'use strict';

const mongoose = require('mongoose');

/**
 * FIX-2026-08-30 / Phase 4 — Auto-Timing per-decision log (append-only).
 *
 * Records every BUY-time decision the Auto-Timing decider made, regardless
 * of whether it blocked or modified the trade. Used by:
 *   - UI: "Recent decisions" list under Settings → Auto-Timing
 *   - Telegram: weekly summary scanner
 *   - Debugging: why did this BUY get blocked?
 *
 * 30-day TTL via Mongo `expireAfterSeconds` index on `createdAt`. The TTL
 * keeps the collection bounded even with high trade frequency (~24×24×60 = 34,560
 * entries/day worst-case at every-min candle, vs ~100-1000/day typical).
 *
 * Schema fields:
 *   botId      — Bot._id (String; matches existing botId type)
 *   ts         — decision timestamp (default Date.now)
 *   day, hour  — bucket (server-local TZ)
 *   action     — final effectiveAction ('allow'|'limit'|'encourage'|'stimulate'|'suppress')
 *   source     — 'classifier' | 'override'
 *   blocked    — was the BUY skipped?
 *   skipReason — 'suppress'|'floor'|'max_concurrent'|'max_trades_day'|null
 *   bandId     — which hold-time band ('lt10m' etc.)
 *   bandSnapshot — {action, notionalMult, ...} full 10-knob snapshot
 *   overrideApplied — bot override action or null
 *   nWeighted  — rolling weighted trade count for the cell
 *   winRate    — rolling weighted win rate
 *   medianHoldMin — rolling weighted median hold (min)
 *   confidence — 'enforce'|'show'|'no_data'
 *   note       — free-text (e.g. "autoTiming_suppress", classifier reason)
 */
const AutoTimingLogSchema = new mongoose.Schema({
  botId:   { type: String, required: true, index: true },
  ts:      { type: Date,   default: Date.now, index: true },
  day:     { type: Number, required: true, min: 0, max: 6 },
  hour:    { type: Number, required: true, min: 0, max: 23 },
  action:  { type: String, required: true },
  source:  { type: String, default: 'classifier' },
  blocked: { type: Boolean, default: false },
  skipReason: { type: String, default: null },
  bandId:  { type: String, default: null },
  bandSnapshot: { type: Object, default: null },
  overrideApplied: { type: String, default: null },
  nWeighted:  { type: Number, default: 0 },
  winRate:    { type: Number, default: 0 },
  medianHoldMin: { type: Number, default: 0 },
  // FIX-2026-08-31: P75 hold (min) — companion to medianHoldMin so the UI can
  //   display both and the user can switch holdMetric in Settings without losing
  //   historical data.
  p75HoldMin: { type: Number, default: 0 },
  confidence: { type: String, default: 'no_data' },
  note:       { type: String, default: null },
}, {
  timestamps: true,
  collection: 'auto_timing_logs',
});

// FIX-2026-08-30: 30-day TTL — auto-purge old entries
AutoTimingLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('AutoTimingLog', AutoTimingLogSchema);
