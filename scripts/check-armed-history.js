const mongoose = require('mongoose');
const config = require('../config');
const Trade = require('../src/db/models/Trade');

(async () => {
  await mongoose.connect(config.mongoUri);

  // All trades ever marked as armed
  console.log('=== ALL TRADES with useStopLossOnUKC=true (any state) ===');
  const armed = await Trade.find({ useStopLossOnUKC: true }).sort({ autoArmedAt: -1 }).limit(30).lean();
  console.log('count:', armed.length);
  for (const t of armed) {
    console.log({
      symbol: t.symbol,
      state: t.state,
      buyPrice: t.buyPrice,
      sellPrice: t.targetSellPrice,
      autoArmedAt: t.autoArmedAt,
      useStopLossOnUKC: t.useStopLossOnUKC,
      sellReason: t.sellReason,
      updatedAt: t.updatedAt,
      createdAt: t.createdAt,
    });
  }

  // Check SELL_REASONS distribution
  console.log('\n=== SELL_REASONS distribution ===');
  const pipeline = [
    { $match: { sellReason: { $ne: null } } },
    { $group: { _id: '$sellReason', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ];
  const reasons = await Trade.aggregate(pipeline);
  for (const r of reasons) console.log(r);

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });