'use strict';

/**
 * Pure indicator functions — compatible with Pine Script v5
 * - ema(close, length): standard EMA (init = SMA ของ first N)
 * - sma(close, length): simple moving average
 * - trueRange(high, low, prevClose): max(high-low, |high-prevClose|, |low-prevClose|)
 * - rma(values, length): Wilder's smoothing
 *   → first value = SMA of first N
 *   → subsequent = (prev*(N-1) + current) / N
 *   (ตรงกับ ta.atr(length) ของ Pine Script)
 * - atr(highs, lows, closes, length): ATR = Wilder RMA of TrueRange
 * - bollingerBands(closes, length, mult): { basis, upper, lower, width }
 */

function ema(values, length) {
  if (!values || values.length === 0) return [];
  const out = new Array(values.length).fill(null);
  const k = 2 / (length + 1);

  // Init: SMA of first 'length' values
  if (values.length < length) return out;

  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    sum += values[i];
  }
  let prev = sum / length;
  out[length - 1] = prev;

  for (let i = length; i < values.length; i += 1) {
    const cur = values[i] * k + prev * (1 - k);
    out[i] = cur;
    prev = cur;
  }
  return out;
}

function trueRange(high, low, prevClose) {
  const hl = high - low;
  if (prevClose === null || prevClose === undefined) return hl;
  const hc = Math.abs(high - prevClose);
  const lc = Math.abs(low - prevClose);
  return Math.max(hl, hc, lc);
}

function trueRangeSeries(highs, lows, closes) {
  const tr = new Array(closes.length).fill(null);
  if (closes.length === 0) return tr;
  // แท่งแรก: tr = high - low (ไม่มี prev close)
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < closes.length; i += 1) {
    tr[i] = trueRange(highs[i], lows[i], closes[i - 1]);
  }
  return tr;
}

/**
 * Wilder's RMA
 * - length N
 * - out[0..N-2] = null
 * - out[N-1] = SMA(tr[0..N-1])
 * - out[i] = (out[i-1]*(N-1) + tr[i]) / N
 */
function rma(values, length) {
  if (!values || values.length === 0) return [];
  const out = new Array(values.length).fill(null);
  if (values.length < length) return out;

  // SMA ของ first N
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += values[i];
  let prev = sum / length;
  out[length - 1] = prev;

  for (let i = length; i < values.length; i += 1) {
    const cur = (prev * (length - 1) + values[i]) / length;
    out[i] = cur;
    prev = cur;
  }
  return out;
}

function atr(highs, lows, closes, length) {
  const tr = trueRangeSeries(highs, lows, closes);
  return rma(tr, length);
}

/**
 * Simple Moving Average
 * - out[0..length-2] = null (warmup)
 * - out[length-1..] = mean of the trailing `length` values
 */
function sma(values, length) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const out = new Array(values.length).fill(null);
  if (values.length < length || length <= 0) return out;

  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += values[i];
  out[length - 1] = sum / length;

  for (let i = length; i < values.length; i += 1) {
    sum += values[i] - values[i - length];
    out[i] = sum / length;
  }
  return out;
}

/**
 * Keltner Channel (default: period=20, mult=1.5) — ใช้ EMA ฐาน + Wilder ATR.
 * - basis  = EMA(closes, length)
 * - range  = ATR(highs, lows, closes, length)  (Wilder-RMA based)
 * - upper  = basis + mult * range
 * - lower  = basis - mult * range
 * - width  = (upper - lower) / close * 100     (เป็น % ของ close; 0 ถ้า warmup)
 *
 * Matches src/core/signalEngine.js math 1:1 — ใช้สูตรเดียวกับหน้า chart
 * และ bot signal. Returns arrays of the same length as `closes`.
 * Indices < length-1 are null (warmup).
 */
function keltnerChannel(highs, lows, closes, length = 20, mult = 1.5) {
  if (!Array.isArray(closes) || closes.length === 0) {
    return { basis: [], upper: [], lower: [], width: [] };
  }
  const basis = ema(closes, length);
  const range = atr(highs, lows, closes, length);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const width = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i += 1) {
    const b = basis[i];
    const r = range[i];
    if (b == null || r == null || r === undefined) continue;
    const u = b + mult * r;
    const l = b - mult * r;
    upper[i] = u;
    lower[i] = l;
    width[i] = closes[i] > 0 ? ((u - l) / closes[i]) * 100 : 0;
  }
  return { basis, upper, lower, width };
}

/**
 * Bollinger Bands (TradingView default: period=20, mult=2).
 * - basis = SMA(closes, length)
 * - sd = population std-dev over same window
 * - upper = basis + mult*sd
 * - lower = basis - mult*sd
 * - width = (upper - lower) / basis   ← BBW (0 for null/incomplete windows)
 *
 * Returns arrays of the same length as `closes`. Indices < length-1 are null
 * (warmup).
 */
function bollingerBands(closes, length = 20, mult = 2) {
  if (!Array.isArray(closes) || closes.length === 0) {
    return { basis: [], upper: [], lower: [], width: [] };
  }
  const basis = sma(closes, length);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const width = new Array(closes.length).fill(null);

  for (let i = length - 1; i < closes.length; i += 1) {
    const m = basis[i];
    if (m === null || m === undefined) continue;
    let s = 0;
    for (let j = i - length + 1; j <= i; j += 1) {
      const d = closes[j] - m;
      s += d * d;
    }
    const sd = Math.sqrt(s / length);
    const u = m + mult * sd;
    const l = m - mult * sd;
    upper[i] = u;
    lower[i] = l;
    width[i] = m > 0 ? (u - l) / m : 0;
  }
  return { basis, upper, lower, width };
}

module.exports = {
  ema,
  sma,
  rma,
  trueRange,
  trueRangeSeries,
  atr,
  keltnerChannel,
  bollingerBands,
};