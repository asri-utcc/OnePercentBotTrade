'use strict';

/**
 * FIX-2026-08-12 (audit Q9): Master CBv5 toggle helper.
 *   - CBv5 was originally "independent of cbVersion" — but user contract violation
 *     because no master switch existed (only per-bot cbv5Enabled).
 *   - masterCbv5Enabled() is the single source of truth for "should CBv5 run anywhere?".
 *   - Returns false ONLY when AppConfig.cbv5MasterEnabled === false.
 *   - Per-bot cbv5Enabled check is separate — caller must check both.
 *   - Cache 30s (AppConfig.doesn't change often — mirror cbVersion).
 *   - Both trader (kline:closed + pre-BUY) and watchdog (Phase 5 + skip helper)
 *     call this so they agree on the gate.
 */

const AppConfig = require('../db/models/AppConfig');
const logger = require('../utils/logger');

const CACHE_MS = 30 * 1000; // 30s
const _cached = { value: true, at: 0 };

async function isMasterCbv5Enabled() {
  const now = Date.now();
  if ((now - _cached.at) < CACHE_MS) return _cached.value;
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    // Default = true (when field missing on old DB rows)
    const v = cfg && cfg.cbv5MasterEnabled === false ? false : true;
    _cached.value = v;
    _cached.at = now;
    return v;
  } catch (err) {
    logger.warn({ err: err.message }, 'cbv5MasterToggle: AppConfig read failed, fallback to true (master ON)');
    return true;
  }
}

function invalidateCache() {
  _cached.value = true;
  _cached.at = 0;
}

// FIX-2026-08-12 (audit Q9): synchronous cached value for pure-function skip helpers
//   - _cbv5SkipReason is a pure static function (no async) — needs sync read
//   - Returns true on cache miss (safe default: master ON)
//   - Used by positionWatchdog._cbv5SkipReason
function isMasterCbv5EnabledCached() {
  return _cached.value;
}

module.exports = {
  isMasterCbv5Enabled,
  isMasterCbv5EnabledCached,
  invalidateCache,
};
