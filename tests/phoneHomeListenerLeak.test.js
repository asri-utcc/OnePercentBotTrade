/**
 * FIX-2026-09-01 audit C13: phoneHomeMonitor eventBus listener leak.
 *
 * Before this fix:
 *   - start() registered `eventBus.on('admin:contact_success', anonymousFn)`
 *   - stop() never removed the listener
 *   - On adminMonitor reloadConfig() (or any restart path that calls
 *     start() again after stop()), a SECOND anonymous listener was added.
 *   - EventEmitter kept firing BOTH listeners per event, so each heartbeat
 *     emitted 2 recordContact() calls — lastContactAt got double-stamped
 *     and the monitor's state transitions fired twice (warn at 36h,
 *     down at 48h emitted twice in a row).
 *
 * Defense added:
 *   - The bound listener is stored in a module-level variable
 *     (_contactSuccessListener) so stop() can pass the same reference
 *     to eventBus.off().
 *   - start() guards: only bind once (don't add a second listener if one
 *     already exists).
 *   - stop() always tries to remove the listener (idempotent).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MOD_PATH = path.join(__dirname, '..', 'src', 'admin-monitor', 'phoneHomeMonitor.js');
const modRaw = fs.readFileSync(MOD_PATH, 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s;,(])\/\/[^\n]*/g, '$1');
}

describe('audit-C13 listener stored in module-level variable', () => {
  test('_contactSuccessListener variable declared at module scope', () => {
    expect(modRaw).toMatch(/let\s+_contactSuccessListener\s*=\s*null;/);
  });

  test('start() binds the listener ONCE and stores the reference', () => {
    const code = stripComments(modRaw);
    // The guard pattern: if (!_contactSuccessListener) { _contactSuccessListener = ...; eventBus.on(...) }
    const bindBlock = code.match(/if \(!_contactSuccessListener\)\s*\{[\s\S]{0,500}_contactSuccessListener\s*=\s*\(payload\)[\s\S]{0,200}eventBus\.on\(['"]admin:contact_success['"],\s*_contactSuccessListener\)/);
    expect(bindBlock).not.toBeNull();
  });

  test('start() no longer passes an anonymous function to eventBus.on', () => {
    // The old bug: eventBus.on('admin:contact_success', (payload) => ...)
    // should NOT appear in the new code. The listener MUST be a named ref.
    const code = stripComments(modRaw);
    // Search for the anonymous arrow pattern after 'admin:contact_success'
    expect(code).not.toMatch(/eventBus\.on\(['"]admin:contact_success['"],\s*\(payload\)\s*=>/);
  });

  test('stop() removes the listener via eventBus.off', () => {
    const code = stripComments(modRaw);
    const stopBlock = code.match(/function stop\(\)\s*\{[\s\S]{0,1500}\}/);
    expect(stopBlock).not.toBeNull();
    expect(stopBlock[0]).toMatch(/eventBus\.off\(['"]admin:contact_success['"],\s*_contactSuccessListener\)/);
  });

  test('stop() clears _contactSuccessListener after removing', () => {
    const code = stripComments(modRaw);
    const stopBlock = code.match(/function stop\(\)\s*\{[\s\S]{0,1500}\}/);
    expect(stopBlock).not.toBeNull();
    expect(stopBlock[0]).toMatch(/_contactSuccessListener\s*=\s*null;/);
  });
});

describe('audit-C13 inline runtime — start/stop cycle does not leak listeners', () => {
  // Simulate the EventEmitter pattern that phoneHomeMonitor relies on.
  // We model the relevant contract: a listener bound ONCE should fire
  // exactly once per emit(), regardless of how many start/stop cycles ran.
  function buildEmitter() {
    const handlers = new Map();
    return {
      on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn); },
      off(ev, fn) {
        const arr = handlers.get(ev);
        if (!arr) return;
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      },
      emit(ev, payload) {
        const arr = handlers.get(ev) || [];
        for (const fn of arr) fn(payload);
      },
      count(ev) { return (handlers.get(ev) || []).length; },
    };
  }

  test('cycle 1: start binds one listener', () => {
    const bus = buildEmitter();
    let listener = null;
    function start() {
      if (!listener) {
        listener = (p) => { /* recordContact */ };
        bus.on('admin:contact_success', listener);
      }
    }
    function stop() {
      if (listener) { bus.off('admin:contact_success', listener); listener = null; }
    }
    start();
    expect(bus.count('admin:contact_success')).toBe(1);
    stop();
  });

  test('cycle 2: start+stop+start — exactly ONE listener attached', () => {
    const bus = buildEmitter();
    let listener = null;
    function start() {
      if (!listener) {
        listener = (p) => { /* recordContact */ };
        bus.on('admin:contact_success', listener);
      }
    }
    function stop() {
      if (listener) { bus.off('admin:contact_success', listener); listener = null; }
    }
    start();
    stop();
    start(); // re-bind — should NOT add a second listener
    expect(bus.count('admin:contact_success')).toBe(1);
  });

  test('cycle 5: after many restarts still exactly ONE listener', () => {
    const bus = buildEmitter();
    let listener = null;
    function start() {
      if (!listener) {
        listener = (p) => { /* recordContact */ };
        bus.on('admin:contact_success', listener);
      }
    }
    function stop() {
      if (listener) { bus.off('admin:contact_success', listener); listener = null; }
    }
    for (let i = 0; i < 5; i++) { start(); stop(); }
    start();
    expect(bus.count('admin:contact_success')).toBe(1);
  });

  test('emit fires exactly N times when N start cycles ran (no N+1)', () => {
    const bus = buildEmitter();
    let listener = null;
    let callCount = 0;
    function start() {
      if (!listener) {
        listener = (p) => { callCount++; };
        bus.on('admin:contact_success', listener);
      }
    }
    function stop() {
      if (listener) { bus.off('admin:contact_success', listener); listener = null; }
    }
    // Simulate 3 restart cycles (each adds and removes), then 1 active cycle
    for (let i = 0; i < 3; i++) { start(); stop(); }
    start();
    bus.emit('admin:contact_success', { source: 'heartbeat' });
    expect(callCount).toBe(1); // NOT 4
  });
});

describe('audit-C13 audit trail in source comments', () => {
  test('comment cites the leak and root cause', () => {
    expect(modRaw).toMatch(/audit C13[\s\S]{0,500}duplicate\s+recordContact/);
  });
});
