'use strict';

// Investigate Sc5 (RAY) + Sc7 (DASH) root cause
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/onepercentbottrade';

const binanceRest = require('../src/binance/binanceRest');
const symbolInfo = require('../src/binance/symbolInfo');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.collection('trades');

  console.log(`\n========== INVESTIGATION: Sc5 (RAY) + Sc7 (DASH) ==========\n`);

  for (const symbol of ['RAYUSDT', 'DASHUSDT']) {
    console.log(`\n========== ${symbol} ==========\n`);

    // 1. Current exchange info stepSize
    const info = await symbolInfo.loadSymbol(symbol).catch(() => null);
    const lotFilter = (info?.filters || []).find((f) => f.filterType === 'LOT_SIZE');
    const notionalFilter = (info?.filters || []).find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
    console.log(`Exchange info for ${symbol}:`);
    console.log(`  status: ${info?.status}`);
    console.log(`  baseAsset: ${info?.baseAsset}`);
    console.log(`  LOT_SIZE stepSize: ${lotFilter?.stepSize}`);
    console.log(`  LOT_SIZE minQty: ${lotFilter?.minQty}`);
    console.log(`  NOTIONAL minNotional: ${notionalFilter?.minNotional || notionalFilter?.notional}`);
    console.log(`  PRICE_FILTER tickSize: ${(info?.filters || []).find((f) => f.filterType === 'PRICE_FILTER')?.tickSize}`);

    // 2. Current balance on Binance
    const acc = await binanceRest.getAccount({}, { critical: true });
    const baseAsset = info?.baseAsset || symbol.replace(/USDT$/, '');
    const b = (acc.balances || []).find((x) => x.asset === baseAsset);
    console.log(`\nCurrent Binance balance for ${baseAsset}:`);
    console.log(`  free: ${b?.free}`);
    console.log(`  locked: ${b?.locked}`);

    // 3. ALL trade history for this symbol
    const allTrades = await col.find({ symbol }).sort({ createdAt: 1 }).toArray();
    console.log(`\nTrade history for ${symbol}: ${allTrades.length} trades`);
    console.log('-'.repeat(120));
    console.log('createdAt              state           buyFilledQty  buyPrice   sellFilledQty  sellAvgPrice   realizedPnl  sellReason');
    console.log('-'.repeat(120));
    for (const t of allTrades) {
      const createdAt = t.createdAt ? new Date(t.createdAt).toISOString().slice(0, 19) : '-';
      const qty = t.buyFilledQty || t.buyQty || t.totalQty || 0;
      console.log(
        `${createdAt.padEnd(20)} ${(t.state || '-').padEnd(15)} ${String(qty).padStart(12)}  ${(parseFloat(t.buyPrice || 0)).toFixed(6).padStart(9)}  ${(parseFloat(t.sellFilledQty || 0)).toString().padStart(12)}  ${(parseFloat(t.sellAvgPrice || 0)).toFixed(6).padStart(11)}  ${(parseFloat(t.realizedPnl || 0)).toFixed(4).padStart(11)}  ${(t.sellReason || '-').slice(0, 40)}`
      );
    }

    // 4. The orphan_recovery_sweeper record specifically
    const orphan = allTrades.find((t) => t.sellReason === 'orphan_recovery_sweeper');
    if (orphan) {
      console.log(`\n  >>> THE ORPHAN RECORD for ${symbol}:`);
      console.log(`      _id: ${orphan._id}`);
      console.log(`      buyFilledQty: ${orphan.buyFilledQty}`);
      console.log(`      buyQty: ${orphan.buyQty}`);
      console.log(`      totalQty: ${orphan.totalQty}`);
      console.log(`      buyPrice: ${orphan.buyPrice}`);
      console.log(`      targetSellPrice: ${orphan.targetSellPrice}`);
      console.log(`      sellAvgPrice (when force-closed): ${orphan.sellAvgPrice}`);
      console.log(`      realizedPnl: ${orphan.realizedPnl}`);
      console.log(`      sellFilledQty: ${orphan.sellFilledQty}`);
      console.log(`      sellOrderId: ${orphan.sellOrderId}`);
      console.log(`      sellFilledAt: ${orphan.sellFilledAt}`);
    }
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
