'use strict';

// Quick USDT balance check + open orders check
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

(async () => {
  const acc = await binanceRest.getAccount({}, { critical: true });
  const usdt = (acc.balances || []).find((b) => b.asset === 'USDT');
  console.log(`\n=== ${arg.replace('--', '')} ===`);
  console.log(`USDT free:   ${parseFloat(usdt?.free || 0).toFixed(4)}`);
  console.log(`USDT locked: ${parseFloat(usdt?.locked || 0).toFixed(4)}`);

  const orders = await binanceRest.getOpenOrders({}, { critical: true }).catch(() => []);
  if (orders.length > 0) {
    console.log(`\nOpen orders: ${orders.length}`);
    for (const o of orders) {
      console.log(`  ${o.symbol} ${o.side} ${o.type} qty=${o.origQty} price=${o.price} orderId=${o.orderId} status=${o.status}`);
    }
  } else {
    console.log('Open orders: 0');
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const trades = await mongoose.connection.collection('trades')
    .find({ sellReason: 'orphan_recovery_sweeper' })
    .toArray();
  // Use bookTicker one more time to estimate cost
  let totalCost = 0;
  let idx = 0;
  for (const t of trades) {
    const sym = t.symbol;
    let px = 0;
    try {
      const bk = await binanceRest.getBookTicker({ symbol: sym }, { critical: false });
      // Try both response shapes
      if (typeof bk === 'object' && bk !== null) {
        px = parseFloat(bk.askPrice || bk.bidPrice || (Array.isArray(bk) ? bk[0]?.askPrice : 0) || 0);
        if (!px) {
          // Maybe binanceRest wraps it
          px = parseFloat(bk.data?.askPrice || bk.data?.bidPrice || 0);
        }
      }
    } catch (e) { /* skip */ }
    if (!px || isNaN(px)) {
      // fallback: use the sellPx from the trade (the price it was sold at)
      px = parseFloat(t.sellAvgPrice || t.sellPrice || t.buyPrice || 0);
    }
    const qty = parseFloat(t.buyFilledQty || t.buyQty || t.totalQty || 0);
    const cost = qty * px;
    totalCost += cost;
    idx++;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`\nEstimated re-buy cost (${trades.length} trades): ${totalCost.toFixed(2)} USDT`);

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
