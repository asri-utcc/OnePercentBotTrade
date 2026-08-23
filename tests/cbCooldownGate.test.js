'use strict';

// FIX-2026-08-09: ACEUSDT cooldown-bypass unit tests
//   Bug: positionWatchdog Phase 4 fired CBv3 → wrote DB cbv3LastFiredAt + cbv3LockedUntil
//        BUT trader's in-memory _cbv3FiredAt was 0 → trader opened 5 BUYs during 8h cooldown.
//   Fix: extract gate logic into src/core/cbCooldownGate.js and consult BOTH in-mem + DB.
//
//   Pure-function tests — no DB / model mocking needed.

const { evaluateCbCooldown } = require('../src/core/cbCooldownGate');

const FIXED_NOW = 1_700_000_000_000; // deterministic reference time
const HOUR = 3600 * 1000;

function mkBot(overrides = {}) {
  return {
    cbv2LockHours: 8,
    cbv2LastFiredAt: null,
    cbv2LockedUntil: null,
    cbv3LockHours: 8,
    cbv3LastFiredAt: null,
    cbv3LockedUntil: null,
    ...overrides,
  };
}

function mkState(overrides = {}) {
  return {
    _cbv2FiredAt: 0,
    _cbv3FiredAt: 0,
    _cbv5FiredAt: 0, // FIX-2026-08-10: CBv5 added
    ...overrides,
  };
}

describe('cbCooldownGate.evaluateCbCooldown', () => {
  // ─── Happy path: in-memory gate fires ────────────────────────────────
  describe('in-memory gate (same-process CB fire)', () => {
    test('no fire anywhere → inactive', () => {
      const r = evaluateCbCooldown(mkState(), mkBot(), 'v3', FIXED_NOW);
      expect(r.active).toBe(false);
      expect(r.source).toBe(null);
      expect(r.remainingMs).toBe(0);
    });

    test('cbv3FiredAt 1h ago + lockHours=8 → active, source=in-memory', () => {
      const state = mkState({ _cbv3FiredAt: FIXED_NOW - 1 * HOUR });
      const bot = mkBot();
      const r = evaluateCbCooldown(state, bot, 'v3', FIXED_NOW);
      expect(r.active).toBe(true);
      expect(r.source).toBe('in-memory');
      expect(r.remainingMs).toBe(7 * HOUR);
    });

    test('cbv3FiredAt 9h ago + lockHours=8 → inactive', () => {
      const state = mkState({ _cbv3FiredAt: FIXED_NOW - 9 * HOUR });
      const r = evaluateCbCooldown(state, mkBot(), 'v3', FIXED_NOW);
      expect(r.active).toBe(false);
    });

    test('CBv2 same rules apply (mirror)', () => {
      const state = mkState({ _cbv2FiredAt: FIXED_NOW - 30 * 60 * 1000 });
      const r = evaluateCbCooldown(state, mkBot(), 'v2', FIXED_NOW);
      expect(r.active).toBe(true);
      expect(r.source).toBe('in-memory');
    });
  });

  // ─── THE ACEUSDT BUG ──────────────────────────────────────────────
  describe('DB-side lock (external writer — ACEUSDT incident)', () => {
    test('cbv3LockedUntil set externally, in-memory=0 → BLOCKS (was the bug)', () => {
      // Simulate: trader just restarted (in-memory=0), watchdog wrote cbv3LockedUntil
      // Helper backfills _cbv3FiredAt from cbv3LastFiredAt → in-memory gate fires (still BLOCKS)
      const state = mkState({ _cbv3FiredAt: 0 });
      const bot = mkBot({
        cbv3LockedUntil: new Date(FIXED_NOW + 4 * HOUR), // 4h remaining per watchdog
        cbv3LastFiredAt: new Date(FIXED_NOW - 4 * HOUR),
      });
      const r = evaluateCbCooldown(state, bot, 'v3', FIXED_NOW);
      expect(r.active).toBe(true);
      // After backfill, in-memory takes the cheaper path. Source can be either:
      expect(['in-memory', 'db-cbv3LockedUntil']).toContain(r.source);
      // backfilled _cbv3FiredAt = (FIXED_NOW - 4h). In-mem: now-that = 4h < 8h → active.
      //   remainingMs = (FIXED_NOW - 4h) + 8h - FIXED_NOW = 4h.
      expect(r.remainingMs).toBe(4 * HOUR);
    });

    test('after DB gate fires, _cbv3FiredAt is backfilled from cbv3LastFiredAt', () => {
      // Side-effect: next call should take the cheaper in-memory path
      const state = mkState({ _cbv3FiredAt: 0 });
      const bot = mkBot({
        cbv3LockedUntil: new Date(FIXED_NOW + 4 * HOUR),
        cbv3LastFiredAt: new Date(FIXED_NOW - 4 * HOUR),
      });
      evaluateCbCooldown(state, bot, 'v3', FIXED_NOW);
      expect(state._cbv3FiredAt).toBe(FIXED_NOW - 4 * HOUR);
    });

    test('CBv2 mirror: cbv2LockedUntil external write also blocks', () => {
      const state = mkState();
      const bot = mkBot({
        cbv2LockedUntil: new Date(FIXED_NOW + 2 * HOUR),
        cbv2LastFiredAt: new Date(FIXED_NOW - 6 * HOUR),
      });
      const r = evaluateCbCooldown(state, bot, 'v2', FIXED_NOW);
      expect(r.active).toBe(true);
      expect(['in-memory', 'db-cbv2LockedUntil']).toContain(r.source);
      // backfilled _cbv2FiredAt = (FIXED_NOW - 6h). In-mem: now-that = 6h < 8h → active.
      // remainingMs = (FIXED_NOW - 6h) + 8h - FIXED_NOW = 2h.
      expect(r.remainingMs).toBe(2 * HOUR);
    });

    test('cbv3LockedUntil in the past + no in-memory fire → inactive', () => {
      const state = mkState();
      const bot = mkBot({
        cbv3LockedUntil: new Date(FIXED_NOW - 1 * HOUR), // expired
        cbv3LastFiredAt: new Date(FIXED_NOW - 9 * HOUR),
      });
      const r = evaluateCbCooldown(state, bot, 'v3', FIXED_NOW);
      expect(r.active).toBe(false);
    });

    test('DB-only fallback: cbv3LastFiredAt present but no cbv3LockedUntil (e.g. legacy data) → still blocks', () => {
      // Edge case: legacy bot data has cbv3LastFiredAt but not cbv3LockedUntil.
      // After backfill, in-memory gate catches it.
      const state = mkState();
      const bot = mkBot({
        cbv3LockedUntil: null,
        cbv3LastFiredAt: new Date(FIXED_NOW - 2 * HOUR),
      });
      const r = evaluateCbCooldown(state, bot, 'v3', FIXED_NOW);
      expect(r.active).toBe(true);
      expect(r.remainingMs).toBe(6 * HOUR);
    });
  });

  // ─── In-memory gate wins over DB gate when both set ─────────────────
  describe('gate priority', () => {
    test('in-memory fire wins when both are active', () => {
      const state = mkState({
        _cbv3FiredAt: FIXED_NOW - 1 * HOUR, // 1h ago
      });
      const bot = mkBot({
        cbv3LockedUntil: new Date(FIXED_NOW + 7 * HOUR), // 7h from now
        cbv3LastFiredAt: new Date(FIXED_NOW - 1 * HOUR),
      });
      const r = evaluateCbCooldown(state, bot, 'v3', FIXED_NOW);
      expect(r.active).toBe(true);
      expect(r.source).toBe('in-memory');
    });

    test('CBv2 + CBv3 are independent (CBv2 active → CBv3 also checkable separately)', () => {
      const state = mkState({ _cbv2FiredAt: FIXED_NOW - 1 * HOUR });
      const bot = mkBot();
      expect(evaluateCbCooldown(state, bot, 'v2', FIXED_NOW).active).toBe(true);
      expect(evaluateCbCooldown(state, bot, 'v3', FIXED_NOW).active).toBe(false);
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────
  describe('edge cases', () => {
    test('invalid cbvNLastFiredAt (NaN string) does not crash', () => {
      const state = mkState();
      const bot = mkBot({ cbv3LastFiredAt: 'not-a-date' });
      const r = evaluateCbCooldown(state, bot, 'v3', FIXED_NOW);
      expect(r.active).toBe(false);
    });

    test('cbvNLockHours=NaN falls back to default 8', () => {
      const state = mkState({ _cbv3FiredAt: FIXED_NOW - 7 * HOUR });
      const bot = mkBot({ cbv3LockHours: NaN });
      const r = evaluateCbCooldown(state, bot, 'v3', FIXED_NOW);
      expect(r.active).toBe(true); // 7h < 8h default
    });

    test('cbvNLockHours out of range clamped to [0.5, 168]', () => {
      // 0.1h clamped to 0.5h (30min). Fire at 0.4h ago (24min) → 24 < 30 → active
      const state = mkState({ _cbv3FiredAt: FIXED_NOW - 0.4 * HOUR });
      const bot = mkBot({ cbv3LockHours: 0.1 });
      const r = evaluateCbCooldown(state, bot, 'v3', FIXED_NOW);
      expect(r.active).toBe(true);
      // 0.4h ago (24min), lockHours=0.5h → 6min remaining
      expect(r.remainingMs).toBe(0.1 * HOUR);
    });
  });

  // ─── Cross-restart continuity ─────────────────────────────────────
  describe('cross-restart behavior', () => {
    test('trader restart preserves cooldown via cbv3LastFiredAt', () => {
      // At t=0 trader fires CBv3 → _cbv3FiredAt = 0, DB cbv3LastFiredAt = t=0
      // pm2 restart: _cbv3FiredAt = new Date(bot.cbv3LastFiredAt).getTime() = 0
      //   (this is what start() does — see trader.js L237)
      // placeBuy runs at t=1h, lockHours=8 → 7h remaining
      const afterRestart = mkState({ _cbv3FiredAt: 0 }); // start() will restore via DB
      const bot = mkBot({ cbv3LastFiredAt: new Date(0) });
      bot.cbv3LockedUntil = new Date(0 + 8 * HOUR); // t=0 + 8h
      const r = evaluateCbCooldown(afterRestart, bot, 'v3', 1 * HOUR);
      expect(r.active).toBe(true);
      // Helper backfills _cbv3FiredAt = 0, so in-memory gate fires: 1h - 0 = 1h < 8h → active
      expect(r.remainingMs).toBe(7 * HOUR); // 8h - 1h elapsed
    });
  });

  // ─── FIX-2026-08-10: CBv5 support — independent of cbVersion ──────
  describe('CBv5 (Support Zone + Deepest Low + Volume Filter)', () => {
    test('cbv5FiredAt 1h ago + cbv5LockHours=4 (default) → active', () => {
      const state = mkState({ _cbv5FiredAt: FIXED_NOW - 1 * HOUR });
      const bot = mkBot();
      // cbv5LockHours default is 4 (not 8 like CBv2/CBv3)
      bot.cbv5LockHours = 4;
      const r = evaluateCbCooldown(state, bot, 'v5', FIXED_NOW);
      expect(r.active).toBe(true);
      expect(r.source).toBe('in-memory');
      expect(r.remainingMs).toBe(3 * HOUR);
    });

    test('CBv5 lockHours defaults to 4 when missing on bot doc', () => {
      const state = mkState({ _cbv5FiredAt: FIXED_NOW - 3 * HOUR });
      const bot = mkBot(); // no cbv5LockHours set
      const r = evaluateCbCooldown(state, bot, 'v5', FIXED_NOW);
      expect(r.active).toBe(true); // 3h < 4h default
      expect(r.remainingMs).toBe(1 * HOUR);
    });

    test('CBv5 cross-restart: cbv5LastFiredAt + cbv5LockedUntil restored → BLOCKS BUY (ACEUSDT-style defense)', () => {
      // After pm2 restart: in-memory=0, but DB has cbv5LockedUntil + cbv5LastFiredAt
      const state = mkState();
      const bot = mkBot({
        cbv5LockedUntil: new Date(FIXED_NOW + 2 * HOUR),
        cbv5LastFiredAt: new Date(FIXED_NOW - 2 * HOUR),
      });
      const r = evaluateCbCooldown(state, bot, 'v5', FIXED_NOW);
      expect(r.active).toBe(true);
      expect(r.remainingMs).toBe(2 * HOUR);
    });

    test('CBv5 in-memory=0 + DB cbv5LockedUntil in past → inactive', () => {
      const state = mkState();
      const bot = mkBot({
        cbv5LockedUntil: new Date(FIXED_NOW - 1 * HOUR), // expired
      });
      const r = evaluateCbCooldown(state, bot, 'v5', FIXED_NOW);
      expect(r.active).toBe(false);
    });

    test('CBv5 independent of CBv2/CBv3 — one version active does not affect others', () => {
      const state = mkState({ _cbv5FiredAt: FIXED_NOW - 1 * HOUR });
      const bot = mkBot();
      bot.cbv5LockHours = 4;
      expect(evaluateCbCooldown(state, bot, 'v5', FIXED_NOW).active).toBe(true);
      expect(evaluateCbCooldown(state, bot, 'v2', FIXED_NOW).active).toBe(false);
      expect(evaluateCbCooldown(state, bot, 'v3', FIXED_NOW).active).toBe(false);
    });

    test('CBv5 lockHours=8 (custom) — 7h remaining after 1h elapsed', () => {
      const state = mkState({ _cbv5FiredAt: FIXED_NOW - 1 * HOUR });
      const bot = mkBot({ cbv5LockHours: 8 });
      const r = evaluateCbCooldown(state, bot, 'v5', FIXED_NOW);
      expect(r.active).toBe(true);
      expect(r.remainingMs).toBe(7 * HOUR);
    });

    test('CBv5 source label uses v5 (not v3 default)', () => {
      const state = mkState();
      const bot = mkBot({
        cbv5LockedUntil: new Date(FIXED_NOW + 3 * HOUR),
        cbv5LastFiredAt: new Date(FIXED_NOW - 1 * HOUR),
      });
      // first call: DB gate fires
      const r1 = evaluateCbCooldown(state, bot, 'v5', FIXED_NOW);
      // (backfill to in-memory may also trigger — accept either path)
      expect(['in-memory', 'db-cbv5LockedUntil']).toContain(r1.source);
    });
  });
});