'use strict';

/**
 * Pure indicator functions — compatible with Pine Script v5
 * - ema(close, length): standard EMA (init = SMA ของ first N)
 * - trueRange(high, low, prevClose): max(high-low, |high-prevClose|, |low-prevClose|)
 * - rma(values, length): Wilder's smoothing
 *   → first value = SMA of first N
 *   → subsequent = (prev*(N-1) + current) / N
 *   (ตรงกับ ta.atr(length) ของ Pine Script)
 * - atr(highs, lows, closes, length): ATR = Wilder RMA of TrueRange
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

module.exports = {
  ema,
  rma,
  trueRange,
  trueRangeSeries,
  atr,
};