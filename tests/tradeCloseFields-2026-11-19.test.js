'use strict';

/**
 * FIX-2026-11-19 refactor guard: the 7 sold-transition reset fields live in src/core/tradeCloseFields.js.
 *   - pins the exact field/value set (any change here changes every sell-finalize path)
 *   - pins that the 7 sites use the helper (no copy-paste drift)
 *   - pins that forceClose.markTradeSold does NOT reset (telegram "F1-armed SL-UKC" context depends on it)
 */

const fs = require('fs');
const { slArmPartialResetFields, SL_ARM_PARTIAL_RESET_KEYS } = require('../src/core/tradeCloseFields');

const read = (p) => fs.readFileSync(require.resolve(p), 'utf8');

test('helper returns exactly the historical reset values', () => {
  expect(slArmPartialResetFields()).toEqual({
    useStopLossOnUKC: false,
    autoArmedAt: null,
    autoArmLossPct: null,
    autoArmAgeHours: null,
    sellPartialDetectedAt: null,
    sellPartialLatchedAt: null,
    sellPartialLatchedReason: null,
  });
  expect(SL_ARM_PARTIAL_RESET_KEYS).toHaveLength(7);
});

test('helper returns a fresh object every call', () => {
  const a = slArmPartialResetFields();
  a.autoArmedAt = new Date();
  expect(slArmPartialResetFields().autoArmedAt).toBeNull();
});

test('sell-finalize sites use the helper (trader ×6, botManager ×1)', () => {
  const count = (src) => (src.match(/\.\.\.slArmPartialResetFields\(\)/g) || []).length;
  expect(count(read('../src/core/trader.js'))).toBe(6);
  expect(count(read('../src/core/botManager.js'))).toBe(1);
});

test('forceClose.markTradeSold keeps F1-arm fields (telegram sellFilled context)', () => {
  const src = read('../src/core/forceClose.js');
  expect(src).not.toMatch(/slArmPartialResetFields/);
});
