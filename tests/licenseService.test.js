'use strict';

/**
 * FIX-2026-08-27 Phase 3a C2: License feature + capital helpers
 *
 *   Verifies:
 *   - isFeatureEnabled reflects license.features (telegram/autoReserve/cbv5)
 *   - Defaults: telegram=true, cbv5=true (legacy-safe), autoReserve=false
 *   - getMaxCapital: 0 when no license, number when set, Infinity when maxCapital===0 (every tier)
 *   - getTotalDeployedUsdt: sums capitalPerTrade*maxTrades, cached 30s
 *   - withinMaxCapital: false when over cap, true when under, true when unlimited
 *   - snapshot returns full status object
 *   - invalidateDeployedCache forces fresh read on next call
 */

jest.mock('../src/admin-monitor/licenseGate', () => ({
  lastLicense: null,
  lastValidatedAt: null,
}));
jest.mock('../src/db/models/Bot', () => ({
  find: jest.fn(),
}));
jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(), info: jest.fn(), error: jest.fn(),
  child: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }),
}));

const licenseGate = require('../src/admin-monitor/licenseGate');
const Bot = require('../src/db/models/Bot');
const licenseService = require('../src/services/licenseService');

describe('licenseService.isFeatureEnabled (FIX-2026-08-27 C2)', () => {
  beforeEach(() => {
    licenseGate.lastLicense = null;
    licenseService.invalidateDeployedCache();
  });

  test('returns false for ALL features when no license', () => {
    expect(licenseService.isFeatureEnabled('telegram')).toBe(false);
    expect(licenseService.isFeatureEnabled('autoReserve')).toBe(false);
    expect(licenseService.isFeatureEnabled('cbv5')).toBe(false);
  });

  test('legacy license (no features field) → telegram+cbv5 ON, autoReserve OFF', () => {
    licenseGate.lastLicense = { tier: 'basic', maxCapital: 100 };
    expect(licenseService.isFeatureEnabled('telegram')).toBe(true);
    expect(licenseService.isFeatureEnabled('cbv5')).toBe(true);
    expect(licenseService.isFeatureEnabled('autoReserve')).toBe(false);
  });

  test('explicit features override defaults', () => {
    licenseGate.lastLicense = {
      tier: 'pro',
      features: { telegram: false, autoReserve: true, cbv5: false },
    };
    expect(licenseService.isFeatureEnabled('telegram')).toBe(false);
    expect(licenseService.isFeatureEnabled('autoReserve')).toBe(true);
    expect(licenseService.isFeatureEnabled('cbv5')).toBe(false);
  });

  test('unknown feature name returns false (not undefined)', () => {
    licenseGate.lastLicense = { tier: 'basic', features: { telegram: true } };
    expect(licenseService.isFeatureEnabled('multiMachine')).toBe(false);
  });
});

describe('licenseService.getMaxCapital (FIX-2026-08-27 C2)', () => {
  beforeEach(() => { licenseGate.lastLicense = null; });

  test('no license → 0 (most restrictive)', () => {
    expect(licenseService.getMaxCapital()).toBe(0);
  });

  test('basic tier with default → 100', () => {
    licenseGate.lastLicense = { tier: 'basic', maxCapital: 100 };
    expect(licenseService.getMaxCapital()).toBe(100);
  });

  test('pro tier → 10000', () => {
    licenseGate.lastLicense = { tier: 'pro', maxCapital: 10000 };
    expect(licenseService.getMaxCapital()).toBe(10000);
  });

  test('enterprise + 0 → Infinity (unlimited)', () => {
    licenseGate.lastLicense = { tier: 'enterprise', maxCapital: 0 };
    expect(licenseService.getMaxCapital()).toBe(Infinity);
  });

  test('enterprise + explicit cap → that cap', () => {
    licenseGate.lastLicense = { tier: 'enterprise', maxCapital: 50000 };
    expect(licenseService.getMaxCapital()).toBe(50000);
  });

  test('basic + 0 → Infinity (FIX-2026-08-28 D5: 0 = unlimited for every tier)', () => {
    licenseGate.lastLicense = { tier: 'basic', maxCapital: 0 };
    expect(licenseService.getMaxCapital()).toBe(Infinity);
  });

  test('free+ + 0 → Infinity (regression guard for free+ trial BUY block — was 0 pre-D5)', () => {
    licenseGate.lastLicense = { tier: 'free+', maxCapital: 0 };
    expect(licenseService.getMaxCapital()).toBe(Infinity);
  });

  test('unknown tier "starter" + 0 → Infinity (dynamic-tier guard — never name-couple)', () => {
    licenseGate.lastLicense = { tier: 'starter', maxCapital: 0 };
    expect(licenseService.getMaxCapital()).toBe(Infinity);
  });
});

describe('licenseService.getTotalDeployedUsdt + withinMaxCapital (FIX-2026-08-27 C2)', () => {
  beforeEach(() => {
    licenseGate.lastLicense = null;
    licenseService.invalidateDeployedCache();
    Bot.find.mockReset();
  });

  test('empty bot list → 0 deployed', async () => {
    Bot.find.mockReturnValueOnce({ lean: () => Promise.resolve([]) });
    expect(await licenseService.getTotalDeployedUsdt()).toBe(0);
  });

  test('sums capitalPerTrade * maxTrades', async () => {
    Bot.find.mockReturnValueOnce({ lean: () => Promise.resolve([
      { capitalPerTrade: 10, maxTrades: 5 },  // 50
      { capitalPerTrade: 20, maxTrades: 3 },  // 60
      { capitalPerTrade: 0, maxTrades: 10 },  // 0 (zero capital)
    ]) });
    expect(await licenseService.getTotalDeployedUsdt()).toBe(110);
  });

  test('cached for 30s — second call skips DB', async () => {
    Bot.find.mockReturnValueOnce({ lean: () => Promise.resolve([{ capitalPerTrade: 5, maxTrades: 4 }]) });
    expect(await licenseService.getTotalDeployedUsdt()).toBe(20);
    // Bot.find should not be called again within 30s
    expect(await licenseService.getTotalDeployedUsdt()).toBe(20);
    expect(Bot.find).toHaveBeenCalledTimes(1);
  });

  test('invalidateDeployedCache forces fresh read', async () => {
    Bot.find.mockReturnValueOnce({ lean: () => Promise.resolve([{ capitalPerTrade: 5, maxTrades: 4 }]) });
    await licenseService.getTotalDeployedUsdt();
    Bot.find.mockReturnValueOnce({ lean: () => Promise.resolve([{ capitalPerTrade: 1, maxTrades: 1 }]) });
    licenseService.invalidateDeployedCache();
    expect(await licenseService.getTotalDeployedUsdt()).toBe(1);
    expect(Bot.find).toHaveBeenCalledTimes(2);
  });

  test('DB error → returns 0 (fail-open, does not throw)', async () => {
    Bot.find.mockReturnValueOnce({ lean: () => Promise.reject(new Error('mongo down')) });
    expect(await licenseService.getTotalDeployedUsdt()).toBe(0);
  });

  test('withinMaxCapital: under cap → true', () => {
    licenseGate.lastLicense = { tier: 'basic', maxCapital: 100 };
    Bot.find.mockReturnValueOnce({ lean: () => Promise.resolve([{ capitalPerTrade: 10, maxTrades: 5 }]) });
    return licenseService.getTotalDeployedUsdt().then(() => {
      expect(licenseService.withinMaxCapital(20)).toBe(true);  // 50 + 20 = 70 < 100
    });
  });

  test('withinMaxCapital: over cap → false', () => {
    licenseGate.lastLicense = { tier: 'basic', maxCapital: 100 };
    Bot.find.mockReturnValueOnce({ lean: () => Promise.resolve([{ capitalPerTrade: 10, maxTrades: 8 }]) });
    return licenseService.getTotalDeployedUsdt().then(() => {
      expect(licenseService.withinMaxCapital(30)).toBe(false); // 80 + 30 = 110 > 100
    });
  });

  test('withinMaxCapital: unlimited → always true', () => {
    licenseGate.lastLicense = { tier: 'enterprise', maxCapital: 0 };
    Bot.find.mockReturnValueOnce({ lean: () => Promise.resolve([{ capitalPerTrade: 1000, maxTrades: 100 }]) });
    return licenseService.getTotalDeployedUsdt().then(() => {
      expect(licenseService.withinMaxCapital(1e9)).toBe(true);
    });
  });

  test('withinMaxCapital: no license → always false', () => {
    Bot.find.mockReturnValueOnce({ lean: () => Promise.resolve([]) });
    return licenseService.getTotalDeployedUsdt().then(() => {
      expect(licenseService.withinMaxCapital(1)).toBe(false);
    });
  });
});

describe('licenseService.snapshot (FIX-2026-08-27 C2)', () => {
  beforeEach(() => {
    licenseGate.lastLicense = null;
    licenseService.invalidateDeployedCache();
    Bot.find.mockReset();
  });

  test('returns full status object', async () => {
    licenseGate.lastLicense = {
      tier: 'pro',
      maxCapital: 10000,
      features: { telegram: true, autoReserve: false, cbv5: true },
    };
    Bot.find.mockReturnValueOnce({ lean: () => Promise.resolve([
      { capitalPerTrade: 10, maxTrades: 5 },
    ]) });
    const snap = await licenseService.snapshot({ additionalUsdt: 50 });
    expect(snap).toEqual({
      tier: 'pro',
      maxCapital: 10000,
      totalDeployedUsdt: 50,
      withinMaxCapital: true,
      // FIX-2026-08-28 B5: _getFeatures() now returns 11 keys (was 3). Legacy license
      // without features.* fields defaults them ON for backward compat.
      // FIX-2026-08-30: +1 key (autoTiming, premium-only, default OFF)
      features: {
        telegram: true, autoReserve: false, cbv5: true, safeTrade: true, cb: true,
        telegramLogin: true, autoAddBot: false, autoUpdateTp: false, autoPauseMinKc: false,
        chartMonitor: true, dps: true, configBackup: true, autoTiming: false,
      },
      hasLicense: true,
    });
  });
});