'use strict';

/**
 * FIX-2026-08-09: CBv2/CBv3 pattern evaluator — single source of truth for
 *   kline fetch + KC compute + isCBv2At + 4-candle fingerprint.
 * FIX-2026-08-10: CBv5 added — independent evaluator for Support Zone + Deepest Low +
 *   Volume Filter pattern (4-condition confirmation per Pine Script).
 *
 * Background (TUT incident 2026-08-09 17:18 BKK):
 *   - trader CBv3 used `klineCache.getAll()` (WS-fed, default 500 candles)
 *   - watchdog CBv3 used to fetch Binance REST with `limit=30` (removed in FIX-2026-08-09)
 *   - Same bot → different lastLower (0.145673 vs 0.14725) → different fire decision
 *   - TUT borderline pattern (green at i-3) fired CBv3 from the WS-cache path
 *     but would NOT have fired from the REST-30 path
 *
 *   Fix: ALL CBv2/CBv3 paths must use this evaluator with the same canonical
 *   window (REST limit=500) so EMA(20) seed is stable across all callers.
 *
 *   Layer 2 (defense-in-depth): 2-tick confirmation registry. Two independent
 *   invocations must observe the same closed candle with the same fingerprint
 *   before destructive action (force-close + cooldown) is allowed. Reduces
 *   false positive from single-tick spikes.
 *
 *   Pure helpers only — no DB / eventBus / telegram. Caller wires those up.
 *
 *   Backward compatibility:
 *     - signalEngine.isCBv2At() semantics unchanged (4 consecutive red below LK)
 *     - cooldown fields, force-close reasons, events unchanged
 *     - signature for callers: fetchAndEvaluateCBv2() returns a structured
 *       object so callers can decide what to do (fire / skip / log borderline)
 */

const KC_LENGTH = 20;
const MIN_PATTERN_CANDLES = 4;
// EMA(20) + ATR(20) need 20 warmup; isCBv2At(i) at lastIdx needs lower[i-3] valid → i-3 >= 19 → lastIdx >= 22 → array length >= 23
const MIN_EVALUATION_CANDLES = KC_LENGTH + MIN_PATTERN_CANDLES - 1; // 23
const CANONICAL_KLINE_LIMIT = 500;

// FIX-2026-08-09: Confirmation TTL — generous enough to span watchdog interval
// (default 180s) and trader kline:closed frequency. Beyond this, the registry
// forgets the pending confirmation → safer (forces re-confirm) rather than
// stale accept.
const DEFAULT_CONFIRMATION_TTL_MS = 10 * 60 * 1000; // 10 min
// FIX-2026-08-09: Number of independent evaluations required before fire
const REQUIRED_CONFIRMATIONS = 2;

// ─── Pure: normalize Binance tuple → object, dedupe, filter closed candles ──
function normalizeKlines(rawKlines, { nowMs = Date.now() } = {}) {
  if (!Array.isArray(rawKlines)) return [];
  const seen = new Set();
  const out = [];
  for (const k of rawKlines) {
    if (!Array.isArray(k) || k.length < 7) continue;
    const openTime = Number(k[0]);
    const open = parseFloat(k[1]);
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const close = parseFloat(k[4]);
    const closeTime = Number(k[6]);
    if (!Number.isFinite(openTime) || openTime <= 0) continue;
    if (!Number.isFinite(closeTime) || closeTime <= 0) continue;
    if (![open, high, low, close].every(Number.isFinite)) continue;
    // Skip open/in-progress candle (closeTime in the future = candle hasn't closed)
    if (closeTime > nowMs) continue;
    if (seen.has(openTime)) continue;
    seen.add(openTime);
    out.push({ openTime, open, high, low, close, closeTime });
  }
  out.sort((a, b) => a.openTime - b.openTime);
  return out;
}

// ─── Pure: build a deterministic fingerprint of the 4 pattern candles ──
// Used to verify re-fetched snapshot still matches previous evaluation
function buildFingerprint(klines, lastIdx) {
  if (!Array.isArray(klines) || lastIdx == null || lastIdx < 3) return null;
  const out = [];
  for (let k = lastIdx - 3; k <= lastIdx; k += 1) {
    const c = klines[k];
    if (!c) return null;
    out.push([c.openTime, c.closeTime, c.open, c.high, c.low, c.close]);
  }
  return JSON.stringify(out);
}

// ─── Pure: count consecutive red-and-below-LK candles ending at lastIdx ──
// Returns 0..4 — used for borderline detection (3 = isCB but not isCBv2)
function countConsecutiveBreach(klines, lastIdx, lower) {
  if (!Array.isArray(klines) || lastIdx == null || lastIdx < 0) return 0;
  let n = 0;
  for (let k = lastIdx; k >= Math.max(0, lastIdx - 3); k -= 1) {
    const c = klines[k];
    const lk = lower[k];
    if (c == null || lk == null) break;
    const isRed = c.open > c.close;
    const fullyBelow = c.close < lk && c.open < lk;
    if (isRed && fullyBelow) n += 1;
    else break;
  }
  return n;
}

// ─── Pure: EMA seed using SMA of first `period` values (Pine Script standard) ──
function _emaSeed(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  let sum = 0;
  for (let i = 0; i < period; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / period;
}

function _emaSeries(values, period) {
  if (!Array.isArray(values) || period <= 0) return [];
  const out = new Array(values.length).fill(null);
  const seed = _emaSeed(values, period);
  if (seed == null) return out;
  const k = 2 / (period + 1);
  out[period - 1] = seed;
  for (let i = period; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) { out[i] = null; continue; }
    const prev = out[i - 1];
    if (prev == null || !Number.isFinite(prev)) { out[i] = null; continue; }
    out[i] = v * k + prev * (1 - k);
  }
  return out;
}

function _smaSeries(values, period) {
  if (!Array.isArray(values) || period <= 0) return [];
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) { out[i] = null; continue; }
    sum += v;
    if (i >= period) {
      const old = values[i - period];
      if (Number.isFinite(old)) sum -= old;
    }
    if (i >= period - 1) out[i] = (i === period - 1) ? sum / period : out[i - 1]; // recompute below
  }
  // Recompute cleanly (the above branch has a subtle bug; do it straight)
  for (let i = 0; i < values.length; i += 1) {
    if (i < period - 1) { out[i] = null; continue; }
    let s = 0;
    let cnt = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const x = values[j];
      if (!Number.isFinite(x)) { s = null; break; }
      s += x;
      cnt += 1;
    }
    out[i] = (s != null && cnt === period) ? s / period : null;
  }
  return out;
}

// ─── Pure: ATR using true range, Wilder smoothing (matches TradingView `ta.atr`) ──
function _atrSeries(highs, lows, closes, period) {
  if (!Array.isArray(highs) || period <= 0) return [];
  const n = highs.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;
  const trs = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    const h = highs[i];
    const l = lows[i];
    const c = i > 0 ? closes[i - 1] : null;
    if (!Number.isFinite(h) || !Number.isFinite(l)) { trs[i] = null; continue; }
    if (c != null && Number.isFinite(c)) {
      trs[i] = Math.max(h - l, Math.abs(h - c), Math.abs(l - c));
    } else {
      trs[i] = h - l;
    }
  }
  // Wilder seed: SMA of first `period` TRs starting at i=1
  let sum = 0;
  for (let i = 1; i <= period; i += 1) {
    if (!Number.isFinite(trs[i])) { sum = null; break; }
    sum += trs[i];
  }
  if (sum == null) return out;
  out[period] = sum / period;
  for (let i = period + 1; i < n; i += 1) {
    const prev = out[i - 1];
    const cur = trs[i];
    if (prev == null || !Number.isFinite(prev) || !Number.isFinite(cur)) { out[i] = null; continue; }
    out[i] = (prev * (period - 1) + cur) / period;
  }
  return out;
}

// ─── Pure: find confirmed pivot lows (ta.pivotlow equivalent) ──
//   At index i, low[i] is a pivot low iff it is strictly less than every low
//   in [i-leftLen, i-1] AND every low in [i+1, i+rightLen].
//   For a pivot at i to be CONFIRMED on candle i+rightLen, we evaluate on
//   indices i ≤ lastIdx - rightLen (so the right side is fully visible).
function _findConfirmedPivotLows(klines, leftLen, rightLen, lastIdx) {
  if (!Array.isArray(klines) || leftLen < 1 || rightLen < 1) return [];
  const lastConfirmedIdx = lastIdx - rightLen;
  if (lastConfirmedIdx < leftLen) return [];
  const result = [];
  for (let i = leftLen; i <= lastConfirmedIdx; i += 1) {
    const pivot = klines[i];
    if (!pivot || !Number.isFinite(pivot.low)) continue;
    let isPivot = true;
    // Left side: i-leftLen .. i-1
    for (let j = i - leftLen; j < i; j += 1) {
      const c = klines[j];
      if (c && Number.isFinite(c.low) && c.low <= pivot.low) { isPivot = false; break; }
    }
    if (!isPivot) continue;
    // Right side: i+1 .. i+rightLen
    for (let j = i + 1; j <= i + rightLen; j += 1) {
      const c = klines[j];
      if (c && Number.isFinite(c.low) && c.low <= pivot.low) { isPivot = false; break; }
    }
    if (isPivot) result.push(pivot.low);
  }
  return result;
}

// ─── Pure: evaluate CBv5 snapshot (Support Zone + Deepest Low + Volume Filter) ──
//   Returns: { ok, matched, lastLower, deepestLow, isKCDown, isBelowDeepest,
//              isBearish, isHighVolume, fingerprint, lastIdx, candlesCount,
//              paramsUsed, reason? }
function evaluateCBv5Snapshot({ bot, klines, targetCloseTime, nowMs }) {
  // Defaults match Pine Script inputs
  const kcLen = (bot && bot.cbv5KcLen) || 20;
  const kcMult = (bot && bot.cbv5KcMult) || 1.2;
  const pivotLookback = (bot && bot.cbv5PivotLookback) || 3;
  const leftLen = (bot && bot.cbv5PivotLeftLen) || 5;
  const rightLen = (bot && bot.cbv5PivotRightLen) || 5;
  const strictBreak = bot && bot.cbv5StrictBreak === false ? false : true; // default true
  const useVolume = bot && bot.cbv5UseVolume === false ? false : true;     // default true
  const volMaLen = (bot && bot.cbv5VolMaLen) || 20;
  const volMultiplier = (bot && bot.cbv5VolMultiplier) || 1.5;
  const debounceCandles = (bot && bot.cbv5DebounceCandles) || 5;

  if (!Array.isArray(klines)) {
    return { ok: false, reason: 'no_klines', matched: false };
  }
  // Need at least: warmup (kcLen) + 1 (current) + rightLen (confirm pivot)
  const minCandles = Math.max(kcLen + 1, leftLen + rightLen + 1, volMaLen + 1);
  if (klines.length < minCandles) {
    return {
      ok: false,
      reason: 'warmup',
      matched: false,
      candlesCount: klines.length,
      minCandles,
    };
  }

  let lastIdx = klines.length - 1;
  if (targetCloseTime != null) {
    const found = klines.findIndex((c) => c.closeTime === targetCloseTime);
    if (found < 0) {
      return {
        ok: false,
        reason: 'target_candle_not_found',
        matched: false,
        targetCloseTime,
        candlesCount: klines.length,
      };
    }
    lastIdx = found;
  }

  const closes = klines.map((c) => c.close);
  const highs = klines.map((c) => c.high);
  const lows = klines.map((c) => c.low);
  const opens = klines.map((c) => c.open);
  const volumes = klines.map((c) => c.volume);

  // KC: basis = EMA(close, kcLen), range = ATR(high, low, close, kcLen)
  const basis = _emaSeries(closes, kcLen);
  const rng = _atrSeries(highs, lows, closes, kcLen);
  const lowerKC = basis.map((b, i) => (b != null && rng[i] != null) ? b - kcMult * rng[i] : null);
  const upperKC = basis.map((b, i) => (b != null && rng[i] != null) ? b + kcMult * rng[i] : null);

  const lastLower = lowerKC[lastIdx];
  if (typeof lastLower !== 'number' || !Number.isFinite(lastLower)) {
    return {
      ok: false,
      reason: 'last_lower_invalid',
      matched: false,
      lastIdx,
      candlesCount: klines.length,
    };
  }

  // Volume MA
  const volMA = _smaSeries(volumes, volMaLen);
  const curVol = volumes[lastIdx];
  const curVolMA = volMA[lastIdx];
  const isHighVolume = !useVolume
    ? true
    : (Number.isFinite(curVol) && Number.isFinite(curVolMA) && curVolMA > 0
       ? curVol > curVolMA * volMultiplier
       : false);

  // Pivot lows — confirmed at indices ≤ lastIdx - rightLen
  const pivots = _findConfirmedPivotLows(klines, leftLen, rightLen, lastIdx);
  let deepestLow = null;
  if (pivots.length > 0) {
    // Take last `pivotLookback` pivot lows, then min
    const tail = pivots.slice(-pivotLookback);
    deepestLow = tail.reduce((m, v) => (m == null || v < m) ? v : m, null);
  }

  if (!Number.isFinite(deepestLow)) {
    return {
      ok: false,
      reason: 'no_pivot_history',
      matched: false,
      lastIdx,
      lastLower,
      candlesCount: klines.length,
      pivotCount: pivots.length,
    };
  }

  // 4 conditions
  const curClose = closes[lastIdx];
  const curOpen = opens[lastIdx];
  const isKCDown = curClose < lastLower;
  const isBelowDeepest = curClose < deepestLow;
  const isBearish = curOpen > curClose; // close < open

  const cbConditionAt = (idx) => {
    if (idx < 0 || idx >= klines.length) return false;
    const lk = lowerKC[idx];
    if (!Number.isFinite(lk)) return false;
    const c = klines[idx];
    if (!c) return false;
    const kcDown = c.close < lk;
    if (!kcDown) return false;
    // deepestLow is computed at the evaluation point — for prior candles, recompute
    // using the same logic on the prefix up to idx (cheap: O(n) total per call site)
    const pivotsIdx = _findConfirmedPivotLows(klines, leftLen, rightLen, idx);
    if (pivotsIdx.length === 0) return false;
    const tail = pivotsIdx.slice(-pivotLookback);
    const d = tail.reduce((m, v) => (m == null || v < m) ? v : m, null);
    if (!Number.isFinite(d)) return false;
    const belowD = c.close < d;
    const bearish = strictBreak ? (c.open > c.close) : true;
    const highVol = !useVolume
      ? true
      : (Number.isFinite(c.volume) && Number.isFinite(volMA[idx]) && volMA[idx] > 0
         ? c.volume > volMA[idx] * volMultiplier
         : false);
    return belowD && bearish && highVol;
  };

  const cbCondition = cbConditionAt(lastIdx);

  // FIX-2026-08-11: Debounce + 2-tick confirmation coordination
  //   - Original: Back-loop 5 candles บล็อก back-to-back WS confirms (06:03 → 06:05)
  //   - Fix: ข้าม back-candles ที่มี pending v5 confirmation แล้ว (registry-driven)
  //   - เพื่อให้ confirmation tick 2 (06:05) ไม่โดน debounce บล็อก
  //   - fail-closed: ถ้า bot._id missing → fall back to current behavior (block via debounce)
  //   - bypassedDebounce เปิด telemetry ให้ caller เห็นว่า debounce ถูก bypass
  let recentlyTriggered = false;
  let bypassedDebounce = false;
  const botIdKey = bot && bot._id ? String(bot._id) : (bot && bot.id ? String(bot.id) : null);
  for (let back = 1; back <= debounceCandles; back += 1) {
    const backIdx = lastIdx - back;
    if (backIdx < 0) break;
    const backCandle = klines[backIdx];
    if (!backCandle) continue;
    // Skip if this back candle already has a pending v5 confirmation
    // (allows back-to-back WS confirmations: 06:03 → 06:05)
    if (botIdKey && getConfirmationCount({
      botId: botIdKey,
      version: 'v5',
      candleCloseTime: backCandle.closeTime,
    }) > 0) {
      bypassedDebounce = true;
      continue;
    }
    if (cbConditionAt(backIdx)) { recentlyTriggered = true; break; }
  }
  const matched = cbCondition && !recentlyTriggered;

  // Fingerprint: pin key snapshot fields so re-fetch can verify equality
  const fingerprint = JSON.stringify({
    v: 1, // schema version
    kcLen, kcMult, pivotLookback, leftLen, rightLen, strictBreak, useVolume, volMaLen, volMultiplier, debounceCandles,
    lastIdx,
    lastLower: round6(lastLower),
    deepestLow: round6(deepestLow),
    isKCDown, isBelowDeepest, isBearish, isHighVolume,
    cbCondition,
  });

  return {
    ok: true,
    matched,
    reason: matched ? 'pattern_matched' : (cbCondition ? 'debounce_active' : 'pattern_not_matched'),
    lastIdx,
    lastLower,
    deepestLow,
    isKCDown,
    isBelowDeepest,
    isBearish,
    isHighVolume,
    cbCondition,
    fingerprint,
    bypassedDebounce,
    candlesCount: klines.length,
    pivotCount: pivots.length,
    targetCloseTime: klines[lastIdx] ? klines[lastIdx].closeTime : null,
    source: 'evaluator',
    paramsUsed: { kcLen, kcMult, pivotLookback, leftLen, rightLen, strictBreak, useVolume, volMaLen, volMultiplier, debounceCandles },
  };
}

function round6(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e6) / 1e6;
}

// ─── Async: fetch + normalize + evaluate CBv5 via canonical REST window ───
async function fetchAndEvaluateCBv5({ bot, binanceRest, targetCloseTime = null, nowMs = Date.now() }) {
  const symbol = bot.symbol;
  const interval = bot.timeframe;
  let raw;
  try {
    raw = await binanceRest.getKlines({ symbol, interval, limit: CANONICAL_KLINE_LIMIT });
  } catch (err) {
    return {
      ok: false,
      reason: 'binance_fetch_error',
      matched: false,
      source: 'binance_rest',
      requestedLimit: CANONICAL_KLINE_LIMIT,
      error: err.message,
    };
  }
  const klines = normalizeKlines(raw, { nowMs });
  const evaluation = evaluateCBv5Snapshot({ bot, klines, targetCloseTime, nowMs });
  return {
    ...evaluation,
    source: evaluation.ok ? 'binance_rest' : evaluation.source || 'binance_rest',
    requestedLimit: CANONICAL_KLINE_LIMIT,
    rawCandlesCount: Array.isArray(raw) ? raw.length : 0,
  };
}

// ─── Pure: evaluate pattern on a normalized snapshot ──
// Returns structured object so callers can branch on `matched` / `consecutiveCount`
function evaluateCBv2Snapshot({ bot, klines, targetCloseTime, signalEngine }) {
  const engine = signalEngine;
  const kcMult = (bot && bot.kcMult) || 1.5;

  if (!Array.isArray(klines)) {
    return { ok: false, reason: 'no_klines', matched: false };
  }
  if (klines.length < MIN_EVALUATION_CANDLES) {
    return { ok: false, reason: 'warmup', matched: false, candlesCount: klines.length };
  }

  // Decide which idx to evaluate:
  // - If targetCloseTime is given, find exact candle (do NOT fallback to tail)
  // - Else use lastIdx
  let lastIdx = klines.length - 1;
  if (targetCloseTime != null) {
    const found = klines.findIndex((c) => c.closeTime === targetCloseTime);
    if (found < 0) {
      return {
        ok: false,
        reason: 'target_candle_not_found',
        matched: false,
        targetCloseTime,
        candlesCount: klines.length,
      };
    }
    lastIdx = found;
  }

  const opens = klines.map((c) => c.open);
  const closes = klines.map((c) => c.close);
  const highs = klines.map((c) => c.high);
  const lows = klines.map((c) => c.low);

  let lower;
  try {
    const states = engine.computeBgStates({
      closes, highs, lows, length: KC_LENGTH, mult: kcMult, useTrueRange: true,
    });
    lower = states.lower;
  } catch (err) {
    return {
      ok: false,
      reason: 'compute_bg_states_failed',
      matched: false,
      candlesCount: klines.length,
      error: err.message,
    };
  }

  const lastLower = lower[lastIdx];
  if (typeof lastLower !== 'number' || !Number.isFinite(lastLower)) {
    return {
      ok: false,
      reason: 'last_lower_invalid',
      matched: false,
      lastIdx,
      candlesCount: klines.length,
    };
  }

  const matched = engine.isCBv2At(lastIdx, opens, closes, lower);
  const consecutiveCount = countConsecutiveBreach(klines, lastIdx, lower);
  const fingerprint = buildFingerprint(klines, lastIdx);
  const targetCloseTimeResolved = klines[lastIdx] ? klines[lastIdx].closeTime : null;

  return {
    ok: true,
    matched,
    reason: matched ? 'pattern_matched' : 'pattern_not_matched',
    lastIdx,
    lastLower,
    consecutiveCount,
    fingerprint,
    targetCloseTime: targetCloseTimeResolved,
    candlesCount: klines.length,
    source: 'evaluator',
    isBorderline: !matched && consecutiveCount === 3,
  };
}

// ─── Async: fetch + normalize + evaluate via canonical REST window ──
async function fetchAndEvaluateCBv2({ bot, binanceRest, targetCloseTime = null, signalEngine, nowMs = Date.now() }) {
  const symbol = bot.symbol;
  const interval = bot.timeframe;
  let raw;
  try {
    raw = await binanceRest.getKlines({ symbol, interval, limit: CANONICAL_KLINE_LIMIT });
  } catch (err) {
    return {
      ok: false,
      reason: 'binance_fetch_error',
      matched: false,
      source: 'binance_rest',
      requestedLimit: CANONICAL_KLINE_LIMIT,
      error: err.message,
    };
  }

  const klines = normalizeKlines(raw, { nowMs });
  const evaluation = evaluateCBv2Snapshot({ bot, klines, targetCloseTime, signalEngine });
  // Attach canonical-window metadata for observability + grep
  return {
    ...evaluation,
    source: evaluation.ok ? 'binance_rest' : evaluation.source || 'binance_rest',
    requestedLimit: CANONICAL_KLINE_LIMIT,
    rawCandlesCount: Array.isArray(raw) ? raw.length : 0,
  };
}

// ─── Shared confirmation registry (in-memory, fail-safe on restart) ──
// Key: botId:version:candleCloseTime
// Stores: count, firstSeenAt, lastSeenAt, fingerprint, candleFingerprint
//
// On pm2 restart, registry is empty → first evaluation creates entry with
// count=1 → caller must wait for the SECOND evaluation (next tick or watchdog)
// before fire. This is intentional fail-safe: a restart costs at most one
// timeframe of delay (3m for 3m TF) in exchange for a strong false-positive
// reduction.
const _confirmationRegistry = new Map();

function _key(botId, version, candleCloseTime) {
  // FIX-2026-08-10: CBv5 added — registry key version space is {v2, v3, v5}
  const v = (version === 'v3' || version === 'v5') ? version : 'v2';
  return `${botId}:${v}:${candleCloseTime}`;
}

function _nowMs() { return Date.now(); }

function recordConfirmation({ botId, version, candleCloseTime, fingerprint, ttlMs = DEFAULT_CONFIRMATION_TTL_MS }) {
  if (botId == null || candleCloseTime == null) return { count: 0 };
  const k = _key(String(botId), version, candleCloseTime);
  const now = _nowMs();
  const existing = _confirmationRegistry.get(k);
  if (existing && existing.expiresAt > now && existing.fingerprint === fingerprint) {
    existing.count += 1;
    existing.lastSeenAt = now;
    return { count: existing.count, firstSeenAt: existing.firstSeenAt, lastSeenAt: now };
  }
  // Fresh entry (or mismatch / expired → reset)
  const entry = {
    count: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    fingerprint,
    expiresAt: now + ttlMs,
  };
  _confirmationRegistry.set(k, entry);
  return { count: 1, firstSeenAt: now, lastSeenAt: now };
}

function getConfirmationCount({ botId, version, candleCloseTime }) {
  if (botId == null || candleCloseTime == null) return 0;
  const k = _key(String(botId), version, candleCloseTime);
  const existing = _confirmationRegistry.get(k);
  if (!existing) return 0;
  if (existing.expiresAt <= _nowMs()) {
    _confirmationRegistry.delete(k);
    return 0;
  }
  return existing.count;
}

function consumeConfirmation({ botId, version, candleCloseTime }) {
  if (botId == null || candleCloseTime == null) return;
  const k = _key(String(botId), version, candleCloseTime);
  _confirmationRegistry.delete(k);
}

// Test-only: reset registry between tests
function _resetConfirmationRegistry() {
  _confirmationRegistry.clear();
}

// Periodic GC: drop expired entries to keep registry small
function _gcExpired() {
  const now = _nowMs();
  for (const [k, v] of _confirmationRegistry.entries()) {
    if (v.expiresAt <= now) _confirmationRegistry.delete(k);
  }
}
const _gcInterval = setInterval(_gcExpired, 60 * 1000);
if (typeof _gcInterval.unref === 'function') _gcInterval.unref();

module.exports = {
  // Constants
  CANONICAL_KLINE_LIMIT,
  KC_LENGTH,
  MIN_EVALUATION_CANDLES,
  MIN_PATTERN_CANDLES,
  REQUIRED_CONFIRMATIONS,
  // Pure evaluators
  normalizeKlines,
  buildFingerprint,
  countConsecutiveBreach,
  evaluateCBv2Snapshot,
  evaluateCBv5Snapshot,
  // Async fetch + evaluate
  fetchAndEvaluateCBv2,
  fetchAndEvaluateCBv5,
  // Confirmation registry
  recordConfirmation,
  getConfirmationCount,
  consumeConfirmation,
  // Test-only
  _resetConfirmationRegistry,
};
