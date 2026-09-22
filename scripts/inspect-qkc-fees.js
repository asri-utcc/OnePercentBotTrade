'use strict';
const fs = require('fs');
const path = require('path');
const envContent = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/onepercentbottrade';
const crypto = require('crypto');
const https = require('https');
const qs = require('querystring');

(async () => {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;

  async function signedRequest(method, path, params = {}) {
    params.timestamp = Date.now();
    params.recvWindow = 5000;
    const query = qs.stringify(params);
    const signature = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
    const url = `https://api.binance.com${path}?${query}&signature=${signature}`;
    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method,
        headers: { 'X-MBX-APIKEY': apiKey },
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve({ raw: data, statusCode: res.statusCode }); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  // Get full myTrades detail for the BUY and SELL orders
  const myTrades = await signedRequest('GET', '/api/v3/myTrades', { symbol: 'QKCUSDT', limit: 20 });
  const relevant = myTrades.filter(t => [445243616, 445243638].includes(t.orderId));
  console.log('=== Relevant myTrades for QKCUSDT ===');
  let totalFeeUsdt = 0;
  let buyProceedsUsdt = 0;
  let sellProceedsUsdt = 0;
  for (const t of relevant) {
    const quoteQty = parseFloat(t.price) * parseFloat(t.qty);
    let feeUsdt = parseFloat(t.commission);
    if (t.commissionAsset !== 'USDT' && t.commissionAsset !== 'BNB') {
      console.log(`  ${new Date(t.time).toISOString()} ${t.isBuyer ? 'BUY ' : 'SELL'} ${t.qty} @ ${t.price} orderId=${t.orderId} fee=${t.commission} ${t.commissionAsset}`);
    } else if (t.commissionAsset === 'BNB') {
      // BNB fee — need to convert to USDT (use ~600 USDT/BNB as approx)
      feeUsdt = parseFloat(t.commission) * 600;
    }
    console.log(`  ${new Date(t.time).toISOString()} ${t.isBuyer ? 'BUY ' : 'SELL'} ${t.qty} @ ${t.price} orderId=${t.orderId} commission=${t.commission} ${t.commissionAsset} (=${feeUsdt.toFixed(6)} USDT)`);
    if (t.isBuyer) buyProceedsUsdt = parseFloat(t.price) * parseFloat(t.qty);
    else sellProceedsUsdt = parseFloat(t.price) * parseFloat(t.qty);
    totalFeeUsdt += feeUsdt;
  }

  console.log('\n=== PnL computation ===');
  console.log(`  BUY  cost: ${buyProceedsUsdt.toFixed(6)} USDT`);
  console.log(`  SELL proceeds: ${sellProceedsUsdt.toFixed(6)} USDT`);
  console.log(`  Gross PnL: ${(sellProceedsUsdt - buyProceedsUsdt).toFixed(6)} USDT`);
  console.log(`  Total fees: ${totalFeeUsdt.toFixed(6)} USDT`);
  console.log(`  Net PnL: ${(sellProceedsUsdt - buyProceedsUsdt - totalFeeUsdt).toFixed(6)} USDT`);
  console.log(`  Net PnL pct: ${((sellProceedsUsdt - buyProceedsUsdt - totalFeeUsdt) / buyProceedsUsdt * 100).toFixed(4)}%`);

  // Look at how bot's other win trades had realizedPnl computed
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);
  const Trade = require('../src/db/models/Trade');
  const winTrades = await Trade.find({ botId: '6a9feb931385620104b53b3d', state: 'sold' }).sort({ sellFilledAt: -1 }).limit(4).lean();
  console.log('\n=== Previous win trades (for realizedPnl format reference) ===');
  for (const w of winTrades) {
    console.log(`  tradeId=${w._id} symbol=${w.symbol} buyPrice=${w.buyPrice} sellPrice=${w.sellPrice} realizedPnl=${w.realizedPnl} pnlPercent=${w.pnlPercent} buyQty=${w.buyQty} sellQty=${w.sellQty} fees=${w.feeUsdt||w.totalFee||'-'}`);
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
