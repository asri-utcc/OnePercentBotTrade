'use strict';

/**
 * FIX-2026-08-01: Coin info aggregator
 *   - รวมข้อมูลจาก 2 Binance endpoints:
 *     1. /api/v3/exchangeInfo?symbol=X → baseAsset/quoteAsset/status/lot/tick/notional
 *     2. /api/v3/ticker/24hr?symbol=X → lastPrice/priceChangePercent/quoteVolume/count
 *   - cache 5 นาที (mirror listSymbols pattern)
 *   - ใช้แสดงในบอท card + scan-volatility
 *
 *   ข้อจำกัด: ไม่มีชื่อเหรียญ (เช่น "Solana") หรือ market cap — Binance public API
 *   ไม่ได้ expose ตรงๆ ต้องใช้ CoinGecko/CoinMarketCap (requires API key)
 *   ตอนนี้แสดงแค่ baseAsset (เช่น "SOL") + status + 24h stats พอ
 *
 * FIX-2026-08-22 (weight spike): single-flight + bulk fetch
 *   - เดิม getCoinInfo() ไม่มี single-flight → bots.html 86 parallel calls = 1,892 weight
 *   - ใหม่: _inflight Map<sym, Promise> dedupe in-flight requests per symbol
 *           getCoinInfosBulk() ใช้ 1 get24hrTickers + 1 exchangeInfo(symbols=[...]) รวม 22 weight
 *           ลดจาก 86×22=1,892 → 22 ต่อ page load
 */

const binanceRest = require('../binance/binanceRest');
const symbolInfo = require('../binance/symbolInfo');
const logger = require('../utils/logger');
const https = require('https');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // symbol -> { data, ts }

// FIX-2026-08-22: single-flight — ถ้ามี call เดียวกันอยู่ระหว่าง flight อยู่แล้ว รอ promise เดิม
const _inflight = new Map(); // sym → Promise<data>
let _inflightBulk = null;     // Promise<Record<sym, data>> (module-level — bulk is shared)

// FIX-2026-08-01: Binance BAPI marketing/symbol list — ดึง fullName (เช่น "Solana", "Tradr 2X Long SNDK ETF (bStocks)")
//   + logo + circulatingSupply + CMC rank
//   - cache 30min (ข้อมูลเปลี่ยนช้า) — ใช้ symbolListCache แชร์ทุก symbol
//   - endpoint: https://www.binance.com/bapi/composite/v1/public/marketing/symbol/list
//   - weight: 1 (public, ไม่นับ rate-limit ของ Binance trading API)
const MARKETING_LIST_URL = 'www.binance.com';
const MARKETING_LIST_PATH = '/bapi/composite/v1/public/marketing/symbol/list';
const MARKETING_TTL_MS = 30 * 60 * 1000;
let symbolListCache = { data: null, ts: 0 };

function fetchMarketingList() {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: MARKETING_LIST_URL,
      path: MARKETING_LIST_PATH,
      headers: {
        'User-Agent': 'Mozilla/5.0 (onepercentbot/coinInfo)',
        'Accept': 'application/json',
        'lang': 'en',
      },
      timeout: 10_000,
    }, (resp) => {
      let body = '';
      resp.on('data', (chunk) => { body += chunk; });
      resp.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.code !== '000000') return reject(new Error(`BAPI code ${j.code}: ${j.message || ''}`));
          resolve(j.data || []);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('BAPI marketing/symbol timeout')); });
  });
}

async function getMarketingList({ force = false } = {}) {
  const now = Date.now();
  if (!force && symbolListCache.data && (now - symbolListCache.ts) < MARKETING_TTL_MS) {
    return symbolListCache.data;
  }
  const list = await fetchMarketingList();
  symbolListCache = { data: list, ts: now };
  logger.info({ count: list.length }, 'coinInfo: BAPI marketing list loaded');
  return list;
}

function findMarketingInfo(list, symbol) {
  if (!list || !symbol) return null;
  const sym = String(symbol).toUpperCase();
  const hit = list.find((s) => String(s.symbol || '').toUpperCase() === sym);
  if (!hit) return null;
  return {
    fullName: hit.fullName || hit.localFullName || hit.name || null,
    name: hit.name || null,
    logo: hit.logo || null,
    cmcId: hit.cmcUniqueId || null,
    cmcRank: hit.rank || null,
    circulatingSupply: hit.circulatingSupply != null ? Number(hit.circulatingSupply) : null,
    maxSupply: hit.maxSupply != null ? Number(hit.maxSupply) : null,
    totalSupply: hit.totalSupply != null ? Number(hit.totalSupply) : null,
  };
}

/**
 * FIX-2026-08-22: build the response shape from raw exchange + ticker entries
 *   - shared between getCoinInfo() and getCoinInfosBulk()
 *   - pure function — no I/O, no cache write
 */
function _buildCoinInfo(s, t, sym) {
  const lotSize = (s.filters || []).find((f) => f.filterType === 'LOT_SIZE');
  const priceFilter = (s.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
  const notional = (s.filters || []).find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');

  let lastPrice = null, priceChangePct = null, priceChange = null, quoteVolume = null, volume = null, count = null;
  if (t && t.symbol) {
    lastPrice = Number(t.lastPrice) || null;
    priceChange = Number(t.priceChange) || null;
    priceChangePct = Number(t.priceChangePercent) || null;
    quoteVolume = Number(t.quoteVolume) || null;
    volume = Number(t.volume) || null;
    count = Number(t.count) || null;
  }

  return {
    symbol: s.symbol,
    baseAsset: s.baseAsset,
    quoteAsset: s.quoteAsset,
    status: s.status,
    isSpotTradingAllowed: !!s.isSpotTradingAllowed,
    // Filters
    lotSize: lotSize && {
      minQty: lotSize.minQty,
      maxQty: lotSize.maxQty,
      stepSize: lotSize.stepSize,
    },
    priceFilter: priceFilter && {
      minPrice: priceFilter.minPrice,
      maxPrice: priceFilter.maxPrice,
      tickSize: priceFilter.tickSize,
    },
    notional: notional && {
      minNotional: notional.minNotional || notional.minNotionalValue || null,
      applyToMarket: notional.applyToMarket !== false,
    },
    // 24h stats
    lastPrice,
    priceChange,
    priceChangePct,
    quoteVolume,    // USDT volume
    volume,         // base asset volume
    count,          // number of trades in 24h
    // FIX-2026-08-01: marketing metadata — จะถูก merge เข้ามาทีหลัง (ต้อง await)
    // FIX-2026-08-06: delist risk fields — จะถูก merge เข้ามาทีหลัง (ต้อง lazy require)
    fetchedAt: new Date().toISOString(),
  };
}

async function _attachMarketingAndDelist(data) {
  const sym = data.symbol;
  // FIX-2026-08-01: BAPI marketing info (fullName + logo + supply) — fail-safe
  let marketing = null;
  try {
    const list = await getMarketingList();
    marketing = findMarketingInfo(list, sym);
  } catch (err) {
    logger.warn({ symbol: sym, err: err.message }, 'coinInfo: BAPI marketing fetch failed — fullName/logo unavailable');
  }
  if (marketing) {
    data.fullName = marketing.fullName;
    data.logo = marketing.logo;
    data.cmcId = marketing.cmcId;
    data.cmcRank = marketing.cmcRank;
    data.circulatingSupply = marketing.circulatingSupply;
    data.maxSupply = marketing.maxSupply;
    data.totalSupply = marketing.totalSupply;
  } else {
    data.fullName = data.fullName || null;
    data.logo = data.logo || null;
    data.cmcId = data.cmcId || null;
    data.cmcRank = data.cmcRank || null;
    data.circulatingSupply = data.circulatingSupply || null;
    data.maxSupply = data.maxSupply || null;
    data.totalSupply = data.totalSupply || null;
  }
  // FIX-2026-08-06: delist risk fields — จาก binanceDelistMonitor
  //   - isAtRisk: Binance Marketing "Monitoring" tag (early warning)
  //   - isDelisted: delistTime has passed
  //   - delistTime: epoch ms ของวันที่จะถูก delist (null ถ้ายังไม่มี schedule)
  //   - delistDateIso: ISO string (UI แสดงสะดวก)
  //   - daysUntil: จำนวนวันก่อน delist (null ถ้ายังไม่มี schedule)
  //   - ทุก field อาจเป็น null/false ถ้า delistMonitor ยังไม่ start
  try {
    const delistMonitor = require('../services/binanceDelistMonitor');
    const risk = delistMonitor.getRiskInfoFor(sym);
    data.isAtRisk = risk ? risk.isAtRisk : false;
    data.isDelisted = risk ? risk.isDelisted : false;
    data.delistTime = risk ? risk.delistTime : null;
    data.delistDateIso = risk ? risk.delistDateIso : null;
    data.daysUntil = risk ? risk.daysUntil : null;
  } catch (_) {
    data.isAtRisk = false;
    data.isDelisted = false;
    data.delistTime = null;
    data.delistDateIso = null;
    data.daysUntil = null;
  }
  return data;
}

async function getCoinInfo(symbol, { force = false } = {}) {
  if (!symbol) throw new Error('symbol required');
  const sym = String(symbol).toUpperCase();

  const now = Date.now();
  const cached = cache.get(sym);
  if (!force && cached && (now - cached.ts) < CACHE_TTL_MS) {
    return cached.data;
  }

  // FIX-2026-08-22: single-flight — ถ้ามี request เดียวกันอยู่ระหว่าง flight รอ promise เดิม
  //   - ป้องกัน N parallel calls = N×weight (เคยเห็น 86 parallel = 1,892 weight)
  if (_inflight.has(sym)) {
    return _inflight.get(sym);
  }

  const p = (async () => {
    // Parallel: exchangeInfo (for status + filters) + ticker/24hr (for price/vol)
    const [exchange, ticker] = await Promise.allSettled([
      binanceRest.getExchangeInfo({ symbol: sym }),
      binanceRest.get24hrTickers({ symbol: sym }),
    ]);

    if (exchange.status === 'rejected') {
      throw new Error(`exchangeInfo failed for ${sym}: ${exchange.reason && exchange.reason.message}`);
    }
    const s = (exchange.value.symbols || [])[0];
    if (!s) {
      throw new Error(`Symbol not found on Binance: ${sym}`);
    }

    // Ticker — fail-safe
    let t = null;
    if (ticker.status === 'fulfilled' && ticker.value) {
      t = Array.isArray(ticker.value) ? ticker.value[0] : ticker.value;
    }

    const data = _buildCoinInfo(s, t, sym);
    await _attachMarketingAndDelist(data);
    cache.set(sym, { data, ts: Date.now() });
    logger.info({ symbol: sym, status: data.status, lastPrice: data.lastPrice }, 'coinInfo: loaded');
    return data;
  })().finally(() => {
    _inflight.delete(sym);
  });

  _inflight.set(sym, p);
  return p;
}

/**
 * FIX-2026-08-22 (weight spike): bulk fetch coin info for many symbols in 2 calls
 *   - Single-flight module-level: 5 concurrent getCoinInfosBulk([...86]) = 1 ชุด call
 *   - Strategy:
 *     1) ดึง get24hrTickers({}) → array ครอบคลุมทุก spot symbol (weight 80, cache 5min)
 *     2) ดึง getExchangeInfo({symbols: missing}) → array สำหรับเฉพาะ symbols ที่ยังไม่มีใน cache (weight 20)
 *     3) shape-build per symbol, attach marketing + delist, cache, return Record<sym, data>
 *   - ลดจาก 86×(20+2)=1,892 weight → 80+20=100 weight ต่อ page load (≈19× reduction)
 */
async function getCoinInfosBulk(symbols) {
  if (!Array.isArray(symbols)) throw new Error('symbols must be an array');

  // FIX-2026-08-22: single-flight — bulk request ใช้ module-level promise เพราะเป็น shared set
  //   - ถ้า 2 callsite ยิง getCoinInfosBulk พร้อมกัน (เช่น bots + scan-volatility) รอ promise เดียวกัน
  if (_inflightBulk) return _inflightBulk;

  const p = (async () => {
    const uniq = [...new Set(symbols.map((s) => String(s).toUpperCase()).filter(Boolean))];
    if (uniq.length === 0) return {};

    const now = Date.now();
    const result = {};
    const missing = [];

    for (const sym of uniq) {
      const cached = cache.get(sym);
      if (cached && (now - cached.ts) < CACHE_TTL_MS) {
        result[sym] = cached.data;
      } else {
        missing.push(sym);
      }
    }

    if (missing.length === 0) {
      logger.info({ requested: uniq.length, servedFromCache: uniq.length }, 'coinInfo: bulk all-served-from-cache');
      return result;
    }

    // FIX-2026-08-22: 1 ticker call (ทุก spot symbol, weight 80) + 1 exchangeInfo call (เฉพาะที่ขาด, weight 20)
    //   - ticker ใช้ empty symbol = all symbols — Binance คืน array ทุก quote
    //   - exchangeInfo ใช้ symbols=[...] = bulk form, weight 20
    let tickerMap = new Map();
    let exchangeMap = new Map();
    try {
      const [allTickers, exchange] = await Promise.all([
        binanceRest.get24hrTickers({}),
        binanceRest.getExchangeInfo({ symbols: missing }),
      ]);
      for (const t of (Array.isArray(allTickers) ? allTickers : [])) {
        tickerMap.set(t.symbol, t);
      }
      for (const s of (exchange.symbols || [])) {
        exchangeMap.set(s.symbol, s);
      }
    } catch (err) {
      // failover: throw → caller sees error → no cache writes → existing per-symbol getCoinInfo ยังทำงาน
      logger.warn({ err: err.message, missing: missing.length }, 'coinInfo: bulk fetch failed — callers should fall back to getCoinInfo');
      throw err;
    }

    // shape-build per missing symbol
    const built = [];
    for (const sym of missing) {
      const s = exchangeMap.get(sym);
      if (!s) {
        logger.warn({ symbol: sym }, 'coinInfo: symbol not found in bulk exchangeInfo');
        continue;
      }
      const t = tickerMap.get(sym) || null;
      const data = _buildCoinInfo(s, t, sym);
      built.push(data);
    }

    // attach marketing + delist (1 BAPI list call shared by all symbols — already cached 30min)
    await Promise.all(built.map((d) => _attachMarketingAndDelist(d)));

    // cache + merge into result
    for (const data of built) {
      cache.set(data.symbol, { data, ts: Date.now() });
      result[data.symbol] = data;
    }

    logger.info(
      { requested: uniq.length, servedFromCache: uniq.length - missing.length, fetched: built.length },
      'coinInfo: bulk loaded'
    );
    return result;
  })().finally(() => {
    _inflightBulk = null;
  });

  _inflightBulk = p;
  return p;
}

function clearCache() {
  cache.clear();
  symbolListCache = { data: null, ts: 0 };
  // FIX-2026-08-22: clearCache also resets single-flight (defensive — for tests)
  _inflight.clear();
  _inflightBulk = null;
}

module.exports = { getCoinInfo, getCoinInfosBulk, clearCache };
