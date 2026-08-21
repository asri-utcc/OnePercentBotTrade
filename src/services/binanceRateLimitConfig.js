'use strict';

/**
 * FIX-2026-08-21: Binance rate-limit capacity — cached AppConfig reader
 *
 * Background:
 *   Binance enforces an IP-based REQUEST_WEIGHT limit per minute
 *   (6,000 for normal accounts, up to 120,000 for Bot Accounts).
 *   The bot uses a token-bucket in src/binance/binanceRest.js whose
 *   `capacity` was hardcoded to 6,000. When multiple instances
 *   (or even multiple unrelated bots) share the same public IP,
 *   they all draw from the same Binance budget — each instance
 *   should claim only its fair share.
 *
 *   This helper:
 *     1. Reads `AppConfig.binanceRateLimitPerMin` (default 6000)
 *     2. Caches for 30s (avoid hammering Mongo on every API call)
 *     3. Provides invalidateCache() so the PUT handler can refresh
 *        the value AND the live limiter immediately.
 *
 * Pattern mirror: src/core/cbVersion.js (same cache TTL).
 *
 * Usage:
 *   const { getBinanceRateLimit } = require('./services/binanceRateLimitConfig');
 *   const cap = await getBinanceRateLimit();           // number (clamped)
 *   binanceRest.setRateLimitCapacity(cap);              // apply to limiter
 */

const AppConfig = require('../db/models/AppConfig');
const logger = require('../utils/logger');

const CACHE_MS = 30 * 1000; // 30s — matches cbVersion.js
const DEFAULT_VALUE = 6000;
const MIN_VALUE = 500;
const MAX_VALUE = 120000;

let _cached = { value: DEFAULT_VALUE, at: 0 };

function _clamp(v) {
  if (!Number.isFinite(v)) return DEFAULT_VALUE;
  return Math.max(MIN_VALUE, Math.min(MAX_VALUE, Math.round(v)));
}

/**
 * Read current capacity from AppConfig (30s in-process cache).
 * Returns a safe number in [500..120000].
 */
async function getBinanceRateLimit({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && _cached.at && (now - _cached.at) < CACHE_MS) {
    return _cached.value;
  }
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (cfg && Number.isFinite(cfg.binanceRateLimitPerMin)) {
      _cached = { value: _clamp(cfg.binanceRateLimitPerMin), at: now };
      return _cached.value;
    }
    // missing field → use default (legacy DB without FIX-2026-08-21)
    _cached = { value: DEFAULT_VALUE, at: now };
    return DEFAULT_VALUE;
  } catch (err) {
    logger.warn({ err: err.message }, 'binanceRateLimitConfig: read failed, using cache/default');
    return _cached.value || DEFAULT_VALUE;
  }
}

/**
 * Drop the in-process cache so the next getBinanceRateLimit()
 * re-reads from Mongo. Call after PUT /api/admin/rate-limit.
 *
 * @param {number} [newValue] optional — also prime the cache with the new value
 *   to skip a DB round-trip immediately following the write.
 */
function invalidateCache(newValue) {
  if (Number.isFinite(newValue)) {
    _cached = { value: _clamp(newValue), at: Date.now() };
  } else {
    _cached = { value: DEFAULT_VALUE, at: 0 };
  }
}

/**
 * Read the current cache metadata (used by tests + GET endpoint).
 */
function cacheInfo() {
  return { value: _cached.value, at: _cached.at, ageMs: _cached.at ? Date.now() - _cached.at : null };
}

module.exports = {
  DEFAULT_VALUE,
  MIN_VALUE,
  MAX_VALUE,
  CACHE_MS,
  getBinanceRateLimit,
  invalidateCache,
  cacheInfo,
  _clamp,
};
