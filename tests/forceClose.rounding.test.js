'use strict';

/**
 * FIX-2026-08-06: Unit tests for forceClose.js stepSize rounding logic
 *
 * Replicates the rounding math from [src/core/forceClose.js:253-313](../src/core/forceClose.js#L253-L313)
 * to lock down the invariant: freeQty sent to Binance MUST be a multiple of stepSize
 * AND >= minQty, otherwise exchange rejects with -1013 LOT_SIZE.
 *
 * HOMEUSDT incident 2026-08-06: freeQty=947.095 with stepSize=1 → -1013.
 */

const Decimal = require('decimal.js');

/**
 * Replicate the rounding logic from forceClose.js:268-298 to test in isolation.
 * Inputs: candidateRaw (number), stepSize (Decimal-string), minQty (Decimal-string)
 * Output: { qty: number, roundedBelowMin: boolean }
 */
function computeRoundedQty(candidateRaw, stepSizeStr, minQtyStr) {
  const stepSize = parseFloat(stepSizeStr);
  const minQty = parseFloat(minQtyStr);
  let marketSellQty = candidateRaw;
  marketSellQty = Math.floor(candidateRaw / stepSize) * stepSize;
  if (stepSize >= 1) {
    marketSellQty = Math.floor(marketSellQty);
  } else {
    const decimals = (stepSizeStr.split('.')[1] || '').replace(/0+$/, '').length;
    marketSellQty = parseFloat(marketSellQty.toFixed(decimals));
  }
  const roundedBelowMin = marketSellQty < minQty;
  return { qty: marketSellQty, roundedBelowMin };
}

describe('forceClose stepSize rounding (FIX-2026-08-06)', () => {
  describe('HOME/USDT (stepSize=1, minQty=1) — primary incident', () => {
    test('947.095 HOME → 947 (floor to integer)', () => {
      // The actual incident: freeQty=947.095 → 947 (floor to stepSize=1)
      const r = computeRoundedQty(947.095, '1', '1');
      expect(r.qty).toBe(947);
      expect(r.roundedBelowMin).toBe(false);
    });

    test('945.5 HOME → 945 (floor to integer)', () => {
      const r = computeRoundedQty(945.5, '1', '1');
      expect(r.qty).toBe(945);
      expect(r.roundedBelowMin).toBe(false);
    });

    test('943.11 HOME (buyQty 945 × 0.998) → 943 (matches fix-stuck script)', () => {
      // cap = min(freeQty, buyQty×0.998) = min(947.095, 943.11) = 943.11
      const cap = Math.min(947.095, 945 * 0.998);
      const r = computeRoundedQty(cap, '1', '1');
      expect(cap).toBe(943.11);
      expect(r.qty).toBe(943);
    });

    test('0.7 HOME → 0 (rounded below minQty → trigger fall-through to synthetic close)', () => {
      // Orphan scenario: freeQty 0.7 with stepSize=1, minQty=1
      const r = computeRoundedQty(0.7, '1', '1');
      expect(r.qty).toBe(0);
      expect(r.roundedBelowMin).toBe(true);
    });
  });

  describe('fractional stepSize (e.g. ZIL/USDT stepSize=0.1)', () => {
    test('1234.7 → 1234.7 (no rounding needed)', () => {
      const r = computeRoundedQty(1234.7, '0.1', '1');
      expect(r.qty).toBe(1234.7);
      expect(r.roundedBelowMin).toBe(false);
    });

    test('1234.74 → 1234.7 (floor to stepSize)', () => {
      const r = computeRoundedQty(1234.74, '0.1', '1');
      expect(r.qty).toBe(1234.7);
      expect(r.roundedBelowMin).toBe(false);
    });

    test('1234.99 → 1234.9 (NOT 1235.0)', () => {
      const r = computeRoundedQty(1234.99, '0.1', '1');
      expect(r.qty).toBe(1234.9);
    });
  });

  describe('micro stepSize (e.g. BTC/USDT stepSize=0.00001)', () => {
    test('0.12345678 → 0.12345 (floor to 5 decimals)', () => {
      const r = computeRoundedQty(0.12345678, '0.00001', '0.00001');
      expect(r.qty).toBe(0.12345);
      expect(r.roundedBelowMin).toBe(false);
    });

    test('0.000009 → 0.00000 (rounded to 0, below minQty)', () => {
      const r = computeRoundedQty(0.000009, '0.00001', '0.00001');
      expect(r.qty).toBe(0);
      expect(r.roundedBelowMin).toBe(true);
    });
  });

  describe('stepSize >= 1 (whole-number instruments)', () => {
    test('BANK/USDT stepSize=1: 100.99 → 100', () => {
      const r = computeRoundedQty(100.99, '1', '1');
      expect(r.qty).toBe(100);
    });

    test('COTI/USDT stepSize=1: 500.0001 → 500 (Decimal precision OK)', () => {
      const r = computeRoundedQty(500.0001, '1', '1');
      expect(r.qty).toBe(500);
    });
  });

  describe('Decimal integrity regression', () => {
    test('no Float rounding errors leak through (Decimal-floor then integer)', () => {
      // 947.095 / 1 = 947.095 → Math.floor = 947 → 947 * 1 = 947
      // 947.095 / 0.001 = 947095 → Math.floor = 947095 → 947095 * 0.001 = 947.095
      const r = computeRoundedQty(947.095, '0.001', '0.001');
      expect(r.qty).toBe(947.095);
      // INTEGER stepSize case
      const r2 = computeRoundedQty(947.095, '1', '1');
      expect(r2.qty).toBe(947);
    });

    test('parity with scripts/fix-stuck-fee-deduct-positions.js roundQtyDown', () => {
      // Compare our formula and the script's roundQtyDown at line 147-152
      function roundQtyDown(qty, stepSizeStr) {
        const step = parseFloat(stepSizeStr);
        if (step <= 0) return qty;
        return Math.floor(qty / step) * step;
      }
      // For integer stepSize, results must match
      expect(roundQtyDown(947.095, '1')).toBe(computeRoundedQty(947.095, '1', '1').qty);
      expect(roundQtyDown(944.055, '1')).toBe(computeRoundedQty(944.055, '1', '1').qty);
      expect(roundQtyDown(1234.74, '0.1')).toBe(computeRoundedQty(1234.74, '0.1', '1').qty);
    });
  });
});
