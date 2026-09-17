'use strict';

// FIX-2026-09-17 EMERGENCY RECOVERY — list all orphan_recovery_sweeper trades
// Args: --faiz or --owner (default owner)

const mongoose = require('mongoose');
const arg = process.argv[2] || '--owner';
const URI = arg === '--faiz'
  ? 'mongodb://127.0.0.1:27017/onepercentbottrade_faiz'
  : 'mongodb://127.0.0.1:27017/onepercentbottrade';

(async () => {
  await mongoose.connect(URI);
  const trades = await mongoose.connection.collection('trades')
    .find({ sellReason: 'orphan_recovery_sweeper' })
    .sort({ sellReasonAt: 1 })
    .toArray();
  console.log(`\n=== ${arg.replace('--', '')}: ${trades.length} trades with sellReason='orphan_recovery_sweeper' ===\n`);
  let totalPnl = 0;
  for (const t of trades) {
    totalPnl += (t.realizedPnl || 0);
    console.log(`  ${t.symbol.padEnd(20)} botId=${String(t.botId).padEnd(28)} buyQty=${String(t.buyQty || t.buyFilledQty).padStart(12)}  buyPrice=${String(t.buyPrice || '').padEnd(14)}  targetSell=${String(t.targetSellPrice || '').padEnd(12)}  soldQty=${String(t.soldQty || '').padStart(12)}  sellPx=${String(t.sellPrice || t.avgSellPrice || '').padEnd(12)}  pnl=${(t.realizedPnl || 0).toFixed(4).padStart(10)}`);
  }
  console.log(`\n  TOTAL PnL: ${totalPnl.toFixed(4)} USDT\n`);
  // Also dump one full record so we can see all available fields
  if (trades.length > 0) {
    console.log('=== sample record keys ===');
    console.log(Object.keys(trades[0]).sort().join(', '));
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
