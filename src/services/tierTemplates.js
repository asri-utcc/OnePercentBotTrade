'use strict';

/**
 * FIX-2026-08-27 Phase 3b-1: Per-tier Bot Presets
 * FIX-2026-09-04: REWORKED — tier preset no longer contributes ANY default value.
 *
 * **User directive (2026-09-04):**
 *   "ลบ tier template ออกให้หมด ให้หมด user จะได้รับค่าเริ่มต้นจากบอทเหมือนๆกันทุกคน
 *    และแต่ละคนจะปรับแต่งการตั้งค่าเองโดยไม่มีการเข้ามาแทรกแซงจากแอกมิน
 *    นอกจากการจำกัดบางฟังชั่นที่ขึ้นอยู่กับข้อจำกัดการใช้งานของแต่ละ tier"
 *
 * Tier = license-level restrictions only (maxBots, maxCapital, feature gates via
 * licenseService.isFeatureEnabled()). NO default-value contribution to bots.
 *
 * All bots — regardless of tier — start from the same fallback (config.defaults),
 * then user's botDefaults (Settings section 1️⃣), then user's explicit overrides.
 *
 * **Why:** admin silently setting "pro tier should have capital=10" caused
 *   - 28 (New Beta) bots to inherit cbv3Enabled:true → LISTA hit by CBv3
 *   - 5 (New Beta) bots to inherit cbv5Enabled:true → T(NewBeta) lost -2.08 USDT
 *   - 2 (bAdd) bots to inherit cbv2Enabled:true
 * Tier presets are too easily misconfigured to be a default-values layer.
 *
 * **What stays tier-restricted (admin-controlled, separate from this file):**
 *   - License.maxBots (licenseService.maxBotsPerLicense)
 *   - License.maxCapital (licenseService.maxCapitalPerLicense)
 *   - License.features[] → licenseService.isFeatureEnabled('cbv5'|'dca'|...)
 *   - Master toggles (cbv5MasterEnabled, masterCbAutoUnlockEnabled, ...)
 *
 * **API preserved for future use:** TIER_PRESETS, getTierPreset, listTiers,
 *   mergeTierWithDefaults — all return empty/no-op today so re-introducing
 *   tier-specific defaults later is a non-breaking change.
 */

const TIER_PRESETS = Object.freeze({
  basic: Object.freeze({}),
  pro: Object.freeze({}),
  enterprise: Object.freeze({}),
});

/**
 * Return the preset for a given tier, or empty object for unknown/null tier.
 * Empty object means "no preset contribution" — caller falls through to botDefaults.
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
 * Pure helper — no side effects.
 *
 * **Current behavior:** always returns botDefaults unchanged (tier presets are empty).
 * **Future:** if tiers re-introduce defaults, this is the single merge point.
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
