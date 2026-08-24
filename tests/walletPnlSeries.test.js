'use strict';

/**
 * 2026-08-22: Regression test for /api/wallet/pnl-series endpoint
 *
 *   Bug discovered: chart showed empty even though user has 1800+ sold trades in DB.
 *   Root cause: aggregation pipeline had a broken `$toLong`/`$dateToString` projection that
 *               threw "Failed to parse number" — entire aggregation failed → route returned
 *               500 → chart rendered empty.
 *
 *   This test mocks Trade.aggregate to:
 *     1. Verify the endpoint logic correctly transforms the aggregation output to chart points
 *     2. Verify the route no longer contains the broken `$toLong` projection (regression guard)
 *
 *   ไม่ต้องใช้ MongoDB — mock require('../src/db/models/Trade') with a minimal aggregate stub.
 */

const express = require('express');

// ─── Mocks ─────────────────────────────────────────────────────────────────
// `mock`-prefixed names are hoisted by jest.mock factory (Jest guard rule).
const sampleTrades = [
  { sellFilledAt: new Date('2026-08-20T10:00:00Z'), pnlUsdt: 0.5 },
  { sellFilledAt: new Date('2026-08-20T12:00:00Z'), pnlUsdt: -0.2 },
  { sellFilledAt: new Date('2026-08-21T08:00:00Z'), pnlUsdt: 1.0 },
];

const mockAggregateSpy = jest.fn(() => Promise.resolve(sampleTrades));

jest.mock('../src/db/models/Trade', () => ({
  aggregate: mockAggregateSpy,
}));

jest.mock('../src/db/models/WalletSnapshot', () => ({
  find: jest.fn(() => ({
    sort: jest.fn(() => ({
      lean: jest.fn(() => Promise.resolve([])),
    })),
  })),
}));

jest.mock('../src/binance/binanceRest', () => ({
  get24hrTickers: jest.fn(() => Promise.resolve([])),
  getAccount: jest.fn(() => Promise.resolve({ balances: [] })),
  formatBinanceError: jest.fn((err) => ({ msg: err.message })),
}));

jest.mock('../src/services/fxService', () => ({
  getUsdtToThb: jest.fn(() => Promise.resolve({ rate: 36.5, source: 'binance_p2p' })),
}));

jest.mock('../src/services/walletReserve', () => ({
  getReserveUsdt: jest.fn(() => Promise.resolve(0)),
  invalidateCache: jest.fn(),
  MAX_RESERVE: 1_000_000,
}));

jest.mock('../src/db/models/AppConfig', () => ({
  findOneAndUpdate: jest.fn(() => Promise.resolve()),
  findOne: jest.fn(() => Promise.resolve(null)),
}));

// Mock auth middleware to always pass
jest.mock('../src/api/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireBotActionPassword: (req, res, next) => next(),
}));

const config = require('../config');
// wallet.routes.js requires config for botActionPassword middleware — set safe value
config.botActionPassword = 'test-password';

// ─── Load the route AFTER mocks are set up ─────────────────────────────────
const walletRouter = require('../src/api/routes/wallet.routes');

// ─── Helper: tiny in-process HTTP server (no supertest dependency) ────────
const http = require('http');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/wallet', walletRouter);
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

async function get(server, path) {
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

// ─── Suppress the route logger noise during tests ──────────────────────────
const logger = require('../src/utils/logger');
beforeAll(() => {
  jest.spyOn(logger, 'error').mockImplementation(() => {});
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  jest.spyOn(logger, 'info').mockImplementation(() => {});
});

beforeEach(() => {
  mockAggregateSpy.mockClear();
  mockAggregateSpy.mockResolvedValue(sampleTrades);
});

// ─── Bug regression — $toLong/$dateToString must NOT appear in source ───────
describe('wallet pnl-series · regression — broken $toLong projection removed', () => {
  test('source code does NOT use the broken $toLong: $dateToString chain', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'routes', 'wallet.routes.js'), 'utf8');
    // Strip out comments and strings so the assertion only checks real code, not doc text
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/\/\/[^\n]*/g, '')         // line comments
      .replace(/'[^']*'/g, "''")          // single-quoted strings
      .replace(/"[^"]*"/g, '""');         // double-quoted strings
    expect(codeOnly).not.toMatch(/\$toLong/);
    expect(codeOnly).not.toMatch(/\$dateToString/);
  });

  test('source code uses simple $project with sellFilledAt + pnlUsdt', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'routes', 'wallet.routes.js'), 'utf8');
    expect(src).toMatch(/\$project:\s*\{[\s\S]*?sellFilledAt:\s*1[\s\S]*?pnlUsdt:\s*\{\s*\$ifNull/);
  });
});

// ─── Endpoint behavior ─────────────────────────────────────────────────────
describe('wallet pnl-series · endpoint output', () => {
  let server;

  beforeAll(async () => {
    server = await listen(buildApp());
  });

  afterAll(async () => {
    await closeServer(server);
  });

  test('returns 200 with points derived from aggregation', async () => {
    const res = await get(server, '/api/wallet/pnl-series?range=30D');
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('30D');
    expect(Array.isArray(res.body.points)).toBe(true);
    expect(res.body.points.length).toBe(sampleTrades.length);
    // First point: time = unix seconds of 2026-08-20T10:00:00Z
    expect(res.body.points[0].time).toBe(Math.floor(new Date('2026-08-20T10:00:00Z').getTime() / 1000));
    expect(res.body.points[0].pnlUsdt).toBe(0.5);
  });

  test('cumulative PnL sums correctly', async () => {
    const res = await get(server, '/api/wallet/pnl-series?range=30D');
    // 0.5 + (-0.2) + 1.0 = 1.3
    expect(res.body.totalPnlUsdt).toBeCloseTo(1.3, 4);
    expect(res.body.count).toBe(3);
  });

  test('counts wins and losses correctly', async () => {
    const res = await get(server, '/api/wallet/pnl-series?range=30D');
    expect(res.body.wins).toBe(2); // 0.5 + 1.0
    expect(res.body.losses).toBe(1); // -0.2
    expect(res.body.winRate).toBeCloseTo(66.67, 1);
  });

  test('baselinePoint equals first point time at zero cumulative', async () => {
    const res = await get(server, '/api/wallet/pnl-series?range=30D');
    expect(res.body.baselinePoint).not.toBeNull();
    expect(res.body.baselinePoint.cumPnlUsdt).toBe(0);
    expect(res.body.baselinePoint.time).toBe(res.body.points[0].time);
  });

  test('rejects invalid range with 400', async () => {
    const res = await get(server, '/api/wallet/pnl-series?range=BOGUS');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/range must be/);
  });

  test('handles empty aggregation result gracefully', async () => {
    mockAggregateSpy.mockResolvedValueOnce([]);
    const res = await get(server, '/api/wallet/pnl-series?range=7D');
    expect(res.status).toBe(200);
    expect(res.body.points).toEqual([]);
    expect(res.body.count).toBe(0);
    expect(res.body.totalPnlUsdt).toBe(0);
    expect(res.body.baselinePoint).toBeNull();
  });

  test('all 8 range values accepted (case-insensitive)', async () => {
    for (const r of ['1D', '3D', '7D', '30D', '90D', '180D', '1Y', 'all']) {
      const res = await get(server, `/api/wallet/pnl-series?range=${r}`);
      expect(res.status).toBe(200);
      // Route uppercases range — frontend can send 'all' and get 'ALL' back
      expect(res.body.range).toBe(r.toUpperCase());
    }
  });
});