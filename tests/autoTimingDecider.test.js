'use strict';

const { decide, isValidAction } = require('../src/core/autoTimingDecider');
const { getDefaultBandsClone } = require('../src/core/autoTimingDefaults');

const BANDS = getDefaultBandsClone();

function makeResult(over = {}) {
  const band = over.band || BANDS.lt10m;
  return Object.assign({
    action: band.action,
    bandId: band.bandId,
    band,
    confidence: 'enforce',
    blocked: band.action === 'suppress',
    reason: 'unit-test',
  }, over);
}

function makeBot(over = {}) {
  return Object.assign({
    capitalPerTrade: 50,
    autoTimingOverrideCell: null,
  }, over);
}

const STANDARD_CLAMP = { minFloorUSDT: 10, maxCeilingUSDT: 200 };
const EMPTY_STATE = { openFromCell: 0, tradesFromCellToday: 0 };

describe('autoTimingDecider.decide — input guards', () => {
  test('null result + null bot → safe allow', () => {
    const r = decide(null, null, { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE);
    expect(r.effectiveAction).toBe('allow');
    expect(r.blocked).toBe(false);
    expect(r.notionalMult).toBe(1);
    expect(r.notionalUSDT).toBe(0); // bot=null → capitalPerTrade=0
    expect(r.skipReason).toBeNull();
  });

  test('missing clamp config uses defaults', () => {
    const allowBand = Object.assign({}, BANDS.lt12h, { action: 'allow', notionalMult: 1 });
    const r = decide(
      makeResult({ action: 'allow', band: allowBand }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, null, null,
    );
    expect(r.notionalFinal).toBe(50);
    expect(r.notionalClamped).toBe('in_range');
  });
});

describe('autoTimingDecider.decide — action pass-through', () => {
  test('action=allow passes through with mult=1', () => {
    const band = Object.assign({}, BANDS.lt12h, { action: 'allow', notionalMult: 1 });
    const r = decide(
      makeResult({ action: 'allow', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.effectiveAction).toBe('allow');
    expect(r.notionalMult).toBe(1);
    expect(r.notionalUSDT).toBe(50);
    expect(r.notionalFinal).toBe(50);
    expect(r.blocked).toBe(false);
  });

  test('action=limit halves notional', () => {
    const band = Object.assign({}, BANDS.lt48h, { action: 'limit', notionalMult: 0.5 });
    const r = decide(
      makeResult({ action: 'limit', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.effectiveAction).toBe('limit');
    expect(r.notionalMult).toBe(0.5);
    expect(r.notionalUSDT).toBe(25);
    expect(r.blocked).toBe(false);
  });

  test('action=stimulate multiplies notional', () => {
    const band = Object.assign({}, BANDS.lt10m, { action: 'stimulate', notionalMult: 1.2 });
    const r = decide(
      makeResult({ action: 'stimulate', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.notionalMult).toBe(1.2);
    expect(r.notionalUSDT).toBe(60);
  });

  test('action=encourage applies slight boost', () => {
    const band = Object.assign({}, BANDS.lt1h, { action: 'encourage', notionalMult: 1.1 });
    const r = decide(
      makeResult({ action: 'encourage', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.notionalUSDT).toBe(55);
  });
});

describe('autoTimingDecider.decide — suppress', () => {
  test('action=suppress → blocked, notional=0', () => {
    const r = decide(
      makeResult({ action: 'suppress', blocked: true }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.effectiveAction).toBe('suppress');
    expect(r.blocked).toBe(true);
    expect(r.notionalFinal).toBe(0);
    expect(r.skipReason).toBe('suppress');
  });

  test('action=allow but band.notionalMult=0 → treated as suppress', () => {
    const band = Object.assign({}, BANDS.lt10m, { notionalMult: 0 });
    const r = decide(
      makeResult({ action: 'allow', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.effectiveAction).toBe('suppress');
    expect(r.blocked).toBe(true);
    expect(r.skipReason).toBe('suppress');
  });
});

describe('autoTimingDecider.decide — clamp', () => {
  test('floor policy: notional < minFloor → skip', () => {
    const band = Object.assign({}, BANDS.lt48h, { action: 'limit', notionalMult: 0.1 });
    const r = decide(
      makeResult({ action: 'limit', band }),
      makeBot({ capitalPerTrade: 50 }), // 50 * 0.1 = 5 < 10 floor
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.notionalUSDT).toBe(5);
    expect(r.notionalClamped).toBe('skipped_low');
    expect(r.notionalFinal).toBe(0);
    expect(r.blocked).toBe(true);
    expect(r.skipReason).toBe('floor');
  });

  test('ceiling policy: notional > maxCeiling → cap (not blocked)', () => {
    const band = Object.assign({}, BANDS.lt10m, { action: 'stimulate', notionalMult: 3 });
    const r = decide(
      makeResult({ action: 'stimulate', band }),
      makeBot({ capitalPerTrade: 100 }), // 100 * 3 = 300 > 200 ceiling
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.notionalUSDT).toBe(300);
    expect(r.notionalFinal).toBe(200);
    expect(r.notionalClamped).toBe('capped_high');
    expect(r.blocked).toBe(false);
    expect(r.skipReason).toBeNull();
  });

  test('notional exactly at floor → in_range, not skipped', () => {
    const band = Object.assign({}, BANDS.lt48h, { action: 'limit', notionalMult: 0.2 });
    const r = decide(
      makeResult({ action: 'limit', band }),
      makeBot({ capitalPerTrade: 50 }), // 50 * 0.2 = 10 == floor
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.notionalUSDT).toBe(10);
    expect(r.notionalClamped).toBe('in_range');
    expect(r.blocked).toBe(false);
  });
});

describe('autoTimingDecider.decide — concurrency + per-day caps', () => {
  test('maxConcurrent reached → blocked', () => {
    const band = Object.assign({}, BANDS.lt48h, {
      action: 'limit', notionalMult: 0.5, maxConcurrent: 3,
    });
    const r = decide(
      makeResult({ action: 'limit', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, { openFromCell: 3, tradesFromCellToday: 1 },
    );
    expect(r.blocked).toBe(true);
    expect(r.skipReason).toBe('max_concurrent');
  });

  test('maxTradesPerDay reached → blocked', () => {
    const band = Object.assign({}, BANDS.lt48h, {
      action: 'limit', notionalMult: 0.5, maxTradesPerDay: 5,
    });
    const r = decide(
      makeResult({ action: 'limit', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, { openFromCell: 1, tradesFromCellToday: 5 },
    );
    expect(r.blocked).toBe(true);
    expect(r.skipReason).toBe('max_trades_day');
  });

  test('null max caps → unlimited', () => {
    const band = Object.assign({}, BANDS.lt10m, {
      action: 'stimulate', notionalMult: 1.2,
      maxConcurrent: null, maxTradesPerDay: null,
    });
    const r = decide(
      makeResult({ action: 'stimulate', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, { openFromCell: 999, tradesFromCellToday: 999 },
    );
    expect(r.blocked).toBe(false);
  });

  test('floor-skip wins over max_concurrent check', () => {
    const band = Object.assign({}, BANDS.lt48h, {
      action: 'limit', notionalMult: 0.1, maxConcurrent: 3,
    });
    const r = decide(
      makeResult({ action: 'limit', band }),
      makeBot({ capitalPerTrade: 50 }), // → 5 < floor
      { day: 0, hour: 0 }, STANDARD_CLAMP, { openFromCell: 3, tradesFromCellToday: 1 },
    );
    expect(r.skipReason).toBe('floor'); // not max_concurrent
  });
});

describe('autoTimingDecider.decide — per-bot override', () => {
  test('override wins over classifier action', () => {
    const r = decide(
      makeResult({ action: 'stimulate', band: BANDS.lt10m }),
      makeBot({
        capitalPerTrade: 50,
        autoTimingOverrideCell: { '1:14': 'suppress' },
      }),
      { day: 1, hour: 14 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.source).toBe('override');
    expect(r.effectiveAction).toBe('suppress');
    expect(r.blocked).toBe(true);
    expect(r.overrideApplied).toBe('suppress');
  });

  test('override to limit on an Allow cell → mult=0.5', () => {
    const r = decide(
      makeResult({ action: 'allow', band: BANDS.lt12h }),
      makeBot({
        capitalPerTrade: 50,
        autoTimingOverrideCell: { '0:0': 'limit' },
      }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.effectiveAction).toBe('limit');
    expect(r.notionalMult).toBe(0.5);
    expect(r.notionalUSDT).toBe(25);
  });

  test('override to stimulate on a Limit cell → mult=1.2', () => {
    const r = decide(
      makeResult({ action: 'limit', band: BANDS.lt48h }),
      makeBot({
        capitalPerTrade: 50,
        autoTimingOverrideCell: { '6:23': 'stimulate' },
      }),
      { day: 6, hour: 23 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.effectiveAction).toBe('stimulate');
    expect(r.notionalMult).toBe(1.2);
    expect(r.notionalUSDT).toBe(60);
  });

  test('invalid override action ignored → classifier used', () => {
    const r = decide(
      makeResult({ action: 'allow', band: BANDS.lt12h }),
      makeBot({
        capitalPerTrade: 50,
        autoTimingOverrideCell: { '0:0': 'BOGUS' },
      }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.source).toBe('classifier');
    expect(r.effectiveAction).toBe('allow');
    expect(r.overrideApplied).toBe('BOGUS');
  });

  test('override for different bucket ignored', () => {
    const r = decide(
      makeResult({ action: 'allow', band: BANDS.lt12h }),
      makeBot({
        capitalPerTrade: 50,
        autoTimingOverrideCell: { '3:9': 'suppress' },
      }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.source).toBe('classifier');
    expect(r.overrideApplied).toBeNull();
  });
});

describe('autoTimingDecider.decide — band knob propagation', () => {
  test('tpTightenPct + slTightenPct propagate', () => {
    const band = Object.assign({}, BANDS.lt48h, {
      action: 'limit', notionalMult: 0.5,
      tpTightenPct: 30, slTightenPct: 10,
    });
    const r = decide(
      makeResult({ action: 'limit', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.tpTightenPct).toBe(30);
    expect(r.slTightenPct).toBe(10);
  });

  test('forceST1/ST2/ST3 + forceCBv5 propagate', () => {
    const band = Object.assign({}, BANDS.lt48h, {
      action: 'limit', notionalMult: 0.5,
      forceST1: true, forceST2: true, forceST3: false, forceCBv5: true,
    });
    const r = decide(
      makeResult({ action: 'limit', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.forceST1).toBe(true);
    expect(r.forceST2).toBe(true);
    expect(r.forceST3).toBe(false);
    expect(r.forceCBv5).toBe(true);
  });

  test('minKcMult propagates', () => {
    const band = Object.assign({}, BANDS.lt48h, {
      action: 'limit', notionalMult: 0.5, minKcMult: 1.5,
    });
    const r = decide(
      makeResult({ action: 'limit', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.minKcMult).toBe(1.5);
  });
});

describe('autoTimingDecider.decide — knob clamping', () => {
  test('out-of-range notionalMult clamped to [0..3]', () => {
    const band = Object.assign({}, BANDS.lt10m, { action: 'stimulate', notionalMult: 9 });
    const r = decide(
      makeResult({ action: 'stimulate', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.notionalMult).toBe(3);
  });

  test('tpTightenPct clamped to 0..50', () => {
    const band = Object.assign({}, BANDS.lt48h, {
      action: 'limit', notionalMult: 0.5, tpTightenPct: 999,
    });
    const r = decide(
      makeResult({ action: 'limit', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.tpTightenPct).toBe(50);
  });

  test('minKcMult clamped to 0.5..2.0', () => {
    const band = Object.assign({}, BANDS.lt48h, {
      action: 'limit', notionalMult: 0.5, minKcMult: 99,
    });
    const r = decide(
      makeResult({ action: 'limit', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.minKcMult).toBe(2);
  });

  test('NaN / negative inputs fall back to safe defaults', () => {
    const band = Object.assign({}, BANDS.lt12h, {
      action: 'allow',
      notionalMult: NaN, tpTightenPct: NaN, minKcMult: -5,
    });
    const r = decide(
      makeResult({ action: 'allow', band }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(r.notionalMult).toBe(1);
    expect(r.tpTightenPct).toBe(0);
    expect(r.minKcMult).toBe(0.5);
  });
});

describe('autoTimingDecider.decide — return shape', () => {
  test('result has all required keys', () => {
    const r = decide(
      makeResult({ action: 'limit', band: BANDS.lt48h }),
      makeBot({ capitalPerTrade: 50 }),
      { day: 0, hour: 0 }, STANDARD_CLAMP, EMPTY_STATE,
    );
    expect(typeof r.effectiveAction).toBe('string');
    expect(typeof r.action).toBe('string');
    expect(typeof r.band).toBe('object');
    expect(typeof r.confidence).toBe('string');
    expect(typeof r.notionalMult).toBe('number');
    expect(typeof r.notionalUSDT).toBe('number');
    expect(typeof r.notionalFinal).toBe('number');
    expect(['in_range', 'skipped_low', 'capped_high']).toContain(r.notionalClamped);
    expect(typeof r.forceST1).toBe('boolean');
    expect(typeof r.forceST2).toBe('boolean');
    expect(typeof r.forceST3).toBe('boolean');
    expect(typeof r.forceCBv5).toBe('boolean');
    expect(typeof r.tpTightenPct).toBe('number');
    expect(typeof r.slTightenPct).toBe('number');
    expect(typeof r.minKcMult).toBe('number');
    expect(typeof r.blocked).toBe('boolean');
    expect(typeof r.bandId).toBe('string');
    expect(typeof r.reason).toBe('string');
    expect(['classifier', 'override']).toContain(r.source);
    // Nullable fields
    expect(r.skipReason === null || typeof r.skipReason === 'string').toBe(true);
    expect(r.overrideApplied === null || typeof r.overrideApplied === 'string').toBe(true);
    expect(r.maxConcurrent === null || typeof r.maxConcurrent === 'number').toBe(true);
    expect(r.maxTradesPerDay === null || typeof r.maxTradesPerDay === 'number').toBe(true);
  });
});

describe('autoTimingDecider.isValidAction', () => {
  test.each([
    ['allow', true], ['limit', true], ['encourage', true],
    ['stimulate', true], ['suppress', true],
    ['ALLOW', false], ['', false], [null, false], [undefined, false],
    ['garbage', false], [42, false], [{}, false],
  ])('isValidAction(%p) === %p', (input, expected) => {
    expect(isValidAction(input)).toBe(expected);
  });
});
