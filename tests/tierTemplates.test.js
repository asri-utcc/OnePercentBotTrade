'use strict';

/**
 * FIX-2026-08-27 Phase 3b-1: tierTemplates tests
 *
 * Verifies:
 *   - TIER_PRESETS is frozen (cannot be mutated at runtime)
 *   - All 3 tiers (basic/pro/enterprise) are present
 *   - getTierPreset() returns preset for known tier, empty for unknown/null
 *   - listTiers() returns sorted list
 *   - mergeTierWithDefaults merges with tier winning over botDefaults
 *   - buildBotCreatePayload honors tier → botDefaults → fallback
 *   - tier=null preserves old behavior (no preset contribution)
 */

const {
  TIER_PRESETS,
  getTierPreset,
  listTiers,
  mergeTierWithDefaults,
} = require('../src/services/tierTemplates');
const { buildBotCreatePayload } = require('../src/services/botDefaults');

describe('tierTemplates — TIER_PRESETS structure (FIX-2026-08-27)', () => {
  test('all 3 tiers present', () => {
    expect(Object.keys(TIER_PRESETS).sort()).toEqual(['basic', 'enterprise', 'pro']);
  });

  test('TIER_PRESETS is frozen (top-level + nested)', () => {
    expect(Object.isFrozen(TIER_PRESETS)).toBe(true);
    expect(Object.isFrozen(TIER_PRESETS.basic)).toBe(true);
    expect(Object.isFrozen(TIER_PRESETS.pro)).toBe(true);
    expect(Object.isFrozen(TIER_PRESETS.enterprise)).toBe(true);
  });

  test('every preset has the same set of keys (consistency check)', () => {
    const basicKeys = Object.keys(TIER_PRESETS.basic).sort();
    const proKeys = Object.keys(TIER_PRESETS.pro).sort();
    const entKeys = Object.keys(TIER_PRESETS.enterprise).sort();
    expect(proKeys).toEqual(basicKeys);
    expect(entKeys).toEqual(basicKeys);
  });

  test('basic has most conservative capitalPerTrade', () => {
    expect(TIER_PRESETS.basic.capitalPerTrade).toBeLessThan(TIER_PRESETS.pro.capitalPerTrade);
    expect(TIER_PRESETS.pro.capitalPerTrade).toBeLessThan(TIER_PRESETS.enterprise.capitalPerTrade);
  });

  test('basic has most conservative maxTrades', () => {
    expect(TIER_PRESETS.basic.maxTrades).toBeLessThan(TIER_PRESETS.pro.maxTrades);
    expect(TIER_PRESETS.pro.maxTrades).toBeLessThan(TIER_PRESETS.enterprise.maxTrades);
  });

  test('basic has lowest tpPercent', () => {
    expect(TIER_PRESETS.basic.tpPercent).toBeLessThan(TIER_PRESETS.pro.tpPercent);
    expect(TIER_PRESETS.pro.tpPercent).toBeLessThan(TIER_PRESETS.enterprise.tpPercent);
  });

  test('NO *Enabled safety/feature toggles in any tier preset (FIX-2026-09-04)', () => {
    // User directive: "ให้ผู้ใช้เป็นผู้ตั้ง ไม่ผูกกับ preset tier ใดๆ"
    // Tier presets must not silently enable ANY safety/feature toggle.
    const forbidden = [
      'cbv5Enabled', 'cbv3Enabled', 'cbAutoUnlockEnabled',
      'dynamicSizeEnabled', 'autoArmStopLossOnUKC', 'autoUpdateTp',
      'dcaEnabled', 'martingaleEnabled',
      'safeTradeTrendlineEnabled', 'safeTradeNoTradeEnabled',
      'stopLossOnUpperKC', 'xs1Enabled', 'tpTrendEnabled',
    ];
    ['basic', 'pro', 'enterprise'].forEach(t => {
      forbidden.forEach(f => {
        expect(TIER_PRESETS[t][f]).toBeUndefined();
      });
    });
  });

  test('lock-hour + threshold hints remain (numeric only)', () => {
    expect(TIER_PRESETS.basic.cbv5LockHours).toBe(8);
    expect(TIER_PRESETS.basic.cbv3LockHours).toBe(8);
    expect(TIER_PRESETS.basic.cbAutoUnlockThresholdPct).toBe(1.0);
    expect(TIER_PRESETS.pro.cbv5LockHours).toBe(4);
    expect(TIER_PRESETS.pro.cbv3LockHours).toBe(8);
    expect(TIER_PRESETS.enterprise.cbv5LockHours).toBe(2);
    expect(TIER_PRESETS.enterprise.cbv3LockHours).toBe(4);
    expect(TIER_PRESETS.enterprise.cbAutoUnlockThresholdPct).toBe(0.8);
  });

  test('size/limit defaults still tier-progressive', () => {
    expect(TIER_PRESETS.basic.capitalPerTrade).toBeLessThan(TIER_PRESETS.pro.capitalPerTrade);
    expect(TIER_PRESETS.pro.capitalPerTrade).toBeLessThan(TIER_PRESETS.enterprise.capitalPerTrade);
    expect(TIER_PRESETS.basic.maxTrades).toBeLessThan(TIER_PRESETS.pro.maxTrades);
    expect(TIER_PRESETS.pro.maxTrades).toBeLessThan(TIER_PRESETS.enterprise.maxTrades);
    expect(TIER_PRESETS.basic.tpPercent).toBeLessThan(TIER_PRESETS.pro.tpPercent);
    expect(TIER_PRESETS.pro.tpPercent).toBeLessThan(TIER_PRESETS.enterprise.tpPercent);
  });
});

describe('tierTemplates — getTierPreset()', () => {
  test('returns basic preset for "basic"', () => {
    const p = getTierPreset('basic');
    expect(p.capitalPerTrade).toBe(TIER_PRESETS.basic.capitalPerTrade);
    expect(p).toBe(TIER_PRESETS.basic); // same reference
  });

  test('returns pro preset for "pro"', () => {
    expect(getTierPreset('pro')).toBe(TIER_PRESETS.pro);
  });

  test('returns enterprise preset for "enterprise"', () => {
    expect(getTierPreset('enterprise')).toBe(TIER_PRESETS.enterprise);
  });

  test('returns empty object for unknown tier', () => {
    expect(getTierPreset('platinum')).toEqual({});
    expect(getTierPreset('')).toEqual({});
    expect(getTierPreset('PRO')).toEqual({}); // case-sensitive
  });

  test('returns empty object for non-string', () => {
    expect(getTierPreset(null)).toEqual({});
    expect(getTierPreset(undefined)).toEqual({});
    expect(getTierPreset(42)).toEqual({});
    expect(getTierPreset({})).toEqual({});
  });
});

describe('tierTemplates — listTiers()', () => {
  test('returns array of tier names', () => {
    const tiers = listTiers();
    expect(Array.isArray(tiers)).toBe(true);
    expect(tiers).toContain('basic');
    expect(tiers).toContain('pro');
    expect(tiers).toContain('enterprise');
  });
});

describe('tierTemplates — mergeTierWithDefaults()', () => {
  test('tier wins over botDefaults', () => {
    const merged = mergeTierWithDefaults({ capitalPerTrade: 7 }, 'basic');
    expect(merged.capitalPerTrade).toBe(5); // basic preset wins
  });

  test('botDefaults used when tier does not set the field', () => {
    const merged = mergeTierWithDefaults({ kcMult: 2.5 }, 'basic');
    expect(merged.kcMult).toBe(2.5); // botDefaults value
    expect(merged.capitalPerTrade).toBe(5); // tier preset
  });

  test('null tier → botDefaults passes through unchanged', () => {
    const merged = mergeTierWithDefaults({ kcMult: 2.5, capitalPerTrade: 9 }, null);
    expect(merged).toEqual({ kcMult: 2.5, capitalPerTrade: 9 });
  });

  test('empty botDefaults → only tier values present', () => {
    const merged = mergeTierWithDefaults({}, 'pro');
    expect(merged.capitalPerTrade).toBe(TIER_PRESETS.pro.capitalPerTrade);
    expect(merged.maxTrades).toBe(TIER_PRESETS.pro.maxTrades);
  });

  test('does not mutate inputs', () => {
    const bd = { capitalPerTrade: 7 };
    const merged = mergeTierWithDefaults(bd, 'basic');
    expect(bd.capitalPerTrade).toBe(7); // original unchanged
    expect(merged.capitalPerTrade).toBe(5);
  });
});

describe('buildBotCreatePayload — tier integration (FIX-2026-08-27)', () => {
  test('tier=basic → small capitalPerTrade', () => {
    const p = buildBotCreatePayload({ tier: 'basic', fallbacks: { capitalPerTrade: 99 } });
    expect(p.capitalPerTrade).toBe(5);
  });

  test('tier=pro → medium capitalPerTrade', () => {
    const p = buildBotCreatePayload({ tier: 'pro', fallbacks: { capitalPerTrade: 99 } });
    expect(p.capitalPerTrade).toBe(10);
  });

  test('tier=enterprise → large capitalPerTrade', () => {
    const p = buildBotCreatePayload({ tier: 'enterprise', fallbacks: { capitalPerTrade: 99 } });
    expect(p.capitalPerTrade).toBe(25);
  });

  test('tier overrides botDefaults for the same field', () => {
    const p = buildBotCreatePayload({
      tier: 'pro',
      botDefaults: { capitalPerTrade: 50 }, // user override in Settings
      fallbacks: { capitalPerTrade: 99 },
    });
    // tier=pro preset (10) wins over botDefaults (50)
    expect(p.capitalPerTrade).toBe(10);
  });

  test('botDefaults used when tier does not set the field', () => {
    const p = buildBotCreatePayload({
      tier: 'basic',
      botDefaults: { kcMult: 2.7 }, // not in basic preset
      fallbacks: { kcMult: 1.5 },
    });
    expect(p.kcMult).toBe(2.7);
  });

  test('user override wins over tier', () => {
    const p = buildBotCreatePayload({
      overrides: { capitalPerTrade: 100 }, // user explicit
      tier: 'enterprise',                  // would give 25
      fallbacks: { capitalPerTrade: 99 },
    });
    expect(p.capitalPerTrade).toBe(100);
  });

  test('tier=null preserves old behavior (no tier contribution)', () => {
    const p = buildBotCreatePayload({
      tier: null,
      fallbacks: { capitalPerTrade: 99 },
    });
    expect(p.capitalPerTrade).toBe(99);
  });

  test('tier=unknown (not in TIER_PRESETS) treated as no tier', () => {
    const p = buildBotCreatePayload({
      tier: 'platinum',
      fallbacks: { capitalPerTrade: 99 },
    });
    expect(p.capitalPerTrade).toBe(99);
  });

  test('NO safety/feature *Enabled is true across all tiers (FIX-2026-09-04)', () => {
    // Regression guard for fleet-wide silent divergence: 28 (New Beta) bots had
    //   cbEnabled=false but cbv3Enabled=true → LISTA got hit today.
    // User directive: "ให้ผู้ใช้เป็นผู้ตั้ง ไม่ผูกกับ preset tier ใดๆ"
    // Circuit-breaker family only — verified by also testing buildBotCreatePayload:
    // - tier preset no longer contributes any *Enabled
    // - botDefaults uses strict + fallback=false for cbv3Enabled/cbv2Enabled/cbv5Enabled/cbAutoUnlockEnabled
    ['basic', 'pro', 'enterprise'].forEach(t => {
      const p = buildBotCreatePayload({ tier: t, fallbacks: {} });
      expect(p.cbv5Enabled).toBe(false);
      expect(p.cbv3Enabled).toBe(false);
      expect(p.cbv2Enabled).toBe(false);
      expect(p.cbAutoUnlockEnabled).toBe(false);
    });
  });

  test('basic tier keeps capitalPerTrade=5 even when botDefaults.capitalPerTrade differs', () => {
    // regression: explicit tier takes priority
    const p = buildBotCreatePayload({
      tier: 'basic',
      botDefaults: { capitalPerTrade: 50 },
      fallbacks: { capitalPerTrade: 9 },
    });
    expect(p.capitalPerTrade).toBe(5);
  });

  test('lock-hour hints flow from tier to botDefaults merge', () => {
    // Verify numeric hints still propagate (cbv5LockHours is NOT an *Enabled flag)
    const basic = buildBotCreatePayload({ tier: 'basic', fallbacks: {} });
    const pro = buildBotCreatePayload({ tier: 'pro', fallbacks: {} });
    const ent = buildBotCreatePayload({ tier: 'enterprise', fallbacks: {} });
    expect(basic.cbv5LockHours).toBe(8);
    expect(pro.cbv5LockHours).toBe(4);
    expect(ent.cbv5LockHours).toBe(2);
  });
});