'use strict';

/**
 * FIX-2026-08-03: Position Watchdog — F1 + SL-UKC for DISABLED bots
 *
 * Background:
 *   When bot is auto-paused (low Min-%KC) or manually disabled, trader.stop()
 *   unsubscribes from eventBus and clears all timers — F1 auto-arm + SL-UKC
 *   trigger (in trader.js) can no longer run. Open losing positions stay stuck.
 *
 *   PositionWatchdog runs OUTSIDE the per-bot Trader instances, scans ALL
 *   state='selling' trades regardless of bot.enabled, and replicates the F1 + SL-UKC
 *   logic so stuck losers get armed + force-closed even while the bot is paused.
 *
 * Two phases every tick (default 60s):
 *   1. F1 arm: state='selling' + useStopLossOnUKC=false + loss > bot.autoArmLossPct
 *      + age > bot.autoArmAgeHours → set useStopLossOnUKC=true
 *   2. SL-UKC trigger: state='selling' + useStopLossOnUKC=true + last close > upperKC
 *      + (loss OR bot.slUkcTriggerOnProfit) → forceCloseTrade({ trade, bot, allowMarketSell: true })
 *
 * DCA-aware:
 *   DCA stacks use stackBep (not buyPrice) as reference price for loss check.
 *   forceCloseTrade already handles DCA stacks via trade.isDcaStack detection.
 *
 * Safety:
 *   - Re-fetches trade right before forceCloseTrade to avoid stale-state double-sell
 *     (forceCloseTrade.markTradeSold has its own atomic state-in-OPEN_STATES guard)
 *   - bot.autoArmStopLossOnUKC === false → watchdog skips F1 arm for that bot
 *     (user's explicit opt-out is respected)
 *   - Watchdog is read-heavy on Binance REST (1 getKlines per bot per tick); with
 *     ~10 disabled bots × 60s = 600 calls/min — well under Binance 1200 weight/min.
 */

const Trade = require('../db/models/Trade');
const Bot = require('../db/models/Bot');
const binanceRest = require('../binance/binanceRest');
const signalEngine = require('../core/signalEngine');
const forceClose = require('../core/forceClose');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');

// FIX-2026-08-04: 60s → 180s (ลด Binance kline API load — watchdog เป็น read-only check)
//   - logic เดิม 100% — F1 auto-arm + SL-UKC ยังทำงานเหมือนเดิม
//   - delay 120s สำหรับ armed positions เป็นที่ยอมรับได้ (ไม่กระทบ bot operations)
const DEFAULT_INTERVAL_MS = 180000;
const KLINE_FETCH_LIMIT = 30; // need >= 21 for KC warmup

class PositionWatchdog {
  constructor() {
    this.interval = null;
    this.intervalMs = DEFAULT_INTERVAL_MS;
    this.inFlight = false;
    this.lastTickAt = null;
    this.lastStats = null;
    this.lastTickError = null;
    this.tickCount = 0;
  }

  start({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    if (this.interval) return;
    this.intervalMs = intervalMs;
    this.interval = setInterval(() => this._tickSafe(), this.intervalMs);
    logger.info({ intervalMs }, 'positionWatchdog: started');
    // run once immediately on start
    setImmediate(() => this._tickSafe());
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info('positionWatchdog: stopped');
  }

  _tickSafe() {
    this.tickCount += 1;
    this.runOnce()
      .then((stats) => {
        this.lastStats = { ...stats, ts: this.lastTickAt, tickCount: this.tickCount };
        this.lastTickError = null;
        const noisy = stats.armed > 0 || stats.closed > 0 || stats.errors > 0;
        const logFn = noisy ? logger.info.bind(logger) : logger.debug.bind(logger);
        logFn({ ...stats, tickCount: this.tickCount, durationMs: stats.durationMs }, 'positionWatchdog: tick');
      })
      .catch((err) => {
        this.lastTickError = err.message;
        logger.error({ err: err.message, stack: err.stack, tickCount: this.tickCount }, 'positionWatchdog: tick failed');
      });
  }

  async runOnce() {
    if (this.inFlight) {
      logger.debug('positionWatchdog: previous tick still in flight, skip');
      return { skipped: true, scanned: 0, armed: 0, triggered: 0, closed: 0, errors: 0 };
    }
    this.inFlight = true;
    const t0 = Date.now();
    this.lastTickAt = t0;
    const stats = { scanned: 0, armed: 0, triggered: 0, closed: 0, errors: 0, skippedNoBot: 0, skippedNoKc: 0, skippedDisabled: 0, skippedNoBotOptIn: 0, skippedNoBotArmed: 0 };
    try {
      await this._armStuckPositions(stats);
      await this._triggerArmedPositions(stats);
    } finally {
      stats.durationMs = Date.now() - t0;
      this.inFlight = false;
    }
    return stats;
  }

  // ─── Phase 1: F1 arm ──────────────────────────────────────────────────────
  // Mirror trader.js:_autoArmStopLossOnUKC but bot-by-bot so we can apply per-bot
  // thresholds (autoArmLossPct, autoArmAgeHours).
  async _armStuckPositions(stats) {
    // FIX-2026-08-06: widened state filter to include 'holding' + 'filled' — เมื่อ SELL cancel
    //   → state revert เป็น 'holding' (botManager reconcile orphan handler) → trade ติด holding
    //   ไม่มี SELL placed อีก → ถ้า filter แค่ 'selling' จะไม่เห็น trade นี้อีกเลย
    //   pattern เดียวกับ botManager reconcilePendingTrades: state ∈ {placed, filled, holding, cancelled, selling}
    // Loose query — fetch all open positions not yet armed, with age floor
    // of 1h (any position younger than 1h cannot be F1-eligible at default 4h threshold).
    const ageFloor = new Date(Date.now() - 60 * 60 * 1000);
    const candidates = await Trade.find({
      state: { $in: ['selling', 'holding', 'filled'] },
      useStopLossOnUKC: { $ne: true },
      buyFilledAt: { $lte: ageFloor },
    }).lean();

    stats.scanned += candidates.length;

    // Group by botId
    const byBot = new Map();
    for (const t of candidates) {
      if (!t.botId) { stats.skippedNoBot++; continue; }
      const key = String(t.botId);
      if (!byBot.has(key)) byBot.set(key, []);
      byBot.get(key).push(t);
    }

    // FIX-2026-08-04: bulk-load bots (replace N+1 Bot.findById with single $in query)
    const botIds = [...byBot.keys()];
    const bots = botIds.length > 0
      ? await Bot.find({ _id: { $in: botIds } }, 'name symbol timeframe kcMult autoArmStopLossOnUKC autoArmLossPct autoArmAgeHours').lean()
      : [];
    const botMap = new Map(bots.map((b) => [String(b._id), b]));

    for (const [botIdStr, trades] of byBot) {
      const bot = botMap.get(botIdStr);
      if (!bot) { stats.skippedNoBot += trades.length; continue; }

      // User opt-out: bot.autoArmStopLossOnUKC === false → skip F1 arm
      if (bot.autoArmStopLossOnUKC === false) {
        stats.skippedNoBotOptIn += trades.length;
        continue;
      }

      const lossPct = (bot.autoArmLossPct ?? 10) / 100;
      const ageHours = bot.autoArmAgeHours ?? 4;
      const ageThresholdAgo = new Date(Date.now() - ageHours * 60 * 60 * 1000);

      // Get latest close price for this bot (single REST call shared across candidates)
      const lastClose = await this._fetchLastClose(bot);
      if (lastClose == null) { stats.skippedNoKc += trades.length; continue; }

      const toArm = [];
      for (const t of trades) {
        if (new Date(t.buyFilledAt) > ageThresholdAgo) continue;
        const refPrice = this._refPrice(t);
        if (!Number.isFinite(refPrice) || refPrice <= 0) continue;
        const loss = (refPrice - lastClose) / refPrice;
        if (loss > lossPct) toArm.push(t._id);
      }

      if (toArm.length === 0) continue;

      // Atomic claim with state filter — race-safe against trader path
      const upd = await Trade.updateMany(
        { _id: { $in: toArm }, state: 'selling', useStopLossOnUKC: { $ne: true } },
        {
          $set: {
            useStopLossOnUKC: true,
            autoArmedAt: new Date(),
            autoArmLossPct: bot.autoArmLossPct ?? 10,
            autoArmAgeHours: bot.autoArmAgeHours ?? 4,
          },
        }
      );
      const armedCount = upd.modifiedCount || 0;
      stats.armed += armedCount;
      if (armedCount > 0) {
        logger.warn({
          botId: botIdStr,
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          botEnabled: bot.enabled,
          autoArmLossPct: bot.autoArmLossPct ?? 10,
          autoArmAgeHours: bot.autoArmAgeHours ?? 4,
          lastClose,
          armedCount,
          tradeIds: toArm.map(String),
        }, 'positionWatchdog: F1 arm fired for stuck losing positions');
        eventBus.emit('positionWatchdog:armed', {
          botId: botIdStr,
          symbol: bot.symbol,
          armedCount,
          source: 'positionWatchdog',
          botEnabled: bot.enabled,
        });
      }
    }
  }

  // ─── Phase 2: SL-UKC trigger ──────────────────────────────────────────────
  // Mirror trader.js:_checkStopLossOnUpperKC for DISABLED bots.
  async _triggerArmedPositions(stats) {
    // FIX-2026-08-06: widened state filter to include 'holding' + 'filled' — Phase 1 arm ตอนนี้
    //   ครอบคลุม holding แล้ว (ดู comment ด้านบน) → Phase 2 ต้องครอบคลุม matching states ด้วย
    //   มิเช่นนั้น armed flag จะ dormant หลัง SELL cancel → state revert 'selling' → 'holding'
    const armedTrades = await Trade.find({
      state: { $in: ['selling', 'holding', 'filled'] },
      useStopLossOnUKC: true,
    }).lean();

    stats.scanned += armedTrades.length;

    // Group by botId
    const byBot = new Map();
    for (const t of armedTrades) {
      if (!t.botId) { stats.skippedNoBot++; continue; }
      const key = String(t.botId);
      if (!byBot.has(key)) byBot.set(key, []);
      byBot.get(key).push(t);
    }

    // FIX-2026-08-04: bulk-load bots (replace N+1 Bot.findById with single $in query)
    const botIds = [...byBot.keys()];
    const bots = botIds.length > 0
      ? await Bot.find({ _id: { $in: botIds } }, 'name symbol timeframe kcMult slUkcTriggerOnProfit enabled').lean()
      : [];
    const botMap = new Map(bots.map((b) => [String(b._id), b]));

    for (const [botIdStr, trades] of byBot) {
      const bot = botMap.get(botIdStr);
      if (!bot) { stats.skippedNoBot += trades.length; continue; }

      // Fetch klines + compute upperKC once per bot per tick
      let upperKC, lastClose;
      try {
        const r = await this._fetchUpperKC(bot);
        if (!r) { stats.skippedNoKc += trades.length; continue; }
        upperKC = r.upperKC;
        lastClose = r.lastClose;
      } catch (err) {
        logger.warn({ err: err.message, botId: botIdStr, symbol: bot.symbol }, 'positionWatchdog: kline fetch failed');
        stats.errors += trades.length;
        continue;
      }

      if (lastClose <= upperKC) {
        // Candle hasn't broken upper-KC this tick — nothing to do
        continue;
      }

      const triggerOnProfit = bot.slUkcTriggerOnProfit === true;

      // FIX-2026-08-04: bulk re-fetch all trades for this bot in one query (instead of per-trade findById)
      const tradeIds = trades.map((t) => t._id);
      const freshTrades = await Trade.find(
        { _id: { $in: tradeIds } },
        'state useStopLossOnUKC sellOrderId isDcaStack stackBep buyPrice symbol'
      ).lean();
      const freshMap = new Map(freshTrades.map((t) => [String(t._id), t]));

      for (const t of trades) {
        stats.triggered++;

        const refPrice = this._refPrice(t);
        // Loss filter (or profit-trigger toggle)
        if (!triggerOnProfit) {
          if (!Number.isFinite(refPrice) || refPrice <= 0) {
            // can't evaluate loss → skip (safer than wrong force-close)
            stats.skippedNoBotArmed++;
            continue;
          }
          const isLoss = refPrice > lastClose;
          if (!isLoss) {
            logger.debug({
              tradeId: String(t._id),
              symbol: t.symbol,
              refPrice, lastClose,
            }, 'positionWatchdog: skip — profitable position (close < refPrice, slUkcTriggerOnProfit=false)');
            continue;
          }
        }

        // FIX-2026-08-06: Re-fetch fresh state via bulk lookup (avoid double-sell if trader path already handled it)
        //   widened to accept 'holding'/'filled' as still-armed states (mirror Phase 1 filter)
        const fresh = freshMap.get(String(t._id));
        if (!fresh || (fresh.state !== 'selling' && fresh.state !== 'holding' && fresh.state !== 'filled') || fresh.useStopLossOnUKC !== true) {
          logger.debug({
            tradeId: String(t._id),
            dbState: fresh ? fresh.state : 'deleted',
            dbArmed: fresh ? fresh.useStopLossOnUKC : null,
          }, 'positionWatchdog: trade no longer armed — skip');
          continue;
        }

        logger.warn({
          tradeId: String(t._id),
          botId: botIdStr,
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          botEnabled: bot.enabled,
          isDcaStack: t.isDcaStack === true,
          refPrice, lastClose, upperKC: upperKC.toFixed(8),
          triggerOnProfit,
        }, 'positionWatchdog: SL-UKC trigger — force-closing');

        try {
          const result = await forceClose.forceCloseTrade({ trade: fresh, bot, allowMarketSell: true });
          if (result.ok) {
            stats.closed++;
            eventBus.emit('positionWatchdog:closed', {
              tradeId: t._id,
              botId: botIdStr,
              symbol: t.symbol,
              isDcaStack: t.isDcaStack === true,
              mode: result.mode,
              pnl: result.pnl,
              avgSellPrice: result.avgSellPrice,
              closePrice: lastClose,
              upperKC,
              source: 'positionWatchdog',
            });
            logger.warn({
              tradeId: String(t._id),
              botId: botIdStr,
              symbol: bot.symbol,
              mode: result.mode,
              pnl: result.pnl,
              avgSellPrice: result.avgSellPrice,
            }, 'positionWatchdog: SL-UKC closed');
          } else {
            stats.errors++;
            logger.warn({
              tradeId: String(t._id),
              botId: botIdStr,
              symbol: t.symbol,
              err: result.error,
            }, 'positionWatchdog: forceCloseTrade failed');
          }
        } catch (err) {
          stats.errors++;
          logger.error({
            err: err.message, stack: err.stack,
            tradeId: String(t._id),
            botId: botIdStr,
            symbol: bot.symbol,
          }, 'positionWatchdog: forceCloseTrade exception');
        }
      }
    }
  }

  // DCA stack → use stackBep; else use buyPrice. Fallback to 0 if invalid.
  _refPrice(trade) {
    if (trade.isDcaStack === true && Number.isFinite(trade.stackBep) && trade.stackBep > 0) {
      return trade.stackBep;
    }
    const p = parseFloat(trade.buyPrice);
    return Number.isFinite(p) ? p : 0;
  }

  // Latest closed candle close price
  async _fetchLastClose(bot) {
    try {
      const klines = await binanceRest.getKlines({
        symbol: bot.symbol,
        interval: bot.timeframe,
        limit: 2,
      });
      if (!Array.isArray(klines) || klines.length < 1) return null;
      return parseFloat(klines[klines.length - 1][4]);
    } catch (err) {
      logger.warn({ err: err.message, symbol: bot.symbol, timeframe: bot.timeframe }, 'positionWatchdog: fetchLastClose failed');
      return null;
    }
  }

  // Compute upper-KC for the most recent closed candle of this bot
  async _fetchUpperKC(bot) {
    const klines = await binanceRest.getKlines({
      symbol: bot.symbol,
      interval: bot.timeframe,
      limit: KLINE_FETCH_LIMIT,
    });
    if (!Array.isArray(klines) || klines.length < 21) return null;

    const closes = klines.map((k) => parseFloat(k[4]));
    const highs = klines.map((k) => parseFloat(k[2]));
    const lows = klines.map((k) => parseFloat(k[3]));

    const { upper } = signalEngine.computeBgStates({
      closes, highs, lows,
      length: 20,
      mult: bot.kcMult || 1.5,
      useTrueRange: true,
    });
    const lastIdx = upper.length - 1;
    const upperKC = upper[lastIdx];
    const lastClose = closes[lastIdx];
    if (upperKC == null || lastClose == null) return null;
    return { upperKC, lastClose };
  }

  getStatus() {
    return {
      running: !!this.interval,
      intervalMs: this.intervalMs,
      inFlight: this.inFlight,
      tickCount: this.tickCount,
      lastTickAt: this.lastTickAt,
      lastTickError: this.lastTickError,
      lastStats: this.lastStats,
    };
  }
}

module.exports = new PositionWatchdog();
