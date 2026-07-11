'use strict';

const eventBus = require('./eventBus');
const logger = require('../utils/logger');

/**
 * Rolling window ของ closed candles แยกตาม symbol/timeframe
 * - เก็บ array ของ {openTime, open, high, low, close, volume, closeTime, isClosed}
 * - เมื่อ kline ปิด (x=true) → emit 'kline:closed'
 */

const DEFAULT_MAX = 500; // เก็บ 500 แท่งล่าสุด

class KlineCache {
  constructor({ maxCandles = DEFAULT_MAX } = {}) {
    this.maxCandles = maxCandles;
    this.caches = new Map(); // key = `${symbol}:${timeframe}` -> array
    this.currentCandles = new Map(); // key -> current (ยังไม่ปิด)
  }

  key(symbol, timeframe) {
    return `${symbol.toUpperCase()}:${timeframe}`;
  }

  getAll(symbol, timeframe) {
    const k = this.key(symbol, timeframe);
    return this.caches.get(k) || [];
  }

  getLatestClosed(symbol, timeframe) {
    const arr = this.getAll(symbol, timeframe);
    return arr.length > 0 ? arr[arr.length - 1] : null;
  }

  getCurrent(symbol, timeframe) {
    const k = this.key(symbol, timeframe);
    return this.currentCandles.get(k) || null;
  }

  size(symbol, timeframe) {
    return this.getAll(symbol, timeframe).length;
  }

  /**
   * อัปเดต kline (เรียกจาก WS message handler)
   */
  update(kline, { isFinal = false } = {}) {
    const symbol = kline.symbol;
    const timeframe = kline.interval;
    const k = this.key(symbol, timeframe);

    const candle = {
      symbol,
      timeframe,
      openTime: kline.openTime,
      open: parseFloat(kline.open),
      high: parseFloat(kline.high),
      low: parseFloat(kline.low),
      close: parseFloat(kline.close),
      volume: parseFloat(kline.volume),
      closeTime: kline.closeTime,
      isClosed: isFinal,
    };

    let arr = this.caches.get(k);
    if (!arr) {
      arr = [];
      this.caches.set(k, arr);
    }

    // ถ้าเป็นแท่งใหม่ (openTime ต่างจากแท่งสุดท้าย) → push
    const last = arr.length > 0 ? arr[arr.length - 1] : null;
    if (!last || last.openTime !== candle.openTime) {
      arr.push(candle);
      // trim
      if (arr.length > this.maxCandles) {
        arr.splice(0, arr.length - this.maxCandles);
      }
    } else {
      // อัปเดตแท่งเดิม
      arr[arr.length - 1] = candle;
    }

    if (!isFinal) {
      this.currentCandles.set(k, candle);
    } else {
      this.currentCandles.delete(k);
      // แท่งปิดแล้ว → emit
      eventBus.emit('kline:closed', { symbol, timeframe, candle });
    }
  }

  /**
   * Seed ด้วย historical klines (จาก REST)
   */
  seed(klines) {
    if (!klines || klines.length === 0) return;
    const symbol = klines[0].symbol;
    const timeframe = klines[0].timeframe;
    const k = this.key(symbol, timeframe);
    const candles = klines.map((c) => ({ ...c, isClosed: true }));
    this.caches.set(k, candles.slice(-this.maxCandles));
    this.currentCandles.delete(k);
    logger.debug({ symbol, timeframe, count: candles.length }, 'klineCache seeded');
  }

  clear(symbol, timeframe) {
    const k = this.key(symbol, timeframe);
    this.caches.delete(k);
    this.currentCandles.delete(k);
  }

  clearAll() {
    this.caches.clear();
    this.currentCandles.clear();
  }
}

module.exports = new KlineCache();