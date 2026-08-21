'use strict';

/**
 * FIX-2026-08-14: Recover EPIC orphan BUY-filled (no SELL placed) trade.
 *
 *   - tradeId  : 6a7e251e137b04440113f2fe
 *   - symbol   : EPICUSDT
 *   - botId    : 6a623d0c34da1ce89d5dea13 (EPIC, disabled by autoPause low_vol)
 *   - state    : 'filled' (BUY filled 4h ago, no sellOrderId)
 *   - Binance  : 34.4 EPIC free, 0 open orders
 *
 *   Root cause: bot was disabled AFTER BUY filled → reconcilePendingTrades
 *   marks DB as 'filled' every cycle but cannot place SELL because trader
 *   doesn't exist for disabled bots.
 *
 *   Fix: enableBot() (uses new code that triggers reconcilePendingTrades after
 *   spawn) → trader detects BUY-filled orphan → handleBuyFilled places
 *   LIMIT_MAKER SELL @ TP.
 *
 *   Run with pm2 RUNNING (this script connects to MongoDB + spawns a separate
 *   botManager instance just for the enable + reconcile cycle).
 *
 *   Pre-conditions:
 *     - bot.autoPauseEnabled = false (set via mongosh before run)
 *     - bot.autoPauseReason = '' (cleared)
 *     - pm2 onepercentbot is running
 *
 *   Idempotency: safe to re-run. enableBot spawns trader only if missing.
 */

const config = require('../config');
const mongoose = require('mongoose');
const Bot = require('../src/db/models/Bot');
const Trade = require('../src/db/models/Trade');
const botManager = require('../src/core/botManager');
const binanceRest = require('../src/binance/binanceRest');
const logger = require('../src/utils/logger');

const BOT_ID = '6a623d0c34da1ce89d5dea13';
const TRADE_ID = '6a7e251e137b04440113f2fe';

async function main() {
  await mongoose.connect(config.mongodb.uri);

  // 1. Pre-flight
  const bot = await Bot.findById(BOT_ID);
  if (!bot) throw new Error(`bot ${BOT_ID} not found`);
  const trade = await Trade.findById(TRADE_ID);
  if (!trade) throw new Error(`trade ${TRADE_ID} not found`);

  console.log('=== Pre-flight ===');
  console.log(`bot ${bot.name} (${bot.symbol}) enabled=${bot.enabled} autoPauseEnabled=${bot.autoPauseEnabled} status=${bot.status}`);
  console.log(`trade ${trade._id} state=${trade.state} buyOrderId=${trade.buyOrderId} sellOrderId=${trade.sellOrderId || '(none)'}`);
  console.log(`buyPrice=${trade.buyPrice} buyQty=${trade.buyQty}`);

  if (trade.state === 'sold') {
    console.log('✅ Trade already sold — nothing to do.');
    process.exit(0);
  }
  if (trade.sellOrderId) {
    console.log(`✅ SELL order already placed (sellOrderId=${trade.sellOrderId}) — nothing to do.`);
    process.exit(0);
  }

  // 2. Start botManager (loads all enabled bots + runs initial reconcile)
  //    EPIC is currently disabled, so it won't be spawned at start.
  console.log('\n=== botManager.start() ===');
  await botManager.start();
  console.log('✅ botManager started');

  // 3. enableBot() — spawns trader + auto-reconciles (new code from 2026-08-14)
  //    This sets enabled=true in DB, spawns a new Trader, then triggers
  //    reconcilePendingTrades() which catches the BUY-filled orphan and calls
  //    trader.handleBuyFilled → places LIMIT_MAKER SELL @ TP.
  console.log('\n=== enableBot(EPIC) — triggers reconcile ===');
  const enabledBot = await botManager.enableBot(BOT_ID);
  console.log(`✅ bot ${enabledBot.name} enabled, status=${enabledBot.status}`);

  // 4. Wait for the async reconcile + SELL placement to complete
  //    enableBot's reconcile runs in fire-and-forget mode (no await).
  //    Poll for trade state change up to 30 seconds.
  console.log('\n=== Waiting for SELL order to be placed (up to 30s) ===');
  let attempts = 0;
  const maxAttempts = 30;
  let finalTrade = null;
  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, 1000));
    finalTrade = await Trade.findById(TRADE_ID);
    if (finalTrade && finalTrade.sellOrderId) {
      break;
    }
    attempts += 1;
    if (attempts % 5 === 0) {
      console.log(`  ... ${attempts}s elapsed, current state=${finalTrade ? finalTrade.state : '?'}`);
    }
  }

  console.log('\n=== Post-recovery state ===');
  if (finalTrade && finalTrade.sellOrderId) {
    console.log(`🎉 SUCCESS — SELL order ${finalTrade.sellOrderId} placed`);
    console.log(`  state=${finalTrade.state}`);
    console.log(`  targetSellPrice=${finalTrade.targetSellPrice}`);
    console.log(`  sellStatus=${finalTrade.sellStatus}`);
    console.log(`  sellPlacedAt=${finalTrade.sellPlacedAt}`);
  } else if (finalTrade) {
    console.log(`⚠️  SELL not placed yet — final state=${finalTrade.state}`);
    console.log('   Check pm2 logs: pm2 logs onepercentbot --lines 50');
  }

  // 5. Verify on Binance
  console.log('\n=== Verify on Binance ===');
  try {
    if (finalTrade && finalTrade.sellOrderId) {
      const order = await binanceRest.getOrder({ symbol: finalTrade.symbol, orderId: finalTrade.sellOrderId });
      console.log(`Binance SELL order ${finalTrade.sellOrderId}:`);
      console.log(`  status=${order.status}`);
      console.log(`  price=${order.price}`);
      console.log(`  origQty=${order.origQty}`);
      console.log(`  side=${order.side}`);
      console.log(`  type=${order.type}`);
    }
    const openOrders = await binanceRest.getOpenOrders({ symbol: 'EPICUSDT' });
    console.log(`\nEPICUSDT open orders on Binance: ${openOrders.length}`);
    openOrders.forEach((o) => {
      console.log(`  - ${o.orderId} ${o.side} ${o.type} @ ${o.price} qty=${o.origQty}`);
    });
  } catch (err) {
    console.log(`⚠️  Binance verification failed: ${err.message}`);
  }

  // 6. Stop this botManager instance (the live pm2 will keep running)
  console.log('\n=== Stop this script\'s botManager (live pm2 unaffected) ===');
  await botManager.stop().catch(() => {});
  await mongoose.disconnect();
  console.log('✅ done');
  process.exit(finalTrade && finalTrade.sellOrderId ? 0 : 1);
}

main().catch(async (err) => {
  console.error('❌ FATAL:', err.message);
  console.error(err.stack);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});