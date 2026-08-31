/**
 * FIX-2026-08-31: Hold-time metric selector (median|p75) tests.
 *
 * Covers:
 *   - percentile() helper — linear interpolation, edge cases
 *   - aggregateByCell computes p75HoldMin alongside medianHoldMin
 *   - autoTimingClassifier respects config.holdMetric when selecting band bucket
 *   - autoTimingClassifier defaults to 'median' when holdMetric is missing
 *   - ALLOWED_HOLD_METRICS whitelist (median|p75) in autoTiming.routes.js
 */
'use strict';

const { percentile, aggregateByCell } = require('../src/services/autoTiming');
const { classify } = require('../src/core/autoTimingClassifier');

describe('percentile() helper', () => {
  test('returns 0 for empty array', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile(null, 0.5)).toBe(0);
    expect(percentile(undefined, 0.5)).toBe(0);
  });

  test('returns 0 for invalid p', () => {
    expect(percentile([1, 2, 3], -0.1)).toBe(0);
    expect(percentile([1, 2, 3], 1.5)).toBe(0);
    expect(percentile([1, 2, 3], NaN)).toBe(0);
  });

  test('returns the only element for single-item array', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.75)).toBe(42);
    expect(percentile([42], 0.25)).toBe(42);
  });

  test('p=0.5 equals median for symmetric input', () => {
    const arr = [3, 7, 9, 12, 15]; // sorted
    // median of 5 items = item at index 2 = 9
    expect(percentile(arr, 0.5)).toBe(9);
  });

  test('p=0.75 (P75) returns the upper-quartile value', () => {
    // [1,2,3,4,5,6,7,8,9,10] — 10 items, rank 0.75 * 9 = 6.75 → linear interp between idx 6 (7) and 7 (8)
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(arr, 0.75)).toBeCloseTo(7.75, 5);
  });

  test('P75 is sensitive to upper-tail outliers (unlike median)', () => {
    // [3,8,12,15,240] — 240 is a "ดอย" outlier
    const arr = [3, 8, 12, 15, 240];
    // median = 12 (outlier-robust)
    expect(percentile(arr, 0.5)).toBe(12);
    // P75 rank = 0.75 * 4 = 3 → sorted[3] = 15
    expect(percentile(arr, 0.75)).toBe(15);
  });

  test('p=0.25 (Q1) returns lower-quartile', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // rank = 0.25 * 9 = 2.25 → interp between 3 and 4
    expect(percentile(arr, 0.25)).toBeCloseTo(3.25, 5);
  });

  test('does not mutate input array', () => {
    const arr = [5, 3, 1, 4, 2];
    percentile(arr, 0.75);
    expect(arr).toEqual([5, 3, 1, 4, 2]);
  });
});

describe('aggregateByCell — p75HoldMin alongside medianHoldMin', () => {
  test('both metrics are computed and stored on cell', () => {
    const now = Date.parse('2026-08-30T12:00:00Z');
    const buyA = new Date('2026-08-30T05:00:00Z');
    const sellA = new Date('2026-08-30T05:30:00Z'); // 30 min
    const buyB = new Date('2026-08-30T05:00:00Z');
    const sellB = new Date('2026-08-30T05:10:00Z'); // 10 min
    const trades = [
      { buyFilledAt: buyA, sellFilledAt: sellA, pnlUSDT: 0.10 },
      { buyFilledAt: buyB, sellFilledAt: sellB, pnlUSDT: -0.05 },
    ];
    const m = aggregateByCell(trades, { recentDays: 7, recentWeight: 1.5, normalWeight: 1.0 }, now);
    const cell = [...m.values()][0];
    expect(cell.medianHoldMin).toBe(20); // (10+30)/2
    // holds sorted = [10, 30], P75 rank = 0.75 * 1 = 0.75 → interp between 10 and 30 = 25
    expect(cell.p75HoldMin).toBeCloseTo(25, 5);
  });

  test('p75HoldMin=0 fallback for empty cell', () => {
    const m = aggregateByCell([], { recentDays: 7, recentWeight: 1.5, normalWeight: 1.0 }, Date.now());
    expect(m.size).toBe(0);
  });
});

describe('autoTimingClassifier — holdMetric switching', () => {
  const NOW = Date.parse('2026-08-31T12:00:00Z');
  const baseConfig = {
    bands: {
      lt10m:   { action: 'stimulate', notionalMult: 1.2, tpTightenPct: 0, slTightenPct: 0, forceST1: false, forceST2: false, forceST3: false, forceCBv5: false, minKcMult: 1, maxConcurrent: null, maxTradesPerDay: null },
      lt1h:    { action: 'encourage', notionalMult: 1.1, tpTightenPct: 0, slTightenPct: 0, forceST1: false, forceST2: false, forceST3: false, forceCBv5: false, minKcMult: 1, maxConcurrent: null, maxTradesPerDay: null },
      lt12h:   { action: 'limit',      notionalMult: 0.5, tpTightenPct: 20,slTightenPct: 0, forceST1: true,  forceST2: false, forceST3: false, forceCBv5: false, minKcMult: 1, maxConcurrent: null, maxTradesPerDay: null },
      lt48h:   { action: 'suppress',   notionalMult: 0,   tpTightenPct: 0, slTightenPct: 0, forceST1: false, forceST2: false, forceST3: false, forceCBv5: true,  minKcMult: 1, maxConcurrent: null, maxTradesPerDay: null },
      gt48h:   { action: 'suppress',   notionalMult: 0,   tpTightenPct: 0, slTightenPct: 0, forceST1: false, forceST2: false, forceST3: false, forceCBv5: true,  minKcMult: 1, maxConcurrent: null, maxTradesPerDay: null },
    },
    minTradesShow: 3,
    minTradesEnforce: 10,
    suppressThresholdEverBad: 10,
  };

  // Cell where median=15 min (lt1h band → encourage) but p75=60 min (lt1h upper edge → still lt1h)
  // Construct a clearer case: median=15 (lt1h), p75=120 (lt12h band)
  const cell = {
    bucket: { day: 1, hour: 14 },
    n: 30,
    winRate: 0.8,
    pnlUSDT: 6,
    medianHoldMin: 15,
    p75HoldMin: 120, // pushes into lt12h band (limit) — P75 stricter
    holds: [],
  };

  test('default (no holdMetric) → uses median → band=lt1h → action=encourage', () => {
    const r = classify(cell, null, baseConfig, NOW);
    expect(r.bandId).toBe('lt1h');
    expect(r.action).toBe('encourage');
    expect(r.metrics.holdMetric).toBe('median');
  });

  test('holdMetric=median (explicit) → band=lt1h → action=encourage', () => {
    const r = classify(cell, null, { ...baseConfig, holdMetric: 'median' }, NOW);
    expect(r.bandId).toBe('lt1h');
    expect(r.action).toBe('encourage');
  });

  test('holdMetric=p75 → bucket into lt12h → action=limit (stricter)', () => {
    const r = classify(cell, null, { ...baseConfig, holdMetric: 'p75' }, NOW);
    expect(r.bandId).toBe('lt12h');
    expect(r.action).toBe('limit');
    expect(r.metrics.holdMetric).toBe('p75');
  });

  test('metrics payload includes both medianHoldMin + p75HoldMin + holdMetric', () => {
    const r = classify(cell, null, { ...baseConfig, holdMetric: 'p75' }, NOW);
    expect(r.metrics.medianHoldMin).toBe(15);
    expect(r.metrics.p75HoldMin).toBe(120);
    expect(r.metrics.holdMetric).toBe('p75');
  });

  test('holdMetric=p75 with missing p75HoldMin falls back to median', () => {
    const cellNoP75 = { ...cell };
    delete cellNoP75.p75HoldMin;
    const r = classify(cellNoP75, null, { ...baseConfig, holdMetric: 'p75' }, NOW);
    // Falls back to median (15) → band=lt1h → action=encourage (NOT lt12h/limit)
    expect(r.bandId).toBe('lt1h');
    expect(r.action).toBe('encourage');
  });

  test('invalid holdMetric string defaults to median', () => {
    const r = classify(cell, null, { ...baseConfig, holdMetric: 'p99' }, NOW);
    expect(r.metrics.holdMetric).toBe('median');
    expect(r.bandId).toBe('lt1h');
  });

  test('p75 reason note mentions [holdMetric=p75] in classifier output', () => {
    const cellOK = { ...cell, n: 15 }; // n in [show=3, enforce=10) → advisory
    const r = classify(cellOK, null, { ...baseConfig, holdMetric: 'p75' }, NOW);
    expect(r.reason).toContain('[holdMetric=p75]');
  });
});

describe('autoTiming.routes.js — ALLOWED_HOLD_METRICS whitelist', () => {
  const fs = require('fs');
  const path = require('path');
  const raw = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api', 'routes', 'autoTiming.routes.js'),
    'utf8'
  );
  const stripComments = (src) => src.replace(/(^|[\s;,(])(?:\/\/)[^\n]*/g, '$1');
  const src = stripComments(raw);

  test('exports ALLOWED_HOLD_METRICS = [median, p75]', () => {
    expect(src).toMatch(/const ALLOWED_HOLD_METRICS = \[[\s\S]*?'median'[\s\S]*?'p75'[\s\S]*?\];/);
  });

  test('PUT_FIELDS includes autoTimingHoldMetric as a real entry', () => {
    expect(src).toContain("'autoTimingHoldMetric'");
  });

  test('PUT handler validates against ALLOWED_HOLD_METRICS', () => {
    expect(src).toMatch(/ALLOWED_HOLD_METRICS\.includes\(v\)/);
  });

  test('extractConfig exposes autoTimingHoldMetric', () => {
    expect(src).toMatch(/autoTimingHoldMetric:\s*\(/);
  });
});
