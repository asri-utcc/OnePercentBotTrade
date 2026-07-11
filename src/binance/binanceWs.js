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

// ─── User Data Stream Manager ──────────────────────────
class UserDataStreamManager {
  constructor() {
    this.ws = null;
    this.listenKey = null;
    this.keepaliveTimer = null;
    this.shouldRun = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
  }

  async start() {
    if (!config.binance.apiKey || !config.binance.apiSecret) {
      logger.warn('user data stream: no API keys configured');
      return;
    }
    this.shouldRun = true;
    try {
      this.listenKey = await binanceRest.createListenKey();
      this.connect();
      // keepalive ทุก 30 นาที (listenKey expire 60 นาที)
      this.keepaliveTimer = setInterval(() => {
        this.keepalive();
      }, 30 * 60 * 1000);
    } catch (err) {
      logger.error({ err: err.message }, 'user data stream start failed');
    }
  }

  async stop() {
    this.shouldRun = false;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.listenKey) {
      await binanceRest.closeListenKey(this.listenKey).catch(() => {});
      this.listenKey = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
      this.ws = null;
    }
  }

  async keepalive() {
    if (!this.listenKey) return;
    try {
      await binanceRest.keepaliveListenKey(this.listenKey);
      logger.debug('user data stream keepalive ok');
    } catch (err) {
      logger.warn({ err: err.message }, 'user data stream keepalive failed');
    }
  }

  connect() {
    if (!this.shouldRun || !this.listenKey) return;
    const url = `${config.binanceApi.wsUserData}/${this.listenKey}`;
    logger.info('user data stream connecting');

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      logger.info('user data stream connected');
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

    ws.on('close', (code, reason) => {
      logger.warn({ code, reason: reason.toString() }, 'user data stream closed');
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
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        // ขอ listenKey ใหม่
        this.listenKey = await binanceRest.createListenKey();
        this.connect();
      } catch (err) {
        logger.error({ err: err.message }, 'user data stream reconnect failed');
        this.scheduleReconnect();
      }
    }, wait);
  }

  handleMessage(msg) {
    const e = msg.e;
    if (e === 'executionReport') {
      // Order update
      eventBus.emit('order:update', {
        symbol: msg.s,
        clientOrderId: msg.c,
        orderId: msg.i,
        side: msg.S,
        type: msg.o,
        status: msg.X, // NEW/PARTIALLY_FILLED/FILLED/CANCELED/...
        executedQty: parseFloat(msg.z),
        cumulativeQuoteQty: parseFloat(msg.Z),
        price: parseFloat(msg.p || msg.ap || 0),
        avgPrice: parseFloat(msg.ap || msg.p || 0),
        commission: parseFloat(msg.n || 0),
        commissionAsset: msg.N || '',
        tradeId: msg.t,
        ts: msg.T || Date.now(),
        raw: msg,
      });
    } else if (e === 'outboundAccountPosition') {
      eventBus.emit('account:update', msg);
    }
  }
}

module.exports = {
  marketWs: new MarketWsManager(),
  userDataWs: new UserDataStreamManager(),
};