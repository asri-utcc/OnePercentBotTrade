'use strict';

// FIX-2026-09-17 EMERGENCY RECOVERY — close all currently open positions
// Args: --faiz or --owner (default owner)
//
// For each trade with state in OPEN_STATES:
//   - If sellOrderId: cancel LIMIT_MAKER on Binance first, then MARKET SELL
//   - If no sellOrderId (holding): MARKET SELL directly
// After fill: update DB trade to state='sold', sellReason='manual_close_pre_recovery_2026-09-17'

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const arg = process.argv[2] || '--owner';
const isFaiz = arg === '--faiz';

// Load the right .env file BEFORE any require that touches config
const envFile = isFaiz ? '.env.faiz' : '.env';
const envPath = path.join(__dirname, '..', envFile);
const envContent = fs.readFileSync(envPath, 'utf8');
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
process.env.MONGODB_URI = isFaiz
  ? 'mongodb://127.0.0.1:27017/onepercentbottrade_faiz'
  : 'mongodb://127.0.0.1:27017/onepercentbottrade';

// Require after env is set
const binanceRest = require('../src/binance/binanceRest');
const symbolInfo = require('../src/binance/symbolInfo');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getExchangeInfoStep(symbol) {
  // symbolInfo module caches exchangeInfo; just call getInfo
  const info = await symbolInfo.getInfo(symbol).catch(() => null);
  if (!info) return null;
  const lotFilter = (info.filters || []).find((f) => f.filterType === 'LOT_SIZE');
  const notional = (info.filters || []).find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
  return {
    stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : null,
    minQty: lotFilter ? parseFloat(lotFilter.minQty) : null,
    minNotional: notional ? parseFloat(notional.minNotional || notional.notional || 0) : 5,
    baseAsset: info.baseAsset,
    quoteAsset: info.quoteAsset,
  };
}

function floorQty(qty, stepSize) {
  if (!stepSize || stepSize === 0) return qty;
  const precision = (stepSize.toString().split('.')[1] || '').length;
  return parseFloat((Math.floor(qty / stepSize) * stepSize).toFixed(precision));
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const OPEN_STATES = ['placed', 'filled', 'holding', 'retrying', 'selling', 'partial_sell_wait', 'partial_wait'];
  const trades = await mongoose.connection.collection('trades')
    .find({ state: { $in: OPEN_STATES } })
    .toArray();
  console.log(`\n=== ${arg.replace('--', '')}: closing ${trades.length} open positions ===\n`);

  let closedCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  let totalUsdtFreed = 0;

  for (const t of trades) {
    const symbol = t.symbol;
    const buyQty = parseFloat(t.buyFilledQty || t.buyQty || t.totalQty || 0);
    console.log(`\n→ ${symbol} state=${t.state} sellOrderId=${t.sellOrderId || 'none'} qty=${buyQty}`);

    // 1. Cancel existing SELL if any
    if (t.sellOrderId) {
      const c = await binanceRest.cancelOrder({ symbol, orderId: t.sellOrderId }, { critical: true }).catch((e) => ({ ok: false, err: e }));
      if (c?.status === 'CANCELED' || c?.status === 'ALREADY_GONE' || c?.code === -2011) {
        console.log(`  cancel sell: OK ${c.status || ''}`);
      } else {
        console.log(`  cancel sell: ${JSON.stringify(c).slice(0, 200)}`);
      }
      await sleep(400);
    }

    // 2. Resolve qty to sell
    const symInfo = await getExchangeInfoStep(symbol).catch(() => null);
    let sellQty = buyQty;
    if (symInfo?.stepSize) sellQty = floorQty(buyQty, symInfo.stepSize);
    if (sellQty <= 0) {
      console.log(`  SKIP: qty ${buyQty} rounds to 0 with stepSize=${symInfo?.stepSize}`);
      skippedCount++;
      continue;
    }

    // 3. Place MARKET SELL (with newClientOrderId for traceability)
    let m;
    try {
      m = await binanceRest.newOrder({
        symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: sellQty,
        newClientOrderId: `close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      }, { critical: true });
    } catch (e) {
      const ferr = e.response?.data || { msg: e.message };
      console.log(`  MARKET SELL ERR: ${JSON.stringify(ferr).slice(0, 200)}`);
      if (ferr.code === -1013) console.log(`  (NOTIONAL fail — likely dust, skipping)`);
      errorCount++;
      continue;
    }

    // 4. Verify fill via getOrder (best-effort)
    await sleep(600);
    let executedQty = parseFloat(m.executedQty || sellQty);
    let avgPrice = parseFloat(m.price || (m.fills?.[0]?.price) || 0);
    let quoteQty = parseFloat(m.cummulativeQuoteQty || 0);
    if (!quoteQty && avgPrice && executedQty) quoteQty = executedQty * avgPrice;

    if (m.orderId) {
      try {
        const verify = await binanceRest.getOrder({ symbol, orderId: m.orderId }, { critical: false });
        executedQty = parseFloat(verify.executedQty || executedQty);
        avgPrice = parseFloat(verify.price || avgPrice);
        quoteQty = parseFloat(verify.cummulativeQuoteQty || quoteQty);
      } catch (_) { /* keep place response */ }
    }

    totalUsdtFreed += quoteQty;
    const pnl = (t.buyPrice && avgPrice) ? (avgPrice - parseFloat(t.buyPrice)) * executedQty : 0;
    console.log(`  MARKET SELL FILLED: qty=${executedQty} avgPx=${avgPrice} ≈ ${quoteQty.toFixed(4)} USDT (PnL=${pnl.toFixed(4)})`);

    // 5. Update DB
    await mongoose.connection.collection('trades').updateOne(
      { _id: t._id },
      {
        $set: {
          state: 'sold',
          sellOrderId: m.orderId,
          sellFilledQty: executedQty,
          sellAvgPrice: avgPrice,
          sellFilledAt: new Date(),
          sellStatus: 'FILLED',
          sellReason: 'manual_close_pre_recovery_2026-09-17',
          sellReasonDetail: `Closed to free USDT for re-buy recovery. Original BUY @ ${t.buyPrice}, current MKT @ ${avgPrice}, pnl=${pnl.toFixed(4)} USDT`,
          sellReasonSource: 'recovery-2026-09-17.preRecoveryClose',
          sellReasonAt: new Date(),
          soldVerifiedAt: new Date(),
          realizedPnl: pnl,
          sellInFlight: false,
        },
      }
    );
    closedCount++;
    await sleep(500);
  }

  console.log(`\n=== DONE: ${arg.replace('--', '')} ===`);
  console.log(`  Closed: ${closedCount}, Errors: ${errorCount}, Skipped: ${skippedCount}`);
  console.log(`  USDT freed (approx): ${totalUsdtFreed.toFixed(4)}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
