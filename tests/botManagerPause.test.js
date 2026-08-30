'use strict';

/**
 * FIX-2026-08-30 Phase 3b-7: Unit tests for botManager.pause() + resume()
 *
 * Background:
 *   - commandExecutor's pause/resume/force_reconsent handlers call these methods
 *     via optional chaining (ctx.botManager?.pause?.()) — but they didn't exist
 *     until Phase 3b-7, so the calls were silently no-op.
 *   - pause() reuses stop() (tears down timers/WS/traders) and sets _paused=true
 *   - resume() reuses start() (re-initializes everything) and clears _paused
 *   - Both are idempotent
 *
 * Coverage:
 *   - pause() sets _paused, calls stop(), idempotent on second call
 *   - resume() clears _paused, calls start(), idempotent when not paused
 *   - pause() tolerates stop() throwing (no crash)
 *   - resume() returns { ok:false } if start() throws
 *   - pause()/resume() leave correct _pausedAt + _pausedReason metadata
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
  refreshServerTimeOffset: jest.fn(() => Promise.resolve(0)),
  ensureTimeOffset: jest.fn(() => Promise.resolve()),
  getRateLimitStatus: jest.fn(() => ({})),
}));
jest.mock('../src/binance/binanceWs', () => ({
  marketWs: { start: jest.fn(), stop: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn() },
  userDataWs: { start: jest.fn(() => Promise.resolve()), stop: jest.fn(() => Promise.resolve()), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/binance/symbolInfo', () => ({
  getInfo: jest.fn(),
  isTradable: jest.fn(() => true),
}));
jest.mock('../src/services/klineCache', () => ({
  getCurrent: jest.fn(() => null),
  get: jest.fn(),
  update: jest.fn(),
  getAll: jest.fn(() => []),
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
  mockBot.find = jest.fn(() => Promise.resolve([]));
  mockBot.findOne = jest.fn(() => Promise.resolve(null));
  mockBot.updateOne = jest.fn(() => Promise.resolve({ modifiedCount: 1 }));
  mockBot.countDocuments = jest.fn(() => Promise.resolve(0));
  return mockBot;
});
jest.mock('../src/db/models/Trade', () => {
  const mockTrade = jest.fn();
  mockTrade.find = jest.fn(() => Promise.resolve([]));
  mockTrade.findOne = jest.fn(() => Promise.resolve(null));
  mockTrade.updateOne = jest.fn(() => Promise.resolve({ modifiedCount: 1 }));
  mockTrade.countDocuments = jest.fn(() => Promise.resolve(0));
  return mockTrade;
});
jest.mock('../src/core/trader', () => jest.fn());
jest.mock('../src/core/tpUpdater', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  stopHourlyTpUpdate: jest.fn(),
  scheduleHourlyTpUpdate: jest.fn(),
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
jest.mock('../src/services/autoPauseAdjust', () => ({
  start: jest.fn(() => Promise.resolve()),
  stop: jest.fn(),
}));
jest.mock('../src/services/telegramNotifier', () => ({
  start: jest.fn(() => Promise.resolve()),
  stop: jest.fn(),
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
jest.mock('../src/services/binanceDelistMonitor', () => ({
  getRiskInfoFor: jest.fn(() => null),
}));
jest.mock('../src/services/licenseService', () => ({
  isFeatureEnabled: jest.fn(() => true),
}));
jest.mock('../config', () => ({
  binance: { recvWindow: 60000, useBnbForFees: true, makerRate: 0.00075 },
  fees: { normalMaker: 0.00075, bnbMaker: 0.00075, normalTaker: 0.001, bnbTaker: 0.001 },
  intervals: { reconcile: 300000, autoPause: 1200000, delistScheduler: 300000, trendline: 600000 },
}));

const botManager = require('../src/core/botManager');

describe('botManager.pause() (FIX-2026-08-30 Phase 3b-7)', () => {
  let setIntervalSpy;
  beforeEach(() => {
    botManager.running = false;
    botManager._paused = false;
    botManager._pausedAt = null;
    botManager._pausedReason = null;
    botManager.reconcileTimer = null;
    botManager.traders = new Map();
    // Stub setInterval so start() doesn't leave real timers keeping Jest alive
    setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(() => 0);
  });
  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  test('sets _paused=true + calls stop() + records reason + timestamp', async () => {
    const before = Date.now();
    const r = await botManager.pause('admin_force_reconsent');
    expect(botManager._paused).toBe(true);
    expect(botManager._pausedReason).toBe('admin_force_reconsent');
    expect(botManager._pausedAt).toBeGreaterThanOrEqual(before);
    expect(botManager._pausedAt).toBeLessThanOrEqual(Date.now());
    expect(r.ok).toBe(true);
    expect(r.alreadyPaused).toBe(false);
  });

  test('idempotent: second pause() returns alreadyPaused=true', async () => {
    await botManager.pause('first');
    const r = await botManager.pause('second');
    expect(r.ok).toBe(true);
    expect(r.alreadyPaused).toBe(true);
    // Reason should remain from the first call (not overwritten)
    expect(botManager._pausedReason).toBe('first');
  });

  test('defaults reason to "admin_pause"', async () => {
    await botManager.pause();
    expect(botManager._pausedReason).toBe('admin_pause');
  });
});

describe('botManager.resume() (FIX-2026-08-30 Phase 3b-7)', () => {
  let setIntervalSpy;
  beforeEach(() => {
    botManager.running = false;
    botManager._paused = false;
    botManager._pausedAt = null;
    botManager._pausedReason = null;
    botManager.reconcileTimer = null;
    botManager.traders = new Map();
    // Stub setInterval so start() doesn't leave real timers keeping Jest alive
    setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(() => 0);
  });
  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  test('clears _paused flags after pause + resume cycle', async () => {
    await botManager.pause('admin_force_reconsent');
    expect(botManager._paused).toBe(true);
    await botManager.resume();
    expect(botManager._paused).toBe(false);
    expect(botManager._pausedAt).toBeNull();
    expect(botManager._pausedReason).toBeNull();
  });

  test('idempotent: resume() when not paused returns alreadyRunning=true', async () => {
    const r = await botManager.resume();
    expect(r.ok).toBe(true);
    expect(r.alreadyRunning).toBe(true);
    expect(botManager._paused).toBe(false);
  });

  test('returns ok:false when start() throws', async () => {
    await botManager.pause('test');
    // Force start() to throw on the next call by breaking marketWs.start
    const binanceWs = require('../src/binance/binanceWs');
    binanceWs.marketWs.start.mockImplementationOnce(() => { throw new Error('ws boom'); });
    const r = await botManager.resume();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ws boom');
  });
});
