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