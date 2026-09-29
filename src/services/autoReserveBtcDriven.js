'use strict';

/**
 * FIX-2026-09-21: BTC Trend Driven Adjust — autoReserve preset by BTC mode
 * FIX-2026-09-29: editable presets loaded from AppConfig + setPresets() API + split step
 *
 * Purpose:
 *   Adjusts autoReserve 6 fields (poleCount, usdtPerPole, lossThresholdPct,
 *   checkHours, stepReserveUsdt, stepReleaseUsdt) automatically based on BTCUSDT 1h
 *   Trend Pattern mode computed by btcTrendMonitor. This is the "global signal"
 *   layer that conservative/aggressive BTC regimes use to tighten or loosen
 *   reserve aggressiveness across all bots.
 *
 * Preset table (editable — round 3):
 *   Default values (mirror original hardcoded values):
 *     conservative (break, waiting-boots): pole=2, usdt=6, loss=4%, check=6h, step↑=6, step↓=6
 *     aggressive   (boots, waiting-break): pole=5, usdt=9, loss=2%, check=2h, step↑=9, step↓=9
 *     normal                          → no preset (user values คงเดิม)
 *   Storage: AppConfig.autoReserveBtcDrivenPresets (Object) — per-key {poleCount, ...}
 *   Override via PUT /api/wallet/auto-reserve/btc-driven/presets (auto-clamped server-side)
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

// ─── Defaults (exported for UI as "defaults" reference) ─────────────────
const DEFAULT_PRESETS = {
  conservative: {
    poleCount: 2,
    usdtPerPole: 6,
    lossThresholdPct: 4,
    checkHours: 6,
    stepReserveUsdt: 6,
    stepReleaseUsdt: 6,
  },
  aggressive: {
    poleCount: 5,
    usdtPerPole: 9,
    lossThresholdPct: 2,
    checkHours: 2,
    stepReserveUsdt: 9,
    stepReleaseUsdt: 9,
  },
};

const PRESET_KEYS = Object.keys(DEFAULT_PRESETS); // ['conservative', 'aggressive']

// FIX-2026-09-29: per-field clamp ranges (defense-in-depth — server enforces)
//   poleCount:       1..100
//   usdtPerPole:     0.1..1000
//   lossThresholdPct:0.1..50
//   checkHours:      1..168
//   stepReserveUsdt: 1..1000
//   stepReleaseUsdt: 1..1000
const PRESET_FIELD_BOUNDS = {
  poleCount:        { min: 1,   max: 100,  type: 'int'  },
  usdtPerPole:      { min: 0.1, max: 1000, type: 'num'  },
  lossThresholdPct: { min: 0.1, max: 50,   type: 'num'  },
  checkHours:       { min: 1,   max: 168,  type: 'int'  },
  stepReserveUsdt:  { min: 1,   max: 1000, type: 'int'  },
  stepReleaseUsdt:  { min: 1,   max: 1000, type: 'int'  },
};

const MODE_TO_PRESET_KEY = {
  'break':         'conservative',
  'waiting-boots': 'conservative',
  'boots':         'aggressive',
  'waiting-break': 'aggressive',
  // 'normal' → no preset key (no apply)
};

// ─── Helpers ─────────────────────────────────────────────────────────────
function clampValue(v, bounds) {
  const n = Number(v);
  if (!Number.isFinite(n)) return bounds.min;
  const clamped = Math.max(bounds.min, Math.min(bounds.max, n));
  return bounds.type === 'int' ? Math.round(clamped) : clamped;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function mergePresetsWithDefaults(stored) {
  // Per-key deep merge: stored overrides defaults, missing fields fall back to defaults.
  // Returns fresh clone (caller can mutate safely).
  const out = {};
  for (const key of PRESET_KEYS) {
    out[key] = { ...DEFAULT_PRESETS[key], ...((stored && stored[key]) || {}) };
  }
  return out;
}

function validateAndClampPresets(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('presets object required');
  }
  const out = {};
  for (const key of PRESET_KEYS) {
    const p = input[key];
    if (!p || typeof p !== 'object') {
      throw new Error(`preset '${key}' missing or invalid`);
    }
    const clamped = {};
    for (const [field, bounds] of Object.entries(PRESET_FIELD_BOUNDS)) {
      clamped[field] = clampValue(p[field], bounds);
    }
    out[key] = clamped;
  }
  return out;
}

class AutoReserveBtcDriven {
  constructor() {
    this.isEnabled = false;       // mirror AppConfig.autoReserveBtcDrivenEnabled
    this.lastMode = null;         // last BTC mode we acted on (skip-if-unchanged)
    this.lastAppliedAt = null;    // ms timestamp of last preset write
    this.lastError = null;        // last error message (for /status payload)
    this._busListener = null;     // eventBus listener reference (for .off)
    this.presets = deepClone(DEFAULT_PRESETS); // in-memory cache — refreshed on start() + setPresets()
  }

  /**
   * Read enabled flag + presets from DB on startup, then subscribe if enabled.
   * Failures here are non-fatal — service just starts in disabled mode with default presets.
   */
  async start() {
    try {
      const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
      this.isEnabled = !!(cfg && cfg.autoReserveBtcDrivenEnabled === true);
      this.lastMode = cfg && cfg.autoReserveBtcDrivenLastMode ? cfg.autoReserveBtcDrivenLastMode : null;
      this.lastAppliedAt = cfg && cfg.autoReserveBtcDrivenLastAppliedAt
        ? new Date(cfg.autoReserveBtcDrivenLastAppliedAt).getTime()
        : null;
      // FIX-2026-09-29: load presets from DB (merge with defaults so missing fields fall back)
      if (cfg && cfg.autoReserveBtcDrivenPresets && typeof cfg.autoReserveBtcDrivenPresets === 'object') {
        this.presets = mergePresetsWithDefaults(cfg.autoReserveBtcDrivenPresets);
      } else {
        this.presets = deepClone(DEFAULT_PRESETS);
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'autoReserveBtcDriven: start load failed — defaults applied');
      this.isEnabled = false;
      this.lastMode = null;
      this.lastAppliedAt = null;
      this.presets = deepClone(DEFAULT_PRESETS);
    }
    logger.info({
      enabled: this.isEnabled,
      lastMode: this.lastMode,
      presetKeys: PRESET_KEYS,
    }, 'autoReserveBtcDriven: started');
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
      presets: this.presets,
      defaults: DEFAULT_PRESETS,
      modeMapping: MODE_TO_PRESET_KEY,
    };
  }

  /**
   * Update presets at runtime. Validates + clamps per field, persists to AppConfig,
   * updates in-memory cache. Does NOT trigger preset re-apply (next BTC mode change
   * will use new values). For instant apply, disable+enable toggle.
   *
   * @param {object} newPresets  { conservative: {...}, aggressive: {...} }
   * @returns {Promise<object>}   the validated+clamped presets written
   */
  async setPresets(newPresets) {
    const validated = validateAndClampPresets(newPresets);
    await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: { autoReserveBtcDrivenPresets: validated } },
      { new: true, upsert: true }
    );
    this.presets = validated;
    logger.info({
      conservative: validated.conservative,
      aggressive: validated.aggressive,
    }, 'autoReserveBtcDriven: presets updated (in-memory + DB)');
    return validated;
  }

  /**
   * Toggle the master switch. Persists to AppConfig, then subscribes/unsubscribes.
   * Does NOT touch autoReserve 6 fields when disabling (per user decision —
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
   * - mode in mapping → write preset fields + reloadConfig (uses in-memory this.presets)
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

    // FIX-2026-09-29: use in-memory presets (loaded from DB or merged with defaults)
    const preset = this.presets[presetKey];
    if (!preset) {
      logger.warn({ mode, presetKey }, 'autoReserveBtcDriven: preset key not found in memory — skip');
      return;
    }
    const now = Date.now();

    // Write-through: write 6 preset fields (split step) + tracking in one atomic upsert.
    // Also mirror legacy autoReserveStepUsdt for clients still reading the old single field.
    await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: {
          autoReservePoleCount: preset.poleCount,
          autoReserveUsdtPerPole: preset.usdtPerPole,
          autoReserveLossThresholdPct: preset.lossThresholdPct,
          autoReserveCheckHours: preset.checkHours,
          // FIX-2026-09-29: split step — write both new fields
          autoReserveStepReserveUsdt: preset.stepReserveUsdt,
          autoReserveStepReleaseUsdt: preset.stepReleaseUsdt,
          autoReserveStepUsdt: preset.stepReserveUsdt, // @deprecated mirror (legacy clients)
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
      stepReserveUsdt: preset.stepReserveUsdt,
      stepReleaseUsdt: preset.stepReleaseUsdt,
    }, 'autoReserveBtcDriven: preset applied');
  }
}

module.exports = new AutoReserveBtcDriven();

// Export internals for tests
module.exports.DEFAULT_PRESETS = DEFAULT_PRESETS;
module.exports.PRESET_FIELD_BOUNDS = PRESET_FIELD_BOUNDS;
module.exports.MODE_TO_PRESET_KEY = MODE_TO_PRESET_KEY;
module.exports.validateAndClampPresets = validateAndClampPresets;
module.exports.mergePresetsWithDefaults = mergePresetsWithDefaults;
module.exports.clampValue = clampValue;
