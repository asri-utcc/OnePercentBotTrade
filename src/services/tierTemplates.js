'use strict';

/**
 * FIX-2026-08-27 Phase 3b-1: Per-tier Bot Presets
 *
 * When admin sets a License.tier (basic/pro/enterprise), new bots should be
 * pre-filled with sane defaults for that tier. Without this, every bot creation
 * is a manual 30-field tuning exercise and most users stick with the wrong
 * defaults for their tier (e.g. enterprise users using basic-tier capital=5).
 *
 * Precedence (per field), bottom = strongest:
 *   1. fallback      — env-level config.defaults (last-resort safe)
 *   2. botDefaults   — AppConfig.botDefaults from Settings section 1️⃣
 *   3. tierPreset    — THIS FILE (admin-set tier wins over user-global)
 *   4. overrides     — explicit user form input / scan result (wins)
 *
 * Rationale: admin-set tier is "what the customer paid for" — it should
 * override generic user defaults, but never override explicit per-field choices.
 *
 * Pattern (per tier):
 *   - capitalPerTrade: matches the typical wallet scale of that tier
 *   - maxTrades: aligns with License.maxBots (basic=10, pro=30, ent=50)
 *   - tpPercent: higher tiers → higher target (more risk appetite)
 *   - risk features (DCA, martingale, SL-UKC auto-arm): opt-in even for top tier
 *   - automation features (auto-update-TP, cb-auto-unlock): progressive unlock
 */

const TIER_PRESETS = Object.freeze({
  basic: Object.freeze({
    // Conservative — small positions, conservative risk
    capitalPerTrade: 5,
    maxTrades: 3,
    tpPercent: 0.281,           // floor (low-vol regime default)
    retryMax: 1,
    retryTimeMin: 0.5,

    cbv5Enabled: true,
    cbv5LockHours: 8,           // wider cooldown
    cbAutoUnlockEnabled: false, // strict — manual unlock only
    cbAutoUnlockThresholdPct: 1.0,
    cbv3Enabled: false,         // simpler — CBv5 only
    cbv3LockHours: 8,

    dynamicSizeEnabled: true,
    autoArmStopLossOnUKC: true,
    autoUpdateTp: false,        // static TP — predictable

    dcaEnabled: false,
    martingaleEnabled: false,
    safeTradeTrendlineEnabled: false,
    safeTradeNoTradeEnabled: false,
    stopLossOnUpperKC: false,
  }),

  pro: Object.freeze({
    // Standard — full features but still opt-in for risky ones
    capitalPerTrade: 10,
    maxTrades: 10,
    tpPercent: 0.5,
    retryMax: 3,
    retryTimeMin: 0.2,

    cbv5Enabled: true,
    cbv5LockHours: 4,
    cbAutoUnlockEnabled: true,
    cbAutoUnlockThresholdPct: 1.0,
    cbv3Enabled: true,
    cbv3LockHours: 8,

    dynamicSizeEnabled: true,
    autoArmStopLossOnUKC: true,
    autoUpdateTp: true,         // dynamic TP — market-aware

    dcaEnabled: false,          // opt-in
    martingaleEnabled: false,   // opt-in
    safeTradeTrendlineEnabled: false,
    safeTradeNoTradeEnabled: false,
    stopLossOnUpperKC: false,
  }),

  enterprise: Object.freeze({
    // Aggressive — max bots, advanced features ON
    capitalPerTrade: 25,
    maxTrades: 20,
    tpPercent: 1.0,
    retryMax: 8,
    retryTimeMin: 0.1,

    cbv5Enabled: true,
    cbv5LockHours: 2,           // tight — operator on standby
    cbAutoUnlockEnabled: true,
    cbAutoUnlockThresholdPct: 0.8,
    cbv3Enabled: true,
    cbv3LockHours: 4,

    dynamicSizeEnabled: true,
    autoArmStopLossOnUKC: true,
    autoUpdateTp: true,

    dcaEnabled: false,          // still opt-in
    martingaleEnabled: false,   // still opt-in
    safeTradeTrendlineEnabled: true,
    safeTradeNoTradeEnabled: true,
    stopLossOnUpperKC: true,
  }),
});

/**
 * Return the preset for a given tier, or empty object for unknown/null tier.
 * Empty object means "no preset contribution" — caller falls through to next level.
 */
function getTierPreset(tier) {
  if (typeof tier !== 'string') return {};
  const preset = TIER_PRESETS[tier];
  return preset || {};
}

/**
 * Return list of supported tier names. Used by tests + frontend to enumerate.
 */
function listTiers() {
  return Object.keys(TIER_PRESETS);
}

/**
 * Merge tier preset with botDefaults, with tier taking precedence.
 * Pure helper — no side effects. Used by buildBotCreatePayload.
 *
 *   mergeTierWithDefaults({capitalPerTrade: 7}, 'basic', {}) → {capitalPerTrade: 5, ...}
 *   mergeTierWithDefaults({}, 'basic', {capitalPerTrade: 7}) → {capitalPerTrade: 7}
 *     (botDefaults wins when tier doesn't set the field)
 *   mergeTierWithDefaults({capitalPerTrade: 5}, 'enterprise', {}) → {capitalPerTrade: 25}
 *     (enterprise preset overrides basic default in this edge case)
 */
function mergeTierWithDefaults(botDefaults, tier) {
  const preset = getTierPreset(tier);
  return { ...(botDefaults || {}), ...preset };
}

module.exports = {
  TIER_PRESETS,
  getTierPreset,
  listTiers,
  mergeTierWithDefaults,
};