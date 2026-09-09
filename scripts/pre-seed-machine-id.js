#!/usr/bin/env node
'use strict';

/**
 * FIX-2026-09-09: Pre-seed machineId file for multi-instance setup
 *
 * Each bot instance needs a unique machineId BEFORE first start, so the admin
 * registers them as distinct machines (not as one machine with 2 ports).
 *
 * Usage:
 *   node scripts/pre-seed-machine-id.js faiz
 *   # → writes data/faiz-machine-id.txt with random 32-char hex
 *
 *   node scripts/pre-seed-machine-id.js faiz --show
 *   # → prints the existing ID instead of regenerating
 *
 * Why pre-seed instead of letting machineId.js auto-generate:
 *   - machineId.js derives ID from hostname/MAC/CPU → same on same host
 *   - We want a stable, per-instance ID that survives OS / network changes
 *   - Persisted file wins on next start (machineId.js line 59-62)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const name = process.argv[2];
const showOnly = process.argv.includes('--show');

if (!name) {
  console.error('Usage: node scripts/pre-seed-machine-id.js <instance-name> [--show]');
  console.error('Example: node scripts/pre-seed-machine-id.js faiz');
  process.exit(2);
}

// Sanitize name to avoid path traversal
const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
const file = path.resolve(__dirname, '..', 'data', `${safeName}-machine-id.txt`);

if (showOnly) {
  if (fs.existsSync(file)) {
    const id = fs.readFileSync(file, 'utf8').trim();
    console.log(`Existing machineId for "${safeName}": ${id}`);
    console.log(`File: ${file}`);
    process.exit(0);
  } else {
    console.error(`No pre-seeded file for "${safeName}" at ${file}`);
    console.error(`Run without --show first to generate one.`);
    process.exit(1);
  }
}

// Idempotent: don't overwrite existing pre-seed (operator might want to control it)
if (fs.existsSync(file)) {
  const existing = fs.readFileSync(file, 'utf8').trim();
  console.log(`✓ Already pre-seeded: ${existing}`);
  console.log(`  File: ${file}`);
  console.log(`  Use --show to display, or delete the file to regenerate.`);
  process.exit(0);
}

// Generate
const id = crypto.randomBytes(16).toString('hex').slice(0, 32);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, id + '\n', 'utf8');

console.log(`✓ Pre-seeded machineId for "${safeName}"`);
console.log(`  ID:   ${id}`);
console.log(`  File: ${file}`);
console.log('');
console.log('Next steps:');
console.log(`  1. Add to .env.${safeName}:  MACHINE_ID_FILE=./data/${safeName}-machine-id.txt`);
console.log(`  2. Start:                    npm run pm2:start:${safeName}`);
console.log(`  3. Verify in admin:          Machines tab → should see machineId starting with "${id.slice(0,8)}..."`);
