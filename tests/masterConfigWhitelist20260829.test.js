/**
 * FIX-2026-08-29 Regression tests for the "no valid fields in settings" 400 bug
 *
 * Background: masterConfigModal UI added `autoPauseAdjustEnabled` toggle in
 * Phase 2026-08-29 (per-bot opt-out for auto-pause threshold auto-adjust).
 * THREE places had not whitelisted the new key, so it was silently dropped:
 *
 *   1. POST /api/bots/:id         (PATCH whitelist, line ~1145, single-line array)
 *   2. POST /api/bots/bulk-update (allowed[], line ~2106, multi-line array)
 *   3. PUT  /api/admin/bot-defaults (BOOLEAN_FIELDS, line ~510)
 *
 * These tests guard against the same regression class by asserting each
 * whitelist parses cleanly and contains `autoPauseAdjustEnabled`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BOT_ROUTES_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'api', 'routes', 'bot.routes.js'), 'utf8'
);
const ADMIN_ROUTES_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'api', 'routes', 'admin.routes.js'), 'utf8'
);
const BOT_MODEL_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'models', 'Bot.js'), 'utf8'
);
const APP_CONFIG_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'models', 'AppConfig.js'), 'utf8'
);

// Extract a clean list of keys from either a single-line or multi-line array
// literal that starts with `const <name> = [`. Picks up string keys only
// (matches `'foo'` and `"foo"` but not numeric or computed keys).
function extractArrayKeys(src, name) {
  // Match `const <name> = [ ... ];` — content can span many lines.
  // We terminate at the matching `];` by counting bracket depth.
  const startIdx = src.indexOf(`const ${name} = [`);
  if (startIdx < 0) return null;
  let depth = 0;
  let i = src.indexOf('[', startIdx);
  let endIdx = -1;
  for (; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') {
      depth -= 1;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }
  if (endIdx < 0) return null;
  const block = src.slice(startIdx, endIdx);
  return [...block.matchAll(/['"]([a-zA-Z][a-zA-Z0-9_]*)['"]/g)].map((x) => x[1]);
}

describe('FIX-2026-08-29 master config whitelist regression', () => {
  describe('bot.routes.js whitelists', () => {
    test('PATCH route allowed[] contains autoPauseAdjustEnabled', () => {
      const keys = extractArrayKeys(BOT_ROUTES_SRC, 'allowed');
      expect(keys).not.toBeNull();
      expect(keys.length).toBeGreaterThan(40);
      expect(keys).toContain('autoPauseAdjustEnabled');
      // Spot-check a few expected fields are still there (regression on deletion).
      for (const k of [
        'capitalPerTrade', 'tpPercent', 'timeframe', 'cbEnabled',
        'cbv3Enabled', 'cbv5Enabled', 'cbv5KcLen',
        'autoPauseEnabled', 'autoPauseMinKcPct',
        'dynamicSizeEnabled', 'safeTradeEnabled', 'safeTradeNoTradeEnabled',
      ]) {
        expect(keys).toContain(k);
      }
    });

    test('PATCH route allowed[] has no duplicate keys', () => {
      const keys = extractArrayKeys(BOT_ROUTES_SRC, 'allowed');
      const seen = new Set();
      const dupes = [];
      for (const k of keys) {
        if (seen.has(k)) dupes.push(k);
        seen.add(k);
      }
      expect(dupes).toEqual([]);
    });

    // FIX-2026-09-06: bulk-update `allowed[]` MUST contain AUv2 fields too.
    //   extractArrayKeys() returns only the first 'allowed' (PATCH), so we
    //   locate the second 'const allowed = [', slice from there, and re-parse.
    //   Root cause: Master Config → save AUv2 toggle → bulk-update returned 400
    //   'no valid fields in settings' because the bulk whitelist was missing
    //   all 6 auv2 fields.
    test('bulk-update allowed[] contains all 6 AUv2 fields', () => {
      const firstStart = BOT_ROUTES_SRC.indexOf('const allowed = [');
      const secondStart = BOT_ROUTES_SRC.indexOf('const allowed = [', firstStart + 1);
      expect(secondStart).toBeGreaterThan(0);
      let depth = 0, endIdx = -1, i = BOT_ROUTES_SRC.indexOf('[', secondStart);
      for (; i < BOT_ROUTES_SRC.length; i += 1) {
        if (BOT_ROUTES_SRC[i] === '[') depth += 1;
        else if (BOT_ROUTES_SRC[i] === ']') {
          depth -= 1;
          if (depth === 0) { endIdx = i + 1; break; }
        }
      }
      const block = BOT_ROUTES_SRC.slice(secondStart, endIdx);
      const keys = [...block.matchAll(/['"]([a-zA-Z][a-zA-Z0-9_]*)['"]/g)].map((x) => x[1]);
      expect(keys.length).toBeGreaterThan(50);
      for (const k of [
        'auv2Enabled', 'auv2MinAgeHours', 'auv2LossMode',
        'auv2MaxLossPct', 'auv2MaxLossThb', 'auv2MaxWaitDays',
      ]) {
        expect(keys).toContain(k);
      }
    });
  });

  describe('admin.routes.js whitelists', () => {
    test('BOOLEAN_FIELDS contains autoPauseAdjustEnabled', () => {
      const keys = extractArrayKeys(ADMIN_ROUTES_SRC, 'BOOLEAN_FIELDS');
      expect(keys).not.toBeNull();
      expect(keys).toContain('autoPauseAdjustEnabled');
    });

    test('BOOLEAN_FIELDS, NUMBER_FIELDS, STRING_FIELDS are mutually exclusive', () => {
      const bools = new Set(extractArrayKeys(ADMIN_ROUTES_SRC, 'BOOLEAN_FIELDS'));
      const nums = new Set(extractArrayKeys(ADMIN_ROUTES_SRC, 'NUMBER_FIELDS'));
      const strs = new Set(extractArrayKeys(ADMIN_ROUTES_SRC, 'STRING_FIELDS'));
      expect(bools.size).toBeGreaterThan(0);
      expect(nums.size).toBeGreaterThan(0);
      expect(strs.size).toBeGreaterThan(0);
      for (const k of bools) {
        expect(nums.has(k)).toBe(false);
        expect(strs.has(k)).toBe(false);
      }
      for (const k of nums) expect(bools.has(k)).toBe(false);
    });

    // FIX-2026-09-06: AUv2 — master config whitelist (PUT /api/admin/app-config)
    //   service reads AppConfig.auv2Enabled (NOT masterAuv2Enabled — match cbEnabled pattern)
    test('admin whitelist contains AUv2 master toggle + 5 per-bot defaults', () => {
      expect(ADMIN_ROUTES_SRC).toMatch(/auv2Enabled\s*:\s*['"]boolean['"]/);
      expect(ADMIN_ROUTES_SRC).toMatch(/auv2MinAgeHours\s*:\s*['"]number['"]/);
      expect(ADMIN_ROUTES_SRC).toMatch(/auv2LossMode\s*:\s*['"]string['"]/);
      expect(ADMIN_ROUTES_SRC).toMatch(/auv2MaxLossPct\s*:\s*['"]number['"]/);
      expect(ADMIN_ROUTES_SRC).toMatch(/auv2MaxLossThb\s*:\s*['"]number['"]/);
      expect(ADMIN_ROUTES_SRC).toMatch(/auv2MaxWaitDays\s*:\s*['"]number['"]/);
    });
  });

  describe('Schema sanity', () => {
    test('Bot schema declares autoPauseAdjustEnabled (default true)', () => {
      expect(BOT_MODEL_SRC).toMatch(/autoPauseAdjustEnabled\s*:\s*\{\s*type\s*:\s*Boolean,\s*default\s*:\s*true/);
    });

    test('AppConfig schema declares autoPauseAdjustEnabled (master switch, default false)', () => {
      expect(APP_CONFIG_SRC).toMatch(/autoPauseAdjustEnabled\s*:\s*\{\s*type\s*:\s*Boolean,\s*default\s*:\s*false/);
    });

    // FIX-2026-09-06: AUv2 master schema field — key is "auv2Enabled" (NOT masterAuv2Enabled)
    //   to match the codebase pattern (cbEnabled, autoArmStopLossOnUKC, dlcEnabled, etc.)
    test('AppConfig schema declares auv2Enabled (no "master" prefix)', () => {
      expect(APP_CONFIG_SRC).toMatch(/auv2Enabled\s*:\s*\{\s*type\s*:\s*Boolean,\s*default\s*:\s*false/);
      expect(APP_CONFIG_SRC).not.toMatch(/masterAuv2Enabled/);
    });
  });
});
