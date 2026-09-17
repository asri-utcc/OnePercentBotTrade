#!/usr/bin/env node
'use strict';

/**
 * manual-recover-stuck-selling-2026-09-17.js — FIX-2026-09-17
 *
 * One-time recovery สำหรับ ZENUSDT ที่ค้างใน state='selling' มา 8 วัน
 * ในบอท faiz — SELL (LIMIT_MAKER) ยังมีชีวิตบน Binance แต่ไม่ fill,
 * reconcile sweep เห็น status=NEW → explicit no-op, ระบบไม่มี time-based
 * sweeper จึงค้างถาวร.
 *
 * FIX strategy:
 *   1. Re-fetch ZENUSDT trade ที่ state='selling'
 *   2. Optional: probe Binance status ของ sellOrderId
 *   3. เรียก forceClose.forceCloseTrade({ source: 'manual-recovery-2026-09-17' })
 *      → ตัว forceClose จะ cancel SELL (cancelSellOrderIfAny) + MARKET SELL freeQty
 *   4. Override sellReason → 'manual_recovery_stuck_sell' เพื่อ trace
 *   5. Emit eventBus 'trade:closed' → telegramNotifier แจ้งเตือน
 *
 * Why not just run fix-orphan-selling-2026-09-12.js:
 *   - script เดิม handle FILLED (inline mark-sold), CANCELED/EXPIRED (revert to holding)
 *     แต่ NEW/PARTIALLY_FILLED → SKIP เพราะ "legitimate selling state"
 *   - สำหรับ ZEN ที่ SELL NEW > 24h ต้อง MARKET SELL ทันที (per user choice)
 *
 * Run:
 *   node scripts/manual-recover-stuck-selling-2026-09-17.js
 *
 * Idempotent: ถ้า trade ไม่อยู่ใน state='selling' อีกแล้ว → no-op.
 *
 * Origin: Plan file `typed-toasting-stroustrup.md` Phase A2.
 */

const fs = require('fs');
const path = require('path');

// CRITICAL: Load .env.faiz BEFORE any require that touches config/index.js
//   config/index.js calls dotenv.config() which loads .env (owner DB) by default.
//   Setting process.env.MONGODB_URI explicitly here overrides the dotenv-loaded value
//   so the script operates on the faiz DB.
const envLines = fs.readFileSync(path.resolve(__dirname, '..', '.env.faiz'), 'utf8').split(/\r?\n/);
const env = {};
for (const l of envLines) {
  const t = l.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq <= 0) continue;
  env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim(); // set into process.env BEFORE requires
}

const mongoose = require('mongoose');
const binanceRest = require('../src/binance/binanceRest');
const forceClose = require('../src/core/forceClose');
const eventBus = require('../src/services/eventBus');

const TARGET_SYMBOL = 'ZENUSDT';

(async () => {
  await require('../src/db/connection').connect();
  console.log(`Connected to faiz DB (${env.MONGODB_URI})`);

  const Trade = mongoose.connection.collection('trades');
  const Bot = mongoose.connection.collection('bots');

  // 1. Find ZENUSDT trade in state='selling'
  const z = await Trade.find({ symbol: TARGET_SYMBOL, state: 'selling' })
    .sort({ updatedAt: -1 })
    .limit(1)
    .next();

  if (!z) {
    console.log(`No ${TARGET_SYMBOL} trade in state='selling' — already resolved or not found. Aborting.`);
    await mongoose.disconnect();
    return;
  }

  console.log(`\nTrade ${z._id.toString()}:`);
  console.log(`  botId=${z.botId.toString()} symbol=${z.symbol}`);
  console.log(`  state=${z.state} buyPrice=${z.buyPrice} buyQty=${z.buyQty}`);
  console.log(`  sellOrderId=${z.sellOrderId} sellPrice=${z.sellPrice}`);
  console.log(`  buyFilledAt=${z.buyFilledAt} age=${((Date.now() - new Date(z.buyFilledAt).getTime()) / 3600000).toFixed(2)}h`);

  const b = await Bot.findOne({ _id: z.botId });
  if (!b) {
    console.log(`Bot ${z.botId.toString()} not found — orphaned trade. Aborting.`);
    await mongoose.disconnect();
    return;
  }
  console.log(`Bot: ${b.symbol} enabled=${b.enabled} auv2Enabled=${b.auv2Enabled}`);

  // 2. Probe Binance status (best-effort, non-blocking)
  if (z.sellOrderId) {
    try {
      const o = await binanceRest.getOrder(
        { symbol: z.symbol, orderId: z.sellOrderId },
        { critical: true }
      );
      console.log(`\nBinance status=${o.status} executedQty=${o.executedQty}/${o.origQty}`);
    } catch (e) {
      console.log(`Probe failed (${e.message}) — proceeding with forceClose anyway`);
    }
  }

  // 3. forceClose — จะ cancel SELL แล้ว MARKET SELL freeQty atomic
  console.log('\n--- Calling forceCloseTrade ---');
  const result = await forceClose.forceCloseTrade({
    trade: z,
    bot: b,
    allowMarketSell: true,
    source: 'manual-recovery-2026-09-17',
  });

  console.log('\nResult:', JSON.stringify({
    ok: result.ok,
    mode: result.mode,
    executedQty: result.executedQty,
    avgSellPrice: result.avgSellPrice,
    pnl: result.pnl,
    error: result.error,
  }, null, 2));

  if (!result.ok) {
    console.log('\nFAIL — forceClose did not close the trade. Aborting before override.');
    await mongoose.disconnect();
    process.exit(1);
  }

  // 4. Override sellReason for traceability
  const updRes = await Trade.updateOne(
    { _id: z._id, state: 'sold' },
    {
      $set: {
        sellReason: 'manual_recovery_stuck_sell',
        sellReasonDetail: `SELL alive >168h on Binance (no price-action or watchdog trigger since 2026-09-09). Cancel + MARKET SELL via forceClose source=manual-recovery-2026-09-17.`,
        sellReasonAt: new Date(),
        sellReasonSource: 'scripts.manualRecoverStuckSelling.2026-09-17',
      },
    }
  );
  console.log(`\nSellReason override: matched=${updRes.matchedCount} modified=${updRes.modifiedCount}`);

  // 5. Emit eventBus trade:closed → telegramNotifier handles notification
  try {
    eventBus.emit('trade:closed', {
      tradeId: z._id,
      botId: z.botId,
      symbol: z.symbol,
      mode: result.mode,
      pnl: result.pnl,
      avgSellPrice: result.avgSellPrice,
      sellReason: 'manual_recovery_stuck_sell',
      source: 'manual-recovery-2026-09-17',
    });
    console.log('Telegram event emitted via eventBus');
  } catch (e) {
    console.log(`Telegram emit warning: ${e.message}`);
  }

  await mongoose.disconnect();
  console.log('\n=== DONE ===');
})().catch((e) => {
  console.error('ERROR:', e.message);
  console.error(e.stack);
  process.exit(1);
});
