'use strict';

/**
 * FIX-2026-09-21: BTC Trend Driven Adjust — autoReserve preset by BTC mode
 *
 * Purpose:
 *   Adjusts autoReserve 5 fields (poleCount, usdtPerPole, lossThresholdPct,
 *   checkHours, stepUsdt) automatically based on BTCUSDT 1h Trend Pattern mode
 *   computed by btcTrendMonitor. This is the "global signal" layer that
 *   conservative/aggressive BTC regimes use to tighten or loosen reserve
 *   aggressiveness across all bots.
 *
 * Preset table (hardcoded — user spec 2026-09-21):
 *   conservative (break, waiting-boots): pole=2, usdt=6, loss=4%, check=6h, step=6
 *   aggressive   (boots, waiting-break): pole=5, usdt=9, loss=2%, check=2h, step=9
 *   normal                          → no preset (user values คงเดิม)
 *
 * Architecture:
 *   - Singleton (mirror btcTrendMonitor, autoReserve patterns)
 *   - Subscribes to 'btc-trend:mode' event from btcTrendMonitor
 *   - Write-through to AppConfig (per user decision) — preset values land in DB
 *     immediately, dashboard reflects new values
 *   - Calls autoReserve.reloadConfig() after each write so scheduler picks up
 *     new checkHours / enabled flag
 *   - Toggle OFF does NOT restore previous user values — DB keeps the
 *     last BTC-applied values (per user decision 2026-09-21)
 *
 * Not persisted: lastMode/lastAppliedAt also persisted to AppConfig for
 *   dashboard rendering without round-trip to btcTrendMonitor.
 *
 * Lifecycle:
 *   - start() called from server.js AFTER btcTrendMonitor + autoReserve
 *     (so BTC mode state is ready and reloadConfig can pick up changes)
 *   - stop() detaches eventBus listener to prevent leak on shutdown
 */

const AppConfig = require('../db/models/AppConfig');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');
const autoReserve = require('./autoReserve');
const btcTrendMonitor = require('./btcTrendMonitor');

// ─── Preset table (exported for UI) ─────────────────────────────────────
const BTC_PRESETS = {
  conservative: {
    poleCount: 2,
    usdtPerPole: 6,
    lossThresholdPct: 4,
    checkHours: 6,
    stepUsdt: 6,
  },
  aggressive: {
    poleCount: 5,
    usdtPerPole: 9,
    lossThresholdPct: 2,
    checkHours: 2,
    stepUsdt: 9,
  },
};

const MODE_TO_PRESET_KEY = {
  'break':         'conservative',
  'waiting-boots': 'conservative',
  'boots':         'aggressive',
  'waiting-break': 'aggressive',
  // 'normal' → no preset key (no apply)
};

class AutoReserveBtcDriven {
  constructor() {
    this.isEnabled = false;       // mirror AppConfig.autoReserveBtcDrivenEnabled
    this.lastMode = null;         // last BTC mode we acted on (skip-if-unchanged)
    this.lastAppliedAt = null;    // ms timestamp of last preset write
    this.lastError = null;        // last error message (for /status payload)
    this._busListener = null;     // eventBus listener reference (for .off)
  }

  /**
   * Read enabled flag from DB on startup, then subscribe if enabled.
   * Failures here are non-fatal — service just starts in disabled mode.
   */
  async start() {
    try {
      const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
      this.isEnabled = !!(cfg && cfg.autoReserveBtcDrivenEnabled === true);
      this.lastMode = cfg && cfg.autoReserveBtcDrivenLastMode ? cfg.autoReserveBtcDrivenLastMode : null;
      this.lastAppliedAt = cfg && cfg.autoReserveBtcDrivenLastAppliedAt
        ? new Date(cfg.autoReserveBtcDrivenLastAppliedAt).getTime()
        : null;
    } catch (err) {
      logger.warn({ err: err.message }, 'autoReserveBtcDriven: start load failed — defaults applied');
      this.isEnabled = false;
      this.lastMode = null;
      this.lastAppliedAt = null;
    }
    logger.info({ enabled: this.isEnabled, lastMode: this.lastMode }, 'autoReserveBtcDriven: started');
    if (this.isEnabled) {
      // Force-apply on startup in case BTC mode changed while we were down
      this._subscribeAndApply(true);
    }
  }

  /**
   * Detach eventBus listener. Safe to call multiple times.
   */
  stop() {
    this._unsubscribe();
    logger.info('autoReserveBtcDriven: stopped');
  }

  /**
   * Public snapshot for GET /api/wallet/auto-reserve/btc-driven + UI.
   */
  getStatus() {
    return {
      enabled: this.isEnabled,
      lastMode: this.lastMode,
      lastAppliedAt: this.lastAppliedAt,
      lastError: this.lastError,
      presets: BTC_PRESETS,
      modeMapping: MODE_TO_PRESET_KEY,
    };
  }

  /**
   * Toggle the master switch. Persists to AppConfig, then subscribes/unsubscribes.
   * Does NOT touch autoReserve 5 fields when disabling (per user decision —
   * DB keeps the last BTC-applied values).
   */
  async setEnabled(bool) {
    const wantEnabled = bool === true;
    await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: { autoReserveBtcDrivenEnabled: wantEnabled } },
      { new: true, upsert: true }
    );
    this.isEnabled = wantEnabled;
    this.lastError = null;
    if (wantEnabled) {
      // Force-apply on enable so the initial preset reflects current BTC mode
      this._subscribeAndApply(true);
      logger.info('autoReserveBtcDriven: enabled — subscribed to btc-trend:mode');
    } else {
      // Detach listener + clear in-memory tracking (do NOT touch DB autoReserve values)
      this._unsubscribe();
      this.lastMode = null;
      this.lastAppliedAt = null;
      // Persist cleared tracking so UI badge reflects OFF state
      try {
        await AppConfig.findOneAndUpdate(
          { key: 'singleton' },
          { $set: { autoReserveBtcDrivenLastMode: null, autoReserveBtcDrivenLastAppliedAt: null } },
          { new: true, upsert: true }
        );
      } catch (err) {
        logger.warn({ err: err.message }, 'autoReserveBtcDriven: clear tracking on disable failed');
      }
      logger.info('autoReserveBtcDriven: disabled — DB autoReserve values kept as-is');
    }
    return this.getStatus();
  }

  /**
   * Internal: subscribe to eventBus + apply current BTC mode.
   * force=true → skip same-mode check (used on initial subscribe where lastMode
   * could be null OR stale from previous session).
   */
  _subscribeAndApply(force) {
    // Detach any prior listener (defensive — should not happen in normal flow)
    this._unsubscribe();
    const mode = btcTrendMonitor.getState().mode;
    // Apply current mode synchronously (don't await — start() returns immediately)
    this._applyForMode(mode, !!force).catch((err) => {
      logger.error({ err: err.message }, 'autoReserveBtcDriven: initial apply failed');
      this.lastError = err.message || String(err);
    });
    this._busListener = (payload) => this._onBtcMode(payload);
    eventBus.on('btc-trend:mode', this._busListener);
  }

  _unsubscribe() {
    if (this._busListener) {
      try { eventBus.off('btc-trend:mode', this._busListener); } catch (e) { /* ignore */ }
      this._busListener = null;
    }
  }

  /**
   * EventBus handler for btc-trend:mode transitions.
   * Skip if disabled or mode unchanged from last applied.
   */
  _onBtcMode({ mode, prevMode, computedAt }) {
    if (!this.isEnabled) return;
    if (mode === this.lastMode) return; // already applied this mode
    this._applyForMode(mode, false).catch((err) => {
      logger.error({ err: err.message, mode }, 'autoReserveBtcDriven: apply on transition failed');
      this.lastError = err.message || String(err);
    });
  }

  /**
   * Internal: apply preset for the given BTC mode.
   * - normal mode → clear lastMode/lastAppliedAt, do NOT write preset fields
   * - mode in mapping → write preset fields + reloadConfig
   * - unknown mode → skip silently (defensive — btcTrendMonitor can return anything)
   *
   * @param {string} mode
   * @param {boolean} force — when true, apply even if mode === lastMode (initial state)
   */
  async _applyForMode(mode, force) {
    const presetKey = MODE_TO_PRESET_KEY[mode];

    // normal mode OR unknown → just clear tracking, no preset write
    if (!presetKey) {
      this.lastMode = mode;
      this.lastAppliedAt = null;
      this.lastError = null;
      try {
        await AppConfig.findOneAndUpdate(
          { key: 'singleton' },
          { $set: {
              autoReserveBtcDrivenLastMode: mode,
              autoReserveBtcDrivenLastAppliedAt: null,
          }},
          { new: true, upsert: true }
        );
        logger.info({ mode }, 'autoReserveBtcDriven: mode has no preset — autoReserve values untouched');
      } catch (err) {
        this.lastError = err.message || String(err);
        logger.warn({ err: err.message, mode }, 'autoReserveBtcDriven: tracking clear failed');
      }
      return;
    }

    // Skip if already applied this mode (same-mode emit) — only for non-force calls
    if (!force && mode === this.lastMode) return;

    const preset = BTC_PRESETS[presetKey];
    const now = Date.now();

    // Write-through: write 5 preset fields + tracking in one atomic upsert
    await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: {
          autoReservePoleCount: preset.poleCount,
          autoReserveUsdtPerPole: preset.usdtPerPole,
          autoReserveLossThresholdPct: preset.lossThresholdPct,
          autoReserveCheckHours: preset.checkHours,
          autoReserveStepUsdt: preset.stepUsdt,
          autoReserveBtcDrivenLastMode: mode,
          autoReserveBtcDrivenLastAppliedAt: new Date(now),
      }},
      { new: true, upsert: true }
    );

    // Reload autoReserve so scheduler picks up new checkHours / installed interval
    try {
      await autoReserve.reloadConfig();
    } catch (err) {
      // Non-fatal — DB write succeeded, scheduler will re-evaluate on next tick
      logger.warn({ err: err.message }, 'autoReserveBtcDriven: reloadConfig after preset write failed');
    }

    this.lastMode = mode;
    this.lastAppliedAt = now;
    this.lastError = null;
    logger.info({
      mode, presetKey,
      poleCount: preset.poleCount,
      usdtPerPole: preset.usdtPerPole,
      lossThresholdPct: preset.lossThresholdPct,
      checkHours: preset.checkHours,
      stepUsdt: preset.stepUsdt,
    }, 'autoReserveBtcDriven: preset applied');
  }
}

module.exports = new AutoReserveBtcDriven();
