'use strict';

/**
 * FIX-2026-09-09 audit Batch 2: Mirror sync test.
 *
 *   public/js/utils/recommendedDefaults.js is a BROWSER-SIDE MIRROR of
 *   src/services/botDefaults.js → RECOMMENDED_DEFAULTS.
 *
 *   If someone updates one but forgets the other, the user-facing UI will
 *   diverge from the server-side defaults. This test catches drift by:
 *     1. Loading both files
 *     2. Comparing their key sets
 *     3. Comparing the values of every overlapping key
 *
 *   Strategy: parsing the JS source with regex (NOT evaluating it) to avoid
 *   pulling Mongoose / Node-only requires.
 *
 *   When drift is detected, the test prints a diff so the developer can
 *   copy/paste the fix.
 */

const fs = require('fs');
const path = require('path');

const SERVER_FILE = path.join(__dirname, '..', 'src', 'services', 'botDefaults.js');
const MIRROR_FILE = path.join(__dirname, '..', 'public', 'js', 'utils', 'recommendedDefaults.js');

function parseRecommendedDefaults(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  // Extract the {...} block following RECOMMENDED_DEFAULTS = Object.freeze({
  const match = src.match(/RECOMMENDED_DEFAULTS\s*=\s*Object\.freeze\(\s*\{([\s\S]*?)\}\s*\)/);
  if (!match) throw new Error(`Could not find RECOMMENDED_DEFAULTS in ${filePath}`);
  const body = match[1];

  const result = {};
  // Match lines like:   key: value,
  // Capture key (must be valid identifier) and value (string/number/bool/null)
  const lineRe = /^\s*([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*('(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false|null)\s*,?\s*(?:\/\/[^\n]*)?$/gm;
  let m;
  while ((m = lineRe.exec(body)) !== null) {
    const key = m[1];
    let val = m[2];
    if (val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1).replace(/\\'/g, "'");
    } else if (val === 'true') {
      val = true;
    } else if (val === 'false') {
      val = false;
    } else if (val === 'null') {
      val = null;
    } else {
      val = Number(val);
    }
    result[key] = val;
  }
  return result;
}

describe('audit-B2 RECOMMENDED_DEFAULTS mirror sync', () => {
  const server = parseRecommendedDefaults(SERVER_FILE);
  const mirror = parseRecommendedDefaults(MIRROR_FILE);

  test('mirror file exists', () => {
    expect(fs.existsSync(MIRROR_FILE)).toBe(true);
  });

  test('server has at least 49 fields', () => {
    expect(Object.keys(server).length).toBeGreaterThanOrEqual(49);
  });

  test('mirror has at least 49 fields', () => {
    expect(Object.keys(mirror).length).toBeGreaterThanOrEqual(49);
  });

  test('every server key exists in mirror', () => {
    const missing = Object.keys(server).filter((k) => !(k in mirror));
    expect(missing).toEqual([]);
  });

  test('every mirror key exists in server (warn if extras)', () => {
    // Mirror may have UI-only extras (e.g. defaultSymbol vs defaultTimeframe)
    // — but values for shared keys MUST match. Print extras for visibility.
    const extras = Object.keys(mirror).filter((k) => !(k in server));
    if (extras.length > 0) {
      console.warn(`Mirror-only keys (UI metadata, allowed): ${extras.join(', ')}`);
    }
  });

  test('every shared key has identical value', () => {
    const diffs = [];
    for (const k of Object.keys(server)) {
      if (!(k in mirror)) continue; // covered above
      if (server[k] !== mirror[k]) {
        diffs.push(`${k}: server=${JSON.stringify(server[k])} vs mirror=${JSON.stringify(mirror[k])}`);
      }
    }
    if (diffs.length > 0) {
      console.error('DRIFT DETECTED:\n  ' + diffs.join('\n  '));
    }
    expect(diffs).toEqual([]);
  });
});
