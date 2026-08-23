const mongoose = require('mongoose');
const config = require('../config');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');

(async () => {
  await mongoose.connect(config.mongoUri);

  console.log('=== ALL OPEN SELLING TRADES ===');
  const trades = await Trade.find({
    state: { $in: ['selling', 'filled', 'partial_sell_wait'] },
  }).lean();

  for (const t of trades) {
    const bot = await Bot.findById(t.botId).lean();
    if (!bot) continue;
    const ageHours = t.buyFilledAt ? ((Date.now() - new Date(t.buyFilledAt).getTime()) / 3600000).toFixed(2) : '?';
    const lossPct = t.buyPrice ? (((t.buyPrice - 0) / t.buyPrice) * 100).toFixed(2) : '?';
    console.log(JSON.stringify({
      symbol: t.symbol,
      botName: bot.name,
      tf: bot.timeframe,
      botEnabled: bot.enabled,
      botStopLossOnUpperKC: bot.stopLossOnUpperKC,
      botAutoArmStopLossOnUKC: bot.autoArmStopLossOnUKC,
      botSlUkcTriggerOnProfit: bot.slUkcTriggerOnProfit,
      tradeId: t._id.toString(),
      state: t.state,
      buyPrice: t.buyPrice,
      targetSellPrice: t.targetSellPrice,
      sellQty: t.sellQty,
      ageHours,
      useStopLossOnUKC: t.useStopLossOnUKC,
      autoArmedAt: t.autoArmedAt,
      sellOrderId: t.sellOrderId,
      updatedAt: t.updatedAt,
    }));
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });