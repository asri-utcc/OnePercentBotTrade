'use strict';

/**
 * FIX-2026-08-26 Phase 3a: tests for scripts/reset-consent.js
 *
 *   We test the internal helpers in isolation:
 *     - flag parsing (--yes, --admin, --dry-run, --help, unknown)
 *     - local file delete (mock fs)
 *     - dry-run guard (no delete when --dry-run)
 *
 *   Admin HTTP DELETE is exercised via a tiny test server we spin up.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-consent-test-'));
const TMP_FILE = path.join(TMP_DIR, 'consent.json');

process.env.CONSENT_FILE_PATH = TMP_FILE;

// Inject mocks BEFORE requiring the script (the script requires both consent/config and admin-monitor/config)
const mockMachineId = 'TEST-MACHINE-RESET';
jest.mock('../src/admin-monitor/machineId', () => ({
  getMachineId: () => mockMachineId,
}));

function loadScript() {
  // fresh require each test (the script reads env at module-load)
  let mod;
  jest.isolateModules(() => {
    mod = require('../scripts/reset-consent.js');
  });
  return mod;
}

describe('reset-consent.js — flag parsing', () => {
  let origArgv;
  beforeAll(() => { origArgv = process.argv; });
  afterAll(() => { process.argv = origArgv; });

  test('parses --yes', () => {
    process.argv = ['node', 'reset-consent.js', '--yes'];
    const script = loadScript();
    expect(script._parseFlags(process.argv)).toEqual({ yes: true, admin: false, dryRun: false, help: false });
  });

  test('parses --admin --dry-run', () => {
    process.argv = ['node', 'reset-consent.js', '--admin', '--dry-run'];
    const script = loadScript();
    expect(script._parseFlags(process.argv)).toEqual({ yes: false, admin: true, dryRun: true, help: false });
  });

  test('parses --help', () => {
    process.argv = ['node', 'reset-consent.js', '--help'];
    const script = loadScript();
    expect(script._parseFlags(process.argv).help).toBe(true);
  });

  test('exits 2 on unknown flag', () => {
    process.argv = ['node', 'reset-consent.js', '--wat'];
    const script = loadScript();
    const spy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const spyErr = jest.spyOn(console, 'error').mockImplementation(() => {});
    script._parseFlags(process.argv);
    expect(spy).toHaveBeenCalledWith(2);
    spy.mockRestore();
    spyErr.mockRestore();
  });
});

describe('reset-consent.js — local file delete', () => {
  beforeEach(() => {
    if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE);
  });
  afterAll(() => {
    if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE);
    try { fs.rmdirSync(TMP_DIR); } catch (e) {}
  });

  test('_readCurrent returns exists:false when no file', () => {
    const script = loadScript();
    const r = script._readCurrent();
    expect(r.exists).toBe(false);
    expect(r.path).toBe(TMP_FILE);
  });

  test('_readCurrent returns record when file exists', () => {
    fs.writeFileSync(TMP_FILE, JSON.stringify({
      decision: 'accepted', consentVersion: '1', decidedAt: '2026-08-26T00:00:00Z', source: 'first_run',
    }));
    const script = loadScript();
    const r = script._readCurrent();
    expect(r.exists).toBe(true);
    expect(r.record.decision).toBe('accepted');
    expect(r.record.consentVersion).toBe('1');
  });

  test('_readCurrent handles corrupt JSON gracefully', () => {
    fs.writeFileSync(TMP_FILE, '{this is not valid json');
    const script = loadScript();
    const r = script._readCurrent();
    expect(r.exists).toBe(true);
    expect(r.error).toBeTruthy();
  });
});

describe('reset-consent.js — end-to-end main() with --dry-run', () => {
  beforeAll(() => { fs.mkdirSync(TMP_DIR, { recursive: true }); });
  beforeEach(() => {
    if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE);
    // Seed file to simulate a decided state
    fs.writeFileSync(TMP_FILE, JSON.stringify({
      decision: 'accepted', consentVersion: '1', decidedAt: '2026-08-26T00:00:00Z', source: 'first_run',
    }));
  });
  afterAll(() => {
    if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE);
  });

  test('dry-run leaves file in place', async () => {
    const origArgv = process.argv;
    process.argv = ['node', 'reset-consent.js', '--dry-run', '--yes'];
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const spyErr = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Re-require in dry-run path
    jest.isolateModules(() => {
      require('../scripts/reset-consent.js');
    });
    // Allow main() to resolve
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(TMP_FILE)).toBe(true); // not deleted
    process.argv = origArgv;
    spy.mockRestore();
    spyErr.mockRestore();
  });
});

describe('reset-consent.js — admin DELETE smoke (in-process HTTP)', () => {
  let server;
  let receivedReq = null;
  beforeAll((done) => {
    server = http.createServer((req, res) => {
      receivedReq = { method: req.method, url: req.url, headers: req.headers };
      if (req.url.includes('/consent') && req.method === 'DELETE') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deletedCount: 1 }));
      } else {
        res.writeHead(404);
        res.end();
      }
    }).listen(0, '127.0.0.1', done);
  });
  afterAll((done) => { server.close(done); });
  beforeEach(() => { receivedReq = null; });

  test('_deleteAdminConsent hits DELETE with X-License-Key header', async () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}`;
    const script = loadScript();
    const r = await script._deleteAdminConsent({
      machineId: mockMachineId,
      licenseKey: 'TEST-KEY',
      adminUrl: url,
      dryRun: false,
    });
    expect(receivedReq.method).toBe('DELETE');
    expect(receivedReq.url).toContain(`/api/instances/admin/${mockMachineId}/consent`);
    expect(receivedReq.headers['x-license-key']).toBe('TEST-KEY');
    expect(r.status).toBe(200);
    expect(r.error).toBeUndefined();
  });

  test('_deleteAdminConsent dry-run does not call server', async () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}`;
    const script = loadScript();
    receivedReq = null;
    const r = await script._deleteAdminConsent({
      machineId: mockMachineId, licenseKey: 'TEST-KEY', adminUrl: url, dryRun: true,
    });
    expect(receivedReq).toBeNull(); // no HTTP call
    expect(r.status).toBe('dry-run');
  });
});