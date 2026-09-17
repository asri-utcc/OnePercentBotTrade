'use strict';

/**
 * FIX-2026-09-17: waiting_sell_recovery — re-place SELL for recovery-injected trades
 *
 * Background:
 *   After the orphan-SELL sweeper rollback (2026-09-17), 17 trades were inserted
 *   with state='waiting_sell_recovery' because at restore time their target TP
 *   was > marketPrice × 1.20 (Binance PRICE_FILTER would reject LIMIT_MAKER).
 *   These positions hold the coin but have NO SELL order on Binance — they
 *   will not auto-sell when price recovers.
 *
 *   This scheduler re-checks every N hours (default 4h) whether the target
 *   TP is now within PRICE_FILTER range. When it passes, place LIMIT_MAKER
 *   SELL and transition to state='selling' (normal bot sell-fill path takes
 *   over from there — same as any other open position).
 *
 * Design:
 *   - Singleton scheduler (mirror autoUnderwaterV2 pattern)
 *   - Default 4h tick (AppConfig.waitingSellRecoveryIntervalMs — range 1h..24h)
 *   - Master toggle: AppConfig.waitingSellRecoveryEnabled (default TRUE — these
 *     are recovery positions that the user expects to auto-recover). Disable
 *     for emergency if needed.
 *   - Idempotent: Trade state guard `{ state: 'waiting_sell_recovery' }` in
 *     updateOne → safe to overlap with other ticks
 *   - Jitter ±25% — prevent burst alignment with reconcile (5min) + AUv2 (5min)
 *
 * Skip reasons (return pure helper — testable without mocks):
 *   - 'master_off'        : AppConfig.waitingSellRecoveryEnabled === false
 *   - 'not_waiting'       : 0 trades in waiting_sell_recovery state
 *   - 'price_filter_fail' : target still > marketPrice × 1.20 (wait more)
 *   - 'dust_skip'         : sellQty × target < minNotional ($5) — too small to SELL
 *   - 'no_market_price'   : bookTicker returned 0 (rate-limit / network)
 *   - 'no_symbol_info'    : symbolInfo.loadSymbol failed after retries
 *   - 'sell_rejected'     : Binance -2010 / minNotional / insufficient balance
 *   - 'error'             : unexpected exception
 *
 * Race-safety:
 *   - updateOne({ _id, state: 'waiting_sell_recovery' }, { state: 'selling', ... })
 *     uses state-in-`waiting_sell_recovery` guard → if another tick already placed
 *     the SELL, this tick's updateOne is a no-op (modifiedCount: 0)
 *   - cancelOpenSells before placing new SELL — defensive against duplicates
 */

const Trade = require('../db/models/Trade');
const AppConfig = require('../db/models/AppConfig');
const binanceRest = require('../binance/binanceRest');
const symbolInfo = require('../binance/symbolInfo');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');

const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours per user spec
const MIN_INTERVAL_MS = 1 * 60 * 60 * 1000;     // 1 hour
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;    // 24 hours
const PRICE_FILTER_MULTIPLIER = 1.20; // Binance LIMIT_MAKER ±20% rule
const BOOK_TICKER_RETRIES = 2;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function floorQty(qty, stepSize) {
  if (!stepSize || stepSize === 0) return qty;
  const precision = (stepSize.toString().split('.')[1] || '').length;
  return parseFloat((Math.floor(qty / stepSize) * stepSize).toFixed(precision));
}

function roundPrice(price, tickSize) {
  if (!tickSize || tickSize === 0) return price;
  return parseFloat((Math.floor(price / tickSize) * tickSize).toFixed(8));
}

class WaitingSellRecovery {
  constructor() {
    this.interval = null;
    this.intervalMs = DEFAULT_INTERVAL_MS;
    this.inFlight = false;
    this.lastTickAt = null;
    this.lastStats = null;
    this.lastTickError = null;
    this.tickCount = 0;
  }

  /**
   * Pure helper — computes skip reason for a (trade, ctx) pair.
   * Returns null when the trade is ready to place SELL.
   * Exposed as static for testability.
   *
   * @param {object} trade — recovery trade with waitingTargetPrice, waitingMarketPrice
   * @param {object} ctx   — { currentMarketPrice, stepSize, minNotional, sellQty, tickSize }
   * @returns {string|null}
   */
  static _evaluate(trade, ctx) {
    const target = parseFloat(trade.waitingTargetPrice || 0);
    if (!target || target <= 0) return 'no_target';

    const market = parseFloat(ctx.currentMarketPrice || 0);
    if (!market || market <= 0) return 'no_market_price';

    // PRICE_FILTER: Binance rejects LIMIT_MAKER if price > market × 1.20
    const maxAllowed = market * PRICE_FILTER_MULTIPLIER;
    if (target > maxAllowed) return 'price_filter_fail';

    // NOTIONAL: skip if SELL value < $5
    const sellQty = parseFloat(ctx.sellQty || 0);
    const sellValue = sellQty * target;
    const minNotional = parseFloat(ctx.minNotional || 5);
    if (sellValue < minNotional) return 'dust_skip';

    return null; // ready to place SELL
  }

  start({ intervalMs } = {}) {
    if (this.interval) return;
    const base = intervalMs || DEFAULT_INTERVAL_MS;
    this.intervalMs = base;
    // Jitter ±25% (mirror autoUnderwaterV2) — spread burst out of reconcile + AUv2
    const jitteredInterval = Math.round(base * (1 + (Math.random() * 2 - 1) * 0.25));
    this.interval = setInterval(() => this._tickSafe(), jitteredInterval);
    logger.info({ intervalMs: base, jitteredIntervalMs: jitteredInterval }, 'waitingSellRecovery: started');
    // initial random delay 30-90s (give bots time to settle on boot)
    const initialDelayMs = 30000 + Math.floor(Math.random() * 60000);
    setTimeout(() => this._tickSafe(), initialDelayMs);
    logger.info({ initialDelayMs }, 'waitingSellRecovery: initial tick scheduled');
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info('waitingSellRecovery: stopped');
  }

  _tickSafe() {
    this.tickCount += 1;
    this.runOnce()
      .then((stats) => {
        this.lastStats = { ...stats, ts: this.lastTickAt, tickCount: this.tickCount };
        this.lastTickError = null;
        const noisy = stats.placed > 0 || stats.errors > 0;
        const logFn = noisy ? logger.info.bind(logger) : logger.debug.bind(logger);
        logFn({ ...stats, tickCount: this.tickCount, durationMs: stats.durationMs }, 'waitingSellRecovery: tick');
      })
      .catch((err) => {
        this.lastTickError = err.message;
        logger.error({ err: err.message, stack: err.stack, tickCount: this.tickCount }, 'waitingSellRecovery: tick failed');
      })
      .finally(() => this._persistTelemetry().catch(() => {}));
  }

  async _persistTelemetry() {
    try {
      const upd = { waitingSellRecoveryLastRunAt: new Date() };
      if (this.lastStats) upd.waitingSellRecoveryLastStats = this.lastStats;
      if (this.lastTickError) upd.waitingSellRecoveryLastError = this.lastTickError;
      else upd.waitingSellRecoveryLastError = null;
      await AppConfig.updateOne({ key: 'singleton' }, { $set: upd });
    } catch (_) { /* non-fatal */ }
  }

  async runOnce() {
    if (this.inFlight) {
      logger.debug('waitingSellRecovery: previous tick still in flight, skip');
      return { skipped: true, scanned: 0, placed: 0, errors: 0 };
    }
    this.inFlight = true;
    const t0 = Date.now();
    this.lastTickAt = t0;
    const stats = {
      scanned: 0,
      placed: 0,
      errors: 0,
      skippedMasterOff: 0,
      skippedPriceFilter: 0,
      skippedDust: 0,
      skippedNoMarket: 0,
      skippedNoSymbol: 0,
      skippedSellRejected: 0,
    };
    try {
      await this._processWaitingTrades(stats);
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'waitingSellRecovery: runOnce error');
      stats.errors++;
    } finally {
      stats.durationMs = Date.now() - t0;
      this.inFlight = false;
    }
    return stats;
  }

  async _processWaitingTrades(stats) {
    // 0. Check master toggle (default true — recovery positions should auto-recover)
    const cfg = await AppConfig.findOne({ key: 'singleton' }, 'waitingSellRecoveryEnabled').lean();
    if (cfg && cfg.waitingSellRecoveryEnabled === false) {
      stats.skippedMasterOff++;
      return;
    }

    // 1. Fetch all waiting_sell_recovery trades
    const trades = await Trade.find({ state: 'waiting_sell_recovery' }).lean();
    if (trades.length === 0) {
      logger.debug('waitingSellRecovery: no trades in waiting_sell_recovery');
      return;
    }
    logger.info({ count: trades.length }, 'waitingSellRecovery: found waiting trades');

    // 2. Group by symbol — share symbolInfo load + bookTicker fetch per symbol
    const bySymbol = new Map();
    for (const t of trades) {
      if (!t.symbol) continue;
      const k = t.symbol;
      if (!bySymbol.has(k)) bySymbol.set(k, []);
      bySymbol.get(k).push(t);
    }

    // 3. Per-symbol processing
    for (const [symbol, symTrades] of bySymbol) {
      try {
        await this._processSymbol(symbol, symTrades, stats);
      } catch (err) {
        logger.error({ err: err.message, stack: err.stack, symbol }, 'waitingSellRecovery: symbol processing failed');
        stats.errors += symTrades.length;
      }
      // Defensive sleep between symbols — don't burst Binance API
      await sleep(300);
    }
  }

  async _processSymbol(symbol, trades, stats) {
    // 3a. Load symbol info (with retry)
    let lot = null;
    for (let i = 0; i < BOOK_TICKER_RETRIES + 1; i++) {
      const info = await symbolInfo.loadSymbol(symbol).catch(() => null);
      if (info && info.lotSize && info.lotSize.stepSize) {
        lot = {
          base: info.baseAsset || symbol.replace(/USDT$|BUSD$|FDUSD$/, ''),
          stepSize: info.lotSize.stepSize.toNumber(),
          tickSize: info.priceFilter?.tickSize ? info.priceFilter.tickSize.toNumber() : 0.00000001,
          minNotional: info.notional?.minNotional ? info.notional.minNotional.toNumber() : 5,
        };
        break;
      }
      await sleep(400);
    }
    if (!lot) {
      stats.skippedNoSymbol += trades.length;
      stats.scanned += trades.length;
      logger.warn({ symbol }, 'waitingSellRecovery: cannot load symbol info — skip');
      return;
    }

    // 3b. Fetch current market price (best ask)
    let currentMarketPrice = 0;
    for (let i = 0; i < BOOK_TICKER_RETRIES + 1; i++) {
      try {
        const t = await binanceRest.getBookTicker(symbol);
        currentMarketPrice = parseFloat(t?.askPrice || t?.bidPrice || 0);
        if (currentMarketPrice > 0) break;
      } catch (_) { /* retry */ }
      await sleep(300);
    }
    if (currentMarketPrice <= 0) {
      stats.skippedNoMarket += trades.length;
      stats.scanned += trades.length;
      logger.warn({ symbol }, 'waitingSellRecovery: bookTicker returned 0 — skip');
      return;
    }

    // 3c. Process each trade
    for (const t of trades) {
      stats.scanned++;
      const target = parseFloat(t.waitingTargetPrice || 0);
      // sellQty = buyFilledQty (the coin we already hold)
      const sellQtyRaw = parseFloat(t.buyFilledQty || 0);
      const sellQty = floorQty(sellQtyRaw, lot.stepSize);

      const ctx = {
        currentMarketPrice,
        stepSize: lot.stepSize,
        minNotional: lot.minNotional,
        sellQty,
        tickSize: lot.tickSize,
      };
      const skip = WaitingSellRecovery._evaluate(t, ctx);
      if (skip === 'price_filter_fail') {
        stats.skippedPriceFilter++;
        logger.debug({
          symbol, tradeId: String(t._id),
          target, market: currentMarketPrice,
          maxAllowed: (currentMarketPrice * PRICE_FILTER_MULTIPLIER).toFixed(8),
        }, 'waitingSellRecovery: PRICE_FILTER still failing — wait more');
        continue;
      }
      if (skip === 'dust_skip') {
        stats.skippedDust++;
        // Promote to dust_skipped — same logic as recovery script (no PnL shown)
        const sellValue = sellQty * target;
        logger.info({
          symbol, tradeId: String(t._id),
          sellValue: sellValue.toFixed(4), minNotional: lot.minNotional,
        }, 'waitingSellRecovery: SELL value < minNotional — dust_skip');
        await Trade.updateOne(
          { _id: t._id, state: 'waiting_sell_recovery' },
          {
            $set: {
              state: 'dust_skipped',
              sellQty,
              recoveryNote: `waitingSellRecovery 2026-09-17 — SELL value $${sellValue.toFixed(4)} < $${lot.minNotional} NOTIONAL`,
              updatedAt: new Date(),
            },
          }
        ).catch(() => {});
        continue;
      }
      if (skip === 'no_market_price') {
        stats.skippedNoMarket++;
        continue;
      }
      if (skip) {
        logger.warn({ symbol, tradeId: String(t._id), skip }, 'waitingSellRecovery: unexpected skip');
        continue;
      }

      // ─── PLACE SELL ───
      const sellPx = roundPrice(target, lot.tickSize);
      const clientOrderId = `wsr-sell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // Defensive: cancel any stale open SELL for this symbol first
      try {
        const openOrders = await binanceRest.getOpenOrders({ symbol }, { critical: false }).catch(() => []);
        for (const o of (openOrders || []).filter((x) => x.side === 'SELL')) {
          await binanceRest.cancelOrder({ symbol, orderId: o.orderId }, { critical: true }).catch(() => {});
          await sleep(200);
        }
      } catch (_) { /* non-fatal */ }

      let sellResult;
      try {
        sellResult = await binanceRest.newOrder({
          symbol,
          side: 'SELL',
          type: 'LIMIT_MAKER',
          quantity: sellQty,
          price: sellPx,
          newClientOrderId: clientOrderId,
        }, { critical: true });
      } catch (e) {
        const ferr = e.response?.data || { msg: e.message };
        stats.skippedSellRejected++;
        stats.errors++;
        logger.warn({
          err: JSON.stringify(ferr).slice(0, 200),
          symbol, tradeId: String(t._id), sellPx, sellQty,
        }, 'waitingSellRecovery: SELL placement failed');
        // Don't change state — try again next tick (PRICE_FILTER may temporarily
        // wobble or Binance may have transient issues)
        continue;
      }

      // ─── UPDATE DB — atomic state guard ───
      const updateRes = await Trade.updateOne(
        { _id: t._id, state: 'waiting_sell_recovery' },
        {
          $set: {
            state: 'selling',
            sellOrderId: sellResult.orderId,
            sellClientOrderId: sellResult.clientOrderId || sellResult.newClientOrderId || clientOrderId,
            sellPlacedAt: new Date(),
            sellStatus: 'NEW',
            sellPrice: sellPx,
            sellQty,
            waitingSince: null,
            waitingTargetPrice: null,
            waitingMarketPrice: null,
            waitingMaxAllowedPrice: null,
            recoveryNote: `waitingSellRecovery 2026-09-17 — LIMIT_MAKER placed @ ${sellPx} (market=${currentMarketPrice}, target=${target}, gap=${((target / currentMarketPrice - 1) * 100).toFixed(2)}%)`,
            updatedAt: new Date(),
          },
        }
      );

      if (updateRes.modifiedCount === 0) {
        // Race: another tick already transitioned this trade — but we just placed a SELL on Binance!
        // Cancel it to avoid orphan SELL.
        logger.warn({
          symbol, tradeId: String(t._id), sellOrderId: sellResult.orderId,
        }, 'waitingSellRecovery: race detected — DB already moved on, cancelling orphan SELL');
        try {
          await binanceRest.cancelOrder({ symbol, orderId: sellResult.orderId }, { critical: true }).catch(() => {});
        } catch (_) {}
        stats.errors++;
        continue;
      }

      stats.placed++;
      logger.info({
        symbol, tradeId: String(t._id),
        sellOrderId: sellResult.orderId,
        sellPx, sellQty,
        market: currentMarketPrice, target,
        gapPct: ((target / currentMarketPrice - 1) * 100).toFixed(2),
      }, 'waitingSellRecovery: SELL placed — trade transitioned to selling');

      // Telegram notification
      eventBus.emit('waitingSellRecovery:placed', {
        symbol,
        tradeId: String(t._id),
        sellOrderId: sellResult.orderId,
        sellPx,
        sellQty,
        target,
        market: currentMarketPrice,
        gapPct: parseFloat(((target / currentMarketPrice - 1) * 100).toFixed(2)),
        recoveryNote: t.recoveryNote,
      });

      // Sleep between placements to avoid Binance rate limit
      await sleep(500);
    }
  }

  getStatus() {
    return {
      running: !!this.interval,
      intervalMs: this.intervalMs,
      inFlight: this.inFlight,
      tickCount: this.tickCount,
      lastTickAt: this.lastTickAt,
      lastTickError: this.lastTickError,
      lastStats: this.lastStats,
    };
  }
}

// Export singleton instance + class
const _instance = new WaitingSellRecovery();
module.exports = _instance;
module.exports.WaitingSellRecovery = WaitingSellRecovery;
