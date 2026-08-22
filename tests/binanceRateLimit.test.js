'use strict';

/**
 * FIX-2026-08-21: Unit tests for Binance rate-limit dynamic capacity feature
 *
 * Covers:
 *   - binanceRateLimitConfig: clamp, defaults, cache lifecycle
 *   - binanceRest.RateLimiter: setCapacity updates in-place, preserves tokens,
 *     updateFromHeaders clamps to current capacity, status() shape
 *   - binanceRest.setRateLimitCapacity: rejects invalid input, applies valid
 *
 * No MongoDB needed — pure in-process logic + mocked AppConfig.
 */

// ─── binanceRateLimitConfig: clamp + constants ──────────────────
const rateLimitConfig = require('../src/services/binanceRateLimitConfig');

describe('binanceRateLimitConfig — constants & clamp', () => {
  test('exports sane defaults', () => {
    expect(rateLimitConfig.DEFAULT_VALUE).toBe(6000);
    expect(rateLimitConfig.MIN_VALUE).toBe(500);
    expect(rateLimitConfig.MAX_VALUE).toBe(120000);
    expect(rateLimitConfig.CACHE_MS).toBeGreaterThan(0);
  });

  test('clamp: in-range value passes through', () => {
    expect(rateLimitConfig._clamp(3000)).toBe(3000);
    expect(rateLimitConfig._clamp(60000)).toBe(60000);
  });
  test('clamp: below MIN_VALUE → MIN_VALUE', () => {
    expect(rateLimitConfig._clamp(100)).toBe(500);
    expect(rateLimitConfig._clamp(0)).toBe(500);
  });
  test('clamp: above MAX_VALUE → MAX_VALUE', () => {
    expect(rateLimitConfig._clamp(200000)).toBe(120000);
  });
  test('clamp: NaN / non-finite → DEFAULT_VALUE', () => {
    expect(rateLimitConfig._clamp(NaN)).toBe(6000);
    expect(rateLimitConfig._clamp(undefined)).toBe(6000);
    expect(rateLimitConfig._clamp(null)).toBe(6000);
    expect(rateLimitConfig._clamp('abc')).toBe(6000);
  });
  test('clamp: rounds to nearest int', () => {
    expect(rateLimitConfig._clamp(1234.7)).toBe(1235);
    expect(rateLimitConfig._clamp(1234.3)).toBe(1234);
  });
});

describe('binanceRateLimitConfig — cache lifecycle', () => {
  beforeEach(() => {
    rateLimitConfig.invalidateCache(); // reset between tests
  });

  test('invalidateCache() resets to default age=0', () => {
    rateLimitConfig.invalidateCache(9000);
    const info = rateLimitConfig.cacheInfo();
    expect(info.value).toBe(9000);
    rateLimitConfig.invalidateCache(); // without arg
    const info2 = rateLimitConfig.cacheInfo();
    expect(info2.value).toBe(6000);
    expect(info2.at).toBe(0);
  });

  test('invalidateCache(value) primes cache', () => {
    rateLimitConfig.invalidateCache(2500);
    expect(rateLimitConfig.cacheInfo().value).toBe(2500);
    expect(rateLimitConfig.cacheInfo().at).toBeGreaterThan(0);
  });

  test('getBinanceRateLimit() reads from Mongo and caches result', async () => {
    // Mock AppConfig.findOne to return a doc without hitting Mongo
    const AppConfig = require('../src/db/models/AppConfig');
    const spy = jest.spyOn(AppConfig, 'findOne').mockReturnValue({
      lean: () => Promise.resolve({ binanceRateLimitPerMin: 1500 }),
    });
    rateLimitConfig.invalidateCache(); // start fresh
    const v = await rateLimitConfig.getBinanceRateLimit({ forceRefresh: true });
    expect(v).toBe(1500);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('getBinanceRateLimit() reads from cache on 2nd call within CACHE_MS', async () => {
    const AppConfig = require('../src/db/models/AppConfig');
    const spy = jest.spyOn(AppConfig, 'findOne').mockReturnValue({
      lean: () => Promise.resolve({ binanceRateLimitPerMin: 2750 }),
    });
    rateLimitConfig.invalidateCache();
    const v1 = await rateLimitConfig.getBinanceRateLimit({ forceRefresh: true });
    const v2 = await rateLimitConfig.getBinanceRateLimit(); // should NOT call Mongo
    expect(v1).toBe(2750);
    expect(v2).toBe(2750);
    expect(spy).toHaveBeenCalledTimes(1); // only the forced call
    spy.mockRestore();
  });

  test('getBinanceRateLimit() uses DEFAULT_VALUE when config has no field (legacy DB)', async () => {
    const AppConfig = require('../src/db/models/AppConfig');
    const spy = jest.spyOn(AppConfig, 'findOne').mockReturnValue({
      lean: () => Promise.resolve({ key: 'singleton' }), // missing binanceRateLimitPerMin
    });
    rateLimitConfig.invalidateCache();
    const v = await rateLimitConfig.getBinanceRateLimit({ forceRefresh: true });
    expect(v).toBe(6000);
    spy.mockRestore();
  });

  test('getBinanceRateLimit() returns cached value on Mongo error', async () => {
    const AppConfig = require('../src/db/models/AppConfig');
    const spy = jest.spyOn(AppConfig, 'findOne').mockReturnValue({
      lean: () => Promise.reject(new Error('mongo down')),
    });
    rateLimitConfig.invalidateCache(4500); // pre-seeded
    const v = await rateLimitConfig.getBinanceRateLimit({ forceRefresh: true });
    expect(v).toBe(4500); // falls back to cached value
    spy.mockRestore();
  });
});

// ─── binanceRest: RateLimiter class ─────────────────────────────
const binanceRest = require('../src/binance/binanceRest');

describe('binanceRest.RateLimiter (via _RateLimiterClass)', () => {
  test('class exported', () => {
    expect(typeof binanceRest._RateLimiterClass).toBe('function');
  });

  test('default capacity = 6000, refillRate = 0.1', () => {
    const R = new binanceRest._RateLimiterClass();
    expect(R.capacity).toBe(6000);
    expect(R.refillRate).toBeCloseTo(6000 / 60000, 6);
    expect(R.tokens).toBe(6000);
  });

  test('setCapacity() updates capacity AND refillRate', () => {
    const R = new binanceRest._RateLimiterClass();
    R.setCapacity(3000);
    expect(R.capacity).toBe(3000);
    expect(R.refillRate).toBeCloseTo(3000 / 60000, 6);
  });

  test('setCapacity() rejects invalid (non-positive / non-finite)', () => {
    const R = new binanceRest._RateLimiterClass();
    const orig = R.capacity;
    R.setCapacity(0);        expect(R.capacity).toBe(orig);
    R.setCapacity(-100);     expect(R.capacity).toBe(orig);
    R.setCapacity(NaN);      expect(R.capacity).toBe(orig);
    R.setCapacity(Infinity); expect(R.capacity).toBe(orig);
  });

  test('setCapacity() no-op when same value', () => {
    // We can't directly assert no-op but confirm it doesn't break invariants
    const R = new binanceRest._RateLimiterClass();
    R.setCapacity(6000);
    expect(R.capacity).toBe(6000);
  });

  test('setCapacity() reduces tokens when shrinking', () => {
    const R = new binanceRest._RateLimiterClass();
    // simulate low tokens by reducing capacity drastically
    R.setCapacity(500);
    expect(R.tokens).toBeLessThanOrEqual(500);
    expect(R.tokens).toBeGreaterThanOrEqual(0);
  });

  test('setCapacity() preserves tokens when growing', () => {
    const R = new binanceRest._RateLimiterClass();
    R.tokens = 100; // simulate used budget
    R.setCapacity(60000);
    expect(R.tokens).toBe(100); // unchanged
    expect(R.capacity).toBe(60000);
  });

  test('updateFromHeaders() uses current capacity (not hardcoded 6000)', () => {
    const R = new binanceRest._RateLimiterClass();
    R.setCapacity(3000);
    R.updateFromHeaders({ 'x-mbx-used-weight-1m': '2500' });
    // tokens = max(0, capacity - used) = max(0, 3000 - 2500) = 500
    expect(R.tokens).toBe(500);
  });

  test('updateFromHeaders() clamps used to new lower capacity', () => {
    const R = new binanceRest._RateLimiterClass();
    // simulate we already have used budget ~5000 (above new capacity)
    R.setCapacity(3000);
    R.updateFromHeaders({ 'x-mbx-used-weight-1m': '5000' });
    // tokens = max(0, 3000 - 5000) = 0  (clamped)
    expect(R.tokens).toBe(0);
  });

  test('status() returns the right shape', () => {
    const R = new binanceRest._RateLimiterClass();
    const s = R.status();
    expect(s).toEqual(expect.objectContaining({
      capacity: expect.any(Number),
      refillRate: expect.any(Number),
      tokens: expect.any(Number),
      usedEstimated: expect.any(Number),
      lastRefill: expect.any(Number),
      banUntilMs: expect.any(Number),
      banRemainingSec: expect.any(Number),
    }));
    expect(s.usedEstimated).toBeGreaterThanOrEqual(0);
    expect(s.banUntilMs).toBe(0);
    expect(s.banRemainingSec).toBe(0);
  });

  // ─── FIX-2026-08-22: 418 IP-ban gate ────────────────────────
  describe('FIX-2026-08-22: 418 IP-ban gate (setBanUntil / take / status)', () => {
    test('default banUntilMs = 0 (no ban)', () => {
      const R = new binanceRest._RateLimiterClass();
      expect(R.banUntilMs).toBe(0);
      const s = R.status();
      expect(s.banUntilMs).toBe(0);
      expect(s.banRemainingSec).toBe(0);
    });

    test('setBanUntil() accepts future epoch ms and updates banUntilMs', () => {
      const R = new binanceRest._RateLimiterClass();
      const futureMs = Date.now() + 60_000;
      const ok = R.setBanUntil(futureMs);
      expect(ok).toBe(true);
      expect(R.banUntilMs).toBe(futureMs);
    });

    test('setBanUntil() rejects invalid (NaN, Infinity, past timestamp)', () => {
      const R = new binanceRest._RateLimiterClass();
      expect(R.setBanUntil(NaN)).toBe(false);
      expect(R.setBanUntil(Infinity)).toBe(false);
      expect(R.setBanUntil(Date.now() - 1000)).toBe(false);
      expect(R.banUntilMs).toBe(0);
    });

    test('setBanUntil() max wins (later expiry overrides earlier)', () => {
      const R = new binanceRest._RateLimiterClass();
      const t1 = Date.now() + 10_000;
      const t2 = Date.now() + 30_000;
      R.setBanUntil(t1);
      R.setBanUntil(t2);
      expect(R.banUntilMs).toBe(t2);
    });

    test('setBanUntil() shorter expiry does NOT override longer one', () => {
      const R = new binanceRest._RateLimiterClass();
      const t1 = Date.now() + 60_000;
      const t2 = Date.now() + 10_000;
      R.setBanUntil(t1);
      const ok = R.setBanUntil(t2);
      expect(ok).toBe(false);
      expect(R.banUntilMs).toBe(t1); // unchanged
    });

    test('clearBan() resets banUntilMs to 0', () => {
      const R = new binanceRest._RateLimiterClass();
      R.setBanUntil(Date.now() + 60_000);
      R.clearBan();
      expect(R.banUntilMs).toBe(0);
    });

    test('take() waits when ban is active, then resumes', async () => {
      const R = new binanceRest._RateLimiterClass({ capacity: 6000 });
      // ban for 200ms
      const banMs = Date.now() + 200;
      R.setBanUntil(banMs);
      const t0 = Date.now();
      await R.take(1);
      const elapsed = Date.now() - t0;
      // Should have waited at least ~150ms (allow some slack)
      expect(elapsed).toBeGreaterThanOrEqual(150);
      // Ban should now be cleared (auto-expire)
      expect(R.banUntilMs).toBe(0);
    });

    test('take() returns immediately when no ban is active', async () => {
      const R = new binanceRest._RateLimiterClass({ capacity: 6000 });
      const t0 = Date.now();
      await R.take(1);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(50);
    });

    test('status() reports remaining seconds correctly during ban', () => {
      const R = new binanceRest._RateLimiterClass();
      const futureMs = Date.now() + 45_000;
      R.setBanUntil(futureMs);
      const s = R.status();
      expect(s.banUntilMs).toBe(futureMs);
      expect(s.banRemainingSec).toBeGreaterThanOrEqual(44);
      expect(s.banRemainingSec).toBeLessThanOrEqual(45);
    });
  });
});

// ─── binanceRest: setRateLimitCapacity() and getRateLimitStatus() ──
describe('binanceRest.setRateLimitCapacity / getRateLimitStatus', () => {
  test('exports the singleton function + status', () => {
    expect(typeof binanceRest.setRateLimitCapacity).toBe('function');
    expect(typeof binanceRest.getRateLimitStatus).toBe('function');
  });

  test('setRateLimitCapacity() rejects non-positive', () => {
    const r1 = binanceRest.setRateLimitCapacity(-1);
    const r2 = binanceRest.setRateLimitCapacity(0);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });

  test('setRateLimitCapacity() applies a valid value', async () => {
    const res = await binanceRest.setRateLimitCapacity(4500);
    expect(res.ok).toBe(true);
    expect(res.capacity).toBe(4500);
    const status = binanceRest.getRateLimitStatus();
    expect(status.capacity).toBe(4500);
    // restore for other tests
    await binanceRest.setRateLimitCapacity(6000);
  });

  test('getRateLimitStatus() returns live snapshot', () => {
    const s = binanceRest.getRateLimitStatus();
    expect(s.capacity).toBeGreaterThan(0);
    expect(s.refillRate).toBeCloseTo(s.capacity / 60000, 4);
  });
});
