'use strict';

/**
 * FIX-2026-09-02: Round-down Capital — pure math helpers
 *
 * Background: when a BUY signal arrives but usable USDT balance is less than the
 * requested notional (e.g. capitalPerTrade=10 USDT but only 7.58 USDT available),
 * the trader normally skips the BUY with "insufficient USDT balance". When the
 * per-bot roundDownCapitalEnabled flag is on, the trader rounds the notional DOWN
 * to fit available balance (rounded to 2 decimals — USDT quote precision) so that
 * the order can still be placed. If the rounded amount would fall below the
 * configurable minimum (default 5.5 USDT), the BUY is still skipped (a
 * sub-minimum BUY is not useful — likely below exchange minNotional too).
 *
 * This module is the **single source of truth** for the math, so that:
 *   - trader.placeBuy() applies the same formula in production
 *   - tests/roundDownCapital.test.js can validate edge cases without
 *     spinning up a full Trader instance (which requires binanceRest,
 *     buyCommitment, walletReserve, Signal/Trade/Bot models, etc.)
 *
 * Functions are PURE (no DB / no side effects). Round-down uses Math.floor
 * (never exceeds available), to 2 decimals (USDT quote precision).
 */

const DEFAULT_MIN = 5.5;        // user-requested default
const MIN_BOUND = 1;             // schema min
const MAX_BOUND = 10000;         // schema max
const QUOTE_PRECISION = 100;     // 2 decimal places (USDT quote precision)

/**
 * Resolve the effective minimum-notional for round-down.
 * - Falls back to DEFAULT_MIN when value is NaN / non-positive / not finite
 * - Clamps to [MIN_BOUND, MAX_BOUND] so a stale UI value cannot trigger
 *   a ridiculous "round to $0.0001" attempt
 * - Returns a finite positive number; never returns null/undefined
 */
function resolveMinRound(value) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MIN;
  return Math.min(MAX_BOUND, Math.max(MIN_BOUND, value));
}

/**
 * Round a notional down to USDT quote precision (2 decimals).
 * Math.floor to ensure the result NEVER exceeds the input (no accidental over-spend).
 */
function floorToQuotePrecision(rawUSDT) {
  return Math.floor(rawUSDT * QUOTE_PRECISION) / QUOTE_PRECISION;
}

/**
 * Compute the adjusted BUY notional to fit available USDT.
 *
 * @param {Object} args
 * @param {number} args.availableForNewBuy  USDT currently spendable (free - reserve - committed).
 * @param {number} args.feeBufferRate       maker fee rate (e.g. 0.001 for 0.1%).
 *                                         Required notional (incl. fee) = adjusted × (1 + feeBufferRate)
 *                                         → adjusted = available / (1 + feeBufferRate)
 * @param {number} [args.minRound]          optional override for the minimum threshold.
 *                                         When omitted, uses DEFAULT_MIN (5.5).
 *                                         A non-positive / NaN value also falls back to DEFAULT_MIN
 *                                         via resolveMinRound().
 * @returns {{
 *   adjustedRaw: number,           // before flooring — useful for diagnostics
 *   adjusted: number,              // floored to 2 decimals (USDT quote precision)
 *   belowMin: boolean,             // true → caller should skip the BUY
 *   minRound: number,              // effective min after fallback + clamp
 *   reason?: string,               // populated when belowMin=true
 * }}
 */
function computeAdjustedNotional({ availableForNewBuy, feeBufferRate, minRound } = {}) {
  const avail = Number.isFinite(availableForNewBuy) && availableForNewBuy > 0 ? availableForNewBuy : 0;
  const fee = Number.isFinite(feeBufferRate) && feeBufferRate >= 0 ? feeBufferRate : 0;
  const minR = resolveMinRound(minRound);

  // adjustedRaw = avail / (1 + fee) — what we can afford AFTER paying the maker fee
  const adjustedRaw = avail / (1 + fee);
  const adjusted = floorToQuotePrecision(adjustedRaw);

  if (adjusted < minR) {
    return {
      adjustedRaw,
      adjusted,
      belowMin: true,
      minRound: minR,
      reason: `insufficient USDT balance: round-down ${adjusted.toFixed(4)} < min ${minR} (available ${avail.toFixed(4)})`,
    };
  }
  return {
    adjustedRaw,
    adjusted,
    belowMin: false,
    minRound: minR,
  };
}

module.exports = {
  DEFAULT_MIN,
  MIN_BOUND,
  MAX_BOUND,
  QUOTE_PRECISION,
  resolveMinRound,
  floorToQuotePrecision,
  computeAdjustedNotional,
};
