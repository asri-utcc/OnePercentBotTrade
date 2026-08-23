'use strict';

/**
 * FIX-2026-08-12 (audit Q9+Q3+Q14): Tests for cbv5MasterToggle + unified tradeStates + dedup.
 *   - cbv5MasterToggle: 4-site master gate (trader + trader pre-BUY + watchdog Phase 5 + skipReason)
 *   - tradeStates: unified atomic force-close state set
 *   - telegram dedup: per-bot per-version 60s latch
 */

const { isMasterCbv5Enabled, isMasterCbv5EnabledCached, invalidateCache } = require('../src/core/cbv5MasterToggle');
const { ATOMIC_FORCE_CLOSE_STATES, FORCE_OPEN_STATES } = require('../src/core/tradeStates');

describe('cbv5MasterToggle', () => {
  beforeEach(() => invalidateCache());

  // Note: async isMasterCbv5Enabled() requires MongoDB connection — skipped in test env
  // (covered by integration tests). Only sync helpers testable here.

  test('cached value returns true initially (safe default: master ON)', () => {
    expect(isMasterCbv5EnabledCached()).toBe(true);
  });

  test('invalidateCache resets to default ON', () => {
    expect(typeof invalidateCache).toBe('function');
    invalidateCache();
    expect(isMasterCbv5EnabledCached()).toBe(true);
  });

  test('isMasterCbv5EnabledCached is synchronous (used by pure helper _cbv5SkipReason)', () => {
    // The watchdog _cbv5SkipReason is a pure static function — needs sync read
    expect(typeof isMasterCbv5EnabledCached).toBe('function');
    const v = isMasterCbv5EnabledCached();
    expect(typeof v).toBe('boolean');
  });

  test('isMasterCbv5Enabled is async (used by trader + trader pre-BUY)', () => {
    // Both trader._checkCBv5PanicClose and pre-BUY are async sites
    expect(isMasterCbv5Enabled.constructor.name).toBe('AsyncFunction');
  });
});

describe('tradeStates — shared force-close state sets', () => {
  test('FORCE_OPEN_STATES is 8 states (includes placed)', () => {
    expect(FORCE_OPEN_STATES.length).toBe(8);
    expect(FORCE_OPEN_STATES).toContain('placed');
    expect(FORCE_OPEN_STATES).toContain('stopping');
  });

  test('ATOMIC_FORCE_CLOSE_STATES is 7 states (excludes placed)', () => {
    expect(ATOMIC_FORCE_CLOSE_STATES.length).toBe(7);
    expect(ATOMIC_FORCE_CLOSE_STATES).not.toContain('placed');
    expect(ATOMIC_FORCE_CLOSE_STATES).toContain('stopping');
    expect(ATOMIC_FORCE_CLOSE_STATES).toContain('filled');
  });

  test('FORCE_OPEN_STATES is a superset of ATOMIC_FORCE_CLOSE_STATES', () => {
    for (const s of ATOMIC_FORCE_CLOSE_STATES) {
      expect(FORCE_OPEN_STATES).toContain(s);
    }
  });

  test('only difference between sets is "placed" (manual force-close of pending BUY)', () => {
    const diff = FORCE_OPEN_STATES.filter(s => !ATOMIC_FORCE_CLOSE_STATES.includes(s));
    expect(diff).toEqual(['placed']);
  });

  test('both sets are frozen (immutable shared constants)', () => {
    expect(Object.isFrozen(FORCE_OPEN_STATES)).toBe(true);
    expect(Object.isFrozen(ATOMIC_FORCE_CLOSE_STATES)).toBe(true);
  });
});

describe('cbCrossCooldown — Direction A/B symmetry (audit Q4)', () => {
  const { applyCrossCooldownOnFire } = require('../src/core/cbCrossCooldown');

  test('Direction A: CBv2 fires while CBv5 active → CBv5 cancelled, CBv2 takes lock', () => {
    const now = Date.now();
    const bot = {
      cbv5LockedUntil: new Date(now + 3 * 3600 * 1000), // 3h remaining
    };
    const result = applyCrossCooldownOnFire({
      bot, firingVersion: 'v2', lockHours: 8, nowMs: now,
    });
    expect(result.cbv5LockedUntil).toBeNull();
    expect(result.cbv2LockedUntil).toBeTruthy();
    expect(result.appliedTo).toBe('cbv2-canceled-cbv5');
  });

  test('Direction A: CBv3 fires while CBv5 active → CBv5 cancelled, CBv3 takes lock', () => {
    const now = Date.now();
    const bot = {
      cbv5LockedUntil: new Date(now + 3 * 3600 * 1000),
    };
    const result = applyCrossCooldownOnFire({
      bot, firingVersion: 'v3', lockHours: 8, nowMs: now,
    });
    expect(result.cbv5LockedUntil).toBeNull();
    expect(result.cbv3LockedUntil).toBeTruthy();
    expect(result.appliedTo).toBe('cbv3-canceled-cbv5');
  });

  test('Direction B: CBv5 fires while CBv2 active → CBv5 absorbed into CBv2', () => {
    const now = Date.now();
    const bot = {
      cbv2LockedUntil: new Date(now + 6 * 3600 * 1000), // 6h remaining
    };
    const result = applyCrossCooldownOnFire({
      bot, firingVersion: 'v5', lockHours: 4, nowMs: now,
    });
    expect(result.cbv5LockedUntil).toBeNull();
    expect(result.cbv2LockedUntil).toBeTruthy();
    expect(result.appliedTo).toContain('cbv5-absorbed-by-cbv2');
  });

  test('No active CB: CBv5 takes its own lock', () => {
    const now = Date.now();
    const bot = {};
    const result = applyCrossCooldownOnFire({
      bot, firingVersion: 'v5', lockHours: 4, nowMs: now,
    });
    expect(result.cbv5LockedUntil).toBeTruthy();
    expect(result.appliedTo).toBe('cbv5-new');
  });
});

