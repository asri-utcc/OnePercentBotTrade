const mongoose = require('mongoose');
const config = require('../config');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');

(async () => {
  await mongoose.connect(config.mongoUri);
  const bot = await Bot.findOne({ symbol: 'GIGGLEUSDT' }).lean();
  if (!bot) { console.log('NO BOT'); process.exit(0); }

  const lossPct = (bot.autoArmLossPct ?? 10) / 100;
  const ageHours = bot.autoArmAgeHours ?? 4;
  const ageThresholdAgo = new Date(Date.now() - ageHours * 60 * 60 * 1000);
  console.log('=== F1 ARM QUERY PARAMS ===');
  console.log({ lossPct, ageHours, ageThresholdAgo: ageThresholdAgo.toISOString() });
  console.log('bot.autoArmStopLossOnUKC:', bot.autoArmStopLossOnUKC);
  console.log('bot._id:', bot._id.toString());

  // Try with closePrice=43.61 (recent candle close)
  const closePrice = 43.61;
  console.log('\n=== TRY 1: closePrice=43.61 ===');
  const c1 = await Trade.find({
    botId: bot._id,
    state: 'selling',
    useStopLossOnUKC: { $ne: true },
    buyFilledAt: { $lte: ageThresholdAgo },
    $expr: {
      $and: [
        { $gt: ['$buyPrice', 0] },
        { $gt: [{ $divide: [{ $subtract: ['$buyPrice', closePrice] }, '$buyPrice'] }, lossPct] },
      ],
    },
  }).lean();
  console.log('candidates:', c1.length);
  for (const t of c1) console.log(' -', t._id.toString(), t.buyPrice, t.buyFilledAt);

  // Try with closePrice=40.65 (bots.json lastClose)
  console.log('\n=== TRY 2: closePrice=40.65 ===');
  const c2 = await Trade.find({
    botId: bot._id,
    state: 'selling',
    useStopLossOnUKC: { $ne: true },
    buyFilledAt: { $lte: ageThresholdAgo },
    $expr: {
      $and: [
        { $gt: ['$buyPrice', 0] },
        { $gt: [{ $divide: [{ $subtract: ['$buyPrice', 40.65] }, '$buyPrice'] }, lossPct] },
      ],
    },
  }).lean();
  console.log('candidates:', c2.length);

  // Loose query — see all selling trades for this bot
  console.log('\n=== ALL SELLING TRADES ===');
  const all = await Trade.find({ botId: bot._id, state: 'selling' }).lean();
  console.log('count:', all.length);
  for (const t of all) {
    console.log({
      _id: t._id.toString(),
      state: t.state,
      buyPrice: t.buyPrice,
      buyFilledAt: t.buyFilledAt,
      useStopLossOnUKC: t.useStopLossOnUKC,
      autoArmedAt: t.autoArmedAt,
      sellOrderId: t.sellOrderId,
      targetSellPrice: t.targetSellPrice,
      sellQty: t.sellQty,
      sellPlacedAt: t.sellPlacedAt,
    });
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });