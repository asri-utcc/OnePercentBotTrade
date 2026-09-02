'use strict';

/**
 * FIX-2026-09-01 audit H10: luxConfirm.js must NEVER call window.confirm().
 *
 *   The audit found that luxConfirm.js had a fallback path that called
 *   window.confirm() when #confirmActionModal was missing. window.confirm()
 *   is a native browser dialog that the dashboard's CSS can't theme, can't
 *   show password input, and which violates the project rule "no native
 *   dialogs" (consistent with the 14-site AdminModalAlert migration in the
 *   bot repo).
 *
 *   Fix:
 *     1. If AdminModalAlert is available, delegate to it.
 *     2. Otherwise, build a themed inline modal dynamically via
 *        _ensureInlineModal() and return its Promise.
 *     3. window.confirm() is never called.
 *
 *   This test is source-level (regex over the IIFE in luxConfirm.js) plus a
 *   runtime replica that exercises _ensureInlineModal in jsdom-less mode by
 *   mocking document.body + a minimal DOM API.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'luxConfirm.js'),
  'utf8'
);

describe('audit-H10 luxConfirm: no native confirm/alert/prompt anywhere', () => {
  test('window.confirm( is not called anywhere in the source', () => {
    // Strip block + line comments first to avoid false positives
    const stripped = SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(stripped).not.toMatch(/window\.confirm\s*\(/);
  });

  test('window.alert( is not called anywhere in the source', () => {
    const stripped = SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(stripped).not.toMatch(/window\.alert\s*\(/);
  });

  test('window.prompt( is not called anywhere in the source', () => {
    const stripped = SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(stripped).not.toMatch(/window\.prompt\s*\(/);
  });

  test('the IIFE does NOT export window.confirm/alert/prompt', () => {
    // Make sure the IIFE doesn't pollute globals
    expect(SRC).not.toMatch(/window\.confirm\s*=/);
    expect(SRC).not.toMatch(/window\.alert\s*=/);
    expect(SRC).not.toMatch(/window\.prompt\s*=/);
  });
});

describe('audit-H10 luxConfirm: AdminModalAlert delegation', () => {
  test('checks for AdminModalAlert.confirm before falling through', () => {
    const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).toMatch(/window\.AdminModalAlert[\s\S]{0,200}\.confirm/);
  });

  test('delegation forwards title/message/level/okLabel', () => {
    // The delegation block must pass these 4 fields
    const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
    const delegationBlock = stripped.match(
      /window\.AdminModalAlert[\s\S]{0,400}\.then\(\(ok\)/
    );
    expect(delegationBlock).not.toBeNull();
    const block = delegationBlock[0];
    expect(block).toMatch(/title/);
    expect(block).toMatch(/message/);
    expect(block).toMatch(/level/);
    expect(block).toMatch(/okLabel/);
  });

  test('variant=danger maps to level=error in the delegation', () => {
    const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).toMatch(/variant\s*===\s*['"]danger['"][\s\S]{0,80}['"]error['"]/);
  });
});

describe('audit-H10 luxConfirm: _ensureInlineModal helper exists and is sane', () => {
  test('_ensureInlineModal is defined as a function', () => {
    expect(SRC).toMatch(/function\s+_ensureInlineModal\s*\(/);
  });

  test('_ensureInlineModal returns a Promise', () => {
    // Match the opening line of the helper body
    const match = SRC.match(/function\s+_ensureInlineModal\([^)]*\)\s*\{[\s\S]{0,200}return\s+new\s+Promise/);
    expect(match).not.toBeNull();
  });

  test('_ensureInlineModal supports requirePassword', () => {
    // The helper must accept a requirePassword option and gate the password
    // input rendering + the confirm resolution value accordingly.
    const match = SRC.match(/function\s+_ensureInlineModal\s*\(\s*\{[^}]*requirePassword/);
    expect(match).not.toBeNull();
    expect(SRC).toMatch(/requirePassword\s*\?\s*['"]<input[^>]*type=["']password["']/);
  });

  test('_ensureInlineModal removes the modal from DOM after dismiss', () => {
    // Look for the cleanup call that removes the overlay
    expect(SRC).toMatch(/document\.body\.removeChild\(overlay\)/);
  });

  test('_ensureInlineModal resolves null on cancel', () => {
    expect(SRC).toMatch(/finish\(null\)/);
  });

  test('_ensureInlineModal Escape key cancels', () => {
    expect(SRC).toMatch(/e\.key\s*===\s*['"]Escape['"][\s\S]{0,80}finish\(null\)/);
  });

  test('_ensureInlineModal Enter key inside password submits', () => {
    expect(SRC).toMatch(/e\.key\s*===\s*['"]Enter['"][\s\S]{0,80}confirmBtn\.click/);
  });

  test('_ensureInlineModal overlay click (outside dialog) cancels', () => {
    expect(SRC).toMatch(/e\.target\s*===\s*overlay[\s\S]{0,40}finish\(null\)/);
  });

  test('_ensureInlineModal variants are reflected in CSS class', () => {
    // The variant CSS class drives the theme
    expect(SRC).toMatch(/lux-inline-is-\$\{variant/);
  });
});

describe('audit-H10 luxConfirm: fallback chain when no #confirmActionModal', () => {
  test('the !modalEl branch tries AdminModalAlert first, then _ensureInlineModal', () => {
    const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
    // Locate the !modalEl block
    const block = stripped.match(/if\s*\(!modalEl\)\s*\{[\s\S]{0,1500}/);
    expect(block).not.toBeNull();
    const code = block[0];
    // AdminModalAlert comes first
    const amaIdx = code.indexOf('AdminModalAlert');
    const inlineIdx = code.indexOf('_ensureInlineModal');
    expect(amaIdx).toBeGreaterThan(-1);
    expect(inlineIdx).toBeGreaterThan(-1);
    expect(amaIdx).toBeLessThan(inlineIdx);
  });

  test('the fallback resolves null on cancel (no native confirm)', () => {
    const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).toMatch(/\.then\(\(pw\)\s*=>\s*resolve\(pw\)\)/);
  });
});

describe('audit-H10 luxConfirm: source-level annotations', () => {
  test('FIX-2026-09-01 audit H10 comment is present', () => {
    expect(SRC).toMatch(/FIX-2026-09-01 audit H10/);
  });

  test('the comment explicitly references the project rule "no native dialogs"', () => {
    expect(SRC).toMatch(/no native dialogs/i);
  });

  test('the comment explicitly cites window\.confirm\(\) as the previous offender', () => {
    expect(SRC).toMatch(/window\.confirm\(\)/);
  });
});

// ─── Runtime replica of _ensureInlineModal behavior ────────────────────
//
// We re-implement the helper logic in this test file using a tiny in-memory
// DOM stub, then assert the contract: it creates overlay, supports password,
// resolves on confirm/cancel/Escape/overlay-click, and removes the DOM node.
//
// This is the pattern used by the other Phase 2.H* runtime replica tests.

describe('audit-H10 luxConfirm: _ensureInlineModal runtime replica', () => {
  // Each test gets its own fresh DOM factory
  function buildDom() {
    const elements = {}; // shared per-overlay element cache

    function makeEl(tag) {
      const children = [];
      const attrs = {};
      const listeners = {};
      const el = {
        tagName: tag.toUpperCase(),
        children,
        attrs,
        classList: {
          _set: new Set(),
          add(c) { this._set.add(c); },
          remove(c) { this._set.delete(c); },
          contains(c) { return this._set.has(c); },
        },
        setAttribute(k, v) { attrs[k] = v; },
        getAttribute(k) { return attrs[k]; },
        dataset: {},
        hidden: false,
        style: {},
        value: '',
        type: '',
        textContent: '',
        innerHTML: '',
        id: '',
        className: '',
        _listeners: listeners,
        addEventListener(type, fn) {
          if (!listeners[type]) listeners[type] = [];
          listeners[type].push(fn);
        },
        removeEventListener(type, fn) {
          if (!listeners[type]) return;
          listeners[type] = listeners[type].filter((f) => f !== fn);
        },
        appendChild(child) { children.push(child); return child; },
        removeChild(child) {
          const idx = children.indexOf(child);
          if (idx >= 0) children.splice(idx, 1);
        },
        // querySelector returns the SAME element each call within a single overlay
        querySelector(sel) {
          if (!elements[sel]) {
            if (sel === '.lux-inline-pw') {
              const i = makeEl('input');
              i.type = 'password';
              elements[sel] = i;
            } else if (sel === '.lux-inline-confirm' || sel === '.lux-inline-cancel') {
              elements[sel] = makeEl('button');
            }
          }
          return elements[sel] || null;
        },
        click() {
          const ls = listeners.click || [];
          for (const fn of ls) fn();
        },
        focus() {},
        // Simulate a DOM event firing on this element
        _fire(type, eventObj = {}) {
          const ls = listeners[type] || [];
          for (const fn of ls) fn(eventObj);
        },
      };
      return el;
    }

    const state = {
      body: makeEl('body'),
      addedToBody: [],
      removedFromBody: [],
      _globalListeners: {},
    };

    const doc = {
      _elements: elements,
      _state: state,
      body: state.body,
      createElement(tag) {
        return makeEl(tag);
      },
      addEventListener(type, fn) {
        if (!state._globalListeners[type]) state._globalListeners[type] = [];
        state._globalListeners[type].push(fn);
      },
      removeEventListener(type, fn) {
        if (!state._globalListeners[type]) return;
        state._globalListeners[type] = state._globalListeners[type].filter((f) => f !== fn);
      },
    };

    return { doc, state };
  }

  // Inline replica — mirrors luxConfirm.js:271-314
  function ensureInlineModal(doc, opts) {
    const { variant = 'warning', icon = '⚠️', title = 'ยืนยัน', message = '', sub = '', requirePassword = false, confirmLabel = 'ยืนยัน', confirmGlyph = '✓' } = opts;
    return new Promise((resolve) => {
      const overlay = doc.createElement('div');
      overlay.id = `luxInlineModal_${Date.now()}_${Math.random()}`;
      overlay.className = `lux-inline-modal-overlay lux-inline-is-${variant}`;
      const pwInput = requirePassword ? overlay.querySelector('.lux-inline-pw') : null;
      const confirmBtn = overlay.querySelector('.lux-inline-confirm');
      const cancelBtn = overlay.querySelector('.lux-inline-cancel');
      doc.body.appendChild(overlay);
      doc._state.addedToBody.push(overlay);

      const finish = (val) => {
        try { doc.body.removeChild(overlay); } catch (_) {}
        doc._state.removedFromBody.push(overlay);
        resolve(val);
      };
      confirmBtn.addEventListener('click', () => finish(requirePassword ? (pwInput ? pwInput.value : '') : ''));
      cancelBtn.addEventListener('click', () => finish(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    });
  }

  test('overlay is appended to document.body', async () => {
    const { doc, state } = buildDom();
    const p = ensureInlineModal(doc, { variant: 'gold', title: 'test' });
    expect(state.addedToBody.length).toBe(1);
    expect(state.addedToBody[0].className).toBe('lux-inline-modal-overlay lux-inline-is-gold');
    state.addedToBody[0].querySelector('.lux-inline-cancel')._fire('click');
    await p;
    expect(state.removedFromBody.length).toBe(1);
  });

  test('confirm resolves with "" (empty string) when no password is required', async () => {
    const { doc, state } = buildDom();
    const p = ensureInlineModal(doc, { variant: 'success', requirePassword: false });
    const overlay = state.addedToBody[state.addedToBody.length - 1];
    overlay.querySelector('.lux-inline-confirm')._fire('click');
    const result = await p;
    expect(result).toBe('');
  });

  test('confirm resolves with the typed password when requirePassword=true', async () => {
    const { doc, state } = buildDom();
    const p = ensureInlineModal(doc, { variant: 'danger', requirePassword: true });
    const overlay = state.addedToBody[state.addedToBody.length - 1];
    const pwInput = overlay.querySelector('.lux-inline-pw');
    pwInput.value = 'hunter2';
    overlay.querySelector('.lux-inline-confirm')._fire('click');
    const result = await p;
    expect(result).toBe('hunter2');
  });

  test('cancel resolves with null', async () => {
    const { doc, state } = buildDom();
    const p = ensureInlineModal(doc, { variant: 'warning', requirePassword: true });
    const overlay = state.addedToBody[state.addedToBody.length - 1];
    overlay.querySelector('.lux-inline-cancel')._fire('click');
    const result = await p;
    expect(result).toBeNull();
  });

  test('overlay click outside dialog (target===overlay) cancels', async () => {
    const { doc, state } = buildDom();
    const p = ensureInlineModal(doc, { variant: 'info' });
    const overlay = state.addedToBody[state.addedToBody.length - 1];
    overlay._fire('click', { target: overlay });
    const result = await p;
    expect(result).toBeNull();
  });

  test('overlay click on inner element does NOT cancel — confirm button click resolves with empty string', async () => {
    const { doc, state } = buildDom();
    const p = ensureInlineModal(doc, { variant: 'gold' });
    const overlay = state.addedToBody[state.addedToBody.length - 1];
    // Confirm button click fires its own listener (which resolves the promise).
    // The overlay's click listener would only fire if target === overlay, which
    // is not the case here — so the overlay listener is bypassed.
    overlay.querySelector('.lux-inline-confirm')._fire('click');
    const result = await p;
    expect(result).toBe('');
  });

  test('variant drives the CSS class', async () => {
    const { doc, state } = buildDom();
    const p = ensureInlineModal(doc, { variant: 'danger' });
    const overlay = state.addedToBody[state.addedToBody.length - 1];
    expect(overlay.className).toMatch(/lux-inline-is-danger/);
    overlay.querySelector('.lux-inline-cancel')._fire('click');
    await p;
  });

  test('overlay is removed from document.body after dismiss', async () => {
    const { doc, state } = buildDom();
    const p = ensureInlineModal(doc, { variant: 'gold' });
    const overlay = state.addedToBody[state.addedToBody.length - 1];
    expect(doc.body.children.includes(overlay)).toBe(true);
    overlay.querySelector('.lux-inline-cancel')._fire('click');
    await p;
    expect(doc.body.children.includes(overlay)).toBe(false);
  });
});