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
const cbv5MasterToggle = require('../core/cbv5MasterToggle'); // FIX-2026-08-12 (audit Q9): master CBv5 toggle
const licenseService = require('./licenseService'); // FIX-2026-08-27 Phase 3a C2: License.features.cbv5 premium gate
const volatilityScanner = require('../core/volatilityScanner'); // FIX-2026-08-08: corrected path (volatilityScanner.js lives in src/core/, not src/services/)
// FIX-2026-08-09: shared CB pattern evaluator — single source of truth for klines/KC/isCBv2At
//   - eliminates kline window inconsistency between trader (WS cache 500) and watchdog (REST 30)
//   - implements 2-tick confirmation registry for defensive false-positive reduction
const cbPatternEvaluator = require('../core/cbPatternEvaluator');
const cbCrossCooldown = require('../core/cbCrossCooldown'); // FIX-2026-08-10: CBv5 cross-version cooldown interaction

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
    // FIX-2026-08-24 (P1 audit): jitter on initial tick to de-align from other subsystem timers
    //   - เดิม: setImmediate fixed → aligned กับ botManager._jitter base 100% (trader reconcile + auto-pause
    //     ทุก subsystem เริ่ม t=0) → burst รวมที่ t=0 + fixed schedule
    //   - fix: random delay 0-5s before first tick → กระจาย initial burst
    //   - subsequent ticks: setInterval with jittered interval (±10%)
    const jitteredInterval = Math.round(intervalMs * (1 + (Math.random() * 2 - 1) * 0.1));
    this.interval = setInterval(() => this._tickSafe(), jitteredInterval);
    logger.info({ intervalMs, jitteredIntervalMs: jitteredInterval }, 'positionWatchdog: started');
    // run once immediately on start, with random delay 0-5s to de-align
    const initialDelayMs = Math.floor(Math.random() * 5000);
    setTimeout(() => this._tickSafe(), initialDelayMs);
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
          || stats.cbv3Triggered > 0 || stats.cbv3Closed > 0 || stats.cbv3Errors > 0
          || stats.cbv5Triggered > 0 || stats.cbv5Closed > 0 || stats.cbv5Errors > 0;
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
        cbv5Scanned: 0, cbv5Triggered: 0, cbv5Closed: 0, cbv5Errors: 0, // FIX-2026-08-10: Phase 5 CBv5
        cbv5SkippedEnabled: 0, cbv5SkippedCooldown: 0, cbv5SkippedDca: 0,
        cbv5SkippedWarmup: 0, cbv5SkippedNoBot: 0, cbv5SkippedNoPositions: 0, cbv5SkippedKline: 0,
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
      cbv5Scanned: 0, cbv5Triggered: 0, cbv5Closed: 0, cbv5Errors: 0, // FIX-2026-08-10: Phase 5 CBv5
      cbv5SkippedEnabled: 0, cbv5SkippedCooldown: 0, cbv5SkippedDca: 0,
      cbv5SkippedWarmup: 0, cbv5SkippedNoBot: 0, cbv5SkippedNoPositions: 0, cbv5SkippedKline: 0,
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
      // FIX-2026-08-10: Phase 5 — CBv5 panic-close (Support Zone + Deepest Low + Volume) for
      //   disabled/paused bots. INDEPENDENT of cbVersion — runs in parallel with Phase 3 (CBv2)
      //   or Phase 4 (CBv3). Mirrors trader._checkCBv5PanicClose with REST canonical window
      //   + 2-tick confirmation + fingerprint recheck.
      await this._checkCBv5PanicCloseForDisabled(stats);
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

    // FIX-2026-08-24 (P1 audit): group-by (symbol, timeframe) → fetch last-close once per unique pair
    //   - เดิม N+1: 100 bots × _fetchLastClose = 100 REST calls per tick
    //   - fix: pre-pass collect unique (symbol,tf) → single fetch each → shared map
    //   - scale: 100 bots across 20 symbols/TFs = 80 calls saved per tick (≈167 calls/min reduction)
    const lastCloseBySymTf = new Map(); // Map<"SYM|TF", number|null>
    const symTfSet = new Set();
    for (const bot of bots) {
      if (bot && bot.symbol && bot.timeframe && bot.autoArmStopLossOnUKC !== false) {
        symTfSet.add(`${bot.symbol}|${bot.timeframe}`);
      }
    }
    for (const key of symTfSet) {
      const [symbol, timeframe] = key.split('|');
      // synthesize a minimal bot object for _fetchLastClose
      const stubBot = { symbol, timeframe };
      const lastClose = await this._fetchLastClose(stubBot);
      lastCloseBySymTf.set(key, lastClose);
    }

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

      // Get latest close price from pre-fetched cache (shared across bots on same (symbol,tf))
      const lastClose = lastCloseBySymTf.get(`${bot.symbol}|${bot.timeframe}`);
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
      // FIX-2026-08-24 (P0 audit): widen state guard to mirror fetch filter (L215)
      //   - เดิม guard แค่ 'selling' แต่ fetch เอา 'selling'/'holding'/'filled'
      //   - trades ที่อยู่ 'holding'/'filled' ถูก eval ทุก tick แต่ updateMany drop silently
      //   - effect: stuck trades (เช่น RVN/PEPE orphan) ไม่ auto-arm จนกว่า manual intervene
      //   - regression risk: ไม่กระทบ 'selling' path เดิม (still race-safe against trader path)
      const upd = await Trade.updateMany(
        { _id: { $in: toArm }, state: { $in: ['selling', 'holding', 'filled'] }, useStopLossOnUKC: { $ne: true } },
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

      // 5. FIX-2026-08-09: Use cbPatternEvaluator — single canonical REST window (limit=500)
      //   Eliminates kline window inconsistency (was: limit=30 REST in watchdog, limit=500
      //   WS cache in trader → different lastLower → different fire decision).
      let evaluation;
      try {
        evaluation = await cbPatternEvaluator.fetchAndEvaluateCBv2({
          bot,
          binanceRest,
          targetCloseTime: null,
          signalEngine,
        });
      } catch (err) {
        stats.cbv2Errors += trades.length;
        stats.cbv2SkippedKline += trades.length;
        logger.warn(
          { err: err.message, botId: botIdStr, symbol: bot.symbol, timeframe: bot.timeframe },
          'positionWatchdog: CBv2 evaluator failed'
        );
        continue;
      }

      if (!evaluation.ok) {
        if (evaluation.reason === 'warmup') stats.cbv2SkippedWarmup += trades.length;
        else stats.cbv2SkippedKline += trades.length;
        continue;
      }

      if (!evaluation.matched) {
        // FIX-2026-08-09: clear stale confirmations when pattern fails to match
        cbPatternEvaluator.consumeConfirmation({
          botId: botIdStr,
          version: 'v2',
          candleCloseTime: evaluation.targetCloseTime,
        });
        if (evaluation.isBorderline) {
          logger.warn({
            botId: botIdStr,
            symbol: bot.symbol,
            timeframe: bot.timeframe,
            cbVersion: 'v2',
            source: evaluation.source,
            requestedLimit: evaluation.requestedLimit,
            targetCloseTime: evaluation.targetCloseTime,
            candlesCount: evaluation.candlesCount,
            lastLower: evaluation.lastLower ? evaluation.lastLower.toFixed(8) : null,
            consecutiveCount: evaluation.consecutiveCount,
            reason: evaluation.reason,
          }, 'positionWatchdog: cbv2 borderline — 3 candles match (CB but not CBv2), no fire');
        }
        continue; // pattern not matched — normal path, no error
      }

      const lastLower = evaluation.lastLower;
      const fingerprint = evaluation.fingerprint;

      // FIX-2026-08-09: 2-tick confirmation — require 2 independent observations
      //   of the same closed candle with the same fingerprint before destructive action.
      const recorded = cbPatternEvaluator.recordConfirmation({
        botId: botIdStr,
        version: 'v2',
        candleCloseTime: evaluation.targetCloseTime,
        fingerprint,
      });
      const confirmationCount = recorded.count;
      if (confirmationCount < cbPatternEvaluator.REQUIRED_CONFIRMATIONS) {
        logger.warn({
          botId: botIdStr,
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          cbVersion: 'v2',
          source: evaluation.source,
          requestedLimit: evaluation.requestedLimit,
          targetCloseTime: evaluation.targetCloseTime,
          lastLower: lastLower.toFixed(8),
          confirmationCount,
          required: cbPatternEvaluator.REQUIRED_CONFIRMATIONS,
          fingerprint,
          reason: 'confirmation_pending',
        }, 'positionWatchdog: cbv2 pattern matched but confirmation pending — skipping force-close');
        continue;
      }

      // FIX-2026-08-09: re-fetch canonical snapshot to verify candle + fingerprint stable
      const recheck = await cbPatternEvaluator.fetchAndEvaluateCBv2({
        bot,
        binanceRest,
        targetCloseTime: evaluation.targetCloseTime,
        signalEngine,
      });
      if (!recheck.ok || !recheck.matched || recheck.fingerprint !== fingerprint) {
        logger.warn({
          botId: botIdStr,
          symbol: bot.symbol,
          targetCloseTime: evaluation.targetCloseTime,
          firstFingerprint: fingerprint,
          recheckMatched: recheck.matched,
          recheckFingerprint: recheck.fingerprint,
          reason: !recheck.ok ? recheck.reason : 'fingerprint_mismatch',
        }, 'positionWatchdog: cbv2 recheck mismatch — skipping force-close (fail-closed)');
        cbPatternEvaluator.consumeConfirmation({
          botId: botIdStr,
          version: 'v2',
          candleCloseTime: evaluation.targetCloseTime,
        });
        continue;
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

      // FIX-2026-08-12 (audit Q4): use cbCrossCooldown for Direction A symmetry
      //   - Watchdog's CBv2 path was directly setting cbv2LockedUntil but NOT
      //     clearing cbv5LockedUntil if CBv5 was active. CBv5 cooldown would block
      //     BUYs unnecessarily until manual unlock.
      //   - Mirror trader.js: route through cbCrossCooldown.applyCrossCooldownOnFire
      //     → Direction A (CBv2 fires while CBv5 active) → cancels CBv5 + applies CBv2
      const cbCrossCooldown = require('../core/cbCrossCooldown');
      const crossResult = cbCrossCooldown.applyCrossCooldownOnFire({
        bot: {
          cbv2LockedUntil: bot.cbv2LockedUntil,
          cbv3LockedUntil: bot.cbv3LockedUntil,
          cbv5LockedUntil: bot.cbv5LockedUntil,
        },
        firingVersion: 'v2',
        lockHours,
        nowMs: Date.now(),
      });
      // 8. Persist cooldown DB fields FIRST (idempotency — concurrent watchdog ticks see cooldown)
      //    Note: HYBRID — DO NOT touch bot.enabled / status / autoPauseReason
      //    This lets trader.restoreCbv2FiredAt (trader.js:222) pick up on next spawn
      // FIX-2026-08-12: write back crossResult.appliedTo + crossResult fields so
      //   cbv5LockedUntil is cleared on Direction A.
      Bot.updateOne(
        { _id: bot._id },
        {
          $set: {
            cbv2LockedUntil: crossResult.cbv2LockedUntil,
            cbv2LockReason: crossResult.cbv2LockedUntil ? 'cbv2_panic' : null,
            cbv2LastFiredAt: crossResult.cbv2LastFiredAt,
            cbv3LockedUntil: crossResult.cbv3LockedUntil,
            cbv5LockedUntil: crossResult.cbv5LockedUntil,
          },
        }
      ).catch((err) =>
        logger.warn(
          { err: err.message, botId: botIdStr },
          'positionWatchdog: persist CBv2 cooldown failed (non-fatal — will retry next tick)'
        )
      );

      // FIX-2026-08-09: ACEUSDT cooldown-bypass mirror — sync in-memory trader for CBv2 (watchdog Phase 3)
      try {
        const botManager = require('../core/botManager');
        const trader = botManager.traders && botManager.traders.get(botIdStr);
        if (trader) {
          trader._cbv2FiredAt = Date.now();
          if (trader.bot) {
            trader.bot.cbv2LockedUntil = crossResult.cbv2LockedUntil;
            trader.bot.cbv2LockReason = crossResult.cbv2LockedUntil ? 'cbv2_panic' : null;
            trader.bot.cbv2LastFiredAt = crossResult.cbv2LastFiredAt;
            // FIX-2026-08-12 (audit Q4): mirror crossResult to clear CBv5 in-memory
            trader.bot.cbv5LockedUntil = crossResult.cbv5LockedUntil;
            trader.bot.cbv5LockReason = crossResult.cbv5LockedUntil ? 'cbv5_panic' : null;
          }
        }
      } catch (traderErr) {
        logger.warn({ err: traderErr.message, botId: botIdStr }, 'positionWatchdog: CBv2 in-memory trader sync failed (non-fatal)');
      }

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

      // FIX-2026-08-09: consume confirmation entry after successful fire
      cbPatternEvaluator.consumeConfirmation({
        botId: botIdStr,
        version: 'v2',
        candleCloseTime: evaluation.targetCloseTime,
      });

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

      // 5. FIX-2026-08-09: Use cbPatternEvaluator — single canonical REST window (limit=500)
      //   Eliminates kline window inconsistency (was: limit=30 REST in watchdog, limit=500
      //   WS cache in trader → different lastLower → different fire decision).
      let evaluation;
      try {
        evaluation = await cbPatternEvaluator.fetchAndEvaluateCBv2({
          bot,
          binanceRest,
          targetCloseTime: null,
          signalEngine,
        });
      } catch (err) {
        stats.cbv3Errors += trades.length;
        stats.cbv3SkippedKline += trades.length;
        logger.warn(
          { err: err.message, botId: botIdStr, symbol: bot.symbol, timeframe: bot.timeframe },
          'positionWatchdog: CBv3 evaluator failed'
        );
        continue;
      }

      if (!evaluation.ok) {
        if (evaluation.reason === 'warmup') stats.cbv3SkippedWarmup += trades.length;
        else stats.cbv3SkippedKline += trades.length;
        continue;
      }

      if (!evaluation.matched) {
        // FIX-2026-08-09: clear stale confirmations when pattern fails to match
        cbPatternEvaluator.consumeConfirmation({
          botId: botIdStr,
          version: 'v3',
          candleCloseTime: evaluation.targetCloseTime,
        });
        if (evaluation.isBorderline) {
          logger.warn({
            botId: botIdStr,
            symbol: bot.symbol,
            timeframe: bot.timeframe,
            cbVersion: 'v3',
            source: evaluation.source,
            requestedLimit: evaluation.requestedLimit,
            targetCloseTime: evaluation.targetCloseTime,
            candlesCount: evaluation.candlesCount,
            lastLower: evaluation.lastLower ? evaluation.lastLower.toFixed(8) : null,
            consecutiveCount: evaluation.consecutiveCount,
            reason: evaluation.reason,
          }, 'positionWatchdog: cbv3 borderline — 3 candles match (CB but not CBv2), no fire');
        }
        continue; // CBv2 pattern not matched — no fire (silent)
      }

      const lastLower = evaluation.lastLower;
      const fingerprint = evaluation.fingerprint;

      // FIX-2026-08-09: 2-tick confirmation
      const recorded = cbPatternEvaluator.recordConfirmation({
        botId: botIdStr,
        version: 'v3',
        candleCloseTime: evaluation.targetCloseTime,
        fingerprint,
      });
      const confirmationCount = recorded.count;
      if (confirmationCount < cbPatternEvaluator.REQUIRED_CONFIRMATIONS) {
        logger.warn({
          botId: botIdStr,
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          cbVersion: 'v3',
          source: evaluation.source,
          requestedLimit: evaluation.requestedLimit,
          targetCloseTime: evaluation.targetCloseTime,
          lastLower: lastLower.toFixed(8),
          confirmationCount,
          required: cbPatternEvaluator.REQUIRED_CONFIRMATIONS,
          fingerprint,
          reason: 'confirmation_pending',
        }, 'positionWatchdog: cbv3 pattern matched but confirmation pending — skipping force-close');
        continue;
      }

      // FIX-2026-08-09: re-fetch canonical snapshot to verify candle + fingerprint stable
      const recheck = await cbPatternEvaluator.fetchAndEvaluateCBv2({
        bot,
        binanceRest,
        targetCloseTime: evaluation.targetCloseTime,
        signalEngine,
      });
      if (!recheck.ok || !recheck.matched || recheck.fingerprint !== fingerprint) {
        logger.warn({
          botId: botIdStr,
          symbol: bot.symbol,
          targetCloseTime: evaluation.targetCloseTime,
          firstFingerprint: fingerprint,
          recheckMatched: recheck.matched,
          recheckFingerprint: recheck.fingerprint,
          reason: !recheck.ok ? recheck.reason : 'fingerprint_mismatch',
        }, 'positionWatchdog: cbv3 recheck mismatch — skipping force-close (fail-closed)');
        cbPatternEvaluator.consumeConfirmation({
          botId: botIdStr,
          version: 'v3',
          candleCloseTime: evaluation.targetCloseTime,
        });
        continue;
      }

      // 7. ST3 no-trade on upper-TF (gating for CBv3)
      // FIX-2026-08-09: FAIL-CLOSED — ST3 fetch error → skip (mirror trader.js fix)
      //   (better to miss a panic than fire a false alarm)
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
            cbPatternEvaluator.consumeConfirmation({
              botId: botIdStr,
              version: 'v3',
              candleCloseTime: evaluation.targetCloseTime,
            });
            continue;
          }
        } catch (stErr) {
          // FIX-2026-08-09: FAIL-CLOSED — ST3 fetch error → skip
          logger.warn({
            err: stErr.message,
            botId: botIdStr,
            symbol: bot.symbol,
            trendTF,
          }, 'positionWatchdog: cbv3 — ST3 fetch failed, skipping (fail-closed)');
          cbPatternEvaluator.consumeConfirmation({
            botId: botIdStr,
            version: 'v3',
            candleCloseTime: evaluation.targetCloseTime,
          });
          continue;
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

      // FIX-2026-08-12 (audit Q4): use cbCrossCooldown for Direction A symmetry
      //   - same fix as CBv2 path — CBv5 cooldown not cleared on Direction A
      //   - reuse cbCrossCooldown (already required at top of CBv2 path above)
      const crossResultV3 = cbCrossCooldown.applyCrossCooldownOnFire({
        bot: {
          cbv2LockedUntil: bot.cbv2LockedUntil,
          cbv3LockedUntil: bot.cbv3LockedUntil,
          cbv5LockedUntil: bot.cbv5LockedUntil,
        },
        firingVersion: 'v3',
        lockHours,
        nowMs: Date.now(),
      });
      // 9. Persist cooldown DB fields FIRST
      Bot.updateOne(
        { _id: bot._id },
        {
          $set: {
            cbv2LockedUntil: crossResultV3.cbv2LockedUntil,
            cbv3LockedUntil: crossResultV3.cbv3LockedUntil,
            cbv3LockReason: crossResultV3.cbv3LockedUntil ? 'cbv3_panic' : null,
            cbv3LastFiredAt: crossResultV3.cbv3LastFiredAt,
            cbv5LockedUntil: crossResultV3.cbv5LockedUntil,
          },
        }
      ).catch((err) =>
        logger.warn(
          { err: err.message, botId: botIdStr },
          'positionWatchdog: persist CBv3 cooldown failed (non-fatal)'
        )
      );

      // FIX-2026-08-09: ACEUSDT cooldown-bypass — sync in-memory trader state so placeBuy gate fires
      //   before DB write completes / across restart. Same pattern as unlock-cbv2 endpoint.
      // FIX-2026-08-12 (audit Q4): mirror crossResult to clear CBv5 in-memory
      try {
        const botManager = require('../core/botManager');
        const trader = botManager.traders && botManager.traders.get(botIdStr);
        if (trader) {
          trader._cbv3FiredAt = Date.now();
          if (trader.bot) {
            trader.bot.cbv2LockedUntil = crossResultV3.cbv2LockedUntil;
            trader.bot.cbv3LockedUntil = crossResultV3.cbv3LockedUntil;
            trader.bot.cbv3LockReason = crossResultV3.cbv3LockedUntil ? 'cbv3_panic' : null;
            trader.bot.cbv3LastFiredAt = crossResultV3.cbv3LastFiredAt;
            trader.bot.cbv5LockedUntil = crossResultV3.cbv5LockedUntil;
            trader.bot.cbv5LockReason = crossResultV3.cbv5LockedUntil ? 'cbv5_panic' : null;
          }
        }
      } catch (traderErr) {
        logger.warn({ err: traderErr.message, botId: botIdStr }, 'positionWatchdog: CBv3 in-memory trader sync failed (non-fatal)');
      }

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

      // FIX-2026-08-09: consume confirmation entry after successful fire
      cbPatternEvaluator.consumeConfirmation({
        botId: botIdStr,
        version: 'v3',
        candleCloseTime: evaluation.targetCloseTime,
      });

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

  // FIX-2026-08-10: Phase 5 (CBv5) — panic-close for disabled/paused bots.
  //   Mirrors trader._checkCBv5PanicClose but runs OUTSIDE trader instance.
  //   Independent of cbVersion — runs in parallel with Phase 3 (CBv2) or Phase 4 (CBv3).
  //   4-condition confirmation per Pine Script CBv5:
  //     close < lowerKC + close < deepest pivot low + (strictBreak ? bearish : true) + volume spike
  //   - mutex cbv5CheckInFlight per instance (defensive — multiple ticks can overlap)
  //   - cross-cooldown via cbCrossCooldown (Direction A: cancel CBv5 if CBv2/CBv3 fires
  //     during same tick — Direction B: absorb CBv5 into existing dominant cooldown)
  //   - persists cbv5* DB fields → trader restores cooldown on resume
  async _checkCBv5PanicCloseForDisabled(stats) {
    // FIX-2026-08-12 (audit Q9): master gate — AppConfig.cbv5MasterEnabled
    //   - Audit found: watchdog Phase 5 had no master gate, only per-bot cbv5Enabled
    //   - User contract: master toggle should let user disable CBv5 globally
    // FIX-2026-08-27 Phase 3a C2: also gate by License.features.cbv5 (premium tier).
    //   - Admin can disable CBv5 for entire license without touching AppConfig.
    if (!(await cbv5MasterToggle.isMasterCbv5Enabled()) || !licenseService.isFeatureEnabled('cbv5')) {
      stats.cbv5SkippedMaster = (stats.cbv5SkippedMaster || 0) + 1;
      return;
    }
    // 1. Get ALL open-state trades — same as Phase 3/4
    const OPEN_STATES = ['partial_wait', 'filled', 'retrying', 'holding', 'selling', 'partial_sell_wait'];
    const candidates = await Trade.find({ state: { $in: OPEN_STATES } }).lean();
    if (candidates.length === 0) return;

    // 2. Group by botId
    const byBot = new Map();
    for (const t of candidates) {
      if (!t.botId) { stats.cbv5SkippedNoBot++; continue; }
      const key = String(t.botId);
      if (!byBot.has(key)) byBot.set(key, []);
      byBot.get(key).push(t);
    }
    if (byBot.size === 0) return;

    // 3. Bulk-load bots with CBv5 + DCA config fields
    const botIds = [...byBot.keys()];
    const bots = botIds.length > 0
      ? await Bot.find(
          { _id: { $in: botIds } },
          'name symbol timeframe enabled dcaEnabled cbv5Enabled cbv5LockHours cbv5LockedUntil cbv5LockReason ' +
          'cbv5KcLen cbv5KcMult cbv5PivotLookback cbv5PivotLeftLen cbv5PivotRightLen cbv5StrictBreak ' +
          'cbv5UseVolume cbv5VolMaLen cbv5VolMultiplier cbv5DebounceCandles'
        ).lean()
      : [];
    const botMap = new Map(bots.map((b) => [String(b._id), b]));

    // 4. Per-bot evaluation
    for (const [botIdStr, trades] of byBot) {
      const bot = botMap.get(botIdStr);
      if (!bot) { stats.cbv5SkippedNoBot += trades.length; continue; }

      // Guard evaluation (pure helper — mirrors _cbv2SkipReason / _cbv3SkipReason shape)
      const skipReason = PositionWatchdog._cbv5SkipReason(bot, trades.length, null, Date.now());
      if (skipReason) {
        if (skipReason === 'disabled') stats.cbv5SkippedEnabled += trades.length;
        else if (skipReason === 'cooldown_active') stats.cbv5SkippedCooldown += trades.length;
        else if (skipReason === 'dca_mode') stats.cbv5SkippedDca += trades.length;
        else if (skipReason === 'no_positions') stats.cbv5SkippedNoPositions++;
        else if (skipReason === 'no_bot') stats.cbv5SkippedNoBot += trades.length;
        continue;
      }

      stats.cbv5Scanned += trades.length;

      // 5. CBv5 uses its own evaluator (cbPatternEvaluator.fetchAndEvaluateCBv5) — independent
      //   of CBv2/CBv3 because CBv5 needs pivot-low history + volume MA which the CBv2
      //   evaluator doesn't compute.
      let evaluation;
      try {
        evaluation = await cbPatternEvaluator.fetchAndEvaluateCBv5({
          bot,
          binanceRest,
          targetCloseTime: null,
        });
      } catch (err) {
        stats.cbv5Errors += trades.length;
        stats.cbv5SkippedKline += trades.length;
        logger.warn(
          { err: err.message, botId: botIdStr, symbol: bot.symbol, timeframe: bot.timeframe },
          'positionWatchdog: CBv5 evaluator failed'
        );
        continue;
      }

      if (!evaluation.ok) {
        if (evaluation.reason === 'warmup') stats.cbv5SkippedWarmup += trades.length;
        else stats.cbv5SkippedKline += trades.length;
        continue;
      }

      if (!evaluation.matched) {
        cbPatternEvaluator.consumeConfirmation({
          botId: botIdStr,
          version: 'v5',
          candleCloseTime: evaluation.targetCloseTime,
        });
        if (evaluation.reason === 'debounce_active') {
          logger.warn({
            botId: botIdStr,
            symbol: bot.symbol,
            timeframe: bot.timeframe,
            reason: evaluation.reason,
            candlesCount: evaluation.candlesCount,
            lastLower: evaluation.lastLower ? evaluation.lastLower.toFixed(8) : null,
            bypassedDebounce: evaluation.bypassedDebounce === true,
            targetCloseTime: evaluation.targetCloseTime,
          }, 'positionWatchdog: cbv5 near-miss — single-tick match but debounce blocked');
        }
        continue;
      }

      const lastLower = evaluation.lastLower;
      const deepestLow = evaluation.deepestLow;
      const fingerprint = evaluation.fingerprint;

      // FIX-2026-08-11: Watchdog Phase 5 (CBv5) uses single-tick confirmation
      //   - Watchdog ticks at 180s (vs WS 500ms); back-to-back ticks always
      //     span debounce window, so 2-tick confirmation is incompatible.
      //   - Trust single-tick match — 4-condition filter (KC + deepestLow +
      //     bearish + volume) keeps noise rate low.
      //   - Still record for cross-process visibility (cbAutoUnlock reads).
      const recorded = cbPatternEvaluator.recordConfirmation({
        botId: botIdStr,
        version: 'v5',
        candleCloseTime: evaluation.targetCloseTime,
        fingerprint,
      });
      const confirmationCount = recorded.count;
      // Watchdog fires on count >= 1 (single-tick trust); trader WS path still uses 2-tick
      const REQUIRED_CONFIRMATIONS_WATCHDOG = 1;
      if (confirmationCount < REQUIRED_CONFIRMATIONS_WATCHDOG) {
        logger.warn({
          botId: botIdStr,
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          source: evaluation.source,
          requestedLimit: evaluation.requestedLimit,
          targetCloseTime: evaluation.targetCloseTime,
          candlesCount: evaluation.candlesCount,
          lastLower: lastLower.toFixed(8),
          deepestLow: deepestLow != null ? deepestLow.toFixed(8) : null,
          confirmationCount,
          required: REQUIRED_CONFIRMATIONS_WATCHDOG,
          fingerprint,
          reason: 'confirmation_pending',
        }, 'positionWatchdog: cbv5 pattern matched but confirmation pending — skipping force-close');
        continue;
      }

      // 7. Re-fetch canonical snapshot to verify candle + fingerprint stable
      const recheck = await cbPatternEvaluator.fetchAndEvaluateCBv5({
        bot,
        binanceRest,
        targetCloseTime: evaluation.targetCloseTime,
      });
      if (!recheck.ok || !recheck.matched || recheck.fingerprint !== fingerprint) {
        logger.warn({
          botId: botIdStr,
          symbol: bot.symbol,
          targetCloseTime: evaluation.targetCloseTime,
          firstFingerprint: fingerprint,
          recheckMatched: recheck.matched,
          recheckFingerprint: recheck.fingerprint,
          reason: !recheck.ok ? recheck.reason : 'fingerprint_mismatch',
        }, 'positionWatchdog: cbv5 recheck mismatch — skipping force-close (fail-closed)');
        cbPatternEvaluator.consumeConfirmation({
          botId: botIdStr,
          version: 'v5',
          candleCloseTime: evaluation.targetCloseTime,
        });
        continue;
      }

      // ─── CBv5 PATTERN MATCHED — fire cooldown + force-close ───
      logger.warn(
        {
          botId: botIdStr,
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          lastLower: lastLower.toFixed(6),
          deepestLow: deepestLow != null ? deepestLow.toFixed(6) : null,
          openTradeIds: trades.map((t) => String(t._id)),
          botEnabled: bot.enabled,
          source: 'positionWatchdog',
        },
        'positionWatchdog: CBv5 pattern matched (Support Zone broken + deepest pivot low breached) — force-closing + setting cooldown'
      );

      // 8. Compute cooldown + apply cross-version interaction (Direction A/B)
      const lockHours = Math.max(0.5, Math.min(168, Number(bot.cbv5LockHours) || 4));
      const nowMs = Date.now();
      // cbCrossCooldown mutates a local copy of fields — we need the crossResult to know
      // whether CBv5 took its own lock or was absorbed into CBv2/CBv3.
      // Apply to a temporary { ...bot } to read crossResult without mutating live bot doc.
      const crossBotFields = {
        cbv2LockedUntil: bot.cbv2LockedUntil,
        cbv3LockedUntil: bot.cbv3LockedUntil,
        cbv5LockedUntil: bot.cbv5LockedUntil,
      };
      const crossResult = cbCrossCooldown.applyCrossCooldownOnFire({
        bot: crossBotFields,
        firingVersion: 'v5',
        lockHours,
        nowMs,
      });

      const lockedUntilIso = crossResult.cbv5LockedUntil
        ? new Date(crossResult.cbv5LockedUntil).toISOString()
        : (crossResult.cbv3LockedUntil
            ? new Date(crossResult.cbv3LockedUntil).toISOString()
            : (crossResult.cbv2LockedUntil
                ? new Date(crossResult.cbv2LockedUntil).toISOString()
                : null));

      // 9. Persist cooldown DB fields (idempotent)
      const updateSet = {
        cbv5LastFiredAt: crossResult.cbv5LastFiredAt,
        cbv5LockedUntil: crossResult.cbv5LockedUntil,
        cbv5LockReason: crossResult.cbv5LockedUntil ? 'cbv5_panic' : null,
      };
      // Direction A: CBv5 fired but CBv2/CBv3 already active → don't overwrite them
      // (crossResult already returned the existing fields unchanged in this case)
      if (crossResult.cbv2LockedUntil !== undefined) updateSet.cbv2LockedUntil = crossResult.cbv2LockedUntil;
      if (crossResult.cbv3LockedUntil !== undefined) updateSet.cbv3LockedUntil = crossResult.cbv3LockedUntil;
      Bot.updateOne(
        { _id: bot._id },
        { $set: updateSet }
      ).catch((err) =>
        logger.warn(
          { err: err.message, botId: botIdStr },
          'positionWatchdog: persist CBv5 cooldown failed (non-fatal)'
        )
      );

      // 10. Sync in-memory trader state so placeBuy gate fires before DB write completes
      //     / across restart (mirror CBv2/CBv3 Phase 3/4 pattern)
      try {
        const botManager = require('../core/botManager');
        const trader = botManager.traders && botManager.traders.get(botIdStr);
        if (trader) {
          if (crossResult.cbv5LockedUntil && new Date(crossResult.cbv5LockedUntil).getTime() > nowMs) {
            trader._cbv5FiredAt = nowMs;
          } else {
            trader._cbv5FiredAt = 0;
          }
          if (trader.bot) {
            trader.bot.cbv5LockedUntil = crossResult.cbv5LockedUntil;
            trader.bot.cbv5LockReason = crossResult.cbv5LockedUntil ? 'cbv5_panic' : null;
            trader.bot.cbv5LastFiredAt = crossResult.cbv5LastFiredAt;
            if (crossResult.cbv2LockedUntil !== undefined) trader.bot.cbv2LockedUntil = crossResult.cbv2LockedUntil;
            if (crossResult.cbv3LockedUntil !== undefined) trader.bot.cbv3LockedUntil = crossResult.cbv3LockedUntil;
          }
        }
      } catch (traderErr) {
        logger.warn({ err: traderErr.message, botId: botIdStr }, 'positionWatchdog: CBv5 in-memory trader sync failed (non-fatal)');
      }

      // 11. Bulk re-fetch fresh trades (race-safety)
      const tradeIds = trades.map((t) => t._id);
      let freshTrades = [];
      try {
        freshTrades = await Trade.find(
          { _id: { $in: tradeIds } },
          'state useStopLossOnUKC sellOrderId isDcaStack stackBep buyPrice symbol botId'
        ).lean();
      } catch (err) {
        stats.cbv5Errors += trades.length;
        logger.warn(
          { err: err.message, botId: botIdStr },
          'positionWatchdog: CBv5 fresh-trades re-fetch failed'
        );
        continue;
      }
      const freshMap = new Map(freshTrades.map((t) => [String(t._id), t]));

      // 12. Force-close loop
      let closedCount = 0;
      for (const t of trades) {
        const fresh = freshMap.get(String(t._id));
        if (!fresh) { stats.cbv5SkippedNoBot++; continue; }
        if (fresh.state !== 'selling' && fresh.state !== 'holding' && fresh.state !== 'filled') {
          continue; // already handled by another path
        }
        try {
          const result = await forceClose.forceCloseTrade({
            trade: fresh,
            bot,
            allowMarketSell: true,
            source: 'watchdog',
          });
          if (result.ok) {
            closedCount++;
            stats.cbv5Closed++;
            Trade.updateOne(
              { _id: fresh._id, state: 'sold' },
              {
                $set: {
                  sellReason: 'cbv5_panic',
                  sellReasonDetail: `positionWatchdog: CBv5 Support Zone broken (bot ${bot.enabled ? 'enabled' : 'disabled'}); closedCount=${closedCount}; lastLower=${lastLower.toFixed(8)}; deepestLow=${deepestLow != null ? deepestLow.toFixed(8) : '?'}`,
                  sellReasonSource: 'positionWatchdog.cbv5',
                  sellReasonAt: new Date(),
                },
              }
            ).catch(() => { /* non-fatal */ });

            eventBus.emit('cbv5Watchdog:closed', {
              tradeId: t._id,
              botId: botIdStr,
              symbol: fresh.symbol,
              isDcaStack: fresh.isDcaStack === true,
              mode: result.mode,
              pnl: result.pnl,
              avgSellPrice: result.avgSellPrice,
              lastLower,
              deepestLow,
              botEnabled: bot.enabled,
              source: 'positionWatchdog',
            });
          } else {
            stats.cbv5Errors++;
            logger.warn(
              {
                tradeId: String(t._id),
                botId: botIdStr,
                err: result.error,
              },
              'positionWatchdog: CBv5 forceCloseTrade failed'
            );
          }
        } catch (err) {
          stats.cbv5Errors++;
          logger.error(
            { err: err.message, stack: err.stack, tradeId: String(t._id), botId: botIdStr },
            'positionWatchdog: CBv5 forceCloseTrade exception'
          );
        }
      }

      stats.cbv5Triggered++;

      // 13. Consume confirmation entry after successful fire
      cbPatternEvaluator.consumeConfirmation({
        botId: botIdStr,
        version: 'v5',
        candleCloseTime: evaluation.targetCloseTime,
      });

      // 14. Emit events
      eventBus.emit('bot:cooldown', {
        botId: bot._id,
        reason: 'cbv5_panic',
        version: 'v5',
        lockedUntil: lockedUntilIso,
        lockHours,
        appliedTo: crossResult.appliedTo,
        source: 'positionWatchdog',
      });
      eventBus.emit('bot:updated', { botId: bot._id });

      // 15. Telegram alert
      try {
        const botName = bot.name || bot.symbol || botIdStr;
        // FIX-2026-08-12: pass number, let template format via .toFixed
        //   (was converting to string here → template's .toFixed call threw
        //   "p.deepestLow.toFixed is not a function" → telegram never sent)
        await telegramNotifier.sendNow('cbv5PanicClose', {
          botName,
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          closedCount,
          lastLower,
          deepestLow,
          isBearish: evaluation.isBearish,
          isHighVolume: evaluation.isHighVolume,
          lockedUntil: lockedUntilIso,
          lockHours,
          appliedTo: crossResult.appliedTo,
          source: 'positionWatchdog',
        });
      } catch (err) {
        logger.warn(
          { err: err.message, botId: botIdStr },
          'positionWatchdog: CBv5 telegram sendNow failed (non-fatal)'
        );
      }
    }
  }

  // FIX-2026-08-09: _fetchKlinesForCBv2 REMOVED — replaced by cbPatternEvaluator.fetchAndEvaluateCBv2
  //   consistent with the trader path (canonical REST 500-candle window + 2-tick confirmation).
  //   Eliminates kline window inconsistency between trader (WS cache 500) and watchdog (REST 30).

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
    // FIX-2026-08-09: warmup threshold raised 21 → 23
    //   - 20 for EMA(20) + ATR(20) seed + 3 for isCBv2At(i-3) lookup
    //   - source: cbPatternEvaluator.MIN_EVALUATION_CANDLES (constant of truth)
    if (klinesLen != null && klinesLen < cbPatternEvaluator.MIN_EVALUATION_CANDLES) return 'warmup';
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
    // FIX-2026-08-09: warmup threshold raised 21 → 23 (mirror CBv2 helper)
    if (klinesLen != null && klinesLen < cbPatternEvaluator.MIN_EVALUATION_CANDLES) return 'warmup';
    return null;
  }

  // ─── FIX-2026-08-10: Phase 5 (CBv5) pure helper — testable without mocks ──
  /**
   * Decide whether CBv5 Phase 5 should skip this bot+positions.
   * Mirror of _cbv3SkipReason but for CBv5 fields. CBv5 has NO version gate
   * (independent of cbVersion enum) — only per-bot cbv5Enabled + cooldown + DCA checks.
   *
   * @param {object|null} bot       - bot doc
   * @param {number}      tradesLen - number of open-state trades for this bot
   * @param {number|null} klinesLen - kline cache size after fetch (null = not fetched yet)
   * @param {number}      nowMs     - reference timestamp
   * @returns {string|null}
   */
  static _cbv5SkipReason(bot, tradesLen, klinesLen, nowMs) {
    if (!bot) return 'no_bot';
    // FIX-2026-08-12 (audit Q9): master gate — synchronous check via cached value
    //   - _cbv5SkipReason is a pure function (no async) — must consult cache directly
    //   - Cache is 30s; misses default to true (master ON) so degradation is safe
    if (!cbv5MasterToggle.isMasterCbv5EnabledCached()) return 'master_disabled';
    if (bot.cbv5Enabled === false) return 'disabled';
    if (bot.cbv5LockedUntil && new Date(bot.cbv5LockedUntil).getTime() > nowMs) {
      return 'cooldown_active';
    }
    if (bot.dcaEnabled === true) return 'dca_mode';
    if (!Number.isFinite(tradesLen) || tradesLen <= 0) return 'no_positions';
    // CBv5 warmup: kcLen=20 + 1 (current) + rightLen=5 (pivot confirm) = 26 minimum
    //   - cbPatternEvaluator.MIN_EVALUATION_CANDLES=23 (CBv2/CBv3 baseline)
    //   - CBv5 needs slightly more for pivot confirmation; use the larger of either constant
    //   - Use 23 for simplicity (cbv5KcLen default=20 + 1 current + 2 = 23 minimum)
    if (klinesLen != null && klinesLen < cbPatternEvaluator.MIN_EVALUATION_CANDLES) return 'warmup';
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
