'use strict';

/**
 * 2026-10-08: CapitalFlow Service
 *
 * ดึง deposit/withdraw history จาก Binance → แปลงเป็น USDT → upsert เข้า CapitalFlow collection
 * ใช้คำนวณ "งบประมาณสะสมที่เติม" (Net Deposited) ให้บอทตัดสินใจ
 *
 * Source:
 *   - binanceRest.getDepositHistory()  → /sapi/v1/capital/deposit/hisrec
 *   - binanceRest.getWithdrawHistory() → /sapi/v1/capital/withdraw/history
 *
 * Price lookup strategy (USD price at insertTime):
 *   1. Stablecoin (USDT/USDC/BUSD/FDUSD/TUSD/DAI/USD1/USDP) → 1.0 (source: 'stablecoin')
 *   2. ใช้ kline 1h ถ้า insertTime อยู่ใน 30 วันหลัง, ไม่งั้น kline 1d (Binance เก็บ 1d ได้นาน)
 *      - request window = 1 candle that contains insertTime → close price
 *      - cache ราคาไว้ใน _priceCache ลด Binance calls
 *   3. Fallback: ใช้ราคาปัจจุบันจาก binanceRest.getBookTicker() (source: 'current')
 *
 * Idempotency:
 *   - upsert by CapitalFlow.key = `${type}:${txId}` — sync ซ้ำของ row เดิม = no-op
 *   - ถ้า Binance ไม่มี txId (internal transfer) → fallback ใช้ Binance internal id
 *
 * Scheduler:
 *   - runOnce({ from, to, source }) — sync 1 window
 *   - start() — daily at 00:05 BKK (5 นาทีหลัง walletSnapshot 00:01)
 *   - getDefaultRange() — botFirstStartAt - 3 days → now (กันเติมเงินล่วงหน้า)
 *
 * Notes:
 *   - Network fee: ตามที่ user ตกลง ผมจะ log โครงสร้าง row ตัวอย่าง 1-2 row แรก ก่อนตัดสิน
 *     default = นับ `amount` (gross) — ปรับเป็น `amount + transactionFee` ได้ภายหลัง
 *   - API key ต้องเปิด "Enable Withdrawals/Deposits" permission — Binance ตอบ -2015
 *     ถ้าไม่มีสิทธิ์
 */

const binanceRest = require('../binance/binanceRest');
const CapitalFlow = require('../db/models/CapitalFlow');
const AppConfig = require('../db/models/AppConfig');
const fxService = require('./fxService'); // 2026-10-08: USDT→THB conversion for THB value display
const logger = require('../utils/logger');

const STABLECOINS = new Set([
  'USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USD1', 'USDP',
]);

const KLINE_1H_MAX_AGE_DAYS = 30;
const KLINE_MAX_AGE_1D_DAYS = 730; // Binance 1d history มีให้ ~2 ปี (older than this → 1w)
const KLINE_1W_MAX_AGE_DAYS = 5 * 365;

// Binance SAPI limit: deposit/withdraw history time interval must be 0-90 days
// (error -4047 "Time interval must be within 0-90 days")
// → chunk larger ranges into 90-day windows
const BINANCE_API_MAX_WINDOW_MS = 90 * 86_400_000;
const BINANCE_API_PAGE_SIZE = 1000;

// Default backfill range offset (user configurable via env or settings)
const DEFAULT_BACKFILL_OFFSET_DAYS_BEFORE_START = 3;

// Scheduler
let _schedulerTimeout = null;
let _inFlight = false;
let _lastRunAt = null;
let _lastRunError = null;
let _lastStats = null;
let _stopped = false;

// Price cache: 1 entry per (asset, day-bucket) — same-day transactions share price
// Reuse rate high because users tend to deposit/withdraw many tx on same day
const _priceCache = new Map(); // key = `${asset}:${bucketKey}` → { price, source, ts }

function _priceCacheKey(asset, insertTime) {
  // 1d bucket — same day = same price
  const b = Math.floor(insertTime / 86_400_000);
  return `${asset.toUpperCase()}:${b}`;
}

function _setPriceCache(asset, insertTime, price, source) {
  _priceCache.set(_priceCacheKey(asset, insertTime), { price, source, ts: Date.now() });
  // Cap cache size
  if (_priceCache.size > 5000) {
    const firstKey = _priceCache.keys().next().value;
    _priceCache.delete(firstKey);
  }
}

function _getPriceCache(asset, insertTime) {
  return _priceCache.get(_priceCacheKey(asset, insertTime)) || null;
}

// ─── Time helpers ───────────────────────────────────────────────────────────
function startOfTodayBkk() {
  const now = new Date();
  const bkkMs = now.getTime() + 7 * 60 * 60_000;
  const bkk = new Date(bkkMs);
  const startUtcMs = Date.UTC(
    bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate(),
    -7, 0, 0
  );
  return new Date(startUtcMs);
}

function nextCapitalFlowDelayMs(now = new Date()) {
  // ms until next 00:05 BKK (4 minutes after walletSnapshot 00:01)
  const nowBkkMs = now.getTime() + 7 * 60 * 60_000;
  const bkk = new Date(nowBkkMs);
  const targetBkkY = bkk.getUTCFullYear();
  const targetBkkM = bkk.getUTCMonth();
  const targetBkkD = bkk.getUTCDate();
  const targetUtcMs = Date.UTC(targetBkkY, targetBkkM, targetBkkD, 0, 5, 0) - 7 * 60 * 60_000;
  let delay = targetUtcMs - now.getTime();
  if (delay <= 0) {
    const tomorrowUtcMs = Date.UTC(targetBkkY, targetBkkM, targetBkkD + 1, 0, 5, 0) - 7 * 60 * 60_000;
    delay = tomorrowUtcMs - now.getTime();
  }
  return delay;
}

// ─── botFirstStartAt — once-only init ──────────────────────────────────────
async function ensureBotFirstStartAt() {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (cfg && cfg.botFirstStartAt) {
      return new Date(cfg.botFirstStartAt);
    }
    // First-ever startup — set now
    const now = new Date();
    await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: { botFirstStartAt: now } },
      { new: true, upsert: true }
    );
    logger.info({ botFirstStartAt: now.toISOString() }, 'capitalFlow: botFirstStartAt set (first boot)');
    return now;
  } catch (err) {
    logger.warn({ err: err.message }, 'capitalFlow: ensureBotFirstStartAt failed — fallback now()');
    return new Date();
  }
}

/**
 * 2026-10-08: Read capital-flow config (for UI Settings modal).
 * Returns: { botFirstStartAt, defaultRange: { from, to } }
 */
async function getConfig() {
  const start = await ensureBotFirstStartAt();
  const from = new Date(start.getTime() - DEFAULT_BACKFILL_OFFSET_DAYS_BEFORE_START * 86_400_000);
  const to = new Date();
  return {
    botFirstStartAt: start.toISOString(),
    defaultRange: { from: from.toISOString(), to: to.toISOString() },
    backfillOffsetDaysBeforeStart: DEFAULT_BACKFILL_OFFSET_DAYS_BEFORE_START,
    ts: Date.now(),
  };
}

/**
 * 2026-10-08: Set botFirstStartAt manually (for UI Settings modal).
 * Validates: must be a valid Date, must be <= now, must be >= 2017-01-01 (Binance launch).
 * Persists to AppConfig.botFirstStartAt.
 */
async function setBotFirstStartAt(input) {
  if (!input) throw new Error('botFirstStartAt is required');
  let d;
  if (input instanceof Date) d = input;
  else d = new Date(input);
  if (isNaN(d.getTime())) throw new Error('botFirstStartAt is unparseable');
  const ms = d.getTime();
  if (ms < 1483228800000) throw new Error('botFirstStartAt must be >= 2017-01-01 (Binance launch)');
  if (ms > Date.now()) throw new Error('botFirstStartAt must be <= now');
  await AppConfig.findOneAndUpdate(
    { key: 'singleton' },
    { $set: { botFirstStartAt: d } },
    { new: true, upsert: true }
  );
  // Invalidate any in-memory price cache that used the old range (rare — but safe)
  clearPriceCache();
  logger.info({ botFirstStartAt: d.toISOString() }, 'capitalFlow: botFirstStartAt updated by user');
  return getConfig();
}

async function getDefaultRange() {
  const start = await ensureBotFirstStartAt();
  const from = new Date(start.getTime() - DEFAULT_BACKFILL_OFFSET_DAYS_BEFORE_START * 86_400_000);
  const to = new Date();
  return { from, to };
}

// ─── Price lookup ───────────────────────────────────────────────────────────
async function _getPriceAtTime(asset, insertTime) {
  const a = String(asset || '').toUpperCase();
  if (!a) return { price: 0, source: 'unknown' };
  if (STABLECOINS.has(a)) return { price: 1.0, source: 'stablecoin' };

  // Cache hit
  const cached = _getPriceCache(a, insertTime);
  if (cached) return { price: cached.price, source: cached.source };

  const now = Date.now();
  const ageDays = (now - insertTime) / 86_400_000;
  let interval;
  if (ageDays < KLINE_1H_MAX_AGE_DAYS) interval = '1h';
  else if (ageDays < KLINE_MAX_AGE_1D_DAYS) interval = '1d';
  else interval = '1w';

  // Pick symbol: ASSETUSDT primarily, ASSETBTC×BTCUSDT fallback
  const symbol = `${a}USDT`;
  // window: 1 candle that contains insertTime
  const windowMs = interval === '1h' ? 3_600_000 : interval === '1d' ? 86_400_000 : 7 * 86_400_000;
  const startTime = insertTime - 1;
  const endTime = insertTime + windowMs;
  try {
    const klines = await binanceRest.getKlines({
      symbol,
      interval,
      startTime,
      endTime,
      limit: 1,
    });
    if (Array.isArray(klines) && klines.length > 0) {
      const close = parseFloat(klines[0][4]);
      if (Number.isFinite(close) && close > 0) {
        _setPriceCache(a, insertTime, close, 'kline');
        return { price: close, source: 'kline' };
      }
    }
  } catch (err) {
    logger.warn({ asset: a, interval, err: err.message }, 'capitalFlow: kline fetch failed, will try fallback');
  }

  // Fallback: current price
  try {
    const ticker = await binanceRest.getBookTicker(symbol);
    if (ticker && ticker.bidPrice) {
      const price = parseFloat(ticker.bidPrice);
      if (Number.isFinite(price) && price > 0) {
        _setPriceCache(a, insertTime, price, 'current');
        return { price, source: 'current' };
      }
    }
  } catch (err) {
    logger.warn({ asset: a, err: err.message }, 'capitalFlow: current price fallback failed');
  }

  // Last resort: mark as fallback with price 0 (caller will treat as "unknown")
  return { price: 0, source: 'fallback' };
}

// ─── Row conversion ─────────────────────────────────────────────────────────
/**
 * Parse Binance time field — could be either:
 *   - ms epoch (number)         e.g. 1787111621000
 *   - ISO/datetime string       e.g. "2026-05-25 04:28:22"  (withdrawal applyTime)
 *   - undefined / null
 * Returns { ok: true, date } or { ok: false, reason }.
 */
function _parseBinanceTime(value) {
  if (value == null || value === '') return { ok: false, reason: 'missing' };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: 'invalid_number' };
    return { ok: true, date: new Date(value) };
  }
  if (typeof value === 'string') {
    // Replace ' ' with 'T' to make it ISO-compatible
    const iso = value.includes('T') ? value : value.replace(' ', 'T');
    const d = new Date(iso);
    if (!isNaN(d.getTime()) && d.getTime() > 0) {
      return { ok: true, date: d };
    }
    // Some Binance fields are ms epoch as string
    const asNum = Number(value);
    if (Number.isFinite(asNum) && asNum > 0) {
      return { ok: true, date: new Date(asNum) };
    }
    return { ok: false, reason: 'unparseable_string' };
  }
  return { ok: false, reason: 'unsupported_type' };
}

function _normalizeDepositRow(raw) {
  // Binance response (capital/deposit/hisrec):
  //   { id, amount, coin, network, status, address, addressTag, txId,
  //     insertTime: <ms-epoch-number>,
  //     transferType, confirmTimes, unlockConfirm, walletType,
  //     completeTime, travelRuleStatus }
  // status: 0=pending, 1=success, 2=failed
  const t = _parseBinanceTime(raw.insertTime);
  if (!t.ok) {
    return { skip: true, reason: `deposit insertTime ${t.reason}: ${raw.insertTime}` };
  }
  const amount = parseFloat(raw.amount) || 0;
  const binanceId = String(raw.id || '');
  const txId = String(raw.txId || '') || binanceId;
  return {
    key: `deposit:${txId}`,
    type: 'deposit',
    asset: String(raw.coin || '').toUpperCase(),
    amount,
    transactionFee: 0, // deposits don't have fee
    insertTime: t.date,
    txId,
    binanceId,
    network: String(raw.network || ''),
    status: String(raw.status ?? ''),
    walletType: String(raw.walletType || ''),
    transferType: String(raw.transferType ?? ''),
    raw,
  };
}

function _normalizeWithdrawRow(raw) {
  // Binance response (capital/withdraw/history):
  //   { id, amount, transactionFee, coin, status, address, txId,
  //     applyTime: <string "YYYY-MM-DD HH:MM:SS">,  ← NOT ms epoch!
  //     completeTime: <string>,
  //     network, transferType, info, confirmNo, walletType, txKey, ... }
  // status: 0=email-sent, 1=cancelled, 2=awaiting approval, 3=rejected,
  //         4=processing, 5=failure, 6=completed
  // Per user decision 2026-10-08: amount = gross (what user clicked)
  const t = _parseBinanceTime(raw.applyTime);
  if (!t.ok) {
    return { skip: true, reason: `withdraw applyTime ${t.reason}: ${raw.applyTime}` };
  }
  const amount = parseFloat(raw.amount) || 0;
  const transactionFee = parseFloat(raw.transactionFee) || 0;
  const binanceId = String(raw.id || '');
  const txId = String(raw.txId || raw.id || '') || binanceId;
  return {
    key: `withdraw:${txId}`,
    type: 'withdraw',
    asset: String(raw.coin || '').toUpperCase(),
    amount,
    transactionFee,
    insertTime: t.date,
    txId,
    binanceId,
    network: String(raw.network || ''),
    status: String(raw.status ?? ''),
    walletType: String(raw.walletType ?? ''),
    transferType: String(raw.transferType ?? ''),
    raw,
  };
}

// ─── Sync core ──────────────────────────────────────────────────────────────
/**
 * Split [fromMs, toMs] into 90-day chunks (Binance SAPI hard cap).
 * Returns array of { fromMs, toMs } pairs.
 */
function _chunkWindows(fromMs, toMs) {
  const windows = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const end = Math.min(cursor + BINANCE_API_MAX_WINDOW_MS, toMs);
    windows.push({ fromMs: cursor, toMs: end });
    cursor = end + 1; // avoid overlap at boundary
  }
  return windows;
}

/**
 * Sync deposit/withdraw rows from Binance within [fromMs, toMs] window.
 * Idempotent — re-running for same window is no-op.
 *
 * @param {Object} opts
 * @param {Date} [opts.from] - window start (ms). Default: botFirstStartAt - 3 days
 * @param {Date} [opts.to] - window end. Default: now
 * @param {string} [opts.source] - 'manual' | 'scheduler' | 'backfill'
 * @returns {Promise<{ok: boolean, deposits: {fetched, upserted}, withdraws: {fetched, upserted}, error?: string}>}
 */
async function syncFromBinance(opts = {}) {
  if (_inFlight) {
    return { ok: false, error: 'in_flight' };
  }
  _inFlight = true;
  const startMs = Date.now();
  try {
    const defaultRange = await getDefaultRange();
    const from = opts.from || defaultRange.from;
    const to = opts.to || defaultRange.to;
    const source = opts.source || 'manual';

    const fromMs = from.getTime();
    const toMs = to.getTime();

    logger.info({
      from: from.toISOString(),
      to: to.toISOString(),
      source,
    }, 'capitalFlow: sync start');

    const windows = _chunkWindows(fromMs, toMs);
    logger.info({ windowCount: windows.length }, 'capitalFlow: chunked into 90d windows');

    const stats = {
      deposits: { fetched: 0, upserted: 0, skipped: 0, failed: 0, windows: 0 },
      withdraws: { fetched: 0, upserted: 0, skipped: 0, failed: 0, windows: 0 },
    };

    // ── Fetch deposits per window ──
    // Binance SAPI doesn't reliably support `offset` together with `startTime`,
    // so we chunk by 90-day windows and rely on per-window < 1000 rows.
    // If a window returns exactly 1000 rows, log a warning (potential data loss).
    try {
      for (const win of windows) {
        const rows = await binanceRest.getDepositHistory({
          startTime: win.fromMs,
          endTime: win.toMs,
          limit: BINANCE_API_PAGE_SIZE,
          status: 1, // success only
        });
        stats.deposits.windows += 1;
        if (!Array.isArray(rows) || rows.length === 0) continue;
        if (rows.length === BINANCE_API_PAGE_SIZE) {
          logger.warn({ from: win.fromMs, to: win.toMs }, 'capitalFlow: deposit window returned exactly 1000 rows — possible data loss, narrow the window');
        }
        stats.deposits.fetched += rows.length;
        for (const raw of rows) {
          try {
            const normalized = _normalizeDepositRow(raw);
            if (normalized && normalized.skip) {
              stats.deposits.skipped += 1;
              logger.warn({ id: raw.id, coin: raw.coin }, `capitalFlow: deposit row skipped — ${normalized.reason}`);
              continue;
            }
            const { usdtValue } = await _convertAndUpsert(normalized);
            if (usdtValue != null) stats.deposits.upserted += 1;
            else stats.deposits.failed += 1;
          } catch (err) {
            stats.deposits.failed += 1;
            logger.warn({ err: err.message, raw: { id: raw.id, coin: raw.coin, txId: raw.txId } }, 'capitalFlow: deposit row failed');
          }
        }
      }
    } catch (err) {
      if (err && err.code === -2015) {
        logger.warn({ code: err.code, msg: err.msg }, 'capitalFlow: deposit sync skipped (API key missing "Enable Withdrawals" permission)');
      } else if (err && err.code === -4047) {
        logger.warn({ code: err.code, msg: err.msg }, 'capitalFlow: deposit sync — window too wide (Binance 90d limit)');
      } else {
        logger.error({ err: err.message, code: err.code }, 'capitalFlow: deposit sync failed');
      }
    }

    // ── Fetch withdraws per window ──
    try {
      for (const win of windows) {
        const rows = await binanceRest.getWithdrawHistory({
          startTime: win.fromMs,
          endTime: win.toMs,
          limit: BINANCE_API_PAGE_SIZE,
        });
        stats.withdraws.windows += 1;
        if (!Array.isArray(rows) || rows.length === 0) continue;
        if (rows.length === BINANCE_API_PAGE_SIZE) {
          logger.warn({ from: win.fromMs, to: win.toMs }, 'capitalFlow: withdraw window returned exactly 1000 rows — possible data loss, narrow the window');
        }
        stats.withdraws.fetched += rows.length;
        for (const raw of rows) {
          try {
            const normalized = _normalizeWithdrawRow(raw);
            if (normalized && normalized.skip) {
              stats.withdraws.skipped += 1;
              logger.warn({ id: raw.id, coin: raw.coin }, `capitalFlow: withdraw row skipped — ${normalized.reason}`);
              continue;
            }
            const { usdtValue } = await _convertAndUpsert(normalized);
            if (usdtValue != null) stats.withdraws.upserted += 1;
            else stats.withdraws.failed += 1;
          } catch (err) {
            stats.withdraws.failed += 1;
            logger.warn({ err: err.message, raw: { id: raw.id, coin: raw.coin, txId: raw.txId } }, 'capitalFlow: withdraw row failed');
          }
        }
      }
    } catch (err) {
      if (err && err.code === -2015) {
        logger.warn({ code: err.code, msg: err.msg }, 'capitalFlow: withdraw sync skipped (API key missing permission)');
      } else if (err && err.code === -4047) {
        logger.warn({ code: err.code, msg: err.msg }, 'capitalFlow: withdraw sync — window too wide (Binance 90d limit)');
      } else {
        logger.error({ err: err.message, code: err.code }, 'capitalFlow: withdraw sync failed');
      }
    }

    _lastRunAt = new Date();
    _lastRunError = null;
    _lastStats = { ...stats, fromMs, toMs, source, durationMs: Date.now() - startMs };
    logger.info({ stats: _lastStats }, 'capitalFlow: sync done');
    return { ok: true, ...stats };
  } catch (err) {
    _lastRunError = err.message;
    logger.error({ err: err.message, stack: err.stack }, 'capitalFlow: sync failed');
    return { ok: false, error: err.message };
  } finally {
    _inFlight = false;
  }
}

async function _convertAndUpsert(normalized) {
  // Convert to USDT @ insertTime
  const insertTimeMs = normalized.insertTime.getTime();
  // Defensive: ensure insertTime is sane (not 1970, not future)
  if (!Number.isFinite(insertTimeMs) || insertTimeMs < 946684800000) { // < year 2000
    logger.warn({ key: normalized.key }, 'capitalFlow: row skipped — insertTime too old/invalid');
    return { usdtValue: null, priceUsdt: 0, priceSource: 'invalid_time' };
  }
  const { price, source: priceSource } = await _getPriceAtTime(normalized.asset, insertTimeMs);

  if (price <= 0) {
    logger.warn({
      type: normalized.type,
      asset: normalized.asset,
      txId: normalized.txId,
    }, 'capitalFlow: no price available — row skipped');
    return { usdtValue: null, priceUsdt: 0, priceSource };
  }

  // Per user decision 2026-10-08: amount = gross (what user clicked)
  // For withdraw: amount is already net of fee per Binance convention
  //   (Binance deduces fee from amount, sends amount - fee to user)
  // For deposit: amount is the full amount received
  const usdtValueRaw = normalized.amount * price;
  // Sign: deposit = +, withdraw = -
  const sign = normalized.type === 'deposit' ? 1 : -1;
  const usdtValue = usdtValueRaw * sign;

  // Upsert by key
  await CapitalFlow.updateOne(
    { key: normalized.key },
    {
      $set: {
        type: normalized.type,
        asset: normalized.asset,
        amount: normalized.amount,
        transactionFee: normalized.transactionFee,
        usdtValue: Number(usdtValue.toFixed(6)),
        priceUsdt: Number(price.toFixed(8)),
        priceSource,
        insertTime: normalized.insertTime,
        txId: normalized.txId,
        binanceId: normalized.binanceId,
        network: normalized.network,
        status: normalized.status,
        walletType: normalized.walletType,
        transferType: normalized.transferType,
        raw: normalized.raw,
        syncedAt: new Date(),
      },
      $setOnInsert: {
        key: normalized.key,
      },
    },
    { upsert: true }
  );
  return { usdtValue, priceUsdt: price, priceSource };
}

// ─── Summary + List queries ─────────────────────────────────────────────────
async function getSummary({ from, to } = {}) {
  const match = {};
  if (from || to) {
    match.insertTime = {};
    if (from) match.insertTime.$gte = from;
    if (to) match.insertTime.$lte = to;
  }
  const result = await CapitalFlow.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$type',
        totalUsdt: { $sum: '$usdtValue' },
        count: { $sum: 1 },
      },
    },
  ]);
  let totalDepositUsdt = 0;
  let totalWithdrawUsdt = 0;
  let depositCount = 0;
  let withdrawCount = 0;
  for (const r of result) {
    if (r._id === 'deposit') {
      totalDepositUsdt = Math.abs(r.totalUsdt);
      depositCount = r.count;
    } else if (r._id === 'withdraw') {
      totalWithdrawUsdt = Math.abs(r.totalUsdt);
      withdrawCount = r.count;
    }
  }
  const netDepositedUsdt = totalDepositUsdt - totalWithdrawUsdt;

  // By coin (deposit only — what user put in)
  const byCoin = await CapitalFlow.aggregate([
    { $match: { ...match, type: 'deposit' } },
    {
      $group: {
        _id: '$asset',
        totalAmount: { $sum: '$amount' },
        totalUsdt: { $sum: '$usdtValue' },
        count: { $sum: 1 },
      },
    },
    { $sort: { totalUsdt: -1 } },
  ]);

  // FX rate for THB conversion (best-effort; null if fxService unavailable)
  let fxRate = null;
  let fxSource = null;
  let fxStale = false;
  try {
    const fx = await fxService.getUsdtToThb();
    if (fx && Number(fx.rate) > 0) {
      fxRate = Number(fx.rate);
      fxSource = fx.source || null;
      fxStale = fx.stale === true;
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'capitalFlow: fxService failed — USDT only');
  }

  const totalDepositUsdtThb = fxRate ? totalDepositUsdt * fxRate : null;
  const totalWithdrawUsdtThb = fxRate ? totalWithdrawUsdt * fxRate : null;
  const netDepositedUsdtThb = fxRate ? netDepositedUsdt * fxRate : null;

  return {
    totalDepositUsdt: Number(totalDepositUsdt.toFixed(6)),
    totalWithdrawUsdt: Number(totalWithdrawUsdt.toFixed(6)),
    netDepositedUsdt: Number(netDepositedUsdt.toFixed(6)),
    totalDepositUsdtThb: totalDepositUsdtThb != null ? Number(totalDepositUsdtThb.toFixed(2)) : null,
    totalWithdrawUsdtThb: totalWithdrawUsdtThb != null ? Number(totalWithdrawUsdtThb.toFixed(2)) : null,
    netDepositedUsdtThb: netDepositedUsdtThb != null ? Number(netDepositedUsdtThb.toFixed(2)) : null,
    depositCount,
    withdrawCount,
    byCoin: byCoin.map((c) => ({
      asset: c._id,
      totalAmount: Number(c.totalAmount.toFixed(8)),
      totalUsdt: Number(c.totalUsdt.toFixed(6)),
      totalUsdtThb: fxRate ? Number((c.totalUsdt * fxRate).toFixed(2)) : null,
      count: c.count,
    })),
    fxRate,
    fxSource,
    fxStale,
    range: { from, to },
    ts: Date.now(),
  };
}

async function getList({ from, to, type, asset, limit = 100, skip = 0 } = {}) {
  const q = {};
  if (from || to) {
    q.insertTime = {};
    if (from) q.insertTime.$gte = from;
    if (to) q.insertTime.$lte = to;
  }
  if (type) q.type = type;
  if (asset) q.asset = String(asset).toUpperCase();
  const total = await CapitalFlow.countDocuments(q);
  const rows = await CapitalFlow.find(q)
    .sort({ insertTime: -1 })
    .skip(Math.max(0, skip))
    .limit(Math.min(500, Math.max(1, limit)))
    .lean();

  // FX rate for THB conversion (best-effort; null if unavailable)
  let fxRate = null;
  try {
    const fx = await fxService.getUsdtToThb();
    if (fx && Number(fx.rate) > 0) fxRate = Number(fx.rate);
  } catch (err) {
    // silent — list still works without THB
  }

  return {
    rows: rows.map((r) => ({
      key: r.key,
      type: r.type,
      asset: r.asset,
      amount: r.amount,
      transactionFee: r.transactionFee,
      usdtValue: r.usdtValue,
      usdtValueThb: fxRate ? Number((r.usdtValue * fxRate).toFixed(2)) : null,
      priceUsdt: r.priceUsdt,
      priceUsdtThb: fxRate ? Number((r.priceUsdt * fxRate).toFixed(2)) : null,
      priceSource: r.priceSource,
      insertTime: r.insertTime,
      txId: r.txId,
      network: r.network,
      status: r.status,
    })),
    total,
    limit: Math.min(500, Math.max(1, limit)),
    skip: Math.max(0, skip),
    fxRate,
    ts: Date.now(),
  };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────
async function runOnce(opts = {}) {
  return syncFromBinance(opts);
}

function _scheduleNext() {
  if (_stopped) return;
  if (_schedulerTimeout) clearTimeout(_schedulerTimeout);
  const delay = nextCapitalFlowDelayMs();
  logger.info({ delayMs: delay, delayHrs: Number((delay / 3_600_000).toFixed(2)) }, 'capitalFlow: scheduled next run');
  _schedulerTimeout = setTimeout(async () => {
    if (_stopped) return;
    await runOnce({ source: 'scheduler' });
    _schedulerTimeout = setTimeout(_onDailyTick, 24 * 60 * 60 * 1000);
  }, delay);
}

async function _onDailyTick() {
  if (_stopped) return;
  await runOnce({ source: 'scheduler' });
  _schedulerTimeout = setTimeout(_onDailyTick, 24 * 60 * 60 * 1000);
}

async function start() {
  if (_schedulerTimeout) {
    logger.warn('capitalFlow: start() called but already running — no-op');
    return;
  }
  _stopped = false;
  // Ensure botFirstStartAt is set (so defaultRange works for first sync)
  await ensureBotFirstStartAt();
  logger.info('capitalFlow: starting');
  // Schedule next 00:05 BKK
  _scheduleNext();
}

function stop() {
  _stopped = true;
  if (_schedulerTimeout) clearTimeout(_schedulerTimeout);
  _schedulerTimeout = null;
  logger.info('capitalFlow: stopped');
}

function getStatus() {
  return {
    running: !_stopped,
    inFlight: _inFlight,
    lastRunAt: _lastRunAt,
    lastRunError: _lastRunError,
    lastStats: _lastStats,
    nextRunAt: _schedulerTimeout ? new Date(Date.now() + nextCapitalFlowDelayMs()) : null,
  };
}

function clearPriceCache() {
  _priceCache.clear();
}

module.exports = {
  start,
  stop,
  runOnce,
  syncFromBinance,
  getSummary,
  getList,
  getStatus,
  getDefaultRange,
  ensureBotFirstStartAt,
  getConfig,            // 2026-10-08: read config for UI
  setBotFirstStartAt,   // 2026-10-08: update botFirstStartAt from UI
  nextCapitalFlowDelayMs,
  clearPriceCache,
  // exported for tests
  _getPriceAtTime,
  _normalizeDepositRow,
  _normalizeWithdrawRow,
};
