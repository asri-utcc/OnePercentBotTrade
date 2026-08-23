'use strict';
const mongoose = require('mongoose');
const Bot = require('./src/db/models/Bot');
const AppConfig = require('./src/db/models/AppConfig');

(async () => {
  try {
    require('dotenv').config();
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/onepercentbottrade');

    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    console.log('=== AppConfig ===');
    console.log('cbVersion:', cfg?.cbVersion || '(unset → fallback default v3)');
    console.log('masterCbAutoUnlockEnabled:', cfg?.masterCbAutoUnlockEnabled);
    console.log('');

    const botsWithCbv3 = await Bot.find({
      $or: [
        { cbv3LastFiredAt: { $ne: null } },
        { cbv3LockedUntil: { $ne: null } },
        { cbv3LockReason: { $ne: null } },
      ],
    }, 'name symbol timeframe cbv3Enabled cbv3LockHours cbv3LockedUntil cbv3LockReason cbv3LastFiredAt enabled dcaEnabled').lean();

    console.log('=== Bots with CBv3 fields populated ===');
    console.log('Count:', botsWithCbv3.length);
    const now = Date.now();
    botsWithCbv3.forEach((b) => {
      const lockMsLeft = b.cbv3LockedUntil ? new Date(b.cbv3LockedUntil).getTime() - now : null;
      const stillLocked = lockMsLeft && lockMsLeft > 0;
      console.log(`  ${b.name || b._id} | ${b.symbol} | ${b.timeframe} | enabled=${b.enabled} | dca=${b.dcaEnabled}`);
      console.log(`    cbv3Enabled=${b.cbv3Enabled} | cbv3LockHours=${b.cbv3LockHours}`);
      console.log(`    cbv3LastFiredAt=${b.cbv3LastFiredAt?.toISOString() || 'null'}`);
      console.log(`    cbv3LockedUntil=${b.cbv3LockedUntil?.toISOString() || 'null'} (${stillLocked ? '🟢 ACTIVE ' + Math.round(lockMsLeft / 60000) + 'min left' : 'expired'})`);
      console.log(`    cbv3LockReason=${b.cbv3LockReason || 'null'}`);
    });

    const total = await Bot.countDocuments({});
    const enabled = await Bot.countDocuments({ enabled: { $ne: false } });
    const disabled = await Bot.countDocuments({ enabled: false });
    console.log('');
    console.log('=== Bot population ===');
    console.log('Total bots:', total, '| Enabled:', enabled, '| Disabled:', disabled);
    console.log('cbv3Enabled=true:', await Bot.countDocuments({ cbv3Enabled: true }));
    console.log('cbv3Enabled=false:', await Bot.countDocuments({ cbv3Enabled: false }));
    console.log('cbv3Enabled=null/undef:', await Bot.countDocuments({ cbv3Enabled: { $in: [null, undefined] } }));
    console.log('cbv3LockHours set:', await Bot.countDocuments({ cbv3LockHours: { $ne: null, $exists: true } }));

    // CBv2 fires (for comparison)
    const cbv2Fires = await Bot.countDocuments({ cbv2LastFiredAt: { $ne: null } });
    const cbv2Active = await Bot.countDocuments({ cbv2LockedUntil: { $gt: new Date() } });
    console.log('');
    console.log('=== CBv2 baseline ===');
    console.log('Total CBv2 fires (cbv2LastFiredAt set):', cbv2Fires);
    console.log('Currently CBv2-locked:', cbv2Active);

    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();