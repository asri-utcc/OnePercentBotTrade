'use strict';

/**
 * FIX-2026-09-17: waiting_sell_recovery scheduler regression tests
 *
 * Background:
 *   After the orphan-SELL sweeper rollback (2026-09-17), 17 trades were
 *   inserted with state='waiting_sell_recovery' because at restore time
 *   their target TP was > marketPrice × 1.20 (Binance PRICE_FILTER would
 *   reject LIMIT_MAKER). These positions hold the coin but have NO SELL
 *   order on Binance — they will not auto-sell when price recovers.
 *
 *   The waiting_sell_recovery scheduler (services/waitingSellRecovery.js)
 *   re-checks every N hours (default 4h) and places LIMIT_MAKER SELL when
 *   the target TP comes into PRICE_FILTER range.
 *
 * This test guards against the 4-layer-whitelist + scheduler wiring class:
 *   1. AppConfig schema has 5 new fields (master toggle, interval, 3 telemetry)
 *   2. admin.routes whitelist accepts the new fields + clamps interval
 *   3. server.js wires start() and stop() for the scheduler
 *   4. waitingSellRecovery.js emits eventBus 'waitingSellRecovery:placed' on success
 *   5. telegramNotifier.js has the handler case 'waitingSellRecoveryPlaced'
 *   6. waitingSellRecovery._evaluate() pure helper returns correct skip reasons
 *
 * Source-level tests only — no DB/network — runs in <50ms.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP_CONFIG_SRC = readSrc('src/db/models/AppConfig.js');
const ADMIN_ROUTES_SRC = readSrc('src/api/routes/admin.routes.js');
const SERVER_SRC = readSrc('src/server.js');
const WSR_SRC = readSrc('src/services/waitingSellRecovery.js');
const TELEGRAM_NOTIFIER_SRC = readSrc('src/services/telegramNotifier.js');
const BINANCE_REST_SRC = readSrc('src/binance/binanceRest.js');

describe('FIX-2026-09-17 waiting_sell_recovery scheduler wiring', () => {
  describe('AppConfig schema', () => {
    test('declares waitingSellRecoveryEnabled (default true — auto-recover)', () => {
      expect(APP_CONFIG_SRC).toMatch(
        /waitingSellRecoveryEnabled\s*:\s*\{\s*type\s*:\s*Boolean\s*,\s*default\s*:\s*true\s*\}/
      );
    });

    test('declares waitingSellRecoveryIntervalMs default 4h with 1h..24h range', () => {
      expect(APP_CONFIG_SRC).toMatch(
        /waitingSellRecoveryIntervalMs\s*:\s*\{\s*type\s*:\s*Number[\s\S]*?default\s*:\s*4\s*\*\s*60\s*\*\s*60\s*\*\s*1000/s
      );
      expect(APP_CONFIG_SRC).toMatch(
        /waitingSellRecoveryIntervalMs[\s\S]*?min\s*:\s*1\s*\*\s*60\s*\*\s*60\s*\*\s*1000[\s\S]*?max\s*:\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/s
      );
    });

    test('declares waitingSellRecoveryLastStats + LastRunAt + LastError telemetry', () => {
      expect(APP_CONFIG_SRC).toMatch(/waitingSellRecoveryLastStats\s*:\s*\{\s*type\s*:\s*Object\s*,\s*default\s*:\s*null\s*\}/);
      expect(APP_CONFIG_SRC).toMatch(/waitingSellRecoveryLastRunAt\s*:\s*\{\s*type\s*:\s*Date\s*,\s*default\s*:\s*null\s*\}/);
      expect(APP_CONFIG_SRC).toMatch(/waitingSellRecoveryLastError\s*:\s*\{\s*type\s*:\s*String\s*,\s*default\s*:\s*null\s*\}/);
    });
  });

  describe('admin.routes whitelist', () => {
    test('accepts waitingSellRecoveryEnabled + waitingSellRecoveryIntervalMs', () => {
      expect(ADMIN_ROUTES_SRC).toMatch(/waitingSellRecoveryEnabled\s*:\s*'boolean'/);
      expect(ADMIN_ROUTES_SRC).toMatch(/waitingSellRecoveryIntervalMs\s*:\s*'number'/);
    });

    test('clamps waitingSellRecoveryIntervalMs to 1h..24h', () => {
      // Find the clamp block — Math.max(3600000, Math.min(86400000, ...))
      expect(ADMIN_ROUTES_SRC).toMatch(
        /if\s*\(\s*set\.waitingSellRecoveryIntervalMs\s*!=\s*null\s*\)\s*\{[\s\S]{0,200}?Math\.min\(\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/s
      );
    });
  });

  describe('server.js start/stop wiring', () => {
    test('requires waitingSellRecovery service', () => {
      expect(SERVER_SRC).toMatch(/require\(['"]\.\/services\/waitingSellRecovery['"]\)/);
    });

    test('calls waitingSellRecovery.start() during boot', () => {
      expect(SERVER_SRC).toMatch(/waitingSellRecovery\.start\s*\(\s*\)/);
    });

    test('calls waitingSellRecovery.stop() during shutdown', () => {
      expect(SERVER_SRC).toMatch(/waitingSellRecovery\.stop\s*\(\s*\)/);
    });
  });

  describe('waitingSellRecovery.js service structure', () => {
    test('exports singleton + WaitingSellRecovery class', () => {
      expect(WSR_SRC).toMatch(/module\.exports\s*=\s*_instance/);
      expect(WSR_SRC).toMatch(/module\.exports\.WaitingSellRecovery\s*=\s*WaitingSellRecovery/);
    });

    test('has start()/stop() with jitter ±25%', () => {
      expect(WSR_SRC).toMatch(/setInterval\s*\(\s*\(\s*\)\s*=>\s*this\._tickSafe\s*\(\s*\)\s*,\s*jitteredInterval\s*\)/);
      expect(WSR_SRC).toMatch(/Math\.random\(\)\s*\*\s*2\s*-\s*1\s*\)\s*\*\s*0\.25/);
    });

    test('queries state=\'waiting_sell_recovery\' trades', () => {
      expect(WSR_SRC).toMatch(/Trade\.find\(\s*\{\s*state\s*:\s*['"]waiting_sell_recovery['"]\s*\}/);
    });

    test('places LIMIT_MAKER SELL with proper price/qty rounding', () => {
      expect(WSR_SRC).toMatch(/side\s*:\s*['"]SELL['"][\s\S]*?type\s*:\s*['"]LIMIT_MAKER['"][\s\S]*?quantity\s*:\s*sellQty[\s\S]*?price\s*:\s*sellPx/s);
    });

    test('emits eventBus waitingSellRecovery:placed on success', () => {
      expect(WSR_SRC).toMatch(/eventBus\.emit\(\s*['"]waitingSellRecovery:placed['"]/);
    });

    test('updates DB with atomic state guard (waiting_sell_recovery → selling)', () => {
      expect(WSR_SRC).toMatch(
        /Trade\.updateOne\(\s*\{\s*_id\s*:\s*t\._id\s*,\s*state\s*:\s*['"]waiting_sell_recovery['"][\s\S]*?state\s*:\s*['"]selling['"]/s
      );
    });

    test('handles race (cancel orphan SELL when DB already moved)', () => {
      expect(WSR_SRC).toMatch(/updateRes\.modifiedCount\s*===\s*0/);
      expect(WSR_SRC).toMatch(/cancelOrder\(\s*\{\s*symbol\s*,\s*orderId\s*:\s*sellResult\.orderId\s*\}/);
    });

    test('PRICE_FILTER check: target > market × 1.20 → skip', () => {
      expect(WSR_SRC).toMatch(/PRICE_FILTER_MULTIPLIER\s*=\s*1\.20/);
      expect(WSR_SRC).toMatch(/return\s+['"]price_filter_fail['"]/);
    });

    test('uses correct getBookTicker signature (string symbol)', () => {
      // Mirror recover-orphan-positions-v3.js fix — passing object returns 0
      expect(WSR_SRC).toMatch(/binanceRest\.getBookTicker\(\s*symbol\s*\)/);
      expect(WSR_SRC).not.toMatch(/getBookTicker\(\s*\{\s*symbol/);
    });

    test('persists telemetry to AppConfig', () => {
      expect(WSR_SRC).toMatch(/waitingSellRecoveryLastRunAt/);
      expect(WSR_SRC).toMatch(/waitingSellRecoveryLastStats/);
      expect(WSR_SRC).toMatch(/waitingSellRecoveryLastError/);
    });

    test('transitions dust-trades to dust_skipped when SELL value < minNotional', () => {
      expect(WSR_SRC).toMatch(/state\s*:\s*['"]dust_skipped['"]/);
    });
  });

  describe('telegramNotifier wiring', () => {
    test('has renderMessage case for waitingSellRecoveryPlaced', () => {
      expect(TELEGRAM_NOTIFIER_SRC).toMatch(/case\s+['"]waitingSellRecoveryPlaced['"]\s*:/);
    });

    test('has eventBus listener for waitingSellRecovery:placed', () => {
      expect(TELEGRAM_NOTIFIER_SRC).toMatch(
        /eventBus\.on\(\s*['"]waitingSellRecovery:placed['"][\s\S]*?dispatch\(\s*['"]waitingSellRecoveryPlaced['"]/s
      );
    });
  });

  describe('_evaluate pure helper (unit tests)', () => {
    // Import the service module to test the static _evaluate method
    let WaitingSellRecovery;
    beforeAll(() => {
      // Mock the dependencies that the service requires on load
      jest.doMock('../src/db/models/Trade', () => ({ find: jest.fn(), updateOne: jest.fn() }));
      jest.doMock('../src/db/models/AppConfig', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
      jest.doMock('../src/binance/binanceRest', () => ({
        getBookTicker: jest.fn(), newOrder: jest.fn(), getOpenOrders: jest.fn(),
        cancelOrder: jest.fn(), getAccount: jest.fn(),
      }));
      jest.doMock('../src/binance/symbolInfo', () => ({ loadSymbol: jest.fn() }));
      jest.doMock('../src/services/eventBus', () => ({ emit: jest.fn() }));
      WaitingSellRecovery = require('../src/services/waitingSellRecovery').WaitingSellRecovery;
    });

    const baseTrade = {
      waitingTargetPrice: 0.10,
      buyFilledQty: 100,
    };

    test('returns null when target is within PRICE_FILTER range and SELL value >= minNotional', () => {
      const ctx = { currentMarketPrice: 0.09, sellQty: 100, minNotional: 5, stepSize: 1, tickSize: 0.0001 };
      // 0.10 ≤ 0.09 × 1.20 = 0.108 → passes; 0.10 × 100 = 10 ≥ 5 → passes
      expect(WaitingSellRecovery._evaluate(baseTrade, ctx)).toBeNull();
    });

    test('returns price_filter_fail when target > market × 1.20', () => {
      const ctx = { currentMarketPrice: 0.07, sellQty: 100, minNotional: 5, stepSize: 1, tickSize: 0.0001 };
      // 0.10 > 0.07 × 1.20 = 0.084 → fail
      expect(WaitingSellRecovery._evaluate(baseTrade, ctx)).toBe('price_filter_fail');
    });

    test('returns dust_skip when SELL value < minNotional', () => {
      const ctx = { currentMarketPrice: 0.09, sellQty: 1, minNotional: 5, stepSize: 1, tickSize: 0.0001 };
      // 0.10 ≤ 0.09 × 1.20 = 0.108 → passes filter; 0.10 × 1 = 0.10 < 5 → dust
      expect(WaitingSellRecovery._evaluate(baseTrade, ctx)).toBe('dust_skip');
    });

    test('returns no_market_price when currentMarketPrice <= 0', () => {
      const ctx = { currentMarketPrice: 0, sellQty: 100, minNotional: 5, stepSize: 1, tickSize: 0.0001 };
      expect(WaitingSellRecovery._evaluate(baseTrade, ctx)).toBe('no_market_price');
    });

    test('returns no_target when waitingTargetPrice is 0', () => {
      const ctx = { currentMarketPrice: 0.10, sellQty: 100, minNotional: 5, stepSize: 1, tickSize: 0.0001 };
      expect(WaitingSellRecovery._evaluate({ waitingTargetPrice: 0, buyFilledQty: 100 }, ctx)).toBe('no_target');
    });

    test('boundary: target exactly at market × 1.20 passes (≤)', () => {
      const trade = { waitingTargetPrice: 0.12, buyFilledQty: 100 };
      const ctx = { currentMarketPrice: 0.10, sellQty: 100, minNotional: 5, stepSize: 1, tickSize: 0.0001 };
      // 0.12 ≤ 0.10 × 1.20 = 0.12 → passes (boundary)
      expect(WaitingSellRecovery._evaluate(trade, ctx)).toBeNull();
    });
  });
});
