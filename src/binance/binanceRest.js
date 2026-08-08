'use strict';

const axios = require('axios');
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../utils/logger');

// ─── Rate limiter แบบ token bucket ตาม X-MBX-USED-WEIGHT-1M ────
// IP-based REQUEST_WEIGHT limit = 6000/min (verified via GET /api/v3/exchangeInfo.rateLimits)
class RateLimiter {
  constructor({ capacity = 6000, refillPerMs = 6000 / 60000 } = {}) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillPerMs;
    this.lastRefill = Date.now();
  }

  async take(weight = 1) {
    while (true) {
      const now = Date.now();
      const elapsed = now - this.lastRefill;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
      this.lastRefill = now;

      if (this.tokens >= weight) {
        this.tokens -= weight;
        return;
      }

      const needed = weight - this.tokens;
      const waitMs = Math.ceil(needed / this.refillRate);
      logger.debug({ waitMs, weight }, 'rate limit wait');
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  updateFromHeaders(headers) {
    const used = parseInt(headers['x-mbx-used-weight-1m'] || '0', 10);
    // แจ้งเตือนเมื่อใช้เกิน 90% (5400/min) — เลิกรบกวนตอนโหลดปกติ
    if (used > this.capacity * 0.9) {
      logger.warn({ used, capacity: this.capacity }, 'binance weight approaching limit');
    }
    this.tokens = Math.max(0, this.capacity - used);
  }
}

const limiter = new RateLimiter();

// ─── HTTP client ────────────────────────────────────────
const http = axios.create({
  baseURL: config.binanceApi.base,
  timeout: 15000,
  headers: { 'X-MBX-APIKEY': config.binance.apiKey || '' },
});

http.interceptors.response.use(
  (resp) => {
    limiter.updateFromHeaders(resp.headers || {});
    return resp;
  },
  async (err) => {
    if (err.response && err.response.headers) {
      limiter.updateFromHeaders(err.response.headers);
    }
    return Promise.reject(err);
  }
);

// ─── Helpers ────────────────────────────────────────────
function signQuery(queryObj) {
  const qs = new URLSearchParams(queryObj).toString();
  const sig = crypto
    .createHmac('sha256', config.binance.apiSecret || '')
    .update(qs)
    .digest('hex');
  return `${qs}&signature=${sig}`;
}

function nowMs() {
  return Date.now();
}

// ─── FIX-2026-07-14: Binance server-time offset cache ──────────────────────
// - ปัญหา: local clock ดันเร็วกว่า Binance server บางที >1000ms → -1021
//   "Timestamp for this request was 1000ms ahead of the server's time."
//   เคยเห็นทั้ง BUY rejected และ /api/account/balance ตอน WS reconnect ทุกๆ 1–2 นาที
// - แก้: ดึง /api/v3/time (public, ~1 ms) → คำนวณ offset = serverTime - localTime
//        cache 5 นาที → apply offset ใน signedRequest timestamp
// - ถ้า fetch fail (network blip) → fallback ใช้ local time (ปลอดภัยกว่า error)
let _timeOffsetMs = 0;
let _timeOffsetFetchedAt = 0;
const TIME_OFFSET_TTL_MS = 5 * 60 * 1000;

async function refreshServerTimeOffset() {
  try {
    const t = await getServerTime();
    const localAt = Date.now();
    _timeOffsetMs = t - localAt;
    _timeOffsetFetchedAt = localAt;
    logger.debug({ offsetMs: _timeOffsetMs }, 'binance: server time offset refreshed');
    return _timeOffsetMs;
  } catch (err) {
    logger.warn({ err: err.message }, 'binance: server time fetch failed, using local clock');
    return _timeOffsetMs; // keep last known offset (or 0)
  }
}

async function ensureTimeOffset() {
  const now = Date.now();
  if (_timeOffsetFetchedAt && (now - _timeOffsetFetchedAt) < TIME_OFFSET_TTL_MS) {
    return _timeOffsetMs;
  }
  return refreshServerTimeOffset();
}

function nowMsBinance() {
  // ใช้สำหรับ signed requests เท่านั้น — apply offset ถ้ามี
  return Date.now() + (_timeOffsetMs || 0);
}

async function publicGet(path, params = {}, weight = 1) {
  await limiter.take(weight);
  const resp = await http.get(path, { params });
  return resp.data;
}

async function signedRequest(method, path, params = {}, weight = 1) {
  if (!config.binance.apiKey || !config.binance.apiSecret) {
    const e = new Error('Binance API keys not configured. Please set BINANCE_API_KEY and BINANCE_API_SECRET in .env or via dashboard.');
    e.code = 'NO_API_KEYS';
    throw e;
  }
  await limiter.take(weight);
  // FIX-2026-07-14: ใช้ Binance-synced timestamp (apply server-time offset) แทน local clock
  //   กัน -1021 "Timestamp ahead of server" ที่เคยเกิดกับทั้ง BUY และ /api/account/balance
  await ensureTimeOffset();
  const q = { ...params, recvWindow: config.binance.recvWindow, timestamp: nowMsBinance() };
  const qs = signQuery(q);

  const url = `${path}?${qs}`;
  // FIX 2026-07-12: signedRequest เดิมใช้ http.post() สำหรับ DELETE ทุก call → Binance ตอบ -1102/-1104
  //   เพราะมันไปยิง POST /api/v3/order (ที่คาดหวัง order placement params) ไม่ใช่ DELETE /api/v3/order
  //   (axios.post() ตั้ง method=POST, ส่ง body='', header Content-Length=0 — Binance ก็ยัง parse เป็น POST)
  const execCall = () => {
    if (method === 'GET') return http.get(url);
    if (method === 'DELETE') return http.delete(url);
    return http.post(url, '');
  };

  try {
    const resp = await execCall();
    return resp.data;
  } catch (err) {
    // FIX-2026-07-14: -1021 = timestamp เกิน recvWindow — ลอง re-sync time แล้ว retry 1 ครั้ง
    const data = err.response && err.response.data;
    if (data && data.code === -1021) {
      logger.warn({ code: -1021, msg: data.msg }, 'binance: -1021 timestamp drift — re-syncing and retrying once');
      await refreshServerTimeOffset();
      // re-build query string with FRESH offset (timestamp + signature)
      const retryQ = { ...params, recvWindow: config.binance.recvWindow, timestamp: nowMsBinance() };
      const retryQs = signQuery(retryQ);
      const retryUrl = `${path}?${retryQs}`;
      try {
        let retryResp;
        if (method === 'GET') retryResp = await http.get(retryUrl);
        else if (method === 'DELETE') retryResp = await http.delete(retryUrl);
        else retryResp = await http.post(retryUrl, '');
        return retryResp.data;
      } catch (retryErr) {
        // ส่งต่อให้ caller log/handle
        throw retryErr;
      }
    }
    throw err;
  }
}

// ─── Public endpoints ───────────────────────────────────
async function ping() {
  await limiter.take(1);
  const resp = await http.get('/api/v3/ping');
  return resp.data;
}

async function getServerTime() {
  const resp = await publicGet('/api/v3/time');
  return resp.serverTime;
}

async function getExchangeInfo({ symbol = null } = {}) {
  const params = {};
  if (symbol) params.symbol = symbol;
  return publicGet('/api/v3/exchangeInfo', params, 20);
}

async function getKlines({ symbol, interval, startTime, endTime, limit = 500 }) {
  const params = { symbol, interval, limit };
  if (startTime) params.startTime = startTime;
  if (endTime) params.endTime = endTime;
  return publicGet('/api/v3/klines', params, 2);
}

/**
 * Fetch up to `totalLimit` klines for a symbol, paginating past Binance's
 * single-call cap of 1000 bars by walking backward with endTime.
 *
 * - Each batch is up to 1000 bars (Binance silent-cap).
 * - Loop terminates when batch < batchLimit (ran out of history) or
 *   enough bars have been collected.
 * - Returns bars in ascending openTime order (oldest first).
 *
 * Cost: 1 weight-2 call per 1000 bars. For window=15000 / 3m tf:
 *   15 calls × 50 symbols × 2 weight = 1500 weight — well under the
 *   6000/min cap, safe for occasional deep scans.
 */
async function getKlinesPaginated({ symbol, interval, totalLimit, batchLimit = 1000 }) {
  if (!Number.isFinite(totalLimit) || totalLimit <= 0) {
    throw new Error('getKlinesPaginated: totalLimit must be a positive number');
  }
  if (totalLimit <= batchLimit) {
    // Single batch — fast path, no endTime needed
    const batch = await getKlines({ symbol, interval, limit: totalLimit });
    return batch;
  }

  const collected = [];
  let endTime = null; // null = "to now"
  // Hard upper bound on iterations as a safety net
  const maxIterations = Math.ceil(totalLimit / batchLimit) + 2;

  for (let i = 0; i < maxIterations; i += 1) {
    const remaining = totalLimit - collected.length;
    if (remaining <= 0) break;
    const want = Math.min(batchLimit, remaining);
    const params = { symbol, interval, limit: want };
    if (endTime !== null) params.endTime = endTime;

    const batch = await getKlines(params);
    if (!Array.isArray(batch) || batch.length === 0) break;

    collected.push(...batch);
    // Next batch ends just before the oldest bar of this batch
    endTime = batch[0][0] - 1;

    // If Binance returned fewer than requested, we've reached the start
    // of available history for this symbol.
    if (batch.length < want) break;
  }

  // De-duplicate by openTime + sort asc (defensive: should already be in order)
  const seen = new Set();
  const dedup = [];
  for (const k of collected) {
    if (!seen.has(k[0])) { seen.add(k[0]); dedup.push(k); }
  }
  dedup.sort((a, b) => a[0] - b[0]);
  return dedup;
}

/**
 * 24hr ticker statistics — returns rolling-window stats for ALL symbols
 * (or one symbol when specified).
 *
 * Per Binance docs:
 *   - No-symbol form: weight 80, returns array of ALL spot symbols.
 *     Useful for ranking the entire USDT market by quoteVolume.
 *   - Specific-symbol form: weight 2, returns single object.
 *
 * Each entry: { symbol, priceChange, priceChangePercent, weightedAvgPrice,
 *   prevClosePrice, lastPrice, lastQty, bidPrice, bidQty, askPrice, askQty,
 *   openPrice, highPrice, lowPrice, volume, quoteVolume, openTime, closeTime,
 *   firstId, lastId, count }
 */
async function get24hrTickers({ symbol = null } = {}) {
  const params = {};
  if (symbol) params.symbol = symbol;
  const weight = symbol ? 2 : 80;
  return publicGet('/api/v3/ticker/24hr', params, weight);
}

// FIX-2026-07-24: bookTicker (best bid/ask) — ใช้ refresh stale bookTicker ก่อน retry
//   weight = 2 per symbol (per Binance API docs)
async function getBookTicker(symbol) {
  if (!symbol) throw new Error('getBookTicker: symbol required');
  return publicGet('/api/v3/ticker/bookTicker', { symbol }, 2);
}

// ─── Public endpoints (X-MBX-APIKEY only, no signature) ─────────────────
// FIX-2026-08-06: Get Spot Delist Schedule
//   - endpoint: GET https://api.binance.com/sapi/v1/spot/delist-schedule
//   - auth: API key in X-MBX-APIKEY header (no signature, no HMAC)
//   - weight: 100 (IP-based) — cache recommended (we use 30min)
//   - response: [{ delistTime: int64_ms, symbols: ['VICUSDT', ...] }, ...]
//   - empty array = no symbols scheduled for delisting
async function getSpotDelistSchedule() {
  await limiter.take(100);
  // sapi endpoints use the same axios instance — base URL is api.binance.com (config.binanceApi.base)
  const resp = await http.get('/sapi/v1/spot/delist-schedule');
  if (!Array.isArray(resp.data)) {
    // defensive: some proxies wrap responses
    if (resp.data && Array.isArray(resp.data.data)) return resp.data.data;
    return [];
  }
  return resp.data;
}

// ─── Signed endpoints ───────────────────────────────────
async function getAccount() {
  return signedRequest('GET', '/api/v3/account', {}, 20);
}

async function newOrder(params) {
  return signedRequest('POST', '/api/v3/order', params, 1);
}

async function cancelOrder({ symbol, orderId = null, origClientOrderId = null }) {
  // Per Binance Spot API docs (Cancel Order trade):
  //   mandatory: symbol + (orderId OR origClientOrderId)
  //   optional:  newClientOrderId, recvWindow, timestamp
  // หมายเหตุสำคัญ: signedRequest เดิมมี bug ที่ใช้ http.post() สำหรับ DELETE → Binance ตอบ -1102/-1104
  //   เพราะมันไปยิง POST /api/v3/order ซึ่งคาดหวัง order placement params
  //   ตอนนี้ signedRequest แยก method ถูกต้องแล้ว (FIX 2026-07-12)
  const params = { symbol };
  if (orderId) params.orderId = orderId;
  if (origClientOrderId) params.origClientOrderId = origClientOrderId;
  return signedRequest('DELETE', '/api/v3/order', params, 1);
}

async function getOrder({ symbol, orderId = null, origClientOrderId = null }) {
  const params = { symbol };
  if (orderId) params.orderId = orderId;
  if (origClientOrderId) params.origClientOrderId = origClientOrderId;
  return signedRequest('GET', '/api/v3/order', params, 4);
}

async function getOpenOrders({ symbol = null } = {}) {
  const params = symbol ? { symbol } : {};
  return signedRequest('GET', '/api/v3/openOrders', params, symbol ? 6 : 80);
}

async function cancelAllOpenOrders({ symbol }) {
  return signedRequest('DELETE', '/api/v3/openOrders', { symbol }, 1);
}

// ─── User Data Stream via WebSocket API (new, post Feb 2026) ─────
// Replaces the legacy listenKey flow (POST/PUT/DELETE /api/v3/userDataStream)
// which was discontinued by Binance in February 2026.
// Per Binance WebSocket API docs (HMAC signing section):
//   "Take all request params EXCEPT signature, sort alphabetically by name,
//    format as key=value joined by &, then HMAC-SHA-256 with secretKey → hex."
// For userDataStream.subscribe.signature, params = { apiKey, recvWindow, timestamp }.
// After sorting alphabetically: apiKey < recvWindow < timestamp.
// So the signed string is: apiKey=<key>&recvWindow=<rw>&timestamp=<ms>
async function signUserStreamParams() {
  if (!config.binance.apiKey || !config.binance.apiSecret) {
    throw new Error('Binance API keys not configured');
  }
  // FIX-2026-07-14: ใช้ Binance-synced timestamp (apply server-time offset) — same root cause fix
  await ensureTimeOffset();
  const timestamp = nowMsBinance();
  const recvWindow = config.binance.recvWindow;
  // IMPORTANT: must include ALL params except signature in the signed string,
  // sorted alphabetically (apiKey, recvWindow, timestamp).
  const qs = `apiKey=${config.binance.apiKey}&recvWindow=${recvWindow}&timestamp=${timestamp}`;
  const signature = crypto
    .createHmac('sha256', config.binance.apiSecret)
    .update(qs)
    .digest('hex');
  return {
    apiKey: config.binance.apiKey,
    timestamp,
    signature,
    recvWindow,
  };
}

// ─── User Data Stream (listenKey) ───────────────────────
async function createListenKey() {
  if (!config.binance.apiKey) throw new Error('API key required');
  await limiter.take(1);
  const resp = await http.post('/api/v3/userDataStream', '');
  return resp.data.listenKey;
}

async function keepaliveListenKey(listenKey) {
  if (!config.binance.apiKey) throw new Error('API key required');
  await limiter.take(1);
  const resp = await http.put(`/api/v3/userDataStream?listenKey=${listenKey}`);
  return resp.data;
}

async function closeListenKey(listenKey) {
  if (!config.binance.apiKey) return;
  await limiter.take(1);
  try {
    await http.delete(`/api/v3/userDataStream?listenKey=${listenKey}`);
  } catch (err) {
    logger.warn({ err: err.message }, 'closeListenKey failed (ignore)');
  }
}

// ─── Error mapping ─────────────────────────────────────
function formatBinanceError(err) {
  const status = err.response ? err.response.status : null;
  const data = err.response ? err.response.data : null;
  if (data && typeof data === 'object') {
    return {
      status,
      code: data.code,
      msg: data.msg,
      raw: data,
    };
  }
  return { status, code: null, msg: err.message, raw: null };
}

module.exports = {
  ping,
  getServerTime,
  getExchangeInfo,
  getKlines,
  getKlinesPaginated,
  get24hrTickers,
  getBookTicker,
  getSpotDelistSchedule,  // FIX-2026-08-06: delist schedule for bot filter
  getAccount,
  newOrder,
  cancelOrder,
  getOrder,
  getOpenOrders,
  cancelAllOpenOrders,
  createListenKey,
  keepaliveListenKey,
  closeListenKey,
  signUserStreamParams,
  formatBinanceError,
  signQuery,
  nowMs,
  nowMsBinance,           // FIX-2026-07-14: export �ำหรับ signed timestamps
  refreshServerTimeOffset,// FIX-2026-07-14: export สำหรับ one-shot sync (เช่นตอน botManager.start)
  ensureTimeOffset,
};