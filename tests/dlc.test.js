'use strict';

/**
 * FIX-2026-09-04: Unit tests for Dynamic Layer Control (DLC) engine
 *
 *   src/core/dlc.js exposes:
 *     - DEFAULTS          (singleton {baseLossPct: -10})
 *     - normalizeConfig() (fills missing/invalid with DEFAULTS)
 *     - evaluate()        (pure — cfg + positions → {allow, reason?, ...})
 *     - loadPositions()   (DB read + caller priceLookup)
 *
 * The engine is the gate that decides whether a BUY signal may proceed
 * when bot.dlcEnabled=true and master.masterDlcEnabled=true. It is pure
 * (no I/O in evaluate), so these tests don't need DB fixtures.
 *
 * loadPositions() does touch Mongo via mongoose, so it is exercised
 * against the real Trade collection (skipped when MONGO is unavailable).
 */

const mongoose = require('mongoose');

const dlc = require('../src/core/dlc');
const Trade = require('../src/db/models/Trade');

// ────────────────────────────────────────────────────────────────────
// Pure-function tests — no I/O
// ────────────────────────────────────────────────────────────────────
describe('dlc — DEFAULTS + normalizeConfig', () => {
  test('DEFAULTS.baseLossPct === -10', () => {
    expect(dlc.DEFAULTS.baseLossPct).toBe(-10);
  });

  test('normalizeConfig(null) → DEFAULTS', () => {
    expect(dlc.normalizeConfig(null)).toEqual({ baseLossPct: -10 });
  });

  test('normalizeConfig(undefined) → DEFAULTS', () => {
    expect(dlc.normalizeConfig(undefined)).toEqual({ baseLossPct: -10 });
  });

  test('normalizeConfig({baseLossPct: -25}) preserves override', () => {
    expect(dlc.normalizeConfig({ baseLossPct: -25 })).toEqual({ baseLossPct: -25 });
  });

  test('normalizeConfig({baseLossPct: NaN}) falls back to DEFAULTS', () => {
    expect(dlc.normalizeConfig({ baseLossPct: NaN })).toEqual({ baseLossPct: -10 });
  });

  test('normalizeConfig({baseLossPct: "abc"}) falls back to DEFAULTS', () => {
    expect(dlc.normalizeConfig({ baseLossPct: 'abc' })).toEqual({ baseLossPct: -10 });
  });

  test('normalizeConfig({}) falls back to DEFAULTS', () => {
    expect(dlc.normalizeConfig({})).toEqual({ baseLossPct: -10 });
  });
});

// ────────────────────────────────────────────────────────────────────
// Helper — build a position with deterministic pnl%
// ────────────────────────────────────────────────────────────────────
function mkPos({ buyPrice, grossPct, daysAgo = 0 }) {
  // grossPct: percent change. e.g. -10 means price is 10% below buy.
  const currentPrice = buyPrice * (1 + grossPct / 100);
  return {
    buyPrice,
    currentPrice,
    buyFilledAt: new Date(Date.now() - daysAgo * 86400000),
    symbol: 'BTCUSDT',
  };
}

describe('dlc.evaluate — base=-10', () => {
  const cfg = { baseLossPct: -10 };

  test('0 positions → allow', () => {
    const r = dlc.evaluate({ cfg, positions: [] });
    expect(r.allow).toBe(true);
    expect(r.openCount).toBe(0);
  });

  test('1 position, pnl=-5% → block (threshold=-10, -5 ≥ -10)', () => {
    const positions = [mkPos({ buyPrice: 100, grossPct: -5 })];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('threshold-not-met');
    expect(r.blockingIdx).toBe(0);
    expect(r.threshold).toBe(-10);
    expect(r.openCount).toBe(1);
  });

  test('1 position, pnl=-10% → block (boundary, -10 ≥ -10)', () => {
    const positions = [mkPos({ buyPrice: 100, grossPct: -10 })];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('threshold-not-met');
    expect(r.threshold).toBe(-10);
  });

  test('1 position, pnl=-15% → allow (-15 < -10)', () => {
    const positions = [mkPos({ buyPrice: 100, grossPct: -15 })];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(true);
    expect(r.openCount).toBe(1);
  });

  test('1 position, pnl=+5% (in profit) → block (5 ≥ -10)', () => {
    const positions = [mkPos({ buyPrice: 100, grossPct: 5 })];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('threshold-not-met');
  });
});

describe('dlc.evaluate — k=2 (base=-10)', () => {
  const cfg = { baseLossPct: -10 };

  test('[pnl=-15, pnl=-5] → block on pos[0] (thresholds [-20, -10])', () => {
    // oldest pos[0]=-15% but threshold=-20 → fails (only -15% deep, not -20%)
    const positions = [
      mkPos({ buyPrice: 100, grossPct: -15, daysAgo: 5 }),
      mkPos({ buyPrice: 100, grossPct: -5, daysAgo: 1 }),
    ];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('threshold-not-met');
    expect(r.blockingIdx).toBe(0);
    expect(r.threshold).toBe(-20);
  });

  test('[pnl=-25, pnl=-15] → allow (pos[0] -25 < -20, pos[1] -15 < -10)', () => {
    const positions = [
      mkPos({ buyPrice: 100, grossPct: -25, daysAgo: 5 }),
      mkPos({ buyPrice: 100, grossPct: -15, daysAgo: 1 }),
    ];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(true);
    expect(r.openCount).toBe(2);
  });

  test('[pnl=-30, pnl=-5] → block on pos[1] (oldest passes -30<-20 but pos[1] -5 ≥ -10)', () => {
    const positions = [
      mkPos({ buyPrice: 100, grossPct: -30, daysAgo: 5 }),
      mkPos({ buyPrice: 100, grossPct: -5, daysAgo: 1 }),
    ];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('threshold-not-met');
    expect(r.blockingIdx).toBe(1);
    expect(r.threshold).toBe(-10);
  });
});

describe('dlc.evaluate — k=3 (base=-10)', () => {
  const cfg = { baseLossPct: -10 };

  test('[pnl=-35, pnl=-25, pnl=-15] → allow (thresholds -30/-20/-10 all met)', () => {
    const positions = [
      mkPos({ buyPrice: 100, grossPct: -35, daysAgo: 10 }),
      mkPos({ buyPrice: 100, grossPct: -25, daysAgo: 5 }),
      mkPos({ buyPrice: 100, grossPct: -15, daysAgo: 1 }),
    ];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(true);
    expect(r.openCount).toBe(3);
  });

  test('[pnl=-25, pnl=-25, pnl=-15] → block on pos[0] (-25 ≥ -30)', () => {
    const positions = [
      mkPos({ buyPrice: 100, grossPct: -25, daysAgo: 10 }),
      mkPos({ buyPrice: 100, grossPct: -25, daysAgo: 5 }),
      mkPos({ buyPrice: 100, grossPct: -15, daysAgo: 1 }),
    ];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('threshold-not-met');
    expect(r.blockingIdx).toBe(0);
    expect(r.threshold).toBe(-30);
  });

  test('[pnl=-40, pnl=-15, pnl=-15] → block on pos[1] (-15 ≥ -20)', () => {
    const positions = [
      mkPos({ buyPrice: 100, grossPct: -40, daysAgo: 10 }),
      mkPos({ buyPrice: 100, grossPct: -15, daysAgo: 5 }),
      mkPos({ buyPrice: 100, grossPct: -15, daysAgo: 1 }),
    ];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('threshold-not-met');
    expect(r.blockingIdx).toBe(1);
    expect(r.threshold).toBe(-20);
  });
});

describe('dlc.evaluate — boundary + safety cases', () => {
  const cfg = { baseLossPct: -10 };

  test('currentPrice=null → block with reason=price-unavailable', () => {
    const positions = [{ buyPrice: 100, currentPrice: null, buyFilledAt: new Date() }];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('price-unavailable');
    expect(r.blockingIdx).toBe(0);
  });

  test('currentPrice=undefined → block (treated as null)', () => {
    const positions = [{ buyPrice: 100, buyFilledAt: new Date() }];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('price-unavailable');
  });

  test('buyPrice=0 → block (division by zero guard)', () => {
    const positions = [{ buyPrice: 0, currentPrice: 100, buyFilledAt: new Date() }];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('price-unavailable');
  });

  test('buyPrice=null → block', () => {
    const positions = [{ buyPrice: null, currentPrice: 100, buyFilledAt: new Date() }];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('price-unavailable');
  });

  test('buyPrice negative (data anomaly) → block (buyPrice <= 0 catches it)', () => {
    const positions = [{ buyPrice: -50, currentPrice: 100, buyFilledAt: new Date() }];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('price-unavailable');
  });
});

describe('dlc.evaluate — configurable baseLossPct', () => {
  test('base=-25, k=2 [pnl=-55, pnl=-30] → allow (thresholds -50/-25, both met)', () => {
    const cfg = { baseLossPct: -25 };
    const positions = [
      mkPos({ buyPrice: 100, grossPct: -55, daysAgo: 5 }),
      mkPos({ buyPrice: 100, grossPct: -30, daysAgo: 1 }),
    ];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(true);
  });

  test('base=-5, k=1, pnl=-3% → block (-3 ≥ -5)', () => {
    const cfg = { baseLossPct: -5 };
    const positions = [mkPos({ buyPrice: 100, grossPct: -3 })];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(false);
    expect(r.threshold).toBe(-5);
  });

  test('base=-1 (most aggressive — k=1 pnl=-2% allows)', () => {
    const cfg = { baseLossPct: -1 };
    const positions = [mkPos({ buyPrice: 100, grossPct: -2 })];
    const r = dlc.evaluate({ cfg, positions });
    expect(r.allow).toBe(true);
  });

  test('base=-95 (most conservative — k=1 pnl=-90% blocks, pnl=-96% allows)', () => {
    const cfg = { baseLossPct: -95 };
    expect(dlc.evaluate({ cfg, positions: [mkPos({ buyPrice: 100, grossPct: -90 })] }).allow).toBe(false);
    expect(dlc.evaluate({ cfg, positions: [mkPos({ buyPrice: 100, grossPct: -96 })] }).allow).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// loadPositions — DB-touching test, only when MONGO is reachable
// ────────────────────────────────────────────────────────────────────
describe('dlc.loadPositions — DB integration', () => {
  // Skip if mongoose can't connect (e.g. CI without mongo)
  let connected = false;
  beforeAll(async () => {
    if (mongoose.connection.readyState === 1) {
      connected = true;
      return;
    }
    try {
      const m = require('../src/db/mongoose');
      await m.connect();
      connected = mongoose.connection.readyState === 1;
    } catch (e) {
      connected = false;
    }
  });

  afterAll(async () => {
    if (connected && mongoose.connection.readyState === 1) {
      try { await mongoose.connection.close(); } catch (_) { /* ignore */ }
    }
  });

  test('returns docs sorted ASC by buyFilledAt with currentPrice injected', async () => {
    if (!connected) {
      // skip silently when mongo is unavailable
      return;
    }
    const botId = new mongoose.Types.ObjectId();
    const now = Date.now();
    // Insert in random order — loadPositions should sort
    await Trade.create([
      { botId, symbol: 'BTCUSDT', state: 'holding', buyPrice: 100, buyFilledAt: new Date(now - 2 * 86400000) },
      { botId, symbol: 'BTCUSDT', state: 'holding', buyPrice: 200, buyFilledAt: new Date(now - 10 * 86400000) },
      { botId, symbol: 'BTCUSDT', state: 'holding', buyPrice: 300, buyFilledAt: new Date(now - 5 * 86400000) },
    ]);
    try {
      const priceMap = { BTCUSDT: 95 };
      const positions = await dlc.loadPositions(botId, (sym) => priceMap[sym] ?? null);
      expect(positions).toHaveLength(3);
      // oldest first → buyPrice 200 (10d), 300 (5d), 100 (2d)
      expect(positions[0].buyPrice).toBe(200);
      expect(positions[1].buyPrice).toBe(300);
      expect(positions[2].buyPrice).toBe(100);
      expect(positions[0].currentPrice).toBe(95);
    } finally {
      await Trade.deleteMany({ botId });
    }
  });
});
