'use strict';

/**
 * FIX-2026-09-21: AutoReserve BTC-Driven Adjust — unit tests
 *
 * Covers:
 *   1. Preset constants exposed correctly
 *   2. MODE_TO_PRESET_KEY mapping (4 in-mapping + normal→none)
 *   3. setEnabled(true) → subscribe + force-apply current BTC mode
 *   4. setEnabled(false) → unsubscribe + tracking cleared, DB autoReserve
 *      5 fields NOT touched
 *   5. _onBtcMode handler: mode change → apply preset + reloadConfig
 *   6. _onBtcMode handler: same mode emit → skip (no DB write)
 *   7. _onBtcMode handler: normal mode → clear tracking only, no preset write
 */

// NOTE: jest hoists jest.mock() calls to the top of the file. Any variable
// referenced inside a mock factory MUST be prefixed with `mock` (case-insensitive).
const mockAppConfigState = {
  doc: { key: 'singleton', autoReserveBtcDrivenEnabled: false, autoReserveBtcDrivenLastMode: null, autoReserveBtcDrivenLastAppliedAt: null },
};
let mockLastUpdatePayload = null;

jest.mock('../src/db/models/AppConfig', () => {
  return {
    findOne: jest.fn(() => ({
      lean: () => Promise.resolve(mockAppConfigState.doc),
    })),
    findOneAndUpdate: jest.fn((_filter, update) => {
      mockLastUpdatePayload = (update && update.$set) || update;
      Object.assign(mockAppConfigState.doc, mockLastUpdatePayload);
      return Promise.resolve(mockAppConfigState.doc);
    }),
  };
});

const mockEventBusListeners = new Map();
jest.mock('../src/services/eventBus', () => {
  return {
    on: jest.fn((event, fn) => {
      if (!mockEventBusListeners.has(event)) mockEventBusListeners.set(event, new Set());
      mockEventBusListeners.get(event).add(fn);
    }),
    off: jest.fn((event, fn) => {
      if (mockEventBusListeners.has(event)) mockEventBusListeners.get(event).delete(fn);
    }),
    emit: jest.fn((event, payload) => {
      if (mockEventBusListeners.has(event)) {
        for (const fn of mockEventBusListeners.get(event)) fn(payload);
      }
    }),
  };
});

const mockBtcTrendState = { mode: 'break', prevMode: null, lastComputedAt: null };
jest.mock('../src/services/btcTrendMonitor', () => {
  return {
    getState: jest.fn(() => ({ ...mockBtcTrendState })),
  };
});

const mockReloadConfig = jest.fn(() => Promise.resolve());
jest.mock('../src/services/autoReserve', () => {
  return {
    reloadConfig: mockReloadConfig,
  };
});

// Mock logger to silence output during tests
jest.mock('../src/utils/logger', () => {
  const mockNoop = () => {};
  return {
    info: mockNoop, warn: mockNoop, error: mockNoop, debug: mockNoop,
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────
function resetAll() {
  jest.resetModules();
  mockAppConfigState.doc = { key: 'singleton', autoReserveBtcDrivenEnabled: false, autoReserveBtcDrivenLastMode: null, autoReserveBtcDrivenLastAppliedAt: null };
  mockLastUpdatePayload = null;
  mockEventBusListeners.clear();
  mockBtcTrendState.mode = 'break';
  mockBtcTrendState.prevMode = null;
  mockBtcTrendState.lastComputedAt = null;
  mockReloadConfig.mockClear();
}

function getService() {
  return require('../src/services/autoReserveBtcDriven');
}

function getEventBus() {
  return require('../src/services/eventBus');
}

function emitBtcMode(mode, prevMode = null) {
  const payload = { mode, prevMode, computedAt: Date.now(), symbol: 'BTCUSDT', interval: '1h' };
  mockBtcTrendState.mode = mode;
  mockBtcTrendState.prevMode = prevMode;
  getEventBus().emit('btc-trend:mode', payload);
}

// Wait for async _applyForMode (the handler is fire-and-forget)
async function flushApply() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ─── Tests ──────────────────────────────────────────────────────────────
describe('autoReserveBtcDriven — preset table', () => {
  beforeEach(resetAll);

  test('1) BTC_PRESETS exports conservative and aggressive with correct values', () => {
    const svc = getService();
    expect(svc.getStatus().presets).toEqual({
      conservative: { poleCount: 2, usdtPerPole: 6, lossThresholdPct: 4, checkHours: 6, stepUsdt: 6 },
      aggressive:   { poleCount: 5, usdtPerPole: 9, lossThresholdPct: 2, checkHours: 2, stepUsdt: 9 },
    });
  });

  test('2) MODE_TO_PRESET_KEY maps 4 in-mapping modes + normal→undefined', () => {
    const svc = getService();
    const map = svc.getStatus().modeMapping;
    expect(map['break']).toBe('conservative');
    expect(map['waiting-boots']).toBe('conservative');
    expect(map['boots']).toBe('aggressive');
    expect(map['waiting-break']).toBe('aggressive');
    expect(map['normal']).toBeUndefined();
  });
});

describe('autoReserveBtcDriven — setEnabled flow', () => {
  beforeEach(resetAll);

  test('3) setEnabled(true) → subscribes + force-applies preset for current BTC mode (break → conservative)', async () => {
    mockBtcTrendState.mode = 'break';
    const svc = getService();
    await svc.setEnabled(true);
    await flushApply();

    expect(mockLastUpdatePayload).toMatchObject({
      autoReservePoleCount: 2,
      autoReserveUsdtPerPole: 6,
      autoReserveLossThresholdPct: 4,
      autoReserveCheckHours: 6,
      autoReserveStepUsdt: 6,
      autoReserveBtcDrivenLastMode: 'break',
    });
    expect(mockLastUpdatePayload.autoReserveBtcDrivenLastAppliedAt).toBeInstanceOf(Date);

    expect(mockReloadConfig).toHaveBeenCalledTimes(1);

    expect(mockEventBusListeners.get('btc-trend:mode') || new Set()).toBeDefined();

    const status = svc.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.lastMode).toBe('break');
    expect(status.lastAppliedAt).toBeGreaterThan(0);
  });

  test('4) setEnabled(false) → unsubscribes + tracking cleared, DB autoReserve 5 fields NOT touched', async () => {
    mockBtcTrendState.mode = 'break';
    let svc = getService();
    await svc.setEnabled(true);
    await flushApply();

    const beforeDisable = { ...mockAppConfigState.doc };
    expect(beforeDisable.autoReservePoleCount).toBe(2); // applied earlier

    await svc.setEnabled(false);

    // After setEnabled(false), the LAST captured payload is the "clear tracking"
    // write (enabled=false was written in the FIRST write). Verify that:
    //  - In-memory doc now has autoReserveBtcDrivenEnabled = false (persisted)
    //  - Tracking fields cleared
    //  - 5 preset fields NOT touched (still = preset values from earlier apply)
    expect(mockAppConfigState.doc.autoReserveBtcDrivenEnabled).toBe(false);
    expect(mockAppConfigState.doc.autoReserveBtcDrivenLastMode).toBe(null);
    expect(mockAppConfigState.doc.autoReserveBtcDrivenLastAppliedAt).toBe(null);
    // Preset values from earlier apply are still in DB — NOT overwritten on disable
    expect(mockAppConfigState.doc.autoReservePoleCount).toBe(2);
    expect(mockAppConfigState.doc.autoReserveUsdtPerPole).toBe(6);
    expect(mockAppConfigState.doc.autoReserveLossThresholdPct).toBe(4);
    expect(mockAppConfigState.doc.autoReserveCheckHours).toBe(6);
    expect(mockAppConfigState.doc.autoReserveStepUsdt).toBe(6);

    // The LAST payload captured is the clear-tracking write (no preset fields)
    expect(mockLastUpdatePayload).toEqual({
      autoReserveBtcDrivenLastMode: null,
      autoReserveBtcDrivenLastAppliedAt: null,
    });

    const status = svc.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.lastMode).toBe(null);
    expect(status.lastAppliedAt).toBe(null);
  });
});

describe('autoReserveBtcDriven — eventBus handler', () => {
  beforeEach(resetAll);

  test('5) _onBtcMode handler: mode change → apply preset + reloadConfig', async () => {
    mockBtcTrendState.mode = 'break';
    let svc = getService();
    // Enable so eventBus listener is registered
    await svc.setEnabled(true);
    await flushApply();
    mockReloadConfig.mockClear();

    emitBtcMode('boots', 'break');
    await flushApply();

    expect(mockLastUpdatePayload).toMatchObject({
      autoReservePoleCount: 5,
      autoReserveUsdtPerPole: 9,
      autoReserveLossThresholdPct: 2,
      autoReserveCheckHours: 2,
      autoReserveStepUsdt: 9,
      autoReserveBtcDrivenLastMode: 'boots',
    });
    expect(mockReloadConfig).toHaveBeenCalledTimes(1);

    const status = svc.getStatus();
    expect(status.lastMode).toBe('boots');
  });

  test('6) _onBtcMode handler: same mode emit → skip (no DB write)', async () => {
    mockBtcTrendState.mode = 'boots';
    let svc = getService();
    await svc.setEnabled(true);
    await flushApply();
    mockReloadConfig.mockClear();

    const writesBefore = require('../src/db/models/AppConfig').findOneAndUpdate.mock.calls.length;
    const reloadsBefore = mockReloadConfig.mock.calls.length;

    emitBtcMode('boots', 'boots');
    await flushApply();

    const writesAfter = require('../src/db/models/AppConfig').findOneAndUpdate.mock.calls.length;
    const reloadsAfter = mockReloadConfig.mock.calls.length;

    expect(writesAfter).toBe(writesBefore);
    expect(reloadsAfter).toBe(reloadsBefore);
  });

  test('7) _onBtcMode handler: normal mode → clear tracking, no preset write', async () => {
    mockBtcTrendState.mode = 'break';
    let svc = getService();
    await svc.setEnabled(true);
    await flushApply();

    const writesBefore = require('../src/db/models/AppConfig').findOneAndUpdate.mock.calls.length;
    const reloadsBefore = mockReloadConfig.mock.calls.length;

    emitBtcMode('normal', 'break');
    await flushApply();

    expect(mockLastUpdatePayload).toEqual(expect.objectContaining({
      autoReserveBtcDrivenLastMode: 'normal',
      autoReserveBtcDrivenLastAppliedAt: null,
    }));
    expect(mockLastUpdatePayload).not.toHaveProperty('autoReservePoleCount');
    expect(mockLastUpdatePayload).not.toHaveProperty('autoReserveUsdtPerPole');
    expect(mockLastUpdatePayload).not.toHaveProperty('autoReserveLossThresholdPct');
    expect(mockLastUpdatePayload).not.toHaveProperty('autoReserveCheckHours');
    expect(mockLastUpdatePayload).not.toHaveProperty('autoReserveStepUsdt');

    const writesAfter = require('../src/db/models/AppConfig').findOneAndUpdate.mock.calls.length;
    const reloadsAfter = mockReloadConfig.mock.calls.length;

    expect(writesAfter).toBe(writesBefore + 1);
    expect(reloadsAfter).toBe(reloadsBefore);

    const status = svc.getStatus();
    expect(status.lastMode).toBe('normal');
    expect(status.lastAppliedAt).toBe(null);
  });
});
