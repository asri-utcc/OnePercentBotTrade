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
   * FIX-2026-08-24 (P2 audit): accept either
   *   1) array of objects [{symbol, timeframe, openTime, ...}]
   *   2) Binance raw arrays [[openTime, open, high, low, close, volume, closeTime], ...]
   * + caller-provided {symbol, timeframe} via opts.
   * - เดิม: klines[0].symbol.toUpperCase() crash ถ้า caller ส่ง raw arrays
   */
  seed(klines, opts = {}) {
    if (!klines || klines.length === 0) return;
    let symbol;
    let timeframe;
    let normalized;
    const first = klines[0];
    // detect raw Binance arrays: [openTime, open, high, low, close, volume, closeTime]
    const isRawArray = Array.isArray(first) && first.length >= 6 && typeof first[0] === 'number';
    if (isRawArray) {
      if (!opts.symbol || !opts.timeframe) {
        logger.warn({ sample: first, opts }, 'klineCache.seed — raw arrays require opts.symbol/timeframe, skipping');
        return;
      }
      symbol = opts.symbol;
      timeframe = opts.timeframe;
      normalized = klines.map((arr) => ({
        openTime: arr[0],
        open: parseFloat(arr[1]),
        high: parseFloat(arr[2]),
        low: parseFloat(arr[3]),
        close: parseFloat(arr[4]),
        volume: parseFloat(arr[5]),
        closeTime: arr[6] || (arr[0] + this.intervalMs(timeframe) - 1),
        isClosed: true,
      }));
    } else if (first && typeof first === 'object' && first.symbol && first.timeframe) {
      symbol = first.symbol;
      timeframe = first.timeframe;
      normalized = klines.map((c) => ({ ...c, isClosed: true }));
    } else {
      logger.warn({ sample: first }, 'klineCache.seed — unknown kline shape, skipping');
      return;
    }
    const k = this.key(symbol, timeframe);
    this.caches.set(k, normalized.slice(-this.maxCandles));
    this.currentCandles.delete(k);
    logger.debug({ symbol, timeframe, count: normalized.length }, 'klineCache seeded');
  }

  /**
   * FIX-2026-08-24 (P2 audit): interval → ms helper for raw-array closeTime fallback
   */
  intervalMs(timeframe) {
    const map = {
      '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
      '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000, '8h': 28_800_000, '12h': 43_200_000,
      '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000,
    };
    return map[timeframe] || 60_000;
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