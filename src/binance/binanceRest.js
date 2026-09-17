'use strict';

const axios = require('axios');
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../utils/logger');

// ─── Circuit breaker — FIX-2026-08-22 (weight spike protection) ────────
// ป้องกัน burst ที่ทำให้ weight พุ่งเกิน capacity แล้ว Binance ตอบ 429/418
// - States: closed (normal) → open (block non-critical) → half-open (test) → closed
// - ตรวจจาก X-MBX-USED-WEIGHT-1M header ใน updateFromHeaders()
// - Trigger: open เมืือ used > 95% capacity × 5 ตัวอย่างติดต่อกัน (~5s ที่ traffic ปกติ)
// - Recovery: half-open หลัง cooldownMs (30s), ถ้า used < 95% → closed
// - critical=true (BUY/SELL) bypass เสมอ — order placement ต้องทำงาน
// - export _CircuitBreaker class สำหรับ tests
class CircuitBreaker {
  constructor({ thresholdPct = 0.95, consecutiveRequired = 5, cooldownMs = 30000 } = {}) {
    this.thresholdPct = thresholdPct;
    this.consecutiveRequired = consecutiveRequired;
    this.cooldownMs = cooldownMs;
    this.state = 'closed';           // 'closed' | 'open' | 'half-open'
    this.openedAt = 0;
    this.consecutiveHighUsed = 0;
    this.usedPct = 0;
  }

  /**
   * Feed a usage sample (used weight / capacity ratio).
   * Returns the resulting state.
   */
  recordUsage(usedPct) {
    this.usedPct = usedPct;
    const overThreshold = usedPct > this.thresholdPct;

    if (this.state === 'closed') {
      if (overThreshold) {
        this.consecutiveHighUsed += 1;
        if (this.consecutiveHighUsed >= this.consecutiveRequired) {
          this._open();
        }
      } else {
        this.consecutiveHighUsed = 0;
      }
    } else if (this.state === 'open') {
      // Check if cooldown elapsed
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half-open';
        // Allow ONE test request — half-open immediately becomes open again on next over-threshold sample
      }
    } else if (this.state === 'half-open') {
      if (overThreshold) {
        // Test failed — back to open with reset timer
        this._open();
      } else {
        // Test passed — close
        this.state = 'closed';
        this.consecutiveHighUsed = 0;
      }
    }
    return this.state;
  }

  _open() {
    this.state = 'open';
    this.openedAt = Date.now();
    this.consecutiveHighUsed = 0;
  }

  /**
   * Whether take() should throw for a non-critical request.
   * Lazy transition open → half-open if cooldown elapsed.
   */
  isOpen() {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half-open';
        return false; // allow one request through
      }
      return true;
    }
    return false;
  }

  /**
   * Snapshot for status() and dashboard.
   */
  snapshot() {
    const cooldownRemainingMs = this.state === 'open'
      ? Math.max(0, this.cooldownMs - (Date.now() - this.openedAt))
      : 0;
    return {
      state: this.state,
      openedAt: this.openedAt,
      cooldownRemainingMs,
      consecutiveHighUsed: this.consecutiveHighUsed,
      usedPct: Number(this.usedPct.toFixed(4)),
    };
  }

  /**
   * Force close (e.g., for tests or manual reset).
   */
  reset() {
    this.state = 'closed';
    this.openedAt = 0;
    this.consecutiveHighUsed = 0;
    this.usedPct = 0;
  }
}

// ─── Rate limiter แบบ token bucket ตาม X-MBX-USED-WEIGHT-1M ────
// IP-based REQUEST_WEIGHT limit = 6000/min (verified via GET /api/v3/exchangeInfo.rateLimits)
// FIX-2026-08-21: capacity ปรับได้ runtime ผ่าน setCapacity() + src/services/binanceRateLimitConfig
//   กรณี server เดียวรันหลาย instance (หรือหลายระบบ) ให้หาร capacity กัน
//   ตัวอย่าง: 2 ระบบแบ่ง 6000/min → ตั้ง 3000/min ต่อ instance
class RateLimiter {
  constructor({ capacity = 6000, refillPerMs = 6000 / 60000, circuitBreaker = null } = {}) {
    this.capacity = capacity;
    this.refillRate = refillPerMs;
    this.tokens = capacity;
    this.lastRefill = Date.now();
    // FIX-2026-08-22: 418 IP-ban gate — Binance ตอบ 418 พร้อม "IP banned until <ms>"
    //   เดิม rate limiter ไม่รู้จัก → ยิงต่อระหว่างถูกแบน → ได้ 418 ทุก call + WS ตาย
    //   fix: setBanUntil() จาก response interceptor → take() รอจนกว่า banUntilMs จะ expire
    this.banUntilMs = 0;
    // FIX-2026-08-22: circuit breaker — block non-critical reads เมืือ used ใกล้ capacity
    this.circuitBreaker = circuitBreaker || new CircuitBreaker();
  }

  /**
   * Update capacity (e.g. user changed via Settings → /api/admin/rate-limit).
   * - Recompute refillRate = capacity / 60000 (tokens/ms)
   * - ไม่ reset tokens (preserves in-flight budget) — clamp ให้ไม่เกิน capacity ใหม่
   */
  setCapacity(newCapacity) {
    if (!Number.isFinite(newCapacity) || newCapacity <= 0) return;
    if (newCapacity === this.capacity) return;
    const oldCapacity = this.capacity;
    this.capacity = newCapacity;
    this.refillRate = newCapacity / 60000;
    if (this.tokens > this.capacity) {
      this.tokens = this.capacity;
    }
    logger.info(
      { oldCapacity, newCapacity, refillRate: this.refillRate, tokens: this.tokens },
      'binance: rate limit capacity updated'
    );
  }

  async take(weight = 1, { critical = false } = {}) {
    // FIX-2026-08-22 (weight spike): circuit breaker — block non-critical requests
    //   - ถ้า breaker 'open' และไม่ใช่ critical (BUY/SELL) → throw CIRCUIT_OPEN
    //   - isOpen() มี side-effect: lazy transition open → half-open ถ้า cooldown หมด
    //   - critical=true (order placement) bypass เสมอ → ระบบเทรดไม่หยุดแม้ breaker เปิด
    if (!critical && this.circuitBreaker && this.circuitBreaker.isOpen()) {
      const err = new Error('binance: rate limit circuit breaker open — non-critical request blocked');
      err.code = 'CIRCUIT_OPEN';
      err.circuitSnapshot = this.circuitBreaker.snapshot();
      throw err;
    }

    // FIX-2026-08-22: respect 418 IP ban — wait until banUntilMs expires before queuing
    //   - Binance bans 5min-2hr หลัง weight > capacity
    //   - ยิงต่อระหว่างแบน → 418 ทุก call + log spam + WS disconnect
    //   - cap wait ที่ 5s ต่อรอบเพื่อให้ ban expiry ตรวจใหม่ได้บ่อยๆ
    while (this.banUntilMs && Date.now() < this.banUntilMs) {
      const waitMs = Math.min(5000, this.banUntilMs - Date.now());
      logger.debug({ banUntilMs: this.banUntilMs, waitMs }, 'binance: rate limiter waiting for 418 ban expiry');
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (this.banUntilMs && Date.now() >= this.banUntilMs) {
      logger.info({ previousBanMs: this.banUntilMs }, 'binance: 418 IP ban expired — resuming requests');
      this.banUntilMs = 0;
    }

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
      logger.debug({ waitMs, weight, capacity: this.capacity }, 'rate limit wait');
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  // FIX-2026-08-22: setBanUntil() — set IP-ban expiry from response interceptor
  //   - Binance 418 body: { code: -1003, msg: "Way too much request weight used;
  //     IP banned until <epochMs>. Please use WebSocket Streams..." }
  //   - parse epochMs from msg → set banUntilMs (max wins)
  //   - defensive: reject invalid (NaN, in-past)
  setBanUntil(banMs) {
    if (!Number.isFinite(banMs) || banMs <= Date.now()) return false;
    if (banMs > this.banUntilMs) {
      const prev = this.banUntilMs;
      this.banUntilMs = banMs;
      const waitSec = Math.round((banMs - Date.now()) / 1000);
      logger.warn({ previousBanMs: prev, newBanMs: banMs, waitSec }, 'binance: rate limiter set 418 IP ban until');
      return true;
    }
    return false;
  }

  // FIX-2026-08-22: clearBan() — manually reset (e.g., for tests)
  clearBan() {
    this.banUntilMs = 0;
  }

  updateFromHeaders(headers) {
    const used = parseInt(headers['x-mbx-used-weight-1m'] || '0', 10);
    // แจ้งเตือนเมื่อใช้เกิน 90% ของ capacity — เลิกรบกวนตอนโหลดปกติ
    const warnAt = this.capacity * 0.9;
    if (used > warnAt) {
      logger.warn({ used, capacity: this.capacity }, 'binance weight approaching limit');
    }
    // FIX-2026-08-22: feed circuit breaker — used/capacity ratio drives state machine
    //   - state transitions: closed → open (×5 consecutive) → half-open → closed
    //   - non-critical reads get blocked while 'open'
    if (this.circuitBreaker && this.capacity > 0) {
      const usedPct = used / this.capacity;
      const prevState = this.circuitBreaker.state;
      const nextState = this.circuitBreaker.recordUsage(usedPct);
      if (prevState !== nextState) {
        logger.warn(
          {
            prevState,
            nextState,
            used,
            capacity: this.capacity,
            usedPct: Number(usedPct.toFixed(4)),
            consecutiveHighUsed: this.circuitBreaker.consecutiveHighUsed,
          },
          'binance: circuit breaker state transition'
        );
      }
    }
    // clamp กับ capacity ปัจจุบัน (กรณี capacity ถูกปรับลดแต่ server ยังรายงาน used สูง)
    const cap = Math.max(1, this.capacity);
    this.tokens = Math.max(0, cap - used);
  }

  /**
   * Snapshot สำหรับ status endpoint / telemetry
   * - capacity: ค่าที่ตั้งไว้ (จาก AppConfig.binanceRateLimitPerMin)
   * - used (estimate): capacity - tokens
   * - banUntilMs: 0 = no ban, else epoch ms when 418 IP-ban expires
   * - circuitBreaker: { state, openedAt, cooldownRemainingMs, consecutiveHighUsed, usedPct }
   *   - 'open' = blocking non-critical reads
   *   - 'half-open' = probe in progress
   *   - 'closed' = normal
   */
  status() {
    return {
      capacity: this.capacity,
      refillRate: this.refillRate,
      tokens: this.tokens,
      usedEstimated: Math.max(0, this.capacity - this.tokens),
      lastRefill: this.lastRefill,
      banUntilMs: this.banUntilMs,
      banRemainingSec: this.banUntilMs > Date.now()
        ? Math.round((this.banUntilMs - Date.now()) / 1000)
        : 0,
      circuitBreaker: this.circuitBreaker ? this.circuitBreaker.snapshot() : null,
    };
  }
}

const limiter = new RateLimiter();

// FIX-2026-08-21: helper สำหรับเรียก setCapacity จากภายนอก (route handler + startup boot)
//   ใช้ mutex เพื่อกัน race ตอน 2 process ยิงพร้อมกัน
let _capacityUpdateInflight = null;
function setRateLimitCapacity(newCapacity) {
  if (typeof newCapacity !== 'number' || !Number.isFinite(newCapacity) || newCapacity <= 0) {
    return { ok: false, error: `Invalid capacity: ${newCapacity}` };
  }
  if (_capacityUpdateInflight) return _capacityUpdateInflight;
  _capacityUpdateInflight = (async () => {
    try {
      limiter.setCapacity(newCapacity);
      return { ok: true, capacity: newCapacity };
    } finally {
      _capacityUpdateInflight = null;
    }
  })();
  return _capacityUpdateInflight;
}

function getRateLimitStatus() {
  return limiter.status();
}

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

      // FIX-2026-08-22: detect Binance 418 IP ban + extract expiry from msg
      //   Binance body: { code: -1003, msg: "Way too much request weight used;
      //     IP banned until <epochMs>. Please use WebSocket Streams..." }
      //   - parse epochMs via regex → setBanUntil() blocks take() until expiry
      //   - ป้องกัน log spam + WS disconnect cascade ที่เคยเห็น 13:06:56 incident
      if (err.response.status === 418) {
        const data = err.response.data;
        if (data && typeof data.msg === 'string') {
          const m = data.msg.match(/IP banned until (\d+)/);
          if (m) {
            limiter.setBanUntil(parseInt(m[1], 10));
          }
        }
      }
      // FIX-2026-08-24 (P1 audit): HTTP 429 = weight limit reached (short of full IP ban)
      //   - เดิม: 429 → reject only → token bucket drained → next requests queue หนัก → burst re-fires 429
      //   - fix: setBanUntil(now + 5000) → take() blocks 5s (refresh bucket) → reduces burst spam
      //   - 5s พอให้ refill rate 100/s catch up โดยไม่ block normal traffic นานเกินไป
      if (err.response.status === 429) {
        limiter.setBanUntil(Date.now() + 5000);
        logger.warn({ status: 429, headers: err.response.headers }, 'binanceRest: HTTP 429 — pausing 5s for token-bucket refill');
      }
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

async function signedRequest(method, path, params = {}, weight = 1, opts = {}) {
  if (!config.binance.apiKey || !config.binance.apiSecret) {
    const e = new Error('Binance API keys not configured. Please set BINANCE_API_KEY and BINANCE_API_SECRET in .env or via dashboard.');
    e.code = 'NO_API_KEYS';
    throw e;
  }
  // FIX-2026-08-24 (P0 audit): signedRequest criticality split
  //   - เดิม: ทุก signed call bypass CB (weight-spike 2026-08-22 mitigation)
  //   - ปัญหา: signed READS (getAccount weight 20, getOpenOrders weight 80, getOrder weight 4)
  //     ก็ bypass CB → 4,560 weight/min รั่วจาก signed reads อย่างเดียว (watchdog 57 bots × 30s)
  //   - fix: caller opt-in via opts.critical (default false for safety)
  //     - true order ops (newOrder, cancelOrder) → pass { critical: true }
  //     - signed reads (getAccount, getOrder, getOpenOrders, getAllOrders, myTrades) → critical: false
  //   - effect: signed reads get blocked เมื่อ CB open → ไม่ทำให้ 418 (defensive)
  //            order placement ยังผ่านเสมอ (trading ไม่หยุด)
  const isCritical = opts.critical === true;
  await limiter.take(weight, { critical: isCritical });
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
  // FIX-2026-08-22 (weight spike): support bulk fetch via symbols=[...]
  //   - Binance docs: ?symbols=[...] form costs the SAME 20 weight as ?symbol=X
  //   - ใช้กับ getCoinInfosBulk() — 1 call แทน 86 parallel calls (UI page load)
  const params = {};
  if (symbol) {
    if (Array.isArray(symbol)) params.symbols = JSON.stringify(symbol);
    else params.symbol = symbol;
  }
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
// FIX-2026-08-24 (P1 audit DEFECT-3): in-process 60s cache for no-symbol get24hrTickers (weight 80)
let _tickers24hCache = null; // { atMs, value }
const _tickers24hCacheTtlMs = 60 * 1000;

async function get24hrTickers({ symbol = null } = {}) {
  // FIX-2026-08-22 (weight spike): support bulk fetch via symbols=[...]
  //   - Binance docs: symbols=[...] form costs 2 (same as single-symbol)
  //   - no-symbol form = all 2500+ spot symbols = weight 80
  //   - ใช้กับ getCoinInfosBulk() — 1 call ครอบคลุมทุก symbol ที่ต้องการ
  const params = {};
  if (symbol) {
    if (Array.isArray(symbol)) params.symbols = JSON.stringify(symbol);
    else params.symbol = symbol;
  }
  const weight = symbol ? 2 : 80;
  // FIX-2026-08-24 (P1 audit DEFECT-3): cache no-symbol form (weight 80) for 60s
  //   - เดิม wallet + botManager.auto-pause + walletSnapshot ทุก tick → N×80 weight ต่อนาที
  //   - fix: in-process 60s cache — caller ส่วนใหญ่ tolerates 60s stale (topN/ranking/snapshot)
  //   - skip cache for per-symbol form (weight 2 only)
  if (!symbol) {
    const now = Date.now();
    if (_tickers24hCache && (now - _tickers24hCache.atMs) < _tickers24hCacheTtlMs) {
      return _tickers24hCache.value;
    }
    const value = await publicGet('/api/v3/ticker/24hr', params, weight);
    _tickers24hCache = { atMs: now, value };
    return value;
  }
  return publicGet('/api/v3/ticker/24hr', params, weight);
}

// FIX-2026-08-24 (P1 audit DEFECT-3): expose cache clear for tests + admin invalidate-volatility-cache pattern
function _resetTickerCache() {
  _tickers24hCache = null;
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
// FIX-2026-08-24 (P0 audit): signed READS explicit critical:false
//   - getAccount (weight 20), getOrder (4), getOpenOrders (6-80), getAllOrders (10),
//     myTrades (10) — all marked critical:false → CB จะ block เมื่อ open
//   - watchdog reconcile (P0-5 risk) จะหยุดยิงเมื่อ breaker open → ไม่ทำให้ 418
async function getAccount() {
  return signedRequest('GET', '/api/v3/account', {}, 20, { critical: false });
}

async function newOrder(params) {
  // FIX-2026-08-24 (P0 audit): order placement = critical (bypass CB)
  return signedRequest('POST', '/api/v3/order', params, 1, { critical: true });
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
  // FIX-2026-08-24 (P0 audit): order cancel = critical (bypass CB)
  return signedRequest('DELETE', '/api/v3/order', params, 1, { critical: true });
}

async function getOrder({ symbol, orderId = null, origClientOrderId = null }, opts = {}) {
  const params = { symbol };
  if (orderId) params.orderId = orderId;
  if (origClientOrderId) params.origClientOrderId = origClientOrderId;
  // FIX-2026-09-17: forward opts.critical to signedRequest
  //   - default false (preserves P0-audit behavior — non-reconcile callers respect CB)
  //   - reconcile safety-net callers (botManager.reconcilePendingTrades) pass
  //     { critical: true } to bypass CB (FIX-2026-09-12 intent)
  //   - bug: pre-fix signature was `(args)` only — second arg silently dropped,
  //     every reconcile sweep was treated as critical:false → blocked by CB
  //     → orphan SELLs stuck for hours/days (36 confirmed stuck at fix time)
  return signedRequest('GET', '/api/v3/order', params, 4, { critical: opts.critical === true });
}

async function getOpenOrders({ symbol = null } = {}) {
  const params = symbol ? { symbol } : {};
  // FIX-2026-08-24 (P0 audit): getOpenOrders no-symbol = weight 80 — must respect CB
  return signedRequest('GET', '/api/v3/openOrders', params, symbol ? 6 : 80, { critical: false });
}

async function cancelAllOpenOrders({ symbol }) {
  // FIX-2026-08-24 (P0 audit): cancel-all = critical (bypass CB)
  return signedRequest('DELETE', '/api/v3/openOrders', { symbol }, 1, { critical: true });
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
  _resetTickerCache,
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
  // FIX-2026-08-21: dynamic rate-limit capacity (Settings → /api/admin/rate-limit)
  setRateLimitCapacity,
  getRateLimitStatus,
  _RateLimiterClass: RateLimiter, // exported for unit tests
  _CircuitBreaker: CircuitBreaker, // FIX-2026-08-22: exported for unit tests
};