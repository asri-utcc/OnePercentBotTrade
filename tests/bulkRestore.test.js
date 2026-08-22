'use strict';

/**
 * FIX-2026-08-22: Unit tests for POST /api/bots/bulk-restore
 *
 * Background:
 *   - เพิ่ม endpoint ใหม่สำหรับ Master Config → "↩️ Restore ที่เลือก"
 *   - �ับ { botIds: [string] } + ต้องผ่าน requireBotActionPassword
 *   - แต่ละบอทต้อง deletedAt != null (มิเฉะนั้น error "Bot is not soft-deleted")
 *   - 30-day restore window เหมือน POST /:id/restore
 *   - response: { ok, succeeded, failed, results: [{ botId, ok, error? }] }
 */

jest.mock('../src/core/botManager', () => ({
  enableBot: jest.fn(), disableBot: jest.fn(), stopTrader: jest.fn(),
  getTrendlineStatusForBots: jest.fn(() => ({})),
}));
jest.mock('../src/services/klineCache', () => ({ getCurrent: jest.fn(), getAll: jest.fn(() => []) }));
jest.mock('../src/binance/binanceRest', () => ({
  getBookTicker: jest.fn(() => Promise.reject(new Error('mock'))),
  get24hrTickers: jest.fn(() => Promise.reject(new Error('mock'))),
  getExchangeInfo: jest.fn(() => Promise.resolve({ symbols: [] })),
}));
jest.mock('../src/binance/symbolInfo', () => ({
  loadSymbol: jest.fn(() => Promise.resolve()),
  getTickSize: jest.fn(() => 0.01),
}));
jest.mock('../src/services/eventBus', () => ({ emit: jest.fn(), on: jest.fn() }));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/core/trendlineForBot', () => ({
  getTrendlineStatusForBots: jest.fn(() => ({})),
  invalidate: jest.fn(),
}));
jest.mock('../src/core/volatilityForBot', () => ({
  invalidate: jest.fn(),
  mapWithConcurrency: jest.fn(async (arr) => arr.map(() => ({}))),
  computeBotVolatilitySnapshot: jest.fn(),
}));
jest.mock('../src/core/qualityIndicator', () => ({
  computeBotsQuality: jest.fn(async () => []),
  getCachedOnly: jest.fn(() => ({})),
  init: jest.fn(() => Promise.resolve()),
  invalidate: jest.fn(),
}));
jest.mock('../src/core/tradeStats', () => ({
  aggregateTodayPerBot: jest.fn(async () => new Map()),
  aggregateMonthPerBot: jest.fn(async () => new Map()),
  aggregateActivePositionsPerBot: jest.fn(async () => new Map()),
  aggregateAllTimeGlobal: jest.fn(async () => ({ totalTrades: 0, totalWins: 0, totalPnl: 0 })),
}));
jest.mock('../src/core/forceClose', () => ({
  cleanupOrphanTrades: jest.fn(async () => ({ cleaned: [], errors: [] })),
}));
jest.mock('../src/core/dynamicPositionSizing', () => ({ invalidateAll: jest.fn() }));
jest.mock('../src/core/masterConfig', () => ({ invalidateAll: jest.fn() }));
jest.mock('../src/services/telegramNotifier', () => ({ stop: jest.fn() }));
jest.mock('../src/core/indicators', () => ({
  ema: jest.fn(() => []),
  keltnerChannels: jest.fn(() => ({ upper: 0, lower: 0, mid: 0 })),
  rsi: jest.fn(() => 0),
  atr: jest.fn(() => 0),
  stdev: jest.fn(() => 0),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
// FIX-2026-08-22: mock config to set botActionPassword — middleware reads config.botActionPassword
//   - this lets the test pass through requireBotActionPassword without env-var gymnastics
jest.mock('../config', () => ({
  botActionPassword: 'test-password',
  binanceApi: { base: 'https://mock' },
  binance: { apiKey: 'mock-key' },
}));

function invokeBulkRestore(body, options = {}) {
  // Auto-inject the test password so the request passes requireBotActionPassword
  body = { password: 'test-password', ...body };
  const Bot = require('../src/db/models/Bot');

  // Test-controlled bot DB
  const db = options.db || new Map();
  const realSave = async function () { /* no-op */ };
  Bot.findById = jest.fn(async (id) => {
    const idStr = String(id);
    const found = db.get(idStr);
    if (!found) return null;
    found.save = realSave;
    return found;
  });

  const router = require('../src/api/routes/bot.routes');
  return new Promise((resolve, reject) => {
    const req = {
      body,
      query: {},
      session: { authenticated: true },
      ip: '127.0.0.1',
      get: (header) => {
        if (header.toLowerCase() === 'x-bot-action-password') return body.password || '';
        return '';
      },
      path: '/api/bots/bulk-restore',
    };
    const res = {
      status: (code) => ({
        json: (data) => resolve({ status: code, data }),
      }),
      json: (data) => resolve({ status: 200, data }),
    };
    const layer = router.stack.find(
      (l) => l.route && l.route.path === '/bulk-restore' && l.route.methods.post
    );
    if (!layer) return reject(new Error('POST /bulk-restore route not found'));
    const handlers = layer.route.stack;
    let idx = 0;
    const next = (err) => {
      if (err) {
        return reject(err);
      }
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

function makeBot(id, overrides = {}) {
  const now = Date.now();
  return {
    _id: id,
    name: overrides.name || `Bot ${id}`,
    symbol: overrides.symbol || 'BTCUSDT',
    deletedAt: overrides.deletedAt === undefined ? new Date(now - 5 * 86400000) : overrides.deletedAt,
    scheduledDeleteAt: overrides.scheduledDeleteAt === undefined ? new Date(now - 2 * 86400000) : overrides.scheduledDeleteAt,
    deleteNotificationSentAt: overrides.deleteNotificationSentAt === undefined ? new Date(now - 1 * 86400000) : overrides.deleteNotificationSentAt,
    status: overrides.status || 'deleted',
    save: jest.fn(async function () { /* no-op */ }),
    ...overrides,
  };
}

describe('POST /api/bots/bulk-restore (FIX-2026-08-22)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 400 when botIds is missing', async () => {
    const { status, data } = await invokeBulkRestore({});
    expect(status).toBe(400);
    expect(data.error).toMatch(/botIds/);
  });

  test('returns 400 when botIds is empty array', async () => {
    const { status, data } = await invokeBulkRestore({ botIds: [] });
    expect(status).toBe(400);
    expect(data.error).toMatch(/botIds/);
  });

  test('returns 400 when botIds exceeds 100', async () => {
    const { status, data } = await invokeBulkRestore({ botIds: Array.from({ length: 101 }, (_, i) => `b${i}`) });
    expect(status).toBe(400);
    expect(data.error).toMatch(/<= 100/);
  });

  test('restores a single soft-deleted bot within 30 days', async () => {
    const bot = makeBot('b1');
    const db = new Map([['b1', bot]]);
    const { status, data } = await invokeBulkRestore({ botIds: ['b1'] }, { db });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.succeeded).toBe(1);
    expect(data.failed).toBe(0);
    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toMatchObject({ botId: 'b1', ok: true, name: bot.name, daysSinceDelete: 5 });
    // Verify bot was actually updated
    expect(bot.deletedAt).toBe(null);
    expect(bot.scheduledDeleteAt).toBe(null);
    expect(bot.deleteNotificationSentAt).toBe(null);
    expect(bot.status).toBe('idle');
  });

  test('restores multiple soft-deleted bots', async () => {
    const bots = [
      makeBot('b1', { symbol: 'BTCUSDT' }),
      makeBot('b2', { symbol: 'ETHUSDT' }),
      makeBot('b3', { symbol: 'BNBUSDT' }),
    ];
    const db = new Map(bots.map((b) => [b._id, b]));
    const { status, data } = await invokeBulkRestore({ botIds: ['b1', 'b2', 'b3'] }, { db });
    expect(status).toBe(200);
    expect(data.succeeded).toBe(3);
    expect(data.failed).toBe(0);
    bots.forEach((b) => expect(b.deletedAt).toBe(null));
  });

  test('rejects bot that is not soft-deleted', async () => {
    const activeBot = makeBot('a1', { deletedAt: null });
    const db = new Map([['a1', activeBot]]);
    const { status, data } = await invokeBulkRestore({ botIds: ['a1'] }, { db });
    expect(status).toBe(200);
    expect(data.succeeded).toBe(0);
    expect(data.failed).toBe(1);
    expect(data.results[0]).toMatchObject({ botId: 'a1', ok: false, error: 'Bot is not soft-deleted' });
  });

  test('rejects bot that does not exist', async () => {
    const db = new Map();
    const { status, data } = await invokeBulkRestore({ botIds: ['missing'] }, { db });
    expect(status).toBe(200);
    expect(data.succeeded).toBe(0);
    expect(data.failed).toBe(1);
    expect(data.results[0]).toMatchObject({ botId: 'missing', ok: false, error: 'Bot not found' });
  });

  test('rejects bot beyond 30-day restore window', async () => {
    const oldBot = makeBot('o1', { deletedAt: new Date(Date.now() - 31 * 86400000) });
    const db = new Map([['o1', oldBot]]);
    const { status, data } = await invokeBulkRestore({ botIds: ['o1'] }, { db });
    expect(status).toBe(200);
    expect(data.failed).toBe(1);
    expect(data.results[0].error).toMatch(/30-day/);
    // Should NOT have been restored
    expect(oldBot.deletedAt).not.toBe(null);
  });

  test('mixed batch — succeeds for deleted bots, fails for active bots', async () => {
    const deleted1 = makeBot('d1');
    const deleted2 = makeBot('d2', { symbol: 'ETHUSDT' });
    const active = makeBot('a1', { deletedAt: null });
    const db = new Map([
      ['d1', deleted1],
      ['d2', deleted2],
      ['a1', active],
    ]);
    const { status, data } = await invokeBulkRestore({ botIds: ['d1', 'a1', 'd2'] }, { db });
    expect(status).toBe(200);
    expect(data.succeeded).toBe(2);
    expect(data.failed).toBe(1);
    expect(deleted1.deletedAt).toBe(null);
    expect(deleted2.deletedAt).toBe(null);
    expect(active.deletedAt).toBe(null); // unchanged (was already null)
  });

  test('emits bot:updated event for each restored bot', async () => {
    const eventBus = require('../src/services/eventBus');
    const bots = [makeBot('b1'), makeBot('b2')];
    const db = new Map(bots.map((b) => [b._id, b]));
    await invokeBulkRestore({ botIds: ['b1', 'b2'] }, { db });
    const updateCalls = eventBus.emit.mock.calls.filter((c) => c[0] === 'bot:updated');
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls.map((c) => c[1].botId).sort()).toEqual(['b1', 'b2']);
  });

  test('does NOT emit bot:updated for failed bots', async () => {
    const eventBus = require('../src/services/eventBus');
    const db = new Map(); // no bots — all will fail
    await invokeBulkRestore({ botIds: ['x1', 'x2'] }, { db });
    const updateCalls = eventBus.emit.mock.calls.filter((c) => c[0] === 'bot:updated');
    expect(updateCalls).toHaveLength(0);
  });
});
