/**
 * FIX-2026-09-01 audit C9: autoTimingEnabled tristate coercion in PATCH path.
 *
 * Before this fix:
 *   - PATCH /api/bots/:id stored autoTimingEnabled via the catch-all
 *     `bot[k] = data[k]` (line 1297). If the frontend sent the string
 *     'true' / 'false' / 'null' (typical form-encoded payload), the string
 *     was stored verbatim → broke the tristate schema (null|true|false).
 *   - Bulk-update (POST /api/bots/bulk-update) already coerced correctly
 *     (inline ternary at line 2224), so the two write paths diverged.
 *   - Downstream `if (bot.autoTimingEnabled === false)` checks (in
 *     autoTiming.decideForBot) failed because the value was a string,
 *     not false → bot stayed in 'inherit master' instead of force-off.
 *
 * Defense added:
 *   - Shared helper _coerceAutoTimingEnabled(v) at the top of bot.routes.js
 *     coerces booleans, integer 0/1, string 'true'/'false'/'null'/''/0/1
 *     into the proper tristate (true | false | null).
 *   - PATCH path now calls _coerceAutoTimingEnabled(data[k]) before assignment.
 *   - Bulk-update path also switched to the same helper (DRY) so the two
 *     paths stay in lockstep forever.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROUTES_PATH = path.join(__dirname, '..', 'src', 'api', 'routes', 'bot.routes.js');
const routesRaw = fs.readFileSync(ROUTES_PATH, 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s;,(])\/\/[^\n]*/g, '$1');
}

describe('audit-C9 _coerceAutoTimingEnabled — shared helper', () => {
  // Inline implementation mirroring bot.routes.js:65-69
  function _coerceAutoTimingEnabled(v) {
    if (v === true || v === 'true' || v === 1 || v === '1') return true;
    if (v === false || v === 'false' || v === 0 || v === '0') return false;
    return null;
  }

  test('boolean true → true', () => {
    expect(_coerceAutoTimingEnabled(true)).toBe(true);
  });

  test('boolean false → false', () => {
    expect(_coerceAutoTimingEnabled(false)).toBe(false);
  });

  test('string "true" → true (frontend form-encoded)', () => {
    expect(_coerceAutoTimingEnabled('true')).toBe(true);
  });

  test('string "false" → false (frontend form-encoded)', () => {
    expect(_coerceAutoTimingEnabled('false')).toBe(false);
  });

  test('integer 1 → true', () => {
    expect(_coerceAutoTimingEnabled(1)).toBe(true);
  });

  test('integer 0 → false', () => {
    expect(_coerceAutoTimingEnabled(0)).toBe(false);
  });

  test('string "1" → true', () => {
    expect(_coerceAutoTimingEnabled('1')).toBe(true);
  });

  test('string "0" → false', () => {
    expect(_coerceAutoTimingEnabled('0')).toBe(false);
  });

  test('null → null (inherit master)', () => {
    expect(_coerceAutoTimingEnabled(null)).toBe(null);
  });

  test('string "null" → null', () => {
    expect(_coerceAutoTimingEnabled('null')).toBe(null);
  });

  test('undefined → null', () => {
    expect(_coerceAutoTimingEnabled(undefined)).toBe(null);
  });

  test('empty string → null', () => {
    expect(_coerceAutoTimingEnabled('')).toBe(null);
  });

  test('unknown string → null (defensive fallback)', () => {
    expect(_coerceAutoTimingEnabled('enabled')).toBe(null);
    expect(_coerceAutoTimingEnabled('yes')).toBe(null);
    expect(_coerceAutoTimingEnabled('on')).toBe(null);
  });

  test('object → null', () => {
    expect(_coerceAutoTimingEnabled({})).toBe(null);
    expect(_coerceAutoTimingEnabled({ value: true })).toBe(null);
  });
});

describe('audit-C9 PATCH route — autoTimingEnabled coerced via helper', () => {
  test('PATCH for-loop has dedicated autoTimingEnabled branch', () => {
    // Strip comments — the regex must match code, not comments.
    const code = stripComments(routesRaw);
    expect(code).toMatch(/else if \(k === 'autoTimingEnabled'\)/);
  });

  test('PATCH branch calls _coerceAutoTimingEnabled', () => {
    const code = stripComments(routesRaw);
    // Match: k === 'autoTimingEnabled' → bot[k] = _coerceAutoTimingEnabled(...)
    const block = code.match(/else if \(k === 'autoTimingEnabled'\)[\s\S]{0,500}_coerceAutoTimingEnabled\(data\[k\]\)/);
    expect(block).not.toBeNull();
  });

  test('audit comment explains the bug', () => {
    expect(routesRaw).toMatch(/audit C9[\s\S]{0,400}tristate coercion in PATCH path/);
  });

  test('catch-all `bot[k] = data[k]` still present (for non-special keys)', () => {
    const code = stripComments(routesRaw);
    expect(code).toMatch(/else \{\s*\r?\n\s*bot\[k\] = data\[k\]/);
  });
});

describe('audit-C9 bulk-update route — uses same helper (DRY)', () => {
  test('bulk-update coercion now calls _coerceAutoTimingEnabled', () => {
    const code = stripComments(routesRaw);
    // Locate the block: if ('autoTimingEnabled' in update) → coerce via helper
    const block = code.match(/if \('autoTimingEnabled' in update\)[\s\S]{0,500}update\.autoTimingEnabled = _coerceAutoTimingEnabled/);
    expect(block).not.toBeNull();
  });

  test('old inline ternary is gone (single source of truth)', () => {
    const code = stripComments(routesRaw);
    // The old inline coercion pattern: `update.autoTimingEnabled = (v === true || v === 'true') ? true : ...`
    expect(code).not.toMatch(/update\.autoTimingEnabled = \(v === true \|\| v === 'true'\)/);
  });
});

describe('audit-C9 helper defined at top of file', () => {
  test('function exists', () => {
    expect(routesRaw).toMatch(/function _coerceAutoTimingEnabled\(v\)/);
  });

  test('helper exported via consistent pattern (not via module.exports, internal use)', () => {
    // Internal helper — used only within this file. Should NOT be in module.exports.
    const code = routesRaw;
    expect(code).toMatch(/function _coerceAutoTimingEnabled\(v\)/);
    // module.exports is at bottom — verify the helper is not listed there
    const exportBlock = code.match(/module\.exports[\s\S]{0,500};/);
    expect(exportBlock).not.toBeNull();
    expect(exportBlock[0]).not.toMatch(/_coerceAutoTimingEnabled/);
  });
});
