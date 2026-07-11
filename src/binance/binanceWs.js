'use strict';

const WebSocket = require('ws');
const config = require('../../config');
const logger = require('../utils/logger');
const klineCache = require('../services/klineCache');
const eventBus = require('../services/eventBus');
const binanceRest = require('./binanceRest');

/**
 * Market WebSocket Manager
 * - ใช้ combined stream + JSON-RPC SUBSCRIBE/UNSUBSCRIBE
 * - Reference counting: subscribe เมื่อ refCount จาก 0 → 1; unsubscribe เมื่อ refCount กลับเป็น 0
 * - Auto reconnect + resubscribe
 *
 * Streams ต่อ symbol/timeframe:
 *   <symbol>@kline_<interval>          (สำหรับ signal)
 *   <symbol>@bookTicker                 (สำหรับ bid price)
 */

class MarketWsManager {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.subscriptions = new Map(); // streamName -> refCount
    this.requestId = 0;
    this.reconnectAttempts = 0;
    this.shouldRun = false;
    this.reconnectTimer = null;
    this.pendingSends = []; // queue เมื่อยังไม่ connected
  }

  start() {
    this.shouldRun = true;
    this.connect();
  }

  stop() {
    this.shouldRun = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
  }

  connect() {
    if (!this.shouldRun) return;
    const url = `${config.binanceApi.wsBase}/stream`;
    logger.info({ url }, 'market WS connecting');

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      logger.info('market WS connected');

      // subscribe ทั้งหมดที่ค้างอยู่
      const all = [...this.subscriptions.keys()];
      if (all.length > 0) {
        this.sendSubscribe(all);
      }
      // flush pending
      for (const msg of this.pendingSends) {
        try { ws.send(JSON.stringify(msg)); } catch (e) { /* ignore */ }
      }
      this.pendingSends = [];
    });

    ws.on('message', (raw) => {
      this.handleMessage(raw.toString('utf8'));
    });

    ws.on('ping', (data) => {
      // ตอบ pong ทันที
      try { ws.pong(data); } catch (e) { /* ignore */ }
    });

    ws.on('close', (code, reason) => {
      this.connected = false;
      logger.warn({ code, reason: reason.toString() }, 'market WS closed');
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      logger.error({ err: err.message }, 'market WS error');
      // close handler จะ trigger reconnect
    });
  }

  scheduleReconnect() {
    if (!this.shouldRun) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const wait = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30000);
    logger.info({ attempt: this.reconnectAttempts, waitMs: wait }, 'market WS reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      logger.warn({ raw: raw.slice(0, 200) }, 'market WS invalid JSON');
      return;
    }

    // Combined stream wraps data: { stream: "...", data: {...} }
    if (msg.stream && msg.data) {
      const stream = msg.stream;
      const data = msg.data;
      if (stream.endsWith('@bookTicker')) {
        this.handleBookTicker(data);
      } else if (stream.includes('@kline_')) {
        this.handleKline(data);
      }
    } else if (msg.e === 'bookTicker') {
      this.handleBookTicker(msg);
    } else if (msg.e === 'kline') {
      this.handleKline(msg);
    }
  }

  handleKline(data) {
    const k = data.k;
    const symbol = data.s;
    const interval = k.i;
    const kline = {
      symbol,
      interval,
      openTime: k.t,
      open: k.o,
      high: k.h,
      low: k.l,
      close: k.c,
      volume: k.v,
      closeTime: k.T,
    };
    const isFinal = k.x === true;
    klineCache.update(kline, { isFinal });
    // ส่ง event ปัจจุบันให้ dashboard ด้วย (รวมถึงแท่งที่ยังไม่ปิด)
    eventBus.emit('kline:update', { symbol, interval, kline: { ...kline, isClosed: isFinal } });
  }

  handleBookTicker(data) {
    const bookTicker = {
      symbol: data.s,
      bid: parseFloat(data.b),
      bidQty: parseFloat(data.B),
      ask: parseFloat(data.a),
      askQty: parseFloat(data.A),
      ts: Date.now(),
    };
    eventBus.emit('bookTicker', bookTicker);
  }

  sendRpc(method, params) {
    this.requestId += 1;
    const msg = {
      method,
      params,
      id: this.requestId,
    };
    if (this.connected && this.ws) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        logger.warn({ err: err.message }, 'WS send failed, queueing');
        this.pendingSends.push(msg);
      }
    } else {
      this.pendingSends.push(msg);
    }
  }

  sendSubscribe(streams) {
    this.sendRpc('SUBSCRIBE', streams);
  }

  sendUnsubscribe(streams) {
    this.sendRpc('UNSUBSCRIBE', streams);
  }

  // ─── Public subscription API ───────────────────────
  /**
   * Subscribe kline + bookTicker สำหรับ symbol/timeframe (refCount++)
   */
  subscribeMarket(symbol, timeframe) {
    symbol = symbol.toUpperCase();
    const klineStream = `${symbol.toLowerCase()}@kline_${timeframe}`;
    const bookStream = `${symbol.toLowerCase()}@bookTicker`;

    this._increment(klineStream);
    this._increment(bookStream);
  }

  unsubscribeMarket(symbol, timeframe) {
    symbol = symbol.toUpperCase();
    const klineStream = `${symbol.toLowerCase()}@kline_${timeframe}`;
    const bookStream = `${symbol.toLowerCase()}@bookTicker`;

    this._decrement(klineStream);
    this._decrement(bookStream);
  }

  _increment(stream) {
    const cur = this.subscriptions.get(stream) || 0;
    if (cur === 0) {
      this.subscriptions.set(stream, 1);
      this.sendSubscribe([stream]);
      logger.debug({ stream, refCount: 1 }, 'WS subscribe');
    } else {
      this.subscriptions.set(stream, cur + 1);
    }
  }

  _decrement(stream) {
    const cur = this.subscriptions.get(stream) || 0;
    if (cur <= 1) {
      this.subscriptions.delete(stream);
      this.sendUnsubscribe([stream]);
      logger.debug({ stream }, 'WS unsubscribe');
    } else {
      this.subscriptions.set(stream, cur - 1);
    }
  }

  getSubscribedStreams() {
    return [...this.subscriptions.keys()];
  }
}

// ─── User Data Stream Manager (WebSocket API) ──────────
// Replaces the legacy listenKey flow (POST/PUT/DELETE /api/v3/userDataStream)
// which Binance discontinued in February 2026.
//
// New flow:
//   1. Connect to WebSocket API endpoint (wss://ws-api.binance.com:9443/ws-api/v3)
//   2. After open, send JSON-RPC: userDataStream.subscribe.signature
//      params = { apiKey, timestamp, signature (HMAC SHA256 base64), recvWindow? }
//   3. Receive subscriptionId in response
//   4. Stream events arrive as { subscriptionId, event: { e, ... } }
//      - event.e === "executionReport" → order update
//      - event.e === "outboundAccountPosition" → account/balance update
//   5. No keepalive needed — subscription lives as long as WS connection is alive.
//      On reconnect, simply re-open WS and re-subscribe.
class UserDataStreamManager {
  constructor() {
    this.ws = null;
    this.subscriptionId = null;
    this.shouldRun = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.requestId = 0;
    this.pendingRequests = new Map(); // id → resolve/reject
  }

  async start() {
    if (!config.binance.apiKey || !config.binance.apiSecret) {
      logger.warn('user data stream: no API keys configured');
      return;
    }
    this.shouldRun = true;
    this.connect();
  }

  async stop() {
    this.shouldRun = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
      this.ws = null;
    }
    this.subscriptionId = null;
  }

  connect() {
    if (!this.shouldRun) return;
    const url = config.binanceApi.wsApiBase;
    logger.info({ url }, 'user data stream connecting');

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      logger.info('user data stream ws open, subscribing...');
      this.sendSubscribe().catch((err) => {
        logger.error({ err: err.message }, 'user data stream subscribe failed');
        try { ws.close(); } catch (e) { /* ignore */ }
      });
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch (err) {
        return;
      }
      this.handleMessage(msg);
    });

    ws.on('ping', (data) => {
      try { ws.pong(data); } catch (e) { /* ignore */ }
    });

    ws.on('close', (code, reason) => {
      logger.warn({ code, reason: reason.toString() }, 'user data stream closed');
      this.subscriptionId = null;
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      logger.error({ err: err.message }, 'user data stream error');
    });
  }

  scheduleReconnect() {
    if (!this.shouldRun) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const wait = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30000);
    logger.info({ attempt: this.reconnectAttempts, waitMs: wait }, 'user data stream reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  sendRpc(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('ws not open'));
      }
      this.requestId += 1;
      const id = String(this.requestId);
      this.pendingRequests.set(id, { resolve, reject, method });
      const payload = { id, method, params };
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pendingRequests.delete(id);
        return reject(err);
      }
      // safety timeout: ถ้า 10 วินาทีไม่ตอบ ถือว่า fail
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('rpc timeout'));
        }
      }, 10000);
    });
  }

  async sendSubscribe() {
    const params = binanceRest.signUserStreamParams();
    const resp = await this.sendRpc('userDataStream.subscribe.signature', params);
    this.subscriptionId = resp.result && resp.result.subscriptionId;
    logger.info({ subscriptionId: this.subscriptionId }, 'user data stream connected');
  }

  handleMessage(msg) {
    // JSON-RPC response to our subscribe request
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const { resolve, reject, method } = this.pendingRequests.get(msg.id);
      this.pendingRequests.delete(msg.id);
      if (msg.status === 200) {
        resolve(msg);
      } else {
        const err = new Error(`${method} failed: ${msg.error?.msg || JSON.stringify(msg)}`);
        err.code = msg.error?.code;
        reject(err);
      }
      return;
    }

    // Event frame: { subscriptionId, event: { e, ... } }
    const ev = msg.event;
    if (!ev) return;
    const e = ev.e;
    if (e === 'executionReport') {
      eventBus.emit('order:update', {
        symbol: ev.s,
        clientOrderId: ev.c,
        orderId: ev.i,
        side: ev.S,
        type: ev.o,
        status: ev.X, // NEW/PARTIALLY_FILLED/FILLED/CANCELED/...
        executedQty: parseFloat(ev.z),
        cumulativeQuoteQty: parseFloat(ev.Z),
        price: parseFloat(ev.p || ev.ap || 0),
        avgPrice: parseFloat(ev.ap || ev.p || 0),
        commission: parseFloat(ev.n || 0),
        commissionAsset: ev.N || '',
        tradeId: ev.t,
        ts: ev.T || Date.now(),
        raw: ev,
      });
    } else if (e === 'outboundAccountPosition') {
      eventBus.emit('account:update', ev);
    } else if (e === 'balanceUpdate') {
      eventBus.emit('balance:update', ev);
    } else if (e === 'listStatus') {
      // OCO list status (we don't use OCO yet, but log)
      eventBus.emit('listStatus', ev);
    }
  }

  isConnected() {
    return this.subscriptionId !== null && this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

module.exports = {
  marketWs: new MarketWsManager(),
  userDataWs: new UserDataStreamManager(),
};