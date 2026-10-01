'use strict';
/**
 * FIX-2026-10-02 — NILUSDT stuck holding + stale selling reconciliation
 *
 * Background (from owner logs 2026-10-01):
 *   - Trade `6abe13c3bffdd7a46fc9ed39` (state=holding):
 *       buyQty=8.9 NIL @ 0.08539 → notional=0.76 USDT
 *       MARKET SELL failed 10x with error -1013 NOTIONAL (Binance market min ~5 USDT)
 *       marked `error: stuck: holding_retry_exhausted_10`
 *       Asset still on Binance (free=8.9 NIL) — cannot be SELLed via API at current price.
 *       **Decision: mark as dust_skipped** (not a real close, NOT counted as PnL).
 *
 *   - Trade `6ab95d20750d8b7f1be09f7f` (state=selling, sellOrderId=500741427):
 *       LIMIT_MAKER SELL @ 0.10371, qty=145.2, executedQty=0, status=NEW (alive)
 *       DB sellStatus='', sellFilledQty=null since 2026-09-27 (4 days ago)
 *       Current price ~0.085 → order sits 22% above market, will fill when NIL recovers
 *       **Decision: reconcile DB to mirror Binance (status='NEW', sellFilledQty=0)**
 *
 *   - Trade `6ab6c825750d8b7f1bdf1c98` (state=selling, sellOrderId=495129972):
 *       LIMIT_MAKER SELL @ 0.12618, qty=112.6, executedQty=0, status=NEW (alive)
 *       DB sellStatus='', sellFilledQty=null since 2026-09-25 (6 days ago)
 *       Current price ~0.085 → order sits 48% above market
 *       **Decision: same — reconcile DB to mirror Binance**
 *
 * Idempotency:
 *   - Trade 6abe13c3: if already state='dust_skipped' with matching recoveryNote → no-op
 *   - Trade 6ab95d20 / 6ab6c825: if already sellStatus='NEW' with sellFilledQty=0 → no-op
 *
 * Safety:
 *   - Default = DRY RUN (only prints planned actions)
 *   - `--execute` flag = actually write
 *
 * Pre-flight:
 *   - Pulls current state from MongoDB AND Binance for ALL 3 trades + 2 orders
 *   - Prints comparison + diff before any write
 *   - Refuses to run if `--execute` is passed but pre-flight shows unexpected drift
 *
 * IMPORTANT:
 *   - 8.9 NIL still on Binance as FREE → can be manually SELLed when NIL price rises
 *     enough for notional >= 5 USDT (need NIL >= 0.562 USDT, current 0.085 = need 6.6x),
 *     OR converted via other pairs (BTC/ETH/etc.), OR left as dust.
 *   - This script does NOT touch Binance (no cancel, no new order).
 *   - Bot (PM2 id 10 onepercentbot) should be reloaded AFTER running to clear in-memory
 *     trader state for trade 6abe13c3. Use `npm run pm2:reload` (CRITICAL per project memory).
 */

const fs = require('fs');
const path = require('path');
const envContent = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/onepercentbottrade';

const mongoose = require('mongoose');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');
const binanceRest = require('../src/binance/binanceRest');

const EXECUTE = process.argv.includes('--execute');

const TARGETS = [
  {
    tradeId: '6abe13c3bffdd7a46fc9ed39',
    botId: '6a71d73f2ef0a655afb98ebb',
    symbol: 'NILUSDT',
    kind: 'stuck_dust',
    sellOrderId: null,
    expectedBinanceStatus: null,
    description: '8.9 NIL dust @ 0.08539 — SELL fails NOTIONAL filter',
  },
  {
    tradeId: '6ab95d20750d8b7f1be09f7f',
    botId: '6a71d73f2ef0a655afb98ebb',
    symbol: 'NILUSDT',
    kind: 'selling_reconcile',
    sellOrderId: 500741427,
    expectedBinanceStatus: 'NEW',
    description: 'LIMIT_MAKER SELL 145.2 @ 0.10371 — waiting for TP',
  },
  {
    tradeId: '6ab6c825750d8b7f1bdf1c98',
    botId: '6a71d73f2ef0a655afb98ebb',
    symbol: 'NILUSDT',
    kind: 'selling_reconcile',
    sellOrderId: 495129972,
    expectedBinanceStatus: 'NEW',
    description: 'LIMIT_MAKER SELL 112.6 @ 0.12618 — waiting for TP',
  },
];

const NOTE_PREFIX = 'FIX-2026-10-02';

(async () => {
  console.log('================================================');
  console.log(`NILUSDT stuck + selling reconciliation`);
  console.log(`Mode: ${EXECUTE ? '⚠️  EXECUTE (will write)' : '🔍 DRY RUN (read-only)'}`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log('================================================\n');

  await mongoose.connect(process.env.MONGODB_URI);

  const tradesCol = mongoose.connection.collection('trades');
  const now = new Date();

  // Pre-flight: fetch DB state
  console.log('=== Pre-flight: DB state ===\n');
  const dbStates = {};
  for (const t of TARGETS) {
    const tr = await Trade.findById(t.tradeId).lean();
    dbStates[t.tradeId] = tr;
    if (!tr) {
      console.log(`❌ Trade ${t.tradeId} NOT FOUND in MongoDB`);
      continue;
    }
    console.log(`Trade ${t.tradeId}`);
    console.log(`  symbol           : ${tr.symbol}`);
    console.log(`  state            : ${tr.state}`);
    console.log(`  buyQty           : ${tr.buyQty}  buyPrice: ${tr.buyPrice}`);
    console.log(`  notional         : ${(tr.buyQty * tr.buyPrice).toFixed(6)} USDT`);
    console.log(`  sellOrderId      : ${tr.sellOrderId || 'null'}`);
    console.log(`  sellStatus       : '${tr.sellStatus || ''}'`);
    console.log(`  sellFilledQty    : ${tr.sellFilledQty}`);
    console.log(`  holdingRetryCount: ${tr.holdingRetryCount || 0}`);
    console.log(`  error            : ${tr.error || '(none)'}`);
    console.log(`  updatedAt        : ${tr.updatedAt}`);
    console.log(`  [${t.kind}] ${t.description}\n`);
  }

  // Pre-flight: fetch Binance orders
  console.log('=== Pre-flight: Binance orders ===\n');
  const binanceOrders = {};
  for (const t of TARGETS) {
    if (!t.sellOrderId) continue;
    try {
      const ord = await binanceRest.getOrder({ symbol: t.symbol, orderId: t.sellOrderId });
      binanceOrders[t.sellOrderId] = ord;
      console.log(`Order ${t.sellOrderId} (${t.symbol})`);
      console.log(`  status         : ${ord.status}`);
      console.log(`  side           : ${ord.side}  type: ${ord.type}`);
      console.log(`  price          : ${ord.price}`);
      console.log(`  origQty        : ${ord.origQty}`);
      console.log(`  executedQty    : ${ord.executedQty}`);
      console.log(`  cummulativeQuoteQty: ${ord.cummulativeQuoteQty || 0}`);
      console.log(`  time           : ${new Date(ord.time).toISOString()}`);
      console.log(`  updateTime     : ${ord.updateTime ? new Date(ord.updateTime).toISOString() : 'null'}`);
      console.log(``);
    } catch (e) {
      console.log(`❌ getOrder ${t.sellOrderId} FAILED: ${e.message}`);
      if (e.response) console.log(`   status=${e.response.status} data=${JSON.stringify(e.response.data)}`);
      binanceOrders[t.sellOrderId] = { error: e.message };
    }
  }

  // Plan actions
  const plan = [];
  for (const t of TARGETS) {
    const db = dbStates[t.tradeId];
    if (!db) continue;

    if (t.kind === 'stuck_dust') {
      const expectedNote = `${NOTE_PREFIX} — NIL dust 0.76 USDT < NOTIONAL 5 — abandoned, manual liquidation required`;
      if (db.state === 'dust_skipped' && db.recoveryNote === expectedNote) {
        plan.push({ tradeId: t.tradeId, action: 'noop', reason: 'already dust_skipped with correct note' });
        continue;
      }
      if (db.state !== 'holding') {
        plan.push({ tradeId: t.tradeId, action: 'reject', reason: `current state is '${db.state}', expected 'holding' — manual review needed` });
        continue;
      }
      plan.push({
        tradeId: t.tradeId,
        action: 'mark_dust_skipped',
        details: {
          state: 'dust_skipped',
          error: '',
          holdingRetryCount: 0,
          recoveryNote: expectedNote,
          sellInFlight: false,
          sellInFlightAt: null,
          orphanBuyRecoveryCount: 0,
          orphanBuyRecoveryAt: null,
        },
      });
    } else if (t.kind === 'selling_reconcile') {
      const ord = binanceOrders[t.sellOrderId];
      if (!ord || ord.error) {
        plan.push({ tradeId: t.tradeId, action: 'reject', reason: `cannot fetch Binance order ${t.sellOrderId}: ${ord?.error || 'unknown'}` });
        continue;
      }
      // Sanity: order must still be NEW and not filled
      if (ord.status !== t.expectedBinanceStatus) {
        plan.push({ tradeId: t.tradeId, action: 'reject', reason: `Binance status='${ord.status}' (expected '${t.expectedBinanceStatus}') — order changed state, abort reconcile` });
        continue;
      }
      if (parseFloat(ord.executedQty) > 0) {
        plan.push({ tradeId: t.tradeId, action: 'reject', reason: `order already has executedQty=${ord.executedQty} — needs fill-recovery, not reconcile` });
        continue;
      }
      if (parseFloat(ord.origQty) !== db.sellQty) {
        plan.push({ tradeId: t.tradeId, action: 'reject', reason: `origQty mismatch: Binance=${ord.origQty} DB=${db.sellQty}` });
        continue;
      }
      // Already reconciled?
      if (db.sellStatus === 'NEW' && parseFloat(db.sellFilledQty || 0) === 0 && db.soldVerifiedAt) {
        plan.push({ tradeId: t.tradeId, action: 'noop', reason: 'already reconciled' });
        continue;
      }
      plan.push({
        tradeId: t.tradeId,
        action: 'reconcile_selling',
        details: {
          sellStatus: 'NEW',
          sellFilledQty: 0,
          sellAvgPrice: null,
          soldVerifiedAt: now,
          recoveryNote: `${NOTE_PREFIX} — reconciled with Binance ${t.sellOrderId} status=NEW executedQty=0 (verified ${now.toISOString()})`,
        },
      });
    }
  }

  console.log('=== Plan ===\n');
  for (const p of plan) {
    if (p.action === 'noop') {
      console.log(`  [NOOP]     ${p.tradeId}: ${p.reason}`);
    } else if (p.action === 'reject') {
      console.log(`  [REJECT]   ${p.tradeId}: ${p.reason}`);
    } else {
      console.log(`  [${p.action.toUpperCase()}] ${p.tradeId}`);
      console.log(`             details: ${JSON.stringify(p.details)}`);
    }
  }
  console.log('');

  const rejects = plan.filter((p) => p.action === 'reject');
  if (rejects.length > 0) {
    console.log(`❌ ${rejects.length} action(s) REJECTED — investigate before re-running`);
    await mongoose.disconnect();
    process.exit(2);
  }

  const writes = plan.filter((p) => p.action !== 'noop' && p.action !== 'reject');
  if (writes.length === 0) {
    console.log('✅ Nothing to do — all targets already in expected state');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!EXECUTE) {
    console.log(`📋 DRY RUN: ${writes.length} write(s) planned.`);
    console.log(`   Re-run with --execute to apply.`);
    console.log(`\n   After execution, reload PM2:`);
    console.log(`     npm run pm2:reload`);
    await mongoose.disconnect();
    process.exit(0);
  }

  // ============ EXECUTE ============
  console.log(`🚀 Executing ${writes.length} write(s)...\n`);
  for (const p of writes) {
    if (p.action === 'mark_dust_skipped') {
      // Use raw collection to bypass TRADE_STATES enum (dust_skipped not in enum)
      const res = await tradesCol.updateOne(
        { _id: new mongoose.Types.ObjectId(p.tradeId), state: 'holding' },
        {
          $set: {
            ...p.details,
            updatedAt: now,
          },
        }
      );
      if (res.modifiedCount === 0) {
        console.log(`❌ ${p.tradeId} update FAILED (state changed?) — verify manually`);
      } else {
        console.log(`✅ ${p.tradeId} → dust_skipped`);
        // Clear bot.status if no other holding trades
        const otherHoldings = await Trade.countDocuments({ botId: dbStates[p.tradeId].botId, state: 'holding' });
        if (otherHoldings === 0) {
          await Bot.updateOne(
            { _id: dbStates[p.tradeId].botId, status: { $in: ['holding', 'stuck'] } },
            { $set: { status: 'idle', lastError: '' } }
          );
          console.log(`   bot.status → idle (no other holding trades)`);
        }
      }
    } else if (p.action === 'reconcile_selling') {
      // Selling trades — use Mongoose model (state stays 'selling', all fields are in enum/default)
      const res = await Trade.updateOne(
        { _id: p.tradeId, state: 'selling' },
        {
          $set: {
            ...p.details,
            updatedAt: now,
          },
        }
      );
      if (res.modifiedCount === 0) {
        console.log(`❌ ${p.tradeId} update FAILED (state changed?) — verify manually`);
      } else {
        console.log(`✅ ${p.tradeId} → sellStatus=NEW (reconciled with Binance ${dbStates[p.tradeId].sellOrderId})`);
      }
    }
  }

  console.log('\n=== Post-execute verification ===\n');
  for (const t of TARGETS) {
    const fresh = await Trade.findById(t.tradeId).lean();
    if (!fresh) continue;
    console.log(`${t.tradeId}:`);
    console.log(`  state          : ${fresh.state}`);
    console.log(`  sellStatus      : '${fresh.sellStatus || ''}'`);
    console.log(`  sellFilledQty  : ${fresh.sellFilledQty}`);
    console.log(`  holdingRetryCount: ${fresh.holdingRetryCount || 0}`);
    console.log(`  error          : ${fresh.error || '(none)'}`);
    console.log(`  recoveryNote   : ${fresh.recoveryNote || '(none)'}`);
    console.log(`  updatedAt      : ${fresh.updatedAt}`);
    console.log(``);
  }

  console.log('================================================');
  console.log('✅ FIX-2026-10-02 complete.');
  console.log('   NEXT STEP: npm run pm2:reload  (clear in-memory trader state for trade 6abe13c3)');
  console.log('   Binance: 8.9 NIL remains as FREE — manual SELL via UI when NIL price >= 0.562 USDT (notional 5 USDT),');
  console.log('            or convert via BTC/ETH pair, or leave as dust.');
  console.log('================================================');

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e);
  console.error(e.stack);
  process.exit(1);
});