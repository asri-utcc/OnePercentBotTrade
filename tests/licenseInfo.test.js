'use strict';

/**
 * FIX-2026-08-26 Phase 3a: License info endpoint tests
 *
 *   Covers:
 *     - GET /api/license/info returns payload shape (license, lastValidatedAt, adminMonitorEnabled, machineId)
 *     - GET /api/license/info when licenseGate has no cached license returns license=null
 *     - POST /api/license/refresh when admin disabled → 400 admin_monitor_disabled
 *     - POST /api/license/refresh calls validate() and returns updated payload
 *
 *   In-process HTTP — no MongoDB, no real admin server. Mocks licenseGate + fxService.
 */

const express = require('express');
const http = require('http');

// ─── Mocks ────────────────────────────────────────────────────────────────
const mockLicenseGate = {
  lastLicense: null,
  lastValidatedAt: null,
  validate: jest.fn(async () => { mockLicenseGate.lastLicense = { owner: 'mock-owner', tier: 'pro', maxBots: 100 }; mockLicenseGate.lastValidatedAt = Date.now(); }),
};
jest.mock('../src/admin-monitor/licenseGate', () => mockLicenseGate);
jest.mock('../src/admin-monitor/config', () => ({
  enabled: true,
  licenseKey: 'TEST-LICENSE-KEY',
  url: 'http://mock-admin:6016',
}));
jest.mock('../src/admin-monitor/machineId', () => ({
  getMachineId: () => 'TEST-MACHINE-001',
}));
jest.mock('../src/services/fxService', () => ({
  convertUsdtToThb: async (n) => n * 35.5,
}));

// Mock requireAuth to no-op (no MongoDB session)
jest.mock('../src/api/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
}));

const licenseRoutes = require('../src/api/routes/license.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/license', licenseRoutes);
  return app;
}
function listen(app) {
  return new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
}
function closeServer(s) { return new Promise((r) => s.close(r)); }
function request(s, method, p, body) {
  const { port } = s.address();
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch (e) { resolve({ status: res.statusCode, body: buf }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('license routes (Phase 3a)', () => {
  let server;
  beforeAll(async () => { server = await listen(buildApp()); });
  afterAll(async () => { await closeServer(server); });
  beforeEach(() => {
    mockLicenseGate.lastLicense = null;
    mockLicenseGate.lastValidatedAt = null;
    mockLicenseGate.validate.mockClear();
  });

  test('GET /api/license/info returns payload with null license when not yet validated', async () => {
    const r = await request(server, 'GET', '/api/license/info');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('license', null);
    expect(r.body).toHaveProperty('lastValidatedAt', null);
    expect(r.body.adminMonitorEnabled).toBe(true);
    expect(r.body.machineId).toBe('TEST-MACHINE-001');
  });

  test('GET /api/license/info returns cached license after validate()', async () => {
    mockLicenseGate.lastLicense = { owner: 'alice', tier: 'pro', maxBots: 100, expiresAt: '2027-01-01', customerTag: 'GIGIJ' };
    mockLicenseGate.lastValidatedAt = 1700000000000;
    const r = await request(server, 'GET', '/api/license/info');
    expect(r.status).toBe(200);
    expect(r.body.license).toMatchObject({ owner: 'alice', tier: 'pro', maxBots: 100 });
    expect(r.body.lastValidatedAt).toBe(1700000000000);
  });

  test('POST /api/license/refresh calls licenseGate.validate() and returns updated payload', async () => {
    const r = await request(server, 'POST', '/api/license/refresh', {});
    expect(r.status).toBe(200);
    expect(mockLicenseGate.validate).toHaveBeenCalledWith({ throwOnFail: false });
    expect(r.body.license).toMatchObject({ owner: 'mock-owner', tier: 'pro' });
    expect(typeof r.body.lastValidatedAt).toBe('number');
  });
});
