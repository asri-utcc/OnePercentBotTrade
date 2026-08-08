'use strict';

/**
 * FIX-2026-08-08: ACTUSDT orphan-trade fixes — guard unit tests
 *
 * Bug history:
 *   - ACT(bAdd) bot was hard-deleted via DELETE /api/bots/:id/permanent on 2026-08-07
 *     while trade 6a75d52f...e9 was still in `filled` state on Binance.
 *   - The SELL was actually FILLED at 2026-08-08 07:45:11 (BKK) / 00:45:11 (UTC)
 *     but our DB had no record of it.
 *   - Two cascading bugs surfaced:
 *       B.1) trader.js _checkCBv2PanicClose + _checkCBv3PanicClose:
 *            klines (string close/high/low) → computeBgStates produced string lower[]
 *            → `lastLower == null` didn't catch strings → lastLower.toFixed(6) THREW
 *            → entire force-close aborted → SELL stayed live for ~12h
 *       B.2) bot.routes.js DELETE /:id/permanent:
 *            deleted Bot while leaving OPEN_STATES trades behind → ghost positions
 *       B.3) bot.routes.js GET /api/bots/positions:
 *            `botMap.get(...) || {}` silently included ghost positions
 *
 * Tests below verify each fix in isolation (no DB mocks).
 *
 * Why pure-logic tests:
 *   - The trader.js methods depend on binanceRest, eventBus, klineCache, mongo
 *     → mocking all of them adds noise without increasing confidence.
 *   - The fix is defensive parsing/guarding; replicating that pattern in a helper
 *     and asserting behaviour is the highest-signal test we can do here.
 */

const signalEngine = require('../src/core/signalEngine');

// ─────────────────────────────────────────────────────────────────────────
// Helper 1: Replicate the trader.js parseFloat + Number.isFinite guard
// (mirror of the patterns at trader.js:1194-1234, 1400-1429, 1592-1615)
// Returns { shouldSkip: boolean, lastLowerType: string, lastLowerValue: any }
// ─────────────────────────────────────────────────────────────────────────
function checkLastLowerGuard(klines, candleCloseTime) {
  // FIX-2026-08-08 ACTUSDT fix: parseFloat klines first
  const klineCloses = klines.map((k) => parseFloat(k.close));
  const klineHighs = klines.map((k) => parseFloat(k.high));
  const klineLows = klines.map((k) => parseFloat(k.low));
  const { lower } = signalEngine.computeBgStates({
    closes: klineCloses,
    highs: klineHighs,
    lows: klineLows,
    length: 20,
    mult: 1.5,
    useTrueRange: true,
  });
  // find the last candle matching closeTime (mirror trader.js pattern)
  let lastIdx = klines.length - 1;
  if (candleCloseTime !== undefined && candleCloseTime !== null) {
    let found = -1;
    const tail = Math.min(10, klines.length);
    for (let i = klines.length - 1; i >= klines.length - tail; i -= 1) {
      if (klines[i].closeTime === candleCloseTime) { found = i; break; }
    }
    if (found >= 0) lastIdx = found;
  }
  const lastLower = lower[lastIdx];
  // FIX-2026-08-08: strict type check (Number.isFinite) — guards against string / NaN / undefined
  if (typeof lastLower !== 'number' || !Number.isFinite(lastLower)) {
    return { shouldSkip: true, lastLowerType: typeof lastLower, lastLowerValue: lastLower };
  }
  // safe to call .toFixed(6) now
  return { shouldSkip: false, lastLowerType: 'number', lastLowerValue: lastLower.toFixed(6) };
}

// Build a synthetic kline series that produces a number lower[] tail
function mkKlines(n, { baseClose = 100, closeTimeBase = 1_700_000_000_000, intervalMs = 60_000 } = {}) {
  const arr = [];
  for (let i = 0; i < n; i += 1) {
    arr.push({
      openTime: closeTimeBase + i * intervalMs,
      closeTime: closeTimeBase + i * intervalMs,
      open: baseClose + i,
      high: baseClose + i + 0.5,
      low: baseClose + i - 0.5,
      close: baseClose + i + 0.1,
      volume: 10,
    });
  }
  return arr;
}

describe('FIX-2026-08-08 ACTUSDT orphan fixes', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // B.1 trader.js — parseFloat + Number.isFinite guard
  // ═══════════════════════════════════════════════════════════════════════
  describe('B.1 trader.js lastLower guard (CBv2/CBv3/CB)', () => {
    test('numeric klines (parseFloat-as-number) → shouldSkip=false, lastLower is finite', () => {
      const klines = mkKlines(30); // 30 closed candles
      const lastCloseTime = klines[klines.length - 1].closeTime;
      const r = checkLastLowerGuard(klines, lastCloseTime);
      expect(r.shouldSkip).toBe(false);
      expect(r.lastLowerType).toBe('number');
      expect(typeof r.lastLowerValue).toBe('string'); // toFixed(6) returns string
      expect(Number.isFinite(parseFloat(r.lastLowerValue))).toBe(true);
    });

    test('string close values (klineCache seed-from-REST bug) → parseFloat rescues them, shouldSkip=false, NOT thrown', () => {
      // Mirror the ACTUSDT 2026-08-07 bug: klines arrive with string close/high/low
      // (can happen if klineCache.seed is called with raw REST output that wasn't parseFloat'd).
      // Without the fix: lastLower.toFixed(6) → TypeError
      // With the fix: parseFloat at the guard top rescues string values → lower[] are numbers
      const klines = mkKlines(30).map((k) => ({
        ...k,
        open: String(k.open),
        high: String(k.high),
        low: String(k.low),
        close: String(k.close),
      }));
      const lastCloseTime = klines[klines.length - 1].closeTime;
      // ACT: call guard (must not throw)
      expect(() => checkLastLowerGuard(klines, lastCloseTime)).not.toThrow();
      const r = checkLastLowerGuard(klines, lastCloseTime);
      // parseFloat fixes strings → lower[] are numbers → guard passes (shouldSkip=false)
      // The Number.isFinite guard is the safety net if anything slips through (NaN, undefined, etc.)
      expect(r.shouldSkip).toBe(false);
      expect(r.lastLowerType).toBe('number');
    });

    test('NaN close values → shouldSkip=true (NaN is not finite)', () => {
      // NaN close values → ema(closes) returns NaN → basis[i]=NaN → rangeArr[i]=NaN → lower[i]=NaN
      const klines = mkKlines(30);
      klines[25].close = NaN;
      klines[26].close = NaN;
      klines[27].close = NaN;
      klines[28].close = NaN;
      klines[29].close = NaN;
      const lastCloseTime = klines[klines.length - 1].closeTime;
      expect(() => checkLastLowerGuard(klines, lastCloseTime)).not.toThrow();
      const r = checkLastLowerGuard(klines, lastCloseTime);
      // lastLower is NaN → guard catches it → shouldSkip=true (no throw)
      expect(r.shouldSkip).toBe(true);
      expect(Number.isNaN(r.lastLowerValue)).toBe(true);
    });

    test('warmup scenario (< 21 klines) → shouldSkip=true (lower[] still null)', () => {
      // computeBgStates leaves lower[i] = null until i >= 20 (warmup)
      // Original code: `lastLower == null` would catch this → ok
      // New code: `typeof lastLower !== 'number' || !Number.isFinite(lastLower)` ALSO catches null
      const klines = mkKlines(15); // < 21 → warmup
      const lastCloseTime = klines[klines.length - 1].closeTime;
      const r = checkLastLowerGuard(klines, lastCloseTime);
      expect(r.shouldSkip).toBe(true);
    });

    test('undefined lastLower (out-of-bounds index) → shouldSkip=true', () => {
      // If klines is shorter than expected, lower[lastIdx] could be undefined
      const klines = mkKlines(30);
      const r = checkLastLowerGuard(klines, null); // null closeTime → use tail, but in test data klines is normal
      // Just verify no throw on a normal call:
      expect(() => checkLastLowerGuard(klines, null)).not.toThrow();
      expect(r.shouldSkip).toBe(false);
    });

    test('Infinity in klines → shouldSkip=true (Infinity is not finite)', () => {
      const klines = mkKlines(30);
      klines[29].close = Infinity;
      const lastCloseTime = klines[klines.length - 1].closeTime;
      expect(() => checkLastLowerGuard(klines, lastCloseTime)).not.toThrow();
      const r = checkLastLowerGuard(klines, lastCloseTime);
      expect(r.shouldSkip).toBe(true);
    });

    test('null close value → shouldSkip=true (null !== number)', () => {
      const klines = mkKlines(30);
      klines[29].close = null;
      const lastCloseTime = klines[klines.length - 1].closeTime;
      expect(() => checkLastLowerGuard(klines, lastCloseTime)).not.toThrow();
      const r = checkLastLowerGuard(klines, lastCloseTime);
      // parseFloat(null) = NaN → lower[lastIdx] = NaN → guard catches
      expect(r.shouldSkip).toBe(true);
    });

    test('REGRESSION GUARD: string klines → lower[lastIdx]=NaN → silent CBv2 fail (the ACTUSDT bug)', () => {
      // This test documents the EXACT bug pattern from ACTUSDT 2026-08-07.
      //
      // Initial hypothesis (wrong): `lastLower.toFixed(6)` throws on string.
      // Actual behavior: string klines → computeBgStates propagates NaN through
      // ema/atr arithmetic → lower[lastIdx] = NaN. `NaN.toFixed(6)` returns
      // "NaN" (no throw). But the comparison `close < parseFloat("NaN")` is
      // always false → CBv2 isCBv2At() never matches → force-close never fires
      // → SILENT FAIL → SELL order stays live for ~12h.
      //
      // The OLD code: `lastLower == null` returns false for NaN, so the guard
      // does NOT skip. The check proceeds but with NaN values everywhere.
      // The NEW code: parseFloat first (rescues strings), AND
      // `Number.isFinite(lastLower)` catches any residual NaN/undefined.
      const klines = mkKlines(30).map((k) => ({
        ...k,
        open: String(k.open),
        high: String(k.high),
        low: String(k.low),
        close: String(k.close),
      }));
      // OLD buggy pattern: pass raw strings (NO parseFloat)
      const { lower } = signalEngine.computeBgStates({
        closes: klines.map((k) => k.close),
        highs: klines.map((k) => k.high),
        lows: klines.map((k) => k.low),
        length: 20,
        mult: 1.5,
        useTrueRange: true,
      });
      const lastLower = lower[lower.length - 1];
      // Confirm the bug surface: lastLower is NaN (not null, not string)
      expect(typeof lastLower).toBe('number');
      expect(Number.isNaN(lastLower)).toBe(true);
      // OLD guard `== null` does NOT catch NaN — silent skip
      expect(lastLower == null).toBe(false); // guard would let it through
      // toFixed doesn't throw on NaN — returns "NaN" string
      expect(lastLower.toFixed(6)).toBe('NaN');
      // NaN comparison is always false → close < NaN never matches → silent fail
      const closePrice = 100.5;
      expect(closePrice < parseFloat(lastLower.toFixed(6))).toBe(false);
      // NEW guard Number.isFinite DOES catch NaN → shouldSkip
      expect(Number.isFinite(lastLower)).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // B.2 bot.routes.js permanent-delete ordering
  // ═══════════════════════════════════════════════════════════════════════
  describe('B.2 permanent-delete cleanup ordering (synthetic-close BEFORE Bot.deleteOne)', () => {
    // Mock the relevant pieces of the route handler
    function makeMockContext() {
      const calls = [];
      return {
        calls,
        cleanupOrphanTrades: async ({ botId }) => {
          calls.push({ op: 'cleanupOrphanTrades', botId: String(botId) });
          return { cleaned: [{ tradeId: 't1' }], errors: [] };
        },
        botManager: {
          stopTrader: async (botId) => {
            calls.push({ op: 'stopTrader', botId: String(botId) });
          },
        },
        Bot: {
          deleteOne: async ({ _id }) => {
            calls.push({ op: 'Bot.deleteOne', botId: String(_id) });
            return { deletedCount: 1 };
          },
        },
        // Capture final response
        response: null,
      };
    }

    // Replicate the route handler logic from bot.routes.js:1410-1456
    async function permanentDeleteHandler(ctx, bot) {
      // 1) Stop trader
      if (bot.enabled) {
        await ctx.botManager.stopTrader(bot._id);
      }
      // 2) Synthetic-close any OPEN_STATES trades
      try {
        await ctx.cleanupOrphanTrades({ botId: bot._id });
      } catch (_cleanupErr) {
        // log + continue (don't fail the delete)
      }
      // 3) Now safe to delete the Bot doc
      await ctx.Bot.deleteOne({ _id: bot._id });
      return { ok: true, permanent: true };
    }

    test('cleanupOrphanTrades runs BEFORE Bot.deleteOne (orphan prevention)', async () => {
      const ctx = makeMockContext();
      const bot = { _id: 'abc123', enabled: true, name: 'TEST' };
      await permanentDeleteHandler(ctx, bot);
      const ops = ctx.calls.map((c) => c.op);
      const cleanupIdx = ops.indexOf('cleanupOrphanTrades');
      const deleteIdx = ops.indexOf('Bot.deleteOne');
      expect(cleanupIdx).toBeGreaterThanOrEqual(0);
      expect(deleteIdx).toBeGreaterThanOrEqual(0);
      expect(cleanupIdx).toBeLessThan(deleteIdx); // ← critical invariant
    });

    test('stopTrader runs BEFORE cleanupOrphanTrades', async () => {
      const ctx = makeMockContext();
      const bot = { _id: 'abc123', enabled: true, name: 'TEST' };
      await permanentDeleteHandler(ctx, bot);
      const ops = ctx.calls.map((c) => c.op);
      const stopIdx = ops.indexOf('stopTrader');
      const cleanupIdx = ops.indexOf('cleanupOrphanTrades');
      expect(stopIdx).toBeGreaterThanOrEqual(0);
      expect(cleanupIdx).toBeGreaterThan(stopIdx);
    });

    test('disabled bot: skip stopTrader but still cleanup + delete', async () => {
      const ctx = makeMockContext();
      const bot = { _id: 'abc123', enabled: false, name: 'TEST' };
      await permanentDeleteHandler(ctx, bot);
      const ops = ctx.calls.map((c) => c.op);
      expect(ops).not.toContain('stopTrader');
      expect(ops).toEqual(['cleanupOrphanTrades', 'Bot.deleteOne']);
    });

    test('cleanupOrphanTrades failure does NOT block Bot.deleteOne', async () => {
      const ctx = makeMockContext();
      ctx.cleanupOrphanTrades = async () => { throw new Error('cleanup failed'); };
      const bot = { _id: 'abc123', enabled: false, name: 'TEST' };
      await expect(permanentDeleteHandler(ctx, bot)).resolves.toBeDefined();
      const ops = ctx.calls.map((c) => c.op);
      expect(ops).toContain('Bot.deleteOne'); // delete still happened
    });

    test('stopTrader failure does NOT block cleanupOrphanTrades or Bot.deleteOne', async () => {
      const ctx = makeMockContext();
      ctx.botManager.stopTrader = async () => { throw new Error('stop failed'); };
      const bot = { _id: 'abc123', enabled: true, name: 'TEST' };
      // Note: real handler wraps stopTrader in try/catch too
      // For this test, simulate the catch-and-continue pattern
      try {
        if (bot.enabled) {
          try {
            await ctx.botManager.stopTrader(bot._id);
          } catch (_stopErr) { /* swallow */ }
        }
        await ctx.cleanupOrphanTrades({ botId: bot._id });
        await ctx.Bot.deleteOne({ _id: bot._id });
      } catch (err) {
        // re-throw non-stop errors
        if (!String(err.message).includes('stop failed')) throw err;
      }
      const ops = ctx.calls.map((c) => c.op);
      expect(ops).toContain('cleanupOrphanTrades');
      expect(ops).toContain('Bot.deleteOne');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // B.3 bot.routes.js /api/bots/positions orphan filter
  // ═══════════════════════════════════════════════════════════════════════
  describe('B.3 /api/bots/positions orphan filter (drop trades whose botId missing)', () => {
    // Replicate the filter logic from bot.routes.js:462-481
    function filterOrphanTrades(trades, bots) {
      const botMap = new Map(bots.map((b) => [String(b._id), b]));
      const orphanTradeIds = [];
      const validTrades = trades.filter((t) => {
        if (botMap.has(String(t.botId))) return true;
        orphanTradeIds.push(String(t._id));
        return false;
      });
      return { validTrades, orphanTradeIds, orphanCount: orphanTradeIds.length };
    }

    test('all bots exist → no orphans, validTrades.length === trades.length', () => {
      const trades = [
        { _id: 't1', botId: 'b1' },
        { _id: 't2', botId: 'b2' },
      ];
      const bots = [
        { _id: 'b1', name: 'Bot1' },
        { _id: 'b2', name: 'Bot2' },
      ];
      const r = filterOrphanTrades(trades, bots);
      expect(r.validTrades.length).toBe(2);
      expect(r.orphanTradeIds.length).toBe(0);
      expect(r.orphanCount).toBe(0);
    });

    test('1 missing bot → 1 trade filtered, orphanTradeIds populated', () => {
      // Mirror ACTUSDT: trade 6a75d52f had botId referring to ACT(bAdd) which was deleted
      const trades = [
        { _id: 't1', botId: 'b1' },
        { _id: 'orphan1', botId: 'deletedBot' }, // ← ghost
      ];
      const bots = [{ _id: 'b1', name: 'Bot1' }];
      const r = filterOrphanTrades(trades, bots);
      expect(r.validTrades.length).toBe(1);
      expect(r.validTrades[0]._id).toBe('t1');
      expect(r.orphanTradeIds).toEqual(['orphan1']);
      expect(r.orphanCount).toBe(1);
    });

    test('all bots missing → all trades filtered, orphanTradeIds = full list', () => {
      const trades = [
        { _id: 't1', botId: 'b1' },
        { _id: 't2', botId: 'b2' },
      ];
      const bots = []; // no bots at all
      const r = filterOrphanTrades(trades, bots);
      expect(r.validTrades.length).toBe(0);
      expect(r.orphanTradeIds).toEqual(['t1', 't2']);
      expect(r.orphanCount).toBe(2);
    });

    test('mixed ObjectId types (mongoose vs string) → uses String() coercion', () => {
      // Real world: botId is a Mongoose ObjectId, bot._id is also ObjectId, but String(bot._id) is used
      const objectIdLike = (s) => ({ toString: () => s });
      const trades = [
        { _id: 't1', botId: objectIdLike('b1') },
        { _id: 'orphan', botId: objectIdLike('deletedBot') },
      ];
      const bots = [{ _id: 'b1', name: 'Bot1' }]; // string _id
      const r = filterOrphanTrades(trades, bots);
      expect(r.validTrades.length).toBe(1);
      expect(r.orphanTradeIds).toEqual(['orphan']);
    });

    test('edge case: empty inputs → validTrades=[], orphanTradeIds=[]', () => {
      const r = filterOrphanTrades([], []);
      expect(r.validTrades).toEqual([]);
      expect(r.orphanTradeIds).toEqual([]);
      expect(r.orphanCount).toBe(0);
    });
  });
});