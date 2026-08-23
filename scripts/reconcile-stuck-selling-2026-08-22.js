'use strict';

/**
 * One-shot reconcile for trades stuck in state='selling'.
 *
 * Background (2026-08-22):
 *   - User data stream (Binance WS) disconnected due to 418 IP ban
 *   - SELL orders filled on Binance but our state machine never received fill events
 *   - 11 trades stuck in state='selling' — oldest is 27 hours
 *
 * This script:
 *   1. Wait for Binance 418 ban to lift
 *   2. For each 'selling' trade:
 *      - getOrder(symbol, orderId) → status
 *      - if FILLED → atomic update Trade to 'sold' with real PnL + update Bot totals
 *      - if CANCELED/EXPIRED → re-arm scheduleHoldingRetry (rare path; trader absent)
 *      - if still NEW/PARTIALLY_FILLED → leave alone (trader still running, will pick up)
 *   3. Audit report
 *
 * Idempotency: uses Trade.updateOne guarded by current state → safe to re-run
 */

const path = require('path');
const fs = require('fs');
const config = require('../config');
const db = require('../src/db/connection');
const logger = require('../src/utils/logger');
const br = require('../src/binance/binanceRest');
const fees = require('../src/binance/fees');
const Bot = require('../src/db/models/Bot');
const Trade = require('../src/db/models/Trade');

const POLL_INTERVAL_MS = 30 * 1000;
const MAX_WAIT_MS = 20 * 60 * 1000;

async function waitForBanToLift() {
  const deadline = Date.now() + MAX_WAIT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const status = br.getRateLimitStatus();
    if (status.banUntilMs === 0 || status.banUntilMs <= Date.now()) {
      try {
        // br.getServerTime() returns the serverTime number directly (not {serverTime})
        const ts = await br.getServerTime();
        const ms = Number(ts);
        if (Number.isFinite(ms) && ms > 0) {
          logger.info({ attempt, serverTime: new Date(ms).toISOString() }, '✅ ban lifted — getServerTime OK');
          return true;
        }
        logger.warn({ attempt, ts }, 'waitForBanToLift: getServerTime returned non-finite (continuing)');
      } catch (err) {
        logger.info({ attempt, err: err.message }, '⏳ API call failed (continuing)');
      }
    } else {
      const waitSec = Math.max(1, Math.round((status.banUntilMs - Date.now()) / 1000));
      logger.info({ attempt, waitSec }, '⏳ local ban in effect');
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  logger.error({ attempt }, 'waitForBanToLift: exceeded MAX_WAIT_MS');
  return false;
}

/**
 * Atomic state guard — only updates if trade is currently in one of the open states.
 * Returns true if updated, false if race-lost (already moved by another path).
 */
async function markTradeSoldFromOrder({ trade, orderResp }) {
  const executedQty = parseFloat(orderResp.executedQty) || 0;
  const avgPrice = parseFloat(orderResp.price) || parseFloat(orderResp.avgPrice)
    || (parseFloat(orderResp.cummulativeQuoteQty) / Math.max(executedQty, 1e-12)) || 0;
  const buyPrice = parseFloat(trade.buyPrice) || 0;
  const feeRate = config.binance.useBnbForFees ? config.fees.bnbTaker : config.fees.normalTaker;
  const pnl = fees.calcPnl({ buyPrice, sellPrice: avgPrice, qty: executedQty, feeRate });
  const filledAt = orderResp.updateTime ? new Date(orderResp.updateTime) : new Date();

  const upd = await Trade.updateOne(
    {
      _id: trade._id,
      state: { $in: ['placed', 'filled', 'holding', 'selling', 'retrying'] },
    },
    {
      $set: {
        state: 'sold',
        sellOrderId: orderResp.orderId,
        sellClientOrderId: orderResp.clientOrderId || null,
        sellPrice: avgPrice,
        sellQty: executedQty,
        sellQuoteQty: parseFloat(orderResp.cummulativeQuoteQty) || 0,
        sellStatus: orderResp.status,
        sellFilledAt: filledAt,
        sellPlacedAt: trade.sellPlacedAt || filledAt,
        realizedPnl: pnl.net,
        pnlPercent: pnl.pnlPercent,
        sellReason: 'reconcile_stuck_selling',
        sellReasonDetail: `manual reconcile (state was 'selling' for ${((Date.now() - new Date(trade.createdAt)) / 3600000).toFixed(1)}h) — Binance status=${orderResp.status}`,
        sellReasonSource: 'scripts/reconcile-stuck-selling',
        sellReasonAt: new Date(),
        error: '',
      },
    }
  );
  return { ok: upd.modifiedCount === 1, pnl, executedQty, avgPrice };
}

async function main() {
  logger.warn('reconcile-stuck-selling-2026-08-22: starting');

  await db.connect();

  // 1. Find all 'selling' trades
  const selling = await Trade.find({ state: 'selling' }).lean();
  logger.warn({ count: selling.length }, 'selling trades located');

  if (!selling.length) {
    logger.warn('nothing to reconcile');
    await db.disconnect();
    return;
  }

  // Snapshot bot names for the audit
  const botIds = [...new Set(selling.map((t) => String(t.botId)))];
  const bots = await Bot.find({ _id: { $in: botIds } }).select('symbol name enabled status totalTrades totalPnl').lean();
  const botMap = new Map(bots.map((b) => [String(b._id), b]));

  logger.warn({
    trades: selling.map((t) => ({
      _id: String(t._id),
      symbol: botMap.get(String(t.botId))?.symbol || '?',
      botStatus: botMap.get(String(t.botId))?.status || '?',
      sellOrderId: t.sellOrderId,
      sellPlacedAt: t.sellPlacedAt,
      ageHours: ((Date.now() - new Date(t.createdAt)) / 3600000).toFixed(1),
    })),
  }, 'plan');

  // 2. Wait for ban to lift
  const ok = await waitForBanToLift();
  if (!ok) {
    logger.error('ban did not lift — aborting');
    await db.disconnect();
    process.exit(3);
  }

  // 3. For each trade, query Binance getOrder() and reconcile
  const summary = {
    filled: [],
    canceled: [],
    stillOpen: [],
    errors: [],
  };

  for (const t of selling) {
    const bot = botMap.get(String(t.botId));
    const tag = {
      tradeId: String(t._id),
      symbol: bot?.symbol,
      sellOrderId: t.sellOrderId,
      ageHours: ((Date.now() - new Date(t.createdAt)) / 3600000).toFixed(1),
      botStatus: bot?.status,
    };

    if (!t.sellOrderId) {
      // No sellOrderId — should not happen for state='selling' but be defensive
      summary.errors.push({ ...tag, error: 'no sellOrderId' });
      continue;
    }

    try {
      const order = await br.getOrder({ symbol: t.symbol, orderId: t.sellOrderId }).catch((e) => {
        // -2013 = order does not exist (too old, or already cleared by Binance)
        const ferr = br.formatBinanceError(e);
        return { __notFound: true, err: ferr || { msg: e.message } };
      });

      if (order.__notFound) {
        summary.errors.push({ ...tag, error: `order not found on Binance: ${order.err.msg}` });
        continue;
      }

      logger.warn({ ...tag, binanceStatus: order.status, executedQty: order.executedQty, price: order.price }, 'Binance order status');

      if (order.status === 'FILLED') {
        const r = await markTradeSoldFromOrder({ trade: t, orderResp: order });
        if (r.ok) {
          // Update bot totals
          const before = botMap.get(String(t.botId));
          await Bot.updateOne(
            { _id: t.botId },
            {
              $inc: {
                totalTrades: 1,
                totalPnl: r.pnl.net,
                winTrades: (r.pnl.net > 0 ? 1 : 0),
              },
              $set: { status: 'idle' },
            }
          );
          summary.filled.push({ ...tag, pnl: r.pnl.net, pnlPct: r.pnl.pnlPercent, executedQty: r.executedQty });
          logger.warn({ ...tag, pnl: r.pnl.net, pnlPct: r.pnl.pnlPercent }, '✅ reconciled FILLED → sold');
        } else {
          summary.errors.push({ ...tag, error: 'modifiedCount=0 (race — already moved)' });
        }
      } else if (order.status === 'CANCELED' || order.status === 'EXPIRED' || order.status === 'REJECTED' || order.status === 'PENDING_CANCEL') {
        // SELL was canceled/expired — trade should go back to 'holding' for the trader to re-arm
        // Since this is reconcile (no trader running for old cases), just mark the trade as failed
        // OR keep state='selling' for the trader to detect — we choose the latter to avoid losing info
        summary.canceled.push({ ...tag, binanceStatus: order.status });
        logger.warn({ ...tag, binanceStatus: order.status }, '⚠️ order canceled/expired on Binance');
      } else {
        // NEW or PARTIALLY_FILLED — trader is probably still running, leave alone
        summary.stillOpen.push({ ...tag, binanceStatus: order.status });
        logger.info({ ...tag, binanceStatus: order.status }, '⏳ order still open — trader should handle');
      }
    } catch (err) {
      summary.errors.push({ ...tag, error: err.message });
      logger.error({ ...tag, err: err.message }, 'reconcile error');
    }

    // Be gentle on rate limit — small delay between calls
    await new Promise((r) => setTimeout(r, 250));
  }

  // 4. Audit report
  const report = {
    script: 'reconcile-stuck-selling-2026-08-22',
    timestamp: new Date().toISOString(),
    totalSelling: selling.length,
    summary,
  };
  const logsDir = path.join(__dirname, '..', 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) { /* ignore */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const reportPath = path.join(logsDir, `reconcile-stuck-selling-${stamp}.json`);
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    logger.info({ reportPath }, 'audit report written');
  } catch (err) {
    logger.warn({ err: err.message }, 'could not write audit report');
  }

  logger.warn({
    filled: summary.filled.length,
    canceled: summary.canceled.length,
    stillOpen: summary.stillOpen.length,
    errors: summary.errors.length,
  }, 'reconcile summary');

  await db.disconnect();
  process.exit(summary.errors.length ? 4 : 0);
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'FATAL');
  process.exit(1);
});
