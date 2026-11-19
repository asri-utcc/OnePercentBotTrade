'use strict';

/**
 * FIX-2026-11-19: reconcileAudit.analyze — detects the DB ↔ Binance drift classes found in the audit.
 * Fixtures mirror the real incidents (HEMI oversell, phantom ACE waiting trade, QI selling w/o order).
 */

const { analyze } = require('../src/services/reconcileAudit');

const NOW = Date.parse('2026-11-19T12:00:00Z');
const old = new Date(NOW - 3 * 3600 * 1000);

describe('reconcileAudit.analyze', () => {
  test('consistent state → no issues', () => {
    const issues = analyze({
      now: NOW,
      openTrades: [
        { _id: 'a1', symbol: 'ZILUSDT', state: 'selling', buyQty: 7121.3, buyPrice: 0.004, sellOrderId: 11, updatedAt: old },
        { _id: 'a2', symbol: 'PHAUSDT', state: 'waiting_sell_recovery', buyFilledQty: 69, buyPrice: 0.09 },
        { _id: 'a3', symbol: 'BTCUSDT', state: 'placed', buyQty: 0.001, buyPrice: 90000, buyOrderId: 12 },
      ],
      balances: [{ asset: 'ZIL', free: '0', locked: '7121.3' }, { asset: 'PHA', free: '69', locked: '0' }],
      openOrders: [{ orderId: 11, symbol: 'ZILUSDT' }, { orderId: 12, symbol: 'BTCUSDT' }],
      recentSold: [{ _id: 's1', symbol: 'ZILUSDT', buyQty: 100, sellQty: 100 }],
    });
    expect(issues).toEqual([]);
  });

  test('phantom position (coins gone) → SHORTFALL, tiny dust ignored', () => {
    const issues = analyze({
      now: NOW,
      openTrades: [
        { _id: 'f41116f3', symbol: 'ACEUSDT', state: 'waiting_sell_recovery', buyFilledQty: 19.8, buyPrice: 0.26 },
        { _id: 'dust', symbol: 'XUSDT', state: 'holding', buyQty: 10, buyPrice: 0.01 }, // 0.1 USDT missing
      ],
      balances: [{ asset: 'ACE', free: '0', locked: '0' }],
      openOrders: [],
      recentSold: [],
    });
    expect(issues.map((i) => i.key)).toEqual(['SHORTFALL:ACE']);
  });

  test('partial SELL fill is not a shortfall', () => {
    const issues = analyze({
      now: NOW,
      openTrades: [{ _id: 'p1', symbol: 'WUSDT', state: 'selling', buyQty: 100, sellFilledQty: 60, buyPrice: 0.1, sellOrderId: 5, updatedAt: old }],
      balances: [{ asset: 'W', free: '0', locked: '40' }],
      openOrders: [{ orderId: 5, symbol: 'WUSDT' }],
      recentSold: [],
    });
    expect(issues).toEqual([]);
  });

  test('selling without order / SELL missing from book (after grace) / unknown order / oversell', () => {
    const issues = analyze({
      now: NOW,
      openTrades: [
        { _id: '1bdef697', symbol: 'QIUSDT', state: 'selling', buyQty: 1198, buyPrice: 0.004 },
        { _id: 'gone', symbol: 'OPUSDT', state: 'selling', buyQty: 10, buyPrice: 1, sellOrderId: 77, updatedAt: old },
        { _id: 'fresh', symbol: 'OPUSDT', state: 'selling', buyQty: 10, buyPrice: 1, sellOrderId: 78, updatedAt: new Date(NOW - 60000) },
      ],
      balances: [{ asset: 'QI', free: '1198', locked: '0' }, { asset: 'OP', free: '0', locked: '20' }],
      openOrders: [{ orderId: 999, symbol: 'OPUSDT', side: 'SELL', type: 'LIMIT', origQty: '5', price: '2', clientOrderId: 'manual' }],
      recentSold: [{ _id: '1ac80cd6', symbol: 'HEMIUSDT', buyQty: 444, sellQty: 6461.1 }],
    });
    expect(issues.map((i) => i.type).sort()).toEqual(['OVERSELL', 'SELLING_NO_ORDER', 'SELL_NOT_ON_BOOK', 'UNKNOWN_ORDER']);
  });
});

describe('reconcile orphan-BUY branch skips holding trades (FIX-2026-11-19 #12)', () => {
  test('botManager has an explicit holding branch before the orphan handleBuyFilled path', () => {
    const src = require('fs').readFileSync(require.resolve('../src/core/botManager.js'), 'utf8');
    const holdingIdx = src.indexOf("} else if (trade.state === 'holding') {");
    const orphanIdx = src.indexOf("'reconcile: ORPHAN detected — BUY filled but DB state stuck'");
    expect(holdingIdx).toBeGreaterThan(0);
    expect(orphanIdx).toBeGreaterThan(holdingIdx);
  });
});
