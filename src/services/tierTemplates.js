'use strict';

/**
 * FIX-2026-08-27 Phase 3b-1: Per-tier Bot Presets
 * FIX-2026-09-04: REWORKED — tier preset no longer sets safety/feature toggles.
 *
 * When admin sets a License.tier (basic/pro/enterprise), new bots should be
 * pre-filled with TIER-APPROPRIATE SIZING (capital, maxTrades, tpPercent, retries).
 *
 * Precedence (per field), bottom = strongest:
 *   1. fallback      — env-level config.defaults (last-resort safe)
 *   2. botDefaults   — AppConfig.botDefaults from Settings section 1️⃣
 *   3. tierPreset    — THIS FILE (admin-set tier sizing wins over user-global)
 *   4. overrides     — explicit user form input / scan result (wins)
 *
 * **CRITICAL (FIX-2026-09-04):** Tier preset does NOT auto-enable ANY safety/feature toggle.
 *   All *Enabled fields (cbv5Enabled, cbv3Enabled, dynamicSizeEnabled, autoArmStopLossOnUKC,
 *   autoUpdateTp, cbAutoUnlockEnabled, dcaEnabled, martingaleEnabled, safeTradeTrendlineEnabled,
 *   safeTradeNoTradeEnabled, stopLossOnUpperKC) are EXPLICITLY OMITTED from presets.
 *   Rationale: silent divergence caused 28 (New Beta) bots to have cbEnabled=false but
 *   cbv3Enabled=true; user got hit on LISTA today (-X USDT). User directive:
 *   "ให้ผู้ใช้เป็นผู้ตั้ง ไม่ผูกกับ preset tier ใดๆ"
 *   Lock-hours + threshold-pct kept as numeric hints for when user opts-in.
 *
 * Pattern (per tier):
 *   - capitalPerTrade: matches the typical wallet scale of that tier
 *   - maxTrades: aligns with License.maxBots (basic=10, pro=30, ent=50)
 *   - tpPercent: higher tiers → higher target (more risk appetite)
 *   - cbv*LockHours: tighter for higher tier (operator can intervene)
 *   - NO safety/feature *Enabled flags — user must opt-in per-bot
 */

const TIER_PRESETS = Object.freeze({
  basic: Object.freeze({
    // FIX-2026-09-04: Tier preset now ONLY sets size/limit defaults — never safety/feature toggles.
    //   User directive: "ให้ผู้ใช้เป็นผู้ตั้ง ไม่ผูกกับ preset tier ใดๆ"
    //   All *Enabled flags removed — user must explicitly opt-in per-bot (CB, DPS, DCA, etc.).
    //   Lock-hours + threshold fields kept as numeric "hints" for when user does opt-in.
    capitalPerTrade: 5,
    maxTrades: 3,
    tpPercent: 0.281,           // floor (low-vol regime default)
    retryMax: 1,
    retryTimeMin: 0.5,

    cbv5LockHours: 8,           // hint if user opts-in to CBv5
    cbv3LockHours: 8,           // hint if user opts-in to CBv3
    cbAutoUnlockThresholdPct: 1.0,
  }),

  pro: Object.freeze({
    capitalPerTrade: 10,
    maxTrades: 10,
    tpPercent: 0.5,
    retryMax: 3,
    retryTimeMin: 0.2,

    cbv5LockHours: 4,
    cbv3LockHours: 8,
    cbAutoUnlockThresholdPct: 1.0,
  }),

  enterprise: Object.freeze({
    capitalPerTrade: 25,
    maxTrades: 20,
    tpPercent: 1.0,
    retryMax: 8,
    retryTimeMin: 0.1,

    cbv5LockHours: 2,           // tight — operator on standby
    cbv3LockHours: 4,
    cbAutoUnlockThresholdPct: 0.8,
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