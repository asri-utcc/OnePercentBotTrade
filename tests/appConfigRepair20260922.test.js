'use strict';

/**
 * FIX-2026-09-22: AppConfig schema self-heal — clamp out-of-range numeric fields.
 *
 * Background:
 *   - 2026-09-17: scripts/pause-sweeper.js wrote orphanSellMaxAgeHours=999999 to
 *     BOTH owner + faiz DBs via raw mongo write (bypassing Mongoose schema max:168).
 *   - 2026-09-22: any subsequent .save() (e.g. POST /api/auth/sync-bot-action-password)
 *     threw ValidationError on the stale field even though the caller only touched
 *     botActionPassword.
 *
 * Fix under test (Option D — schema self-heal):
 *   1. src/utils/appConfigRepair.js — pure helper clampOutOfRangeNumbers + repairAppConfig
 *   2. AppConfig.js pre('save') hook — clamps silently before validation runs
 *   3. server.js boot-time repair — runs once after db.connect + license check
 *   4. scripts/repair-appconfig-bounds.js — manual rescue for any instance
 *
 * Tests:
 *   - Pure helper unit tests (no DB): boundary conditions, skip rules, idempotency
 *   - Source-level wiring: hook exists, server wires boot-repair, script exists
 *
 * Pure only — <50ms. mongodb-memory-server not required.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP_CONFIG_SRC = readSrc('src/db/models/AppConfig.js');
const REPAIR_SRC = readSrc('src/utils/appConfigRepair.js');
const SERVER_SRC = readSrc('src/server.js');
const REPAIR_SCRIPT_EXISTS = fs.existsSync(path.join(ROOT, 'scripts', 'repair-appconfig-bounds.js'));

let clampOutOfRangeNumbers, repairAppConfig, DEFAULT_SKIP_PATHS, REPAIR_VERSION;
beforeAll(() => {
  ({ clampOutOfRangeNumbers, repairAppConfig, DEFAULT_SKIP_PATHS, REPAIR_VERSION } =
    require('../src/utils/appConfigRepair'));
});

// ────────────────────────────────────────────────────────────────────────────
// Source-level wiring
// ────────────────────────────────────────────────────────────────────────────

describe('FIX-2026-09-22 AppConfig self-heal — source wiring', () => {
  test('AppConfig.js imports clampOutOfRangeNumbers + logger from utils', () => {
    expect(APP_CONFIG_SRC).toMatch(/require\(['"]\.\.\/\.\.\/utils\/appConfigRepair['"]\)/);
    expect(APP_CONFIG_SRC).toMatch(/require\(['"]\.\.\/\.\.\/utils\/logger['"]\)/);
  });

  test('AppConfig.js declares a pre(\"save") clamp hook', () => {
    expect(APP_CONFIG_SRC).toMatch(/appConfigSchema\.pre\(\s*['"]save['"]/);
    // Hook must call the shared utility
    expect(APP_CONFIG_SRC).toMatch(/clampOutOfRangeNumbers\(\s*this\s*,\s*\{\s*logger\s*,\s*skipPaths:\s*DEFAULT_SKIP_PATHS\s*\}\s*\)/);
    // Hook must never block save on self-heal failure
    expect(APP_CONFIG_SRC).toMatch(/try\s*\{[\s\S]*clampOutOfRangeNumbers[\s\S]*\}\s*catch/);
    // Hook must always call next() so validation runs
    expect(APP_CONFIG_SRC).toMatch(/next\(\)/);
  });

  test('server.js calls repairAppConfig() at boot before botManager.start', () => {
    // Order matters: must be after db.connect (lines 55+) and before botManager.start
    expect(SERVER_SRC).toMatch(/repairAppConfig\(\s*\{\s*AppConfig\s*,\s*logger\s*\}\s*\)/);
    // Wrapped in try/catch — boot must never block on repair failure
    const repairIdx = SERVER_SRC.indexOf('repairAppConfig');
    const next500 = SERVER_SRC.slice(repairIdx, repairIdx + 1500);
    expect(next500).toMatch(/catch\s*\(\s*err\s*\)/);
    expect(next500).toMatch(/non-fatal/);
  });

  test('scripts/repair-appconfig-bounds.js exists and uses shared utility', () => {
    expect(REPAIR_SCRIPT_EXISTS).toBe(true);
    const scriptSrc = readSrc('scripts/repair-appconfig-bounds.js');
    expect(scriptSrc).toMatch(/require.*appConfigRepair/);
    expect(scriptSrc).toMatch(/repairAppConfig\(\s*\{/);
    // Must respect DB_URI env var for cross-instance use
    expect(scriptSrc).toMatch(/DB_URI/);
    // Must NOT clear sweeperEmergencyPaused automatically
    expect(scriptSrc).not.toMatch(/sweeperEmergencyPaused.*=.*false/);
  });

  test('REPAIR_VERSION is exported + stamped on this fix', () => {
    expect(REPAIR_VERSION).toBe('2026-09-22');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Pure helper unit tests — fake doc with schema-like paths shape
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a fake Mongoose-like doc with .schema.paths shaped like AppConfig.
 * Pure unit-test fixture — no DB / Mongoose instance needed.
 */
function makeFakeDoc(fieldDefs, initialValues) {
  const doc = { ...initialValues };
  doc.schema = {
    paths: Object.fromEntries(
      Object.entries(fieldDefs).map(([name, def]) => [
        name,
        {
          instance: def.type,
          options: {
            ...(def.min != null ? { min: def.min } : {}),
            ...(def.max != null ? { max: def.max } : {}),
            // Preserve other options for completeness
          },
        },
      ])
    ),
  };
  return doc;
}

describe('FIX-2026-09-22 clampOutOfRangeNumbers — pure helper', () => {
  test('clamps value above max to max', () => {
    const doc = makeFakeDoc(
      { orphanSellMaxAgeHours: { type: 'Number', min: 1, max: 168 } },
      { orphanSellMaxAgeHours: 999999 }
    );
    const { repaired } = clampOutOfRangeNumbers(doc);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({
      path: 'orphanSellMaxAgeHours',
      from: 999999,
      to: 168,
      min: 1,
      max: 168,
    });
    expect(doc.orphanSellMaxAgeHours).toBe(168);
  });

  test('clamps value below min to min', () => {
    const doc = makeFakeDoc(
      { orphanSellMaxAgeHours: { type: 'Number', min: 1, max: 168 } },
      { orphanSellMaxAgeHours: -5 }
    );
    const { repaired } = clampOutOfRangeNumbers(doc);
    expect(repaired).toHaveLength(1);
    expect(doc.orphanSellMaxAgeHours).toBe(1);
  });

  test('leaves valid value untouched (no false-positive clamp)', () => {
    const doc = makeFakeDoc(
      { orphanSellMaxAgeHours: { type: 'Number', min: 1, max: 168 } },
      { orphanSellMaxAgeHours: 24 }
    );
    const { repaired } = clampOutOfRangeNumbers(doc);
    expect(repaired).toEqual([]);
    expect(doc.orphanSellMaxAgeHours).toBe(24);
  });

  test('clamps to boundary values exactly', () => {
    const docMax = makeFakeDoc(
      { orphanSellMaxAgeHours: { type: 'Number', min: 1, max: 168 } },
      { orphanSellMaxAgeHours: 168 }
    );
    const docMin = makeFakeDoc(
      { orphanSellMaxAgeHours: { type: 'Number', min: 1, max: 168 } },
      { orphanSellMaxAgeHours: 1 }
    );
    expect(clampOutOfRangeNumbers(docMax).repaired).toEqual([]);
    expect(clampOutOfRangeNumbers(docMin).repaired).toEqual([]);
  });

  test('skips non-Number fields (String/Boolean/Object/Mixed)', () => {
    const doc = makeFakeDoc(
      {
        cbVersion: { type: 'String' },           // String — skip
        auv2Enabled: { type: 'Boolean' },         // Boolean — skip
        telegramEvents: { type: 'Object' },       // Mixed — skip
        masterConfigTemplates: { type: 'Array' }, // Array — skip
        autoTimingBands: { type: 'Object' },      // Mixed — skip
      },
      {
        cbVersion: 999999,            // would otherwise look numeric but field is String
        auv2Enabled: 999999,
        telegramEvents: 999999,
        masterConfigTemplates: 999999,
        autoTimingBands: 999999,
      }
    );
    const { repaired } = clampOutOfRangeNumbers(doc);
    expect(repaired).toEqual([]);
    // Originals untouched
    expect(doc.cbVersion).toBe(999999);
    expect(doc.auv2Enabled).toBe(999999);
  });

  test('skips Number fields without min/max (e.g. cbVersion-style config)', () => {
    const doc = makeFakeDoc(
      { someUnboundedNumber: { type: 'Number' } },
      { someUnboundedNumber: 999999 }
    );
    const { repaired } = clampOutOfRangeNumbers(doc);
    expect(repaired).toEqual([]);
  });

  test('skips undefined / null / NaN values (do not crash)', () => {
    const defs = {
      a: { type: 'Number', min: 0, max: 100 },
      b: { type: 'Number', min: 0, max: 100 },
      c: { type: 'Number', min: 0, max: 100 },
      e: { type: 'Number', min: 0, max: 100 },
    };
    const doc = makeFakeDoc(defs, { a: undefined, b: null, c: NaN, e: 999999 });
    const { repaired } = clampOutOfRangeNumbers(doc);
    expect(repaired).toHaveLength(1);
    expect(repaired[0].path).toBe('e');
    expect(doc.e).toBe(100);
    // a/b/c unchanged
    expect(doc.a).toBeUndefined();
    expect(doc.b).toBeNull();
    expect(Number.isNaN(doc.c)).toBe(true);
  });

  test('respects skipPaths (operator-controlled emergency markers)', () => {
    const doc = makeFakeDoc(
      {
        orphanSellMaxAgeHours: { type: 'Number', min: 1, max: 168 },
        sweeperEmergencyPaused: { type: 'Boolean' }, // not numeric, but skip check still applies
      },
      { orphanSellMaxAgeHours: 999999, sweeperEmergencyPaused: true }
    );
    const { repaired } = clampOutOfRangeNumbers(doc, {
      skipPaths: new Set(['sweeperEmergencyPaused', 'sweeperEmergencyPausedAt', 'sweeperEmergencyPauseReason']),
    });
    expect(repaired).toHaveLength(1);
    expect(repaired[0].path).toBe('orphanSellMaxAgeHours');
  });

  test('clamps multiple fields in one pass', () => {
    const doc = makeFakeDoc(
      {
        orphanSellMaxAgeHours: { type: 'Number', min: 1, max: 168 },
        autoTimingLookbackDays: { type: 'Number', min: 7, max: 90 },
        walletReserveUsdt: { type: 'Number', min: 0, max: 1_000_000 },
      },
      {
        orphanSellMaxAgeHours: 999999,
        autoTimingLookbackDays: 1000,
        walletReserveUsdt: 5_000_000,
      }
    );
    const { repaired } = clampOutOfRangeNumbers(doc);
    expect(repaired).toHaveLength(3);
    expect(doc.orphanSellMaxAgeHours).toBe(168);
    expect(doc.autoTimingLookbackDays).toBe(90);
    expect(doc.walletReserveUsdt).toBe(1_000_000);
  });

  test('handles min-only field (clamps below min)', () => {
    const doc = makeFakeDoc(
      { autoBuyBnbCooldownMin: { type: 'Number', min: 0 } },
      { autoBuyBnbCooldownMin: -1 }
    );
    const { repaired } = clampOutOfRangeNumbers(doc);
    expect(repaired).toHaveLength(1);
    expect(doc.autoBuyBnbCooldownMin).toBe(0);
  });

  test('handles max-only field (clamps above max)', () => {
    const doc = makeFakeDoc(
      { autoTimingMinNotionalFloorUSDT: { type: 'Number', max: 1_000_000 } },
      { autoTimingMinNotionalFloorUSDT: 2_000_000 }
    );
    const { repaired } = clampOutOfRangeNumbers(doc);
    expect(repaired).toHaveLength(1);
    expect(doc.autoTimingMinNotionalFloorUSDT).toBe(1_000_000);
  });

  test('returns empty array for invalid doc input (defensive)', () => {
    expect(clampOutOfRangeNumbers(null).repaired).toEqual([]);
    expect(clampOutOfRangeNumbers(undefined).repaired).toEqual([]);
    expect(clampOutOfRangeNumbers({}).repaired).toEqual([]);
    expect(clampOutOfRangeNumbers({ schema: {} }).repaired).toEqual([]);
  });

  test('idempotent — running twice does not re-clamp', () => {
    const doc = makeFakeDoc(
      { orphanSellMaxAgeHours: { type: 'Number', min: 1, max: 168 } },
      { orphanSellMaxAgeHours: 999999 }
    );
    clampOutOfRangeNumbers(doc);
    const { repaired } = clampOutOfRangeNumbers(doc);
    expect(repaired).toEqual([]);
    expect(doc.orphanSellMaxAgeHours).toBe(168);
  });

  test('emits warn log when repairs found, no log when clean', () => {
    const dirty = makeFakeDoc(
      { orphanSellMaxAgeHours: { type: 'Number', min: 1, max: 168 } },
      { orphanSellMaxAgeHours: 999999 }
    );
    const clean = makeFakeDoc(
      { orphanSellMaxAgeHours: { type: 'Number', min: 1, max: 168 } },
      { orphanSellMaxAgeHours: 24 }
    );
    const calls = [];
    const fakeLogger = { warn: (obj, msg) => calls.push({ obj, msg }) };
    clampOutOfRangeNumbers(dirty, { logger: fakeLogger });
    clampOutOfRangeNumbers(clean, { logger: fakeLogger });
    expect(calls).toHaveLength(1);
    expect(calls[0].obj).toBeDefined();
    expect(calls[0].msg).toMatch(/clamped out-of-range/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// DEFAULT_SKIP_PATHS — operator-controlled emergency state must be skipped
// ────────────────────────────────────────────────────────────────────────────

describe('FIX-2026-09-22 DEFAULT_SKIP_PATHS', () => {
  test('includes sweeperEmergencyPaused + related markers', () => {
    expect(DEFAULT_SKIP_PATHS.has('sweeperEmergencyPaused')).toBe(true);
    expect(DEFAULT_SKIP_PATHS.has('sweeperEmergencyPausedAt')).toBe(true);
    expect(DEFAULT_SKIP_PATHS.has('sweeperEmergencyPauseReason')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// repairAppConfig() — defensive behavior without DB
// ────────────────────────────────────────────────────────────────────────────

describe('FIX-2026-09-22 repairAppConfig — defensive behavior (no DB)', () => {
  test('returns docFound:false when AppConfig model is missing', async () => {
    const r = await repairAppConfig({ AppConfig: null });
    expect(r.docFound).toBe(false);
    expect(r.persisted).toBe(false);
    expect(r.repaired).toEqual([]);
  });

  test('returns docFound:false when AppConfig.findOne throws', async () => {
    const fakeAC = { findOne: async () => { throw new Error('mongo down'); } };
    const r = await repairAppConfig({ AppConfig: fakeAC });
    expect(r.docFound).toBe(false);
    expect(r.persisted).toBe(false);
    expect(r.error).toMatch(/mongo down/);
  });

  test('returns docFound:false when no singleton doc exists', async () => {
    const fakeAC = { findOne: async () => null };
    const r = await repairAppConfig({ AppConfig: fakeAC });
    expect(r.docFound).toBe(false);
    expect(r.repaired).toEqual([]);
  });
});