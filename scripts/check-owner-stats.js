'use strict';

// FIX-2026-09-17: read owner DB AppConfig orphanRecoveryLastStats (mirrors check-faiz-stats.js)
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/onepercentbottrade';

const m = require('../src/db/connection');
const AppConfig = require('../src/db/models/AppConfig');

(async () => {
  await m.connect();
  const cfg = await AppConfig.findOne(
    { key: 'singleton' },
    { orphanRecoveryLastStats: 1, orphanRecoveryLastRunAt: 1, orphanSellMaxAgeHours: 1, auv2Enabled: 1 }
  ).lean();
  console.log(JSON.stringify(cfg, null, 2));
  await m.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
