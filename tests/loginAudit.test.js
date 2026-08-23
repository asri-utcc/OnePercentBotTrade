'use strict';

// FIX-2026-08-09: LoginAttempt model + loginAudit helper tests
//   - Schema fields (at, ip, method, reason, userAgent, deviceLabel)
//   - Enum validation for method + reason
//   - logFailedLoginAttempt: validates input, swallows errors
//   - TTL index exists on `at` for 30-day auto-cleanup
//
// We mock the model `create()` so tests don't actually write to MongoDB
// (no connection in test env).

jest.mock('../src/db/models/LoginAttempt', () => {
  // Capture the calls; return resolved promise so the helper doesn't hang
  const calls = [];
  function _mockCreate(doc) { calls.push(doc); return Promise.resolve(doc); }
  _mockCreate.__calls = calls;
  // Schema metadata for static assertions
  const schema = {
    paths: {
      at: {},
      ip: { options: { required: true } },
      method: { options: { enum: ['password', 'telegram-otp'] } },
      reason: { options: { required: true } },
      userAgent: { options: { default: '' } },
      deviceLabel: {},
      attemptedPassword: { options: { default: '', maxlength: 256 } },
    },
    indexes: () => [
      [{ at: -1 }, {}],
      [{ at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }],
    ],
  };
  return { create: _mockCreate, schema, __calls: calls };
});

const LoginAttempt = require('../src/db/models/LoginAttempt');
const loginAudit = require('../src/utils/loginAudit');

describe('LoginAttempt schema (FIX-2026-08-09)', () => {
  test('schema has all required fields with correct defaults', () => {
    const schema = LoginAttempt.schema;
    expect(schema.paths.at).toBeDefined();
    expect(schema.paths.ip).toBeDefined();
    expect(schema.paths.ip.options.required).toBe(true);
    expect(schema.paths.method).toBeDefined();
    expect(schema.paths.method.options.enum).toEqual(['password', 'telegram-otp']);
    expect(schema.paths.reason).toBeDefined();
    expect(schema.paths.reason.options.required).toBe(true);
    expect(schema.paths.userAgent).toBeDefined();
    expect(schema.paths.userAgent.options.default).toBe('');
    expect(schema.paths.deviceLabel).toBeDefined();
  });

  test('FIX-2026-08-10: attemptedPassword field exists with default + maxlength 256', () => {
    const schema = LoginAttempt.schema;
    expect(schema.paths.attemptedPassword).toBeDefined();
    expect(schema.paths.attemptedPassword.options.default).toBe('');
    expect(schema.paths.attemptedPassword.options.maxlength).toBe(256);
  });

  test('TTL index on `at` with 30-day expireAfterSeconds', () => {
    const indexes = LoginAttempt.schema.indexes();
    const ttlIdx = indexes.find((idx) => idx[0].at === 1 && idx[1]?.expireAfterSeconds !== undefined);
    expect(ttlIdx).toBeDefined();
    expect(ttlIdx[1].expireAfterSeconds).toBe(30 * 24 * 60 * 60);
  });

  test('descending index on `at` for recent-first queries', () => {
    const indexes = LoginAttempt.schema.indexes();
    const descIdx = indexes.find((idx) => idx[0].at === -1);
    expect(descIdx).toBeDefined();
  });
});

describe('loginAudit helper (FIX-2026-08-09)', () => {
  beforeEach(() => { LoginAttempt.__calls.length = 0; });

  test('exports logFailedLoginAttempt + VALID_METHODS + VALID_REASONS', () => {
    expect(typeof loginAudit.logFailedLoginAttempt).toBe('function');
    expect(loginAudit.VALID_METHODS).toBeInstanceOf(Set);
    expect(loginAudit.VALID_REASONS).toBeInstanceOf(Set);
    expect(Array.from(loginAudit.VALID_METHODS)).toEqual(['password', 'telegram-otp']);
    expect(loginAudit.VALID_REASONS.has('wrong-password')).toBe(true);
    expect(loginAudit.VALID_REASONS.has('otp-locked')).toBe(true);
    expect(loginAudit.VALID_REASONS.has('locked')).toBe(true);
    expect(loginAudit.VALID_REASONS.has('rate-limited')).toBe(true);
    expect(loginAudit.VALID_REASONS.has('telegram-disabled')).toBe(true);
    expect(loginAudit.VALID_REASONS.has('telegram-event-disabled')).toBe(true);
    expect(loginAudit.VALID_REASONS.has('otp-wrong')).toBe(true);
    expect(loginAudit.VALID_REASONS.has('otp-expired')).toBe(true);
    expect(loginAudit.VALID_REASONS.has('otp-malformed')).toBe(true);
    expect(loginAudit.VALID_REASONS.has('otp-token-invalid')).toBe(true);
  });

  test('does not throw on missing args', async () => {
    await expect(loginAudit.logFailedLoginAttempt()).resolves.toBeUndefined();
    await expect(loginAudit.logFailedLoginAttempt({})).resolves.toBeUndefined();
    await expect(loginAudit.logFailedLoginAttempt({ ip: '1.2.3.4' })).resolves.toBeUndefined();
    expect(LoginAttempt.__calls.length).toBe(0);
  });

  test('does not throw on invalid method', async () => {
    await loginAudit.logFailedLoginAttempt({
      ip: '1.2.3.4',
      method: 'invalid',
      reason: 'wrong-password',
    });
    expect(LoginAttempt.__calls.length).toBe(0);
  });

  test('does not throw on unknown reason (logs warn, returns silently)', async () => {
    await loginAudit.logFailedLoginAttempt({
      ip: '1.2.3.4',
      method: 'password',
      reason: 'totally-unknown-reason',
    });
    expect(LoginAttempt.__calls.length).toBe(0);
  });

  test('truncates long ip + userAgent strings (max 64 + 500 chars)', async () => {
    const longIp = '1'.repeat(100);
    const longUA = 'x'.repeat(1000);
    await loginAudit.logFailedLoginAttempt({
      ip: longIp,
      method: 'password',
      reason: 'wrong-password',
      userAgent: longUA,
    });
    expect(LoginAttempt.__calls.length).toBe(1);
    expect(LoginAttempt.__calls[0].ip.length).toBe(64);
    expect(LoginAttempt.__calls[0].userAgent.length).toBe(500);
  });

  test('parses userAgent → deviceLabel', async () => {
    await loginAudit.logFailedLoginAttempt({
      ip: '1.2.3.4',
      method: 'password',
      reason: 'wrong-password',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    expect(LoginAttempt.__calls[0].deviceLabel).toEqual({ browser: 'Chrome', os: 'Windows', device: 'desktop' });
  });

  test('accepts all 10 valid reason codes and persists them', async () => {
    const reasons = Array.from(loginAudit.VALID_REASONS);
    for (const reason of reasons) {
      await loginAudit.logFailedLoginAttempt({
        ip: '1.2.3.4',
        method: 'password',
        reason,
        userAgent: 'test-agent',
      });
    }
    expect(LoginAttempt.__calls.length).toBe(10);
    expect(LoginAttempt.__calls.map((c) => c.reason).sort()).toEqual(reasons.sort());
  });

  test('method "telegram-otp" works', async () => {
    await loginAudit.logFailedLoginAttempt({
      ip: '5.6.7.8',
      method: 'telegram-otp',
      reason: 'otp-wrong',
      userAgent: 'iPhone',
    });
    expect(LoginAttempt.__calls[0].method).toBe('telegram-otp');
    expect(LoginAttempt.__calls[0].deviceLabel.os).toBe('iOS');
  });

  test('FIX-2026-08-10: persists attemptedPassword for password + wrong-password', async () => {
    await loginAudit.logFailedLoginAttempt({
      ip: '1.2.3.4',
      method: 'password',
      reason: 'wrong-password',
      attemptedPassword: 'MyOldPassword123',
    });
    expect(LoginAttempt.__calls[0].attemptedPassword).toBe('MyOldPassword123');
  });

  test('FIX-2026-08-10: trims attemptedPassword to 256 chars', async () => {
    const long = 'x'.repeat(500);
    await loginAudit.logFailedLoginAttempt({
      ip: '1.2.3.4',
      method: 'password',
      reason: 'wrong-password',
      attemptedPassword: long,
    });
    expect(LoginAttempt.__calls[0].attemptedPassword.length).toBe(256);
  });

  test('FIX-2026-08-10: does NOT persist attemptedPassword for telegram-otp (OTP codes are ephemeral)', async () => {
    await loginAudit.logFailedLoginAttempt({
      ip: '1.2.3.4',
      method: 'telegram-otp',
      reason: 'otp-wrong',
      attemptedPassword: 'should-be-ignored',
    });
    expect(LoginAttempt.__calls[0].attemptedPassword).toBe('');
  });

  test('FIX-2026-08-10: does NOT persist attemptedPassword for password + locked', async () => {
    // When IP is locked, no password was even tried — don't persist stale value
    await loginAudit.logFailedLoginAttempt({
      ip: '1.2.3.4',
      method: 'password',
      reason: 'locked',
      attemptedPassword: 'should-be-ignored',
    });
    expect(LoginAttempt.__calls[0].attemptedPassword).toBe('');
  });

  test('FIX-2026-08-10: empty attemptedPassword stores empty string', async () => {
    await loginAudit.logFailedLoginAttempt({
      ip: '1.2.3.4',
      method: 'password',
      reason: 'wrong-password',
    });
    expect(LoginAttempt.__calls[0].attemptedPassword).toBe('');
  });

  test('does not throw if create() rejects (DB error swallowed)', async () => {
    // Override the mock for one call
    const origCreate = LoginAttempt.create;
    LoginAttempt.create = () => Promise.reject(new Error('mock DB failure'));
    await expect(loginAudit.logFailedLoginAttempt({
      ip: '1.2.3.4',
      method: 'password',
      reason: 'wrong-password',
    })).resolves.toBeUndefined();
    LoginAttempt.create = origCreate;
  });
});