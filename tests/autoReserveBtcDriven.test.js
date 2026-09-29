'use strict';

/**
 * FIX-2026-09-21: AutoReserve BTC-Driven Adjust — unit tests
 * FIX-2026-09-29: updated for split-step (stepReserve/stepRelease) + editable presets
 *
 * Covers:
 *   1. Default presets exposed correctly (6 fields, split step)
 *   2. MODE_TO_PRESET_KEY mapping (4 in-mapping + normal→none)
 *   3. setEnabled(true) → subscribe + force-apply current BTC mode
 *   4. setEnabled(false) → unsubscribe + tracking cleared, DB autoReserve
 *      6 fields NOT touched
 *   5. _onBtcMode handler: mode change → apply preset + reloadConfig
 *   6. _onBtcMode handler: same mode emit → skip (no DB write)
 *   7. _onBtcMode handler: normal mode → clear tracking only, no preset write
 *   8. setPresets() → DB write + in-memory cache update
 *   9. setPresets() with out-of-range values → auto-clamped
 *  10. start() loads presets from AppConfig (merged with defaults)
 *  11. start() falls back to defaults when AppConfig preset missing
 */

// NOTE: jest hoists jest.mock() calls to the top of the file. Any variable
// referenced inside a mock factory MUST be prefixed with `mock` (case-insensitive).
const mockAppConfigState = {
  doc: {
    key: 'singleton',
    autoReserveBtcDrivenEnabled: false,
    autoReserveBtcDrivenLastMode: null,
    autoReserveBtcDrivenLastAppliedAt: null,
    autoReserveBtcDrivenPresets: null, // null → service uses defaults (test 1, 2, 3-7)
  },
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
  mockAppConfigState.doc = {
    key: 'singleton',
    autoReserveBtcDrivenEnabled: false,
    autoReserveBtcDrivenLastMode: null,
    autoReserveBtcDrivenLastAppliedAt: null,
    autoReserveBtcDrivenPresets: null,
  };
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

  test('1) DEFAULT_PRESETS exports conservative + aggressive with 6 fields (split step)', () => {
    const svc = getService();
    expect(svc.getStatus().presets).toEqual({
      conservative: { poleCount: 2, usdtPerPole: 6, lossThresholdPct: 4, checkHours: 6, stepReserveUsdt: 6, stepReleaseUsdt: 6 },
      aggressive:   { poleCount: 5, usdtPerPole: 9, lossThresholdPct: 2, checkHours: 2, stepReserveUsdt: 9, stepReleaseUsdt: 9 },
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

  test('3) setEnabled(true) → subscribes + force-applies preset for current BTC mode (break → conservative, split step)', async () => {
    mockBtcTrendState.mode = 'break';
    const svc = getService();
    await svc.setEnabled(true);
    await flushApply();

    // FIX-2026-09-29: now writes both split step fields + mirrors legacy single field
    expect(mockLastUpdatePayload).toMatchObject({
      autoReservePoleCount: 2,
      autoReserveUsdtPerPole: 6,
      autoReserveLossThresholdPct: 4,
      autoReserveCheckHours: 6,
      autoReserveStepReserveUsdt: 6,
      autoReserveStepReleaseUsdt: 6,
      autoReserveStepUsdt: 6, // legacy mirror
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

  test('4) setEnabled(false) → unsubscribes + tracking cleared, DB autoReserve 6 fields NOT touched', async () => {
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
    //  - 6 preset fields NOT touched (still = preset values from earlier apply)
    expect(mockAppConfigState.doc.autoReserveBtcDrivenEnabled).toBe(false);
    expect(mockAppConfigState.doc.autoReserveBtcDrivenLastMode).toBe(null);
    expect(mockAppConfigState.doc.autoReserveBtcDrivenLastAppliedAt).toBe(null);
    // Preset values from earlier apply are still in DB — NOT overwritten on disable
    expect(mockAppConfigState.doc.autoReservePoleCount).toBe(2);
    expect(mockAppConfigState.doc.autoReserveUsdtPerPole).toBe(6);
    expect(mockAppConfigState.doc.autoReserveLossThresholdPct).toBe(4);
    expect(mockAppConfigState.doc.autoReserveCheckHours).toBe(6);
    expect(mockAppConfigState.doc.autoReserveStepReserveUsdt).toBe(6);
    expect(mockAppConfigState.doc.autoReserveStepReleaseUsdt).toBe(6);
    expect(mockAppConfigState.doc.autoReserveStepUsdt).toBe(6); // legacy mirror also preserved

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

  test('5) _onBtcMode handler: mode change → apply preset + reloadConfig (split step)', async () => {
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
      autoReserveStepReserveUsdt: 9,
      autoReserveStepReleaseUsdt: 9,
      autoReserveStepUsdt: 9, // legacy mirror
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

  test('7) _onBtcMode handler: normal mode → clear tracking, no preset write (no split step fields)', async () => {
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
    expect(mockLastUpdatePayload).not.toHaveProperty('autoReserveStepReserveUsdt');
    expect(mockLastUpdatePayload).not.toHaveProperty('autoReserveStepReleaseUsdt');

    const writesAfter = require('../src/db/models/AppConfig').findOneAndUpdate.mock.calls.length;
    const reloadsAfter = mockReloadConfig.mock.calls.length;

    expect(writesAfter).toBe(writesBefore + 1);
    expect(reloadsAfter).toBe(reloadsBefore);

    const status = svc.getStatus();
    expect(status.lastMode).toBe('normal');
    expect(status.lastAppliedAt).toBe(null);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-2026-09-29: editable preset tests (round 3)
// ──────────────────────────────────────────────────────────────────────────
describe('autoReserveBtcDriven — setPresets (editable)', () => {
  beforeEach(resetAll);

  test('8) setPresets() → DB write + in-memory cache update (returns validated+clamped)', async () => {
    const svc = getService();
    const newPresets = {
      conservative: { poleCount: 3, usdtPerPole: 7, lossThresholdPct: 3.5, checkHours: 4, stepReserveUsdt: 7, stepReleaseUsdt: 5 },
      aggressive:   { poleCount: 6, usdtPerPole: 12, lossThresholdPct: 1.5, checkHours: 1, stepReserveUsdt: 12, stepReleaseUsdt: 10 },
    };

    const validated = await svc.setPresets(newPresets);

    // DB write happened with validated values
    expect(mockLastUpdatePayload).toMatchObject({
      autoReserveBtcDrivenPresets: validated,
    });

    // Returned value matches input (all within bounds)
    expect(validated.conservative.poleCount).toBe(3);
    expect(validated.aggressive.poleCount).toBe(6);

    // In-memory cache updated
    expect(svc.getStatus().presets.conservative.poleCount).toBe(3);
    expect(svc.getStatus().presets.aggressive.poleCount).toBe(6);

    // DB doc also reflects write (Object.assign in mock)
    expect(mockAppConfigState.doc.autoReserveBtcDrivenPresets.conservative.poleCount).toBe(3);
  });

  test('9) setPresets() with out-of-range values → auto-clamped per field', async () => {
    const svc = getService();
    // poleCount: bounds 1..100 (clamped)
    // usdtPerPole: bounds 0.1..1000
    // lossThresholdPct: bounds 0.1..50
    // checkHours: bounds 1..168
    // stepReserveUsdt + stepReleaseUsdt: bounds 1..1000
    const input = {
      conservative: { poleCount: 999, usdtPerPole: 9999, lossThresholdPct: 999, checkHours: 999, stepReserveUsdt: 9999, stepReleaseUsdt: 0 },
      aggressive:   { poleCount: -5, usdtPerPole: 0.01, lossThresholdPct: -1, checkHours: 0, stepReserveUsdt: -1, stepReleaseUsdt: 0.5 },
    };

    const validated = await svc.setPresets(input);

    expect(validated.conservative.poleCount).toBe(100);          // clamped from 999
    expect(validated.conservative.usdtPerPole).toBe(1000);       // clamped from 9999
    expect(validated.conservative.lossThresholdPct).toBe(50);    // clamped from 999
    expect(validated.conservative.checkHours).toBe(168);         // clamped from 999
    expect(validated.conservative.stepReserveUsdt).toBe(1000);   // clamped from 9999
    expect(validated.conservative.stepReleaseUsdt).toBe(1);      // clamped from 0

    expect(validated.aggressive.poleCount).toBe(1);              // clamped from -5
    expect(validated.aggressive.usdtPerPole).toBe(0.1);           // clamped from 0.01
    expect(validated.aggressive.lossThresholdPct).toBe(0.1);     // clamped from -1
    expect(validated.aggressive.checkHours).toBe(1);             // clamped from 0
    expect(validated.aggressive.stepReserveUsdt).toBe(1);        // clamped from -1
    expect(validated.aggressive.stepReleaseUsdt).toBe(1);        // clamped from 0.5
  });

  test('10) start() loads presets from AppConfig (merged with defaults)', async () => {
    // Pre-populate AppConfig with custom presets (only some fields overridden)
    mockAppConfigState.doc.autoReserveBtcDrivenPresets = {
      conservative: { poleCount: 7 }, // other fields should fall back to defaults
      aggressive: { stepReserveUsdt: 15, stepReleaseUsdt: 12 }, // other fields fall back
    };

    // Reset to re-require module + re-run constructor/start
    jest.resetModules();
    const svc = require('../src/services/autoReserveBtcDriven');
    // start() not yet called — load on next start
    await svc.start();

    const presets = svc.getStatus().presets;
    // Conservative: poleCount from DB, other fields from defaults
    expect(presets.conservative.poleCount).toBe(7);
    expect(presets.conservative.usdtPerPole).toBe(6); // default
    expect(presets.conservative.stepReserveUsdt).toBe(6); // default
    expect(presets.conservative.stepReleaseUsdt).toBe(6); // default

    // Aggressive: step fields from DB, other fields from defaults
    expect(presets.aggressive.poleCount).toBe(5); // default
    expect(presets.aggressive.stepReserveUsdt).toBe(15); // from DB
    expect(presets.aggressive.stepReleaseUsdt).toBe(12); // from DB
  });

  test('11) start() falls back to DEFAULT_PRESETS when AppConfig presets missing', async () => {
    // AppConfig.autoReserveBtcDrivenPresets = null → use defaults
    mockAppConfigState.doc.autoReserveBtcDrivenPresets = null;

    jest.resetModules();
    const svc = require('../src/services/autoReserveBtcDriven');
    await svc.start();

    const presets = svc.getStatus().presets;
    expect(presets.conservative.poleCount).toBe(2);
    expect(presets.conservative.stepReserveUsdt).toBe(6);
    expect(presets.aggressive.poleCount).toBe(5);
    expect(presets.aggressive.stepReserveUsdt).toBe(9);

    // defaults field exposes original constant
    expect(svc.getStatus().defaults.conservative.poleCount).toBe(2);
    expect(svc.getStatus().defaults.aggressive.poleCount).toBe(5);
  });

  test('12) setPresets() throws on missing preset key or null input (validation)', async () => {
    const svc = getService();
    // Missing 'aggressive' key entirely → throws
    await expect(svc.setPresets({
      conservative: { poleCount: 3, usdtPerPole: 7, lossThresholdPct: 3, checkHours: 4, stepReserveUsdt: 7, stepReleaseUsdt: 5 },
    })).rejects.toThrow(/preset 'aggressive' missing/);

    // null input → throws
    await expect(svc.setPresets(null)).rejects.toThrow(/presets object required/);

    // Non-object (string) input → throws
    await expect(svc.setPresets('invalid')).rejects.toThrow(/presets object required/);

    // Array input → throws
    await expect(svc.setPresets(['conservative', 'aggressive'])).rejects.toThrow(/presets object required/);

    // Empty object for one preset (null/undefined value) → throws
    await expect(svc.setPresets({ conservative: null, aggressive: {} })).rejects.toThrow(/preset 'conservative' missing or invalid/);
  });
});
