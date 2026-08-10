'use strict';

const path = require('path');

// FIX-2026-08-10: Phase 5 (CBv5 panic-close for disabled bots) — guard unit tests
//   Tests PositionWatchdog._cbv5SkipReason — the pure helper that decides whether
//   to skip CBv5 for a given bot. Mirrors the runtime decision order in
//   _checkCBv5PanicCloseForDisabled so any future reorder breaks a test.
//
// CBv5 is independent of cbVersion enum — Phase 5 has NO version gate. Only the
// per-bot cbv5Enabled + cooldown + DCA checks apply.

const positionWatchdog = require('../src/services/positionWatchdog');
const PositionWatchdog = positionWatchdog.PositionWatchdog;

function mkBot(overrides = {}) {
  return {
    _id: 'bot-cbv5',
    name: 'TEST-CBv5',
    symbol: 'TESTUSDT',
    timeframe: '3m',
    cbv5Enabled: true,
    cbv5LockedUntil: null,
    dcaEnabled: false,
    ...overrides,
  };
}

describe('PositionWatchdog._cbv5SkipReason (Phase 5 guard helper)', () => {
  const FIXED_NOW = 1_700_000_000_000;

  // ─── Guard order — first match wins ──────────────────────────────────────
  describe('guard order (first match wins)', () => {
    test('null bot → "no_bot" wins over every other guard', () => {
      expect(PositionWatchdog._cbv5SkipReason(null, 1, 30, FIXED_NOW)).toBe('no_bot');
    });

    test('cbv5Enabled===false wins over cooldown_active', () => {
      const bot = mkBot({
        cbv5Enabled: false,
        cbv5LockedUntil: new Date(FIXED_NOW + 1_000_000),
      });
      expect(PositionWatchdog._cbv5SkipReason(bot, 1, 30, FIXED_NOW)).toBe('disabled');
    });

    test('cooldown_active wins over DCA mode', () => {
      const bot = mkBot({
        cbv5LockedUntil: new Date(FIXED_NOW + 3_600_000),
        dcaEnabled: true,
      });
      expect(PositionWatchdog._cbv5SkipReason(bot, 1, 30, FIXED_NOW)).toBe('cooldown_active');
    });

    test('DCA mode wins over no_positions', () => {
      const bot = mkBot({ dcaEnabled: true });
      expect(PositionWatchdog._cbv5SkipReason(bot, 0, 30, FIXED_NOW)).toBe('dca_mode');
    });

    test('no_positions wins over warmup', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv5SkipReason(bot, 0, 5, FIXED_NOW)).toBe('no_positions');
    });
  });

  // ─── Guard 1: disabled by user ─────────────────────────────────────────
  describe('Guard 1: cbv5Enabled === false', () => {
    test('disabled bot → skip with "disabled"', () => {
      const bot = mkBot({ cbv5Enabled: false });
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 30, FIXED_NOW)).toBe('disabled');
    });

    test('enabled bot (default) → no skip from this guard', () => {
      const bot = mkBot({ cbv5Enabled: true });
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });

    test('cbv5Enabled undefined → treated as enabled (default semantics)', () => {
      const bot = mkBot();
      delete bot.cbv5Enabled;
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });
  });

  // ─── Guard 2: cooldown already active ───────────────────────────────────
  describe('Guard 2: bot.cbv5LockedUntil > now', () => {
    test('cooldown expiry in the future → skip with "cooldown_active"', () => {
      const bot = mkBot({ cbv5LockedUntil: new Date(FIXED_NOW + 3_600_000) });
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 30, FIXED_NOW)).toBe('cooldown_active');
    });

    test('cooldown expiry exactly now → NOT active (== is not >)', () => {
      const bot = mkBot({ cbv5LockedUntil: new Date(FIXED_NOW) });
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });

    test('cooldown expiry in the past → NOT active', () => {
      const bot = mkBot({ cbv5LockedUntil: new Date(FIXED_NOW - 1) });
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });

    test('cooldown expiry null → NOT active', () => {
      const bot = mkBot({ cbv5LockedUntil: null });
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });

    test('invalid cooldown expiry string → graceful fallback', () => {
      const bot = mkBot({ cbv5LockedUntil: new Date('not-a-date') });
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });
  });

  // ─── Guard 3: DCA mode ──────────────────────────────────────────────────
  describe('Guard 3: bot.dcaEnabled === true', () => {
    test('DCA bot → skip with "dca_mode" (mirror trader._isDcaMode)', () => {
      const bot = mkBot({ dcaEnabled: true });
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 30, FIXED_NOW)).toBe('dca_mode');
    });

    test('non-DCA bot (default) → no skip from this guard', () => {
      const bot = mkBot({ dcaEnabled: false });
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });
  });

  // ─── Guard 4: no positions for this bot ─────────────────────────────────
  describe('Guard 4: trades.length === 0', () => {
    test('zero trades → skip with "no_positions"', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv5SkipReason(bot, 0, 30, FIXED_NOW)).toBe('no_positions');
    });

    test('non-integer trades count → "no_positions" (NaN check)', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv5SkipReason(bot, NaN, 30, FIXED_NOW)).toBe('no_positions');
      expect(PositionWatchdog._cbv5SkipReason(bot, undefined, 30, FIXED_NOW)).toBe('no_positions');
      expect(PositionWatchdog._cbv5SkipReason(bot, null, 30, FIXED_NOW)).toBe('no_positions');
    });

    test('one trade → NOT no_positions (proceed with further checks)', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv5SkipReason(bot, 1, 30, FIXED_NOW)).toBeNull();
    });
  });

  // ─── Guard 5: kline warmup ──────────────────────────────────────────────
  // FIX-2026-08-10: cbPatternEvaluator.MIN_EVALUATION_CANDLES=23 baseline (KC EMA+ATR)
  describe('Guard 5: klines.length < 23 (warmup)', () => {
    test('klines null (not fetched) → no skip from this guard yet', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, null, FIXED_NOW)).toBeNull();
    });

    test('0 klines → skip with "warmup"', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 0, FIXED_NOW)).toBe('warmup');
    });

    test('22 klines (just below threshold) → skip with "warmup"', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 22, FIXED_NOW)).toBe('warmup');
    });

    test('23 klines (exactly threshold) → no skip', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 23, FIXED_NOW)).toBeNull();
    });
  });

  // ─── Happy path — all guards pass ──────────────────────────────────────
  describe('happy path — all guards pass', () => {
    test('enabled bot + no cooldown + non-DCA + has positions + warm klines → null', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv5SkipReason(bot, 3, 30, FIXED_NOW)).toBeNull();
    });
  });

  // ─── Independence from cbVersion ───────────────────────────────────────
  // CBv5 has NO version gate (independent of cbVersion enum). The helper does
  // not consult bot.cbVersion at all — Phase 5 runs in parallel with Phase 3/4.
  describe('independence from cbVersion', () => {
    test('cbVersion=undefined (no master config yet) → CBv5 still proceeds', () => {
      const bot = mkBot();
      delete bot.cbVersion;
      expect(PositionWatchdog._cbv5SkipReason(bot, 3, 30, FIXED_NOW)).toBeNull();
    });

    test('cbVersion=v2 → CBv5 still proceeds (in parallel with CBv2)', () => {
      const bot = mkBot({ cbVersion: 'v2' });
      expect(PositionWatchdog._cbv5SkipReason(bot, 3, 30, FIXED_NOW)).toBeNull();
    });

    test('cbVersion=v3 → CBv5 still proceeds (in parallel with CBv3)', () => {
      const bot = mkBot({ cbVersion: 'v3' });
      expect(PositionWatchdog._cbv5SkipReason(bot, 3, 30, FIXED_NOW)).toBeNull();
    });
  });

  // ─── Decision stability across re-fetch ─────────────────────────────────
  describe('decision stability across re-fetch', () => {
    test('same bot evaluated before/after kline fetch returns consistent decisions', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, null, FIXED_NOW)).toBeNull();
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
      expect(PositionWatchdog._cbv5SkipReason(bot, 5, 10, FIXED_NOW)).toBe('warmup');
    });
  });
});