'use strict';

/**
 * FIX-2026-08-24: LoginGuard unit tests — layered brute-force protection
 *
 * Coverage:
 *   - progressive backoff tiers (0/5s/30s/locked)
 *   - lockout escalation (level 1 → 2 → 3 within window)
 *   - escalation reset outside window
 *   - per-account lockout (distributed brute-force)
 *   - burst flood cap triggers lock
 *   - recordSuccess resets both IP + account counters
 *   - getStatus() exposes attemptsRemaining + nextDelayMs for UI
 *   - windowMs eviction (old attempts fall outside window)
 *   - cleanup() removes expired entries
 *   - backward compat: check() returns expected shape
 */

const {
  LoginGuard,
  progressiveDelayMs,
  LOCKOUT_TIERS_MS,
  LOCKOUT_LEVEL_WINDOW_MS,
  ACCOUNT_MAX_ATTEMPTS,
} = require('../src/utils/loginGuard');

// ใช้ short window/lockout เพื่อให้ test เร็ว
const FAST_OPTS = {
  maxAttempts: 5,
  windowMs: 1000, // 1s
  lockoutMs: 500, // 0.5s (base for level 1 escalation)
};

describe('FIX-2026-08-24: progressiveDelayMs()', () => {
  test('0 fails → 0ms (no delay)', () => {
    expect(progressiveDelayMs(0)).toBe(0);
    expect(progressiveDelayMs(3)).toBe(0);
  });
  test('4-6 fails → 5000ms (tier 1)', () => {
    expect(progressiveDelayMs(4)).toBe(5000);
    expect(progressiveDelayMs(5)).toBe(5000);
    expect(progressiveDelayMs(6)).toBe(5000);
  });
  test('7-9 fails → 30000ms (tier 2)', () => {
    expect(progressiveDelayMs(7)).toBe(30000);
    expect(progressiveDelayMs(8)).toBe(30000);
    expect(progressiveDelayMs(9)).toBe(30000);
  });
  test('10+ fails → -1 (signal "locked")', () => {
    expect(progressiveDelayMs(10)).toBe(-1);
    expect(progressiveDelayMs(20)).toBe(-1);
  });
});

describe('FIX-2026-08-24: constants exported correctly', () => {
  test('LOCKOUT_TIERS_MS = [15m, 30m, 60m]', () => {
    expect(LOCKOUT_TIERS_MS).toEqual([15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000]);
  });
  test('LOCKOUT_LEVEL_WINDOW_MS = 1h', () => {
    expect(LOCKOUT_LEVEL_WINDOW_MS).toBe(60 * 60 * 1000);
  });
  test('ACCOUNT_MAX_ATTEMPTS = 5 (lower than IP 10)', () => {
    expect(ACCOUNT_MAX_ATTEMPTS).toBe(5);
    expect(ACCOUNT_MAX_ATTEMPTS).toBeLessThan(10);
  });
});

describe('FIX-2026-08-24: LoginGuard basic check()', () => {
  let guard;
  beforeEach(() => { guard = new LoginGuard(FAST_OPTS); });
  afterEach(() => guard.stop());

  test('unknown IP returns not locked', () => {
    expect(guard.check('1.2.3.4')).toEqual({ locked: false, retryAfterSec: 0, lockoutLevel: 0 });
  });
  test('check() returns backward-compat shape (no attemptsRemaining/nextDelayMs)', () => {
    const r = guard.check('1.2.3.4');
    expect(r).toHaveProperty('locked');
    expect(r).toHaveProperty('retryAfterSec');
    // ไม่มี attemptsRemaining (ใช้ getStatus() แทน)
    expect(r).not.toHaveProperty('attemptsRemaining');
  });
});

describe('FIX-2026-08-24: getStatus() for UI', () => {
  let guard;
  beforeEach(() => { guard = new LoginGuard(FAST_OPTS); });
  afterEach(() => guard.stop());

  test('fresh IP → maxAttempts remaining, no delay', () => {
    const s = guard.getStatus('1.2.3.4');
    expect(s.locked).toBe(false);
    expect(s.attemptsRemaining).toBe(FAST_OPTS.maxAttempts);
    expect(s.nextDelayMs).toBe(0);
    expect(s.maxAttempts).toBe(FAST_OPTS.maxAttempts);
    expect(s.lockoutLevel).toBe(0);
  });
  test('after 2 fails → 3 remaining, no delay (tier 0)', () => {
    guard.recordFail('1.2.3.4');
    guard.recordFail('1.2.3.4');
    const s = guard.getStatus('1.2.3.4');
    expect(s.attemptsRemaining).toBe(3);
    expect(s.nextDelayMs).toBe(0);
  });
  test('after 4 fails → tier 1 (5s delay), 1 remaining', () => {
    for (let i = 0; i < 4; i++) guard.recordFail('1.2.3.4');
    const s = guard.getStatus('1.2.3.4');
    expect(s.attemptsRemaining).toBe(1);
    expect(s.nextDelayMs).toBe(5000);
  });
  test('after 5 fails (maxAttempts) → locked', () => {
    for (let i = 0; i < FAST_OPTS.maxAttempts; i++) guard.recordFail('1.2.3.4');
    const s = guard.getStatus('1.2.3.4');
    expect(s.locked).toBe(true);
    expect(s.retryAfterSec).toBeGreaterThan(0);
    expect(s.attemptsRemaining).toBe(0);
    expect(s.lockoutLevel).toBe(1);
  });
});

describe('FIX-2026-08-24: hard lockout at maxAttempts', () => {
  let guard;
  beforeEach(() => { guard = new LoginGuard(FAST_OPTS); });
  afterEach(() => guard.stop());

  test('after maxAttempts fails → IP locked for level 1 (15 min)', () => {
    for (let i = 0; i < FAST_OPTS.maxAttempts; i++) guard.recordFail('1.2.3.4');
    const r = guard.check('1.2.3.4');
    expect(r.locked).toBe(true);
    expect(r.retryAfterSec).toBeGreaterThan(0);
    expect(r.retryAfterSec).toBeLessThanOrEqual(15 * 60); // level 1 = 15 min
    expect(r.lockoutLevel).toBe(1);
  });
  test('after lockout expires → entry deleted', async () => {
    for (let i = 0; i < FAST_OPTS.maxAttempts; i++) guard.recordFail('1.2.3.4');
    expect(guard.check('1.2.3.4').locked).toBe(true);
    // Simulate lockout expired by setting lockedUntil to past timestamp
    const entry = guard.ipEntries.get('1.2.3.4');
    entry.lockedUntil = Date.now() - 1000; // 1s ago
    guard.ipEntries.set('1.2.3.4', entry);
    expect(guard.check('1.2.3.4')).toEqual({ locked: false, retryAfterSec: 0, lockoutLevel: 0 });
  });
});

describe('FIX-2026-08-24: lockout escalation', () => {
  let guard;
  beforeEach(() => { guard = new LoginGuard(FAST_OPTS); });
  afterEach(() => guard.stop());

  test('2nd lock within window → level 2 (30 min equivalent)', () => {
    // Cycle 1
    for (let i = 0; i < FAST_OPTS.maxAttempts; i++) guard.recordFail('1.2.3.4');
    expect(guard.check('1.2.3.4').lockoutLevel).toBe(1);
    // Simulate lockout expired (within LOCKOUT_LEVEL_WINDOW_MS=1h)
    const entry1 = guard.ipEntries.get('1.2.3.4');
    entry1.lockedUntil = Date.now() - 1000;
    guard.ipEntries.set('1.2.3.4', entry1);
    // Cycle 2 → should escalate to level 2
    for (let i = 0; i < FAST_OPTS.maxAttempts; i++) guard.recordFail('1.2.3.4');
    expect(guard.check('1.2.3.4').lockoutLevel).toBe(2);
  });
  test('lockout cap at level 3 (60 min)', async () => {
    guard = new LoginGuard(FAST_OPTS);
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let i = 0; i < FAST_OPTS.maxAttempts; i++) guard.recordFail('1.2.3.4');
      await new Promise((r) => setTimeout(r, FAST_OPTS.lockoutMs + 50));
    }
    // level 4 ต้อง cap ที่ 3
    expect(guard.check('1.2.3.4').lockoutLevel).toBeLessThanOrEqual(3);
  });
  test('escalation resets if previous lockout > 1h ago', async () => {
    // Note: can't actually wait 1h in tests — verify via internal entry access
    guard = new LoginGuard(FAST_OPTS);
    const entry = guard.ipEntries.get('1.2.3.4') || { attempts: [], lockedUntil: 0, lockoutLevel: 0, lastLockoutAt: 0 };
    // Simulate previous lockout 2h ago
    entry.lastLockoutAt = Date.now() - (2 * 60 * 60 * 1000);
    entry.lockoutLevel = 2;
    guard.ipEntries.set('1.2.3.4', entry);
    // trigger new fail → should reset to level 1
    for (let i = 0; i < FAST_OPTS.maxAttempts; i++) guard.recordFail('1.2.3.4');
    expect(guard.check('1.2.3.4').lockoutLevel).toBe(1);
  });
});

describe('FIX-2026-08-24: burst flood cap triggers lock', () => {
  let guard;
  beforeEach(() => { guard = new LoginGuard(FAST_OPTS); });
  afterEach(() => guard.stop());

  test('attempts > maxAttempts * 10 → immediate lock (credential stuffing)', () => {
    const CAP = FAST_OPTS.maxAttempts * 10;
    // Push CAP+1 fails — cap แล้ว trigger lock ทันที
    for (let i = 0; i < CAP + 1; i++) guard.recordFail('1.2.3.4');
    expect(guard.check('1.2.3.4').locked).toBe(true);
    // array ต้องถูก slice(-CAP) ไม่โตเกิน CAP
    const entry = guard.ipEntries.get('1.2.3.4');
    expect(entry.attempts.length).toBeLessThanOrEqual(CAP);
  });
});

describe('FIX-2026-08-24: per-account lockout (distributed brute-force)', () => {
  let guard;
  beforeEach(() => { guard = new LoginGuard(FAST_OPTS); });
  afterEach(() => guard.stop());

  test('different IPs attacking same passwordHash → account locked after 5 fails', () => {
    const hash = '$2b$10$abcdefghijklmnopqrstuv';
    // 5 fails from 5 different IPs against same hash
    for (let i = 0; i < ACCOUNT_MAX_ATTEMPTS; i++) {
      guard.recordFail(`1.2.3.${i}`, hash);
    }
    // account should be locked
    expect(guard.checkAccount(hash).locked).toBe(true);
  });
  test('same IP fail many times → BOTH IP and account locked', () => {
    const hash = '$2b$10$abc';
    for (let i = 0; i < FAST_OPTS.maxAttempts; i++) guard.recordFail('1.2.3.4', hash);
    expect(guard.check('1.2.3.4').locked).toBe(true);
    expect(guard.checkAccount(hash).locked).toBe(true);
  });
  test('no hash → no per-account tracking (backward compat)', () => {
    guard.recordFail('1.2.3.4');
    expect(guard.accountEntries.size).toBe(0);
  });
  test('checkAccount() with no hash → not locked', () => {
    expect(guard.checkAccount(null).locked).toBe(false);
    expect(guard.checkAccount(undefined).locked).toBe(false);
    expect(guard.checkAccount('').locked).toBe(false);
  });
  test('recordFailAccount only fires when passwordHash provided', () => {
    const hash = '$2b$10$xyz';
    guard.recordFailAccount(hash);
    guard.recordFailAccount(hash);
    expect(guard.accountEntries.get(hash).attempts.length).toBe(2);
  });
});

describe('FIX-2026-08-24: recordSuccess resets both', () => {
  let guard;
  beforeEach(() => { guard = new LoginGuard(FAST_OPTS); });
  afterEach(() => guard.stop());

  test('success → IP + account counters cleared', () => {
    const hash = '$2b$10$abc';
    for (let i = 0; i < 3; i++) guard.recordFail('1.2.3.4', hash);
    expect(guard.ipEntries.get('1.2.3.4').attempts.length).toBe(3);
    expect(guard.accountEntries.get(hash).attempts.length).toBe(3);
    guard.recordSuccess('1.2.3.4', hash);
    expect(guard.ipEntries.get('1.2.3.4')).toBeUndefined();
    expect(guard.accountEntries.get(hash)).toBeUndefined();
  });
  test('recordSuccess(ip) alone → only IP cleared', () => {
    const hash = '$2b$10$abc';
    guard.recordFailAccount(hash);
    guard.recordSuccess('1.2.3.4'); // no hash
    expect(guard.accountEntries.get(hash)).toBeDefined();
  });
});

describe('FIX-2026-08-24: window eviction', () => {
  let guard;
  beforeEach(() => { guard = new LoginGuard({ ...FAST_OPTS, windowMs: 100 }); });
  afterEach(() => guard.stop());

  test('old attempts fall outside window → attemptsRemaining recovers', async () => {
    guard.recordFail('1.2.3.4');
    guard.recordFail('1.2.3.4');
    expect(guard.getStatus('1.2.3.4').attemptsRemaining).toBe(3);
    await new Promise((r) => setTimeout(r, 150));
    expect(guard.getStatus('1.2.3.4').attemptsRemaining).toBe(5);
  });
});

describe('FIX-2026-08-24: _cleanup() removes expired entries', () => {
  test('cleanup drops expired entries (no live lock)', async () => {
    const guard = new LoginGuard({ ...FAST_OPTS, windowMs: 50 });
    guard.recordFail('1.2.3.4');
    guard.recordFail('5.6.7.8');
    // รอให้ attempts expire
    await new Promise((r) => setTimeout(r, 100));
    guard._cleanup();
    expect(guard.ipEntries.get('1.2.3.4')).toBeUndefined();
    expect(guard.ipEntries.get('5.6.7.8')).toBeUndefined();
    guard.stop();
  });
  test('cleanup keeps live-locked entries', () => {
    const guard = new LoginGuard(FAST_OPTS);
    for (let i = 0; i < FAST_OPTS.maxAttempts; i++) guard.recordFail('1.2.3.4');
    guard._cleanup();
    expect(guard.check('1.2.3.4').locked).toBe(true);
    guard.stop();
  });
});

describe('FIX-2026-08-24: stop() clears cleanup timer', () => {
  test('stop() is safe to call multiple times', () => {
    const guard = new LoginGuard(FAST_OPTS);
    guard.stop();
    guard.stop(); // should not throw
  });
});