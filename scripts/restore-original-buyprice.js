'use strict';

// FIX-2026-09-17 restore ORIGINAL buyPrice on recovery-injected trades
// User feedback: %PnL ต้องคำนวณจากราคาซื้อดั้งเดิม (ก่อน force-close) ไม่ใช่ราคาในรอบ restore
//
// Approach: query Binance getMyTrades for each symbol, find BUY at original time
// (recoveryOriginalTradeCreatedAt), update the trade's buyPrice.

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
const config = require('../config');
const axios = require('axios');

// Inline myTrades — binanceRest doesn't export it
const http = axios.create({
  baseURL: config.binance.base || 'https://api.binance.com',
  timeout: 15000,
  headers: { 'X-MBX-APIKEY': config.binance.apiKey },
});

async function myTrades({ symbol, startTime, endTime, limit = 1000 } = {}) {
  const params = { symbol };
  if (startTime) params.startTime = startTime;
  if (endTime) params.endTime = endTime;
  if (limit) params.limit = limit;
  // Sign with recvWindow + timestamp
  const qs = binanceRest.signQuery({
    ...params,
    recvWindow: config.binance.recvWindow,
    timestamp: binanceRest.nowMsBinance(),
  });
  const url = `/api/v3/myTrades?${qs}`;
  const r = await http.get(url);
  return r.data;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.collection('trades');

  const trades = await col.find({ recoveryOriginalId: { $exists: true } }).sort({ symbol: 1 }).toArray();
  console.log(`\n=== ${arg.replace('--', '')} restore-original-buyPrice: ${trades.length} recovery-injected trades ===\n`);

  // Group by symbol for fewer API calls (Binance myTrades returns up to 1000 per call)
  const bySymbol = {};
  for (const t of trades) (bySymbol[t.symbol] = bySymbol[t.symbol] || []).push(t);

  let updated = 0, notFound = 0, errors = 0;
  const errLog = [];

  for (const [symbol, symTrades] of Object.entries(bySymbol)) {
    process.stdout.write(`\n${symbol}: ${symTrades.length} trade(s) → fetching myTrades...`);
    let fetchedTrades;
    try {
      // Fetch all trades for this symbol from earliest recoveryOriginalTradeCreatedAt - 1 day
      const earliest = Math.min(...symTrades.map((t) => new Date(t.recoveryOriginalTradeCreatedAt).getTime()));
      const startTime = earliest - 24 * 60 * 60 * 1000; // 1 day before
      fetchedTrades = await myTrades({ symbol, startTime });
    } catch (e) {
      console.log(` ERR fetch: ${e.message}`);
      errors++;
      errLog.push({ symbol, err: e.message });
      continue;
    }

    // For each recovery-injected trade, find BUY at the right time
    for (const t of symTrades) {
      const originalCreatedMs = new Date(t.recoveryOriginalTradeCreatedAt).getTime();
      // Look for BUY trade within 5 min window
      const windowStart = originalCreatedMs - 5 * 60 * 1000;
      const windowEnd = originalCreatedMs + 5 * 60 * 1000;
      const candidates = (fetchedTrades || [])
        .filter((tr) => tr.isBuyer === true && tr.time >= windowStart && tr.time <= windowEnd);
      if (candidates.length === 0) {
        console.log(`\n  ✗ ${symbol}: no BUY found near ${new Date(originalCreatedMs).toISOString()}`);
        notFound++;
        continue;
      }
      // Use the BUY closest to the original trade creation time
      candidates.sort((a, b) => Math.abs(a.time - originalCreatedMs) - Math.abs(b.time - originalCreatedMs));
      const best = candidates[0];
      const origPrice = parseFloat(best.price);
      const origQty = parseFloat(best.qty);
      const oldPrice = parseFloat(t.buyPrice);

      console.log(`\n  ✓ ${symbol}: buyPrice ${oldPrice} → ${origPrice}  buyFilledAt → ${new Date(best.time).toISOString()}`);
      try {
        await col.updateOne(
          { _id: t._id },
          {
            $set: {
              // Update %PnL field
              buyPrice: origPrice,
              // Update position duration field — use ORIGINAL buyFilledAt so duration is accurate
              buyFilledAt: new Date(best.time),
              buyFilledQty: origQty,
              // Backup fields for audit
              originalBuyPrice: origPrice,
              originalBuyQty: origQty,
              originalBuyTime: new Date(best.time),
              originalBuyOrderId: best.orderId,
              updatedAt: new Date(),
            },
          }
        );
        updated++;
      } catch (e) {
        console.log(`     ERR update: ${e.message}`);
        errors++;
      }
    }
    await sleep(300);
  }

  console.log(`\n\n=== ${arg.replace('--', '')} restore-original-buyPrice DONE ===`);
  console.log(`  updated: ${updated}, not_found: ${notFound}, errors: ${errors}`);
  if (errLog.length > 0) {
    console.log(`\nErrors:`);
    for (const e of errLog) console.log(`  ${e.symbol}: ${e.err}`);
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
