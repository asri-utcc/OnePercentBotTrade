'use strict';

/**
 * FIX-2026-08-20: Unit tests for src/core/tradeStats.js
 *
 * Background: Total Trades tile ในหน้า bots เคยแสดง 309 ทั้งที่ DB มี 1,646 trades
 *   - เพราะ API filter `deletedAt: null` ตัด 77 soft-deleted bots ออก
 *   - แล้ว `bots.reduce((s,b) => s + (b.totalTrades), 0)` รวมแค่ 44 active bots
 *   - รวม trades จาก soft-deleted bots = 1,335 trades ที่หายไป
 *
 * Fix: aggregateAllTimeGlobal() ใช้ Trade collection (source of truth) โดยตรง
 *   - ไม่สนว่า bot ยังมีอยู่หรือถูกลบ
 *   - ไม่ต้องพึ่ง bot.totalTrades cumulative counter (ที่อาจมี drift)
 *
 * Test strategy:
 *   - mock mongoose Model.aggregate() → verify pipeline shape
 *   - verify ผลลัพธ์ map โครงสร้าง (ไม่ผูกกับ bot's deletedAt)
 */

const mongoose = require('mongoose');

describe('tradeStats.aggregateAllTimeGlobal', () => {
  let originalAggregate;
  let aggregateMock;

  beforeEach(() => {
    // mock mongoose.Model.aggregate ผ่าน mongoose.models.Trade
    const Trade = require('../src/db/models/Trade');
    originalAggregate = Trade.aggregate;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockAggregateReturn(rows) {
    const Trade = require('../src/db/models/Trade');
    // aggregate returns a thenable (Promise-like) — must support .then()
    const thenable = Promise.resolve(rows);
    Trade.aggregate = jest.fn(() => thenable);
  }

  // require AFTER mock setup so the module picks up the mock
  function loadModule() {
    jest.isolateModules(() => {
      // ensures a fresh module instance with the mock
    });
    return require('../src/core/tradeStats');
  }

  test('returns { totalTrades, totalWins, totalPnl } with correct shape', async () => {
    mockAggregateReturn([{ totalTrades: 1646, totalWins: 832, totalPnl: 12.34 }]);
    const { aggregateAllTimeGlobal } = loadModule();
    const result = await aggregateAllTimeGlobal();
    expect(result).toEqual({ totalTrades: 1646, totalWins: 832, totalPnl: 12.34 });
  });

  test('returns zeros when no trades exist', async () => {
    mockAggregateReturn([]);
    const { aggregateAllTimeGlobal } = loadModule();
    const result = await aggregateAllTimeGlobal();
    expect(result).toEqual({ totalTrades: 0, totalWins: 0, totalPnl: 0 });
  });

  test('aggregates ALL trades regardless of bot deletedAt status (key fix)', async () => {
    // simulate: total = 1646 = 309 (active) + 1335 (deleted) + 2 (orphan)
    mockAggregateReturn([{ totalTrades: 1646, totalWins: 832, totalPnl: 5.67 }]);
    const { aggregateAllTimeGlobal } = loadModule();
    const result = await aggregateAllTimeGlobal();

    // KEY: this number is what the summary tile should show (1646, not 309)
    expect(result.totalTrades).toBe(1646);
    // Sanity: it must NOT be 309 (the bug value)
    expect(result.totalTrades).not.toBe(309);
  });

  test('uses pipeline with $match state=sold + realizedPnl != null + $group', async () => {
    const Trade = require('../src/db/models/Trade');
    const spy = jest.fn(() => Promise.resolve([{ totalTrades: 0, totalWins: 0, totalPnl: 0 }]));
    Trade.aggregate = spy;

    const { aggregateAllTimeGlobal } = loadModule();
    await aggregateAllTimeGlobal();

    expect(spy).toHaveBeenCalledTimes(1);
    const pipeline = spy.mock.calls[0][0];
    expect(pipeline).toHaveLength(2);
    expect(pipeline[0]).toEqual({
      $match: { state: 'sold', realizedPnl: { $ne: null } },
    });
    expect(pipeline[1].$group).toMatchObject({
      _id: null,
      totalTrades: { $sum: 1 },
      totalWins: { $sum: { $cond: [{ $gt: ['$realizedPnl', 0] }, 1, 0] } },
      totalPnl: { $sum: '$realizedPnl' },
    });
  });

  test('pipeline does NOT filter by botId (so includes trades from soft-deleted bots)', async () => {
    const Trade = require('../src/db/models/Trade');
    const spy = jest.fn(() => Promise.resolve([{ totalTrades: 0, totalWins: 0, totalPnl: 0 }]));
    Trade.aggregate = spy;

    const { aggregateAllTimeGlobal } = loadModule();
    await aggregateAllTimeGlobal();

    const pipeline = spy.mock.calls[0][0];
    const matchStage = pipeline[0].$match;
    expect(matchStage).not.toHaveProperty('botId');
    expect(matchStage).not.toHaveProperty('botDeletedAt');
  });
});

describe('tradeStats.aggregateTodayPerBot', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('returns Map<botIdString, { todayTrades, todayPnl }>', async () => {
    const Trade = require('../src/db/models/Trade');
    const botId = '6a842a10a30b17fc2b2eab82';
    Trade.aggregate = jest.fn(() => Promise.resolve([
      { _id: botId, todayTrades: 4, todayPnl: 0.12 },
    ]));

    const { aggregateTodayPerBot } = require('../src/core/tradeStats');
    const map = await aggregateTodayPerBot();
    expect(map.get(botId)).toEqual({ todayTrades: 4, todayPnl: 0.12 });
  });

  test('uses sellFilledAt $gte today\'s start', async () => {
    const Trade = require('../src/db/models/Trade');
    const spy = jest.fn(() => Promise.resolve([]));
    Trade.aggregate = spy;

    const { aggregateTodayPerBot } = require('../src/core/tradeStats');
    await aggregateTodayPerBot();

    const pipeline = spy.mock.calls[0][0];
    const matchStage = pipeline[0].$match;
    expect(matchStage.sellFilledAt).toHaveProperty('$gte');
    expect(matchStage.sellFilledAt.$gte).toBeInstanceOf(Date);
  });
});

describe('tradeStats.aggregateMonthPerBot', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('groups by botId with monthTrades + monthPnl', async () => {
    const Trade = require('../src/db/models/Trade');
    const botId = '6a842a10a30b17fc2b2eab82';
    Trade.aggregate = jest.fn(() => Promise.resolve([
      { _id: botId, monthTrades: 12, monthPnl: 0.5 },
    ]));

    const { aggregateMonthPerBot } = require('../src/core/tradeStats');
    const map = await aggregateMonthPerBot();
    expect(map.get(botId)).toEqual({ monthTrades: 12, monthPnl: 0.5 });
  });
});

describe('tradeStats.aggregateActivePositionsPerBot', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('matches 7-state open positions set', async () => {
    const Trade = require('../src/db/models/Trade');
    const spy = jest.fn(() => Promise.resolve([]));
    Trade.aggregate = spy;

    const { aggregateActivePositionsPerBot } = require('../src/core/tradeStats');
    await aggregateActivePositionsPerBot();

    const pipeline = spy.mock.calls[0][0];
    const matchStage = pipeline[0].$match;
    expect(matchStage.state.$in).toEqual([
      'placed', 'partial_wait', 'filled', 'retrying', 'holding', 'selling', 'stopping',
    ]);
  });
});

describe('tradeStats.startOfTodayLocal / startOfMonthLocal', () => {
  test('startOfTodayLocal is today 00:00:00 local', () => {
    const { startOfTodayLocal } = require('../src/core/tradeStats');
    const d = startOfTodayLocal();
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });

  test('startOfMonthLocal is day 1, 00:00:00 local', () => {
    const { startOfMonthLocal } = require('../src/core/tradeStats');
    const d = startOfMonthLocal();
    expect(d.getDate()).toBe(1);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
});
