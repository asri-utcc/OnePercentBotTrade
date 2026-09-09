#!/usr/bin/env node
'use strict';

/**
 * FIX-2026-09-09: OneClick Update — migration runner.
 *
 *   Usage:
 *     node scripts/run-pending-migrations.js migrate-a.js migrate-b.js
 *
 *   Each migration script must be idempotent (existing convention — see
 *   scripts/migrate-dca-fields.js for the canonical pattern using $exists
 *   gates + idempotent operations).
 *
 *   Streams each script's stdout/stderr to the parent's stdout/stderr so
 *   the update orchestrator's UI can show real-time progress.
 *
 *   Exit code:
 *     0 — all migrations succeeded
 *     non-zero — first failed migration (orchestrator will trigger rollback)
 *
 *   This script is intentionally minimal — heavy logic lives in each
 *   migration. The runner just sequences them.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const BOT_ROOT = path.resolve(__dirname, '..');

function runOne(scriptName) {
  const scriptPath = path.join(BOT_ROOT, 'scripts', scriptName);
  console.log(`\n=== Migration: ${scriptName} ===`);
  console.log(`[migrate-runner] node ${scriptPath}`);
  const r = spawnSync(process.execPath, [scriptPath], {
    stdio: 'inherit',
    cwd: BOT_ROOT,
    env: process.env,
  });
  if (r.error) {
    console.error(`[migrate-runner] failed to spawn ${scriptName}: ${r.error.message}`);
    return { ok: false, script: scriptName, error: r.error.message };
  }
  if (r.status !== 0) {
    console.error(`[migrate-runner] ${scriptName} exited ${r.status}`);
    return { ok: false, script: scriptName, exitCode: r.status };
  }
  console.log(`=== ${scriptName} OK ===`);
  return { ok: true, script: scriptName };
}

function main() {
  const scripts = process.argv.slice(2).filter(Boolean);
  if (scripts.length === 0) {
    console.error('[migrate-runner] usage: node scripts/run-pending-migrations.js <m1.js> [<m2.js>...]');
    process.exit(2);
  }
  console.log(`[migrate-runner] ${scripts.length} migration(s) to run: ${scripts.join(', ')}`);
  const results = [];
  for (const s of scripts) {
    const r = runOne(s);
    results.push(r);
    if (!r.ok) {
      console.error(`[migrate-runner] aborting — ${s} failed`);
      console.log(JSON.stringify({ ok: false, results }, null, 2));
      process.exit(r.exitCode || 1);
    }
  }
  console.log(`\n[migrate-runner] all migrations succeeded`);
  console.log(JSON.stringify({ ok: true, results }, null, 2));
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { runOne, main };
