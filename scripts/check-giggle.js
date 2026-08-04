const mongoose = require('mongoose');
const config = require('../config');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');

(async () => {
  await mongoose.connect(config.mongoUri);
  const bot = await Bot.findOne({ symbol: 'GIGGLEUSDT' }).lean();
  if (!bot) { console.log('NO BOT'); process.exit(0); }
  console.log('=== BOT ===');
  console.log({
    _id: bot._id.toString(),
    name: bot.name,
    enabled: bot.enabled,
    stopLossOnUpperKC: bot.stopLossOnUpperKC,
    autoArmStopLossOnUKC: bot.autoArmStopLossOnUKC,
    autoArmLossPct: bot.autoArmLossPct,
    autoArmAgeHours: bot.autoArmAgeHours,
    slUkcTriggerOnProfit: bot.slUkcTriggerOnProfit,
    tpTrendMultiplier: bot.tpTrendMultiplier,
    tpPercent: bot.tpPercent,
    dcaEnabled: bot.dcaEnabled,
    timeframe: bot.timeframe,
    lastClose: bot.lastClose,
    kcMult: bot.kcMult,
    emaState: bot.emaState,
    lastSignalAt: bot.lastSignalAt,
    activePositionsCount: bot.activePositionsCount,
    warning: bot.warning,
    lastError: bot.lastError,
    cbEnabled: bot.cbEnabled,
  });
  const trades = await Trade.find({ botId: bot._id, state: { $in: ['selling','filled','partial_wait','partial_sell_wait','holding','retrying','stopping'] } }).lean();
  console.log('\n=== OPEN TRADES === count=' + trades.length);
  for (const t of trades) {
    console.log({
      _id: t._id.toString(),
      state: t.state,
      side: t.side,
      buyPrice: t.buyPrice,
      buyFilledAt: t.buyFilledAt,
      buyQty: t.buyQty,
      sellQty: t.sellQty,
      targetSellPrice: t.targetSellPrice,
      useStopLossOnUKC: t.useStopLossOnUKC,
      autoArmedAt: t.autoArmedAt,
      autoArmLossPct: t.autoArmLossPct,
      autoArmAgeHours: t.autoArmAgeHours,
      sellReason: t.sellReason,
      sellOrderId: t.sellOrderId,
      isDcaStack: t.isDcaStack,
      stackBep: t.stackBep,
      stackTotalQty: t.stackTotalQty,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      ageHours: t.buyFilledAt ? ((Date.now() - new Date(t.buyFilledAt).getTime()) / 3600000).toFixed(2) : null,
    });
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });