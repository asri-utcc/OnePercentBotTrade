'use strict';

/**
 * FIX-2026-08-09: Pure cooldown gate evaluator — extracted from trader.placeBuy for unit testability.
 *   ACEUSDT incident: positionWatchdog wrote DB cbv3LastFiredAt + cbv3LockedUntil but trader's
 *   in-memory _cbv3FiredAt was 0 → trader placed 5 BUYs during 8h CBv3 cooldown window.
 *
 *   Fix has 2 layers:
 *     (1) gate consults BOTH in-memory _cbv3FiredAt AND DB bot.cbv3LockedUntil
 *     (2) lazily backfill _cbv3FiredAt from bot.cbv3LastFiredAt on first placeBuy after external write
 *
 *   Returns { active: bool, remainingMs: number, source: 'in-memory' | 'db-cbv2LockedUntil' | 'db-cbv3LockedUntil' | null }
 *   Mutates the provided state object (sets _cbvN_FiredAt from DB if needed) — matches trader.placeBuy side effect.
 *
 *   Same shape works for CBv2 + CBv3 — caller passes the appropriate field names.
 *
 *   @param {Object} state  - mutable in-memory state { _cbv2FiredAt: number, _cbv3FiredAt: number }
 *   @param {Object} bot    - bot doc (must have cbvNLockHours + cbvNLastFiredAt + cbvNLockedUntil)
 *   @param {string} version - 'v2' | 'v3'
 *   @param {number} nowMs   - Date.now() (injected for determinism)
 */

function evaluateCbCooldown(state, bot, version, nowMs) {
  // FIX-2026-08-10: CBv5 added — version space {v2, v3, v5}
  const num = version === 'v2' ? 2 : (version === 'v3' ? 3 : (version === 'v5' ? 5 : 3));
  const v = `v${num}`;
  const lockHours = Math.max(0.5, Math.min(168, Number(bot[`cbv${num}LockHours`]) || (num === 5 ? 4 : 8)));
  const cooldownMs = lockHours * 3600 * 1000;
  const memKey = `_cbv${num}FiredAt`;
  const dbLastFiredKey = `cbv${num}LastFiredAt`;
  const dbLockedUntilKey = `cbv${num}LockedUntil`;

  // 1) backfill in-memory from DB if external writer set it
  if (state[memKey] === 0 && bot[dbLastFiredKey]) {
    const dbFiredMs = new Date(bot[dbLastFiredKey]).getTime();
    if (Number.isFinite(dbFiredMs) && dbFiredMs > 0) {
      state[memKey] = dbFiredMs;
    }
  }

  let activeUntil = 0;
  let source = null;

  // 2a) in-memory gate (cheaper, catches same-process fires)
  if (state[memKey] > 0 && (nowMs - state[memKey]) < cooldownMs) {
    activeUntil = state[memKey] + cooldownMs;
    source = 'in-memory';
  }
  // 2b) DB gate (catches watchdog / external / cross-restart writes)
  else if (bot[dbLockedUntilKey] && new Date(bot[dbLockedUntilKey]).getTime() > nowMs) {
    activeUntil = new Date(bot[dbLockedUntilKey]).getTime();
    source = `db-cbv${num}LockedUntil`;
    // backfill mem so subsequent calls take the cheap path
    if (state[memKey] === 0 && bot[dbLastFiredKey]) {
      const dbFiredMs = new Date(bot[dbLastFiredKey]).getTime();
      if (Number.isFinite(dbFiredMs) && dbFiredMs > 0) state[memKey] = dbFiredMs;
    }
  }

  if (activeUntil === 0) return { active: false, remainingMs: 0, source: null };
  return {
    active: true,
    remainingMs: Math.max(0, activeUntil - nowMs),
    source,
  };
}

module.exports = { evaluateCbCooldown };