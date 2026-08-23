'use strict';

/**
 * FIX-2026-08-14: Unit tests for botConfigIO helper
 *
 * Pure-function tests (no DB, no Express). Mirrors masterConfigTemplates.test.js style.
 * Covers: constants, buildExportPayload shape, sanitizeImportSettings (with type coercion),
 * checkMutuallyExclusive rules, validateImportPayload (version/type/shape), and a full
 * export→parse→sanitize round-trip.
 */

const {
  SCHEMA_VERSION,
  MAX_FILE_BYTES,
  ALLOWED_IMPORT_TYPES,
  ALLOWED_FIELD_KEYS,
  NUMBER_FIELDS,
  BOOLEAN_FIELDS,
  STRING_FIELDS,
  buildExportPayload,
  sanitizeImportSettings,
  checkMutuallyExclusive,
  validateImportPayload,
} = require('../src/services/botConfigIO');

describe('botConfigIO — constants', () => {
  test('SCHEMA_VERSION = 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
  test('MAX_FILE_BYTES = 1 MiB', () => {
    expect(MAX_FILE_BYTES).toBe(1_048_576);
  });
  test('ALLOWED_IMPORT_TYPES has exactly 3 entries', () => {
    expect(ALLOWED_IMPORT_TYPES).toHaveLength(3);
    expect(ALLOWED_IMPORT_TYPES).toEqual(['bot', 'master-template', 'bot-defaults']);
  });
  test('ALLOWED_FIELD_KEYS has expected size + no duplicates', () => {
    // 50 masterConfigTemplates + 2 new (defaultSymbol, defaultTimeframe) = 52
    expect(ALLOWED_FIELD_KEYS.length).toBeGreaterThanOrEqual(50);
    const set = new Set(ALLOWED_FIELD_KEYS);
    expect(set.size).toBe(ALLOWED_FIELD_KEYS.length);
  });
  test('ALLOWED_FIELD_KEYS contains all CBv5 advanced keys', () => {
    ['cbv5Enabled', 'cbv5LockHours', 'cbv5KcLen', 'cbv5KcMult',
      'cbv5PivotLookback', 'cbv5PivotLeftLen', 'cbv5PivotRightLen',
      'cbv5StrictBreak', 'cbv5UseVolume', 'cbv5VolMaLen',
      'cbv5VolMultiplier', 'cbv5DebounceCandles',
    ].forEach((k) => expect(ALLOWED_FIELD_KEYS).toContain(k));
  });
  test('ALLOWED_FIELD_KEYS contains bot defaults keys (new in this PR)', () => {
    expect(ALLOWED_FIELD_KEYS).toContain('defaultSymbol');
    expect(ALLOWED_FIELD_KEYS).toContain('defaultTimeframe');
  });
  test('NUMBER_FIELDS / BOOLEAN_FIELDS / STRING_FIELDS are disjoint Sets', () => {
    const num = [...NUMBER_FIELDS];
    const bool = [...BOOLEAN_FIELDS];
    const str = [...STRING_FIELDS];
    num.forEach((k) => {
      expect(BOOLEAN_FIELDS.has(k)).toBe(false);
      expect(STRING_FIELDS.has(k)).toBe(false);
    });
    bool.forEach((k) => {
      expect(NUMBER_FIELDS.has(k)).toBe(false);
      expect(STRING_FIELDS.has(k)).toBe(false);
    });
    str.forEach((k) => {
      expect(NUMBER_FIELDS.has(k)).toBe(false);
      expect(BOOLEAN_FIELDS.has(k)).toBe(false);
    });
  });
});

describe('botConfigIO — buildExportPayload', () => {
  test('returns schemaVersion=1 + correct type + ISO exportedAt', () => {
    const p = buildExportPayload({ type: 'bot', settings: { kcMult: 1.5 } });
    expect(p.schemaVersion).toBe(1);
    expect(p.type).toBe('bot');
    expect(typeof p.exportedAt).toBe('string');
    expect(() => new Date(p.exportedAt).toISOString()).not.toThrow();
  });
  test('meta.fieldCount equals settings key count', () => {
    const p = buildExportPayload({ type: 'master-template', settings: { a: 1, b: 2, c: 3 } });
    expect(p.meta.fieldCount).toBe(3);
  });
  test('passes through meta fields verbatim', () => {
    const p = buildExportPayload({
      type: 'bot',
      source: 'bot-edit',
      botSymbol: 'BTCUSDT',
      botTimeframe: '5m',
      cbVersion: 'v3',
      settings: { kcMult: 1.5 },
    });
    expect(p.meta.source).toBe('bot-edit');
    expect(p.meta.botSymbol).toBe('BTCUSDT');
    expect(p.meta.botTimeframe).toBe('5m');
    expect(p.meta.cbVersion).toBe('v3');
  });
  test('null name → fallback "Unnamed"', () => {
    expect(buildExportPayload({ name: null }).name).toBe('Unnamed');
    expect(buildExportPayload({}).name).toBe('Unnamed');
  });
  test('empty settings → fieldCount=0', () => {
    expect(buildExportPayload({ type: 'bot-defaults' }).meta.fieldCount).toBe(0);
  });
  test('null/undefined settings → empty object (defensive)', () => {
    expect(buildExportPayload({ type: 'bot', settings: null }).settings).toEqual({});
    expect(buildExportPayload({ type: 'bot', settings: undefined }).settings).toEqual({});
    expect(buildExportPayload({ type: 'bot', settings: 'x' }).settings).toEqual({});
    expect(buildExportPayload({ type: 'bot', settings: [1, 2] }).settings).toEqual({});
  });
  test('default type = "master-template"', () => {
    expect(buildExportPayload({ settings: {} }).type).toBe('master-template');
  });
});

describe('botConfigIO — sanitizeImportSettings', () => {
  test('drops unknown keys + counts dropped', () => {
    const r = sanitizeImportSettings({
      capitalPerTrade: 12,
      cbEnabled: true,
      rogueField: 'x',
      evil: null,
      constructor: 'polluted',
    });
    expect(r.settings).toEqual({ capitalPerTrade: 12, cbEnabled: true });
    expect(r.dropped).toBe(3);
  });
  test('non-object → empty settings', () => {
    expect(sanitizeImportSettings(null).settings).toEqual({});
    expect(sanitizeImportSettings(undefined).settings).toEqual({});
    expect(sanitizeImportSettings([]).settings).toEqual({});
    expect(sanitizeImportSettings('x').settings).toEqual({});
    expect(sanitizeImportSettings(42).settings).toEqual({});
  });
  test('coerces string numbers → numbers for NUMBER_FIELDS', () => {
    const r = sanitizeImportSettings({ capitalPerTrade: '12', kcMult: '1.7' });
    expect(r.settings.capitalPerTrade).toBe(12);
    expect(r.settings.kcMult).toBe(1.7);
    expect(r.dropped).toBe(0);
  });
  test('drops non-numeric values for NUMBER_FIELDS', () => {
    const r = sanitizeImportSettings({ capitalPerTrade: 'abc', kcMult: null });
    expect(r.dropped).toBe(2);
    expect(r.settings).toEqual({});
  });
  test('coerces string booleans → booleans for BOOLEAN_FIELDS', () => {
    const r = sanitizeImportSettings({
      cbEnabled: 'true',
      dcaEnabled: 'false',
      xs1Enabled: '1',
      s1OnlyDown: '0',
    });
    expect(r.settings.cbEnabled).toBe(true);
    expect(r.settings.dcaEnabled).toBe(false);
    expect(r.settings.xs1Enabled).toBe(true);
    expect(r.settings.s1OnlyDown).toBe(false);
    expect(r.dropped).toBe(0);
  });
  test('preserves null for STRING_FIELDS', () => {
    const r = sanitizeImportSettings({ defaultSymbol: null, defaultTimeframe: null });
    expect(r.settings.defaultSymbol).toBeNull();
    expect(r.settings.defaultTimeframe).toBeNull();
    expect(r.dropped).toBe(0);
  });
  test('preserves string values for STRING_FIELDS', () => {
    const r = sanitizeImportSettings({ defaultSymbol: 'BTCUSDT', timeframe: '5m' });
    expect(r.settings.defaultSymbol).toBe('BTCUSDT');
    expect(r.settings.timeframe).toBe('5m');
  });
  test('all-known payload → dropped = 0', () => {
    const all = {};
    ALLOWED_FIELD_KEYS.forEach((k) => {
      if (NUMBER_FIELDS.has(k)) all[k] = 1;
      else if (BOOLEAN_FIELDS.has(k)) all[k] = true;
      else if (STRING_FIELDS.has(k)) all[k] = 'x';
    });
    const r = sanitizeImportSettings(all);
    expect(r.dropped).toBe(0);
    expect(Object.keys(r.settings)).toHaveLength(ALLOWED_FIELD_KEYS.length);
  });
});

describe('botConfigIO — checkMutuallyExclusive', () => {
  test('Martingale=true + DCA=false → 1 warning', () => {
    const warnings = checkMutuallyExclusive({ martingaleEnabled: true, dcaEnabled: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Martingale requires DCA/);
  });
  test('DPS=true + DCA=true → 1 warning', () => {
    const warnings = checkMutuallyExclusive({ dynamicSizeEnabled: true, dcaEnabled: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/DPS.*exclusive/);
  });
  test('DPS=true + Martingale=true → 1 warning', () => {
    const warnings = checkMutuallyExclusive({ dynamicSizeEnabled: true, martingaleEnabled: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/DPS.*exclusive/);
  });
  test('DPS=false + DCA=true → 0 warnings', () => {
    expect(checkMutuallyExclusive({ dynamicSizeEnabled: false, dcaEnabled: true })).toEqual([]);
  });
  test('CB=false + AutoUnlock=true → 1 warning', () => {
    const warnings = checkMutuallyExclusive({
      cbEnabled: false,
      cbAutoUnlockEnabled: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/CB Auto-Unlock/);
  });
  test('all-consistent → 0 warnings', () => {
    expect(checkMutuallyExclusive({
      dcaEnabled: true,
      martingaleEnabled: true,
      dynamicSizeEnabled: false,
      cbEnabled: true,
      cbAutoUnlockEnabled: false,
    })).toEqual([]);
  });
  test('empty / null → 0 warnings', () => {
    expect(checkMutuallyExclusive({})).toEqual([]);
    expect(checkMutuallyExclusive(null)).toEqual([]);
    expect(checkMutuallyExclusive(undefined)).toEqual([]);
  });
  test('multiple conflicts → multiple warnings', () => {
    const warnings = checkMutuallyExclusive({
      martingaleEnabled: true,
      dcaEnabled: false,
      dynamicSizeEnabled: true,
    });
    // Martingale+DCA missing → 1
    // DPS with Martingale → 1
    expect(warnings).toHaveLength(2);
  });
});

describe('botConfigIO — validateImportPayload', () => {
  const validPayload = {
    schemaVersion: 1,
    type: 'master-template',
    exportedAt: '2026-08-14T12:00:00.000Z',
    name: 'Test',
    meta: { source: 'master-config', fieldCount: 0 },
    settings: { kcMult: 1.5 },
  };

  test('accepts valid payload', () => {
    const r = validateImportPayload(validPayload);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });
  test('rejects non-object', () => {
    expect(validateImportPayload(null).ok).toBe(false);
    expect(validateImportPayload(undefined).ok).toBe(false);
    expect(validateImportPayload('x').ok).toBe(false);
    expect(validateImportPayload(42).ok).toBe(false);
    expect(validateImportPayload([1, 2]).ok).toBe(false);
  });
  test('rejects missing schemaVersion', () => {
    const r = validateImportPayload({ ...validPayload, schemaVersion: undefined });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/schemaVersion/);
  });
  test('rejects unsupported schemaVersion', () => {
    const r = validateImportPayload({ ...validPayload, schemaVersion: 99 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/99/);
    expect(r.error).toMatch(/expects 1/);
  });
  test('rejects unknown type', () => {
    const r = validateImportPayload({ ...validPayload, type: 'hack' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unknown type/);
  });
  test('rejects missing settings', () => {
    const r = validateImportPayload({ ...validPayload, settings: null });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/settings/);
  });
  test('rejects non-object settings', () => {
    const r = validateImportPayload({ ...validPayload, settings: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/settings/);
  });
  test('accepts empty settings {}', () => {
    const r = validateImportPayload({ ...validPayload, settings: {} });
    expect(r.ok).toBe(true);
  });
  test('includes warnings from checkMutuallyExclusive', () => {
    const r = validateImportPayload({
      ...validPayload,
      settings: { martingaleEnabled: true, dcaEnabled: false },
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
  });
});

describe('botConfigIO — full round-trip (export → parse → sanitize)', () => {
  test('export → JSON.stringify → JSON.parse → sanitize → equal settings', () => {
    const original = {
      kcMult: 1.7,
      capitalPerTrade: 12,
      cbEnabled: true,
      dcaEnabled: false,
      cbv5KcMult: 1.2,
      defaultSymbol: 'BTCUSDT',
      defaultTimeframe: '5m',
    };
    const payload = buildExportPayload({ type: 'bot', settings: original });
    const text = JSON.stringify(payload);
    const parsed = JSON.parse(text);
    const r = validateImportPayload(parsed);
    expect(r.ok).toBe(true);
    const sanitized = sanitizeImportSettings(r.payload.settings);
    expect(sanitized.settings).toEqual(original);
    expect(sanitized.dropped).toBe(0);
  });

  test('round-trip with string-typed numbers + booleans (defensive coercion)', () => {
    const original = {
      kcMult: 1.7,
      cbEnabled: 'true',
      dcaEnabled: 'false',
    };
    const payload = buildExportPayload({ type: 'master-template', settings: original });
    const parsed = JSON.parse(JSON.stringify(payload));
    const r = validateImportPayload(parsed);
    const sanitized = sanitizeImportSettings(r.payload.settings);
    expect(sanitized.settings.kcMult).toBe(1.7);
    expect(sanitized.settings.cbEnabled).toBe(true);
    expect(sanitized.settings.dcaEnabled).toBe(false);
  });

  test('backward compat: 50-key file (no defaultSymbol/defaultTimeframe) still parses', () => {
    // Simulates an export from before this PR existed
    const oldPayload = {
      schemaVersion: 1,
      type: 'master-template',
      exportedAt: '2026-08-13T00:00:00.000Z',
      name: 'Old preset',
      meta: { source: 'master-config', fieldCount: 2 },
      settings: { kcMult: 1.5, cbEnabled: true },
    };
    const r = validateImportPayload(oldPayload);
    expect(r.ok).toBe(true);
    const sanitized = sanitizeImportSettings(r.payload.settings);
    expect(sanitized.settings).toEqual({ kcMult: 1.5, cbEnabled: true });
    expect(sanitized.dropped).toBe(0);
  });

  test('drops rogue keys silently on round-trip', () => {
    const payload = buildExportPayload({
      type: 'master-template',
      settings: { kcMult: 1.5, name: 'should be dropped', enabled: false, evil: null },
    });
    const parsed = JSON.parse(JSON.stringify(payload));
    const r = validateImportPayload(parsed);
    const sanitized = sanitizeImportSettings(r.payload.settings);
    expect(sanitized.dropped).toBe(3); // name + enabled + evil
    expect(sanitized.settings).toEqual({ kcMult: 1.5 });
  });
});
