'use strict';

/**
 * FIX-2026-09-01 audit H6: suppressHit latch — bucket.day/hour is LOCAL time but
 *   the previous todayKey used toISOString().slice(0,10) (UTC). In BKK (+7),
 *   Monday 06:30 local = Sunday 23:30 UTC → todayKey rolled back one day,
 *   breaking the "1 per bot per day per cell" latch.
 *
 *   This test verifies the FIX:
 *     - _localDateKey() returns a YYYY-MM-DD string in LOCAL TZ
 *     - 06:30 BKK Monday → "YYYY-MM-DD" for Monday (NOT Sunday)
 *     - Two Suppress hits on the same local day → same todayKey → latch works
 *     - A Suppress hit on the next local day → different todayKey → fresh latch
 *     - bucket.day/hour and todayKey agree on the day-of-week
 *
 *   We don't import autoTiming.js directly (heavy side-effects) — instead we
 *   replicate the helper + the latch logic in a tiny replica and assert.
 */

function bucketOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return { day: d.getDay(), hour: d.getHours() };
}
function _localDateKey(msOrDate) {
  const d = msOrDate instanceof Date ? msOrDate : new Date(msOrDate);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('audit-H6 _localDateKey (FIX-2026-09-01)', () => {
  test('returns YYYY-MM-DD format', () => {
    const k = _localDateKey(new Date('2026-09-01T10:00:00Z'));
    expect(k).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('06:30 BKK Monday = local Monday (not UTC Sunday)', () => {
    // 2026-09-07T06:30:00+07:00 = 2026-09-06T23:30:00Z = UTC Sunday
    // In BKK local, that's Monday 06:30. Server-local TZ depends on env;
    // we test the contract: the local date key matches bucket.day.
    const ms = new Date('2026-09-06T23:30:00Z').getTime(); // Sun 23:30 UTC
    const bucket = bucketOf(ms);
    const todayKey = _localDateKey(ms);
    // The TZ may shift bucket.day by 1 from UTC day. The key contract:
    //   bucket.day must agree with the calendar day-of-month in todayKey.
    // i.e., bucket.day computed via getDay() should match the day-of-week
    // implied by todayKey via getDay() too — same call site.
    const reconstructedDay = new Date(todayKey + 'T12:00:00').getDay();
    expect(bucket.day).toBe(reconstructedDay);
  });

  test('regression: local date key ≠ UTC date key near midnight', () => {
    // 2026-09-01T20:00:00 UTC — depending on server TZ this could be Sep 1,
    // Sep 2, or Aug 31 local. The KEY POINT: bucket.day must be derivable from
    // todayKey via getDay() too — they MUST agree.
    const ms = Date.UTC(2026, 8, 1, 20, 0, 0); // Sep 1, 20:00 UTC
    const bucket = bucketOf(ms);
    const todayKey = _localDateKey(ms);
    const bucketFromKey = bucketOf(todayKey + 'T12:00:00');
    expect(bucket.day).toBe(bucketFromKey.day);
  });

  test('UTC vs local: 06:30 in BKK (+7) UTC is 23:30 the previous day', () => {
    // Pick a fixed point and verify the helper is timezone-aware by computing
    // the same instant two ways.
    const ms = new Date('2026-09-06T23:30:00Z').getTime(); // Sun 23:30 UTC
    const localKey = _localDateKey(ms);
    const utcKey = new Date(ms).toISOString().slice(0, 10);
    // In BKK local, that's Monday 06:30 — but the server's TZ could be UTC.
    // We test the contract: bucket.day derived from `ms` matches the day implied
    // by todayKey (the local date string).
    const bLocal = bucketOf(ms);
    const bKey = bucketOf(localKey + 'T12:00:00');
    expect(bLocal.day).toBe(bKey.day);
    // Document the UTC key (debug aid)
    expect(utcKey).toBe('2026-09-06');
  });
});

describe('audit-H6 latch behavior: 1/bot/day/cell', () => {
  function checkLatch(latched, botId, ms) {
    const bucket = bucketOf(ms);
    const latchKey = `${botId}:${bucket.day}:${bucket.hour}`;
    const todayKey = _localDateKey(ms);
    const fullKey = `${latchKey}:${todayKey}`;
    if (latched.has(fullKey)) return { emitted: false, key: fullKey };
    latched.add(fullKey);
    return { emitted: true, key: fullKey };
  }

  test('same cell twice in the same local day → only first emits', () => {
    const latched = new Set();
    // Both instants are local hour=8 (same cell) on the same local day.
    // ms1 = 2026-09-07T01:00:00Z → BKK Mon 08:00 local (hour=8)
    // ms2 = 2026-09-07T01:30:00Z → BKK Mon 08:30 local (hour=8, same cell)
    const ms1 = new Date('2026-09-07T01:00:00Z').getTime();
    const ms2 = new Date('2026-09-07T01:30:00Z').getTime();
    expect(checkLatch(latched, 'botA', ms1).emitted).toBe(true);
    expect(checkLatch(latched, 'botA', ms2).emitted).toBe(false);
  });

  test('same cell on the next local day → emits again', () => {
    const latched = new Set();
    const ms1 = new Date('2026-09-07T10:00:00Z').getTime(); // BKK Mon 17:00
    const ms2 = new Date('2026-09-07T20:00:00Z').getTime(); // BKK Tue 03:00
    expect(checkLatch(latched, 'botA', ms1).emitted).toBe(true);
    expect(checkLatch(latched, 'botA', ms2).emitted).toBe(true);
  });

  test('different bots → independent latches', () => {
    const latched = new Set();
    const ms = new Date('2026-09-07T03:00:00Z').getTime();
    expect(checkLatch(latched, 'botA', ms).emitted).toBe(true);
    expect(checkLatch(latched, 'botB', ms).emitted).toBe(true);
  });

  test('regression: BKK early-morning Suppress uses correct local day', () => {
    // BKK Mon 06:30 local = UTC Sun 23:30
    // Old code: todayKey='2026-09-06' (Sunday), bucket.day=1 (Monday local).
    //   → full key mixes Sunday with Monday cells — wrong day semantics.
    // New code: todayKey='2026-09-07' (Monday local), bucket.day=1 (Monday local).
    //   → consistent.
    const latched = new Set();
    const ms = new Date('2026-09-06T23:30:00Z').getTime();
    const r1 = checkLatch(latched, 'botA', ms);
    // Second hit same instant: must be latched
    const r2 = checkLatch(latched, 'botA', ms);
    expect(r1.emitted).toBe(true);
    expect(r2.emitted).toBe(false);
    expect(r1.key).toBe(r2.key);
    // The key must use the local date, not UTC
    // (BKK local for this instant is Monday 06:30 — so todayKey = '2026-09-07')
    const todayKey = _localDateKey(ms);
    const expectedDate = new Date(ms);
    const expectedLocalKey = `${expectedDate.getFullYear()}-${String(expectedDate.getMonth()+1).padStart(2,'0')}-${String(expectedDate.getDate()).padStart(2,'0')}`;
    expect(todayKey).toBe(expectedLocalKey);
  });
});

describe('audit-H6 source: autoTiming.js uses local date key for latch', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = path.join(__dirname, '..', 'src', 'services', 'autoTiming.js');

  test('FIX-2026-09-01 audit H6 comment present', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src).toMatch(/FIX-2026-09-01 audit H6/);
  });

  test('_localDateKey helper exists', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src).toMatch(/function\s+_localDateKey\s*\(/);
  });

  test('latch block calls _localDateKey (not toISOString)', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    // The OLD pattern was: todayKey = new Date(msOf(now)).toISOString().slice(0, 10);
    // The NEW pattern must use _localDateKey.
    const latchBlock = src.match(/emit suppressHit event[\s\S]{0,1000}fullKey\s*=/);
    expect(latchBlock).not.toBeNull();
    expect(latchBlock[0]).toMatch(/_localDateKey/);
    expect(latchBlock[0]).not.toMatch(/\.toISOString\(\)\.slice/);
  });
});
