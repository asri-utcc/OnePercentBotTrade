'use strict';

/**
 * FIX-2026-09-09: Consent boot-resync push
 *
 *   Verifies that pushDecision() correctly sends the current state to admin so
 *   the Machines tab reflects the latest consent decision per machine.
 *   server.js calls this on every boot with source='boot_resync'.
 *
 *   Strategy: set process.env (admin-monitor config reads it directly), then
 *   mock http.request to capture the call. Use jest.resetModules() between
 *   cases so a fresh copy of consent/api.js sees the new env.
 */

const path = require('path');

const CONSENT_API_PATH = path.resolve(__dirname, '..', 'src', 'consent', 'api.js');

function _captureHttp() {
  const captured = { calls: [] };
  const http = require('http');
  const origRequest = http.request;
  http.request = function (opts, cb) {
    captured.calls.push({ opts });
    const handlers = {};
    const req = {
      on(evt, fn) { handlers[evt] = fn; return this; },
      write() {},
      end() {
        const res = {
          statusCode: 200,
          on(evt, fn) { if (evt === 'end') setImmediate(fn); return this; },
        };
        setImmediate(() => cb && cb(res));
      },
      destroy() {},
    };
    return req;
  };
  return { captured, restore: () => { http.request = origRequest; } };
}

describe('consent api.pushDecision — boot_resync support (FIX-2026-09-09)', () => {
  let origEnv;
  beforeEach(() => {
    origEnv = { ...process.env };
    jest.resetModules();
  });
  afterEach(() => {
    process.env = origEnv;
  });

  test('pushes accepted decision to admin', () => {
    process.env.ADMIN_ENABLED = 'true';
    process.env.ADMIN_LICENSE_KEY = 'TEST-LICENSE';
    process.env.ADMIN_URL = 'http://admin.test:6016';
    const { captured, restore } = _captureHttp();
    try {
      const api = require(CONSENT_API_PATH);
      return api.pushDecision({ machineId: 'mid-test', decision: 'accepted', consentVersion: '1', source: 'boot_resync' })
        .then((ok) => {
          expect(ok).toBe(true);
          expect(captured.calls.length).toBe(1);
          const call = captured.calls[0];
          expect(call.opts.hostname).toBe('admin.test');
          expect(call.opts.port).toBe('6016');
          expect(call.opts.path).toBe('/api/instances/consent');
          expect(call.opts.headers['X-License-Key']).toBe('TEST-LICENSE');
          expect(call.opts.method).toBe('POST');
        });
    } finally { restore(); }
  });

  test('skips push when adminMonitor disabled (no admin URL configured)', () => {
    delete process.env.ADMIN_ENABLED;
    delete process.env.ADMIN_LICENSE_KEY;
    delete process.env.ADMIN_URL;
    const { captured, restore } = _captureHttp();
    try {
      const api = require(CONSENT_API_PATH);
      return api.pushDecision({ machineId: 'mid-test', decision: 'accepted', consentVersion: '1', source: 'boot_resync' })
        .then((ok) => {
          expect(ok).toBe(false);
          expect(captured.calls.length).toBe(0);
        });
    } finally { restore(); }
  });

  test('pushes both accepted and declined (boot_resync sends whatever state is current)', () => {
    process.env.ADMIN_ENABLED = 'true';
    process.env.ADMIN_LICENSE_KEY = 'TEST-LICENSE';
    process.env.ADMIN_URL = 'http://admin.test:6016';
    const { captured, restore } = _captureHttp();
    try {
      const api = require(CONSENT_API_PATH);
      return Promise.all([
        api.pushDecision({ machineId: 'a', decision: 'accepted', consentVersion: '1', source: 'boot_resync' }),
        api.pushDecision({ machineId: 'b', decision: 'declined', consentVersion: '1', source: 'boot_resync' }),
      ]).then(() => {
        expect(captured.calls.length).toBe(2);
        expect(captured.calls[0].opts.method).toBe('POST');
        expect(captured.calls[1].opts.method).toBe('POST');
      });
    } finally { restore(); }
  });

  test('returns false (no throw) when http.request errors', () => {
    process.env.ADMIN_ENABLED = 'true';
    process.env.ADMIN_LICENSE_KEY = 'TEST-LICENSE';
    process.env.ADMIN_URL = 'http://admin.test:6016';
    const http = require('http');
    const origRequest = http.request;
    http.request = function () {
      const req = {
        on() { return this; },
        write() {},
        end() {},
        destroy() {},
      };
      setImmediate(() => {
        const e = new Error('ECONNREFUSED');
        const handlers = req._h || {};
        if (handlers.error) handlers.error(e);
      });
      // store handlers for the deferred trigger
      const h = {};
      req.on = function (evt, fn) { h[evt] = fn; return this; };
      req._h = h;
      return req;
    };
    try {
      const api = require(CONSENT_API_PATH);
      return api.pushDecision({ machineId: 'mid-test', decision: 'accepted', consentVersion: '1', source: 'boot_resync' })
        .then((ok) => {
          expect(ok).toBe(false);
        });
    } finally { http.request = origRequest; }
  });
});
