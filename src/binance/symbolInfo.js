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
  // FIX-2026-07-31: ตัด trailing zeros ก่อนนับ ไม่งั้น "0.01000000" จะคืน 8 (ผิด)
  //   ZILUSDT tickSize="0.00000100" → "0.000001" → precision=6 (ตรงกับ Binance UI)
  if (!stepSize) return 0;
  let s = stepSize.toString();
  if (s.includes('e-')) {
    const m = s.match(/\d+(?:\.(\d+))?e-(\d+)/);
    if (m) return parseInt(m[2], 10);
  }
  const dot = s.indexOf('.');
  if (dot === -1) return 0;
  // ตัด trailing zeros หลังจุดทศนิยม
  let frac = s.slice(dot + 1);
  frac = frac.replace(/0+$/, '');
  return frac.length;
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

// ตรวจว่า order ผ่าน LOT_SIZE / PRICE_FILTER / NOTIONAL / DELIST หรือไม่
// FIX-2026-08-06: เพิ่ม delist gate — ถ้า symbol อยู่ใน /sapi/v1/spot/delist-schedule
//   และ delistTime - now <= 7 วัน → reject (defense-in-depth นอกเหนือจาก trader pre-flight)
function validateOrder({ symbol, price, qty }) {
  const info = getCached(symbol);
  if (!info) {
    return { ok: false, reason: 'symbol info not loaded' };
  }
  const errors = [];

  // FIX-2026-08-06: delist gate (load lazily to avoid circular require at module load)
  try {
    const delistMonitor = require('../services/binanceDelistMonitor');
    if (delistMonitor.isDelisted(symbol)) {
      errors.push(`symbol already delisted on Binance`);
    } else if (delistMonitor.willDelistWithin(symbol, 7)) {
      const dt = delistMonitor.getDelistTime(symbol);
      errors.push(`symbol scheduled for delisting at ${new Date(dt).toISOString()} (within 7 days)`);
    }
  } catch (_) { /* delistMonitor not yet started — fail-open */ }

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
// FIX-2026-07-31: ส่ง object { symbol, pricePrecision, tickSize } — ให้ client ใช้ tickSize
//   เป็น authoritative precision (ตรงกับ Binance UI) ไม่ต้องเดาจาก price magnitude
//   shape ใหม่: { symbols: ['BTCUSDT', ...], symbolInfo: { 'BTCUSDT': { tickSize: '0.01', pricePrecision: 2 }, ... } }
let symbolsCache = { data: null, ts: 0 };
async function listSymbols() {
  const now = Date.now();
  if (symbolsCache.data && now - symbolsCache.ts < 5 * 60 * 1000) {
    return symbolsCache.data;
  }
  const info = await binanceRest.getExchangeInfo({});
  const trading = (info.symbols || []).filter(
    (s) => s.isSpotTradingAllowed && s.status === 'TRADING' && s.quoteAsset === 'USDT'
  );
  const symbolInfoMap = {};
  for (const s of trading) {
    const pf = (s.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
    if (!pf || !pf.tickSize) continue;
    const tickSizeStr = String(pf.tickSize);
    symbolInfoMap[s.symbol] = {
      tickSize: tickSizeStr,
      pricePrecision: getPrecision(tickSizeStr),
    };
  }
  const symbols = trading.map((s) => s.symbol).sort();
  symbolsCache = { data: { symbols, symbolInfo: symbolInfoMap }, ts: now };
  return symbolsCache.data;
}

// FIX-2026-07-31: format price ตาม tickSize (authoritative per-symbol)
//   - ใช้ใน telegramNotifier.js เพื่อแสดงราคาในแชทให้ตรงกับ Binance UI
//   - ก่อนหน้านี้ heuristic: >=1 → 6 dp, <1 → 10 dp (over-precise สำหรับ ZILUSDT)
//   - ZILUSDT จริงควรแสดง 6 dp (เช่น "0.014500") ตาม PRICE_FILTER.tickSize
//   - ถ้า symbol ไม่อยู่ใน cache → fallback heuristic แบบเดิม (เพื่อกันพัง)
const tickSizeCache = new Map(); // symbol -> { tickSize: Decimal, pricePrecision: number }
function getTickSize(symbol) {
  if (!symbol) return null;
  const sym = String(symbol).toUpperCase();
  if (tickSizeCache.has(sym)) return tickSizeCache.get(sym);
  // load from listSymbols cache (ไม่ await — ถ้ายังไม่ load ใช้ fallback)
  const data = symbolsCache.data;
  if (data && data.symbolInfo && data.symbolInfo[sym]) {
    const info = data.symbolInfo[sym];
    const Decimal = require('decimal.js');
    const ts = new Decimal(info.tickSize);
    const entry = { tickSize: ts, pricePrecision: info.pricePrecision };
    tickSizeCache.set(sym, entry);
    return entry;
  }
  return null;
}

function formatPrice(price, symbol) {
  if (price == null) return String(price);
  const n = Number(price);
  if (!Number.isFinite(n)) return String(price);
  const ts = getTickSize(symbol);
  if (ts && ts.pricePrecision != null) {
    return n.toFixed(ts.pricePrecision);
  }
  // fallback heuristic (เดิม) — กันพังกรณี cache ยังไม่พร้อม
  if (Math.abs(n) >= 1) return n.toFixed(6);
  return n.toFixed(10);
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
  formatPrice, // FIX-2026-07-31: format price ตาม tickSize ใช้ใน telegramNotifier
  getTickSize, // expose for testing
};