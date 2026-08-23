'use strict';

// FIX-2026-08-03: Safe-trade filter #2 (LuxAlgo red pivot-low trendline) — live status module
//   - mirror volatilityForBot pattern: per-bot 60s cache + concurrency-controlled batch scan
//   - returns current ST#2 status so UI can show 📐 ✅/❌/⏳ badge on bot card
//   - **read-only** — does NOT trigger any BUY/SELL; the trader.js path is the only place that blocks
//   - import-only `signalEngine.computeTrendlinePivotLows` (pure function) — no circular import risk
//     (signalEngine is a leaf module; we don't import it from volatilityScanner)

const binanceRest = require('../binance/binanceRest');
const signalEngine = require('./signalEngine');
const volatilityScanner = require('./volatilityScanner');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 60 * 1000; // 60s — mirror volatilityForBot cache TTL
const cache = new Map();

function cacheKey(symbol, timeframe) {
  return `${String(symbol || '').toUpperCase()}|${timeframe}`;
}

// FIX-2026-08-03: build a status object that the UI can render directly
//   - status ∈ 'disabled' | 'no_trend_tf' | 'warmup' | 'insufficient_data' | 'api_error' | 'pass' | 'blocked'
//   - when filter is OFF (safeTradeTrendlineEnabled !== true), return {status: 'disabled'} — no Binance fetch
function emptyStatus(status, extras = {}) {
  return {
    ok: status === 'pass' || status === 'blocked',
    status,
    trendTF: null,
    lastClose: null,
    trendlineValue: null,
    gapPct: null,
    pivotCount: 0,
    updatedAt: Date.now(),
    ms: 0,
    cached: false,
    ...extras,
  };
}

// FIX-2026-08-03: compute ST#2 status for one bot
//   - skip work entirely if filter is disabled or trendTF not mapped
//   - Binance error → status='api_error' (matches signalEngine fail-open semantics)
//   - **does not throw** — always returns a status object
async function computeBotTrendlineSnapshot(bot) {
  const start = Date.now();
  const symbol = String(bot.symbol || '').toUpperCase();
  const timeframe = bot.timeframe;

  // Filter disabled — never call Binance
  if (bot.safeTradeTrendlineEnabled !== true) {
    return emptyStatus('disabled', { ms: Date.now() - start });
  }

  const trendTF = volatilityScanner.TREND_TF_MAP && volatilityScanner.TREND_TF_MAP[timeframe];
  if (!trendTF) {
    return emptyStatus('no_trend_tf', { ms: Date.now() - start });
  }

  // Cache hit
  const key = cacheKey(symbol, timeframe);
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
    return { ...cached.value, cached: true, ms: Date.now() - start };
  }

  // Fetch upper-TF klines — same source as trader.js
  let raw;
  try {
    raw = await binanceRest.getKlines({ symbol, interval: trendTF, limit: 200 });
  } catch (err) {
    logger.warn({ symbol, timeframe, trendTF, err: err.message }, 'trendlineForBot: getKlines failed');
    const value = emptyStatus('api_error', { trendTF, error: err.message, ms: Date.now() - start });
    cache.set(key, { at: Date.now(), value });
    return value;
  }
  if (!Array.isArray(raw) || raw.length < 50) {
    const value = emptyStatus('insufficient_data', { trendTF, ms: Date.now() - start });
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  // Binance raw tuple → object kline (matches live klineCache format)
  const klines = raw.map((k) => ({
    openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), closeTime: k[6],
  }));
  const trendline = signalEngine.computeTrendlinePivotLows(klines);
  const lastIdx = klines.length - 1;
  const trendlineValue = trendline ? trendline[lastIdx] : null;

  // Warmup — no pivot yet OR trendline invalid
  if (trendlineValue == null || !Number.isFinite(trendlineValue)) {
    const value = emptyStatus('warmup', {
      trendTF,
      pivotCount: trendline ? trendline.filter((v) => v != null).length : 0,
      ms: Date.now() - start,
    });
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  const lastClose = klines[lastIdx].close;
  const pass = lastClose > trendlineValue;
  const gapPct = ((lastClose - trendlineValue) / trendlineValue) * 100;
  const value = {
    ok: true,
    status: pass ? 'pass' : 'blocked',
    trendTF,
    lastClose,
    trendlineValue,
    gapPct,
    pivotCount: trendline.filter((v) => v != null).length,
    updatedAt: Date.now(),
    ms: Date.now() - start,
    cached: false,
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

// FIX-2026-08-03: concurrency-controlled batch scan (mirror volatilityForBot.mapWithConcurrency)
async function mapWithConcurrency(items, limit, mapper) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      try {
        out[idx] = await mapper(items[idx], idx);
      } catch (err) {
        out[idx] = { error: err.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// FIX-2026-08-03: manual cache invalidation (e.g., after timeframe change in Master Config)
function invalidate(symbol, timeframe) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${String(symbol || '').toUpperCase()}|${timeframe}|`)) cache.delete(key);
  }
}

function _resetCache() {
  cache.clear();
}

module.exports = {
  computeBotTrendlineSnapshot,
  mapWithConcurrency,
  invalidate,
  CACHE_TTL_MS,
  _resetCache,
};
