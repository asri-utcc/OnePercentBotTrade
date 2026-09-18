'use strict';

/**
 * FIX-2026-08-05: Auto-Buy BNB Service
 *
 * Background:
 *   BNB-empty fee-deduct incident (2026-08-05) — Binance หัก 0.1% fee จาก base asset
 *   เมื่อ BNB balance หมด → 5 stuck positions (VIC/COTI/HOME/HFT/NIL). เพื่อกันไม่ให้
 *   เกิดซ้ำ ระบบนี้จะเติม BNB ให้อัตโนมัติเมื่อ BNB value < threshold
 *
 * Design:
 *   - Default OFF (user must opt-in via /settings.html)
 *   - Periodic scan (default 60 min) — check BNB value < threshold
 *   - ถ้าใช่ → MARKET BUY BNB/USDT with quoteOrderQty = topUpUsdt
 *   - Safety gates:
 *       1. Cooldown (default 30 min) — กัน burst
 *       2. Daily cap (default 50 USDT) — กัน runaway
 *       3. Insufficient USDT — skip buy + alert telegram
 *       4. MinNotional check — Binance BNB/USDT minNotional ~5 USDT
 *   - Audit log: บันทึกทุก buy attempt (success/failed/skipped) ลง MongoDB collection `bnbAutoBuyLog`
 *   - EventBus: emit `bnbAutoBuySuccess` / `bnbAutoBuyFailed` / `bnbAutoBuySkipped`
 *   - Telegram: telegramNotifier subscribe events + dispatch `bnbAutoBuy` event
 *
 * Manual trigger:
 *   - POST /api/bnb-auto-buy/trigger → runOnce() โดยไม่สนใจ interval
 *   - ใช้สำหรับ test หรือ emergency top-up
 *
 * ⚠️ Live trading risk: ทุก buy เป็น MARKET BUY real money — test ใน DRY mode ก่อน
 */

const AppConfig = require('../db/models/AppConfig');
const mongoose = require('mongoose');
const binanceRest = require('../binance/binanceRest');
const symbolInfo = require('../binance/symbolInfo');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');
// FIX-2026-09-17: per-instance first-fire stagger
const { scheduledInterval, clearScheduledInterval } = require('../utils/scheduledInterval');

const BNB_SYMBOL = 'BNBUSDT';
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MIN_TOPUP_USDT = 5.0; // BNB/USDT minNotional ปัจจุบัน ~ 5 USDT — กัน -1013 LOT_SIZE / MIN_NOTIONAL
const MIN_CHECK_INTERVAL_MIN = 5;

// ─── Audit log schema (collection: bnbautobuylog) ─────────────────
// in-memory write เฉพาะ log ที่ต้องการ audit (success/failed) → persist ลง MongoDB
const BnbAutoBuyLogSchema = new mongoose.Schema(
  {
    ts: { type: Date, default: Date.now, index: true },
    outcome: { type: String, enum: ['success', 'failed', 'skipped'], required: true },
    reason: { type: String, default: null }, // เหตุผล (สำหรับ skipped/failed)
    bnbQtyBefore: { type: Number, default: null },
    bnbUsdtValueBefore: { type: Number, default: null },
    bnbUsdtPrice: { type: Number, default: null },
    topUpUsdt: { type: Number, default: null },
    bnbQtyBought: { type: Number, default: null },
    bnbPriceFilled: { type: Number, default: null },
    orderId: { type: Number, default: null },
    clientOrderId: { type: String, default: null },
    errorCode: { type: String, default: null },
    errorMsg: { type: String, default: null },
    source: { type: String, enum: ['periodic', 'manual'], default: 'periodic' },
  },
  { timestamps: false }
);
const BnbAutoBuyLog = mongoose.models.BnbAutoBuyLog || mongoose.model('BnbAutoBuyLog', BnbAutoBuyLogSchema);

class AutoBnbBuyer {
  constructor() {
    this.interval = null;
    this.intervalMs = DEFAULT_INTERVAL_MS;
    this.inFlight = false;
    this.lastTickAt = null;
    this.lastTickError = null;
    this.tickCount = 0;
    this.lastBuyAt = null; // last successful buy timestamp (Unix ms)
    this.dailySpendUsdt = 0; // recent 24h spend (reset after first check each day)
    this.dailySpendDay = null; // YYYY-MM-DD of last reset
    this.lastStats = null;
  }

  /**
   * Start the periodic scanner. Config reloaded from AppConfig every tick.
   */
  start({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    if (this.interval) return;
    this.intervalMs = intervalMs;
    // FIX-2026-09-17: SCHEDULE_OFFSET_SEC applied
    this.interval = scheduledInterval(() => this._tickSafe(), this.intervalMs, {
      unref: true,
      meta: 'autoBnbBuyer',
    });
    logger.info({ baseMs: intervalMs, bnbSymbol: BNB_SYMBOL }, 'autoBnbBuyer: started');
    // initial tick 30s after start (รอ bookTicker + symbolInfo cache warm up) — defensive warm-up
    setTimeout(() => this._tickSafe(), 30_000);
  }

  stop() {
    if (this.interval) {
      clearScheduledInterval(this.interval);
      this.interval = null;
    }
    logger.info('autoBnbBuyer: stopped');
  }

  /**
   * Reload config + restart timer with new interval (เมียกจาก PUT /api/bnb-auto-buy/config)
   */
  reloadConfig() {
    if (this.interval) {
      clearScheduledInterval(this.interval);
      this.interval = null;
    }
    this.start({ intervalMs: this.intervalMs });
  }

  _tickSafe() {
    this.tickCount += 1;
    this.runOnce({ source: 'periodic' })
      .then((stats) => {
        this.lastStats = { ...stats, ts: this.lastTickAt, tickCount: this.tickCount };
        this.lastTickError = null;
        if (stats.outcome !== 'skipped_no_config') {
          logger.info({ ...stats, tickCount: this.tickCount }, 'autoBnbBuyer: tick');
        }
      })
      .catch((err) => {
        this.lastTickError = err.message;
        logger.error({ err: err.message, stack: err.stack, tickCount: this.tickCount }, 'autoBnbBuyer: tick failed');
      });
  }

  /**
   * Run one scan + maybe buy. Idempotent — in-flight guard.
   */
  async runOnce({ source = 'periodic', force = false } = {}) {
    if (this.inFlight) {
      logger.warn({ source }, 'autoBnbBuyer: previous tick still in flight, skip');
      return { outcome: 'skipped_in_flight' };
    }
    this.inFlight = true;
    this.lastTickAt = Date.now();
    try {
      const cfg = await this._loadConfig();
      if (!cfg) return { outcome: 'skipped_no_config' };
      if (!cfg.enabled && !force) {
        return { outcome: 'skipped_disabled' };
      }

      // Cooldown gate
      const now = Date.now();
      const cooldownMs = cfg.cooldownMin * 60 * 1000;
      if (this.lastBuyAt && (now - this.lastBuyAt) < cooldownMs) {
        const remainingMin = Math.ceil((cooldownMs - (now - this.lastBuyAt)) / 60000);
        return { outcome: 'skipped_cooldown', remainingMin };
      }

      // Daily cap reset (rolls at midnight local time)
      this._maybeResetDailySpend();

      // Read BNB balance (reuses telegramNotifier cache if available)
      const balance = await this._fetchBnbBalance();
      if (!balance) {
        return { outcome: 'skipped_balance_fetch_failed' };
      }

      const threshold = cfg.thresholdUsdt;
      const isLow = balance.usdtValue < threshold;
      if (!isLow && !force) {
        return { outcome: 'skipped_not_low', bnbValue: balance.usdtValue, threshold };
      }

      // Safety: topUpUsdt must be >= MIN_TOPUP_USDT (Binance minNotional)
      if (cfg.topUpUsdt < MIN_TOPUP_USDT) {
        await this._logAudit({
          outcome: 'skipped',
          reason: `topUpUsdt ${cfg.topUpUsdt} < minNotional ${MIN_TOPUP_USDT}`,
          bnbQtyBefore: balance.qty,
          bnbUsdtValueBefore: balance.usdtValue,
          bnbUsdtPrice: balance.usdtPrice,
          topUpUsdt: cfg.topUpUsdt,
          source,
        });
        return { outcome: 'skipped_min_notional', requiredMin: MIN_TOPUP_USDT };
      }

      // Daily cap gate
      if (this.dailySpendUsdt + cfg.topUpUsdt > cfg.maxUsdtPerDay) {
        await this._logAudit({
          outcome: 'skipped',
          reason: `daily cap would be exceeded (${this.dailySpendUsdt} + ${cfg.topUpUsdt} > ${cfg.maxUsdtPerDay})`,
          bnbQtyBefore: balance.qty,
          bnbUsdtValueBefore: balance.usdtValue,
          bnbUsdtPrice: balance.usdtPrice,
          topUpUsdt: cfg.topUpUsdt,
          source,
        });
        eventBus.emit('bnbAutoBuySkipped', {
          reason: 'daily_cap', spentToday: this.dailySpendUsdt, cap: cfg.maxUsdtPerDay,
        });
        return { outcome: 'skipped_daily_cap', spentToday: this.dailySpendUsdt, cap: cfg.maxUsdtPerDay };
      }

      // Check USDT balance sufficient
      const usdtAvail = await this._fetchUsdtFree();
      if (usdtAvail == null || usdtAvail < cfg.topUpUsdt) {
        await this._logAudit({
          outcome: 'skipped',
          reason: `insufficient USDT (usdtAvail=${usdtAvail}, topUp=${cfg.topUpUsdt})`,
          bnbQtyBefore: balance.qty,
          bnbUsdtValueBefore: balance.usdtValue,
          bnbUsdtPrice: balance.usdtPrice,
          topUpUsdt: cfg.topUpUsdt,
          source,
        });
        eventBus.emit('bnbAutoBuySkipped', {
          reason: 'insufficient_usdt', usdtAvail, needed: cfg.topUpUsdt,
        });
        return { outcome: 'skipped_insufficient_usdt', usdtAvail, needed: cfg.topUpUsdt };
      }

      // Place MARKET BUY BNB/USDT with quoteOrderQty (Binance จะ convert เป็น BNB qty)
      const clientOrderId = `auto-bnb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      logger.warn({
        clientOrderId,
        topUpUsdt: cfg.topUpUsdt,
        bnbQtyBefore: balance.qty,
        bnbUsdtValueBefore: balance.usdtValue,
        bnbUsdtPrice: balance.usdtPrice,
        source,
      }, 'autoBnbBuyer: placing MARKET BUY BNB/USDT');

      let orderResp;
      try {
        orderResp = await binanceRest.newOrder({
          symbol: BNB_SYMBOL,
          side: 'BUY',
          type: 'MARKET',
          quoteOrderQty: cfg.topUpUsdt.toFixed(2), // USDT amount to spend
          newClientOrderId: clientOrderId,
          newOrderRespType: 'FULL',
        });
      } catch (err) {
        const ferr = binanceRest.formatBinanceError(err);
        const code = ferr && ferr.code ? String(ferr.code) : null;
        const msg = (ferr && ferr.msg) || err.message;
        logger.error({
          clientOrderId, code, msg, stack: err.stack,
        }, 'autoBnbBuyer: newOrder failed');
        await this._logAudit({
          outcome: 'failed',
          reason: msg,
          bnbQtyBefore: balance.qty,
          bnbUsdtValueBefore: balance.usdtValue,
          bnbUsdtPrice: balance.usdtPrice,
          topUpUsdt: cfg.topUpUsdt,
          clientOrderId,
          errorCode: code,
          errorMsg: msg,
          source,
        });
        eventBus.emit('bnbAutoBuyFailed', {
          reason: 'newOrder_error', code, msg, topUpUsdt: cfg.topUpUsdt,
        });
        return { outcome: 'failed', code, msg };
      }

      // orderResp.executedQty = BNB qty bought, orderResp.cummulativeQuoteQty = USDT spent
      const bnbQtyBought = parseFloat(orderResp.executedQty || orderResp.qty || 0);
      const usdtSpent = parseFloat(orderResp.cummulativeQuoteQty || cfg.topUpUsdt);
      const bnbPriceFilled = bnbQtyBought > 0 ? usdtSpent / bnbQtyBought : balance.usdtPrice;
      const orderId = orderResp.orderId;

      logger.warn({
        clientOrderId, orderId,
        bnbQtyBought, usdtSpent, bnbPriceFilled,
        bnbQtyAfter: balance.qty + bnbQtyBought,
      }, 'autoBnbBuyer: BNB bought successfully');

      // Update audit + tracking
      this.lastBuyAt = Date.now();
      this.dailySpendUsdt += usdtSpent;
      await this._logAudit({
        outcome: 'success',
        bnbQtyBefore: balance.qty,
        bnbUsdtValueBefore: balance.usdtValue,
        bnbUsdtPrice: balance.usdtPrice,
        topUpUsdt: cfg.topUpUsdt,
        bnbQtyBought,
        bnbPriceFilled,
        orderId,
        clientOrderId,
        source,
      });

      eventBus.emit('bnbAutoBuySuccess', {
        bnbQtyBought,
        usdtSpent,
        bnbPriceFilled,
        orderId,
        clientOrderId,
        bnbQtyBefore: balance.qty,
        bnbValueBefore: balance.usdtValue,
        threshold: cfg.thresholdUsdt,
        topUpUsdt: cfg.topUpUsdt,
        source,
      });

      return {
        outcome: 'success',
        orderId,
        bnbQtyBought,
        usdtSpent,
        bnbPriceFilled,
        bnbQtyAfter: balance.qty + bnbQtyBought,
      };
    } finally {
      this.inFlight = false;
    }
  }

  async _loadConfig() {
    try {
      const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
      if (!cfg) return null;
      const enabled = cfg.autoBuyBnbEnabled === true;
      const topUpUsdt = Number(cfg.autoBuyBnbTopUpUsdt) || 5.5;
      const thresholdUsdt = Number(cfg.autoBuyBnbThresholdUsdt) || 0.5;
      const checkIntervalMin = Math.max(MIN_CHECK_INTERVAL_MIN, Number(cfg.autoBuyBnbCheckIntervalMin) || 60);
      const maxUsdtPerDay = Number(cfg.autoBuyBnbMaxUsdtPerDay) || 50;
      const cooldownMin = Math.max(0, Number(cfg.autoBuyBnbCooldownMin) || 30);
      // Update internal interval if changed
      const newIntervalMs = checkIntervalMin * 60 * 1000;
      if (newIntervalMs !== this.intervalMs && this.interval) {
        this.intervalMs = newIntervalMs;
        // FIX-2026-09-17: clearScheduledInterval + scheduledInterval (offset applies on new schedule)
        clearScheduledInterval(this.interval);
        this.interval = scheduledInterval(() => this._tickSafe(), this.intervalMs, {
          unref: true,
          meta: 'autoBnbBuyer:reload',
        });
      }
      return { enabled, topUpUsdt, thresholdUsdt, checkIntervalMin, maxUsdtPerDay, cooldownMin };
    } catch (err) {
      logger.warn({ err: err.message }, 'autoBnbBuyer: loadConfig failed');
      return null;
    }
  }

  async _fetchBnbBalance() {
    // try telegramNotifier cache first (avoid extra Binance call)
    try {
      const telegramNotifier = require('./telegramNotifier');
      const cached = telegramNotifier.getBnbBalanceCached();
      if (cached && (Date.now() - cached.ts) < 60_000) {
        return { qty: cached.qty, usdtPrice: cached.usdtPrice, usdtValue: cached.usdtValue };
      }
    } catch (_) { /* ignore — telegramNotifier may not be loaded */ }
    // fallback: fresh Binance call
    try {
      const acc = await binanceRest.getAccount();
      const row = (acc.balances || []).find((b) => b.asset === 'BNB');
      const qty = row ? (parseFloat(row.free) || 0) + (parseFloat(row.locked) || 0) : 0;
      const ticker = await binanceRest.getBookTicker(BNB_SYMBOL);
      const usdtPrice = parseFloat(ticker.bidPrice) || 0;
      return { qty, usdtPrice, usdtValue: qty * usdtPrice };
    } catch (err) {
      logger.warn({ err: err.message }, 'autoBnbBuyer: fetchBnbBalance failed');
      return null;
    }
  }

  async _fetchUsdtFree() {
    try {
      const acc = await binanceRest.getAccount();
      const row = (acc.balances || []).find((b) => b.asset === 'USDT');
      return row ? parseFloat(row.free) || 0 : 0;
    } catch (err) {
      logger.warn({ err: err.message }, 'autoBnbBuyer: fetchUsdtFree failed');
      return null;
    }
  }

  _maybeResetDailySpend() {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    if (this.dailySpendDay !== today) {
      this.dailySpendUsdt = 0;
      this.dailySpendDay = today;
    }
  }

  async _logAudit(entry) {
    try {
      await BnbAutoBuyLog.create({ ...entry, ts: new Date() });
    } catch (err) {
      logger.warn({ err: err.message, entry: { outcome: entry.outcome, reason: entry.reason } }, 'autoBnbBuyer: audit log failed');
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
      lastBuyAt: this.lastBuyAt,
      dailySpendUsdt: this.dailySpendUsdt,
      dailySpendDay: this.dailySpendDay,
      lastStats: this.lastStats,
    };
  }
}

module.exports = new AutoBnbBuyer();
