'use strict';

const { ema, atr } = require('./indicators');

/**
 * Keltner Channel + bg zone + S1 signal detector (Pine Script v5 compatible)
 *
 * Pine Script mapping:
 *   useTrueRange = true (default)
 *   kcLen = 20
 *   kcMult = 1.5
 *
 *   basisKC = ta.ema(close, 20)
 *   rngKC = ta.atr(20)   // Wilder RMA-based ATR
 *   upperKC = basisKC + 1.5 * rngKC
 *   lowerKC = basisKC - 1.5 * rngKC
 *
 *   bg1 = close > upperKC                  → bg_state = 1 (Strong Up - green)
 *   bg2 = close < basisKC and close > lowerKC → bg_state = 2 (Weak Down - purple)
 *   bg3 = close < lowerKC                  → bg_state = 3 (Strong Down - red)
 *   bg_state = 0 ถ้าไม่เข้าเงื่อนไขใดเลย
 *
 *   S1 = bg_prev == 2 AND (bg_state == 3 OR bg_state == 1)
 */

const KC_LEN = 20;
const KC_MULT = 1.5;

// คำนวณ bg_state ของแต่ละแท่ง
function computeBgStates({ closes, highs, lows, length = KC_LEN, mult = KC_MULT, useTrueRange = true }) {
  const n = closes.length;
  const basis = ema(closes, length);
  const rangeArr = useTrueRange ? atr(highs, lows, closes, length) : ema(
    highs.map((h, i) => h - lows[i]),
    length
  );

  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  const bg = new Array(n).fill(null);

  for (let i = 0; i < n; i += 1) {
    if (basis[i] === null || rangeArr[i] === null) continue;
    const u = basis[i] + mult * rangeArr[i];
    const l = basis[i] - mult * rangeArr[i];
    upper[i] = u;
    lower[i] = l;
    const c = closes[i];
    if (c > u) bg[i] = 1;
    else if (c < basis[i] && c > l) bg[i] = 2;
    else if (c < l) bg[i] = 3;
    else bg[i] = 0; // edge case: close == basisKC หรืออยู่ในช่องพอดี
  }

  return { basis, upper, lower, bg };
}

// ตรวจ S1 ที่ดัชนี i (ต้องมี bg[i-1])
function isS1At(bg, i) {
  if (i <= 0) return false;
  if (bg[i] === null || bg[i - 1] === null) return false;
  return bg[i - 1] === 2 && (bg[i] === 1 || bg[i] === 3);
}

/**
 * รับ array ของ klines [{openTime, open, high, low, close, volume}, ...]
 * คืน array ของ signal objects (S1 ที่เจอ) + bg array ทั้งหมด
 */
function detectS1Signals(klines, opts = {}) {
  const closes = klines.map((k) => parseFloat(k.close));
  const highs = klines.map((k) => parseFloat(k.high));
  const lows = klines.map((k) => parseFloat(k.low));

  const { basis, upper, lower, bg } = computeBgStates({ closes, highs, lows, ...opts });

  const signals = [];
  for (let i = 0; i < klines.length; i += 1) {
    if (isS1At(bg, i)) {
      signals.push({
        index: i,
        openTime: klines[i].openTime,
        closeTime: klines[i].closeTime,
        type: 'S1',
        close: closes[i],
        basisKC: basis[i],
        upperKC: upper[i],
        lowerKC: lower[i],
        bgState: bg[i],
        bgPrev: bg[i - 1],
      });
    }
  }

  return { signals, basis, upper, lower, bg };
}

// ตรวจ S1 บนแท่งล่าสุดเท่านั้น (สำหรับ live trading — ต้องมี previous candle)
function checkS1OnLatestCandle(klines, opts = {}) {
  if (!klines || klines.length < 2) return null;
  const { signals, bg } = detectS1Signals(klines, opts);
  const i = klines.length - 1;
  if (!isS1At(bg, i)) return null;
  const s = signals[signals.length - 1];
  return s;
}

// เช็คว่าพร้อมคำนวณสัญญาณหรือยัง (ต้องมีข้อมูล >= warm-up candles)
function isWarmedUp(klinesLength, length = KC_LEN) {
  // ATR (RMA) ต้องการ length แท่งขึ้นไป → ใช้ 2*length เพื่อความปลอดภัย
  return klinesLength >= length * 2;
}

module.exports = {
  computeBgStates,
  isS1At,
  detectS1Signals,
  checkS1OnLatestCandle,
  isWarmedUp,
  KC_LEN,
  KC_MULT,
};