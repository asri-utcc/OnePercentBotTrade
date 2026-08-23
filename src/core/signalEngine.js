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
 *
 * FIX-2026-07-25: XS1 anti-dump gate (per-bot toggle via opts.xs1Enabled, default true)
 *   ป้องกันการซื้อขณะราคาไหลเร็วเกินไป (candle-wide dump)
 *   XS1 = (close < lowerKC AND open > basisKC)
 *      OR (open[1] > basisKC[1] AND close[1] < basisKC[1]
 *          AND close < lowerKC AND open < basisKC)
 *   opts.xs1Enabled:
 *     - true  (default) → ถ้า XS1 = true ให้ skip S1 signal
 *     - false           → ใช้สัญญาณดั้งเดิม (ไม่ skip แม้ candle-wide dump) — สำหรับบอทที่ user อยาก S1 ตามปกติ
 */

const KC_LEN = 20;
const KC_MULT = 1.5;

// FIX-2026-08-05: Safe-trade filter #3 — Pine "No-Trade Signal Engine" constants
//   - kcLen=20 (fixed, matches Pine)
//   - kcMult = bot.kcMult (per-bot, pass-through via opts.mult) — FIX ให้ consistent กับ S1
const NO_TRADE_KC_LEN = 20;

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
// FIX-2026-07-24: opts.onlyDown
//   - false (default, backward-compat): S1 = bg_prev=2 AND (bg=1 OR bg=3)
//   - true: S1 = bg_prev=2 AND bg=3 เท่านั้น (ลง — ไม่ซื้อตอนราคาสูง)
// FIX-2026-07-25: XS1 anti-dump (always applied)
//   - ถ้า candle-wide dump → skip signal (กันราคาไหลเร็ว)
//   - ดู isXS1At() ด้านล่างสำหรับ pattern เต็ม
function isS1At(bg, i, opts = {}) {
  if (i <= 0) return false;
  if (bg[i] === null || bg[i - 1] === null) return false;
  if (bg[i - 1] !== 2) return false;
  if (opts.onlyDown) {
    if (bg[i] !== 3) return false;
  } else {
    if (bg[i] !== 1 && bg[i] !== 3) return false;
  }
  return true;
}

// FIX-2026-07-25: XS1 anti-dump gate (hard rule)
//   ตรวจว่า candle มี pattern "ไหลเร็วเกินไป" หรือไม่ — ถ้าใช่ → skip S1
//
//   XS1 = (close < lowerKC AND open > basisKC)
//      OR (open[1] > basisKC[1] AND close[1] < basisKC[1]
//          AND close < lowerKC AND open < basisKC)
//
//   index [1] = previous candle (i-1)
//
//   Inputs:
//     i         - index ของ current candle
//     opens     - array ของ open prices (ทุก kline)
//     closes    - array ของ close prices
//     basis     - array ของ basisKC (จาก computeBgStates)
//     lower     - array ของ lowerKC (จาก computeBgStates)
//
//   Returns: true ถ้า candle มี dump pattern (ให้ caller skip signal)
function isXS1At(i, opens, closes, basis, lower) {
  if (i <= 0) return false;
  if (opens[i] == null || closes[i] == null || basis[i] == null || lower[i] == null) return false;
  if (opens[i - 1] == null || closes[i - 1] == null || basis[i - 1] == null || lower[i - 1] == null) return false;
  // Pattern A: current candle alone dumps hard
  //   close < lowerKC AND open > basisKC
  //   → opened above basis, closed below lower (full-channel crash)
  const patternA = closes[i] < lower[i] && opens[i] > basis[i];
  // Pattern B: previous candle started above basis, then 2 consecutive dumps
  //   open[1] > basisKC[1] AND close[1] < basisKC[1]
  //   AND close < lowerKC AND open < basisKC
  const patternB = opens[i - 1] > basis[i - 1]
    && closes[i - 1] < basis[i - 1]
    && closes[i] < lower[i]
    && opens[i] < basis[i];
  return patternA || patternB;
}

// FIX-2026-07-30: Circuit-breaker (CB) panic-sell pattern — เดิมชื่อ SLS1
//   "กราฟไหลลงแล้วไม่ขึ้นอีกเลย" — 3 แท่งติด RED + below lowerKC
//
//   FIX-2026-08-09: ปรับให้ตรง Pine "sls12" (3-candle) — เดิมใช้ 4 แท่ง (off-by-one)
//     Pine sls12 = close<lowerKC and open<lowerKC and close[1]<lowerKC[1] and open[1]<lowerKC[1]
//                       and close[2]<lowerKC[2] and open[2]<lowerKC[2]
//                       and open>close and open[1]>close[1] and open[2]>close[2]
//     = 3 candles (i, i-1, i-2) all RED AND fully below lowerKC
//   - เดิม JS เช็ค 4 แท่ง (i, i-1, i-2, i-3) — เข้มงวดเกินไป 1 candle
//   - ผลกระทบ: CB fires เร็วขึ้น (Pine-correct) — ตรงกับ Pine script ต้นฉบับ
//
//   CB[i] = (open[i]  > close[i])  AND   # current red candle (ยังไหลลง)
//             (open[i-1] > close[i-1]) AND
//             (open[i-2] > close[i-2]) AND
//             (close[i]   < lowerKC[i])   AND (open[i]   < lowerKC[i])
//             AND (close[i-1] < lowerKC[i-1]) AND (open[i-1] < lowerKC[i-1])
//             AND (close[i-2] < lowerKC[i-2]) AND (open[i-2] < lowerKC[i-2])
//
//   Inputs:
//     i        - index ของ current candle (ต้อง >= 2)
//     opens    - array ของ open prices
//     closes   - array ของ close prices
//     lower    - array ของ lowerKC (จาก computeBgStates)
//
//   Returns: true ถ้า candle มี 3-candle panic-sell pattern (caller force-close ทุก position ในบอท)
function isCBAt(i, opens, closes, lower) {
  if (i < 2) return false;
  // current bar must be valid + red + below lowerKC
  if (opens[i] == null || closes[i] == null || lower[i] == null) return false;
  if (opens[i] <= closes[i]) return false; // not a red candle
  if (!(closes[i] < lower[i] && opens[i] < lower[i])) return false;
  // previous 2 bars must each be red AND fully below lowerKC (Pine sls12 = 3 candles total)
  for (let k = i - 1; k >= i - 2; k -= 1) {
    if (opens[k] == null || closes[k] == null || lower[k] == null) return false;
    if (opens[k] <= closes[k]) return false; // ไม่ใช่แท่งแดง
    if (!(closes[k] < lower[k] && opens[k] < lower[k])) return false;
  }
  return true;
}

// FIX-2026-08-06: Circuit-breaker V2 (CBv2) — sustained 4-candle breach lock (stricter than CB)
//   - matches user's Pine (FIX-2026-08-09: corrected to Pine semantics):
//       sls12 = close<lowerKC and open<lowerKC and close[1]<lowerKC[1] and open[1]<lowerKC[1]
//             and close[2]<lowerKC[2] and open[2]<lowerKC[2]
//             and open>close and open[1]>close[1] and open[2]>close[2]
//       cbv2  = sls12 and sls12[1]
//   - CBv2 = sls12(i) AND sls12(i-1) = 4 แท่ง consecutive (i-3, i-2, i-1, i) all RED+below lowerKC
//   - ต่างจาก CB (3 แท่ง) ตรงที่ต้องมี 4 แท่ง consecutive จริงๆ (no warmup gap)
//   - เดิม JS ใช้ isCBAt(i) AND isCBAt(i-1) แต่ isCBAt เคยเช็ค 4 แท่ง = รวม 5 แท่ง (off-by-one +1)
//   - หลัง FIX-2026-08-09 isCBAt เช็ค 3 แท่ง (Pine sls12) → CBv2 = 4 แท่ง (Pine cbv2) ✓
//
//   Inputs:
//     i        - index ของ current candle (ต้อง >= 3 เพราะ isCBAt(i-1) ต้องการ i-3)
//     opens    - array ของ open prices
//     closes   - array ของ close prices
//     lower    - array ของ lowerKC (จาก computeBgStates)
//
//   Returns: true ถ้า candle มี 4-candle sustained breach (caller force-close + lock บอท cbv2LockHours ชั่วโมง)
function isCBv2At(i, opens, closes, lower) {
  if (i < 3) return false;
  if (!isCBAt(i, opens, closes, lower)) return false;
  if (!isCBAt(i - 1, opens, closes, lower)) return false;
  return true;
}

/**
 * รับ array ของ klines [{openTime, open, high, low, close, volume}, ...]
 * คืน array ของ signal objects (S1 ที่เจอ) + bg array ทั้งหมด
 */
function detectS1Signals(klines, opts = {}) {
  const closes = klines.map((k) => parseFloat(k.close));
  const highs = klines.map((k) => parseFloat(k.high));
  const lows = klines.map((k) => parseFloat(k.low));
  // FIX-2026-07-25: opens needed for XS1 anti-dump pattern A/B
  const opens = klines.map((k) => parseFloat(k.open));

  const { basis, upper, lower, bg } = computeBgStates({ closes, highs, lows, ...opts });

  const signals = [];
  for (let i = 0; i < klines.length; i += 1) {
    if (!isS1At(bg, i, opts)) continue;
    // FIX-2026-07-25: XS1 anti-dump gate (per-bot toggle — opts.xs1Enabled, default true)
    //   ผู้ใช้สามารถปิดได้ต่อบอท (bot.xs1Enabled=false) → ใช้สัญญาณดั้งเดิม
    if (opts.xs1Enabled !== false && isXS1At(i, opens, closes, basis, lower)) continue;
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

  return { signals, basis, upper, lower, bg };
}

// ตรวจ S1 บนแท่งล่าสุดเท่านั้น (สำหรับ live trading — ต้องมี previous candle)
// FIX-2026-07-25: คืน object { signal, xs1 } — xs1=true ถ้า candle มี dump pattern
//   - signal=null && xs1=true  → S1 base match แต่ skip เพราะ candle-wide dump
//   - signal=null && xs1=false → ไม่ใช่ S1 base match
//   - signal=object && xs1=false → valid S1 signal
//   - signal=object && xs1=true  → เป็นไปไม่ได้ (filter ที่ detectS1Signals แล้ว)
// FIX-2026-07-25: opts.xs1Enabled (per-bot toggle)
//   - true (default): ถ้า XS1 = true → skip (return { signal: null, xs1: true })
//   - false: XS1 ไม่ skip → return signal ปกติ (xs1=false)
function checkS1OnLatestCandle(klines, opts = {}) {
  if (!klines || klines.length < 2) return { signal: null, xs1: false };
  const { signals, bg } = detectS1Signals(klines, opts);
  const i = klines.length - 1;
  const baseS1 = isS1At(bg, i, opts);
  if (!baseS1) return { signal: null, xs1: false };
  // ตรวจ XS1 เพิ่มเติม (สำหรับ diagnostic — caller รู้ว่าถูก skip เพราะอะไร)
  const opens = klines.map((k) => parseFloat(k.open));
  const closes = klines.map((k) => parseFloat(k.close));
  const { basis, lower } = computeBgStates({
    closes,
    highs: klines.map((k) => parseFloat(k.high)),
    lows: klines.map((k) => parseFloat(k.low)),
    ...opts,
  });
  const xs1 = isXS1At(i, opens, closes, basis, lower);
  // FIX-2026-07-25: ถ้า xs1Enabled=false → ไม่ skip แม้ xs1=true (return signal ปกติ)
  if (xs1 && opts.xs1Enabled !== false) return { signal: null, xs1: true };
  const s = signals[signals.length - 1];
  return { signal: s, xs1 };
}

// เช็คว่าพร้อมคำนวณสัญญาณหรือยัง (ต้องมีข้อมูล >= warm-up candles)
function isWarmedUp(klinesLength, length = KC_LEN) {
  // ATR (RMA) ต้องการ length แท่งขึ้นไป → ใช้ 2*length เพื่อความปลอดภัย
  return klinesLength >= length * 2;
}

// FIX-2026-08-09: minimum candles required for CBv2/CBv3 evaluation
//   - EMA(20)+ATR(20) need 20 warmup (lowerKC[i] valid when i >= 19)
//   - isCBv2At(i) at lastIdx needs lowerKC[i-3] valid → lastIdx >= 22 → array length >= 23
//   - Returns length + 3 = 23 for default KC_LEN=20
//   - Used by cbPatternEvaluator + positionWatchdog (was hardcoded as 21 in trader/watchdog — INCORRECT)
function minimumCBv2Warmup(length = KC_LEN) {
  return length + 3;
}

// FIX-2026-08-01: Safe-trade super-upper TF map (separate from TREND_TF_MAP — thresholds differ)
//   - 3m/5m → 4h (ตรวจ 4h ว่าเป็นแท่งเขียว/เหนือ EMA20 ก่อนซื้อ)
//   - 15m → 1d
//   - 1h → 1w
//   - บอท TF อื่น (1m, 30m, 2h, 4h, 1d+) → no-filter (log "no_super_tf")
const SAFE_TRADE_SUPER_TF_MAP = {
  '3m': '4h',
  '5m': '4h',
  '15m': '1d',
  '1h': '1w',
};

// FIX-2026-08-19: Safe-trade filter (STRICT green-only) — ก่อนวาง BUY ให้เช็ค super-upper TF
//   - PASS condition: lastClose > lastOpen (แท่งเขียวเท่านั้น) — strict
//   - แท่งแดง → block ทันที แม้ราคาจะอยู่เหนือ EMA20 (เดิม OR กับ aboveEma แต่ปรับให้เข้มงวดขึ้น 2026-08-19)
//   - aboveEma ยังคง compute + return เพื่อ log/debug telemetry (ไม่กระทบ pass decision)
//   - FAIL-OPEN on Binance error / insufficient data (mirror previous behavior)
//   - return { skip, pass, greenCandle, aboveEma, superTF, lastClose, lastOpen, lastEma, reason }
//     skip=true means trader should NOT place BUY on this S1 signal
async function checkSafeTrade(bot, binanceRest, indicators) {
  if (bot.safeTradeEnabled === false) {
    return { skip: false, reason: 'disabled' };
  }
  const superTF = SAFE_TRADE_SUPER_TF_MAP[bot.timeframe];
  if (!superTF) {
    return { skip: false, reason: 'no_super_tf', superTF: null };
  }
  try {
    const raw = await binanceRest.getKlines({ symbol: bot.symbol, interval: superTF, limit: 25 });
    if (!Array.isArray(raw) || raw.length < 21) {
      // FAIL-OPEN: insufficient data → allow buy + warn
      return { skip: false, reason: 'insufficient_data_open', superTF };
    }
    const last = raw[raw.length - 1];
    const lastClose = parseFloat(last[4]);
    const lastOpen = parseFloat(last[1]);
    const closes = raw.map((k) => parseFloat(k[4]));
    const emaArr = indicators.ema(closes, 20);
    const lastEma = emaArr[emaArr.length - 1];
    const greenCandle = lastClose > lastOpen;
    const aboveEma = lastEma != null && Number.isFinite(lastEma) && lastClose > lastEma;
    // FIX-2026-08-19: strict — greenCandle ONLY; แดง → block ไม่สน EMA
    const pass = greenCandle;
    return {
      skip: !pass,
      pass,
      greenCandle,
      aboveEma,
      superTF,
      lastClose,
      lastOpen,
      lastEma,
      reason: pass ? 'pass' : 'blocked',
    };
  } catch (err) {
    // FAIL-OPEN: API error → allow buy + warn
    return { skip: false, reason: 'api_error_open', error: err.message, superTF };
  }
}

// FIX-2026-08-03: Safe-trade filter #2 — LuxAlgo red pivot-low trendline (helper)
//   - Ported from Pine "Trendlines with Breaks" by LuxAlgo (CC BY-NC-SA 4.0) — red dashed line only
//   - Pine algorithm:
//     length = 14
//     mult   = 1.0
//     pl     = ta.pivotlow(length, length)  // low[i] is strict min in [i-length, i+length]
//     slope  = ta.atr(length) / length * mult  // ATR-based slope (price units per bar)
//     var lower    = pl ? pl : lower + slope_pl    // trendline value (persists across bars)
//     var slope_pl = pl ? slope : slope_pl          // slope from last pivot (persists)
//   - On each bar: trendline value = pivotLowValue + slope * (barIndex - pivotBarIndex)
//   - Returns null when n < 2*length+1 (can't form even one confirmed pivot)
//
//   Pivot detection tie-break matches Pine:
//     - first occurrence wins (leftmost equal-low in window is the pivot)
//     - if a stricter low exists anywhere in window → not a pivot
//     - valid range: [length, n-length) — last `length` bars cannot be confirmed (need right-side data)
//
//   Returns:
//     trendline: Array<number|null>  same length as klines
//                null until first pivot (warmup), then extrapolated forward
//                resets at each new pivot detection
function computeTrendlinePivotLows(klines, opts = {}) {
  const length = opts.length != null ? opts.length : 14;
  const mult = opts.mult != null ? opts.mult : 1.0;
  const n = klines.length;
  if (n < 2 * length + 1) return null; // not enough data for a single confirmed pivot

  const highs = klines.map((k) => parseFloat(k.high));
  const lows = klines.map((k) => parseFloat(k.low));
  const closes = klines.map((k) => parseFloat(k.close));

  // FIX-2026-08-03: use Wilder RMA ATR (matches Pine ta.atr(length))
  //   - atr() in indicators.js returns null-padded array (first length-1 entries = null)
  //   - slope captured at pivot bar (Pine semantics — Pine evaluates `slope = ta.atr(length)` at bar i)
  const atrArr = atr(highs, lows, closes, length);

  // Build pivotAtIndex[i] = {index, value, slope} or null
  //   - O(n × (2*length+1)) = acceptable for length=14 + n=200 (~5700 comparisons)
  const pivotAtIndex = new Array(n).fill(null);
  for (let i = length; i < n - length; i += 1) {
    const low = lows[i];
    if (low == null) continue;
    let isLowest = true;
    for (let j = i - length; j <= i + length; j += 1) {
      if (j === i) continue;
      const lj = lows[j];
      if (lj == null || lj < low) { isLowest = false; break; }
      if (lj === low && j < i) { isLowest = false; break; } // first-occurrence tie-break (matches Pine)
    }
    if (isLowest) {
      const slope = (atrArr[i] != null ? atrArr[i] : 0) / length * mult;
      pivotAtIndex[i] = { index: i, value: low, slope };
    }
  }

  // Extend trendline forward from each pivot (Pine-style `var lower` + `var slope_pl`)
  //   - before first pivot: null (caller fails-open)
  //   - after pivot: trendline[i] = pivot.value + pivot.slope * (i - pivot.index)
  //   - when new pivot fires: line resets to new pivot value + new slope
  const trendline = new Array(n).fill(null);
  let cur = null;
  for (let i = 0; i < n; i += 1) {
    if (pivotAtIndex[i] != null) cur = pivotAtIndex[i];
    if (cur != null) trendline[i] = cur.value + cur.slope * (i - cur.index);
  }
  return trendline;
}

// FIX-2026-08-03: Safe-trade filter #2 — entry point (live trader)
//   - On S1 BUY signal: check upper-TF price > LuxAlgo red pivot-low trendline
//   - PASS = lastClose > trendline value at current bar → BUY
//   - FAIL-OPEN on Binance error / warmup / insufficient data (never block on infrastructure issue)
//   - trendTF passed in by caller (resolved via volatilityScanner.TREND_TF_MAP outside this module)
//     — keeps signalEngine as a leaf module (no circular import with volatilityScanner)
//   - returns: {skip, pass, reason, trendTF, lastClose, trendlineValue, gapPct, pivotCount, error?}
//       reason ∈ 'disabled' | 'no_trend_tf' | 'warmup' | 'insufficient_data_open'
//             | 'api_error_open' | 'pass' | 'blocked'
//       skip=true ONLY when reason='blocked'
async function checkSafeTradeTrendline(bot, trendTF, binanceRest) {
  if (bot.safeTradeTrendlineEnabled !== true) {
    return { skip: false, pass: true, reason: 'disabled', trendTF: null };
  }
  if (!trendTF) {
    return { skip: false, pass: true, reason: 'no_trend_tf', trendTF: null };
  }
  try {
    const raw = await binanceRest.getKlines({ symbol: bot.symbol, interval: trendTF, limit: 200 });
    if (!Array.isArray(raw) || raw.length < 50) {
      // FAIL-OPEN: insufficient data → allow buy + warn
      return { skip: false, pass: true, reason: 'insufficient_data_open', trendTF };
    }
    // Binance raw tuple [openTime, open, high, low, close, volume, closeTime, ...] → object kline
    const klines = raw.map((k) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      closeTime: k[6],
    }));
    const trendline = computeTrendlinePivotLows(klines);
    const lastIdx = klines.length - 1;
    const trendlineValue = trendline ? trendline[lastIdx] : null;
    if (trendlineValue == null || !Number.isFinite(trendlineValue)) {
      // Warmup — no pivot yet (or trendline invalid). Fail-OPEN.
      return { skip: false, pass: true, reason: 'warmup', trendTF, pivotCount: 0 };
    }
    const lastClose = klines[lastIdx].close;
    const pass = lastClose > trendlineValue;
    const gapPct = ((lastClose - trendlineValue) / trendlineValue) * 100;
    // count pivots: trendline non-null count is a reasonable proxy (same as bars after first pivot)
    const pivotCount = trendline ? trendline.filter((v) => v != null).length : 0;
    return {
      skip: !pass,
      pass,
      reason: pass ? 'pass' : 'blocked',
      trendTF,
      lastClose,
      trendlineValue,
      gapPct,
      pivotCount,
    };
  } catch (err) {
    // FAIL-OPEN: API error → allow buy + warn
    return { skip: false, pass: true, reason: 'api_error_open', error: err.message, trendTF };
  }
}

// FIX-2026-08-05: Safe-trade filter #3 — Pine "No-Trade Signal Engine" patterns + state machine
//   - Ported from Pine Script by user (Bearish Engulfing 1-bar / 2-bar + Shooting Star)
//   - All patterns must be in upper KC zone (open or close > upperKC)
//   - Tolerance: open*1.001 >= close[1], close*0.999 <= open[1] (Pine: open*(1.001) ... close*(0.999))
//   - Returns per-bar result of {kind: 'none'|'nt'|'nt1'} (same length as klines)
//   - **Real-time**: Binance REST `getKlines` returns the current incomplete candle as the last
//     entry (close = last price แบบ live) — Pine semantics เดิม run ทุก tick จึง treat เหมือน closed bar

// Pattern 1: Bearish Engulfing (1-bar) — red candle �ลืนกิน green [1]
//   Pine: close[1] > open[1] AND close < open
//         AND open*1.001 >= close[1] AND close*0.999 <= open[1]
//         AND (close[1] > upperKC OR open > upperKC)
function isEngulf1BarAt(i, opens, closes, upperKC) {
  if (i < 1) return false;
  if (opens[i] == null || closes[i] == null || opens[i - 1] == null || closes[i - 1] == null) return false;
  if (upperKC[i] == null) return false;
  const greenPrev = closes[i - 1] > opens[i - 1];
  const redNow = closes[i] < opens[i];
  const coversHigh = opens[i] * 1.001 >= closes[i - 1];
  const dipsBelow = closes[i] * 0.999 <= opens[i - 1];
  // FIX-2026-08-09: Pine `upperKC` (no index) = current bar's value — ใช้ upperKC[i] ทั้งคู่
  const inUpperZone = closes[i - 1] > upperKC[i] || opens[i] > upperKC[i];
  return greenPrev && redNow && coversHigh && dipsBelow && inUpperZone;
}

// Pattern 1.2: Bearish Engulfing (2-bar) — green [2] → red/doji [1] → red [0] กลืนกินย้อนไปถึง [2]
//   Pine: close[2] > open[2] AND close[1] <= open[1] AND close < open
//         AND close*0.999 <= open[2]
//         AND (close[2] > upperKC OR close[1] > upperKC OR open > upperKC)
function isEngulf2BarAt(i, opens, closes, upperKC) {
  if (i < 2) return false;
  if (opens[i] == null || closes[i] == null
      || opens[i - 1] == null || closes[i - 1] == null
      || opens[i - 2] == null || closes[i - 2] == null) return false;
  if (upperKC[i] == null) return false;
  const green2Ago = closes[i - 2] > opens[i - 2];
  const redOrDoji1Ago = closes[i - 1] <= opens[i - 1];
  const redNow = closes[i] < opens[i];
  const dipsBelow2Open = closes[i] * 0.999 <= opens[i - 2];
  // FIX-2026-08-09: Pine `upperKC` (no index) = current bar's value — ใช้ upperKC[i] ทั้งหมด
  const inUpperZone = closes[i - 2] > upperKC[i]
    || closes[i - 1] > upperKC[i]
    || opens[i] > upperKC[i];
  return green2Ago && redOrDoji1Ago && redNow && dipsBelow2Open && inUpperZone;
}

// Pattern 2: Shooting Star — small body + long upper wick + small lower wick ใน upper KC zone
//   Pine: bodySize = |close - open|
//         upperWick = high - max(open, close)
//         lowerWick = min(open, close) - low
//         candleRange = high - low
//         isSmallBody = bodySize <= candleRange * bodyMaxPercent AND candleRange > 0
//         isLongUpperWick = upperWick >= bodySize * wickRatio AND upperWick >= candleRange * 0.5
//         isSmallLowerWick = lowerWick <= candleRange * lowerWickMaxPercent
//         isShootingStar = above + (open > upperKC OR close > upperKC)
function isShootingStarAt(i, opens, closes, highs, lows, upperKC, opts = {}) {
  const bodyMaxPercent = opts.bodyMaxPercent != null ? opts.bodyMaxPercent : 0.35;
  const wickRatio = opts.wickRatio != null ? opts.wickRatio : 2.0;
  const lowerWickMaxPercent = opts.lowerWickMaxPercent != null ? opts.lowerWickMaxPercent : 0.15;
  if (opens[i] == null || closes[i] == null || highs[i] == null || lows[i] == null || upperKC[i] == null) {
    return false;
  }
  const candleRange = highs[i] - lows[i];
  if (candleRange <= 0) return false;
  const bodySize = Math.abs(closes[i] - opens[i]);
  const upperWick = highs[i] - Math.max(opens[i], closes[i]);
  const lowerWick = Math.min(opens[i], closes[i]) - lows[i];
  const isSmallBody = bodySize <= candleRange * bodyMaxPercent;
  const isLongUpperWick = upperWick >= bodySize * wickRatio && upperWick >= candleRange * 0.5;
  const isSmallLowerWick = lowerWick <= candleRange * lowerWickMaxPercent;
  const inUpperZone = opens[i] > upperKC[i] || closes[i] > upperKC[i];
  return isSmallBody && isLongUpperWick && isSmallLowerWick && inUpperZone;
}

// computeNoTradePerBar — คำนวณ per-bar nt/nt1/none พร้อม state machine
//   - inputs: klines [{openTime, open, high, low, close, volume}], opts.mult (kcMult from bot)
//   - returns Array<{kind: 'none'|'nt'|'nt1'}> (same length)
//   - Pine semantics: trigger (nt) → ครอบคลุม 2 แท่งแดงถัดไป (nt1) — reset เมื่อเจอแท่งเขียว
function computeNoTradePerBar(klines, opts = {}) {
  const length = opts.length != null ? opts.length : NO_TRADE_KC_LEN;
  const mult = opts.mult != null ? opts.mult : KC_MULT;
  const n = klines.length;
  const result = new Array(n).fill(null).map(() => ({ kind: 'none' }));
  if (n === 0) return result;

  const opens = klines.map((k) => parseFloat(k.open));
  const closes = klines.map((k) => parseFloat(k.close));
  const highs = klines.map((k) => parseFloat(k.high));
  const lows = klines.map((k) => parseFloat(k.low));

  // FIX-2026-08-05: Keltner Channel (kcLen=20, kcMult = opts.mult from bot.kcMult)
  const basisArr = ema(closes, length);
  const rangeArr = atr(highs, lows, closes, length);
  const upperKC = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    if (basisArr[i] == null || rangeArr[i] == null) continue;
    upperKC[i] = basisArr[i] + mult * rangeArr[i];
  }

  let redCountRemaining = 0;
  for (let i = 0; i < n; i += 1) {
    const engulf1 = isEngulf1BarAt(i, opens, closes, upperKC);
    const engulf2 = isEngulf2BarAt(i, opens, closes, upperKC);
    const shooting = isShootingStarAt(i, opens, closes, highs, lows, upperKC, opts);
    const rawNoTrade = engulf1 || engulf2 || shooting;
    if (rawNoTrade) {
      result[i] = { kind: 'nt', engulf1, engulf2, shooting };
      redCountRemaining = 2;
    } else if (redCountRemaining > 0 && opens[i] != null && closes[i] != null && closes[i] < opens[i]) {
      result[i] = { kind: 'nt1' };
      redCountRemaining -= 1;
    } else {
      result[i] = { kind: 'none' };
      redCountRemaining = 0;
    }
  }
  return result;
}

// checkNoTradeOnUpperTF — entry point (live trader + backtester)
//   - On S1 BUY signal: check upper-TF (TREND_TF_MAP) — แท่งล่าสุดมี nt/nt1 pattern หรือไม่
//   - PASS = lastKind === 'none' → BUY
//   - FAIL-OPEN on Binance error / insufficient data / no_trend_tf / warmup (mirror ST#1/ST#2)
//   - **Real-time**: Binance REST returns last candle with close = live price → check ทันที
//   - FIX-2026-08-09: opts.bypassOptIn=true → ข้าม safeTradeNoTradeEnabled check ใช้สำหรับ CBv3 panic-sell gate
//     (CBv3 ต้องการความ "มั่นใจว่าเป็นเหวจริง" เสมอ ไม่ควรขึ้นกับ opt-in flag ของ S1 BUY side)
async function checkNoTradeOnUpperTF(bot, trendTF, binanceRest, opts = {}) {
  const bypassOptIn = opts.bypassOptIn === true;
  if (!bypassOptIn && bot.safeTradeNoTradeEnabled !== true) {
    return { skip: false, pass: true, reason: 'disabled', trendTF: null };
  }
  if (!trendTF) {
    return { skip: false, pass: true, reason: 'no_trend_tf', trendTF: null };
  }
  try {
    const raw = await binanceRest.getKlines({ symbol: bot.symbol, interval: trendTF, limit: 30 });
    if (!Array.isArray(raw) || raw.length < 21) {
      return { skip: false, pass: true, reason: 'insufficient_data_open', trendTF };
    }
    // Binance raw tuple → object kline
    const klines = raw.map((k) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      closeTime: k[6],
    }));
    const mult = bot.kcMult != null ? parseFloat(bot.kcMult) : KC_MULT;
    const perBar = computeNoTradePerBar(klines, { mult });
    const lastIdx = klines.length - 1;
    const lastEntry = perBar[lastIdx] || { kind: 'none' };
    const lastKind = lastEntry.kind;
    const blocked = lastKind === 'nt' || lastKind === 'nt1';
    return {
      skip: blocked,
      pass: !blocked,
      reason: blocked ? 'blocked' : 'pass',
      trendTF,
      lastKind,
      lastOpenTime: klines[lastIdx].openTime,
      lastClose: klines[lastIdx].close,
      lastOpen: klines[lastIdx].open,
      lastHigh: klines[lastIdx].high,
      lastLow: klines[lastIdx].low,
      kcMult: mult,
    };
  } catch (err) {
    return { skip: false, pass: true, reason: 'api_error_open', error: err.message, trendTF };
  }
}

module.exports = {
  computeBgStates,
  isS1At,
  isXS1At,
  isCBAt,    // FIX-2026-07-30: CB panic-sell pattern (Pine sls12 = 3 consecutive red below lowerKC) — เดิมชื่อ isSLS1At
  isCBv2At,  // FIX-2026-08-06: CBv2 sustained 4-candle breach (Pine cbv2 = sls12 AND sls12[1]) — used by _checkCBv2PanicClose to lock bot cbv2LockHours hours
  detectS1Signals,
  checkS1OnLatestCandle,
  isWarmedUp,
  minimumCBv2Warmup, // FIX-2026-08-09: CBv2/CBv3 minimum candles (= KC_LEN + 3 = 23 for default)
  KC_LEN,
  KC_MULT,
  // FIX-2026-08-01: Safe-trade filter exports
  SAFE_TRADE_SUPER_TF_MAP,
  checkSafeTrade,
  // FIX-2026-08-03: Safe-trade filter #2 (trendline) exports
  computeTrendlinePivotLows,
  checkSafeTradeTrendline,
  // FIX-2026-08-05: Safe-trade filter #3 (no-trade engulfing/SS) exports
  NO_TRADE_KC_LEN,
  isEngulf1BarAt,
  isEngulf2BarAt,
  isShootingStarAt,
  computeNoTradePerBar,
  checkNoTradeOnUpperTF,
};