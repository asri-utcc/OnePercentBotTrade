'use strict';

// Dump all faiz trade history relevant to the incident
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const envPath = path.join(__dirname, '..', '.env.faiz');
const envContent = fs.readFileSync(envPath, 'utf8');
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/onepercentbottrade_faiz';

const OPEN_STATES = ['placed', 'filled', 'holding', 'retrying', 'selling', 'partial_sell_wait', 'partial_wait'];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.collection('trades');
  const all = await col.find({}).sort({ createdAt: -1 }).toArray();
  const orphans = all.filter((t) => t.sellReason === 'orphan_recovery_sweeper');
  const opens = all.filter((t) => OPEN_STATES.includes(t.state));
  const manualClosed = all.filter((t) => t.sellReason === 'manual_close_pre_recovery_2026-09-17');
  const sold = all.filter((t) => t.state === 'sold');

  console.log(`\n=========== FAIZ TRADE HISTORY (full DB dump) ===========\n`);
  console.log(`Total trades: ${all.length}`);
  console.log(`  orphan_recovery_sweeper: ${orphans.length}`);
  console.log(`  open (state in OPEN_STATES): ${opens.length}`);
  console.log(`  manual_close_pre_recovery_2026-09-17: ${manualClosed.length}`);
  console.log(`  sold (any): ${sold.length}`);
  console.log();

  console.log(`\n===== A. orphan_recovery_sweeper (${orphans.length}) — these need BUY-back + SELL re-place =====\n`);
  console.log('symbol           state     qty         buyPrice    targetSellPrice  realizedPnl  sellFilledAt');
  console.log('─'.repeat(110));
  let pnlSum = 0;
  for (const t of orphans) {
    const qty = t.buyFilledQty || t.buyQty || t.totalQty || 0;
    pnlSum += parseFloat(t.realizedPnl || 0);
    console.log(
      `${(t.symbol || '?').padEnd(16)} ${(t.state || '?').padEnd(9)} ${String(qty).padStart(10)}  ${(parseFloat(t.buyPrice || 0)).toFixed(6).padStart(11)}  ${(parseFloat(t.targetSellPrice || 0)).toFixed(6).padStart(14)}  ${(parseFloat(t.realizedPnl || 0)).toFixed(4).padStart(11)}  ${(t.sellFilledAt ? new Date(t.sellFilledAt).toISOString().slice(0, 19) : '-').padEnd(19)}`
    );
  }
  console.log(`\n  Σ realizedPnl = ${pnlSum.toFixed(4)} USDT`);

  console.log(`\n===== B. open positions (${opens.length}) — currently OPEN (after pre-recovery close) =====\n`);
  console.log('symbol           state              qty         sellOrderId   sellPrice    sellReason');
  console.log('─'.repeat(110));
  for (const t of opens) {
    const qty = t.buyFilledQty || t.buyQty || t.totalQty || 0;
    console.log(
      `${(t.symbol || '?').padEnd(16)} ${(t.state || '?').padEnd(17)} ${String(qty).padStart(10)}  ${String(t.sellOrderId || '-').padStart(13)}  ${(parseFloat(t.sellPrice || 0)).toFixed(6).padStart(11)}  ${(t.sellReason || '-').slice(0, 30)}`
    );
  }

  console.log(`\n===== C. manual_close_pre_recovery_2026-09-17 (${manualClosed.length}) — pre-recovery closes =====\n`);
  console.log('symbol           buyPrice    sellAvgPrice  qty         realizedPnl  sellFilledAt');
  console.log('─'.repeat(110));
  for (const t of manualClosed) {
    const qty = t.sellFilledQty || t.buyFilledQty || t.buyQty || 0;
    console.log(
      `${(t.symbol || '?').padEnd(16)} ${(parseFloat(t.buyPrice || 0)).toFixed(6).padStart(11)}  ${(parseFloat(t.sellAvgPrice || 0)).toFixed(6).padStart(12)}  ${String(qty).padStart(10)}  ${(parseFloat(t.realizedPnl || 0)).toFixed(4).padStart(11)}  ${(t.sellFilledAt ? new Date(t.sellFilledAt).toISOString().slice(0, 19) : '-').padEnd(19)}`
    );
  }

  console.log(`\n===== D. all other SOLD trades (${sold.length - orphans.length - manualClosed.length}) — recent 20 =====\n`);
  const others = sold.filter((t) => t.sellReason !== 'orphan_recovery_sweeper' && t.sellReason !== 'manual_close_pre_recovery_2026-09-17')
    .sort((a, b) => new Date(b.sellFilledAt || 0) - new Date(a.sellFilledAt || 0))
    .slice(0, 20);
  console.log('symbol           buyPrice    sellAvgPrice  qty         realizedPnl  sellFilledAt             sellReason');
  console.log('─'.repeat(120));
  for (const t of others) {
    const qty = t.sellFilledQty || t.buyFilledQty || t.buyQty || 0;
    console.log(
      `${(t.symbol || '?').padEnd(16)} ${(parseFloat(t.buyPrice || 0)).toFixed(6).padStart(11)}  ${(parseFloat(t.sellAvgPrice || 0)).toFixed(6).padStart(12)}  ${String(qty).padStart(10)}  ${(parseFloat(t.realizedPnl || 0)).toFixed(4).padStart(11)}  ${(t.sellFilledAt ? new Date(t.sellFilledAt).toISOString().slice(0, 19) : '-').padEnd(19)}  ${(t.sellReason || '-').slice(0, 30)}`
    );
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
