'use strict';

/**
 * FIX-2026-08-24: Auto Reserve / Release USDT — periodic adjuster
 *
 * Background:
 *   User wants the wallet reserve (walletReserveUsdt) to self-adjust based on
 *   "available poles" formula — so the system always reserves enough USDT to cover
 *   N poles of trade capital (default 3 poles × 10 USDT/pole = 30 USDT) plus any
 *   positions currently at a small loss (counted as "1 pole each" via lossThresholdPct).
 *
 *   - usablePoleCount  = floor(usableUsdt / usdtPerPole)
 *   - lossPoleCount    = count(positions where unrealized loss% < lossThresholdPct)
 *   - availablePoleCount = usablePoleCount + lossPoleCount
 *
 *   If availablePoleCount > targetPoleCount → reserve stepUsdt (lock more)
 *   If availablePoleCount < targetPoleCount → release stepUsdt (unlock)
 *   If equal → no action
 *
 *   Example (default config):
 *     usable=22 USDT, usdtPerPole=10 → 2 poles from cash
 *     + 1 position with loss -1.5% (<2% threshold) → 1 loss pole
 *     = 3 available vs 3 target → no action
 *
 *   Default OFF — user must opt-in via Settings or Wallet toggle.
 *
 * Design:
 *   - Mirror src/services/autoAddBot.js: singleton class with start/stop/reloadConfig
 *   - Periodic check every 60s, fires when local hour % checkHours === 0 && minute === 0
 *     (matches walletSnapshot pattern of BKK-aligned trigger)
 *   - lastFiredHourKey guard prevents double-fire within same hour
 *   - In-flight guard prevents overlap if Binance API is slow
 *   - Persist lastRunAt/lastStats/lastError to AppConfig (cross-restart survive)
 *   - Emit `autoReserve:adjusted` event for telegram + UI refresh
 *
 * Why BKK-aligned (not "every 4h from server start"):
 *   User wants predictable schedule — 00:00/04:00/08:00/12:00/16:00/20:00 BKK.
 *   This makes logs easier to audit and aligns with daily snapshot at 00:01 BKK.
 *
 * Risk:
 *   - Auto-reserve can flip reserve every 4h if user has high trading activity.
 *     Mitigated by stepUsdt granularity (default 10 USDT — not whole-sale).
 *   - If user manually adjusts reserve between checks, our 4h tick will re-adjust.
 *     This is the intended behavior — user opted in.
 *   - DCA stacks: counted by stackBep + stackTotalQty (1 position = 1 loss check).
 */

const AppConfig = require('../db/models/AppConfig');
const Trade = require('../db/models/Trade');
const binanceRest = require('../binance/binanceRest');
const klineCache = require('./klineCache');
const walletReserve = require('./walletReserve');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');

const TICK_INTERVAL_MS = 60 * 1000; // 60s — same as tpUpdater
const MAX_RESERVE = walletReserve.MAX_RESERVE || 1_000_000;

// ─── OPEN_POSITIONS_STATES (mirror bot.routes.js:322) ──────────────────────
const OPEN_POSITIONS_STATES = [
  'placed', 'partial_wait', 'filled', 'retrying', 'holding', 'selling', 'stopping',
];

/**
 * Pure calculator: count usable poles + loss poles.
 *
 * @param {Object} args
 * @param {number} args.usableUsdt        - USDT available for new BUYs (totalUsdt - currentReserveUsdt)
 * @param {number} args.usdtPerPole       - USDT value of 1 pole (e.g. 10)
 * @param {Array}  args.positions         - [{ symbol, timeframe, isDcaStack, entry, qty, unrealizedUsdt }, ...]
 * @param {number} args.lossThresholdPct  - positions with loss% < threshold count as 1 pole (e.g. 2)
 * @returns {{ usablePoleCount: number, lossPoleCount: number, availablePoleCount: number }}
 */
function computeAvailablePoles({ usableUsdt, usdtPerPole, positions, lossThresholdPct }) {
  // 1) usable poles from cash
  let usablePoleCount = 0;
  if (Number.isFinite(usableUsdt) && Number.isFinite(usdtPerPole) && usdtPerPole > 0 && usableUsdt > 0) {
    usablePoleCount = Math.floor(usableUsdt / usdtPerPole);
  }

  // 2) loss poles from positions
  let lossPoleCount = 0;
  if (Array.isArray(positions) && Number.isFinite(lossThresholdPct)) {
    for (const p of positions) {
      if (!p || !Number.isFinite(p.entry) || !Number.isFinite(p.qty) || p.entry <= 0 || p.qty <= 0) continue;
      // unrealized% = (currentPrice - entry) / entry * 100 — for DCA we use stackBep + stackTotalQty
      const unrealizedPct = ((p.currentPrice - p.entry) / p.entry) * 100;
      // negative % = loss — we count positions where loss is SMALL (below threshold) as 1 pole each
      // (idea: small-loss positions still consume 1 pole of risk budget)
      if (unrealizedPct < 0 && Math.abs(unrealizedPct) < lossThresholdPct) {
        lossPoleCount += 1;
      }
    }
  }

  return {
    usablePoleCount,
    lossPoleCount,
    availablePoleCount: usablePoleCount + lossPoleCount,
  };
}

/**
 * Decide what to do: reserve / release / none.
 *
 * @param {Object} args
 * @param {number} args.availablePoleCount - current count
 * @param {number} args.targetPoleCount    - desired count (e.g. 3)
 * @param {number} args.reserveUsdt        - current reserve
 * @param {number} args.stepUsdt           - amount per action
 * @param {number} args.totalUsdt          - total USDT on Binance (free+locked) — caps reserve ceiling
 * @returns {{ action: 'reserve'|'release'|'none', deltaUsdt: number, afterReserve: number, reason: string }}
 */
function decideAction({ availablePoleCount, targetPoleCount, reserveUsdt, stepUsdt, totalUsdt }) {
  const safeReserve = Number.isFinite(reserveUsdt) ? Math.max(0, reserveUsdt) : 0;
  const safeStep = Number.isFinite(stepUsdt) && stepUsdt > 0 ? stepUsdt : 0;
  const safeTotal = Number.isFinite(totalUsdt) ? Math.max(0, totalUsdt) : 0;

  if (!Number.isFinite(availablePoleCount) || !Number.isFinite(targetPoleCount)) {
    return { action: 'none', deltaUsdt: 0, afterReserve: safeReserve, reason: 'invalid_pole_count' };
  }
  if (safeStep <= 0) {
    return { action: 'none', deltaUsdt: 0, afterReserve: safeReserve, reason: 'zero_step' };
  }

  if (availablePoleCount > targetPoleCount) {
    // Reserve MORE: lock stepUsdt extra — but ONLY if full stepUsdt fits
    //   - FIX-2026-08-24: skip partial reserve. ถ้า usable < stepUsdt → wait for
    //     next tick ดีกว่า lock เศษ 2 USDT (พอกั๊กจริงไม่พอ)
    //   - reserve_at_max เมื่อ safeReserve + step > MAX_RESERVE
    //   - insufficient_usable_for_step เมื่อ safeReserve + step > totalUsdt
    const fullAfter = safeReserve + safeStep;
    if (fullAfter > MAX_RESERVE) {
      return { action: 'none', deltaUsdt: 0, afterReserve: safeReserve, reason: 'reserve_at_max' };
    }
    if (fullAfter > safeTotal) {
      return { action: 'none', deltaUsdt: 0, afterReserve: safeReserve, reason: 'insufficient_usable_for_step' };
    }
    return { action: 'reserve', deltaUsdt: safeStep, afterReserve: fullAfter, reason: 'available_exceeds_target' };
  }

  if (availablePoleCount < targetPoleCount) {
    // Release: unlock stepUsdt
    const after = Math.max(0, safeReserve - safeStep);
    const delta = safeReserve - after;
    if (delta <= 0) {
      return { action: 'none', deltaUsdt: 0, afterReserve: safeReserve, reason: 'reserve_already_zero' };
    }
    return { action: 'release', deltaUsdt: delta, afterReserve: after, reason: 'available_below_target' };
  }

  // exact match → no action
  return { action: 'none', deltaUsdt: 0, afterReserve: safeReserve, reason: 'in_target' };
}

class AutoReserve {
  constructor() {
    this.interval = null;
    this.inFlight = false;
    this.tickCount = 0;
    this.lastRunAt = null;
    this.lastRunError = null;
    this.lastStats = null;
    this.config = null;
    this.lastFiredHourKey = -1; // e.g. "2026-08-24T16" — guard against drift double-fire
  }

  /**
   * Start the periodic adjuster. Config reloaded from AppConfig at start + every PUT.
   *   - If enabled=false → start in dormant mode (no interval installed)
   *   - reloadConfig() will install interval when user toggles ON later
   */
  start() {
    this._loadConfig().then((cfg) => {
      this.config = cfg;
      if (cfg.enabled) this._installInterval();
      logger.info({ enabled: cfg.enabled, checkHours: cfg.checkHours }, 'autoReserve: started');
    }).catch((err) => {
      logger.error({ err: err.message }, 'autoReserve: initial config load failed');
    });
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.lastFiredHourKey = -1;
    logger.info('autoReserve: stopped');
  }

  /**
   * Reload config + restart timer (called from PUT /api/wallet/auto-reserve/config)
   *   - If enabled flag flipped → install/clear interval
   *   - If checkHours changed → restart timer
   */
  async reloadConfig() {
    const wasEnabled = !!this.interval;
    try {
      this.config = await this._loadConfig();
    } catch (err) {
      logger.warn({ err: err.message }, 'autoReserve: reloadConfig load failed');
      return;
    }
    if (this.config.enabled && !wasEnabled) {
      this._installInterval();
      logger.info({ checkHours: this.config.checkHours }, 'autoReserve: enabled — interval installed');
    } else if (!this.config.enabled && wasEnabled) {
      this.stop();
      logger.info('autoReserve: disabled — interval cleared');
    } else {
      logger.info({ enabled: this.config.enabled, checkHours: this.config.checkHours }, 'autoReserve: reloaded (no interval change)');
    }
  }

  _installInterval() {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => this._tickSafe(), TICK_INTERVAL_MS);
    // immediate first tick — let user see status right after enable
    setImmediate(() => this._tickSafe());
  }

  async _loadConfig() {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (!cfg) {
      return {
        enabled: false,
        poleCount: 3,
        usdtPerPole: 10,
        lossThresholdPct: 2,
        checkHours: 4,
        stepUsdt: 10,
      };
    }
    const checkHours = Math.max(1, Math.min(24, Number(cfg.autoReserveCheckHours) || 4));
    return {
      enabled: cfg.autoReserveEnabled === true,
      poleCount: Math.max(1, Math.min(100, Number(cfg.autoReservePoleCount) || 3)),
      usdtPerPole: Math.max(1, Math.min(1000, Number(cfg.autoReserveUsdtPerPole) || 10)),
      lossThresholdPct: Math.max(0.1, Math.min(50, Number(cfg.autoReserveLossThresholdPct) || 2)),
      checkHours,
      stepUsdt: Math.max(1, Math.min(1000, Number(cfg.autoReserveStepUsdt) || 10)),
    };
  }

  /**
   * Tick guard: fire only when current local-time hour % checkHours === 0 && minutes === 0
   * AND we haven't already fired for this (day, hour) combo.
   */
  _isTriggerTime(now, checkHours) {
    if (now.getMinutes() !== 0) return false;
    if (now.getHours() % checkHours !== 0) return false;
    // hourKey = "YYYY-MM-DDTHH" — unique per local-time hour
    const hourKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}T${now.getHours()}`;
    if (this.lastFiredHourKey === hourKey) return false;
    this.lastFiredHourKey = hourKey;
    return true;
  }

  _tickSafe() {
    this.tickCount += 1;
    // Use force=false on periodic ticks so a disabled config is a no-op
    this.runOnce({ source: 'periodic', force: false })
      .then((stats) => {
        this.lastStats = { ...stats, ts: Date.now(), tickCount: this.tickCount };
        this.lastRunError = null;
        if (stats.action && stats.action !== 'none') {
          logger.info({ ...stats, tickCount: this.tickCount }, 'autoReserve: tick (action taken)');
        } else {
          logger.debug({ ...stats, tickCount: this.tickCount }, 'autoReserve: tick (no action)');
        }
      })
      .catch((err) => {
        this.lastRunError = err.message;
        logger.error({ err: err.message, stack: err.stack, tickCount: this.tickCount }, 'autoReserve: tick failed');
      })
      .finally(async () => {
        this.lastRunAt = new Date();
        try {
          await AppConfig.updateOne({ key: 'singleton' }, {
            $set: {
              autoReserveLastRunAt: this.lastRunAt,
              autoReserveLastStats: this.lastStats,
              autoReserveLastError: this.lastRunError,
            },
          });
        } catch (err) {
          logger.warn({ err: err.message }, 'autoReserve: persist lastRun failed');
        }
      });
  }

  /**
   * Run one cycle. Returns stats for telemetry.
   *   - force=true bypasses time-of-day guard AND disabled check (used by manual POST /run)
   *
   * Returns { outcome, action, deltaUsdt, beforeReserve, afterReserve, totalUsdt, usableUsdt,
   *           usablePoleCount, lossPoleCount, availablePoleCount, targetPoleCount,
   *           positionCount, source, reason? }
   */
  async runOnce({ source = 'periodic', force = false } = {}) {
    if (this.inFlight) {
      logger.warn({ source }, 'autoReserve: previous tick still in flight, skip');
      return { outcome: 'skipped', skipped: 'inFlight' };
    }
    this.inFlight = true;
    try {
      // Lazy-load config if not loaded yet (e.g. manual run before start())
      if (!this.config) {
        this.config = await this._loadConfig();
      }
      if (!this.config.enabled && !force) {
        return { outcome: 'skipped', skipped: 'disabled', source };
      }

      // Periodic ticks respect BKK-aligned time guard
      if (!force && source === 'periodic') {
        const now = new Date();
        if (!this._isTriggerTime(now, this.config.checkHours)) {
          return { outcome: 'skipped', skipped: 'not_trigger_time', source };
        }
      }

      // 1. Compute usableUsdt + lossPoleCount
      const [usdtCtx, lossPolePositions] = await Promise.all([
        this._getUsableUsdtContext(),
        this._computeLossPositions(),
      ]);
      const { totalUsdt, reserveUsdt, usableUsdt } = usdtCtx;

      // 2. Compute availablePoleCount
      const { usablePoleCount, lossPoleCount, availablePoleCount } = computeAvailablePoles({
        usableUsdt,
        usdtPerPole: this.config.usdtPerPole,
        positions: lossPolePositions,
        lossThresholdPct: this.config.lossThresholdPct,
      });

      // 3. Decide action
      const decision = decideAction({
        availablePoleCount,
        targetPoleCount: this.config.poleCount,
        reserveUsdt,
        stepUsdt: this.config.stepUsdt,
        totalUsdt,
      });

      const stats = {
        outcome: decision.action === 'none' ? 'no_change' : 'adjusted',
        action: decision.action,
        deltaUsdt: decision.deltaUsdt,
        reason: decision.reason,
        beforeReserve: reserveUsdt,
        afterReserve: decision.afterReserve,
        totalUsdt,
        usableUsdt,
        usablePoleCount,
        lossPoleCount,
        availablePoleCount,
        targetPoleCount: this.config.poleCount,
        positionCount: lossPolePositions.length,
        source,
        ts: Date.now(),
      };

      // 4. Apply action if any
      if (decision.action === 'reserve' || decision.action === 'release') {
        const beforeReserve = reserveUsdt;
        const afterReserve = decision.afterReserve;
        try {
          const updateResult = await AppConfig.findOneAndUpdate(
            { key: 'singleton' },
            { $set: { walletReserveUsdt: afterReserve } },
            { new: true }
          );
          walletReserve.invalidateCache();
          // Emit event for telegram + wallet UI refresh
          try {
            eventBus.emit('autoReserve:adjusted', {
              action: decision.action,
              deltaUsdt: decision.deltaUsdt,
              beforeReserve,
              afterReserve,
              totalUsdt,
              usableUsdt,
              usablePoleCount,
              lossPoleCount,
              availablePoleCount,
              targetPoleCount: this.config.poleCount,
              reason: decision.reason,
              ts: Date.now(),
              source,
            });
          } catch (evtErr) {
            logger.warn({ err: evtErr.message }, 'autoReserve: event emit failed (non-fatal)');
          }
          logger.info({
            action: decision.action,
            deltaUsdt: decision.deltaUsdt,
            beforeReserve,
            afterReserve,
            availablePoleCount,
            targetPoleCount: this.config.poleCount,
            positionCount: lossPolePositions.length,
            source,
          }, 'autoReserve: reserve adjusted');
        } catch (err) {
          stats.outcome = 'failed_apply';
          stats.error = err.message;
          logger.error({ err: err.message }, 'autoReserve: apply failed');
          throw err;
        }
      }

      return stats;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Read USDT total (free+locked) and current reserve.
   * Falls back gracefully if Binance throws.
   */
  async _getUsableUsdtContext() {
    let totalUsdt = 0;
    try {
      const acc = await binanceRest.getAccount();
      const usdtBal = (acc && acc.balances || []).find((b) => b && b.asset === 'USDT');
      if (usdtBal) {
        totalUsdt = (parseFloat(usdtBal.free) || 0) + (parseFloat(usdtBal.locked) || 0);
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'autoReserve: getAccount failed — treating totalUsdt=0');
    }
    let reserveUsdt = 0;
    try {
      reserveUsdt = await walletReserve.getReserveUsdt();
    } catch (err) {
      logger.warn({ err: err.message }, 'autoReserve: getReserveUsdt failed — treating reserve=0');
    }
    const usableUsdt = Math.max(0, totalUsdt - reserveUsdt);
    return { totalUsdt, reserveUsdt, usableUsdt };
  }

  /**
   * Query open positions, attach mark price from klineCache (fallback bookTicker).
   * Returns array of { symbol, timeframe, isDcaStack, entry, qty, currentPrice }.
   */
  async _computeLossPositions() {
    const trades = await Trade.find({ state: { $in: OPEN_POSITIONS_STATES } })
      .sort({ createdAt: -1 })
      .limit(500) // safety cap — most users have <100 open
      .lean();

    if (trades.length === 0) return [];

    // Resolve price per unique symbol:
    //   1. klineCache.getCurrent(symbol, timeframe) — fast in-memory WS data
    //   2. bookTicker fallback for symbols without WS (rare, e.g. just-added bot)
    const uniqueSymbols = [...new Set(trades.map((t) => t.symbol))];
    const symbolPriceMap = new Map();

    for (const sym of uniqueSymbols) {
      // Try primary timeframe first (most bots are 1 symbol × 1 timeframe in open positions)
      const t = trades.find((tt) => tt.symbol === sym);
      const tf = t ? t.timeframe : null;
      if (tf) {
        const cur = klineCache.getCurrent(sym, tf);
        if (cur && Number.isFinite(parseFloat(cur.close))) {
          symbolPriceMap.set(sym, parseFloat(cur.close));
          continue;
        }
      }
    }

    // BookTicker fallback for symbols still missing price
    const missingSymbols = uniqueSymbols.filter((s) => !symbolPriceMap.has(s));
    if (missingSymbols.length > 0) {
      await Promise.allSettled(missingSymbols.map(async (sym) => {
        try {
          const ticker = await binanceRest.getBookTicker(sym);
          const bid = parseFloat(ticker.bidPrice);
          const ask = parseFloat(ticker.askPrice);
          if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
            symbolPriceMap.set(sym, (bid + ask) / 2);
          }
        } catch (err) {
          logger.warn({ sym, err: err.message }, 'autoReserve: bookTicker fallback failed');
        }
      }));
    }

    // Build position objects
    const out = [];
    for (const t of trades) {
      const isDcaStack = t.isDcaStack === true;
      // DCA stacks: use stackBep + stackTotalQty; regular trades: buyPrice + buyQty
      const entry = isDcaStack
        ? (Number(t.stackBep) || 0)
        : (Number(t.buyPrice) || 0);
      const qty = isDcaStack
        ? (Number(t.stackTotalQty) || 0)
        : (Number(t.buyQty) || 0);
      if (entry <= 0 || qty <= 0) continue;
      const currentPrice = symbolPriceMap.get(t.symbol);
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue; // skip — no price
      out.push({
        symbol: t.symbol,
        timeframe: t.timeframe,
        isDcaStack,
        entry,
        qty,
        currentPrice,
      });
    }
    return out;
  }

  getStatus() {
    return {
      running: !!this.interval,
      enabled: !!this.config?.enabled,
      inFlight: this.inFlight,
      tickCount: this.tickCount,
      lastRunAt: this.lastRunAt,
      lastRunError: this.lastRunError,
      lastStats: this.lastStats,
      config: this.config,
      lastFiredHourKey: this.lastFiredHourKey,
    };
  }
}

module.exports = new AutoReserve();

// Export pure functions for unit tests
module.exports.computeAvailablePoles = computeAvailablePoles;
module.exports.decideAction = decideAction;
module.exports.OPEN_POSITIONS_STATES = OPEN_POSITIONS_STATES;
