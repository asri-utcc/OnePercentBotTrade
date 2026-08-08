'use strict';

// FIX-2026-08-06: Tests for binanceDelistMonitor
//   - helper pure functions (isAtRisk, willDelistWithin, isDelisted, shouldForceClose)
//   - notification latch (markNotified, wasNotified)
//   - getRiskInfoFor shape + daysUntil calculation
//   - refresh diff logic via mocked binanceRest.getSpotDelistSchedule
//
// Note: binanceRest is mocked to keep tests offline.
// The monitor is a singleton — internal state persists across tests in same file,
// so we use UNIQUE symbol names per test to avoid collision.

jest.mock('../src/binance/binanceRest', () => ({
  getSpotDelistSchedule: jest.fn(),
}));

const delistMonitor = require('../src/services/binanceDelistMonitor');
const binanceRest = require('../src/binance/binanceRest');

describe('binanceDelistMonitor — pure helpers (empty state)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('isAtRisk returns false for unknown symbol', () => {
    expect(delistMonitor.isAtRisk('NEVER_SEEN_RISK_USDT')).toBe(false);
    expect(delistMonitor.isAtRisk(null)).toBe(false);
    expect(delistMonitor.isAtRisk('')).toBe(false);
  });

  test('willDelistWithin returns false for unknown symbol', () => {
    expect(delistMonitor.willDelistWithin('NEVER_SEEN_SCHED_USDT', 7)).toBe(false);
    expect(delistMonitor.willDelistWithin('NEVER_SEEN_SCHED_USDT')).toBe(false);
  });

  test('isDelisted returns false for unknown symbol', () => {
    expect(delistMonitor.isDelisted('NEVER_SEEN_PAST_USDT')).toBe(false);
  });

  test('shouldForceClose returns false for unknown symbol', () => {
    expect(delistMonitor.shouldForceClose('NEVER_SEEN_FORCE_USDT')).toBe(false);
  });

  test('getDelistTime returns null for unknown symbol', () => {
    expect(delistMonitor.getDelistTime('NEVER_SEEN_TIME_USDT')).toBeNull();
  });

  test('getRiskInfoFor returns null for unknown symbol', () => {
    expect(delistMonitor.getRiskInfoFor('NEVER_SEEN_RISK_INFO_USDT')).toBeNull();
  });

  test('getScheduledSymbols returns array', () => {
    expect(Array.isArray(delistMonitor.getScheduledSymbols())).toBe(true);
  });

  test('markNotified + wasNotified latch (case-insensitive)', () => {
    const sym = 'LATCH_TEST_USDT';
    expect(delistMonitor.wasNotified(sym)).toBe(false);
    delistMonitor.markNotified(sym.toLowerCase());
    expect(delistMonitor.wasNotified(sym)).toBe(true);
    expect(delistMonitor.wasNotified(sym.toLowerCase())).toBe(true);
  });

  test('constants exposed for UI/tests', () => {
    expect(delistMonitor.BLOCK_BUY_DAYS).toBe(7);
    expect(delistMonitor.FORCE_CLOSE_DAYS).toBe(3);
  });
});

describe('binanceDelistMonitor — refresh populates state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('refreshDelistSchedule exposes helpers correctly', async () => {
    const sym1 = `POPULATE_A_USDT_${Date.now()}`;
    const sym2 = `POPULATE_B_USDT_${Date.now()}`;
    const sym3 = `POPULATE_C_USDT_${Date.now()}`;
    const now = Date.now();
    binanceRest.getSpotDelistSchedule.mockResolvedValueOnce([
      { delistTime: now + 2 * 24 * 60 * 60 * 1000, symbols: [sym1] },
      { delistTime: now + 14 * 24 * 60 * 60 * 1000, symbols: [sym2, sym3] },
    ]);

    const result = await delistMonitor.refreshDelistSchedule({ force: true });
    expect(result.size).toBeGreaterThanOrEqual(3);

    // Within 2d → willDelistWithin(7) true + shouldForceClose true
    expect(delistMonitor.willDelistWithin(sym1, 7)).toBe(true);
    expect(delistMonitor.shouldForceClose(sym1)).toBe(true);
    expect(delistMonitor.isDelisted(sym1)).toBe(false);
    expect(delistMonitor.getDelistTime(sym1)).toBeGreaterThan(now);

    // Within 14d → willDelistWithin(7) false, willDelistWithin(14) true
    expect(delistMonitor.willDelistWithin(sym2, 7)).toBe(false);
    expect(delistMonitor.willDelistWithin(sym2, 14)).toBe(true);
    expect(delistMonitor.shouldForceClose(sym2)).toBe(false);

    // getRiskInfoFor shape
    const risk = delistMonitor.getRiskInfoFor(sym1);
    expect(risk).not.toBeNull();
    expect(risk.isAtRisk).toBe(false);
    expect(risk.isDelisted).toBe(false);
    expect(risk.delistTime).toBeGreaterThan(now);
    expect(risk.delistDateIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(risk.daysUntil).toBeGreaterThan(1.5);
    expect(risk.daysUntil).toBeLessThan(2.5);
  });

  test('refreshDelistSchedule handles empty response', async () => {
    const sym = `EMPTY_TEST_USDT_${Date.now()}`;
    binanceRest.getSpotDelistSchedule.mockResolvedValueOnce([]);
    const result = await delistMonitor.refreshDelistSchedule({ force: true });
    expect(result.size).toBeGreaterThanOrEqual(0); // stale from prev tests
    expect(delistMonitor.getDelistTime(sym)).toBeNull();
  });

  test('refreshDelistSchedule skips malformed entries', async () => {
    const okSym = `OK_TEST_USDT_${Date.now()}`;
    binanceRest.getSpotDelistSchedule.mockResolvedValueOnce([
      { delistTime: null, symbols: ['BAD_USDT_1'] },
      { delistTime: 0, symbols: ['BAD_USDT_2'] },
      { delistTime: Date.now() + 86400000, symbols: [] },
      { delistTime: Date.now() + 86400000 }, // missing symbols
      { delistTime: Date.now() + 86400000, symbols: [okSym] },
    ]);
    await delistMonitor.refreshDelistSchedule({ force: true });
    expect(delistMonitor.getDelistTime(okSym)).not.toBeNull();
  });

  test('refreshDelistSchedule takes earliest delistTime for duplicate symbol', async () => {
    const sym = `DUP_TEST_USDT_${Date.now()}`;
    const now = Date.now();
    binanceRest.getSpotDelistSchedule.mockResolvedValueOnce([
      { delistTime: now + 14 * 24 * 60 * 60 * 1000, symbols: [sym] },
      { delistTime: now + 2 * 24 * 60 * 60 * 1000, symbols: [sym] },
    ]);
    await delistMonitor.refreshDelistSchedule({ force: true });
    expect(delistMonitor.getDelistTime(sym)).toBe(now + 2 * 24 * 60 * 60 * 1000);
    expect(delistMonitor.shouldForceClose(sym)).toBe(true);
  });

  test('isDelisted returns true for past delistTime', async () => {
    const sym = `PAST_USDT_${Date.now()}`;
    const now = Date.now();
    binanceRest.getSpotDelistSchedule.mockResolvedValueOnce([
      { delistTime: now - 60 * 1000, symbols: [sym] }, // 1 minute ago
    ]);
    await delistMonitor.refreshDelistSchedule({ force: true });
    expect(delistMonitor.isDelisted(sym)).toBe(true);
    expect(delistMonitor.willDelistWithin(sym, 30)).toBe(true);
    expect(delistMonitor.shouldForceClose(sym)).toBe(true);
  });
});

describe('binanceDelistMonitor — eventBus emit on diff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('refresh emits delistMonitor:scheduled for new symbols', async () => {
    const eventBus = require('../src/services/eventBus');
    const handler = jest.fn();
    eventBus.on('delistMonitor:scheduled', handler);

    const sym = `EVT_USDT_${Date.now()}`;
    binanceRest.getSpotDelistSchedule.mockResolvedValueOnce([
      { delistTime: Date.now() + 2 * 86400000, symbols: [sym] },
    ]);
    await delistMonitor.refreshDelistSchedule({ force: true });
    // emit() is synchronous — no flush needed
    const matchingCalls = handler.mock.calls.filter((call) => call[0] && call[0].symbol === sym);
    expect(matchingCalls.length).toBe(1);
    expect(matchingCalls[0][0]).toEqual(expect.objectContaining({
      symbol: sym,
      delistTime: expect.any(Number),
      delistDateIso: expect.any(String),
    }));

    eventBus.removeAllListeners('delistMonitor:scheduled');
  });

  test('re-appear emits new scheduled event', async () => {
    const eventBus = require('../src/services/eventBus');
    const handler = jest.fn();
    eventBus.on('delistMonitor:scheduled', handler);

    const sym = `REAPPEAR_USDT_${Date.now()}`;
    const now = Date.now();

    // First refresh — symbol appears
    binanceRest.getSpotDelistSchedule.mockResolvedValueOnce([
      { delistTime: now + 2 * 86400000, symbols: [sym] },
    ]);
    await delistMonitor.refreshDelistSchedule({ force: true });

    // Second refresh — symbol disappears (cancel delist)
    binanceRest.getSpotDelistSchedule.mockResolvedValueOnce([]);
    await delistMonitor.refreshDelistSchedule({ force: true });

    // Third refresh — symbol reappears (new schedule)
    binanceRest.getSpotDelistSchedule.mockResolvedValueOnce([
      { delistTime: now + 5 * 86400000, symbols: [sym] },
    ]);
    await delistMonitor.refreshDelistSchedule({ force: true });

    const matchingCalls = handler.mock.calls.filter((call) => call[0] && call[0].symbol === sym);
    expect(matchingCalls.length).toBe(2); // first + reappear

    eventBus.removeAllListeners('delistMonitor:scheduled');
  });

  test('cleared schedule emits schedule-cleared', async () => {
    const eventBus = require('../src/services/eventBus');
    const clearedHandler = jest.fn();
    eventBus.on('delistMonitor:schedule-cleared', clearedHandler);

    const sym = `CLEAR_USDT_${Date.now()}`;
    const now = Date.now();

    // First — symbol appears
    binanceRest.getSpotDelistSchedule.mockResolvedValueOnce([
      { delistTime: now + 2 * 86400000, symbols: [sym] },
    ]);
    await delistMonitor.refreshDelistSchedule({ force: true });

    // Then — symbol disappears
    binanceRest.getSpotDelistSchedule.mockResolvedValueOnce([]);
    await delistMonitor.refreshDelistSchedule({ force: true });

    const matchingCalls = clearedHandler.mock.calls.filter((call) => call[0] && call[0].symbol === sym);
    expect(matchingCalls.length).toBe(1);

    eventBus.removeAllListeners('delistMonitor:schedule-cleared');
  });
});
