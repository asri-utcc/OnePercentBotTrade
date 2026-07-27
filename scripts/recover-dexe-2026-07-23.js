#!/usr/bin/env node
'use strict';

/**
 * recover-dexe-2026-07-23.js — ONE-OFF recovery for DEXE bot
 *
 * What happened at 07:39-07:40 UTC 2026-07-23 (≈14:39-14:40 THB):
 *   1. BUY 1005885315 placed 16.37 DEXE @ 4.274 ($70)
 *   2. WS PARTIALLY_FILLED 1.42 DEXE (~$6.07) at 07:39:02
 *   3. handlePartialBuyFill correctly: atomic-claim → state='filled', NOTIONAL check
 *      passed, cancelled BUY, placed SELL 1005885336 (1.42 @ 4.361)
 *   4. BUT the 60s retry timer fired checkBuyOrder at 07:40:01, didn't check trade.state,
 *      saw the BUY as CANCELED (Case E), overwrote state='selling' → 'cancelled',
 *      tried rePlaceBuy → -2010 insufficient balance
 *   5. SELL 1005885336 still pending on Binance, DB trade state='cancelled'
 *
 * This script:
 *   - Cancels the stale SELL order
 *   - Re-opens the trade as 'selling' with no sellOrderId
 *   - Places a fresh SELL order close to current ask (LIMIT_MAKER)
 *   - If MARKET is needed, falls back
 *
 * Usage:
 *   node scripts/recover-dexe-2026-07-23.js              # dry-run (default)
 *   node scripts/recover-dexe-2026-07-23.js --execute   # actually do it
 */

const mongoose = require('mongoose');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');
const binanceRest = require('../src/binance/binanceRest');
const symbolInfo = require('../src/binance/symbolInfo');
const fees = require('../src/binance/fees');
const config = require('../config');
const recvWindow = config.binance.recvWindow;

const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = !EXECUTE;

const BOT_ID = '6a5f193ac5d569064ef643a2';
const STALE_SELL_ORDER = 1005885336;
const TRADE_ID = '6a6162a5b2af10a918494950';

function log(line) {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

async function main() {
  await require('../src/db/connection').connect();
  log(`=== recover-dexe-2026-07-23 START === mode=${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);

  const trade = await Trade.findById(TRADE_ID).lean();
  if (!trade) {
    log(`FATAL: trade ${TRADE_ID} not found`);
    process.exit(1);
  }
  const bot = await Bot.findById(BOT_ID).lean();
  if (!bot) {
    log(`FATAL: bot ${BOT_ID} not found`);
    process.exit(1);
  }

  log(`trade: ${trade._id} state=${trade.state} buyQty=${trade.buyQty} buyPrice=${trade.buyPrice}`);
  log(`trade sellOrderId=${trade.sellOrderId} sellStatus=${trade.sellStatus}`);
  log(`bot: ${bot.symbol} capitalPerTrade=$${bot.capitalPerTrade} tpPercent=${bot.tpPercent}%`);

  // ── Step 1: check stale SELL order on Binance ─────────────────────
  let staleSell = null;
  try {
    staleSell = await binanceRest.getOrder({ symbol: bot.symbol, orderId: STALE_SELL_ORDER });
    log(`Binance stale SELL ${STALE_SELL_ORDER}: status=${staleSell.status} executedQty=${staleSell.executedQty} origQty=${staleSell.origQty}`);
  } catch (e) {
    log(`WARN: cannot fetch SELL ${STALE_SELL_ORDER}: ${e.message}`);
  }

  if (staleSell && staleSell.status === 'FILLED') {
    // Lucky case — SELL filled already, but DB doesn't know
    log(`\n🎉 SELL already FILLED on Binance! Updating DB to reflect this.`);
    const gross = parseFloat(staleSell.price) * parseFloat(staleSell.executedQty);
    const fees = gross * 0.001;
    const realizedPnl = (parseFloat(staleSell.price) - trade.buyPrice) * parseFloat(staleSell.executedQty) - fees;
    log(`  sellPrice=${staleSell.price} qty=${staleSell.executedQty} gross=$${gross.toFixed(4)} fees=$${fees.toFixed(4)} realizedPnl=$${realizedPnl.toFixed(4)}`);

    if (!DRY_RUN) {
      const r = await Trade.updateOne(
        { _id: TRADE_ID },
        {
          state: 'sold',
          sellOrderId: STALE_SELL_ORDER,
          sellStatus: 'FILLED',
          sellPrice: parseFloat(staleSell.price),
          sellQty: parseFloat(staleSell.executedQty),
          sellQuoteQty: parseFloat(staleSell.cummulativeQuoteQty),
          sellFilledAt: new Date(staleSell.updateTime || Date.now()),
          realizedPnl: Number(realizedPnl.toFixed(6)),
          pnlPercent: Number(((realizedPnl / (trade.buyPrice * parseFloat(staleSell.executedQty))) * 100).toFixed(4)),
          error: `[FIX-2026-07-23] orphan recovered — SELL already filled`,
        }
      );
      log(`  DB updated: ${r.modifiedCount} modified`);

      await Bot.updateOne(
        { _id: bot._id },
        {
          $inc: { totalPnl: realizedPnl, totalTrades: 1, winTrades: realizedPnl > 0 ? 1 : 0 },
          $set: { status: 'idle', lastError: '' },
        }
      );
      log(`  Bot stats updated`);
    }
    await mongoose.disconnect();
    return;
  }

  if (staleSell && (staleSell.status === 'NEW' || staleSell.status === 'PARTIALLY_FILLED')) {
    log(`\nSELL ${STALE_SELL_ORDER} is ${staleSell.status} on Binance — need to cancel and replace`);
    if (!DRY_RUN) {
      try {
        await binanceRest.cancelOrder({ symbol: bot.symbol, orderId: STALE_SELL_ORDER });
        log(`  cancelled SELL ${STALE_SELL_ORDER}`);
      } catch (e) {
        log(`  ERROR cancelling SELL: ${e.message}`);
      }
    } else {
      log(`  DRY-RUN: would cancel SELL ${STALE_SELL_ORDER}`);
    }
  }

  // ── Step 2: check current price ───────────────────────────────────
  const ticker = await binanceRest.get24hrTickers({ symbol: bot.symbol });
  const lastPrice = parseFloat(ticker.lastPrice);
  const bidPrice = parseFloat(ticker.bidPrice);
  const askPrice = parseFloat(ticker.askPrice);
  log(`\ncurrent DEXE: last=${lastPrice} bid=${bidPrice} ask=${askPrice}`);

  // ── Step 3: decide recovery strategy ──────────────────────────────
  // Try LIMIT_MAKER just above current ask — fills quickly as maker, low fees.
  // If spread is too tight, fall back to MARKET.
  const buyPrice = parseFloat(trade.buyPrice);
  const buyQty = parseFloat(trade.buyQty);
  const feeRate = fees.getMakerRate();

  // Recovery-oriented target: tpPercent=0.3% (override bot config) — small profit,
  // no-loss. Place SELL at TP target as LIMIT_MAKER. If can't fill as maker,
  // the script will fall back to MARKET only if explicitly chosen.
  const RECOVERY_TP_PCT = 0.3; // override bot's 1.881%
  await symbolInfo.loadSymbol(bot.symbol);
  const info = symbolInfo.getCached(bot.symbol);
  const tickSize = info.priceFilter.tickSize;

  const tpPriceRaw = fees.calcSellPrice({ buyPrice, tpPercent: RECOVERY_TP_PCT, feeRate });
  const targetSell = symbolInfo.roundPrice(tpPriceRaw, tickSize).toString();
  log(`\nrecovery TP target: tpPercent=${RECOVERY_TP_PCT}% → raw=${tpPriceRaw.toFixed(6)} rounded=${targetSell} (tickSize=${tickSize})`);
  log(`  current bid=${bidPrice} ask=${askPrice} last=${lastPrice}`);
  log(`  target ${targetSell} vs ask ${askPrice}: ${parseFloat(targetSell) > askPrice ? 'ABOVE ask (post-only OK, will fill as maker)' : 'BELOW ask (post-only will reject → fallback to MARKET)'}`);

  // informational: original TP target
  const origTpRaw = fees.calcSellPrice({ buyPrice, tpPercent: bot.tpPercent, feeRate });
  log(`  (informational: original bot TP target @ ${bot.tpPercent}% = ${symbolInfo.roundPrice(origTpRaw, tickSize)})`);

  if (DRY_RUN) {
    log(`\n=== DRY-RUN summary ===`);
    log(`  1. would cancel SELL ${STALE_SELL_ORDER}`);
    log(`  2. would place new SELL 1.42 DEXE @ ${targetSell} (LIMIT_MAKER, tpPercent=0.3%, no MARKET fallback)`);
    log(`  3. would update DB trade: state='selling', sellOrderId=<new>, error='[FIX-2026-07-23] orphan recovery'`);
    log(`\nrun with --execute to apply`);
    await mongoose.disconnect();
    return;
  }

  // ── Step 4: place new SELL (LIMIT_MAKER only, no MARKET fallback) ───
  let newSellResp = null;
  const newClientOrderId = `recover-${Date.now()}-sell`;
  log(`\nplacing LIMIT_MAKER SELL 1.42 @ ${targetSell} (no MARKET fallback — ผู้ใช้สั่งอย่าขาดทุน)`);
  try {
    newSellResp = await binanceRest.newOrder({
      symbol: bot.symbol,
      side: 'SELL',
      type: 'LIMIT_MAKER',
      quantity: buyQty.toString(),
      price: targetSell,
      newClientOrderId,
      recvWindow,
    });
    log(`  SELL placed: orderId=${newSellResp.orderId} status=${newSellResp.status}`);
  } catch (err) {
    const fe = binanceRest.formatBinanceError(err);
    log(`  LIMIT_MAKER failed: ${fe.msg || err.message}`);
    log(`  → SELL NOT placed. Old SELL ${STALE_SELL_ORDER} (if status=NEW) is still pending on Binance.`);
    log(`  → Run again later when price moves into range, or cancel manually.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!newSellResp) {
    log(`FATAL: SELL response is null`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // ── Step 5: update DB ─────────────────────────────────────────────
  const newState = newSellResp.status === 'FILLED' ? 'sold' : 'selling';
  const update = {
    state: newState,
    sellOrderId: newSellResp.orderId,
    sellClientOrderId: newClientOrderId,
    sellPrice: newSellResp.status === 'FILLED' ? parseFloat(newSellResp.price || lastPrice) : parseFloat(targetSell),
    sellQty: buyQty,
    sellQuoteQty: parseFloat(newSellResp.cummulativeQuoteQty) || null,
    sellStatus: newSellResp.status,
    sellPlacedAt: new Date(),
    sellFilledAt: newSellResp.status === 'FILLED' ? new Date(newSellResp.updateTime || Date.now()) : null,
    error: `[FIX-2026-07-23] orphan recovery: cancelled stale SELL ${STALE_SELL_ORDER}, placed new SELL ${newSellResp.orderId}`,
  };

  if (newSellResp.status === 'FILLED') {
    const avgSell = parseFloat(newSellResp.price) || lastPrice;
    const gross = (avgSell - buyPrice) * buyQty;
    const feeCost = buyQty * avgSell * 0.001;
    update.realizedPnl = Number((gross - feeCost).toFixed(6));
    update.pnlPercent = Number(((update.realizedPnl / (buyPrice * buyQty)) * 100).toFixed(4));
  }

  const r = await Trade.updateOne({ _id: TRADE_ID, state: { $in: ['cancelled', 'failed'] } }, { $set: update });
  log(`\nDB updated: ${r.modifiedCount} modified → state=${newState}`);

  if (newSellResp.status === 'FILLED') {
    await Bot.updateOne(
      { _id: bot._id },
      {
        $inc: { totalPnl: update.realizedPnl, totalTrades: 1, winTrades: update.realizedPnl > 0 ? 1 : 0 },
        $set: { status: 'idle', lastError: '' },
      }
    );
    log(`Bot stats updated: pnl=$${update.realizedPnl.toFixed(4)}`);
  } else {
    await Bot.updateOne(
      { _id: bot._id },
      { $set: { status: 'selling', lastError: `orphan recovery in progress (sellOrderId=${newSellResp.orderId})` } }
    );
  }

  await mongoose.disconnect();
  log(`\n=== DONE ===`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}\n${err.stack}`);
  process.exit(1);
});