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
 */

const binanceRest = require('../binance/binanceRest');
const symbolInfo = require('../binance/symbolInfo');
const logger = require('../utils/logger');
const https = require('https');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // symbol -> { data, ts }

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

async function getCoinInfo(symbol, { force = false } = {}) {
  if (!symbol) throw new Error('symbol required');
  const sym = String(symbol).toUpperCase();

  const now = Date.now();
  const cached = cache.get(sym);
  if (!force && cached && (now - cached.ts) < CACHE_TTL_MS) {
    return cached.data;
  }

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

  // Filters
  const lotSize = (s.filters || []).find((f) => f.filterType === 'LOT_SIZE');
  const priceFilter = (s.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
  const notional = (s.filters || []).find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');

  // Ticker (may fail — fail-safe)
  let lastPrice = null, priceChangePct = null, priceChange = null, quoteVolume = null, volume = null, count = null;
  if (ticker.status === 'fulfilled' && ticker.value) {
    // /api/v3/ticker/24hr returns:
    //   - array of objects (no symbol filter)
    //   - single object (with symbol filter)
    const t = Array.isArray(ticker.value) ? ticker.value[0] : ticker.value;
    if (t && t.symbol) {
      lastPrice = Number(t.lastPrice) || null;
      priceChange = Number(t.priceChange) || null;
      priceChangePct = Number(t.priceChangePercent) || null;
      quoteVolume = Number(t.quoteVolume) || null;
      volume = Number(t.volume) || null;
      count = Number(t.count) || null;
    }
  }

  // FIX-2026-08-01: BAPI marketing info (fullName + logo + supply) — fail-safe
  let marketing = null;
  try {
    const list = await getMarketingList();
    marketing = findMarketingInfo(list, sym);
  } catch (err) {
    logger.warn({ symbol: sym, err: err.message }, 'coinInfo: BAPI marketing fetch failed — fullName/logo unavailable');
  }

  const data = {
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
    // FIX-2026-08-01: marketing metadata (fullName + logo + supply) — จาก BAPI
    fullName: marketing ? marketing.fullName : null,
    logo: marketing ? marketing.logo : null,
    cmcId: marketing ? marketing.cmcId : null,
    cmcRank: marketing ? marketing.cmcRank : null,
    circulatingSupply: marketing ? marketing.circulatingSupply : null,
    maxSupply: marketing ? marketing.maxSupply : null,
    totalSupply: marketing ? marketing.totalSupply : null,
    fetchedAt: new Date().toISOString(),
  };

  cache.set(sym, { data, ts: now });
  logger.info({ symbol: sym, status: data.status, lastPrice: data.lastPrice }, 'coinInfo: loaded');
  return data;
}

function clearCache() {
  cache.clear();
}

module.exports = { getCoinInfo, clearCache };
