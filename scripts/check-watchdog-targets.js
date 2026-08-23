const mongoose = require('mongoose');
const config = require('../config');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');

(async () => {
  await mongoose.connect(config.mongoUri);

  const allBots = await Bot.find({}).lean();
  const selling = await Trade.find({ state: 'selling' }).lean();

  const disabledWithOpen = [];
  const enabledWithOpen = [];

  for (const t of selling) {
    const bot = allBots.find(b => String(b._id) === String(t.botId));
    if (!bot) continue;
    const ageHours = t.buyFilledAt ? ((Date.now() - new Date(t.buyFilledAt).getTime()) / 3600000).toFixed(1) : '?';
    const refPrice = t.isDcaStack && t.stackBep > 0 ? t.stackBep : t.buyPrice;
    const entry = {
      symbol: t.symbol,
      botName: bot.name,
      tf: bot.timeframe,
      botEnabled: bot.enabled,
      autoArmStopLossOnUKC: bot.autoArmStopLossOnUKC,
      autoArmLossPct: bot.autoArmLossPct,
      autoArmAgeHours: bot.autoArmAgeHours,
      buyPrice: t.buyPrice,
      stackBep: t.stackBep,
      refPrice,
      buyFilledAt: t.buyFilledAt,
      ageHours,
      useStopLossOnUKC: t.useStopLossOnUKC,
      autoArmedAt: t.autoArmedAt,
      state: t.state,
      tradeId: String(t._id),
    };
    if (bot.enabled) enabledWithOpen.push(entry);
    else disabledWithOpen.push(entry);
  }

  console.log(`=== DISABLED BOTS with open positions (${disabledWithOpen.length}) — these need WATCHDOG ===`);
  for (const e of disabledWithOpen) console.log(JSON.stringify(e));
  console.log(`\n=== ENABLED BOTS with open positions (${enabledWithOpen.length}) — handled by trader ===`);
  for (const e of enabledWithOpen) console.log(JSON.stringify(e));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
