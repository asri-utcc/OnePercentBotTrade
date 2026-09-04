'use strict';

/**
 * FIX-2026-08-27 Phase 3b-1: tierTemplates tests
 * FIX-2026-09-04: REWORKED — tier templates are EMPTY (no default contribution).
 *
 * **User directive (2026-09-04):**
 *   "ลบ tier template ออกให้หมด ให้หมด user จะได้รับค่าเริ่มต้นจากบอทเหมือนๆกันทุกคน
 *    และแต่ละคนจะปรับแต่งการตั้งค่าเองโดยไม่มีการเข้ามาแทรกแซงจากแอกมิน
 *    นอกจากการจำกัดบางฟังชั่นที่ขึ้นอยู่กับข้อจำกัดการใช้งานของแต่ละ tier"
 *
 * Tier now restricts ONLY features (licenseService.isFeatureEnabled) + maxBots/maxCapital.
 * NO default-value contribution. All bots get same fallback → botDefaults → overrides.
 *
 * Verifies:
 *   - TIER_PRESETS is frozen + all 3 tiers present
 *   - All 3 tier presets are EMPTY (no keys)
 *   - getTierPreset() returns empty preset for known tier
 *   - mergeTierWithDefaults returns botDefaults unchanged (tier contributes nothing)
 *   - buildBotCreatePayload ignores tier — same result for tier=null/basic/pro/enterprise
 *   - User override > botDefaults > fallback (unchanged from previous behavior)
 */

const {
  TIER_PRESETS,
  getTierPreset,
  listTiers,
  mergeTierWithDefaults,
} = require('../src/services/tierTemplates');
const { buildBotCreatePayload } = require('../src/services/botDefaults');

describe('tierTemplates — TIER_PRESETS structure (FIX-2026-09-04: empty presets)', () => {
  test('all 3 tiers present', () => {
    expect(Object.keys(TIER_PRESETS).sort()).toEqual(['basic', 'enterprise', 'pro']);
  });

  test('TIER_PRESETS is frozen (top-level + nested)', () => {
    expect(Object.isFrozen(TIER_PRESETS)).toBe(true);
    expect(Object.isFrozen(TIER_PRESETS.basic)).toBe(true);
    expect(Object.isFrozen(TIER_PRESETS.pro)).toBe(true);
    expect(Object.isFrozen(TIER_PRESETS.enterprise)).toBe(true);
  });

  test('all tier presets are EMPTY (FIX-2026-09-04 user directive)', () => {
    // User: "ลบ tier template ออกให้หมด ให้หมด user จะได้รับค่าเริ่มต้นจากบอทเหมือนๆกันทุกคน"
    expect(Object.keys(TIER_PRESETS.basic)).toEqual([]);
    expect(Object.keys(TIER_PRESETS.pro)).toEqual([]);
    expect(Object.keys(TIER_PRESETS.enterprise)).toEqual([]);
  });

  test('NO safety/feature/size defaults in any tier preset (FIX-2026-09-04)', () => {
    // Comprehensive: nothing admin-set should leak into bot defaults via tier.
    // Tier only restricts features (licenseService) — not bot values.
    const forbiddenAny = [
      // safety toggles
      'cbv5Enabled', 'cbv3Enabled', 'cbv2Enabled', 'cbAutoUnlockEnabled',
      'safeTradeTrendlineEnabled', 'safeTradeNoTradeEnabled',
      'dcaEnabled', 'martingaleEnabled',
      // automation toggles
      'dynamicSizeEnabled', 'autoArmStopLossOnUKC', 'autoUpdateTp',
      'stopLossOnUpperKC', 'xs1Enabled', 'tpTrendEnabled',
      // size/limit defaults (was tier-progressive before, now removed)
      'capitalPerTrade', 'maxTrades', 'tpPercent', 'retryMax', 'retryTimeMin',
      // numeric hints (was kept briefly in round 3, now removed too)
      'cbv5LockHours', 'cbv3LockHours', 'cbAutoUnlockThresholdPct',
    ];
    ['basic', 'pro', 'enterprise'].forEach(t => {
      forbiddenAny.forEach(f => {
        expect(TIER_PRESETS[t][f]).toBeUndefined();
      });
    });
  });
});

describe('tierTemplates — getTierPreset()', () => {
  test('returns empty frozen object for basic/pro/enterprise', () => {
    expect(getTierPreset('basic')).toEqual({});
    expect(getTierPreset('pro')).toEqual({});
    expect(getTierPreset('enterprise')).toEqual({});
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
  test('returns array of 3 tier names', () => {
    const tiers = listTiers();
    expect(tiers).toEqual(['basic', 'pro', 'enterprise']);
  });
});

describe('tierTemplates — mergeTierWithDefaults() (FIX-2026-09-04: tier is no-op)', () => {
  test('tier=null → botDefaults passes through unchanged', () => {
    const merged = mergeTierWithDefaults({ kcMult: 2.5, capitalPerTrade: 9 }, null);
    expect(merged).toEqual({ kcMult: 2.5, capitalPerTrade: 9 });
  });

  test('tier=basic → botDefaults passes through unchanged (FIX-2026-09-04)', () => {
    const merged = mergeTierWithDefaults({ capitalPerTrade: 7 }, 'basic');
    expect(merged.capitalPerTrade).toBe(7); // tier contributes nothing
  });

  test('tier=pro → botDefaults passes through unchanged (FIX-2026-09-04)', () => {
    const merged = mergeTierWithDefaults({ kcMult: 2.5 }, 'pro');
    expect(merged.kcMult).toBe(2.5);
    expect(merged.capitalPerTrade).toBeUndefined(); // not injected
  });

  test('tier=enterprise → botDefaults passes through unchanged (FIX-2026-09-04)', () => {
    const merged = mergeTierWithDefaults({ capitalPerTrade: 25, maxTrades: 20 }, 'enterprise');
    expect(merged).toEqual({ capitalPerTrade: 25, maxTrades: 20 });
  });

  test('empty botDefaults + any tier → still empty', () => {
    expect(mergeTierWithDefaults({}, 'basic')).toEqual({});
    expect(mergeTierWithDefaults({}, 'pro')).toEqual({});
    expect(mergeTierWithDefaults({}, 'enterprise')).toEqual({});
  });

  test('does not mutate inputs', () => {
    const bd = { capitalPerTrade: 7 };
    const merged = mergeTierWithDefaults(bd, 'enterprise');
    expect(bd.capitalPerTrade).toBe(7);
    expect(merged).toEqual({ capitalPerTrade: 7 });
  });

  test('tier=unknown → botDefaults passes through (no error)', () => {
    const merged = mergeTierWithDefaults({ capitalPerTrade: 12 }, 'platinum');
    expect(merged).toEqual({ capitalPerTrade: 12 });
  });
});

describe('buildBotCreatePayload — tier is a no-op (FIX-2026-09-04)', () => {
  // CRITICAL: all tiers must produce IDENTICAL results when only tier differs.
  // This is the regression guard against silent admin interference.

  test('tier=null/basic/pro/enterprise → IDENTICAL capitalPerTrade (fallback)', () => {
    const fb = { capitalPerTrade: 99 };
    const a = buildBotCreatePayload({ tier: null, fallbacks: fb });
    const b = buildBotCreatePayload({ tier: 'basic', fallbacks: fb });
    const c = buildBotCreatePayload({ tier: 'pro', fallbacks: fb });
    const d = buildBotCreatePayload({ tier: 'enterprise', fallbacks: fb });
    expect(a.capitalPerTrade).toBe(99);
    expect(b.capitalPerTrade).toBe(99);
    expect(c.capitalPerTrade).toBe(99);
    expect(d.capitalPerTrade).toBe(99);
  });

  test('tier=null/basic/pro/enterprise → IDENTICAL maxTrades (fallback)', () => {
    const fb = { maxTrades: 7 };
    ['basic', 'pro', 'enterprise', null].forEach(t => {
      const p = buildBotCreatePayload({ tier: t, fallbacks: fb });
      expect(p.maxTrades).toBe(7);
    });
  });

  test('tier does not affect kcMult', () => {
    const botDefaults = { kcMult: 2.7 };
    const fb = { kcMult: 1.5 };
    ['basic', 'pro', 'enterprise'].forEach(t => {
      const p = buildBotCreatePayload({ tier: t, botDefaults, fallbacks: fb });
      expect(p.kcMult).toBe(2.7); // botDefaults wins, tier contributes nothing
    });
  });

  test('user override still wins (unchanged precedence)', () => {
    const p = buildBotCreatePayload({
      overrides: { capitalPerTrade: 100 },
      tier: 'enterprise', // would have given 25 in old design
      fallbacks: { capitalPerTrade: 99 },
    });
    expect(p.capitalPerTrade).toBe(100); // user override wins
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
    // Regression guard: 28 (New Beta) bots had cbEnabled=false but cbv3Enabled=true.
    const safetyFlags = [
      'cbv5Enabled', 'cbv3Enabled', 'cbv2Enabled', 'cbAutoUnlockEnabled',
    ];
    ['basic', 'pro', 'enterprise'].forEach(t => {
      const p = buildBotCreatePayload({ tier: t, fallbacks: {} });
      safetyFlags.forEach(f => {
        expect(p[f]).toBe(false);
      });
    });
  });

  test('cbv*LockHours are NOT tier-influenced (FIX-2026-09-04)', () => {
    // Previously cbv5LockHours was tier-progressive (8/4/2). Now all from botDefaults (user Settings)
    // or hardcoded fallback inside pickScalar — tier contributes nothing.
    const botDefaults = { cbv5LockHours: 6, cbv3LockHours: 7 };
    ['basic', 'pro', 'enterprise'].forEach(t => {
      const p = buildBotCreatePayload({ tier: t, botDefaults, fallbacks: {} });
      expect(p.cbv5LockHours).toBe(6);
      expect(p.cbv3LockHours).toBe(7);
    });
  });

  test('all tiers with no overrides/botDefaults/fallbacks → identical default bot', () => {
    // This is the headline test: every bot starts the same way regardless of tier.
    const a = buildBotCreatePayload({ tier: 'basic', fallbacks: {} });
    const b = buildBotCreatePayload({ tier: 'pro', fallbacks: {} });
    const c = buildBotCreatePayload({ tier: 'enterprise', fallbacks: {} });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});
