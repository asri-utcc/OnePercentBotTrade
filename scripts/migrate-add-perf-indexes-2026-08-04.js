'use strict';

// FIX-2026-08-04: Performance indexes migration
//   - adds 12 indexes to trades/bots/signals collections
//   - drives PnL queries, positionWatchdog N+1, auto-pause/trendline/tpUpdater scans
//   - background: true → non-blocking on existing data
//   - idempotent: createIndex is a no-op if index already exists
//
// Safety: NO data mutation, NO schema change at app level — only adds indexes.
// Migration script is standalone (does not require app to be running).
//
// Usage:
//   pm2 stop onepercentbot
//   node scripts/migrate-add-perf-indexes-2026-08-04.js
//   pm2 start onepercentbot
//
// Rollback:
//   node scripts/migrate-add-perf-indexes-2026-08-04.js --rollback

const path = require('path');
const mongoose = require('mongoose');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {
  // dotenv optional
}

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/onepercentbottrade';
const ROLLBACK = process.argv.includes('--rollback');

const INDEXES = [
  {
    collection: 'trades',
    spec: { sellFilledAt: -1, realizedPnl: 1 },
    options: { name: 'sellFilledAt_-1_realizedPnl_1_partial', background: true, partialFilterExpression: { realizedPnl: { $exists: true } } },
  },
  { collection: 'trades', spec: { buyFilledAt: -1, buyStatus: 1 }, options: { name: 'buyFilledAt_-1_buyStatus_1', background: true } },
  { collection: 'trades', spec: { botId: 1, useStopLossOnUKC: 1, state: 1 }, options: { name: 'botId_1_useStopLossOnUKC_1_state_1', background: true } },
  { collection: 'trades', spec: { botId: 1, sellFilledAt: -1 }, options: { name: 'botId_1_sellFilledAt_-1', background: true } },
  { collection: 'trades', spec: { botId: 1, buyFilledAt: -1 }, options: { name: 'botId_1_buyFilledAt_-1', background: true } },
  { collection: 'trades', spec: { botId: 1, createdAt: -1 }, options: { name: 'botId_1_createdAt_-1', background: true } },
  { collection: 'bots', spec: { enabled: 1, createdAt: -1 }, options: { name: 'enabled_1_createdAt_-1', background: true } },
  { collection: 'bots', spec: { autoPauseEnabled: 1 }, options: { name: 'autoPauseEnabled_1_partial', background: true, partialFilterExpression: { autoPauseEnabled: true } } },
  { collection: 'bots', spec: { safeTradeTrendlineEnabled: 1 }, options: { name: 'safeTradeTrendlineEnabled_1_partial', background: true, partialFilterExpression: { safeTradeTrendlineEnabled: true } } },
  { collection: 'bots', spec: { autoUpdateTp: 1 }, options: { name: 'autoUpdateTp_1_partial', background: true, partialFilterExpression: { autoUpdateTp: true } } },
  { collection: 'signals', spec: { botId: 1, candleCloseTime: -1 }, options: { name: 'botId_1_candleCloseTime_-1', background: true } },
  { collection: 'signals', spec: { botId: 1, createdAt: -1 }, options: { name: 'botId_1_createdAt_-1', background: true } },
];

async function main() {
  console.log(`[migrate-add-perf-indexes] connecting to ${MONGO_URI}`);
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('[migrate-add-perf-indexes] connected');

  const db = mongoose.connection.db;

  for (const idx of INDEXES) {
    try {
      if (ROLLBACK) {
        const existing = await db.collection(idx.collection).indexExists(idx.options.name);
        if (existing) {
          await db.collection(idx.collection).dropIndex(idx.options.name);
          console.log(`✓ dropped ${idx.collection}.${idx.options.name}`);
        } else {
          console.log(`- skip ${idx.collection}.${idx.options.name} (not found)`);
        }
      } else {
        await db.collection(idx.collection).createIndex(idx.spec, idx.options);
        console.log(`✓ created ${idx.collection}.${idx.options.name} ${JSON.stringify(idx.spec)}`);
      }
    } catch (err) {
      console.error(`✗ failed ${idx.collection}.${idx.options.name}:`, err.message);
      // continue on best-effort
    }
  }

  await mongoose.disconnect();
  console.log(`[migrate-add-perf-indexes] done (${ROLLBACK ? 'rollback' : 'forward'})`);
}

main().catch((err) => {
  console.error('[migrate-add-perf-indexes] fatal:', err);
  process.exit(1);
});
