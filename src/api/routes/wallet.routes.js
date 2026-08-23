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
const Trade = require('../../db/models/Trade');
const WalletSnapshot = require('../../db/models/WalletSnapshot');
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

// ─── Time-range helpers (chart query params) ───────────────────────────────
// FIX-2026-08-22: store entries UPPERCASE — range param is uppercased before lookup,
//   so 'all' from frontend becomes 'ALL' which matches the Set. (Pre-fix stored
//   'all' lowercase → Set.has('ALL') = false → 400 even though rangeToMs handled it.)
// FIX-2026-08-22 (later): added 90D + 180D — long-term trend view (PnL chart + portfolio).
const ALLOWED_RANGES = new Set(['1D', '3D', '7D', '30D', '90D', '180D', '1Y', 'ALL']);

function rangeToMs(range) {
  // returns ms offset from now; null = no lower bound (all)
  switch (String(range || '').toUpperCase()) {
    case '1D': return 24 * 60 * 60_000;
    case '3D': return 3 * 24 * 60 * 60_000;
    case '7D': return 7 * 24 * 60 * 60_000;
    case '30D': return 30 * 24 * 60 * 60_000;
    case '90D': return 90 * 24 * 60 * 60_000;
    case '180D': return 180 * 24 * 60 * 60_000;
    case '1Y': return 365 * 24 * 60 * 60_000;
    case 'ALL': return null;
    default: return null;
  }
}

// ─── GET /api/wallet/portfolio-history ─────────────────────────────────────
// FIX-2026-08-22: time-series of wallet snapshot values (USDT or THB) for chart 1
//   - Query: ?range=1D|3D|7D|30D|1Y|all (default 30D)
//   - Source: WalletSnapshot collection (1 doc/day at 00:01 BKK)
//   - Returns: { range, points: [{time: unixSec, value: number, totalThb?, fxRate?}], count }
//   - Always appends a "live now" point at the end (today's current wallet) so chart is fresh
router.get('/portfolio-history', requireAuth, async (req, res) => {
  try {
    const range = String(req.query.range || '30D').toUpperCase();
    if (!ALLOWED_RANGES.has(range)) {
      return res.status(400).json({ error: `range must be one of ${[...ALLOWED_RANGES].join(',')}` });
    }
    const offsetMs = rangeToMs(range);
    const since = offsetMs == null ? null : new Date(Date.now() - offsetMs);

    // Fetch snapshots ordered ascending
    const query = since ? { snapshotAt: { $gte: since } } : {};
    const rows = await WalletSnapshot.find(query)
      .sort({ snapshotAt: 1 })
      .lean();

    const points = rows.map((r) => ({
      time: Math.floor(new Date(r.snapshotAt).getTime() / 1000),
      totalUsdt: Number(r.totalUsdt) || 0,
      totalThb: r.totalThb != null ? Number(r.totalThb) : null,
      coinCount: r.coinCount || 0,
      fxRate: r.fxRate != null ? Number(r.fxRate) : null,
    }));

    // Append live point: today's current portfolio value (so chart shows up-to-date)
    // Only if last snapshot is older than ~6h (avoid duplication when scheduler just ran)
    let livePoint = null;
    try {
      const last = rows.length ? new Date(rows[rows.length - 1].snapshotAt).getTime() : 0;
      if (Date.now() - last > 6 * 60 * 60_000) {
        const walletSnapshotSvc = require('../../services/walletSnapshot');
        const live = await walletSnapshotSvc.snapshotWallet();
        livePoint = {
          time: Math.floor(Date.now() / 1000),
          totalUsdt: live.totalUsdt,
          totalThb: live.totalThb,
          coinCount: live.coinCount,
          fxRate: live.fxRate,
          isLive: true,
        };
      }
    } catch (liveErr) {
      logger.warn({ err: liveErr.message }, 'wallet: portfolio-history live point skipped (non-fatal)');
    }

    res.json({
      range,
      points,
      livePoint,
      count: points.length + (livePoint ? 1 : 0),
      ts: Date.now(),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'wallet: portfolio-history failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/wallet/pnl-series ───────────────────────────────────────────
// FIX-2026-08-22: cumulative USDT PnL time-series for chart 2
//   - Query: ?range=1D|3D|7D|30D|1Y|all (default 30D) — same convention as portfolio-history
//   - Source: Trade.realizedPnl aggregation (1 point per SELL fill)
//   - Returns: { range, points: [{time: unixSec, pnlUsdt, cumPnlUsdt, trades}], count, totalPnl, ... }
//   - Cumulative sum computed server-side (avoid sending 10k+ trades to client)
//   - Always appends a "live now" point equal to current cumulative (so chart shows fresh)
router.get('/pnl-series', requireAuth, async (req, res) => {
  try {
    const range = String(req.query.range || '30D').toUpperCase();
    if (!ALLOWED_RANGES.has(range)) {
      return res.status(400).json({ error: `range must be one of ${[...ALLOWED_RANGES].join(',')}` });
    }
    const offsetMs = rangeToMs(range);
    const since = offsetMs == null ? null : new Date(Date.now() - offsetMs);

    const match = { realizedPnl: { $ne: null }, sellFilledAt: { $ne: null } };
    if (since) match.sellFilledAt.$gte = since;

    // Aggregate: each trade = 1 point (sorted asc by sellFilledAt)
    // FIX-2026-08-22: removed broken `$toLong`/`$dateToString` projection — the `time` field
    //   was never used in the route (we convert sellFilledAt → unix-seconds in JS below).
    //   $dateToString produced strings like "2026-08-22T01:46:45.123Z" with literal T/Z, then
    //   $toLong tried to parse them as numbers and threw "Failed to parse number" — the
    //   entire aggregation failed → route returned 500 → chart rendered empty even with 1800+
    //   sold trades in DB. Just project sellFilledAt + realizedPnl directly.
    const trades = await Trade.aggregate([
      { $match: match },
      {
        $project: {
          sellFilledAt: 1,
          pnlUsdt: { $ifNull: ['$realizedPnl', 0] },
        },
      },
      { $sort: { sellFilledAt: 1 } },
      { $limit: 50000 }, // safety cap
    ]);

    // Build cumulative series (server-side — avoid sending 50k points to client unaggregated)
    let cum = 0;
    const points = [];
    let wins = 0;
    let losses = 0;
    for (const t of trades) {
      cum += Number(t.pnlUsdt) || 0;
      if (Number(t.pnlUsdt) > 0) wins++;
      else if (Number(t.pnlUsdt) < 0) losses++;
      points.push({
        time: Math.floor(new Date(t.sellFilledAt).getTime() / 1000),
        pnlUsdt: Number(Number(t.pnlUsdt).toFixed(6)),
        cumPnlUsdt: Number(cum.toFixed(6)),
      });
    }

    // Compute range-relative totals
    const totalPnlUsdt = cum;
    const winRate = points.length > 0 ? (wins / points.length) * 100 : 0;

    // For 'all' range also include a leading 0-point (so chart starts at zero baseline)
    let baselinePoint = null;
    if (points.length > 0) {
      // pick earliest point's time
      baselinePoint = { time: points[0].time, pnlUsdt: 0, cumPnlUsdt: 0 };
    }

    res.json({
      range,
      points,
      baselinePoint,
      count: points.length,
      totalPnlUsdt: Number(totalPnlUsdt.toFixed(6)),
      wins,
      losses,
      winRate: Number(winRate.toFixed(2)),
      ts: Date.now(),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'wallet: pnl-series failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;