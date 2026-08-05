'use strict';

/**
 * 2026-08-05: Prediction helper — compute upper-KC + predicted loss/PnL at upper-KC exit
 *   ใช้ใน position card UI (bots.html Open Positions modal + bot-detail Positions tab) เพื่อแสดง:
 *     - upperKC: เส้น upper Keltner Channel ปัจจุบัน (คาดการณ์จุดขายถ้า SL-on-UKC trigger)
 *     - predictedSellPrice: = upperKC
 *     - predictedLossUsdt/Pct/Thb: ขาดทุนคาดการณ์ถ้าขายที่ upperKC (เครื่องหมาย: ลบ = ขาดทุน, บวก = กำไร)
 *
 * Architecture:
 *   - Primary path: klineCache in-memory (zero Binance weight)
 *   - Fallback path: REST getKlines (1 call per warmup pair, ~weight 2) — for disabled bots / no trader running
 *   - Dedupe by (symbol, timeframe) → compute upperKC ครั้งเดียวต่อคู่ ใช้ร่วมกันหลาย positions
 *   - DCA stacks ใช้ stackBep + stackTotalQty แทน buyPrice + buyQty
 *
 * Functions:
 *   computeUpperKCPrices(items, opts) → Map<key, { upperKC, basisKC, lowerKC, lastClose, kcMult, kcLen, computedAt, warmup, cachedCandles, source }>
 *     items = [{ symbol, timeframe, kcMult? }]
 *     opts = { restFallback: bool, restLimit: number } — defaults { restFallback: true, restLimit: 30 }
 *
 *   computePredictionForTrade(trade, upperKCInfo, usdtToThbRate) → prediction object or null
 */

const klineCache = require('../services/klineCache');
const signalEngine = require('./signalEngine');
const logger = require('../utils/logger');

const KC_LEN = 20; // mirror Pine kcLen (signalEngine default)

function makeKey(symbol, timeframe) {
  return `${String(symbol).toUpperCase()}:${String(timeframe)}`;
}

/**
 * Lazy-load binanceRest (avoid circular deps if any). Returns null on failure.
 */
let _binanceRest = null;
function getBinanceRest() {
  if (_binanceRest) return _binanceRest;
  try {
    _binanceRest = require('../binance/binanceRest');
    return _binanceRest;
  } catch (_) {
    return null;
  }
}

/**
 * Try to fetch klines from REST as a fallback when klineCache is warmup.
 * Used for disabled bots / no trader running.
 */
async function _fetchUpperKCViaRest(symbol, timeframe, kcMult) {
  const rest = getBinanceRest();
  if (!rest || typeof rest.getKlines !== 'function') return null;
  try {
    const klines = await rest.getKlines({ symbol, interval: timeframe, limit: 30 });
    if (!Array.isArray(klines) || klines.length < KC_LEN) return null;

    // Binance REST returns array tuples: [openTime, open, high, low, close, volume, closeTime, ...]
    const closes = klines.map((k) => parseFloat(k[4])).filter((v) => Number.isFinite(v));
    const highs = klines.map((k) => parseFloat(k[2])).filter((v) => Number.isFinite(v));
    const lows = klines.map((k) => parseFloat(k[3])).filter((v) => Number.isFinite(v));

    if (closes.length < KC_LEN) return null;

    const mult = Number(kcMult) || 1.5;
    const { basis, upper, lower } = signalEngine.computeBgStates({
      closes, highs, lows, length: KC_LEN, mult, useTrueRange: true,
    });

    const lastIdx = upper.length - 1;
    return {
      upperKC: Number.isFinite(upper[lastIdx]) ? upper[lastIdx] : null,
      basisKC: Number.isFinite(basis[lastIdx]) ? basis[lastIdx] : null,
      lowerKC: Number.isFinite(lower[lastIdx]) ? lower[lastIdx] : null,
      lastClose: closes[closes.length - 1] || null,
      kcMult: mult,
      kcLen: KC_LEN,
      computedAt: new Date().toISOString(),
      warmup: false,
      cachedCandles: closes.length,
      source: 'binance-rest',
    };
  } catch (err) {
    logger.warn({ symbol, timeframe, err: err.message }, 'prediction: REST fallback failed');
    return null;
  }
}

/**
 * Compute upper-KC for a list of (symbol, timeframe, kcMult) tuples.
 * Returns Map<key, info> where key = `${symbol}:${tf}`.
 * Skips items with <20 cached klines (warmup) — unless restFallback enabled, then fetches via REST.
 *
 * @param {Array<{symbol, timeframe, kcMult?}>} items
 * @param {{restFallback?: boolean, restLimit?: number}} [opts]
 * @returns {Promise<Map<string, object>>} resolves when all entries computed
 */
async function computeUpperKCPrices(items, opts = {}) {
  const restFallback = opts.restFallback !== false; // default true
  const result = new Map();
  if (!Array.isArray(items) || items.length === 0) return result;

  // First pass: fill from klineCache (sync)
  const warmupKeys = [];
  for (const it of items) {
    const symbol = it && it.symbol;
    const timeframe = it && it.timeframe;
    if (!symbol || !timeframe) continue;

    const key = makeKey(symbol, timeframe);
    if (result.has(key)) continue; // dedupe

    const closed = klineCache.getAll(symbol, timeframe);
    const current = klineCache.getCurrent(symbol, timeframe);

    if (!Array.isArray(closed) || closed.length < KC_LEN) {
      warmupKeys.push({ key, symbol, timeframe, kcMult: it.kcMult, currentCandle: current });
      continue;
    }

    const closes = closed.map((c) => Number(c.close));
    const highs = closed.map((c) => Number(c.high));
    const lows = closed.map((c) => Number(c.low));

    if (current && Number(current.close) > 0) {
      closes.push(Number(current.close));
      highs.push(Number(current.high));
      lows.push(Number(current.low));
    }

    const mult = Number(it.kcMult) || 1.5;
    const { basis, upper, lower } = signalEngine.computeBgStates({
      closes, highs, lows, length: KC_LEN, mult, useTrueRange: true,
    });

    const lastIdx = upper.length - 1;
    const upperKC = Number.isFinite(upper[lastIdx]) ? upper[lastIdx] : null;
    const basisKC = Number.isFinite(basis[lastIdx]) ? basis[lastIdx] : null;
    const lowerKC = Number.isFinite(lower[lastIdx]) ? lower[lastIdx] : null;

    result.set(key, {
      upperKC,
      basisKC,
      lowerKC,
      lastClose: closes[closes.length - 1] || null,
      kcMult: mult,
      kcLen: KC_LEN,
      computedAt: new Date().toISOString(),
      warmup: false,
      cachedCandles: closed.length,
      source: 'klineCache',
    });
  }

  // Second pass: REST fallback for warmup keys (only if enabled and there are any)
  if (restFallback && warmupKeys.length > 0) {
    // dedupe by key for REST too
    const seenKeys = new Set();
    const restTasks = [];
    for (const w of warmupKeys) {
      if (seenKeys.has(w.key)) continue;
      seenKeys.add(w.key);
      restTasks.push(_fetchUpperKCViaRest(w.symbol, w.timeframe, w.kcMult).then((info) => ({ ...w, info })));
    }
    const restResults = await Promise.allSettled(restTasks);

    for (let i = 0; i < restResults.length; i += 1) {
      const r = restResults[i];
      if (r.status !== 'fulfilled') continue;
      const w = r.value;
      if (w.info) {
        result.set(w.key, w.info);
      } else {
        // REST also failed → return warmup stub with current candle lastClose if available
        const cur = w.currentCandle;
        result.set(w.key, {
          upperKC: null,
          basisKC: null,
          lowerKC: null,
          lastClose: cur && Number(cur.close) > 0 ? Number(cur.close) : null,
          kcMult: Number(w.kcMult) || 1.5,
          kcLen: KC_LEN,
          computedAt: new Date().toISOString(),
          warmup: true,
          cachedCandles: 0,
          source: 'warmup',
        });
      }
    }
  } else {
    // No REST fallback → fill with warmup stubs
    for (const w of warmupKeys) {
      const cur = w.currentCandle;
      result.set(w.key, {
        upperKC: null,
        basisKC: null,
        lowerKC: null,
        lastClose: cur && Number(cur.close) > 0 ? Number(cur.close) : null,
        kcMult: Number(w.kcMult) || 1.5,
        kcLen: KC_LEN,
        computedAt: new Date().toISOString(),
        warmup: true,
        cachedCandles: 0,
        source: 'warmup',
      });
    }
  }

  return result;
}

/**
 * Compute predicted exit at upper-KC for a single trade (or DCA stack).
 *   - refPrice: stackBep (DCA) or buyPrice (single trade)
 *   - qty: stackTotalQty (DCA) or buyQty (single)
 *
 * Returns null if upperKC unavailable (warmup). Always returns object otherwise
 * with isProfit=true when (upperKC - refPrice) >= 0.
 *
 * @param {object} trade — trade or DCA stack doc (must have buyPrice/buyQty OR stackBep/stackTotalQty + isDcaStack)
 * @param {object} upperKCInfo — result from computeUpperKCPrices
 * @param {number|null} usdtToThbRate — raw USDT→THB rate (e.g. 35.5). null/undefined skips THB computation.
 * @returns {object|null} prediction object or null if trade invalid
 */
function computePredictionForTrade(trade, upperKCInfo, usdtToThbRate) {
  if (!trade) return null;
  const isDcaStack = trade.isDcaStack === true;
  const refPrice = isDcaStack
    ? (Number(trade.stackBep) || 0)
    : (Number(trade.buyPrice) || 0);
  const qty = isDcaStack
    ? (Number(trade.stackTotalQty) || 0)
    : (Number(trade.buyQty) || 0);

  const base = {
    upperKC: null,
    basisKC: null,
    lowerKC: null,
    predictedSellPrice: null,
    predictedLossUsdt: null,
    predictedLossPct: null,
    predictedLossThb: null,
    refPrice,
    qty,
    isDcaStack,
    warmup: true,
    cachedCandles: upperKCInfo && Number.isFinite(upperKCInfo.cachedCandles) ? upperKCInfo.cachedCandles : 0,
  };

  if (!upperKCInfo || upperKCInfo.upperKC == null || !Number.isFinite(upperKCInfo.upperKC)) {
    return base;
  }

  const upperKC = upperKCInfo.upperKC;
  const deltaUsdt = (upperKC - refPrice) * qty;
  const deltaPct = refPrice > 0 ? ((upperKC - refPrice) / refPrice) * 100 : 0;
  const deltaThb = (typeof usdtToThbRate === 'number' && Number.isFinite(usdtToThbRate) && usdtToThbRate > 0)
    ? deltaUsdt * usdtToThbRate
    : null;

  return {
    upperKC,
    basisKC: upperKCInfo.basisKC,
    lowerKC: upperKCInfo.lowerKC,
    predictedSellPrice: upperKC,
    predictedLossUsdt: deltaUsdt, // positive = predicted profit, negative = predicted loss (semantic aligned with realizedPnl)
    predictedLossPct: deltaPct,
    predictedLossThb: Number.isFinite(deltaThb) ? deltaThb : null,
    refPrice,
    qty,
    isDcaStack,
    warmup: false,
  };
}

module.exports = {
  computeUpperKCPrices,
  computePredictionForTrade,
  makeKey,
  KC_LEN,
};
