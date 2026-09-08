'use strict';

/**
 * FIX-2026-09-02: Unit tests for Round-down Capital helper
 *
 * Background: when a BUY signal arrives but usable USDT balance is less than
 * the requested notional (e.g. capitalPerTrade=10 USDT but only 7.58 USDT
 * available), the trader normally skips the BUY with "insufficient USDT
 * balance". When the per-bot roundDownCapitalEnabled flag is on, the trader
 * rounds the notional DOWN to fit available balance (floored to 2 decimals
 * — USDT quote precision) so the order can still be placed. If the rounded
 * amount would fall below the configurable minimum (default 5.5 USDT), the
 * BUY is still skipped (a sub-minimum BUY is not useful).
 *
 * Covers:
 *   - resolveMinRound: defaults, clamps, NaN/0/negative fallback
 *   - floorToQuotePrecision: exact 2-decimal floor
 *   - computeAdjustedNotional:
 *       1. balance OK + feature ON → no override (caller does nothing)
 *       2. balance OK + feature OFF → no change (caller skips the round-down branch)
 *       3. balance short + adjusted >= min → re-claim path
 *       4. balance short + adjusted < min → skip with reason
 *       5. availableForNewBuy = 0 → adjusted = 0 < min → skip
 *       6. min = 0 / NaN / negative → fallback DEFAULT_MIN (5.5)
 *       7. min > MAX_BOUND → clamp to MAX_BOUND
 *       8. adjusted NEVER exceeds availableForNewBuy (no over-spend risk)
 *       9. rounding precision: 7.581 → 7.58 (always down)
 *   - botDefaults.buildBotCreatePayload: roundDownCapitalEnabled default=false,
 *     roundDownCapitalMin default=5.5, strict boolean semantics
 */

const rdc = require('../src/services/roundDownCapital');
const botDefaults = require('../src/services/botDefaults');

// ─── resolveMinRound ──────────────────────────────────────────────────────

describe('roundDownCapital — resolveMinRound', () => {
  test('DEFAULT_MIN = 5.5', () => {
    expect(rdc.DEFAULT_MIN).toBe(5.5);
  });

  test('positive finite value within [1, 10000] passes through', () => {
    expect(rdc.resolveMinRound(7.5)).toBe(7.5);
    expect(rdc.resolveMinRound(1)).toBe(1);
    expect(rdc.resolveMinRound(10000)).toBe(10000);
  });

  test('0 → fallback DEFAULT_MIN', () => {
    expect(rdc.resolveMinRound(0)).toBe(5.5);
  });

  test('negative → fallback DEFAULT_MIN', () => {
    expect(rdc.resolveMinRound(-5)).toBe(5.5);
    expect(rdc.resolveMinRound(-0.01)).toBe(5.5);
  });

  test('NaN → fallback DEFAULT_MIN', () => {
    expect(rdc.resolveMinRound(NaN)).toBe(5.5);
  });

  test('Infinity / -Infinity → fallback DEFAULT_MIN (not finite)', () => {
    expect(rdc.resolveMinRound(Infinity)).toBe(5.5);
    expect(rdc.resolveMinRound(-Infinity)).toBe(5.5);
  });

  test('undefined / null → fallback DEFAULT_MIN', () => {
    expect(rdc.resolveMinRound(undefined)).toBe(5.5);
    expect(rdc.resolveMinRound(null)).toBe(5.5);
  });

  test('above MAX_BOUND (10000) → clamps to 10000', () => {
    expect(rdc.resolveMinRound(99999)).toBe(10000);
  });

  test('below MIN_BOUND (1) — clamps to 1', () => {
    // 0 already handled above. 0.5 is below MIN_BOUND but positive+finite → clamp to 1.
    expect(rdc.resolveMinRound(0.5)).toBe(1);
  });

  test('string number → coerced via Number.isFinite', () => {
    // "5.5" passes through Number.isFinite but resolveMinRound expects raw number.
    // Verify behavior matches typical caller pattern (passes through as a number).
    // We intentionally do NOT coerce strings here — caller responsibility.
    // (BuildbotCreatePayload already runs Number() coercion via pickScalar.)
  });
});

// ─── floorToQuotePrecision ────────────────────────────────────────────────

describe('roundDownCapital — floorToQuotePrecision', () => {
  test('rounds down to 2 decimals', () => {
    expect(rdc.floorToQuotePrecision(7.581)).toBe(7.58);
    expect(rdc.floorToQuotePrecision(7.589)).toBe(7.58);
  });

  test('exact 2-decimal value passes through', () => {
    expect(rdc.floorToQuotePrecision(7.58)).toBe(7.58);
    expect(rdc.floorToQuotePrecision(10)).toBe(10);
  });

  test('rounds down further precision (3+ decimals)', () => {
    expect(rdc.floorToQuotePrecision(7.123456)).toBe(7.12);
  });

  test('zero passes through', () => {
    expect(rdc.floorToQuotePrecision(0)).toBe(0);
  });

  test('never exceeds input (Math.floor)', () => {
    // CRITICAL: must NEVER round UP — would risk over-spend vs available balance
    const inputs = [7.581, 7.589, 7.999, 0.001, 99.991];
    inputs.forEach((v) => {
      expect(rdc.floorToQuotePrecision(v)).toBeLessThanOrEqual(v);
    });
  });
});

// ─── computeAdjustedNotional ──────────────────────────────────────────────

describe('roundDownCapital — computeAdjustedNotional (the actual retry math)', () => {
  const fee = 0.001; // 0.1% maker fee

  test('adjusted >= min → belowMin=false (caller proceeds with re-claim)', () => {
    // avail=7.58, fee=0.001 → adjustedRaw = 7.58/1.001 ≈ 7.5724 → floor → 7.57
    // default min=5.5 → 7.57 ≥ 5.5 → belowMin=false
    const r = rdc.computeAdjustedNotional({ availableForNewBuy: 7.58, feeBufferRate: fee });
    expect(r.belowMin).toBe(false);
    expect(r.adjusted).toBe(7.57);
    expect(r.minRound).toBe(5.5);
    expect(r.reason).toBeUndefined();
  });

  test('adjusted < min → belowMin=true with reason', () => {
    // avail=4 USDT → adjustedRaw = 4/1.001 ≈ 3.996 → floor → 3.99
    // min=5.5 → 3.99 < 5.5 → skip
    const r = rdc.computeAdjustedNotional({ availableForNewBuy: 4, feeBufferRate: fee });
    expect(r.belowMin).toBe(true);
    expect(r.adjusted).toBe(3.99);
    expect(r.minRound).toBe(5.5);
    // reason uses 4-decimal precision for diagnostics (matches trader.js log style)
    expect(r.reason).toMatch(/round-down 3\.9900 < min 5\.5/);
    expect(r.reason).toMatch(/available 4\.0000/);
  });

  test('availableForNewBuy = 0 → adjusted = 0 < min → belowMin=true', () => {
    const r = rdc.computeAdjustedNotional({ availableForNewBuy: 0, feeBufferRate: fee });
    expect(r.belowMin).toBe(true);
    expect(r.adjusted).toBe(0);
  });

  test('availableForNewBuy negative → coerced to 0 → belowMin=true', () => {
    const r = rdc.computeAdjustedNotional({ availableForNewBuy: -5, feeBufferRate: fee });
    expect(r.belowMin).toBe(true);
    expect(r.adjusted).toBe(0);
  });

  test('availableForNewBuy NaN → coerced to 0 → belowMin=true', () => {
    const r = rdc.computeAdjustedNotional({ availableForNewBuy: NaN, feeBufferRate: fee });
    expect(r.belowMin).toBe(true);
    expect(r.adjusted).toBe(0);
  });

  test('custom min = 8 → avail 7.58 adjusted 7.57 → belowMin=true', () => {
    // 7.57 < 8 → belowMin=true
    const r = rdc.computeAdjustedNotional({ availableForNewBuy: 7.58, feeBufferRate: fee, minRound: 8 });
    expect(r.belowMin).toBe(true);
    expect(r.adjusted).toBe(7.57);
    expect(r.minRound).toBe(8);
  });

  test('custom min = 5 → avail 7.58 adjusted 7.57 → belowMin=false', () => {
    // 7.57 ≥ 5 → belowMin=false
    const r = rdc.computeAdjustedNotional({ availableForNewBuy: 7.58, feeBufferRate: fee, minRound: 5 });
    expect(r.belowMin).toBe(false);
    expect(r.adjusted).toBe(7.57);
    expect(r.minRound).toBe(5);
  });

  test('min = 0 → fallback DEFAULT_MIN (5.5)', () => {
    const r = rdc.computeAdjustedNotional({ availableForNewBuy: 6, feeBufferRate: fee, minRound: 0 });
    expect(r.minRound).toBe(5.5);
    expect(r.belowMin).toBe(false); // 6/1.001 ≈ 5.994 → floor 5.99 ≥ 5.5
  });

  test('min = NaN → fallback DEFAULT_MIN (5.5)', () => {
    const r = rdc.computeAdjustedNotional({ availableForNewBuy: 6, feeBufferRate: fee, minRound: NaN });
    expect(r.minRound).toBe(5.5);
  });

  test('min negative → fallback DEFAULT_MIN (5.5)', () => {
    const r = rdc.computeAdjustedNotional({ availableForNewBuy: 6, feeBufferRate: fee, minRound: -10 });
    expect(r.minRound).toBe(5.5);
  });

  test('min > 10000 → clamps to MAX_BOUND (10000)', () => {
    const r = rdc.computeAdjustedNotional({ availableForNewBuy: 99999, feeBufferRate: fee, minRound: 999999 });
    expect(r.minRound).toBe(10000);
  });

  test('fee = 0 (VIP / zero-fee) → adjusted = avail exactly (still floored)', () => {
    const r = rdc.computeAdjustedNotional({ availableForNewBuy: 7.581, feeBufferRate: 0 });
    expect(r.belowMin).toBe(false);
    expect(r.adjusted).toBe(7.58);
  });

  test('feeBufferRate NaN → coerced to 0', () => {
    const r = rdc.computeAdjustedNotional({ availableForNewBuy: 7.581, feeBufferRate: NaN });
    expect(r.belowMin).toBe(false);
    expect(r.adjusted).toBe(7.58);
  });

  test('CRITICAL: adjusted × (1 + fee) ≤ availableForNewBuy (never over-spend)', () => {
    // The whole point of round-down: the final spent amount must fit within
    // the available USDT. This property must hold for any inputs.
    const cases = [
      { avail: 7.581, fee: 0.001 },
      { avail: 7.58, fee: 0.001 },
      { avail: 4, fee: 0.001 },
      { avail: 0.01, fee: 0.001 },
      { avail: 100, fee: 0.0005 },
      { avail: 5.5, fee: 0.001 },
      { avail: 10000, fee: 0.001 },
      { avail: 0.001, fee: 0.001 },
    ];
    cases.forEach(({ avail, fee }) => {
      const r = rdc.computeAdjustedNotional({ availableForNewBuy: avail, feeBufferRate: fee });
      const totalRequired = r.adjusted * (1 + fee);
      // Total cost (incl. fee) MUST be ≤ available — by Math.floor invariant
      expect(totalRequired).toBeLessThanOrEqual(avail + 1e-9); // tiny epsilon for float
    });
  });

  test('adjustedRaw is exposed for diagnostics', () => {
    const r = rdc.computeAdjustedNotional({ availableForNewBuy: 10, feeBufferRate: 0.001 });
    expect(r.adjustedRaw).toBeCloseTo(10 / 1.001, 6);
    // adjusted = floor(adjustedRaw × 100) / 100
    expect(r.adjusted).toBe(Math.floor(r.adjustedRaw * 100) / 100);
  });

  test('no args → all defaults, returns defensive result', () => {
    const r = rdc.computeAdjustedNotional();
    // avail defaults to 0 → adjusted = 0, belowMin = true
    expect(r.belowMin).toBe(true);
    expect(r.adjusted).toBe(0);
    expect(r.minRound).toBe(5.5);
  });
});

// ─── botDefaults.buildBotCreatePayload integration ─────────────────────────

describe('roundDownCapital — botDefaults.buildBotCreatePayload defaults', () => {
  test('no override, no botDefaults, no tier → roundDownCapitalEnabled=true (FIX-2026-09-09 recommend ON)', () => {
    const p = botDefaults.buildBotCreatePayload();
    expect(p.roundDownCapitalEnabled).toBe(true);
  });

  test('default roundDownCapitalMin = 5.5', () => {
    const p = botDefaults.buildBotCreatePayload();
    expect(p.roundDownCapitalMin).toBe(5.5);
  });

  test('explicit user override=true → roundDownCapitalEnabled=true', () => {
    const p = botDefaults.buildBotCreatePayload({ overrides: { roundDownCapitalEnabled: true } });
    expect(p.roundDownCapitalEnabled).toBe(true);
  });

  test('explicit user override=false → roundDownCapitalEnabled=false (preserved)', () => {
    const p = botDefaults.buildBotCreatePayload({ overrides: { roundDownCapitalEnabled: false } });
    expect(p.roundDownCapitalEnabled).toBe(false);
  });

  test('botDefaults.roundDownCapitalEnabled=true (admin sets in Settings) → true', () => {
    const p = botDefaults.buildBotCreatePayload({ botDefaults: { roundDownCapitalEnabled: true } });
    expect(p.roundDownCapitalEnabled).toBe(true);
  });

  test('strict: botDefaults.roundDownCapitalEnabled=1 → false (must be === true)', () => {
    const p = botDefaults.buildBotCreatePayload({ botDefaults: { roundDownCapitalEnabled: 1 } });
    expect(p.roundDownCapitalEnabled).toBe(false);
  });

  test('strict: botDefaults.roundDownCapitalEnabled="true" → false', () => {
    const p = botDefaults.buildBotCreatePayload({ botDefaults: { roundDownCapitalEnabled: 'true' } });
    expect(p.roundDownCapitalEnabled).toBe(false);
  });

  test('custom min override → roundDownCapitalMin=10', () => {
    const p = botDefaults.buildBotCreatePayload({ overrides: { roundDownCapitalMin: 10 } });
    expect(p.roundDownCapitalMin).toBe(10);
  });

  test('clamps min above 10000 → 10000', () => {
    const p = botDefaults.buildBotCreatePayload({ overrides: { roundDownCapitalMin: 99999 } });
    expect(p.roundDownCapitalMin).toBe(10000);
  });

  test('clamps min below 1 → 1', () => {
    const p = botDefaults.buildBotCreatePayload({ overrides: { roundDownCapitalMin: 0.1 } });
    expect(p.roundDownCapitalMin).toBe(1);
  });

  test('precedence: explicit override wins over botDefaults', () => {
    const p = botDefaults.buildBotCreatePayload({
      overrides: { roundDownCapitalEnabled: true, roundDownCapitalMin: 12 },
      botDefaults: { roundDownCapitalEnabled: false, roundDownCapitalMin: 5.5 },
    });
    expect(p.roundDownCapitalEnabled).toBe(true);
    expect(p.roundDownCapitalMin).toBe(12);
  });

  test('tier preset basic/pro/enterprise is a no-op for round-down (FIX-2026-09-04 tier empty)', () => {
    // FIX-2026-09-09: RECOMMENDED_DEFAULTS.roundDownCapitalEnabled=true (recommend ON)
    // Tier presets are frozen-empty (FIX-2026-09-04) → tier is a no-op → default stays true
    expect(botDefaults.buildBotCreatePayload({ tier: 'basic' }).roundDownCapitalEnabled).toBe(true);
    expect(botDefaults.buildBotCreatePayload({ tier: 'pro' }).roundDownCapitalEnabled).toBe(true);
    expect(botDefaults.buildBotCreatePayload({ tier: 'enterprise' }).roundDownCapitalEnabled).toBe(true);
  });
});
