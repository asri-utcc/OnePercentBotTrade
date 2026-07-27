// Patch signalEngine.js — เพิ่ม XS1 anti-dump gate
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, '..', 'src/core/signalEngine.js');
let src = fs.readFileSync(filePath, 'utf8');

// 1. Update header doc comment — เพิ่ม XS1 section
const headerOld = " *   S1 = bg_prev == 2 AND (bg_state == 3 OR bg_state == 1)\r\n */";
const headerNew =
  " *   S1 = bg_prev == 2 AND (bg_state == 3 OR bg_state == 1)\r\n" +
  " *\r\n" +
  " * FIX-2026-07-25: XS1 anti-dump gate (hard rule, applies to all bots)\r\n" +
  " *   ป้องกันการซื้อขณะราคาไหลเร็วเกินไป (candle-wide dump)\r\n" +
  " *   XS1 = (close < lowerKC AND open > basisKC)\r\n" +
  " *      OR (open[1] > basisKC[1] AND close[1] < basisKC[1]\r\n" +
  " *          AND close < lowerKC AND open < basisKC)\r\n" +
  " *   ถ้า XS1 = true → ไม่นับเป็น S1 signal (skip buy)\r\n" +
  " */";
if (!src.includes(headerOld)) throw new Error('headerOld not found');
src = src.replace(headerOld, headerNew);

// 2. Update isS1At comment + accept opts.allowDump (default false)
const isS1Old = "// ตรวจ S1 ที่ดัชนี i (ต้องมี bg[i-1])\r\n" +
  "// FIX-2026-07-24: opts.onlyDown\r\n" +
  "//   - false (default, backward-compat): S1 = bg_prev=2 AND (bg=1 OR bg=3)\r\n" +
  "//   - true: S1 = bg_prev=2 AND bg=3 เท่านั้น (ลง — ไม่ซื้อตอนราคาสูง)\r\n" +
  "function isS1At(bg, i, opts = {}) {\r\n" +
  "  if (i <= 0) return false;\r\n" +
  "  if (bg[i] === null || bg[i - 1] === null) return false;\r\n" +
  "  if (bg[i - 1] !== 2) return false;\r\n" +
  "  if (opts.onlyDown) return bg[i] === 3;\r\n" +
  "  return bg[i] === 1 || bg[i] === 3;\r\n" +
  "}";
const isS1New =
  "// ตรวจ S1 ที่ดัชนี i (ต้องมี bg[i-1])\r\n" +
  "// FIX-2026-07-24: opts.onlyDown\r\n" +
  "//   - false (default, backward-compat): S1 = bg_prev=2 AND (bg=1 OR bg=3)\r\n" +
  "//   - true: S1 = bg_prev=2 AND bg=3 เท่านั้น (ลง — ไม่ซื้อตอนราคาสูง)\r\n" +
  "// FIX-2026-07-25: XS1 anti-dump (always applied)\r\n" +
  "//   - ถ้า candle-wide dump → skip signal (กันราคาไหลเร็ว)\r\n" +
  "//   - ดู isXS1At() ด้านล่างสำหรับ pattern เต็ม\r\n" +
  "function isS1At(bg, i, opts = {}) {\r\n" +
  "  if (i <= 0) return false;\r\n" +
  "  if (bg[i] === null || bg[i - 1] === null) return false;\r\n" +
  "  if (bg[i - 1] !== 2) return false;\r\n" +
  "  if (opts.onlyDown) {\r\n" +
  "    if (bg[i] !== 3) return false;\r\n" +
  "  } else {\r\n" +
  "    if (bg[i] !== 1 && bg[i] !== 3) return false;\r\n" +
  "  }\r\n" +
  "  return true;\r\n" +
  "}";
if (!src.includes(isS1Old)) throw new Error('isS1At block not found');
src = src.replace(isS1Old, isS1New);

// 3. Insert isXS1At() function after isS1At
const insertAfterOld = "function isS1At(bg, i, opts = {}) {";
const idx = src.indexOf(insertAfterOld);
if (idx < 0) throw new Error('isS1At anchor not found');

// find end of isS1At function (next blank line then '/**' or other func)
const funcEndMarker = src.indexOf('\r\n/**', idx);
if (funcEndMarker < 0) throw new Error('isS1At end marker not found');

const xs1Func =
  "\r\n" +
  "// FIX-2026-07-25: XS1 anti-dump gate (hard rule)\r\n" +
  "//   ตรวจว่า candle มี pattern \"ไหลเร็วเกินไป\" หรือไม่ — ถ้าใช่ → skip S1\r\n" +
  "//\r\n" +
  "//   XS1 = (close < lowerKC AND open > basisKC)\r\n" +
  "//      OR (open[1] > basisKC[1] AND close[1] < basisKC[1]\r\n" +
  "//          AND close < lowerKC AND open < basisKC)\r\n" +
  "//\r\n" +
  "//   index [1] = previous candle (i-1)\r\n" +
  "//\r\n" +
  "//   Inputs:\r\n" +
  "//     i         - index ของ current candle\r\n" +
  "//     opens     - array ของ open prices (ทุก kline)\r\n" +
  "//     closes    - array ของ close prices\r\n" +
  "//     basis     - array ของ basisKC (จาก computeBgStates)\r\n" +
  "//     lower     - array ของ lowerKC (จาก computeBgStates)\r\n" +
  "//\r\n" +
  "//   Returns: true ถ้า candle มี dump pattern (ให้ caller skip signal)\r\n" +
  "function isXS1At(i, opens, closes, basis, lower) {\r\n" +
  "  if (i <= 0) return false;\r\n" +
  "  if (opens[i] == null || closes[i] == null || basis[i] == null || lower[i] == null) return false;\r\n" +
  "  if (opens[i - 1] == null || closes[i - 1] == null || basis[i - 1] == null || lower[i - 1] == null) return false;\r\n" +
  "  // Pattern A: current candle alone dumps hard\r\n" +
  "  //   close < lowerKC AND open > basisKC\r\n" +
  "  //   → opened above basis, closed below lower (full-channel crash)\r\n" +
  "  const patternA = closes[i] < lower[i] && opens[i] > basis[i];\r\n" +
  "  // Pattern B: previous candle started above basis, then 2 consecutive dumps\r\n" +
  "  //   open[1] > basisKC[1] AND close[1] < basisKC[1]\r\n" +
  "  //   AND close < lowerKC AND open < basisKC\r\n" +
  "  const patternB = opens[i - 1] > basis[i - 1]\r\n" +
  "    && closes[i - 1] < basis[i - 1]\r\n" +
  "    && closes[i] < lower[i]\r\n" +
  "    && opens[i] < basis[i];\r\n" +
  "  return patternA || patternB;\r\n" +
  "}\r\n";

src = src.slice(0, funcEndMarker) + xs1Func + src.slice(funcEndMarker);

// 4. detectS1Signals — pass opens array + check XS1
const detectOld =
  "function detectS1Signals(klines, opts = {}) {\r\n" +
  "  const closes = klines.map((k) => parseFloat(k.close));\r\n" +
  "  const highs = klines.map((k) => parseFloat(k.high));\r\n" +
  "  const lows = klines.map((k) => parseFloat(k.low));\r\n" +
  "\r\n" +
  "  const { basis, upper, lower, bg } = computeBgStates({ closes, highs, lows, ...opts });\r\n" +
  "\r\n" +
  "  const signals = [];\r\n" +
  "  for (let i = 0; i < klines.length; i += 1) {\r\n" +
  "    if (isS1At(bg, i, opts)) {\r\n" +
  "      signals.push({\r\n" +
  "        index: i,\r\n" +
  "        openTime: klines[i].openTime,\r\n" +
  "        closeTime: klines[i].closeTime,\r\n" +
  "        type: 'S1',\r\n" +
  "        close: closes[i],\r\n" +
  "        basisKC: basis[i],\r\n" +
  "        upperKC: upper[i],\r\n" +
  "        lowerKC: lower[i],\r\n" +
  "        bgState: bg[i],\r\n" +
  "        bgPrev: bg[i - 1],\r\n" +
  "      });\r\n" +
  "    }\r\n" +
  "  }\r\n" +
  "\r\n" +
  "  return { signals, basis, upper, lower, bg };\r\n" +
  "}";
const detectNew =
  "function detectS1Signals(klines, opts = {}) {\r\n" +
  "  const closes = klines.map((k) => parseFloat(k.close));\r\n" +
  "  const highs = klines.map((k) => parseFloat(k.high));\r\n" +
  "  const lows = klines.map((k) => parseFloat(k.low));\r\n" +
  "  // FIX-2026-07-25: opens needed for XS1 anti-dump pattern A/B\r\n" +
  "  const opens = klines.map((k) => parseFloat(k.open));\r\n" +
  "\r\n" +
  "  const { basis, upper, lower, bg } = computeBgStates({ closes, highs, lows, ...opts });\r\n" +
  "\r\n" +
  "  const signals = [];\r\n" +
  "  for (let i = 0; i < klines.length; i += 1) {\r\n" +
  "    if (!isS1At(bg, i, opts)) continue;\r\n" +
  "    // FIX-2026-07-25: XS1 anti-dump gate (hard rule)\r\n" +
  "    if (isXS1At(i, opens, closes, basis, lower)) continue;\r\n" +
  "    signals.push({\r\n" +
  "      index: i,\r\n" +
  "      openTime: klines[i].openTime,\r\n" +
  "      closeTime: klines[i].closeTime,\r\n" +
  "      type: 'S1',\r\n" +
  "      close: closes[i],\r\n" +
  "      basisKC: basis[i],\r\n" +
  "      upperKC: upper[i],\r\n" +
  "      lowerKC: lower[i],\r\n" +
  "      bgState: bg[i],\r\n" +
  "      bgPrev: bg[i - 1],\r\n" +
  "    });\r\n" +
  "  }\r\n" +
  "\r\n" +
  "  return { signals, basis, upper, lower, bg };\r\n" +
  "}";
if (!src.includes(detectOld)) throw new Error('detectS1Signals block not found');
src = src.replace(detectOld, detectNew);

// 5. checkS1OnLatestCandle — needs to return XS1 reason? ขอเปลี่ยน shape ให้คืน XS1 flag
const checkOld =
  "// ตรวจ S1 บนแท่งล่าสุดเท่านั้น (สำหรับ live trading — ต้องมี previous candle)\r\n" +
  "function checkS1OnLatestCandle(klines, opts = {}) {\r\n" +
  "  if (!klines || klines.length < 2) return null;\r\n" +
  "  const { signals, bg } = detectS1Signals(klines, opts);\r\n" +
  "  const i = klines.length - 1;\r\n" +
  "  if (!isS1At(bg, i, opts)) return null;\r\n" +
  "  const s = signals[signals.length - 1];\r\n" +
  "  return s;\r\n" +
  "}";
const checkNew =
  "// ตรวจ S1 บนแท่งล่าสุดเท่านั้น (สำหรับ live trading — ต้องมี previous candle)\r\n" +
  "// FIX-2026-07-25: คืน object { signal, xs1 } — xs1=true ถ้า candle มี dump pattern\r\n" +
  "//   - signal=null && xs1=true  → S1 base match แต่ skip เพราะ candle-wide dump\r\n" +
  "//   - signal=null && xs1=false → ไม่ใช่ S1 base match\r\n" +
  "//   - signal=object && xs1=false → valid S1 signal\r\n" +
  "//   - signal=object && xs1=true  → เป็นไปไม่ได้ (filter ที่ detectS1Signals แล้ว)\r\n" +
  "function checkS1OnLatestCandle(klines, opts = {}) {\r\n" +
  "  if (!klines || klines.length < 2) return { signal: null, xs1: false };\r\n" +
  "  const { signals, bg } = detectS1Signals(klines, opts);\r\n" +
  "  const i = klines.length - 1;\r\n" +
  "  const baseS1 = isS1At(bg, i, opts);\r\n" +
  "  if (!baseS1) return { signal: null, xs1: false };\r\n" +
  "  // ตรวจ XS1 เพิ่มเติม (สำหรับ diagnostic — caller รู้ว่าถูก skip เพราะอะไร)\r\n" +
  "  const opens = klines.map((k) => parseFloat(k.open));\r\n" +
  "  const closes = klines.map((k) => parseFloat(k.close));\r\n" +
  "  const { basis, lower } = computeBgStates({\r\n" +
  "    closes,\r\n" +
  "    highs: klines.map((k) => parseFloat(k.high)),\r\n" +
  "    lows: klines.map((k) => parseFloat(k.low)),\r\n" +
  "    ...opts,\r\n" +
  "  });\r\n" +
  "  const xs1 = isXS1At(i, opens, closes, basis, lower);\r\n" +
  "  if (xs1) return { signal: null, xs1: true };\r\n" +
  "  const s = signals[signals.length - 1];\r\n" +
  "  return { signal: s, xs1: false };\r\n" +
  "}";
if (!src.includes(checkOld)) throw new Error('checkS1OnLatestCandle block not found');
src = src.replace(checkOld, checkNew);

// 6. Export isXS1At
const exportOld = "module.exports = {\r\n" +
  "  computeBgStates,\r\n" +
  "  isS1At,\r\n" +
  "  detectS1Signals,\r\n" +
  "  checkS1OnLatestCandle,\r\n" +
  "  isWarmedUp,\r\n" +
  "  KC_LEN,\r\n" +
  "  KC_MULT,\r\n" +
  "};";
const exportNew = "module.exports = {\r\n" +
  "  computeBgStates,\r\n" +
  "  isS1At,\r\n" +
  "  isXS1At,\r\n" +
  "  detectS1Signals,\r\n" +
  "  checkS1OnLatestCandle,\r\n" +
  "  isWarmedUp,\r\n" +
  "  KC_LEN,\r\n" +
  "  KC_MULT,\r\n" +
  "};";
if (!src.includes(exportOld)) throw new Error('exports block not found');
src = src.replace(exportOld, exportNew);

fs.writeFileSync(filePath, src);
console.log('Patched OK');