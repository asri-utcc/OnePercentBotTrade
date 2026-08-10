'use strict';

/**
 * FIX-2026-08-10: Unit tests for cbPatternEvaluator.evaluateCBv5Snapshot.
 * Mirrors the Pine Script CBv5 (Support Zone, Deepest Low & Volume Filter) logic.
 *
 * Pure-function tests — no DB / no mocks / no eventBus.
 */

const {
  evaluateCBv5Snapshot,
  normalizeKlines,
} = require('../src/core/cbPatternEvaluator');

const FIXED_NOW = 1_700_000_000_000;
const TF_MS = 3 * 60 * 1000; // 3m timeframe

function makeKline(i, { open, high, low, close, volume = 100 }) {
  return {
    openTime: FIXED_NOW - (60 - i) * TF_MS,
    closeTime: FIXED_NOW - (60 - i - 1) * TF_MS,
    open, high, low, close, volume,
  };
}

function defaultBot(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    timeframe: '3m',
    cbv5KcLen: 20,
    cbv5KcMult: 1.2,
    cbv5PivotLookback: 3,
    cbv5PivotLeftLen: 5,
    cbv5PivotRightLen: 5,
    cbv5StrictBreak: true,
    cbv5UseVolume: true,
    cbv5VolMaLen: 20,
    cbv5VolMultiplier: 1.5,
    cbv5DebounceCandles: 5,
    ...overrides,
  };
}

// Generate a sideway series with clear pivot lows: 80 candles
// - i=20 is a clear pivot low (low=97, neighbors=99.5)
// - i=50 is a deeper pivot low (low=96, neighbors=99.5)
// - All other lows = 99.5
// - Volumes cycle 100/110/120 → SMA(20) ≈ 110
function buildSidewayKlines(count = 80) {
  const klines = [];
  for (let i = 0; i < count; i += 1) {
    const base = 100;
    const noise = (i % 5) - 2; // -2..2
    const open = base + noise;
    const close = base + noise + 0.1;
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    const volume = 100 + (i % 3) * 10; // 100, 110, 120 cycling
    klines.push(makeKline(i, { open, high, low, close, volume }));
  }
  // Force pivot lows at i=20 and i=50 (lower than neighbors) — only if those indices exist
  if (count > 25) {
    for (let i = 15; i <= 25; i += 1) {
      klines[i].low = 99.5;
      klines[i].high = 100.5;
      klines[i].volume = 110;
    }
    klines[20].low = 97.0;
    klines[20].high = 99.5;
    klines[20].close = 98.0;
    klines[20].open = 98.5;
    klines[20].volume = 110;
  }
  if (count > 55) {
    for (let i = 45; i <= 55; i += 1) {
      klines[i].low = 99.5;
      klines[i].high = 100.5;
      klines[i].volume = 110;
    }
    klines[50].low = 96.0;
    klines[50].high = 99.5;
    klines[50].close = 97.0;
    klines[50].open = 97.5;
    klines[50].volume = 110;
  }
  return klines;
}

// Generate a sharp breakout at the LAST candle (i=lastIdx, default last)
// - previous candles: sideway (with pivots at 20, 50)
// - last candle: close way below all pivots, bearish, with HUGE volume
function buildBreakoutKlines({ dropPct = 10, volSpike = 10 } = {}) {
  const klines = buildSidewayKlines(80);
  // Make the LAST candle drop sharply (i = 79)
  const lastIdx = klines.length - 1;
  const o = 100;
  const c = 100 - dropPct; // e.g., 90 for 10% drop
  const h = o + 1;
  const l = c - 2;
  const v = 110 * volSpike; // 10x normal volume
  klines[lastIdx] = makeKline(lastIdx, { open: o, high: h, low: l, close: c, volume: v });
  // Also dampen the candle before so EMA/ATR can settle
  if (lastIdx > 0) {
    klines[lastIdx - 1].open = 100;
    klines[lastIdx - 1].close = 99;
    klines[lastIdx - 1].high = 101;
    klines[lastIdx - 1].low = 98;
    klines[lastIdx - 1].volume = 110;
  }
  return klines;
}

describe('cbPatternEvaluator.evaluateCBv5Snapshot', () => {
  test('no klines → ok:false reason:no_klines', () => {
    const r = evaluateCBv5Snapshot({ bot: defaultBot(), klines: null, nowMs: FIXED_NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_klines');
    expect(r.matched).toBe(false);
  });

  test('insufficient klines → ok:false reason:warmup', () => {
    const r = evaluateCBv5Snapshot({
      bot: defaultBot(),
      klines: buildSidewayKlines(10),
      nowMs: FIXED_NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('warmup');
    expect(r.matched).toBe(false);
  });

  test('sideway market → ok:true, matched:false (no KC breakout)', () => {
    const r = evaluateCBv5Snapshot({
      bot: defaultBot(),
      klines: buildSidewayKlines(80),
      nowMs: FIXED_NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.matched).toBe(false);
    expect(r.isKCDown).toBe(false);
    expect(r.deepestLow).toBeCloseTo(96.0, 1); // min(97, 96)
  });

  test('big breakout below KC + below pivot + bearish + volume spike → matched:true', () => {
    const klines = buildBreakoutKlines({ dropPct: 15, volSpike: 10 });
    const r = evaluateCBv5Snapshot({
      bot: defaultBot(),
      klines,
      nowMs: FIXED_NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.isKCDown).toBe(true);
    expect(r.isBelowDeepest).toBe(true); // close=85 < deepestLow=96
    expect(r.isBearish).toBe(true);
    expect(r.isHighVolume).toBe(true);
    expect(r.matched).toBe(true);
  });

  test('strict break OFF + non-bearish candle (but other conditions met) → matched:true', () => {
    const klines = buildBreakoutKlines({ dropPct: 15, volSpike: 10 });
    const lastIdx = klines.length - 1;
    // Make the last candle GREEN (close > open) but keep all other breakout signals
    klines[lastIdx].open = 80;
    klines[lastIdx].close = 85; // green
    const r = evaluateCBv5Snapshot({
      bot: defaultBot({ cbv5StrictBreak: false }),
      klines,
      nowMs: FIXED_NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.isBearish).toBe(false);
    expect(r.matched).toBe(true); // strict OFF → bearish check skipped
  });

  test('strict break ON + green candle → matched:false', () => {
    const klines = buildBreakoutKlines({ dropPct: 15, volSpike: 10 });
    const lastIdx = klines.length - 1;
    klines[lastIdx].open = 80;
    klines[lastIdx].close = 85; // green (not bearish)
    const r = evaluateCBv5Snapshot({
      bot: defaultBot(), // strictBreak=true default
      klines,
      nowMs: FIXED_NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.isBearish).toBe(false);
    expect(r.matched).toBe(false); // strict ON → bearish required
  });

  test('volume filter OFF + low volume → matched:true (volume ignored)', () => {
    const klines = buildBreakoutKlines({ dropPct: 15, volSpike: 1 }); // no volume spike
    const r = evaluateCBv5Snapshot({
      bot: defaultBot({ cbv5UseVolume: false }),
      klines,
      nowMs: FIXED_NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.isHighVolume).toBe(true); // forced true when useVolume=false
    expect(r.matched).toBe(true);
  });

  test('volume filter ON + low volume → matched:false', () => {
    const klines = buildBreakoutKlines({ dropPct: 15, volSpike: 1 }); // no spike
    const r = evaluateCBv5Snapshot({
      bot: defaultBot({ cbv5VolMultiplier: 5.0 }), // require 5x spike
      klines,
      nowMs: FIXED_NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.isHighVolume).toBe(false);
    expect(r.matched).toBe(false);
  });

  test('targetCloseTime not found → ok:false reason:target_candle_not_found', () => {
    const klines = buildSidewayKlines(80);
    const r = evaluateCBv5Snapshot({
      bot: defaultBot(),
      klines,
      targetCloseTime: 999999999999,
      nowMs: FIXED_NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('target_candle_not_found');
  });

  test('normalizeKlines filters out open candle (closeTime > nowMs)', () => {
    const futureKline = [FIXED_NOW + TF_MS, '100', '101', '99', '100.5', '100', FIXED_NOW + 2 * TF_MS, '0', '0', '0', '0', '0'];
    const pastKline = [FIXED_NOW - TF_MS, '100', '101', '99', '100.5', '100', FIXED_NOW, '0', '0', '0', '0', '0'];
    const out = normalizeKlines([futureKline, pastKline], { nowMs: FIXED_NOW });
    expect(out).toHaveLength(1);
    expect(out[0].closeTime).toBe(FIXED_NOW);
  });

  test('fingerprint is deterministic for same input', () => {
    const klines = buildBreakoutKlines({ lastIdx: 75, dropPct: 15, volSpike: 10 });
    const r1 = evaluateCBv5Snapshot({ bot: defaultBot(), klines, nowMs: FIXED_NOW });
    const r2 = evaluateCBv5Snapshot({ bot: defaultBot(), klines, nowMs: FIXED_NOW });
    expect(r1.fingerprint).toBe(r2.fingerprint);
  });

  test('fingerprint changes when pivotLookback differs', () => {
    const klines = buildSidewayKlines(80);
    const r1 = evaluateCBv5Snapshot({
      bot: defaultBot({ cbv5PivotLookback: 1 }), klines, nowMs: FIXED_NOW,
    });
    const r2 = evaluateCBv5Snapshot({
      bot: defaultBot({ cbv5PivotLookback: 2 }), klines, nowMs: FIXED_NOW,
    });
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  test('custom params (kcMult) change thresholds — tight KC breaks below easier', () => {
    const klines = buildBreakoutKlines({ dropPct: 8, volSpike: 5 });
    // Tight KC (mult=0.5) → easier to break below
    const tight = evaluateCBv5Snapshot({
      bot: defaultBot({ cbv5KcMult: 0.5 }),
      klines,
      nowMs: FIXED_NOW,
    });
    // Wide KC (mult=5.0) → harder to break below
    const wide = evaluateCBv5Snapshot({
      bot: defaultBot({ cbv5KcMult: 5.0 }),
      klines,
      nowMs: FIXED_NOW,
    });
    expect(tight.isKCDown).toBe(true);
    expect(wide.isKCDown).toBe(false);
  });

  test('NaN handling: insufficient klines → ok:false', () => {
    const klines = [];
    for (let i = 0; i < 5; i += 1) {
      klines.push(makeKline(i, { open: NaN, high: NaN, low: NaN, close: NaN, volume: 0 }));
    }
    const r = evaluateCBv5Snapshot({ bot: defaultBot(), klines, nowMs: FIXED_NOW });
    expect(r.ok).toBe(false);
  });
});
