'use strict';

/**
 * FIX-2026-08-12 (audit Q14): shared atomic force-close state set.
 *   - Audit found: forceClose.js FORCE_OPEN_STATES = 8 states (includes 'placed')
 *     vs trader.js _forceCloseTradeNow ALLOWED_FROM = 6 states (excludes 'placed')
 *     → on concurrent paths, both can pass their atomic claim.
 *   - The 'placed' state was added to forceClose.js to handle "BUY not yet filled
 *     but wants to be force-closed" (e.g. user cancels BUY). But it's a SAFETY gap:
 *     a forced cancel of a 'placed' BUY is correct (the BUY hasn't filled, so no
 *     SELL exists). However, including 'placed' in FORCE_OPEN_STATES means
 *     _forceCloseTradeNow()-style MARKET claims can hit a 'placed' trade that
 *     has no asset to sell — leading to "insufficient balance" + stuck state.
 *   - Fix: extract a shared constant. The 'placed' state is intentionally kept
 *     in forceClose.js (manual cancel-of-pending-BUY use case) but excluded
 *     from atomic MARKRT force-close.
 *
 * Two states with distinct semantics:
 *   - ATOMIC_FORCE_CLOSE_STATES: 6 states — used by _forceCloseTradeNow + markTradeSold
 *     when doing MARKET SELL (require filled BUY first)
 *   - FORCE_OPEN_STATES: 8 states — used by manual forceClose (covers 'placed' too)
 */

const ATOMIC_FORCE_CLOSE_STATES = Object.freeze([
  'partial_wait',
  'filled',
  'retrying',
  'holding',
  'selling',
  'partial_sell_wait',
  'stopping',
]);

// Wider set: includes 'placed' (BUY not yet filled) — used for manual force-close
// that allows "cancel pending BUY without SELL" path.
const FORCE_OPEN_STATES = Object.freeze([
  'placed',
  'partial_wait',
  'filled',
  'holding',
  'selling',
  'retrying',
  'partial_sell_wait',
  'stopping',
]);

module.exports = {
  ATOMIC_FORCE_CLOSE_STATES,
  FORCE_OPEN_STATES,
};
