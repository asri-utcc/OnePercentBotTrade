'use strict';

/**
 * FIX-2026-09-29: Tests for round-3-follow-up bootstrap + migration functions.
 *
 * Covers:
 *   - bootstrapAppConfigDefaults()
 *   - migrateSplitStepFields() (strengthened — null legacy → schema default)
 *   - migrateBtcDrivenPresets() (NEW — top-level Object)
 *   - migratePresetsSubFields() (NEW — nested stepUsdt mirror inside presets)
 *
 * Pattern: each test mocks AppConfig (mongoose model) in-place. No mongodb-memory-server
 * because these are pure functions over a mockable model.
 */

// ─── Mock factory (variable prefix MUST be `mock*` per jest hoisting rules) ───
const mockAppConfigDoc = {
  // Mutable state — tests mutate directly
  _exists: false,
  _doc: {},
};

function makeMockAppConfig() {
  // Make AppConfig callable with `new AppConfig(...)` — wrap as a function that returns a doc-like object
  function MockAppConfig(init = {}) {
    const instance = { ...init, _isMockInstance: true };
    instance.save = jest.fn(async function() {
      // Persist the instance state into mock doc
      mockAppConfigDoc._doc = { ...instance };
      delete mockAppConfigDoc._doc.save;
      mockAppConfigDoc._exists = true;
      return mockAppConfigDoc._doc;
    });
    return instance;
  }

  // Helper: build a thenable that resolves to current mock state
  function thenableResult() {
    return {
      then: (resolve, reject) => {
        const result = mockAppConfigDoc._exists ? { ...mockAppConfigDoc._doc } : null;
        return Promise.resolve(result).then(resolve, reject);
      },
    };
  }

  MockAppConfig.findOne = jest.fn((filter) => {
    // Mongoose-style: findOne returns a Query that is thenable AND has .lean()
    const query = {
      lean: () => thenableResult(),
    };
    query.then = thenableResult().then;
    return query;
  });

  MockAppConfig.findOneAndUpdate = jest.fn(async (filter, update) => {
    const $set = (update && update.$set) || update || {};
    mockAppConfigDoc._doc = { ...mockAppConfigDoc._doc, ...$set };
    mockAppConfigDoc._exists = true;
    return mockAppConfigDoc._doc;
  });

  return MockAppConfig;
}

const noopLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function resetMockDoc(state = null) {
  if (state === null) {
    mockAppConfigDoc._exists = false;
    mockAppConfigDoc._doc = {};
  } else {
    mockAppConfigDoc._exists = true;
    mockAppConfigDoc._doc = JSON.parse(JSON.stringify(state));
  }
}

function getRepair() {
  return require('../src/utils/appConfigRepair');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('FIX-2026-09-29 bootstrapAppConfigDefaults', () => {
  beforeEach(() => {
    resetMockDoc(null);
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
  });

  test('1) creates singleton doc when none exists', async () => {
    const AppConfig = makeMockAppConfig();
    const { bootstrapAppConfigDefaults } = getRepair();

    const result = await bootstrapAppConfigDefaults({ AppConfig, logger: noopLogger });
    expect(result.created).toBe(true);
    expect(result.docFound).toBe(false);
    expect(mockAppConfigDoc._exists).toBe(true);
    // new AppConfig({key:'singleton'}) in test env doesn't trigger schema defaults
    // (we mock the model), so we just verify the doc was created and saved.
    expect(mockAppConfigDoc._doc.key).toBe('singleton');
  });

  test('2) no-op when singleton already exists', async () => {
    resetMockDoc({ key: 'singleton', setupCompleted: true });
    const AppConfig = makeMockAppConfig();
    const { bootstrapAppConfigDefaults } = getRepair();

    const result = await bootstrapAppConfigDefaults({ AppConfig, logger: noopLogger });
    expect(result.created).toBe(false);
    expect(result.docFound).toBe(true);
    // findOneAndUpdate should NOT be called
    expect(AppConfig.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('3) handles missing AppConfig gracefully', async () => {
    const { bootstrapAppConfigDefaults } = getRepair();
    const result = await bootstrapAppConfigDefaults({ AppConfig: null, logger: noopLogger });
    expect(result.created).toBe(false);
    expect(result.error).toMatch(/missing/);
  });
});

describe('FIX-2026-09-29 migrateSplitStepFields (strengthened)', () => {
  beforeEach(() => {
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
  });

  test('4) mirrors legacy autoReserveStepUsdt=7 to both new fields', async () => {
    resetMockDoc({ key: 'singleton', autoReserveStepUsdt: 7 });
    const AppConfig = makeMockAppConfig();
    const { migrateSplitStepFields } = getRepair();

    const result = await migrateSplitStepFields({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(true);
    expect(result.legacyValid).toBe(true);
    expect(mockAppConfigDoc._doc.autoReserveStepReserveUsdt).toBe(7);
    expect(mockAppConfigDoc._doc.autoReserveStepReleaseUsdt).toBe(7);
  });

  test('5) falls back to schema default (10) when legacy is null AND new fields missing', async () => {
    // NEW behavior (round 3 follow-up): null legacy + null new fields → default 10
    resetMockDoc({ key: 'singleton' /* no autoReserveStepUsdt, no new fields */ });
    const AppConfig = makeMockAppConfig();
    const { migrateSplitStepFields } = getRepair();

    const result = await migrateSplitStepFields({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(true);
    expect(result.legacyValid).toBe(false);
    expect(mockAppConfigDoc._doc.autoReserveStepReserveUsdt).toBe(10);
    expect(mockAppConfigDoc._doc.autoReserveStepReleaseUsdt).toBe(10);
  });

  test('6) no-op when both new fields already populated', async () => {
    resetMockDoc({
      key: 'singleton',
      autoReserveStepUsdt: 7,
      autoReserveStepReserveUsdt: 9,
      autoReserveStepReleaseUsdt: 11,
    });
    const AppConfig = makeMockAppConfig();
    const { migrateSplitStepFields } = getRepair();

    const result = await migrateSplitStepFields({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(false);
    // findOneAndUpdate NOT called (nothing to write)
    expect(AppConfig.findOneAndUpdate).not.toHaveBeenCalled();
    // Existing values preserved
    expect(mockAppConfigDoc._doc.autoReserveStepReserveUsdt).toBe(9);
    expect(mockAppConfigDoc._doc.autoReserveStepReleaseUsdt).toBe(11);
  });

  test('7) no-op when no doc exists (bootstrap will handle)', async () => {
    resetMockDoc(null);
    const AppConfig = makeMockAppConfig();
    const { migrateSplitStepFields } = getRepair();

    const result = await migrateSplitStepFields({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(false);
  });

  test('8) legacy out-of-range (e.g. 999999) is ignored → uses schema default', async () => {
    resetMockDoc({ key: 'singleton', autoReserveStepUsdt: 999999 });
    const AppConfig = makeMockAppConfig();
    const { migrateSplitStepFields } = getRepair();

    const result = await migrateSplitStepFields({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(true);
    expect(result.legacyValid).toBe(false);
    expect(mockAppConfigDoc._doc.autoReserveStepReserveUsdt).toBe(10);
  });

  test('9) partial — legacy valid but only reserve field missing → mirrors to reserve only', async () => {
    resetMockDoc({
      key: 'singleton',
      autoReserveStepUsdt: 7,
      autoReserveStepReserveUsdt: null,
      autoReserveStepReleaseUsdt: 99, // already set by user
    });
    const AppConfig = makeMockAppConfig();
    const { migrateSplitStepFields } = getRepair();

    const result = await migrateSplitStepFields({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(true);
    expect(result.fields).toEqual(['autoReserveStepReserveUsdt']);
    expect(mockAppConfigDoc._doc.autoReserveStepReserveUsdt).toBe(7);
    expect(mockAppConfigDoc._doc.autoReserveStepReleaseUsdt).toBe(99); // preserved
  });

  test('10) handles missing AppConfig gracefully', async () => {
    const { migrateSplitStepFields } = getRepair();
    const result = await migrateSplitStepFields({ AppConfig: null, logger: noopLogger });
    expect(result.migrated).toBe(false);
    expect(result.error).toMatch(/missing/);
  });
});

describe('FIX-2026-09-29 migrateBtcDrivenPresets', () => {
  beforeEach(() => {
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
  });

  test('11) writes defaults when presets is null', async () => {
    resetMockDoc({ key: 'singleton', autoReserveBtcDrivenPresets: null });
    const AppConfig = makeMockAppConfig();
    const { migrateBtcDrivenPresets } = getRepair();

    const result = await migrateBtcDrivenPresets({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(true);
    expect(mockAppConfigDoc._doc.autoReserveBtcDrivenPresets.conservative).toBeDefined();
    expect(mockAppConfigDoc._doc.autoReserveBtcDrivenPresets.aggressive).toBeDefined();
    expect(mockAppConfigDoc._doc.autoReserveBtcDrivenPresets.conservative.stepReserveUsdt).toBe(6);
  });

  test('12) writes defaults when presets is undefined', async () => {
    resetMockDoc({ key: 'singleton' });
    const AppConfig = makeMockAppConfig();
    const { migrateBtcDrivenPresets } = getRepair();

    const result = await migrateBtcDrivenPresets({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(true);
  });

  test('13) no-op when presets is valid (both keys present)', async () => {
    resetMockDoc({
      key: 'singleton',
      autoReserveBtcDrivenPresets: {
        conservative: { poleCount: 3, usdtPerPole: 7, lossThresholdPct: 3, checkHours: 4, stepReserveUsdt: 7, stepReleaseUsdt: 7 },
        aggressive:   { poleCount: 6, usdtPerPole: 12, lossThresholdPct: 2, checkHours: 2, stepReserveUsdt: 12, stepReleaseUsdt: 12 },
      },
    });
    const AppConfig = makeMockAppConfig();
    const { migrateBtcDrivenPresets } = getRepair();

    const result = await migrateBtcDrivenPresets({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(false);
    expect(AppConfig.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('14) writes defaults when only conservative key present (partial)', async () => {
    resetMockDoc({
      key: 'singleton',
      autoReserveBtcDrivenPresets: {
        conservative: { poleCount: 3 },
        // aggressive missing
      },
    });
    const AppConfig = makeMockAppConfig();
    const { migrateBtcDrivenPresets } = getRepair();

    const result = await migrateBtcDrivenPresets({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(true);
    expect(mockAppConfigDoc._doc.autoReserveBtcDrivenPresets.aggressive).toBeDefined();
  });

  test('15) no-op when no doc exists', async () => {
    resetMockDoc(null);
    const AppConfig = makeMockAppConfig();
    const { migrateBtcDrivenPresets } = getRepair();

    const result = await migrateBtcDrivenPresets({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(false);
  });

  test('16) handles missing AppConfig gracefully', async () => {
    const { migrateBtcDrivenPresets } = getRepair();
    const result = await migrateBtcDrivenPresets({ AppConfig: null, logger: noopLogger });
    expect(result.migrated).toBe(false);
    expect(result.error).toMatch(/missing/);
  });
});

describe('FIX-2026-09-29 migratePresetsSubFields', () => {
  beforeEach(() => {
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
  });

  test('17) mirrors legacy stepUsdt=15 inside preset to stepReserveUsdt + stepReleaseUsdt', async () => {
    // Round 2 had presets with single `stepUsdt`. Round 3 splits it.
    resetMockDoc({
      key: 'singleton',
      autoReserveBtcDrivenPresets: {
        conservative: { poleCount: 2, usdtPerPole: 6, lossThresholdPct: 4, checkHours: 6, stepUsdt: 15 },
        aggressive:   { poleCount: 5, usdtPerPole: 9, lossThresholdPct: 2, checkHours: 2, stepUsdt: 20 },
      },
    });
    const AppConfig = makeMockAppConfig();
    const { migratePresetsSubFields } = getRepair();

    const result = await migratePresetsSubFields({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(true);

    const cons = mockAppConfigDoc._doc.autoReserveBtcDrivenPresets.conservative;
    expect(cons.stepReserveUsdt).toBe(15);
    expect(cons.stepReleaseUsdt).toBe(15);
    expect(cons.stepUsdt).toBe(15); // legacy preserved

    const agg = mockAppConfigDoc._doc.autoReserveBtcDrivenPresets.aggressive;
    expect(agg.stepReserveUsdt).toBe(20);
    expect(agg.stepReleaseUsdt).toBe(20);
    expect(agg.stepUsdt).toBe(20);
  });

  test('18) no-op when presets already have split fields (round 3 docs)', async () => {
    resetMockDoc({
      key: 'singleton',
      autoReserveBtcDrivenPresets: {
        conservative: { poleCount: 2, usdtPerPole: 6, lossThresholdPct: 4, checkHours: 6, stepReserveUsdt: 7, stepReleaseUsdt: 8 },
        aggressive:   { poleCount: 5, usdtPerPole: 9, lossThresholdPct: 2, checkHours: 2, stepReserveUsdt: 12, stepReleaseUsdt: 14 },
      },
    });
    const AppConfig = makeMockAppConfig();
    const { migratePresetsSubFields } = getRepair();

    const result = await migratePresetsSubFields({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(false);
    expect(AppConfig.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('19) mixed — one preset has stepUsdt, other already split → only mirror first', async () => {
    resetMockDoc({
      key: 'singleton',
      autoReserveBtcDrivenPresets: {
        conservative: { poleCount: 2, stepUsdt: 6 }, // legacy
        aggressive: { poleCount: 5, stepReserveUsdt: 9, stepReleaseUsdt: 11 }, // already split
      },
    });
    const AppConfig = makeMockAppConfig();
    const { migratePresetsSubFields } = getRepair();

    const result = await migratePresetsSubFields({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(true);

    const cons = mockAppConfigDoc._doc.autoReserveBtcDrivenPresets.conservative;
    expect(cons.stepReserveUsdt).toBe(6);
    expect(cons.stepReleaseUsdt).toBe(6);

    const agg = mockAppConfigDoc._doc.autoReserveBtcDrivenPresets.aggressive;
    expect(agg.stepReserveUsdt).toBe(9); // preserved
    expect(agg.stepReleaseUsdt).toBe(11); // preserved
  });

  test('20) legacy stepUsdt out-of-range is ignored → skip that preset', async () => {
    resetMockDoc({
      key: 'singleton',
      autoReserveBtcDrivenPresets: {
        conservative: { poleCount: 2, stepUsdt: 999999 }, // invalid
        aggressive:   { poleCount: 5, stepUsdt: 8 }, // valid
      },
    });
    const AppConfig = makeMockAppConfig();
    const { migratePresetsSubFields } = getRepair();

    const result = await migratePresetsSubFields({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(true);

    // Conservative preserved as-is (out-of-range legacy ignored)
    expect(mockAppConfigDoc._doc.autoReserveBtcDrivenPresets.conservative.stepReserveUsdt).toBeUndefined();
    // Aggressive migrated
    expect(mockAppConfigDoc._doc.autoReserveBtcDrivenPresets.aggressive.stepReserveUsdt).toBe(8);
    expect(mockAppConfigDoc._doc.autoReserveBtcDrivenPresets.aggressive.stepReleaseUsdt).toBe(8);
  });

  test('21) no-op when presets is null/undefined', async () => {
    resetMockDoc({ key: 'singleton' });
    const AppConfig = makeMockAppConfig();
    const { migratePresetsSubFields } = getRepair();

    const result = await migratePresetsSubFields({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(false);
  });

  test('22) no-op when no doc exists', async () => {
    resetMockDoc(null);
    const AppConfig = makeMockAppConfig();
    const { migratePresetsSubFields } = getRepair();

    const result = await migratePresetsSubFields({ AppConfig, logger: noopLogger });
    expect(result.migrated).toBe(false);
  });

  test('23) handles missing AppConfig gracefully', async () => {
    const { migratePresetsSubFields } = getRepair();
    const result = await migratePresetsSubFields({ AppConfig: null, logger: noopLogger });
    expect(result.migrated).toBe(false);
    expect(result.error).toMatch(/missing/);
  });
});

describe('FIX-2026-09-29 idempotency — all 4 functions second-run no-op', () => {
  beforeEach(() => {
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
  });

  test('24) run all 4 migrations twice — second run is no-op for all', async () => {
    // Setup: legacy doc with no new fields, legacy stepUsdt=7
    resetMockDoc({
      key: 'singleton',
      autoReserveStepUsdt: 7,
      autoReserveBtcDrivenPresets: {
        conservative: { poleCount: 2, stepUsdt: 7 },
        aggressive:   { poleCount: 5, stepUsdt: 9 },
      },
    });
    const AppConfig = makeMockAppConfig();
    const { bootstrapAppConfigDefaults, migrateSplitStepFields, migrateBtcDrivenPresets, migratePresetsSubFields } = getRepair();

    // Run 1
    const b1 = await bootstrapAppConfigDefaults({ AppConfig, logger: noopLogger });
    const m1 = await migrateSplitStepFields({ AppConfig, logger: noopLogger });
    const p1 = await migrateBtcDrivenPresets({ AppConfig, logger: noopLogger });
    const s1 = await migratePresetsSubFields({ AppConfig, logger: noopLogger });

    expect(b1.created).toBe(false); // doc exists
    expect(m1.migrated).toBe(true);
    expect(p1.migrated).toBe(false); // presets valid
    expect(s1.migrated).toBe(true);

    // Capture write counts
    const writesAfterRun1 = AppConfig.findOneAndUpdate.mock.calls.length;

    // Run 2 — should be all no-ops
    const b2 = await bootstrapAppConfigDefaults({ AppConfig, logger: noopLogger });
    const m2 = await migrateSplitStepFields({ AppConfig, logger: noopLogger });
    const p2 = await migrateBtcDrivenPresets({ AppConfig, logger: noopLogger });
    const s2 = await migratePresetsSubFields({ AppConfig, logger: noopLogger });

    expect(b2.created).toBe(false);
    expect(m2.migrated).toBe(false);
    expect(p2.migrated).toBe(false);
    expect(s2.migrated).toBe(false);

    // No additional writes
    expect(AppConfig.findOneAndUpdate.mock.calls.length).toBe(writesAfterRun1);
  });
});
