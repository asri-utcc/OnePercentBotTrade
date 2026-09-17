'use strict';

// FIX-2026-09-17 EMERGENCY RECOVERY v3 — handle all scenarios
//
// Args: --faiz or --owner (default owner)
//
// For each orphan_recovery_sweeper trade:
//   1. PRE-LOAD symbol info (3 retries — fixes cold cache bug)
//   2. Compute BUY qty = max(0, expectedQty - dust) floored to stepSize
//   3. Compute SELL qty = MIN(floor(expectedQty), dust+buyQty) floored (fixes off-by-one)
//   4. Pre-checks:
//      - Sc 7: expectedQty < stepSize → dust_skipped, NO PnL
//      - Sc 5 micro: target value < $1 USDT → dust_skipped, NO PnL
//      - Sc 5 NOTIONAL: BUY cost < $5 OR SELL value < $5 → dust_skipped, NO PnL
//      - Sc 3/4 PRICE_FILTER: target > market × 1.20 → waiting_sell_recovery (no SELL placed)
//   5. Normal: BUY + LIMIT_MAKER SELL + DELETE old + INSERT new state='selling'
//   6. BUY succeeded but SELL failed → emergency MARKET dump
//
// ZENUSDT skipped per user instruction.

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
  // Try up to 3 times to handle cold cache (root cause of Sc 5/7)
  for (let i = 0; i < 3; i++) {
    const info = await symbolInfo.loadSymbol(symbol).catch(() => null);
    if (info && info.filters) {
      const lot = (info.filters || []).find((f) => f.filterType === 'LOT_SIZE');
      const notional = (info.filters || []).find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
      const priceFilter = (info.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
      return {
        base: info.baseAsset || symbol.replace(/USDT$|BUSD$|FDUSD$/, ''),
        status: info.status,
        stepSize: lot ? parseFloat(lot.stepSize) : null,
        minQty: lot ? parseFloat(lot.minQty) : null,
        tickSize: parseFloat(priceFilter?.tickSize || '0.00000001'),
        minNotional: parseFloat(notional?.minNotional || notional?.notional || 5),
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
    const t = await binanceRest.getBookTicker({ symbol }, { critical: false });
    return parseFloat(t.askPrice || t.bidPrice || t.data?.askPrice || 0);
  } catch (_) { return 0; }
}

async function cancelStaleSells(symbol) {
  try {
    const existingSells = await binanceRest.getOpenOrders({ symbol }, { critical: false }).catch(() => []);
    for (const o of (existingSells || []).filter((x) => x.side === 'SELL')) {
      const c = await binanceRest.cancelOrder({ symbol, orderId: o.orderId }, { critical: true }).catch(() => ({ status: 'ERR' }));
      console.log(`     cancelled stale SELL ${o.orderId}: ${c.status || 'OK'}`);
      await sleep(200);
    }
  } catch (_) {}
}

async function emergencyDump(symbol, baseAsset, stepSize) {
  try {
    const fresh = await getFreeBalance(baseAsset);
    const dumpQty = floorQty(fresh, stepSize);
    if (dumpQty > 0) {
      await binanceRest.newOrder({
        symbol, side: 'SELL', type: 'MARKET', quantity: dumpQty,
        newClientOrderId: `recovery-dump-${Date.now()}`,
      }, { critical: true });
      console.log(`     emergency dump ${dumpQty} ${baseAsset}`);
      return true;
    }
  } catch (e) {
    console.log(`     emergency dump FAILED: ${e.message}`);
  }
  return false;
}

async function deleteAndInsert(tradesCol, t, newDoc) {
  await tradesCol.deleteOne({ _id: t._id });
  await tradesCol.insertOne({
    ...t,
    ...newDoc,
    _id: new mongoose.Types.ObjectId(),
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
    recoveryOriginalId: t._id,
    recoveryOriginalTradeCreatedAt: t.createdAt,
    updatedAt: new Date(),
  });
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const tradesCol = mongoose.connection.collection('trades');

  const trades = await tradesCol
    .find({ sellReason: 'orphan_recovery_sweeper', symbol: { $ne: 'ZENUSDT' } })
    .sort({ symbol: 1 })
    .toArray();
  console.log(`\n=== ${arg.replace('--', '')} recovery v3: ${trades.length} trades (excl. ZENUSDT) ===\n`);

  let ok = 0, waiting = 0, dustSkip = 0, errors = 0;
  const errorLog = [];

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const symbol = t.symbol;
    const expectedQty = parseFloat(t.buyFilledQty || t.buyQty || t.totalQty || 0);
    const targetSellPrice = parseFloat(t.targetSellPrice || 0);
    if (!expectedQty || !targetSellPrice) {
      console.log(`[${i + 1}/${trades.length}] SKIP ${symbol}: missing qty/target`);
      continue;
    }

    console.log(`\n[${i + 1}/${trades.length}] ${symbol} expected=${expectedQty} TP=${targetSellPrice}`);

    // 1. PRE-LOAD symbol info (handle cold cache)
    const lot = await getBaseAssetAndLot(symbol);
    if (!lot || !lot.stepSize) {
      console.log(`  ERR: cannot load symbol info`);
      errors++;
      errorLog.push({ symbol, err: 'cannot load symbol info' });
      continue;
    }
    if (lot.status && lot.status !== 'TRADING') {
      console.log(`  SKIP: symbol ${lot.status}`);
      await deleteAndInsert(tradesCol, t, {
        state: 'dust_skipped',
        recoveryNote: `restored 2026-09-17 — symbol ${lot.status}`,
      });
      dustSkip++;
      continue;
    }
    const stepSize = lot.stepSize;
    const tickSize = lot.tickSize;
    const minNotional = lot.minNotional || 5;
    console.log(`  stepSize=${stepSize} tickSize=${tickSize} minNotional=${minNotional} base=${lot.base} status=${lot.status}`);

    // 2. Current balance
    const existingFree = await getFreeBalance(lot.base);
    console.log(`  existing free ${lot.base}: ${existingFree}`);

    // 3. Compute qty
    const buyQtyRaw = Math.max(0, expectedQty - existingFree);
    const buyQty = floorQty(buyQtyRaw, stepSize);
    const maxSellableQty = existingFree + buyQty;
    const sellQty = Math.min(
      floorQty(expectedQty, stepSize),
      floorQty(maxSellableQty, stepSize)
    );
    console.log(`  buyQty=${buyQty} sellQty=${sellQty} target=${targetSellPrice}`);

    // 4. Pre-check Sc 7: qty below stepSize
    if (expectedQty < stepSize) {
      console.log(`  → SC 7: expectedQty (${expectedQty}) < stepSize (${stepSize}) — DUST SKIP, no PnL`);
      await deleteAndInsert(tradesCol, t, {
        state: 'dust_skipped',
        recoveryNote: `restored 2026-09-17 — qty ${expectedQty} < stepSize ${stepSize}`,
      });
      dustSkip++;
      continue;
    }

    // 5. Pre-check Sc 5 micro: target value < $1
    const targetValue = sellQty * targetSellPrice;
    if (targetValue < 1) {
      console.log(`  → SC 5 micro: target value ($${targetValue.toFixed(4)}) < $1 — DUST SKIP, no PnL`);
      await deleteAndInsert(tradesCol, t, {
        state: 'dust_skipped',
        recoveryNote: `restored 2026-09-17 — target value $${targetValue.toFixed(4)} < $1`,
      });
      dustSkip++;
      continue;
    }

    // 6. Market price
    const marketPrice = await getMarketPrice(symbol);
    console.log(`  market ask: ${marketPrice}`);

    // 7. Pre-check Sc 3/4: PRICE_FILTER fail (target > market × 1.20)
    const maxAllowedPrice = marketPrice * 1.20;
    if (targetSellPrice > maxAllowedPrice) {
      console.log(`  → SC 3/4: target (${targetSellPrice}) > max (${maxAllowedPrice.toFixed(6)}) — WAITING`);

      // Try to BUY so we have the coin ready for later
      let buyResult = null;
      if (buyQty > 0) {
        const buyCost = buyQty * marketPrice;
        if (buyCost < minNotional) {
          console.log(`     BUY cost $${buyCost.toFixed(2)} < $${minNotional} — skip BUY, just record current dust`);
        } else {
          try {
            await cancelStaleSells(symbol);
            buyResult = await binanceRest.newOrder({
              symbol, side: 'BUY', type: 'MARKET', quantity: buyQty,
              newClientOrderId: `recovery-buy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            }, { critical: true });
            console.log(`     BUY filled: orderId=${buyResult.orderId} qty=${buyResult.executedQty}`);
            await sleep(500);
          } catch (e) {
            console.log(`     BUY failed: ${JSON.stringify(e.response?.data || e.message).slice(0, 150)}`);
            errorLog.push({ symbol, err: e.response?.data || e.message });
            errors++;
            continue;
          }
        }
      } else {
        await cancelStaleSells(symbol);
      }

      // Insert waiting_sell_recovery (no SELL placed)
      const buyAvgPrice = parseFloat(buyResult?.fills?.[0]?.price || marketPrice || t.buyPrice || 0);
      const totalHeldQty = existingFree + (buyResult ? parseFloat(buyResult.executedQty || 0) : 0);
      await deleteAndInsert(tradesCol, t, {
        state: 'waiting_sell_recovery',
        sellOrderId: null,
        sellClientOrderId: null,
        sellPlacedAt: null,
        sellStatus: null,
        sellPrice: targetSellPrice,
        sellQty: floorQty(totalHeldQty, stepSize),
        buyOrderId: buyResult?.orderId || t.buyOrderId,
        buyPrice: buyAvgPrice,
        buyFilledQty: totalHeldQty,
        buyFilledAt: buyResult ? new Date() : t.buyFilledAt,
        waitingSince: new Date(),
        waitingTargetPrice: targetSellPrice,
        waitingMarketPrice: marketPrice,
        waitingMaxAllowedPrice: maxAllowedPrice,
        recoveryNote: `restored 2026-09-17 — waiting for target TP ${targetSellPrice} to pass PRICE_FILTER (market=${marketPrice}, max=${maxAllowedPrice.toFixed(6)})`,
      });
      console.log(`     new Trade inserted (waiting_sell_recovery), retry every 4h`);
      waiting++;
      continue;
    }

    // 8. Normal flow: BUY + SELL + DB
    let buyResult = null, sellResult = null;
    try {
      await cancelStaleSells(symbol);

      // BUY
      if (buyQty > 0) {
        const buyCost = buyQty * marketPrice;
        if (buyCost < minNotional) {
          console.log(`  → SC 5: BUY cost $${buyCost.toFixed(2)} < $${minNotional} — DUST SKIP, no PnL`);
          await deleteAndInsert(tradesCol, t, {
            state: 'dust_skipped',
            recoveryNote: `restored 2026-09-17 — BUY cost $${buyCost.toFixed(2)} < $${minNotional} NOTIONAL min`,
          });
          dustSkip++;
          continue;
        }
        buyResult = await binanceRest.newOrder({
          symbol, side: 'BUY', type: 'MARKET', quantity: buyQty,
          newClientOrderId: `recovery-buy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        }, { critical: true });
        console.log(`  BUY filled: orderId=${buyResult.orderId} qty=${buyResult.executedQty}`);
        await sleep(500);
      }

      // SELL
      const sellValue = sellQty * targetSellPrice;
      if (sellValue < minNotional) {
        console.log(`  → SC 5: SELL value $${sellValue.toFixed(2)} < $${minNotional} — DUST SKIP`);
        if (buyResult) await emergencyDump(symbol, lot.base, stepSize);
        await deleteAndInsert(tradesCol, t, {
          state: 'dust_skipped',
          recoveryNote: `restored 2026-09-17 — SELL value $${sellValue.toFixed(2)} < $${minNotional}`,
        });
        dustSkip++;
        continue;
      }

      const sellPx = roundPrice(targetSellPrice, tickSize);
      sellResult = await binanceRest.newOrder({
        symbol, side: 'SELL', type: 'LIMIT_MAKER', quantity: sellQty, price: sellPx,
        newClientOrderId: `recovery-sell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      }, { critical: true });
      console.log(`  SELL placed: orderId=${sellResult.orderId} qty=${sellQty} @ ${sellPx}`);

      // BUY avg price
      let buyAvgPrice = parseFloat(buyResult?.fills?.[0]?.price || 0);
      if (buyResult?.orderId && !buyAvgPrice) {
        try {
          const vo = await binanceRest.getOrder({ symbol, orderId: buyResult.orderId }, { critical: false });
          buyAvgPrice = parseFloat(vo.price || vo.fills?.[0]?.price || 0);
        } catch (_) {}
      }

      // DB restore
      await deleteAndInsert(tradesCol, t, {
        state: 'selling',
        sellOrderId: sellResult.orderId,
        sellClientOrderId: sellResult.clientOrderId || sellResult.newClientOrderId,
        sellPlacedAt: new Date(),
        sellStatus: 'NEW',
        sellPrice: sellPx,
        sellQty: sellQty,
        buyOrderId: buyResult?.orderId || t.buyOrderId,
        buyPrice: buyAvgPrice || t.buyPrice,
        buyFilledQty: sellQty,
        buyFilledAt: buyResult ? new Date() : t.buyFilledAt,
        recoveryNote: 'restored 2026-09-17 after orphan-recovery-sweeper rollback',
      });
      console.log(`  DB restored: state='selling', old trade deleted + new inserted`);
      ok++;
    } catch (e) {
      const ferr = e.response?.data || { msg: e.message };
      console.log(`  ERR: ${JSON.stringify(ferr).slice(0, 200)}`);
      errorLog.push({ symbol, err: ferr });
      errors++;
      // Emergency dump if BUY succeeded but SELL failed
      if (buyResult?.orderId && !sellResult?.orderId) {
        console.log(`  → emergency dump (BUY succeeded, SELL failed)`);
        await emergencyDump(symbol, lot.base, stepSize);
      }
    }

    await sleep(700);
  }

  console.log(`\n=== ${arg.replace('--', '')} recovery v3 DONE ===`);
  console.log(`  ok: ${ok}, waiting: ${waiting}, dust_skip: ${dustSkip}, errors: ${errors}`);
  if (errorLog.length > 0) {
    console.log(`\nErrors:`);
    for (const e of errorLog) console.log(`  ${e.symbol}: ${JSON.stringify(e.err).slice(0, 150)}`);
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
