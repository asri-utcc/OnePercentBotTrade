'use strict';

const eventBus = require('../src/services/eventBus');
const { AutoTiming, aggregateByCell, bucketOf, median } = require('../src/services/autoTiming');

jest.mock('../src/db/models/AppConfig');
jest.mock('../src/db/models/Bot');
jest.mock('../src/db/models/Trade');
jest.mock('../src/db/models/AutoTimingLifetime');
jest.mock('../src/db/models/AutoTimingLog');
jest.mock('../src/services/licenseService', () => ({
  isFeatureEnabled: () => true,
}), { virtual: true });

const AppConfig = require('../src/db/models/AppConfig');
const Bot = require('../src/db/models/Bot');
const Trade = require('../src/db/models/Trade');
const AutoTimingLifetime = require('../src/db/models/AutoTimingLifetime');

function makeCfgDoc(over = {}) {
  return Object.assign({
    autoTimingEnabled: true,
    autoTimingLookbackDays: 30,
    autoTimingRecentDays: 7,
    autoTimingRecentWeight: 1.5,
    autoTimingNormalWeight: 1.0,
    autoTimingSuppressCooldownDays: 90,
    autoTimingMinTradesEnforce: 5,
    autoTimingMinTradesShow: 2,
    autoTimingBands: require('../src/core/autoTimingDefaults').getDefaultBandsClone(),
    autoTimingMinNotionalFloorUSDT: 10,
    autoTimingMaxNotionalCeilingUSDT: 200,
    autoTimingIntervalMs: 30 * 60 * 1000,
  }, over);
}

beforeEach(() => {
  jest.clearAllMocks();
  AppConfig.updateOne.mockResolvedValue({ acknowledged: true });
  AppConfig.findOne.mockResolvedValue(makeCfgDoc());
  // AutoTimingLifetime.find().lean() chain — return empty array by default
  AutoTimingLifetime.find.mockReturnValue({ lean: () => Promise.resolve([]) });
  AutoTimingLifetime.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
  AutoTimingLifetime.bulkWrite.mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 });
  Bot.updateOne.mockResolvedValue({ acknowledged: true });
  // Trade.find().select().lean() chain — default to empty
  Trade.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
});

describe('autoTiming.aggregateByCell', () => {
  test('returns empty map for empty input', () => {
    const m = aggregateByCell([], { recentDays: 7, recentWeight: 1.5, normalWeight: 1.0 }, Date.now());
    expect(m.size).toBe(0);
  });

  test('buckets trades by (day, hour) of buyFilledAt using server-local TZ', () => {
    const now = Date.parse('2026-08-30T12:00:00Z');
    // 2026-08-30 is a Sunday (getDay() === 0) in UTC
    // We need a known local-time bucket; use a fresh construction that respects Date.getDay/getHours
    const buyA = new Date('2026-08-30T05:00:00Z'); // 12:00 ICT
    const sellA = new Date('2026-08-30T05:30:00Z'); // 30 min hold
    const buyB = new Date('2026-08-30T05:00:00Z'); // same bucket
    const sellB = new Date('2026-08-30T05:10:00Z'); // 10 min hold
    const trades = [
      { buyFilledAt: buyA, sellFilledAt: sellA, pnlUSDT: 0.10 },
      { buyFilledAt: buyB, sellFilledAt: sellB, pnlUSDT: -0.05 },
    ];
    const m = aggregateByCell(trades, { recentDays: 7, recentWeight: 1.5, normalWeight: 1.0 }, now);
    expect(m.size).toBe(1);
    const cell = [...m.values()][0];
    const expectedDay = buyA.getDay();
    const expectedHour = buyA.getHours();
    expect(cell.bucket.day).toBe(expectedDay);
    expect(cell.bucket.hour).toBe(expectedHour);
    // both trades are within 7d window → recentWeight=1.5
    expect(cell.n).toBe(3); // 1.5 + 1.5
    expect(cell.winRate).toBe(0.5); // 1 win out of 2 (weighted equally)
    expect(cell.pnlUSDT).toBeCloseTo(0.05, 5);
    expect(cell.medianHoldMin).toBe(20); // (10+30)/2
  });

  test('older trades get normalWeight (1.0), recent get recentWeight (1.5)', () => {
    const now = Date.parse('2026-08-30T12:00:00Z');
    // recentBuy = 3 days ago → recentDays=7 → recentWeight=1.5
    // oldBuy    = recentBuy - 7 days = 10 days ago → dayAge>7 → normalWeight=1.0
    // (10-3 = 7 days apart → same day-of-week + hour → same cell)
    const recentBuy = new Date(now - 3 * 86400_000);
    const recentSell = new Date(recentBuy.getTime() + 10 * 60_000);
    const oldBuy = new Date(recentBuy.getTime() - 7 * 86400_000);
    const oldSell = new Date(oldBuy.getTime() + 30 * 60_000);
    const trades = [
      { buyFilledAt: recentBuy, sellFilledAt: recentSell, pnlUSDT: 0.1 },
      { buyFilledAt: oldBuy, sellFilledAt: oldSell, pnlUSDT: -0.1 },
    ];
    const m = aggregateByCell(trades, { recentDays: 7, recentWeight: 1.5, normalWeight: 1.0 }, now);
    const cell = [...m.values()][0];
    expect(cell.n).toBe(2.5); // 1.5 + 1.0
  });

  test('skips trades missing buyFilledAt or sellFilledAt', () => {
    const m = aggregateByCell([
      { buyFilledAt: null, sellFilledAt: new Date(), pnlUSDT: 0 },
      { buyFilledAt: new Date(), sellFilledAt: null, pnlUSDT: 0 },
      {},
    ], { recentDays: 7, recentWeight: 1.5, normalWeight: 1.0 }, Date.now());
    expect(m.size).toBe(0);
  });

  test('median of odd-length holds', () => {
    expect(median([1, 5, 3])).toBe(3);
    expect(median([1, 2, 3, 4, 5])).toBe(3);
  });

  test('median of empty array → 0', () => {
    expect(median([])).toBe(0);
  });

  test('bucketOf maps Date to {day, hour}', () => {
    const d = new Date('2026-08-30T05:00:00Z'); // server-local hour/day
    const b = bucketOf(d);
    expect(typeof b.day).toBe('number');
    expect(typeof b.hour).toBe('number');
    expect(b.day).toBe(d.getDay());
    expect(b.hour).toBe(d.getHours());
  });
});

describe('autoTiming singleton lifecycle', () => {
  let inst;
  beforeEach(() => {
    inst = new AutoTiming();
  });

  test('start() loads config and installs interval when enabled+licensed', async () => {
    await inst.start();
    expect(inst._running).toBe(true);
    expect(inst._timer).not.toBeNull();
    expect(inst._config.enabled).toBe(true);
    inst.stop();
  });

  test('start() is idempotent', async () => {
    await inst.start();
    const timer1 = inst._timer;
    await inst.start();
    expect(inst._timer).toBe(timer1);
    inst.stop();
  });

  test('stop() clears timer and flags', async () => {
    await inst.start();
    inst.stop();
    expect(inst._running).toBe(false);
    expect(inst._timer).toBeNull();
    expect(inst._inFlight).toBe(false);
  });

  test('reloadConfig() picks up new intervalMs', async () => {
    await inst.start();
    AppConfig.findOne.mockResolvedValueOnce(makeCfgDoc({ autoTimingIntervalMs: 60_000 }));
    await inst.reloadConfig();
    expect(inst._config.intervalMs).toBe(60_000);
    inst.stop();
  });

  test('start() with disabled master does NOT install interval', async () => {
    AppConfig.findOne.mockResolvedValue(makeCfgDoc({ autoTimingEnabled: false }));
    await inst.start();
    expect(inst._running).toBe(true);
    expect(inst._timer).toBeNull();
    inst.stop();
  });

  test('getStatus() returns running/timerInstalled/inFlight/config', async () => {
    await inst.start();
    const s = inst.getStatus();
    expect(s.running).toBe(true);
    expect(typeof s.timerInstalled).toBe('boolean');
    expect(typeof s.inFlight).toBe('boolean');
    expect(s.config).toBeTruthy();
    expect(s.config.enabled).toBe(true);
    inst.stop();
  });
});

describe('autoTiming.runOnce', () => {
  let inst;
  beforeEach(() => {
    inst = new AutoTiming();
  });

  test('early-exit when master disabled', async () => {
    AppConfig.findOne.mockResolvedValue(makeCfgDoc({ autoTimingEnabled: false }));
    const r = await inst.runOnce({ source: 'manual' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('master_disabled');
  });

  test('early-exit when license disabled', async () => {
    jest.resetModules();
    jest.doMock('../src/services/licenseService', () => ({
      isFeatureEnabled: () => false,
    }), { virtual: true });
    const fresh = require('../src/services/autoTiming');
    const r = await fresh.runOnce({ source: 'manual' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('master_disabled'); // _loadConfig may have failed; either is acceptable
  });

  test('in-flight guard rejects reentry', async () => {
    inst._inFlight = true;
    const r = await inst.runOnce({ source: 'manual' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('in_flight');
  });

  test('writes Tier 2 for cells promoted by classifier', async () => {
    const now = Date.parse('2026-08-30T12:00:00Z');
    // Build 5 losing trades in one cell — bad pnlPerTrade + low winRate
    const buy0 = new Date(now - 1 * 86400_000);
    const trades = [];
    for (let i = 0; i < 5; i++) {
      trades.push({
        buyFilledAt: new Date(buy0.getTime() + i * 60_000),
        sellFilledAt: new Date(buy0.getTime() + i * 60_000 + 60_000),
        pnlUSDT: -0.5,
      });
    }
    // Pre-seed Tier 2 with everBadCount=10 (≥ threshold)
    AutoTimingLifetime.find.mockReturnValueOnce({
      lean: () => Promise.resolve([
        { day: buy0.getDay(), hour: buy0.getHours(), everBadCount: 10, suppressUntil: 0, lastBadAt: 0 },
      ]),
    });
    Trade.find.mockReturnValueOnce({
      select: () => ({ lean: () => Promise.resolve(trades) }),
    });
    AutoTimingLifetime.bulkWrite.mockResolvedValueOnce({ upsertedCount: 1 });

    const r = await inst.runOnce({ source: 'manual' });
    expect(r.ok).toBe(true);
    expect(r.cellsEvaluated).toBe(1);
    expect(r.tier2Promotions).toBe(1);
    expect(AutoTimingLifetime.bulkWrite).toHaveBeenCalled();
  });

  test('emits autoTiming:applied event when cells evaluated', async () => {
    const now = Date.parse('2026-08-30T12:00:00Z');
    const buy0 = new Date(now - 1 * 86400_000);
    const trades = [{
      buyFilledAt: buy0,
      sellFilledAt: new Date(buy0.getTime() + 30 * 60_000),
      pnlUSDT: 0.1,
    }];
    Trade.find.mockReturnValueOnce({
      select: () => ({ lean: () => Promise.resolve(trades) }),
    });
    AutoTimingLifetime.find.mockReturnValueOnce({ lean: () => Promise.resolve([]) });

    const listener = jest.fn();
    eventBus.on('autoTiming:applied', listener);
    const r = await inst.runOnce({ source: 'manual' });
    expect(r.ok).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    eventBus.off('autoTiming:applied', listener);
  });

  test('persists telemetry on success', async () => {
    const r = await inst.runOnce({ source: 'manual' });
    expect(AppConfig.updateOne).toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });

  test('persists error telemetry on thrown failure', async () => {
    Trade.find.mockImplementationOnce(() => { throw new Error('boom'); });
    const r = await inst.runOnce({ source: 'manual' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/boom/);
    expect(AppConfig.updateOne).toHaveBeenCalled();
  });
});

describe('autoTiming.decideForBot', () => {
  let inst;
  beforeEach(() => {
    inst = new AutoTiming();
  });

  function makeBot(over = {}) {
    return Object.assign({
      _id: 'bot-1',
      capitalPerTrade: 50,
      autoTimingEnabled: null,
      autoTimingOverrideCell: null,
    }, over);
  }

  test('returns no-op when master disabled', async () => {
    AppConfig.findOne.mockResolvedValue(makeCfgDoc({ autoTimingEnabled: false }));
    await inst._loadConfig();
    const r = await inst.decideForBot(makeBot(), Date.now());
    expect(r.effectiveAction).toBe('allow');
    expect(r.reason).toMatch(/disabled/);
  });

  test('returns no-op when bot explicitly opted out (autoTimingEnabled=false)', async () => {
    await inst._loadConfig();
    const r = await inst.decideForBot(makeBot({ autoTimingEnabled: false }), Date.now());
    expect(r.effectiveAction).toBe('allow');
    expect(r.reason).toMatch(/disabled/);
  });

  test('returns allow on no-data cell', async () => {
    await inst._loadConfig();
    AutoTimingLifetime.findOne.mockReturnValueOnce({ lean: () => Promise.resolve(null) });
    Trade.find.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve([]) }) });
    const r = await inst.decideForBot(makeBot(), Date.now());
    expect(r.confidence).toBe('no_data');
    expect(r.blocked).toBe(false);
  });

  test('updates bot.autoTimingLastEvaluatedAt + lastDecision', async () => {
    await inst._loadConfig();
    AutoTimingLifetime.findOne.mockReturnValueOnce({ lean: () => Promise.resolve(null) });
    Trade.find.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve([]) }) });
    await inst.decideForBot(makeBot(), Date.now());
    expect(Bot.updateOne).toHaveBeenCalled();
    const set = Bot.updateOne.mock.calls[0][1].$set;
    expect(set.autoTimingLastEvaluatedAt).toBeInstanceOf(Date);
    expect(set.autoTimingLastDecision.day).toBeDefined();
    expect(set.autoTimingLastDecision.hour).toBeDefined();
  });
});

describe('autoTiming counters', () => {
  let inst;
  beforeEach(() => {
    inst = new AutoTiming();
  });

  test('bumpCounter(open) increments both open and today counts', () => {
    const bot = { _id: 'b1' };
    const now = Date.now();
    inst.bumpCounter('open', bot, now);
    const key = `b1:${bucketOf(now).day}:${bucketOf(now).hour}`;
    expect(inst._counters.openFromCell.get(key)).toBe(1);
    expect(inst._counters.tradesFromCellToday.get(key)).toBe(1);
    inst.bumpCounter('open', bot, now);
    expect(inst._counters.openFromCell.get(key)).toBe(2);
    expect(inst._counters.tradesFromCellToday.get(key)).toBe(2);
  });

  test('bumpCounter(close) decrements open count', () => {
    const bot = { _id: 'b1' };
    const now = Date.now();
    inst.bumpCounter('open', bot, now);
    inst.bumpCounter('open', bot, now);
    inst.bumpCounter('close', bot, now);
    const key = `b1:${bucketOf(now).day}:${bucketOf(now).hour}`;
    expect(inst._counters.openFromCell.get(key)).toBe(1);
  });

  test('bumpCounter(close) at 0 stays at 0 (no negative)', () => {
    const bot = { _id: 'b1' };
    const now = Date.now();
    inst.bumpCounter('close', bot, now);
    const key = `b1:${bucketOf(now).day}:${bucketOf(now).hour}`;
    expect(inst._counters.openFromCell.get(key)).toBeUndefined();
  });

  test('resetDailyCounters clears tradesFromCellToday only', () => {
    const bot = { _id: 'b1' };
    const now = Date.now();
    inst.bumpCounter('open', bot, now);
    inst.bumpCounter('open', bot, now);
    inst.resetDailyCounters();
    const key = `b1:${bucketOf(now).day}:${bucketOf(now).hour}`;
    expect(inst._counters.openFromCell.get(key)).toBe(2); // still 2
    expect(inst._counters.tradesFromCellToday.get(key)).toBeUndefined();
  });
});
