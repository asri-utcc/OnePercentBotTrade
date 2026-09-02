'use strict';

/**
 * FIX-2026-08-09: Unit tests for botDefaults helper
 *
 * Background: regression guard for the autoAddBot-vs-manual defaults drift bug
 * (1000CAT(bAdd) was created with hardcoded values, ignoring Settings → Bot Defaults).
 *
 * These tests verify buildBotCreatePayload() honors the 3-tier precedence:
 *   overrides (user/scan) > botDefaults (Settings) > fallback (config.defaults)
 *
 * Boolean semantics:
 *   - "ON by default" fields use lenient (anything !== false → true)
 *   - "OFF by default" fields use strict (must be === true to enable)
 *   - explicit `false` must always pass through (not treated as undefined)
 */

const {
  pickValue,
  pickBool,
  pickScalar,
  pickInt,
  buildBotCreatePayload,
  getBotDefaultsFromDoc,
} = require('../src/services/botDefaults');

describe('botDefaults — pickValue (basic precedence)', () => {
  test('override wins when present', () => {
    expect(pickValue({ x: 1 }, { x: 2 }, 'x', 3)).toBe(1);
  });
  test('botDefaults used when no override', () => {
    expect(pickValue({}, { x: 2 }, 'x', 3)).toBe(2);
  });
  test('fallback used when neither set', () => {
    expect(pickValue({}, {}, 'x', 3)).toBe(3);
  });
  test('override=null passes through (only undefined is treated as "missing")', () => {
    // pickValue uses !== undefined (not != null), so explicit null is preserved
    // (callers that want null-skipping should use pickScalar which uses == null)
    expect(pickValue({ x: null }, { x: 2 }, 'x', 3)).toBe(null);
  });
  test('override=undefined is treated as missing → botDefaults used', () => {
    expect(pickValue({ x: undefined }, { x: 2 }, 'x', 3)).toBe(2);
  });
});

describe('botDefaults — pickBool (lenient vs strict)', () => {
  test('lenient: explicit false → false', () => {
    expect(pickBool({ xs1Enabled: false }, {}, 'xs1Enabled', true)).toBe(false);
  });
  test('lenient: undefined + botDefaults true → true', () => {
    expect(pickBool({}, { xs1Enabled: true }, 'xs1Enabled', false)).toBe(true);
  });
  test('lenient: undefined + botDefaults false → false', () => {
    expect(pickBool({}, { xs1Enabled: false }, 'xs1Enabled', true)).toBe(false);
  });
  test('lenient: truthy values count as true (1, "1", "true", true)', () => {
    expect(pickBool({ xs1Enabled: 1 }, {}, 'xs1Enabled', false)).toBe(true);
    expect(pickBool({ xs1Enabled: '1' }, {}, 'xs1Enabled', false)).toBe(true);
    expect(pickBool({ xs1Enabled: 'true' }, {}, 'xs1Enabled', false)).toBe(true);
  });
  test('strict: explicit true → true', () => {
    expect(pickBool({ dcaEnabled: true }, {}, 'dcaEnabled', false, { strict: true })).toBe(true);
  });
  test('strict: truthy non-true values are still false (1, "true")', () => {
    expect(pickBool({ dcaEnabled: 1 }, {}, 'dcaEnabled', false, { strict: true })).toBe(false);
    expect(pickBool({ dcaEnabled: 'true' }, {}, 'dcaEnabled', false, { strict: true })).toBe(false);
  });
  test('strict: undefined + botDefaults true → true', () => {
    expect(pickBool({}, { dcaEnabled: true }, 'dcaEnabled', false, { strict: true })).toBe(true);
  });
  test('strict: fallback wins when nothing set', () => {
    expect(pickBool({}, {}, 'dcaEnabled', false, { strict: true })).toBe(false);
  });
});

describe('botDefaults — pickScalar (numeric + clamp)', () => {
  test('parses override as float', () => {
    expect(pickScalar({ kcMult: '1.7' }, {}, 'kcMult', 1.5)).toBe(1.7);
  });
  test('clamps override above max', () => {
    expect(pickScalar({ kcMult: 10 }, {}, 'kcMult', 1.5, { clamp: [0.5, 5] })).toBe(5);
  });
  test('clamps override below min', () => {
    expect(pickScalar({ kcMult: 0.1 }, {}, 'kcMult', 1.5, { clamp: [0.5, 5] })).toBe(0.5);
  });
  test('uses botDefaults when no override', () => {
    expect(pickScalar({}, { kcMult: 1.2 }, 'kcMult', 1.5)).toBe(1.2);
  });
  test('uses fallback when nothing set', () => {
    expect(pickScalar({}, {}, 'kcMult', 1.5)).toBe(1.5);
  });
  test('int mode parses + clamps as integer', () => {
    expect(pickScalar({ maxTrades: 5.7 }, {}, 'maxTrades', 1, { int: true })).toBe(5);
    expect(pickScalar({ maxTrades: 1000 }, {}, 'maxTrades', 1, { clamp: [1, 100], int: true })).toBe(100);
  });
  test('returns null when fallback is null and no override', () => {
    expect(pickScalar({}, {}, 'x', null)).toBe(null);
  });
  // FIX-2026-08-10: 24h vol guard for Auto Pause-Resume (clamp [0, 1e9])
  test('autoPauseMin24hVolUsdt default = 1_000_000', () => {
    expect(pickScalar({}, {}, 'autoPauseMin24hVolUsdt', 1_000_000)).toBe(1_000_000);
  });
  test('autoPauseMin24hVolUsdt clamps above max (1e9)', () => {
    expect(pickScalar({ autoPauseMin24hVolUsdt: 5e9 }, {}, 'autoPauseMin24hVolUsdt', 1_000_000, { clamp: [0, 1_000_000_000] })).toBe(1_000_000_000);
  });
  test('autoPauseMin24hVolUsdt clamps below min (0)', () => {
    expect(pickScalar({ autoPauseMin24hVolUsdt: -100 }, {}, 'autoPauseMin24hVolUsdt', 1_000_000, { clamp: [0, 1_000_000_000] })).toBe(0);
  });
  test('autoPauseMin24hVolUsdt accepts override within range', () => {
    expect(pickScalar({ autoPauseMin24hVolUsdt: 5_000_000 }, {}, 'autoPauseMin24hVolUsdt', 1_000_000, { clamp: [0, 1_000_000_000] })).toBe(5_000_000);
  });
});

describe('botDefaults — buildBotCreatePayload (full integration)', () => {
  // 1. No overrides, no botDefaults → falls back to hardcoded defaults
  test('pure fallback when nothing set', () => {
    const p = buildBotCreatePayload();
    expect(p.symbol).toBe('');
    expect(p.timeframe).toBe('5m');
    expect(p.capitalPerTrade).toBe(9);
    expect(p.maxTrades).toBe(1);
    expect(p.kcMult).toBe(1.5); // hardcoded fallback
    expect(p.xs1Enabled).toBe(true); // lenient default ON
    expect(p.dcaEnabled).toBe(false); // strict default OFF
    expect(p.tpTrendEnabled).toBe(true);
    expect(p.tpTrendMultiplier).toBe(2);
  });

  // 2. botDefaults only (Settings) — user เปลี่ยน capitalPerTrade ใน Settings
  test('user Settings: capitalPerTrade=12, kcMult=1.7, tpTrendEnabled=false', () => {
    const botDefaults = {
      capitalPerTrade: 12,
      kcMult: 1.7,
      tpTrendEnabled: false,
      tpTrendMultiplier: 3,
    };
    const p = buildBotCreatePayload({ botDefaults, fallbacks: { symbol: 'BNBUSDT', timeframe: '3m' } });
    expect(p.capitalPerTrade).toBe(12);
    expect(p.kcMult).toBe(1.7);
    expect(p.tpTrendEnabled).toBe(false);
    expect(p.tpTrendMultiplier).toBe(3);
  });

  // 3. user override wins (manual POST sends explicit value)
  test('user override wins over Settings default', () => {
    const botDefaults = { capitalPerTrade: 12, kcMult: 1.7 };
    const p = buildBotCreatePayload({
      overrides: { capitalPerTrade: 25 },
      botDefaults,
    });
    expect(p.capitalPerTrade).toBe(25);
    expect(p.kcMult).toBe(1.7); // from botDefaults (no override)
  });

  // 4. explicit false passes through for "ON by default" fields (lenient)
  test('explicit false on xs1Enabled (ON default) is preserved', () => {
    const p = buildBotCreatePayload({ overrides: { xs1Enabled: false } });
    expect(p.xs1Enabled).toBe(false);
  });

  // 5. explicit true required for "OFF by default" fields (strict)
  test('explicit true on dcaEnabled (OFF default) is preserved', () => {
    const p = buildBotCreatePayload({ overrides: { dcaEnabled: true } });
    expect(p.dcaEnabled).toBe(true);
  });
  test('non-true value on dcaEnabled (strict) → false', () => {
    const p = buildBotCreatePayload({ overrides: { dcaEnabled: 1 } });
    expect(p.dcaEnabled).toBe(false);
  });
  test('non-true value on safeTradeTrendlineEnabled (strict) → false', () => {
    const p = buildBotCreatePayload({ overrides: { safeTradeTrendlineEnabled: 'true' } });
    expect(p.safeTradeTrendlineEnabled).toBe(false);
  });

  // 6. clamping
  test('clamps kcMult above max (5)', () => {
    const p = buildBotCreatePayload({ overrides: { kcMult: 100 } });
    expect(p.kcMult).toBe(5);
  });
  test('clamps cbv2LockHours above max (168)', () => {
    const p = buildBotCreatePayload({ overrides: { cbv2LockHours: 9999 } });
    expect(p.cbv2LockHours).toBe(168);
  });
  test('clamps martingaleMultiplier to [1, 3]', () => {
    const p = buildBotCreatePayload({ overrides: { martingaleMultiplier: 10 } });
    expect(p.martingaleMultiplier).toBe(3);
  });
  test('clamps dcaMaxLayers as int in [1, 100]', () => {
    const p = buildBotCreatePayload({ overrides: { dcaMaxLayers: 200 } });
    expect(p.dcaMaxLayers).toBe(100);
  });

  // 7. symbol + timeframe
  test('symbol uppercase + timeframe from override', () => {
    const p = buildBotCreatePayload({ overrides: { symbol: 'btcusdt', timeframe: '15m' } });
    expect(p.symbol).toBe('BTCUSDT');
    expect(p.timeframe).toBe('15m');
  });
  test('symbol + timeframe fallback to botDefaults.defaultSymbol/defaultTimeframe', () => {
    const p = buildBotCreatePayload({ botDefaults: { defaultSymbol: 'BNBUSDT', defaultTimeframe: '3m' } });
    expect(p.symbol).toBe('BNBUSDT');
    expect(p.timeframe).toBe('3m');
  });
  test('name: override > "<symbol> <timeframe>"', () => {
    const a = buildBotCreatePayload({ overrides: { symbol: 'BTCUSDT', timeframe: '5m' } });
    expect(a.name).toBe('BTCUSDT 5m');
    const b = buildBotCreatePayload({ overrides: { symbol: 'BTCUSDT', name: 'MyBot' } });
    expect(b.name).toBe('MyBot');
  });

  // 8. autoAddBot scenario (the original bug)
  test('autoAddBot scenario: user Settings capitalPerTrade=12 applied to 1000CAT', () => {
    // This is the bug case: user เปลี่ยน capitalPerTrade ใน Settings เป็น 12
    // แต่ก่อนหน้านี้ autoAddBot ใช้ hardcode 9
    const botDefaults = { capitalPerTrade: 12, kcMult: 1.7, tpTrendMultiplier: 3 };
    const overrides = {
      name: '1000CAT(bAdd)',
      symbol: '1000CATUSDT',
      timeframe: '3m',
      tpPercent: 0.15,
    };
    const p = buildBotCreatePayload({ overrides, botDefaults });
    expect(p.symbol).toBe('1000CATUSDT');
    expect(p.timeframe).toBe('3m');
    expect(p.name).toBe('1000CAT(bAdd)');
    expect(p.tpPercent).toBe(0.15);
    expect(p.capitalPerTrade).toBe(12); // ← เคยเป็น 9 hardcode
    expect(p.kcMult).toBe(1.7); // ← เคยเป็น 1.2 hardcode
    expect(p.tpTrendMultiplier).toBe(3); // ← เคยเป็น 2 hardcode
  });
});

describe('botDefaults — getBotDefaultsFromDoc (sync helper for tests/admin)', () => {
  test('returns botDefaults object when present', () => {
    const cfg = { botDefaults: { capitalPerTrade: 12 } };
    expect(getBotDefaultsFromDoc(cfg)).toEqual({ capitalPerTrade: 12 });
  });
  test('returns empty object when missing', () => {
    expect(getBotDefaultsFromDoc({})).toEqual({});
    expect(getBotDefaultsFromDoc(null)).toEqual({});
    expect(getBotDefaultsFromDoc(undefined)).toEqual({});
  });
});

// FIX-2026-09-02: CBv5 default OFF — regression guard for fleet-wide invisible divergence
//   - 20 bots had cbEnabled=false but cbv5Enabled=true (created when user thought CB was off)
//   - User reported "OGUSDT" (was actually 0GUSDT/0G-New Beta) got force-closed by CBv5
//   - Fix: pickBool strict + fallback=false; CBv5 is opt-in
describe('botDefaults — CBv5 default OFF (FIX-2026-09-02)', () => {
  test('no override, no botDefaults, no tier → cbv5Enabled=false (was true)', () => {
    const p = buildBotCreatePayload({});
    expect(p.cbv5Enabled).toBe(false);
  });
  test('user has cbEnabled=false → cbv5Enabled also false (was: true)', () => {
    // Simulates the bug: user disables CB master but defaults sneak CBv5 on
    const p = buildBotCreatePayload({
      overrides: { cbEnabled: false },
      botDefaults: { cbEnabled: false },
    });
    expect(p.cbEnabled).toBe(false);
    expect(p.cbv5Enabled).toBe(false);
  });
  test('explicit override=true → cbv5Enabled=true (opt-in still works)', () => {
    const p = buildBotCreatePayload({ overrides: { cbv5Enabled: true } });
    expect(p.cbv5Enabled).toBe(true);
  });
  test('botDefaults.cbv5Enabled=true → cbv5Enabled=true (admin opt-in via Settings)', () => {
    const p = buildBotCreatePayload({ botDefaults: { cbv5Enabled: true } });
    expect(p.cbv5Enabled).toBe(true);
  });
  test('tier preset cbv5Enabled=true (basic/pro/ent) → cbv5Enabled=true (admin set paid tier)', () => {
    expect(buildBotCreatePayload({ tier: 'basic' }).cbv5Enabled).toBe(true);
    expect(buildBotCreatePayload({ tier: 'pro' }).cbv5Enabled).toBe(true);
    expect(buildBotCreatePayload({ tier: 'enterprise' }).cbv5Enabled).toBe(true);
  });
  test('strict: botDefaults.cbv5Enabled=1 → false (must be === true)', () => {
    const p = buildBotCreatePayload({ botDefaults: { cbv5Enabled: 1 } });
    expect(p.cbv5Enabled).toBe(false);
  });
  test('explicit override=false → cbv5Enabled=false', () => {
    const p = buildBotCreatePayload({ overrides: { cbv5Enabled: false } });
    expect(p.cbv5Enabled).toBe(false);
  });
  test('precedence: explicit user override=false wins over tier preset=true', () => {
    // Documented precedence (strongest first): overrides > tierPreset > botDefaults > fallback.
    // Even though pro tier preset sets cbv5Enabled=true, an explicit user override=false
    // still wins — explicit choice always beats implicit preset.
    const p = buildBotCreatePayload({ overrides: { cbv5Enabled: false }, tier: 'pro' });
    expect(p.cbv5Enabled).toBe(false);
  });
});
