'use strict';

/**
 * FIX-2026-09-01 audit H15: PUT /api/admin/app-config — unknown keys are no
 * longer silently dropped.
 *
 *   Before: the route's whitelist loop only iterated over keys that were in
 *   the whitelist. Any key in req.body that wasn't on the whitelist was
 *   silently ignored. The admin UI then reported "saved" but the field never
 *   landed in MongoDB → "I changed DPS but it's still using the old value"
 *   bug reports.
 *
 *   Fix:
 *     1. After building the whitelist set, scan req.body for keys that are
 *        NOT in the whitelist → collect as `unknownKeys`.
 *     2. Also catch type-mismatches (whitelisted key but wrong JS type →
 *        Number.isFinite(parseFloat(...)) === false for a 'number' field).
 *     3. Include `unknownKeys` in the response when non-empty so the admin
 *        UI can show a warning toast.
 *     4. Log a `warn` line for each PUT that includes rejected keys.
 *
 *   Tests:
 *     1. Source-level: code paths exist + FIX comment + response shape.
 *     2. Runtime replica: re-implement the whitelist processor and assert
 *        unknownKey detection + type-mismatch capture.
 */

const fs = require('fs');
const path = require('path');

const ADMIN_PATH = path.join(__dirname, '..', 'src', 'api', 'routes', 'admin.routes.js');
const adminRaw = fs.readFileSync(ADMIN_PATH, 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const adminCode = stripComments(adminRaw);

// Locate the PUT /app-config handler block. Find the next "router." line that
// follows it (i.e., the start of the next route) and slice up to that.
const handlerStart = adminCode.indexOf("router.put('/app-config'");
const nextRouterIdx = adminCode.indexOf("\nrouter.", handlerStart + 100);
const handlerEnd = nextRouterIdx > 0 ? nextRouterIdx : handlerStart + 6000;
const handler = adminCode.slice(handlerStart, handlerEnd);

describe('audit-H15 admin app-config: unknown-key detection in source', () => {
  test('whitelist keys are collected into a Set for membership checks', () => {
    expect(handler).toMatch(/whitelistKeys\s*=\s*new Set\(Object\.keys\(whitelist\)\)/);
  });

  test('req.body is iterated to find unknown keys', () => {
    expect(handler).toMatch(/for\s*\(\s*const\s+k\s+of\s+Object\.keys\(\s*req\.body\s*\|\|\s*\{\s*\}\s*\)/);
  });

  test('unknown keys are pushed to unknownKeys array', () => {
    expect(handler).toMatch(/unknownKeys\.push\(k\)/);
  });

  test('response includes unknownKeys field', () => {
    expect(handler).toMatch(/unknownKeys:\s*unknownKeys\.length\s*>\s*0\s*\?\s*unknownKeys\s*:\s*undefined/);
  });

  test('a logger.warn is emitted when unknownKeys is non-empty', () => {
    expect(handler).toMatch(/unknownKeys\.length\s*>\s*0/);
    expect(handler).toMatch(/logger\.warn\(\{[^}]*unknownKeys[^}]*\}/);
  });

  test('FIX-2026-09-01 audit H15 comment present', () => {
    expect(adminRaw).toMatch(/FIX-2026-09-01 audit H15/);
  });
});

describe('audit-H15 admin app-config: type-mismatch detection', () => {
  test('non-finite number values are pushed to unknownKeys', () => {
    // For 'number' fields, parseFloat(NaN/Infinity) === NaN → push to unknownKeys.
    // Pattern: t === 'number' → parseFloat → if Number.isFinite(n) set → else if unknownKeys.push(k)
    const re = /t\s*===\s*['"]number['"][\s\S]{0,300}if\s*\(Number\.isFinite\(n\)\)[\s\S]{0,200}else if\s*\([\s\S]{0,100}unknownKeys\.push/;
    expect(handler).toMatch(re);
  });

  test('non-string values for string fields are pushed to unknownKeys', () => {
    // For 'string' fields, typeof !== 'string' → push to unknownKeys
    // Source pattern: typeof req.body[k] === 'string' set[k] = ...; else if ... unknownKeys.push(k)
    const re = /typeof\s+req\.body\[k\]\s*===\s*['"]string['"][\s\S]{0,200}else\s*if[\s\S]{0,100}unknownKeys\.push/;
    expect(handler).toMatch(re);
  });
});

// ─── Runtime replica of the whitelist processor ─────────────────────────
//
// Re-implement the same logic to verify behavior across the relevant inputs.

describe('audit-H15 runtime replica: whitelist processor', () => {
  function processBody(body, whitelist) {
    const safeBody = body || {};
    const set = {};
    const unknownKeys = [];
    const whitelistKeys = new Set(Object.keys(whitelist));
    for (const k of Object.keys(safeBody)) {
      if (!whitelistKeys.has(k)) unknownKeys.push(k);
    }
    for (const [k, t] of Object.entries(whitelist)) {
      if (safeBody[k] === undefined) continue;
      if (t === 'boolean') set[k] = !!safeBody[k];
      else if (t === 'number') {
        const n = parseFloat(safeBody[k]);
        if (Number.isFinite(n)) set[k] = n;
        else if (!unknownKeys.includes(k)) unknownKeys.push(k);
      } else if (t === 'string') {
        if (typeof safeBody[k] === 'string') set[k] = safeBody[k];
        else if (!unknownKeys.includes(k)) unknownKeys.push(k);
      }
    }
    return { set, unknownKeys };
  }

  const WHITELIST = {
    dpsMinSize: 'number',
    dpsMaxSize: 'number',
    cbVersion: 'string',
    autoTimingEnabled: 'boolean',
    autoDeleteBotDays: 'number',
  };

  test('all-whitelisted body: unknownKeys is empty', () => {
    const { set, unknownKeys } = processBody({
      dpsMinSize: 10,
      dpsMaxSize: 20,
      cbVersion: 'v2',
      autoTimingEnabled: true,
      autoDeleteBotDays: 30,
    }, WHITELIST);
    expect(unknownKeys).toEqual([]);
    expect(set.dpsMinSize).toBe(10);
    expect(set.cbVersion).toBe('v2');
    expect(set.autoTimingEnabled).toBe(true);
  });

  test('all-unknown body: every key lands in unknownKeys', () => {
    const { set, unknownKeys } = processBody({
      madeUpField: 'x',
      fooBar: 42,
      baz: true,
    }, WHITELIST);
    expect(unknownKeys.sort()).toEqual(['baz', 'fooBar', 'madeUpField']);
    expect(set).toEqual({});
  });

  test('mixed body: whitelisted keys land in set, others in unknownKeys', () => {
    const { set, unknownKeys } = processBody({
      dpsMinSize: 12,
      mysteryField: 'orphan',
      cbVersion: 'v3',
      anotherOrphan: true,
    }, WHITELIST);
    expect(unknownKeys.sort()).toEqual(['anotherOrphan', 'mysteryField']);
    expect(set.dpsMinSize).toBe(12);
    expect(set.cbVersion).toBe('v3');
  });

  test('type mismatch: number field given non-numeric string → unknownKeys', () => {
    const { set, unknownKeys } = processBody({
      dpsMinSize: 'not-a-number',
      dpsMaxSize: NaN,
    }, WHITELIST);
    expect(unknownKeys.sort()).toEqual(['dpsMaxSize', 'dpsMinSize']);
    expect(set).toEqual({});
  });

  test('type mismatch: string field given number → unknownKeys', () => {
    const { set, unknownKeys } = processBody({
      cbVersion: 42,
    }, WHITELIST);
    expect(unknownKeys).toEqual(['cbVersion']);
    expect(set).toEqual({});
  });

  test('Infinity is treated as non-finite and rejected', () => {
    const { set, unknownKeys } = processBody({
      dpsMinSize: Infinity,
    }, WHITELIST);
    expect(unknownKeys).toEqual(['dpsMinSize']);
    expect(set).toEqual({});
  });

  test('boolean coercion: truthy + falsy values map correctly', () => {
    const { set, unknownKeys } = processBody({
      autoTimingEnabled: 1,
      autoDeleteBotEnabled: 0, // not in whitelist — should be unknown
    }, { ...WHITELIST, autoDeleteBotEnabled: 'boolean' });
    expect(set.autoTimingEnabled).toBe(true);
    expect(set.autoDeleteBotEnabled).toBe(false);
    expect(unknownKeys).toEqual([]);
  });

  test('undefined values are skipped (not added to unknownKeys)', () => {
    const { set, unknownKeys } = processBody({
      dpsMinSize: undefined,
      dpsMaxSize: 15,
    }, WHITELIST);
    expect(unknownKeys).toEqual([]);
    expect(set).toEqual({ dpsMaxSize: 15 });
  });

  test('null values: parseFloat(null) === NaN → treated as bad number', () => {
    const { set, unknownKeys } = processBody({
      dpsMinSize: null,
    }, WHITELIST);
    // parseFloat(null) === NaN, Number.isFinite(NaN) === false → unknownKeys
    expect(unknownKeys).toEqual(['dpsMinSize']);
    expect(set).toEqual({});
  });

  test('empty body returns empty set + empty unknownKeys', () => {
    const { set, unknownKeys } = processBody({}, WHITELIST);
    expect(set).toEqual({});
    expect(unknownKeys).toEqual([]);
  });

  test('null body does not throw (defensive: req.body || {})', () => {
    const { set, unknownKeys } = processBody(null, WHITELIST);
    expect(set).toEqual({});
    expect(unknownKeys).toEqual([]);
  });
});

describe('audit-H15 admin app-config: response shape contract', () => {
  test('ok field preserved', () => {
    expect(handler).toMatch(/ok:\s*true/);
  });

  test('config field preserved', () => {
    expect(handler).toMatch(/config:\s*updated/);
  });

  test('unknownKeys is undefined when empty (not leaking empty array)', () => {
    // The response uses `unknownKeys: unknownKeys.length > 0 ? unknownKeys : undefined`
    // so consumers don't see a noisy empty array on every successful save.
    expect(handler).toMatch(/unknownKeys:\s*unknownKeys\.length\s*>\s*0\s*\?\s*unknownKeys\s*:\s*undefined/);
  });
});