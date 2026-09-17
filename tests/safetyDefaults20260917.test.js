'use strict';

/**
 * FIX-2026-09-17: env-var → AppConfig safety defaults — regression tests
 *
 * Background:
 *   - AppConfig schema has opt-in safety toggles (default false)
 *   - Without env override, fresh instance boots with all safety OFF
 *     → silent-off class of bugs (BERAUSDT, ZENUSDT)
 *   - This test guards the pure-helper computeSafetyDefaults + ENV_DEFAULTS schema
 *
 * Source-level + pure-helper tests only — no DB/network — runs <50ms.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SAFETY_DEFAULTS_SRC = readSrc('src/utils/safetyDefaults.js');
const AUTH_ROUTES_SRC = readSrc('src/api/routes/auth.routes.js');
const ENV_EXAMPLE_SRC = readSrc('.env.example');
const APP_CONFIG_SRC = readSrc('src/db/models/AppConfig.js');

let computeSafetyDefaults;
beforeAll(() => {
  // No external deps in safetyDefaults.js → safe to require directly
  computeSafetyDefaults = require('../src/utils/safetyDefaults').computeSafetyDefaults;
});

describe('FIX-2026-09-17 env-var → AppConfig safety defaults wiring', () => {
  describe('auth.routes.js setup integration', () => {
    test('requires safetyDefaults helper', () => {
      expect(AUTH_ROUTES_SRC).toMatch(/require\(['"]\.\.\/\.\.\/utils\/safetyDefaults['"]\)/);
    });

    test('calls applySafetyDefaults(configDoc) before save', () => {
      expect(AUTH_ROUTES_SRC).toMatch(/safetyDefaults\.applySafetyDefaults\(\s*configDoc\s*\)/);
    });
  });

  describe('.env.example documents safety env vars', () => {
    test('lists AUV2_ENABLED + ORPHAN_SELL_MAX_AGE_HOURS + WAITING_SELL_RECOVERY_*', () => {
      expect(ENV_EXAMPLE_SRC).toMatch(/^AUV2_ENABLED=/m);
      expect(ENV_EXAMPLE_SRC).toMatch(/^AUV2_MIN_AGE_HOURS=/m);
      expect(ENV_EXAMPLE_SRC).toMatch(/^AUV2_MAX_LOSS_PCT=/m);
      expect(ENV_EXAMPLE_SRC).toMatch(/^AUV2_MAX_LOSS_THB=/m);
      expect(ENV_EXAMPLE_SRC).toMatch(/^AUV2_MAX_WAIT_DAYS=/m);
      expect(ENV_EXAMPLE_SRC).toMatch(/^ORPHAN_SELL_MAX_AGE_HOURS=/m);
      expect(ENV_EXAMPLE_SRC).toMatch(/^WAITING_SELL_RECOVERY_ENABLED=/m);
      expect(ENV_EXAMPLE_SRC).toMatch(/^WAITING_SELL_RECOVERY_INTERVAL_MS=/m);
    });
  });

  describe('ENV_DEFAULTS schema', () => {
    test('declares all 8 safety fields with type/min/max bounds', () => {
      expect(SAFETY_DEFAULTS_SRC).toMatch(/auv2Enabled\s*:\s*\{[\s\S]*?type\s*:\s*'boolean'[\s\S]*?schemaDefault\s*:\s*false/s);
      expect(SAFETY_DEFAULTS_SRC).toMatch(/orphanSellMaxAgeHours\s*:\s*\{[\s\S]*?min\s*:\s*1[\s\S]*?max\s*:\s*168[\s\S]*?schemaDefault\s*:\s*24/s);
      expect(SAFETY_DEFAULTS_SRC).toMatch(/waitingSellRecoveryIntervalMs\s*:\s*\{[\s\S]*?min\s*:\s*1\s*\*\s*60\s*\*\s*60\s*\*\s*1000[\s\S]*?max\s*:\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000[\s\S]*?schemaDefault\s*:\s*4\s*\*\s*60\s*\*\s*60\s*\*\s*1000/s);
    });
  });

  describe('computeSafetyDefaults pure helper (no mocks)', () => {
    test('returns empty fields when existing is full and env is empty', () => {
      const existing = {
        auv2Enabled: false,
        orphanSellMaxAgeHours: 24,
        waitingSellRecoveryEnabled: true,
      };
      const r = computeSafetyDefaults(existing, {});
      expect(Object.keys(r.fields)).toEqual([]);
      expect(r.sources.auv2Enabled).toBe('existing');
    });

    test('respects existing DB value (does not override)', () => {
      const existing = { auv2Enabled: false };  // user explicitly OFF
      const env = { AUV2_ENABLED: 'true' };     // env says ON
      const r = computeSafetyDefaults(existing, env);
      expect(r.fields.auv2Enabled).toBeUndefined();
      expect(r.sources.auv2Enabled).toBe('existing');
    });

    test('applies env when existing is undefined/null', () => {
      const existing = {};  // fresh deploy — no AppConfig yet
      const env = {
        AUV2_ENABLED: 'true',
        ORPHAN_SELL_MAX_AGE_HOURS: '48',
        WAITING_SELL_RECOVERY_ENABLED: 'false',
      };
      const r = computeSafetyDefaults(existing, env);
      expect(r.fields.auv2Enabled).toBe(true);
      expect(r.fields.orphanSellMaxAgeHours).toBe(48);
      expect(r.fields.waitingSellRecoveryEnabled).toBe(false);
      expect(r.sources.auv2Enabled).toBe('env');
    });

    test('parses booleans (true/1/yes/on → true; false/0/no/off → false)', () => {
      const cases = [
        ['true', true], ['TRUE', true], ['True', true],
        ['1', true], ['yes', true], ['YES', true], ['on', true],
        ['false', false], ['FALSE', false], ['0', false],
        ['no', false], ['off', false],
      ];
      for (const [raw, expected] of cases) {
        const r = computeSafetyDefaults({}, { AUV2_ENABLED: raw });
        expect(r.fields.auv2Enabled).toBe(expected);
      }
    });

    test('skips invalid boolean (records in skipped)', () => {
      const r = computeSafetyDefaults({}, { AUV2_ENABLED: 'maybe' });
      expect(r.fields.auv2Enabled).toBeUndefined();
      expect(r.skipped).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'auv2Enabled', reason: expect.stringContaining('invalid boolean') }),
      ]));
    });

    test('skips out-of-range numbers (clamp enforcement)', () => {
      const r1 = computeSafetyDefaults({}, { ORPHAN_SELL_MAX_AGE_HOURS: '0' });   // min=1
      expect(r1.fields.orphanSellMaxAgeHours).toBeUndefined();
      expect(r1.skipped).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'orphanSellMaxAgeHours', reason: expect.stringContaining('below min') }),
      ]));

      const r2 = computeSafetyDefaults({}, { ORPHAN_SELL_MAX_AGE_HOURS: '200' }); // max=168
      expect(r2.fields.orphanSellMaxAgeHours).toBeUndefined();
      expect(r2.skipped).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'orphanSellMaxAgeHours', reason: expect.stringContaining('above max') }),
      ]));
    });

    test('skips invalid numbers', () => {
      const r = computeSafetyDefaults({}, { ORPHAN_SELL_MAX_AGE_HOURS: 'not-a-number' });
      expect(r.fields.orphanSellMaxAgeHours).toBeUndefined();
      expect(r.skipped).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringContaining('invalid number') }),
      ]));
    });

    test('WAITING_SELL_RECOVERY_INTERVAL_MS validates 1h..24h range', () => {
      const minMs = 1 * 60 * 60 * 1000;
      const maxMs = 24 * 60 * 60 * 1000;

      // Valid (4h)
      const r1 = computeSafetyDefaults({}, { WAITING_SELL_RECOVERY_INTERVAL_MS: String(4 * 60 * 60 * 1000) });
      expect(r1.fields.waitingSellRecoveryIntervalMs).toBe(4 * 60 * 60 * 1000);

      // Below min (30min)
      const r2 = computeSafetyDefaults({}, { WAITING_SELL_RECOVERY_INTERVAL_MS: String(30 * 60 * 1000) });
      expect(r2.fields.waitingSellRecoveryIntervalMs).toBeUndefined();

      // Above max (48h)
      const r3 = computeSafetyDefaults({}, { WAITING_SELL_RECOVERY_INTERVAL_MS: String(48 * 60 * 60 * 1000) });
      expect(r3.fields.waitingSellRecoveryIntervalMs).toBeUndefined();
    });

    test('treats empty string as unset (does not apply)', () => {
      const r = computeSafetyDefaults({}, { AUV2_ENABLED: '' });
      expect(r.fields.auv2Enabled).toBeUndefined();
    });

    test('all 8 fields in ENV_DEFAULTS — coverage guard', () => {
      const r = computeSafetyDefaults({}, {
        AUV2_ENABLED: 'true',
        AUV2_MIN_AGE_HOURS: '24',
        AUV2_MAX_LOSS_PCT: '5',
        AUV2_MAX_LOSS_THB: '200',
        AUV2_MAX_WAIT_DAYS: '7',
        ORPHAN_SELL_MAX_AGE_HOURS: '24',
        WAITING_SELL_RECOVERY_ENABLED: 'true',
        WAITING_SELL_RECOVERY_INTERVAL_MS: String(4 * 60 * 60 * 1000),
      });
      expect(Object.keys(r.fields).sort()).toEqual([
        'auv2Enabled', 'auv2MaxLossPct', 'auv2MaxLossThb', 'auv2MaxWaitDays',
        'auv2MinAgeHours', 'orphanSellMaxAgeHours',
        'waitingSellRecoveryEnabled', 'waitingSellRecoveryIntervalMs',
      ]);
    });
  });

  describe('scripts/seed-appconfig-from-env.js', () => {
    test('exists with --owner / --faiz / --force args', () => {
      const script = readSrc('scripts/seed-appconfig-from-env.js');
      expect(script).toMatch(/--faiz|--owner/);
      expect(script).toMatch(/--force/);
    });

    test('uses safetyDefaults.computeSafetyDefaults (not custom logic)', () => {
      const script = readSrc('scripts/seed-appconfig-from-env.js');
      expect(script).toMatch(/require\(['"]\.\.\/src\/utils\/safetyDefaults['"]\)/);
      expect(script).toMatch(/computeSafetyDefaults\s*\(/);
    });
  });

  describe('AppConfig schema includes all env-seeded fields (so Mongoose strict mode does not silently drop)', () => {
    test('declares auv2Enabled, orphanSellMaxAgeHours, waitingSellRecovery*', () => {
      expect(APP_CONFIG_SRC).toMatch(/auv2Enabled\s*:\s*\{\s*type\s*:\s*Boolean/);
      expect(APP_CONFIG_SRC).toMatch(/orphanSellMaxAgeHours\s*:\s*\{\s*type\s*:\s*Number/);
      expect(APP_CONFIG_SRC).toMatch(/waitingSellRecoveryEnabled\s*:\s*\{\s*type\s*:\s*Boolean/);
      expect(APP_CONFIG_SRC).toMatch(/waitingSellRecoveryIntervalMs\s*:\s*\{\s*type\s*:\s*Number/);
    });
  });
});
