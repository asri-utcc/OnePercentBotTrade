'use strict';

/**
 * FIX-2026-11-19: forceClose oversell (HEMI/SAGA/CELR/MOVR incidents)
 *
 * positionWatchdog re-fetched trades with a projection lacking buyQty → forceCloseTrade's cap fell
 * back to the whole free balance → one MARKET SELL dumped every sibling trade's coins
 * (HEMI trade buyQty 444 → SELL 6461.1, recorded PnL -89.59 instead of -6.16).
 */

jest.mock('../src/binance/binanceRest', () => ({
  getRateLimitStatus: jest.fn(() => ({ circuitBreaker: { state: 'closed' } })),
  getAccount: jest.fn(),
  newOrder: jest.fn(),
  cancelOrder: jest.fn(),
  cancelAllOpenOrders: jest.fn(),
  formatBinanceError: jest.fn((e) => ({ msg: e && e.message })),
}));
jest.mock('../src/binance/symbolInfo', () => ({
  loadSymbol: jest.fn(async () => ({ lotSize: { stepSize: '0.1', minQty: '0.1' } })),
}));
jest.mock('../src/core/botManager', () => ({}));
jest.mock('../src/core/dpsAfterClose', () => ({ evaluateDpsAfterClose: jest.fn() }));

const binanceRest = require('../src/binance/binanceRest');
const Trade = require('../src/db/models/Trade');
const forceClose = require('../src/core/forceClose');

const FULL = {
  _id: '6a9929b4f3b5b5db1ac80cd6', botId: 'b1', symbol: 'HEMIUSDT', state: 'holding',
  buyQty: 444, buyPrice: 0.01734, isDcaStack: false,
};
const BOT = { _id: 'b1', symbol: 'HEMIUSDT' };

beforeEach(() => {
  jest.clearAllMocks();
  binanceRest.getAccount.mockResolvedValue({ balances: [{ asset: 'HEMI', free: '6905.1', locked: '0' }] });
  binanceRest.newOrder.mockResolvedValue({ orderId: 1, executedQty: '443.1', cummulativeQuoteQty: '1.546', status: 'FILLED' });
  jest.spyOn(Trade, 'findOneAndUpdate').mockReturnValue({ lean: async () => null });
  jest.spyOn(Trade, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
});
afterEach(() => jest.restoreAllMocks());

test('projected trade without buyQty is re-loaded — MARKET SELL capped at the trade\'s own qty', async () => {
  const findById = jest.spyOn(Trade, 'findById').mockReturnValue({ lean: () => ({ catch: () => Promise.resolve(FULL) }) });
  const projected = { _id: FULL._id, botId: 'b1', symbol: 'HEMIUSDT', state: 'holding', buyPrice: 0.01734 };
  await forceClose.forceCloseTrade({ trade: projected, bot: BOT, allowMarketSell: true, source: 'watchdog' }).catch(() => {});
  expect(findById).toHaveBeenCalled();
  expect(binanceRest.newOrder).toHaveBeenCalledTimes(1);
  const qty = parseFloat(binanceRest.newOrder.mock.calls[0][0].quantity);
  expect(qty).toBeLessThanOrEqual(444);
  expect(qty).toBeGreaterThan(440);
});

test('trade with no qty at all → refuses MARKET SELL instead of selling the whole balance', async () => {
  jest.spyOn(Trade, 'findById').mockReturnValue({ lean: () => ({ catch: () => Promise.resolve(null) }) });
  const r = await forceClose.forceCloseTrade({
    trade: { _id: FULL._id, botId: 'b1', symbol: 'HEMIUSDT', state: 'holding', buyPrice: 0.01734 },
    bot: BOT, allowMarketSell: true, source: 'watchdog',
  });
  expect(r.ok).toBe(false);
  expect(binanceRest.newOrder).not.toHaveBeenCalled();
});

test('positionWatchdog re-fetch projections include buyQty/buyFilledQty', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/positionWatchdog.js'), 'utf8');
  const projections = src.match(/'state useStopLossOnUKC sellOrderId[^']*'/g) || [];
  expect(projections.length).toBeGreaterThanOrEqual(4);
  for (const p of projections) {
    expect(p).toMatch(/\bbuyQty\b/);
    expect(p).toMatch(/\bbuyFilledQty\b/);
  }
});
