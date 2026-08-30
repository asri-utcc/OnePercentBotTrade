'use strict';

const mongoose = require('mongoose');

/**
 * FIX-2026-08-30 / Phase 4 — Auto-Timing Tier 2 (persistent lifetime) state.
 *
 * Stores per-(day, hour) cell aggregated evidence that survives across the
 * 30-day rolling window. Used by the classifier to:
 *   - Apply the 2-tier model (recent rolling + persistent lifetime + cool-down)
 *   - Promote a "bad" cell into a sticky suppression (cool-down ≥90 days)
 *   - Avoid the self-fulfilling prophecy feedback loop (Suppressed cells
 *     decay to n=0 → re-allowed → bad trade → Suppressed again)
 *
 * Composite key: (day, hour) — global across all bots/symbols (per design decision).
 *
 * Schema fields:
 *   day (0..6)              — day of week (server-local TZ)
 *   hour (0..23)            — hour of day (server-local TZ)
 *   everBadCount            — lifetime count of "bad" evaluations (n ≥ minEnforce,
 *                             bad pnlPerTrade or low winRate)
 *   firstBadAt              — first time this cell was classified bad
 *   lastBadAt               — most recent bad classification
 *   suppressUntil           — cool-down end timestamp; until then classify → suppress
 *   lifetimeN               — total trades counted (across all bots) since first record
 *   lifetimeWinRate         — cumulative win rate 0..1
 *   lifetimePnlUSDT         — cumulative net PnL
 *   lastEvaluatedAt         — last time the scheduler processed this cell
 */
const AutoTimingLifetimeSchema = new mongoose.Schema({
  day:  { type: Number, required: true, min: 0, max: 6 },
  hour: { type: Number, required: true, min: 0, max: 23 },
  everBadCount:    { type: Number, default: 0, min: 0 },
  firstBadAt:      { type: Date,   default: null },
  lastBadAt:       { type: Date,   default: null },
  suppressUntil:   { type: Date,   default: null },
  lifetimeN:       { type: Number, default: 0, min: 0 },
  lifetimeWinRate: { type: Number, default: 0, min: 0, max: 1 },
  lifetimePnlUSDT: { type: Number, default: 0 },
  lastEvaluatedAt: { type: Date,   default: null },
}, {
  timestamps: true,
  collection: 'auto_timing_lifetime',
});

AutoTimingLifetimeSchema.index({ day: 1, hour: 1 }, { unique: true });

module.exports = mongoose.model('AutoTimingLifetime', AutoTimingLifetimeSchema);
