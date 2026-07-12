'use strict';

const Decimal = require('decimal.js');
const binanceRest = require('./binanceRest');
const logger = require('../utils/logger');

const cache = new Map(); // symbol -> info
let loadingPromises = new Map(); // กัน race ตอนโหลดพร้อมกัน

function pickFilter(symbolInfo, filterType) {
  return (symbolInfo.filters || []).find((f) => f.filterType === filterType);
}

async function loadSymbol(symbol, { force = false } = {}) {
  symbol = symbol.toUpperCase();
  if (!force && cache.has(symbol)) return cache.get(symbol);

  if (loadingPromises.has(symbol)) return loadingPromises.get(symbol);

  const p = (async () => {
    const info = await binanceRest.getExchangeInfo({ symbol });
    const s = info.symbols && info.symbols[0];
    if (!s) throw new Error(`Symbol not found on Binance: ${symbol}`);

    const lotSize = pickFilter(s, 'LOT_SIZE');
    const priceFilter = pickFilter(s, 'PRICE_FILTER');
    const notional = pickFilter(s, 'NOTIONAL') || pickFilter(s, 'MIN_NOTIONAL');

    const parsed = {
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      status: s.status,
      isSpotTradingAllowed: s.isSpotTradingAllowed,
      lotSize: lotSize && {
        minQty: new Decimal(lotSize.minQty),
        maxQty: new Decimal(lotSize.maxQty),
        stepSize: new Decimal(lotSize.stepSize),
      },
      priceFilter: priceFilter && {
        minPrice: new Decimal(priceFilter.minPrice),
        maxPrice: new Decimal(priceFilter.maxPrice),
        tickSize: new Decimal(priceFilter.tickSize),
      },
      notional: notional && {
        minNotional: new Decimal(notional.minNotional || notional.minNotionalValue || '0'),
        applyToMarket: notional.applyToMarket !== false,
      },
      raw: s,
    };

    cache.set(symbol, parsed);
    loadingPromises.delete(symbol);
    logger.info({ symbol, baseAsset: parsed.baseAsset, quoteAsset: parsed.quoteAsset }, 'symbol info loaded');
    return parsed;
  })();

  loadingPromises.set(symbol, p);
  return p;
}

function getCached(symbol) {
  return cache.get(symbol.toUpperCase()) || null;
}

// ─── Precision helpers ─────────────────────────────────
function getPrecision(stepSize) {
  // stepSize เช่น "0.00010000" → precision = 4 (จำนวนทศนิยมที่ significant)
  if (!stepSize) return 0;
  const s = stepSize.toString();
  if (s.includes('e-')) {
    const m = s.match(/\d+(?:\.(\d+))?e-(\d+)/);
    if (m) return parseInt(m[2], 10);
  }
  const dot = s.indexOf('.');
  if (dot === -1) return 0;
  return s.length - dot - 1;
}

// floor qty ตาม stepSize
function roundQty(qty, stepSize) {
  if (!stepSize || stepSize.isZero()) return new Decimal(qty);
  return new Decimal(qty).div(stepSize).floor().mul(stepSize);
}

// round price ตาม tickSize (ปัดให้ใกล้ที่สุด)
function roundPrice(price, tickSize) {
  if (!tickSize || tickSize.isZero()) return new Decimal(price);
  return new Decimal(price).div(tickSize).round().mul(tickSize);
}

// floor price ตาม tickSize (ปัดลงให้เป็น multiple ที่ valid)
// ใช้สำหรับ LIMIT_MAKER BUY ที่ต้องการ price < ask (post-only safe)
// เช่น ask=77.92, tickSize=0.01 → floor((77.92-0.01)/0.01)*0.01 = 77.91
function floorPrice(price, tickSize) {
  if (!tickSize || tickSize.isZero()) return new Decimal(price);
  return new Decimal(price).div(tickSize).floor().mul(tickSize);
}

// ตรวจว่า order ผ่าน LOT_SIZE / PRICE_FILTER / NOTIONAL หรือไม่
function validateOrder({ symbol, price, qty }) {
  const info = getCached(symbol);
  if (!info) {
    return { ok: false, reason: 'symbol info not loaded' };
  }
  const errors = [];

  if (info.lotSize) {
    if (new Decimal(qty).lessThan(info.lotSize.minQty)) {
      errors.push(`qty ${qty} < minQty ${info.lotSize.minQty.toString()}`);
    }
    if (new Decimal(qty).greaterThan(info.lotSize.maxQty)) {
      errors.push(`qty ${qty} > maxQty ${info.lotSize.maxQty.toString()}`);
    }
    // ตรวจ stepSize ตรงๆ ด้วยการเทียบ (qty / stepSize) ต้องเป็นจำนวนเต็ม
    const ratio = new Decimal(qty).div(info.lotSize.stepSize);
    if (!ratio.isInteger()) {
      errors.push(`qty ${qty} is not a multiple of stepSize ${info.lotSize.stepSize.toString()}`);
    }
  }

  if (info.priceFilter && price) {
    if (new Decimal(price).lessThan(info.priceFilter.minPrice)) {
      errors.push(`price ${price} < minPrice ${info.priceFilter.minPrice.toString()}`);
    }
    if (new Decimal(price).greaterThan(info.priceFilter.maxPrice)) {
      errors.push(`price ${price} > maxPrice ${info.priceFilter.maxPrice.toString()}`);
    }
    const ratio = new Decimal(price).div(info.priceFilter.tickSize);
    if (!ratio.isInteger()) {
      errors.push(`price ${price} is not a multiple of tickSize ${info.priceFilter.tickSize.toString()}`);
    }
  }

  if (info.notional && price) {
    const notional = new Decimal(qty).mul(new Decimal(price));
    if (notional.lessThan(info.notional.minNotional)) {
      errors.push(`notional ${notional.toString()} < minNotional ${info.notional.minNotional.toString()}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, reason: errors.join('; ') };
  }
  return { ok: true };
}

// คำนวณ qty จาก USDT capital และ bid price
function calcQtyFromCapital({ symbol, capitalUSDT, price }) {
  const info = getCached(symbol);
  if (!info || !info.lotSize) {
    throw new Error(`Symbol info not loaded for ${symbol}`);
  }
  const rawQty = new Decimal(capitalUSDT).div(new Decimal(price));
  const qty = roundQty(rawQty, info.lotSize.stepSize);
  return {
    qty: qty.toString(),
    precision: getPrecision(info.lotSize.stepSize),
  };
}

function clearCache() {
  cache.clear();
  loadingPromises.clear();
}

// ดึงรายชื่อ symbols ทั้งหมดที่ TRADING (cache 5 นาที)
let symbolsCache = { data: null, ts: 0 };
async function listSymbols() {
  const now = Date.now();
  if (symbolsCache.data && now - symbolsCache.ts < 5 * 60 * 1000) {
    return symbolsCache.data;
  }
  const info = await binanceRest.getExchangeInfo({});
  const symbols = (info.symbols || [])
    .filter((s) => s.isSpotTradingAllowed && s.status === 'TRADING' && s.quoteAsset === 'USDT')
    .map((s) => s.symbol)
    .sort();
  symbolsCache = { data: symbols, ts: now };
  return symbols;
}

module.exports = {
  loadSymbol,
  getCached,
  roundQty,
  roundPrice,
  floorPrice,
  validateOrder,
  calcQtyFromCapital,
  getPrecision,
  clearCache,
  listSymbols,
};