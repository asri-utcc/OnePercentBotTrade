'use strict';

/**
 * 2026-08-19: Unit tests for src/services/walletReserve.js
 *
 *   - ไม่ต้องใช้ MongoDB — mock require('../src/db/models/AppConfig') แทน
 *   - ครอบคลุม:
 *     - getReserveUsdt() returns AppConfig.walletReserveUsdt value
 *     - returns 0 when AppConfig missing
 *     - returns 0 when AppConfig throws (DB hiccup)
 *     - returns 0 when value is negative
 *     - returns MAX_RESERVE when value > MAX (clamps)
 *     - cache hit within 10s (DB only queried once)
 *     - cache miss after invalidateCache()
 *     - concurrent reads share single DB query (in-flight de-dup)
 */

const path = require('path');

// Mock AppConfig BEFORE requiring walletReserve
const mockAppConfig = {
  _value: 0,
  _throwOnFindOne: false,
  _findOneCallCount: 0,
};
jest.mock('../src/db/models/AppConfig', () => {
  return {
    findOne: jest.fn(() => {
      mockAppConfig._findOneCallCount += 1;
      if (mockAppConfig._throwOnFindOne) {
        return Promise.reject(new Error('mock DB hiccup'));
      }
      if (mockAppConfig._value === 'missing') return Promise.resolve(null);
      return Promise.resolve({ key: 'singleton', walletReserveUsdt: mockAppConfig._value });
    }),
  };
});

// Now require the service under test
const walletReserve = require('../src/services/walletReserve');

beforeEach(() => {
  // reset cache + mock state between tests
  walletReserve.invalidateCache();
  mockAppConfig._value = 0;
  mockAppConfig._throwOnFindOne = false;
  mockAppConfig._findOneCallCount = 0;
});

describe('walletReserve · DEFAULTS / EXPORTS', () => {
  test('MAX_RESERVE = 1,000,000 USDT (sanity ceiling)', () => {
    expect(walletReserve.MAX_RESERVE).toBe(1_000_000);
  });

  test('CACHE_TTL_MS = 10s', () => {
    expect(walletReserve.CACHE_TTL_MS).toBe(10_000);
  });
});

describe('walletReserve · getReserveUsdt()', () => {
  test('returns 0 when AppConfig value is 0 (default)', async () => {
    mockAppConfig._value = 0;
    const r = await walletReserve.getReserveUsdt();
    expect(r).toBe(0);
  });

  test('returns the AppConfig value when set', async () => {
    mockAppConfig._value = 50;
    const r = await walletReserve.getReserveUsdt();
    expect(r).toBe(50);
  });

  test('returns 0 when AppConfig document missing (returns null)', async () => {
    mockAppConfig._value = 'missing';
    const r = await walletReserve.getReserveUsdt();
    expect(r).toBe(0);
  });

  test('returns 0 when AppConfig.findOne() throws (DB hiccup)', async () => {
    mockAppConfig._throwOnFindOne = true;
    const r = await walletReserve.getReserveUsdt();
    expect(r).toBe(0);
  });

  test('returns 0 when value is negative (defensive clamp)', async () => {
    mockAppConfig._value = -10;
    const r = await walletReserve.getReserveUsdt();
    expect(r).toBe(0);
  });

  test('clamps to MAX_RESERVE when value above ceiling', async () => {
    mockAppConfig._value = 999_999_999;
    const r = await walletReserve.getReserveUsdt();
    expect(r).toBe(walletReserve.MAX_RESERVE);
  });

  test('treats non-finite values (NaN/Infinity) as 0', async () => {
    mockAppConfig._value = NaN;
    expect(await walletReserve.getReserveUsdt()).toBe(0);
    walletReserve.invalidateCache();
    mockAppConfig._value = Infinity;
    expect(await walletReserve.getReserveUsdt()).toBe(0);
    walletReserve.invalidateCache();
    mockAppConfig._value = null;
    expect(await walletReserve.getReserveUsdt()).toBe(0);
  });
});

describe('walletReserve · cache behavior', () => {
  test('two consecutive reads share a single DB query (cache hit within 10s)', async () => {
    mockAppConfig._value = 25;
    await walletReserve.getReserveUsdt();
    await walletReserve.getReserveUsdt();
    await walletReserve.getReserveUsdt();
    expect(mockAppConfig._findOneCallCount).toBe(1);
  });

  test('invalidateCache() forces next read to re-query DB', async () => {
    mockAppConfig._value = 10;
    await walletReserve.getReserveUsdt();
    expect(mockAppConfig._findOneCallCount).toBe(1);

    walletReserve.invalidateCache();
    await walletReserve.getReserveUsdt();
    expect(mockAppConfig._findOneCallCount).toBe(2);
  });

  test('concurrent reads share the in-flight DB query (de-dup)', async () => {
    mockAppConfig._value = 75;
    const [r1, r2, r3, r4] = await Promise.all([
      walletReserve.getReserveUsdt(),
      walletReserve.getReserveUsdt(),
      walletReserve.getReserveUsdt(),
      walletReserve.getReserveUsdt(),
    ]);
    expect([r1, r2, r3, r4]).toEqual([75, 75, 75, 75]);
    expect(mockAppConfig._findOneCallCount).toBe(1);
  });

  test('cache survives through TTL window but resets on invalidateCache', async () => {
    mockAppConfig._value = 33;
    const first = await walletReserve.getReserveUsdt();
    expect(first).toBe(33);
    // Change DB value but cache should still return old value
    mockAppConfig._value = 99;
    const second = await walletReserve.getReserveUsdt();
    expect(second).toBe(33);
    expect(mockAppConfig._findOneCallCount).toBe(1);

    // invalidate → next read sees new value
    walletReserve.invalidateCache();
    const third = await walletReserve.getReserveUsdt();
    expect(third).toBe(99);
    expect(mockAppConfig._findOneCallCount).toBe(2);
  });

  test('does not cache the failure path — next read retries DB', async () => {
    mockAppConfig._throwOnFindOne = true;
    const first = await walletReserve.getReserveUsdt();
    expect(first).toBe(0);
    // second read should also retry (DB call count = 2, not 1)
    mockAppConfig._throwOnFindOne = false;
    mockAppConfig._value = 42;
    const second = await walletReserve.getReserveUsdt();
    expect(second).toBe(42);
    expect(mockAppConfig._findOneCallCount).toBe(2);
  });
});

describe('walletReserve · integration scenarios', () => {
  test('typical flow: set 50 → next trader call sees 50', async () => {
    mockAppConfig._value = 50;
    const r = await walletReserve.getReserveUsdt();
    expect(r).toBe(50);
    // simulate user setting it to 0
    walletReserve.invalidateCache();
    mockAppConfig._value = 0;
    const r2 = await walletReserve.getReserveUsdt();
    expect(r2).toBe(0);
  });

  test('100 USDT reserve with fractional rounding (floor)', async () => {
    mockAppConfig._value = 99.7;
    const r = await walletReserve.getReserveUsdt();
    // returns the raw number (no rounding here — UI handles floor display)
    expect(r).toBe(99.7);
  });
});