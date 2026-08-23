'use strict';

/**
 * hei-reconcile-combined-sell.js
 *
 * One-shot reconciliation script for HEIUSDT bot — splits Binance order
 * 389549754 (43.3 HEI MARKET SELL @ 0.2018) across both original DB trades:
 *
 *   - Trade 1 (6a74520f): buyQty=19.3 @ 0.4657 → 19.3 HEI sold @ 0.2018
 *   - Trade 2 (6a7465ad): buyQty=24   @ 0.3737 → 24   HEI sold @ 0.2018
 *
 * Background:
 *   - At 00:00:22 user called /api/bots/:id/force-close (forceCloseBot). 1
 *     succeeded (trade 3 = 27.3 HEI), 2 errored (trade 1, trade 2 — likely
 *     NOTIONAL filter, since HEI price dropped under 0.21 = $5 notional
 *     threshold).
 *   - At 00:07:25 positionWatchdog picked up trade 1 (stuck in 'selling'),
 *     placed a SINGLE MARKET SELL of 43.3 HEI (= full freeQty because
 *     buyQtyCap check fell through — buyQty became 0 after a previous bad
 *     update). Order 389549754 filled @ 0.2018.
 *   - The watchdog's forceCloseTrade attributed the WHOLE 43.3 HEI to trade 1
 *     → realizedPnl = -11.45 USDT, sellQty=43.3, sellFilledQty=null,
 *     sellCumulativeQuoteQty=null. Bot $inc was NOT applied (modifiedCount=0
 *     atomic guard conflict).
 *   - Trade 2 is stuck in 'filled' state with sellStatus='CANCELED' (the
 *     original LIMIT_MAKER 383431578 was cancelled). Subsequent watchdog
 *     attempts keep failing NOTIONAL.
 *
 *   This script fixes the attribution:
 *     - Trade 1: correct sellQty=19.3, sellCumulativeQuoteQty=3.89474, PnL=-5.106
 *     - Trade 2: mark 'sold' with sellQty=24, sellCumulativeQuoteQty=4.8432, PnL=-4.167
 *     - Bot totals: +2 trades (both losses), totalPnl += (-5.106 + -4.167)
 *
 * Date: 2026-08-07
 */

const path = require('path');
const mongoose = require('mongoose');
const { connect: connectMongo, disconnect: disconnectMongo } = require(path.join(__dirname, '..', 'src', 'db', 'connection'));

const Bot = require('../src/db/models/Bot');
const Trade = require('../src/db/models/Trade');
const fees = require('../src/binance/fees');
const config = require('../config');
const logger = require('../src/utils/logger');
const eventBus = require('../src/services/eventBus');

const BOT_ID = '6a73173292d15e6d2f41f0b4';
const TRADE_1_ID = '6a74520f34de5faac700e37a'; // buyQty 19.3
const TRADE_2_ID = '6a7465ad34de5faac7011996'; // buyQty 24
const BINANCE_ORDER_ID = 389549754;
const AVG_SELL_PRICE = 0.2018;
const SELL_FILLED_AT = new Date('2026-08-06T17:07:25.851Z');

const feeRate = config.binance.useBnbForFees ? config.fees.bnbTaker : config.fees.normalTaker;
console.log(`feeRate = ${feeRate} (useBnbForFees=${config.binance.useBnbForFees})`);

function computePnl(buyPrice, buyQty, sellPrice) {
  const pnlRes = fees.calcPnl({
    buyPrice,
    sellPrice,
    qty: buyQty,
    feeRate,
  });
  return pnlRes;
}

async function main() {
  console.log('=== HEI combined-sell reconciliation ===');
  await connectMongo();

  // ─── 1. Trade 1: correct the attribution ───
  const t1 = await Trade.findById(TRADE_1_ID);
  if (!t1) throw new Error(`Trade 1 ${TRADE_1_ID} not found`);
  console.log(`\nTrade 1 (${TRADE_1_ID}):`);
  console.log(`  state=${t1.state}, buyPrice=${t1.buyPrice}, buyQty=${t1.buyQty}`);
  console.log(`  current: sellPrice=${t1.sellPrice}, sellQty=${t1.sellFilledQty || 'null'}, realizedPnl=${t1.realizedPnl}, pnlPercent=${t1.pnlPercent}`);

  const t1BuyPrice = parseFloat(t1.buyPrice);
  const t1BuyQty = parseFloat(t1.buyQty);
  const t1Pnl = computePnl(t1BuyPrice, t1BuyQty, AVG_SELL_PRICE);
  const t1Quote = t1BuyQty * AVG_SELL_PRICE;
  console.log(`  CORRECT: sellPrice=${AVG_SELL_PRICE}, sellQty=${t1BuyQty}, quote=${t1Quote.toFixed(4)}`);
  console.log(`  CORRECT pnl: gross=${t1Pnl.gross.toFixed(4)}, fees=${t1Pnl.fees.toFixed(4)}, net=${t1Pnl.net.toFixed(4)} (${t1Pnl.pnlPercent.toFixed(2)}%)`);

  // Compute the diff in realizedPnl (because we may need to revert a prior bad update)
  const t1OldPnl = t1.realizedPnl || 0;
  const t1PnlDiff = t1Pnl.net - t1OldPnl;
  console.log(`  old realizedPnl=${t1OldPnl.toFixed(4)}, diff=${t1PnlDiff.toFixed(4)}`);

  const t1Upd = await Trade.updateOne(
    { _id: TRADE_1_ID },
    {
      $set: {
        sellOrderId: BINANCE_ORDER_ID,
        sellFilledQty: t1BuyQty,
        sellCumulativeQuoteQty: t1Quote,
        sellQuoteQty: t1Quote,
        sellPrice: AVG_SELL_PRICE,
        sellQty: t1BuyQty,
        sellStatus: 'FILLED',
        realizedPnl: t1Pnl.net,
        pnlPercent: t1Pnl.pnlPercent,
        sellReason: 'manual_api_market',
        sellReasonDetail: `combined MARKET SELL via emergency script — ${t1BuyQty}/43.3 HEI @ ${AVG_SELL_PRICE} USDT (Binance order ${BINANCE_ORDER_ID}, originally attributed to this trade only)`,
        sellReasonAt: SELL_FILLED_AT,
        sellReasonSource: 'scripts.hei-reconcile-combined-sell',
        sellPlacedAt: SELL_FILLED_AT,
        sellFilledAt: SELL_FILLED_AT,
      },
    }
  );
  console.log(`  Trade 1 update: modifiedCount=${t1Upd.modifiedCount}`);

  // ─── 2. Trade 2: mark 'sold' with proportional attribution ───
  const t2 = await Trade.findById(TRADE_2_ID);
  if (!t2) throw new Error(`Trade 2 ${TRADE_2_ID} not found`);
  console.log(`\nTrade 2 (${TRADE_2_ID}):`);
  console.log(`  state=${t2.state}, buyPrice=${t2.buyPrice}, buyQty=${t2.buyQty}`);
  console.log(`  current: sellPrice=${t2.sellPrice}, sellStatus=${t2.sellStatus}`);

  const t2BuyPrice = parseFloat(t2.buyPrice);
  const t2BuyQty = parseFloat(t2.buyQty);
  const t2Pnl = computePnl(t2BuyPrice, t2BuyQty, AVG_SELL_PRICE);
  const t2Quote = t2BuyQty * AVG_SELL_PRICE;
  console.log(`  CORRECT: sellPrice=${AVG_SELL_PRICE}, sellQty=${t2BuyQty}, quote=${t2Quote.toFixed(4)}`);
  console.log(`  CORRECT pnl: gross=${t2Pnl.gross.toFixed(4)}, fees=${t2Pnl.fees.toFixed(4)}, net=${t2Pnl.net.toFixed(4)} (${t2Pnl.pnlPercent.toFixed(2)}%)`);

  const t2Upd = await Trade.updateOne(
    { _id: TRADE_2_ID },
    {
      $set: {
        state: 'sold',
        sellOrderId: BINANCE_ORDER_ID,
        sellFilledQty: t2BuyQty,
        sellCumulativeQuoteQty: t2Quote,
        sellQuoteQty: t2Quote,
        sellPrice: AVG_SELL_PRICE,
        sellQty: t2BuyQty,
        sellStatus: 'FILLED',
        realizedPnl: t2Pnl.net,
        pnlPercent: t2Pnl.pnlPercent,
        sellReason: 'manual_api_market',
        sellReasonDetail: `combined MARKET SELL via emergency script — ${t2BuyQty}/43.3 HEI @ ${AVG_SELL_PRICE} USDT (Binance order ${BINANCE_ORDER_ID}, retroactive split — original LIMIT_MAKER 383431578 was cancelled before fill)`,
        sellReasonAt: SELL_FILLED_AT,
        sellReasonSource: 'scripts.hei-reconcile-combined-sell',
        sellPlacedAt: SELL_FILLED_AT,
        sellFilledAt: SELL_FILLED_AT,
        error: '',
      },
    }
  );
  console.log(`  Trade 2 update: modifiedCount=${t2Upd.modifiedCount}`);

  // ─── 3. Bot totals ───
  // Bot's current totals:
  //   totalPnl: -2.6616477750000027 (unchanged — earlier $inc was guarded by modifiedCount=0)
  //   totalTrades: 5
  //   winTrades: 4
  //
  // Trade 3 (6a746e2a) was force-closed at 00:00:22 → incremented to totalTrades=5 ✓
  // Trade 1 was force-closed at 00:07:25 but modifiedCount=0 → not incremented
  // Trade 2 was never force-closed
  //
  // Now: we need to:
  //   - apply t1PnlDiff to bot.totalPnl (since t1's pnl changed from -11.45 to -5.106)
  //   - increment totalTrades by 1 (trade 2 wasn't counted yet — but trade 1 was also not counted before, so only +1 here? Let me check)
  //
  // Actually wait — let me trace the original totalTrades:
  //   Looking at trade history, before the force-close events at 00:00, bot.totalTrades was likely 3 (sold trades: 6a73cf4114eb21f18b041429, 6a73d36d14eb21f18b041fce, 6a73dbf614eb21f18b04377d, 6a744dde34de5faac700d7e2 — that's 4 sold)
  //   Actually 4 sold before force-close: totalTrades=4 originally
  //   After force-close of trade 3 at 00:00:22: totalTrades=5 (we see it now)
  //   Trade 1 was force-closed at 00:07:25 but modifiedCount=0
  //   Trade 2 was never force-closed
  // So now we need to:
  //   - Add trade 1: +1 trade
  //   - Add trade 2: +1 trade
  //   - totalTrades += 2 (now 7)
  //   - totalPnl: apply t1PnlDiff (correct the wrong -11.45 to -5.106), then add t2Pnl
  //
  // For winTrades: both are losses, so no increment
  //
  // t1PnlDiff = t1Pnl.net - t1OldPnl = -5.106 - (-11.45) = +6.34 (RECOVER some previously lost PnL)

  console.log('\n=== Bot totals update ===');
  const bot = await Bot.findById(BOT_ID);
  console.log(`Before: totalPnl=${bot.totalPnl}, totalTrades=${bot.totalTrades}, winTrades=${bot.winTrades}`);

  const t1IncTotalTrades = t1OldPnl === 0 ? 1 : 0; // t1 was never counted (modifiedCount=0)
  const t2IncTotalTrades = 1; // t2 was never counted
  const t1IncWin = 0; // t1 is a loss
  const t2IncWin = 0; // t2 is a loss

  // Apply: correct t1 pnl diff + add t1 trade (if not previously counted) + add t2 trade + t2 pnl
  const totalPnlDelta = t1PnlDiff + t2Pnl.net;
  const totalTradesDelta = t1IncTotalTrades + t2IncTotalTrades;

  console.log(`Delta: totalPnl += ${totalPnlDelta.toFixed(4)} (t1Diff=${t1PnlDiff.toFixed(4)}, t2=${t2Pnl.net.toFixed(4)})`);
  console.log(`Delta: totalTrades += ${totalTradesDelta}, winTrades += 0`);

  const botUpd = await Bot.updateOne(
    { _id: BOT_ID },
    {
      $inc: {
        totalPnl: totalPnlDelta,
        totalTrades: totalTradesDelta,
        winTrades: 0,
      },
      $set: {
        warning: '',
        warningAt: null,
      },
    }
  );
  console.log(`Bot update: modifiedCount=${botUpd.modifiedCount}`);

  const botAfter = await Bot.findById(BOT_ID);
  console.log(`After: totalPnl=${botAfter.totalPnl}, totalTrades=${botAfter.totalTrades}, winTrades=${botAfter.winTrades}`);

  // ─── 4. Emit events for dashboard ───
  eventBus.emit('trade:update', {
    tradeId: TRADE_1_ID,
    botId: BOT_ID,
    state: 'sold',
    reason: 'manual_api_market',
    reasonDetail: `reconciled — combined sell split ${t1BuyQty}/43.3 HEI @ ${AVG_SELL_PRICE}`,
    realizedPnl: t1Pnl.net,
    pnlPercent: t1Pnl.pnlPercent,
  });
  eventBus.emit('trade:update', {
    tradeId: TRADE_2_ID,
    botId: BOT_ID,
    state: 'sold',
    reason: 'manual_api_market',
    reasonDetail: `reconciled — combined sell split ${t2BuyQty}/43.3 HEI @ ${AVG_SELL_PRICE}`,
    realizedPnl: t2Pnl.net,
    pnlPercent: t2Pnl.pnlPercent,
  });
  eventBus.emit('bot:status', { botId: BOT_ID, status: 'idle' });

  console.log('\n=== SUMMARY ===');
  console.log(`Trade 1: realizedPnl=${t1Pnl.net.toFixed(4)} USDT (${t1Pnl.pnlPercent.toFixed(2)}%)`);
  console.log(`Trade 2: realizedPnl=${t2Pnl.net.toFixed(4)} USDT (${t2Pnl.pnlPercent.toFixed(2)}%)`);
  console.log(`Total combined loss: ${(t1Pnl.net + t2Pnl.net).toFixed(4)} USDT`);
  console.log(`Bot totalPnl: ${bot.totalPnl.toFixed(4)} → ${botAfter.totalPnl.toFixed(4)}`);
  console.log(`Bot totalTrades: ${bot.totalTrades} → ${botAfter.totalTrades}`);
  console.log('=== DONE ===');
}

main()
  .then(async () => {
    await disconnectMongo();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('SCRIPT FAILED:', err);
    logger.error({ err: err.message, stack: err.stack }, 'hei-reconcile-combined-sell failed');
    try { await disconnectMongo(); } catch (_) {}
    process.exit(1);
  });