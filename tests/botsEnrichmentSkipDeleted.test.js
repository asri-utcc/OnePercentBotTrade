'use strict';

/**
 * FIX-2026-08-22 (perf): skip vol Binance enrichment for soft-deleted bots
 *
 * Background:
 *   - GET /api/bots with ?includeDeleted=1 returns ALL bots including soft-deleted
 *   - Previously, the volSnapshots loop in bot.routes.js called
 *     volatilityForBot.computeBotVolatilitySnapshot(bot) on EVERY bot — including soft-deleted.
 *   - Soft-deleted bots have no trader → klineCache is empty → every enrichment
 *     triggers a Binance REST call (get24hrTickers + getKlines × N) → wasted weight.
 *   - With 77 soft-deleted bots, that's ~460 weight per page load.
 *
 * Fix:
 *   - Route returns EMPTY_VOL sentinel for deleted bots instead of
 *     calling the Binance-heavy helper. UI gets null fields → fallback "—".
 *   - Non-deleted bots still get full enrichment (unchanged behavior).
 *   - Card still appears in the response (so 🗑 DELETED badge renders).
 */

jest.mock('../src/core/botManager', () => ({
  enableBot: jest.fn(), disableBot: jest.fn(), stopTrader: jest.fn(),
  getTrendlineStatusForBots: jest.fn(() => ({})),
}));
jest.mock('../src/services/klineCache', () => ({
  getCurrent: jest.fn(() => null),
  getAll: jest.fn(() => []),
}));
jest.mock('../src/binance/binanceRest', () => ({
  getBookTicker: jest.fn(() => Promise.reject(new Error('mock: binance not available'))),
}));
jest.mock('../src/core/prediction', () => ({
  makeKey: jest.fn((s, t) => `${s}_${t}`),
  computeUpperKCPrices: jest.fn(async () => new Map()),
  computePredictionForTrade: jest.fn(() => ({})),
}));

// FIX-2026-08-22: real mapWithConcurrency (so mapper gets invoked) but spy on the helpers
const mockComputeBotVolatilitySnapshot = jest.fn();
jest.mock('../src/core/volatilityForBot', () => {
  const realMapWithConcurrency = async (arr, limit, mapper) => {
    const out = new Array(arr.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, arr.length || 1) }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= arr.length) return;
        out[idx] = await mapper(arr[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  };
  return {
    mapWithConcurrency: realMapWithConcurrency,
    computeBotVolatilitySnapshot: mockComputeBotVolatilitySnapshot,
  };
});
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

function invokeListBots(bots, query = {}) {
  const Bot = require('../src/db/models/Bot');
  Bot.find = jest.fn(() => ({
    sort: () => ({
      lean: async () => bots,
    }),
  }));

  // Volatility snapshot stub: mark call with bot.symbol so we can assert
  mockComputeBotVolatilitySnapshot.mockImplementation(async (b) => ({
    ok: true, cached: false, ms: 1,
    kcMinPct: 1.0, kcMinPctDisplay: '1.00%', suggestedTpPct: 0.5,
    quoteVolume24h: 1000000, quoteVolume24hDisplay: '1.00M',
  }));

  const router = require('../src/api/routes/bot.routes');
  return new Promise((resolve, reject) => {
    const req = { query, session: { authenticated: true } };
    const res = {
      status: (code) => ({
        json: (data) => resolve({ status: code, data }),
      }),
      json: (data) => resolve({ status: 200, data }),
    };
    const layer = router.stack.find(
      (l) => l.route && l.route.path === '/' && l.route.methods.get
    );
    if (!layer) return reject(new Error('GET / route not found'));
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

function makeBot(overrides = {}) {
  return {
    _id: overrides._id || `bot-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name || 'TEST',
    symbol: overrides.symbol || 'BTCUSDT',
    timeframe: overrides.timeframe || '15m',
    enabled: overrides.enabled !== false,
    capitalPerTrade: 100,
    maxTrades: 3,
    deletedAt: overrides.deletedAt || null,
    kcMult: 1.5,
    ...overrides,
  };
}

describe('GET /api/bots — skip vol enrichment for soft-deleted bots (FIX-2026-08-22 perf)', () => {
  beforeEach(() => {
    mockComputeBotVolatilitySnapshot.mockClear();
  });

  test('volatilityForBot.computeBotVolatilitySnapshot NOT called for soft-deleted bots', async () => {
    const bots = [
      makeBot({ _id: 'a', symbol: 'BTCUSDT' }),
      makeBot({ _id: 'b', symbol: 'ETHUSDT', deletedAt: new Date('2026-08-15') }),
      makeBot({ _id: 'c', symbol: 'SOLUSDT' }),
      makeBot({ _id: 'd', symbol: 'BNBUSDT', deletedAt: new Date('2026-08-10') }),
    ];
    const { data } = await invokeListBots(bots, { includeDeleted: '1', expand: '1' });
    expect(data.bots).toHaveLength(4);
    // Should be called ONLY for non-deleted (a, c) — 2 calls
    expect(mockComputeBotVolatilitySnapshot).toHaveBeenCalledTimes(2);
    const calledSymbols = mockComputeBotVolatilitySnapshot.mock.calls.map((c) => c[0].symbol).sort();
    expect(calledSymbols).toEqual(['BTCUSDT', 'SOLUSDT']);
  });

  test('soft-deleted bot cards still appear in response with sentinel null vol fields', async () => {
    const bots = [
      makeBot({ _id: 'a', symbol: 'BTCUSDT' }),
      makeBot({ _id: 'b', symbol: 'ETHUSDT', deletedAt: new Date('2026-08-15') }),
    ];
    const { data } = await invokeListBots(bots, { includeDeleted: '1', expand: '1' });
    expect(data.bots).toHaveLength(2);
    const deletedCard = data.bots.find((b) => String(b._id) === 'b');
    const activeCard = data.bots.find((b) => String(b._id) === 'a');
    // Card must exist (UI needs 🗑 badge)
    expect(deletedCard).toBeDefined();
    expect(deletedCard.symbol).toBe('ETHUSDT');
    expect(deletedCard.deletedAt).toEqual(new Date('2026-08-15'));
    // vol fields = sentinel nulls
    expect(deletedCard.volKcMinPct).toBeNull();
    expect(deletedCard.volKcMinPctDisplay).toBeNull();
    expect(deletedCard.volSuggestedTpPct).toBeNull();
    expect(deletedCard.volQuoteVolume24h).toBeNull();
    expect(deletedCard.volOk).toBe(false);
    expect(deletedCard.volError).toBe('bot_deleted');
    // Active bot still has real values
    expect(activeCard.volKcMinPct).toBe(1.0);
    expect(activeCard.volOk).toBe(true);
  });
});