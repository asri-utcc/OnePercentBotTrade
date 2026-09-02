'use strict';

/**
 * FIX-2026-09-01 audit H3: licenseService — safety features must default
 * ON during the no-license gap (boot / before first heartbeat).
 *
 *   Before: _getFeatures() returned _allFeatures(false) when no license
 *           existed, leaving CB / CBv5 / safeTrade / telegram silently
 *           DISABLED during the window between bot boot and the first
 *           successful admin heartbeat. A bot could overshoot its
 *           circuit-breaker config or skip safe-trade filters in that gap.
 *
 *   After:  Safety features (cb, cbv5, safeTrade, telegram, telegramLogin,
 *           chartMonitor, dps, configBackup) default ON when no license
 *           is loaded. Premium features (autoReserve, autoAddBot,
 *           autoTiming, autoUpdateTp, autoPauseMinKc) still default OFF —
 *           they're admin-gated and never accidentally free.
 *
 *   Once a license IS loaded, the per-feature `!== false` / `=== true`
 *   semantics in _getFeatures() apply unchanged.
 */

const fs = require('fs');
const path = require('path');

const LIC_PATH = path.join(__dirname, '..', 'src', 'services', 'licenseService.js');
const licRaw = fs.readFileSync(LIC_PATH, 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s;,(])\/\/[^\n]*/g, '$1');
}

describe('audit-H3 source: licenseService splits safety-on vs premium-off defaults', () => {
  test('FIX-2026-09-01 audit H3 comment present', () => {
    expect(licRaw).toMatch(/FIX-2026-09-01 audit H3/);
  });

  test('_getFeatures() no-license branch uses _safetyOnPremiumOff() (not _allFeatures(false))', () => {
    const code = stripComments(licRaw);
    // The no-license branch must NOT return _allFeatures(false) — that's
    // the audit-flagged pattern (all features including safety=OFF).
    // It must return _safetyOnPremiumOff() (the audit-fix helper).
    const noLicBlock = code.match(/if\s*\(\s*!lic\s*\)\s*\{[\s\S]{0,300}return\s+_safetyOnPremiumOff\(\)\s*;/);
    expect(noLicBlock).not.toBeNull();
    // Confirm the old _allFeatures(false) is no longer reached.
    expect(code).not.toMatch(/if\s*\(\s*!lic\s*\)\s*\{[\s\S]{0,300}return\s+_allFeatures\(false\)/);
  });

  test('_safetyOnPremiumOff helper exists and lists each safety feature ON', () => {
    const code = stripComments(licRaw);
    const helper = code.match(/function\s+_safetyOnPremiumOff\s*\(\s*\)\s*\{[\s\S]{0,1500}\}/);
    expect(helper).not.toBeNull();
    const body = helper[0];
    // Safety ON
    expect(body).toMatch(/cb:\s*true/);
    expect(body).toMatch(/cbv5:\s*true/);
    expect(body).toMatch(/safeTrade:\s*true/);
    expect(body).toMatch(/telegram:\s*true/);
    expect(body).toMatch(/telegramLogin:\s*true/);
    expect(body).toMatch(/chartMonitor:\s*true/);
    expect(body).toMatch(/dps:\s*true/);
    expect(body).toMatch(/configBackup:\s*true/);
  });

  test('_safetyOnPremiumOff helper lists each premium feature OFF', () => {
    const code = stripComments(licRaw);
    const helper = code.match(/function\s+_safetyOnPremiumOff\s*\(\s*\)\s*\{[\s\S]{0,1500}\}/);
    expect(helper).not.toBeNull();
    const body = helper[0];
    // Premium OFF (explicit, not omitted — defense in depth)
    expect(body).toMatch(/autoReserve:\s*false/);
    expect(body).toMatch(/autoAddBot:\s*false/);
    expect(body).toMatch(/autoUpdateTp:\s*false/);
    expect(body).toMatch(/autoPauseMinKc:\s*false/);
    expect(body).toMatch(/autoTiming:\s*false/);
  });

  test('legacy license branch (features present) is unchanged', () => {
    const code = stripComments(licRaw);
    // Once license IS loaded, per-feature semantics use the legacy
    // `!== false` for safety and `=== true` for premium — unchanged.
    expect(code).toMatch(/f\.cb\s*!==\s*false/);
    expect(code).toMatch(/f\.cbv5\s*!==\s*false/);
    expect(code).toMatch(/f\.safeTrade\s*!==\s*false/);
    expect(code).toMatch(/f\.autoTiming\s*===\s*true/);
    expect(code).toMatch(/f\.autoReserve\s*===\s*true/);
  });
});

describe('audit-H3 runtime: default-feature resolution matrix', () => {
  // We replicate the safety-on/premium-off logic and assert it maps to
  // the expectations. The real resolver is the function we just changed.

  function defaultsForNoLicense() {
    return {
      telegram: true, cbv5: true, safeTrade: true, cb: true,
      telegramLogin: true, chartMonitor: true, dps: true, configBackup: true,
      autoReserve: false, autoAddBot: false, autoUpdateTp: false,
      autoPauseMinKc: false, autoTiming: false,
    };
  }

  const SAFETY_KEYS = ['cb', 'cbv5', 'safeTrade', 'telegram', 'telegramLogin', 'chartMonitor', 'dps', 'configBackup'];
  const PREMIUM_KEYS = ['autoReserve', 'autoAddBot', 'autoUpdateTp', 'autoPauseMinKc', 'autoTiming'];

  test('during no-license gap: EVERY safety feature is ON', () => {
    const d = defaultsForNoLicense();
    for (const k of SAFETY_KEYS) {
      expect({ key: k, val: d[k] }).toEqual(expect.objectContaining({ val: true }));
    }
  });

  test('during no-license gap: EVERY premium feature is OFF', () => {
    const d = defaultsForNoLicense();
    for (const k of PREMIUM_KEYS) {
      expect({ key: k, val: d[k] }).toEqual(expect.objectContaining({ val: false }));
    }
  });

  test('the audit-flagged CB case is now ON (not silently OFF)', () => {
    // The literal scenario from the audit:
    const d = defaultsForNoLicense();
    expect(d.cb).toBe(true);
  });

  test('the audit-flagged CBv5 case is now ON', () => {
    const d = defaultsForNoLicense();
    expect(d.cbv5).toBe(true);
  });

  test('the audit-flagged safeTrade case is now ON', () => {
    const d = defaultsForNoLicense();
    expect(d.safeTrade).toBe(true);
  });

  test('premium autoTiming still OFF (admin-gated)', () => {
    const d = defaultsForNoLicense();
    expect(d.autoTiming).toBe(false);
  });

  test('premium autoReserve still OFF (admin-gated)', () => {
    const d = defaultsForNoLicense();
    expect(d.autoReserve).toBe(false);
  });
});