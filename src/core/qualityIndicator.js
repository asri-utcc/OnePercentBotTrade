'use strict';

// FIX-2026-08-01: Bot Quality Indicator (0–4 score per bot)
//   - 4 criteria: Volume / Top50 / Squeeze / Trend (1 pt each)
//   - Shared top-N cache (single Binance weight-80 call per refresh interval)
//   - Per-bot cache (5 min TTL) — mirrors src/core/volatilityForBot.js pattern
//   - Settings live in AppConfig.qualityEnabled / qualityRefreshMs / qualityThresholds
//   - score → color:
//       0  = red
//       1  = orange
//       2  = yellow
//       3+ = green
//   - ใช้โดย bot.routes.js (GET / enrichment + GET /:id/quality endpoint)

const binanceRest = require('../binance/binanceRest');
const indicators = require('./indicators');
const volatilityScanner = require('./volatilityScanner');
const AppConfig = require('../db/models/AppConfig');
const { mapWithConcurrency } = require('./volatilityForBot');
const logger = require('../utils/logger');

// FIX-2026-08-01: per-bot cache TTL — 5 นาที (เท่ากับ top50 refresh) — match qualityIndicator.refreshMs default
const PER_BOT_CACHE_TTL_MS = 5 * 60 * 1000;

// top50 cache (shared ทุก bot)
let top50Cache = {
  at: 0,
  symbols: new Set(),
  rankMap: new Map(),
  totalSymbols: 0,
  lastRefreshError: null,
};

// per-bot cache: key = `${SYMBOL}|${TF}` → { at, value }
const perBotCache = new Map();

// active refresh timer
let refreshTimer = null;

// current config (synced from AppConfig on startup + reloadConfig)
let currentConfig = {
  enabled: true,
  refreshMs: 5 * 60 * 1000,
  thresholds: {
    volumeMinUSDT: 100_000,
    topN: 50,
    kcTightPct: 1.0,
    squeezeMinPct: 40,
    trendMinPct: 50,
  },
};

// ─── Defaults / merge ────────────────────────────────────────────────────

function mergeThresholds(loaded) {
  const t = loaded || {};
  const out = { ...currentConfig.thresholds };
  if (Number.isFinite(t.volumeMinUSDT)) out.volumeMinUSDT = Math.max(0, t.volumeMinUSDT);
  if (Number.isFinite(t.topN)) out.topN = Math.max(1, Math.min(500, t.topN));
  if (Number.isFinite(t.kcTightPct)) out.kcTightPct = Math.max(0.01, Math.min(50, t.kcTightPct));
  if (Number.isFinite(t.squeezeMinPct)) out.squeezeMinPct = Math.max(0, Math.min(100, t.squeezeMinPct));
  if (Number.isFinite(t.trendMinPct)) out.trendMinPct = Math.max(0, Math.min(100, t.trendMinPct));
  return out;
}

async function loadConfigFromDb() {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (!cfg) return;
    // default true when undefined (mirror schema default)
    if (typeof cfg.qualityEnabled === 'boolean') currentConfig.enabled = cfg.qualityEnabled;
    else currentConfig.enabled = true;
    if (Number.isFinite(cfg.qualityRefreshMs)) {
      currentConfig.refreshMs = Math.max(60_000, Math.min(60 * 60 * 1000, cfg.qualityRefreshMs));
    }
    if (cfg.qualityThresholds && typeof cfg.qualityThresholds === 'object') {
      currentConfig.thresholds = mergeThresholds(cfg.qualityThresholds);
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'qualityIndicator: loadConfigFromDb failed (using defaults)');
  }
}

// ─── Color tier ──────────────────────────────────────────────────────────

function colorFor(score) {
  if (score == null || !Number.isFinite(score) || score < 0) return 'gray';
  if (score === 0) return 'red';
  if (score === 1) return 'orange';
  if (score === 2) return 'yellow';
  return 'green'; // 3 or 4
}

// ─── Shared Top-N cache ──────────────────────────────────────────────────

async function refreshTop50(force = false) {
  const now = Date.now();
  if (!force && (now - top50Cache.at) < currentConfig.refreshMs && top50Cache.at > 0) {
    return; // cache fresh
  }
  const topN = currentConfig.thresholds.topN;
  try {
    const tickers = await binanceRest.get24hrTickers(); // weight 80
    if (!Array.isArray(tickers)) {
      throw new Error('get24hrTickers did not return array');
    }
    // USDT pairs only (mirror volatilityScanner) — exclude leveraged tokens
    const LEVERAGED_PREFIX = /^(UP|DOWN|BULL|BEAR)[A-Z0-9]+USDT$/;
    const list = tickers
      .filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT') && !LEVERAGED_PREFIX.test(t.symbol))
      .map((t) => ({ symbol: t.symbol, qv: parseFloat(t.quoteVolume) }))
      .filter((t) => Number.isFinite(t.qv))
      .sort((a, b) => b.qv - a.qv);
    const sliced = list.slice(0, topN);
    const symbols = new Set(sliced.map((t) => t.symbol));
    const rankMap = new Map();
    sliced.forEach((t, idx) => rankMap.set(t.symbol, idx + 1));
    top50Cache = {
      at: now,
      symbols,
      rankMap,
      totalSymbols: list.length,
      lastRefreshError: null,
    };
    logger.info({ topN: symbols.size, totalUSDTSymbols: list.length }, 'qualityIndicator: top-N refreshed');
  } catch (err) {
    top50Cache.lastRefreshError = err.message;
    logger.warn({ err: err.message }, 'qualityIndicator: top-N refresh failed — keeping stale cache');
    // bump at เพื่อให้ retry ใน tick หน้า (ไม่ retry ซ้อนทุก call)
    if (top50Cache.at === 0) top50Cache.at = now;
  }
}

// ─── Per-bot criterion computations ──────────────────────────────────────

async function computeVolume(bot) {
  const t = await binanceRest.get24hrTickers({ symbol: bot.symbol }); // weight 2
  const arr = Array.isArray(t) ? t : (t ? [t] : []);
  const row = arr[0] || {};
  const v = parseFloat(row.quoteVolume);
  const value = Number.isFinite(v) ? v : null;
  const threshold = currentConfig.thresholds.volumeMinUSDT;
  return {
    value,
    threshold,
    pass: value != null && value >= threshold,
  };
}

async function computeTop50(bot) {
  // ensure shared cache is fresh (no-op if within TTL)
  if (Date.now() - top50Cache.at >= currentConfig.refreshMs) {
    await refreshTop50();
  }
  const rank = top50Cache.rankMap.get(String(bot.symbol).toUpperCase()) || null;
  return {
    value: rank,
    threshold: top50Cache.symbols.size || currentConfig.thresholds.topN,
    pass: rank != null,
    totalSymbols: top50Cache.totalSymbols,
  };
}

async function computeSqueeze(bot) {
  // need 20 bars for KC warmup + 50 for tail
  const raw = await binanceRest.getKlines({
    symbol: bot.symbol,
    interval: bot.timeframe,
    limit: 70,
  });
  if (!Array.isArray(raw) || raw.length < 20) {
    return { value: null, threshold: currentConfig.thresholds.squeezeMinPct, pass: false, kcTightPct: currentConfig.thresholds.kcTightPct, reason: 'insufficient_klines' };
  }
  const highs = raw.map((k) => parseFloat(k[2]));
  const lows = raw.map((k) => parseFloat(k[3]));
  const closes = raw.map((k) => parseFloat(k[4]));
  const kcMult = bot.kcMult || 1.5;
  const kc = indicators.keltnerChannel(highs, lows, closes, 20, kcMult);
  const tail = kc.width.slice(-50).filter((w) => w != null && Number.isFinite(w));
  if (tail.length < 5) {
    return { value: null, threshold: currentConfig.thresholds.squeezeMinPct, pass: false, kcTightPct: currentConfig.thresholds.kcTightPct, reason: 'kc_warmup' };
  }
  const tight = tail.filter((w) => w < currentConfig.thresholds.kcTightPct).length;
  const pct = (tight / tail.length) * 100;
  return {
    value: pct,
    threshold: currentConfig.thresholds.squeezeMinPct,
    pass: pct >= currentConfig.thresholds.squeezeMinPct,
    kcTightPct: currentConfig.thresholds.kcTightPct,
    samples: tail.length,
  };
}

async function computeTrend(bot) {
  const trendTF = volatilityScanner.TREND_TF_MAP[bot.timeframe] || null;
  if (!trendTF || trendTF === bot.timeframe) {
    // 1M (or unknown TF) → can't get a higher TF
    return {
      value: null,
      threshold: currentConfig.thresholds.trendMinPct,
      pass: false,
      trendTF,
      trendState: 'unknown',
      reason: 'no_upper_tf',
    };
  }
  const raw = await binanceRest.getKlines({
    symbol: bot.symbol,
    interval: trendTF,
    limit: 70,
  });
  if (!Array.isArray(raw) || raw.length < 20) {
    return {
      value: null,
      threshold: currentConfig.thresholds.trendMinPct,
      pass: false,
      trendTF,
      trendState: 'warmup',
      reason: 'insufficient_klines',
    };
  }
  const trendKlines = raw.map((k) => ({
    openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    closeTime: k[6],
  }));
  const trend = volatilityScanner.computeTrend(trendKlines, trendTF);
  if (trend.trendState !== 'upper') {
    return {
      value: 0,
      threshold: currentConfig.thresholds.trendMinPct,
      pass: false,
      trendTF,
      trendState: trend.trendState,
      trendGapPct: trend.trendGapPct,
    };
  }
  // count % bars in last 50 above EMA20
  const closes = trendKlines.map((k) => k.close);
  const emaArr = indicators.ema(closes, 20);
  const tail = closes.slice(-50);
  const emaTail = emaArr.slice(-50);
  let above = 0;
  let counted = 0;
  for (let i = 0; i < tail.length; i += 1) {
    const e = emaTail[i];
    if (e != null && Number.isFinite(e)) {
      counted += 1;
      if (tail[i] >= e) above += 1;
    }
  }
  const pct = counted > 0 ? (above / counted) * 100 : 0;
  return {
    value: pct,
    threshold: currentConfig.thresholds.trendMinPct,
    pass: pct >= currentConfig.thresholds.trendMinPct,
    trendTF,
    trendState: trend.trendState,
    trendGapPct: trend.trendGapPct,
    samples: counted,
  };
}

// ─── Per-bot aggregate ───────────────────────────────────────────────────

function perBotCacheKey(symbol, timeframe) {
  return `${String(symbol || '').toUpperCase()}|${timeframe}`;
}

async function computeBotQuality(bot) {
  if (!currentConfig.enabled) {
    return { enabled: false, score: null, color: 'gray', updatedAt: null, cached: false, breakdown: null };
  }
  const key = perBotCacheKey(bot.symbol, bot.timeframe);
  const now = Date.now();
  const cached = perBotCache.get(key);
  if (cached && (now - cached.at) < PER_BOT_CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  // run 4 criteria in parallel; ignore individual failures (record pass=false)
  const [volume, top50, squeeze, trend] = await Promise.all([
    computeVolume(bot).catch((err) => ({ value: null, threshold: null, pass: false, error: err.message })),
    computeTop50(bot).catch((err) => ({ value: null, threshold: null, pass: false, error: err.message })),
    computeSqueeze(bot).catch((err) => ({ value: null, threshold: null, pass: false, error: err.message })),
    computeTrend(bot).catch((err) => ({ value: null, threshold: null, pass: false, error: err.message })),
  ]);

  const score = (volume.pass ? 1 : 0) + (top50.pass ? 1 : 0) + (squeeze.pass ? 1 : 0) + (trend.pass ? 1 : 0);
  const value = {
    enabled: true,
    score,
    color: colorFor(score),
    updatedAt: now,
    cached: false,
    breakdown: { volume, top50, squeeze, trend },
  };
  perBotCache.set(key, { at: now, value });
  return value;
}

// FIX-2026-08-02: return cached value only (no compute) — used by /api/bots default load
//   - skips 5s Binance cold cache hit on first paint
//   - returns null if cache cold → frontend pill shows "—" until cache warms
function getCachedOnly(bot) {
  if (!currentConfig.enabled) {
    return { enabled: false, score: null, color: 'gray', updatedAt: null, cached: false };
  }
  const key = perBotCacheKey(bot.symbol, bot.timeframe);
  const cached = perBotCache.get(key);
  if (cached && (Date.now() - cached.at) < PER_BOT_CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }
  return null;
}

async function computeBotsQuality(botsList) {
  return mapWithConcurrency(botsList, 6, (b) => computeBotQuality(b));
}

// ─── Cache management ────────────────────────────────────────────────────

function invalidate(symbol, timeframe) {
  const key = perBotCacheKey(symbol, timeframe);
  perBotCache.delete(key);
}

function reloadConfig() {
  perBotCache.clear();
  top50Cache = {
    at: 0,
    symbols: new Set(),
    rankMap: new Map(),
    totalSymbols: 0,
    lastRefreshError: null,
  };
  // restart refresh loop with potentially-new interval
  return loadConfigFromDb().then(() => {
    startRefreshLoop();
    logger.info({ refreshMs: currentConfig.refreshMs, thresholds: currentConfig.thresholds, enabled: currentConfig.enabled }, 'qualityIndicator: config reloaded');
  });
}

function startRefreshLoop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (!currentConfig.enabled) {
    logger.info('qualityIndicator: disabled — refresh loop NOT started');
    return;
  }
  refreshTimer = setInterval(() => {
    refreshTop50(true).catch((err) => logger.warn({ err: err.message }, 'qualityIndicator: tick refresh failed'));
  }, currentConfig.refreshMs);
  // .unref() so it doesn't keep node alive in tests / shutdown
  if (refreshTimer && typeof refreshTimer.unref === 'function') refreshTimer.unref();
  logger.info({ refreshMs: currentConfig.refreshMs }, 'qualityIndicator: refresh loop started');
}

function _resetCache() {
  perBotCache.clear();
  top50Cache = {
    at: 0,
    symbols: new Set(),
    rankMap: new Map(),
    totalSymbols: 0,
    lastRefreshError: null,
  };
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// Public init — call once at server start (bot.routes.js module-load)
async function init() {
  await loadConfigFromDb();
  startRefreshLoop();
}

module.exports = {
  init,
  computeBotQuality,
  computeBotsQuality,
  getCachedOnly, // FIX-2026-08-02: cached-only read for /api/bots default load
  refreshTop50,
  invalidate,
  reloadConfig,
  startRefreshLoop,
  colorFor,
  _resetCache,
  PER_BOT_CACHE_TTL_MS,
  // for testing/diagnostics
  _getConfig: () => ({ ...currentConfig, thresholds: { ...currentConfig.thresholds } }),
  _getTop50Cache: () => ({ at: top50Cache.at, size: top50Cache.symbols.size, totalSymbols: top50Cache.totalSymbols, error: top50Cache.lastRefreshError }),
  _getPerBotCacheSize: () => perBotCache.size,
};
