'use strict';

// FIX-2026-09-17: seed AppConfig safety defaults from env vars
//
// Use case:
//   - Existing instance missing a safety toggle (e.g. AppConfig.auv2Enabled
//     stuck at schema default `false`)
//   - Operator adds AUV2_ENABLED=true to .env, restarts bot, but DB is already
//     written → bootstrap path doesn't fire (env respects existing DB values)
//   - This script does ONE-SHOT re-apply: reads current AppConfig, runs
//     computeSafetyDefaults, applies env-derived fields to existing doc,
//     writes back. Respects "existing DB wins" rule (only fills undefined fields)
//
// Args:
//   --owner (default) → .env + DB=onepercentbottrade
//   --faiz            → .env.faiz + DB=onepercentbottrade_faiz
//
// Options:
//   --force  → apply env values EVEN IF DB has explicit value
//              (DANGER — use only if you know what you're doing)
//
// Examples:
//   node scripts/seed-appconfig-from-env.js --owner
//   node scripts/seed-appconfig-from-env.js --faiz --force

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const isFaiz = args.includes('--faiz');
const force = args.includes('--force');

const envFile = isFaiz ? '.env.faiz' : '.env';
const envContent = fs.readFileSync(path.join(__dirname, '..', envFile), 'utf8');
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.MONGODB_URI = isFaiz
  ? 'mongodb://127.0.0.1:27017/onepercentbottrade_faiz'
  : 'mongodb://127.0.0.1:27017/onepercentbottrade';

const AppConfig = require('../src/db/models/AppConfig');
const { ENV_DEFAULTS, computeSafetyDefaults } = require('../src/utils/safetyDefaults');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.collection('appconfigs');

  console.log(`\n=== ${isFaiz ? 'faiz' : 'owner'} seed-appconfig-from-env${force ? ' (FORCE)' : ''} ===\n`);

  // 1. Print current DB state
  let existing = await col.findOne({ key: 'singleton' });
  if (!existing) {
    console.log('⚠️  No AppConfig singleton found — creating fresh one');
    const created = await AppConfig.create({ key: 'singleton' });
    existing = created.toObject();
  }

  console.log('Current AppConfig safety fields:');
  for (const key of Object.keys(ENV_DEFAULTS)) {
    const v = existing[key];
    const envName = ENV_DEFAULTS[key].env;
    const envVal = process.env[envName];
    console.log(`  ${key.padEnd(32)} DB=${String(v).padEnd(8)} env(${envName})=${envVal ?? '(unset)'}`);
  }

  // 2. Compute env-derived fields
  const { fields, sources, skipped } = computeSafetyDefaults(existing, process.env);
  console.log(`\nCompute result:`);
  console.log(`  fields to apply: ${Object.keys(fields).length}`);
  console.log(`  skipped (invalid/unset): ${skipped.length}`);
  if (skipped.length > 0) {
    for (const s of skipped) console.log(`    - ${s.key} (${s.env}): ${s.reason}`);
  }

  if (Object.keys(fields).length === 0 && !force) {
    console.log(`\n✅ Nothing to seed — all env-derived fields already set in DB (or env vars unset).`);
    await mongoose.disconnect();
    return process.exit(0);
  }

  // 3. If --force, override existing values with env
  let finalFields = { ...fields };
  if (force) {
    for (const [k, spec] of Object.entries(ENV_DEFAULTS)) {
      const raw = process.env[spec.env];
      if (raw === undefined || raw === null || raw === '') continue;
      if (spec.type === 'boolean') {
        const lc = String(raw).toLowerCase().trim();
        if (['true', '1', 'yes', 'on'].includes(lc)) finalFields[k] = true;
        else if (['false', '0', 'no', 'off'].includes(lc)) finalFields[k] = false;
      } else {
        const n = parseFloat(raw);
        if (Number.isFinite(n)) finalFields[k] = n;
      }
      sources[k] = 'env-force';
    }
  }

  // 4. Show preview + confirm
  console.log(`\nWill write to AppConfig:`);
  for (const [k, v] of Object.entries(finalFields)) {
    console.log(`  ${k} = ${v}  (source: ${sources[k]})`);
  }
  console.log(`\n🔒 Press Ctrl+C to abort (waiting 5s...)`);
  await new Promise((r) => setTimeout(r, 5000));

  // 5. Update DB
  const update = { ...finalFields, updatedAt: new Date() };
  const res = await col.updateOne({ key: 'singleton' }, { $set: update });
  console.log(`\nUpdate result: matched=${res.matchedCount} modified=${res.modifiedCount}`);

  // 6. Verify
  const verified = await col.findOne({ key: 'singleton' });
  console.log(`\nVerified after update:`);
  for (const [k, v] of Object.entries(finalFields)) {
    const actual = verified[k];
    const ok = JSON.stringify(actual) === JSON.stringify(v);
    console.log(`  ${ok ? '✅' : '❌'} ${k} = ${actual} (expected ${v})`);
  }

  console.log(`\n=== DONE — restart bot for changes to take effect (npm run pm2:reload) ===`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
