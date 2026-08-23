'use strict';

const tpUpdater = require('./tpUpdater');
const binanceRest = require('../binance/binanceRest');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 60 * 1000;

const cache = new Map();

function cacheKey(symbol, timeframe, suggestTpWindow) {
  return `${String(symbol || '').toUpperCase()}|${timeframe}|${suggestTpWindow}`;
}

function format24hVolume(v) {
  if (v == null || !Number.isFinite(v)) return null;
  const n = Number(v);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

function formatKcMinPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  // FIX 2026-07-31: kcMinPct จาก tpUpdater.computeSuggestedTpForBot เป็น **percent** อยู่แล้ว
  //   indicators.keltnerChannel().width = ((u-l)/close) * 100  → "1.23" = 1.23%
  //   ไม่ต้อง *100 อีก (เก่าแสดง "123.00%" ผิด)
  return `${Number(pct).toFixed(2)}%`;
}

async function computeBotVolatilitySnapshot(bot) {
  const start = Date.now();
  const symbol = String(bot.symbol || '').toUpperCase();
  const timeframe = bot.timeframe;
  const suggestTpWindow = bot.suggestTpWindow || 500;
  const key = cacheKey(symbol, timeframe, suggestTpWindow);

  const cached = cache.get(key);
  if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
    return { ...cached.value, cached: true, ms: Date.now() - start };
  }

  let tp;
  try {
    tp = await tpUpdater.computeSuggestedTpForBot(bot);
  } catch (err) {
    logger.warn({ botId: String(bot._id || ''), symbol, tf: timeframe, err: err.message }, 'volatilityForBot: computeSuggestedTpForBot failed');
    return {
      ok: false,
      error: err.message,
      kcMinPct: null,
      kcMinPctDisplay: null,
      suggestedTpPct: null,
      trendState: null,
      trendTF: null,
      tpOverridden: false,
      rawSuggestedTpPct: null,
      feeBufferPct: null,
      quoteVolume24h: null,
      quoteVolume24hDisplay: null,
      ms: Date.now() - start,
      cached: false,
    };
  }

  let quoteVolume24h = null;
  try {
    const t24 = await binanceRest.get24hrTickers({ symbol });
    if (t24) {
      const t = Array.isArray(t24) ? t24[0] : t24;
      const v = parseFloat(t && t.quoteVolume);
      if (Number.isFinite(v)) quoteVolume24h = v;
    }
  } catch (err) {
    logger.warn({ symbol, err: err.message }, 'volatilityForBot: get24hrTickers failed');
  }

  const value = {
    ok: tp && !tp.error,
    error: tp && tp.error,
    kcMinPct: tp && Number.isFinite(tp.kcMinPct) ? tp.kcMinPct : null,
    kcMinPctDisplay: tp && Number.isFinite(tp.kcMinPct) ? formatKcMinPct(tp.kcMinPct) : null,
    suggestedTpPct: tp && tp.suggestedTpPct != null && Number.isFinite(tp.suggestedTpPct) ? tp.suggestedTpPct : null,
    trendState: tp && tp.trendState ? tp.trendState : (tp && tp.error ? null : 'warmup'),
    trendTF: tp && tp.trendTF ? tp.trendTF : null,
    tpOverridden: !!(tp && tp.tpOverridden),
    rawSuggestedTpPct: tp && Number.isFinite(tp.rawSuggestedTpPct) ? tp.rawSuggestedTpPct : null,
    feeBufferPct: tp && Number.isFinite(tp.feeBufferPct) ? tp.feeBufferPct : null,
    quoteVolume24h,
    quoteVolume24hDisplay: quoteVolume24h != null ? format24hVolume(quoteVolume24h) : null,
    ms: Date.now() - start,
    cached: false,
  };

  cache.set(key, { at: Date.now(), value });
  return value;
}

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

function invalidate(symbol, timeframe) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${String(symbol || '').toUpperCase()}|${timeframe}|`)) cache.delete(key);
  }
}

function _resetCache() {
  cache.clear();
}

module.exports = {
  computeBotVolatilitySnapshot,
  mapWithConcurrency,
  invalidate,
  format24hVolume,
  formatKcMinPct,
  CACHE_TTL_MS,
  _resetCache,
};
