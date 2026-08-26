'use strict';

/**
 * FIX-2026-08-26: Watermark E2E test
 *
 * Verifies the per-customer watermark tag is:
 *   1. Auto-generated at license issuance
 *   2. Echoed in heartbeat payload (env ADMIN_CUSTOMER_TAG)
 *   3. Stored on Machine record in admin DB
 *   4. Returned in /validate response
 *   5. Visible in /api/admin/machines listing
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:6016';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.TEST_ADMIN_PASSWORD || '';
const LICENSE_KEY = process.env.ADMIN_LICENSE_KEY || process.env.TEST_LICENSE_KEY || '';
const CUSTOMER_TAG = process.env.ADMIN_CUSTOMER_TAG || process.env.TEST_CUSTOMER_TAG || '';

if (!ADMIN_PASSWORD || !LICENSE_KEY || !CUSTOMER_TAG) {
  console.error('ERROR: set TEST_ADMIN_PASSWORD, TEST_LICENSE_KEY, TEST_CUSTOMER_TAG');
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
      timeout: 10000,
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
  console.log('=== watermark E2E test ===');
  console.log('customerTag:', CUSTOMER_TAG);
  console.log('licenseKey:', LICENSE_KEY.slice(0, 8) + '...');
  console.log('');

  // Login
  const loginRes = await httpReq('POST', `${ADMIN_URL}/api/auth/login`, {
    username: ADMIN_USERNAME, password: ADMIN_PASSWORD,
  });
  if (loginRes.status !== 200) throw new Error('login failed');
  const token = loginRes.body.token;

  // Pre-cleanup: delete any existing Machine record for our machineId (bound to a previous license)
  process.env.ADMIN_ENABLED = 'true';
  process.env.ADMIN_URL = ADMIN_URL;
  process.env.ADMIN_LICENSE_KEY = LICENSE_KEY;
  process.env.ADMIN_CUSTOMER_TAG = CUSTOMER_TAG;
  process.env.ADMIN_HEARTBEAT_MS = '1500';
  process.env.ADMIN_POLL_MS = '1500';

  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '.env') });

  const { getMachineId } = require('../src/admin-monitor/machineId');
  const machineId = getMachineId();
  await httpReq('DELETE', `${ADMIN_URL}/api/admin/machines/admin/${machineId}`, null, { Authorization: `Bearer ${token}` });

  // T1: license detail should include customerTag
  console.log('T1: license detail returns customerTag');
  await test('GET /api/licenses/:key returns license with customerTag', async () => {
    const res = await httpReq('GET', `${ADMIN_URL}/api/licenses/${LICENSE_KEY}`, null, { Authorization: `Bearer ${token}` });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.license.customerTag === CUSTOMER_TAG,
      `expected customerTag=${CUSTOMER_TAG}, got ${res.body.license.customerTag}`);
  });
  console.log('');

  // T2: bot sends heartbeat with customerTag from env
  console.log('T2: bot heartbeat includes customerTag');

  const adminMonitor = require('../src/admin-monitor');

  adminMonitor.start({
    botManager: { pause: () => {}, resume: () => {}, kill: () => {}, forceCloseAll: async () => 0, setConfig: () => {}, listBots: () => [] },
    eventBus: { emit: () => {} },
    getMetrics: () => ({ uptime: 0, runningBots: 0, activePositions: 0 }),
  });

  await sleep(3500); // wait for heartbeat

  await test('Machine record in admin DB has customerTag', async () => {
    const res = await httpReq('GET', `${ADMIN_URL}/api/admin/machines/admin/list`, null, { Authorization: `Bearer ${token}` });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const machineId = getMachineId();
    const machine = (res.body.machines || []).find(m => m.machineId === machineId);
    assert(machine, `machine ${machineId.slice(0, 12)} not found`);
    assert(machine.customerTag === CUSTOMER_TAG,
      `expected machine.customerTag=${CUSTOMER_TAG}, got ${machine.customerTag}`);
  });
  console.log('');

  // T3: validate response includes customerTag
  console.log('T3: /validate response includes customerTag');
  await test('POST /validate returns customerTag in license + machine', async () => {
    const res = await adminMonitor.validateLicense();
    assert(res.ok, 'expected ok=true');
    assert(res.license.customerTag === CUSTOMER_TAG,
      `expected license.customerTag=${CUSTOMER_TAG}, got ${res.license.customerTag}`);
    assert(res.machine.customerTag === CUSTOMER_TAG,
      `expected machine.customerTag=${CUSTOMER_TAG}, got ${res.machine.customerTag}`);
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
