#!/usr/bin/env node
'use strict';

/**
 * fix-orphan-selling-2026-09-12.js — FIX-2026-09-12
 *
 * One-time recovery script สำหรับแก้ orphan positions ที่ค้างใน DB
 * (DB state='selling' แต่ reconcile sweep ทำงานไม่ได้เพราะ circuit breaker
 *  blocks binanceRest.getOrder() calls — orphan สะสมเงียงๆ)
 *
 * Strategy:
 *   1. Query trade ทั้งหมดที่ state='selling' AND sellOrderId IS NOT NULL
 *   2. เรียก binanceRest.getOrder() ทีละตัว (critical=true เพื่อ bypass circuit breaker)
 *   3. Categorize:
 *      - FILLED  → inline mark-sold (atomic state guard, identical logic กับ botManager.doInlineMarkSold)
 *      - CANCELED / EXPIRED → revert state='holding', clear sellOrderId, $unset sellClientOrderId
 *      - NEW / PARTIALLY_FILLED → skip (legitimate selling state, รอ fill)
 *      - error → log + skip (manual review)
 *   4. Dry-run default → --execute เพื่อ apply
 *   5. ทุก UPDATE ใช้ atomic WHERE state guard (idempotent)
 *
 * Run:
 *   node scripts/fix-orphan-selling-2026-09-12.js              # dry-run
 *   node scripts/fix-orphan-selling-2026-09-12.js --execute    # apply
 *   node scripts/fix-orphan-selling-2026-09-12.js --bot=<id>   # เฉพาะบอท
 *
 * ปลอดภัยเพราะ:
 *   - default = dry-run แสดงแผนก่อนแก้
 *   - ต้องพิมพ์ YES เพื่อ confirm (เหมือน cleanup-orphan.js)
 *   - atomic guard ป้องกัน double-update
 *   - log file ทุก action
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const readline = require('readline');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');
const binanceRest = require('../src/binance/binanceRest');
const { calcPnl, getMakerRate } = require('../src/binance/fees');
const dpsAfterClose = require('../src/core/dpsAfterClose');
const eventBus = require('../src/services/eventBus');

const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = !EXECUTE;
const BOT_ID = (process.argv.find((a) => a.startsWith('--bot=')) || '').slice('--bot='.length) || null;

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG_FILE = path.join(LOG_DIR, `fix-orphan-selling-${STAMP}.log`);
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(line) {
  const ts = new Date().toISOString();
  const out = `[${ts}] ${line}`;
  console.log(out);
  logStream.write(out + '\n');
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function checkOrderOnBinance(symbol, orderId) {
  // Try multiple times to bypass transient CIRCUIT_OPEN (critical=true flag
  // bypasses our own circuit breaker, but Binance may still 429 → retry once).
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const order = await binanceRest.getOrder({ symbol, orderId }, { critical: true });
      return { ok: true, order };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      log(`    ⚠️ getOrder attempt ${attempt}/${maxAttempts} for ${symbol}#${orderId} failed: ${msg}`);
      if (attempt === maxAttempts) return { ok: false, error: msg };
      // wait 2s before retry
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return { ok: false, error: 'unreachable' };
}

async function inlineMarkSold(trade, order) {
  const inlineSellPrice = parseFloat(order.price || order.avgPrice)
    || (parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty));
  const inlineSellQty = parseFloat(order.executedQty);
  const inlinePnl = calcPnl({
    buyPrice: trade.buyPrice,
    sellPrice: inlineSellPrice,
    qty: inlineSellQty,
    feeRate: getMakerRate(),
  });

  // Atomic guard — idempotent (same pattern as botManager.doInlineMarkSold line 919-950)
  const updRes = await Trade.updateOne(
    {
      _id: trade._id,
      sellOrderId: order.orderId,
      state: { $nin: ['sold'] },
    },
    {
      $set: {
        state: 'sold',
        sellStatus: 'FILLED',
        sellPrice: inlineSellPrice,
        sellQty: inlineSellQty,
        sellQuoteQty: parseFloat(order.cummulativeQuoteQty),
        sellFilledAt: new Date(order.updateTime || Date.now()),
        realizedPnl: inlinePnl.net,
        pnlPercent: inlinePnl.pnlPercent,
        // reset auto-arm flag
        useStopLossOnUKC: false,
        autoArmedAt: null,
        autoArmLossPct: null,
        autoArmAgeHours: null,
        // reset partial-fill latch
        sellPartialDetectedAt: null,
        sellPartialLatchedAt: null,
        sellPartialLatchedReason: null,
        // structured sellReason for orphan recovery
        sellReason: 'manual_api_market',
        sellReasonDetail: `orphan reconcile (2026-09-12 sweep): SELL ${order.orderId} filled but DB state='${trade.state}' — inline mark-sold`,
        sellReasonAt: new Date(),
        sellReasonSource: 'scripts.fixOrphanSelling.2026-09-12',
      },
    }
  );
  return { updated: updRes.modifiedCount === 1, inlinePnl };
}

async function revertToHolding(trade, orderStatus) {
  const updRes = await Trade.updateOne(
    {
      _id: trade._id,
      state: { $in: ['selling', 'placed', 'filled'] },
    },
    {
      $set: {
        state: 'holding',
        sellStatus: orderStatus,
      },
      $unset: { sellOrderId: '', sellClientOrderId: '' },
    }
  );
  return { updated: updRes.modifiedCount === 1 };
}

async function main() {
  await require('../src/db/connection').connect();
  log(`=== fix-orphan-selling-2026-09-12 START === mode=${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);

  const filter = {
    state: 'selling',
    sellOrderId: { $exists: true, $ne: null },
  };
  if (BOT_ID) filter.botId = mongoose.Types.ObjectId.createFromHexString(BOT_ID);

  const orphans = await Trade.find(filter).sort({ updatedAt: 1 }).lean();
  log(`found ${orphans.length} orphan(s) with state='selling' AND sellOrderId IS NOT NULL`);

  if (orphans.length === 0) {
    log('Nothing to fix.');
    await mongoose.disconnect();
    return;
  }

  // ── Phase A: probe each orphan on Binance ─────────────────────────────
  const probes = [];
  for (const t of orphans) {
    log(`\n--- probing ${t.symbol} trade ${t._id.toString()} (sellOrderId=${t.sellOrderId}, age=${((Date.now() - new Date(t.updatedAt).getTime()) / 3600000).toFixed(1)}h) ---`);
    const r = await checkOrderOnBinance(t.symbol, t.sellOrderId);
    if (!r.ok) {
      log(`  ✗ probe failed: ${r.error} → SKIP (manual review)`);
      probes.push({ trade: t, action: 'skip', reason: `probe_error: ${r.error}` });
      continue;
    }
    const o = r.order;
    log(`  → Binance status=${o.status} executedQty=${o.executedQty}/${o.origQty} cummQuote=${o.cummulativeQuoteQty} updateTime=${new Date(o.updateTime).toISOString()}`);
    if (o.status === 'FILLED') {
      probes.push({ trade: t, order: o, action: 'inline_mark_sold' });
    } else if (o.status === 'CANCELED' || o.status === 'EXPIRED') {
      probes.push({ trade: t, order: o, action: 'revert_to_holding' });
    } else {
      // NEW / PARTIALLY_FILLED — legitimate selling state, do nothing
      probes.push({ trade: t, order: o, action: 'skip', reason: `Binance status=${o.status} — keep selling state` });
    }
  }

  // ── Phase B: summarize plan ───────────────────────────────────────────
  const plan = {
    inline_mark_sold: probes.filter((p) => p.action === 'inline_mark_sold'),
    revert_to_holding: probes.filter((p) => p.action === 'revert_to_holding'),
    skip: probes.filter((p) => p.action === 'skip'),
  };

  log(`\n=== PLAN ===`);
  log(`  inline_mark_sold: ${plan.inline_mark_sold.length}`);
  log(`  revert_to_holding: ${plan.revert_to_holding.length}`);
  log(`  skip: ${plan.skip.length}`);

  if (DRY_RUN) {
    log(`\n[DRY-RUN] would apply:`);
    for (const p of plan.inline_mark_sold) {
      const px = parseFloat(p.order.price || p.order.avgPrice)
        || (parseFloat(p.order.cummulativeQuoteQty) / parseFloat(p.order.executedQty));
      const pnl = calcPnl({ buyPrice: p.trade.buyPrice, sellPrice: px, qty: parseFloat(p.order.executedQty), feeRate: getMakerRate() });
      log(`  ✓ ${p.trade.symbol} trade ${p.trade._id} → mark sold, PnL≈${pnl.net.toFixed(4)} USDT (${pnl.pnlPercent.toFixed(2)}%)`);
    }
    for (const p of plan.revert_to_holding) {
      log(`  ↩ ${p.trade.symbol} trade ${p.trade._id} → revert to holding (Binance=${p.order.status})`);
    }
    for (const p of plan.skip) {
      log(`  ⊘ ${p.trade.symbol} trade ${p.trade._id} → SKIP (${p.reason})`);
    }
    log(`\nRun with --execute to apply.`);
    log(`log file: ${LOG_FILE}`);
    await mongoose.disconnect();
    return;
  }

  // ── Phase C: confirm + apply ──────────────────────────────────────────
  const ans = await prompt(`\nApply ${plan.inline_mark_sold.length} mark-sold + ${plan.revert_to_holding.length} revert? (type YES to confirm): `);
  if (ans !== 'YES') {
    log(`ABORTED — user did not confirm`);
    await mongoose.disconnect();
    return;
  }

  let fixedSold = 0;
  let fixedHolding = 0;
  for (const p of plan.inline_mark_sold) {
    const { updated, inlinePnl } = await inlineMarkSold(p.trade, p.order);
    if (!updated) {
      log(`  ⊘ ${p.trade.symbol} trade ${p.trade._id}: already fixed by another path, SKIP`);
      continue;
    }
    fixedSold += 1;
    // Atomic $inc on bot totals (mirror botManager.js line 985-995)
    await Bot.updateOne(
      { _id: p.trade.botId },
      {
        $inc: {
          totalPnl: inlinePnl.net,
          totalTrades: 1,
          winTrades: (inlinePnl.net > 0 ? 1 : 0),
        },
        $set: { status: 'idle', lastError: '' },
      }
    );
    eventBus.emit('trade:update', {
      tradeId: p.trade._id,
      botId: p.trade.botId,
      state: 'sold',
      reason: 'orphan_reconcile_2026-09-12_script',
      reasonDetail: `SELL ${p.order.orderId} filled but DB state='${p.trade.state}' — inline mark-sold by script`,
      realizedPnl: inlinePnl.net,
      pnlPercent: inlinePnl.pnlPercent,
    });
    eventBus.emit('trade:warning', {
      tradeId: p.trade._id,
      botId: p.trade.botId,
      state: 'sold',
      reason: 'orphan_reconcile_inline_mark_2026-09-12',
      reasonDetail: `SELL ${p.order.orderId} FILLED but DB was '${p.trade.state}' — inline mark-sold, PnL=${inlinePnl.net.toFixed(4)} USDT (${inlinePnl.pnlPercent.toFixed(2)}%)`,
    });
    // DPS evaluation (mirror botManager.js line 1022-1037)
    try {
      const botSnap = await Bot.findById(p.trade.botId).lean();
      if (botSnap) {
        await dpsAfterClose.evaluateDpsAfterClose({
          bot: botSnap,
          pnl: inlinePnl.net,
          pnlPct: inlinePnl.pnlPercent,
          source: 'scripts.fixOrphanSelling.2026-09-12',
        });
      }
    } catch (dpsErr) {
      log(`    ⚠️ DPS eval failed (non-fatal): ${dpsErr.message}`);
    }
    log(`  ✓ ${p.trade.symbol} trade ${p.trade._id} → mark sold, PnL=${inlinePnl.net.toFixed(4)} USDT`);
  }

  for (const p of plan.revert_to_holding) {
    const { updated } = await revertToHolding(p.trade, p.order.status);
    if (updated) {
      fixedHolding += 1;
      log(`  ↩ ${p.trade.symbol} trade ${p.trade._id} → reverted to holding`);
    } else {
      log(`  ⊘ ${p.trade.symbol} trade ${p.trade._id}: state changed by another path, SKIP`);
    }
  }

  log(`\n=== SUMMARY ===`);
  log(`mode: EXECUTE`);
  log(`inline_mark_sold applied: ${fixedSold}`);
  log(`revert_to_holding applied: ${fixedHolding}`);
  log(`skipped (already fixed): ${orphans.length - fixedSold - fixedHolding}`);
  log(`log file: ${LOG_FILE}`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  log(`FATAL: ${err.message}\n${err.stack}`);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
