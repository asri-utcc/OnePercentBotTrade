'use strict';
// FIX-2026-09-03: Migrate DPS layer-related fields out of the database.
//   - Background: DPS no longer auto-tunes `maxTrades` (layers).  That
//     concern will be owned by a separate layer-control function.  After
//     the code refactor, the engine no longer writes these fields, but
//     legacy rows from previous bot versions still carry them.
//   - This migration `$unset`s:
//       Bot.dynamicLayersCurrent
//       AppConfig.{dpsMinLayers, dpsMaxLayers, dpsWinStreakDeltaLayers,
//                  dpsBigWinDeltaLayers, dpsLossDeltaLayers}
//   - IDEMPOTENT: `$unset` on a missing field is a no-op, and the query
//     filter uses `$exists:true` so re-runs match zero docs.
//
// Usage:
//   node scripts/migrate-dps-layers-2026-09-03.js --dry-run   # preview
//   node scripts/migrate-dps-layers-2026-09-03.js             # live

require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const Bot = require(path.resolve(__dirname, '..', 'src', 'db', 'models', 'Bot'));
const AppConfig = require(path.resolve(__dirname, '..', 'src', 'db', 'models', 'AppConfig'));

const BOT_FIELDS_TO_UNSET = ['dynamicLayersCurrent'];

const APP_CONFIG_FIELDS_TO_UNSET = [
  'dpsMinLayers',
  'dpsMaxLayers',
  'dpsWinStreakDeltaLayers',
  'dpsBigWinDeltaLayers',
  'dpsLossDeltaLayers',
];

function fieldSummary(label, fields) {
  return {
    label,
    fields,
    count: fields.length,
  };
}

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  const startedAt = new Date().toISOString();
  console.log(`🔧 DPS layers-removal migration (${dryRun ? 'DRY-RUN' : 'LIVE'})`);
  console.log(`   started: ${startedAt}`);

  const stats = {
    bot: { found: 0, modified: 0, remaining: 0 },
    appConfig: { found: 0, modified: 0, remaining: 0 },
    dryRun,
  };

  try {
    await mongoose.connect(
      process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/onepercentbottrade',
    );

    // ─── Bots ─────────────────────────────────────────────────────────────
    const botQuery = { dynamicLayersCurrent: { $exists: true } };
    stats.bot.found = await Bot.countDocuments(botQuery);
    console.log(`   Bot docs with dynamicLayersCurrent: ${stats.bot.found}`);

    if (stats.bot.found > 0) {
      if (dryRun) {
        console.log('   🔍 DRY-RUN: would $unset dynamicLayersCurrent on those bots');
      } else {
        const botUnset = {};
        BOT_FIELDS_TO_UNSET.forEach((k) => { botUnset[k] = ''; });
        // FIX-2026-09-03: fields are no longer in Bot.js schema, so Mongoose
        // model-level updateMany silently drops the $unset.  Use the raw
        // collection driver to bypass strict-mode validation.
        const r = await Bot.collection.updateMany(botQuery, { $unset: botUnset });
        stats.bot.modified = r.modifiedCount || 0;
        console.log(`   ✅ Bot.$unset: matched=${r.matchedCount} modified=${r.modifiedCount}`);
      }
    }

    // ─── AppConfig ───────────────────────────────────────────────────────
    const appOr = APP_CONFIG_FIELDS_TO_UNSET.map((k) => ({ [k]: { $exists: true } }));
    const appQuery = appOr.length > 0 ? { $or: appOr } : { _id: null };
    stats.appConfig.found = await AppConfig.countDocuments(appQuery);
    console.log(`   AppConfig docs with any dps*Layers field: ${stats.appConfig.found}`);

    if (stats.appConfig.found > 0) {
      if (dryRun) {
        console.log('   🔍 DRY-RUN: would $unset 5 dps*Layers fields on those AppConfig docs');
      } else {
        const appUnset = {};
        APP_CONFIG_FIELDS_TO_UNSET.forEach((k) => { appUnset[k] = ''; });
        // FIX-2026-09-03: same as Bot — fields no longer in AppConfig.js
        // schema, so use raw collection driver to bypass Mongoose strict mode.
        const r = await AppConfig.collection.updateMany(appQuery, { $unset: appUnset });
        stats.appConfig.modified = r.modifiedCount || 0;
        console.log(`   ✅ AppConfig.$unset: matched=${r.matchedCount} modified=${r.modifiedCount}`);
      }
    }

    // ─── Verify ──────────────────────────────────────────────────────────
    if (!dryRun) {
      stats.bot.remaining = await Bot.countDocuments(botQuery);
      stats.appConfig.remaining = await AppConfig.countDocuments(appQuery);
      console.log(`   Post-migration: bot remaining=${stats.bot.remaining}, appConfig remaining=${stats.appConfig.remaining}`);
    }

    // Per-field verify (only meaningful on live run, but cheap to always print)
    for (const k of BOT_FIELDS_TO_UNSET) {
      const n = await Bot.countDocuments({ [k]: { $exists: true } });
      console.log(`   verify Bot.${k} remaining: ${n}`);
    }
    for (const k of APP_CONFIG_FIELDS_TO_UNSET) {
      const n = await AppConfig.countDocuments({ [k]: { $exists: true } });
      console.log(`   verify AppConfig.${k} remaining: ${n}`);
    }

    const summary = {
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      dryRun,
      bot: stats.bot,
      appConfig: stats.appConfig,
      botFields: fieldSummary('bot', BOT_FIELDS_TO_UNSET),
      appConfigFields: fieldSummary('appConfig', APP_CONFIG_FIELDS_TO_UNSET),
    };
    console.log(`📦 migration-summary: ${JSON.stringify(summary)}`);

    await mongoose.disconnect();
    console.log(dryRun ? '✅ Dry-run complete (no writes performed)' : '✅ Migration complete');
    process.exit(0);
  } catch (err) {
    console.error('Fatal:', err.message);
    console.error(err.stack);
    try { await mongoose.disconnect(); } catch (_) { /* noop */ }
    process.exit(1);
  }
})();
