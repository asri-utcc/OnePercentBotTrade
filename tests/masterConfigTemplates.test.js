'use strict';

/**
 * FIX-2026-08-13: Unit tests for masterConfigTemplates helper
 *
 * Pure-function tests (no DB, no Express). Mirrors src/services/botDefaults.js style.
 * Covers: constants, name validation/normalize, settings whitelist sanitization,
 * name uniqueness (case-insensitive + excludeId for renames), ID generation,
 * metadata projection, and a full CRUD round-trip simulation.
 */

const {
  MAX_TEMPLATES,
  MAX_NAME_LEN,
  ALLOWED_TEMPLATE_FIELDS,
  newTemplateId,
  normalizeName,
  validateName,
  sanitizeSettings,
  findById,
  findIndexById,
  isNameTaken,
  buildEntry,
  toMetadataList,
} = require('../src/services/masterConfigTemplates');

describe('masterConfigTemplates — constants', () => {
  test('MAX_TEMPLATES cap = 50', () => {
    expect(MAX_TEMPLATES).toBe(50);
  });
  test('MAX_NAME_LEN = 50', () => {
    expect(MAX_NAME_LEN).toBe(50);
  });
  test('whitelist contains expected numeric + select + boolean keys', () => {
    expect(ALLOWED_TEMPLATE_FIELDS).toContain('capitalPerTrade');
    expect(ALLOWED_TEMPLATE_FIELDS).toContain('timeframe');
    expect(ALLOWED_TEMPLATE_FIELDS).toContain('cbEnabled');
    expect(ALLOWED_TEMPLATE_FIELDS).toContain('cbv3Enabled');
    expect(ALLOWED_TEMPLATE_FIELDS).toContain('cbv5KcLen');
    expect(ALLOWED_TEMPLATE_FIELDS).toContain('cbv5DebounceCandles');
    expect(ALLOWED_TEMPLATE_FIELDS).toContain('dcaEnabled');
    expect(ALLOWED_TEMPLATE_FIELDS).toContain('martingaleEnabled');
    // FIX-2026-08-14: Bot Defaults keys added for cross-surface import/export
    expect(ALLOWED_TEMPLATE_FIELDS).toContain('defaultSymbol');
    expect(ALLOWED_TEMPLATE_FIELDS).toContain('defaultTimeframe');
  });
  test('whitelist has no duplicate keys', () => {
    const set = new Set(ALLOWED_TEMPLATE_FIELDS);
    expect(set.size).toBe(ALLOWED_TEMPLATE_FIELDS.length);
  });
});

describe('masterConfigTemplates — normalizeName + validateName', () => {
  test('collapses internal whitespace + trims edges', () => {
    expect(normalizeName('  hello   world  ')).toBe('hello world');
    expect(normalizeName('a\t\nb  c')).toBe('a b c');
  });
  test('non-string returns empty string', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName(123)).toBe('');
    expect(normalizeName({})).toBe('');
  });
  test('validateName rejects empty / whitespace-only', () => {
    expect(validateName('').ok).toBe(false);
    expect(validateName('   ').ok).toBe(false);
    expect(validateName(null).ok).toBe(false);
  });
  test('validateName rejects name > 50 chars', () => {
    expect(validateName('x'.repeat(51)).ok).toBe(false);
    expect(validateName('x'.repeat(51)).error).toMatch(/max 50/);
  });
  test('validateName accepts exactly 50 chars', () => {
    expect(validateName('x'.repeat(50)).ok).toBe(true);
    expect(validateName('x'.repeat(50)).name).toHaveLength(50);
  });
  test('validateName returns trimmed name on success', () => {
    const r = validateName('  My Preset  ');
    expect(r.ok).toBe(true);
    expect(r.name).toBe('My Preset');
  });
  test('validateName error messages contain useful info', () => {
    expect(validateName('').error).toMatch(/required/i);
    expect(validateName('a'.repeat(99)).error).toMatch(/50/);
  });
});

describe('masterConfigTemplates — sanitizeSettings (field whitelist)', () => {
  test('keeps only known keys, drops rest, counts dropped', () => {
    const r = sanitizeSettings({
      capitalPerTrade: 12,
      cbEnabled: true,
      rogueField: 'x',
      evil: null,
      constructor: 'polluted',
    });
    expect(r.settings).toEqual({ capitalPerTrade: 12, cbEnabled: true });
    expect(r.dropped).toBe(3); // rogueField + evil + constructor
  });
  test('non-object → empty settings', () => {
    expect(sanitizeSettings(null).settings).toEqual({});
    expect(sanitizeSettings(undefined).settings).toEqual({});
    expect(sanitizeSettings([]).settings).toEqual({});
    expect(sanitizeSettings('x').settings).toEqual({});
    expect(sanitizeSettings(42).settings).toEqual({});
  });
  test('preserves value types (number, boolean, string)', () => {
    const r = sanitizeSettings({
      capitalPerTrade: 12.5,
      cbEnabled: false,
      timeframe: '5m',
    });
    expect(r.settings.capitalPerTrade).toBe(12.5);
    expect(r.settings.cbEnabled).toBe(false);
    expect(r.settings.timeframe).toBe('5m');
    expect(r.dropped).toBe(0);
  });
  test('all-known payload → dropped = 0', () => {
    const all = {};
    ALLOWED_TEMPLATE_FIELDS.forEach((k) => { all[k] = 1; });
    const r = sanitizeSettings(all);
    expect(r.dropped).toBe(0);
    expect(Object.keys(r.settings)).toHaveLength(ALLOWED_TEMPLATE_FIELDS.length);
  });
});

describe('masterConfigTemplates — name uniqueness (case-insensitive)', () => {
  const list = [
    { id: 'a', name: 'Conservative' },
    { id: 'b', name: 'Aggressive' },
    { id: 'c', name: 'Scalper  v2' },
  ];

  test('exact duplicate is taken', () => {
    expect(isNameTaken(list, 'Conservative')).toBe(true);
  });
  test('case-insensitive duplicate', () => {
    expect(isNameTaken(list, 'CONSERVATIVE')).toBe(true);
    expect(isNameTaken(list, 'aggressive')).toBe(true);
    expect(isNameTaken(list, 'AgGrEsSiVe')).toBe(true);
  });
  test('trim + collapse before compare', () => {
    expect(isNameTaken(list, '  Conservative  ')).toBe(true);
    expect(isNameTaken(list, 'Scalper    v2')).toBe(true);
    expect(isNameTaken(list, 'Scalper v3')).toBe(false);
  });
  test('excludeId allows rename to same name', () => {
    expect(isNameTaken(list, 'Conservative', 'a')).toBe(false);
    expect(isNameTaken(list, 'Aggressive', 'a')).toBe(true);
  });
  test('null/empty list → never taken', () => {
    expect(isNameTaken([], 'x')).toBe(false);
    expect(isNameTaken(null, 'x')).toBe(false);
    expect(isNameTaken(undefined, 'x')).toBe(false);
  });
  test('empty normalized name → never taken', () => {
    expect(isNameTaken(list, '')).toBe(false);
    expect(isNameTaken(list, '   ')).toBe(false);
    expect(isNameTaken(list, null)).toBe(false);
  });
});

describe('masterConfigTemplates — findById / findIndexById', () => {
  const list = [
    { id: 'a', name: 'X' },
    { id: 'b', name: 'Y' },
    { id: 'c', name: 'Z' },
  ];

  test('findById returns matching entry', () => {
    expect(findById(list, 'b').name).toBe('Y');
    expect(findById(list, 'a').id).toBe('a');
  });
  test('findById returns null on miss', () => {
    expect(findById(list, 'nope')).toBeNull();
    expect(findById(list, '')).toBeNull();
  });
  test('findById null-safe', () => {
    expect(findById(null, 'a')).toBeNull();
    expect(findById(undefined, 'a')).toBeNull();
  });
  test('findIndexById returns index', () => {
    expect(findIndexById(list, 'a')).toBe(0);
    expect(findIndexById(list, 'b')).toBe(1);
    expect(findIndexById(list, 'c')).toBe(2);
  });
  test('findIndexById returns -1 on miss + null-safe', () => {
    expect(findIndexById(list, 'nope')).toBe(-1);
    expect(findIndexById(null, 'a')).toBe(-1);
    expect(findIndexById(undefined, 'a')).toBe(-1);
  });
});

describe('masterConfigTemplates — buildEntry + newTemplateId + toMetadataList', () => {
  test('buildEntry generates uuid + sets timestamps', () => {
    const before = Date.now();
    const e = buildEntry({ name: 'Test', settings: { x: 1 } });
    const after = Date.now();
    expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(e.name).toBe('Test');
    expect(e.settings).toEqual({ x: 1 });
    expect(e.createdAt).toBeInstanceOf(Date);
    expect(e.updatedAt).toBeInstanceOf(Date);
    expect(e.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(e.createdAt.getTime()).toBeLessThanOrEqual(after);
  });
  test('newTemplateId returns unique ids across calls', () => {
    const a = newTemplateId();
    const b = newTemplateId();
    const c = newTemplateId();
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });
  test('toMetadataList strips settings + adds fieldCount', () => {
    const list = [{
      id: 'a',
      name: 'X',
      settings: { k1: 1, k2: 2, k3: 3 },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-02-01'),
    }];
    const meta = toMetadataList(list);
    expect(meta).toHaveLength(1);
    expect(meta[0]).toEqual({
      id: 'a',
      name: 'X',
      fieldCount: 3,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(meta[0].settings).toBeUndefined();
  });
  test('toMetadataList handles null + missing settings', () => {
    expect(toMetadataList(null)).toEqual([]);
    expect(toMetadataList(undefined)).toEqual([]);
    expect(toMetadataList([])).toEqual([]);
    expect(toMetadataList([{ id: 'a', name: 'X' }])[0].fieldCount).toBe(0);
    expect(toMetadataList([{ id: 'a', name: 'X', settings: null }])[0].fieldCount).toBe(0);
    expect(toMetadataList([{ id: 'a', name: 'X', settings: 'not-an-object' }])[0].fieldCount).toBe(0);
  });
});

describe('masterConfigTemplates — full CRUD round-trip (pure simulation, no DB)', () => {
  // Simulates: create → list (metadata) → duplicate → rename → update settings → delete
  // Each "operation" mutates an in-memory array; mirrors the route handlers' logic.

  function _create(list, name, settings) {
    const v = validateName(name);
    if (!v.ok) throw new Error(v.error);
    if (isNameTaken(list, v.name)) throw new Error('ชื่อซ้ำ');
    const { settings: s } = sanitizeSettings(settings);
    if (Object.keys(s).length === 0) throw new Error('empty settings');
    const entry = buildEntry({ name: v.name, settings: s });
    list.push(entry);
    return entry;
  }

  function _deleteById(list, id) {
    const idx = findIndexById(list, id);
    if (idx === -1) throw new Error('not found');
    list.splice(idx, 1);
  }

  function _rename(list, id, newName) {
    const v = validateName(newName);
    if (!v.ok) throw new Error(v.error);
    if (isNameTaken(list, v.name, id)) throw new Error('duplicate');
    const entry = findById(list, id);
    entry.name = v.name;
    entry.updatedAt = new Date();
  }

  function _updateSettings(list, id, newSettings) {
    const { settings } = sanitizeSettings(newSettings);
    if (Object.keys(settings).length === 0) throw new Error('empty');
    const entry = findById(list, id);
    entry.settings = settings;
    entry.updatedAt = new Date();
  }

  test('round-trip preserves invariants', () => {
    let list = [];

    // CREATE
    const e1 = _create(list, ' Conservative ', { kcMult: 1.7, cbEnabled: true });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Conservative');
    expect(list[0].id).toBeDefined();

    // CREATE another
    _create(list, 'Aggressive', { kcMult: 2.5 });
    expect(list).toHaveLength(2);

    // DUPLICATE (different name)
    const dupName = 'Conservative (copy)';
    const dup = _create(list, dupName, list[0].settings);
    expect(list).toHaveLength(3);
    expect(dup.name).toBe(dupName);
    expect(dup.settings).toEqual(list[0].settings);

    // RENAME
    _rename(list, e1.id, 'Conservative v2');
    expect(findById(list, e1.id).name).toBe('Conservative v2');

    // RENAME same to same → ok (excludeId)
    _rename(list, e1.id, 'Conservative v2');
    expect(findById(list, e1.id).name).toBe('Conservative v2');

    // RENAME to existing name → throws
    expect(() => _rename(list, e1.id, 'Aggressive')).toThrow(/duplicate/);

    // UPDATE settings
    _updateSettings(list, e1.id, { kcMult: 1.5, tpPercent: 0.3, rogueField: 'x' });
    const updated = findById(list, e1.id);
    expect(updated.settings).toEqual({ kcMult: 1.5, tpPercent: 0.3 });
    expect(updated.settings.rogueField).toBeUndefined();

    // GET metadata
    const meta = toMetadataList(list);
    expect(meta).toHaveLength(3);
    expect(meta[0].fieldCount).toBe(2); // kcMult + tpPercent

    // DELETE
    _deleteById(list, dup.id);
    expect(list).toHaveLength(2);
    expect(findById(list, dup.id)).toBeNull();

    // Final invariants
    expect(findById(list, e1.id).name).toBe('Conservative v2');
    expect(findById(list, e1.id).settings.kcMult).toBe(1.5);
  });

  test('rejects empty settings on create', () => {
    expect(() => _create([], 'X', {})).toThrow(/empty/);
    expect(() => _create([], 'X', { rogueField: 'dropped' })).toThrow(/empty/);
  });

  test('rejects duplicate name on create', () => {
    const list = [];
    _create(list, 'X', { kcMult: 1 });
    expect(() => _create(list, 'x', { kcMult: 2 })).toThrow(/ซ้ำ/);
    expect(() => _create(list, ' X ', { kcMult: 2 })).toThrow(/ซ้ำ/);
  });

  test('rejects empty name on create', () => {
    expect(() => _create([], '', { kcMult: 1 })).toThrow(/required/);
    expect(() => _create([], '   ', { kcMult: 1 })).toThrow(/required/);
  });

  test('rejects name > 50 chars on create', () => {
    expect(() => _create([], 'a'.repeat(51), { kcMult: 1 })).toThrow(/50/);
  });
});
