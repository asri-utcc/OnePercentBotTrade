'use strict';

const axios = require('axios');
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../utils/logger');

// ─── Rate limiter แบบ token bucket ตาม X-MBX-USED-WEIGHT-1M ────
class RateLimiter {
  constructor({ capacity = 1200, refillPerMs = 1200 / 60000 } = {}) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillPerMs; // tokens per ms
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
    if (used > this.capacity * 0.8) {
      logger.warn({ used, capacity: this.capacity }, 'binance weight approaching limit');
    }
    // ปรับ token ตาม header ที่บอกว่าใช้ไปเท่าไหร่
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
  const q = { ...params, recvWindow: config.binance.recvWindow, timestamp: nowMs() };
  const qs = signQuery(q);

  const url = `${path}?${qs}`;
  const resp = method === 'GET'
    ? await http.get(url)
    : await http.post(url, '');
  return resp.data;
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
  return publicGet('/api/v3/exchangeInfo', params, symbol ? 20 : 20);
}

async function getKlines({ symbol, interval, startTime, endTime, limit = 500 }) {
  const params = { symbol, interval, limit };
  if (startTime) params.startTime = startTime;
  if (endTime) params.endTime = endTime;
  return publicGet('/api/v3/klines', params, 2);
}

// ─── Signed endpoints ───────────────────────────────────
async function getAccount() {
  return signedRequest('GET', '/api/v3/account', {}, 20);
}

async function newOrder(params) {
  // params: symbol, side, type, timeInForce?, quantity?, price?, newClientOrderId?, ...
  return signedRequest('POST', '/api/v3/order', params, 1);
}

async function cancelOrder({ symbol, orderId = null, origClientOrderId = null }) {
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
  // public
  ping,
  getServerTime,
  getExchangeInfo,
  getKlines,
  // signed
  getAccount,
  newOrder,
  cancelOrder,
  getOrder,
  getOpenOrders,
  cancelAllOpenOrders,
  // user data stream
  createListenKey,
  keepaliveListenKey,
  closeListenKey,
  // utils
  formatBinanceError,
  signQuery,
  nowMs,
};