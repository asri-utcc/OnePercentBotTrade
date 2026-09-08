'use strict';

/**
 * FIX-2026-09-01 audit C15: botDefaults.js — duplicate autoPauseAdjustEnabled key.
 *
 *   The botDefaults factory returned an object literal with the same key
 *   TWICE. JS silently takes the second value (same code path), so behaviour
 *   is identical — but the smell is dangerous: if anyone later changes the
 *   pickBool default of the FIRST line (e.g. → false), JS will still use
 *   the SECOND line's default (true) without warning. Future bugs waiting
 *   to happen.
 *
 *   Fix: removed the first occurrence. Only the second (with the canonical
 *   Thai explanation) remains.
 *
 *   This test asserts the duplicate is gone by:
 *     1. counting non-comment `autoPauseAdjustEnabled:` occurrences in the
 *        source (must be exactly 1)
 *     2. spot-checking the runtime behaviour still resolves to the expected
 *        default (true when no override).
 */

const fs = require('fs');
const path = require('path');

const MOD_PATH = path.join(__dirname, '..', 'src', 'services', 'botDefaults.js');
const modRaw = fs.readFileSync(MOD_PATH, 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s;,(])\/\/[^\n]*/g, '$1');
}

describe('audit-C15 no duplicate autoPauseAdjustEnabled key', () => {
  test('source has exactly one `autoPauseAdjustEnabled:` field declaration', () => {
    const code = stripComments(modRaw);
    // Match only the FIELD declaration, not references inside string literals or comments
    const matches = code.match(/autoPauseAdjustEnabled\s*:\s*pickBool/g) || [];
    expect(matches.length).toBe(1);
  });

  test('the surviving declaration uses pickBool with default true', () => {
    const code = stripComments(modRaw);
    // Should be exactly: autoPauseAdjustEnabled: pickBool(o, b, 'autoPauseAdjustEnabled', <true-or-rec>),
    //   where <true-or-rec> = literal `true` OR `rec('autoPauseAdjustEnabled')` (FIX-2026-09-09: RECOMMENDED_DEFAULTS alias)
    const matches = code.match(/autoPauseAdjustEnabled\s*:\s*pickBool\(\s*o\s*,\s*b\s*,\s*['"]autoPauseAdjustEnabled['"]\s*,\s*(?:true|rec\(['"]autoPauseAdjustEnabled['"]\))\s*\)/);
    expect(matches).not.toBeNull();
    expect(matches.length).toBe(1);
  });

  test('no stray duplicate field declarations exist for any autoPauseAdjust* key (FIX-2026-09-09: scoped to buildBotCreatePayload)', () => {
    // After the RECOMMENDED_DEFAULTS refactor, the field legitimately appears TWICE in the
    // file: once in the RECOMMENDED_DEFAULTS constant (line ~84) and once in
    // buildBotCreatePayload's return object (~line 341). What we MUST guard against is
    // the original bug: a duplicate within buildBotCreatePayload itself, where JS would
    // silently take the second value.
    //
    // Scope: only count declarations inside buildBotCreatePayload's return object.
    const code = stripComments(modRaw);
    const start = code.indexOf('function buildBotCreatePayload');
    const end = code.indexOf('module.exports', start);
    const slice = start >= 0 && end >= 0 ? code.slice(start, end) : code;
    const lines = slice.split('\n');
    const seen = new Map();
    for (const line of lines) {
      const m = line.match(/^\s*(autoPauseAdjust\w*)\s*:/);
      if (m) {
        const key = m[1];
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
    for (const [k, count] of seen.entries()) {
      expect({ key: k, count }).toEqual(expect.objectContaining({ count: 1 }));
    }
  });
});

describe('audit-C15 runtime: buildBotCreatePayload still resolves autoPauseAdjustEnabled', () => {
  test('default true when overrides, botDefaults and fallbacks all empty', () => {
    const { buildBotCreatePayload } = require('../src/services/botDefaults');
    const d = buildBotCreatePayload();
    expect(typeof d.autoPauseAdjustEnabled).toBe('boolean');
    expect(d.autoPauseAdjustEnabled).toBe(true);
  });

  test('botDefaults.autoPauseAdjustEnabled=false propagates as the default', () => {
    const { buildBotCreatePayload } = require('../src/services/botDefaults');
    const d = buildBotCreatePayload({ botDefaults: { autoPauseAdjustEnabled: false } });
    expect(d.autoPauseAdjustEnabled).toBe(false);
  });

  test('overrides.autoPauseAdjustEnabled=false wins over botDefaults=true', () => {
    const { buildBotCreatePayload } = require('../src/services/botDefaults');
    const d = buildBotCreatePayload({
      overrides: { autoPauseAdjustEnabled: false },
      botDefaults: { autoPauseAdjustEnabled: true },
    });
    expect(d.autoPauseAdjustEnabled).toBe(false);
  });
});