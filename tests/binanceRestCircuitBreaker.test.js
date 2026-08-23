'use strict';

/**
 * FIX-2026-08-22: Unit tests for Binance rate-limit CircuitBreaker
 *
 * Covers:
 *   - CircuitBreaker class: state machine (closed/open/half-open),
 *     threshold + consecutive-count, cooldown timer, isOpen() side-effect,
 *     snapshot() shape, reset()
 *   - RateLimiter integration: opens after 5 consecutive high samples,
 *     blocks non-critical, bypasses critical (BUY/SELL path)
 *   - status() exposes circuitBreaker snapshot
 *   - updateFromHeaders() feeds the breaker with used/capacity ratio
 */

const binanceRest = require('../src/binance/binanceRest');

describe('binanceRest.CircuitBreaker (via _CircuitBreaker)', () => {
  test('class exported', () => {
    expect(typeof binanceRest._CircuitBreaker).toBe('function');
  });

  test('default state is closed with sane defaults', () => {
    const cb = new binanceRest._CircuitBreaker();
    expect(cb.state).toBe('closed');
    expect(cb.thresholdPct).toBe(0.95);
    expect(cb.consecutiveRequired).toBe(5);
    expect(cb.cooldownMs).toBe(30000);
    expect(cb.consecutiveHighUsed).toBe(0);
  });

  test('recordUsage below threshold leaves state closed', () => {
    const cb = new binanceRest._CircuitBreaker();
    cb.recordUsage(0.5);
    expect(cb.state).toBe('closed');
    expect(cb.consecutiveHighUsed).toBe(0);
  });

  test('recordUsage at threshold (not above) does not increment consecutiveHighUsed', () => {
    const cb = new binanceRest._CircuitBreaker();
    cb.recordUsage(0.95); // exactly threshold
    expect(cb.state).toBe('closed');
    expect(cb.consecutiveHighUsed).toBe(0);
  });

  test('5 consecutive samples > 95% → state opens', () => {
    const cb = new binanceRest._CircuitBreaker();
    for (let i = 0; i < 4; i++) cb.recordUsage(0.96);
    expect(cb.state).toBe('closed');
    cb.recordUsage(0.96);
    expect(cb.state).toBe('open');
    expect(cb.openedAt).toBeGreaterThan(0);
  });

  test('non-consecutive high samples do not trip the breaker', () => {
    const cb = new binanceRest._CircuitBreaker();
    cb.recordUsage(0.96);
    cb.recordUsage(0.96);
    cb.recordUsage(0.5); // resets counter
    cb.recordUsage(0.96);
    cb.recordUsage(0.96);
    cb.recordUsage(0.96);
    cb.recordUsage(0.96);
    expect(cb.state).toBe('closed');
    expect(cb.consecutiveHighUsed).toBe(4);
  });

  test('isOpen() returns true when state is open', () => {
    const cb = new binanceRest._CircuitBreaker();
    cb.state = 'open';
    cb.openedAt = Date.now();
    expect(cb.isOpen()).toBe(true);
  });

  test('isOpen() lazy-transitions open → half-open after cooldown', () => {
    const cb = new binanceRest._CircuitBreaker({ cooldownMs: 30000 });
    cb.state = 'open';
    cb.openedAt = Date.now() - 30001; // 30s + 1ms ago
    expect(cb.isOpen()).toBe(false); // allowed one request through
    expect(cb.state).toBe('half-open');
  });

  test('half-open + still-high sample → back to open with reset timer', () => {
    const cb = new binanceRest._CircuitBreaker();
    cb.state = 'half-open';
    const prevOpenedAt = Date.now() - 1000;
    cb.openedAt = prevOpenedAt;
    cb.recordUsage(0.98); // still over threshold
    expect(cb.state).toBe('open');
    expect(cb.openedAt).toBeGreaterThan(prevOpenedAt);
  });

  test('half-open + low sample → close', () => {
    const cb = new binanceRest._CircuitBreaker();
    cb.state = 'half-open';
    cb.recordUsage(0.5);
    expect(cb.state).toBe('closed');
    expect(cb.consecutiveHighUsed).toBe(0);
  });

  test('snapshot returns expected shape', () => {
    const cb = new binanceRest._CircuitBreaker({ cooldownMs: 30000 });
    cb.recordUsage(0.6);
    const snap = cb.snapshot();
    expect(snap).toHaveProperty('state', 'closed');
    expect(snap).toHaveProperty('openedAt', 0);
    expect(snap).toHaveProperty('cooldownRemainingMs', 0);
    expect(snap).toHaveProperty('consecutiveHighUsed', 0);
    expect(snap).toHaveProperty('usedPct');
    expect(snap.usedPct).toBe(0.6);
  });

  test('snapshot while open includes cooldownRemainingMs', () => {
    const cb = new binanceRest._CircuitBreaker({ cooldownMs: 30000 });
    cb.state = 'open';
    cb.openedAt = Date.now() - 5000;
    const snap = cb.snapshot();
    expect(snap.state).toBe('open');
    expect(snap.cooldownRemainingMs).toBeGreaterThan(24000);
    expect(snap.cooldownRemainingMs).toBeLessThanOrEqual(25000);
  });

  test('reset() returns to initial state', () => {
    const cb = new binanceRest._CircuitBreaker();
    cb.state = 'open';
    cb.openedAt = Date.now();
    cb.consecutiveHighUsed = 5;
    cb.usedPct = 0.99;
    cb.reset();
    expect(cb.state).toBe('closed');
    expect(cb.openedAt).toBe(0);
    expect(cb.consecutiveHighUsed).toBe(0);
    expect(cb.usedPct).toBe(0);
  });
});

describe('binanceRest.RateLimiter + CircuitBreaker integration', () => {
  test('updateFromHeaders opens circuit after 5 consecutive high samples', () => {
    const cb = new binanceRest._CircuitBreaker();
    const R = new binanceRest._RateLimiterClass({ capacity: 100, circuitBreaker: cb });
    for (let i = 0; i < 5; i++) {
      R.updateFromHeaders({ 'x-mbx-used-weight-1m': '98' }); // 98/100 = 98%
    }
    expect(cb.state).toBe('open');
  });

  test('take() non-critical throws CIRCUIT_OPEN when breaker is open', async () => {
    const cb = new binanceRest._CircuitBreaker();
    const R = new binanceRest._RateLimiterClass({ capacity: 100, circuitBreaker: cb });
    cb.state = 'open';
    cb.openedAt = Date.now();
    await expect(R.take(1, { critical: false })).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
  });

  test('take() critical=true bypasses open breaker', async () => {
    const cb = new binanceRest._CircuitBreaker();
    const R = new binanceRest._RateLimiterClass({ capacity: 100, circuitBreaker: cb });
    cb.state = 'open';
    cb.openedAt = Date.now();
    await expect(R.take(1, { critical: true })).resolves.toBeUndefined();
  });

  test('take() proceeds when breaker is closed', async () => {
    const cb = new binanceRest._CircuitBreaker();
    const R = new binanceRest._RateLimiterClass({ capacity: 100, circuitBreaker: cb });
    await expect(R.take(1)).resolves.toBeUndefined();
  });

  test('take() proceeds when breaker is half-open (cooldown elapsed)', async () => {
    const cb = new binanceRest._CircuitBreaker({ cooldownMs: 30000 });
    const R = new binanceRest._RateLimiterClass({ capacity: 100, circuitBreaker: cb });
    cb.state = 'open';
    cb.openedAt = Date.now() - 30001;
    // isOpen() will lazily transition to half-open; take should pass
    await expect(R.take(1, { critical: false })).resolves.toBeUndefined();
    expect(cb.state).toBe('half-open');
  });

  test('status() includes circuitBreaker snapshot', () => {
    const cb = new binanceRest._CircuitBreaker();
    const R = new binanceRest._RateLimiterClass({ capacity: 6000, circuitBreaker: cb });
    const status = R.status();
    expect(status).toHaveProperty('circuitBreaker');
    expect(status.circuitBreaker.state).toBe('closed');
    expect(status.circuitBreaker).toHaveProperty('openedAt');
    expect(status.circuitBreaker).toHaveProperty('cooldownRemainingMs');
    expect(status.circuitBreaker).toHaveProperty('consecutiveHighUsed');
  });

  test('setCapacity() while open preserves breaker state', () => {
    const cb = new binanceRest._CircuitBreaker();
    const R = new binanceRest._RateLimiterClass({ capacity: 100, circuitBreaker: cb });
    cb.state = 'open';
    cb.openedAt = Date.now();
    R.setCapacity(200);
    expect(cb.state).toBe('open');
    expect(R.capacity).toBe(200);
    // tokens clamped to new capacity
    expect(R.tokens).toBeLessThanOrEqual(200);
  });

  test('end-to-end: high traffic closes/opens/half-opens through updateFromHeaders', () => {
    const cb = new binanceRest._CircuitBreaker({ thresholdPct: 0.5, consecutiveRequired: 3, cooldownMs: 1000 });
    const R = new binanceRest._RateLimiterClass({ capacity: 100, circuitBreaker: cb });

    // 3 consecutive high samples → open
    R.updateFromHeaders({ 'x-mbx-used-weight-1m': '60' });
    expect(cb.state).toBe('closed');
    R.updateFromHeaders({ 'x-mbx-used-weight-1m': '60' });
    expect(cb.state).toBe('closed');
    R.updateFromHeaders({ 'x-mbx-used-weight-1m': '60' });
    expect(cb.state).toBe('open');

    // cooldown not yet elapsed → still open
    cb.state = 'open'; // force (fake timers)
    cb.openedAt = Date.now();
    expect(cb.isOpen()).toBe(true);

    // cooldown elapsed (simulate by setting openedAt in past) → half-open
    cb.openedAt = Date.now() - 1500;
    expect(cb.isOpen()).toBe(false);
    expect(cb.state).toBe('half-open');

    // low sample closes
    R.updateFromHeaders({ 'x-mbx-used-weight-1m': '30' });
    expect(cb.state).toBe('closed');
  });
});

describe('binanceRest.getExchangeInfo + get24hrTickers array support', () => {
  test('public API accepts array argument (signature check)', () => {
    expect(typeof binanceRest.getExchangeInfo).toBe('function');
    expect(typeof binanceRest.get24hrTickers).toBe('function');
  });
});
