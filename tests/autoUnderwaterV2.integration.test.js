'use strict';

/**
 * FIX-2026-09-06: AUv2 integration tests — runOnce() flow with mocks
 *
 * Covers:
 *   - Master toggle OFF → tick exits early, stats.skippedMasterOff=1
 *   - License OFF → tick exits early, stats.skippedLicenseOff=1
 *   - Master ON + no open trades → tick exits cleanly
 *   - Master ON + open trade but bot opt-out → skippedBotOptOut incremented
 *   - Master ON + open trade eligible → forceCloseTrade invoked + sellReason overridden
 *   - Hard cap → trigger regardless of lossPct
 *   - runOnce in-flight guard → second call skipped
 */

// ─── Mocks (must be set up before requiring the service) ──────────────────

const mockAppConfig = {
  findOne: jest.fn(),
  updateOne: jest.fn(async () => ({})),
};
jest.mock('../src/db/models/AppConfig', () => mockAppConfig);

const mockBot = {
  find: jest.fn(),
};
jest.mock('../src/db/models/Bot', () => mockBot);

const mockTrade = {
  find: jest.fn(),
  findById: jest.fn(),
  updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
};
jest.mock('../src/db/models/Trade', () => mockTrade);

const mockForceClose = {
  forceCloseTrade: jest.fn(),
};
jest.mock('../src/core/forceClose', () => mockForceClose);

const mockFx = {
  getRate: jest.fn(async () => ({ rate: 35, source: 'test' })),
};
jest.mock('../src/services/fxService', () => mockFx);

const mockBinanceRest = {
  getKlines: jest.fn(async () => [
    [0, 0, 0, 0, 95, 0, 0, 0, 0, 0, 0, 0], // close=95
  ]),
};
jest.mock('../src/binance/binanceRest', () => mockBinanceRest);

jest.mock('../src/services/eventBus', () => ({
  emit: jest.fn(),
  on: jest.fn(),
  removeAllListeners: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../src/services/licenseService', () => ({
  isFeatureEnabled: jest.fn(() => true),
}));

// eslint-disable-next-line no-unused-vars
const _licenseServiceRef = require('../src/services/licenseService');

// ─── Load service AFTER mocks ────────────────────────────────────────────

const auv2 = require('../src/services/autoUnderwaterV2');

// ─── Helpers ─────────────────────────────────────────────────────────────

function resetMocks() {
  jest.clearAllMocks();
  // Reset license service mock back to enabled=true (default)
  const licenseSvc = require('../src/services/licenseService');
  licenseSvc.isFeatureEnabled.mockReturnValue(true);
  mockAppConfig.findOne.mockReset();
  mockBot.find.mockReset();
  mockTrade.find.mockReset();
  mockTrade.findById.mockReset();
  mockTrade.updateOne.mockReset();
  mockForceClose.forceCloseTrade.mockReset();
  mockFx.getRate.mockReset();
  mockBinanceRest.getKlines.mockReset();

  // Defaults
  mockAppConfig.findOne.mockReturnValue({ lean: async () => ({ key: 'singleton', masterAuv2Enabled: true }) });
  mockBot.find.mockReturnValue({ lean: async () => [] });
  mockTrade.find.mockReturnValue({ lean: async () => [] });
  mockTrade.findById.mockReturnValue({ lean: async () => null });
  mockTrade.updateOne.mockResolvedValue({ modifiedCount: 1 });
  mockForceClose.forceCloseTrade.mockResolvedValue({ ok: true, mode: 'market', pnl: { net: 0 }, avgSellPrice: 95 });
  mockFx.getRate.mockResolvedValue({ rate: 35, source: 'test' });
  mockBinanceRest.getKlines.mockResolvedValue([
    [0, 0, 0, 0, 95, 0, 0, 0, 0, 0, 0, 0],
  ]);
}

beforeEach(() => {
  resetMocks();
  auv2.inFlight = false; // reset singleton state
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('AutoUnderwaterV2.runOnce integration', () => {
  test('master toggle OFF → exits early with skippedMasterOff=1', async () => {
    mockAppConfig.findOne.mockReturnValue({ lean: async () => ({ key: 'singleton', masterAuv2Enabled: false }) });
    const stats = await auv2.runOnce();
    expect(stats.skippedMasterOff).toBe(1);
    expect(mockTrade.find).not.toHaveBeenCalled();
  });

  test('master toggle missing (cfg null) → exits early', async () => {
    mockAppConfig.findOne.mockReturnValue({ lean: async () => null });
    const stats = await auv2.runOnce();
    expect(stats.skippedMasterOff).toBe(1);
    expect(mockTrade.find).not.toHaveBeenCalled();
  });

  test('license OFF → exits early with skippedLicenseOff=1', async () => {
    const licenseService = require('../src/services/licenseService');
    licenseService.isFeatureEnabled.mockReturnValue(false);
    const stats = await auv2.runOnce();
    expect(stats.skippedLicenseOff).toBe(1);
    expect(mockTrade.find).not.toHaveBeenCalled();
  });

  test('no open trades → exits cleanly with no errors', async () => {
    mockTrade.find.mockReturnValue({ lean: async () => [] });
    const stats = await auv2.runOnce();
    expect(stats.errors).toBe(0);
    expect(mockForceClose.forceCloseTrade).not.toHaveBeenCalled();
  });

  test('open trade but bot missing in DB → skipped silently', async () => {
    const tradeId = require('mongoose').Types.ObjectId;
    mockTrade.find.mockReturnValue({
      lean: async () => [{
        _id: 't1', botId: 'b1', state: 'holding',
        buyFilledAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        buyPrice: 100, totalQty: 10, isDcaStack: false, stackBep: null,
      }],
    });
    mockBot.find.mockReturnValue({ lean: async () => [] }); // no bots
    const stats = await auv2.runOnce();
    expect(stats.scanned).toBe(1);
    expect(stats.skippedNotOpen).toBe(1);
    expect(mockForceClose.forceCloseTrade).not.toHaveBeenCalled();
  });

  test('open trade + bot opt-out (auv2Enabled=false) → skippedBotOptOut=1', async () => {
    mockTrade.find.mockReturnValue({
      lean: async () => [{
        _id: 't1', botId: 'b1', state: 'holding',
        buyFilledAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        buyPrice: 100, totalQty: 10, isDcaStack: false, stackBep: null,
      }],
    });
    mockBot.find.mockReturnValue({
      lean: async () => [{
        _id: 'b1', symbol: 'BTCUSDT', timeframe: '3m', enabled: true,
        auv2Enabled: false, // opt-out
      }],
    });
    const stats = await auv2.runOnce();
    expect(stats.skippedBotOptOut).toBe(1);
    expect(mockForceClose.forceCloseTrade).not.toHaveBeenCalled();
  });

  test('DCA stack trade (isDcaStack=true) → skippedDca=1 even if shallow loss', async () => {
    mockBinanceRest.getKlines.mockResolvedValue([
      [0, 0, 0, 0, 95.1, 0, 0, 0, 0, 0, 0, 0], // -4.9% (would trigger)
    ]);
    mockTrade.find.mockReturnValue({
      lean: async () => [{
        _id: 't1', botId: 'b1', state: 'holding',
        buyFilledAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        buyPrice: 100, totalQty: 10, isDcaStack: true, stackBep: 80,
      }],
    });
    mockBot.find.mockReturnValue({
      lean: async () => [{
        _id: 'b1', symbol: 'BTCUSDT', timeframe: '3m', enabled: true,
        auv2Enabled: true, auv2MinAgeHours: 24, auv2LossMode: 'pct',
        auv2MaxLossPct: 5, auv2MaxLossThb: 200, auv2MaxWaitDays: 0,
      }],
    });
    const stats = await auv2.runOnce();
    expect(stats.skippedDca).toBe(1);
    expect(stats.triggered).toBe(0);
    expect(stats.closed).toBe(0);
    expect(mockForceClose.forceCloseTrade).not.toHaveBeenCalled();
  });

  test('trigger path: bot eligible + loss shallow → forceCloseTrade called', async () => {
    // lastClose=95.1 → lossPct=4.9% (< default 5% threshold) → trigger
    mockBinanceRest.getKlines.mockResolvedValue([
      [0, 0, 0, 0, 95.1, 0, 0, 0, 0, 0, 0, 0],
    ]);
    mockTrade.find.mockReturnValue({
      lean: async () => [{
        _id: 't1', botId: 'b1', state: 'holding',
        buyFilledAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        buyPrice: 100, totalQty: 10, isDcaStack: false, stackBep: null,
      }],
    });
    mockBot.find.mockReturnValue({
      lean: async () => [{
        _id: 'b1', symbol: 'BTCUSDT', timeframe: '3m', enabled: true,
        auv2Enabled: true, auv2MinAgeHours: 24, auv2LossMode: 'pct',
        auv2MaxLossPct: 5, auv2MaxLossThb: 200, auv2MaxWaitDays: 7,
      }],
    });
    // findById returns same trade in 'holding' state (re-fetch for atomic claim)
    mockTrade.findById.mockReturnValue({
      lean: async () => ({
        _id: 't1', state: 'holding', symbol: 'BTCUSDT',
        buyPrice: 100, totalQty: 10, isDcaStack: false, stackBep: null,
        buyFilledAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      }),
    });

    const stats = await auv2.runOnce();
    expect(stats.triggered).toBe(1);
    expect(stats.closed).toBe(1);
    expect(mockForceClose.forceCloseTrade).toHaveBeenCalledTimes(1);
    expect(mockForceClose.forceCloseTrade).toHaveBeenCalledWith(expect.objectContaining({
      source: 'auv2',
      allowMarketSell: true,
    }));
  });

  test('hard cap triggers even with deep loss', async () => {
    mockBinanceRest.getKlines.mockResolvedValue([
      [0, 0, 0, 0, 50, 0, 0, 0, 0, 0, 0, 0],
    ]);
    mockTrade.find.mockReturnValue({
      lean: async () => [{
        _id: 't1', botId: 'b1', state: 'holding',
        buyFilledAt: new Date(Date.now() - 10 * 86400000).toISOString(),
        buyPrice: 100, totalQty: 10, isDcaStack: false, stackBep: null,
      }],
    });
    mockBot.find.mockReturnValue({
      lean: async () => [{
        _id: 'b1', symbol: 'BTCUSDT', timeframe: '3m', enabled: true,
        auv2Enabled: true, auv2MinAgeHours: 24, auv2LossMode: 'pct',
        auv2MaxLossPct: 5, auv2MaxLossThb: 200, auv2MaxWaitDays: 7,
      }],
    });
    mockTrade.findById.mockReturnValue({
      lean: async () => ({
        _id: 't1', state: 'holding', symbol: 'BTCUSDT',
        buyPrice: 100, totalQty: 10, isDcaStack: false, stackBep: null,
        buyFilledAt: new Date(Date.now() - 10 * 86400000).toISOString(),
      }),
    });

    const stats = await auv2.runOnce();
    expect(stats.triggered).toBe(1);
    expect(stats.closed).toBe(1);
  });

  test('forceCloseTrade failure → stats.errors++', async () => {
    mockBinanceRest.getKlines.mockResolvedValue([
      [0, 0, 0, 0, 95.1, 0, 0, 0, 0, 0, 0, 0],
    ]);
    mockTrade.find.mockReturnValue({
      lean: async () => [{
        _id: 't1', botId: 'b1', state: 'holding',
        buyFilledAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        buyPrice: 100, totalQty: 10, isDcaStack: false, stackBep: null,
      }],
    });
    mockBot.find.mockReturnValue({
      lean: async () => [{
        _id: 'b1', symbol: 'BTCUSDT', timeframe: '3m', enabled: true,
        auv2Enabled: true, auv2MinAgeHours: 24, auv2LossMode: 'pct',
        auv2MaxLossPct: 5, auv2MaxLossThb: 200, auv2MaxWaitDays: 7,
      }],
    });
    mockTrade.findById.mockReturnValue({
      lean: async () => ({
        _id: 't1', state: 'holding', symbol: 'BTCUSDT',
        buyPrice: 100, totalQty: 10, isDcaStack: false, stackBep: null,
        buyFilledAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      }),
    });
    mockForceClose.forceCloseTrade.mockResolvedValue({ ok: false, error: 'binance timeout' });

    const stats = await auv2.runOnce();
    expect(stats.triggered).toBe(1);
    expect(stats.closed).toBe(0);
    expect(stats.errors).toBe(1);
  });

  test('in-flight guard → second call returns skipped', async () => {
    // Set inFlight manually to simulate running tick
    auv2.inFlight = true;
    const stats = await auv2.runOnce();
    expect(stats.skipped).toBe(true);
    expect(mockTrade.find).not.toHaveBeenCalled();
  });

  test('persists telemetry to AppConfig after successful tick', async () => {
    mockTrade.find.mockReturnValue({ lean: async () => [] });
    await auv2.runOnce();
    // _persistTelemetry() is called from _tickSafe().finally() — invoke directly:
    await auv2._persistTelemetry();
    expect(mockAppConfig.updateOne).toHaveBeenCalled();
    const call = mockAppConfig.updateOne.mock.calls[0];
    expect(call[0]).toEqual({ key: 'singleton' });
    expect(call[1].$set.auv2LastRunAt).toBeDefined();
  });
});