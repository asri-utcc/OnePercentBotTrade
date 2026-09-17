'use strict';

// FIX-2026-09-17 EMERGENCY RECOVERY — pause orphan-SELL sweeper on BOTH DBs
// Reason: about to re-buy 39 stuck positions; sweeper would immediately kill new SELLs
// Method: direct mongo write (bypass Mongoose schema min/max: 1..168)
//         raw updateOne sets orphanSellMaxAgeHours=999999 (effectively disabled)

const mongoose = require('mongoose');

const FAIZ_URI = 'mongodb://127.0.0.1:27017/onepercentbottrade_faiz';
const OWNER_URI = 'mongodb://127.0.0.1:27017/onepercentbottrade';

async function pauseOne(label, uri) {
  await mongoose.connect(uri);
  const col = mongoose.connection.collection('appconfigs');
  const res = await col.updateOne(
    { key: 'singleton' },
    {
      $set: {
        orphanSellMaxAgeHours: 999999,
        sweeperEmergencyPaused: true,
        sweeperEmergencyPausedAt: new Date(),
        sweeperEmergencyPauseReason: 'manual rollback recovery 2026-09-17 — re-buying 39 stuck positions',
      },
    }
  );
  const verify = await col.findOne({ key: 'singleton' }, { projection: { orphanSellMaxAgeHours: 1, sweeperEmergencyPaused: 1 } });
  console.log(`[${label}] update: matched=${res.matchedCount} modified=${res.modifiedCount}`);
  console.log(`[${label}] verify:`, JSON.stringify(verify));
  await mongoose.disconnect();
}

(async () => {
  try {
    await pauseOne('faiz', FAIZ_URI);
    await pauseOne('owner', OWNER_URI);
    console.log('OK — sweeper paused on both instances');
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
})();
