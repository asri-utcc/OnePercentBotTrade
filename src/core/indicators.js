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

  // FIX-2026-08-24 (P2 audit): sanitize non-finite inputs (NaN/undefined/null)
  //   - เดิม: NaN ใน input → NaN propagate ทุก EMA value downstream → Keltner width NaN
  //     → false signal + auto-pause misfire (เคย trigger incident 2026-08-22)
  //   - fix: แทน non-finite ด้วย null ก่อนคำนวณ (warmup pattern มาตรฐาน)
  const v = values.map((x) => (Number.isFinite(x) ? x : null));
  if (v.some((x) => x === null)) {
    // ถ้ามี non-finite ใน window แรก → ขยาย warmup จนกว่าจะเจอ finite ทั้ง length ตัว
    let startIdx = 0;
    while (startIdx < v.length && v[startIdx] === null) startIdx += 1;
    if (v.length - startIdx < length) return out;
    // shift window: out indices 0..startIdx+length-2 are null, then compute from startIdx+length-1
    let sum = 0;
    for (let i = startIdx; i < startIdx + length; i += 1) sum += v[i];
    let prev = sum / length;
    out[startIdx + length - 1] = prev;
    for (let i = startIdx + length; i < v.length; i += 1) {
      if (v[i] === null) {
        // skip + carry prev forward (warmup gap)
        out[i] = prev;
        continue;
      }
      const cur = v[i] * k + prev * (1 - k);
      out[i] = cur;
      prev = cur;
    }
    return out;
  }

  // Init: SMA of first 'length' values
  if (v.length < length) return out;

  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    sum += v[i];
  }
  let prev = sum / length;
  out[length - 1] = prev;

  for (let i = length; i < v.length; i += 1) {
    const cur = v[i] * k + prev * (1 - k);
    out[i] = cur;
    prev = cur;
  }
  return out;
}

function trueRange(high, low, prevClose) {
  // FIX-2026-08-24 (P2 audit): NaN guard
  //   - ถ้า high/low/prevClose มี non-finite → คืน 0 (safe fallback)
  //   - เดิม: NaN propagate ทั้ง ATR → KC range → false SL-UKC trigger
  if (!Number.isFinite(high) || !Number.isFinite(low)) return 0;
  const hl = high - low;
  if (!Number.isFinite(prevClose)) return hl;
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

  // FIX-2026-08-24 (P2 audit): sanitize non-finite inputs
  const v = values.map((x) => (Number.isFinite(x) ? x : null));
  if (v.slice(0, length).some((x) => x === null)) return out;

  // SMA ของ first N
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += v[i];
  let prev = sum / length;
  out[length - 1] = prev;

  for (let i = length; i < v.length; i += 1) {
    if (v[i] === null) {
      // skip + carry prev (warmup gap pattern)
      out[i] = prev;
      continue;
    }
    const cur = (prev * (length - 1) + v[i]) / length;
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

  // FIX-2026-08-24 (P2 audit): sanitize non-finite inputs (NaN/undefined/null)
  //   - NaN ใน window → propagate ไป SMA → KC basis → false signal
  //   - skip + carry previous sum forward for non-finite values
  const v = values.map((x) => (Number.isFinite(x) ? x : null));
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    if (v[i] === null) return out; // เคยเจอ non-finite ใน first window → extend warmup
    sum += v[i];
  }
  out[length - 1] = sum / length;

  for (let i = length; i < v.length; i += 1) {
    if (v[i] === null) {
      // non-finite ใน window → skip + carry prev (warmup gap)
      out[i] = out[i - 1];
      continue;
    }
    const drop = v[i - length] === null ? 0 : v[i - length];
    sum += v[i] - drop;
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
  // FIX-2026-08-24 (P2 audit): filter non-finite in highs/lows/closes BEFORE ema/atr
  //   - เดิม: NaN ใน highs/lows → trueRangeSeries=NaN → atr=NaN → range=NaN → upper/lower=NaN
  //   - fix: NaN sanitize ที่ source — ema/rma already sanitize, แต่ atr ผ่าน trueRangeSeries
  //     ที่ใช้ trueRange(high, low, prevClose) — trueRange guard NaN แล้ว return 0 → atr ปลอดภัย
  const basis = ema(closes, length);
  const range = atr(highs, lows, closes, length);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const width = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i += 1) {
    const b = basis[i];
    const r = range[i];
    // FIX-2026-08-24 (P2 audit): strict Number.isFinite guard (was b == null || r == null — let NaN slip)
    if (!Number.isFinite(b) || !Number.isFinite(r)) continue;
    const u = b + mult * r;
    const l = b - mult * r;
    upper[i] = u;
    lower[i] = l;
    const c = closes[i];
    width[i] = Number.isFinite(c) && c > 0 ? ((u - l) / c) * 100 : null;
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