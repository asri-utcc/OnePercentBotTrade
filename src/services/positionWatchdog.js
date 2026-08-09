'use strict';

/**
 * FIX-2026-08-03: Position Watchdog — F1 + SL-UKC for DISABLED bots
 * FIX-2026-08-07: Phase 3 added — CBv2 sustained panic-close (4 red below lowerKC)
 *                  for disabled/paused bots, mirroring trader._checkCBv2PanicClose.
 * FIX-2026-08-08: Feature #2 — Phase 4 added — CBv3 panic-close (CBv2 + ST3 upper-TF)
 *                  for disabled/paused bots, mirroring trader._checkCBv3PanicClose.
 *                  Mutually exclusive with CBv2 via AppConfig.cbVersion.
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
 * Four phases every tick (default 180s):
 *   1. F1 arm: state='selling' + useStopLossOnUKC=false + loss > bot.autoArmLossPct
 *      + age > bot.autoArmAgeHours → set useStopLossOnUKC=true
 *   2. SL-UKC trigger: state='selling' + useStopLossOnUKC=true + last close > upperKC
 *      + (loss OR bot.slUkcTriggerOnProfit) → forceCloseTrade({ trade, bot, allowMarketSell: true })
 *   3. CBv2 panic-close (Phase 3): any bot with open positions where
 *      isCBv2At(lastIdx) === true (4 consecutive red candles fully below lower-KC)
 *      → force-close all open positions + set cbv2LockedUntil/cbv2LockReason
 *      → emit bot:cooldown (same as trader path) + telegram cbv2PanicClose alert.
 *      Closes the "disabled bot + sustained dump = no protection" gap.
 *   4. CBv3 panic-close (Phase 4 — 2026-08-08): like Phase 3 BUT additionally
 *      requires ST3 no-trade pattern on upper-TF (TREND_TF_MAP) on the same candle.
 *      Gated by AppConfig.cbVersion === 'v3' (mutually exclusive with Phase 3).
 *
 * DCA-aware:
 *   DCA stacks use stackBep (not buyPrice) as reference price for loss check.
 *   forceCloseTrade already handles DCA stacks via trade.isDcaStack detection.
 *   Phase 3 (CBv2) skips DCA mode entirely — DCA uses dip-buying, panic-sell
 *   interferes with the Martingale buying plan.
 *
 * Safety:
 *   - Re-fetches trade right before forceCloseTrade to avoid stale-state double-sell
 *     (forceCloseTrade.markTradeSold has its own atomic state-in-OPEN_STATES guard)
 *   - bot.autoArmStopLossOnUKC === false → watchdog skips F1 arm for that bot
 *     (user's explicit opt-out is respected)
 *   - bot.cbv2Enabled === false → Phase 3 skips CBv2 for that bot (user opt-out)
 *   - bot.cbv2LockedUntil > now → Phase 3 skips (idempotent across watchdog ticks)
 *   - bot.cbv3Enabled === false → Phase 4 skips CBv3 for that bot (user opt-out)
 *   - bot.cbv3LockedUntil > now → Phase 4 skips (idempotent across watchdog ticks)
 *     (cbv3Enabled/cbv3LockHours fields were MISSING from Bot.js schema before
 *      FIX-2026-08-09 — Mongoose strict mode silently dropped saves; per-bot
 *      opt-out UI was broken. Added to schema + backfill migration applied.)
 *   - Watchdog is read-heavy on Binance REST (≤2 getKlines per bot per tick); with
 *     ~10 disabled bots × 180s = ~33 calls/min — well under Binance 6000 weight/min.
 */

const Trade = require('../db/models/Trade');
const Bot = require('../db/models/Bot');
const binanceRest = require('../binance/binanceRest');
const signalEngine = require('../core/signalEngine');
const forceClose = require('../core/forceClose');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');
// FIX-2026-08-07: Phase 3 (CBv2 panic-close for disabled bots) needs telegram alerts
const telegramNotifier = require('./telegramNotifier');
// FIX-2026-08-08: Feature #2 — CBv3 version routing (mutually exclusive with CBv2)
const cbVersion = require('../core/cbVersion');
const volatilityScanner = require('../core/volatilityScanner'); // FIX-2026-08-08: corrected path (volatilityScanner.js lives in src/core/, not src/services/)

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
        // FIX-2026-08-07: include CBv2 counters in noisy detector (Phase 3)
        // FIX-2026-08-08: include CBv3 counters (Phase 4)
        const noisy = stats.armed > 0 || stats.closed > 0 || stats.errors > 0
          || stats.cbv2Triggered > 0 || stats.cbv2Closed > 0 || stats.cbv2Errors > 0
          || stats.cbv3Triggered > 0 || stats.cbv3Closed > 0 || stats.cbv3Errors > 0;
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
      return {
        skipped: true,
        scanned: 0, armed: 0, triggered: 0, closed: 0, errors: 0,
        skippedNoBot: 0, skippedNoKc: 0, skippedDisabled: 0, skippedNoBotOptIn: 0, skippedNoBotArmed: 0,
        cbv2Scanned: 0, cbv2Triggered: 0, cbv2Closed: 0, cbv2Errors: 0,
        cbv2SkippedEnabled: 0, cbv2SkippedCooldown: 0, cbv2SkippedDca: 0,
        cbv2SkippedWarmup: 0, cbv2SkippedNoBot: 0, cbv2SkippedNoPositions: 0, cbv2SkippedKline: 0,
        cbv2SkippedVersion: 0, // FIX-2026-08-09: Phase 3 cbVersion='v2' gate skip counter
        cbv3Scanned: 0, cbv3Triggered: 0, cbv3Closed: 0, cbv3Errors: 0,
        cbv3SkippedEnabled: 0, cbv3SkippedCooldown: 0, cbv3SkippedDca: 0,
        cbv3SkippedWarmup: 0, cbv3SkippedNoBot: 0, cbv3SkippedNoPositions: 0, cbv3SkippedKline: 0,
        cbv3SkippedVersion: 0, cbv3SkippedSt3: 0,
      };
    }
    this.inFlight = true;
    const t0 = Date.now();
    this.lastTickAt = t0;
    // FIX-2026-08-07: CBv2 telemetry counters added (Phase 3 panic-close for disabled/paused bots)
    //   - cbv2Scanned: total open-state trades considered for CBv2 check
    //   - cbv2Triggered: number of bots where CBv2 pattern matched (a single fire can close multiple trades)
    //   - cbv2Closed: individual trades successfully closed by CBv2 path
    //   - cbv2Skipped*: breakdown of why each bot+position pair was skipped (one of: enabled=false, cooldown active, DCA mode, KC warmup, kline fetch fail)
    //   - cbv2Errors: individual trade forceCloseTrade failures within a CBv2 fire
    // FIX-2026-08-08: Feature #2 — CBv3 counters (Phase 4 panic-close for disabled/paused bots, mirror Phase 3 with ST3 upper-TF)
    //   - cbv3Scanned/Triggered/Closed/Errors mirror cbv2* semantics
    //   - cbv3SkippedVersion: cbVersion !== 'v3' (entire phase skipped)
    //   - cbv3SkippedSt3: CBv2 pattern matched but ST3 upper-TF didn't trigger (no fire)
    const stats = {
      scanned: 0, armed: 0, triggered: 0, closed: 0, errors: 0,
      skippedNoBot: 0, skippedNoKc: 0, skippedDisabled: 0, skippedNoBotOptIn: 0, skippedNoBotArmed: 0,
      cbv2Scanned: 0, cbv2Triggered: 0, cbv2Closed: 0, cbv2Errors: 0,
      cbv2SkippedEnabled: 0, cbv2SkippedCooldown: 0, cbv2SkippedDca: 0,
      cbv2SkippedWarmup: 0, cbv2SkippedNoBot: 0, cbv2SkippedNoPositions: 0, cbv2SkippedKline: 0,
      cbv2SkippedVersion: 0, // FIX-2026-08-09: Phase 3 cbVersion='v2' gate skip counter
      cbv3Scanned: 0, cbv3Triggered: 0, cbv3Closed: 0, cbv3Errors: 0,
      cbv3SkippedEnabled: 0, cbv3SkippedCooldown: 0, cbv3SkippedDca: 0,
      cbv3SkippedWarmup: 0, cbv3SkippedNoBot: 0, cbv3SkippedNoPositions: 0, cbv3SkippedKline: 0,
      cbv3SkippedVersion: 0, cbv3SkippedSt3: 0,
    };
    try {
      await this._armStuckPositions(stats);
      await this._triggerArmedPositions(stats);
      // FIX-2026-08-07: Phase 3 — CBv2 sustained panic-close (4 red candles below lowerKC) for disabled/paused bots
      //   - mirrors trader._checkCBv2PanicClose but runs OUTSIDE trader instance
      //   - covers bots that were auto-paused (low Min-%KC) or manually disabled while holding positions
      //   - persists cbv2* DB fields → trader restores cooldown on resume (gap-fix replay collision)
      await this._checkCBv2PanicCloseForDisabled(stats);
      // FIX-2026-08-08: Feature #2 — Phase 4 — CBv3 panic-close (CBv2 + ST3 upper-TF) for disabled/paused bots
      //   - mirror of Phase 3 + ST3 filter on upper-TF (TREND_TF_MAP)
      //   - gated by cbVersion === 'v3' (mutually exclusive with Phase 3)
      //   - runs even if Phase 3 already fired — independent cooldown DB fields (cbv3*)
      await this._checkCBv3PanicCloseForDisabled(stats);
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
          // FIX-2026-08-09: source='watchdog' — base sellReason 'manual_api_watchdog',
          //   then overridden to 'sl_ukc_f1_armed' below (F1 auto-armed is the main use case)
          const result = await forceClose.forceCloseTrade({ trade: fresh, bot, allowMarketSell: true, source: 'watchdog' });
          if (result.ok) {
            stats.closed++;
            // FIX-2026-08-09: override sellReason → 'sl_ukc_f1_armed' (อันนี้คือ SL-UKC, ไม่ใช่ manual_api)
            //   - positionWatchdog เป็น auto-system → default 'manual_api_watchdog' ไม่สื่อ
            //   - เปลี่ยนเป็น 'sl_ukc_f1_armed' เพื่อให้ filter/group รู้ว่าเป็น SL-UKC auto-armed
            Trade.updateOne(
              { _id: fresh._id, state: 'sold' },
              {
                $set: {
                  sellReason: 'sl_ukc_f1_armed',
                  sellReasonDetail: `positionWatchdog SL-UKC — close=${lastClose} > upperKC=${upperKC.toFixed(6)}, triggerOnProfit=${triggerOnProfit}`,
                  sellReasonSource: 'positionWatchdog.slUkc',
                  sellReasonAt: new Date(),
                },
              }
            ).catch(() => { /* non-fatal */ });
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

  // FIX-2026-08-07: Phase 3 — CBv2 sustained panic-close for DISABLED/PAUSED bots
  // ---------------------------------------------------------------------------
  // Mirrors trader._checkCBv2PanicClose but runs OUTSIDE the trader instance,
  // so disabled/paused bots (which have no kline:closed handler) still get
  // panic-close protection when 4 consecutive red candles form below lower-KC.
  //
  // FIX-2026-08-09: MUTUAL EXCLUSION with Phase 4 (CBv3)
  //   - gated by AppConfig.cbVersion === 'v2' (mirror Phase 4's cbVersion='v3' gate)
  //   - when cbVersion='v3' → Phase 3 returns early, Phase 4 (CBv3) is the
  //     only panic-close that fires (CBv3 = CBv2 + ST3 upper-TF same candle)
  //   - without this gate: 1000CAT(bAdd) on 2026-08-09 fired CBv2 alert
  //     despite cbVersion='v3' — ST3 didn't match on 1h, so CBv3 didn't fire,
  //     but Phase 3 ran anyway and wrote cbv2LockedUntil + sent CBv2 alert
  //
  // Design contract (parity with trader path):
  //   - guarded by bot.cbv2Enabled !== false (opt-out)
  //   - guarded by bot.cbv2LockedUntil > now (idempotent across multi-tick)
  //   - skip DCA mode (bot.dcaEnabled === true) — DCA uses dip-buying, panic-sell interferes
  //   - require klines.length >= 21 for KC(20) warmup (mirror trader:1318)
  //   - pattern = signalEngine.isCBv2At(lastIdx, opens, closes, lowerKC)
  //   - on match: bulk-fetch fresh trades, force-close all open, persist cooldown fields
  //
  // Cross-restart fix:
  //   trader.start() (trader.js:222-224) restores `_cbv2FiredAt` from
  //   `bot.cbv2LastFiredAt`. By persisting cbv2LastFiredAt here, the trader that
  //   later spawns will inherit the cooldown and not re-fire the same pattern.
  //   This closes the "auto-resume + CBv2 replay collision" gap documented in
  //   the CBv2 memory file.
  async _checkCBv2PanicCloseForDisabled(stats) {
    // FIX-2026-08-09: version gate — Phase 3 only runs when AppConfig.cbVersion='v2'
    //   - mutually exclusive with Phase 4 (CBv3) which gates on cbVersion='v3'
    //   - prevents Phase 3 from firing CBv2 alert when user opted into CBv3
    //     (CBv3 is stricter — requires CBv2 pattern + ST3 upper-TF same candle;
    //      if ST3 doesn't match, user chose not to panic-close for this candle)
    const cbVer = await cbVersion.getActiveVersion();
    if (cbVer !== 'v2') {
      // FIX-2026-08-09: increment skippedVersion counter (mirror Phase 4 cbv3SkippedVersion)
      //   - helps observability: can graph "how many watchdog ticks skipped CBv2
      //     because user has cbVersion='v3'"
      stats.cbv2SkippedVersion = (stats.cbv2SkippedVersion || 0) + 1;
      // Not an error — Phase 3 is disabled when v3 is active (Phase 4 takes over)
      return;
    }
    // 1. Get ALL open-state trades — do not filter by bot.enabled because:
    //    - enabled bot has trader path active too, but its guard
    //      (cbv2LockedUntil > now) is set first → next watchdog tick sees cooldown
    //    - forceCloseTrade has atomic state-in-OPEN_STATES guard so duplicates harmless
    //    - bulk query is cheaper than fetching bot.enabled for every trade
    // Mirror OPEN_STATES from trader.js:1355 — kept locally to avoid circular require
    const OPEN_STATES = ['partial_wait', 'filled', 'retrying', 'holding', 'selling', 'partial_sell_wait'];
    const candidates = await Trade.find({ state: { $in: OPEN_STATES } }).lean();
    if (candidates.length === 0) return;

    // 2. Group by botId
    const byBot = new Map();
    for (const t of candidates) {
      if (!t.botId) { stats.cbv2SkippedNoBot++; continue; }
      const key = String(t.botId);
      if (!byBot.has(key)) byBot.set(key, []);
      byBot.get(key).push(t);
    }
    if (byBot.size === 0) return;

    // 3. Bulk-load bots with CBv2 + DCA + KC config fields
    const botIds = [...byBot.keys()];
    const bots = botIds.length > 0
      ? await Bot.find(
          { _id: { $in: botIds } },
          'name symbol timeframe kcMult enabled dcaEnabled cbv2Enabled cbv2LockHours cbv2LockedUntil cbv2LockReason'
        ).lean()
      : [];
    const botMap = new Map(bots.map((b) => [String(b._id), b]));

    // 4. Per-bot evaluation
    for (const [botIdStr, trades] of byBot) {
      const bot = botMap.get(botIdStr);
      if (!bot) { stats.cbv2SkippedNoBot += trades.length; continue; }

      // Guard evaluation (pure helper — testable without mocks)
      const klinesCount = null; // klines not yet fetched at this point
      const skipReason = PositionWatchdog._cbv2SkipReason(bot, trades.length, klinesCount, Date.now());
      if (skipReason) {
        if (skipReason === 'disabled') stats.cbv2SkippedEnabled += trades.length;
        else if (skipReason === 'cooldown_active') stats.cbv2SkippedCooldown += trades.length;
        else if (skipReason === 'dca_mode') stats.cbv2SkippedDca += trades.length;
        else if (skipReason === 'no_positions') stats.cbv2SkippedNoPositions++;
        else if (skipReason === 'no_bot') stats.cbv2SkippedNoBot += trades.length;
        continue;
      }

      stats.cbv2Scanned += trades.length;

      // 5. Fetch klines + compute lowerKC
      let klines;
      try {
        klines = await this._fetchKlinesForCBv2(bot);
      } catch (err) {
        stats.cbv2Errors += trades.length;
        stats.cbv2SkippedKline += trades.length;
        logger.warn(
          { err: err.message, botId: botIdStr, symbol: bot.symbol, timeframe: bot.timeframe },
          'positionWatchdog: CBv2 kline fetch failed'
        );
        continue;
      }
      if (PositionWatchdog._cbv2SkipReason(bot, trades.length, klines ? klines.length : 0, Date.now()) === 'warmup') {
        stats.cbv2SkippedWarmup += trades.length;
        continue;
      }

      let lower;
      try {
        const states = signalEngine.computeBgStates({
          closes: klines.map((k) => k.close),
          highs: klines.map((k) => k.high),
          lows: klines.map((k) => k.low),
          length: 20,
          mult: bot.kcMult || 1.5,
          useTrueRange: true,
        });
        lower = states.lower;
      } catch (err) {
        stats.cbv2Errors += trades.length;
        stats.cbv2SkippedKline += trades.length;
        logger.warn(
          { err: err.message, botId: botIdStr, symbol: bot.symbol },
          'positionWatchdog: CBv2 computeBgStates failed'
        );
        continue;
      }

      const lastIdx = lower.length - 1;
      const lastLower = lower[lastIdx];
      if (lastLower == null) {
        stats.cbv2SkippedWarmup += trades.length;
        continue;
      }

      // 6. Pattern check — exact mirror of trader._checkCBv2PanicClose:1352
      const opens = klines.map((k) => k.open);
      const closes = klines.map((k) => k.close);
      if (!signalEngine.isCBv2At(lastIdx, opens, closes, lower)) {
        continue; // pattern not matched — normal path, no error
      }

      // ─── CBv2 PATTERN MATCHED — fire cooldown + force-close ───
      logger.warn(
        {
          botId: botIdStr,
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          lastLower: lastLower.toFixed(6),
          openTradeIds: trades.map((t) => String(t._id)),
          botEnabled: bot.enabled,
          source: 'positionWatchdog',
        },
        'positionWatchdog: CBv2 pattern matched (4 red below lowerKC) — force-closing + setting cooldown'
      );

      // 7. Compute cooldown window (mirror trader:1409)
      const lockHours = Math.max(0.5, Math.min(168, Number(bot.cbv2LockHours) || 8));
      const lockedUntil = new Date(Date.now() + lockHours * 60 * 60 * 1000);
      const lockedUntilIso = lockedUntil.toISOString();

      // 8. Persist cooldown DB fields FIRST (idempotency — concurrent watchdog ticks see cooldown)
      //    Note: HYBRID — DO NOT touch bot.enabled / status / autoPauseReason
      //    This lets trader.restoreCbv2FiredAt (trader.js:222) pick up on next spawn
      Bot.updateOne(
        { _id: bot._id },
        {
          $set: {
            cbv2LockedUntil: lockedUntil,
            cbv2LockReason: 'cbv2_panic',
            cbv2LastFiredAt: new Date(),
          },
        }
      ).catch((err) =>
        logger.warn(
          { err: err.message, botId: botIdStr },
          'positionWatchdog: persist CBv2 cooldown failed (non-fatal — will retry next tick)'
        )
      );

      // 9. Bulk re-fetch fresh trades (race-safety vs trader path / other watchdog phases)
      const tradeIds = trades.map((t) => t._id);
      let freshTrades = [];
      try {
        freshTrades = await Trade.find(
          { _id: { $in: tradeIds } },
          'state useStopLossOnUKC sellOrderId isDcaStack stackBep buyPrice symbol botId'
        ).lean();
      } catch (err) {
        stats.cbv2Errors += trades.length;
        logger.warn(
          { err: err.message, botId: botIdStr },
          'positionWatchdog: CBv2 fresh-trades re-fetch failed'
        );
        continue;
      }
      const freshMap = new Map(freshTrades.map((t) => [String(t._id), t]));

      // 10. Force-close loop (mirror trader SL-UKC trigger at line 273-360)
      let closedCount = 0;
      for (const t of trades) {
        const fresh = freshMap.get(String(t._id));
        if (!fresh) { stats.cbv2SkippedNoBot++; continue; }
        if (fresh.state !== 'selling' && fresh.state !== 'holding' && fresh.state !== 'filled') {
          // Already closed/managed by another path (trader SL-UKC, manual API, etc.)
          continue;
        }

        try {
          // FIX-2026-08-09: source='watchdog' — base sellReason 'manual_api_watchdog',
          //   then overridden to 'cbv2_panic' below (already had this pattern)
          const result = await forceClose.forceCloseTrade({
            trade: fresh,
            bot,
            allowMarketSell: true,
            source: 'watchdog',
          });
          if (result.ok) {
            closedCount++;
            stats.cbv2Closed++;
            // Annotate with cbv2_panic sellReason for analytics parity
            // (forceCloseTrade defaults to manual_api_market — we override after close)
            Trade.updateOne(
              { _id: fresh._id, state: 'sold' },
              {
                $set: {
                  sellReason: 'cbv2_panic',
                  sellReasonDetail: `positionWatchdog: 4 red candles below lowerKC (bot ${bot.enabled ? 'enabled' : 'disabled'}${bot.autoArmStopLossOnUKC === false ? ', autoArmOff' : ''}); closedCount=${closedCount}; lastLower=${lastLower.toFixed(8)}`,
                  sellReasonSource: 'positionWatchdog.cbv2',
                  sellReasonAt: new Date(),
                },
              }
            ).catch(() => { /* non-fatal — analytics only */ });

            eventBus.emit('cbv2Watchdog:closed', {
              tradeId: t._id,
              botId: botIdStr,
              symbol: fresh.symbol,
              isDcaStack: fresh.isDcaStack === true,
              mode: result.mode,
              pnl: result.pnl,
              avgSellPrice: result.avgSellPrice,
              lastLower,
              botEnabled: bot.enabled,
              source: 'positionWatchdog',
            });
          } else {
            stats.cbv2Errors++;
            logger.warn(
              {
                tradeId: String(t._id),
                botId: botIdStr,
                err: result.error,
              },
              'positionWatchdog: CBv2 forceCloseTrade failed'
            );
          }
        } catch (err) {
          stats.cbv2Errors++;
          logger.error(
            { err: err.message, stack: err.stack, tradeId: String(t._id), botId: botIdStr },
            'positionWatchdog: CBv2 forceCloseTrade exception'
          );
        }
      }

      stats.cbv2Triggered++;

      // 11. Emit events — same as trader path so telegram botLocked subscription fires
      eventBus.emit('bot:cooldown', {
        botId: bot._id,
        reason: 'cbv2_panic',
        lockedUntil: lockedUntilIso,
        lockHours,
        source: 'positionWatchdog', // differentiate from trader path
      });
      eventBus.emit('bot:updated', { botId: bot._id });

      // 12. Telegram alert (uses same template as trader cbv2PanicClose)
      try {
        const botName = bot.name || bot.symbol || botIdStr;
        await telegramNotifier.sendNow('cbv2PanicClose', {
          botName,
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          closedCount,
          lastLower,
          lockedUntil: lockedUntilIso,
          lockHours,
          source: 'positionWatchdog', // diagnostic — included in detail only
        });
      } catch (err) {
        logger.warn(
          { err: err.message, botId: botIdStr },
          'positionWatchdog: CBv2 telegram sendNow failed (non-fatal)'
        );
      }
    }
  }

  // FIX-2026-08-08: Feature #2 — Phase 4 — CBv3 panic-close (CBv2 + ST3 upper-TF) for DISABLED/PAUSED bots
  // ---------------------------------------------------------------------------
  // Mirrors trader._checkCBv3PanicClose but runs OUTSIDE the trader instance.
  //
  // Differences from Phase 3:
  //   - gated by AppConfig.cbVersion === 'v3' (mutually exclusive with CBv2)
  //   - CBv2 base pattern check + ADDITIONAL ST3 no-trade on upper-TF (TREND_TF_MAP)
  //   - cooldown DB fields: cbv3LockedUntil / cbv3LockReason / cbv3LastFiredAt (separate from cbv2*)
  //
  // Gating order:
  //   1. cbVersion !== 'v3' → cbv3SkippedVersion++
  //   2. bot.cbv3Enabled === false → cbv3SkippedEnabled++
  //   3. bot.cbv3LockedUntil > now → cbv3SkippedCooldown++
  //   4. bot.dcaEnabled === true → cbv3SkippedDca++
  //   5. no open positions → cbv3SkippedNoPositions++
  //   6. klines.length < 21 → cbv3SkippedWarmup++
  //   7. CBv2 pattern not matched → no increment (silent, expected for most ticks)
  //   8. ST3 not triggered on upper-TF → cbv3SkippedSt3++ (v3 strict gate — pure CBv2 should not fire)
  //   9. all gates pass → fire (force-close all + persist cbv3* cooldown)
  async _checkCBv3PanicCloseForDisabled(stats) {
    // FIX-2026-08-08: Feature #2 — version gate (Phase 4 only runs when AppConfig.cbVersion='v3')
    const cbVer = await cbVersion.getActiveVersion();
    if (cbVer !== 'v3') {
      // Not an error — Phase 4 is disabled when v2 is active
      return;
    }

    // 1. Get ALL open-state trades — same as Phase 3
    const OPEN_STATES = ['partial_wait', 'filled', 'retrying', 'holding', 'selling', 'partial_sell_wait'];
    const candidates = await Trade.find({ state: { $in: OPEN_STATES } }).lean();
    if (candidates.length === 0) return;

    // 2. Group by botId
    const byBot = new Map();
    for (const t of candidates) {
      if (!t.botId) { stats.cbv3SkippedNoBot++; continue; }
      const key = String(t.botId);
      if (!byBot.has(key)) byBot.set(key, []);
      byBot.get(key).push(t);
    }
    if (byBot.size === 0) return;

    // 3. Bulk-load bots with CBv3 + DCA + KC config fields
    const botIds = [...byBot.keys()];
    const bots = botIds.length > 0
      ? await Bot.find(
          { _id: { $in: botIds } },
          'name symbol timeframe kcMult enabled dcaEnabled cbv3Enabled cbv3LockHours cbv3LockedUntil cbv3LockReason'
        ).lean()
      : [];
    const botMap = new Map(bots.map((b) => [String(b._id), b]));

    // 4. Per-bot evaluation
    for (const [botIdStr, trades] of byBot) {
      const bot = botMap.get(botIdStr);
      if (!bot) { stats.cbv3SkippedNoBot += trades.length; continue; }

      // Guard evaluation (pure helper)
      const skipReason = PositionWatchdog._cbv3SkipReason(bot, trades.length, null, Date.now());
      if (skipReason) {
        if (skipReason === 'disabled') stats.cbv3SkippedEnabled += trades.length;
        else if (skipReason === 'cooldown_active') stats.cbv3SkippedCooldown += trades.length;
        else if (skipReason === 'dca_mode') stats.cbv3SkippedDca += trades.length;
        else if (skipReason === 'no_positions') stats.cbv3SkippedNoPositions++;
        else if (skipReason === 'no_bot') stats.cbv3SkippedNoBot += trades.length;
        continue;
      }

      stats.cbv3Scanned += trades.length;

      // 5. Fetch klines + compute lowerKC
      let klines;
      try {
        klines = await this._fetchKlinesForCBv2(bot);
      } catch (err) {
        stats.cbv3Errors += trades.length;
        stats.cbv3SkippedKline += trades.length;
        logger.warn(
          { err: err.message, botId: botIdStr, symbol: bot.symbol, timeframe: bot.timeframe },
          'positionWatchdog: CBv3 kline fetch failed'
        );
        continue;
      }
      if (PositionWatchdog._cbv3SkipReason(bot, trades.length, klines ? klines.length : 0, Date.now()) === 'warmup') {
        stats.cbv3SkippedWarmup += trades.length;
        continue;
      }

      let lower;
      try {
        const states = signalEngine.computeBgStates({
          closes: klines.map((k) => k.close),
          highs: klines.map((k) => k.high),
          lows: klines.map((k) => k.low),
          length: 20,
          mult: bot.kcMult || 1.5,
          useTrueRange: true,
        });
        lower = states.lower;
      } catch (err) {
        stats.cbv3Errors += trades.length;
        stats.cbv3SkippedKline += trades.length;
        logger.warn(
          { err: err.message, botId: botIdStr, symbol: bot.symbol },
          'positionWatchdog: CBv3 computeBgStates failed'
        );
        continue;
      }

      const lastIdx = lower.length - 1;
      const lastLower = lower[lastIdx];
      if (lastLower == null) {
        stats.cbv3SkippedWarmup += trades.length;
        continue;
      }

      // 6. CBv2 base pattern check (must match first)
      const opens = klines.map((k) => k.open);
      const closes = klines.map((k) => k.close);
      if (!signalEngine.isCBv2At(lastIdx, opens, closes, lower)) {
        continue; // CBv2 pattern not matched — no fire (silent)
      }

      // 7. ST3 no-trade on upper-TF (gating for CBv3)
      // FIX-2026-08-09: bypassOptIn=true → ST3 logic runs independently of bot.safeTradeNoTradeEnabled
      // (mirror trader.js fix — CBv3 panic-sell must remain a safety net for disabled/paused bots regardless of opt-in)
      const trendTF = volatilityScanner.TREND_TF_MAP ? volatilityScanner.TREND_TF_MAP[bot.timeframe] : null;
      if (trendTF) {
        try {
          const noTradeCheck = await signalEngine.checkNoTradeOnUpperTF(
            bot, trendTF, binanceRest, { bypassOptIn: true },
          );
          if (noTradeCheck.skip !== true) {
            // CBv2 matched but ST3 cleared → no CBv3 fire (v3 strict gate)
            stats.cbv3SkippedSt3 += trades.length;
            logger.debug({
              botId: botIdStr,
              symbol: bot.symbol,
              timeframe: bot.timeframe,
              trendTF,
              reason: noTradeCheck.reason,
            }, 'positionWatchdog: cbv3 — CBv2 matched but ST3 cleared, no fire');
            continue;
          }
        } catch (stErr) {
          // FAIL-OPEN: ST3 fetch error → fall through to fire CBv3 (treat as pure CBv2)
          logger.warn({ err: stErr.message, botId: botIdStr }, 'positionWatchdog: cbv3 — ST3 fetch failed, firing anyway (fail-open)');
        }
      }
      // If no trendTF → fire CBv3 anyway (CBv2-equivalent, mirror trader behavior)

      // ─── CBv3 PATTERN MATCHED — fire cooldown + force-close ───
      logger.warn(
        {
          botId: botIdStr,
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          lastLower: lastLower.toFixed(6),
          openTradeIds: trades.map((t) => String(t._id)),
          botEnabled: bot.enabled,
          source: 'positionWatchdog',
        },
        'positionWatchdog: CBv3 pattern matched (CBv2 + ST3 upper-TF) — force-closing + setting cooldown'
      );

      // 8. Compute cooldown window (mirror CBv3 in trader)
      const lockHours = Math.max(0.5, Math.min(168, Number(bot.cbv3LockHours) || 8));
      const lockedUntil = new Date(Date.now() + lockHours * 60 * 60 * 1000);
      const lockedUntilIso = lockedUntil.toISOString();

      // 9. Persist cooldown DB fields FIRST
      Bot.updateOne(
        { _id: bot._id },
        {
          $set: {
            cbv3LockedUntil: lockedUntil,
            cbv3LockReason: 'cbv3_panic',
            cbv3LastFiredAt: new Date(),
          },
        }
      ).catch((err) =>
        logger.warn(
          { err: err.message, botId: botIdStr },
          'positionWatchdog: persist CBv3 cooldown failed (non-fatal)'
        )
      );

      // 10. Bulk re-fetch fresh trades (race-safety)
      const tradeIds = trades.map((t) => t._id);
      let freshTrades = [];
      try {
        freshTrades = await Trade.find(
          { _id: { $in: tradeIds } },
          'state useStopLossOnUKC sellOrderId isDcaStack stackBep buyPrice symbol botId'
        ).lean();
      } catch (err) {
        stats.cbv3Errors += trades.length;
        logger.warn(
          { err: err.message, botId: botIdStr },
          'positionWatchdog: CBv3 fresh-trades re-fetch failed'
        );
        continue;
      }
      const freshMap = new Map(freshTrades.map((t) => [String(t._id), t]));

      // 11. Force-close loop
      let closedCount = 0;
      for (const t of trades) {
        const fresh = freshMap.get(String(t._id));
        if (!fresh) { stats.cbv3SkippedNoBot++; continue; }
        if (fresh.state !== 'selling' && fresh.state !== 'holding' && fresh.state !== 'filled') {
          continue; // already handled by another path
        }
        try {
          // FIX-2026-08-09: source='watchdog' — base sellReason 'manual_api_watchdog',
          //   then overridden to 'cbv3_panic' below (already had this pattern)
          const result = await forceClose.forceCloseTrade({
            trade: fresh,
            bot,
            allowMarketSell: true,
            source: 'watchdog',
          });
          if (result.ok) {
            closedCount++;
            stats.cbv3Closed++;
            Trade.updateOne(
              { _id: fresh._id, state: 'sold' },
              {
                $set: {
                  sellReason: 'cbv3_panic',
                  sellReasonDetail: `positionWatchdog: CBv2 + ST3 upper-TF (bot ${bot.enabled ? 'enabled' : 'disabled'}); closedCount=${closedCount}; lastLower=${lastLower.toFixed(8)}`,
                  sellReasonSource: 'positionWatchdog.cbv3',
                  sellReasonAt: new Date(),
                },
              }
            ).catch(() => { /* non-fatal */ });

            eventBus.emit('cbv3Watchdog:closed', {
              tradeId: t._id,
              botId: botIdStr,
              symbol: fresh.symbol,
              isDcaStack: fresh.isDcaStack === true,
              mode: result.mode,
              pnl: result.pnl,
              avgSellPrice: result.avgSellPrice,
              lastLower,
              botEnabled: bot.enabled,
              source: 'positionWatchdog',
            });
          } else {
            stats.cbv3Errors++;
            logger.warn(
              {
                tradeId: String(t._id),
                botId: botIdStr,
                err: result.error,
              },
              'positionWatchdog: CBv3 forceCloseTrade failed'
            );
          }
        } catch (err) {
          stats.cbv3Errors++;
          logger.error(
            { err: err.message, stack: err.stack, tradeId: String(t._id), botId: botIdStr },
            'positionWatchdog: CBv3 forceCloseTrade exception'
          );
        }
      }

      stats.cbv3Triggered++;

      // 12. Emit events — bot:cooldown (CBv3-specific BUY suppression), bot:updated
      eventBus.emit('bot:cooldown', {
        botId: bot._id,
        reason: 'cbv3_panic',
        version: 'v3',
        lockedUntil: lockedUntilIso,
        lockHours,
        source: 'positionWatchdog',
      });
      eventBus.emit('bot:updated', { botId: bot._id });

      // 13. Telegram alert
      try {
        const botName = bot.name || bot.symbol || botIdStr;
        await telegramNotifier.sendNow('cbv3PanicClose', {
          botName,
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          closedCount,
          lastLower,
          lockedUntil: lockedUntilIso,
          lockHours,
          source: 'positionWatchdog',
        });
      } catch (err) {
        logger.warn(
          { err: err.message, botId: botIdStr },
          'positionWatchdog: CBv3 telegram sendNow failed (non-fatal)'
        );
      }
    }
  }

  // FIX-2026-08-07: Fetch + parse klines for CBv2 pattern detection (Phase 3)
  //   - returns null if klines insufficient for KC(20) warmup
  //   - parses once here so callers don't repeat work
  async _fetchKlinesForCBv2(bot) {
    const klines = await binanceRest.getKlines({
      symbol: bot.symbol,
      interval: bot.timeframe,
      limit: 30,
    });
    if (!Array.isArray(klines) || klines.length < 21) return null;
    return klines.map((k) => ({
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
    }));
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

  // ─── FIX-2026-08-07: Phase 3 (CBv2) pure helper — testable without mocks ──
  /**
   * Decide whether CBv2 Phase 3 should skip this bot+positions.
   *
   * Returns a string skip reason when blocked, or null when CBv2 may proceed.
   * Order matters — guards are evaluated top-down so the first match wins
   * (matching the runtime decision order in _checkCBv2PanicCloseForDisabled).
   *
   * @param {object|null} bot       - bot doc (may be null if botId not found)
   * @param {number}      tradesLen - number of open-state trades for this bot
   * @param {number|null} klinesLen - kline cache size after fetch (null = not fetched yet)
   * @param {number}      nowMs     - reference timestamp (defaults to Date.now() at call site)
   * @returns {string|null}
   */
  static _cbv2SkipReason(bot, tradesLen, klinesLen, nowMs) {
    if (!bot) return 'no_bot';
    if (bot.cbv2Enabled === false) return 'disabled';
    if (bot.cbv2LockedUntil && new Date(bot.cbv2LockedUntil).getTime() > nowMs) {
      return 'cooldown_active';
    }
    if (bot.dcaEnabled === true) return 'dca_mode';
    if (!Number.isFinite(tradesLen) || tradesLen <= 0) return 'no_positions';
    if (klinesLen != null && klinesLen < 21) return 'warmup';
    return null;
  }

  // ─── FIX-2026-08-08: Phase 4 (CBv3) pure helper — testable without mocks ──
  /**
   * Decide whether CBv3 Phase 4 should skip this bot+positions.
   * Mirror of _cbv2SkipReason but for CBv3 fields. Caller already gates
   * on AppConfig.cbVersion === 'v3' before invoking this.
   *
   * @param {object|null} bot       - bot doc
   * @param {number}      tradesLen - number of open-state trades for this bot
   * @param {number|null} klinesLen - kline cache size after fetch (null = not fetched yet)
   * @param {number}      nowMs     - reference timestamp
   * @returns {string|null}
   */
  static _cbv3SkipReason(bot, tradesLen, klinesLen, nowMs) {
    if (!bot) return 'no_bot';
    if (bot.cbv3Enabled === false) return 'disabled';
    if (bot.cbv3LockedUntil && new Date(bot.cbv3LockedUntil).getTime() > nowMs) {
      return 'cooldown_active';
    }
    if (bot.dcaEnabled === true) return 'dca_mode';
    if (!Number.isFinite(tradesLen) || tradesLen <= 0) return 'no_positions';
    if (klinesLen != null && klinesLen < 21) return 'warmup';
    return null;
  }
}

// Export singleton instance + class (so tests can access static helpers like _cbv2SkipReason)
const _positionWatchdogInstance = new PositionWatchdog();
module.exports = _positionWatchdogInstance;
// expose class on the singleton for tests + advanced consumers
_positionWatchdogInstance.PositionWatchdog = PositionWatchdog;
// also expose via property on module.exports for ES module-style import compatibility
module.exports.PositionWatchdog = PositionWatchdog;
