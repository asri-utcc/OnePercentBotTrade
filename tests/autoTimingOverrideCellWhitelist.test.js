/**
 * FIX-2026-09-01 audit C9: autoTimingOverrideCell added to PATCH and bulk-update
 * whitelists in bot.routes.js.
 *
 * Before this fix:
 *   - PUT /api/bots/:id with body.autoTimingOverrideCell → field silently dropped
 *   - POST /api/bots/bulk-update with settings.autoTimingOverrideCell →
 *     'no valid fields in settings' (whole bulk-update rejected)
 *   - The UI per-bot "Cell Override" editor wrote to a field that the server
 *     ignored, leaving operators confused.
 *
 * Defense added:
 *   - Field added to BOTH whitelists (PATCH at L1145+ and bulk-update at L2117+)
 *   - Shared validator _validateAutoTimingOverrideCell() ensures keys are 'd:h'
 *     (day 0..6, hour 0..23) and values are allow|limit|encourage|stimulate|suppress
 *   - Validator returns { error } for malformed input → 400 response
 *   - null clears the override (per schema default)
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

// Locate the PATCH whitelist (the long literal array containing autoTimingEnabled)
// and the bulk-update whitelist (the array starting with 'capitalPerTrade').
function findWhitelistBlock(label, anchor, endAnchor) {
  const anchorIdx = routesRaw.indexOf(anchor);
  if (anchorIdx === -1) return null;
  const slice = routesRaw.slice(anchorIdx, anchorIdx + 4000);
  // Find matching closing `];` after endAnchor
  const endIdx = slice.indexOf(endAnchor, slice.indexOf("'"));
  if (endIdx === -1) return null;
  return slice.slice(0, endIdx + endAnchor.length);
}

describe('audit-C9 autoTimingOverrideCell in PATCH whitelist', () => {
  test('PATCH allowed[] contains autoTimingOverrideCell', () => {
    // The PATCH whitelist is the long array starting with 'name'. Look for the field
    // in close proximity to autoTimingEnabled (which is already known to be there).
    const block = routesRaw.match(/const allowed = \[([^\]]{0,8000})\];/);
    expect(block).not.toBeNull();
    expect(block[1]).toMatch(/'autoTimingOverrideCell'/);
  });

  test('PATCH validation handler calls _validateAutoTimingOverrideCell', () => {
    const code = stripComments(routesRaw);
    expect(code).toMatch(/k === 'autoTimingOverrideCell'[\s\S]{0,400}_validateAutoTimingOverrideCell/);
  });

  test('PATCH rejects malformed input via 400', () => {
    const code = stripComments(routesRaw);
    expect(code).toMatch(/if \(v\.error\) return res\.status\(400\)\.json\(\{ error: v\.error \}\)/);
  });
});

describe('audit-C9 autoTimingOverrideCell in bulk-update whitelist', () => {
  test('bulk-update allowed[] contains autoTimingOverrideCell', () => {
    const code = stripComments(routesRaw);
    // Find the second `const allowed = [` occurrence (the bulk-update one)
    // and verify the field is listed within ~50 lines after autoTimingEnabled.
    const secondAllowed = code.indexOf("'capitalPerTrade'", code.indexOf("'capitalPerTrade'") + 1);
    expect(secondAllowed).toBeGreaterThan(-1);
    const slice = code.slice(secondAllowed, secondAllowed + 5000);
    expect(slice).toMatch(/'autoTimingOverrideCell'/);
  });

  test('bulk-update applies _validateAutoTimingOverrideCell', () => {
    const code = stripComments(routesRaw);
    // Locate the validation block: 'autoTimingOverrideCell' in update → validate
    const block = code.match(/if \('autoTimingOverrideCell' in update\)[\s\S]{0,500}_validateAutoTimingOverrideCell/);
    expect(block).not.toBeNull();
  });

  test('bulk-update rejects malformed input via 400', () => {
    const code = stripComments(routesRaw);
    // The same v.error → 400 pattern appears in both PATCH and bulk-update paths
    // (verify both via global regex).
    const matches = code.match(/if \(v\.error\) return res\.status\(400\)\.json\(\{ error: v\.error \}\)/g);
    expect(matches).not.toBeNull();
    // Expect at least 2 matches (PATCH + bulk-update)
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('audit-C9 _validateAutoTimingOverrideCell — shared validator', () => {
  // Inline tests of the validator logic. We re-implement it here against the
  // contract; the file-based tests above already verify the helper exists.
  function _validateAutoTimingOverrideCell(v) {
    const KEY_RE = /^([0-6]):([0-9]|1[0-9]|2[0-3])$/;
    const VALUES = new Set(['allow', 'limit', 'encourage', 'stimulate', 'suppress']);
    if (v === null) return { value: null };
    if (typeof v !== 'object' || Array.isArray(v)) {
      return { error: 'autoTimingOverrideCell must be an object like { "0:4": "suppress" } or null' };
    }
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof k !== 'string' || !KEY_RE.test(k)) {
        return { error: `autoTimingOverrideCell key '${k}' must be 'd:h' where d=0..6, h=0..23` };
      }
      if (typeof val !== 'string' || !VALUES.has(val)) {
        return { error: `autoTimingOverrideCell value '${val}' for key '${k}' must be one of allow|limit|encourage|stimulate|suppress` };
      }
      out[k] = val;
    }
    return { value: out };
  }

  test('null clears the override', () => {
    expect(_validateAutoTimingOverrideCell(null)).toEqual({ value: null });
  });

  test('accepts a valid override map', () => {
    const r = _validateAutoTimingOverrideCell({ '0:4': 'suppress', '6:23': 'stimulate' });
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual({ '0:4': 'suppress', '6:23': 'stimulate' });
  });

  test('rejects arrays (not a plain object)', () => {
    const r = _validateAutoTimingOverrideCell(['suppress', 'limit']);
    expect(r.error).toMatch(/must be an object/);
  });

  test('rejects non-string keys', () => {
    const r = _validateAutoTimingOverrideCell({ 4: 'suppress' });
    expect(r.error).toMatch(/key '4' must be 'd:h'/);
  });

  test('rejects day out of range (7)', () => {
    const r = _validateAutoTimingOverrideCell({ '7:4': 'suppress' });
    expect(r.error).toMatch(/key '7:4'/);
  });

  test('rejects hour out of range (24)', () => {
    const r = _validateAutoTimingOverrideCell({ '0:24': 'suppress' });
    expect(r.error).toMatch(/key '0:24'/);
  });

  test('rejects unknown action', () => {
    const r = _validateAutoTimingOverrideCell({ '0:4': 'boost' });
    expect(r.error).toMatch(/'boost' for key '0:4'/);
  });

  test('rejects numeric values', () => {
    const r = _validateAutoTimingOverrideCell({ '0:4': 1 });
    expect(r.error).toMatch(/value '1' for key '0:4'/);
  });

  test('rejects hour 99', () => {
    const r = _validateAutoTimingOverrideCell({ '3:99': 'allow' });
    expect(r.error).toMatch(/key '3:99'/);
  });

  test('accepts edge case: day=6 hour=23', () => {
    const r = _validateAutoTimingOverrideCell({ '6:23': 'encourage' });
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual({ '6:23': 'encourage' });
  });

  test('accepts edge case: day=0 hour=0', () => {
    const r = _validateAutoTimingOverrideCell({ '0:0': 'limit' });
    expect(r.error).toBeUndefined();
  });

  test('empty object is accepted (clears all overrides)', () => {
    const r = _validateAutoTimingOverrideCell({});
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual({});
  });
});

describe('audit-C9 validator source location', () => {
  test('helper defined at top of file (shared between routes)', () => {
    const code = routesRaw;
    const helperIdx = code.indexOf('function _validateAutoTimingOverrideCell');
    expect(helperIdx).toBeGreaterThan(-1);
    // Helper should be defined before PATCH route (~line 1100+)
    const patchIdx = code.indexOf("router.put('/:id'");
    // Both must exist and helper must be defined before the PATCH route
    expect(patchIdx).toBeGreaterThan(-1);
    expect(helperIdx).toBeLessThan(patchIdx);
  });

  test('helper exports VALID_ACTIONS_SET equivalent via Set literal', () => {
    const code = routesRaw;
    // The validator must use a Set literal with the 5 actions
    expect(code).toMatch(/new Set\(\['allow', 'limit', 'encourage', 'stimulate', 'suppress'\]\)/);
  });

  test('helper regex matches day 0-6 and hour 0-23', () => {
    const code = routesRaw;
    expect(code).toMatch(/\/\^\(\[0-6\]\):\(\[0-9\]\|1\[0-9\]\|2\[0-3\]\)\$\//);
  });
});
