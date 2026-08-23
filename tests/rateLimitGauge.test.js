'use strict';

/**
 * FIX-2026-08-23: Tests for the live Binance API weight gauge
 *
 * Covers:
 *   • GET /api/system/rate-limit returns the live snapshot shape
 *   • capacity / tokens / usedEstimated / usedPct derived correctly
 *   • circuitBreaker sub-object is forwarded (state, usedPct, cooldownRemainingMs)
 *   • banRemainingSec surfaces when 418 timer is active
 *   • healthMonitor._tick() emits 'rateLimit:update' on EventBus with payload
 *   • EVENTS_TO_FORWARD in dashboardWs.js includes 'rateLimit:update'
 *   • healthMonitor tick is resilient if getRateLimitStatus throws
 *
 * No MongoDB needed — pure in-process logic + mocked binanceRest.
 */

const express = require('express');
const http = require('http');

// ─── Mocks ────────────────────────────────────────────────────────────────
const mockGetRateLimitStatus = jest.fn();

jest.mock('../src/binance/binanceRest', () => ({
  getRateLimitStatus: mockGetRateLimitStatus,
}));

// Mock auth middleware so the route handler runs in tests
jest.mock('../src/api/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
}));

const rateLimitRouter = require('../src/api/routes/rateLimit.routes');

// ─── Tiny in-process HTTP server (no supertest dep) ───────────────────────
function buildApp() {
  const app = express();
  app.use('/api/system', rateLimitRouter);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function get(server, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, body }); }
      });
    }).on('error', reject);
  });
}

// ─── Suppress logger noise ───────────────────────────────────────────────
const logger = require('../src/utils/logger');
beforeAll(() => {
  jest.spyOn(logger, 'error').mockImplementation(() => {});
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  jest.spyOn(logger, 'info').mockImplementation(() => {});
  jest.spyOn(logger, 'debug').mockImplementation(() => {});
});

// ─── Endpoint tests ──────────────────────────────────────────────────────
describe('rate-limit gauge · GET /api/system/rate-limit', () => {
  let server;

  beforeAll(async () => {
    server = await listen(buildApp());
  });

  afterAll(async () => {
    await closeServer(server);
  });

  beforeEach(() => {
    mockGetRateLimitStatus.mockReset();
  });

  test('returns 200 with full snapshot shape (healthy state)', async () => {
    mockGetRateLimitStatus.mockReturnValue({
      capacity: 6000,
      refillRate: 6000 / 60000,        // tokens / ms
      tokens: 4800,
      usedEstimated: 1200,
      lastRefill: Date.now(),
      banUntilMs: 0,
      banRemainingSec: 0,
      circuitBreaker: {
        state: 'closed',
        openedAt: 0,
        cooldownRemainingMs: 0,
        consecutiveHighUsed: 0,
        usedPct: 0.20,
      },
    });

    const res = await get(server, '/api/system/rate-limit');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      capacity: 6000,
      tokens: 4800,
      usedEstimated: 1200,
      usedPct: 20,                          // 1200 / 6000 = 20%
      refillRate: 6000 / 60000,
      banRemainingSec: 0,
      circuitBreaker: expect.objectContaining({
        state: 'closed',
        usedPct: 0.20,
        cooldownRemainingMs: 0,
      }),
    }));
    expect(typeof res.body.ts).toBe('number');
    expect(res.body.ts).toBeGreaterThan(0);
  });

  test('usedPct rounds to nearest integer (4500/6000 = 75%)', async () => {
    mockGetRateLimitStatus.mockReturnValue({
      capacity: 6000,
      refillRate: 6000 / 60000,
      tokens: 1500,
      usedEstimated: 4500,
      lastRefill: Date.now(),
      banUntilMs: 0,
      banRemainingSec: 0,
      circuitBreaker: { state: 'closed', openedAt: 0, cooldownRemainingMs: 0, consecutiveHighUsed: 0, usedPct: 0.75 },
    });

    const res = await get(server, '/api/system/rate-limit');
    expect(res.body.usedPct).toBe(75);
    expect(res.body.tokens).toBe(1500);
    expect(res.body.usedEstimated).toBe(4500);
  });

  test('circuit-breaker OPEN state surfaces banRemainingSec', async () => {
    const future = Date.now() + 25_000;
    mockGetRateLimitStatus.mockReturnValue({
      capacity: 6000,
      refillRate: 6000 / 60000,
      tokens: 50,
      usedEstimated: 5950,
      lastRefill: Date.now(),
      banUntilMs: future,
      banRemainingSec: 25,
      circuitBreaker: { state: 'open', openedAt: Date.now(), cooldownRemainingMs: 25000, consecutiveHighUsed: 5, usedPct: 0.99 },
    });

    const res = await get(server, '/api/system/rate-limit');
    expect(res.status).toBe(200);
    expect(res.body.usedPct).toBe(99);
    expect(res.body.circuitBreaker.state).toBe('open');
    expect(res.body.banRemainingSec).toBe(25);
  });

  test('returns 500 if getRateLimitStatus throws', async () => {
    mockGetRateLimitStatus.mockImplementation(() => { throw new Error('rate limiter down'); });
    const res = await get(server, '/api/system/rate-limit');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/rate limiter down/);
  });
});

// ─── healthMonitor tick emits rateLimit:update ───────────────────────────
describe('healthMonitor · rateLimit:update event', () => {
  let eventBus;
  let healthMonitor;

  beforeEach(() => {
    // Re-require eventBus + healthMonitor fresh (with our mocks in place)
    jest.resetModules();
    mockGetRateLimitStatus.mockReset();
    // mock mongoose so require chain doesn't try to connect
    jest.doMock('mongoose', () => ({
      connection: { readyState: 1 },
    }));
    jest.doMock('../src/binance/binanceWs', () => ({
      marketWs: { connected: true, reconnectAttempts: 0, getSubscribedStreams: () => [] },
      userDataWs: { ws: null, subscriptionId: null },
    }));
    jest.doMock('../src/core/botManager', () => ({ traders: { size: 0 } }));
    jest.doMock('../config', () => ({
      env: 'test',
      logLevel: 'silent',
      binanceApi: { base: 'http://example' },
      binance: { apiKey: 'test' },
    }));
    eventBus = require('../src/services/eventBus');
    healthMonitor = require('../src/services/healthMonitor');
  });

  afterEach(() => {
    jest.dontMock('mongoose');
    jest.dontMock('../src/binance/binanceWs');
    jest.dontMock('../src/core/botManager');
    jest.dontMock('../config');
    // Remove all listeners so we don't leak between tests
    eventBus.removeAllListeners('rateLimit:update');
    eventBus.removeAllListeners('health:update');
  });

  test('_tick() emits rateLimit:update with full payload', () => {
    mockGetRateLimitStatus.mockReturnValue({
      capacity: 6000,
      refillRate: 6000 / 60000,
      tokens: 3000,
      usedEstimated: 3000,
      lastRefill: Date.now(),
      banUntilMs: 0,
      banRemainingSec: 0,
      circuitBreaker: { state: 'closed', openedAt: 0, cooldownRemainingMs: 0, consecutiveHighUsed: 0, usedPct: 0.5 },
    });

    const spy = jest.fn();
    eventBus.on('rateLimit:update', spy);

    healthMonitor._tick();

    expect(spy).toHaveBeenCalledTimes(1);
    const payload = spy.mock.calls[0][0];
    expect(payload).toEqual(expect.objectContaining({
      capacity: 6000,
      tokens: 3000,
      usedEstimated: 3000,
      usedPct: 50,                       // 3000/6000 = 50%
      refillRate: 6000 / 60000,
      banRemainingSec: 0,
      circuitBreaker: expect.objectContaining({
        state: 'closed',
        usedPct: 0.5,
        cooldownRemainingMs: 0,
      }),
    }));
    expect(typeof payload.ts).toBe('number');
  });

  test('_tick() does not throw if getRateLimitStatus fails (health tick survives)', () => {
    mockGetRateLimitStatus.mockImplementation(() => { throw new Error('boom'); });

    const spy = jest.fn();
    eventBus.on('rateLimit:update', spy);

    expect(() => healthMonitor._tick()).not.toThrow();
    expect(spy).not.toHaveBeenCalled(); // skipped because of error
  });

  test('_tick() still emits health:update even when rateLimit read fails', () => {
    mockGetRateLimitStatus.mockImplementation(() => { throw new Error('boom'); });
    const healthSpy = jest.fn();
    eventBus.on('health:update', healthSpy);

    healthMonitor._tick();

    expect(healthSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── dashboardWs forward list includes rateLimit:update ─────────────────
describe('dashboardWs · EVENTS_TO_FORWARD includes rateLimit:update', () => {
  test('forward list contains the new event (raw source check)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'realtime', 'dashboardWs.js'),
      'utf8'
    );
    // Assert string literal appears in the forward-list array
    expect(src).toMatch(/['"]rateLimit:update['"]/);
    // Assert the array literal is still intact (no broken edit)
    expect(src).toMatch(/const EVENTS_TO_FORWARD = \[[\s\S]*?\];/);
  });
});