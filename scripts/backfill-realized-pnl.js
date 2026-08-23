'use strict';
// FIX-2026-08-22: Backfill realizedPnl for sold trades that have null/missing value
//
//   Root cause: wallet page PnL (สะสม) chart shows empty even though user has 1000+ trades
//               because the `/api/wallet/pnl-series` filter requires `realizedPnl: { $ne: null }`
//               Older trades (before this field was reliably persisted) don't have realizedPnl
//               → $ne:null filter excludes them → cumulative line stays at zero
//
//   Strategy:
//     - target: state='sold' AND (realizedPnl: null OR field doesn't exist)
//     - preferred source: actual fees on the Trade doc (buyFee + sellFee when USDT-paid)
//                        formula: realizedPnl = (sellPrice - buyPrice) * qty - buyFee - sellFee
//                        This matches what `fees.calcPnl` computes minus any rounding tolerance
//     - fallback: fees.calcPnl({buyPrice, sellPrice, qty, feeRate})
//                 feeRate = 0.001 (normalMaker default — same as trader.js runtime)
//     - DCA stacks: use stackBep + stackTotalQty (BEP = weighted-avg of all layers)
//     - skip if essential fields missing (can't compute safely) — log + count in summary
//
//   Idempotent: only updates trades where realizedPnl is null/missing. Re-runs are no-ops
//
//   Usage:
//     node scripts/backfill-realized-pnl.js --dry-run    # preview only
//     node scripts/backfill-realized-pnl.js              # actually run (batched)
//     node scripts/backfill-realized-pnl.js --batch=500  # custom batch size

require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/db/models/Trade');
const config = require('../config');

const BACKFILL_SOURCE = 'backfill-realized-pnl-2026-08-22';
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_FEE_RATE = config.fees.normalMaker; // 0.001

// ─── PnL formula (mirrors src/binance/fees.js calcPnl) ──────────────────
function calcPnlFromFields(buyPrice, sellPrice, qty, feeRate) {
  const bp = parseFloat(buyPrice);
  const sp = parseFloat(sellPrice);
  const q = parseFloat(qty);
  const f = parseFloat(feeRate);
  if (!Number.isFinite(bp) || !Number.isFinite(sp) || !Number.isFinite(q) || q <= 0) return null;
  const gross = (sp - bp) * q;
  const fees = (bp + sp) * q * f;
  const net = gross - fees;
  const notional = bp * q;
  const pnlPercent = notional > 0 ? (net / notional) * 100 : 0;
  return { net, pnlPercent };
}

function deriveRealizedPnl(trade) {
  // DCA stack path — use stackBep + stackTotalQty (BEP = weighted-avg of all layers)
  if (trade.isDcaStack && trade.stackBep != null && trade.stackTotalQty > 0) {
    const sellPrice = parseFloat(trade.sellAvgPrice ?? trade.sellPrice);
    if (Number.isFinite(sellPrice) && sellPrice > 0) {
      // Prefer actual fees if both USDT-paid (most common for BEP stacks)
      const buyFee = parseFloat(trade.buyFee || 0);
      const sellFee = parseFloat(trade.sellFee || 0);
      if (Number.isFinite(buyFee) && Number.isFinite(sellFee) && (buyFee > 0 || sellFee > 0)) {
        const gross = (sellPrice - trade.stackBep) * trade.stackTotalQty;
        return {
          realizedPnl: Number((gross - buyFee - sellFee).toFixed(6)),
          pnlPercent: trade.stackBep * trade.stackTotalQty > 0
            ? Number((((gross - buyFee - sellFee) / (trade.stackBep * trade.stackTotalQty)) * 100).toFixed(4))
            : 0,
          source: 'dca-stack-fees',
        };
      }
      // Fallback: calcPnl with default feeRate
      const pnl = calcPnlFromFields(trade.stackBep, sellPrice, trade.stackTotalQty, DEFAULT_FEE_RATE);
      if (pnl) {
        return {
          realizedPnl: Number(pnl.net.toFixed(6)),
          pnlPercent: Number(pnl.pnlPercent.toFixed(4)),
          source: 'dca-stack-calc',
        };
      }
    }
    return null;
  }

  // Normal path — single BUY + SELL
  const buyPrice = parseFloat(trade.buyPrice);
  const sellPrice = parseFloat(trade.sellAvgPrice ?? trade.sellPrice);
  const qty = parseFloat(trade.sellFilledQty ?? trade.sellQty ?? trade.buyQty);
  if (!Number.isFinite(buyPrice) || !Number.isFinite(sellPrice) || !Number.isFinite(qty) || qty <= 0) {
    return null;
  }

  // Prefer actual fees (more accurate than feeRate * notional)
  const buyFee = parseFloat(trade.buyFee || 0);
  const sellFee = parseFloat(trade.sellFee || 0);
  if (Number.isFinite(buyFee) && Number.isFinite(sellFee) && (buyFee > 0 || sellFee > 0)) {
    const gross = (sellPrice - buyPrice) * qty;
    const realizedPnl = gross - buyFee - sellFee;
    const notional = buyPrice * qty;
    const pnlPercent = notional > 0 ? (realizedPnl / notional) * 100 : 0;
    return {
      realizedPnl: Number(realizedPnl.toFixed(6)),
      pnlPercent: Number(pnlPercent.toFixed(4)),
      source: 'fees',
    };
  }

  // Fallback: calcPnl with default feeRate (less accurate but always computable)
  const pnl = calcPnlFromFields(buyPrice, sellPrice, qty, DEFAULT_FEE_RATE);
  if (pnl) {
    return {
      realizedPnl: Number(pnl.net.toFixed(6)),
      pnlPercent: Number(pnl.pnlPercent.toFixed(4)),
      source: 'calc',
    };
  }
  return null;
}

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  const batchArg = process.argv.find((a) => a.startsWith('--batch='));
  const batchSize = batchArg ? parseInt(batchArg.split('=')[1], 10) : DEFAULT_BATCH_SIZE;
  console.log(`🔧 Backfill realizedPnl (${dryRun ? 'DRY-RUN' : 'LIVE'}, batch=${batchSize})`);

  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/onepercentbottrade');

    // ─── Step 1: find candidates ──────────────────────────────────────────
    const missingQuery = {
      state: 'sold',
      $or: [
        { realizedPnl: null },
        { realizedPnl: { $exists: false } },
      ],
    };
    const totalMissing = await Trade.countDocuments(missingQuery);
    console.log(`\n📌 Step 1: Find sold trades missing realizedPnl`);
    console.log(`   Found ${totalMissing} candidates`);

    if (totalMissing === 0) {
      console.log('✅ All sold trades already have realizedPnl — nothing to backfill');
      await mongoose.disconnect();
      return;
    }

    // ─── Step 2: derive + classify ─────────────────────────────────────────
    console.log(`\n📌 Step 2: Derive realizedPnl from buy/sell/fees`);
    const cursor = Trade.find(missingQuery)
      .select('_id botId symbol isDcaStack buyPrice sellPrice sellAvgPrice sellQty sellFilledQty buyQty buyFee sellFee stackBep stackTotalQty sellFilledAt')
      .lean()
      .cursor();

    const buckets = { 'fees': [], 'calc': [], 'dca-stack-fees': [], 'dca-stack-calc': [], 'skip': [] };
    let processed = 0;

    for await (const trade of cursor) {
      const result = deriveRealizedPnl(trade);
      if (!result) {
        buckets.skip.push(trade);
      } else {
        buckets[result.source].push({ trade, ...result });
      }
      processed++;
      if (processed % 1000 === 0) console.log(`   ...processed ${processed}/${totalMissing}`);
    }

    console.log(`\n   Classification:`);
    let totalUpdatable = 0;
    for (const [source, list] of Object.entries(buckets)) {
      console.log(`     ${source}: ${list.length}`);
      if (source !== 'skip') totalUpdatable += list.length;
    }
    console.log(`   Total to update: ${totalUpdatable}`);
    console.log(`   Skipped (missing fields): ${buckets.skip.length}`);

    if (buckets.skip.length > 0) {
      console.log(`\n   Sample skipped trades (first 3):`);
      for (const t of buckets.skip.slice(0, 3)) {
        console.log(`     ${t._id} ${t.symbol} buyPrice=${t.buyPrice} sellPrice=${t.sellPrice} qty=${t.sellQty ?? t.buyQty} isDca=${t.isDcaStack}`);
      }
    }

    if (dryRun) {
      console.log(`\n🔍 DRY-RUN — sample of trades that would be updated:`);
      for (const source of ['fees', 'calc', 'dca-stack-fees', 'dca-stack-calc']) {
        if (buckets[source].length > 0) {
          const sample = buckets[source][0];
          console.log(`   [${source}] ${sample.trade._id} ${sample.trade.symbol} realizedPnl=${sample.realizedPnl.toFixed(4)} pnlPercent=${sample.pnlPercent.toFixed(3)}%`);
        }
      }
      await mongoose.disconnect();
      return;
    }

    // ─── Step 3: write back (batched) ─────────────────────────────────────
    console.log(`\n📌 Step 3: Write back (batched, ${batchSize}/batch)`);
    let updatedCount = 0;
    const allUpdatable = [
      ...buckets['fees'],
      ...buckets['calc'],
      ...buckets['dca-stack-fees'],
      ...buckets['dca-stack-calc'],
    ];

    for (let i = 0; i < allUpdatable.length; i += batchSize) {
      const batch = allUpdatable.slice(i, i + batchSize);
      const bulkOps = batch.map((item) => ({
        updateOne: {
          filter: { _id: item.trade._id, state: 'sold' },
          update: {
            $set: {
              realizedPnl: item.realizedPnl,
              pnlPercent: item.pnlPercent,
            },
          },
        },
      }));
      const r = await Trade.bulkWrite(bulkOps, { ordered: false });
      updatedCount += r.modifiedCount || 0;
      console.log(`   batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(allUpdatable.length / batchSize)} → matched=${r.matchedCount} modified=${r.modifiedCount}`);
    }

    // ─── Step 4: verify ───────────────────────────────────────────────────
    const stillMissing = await Trade.countDocuments(missingQuery);
    console.log(`\n📌 Post-backfill:`);
    console.log(`   Updated: ${updatedCount} trades`);
    console.log(`   Still missing realizedPnl: ${stillMissing}`);

    // Quick sanity: cumulative PnL across all sold trades
    const agg = await Trade.aggregate([
      { $match: { state: 'sold', realizedPnl: { $ne: null } } },
      { $group: { _id: null, totalPnl: { $sum: '$realizedPnl' }, count: { $sum: 1 } } },
    ]);
    if (agg.length > 0) {
      console.log(`\n💰 Cumulative PnL (all sold trades): ${agg[0].totalPnl.toFixed(4)} USDT across ${agg[0].count} trades`);
    }

    await mongoose.disconnect();
    console.log(`\n✅ Backfill complete`);
  } catch (err) {
    console.error('Fatal:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();