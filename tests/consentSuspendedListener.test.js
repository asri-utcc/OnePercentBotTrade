/**
 * FIX-2026-09-01 audit C8: suspendedByConsent bot listener.
 *
 * Before this fix:
 *   - Admin flipped Machine.suspendedByConsent=true (e.g. via "Decline"
 *     handler at /api/instances POST /consent) → flag changed in admin DB
 *   - Bot had NO listener for that change. Bot kept trading indefinitely
 *     until the bot's local overlay (separate flow) caught it via the
 *     next /api/consent roundtrip.
 *
 * Defense added (bot side):
 *   - New command handlers `consent_suspended` and `consent_resumed` in
 *     commandExecutor.js. Admin MUST queue these via /api/instances/.../commands
 *     whenever Machine.suspendedByConsent is flipped (companion admin-side
 *     change required).
 *   - `consent_suspended` pauses botManager + sets a sticky `_consentSuspended`
 *     flag + re-engages the local consent overlay (mirrors force_reconsent flow).
 *   - `consent_resumed` clears the sticky flag + resumes botManager.
 *   - Both emit eventBus events ('consent:suspended' / 'consent:resumed') for
 *     downstream listeners (Telegram notify, dashboard alert).
 *
 * Companion admin-side change (NOT in this commit, separate repo):
 *   - /admin/machines.js POST /consent and PATCH must queue the matching
 *     command. This file's contract test only verifies the bot-side handler.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const EXEC_PATH = path.join(__dirname, '..', 'src', 'admin-monitor', 'commandExecutor.js');
const execRaw = fs.readFileSync(EXEC_PATH, 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s;,(])\/\/[^\n]*/g, '$1');
}

describe('audit-C8 consent_suspended handler — bot pauses when admin flips flag', () => {
  test('handler is registered in commandExecutor.handlers', () => {
    // Look for the handler key in the literal handlers object
    expect(stripComments(execRaw)).toMatch(/async consent_suspended\(payload, ctx\)\s*\{/);
  });

  test('handler sets the sticky _consentSuspended flag via setConfig', () => {
    const code = stripComments(execRaw);
    expect(code).toMatch(/ctx\.botManager\?\.setConfig\?\.\(['"]_consentSuspended['"],\s*true\)/);
  });

  test('handler records timestamp and reason', () => {
    const code = stripComments(execRaw);
    expect(code).toMatch(/_consentSuspendedAt['"],\s*Date\.now\(\)/);
    expect(code).toMatch(/_consentSuspendedReason['"],\s*reason/);
  });

  test('handler pauses botManager', () => {
    const code = stripComments(execRaw);
    expect(code).toMatch(/await ctx\.botManager\?\.pause\?\.\(reason\)/);
  });

  test('handler re-engages the consent overlay (mirrors force_reconsent)', () => {
    const code = stripComments(execRaw);
    // Should call consentHandlers.forceReset — same call site as force_reconsent
    expect(code).toMatch(/consentHandlers\.forceReset\(\{ source: 'admin_consent_suspended', port \}\)/);
  });

  test('handler emits consent:suspended eventBus event', () => {
    const code = stripComments(execRaw);
    expect(code).toMatch(/ctx\.eventBus\?\.emit\?\.\(['"]consent:suspended['"]/);
  });

  test('return shape includes paused + alreadyPaused + fileDeleted', () => {
    const code = stripComments(execRaw);
    // Verify the return object structure
    const handlerBlock = execRaw.match(/async consent_suspended\(payload, ctx\)\s*\{[\s\S]{0,3000}return\s*\{[\s\S]{0,500}\};?[\s\S]{0,100}\},?/);
    expect(handlerBlock).not.toBeNull();
    expect(handlerBlock[0]).toMatch(/action: 'consent_suspended'/);
    expect(handlerBlock[0]).toMatch(/paused:/);
    expect(handlerBlock[0]).toMatch(/alreadyPaused:/);
    expect(handlerBlock[0]).toMatch(/fileDeleted:/);
  });

  test('audit comment block explains the bypass risk', () => {
    expect(execRaw).toMatch(/audit C8[\s\S]{0,600}consent_suspended/);
  });
});

describe('audit-C8 consent_resumed handler — bot resumes when admin clears flag', () => {
  test('handler is registered in commandExecutor.handlers', () => {
    expect(stripComments(execRaw)).toMatch(/async consent_resumed\(payload, ctx\)\s*\{/);
  });

  test('handler clears the sticky _consentSuspended flag', () => {
    const code = stripComments(execRaw);
    expect(code).toMatch(/ctx\.botManager\?\.setConfig\?\.\(['"]_consentSuspended['"],\s*false\)/);
    expect(code).toMatch(/_consentSuspendedAt['"],\s*null/);
    expect(code).toMatch(/_consentSuspendedReason['"],\s*null/);
  });

  test('handler resumes botManager', () => {
    const code = stripComments(execRaw);
    expect(code).toMatch(/await ctx\.botManager\?\.resume\?\.\(\)/);
  });

  test('handler emits consent:resumed eventBus event', () => {
    const code = stripComments(execRaw);
    expect(code).toMatch(/ctx\.eventBus\?\.emit\?\.\(['"]consent:resumed['"]/);
  });

  test('return shape includes resumed + alreadyRunning', () => {
    const handlerBlock = execRaw.match(/async consent_resumed\(payload, ctx\)\s*\{[\s\S]{0,2000}return\s*\{[\s\S]{0,500}\};?[\s\S]{0,100}\},?/);
    expect(handlerBlock).not.toBeNull();
    expect(handlerBlock[0]).toMatch(/action: 'consent_resumed'/);
    expect(handlerBlock[0]).toMatch(/resumed:/);
    expect(handlerBlock[0]).toMatch(/alreadyRunning:/);
  });
});

describe('audit-C8 regression — existing handlers intact', () => {
  test('pause / resume / kill / force_reconsent / revoke_license still exist', () => {
    const code = stripComments(execRaw);
    expect(code).toMatch(/async pause\(payload, ctx\)/);
    expect(code).toMatch(/async resume\(payload, ctx\)/);
    expect(code).toMatch(/async kill\(payload, ctx\)/);
    expect(code).toMatch(/async force_reconsent\(payload, ctx\)/);
    expect(code).toMatch(/async revoke_license\(payload, ctx\)/);
  });

  test('handlers export still includes execute + handlers', () => {
    expect(execRaw).toMatch(/module\.exports\s*=\s*\{\s*execute,\s*handlers\s*\};/);
  });
});

describe('audit-C8 documentation — comment block cites companion admin change', () => {
  test('consent_suspended comment mentions admin-side queue requirement', () => {
    expect(execRaw).toMatch(/admin MUST queue this command/i);
  });

  test('consent_resumed comment explains why bot must clear sticky flag', () => {
    expect(execRaw).toMatch(/sticky .?_consentSuspended/i);
  });
});
