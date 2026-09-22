'use strict';
const fs = require('fs');
const path = require('path');
const envContent = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/onepercentbottrade';
const binanceRest = require('../src/binance/binanceRest');

(async () => {
  // 1. Check buyOrder 445243616 — should be FILLED according to DB
  console.log('\n=== 1. Binance getOrder buyOrderId=445243616 ===');
  const buyOrder = await binanceRest.getOrder({ symbol: 'QKCUSDT', orderId: 445243616 }, { critical: true }).catch((e) => ({ error: e.message }));
  console.log(JSON.stringify(buyOrder, null, 2));

  // 2. Get myTrades for QKCUSDT to find actual fills
  console.log('\n=== 2. Binance myTrades for QKCUSDT ===');
  const myTrades = await binanceRest.myTrades({ symbol: 'QKCUSDT', limit: 20 }, { critical: true }).catch((e) => ({ error: e.message }));
  if (Array.isArray(myTrades)) {
    myTrades.forEach(t => {
      console.log(`  ${t.time} ${t.isBuyer ? 'BUY ' : 'SELL'} ${t.qty} QKC @ ${t.price} (orderId=${t.orderId}, commission=${t.commission} ${t.commissionAsset})`);
    });
  } else {
    console.log(JSON.stringify(myTrades, null, 2));
  }

  // 3. Get all orders for QKCUSDT (recent)
  console.log('\n=== 3. Binance allOrders for QKCUSDT (last 20) ===');
  const allOrders = await binanceRest.getAllOrders({ symbol: 'QKCUSDT', limit: 20 }, { critical: true }).catch((e) => ({ error: e.message }));
  if (Array.isArray(allOrders)) {
    allOrders.forEach(o => {
      console.log(`  ${new Date(o.time).toISOString()} ${o.side} ${o.type} ${o.status} qty=${o.executedQty}/${o.origQty} @ ${o.price} (orderId=${o.orderId})`);
    });
  } else {
    console.log(JSON.stringify(allOrders, null, 2));
  }

  // 4. Get all open orders for QKCUSDT
  console.log('\n=== 4. Open orders for QKCUSDT ===');
  const openOrders = await binanceRest.getOpenOrders({ symbol: 'QKCUSDT' }, { critical: true }).catch((e) => ({ error: e.message }));
  console.log(JSON.stringify(openOrders, null, 2));

  // 5. Get current account balance for QKC
  console.log('\n=== 5. QKC balance in account ===');
  const acc = await binanceRest.getAccount({}, { critical: true }).catch((e) => null);
  if (acc) {
    const qkc = (acc.balances || []).find(b => b.asset === 'QKC');
    console.log(`  QKC free=${qkc?.free} locked=${qkc?.locked}`);
  }

  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });