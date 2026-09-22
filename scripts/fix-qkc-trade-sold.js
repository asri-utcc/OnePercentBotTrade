'use strict';
/**
 * FIX-2026-09-22 — QKC trade `6aae4d5eaa1d23232da13097` cleanup
 *
 * Background:
 *   - Bot placed BUY orderId=445243616 (FILLED) at 0.002775 for 1837 QKC
 *     on 2026-09-19T08:52:54.637Z
 *   - Bot placed SELL LIMIT_MAKER orderId=445243638 at 0.002796 (refTs=1789807974637
 *     = buyFilledAtMs → clientOrderId `bb53b3d-1789807974637-0-sell-enn1iq`).
 *     SELL filled on Binance at 2026-09-19T08:57:42.880Z.
 *   - But bot's process state never advanced past _handleBuyFilledImpl → DB still
 *     shows state='holding', sellOrderId=null, sellStatus='', error='-2010 ...'.
 *   - Reconcile at 15:58:06 detected orphan (dbState='placed'), forced state='filled',
 *     then auto-pause kicked in (`low_vol`) and orphan-recovery kicked in but
 *     kept failing with -2010 (insufficient balance) because qty was already
 *     locked in the existing SELL 445243638.
 *
 * Action:
 *   - Mark Trade as state='sold' using actual Binance data (SELL FILLED at 0.002796)
 *   - Compute realizedPnl via calcPnl() formula:
 *       gross = (sellPrice - buyPrice) * qty
 *       fees  = (buyPrice + sellPrice) * qty * feeRate  (feeRate=0.00075 BNB maker)
 *       net   = gross - fees
 *       pnlPercent = net / notional * 100
 *   - Update Bot counters: totalPnl += net, totalTrades += 1, winTrades += 1
 *   - Clear bot.status → 'idle', holdingRetryCount=0, error=null, orphanBuyRecoveryCount=0
 *   - Emit trade:update with state='sold' (best-effort)
 *
 * IMPORTANT:
 *   - This script is IDEMPOTENT — checks current state before write.
 *     If state is already 'sold' and sellOrderId=445243638 → no-op.
 *   - DO NOT run while bot is live and may write to this trade simultaneously.
 *     Best: temporarily disable bot via UI/API before running.
 */
const fs = require('fs');
const path = require('path');
const envContent = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/onepercentbottrade';
const mongoose = require('mongoose');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');
const fees = require('../src/binance/fees');
const eventBus = require('../src/services/eventBus');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const TRADE_ID = '6aae4d5eaa1d23232da13097';
  const BOT_ID = '6a9feb931385620104b53b3d';
  const SELL_ORDER_ID = 445243638;
  const SELL_PRICE = 0.002796;
  const SELL_QTY = 1837;
  const SELL_FILLED_AT = new Date('2026-09-19T08:57:42.880Z');
  const BUY_PRICE = 0.002775;
  const FEE_RATE = 0.00075; // BNB maker rate (matches previous wins format)

  // 1. Idempotency check
  const trade = await Trade.findById(TRADE_ID).lean();
  if (!trade) { console.error('Trade not found'); process.exit(1); }
  console.log(`Current state: ${trade.state}, sellOrderId: ${trade.sellOrderId || 'null'}`);
  if (trade.state === 'sold' && trade.sellOrderId === SELL_ORDER_ID) {
    console.log('Already marked as sold with correct sellOrderId — no-op');
    await mongoose.disconnect();
    process.exit(0);
  }
  if (!['placed', 'filled', 'holding'].includes(trade.state)) {
    console.error(`Refusing to overwrite terminal state: ${trade.state}`);
    process.exit(1);
  }

  // 2. Compute realizedPnl via canonical formula
  const pnl = fees.calcPnl({
    buyPrice: BUY_PRICE,
    sellPrice: SELL_PRICE,
    qty: SELL_QTY,
    feeRate: FEE_RATE,
  });
  console.log('\n=== Computed PnL ===');
  console.log(`  gross       = ${pnl.gross.toFixed(8)} USDT`);
  console.log(`  fees        = ${pnl.fees.toFixed(8)} USDT`);
  console.log(`  net (=realizedPnl) = ${pnl.net.toFixed(8)} USDT`);
  console.log(`  notional    = ${pnl.notional.toFixed(6)} USDT`);
  console.log(`  pnlPercent  = ${pnl.pnlPercent.toFixed(6)}%`);

  // 3. Update Trade
  const tradeUpd = await Trade.updateOne(
    { _id: TRADE_ID, state: { $in: ['placed', 'filled', 'holding'] } },
    {
      $set: {
        state: 'sold',
        sellOrderId: SELL_ORDER_ID,
        sellClientOrderId: 'bb53b3d-1789807974637-0-sell-enn1iq',
        sellPrice: SELL_PRICE,
        sellQty: SELL_QTY,
        sellStatus: 'FILLED',
        sellFilledAt: SELL_FILLED_AT,
        sellPlacedAt: SELL_FILLED_AT, // close enough — placed time unknown but filled time known
        realizedPnl: pnl.net,
        pnlPercent: pnl.pnlPercent,
        sellReason: 'tp_hit',
        sellReasonDetail: `recovered orphan 2026-09-22 — SELL 445243638 LIMIT_MAKER @ ${SELL_PRICE} FILLED at ${SELL_FILLED_AT.toISOString()}`,
        sellReasonAt: new Date(),
        sellReasonSource: 'manual_recovery',
        holdingRetryCount: 0,
        error: '',
        sellInFlight: false,
        sellInFlightAt: null,
        orphanBuyRecoveryCount: 0,
        orphanBuyRecoveryAt: null,
        updatedAt: new Date(),
      },
    }
  );
  if (tradeUpd.modifiedCount === 0) {
    console.error('Trade update FAILED (modifiedCount=0) — state changed?');
    process.exit(1);
  }
  console.log(`\n✅ Trade updated → state='sold', sellOrderId=${SELL_ORDER_ID}`);

  // 4. Update Bot counters
  const botBefore = await Bot.findById(BOT_ID).lean();
  const newTotalPnl = (botBefore.totalPnl || 0) + pnl.net;
  const newTotalTrades = (botBefore.totalTrades || 0) + 1;
  const newWinTrades = (botBefore.winTrades || 0) + 1;
  const botUpd = await Bot.updateOne(
    { _id: BOT_ID },
    {
      $set: {
        status: 'idle',
        totalPnl: newTotalPnl,
        totalTrades: newTotalTrades,
        winTrades: newWinTrades,
        lastError: '',
      },
    }
  );
  if (botUpd.modifiedCount === 0) {
    console.warn('⚠️  Bot update did not modify — investigate');
  } else {
    console.log(`✅ Bot counters updated:`);
    console.log(`   totalPnl: ${(botBefore.totalPnl || 0).toFixed(6)} → ${newTotalPnl.toFixed(6)}`);
    console.log(`   totalTrades: ${botBefore.totalTrades || 0} → ${newTotalTrades}`);
    console.log(`   winTrades: ${botBefore.winTrades || 0} → ${newWinTrades}`);
    console.log(`   status: holding → idle`);
  }

  // 5. Emit event (best-effort — listener may not be loaded in script context)
  try {
    eventBus.emit('trade:update', {
      tradeId: TRADE_ID,
      state: 'sold',
      realizedPnl: pnl.net,
      pnlPercent: pnl.pnlPercent,
      reason: 'tp_hit',
      reasonDetail: 'recovered orphan 2026-09-22',
    });
    console.log('✅ eventBus: trade:update emitted');
  } catch (e) {
    console.log(`⚠️  eventBus emit failed (non-fatal): ${e.message}`);
  }

  await mongoose.disconnect();
  console.log('\n🎉 QKC trade cleanup complete.');
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
