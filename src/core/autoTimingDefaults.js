'use strict';

/**
 * FIX-2026-08-30: Auto-Timing default band config.
 *
 * Each entry corresponds to a band in src/core/holdBands.js (by `bandId`).
 * The 10 knobs are applied per-band when the classifier picks that band.
 *
 * Defaults mirror the recommended starter mapping the user approved:
 *   🔵 ≤10 นาที     → Stimulate  (boost, no extra filter)
 *   � 10 นาที–1 ชม. → Encourage  (slight boost)
 *   🟡 1–12 ชม.     → Allow      (no override — bot uses its own config)
 *   🟠 12–48 �ม.    → Limit      (half notional + force ST1 + tighter TP)
 *   🔴 >2 วัน       → Suppress   (block entry)
 *
 * Each band object:
 *   bandId         — FK to HOLD_BANDS[i].id
 *   action         — 'allow' | 'limit' | 'encourage' | 'stimulate' | 'suppress'
 *   notionalMult   — multiplier on base notional (0 = suppress, 0.5 = half, 1.2 = +20%)
 *   tpTightenPct   — 0..50, % reduction in TP (e.g. 30 → TP × 0.7)
 *   slTightenPct   — 0..50, % reduction in SL threshold (less relevant for buys)
 *   forceST1       — require green candle before entry (boolean)
 *   forceST2       — require LuxAlgo red pivot low (boolean)
 *   forceST3       — require bearish-engulfing/shooting-star absence (boolean)
 *   forceCBv5      — enable CBv5 support-zone check on this slot (boolean)
 *   minKcMult      — multiplier on bot's autoPauseMinKcPct (0.5..2.0)
 *   maxConcurrent  — max positions opened from this cell concurrently (null = unlimited)
 *   maxTradesPerDay — max new entries from this cell per local-day (null = unlimited)
 */
const AUTO_TIMING_DEFAULT_BANDS = {
  lt10m: {
    bandId: 'lt10m', action: 'stimulate',
    notionalMult: 1.2, tpTightenPct: 0, slTightenPct: 0,
    forceST1: false, forceST2: false, forceST3: false, forceCBv5: false,
    minKcMult: 1.0, maxConcurrent: null, maxTradesPerDay: null,
  },
  lt1h: {
    bandId: 'lt1h', action: 'encourage',
    notionalMult: 1.1, tpTightenPct: 0, slTightenPct: 0,
    forceST1: false, forceST2: false, forceST3: false, forceCBv5: false,
    minKcMult: 1.0, maxConcurrent: null, maxTradesPerDay: null,
  },
  lt12h: {
    bandId: 'lt12h', action: 'allow',
    notionalMult: 1.0, tpTightenPct: 0, slTightenPct: 0,
    forceST1: false, forceST2: false, forceST3: false, forceCBv5: false,
    minKcMult: 1.0, maxConcurrent: null, maxTradesPerDay: null,
  },
  lt48h: {
    bandId: 'lt48h', action: 'limit',
    notionalMult: 0.5, tpTightenPct: 30, slTightenPct: 0,
    forceST1: true, forceST2: false, forceST3: false, forceCBv5: false,
    minKcMult: 1.0, maxConcurrent: 3, maxTradesPerDay: 5,
  },
  gt48h: {
    bandId: 'gt48h', action: 'suppress',
    notionalMult: 0, tpTightenPct: 0, slTightenPct: 0,
    forceST1: false, forceST2: false, forceST3: false, forceCBv5: false,
    minKcMult: 1.0, maxConcurrent: null, maxTradesPerDay: 0,
  },
};

const VALID_ACTIONS = ['allow', 'limit', 'encourage', 'stimulate', 'suppress'];

/**
 * Deep-clone the default bands so callers cannot mutate the canonical object.
 * Returns a fresh object whose band sub-objects are also fresh.
 */
function getDefaultBandsClone() {
  return JSON.parse(JSON.stringify(AUTO_TIMING_DEFAULT_BANDS));
}

/**
 * Validate a band override object against the schema. Returns {ok, errors, cleaned}.
 * Used by the PUT /api/auto-timing/config handler.
 */
function validateBandOverride(bandId, raw, errors = []) {
  const cleaned = {};
  if (!VALID_ACTIONS.includes(raw.action)) {
    errors.push(`bands.${bandId}.action must be one of ${VALID_ACTIONS.join('|')}`);
  } else {
    cleaned.action = raw.action;
  }
  if (raw.notionalMult !== undefined) {
    const v = Number(raw.notionalMult);
    if (!Number.isFinite(v) || v < 0 || v > 3) errors.push(`bands.${bandId}.notionalMult must be 0..3`);
    else cleaned.notionalMult = v;
  }
  if (raw.tpTightenPct !== undefined) {
    const v = Number(raw.tpTightenPct);
    if (!Number.isFinite(v) || v < 0 || v > 50) errors.push(`bands.${bandId}.tpTightenPct must be 0..50`);
    else cleaned.tpTightenPct = v;
  }
  if (raw.slTightenPct !== undefined) {
    const v = Number(raw.slTightenPct);
    if (!Number.isFinite(v) || v < 0 || v > 50) errors.push(`bands.${bandId}.slTightenPct must be 0..50`);
    else cleaned.slTightenPct = v;
  }
  for (const k of ['forceST1', 'forceST2', 'forceST3', 'forceCBv5']) {
    if (raw[k] !== undefined) cleaned[k] = !!raw[k];
  }
  if (raw.minKcMult !== undefined) {
    const v = Number(raw.minKcMult);
    if (!Number.isFinite(v) || v < 0.5 || v > 2.0) errors.push(`bands.${bandId}.minKcMult must be 0.5..2.0`);
    else cleaned.minKcMult = v;
  }
  if (raw.maxConcurrent !== undefined && raw.maxConcurrent !== null) {
    const v = Number(raw.maxConcurrent);
    if (!Number.isFinite(v) || v < 0 || v > 100) errors.push(`bands.${bandId}.maxConcurrent must be 0..100 or null`);
    else cleaned.maxConcurrent = v;
  }
  if (raw.maxTradesPerDay !== undefined && raw.maxTradesPerDay !== null) {
    const v = Number(raw.maxTradesPerDay);
    if (!Number.isFinite(v) || v < 0 || v > 100) errors.push(`bands.${bandId}.maxTradesPerDay must be 0..100 or null`);
    else cleaned.maxTradesPerDay = v;
  }
  return { cleaned, errors };
}

module.exports = {
  AUTO_TIMING_DEFAULT_BANDS,
  VALID_ACTIONS,
  getDefaultBandsClone,
  validateBandOverride,
};
