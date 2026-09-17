'use strict';

// FIX-2026-09-17 EMERGENCY RECOVERY — restore 38 orphan_recovery_sweeper positions
// Args: --faiz or --owner (default owner)
//
// For each orphan_recovery_sweeper trade:
//   1. Cancel any open SELL for the symbol (defensive)
//   2. Compute BUY qty = max(0, expectedQty - existingDust) floored to LOT_SIZE
//   3. MARKET BUY at current market → wait for fill
//   4. LIMIT_MAKER SELL at original targetSellPrice
//   5. DELETE old Trade (which had sellReason='orphan_recovery_sweeper' + realizedPnl)
//   6. INSERT new Trade (state='selling' with new BUY/SELL data) — "restore as before"
//
// ZENUSDT is skipped (per user instruction)

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const arg = process.argv[2] || '--owner';
const isFaiz = arg === '--faiz';

const envFile = isFaiz ? '.env.faiz' : '.env';
const envContent = fs.readFileSync(path.join(__dirname, '..', envFile), 'utf8');
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.MONGODB_URI = isFaiz
  ? 'mongodb://127.0.0.1:27017/onepercentbottrade_faiz'
  : 'mongodb://127.0.0.1:27017/onepercentbottrade';

const binanceRest = require('../src/binance/binanceRest');
const symbolInfo = require('../src/binance/symbolInfo');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getBaseAssetAndLot(symbol) {
  const info = await symbolInfo.loadSymbol(symbol).catch(() => null);
  const lot = (info?.filters || []).find((f) => f.filterType === 'LOT_SIZE');
  return {
    base: info?.baseAsset || symbol.replace(/USDT$|BUSD$|FDUSD$/, ''),
    stepSize: lot ? parseFloat(lot.stepSize) : null,
    minQty: lot ? parseFloat(lot.minQty) : null,
    tickSize: parseFloat((info?.filters || []).find((f) => f.filterType === 'PRICE_FILTER')?.tickSize || 0.00000001),
  };
}

function floorQty(qty, stepSize) {
  if (!stepSize || stepSize === 0) return qty;
  const precision = (stepSize.toString().split('.')[1] || '').length;
  return parseFloat((Math.floor(qty / stepSize) * stepSize).toFixed(precision));
}

function roundPrice(price, tickSize) {
  if (!tickSize || tickSize === 0) return price;
  return parseFloat((Math.floor(price / tickSize) * tickSize).toFixed(8));
}

async function getFreeBalance(asset) {
  const acc = await binanceRest.getAccount({}, { critical: false }).catch(() => null);
  if (!acc) return 0;
  const b = (acc.balances || []).find((x) => x.asset === asset);
  return parseFloat(b?.free || 0);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const tradesCol = mongoose.connection.collection('trades');

  // Get all 38 (excluding ZEN)
  const trades = await tradesCol
    .find({ sellReason: 'orphan_recovery_sweeper', symbol: { $ne: 'ZENUSDT' } })
    .sort({ symbol: 1 })
    .toArray();
  console.log(`\n=== ${arg.replace('--', '')} recovery: ${trades.length} trades (excl. ZENUSDT) ===\n`);

  let success = 0, errors = 0, skipped = 0;
  const errorLog = [];

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const symbol = t.symbol;
    const expectedQty = parseFloat(t.buyFilledQty || t.buyQty || t.totalQty || 0);
    const targetSellPrice = parseFloat(t.targetSellPrice || 0);
    if (!expectedQty || !targetSellPrice) {
      console.log(`[${i + 1}/${trades.length}] SKIP ${symbol}: missing qty/target`);
      skipped++;
      continue;
    }

    console.log(`\n[${i + 1}/${trades.length}] ${symbol} expected=${expectedQty} TP=${targetSellPrice}`);

    // Get LOT_SIZE info
    const lot = await getBaseAssetAndLot(symbol);
    if (!lot.stepSize) {
      console.log(`  WARN: no LOT_SIZE for ${symbol}, using raw qty`);
    }
    const stepSize = lot.stepSize || 1;
    const tickSize = lot.tickSize || 0.0000001;

    // Check existing balance (dust from rounding)
    const existingFree = await getFreeBalance(lot.base);
    console.log(`  existing free ${lot.base}: ${existingFree}`);

    // Compute BUY qty = max(0, expected - existing) floored to stepSize
    const buyQtyRaw = Math.max(0, expectedQty - existingFree);
    const buyQty = floorQty(buyQtyRaw, stepSize);
    const sellQty = floorQty(expectedQty, stepSize); // SELL = full expected (after dust + new bought = expected)

    console.log(`  BUY qty=${buyQty}  SELL qty=${sellQty}  target=${targetSellPrice}`);

    if (buyQty <= 0 && existingFree >= sellQty) {
      // Already have enough — skip BUY, just place SELL
      console.log(`  → have enough, BUY skipped`);
    } else if (buyQty <= 0) {
      console.log(`  → have ${existingFree} but need ${sellQty} and stepSize=${stepSize}, BUY=${buyQty} — partial`);
    }

    let buyResult = null, sellResult = null;
    try {
      // 1. Cancel any existing SELL for this symbol (defensive)
      try {
        const existingSells = await binanceRest.getOpenOrders({ symbol }, { critical: false }).catch(() => []);
        for (const o of (existingSells || []).filter((x) => x.side === 'SELL')) {
          const c = await binanceRest.cancelOrder({ symbol, orderId: o.orderId }, { critical: true }).catch((e) => ({ ok: false, err: e }));
          if (c?.status || c?.code === -2011) console.log(`  cancelled stale SELL ${o.orderId}: ${c.status || 'ALREADY_GONE'}`);
          await sleep(200);
        }
      } catch (e) { /* ignore */ }

      // 2. MARKET BUY
      if (buyQty > 0) {
        buyResult = await binanceRest.newOrder({
          symbol,
          side: 'BUY',
          type: 'MARKET',
          quantity: buyQty,
          newClientOrderId: `recovery-buy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        }, { critical: true });
        console.log(`  BUY filled: orderId=${buyResult.orderId} qty=${buyResult.executedQty} avgPx=${buyResult.fills?.[0]?.price || buyResult.price}`);
        await sleep(500);
      } else {
        console.log(`  BUY skipped (sufficient dust)`);
      }

      // 3. LIMIT_MAKER SELL at original targetSellPrice
      const sellPx = roundPrice(targetSellPrice, tickSize);
      sellResult = await binanceRest.newOrder({
        symbol,
        side: 'SELL',
        type: 'LIMIT_MAKER',
        quantity: sellQty,
        price: sellPx,
        newClientOrderId: `recovery-sell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      }, { critical: true });
      console.log(`  SELL placed: orderId=${sellResult.orderId} qty=${sellResult.quantity || sellQty} @ ${sellPx}`);

      // 4. Get BUY avg price for the new record
      let buyAvgPrice = parseFloat(buyResult?.fills?.[0]?.price || buyResult?.price || 0);
      if (buyResult?.orderId && !buyAvgPrice) {
        try {
          const vo = await binanceRest.getOrder({ symbol, orderId: buyResult.orderId }, { critical: false });
          buyAvgPrice = parseFloat(vo.price || vo.fills?.[0]?.price || 0);
        } catch (_) { /* keep */ }
      }

      // 5. DELETE old Trade
      await tradesCol.deleteOne({ _id: t._id });
      console.log(`  old Trade deleted: ${t._id}`);

      // 6. INSERT new Trade (restore as 'selling' state)
      const newTradeDoc = {
        ...t, // copy all original fields
        _id: new mongoose.Types.ObjectId(),
        state: 'selling',
        sellOrderId: sellResult.orderId,
        sellClientOrderId: sellResult.clientOrderId || sellResult.newClientOrderId,
        sellPlacedAt: new Date(),
        sellStatus: 'NEW',
        sellPrice: sellPx,
        sellQty: sellQty,
        buyOrderId: buyResult?.orderId || t.buyOrderId,
        buyPrice: buyAvgPrice || t.buyPrice, // if BUY happened, use new avg; else preserve old
        buyFilledQty: sellQty, // for the new BUY this was filled
        buyFilledAt: buyResult ? new Date() : t.buyFilledAt,
        realizedPnl: null,
        sellReason: null,
        sellReasonDetail: null,
        sellReasonSource: null,
        sellReasonAt: null,
        sellFilledAt: null,
        sellAvgPrice: null,
        sellFilledQty: null,
        soldVerifiedAt: null,
        sellInFlight: false,
        recoveryNote: 'restored 2026-09-17 after orphan-recovery-sweeper rollback',
        recoveryOriginalId: t._id,
        recoveryOriginalTradeCreatedAt: t.createdAt,
        updatedAt: new Date(),
      };
      await tradesCol.insertOne(newTradeDoc);
      console.log(`  new Trade inserted: ${newTradeDoc._id}`);

      success++;
    } catch (e) {
      const ferr = e.response?.data || { msg: e.message };
      console.log(`  ERR: ${JSON.stringify(ferr).slice(0, 200)}`);
      errorLog.push({ symbol, err: ferr });
      errors++;
      // If BUY succeeded but SELL failed, immediately SELL what we bought
      if (buyResult?.orderId && !sellResult?.orderId) {
        console.log(`  KNOWN-ISSUE: BUY done but SELL failed — placing emergency SELL at market to avoid orphan BUY`);
        try {
          const dustFree = await getFreeBalance(lot.base);
          const dumpQty = floorQty(dustFree, stepSize);
          if (dumpQty > 0) {
            await binanceRest.newOrder({
              symbol, side: 'SELL', type: 'MARKET', quantity: dumpQty,
              newClientOrderId: `emergency-dump-${Date.now()}`,
            }, { critical: true });
            console.log(`  emergency dumped ${dumpQty} ${lot.base}`);
          }
        } catch (e2) {
          console.log(`  emergency dump FAILED: ${e2.message}`);
        }
      }
    }

    await sleep(700); // weight-friendly
  }

  console.log(`\n=== ${arg.replace('--', '')} recovery DONE ===`);
  console.log(`  Success: ${success}, Errors: ${errors}, Skipped: ${skipped}`);
  if (errorLog.length > 0) {
    console.log(`\nErrors:`);
    for (const e of errorLog) console.log(`  ${e.symbol}: ${JSON.stringify(e.err).slice(0, 150)}`);
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
