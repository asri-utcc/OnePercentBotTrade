'use strict';

const mongoose = require('mongoose');
const eventBus = require('./eventBus');
const binanceRest = require('../binance/binanceRest');
const { marketWs, userDataWs } = require('../binance/binanceWs');
const botManager = require('../core/botManager');
const config = require('../../config');
const logger = require('../utils/logger');

/**
 * Health Monitor — เช็คสถานะ component ต่างๆ เป็นระยะ
 *
 * Components:
 *  - mongodb: mongoose.connection.readyState (0/1/2/3)
 *  - binanceRest: ping() success/failure
 *  - marketWs: connected + subscribed streams count
 *  - userDataWs: ws != null + subscriptionId set (subscribe confirmed)
 *  - activeBots: จำนวน Trader ที่กำลังทำงาน
 *
 * Broadcast ผ่าน eventBus 'health:update' ทุก HEALTH_INTERVAL_MS
 */

const HEALTH_INTERVAL_MS = 5000;
const BINANCE_PING_INTERVAL_MS = 60000;

class HealthMonitor {
  constructor() {
    this.interval = null;
    this.binancePingInterval = null;
    this.lastBinancePingAt = 0;
    this.lastBinancePingOk = false;
    this.binanceLatencyMs = null;
    this.startedAt = null;
    this.binanceErrorCount = 0;
  }

  start() {
    if (this.interval) return;
    this.startedAt = Date.now();

    // เช็คทันที
    this._tick();

    this.interval = setInterval(() => this._tick(), HEALTH_INTERVAL_MS);
    this.binancePingInterval = setInterval(() => this._pingBinance(), BINANCE_PING_INTERVAL_MS);

    // ping ครั้งแรกทันที
    this._pingBinance();

    logger.info('healthMonitor started');
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.binancePingInterval) {
      clearInterval(this.binancePingInterval);
      this.binancePingInterval = null;
    }
    logger.info('healthMonitor stopped');
  }

  async _pingBinance() {
    this.lastBinancePingAt = Date.now();
    try {
      const t0 = Date.now();
      await binanceRest.ping();
      this.binanceLatencyMs = Date.now() - t0;
      this.lastBinancePingOk = true;
      // FIX-2026-08-24 (P2 audit): reset binanceErrorCount on success path
      //   - เดิม: counter โต unbounded (เดือนละ thousands) → ไม่มี semantic อีกต่อไป
      //   - fix: reset เมื่อ ping สำเร็จ 2 ครั้งติด (hysteresis: กัน false reset ระหว่าง 418 flapping)
      if (this._consecutiveSuccess == null) this._consecutiveSuccess = 0;
      this._consecutiveSuccess += 1;
      if (this._consecutiveSuccess >= 2 && this.binanceErrorCount > 0) {
        this.binanceErrorCount = 0;
      }
    } catch (err) {
      this.lastBinancePingOk = false;
      this.binanceErrorCount += 1;
      this._consecutiveSuccess = 0;
      logger.warn({ err: err.message }, 'binance ping failed');
    }
  }

  _tick() {
    const status = this.getStatus();
    eventBus.emit('health:update', status);

    // FIX-2026-08-23: piggyback live Binance API weight snapshot on the
    //   same 5s cadence so the navbar pill updates without a separate timer.
    //   Read-through only — never throws out of _tick().
    try {
      const rl = binanceRest.getRateLimitStatus();
      const usedPct = rl.capacity > 0
        ? Math.round((rl.usedEstimated / rl.capacity) * 100)
        : 0;
      eventBus.emit('rateLimit:update', {
        capacity: rl.capacity,
        tokens: Math.round(rl.tokens),
        usedEstimated: Math.round(rl.usedEstimated),
        usedPct,
        refillRate: rl.refillRate,
        banRemainingSec: rl.banRemainingSec,
        circuitBreaker: rl.circuitBreaker
          ? {
              state: rl.circuitBreaker.state,
              usedPct: rl.circuitBreaker.usedPct,
              cooldownRemainingMs: rl.circuitBreaker.cooldownRemainingMs,
            }
          : null,
        ts: Date.now(),
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'rateLimit:update emit failed');
    }
  }

  getStatus() {
    const mongoState = mongoose.connection.readyState; // 0=disconnected 1=connected 2=connecting 3=disconnecting
    const mongoStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    const mongoConnected = mongoState === 1;

    // ตรวจว่า marketWs ยังมี subscriptions อยู่
    const subscribedStreams = marketWs.getSubscribedStreams();
    const marketWsOk = marketWs.connected === true;
    const marketWsReconnect = marketWs.reconnectAttempts || 0;

    const userDataWsOk = !!userDataWs.ws && userDataWs.ws.readyState === 1 // OPEN
      && userDataWs.subscriptionId !== null; // subscribe confirmed

    const activeTraders = botManager.traders.size;

    // uptime
    const uptimeSec = this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;

    // overall health
    const allOk = mongoConnected && marketWsOk && this.lastBinancePingOk;
    const degraded = mongoConnected && (marketWsOk || subscribedStreams.length === 0);

    let overall = 'ok';
    if (!mongoConnected) overall = 'critical';
    else if (!marketWsOk) overall = 'degraded';
    else if (!this.lastBinancePingOk && Date.now() - this.lastBinancePingAt > 120000) overall = 'warning';

    return {
      ts: Date.now(),
      uptimeSec,
      overall,
      components: {
        mongodb: {
          ok: mongoConnected,
          state: mongoStates[mongoState] || 'unknown',
          host: (config.mongoUri || '').replace(/\/\/[^@]*@/, '//***@'),
        },
        binanceRest: {
          ok: this.lastBinancePingOk,
          latencyMs: this.binanceLatencyMs,
          lastPingAt: this.lastBinancePingAt,
          errorCount: this.binanceErrorCount,
          hasApiKeys: !!(config.binance.apiKey && config.binance.apiSecret),
        },
        marketWs: {
          ok: marketWsOk,
          connected: marketWs.connected,
          subscribedStreams: subscribedStreams.length,
          reconnectAttempts: marketWsReconnect,
        },
        userDataWs: {
          ok: userDataWsOk,
          connected: userDataWsOk,
          subscriptionId: userDataWs.subscriptionId,
          reconnectAttempts: userDataWs.reconnectAttempts || 0,
        },
        botManager: {
          ok: true,
          running: botManager.running,
          activeTraders,
        },
      },
    };
  }
}

module.exports = new HealthMonitor();