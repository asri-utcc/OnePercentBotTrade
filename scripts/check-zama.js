const mongoose = require('mongoose');
const config = require('../config');
const Bot = require('../src/db/models/Bot');

(async () => {
  await mongoose.connect(config.mongoUri);
  const zama = await Bot.findOne({ symbol: 'ZAMAUSDT' }).lean();
  console.log('ZAMA bot:', JSON.stringify({
    name: zama.name, symbol: zama.symbol, enabled: zama.enabled,
    autoArmStopLossOnUKC: zama.autoArmStopLossOnUKC,
    autoArmLossPct: zama.autoArmLossPct,
    autoArmAgeHours: zama.autoArmAgeHours,
    stopLossOnUpperKC: zama.stopLossOnUpperKC,
    keys: Object.keys(zama).filter(k => k.toLowerCase().includes('arm') || k.toLowerCase().includes('slukc')),
  }));
  await mongoose.disconnect();
})();
