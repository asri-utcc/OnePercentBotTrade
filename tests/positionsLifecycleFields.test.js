'use strict';

/**
 * FIX-2026-08-22: Unit tests for /api/bots/positions lifecycle enrichment
 *
 * Background:
 *   - bot.routes.js GET /api/bots/positions now exposes botDeletedAt + botEnabled +
 *     botAutoPauseReason + botDisabledAt + botScheduledDeleteAt per position.
 *   - frontend uses these to render 🗑/⏸ badges in Open Positions modal + offer Restore.
 */

jest.mock('../src/core/botManager', () => ({
  enableBot: jest.fn(),
  disableBot: jest.fn(),
  stopTrader: jest.fn(),
  getTrendlineStatusForBots: jest.fn(() => ({})),
}));
jest.mock('../src/services/klineCache', () => ({
  getCurrent: jest.fn(() => null),
}));
jest.mock('../src/binance/binanceRest', () => ({
  getBookTicker: jest.fn(() => Promise.reject(new Error('mock: binance not available'))),
}));
jest.mock('../src/core/prediction', () => ({
  makeKey: jest.fn((sym, tf) => `${sym}_${tf}`),
  computeUpperKCPrices: jest.fn(async () => new Map()),
  computePredictionForTrade: jest.fn(() => ({
    upperKC: null, predictedSellPrice: null, predictedLossUsdt: null,
    predictedLossPct: null, predictedLossThb: null, warmup: true,
  })),
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
jest.mock('../src/services/eventBus', () => ({
  emit: jest.fn(),
  on: jest.fn(),
}));
jest.mock('../src/core/forceClose', () => ({
  cleanupOrphanTrades: jest.fn(async () => ({ cleaned: [], errors: [] })),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/services/fxService', () => ({ getUsdtToThb: jest.fn() }));
jest.mock('../src/core/trendlineForBot', () => ({
  getTrendlineStatusForBots: jest.fn(() => ({})),
}));

function invokeGetPositions(bots, trades) {
  const Bot = require('../src/db/models/Bot');
  const Trade = require('../src/db/models/Trade');
  const botSelectChain = { lean: () => Promise.resolve(bots) };
  Bot.find = jest.fn(() => ({ select: () => botSelectChain }));
  const tradeChain = {
    sort: () => ({ limit: () => ({ lean: () => Promise.resolve(trades) }) }),
  };
  Trade.find = jest.fn(() => tradeChain);

  const router = require('../src/api/routes/bot.routes');

  return new Promise((resolve, reject) => {
    const req = { query: {}, session: { authenticated: true } };
    const res = {
      status: (code) => ({ json: (data) => resolve({ status: code, data }) }),
      json: (data) => resolve({ status: 200, data }),
    };
    const layer = router.stack.find(
      (l) => l.route && l.route.path === '/positions' && l.route.methods.get
    );
    if (!layer) return reject(new Error('GET /positions route not found'));
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

describe('GET /api/bots/positions — lifecycle enrichment (FIX-2026-08-22)', () => {
  const baseBot = {
    _id: 'b1',
    name: 'Coti(bAdd)',
    symbol: 'COTIUSDT',
    timeframe: '5m',
    enabled: false,
    retryMax: 3,
    kcMult: 1.2,
  };
  const baseTrade = {
    _id: 't1',
    botId: 'b1',
    symbol: 'COTIUSDT',
    timeframe: '5m',
    state: 'filled',
    buyPrice: 0.1,
    buyQty: 100,
    buyQuoteQty: 10,
    buyFilledAt: new Date('2026-08-22T10:00:00Z'),
    buyOrderId: 'order-1',
    retryCount: 0,
  };

  test('includes botDeletedAt when position belongs to soft-deleted bot', async () => {
    const deletedAt = new Date('2026-08-20T03:00:00Z');
    const bots = [{ ...baseBot, deletedAt, enabled: false, autoPauseReason: null, disabledAt: null }];
    const { status, data } = await invokeGetPositions(bots, [baseTrade]);
    expect(status).toBe(200);
    expect(data.positions).toHaveLength(1);
    const pos = data.positions[0];
    expect(new Date(pos.botDeletedAt).toISOString()).toBe(deletedAt.toISOString());
    expect(pos.botEnabled).toBe(false);
    expect(pos.botAutoPauseReason).toBeNull();
  });

  test('includes botAutoPauseReason when bot was auto-paused (low vol)', async () => {
    const disabledAt = new Date('2026-08-21T05:00:00Z');
    const bots = [{ ...baseBot, deletedAt: null, enabled: false, autoPauseReason: 'low_vol', disabledAt }];
    const { data } = await invokeGetPositions(bots, [baseTrade]);
    const pos = data.positions[0];
    expect(pos.botDeletedAt).toBeNull();
    expect(pos.botEnabled).toBe(false);
    expect(pos.botAutoPauseReason).toBe('low_vol');
    expect(new Date(pos.botDisabledAt).toISOString()).toBe(disabledAt.toISOString());
  });

  test('botEnabled=true for running bot (no deletion, no auto-pause)', async () => {
    const bots = [{ ...baseBot, deletedAt: null, enabled: true, autoPauseReason: null, disabledAt: null }];
    const { data } = await invokeGetPositions(bots, [baseTrade]);
    const pos = data.positions[0];
    expect(pos.botEnabled).toBe(true);
    expect(pos.botDeletedAt).toBeNull();
    expect(pos.botAutoPauseReason).toBeNull();
  });

  test('exposes botScheduledDeleteAt + botDeleteNotifiedAt (FIX-2026-08-22)', async () => {
    const deletedAt = new Date('2026-08-22T01:00:00Z');
    const scheduledDeleteAt = new Date('2026-09-21T01:00:00Z');
    const notifAt = new Date('2026-08-15T01:00:00Z');
    const bots = [{
      ...baseBot, deletedAt, enabled: false, autoPauseReason: null, disabledAt: null,
      scheduledDeleteAt, deleteNotificationSentAt: notifAt,
    }];
    const { data } = await invokeGetPositions(bots, [baseTrade]);
    const pos = data.positions[0];
    expect(new Date(pos.botScheduledDeleteAt).toISOString()).toBe(scheduledDeleteAt.toISOString());
    expect(new Date(pos.botDeleteNotifiedAt).toISOString()).toBe(notifAt.toISOString());
  });

  test('orphans (bot doc missing) still filtered from response (no regression)', async () => {
    const { data } = await invokeGetPositions([], [baseTrade]);
    expect(data.positions).toHaveLength(0);
    expect(data.orphanFiltered).toBe(1);
    expect(data.orphanTradeIds).toContain('t1');
  });

  test('mixed: 1 active + 1 deleted bot — both positions enriched correctly', async () => {
    const activeBotId = 'active';
    const deletedBotId = 'deleted';
    const bots = [
      { ...baseBot, _id: activeBotId, enabled: true, deletedAt: null },
      { ...baseBot, _id: deletedBotId, enabled: false, deletedAt: new Date('2026-08-19T01:00:00Z'), autoPauseReason: null },
    ];
    const trades = [
      { ...baseTrade, _id: 't-active', botId: activeBotId },
      { ...baseTrade, _id: 't-deleted', botId: deletedBotId },
    ];
    const { data } = await invokeGetPositions(bots, trades);
    expect(data.positions).toHaveLength(2);
    const byId = Object.fromEntries(data.positions.map((p) => [p.botId, p]));
    expect(byId[activeBotId].botEnabled).toBe(true);
    expect(byId[activeBotId].botDeletedAt).toBeNull();
    expect(byId[deletedBotId].botEnabled).toBe(false);
    expect(new Date(byId[deletedBotId].botDeletedAt).toISOString()).toBe(new Date('2026-08-19T01:00:00Z').toISOString());
  });
});