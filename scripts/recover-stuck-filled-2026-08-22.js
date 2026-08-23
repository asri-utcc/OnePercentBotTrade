'use strict';

/**
 * One-shot recovery for trades stuck in state='filled' with no SELL placed.
 *
 * Background (2026-08-22):
 *   - 11 trades were stuck in 'selling' state due to Binance 418 ban
 *   - LIMIT SELL orders canceled + trade reverted to 'filled' (cancel-stuck-limit-sells script)
 *   - But trader has no startup-recovery path for state='filled' with no sellOrderId
 *   - Need to place new SELL orders directly + update trade state to 'selling'
 *
 * Action per trade:
 *   1. Compute TP via same logic as trader._computeTp() (use fees.calcSellPrice + bot config)
 *   2. Place LIMIT_MAKER SELL via binanceRest.newOrder()
 *   3. Atomic update Trade: state='filled' → 'selling' with sellOrderId, sellPrice, sellQty
 *
 * Idempotency: uses Trade.updateOne guarded by state='filled' + sellOrderId=null
 */

const path = require('path');
const fs = require('fs');
const config = require('../config');
const db = require('../src/db/connection');
const logger = require('../src/utils/logger');
const br = require('../src/binance/binanceRest');
const fees = require('../src/binance/fees');
const symbolInfo = require('../src/binance/symbolInfo');
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
        const ts = await br.getServerTime();
        const ms = Number(ts);
        if (Number.isFinite(ms) && ms > 0) {
          logger.info({ attempt, serverTime: new Date(ms).toISOString() }, '✅ ban lifted');
          return true;
        }
      } catch (err) {
        logger.info({ attempt, err: err.message }, '⏳ API call failed');
      }
    } else {
      const waitSec = Math.max(1, Math.round((status.banUntilMs - Date.now()) / 1000));
      logger.info({ attempt, waitSec }, '⏳ ban in effect');
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

function makeClientOrderId(symbol, retryCount = 0) {
  // br.makeClientOrderId may not be available — build directly
  const base = symbol.replace(/USDT$|USDC$|BUSD$/, '');
  const ts = Date.now();
  const r = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `recover-sell-${base}-${ts}-${r}-${retryCount}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36);
}

async function main() {
  logger.warn('recover-stuck-filled-2026-08-22: starting');
  await db.connect();

  // Find trades with state='filled' and no sellOrderId (the reverted-but-not-resold)
  const stuck = await Trade.find({ state: 'filled', sellOrderId: null, buyOrderId: { $ne: null } }).lean();
  logger.warn({ count: stuck.length }, 'stuck-filled trades located');

  if (!stuck.length) {
    logger.warn('nothing to recover');
    await db.disconnect();
    return;
  }

  const botIds = [...new Set(stuck.map((t) => String(t.botId)))];
  const bots = await Bot.find({ _id: { $in: botIds } }).lean();
  const botMap = new Map(bots.map((b) => [String(b._id), b]));

  const ok = await waitForBanToLift();
  if (!ok) {
    logger.error('ban did not lift — aborting');
    await db.disconnect();
    process.exit(3);
  }

  const summary = { placed: [], errors: [] };
  for (const t of stuck) {
    const bot = botMap.get(String(t.botId));
    const tag = { tradeId: String(t._id), symbol: t.symbol, botId: String(t.botId) };

    if (!bot) {
      summary.errors.push({ ...tag, error: 'bot not found' });
      continue;
    }
    if (!t.buyQty || !t.buyPrice) {
      summary.errors.push({ ...tag, error: 'missing buyQty/buyPrice' });
      continue;
    }

    try {
      // 1. Compute TP using bot's TP config (mirror trader._computeTp without trend mult)
      const tpPercent = bot.tpPercent || config.defaults?.tpPercent || 0.28;
      const feeRate = config.binance.useBnbForFees ? config.fees.bnbTaker : config.fees.normalTaker;
      const sellPrice = fees.calcSellPrice({ buyPrice: parseFloat(t.buyPrice), tpPercent, feeRate });
      const sellPriceStr = sellPrice.toFixed(8);

      // 2. Validate
      let validation;
      try { validation = symbolInfo.validateOrder({ symbol: t.symbol, price: sellPriceStr, qty: parseFloat(t.buyQty) }); }
      catch (e) { validation = { ok: false, reason: e.message }; }
      if (!validation || !validation.ok) {
        summary.errors.push({ ...tag, error: `validation: ${validation?.reason || 'unknown'}` });
        continue;
      }

      // 3. Place LIMIT_MAKER SELL
      const clientOrderId = makeClientOrderId(t.symbol, t.retryCount || 0);
      logger.info({ ...tag, sellPrice: sellPriceStr, qty: t.buyQty, clientOrderId }, 'placing LIMIT_MAKER SELL');
      const sellResp = await br.newOrder({
        symbol: t.symbol,
        side: 'SELL',
        type: 'LIMIT_MAKER',
        quantity: String(t.buyQty),
        price: sellPriceStr,
        newClientOrderId: clientOrderId,
      });

      // 4. Atomic update
      const upd = await Trade.updateOne(
        { _id: t._id, state: 'filled', sellOrderId: null },
        {
          $set: {
            state: 'selling',
            sellOrderId: sellResp.orderId,
            sellClientOrderId: clientOrderId,
            sellPrice: parseFloat(sellPriceStr),
            sellQty: parseFloat(t.buyQty),
            sellStatus: sellResp.status,
            sellPlacedAt: new Date(),
            targetSellPrice: parseFloat(sellPriceStr),
            sellReason: null,
            error: '',
          },
        }
      );

      if (upd.modifiedCount === 1) {
        await Bot.updateOne({ _id: t.botId }, { $set: { status: 'selling' } }).catch(() => null);
        summary.placed.push({ ...tag, sellOrderId: sellResp.orderId, sellPrice: sellPriceStr });
        logger.warn({ ...tag, sellOrderId: sellResp.orderId, sellPrice: sellPriceStr }, '✅ SELL placed');
      } else {
        // race: cancel the just-placed order
        logger.warn({ ...tag }, 'race lost — cancelling orphan SELL');
        await br.cancelOrder({ symbol: t.symbol, orderId: sellResp.orderId }).catch(() => null);
        summary.errors.push({ ...tag, error: 'modifiedCount=0 (race)' });
      }
    } catch (err) {
      const m = err.message || String(err);
      logger.error({ ...tag, err: m }, 'SELL place failed');
      summary.errors.push({ ...tag, error: m });
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  // Audit
  const report = {
    script: 'recover-stuck-filled-2026-08-22',
    timestamp: new Date().toISOString(),
    totalStuck: stuck.length,
    placed: summary.placed.length,
    errors: summary.errors.length,
    summary,
  };
  const logsDir = path.join(__dirname, '..', 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) { /* ignore */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const reportPath = path.join(logsDir, `recover-stuck-filled-${stamp}.json`);
  try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); logger.info({ reportPath }, 'audit report written'); } catch (_) {}

  logger.warn({ placed: summary.placed.length, errors: summary.errors.length }, 'recover-stuck-filled summary');
  await db.disconnect();
  process.exit(summary.errors.length ? 4 : 0);
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'FATAL');
  process.exit(1);
});