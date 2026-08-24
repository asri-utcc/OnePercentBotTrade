'use strict';

/**
 * FIX-2026-08-22 (auto-resume replay-1): Unit tests for replay-last-closed-candle
 * on auto-resume from auto-pause.
 *
 * Background:
 *   - GIGGLE incident 2026-08-05: re-enabling a paused bot would replay 200 historical
 *     candles → S1 detector fired ghost BUY on stale signals.
 *   - Fix at that time: skip ALL historical replay by jumping cursor to latestClosedMs
 *     when cursorAgeMs > 30 minutes.
 *   - PUMP incident 2026-08-22 02:33 BKK: bot auto-paused → resumed → missed the S1
 *     signal that fired during pause.
 *   - New fix: when cursor is moderately stale (>30s ≤ 5min) on re-enable, replay
 *     ONLY the last closed candle (1 candle, not historical window) to catch missed
 *     S1 signals while preserving ghost-BUY protection.
 *
 * Coverage:
 *   - gate #1: _resetStaleReplayCursorOnEnable returns { newCursorMs, pendingReplayCandle }
 *   - gate #2: cursorAgeMs ≤ 30s → no replay (too fresh; WS will catch up)
 *   - gate #3: 30s < cursorAgeMs ≤ 5min → reset cursor AND replay last closed candle
 *   - gate #4: cursorAgeMs > 5min → reset cursor but NO replay (too stale)
 *   - gate #5: Binance fetch fails → graceful no-op (no reset, no replay)
 *   - gate #6: no closed candle available → no reset, no replay
 *   - gate #7: fresh bot (lastSignalCloseTime === 0) → cursor reset, no replay
 *   - gate #8: spawnTrader with pendingReplayCandle → schedules onCandleClosed via setImmediate
 *   - gate #9: spawnTrader without pendingReplayCandle → no replay scheduled
 *   - gate #10: spawnTrader on soft-deleted bot → no replay scheduled (defense-in-depth)
 *   - gate #11: replay onCandleClosed error → caught and logged, no crash
 */

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
  marketWs: {
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    subscribeMarket: jest.fn(),
    unsubscribeMarket: jest.fn(),
    stop: jest.fn(),
  },
  userDataWs: { on: jest.fn(), off: jest.fn(), stop: jest.fn(() => Promise.resolve()) },
}));
jest.mock('../src/binance/symbolInfo', () => ({
  getInfo: jest.fn(),
  isTradable: jest.fn(() => true),
  loadSymbol: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/klineCache', () => ({
  getCurrent: jest.fn(() => null),
  get: jest.fn(),
  update: jest.fn(),
  getAll: jest.fn(() => []),
  size: jest.fn(() => 200),       // seedKlines early-returns if ≥ 100
  seed: jest.fn(),
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
  mockBot.findById = jest.fn(() => Promise.resolve(null));
  mockBot.updateOne = jest.fn(() => Promise.resolve({ modifiedCount: 1 }));
  mockBot.updateMany = jest.fn(() => Promise.resolve({ modifiedCount: 1 }));
  mockBot.countDocuments = jest.fn(() => Promise.resolve(0));
  return mockBot;
});
jest.mock('../src/db/models/Trade', () => {
  const mockTrade = jest.fn();
  mockTrade.find = jest.fn();
  mockTrade.findOne = jest.fn();
  mockTrade.updateOne = jest.fn(() => Promise.resolve({ modifiedCount: 1 }));
  mockTrade.countDocuments = jest.fn(() => Promise.resolve(0));
  return mockTrade;
});
jest.mock('../src/core/trader', () => {
  const Trader = jest.fn();
  Trader.prototype.start = jest.fn();
  Trader.prototype.stop = jest.fn(() => Promise.resolve());
  Trader.prototype.onCandleClosed = jest.fn(() => Promise.resolve());
  return Trader;
});
jest.mock('../src/core/tpUpdater', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  forceUpdate: jest.fn(),
}));
jest.mock('../src/core/indicators', () => ({
  keltnerChannel: jest.fn(() => ({
    upper: Array(50).fill(100),
    lower: Array(50).fill(95),
    mid: Array(50).fill(97.5),
    width: Array(50).fill(5),
  })),
  ema: jest.fn(() => []),
}));
jest.mock('../src/core/trendlineForBot', () => ({
  ensureCacheForBots: jest.fn(),
  getTrendlineStatusForBots: jest.fn(() => ({})),
  invalidateTrendlineCache: jest.fn(),
  scanSingleBot: jest.fn(),
  computeBotTrendlineSnapshot: jest.fn(),
  mapWithConcurrency: jest.fn(async (arr) => arr.map(() => ({}))),
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
const BotModel = require('../src/db/models/Bot');
const binanceRest = require('../src/binance/binanceRest');
const TraderModule = require('../src/core/trader');

// Helper: build a closed candle array entry [openTime, O, H, L, C, V, closeTime]
function makeKline(openTime, close, vol = 1000) {
  const closeTime = openTime + 60000 - 1; // 1m candle: closeTime = openTime + 59999
  return [openTime, close - 0.5, close + 1, close - 1, close, vol, closeTime];
}

// Helper: create a botManager instance for spawnTrader tests
// (the module exports both the class and standalone checkAutoPauseBots function)
function newManager() {
  return new botManager.constructor();
}

describe('FIX-2026-08-22: _resetStaleReplayCursorOnEnable return shape', () => {
  let nowMock;

  beforeEach(() => {
    jest.clearAllMocks();
    nowMock = 1_780_000_000_000; // fixed "now" for deterministic cursorAgeMs
    jest.spyOn(Date, 'now').mockReturnValue(nowMock);
  });

  afterEach(() => {
    Date.now.mockRestore();
  });

  test('fresh cursor (≤30s) → returns null pendingReplayCandle, no Binance call', async () => {
    // cursor age = 10s (≤ REPLAY_MIN_AGE_MS=30s → fresh)
    const lastSignalCloseTime = nowMock - (10 * 1000);
    const bot = {
      _id: 'freshBot',
      symbol: 'TESTUSDT',
      timeframe: '1m',
      lastSignalCloseTime,
    };

    const result = await botManager._resetStaleReplayCursorOnEnable(bot);

    expect(result).toEqual({ newCursorMs: lastSignalCloseTime, pendingReplayCandle: null });
    expect(binanceRest.getKlines).not.toHaveBeenCalled();
    expect(BotModel.updateOne).not.toHaveBeenCalled();
  });

  test('cursorAgeMs = 31s (just above REPLAY_MIN_AGE_MS) → reset cursor + replay last closed candle', async () => {
    // cursor age = 31 seconds (in safe replay window: 30s < age ≤ 5min)
    const cursorAgeMs = 31 * 1000;
    const lastSignalCloseTime = nowMock - cursorAgeMs;
    const lastClosedMs = nowMock - 60 * 1000; // last closed candle 1 min ago
    const lastClosedOpenTime = lastClosedMs - 59999;
    const lastClosedCandle = makeKline(lastClosedOpenTime, 100);

    binanceRest.getKlines.mockResolvedValueOnce([
      lastClosedCandle,
      [nowMock + 30000, 100, 101, 99, 100, 1000, nowMock + 89999], // forming
    ]);

    const bot = {
      _id: 'inWindowBot',
      symbol: 'TESTUSDT',
      timeframe: '1m',
      lastSignalCloseTime,
    };

    const result = await botManager._resetStaleReplayCursorOnEnable(bot);

    expect(result.newCursorMs).toBe(lastClosedMs);
    expect(result.pendingReplayCandle).toBeTruthy();
    expect(result.pendingReplayCandle.closeTime).toBe(lastClosedMs);
    expect(result.pendingReplayCandle.close).toBe(100);
    expect(result.pendingReplayCandle.openTime).toBe(lastClosedOpenTime);
    expect(BotModel.updateOne).toHaveBeenCalledWith(
      { _id: 'inWindowBot' },
      { $set: { lastSignalCloseTime: lastClosedMs } },
    );
  });

  test('cursorAgeMs = 5 min exactly (REPLAY_MAX_AGE_MS boundary) → replay allowed', async () => {
    const cursorAgeMs = 5 * 60 * 1000;
    const lastSignalCloseTime = nowMock - cursorAgeMs;
    const lastClosedMs = nowMock - 30 * 1000;
    const lastClosedCandle = makeKline(lastClosedMs - 59999, 200);

    binanceRest.getKlines.mockResolvedValueOnce([lastClosedCandle]);

    const bot = {
      _id: 'boundaryBot',
      symbol: 'TESTUSDT',
      timeframe: '1m',
      lastSignalCloseTime,
    };

    const result = await botManager._resetStaleReplayCursorOnEnable(bot);

    expect(result.pendingReplayCandle).toBeTruthy();
    expect(result.pendingReplayCandle.closeTime).toBe(lastClosedMs);
  });

  test('cursorAgeMs > 5 min (too stale) → cursor reset but NO replay', async () => {
    // cursor age = 1 hour (above REPLAY_MAX_AGE_MS)
    const cursorAgeMs = 60 * 60 * 1000;
    const lastSignalCloseTime = nowMock - cursorAgeMs;
    const lastClosedMs = nowMock - 30 * 1000;
    const lastClosedCandle = makeKline(lastClosedMs - 59999, 50);

    binanceRest.getKlines.mockResolvedValueOnce([lastClosedCandle]);

    const bot = {
      _id: 'tooStaleBot',
      symbol: 'TESTUSDT',
      timeframe: '1m',
      lastSignalCloseTime,
    };

    const result = await botManager._resetStaleReplayCursorOnEnable(bot);

    // cursor IS reset
    expect(result.newCursorMs).toBe(lastClosedMs);
    // but NO replay candle
    expect(result.pendingReplayCandle).toBeNull();
    // and DB is updated
    expect(BotModel.updateOne).toHaveBeenCalledWith(
      { _id: 'tooStaleBot' },
      { $set: { lastSignalCloseTime: lastClosedMs } },
    );
  });

  test('cursorAgeMs > 30 min (GIGGLE protection path) → reset cursor, NO replay', async () => {
    // Same as above but verify the GIGGLE-incident protection still holds
    const cursorAgeMs = 45 * 60 * 1000; // 45 min
    const lastSignalCloseTime = nowMock - cursorAgeMs;
    const lastClosedMs = nowMock - 60 * 1000;
    const lastClosedCandle = makeKline(lastClosedMs - 59999, 25);

    binanceRest.getKlines.mockResolvedValueOnce([lastClosedCandle]);

    const bot = {
      _id: 'giggleBot',
      symbol: 'GIGGLEUSDT',
      timeframe: '1m',
      lastSignalCloseTime,
    };

    const result = await botManager._resetStaleReplayCursorOnEnable(bot);

    expect(result.newCursorMs).toBe(lastClosedMs);
    expect(result.pendingReplayCandle).toBeNull();
  });

  test('Binance fetch fails → THROW STALE_CURSOR_RESET_FAILED (FIX-2026-08-24 P0-6: refuse to enable to prevent ghost BUY replay)', async () => {
    // FIX-2026-08-24 (P0-6 audit): เดิม swallow error เงียบๆ → spawnTrader → reconcileKlines('startup')
    //   replay 200 candles จาก stale cursor → ghost BUY (regression GIGGLE 2026-08-05)
    //   ใหม่ throw เพื่อให้ caller (enableBot, auto-resume) abort spawn safely
    binanceRest.getKlines.mockRejectedValueOnce(new Error('Network error'));

    const bot = {
      _id: 'fetchFailBot',
      symbol: 'TESTUSDT',
      timeframe: '1m',
      lastSignalCloseTime: nowMock - (60 * 1000), // 60s old (would normally replay)
    };

    await expect(botManager._resetStaleReplayCursorOnEnable(bot))
      .rejects
      .toThrow(/stale-cursor reset failed for bot fetchFailBot: Network error/);

    // wrapped error must carry code for caller to identify
    try {
      await botManager._resetStaleReplayCursorOnEnable(bot);
    } catch (err) {
      expect(err.code).toBe('STALE_CURSOR_RESET_FAILED');
      expect(err.botId).toBe('fetchFailBot');
    }
  });

  test('No closed candle available (Binance returns only forming) → no reset, no replay', async () => {
    binanceRest.getKlines.mockResolvedValueOnce([
      [nowMock + 30000, 100, 101, 99, 100, 1000, nowMock + 89999], // forming only
    ]);

    const bot = {
      _id: 'noClosedBot',
      symbol: 'TESTUSDT',
      timeframe: '1m',
      lastSignalCloseTime: nowMock - (60 * 1000),
    };

    const result = await botManager._resetStaleReplayCursorOnEnable(bot);

    expect(result.newCursorMs).toBe(bot.lastSignalCloseTime);
    expect(result.pendingReplayCandle).toBeNull();
    expect(BotModel.updateOne).not.toHaveBeenCalled();
  });

  test('Fresh bot (lastSignalCloseTime === 0) → Binance called, cursor reset, no replay', async () => {
    // Fresh bot has no cursor yet. Should still fetch klines and set cursor to latest.
    const lastClosedMs = nowMock - 30 * 1000;
    const lastClosedCandle = makeKline(lastClosedMs - 59999, 50);

    binanceRest.getKlines.mockResolvedValueOnce([lastClosedCandle]);

    const bot = {
      _id: 'newBot',
      symbol: 'TESTUSDT',
      timeframe: '1m',
      lastSignalCloseTime: 0,
    };

    const result = await botManager._resetStaleReplayCursorOnEnable(bot);

    // cursorAge = nowMs - 0 = a huge number → too_stale path
    expect(result.newCursorMs).toBe(lastClosedMs);
    expect(result.pendingReplayCandle).toBeNull();
    expect(BotModel.updateOne).toHaveBeenCalledWith(
      { _id: 'newBot' },
      { $set: { lastSignalCloseTime: lastClosedMs } },
    );
  });
});

describe('FIX-2026-08-22: spawnTrader replays pendingReplayCandle via setImmediate', () => {
  let logger;
  let manager;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = require('../src/utils/logger');
    TraderModule.mockClear();
    TraderModule.prototype.start.mockClear();
    TraderModule.prototype.onCandleClosed.mockClear();
    TraderModule.prototype.onCandleClosed.mockResolvedValue(undefined);
    // seedKlines calls getKlines with limit 200 — provide a stub
    binanceRest.getKlines.mockResolvedValue([]);
    manager = newManager();
    manager.traders = new Map();
  });

  test('spawnTrader(bot, { pendingReplayCandle }) → schedules trader.onCandleClosed via setImmediate', async () => {
    const bot = {
      _id: 'testBotId',
      symbol: 'TESTUSDT',
      timeframe: '3m',
      deletedAt: null,
    };
    const pendingCandle = {
      openTime: 1000,
      open: 99, high: 101, low: 98, close: 100, volume: 5000, closeTime: 1599,
    };

    await manager.spawnTrader(bot, { pendingReplayCandle: pendingCandle });

    // Verify trader started
    expect(TraderModule.prototype.start).toHaveBeenCalledTimes(1);

    // Flush microtasks + setImmediate
    await new Promise((resolve) => setImmediate(resolve));

    // Verify onCandleClosed called once with replay trigger
    expect(TraderModule.prototype.onCandleClosed).toHaveBeenCalledTimes(1);
    expect(TraderModule.prototype.onCandleClosed).toHaveBeenCalledWith(
      pendingCandle,
      { replay: true, trigger: 'resume-replay-1' },
    );
  });

  test('spawnTrader(bot) without opts → no replay scheduled', async () => {
    const bot = {
      _id: 'testBotId',
      symbol: 'TESTUSDT',
      timeframe: '3m',
      deletedAt: null,
    };

    await manager.spawnTrader(bot);

    expect(TraderModule.prototype.start).toHaveBeenCalledTimes(1);

    // Flush setImmediate
    await new Promise((resolve) => setImmediate(resolve));

    expect(TraderModule.prototype.onCandleClosed).not.toHaveBeenCalled();
  });

  test('spawnTrader with pendingReplayCandle on soft-deleted bot → no replay scheduled', async () => {
    const deletedBot = {
      _id: 'deletedBotId',
      symbol: 'TESTUSDT',
      timeframe: '3m',
      deletedAt: new Date('2026-08-22T00:00:00Z'),
    };
    const pendingCandle = {
      openTime: 1000, open: 99, high: 101, low: 98, close: 100, volume: 5000, closeTime: 1599,
    };

    await manager.spawnTrader(deletedBot, { pendingReplayCandle: pendingCandle });

    // spawnTrader should bail BEFORE creating trader
    expect(TraderModule.prototype.start).not.toHaveBeenCalled();

    await new Promise((resolve) => setImmediate(resolve));

    expect(TraderModule.prototype.onCandleClosed).not.toHaveBeenCalled();
  });

  test('replay onCandleClosed error → caught and logged, no crash', async () => {
    TraderModule.prototype.onCandleClosed.mockRejectedValueOnce(new Error('S1 detection failed'));

    const bot = {
      _id: 'testBotId',
      symbol: 'TESTUSDT',
      timeframe: '3m',
      deletedAt: null,
    };
    const pendingCandle = {
      openTime: 1000, open: 99, high: 101, low: 98, close: 100, volume: 5000, closeTime: 1599,
    };

    await manager.spawnTrader(bot, { pendingReplayCandle: pendingCandle });

    await new Promise((resolve) => setImmediate(resolve));
    // Wait a tick for the rejected promise to propagate through the try/catch
    await new Promise((resolve) => setImmediate(resolve));

    expect(TraderModule.prototype.onCandleClosed).toHaveBeenCalledTimes(1);
    const warnCalls = logger.warn.mock.calls.map((c) => c[1]);
    expect(warnCalls.some((m) => m && m.includes('resume-replay-1 candle failed'))).toBe(true);
  });
});

describe('FIX-2026-08-22: enableBot() does NOT pass pendingReplayCandle', () => {
  let manager;

  beforeEach(() => {
    jest.clearAllMocks();
    TraderModule.mockClear();
    TraderModule.prototype.start.mockClear();
    manager = newManager();
    manager.traders = new Map();
    binanceRest.getKlines.mockResolvedValue([]);
  });

  test('enableBot → spawnTrader called WITHOUT opts.pendingReplayCandle', async () => {
    // Stub _resetStaleReplayCursorOnEnable to return a valid pendingCandle
    jest.spyOn(botManager, '_resetStaleReplayCursorOnEnable').mockResolvedValueOnce({
      newCursorMs: 1000,
      pendingReplayCandle: {
        openTime: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: 1000,
      },
    });

    // Mock Bot.findById to return an enabled bot
    const aliveDoc = {
      _id: 'manualEnableBot',
      symbol: 'TESTUSDT',
      timeframe: '3m',
      deletedAt: null,
      enabled: false,
      enabledAt: null,
      status: 'idle',
      safeTradeTrendlineEnabled: false,
      name: 'btc',
      totalActiveMs: 0,
      save: jest.fn(function () { return Promise.resolve(this); }),
    };
    BotModel.findById.mockResolvedValue(aliveDoc);

    const spawnSpy = jest.spyOn(manager, 'spawnTrader').mockResolvedValueOnce(undefined);

    await manager.enableBot('manualEnableBot');

    // spawnTrader should be called WITHOUT pendingReplayCandle
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnOpts = spawnSpy.mock.calls[0][1] || {};
    expect(spawnOpts.pendingReplayCandle).toBeUndefined();

    spawnSpy.mockRestore();
  });
});
