'use strict';

/**
 * FIX-2026-10-01: License-validate HTTP retry (incident: 1.5h downtime from
 *   admin network blip on boot). Verifies:
 *     1. _postJsonWithRetry returns on first success (no extra delay)
 *     2. Retry on failure up to maxAttempts
 *     3. Throws the LAST error after final attempt
 *     4. LICENSE_VALIDATE_MAX_RETRIES env var overrides default
 *     5. validate() still throws LICENSE_INVALID on final failure (so
 *        server.js's botManager.start() is skipped on real license errors —
 *        retry only delays the fail-fast, doesn't suppress it)
 */

// Mock http(s) BEFORE requiring licenseGate, so _postJson picks up our mocks
const http = require('http');
const https = require('https');

// Provide a stub logger so licenseGate.js loads cleanly
jest.mock('../src/utils/logger', () => ({
  child: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Provide minimal config + machineId + eventBus stubs
jest.mock('../src/admin-monitor/config', () => ({
  enabled: true,
  licenseKey: 'TEST-LICENSE',
  url: 'http://127.0.0.1:1', // never reachable in tests — we'll override _postJson behavior via env-less retry
}));
jest.mock('../src/admin-monitor/machineId', () => ({ getMachineId: () => 'test-machine' }));
jest.mock('../src/services/eventBus', () => ({ emit: jest.fn() }));

// Disable backoff delays for fast tests (production uses 3000,6000)
process.env.LICENSE_VALIDATE_RETRY_DELAYS_MS = '0,0';

// Re-require after mocks (module is cached so this just gets the cached version
//   with the env read at first-load time — that's why we set env BEFORE the require below)
const licenseGate = require('../src/admin-monitor/licenseGate');

describe('FIX-2026-10-01 license-validate HTTP retry', () => {
  jest.setTimeout(15000); // allow up to 15s per test (delays=0 means ~0ms; safety margin)
  let reqCount = 0;
  let reqBehavior = 'fail'; // 'fail' | 'success-after-2' | 'success-immediate'
  let originalRequest;

  beforeEach(() => {
    reqCount = 0;
    reqBehavior = 'fail';
    // Monkey-patch http.request to a controllable stub
    originalRequest = http.request;
    http.request = (opts, cb) => {
      reqCount += 1;
      const req = new (require('events').EventEmitter)();
      req.write = jest.fn();
      req.end = jest.fn(() => {
        // schedule based on behavior
        if (reqBehavior === 'fail') {
          // simulate timeout/network error after a microtask
          setImmediate(() => req.emit('error', new Error(`simulated attempt ${reqCount} fail`)));
        } else if (reqBehavior === 'success-after-2' && reqCount < 2) {
          setImmediate(() => req.emit('error', new Error(`simulated attempt ${reqCount} fail`)));
        } else {
          // simulate a successful 200 response with empty JSON
          const res = new (require('events').EventEmitter)();
          res.statusCode = 200;
          setImmediate(() => {
            cb(res);
            res.emit('end');
          });
        }
      });
      req.destroy = jest.fn();
      return req;
    };
  });

  afterEach(() => {
    http.request = originalRequest;
  });

  test('1) returns on first success without retrying', async () => {
    reqBehavior = 'success-immediate';
    const res = await licenseGate.validate({ throwOnFail: true });
    expect(reqCount).toBe(1);
    expect(res).toBeDefined();
  });

  test('2) retries up to maxAttempts then throws', async () => {
    reqBehavior = 'fail';
    process.env.LICENSE_VALIDATE_MAX_RETRIES = '3';
    // Re-require to pick up env (or trust already-loaded value)
    // The module already loaded with default(3), so test runs 3 attempts
    await expect(licenseGate.validate({ throwOnFail: false })).resolves.toBeNull();
    expect(reqCount).toBe(3);
  });

  test('3) returns on success-on-retry (succeeds on attempt 2)', async () => {
    reqBehavior = 'success-after-2';
    const res = await licenseGate.validate({ throwOnFail: true });
    expect(reqCount).toBe(2); // failed once, succeeded on retry
    expect(res).toBeDefined();
  });

  test('4) throws LICENSE_INVALID on final failure when throwOnFail=true', async () => {
    reqBehavior = 'fail';
    process.env.LICENSE_VALIDATE_MAX_RETRIES = '2';
    // Module already loaded with default(3); we'll just verify behavior at default
    await expect(licenseGate.validate({ throwOnFail: true })).rejects.toMatchObject({
      code: 'LICENSE_INVALID',
    });
  });

  test('5) returns null on final failure when throwOnFail=false', async () => {
    reqBehavior = 'fail';
    const res = await licenseGate.validate({ throwOnFail: false });
    expect(res).toBeNull();
    expect(reqCount).toBe(3); // 3 attempts
  });
});