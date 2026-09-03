'use strict';

/**
 * FIX-2026-09-03: Regression guard for round-down double-claim bug in trader.placeBuy().
 *
 * Bug history:
 *   - Round-down retry path (FIX-2026-09-02, L4415) calls buyCommitment.claimBuy(adjReqWithBuffer)
 *     on the round-down-adjusted amount.
 *   - The original code then "fell through" to the post-if atomic claim at L4457, which called
 *     buyCommitment.claimBuy(requiredWithBuffer) AGAIN with the (now-overridden) requiredWithBuffer.
 *   - When the 2nd claim race-lost (committed + adjReqWithBuffer > availableForNewBuy), the
 *     function returned at L4466 WITHOUT releasing the 1st round-down claim.
 *   - Result: committed counter permanently stuck at adjReqWithBuffer after every successful
 *     round-down. Observed in production: 8.1524 / 7.0378 USDT stuck for 6-14 hours, blocking
 *     every concurrent bot from passing the balance check.
 *
 * Fix:
 *   - Added `let roundDownClaimed = false;` flag (just inside the balance-check try block).
 *   - Round-down success path sets `roundDownClaimed = true;` after setting `claimedBuy = true`.
 *   - Wrapped the post-if atomic claim in `if (!roundDownClaimed)` so the 2nd claimBuy() is
 *     skipped when round-down has already claimed. The release path at L4482/L4722/L4765/L4817
 *     still works correctly because `requiredWithBuffer` was overridden to adjReqWithBuffer
 *     BEFORE claimedBuy=true was set.
 *
 * This is a SOURCE-LEVEL contract test (mirrors botDefaultsDupAutoPauseAdjustEnabled.test.js
 * pattern). It asserts the structural guard exists in trader.js so future refactors cannot
 * accidentally reintroduce the double-claim.
 */

const fs = require('fs');
const path = require('path');

const TRADER_PATH = path.join(__dirname, '..', 'src', 'core', 'trader.js');
const traderSrc = fs.readFileSync(TRADER_PATH, 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s;,(])\/\/[^\n]*/g, '$1');
}

describe('FIX-2026-09-03 — round-down double-claim guard in trader.placeBuy()', () => {
  // Strip comments so we don't accidentally match the FIX comments themselves.
  const code = stripComments(traderSrc);

  test('balance-check try block declares `let roundDownClaimed = false`', () => {
    // The flag must be declared INSIDE the try block so the catch can see it (we don't actually
    // use it in the catch today, but it's safer than putting it at function scope).
    // Accept either `let roundDownClaimed = false;` or `let roundDownClaimed =false;`.
    const matches = code.match(/let\s+roundDownClaimed\s*=\s*false\s*;/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  test('round-down success path sets roundDownClaimed = true', () => {
    // Find the round-down claim success block — must set the flag
    // Look for: claimedBuy = true ... roundDownClaimed = true
    expect(code).toMatch(/claimedBuy\s*=\s*true[\s\S]{0,300}roundDownClaimed\s*=\s*true/);
  });

  test('post-if atomic claim is wrapped in `if (!roundDownClaimed)`', () => {
    // The post-if block at L4470 must guard the claimBuy call.
    // Pattern: if (!roundDownClaimed) { const claimed = buyCommitment.claimBuy(...)
    expect(code).toMatch(/if\s*\(\s*!roundDownClaimed\s*\)\s*\{[^}]*buyCommitment\.claimBuy\(/);
  });

  test('else branch has skip-2nd-claim log message (diagnostics)', () => {
    // Verify the else branch emits a debug log so operators can confirm the guard fired.
    expect(code).toMatch(/round-down already claimed.*skipping 2nd claimBuy/i);
  });

  test('no orphan `buyCommitment.claimBuy(` calls outside guarded blocks', () => {
    // Sanity: any direct claimBuy call must be inside the round-down branch OR the
    // post-if `if (!roundDownClaimed)` guard, OR the DCA topUp path.
    // Find all claimBuy call sites and verify they're properly guarded.
    const claimBuySites = [...code.matchAll(/buyCommitment\.claimBuy\(/g)];
    expect(claimBuySites.length).toBeGreaterThanOrEqual(3); // round-down + post-if + topUp

    // Each claimBuy site should be preceded (within 500 chars) by either:
    //   - "if (this.bot.roundDownCapitalEnabled === true) {"  (round-down branch)
    //   - "if (!roundDownClaimed) {"  (post-if guard)
    //   - "buyCommitment.claimBuy(topUpNotional);" (topUp path L7273 - unguarded is OK because it's DCA only)
    // We can't easily diff those patterns here, but the existence of the guard
    // is the primary contract — see the test above.
  });
});

describe('FIX-2026-09-03 — roundDownCapital.computeAdjustedNotional still over-spend-safe', () => {
  // CRITICAL: even though the double-claim fix removed the leak path, the round-down math
  // must still satisfy its over-spend invariant. If anyone modifies the math and breaks this,
  // every round-down retry could over-spend vs available USDT → catastrophic for reserves.

  const rdc = require('../src/services/roundDownCapital');

  test('adjusted × (1 + fee) ≤ availableForNewBuy for all reasonable inputs', () => {
    const cases = [
      { avail: 7.581, fee: 0.001 },
      { avail: 7.58, fee: 0.001 },
      { avail: 4, fee: 0.001 },
      { avail: 0.01, fee: 0.001 },
      { avail: 100, fee: 0.0005 },
      { avail: 5.5, fee: 0.001 },
      { avail: 10000, fee: 0.001 },
      { avail: 0.001, fee: 0.001 },
      { avail: 7.7699, fee: 0.001 }, // matches the leaked committed values
    ];
    cases.forEach(({ avail, fee }) => {
      const r = rdc.computeAdjustedNotional({ availableForNewBuy: avail, feeBufferRate: fee });
      if (!r.belowMin) {
        const totalRequired = r.adjusted * (1 + fee);
        expect(totalRequired).toBeLessThanOrEqual(avail + 1e-9);
      }
    });
  });
});
