'use strict';

/**
 * FIX-2026-09-21: BTC Trend Pattern — global background monitor
 *
 * Purpose:
 *   Computes the BTC Trend Pattern mode for BTCUSDT 1h candles in the background
 *   and exposes the latest mode to other services (e.g. autoReserve will use this
 *   in a future phase to adjust its reserve policy).
 *
 * Architecture:
 *   - Singleton instance (mirror autoReserve pattern)
 *   - Ticks every 15 minutes (configurable via BTC_TREND_TICK_MIN env var)
 *   - Fetches latest BTCUSDT 1h klines via binanceRest (subject to its
 *     circuit-breaker + rate-limiter — no separate guard needed)
 *   - Runs the state-machine in src/core/btcTrendPattern.js
 *   - Stores the latest mode + lastComputedAt + lastError in-memory
 *   - Emits 'btc-trend:mode' on eventBus whenever mode changes
 *
 * Not persisted: state is reset on restart. By design — historical mode
 * isn't needed for consumers (they react to transitions only).
 *
 * Trigger consumer note:
 *   eventBus.on('btc-trend:mode', ({ mode, prevMode, computedAt }) => { ... })
 *
 * FIX-2026-09-21: API surface
 *   - getState() → { mode, prevMode, lastComputedAt, lastError, tickCount, isRunning }
 *   - start() / stop() lifecycle
 */

const { computeBtcTrendPattern } = require('../core/btcTrendPattern');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');
const config = require('../../config');
const binanceRest = require('../binance/binanceRest');

// BTC is the only pair we monitor — hardcoded by design (user requirement).
const SYMBOL = 'BTCUSDT';
const INTERVAL = '1h';
const LIMIT = 500; // 500h ≈ 20 days of history (enough for state-machine + warmup)

// Default tick = 15 minutes (per user). Override via env (BTC_TREND_TICK_MIN).
const DEFAULT_TICK_MIN = 15;

class BtcTrendMonitor {
  constructor() {
    this.currentMode = 'normal'; // initial guess until first tick completes
    this.prevMode = null;        // first emit carries prevMode=null
    this.lastComputedAt = null;
    this.lastError = null;
    this.tickCount = 0;
    this.isRunning = false;
    this._timer = null;
  }

  /**
   * Public snapshot for /api/btc-trend/current + Settings mini-widget.
   */
  getState() {
    return {
      symbol: SYMBOL,
      interval: INTERVAL,
      mode: this.currentMode,
      prevMode: this.prevMode,
      lastComputedAt: this.lastComputedAt,
      lastError: this.lastError,
      tickCount: this.tickCount,
      isRunning: this.isRunning,
    };
  }

  /**
   * Start the periodic tick.
   * Safe to call multiple times — guards against double-start.
   */
  start() {
    if (this.isRunning) return;
    const tickMin = this._resolveTickMin();
    this.isRunning = true;
    logger.info({ tickMin, symbol: SYMBOL, interval: INTERVAL }, 'btcTrendMonitor: starting');

    // Fire first tick immediately so /api/btc-trend/current has real data ASAP.
    // Then schedule on interval.
    this._tick().catch((err) => {
      logger.error({ err: err.message }, 'btcTrendMonitor: initial tick failed');
    });
    this._timer = setInterval(() => {
      this._tick().catch((err) => {
        logger.error({ err: err.message }, 'btcTrendMonitor: tick failed');
      });
    }, tickMin * 60 * 1000);
  }

  /**
   * Stop the periodic tick. Used in graceful shutdown.
   */
  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    logger.info('btcTrendMonitor: stopped');
  }

  /**
   * Internal: fetch → compute → emit on transition → update state.
   * Wrapped in try/catch at the call sites; this method itself does not throw.
   */
  async _tick() {
    try {
      const raw = await binanceRest.getKlines({ symbol: SYMBOL, interval: INTERVAL, limit: LIMIT });
      const candles = raw.map((k) => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
      }));
      const { modes } = computeBtcTrendPattern(candles);
      const newMode = modes[modes.length - 1] || 'normal';
      const prevMode = this.currentMode;
      const computedAt = Date.now();

      this.currentMode = newMode;
      this.prevMode = prevMode;
      this.lastComputedAt = computedAt;
      this.lastError = null;
      this.tickCount += 1;

      // Emit only on transition — saves noise for downstream subscribers.
      if (newMode !== prevMode) {
        try {
          eventBus.emit('btc-trend:mode', {
            mode: newMode,
            prevMode,
            computedAt,
            symbol: SYMBOL,
            interval: INTERVAL,
          });
        } catch (emitErr) {
          // Listener crash must not affect our state — log and continue.
          logger.warn({ err: emitErr.message }, 'btcTrendMonitor: eventBus.emit listener threw');
        }
      }
    } catch (err) {
      this.lastError = err.message || String(err);
      // Don't change currentMode on failure — keep last-known mode.
      // Increment tickCount so we know we tried.
      this.tickCount += 1;
      throw err; // caller will log; we keep state.
    }
  }

  /**
   * Resolve tick interval from env or default.
   */
  _resolveTickMin() {
    const v = parseInt(config.btcTrendTickMin, 10);
    if (Number.isFinite(v) && v > 0) return v;
    return DEFAULT_TICK_MIN;
  }
}

module.exports = new BtcTrendMonitor();