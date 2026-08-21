'use strict';

/**
 * 2026-08-21: BUY commitment — atomic in-process claim counter.
 *
 * Problem (root cause of "กั๊กเงิน หลุด"):
 *   - trader.js balance check used `freeUsdt + lockedUsdt` as availableUsdt
 *   - but `locked` is USDT already committed to open LIMIT_MAKER BUYs
 *   - when 2 bots call getAccount() concurrently, both see the same balance
 *     → both pass the reserve check → both place BUY → total committed
 *     exceeds reserve
 *   - e.g. total=20, reserve=10 (usable=10). Bot A + Bot B race, both pass,
 *     both place 8 USDT → total committed = 16 (should be capped at 10).
 *     → after fills, total drops below reserve → reserve "หลุด".
 *
 * Fix:
 *   - For NEW BUY intent, the right number to check is `freeUsdt - reserve`
 *     (not `free + locked - reserve`), because `locked` is already spoken for.
 *   - Additionally, use an atomic claim counter so concurrent BUYs from
 *     different bots cannot both pass the check.
 *
 * Single-process assumption:
 *   - onepercentbot runs as 1 pm2 fork process (verified via `pm2 list`)
 *   - so an in-process counter is sufficient; no need for Mongo-backed claim.
 *   - if multi-worker support is ever needed, swap this for an
 *     AppConfig.findOneAndUpdate({...}, {$inc: {committedUsdt: x}}, ...)
 *     pattern (similar to src/services/walletReserve.js caching).
 *
 * API:
 *   - claimBuy(notional) -> boolean   (atomic: returns false if would overcommit)
 *   - releaseBuy(notional)            (call on cancel / place-fail / -2010 retry skip)
 *   - getCommitted() -> number        (for tests / debug)
 *   - reset()                         (call on process start / test teardown)
 *
 * Notional is rounded to 4 decimals before claim/release to avoid floating drift.
 */

const PRECISION = 4;

let _committed = 0;

function _round(n) {
  return Math.round(Number(n) * Math.pow(10, PRECISION)) / Math.pow(10, PRECISION);
}

/**
 * Atomically try to claim `notional` USDT for an upcoming BUY.
 * Returns true if claimed, false if not (caller should abort).
 *
 * IMPORTANT: caller MUST call releaseBuy(notional) on every code path where
 * the order is NOT actually placed (cancel-fail skip, -2010 retry skip, etc.)
 * — only successful newOrder() responses should keep the claim.
 */
function claimBuy(notional) {
  const n = _round(notional);
  if (!Number.isFinite(n) || n <= 0) return false;
  // JS is single-threaded — synchronous read-modify-write is atomic
  _committed = Math.round((_committed + n) * Math.pow(10, PRECISION)) / Math.pow(10, PRECISION);
  return true;
}

/**
 * Release a previously-claimed notional (used when order placement failed
 * or got cancelled before committing USDT to Binance).
 */
function releaseBuy(notional) {
  const n = _round(notional);
  if (!Number.isFinite(n) || n <= 0) return;
  _committed = Math.max(0, Math.round((_committed - n) * Math.pow(10, PRECISION)) / Math.pow(10, PRECISION));
}

/**
 * Current committed total (for tests / debug).
 */
function getCommitted() {
  return _committed;
}

/**
 * Reset to 0 (call on process start / test teardown).
 */
function reset() {
  _committed = 0;
}

module.exports = {
  claimBuy,
  releaseBuy,
  getCommitted,
  reset,
};
