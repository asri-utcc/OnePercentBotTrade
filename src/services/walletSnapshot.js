'use strict';

/**
 * FIX-2026-08-22: Wallet Daily Snapshot scheduler
 *
 * Background:
 *   หน้า /wallet.html เพิ่ม 2 กราฟ:
 *     1. "Account Estimate Value" — snapshot มูลค่าพอร์ตทุกเที่ยงคืน BKK (00:00 Asia/Bangkok)
 *     2. "USDT PnL" (cumulative) — aggregate จาก Trade.realizedPnl (ไม่ต้อง snapshot)
 *
 * Service นี้รับผิดชอบ:
 *   - Schedule daily snapshot ที่ 00:01 BKK (delay 1 นาทีหลังเที่ยงคืน เพื่อให้ BKK day boundary settle)
 *   - On startup: ถ้าวันนี้ยังไม่มี snapshot → snapshot ทันที (backfill "today")
 *   - Idempotent: upsert by dateKey — ซ้ำวันเดียวกัน = update, ไม่สร้างใหม่
 *   - Fail-soft: error → log + retry next day (ไม่ throw / crash process)
 *
 * Source of value:
 *   - Reuses src/api/routes/wallet.routes.js logic (binanceRest.getAccount() + 24hr tickers + fxService)
 *   - แทนที่จะ duplicate logic → เรียก internal helper `_snapshotWallet()` ที่ห่อ logic เดียวกัน
 *   - แต่เพื่อหลีกเลี่ยน circular import (routes → services → routes)
 *     → duplicate minimal aggregation logic ใน service นี้ (same pattern as dailyTarget.routes.js)
 *
 * Restart safety:
 *   - on start(): check if today's snapshot exists → if not, run immediately (idempotent upsert)
 *   - on next 00:01 BKK → run daily
 *   - if server is offline at midnight → snapshot missed → "today" snapshot fills on next startup
 *   - older days without snapshot → not backfilled (chart shows from earliest available)
 *
 * Time helpers:
 *   - nextMidnightBkkMs() — ms until next 00:01 BKK
 *   - startOfTodayBkk() — 00:00:00 BKK today (Asia/Bangkok convention)
 */

const AppConfig = require('../db/models/AppConfig');
const WalletSnapshot = require('../db/models/WalletSnapshot');
const binanceRest = require('../binance/binanceRest');
const fxService = require('./fxService');
const logger = require('../utils/logger');

const STABLECOINS = new Set([
  'USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USD1', 'USDP',
]);

const TICKER_CACHE_TTL_MS = 30 * 1000;
const _tickerCache = { ts: 0, bySymbol: new Map() };

let _schedulerInterval = null;
let _schedulerTimeout = null;
let _inFlight = false;
let _lastRunAt = null;
let _lastRunError = null;
let _lastStats = null;
let _stopped = false;

// ─── helpers ────────────────────────────────────────────────────────────────

function startOfTodayBkk() {
  // FIX-2026-08-08 convention: convert UTC ms → BKK clock with fixed +7h offset
  const now = new Date();
  const bkkMs = now.getTime() + 7 * 60 * 60_000;
  const bkk = new Date(bkkMs);
  const startUtcMs = Date.UTC(
    bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate(),
    -7, 0, 0
  );
  return new Date(startUtcMs);
}

function bkkDateKey(d) {
  // 'YYYY-MM-DD' in Asia/Bangkok
  const bkkMs = d.getTime() + 7 * 60 * 60_000;
  const bkk = new Date(bkkMs);
  const y = bkk.getUTCFullYear();
  const m = String(bkk.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(bkk.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function nextMidnightDelayMs(now = new Date()) {
  // ms until next 00:01 BKK
  const nowBkkMs = now.getTime() + 7 * 60 * 60_000;
  const bkk = new Date(nowBkkMs);
  // build 00:01 BKK of (today if now<00:01 else tomorrow) in UTC ms
  const targetBkkY = bkk.getUTCFullYear();
  const targetBkkM = bkk.getUTCMonth();
  const targetBkkD = bkk.getUTCDate();
  const targetUtcMs = Date.UTC(targetBkkY, targetBkkM, targetBkkD, 0, 1, 0) - 7 * 60 * 60_000;
  let delay = targetUtcMs - now.getTime();
  if (delay <= 0) {
    // already past 00:01 BKK today → schedule tomorrow
    const tomorrowUtcMs = Date.UTC(targetBkkY, targetBkkM, targetBkkD + 1, 0, 1, 0) - 7 * 60 * 60_000;
    delay = tomorrowUtcMs - now.getTime();
  }
  return delay;
}

async function _getTickerPrices() {
  const now = Date.now();
  if (_tickerCache.bySymbol.size > 0 && (now - _tickerCache.ts) < TICKER_CACHE_TTL_MS) {
    return _tickerCache.bySymbol;
  }
  try {
    const tickers = await binanceRest.get24hrTickers();
    const bySymbol = new Map();
    for (const t of (tickers || [])) {
      if (!t || !t.symbol) continue;
      const lp = parseFloat(t.lastPrice);
      if (Number.isFinite(lp) && lp > 0) bySymbol.set(t.symbol, lp);
    }
    _tickerCache.ts = Date.now();
    _tickerCache.bySymbol = bySymbol;
    return bySymbol;
  } catch (err) {
    logger.warn({ err: err.message }, 'walletSnapshot: get24hrTickers failed — using stale cache');
    return _tickerCache.bySymbol;
  }
}

function _getUsdtPriceForAsset(asset, tickerPrices) {
  if (STABLECOINS.has(asset)) return 1.0;
  const pair = `${asset}USDT`;
  const p = tickerPrices.get(pair);
  if (p != null && Number.isFinite(p) && p > 0) return p;
  const btcPair = tickerPrices.get('BTCUSDT');
  if (btcPair && btcPair > 0) {
    const btcAssetPrice = tickerPrices.get(`${asset}BTC`);
    if (btcAssetPrice && btcAssetPrice > 0) return btcAssetPrice * btcPair;
  }
  return null;
}

/**
 * Compute current wallet value (USDT + THB) for snapshot.
 * Mirror src/api/routes/wallet.routes.js balances logic (avoid circular import).
 *
 * @returns {Promise<{totalUsdt:number,totalThb:number|null,fxRate:number|null,fxSource:string|null,coinCount:number,holdings:Array,dateKey:string,snapshotAt:Date}>}
 */
async function snapshotWallet() {
  const [acc, tickerPrices, fx] = await Promise.all([
    binanceRest.getAccount(),
    _getTickerPrices(),
    fxService.getUsdtToThb().catch((err) => {
      logger.warn({ err: err.message }, 'walletSnapshot: fxService failed — USDT only');
      return { rate: null, source: null };
    }),
  ]);
  const fxRate = fx && Number(fx.rate) > 0 ? Number(fx.rate) : null;
  const fxSource = fx && fx.source ? fx.source : null;

  const rows = [];
  let totalUsdt = 0;
  for (const b of (acc.balances || [])) {
    const free = parseFloat(b.free) || 0;
    const locked = parseFloat(b.locked) || 0;
    const total = free + locked;
    if (total <= 0) continue;
    const priceUsdt = b.asset === 'USDT' ? 1.0 : _getUsdtPriceForAsset(b.asset, tickerPrices);
    if (priceUsdt == null) continue;
    const valueUsdt = total * priceUsdt;
    const valueThb = fxRate && fxRate > 0 ? valueUsdt * fxRate : null;
    rows.push({
      asset: b.asset,
      qty: total,
      priceUsdt,
      valueUsdt,
      valueThb,
    });
    totalUsdt += valueUsdt;
  }
  // Filter > 1 THB (mirror wallet.routes.js MIN_VALUE_THB)
  const filtered = (fxRate && fxRate > 0)
    ? rows.filter((r) => r.valueThb == null || r.valueThb > 1)
    : rows;
  filtered.sort((a, b) => b.valueUsdt - a.valueUsdt);

  const now = new Date();
  return {
    dateKey: bkkDateKey(now),
    snapshotAt: startOfTodayBkk(),
    totalUsdt: Number(totalUsdt.toFixed(4)),
    totalThb: fxRate && fxRate > 0 ? Number((totalUsdt * fxRate).toFixed(2)) : null,
    fxRate,
    fxSource,
    coinCount: filtered.length,
    holdings: filtered.map((r) => ({
      asset: r.asset,
      qty: Number(r.qty.toFixed(8)),
      priceUsdt: Number(r.priceUsdt.toFixed(8)),
      valueUsdt: Number(r.valueUsdt.toFixed(4)),
      valueThb: r.valueThb != null ? Number(r.valueThb.toFixed(2)) : null,
    })),
  };
}

/**
 * Run snapshot once for "today" (idempotent upsert).
 * @param {string} [source] — 'scheduler' | 'manual' | 'backfill'
 * @returns {Promise<{ok:boolean, dateKey:string, totalUsdt:number, upserted:boolean, error?:string}>}
 */
async function runOnce(source = 'scheduler') {
  if (_inFlight) {
    logger.debug('walletSnapshot: runOnce skipped — already in flight');
    return { ok: false, dateKey: null, totalUsdt: 0, upserted: false, error: 'in_flight' };
  }
  _inFlight = true;
  _lastRunAt = new Date();
  try {
    const snap = await snapshotWallet();
    // Upsert by dateKey — idempotent for same-day re-runs
    const result = await WalletSnapshot.findOneAndUpdate(
      { dateKey: snap.dateKey },
      {
        $set: {
          snapshotAt: snap.snapshotAt,
          totalUsdt: snap.totalUsdt,
          totalThb: snap.totalThb,
          fxRate: snap.fxRate,
          fxSource: snap.fxSource,
          coinCount: snap.coinCount,
          holdings: snap.holdings,
          source,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const upserted = !!result;
    _lastRunError = null;
    _lastStats = {
      dateKey: snap.dateKey,
      totalUsdt: snap.totalUsdt,
      totalThb: snap.totalThb,
      coinCount: snap.coinCount,
      upserted,
      source,
    };
    logger.info({
      dateKey: snap.dateKey,
      totalUsdt: snap.totalUsdt,
      totalThb: snap.totalThb,
      coinCount: snap.coinCount,
      source,
    }, 'walletSnapshot: done');
    return { ok: true, ..._lastStats };
  } catch (err) {
    _lastRunError = err.message;
    logger.error({ err: err.message, stack: err.stack }, 'walletSnapshot: runOnce failed');
    return { ok: false, dateKey: null, totalUsdt: 0, upserted: false, error: err.message };
  } finally {
    _inFlight = false;
  }
}

async function _ensureTodayThenSchedule() {
  // On startup: if today's snapshot doesn't exist → run immediately (backfill today)
  try {
    const todayKey = bkkDateKey(new Date());
    const existing = await WalletSnapshot.findOne({ dateKey: todayKey }).lean();
    if (!existing) {
      logger.info({ dateKey: todayKey }, 'walletSnapshot: today snapshot missing — running initial backfill');
      await runOnce('scheduler');
    } else {
      logger.info({ dateKey: todayKey, totalUsdt: existing.totalUsdt }, 'walletSnapshot: today snapshot already exists');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'walletSnapshot: initial backfill check failed (non-fatal)');
  }
  _scheduleNext();
}

function _scheduleNext() {
  if (_stopped) return;
  if (_schedulerTimeout) clearTimeout(_schedulerTimeout);
  const delay = nextMidnightDelayMs();
  logger.info({ delayMs: delay, delayHrs: Number((delay / 3_600_000).toFixed(2)) }, 'walletSnapshot: scheduled next run');
  _schedulerTimeout = setTimeout(async () => {
    if (_stopped) return;
    await runOnce('scheduler');
    // schedule next 24h cycle
    _schedulerTimeout = setTimeout(_onDailyTick, 24 * 60 * 60 * 1000);
  }, delay);
}

async function _onDailyTick() {
  if (_stopped) return;
  await runOnce('scheduler');
  _schedulerTimeout = setTimeout(_onDailyTick, 24 * 60 * 60 * 1000);
}

/**
 * Start the wallet snapshot scheduler.
 *   - Always runs (no master toggle — simple, safe, idempotent)
 *   - On startup: ensures "today" exists, then schedules next 00:01 BKK
 */
function start() {
  if (_schedulerInterval || _schedulerTimeout) {
    logger.warn('walletSnapshot: start() called but already running — no-op');
    return;
  }
  _stopped = false;
  logger.info('walletSnapshot: starting');
  _ensureTodayThenSchedule();
}

function stop() {
  _stopped = true;
  if (_schedulerTimeout) clearTimeout(_schedulerTimeout);
  if (_schedulerInterval) clearInterval(_schedulerInterval);
  _schedulerTimeout = null;
  _schedulerInterval = null;
  logger.info('walletSnapshot: stopped');
}

function getStatus() {
  return {
    running: !_stopped,
    inFlight: _inFlight,
    lastRunAt: _lastRunAt,
    lastRunError: _lastRunError,
    lastStats: _lastStats,
    nextRunAt: _schedulerTimeout ? new Date(Date.now() + (nextMidnightDelayMs())) : null,
  };
}

module.exports = {
  start,
  stop,
  runOnce,
  snapshotWallet, // exported for tests + manual backfill
  nextMidnightDelayMs, // exported for tests
  bkkDateKey, // exported for tests
  startOfTodayBkk, // exported for tests
  getStatus,
};
