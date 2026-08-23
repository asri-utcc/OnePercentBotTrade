'use strict';

// FIX-2026-08-02: One-shot migration — bump TP% floor value from 0.111 → 0.281
//   - Target: bots with bot.tpPercent < 0.281 (stale floor value under old override)
//   - Action: run computeSuggestedTpForBot() per bot → use NEW floor logic (0.281)
//     - If result >= 0.281: persist that value, set tpOnFloor=false
//     - If result null/insufficient data: fallback bump to 0.281 + tpOnFloor=true
//     - If compute error: fallback bump to 0.281 + tpOnFloor=true (safe default)
//   - After update: emit `bot:updated` event so running trader refreshes this.bot.tpPercent
//
// Why needed: floor constants changed in src/core/tpUpdater.js (TP_FLOOR_THRESHOLD_PCT +
// TP_FLOOR_OVERRIDE_PCT) but existing bots with `tpOnFloor=true` still have stored tpPercent
// = 0.111. Without this migration, UI shows stale 0.111 + ⚙️ floor badge until each bot's
// next hourly auto-tick (only autoUpdateTp=true bots tick).
//
// Usage (safe to run with pm2 running — DB writes are atomic; emits bot:updated which traders
// handle gracefully):
//   node scripts/migrate-tp-floor-0281.js
//
// Idempotent — re-running on a clean DB finds no bots with tpPercent < 0.281.

const path = require('path');

// Load .env manually (avoid pulling full app boot)
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {
  // dotenv optional — env vars may already be set
}

const mongoose = require('mongoose');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/onepercentbot';

const Bot = require('../src/db/models/Bot');
const tpUpdater = require('../src/core/tpUpdater');

(async () => {
  await mongoose.connect(MONGO_URI);
  console.log(`[migrate-tp-floor-0281] connected: ${MONGO_URI}`);

  // Try to load eventBus so we can notify running traders (optional — may not exist yet)
  let eventBus = null;
  try {
    eventBus = require('../src/services/eventBus');
  } catch (_) { /* fine — only matters if pm2 is up */ }

  // FIX-2026-08-02 (added post-run): hard-clear volatilityForBot cache because the TP-floor
  //   formula changed (0.111 → 0.281). Server cache may still hold OLD values for up to 60s.
  //   We need every bot's volSuggestedTpPct to reflect the new logic immediately.
  let volatilityForBot = null;
  try {
    volatilityForBot = require('../src/core/volatilityForBot');
    if (typeof volatilityForBot._resetCache === 'function') {
      volatilityForBot._resetCache();
      console.log(`[migrate-tp-floor-0281] volatilityForBot cache cleared (60s TTL force-expired)`);
    }
  } catch (err) {
    console.log(`[migrate-tp-floor-0281] (skip) volatilityForBot cache reset: ${err.message}`);
  }

  const NEW_FLOOR = 0.281;
  const affected = await Bot.find({ tpPercent: { $lt: NEW_FLOOR } }).select('_id symbol timeframe tpPercent tpOnFloor autoUpdateTp').lean();
  console.log(`[migrate-tp-floor-0281] Found ${affected.length} bots with tpPercent < ${NEW_FLOOR}%`);

  let updatedToNatural = 0;
  let updatedToFloor = 0;
  let failed = 0;
  const errors = [];

  for (const b of affected) {
    const botId = b._id.toString();
    let newTp = NEW_FLOOR;
    let newFloorFlag = true;
    let method = 'floor-fallback';

    try {
      const calc = await tpUpdater.computeSuggestedTpForBot(b);
      if (calc && !calc.error && calc.suggestedTpPct != null) {
        newTp = calc.suggestedTpPct;
        newFloorFlag = !!calc.tpOverridden;
        method = newFloorFlag ? 'floor-applied' : 'natural';
      } else {
        // warmup / insufficient / error → keep newFloorFlag=true so UI badge stays
        console.log(`[migrate-tp-floor-0281]   ${b.symbol}/${b.timeframe} botId=${botId} calc unavailable (${calc && calc.error ? calc.error : 'warmup'}) — falling back to ${NEW_FLOOR} + tpOnFloor=true`);
      }

      await Bot.updateOne(
        { _id: b._id },
        {
          $set: {
            tpPercent: newTp,
            tpOnFloor: newFloorFlag,
            updateTpAt: new Date(),
          },
        }
      );

      if (newFloorFlag) updatedToFloor += 1;
      else updatedToNatural += 1;

      // Notify running trader so it refreshes this.bot.tpPercent (preservedKeys doesn't list tpPercent
      // so _botUpdatedHandler will overwrite it from fresh DB doc).
      if (eventBus && typeof eventBus.emit === 'function') {
        try { eventBus.emit('bot:updated', { botId }); } catch (_) { /* non-fatal */ }
      }

      console.log(`[migrate-tp-floor-0281]   ${b.symbol}/${b.timeframe} botId=${botId}: ${b.tpPercent}% → ${newTp}% [${method}, tpOnFloor=${newFloorFlag}]`);
    } catch (err) {
      failed += 1;
      errors.push({ botId, err: err.message });
      console.error(`[migrate-tp-floor-0281]   ${b.symbol}/${b.timeframe} botId=${botId}: FAILED ${err.message}`);
    }
  }

  // Diagnostic: list remaining bots with tpPercent < NEW_FLOOR (should be 0 unless constraint failed)
  const remaining = await Bot.countDocuments({ tpPercent: { $lt: NEW_FLOOR } });

  console.log(`[migrate-tp-floor-0281] Done. updated-to-natural=${updatedToNatural} updated-to-floor=${updatedToFloor} failed=${failed}`);
  console.log(`[migrate-tp-floor-0281] Remaining bots with tpPercent < ${NEW_FLOOR}%: ${remaining}`);
  if (errors.length > 0) {
    console.log(`[migrate-tp-floor-0281] Errors:`, JSON.stringify(errors, null, 2));
  }

  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('[migrate-tp-floor-0281] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
