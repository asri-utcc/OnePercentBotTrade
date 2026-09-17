'use strict';

// FIX-2026-09-17 EMERGENCY RECOVERY — list currently open positions
// (excluding the 38 orphan_recovery_sweeper ones which are already sold)

const mongoose = require('mongoose');
const arg = process.argv[2] || '--owner';
const URI = arg === '--faiz'
  ? 'mongodb://127.0.0.1:27017/onepercentbottrade_faiz'
  : 'mongodb://127.0.0.1:27017/onepercentbottrade';

(async () => {
  await mongoose.connect(URI);
  const OPEN_STATES = ['placed', 'filled', 'holding', 'retrying', 'selling', 'partial_sell_wait', 'partial_wait'];
  const trades = await mongoose.connection.collection('trades')
    .find({ state: { $in: OPEN_STATES } })
    .sort({ symbol: 1 })
    .toArray();
  console.log(`\n=== ${arg.replace('--', '')}: ${trades.length} currently OPEN positions ===\n`);
  // Group by symbol, show qty + sellOrderId status
  for (const t of trades) {
    console.log(`  ${t.symbol.padEnd(20)} state=${(t.state || '').padEnd(10)} qty=${String(t.buyQty || t.buyFilledQty || t.totalQty || '?').padStart(12)}  sellOrderId=${String(t.sellOrderId || '(none)').padEnd(15)}  botId=${String(t.botId).slice(-8)}`);
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
