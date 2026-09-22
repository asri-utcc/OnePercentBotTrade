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
// Need to access signedRequest directly — let's inspect module
const mod = require('module');
const binanceModPath = require.resolve('../src/binance/binanceRest');
const binanceSrc = fs.readFileSync(binanceModPath, 'utf8');
// Try direct REST call
const crypto = require('crypto');
const https = require('https');
const qs = require('querystring');

(async () => {
  // Find API key/secret from env
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) {
    console.error('API key/secret not found in env');
    process.exit(1);
  }

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

  // 1. myTrades for QKCUSDT
  console.log('\n=== 1. myTrades for QKCUSDT (last 20) ===');
  const myTrades = await signedRequest('GET', '/api/v3/myTrades', { symbol: 'QKCUSDT', limit: 20 }).catch((e) => ({ error: e.message }));
  if (Array.isArray(myTrades)) {
    myTrades.slice(0, 20).forEach(t => {
      console.log(`  ${new Date(t.time).toISOString()} ${t.isBuyer ? 'BUY ' : 'SELL'} ${t.qty} QKC @ ${t.price} orderId=${t.orderId} commission=${t.commission} ${t.commissionAsset}`);
    });
  } else {
    console.log(JSON.stringify(myTrades, null, 2));
  }

  // 2. allOrders for QKCUSDT
  console.log('\n=== 2. allOrders for QKCUSDT (last 30) ===');
  const allOrders = await signedRequest('GET', '/api/v3/allOrders', { symbol: 'QKCUSDT', limit: 30 }).catch((e) => ({ error: e.message }));
  if (Array.isArray(allOrders)) {
    allOrders.slice(0, 30).forEach(o => {
      console.log(`  ${new Date(o.time).toISOString()} ${o.side} ${o.type} ${o.status} qty=${o.executedQty}/${o.origQty} @ ${o.price} orderId=${o.orderId} clientOrderId=${o.clientOrderId}`);
    });
  } else {
    console.log(JSON.stringify(allOrders, null, 2));
  }

  // 3. account info with full balances
  console.log('\n=== 3. account balances for QKC ===');
  const acc = await signedRequest('GET', '/api/v3/account');
  if (acc && acc.balances) {
    const qkc = acc.balances.find(b => b.asset === 'QKC');
    console.log(`  QKC: free=${qkc.free} locked=${qkc.locked}`);
  }

  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });