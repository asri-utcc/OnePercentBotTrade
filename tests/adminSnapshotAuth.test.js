/**
 * FIX-2026-09-01 audit C2: adminSnapshot endpoint — proper license-key auth.
 *
 * Previously the snapshot endpoint only checked that X-License-Key header was
 * present (any non-empty string passed). Now uses requireAuthOrLicenseKey which
 * does timingSafeEqual against adminMonitorConfig.licenseKey.
 */
'use strict';

jest.mock('../src/services/eventBus', () => ({
  getEventBus: () => ({ emit: jest.fn(), on: jest.fn(), removeAllListeners: jest.fn() }),
  emit: jest.fn(),
}));
jest.mock('../src/admin-monitor/commandExecutor', () => ({
  execute: jest.fn(),
  handlers: {},
}));
jest.mock('../src/admin-monitor/machineId', () => ({
  getMachineId: () => 'test-machine-id-snap',
}));

beforeEach(() => {
  process.env.ADMIN_ENABLED = 'true';
  process.env.ADMIN_LICENSE_KEY = 'real-admin-key-1234';
  delete process.env.ADMIN_COMMAND_HMAC_SECRET;
  delete process.env.JWT_SECRET;
});

describe('audit-C2 adminSnapshot — requireAuthOrLicenseKey gate (static contract)', () => {
  test('snapshot endpoint imports requireAuthOrLicenseKey middleware', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'api', 'routes', 'adminSnapshot.routes.js'),
      'utf8',
    );
    expect(src).toMatch(/requireAuthOrLicenseKey/);
    expect(src).toMatch(/router\.get\(['"]\/?['"],\s*requireAuthOrLicenseKey/);
    // The legacy "we trust header presence" comment must be gone.
    expect(src).not.toMatch(/we trust the header presence/);
    // No bare `if (!licenseKey)` early-return — the gate is now the middleware.
    expect(src).not.toMatch(/if \(!licenseKey\)\s*\{\s*return res\.status\(401\)/);
  });

  test('middleware uses timingSafeEqual (not just length / string ===)', () => {
    const fs = require('fs');
    const path = require('path');
    const authSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'api', 'middleware', 'auth.js'),
      'utf8',
    );
    expect(authSrc).toMatch(/requireAuthOrLicenseKey/);
    expect(authSrc).toMatch(/crypto\.timingSafeEqual/);
    expect(authSrc).toMatch(/adminMonitorConfig\.licenseKey/);
  });

  test('audit comment block (FIX-2026-09-01 audit C2) explains the fix', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'api', 'routes', 'adminSnapshot.routes.js'),
      'utf8',
    );
    expect(src).toMatch(/FIX-2026-09-01 audit C2/);
    expect(src).toMatch(/timingSafeEqual/);
  });
});

describe('integration: middleware rejects invalid X-License-Key', () => {
  // Build a fake req/res and call the middleware directly — no supertest needed.
  function buildReqRes({ licenseKey, sessionAuthed = false } = {}) {
    const req = {
      session: sessionAuthed ? { authenticated: true } : {},
      get: (name) => (name === 'X-License-Key' ? licenseKey : undefined),
      path: '/snap',
      ip: '127.0.0.1',
    };
    let statusCode = null;
    let jsonBody = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(body) { jsonBody = body; return this; },
    };
    return { req, res, getStatus: () => statusCode, getBody: () => jsonBody };
  }

  function runMiddleware(licenseKey) {
    jest.resetModules();
    process.env.ADMIN_LICENSE_KEY = 'real-admin-key-1234';
    const { requireAuthOrLicenseKey } = require('../src/api/middleware/auth');
    const { req, res, getStatus } = buildReqRes({ licenseKey });
    let nextCalled = false;
    requireAuthOrLicenseKey(req, res, () => { nextCalled = true; });
    return { status: getStatus(), nextCalled };
  }

  test('missing X-License-Key + no session → 401', () => {
    const r = runMiddleware(undefined);
    expect(r.status).toBe(401);
    expect(r.nextCalled).toBe(false);
  });

  test('empty X-License-Key + no session → 401', () => {
    const r = runMiddleware('');
    expect(r.status).toBe(401);
    expect(r.nextCalled).toBe(false);
  });

  test('wrong X-License-Key + no session → 401', () => {
    const r = runMiddleware('wrong-key');
    expect(r.status).toBe(401);
    expect(r.nextCalled).toBe(false);
  });

  test('correct X-License-Key → next() called (200)', () => {
    const r = runMiddleware('real-admin-key-1234');
    expect(r.status).toBe(null);
    expect(r.nextCalled).toBe(true);
  });

  test('prefix of real key → 401 (no substring leak)', () => {
    const r = runMiddleware('real-admin-key');
    expect(r.status).toBe(401);
    expect(r.nextCalled).toBe(false);
  });

  test('superset of real key → 401 (no substring match)', () => {
    const r = runMiddleware('real-admin-key-1234-extra');
    expect(r.status).toBe(401);
    expect(r.nextCalled).toBe(false);
  });

  test('length-mismatch key → 401 (timingSafeEqual requires equal length)', () => {
    const r = runMiddleware('short');
    expect(r.status).toBe(401);
    expect(r.nextCalled).toBe(false);
  });

  test('session-cookie path still works (legacy browser flow)', () => {
    jest.resetModules();
    process.env.ADMIN_LICENSE_KEY = 'real-admin-key-1234';
    const { requireAuthOrLicenseKey } = require('../src/api/middleware/auth');
    const { req, res } = buildReqRes({ sessionAuthed: true });
    let nextCalled = false;
    requireAuthOrLicenseKey(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
});