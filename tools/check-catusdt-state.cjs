'use strict';
require('dotenv').config();
const mongoose = require('../src/db/connection');
const Bot = require('../src/db/models/Bot');

(async () => {
  try {
    await mongoose.connect();
    const cats = await Bot.find({ symbol: '1000CATUSDT' }).lean();
    console.log(JSON.stringify({
      count: cats.length,
      bots: cats.map(b => ({
        botId: String(b._id),
        status: b.status,
        enabled: b.enabled,
        buyOrderId: b.buyOrderId,
        sellOrderId: b.sellOrderId,
        buyFilledAt: b.buyFilledAt,
        lastSellPrice: b.lastSellPrice,
        orphanBuyRecoveryCount: b.orphanBuyRecoveryCount,
        autoPauseReason: b.autoPauseReason,
        lastSellReconcileAt: b.lastSellReconcileAt,
        sellAt: b.sellAt,
        deletedAt: b.deletedAt,
        tpTarget: b.tpTarget,
      })),
    }, null, 2));
  } catch (e) {
    console.error('ERR:', e.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
})();
