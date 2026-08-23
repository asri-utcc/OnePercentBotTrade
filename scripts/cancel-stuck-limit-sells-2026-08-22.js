'use strict';

/**
 * One-shot fix for stuck 'selling' trades where the LIMIT SELL never filled on Binance.
 *
 * Background (2026-08-22):
 *   - 11 trades have state='selling' but Binance reports status='NEW' (LIMIT SELL still sitting)
 *   - Root cause: User Data Stream (WS) disconnected from 418 IP ban
 *     → fill events never propagated → state machine stuck in 'selling'
 *   - LIMIT_MAKER orders placed at sellPrice but the price target was never reached
 *
 * Action per trade:
 *   1. DELETE the LIMIT SELL on Binance via cancelOrder (weight 1)
 *   2. Update Trade: state='selling' → 'filled' (BUY filled, no SELL)
 *      clear sellOrderId/sellClientOrderId/sellPrice/sellPlacedAt/sellQty/sellQuoteQty/sellStatus/error
 *   3. Update Bot: status='idle' (so trader on restart can re-place SELL)
 *
 * Why state='filled':
 *   - The BUY filled (so trade is filled state)
 *   - We cancel the SELL so there's no active sell order
 *   - On restart, the trader's reconcileAccountBalance + holding-retry will:
 *     * see base asset balance > 0
 *     * see no active SELL order in our DB (sellOrderId cleared)
 *     * re-place SELL via scheduleHoldingRetry / _onHoldingCycle
 *
 * Idempotency: uses Trade.updateOne guarded by current state='selling' + botId
 *   safe to re-run if a previous run cancelled Binance order but failed mid-DB update.
 */

const path = require('path');
const fs = require('fs');
const db = require('../src/db/connection');
const logger = require('../src/utils/logger');
const br = require('../src/binance/binanceRest');
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

async function main() {
  logger.warn('cancel-stuck-limit-sells-2026-08-22: starting');

  await db.connect();

  // 1. Find all 'selling' trades
  const selling = await Trade.find({ state: 'selling' }).lean();
  logger.warn({ count: selling.length }, 'selling trades located');

  if (!selling.length) {
    logger.warn('nothing to fix');
    await db.disconnect();
    return;
  }

  // Snapshot bot names
  const botIds = [...new Set(selling.map((t) => String(t.botId)))];
  const bots = await Bot.find({ _id: { $in: botIds } }).select('symbol name enabled status').lean();
  const botMap = new Map(bots.map((b) => [String(b._id), b]));

  logger.warn({
    trades: selling.map((t) => ({
      tradeId: String(t._id),
      symbol: t.symbol,
      botStatus: botMap.get(String(t.botId))?.status,
      sellOrderId: t.sellOrderId,
      sellPrice: t.sellPrice,
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

  // 3. Re-verify each order is still NEW on Binance (defense vs race with bot Manager)
  const summary = { canceled: [], alreadyGone: [], errors: [] };

  for (const t of selling) {
    const bot = botMap.get(String(t.botId));
    const tag = {
      tradeId: String(t._id),
      symbol: t.symbol,
      sellOrderId: t.sellOrderId,
      ageHours: ((Date.now() - new Date(t.createdAt)) / 3600000).toFixed(1),
    };

    if (!t.sellOrderId) {
      // No sellOrderId stored — can't cancel via cancelOrder. Skip cancel, do DB revert only.
      logger.warn({ ...tag }, 'no sellOrderId stored — DB-only revert');
    } else {
      try {
        const order = await br.getOrder({ symbol: t.symbol, orderId: t.sellOrderId }).catch((e) => {
          const ferr = br.formatBinanceError(e);
          return { __notFound: true, err: ferr || { msg: e.message } };
        });

        if (order.__notFound) {
          logger.info({ ...tag, msg: order.err.msg }, 'order already gone from Binance (-2011)');
          summary.alreadyGone.push({ ...tag });
        } else if (order.status === 'FILLED') {
          // Race: between our pre-check and now, the order filled.
          //   This would mean we got a WS event we missed — leave alone for now.
          logger.warn({ ...tag, binanceStatus: 'FILLED', executedQty: order.executedQty }, 'order FILLED mid-script — leaving alone');
          continue;
        } else if (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') {
          // Cancel it
          try {
            const cancelResp = await br.cancelOrder({ symbol: t.symbol, orderId: t.sellOrderId });
            logger.warn({ ...tag, cancelStatus: cancelResp && cancelResp.status }, '✅ SELL order canceled on Binance');
            summary.canceled.push({ ...tag });
          } catch (cancelErr) {
            const m = cancelErr.message || '';
            if (/2011|Unknown order|already cancelled|UNKNOWN_ORDER/i.test(m)) {
              logger.info({ ...tag }, 'cancelOrder: -2011 (already gone)');
              summary.alreadyGone.push({ ...tag });
            } else {
              logger.error({ ...tag, err: m }, 'cancelOrder failed');
              summary.errors.push({ ...tag, error: `cancel: ${m}` });
              continue;
            }
          }
        } else {
          // CANCELED / EXPIRED — already gone from Binance
          logger.info({ ...tag, binanceStatus: order.status }, 'order already CANCELED/EXPIRED on Binance');
          summary.alreadyGone.push({ ...tag });
        }
      } catch (err) {
        summary.errors.push({ ...tag, error: err.message });
        logger.error({ ...tag, err: err.message }, 'getOrder error');
        continue;
      }
    }

    // 4. Revert Trade state: 'selling' → 'filled' (BUY filled, SELL canceled → trader re-places)
    const upd = await Trade.updateOne(
      { _id: t._id, state: 'selling' },
      {
        $set: {
          state: 'filled',
          // clear SELL fields so trader doesn't think a SELL is in-flight
          sellOrderId: null,
          sellClientOrderId: null,
          sellPrice: null,
          sellPlacedAt: null,
          sellQty: null,
          sellQuoteQty: null,
          sellStatus: null,
          sellReason: null,
          sellReasonDetail: 'revert_stuck_unfilled_sell',
          sellReasonSource: 'scripts/cancel-stuck-limit-sells',
          sellReasonAt: new Date(),
          error: '',
        },
      }
    );

    if (upd.modifiedCount === 1) {
      // 5. Set Bot.status back to 'idle' so trader can act
      await Bot.updateOne(
        { _id: t.botId, status: 'selling' },
        { $set: { status: 'idle' } }
      );
      logger.warn({ ...tag }, '✅ Trade reverted to filled + Bot.status=idle');
    } else if (upd.modifiedCount === 0) {
      logger.warn({ ...tag }, '⚠️ Trade already not in state=selling — race lost (trader moved it)');
    }

    // Be gentle on rate limit
    await new Promise((r) => setTimeout(r, 250));
  }

  // 6. Audit report
  const report = {
    script: 'cancel-stuck-limit-sells-2026-08-22',
    timestamp: new Date().toISOString(),
    totalSelling: selling.length,
    canceled: summary.canceled.length,
    alreadyGone: summary.alreadyGone.length,
    errors: summary.errors.length,
    summary,
  };
  const logsDir = path.join(__dirname, '..', 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) { /* ignore */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const reportPath = path.join(logsDir, `cancel-stuck-limit-sells-${stamp}.json`);
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    logger.info({ reportPath }, 'audit report written');
  } catch (err) {
    logger.warn({ err: err.message }, 'could not write audit report');
  }

  logger.warn({
    canceled: summary.canceled.length,
    alreadyGone: summary.alreadyGone.length,
    errors: summary.errors.length,
  }, 'cancel-stuck-limit-sells summary');

  await db.disconnect();
  process.exit(summary.errors.length ? 4 : 0);
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'FATAL');
  process.exit(1);
});