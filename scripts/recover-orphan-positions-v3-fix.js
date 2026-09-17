'use strict';

// FIX-2026-09-17 v3 fix — correct the 9 wrong waiting_sell_recovery records
// (v3 inserted with buyPrice=0 because marketPrice returned 0 due to wrong API signature)
//
// Args: --faiz or --owner (default owner)
//
// For each waiting_sell_recovery record (with buyPrice=0):
//   1. Re-read market price (using correct string symbol)
//   2. BUY missing qty (if buyCost >= $5)
//   3. Update buyPrice, buyFilledQty
//   4. Re-check PRICE_FILTER:
//      - If target passes now: place SELL, change state to 'selling'
//      - If still waiting: update record with correct prices, keep state

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
  for (let i = 0; i < 3; i++) {
    const info = await symbolInfo.loadSymbol(symbol).catch(() => null);
    if (info && info.lotSize) {
      return {
        base: info.baseAsset || symbol.replace(/USDT$|BUSD$|FDUSD$/, ''),
        status: info.status,
        stepSize: info.lotSize?.stepSize ? info.lotSize.stepSize.toNumber() : null,
        minQty: info.lotSize?.minQty ? info.lotSize.minQty.toNumber() : null,
        tickSize: info.priceFilter?.tickSize ? info.priceFilter.tickSize.toNumber() : 0.00000001,
        minNotional: info.notional?.minNotional ? info.notional.minNotional.toNumber() : 5,
      };
    }
    await sleep(300);
  }
  return null;
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

async function getMarketPrice(symbol) {
  try {
    const t = await binanceRest.getBookTicker(symbol);
    return parseFloat(t?.askPrice || t?.bidPrice || 0);
  } catch (_) { return 0; }
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const tradesCol = mongoose.connection.collection('trades');

  // Find wrong waiting_sell_recovery records (buyPrice=0 OR buyPrice unset from v3 bug)
  const records = await tradesCol
    .find({ state: 'waiting_sell_recovery', recoveryOriginalId: { $exists: true } })
    .sort({ symbol: 1 })
    .toArray();
  console.log(`\n=== ${arg.replace('--', '')} v3-fix: ${records.length} waiting_sell_recovery records to fix ===\n`);

  let fixedSelling = 0, fixedWaiting = 0, skipped = 0, errors = 0;
  const errorLog = [];

  for (let i = 0; i < records.length; i++) {
    const t = records[i];
    const symbol = t.symbol;
    const expectedQty = parseFloat(t.recoveryOriginalQty || t.buyFilledQty || t.buyQty || t.totalQty || 0);
    const targetSellPrice = parseFloat(t.waitingTargetPrice || t.targetSellPrice || 0);
    if (!expectedQty || !targetSellPrice) {
      console.log(`[${i + 1}/${records.length}] SKIP ${symbol}: missing qty/target`);
      skipped++;
      continue;
    }

    console.log(`\n[${i + 1}/${records.length}] ${symbol} expected=${expectedQty} TP=${targetSellPrice}`);

    // 1. PRE-LOAD symbol info
    const lot = await getBaseAssetAndLot(symbol);
    if (!lot || !lot.stepSize) {
      console.log(`  ERR: cannot load symbol info`);
      errors++;
      errorLog.push({ symbol, err: 'cannot load symbol info' });
      continue;
    }
    const stepSize = lot.stepSize;
    const tickSize = lot.tickSize;
    const minNotional = lot.minNotional || 5;
    console.log(`  stepSize=${stepSize} minNotional=${minNotional}`);

    // 2. Current balance
    const existingFree = await getFreeBalance(lot.base);
    console.log(`  existing free ${lot.base}: ${existingFree}`);

    // 3. Compute correct qty
    const buyQtyRaw = Math.max(0, expectedQty - existingFree);
    const buyQty = floorQty(buyQtyRaw, stepSize);
    const maxSellableQty = existingFree + buyQty;
    const sellQty = Math.min(
      floorQty(expectedQty, stepSize),
      floorQty(maxSellableQty, stepSize)
    );
    console.log(`  buyQty=${buyQty} sellQty=${sellQty}`);

    // 4. Get market price
    const marketPrice = await getMarketPrice(symbol);
    console.log(`  market ask: ${marketPrice}`);
    if (!marketPrice) {
      console.log(`  ERR: marketPrice=0`);
      errors++;
      errorLog.push({ symbol, err: 'marketPrice=0' });
      continue;
    }

    // 5. BUY if needed
    let buyResult = null;
    let actualBuyAvgPrice = marketPrice;
    if (buyQty > 0) {
      const buyCost = buyQty * marketPrice;
      if (buyCost < minNotional) {
        console.log(`  → BUY cost $${buyCost.toFixed(2)} < $${minNotional} — skip BUY`);
      } else {
        try {
          buyResult = await binanceRest.newOrder({
            symbol, side: 'BUY', type: 'MARKET', quantity: buyQty,
            newClientOrderId: `v3fix-buy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          }, { critical: true });
          actualBuyAvgPrice = parseFloat(buyResult?.fills?.[0]?.price || marketPrice);
          console.log(`  BUY filled: orderId=${buyResult.orderId} qty=${buyResult.executedQty} @ ${actualBuyAvgPrice}`);
          await sleep(500);
        } catch (e) {
          console.log(`  ERR BUY: ${JSON.stringify(e.response?.data || e.message).slice(0, 200)}`);
          errorLog.push({ symbol, err: e.response?.data || e.message });
          errors++;
          continue;
        }
      }
    }

    // 6. Check PRICE_FILTER
    const maxAllowedPrice = marketPrice * 1.20;
    if (targetSellPrice > maxAllowedPrice) {
      // Still waiting — update record with correct prices
      console.log(`  → SC 3/4 still: target (${targetSellPrice}) > max (${maxAllowedPrice.toFixed(6)})`);
      const finalQty = existingFree + (buyResult ? parseFloat(buyResult.executedQty || 0) : 0);
      await tradesCol.updateOne(
        { _id: t._id },
        {
          $set: {
            buyPrice: actualBuyAvgPrice,
            buyFilledQty: floorQty(finalQty, stepSize),
            buyOrderId: buyResult?.orderId || t.buyOrderId,
            buyFilledAt: buyResult ? new Date() : t.buyFilledAt,
            waitingMarketPrice: marketPrice,
            waitingMaxAllowedPrice: maxAllowedPrice,
            updatedAt: new Date(),
          },
        }
      );
      console.log(`  → updated record: buyPrice=${actualBuyAvgPrice}, buyFilledQty=${floorQty(finalQty, stepSize)}`);
      fixedWaiting++;
      continue;
    }

    // 7. Pass PRICE_FILTER now → place SELL, change to 'selling'
    const sellValue = sellQty * targetSellPrice;
    if (sellValue < minNotional) {
      console.log(`  → SC 5: SELL value $${sellValue.toFixed(2)} < $${minNotional} — DUST SKIP`);
      // Emergency dump if we just bought
      if (buyResult) {
        try {
          const fresh = await getFreeBalance(lot.base);
          const dumpQty = floorQty(fresh, stepSize);
          if (dumpQty > 0) {
            await binanceRest.newOrder({
              symbol, side: 'SELL', type: 'MARKET', quantity: dumpQty,
              newClientOrderId: `v3fix-dump-${Date.now()}`,
            }, { critical: true });
            console.log(`  emergency dump ${dumpQty}`);
          }
        } catch (_) {}
      }
      await tradesCol.updateOne(
        { _id: t._id },
        {
          $set: {
            state: 'dust_skipped',
            sellQty: floorQty(sellQty, stepSize),
            buyPrice: actualBuyAvgPrice,
            buyFilledQty: floorQty(existingFree + (buyResult ? parseFloat(buyResult.executedQty || 0) : 0), stepSize),
            recoveryNote: `v3-fixed 2026-09-17 — SELL value $${sellValue.toFixed(2)} < $${minNotional} NOTIONAL`,
            updatedAt: new Date(),
          },
        }
      );
      skipped++;
      continue;
    }

    // Cancel any stale SELL first
    try {
      const existingSells = await binanceRest.getOpenOrders({ symbol }, { critical: false }).catch(() => []);
      for (const o of (existingSells || []).filter((x) => x.side === 'SELL')) {
        await binanceRest.cancelOrder({ symbol, orderId: o.orderId }, { critical: true }).catch(() => {});
        await sleep(200);
      }
    } catch (_) {}

    // Place SELL
    let sellResult;
    try {
      const sellPx = roundPrice(targetSellPrice, tickSize);
      sellResult = await binanceRest.newOrder({
        symbol, side: 'SELL', type: 'LIMIT_MAKER', quantity: sellQty, price: sellPx,
        newClientOrderId: `v3fix-sell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      }, { critical: true });
      console.log(`  SELL placed: orderId=${sellResult.orderId} qty=${sellQty} @ ${sellPx}`);
    } catch (e) {
      console.log(`  ERR SELL: ${JSON.stringify(e.response?.data || e.message).slice(0, 200)}`);
      if (buyResult) {
        try {
          const fresh = await getFreeBalance(lot.base);
          const dumpQty = floorQty(fresh, stepSize);
          if (dumpQty > 0) {
            await binanceRest.newOrder({
              symbol, side: 'SELL', type: 'MARKET', quantity: dumpQty,
              newClientOrderId: `v3fix-dump-${Date.now()}`,
            }, { critical: true });
            console.log(`  emergency dump ${dumpQty}`);
          }
        } catch (_) {}
      }
      errorLog.push({ symbol, err: e.response?.data || e.message });
      errors++;
      continue;
    }

    // Update record to 'selling'
    await tradesCol.updateOne(
      { _id: t._id },
      {
        $set: {
          state: 'selling',
          sellOrderId: sellResult.orderId,
          sellClientOrderId: sellResult.clientOrderId || sellResult.newClientOrderId,
          sellPlacedAt: new Date(),
          sellStatus: 'NEW',
          sellPrice: roundPrice(targetSellPrice, tickSize),
          sellQty: sellQty,
          buyPrice: actualBuyAvgPrice,
          buyFilledQty: floorQty(existingFree + (buyResult ? parseFloat(buyResult.executedQty || 0) : 0), stepSize),
          buyOrderId: buyResult?.orderId || t.buyOrderId,
          buyFilledAt: buyResult ? new Date() : t.buyFilledAt,
          waitingSince: null,
          waitingTargetPrice: null,
          waitingMarketPrice: null,
          waitingMaxAllowedPrice: null,
          recoveryNote: `v3-fixed 2026-09-17 — BUY @ ${actualBuyAvgPrice}, SELL placed @ ${roundPrice(targetSellPrice, tickSize)}`,
          updatedAt: new Date(),
        },
      }
    );
    console.log(`  → updated record: state='selling'`);
    fixedSelling++;

    await sleep(700);
  }

  console.log(`\n=== ${arg.replace('--', '')} v3-fix DONE ===`);
  console.log(`  fixed_selling: ${fixedSelling}, fixed_waiting: ${fixedWaiting}, skipped: ${skipped}, errors: ${errors}`);
  if (errorLog.length > 0) {
    console.log(`\nErrors:`);
    for (const e of errorLog) console.log(`  ${e.symbol}: ${JSON.stringify(e.err).slice(0, 150)}`);
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
