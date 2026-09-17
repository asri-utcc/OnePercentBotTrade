'use strict';

// FIX-2026-09-17 EMERGENCY RECOVERY — check USDT balance + total estimated cost
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
  // Get USDT balance
  const acc = await binanceRest.getAccount({}, { critical: true }).catch((e) => null);
  if (!acc) { console.error('getAccount failed'); process.exit(1); }
  const usdt = (acc.balances || []).find((b) => b.asset === 'USDT');
  const usdtFree = parseFloat(usdt?.free || 0);
  const usdtLocked = parseFloat(usdt?.locked || 0);
  console.log(`\n=== ${arg.replace('--', '')} Binance USDT balance ===`);
  console.log(`  Free: ${usdtFree.toFixed(4)}`);
  console.log(`  Locked: ${usdtLocked.toFixed(4)}`);
  console.log(`  Total: ${(usdtFree + usdtLocked).toFixed(4)}\n`);

  // Compute estimated cost for re-buying the 38 (excluding dust ones)
  await mongoose.connect(process.env.MONGODB_URI);
  const trades = await mongoose.connection.collection('trades')
    .find({ sellReason: 'orphan_recovery_sweeper' })
    .toArray();
  console.log(`=== Estimated re-buy cost for ${trades.length} positions ===\n`);
  // We need current prices. Use bookTicker for symbol
  const symbols = [...new Set(trades.map((t) => t.symbol))];
  const prices = {};
  for (const sym of symbols) {
    try {
      const t = await binanceRest.getBookTicker({ symbol: sym }, { critical: false });
      prices[sym] = parseFloat(t.askPrice || t.bidPrice || 0);
    } catch (e) {
      prices[sym] = 0;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  let totalCost = 0;
  let affordable = 0;
  let expensive = 0;
  for (const t of trades) {
    const qty = parseFloat(t.buyFilledQty || t.buyQty || t.totalQty || 0);
    const px = prices[t.symbol] || 0;
    const cost = qty * px;
    totalCost += cost;
    if (cost >= 5) affordable++; else expensive++;
    console.log(`  ${t.symbol.padEnd(20)} qty=${String(qty).padStart(12)} @ ask=${px.toString().padEnd(12)} ≈ ${cost.toFixed(4)} USDT`);
  }
  console.log(`\n  TOTAL estimated cost: ${totalCost.toFixed(4)} USDT`);
  console.log(`  Affordable (>=5 USDT): ${affordable}`);
  console.log(`  Dust (<5 USDT): ${expensive}\n`);

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
