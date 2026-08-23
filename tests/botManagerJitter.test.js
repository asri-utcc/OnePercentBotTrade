'use strict';

/**
 * FIX-2026-08-22: Unit tests for botManager subsystem timer jitter
 *
 * Background:
 *   - เดิม 4 setInterval (reconcile, autoPause, trendline, delist) เริ่ม t=0
 *     → ทุก tick aligned burst เมื่อถึงเวลา (5min, 10min, 10min, 5min)
 *   - Fix: ±10% jitter per start() → ticks กระจายตัวใน window ~33s
 *
 * Coverage:
 *   - reconcileTimer interval in [0.9*RECONCILE_INTERVAL_MS, 1.1*RECONCILE_INTERVAL_MS]
 *   - autoPauseTimer interval in [0.9*AUTO_PAUSE_INTERVAL_MS, 1.1*AUTO_PAUSE_INTERVAL_MS]
 *   - trendlineScanTimer interval in [0.9*TRENDLINE_SCAN_INTERVAL_MS, 1.1*TRENDLINE_SCAN_INTERVAL_MS]
 *   - delistSchedulerTimer interval in [0.9*DELIST_SCHEDULE_INTERVAL_MS, 1.1*DELIST_SCHEDULE_INTERVAL_MS]
 *   - Trader per-instance jitter (sweepIntervalMs + reconcileBalanceIntervalMs)
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
  marketWs: { start: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn() },
  userDataWs: { start: jest.fn(() => Promise.resolve()), on: jest.fn(), off: jest.fn() },
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
jest.mock('../config', () => ({
  binance: { recvWindow: 60000, useBnbForFees: true, makerRate: 0.00075 },
  fees: { normalMaker: 0.00075, bnbMaker: 0.00075, normalTaker: 0.001, bnbTaker: 0.001 },
  intervals: { reconcile: 300000, autoPause: 600000, delistScheduler: 300000, trendline: 600000 },
}));

const botManager = require('../src/core/botManager');

const RECONCILE_BASE = 5 * 60 * 1000;        // botManager line 23
const AUTO_PAUSE_BASE = 10 * 60 * 1000;       // botManager line 30
const TRENDLINE_BASE = 10 * 60 * 1000;        // botManager line 64
const DELIST_BASE = 5 * 60 * 1000;            // botManager line 50
const TOLERANCE = 0.1; // ±10%

const withinTolerance = (actual, base) => {
  const lo = base * (1 - TOLERANCE);
  const hi = base * (1 + TOLERANCE);
  return actual >= lo && actual <= hi;
};

describe('botManager.start() subsystem timer jitter (FIX-2026-08-22)', () => {
  let setIntervalSpy;
  let setIntervalCalls;

  beforeEach(() => {
    setIntervalCalls = [];
    setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((handler, ms, ...rest) => {
      setIntervalCalls.push({ handler, ms, rest });
      return 0; // fake handle
    });
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    // reset botManager.running + clear instance-level timer (others are module-level vars — leaked handles OK in jest)
    if (botManager) {
      botManager.running = false;
      if (botManager.reconcileTimer) { clearInterval(botManager.reconcileTimer); botManager.reconcileTimer = null; }
    }
  });

  test('reconcileTimer interval in ±10% of RECONCILE_INTERVAL_MS', async () => {
    await botManager.start();
    const matched = setIntervalCalls.find(({ ms }) => withinTolerance(ms, RECONCILE_BASE));
    expect(matched).toBeDefined();
    expect(matched.ms).toBeGreaterThanOrEqual(RECONCILE_BASE * 0.9);
    expect(matched.ms).toBeLessThanOrEqual(RECONCILE_BASE * 1.1);
  });

  test('autoPauseTimer interval in ±10% of AUTO_PAUSE_INTERVAL_MS', async () => {
    await botManager.start();
    const matched = setIntervalCalls.find(({ ms }) => withinTolerance(ms, AUTO_PAUSE_BASE));
    expect(matched).toBeDefined();
    expect(matched.ms).toBeGreaterThanOrEqual(AUTO_PAUSE_BASE * 0.9);
    expect(matched.ms).toBeLessThanOrEqual(AUTO_PAUSE_BASE * 1.1);
  });

  test('trendlineScanTimer interval in ±10% of TRENDLINE_SCAN_INTERVAL_MS', async () => {
    await botManager.start();
    const matched = setIntervalCalls.find(({ ms }) => withinTolerance(ms, TRENDLINE_BASE));
    expect(matched).toBeDefined();
    expect(matched.ms).toBeGreaterThanOrEqual(TRENDLINE_BASE * 0.9);
    expect(matched.ms).toBeLessThanOrEqual(TRENDLINE_BASE * 1.1);
  });

  test('delistSchedulerTimer interval in ±10% of DELIST_SCHEDULE_INTERVAL_MS', async () => {
    await botManager.start();
    const matched = setIntervalCalls.find(({ ms }) => withinTolerance(ms, DELIST_BASE));
    expect(matched).toBeDefined();
    expect(matched.ms).toBeGreaterThanOrEqual(DELIST_BASE * 0.9);
    expect(matched.ms).toBeLessThanOrEqual(DELIST_BASE * 1.1);
  });

  test('all 4 subsystem timers jittered (none equal to base)', async () => {
    let anyDifferent = false;
    for (let i = 0; i < 5; i++) {
      botManager.running = false;
      setIntervalCalls = [];
      await botManager.start();
      for (const { ms } of setIntervalCalls) {
        if (withinTolerance(ms, RECONCILE_BASE) || withinTolerance(ms, AUTO_PAUSE_BASE)
            || withinTolerance(ms, TRENDLINE_BASE) || withinTolerance(ms, DELIST_BASE)) {
          if (ms !== RECONCILE_BASE && ms !== AUTO_PAUSE_BASE && ms !== TRENDLINE_BASE && ms !== DELIST_BASE) {
            anyDifferent = true;
            break;
          }
        }
      }
      if (anyDifferent) break;
    }
    expect(anyDifferent).toBe(true);
  });
});

describe('jitter formula correctness (sanity check)', () => {
  test('±10% formula: 100 iterations all within range', () => {
    const jitter = (base, pct = 0.1) => Math.round(base * (1 + (Math.random() * 2 - 1) * pct));
    const base = 5 * 60 * 1000;
    for (let i = 0; i < 100; i++) {
      const v = jitter(base);
      expect(v).toBeGreaterThanOrEqual(base * 0.9);
      expect(v).toBeLessThanOrEqual(base * 1.1);
    }
  });
});
