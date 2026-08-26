'use strict';

/**
 * FIX-2026-08-26: Snapshot E2E test
 *
 * Validates the full snapshot pipeline:
 *   1. Bot exposes /api/admin/snapshot (PnL/bots/positions/config, no secrets)
 *   2. Admin exposes /api/instances/snapshot (receive + store)
 *   3. Snapshot sender (bot) pushes every N seconds → admin stores
 *   4. Admin /api/admin/snapshots/latest returns stored snapshot
 *
 * Run with:
 *   TEST_LICENSE_KEY=... TEST_ADMIN_PASSWORD=... node scripts/test-snapshot-e2e.js
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:6016';
const BOT_URL = process.env.BOT_URL || 'http://127.0.0.1:6015';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.TEST_ADMIN_PASSWORD || '';
const LICENSE_KEY = process.env.ADMIN_LICENSE_KEY || process.env.TEST_LICENSE_KEY || '';

if (!ADMIN_PASSWORD || !LICENSE_KEY) {
  console.error('ERROR: set TEST_ADMIN_PASSWORD and TEST_LICENSE_KEY');
  process.exit(1);
}

function httpReq(method, targetUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(data ? { 'Content-Length': data.length } : {}),
      },
      timeout: 30000,
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: text ? JSON.parse(text) : {} }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw: text } }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

async function main() {
  console.log('=== snapshot E2E test ===');
  console.log('botUrl:', BOT_URL);
  console.log('adminUrl:', ADMIN_URL);
  console.log('licenseKey:', LICENSE_KEY.slice(0, 8) + '...');
  console.log('');

  // T1: bot exposes /api/admin/snapshot
  console.log('T1: bot /api/admin/snapshot');
  await test('GET /api/admin/snapshot (no key) returns 401', async () => {
    const res = await httpReq('GET', `${BOT_URL}/api/admin/snapshot`);
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });
  await test('GET /api/admin/snapshot (with key) returns 200 + totals', async () => {
    const res = await httpReq('GET', `${BOT_URL}/api/admin/snapshot`, null, { 'X-License-Key': LICENSE_KEY });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.totals, 'missing totals');
    assert(typeof res.body.totals.totalBots === 'number', 'totals.totalBots missing');
    assert(typeof res.body.totals.todayPnl === 'number', 'totals.todayPnl missing');
    assert(Array.isArray(res.body.bots), 'bots must be array');
  });
  await test('Snapshot excludes secrets (no API keys / passwords / tokens)', async () => {
    const res = await httpReq('GET', `${BOT_URL}/api/admin/snapshot`, null, { 'X-License-Key': LICENSE_KEY });
    const json = JSON.stringify(res.body);
    const secretPatterns = [
      /BINANCE_API_SECRET/i, /sessionSecret/i, /encryptionKey/i,
      /telegram.*token/i, /botActionPassword/i, /dashboardPassword/i,
    ];
    for (const re of secretPatterns) {
      assert(!re.test(json), `snapshot leaked secret matching ${re}`);
    }
  });
  console.log('');

  // Login admin
  const loginRes = await httpReq('POST', `${ADMIN_URL}/api/auth/login`, {
    username: ADMIN_USERNAME, password: ADMIN_PASSWORD,
  });
  if (loginRes.status !== 200) throw new Error('admin login failed');
  const token = loginRes.body.token;

  // T2: admin receives snapshot
  console.log('T2: admin receives snapshot via /api/instances/snapshot');
  // Setup: register our machineId first via heartbeat so admin knows about us
  process.env.ADMIN_ENABLED = 'true';
  process.env.ADMIN_URL = ADMIN_URL;
  process.env.ADMIN_LICENSE_KEY = LICENSE_KEY;
  process.env.ADMIN_CUSTOMER_TAG = '';
  process.env.ADMIN_BOT_URL = BOT_URL;
  process.env.ADMIN_HEARTBEAT_MS = '1500';
  process.env.ADMIN_POLL_MS = '1500';
  process.env.ADMIN_SNAPSHOT_MS = '2000';

  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '.env') });

  const adminMonitor = require('../src/admin-monitor');
  const { getMachineId } = require('../src/admin-monitor/machineId');
  const machineId = getMachineId();

  // Pre-cleanup
  await httpReq('DELETE', `${ADMIN_URL}/api/admin/machines/admin/${machineId}`, null, { Authorization: `Bearer ${token}` });

  adminMonitor.start({
    botManager: { pause: () => {}, resume: () => {}, kill: () => {}, forceCloseAll: async () => 0, setConfig: () => {}, listBots: () => [] },
    eventBus: { emit: () => {} },
    getMetrics: () => ({ uptime: 0, runningBots: 0, activePositions: 0 }),
  });

  // Wait for heartbeat (registers machine) + snapshot push
  await sleep(6000);

  await test('admin stored snapshot for our machine', async () => {
    const res = await httpReq('GET', `${ADMIN_URL}/api/admin/snapshots/${encodeURIComponent(machineId)}/latest`, null, { Authorization: `Bearer ${token}` });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.snapshot, 'missing snapshot');
    assert(res.body.snapshot.totals, 'snapshot missing totals');
    assert(typeof res.body.snapshot.totals.totalBots === 'number', 'snapshot.totals.totalBots missing');
  });
  await test('snapshot has bots array (length matches totalBots)', async () => {
    const res = await httpReq('GET', `${ADMIN_URL}/api/admin/snapshots/${encodeURIComponent(machineId)}/latest`, null, { Authorization: `Bearer ${token}` });
    const snap = res.body.snapshot;
    assert(Array.isArray(snap.bots), 'bots must be array');
    assert(snap.bots.length === snap.totals.totalBots, `expected ${snap.bots.length} bots, got ${snap.totals.totalBots}`);
  });
  console.log('');

  // T3: list latest across all machines
  console.log('T3: admin /api/admin/snapshots/latest');
  await test('GET /api/admin/snapshots/latest returns our snapshot', async () => {
    const res = await httpReq('GET', `${ADMIN_URL}/api/admin/snapshots/latest`, null, { Authorization: `Bearer ${token}` });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.snapshots[machineId], 'snapshot for our machine missing');
    assert(res.body.snapshots[machineId].totals, 'snapshot totals missing');
  });
  console.log('');

  adminMonitor.stop();

  console.log('=== summary ===');
  console.log(`passed: ${passed}`);
  console.log(`failed: ${failed}`);
  console.log('=================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
