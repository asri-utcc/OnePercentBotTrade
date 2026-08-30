'use strict';

/**
 * FIX-2026-08-30: Hold-time band thresholds — single source of truth for both the
 * heatmap UI and the Auto-Timing classifier. Frontend (`public/js/pages/trade-analysis.js`)
 * mirrors this constant because there is no shared build step; if you change the bands
 * here, mirror them there too.
 *
 * Each band's maxMin is an UPPER BOUND in minutes. holdBandOf() walks the array in
 * order and returns the first band whose maxMin is >= the input. The final band
 * always has maxMin = Infinity to catch anything above the previous threshold.
 *
 * Bands (5 tiers, green→red):
 *   🔵 ≤10 นาที   — same-candle scalps
 *   🟢 10 นาที–1 �ม. — fast trades
 *   🟡 1–12 ชม.   — intraday holds
 *   🟠 12–48 ชม.  — multi-day bags starting
 *   🔴 >2 วัน    — chronic bags (candidates for Auto-Timing Suppress)
 */
const HOLD_BANDS = [
  { id: 'lt10m',     maxMin: 10,     rgb: '0,170,255',  label: '≤10 นาที' },
  { id: 'lt1h',      maxMin: 60,     rgb: '0,229,184',  label: '10 นาที–1 ชม.' },
  { id: 'lt12h',     maxMin: 720,    rgb: '255,209,102', label: '1–12 ชม.' },
  { id: 'lt48h',     maxMin: 2880,   rgb: '255,159,67',  label: '12–48 ชม.' },
  { id: 'gt48h',     maxMin: Infinity, rgb: '255,77,109',  label: '>2 วัน' },
];

function holdBandOf(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return HOLD_BANDS[HOLD_BANDS.length - 1];
  return HOLD_BANDS.find((b) => minutes <= b.maxMin) || HOLD_BANDS[HOLD_BANDS.length - 1];
}

function holdBandIndexOf(minutes) {
  return HOLD_BANDS.indexOf(holdBandOf(minutes));
}

module.exports = { HOLD_BANDS, holdBandOf, holdBandIndexOf };
