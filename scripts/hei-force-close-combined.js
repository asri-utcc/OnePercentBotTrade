'use strict';

/**
 * hei-force-close-combined.js
 *
 * One-shot emergency script: place a SINGLE combined MARKET SELL for ALL HEI
 * held by bot HEIUSDT, then backfill both open trades in DB with the actual
 * fill data + per-trade PnL.
 *
 * Reason: bot's 2 LIMIT_MAKER SELL orders (380516174, 383431578) were
 * cancelled/expired when the bot was disabled, but the DB trades are still
 * stuck in state='selling' with sellStatus=''. Calling forceCloseBot sequentially
 * leaves ~0.3 HEI orphan (stepSize rounding). User wants combined sell.
 *
 * Date: 2026-08-07 — emergency
 */

const path = require('path');
const mongoose = require('mongoose');
const { connect: connectMongo, disconnect: disconnectMongo } = require(path.join(__dirname, '..', 'src', 'db', 'connection'));

const Bot = require('../src/db/models/Bot');
const Trade = require('../src/db/models/Trade');
const binanceRest = require('../src/binance/binanceRest');
const fees = require('../src/binance/fees');
const config = require('../config');
const logger = require('../src/utils/logger');
const eventBus = require('../src/services/eventBus');

const BOT_ID = '6a73173292d15e6d2f41f0b4';
const SYMBOL = 'HEIUSDT';
const TRADE_IDS = [
  '6a74520f34de5faac700e37a', // buyPrice=0.4657, buyQty=19.3
  '6a7465ad34de5faac7011996', // buyPrice=0.3737, buyQty=24
];

async function main() {
  console.log('=== HEI combined force-close ===');

  // Connect to Mongo first (the connection module is lazy — server.js calls connect() at startup)
  await connectMongo();
  console.log('Mongo connected');

  // Sanity check: load bot + trades
  const bot = await Bot.findById(BOT_ID);
  if (!bot) {
    throw new Error(`Bot ${BOT_ID} not found`);
  }
  console.log(`Bot: ${bot.name} (${bot.symbol}, enabled=${bot.enabled}, status=${bot.status})`);

  const trades = await Trade.find({ _id: { $in: TRADE_IDS } });
  if (trades.length !== TRADE_IDS.length) {
    throw new Error(`Expected ${TRADE_IDS.length} trades, got ${trades.length}`);
  }
  let totalSellQty = 0;
  let totalCostBasis = 0;
  trades.forEach((t) => {
    if (!['placed', 'partial_wait', 'filled', 'holding', 'selling', 'retrying', 'partial_sell_wait', 'stopping'].includes(t.state)) {
      throw new Error(`Trade ${t._id} in unexpected state ${t.state}`);
    }
    const qty = parseFloat(t.buyQty);
    const px = parseFloat(t.buyPrice);
    totalSellQty += qty;
    totalCostBasis += qty * px;
    console.log(`Trade ${t._id}: state=${t.state}, buyPrice=${px}, buyQty=${qty}, sellOrderId=${t.sellOrderId}`);
  });
  console.log(`Total qty: ${totalSellQty} HEI, total cost basis: ${totalCostBasis.toFixed(4)} USDT`);

  // Get fresh balance
  const acc = await binanceRest.getAccount();
  const heiBal = (acc.balances || []).find((b) => b.asset === 'HEI');
  const freeQty = heiBal ? parseFloat(heiBal.free) : 0;
  const lockedQty = heiBal ? parseFloat(heiBal.locked) : 0;
  console.log(`HEI balance: free=${freeQty}, locked=${lockedQty}`);

  if (freeQty < totalSellQty - 0.5) {
    throw new Error(`Insufficient freeQty ${freeQty} < expected ${totalSellQty}`);
  }

  // Cancel any leftover open orders for HEIUSDT first (just in case)
  try {
    const openOrders = await binanceRest.getOpenOrders({ symbol: SYMBOL });
    if (Array.isArray(openOrders) && openOrders.length > 0) {
      console.log(`Cancelling ${openOrders.length} leftover open orders for ${SYMBOL}`);
      for (const o of openOrders) {
        try {
          await binanceRest.cancelOrder({ symbol: SYMBOL, orderId: o.orderId });
        } catch (e) {
          console.warn(`Cancel ${o.orderId} failed: ${e.message}`);
        }
      }
      // wait for cancellations to settle
      await new Promise((r) => setTimeout(r, 600));
    } else {
      console.log('No open orders for HEIUSDT');
    }
  } catch (e) {
    console.warn('getOpenOrders failed (proceeding):', e.message);
  }

  // Round qty down to stepSize (0.1) for HEI
  const sellQty = (Math.floor(freeQty * 10) / 10).toFixed(1); // floor to 0.1
  console.log(`Placing MARKET SELL of ${sellQty} HEI...`);

  const newClientOrderId = `hei-fc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resp = await binanceRest.newOrder({
    symbol: SYMBOL,
    side: 'SELL',
    type: 'MARKET',
    quantity: sellQty,
    newClientOrderId,
    recvWindow: config.binance.recvWindow,
  });

  console.log('MARKET SELL response:', JSON.stringify(resp, null, 2));

  const executed = parseFloat(resp.executedQty) || 0;
  const cummQuote = parseFloat(resp.cummulativeQuoteQty) || 0;
  const avgSell = parseFloat(resp.price) || (executed > 0 ? cummQuote / executed : 0);
  console.log(`Executed: ${executed} HEI @ avg ${avgSell} USDT, gross ${cummQuote.toFixed(4)} USDT`);

  // Fee rate (taker for MARKET leg)
  const feeRate = config.binance.useBnbForFees ? config.fees.bnbTaker : config.fees.normalTaker;
  console.log(`feeRate = ${feeRate} (useBnbForFees=${config.binance.useBnbForFees})`);

  // Per-trade proportional PnL — distribute sell proceeds by qty ratio
  let totalNetPnl = 0;
  let totalTradesAdded = 0;
  let totalWinAdded = 0;
  const fillTimestamp = new Date(resp.updateTime || Date.now());
  const placedTimestamp = new Date();

  for (const trade of trades) {
    const buyQty = parseFloat(trade.buyQty);
    const buyPrice = parseFloat(trade.buyPrice);

    // Per-trade PnL using fees.calcPnl (sellPrice = avgSell, qty = buyQty)
    const pnlRes = fees.calcPnl({
      buyPrice,
      sellPrice: avgSell,
      qty: buyQty,
      feeRate,
    });

    // Atomic state transition: 'selling'/'filled'/etc → 'sold'
    const upd = await Trade.updateOne(
      {
        _id: trade._id,
        state: { $in: ['placed', 'partial_wait', 'filled', 'holding', 'selling', 'retrying', 'partial_sell_wait', 'stopping'] },
      },
      {
        $set: {
          state: 'sold',
          sellOrderId: resp.orderId,
          sellClientOrderId: resp.clientOrderId || newClientOrderId,
          sellPrice: avgSell,
          sellQty: buyQty, // original qty for this trade (NOT the actual MARKET qty — that's distributed)
          sellFilledQty: (buyQty / parseFloat(sellQty)) * executed, // proportional actual fill
          sellCumulativeQuoteQty: (buyQty / parseFloat(sellQty)) * cummQuote,
          sellQuoteQty: buyQty * avgSell,
          sellStatus: resp.status || 'FILLED',
          sellFilledAt: fillTimestamp,
          sellPlacedAt: placedTimestamp,
          realizedPnl: pnlRes.net,
          pnlPercent: pnlRes.pnlPercent,
          sellReason: 'manual_api_market',
          sellReasonDetail: `combined MARKET SELL via emergency script — ${buyQty}/${parseFloat(sellQty)} of ${executed} HEI @ ${avgSell} USDT`,
          sellReasonAt: new Date(),
          sellReasonSource: 'scripts.hei-force-close-combined',
          error: '',
        },
      }
    );
    console.log(`Trade ${trade._id}: marked sold, realizedPnl=${pnlRes.net.toFixed(4)} USDT (${pnlRes.pnlPercent.toFixed(2)}%), modified=${upd.modifiedCount}`);
    totalNetPnl += pnlRes.net;
    if (upd.modifiedCount === 1) {
      totalTradesAdded += 1;
      if (pnlRes.net > 0) totalWinAdded += 1;
    }

    eventBus.emit('trade:update', {
      tradeId: trade._id,
      botId: trade.botId,
      state: 'sold',
      reason: 'manual_api_market',
      reasonDetail: 'combined MARKET SELL via emergency script',
      realizedPnl: pnlRes.net,
      pnlPercent: pnlRes.pnlPercent,
    });
  }

  // Update bot totals (atomic)
  if (totalTradesAdded > 0) {
    const botUpd = await Bot.updateOne(
      { _id: BOT_ID },
      {
        $inc: {
          totalPnl: totalNetPnl,
          totalTrades: totalTradesAdded,
          winTrades: totalWinAdded,
        },
        $set: { status: 'idle', warning: '', warningAt: null },
      }
    );
    console.log(`Bot ${BOT_ID}: +${totalNetPnl.toFixed(4)} USDT, +${totalTradesAdded} trades, +${totalWinAdded} wins, modified=${botUpd.modifiedCount}`);
  }

  eventBus.emit('bot:status', { botId: BOT_ID, status: 'idle' });

  console.log('\n=== SUMMARY ===');
  console.log(`Total net PnL: ${totalNetPnl.toFixed(4)} USDT`);
  console.log(`Trades updated: ${totalTradesAdded}`);
  console.log('=== DONE ===');
}

main()
  .then(async () => {
    await disconnectMongo();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('SCRIPT FAILED:', err);
    logger.error({ err: err.message, stack: err.stack }, 'hei-force-close-combined failed');
    try { await disconnectMongo(); } catch (_) {}
    process.exit(1);
  });