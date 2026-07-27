'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

/**
 * FX rate service — USDT → THB
 *
 * Primary: ExchangeRate-API (open.er-api.com) — USD→THB
 *   • 250,000 calls/month free, no key
 *   • https://www.exchangerate-api.com/docs/free
 *   • Example: https://open.er-api.com/v6/latest/USD → { rates: { THB: 33.5 } }
 *
 * Fallback: CoinGecko — actual USDT→THB (slightly different from USD→THB
 *   due to stablecoin P2P spreads; useful when primary is down)
 *   • https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=thb
 *
 * Cache: in-memory with TTL 10 minutes (configurable).
 * Stale-while-revalidate: if cache is stale but present, return it immediately
 *   and refresh in the background; this prevents UI from flashing 503s.
 */

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REFRESH_TIMEOUT_MS = 8000;

let cache = {
  rate: null,         // number (e.g. 33.28)
  source: null,       // 'exchangerate-api' | 'coingecko'
  fetchedAt: 0,       // ms epoch
  stale: false,       // true when past TTL but still serving
};

let inFlight = null;  // dedupe parallel refreshes

function _ageSec() {
  return cache.fetchedAt ? Math.floor((Date.now() - cache.fetchedAt) / 1000) : null;
}

async function _fetchFromExchangeRateApi() {
  const resp = await axios.get('https://open.er-api.com/v6/latest/USD', {
    timeout: REFRESH_TIMEOUT_MS,
    headers: { 'User-Agent': 'OnePercentBotTrade/1.0' },
  });
  if (resp.status !== 200 || !resp.data || resp.data.result !== 'success') {
    throw new Error(`exchangerate-api: bad response ${resp.status}`);
  }
  const rate = resp.data.rates && resp.data.rates.THB;
  if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) {
    throw new Error('exchangerate-api: missing or invalid THB rate');
  }
  return { rate, source: 'exchangerate-api' };
}

async function _fetchFromCoinGecko() {
  const resp = await axios.get(
    'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=thb',
    {
      timeout: REFRESH_TIMEOUT_MS,
      headers: { 'User-Agent': 'OnePercentBotTrade/1.0' },
    }
  );
  if (resp.status !== 200 || !resp.data || !resp.data.tether || typeof resp.data.tether.thb !== 'number') {
    throw new Error(`coingecko: bad response ${resp.status}`);
  }
  const rate = resp.data.tether.thb;
  if (!isFinite(rate) || rate <= 0) {
    throw new Error('coingecko: missing or invalid THB rate');
  }
  return { rate, source: 'coingecko' };
}

async function _refresh() {
  // Try primary → fallback
  try {
    const v = await _fetchFromExchangeRateApi();
    cache = { rate: v.rate, source: v.source, fetchedAt: Date.now(), stale: false };
    logger.info({ rate: v.rate, source: v.source }, 'fx: USDT/THB refreshed');
    return cache;
  } catch (primaryErr) {
    logger.warn({ err: primaryErr.message }, 'fx: primary (exchangerate-api) failed, trying fallback');
    try {
      const v = await _fetchFromCoinGecko();
      cache = { rate: v.rate, source: v.source, fetchedAt: Date.now(), stale: false };
      logger.info({ rate: v.rate, source: v.source }, 'fx: USDT/THB refreshed (fallback)');
      return cache;
    } catch (fallbackErr) {
      logger.error(
        { primaryErr: primaryErr.message, fallbackErr: fallbackErr.message },
        'fx: both sources failed'
      );
      throw new Error(`both FX sources failed (primary: ${primaryErr.message}, fallback: ${fallbackErr.message})`);
    }
  }
}

/**
 * Get current USDT→THB rate.
 *
 * - Returns a usable rate immediately when cache is fresh (< CACHE_TTL_MS).
 * - Triggers background refresh when cache is stale but still present.
 * - Triggers foreground refresh when cache is empty.
 *
 * @returns {Promise<{rate: number, source: string, fetchedAt: number, stale: boolean, ageSec: number}>}
 *          Always resolves with a valid (non-null) rate when any source ever succeeded.
 *          Rejects only if cache is empty AND both sources fail.
 */
async function getUsdtToThb({ forceRefresh = false } = {}) {
  const now = Date.now();
  const fresh = cache.rate != null && (now - cache.fetchedAt) < CACHE_TTL_MS;

  if (!forceRefresh && fresh) {
    return { ...cache, ageSec: _ageSec() };
  }

  // If we have a stale cache and someone is already refreshing, return the stale value
  // and let the in-flight refresh finish in the background.
  if (cache.rate != null && inFlight) {
    if (!fresh) cache.stale = true;
    return { ...cache, ageSec: _ageSec() };
  }

  inFlight = (async () => {
    try {
      await _refresh();
    } catch (err) {
      // If we had a cache, mark it stale (don't lose the data)
      if (cache.rate != null) cache.stale = true;
    } finally {
      inFlight = null;
    }
  })();

  if (cache.rate != null) {
    if (!fresh) cache.stale = true;
    return { ...cache, ageSec: _ageSec() };
  }

  // No cache at all — wait for the refresh to finish (success or fail)
  await inFlight;
  if (cache.rate == null) {
    const err = new Error('FX rate unavailable (no cache, all sources failed)');
    err.status = 503;
    throw err;
  }
  return { ...cache, ageSec: _ageSec() };
}

/**
 * Reset cache (useful for testing only).
 */
function _resetCache() {
  cache = { rate: null, source: null, fetchedAt: 0, stale: false };
}

module.exports = {
  getUsdtToThb,
  _resetCache,
  CACHE_TTL_MS,
};
