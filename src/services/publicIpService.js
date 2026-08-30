'use strict';

/**
 * FIX-2026-08-31: Public IP detection
 *
 *   Periodically (re)fetch this bot's public IP from api.ipify.org.
 *   Used in heartbeat payload so admin can show "📡 {publicIp}:{port}" link
 *   operator can use to open the bot's login page from outside the LAN.
 *
 *   - Cached 24h — no point hammering ipify
 *   - Graceful failure: returns null on network errors / timeouts (the bot
 *     can run offline / behind firewalls where this is expected)
 *   - Uses Node 18+ built-in fetch (no new dependency)
 */

const config = require('../../config');
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'services/publicIp' }) : rootLogger;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 5000;
const IPIFY_URL = process.env.PUBLIC_IP_URL || 'https://api.ipify.org?format=json';

let _cache = { ip: null, fetchedAt: 0, inFlight: null };

function _isCacheValid() {
  return _cache.ip && (Date.now() - _cache.fetchedAt) < CACHE_TTL_MS;
}

/**
 * Returns this bot's public IP, or null if unknown / fetch failed.
 * Uses cache unless stale; concurrent callers share a single in-flight fetch.
 */
async function getPublicIp({ forceRefresh = false } = {}) {
  if (forceRefresh) {
    _cache = { ip: null, fetchedAt: 0, inFlight: null };
  }
  if (!forceRefresh && _isCacheValid()) {
    return _cache.ip;
  }
  if (_cache.inFlight) {
    return _cache.inFlight;
  }
  _cache.inFlight = _fetchOnce()
    .then((ip) => {
      _cache.ip = ip;
      _cache.fetchedAt = Date.now();
      return ip;
    })
    .catch((err) => {
      logger.warn({ err: err.message }, 'publicIpService: fetch failed (returning null)');
      return null;
    })
    .finally(() => {
      _cache.inFlight = null;
    });
  return _cache.inFlight;
}

async function _fetchOnce() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(IPIFY_URL, { signal: ctl.signal });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const json = await res.json();
    const ip = typeof json?.ip === 'string' ? json.ip.trim() : '';
    // Light validation — IPv4 dotted-quad or IPv6 hextets. Anything else → reject.
    if (!ip || !/^[0-9a-fA-F:.]+$/.test(ip) || ip.length > 64) {
      throw new Error(`invalid ip string: ${ip.slice(0, 32)}`);
    }
    return ip;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reset cache (for tests). Not part of the production surface.
 */
function _resetCache() {
  _cache = { ip: null, fetchedAt: 0, inFlight: null };
}

module.exports = {
  getPublicIp,
  _resetCache,
  _CACHE_TTL_MS: CACHE_TTL_MS,
};
