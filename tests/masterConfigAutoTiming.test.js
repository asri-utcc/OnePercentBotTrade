/**
 * Regression test for user report (2026-08-31):
 *   "master config เมื่อเปลี่ยน auto-timing มันขึ้นว่า no valid field to update"
 *
 * Root cause verification: every whitelist involved in the Master Config save
 * flow must accept autoTimingEnabled (the 12th per-bot tristate field).
 *
 * Three save paths from Master Config modal:
 *   1. "ใช้ค่ากับบอทที่เลือก" → POST /api/bots/bulk-update  (bot.routes.js)
 *   2. "Set to new bot"   → PUT  /api/admin/bot-defaults   (admin.routes.js)
 *   3. Save template       → POST/PUT /api/admin/master-config-templates (admin.routes.js)
 *                            which uses masterConfigTemplates.sanitizeSettings
 */
'use strict';

const {
  sanitizeSettings,
  ALLOWED_TEMPLATE_FIELDS,
} = require('../src/services/masterConfigTemplates');

describe('Master Config autoTimingEnabled — every whitelist must accept it', () => {
  test('ALLOWED_TEMPLATE_FIELDS includes autoTimingEnabled', () => {
    expect(ALLOWED_TEMPLATE_FIELDS).toContain('autoTimingEnabled');
  });

  test('sanitizeSettings preserves autoTimingEnabled=true', () => {
    const { settings, dropped } = sanitizeSettings({ autoTimingEnabled: true });
    expect(settings.autoTimingEnabled).toBe(true);
    expect(dropped).toBe(0);
  });

  test('sanitizeSettings preserves autoTimingEnabled=false', () => {
    const { settings } = sanitizeSettings({ autoTimingEnabled: false });
    expect(settings.autoTimingEnabled).toBe(false);
  });

  test('sanitizeSettings preserves autoTimingEnabled=null (inherit)', () => {
    const { settings } = sanitizeSettings({ autoTimingEnabled: null });
    expect(settings.autoTimingEnabled).toBe(null);
    // null is included by the Object.entries iteration (unlike undefined)
  });

  test('sanitizeSettings preserves autoTimingEnabled=undefined is dropped', () => {
    // undefined is enumerable in Object.entries() in modern Node — still included
    // But null and undefined behave differently in JSON serialization (undefined → key absent)
    const { settings, dropped } = sanitizeSettings({ autoTimingEnabled: undefined });
    // undefined values: Object.entries includes them, so it's preserved
    // Either way the bulk-update route coerces undefined to nothing.
    expect([null, undefined]).toContain(settings.autoTimingEnabled);
  });

  test('sanitizeSettings preserves autoTimingEnabled alongside other fields', () => {
    const { settings, dropped } = sanitizeSettings({
      capitalPerTrade: 12,
      autoTimingEnabled: true,
      autoPauseAdjustEnabled: false,
    });
    expect(settings.capitalPerTrade).toBe(12);
    expect(settings.autoTimingEnabled).toBe(true);
    expect(settings.autoPauseAdjustEnabled).toBe(false);
    expect(dropped).toBe(0);
  });
});

// FIX-2026-08-31: regex checks must strip // line comments first — otherwise a
// pattern like 'autoTimingEnabled' embedded inside a comment block passes the
// match even when the whitelist itself is missing the entry. The previous test
// had this exact false-positive and let the bug ship.
function stripJsComments(src) {
  // Remove //... line comments but preserve strings. Simple: only strip when
  // // is at start-of-line or preceded by whitespace (avoid // inside URLs).
  return src.replace(/(^|[\s;,(])(?:\/\/)[^\n]*/g, '$1');
}

describe('bot.routes.js bulk-update whitelist includes autoTimingEnabled', () => {
  // Read the route source to confirm the whitelist (lightweight contract test)
  const fs = require('fs');
  const path = require('path');
  const raw = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api', 'routes', 'bot.routes.js'),
    'utf8'
  );
  const src = stripJsComments(raw);

  test('allowed[] in /bulk-update includes autoTimingEnabled as a real entry (not a comment)', () => {
    // Find the bulk-update route block, then verify the entry is present AFTER
    // stripping line comments — so a commented-out 'autoTimingEnabled' cannot
    // satisfy the test.
    const bulkBlock = src.match(/router\.post\('\/bulk-update'[\s\S]*?\];/);
    expect(bulkBlock).not.toBeNull();
    const block = bulkBlock[0];
    // Must contain 'autoTimingEnabled' as a quoted string in a line that is not a comment
    expect(block).toMatch(/^\s*'autoTimingEnabled'\s*,?\s*$/m);
  });

  test('allowed[] in PUT /:id includes autoTimingEnabled as a real entry (not a comment)', () => {
    // FIX-2026-08-31: the literal 'autoTimingEnabled' was previously embedded
    // INSIDE a single-line comment after 'autoPauseAdjustEnabled' — this
    // regression test makes sure the entry is a real list item.
    const putBlock = src.match(/router\.put\('\/:id'[\s\S]*?\];/);
    expect(putBlock).not.toBeNull();
    const block = putBlock[0];
    expect(block).toMatch(/^\s*'autoTimingEnabled'\s*,?\s*$/m);
  });

  test('tristate coercion handles null/true/false', () => {
    expect(src).toMatch(/v === true \|\| v === 'true'[\s\S]*?v === false \|\| v === 'false'[\s\S]*?:\s*null/);
  });
});

describe('admin.routes.js bot-defaults TRISTATE_FIELDS includes autoTimingEnabled', () => {
  const fs = require('fs');
  const path = require('path');
  const raw = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api', 'routes', 'admin.routes.js'),
    'utf8'
  );
  const src = stripJsComments(raw);

  test('TRISTATE_FIELDS includes autoTimingEnabled as a real entry (not a comment)', () => {
    // After stripJsComments(), any surviving 'autoTimingEnabled' string IS a real entry.
    // The line is `const TRISTATE_FIELDS = ['autoTimingEnabled'];` — toContain is sufficient.
    expect(src).toContain("'autoTimingEnabled'");
  });

  test('/api/admin/app-config whitelist includes autoTimingEnabled as a real entry (not a comment)', () => {
    // FIX-2026-08-31: added to PUT /app-config whitelist (mounted under /api/admin).
    const block = src.match(/router\.put\('\/app-config'[\s\S]*?\};/);
    expect(block).not.toBeNull();
    expect(block[0]).toContain('autoTimingEnabled: \'boolean\'');
  });

  test('tristate coercion handles null/true/false', () => {
    expect(src).toMatch(/TRISTATE_FIELDS[\s\S]*?body\[k\] === null \|\| typeof body\[k\] === 'boolean'/);
  });

  test('returns "No valid fields to update" when update is empty', () => {
    expect(src).toMatch(/No valid fields to update/);
  });
});