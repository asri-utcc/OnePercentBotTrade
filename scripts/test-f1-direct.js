const mongoose = require('mongoose');
const config = require('../config');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');
const Trader = require('../src/core/trader');

(async () => {
  await mongoose.connect(config.mongoUri);
  const botDoc = await Bot.findOne({ symbol: 'GIGGLEUSDT' });
  if (!botDoc) { console.log('NO BOT'); process.exit(0); }

  console.log('=== Bot (as trader sees it) ===');
  console.log({
    _id: botDoc._id.toString(),
    enabled: botDoc.enabled,
    autoArmStopLossOnUKC: botDoc.autoArmStopLossOnUKC,
    autoArmLossPct: botDoc.autoArmLossPct,
    autoArmAgeHours: botDoc.autoArmAgeHours,
    autoArmLossPctDefaulted: botDoc.autoArmLossPct ?? 10,
    autoArmAgeHoursDefaulted: botDoc.autoArmAgeHours ?? 4,
  });

  // Instantiate Trader (does NOT call start())
  const trader = new Trader(botDoc.toObject ? botDoc.toObject() : botDoc);

  // Construct a fake candle with realistic data (close=43.61, age=52h past)
  const candle = {
    openTime: Date.now() - 200000,
    closeTime: Date.now() - 180000,
    open: 43.5, high: 44.0, low: 43.0, close: 43.61,
    isClosed: true,
  };

  console.log('\n=== Calling _autoArmStopLossOnUKC directly ===');
  // Patch the logger to capture
  const captured = [];
  const origLogger = require('../src/utils/logger');
  origLogger.warn = (...args) => { captured.push({ level: 'warn', args }); console.log('LOG.warn:', JSON.stringify(args[1] || args[0])); };

  // Set trader.running=true so F1 doesn't early-return
  trader.running = true;
  await trader._autoArmStopLossOnUKC(candle);

  console.log('\n=== Captured warn logs:', captured.length, '===');
  for (const c of captured) console.log(c);

  // Also check DB
  const after = await Trade.findOne({ _id: '6a6d9c4d925e05951e71f43b' }).lean();
  console.log('\n=== Trade after F1 ===');
  console.log({
    useStopLossOnUKC: after.useStopLossOnUKC,
    autoArmedAt: after.autoArmedAt,
    autoArmLossPct: after.autoArmLossPct,
    autoArmAgeHours: after.autoArmAgeHours,
  });

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });