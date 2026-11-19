'use strict';

/**
 * FIX-2026-11-19: holding-retry chain dedup + parking
 *
 * Incident (pm2 logs 2026-11-19): stranded positions below Binance MIN_NOTIONAL looped forever —
 *   - reconcile re-armed scheduleHoldingRetry every 5-min sweep on top of the running chain
 *     ("another path already placing SELL (sellInFlight claim failed)" 120ms before each failure)
 *   - exhaustion reset holdingRetryCount=0 → next sweep re-armed → ~2k "exhausted" + Telegram per day
 *   - MARKET SELL "-1013 Filter failure: NOTIONAL" retried every 60s (~6k failures)
 *
 * Pins: one chain per trade, park on exhaustion / NOTIONAL, latched alert.
 */

const Trade = require('../src/db/models/Trade');
const eventBus = require('../src/services/eventBus');
const Trader = require('../src/core/trader');

function makeTrader() {
  const t = new Trader({ _id: 'bot000000000000000000001', symbol: 'HEMIUSDT', enabled: true });
  t.running = true;
  return t;
}

function leanable(value) {
  return { lean: () => Promise.resolve(value), then: (res, rej) => Promise.resolve(value).then(res, rej), catch: () => Promise.resolve(value) };
}

describe('Trader.isUnsellableAtMarketError', () => {
  test.each([
    [{ code: -1013, msg: 'Filter failure: NOTIONAL' }, true],
    [{ code: -1013, msg: 'Filter failure: MIN_NOTIONAL' }, true],
    [{ code: -1013, msg: 'Filter failure: PERCENT_PRICE_BY_SIDE' }, true],
    [{ code: -2010, msg: 'Account has insufficient balance for requested action.' }, false],
    [{ code: -1013, msg: 'Filter failure: LOT_SIZE' }, false],
    [null, false],
  ])('%j → %s', (err, expected) => {
    expect(Trader.isUnsellableAtMarketError(err)).toBe(expected);
  });
});

describe('scheduleHoldingRetry — one chain per trade', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  test('external duplicate calls are ignored while a chain is active', async () => {
    const trader = makeTrader();
    const spy = jest.spyOn(Trade, 'findOneAndUpdate')
      .mockImplementation(() => leanable({ _id: 't1', holdingRetryCount: 1, state: 'holding' }));
    const trade = { _id: 't1' };

    await trader.scheduleHoldingRetry(trade, 10, 1, 1.01);
    await trader.scheduleHoldingRetry(trade, 10, 1, 1.01); // reconcile re-arm
    expect(spy).toHaveBeenCalledTimes(1);
    expect(trader.holdingRetryTimers.has('t1')).toBe(true);
    await trader.stop().catch(() => {});
    expect(trader.holdingRetryTimers.size).toBe(0);
  });

  test('chains for different trades on the same bot do not clobber each other', async () => {
    const trader = makeTrader();
    jest.spyOn(Trade, 'findOneAndUpdate')
      .mockImplementation(() => leanable({ holdingRetryCount: 1, state: 'holding' }));

    await trader.scheduleHoldingRetry({ _id: 'a' }, 10, 1, 1.01);
    await trader.scheduleHoldingRetry({ _id: 'b' }, 10, 1, 1.01);
    expect([...trader.holdingRetryTimers.keys()].sort()).toEqual(['a', 'b']);
    expect(trader.holdingRetryTimers.get('a')).toBeTruthy();
    expect(trader.holdingRetryTimers.get('b')).toBeTruthy();
    await trader.stop().catch(() => {});
  });

  test('exhausted budget parks the trade and alerts once (latched)', async () => {
    const trader = makeTrader();
    const updates = [];
    let alertedAt = null;
    jest.spyOn(Trade, 'findOneAndUpdate').mockImplementation((filter, update) => {
      updates.push(update);
      if (update.$inc) return leanable({ holdingRetryCount: 11, state: 'holding' });
      return leanable({ state: 'holding', holdingRetryAlertedAt: alertedAt });
    });
    jest.spyOn(Trade, 'updateOne').mockImplementation((filter, update) => {
      if (update.$set && update.$set.holdingRetryAlertedAt) alertedAt = update.$set.holdingRetryAlertedAt;
      return leanable({ modifiedCount: 1 });
    });
    const alerts = [];
    const onAlert = (p) => alerts.push(p);
    eventBus.on('insufficient:balance', onAlert);

    await trader.scheduleHoldingRetry({ _id: 'x' }, 10, 1, 1.01);
    await trader.scheduleHoldingRetry({ _id: 'x' }, 10, 1, 1.01);
    eventBus.off('insufficient:balance', onAlert);

    const park = updates.find((u) => u.$set && u.$set.holdingRetryParkedAt);
    expect(park.$set.error).toBe('stuck: holding_retry_exhausted_10');
    expect(park.$set.holdingRetryCount).toBe(0);
    expect(alerts).toHaveLength(1);
    expect(trader.holdingRetryTimers.has('x')).toBe(false);
  });
});
