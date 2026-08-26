#!/usr/bin/env node
'use strict';

/**
 * FIX-2026-08-26 Phase 3a: Re-sign consent CLI tool
 *
 *   Resets the bot's local consent decision so the next bot startup re-engages
 *   /consent on port 6015. Useful for testing the first-run flow.
 *
 * Usage:
 *   node scripts/reset-consent.js [--yes] [--admin] [--dry-run] [--help]
 *
 * Flags:
 *   --yes        skip the "are you sure?" prompt (required for non-interactive use)
 *   --admin      also DELETE the corresponding consent record on the admin server
 *                (via DELETE /api/instances/admin/:machineId/consent with X-License-Key)
 *   --dry-run    print actions without modifying anything
 *   --help       show this help
 *
 * What it does:
 *   1. Read consent config (CONSENT_FILE_PATH from .env, default ~/.onepercentbot-consent.json)
 *   2. If file exists: show current decision + delete the file
 *   3. If --admin: HTTP DELETE to admin server's consent endpoint
 *   4. Print summary; suggest restarting the bot to re-engage /consent on 6015
 *
 * Exit codes:
 *   0 — success (or dry-run)
 *   1 — error (e.g. admin endpoint failed)
 *   2 — invalid flags
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// Load .env so CONSENT_FILE_PATH / ADMIN_MONITOR_URL / LICENSE_KEY are available
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (e) { /* dotenv not installed — fine, fall back to process.env */ }

const consentConfig = require('../src/consent/config');
const { getMachineId } = require('../src/admin-monitor/machineId');
const adminConfig = require('../src/admin-monitor/config');

function _printHelp() {
  console.log(`Usage: node scripts/reset-consent.js [--yes] [--admin] [--dry-run] [--help]

Resets the bot's local consent decision so the next bot startup re-engages /consent on 6015.

Flags:
  --yes        skip the "are you sure?" prompt (required for non-interactive use)
  --admin      also DELETE the corresponding consent record on the admin server
  --dry-run    print actions without modifying anything
  --help       show this help

Exit codes:
  0 = success (or dry-run), 1 = error, 2 = invalid flags`);
}

function _parseFlags(argv) {
  const flags = { yes: false, admin: false, dryRun: false, help: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--yes') flags.yes = true;
    else if (arg === '--admin') flags.admin = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else {
      console.error(`Unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return flags;
}

function _readCurrent() {
  const fp = consentConfig.filePath;
  if (!fs.existsSync(fp)) return { exists: false, path: fp };
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const record = JSON.parse(raw);
    return { exists: true, path: fp, record };
  } catch (err) {
    return { exists: true, path: fp, error: err.message };
  }
}

function _httpDelete(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch (e) { return reject(new Error(`bad URL: ${targetUrl}`)); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'DELETE',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search || ''}`,
      headers: { 'Content-Length': 0, ...headers },
      timeout: 8000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: buf });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function _deleteAdminConsent({ machineId, licenseKey, adminUrl, dryRun }) {
  const url = `${adminUrl.replace(/\/$/, '')}/api/instances/admin/${encodeURIComponent(machineId)}/consent`;
  console.log(`  → DELETE ${url}`);
  if (dryRun) return { status: 'dry-run', body: '' };
  try {
    const r = await _httpDelete(url, { 'X-License-Key': licenseKey });
    console.log(`  ← ${r.status} ${r.body}`);
    if (r.status >= 200 && r.status < 300) return r;
    return { error: true, status: r.status, body: r.body };
  } catch (err) {
    console.error(`  ✗ admin DELETE failed: ${err.message}`);
    return { error: true, message: err.message };
  }
}

async function main() {
  const flags = _parseFlags(process.argv);
  if (flags.help) { _printHelp(); process.exit(0); }

  const machineId = getMachineId();
  const adminEnabled = !!(adminConfig.enabled && adminConfig.licenseKey && adminConfig.url);
  const adminUrl = adminConfig.url || '';
  const licenseKey = adminConfig.licenseKey || '';

  console.log('─'.repeat(60));
  console.log('🛠  Re-sign Consent — reset bot local consent decision');
  console.log('─'.repeat(60));
  console.log(`  Machine ID    : ${machineId}`);
  console.log(`  Consent file  : ${consentConfig.filePath}`);
  console.log(`  Consent enabled: ${consentConfig.enabled ? '✅ yes' : '⚪ no (disabled)'}`);
  console.log(`  Admin monitor : ${adminEnabled ? `✅ ${adminUrl}` : '⚪ disabled'}`);
  console.log(`  Flags         : ${flags.yes ? '--yes ' : ''}${flags.admin ? '--admin ' : ''}${flags.dryRun ? '--dry-run' : ''}`);
  console.log('');

  const current = _readCurrent();
  if (current.exists) {
    if (current.error) {
      console.log(`  Current state : ⚠ file exists but unreadable (${current.error})`);
    } else {
      console.log(`  Current state : decision=${current.record.decision} · version=${current.record.consentVersion} · decidedAt=${current.record.decidedAt || '—'} · source=${current.record.source || '—'}`);
    }
  } else {
    console.log('  Current state : ⚪ no consent file yet (never decided)');
  }
  console.log('');

  if (!flags.dryRun) {
    if (!flags.yes) {
      // Try stdin TTY prompt; fall back to a clear non-TTY warning
      if (process.stdin.isTTY) {
        process.stdout.write('Reset consent? Type "yes" to confirm: ');
        const answer = await new Promise((resolve) => {
          let buf = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (c) => { buf += c; if (buf.endsWith('\n')) resolve(buf.trim()); });
          process.stdin.once('end', () => resolve(buf.trim()));
          process.stdin.resume();
        });
        if (answer !== 'yes') {
          console.log('  → Aborted (no confirmation).');
          process.exit(0);
        }
      } else {
        console.error('Non-interactive mode requires --yes flag. Aborting.');
        process.exit(2);
      }
    }

    // 1) Delete local consent file
    if (current.exists) {
      try {
        fs.unlinkSync(current.path);
        console.log(`  ✓ Deleted ${current.path}`);
      } catch (err) {
        console.error(`  ✗ Failed to delete ${current.path}: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.log('  → Nothing to delete locally (no file).');
    }

    // 2) Optionally DELETE admin record
    if (flags.admin) {
      if (!adminEnabled) {
        console.error('  ✗ --admin requested but admin monitor is not configured (URL or LICENSE_KEY missing).');
        process.exit(1);
      }
      console.log('');
      console.log('  Admin consent reset:');
      const r = await _deleteAdminConsent({ machineId, licenseKey, adminUrl, dryRun: false });
      if (r.error) process.exit(1);
    } else if (adminEnabled) {
      console.log('  (pass --admin to also DELETE the consent record on the admin server)');
    }
  } else {
    console.log('  [DRY-RUN] would delete local file' + (flags.admin ? ' + DELETE admin consent' : ''));
    if (flags.admin && adminEnabled) {
      await _deleteAdminConsent({ machineId, licenseKey, adminUrl, dryRun: true });
    }
  }

  console.log('');
  console.log('─'.repeat(60));
  console.log('✅ Consent reset complete.');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Reload the bot: npm run pm2:reload');
  console.log('  2. Open http://localhost:6015/login.html — the consent overlay will');
  console.log('     appear if not yet decided (and the legacy 6017 fallback starts');
  console.log('     after CONSENT_FALLBACK_DELAY_MS if you don\'t engage 6015).');
  console.log('  3. Or open http://localhost:6015/consent directly to make a decision.');
  console.log('─'.repeat(60));
}

// FIX-2026-08-26 Phase 3a: only auto-run when invoked directly (not when require'd by tests)
if (require.main === module) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}

// Export helpers for unit tests.
//   - `main` is not re-exported on purpose (would conflict with the auto-runner above)
module.exports = {
  _parseFlags,
  _readCurrent,
  _deleteAdminConsent,
  _httpDelete,
};