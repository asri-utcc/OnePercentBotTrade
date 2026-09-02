'use strict';

/**
 * FIX-2026-08-30 / Phase 4: Auto-Timing engine — singleton scheduler
 *
 * Mirrors src/services/autoPauseAdjust.js exactly:
 *   - start() / stop() / reloadConfig() / runOnce() / getStatus()
 *   - 30-min default interval (floor 60s, unref() so it doesn't block exit)
 *   - Singleton with in-flight guard (runOnce re-entrancy safe)
 *   - License-gated: requires licenseService.isFeatureEnabled('autoTiming')
 *   - Persists scheduler telemetry to AppConfig.autoTiming{LastRunAt,LastStats,LastError}
 *   - Emits 'autoTiming:applied' (UI refresh + Telegram hooks)
 *
 * Difference vs autoPauseAdjust:
 *   - Reads Trade aggregate (not Bot collection) — heatmap-driven
 *   - Writes Tier 2 (AutoTimingLifetime) for 2-tier evidence model
 *   - Writes per-decision log (AutoTimingLog) for UI/debugging
 *   - expose decideForBot(bot, now) — called from trader.js BUY pipeline
 *
 * Aggregation:
 *   - For each closed trade in [now - lookbackDays, now], compute:
 *       bucket = { day: getDay(buyFilledAt), hour: getHours(buyFilledAt) }   // server-local TZ
 *       holdMin = (sellFilledAt - buyFilledAt) / 60000
 *       win     = pnlUSDT > 0
 *   - Weight by recency:
 *       dayAge = (now - buyFilledAt) / 86400_000
 *       w = dayAge <= recentDays ? recentWeight : normalWeight
 *   - Per-cell metrics:
 *       nWeighted = Σ w
 *       winRate   = Σ(w·win) / Σ(w)
 *       pnlUSDT   = Σ pnlUSDT  (unweighted — currency should not be weighted)
 *       medianHoldMin = median(holds) (unweighted — median has no Σ form)
 */

const AppConfig = require('../db/models/AppConfig');
const Bot = require('../db/models/Bot');
const Trade = require('../db/models/Trade');
const AutoTimingLifetime = require('../db/models/AutoTimingLifetime');
const AutoTimingLog = require('../db/models/AutoTimingLog');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');
const { classify, shouldPromoteToTier2 } = require('../core/autoTimingClassifier');
const { decide } = require('../core/autoTimingDecider');
const { getDefaultBandsClone } = require('../core/autoTimingDefaults');

let licenseService = null;
try { licenseService = require('./licenseService'); } catch (_) { /* ignore */ }

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_RECENT_DAYS = 7;
const DEFAULT_RECENT_WEIGHT = 1.5;
const DEFAULT_NORMAL_WEIGHT = 1.0;
const DEFAULT_COOLDOWN_DAYS = 90;
const DEFAULT_MIN_TRADES_ENFORCE = 10;
const DEFAULT_MIN_TRADES_SHOW = 3;
const DEFAULT_MIN_NOTIONAL_FLOOR = 10;
const DEFAULT_MAX_NOTIONAL_CEILING = 200;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const SUPPRESS_THRESHOLD_EVER_BAD = 10;

class AutoTiming {
  constructor() {
    this._running = false;
    this._inFlight = false;
    this._timer = null;
    this._config = null;
    // In-memory per-bot counter cache (rebuilt on runOnce). Key = `${botId}:${day}:${hour}`.
    // Decremented when a position closes; incremented when a BUY fills.
    // Used by trader.js to enforce maxConcurrent + maxTradesPerDay.
    this._counters = {
      openFromCell: new Map(), // key → count of currently-open positions from this cell
      tradesFromCellToday: new Map(), // key → count of BUYs filled today (local day) from this cell
    };
    // FIX-2026-09-01 audit H7: telemetry write throttle — per-bot state to avoid
    //   2 DB writes (Bot.updateOne + AutoTimingLog.create) on every BUY.
    //   - _lastPersistAt[botId] = last time we wrote any telemetry for this bot
    //   - _lastPersistSig[botId] = signature of last persisted decision
    //   A new persist is triggered when EITHER the decision signature CHANGES
    //   (state-change event — important) OR 60s have elapsed (periodic refresh).
    //   Suppress decisions ALWAYS persist regardless of throttle (critical audit).
    this._lastPersistAt = new Map();
    this._lastPersistSig = new Map();
    this._PERSIST_INTERVAL_MS = 60 * 1000; // 1 min periodic heartbeat
  }

  async start() {
    this._inFlight = false;
    if (this._running) return;
    this._running = true;
    await this._loadConfig();
    this._installInterval();
    this._installEventListeners();
    logger.info({ cfg: this._configSummary() }, 'autoTiming: started');
  }

  /**
   * FIX-2026-08-30: subscribe to trade lifecycle events to maintain per-cell
   * counters (openFromCell, tradesFromCellToday) without requiring trader.js
   * explicit call sites. Architecture: emit-based, decoupled from BUY pipeline.
   *   - 'trade:update' state='filled'  → bumpCounter('open') for layer-1 fills
   *   - 'trade:update' state='sold'    → bumpCounter('close')
   *   - 'trade:update' state='holding' → ALSO bumpCounter('open') (DCA layer fills
   *     re-emit as holding)
   */
  _installEventListeners() {
    if (this._eventsBound) return;
    this._eventsBound = true;
    this._onTradeUpdate = (payload) => {
      try {
        if (!payload || !payload.tradeId) return;
        if (payload.state === 'filled' || payload.state === 'holding') {
          // Resolve botId from payload or DB lookup; we use the payload's botId if present
          const botId = payload.botId || null;
          if (botId) {
            const bot = { _id: botId };
            const buyTs = payload.buyFilledAt ? new Date(payload.buyFilledAt).getTime() : Date.now();
            this.bumpCounter('open', bot, buyTs);
          }
        } else if (payload.state === 'sold') {
          const botId = payload.botId || null;
          if (botId) {
            const bot = { _id: botId };
            const sellTs = payload.sellFilledAt ? new Date(payload.sellFilledAt).getTime() : Date.now();
            this.bumpCounter('close', bot, sellTs);
          }
        }
      } catch (err) {
        logger.warn({ err: err.message }, 'autoTiming: trade:update handler failed');
      }
    };
    eventBus.on('trade:update', this._onTradeUpdate);
  }

  _uninstallEventListeners() {
    if (!this._eventsBound) return;
    if (this._onTradeUpdate) eventBus.off('trade:update', this._onTradeUpdate);
    this._eventsBound = false;
  }

  async reloadConfig() {
    try {
      await this._loadConfig();
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      this._installInterval();
      logger.info({ cfg: this._configSummary() }, 'autoTiming: reloadConfig applied');
    } catch (err) {
      logger.warn({ err: err.message }, 'autoTiming: reloadConfig failed');
    }
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._uninstallEventListeners();
    this._running = false;
    this._inFlight = false;
    logger.info('autoTiming: stopped');
  }

  getStatus() {
    return {
      running: this._running,
      timerInstalled: this._timer != null,
      inFlight: this._inFlight,
      config: this._config ? this._configSummary() : null,
    };
  }

  _configSummary() {
    if (!this._config) return null;
    const c = this._config;
    return {
      enabled: c.enabled,
      lookbackDays: c.lookbackDays,
      intervalMs: c.intervalMs,
      minTradesEnforce: c.minTradesEnforce,
      minTradesShow: c.minTradesShow,
      cooldownDays: c.cooldownDays,
      minFloorUSDT: c.minFloorUSDT,
      maxCeilingUSDT: c.maxCeilingUSDT,
      suppressThresholdEverBad: c.suppressThresholdEverBad,
      bands: Object.keys(c.bands || {}),
    };
  }

  async _loadConfig() {
    const cfg = await AppConfig.findOne({ key: 'singleton' });
    if (!cfg) {
      this._config = defaultConfig();
      return;
    }
    this._config = {
      enabled: cfg.autoTimingEnabled === true,
      lookbackDays:      posOrDefault(cfg.autoTimingLookbackDays, DEFAULT_LOOKBACK_DAYS),
      recentDays:        posOrDefault(cfg.autoTimingRecentDays, DEFAULT_RECENT_DAYS),
      recentWeight:      posOrDefault(cfg.autoTimingRecentWeight, DEFAULT_RECENT_WEIGHT),
      normalWeight:      posOrDefault(cfg.autoTimingNormalWeight, DEFAULT_NORMAL_WEIGHT),
      cooldownDays:      posOrDefault(cfg.autoTimingSuppressCooldownDays, DEFAULT_COOLDOWN_DAYS),
      minTradesEnforce:  posOrDefault(cfg.autoTimingMinTradesEnforce, DEFAULT_MIN_TRADES_ENFORCE),
      minTradesShow:     posOrDefault(cfg.autoTimingMinTradesShow, DEFAULT_MIN_TRADES_SHOW),
      // FIX-2026-08-31: hold-time metric selector (median|p75) — defaults to median
      //   for backward compat. Validated against enum in AppConfig.
      holdMetric:        (cfg.autoTimingHoldMetric === 'p75') ? 'p75' : 'median',
      minFloorUSDT:      posOrDefault(cfg.autoTimingMinNotionalFloorUSDT, DEFAULT_MIN_NOTIONAL_FLOOR),
      maxCeilingUSDT:    posOrDefault(cfg.autoTimingMaxNotionalCeilingUSDT, DEFAULT_MAX_NOTIONAL_CEILING),
      suppressThresholdEverBad: SUPPRESS_THRESHOLD_EVER_BAD,
      intervalMs:        posOrDefault(cfg.autoTimingIntervalMs, DEFAULT_INTERVAL_MS),
      bands: (cfg.autoTimingBands && typeof cfg.autoTimingBands === 'object')
        ? cfg.autoTimingBands : getDefaultBandsClone(),
    };
  }

  _installInterval() {
    if (!this._config || !this._config.enabled) {
      logger.info('autoTiming: master disabled — no interval installed');
      return;
    }
    if (!licenseService || !licenseService.isFeatureEnabled || !licenseService.isFeatureEnabled('autoTiming')) {
      logger.info('autoTiming: license gate not satisfied — no interval installed');
      return;
    }
    const intervalMs = Math.max(60_000, this._config.intervalMs);
    this._timer = setInterval(() => {
      this._tickSafe().catch((err) => logger.warn({ err: err.message }, 'autoTiming: tick failed'));
    }, intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    logger.info({ intervalMs }, 'autoTiming: interval installed');
  }

  async _tickSafe() { return this.runOnce({ source: 'periodic' }); }

  /**
   * Single recompute tick:
   *   1. Aggregate closed trades from the past `lookbackDays`
   *   2. For each (day, hour) cell, compute weighted n/winRate/pnl/medianHold
   *   3. Load Tier 2 state (AutoTimingLifetime)
   *   4. Call classifier for each cell
   *   5. For cells in `tier2Hit === 'ever_bad'` → write/update Tier 2
   *   6. Persist scheduler telemetry to AppConfig
   *   7. Emit 'autoTiming:applied' for downstream UI/Telegram hooks
   *
   * @param {{ source?: 'periodic' | 'manual' }} opts
   * @returns {Promise<{ ok, source, cellsEvaluated, tier2Promotions, error }>}
   */
  async runOnce({ source = 'periodic' } = {}) {
    if (this._inFlight) {
      logger.warn({ source }, 'autoTiming: runOnce skipped (already in flight)');
      return { ok: false, reason: 'in_flight', source };
    }
    if (!this._config) {
      await this._loadConfig();
    }
    if (!this._config || !this._config.enabled) {
      return { ok: false, reason: 'master_disabled', source };
    }
    if (licenseService && licenseService.isFeatureEnabled && !licenseService.isFeatureEnabled('autoTiming')) {
      return { ok: false, reason: 'license_disabled', source };
    }

    this._inFlight = true;
    const startedAt = new Date();
    try {
      const sinceMs = startedAt.getTime() - this._config.lookbackDays * 86400_000;
      const trades = await Trade.find({
        sellFilledAt: { $ne: null, $gte: new Date(sinceMs) },
        buyFilledAt: { $ne: null },
      })
        .select({ buyFilledAt: 1, sellFilledAt: 1, pnlUSDT: 1, _id: 0 })
        .lean();

      const cellMap = aggregateByCell(trades, this._config, startedAt.getTime());

      // Load Tier 2 in bulk (168 docs max — 7×24)
      const tier2Docs = await AutoTimingLifetime.find({}).lean();
      const tier2ByCell = new Map();
      for (const d of tier2Docs) {
        tier2ByCell.set(`${d.day}:${d.hour}`, d);
      }

      let cellsEvaluated = 0;
      let tier2Promotions = 0;
      const writes = [];

      for (const [cellKey, cellStats] of cellMap.entries()) {
        const [dayStr, hourStr] = cellKey.split(':');
        const day = Number(dayStr);
        const hour = Number(hourStr);
        const tier2 = tier2ByCell.get(cellKey) || null;
        const result = classify(cellStats, tier2, this._config, startedAt.getTime());
        cellsEvaluated++;

        if (shouldPromoteToTier2(result, tier2, this._config.cooldownDays)) {
          tier2Promotions++;
          const suppressUntil = new Date(startedAt.getTime() + this._config.cooldownDays * 86400_000);
          writes.push(buildTier2Upsert({
            day, hour,
            suppressUntil,
            pnlPerTrade: cellStats.n > 0 ? cellStats.pnlUSDT / cellStats.n : 0,
            winRate: cellStats.winRate,
            existing: tier2,
          }));
        }
      }

      // Also persist lastEvaluatedAt for cells we saw (even non-bad)
      for (const cellKey of cellMap.keys()) {
        const [dayStr, hourStr] = cellKey.split(':');
        writes.push({
          updateOne: {
            filter: { day: Number(dayStr), hour: Number(hourStr) },
            update: { $set: { lastEvaluatedAt: startedAt, lifetimeN: cellMap.get(cellKey).n } },
            upsert: false,
          },
        });
      }

      if (writes.length > 0) {
        try {
          await AutoTimingLifetime.bulkWrite(writes, { ordered: false });
        } catch (err) {
          logger.warn({ err: err.message }, 'autoTiming: bulkWrite tier2 failed');
        }
      }

      const stats = {
        source,
        ranAt: startedAt,
        cellsEvaluated,
        tier2Promotions,
        lookbackDays: this._config.lookbackDays,
        tradesScanned: trades.length,
        config: this._configSummary(),
      };
      await this._persistSchedulerTelemetry(stats, null);
      try { eventBus.emit('autoTiming:applied', stats); } catch (_) { /* ignore */ }
      // FIX-2026-08-30 / Phase 4: dashboard tile ping — emitted right after every runOnce so the
      //   navbar pill refreshes today's decision tally via GET /api/auto-timing/recent-decisions.
      try {
        eventBus.emit('autoTiming:update', {
          ts: Date.now(),
          source,
          ranAt: stats.ranAt,
          enabled: !!(this._config && this._config.enabled),
          cellsEvaluated,
          tier2Promotions,
          tradesScanned: trades.length,
        });
      } catch (_) { /* ignore */ }
      logger.info({ stats }, 'autoTiming: tick done');
      return { ok: true, ...stats };
    } catch (err) {
      logger.warn({ err: err.message, source }, 'autoTiming: tick error');
      try {
        await this._persistSchedulerTelemetry({ source, ranAt: startedAt }, err.message);
      } catch (_) { /* ignore */ }
      return { ok: false, error: err.message, source, ranAt: startedAt };
    } finally {
      this._inFlight = false;
    }
  }

  async _persistSchedulerTelemetry(stats, errorMsg) {
    try {
      await AppConfig.updateOne({ key: 'singleton' }, {
        $set: {
          autoTimingLastRunAt: new Date(),
          autoTimingLastStats: stats,
          autoTimingLastError: errorMsg || null,
        },
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'autoTiming: persistSchedulerTelemetry failed');
    }
  }

  /**
   * HOT PATH — called from trader.js placeBuy().
   * 1. Resolve master config (cached)
   * 2. Check license + master + per-bot opt-in
   * 3. Resolve (day, hour) from `now`
   * 4. Load current cell stats from in-memory cache (rebuilt on runOnce) OR compute on-demand
   * 5. Call classifier
   * 6. Call decider with per-bot context (capital, override, state)
   * 7. Append AutoTimingLog (non-blocking — fire-and-forget)
   *
   * Returns the decider result. Trader.js applies the knobs (notional, force ST, etc.).
   *
   * @param {Object} bot — Mongoose Bot doc
   * @param {Date|number} now — default Date.now()
   * @returns {Object} decider result (see src/core/autoTimingDecider.js)
   */
  async decideForBot(bot, now = Date.now()) {
    const noOp = () => ({
      effectiveAction: 'allow', action: 'allow', band: null,
      notionalMult: 1, notionalUSDT: 0, notionalFinal: 0, notionalClamped: 'in_range',
      forceST1: false, forceST2: false, forceST3: false, forceCBv5: false,
      tpTightenPct: 0, slTightenPct: 0, minKcMult: 1,
      maxConcurrent: null, maxTradesPerDay: null,
      blocked: false, skipReason: null, overrideApplied: null,
      bandId: null, confidence: 'no_data', reason: 'autoTiming disabled',
      source: 'classifier',
    });

    if (!this._config || !this._config.enabled) return noOp();
    if (!bot) return noOp();
    // Per-bot opt-in: null = inherit, false = off, true = on
    if (bot.autoTimingEnabled === false) return noOp();

    const bucket = bucketOf(now);
    let cellStats = this._cachedCellStats && this._cachedCellStats.get(`${bucket.day}:${bucket.hour}`) || null;
    if (!cellStats) {
      // Cold path: query DB once for this cell (acceptable; called once per BUY)
      try {
        cellStats = await this._fetchCellStats(bucket, now);
      } catch (err) {
        logger.warn({ err: err.message }, 'autoTiming: cold-path cellStats failed; allowing');
        return noOp();
      }
    }

    let tier2State = null;
    try {
      const t2 = await AutoTimingLifetime.findOne({ day: bucket.day, hour: bucket.hour }).lean();
      tier2State = t2 || null;
    } catch (_) { /* allow through */ }

    const result = classify(cellStats, tier2State, this._config, msOf(now));
    const counterKey = `${bot._id || bot.id}:${bucket.day}:${bucket.hour}`;
    const openFromCell = this._counters.openFromCell.get(counterKey) || 0;
    const tradesFromCellToday = this._counters.tradesFromCellToday.get(counterKey) || 0;
    const decision = decide(result, bot, bucket, {
      minFloorUSDT: this._config.minFloorUSDT,
      maxCeilingUSDT: this._config.maxCeilingUSDT,
    }, { openFromCell, tradesFromCellToday });

    // FIX-2026-08-30 / Phase 4: emit suppressHit event with anti-spam latch 1/bot/day/cell
    // FIX-2026-09-01 audit H6: todayKey must use LOCAL-time date to match bucket.day/hour.
    //   The previous code used toISOString().slice(0,10) — that's UTC. For a bot
    //   running in BKK (+7), Monday 06:30 local = Sunday 23:30 UTC → todayKey
    //   rolled to the previous day, breaking the "1 per bot per day per cell" latch:
    //   two Suppress hits on Monday 06:30 and Monday 23:30 (same day, same cells)
    //   got different todayKeys → user received duplicate Telegram messages.
    //   bucketOf() uses local-time getDay()/getHours(), so the latch day must too.
    if (decision.blocked) {
      const latchKey = `${bot._id || bot.id}:${bucket.day}:${bucket.hour}`;
      const todayKey = _localDateKey(msOf(now));
      const fullKey = `${latchKey}:${todayKey}`;
      if (!this._autoTimingSuppressLatched || !this._autoTimingSuppressLatched.has(fullKey)) {
        if (!this._autoTimingSuppressLatched) this._autoTimingSuppressLatched = new Set();
        this._autoTimingSuppressLatched.add(fullKey);
        // Reset memory lazily: cap size to 5000 entries (TTL-ish protection)
        if (this._autoTimingSuppressLatched.size > 5000) {
          const arr = [...this._autoTimingSuppressLatched];
          this._autoTimingSuppressLatched = new Set(arr.slice(-2500));
        }
        try {
          eventBus.emit('autoTiming:suppressHit', {
            botId: String(bot._id || bot.id),
            botName: bot.name || null,
            symbol: bot.symbol || null,
            timeframe: bot.timeframe || null,
            day: bucket.day,
            hour: bucket.hour,
            action: decision.effectiveAction || 'suppress',
            reason: decision.reason || decision.skipReason || 'cell_suppressed',
            holdBand: decision.bandId || null,
          });
        } catch (_) { /* ignore */ }
      }
    }

    // Telemetry: persist last decision + log append
    // FIX-2026-09-01 audit H7: throttle the 2 writes per BUY. Before this fix,
    //   every BUY → Bot.updateOne + AutoTimingLog.create = 2 DB writes. With
    //   active bots opening BUYs every candle (every 3m/5m), this adds up to
    //   thousands of writes/day per bot, mostly redundant (same decision
    //   repeated). Throttle: write on state-change, OR every 60s, OR on
    //   Suppress (always — critical audit).
    const botId = String(bot._id || bot.id);
    const nowMs = msOf(now);
    const decisionSig = `${decision.effectiveAction}|${decision.blocked ? 1 : 0}|${decision.reason || ''}|${bucket.day}|${bucket.hour}`;
    const lastAt = this._lastPersistAt.get(botId) || 0;
    const lastSig = this._lastPersistSig.get(botId) || '';
    const elapsed = nowMs - lastAt;
    const sigChanged = lastSig !== decisionSig;
    const isSuppress = decision.blocked === true;
    const shouldPersist = sigChanged || isSuppress || elapsed >= this._PERSIST_INTERVAL_MS;
    if (shouldPersist) {
      try {
        await Bot.updateOne({ _id: bot._id }, {
          $set: {
            autoTimingLastEvaluatedAt: new Date(),
            autoTimingLastDecision: {
              day: bucket.day, hour: bucket.hour,
              bandId: decision.bandId, action: decision.effectiveAction,
              blocked: decision.blocked, reason: decision.reason,
              source: decision.source,
            },
          },
        });
        const logPromise = AutoTimingLog.create({
          botId,
          ts: new Date(nowMs),
          day: bucket.day, hour: bucket.hour,
          action: decision.effectiveAction,
          source: decision.source,
          blocked: decision.blocked,
          skipReason: decision.skipReason,
          bandId: decision.bandId,
          bandSnapshot: pickBandSnapshot(decision.band),
          overrideApplied: decision.overrideApplied,
          nWeighted: cellStats ? cellStats.n : 0,
          winRate: cellStats ? cellStats.winRate : 0,
          medianHoldMin: cellStats ? cellStats.medianHoldMin : 0,
          // FIX-2026-08-31: persist p75HoldMin alongside median so the UI can show
          //   both, and so future A/B tests don't need to recompute aggregations.
          p75HoldMin: cellStats ? (cellStats.p75HoldMin || 0) : 0,
          confidence: decision.confidence,
          note: decision.reason,
        });
        if (logPromise && typeof logPromise.catch === 'function') {
          logPromise.catch((err) => logger.warn({ err: err.message }, 'autoTiming: log append failed'));
        }
        this._lastPersistAt.set(botId, nowMs);
        this._lastPersistSig.set(botId, decisionSig);
      } catch (err) {
        logger.warn({ err: err.message }, 'autoTiming: telemetry write failed');
      }
    }

    return decision;
  }

  async _fetchCellStats(bucket, now) {
    const since = new Date(msOf(now) - this._config.lookbackDays * 86400_000);
    const trades = await Trade.find({
      sellFilledAt: { $ne: null, $gte: since },
      buyFilledAt: { $ne: null },
    }).select({ buyFilledAt: 1, sellFilledAt: 1, pnlUSDT: 1 }).lean();
    const cellMap = aggregateByCell(trades, this._config, msOf(now));
    return cellMap.get(`${bucket.day}:${bucket.hour}`) || {
      bucket, n: 0, winRate: 0, pnlUSDT: 0, medianHoldMin: 0, p75HoldMin: 0, holds: [],
    };
  }

  /**
   * Update the in-memory counter for a BUY fill or a position close.
   * Called by trader.js after placeBuy() success and after SELL fill.
   */
  bumpCounter(kind, bot, now = Date.now()) {
    if (!bot) return;
    const bucket = bucketOf(now);
    const key = `${bot._id || bot.id}:${bucket.day}:${bucket.hour}`;
    if (kind === 'open') {
      this._counters.openFromCell.set(key, (this._counters.openFromCell.get(key) || 0) + 1);
      this._counters.tradesFromCellToday.set(key, (this._counters.tradesFromCellToday.get(key) || 0) + 1);
    } else if (kind === 'close') {
      const v = this._counters.openFromCell.get(key) || 0;
      if (v > 0) this._counters.openFromCell.set(key, v - 1);
    }
  }

  /**
   * Reset per-day counters at midnight (server-local TZ). Called by a daily timer in server.js.
   */
  resetDailyCounters() {
    this._counters.tradesFromCellToday.clear();
  }
}

// ─── Pure helpers (exported for unit tests) ──────────────────────────────

function posOrDefault(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

function defaultConfig() {
  return {
    enabled: false,
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
    recentDays: DEFAULT_RECENT_DAYS,
    recentWeight: DEFAULT_RECENT_WEIGHT,
    normalWeight: DEFAULT_NORMAL_WEIGHT,
    cooldownDays: DEFAULT_COOLDOWN_DAYS,
    minTradesEnforce: DEFAULT_MIN_TRADES_ENFORCE,
    minTradesShow: DEFAULT_MIN_TRADES_SHOW,
    holdMetric: 'median', // FIX-2026-08-31: default to median (outlier-robust)
    minFloorUSDT: DEFAULT_MIN_NOTIONAL_FLOOR,
    maxCeilingUSDT: DEFAULT_MAX_NOTIONAL_CEILING,
    suppressThresholdEverBad: SUPPRESS_THRESHOLD_EVER_BAD,
    intervalMs: DEFAULT_INTERVAL_MS,
    bands: getDefaultBandsClone(),
  };
}

function bucketOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return { day: d.getDay(), hour: d.getHours() };
}

function msOf(date) {
  return date instanceof Date ? date.getTime() : Number(date);
}

/**
 * FIX-2026-09-01 audit H6: local-time YYYY-MM-DD string for the suppressHit
 *   latch. bucketOf() uses d.getDay()/d.getHours() (LOCAL), so the latch day
 *   must also be local. Previously the code used toISOString().slice(0,10)
 *   (UTC) — which disagrees with bucket.day for any timezone east/west of
 *   the date line. For BKK (+7): Monday 06:30 local → Sunday in UTC.
 */
function _localDateKey(msOrDate) {
  const d = msOrDate instanceof Date ? msOrDate : new Date(msOrDate);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function aggregateByCell(trades, config, nowMs) {
  const map = new Map();
  for (const t of trades) {
    const buyTs = t.buyFilledAt ? new Date(t.buyFilledAt).getTime() : null;
    const sellTs = t.sellFilledAt ? new Date(t.sellFilledAt).getTime() : null;
    if (!buyTs || !sellTs) continue;
    const holdMin = (sellTs - buyTs) / 60000;
    if (!Number.isFinite(holdMin) || holdMin < 0) continue;
    const dayAgeDays = (nowMs - buyTs) / 86400_000;
    const w = dayAgeDays <= config.recentDays ? config.recentWeight : config.normalWeight;
    const d = new Date(buyTs);
    const key = `${d.getDay()}:${d.getHours()}`;
    let cell = map.get(key);
    if (!cell) {
      // FIX-2026-08-31: pre-allocate p75HoldMin=0 alongside medianHoldMin so the
      //   classifier can pick either metric without crashing on legacy cells.
      cell = { bucket: { day: d.getDay(), hour: d.getHours() }, n: 0, winRate: 0, pnlUSDT: 0, medianHoldMin: 0, p75HoldMin: 0, holds: [], weightedSumW: 0, weightedSumWin: 0 };
      map.set(key, cell);
    }
    cell.weightedSumW += w;
    const isWin = Number(t.pnlUSDT) > 0;
    cell.weightedSumWin += (isWin ? w : 0);
    cell.pnlUSDT += Number(t.pnlUSDT) || 0;
    cell.holds.push(holdMin);
  }
  // Finalize
  for (const cell of map.values()) {
    cell.n = cell.weightedSumW;
    cell.winRate = cell.weightedSumW > 0 ? cell.weightedSumWin / cell.weightedSumW : 0;
    cell.medianHoldMin = median(cell.holds);
    // FIX-2026-08-31: compute P75 alongside median so the user can switch metrics
    //   without recomputing the full 30-day aggregation.
    cell.p75HoldMin = percentile(cell.holds, 0.75);
    delete cell.weightedSumW; delete cell.weightedSumWin;
  }
  return map;
}

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// FIX-2026-08-31: percentile helper — linear interpolation between adjacent ranks.
//   p in [0,1]. Returns 0 for empty arrays. For p=0.5 this equals median().
function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  if (!Number.isFinite(p) || p < 0 || p > 1) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1); // 0..n-1
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function buildTier2Upsert({ day, hour, suppressUntil, pnlPerTrade, winRate, existing }) {
  const now = new Date();
  const update = {
    $set: {
      suppressUntil,
      lastBadAt: now,
      lastEvaluatedAt: now,
    },
    $inc: { everBadCount: 1 },
    $setOnInsert: {
      day, hour,
      firstBadAt: existing && existing.firstBadAt ? existing.firstBadAt : now,
      lifetimeN: 0, lifetimeWinRate: 0, lifetimePnlUSDT: 0,
    },
  };
  // Update cumulative lifetime stats only when an existing record is present
  if (existing) {
    update.$set.lifetimePnlUSDT = (existing.lifetimePnlUSDT || 0) + pnlPerTrade;
    update.$set.lifetimeWinRate = winRate; // approximation; full lifetime would need aggregation
    update.$set.lifetimeN = (existing.lifetimeN || 0) + 1;
  }
  return {
    updateOne: {
      filter: { day, hour },
      update,
      upsert: true,
    },
  };
}

function pickBandSnapshot(band) {
  if (!band) return null;
  return {
    action: band.action,
    notionalMult: band.notionalMult,
    tpTightenPct: band.tpTightenPct,
    slTightenPct: band.slTightenPct,
    forceST1: band.forceST1, forceST2: band.forceST2, forceST3: band.forceST3,
    forceCBv5: band.forceCBv5,
    minKcMult: band.minKcMult,
    maxConcurrent: band.maxConcurrent,
    maxTradesPerDay: band.maxTradesPerDay,
  };
}

const instance = new AutoTiming();

module.exports = instance;
module.exports.AutoTiming = AutoTiming;
module.exports.aggregateByCell = aggregateByCell;
module.exports.bucketOf = bucketOf;
module.exports.median = median;
module.exports.percentile = percentile;
