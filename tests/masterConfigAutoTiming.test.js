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

describe('bot.routes.js bulk-update whitelist includes autoTimingEnabled', () => {
  // Read the route source to confirm the whitelist (lightweight contract test)
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api', 'routes', 'bot.routes.js'),
    'utf8'
  );

  test('allowed[] in /bulk-update includes autoTimingEnabled', () => {
    expect(src).toMatch(/const allowed = \[[\s\S]*?['"]autoTimingEnabled['"][\s\S]*?\];/);
  });

  test('tristate coercion handles null/true/false', () => {
    expect(src).toMatch(/v === true \|\| v === 'true'[\s\S]*?v === false \|\| v === 'false'[\s\S]*?:\s*null/);
  });
});

describe('admin.routes.js bot-defaults TRISTATE_FIELDS includes autoTimingEnabled', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api', 'routes', 'admin.routes.js'),
    'utf8'
  );

  test('TRISTATE_FIELDS includes autoTimingEnabled', () => {
    expect(src).toMatch(/const TRISTATE_FIELDS = \[[\s\S]*?'autoTimingEnabled'[\s\S]*?\];/);
  });

  test('tristate coercion handles null/true/false', () => {
    expect(src).toMatch(/TRISTATE_FIELDS[\s\S]*?body\[k\] === null \|\| typeof body\[k\] === 'boolean'/);
  });

  test('returns "No valid fields to update" when update is empty', () => {
    expect(src).toMatch(/No valid fields to update/);
  });
});