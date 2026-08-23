'use strict';
// FIX-2026-08-09: Migrate CBv3 fields — backfill bots with cbv3Enabled + cbv3LockHours
//   - Background: Bot.js schema was missing cbv3Enabled + cbv3LockHours fields
//   - Mongoose strict mode silently dropped them on save → bot-edit.js UI was
//     "checking/unchecking" but the value never persisted
//   - This migration adds the fields with default values (true / 8 hours) to
//     all existing bots that don't have them yet
//   - IDEMPOTENT: $set with $exists:false guard — re-running is safe
//
// Usage: node scripts/migrate-cbv3-fields.js [--dry-run]

require('dotenv').config();
const mongoose = require('mongoose');
const Bot = require('../src/db/models/Bot');

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`🔧 CBv3 fields migration (${dryRun ? 'DRY-RUN' : 'LIVE'})`);

  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/onepercentbottrade');

    // Count bots that need migration
    const needsCbv3Enabled = await Bot.countDocuments({ cbv3Enabled: { $exists: false } });
    const needsCbv3LockHours = await Bot.countDocuments({ cbv3LockHours: { $exists: false } });
    console.log(`   Bots without cbv3Enabled: ${needsCbv3Enabled}`);
    console.log(`   Bots without cbv3LockHours: ${needsCbv3LockHours}`);

    if (needsCbv3Enabled === 0 && needsCbv3LockHours === 0) {
      console.log('✅ All bots already have CBv3 fields — nothing to migrate');
      await mongoose.disconnect();
      return;
    }

    if (dryRun) {
      console.log('🔍 DRY-RUN: would backfill both fields (cbv3Enabled=true, cbv3LockHours=8)');
      await mongoose.disconnect();
      return;
    }

    // Backfill cbv3Enabled = true (only if missing)
    const r1 = await Bot.updateMany(
      { cbv3Enabled: { $exists: false } },
      { $set: { cbv3Enabled: true } },
    );
    console.log(`   ✅ cbv3Enabled backfilled: matched=${r1.matchedCount} modified=${r1.modifiedCount}`);

    // Backfill cbv3LockHours = 8 (only if missing)
    const r2 = await Bot.updateMany(
      { cbv3LockHours: { $exists: false } },
      { $set: { cbv3LockHours: 8 } },
    );
    console.log(`   ✅ cbv3LockHours backfilled: matched=${r2.matchedCount} modified=${r2.modifiedCount}`);

    // Verify
    const stillNeedsEnabled = await Bot.countDocuments({ cbv3Enabled: { $exists: false } });
    const stillNeedsLockHours = await Bot.countDocuments({ cbv3LockHours: { $exists: false } });
    console.log(`   Post-migration: ${stillNeedsEnabled} bots still missing cbv3Enabled, ${stillNeedsLockHours} bots still missing cbv3LockHours`);

    await mongoose.disconnect();
    console.log('✅ Migration complete');
  } catch (err) {
    console.error('Fatal:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
