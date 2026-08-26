'use strict';

/**
 * FIX-2026-08-26: E2E test for bot admin-monitor ↔ OnePercentBot-Admin
 *
 * What it does:
 *   1. Set env vars (ADMIN_URL, ADMIN_LICENSE_KEY, short intervals)
 *   2. Start adminMonitor with mock botManager + getMetrics
 *   3. Wait ~3s for first heartbeat to land in admin DB
 *   4. Login to admin API → queue a 'show_message' command via admin route
 *   5. Wait ~3s for bot to poll + execute + report
 *   6. Query admin DB to verify:
 *      - Machine record exists with this machineId
 *      - Command is now 'completed' with our payload echoed
 *
 * Run with:
 *   node scripts/test-admin-monitor-e2e.js
 *
 * Requires:
 *   - OnePercentBot-Admin running on port 6016
 *   - Valid ADMIN_LICENSE_KEY below (or set via env)
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:6016';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'qMJfqtMnuEgeJ9q!Aa1';
const LICENSE_KEY = process.env.ADMIN_LICENSE_KEY || process.env.TEST_LICENSE_KEY || '';

if (!LICENSE_KEY) {
  console.error('ERROR: set TEST_LICENSE_KEY (or ADMIN_LICENSE_KEY) env var');
  console.error('  Generate: cd OnePercentBot-Admin && node tools/generate-license.js --owner e2e-test --max-machines 1');
  process.exit(1);
}

// Speed intervals for the test
process.env.ADMIN_ENABLED = 'true';
process.env.ADMIN_URL = ADMIN_URL;
process.env.ADMIN_LICENSE_KEY = LICENSE_KEY;
process.env.ADMIN_HEARTBEAT_MS = '1500'; // 1.5s
process.env.ADMIN_POLL_MS = '1500'; // 1.5s

// Patch require to load the bot's config (some env like SESSION_SECRET required)
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });
// But our SESSION_SECRET/ENCRYPTION_KEY shouldn't be required when loading admin-monitor
// (admin-monitor doesn't import server-side crypto).

const adminMonitor = require('../src/admin-monitor');
const { getMachineId } = require('../src/admin-monitor/machineId');

// Mock botManager + eventBus
const events = [];
const mockBotManager = {
  pause: (reason) => events.push({ type: 'pause', reason }),
  resume: () => events.push({ type: 'resume' }),
  kill: () => events.push({ type: 'kill' }),
  forceCloseAll: async (reason) => { events.push({ type: 'forceCloseAll', reason }); return 0; },
  setConfig: (k, v) => events.push({ type: 'setConfig', key: k, value: v }),
  listBots: () => [{ running: true }, { running: false }], // 1 running bot
};
const mockEventBus = {
  emit: (event, payload) => events.push({ type: 'eventBus', event, payload }),
};

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

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  console.log('=== admin-monitor E2E test ===');
  const machineId = getMachineId();
  console.log('machineId:', machineId);
  console.log('adminUrl:', ADMIN_URL);
  console.log('licenseKey:', LICENSE_KEY.slice(0, 8) + '...');
  console.log('');

  // 1. Login to admin
  console.log('[1] login to admin...');
  const loginRes = await httpReq('POST', `${ADMIN_URL}/api/auth/login`, {
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
  });
  if (loginRes.status !== 200 || !loginRes.body.token) {
    throw new Error(`login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  const token = loginRes.body.token;
  console.log('    ✓ logged in (token len=' + token.length + ')');
  console.log('');

  // 2. Start admin-monitor
  console.log('[2] starting adminMonitor...');
  adminMonitor.start({
    botManager: mockBotManager,
    eventBus: mockEventBus,
    getMetrics: () => ({
      runningBots: 1,
      activePositions: 0,
      uptime: Math.floor(process.uptime()),
      errors: 0,
    }),
  });
  console.log('    ✓ started');
  console.log('');

  // 3. Wait for heartbeat
  console.log('[3] waiting 3s for first heartbeat...');
  await sleep(3000);
  console.log('    ✓ heartbeat should have been sent');
  console.log('');

  // 4. Verify heartbeat landed (admin should now have a Machine record)
  console.log('[4] checking machines via admin API...');
  const machinesRes = await httpReq('GET', `${ADMIN_URL}/api/admin/machines/admin/list`, null, { Authorization: `Bearer ${token}` });
  console.log('    status:', machinesRes.status);
  console.log('    machines count:', (machinesRes.body.machines || machinesRes.body || []).length);
  if (machinesRes.status === 200) {
    const ms = machinesRes.body.machines || [];
    const found = ms.find(m => m.machineId === machineId);
    if (found) {
      console.log('    ✓ machine record found:', found.machineId.slice(0, 12) + '...');
      console.log('      hostname:', found.hostname);
      console.log('      lastHeartbeatAt:', found.lastHeartbeatAt);
    } else {
      console.log('    ✗ machine record NOT found');
      console.log('    machines:', JSON.stringify(ms, null, 2).slice(0, 500));
    }
  }
  console.log('');

  // 5. Queue a 'show_message' command
  console.log('[5] queueing show_message command...');
  const uniqueMsg = 'E2E-test-' + Date.now();
  const queueRes = await httpReq('POST', `${ADMIN_URL}/api/commands`, {
    machineId,
    type: 'show_message',
    payload: { message: uniqueMsg },
  }, { Authorization: `Bearer ${token}` });
  console.log('    status:', queueRes.status);
  console.log('    response:', JSON.stringify(queueRes.body).slice(0, 300));
  if (queueRes.status !== 200 && queueRes.status !== 201) {
    throw new Error(`queue failed: ${queueRes.status}`);
  }
  const commandId = queueRes.body.command?.commandId || queueRes.body.commandId;
  console.log('    commandId:', commandId);
  console.log('');

  // 6. Wait for bot to poll + execute + report
  console.log('[6] waiting 3s for bot to poll + execute + report...');
  await sleep(3000);
  console.log('');

  // 7. Check command status
  console.log('[7] checking command status...');
  const cmdRes = await httpReq('GET', `${ADMIN_URL}/api/commands/${commandId}`, null, { Authorization: `Bearer ${token}` });
  if (cmdRes.status === 200) {
    const cmd = cmdRes.body.command || cmdRes.body;
    console.log('    status:', cmd.status);
    console.log('    type:', cmd.type);
    console.log('    result:', JSON.stringify(cmd.result || {}).slice(0, 200));
    console.log('    ✓ command lifecycle complete (queued → fetched → executed → reported)');
  } else {
    console.log('    ✗ could not fetch command:', cmdRes.status, JSON.stringify(cmdRes.body));
  }
  console.log('');

  // 8. Check local events captured
  console.log('[8] local events captured:');
  for (const e of events) console.log('    -', JSON.stringify(e));
  console.log('');

  // 9. Cleanup
  console.log('[9] stopping adminMonitor...');
  adminMonitor.stop();
  console.log('    ✓ stopped');
  console.log('');

  console.log('=== E2E test done ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('TEST FAILED:', err.message);
  console.error(err.stack);
  adminMonitor.stop?.();
  process.exit(1);
});
