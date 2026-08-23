'use strict';

// FIX-2026-07-31: shared price formatter using Binance tickSize (authoritative per-symbol)
//   - ก่อนหน้านี้ client ใช้ heuristic: >=0.01 → 4 ตำแหน่ง → ZILUSDT (price ~0.01) แสดง 4 ตำแหน่ง
//     แต่ Binance จริงแสดง 6 ตำแหน่ง (ตาม PRICE_FILTER.tickSize) — ข้อมูลไม่ตรง
//   - วิธี fix: ดึง tickSize จาก /api/bots/symbols → ใช้ pricePrecision จาก tickSize
//     ถ้า symbol ยังไม่โหลด → fallback heuristic (เดิม) เพื่อกันไม่ให้พัง
//
// Exposed on window.PriceFormat:
//   PriceFormat.format(price, symbol)             → "0.014500"  (string)
//   PriceFormat.digits(symbol)                    → 6           (int)
//   PriceFormat.load()                            → Promise    (preload + cache)
//   PriceFormat.getSymbolInfo(symbol)             → {tickSize, pricePrecision} | null
//
// Usage:
//   await PriceFormat.load();                       // ใน init() ของ page
//   PriceFormat.format(0.0145, 'ZILUSDT')           // '0.014500'
//   PriceFormat.format(67234.5, 'BTCUSDT')          // '67234.50'

(function () {
  const cache = { symbols: null, symbolInfo: null, loading: null };

  // ── Heuristic fallback (เดิม) — ใช้เมื่อ symbol ไม่อยู่ใน symbolInfo cache ──────
  function heuristicDigits(price) {
    if (price == null || !Number.isFinite(price)) return 4;
    const abs = Math.abs(price);
    if (abs >= 1000) return 2;
    if (abs >= 1) return 4;
    if (abs >= 0.01) return 4;
    if (abs >= 0.0001) return 5;
    return 6;
  }

  function getDigits(symbol, price) {
    if (symbol && cache.symbolInfo && cache.symbolInfo[symbol] != null) {
      const p = cache.symbolInfo[symbol];
      if (p && typeof p.pricePrecision === 'number') return p.pricePrecision;
    }
    return heuristicDigits(price);
  }

  function format(price, symbol) {
    if (price == null || !Number.isFinite(price)) return '';
    return price.toFixed(getDigits(symbol, price));
  }

  async function load() {
    if (cache.symbolInfo) return cache.symbolInfo; // already loaded
    if (cache.loading) return cache.loading;
    cache.loading = (async () => {
      try {
        const resp = await API.get('/api/bots/symbols');
        cache.symbols = Array.isArray(resp && resp.symbols) ? resp.symbols : [];
        cache.symbolInfo = (resp && resp.symbolInfo) || {};
      } catch (e) {
        // ignore — fallback heuristic only
        cache.symbols = [];
        cache.symbolInfo = {};
      }
      return cache.symbolInfo;
    })();
    return cache.loading;
  }

  function getSymbolInfo(symbol) {
    if (!symbol) return null;
    return (cache.symbolInfo && cache.symbolInfo[symbol]) || null;
  }

  window.PriceFormat = {
    format,
    digits: getDigits,
    load,
    getSymbolInfo,
    heuristicDigits, // exposed for testing/debugging
  };
})();
