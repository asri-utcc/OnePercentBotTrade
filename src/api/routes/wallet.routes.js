'use strict';

/**
 * 2026-08-19: Wallet routes — holdings aggregation + reserve CRUD
 *
 *   GET  /api/wallet/balances  → aggregate Binance Spot balances with USDT price
 *                                  + THB value (filtered > 1 THB)
 *   GET  /api/wallet/reserve   → read current reserve + total USDT + usable
 *   PUT  /api/wallet/reserve   → update reserve (gated by requireBotActionPassword)
 *
 * Price source:
 *   - binanceRest.get24hrTickers() — single batch (weight 80) for ALL symbols
 *   - 30s in-process cache to avoid hitting Binance every page load / refresh
 *   - stablecoins (USDT/USDC/BUSD/FDUSD/TUSD/DAI) → hardcoded 1.0 USDT
 *
 * Auth:
 *   - GET endpoints: requireAuth
 *   - PUT /api/wallet/reserve: requireAuth + bot-action password (inlined — mirror
 *     bot.routes.js pattern since admin.routes.js uses try/require fallback).
 *
 * Cache discipline:
 *   - reserve: src/services/walletReserve.js (10s)
 *   - 24hr tickers: 30s in-process Map<ts, tickers>
 */

const express = require('express');
const binanceRest = require('../../binance/binanceRest');
const fxService = require('../../services/fxService');
const walletReserve = require('../../services/walletReserve');
const AppConfig = require('../../db/models/AppConfig');
const config = require('../../../config');
const logger = require('../../utils/logger');
const { requireAuth } = require('../middleware/auth');

// ─── Bot-Action Password middleware (inlined mirror of bot.routes.js) ─────
// รับ password จาก body.password, header X-Bot-Action-Password, หรือ query ?password=
// ถ้า config.botActionPassword ว่าง → reject ทุก action (force secure by default)
function requireBotActionPassword(req, res, next) {
  const expected = (config.botActionPassword || '').trim();
  if (!expected) {
    logger.warn({ path: req.path, ip: req.ip }, 'wallet: bot action blocked: BOT_ACTION_PASSWORD not configured');
    return res.status(503).json({
      error: 'Bot actions are disabled because BOT_ACTION_PASSWORD is not set. Set it in .env to enable reserve changes.',
    });
  }
  const provided = (
    (req.body && req.body.password)
    || req.get('X-Bot-Action-Password')
    || req.query.password
    || ''
  ).toString().trim();
  if (!provided || provided !== expected) {
    logger.warn({ path: req.path, ip: req.ip, hasPassword: !!provided }, 'wallet: bot action blocked: invalid/missing password');
    return res.status(403).json({ error: 'Invalid or missing password for bot action' });
  }
  next();
}

// ─── Constants ─────────────────────────────────────────────────────────────
const STABLECOINS = new Set([
  'USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USD1', 'USDP',
]);
const PRICE_CACHE_TTL_MS = 30 * 1000;
const MIN_VALUE_THB = 1; // filter coins with total value <= 1 THB

// ─── 24hr ticker cache (30s) ─────────────────────────────────────────────
let _tickerCache = null; // { ts, bySymbol: Map<USDT_PAIR_SYMBOL, lastPrice> }
let _tickerInflight = null;

async function _getTickerPrices() {
  const now = Date.now();
  if (_tickerCache && (now - _tickerCache.ts) < PRICE_CACHE_TTL_MS) {
    return _tickerCache.bySymbol;
  }
  if (_tickerInflight) return _tickerInflight;
  _tickerInflight = (async () => {
    try {
      const tickers = await binanceRest.get24hrTickers();
      const bySymbol = new Map();
      for (const t of (tickers || [])) {
        if (!t || !t.symbol) continue;
        // lastPrice is already USDT-denominated for *USDT pairs
        const lp = parseFloat(t.lastPrice);
        if (Number.isFinite(lp) && lp > 0) bySymbol.set(t.symbol, lp);
      }
      _tickerCache = { ts: Date.now(), bySymbol };
      return bySymbol;
    } catch (err) {
      logger.warn({ err: err.message }, 'wallet: get24hrTickers failed — returning empty price map');
      // return whatever cache we have (may be stale)
      return _tickerCache ? _tickerCache.bySymbol : new Map();
    } finally {
      _tickerInflight = null;
    }
  })();
  return _tickerInflight;
}

function _getUsdtPriceForAsset(asset, tickerPrices) {
  if (STABLECOINS.has(asset)) return 1.0;
  // Try primary: ASSETUSDT
  const pair = `${asset}USDT`;
  const p = tickerPrices.get(pair);
  if (p != null && Number.isFinite(p) && p > 0) return p;
  // Some assets have a non-USDT quote (e.g., BTC). Try ASSETBTC + ASSETFDUSD.
  // Fallback: ASSETBTC × BTCUSDT (best-effort)
  const btcPair = tickerPrices.get('BTCUSDT');
  if (btcPair && btcPair > 0) {
    const btcAssetPrice = tickerPrices.get(`${asset}BTC`);
    if (btcAssetPrice && btcAssetPrice > 0) return btcAssetPrice * btcPair;
  }
  // No price available → return null (caller excludes)
  return null;
}

const router = express.Router();

// ─── GET /api/wallet/balances ─────────────────────────────────────────────
router.get('/balances', requireAuth, async (req, res) => {
  try {
    const [acc, tickerPrices, fx] = await Promise.all([
      binanceRest.getAccount(),
      _getTickerPrices(),
      fxService.getUsdtToThb().catch((err) => {
        logger.warn({ err: err.message }, 'wallet: fxService failed — USD values only');
        return { rate: null, source: null };
      }),
    ]);
    const fxRate = fx && fx.rate;
    const fxSource = fx && fx.source;

    const rows = [];
    let totalValueUsdt = 0;
    for (const b of (acc.balances || [])) {
      const free = parseFloat(b.free) || 0;
      const locked = parseFloat(b.locked) || 0;
      const total = free + locked;
      if (total <= 0) continue;

      // USDT is priced 1:1 against USDT (avoids stale ticker cache issues)
      let priceUsdt = b.asset === 'USDT' ? 1.0 : _getUsdtPriceForAsset(b.asset, tickerPrices);
      if (priceUsdt == null) {
        // asset without USDT price → skip (probably dust or unusual token)
        continue;
      }
      const valueUsdt = total * priceUsdt;
      const valueThb = fxRate && fxRate > 0 ? valueUsdt * fxRate : null;

      rows.push({
        asset: b.asset,
        free,
        locked,
        total,
        priceUsdt,
        valueUsdt,
        valueThb,
        isStable: STABLECOINS.has(b.asset),
      });
      totalValueUsdt += valueUsdt;
    }

    // Sort descending by valueUsdt
    rows.sort((a, b) => b.valueUsdt - a.valueUsdt);

    // Filter > MIN_VALUE_THB (only if THB rate available; otherwise show all)
    const filtered = (fxRate && fxRate > 0)
      ? rows.filter((r) => r.valueThb == null || r.valueThb > MIN_VALUE_THB)
      : rows;

    // compute % of portfolio (use filtered total as denominator)
    const filteredTotal = filtered.reduce((s, r) => s + r.valueUsdt, 0);
    for (const r of filtered) {
      r.pctOfPortfolio = filteredTotal > 0 ? (r.valueUsdt / filteredTotal) * 100 : 0;
    }

    res.json({
      balances: filtered,
      count: filtered.length,
      totalValueUsdt,
      totalValueThb: fxRate && fxRate > 0 ? totalValueUsdt * fxRate : null,
      minValueThb: MIN_VALUE_THB,
      fxRate: fxRate || null,
      fxSource: fxSource || null,
      fxStale: fx && fx.stale === true,
      ts: Date.now(),
    });
  } catch (err) {
    const binanceErr = binanceRest.formatBinanceError(err);
    if (binanceErr && binanceErr.code === 'NO_API_KEYS') {
      return res.status(400).json({ error: 'API keys not configured' });
    }
    logger.error({
      err: binanceErr.msg || err.message,
      binanceCode: binanceErr.code,
      binanceStatus: binanceErr.status,
    }, 'wallet: balances fetch failed');
    res.status(502).json({
      error: binanceErr.msg || err.message,
      binanceCode: binanceErr.code,
      binanceStatus: binanceErr.status,
    });
  }
});

// ─── GET /api/wallet/reserve ───────────────────────────────────────────────
router.get('/reserve', requireAuth, async (req, res) => {
  try {
    const [reserveUsdt, acc] = await Promise.all([
      walletReserve.getReserveUsdt(),
      binanceRest.getAccount().catch((err) => {
        logger.warn({ err: err.message }, 'wallet: reserve: getAccount failed');
        return { balances: [] };
      }),
    ]);
    const usdtBal = (acc.balances || []).find((b) => b.asset === 'USDT');
    const totalUsdt = usdtBal ? (parseFloat(usdtBal.free) || 0) + (parseFloat(usdtBal.locked) || 0) : 0;
    const usableUsdt = Math.max(0, totalUsdt - reserveUsdt);
    const isOverReserved = reserveUsdt > totalUsdt;
    res.json({
      reserveUsdt,
      totalUsdt,
      usableUsdt,
      isOverReserved,
      ts: Date.now(),
    });
  } catch (err) {
    const binanceErr = binanceRest.formatBinanceError(err);
    logger.error({ err: binanceErr.msg || err.message, binanceCode: binanceErr.code }, 'wallet: reserve fetch failed');
    res.status(500).json({ error: binanceErr.msg || err.message, binanceCode: binanceErr.code });
  }
});

// ─── PUT /api/wallet/reserve ───────────────────────────────────────────────
router.put('/reserve', requireAuth, requireBotActionPassword, async (req, res) => {
  try {
    const raw = req.body && req.body.reserveUsdt;
    if (raw === undefined || raw === null) {
      return res.status(400).json({ error: 'reserveUsdt is required (number, USDT)' });
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: 'reserveUsdt must be a non-negative number' });
    }
    const MAX = walletReserve.MAX_RESERVE;
    const clamped = Math.min(MAX, n);
    if (clamped !== n) {
      logger.warn({ requested: n, clamped }, 'wallet: reserve above schema max — clamped');
    }

    await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: { walletReserveUsdt: clamped } },
      { new: true, upsert: true }
    );
    walletReserve.invalidateCache();

    // Read current USDT (best-effort) so client knows if it's over-reserved
    let totalUsdt = null;
    try {
      const acc = await binanceRest.getAccount();
      const usdtBal = (acc.balances || []).find((b) => b.asset === 'USDT');
      totalUsdt = usdtBal ? (parseFloat(usdtBal.free) || 0) + (parseFloat(usdtBal.locked) || 0) : 0;
    } catch (err) {
      logger.warn({ err: err.message }, 'wallet: reserve PUT: getAccount failed (non-fatal)');
    }

    logger.info({ reserveUsdt: clamped, totalUsdt }, 'wallet: reserve updated');

    res.json({
      ok: true,
      reserveUsdt: clamped,
      totalUsdt,
      usableUsdt: totalUsdt != null ? Math.max(0, totalUsdt - clamped) : null,
      isOverReserved: totalUsdt != null ? clamped > totalUsdt : false,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'wallet: reserve PUT failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;