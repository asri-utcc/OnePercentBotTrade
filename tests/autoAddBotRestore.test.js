'use strict';

/**
 * FIX-2026-08-23: Unit tests for autoAddBot service — soft-delete restore + activate flow
 *
 * Background:
 *   - ก่อนหน้านี้ `Bot.distinct('symbol')` รวม soft-deleted bots → autoAddBot skip symbol ที่มีบอท soft-deleted �ยู่
 *   - ตอนนี้ runOnce() แยก fetch: activeSymbols (deletedAt: null) + deletedBots (deletedAt: $ne null)
 *   - ถ้า candidate symbol มี soft-deleted bot + autoRestore=true → restore + (optional) auto-enable
 *   - ถ้า candidate symbol ไม่มีบอทเลย → create new (เหมือนเ�ิม)
 */

// ─── Mocks (top-level jest.mock — factory pattern) ─────────

// Bot model — use jest.fn() that can be reassigned per test
const mockBot = {
  distinct: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
  findOne: jest.fn(async () => null),
  findById: jest.fn(async () => null),
};

jest.mock('../src/db/models/Bot', () => mockBot);

jest.mock('../src/db/models/AppConfig', () => ({
  findOne: jest.fn(async () => null),
  updateOne: jest.fn(async () => ({})),
}));

jest.mock('../src/core/volatilityScanner', () => ({
  scanUniverse: jest.fn(),
}));

jest.mock('../src/core/botManager', () => ({
  enableBot: jest.fn(async () => ({})),
  disableBot: jest.fn(),
  stopTrader: jest.fn(),
  spawnTrader: jest.fn(),
}));

jest.mock('../src/services/eventBus', () => ({
  emit: jest.fn(),
  on: jest.fn(),
  removeAllListeners: jest.fn(),
}));

jest.mock('../src/services/botDefaults', () => ({
  getBotDefaults: jest.fn(async () => ({})),
  buildBotCreatePayload: jest.fn(({ overrides, botDefaults }) => ({
    ...botDefaults,
    ...overrides,
    enabled: false,
  })),
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// ─── Test helpers ─────────────────────────────────────────

/**
 * Configure Bot mock for a specific test scenario.
 * - activeSymbols: array of symbol strings (uppercase) — bots with deletedAt: null
 * - deletedBots: array of bot objects with _id, name, symbol, deletedAt — bots that were soft-deleted
 */
function setupBot({ activeSymbols = [], deletedBots = [] } = {}) {
  mockBot.distinct.mockImplementation(async (field, filter = {}) => {
    if (field !== 'symbol') return [];
    if (filter && Object.keys(filter).length === 0) {
      // legacy: returns all
      return [...activeSymbols, ...deletedBots.map((b) => b.symbol)];
    }
    return activeSymbols;
  });

  mockBot.find.mockImplementation((filter = {}) => {
    const wantDeleted = filter && filter.deletedAt && filter.deletedAt.$ne != null;
    const filtered = deletedBots.filter((b) => (wantDeleted ? b.deletedAt != null : true));
    return {
      select: () => ({
        lean: async () => filtered,
      }),
      lean: async () => filtered,
    };
  });

  mockBot.create.mockImplementation(async (payload) => {
    const id = `new-${Math.random().toString(36).slice(2, 10)}`;
    return { _id: id, ...payload };
  });
}

function makeDeletedBot(id, symbol, daysAgoDeleted = 5) {
  return {
    _id: id,
    name: `${symbol.replace('USDT', '')}(legacy)`,
    symbol,
    deletedAt: new Date(Date.now() - daysAgoDeleted * 86_400_000),
    scheduledDeleteAt: new Date(Date.now() - 2 * 86_400_000),
    deleteNotificationSentAt: new Date(Date.now() - 1 * 86_400_000),
  };
}

/**
 * Inject test config directly into autoAddBot instance (bypass _loadConfig).
 */
function setConfig(service, overrides = {}) {
  service.config = {
    enabled: true,
    intervalMs: 60 * 60 * 1000,
    minKcPct: 2,
    maxPerRun: 5,
    telegramNotify: true,
    autoEnable: true,
    autoRestore: true,
    namePrefix: '(bAdd)',
    scanParams: {
      timeframe: '3m',
      threshold: 0.5,
      window: 500,
      tpWindow: 30,
      topN: 100,
      minQuoteVolume: 1_000_000,
      minPctBarsAbove: 0.30,
      trends: ['uptrend', 'downtrend', 'sideways'],
      concurrency: 8,
    },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────

describe('autoAddBot.runOnce — restore soft-deleted bots (FIX-2026-08-23)', () => {
  let service;
  let volatilityScanner;
  let botManager;
  let eventBus;

  beforeEach(() => {
    jest.clearAllMocks();
    // re-enable default mocks that clearAllMocks wipes
    mockBot.updateOne.mockResolvedValue({ modifiedCount: 1 });
    botManager = require('../src/core/botManager');
    botManager.enableBot.mockImplementation(async (botId) => ({ _id: botId, enabled: true }));

    service = require('../src/services/autoAddBot');
    setConfig(service);

    volatilityScanner = require('../src/core/volatilityScanner');
    eventBus = require('../src/services/eventBus');
    service.inFlight = false;
  });

  test('Case 1: brand-new symbol + no existing bot → CREATEs new bot (regression)', async () => {
    setupBot({ activeSymbols: [], deletedBots: [] });
    volatilityScanner.scanUniverse.mockResolvedValueOnce({
      ranked: [{ symbol: 'NEWUSDT', score: 1.5, kcMinPct: 3.0, suggestedTpPct: 0.15 }],
    });

    const result = await service.runOnce({ source: 'manual', force: true });

    expect(result.created).toBe(1);
    expect(result.restored).toBe(0);
    expect(result.createdList[0].symbol).toBe('NEWUSDT');
    expect(result.createdList[0].autoEnabled).toBe(true);
    expect(result.createdEnabled).toBe(1);
    expect(botManager.enableBot).toHaveBeenCalledTimes(1);
  });

  test('Case 2: soft-deleted bot + autoRestore=true + symbol meets kc → RESTORED + auto-enabled', async () => {
    setupBot({ activeSymbols: [], deletedBots: [makeDeletedBot('bot-1', 'XYZUSDT', 5)] });
    volatilityScanner.scanUniverse.mockResolvedValueOnce({
      ranked: [{ symbol: 'XYZUSDT', score: 1.5, kcMinPct: 3.0, suggestedTpPct: 0.15 }],
    });

    const result = await service.runOnce({ source: 'manual', force: true });

    expect(result.restored).toBe(1);
    expect(result.created).toBe(0);
    expect(result.restoredList[0].symbol).toBe('XYZUSDT');
    expect(result.restoredList[0].autoEnabled).toBe(true);
    expect(result.restoredList[0].daysSinceDelete).toBeGreaterThanOrEqual(4);
    expect(botManager.enableBot).toHaveBeenCalledWith('bot-1');
    expect(mockBot.updateOne).toHaveBeenCalledWith(
      { _id: 'bot-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          deletedAt: null,
          scheduledDeleteAt: null,
          deleteNotificationSentAt: null,
          status: 'idle',
          restoredBy: 'autoAddBot',
        }),
      })
    );
  });

  test('Case 3: soft-deleted bot + autoEnable=false → RESTORED but NOT enabled', async () => {
    setConfig(service, { autoEnable: false });
    setupBot({ activeSymbols: [], deletedBots: [makeDeletedBot('bot-1', 'XYZUSDT', 5)] });
    volatilityScanner.scanUniverse.mockResolvedValueOnce({
      ranked: [{ symbol: 'XYZUSDT', score: 1.5, kcMinPct: 3.0, suggestedTpPct: 0.15 }],
    });

    const result = await service.runOnce({ source: 'manual', force: true });

    expect(result.restored).toBe(1);
    expect(result.restoredList[0].autoEnabled).toBe(false);
    expect(botManager.enableBot).not.toHaveBeenCalled();
  });

  test('Case 4: soft-deleted bot + autoRestore=false → NOT touched (fallback to CREATE)', async () => {
    setConfig(service, { autoRestore: false });
    setupBot({ activeSymbols: [], deletedBots: [makeDeletedBot('bot-1', 'XYZUSDT', 5)] });
    volatilityScanner.scanUniverse.mockResolvedValueOnce({
      ranked: [{ symbol: 'XYZUSDT', score: 1.5, kcMinPct: 3.0, suggestedTpPct: 0.15 }],
    });

    const result = await service.runOnce({ source: 'manual', force: true });

    expect(result.restored).toBe(0);
    expect(result.created).toBe(1);
    expect(result.createdList[0].symbol).toBe('XYZUSDT');
    expect(mockBot.updateOne).not.toHaveBeenCalled();
  });

  test('Case 5: soft-deleted bot + symbol below minKcPct threshold → NOT touched', async () => {
    setConfig(service, { minKcPct: 5 });
    setupBot({ activeSymbols: [], deletedBots: [makeDeletedBot('bot-1', 'XYZUSDT', 5)] });
    volatilityScanner.scanUniverse.mockResolvedValueOnce({
      ranked: [{ symbol: 'XYZUSDT', score: 1.5, kcMinPct: 2.0, suggestedTpPct: 0.15 }],
    });

    const result = await service.runOnce({ source: 'manual', force: true });

    expect(result.restored).toBe(0);
    expect(result.created).toBe(0);
    expect(result.candidates).toBe(0);
  });

  test('Case 6: mixed candidates (active + soft-deleted + new) → only restore + create eligible', async () => {
    setupBot({
      activeSymbols: ['BTCUSDT'],
      deletedBots: [makeDeletedBot('bot-1', 'XYZUSDT', 5)],
    });
    volatilityScanner.scanUniverse.mockResolvedValueOnce({
      ranked: [
        { symbol: 'BTCUSDT', score: 2.0, kcMinPct: 3.0, suggestedTpPct: 0.15 },
        { symbol: 'XYZUSDT', score: 1.5, kcMinPct: 3.0, suggestedTpPct: 0.15 },
        { symbol: 'ABCUSDT', score: 1.0, kcMinPct: 3.0, suggestedTpPct: 0.15 },
      ],
    });

    const result = await service.runOnce({ source: 'manual', force: true });

    expect(result.candidates).toBe(2);
    expect(result.restored).toBe(1);
    expect(result.created).toBe(1);
    expect(result.restoredList[0].symbol).toBe('XYZUSDT');
    expect(result.createdList[0].symbol).toBe('ABCUSDT');
  });

  test('Case 7: soft-deleted beyond 30-day window → error in failedList (not silently skipped)', async () => {
    setupBot({ activeSymbols: [], deletedBots: [makeDeletedBot('bot-1', 'XYZUSDT', 45)] });
    volatilityScanner.scanUniverse.mockResolvedValueOnce({
      ranked: [{ symbol: 'XYZUSDT', score: 1.5, kcMinPct: 3.0, suggestedTpPct: 0.15 }],
    });

    const result = await service.runOnce({ source: 'manual', force: true });

    expect(result.restored).toBe(0);
    expect(result.created).toBe(0);
    expect(result.failedList).toHaveLength(1);
    expect(result.failedList[0].symbol).toBe('XYZUSDT');
    expect(result.failedList[0].error).toMatch(/30-day|restore window/i);
    expect(mockBot.updateOne).not.toHaveBeenCalled();
    expect(botManager.enableBot).not.toHaveBeenCalled();
  });

  test('Case 8: bot:restored eventBus.emit called with correct payload', async () => {
    setupBot({ activeSymbols: [], deletedBots: [makeDeletedBot('bot-1', 'XYZUSDT', 5)] });
    volatilityScanner.scanUniverse.mockResolvedValueOnce({
      ranked: [{ symbol: 'XYZUSDT', score: 1.5, kcMinPct: 3.0, suggestedTpPct: 0.15 }],
    });

    await service.runOnce({ source: 'manual', force: true });

    const restoredEmit = eventBus.emit.mock.calls.find((c) => c[0] === 'bot:restored');
    expect(restoredEmit).toBeDefined();
    expect(restoredEmit[1]).toMatchObject({
      botId: 'bot-1',
      source: 'autoAddBot',
    });
  });

  test('Case 9: autoAddBot:restored event emitted when telegramNotify=true', async () => {
    setupBot({ activeSymbols: [], deletedBots: [makeDeletedBot('bot-1', 'XYZUSDT', 5)] });
    volatilityScanner.scanUniverse.mockResolvedValueOnce({
      ranked: [{ symbol: 'XYZUSDT', score: 1.5, kcMinPct: 3.0, suggestedTpPct: 0.15 }],
    });

    await service.runOnce({ source: 'manual', force: true });

    const restoredEmit = eventBus.emit.mock.calls.find((c) => c[0] === 'autoAddBot:restored');
    expect(restoredEmit).toBeDefined();
    expect(restoredEmit[1]).toMatchObject({
      botId: 'bot-1',
      symbol: 'XYZUSDT',
      autoEnabled: true,
    });
    expect(restoredEmit[1].daysSinceDelete).toBeGreaterThanOrEqual(4);
  });

  test('Case 10: autoAddBot:restored NOT emitted when telegramNotify=false', async () => {
    setConfig(service, { telegramNotify: false });
    setupBot({ activeSymbols: [], deletedBots: [makeDeletedBot('bot-1', 'XYZUSDT', 5)] });
    volatilityScanner.scanUniverse.mockResolvedValueOnce({
      ranked: [{ symbol: 'XYZUSDT', score: 1.5, kcMinPct: 3.0, suggestedTpPct: 0.15 }],
    });

    await service.runOnce({ source: 'manual', force: true });

    const restoredEmit = eventBus.emit.mock.calls.find((c) => c[0] === 'autoAddBot:restored');
    expect(restoredEmit).toBeUndefined();
    const internalRestored = eventBus.emit.mock.calls.find((c) => c[0] === 'bot:restored');
    expect(internalRestored).toBeDefined();
  });

  test('Case 11: active bot symbol still skipped from candidates (regression)', async () => {
    setupBot({ activeSymbols: ['BTCUSDT'], deletedBots: [] });
    volatilityScanner.scanUniverse.mockResolvedValueOnce({
      ranked: [{ symbol: 'BTCUSDT', score: 2.0, kcMinPct: 3.0, suggestedTpPct: 0.15 }],
    });

    const result = await service.runOnce({ source: 'manual', force: true });

    expect(result.candidates).toBe(0);
    expect(result.created).toBe(0);
    expect(result.restored).toBe(0);
    expect(mockBot.create).not.toHaveBeenCalled();
    expect(botManager.enableBot).not.toHaveBeenCalled();
  });

  test('Case 12: enableBot throws → restored=true but autoEnabled=false + enableError set', async () => {
    setupBot({ activeSymbols: [], deletedBots: [makeDeletedBot('bot-1', 'XYZUSDT', 5)] });
    botManager.enableBot.mockImplementationOnce(async () => {
      throw new Error('mock enableBot failure');
    });
    volatilityScanner.scanUniverse.mockResolvedValueOnce({
      ranked: [{ symbol: 'XYZUSDT', score: 1.5, kcMinPct: 3.0, suggestedTpPct: 0.15 }],
    });

    const result = await service.runOnce({ source: 'manual', force: true });

    expect(result.restored).toBe(1);
    expect(result.restoredList[0].autoEnabled).toBe(false);
    expect(result.restoredList[0].enableError).toMatch(/mock enableBot failure/);
  });
});
