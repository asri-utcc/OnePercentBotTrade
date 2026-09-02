'use strict';

/**
 * FIX-2026-09-01 audit H7: Auto-Timing DB write on every BUY → throttle.
 *
 *   Before: every call to decideForBot() → Bot.updateOne + AutoTimingLog.create
 *     (2 writes per BUY). With active bots trading every candle (3-5m),
 *     this is thousands of writes/day/bot, mostly redundant (same decision
 *     repeated).
 *
 *   After: throttle — only persist when EITHER:
 *     - The decision signature changed (action/blocked/reason/cell differs)
 *     - 60s have elapsed since the last persist (periodic heartbeat)
 *     - The decision is blocked (Suppress — always persist, critical audit)
 *
 *   This test verifies the throttle logic in isolation (replica) plus source-level
 *   assertions that the production code uses the throttle.
 */

function makeThrottler({ persistIntervalMs = 60_000 } = {}) {
  return {
    _lastPersistAt: new Map(),
    _lastPersistSig: new Map(),
    _PERSIST_INTERVAL_MS: persistIntervalMs,
    _writes: 0,
    shouldPersist(botId, decision, nowMs) {
      const sig = `${decision.effectiveAction}|${decision.blocked ? 1 : 0}|${decision.reason || ''}|${decision.day}|${decision.hour}`;
      const lastAt = this._lastPersistAt.get(botId) || 0;
      const lastSig = this._lastPersistSig.get(botId) || '';
      const elapsed = nowMs - lastAt;
      const sigChanged = lastSig !== sig;
      const isSuppress = decision.blocked === true;
      const should = sigChanged || isSuppress || elapsed >= this._PERSIST_INTERVAL_MS;
      if (should) {
        this._lastPersistAt.set(botId, nowMs);
        this._lastPersistSig.set(botId, sig);
        this._writes += 1;
      }
      return should;
    },
  };
}

describe('audit-H7 throttle: 1 persist per state-change or 60s, Suppress always', () => {
  test('first call for a bot → persist (cold cache)', () => {
    const t = makeThrottler();
    const d = { effectiveAction: 'allow', blocked: false, reason: 'within_band', day: 1, hour: 8 };
    expect(t.shouldPersist('botA', d, 1000)).toBe(true);
    expect(t._writes).toBe(1);
  });

  test('same bot + same decision within 60s → skip', () => {
    const t = makeThrottler();
    const d = { effectiveAction: 'allow', blocked: false, reason: 'within_band', day: 1, hour: 8 };
    t.shouldPersist('botA', d, 1000);
    expect(t.shouldPersist('botA', d, 5000)).toBe(false);  // 4s later
    expect(t.shouldPersist('botA', d, 30 * 1000)).toBe(false);
    expect(t._writes).toBe(1);
  });

  test('same bot + same decision after 60s → periodic refresh persists', () => {
    const t = makeThrottler();
    const d = { effectiveAction: 'allow', blocked: false, reason: 'within_band', day: 1, hour: 8 };
    t.shouldPersist('botA', d, 1000);
    expect(t.shouldPersist('botA', d, 61 * 1000)).toBe(true); // 61s later
    expect(t._writes).toBe(2);
  });

  test('state change (action differs) → persist immediately', () => {
    const t = makeThrottler();
    const allow = { effectiveAction: 'allow', blocked: false, reason: 'within_band', day: 1, hour: 8 };
    const limit = { effectiveAction: 'limit', blocked: false, reason: 'borderline_pnl', day: 1, hour: 8 };
    t.shouldPersist('botA', allow, 1000);
    expect(t.shouldPersist('botA', limit, 2000)).toBe(true); // 2s later but different action
    expect(t._writes).toBe(2);
  });

  test('state change (cell moves day/hour) → persist', () => {
    const t = makeThrottler();
    const a = { effectiveAction: 'allow', blocked: false, reason: 'within_band', day: 1, hour: 8 };
    const b = { effectiveAction: 'allow', blocked: false, reason: 'within_band', day: 1, hour: 9 }; // +1h
    t.shouldPersist('botA', a, 1000);
    expect(t.shouldPersist('botA', b, 2000)).toBe(true);
  });

  test('Suppress ALWAYS persists (even within 60s and same decision)', () => {
    const t = makeThrottler();
    const suppress = { effectiveAction: 'suppress', blocked: true, reason: 'cell_suppressed', day: 0, hour: 3 };
    t.shouldPersist('botA', suppress, 1000);
    expect(t.shouldPersist('botA', suppress, 1500)).toBe(true); // same instant, same cell — should still persist
    expect(t._writes).toBe(2);
  });

  test('different bots have independent throttle state', () => {
    const t = makeThrottler();
    const d = { effectiveAction: 'allow', blocked: false, reason: 'within_band', day: 1, hour: 8 };
    t.shouldPersist('botA', d, 1000);
    expect(t.shouldPersist('botB', d, 1500)).toBe(true); // botB cold
    expect(t.shouldPersist('botA', d, 2000)).toBe(false); // botA warm
    expect(t._writes).toBe(2);
  });

  test('reason change (within same action/blocked) triggers persist', () => {
    const t = makeThrottler();
    const a = { effectiveAction: 'limit', blocked: false, reason: 'pnl_-0.05', day: 1, hour: 8 };
    const b = { effectiveAction: 'limit', blocked: false, reason: 'pnl_-0.08', day: 1, hour: 8 };
    t.shouldPersist('botA', a, 1000);
    expect(t.shouldPersist('botA', b, 2000)).toBe(true); // reason changed
  });

  test('10 rapid same-decision calls within 60s → only 1 write', () => {
    const t = makeThrottler();
    const d = { effectiveAction: 'allow', blocked: false, reason: 'within_band', day: 1, hour: 8 };
    for (let i = 0; i < 10; i++) {
      t.shouldPersist('botA', d, 1000 + i * 100);
    }
    expect(t._writes).toBe(1);
  });
});

describe('audit-H7 source: autoTiming.js implements throttle', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = path.join(__dirname, '..', 'src', 'services', 'autoTiming.js');

  test('FIX-2026-09-01 audit H7 comment present', () => {
    expect(fs.readFileSync(SRC, 'utf8')).toMatch(/FIX-2026-09-01 audit H7/);
  });

  test('_lastPersistAt and _lastPersistSig maps are declared on the class', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src).toMatch(/this\._lastPersistAt\s*=\s*new Map\(\)/);
    expect(src).toMatch(/this\._lastPersistSig\s*=\s*new Map\(\)/);
  });

  test('throttle constants: PERSIST_INTERVAL_MS = 60 * 1000', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src).toMatch(/_PERSIST_INTERVAL_MS\s*=\s*60\s*\*\s*1000/);
  });

  test('telemetry block gated by shouldPersist-style conditional (sigChanged || isSuppress || elapsed)', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const block = src.match(/FIX-2026-09-01 audit H7:[\s\S]{0,1500}if\s*\(shouldPersist\)/);
    expect(block).not.toBeNull();
    const body = block[0];
    expect(body).toMatch(/sigChanged/);
    expect(body).toMatch(/isSuppress/);
    expect(body).toMatch(/elapsed\s*>=/);
  });

  test('Suppress always persists: decision.blocked === true branch', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src).toMatch(/const\s+isSuppress\s*=\s*decision\.blocked\s*===\s*true/);
  });
});
