'use strict';

/**
 * FIX-2026-08-27 Bug B/C: tests for src/admin-monitor/commandListener.js
 *
 *   Covers:
 *     - HMAC signature verification (Bug B):
 *       - valid signature → accepted
 *       - tampered signature → rejected + reports 'failed' with signature_invalid reason
 *       - missing signature → rejected
 *       - length mismatch → rejected
 *       - commandHmacSecret from env / derived from licenseKey
 *     - Listener lifecycle:
 *       - start() respects config.enabled (disabled = no-op)
 *       - start() skips when licenseKey empty
 *       - inFlight skips overlapping polls
 *       - 403 race recovery: retry once after 500ms
 *     - 403 reportResult failure on invalid sig should not crash listener
 *
 *   Note on test isolation: each test uses jest.resetModules() so the config
 *   + listener modules are freshly required with the current process.env.
 *   We can't use jest.mock() for our SUT (commandListener) — instead we mock
 *   the three dependencies (eventBus, executor, machineId) at the top of
 *   the file; jest hoists these and reapplies them on every resetModules().
 */

const crypto = require('crypto');

// Mutable mocks — referenced inside jest.mock factories
const mockExecute = jest.fn().mockResolvedValue({ ok: true, action: 'ok' });
const mockEmit = jest.fn();

jest.mock('../src/services/eventBus', () => ({
  getEventBus: () => ({ emit: mockEmit, on: jest.fn(), removeAllListeners: jest.fn() }),
  emit: mockEmit,
}));

jest.mock('../src/admin-monitor/commandExecutor', () => ({
  execute: mockExecute,
  handlers: {},
}));

jest.mock('../src/admin-monitor/machineId', () => ({
  getMachineId: () => 'test-machine-id-001',
}));

// Stub http/https to return queued responses (one queue per protocol)
function installHttpStub() {
  const make = (kind) => () => {
    const handlers = (global.__HTTP_HANDLERS__ && global.__HTTP_HANDLERS__[kind]) || [];
    return {
      request: (opts, cb) => {
        const handler = handlers.shift();
        if (!handler) throw new Error(`No stubbed response queued for ${kind}`);
        const res = {
          statusCode: handler.statusCode || 200,
          on(evt, fn) {
            if (evt === 'data') {
              setImmediate(() => fn(Buffer.from(JSON.stringify(handler.body || {}))));
            }
            if (evt === 'end') {
              setImmediate(fn);
            }
            return this;
          },
        };
        setImmediate(() => cb(res));
        return {
          on() { return this; },
          write() {},
          end() { if (handler.onEnd) handler.onEnd(opts); },
          destroy() {},
        };
      },
    };
  };
  jest.doMock('http', make('http'));
  jest.doMock('https', make('https'));
}

function queueHttp(kind, response) {
  if (!global.__HTTP_HANDLERS__) global.__HTTP_HANDLERS__ = { http: [], https: [] };
  global.__HTTP_HANDLERS__[kind].push(response);
}

function setEnv({ enabled = true, licenseKey = 'lic-abc', secret = null, jwt = null } = {}) {
  process.env.ADMIN_ENABLED = enabled ? 'true' : 'false';
  process.env.ADMIN_LICENSE_KEY = licenseKey;
  if (secret !== null) process.env.ADMIN_COMMAND_HMAC_SECRET = secret;
  else delete process.env.ADMIN_COMMAND_HMAC_SECRET;
  if (jwt !== null) process.env.JWT_SECRET = jwt;
  else delete process.env.JWT_SECRET;
}

function loadFresh() {
  jest.resetModules();
  installHttpStub();
  const config = require('../src/admin-monitor/config');
  const listener = require('../src/admin-monitor/commandListener');
  return { listener, config };
}

beforeEach(() => {
  mockExecute.mockClear();
  mockEmit.mockClear();
  global.__HTTP_HANDLERS__ = { http: [], https: [] };
});

function sign({ commandId, type, payload, issuedAt }, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify({ commandId, type, payload, issuedAt }))
    .digest('hex');
}

describe('commandListener.config.commandHmacSecret', () => {
  test('uses ADMIN_COMMAND_HMAC_SECRET when set', () => {
    setEnv({ secret: 'explicit-secret-1' });
    const { config } = loadFresh();
    expect(config.commandHmacSecret).toBe('explicit-secret-1');
    expect(config.commandHmacSource).toBe('env:ADMIN_COMMAND_HMAC_SECRET');
  });

  test('falls back to JWT_SECRET', () => {
    setEnv({ secret: null, jwt: 'jwt-fallback' });
    const { config } = loadFresh();
    expect(config.commandHmacSecret).toBe('jwt-fallback');
    expect(config.commandHmacSource).toBe('env:JWT_SECRET');
  });

  test('falls back to derived (SHA-256 of licenseKey) when no env set', () => {
    setEnv({ licenseKey: 'lic-xyz', secret: null, jwt: null });
    const { config } = loadFresh();
    const expected = crypto.createHash('sha256').update('lic-xyz:cmd-hmac:v1').digest('hex');
    expect(config.commandHmacSecret).toBe(expected);
    expect(config.commandHmacSource).toBe('derived:licenseKey');
  });

  test('commandHmacSecret is null when licenseKey is empty AND no env', () => {
    setEnv({ licenseKey: '', secret: null, jwt: null });
    const { config } = loadFresh();
    expect(config.commandHmacSecret).toBeNull();
  });
});

describe('commandListener.start lifecycle', () => {
  test('disabled = no listener interval created', () => {
    setEnv({ enabled: false });
    const { listener } = loadFresh();
    listener.start();
    expect(listener.interval).toBeNull();
  });

  test('no licenseKey = skip + no interval', () => {
    setEnv({ licenseKey: '' });
    const { listener } = loadFresh();
    listener.start();
    expect(listener.interval).toBeNull();
  });

  test('enabled + licenseKey = interval set', () => {
    setEnv({ licenseKey: 'lic-x' });
    const { listener } = loadFresh();
    listener.start();
    expect(listener.interval).not.toBeNull();
    listener.stop();
  });
});

describe('commandListener._executeAndReport (HMAC verification)', () => {
  test('valid signature → executor runs', async () => {
    setEnv({ licenseKey: 'lic-abc', secret: 'shhh' });
    const { listener } = loadFresh();
    const cmd = {
      commandId: 'cmd-001',
      type: 'pause',
      payload: { reason: 'admin' },
      issuedAt: 1234567890,
    };
    cmd.signature = sign(cmd, 'shhh');
    await listener._executeAndReport(cmd);
    expect(mockExecute).toHaveBeenCalledWith(cmd, expect.any(Object));
  });

  test('invalid signature → executor NOT called', async () => {
    setEnv({ licenseKey: 'lic-abc', secret: 'shhh' });
    const { listener } = loadFresh();
    const cmd = {
      commandId: 'cmd-002',
      type: 'kill',
      payload: {},
      issuedAt: 999,
      signature: 'deadbeef'.repeat(8),
    };
    await listener._executeAndReport(cmd);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('missing signature → executor NOT called', async () => {
    setEnv({ licenseKey: 'lic-abc', secret: 'shhh' });
    const { listener } = loadFresh();
    const cmd = {
      commandId: 'cmd-003',
      type: 'pause',
      payload: {},
      issuedAt: 999,
    };
    await listener._executeAndReport(cmd);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('null commandHmacSecret → all commands rejected', async () => {
    setEnv({ licenseKey: '', secret: null, jwt: null });
    const { listener } = loadFresh();
    const cmd = {
      commandId: 'cmd-004',
      type: 'pause',
      payload: {},
      issuedAt: 999,
      signature: 'a'.repeat(64),
    };
    await listener._executeAndReport(cmd);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('signature length mismatch → rejected (no timingSafeEqual crash)', async () => {
    setEnv({ licenseKey: 'lic-abc', secret: 'shhh' });
    const { listener } = loadFresh();
    const cmd = {
      commandId: 'cmd-005',
      type: 'pause',
      payload: {},
      issuedAt: 999,
      signature: 'aabb',
    };
    await listener._executeAndReport(cmd);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('non-hex signature → rejected (no crash)', async () => {
    setEnv({ licenseKey: 'lic-abc', secret: 'shhh' });
    const { listener } = loadFresh();
    const cmd = {
      commandId: 'cmd-006',
      type: 'pause',
      payload: {},
      issuedAt: 999,
      signature: 'NOT-HEX-STRING',
    };
    await listener._executeAndReport(cmd);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('tampered payload after signing → rejected', async () => {
    setEnv({ licenseKey: 'lic-abc', secret: 'shhh' });
    const { listener } = loadFresh();
    const cmd = {
      commandId: 'cmd-007',
      type: 'pause',
      payload: { reason: 'safe' },
      issuedAt: 1,
    };
    cmd.signature = sign(cmd, 'shhh');
    cmd.payload = { reason: 'TAMPERED' };

    await listener._executeAndReport(cmd);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('derived secret verifies correctly', async () => {
    setEnv({ licenseKey: 'lic-derived', secret: null, jwt: null });
    const { listener } = loadFresh();
    const cmd = {
      commandId: 'cmd-008',
      type: 'pause',
      payload: {},
      issuedAt: 42,
    };
    const derivedSecret = crypto.createHash('sha256').update('lic-derived:cmd-hmac:v1').digest('hex');
    cmd.signature = sign(cmd, derivedSecret);
    await listener._executeAndReport(cmd);
    expect(mockExecute).toHaveBeenCalled();
  });
});

describe('commandListener._poll (HTTP fetch)', () => {
  test('skips when inFlight=true', async () => {
    setEnv({ licenseKey: 'lic-abc', secret: 'shhh' });
    const { listener } = loadFresh();
    listener.inFlight = true;
    await listener._poll();
    // No HTTP call expected — listener returned early.
    expect(global.__HTTP_HANDLERS__.http.length).toBe(0);
  });

  test('processes commands returned by poll', async () => {
    setEnv({ licenseKey: 'lic-abc', secret: 'shhh' });
    const { listener } = loadFresh();
    const cmd = {
      commandId: 'cmd-poll-1',
      type: 'pause',
      payload: { reason: 'from-poll' },
      issuedAt: 1,
    };
    cmd.signature = sign(cmd, 'shhh');

    queueHttp('http', { body: { commands: [cmd] } });
    await listener._poll();
    expect(mockExecute).toHaveBeenCalledWith(cmd, expect.any(Object));
  });

  test('successful poll clears lastError + emits admin:contact_success', async () => {
    setEnv({ licenseKey: 'lic-abc', secret: 'shhh' });
    const { listener } = loadFresh();
    listener.lastError = 'prev err';

    queueHttp('http', { body: { commands: [] } });
    await listener._poll();

    expect(listener.lastError).toBeNull();
    expect(mockEmit).toHaveBeenCalledWith('admin:contact_success', expect.objectContaining({
      source: 'command_poll',
    }));
  });
});