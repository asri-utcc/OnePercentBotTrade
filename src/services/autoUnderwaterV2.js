'use strict';

/**
 * FIX-2026-09-06: AUv2 — Auto-Underwater v2 (F1 auto-arm variant)
 *
 * Background:
 *   F1 auto-arm (trader._autoArmStopLossOnUKC) ใช้ age + loss > X% → arm SL-UKC
 *   flag → รอ close > upperKC (price action) ก่อน trigger.
 *
 *   AUv2 = F1 variant — ใช้ age + loss **shallower** than threshold → MARKET SELL
 *   ทันที (ไม่ต้องรอ price action).
 *
 *   Use case: position underwater มานาน รอ recovery — เมื่อ underwater ลดลงจน "ตื้นพอ"
 *   (เช่น -10% → -4.9%) ให้ปิดทำกำไรทันทีโดยไม่ต้องรอ breakout upperKC.
 *
 * Design:
 *   - Singleton scheduler with in-flight guard (mirror positionWatchdog pattern)
 *   - Default 180s tick (AppConfig.auv2IntervalMs — mirror positionWatchdog)
 *   - NO license gate (mirrors F1 — safety feature, not premium)
 *   - Master toggle: AppConfig.auv2Enabled (no "master" prefix, matches cbEnabled pattern; default false — opt-in)
 *   - Per-bot toggle: bot.auv2Enabled (default false — opt-in)
 *   - DCA skip: trade.isDcaStack === true → AUv2 ไม่ trigger (DCA มี BEP logic ของตัวเอง)
 *   - Hard cap: bot.auv2MaxWaitDays — OPTIONAL force sell (default 0 = disabled, ให้ TP/CB/AUv1/manual จัดการเอง)
 *   - Loss metric: bot.auv2LossMode ('pct' | 'thb') เลือก 1 อย่าง
 *       * 'pct': lossPct > -bot.auv2MaxLossPct (shallower than threshold)
 *       * 'thb': lossTHB > -bot.auv2MaxLossThb (ผ่าน fxService.convertUsdtToThb)
 *   - DCA-aware: stack BEP (mirror positionWatchdog._refPrice)
 *   - Position scope: state ∈ {placed, filled, holding, selling} (mirror F1 widened)
 *
 * Skip reasons (return pure helper — testable without mocks):
 *   - 'master_off'    : AppConfig.auv2Enabled === false
 *   - 'bot_optout'    : bot.auv2Enabled === false
 *   - 'bot_disabled'  : bot.enabled !== true (FIX-2026-09-17 — skip user-paused bots)
 *   - 'dca_skip'      : trade.isDcaStack === true (AUv2 ไม่ใช้กับ DCA — DCA มี logic ของตัวเอง)
 *   - 'not_open'      : trade.state not in OPEN_STATES
 *   - 'too_young'     : age < bot.auv2MinAgeHours
 *   - 'not_shallow'   : loss ยังไม่ตื้นพอ + ไม่เกิน hard cap
 *   - 'no_close'      : Binance kline fetch failed
 *   - 'no_ref_price'  : refPrice invalid (buyPrice <= 0)
 *
 * Note: license gate was REMOVED 2026-09-06 (Bug #2 fix) — see commit 5d85d3d.
 *       `skippedLicenseOff` telemetry bucket is kept as no-op (always 0) for
 *       backward compat with existing dashboards/tests; do not re-introduce
 *       the gate without putting `auv2` in licenseService._getFeatures().
 *
 * Race-safety:
 *   - forceCloseTrade has atomic state-in-OPEN_STATES guard → idempotent
 *   - AUv2 + F1 can both run on same position → first to fire wins, other is no-op
 *   - AUv2 + CBv2/CBv3/CBv5: same — first wins
 */

const Trade = require('../db/models/Trade');
const Bot = require('../db/models/Bot');
const AppConfig = require('../db/models/AppConfig');
const binanceRest = require('../binance/binanceRest');
const forceClose = require('../core/forceClose');
const fxService = require('./fxService');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');
// FIX-2026-09-17: per-instance first-fire stagger
const { scheduledInterval, clearScheduledInterval } = require('../utils/scheduledInterval');

// FIX-2026-09-06: AUv2 mirrors F1 auto-arm (trader.js:_autoArmStopLossOnUKC) —
//   safety feature, NOT premium. F1 has NO license gate; AUv2 should follow.
//   The original license gate (licenseService.isFeatureEnabled('auv2'))
//   silently broke because `_getFeatures()` in licenseService.js does NOT
//   include `auv2` in its allowlist → features['auv2'] === undefined → false
//   for EVERY license (including enterprise). Removal makes AUv2 work like F1:
//   only master toggle (AppConfig.auv2Enabled) + per-bot opt-in gate it.

// FIX-2026-09-12: 180s → 300s (5 min) — FIX orphan-mismatch stampede
//   - root cause: 21 bots × auv2 (3 min) + positionWatchdog (3 min) + trader reconcile (5 min)
//     burst ใน window 2-3 วินาที → base weight 2700+ → ชน 3000 cap → circuit breaker เปิดถี่
//   - align auv2 กับ trader reconcile (5 min) เพื่อให้ 2 sweep ไม่ชนกัน
//   - jitter ±10% → ±25% กระจาย burst ออกจาก watchdog + trader
const DEFAULT_INTERVAL_MS = 300000;
const KLINE_FETCH_LIMIT = 2; // last close only

// Mirrors OPEN_STATES in trader.js:1355 — kept locally to avoid circular require
const OPEN_STATES = ['placed', 'filled', 'retrying', 'holding', 'selling', 'partial_sell_wait', 'partial_wait'];

class AutoUnderwaterV2 {
  constructor() {
    this.interval = null;
    this.intervalMs = DEFAULT_INTERVAL_MS;
    this.inFlight = false;
    this.lastTickAt = null;
    this.lastStats = null;
    this.lastTickError = null;
    this.tickCount = 0;
  }

  /**
   * Pure helper — computes skip reason for a (bot, trade) pair at `now`.
   * Returns null when AUv2 should TRIGGER.
   * Exposed as static for testability without mocks.
   *
   * @param {object} bot  — bot document (lean or full) with auv2* fields
   * @param {object} trade — trade document (lean) with buyFilledAt, buyPrice, isDcaStack, stackBep, qty
   * @param {object} ctx  — { now, lastClose, fxRate, masterOn }
   * @returns {string|null} skip reason or null when trigger
   */
  static _evaluate({ bot, trade, ctx }) {
    if (!ctx.masterOn) return 'master_off';
    if (bot.auv2Enabled !== true) return 'bot_optout';
    // FIX-2026-09-17: skip user-paused bots (bot.enabled !== true). Mirror pattern
    //   from positionWatchdog _cbv3SkipReason — pausing a bot should freeze ALL
    //   automated risk-management, not just CB tiers.
    if (bot.enabled !== true) return 'bot_disabled';
    // FIX-2026-09-06: AUv2 skip DCA stacks (ไม่ต้องใช้กับ DCA — DCA มี BEP/TP logic ของตัวเอง)
    if (trade.isDcaStack === true) return 'dca_skip';
    if (!OPEN_STATES.includes(trade.state)) return 'not_open';

    if (!trade.buyFilledAt) return 'not_open'; // BUY ยังไม่ fill → ไม่มีจุดเริ่มนับ
    const ageHours = (ctx.now - new Date(trade.buyFilledAt).getTime()) / (60 * 60 * 1000);
    const minAgeHours = bot.auv2MinAgeHours ?? 24;
    if (ageHours < minAgeHours) return 'too_young';

    if (ctx.lastClose == null || !Number.isFinite(ctx.lastClose) || ctx.lastClose <= 0) return 'no_close';

    // refPrice = stackBep สำหรับ DCA stack, buyPrice สำหรับ non-stack (mirror positionWatchdog._refPrice)
    let refPrice;
    if (trade.isDcaStack === true && Number.isFinite(trade.stackBep) && trade.stackBep > 0) {
      refPrice = trade.stackBep;
    } else {
      refPrice = parseFloat(trade.buyPrice);
    }
    if (!Number.isFinite(refPrice) || refPrice <= 0) return 'no_ref_price';

    // lossPct = (refPrice - lastClose) / refPrice * 100 — POSITIVE when underwater (mirror F1 logic)
    const lossPct = ((refPrice - ctx.lastClose) / refPrice) * 100;
    const isUnderwater = lossPct > 0; // position must be in loss for loss-gate to apply

    // ─── Hard cap: ถ้าเกิน auv2MaxWaitDays (และ > 0) → force sell ไม่ว่า loss เท่าไหร่ ──
    const maxWaitDays = bot.auv2MaxWaitDays ?? 7;
    if (maxWaitDays > 0 && ageHours >= maxWaitDays * 24) {
      return null; // trigger — hard cap reached (regardless of underwater state)
    }

    // Position in profit (not underwater) → AUv2 ไม่ trigger (TP/CB จัดการเอง)
    if (!isUnderwater) return 'not_shallow';

    // ─── Loss metric gate (only when underwater) ───
    const mode = bot.auv2LossMode || 'pct';
    if (mode === 'thb') {
      // lossTHB = (refPrice - lastClose) * qty * fxRate — POSITIVE magnitude when underwater
      const qty = parseFloat(trade.totalQty || trade.buyQty || 0);
      if (!Number.isFinite(qty) || qty <= 0) return 'no_ref_price';
      const fxRate = ctx.fxRate || 0;
      if (!Number.isFinite(fxRate) || fxRate <= 0) {
        // fallback: ไม่มี fx rate → ใช้ pct mode แทน (graceful degradation)
        const maxLossPct = bot.auv2MaxLossPct ?? 5;
        return lossPct < maxLossPct ? null : 'not_shallow';
      }
      const lossThb = lossPct / 100 * refPrice * qty * fxRate; // magnitude: positive when loss
      const maxLossThb = bot.auv2MaxLossThb ?? 200;
      return lossThb < maxLossThb ? null : 'not_shallow';
    }

    // default: pct
    const maxLossPct = bot.auv2MaxLossPct ?? 5;
    return lossPct < maxLossPct ? null : 'not_shallow';
  }

  start({ intervalMs } = {}) {
    if (this.interval) return;
    const base = intervalMs || DEFAULT_INTERVAL_MS;
    this.intervalMs = base;
    // FIX-2026-09-12: Jitter ±10% → ±25% (mirror positionWatchdog — prevent burst alignment)
    //   ±25% jitter กระจาย burst ออกจาก watchdog (10 min) + trader reconcile (5 min)
    const jitteredInterval = Math.round(base * (1 + (Math.random() * 2 - 1) * 0.25));
    // FIX-2026-09-17: SCHEDULE_OFFSET_SEC applied; ±25% jitter kept additive
    this.interval = scheduledInterval(() => this._tickSafe(), jitteredInterval, {
      unref: true,
      meta: 'auv2',
    });
    logger.info({ baseMs: base, jitteredIntervalMs: jitteredInterval }, 'auv2: started');
    // keep defensive 0-5s random delay as defensive layer
    const initialDelayMs = Math.floor(Math.random() * 5000);
    setTimeout(() => this._tickSafe(), initialDelayMs);
  }

  stop() {
    if (this.interval) {
      clearScheduledInterval(this.interval);
      this.interval = null;
    }
    logger.info('auv2: stopped');
  }

  _tickSafe() {
    this.tickCount += 1;
    this.runOnce()
      .then((stats) => {
        this.lastStats = { ...stats, ts: this.lastTickAt, tickCount: this.tickCount };
        this.lastTickError = null;
        const noisy = stats.triggered > 0 || stats.closed > 0 || stats.errors > 0;
        const logFn = noisy ? logger.info.bind(logger) : logger.debug.bind(logger);
        logFn({ ...stats, tickCount: this.tickCount, durationMs: stats.durationMs }, 'auv2: tick');
      })
      .catch((err) => {
        this.lastTickError = err.message;
        logger.error({ err: err.message, stack: err.stack, tickCount: this.tickCount }, 'auv2: tick failed');
      })
      .finally(() => this._persistTelemetry().catch(() => {}));
  }

  async _persistTelemetry() {
    try {
      const upd = {
        auv2LastRunAt: new Date(),
      };
      if (this.lastStats) upd.auv2LastStats = this.lastStats;
      if (this.lastTickError) upd.auv2LastError = this.lastTickError;
      else upd.auv2LastError = null;
      await AppConfig.updateOne({ key: 'singleton' }, { $set: upd });
    } catch (_) { /* non-fatal */ }
  }

  async runOnce() {
    if (this.inFlight) {
      logger.debug('auv2: previous tick still in flight, skip');
      return { skipped: true, scanned: 0, triggered: 0, closed: 0, errors: 0 };
    }
    this.inFlight = true;
    const t0 = Date.now();
    this.lastTickAt = t0;
    const stats = {
      scanned: 0, triggered: 0, closed: 0, errors: 0,
      skippedMasterOff: 0,
      // skippedLicenseOff kept as always-0 for backward compat with dashboards/tests
      // (license gate was REMOVED 2026-09-06 — see Bug #2 fix commit 5d85d3d)
      skippedLicenseOff: 0, skippedBotOptOut: 0, skippedBotDisabled: 0,
      skippedDca: 0,
      skippedNotOpen: 0, skippedTooYoung: 0, skippedNotShallow: 0,
      skippedNoClose: 0, skippedNoRefPrice: 0,
    };
    try {
      await this._checkUnderwaterPositions(stats);
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'auv2: runOnce error');
      stats.errors++;
    } finally {
      stats.durationMs = Date.now() - t0;
      this.inFlight = false;
    }
    return stats;
  }

  async _checkUnderwaterPositions(stats) {
    // 0. Check master toggle (AppConfig.auv2Enabled — no "master" prefix, matches cbEnabled pattern)
    const cfg = await AppConfig.findOne({ key: 'singleton' }, 'auv2Enabled').lean();
    if (!cfg || cfg.auv2Enabled !== true) {
      stats.skippedMasterOff++;
      return;
    }

    // (License gate intentionally absent — see skip-reasons docstring note above)

    // 1. Fetch all open-state trades
    const candidates = await Trade.find({ state: { $in: OPEN_STATES } }).lean();
    if (candidates.length === 0) return;

    // 3. Group by botId
    const byBot = new Map();
    for (const t of candidates) {
      if (!t.botId) continue;
      const k = String(t.botId);
      if (!byBot.has(k)) byBot.set(k, []);
      byBot.get(k).push(t);
    }
    if (byBot.size === 0) return;

    // 4. Bulk-load bots with AUv2 fields
    const botIds = [...byBot.keys()];
    const bots = await Bot.find(
      { _id: { $in: botIds } },
      'name symbol timeframe auv2Enabled auv2MinAgeHours auv2LossMode auv2MaxLossPct auv2MaxLossThb auv2MaxWaitDays enabled'
    ).lean();
    const botMap = new Map(bots.map(function (b) { return [String(b._id), b]; }));

    // 5. Pre-fetch FX rate once per tick (THB mode)
    let fxRate = null;
    try {
      const fx = await fxService.getRate();
      fxRate = fx && fx.rate;
    } catch (_) { fxRate = null; }

    // 6. Pre-fetch last close once per (symbol, timeframe) — perf mirror positionWatchdog
    const lastCloseBySymTf = new Map();
    const symTfSet = new Set();
    for (const bot of bots) {
      // FIX-2026-09-17: also require bot.enabled === true to skip Binance fetch
      //   for paused bots — saves a kline call per disabled bot per tick.
      if (bot && bot.symbol && bot.timeframe && bot.auv2Enabled === true && bot.enabled === true) {
        symTfSet.add(`${bot.symbol}|${bot.timeframe}`);
      }
    }
    for (const key of symTfSet) {
      const [symbol, timeframe] = key.split('|');
      const lastClose = await this._fetchLastClose({ symbol, timeframe });
      lastCloseBySymTf.set(key, lastClose);
    }

    const now = Date.now();
    const ctx = { now, fxRate, masterOn: true };

    // 7. Per-bot evaluation
    for (const [botIdStr, trades] of byBot) {
      const bot = botMap.get(botIdStr);
      if (!bot) {
        for (const t of trades) {
          stats.scanned++;
          stats.skippedNotOpen++; // bot missing → can't evaluate
        }
        continue;
      }
      if (bot.auv2Enabled !== true) {
        for (const t of trades) {
          stats.scanned++;
          stats.skippedBotOptOut++;
        }
        continue;
      }
      // FIX-2026-09-17: skip user-paused bots (mirror positionWatchdog pattern)
      if (bot.enabled !== true) {
        for (const t of trades) {
          stats.scanned++;
          stats.skippedBotDisabled++;
        }
        continue;
      }

      const lastClose = lastCloseBySymTf.get(`${bot.symbol}|${bot.timeframe}`);
      const tradeCtx = { ...ctx, lastClose };

      for (const t of trades) {
        stats.scanned++;
        const skip = AutoUnderwaterV2._evaluate({ bot, trade: t, ctx: tradeCtx });
        if (skip) {
          // bucket by skip reason
          if (skip === 'master_off') stats.skippedMasterOff++;
          else if (skip === 'license_off') stats.skippedLicenseOff++; // always 0 post-2026-09-06 — kept for compat
          else if (skip === 'bot_optout') stats.skippedBotOptOut++;
          else if (skip === 'bot_disabled') stats.skippedBotDisabled++;
          else if (skip === 'dca_skip') stats.skippedDca++;
          else if (skip === 'not_open') stats.skippedNotOpen++;
          else if (skip === 'too_young') stats.skippedTooYoung++;
          else if (skip === 'not_shallow') stats.skippedNotShallow++;
          else if (skip === 'no_close') stats.skippedNoClose++;
          else if (skip === 'no_ref_price') stats.skippedNoRefPrice++;
          continue;
        }
        stats.triggered++;

        // ─── TRIGGER: force-close this position ───
        // Re-fetch fresh state to avoid double-sell (forceCloseTrade also has atomic claim)
        const fresh = await Trade.findById(t._id, 'state botId symbol buyPrice buyQty totalQty isDcaStack stackBep buyFilledAt').lean();
        if (!fresh || !OPEN_STATES.includes(fresh.state)) {
          logger.debug({ tradeId: String(t._id), dbState: fresh ? fresh.state : 'deleted' }, 'auv2: trade no longer open — skip');
          continue;
        }

        const lossPctNow = ((parseFloat(fresh.stackBep || fresh.buyPrice) - lastClose) / parseFloat(fresh.stackBep || fresh.buyPrice)) * 100;
        const ageHoursNow = (now - new Date(fresh.buyFilledAt).getTime()) / (60 * 60 * 1000);
        const capReached = bot.auv2MaxWaitDays > 0 && ageHoursNow >= bot.auv2MaxWaitDays * 24;
        const ageFloorIso = new Date(now - bot.auv2MinAgeHours * 60 * 60 * 1000).toISOString();

        logger.warn({
          tradeId: String(t._id),
          botId: botIdStr,
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          mode: bot.auv2LossMode,
          isDcaStack: fresh.isDcaStack === true,
          refPrice: parseFloat(fresh.stackBep || fresh.buyPrice),
          lastClose,
          lossPct: lossPctNow.toFixed(2),
          ageHours: ageHoursNow.toFixed(2),
          minAgeHours: bot.auv2MinAgeHours,
          capReached,
          maxWaitDays: bot.auv2MaxWaitDays,
        }, 'auv2: shallow-loss trigger — force-closing');

        try {
          const result = await forceClose.forceCloseTrade({
            trade: fresh, bot, allowMarketSell: true, source: 'auv2',
          });
          if (result.ok) {
            stats.closed++;
            // Override sellReason → 'auv2_shallow_loss' (mirror watchdog sl_ukc_f1_armed override)
            Trade.updateOne(
              { _id: fresh._id, state: 'sold' },
              {
                $set: {
                  sellReason: 'auv2_shallow_loss',
                  sellReasonDetail: `AUv2 — age=${ageHoursNow.toFixed(1)}h ≥ minAge=${bot.auv2MinAgeHours}h, lossPct=${lossPctNow.toFixed(2)}%${capReached ? ` (HARD CAP ${bot.auv2MaxWaitDays}d reached)` : ''}, mode=${bot.auv2LossMode}, lastClose=${lastClose}`,
                  sellReasonSource: 'autoUnderwaterV2.shallowLoss',
                  sellReasonAt: new Date(),
                },
              }
            ).catch(() => { /* non-fatal */ });
            eventBus.emit('auv2:closed', {
              tradeId: t._id,
              botId: botIdStr,
              symbol: t.symbol,
              isDcaStack: t.isDcaStack === true,
              mode: result.mode,
              pnl: result.pnl,
              avgSellPrice: result.avgSellPrice,
              lossPct: lossPctNow,
              ageHours: ageHoursNow,
              capReached,
              source: 'autoUnderwaterV2',
            });
            logger.warn({
              tradeId: String(t._id),
              botId: botIdStr,
              symbol: bot.symbol,
              mode: result.mode,
              pnl: result.pnl,
              avgSellPrice: result.avgSellPrice,
            }, 'auv2: shallow-loss closed');
          } else {
            stats.errors++;
            logger.warn({
              tradeId: String(t._id),
              botId: botIdStr,
              err: result.error,
            }, 'auv2: forceCloseTrade failed');
          }
        } catch (err) {
          stats.errors++;
          logger.error({
            err: err.message, stack: err.stack,
            tradeId: String(t._id),
            botId: botIdStr,
            symbol: bot.symbol,
          }, 'auv2: forceCloseTrade exception');
        }
      }
    }
  }

  async _fetchLastClose(stubBot) {
    try {
      const klines = await binanceRest.getKlines({
        symbol: stubBot.symbol,
        interval: stubBot.timeframe,
        limit: KLINE_FETCH_LIMIT,
      });
      if (!Array.isArray(klines) || klines.length < 1) return null;
      return parseFloat(klines[klines.length - 1][4]);
    } catch (err) {
      logger.warn({ err: err.message, symbol: stubBot.symbol, timeframe: stubBot.timeframe }, 'auv2: fetchLastClose failed');
      return null;
    }
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

// Export singleton instance + class
const _auv2Instance = new AutoUnderwaterV2();
module.exports = _auv2Instance;
_auv2Instance.AutoUnderwaterV2 = AutoUnderwaterV2;
module.exports.AutoUnderwaterV2 = AutoUnderwaterV2;