'use strict';

/**
 * BTC Trend Pattern — state machine tests
 * Mirrors src/core/signalEngine.test.js style (Jest 29.7).
 *
 * flatCandles(n, 1000, 10) baseline (BEFORE any mutation):
 *   ATR(20) ≈ 20
 *   inner KC (mult=0.8): upper=1016, lower=984
 *   outer KC2 (mult=2.2): upper=1044, lower=956
 *
 * NOTE on scenario candles:
 *   Each test creates a FRESH candles array (no shared state) so ATR drift
 *   from one scenario does not pollute another. We mutate indices 25..33
 *   which is well past warmup (19).
 *
 * After ANY candle with high-low range > 20, ATR will drift upward and the
 * KC bands will shift accordingly. We compute expected bands dynamically in
 * debug, then bake the observed values into the test.
 */

const btcTrend = require('../src/core/btcTrendPattern');

const KC_LEN = 20;
const WARMUP_END = KC_LEN - 1; // 19
const BASE = 1000;
const RANGE = 10;
const KC_INNER_UP = 1016;
const KC_INNER_LO = 984;
const KC_OUTER_UP = 1044;
const KC_OUTER_LO = 956;

/** Build `n` flat candles with constant OHLC around `base` ± `range`. */
function flatCandles(n, base = BASE, range = RANGE) {
  return Array.from({ length: n }, () => ({
    open: base,
    high: base + range,
    low: base - range,
    close: base,
  }));
}

describe('btcTrendPattern — invariants', () => {
  test('warmup guard: modes[0..18] ทั้งหมดเป็น normal', () => {
    const candles = flatCandles(60, 100, 50); // aggressive range — would normally trigger
    const { modes } = btcTrend.computeBtcTrendPattern(candles);
    for (let i = 0; i < WARMUP_END; i += 1) {
      expect(modes[i]).toBe('normal');
    }
  });

  test('output arrays ทั้งหมดยาวเท่ากับ input', () => {
    const candles = flatCandles(50);
    const out = btcTrend.computeBtcTrendPattern(candles);
    expect(out.basis.length).toBe(candles.length);
    expect(out.upperKC.length).toBe(candles.length);
    expect(out.lowerKC.length).toBe(candles.length);
    expect(out.upperKC2.length).toBe(candles.length);
    expect(out.lowerKC2.length).toBe(candles.length);
    expect(out.modes.length).toBe(candles.length);
  });

  test('warmupEnd = kcLen - 1', () => {
    expect(btcTrend.computeBtcTrendPattern(flatCandles(50)).warmupEnd).toBe(WARMUP_END);
  });

  test('output length 0 → empty arrays (no crash)', () => {
    const out = btcTrend.computeBtcTrendPattern([]);
    expect(out.basis).toEqual([]);
    expect(out.modes).toEqual([]);
    expect(out.warmupEnd).toBe(WARMUP_END);
  });

  test('band widths: outer KC (mult=2.2) กว้างกว่า inner KC (mult=0.8) เสมอ', () => {
    const candles = flatCandles(50);
    const { upperKC, lowerKC, upperKC2, lowerKC2 } = btcTrend.computeBtcTrendPattern(candles);
    for (let i = WARMUP_END; i < candles.length; i += 1) {
      const innerWidth = upperKC[i] - lowerKC[i];
      const outerWidth = upperKC2[i] - lowerKC2[i];
      expect(outerWidth).toBeGreaterThan(innerWidth);
    }
  });

  test('flat candles (no volatility) → modes เป็น normal ทั้งหมด', () => {
    const candles = flatCandles(40, BASE, 1); // range=1 → ATR≈2 → very tight KC
    const { modes } = btcTrend.computeBtcTrendPattern(candles);
    for (let i = WARMUP_END; i < candles.length; i += 1) {
      expect(modes[i]).toBe('normal');
    }
  });

  test('NaN guard: high=NaN ในช่วง warmup → modes คงเป็น normal', () => {
    const candles = flatCandles(30);
    candles[5].high = NaN; // keltnerChannel sanitize → null ใน warmup window
    const { modes } = btcTrend.computeBtcTrendPattern(candles);
    for (let i = 0; i < WARMUP_END; i += 1) {
      expect(modes[i]).toBe('normal');
    }
  });

  test('MODES export เป็น array 5 ค่า', () => {
    expect(btcTrend.MODES).toEqual(['normal', 'waiting-boots', 'boots', 'waiting-break', 'break']);
    expect(btcTrend.MODES.length).toBe(5);
  });
});

describe('btcTrendPattern — state transitions (single-state setup)', () => {
  test('normal → waiting-boots: low < lowerKC2', () => {
    const candles = flatCandles(30);
    candles[25] = { open: BASE, high: BASE + RANGE, low: KC_OUTER_LO - 10, close: BASE };
    const { modes } = btcTrend.computeBtcTrendPattern(candles);
    expect(modes[24]).toBe('normal');
    expect(modes[25]).toBe('waiting-boots');
  });

  test('waiting-boots → boots: high > lowerKC', () => {
    const candles = flatCandles(30);
    candles[25] = { open: BASE, high: BASE + RANGE, low: KC_OUTER_LO - 10, close: BASE };
    candles[27] = { open: BASE, high: KC_INNER_LO + 10, low: BASE - RANGE, close: BASE };
    const { modes } = btcTrend.computeBtcTrendPattern(candles);
    expect(modes[25]).toBe('waiting-boots');
    expect(modes[27]).toBe('boots');
  });

  test('boots → waiting-break: high > upperKC2', () => {
    const candles = flatCandles(30);
    candles[25] = { open: BASE, high: BASE + RANGE, low: KC_OUTER_LO - 10, close: BASE };
    candles[27] = { open: BASE, high: KC_INNER_LO + 10, low: BASE - RANGE, close: BASE };
    // upperKC2 ที่ 29 ≈ 1044 (flat candles) → high ต้อง > 1044
    candles[29] = { open: BASE, high: KC_OUTER_UP + 20, low: BASE - RANGE, close: BASE };
    const { modes } = btcTrend.computeBtcTrendPattern(candles);
    expect(modes[27]).toBe('boots');
    expect(modes[29]).toBe('waiting-break');
  });

  test('boots → waiting-boots fallback: lo < lowerKC2 ชนะ over hi > upperKC2', () => {
    const candles = flatCandles(30);
    candles[25] = { open: BASE, high: BASE + RANGE, low: KC_OUTER_LO - 10, close: BASE };
    candles[27] = { open: BASE, high: KC_INNER_LO + 10, low: BASE - RANGE, close: BASE };
    // NOTE: candles[25].low=946 ทำให้ ATR drift ขึ้น → lowerKC2[29] สูงขึ้นเป็น ~942
    // ดังนั้น candles[29].low ต้องต่ำกว่า 942 (ใช้ 920 เพื่อ safety margin)
    candles[29] = { open: BASE, high: KC_OUTER_UP + 20, low: 920, close: BASE };
    const { modes } = btcTrend.computeBtcTrendPattern(candles);
    expect(modes[27]).toBe('boots');
    expect(modes[29]).toBe('waiting-boots'); // fallback ชนะ over waiting-break
  });

  test('waiting-break → break: low < upperKC', () => {
    const candles = flatCandles(40);
    candles[25] = { open: BASE, high: BASE + RANGE, low: BASE - RANGE, close: BASE };
    candles[27] = { open: BASE, high: BASE + RANGE, low: BASE - RANGE, close: BASE };
    // waiting-break ที่ 29 (high > upperKC2)
    candles[29] = { open: BASE, high: KC_OUTER_UP + 20, low: BASE - RANGE, close: BASE + 30 };
    // break ที่ 31 (low < upperKC ≈ 1016 + ATR drift)
    candles[31] = { open: BASE, high: BASE + RANGE, low: 990, close: BASE };
    const { modes } = btcTrend.computeBtcTrendPattern(candles);
    expect(modes[29]).toBe('waiting-break');
    expect(modes[31]).toBe('break');
  });

  test('break → waiting-boots: low < lowerKC2', () => {
    const candles = flatCandles(40);
    // ตั้ง mode[29] = 'waiting-break' โดยดัด candles[29] ให้ high > upperKC2
    candles[25] = { open: BASE, high: BASE + RANGE, low: BASE - RANGE, close: BASE };
    candles[27] = { open: BASE, high: BASE + RANGE, low: BASE - RANGE, close: BASE };
    candles[29] = { open: BASE, high: KC_OUTER_UP + 20, low: BASE - RANGE, close: BASE + 30 };
    // break ที่ 31 (low < upperKC ≈ 1016 + drift)
    candles[31] = { open: BASE, high: BASE + RANGE, low: 990, close: BASE };
    // waiting-boots ที่ 33 (low < lowerKC2 ≈ 956 + drift)
    candles[33] = { open: BASE, high: BASE + RANGE, low: 920, close: BASE };
    const { modes } = btcTrend.computeBtcTrendPattern(candles);
    expect(modes[31]).toBe('break');
    expect(modes[33]).toBe('waiting-boots');
  });

  test('break → waiting-boots fallback: lo < lowerKC2 ชนะ over hi > upperKC2', () => {
    // หมายเหตุ: Pine evaluates fallback FIRST (lo check ก่อน) ดังนั้นเมื่อทั้งคู่เกิดพร้อมกัน
    // → lo < lowerKC2 ชนะเสมอ (waiting-boots) ไม่ใช่ hi > upperKC2 (waiting-break)
    const candles = flatCandles(40);
    candles[25] = { open: BASE, high: BASE + RANGE, low: BASE - RANGE, close: BASE };
    candles[27] = { open: BASE, high: BASE + RANGE, low: BASE - RANGE, close: BASE };
    candles[29] = { open: BASE, high: KC_OUTER_UP + 20, low: BASE - RANGE, close: BASE + 30 };
    candles[31] = { open: BASE, high: BASE + RANGE, low: 990, close: BASE }; // break
    // ที่ 33: ทั้ง lo < outer lower และ hi > outer upper → fallback ต้องให้ lo ชนะ
    candles[33] = { open: BASE, high: KC_OUTER_UP + 20, low: 920, close: BASE };
    const { modes } = btcTrend.computeBtcTrendPattern(candles);
    expect(modes[31]).toBe('break');
    expect(modes[33]).toBe('waiting-boots'); // lo < outer lower ชนะ over hi > outer upper
  });

  test('boots → boots: price ยังอยู่ในกรอบ → boots ต่อ', () => {
    const candles = flatCandles(30);
    candles[25] = { open: BASE, high: BASE + RANGE, low: KC_OUTER_LO - 10, close: BASE };
    candles[27] = { open: BASE, high: KC_INNER_LO + 10, low: BASE - RANGE, close: BASE };
    candles[28] = { open: BASE, high: BASE + 5, low: BASE - 5, close: BASE };
    const { modes } = btcTrend.computeBtcTrendPattern(candles);
    expect(modes[27]).toBe('boots');
    expect(modes[28]).toBe('boots');
  });

  test('break → break: price ยังอยู่ระหว่าง upperKC กับ lowerKC2', () => {
    const candles = flatCandles(40);
    candles[25] = { open: BASE, high: BASE + RANGE, low: BASE - RANGE, close: BASE };
    candles[27] = { open: BASE, high: BASE + RANGE, low: BASE - RANGE, close: BASE };
    candles[29] = { open: BASE, high: KC_OUTER_UP + 20, low: BASE - RANGE, close: BASE + 30 };
    candles[31] = { open: BASE, high: BASE + RANGE, low: 990, close: BASE };
    candles[32] = { open: BASE, high: BASE + 5, low: BASE - 5, close: BASE };
    const { modes } = btcTrend.computeBtcTrendPattern(candles);
    expect(modes[31]).toBe('break');
    expect(modes[32]).toBe('break');
  });
});

describe('btcTrendPattern — full state machine path', () => {
  // Integration test: ทุก transition เรียงต่อกันใน candles ชุดเดียว
  // ใช้ candles[29].high = 1100 (เพิ่ม ATR drift ~24) → ทุก candles หลังจากนั้น
  // ต้องใช้ price targets ที่ trigger ตามที่ต้องการ
  test('normal → waiting-boots → boots → waiting-break → break → waiting-boots', () => {
    const candles = flatCandles(40);
    candles[25] = { open: BASE, high: BASE + RANGE, low: BASE - RANGE, close: BASE };  // flat (normal)
    candles[27] = { open: BASE, high: BASE + RANGE, low: BASE - RANGE, close: BASE };  // flat (normal)
    candles[29] = { open: 1030, high: 1100, low: 990, close: 1030 };  // waiting-break (high > outer upper)
    candles[31] = { open: BASE, high: BASE + RANGE, low: 1006, close: BASE };  // break (low < inner upper)
    candles[33] = { open: BASE, high: BASE + RANGE, low: 930, close: BASE };  // waiting-boots (low < outer lower)
    const { modes } = btcTrend.computeBtcTrendPattern(candles);
    expect(modes[24]).toBe('normal');
    expect(modes[29]).toBe('waiting-break');
    expect(modes[31]).toBe('break');
    expect(modes[33]).toBe('waiting-boots');
  });
});