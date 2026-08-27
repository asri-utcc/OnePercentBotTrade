'use strict';

/**
 * FIX-2026-08-27 Phase 3b-2: Custom Alert Thresholds
 *
 * Per-event thresholds for telegram notifier. Lives in AppConfig.telegramThresholds
 * alongside the existing positionLossPct/positionProfitPct/positionStuckMin/bnbLowBalanceUsdt.
 *
 * New thresholds (Phase 3b-2):
 *   - cbPanicMinPositions  (number, default 1)
 *       Suppress CB panic-close alerts if closedCount < cbPanicMinPositions.
 *       Rationale: basic-tier small accounts don't need alerts for every single
 *       position panic-close; enterprise-tier big accounts want every panic.
 *       Set to 3 on basic to suppress noise; set to 1 on enterprise for max coverage.
 *
 *   - quietHoursEnabled  (bool, default false)
 *   - quietHoursStart    (HH:mm string, default '22:00')
 *   - quietHoursEnd      (HH:mm string, default '07:00')
 *       When enabled, suppress ALL telegram alerts during [start, end) window.
 *       Handles wrap-around (start > end means window crosses midnight, e.g.
 *       22:00–07:00 suppresses every night).
 *       Use case: don't wake up at 3am for routine position-loss alerts.
 *       Critical alerts (anti-tamper, login-locked) intentionally bypass quiet
 *       hours — see telegramNotifier dispatch() whitelist.
 *
 * Pattern: pure helpers, no I/O. telegramNotifier.dispatch() reads
 * cfg.thresholds and calls these helpers to decide whether to send.
 */

const DEFAULT_ALERT_THRESHOLDS = Object.freeze({
  cbPanicMinPositions: 1,
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
});

/**
 * Merge defaults with user-provided thresholds. User values win per-field.
 * Pure — no mutation of inputs.
 */
function getEffectiveThresholds(userThresholds) {
  return Object.assign({}, DEFAULT_ALERT_THRESHOLDS, userThresholds || {});
}

/**
 * Return true if telegram alert SHOULD be sent for a CB panic-close event
 * with the given closedCount.
 *
 *   closedCount=2, cbPanicMinPositions=3  → false (suppress — small panic)
 *   closedCount=3, cbPanicMinPositions=3  → true  (hit threshold)
 *   closedCount=5, cbPanicMinPositions=1  → true  (default — always alert)
 *
 * Defensive: invalid thresholds fall back to "always alert" (cbPanicMinPositions=1)
 * so misconfiguration doesn't silently silence critical alerts.
 */
function shouldAlertCbPanic(closedCount, thresholds) {
  const raw = (thresholds && typeof thresholds === 'object') ? thresholds.cbPanicMinPositions : undefined;
  const min = Number.isFinite(Number(raw)) ? Number(raw) : 1;
  // min < 1 means "always alert" (treat same as 1)
  const effectiveMin = min < 1 ? 1 : min;
  const count = Number.isFinite(Number(closedCount)) ? Number(closedCount) : 0;
  return count >= effectiveMin;
}

/**
 * Parse HH:mm string into { hour, minute }. Returns null on invalid input.
 * Accepts both "22:00" and "7:00" and "7:5" (single-digit minutes OK).
 */
function parseHHmm(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Convert HH:mm string to total minutes since midnight (0..1439).
 * Returns null on invalid input.
 */
function toMinutes(s) {
  const p = parseHHmm(s);
  if (!p) return null;
  return p.hour * 60 + p.minute;
}

/**
 * Return true if `now` (Date) falls inside the configured quiet-hours window.
 *
 *   quietHoursEnabled=false  → always false (no quiet hours)
 *   start=end                → always false (degenerate, never match)
 *   start=22:00, end=07:00   → suppress from 22:00 today through 07:00 next day
 *                              (wraps midnight)
 *   start=09:00, end=17:00   → suppress from 09:00 through 17:00 same day
 *                              (no wrap)
 *
 * `now` defaults to `new Date()`. Thresholds object expected shape:
 *   { quietHoursEnabled, quietHoursStart, quietHoursEnd }
 *
 * Invalid times → returns false (fail-open: don't silence alerts on bad config).
 */
function isInQuietHours(now, thresholds) {
  if (!thresholds || thresholds.quietHoursEnabled !== true) return false;
  const startMin = toMinutes(thresholds.quietHoursStart);
  const endMin = toMinutes(thresholds.quietHoursEnd);
  if (startMin == null || endMin == null) return false;
  if (startMin === endMin) return false; // degenerate window

  const d = now instanceof Date ? now : new Date();
  if (Number.isNaN(d.getTime())) return false;
  const nowMin = d.getHours() * 60 + d.getMinutes();

  if (startMin < endMin) {
    // Same-day window: [startMin, endMin)
    return nowMin >= startMin && nowMin < endMin;
  }
  // Wrap-around window: [startMin, 24:00) ∪ [00:00, endMin)
  return nowMin >= startMin || nowMin < endMin;
}

module.exports = {
  DEFAULT_ALERT_THRESHOLDS,
  getEffectiveThresholds,
  shouldAlertCbPanic,
  parseHHmm,
  toMinutes,
  isInQuietHours,
};
