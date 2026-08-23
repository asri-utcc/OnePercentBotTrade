'use strict';

/**
 * 2026-08-22: Unit tests for src/services/walletSnapshot.js
 *
 *   - ไม่ต้องใช้ MongoDB — mock require('../src/db/models/WalletSnapshot') + AppConfig
 *   - ครอบคลุม:
 *     - bkkDateKey() produces correct YYYY-MM-DD for BKK tz
 *     - nextMidnightDelayMs() produces sane delay (positive, < 24h)
 *     - runOnce() writes to WalletSnapshot (upsert)
 *     - runOnce() is idempotent (re-running same day = upsert, no new doc)
 *     - runOnce() returns ok:false when in-flight
 *     - runOnce() returns ok:false when snapshotWallet throws
 *     - stop() halts scheduler
 *     - start() schedules next run (no throw)
 *     - getStatus() reflects running state
 */

const path = require('path');

// ─── Mocks ────────────────────────────────────────────────────────────────
const mockStore = {
  docs: new Map(), // dateKey → doc
  upsertCalls: 0,
  findOneCalls: 0,
  throwOnUpsert: false,
};

jest.mock('../src/db/models/WalletSnapshot', () => {
  return {
    findOneAndUpdate: jest.fn((filter, update, opts) => {
      mockStore.upsertCalls += 1;
      if (mockStore.throwOnUpsert) return Promise.reject(new Error('mock upsert fail'));
      const key = filter.dateKey;
      const existing = mockStore.docs.get(key);
      const newDoc = {
        dateKey: key,
        snapshotAt: update.$set.snapshotAt,
        totalUsdt: update.$set.totalUsdt,
        totalThb: update.$set.totalThb,
        fxRate: update.$set.fxRate,
        coinCount: update.$set.coinCount,
        holdings: update.$set.holdings,
        source: update.$set.source,
      };
      mockStore.docs.set(key, newDoc);
      return Promise.resolve(newDoc);
    }),
    // chainable findOne: must support .lean() (called by walletSnapshot._ensureTodayThenSchedule)
    findOne: jest.fn((filter) => {
      const q = {
        _filter: filter,
        lean: () => {
          mockStore.findOneCalls += 1;
          const doc = mockStore.docs.get(filter.dateKey);
          return Promise.resolve(doc ? { ...doc } : null);
        },
        // also support await directly (return promise) — some callers do `await Model.findOne(...)`
        then: (resolve, reject) => {
          mockStore.findOneCalls += 1;
          const doc = mockStore.docs.get(filter.dateKey);
          try { resolve(doc ? { ...doc } : null); }
          catch (e) { if (reject) reject(e); }
        },
      };
      return q;
    }),
  };
});

jest.mock('../src/db/models/AppConfig', () => ({
  findOne: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('../src/binance/binanceRest', () => ({
  get24hrTickers: jest.fn(() => Promise.resolve([
    { symbol: 'BTCUSDT', lastPrice: '60000' },
    { symbol: 'ETHUSDT', lastPrice: '3000' },
    { symbol: 'BNBUSDT', lastPrice: '600' },
  ])),
  getAccount: jest.fn(() => Promise.resolve({
    balances: [
      { asset: 'USDT', free: '100.5', locked: '0' },
      { asset: 'BTC', free: '0.01', locked: '0' },
      { asset: 'ETH', free: '0.5', locked: '0' },
      { asset: 'BNB', free: '2.0', locked: '0' },
    ],
  })),
}));

jest.mock('../src/services/fxService', () => ({
  getUsdtToThb: jest.fn(() => Promise.resolve({ rate: 36.5, source: 'binance_p2p' })),
}));

// Now require the service under test
const walletSnapshot = require('../src/services/walletSnapshot');

beforeEach(() => {
  mockStore.docs.clear();
  mockStore.upsertCalls = 0;
  mockStore.findOneCalls = 0;
  mockStore.throwOnUpsert = false;
  // ensure scheduler not running between tests
  try { walletSnapshot.stop(); } catch (_) {}
});

// ─── bkkDateKey ──────────────────────────────────────────────────────────
describe('walletSnapshot · bkkDateKey()', () => {
  test('returns YYYY-MM-DD format for BKK tz', () => {
    const out = walletSnapshot.bkkDateKey(new Date('2026-08-22T17:30:00.000Z')); // 00:30 BKK next day
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('UTC 17:00 = BKK 00:00 next day', () => {
    // 2026-08-22 17:00 UTC = 2026-08-23 00:00 BKK
    const out = walletSnapshot.bkkDateKey(new Date('2026-08-22T17:00:00.000Z'));
    expect(out).toBe('2026-08-23');
  });

  test('UTC 16:59 = BKK 23:59 same day', () => {
    // 2026-08-22 16:59 UTC = 2026-08-22 23:59 BKK
    const out = walletSnapshot.bkkDateKey(new Date('2026-08-22T16:59:00.000Z'));
    expect(out).toBe('2026-08-22');
  });

  test('UTC 07:00 = BKK 14:00 same day', () => {
    // 2026-08-22 07:00 UTC = 2026-08-22 14:00 BKK
    const out = walletSnapshot.bkkDateKey(new Date('2026-08-22T07:00:00.000Z'));
    expect(out).toBe('2026-08-22');
  });
});

// ─── nextMidnightDelayMs ────────────────────────────────────────────────
describe('walletSnapshot · nextMidnightDelayMs()', () => {
  test('returns positive number < 24h', () => {
    const delay = walletSnapshot.nextMidnightDelayMs();
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  test('returns ~1 minute if called just before 00:00 BKK', () => {
    // 2026-08-22 16:59 UTC = 2026-08-22 23:59 BKK → ~1 minute to next 00:01 BKK
    const delay = walletSnapshot.nextMidnightDelayMs(new Date('2026-08-22T16:59:30.000Z'));
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThan(2 * 60_000); // < 2 min
  });

  test('returns ~23h 59min if called just after 00:01 BKK', () => {
    // 2026-08-22 17:02 UTC = 2026-08-23 00:02 BKK → ~23h 59min to next 00:01 BKK
    const delay = walletSnapshot.nextMidnightDelayMs(new Date('2026-08-22T17:02:00.000Z'));
    expect(delay).toBeGreaterThan(23.9 * 60 * 60_000); // > 23.9h
    expect(delay).toBeLessThan(24 * 60 * 60_000); // < 24h
  });
});

// ─── startOfTodayBkk ─────────────────────────────────────────────────────
describe('walletSnapshot · startOfTodayBkk()', () => {
  test('returns 00:00:00 of today (BKK)', () => {
    const out = walletSnapshot.startOfTodayBkk();
    expect(out).toBeInstanceOf(Date);
    // Check the BKK equivalent is midnight
    const bkkMs = out.getTime() + 7 * 60 * 60_000;
    const bkk = new Date(bkkMs);
    expect(bkk.getUTCHours()).toBe(0);
    expect(bkk.getUTCMinutes()).toBe(0);
    expect(bkk.getUTCSeconds()).toBe(0);
  });
});

// ─── snapshotWallet ──────────────────────────────────────────────────────
describe('walletSnapshot · snapshotWallet()', () => {
  test('returns aggregated portfolio value', async () => {
    const snap = await walletSnapshot.snapshotWallet();
    // USDT (100.5) + BTC (0.01 * 60000 = 600) + ETH (0.5 * 3000 = 1500) + BNB (2.0 * 600 = 1200) = 3400.5
    expect(snap.totalUsdt).toBeCloseTo(3400.5, 1);
    expect(snap.totalThb).toBeCloseTo(3400.5 * 36.5, 0);
    expect(snap.fxRate).toBe(36.5);
    expect(snap.coinCount).toBe(4);
    expect(snap.holdings.length).toBe(4);
    expect(snap.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('holdings sorted desc by valueUsdt', async () => {
    const snap = await walletSnapshot.snapshotWallet();
    for (let i = 1; i < snap.holdings.length; i++) {
      expect(snap.holdings[i - 1].valueUsdt).toBeGreaterThanOrEqual(snap.holdings[i].valueUsdt);
    }
  });
});

// ─── runOnce ─────────────────────────────────────────────────────────────
describe('walletSnapshot · runOnce()', () => {
  test('writes one snapshot for today', async () => {
    const r = await walletSnapshot.runOnce('scheduler');
    expect(r.ok).toBe(true);
    expect(r.upserted).toBe(true);
    expect(r.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mockStore.docs.size).toBe(1);
    expect(mockStore.upsertCalls).toBe(1);
  });

  test('is idempotent — second call same day updates, does not duplicate', async () => {
    await walletSnapshot.runOnce('scheduler');
    await walletSnapshot.runOnce('scheduler');
    expect(mockStore.docs.size).toBe(1);
    expect(mockStore.upsertCalls).toBe(2); // 2 upserts, but same key
  });

  test('captures totalUsdt > 0 from snapshot', async () => {
    const r = await walletSnapshot.runOnce('scheduler');
    expect(r.totalUsdt).toBeGreaterThan(0);
  });

  test('source flag is persisted', async () => {
    await walletSnapshot.runOnce('manual');
    const todayKey = walletSnapshot.bkkDateKey(new Date());
    const doc = mockStore.docs.get(todayKey);
    expect(doc.source).toBe('manual');
  });

  test('returns ok:false on upsert failure', async () => {
    mockStore.throwOnUpsert = true;
    const r = await walletSnapshot.runOnce('scheduler');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('mock upsert fail');
  });

  test('records lastRunError on failure, clears on success', async () => {
    mockStore.throwOnUpsert = true;
    await walletSnapshot.runOnce('scheduler');
    expect(walletSnapshot.getStatus().lastRunError).toBe('mock upsert fail');

    mockStore.throwOnUpsert = false;
    await walletSnapshot.runOnce('scheduler');
    expect(walletSnapshot.getStatus().lastRunError).toBe(null);
  });
});

// ─── start / stop ────────────────────────────────────────────────────────
describe('walletSnapshot · start() / stop()', () => {
  afterEach(() => {
    try { walletSnapshot.stop(); } catch (_) {}
  });

  test('start() does not throw', () => {
    expect(() => walletSnapshot.start()).not.toThrow();
  });

  test('start() sets running=true in getStatus()', () => {
    walletSnapshot.start();
    expect(walletSnapshot.getStatus().running).toBe(true);
  });

  test('stop() sets running=false', () => {
    walletSnapshot.start();
    walletSnapshot.stop();
    expect(walletSnapshot.getStatus().running).toBe(false);
  });

  test('start() twice does not throw (idempotent)', () => {
    expect(() => {
      walletSnapshot.start();
      walletSnapshot.start();
    }).not.toThrow();
  });

  test('start() backfills today if missing', async () => {
    walletSnapshot.start();
    // wait for async _ensureTodayThenSchedule
    await new Promise((r) => setTimeout(r, 100));
    // upsert should have been called at least once (today backfill)
    expect(mockStore.upsertCalls).toBeGreaterThanOrEqual(1);
  });

  test('start() skips backfill if today exists', async () => {
    // pre-insert today's snapshot
    const todayKey = walletSnapshot.bkkDateKey(new Date());
    mockStore.docs.set(todayKey, {
      dateKey: todayKey,
      snapshotAt: new Date(),
      totalUsdt: 123,
      totalThb: 123,
      coinCount: 0,
      holdings: [],
      source: 'scheduler',
    });
    walletSnapshot.start();
    await new Promise((r) => setTimeout(r, 100));
    // findOne called but no upsert (today already exists)
    expect(mockStore.findOneCalls).toBeGreaterThanOrEqual(1);
    expect(mockStore.upsertCalls).toBe(0);
  });
});

// ─── getStatus ───────────────────────────────────────────────────────────
describe('walletSnapshot · getStatus()', () => {
  test('returns lastRunAt after runOnce', async () => {
    const before = Date.now();
    await walletSnapshot.runOnce('scheduler');
    const status = walletSnapshot.getStatus();
    expect(status.lastRunAt).toBeInstanceOf(Date);
    expect(status.lastRunAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(status.lastStats).toBeTruthy();
    expect(status.lastStats.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
