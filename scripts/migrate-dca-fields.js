'use strict';

// FIX-2026-08-02: One-shot migration — add DCA + BEP stack fields to Bot + Trade
//   - Bot:  add dcaEnabled=false, dcaMaxLayers=3 (defaults — backward compatible)
//   - Trade: backfill isDcaStack=false, dcaLayerCount=0 (don't convert existing trades)
//
// Usage (with pm2 STOPPED to avoid race):
//   pm2 stop onepercentbot
//   node scripts/migrate-dca-fields.js
//   pm2 start onepercentbot
//
// Idempotent — re-running is safe (uses $exists gate).

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
const Trade = require('../src/db/models/Trade');

(async () => {
  await mongoose.connect(MONGO_URI);
  console.log(`[migrate-dca-fields] connected: ${MONGO_URI}`);

  // 1. Bot: add DCA defaults for existing docs (idempotent $exists gate)
  const r1 = await Bot.updateMany(
    { dcaEnabled: { $exists: false } },
    { $set: { dcaEnabled: false, dcaMaxLayers: 3 } }
  );
  console.log(`[migrate-dca-fields] Bot.dcaEnabled/dcaMaxLayers:  set defaults on ${r1.modifiedCount} docs`);

  // 2. Trade: backfill stack flags for existing docs (do NOT convert to DCA — leave isDcaStack=false)
  const r2 = await Trade.updateMany(
    { isDcaStack: { $exists: false } },
    { $set: { isDcaStack: false, dcaLayerCount: 0 } }
  );
  console.log(`[migrate-dca-fields] Trade.isDcaStack/dcaLayerCount:  backfilled ${r2.modifiedCount} docs`);

  // 3. Verification: count bots by dcaEnabled
  const totalBots = await Bot.countDocuments({});
  const dcaOn = await Bot.countDocuments({ dcaEnabled: true });
  const dcaOff = await Bot.countDocuments({ dcaEnabled: false, dcaMaxLayers: { $exists: true } });
  const legacy = await Bot.countDocuments({ dcaEnabled: { $exists: false } });
  console.log(`[migrate-dca-fields] verify: totalBots=${totalBots} dcaOn=${dcaOn} dcaOff=${dcaOff} legacyMissingFields=${legacy}`);

  // 4. Verification: count trades by isDcaStack
  const totalTrades = await Trade.countDocuments({});
  const dcaStacks = await Trade.countDocuments({ isDcaStack: true });
  const nonDca = await Trade.countDocuments({ isDcaStack: false });
  const legacyTrades = await Trade.countDocuments({ isDcaStack: { $exists: false } });
  console.log(`[migrate-dca-fields] verify: totalTrades=${totalTrades} dcaStacks=${dcaStacks} nonDca=${nonDca} legacyMissingFields=${legacyTrades}`);

  console.log(JSON.stringify({
    bots_defaults_set: r1.modifiedCount,
    trades_backfilled: r2.modifiedCount,
    verify: { totalBots, dcaOn, dcaOff, legacyBots: legacy, totalTrades, dcaStacks, nonDca, legacyTrades },
  }));

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('[migrate-dca-fields] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
