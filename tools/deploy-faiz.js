#!/usr/bin/env node
'use strict';

/**
 * FIX-2026-09-29: One-command Faiz instance deploy.
 *
 * Workflow:
 *   1. Verify pre-requisites (.env.faiz exists, repo is git repo)
 *   2. Capture package.json hash before pull
 *   3. git pull (shared repo, same source as owner)
 *   4. If package.json changed → npm install (production deps only)
 *   5. npm run pm2:reload:faiz (graceful reload, no downtime)
 *   6. Print status + log path + health check hint
 *
 * Usage:
 *   node tools/deploy-faiz.js
 *   npm run deploy:faiz
 *
 * Pre-requisites:
 *   - Repo is a git repo with remote `origin`
 *   - Faiz pm2 process `onepercentbot-faiz` exists (use `npm run pm2:start:faiz` if not)
 *   - `.env.faiz` exists at repo root (sibling of ecosystem.faiz.config.js)
 *
 * Notes:
 *   - Owner and Faiz share the SAME source code (per `onepercentbot-multi-instance-deployment-2026-09-09.md`)
 *   - Only Faiz-specific files differ: `.env.faiz`, `data/faiz-machine-id.txt`, log files
 *   - PM2 reload uses graceful restart (zero-downtime)
 *
 * Exit codes:
 *   0 — success
 *   1 — pre-requisite missing
 *   2 — git pull failed
 *   3 — npm install failed
 *   4 — pm2 reload failed
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function run(cmd, opts = {}) {
  console.log(`\n→ ${cmd}`);
  try {
    return execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
  } catch (e) {
    // execSync throws on non-zero exit
    throw e;
  }
}

function fail(step, err) {
  console.error(`\n✗ ${step} failed`);
  if (err) console.error(`  ${err.message || err}`);
  process.exit(1);
}

function main() {
  // ─── 1. Verify pre-requisites ────────────────────────────────────────
  console.log('🔍 Checking pre-requisites...');

  if (!fs.existsSync(path.join(ROOT, '.env.faiz'))) {
    console.error('✗ .env.faiz missing — cannot deploy Faiz');
    console.error('  → See SYSTEM-INSTALL.md for one-time setup');
    process.exit(1);
  }

  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    console.error('✗ .git directory missing — not a git repo');
    process.exit(1);
  }

  console.log('  ✓ .env.faiz present');
  console.log('  ✓ git repo');

  // ─── 2. Capture package.json hash before pull ────────────────────────
  const pkgPath = path.join(ROOT, 'package.json');
  const pkgBefore = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : '';

  // ─── 3. git pull ─────────────────────────────────────────────────────
  try {
    run('git pull');
  } catch (err) {
    fail('git pull', err);
  }

  // ─── 4. Detect package.json change → npm install ────────────────────
  const pkgAfter = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : '';
  if (pkgBefore !== pkgAfter) {
    console.log('\n→ package.json changed → running npm install (production deps only)');
    try {
      run('npm install --omit=dev');
    } catch (err) {
      fail('npm install', err);
    }
  } else {
    console.log('\n→ package.json unchanged → skipping npm install');
  }

  // ─── 5. Reload Faiz ─────────────────────────────────────────────────
  try {
    run('npm run pm2:reload:faiz');
  } catch (err) {
    fail('pm2 reload:faiz', err);
  }

  // ─── 6. Show status ─────────────────────────────────────────────────
  try {
    run('pm2 status onepercentbot-faiz');
  } catch (err) {
    console.warn('\n⚠ pm2 status failed (non-fatal):', err.message);
  }

  console.log('\n✅ Faiz deploy complete');
  console.log('  📋 Logs:   tail -f logs/faiz-pm2-out.log');
  console.log('  🔍 Health: curl http://127.0.0.1:2026/api/health');
  console.log('  🛑 Stop:   npm run pm2:stop:faiz');
}

main();
