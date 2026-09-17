'use strict';
require('dotenv').config();
const mongoose = require('../src/db/connection');
const Trade = require('../src/db/models/Trade');

(async () => {
  try {
    await mongoose.connect();
    // Find all trades for 1000CATUSDT in active states
    const cats = await Trade.find({
      symbol: '1000CATUSDT',
      state: { $in: ['placed', 'filled', 'holding', 'cancelled', 'selling'] },
    }).lean();
    console.log(JSON.stringify({
      count: cats.length,
      trades: cats.map(t => ({
        tradeId: String(t._id),
        state: t.state,
        sellState: t.sellState,
        buyOrderId: t.buyOrderId,
        sellOrderId: t.sellOrderId,
        buyPrice: t.buyPrice,
        sellPrice: t.sellPrice,
        buyFilledAt: t.buyFilledAt,
        sellAt: t.sellAt,
        filledQty: t.filledQty,
        orphanBuyRecoveryCount: t.orphanBuyRecoveryCount,
        orphanBuyRecoveryAt: t.orphanBuyRecoveryAt,
        lastReconcileAt: t.lastReconcileAt,
        lastReconcileReason: t.lastReconcileReason,
      })),
    }, null, 2));

    // Also show top-N orphan-pending (no SELL alive but DB state still 'selling')
    const selling = await Trade.find({ state: 'selling' }).limit(5).lean();
    console.log('---Sample selling trades---');
    console.log(JSON.stringify(selling.map(t => ({
      tradeId: String(t._id),
      symbol: t.symbol,
      state: t.state,
      sellOrderId: t.sellOrderId,
      sellStatus: t.sellStatus,
      sellFilledAt: t.sellFilledAt,
      soldAt: t.soldAt,
    })), null, 2));

    // Counts by state
    const counts = await Trade.aggregate([
      { $match: { state: { $in: ['placed', 'filled', 'holding', 'cancelled', 'selling'] } } },
      { $group: { _id: '$state', count: { $sum: 1 } } },
    ]);
    console.log('---State counts---');
    console.log(JSON.stringify(counts, null, 2));
  } catch (e) {
    console.error('ERR:', e.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
})();
