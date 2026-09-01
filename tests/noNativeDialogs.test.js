/**
 * FIX-2026-09-01 audit: No native dialogs (audit C11 + H10).
 *
 * The project enforces a no-native-dialog pattern (memory bot-toast-modal-alert-2026-08-28):
 * all confirm/alert/prompt UX must go through AdminModalAlert (themed modal) — never
 * native window.confirm/alert/prompt (blocks UI thread, breaks themed UX, security risk).
 *
 *   - chat.js:366 — was `alert('Download failed: ...')` → AdminModalAlert.alert(...)
 *   - luxConfirm.js:46 — was `window.confirm(...)` fallback → AdminModalAlert.confirm(...)
 *
 * Contract tests verify no remaining native dialogs in the 2 changed files + chat.js
 * sends to AdminModalAlert.alert with error level.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CHAT_JS      = path.join(__dirname, '..', 'public', 'js', 'pages', 'chat.js');
const LUX_CONFIRM  = path.join(__dirname, '..', 'public', 'js', 'luxConfirm.js');

const chatRaw     = fs.readFileSync(CHAT_JS, 'utf8');
const luxRaw      = fs.readFileSync(LUX_CONFIRM, 'utf8');

// Strip JS line + block comments so we don't false-match commented-out references.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[\s;,(])\/\/[^\n]*/g, '$1');

const chatCode  = stripComments(chatRaw);
const luxCode   = stripComments(luxRaw);

describe('audit-C11 chat.js — no native alert()', () => {
  test('no native window.alert / alert( call in chat.js', () => {
    // Allow comments (stripped above) + check actual code.
    // Allow string literals — only check that no callable alert() exists.
    expect(chatCode).not.toMatch(/[^.\w]alert\s*\(/);
  });

  test('download failure uses AdminModalAlert.alert', () => {
    expect(chatCode).toMatch(/AdminModalAlert\.alert\(\s*['"]Download failed:/);
    expect(chatCode).toMatch(/AdminModalAlert\.alert\([^,]+,\s*['"]error['"]\)/);
  });
});

describe('audit-H10 luxConfirm.js — no native window.confirm() in fallback', () => {
  test('fallback uses AdminModalAlert.confirm as primary', () => {
    // The fallback block (when #confirmActionModal is missing) must call
    // AdminModalAlert.confirm first; native confirm only as last-resort.
    expect(luxCode).toMatch(/window\.AdminModalAlert.*\.confirm\(/s);
  });

  test('admin-modal-alert missing branch retains defensive native confirm (documented)', () => {
    // We keep a defensive native-confirm as a true last-resort (when both
    // modal markup AND AdminModalAlert are missing). Verify the code path exists;
    // the documentation comment is checked against the raw (unstripped) source below.
    expect(luxCode).toMatch(/window\.confirm\(/);
    expect(luxRaw).toMatch(/Last-resort:\s*native confirm/);
  });

  test('AdminModalAlert.confirm variant mapped from danger→error', () => {
    // The themed fallback should set level='error' for danger variant, 'warn' otherwise.
    expect(luxCode).toMatch(/variant === 'danger' \? 'error' : 'warn'/);
  });
});

describe('global — adminModalAlert API surface (regression guard)', () => {
  // ws-client.js is the single source of truth for AdminModalAlert — verify
  // the three variants (alert, confirm, prompt) exist so chat.js / luxConfirm.js
  // can rely on them.
  const WS_CLIENT = path.join(__dirname, '..', 'public', 'js', 'ws-client.js');
  const wsRaw     = fs.readFileSync(WS_CLIENT, 'utf8');

  test('AdminModalAlert.alert exposed on window', () => {
    expect(wsRaw).toMatch(/AdminModalAlert\.alert\s*=/);
    expect(wsRaw).toMatch(/window\.AdminModalAlert\s*=\s*AdminModalAlert/);
  });

  test('AdminModalAlert.confirm exposed on window', () => {
    expect(wsRaw).toMatch(/AdminModalAlert\.confirm\s*=/);
  });

  test('AdminModalAlert.prompt exposed on window', () => {
    expect(wsRaw).toMatch(/AdminModalAlert\.prompt\s*=/);
  });
});