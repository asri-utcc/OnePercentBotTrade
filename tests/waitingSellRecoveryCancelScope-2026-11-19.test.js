'use strict';

/**
 * FIX-2026-11-19: waitingSellRecovery must not touch other trades' SELLs, and must not place a SELL
 * for coins the wallet doesn't hold (audit: 6/7 waiting trades had no coins left).
 */

const mockTrade = { find: jest.fn(), updateOne: jest.fn() };
jest.mock('../src/db/models/Trade', () => mockTrade);
jest.mock('../src/db/models/AppConfig', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/binance/binanceRest', () => ({
  getBookTicker: jest.fn(), newOrder: jest.fn(), getOpenOrders: jest.fn(),
  cancelOrder: jest.fn(), getAccount: jest.fn(),
}));
jest.mock('../src/binance/symbolInfo', () => ({ loadSymbol: jest.fn() }));
jest.mock('../src/services/eventBus', () => ({ emit: jest.fn() }));

const binanceRest = require('../src/binance/binanceRest');
const symbolInfo = require('../src/binance/symbolInfo');
const wsr = require('../src/services/waitingSellRecovery');

const num = (n) => ({ toNumber: () => n });
const waiting = { _id: 'w1', symbol: 'WUSDT', state: 'waiting_sell_recovery', waitingTargetPrice: 0.026, buyQty: 235.6 };

beforeEach(() => {
  jest.clearAllMocks();
  symbolInfo.loadSymbol.mockResolvedValue({
    baseAsset: 'W', lotSize: { stepSize: num(0.1) }, priceFilter: { tickSize: num(0.00001) }, notional: { minNotional: num(5) },
  });
  binanceRest.getBookTicker.mockResolvedValue({ askPrice: '0.025' });
  binanceRest.getOpenOrders.mockResolvedValue([
    { orderId: 111, side: 'SELL', clientOrderId: 'b123-sell-tp' },       // another trade's live TP
    { orderId: 222, side: 'SELL', clientOrderId: 'wsr-sell-old-abcd' },  // stale, unowned wsr order
    { orderId: 333, side: 'SELL', clientOrderId: 'wsr-sell-own-efgh' },  // wsr order owned by a selling trade
  ]);
  binanceRest.newOrder.mockResolvedValue({ orderId: 999, clientOrderId: 'wsr-sell-new' });
  mockTrade.find.mockReturnValue({ lean: async () => [{ sellOrderId: 111 }, { sellOrderId: 333 }] });
  mockTrade.updateOne.mockReturnValue({ catch: () => Promise.resolve({ modifiedCount: 1 }), then: (r) => r({ modifiedCount: 1 }) });
});

test('only cancels stale wsr-sell-* orders that no trade owns; sells buyQty when buyFilledQty missing', async () => {
  binanceRest.getAccount.mockResolvedValue({ balances: [{ asset: 'W', free: '595', locked: '0' }] });
  const stats = {};
  await wsr._processSymbol('WUSDT', [waiting], stats);
  const cancelled = binanceRest.cancelOrder.mock.calls.map((c) => c[0].orderId);
  expect(cancelled).toEqual([222]);
  expect(binanceRest.newOrder).toHaveBeenCalledTimes(1);
  expect(parseFloat(binanceRest.newOrder.mock.calls[0][0].quantity)).toBeCloseTo(235.6, 5);
});

test('skips placement when the wallet does not hold the coins', async () => {
  binanceRest.getAccount.mockResolvedValue({ balances: [{ asset: 'W', free: '0.4', locked: '0' }] });
  const stats = {};
  await wsr._processSymbol('WUSDT', [waiting], stats);
  expect(binanceRest.newOrder).not.toHaveBeenCalled();
  expect(binanceRest.cancelOrder).not.toHaveBeenCalled();
  expect(stats.skippedNoBalance).toBe(1);
});
