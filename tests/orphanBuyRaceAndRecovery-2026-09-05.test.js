'use strict';

/**
 * FIX-2026-09-05: FFUSDT orphan incident — BUY filled on a bot that auto-pause
 * had just killed, leaving 71.2 FF with NO SELL order on Binance for 7h46m.
 *
 * Timeline (from pm2-out.log):
 *   ~02:16:34  checkAutoPauseBots sweep starts → findBotIdsWithBuyInFlight() snapshot
 *              taken (FF has no trade yet)
 *    02:18:01  S1 → BUY 514480761 placed (71.2 FF @ 0.10804), state='placed'
 *    02:18:09  sweep loop reaches FF (getKlines per bot ≈ 100s for the fleet) →
 *              minKC 1.039 < 1.2 → auto-pause using the 87s-stale snapshot →
 *              trader.stop() kills the in-memory fill handler
 *    02:18:13  BUY FILLS on Binance — nobody is listening
 *    02:26 →   reconcile logs "🚨 ORPHAN BUY filled on DISABLED bot" every ~5 min,
 *              98 times, taking no action.  telegramAlerted:false every single time.
 *
 * Three defects, three fixes covered here:
 *   1. TOCTOU race   — the buy-in-flight guard read a snapshot taken before the BUY
 *                      existed.  Fix: hasBuyInFlightFresh() re-query at the pause
 *                      decision point (fail-CLOSED).
 *   2. Dead latch    — the telegram latch measured `trade.updatedAt`, but the same
 *                      code block rewrote the Trade every 5 min, so staleMs never
 *                      passed 1h.  Fix: dedicated `orphanBuyAlertedAt` field, and
 *                      stop rewriting an already-'filled' trade.
 *   3. No remedy     — orphan detection had no action.  Fix: spawn a transient
 *                      trader (bot.enabled left false → onCandleClosed bails at
 *                      trader.js:3224, so it CANNOT open a new BUY) just long enough
 *                      to place the SELL, then stopTrader.
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
  size: jest.fn(() => 200),
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
  mockTrade.findById = jest.fn();
  mockTrade.updateOne = jest.fn(() => Promise.resolve({ modifiedCount: 1 }));
  mockTrade.countDocuments = jest.fn(() => Promise.resolve(0));
  return mockTrade;
});
jest.mock('../src/db/models/Signal', () => {
  const mockSignal = jest.fn();
  mockSignal.find = jest.fn(() => Promise.resolve([]));
  mockSignal.updateOne = jest.fn(() => Promise.resolve({ modifiedCount: 1 }));
  return mockSignal;
});
jest.mock('../src/core/trader', () => {
  const Trader = jest.fn();
  Trader.prototype.start = jest.fn();
  Trader.prototype.stop = jest.fn(() => Promise.resolve());
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
jest.mock('../src/services/licenseService', () => ({
  isFeatureEnabled: jest.fn().mockReturnValue(true),
  getMaxCapital: jest.fn().mockReturnValue(Infinity),
  withinMaxCapital: jest.fn().mockReturnValue(true),
  invalidateDeployedCache: jest.fn(),
  snapshot: jest.fn().mockResolvedValue({ tier: 'pro', maxCapital: Infinity, features: {} }),
}));
jest.mock('../config', () => ({
  binance: { recvWindow: 60000, useBnbForFees: true, makerRate: 0.00075 },
  fees: { normalMaker: 0.00075, bnbMaker: 0.00075, normalTaker: 0.001, bnbTaker: 0.001 },
  intervals: { reconcile: 300000, autoPause: 1200000, delistScheduler: 300000 },
}));

const botManager = require('../src/core/botManager');
const BotModel = require('../src/db/models/Bot');
const Trade = require('../src/db/models/Trade');
const binanceRest = require('../src/binance/binanceRest');
const indicators = require('../src/core/indicators');
const telegramNotifier = require('../src/services/telegramNotifier');

/** kline series that yields a LOW %KC → pause reason 'low_vol' */
function lowVolKlines() {
  const out = [];
  for (let i = 0; i < 30; i += 1) {
    out.push([1000 + i * 60000, 100, 100.1, 99.9, 100, 1000, 1000 + i * 60000 + 59999]);
  }
  return out;
}

/** empty cursor for findBotIdsWithBuyInFlight() → simulates the stale snapshot */
function emptySnapshot() {
  Trade.find.mockReturnValue({ lean: () => ({ cursor: () => (async function* () {})() }) });
}

// ───────────────────────────────────────────────────────────────────────────
// FIX 1 — TOCTOU race
// ───────────────────────────────────────────────────────────────────────────
describe('FIX 1 — hasBuyInFlightFresh() (TOCTOU race)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns true when a BUY-in-flight trade exists for the bot', async () => {
    Trade.findOne.mockReturnValueOnce({ lean: () => Promise.resolve({ _id: 't1' }) });
    await expect(botManager.hasBuyInFlightFresh('botA')).resolves.toBe(true);
  });

  test('returns false when no BUY-in-flight trade exists', async () => {
    Trade.findOne.mockReturnValueOnce({ lean: () => Promise.resolve(null) });
    await expect(botManager.hasBuyInFlightFresh('botA')).resolves.toBe(false);
  });

  test('queries the same state list the snapshot uses', async () => {
    Trade.findOne.mockReturnValueOnce({ lean: () => Promise.resolve(null) });
    await botManager.hasBuyInFlightFresh('botA');
    const filter = Trade.findOne.mock.calls[0][0];
    expect(filter.botId).toBe('botA');
    expect(filter.state.$in).toEqual(botManager.AUTO_PAUSE_BUY_IN_FLIGHT_STATES);
  });

  test('fail-CLOSED: DB error → true (do NOT pause; orphan costs more than a late pause)', async () => {
    Trade.findOne.mockImplementationOnce(() => { throw new Error('mongo down'); });
    await expect(botManager.hasBuyInFlightFresh('botA')).resolves.toBe(true);
  });
});

describe('FIX 1 — checkAutoPauseBots does not pause a BUY placed mid-sweep (FFUSDT regression)', () => {
  const ffBot = {
    _id: 'ffBotId',
    symbol: 'FFUSDT',
    timeframe: '3m',
    kcMult: 1.5,
    enabled: true,
    autoPauseEnabled: true,
    autoPauseMinKcPct: 1.2,
    deletedAt: null,
    name: 'FF(New Beta)',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    BotModel.find = jest.fn(() => ({ lean: () => Promise.resolve([ffBot]) }));
    BotModel.updateOne = jest.fn(() => Promise.resolve({ modifiedCount: 1 }));
    binanceRest.getKlines.mockResolvedValue(lowVolKlines());
    binanceRest.get24hrTickers.mockResolvedValue([{ symbol: 'FFUSDT', quoteVolume: '3910841' }]);
    // minKcPct = 0.5 < autoPauseMinKcPct 1.2 → pauseReason 'low_vol' (the real FF numbers
    // were 1.039 vs 1.2). keltnerChannel is module-mocked, so drive it directly.
    indicators.keltnerChannel.mockReturnValue({
      upper: Array(50).fill(100),
      lower: Array(50).fill(99.5),
      mid: Array(50).fill(99.75),
      width: Array(50).fill(0.5),
    });
    emptySnapshot(); // snapshot taken BEFORE the BUY existed → misses it
  });

  test('BUY appears after the snapshot → fresh re-check catches it → skip pause', async () => {
    // fresh re-query DOES see the BUY placed 87s into the sweep
    Trade.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'ffTradeId' }) });

    await botManager.checkAutoPauseBots();

    expect(BotModel.updateOne).toHaveBeenCalled();
    const writes = BotModel.updateOne.mock.calls.map((c) => c[1].$set);
    // marked as skipped...
    expect(writes.some((w) => w && w.autoPauseSkipReason === 'buy_in_flight')).toBe(true);
    // ...and critically, NEVER disabled (this is what orphaned the FF position)
    expect(writes.some((w) => w && w.enabled === false)).toBe(false);
  });

  test('no BUY in flight → pause proceeds normally (guard is not over-broad)', async () => {
    Trade.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    await botManager.checkAutoPauseBots();

    const writes = BotModel.updateOne.mock.calls.map((c) => c[1].$set);
    expect(writes.some((w) => w && w.enabled === false && w.autoPauseReason === 'low_vol')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FIX 2 — the alert latch that could never open
// ───────────────────────────────────────────────────────────────────────────
describe('FIX 2 — orphan alert latch uses a dedicated field, not updatedAt', () => {
  // Mirrors the decision in reconcilePendingTrades. Pure, so the rule is auditable.
  function shouldAlert({ trade, recovered, now }) {
    const alertedAtMs = trade.orphanBuyAlertedAt ? new Date(trade.orphanBuyAlertedAt).getTime() : 0;
    return !recovered && (!alertedAtMs || (now - alertedAtMs) > botManager.ORPHAN_ALERT_LATCH_MS);
  }
  const NOW = Date.parse('2026-09-05T10:00:00Z');

  test('first detection alerts immediately (no 1h wait)', () => {
    expect(shouldAlert({ trade: { orphanBuyAlertedAt: null }, recovered: false, now: NOW })).toBe(true);
  });

  test('re-detection 5 min later does NOT alert (spam guard still works)', () => {
    const t = { orphanBuyAlertedAt: new Date(NOW - 5 * 60 * 1000) };
    expect(shouldAlert({ trade: t, recovered: false, now: NOW })).toBe(false);
  });

  test('still orphaned after 1h → re-alerts', () => {
    const t = { orphanBuyAlertedAt: new Date(NOW - 61 * 60 * 1000) };
    expect(shouldAlert({ trade: t, recovered: false, now: NOW })).toBe(true);
  });

  test('REGRESSION: a freshly-written updatedAt no longer suppresses the alert', () => {
    // The old rule was `Date.now() - trade.updatedAt > 1h`. Because the same block
    // rewrote the trade every 5 min, updatedAt was always ~5 min old → alert never fired
    // (FFUSDT: telegramAlerted:false, staleMsSinceLastUpdate≈280000, 98× in a row).
    const ffLikeTrade = { updatedAt: new Date(NOW - 280000), orphanBuyAlertedAt: null };
    const oldRule = (Date.now() - new Date(ffLikeTrade.updatedAt).getTime()) > 60 * 60 * 1000;
    expect(oldRule).toBe(false);                                                   // old: silent
    expect(shouldAlert({ trade: ffLikeTrade, recovered: false, now: NOW })).toBe(true); // new: alerts
  });

  test('successful auto-recovery suppresses the alert (nothing for the user to do)', () => {
    expect(shouldAlert({ trade: { orphanBuyAlertedAt: null }, recovered: true, now: NOW })).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FIX 3 — auto-recovery policy
// ───────────────────────────────────────────────────────────────────────────
describe('FIX 3 — orphan auto-recovery eligibility', () => {
  // Mirrors the `canRecover` predicate in reconcilePendingTrades.
  function canRecover({ bot, trade, hasLiveTrader }) {
    return bot.enabled === false
      && !bot.deletedAt
      && botManager.ORPHAN_RECOVERABLE_PAUSE_REASONS.includes(bot.autoPauseReason)
      && (trade.orphanBuyRecoveryCount || 0) < botManager.MAX_ORPHAN_RECOVERY_ATTEMPTS
      && !hasLiveTrader;
  }
  const freshTrade = { orphanBuyRecoveryCount: 0 };
  const base = { enabled: false, deletedAt: null, autoPauseReason: 'low_vol' };

  test('auto-paused on low_vol → recoverable (the FFUSDT case)', () => {
    expect(canRecover({ bot: base, trade: freshTrade, hasLiveTrader: false })).toBe(true);
  });

  test('auto-paused on low_24h_vol → recoverable', () => {
    expect(canRecover({ bot: { ...base, autoPauseReason: 'low_24h_vol' }, trade: freshTrade, hasLiveTrader: false })).toBe(true);
  });

  test('user disabled the bot (reason=null) → NOT recoverable, alert only', () => {
    expect(canRecover({ bot: { ...base, autoPauseReason: null }, trade: freshTrade, hasLiveTrader: false })).toBe(false);
  });

  test('binance_delist → NOT recoverable (delist scheduler force-closes instead)', () => {
    expect(canRecover({ bot: { ...base, autoPauseReason: 'binance_delist' }, trade: freshTrade, hasLiveTrader: false })).toBe(false);
  });

  test('soft-deleted bot → NOT recoverable (zombie guard)', () => {
    expect(canRecover({ bot: { ...base, deletedAt: new Date() }, trade: freshTrade, hasLiveTrader: false })).toBe(false);
  });

  test('circuit breaker: stops after MAX_ORPHAN_RECOVERY_ATTEMPTS', () => {
    const exhausted = { orphanBuyRecoveryCount: botManager.MAX_ORPHAN_RECOVERY_ATTEMPTS };
    expect(canRecover({ bot: base, trade: exhausted, hasLiveTrader: false })).toBe(false);
    const oneLeft = { orphanBuyRecoveryCount: botManager.MAX_ORPHAN_RECOVERY_ATTEMPTS - 1 };
    expect(canRecover({ bot: base, trade: oneLeft, hasLiveTrader: false })).toBe(true);
  });

  test('a live trader already exists → let the normal path handle it', () => {
    expect(canRecover({ bot: base, trade: freshTrade, hasLiveTrader: true })).toBe(false);
  });
});

describe('FIX 3 — recovery constants', () => {
  test('only system-initiated pauses are recoverable', () => {
    expect(botManager.ORPHAN_RECOVERABLE_PAUSE_REASONS).toEqual(['low_vol', 'low_24h_vol']);
  });

  test('attempt cap is finite (no infinite spawn/stop loop)', () => {
    expect(botManager.MAX_ORPHAN_RECOVERY_ATTEMPTS).toBeGreaterThan(0);
    expect(Number.isFinite(botManager.MAX_ORPHAN_RECOVERY_ATTEMPTS)).toBe(true);
  });

  test('alert latch is 1 hour', () => {
    expect(botManager.ORPHAN_ALERT_LATCH_MS).toBe(60 * 60 * 1000);
  });
});

describe('FIX 3 — telegram template surfaces the recovery failure reason', () => {
  // Read the real source (the module is mocked in this file) and assert the
  // orphanBuyFilled branch renders p.recoveryError — otherwise a failed recovery
  // is invisible to the user and we are back to "silent orphan".
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/services/telegramNotifier.js'), 'utf8');

  test('orphanBuyFilled case references p.recoveryError', () => {
    const caseIdx = src.indexOf("case 'orphanBuyFilled'");
    expect(caseIdx).toBeGreaterThan(-1);
    const block = src.slice(caseIdx, caseIdx + 1200);
    expect(block).toContain('p.recoveryError');
  });
});
