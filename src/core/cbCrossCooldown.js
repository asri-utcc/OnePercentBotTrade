'use strict';

/**
 * FIX-2026-08-10: Cross-cooldown interaction helper for CBv2 / CBv3 / CBv5.
 *
 * CBv5 runs independently of cbVersion enum — user can have CBv5 + CBv2 (or CBv3)
 * active at the same time. When two CBs fire near each other, we need a single
 * source of truth for the EFFECTIVE cooldown end time. This helper centralizes
 * the logic so both trader (kline:closed path) and watchdog (REST path) compute
 * the same result.
 *
 * Rules (per user spec 2026-08-10):
 *
 *   Direction A — CBv5 lock ACTIVE, then CBv2 or CBv3 fires:
 *     - Cancel CBv5 cooldown (cbv5LockedUntil = null, cbv5LockReason = null)
 *     - Apply the NEW CBv2/CBv3 cooldown from now (full reset)
 *     - Audit: cbv5LastFiredAt is kept on bot doc (unchanged)
 *     - Caller is responsible for clearing trader._cbv5FiredAt = 0
 *
 *   Direction B — CBv2 or CBv3 lock ACTIVE, then CBv5 fires:
 *     - CBv5 is ABSORBED into the existing dominant cooldown (cbv5LockedUntil = null)
 *     - If CBv5's new lock > longest remaining of CBv2/CBv3 → EXTEND that field
 *       (cbv2LockedUntil or cbv3LockedUntil) to (now + cbv5LockHours)
 *     - If CBv5's new lock ≤ longest remaining → leave existing untouched
 *     - Audit: cbv5LastFiredAt is always set
 *     - Caller is responsible for NOT setting trader._cbv5FiredAt (since cbv5LockedUntil is null)
 *
 *   No active CBv2/CBv3 + CBv5 fires:
 *     - CBv5 takes its own lock (cbv5LockedUntil = now + cbv5LockHours)
 *
 * Pure function — mutates `bot` argument in place and returns a summary object.
 */

const SUPPORTED_VERSIONS = new Set(['v2', 'v3', 'v5']);

/**
 * Compute remaining ms for a given lock field on a bot doc.
 * Returns 0 if field is null/invalid/past.
 */
function _remainingMs(bot, key, nowMs) {
  const v = bot[key];
  if (v == null) return 0;
  const t = (v instanceof Date) ? v.getTime() : new Date(v).getTime();
  if (!Number.isFinite(t) || t <= nowMs) return 0;
  return t - nowMs;
}

/**
 * Apply cross-cooldown rules when a CB fires.
 *
 * @param {object} params
 * @param {object} params.bot — Bot Mongoose doc (mutated in place)
 * @param {'v2'|'v3'|'v5'} params.firingVersion — which CB just fired
 * @param {number} params.lockHours — lockHours from the firing bot
 * @param {number} params.nowMs — current time
 * @returns {{ appliedTo: string, cbv2LockedUntil: Date|null, cbv3LockedUntil: Date|null, cbv5LockedUntil: Date|null, cbv5LastFiredAt: Date }}
 */
function applyCrossCooldownOnFire({ bot, firingVersion, lockHours, nowMs }) {
  if (!bot || typeof bot !== 'object') {
    throw new TypeError('cbCrossCooldown: bot is required');
  }
  if (!SUPPORTED_VERSIONS.has(firingVersion)) {
    throw new TypeError(`cbCrossCooldown: unsupported firingVersion "${firingVersion}"`);
  }
  if (!Number.isFinite(lockHours) || lockHours <= 0) {
    throw new TypeError(`cbCrossCooldown: lockHours must be > 0, got ${lockHours}`);
  }
  if (!Number.isFinite(nowMs)) nowMs = Date.now();

  const newLockMs = lockHours * 3600 * 1000;
  const newLockedUntil = new Date(nowMs + newLockMs);
  const auditTimestamp = new Date(nowMs);

  // Always record audit timestamp for the firing version
  if (firingVersion === 'v5') bot.cbv5LastFiredAt = auditTimestamp;
  else if (firingVersion === 'v2') bot.cbv2LastFiredAt = auditTimestamp;
  else if (firingVersion === 'v3') bot.cbv3LastFiredAt = auditTimestamp;

  if (firingVersion === 'v5') {
    // Direction B: CBv5 fires (may be during CBv2/CBv3 cooldown)
    const cbv2Rem = _remainingMs(bot, 'cbv2LockedUntil', nowMs);
    const cbv3Rem = _remainingMs(bot, 'cbv3LockedUntil', nowMs);

    // No active CBv2/CBv3 → CBv5 takes its own lock
    if (cbv2Rem === 0 && cbv3Rem === 0) {
      bot.cbv5LockedUntil = newLockedUntil;
      bot.cbv5LockReason = 'cbv5_panic';
      return {
        appliedTo: 'cbv5-new',
        cbv2LockedUntil: null,
        cbv3LockedUntil: null,
        cbv5LockedUntil: newLockedUntil,
        cbv5LastFiredAt: auditTimestamp,
      };
    }

    // CBv5 is absorbed into the existing dominant cooldown
    // Pick the active CB with longer remaining; CBv3 wins ties (consistent with master cbVersion priority)
    const cbv5NewMs = newLockMs;
    const newLockDate = new Date(nowMs + cbv5NewMs);
    let targetField = null; // 'cbv2LockedUntil' or 'cbv3LockedUntil'
    let targetRemaining = 0;
    if (cbv3Rem > 0 && cbv3Rem >= cbv2Rem) {
      targetField = 'cbv3LockedUntil';
      targetRemaining = cbv3Rem;
    } else if (cbv2Rem > 0) {
      targetField = 'cbv2LockedUntil';
      targetRemaining = cbv2Rem;
    }

    if (targetField && cbv5NewMs > targetRemaining) {
      bot[targetField] = newLockDate;
    }
    bot.cbv5LockedUntil = null;
    bot.cbv5LockReason = null;

    const targetKey = targetField === 'cbv3LockedUntil' ? 'cbv3' : 'cbv2';
    return {
      appliedTo: cbv5NewMs > targetRemaining
        ? `cbv5-extended-${targetKey}`
        : `cbv5-absorbed-by-${targetKey}`,
      cbv2LockedUntil: bot.cbv2LockedUntil,
      cbv3LockedUntil: bot.cbv3LockedUntil,
      cbv5LockedUntil: null,
      cbv5LastFiredAt: auditTimestamp,
    };
  }

  // Direction A: CBv2 or CBv3 fires (CBv5 may be active)
  const cbv5WasActive = _remainingMs(bot, 'cbv5LockedUntil', nowMs) > 0;
  if (cbv5WasActive) {
    bot.cbv5LockedUntil = null;
    bot.cbv5LockReason = null;
  }

  if (firingVersion === 'v2') {
    bot.cbv2LockedUntil = newLockedUntil;
    bot.cbv2LockReason = 'cbv2_panic';
    return {
      appliedTo: cbv5WasActive ? 'cbv2-canceled-cbv5' : 'cbv2-fresh',
      cbv2LockedUntil: newLockedUntil,
      cbv3LockedUntil: null,
      cbv5LockedUntil: null,
      cbv5LastFiredAt: auditTimestamp,
    };
  }

  // firingVersion === 'v3'
  bot.cbv3LockedUntil = newLockedUntil;
  bot.cbv3LockReason = 'cbv3_panic';
  return {
    appliedTo: cbv5WasActive ? 'cbv3-canceled-cbv5' : 'cbv3-fresh',
    cbv2LockedUntil: null,
    cbv3LockedUntil: newLockedUntil,
    cbv5LockedUntil: null,
    cbv5LastFiredAt: auditTimestamp,
  };
}

module.exports = {
  applyCrossCooldownOnFire,
  SUPPORTED_VERSIONS,
};
