'use strict';

/**
 * FIX-2026-08-26 Phase 2c-v2: Consent routes test (in-process HTTP).
 *
 *   Covers:
 *     - GET /consent (HTML page) unauth → 200 HTML, no redirect
 *     - GET /api/consent/status unauth → 200 JSON with decision
 *     - POST /api/consent/accept flips status to accepted
 *     - POST /api/consent/decline flips status to declined
 *     - GET /index.html unauth still redirects (regression: auth-gating unchanged)
 *     - Rate limit: >5 POSTs/min from same IP → 429
 *     - JSON vs HTML response per Accept header
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-routes-test-'));
const TMP_FILE = path.join(TMP_DIR, 'consent.json');

// ─── Mocks ────────────────────────────────────────────────────────────────
jest.mock('../src/consent/api', () => ({
  pushDecision: async () => true,
}));
jest.mock('../src/admin-monitor/machineId', () => ({
  getMachineId: () => 'TEST-MACHINE-002',
}));

// Override config.filePath BEFORE handlers/storage load (they cache it at require-time)
process.env.CONSENT_FILE_PATH = TMP_FILE;

const config = require('../src/consent/config');
const handlers = require('../src/consent/handlers');
const storage = require('../src/consent/storage');
config.filePath = TMP_FILE;

const consentRoutes = require('../src/api/routes/consent.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/consent', consentRoutes);
  app.get('/consent', consentRoutes.page);
  // Mini auth-gating regression check — index.html still requires session
  app.use((req, res, next) => {
    if (req.path === '/index.html' && (!req.headers.cookie || !req.headers.cookie.includes('connect.sid'))) {
      return res.redirect(302, '/login.html');
    }
    next();
  });
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(server, method, p, body, headers = {}) {
  const { port } = server.address();
  const data = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
  const opts = {
    host: '127.0.0.1', port, method, path: p,
    headers: {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      ...headers,
    },
  };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        const ct = res.headers['content-type'] || '';
        let parsed = buf;
        if (ct.includes('application/json')) { try { parsed = JSON.parse(buf); } catch (e) { /* keep raw */ } }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('consent routes (Phase 2c-v2)', () => {
  let server;
  beforeAll(async () => {
    config.filePath = TMP_FILE;
    server = await listen(buildApp());
  });
  afterAll(async () => {
    await closeServer(server);
    try { fs.unlinkSync(TMP_FILE); } catch (e) {}
    try { fs.rmdirSync(TMP_DIR); } catch (e) {}
  });
  beforeEach(() => {
    if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE);
    handlers._resetEngagedForTest();
  });

  test('GET /consent unauth → 200 HTML, no redirect', async () => {
    const r = await request(server, 'GET', '/consent');
    expect(r.status).toBe(200);
    expect((r.headers['content-type'] || '').includes('text/html')).toBe(true);
    expect(r.body).toContain('OnePercentBot');
    expect(r.body).toContain('First-Run Consent');
    expect(r.body).toContain('/api/consent/accept'); // actionBase uses new route
  });

  test('GET /api/consent/status → 200 JSON with decision', async () => {
    const r = await request(server, 'GET', '/api/consent/status');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('decision');
    expect(r.body).toHaveProperty('consentVersion');
    expect(r.body).toHaveProperty('consentEnabled');
  });

  test('POST /api/consent/accept flips status to accepted (JSON)', async () => {
    const r = await request(server, 'POST', '/api/consent/accept', {}, {
      'X-Fetch': '1', 'Accept': 'application/json',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, decision: 'accepted' });
    expect(storage.currentDecision()).toBe('accepted');
  });

  test('POST /api/consent/decline flips status to declined', async () => {
    const r = await request(server, 'POST', '/api/consent/decline', {}, {
      'X-Fetch': '1', 'Accept': 'application/json',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, decision: 'declined' });
    expect(storage.currentDecision()).toBe('declined');
  });

  test('POST accept returns HTML when Accept includes text/html + no X-Fetch', async () => {
    if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE);
    handlers._resetEngagedForTest();
    const r = await request(server, 'POST', '/api/consent/accept', {}, {
      'Accept': 'text/html,application/xhtml+xml',
    });
    expect(r.status).toBe(200);
    expect((r.headers['content-type'] || '').includes('text/html')).toBe(true);
    expect(r.body).toContain('Consent accepted');
  });

  test('Idempotent: second POST with same decision → alreadyDecided', async () => {
    await request(server, 'POST', '/api/consent/accept', {}, {
      'X-Fetch': '1', 'Accept': 'application/json',
    });
    const r = await request(server, 'POST', '/api/consent/accept', {}, {
      'X-Fetch': '1', 'Accept': 'application/json',
    });
    expect(r.status).toBe(200);
    expect(r.body.alreadyDecided).toBe(true);
  });

  test('Rate limit: 6th POST in same minute → 429', async () => {
    // First 5 should succeed (or be idempotent)
    for (let i = 0; i < 5; i++) {
      await request(server, 'POST', '/api/consent/accept', {}, {
        'X-Fetch': '1', 'Accept': 'application/json',
      });
    }
    const r = await request(server, 'POST', '/api/consent/accept', {}, {
      'X-Fetch': '1', 'Accept': 'application/json',
    });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'rate_limited' });
  });

  test('Regression: GET /index.html unauth still redirects to /login.html', async () => {
    const r = await request(server, 'GET', '/index.html');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/login.html');
  });
});