'use strict';

// Verify final state of both instances after recovery
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

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.collection('trades');

  console.log(`\n=== ${arg.replace('--', '')} post-recovery state verification ===\n`);

  // 1. orphan_recovery_sweeper should be 0
  const orphans = await col.countDocuments({ sellReason: 'orphan_recovery_sweeper' });
  console.log(`orphan_recovery_sweeper records remaining: ${orphans} ${orphans === 0 ? '✅' : '❌'}`);

  // 2. State distribution
  const pipeline = [
    { $group: { _id: '$state', count: { $sum: 1 }, sumPnL: { $sum: { $toDouble: { $ifNull: ['$realizedPnl', 0] } } } } },
    { $sort: { _id: 1 } },
  ];
  const dist = await col.aggregate(pipeline).toArray();
  console.log(`\nState distribution:`);
  for (const d of dist) {
    console.log(`  ${d._id.padEnd(28)} ${String(d.count).padStart(4)} trades  ΣPnL=${d.sumPnL.toFixed(4)} USDT`);
  }

  // 3. Recovery-injected trades
  const recovered = await col.find({ recoveryNote: { $exists: true } }).sort({ createdAt: 1 }).toArray();
  console.log(`\n=== Recovery-injected trades: ${recovered.length} ===`);
  console.log('symbol           state                    buyPrice    buyFilledQty  sellPrice     realizedPnl');
  console.log('-'.repeat(110));
  for (const t of recovered) {
    const qty = t.buyFilledQty || t.buyQty || t.totalQty || 0;
    console.log(
      `${(t.symbol || '?').padEnd(16)} ${(t.state || '-').padEnd(23)} ${(parseFloat(t.buyPrice || 0)).toFixed(6).padStart(10)}  ${String(qty).padStart(11)}  ${(parseFloat(t.sellPrice || 0)).toFixed(6).padStart(10)}  ${(parseFloat(t.realizedPnl || 0)).toFixed(4).padStart(11)}`
    );
  }

  // 4. PnL sum check — should be ZERO across recovery-injected trades (no realized PnL recorded)
  const totalRealizedPnL = recovered.reduce((sum, t) => sum + parseFloat(t.realizedPnl || 0), 0);
  console.log(`\nΣ realizedPnl in recovery-injected trades: ${totalRealizedPnL.toFixed(4)} USDT ${Math.abs(totalRealizedPnL) < 0.01 ? '✅ (zero)' : '❌'}`);

  // 5. State totals for OPEN_STATES
  const OPEN_STATES = ['placed', 'filled', 'holding', 'retrying', 'selling', 'partial_sell_wait', 'partial_wait', 'waiting_sell_recovery', 'dust_skipped'];
  const open = await col.countDocuments({ state: { $in: OPEN_STATES } });
  console.log(`\nTotal in OPEN_STATES (+waiting_sell_recovery+dust_skipped): ${open}`);

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
