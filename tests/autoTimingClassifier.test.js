'use strict';

const {
  classify,
  shouldPromoteToTier2,
  BAD_PNL_PER_TRADE,
  BAD_WIN_RATE,
} = require('../src/core/autoTimingClassifier');
const { getDefaultBandsClone } = require('../src/core/autoTimingDefaults');

const NOW = Date.parse('2026-08-30T12:00:00Z');
const BANDS = getDefaultBandsClone();

function makeConfig(over = {}) {
  return Object.assign({
    bands: BANDS,
    minTradesShow: 3,
    minTradesEnforce: 10,
    suppressCooldownDays: 90,
    suppressThresholdEverBad: 10,
  }, over);
}

function makeCell(over = {}) {
  return Object.assign({
    bucket: { day: 1, hour: 14 }, // Tuesday 14:00
    n: 0,
    winRate: 0,
    pnlUSDT: 0,
    medianHoldMin: 60,
    holds: [],
  }, over);
}

describe('autoTimingClassifier.classify — input guards', () => {
  test('null cell → allow/no_data without throwing', () => {
    const r = classify(null, null, makeConfig(), NOW);
    expect(r.action).toBe('allow');
    expect(r.confidence).toBe('no_data');
    expect(r.blocked).toBe(false);
    // medianHoldMin = 0 (NaN→0) maps to lt10m (maxMin=10, 0 ≤ 10)
    expect(r.bandId).toBe('lt10m');
  });

  test('missing config → safe defaults (allow)', () => {
    const r = classify(makeCell({ n: 50, winRate: 0.9, pnlUSDT: 5 }), null, null, NOW);
    expect(r.action).toBe('allow');     // missing bands → default allow
    expect(r.confidence).toBe('enforce');
    expect(r.blocked).toBe(false);
  });

  test('non-finite winRate clamped to 0..1', () => {
    const r1 = classify(makeCell({ n: 20, winRate: 1.7,  pnlUSDT: 5 }), null, makeConfig(), NOW);
    const r2 = classify(makeCell({ n: 20, winRate: -0.4, pnlUSDT: 5 }), null, makeConfig(), NOW);
    expect(r1.metrics.winRate).toBe(1);
    expect(r2.metrics.winRate).toBe(0);
  });
});

describe('autoTimingClassifier.classify — band mapping', () => {
  test.each([
    [   0, 'lt10m'],
    [   5, 'lt10m'],
    [  10, 'lt10m'],
    [  11, 'lt1h'],
    [  60, 'lt1h'],
    [  61, 'lt12h'],
    [ 720, 'lt12h'],
    [ 721, 'lt48h'],
    [2880, 'lt48h'],
    [2881, 'gt48h'],
    [999999, 'gt48h'],
  ])('medianHoldMin=%i → band=%s', (mins, expectedBand) => {
    const r = classify(
      makeCell({ n: 50, medianHoldMin: mins, winRate: 0.8, pnlUSDT: 10 }),
      null, makeConfig(), NOW,
    );
    expect(r.bandId).toBe(expectedBand);
  });
});

describe('autoTimingClassifier.classify — default band actions', () => {
  test('lt10m cell with healthy stats → stimulate', () => {
    const r = classify(
      makeCell({ n: 20, medianHoldMin: 5, winRate: 0.9, pnlUSDT: 4 }),
      null, makeConfig(), NOW,
    );
    expect(r.bandId).toBe('lt10m');
    expect(r.action).toBe('stimulate');
    expect(r.blocked).toBe(false);
    expect(r.confidence).toBe('enforce');
  });

  test('lt48h cell with healthy stats → limit', () => {
    const r = classify(
      makeCell({ n: 20, medianHoldMin: 1440, winRate: 0.7, pnlUSDT: 3 }),
      null, makeConfig(), NOW,
    );
    expect(r.bandId).toBe('lt48h');
    expect(r.action).toBe('limit');
    expect(r.blocked).toBe(false);
  });

  test('gt48h cell with healthy stats → suppress (per default config)', () => {
    const r = classify(
      makeCell({ n: 20, medianHoldMin: 5000, winRate: 0.6, pnlUSDT: 2 }),
      null, makeConfig(), NOW,
    );
    expect(r.bandId).toBe('gt48h');
    expect(r.action).toBe('suppress');
    expect(r.blocked).toBe(true);
  });
});

describe('autoTimingClassifier.classify — confidence gating', () => {
  test('n=0 → no_data, allow', () => {
    const r = classify(makeCell({ n: 0 }), null, makeConfig(), NOW);
    expect(r.confidence).toBe('no_data');
    expect(r.action).toBe('allow');
    expect(r.reason).toMatch(/insufficient data/);
  });

  test('n=2 (below minShow=3) → no_data, allow', () => {
    const r = classify(makeCell({ n: 2 }), null, makeConfig(), NOW);
    expect(r.confidence).toBe('no_data');
    expect(r.action).toBe('allow');
  });

  test('n=5 (between minShow=3 and minEnforce=10) → show, band action', () => {
    const r = classify(
      makeCell({ n: 5, medianHoldMin: 1440, winRate: 0.7, pnlUSDT: 1 }),
      null, makeConfig(), NOW,
    );
    expect(r.confidence).toBe('show');
    expect(r.action).toBe('limit'); // default lt48h → limit
    expect(r.reason).toMatch(/advisory/);
  });

  test('n=15 (above minEnforce) → enforce', () => {
    const r = classify(
      makeCell({ n: 15, medianHoldMin: 5, winRate: 0.9, pnlUSDT: 5 }),
      null, makeConfig(), NOW,
    );
    expect(r.confidence).toBe('enforce');
    expect(r.action).toBe('stimulate');
  });
});

describe('autoTimingClassifier.classify — cool-down override', () => {
  test('suppressUntil in future → suppress, tier2Hit=cool_down', () => {
    const tier2 = { everBadCount: 12, suppressUntil: NOW + 10 * 86400_000 };
    const r = classify(
      makeCell({ n: 30, medianHoldMin: 5, winRate: 0.9, pnlUSDT: 5 }),
      tier2, makeConfig(), NOW,
    );
    expect(r.action).toBe('suppress');
    expect(r.blocked).toBe(true);
    expect(r.tier2Hit).toBe('cool_down');
    expect(r.reason).toMatch(/cool-down/);
  });

  test('suppressUntil in past → falls through to band logic', () => {
    const tier2 = { everBadCount: 12, suppressUntil: NOW - 86400_000 };
    const r = classify(
      makeCell({ n: 20, medianHoldMin: 5, winRate: 0.9, pnlUSDT: 5 }),
      tier2, makeConfig(), NOW,
    );
    expect(r.tier2Hit).toBe('fresh');
    expect(r.action).toBe('stimulate');
  });

  test('suppressUntil = 0 / missing → cool-down ignored', () => {
    const tier2 = { everBadCount: 12, suppressUntil: 0 };
    const r = classify(
      makeCell({ n: 20, medianHoldMin: 5, winRate: 0.9, pnlUSDT: 5 }),
      tier2, makeConfig(), NOW,
    );
    expect(r.tier2Hit).toBe('fresh');
  });
});

describe('autoTimingClassifier.classify — Tier-2 promotion (ever_bad)', () => {
  test('bad pnlPerTrade + low winRate + tier2 everBadCount ≥ threshold → suppress', () => {
    const tier2 = { everBadCount: 10, suppressUntil: 0 };
    const r = classify(
      makeCell({ n: 20, medianHoldMin: 1440, winRate: 0.3, pnlUSDT: -2 }),
      tier2, makeConfig(), NOW,
    );
    expect(r.action).toBe('suppress');
    expect(r.blocked).toBe(true);
    expect(r.tier2Hit).toBe('ever_bad');
  });

  test('bad stats but tier2 everBadCount below threshold → band action (no suppress)', () => {
    const tier2 = { everBadCount: 5, suppressUntil: 0 };
    const r = classify(
      makeCell({ n: 20, medianHoldMin: 1440, winRate: 0.3, pnlUSDT: -2 }),
      tier2, makeConfig({ suppressThresholdEverBad: 10 }), NOW,
    );
    expect(r.tier2Hit).toBe('fresh');
    expect(r.action).toBe('limit'); // default lt48h → limit
  });

  test('good stats even with high everBadCount → band action (not suppress)', () => {
    const tier2 = { everBadCount: 50, suppressUntil: 0 };
    const r = classify(
      makeCell({ n: 20, medianHoldMin: 5, winRate: 0.9, pnlUSDT: 5 }),
      tier2, makeConfig(), NOW,
    );
    expect(r.tier2Hit).toBe('fresh');
    expect(r.action).toBe('stimulate');
  });

  test('boundary: pnlPerTrade exactly at BAD_PNL_PER_TRADE → not bad', () => {
    const tier2 = { everBadCount: 10, suppressUntil: 0 };
    // n=20, pnlUSDT = -1 → pnlPerTrade = -0.05 (== threshold, not <)
    const r = classify(
      makeCell({ n: 20, medianHoldMin: 5, winRate: 0.9, pnlUSDT: -1 }),
      tier2, makeConfig(), NOW,
    );
    expect(r.tier2Hit).toBe('fresh');
  });
});

describe('autoTimingClassifier.classify — return shape', () => {
  test('result contains all required keys', () => {
    const r = classify(makeCell({ n: 20 }), null, makeConfig(), NOW);
    expect(r).toHaveProperty('action');
    expect(r).toHaveProperty('bandId');
    expect(r).toHaveProperty('band');
    expect(r).toHaveProperty('reason');
    expect(r).toHaveProperty('blocked');
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('tier2Hit');
    expect(r).toHaveProperty('metrics');
    expect(r).toHaveProperty('asOf', NOW);
  });

  test('band snapshot has all 10 knobs', () => {
    const r = classify(makeCell({ n: 20, medianHoldMin: 30 }), null, makeConfig(), NOW);
    // medianHoldMin=30 → lt1h band (default = encourage)
    expect(r.band).toEqual(expect.objectContaining({
      action: 'encourage',
      notionalMult: 1.1,
      tpTightenPct: 0,
      slTightenPct: 0,
      forceST1: false,
      forceST2: false,
      forceST3: false,
      forceCBv5: false,
      minKcMult: 1,
      maxConcurrent: null,
      maxTradesPerDay: null,
    }));
  });
});

describe('autoTimingClassifier.shouldPromoteToTier2', () => {
  test('non-blocked result → never promote', () => {
    const r = classify(makeCell({ n: 20 }), null, makeConfig(), NOW);
    expect(shouldPromoteToTier2(r, null, 90)).toBe(false);
  });

  test('cool-down result → never promote (already persistent)', () => {
    const tier2 = { suppressUntil: NOW + 86400_000, everBadCount: 20, lastBadAt: 0 };
    const r = classify(makeCell({ n: 20, winRate: 0.3, pnlUSDT: -2 }), tier2, makeConfig(), NOW);
    expect(r.tier2Hit).toBe('cool_down');
    expect(shouldPromoteToTier2(r, tier2, 90)).toBe(false);
  });

  test('ever_bad result + no prior record → promote', () => {
    const r = { blocked: true, tier2Hit: 'ever_bad' };
    expect(shouldPromoteToTier2(r, null, 90)).toBe(true);
  });

  test('ever_bad result + last promotion >30d ago → promote', () => {
    const r = { blocked: true, tier2Hit: 'ever_bad' };
    const tier2 = { lastBadAt: Date.now() - 31 * 86400_000 };
    expect(shouldPromoteToTier2(r, tier2, 90)).toBe(true);
  });

  test('ever_bad result + last promotion <30d ago → skip (avoid runaway writes)', () => {
    const r = { blocked: true, tier2Hit: 'ever_bad' };
    const tier2 = { lastBadAt: Date.now() - 5 * 86400_000 };
    expect(shouldPromoteToTier2(r, tier2, 90)).toBe(false);
  });
});

describe('autoTimingClassifier — exported constants', () => {
  test('BAD_PNL_PER_TRADE and BAD_WIN_RATE are stable', () => {
    expect(BAD_PNL_PER_TRADE).toBe(-0.05);
    expect(BAD_WIN_RATE).toBe(0.4);
  });
});
