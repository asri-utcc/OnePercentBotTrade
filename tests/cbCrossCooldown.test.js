'use strict';

/**
 * FIX-2026-08-10: Unit tests for cbCrossCooldown.applyCrossCooldownOnFire.
 *
 * Covers Direction A (CBv5 → CBv2/CBv3) and Direction B (CBv2/CBv3 → CBv5)
 * per user spec.
 */

const { applyCrossCooldownOnFire } = require('../src/core/cbCrossCooldown');

const FIXED_NOW = 1_700_000_000_000;
const HOUR_MS = 3600 * 1000;

function mkBot(overrides = {}) {
  return {
    cbv2LockedUntil: null,
    cbv2LockReason: null,
    cbv2LastFiredAt: null,
    cbv3LockedUntil: null,
    cbv3LockReason: null,
    cbv3LastFiredAt: null,
    cbv5LockedUntil: null,
    cbv5LockReason: null,
    cbv5LastFiredAt: null,
    ...overrides,
  };
}

describe('cbCrossCooldown.applyCrossCooldownOnFire', () => {
  describe('Direction A — CBv5 active, CBv2/CBv3 fires (cancel CBv5, apply new)', () => {
    test('CBv5 active → CBv3 fires → cancel CBv5, apply CBv3 from now', () => {
      const priorV5Fire = new Date(FIXED_NOW - 2 * HOUR_MS);
      const bot = mkBot({
        cbv5LockedUntil: new Date(FIXED_NOW + 3 * HOUR_MS),
        cbv5LockReason: 'cbv5_panic',
        cbv5LastFiredAt: priorV5Fire, // set audit timestamp
      });
      const r = applyCrossCooldownOnFire({
        bot, firingVersion: 'v3', lockHours: 8, nowMs: FIXED_NOW,
      });
      expect(r.appliedTo).toBe('cbv3-canceled-cbv5');
      expect(bot.cbv5LockedUntil).toBeNull();
      expect(bot.cbv5LockReason).toBeNull();
      expect(bot.cbv3LockedUntil.getTime()).toBe(FIXED_NOW + 8 * HOUR_MS);
      expect(bot.cbv3LockReason).toBe('cbv3_panic');
      expect(bot.cbv3LastFiredAt).toEqual(new Date(FIXED_NOW));
      // cbv5LastFiredAt preserved as audit (NOT cleared)
      expect(bot.cbv5LastFiredAt).toEqual(priorV5Fire);
    });

    test('CBv5 active → CBv2 fires → cancel CBv5, apply CBv2 from now', () => {
      const bot = mkBot({
        cbv5LockedUntil: new Date(FIXED_NOW + 3 * HOUR_MS),
        cbv5LockReason: 'cbv5_panic',
      });
      const r = applyCrossCooldownOnFire({
        bot, firingVersion: 'v2', lockHours: 8, nowMs: FIXED_NOW,
      });
      expect(r.appliedTo).toBe('cbv2-canceled-cbv5');
      expect(bot.cbv5LockedUntil).toBeNull();
      expect(bot.cbv5LockReason).toBeNull();
      expect(bot.cbv2LockedUntil.getTime()).toBe(FIXED_NOW + 8 * HOUR_MS);
      expect(bot.cbv2LockReason).toBe('cbv2_panic');
    });

    test('no CBv5 active → CBv3 fires → fresh apply (no cancel)', () => {
      const bot = mkBot();
      const r = applyCrossCooldownOnFire({
        bot, firingVersion: 'v3', lockHours: 8, nowMs: FIXED_NOW,
      });
      expect(r.appliedTo).toBe('cbv3-fresh');
      expect(bot.cbv5LockedUntil).toBeNull();
      expect(bot.cbv3LockedUntil.getTime()).toBe(FIXED_NOW + 8 * HOUR_MS);
    });

    test('CBv5 already expired (in past) → CBv3 fires → fresh apply', () => {
      const bot = mkBot({
        cbv5LockedUntil: new Date(FIXED_NOW - HOUR_MS), // expired 1h ago
        cbv5LockReason: 'cbv5_panic',
      });
      const r = applyCrossCooldownOnFire({
        bot, firingVersion: 'v3', lockHours: 8, nowMs: FIXED_NOW,
      });
      expect(r.appliedTo).toBe('cbv3-fresh'); // treated as no active CBv5
      // bot.cbv5LockedUntil should remain as user set (we don't auto-clear expired)
      expect(bot.cbv5LockedUntil.getTime()).toBe(FIXED_NOW - HOUR_MS);
      expect(bot.cbv3LockedUntil.getTime()).toBe(FIXED_NOW + 8 * HOUR_MS);
    });
  });

  describe('Direction B — CBv2/CBv3 active, CBv5 fires (absorbed into existing)', () => {
    test('CBv3 (1h left) + CBv5 fires (4h) → CBv3 extended to T+4h, cbv5LockedUntil=null', () => {
      const bot = mkBot({
        cbv3LockedUntil: new Date(FIXED_NOW + 1 * HOUR_MS),
        cbv3LockReason: 'cbv3_panic',
      });
      const r = applyCrossCooldownOnFire({
        bot, firingVersion: 'v5', lockHours: 4, nowMs: FIXED_NOW,
      });
      expect(r.appliedTo).toBe('cbv5-extended-cbv3');
      expect(bot.cbv5LockedUntil).toBeNull();
      expect(bot.cbv5LockReason).toBeNull();
      // cbv3 extended to now + 4h (since 4h > 1h remaining)
      expect(bot.cbv3LockedUntil.getTime()).toBe(FIXED_NOW + 4 * HOUR_MS);
      // audit preserved
      expect(bot.cbv5LastFiredAt).toEqual(new Date(FIXED_NOW));
    });

    test('CBv3 (6h left) + CBv5 fires (4h) → CBv3 unchanged, cbv5LockedUntil=null', () => {
      const bot = mkBot({
        cbv3LockedUntil: new Date(FIXED_NOW + 6 * HOUR_MS),
        cbv3LockReason: 'cbv3_panic',
      });
      const r = applyCrossCooldownOnFire({
        bot, firingVersion: 'v5', lockHours: 4, nowMs: FIXED_NOW,
      });
      expect(r.appliedTo).toBe('cbv5-absorbed-by-cbv3');
      expect(bot.cbv5LockedUntil).toBeNull();
      // cbv3 unchanged (4h < 6h remaining)
      expect(bot.cbv3LockedUntil.getTime()).toBe(FIXED_NOW + 6 * HOUR_MS);
    });

    test('CBv2 (1h left) + CBv5 fires (4h) → CBv2 extended to T+4h, cbv5LockedUntil=null', () => {
      const bot = mkBot({
        cbv2LockedUntil: new Date(FIXED_NOW + 1 * HOUR_MS),
        cbv2LockReason: 'cbv2_panic',
      });
      const r = applyCrossCooldownOnFire({
        bot, firingVersion: 'v5', lockHours: 4, nowMs: FIXED_NOW,
      });
      expect(r.appliedTo).toBe('cbv5-extended-cbv2');
      expect(bot.cbv5LockedUntil).toBeNull();
      expect(bot.cbv2LockedUntil.getTime()).toBe(FIXED_NOW + 4 * HOUR_MS);
    });

    test('CBv2 (6h left) + CBv5 fires (4h) → CBv2 unchanged, cbv5LockedUntil=null', () => {
      const bot = mkBot({
        cbv2LockedUntil: new Date(FIXED_NOW + 6 * HOUR_MS),
      });
      const r = applyCrossCooldownOnFire({
        bot, firingVersion: 'v5', lockHours: 4, nowMs: FIXED_NOW,
      });
      expect(r.appliedTo).toBe('cbv5-absorbed-by-cbv2');
      expect(bot.cbv5LockedUntil).toBeNull();
      expect(bot.cbv2LockedUntil.getTime()).toBe(FIXED_NOW + 6 * HOUR_MS);
    });

    test('CBv2 (2h) + CBv3 (3h) + CBv5 fires (5h) → CBv3 extended to T+5h (CBv3 wins tie-break, 5h > 3h remaining)', () => {
      const bot = mkBot({
        cbv2LockedUntil: new Date(FIXED_NOW + 2 * HOUR_MS),
        cbv3LockedUntil: new Date(FIXED_NOW + 3 * HOUR_MS),
      });
      const r = applyCrossCooldownOnFire({
        bot, firingVersion: 'v5', lockHours: 5, nowMs: FIXED_NOW,
      });
      expect(r.appliedTo).toBe('cbv5-extended-cbv3');
      expect(bot.cbv5LockedUntil).toBeNull();
      // CBv3 extended from T+3h to T+5h (5h > 3h)
      expect(bot.cbv3LockedUntil.getTime()).toBe(FIXED_NOW + 5 * HOUR_MS);
      // CBv2 untouched
      expect(bot.cbv2LockedUntil.getTime()).toBe(FIXED_NOW + 2 * HOUR_MS);
    });

    test('CBv2 (2h) + CBv3 (3h) + CBv5 fires (2h) → CBv3 still wins (2h < 3h remaining, unchanged)', () => {
      const bot = mkBot({
        cbv2LockedUntil: new Date(FIXED_NOW + 2 * HOUR_MS),
        cbv3LockedUntil: new Date(FIXED_NOW + 3 * HOUR_MS),
      });
      const r = applyCrossCooldownOnFire({
        bot, firingVersion: 'v5', lockHours: 2, nowMs: FIXED_NOW,
      });
      expect(r.appliedTo).toBe('cbv5-absorbed-by-cbv3');
      expect(bot.cbv5LockedUntil).toBeNull();
      // CBv3 stays at T+3h (not extended because CBv5's 2h < 3h remaining)
      expect(bot.cbv3LockedUntil.getTime()).toBe(FIXED_NOW + 3 * HOUR_MS);
      // CBv2 untouched
      expect(bot.cbv2LockedUntil.getTime()).toBe(FIXED_NOW + 2 * HOUR_MS);
    });

    test('no active cooldowns + CBv5 fires (4h) → cbv5LockedUntil=T+4h', () => {
      const bot = mkBot();
      const r = applyCrossCooldownOnFire({
        bot, firingVersion: 'v5', lockHours: 4, nowMs: FIXED_NOW,
      });
      expect(r.appliedTo).toBe('cbv5-new');
      expect(bot.cbv5LockedUntil.getTime()).toBe(FIXED_NOW + 4 * HOUR_MS);
      expect(bot.cbv5LockReason).toBe('cbv5_panic');
    });
  });

  describe('audit timestamps', () => {
    test('CBv5 fires → cbv5LastFiredAt always updated', () => {
      const bot = mkBot();
      applyCrossCooldownOnFire({ bot, firingVersion: 'v5', lockHours: 4, nowMs: FIXED_NOW });
      expect(bot.cbv5LastFiredAt).toEqual(new Date(FIXED_NOW));
    });

    test('CBv2 fires → cbv2LastFiredAt updated, cbv5LastFiredAt preserved if was set', () => {
      const oldV5Fire = new Date(FIXED_NOW - 2 * HOUR_MS);
      const bot = mkBot({ cbv5LastFiredAt: oldV5Fire });
      applyCrossCooldownOnFire({ bot, firingVersion: 'v2', lockHours: 8, nowMs: FIXED_NOW });
      expect(bot.cbv2LastFiredAt).toEqual(new Date(FIXED_NOW));
      expect(bot.cbv5LastFiredAt).toEqual(oldV5Fire); // preserved
    });
  });

  describe('validation', () => {
    test('invalid firingVersion throws', () => {
      expect(() => applyCrossCooldownOnFire({
        bot: mkBot(), firingVersion: 'v9', lockHours: 4, nowMs: FIXED_NOW,
      })).toThrow(/unsupported firingVersion/);
    });

    test('invalid lockHours throws', () => {
      expect(() => applyCrossCooldownOnFire({
        bot: mkBot(), firingVersion: 'v5', lockHours: 0, nowMs: FIXED_NOW,
      })).toThrow(/lockHours must be/);
      expect(() => applyCrossCooldownOnFire({
        bot: mkBot(), firingVersion: 'v5', lockHours: -1, nowMs: FIXED_NOW,
      })).toThrow(/lockHours must be/);
    });

    test('missing bot throws', () => {
      expect(() => applyCrossCooldownOnFire({
        bot: null, firingVersion: 'v5', lockHours: 4, nowMs: FIXED_NOW,
      })).toThrow(/bot is required/);
    });
  });
});
