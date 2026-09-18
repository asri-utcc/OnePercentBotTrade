'use strict';

/**
 * FIX-2026-09-17 (Schedule Offset) — per-instance first-fire stagger for periodic timers.
 *
 * Problem
 * -------
 * 2 PM2 instances (`onepercentbot` + `onepercentbot-faiz`) on the same host share the same
 * Binance IP weight budget (6000/min). Their periodic sweeps (reconcile, auv2, watchdog,
 * autoBnbBuyer, etc.) all fire at the same wall-clock minute because both instances boot
 * within seconds of each other. Combined weight spike opens the Circuit Breaker —
 * 1000CATUSDT was stuck 265h before the orphan-recovery fix.
 *
 * Existing `_jitter(base, 0.10)` only spreads each instance's own ticks ±10% around its
 * own boot time, which is not enough to prevent stacking when boot times are seconds apart.
 *
 * Fix
 * ---
 * Read `SCHEDULE_OFFSET_SEC` (0..59) once at module load (env is frozen for process
 * lifetime). Each call site delegates scheduling here; we delay the FIRST fire by offsetMs
 * and keep the recurring cadence at baseMs thereafter. Instance A with offset=12 fires at
 * xx:05:12, instance B with offset=42 fires at xx:05:42 — 30s gap, well within a 60s
 * refill window so weight spikes never stack.
 *
 * First-fire correctness
 * ----------------------
 * The helper MUST restart the recurring setInterval AFTER the offset fires, otherwise
 * the cadence anchors at boot time (t=0) and after one cycle the two instances
 * re-collide (e.g. owner offset=12s, faiz offset=42s → first fires 30s apart, but both
 * setIntervals tick every 5min starting at t=0, so second fires land at t=5min for both,
 * 0s apart — defeating the whole purpose). Restart-anchor gives clean cadence:
 * offsetMs → offsetMs+baseMs → offsetMs+2*baseMs → … with NO collision drift.
 *
 * Env
 * ---
 *   SCHEDULE_OFFSET_SEC (0..59) — recommended 12 for owner, 42 for faiz (30s gap).
 *   Default 0 if unset (single-instance deploy: unchanged behavior).
 *
 * Reuse
 * -----
 * - logger (../utils/logger) — same Pino instance as botManager / services
 * - dotenv propagation handled by config/index.js (owner) and ecosystem.faiz.config.js
 *   loadEnvFile() (faiz); no PM2 file changes needed.
 */

const logger = require('./logger');

// ── read env ONCE at module load (idempotent — frozen for process lifetime) ──
function _parseOffsetSec() {
  const raw = process.env.SCHEDULE_OFFSET_SEC;
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn(
      { SCHEDULE_OFFSET_SEC: raw },
      'scheduledInterval: SCHEDULE_OFFSET_SEC invalid — defaulting to 0',
    );
    return 0;
  }
  // clamp 0..59 (offset bounded by 1 minute; for intervals > 60s, offsetMs < baseMs anyway)
  return Math.max(0, Math.min(59, n));
}
const OFFSET_SEC = _parseOffsetSec();
const OFFSET_MS = OFFSET_SEC * 1000;

if (OFFSET_SEC > 0) {
  logger.info(
    { SCHEDULE_OFFSET_SEC: OFFSET_SEC, offsetMs: OFFSET_MS },
    'scheduledInterval: SCHEDULE_OFFSET_SEC active — first-fire stagger enabled',
  );
}

// ── per-handle bookkeeping so `clearScheduledInterval()` can kill BOTH timers ──
// Keyed on the intervalHandle (or a sentinel { intervalHandle: null } before setInterval
// is created) so clearScheduledInterval always finds its entry even if called before
// setTimeout fires (and the recurring interval hasn't been created yet).
const _handles = new WeakMap();

function _clearEntry(handleOrEntry) {
  let entry;
  if (handleOrEntry && typeof handleOrEntry.intervalHandle !== 'undefined') {
    entry = handleOrEntry;
  } else {
    entry = _handles.get(handleOrEntry);
  }
  if (!entry) return;
  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
    entry.timeoutHandle = null;
  }
  if (entry.intervalHandle) {
    clearInterval(entry.intervalHandle);
    _handles.delete(entry.intervalHandle);
    entry.intervalHandle = null;
  }
}

/**
 * Schedule a periodic timer with a one-time first-fire offset.
 *
 * @param {Function} fn                The callback (matches setInterval signature)
 * @param {number}   baseMs            Recurring interval in ms (e.g. 5*60*1000)
 * @param {object}   [opts]
 * @param {number}   [opts.offsetSec]  Per-call override (default = module OFFSET_SEC)
 * @param {boolean}  [opts.unref=false] Call .unref() on the recurring handle (PM2-shutdown safe)
 * @param {string}   [opts.meta]       Component/timer name for log line, e.g. 'botManager:reconcile'
 * @returns {NodeJS.Timeout|null}      Recurring setInterval handle; null if baseMs invalid.
 *                                     Use `clearScheduledInterval(handle)` to stop BOTH timers.
 */
function scheduledInterval(fn, baseMs, opts = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError('scheduledInterval: fn must be a function');
  }
  if (!Number.isFinite(baseMs) || baseMs <= 0) {
    logger.warn({ baseMs }, 'scheduledInterval: invalid baseMs — not scheduling');
    return null;
  }
  const offsetSec = (opts.offsetSec !== undefined)
    ? Math.max(0, Math.min(59, Math.floor(Number(opts.offsetSec) || 0)))
    : OFFSET_SEC;
  const offsetMs = offsetSec * 1000;

  // First-fire offset anchor:
  //   - If offsetMs > 0: setTimeout fires fn() once at +offsetMs, then schedules
  //     setInterval anchored at +offsetMs (so cadence is offsetMs → offsetMs+baseMs
  //     → offsetMs+2*baseMs …). This is critical — without restart, the original
  //     setInterval would have been ticking since t=0 and its NEXT fire after
  //     offsetMs would be at +baseMs, not +offsetMs+baseMs, causing instances to
  //     re-collide after one cycle.
  //   - If offsetMs === 0: fire immediately, then recurring baseMs.
  //
  // We don't use the "guarded setInterval" pattern here — restarting setInterval
  // is cleaner and produces a stable cadence.
  let intervalHandle = null;
  const entry = { intervalHandle: null, timeoutHandle: null };

  const startRecurring = () => {
    intervalHandle = setInterval(fn, baseMs);
    if (opts.unref && typeof intervalHandle.unref === 'function') {
      intervalHandle.unref();
    }
    entry.intervalHandle = intervalHandle;
    _handles.set(intervalHandle, entry);
  };

  if (offsetMs > 0) {
    entry.timeoutHandle = setTimeout(() => {
      if (entry.timeoutHandle === null) return; // already cleared
      entry.timeoutHandle = null;
      // Fire first call, then start the recurring interval anchored at NOW
      try {
        fn();
      } catch (err) {
        logger.error({ err: err.message, meta: opts.meta }, 'scheduledInterval: first-fire callback threw');
      }
      startRecurring();
    }, offsetMs);
    if (typeof entry.timeoutHandle.unref === 'function') {
      entry.timeoutHandle.unref();
    }
  } else {
    // No offset: fire once immediately, then recurring
    try {
      fn();
    } catch (err) {
      logger.error({ err: err.message, meta: opts.meta }, 'scheduledInterval: first-fire callback threw');
    }
    startRecurring();
  }

  if (opts.meta) {
    const now = Date.now();
    logger.info(
      {
        meta: opts.meta,
        baseMs,
        offsetSec,
        offsetMs,
        nextFireAt: new Date(now + offsetMs).toISOString(),
        nextRecurAt: new Date(now + offsetMs + baseMs).toISOString(),
      },
      'scheduledInterval: timer scheduled',
    );
  }

  // If offsetMs > 0, intervalHandle is still null at this point. Caller code currently
  // does `clearInterval(this.timer)` in stop() — for the offset case, we expose a
  // sentinel wrapper so clearScheduledInterval(sentinel) can clean up both timers
  // even before setTimeout fires.
  if (intervalHandle === null) {
    // Pre-offset: return the entry object itself so callers using
    // `clearScheduledInterval(returned)` work correctly. Callers using bare
    // `clearInterval(returned)` get a no-op (no .unref or scheduled-tick fires),
    // which is benign — the setTimeout will still fire and clear itself on next tick.
    _handles.set(entry, entry); // self-key so clearScheduledInterval(entry) works
    return entry;
  }
  return intervalHandle;
}

/**
 * Stop both the recurring interval AND the pending first-fire timeout.
 * Silently falls back to clearInterval() for handles not created by scheduledInterval().
 */
function clearScheduledInterval(handleOrEntry) {
  if (!handleOrEntry) return;
  if (_handles.has(handleOrEntry)) {
    _clearEntry(handleOrEntry);
  } else {
    // Not ours — fall back to plain clearInterval for caller-defined handles.
    clearInterval(handleOrEntry);
  }
}

module.exports = {
  scheduledInterval,
  clearScheduledInterval,
  // exposed for tests + diagnostics
  OFFSET_SEC,
  OFFSET_MS,
};
