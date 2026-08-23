'use strict';

const path = require('path');

// FIX-2026-08-07: Phase 3 (CBv2 panic-close for disabled bots) — guard unit tests
//   Tests PositionWatchdog._cbv2SkipReason — the pure helper that decides whether
//   to skip CBv2 for a given bot. Mirrors the runtime decision order in
//   _checkCBv2PanicCloseForDisabled so any future reorder breaks a test.
//
// Why a pure helper instead of mocking DB/models:
//   - All other Phase 3 code (Binance getKlines, computeBgStates, forceCloseTrade,
//     telegramNotifier.sendNow) require heavy mocking; testing that integration
//     adds noise without increasing confidence.
//   - The 6 guard conditions are the most critical decision points:
//     misordering or wrong evaluation could fire CBv2 on healthy bots or skip
//     actual panic scenarios. These deserve dedicated tests.
//   - Pattern detection (isCBv2At) is already covered by tests/isCBv2At.test.js.

const positionWatchdog = require('../src/services/positionWatchdog');
// The singleton exposes the class as a property so tests can call static methods
const PositionWatchdog = positionWatchdog.PositionWatchdog;

// Helper: build a bot doc with only the fields used by _cbv2SkipReason
function mkBot(overrides = {}) {
  return {
    _id: 'bot123',
    name: 'TEST-3M',
    symbol: 'TESTUSDT',
    timeframe: '3m',
    cbv2Enabled: true,
    cbv2LockedUntil: null,
    dcaEnabled: false,
    ...overrides,
  };
}

describe('PositionWatchdog._cbv2SkipReason (Phase 3 guard helper)', () => {
  const FIXED_NOW = 1_700_000_000_000; // deterministic reference time

  // ─── Guard order — first match wins ──────────────────────────────────────
  describe('guard order (first match wins)', () => {
    test('null bot → "no_bot" wins over every other guard', () => {
      const reason = PositionWatchdog._cbv2SkipReason(null, 1, 30, FIXED_NOW);
      expect(reason).toBe('no_bot');
    });

    test('cbv2Enabled===false wins over cooldown_active', () => {
      // If disabled, cooldown window is irrelevant — disabled state takes priority
      const bot = mkBot({
        cbv2Enabled: false,
        cbv2LockedUntil: new Date(FIXED_NOW + 1_000_000),
      });
      expect(PositionWatchdog._cbv2SkipReason(bot, 1, 30, FIXED_NOW)).toBe('disabled');
    });

    test('cooldown_active wins over DCA mode', () => {
      const bot = mkBot({
        cbv2LockedUntil: new Date(FIXED_NOW + 3_600_000),
        dcaEnabled: true,
      });
      expect(PositionWatchdog._cbv2SkipReason(bot, 1, 30, FIXED_NOW)).toBe('cooldown_active');
    });

    test('DCA mode wins over no_positions', () => {
      const bot = mkBot({ dcaEnabled: true });
      // Even with no positions, DCA bot is skipped — never fire CBv2 on DCA
      expect(PositionWatchdog._cbv2SkipReason(bot, 0, 30, FIXED_NOW)).toBe('dca_mode');
    });

    test('no_positions wins over warmup', () => {
      const bot = mkBot();
      // No positions + insufficient klines → no_positions takes priority
      // (a bot with no positions doesn't need CBv2 even if warmup incomplete)
      expect(PositionWatchdog._cbv2SkipReason(bot, 0, 5, FIXED_NOW)).toBe('no_positions');
    });
  });

  // ─── Guard 1: disabled by user ─────────────────────────────────────────
  describe('Guard 1: cbv2Enabled === false', () => {
    test('disabled bot → skip with "disabled"', () => {
      const bot = mkBot({ cbv2Enabled: false });
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 30, FIXED_NOW)).toBe('disabled');
    });

    test('enabled bot (default) → no skip from this guard', () => {
      const bot = mkBot({ cbv2Enabled: true });
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });

    test('cbv2Enabled undefined → treated as enabled (default semantics)', () => {
      const bot = mkBot();
      delete bot.cbv2Enabled;
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });
  });

  // ─── Guard 2: cooldown already active ───────────────────────────────────
  describe('Guard 2: bot.cbv2LockedUntil > now', () => {
    test('cooldown expiry in the future → skip with "cooldown_active"', () => {
      const bot = mkBot({ cbv2LockedUntil: new Date(FIXED_NOW + 3_600_000) });
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 30, FIXED_NOW)).toBe('cooldown_active');
    });

    test('cooldown expiry exactly now → NOT active (== is not >)', () => {
      const bot = mkBot({ cbv2LockedUntil: new Date(FIXED_NOW) });
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });

    test('cooldown expiry in the past → NOT active', () => {
      const bot = mkBot({ cbv2LockedUntil: new Date(FIXED_NOW - 1) });
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });

    test('cooldown expiry null → NOT active', () => {
      const bot = mkBot({ cbv2LockedUntil: null });
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });

    test('cooldown expiry undefined → NOT active', () => {
      const bot = mkBot();
      delete bot.cbv2LockedUntil;
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });

    test('invalid cooldown expiry string → Date parse → check > now', () => {
      // Invalid date in JS becomes Invalid Date whose getTime() is NaN — NaN > any === false
      // → helper should NOT skip (graceful fallback)
      const bot = mkBot({ cbv2LockedUntil: new Date('not-a-date') });
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });
  });

  // ─── Guard 3: DCA mode ──────────────────────────────────────────────────
  describe('Guard 3: bot.dcaEnabled === true', () => {
    test('DCA bot → skip with "dca_mode" (mirror trader._isDcaMode)', () => {
      const bot = mkBot({ dcaEnabled: true });
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 30, FIXED_NOW)).toBe('dca_mode');
    });

    test('non-DCA bot (default) → no skip from this guard', () => {
      const bot = mkBot({ dcaEnabled: false });
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });

    test('dcaEnabled undefined → NOT DCA', () => {
      const bot = mkBot();
      delete bot.dcaEnabled;
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });
  });

  // ─── Guard 4: no positions for this bot ─────────────────────────────────
  describe('Guard 4: trades.length === 0', () => {
    test('zero trades → skip with "no_positions"', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv2SkipReason(bot, 0, 30, FIXED_NOW)).toBe('no_positions');
    });

    test('non-integer trades count → "no_positions" (NaN check)', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv2SkipReason(bot, NaN, 30, FIXED_NOW)).toBe('no_positions');
      expect(PositionWatchdog._cbv2SkipReason(bot, undefined, 30, FIXED_NOW)).toBe('no_positions');
      expect(PositionWatchdog._cbv2SkipReason(bot, null, 30, FIXED_NOW)).toBe('no_positions');
    });

    test('one trade → NOT no_positions (proceed with further checks)', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv2SkipReason(bot, 1, 30, FIXED_NOW)).toBeNull();
    });
  });

  // ─── Guard 5: kline warmup ──────────────────────────────────────────────
  // FIX-2026-08-09: threshold raised 21 → 23 (cbPatternEvaluator.MIN_EVALUATION_CANDLES)
  //   - 20 for EMA(20) + ATR(20) seed + 3 for isCBv2At(i-3) lookup
  describe('Guard 5: klines.length < 23 (warmup)', () => {
    test('klines null (not fetched) → no skip from this guard yet', () => {
      // The first decision uses klinesLen=null because klines not fetched yet;
      // warmup check happens AFTER kline fetch in the runtime loop.
      const bot = mkBot();
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, null, FIXED_NOW)).toBeNull();
    });

    test('0 klines → skip with "warmup"', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 0, FIXED_NOW)).toBe('warmup');
    });

    test('22 klines (just below threshold) → skip with "warmup"', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 22, FIXED_NOW)).toBe('warmup');
    });

    test('23 klines (exactly threshold) → no skip', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 23, FIXED_NOW)).toBeNull();
    });

    test('30 klines (typical) → no skip', () => {
      const bot = mkBot();
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
    });
  });

  // ─── Happy path — all guards pass, proceed ──────────────────────────────
  describe('happy path — all guards pass', () => {
    test('enabled bot + no cooldown + non-DCA + has positions + warm klines → null (proceed)', () => {
      const bot = mkBot();
      const reason = PositionWatchdog._cbv2SkipReason(bot, 3, 30, FIXED_NOW);
      expect(reason).toBeNull();
    });
  });

  // ─── Re-fetch pattern parity check ──────────────────────────────────────
  describe('decision stability across re-fetch', () => {
    test('same bot evaluated before/after kline fetch returns consistent decisions', () => {
      const bot = mkBot();
      // Before fetch
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, null, FIXED_NOW)).toBeNull();
      // After fetch with sufficient klines
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 30, FIXED_NOW)).toBeNull();
      // After fetch with insufficient klines
      expect(PositionWatchdog._cbv2SkipReason(bot, 5, 10, FIXED_NOW)).toBe('warmup');
    });
  });
});
