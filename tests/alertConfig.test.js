'use strict';

/**
 * FIX-2026-08-27 Phase 3b-2: alertConfig helper unit tests
 *
 *   - getEffectiveThresholds merges defaults + user input
 *   - shouldAlertCbPanic: closedCount >= cbPanicMinPositions (defensive fallbacks)
 *   - parseHHmm: accepts valid HH:mm, rejects garbage
 *   - toMinutes: HH:mm → total minutes since midnight
 *   - isInQuietHours: respects enabled flag + start/end + handles midnight wrap
 */

const {
  DEFAULT_ALERT_THRESHOLDS,
  getEffectiveThresholds,
  shouldAlertCbPanic,
  parseHHmm,
  toMinutes,
  isInQuietHours,
} = require('../src/services/alertConfig');

describe('alertConfig — defaults', () => {
  test('DEFAULT_ALERT_THRESHOLDS exposes 4 keys with sane defaults', () => {
    expect(DEFAULT_ALERT_THRESHOLDS).toEqual({
      cbPanicMinPositions: 1,
      quietHoursEnabled: false,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
    });
  });
  test('DEFAULT_ALERT_THRESHOLDS is frozen (no runtime mutation)', () => {
    expect(Object.isFrozen(DEFAULT_ALERT_THRESHOLDS)).toBe(true);
    expect(() => { DEFAULT_ALERT_THRESHOLDS.cbPanicMinPositions = 999; }).toThrow();
  });
});

describe('alertConfig.getEffectiveThresholds', () => {
  test('returns defaults when user input is undefined/null/empty', () => {
    expect(getEffectiveThresholds()).toEqual(DEFAULT_ALERT_THRESHOLDS);
    expect(getEffectiveThresholds(null)).toEqual(DEFAULT_ALERT_THRESHOLDS);
    expect(getEffectiveThresholds({})).toEqual(DEFAULT_ALERT_THRESHOLDS);
  });
  test('user value wins per-field, defaults fill gaps', () => {
    const merged = getEffectiveThresholds({ cbPanicMinPositions: 5 });
    expect(merged.cbPanicMinPositions).toBe(5);
    expect(merged.quietHoursEnabled).toBe(false);
    expect(merged.quietHoursStart).toBe('22:00');
    expect(merged.quietHoursEnd).toBe('07:00');
  });
  test('does not mutate input object', () => {
    const input = { cbPanicMinPositions: 5 };
    const inputClone = { ...input };
    getEffectiveThresholds(input);
    expect(input).toEqual(inputClone);
  });
  test('does not mutate DEFAULT_ALERT_THRESHOLDS', () => {
    const before = JSON.stringify(DEFAULT_ALERT_THRESHOLDS);
    getEffectiveThresholds({ cbPanicMinPositions: 5 });
    expect(JSON.stringify(DEFAULT_ALERT_THRESHOLDS)).toBe(before);
  });
});

describe('alertConfig.shouldAlertCbPanic', () => {
  test('default (cbPanicMin=1) → always alert', () => {
    expect(shouldAlertCbPanic(0, {})).toBe(false); // 0 closed = no positions, still suppress
    expect(shouldAlertCbPanic(1, {})).toBe(true);
    expect(shouldAlertCbPanic(100, {})).toBe(true);
  });
  test('cbPanicMin=3 → suppress below 3', () => {
    expect(shouldAlertCbPanic(0, { cbPanicMinPositions: 3 })).toBe(false);
    expect(shouldAlertCbPanic(2, { cbPanicMinPositions: 3 })).toBe(false);
    expect(shouldAlertCbPanic(3, { cbPanicMinPositions: 3 })).toBe(true);
    expect(shouldAlertCbPanic(10, { cbPanicMinPositions: 3 })).toBe(true);
  });
  test('cbPanicMin=5 (basic tier) → big panic only', () => {
    expect(shouldAlertCbPanic(4, { cbPanicMinPositions: 5 })).toBe(false);
    expect(shouldAlertCbPanic(5, { cbPanicMinPositions: 5 })).toBe(true);
  });
  test('invalid cbPanicMin (string, NaN, undefined) → fall back to 1', () => {
    expect(shouldAlertCbPanic(1, { cbPanicMinPositions: 'abc' })).toBe(true);
    expect(shouldAlertCbPanic(1, { cbPanicMinPositions: NaN })).toBe(true);
    expect(shouldAlertCbPanic(1, { cbPanicMinPositions: undefined })).toBe(true);
  });
  test('cbPanicMin<1 (0, -1, 0.5) → treat as 1 (always alert)', () => {
    expect(shouldAlertCbPanic(1, { cbPanicMinPositions: 0 })).toBe(true);
    expect(shouldAlertCbPanic(1, { cbPanicMinPositions: -1 })).toBe(true);
    expect(shouldAlertCbPanic(1, { cbPanicMinPositions: 0.5 })).toBe(true);
  });
  test('invalid closedCount (string, null, undefined) → treat as 0 → suppress when min>=1', () => {
    expect(shouldAlertCbPanic('abc', { cbPanicMinPositions: 1 })).toBe(false);
    expect(shouldAlertCbPanic(null, { cbPanicMinPositions: 1 })).toBe(false);
    expect(shouldAlertCbPanic(undefined, { cbPanicMinPositions: 1 })).toBe(false);
  });
  test('null/undefined thresholds → fall back to defaults', () => {
    expect(shouldAlertCbPanic(1, null)).toBe(true);
    expect(shouldAlertCbPanic(1, undefined)).toBe(true);
    expect(shouldAlertCbPanic(0, null)).toBe(false);
  });
});

describe('alertConfig.parseHHmm', () => {
  test('valid HH:mm strings', () => {
    expect(parseHHmm('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseHHmm('07:00')).toEqual({ hour: 7, minute: 0 });
    expect(parseHHmm('22:30')).toEqual({ hour: 22, minute: 30 });
    expect(parseHHmm('23:59')).toEqual({ hour: 23, minute: 59 });
  });
  test('single-digit hour/minute accepted', () => {
    expect(parseHHmm('7:00')).toEqual({ hour: 7, minute: 0 });
    expect(parseHHmm('7:5')).toEqual({ hour: 7, minute: 5 });
  });
  test('whitespace tolerated', () => {
    expect(parseHHmm('  22:00  ')).toEqual({ hour: 22, minute: 0 });
  });
  test('invalid → null', () => {
    expect(parseHHmm('24:00')).toBeNull();        // hour out of range
    expect(parseHHmm('22:60')).toBeNull();        // minute out of range
    expect(parseHHmm('25:00')).toBeNull();
    expect(parseHHmm('-1:00')).toBeNull();
    expect(parseHHmm('22')).toBeNull();           // missing minute
    expect(parseHHmm('22:00:00')).toBeNull();     // too many parts
    expect(parseHHmm('abc')).toBeNull();
    expect(parseHHmm('')).toBeNull();
    expect(parseHHmm(null)).toBeNull();
    expect(parseHHmm(undefined)).toBeNull();
    expect(parseHHmm(123)).toBeNull();
  });
});

describe('alertConfig.toMinutes', () => {
  test('valid HH:mm → minutes since midnight', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('07:00')).toBe(420);
    expect(toMinutes('12:00')).toBe(720);
    expect(toMinutes('22:00')).toBe(1320);
    expect(toMinutes('23:59')).toBe(1439);
  });
  test('invalid → null', () => {
    expect(toMinutes('24:00')).toBeNull();
    expect(toMinutes('abc')).toBeNull();
    expect(toMinutes(null)).toBeNull();
  });
});

describe('alertConfig.isInQuietHours', () => {
  // Helper: build a Date at given hour:minute on any date (Date is irrelevant for HH:mm compare)
  function atDate(h, m) {
    const d = new Date(2026, 7, 27, h, m, 0); // 2026-08-27 (any date works)
    return d;
  }

  test('quietHoursEnabled=false → always false regardless of time', () => {
    expect(isInQuietHours(atDate(3, 0), { quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00' })).toBe(false);
    expect(isInQuietHours(atDate(23, 0), { quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00' })).toBe(false);
  });

  test('wrap-around window 22:00–07:00 — night time suppressed', () => {
    const cfg = { quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00' };
    expect(isInQuietHours(atDate(22, 0), cfg)).toBe(true);  // start (inclusive)
    expect(isInQuietHours(atDate(23, 30), cfg)).toBe(true);
    expect(isInQuietHours(atDate(0, 0), cfg)).toBe(true);   // after midnight
    expect(isInQuietHours(atDate(3, 15), cfg)).toBe(true);
    expect(isInQuietHours(atDate(6, 59), cfg)).toBe(true);
    expect(isInQuietHours(atDate(7, 0), cfg)).toBe(false);  // end (exclusive)
    expect(isInQuietHours(atDate(12, 0), cfg)).toBe(false); // daytime OK
    expect(isInQuietHours(atDate(21, 59), cfg)).toBe(false);
  });

  test('same-day window 09:00–17:00 — work hours suppressed', () => {
    const cfg = { quietHoursEnabled: true, quietHoursStart: '09:00', quietHoursEnd: '17:00' };
    expect(isInQuietHours(atDate(8, 59), cfg)).toBe(false);
    expect(isInQuietHours(atDate(9, 0), cfg)).toBe(true);
    expect(isInQuietHours(atDate(12, 30), cfg)).toBe(true);
    expect(isInQuietHours(atDate(16, 59), cfg)).toBe(true);
    expect(isInQuietHours(atDate(17, 0), cfg)).toBe(false); // end exclusive
    expect(isInQuietHours(atDate(22, 0), cfg)).toBe(false);
    expect(isInQuietHours(atDate(3, 0), cfg)).toBe(false);
  });

  test('degenerate window start==end → never quiet (fail-open)', () => {
    const cfg = { quietHoursEnabled: true, quietHoursStart: '12:00', quietHoursEnd: '12:00' };
    expect(isInQuietHours(atDate(12, 0), cfg)).toBe(false);
    expect(isInQuietHours(atDate(0, 0), cfg)).toBe(false);
  });

  test('invalid times → fail-open (return false)', () => {
    const cfg = { quietHoursEnabled: true, quietHoursStart: 'bad', quietHoursEnd: '07:00' };
    expect(isInQuietHours(atDate(3, 0), cfg)).toBe(false);
    const cfg2 = { quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: 'alsobad' };
    expect(isInQuietHours(atDate(3, 0), cfg2)).toBe(false);
  });

  test('null/undefined thresholds → return false (no quiet hours)', () => {
    expect(isInQuietHours(atDate(3, 0), null)).toBe(false);
    expect(isInQuietHours(atDate(3, 0), undefined)).toBe(false);
    expect(isInQuietHours(atDate(3, 0), {})).toBe(false); // enabled not true
  });

  test('invalid Date → return false (fail-open)', () => {
    const cfg = { quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00' };
    expect(isInQuietHours(new Date('not-a-date'), cfg)).toBe(false);
  });

  test('now defaults to current Date when omitted', () => {
    // Sanity — just call without `now` arg, ensure no throw
    expect(() => isInQuietHours(undefined, { quietHoursEnabled: false })).not.toThrow();
  });

  test('coerces non-Date `now` to Date', () => {
    const cfg = { quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00' };
    // passing a string that Date() can parse — should not throw
    expect(() => isInQuietHours('2026-08-27T03:00:00', cfg)).not.toThrow();
  });
});

describe('alertConfig — integration scenarios', () => {
  test('basic-tier small account: cbPanicMin=3 + quiet hours → no spam at night', () => {
    const thresholds = {
      cbPanicMinPositions: 3,
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
    };
    // Daytime: only big panic alerts
    expect(shouldAlertCbPanic(2, thresholds)).toBe(false);
    expect(shouldAlertCbPanic(3, thresholds)).toBe(true);
    // Nighttime: would be quiet hours anyway (would be suppressed at dispatch)
    expect(isInQuietHours(new Date(2026, 7, 27, 3, 0), thresholds)).toBe(true);
  });

  test('enterprise user: cbPanicMin=1 + no quiet hours → maximum coverage', () => {
    const thresholds = {
      cbPanicMinPositions: 1,
      quietHoursEnabled: false,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
    };
    expect(shouldAlertCbPanic(1, thresholds)).toBe(true);
    expect(isInQuietHours(new Date(2026, 7, 27, 3, 0), thresholds)).toBe(false);
  });
});
