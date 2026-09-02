'use strict';

/**
 * FIX-2026-09-01 audit H12: WS reconnect uses ±25% jitter.
 *
 *   Before: ws-client.js onclose did `setTimeout(_connect, reconnectDelay)`
 *   where reconnectDelay doubled 1000 → 2000 → ... → 30000 with NO jitter.
 *   When the backend drops, every browser tab on every user's machine tries
 *   to reconnect at exactly the same instant (e.g. 1000ms after disconnect,
 *   then 2000ms after that, etc) — a textbook thundering-herd.
 *
 *   Fix: each reconnect delay gets ±25% jitter
 *     delay = base * (0.75 + Math.random() * 0.5)
 *     → delay ∈ [0.75*base, 1.25*base]
 *
 *   The exponential backoff schedule is preserved (cap stays at 30s); the
 *   jitter only varies the per-attempt delay within a 0.5x window.
 *
 *   Tests:
 *     1. Source-level: jitter formula + reset-on-success behaviour.
 *     2. Runtime replica: simulate 1000 reconnects, assert distribution.
 */

const fs = require('fs');
const path = require('path');

const WS_PATH = path.join(__dirname, '..', 'public', 'js', 'ws-client.js');
const wsRaw = fs.readFileSync(WS_PATH, 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const wsCode = stripComments(wsRaw);

describe('audit-H12 ws-client: jitter formula in source', () => {
  test('onclose branch uses Math.random() for jitter', () => {
    // The reconnect delay computation must reference Math.random()
    expect(wsCode).toMatch(/Math\.random\(\)/);
  });

  test('jitter multiplier is 0.5 (±25% around base)', () => {
    // 0.75 + Math.random() * 0.5 gives [0.75, 1.25] — ±25%
    expect(wsCode).toMatch(/0\.75\s*\+\s*Math\.random\(\)\s*\*\s*0\.5/);
  });

  test('exponential backoff still caps at 30000ms', () => {
    // Sanity: the cap is preserved
    expect(wsCode).toMatch(/Math\.min\([^,]*?\*\s*2\s*,\s*30000\)/);
  });

  test('FIX-2026-09-01 audit H12 comment present', () => {
    expect(wsRaw).toMatch(/FIX-2026-09-01 audit H12/);
  });
});

describe('audit-H12 ws-client: reset-on-success still present', () => {
  // When the WS successfully connects (after reconnect), the delay must reset
  // back to the base so a transient blip doesn't leave us stuck on 30s.
  test('reconnectDelay is reset to 1000 on successful connect', () => {
    // The constructor sets it to 1000 (line 24); on successful connection the
    // code should reset it. Look for either `this.reconnectDelay = 1000` in
    // onopen or a similar reset path.
    expect(wsCode).toMatch(/this\.reconnectDelay\s*=\s*1000/);
  });
});

// ─── Runtime replica of the jitter math ────────────────────────────────

describe('audit-H12 ws-client: runtime replica of jitter', () => {
  // Re-implement the exact line from ws-client.js
  function applyJitter(base) {
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  test('jitter stays within ±25% of base for base=1000', () => {
    for (let i = 0; i < 1000; i++) {
      const d = applyJitter(1000);
      expect(d).toBeGreaterThanOrEqual(750);
      expect(d).toBeLessThanOrEqual(1250);
    }
  });

  test('jitter stays within ±25% of base for base=8000', () => {
    for (let i = 0; i < 1000; i++) {
      const d = applyJitter(8000);
      expect(d).toBeGreaterThanOrEqual(6000);
      expect(d).toBeLessThanOrEqual(10000);
    }
  });

  test('jitter stays within ±25% of base for base=30000 (capped)', () => {
    for (let i = 0; i < 1000; i++) {
      const d = applyJitter(30000);
      expect(d).toBeGreaterThanOrEqual(22500);
      expect(d).toBeLessThanOrEqual(37500);
    }
  });

  test('1000-sample distribution looks uniform-ish (no clustering at one end)', () => {
    const N = 1000;
    let below = 0;
    let above = 0;
    for (let i = 0; i < N; i++) {
      const d = applyJitter(1000);
      if (d < 1000) below++;
      else if (d > 1000) above++;
    }
    // Expect roughly 50/50 split between below-base and above-base.
    // Allow generous tolerance for the random variance.
    expect(below).toBeGreaterThan(350);
    expect(below).toBeLessThan(650);
    expect(above).toBeGreaterThan(350);
    expect(above).toBeLessThan(650);
  });

  test('two consecutive jittered delays are usually different (no thundering-herd)', () => {
    // Sample 100 pairs; assert that within any pair the two values differ.
    let equalCount = 0;
    for (let i = 0; i < 100; i++) {
      const a = applyJitter(1000);
      const b = applyJitter(1000);
      if (a === b) equalCount++;
    }
    // Could in principle match if both random samples land on the same int
    // after rounding — but with 500 distinct int values in [750, 1250] the
    // expected collision count over 100 pairs is well under 5.
    expect(equalCount).toBeLessThan(10);
  });

  test('jitter never returns the same value 1000 times in a row', () => {
    // Sanity: Math.random() works
    const set = new Set();
    for (let i = 0; i < 100; i++) set.add(applyJitter(1000));
    expect(set.size).toBeGreaterThan(20); // expect at least 20 distinct values
  });
});

describe('audit-H12 ws-client: no-regression — no fixed-delay back-to-back calls', () => {
  // The fix replaces the EXACT line `setTimeout(_connect, this.reconnectDelay)`
  // with a jittered version. Make sure no OTHER reconnect path uses the raw
  // base delay without jitter.
  test('all setTimeout(_connect ...) calls reference the jittered variable', () => {
    // Find all setTimeout calls that call _connect
    const lines = wsCode.match(/setTimeout\([^)]*_connect[^)]*,[^)]*\)/g) || [];
    for (const line of lines) {
      // Must reference `jittered` (not the raw this.reconnectDelay)
      expect(line).toMatch(/jittered/);
      expect(line).not.toMatch(/this\.reconnectDelay(?!\s*\*)/); // allow "reconnectDelay * 2"
    }
  });
});