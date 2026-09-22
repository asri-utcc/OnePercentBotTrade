'use strict';

// FIX-2026-09-22: Manual AppConfig out-of-range repair — multi-instance rescue.
//
// Why this script exists:
//   - scripts/pause-sweeper.js (2026-09-17) wrote orphanSellMaxAgeHours=999999 via
//     raw mongo write on BOTH owner + faiz DBs to disable the orphan-SELL sweeper.
//     That bypassed Mongoose schema (max: 168). MongoDB stored 999999 happily.
//   - Any subsequent .save() (e.g. POST /api/auth/sync-bot-action-password) then
//     threw ValidationError on the stale field even though the caller only touched
//     botActionPassword.
//
//   This script uses the same shared utility as the boot-time repair (src/utils/
//   appConfigRepair.js → repairAppConfig) so behavior is identical to what the
//   server does on startup. It is idempotent and safe to re-run.
//
// Usage:
//   node scripts/repair-appconfig-bounds.js                                 (uses MONGO_URI env or default)
//   DB_URI=mongodb://127.0.0.1:27017/onepercentbottrade_faiz node scripts/repair-appconfig-bounds.js
//   DB_URI=mongodb://127.0.0.1:27017/onepercentbottrade      node scripts/repair-appconfig-bounds.js
//
// What it does NOT do (intentional):
//   - Does NOT clear sweeperEmergencyPaused / sweeperEmergencyPausedAt /
//     sweeperEmergencyPauseReason — those are operator-controlled emergency state.
//     When you decide the recovery is safe to resume, clear them via Master Config
//     or a separate explicit script. We refuse to silently un-pause the sweeper
//     during a data-repair pass.

const mongoose = require('mongoose');
const path = require('path');

const DEFAULT_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/onepercentbottrade';

async function main() {
  const uri = process.env.DB_URI || DEFAULT_URI;
  console.log(`[repair-appconfig] target URI: ${uri}`);

  await mongoose.connect(uri);
  try {
    // Require models AFTER connection so Mongoose state is initialized.
    const AppConfig = require(path.join('..', 'src', 'db', 'models', 'AppConfig'));
    const { repairAppConfig, REPAIR_VERSION } = require(path.join('..', 'src', 'utils', 'appConfigRepair'));

    console.log(`[repair-appconfig] repair version: ${REPAIR_VERSION}`);

    const r = await repairAppConfig({
      AppConfig,
      logger: {
        warn: (obj, msg) => console.warn(`[WARN] ${msg}`, JSON.stringify(obj)),
        info: (obj, msg) => console.log(`[INFO] ${msg}`, JSON.stringify(obj)),
        error: (obj, msg) => console.error(`[ERROR] ${msg}`, JSON.stringify(obj)),
      },
    });

    if (!r.docFound) {
      console.log('[repair-appconfig] no AppConfig singleton found — nothing to repair');
    } else if (r.persisted) {
      console.log(`[repair-appconfig] OK — repaired ${r.repaired.length} field(s):`);
      for (const item of r.repaired) {
        console.log(`  • ${item.path}: ${item.from} → ${item.to} (min=${item.min} max=${item.max})`);
      }
    } else if (r.repaired.length === 0) {
      console.log('[repair-appconfig] OK — AppConfig is already within schema bounds (nothing to repair)');
    } else {
      console.log(`[repair-appconfig] WARN — detected ${r.repaired.length} drift(s) but save() failed: ${r.error}`);
      console.log('         In-memory clamps were computed but NOT persisted.');
      console.log('         Pre-save hook on the model will re-clamp on the next save() call.');
      process.exitCode = 2;
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('[repair-appconfig] FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});