'use strict';

// FIX-2026-08-03: One-shot migration — add DCA + Martingale sizing fields to Bot
//   - Bot:  add martingaleEnabled=false, martingaleMultiplier=1.5, martingaleMaxLayerNotional=100
//   - backward compatible: martingaleEnabled=false default → existing behavior 100% unchanged
//   - existing DCA bots (dcaEnabled=true) keep working with fixed capitalPerTrade per layer
//
// Usage (with pm2 STOPPED to avoid race):
//   pm2 stop onepercentbot
//   node scripts/migrate-martingale-fields.js
//   pm2 start onepercentbot
//
// Idempotent — re-running is safe (uses $exists gate).
// Rollback support: node scripts/migrate-martingale-fields.js --rollback

const path = require('path');
const mongoose = require('mongoose');

// Load .env manually (avoid pulling full app boot)
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {
  // dotenv optional — env vars may already be set
}

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/onepercentbottrade';
const Bot = require('../src/db/models/Bot');

const ROLLBACK = process.argv.includes('--rollback');

(async () => {
  await mongoose.connect(MONGO_URI);
  console.log(`[migrate-martingale-fields] connected: ${MONGO_URI}`);
  console.log(`[migrate-martingale-fields] mode: ${ROLLBACK ? 'ROLLBACK' : 'APPLY'}`);

  if (ROLLBACK) {
    // Rollback: drop the 3 Martingale fields (purely additive removal — no data loss of original fields)
    const r = await Bot.updateMany(
      { martingaleEnabled: { $exists: true } },
      { $unset: { martingaleEnabled: '', martingaleMultiplier: '', martingaleMaxLayerNotional: '' } }
    );
    console.log(`[migrate-martingale-fields] ROLLBACK: dropped martingale fields on ${r.modifiedCount} docs`);

    const totalBots = await Bot.countDocuments({});
    const withFields = await Bot.countDocuments({ martingaleEnabled: { $exists: true } });
    console.log(`[migrate-martingale-fields] verify (rollback): totalBots=${totalBots} stillHasFields=${withFields}`);

    console.log(JSON.stringify({
      mode: 'rollback',
      modified: r.modifiedCount,
      verify: { totalBots, stillHasFields: withFields },
    }));
  } else {
    // Apply: add Martingale defaults (idempotent $exists gate)
    const r1 = await Bot.updateMany(
      { martingaleEnabled: { $exists: false } },
      { $set: {
        martingaleEnabled: false,
        martingaleMultiplier: 1.5,
        martingaleMaxLayerNotional: 100,
      } }
    );
    console.log(`[migrate-martingale-fields] Bot.martingale fields: set defaults on ${r1.modifiedCount} docs`);

    // Verification: count bots by martingaleEnabled
    const totalBots = await Bot.countDocuments({});
    const martingaleOn = await Bot.countDocuments({ martingaleEnabled: true });
    const martingaleOff = await Bot.countDocuments({ martingaleEnabled: false });
    const legacyMissing = await Bot.countDocuments({ martingaleEnabled: { $exists: false } });

    console.log(`[migrate-martingale-fields] verify: totalBots=${totalBots} martingaleOn=${martingaleOn} martingaleOff=${martingaleOff} legacyMissingFields=${legacyMissing}`);

    // Sanity check: every bot with martingaleEnabled=true should also have dcaEnabled=true
    const inconsistent = await Bot.countDocuments({ martingaleEnabled: true, dcaEnabled: { $ne: true } });
    if (inconsistent > 0) {
      console.warn(`[migrate-martingale-fields] WARNING: ${inconsistent} bots have martingaleEnabled=true but dcaEnabled!=true — should be impossible with new validation, but flagging for manual review`);
    }

    console.log(JSON.stringify({
      mode: 'apply',
      bots_defaults_set: r1.modifiedCount,
      verify: { totalBots, martingaleOn, martingaleOff, legacyBots: legacyMissing, inconsistentMartingaleNoDca: inconsistent },
    }));
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('[migrate-martingale-fields] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
