'use strict';

/**
 * FIX-2026-08-30 / Phase 4: Auto-Timing classifier — pure function, TDD-friendly.
 *
 * Inputs:
 *   cell         - { bucket: {day:0..6, hour:0..23}, n (weighted trade count),
 *                    winRate (0..1), pnlUSDT, medianHoldMin, holds[] }
 *   tier2State   - null OR { everBadCount, firstBadAt, lastBadAt,
 *                            suppressUntil, lifetimeN, lifetimeWinRate }
 *   config       - master config:
 *                    { bands: { lt10m: { ...10 knobs }, ... },
 *                      minTradesShow (default 3),
 *                      minTradesEnforce (default 10),
 *                      suppressCooldownDays (default 90),
 *                      suppressThresholdEverBad (default 10) }
 *   now          - timestamp (default Date.now()) for cool-down comparison
 *
 * Output:
 *   {
 *     action: 'suppress'|'limit'|'allow'|'encourage'|'stimulate',
 *     bandId: 'lt10m'|'lt1h'|'lt12h'|'lt48h'|'gt48h',
 *     band:   { ...10 knobs },          // band config snapshot
 *     reason: string,                   // human-readable
 *     blocked: boolean,                 // true ⇒ caller MUST skip BUY
 *     confidence: 'enforce'|'show'|'no_data',
 *     tier2Hit: 'cool_down'|'ever_bad'|'fresh',
 *     metrics: { n, winRate, pnlUSDT, medianHoldMin },
 *     asOf: timestamp,
 *   }
 *
 * Decision order (priority high→low):
 *   1. Cool-down active → 'suppress' (tier2Hit='cool_down')
 *   2. n < minTradesShow → 'allow' (tier2Hit='fresh', confidence='no_data')
 *   3. recent bad AND tier2 everBadCount ≥ suppressThresholdEverBad → 'suppress'
 *      (tier2Hit='ever_bad') — promotes cell into Tier 2 persistence
 *   4. n ≥ minTradesEnforce → band.action (confidence='enforce')
 *   5. n in [minTradesShow, minTradesEnforce) → band.action (confidence='show',
 *      advisory only — caller may still apply but logs/advisory UI marks it)
 */
const { holdBandOf } = require('./holdBands');

const ACTION_TO_BLOCKED = {
  suppress: true,
  limit: false,
  allow: false,
  encourage: false,
  stimulate: false,
};

// FIX-2026-08-30: threshold for declaring a slot "bad".
//   - bad pnlPerTrade < -0.05 USDT/trade (≈ −5¢ per trade)
//   - bad winRate < 40% (only when enough data)
const BAD_PNL_PER_TRADE = -0.05;
const BAD_WIN_RATE = 0.4;

function classify(cell, tier2State, config, now = Date.now()) {
  const safeConfig = config || {};
  const bands = safeConfig.bands || {};
  const minShow = positiveOrDefault(safeConfig.minTradesShow, 3);
  const minEnforce = positiveOrDefault(safeConfig.minTradesEnforce, 10);
  const suppressThreshold = positiveOrDefault(safeConfig.suppressThresholdEverBad, 10);

  const n = Math.max(0, Number(cell && cell.n) || 0);
  const winRate = clamp01(Number(cell && cell.winRate) || 0);
  const pnlUSDT = Number(cell && cell.pnlUSDT) || 0;
  const medianHoldMin = Number(cell && cell.medianHoldMin) || 0;
  const metrics = { n, winRate, pnlUSDT, medianHoldMin };

  const band = holdBandOf(medianHoldMin);
  const bandConfig = bands[band.id] || defaultBandConfig(band.id);

  // 1) Cool-down override (sticky bad)
  if (tier2State && Number(tier2State.suppressUntil) > now) {
    return buildResult({
      action: 'suppress',
      bandId: band.id,
      band: bandConfig,
      reason: `tier-2 cool-down active until ${new Date(Number(tier2State.suppressUntil)).toISOString()} ` +
              `(everBad=${Number(tier2State.everBadCount) || 0})`,
      blocked: true,
      confidence: 'enforce',
      tier2Hit: 'cool_down',
      metrics,
      asOf: now,
    });
  }

  // 2) Insufficient data — never block, never override knobs
  if (n < minShow) {
    return buildResult({
      action: 'allow',
      bandId: band.id,
      band: bandConfig,
      reason: `insufficient data (n=${n} < minShow=${minShow}); defaulting to allow`,
      blocked: false,
      confidence: 'no_data',
      tier2Hit: 'fresh',
      metrics,
      asOf: now,
    });
  }

  // 3) Bad slot + tier-2 confirmation → promote to suppress (caller will write Tier 2)
  const pnlPerTrade = n > 0 ? pnlUSDT / n : 0;
  const isBad = (pnlPerTrade < BAD_PNL_PER_TRADE) ||
                (n >= minEnforce && winRate < BAD_WIN_RATE);
  const everBadCount = Number(tier2State && tier2State.everBadCount) || 0;

  if (isBad && n >= minEnforce && everBadCount >= suppressThreshold) {
    return buildResult({
      action: 'suppress',
      bandId: band.id,
      band: bandConfig,
      reason: `bad slot (winRate=${(winRate * 100).toFixed(1)}%, ` +
              `pnlPerTrade=${pnlPerTrade.toFixed(4)}) AND lifetime everBad=${everBadCount} ≥ ${suppressThreshold}`,
      blocked: true,
      confidence: 'enforce',
      tier2Hit: 'ever_bad',
      metrics,
      asOf: now,
    });
  }

  // 4/5) Apply band action with confidence gating
  const confidence = n >= minEnforce ? 'enforce' : 'show';
  const reason = confidence === 'enforce'
    ? `band=${band.id} action=${bandConfig.action} (winRate=${(winRate * 100).toFixed(1)}%, ` +
      `pnlPerTrade=${pnlPerTrade.toFixed(4)})`
    : `advisory only (n=${n} ∈ [${minShow},${minEnforce})); band=${band.id} action=${bandConfig.action}`;

  return buildResult({
    action: bandConfig.action,
    bandId: band.id,
    band: bandConfig,
    reason,
    blocked: ACTION_TO_BLOCKED[bandConfig.action] === true,
    confidence,
    tier2Hit: 'fresh',
    metrics,
    asOf: now,
  });
}

function defaultBandConfig(bandId) {
  // Defensive fallback if bands[bandId] is missing — never block by default.
  return {
    bandId,
    action: 'allow',
    notionalMult: 1,
    tpTightenPct: 0,
    slTightenPct: 0,
    forceST1: false,
    forceST2: false,
    forceST3: false,
    forceCBv5: false,
    minKcMult: 1,
    maxConcurrent: null,
    maxTradesPerDay: null,
  };
}

function buildResult(p) {
  return {
    action: p.action,
    bandId: p.bandId,
    band: p.band,
    reason: p.reason,
    blocked: p.blocked,
    confidence: p.confidence,
    tier2Hit: p.tier2Hit,
    metrics: p.metrics,
    asOf: p.asOf,
  };
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function positiveOrDefault(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

/**
 * Decide whether to write a fresh Tier 2 entry for this cell.
 * Returns true when the slot is newly bad AND persistent, meaning
 * the scheduler should bump everBadCount + extend suppressUntil.
 */
function shouldPromoteToTier2(result, tier2State, cooldownDays) {
  if (!result || !result.blocked) return false;
  if (result.tier2Hit !== 'ever_bad') return false; // already cool-down or fresh bad
  const days = positiveOrDefault(cooldownDays, 90);
  // Promote if no existing record or last promotion > 30 days ago
  const lastBadAt = tier2State && tier2State.lastBadAt ? Number(tier2State.lastBadAt) : 0;
  if (!lastBadAt) return true;
  return (Date.now() - lastBadAt) > (30 * 24 * 60 * 60 * 1000);
}

module.exports = {
  classify,
  shouldPromoteToTier2,
  BAD_PNL_PER_TRADE,
  BAD_WIN_RATE,
};
