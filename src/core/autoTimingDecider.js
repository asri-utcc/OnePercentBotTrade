'use strict';

/**
 * FIX-2026-08-30 / Phase 4: Auto-Timing decider — pure function, TDD-friendly.
 *
 * Translates a classifier result + per-bot counters + clamp config into the
 * concrete knobs the trader.js BUY pipeline applies. Does NOT touch Mongo.
 *
 * Inputs:
 *   result           - classifier output:
 *                       { action, band: {10 knobs}, bandId, confidence, blocked, reason }
 *   bot              - { capitalPerTrade, autoTimingOverrideCell }
 *   bucket           - { day: 0..6, hour: 0..23 }
 *   clamp            - { minFloorUSDT, maxCeilingUSDT } — from AppConfig
 *   state            - { openFromCell: number, tradesFromCellToday: number }
 *
 * Output:
 *   {
 *     effectiveAction:  'suppress'|'limit'|'allow'|'encourage'|'stimulate'|'override',
 *     notionalMult:     0..3,                       // final multiplier after override
 *     notionalUSDT:     number,                     // capitalPerTrade × notionalMult (pre-clamp)
 *     notionalFinal:    number,                     // after clamp
 *     notionalClamped:  'skipped_low'|'capped_high'|'in_range',
 *     forceST1:         boolean,
 *     forceST2:         boolean,
 *     forceST3:         boolean,
 *     forceCBv5:        boolean,
 *     tpTightenPct:     0..50,
 *     slTightenPct:     0..50,
 *     minKcMult:        0.5..2.0,
 *     maxConcurrent:    number|null,
 *     maxTradesPerDay:  number|null,
 *     blocked:          boolean,                    // caller MUST skip BUY
 *     skipReason:       'suppress'|'floor'|'max_concurrent'|'max_trades_day'|null,
 *     overrideApplied:  'suppress'|'limit'|'allow'|'encourage'|'stimulate'|null,
 *     bandId:           string,
 *     confidence:       'enforce'|'show'|'no_data',
 *     reason:           string,
 *     source:           'classifier'|'override',
 *   }
 *
 * Decision order:
 *   1. Per-bot override (autoTimingOverrideCell["d:h"]) wins over classifier
 *   2. Suppress → blocked, skipReason='suppress'
 *   3. Compute notional = capitalPerTrade × notionalMult; apply clamp
 *   4. Check maxConcurrent, maxTradesPerDay against state counters
 */
function decide(result, bot, bucket, clamp, state) {
  const safeResult = result || {};
  const safeBot = bot || {};
  const safeBucket = bucket || { day: 0, hour: 0 };
  const safeClamp = clamp || {};
  const safeState = state || { openFromCell: 0, tradesFromCellToday: 0 };

  const capitalPerTrade = Math.max(0, Number(safeBot.capitalPerTrade) || 0);
  const minFloor = Math.max(1, Number(safeClamp.minFloorUSDT) || 1);
  const maxCeiling = Math.max(minFloor, Number(safeClamp.maxCeilingUSDT) || 200);
  const confidence = safeResult.confidence || 'no_data';

  // Step 1: per-bot override
  const overrideKey = `${safeBucket.day}:${safeBucket.hour}`;
  const overrides = safeBot.autoTimingOverrideCell || {};
  const overrideApplied = (overrides && typeof overrides === 'object' && overrides[overrideKey])
    ? String(overrides[overrideKey])
    : null;

  let source = 'classifier';
  let action = safeResult.action || 'allow';
  let band = safeResult.band || defaultBand(safeResult.bandId);

  // FIX-2026-08-30: clean the multiplier ONCE up front.
  //   - NaN/undefined/null → 1 (safe default)
  //   - 0 (explicit block) → 0 (triggers suppress path below)
  //   - negative → clamped to 0 by clampMult
  // We use Number.isFinite() instead of `|| 1` to avoid masking legitimate 0s.
  const _rawMult = Number(band.notionalMult);
  let effMult = clampMult(Number.isFinite(_rawMult) ? _rawMult : 1);

  if (overrideApplied && isValidAction(overrideApplied)) {
    action = overrideApplied;
    source = 'override';
    // Apply a sane default multiplier for the override action
    const overrideMult = action === 'suppress' ? 0
                       : action === 'limit' ? 0.5
                       : action === 'allow' ? 1
                       : action === 'encourage' ? 1.1
                       : action === 'stimulate' ? 1.2
                       : 1;
    band = Object.assign({}, band, { action, notionalMult: overrideMult });
    effMult = overrideMult;
  }

  // Step 2: suppress (action override OR explicit zero multiplier — NOT NaN)
  if (action === 'suppress' || effMult === 0) {
    return finalize({
      source,
      effectiveAction: 'suppress',
      action,
      band,
      confidence,
      notionalMult: 0,
      notionalUSDT: 0,
      notionalFinal: 0,
      notionalClamped: 'skipped_low',
      forceST1: !!band.forceST1,
      forceST2: !!band.forceST2,
      forceST3: !!band.forceST3,
      forceCBv5: !!band.forceCBv5,
      tpTightenPct: clampPct(band.tpTightenPct),
      slTightenPct: clampPct(band.slTightenPct),
      minKcMult: clampKcMult(band.minKcMult),
      maxConcurrent: band.maxConcurrent != null ? Number(band.maxConcurrent) : null,
      maxTradesPerDay: band.maxTradesPerDay != null ? Number(band.maxTradesPerDay) : null,
      blocked: true,
      skipReason: 'suppress',
      overrideApplied,
      bandId: safeResult.bandId || 'gt48h',
      reason: safeResult.reason || 'suppress',
    });
  }

  // Step 3: notional × multiplier + clamp (effMult already cleaned above)
  let notionalMult = effMult;
  let notionalUSDT = capitalPerTrade * notionalMult;
  let notionalFinal = notionalUSDT;
  let notionalClamped = 'in_range';
  let blocked = false;
  let skipReason = null;

  // Skip clamp entirely if there's no capital configured (degenerate input);
  // the trader.js pipeline will surface a "no capital" error separately.
  if (capitalPerTrade > 0 && notionalFinal < minFloor) {
    // Floor policy: Skip below floor (per 2026-08-29 design choice A)
    notionalFinal = 0;
    notionalClamped = 'skipped_low';
    blocked = true;
    skipReason = 'floor';
  } else if (capitalPerTrade > 0 && notionalFinal > maxCeiling) {
    // Ceiling policy: Cap above ceiling
    notionalFinal = maxCeiling;
    notionalClamped = 'capped_high';
    // not blocked — just capped
  }

  // Step 4: concurrency + per-day caps
  const maxC = band.maxConcurrent != null ? Math.max(0, Number(band.maxConcurrent)) : null;
  const maxD = band.maxTradesPerDay != null ? Math.max(0, Number(band.maxTradesPerDay)) : null;
  if (!blocked && maxC !== null && safeState.openFromCell >= maxC) {
    blocked = true;
    skipReason = 'max_concurrent';
  }
  if (!blocked && maxD !== null && safeState.tradesFromCellToday >= maxD) {
    blocked = true;
    skipReason = 'max_trades_day';
  }

  return finalize({
    source,
    effectiveAction: action,
    action,
    band,
    confidence,
    notionalMult,
    notionalUSDT,
    notionalFinal,
    notionalClamped,
    forceST1: !!band.forceST1,
    forceST2: !!band.forceST2,
    forceST3: !!band.forceST3,
    forceCBv5: !!band.forceCBv5,
    tpTightenPct: clampPct(band.tpTightenPct),
    slTightenPct: clampPct(band.slTightenPct),
    minKcMult: clampKcMult(band.minKcMult),
    maxConcurrent: maxC,
    maxTradesPerDay: maxD,
    blocked,
    skipReason,
    overrideApplied,
    bandId: safeResult.bandId || 'lt10m',
    reason: safeResult.reason || `${action} band`,
  });
}

function finalize(p) {
  return {
    effectiveAction: p.effectiveAction,
    action: p.action,
    band: p.band,
    confidence: p.confidence,
    notionalMult: p.notionalMult,
    notionalUSDT: round4(p.notionalUSDT),
    notionalFinal: round4(p.notionalFinal),
    notionalClamped: p.notionalClamped,
    forceST1: p.forceST1,
    forceST2: p.forceST2,
    forceST3: p.forceST3,
    forceCBv5: p.forceCBv5,
    tpTightenPct: p.tpTightenPct,
    slTightenPct: p.slTightenPct,
    minKcMult: p.minKcMult,
    maxConcurrent: p.maxConcurrent,
    maxTradesPerDay: p.maxTradesPerDay,
    blocked: p.blocked,
    skipReason: p.skipReason,
    overrideApplied: p.overrideApplied,
    bandId: p.bandId,
    reason: p.reason,
    source: p.source,
  };
}

function defaultBand(bandId) {
  return {
    bandId: bandId || 'lt10m',
    action: 'allow',
    notionalMult: 1,
    tpTightenPct: 0,
    slTightenPct: 0,
    forceST1: false, forceST2: false, forceST3: false, forceCBv5: false,
    minKcMult: 1,
    maxConcurrent: null,
    maxTradesPerDay: null,
  };
}

const VALID_ACTIONS_SET = new Set(['allow', 'limit', 'encourage', 'stimulate', 'suppress']);
function isValidAction(a) { return VALID_ACTIONS_SET.has(String(a)); }

function clampMult(v) {
  if (!Number.isFinite(v)) return 1;
  if (v < 0) return 0;
  if (v > 3) return 3;
  return v;
}
function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 50) return 50;
  return n;
}
function clampKcMult(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  if (n < 0.5) return 0.5;
  if (n > 2) return 2;
  return n;
}
function round4(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

module.exports = { decide, isValidAction };
