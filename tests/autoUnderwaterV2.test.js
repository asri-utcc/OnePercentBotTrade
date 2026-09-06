'use strict';

/**
 * FIX-2026-09-06: Unit tests for AUv2 — Auto-Underwater v2
 *
 * Covers (pure helper AutoUnderwaterV2._evaluate):
 *   - master_off / license_off / bot_optout / dca_skip
 *   - not_open (state not in OPEN_STATES)
 *   - too_young (age < auv2MinAgeHours)
 *   - no_close (lastClose invalid)
 *   - no_ref_price (refPrice invalid)
 *   - not_shallow — pct mode
 *   - TRIGGER — pct mode (lossPct > -auv2MaxLossPct)
 *   - not_shallow — thb mode
 *   - TRIGGER — thb mode (lossTHB > -auv2MaxLossThb)
 *   - TRIGGER — hard cap reached (auv2MaxWaitDays=7, age=10d, loss still deep)
 *   - DCA stack is skipped entirely (Q4 — DCA มี BEP logic ของตัวเอง)
 *   - THB mode graceful degradation when fxRate invalid → fallback to pct
 */

const { AutoUnderwaterV2 } = require('../src/services/autoUnderwaterV2');

// ─── Test fixtures ───────────────────────────────────────────────────────

const NOW = new Date('2026-09-06T12:00:00Z').getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function bot(overrides = {}) {
  return {
    auv2Enabled: true,
    auv2MinAgeHours: 24,
    auv2LossMode: 'pct',
    auv2MaxLossPct: 5,
    auv2MaxLossThb: 200,
    auv2MaxWaitDays: 7,
    ...overrides,
  };
}

function trade(overrides = {}) {
  return {
    state: 'holding',
    buyFilledAt: new Date(NOW - 2 * DAY).toISOString(), // 2 days old
    buyPrice: 100,
    buyQty: 10,
    totalQty: 10,
    isDcaStack: false,
    stackBep: null,
    ...overrides,
  };
}

function ctx(overrides = {}) {
  return {
    now: NOW,
    lastClose: 95, // -5% from buyPrice=100
    fxRate: 35,
    masterOn: true,
    licenseOn: true,
    ...overrides,
  };
}

function eval_(opts = {}) {
  return AutoUnderwaterV2._evaluate({
    bot: opts.bot || bot(),
    trade: opts.trade || trade(),
    ctx: opts.ctx || ctx(),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('AutoUnderwaterV2._evaluate', () => {
  test('returns null when all gates pass (pct mode, loss shallow)', () => {
    // Use lastClose=95.1 → lossPct = (100-95.1)/100*100 = 4.9% (< 5% threshold → trigger)
    const skip = eval_({
      bot: bot({ auv2MaxLossPct: 5, auv2LossMode: 'pct' }),
      trade: trade({ buyPrice: 100 }),
      ctx: ctx({ lastClose: 95.1 }),
    });
    expect(skip).toBeNull();
  });

  test('returns null when loss shallower than threshold (pct mode)', () => {
    const skip = eval_({
      bot: bot({ auv2MaxLossPct: 5 }),
      ctx: ctx({ lastClose: 95.1 }), // -4.9%
    });
    expect(skip).toBeNull();
  });

  test('returns "not_shallow" when loss deeper than threshold (pct mode)', () => {
    const skip = eval_({
      bot: bot({ auv2MaxLossPct: 5 }),
      ctx: ctx({ lastClose: 90 }), // -10%
    });
    expect(skip).toBe('not_shallow');
  });

  test('returns "too_young" when age < minAgeHours', () => {
    const skip = eval_({
      bot: bot({ auv2MinAgeHours: 24 }),
      trade: trade({ buyFilledAt: new Date(NOW - 12 * HOUR).toISOString() }),
    });
    expect(skip).toBe('too_young');
  });

  test('returns "master_off" when ctx.masterOn=false', () => {
    const skip = eval_({ ctx: ctx({ masterOn: false }) });
    expect(skip).toBe('master_off');
  });

  test('returns "license_off" when ctx.licenseOn=false', () => {
    const skip = eval_({ ctx: ctx({ licenseOn: false }) });
    expect(skip).toBe('license_off');
  });

  test('returns "bot_optout" when bot.auv2Enabled !== true', () => {
    const skip = eval_({ bot: bot({ auv2Enabled: false }) });
    expect(skip).toBe('bot_optout');
  });

  test('returns "dca_skip" when trade.isDcaStack === true (even if shallow loss)', () => {
    const skip = eval_({
      trade: trade({ isDcaStack: true, stackBep: 80 }),
      ctx: ctx({ lastClose: 95.1 }), // would normally trigger
    });
    expect(skip).toBe('dca_skip');
  });

  test('returns "dca_skip" for DCA stack regardless of age/loss', () => {
    const skip = eval_({
      bot: bot({ auv2MinAgeHours: 1, auv2MaxLossPct: 50 }),
      trade: trade({
        isDcaStack: true,
        stackBep: 80,
        buyFilledAt: new Date(NOW - 30 * DAY).toISOString(), // 30 days old
      }),
      ctx: ctx({ lastClose: 79.9 }), // would trigger
    });
    expect(skip).toBe('dca_skip');
  });

  test('returns "not_open" when state not in OPEN_STATES', () => {
    const skip = eval_({ trade: trade({ state: 'sold' }) });
    expect(skip).toBe('not_open');
  });

  test('returns "no_close" when lastClose invalid', () => {
    const skip = eval_({ ctx: ctx({ lastClose: null }) });
    expect(skip).toBe('no_close');
  });

  test('returns "no_ref_price" when buyPrice <= 0', () => {
    const skip = eval_({ trade: trade({ buyPrice: 0 }) });
    expect(skip).toBe('no_ref_price');
  });

  test('THB mode — triggers when lossTHB shallower than threshold', () => {
    // Use lastClose=99.9 → loss = 0.1 USDT, qty=10, fxRate=35 → lossTHB = 35
    // 35 < 200 → trigger
    const skip = eval_({
      bot: bot({ auv2LossMode: 'thb', auv2MaxLossThb: 200 }),
      ctx: ctx({ lastClose: 99.9, fxRate: 35 }),
    });
    expect(skip).toBeNull();
  });

  test('THB mode — returns "not_shallow" when lossTHB deeper than threshold', () => {
    // lastClose=95 → loss = 5 USDT, qty=10, fxRate=35 → lossTHB = 1750
    // 1750 > 200 → not_shallow
    const skip = eval_({
      bot: bot({ auv2LossMode: 'thb', auv2MaxLossThb: 200 }),
      ctx: ctx({ lastClose: 95, fxRate: 35 }),
    });
    expect(skip).toBe('not_shallow');
  });

  test('THB mode — graceful fallback to pct when fxRate invalid', () => {
    // Use lastClose=95.1 → lossPct=4.9% (< 5) → trigger via pct fallback
    const skip = eval_({
      bot: bot({ auv2LossMode: 'thb', auv2MaxLossThb: 200, auv2MaxLossPct: 5 }),
      ctx: ctx({ lastClose: 95.1, fxRate: 0 }),
    });
    expect(skip).toBeNull();
  });

  test('THB mode — graceful fallback rejects deep loss when fxRate invalid', () => {
    const skip = eval_({
      bot: bot({ auv2LossMode: 'thb', auv2MaxLossThb: 200, auv2MaxLossPct: 5 }),
      ctx: ctx({ lastClose: 90, fxRate: 0 }),
    });
    expect(skip).toBe('not_shallow');
  });

  test('Hard cap — triggers even when loss is deep (auv2MaxWaitDays reached)', () => {
    const skip = eval_({
      bot: bot({ auv2MaxLossPct: 5, auv2MaxWaitDays: 7 }),
      trade: trade({ buyFilledAt: new Date(NOW - 10 * DAY).toISOString() }),
      ctx: ctx({ lastClose: 50 }), // -50% (very deep)
    });
    expect(skip).toBeNull(); // hard cap fires regardless of loss
  });

  test('Hard cap = 0 disables cap', () => {
    // 10 days old, loss deep → not_shallow (no cap)
    const skip = eval_({
      bot: bot({ auv2MaxLossPct: 5, auv2MaxWaitDays: 0 }),
      trade: trade({ buyFilledAt: new Date(NOW - 10 * DAY).toISOString() }),
      ctx: ctx({ lastClose: 50 }),
    });
    expect(skip).toBe('not_shallow');
  });

  test('Missing buyFilledAt → not_open', () => {
    const skip = eval_({ trade: trade({ buyFilledAt: null }) });
    expect(skip).toBe('not_open');
  });

  test('THB mode — uses totalQty when buyQty missing', () => {
    // totalQty=5, fxRate=40 → lossTHB = (100-95)*5*40 = 1000
    // 1000 > -200? No → not_shallow
    const skip = eval_({
      bot: bot({ auv2LossMode: 'thb', auv2MaxLossThb: 200 }),
      trade: trade({ buyQty: null, totalQty: 5 }),
      ctx: ctx({ lastClose: 95, fxRate: 40 }),
    });
    expect(skip).toBe('not_shallow');
  });

  test('THB mode — qty=0 → no_ref_price', () => {
    const skip = eval_({
      bot: bot({ auv2LossMode: 'thb' }),
      trade: trade({ buyQty: 0, totalQty: 0 }),
    });
    expect(skip).toBe('no_ref_price');
  });

  test('lastClose=0 → no_close', () => {
    const skip = eval_({ ctx: ctx({ lastClose: 0 }) });
    expect(skip).toBe('no_close');
  });

  test('lastClose negative → no_close (defensive)', () => {
    const skip = eval_({ ctx: ctx({ lastClose: -1 }) });
    expect(skip).toBe('no_close');
  });
});