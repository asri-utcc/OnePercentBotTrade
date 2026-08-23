'use strict';

/**
 * FIX-2026-08-22: Unit tests for auto-pause skip when BUY is in flight.
 *
 * Background:
 *   - ก่อนหน้านี้ checkAutoPauseBots() (ใน botManager.js) check แค่ volatility metrics
 *     (Min-%KC + 24hVol) — ไม่สนใจว่ามี BUY order ค้างอยู่หรือไม่
 *   - ปัญหา: BUY 1344279972 (RVN) placed @ 01:27:16 → auto-pause fired @ 01:27:37
 *     → trader.stop() killed in-memory SELL-placement handler → BUY filled @ 01:30:46
 *     → SELL never placed → orphan 2108.4 RVN (~$7.42) ค้างในกระเป๋า 7 ชม.
 *   - Fix: findBotIdsWithBuyInFlight() query Trade collection ก่อน pause
 *     — ถ้ามี trade ใน BUY-in-flight states → skip pause (รอ tick ถัดไป)
 *
 * Coverage:
 *   - AUTO_PAUSE_BUY_IN_FLIGHT_STATES มี states ที่ user-specified (placed, retrying)
 *     + safety states (filled, holding, partial_wait, partial_sell_wait, stopping)
 *   - findBotIdsWithBuyInFlight() returns Set of botId strings จาก Trade query
 *   - findBotIdsWithBuyInFlight() fail-OPEN (return empty Set on error → pause allowed)
 *   - `selling` is NOT in BUY-in-flight (SELL on order book → safe to pause)
 *   - `sold` / `cancelled` / `failed` are NOT in BUY-in-flight (terminal)
 */

// Mock all heavy deps that botManager.js requires at load time
// (binanceRest, ws, models, eventBus, etc.) — only Trade is exercised.
jest.mock('../src/binance/binanceRest', () => ({
  getKlines: jest.fn(),
  get24hrTickers: jest.fn(() => Promise.resolve([])),
  newOrder: jest.fn(),
  cancelOrder: jest.fn(),
  getOrder: jest.fn(),
  getAccount: jest.fn(),
  getMyTrades: jest.fn(),
  formatBinanceError: jest.fn(),
}));
jest.mock('../src/binance/binanceWs', () => ({
  marketWs: { subscribe: jest.fn(), unsubscribe: jest.fn() },
  userDataWs: { on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/binance/symbolInfo', () => ({
  getInfo: jest.fn(),
  isTradable: jest.fn(() => true),
}));
jest.mock('../src/services/klineCache', () => ({
  getCurrent: jest.fn(() => null),
  get: jest.fn(),
  update: jest.fn(),
}));
jest.mock('../src/services/eventBus', () => {
  const EventEmitter = require('events');
  return new EventEmitter();
});
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../src/db/models/Bot', () => {
  const mockBot = jest.fn();
  mockBot.find = jest.fn(() => ({ lean: () => Promise.resolve([]) }));
  mockBot.findOne = jest.fn(() => Promise.resolve(null));
  mockBot.updateOne = jest.fn(() => Promise.resolve({ modifiedCount: 1 }));
  mockBot.countDocuments = jest.fn(() => Promise.resolve(0));
  return mockBot;
});
jest.mock('../src/db/models/Trade', () => {
  const mockTrade = jest.fn();
  // Trade.find(...).lean().cursor() — match the API used in botManager.findBotIdsWithBuyInFlight
  mockTrade.find = jest.fn();
  mockTrade.findOne = jest.fn();
  mockTrade.updateOne = jest.fn(() => Promise.resolve({ modifiedCount: 1 }));
  mockTrade.countDocuments = jest.fn(() => Promise.resolve(0));
  return mockTrade;
});
jest.mock('../src/core/trader', () => jest.fn());
jest.mock('../src/core/tpUpdater', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  forceUpdate: jest.fn(),
}));
jest.mock('../src/core/indicators', () => ({
  keltnerChannel: jest.fn(() => ({ upper: [], lower: [], mid: [], width: [] })),
  ema: jest.fn(() => []),
}));
jest.mock('../src/core/trendlineForBot', () => ({
  ensureCacheForBots: jest.fn(),
  getTrendlineStatusForBots: jest.fn(() => ({})),
  invalidateTrendlineCache: jest.fn(),
}));
jest.mock('../src/core/volatilityForBot', () => ({}));
jest.mock('../src/core/backtester', () => ({}));
jest.mock('../src/core/prediction', () => ({}));
jest.mock('../src/core/dpsAfterClose', () => ({}));
jest.mock('../src/core/cbPatternEvaluator', () => ({}));
jest.mock('../src/services/telegramNotifier', () => ({
  sendNow: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/healthMonitor', () => ({
  start: jest.fn(),
  stop: jest.fn(),
}));
jest.mock('../src/realtime/dashboardWs', () => ({
  broadcast: jest.fn(),
  init: jest.fn(),
}));
jest.mock('../src/services/fxService', () => ({
  getUsdtToThb: jest.fn(() => Promise.resolve(35)),
  clearCache: jest.fn(),
}));
jest.mock('../config', () => ({
  binance: { recvWindow: 60000, useBnbForFees: true, makerRate: 0.00075 },
  fees: { normalMaker: 0.00075, bnbMaker: 0.00075, normalTaker: 0.001, bnbTaker: 0.001 },
  intervals: { reconcile: 300000, autoPause: 600000, delistScheduler: 300000 },
}));

const botManager = require('../src/core/botManager');
const Trade = require('../src/db/models/Trade');

describe('AUTO_PAUSE_BUY_IN_FLIGHT_STATES (FIX-2026-08-22)', () => {
  test('contains user-named states (placed, retrying)', () => {
    const S = botManager.AUTO_PAUSE_BUY_IN_FLIGHT_STATES;
    expect(S).toContain('placed');
    expect(S).toContain('retrying');
  });

  test('contains safety states (filled, holding, partial_wait, partial_sell_wait, stopping)', () => {
    const S = botManager.AUTO_PAUSE_BUY_IN_FLIGHT_STATES;
    expect(S).toContain('filled');
    expect(S).toContain('holding');
    expect(S).toContain('partial_wait');
    expect(S).toContain('partial_sell_wait');
    expect(S).toContain('stopping');
  });

  test('does NOT include `selling` (SELL on order book → safe to pause)', () => {
    const S = botManager.AUTO_PAUSE_BUY_IN_FLIGHT_STATES;
    expect(S).not.toContain('selling');
  });

  test('does NOT include terminal states (sold, cancelled, failed)', () => {
    const S = botManager.AUTO_PAUSE_BUY_IN_FLIGHT_STATES;
    expect(S).not.toContain('sold');
    expect(S).not.toContain('cancelled');
    expect(S).not.toContain('failed');
  });
});

describe('findBotIdsWithBuyInFlight()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns Set of botId strings from Trade query', async () => {
    // Mock Trade.find(...).lean().cursor() to return an async iterator
    const mockTrades = [
      { _id: 't1', botId: 'botA' },
      { _id: 't2', botId: 'botB' },
      { _id: 't3', botId: 'botA' }, // duplicate botId
    ];
    const mockCursor = (async function* () {
      for (const t of mockTrades) yield t;
    })();
    Trade.find.mockReturnValueOnce({
      lean: () => ({ cursor: () => mockCursor }),
    });

    const set = await botManager.findBotIdsWithBuyInFlight();
    expect(set).toBeInstanceOf(Set);
    expect(set.size).toBe(2);
    expect(set.has('botA')).toBe(true);
    expect(set.has('botB')).toBe(true);
    expect(set.has('botC')).toBe(false);

    // verify query was called with $in on the right states
    expect(Trade.find).toHaveBeenCalledTimes(1);
    const queryArg = Trade.find.mock.calls[0][0];
    expect(queryArg.state.$in).toEqual(expect.arrayContaining(['placed', 'retrying', 'filled']));
  });

  test('returns empty Set when no BUY-in-flight trades exist', async () => {
    const mockCursor = (async function* () {})(); // empty
    Trade.find.mockReturnValueOnce({
      lean: () => ({ cursor: () => mockCursor }),
    });

    const set = await botManager.findBotIdsWithBuyInFlight();
    expect(set.size).toBe(0);
  });

  test('fail-OPEN: returns empty Set on Trade.find() error (pause still allowed)', async () => {
    Trade.find.mockImplementationOnce(() => {
      throw new Error('mongo down');
    });

    const set = await botManager.findBotIdsWithBuyInFlight();
    expect(set.size).toBe(0);
  });

  test('skips records with missing botId (defensive)', async () => {
    const mockTrades = [
      { _id: 't1', botId: 'botA' },
      { _id: 't2', botId: null },
      { _id: 't3' }, // missing botId
      null,         // null record (defensive)
    ];
    const mockCursor = (async function* () {
      for (const t of mockTrades) yield t;
    })();
    Trade.find.mockReturnValueOnce({
      lean: () => ({ cursor: () => mockCursor }),
    });

    const set = await botManager.findBotIdsWithBuyInFlight();
    expect(set.size).toBe(1);
    expect(set.has('botA')).toBe(true);
  });
});

describe('skip-pause decision (regression: 2026-08-22 RVN orphan)', () => {
  // Reproduce the exact decision logic inline (mirrors checkAutoPauseBots PAUSE branch).
  // Keeping it pure makes the rule auditable without spinning up the full scanner.
  function shouldSkip({ bot, buyInFlightBots, kcLow, volLow }) {
    const pauseReason = kcLow ? 'low_vol' : (volLow ? 'low_24h_vol' : null);
    if (pauseReason && bot.enabled !== false) {
      if (buyInFlightBots.has(String(bot._id))) {
        return { skip: true, reason: 'buy_in_flight' };
      }
      return { skip: false, reason: pauseReason };
    }
    return { skip: false, reason: null };
  }

  const rvBot = { _id: 'rvBot', enabled: true };
  const buyInFlight = new Set(['rvBot']);
  const noBuyInFlight = new Set();

  test('skips pause when bot has BUY in flight (RVN case)', () => {
    const r = shouldSkip({ bot: rvBot, buyInFlightBots: buyInFlight, kcLow: true, volLow: true });
    expect(r).toEqual({ skip: true, reason: 'buy_in_flight' });
  });

  test('skips pause when only %KC is low (not 24hVol)', () => {
    const r = shouldSkip({ bot: rvBot, buyInFlightBots: buyInFlight, kcLow: true, volLow: false });
    expect(r).toEqual({ skip: true, reason: 'buy_in_flight' });
  });

  test('does NOT skip when bot is healthy (no pause reason)', () => {
    const r = shouldSkip({ bot: rvBot, buyInFlightBots: buyInFlight, kcLow: false, volLow: false });
    expect(r).toEqual({ skip: false, reason: null });
  });

  test('does NOT skip when bot has no BUY in flight (pause proceeds normally)', () => {
    const r = shouldSkip({ bot: rvBot, buyInFlightBots: noBuyInFlight, kcLow: true, volLow: true });
    expect(r).toEqual({ skip: false, reason: 'low_vol' });
  });

  test('does NOT skip when bot is already disabled (no pause action anyway)', () => {
    const r = shouldSkip({ bot: { _id: 'rvBot', enabled: false }, buyInFlightBots: buyInFlight, kcLow: true, volLow: true });
    expect(r).toEqual({ skip: false, reason: null });
  });
});
