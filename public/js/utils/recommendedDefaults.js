'use strict';

/**
 * FIX-2026-09-09 audit Batch 2: Browser-side mirror of
 *   src/services/botDefaults.js → RECOMMENDED_DEFAULTS
 *
 * Why a separate file (not directly imported)?
 *   - botDefaults.js uses `require()` + Mongoose models → Node-only.
 *   - Browser pages need a frozen constant for pre-filling empty forms
 *     (bot-edit.js, settings.js, masterConfigModal.js, bots.html new-bot modal).
 *
 * Sync protocol:
 *   - When RECOMMENDED_DEFAULTS changes in src/services/botDefaults.js,
 *     COPY the new values here.
 *   - Drift between this file and the server-side constant is detected
 *     by tests/botDefaultsMirrorSync.test.js (Phase 2 batch).
 *
 * Strategy (mirrors server-side):
 *   - Classic single-position + DLC layer-gating + cut-loss fast.
 *   - AUv2 cuts ≤22 THB when age ≥ 5.3 days (128 hours)
 *   - F1 (autoArm SL-UKC) cuts when age ≥ 34.5 days (828 hours) — AUv2 fires first
 *   - No safe-trade filters (more signals pass; user decides via auto-pause)
 *   - No CB panic-sell (cbEnabled=false); cbAutoUnlockEnabled=true for fast recovery
 *   - Round-down capital ON (8 USDT/trade is small enough to be flexible)
 */
window.RECOMMENDED_DEFAULTS = Object.freeze({
  // Identity
  defaultSymbol: 'BNBUSDT',
  defaultTimeframe: '3m',

  // Position sizing
  capitalPerTrade: 8,
  maxTrades: 1,
  tpPercent: 0.1,

  // Round-down Capital
  roundDownCapitalEnabled: true,
  roundDownCapitalMin: 5.5,

  // Entry / signal config
  retryTimeMin: 0.2,
  retryMax: 8,
  kcMult: 1.2,
  minSpreadTicks: 1,
  s1OnlyDown: false,
  xs1Enabled: false,
  suggestTpWindow: 30,

  // TP
  autoUpdateTp: true,
  tpTrendEnabled: true,
  tpTrendMultiplier: 2,

  // Auto-pause
  autoPauseEnabled: true,
  autoPauseMinKcPct: 1.2,
  autoPauseMin24hVolUsdt: 400000,
  autoPauseAdjustEnabled: true,

  // Dynamic Position Sizing
  dynamicSizeEnabled: true,

  // DLC (Dynamic Layer Control) — recommended ON since DCA/Martingale are OFF
  dlcEnabled: true,
  dlcBaseLossPct: -10,

  // DCA + Martingale — recommended OFF (incompatible with DLC; opt-in)
  dcaEnabled: false,
  dcaMaxLayers: 3,
  martingaleEnabled: false,
  martingaleMultiplier: 1.5,
  martingaleMaxLayerNotional: 100,

  // Auto-Timing — recommended OFF (no heatmap gating)
  autoTimingEnabled: false,

  // Risk / SL-UKC / F1
  stopLossOnUpperKC: false,
  autoArmStopLossOnUKC: true,
  autoArmLossPct: 10,
  autoArmAgeHours: 828,
  slUkcTriggerOnProfit: true,

  // AUv2 — F1 v2 (shallow-loss exit) — recommended ON with thb mode
  auv2Enabled: true,
  auv2MinAgeHours: 128,
  auv2LossMode: 'thb',
  auv2MaxLossPct: 8,
  auv2MaxLossThb: 22,
  auv2MaxWaitDays: 0,

  // Circuit Breaker
  cbEnabled: false,
  cbv2Enabled: false,
  cbv2LockHours: 8,
  cbv3Enabled: false,
  cbv3LockHours: 8,
  cbv5Enabled: false,
  cbv5LockHours: 4,
  cbv5KcLen: 20,
  cbv5KcMult: 1.2,
  cbv5PivotLookback: 3,
  cbv5PivotLeftLen: 5,
  cbv5PivotRightLen: 5,
  cbv5StrictBreak: true,
  cbv5UseVolume: true,
  cbv5VolMaLen: 20,
  cbv5VolMultiplier: 1.5,
  cbv5DebounceCandles: 5,

  // CB Auto-Unlock
  cbAutoUnlockEnabled: true,
  cbAutoUnlockThresholdPct: 2,

  // Safe Trade filters — recommended OFF (more signals pass)
  safeTradeEnabled: false,
  safeTradeTrendlineEnabled: false,
  safeTradeNoTradeEnabled: false,
});

/**
 * rec(key) — defensive lookup. Returns the value if defined, else undefined.
 *   Mirrors the server-side `rec(key)` helper in src/services/botDefaults.js.
 *   Use as `${rec('capitalPerTrade')}` in template literals OR
 *        `rec('capitalPerTrade') ?? fallback` in expressions.
 */
window.rec = function rec(key) {
  return window.RECOMMENDED_DEFAULTS && window.RECOMMENDED_DEFAULTS[key];
};
