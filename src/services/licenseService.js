'use strict';

/**
 * FIX-2026-08-27 Phase 3a C2: License features + max-capital enforcement
 *
 * Reads the cached license from `licenseGate.lastLicense` (set on every successful
 * validate / re-validate) and exposes synchronous-friendly helpers that the rest of
 * the bot uses to gate premium features + enforce capital caps.
 *
 * Source-of-truth is admin's `License` document:
 *   - features: { telegram, autoReserve, cbv5, ... }   → boolean gates
 *   - maxCapital: Number (USDT)                        → deployment cap, 0 = unlimited
 *
 * Caching:
 *   - All values are memoized from licenseGate.lastLicense, which itself refreshes
 *     every 1h (REVALIDATE_MS). No need for an additional TTL here.
 *   - getTotalDeployedUsdt() does query the Bot collection — cached 30s to keep
 *     the BUY hot path fast (one Mongo find per ~30s, not per candle).
 *
 * Safety contract:
 *   - If licenseGate is disabled or no valid license → all features return false,
 *     getMaxCapital() returns 0 (most restrictive), getTotalDeployedUsdt returns 0.
 *   - getMaxCapital() === 0 means "no capital allowed" — not "unlimited". Use
 *     `Infinity` for unlimited and never compare with `>` directly; use
 *     `withinMaxCapital(usdt)` instead.
 */

const Bot = require('../db/models/Bot');
const licenseGate = require('../admin-monitor/licenseGate');
const logger = require('../utils/logger');

const TOTAL_DEPLOYED_CACHE_MS = 30 * 1000;
const _totalDeployedCache = { value: 0, at: 0 };

function _getLicense() {
  // licenseGate.lastLicense is the admin-issued License doc (NOT including
  // runtime fields like machine/machineId). Returns null if invalid/missing.
  return licenseGate.lastLicense || null;
}

// FIX-2026-08-28 B5: 11 feature keys (was 3). Default-ON for backward-compat
// (existing licenses without features.* still work). Default-OFF for new premium-only
// flags (autoAddBot / autoUpdateTp / autoPauseMinKc) so legacy licenses don't silently
// gain premium features.
// FIX-2026-08-29: +1 key (configBackup) for Config Backup/Restore feature. Default ON.
// FIX-2026-08-30: +1 key (autoTiming) for Phase 4 Auto-Timing (heatmap-driven entry gate).
//   Premium-only, default OFF — owner must enable via admin Edit License modal.
function _getFeatures() {
  const lic = _getLicense();
  if (!lic) {
    // FIX-2026-09-01 audit H3: per-feature default when no license is set.
    //   Safety features (CB/CBv5/safeTrade/telegram/...) default ON even
    //   before the first heartbeat validates the license — fail-OPEN for
    //   safety prevents a brief NO-protection window (e.g. bot boot,
    //   license renewal gap) where CB would silently disable and the
    //   bot could over-trade or skip circuit breakers.
    //   Premium features (autoReserve/autoAddBot/autoTiming/...) default
    //   OFF — they're admin-gated, never accidentally free.
    return _safetyOnPremiumOff();
  }
  const f = lic.features || {};
  return {
    telegram: f.telegram !== false,
    autoReserve: f.autoReserve === true,
    cbv5: f.cbv5 !== false,
    safeTrade: f.safeTrade !== false,
    cb: f.cb !== false,
    telegramLogin: f.telegramLogin !== false,
    autoAddBot: f.autoAddBot === true,
    autoUpdateTp: f.autoUpdateTp === true,
    autoPauseMinKc: f.autoPauseMinKc === true,
    chartMonitor: f.chartMonitor !== false,
    dps: f.dps !== false,
    configBackup: f.configBackup !== false,
    autoTiming: f.autoTiming === true,
  };
}

/**
 * FIX-2026-09-01 audit H3: split default-on (safety) vs default-off (premium).
 *   Used only when `_getLicense()` returns null (boot window before first
 *   admin heartbeat). Once a license IS loaded, the per-field semantics
 *   in `_getFeatures()` apply (legacy ON-premium = match `!== false`,
 *   new premium = strict `=== true`).
 */
function _safetyOnPremiumOff() {
  return {
    // Safety ON (defensive — better to over-protect than under)
    telegram: true,
    cbv5: true,
    safeTrade: true,
    cb: true,
    telegramLogin: true,
    chartMonitor: true,
    dps: true,
    configBackup: true,
    // Premium OFF (admin-gated, never accidentally free)
    autoReserve: false,
    autoAddBot: false,
    autoUpdateTp: false,
    autoPauseMinKc: false,
    autoTiming: false,
  };
}

function _allFeatures(on) {
  return {
    telegram: on,
    autoReserve: on,
    cbv5: on,
    safeTrade: on,
    cb: on,
    telegramLogin: on,
    autoAddBot: on,
    autoUpdateTp: on,
    autoPauseMinKc: on,
    chartMonitor: on,
    dps: on,
    configBackup: on,
    autoTiming: on,
  };
}

/**
 * Synchronous feature check. Use for hot paths (every BUY) where an await would
 * add latency. Reads licenseGate.lastLicense directly (no async work).
 * Returns false if no valid license (defensive default).
 */
function isFeatureEnabled(featureName) {
  const features = _getFeatures();
  return features[featureName] === true;
}

/**
 * Returns the max total USDT this license allows across all bots+machines.
 *   - 0   → "unlimited" (admin signals "no cap" by leaving maxCapital at 0)
 *   - >0  → capped at this value
 *   - Infinity → unlimited (same as 0, kept for legacy callers)
 *
 * FIX-2026-08-28 Phase 3b-5 D5: unlimited is signaled by `maxCapital === 0` regardless of tier name.
 *   The previous rule (`lic.tier === 'enterprise'`) was tier-name coupled and silently blocked
 *   every BUY on any tier with `maxCapital: 0` (notably `free+` trials, where the admin UI
 *   already renders 0 as `∞ unlimited`). Tier names are now admin-editable data in the
 *   TierTemplate collection, so the bot must not hardcode any of them. "Block this customer"
 *   = revoke the license, not `maxCapital: 0`.
 */
function getMaxCapital() {
  const lic = _getLicense();
  if (!lic) return 0; // no license → no capital
  const v = Number(lic.maxCapital);
  if (!Number.isFinite(v) || v <= 0) {
    // 0 / null / absent / NaN / negative = unlimited for every tier.
    return Infinity;
  }
  return v;
}

/**
 * Synchronous check: would adding `additionalUsdt` push total deployment over cap?
 * Returns true if allowed, false if over limit.
 * `additionalUsdt` is the size of the next BUY (one trade).
 */
function withinMaxCapital(additionalUsdt) {
  const cap = getMaxCapital();
  if (cap === Infinity) return true;
  const total = getTotalDeployedUsdtCached();
  return (total + Math.max(0, Number(additionalUsdt) || 0)) <= cap;
}

/**
 * Aggregate deployed capital across all enabled, non-deleted bots.
 * Formula: sum(capitalPerTrade * maxTrades) over { deletedAt: null, enabled: true }.
 *   - Cached 30s (TOTAL_DEPLOYED_CACHE_MS) — safe for BUY hot path.
 *   - Returns 0 on query failure (fail-OPEN for capital — bot keeps trading).
 *     Fail-closed for capital would lock every bot out on transient DB blips.
 *   - Excludes bots currently paused (pausedAt !== null) — those aren't risking capital.
 */
async function getTotalDeployedUsdt() {
  const now = Date.now();
  if ((now - _totalDeployedCache.at) < TOTAL_DEPLOYED_CACHE_MS) {
    return _totalDeployedCache.value;
  }
  try {
    const bots = await Bot.find(
      { deletedAt: null, enabled: true, pausedAt: null },
      'capitalPerTrade maxTrades'
    ).lean();
    let total = 0;
    for (const b of bots) {
      const cpt = Math.max(0, Number(b.capitalPerTrade) || 0);
      const mx = Math.max(0, Number(b.maxTrades) || 0);
      total += cpt * mx;
    }
    _totalDeployedCache.value = total;
    _totalDeployedCache.at = now;
    return total;
  } catch (err) {
    logger.warn({ err: err.message }, 'licenseService: getTotalDeployedUsdt query failed, treating as 0 (fail-open)');
    return 0;
  }
}

/**
 * Synchronous wrapper — returns the cached value (or 0 if cache cold).
 * Caller can await `getTotalDeployedUsdt()` first to warm the cache if needed.
 */
function getTotalDeployedUsdtCached() {
  if ((Date.now() - _totalDeployedCache.at) < TOTAL_DEPLOYED_CACHE_MS) {
    return _totalDeployedCache.value;
  }
  return 0;
}

/**
 * Invalidate the deployed-capital cache. Call after Bot CRUD that changes
 * capitalPerTrade/maxTrades/enabled/deletedAt (insert/update/delete/enable/disable).
 * Wired in `botManager.enableBot/disableBot/createBot/updateBot` + Bot routes.
 */
function invalidateDeployedCache() {
  _totalDeployedCache.at = 0;
}

/**
 * Snapshot for snapshot/admin dashboard + tests.
 * Returns { tier, maxCapital, totalDeployedUsdt, withinMaxCapital, features }.
 */
async function snapshot({ additionalUsdt = 0 } = {}) {
  // Warm cache if cold (so withinMaxCapital uses fresh value)
  const total = await getTotalDeployedUsdt();
  return {
    tier: getTier(),
    maxCapital: getMaxCapital(),
    totalDeployedUsdt: total,
    withinMaxCapital: withinMaxCapital(additionalUsdt),
    features: _getFeatures(),
    hasLicense: !!_getLicense(),
  };
}

/**
 * Synchronous tier access — reads licenseGate.lastLicense.tier directly.
 * Returns string ('basic' | 'pro' | 'enterprise') or null if no license.
 * Used by hot paths (e.g. POST /api/bots → buildBotCreatePayload) where
 * awaiting an async snapshot() would add latency to every bot creation.
 */
function getTier() {
  const lic = _getLicense();
  if (!lic || !lic.tier) return null;
  return lic.tier;
}

module.exports = {
  isFeatureEnabled,
  getMaxCapital,
  getTier,
  getTotalDeployedUsdt,
  getTotalDeployedUsdtCached,
  withinMaxCapital,
  invalidateDeployedCache,
  snapshot,
};