'use strict';

/**
 * FIX-2026-08-22: Unit tests for /api/bots includeDeleted filter
 *
 * Background:
 *   - default behavior of GET /api/bots is to exclude soft-deleted bots (deletedAt: null)
 *   - ?includeDeleted=1 returns all bots including soft-deleted
 *   - frontend now ALWAYS sends ?includeDeleted=1 (UI controls visibility via chip filter)
 */

jest.mock('../src/core/botManager', () => ({
  enableBot: jest.fn(), disableBot: jest.fn(), stopTrader: jest.fn(),
  getTrendlineStatusForBots: jest.fn(() => ({})),
}));
jest.mock('../src/services/klineCache', () => ({ getCurrent: jest.fn() }));
jest.mock('../src/binance/binanceRest', () => ({
  getBookTicker: jest.fn(() => Promise.reject(new Error('mock: binance not available'))),
}));
jest.mock('../src/core/prediction', () => ({
  makeKey: jest.fn((s, t) => `${s}_${t}`),
  computeUpperKCPrices: jest.fn(async () => new Map()),
  computePredictionForTrade: jest.fn(() => ({})),
}));
jest.mock('../src/core/volatilityForBot', () => ({
  mapWithConcurrency: jest.fn(async (arr) => arr.map(() => ({}))),
  computeBotVolatilitySnapshot: jest.fn(),
}));
jest.mock('../src/core/tradeStats', () => ({
  aggregateTodayPerBot: jest.fn(async () => new Map()),
  aggregateMonthPerBot: jest.fn(async () => new Map()),
  aggregateActivePositionsPerBot: jest.fn(async () => new Map()),
  aggregateAllTimeGlobal: jest.fn(async () => ({ totalTrades: 0, totalWins: 0, totalPnl: 0 })),
}));
jest.mock('../src/services/eventBus', () => ({ emit: jest.fn(), on: jest.fn() }));
jest.mock('../src/core/forceClose', () => ({
  cleanupOrphanTrades: jest.fn(async () => ({ cleaned: [], errors: [] })),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/core/trendlineForBot', () => ({
  getTrendlineStatusForBots: jest.fn(() => ({})),
}));

function invokeListBots(query = {}) {
  const Bot = require('../src/db/models/Bot');
  let capturedFilter = null;
  Bot.find = jest.fn((filter) => {
    capturedFilter = filter;
    return {
      sort: () => ({
        lean: async () => [],
      }),
    };
  });

  const router = require('../src/api/routes/bot.routes');
  return new Promise((resolve, reject) => {
    const req = { query, session: { authenticated: true } };
    const res = {
      status: (code) => ({
        json: (data) => resolve({ filter: capturedFilter, status: code, data }),
      }),
      json: (data) => resolve({ filter: capturedFilter, status: 200, data }),
    };
    const layer = router.stack.find(
      (l) => l.route && l.route.path === '/' && l.route.methods.get
    );
    if (!layer) return reject(new Error('GET / route not found'));
    // route.stack: [0]=requireAuth, [1]=handler. Run all in order.
    const handlers = layer.route.stack;
    let idx = 0;
    const next = (err) => {
      if (err) return reject(err);
      if (idx >= handlers.length) return;
      const h = handlers[idx++].handle;
      try {
        h(req, res, next);
      } catch (e) {
        reject(e);
      }
    };
    next();
  });
}

describe('GET /api/bots — includeDeleted query param (FIX-2026-08-22)', () => {
  test('default behavior EXCLUDES soft-deleted bots (filter: deletedAt: null)', async () => {
    const { filter } = await invokeListBots();
    expect(filter).toEqual({ deletedAt: null });
  });

  test('?includeDeleted=1 INCLUDES all bots (filter: {})', async () => {
    const { filter } = await invokeListBots({ includeDeleted: '1' });
    expect(filter).toEqual({});
  });

  test('?includeDeleted=true behaves same as default (only "1" triggers inclusion)', async () => {
    const { filter } = await invokeListBots({ includeDeleted: 'true' });
    expect(filter).toEqual({ deletedAt: null });
  });

  test('?includeDeleted=0 behaves same as default (excludes)', async () => {
    const { filter } = await invokeListBots({ includeDeleted: '0' });
    expect(filter).toEqual({ deletedAt: null });
  });
});