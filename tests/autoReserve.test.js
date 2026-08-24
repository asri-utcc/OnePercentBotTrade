'use strict';

/**
 * FIX-2026-08-24: Unit tests for Auto Reserve / Release USDT pure calculator
 *
 * Covers:
 *   - computeAvailablePoles: usablePoleCount + lossPoleCount math, NaN guards,
 *     DCA-stack-friendly shape, empty positions, zero/negative inputs
 *   - decideAction: reserve / release / none branches, MAX_RESERVE clamp,
 *     release floor at 0, exact match → no action, NaN guards
 *
 * No MongoDB or Binance needed — pure functions only.
 */

const autoReserve = require('../src/services/autoReserve');

describe('autoReserve — pure calculator functions', () => {
  // ─────────────────────────────────────────────────────────────────
  // computeAvailablePoles
  // ─────────────────────────────────────────────────────────────────
  describe('computeAvailablePoles', () => {
    test('exports function', () => {
      expect(typeof autoReserve.computeAvailablePoles).toBe('function');
    });

    test('exports OPEN_POSITIONS_STATES constant', () => {
      expect(Array.isArray(autoReserve.OPEN_POSITIONS_STATES)).toBe(true);
      expect(autoReserve.OPEN_POSITIONS_STATES).toContain('placed');
      expect(autoReserve.OPEN_POSITIONS_STATES).toContain('filled');
      expect(autoReserve.OPEN_POSITIONS_STATES).toContain('holding');
    });

    test('basic: usable=22 USDT / 10 per pole → 2 usable poles', () => {
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 22,
        usdtPerPole: 10,
        positions: [],
        lossThresholdPct: 2,
      });
      expect(r.usablePoleCount).toBe(2);
      expect(r.lossPoleCount).toBe(0);
      expect(r.availablePoleCount).toBe(2);
    });

    test('basic: floor — 29 USDT / 10 per pole → 2 usable (not 3)', () => {
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 29,
        usdtPerPole: 10,
        positions: [],
        lossThresholdPct: 2,
      });
      expect(r.usablePoleCount).toBe(2);
    });

    test('exact: 30 USDT / 10 per pole → 3 usable', () => {
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 30,
        usdtPerPole: 10,
        positions: [],
        lossThresholdPct: 2,
      });
      expect(r.usablePoleCount).toBe(3);
    });

    test('usableUsdt=0 → 0 usable poles (not NaN)', () => {
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 0,
        usdtPerPole: 10,
        positions: [],
        lossThresholdPct: 2,
      });
      expect(r.usablePoleCount).toBe(0);
    });

    test('usableUsdt negative → 0 usable poles (guard)', () => {
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: -50,
        usdtPerPole: 10,
        positions: [],
        lossThresholdPct: 2,
      });
      expect(r.usablePoleCount).toBe(0);
    });

    test('NaN guards — unusable inputs return zero', () => {
      const r1 = autoReserve.computeAvailablePoles({ usableUsdt: NaN, usdtPerPole: 10, positions: [], lossThresholdPct: 2 });
      expect(r1.usablePoleCount).toBe(0);
      const r2 = autoReserve.computeAvailablePoles({ usableUsdt: 100, usdtPerPole: NaN, positions: [], lossThresholdPct: 2 });
      expect(r2.usablePoleCount).toBe(0);
      const r3 = autoReserve.computeAvailablePoles({ usableUsdt: 100, usdtPerPole: 0, positions: [], lossThresholdPct: 2 });
      expect(r3.usablePoleCount).toBe(0);
    });

    test('empty positions → lossPoleCount=0', () => {
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 50,
        usdtPerPole: 10,
        positions: [],
        lossThresholdPct: 2,
      });
      expect(r.lossPoleCount).toBe(0);
      expect(r.availablePoleCount).toBe(5);
    });

    test('loss pole: position with -1.5% loss (<2%) → counts as 1 loss pole', () => {
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 50,
        usdtPerPole: 10,
        positions: [{ entry: 100, qty: 10, currentPrice: 98.5 }], // -1.5%
        lossThresholdPct: 2,
      });
      expect(r.lossPoleCount).toBe(1);
      expect(r.usablePoleCount).toBe(5);
      expect(r.availablePoleCount).toBe(6);
    });

    test('loss pole: position with -5% loss (>2%) → NOT counted', () => {
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 50,
        usdtPerPole: 10,
        positions: [{ entry: 100, qty: 10, currentPrice: 95 }], // -5%
        lossThresholdPct: 2,
      });
      expect(r.lossPoleCount).toBe(0);
    });

    test('profit position (+1%) → NOT counted as loss pole', () => {
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 50,
        usdtPerPole: 10,
        positions: [{ entry: 100, qty: 10, currentPrice: 101 }], // +1%
        lossThresholdPct: 2,
      });
      expect(r.lossPoleCount).toBe(0);
    });

    test('exact threshold (-2% exactly) → NOT counted (strict less-than)', () => {
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 50,
        usdtPerPole: 10,
        positions: [{ entry: 100, qty: 10, currentPrice: 98 }], // -2% exact
        lossThresholdPct: 2,
      });
      expect(r.lossPoleCount).toBe(0);
    });

    test('just-below threshold (-1.99%) → counted', () => {
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 50,
        usdtPerPole: 10,
        positions: [{ entry: 100, qty: 10, currentPrice: 98.01 }], // -1.99%
        lossThresholdPct: 2,
      });
      expect(r.lossPoleCount).toBe(1);
    });

    test('multiple positions: mix of loss/profit/zero → counted correctly', () => {
      const positions = [
        { entry: 100, qty: 10, currentPrice: 99 },     // -1% → count
        { entry: 100, qty: 10, currentPrice: 98 },     // -2% exact → skip
        { entry: 100, qty: 10, currentPrice: 101 },    // +1% → skip
        { entry: 100, qty: 10, currentPrice: 90 },     // -10% → skip (too big)
        { entry: 100, qty: 10, currentPrice: 99.5 },   // -0.5% → count
      ];
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 50,
        usdtPerPole: 10,
        positions,
        lossThresholdPct: 2,
      });
      expect(r.lossPoleCount).toBe(2);
    });

    test('skips positions with invalid entry/qty', () => {
      const positions = [
        { entry: 0, qty: 10, currentPrice: 100 },       // entry=0 → skip
        { entry: 100, qty: 0, currentPrice: 100 },      // qty=0 → skip
        { entry: NaN, qty: 10, currentPrice: 100 },     // NaN entry → skip
        { entry: 100, qty: 10, currentPrice: 99 },       // valid -1% → count
      ];
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 50,
        usdtPerPole: 10,
        positions,
        lossThresholdPct: 2,
      });
      expect(r.lossPoleCount).toBe(1);
    });

    test('positions is null → lossPoleCount=0 (no throw)', () => {
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 50,
        usdtPerPole: 10,
        positions: null,
        lossThresholdPct: 2,
      });
      expect(r.lossPoleCount).toBe(0);
    });

    test('NaN lossThresholdPct → lossPoleCount=0 (guard)', () => {
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 50,
        usdtPerPole: 10,
        positions: [{ entry: 100, qty: 10, currentPrice: 99 }],
        lossThresholdPct: NaN,
      });
      expect(r.lossPoleCount).toBe(0);
    });

    test('custom threshold: 5% threshold captures -3% loss', () => {
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 50,
        usdtPerPole: 10,
        positions: [{ entry: 100, qty: 10, currentPrice: 97 }], // -3%
        lossThresholdPct: 5,
      });
      expect(r.lossPoleCount).toBe(1);
    });

    test('DCA stack shape: stackBep + stackTotalQty mapped to entry/qty', () => {
      const positions = [
        { entry: 95, qty: 25, currentPrice: 94 }, // -1.05% on stackBep
      ];
      const r = autoReserve.computeAvailablePoles({
        usableUsdt: 30,
        usdtPerPole: 10,
        positions,
        lossThresholdPct: 2,
      });
      expect(r.lossPoleCount).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // decideAction
  // ─────────────────────────────────────────────────────────────────
  describe('decideAction', () => {
    test('exports function', () => {
      expect(typeof autoReserve.decideAction).toBe('function');
    });

    test('exact match (available == target) → none, deltaUsdt=0', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 3,
        targetPoleCount: 3,
        reserveUsdt: 30,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('none');
      expect(r.deltaUsdt).toBe(0);
      expect(r.afterReserve).toBe(30);
      expect(r.reason).toBe('in_target');
    });

    test('available > target → reserve stepUsdt', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 5,
        targetPoleCount: 3,
        reserveUsdt: 30,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('reserve');
      expect(r.deltaUsdt).toBe(10);
      expect(r.afterReserve).toBe(40);
      expect(r.reason).toBe('available_exceeds_target');
    });

    test('available < target → release stepUsdt', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 1,
        targetPoleCount: 3,
        reserveUsdt: 30,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('release');
      expect(r.deltaUsdt).toBe(10);
      expect(r.afterReserve).toBe(20);
      expect(r.reason).toBe('available_below_target');
    });

    test('release floor: reserveUsdt=5, step=10 → release ALL remaining 5 (FIX-2026-08-24)', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 0,
        targetPoleCount: 3,
        reserveUsdt: 5,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('release');
      expect(r.afterReserve).toBe(0);
      expect(r.deltaUsdt).toBe(5);
      expect(r.reason).toBe('release_remaining_below_step'); // FIX-2026-08-24 new reason
    });

    test('FIX-2026-08-24: reserve=3, step=10 → release 3, after=0', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 0,
        targetPoleCount: 3,
        reserveUsdt: 3,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('release');
      expect(r.deltaUsdt).toBe(3);
      expect(r.afterReserve).toBe(0);
      expect(r.reason).toBe('release_remaining_below_step');
    });

    test('FIX-2026-08-24: reserve=1, step=10 → release 1 (drain to zero)', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 0,
        targetPoleCount: 3,
        reserveUsdt: 1,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('release');
      expect(r.deltaUsdt).toBe(1);
      expect(r.afterReserve).toBe(0);
      expect(r.reason).toBe('release_remaining_below_step');
    });

    test('release full step: reserve=30, step=10 → release exactly 10', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 0,
        targetPoleCount: 5,
        reserveUsdt: 30,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('release');
      expect(r.deltaUsdt).toBe(10);
      expect(r.afterReserve).toBe(20);
      expect(r.reason).toBe('available_below_target'); // not the new reason — has enough
    });

    test('release at zero: reserveUsdt=0 → none (reserve_already_zero)', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 0,
        targetPoleCount: 3,
        reserveUsdt: 0,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('none');
      expect(r.deltaUsdt).toBe(0);
      expect(r.afterReserve).toBe(0);
      expect(r.reason).toBe('reserve_already_zero');
    });

    test('reserve clamp: totalUsdt < reserve+step → SKIP (insufficient_usable_for_step) — FIX-2026-08-24 no partial', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 5,
        targetPoleCount: 3,
        reserveUsdt: 95,
        stepUsdt: 10,
        totalUsdt: 100, // total = reserve(95) + usable(5) < step(10)
      });
      expect(r.action).toBe('none');
      expect(r.afterReserve).toBe(95); // unchanged
      expect(r.deltaUsdt).toBe(0);
      expect(r.reason).toBe('insufficient_usable_for_step');
    });

    test('reserve already at total → none (insufficient_usable_for_step) — FIX-2026-08-24', () => {
      // reserve=total → usable=0 → can't do full step → skip
      // (reserve_at_max only triggers if safeReserve+step > MAX_RESERVE=1M)
      const r = autoReserve.decideAction({
        availablePoleCount: 5,
        targetPoleCount: 3,
        reserveUsdt: 100,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('none');
      expect(r.deltaUsdt).toBe(0);
      expect(r.afterReserve).toBe(100);
      expect(r.reason).toBe('insufficient_usable_for_step');
    });

    test('totalUsdt=0 → SKIP (no usable) — FIX-2026-08-24 no partial', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 5,
        targetPoleCount: 3,
        reserveUsdt: 0,
        stepUsdt: 10,
        totalUsdt: 0,
      });
      expect(r.action).toBe('none');
      expect(r.afterReserve).toBe(0);
      expect(r.reason).toBe('insufficient_usable_for_step');
    });

    test('FIX-2026-08-24: usable=2, reserve=50, step=10 → SKIP (insufficient_usable_for_step)', () => {
      // real-world scenario: 5 loss poles counted, usable only 2 USDT
      // ระบบต้องการ reserve 10 แต่มีแค่ 2 → ข้าม รอบถัดไป
      const r = autoReserve.decideAction({
        availablePoleCount: 5,
        targetPoleCount: 3,
        reserveUsdt: 50,
        stepUsdt: 10,
        totalUsdt: 52, // total = reserve(50) + usable(2)
      });
      expect(r.action).toBe('none');
      expect(r.deltaUsdt).toBe(0);
      expect(r.afterReserve).toBe(50); // unchanged
      expect(r.reason).toBe('insufficient_usable_for_step');
    });

    test('FIX-2026-08-24: usable=step exactly → reserve (full step boundary)', () => {
      // usable = 10, step = 10 → exactly full step available
      const r = autoReserve.decideAction({
        availablePoleCount: 5,
        targetPoleCount: 3,
        reserveUsdt: 90,
        stepUsdt: 10,
        totalUsdt: 100, // usable = 10 = step
      });
      expect(r.action).toBe('reserve');
      expect(r.deltaUsdt).toBe(10);
      expect(r.afterReserve).toBe(100);
      expect(r.reason).toBe('available_exceeds_target');
    });

    test('FIX-2026-08-24: usable = step-1 → SKIP (off-by-one boundary)', () => {
      // usable = 9, step = 10 → 9 < 10 → skip
      const r = autoReserve.decideAction({
        availablePoleCount: 5,
        targetPoleCount: 3,
        reserveUsdt: 91,
        stepUsdt: 10,
        totalUsdt: 100, // usable = 9 = step - 1
      });
      expect(r.action).toBe('none');
      expect(r.reason).toBe('insufficient_usable_for_step');
    });

    test('stepUsdt=0 → none (zero_step)', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 5,
        targetPoleCount: 3,
        reserveUsdt: 30,
        stepUsdt: 0,
        totalUsdt: 100,
      });
      expect(r.action).toBe('none');
      expect(r.reason).toBe('zero_step');
    });

    test('NaN stepUsdt → none (zero_step)', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 5,
        targetPoleCount: 3,
        reserveUsdt: 30,
        stepUsdt: NaN,
        totalUsdt: 100,
      });
      expect(r.action).toBe('none');
      expect(r.reason).toBe('zero_step');
    });

    test('NaN availablePoleCount → none (invalid_pole_count)', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: NaN,
        targetPoleCount: 3,
        reserveUsdt: 30,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('none');
      expect(r.reason).toBe('invalid_pole_count');
    });

    test('NaN targetPoleCount → none (invalid_pole_count)', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 3,
        targetPoleCount: NaN,
        reserveUsdt: 30,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('none');
      expect(r.reason).toBe('invalid_pole_count');
    });

    test('negative reserveUsdt treated as 0 — reserves from 0 forward', () => {
      // safeReserve = max(0, -10) = 0; after = min(MAX, total, 0+10) = 10; delta = 10-0 = 10
      const r = autoReserve.decideAction({
        availablePoleCount: 5,
        targetPoleCount: 3,
        reserveUsdt: -10,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('reserve');
      expect(r.afterReserve).toBe(10);
      expect(r.deltaUsdt).toBe(10);
    });

    test('negative reserveUsdt on release path — release floor at 0', () => {
      // safeReserve = 0; available=0 < target=3 → release; after = max(0, 0-10) = 0; delta = 0
      const r = autoReserve.decideAction({
        availablePoleCount: 0,
        targetPoleCount: 3,
        reserveUsdt: -50,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('none');
      expect(r.afterReserve).toBe(0);
      expect(r.deltaUsdt).toBe(0);
      expect(r.reason).toBe('reserve_already_zero');
    });

    test('boundary: available = target + 1 → reserve step', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 4,
        targetPoleCount: 3,
        reserveUsdt: 30,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('reserve');
      expect(r.deltaUsdt).toBe(10);
    });

    test('boundary: available = target - 1 → release step', () => {
      const r = autoReserve.decideAction({
        availablePoleCount: 2,
        targetPoleCount: 3,
        reserveUsdt: 30,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('release');
      expect(r.deltaUsdt).toBe(10);
    });

    test('large step: step=100, available > target → SKIP (insufficient_usable_for_step) — FIX-2026-08-24', () => {
      // ก่อนหน้านี้: partial reserve (delta=70). หลังแก้: skip ทั้งดอก
      const r = autoReserve.decideAction({
        availablePoleCount: 20,
        targetPoleCount: 3,
        reserveUsdt: 30,
        stepUsdt: 100,
        totalUsdt: 100, // total = reserve(30) + usable(70) < step(100)
      });
      expect(r.action).toBe('none');
      expect(r.afterReserve).toBe(30); // unchanged
      expect(r.deltaUsdt).toBe(0);
      expect(r.reason).toBe('insufficient_usable_for_step');
    });

    test('release when availableUsdt already covers: multiple-step gap', () => {
      // available=0, target=5, reserve=50 → release 10 → after=40
      const r = autoReserve.decideAction({
        availablePoleCount: 0,
        targetPoleCount: 5,
        reserveUsdt: 50,
        stepUsdt: 10,
        totalUsdt: 100,
      });
      expect(r.action).toBe('release');
      expect(r.afterReserve).toBe(40);
      expect(r.deltaUsdt).toBe(10);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Integration: combine computeAvailablePoles + decideAction
  // ─────────────────────────────────────────────────────────────────
  describe('integration: computeAvailablePoles + decideAction', () => {
    test('default scenario: 22 USDT + 1 small-loss position + 3 target = no action', () => {
      // usable=22 → 2 poles; +1 loss pole (-1.5%) = 3 available = 3 target → none
      const positions = [{ entry: 100, qty: 10, currentPrice: 98.5 }];
      const { availablePoleCount } = autoReserve.computeAvailablePoles({
        usableUsdt: 22,
        usdtPerPole: 10,
        positions,
        lossThresholdPct: 2,
      });
      expect(availablePoleCount).toBe(3);
      const decision = autoReserve.decideAction({
        availablePoleCount,
        targetPoleCount: 3,
        reserveUsdt: 30,
        stepUsdt: 10,
        totalUsdt: 52, // total = reserve(30) + usable(22)
      });
      expect(decision.action).toBe('none');
    });

    test('rich: 100 USDT + 5 loss poles + 3 target → reserve', () => {
      const positions = Array(5).fill({ entry: 100, qty: 10, currentPrice: 99 });
      const { availablePoleCount } = autoReserve.computeAvailablePoles({
        usableUsdt: 100,
        usdtPerPole: 10,
        positions,
        lossThresholdPct: 2,
      });
      expect(availablePoleCount).toBe(15); // 10 usable + 5 loss
      const decision = autoReserve.decideAction({
        availablePoleCount,
        targetPoleCount: 3,
        reserveUsdt: 30,
        stepUsdt: 10,
        totalUsdt: 200,
      });
      expect(decision.action).toBe('reserve');
      expect(decision.afterReserve).toBe(40);
    });

    test('poor: 0 USDT + 0 positions + 3 target → release', () => {
      const { availablePoleCount } = autoReserve.computeAvailablePoles({
        usableUsdt: 0,
        usdtPerPole: 10,
        positions: [],
        lossThresholdPct: 2,
      });
      expect(availablePoleCount).toBe(0);
      const decision = autoReserve.decideAction({
        availablePoleCount,
        targetPoleCount: 3,
        reserveUsdt: 30,
        stepUsdt: 10,
        totalUsdt: 30,
      });
      expect(decision.action).toBe('release');
      expect(decision.afterReserve).toBe(20);
    });
  });
});