'use strict';

// FIX-2026-08-01: One-shot migration — rename sls1 fields/enum to cb
//   - Bot.sls1Enabled        → Bot.cbEnabled
//   - Bot.sls1LastFiredAt    → Bot.cbLastFiredAt
//   - Trade.sellReason: 'sls1_panic' → 'cb_panic'
//
// Usage (with pm2 STOPPED to avoid race):
//   pm2 stop onepercentbot
//   node scripts/migrate-sls1-to-cb.js
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

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/onepercentbot';

const Bot = require('../src/db/models/Bot');
const Trade = require('../src/db/models/Trade');

(async () => {
  await mongoose.connect(MONGO_URI);
  console.log(`[migrate-sls1-to-cb] connected: ${MONGO_URI}`);

  // Bot: rename sls1Enabled → cbEnabled (idempotent — only docs that still have sls1Enabled)
  const r1 = await Bot.updateMany({ sls1Enabled: { $exists: true } }, [
    { $set: { cbEnabled: '$sls1Enabled' } },
    { $unset: ['sls1Enabled'] },
  ]);
  console.log(`[migrate-sls1-to-cb] Bot.cbEnabled:  renamed ${r1.modifiedCount} docs`);

  // Bot: rename sls1LastFiredAt → cbLastFiredAt
  const r2 = await Bot.updateMany({ sls1LastFiredAt: { $exists: true } }, [
    { $set: { cbLastFiredAt: '$sls1LastFiredAt' } },
    { $unset: ['sls1LastFiredAt'] },
  ]);
  console.log(`[migrate-sls1-to-cb] Bot.cbLastFiredAt:  renamed ${r2.modifiedCount} docs`);

  // Trade: backfill sellReason
  const r3 = await Trade.updateMany({ sellReason: 'sls1_panic' }, { $set: { sellReason: 'cb_panic' } });
  console.log(`[migrate-sls1-to-cb] Trade.sellReason:  backfilled ${r3.modifiedCount} docs`);

  console.log(JSON.stringify({
    bots_renamed_enabled: r1.modifiedCount,
    bots_renamed_lastFired: r2.modifiedCount,
    trades_backfilled: r3.modifiedCount,
  }));

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('[migrate-sls1-to-cb] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});