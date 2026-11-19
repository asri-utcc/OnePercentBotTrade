'use strict';

/**
 * FIX-2026-11-19: Reconcile Audit — periodic READ-ONLY DB ↔ Binance consistency check
 *
 * เหตุผล: audit 2026-11-19 พบ DB เพี้ยนจาก Binance มาเป็นเดือนโดยไม่มีใครรู้ (forceClose oversell,
 *   phantom waiting_sell_recovery, orphan filled ไม่มี SELL). service นี้จับอาการเดียวกันอัตโนมัติ:
 *
 *   1. SHORTFALL      wallet (free+locked) < เหรียญที่ open trades ถือตาม DB (เหรียญหาย / ถูกขายโดย path อื่น)
 *   2. SELLING_NO_ORDER  state='selling' แต่ไม่มี sellOrderId
 *   3. SELL_NOT_ON_BOOK  state='selling' + sellOrderId ไม่อยู่ใน openOrders นานเกิน grace (WS miss)
 *   4. UNKNOWN_ORDER  open order บน Binance ที่ไม่มี open trade อ้างถึง
 *   5. OVERSELL       sold ใน 25 ชม.ล่าสุด ที่ sellQty > qty ของตัวเอง (ขายเหรียญ trade อื่น)
 *
 * ไม่แก้อะไรเอง — log + Telegram ('reconcileAudit') เมื่อเจอปัญหา (ส่งซ้ำเมื่อชุดปัญหาเปลี่ยน หรือทุก 24 ชม.)
 * Weight ต่อรอบ: getAccount 20 + openOrders 80 = 100 (ทุก 6 ชม.)
 */

const Trade = require('../db/models/Trade');
const binanceRest = require('../binance/binanceRest');
const logger = require('../utils/logger');
const { scheduledInterval, clearScheduledInterval } = require('../utils/scheduledInterval');

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 15 * 60 * 1000;
const RESEND_SAME_ISSUES_MS = 24 * 60 * 60 * 1000;
const SELL_MISSING_GRACE_MS = 30 * 60 * 1000;
const MIN_SHORTFALL_USDT = 1;
// states ที่ "ถือเหรียญแล้ว" (BUY fill แล้ว) — placed/partial_wait ยังไม่นับ
const HOLDING_STATES = ['filled', 'retrying', 'holding', 'selling', 'stopping', 'partial_sell_wait', 'waiting_sell_recovery'];
const OPEN_STATES = ['placed', 'partial_wait', ...HOLDING_STATES];

const baseAssetOf = (symbol) => String(symbol || '').replace(/(USDT|USDC|FDUSD|BUSD)$/, '');
const ownQty = (t) => (t.isDcaStack ? Number(t.stackTotalQty) : 0) || Number(t.buyFilledQty) || Number(t.buyQty) || 0;

/**
 * Pure analysis — exported for tests.
 * @returns {Array<{type: string, key: string, detail: string}>}
 */
function analyze({ openTrades, balances, openOrders, recentSold, now = Date.now() }) {
  const issues = [];
  const wallet = new Map((balances || []).map((b) => [b.asset, Number(b.free) + Number(b.locked)]));
  const liveIds = new Set((openOrders || []).map((o) => String(o.orderId)));

  // 1. SHORTFALL per base asset
  const expected = new Map();
  for (const t of openTrades) {
    if (!HOLDING_STATES.includes(t.state)) continue;
    const a = baseAssetOf(t.symbol);
    const sold = Number(t.sellFilledQty) || 0; // partial SELL already gone from wallet
    const e = expected.get(a) || { qty: 0, cost: 0, ids: [] };
    const q = Math.max(0, ownQty(t) - sold);
    e.qty += q;
    e.cost += q * (Number(t.buyPrice) || 0);
    e.ids.push(String(t._id).slice(-8));
    expected.set(a, e);
  }
  for (const [asset, e] of expected) {
    const have = wallet.get(asset) || 0;
    const missing = e.qty - have;
    if (e.qty <= 0 || missing <= e.qty * 0.02) continue;
    const missingUsdt = (e.cost / e.qty) * missing;
    if (missingUsdt < MIN_SHORTFALL_USDT) continue;
    issues.push({
      type: 'SHORTFALL', key: `SHORTFALL:${asset}`,
      detail: `${asset}: wallet ${+have.toFixed(8)} < DB ${+e.qty.toFixed(8)} (ขาด ~${missingUsdt.toFixed(2)} USDT) trades ${e.ids.join(',')}`,
    });
  }

  // 2/3. selling trades vs order book
  for (const t of openTrades) {
    if (t.state !== 'selling') continue;
    const id = String(t._id).slice(-8);
    if (!t.sellOrderId) {
      issues.push({ type: 'SELLING_NO_ORDER', key: `SNO:${t._id}`, detail: `${t.symbol} ${id}: state=selling แต่ไม่มี sellOrderId` });
      continue;
    }
    const age = now - new Date(t.updatedAt || t.sellPlacedAt || 0).getTime();
    if (!liveIds.has(String(t.sellOrderId)) && age > SELL_MISSING_GRACE_MS) {
      issues.push({ type: 'SELL_NOT_ON_BOOK', key: `SNB:${t._id}`, detail: `${t.symbol} ${id}: SELL ${t.sellOrderId} ไม่อยู่บน order book (${Math.round(age / 60000)} นาที)` });
    }
  }

  // 4. Binance open orders not owned by any open trade
  const owned = new Set();
  for (const t of openTrades) {
    if (t.buyOrderId) owned.add(String(t.buyOrderId));
    if (t.sellOrderId) owned.add(String(t.sellOrderId));
    if (t.topUpOrderId) owned.add(String(t.topUpOrderId));
  }
  for (const o of openOrders || []) {
    if (owned.has(String(o.orderId))) continue;
    issues.push({
      type: 'UNKNOWN_ORDER', key: `UO:${o.orderId}`,
      detail: `${o.symbol} ${o.side} ${o.type} ${o.origQty}@${o.price} (order ${o.orderId}, ${o.clientOrderId}) — ไม่มี trade ใน DB`,
    });
  }

  // 5. oversell
  for (const t of recentSold || []) {
    const own = ownQty(t);
    if (own > 0 && Number(t.sellQty) > own * 1.01) {
      issues.push({
        type: 'OVERSELL', key: `OS:${t._id}`,
        detail: `${t.symbol} ${String(t._id).slice(-8)}: sold ${t.sellQty} > own ${own} (ขายเหรียญของ trade อื่น)`,
      });
    }
  }
  return issues;
}

class ReconcileAudit {
  constructor() {
    this.interval = null;
    this.firstTimer = null;
    this.inFlight = false;
    this.lastRunAt = null;
    this.lastIssues = [];
    this.lastError = null;
    this._lastSentSig = null;
    this._lastSentAt = 0;
  }

  start({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    if (this.interval) return;
    this.interval = scheduledInterval(() => this._tickSafe(), intervalMs, { unref: true, meta: 'reconcileAudit' });
    this.firstTimer = setTimeout(() => this._tickSafe(), FIRST_RUN_DELAY_MS);
    if (this.firstTimer.unref) this.firstTimer.unref();
    logger.info({ intervalMs }, 'reconcileAudit: started');
  }

  stop() {
    if (this.interval) clearScheduledInterval(this.interval);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.interval = null;
    this.firstTimer = null;
  }

  async _tickSafe() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.lastError = err.message;
      logger.warn({ err: err.message }, 'reconcileAudit: run failed (will retry next interval)');
    } finally {
      this.inFlight = false;
    }
  }

  async runOnce({ notify = true } = {}) {
    const now = Date.now();
    const [openTrades, recentSold] = await Promise.all([
      Trade.find({ state: { $in: OPEN_STATES } }).lean(),
      Trade.find({ state: 'sold', sellFilledAt: { $gte: new Date(now - 25 * 3600 * 1000) } }).lean(),
    ]);
    // read-only, non-critical: skipped automatically when the rate-limit CB is open
    const account = await binanceRest.getAccount();
    const openOrders = await binanceRest.getOpenOrders();
    const issues = analyze({ openTrades, balances: account.balances, openOrders, recentSold, now });

    this.lastRunAt = new Date(now);
    this.lastIssues = issues;
    this.lastError = null;
    if (issues.length === 0) {
      logger.info({ openTrades: openTrades.length, openOrders: openOrders.length }, 'reconcileAudit: DB matches Binance');
      this._lastSentSig = null;
      return issues;
    }
    logger.warn({ count: issues.length, issues: issues.slice(0, 20) }, 'reconcileAudit: DB ↔ Binance mismatch');

    const sig = issues.map((i) => i.key).sort().join('|');
    if (notify && (sig !== this._lastSentSig || now - this._lastSentAt > RESEND_SAME_ISSUES_MS)) {
      try {
        const telegramNotifier = require('./telegramNotifier');
        await telegramNotifier.sendNow('reconcileAudit', { issues, openTrades: openTrades.length });
        this._lastSentSig = sig;
        this._lastSentAt = now;
      } catch (err) {
        logger.warn({ err: err.message }, 'reconcileAudit: telegram send failed (non-fatal)');
      }
    }
    return issues;
  }

  getStatus() {
    return {
      running: !!this.interval,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      issueCount: this.lastIssues.length,
      issues: this.lastIssues,
    };
  }
}

const _instance = new ReconcileAudit();
module.exports = _instance;
module.exports.ReconcileAudit = ReconcileAudit;
module.exports.analyze = analyze;
