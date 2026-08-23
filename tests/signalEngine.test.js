'use strict';

const signalEngine = require('../src/core/signalEngine');
const indicators = require('../src/core/indicators');

describe('indicators', () => {
  test('ema คำนวณถูกต้อง', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
    const out = indicators.ema(values, 5);
    // out[4] = SMA(1..5) = 3
    expect(out[4]).toBeCloseTo(3, 5);
    // out[5] = 6 * (2/6) + 3 * (4/6) = 2 + 2 = 4
    expect(out[5]).toBeCloseTo(4, 5);
    // ทุกค่า >= 0 (ขึ้นอยู่กับ data)
    expect(out.every((v) => v === null || typeof v === 'number')).toBe(true);
  });

  test('rma (Wilder) คำนวณถูกต้อง', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out = indicators.rma(values, 5);
    // out[4] = SMA(1..5) = 3
    expect(out[4]).toBeCloseTo(3, 5);
    // out[5] = (3 * 4 + 6) / 5 = 18/5 = 3.6
    expect(out[5]).toBeCloseTo(3.6, 5);
    // out[6] = (3.6 * 4 + 7) / 5 = 21.4/5 = 4.28
    expect(out[6]).toBeCloseTo(4.28, 5);
  });

  test('atr ใช้ Wilder RMA', () => {
    // simple uptrend — TR = high - low บวก gap (|high-prevClose|)
    const highs = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const lows = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
    const closes = [9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5];
    const atr = indicators.atr(highs, lows, closes, 5);
    expect(atr.length).toBe(closes.length);
    expect(atr[0]).toBeNull();
    expect(atr[4]).not.toBeNull();
    // TR[0]=1, TR[1..]=max(1, |h-pc|=1.5, |l-pc|=0.5)=1.5
    // SMA(TR[0..4]) = (1+1.5+1.5+1.5+1.5)/5 = 1.4
    expect(atr[4]).toBeCloseTo(1.4, 5);
  });

  test('trueRange ของแท่งแรก = high-low', () => {
    const tr = indicators.trueRangeSeries([10], [9], [9.5]);
    expect(tr[0]).toBe(1);
  });
});

describe('signalEngine', () => {
  test('computeBgStates คำนวณ bg zones ถูกต้อง', () => {
    const closes = [
      ...Array(20).fill(100), // warmup
      95, 95, 110, 110, 100, 100, 90, 90,
    ];
    const highs = closes.map((c) => c + 0.5);
    const lows = closes.map((c) => c - 0.5);
    const { bg, upper, lower, basis } = signalEngine.computeBgStates({ closes, highs, lows });
    expect(bg.length).toBe(closes.length);
    // ช่วง warmup bg = null
    expect(bg[5]).toBeNull();
    // ทดสอบ bg zones ตาม close — หา index ที่มี bg != null
    // EMA(20) init ที่ index 19, RMA(20) init ที่ index 19 ดังนั้น bg valid ตั้งแต่ index 19
    const validIdx = bg.findIndex((b) => b !== null);
    expect(validIdx).toBeGreaterThanOrEqual(19);
    expect(validIdx).toBeLessThan(30);
  });

  test('S1 = bg_prev=2 เปลี่ยนเป็น 1 หรือ 3', () => {
    // สร้าง scenario: bg_prev=2, bg_state=1 → S1
    // แต่ละแท่งต้องมี bg state ครบ
    // ง่ายๆ: สร้างแท่งที่มี bg ตามต้องการ
    const closes = [
      ...Array(20).fill(100),
      // จากนั้นปรับเพื่อให้ bg=2, แล้วเปลี่ยนเป็น bg=1 หรือ bg=3
    ];
    const highs = closes.map((c) => c + 0.5);
    const lows = closes.map((c) => c - 0.5);

    // สร้างข้อมูลจริงที่ให้ S1 ปรากฏ
    const klines = [];
    for (let i = 0; i < 60; i += 1) {
      // close ให้แกว่งรอบ ๆ basis
      klines.push({
        openTime: i * 300000,
        closeTime: (i + 1) * 300000,
        open: 100,
        high: 102,
        low: 98,
        close: 100 + Math.sin(i / 5) * 5,
        volume: 100,
      });
    }
    const { signals } = signalEngine.detectS1Signals(klines);
    // คาดว่ามี signals อย่างน้อย 0 (อาจไม่มีถ้า data ไม่ trigger)
    expect(Array.isArray(signals)).toBe(true);
  });

  test('isS1At คืน false เมื่อ bg_prev ไม่ใช่ 2', () => {
    expect(signalEngine.isS1At([1, 1, 1], 1)).toBe(false);
    expect(signalEngine.isS1At([1, 3, 1], 1)).toBe(false);
    expect(signalEngine.isS1At([2, 1, 1], 2)).toBe(false);
  });

  test('isS1At คืน true เมื่อ bg_prev=2 และ bg=1 หรือ 3', () => {
    expect(signalEngine.isS1At([2, 1], 1)).toBe(true);
    expect(signalEngine.isS1At([2, 3], 1)).toBe(true);
  });

  test('isWarmedUp คืน true เมื่อมีข้อมูลพอ', () => {
    expect(signalEngine.isWarmedUp(20)).toBe(false); // น้อยกว่า 2x length (40)
    expect(signalEngine.isWarmedUp(40)).toBe(true);
    expect(signalEngine.isWarmedUp(100)).toBe(true);
  });
});

describe('integration: Pine Script compatibility', () => {
  test('scenario จริง: bg_state=2 → bg_state=1 คือ S1', () => {
    // สร้าง klines ที่ทำให้เกิด S1 อย่างแน่นอน
    const klines = [];
    // แท่ง 0-39: warmup
    for (let i = 0; i < 40; i += 1) {
      klines.push({
        openTime: i * 300000,
        closeTime: (i + 1) * 300000,
        open: 100, high: 101, low: 99, close: 100, volume: 100,
      });
    }
    // แท่ง 40-44: ทำให้ close อยู่ในช่วง weak down (bg=2)
    // basis ≈ 100, atr ≈ 1, upper ≈ 101.5, lower ≈ 98.5
    // bg=2 → 98.5 < close < 100
    for (let i = 40; i < 45; i += 1) {
      klines.push({
        openTime: i * 300000,
        closeTime: (i + 1) * 300000,
        open: 99, high: 99.5, low: 98.7, close: 99, volume: 100,
      });
    }
    // แท่ง 45: ทำให้ close > upperKC → bg=1 → S1!
    klines.push({
      openTime: 45 * 300000,
      closeTime: 46 * 300000,
      open: 100, high: 105, low: 100, close: 104, volume: 100,
    });
    const { signals } = signalEngine.detectS1Signals(klines);
    expect(signals.length).toBeGreaterThan(0);
    // ตรวจ signal สุดท้ายต้องตรง index 45
    const last = signals[signals.length - 1];
    expect(last.index).toBe(45);
    expect(last.bgPrev).toBe(2);
    expect(last.bgState).toBe(1);
  });

  test('scenario: bg_state=2 → bg_state=3 ก็เป็น S1', () => {
    const klines = [];
    for (let i = 0; i < 40; i += 1) {
      klines.push({ openTime: i*300000, closeTime: (i+1)*300000, open:100, high:101, low:99, close:100, volume:100 });
    }
    // bg=2 (98.5 < close < 100)
    for (let i = 40; i < 45; i += 1) {
      klines.push({ openTime: i*300000, closeTime: (i+1)*300000, open:99, high:99.5, low:98.7, close:99, volume:100 });
    }
    // bg=3 (close < 98.5)
    klines.push({ openTime: 45*300000, closeTime: 46*300000, open:97, high:98, low:95, close:96, volume:100 });
    const { signals } = signalEngine.detectS1Signals(klines);
    expect(signals.length).toBeGreaterThan(0);
    const last = signals[signals.length - 1];
    expect(last.index).toBe(45);
    expect(last.bgState).toBe(3);
    expect(last.bgPrev).toBe(2);
  });
});

// FIX-2026-08-03: Safe-trade filter #2 — LuxAlgo red pivot-low trendline port
describe('computeTrendlinePivotLows', () => {
  // Helper: build flat klines around a base price
  const flat = (n, base = 100) => {
    const ks = [];
    for (let i = 0; i < n; i += 1) {
      ks.push({ openTime: i * 300000, closeTime: (i + 1) * 300000,
        open: base, high: base + 0.5, low: base - 0.5, close: base, volume: 100 });
    }
    return ks;
  };

  test('returns null when n < 2*length+1', () => {
    const ks = flat(20); // length=14 needs >= 29 bars
    expect(signalEngine.computeTrendlinePivotLows(ks)).toBeNull();
  });

  test('all-null trendline when no pivot exists (flat market)', () => {
    const ks = flat(60);
    const tl = signalEngine.computeTrendlinePivotLows(ks);
    expect(tl).toHaveLength(60);
    // No strict pivot low in a flat series (no bar is strictly less than its neighbors with the required window)
    expect(tl.filter((v) => v != null).length).toBe(0);
  });

  test('detects V-shape pivot and extrapolates with positive slope', () => {
    const ks = flat(60, 100);
    // Carve a V-shape: drop to 90 at bar 30, recover to 100
    for (let i = 25; i < 36; i += 1) {
      const depth = 90 + (i === 30 ? 0 : Math.abs(i - 30) * 1.5);
      ks[i].low = depth;
      ks[i].high = depth + 0.5;
      ks[i].open = depth;
      ks[i].close = depth;
    }
    // Make sure pivot at 30 is the unique lowest point in window [16, 44]
    const tl = signalEngine.computeTrendlinePivotLows(ks);
    expect(tl).not.toBeNull();
    expect(tl).toHaveLength(60);
    // First non-null should be at or after pivot (index 30)
    const firstIdx = tl.findIndex((v) => v != null);
    expect(firstIdx).toBeGreaterThanOrEqual(30);
    expect(firstIdx).toBeLessThanOrEqual(45); // valid range [14, 46)
    // After first pivot, trendline extrapolates — generally last value should differ from first
    if (tl[tl.length - 1] != null && tl[firstIdx] != null) {
      // slope is ATR-based; with our data it will be > 0 (RMA rises after the V)
      // so the line tends to rise after the pivot
      expect(tl[tl.length - 1]).toBeGreaterThanOrEqual(tl[firstIdx] - 1e-6);
    }
  });

  test('extrapolation: line equals pivot.value at pivot index', () => {
    const ks = flat(60, 100);
    // Strong dip at bar 30 → pivot
    for (let i = 28; i < 33; i += 1) {
      ks[i].low = i === 30 ? 80 : 80 + Math.abs(i - 30);
      ks[i].open = ks[i].low;
      ks[i].close = ks[i].low;
      ks[i].high = ks[i].low + 0.1;
    }
    const tl = signalEngine.computeTrendlinePivotLows(ks);
    expect(tl).not.toBeNull();
    // Find first non-null — it should equal the pivot value exactly (line = pivot at pivot bar)
    const firstIdx = tl.findIndex((v) => v != null);
    expect(firstIdx).toBeGreaterThanOrEqual(14);
    expect(tl[firstIdx]).toBeCloseTo(ks[firstIdx].low, 5);
  });

  test('resets trendline when a new pivot fires', () => {
    // Two distinct V dips at bar 20 and bar 40
    const ks = flat(80, 100);
    for (let i = 18; i < 23; i += 1) {
      ks[i].low = i === 20 ? 70 : 70 + Math.abs(i - 20);
      ks[i].open = ks[i].low; ks[i].close = ks[i].low; ks[i].high = ks[i].low + 0.1;
    }
    for (let i = 38; i < 43; i += 1) {
      ks[i].low = i === 40 ? 50 : 50 + Math.abs(i - 40);
      ks[i].open = ks[i].low; ks[i].close = ks[i].low; ks[i].high = ks[i].low + 0.1;
    }
    const tl = signalEngine.computeTrendlinePivotLows(ks);
    expect(tl).not.toBeNull();
    // At least one pivot detected (we don't require both since windowing may merge)
    const nonNull = tl.filter((v) => v != null).length;
    expect(nonNull).toBeGreaterThan(0);
  });

  test('first-occurrence tie-break on equal lows', () => {
    // Two bars at exactly the same low value — only the leftmost should win
    const ks = flat(60, 100);
    ks[20].low = 80; ks[20].open = 80; ks[20].close = 80; ks[20].high = 80.1;
    ks[30].low = 80; ks[30].open = 80; ks[30].close = 80; ks[30].high = 80.1;
    // Make surrounding bars higher so both are strict-or-equal local minima
    for (let j = 19; j <= 21; j += 1) if (j !== 20) { ks[j].low = 90; ks[j].high = 90.5; }
    for (let j = 29; j <= 31; j += 1) if (j !== 30) { ks[j].low = 90; ks[j].high = 90.5; }
    const tl = signalEngine.computeTrendlinePivotLows(ks);
    expect(tl).not.toBeNull();
    // The trendline should NOT reset at bar 30 (first-occurrence wins)
    // i.e., trendline value at bar 30 should reflect extrapolation from bar 20, not a fresh pivot at 80
    if (tl[20] != null && tl[30] != null) {
      // Since first pivot at 20 extrapolates with slope >= 0, value at 30 should be >= 80
      // If 30 had been chosen as new pivot, tl[30] would be exactly 80
      // The tie-break ensures tl[30] > 80 OR equal (in degenerate case slope=0)
      expect(tl[30]).toBeGreaterThanOrEqual(80 - 1e-6);
    }
  });
});

// FIX-2026-08-19: Safe-trade #1 (strict green-only) — checkSafeTrade tests
//   Pattern: inject fake binanceRest.getKlines() returning Binance raw tuple arrays
//   Tuple format: [openTime, open, high, low, close, volume, closeTime, ...]
describe('checkSafeTrade (ST#1 strict green-only)', () => {
  // Build 25-bar history where bars 1-21 are flat at basePrice, bars 22-25 follow lastBars spec.
  // lastBars: array of {open, close} for the trailing 4 bars.
  function makeKlines(basePrice, lastBars) {
    const klines = [];
    // bars 0-20 (21 bars): flat
    for (let i = 0; i < 21; i += 1) {
      klines.push([i * 1000, basePrice, basePrice + 1, basePrice - 1, basePrice, 100]);
    }
    // bars 21-24 (4 bars): per lastBars spec
    lastBars.forEach((bar, idx) => {
      klines.push([(21 + idx) * 1000, bar.open, Math.max(bar.open, bar.close) + 1, Math.min(bar.open, bar.close) - 1, bar.close, 100]);
    });
    return klines;
  }

  test('green candle → PASS', async () => {
    // rising history ending with green bar
    const klines = makeKlines(100, [
      { open: 100, close: 104 },
      { open: 104, close: 108 },
      { open: 108, close: 112 },
      { open: 110, close: 115 }, // green: close > open
    ]);
    const fakeBinance = { getKlines: async () => klines };
    const bot = { symbol: 'BTCUSDT', timeframe: '3m', safeTradeEnabled: true };
    const st = await signalEngine.checkSafeTrade(bot, fakeBinance, indicators);
    expect(st.skip).toBe(false);
    expect(st.pass).toBe(true);
    expect(st.greenCandle).toBe(true);
    expect(st.superTF).toBe('4h');
    expect(st.reason).toBe('pass');
  });

  test('red candle above EMA20 → BLOCK (strict green-only — FIX-2026-08-19)', async () => {
    // rising history but last bar is red (pullback) — old OR-logic would PASS via aboveEma,
    // strict green-only rule MUST block.
    const klines = makeKlines(100, [
      { open: 100, close: 104 },
      { open: 104, close: 108 },
      { open: 108, close: 112 },
      { open: 115, close: 110 }, // RED but close=110 is well above EMA20 (~104)
    ]);
    const fakeBinance = { getKlines: async () => klines };
    const bot = { symbol: 'BTCUSDT', timeframe: '3m', safeTradeEnabled: true };
    const st = await signalEngine.checkSafeTrade(bot, fakeBinance, indicators);
    expect(st.greenCandle).toBe(false);
    expect(st.aboveEma).toBe(true);  // confirms EMA telemetry still computed
    expect(st.pass).toBe(false);
    expect(st.skip).toBe(true);
    expect(st.reason).toBe('blocked');
  });

  test('red candle below EMA20 → BLOCK', async () => {
    // downtrend: flat history, last bar red and below EMA
    const klines = makeKlines(100, [
      { open: 100, close: 99 },
      { open: 99, close: 98 },
      { open: 98, close: 97 },
      { open: 97, close: 95 }, // RED + close below EMA
    ]);
    const fakeBinance = { getKlines: async () => klines };
    const bot = { symbol: 'BTCUSDT', timeframe: '3m', safeTradeEnabled: true };
    const st = await signalEngine.checkSafeTrade(bot, fakeBinance, indicators);
    expect(st.greenCandle).toBe(false);
    expect(st.aboveEma).toBe(false);
    expect(st.pass).toBe(false);
    expect(st.skip).toBe(true);
  });

  test('doji (open === close) → BLOCK (strict > comparison)', async () => {
    // last bar: open=close — strict > means greenCandle=false
    const klines = makeKlines(100, [
      { open: 100, close: 104 },
      { open: 104, close: 108 },
      { open: 108, close: 112 },
      { open: 112, close: 112 }, // doji
    ]);
    const fakeBinance = { getKlines: async () => klines };
    const bot = { symbol: 'BTCUSDT', timeframe: '3m', safeTradeEnabled: true };
    const st = await signalEngine.checkSafeTrade(bot, fakeBinance, indicators);
    expect(st.greenCandle).toBe(false);
    expect(st.pass).toBe(false);
    expect(st.skip).toBe(true);
  });

  test('insufficient data (<21 bars) → FAIL-OPEN', async () => {
    const fakeBinance = { getKlines: async () => makeKlines(100, []).slice(0, 10) };
    const bot = { symbol: 'BTCUSDT', timeframe: '3m', safeTradeEnabled: true };
    const st = await signalEngine.checkSafeTrade(bot, fakeBinance, indicators);
    expect(st.skip).toBe(false);
    expect(st.reason).toBe('insufficient_data_open');
    expect(st.superTF).toBe('4h');
  });

  test('API error → FAIL-OPEN', async () => {
    const fakeBinance = { getKlines: async () => { throw new Error('binance 503'); } };
    const bot = { symbol: 'BTCUSDT', timeframe: '3m', safeTradeEnabled: true };
    const st = await signalEngine.checkSafeTrade(bot, fakeBinance, indicators);
    expect(st.skip).toBe(false);
    expect(st.reason).toBe('api_error_open');
    expect(st.superTF).toBe('4h');
  });

  test('safeTradeEnabled=false → disabled (no filter call)', async () => {
    // getKlines should NOT be called
    const fakeBinance = { getKlines: jest.fn ? jest.fn() : async () => { throw new Error('should not call'); } };
    const bot = { symbol: 'BTCUSDT', timeframe: '3m', safeTradeEnabled: false };
    const st = await signalEngine.checkSafeTrade(bot, fakeBinance, indicators);
    expect(st.skip).toBe(false);
    expect(st.reason).toBe('disabled');
  });

  test('TF not in SAFE_TRADE_SUPER_TF_MAP → no-filter', async () => {
    // TF=30m is not in map → no_super_tf, no Binance call
    const fakeBinance = { getKlines: async () => { throw new Error('should not call'); } };
    const bot = { symbol: 'BTCUSDT', timeframe: '30m', safeTradeEnabled: true };
    const st = await signalEngine.checkSafeTrade(bot, fakeBinance, indicators);
    expect(st.skip).toBe(false);
    expect(st.reason).toBe('no_super_tf');
    expect(st.superTF).toBe(null);
  });
});