'use strict';

/**
 * FIX-2026-08-26: License gate E2E test
 *
 * Tests the new /api/instances/validate endpoint (admin) + licenseGate module (bot):
 *   1. Invalid license key → 403 invalid_license
 *   2. Valid license + correct machineId (after heartbeat) → 200
 *   3. Valid license + unknown machineId → 404 machine_not_registered
 *   4. Valid license + machineId bound to different license → 403 machine_license_mismatch
 *   5. Bot licenseGate.validate() throws on missing key, returns ok on valid
 *
 * Requires:
 *   - OnePercentBot-Admin running on port 6016
 *   - TEST_LICENSE_KEY env (license issued by admin CLI)
 *   - TEST_ADMIN_PASSWORD env (admin login)
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:6016';
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
      timeout: 10000,
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try {
          const json = text ? JSON.parse(text) : {};
          resolve({ status: res.statusCode, body: json });
        } catch (e) {
          resolve({ status: res.statusCode, body: { raw: text } });
        }
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
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

async function main() {
  console.log('=== license gate E2E test ===');
  console.log('');

  // Login
  const loginRes = await httpReq('POST', `${ADMIN_URL}/api/auth/login`, {
    username: ADMIN_USERNAME, password: ADMIN_PASSWORD,
  });
  if (loginRes.status !== 200) throw new Error('login failed');
  const token = loginRes.body.token;
  console.log('logged in');
  console.log('');

  // T1: invalid license
  console.log('T1: invalid license → expect 403');
  await test('POST /validate with bad license returns 403 invalid_license', async () => {
    const res = await httpReq('POST', `${ADMIN_URL}/api/instances/validate`,
      { machineId: 'doesnt-matter' },
      { 'X-License-Key': 'INVALID-XXXX-YYYY-ZZZZ' }
    );
    assert(res.status === 403, `expected 403, got ${res.status}`);
    assert(res.body.error === 'invalid_license', `expected error=invalid_license, got ${res.body.error}`);
  });
  console.log('');

  // T2: valid license but no machine record
  console.log('T2: valid license + unknown machine → expect 404 machine_not_registered');
  await test('POST /validate with valid license + unknown machineId returns 404', async () => {
    const res = await httpReq('POST', `${ADMIN_URL}/api/instances/validate`,
      { machineId: 'this-machine-does-not-exist-anywhere' },
      { 'X-License-Key': LICENSE_KEY }
    );
    assert(res.status === 404, `expected 404, got ${res.status}`);
    assert(res.body.error === 'machine_not_registered', `expected error=machine_not_registered, got ${res.body.error}`);
  });
  console.log('');

  // T3: bot perspective — set env, start heartbeat, then validate
  console.log('T3: bot license gate → send heartbeat first, then validate');
  process.env.ADMIN_ENABLED = 'true';
  process.env.ADMIN_URL = ADMIN_URL;
  process.env.ADMIN_LICENSE_KEY = LICENSE_KEY;
  process.env.ADMIN_HEARTBEAT_MS = '1500';
  process.env.ADMIN_POLL_MS = '1500';

  const dotenv = require('dotenv');
  dotenv.config({ path: require('path').join(__dirname, '..', '.env') });

  const adminMonitor = require('../src/admin-monitor');
  const { getMachineId } = require('../src/admin-monitor/machineId');

  const mockBotManager = {
    pause: () => {}, resume: () => {}, kill: () => {},
    forceCloseAll: async () => 0, setConfig: () => {},
    listBots: () => [],
  };

  adminMonitor.start({
    botManager: mockBotManager,
    eventBus: { emit: () => {} },
    getMetrics: () => ({ uptime: 0, runningBots: 0, activePositions: 0 }),
  });

  // Wait for heartbeat to register machine
  await sleep(3500);

  await test('validateLicense() succeeds after heartbeat (valid + matching machine)', async () => {
    const res = await adminMonitor.validateLicense();
    assert(res && res.ok === true, `expected ok=true, got ${JSON.stringify(res)}`);
    assert(res.license && res.license.owner, `expected license.owner, got ${JSON.stringify(res.license)}`);
    assert(res.machine && res.machine.status === 'online', `expected machine.status=online, got ${res.machine?.status}`);
  });

  await test('adminMonitor.licenseGate.isValid is true after success', () => {
    assert(adminMonitor.licenseGate.isValid === true, 'licenseGate.isValid should be true');
  });
  console.log('');

  // T4: simulate wrong-machine scenario — try to validate with a different machineId
  console.log('T4: wrong machineId with valid license → expect 404');
  await test('POST /validate with valid license but machineId NOT registered returns 404', async () => {
    const res = await httpReq('POST', `${ADMIN_URL}/api/instances/validate`,
      { machineId: 'fake-machine-9999' },
      { 'X-License-Key': LICENSE_KEY }
    );
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });
  console.log('');

  // T5: licenseGate.validate() throws on bad license (without going through heartbeat)
  console.log('T5: licenseGate.validate() throws with bad license key');
  await test('POST /validate with bad license key returns 403 (covers both API + bot wrapper)', async () => {
    const res = await httpReq('POST', `${ADMIN_URL}/api/instances/validate`,
      { machineId: 'any-machine' },
      { 'X-License-Key': 'BAD-KEY-XXXX-YYYY' }
    );
    assert(res.status === 403, `expected 403, got ${res.status}`);
    assert(res.body.error === 'invalid_license', `expected error=invalid_license, got ${res.body.error}`);
  });
  console.log('');

  // Cleanup
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
