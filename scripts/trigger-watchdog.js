const mongoose = require('mongoose');
const config = require('../config');
const positionWatchdog = require('../src/services/positionWatchdog');

(async () => {
  await mongoose.connect(config.mongoUri);
  console.log('Running watchdog runOnce()...');
  const stats = await positionWatchdog.runOnce();
  console.log('STATS:', JSON.stringify(stats, null, 2));
  console.log('STATUS:', JSON.stringify(positionWatchdog.getStatus(), null, 2));
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
