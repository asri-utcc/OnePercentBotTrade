'use strict';

/**
 * FIX-2026-08-29: Unit tests for autoPauseAdjust service
 *
 * Covers:
 *   - decideAdjustment: tighten / loosen / none branches, sign of delta, NaN guards, defaults
 *   - clampKc / clampVol: schema-bound clamps (KC [0.1, 50], Vol [0, 1e9]) + NaN handling
 *   - Singleton service runOnce():
 *       disabled → skipped
 *       in-flight → skipped
 *       license-disabled → skipped
 *       running < minBots → loosen path (bulkWrite emits)
 *       running > maxBots → tighten path
 *       running in [minBots, maxBots] → no-op (no bulkWrite)
 *       eligible-empty → no-op (no bulkWrite)
 *       clamp KC at KC_MAX → only vol field updates (updatedBots=1)
 *       clamp VOL at VOL_MAX → only KC field updates (updatedBots=1)
 *       both fields clamped → skip bot (updatedBots=0)
 *       KC at KC_MIN when loosening → only vol updates (updatedBots=1)
 *       opted-out bots excluded from eligibility query
 *       soft-deleted bots excluded from eligibility query
 *       emits 'autoPauseAdjust:applied' event when bots updated
 *   - reloadConfig: install interval in-place when enabled, no-op when disabled
 *   - getStatus: returns running/timer/inFlight/config snapshot
 */

// ─── Mocks (top-level jest.mock — factory pattern) ──────────────────────

const mockBot = {
  countDocuments: jest.fn(),
  find: jest.fn(),
  bulkWrite: jest.fn(async () => ({ modifiedCount: 0 })),
};

jest.mock('../src/db/models/Bot', () => mockBot);

const mockAppConfig = {
  findOne: jest.fn(async () => null),
  updateOne: jest.fn(async () => ({})),
  findOneAndUpdate: jest.fn(async () => null),
};

jest.mock('../src/db/models/AppConfig', () => mockAppConfig);

jest.mock('../src/services/eventBus', () => ({
  emit: jest.fn(),
  on: jest.fn(),
  removeAllListeners: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../src/services/licenseService', () => ({
  isFeatureEnabled: jest.fn(() => true), // default: feature enabled
}));

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Configure AppConfig mock to return a specific autoPauseAdjust* config.
 */
function setMasterConfig(overrides = {}) {
  const defaults = {
    autoPauseAdjustEnabled: false,
    autoPauseAdjustMinBots: 15,
    autoPauseAdjustMaxBots: 25,
    autoPauseAdjustIntervalMs: 60 * 60 * 1000,
    autoPauseAdjustKcStep: 0.1,
    autoPauseAdjustVolStep: 100_000,
  };
  mockAppConfig.findOne.mockResolvedValue({ key: 'singleton', ...defaults, ...overrides });
}

/**
 * Configure Bot.countDocuments mock for the "running bots" count.
 * Note: service calls countDocuments({ enabled, autoPauseEnabled, deletedAt: null })
 */
function setRunningBots(n) {
  mockBot.countDocuments.mockResolvedValue(n);
}

/**
 * Configure Bot.find(...).lean() mock — returns the array of eligible bot docs.
 */
function setEligibleBots(els) {
  mockBot.find.mockReturnValue({ lean: async () => els });
}

/**
 * Reset all mocks to default state.
 */
function resetMocks() {
  jest.clearAllMocks();
  mockBot.countDocuments.mockReset();
  mockBot.find.mockReset();
  mockBot.bulkWrite.mockReset();
  mockBot.bulkWrite.mockResolvedValue({ modifiedCount: 0 });
  mockAppConfig.findOne.mockReset();
  mockAppConfig.updateOne.mockReset();
  mockAppConfig.findOneAndUpdate.mockReset();
  mockAppConfig.findOne.mockResolvedValue(null);
  mockAppConfig.updateOne.mockResolvedValue({});
  // Re-import licenseService and reset its mock
  const licenseService = require('../src/services/licenseService');
  licenseService.isFeatureEnabled.mockReturnValue(true);
}

beforeEach(resetMocks);

// ─── Pure function tests (no DB) ─────────────────────────────────────────

const svc = require('../src/services/autoPauseAdjust');

describe('autoPauseAdjust — constants + clampers', () => {
  test('exports expected defaults', () => {
    expect(svc.DEFAULT_MIN_BOTS).toBe(15);
    expect(svc.DEFAULT_MAX_BOTS).toBe(25);
    expect(svc.DEFAULT_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(svc.DEFAULT_KC_STEP).toBe(0.1);
    expect(svc.DEFAULT_VOL_STEP).toBe(100_000);
  });

  test('exports schema-bound constants', () => {
    expect(svc.KC_MIN).toBe(0.1);
    expect(svc.KC_MAX).toBe(50);
    expect(svc.VOL_MIN).toBe(0);
    expect(svc.VOL_MAX).toBe(1_000_000_000);
  });

  test('clampKc — within bounds returns same', () => {
    expect(svc.clampKc(1.5)).toBe(1.5);
    expect(svc.clampKc(0.1)).toBe(0.1);
    expect(svc.clampKc(50)).toBe(50);
  });

  test('clampKc — above max clamps to KC_MAX', () => {
    expect(svc.clampKc(100)).toBe(50);
    expect(svc.clampKc(50.0001)).toBe(50);
  });

  test('clampKc — below min clamps to KC_MIN', () => {
    expect(svc.clampKc(0.05)).toBe(0.1);
    expect(svc.clampKc(-5)).toBe(0.1);
  });

  test('clampKc — NaN / non-finite → null', () => {
    expect(svc.clampKc(NaN)).toBeNull();
    expect(svc.clampKc('abc')).toBeNull();
    expect(svc.clampKc(null)).toBeNull();
    expect(svc.clampKc(undefined)).toBeNull();
  });

  test('clampVol — within bounds returns same', () => {
    expect(svc.clampVol(500_000)).toBe(500_000);
    expect(svc.clampVol(0)).toBe(0);
    expect(svc.clampVol(1_000_000_000)).toBe(1_000_000_000);
  });

  test('clampVol — above max clamps to VOL_MAX', () => {
    expect(svc.clampVol(2_000_000_000)).toBe(1_000_000_000);
  });

  test('clampVol — below min clamps to VOL_MIN', () => {
    expect(svc.clampVol(-100)).toBe(0);
  });

  test('clampVol — NaN → null', () => {
    expect(svc.clampVol(NaN)).toBeNull();
  });
});

describe('autoPauseAdjust — ADJUST_* operational bounds (FIX-2026-08-29)', () => {
  test('exports tighter ADJUST_KC bounds', () => {
    expect(svc.ADJUST_KC_MIN).toBe(0.8);
    expect(svc.ADJUST_KC_MAX).toBe(2.8);
  });

  test('exports tighter ADJUST_VOL bounds', () => {
    expect(svc.ADJUST_VOL_MIN).toBe(100_000);
    expect(svc.ADJUST_VOL_MAX).toBe(2_800_000);
  });

  test('clampAdjustKc — within ADJUST bounds returns same', () => {
    expect(svc.clampAdjustKc(1.5)).toBe(1.5);
    expect(svc.clampAdjustKc(0.8)).toBe(0.8);
    expect(svc.clampAdjustKc(2.8)).toBe(2.8);
  });

  test('clampAdjustKc — above ADJUST_KC_MAX clamps to 2.8', () => {
    expect(svc.clampAdjustKc(5)).toBe(2.8);
    expect(svc.clampAdjustKc(50)).toBe(2.8);
    expect(svc.clampAdjustKc(2.8001)).toBe(2.8);
  });

  test('clampAdjustKc — below ADJUST_KC_MIN clamps to 0.8', () => {
    expect(svc.clampAdjustKc(0.5)).toBe(0.8);
    expect(svc.clampAdjustKc(0)).toBe(0.8);
  });

  test('clampAdjustKc — NaN / non-finite → null', () => {
    expect(svc.clampAdjustKc(NaN)).toBeNull();
    expect(svc.clampAdjustKc('abc')).toBeNull();
    expect(svc.clampAdjustKc(null)).toBeNull();
  });

  test('clampAdjustVol — within ADJUST bounds returns same', () => {
    expect(svc.clampAdjustVol(500_000)).toBe(500_000);
    expect(svc.clampAdjustVol(100_000)).toBe(100_000);
    expect(svc.clampAdjustVol(2_800_000)).toBe(2_800_000);
  });

  test('clampAdjustVol — above ADJUST_VOL_MAX clamps to 2.8M', () => {
    expect(svc.clampAdjustVol(5_000_000)).toBe(2_800_000);
    expect(svc.clampAdjustVol(1_000_000_000)).toBe(2_800_000);
  });

  test('clampAdjustVol — below ADJUST_VOL_MIN clamps to 100k', () => {
    expect(svc.clampAdjustVol(50_000)).toBe(100_000);
    expect(svc.clampAdjustVol(0)).toBe(100_000);
  });

  test('clampAdjustVol — NaN → null', () => {
    expect(svc.clampAdjustVol(NaN)).toBeNull();
  });
});

describe('autoPauseAdjust.decideAdjustment — pure decision', () => {
  test('tighten: running > maxBots → positive deltas', () => {
    const d = svc.decideAdjustment({
      runningBots: 28, minBots: 15, maxBots: 25, kcStep: 0.1, volStep: 100_000,
    });
    expect(d.action).toBe('tighten');
    expect(d.deltaKc).toBe(0.1);
    expect(d.deltaVol).toBe(100_000);
    expect(d.reason).toMatch(/running=28 > max=25/);
  });

  test('loosen: running < minBots → negative deltas', () => {
    const d = svc.decideAdjustment({
      runningBots: 8, minBots: 15, maxBots: 25, kcStep: 0.1, volStep: 100_000,
    });
    expect(d.action).toBe('loosen');
    expect(d.deltaKc).toBe(-0.1);
    expect(d.deltaVol).toBe(-100_000);
    expect(d.reason).toMatch(/running=8 < min=15/);
  });

  test('none: running in [minBots, maxBots] → zero deltas', () => {
    const d = svc.decideAdjustment({
      runningBots: 20, minBots: 15, maxBots: 25, kcStep: 0.1, volStep: 100_000,
    });
    expect(d.action).toBe('none');
    expect(d.deltaKc).toBe(0);
    expect(d.deltaVol).toBe(0);
  });

  test('boundary: running === maxBots → none (not tighten)', () => {
    const d = svc.decideAdjustment({
      runningBots: 25, minBots: 15, maxBots: 25, kcStep: 0.1, volStep: 100_000,
    });
    expect(d.action).toBe('none');
  });

  test('boundary: running === minBots → none (not loosen)', () => {
    const d = svc.decideAdjustment({
      runningBots: 15, minBots: 15, maxBots: 25, kcStep: 0.1, volStep: 100_000,
    });
    expect(d.action).toBe('none');
  });

  test('NaN guards — runningBots undefined → treats as 0 (loosen)', () => {
    const d = svc.decideAdjustment({
      minBots: 15, maxBots: 25, kcStep: 0.1, volStep: 100_000,
    });
    expect(d.action).toBe('loosen');
  });

  test('uses defaults when only runningBots provided', () => {
    const d = svc.decideAdjustment({ runningBots: 100 });
    expect(d.action).toBe('tighten');
    expect(d.deltaKc).toBe(0.1); // DEFAULT_KC_STEP
    expect(d.deltaVol).toBe(100_000); // DEFAULT_VOL_STEP
  });
});

// ─── Service integration tests (with mocks) ──────────────────────────────

describe('autoPauseAdjust — singleton service', () => {
  test('singleton instance has expected methods', () => {
    expect(typeof svc.start).toBe('function');
    expect(typeof svc.stop).toBe('function');
    expect(typeof svc.reloadConfig).toBe('function');
    expect(typeof svc.runOnce).toBe('function');
    expect(typeof svc.getStatus).toBe('function');
  });

  test('getStatus() returns expected shape', async () => {
    await svc.start();
    const s = svc.getStatus();
    expect(s).toHaveProperty('running');
    expect(s).toHaveProperty('timerInstalled');
    expect(s).toHaveProperty('inFlight');
    expect(s).toHaveProperty('config');
    expect(s.config).toHaveProperty('enabled');
    expect(s.config).toHaveProperty('minBots');
    expect(s.config).toHaveProperty('maxBots');
    svc.stop();
  });

  test('start() when master disabled → does not install timer', async () => {
    setMasterConfig({ autoPauseAdjustEnabled: false });
    await svc.start();
    const s = svc.getStatus();
    expect(s.running).toBe(true);
    expect(s.timerInstalled).toBe(false);
    svc.stop();
  });

  test('start() when master enabled → installs timer', async () => {
    setMasterConfig({
      autoPauseAdjustEnabled: true,
      autoPauseAdjustIntervalMs: 60_000,
    });
    await svc.start();
    const s = svc.getStatus();
    expect(s.running).toBe(true);
    expect(s.timerInstalled).toBe(true);
    expect(s.config.intervalMs).toBe(60_000);
    svc.stop();
  });

  test('reloadConfig() picks up new intervalMs', async () => {
    setMasterConfig({ autoPauseAdjustEnabled: true, autoPauseAdjustIntervalMs: 60_000 });
    await svc.start();
    expect(svc.getStatus().config.intervalMs).toBe(60_000);

    // Simulate user changing interval to 120s
    setMasterConfig({ autoPauseAdjustEnabled: true, autoPauseAdjustIntervalMs: 120_000 });
    await svc.reloadConfig();
    expect(svc.getStatus().config.intervalMs).toBe(120_000);
    expect(svc.getStatus().timerInstalled).toBe(true);
    svc.stop();
  });

  test('reloadConfig() when toggled off → clears timer', async () => {
    setMasterConfig({ autoPauseAdjustEnabled: true });
    await svc.start();
    expect(svc.getStatus().timerInstalled).toBe(true);

    setMasterConfig({ autoPauseAdjustEnabled: false });
    await svc.reloadConfig();
    expect(svc.getStatus().timerInstalled).toBe(false);
    svc.stop();
  });
});

describe('autoPauseAdjust.runOnce — control flow', () => {
  beforeEach(async () => {
    // Default: enabled, running in range (no action)
    setMasterConfig({ autoPauseAdjustEnabled: true });
    await svc.start();
  });
  afterEach(() => svc.stop());

  test('skipped when master disabled', async () => {
    await svc.stop();
    setMasterConfig({ autoPauseAdjustEnabled: false });
    await svc.start();
    const result = await svc.runOnce({ source: 'manual' });
    expect(result).toEqual({ skipped: 'disabled' });
    expect(mockBot.bulkWrite).not.toHaveBeenCalled();
  });

  test('skipped when license feature disabled', async () => {
    const licenseService = require('../src/services/licenseService');
    licenseService.isFeatureEnabled.mockReturnValue(false);
    const result = await svc.runOnce({ source: 'manual' });
    expect(result).toEqual({ skipped: 'license-disabled' });
    expect(mockBot.bulkWrite).not.toHaveBeenCalled();
  });

  test('skipped when in-flight (concurrent run)', async () => {
    // Set up a slow bulkWrite that lets us trigger a second tick
    let resolveBulk;
    mockBot.bulkWrite.mockImplementation(() => new Promise((res) => { resolveBulk = res; }));
    setRunningBots(30); // > max → tighten
    setEligibleBots([{ _id: 'b1', autoPauseMinKcPct: 1.3, autoPauseMin24hVolUsdt: 500_000 }]);

    // Kick off first runOnce — it will pause at bulkWrite (waiting on our Promise).
    // Wait for first to settle at bulkWrite (it may need a few awaits: loadConfig, countDocuments, find, bulkWrite).
    const first = svc.runOnce({ source: 'manual' });
    // Use a microtask loop to advance first through its awaits until it suspends at bulkWrite.
    for (let i = 0; i < 10 && typeof resolveBulk !== 'function'; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    // Now first is in-flight at bulkWrite; second should be skipped.
    const second = await svc.runOnce({ source: 'manual' });
    expect(second).toEqual({ skipped: 'in-flight' });

    expect(typeof resolveBulk).toBe('function');
    resolveBulk({ modifiedCount: 1 });
    const firstResult = await first;
    expect(firstResult.action).toBe('tighten');
    expect(firstResult.updatedBots).toBe(1);
  });
});

describe('autoPauseAdjust.runOnce — decision branches', () => {
  beforeEach(async () => {
    setMasterConfig({ autoPauseAdjustEnabled: true });
    await svc.start();
  });
  afterEach(() => svc.stop());

  test('tighten path: 28 running > 25 max → bulkWrite with +0.1 KC / +100k vol', async () => {
    setRunningBots(28);
    setEligibleBots([
      { _id: 'b1', autoPauseMinKcPct: 1.3, autoPauseMin24hVolUsdt: 500_000 },
      { _id: 'b2', autoPauseMinKcPct: 2.0, autoPauseMin24hVolUsdt: 800_000 },
    ]);
    mockBot.bulkWrite.mockResolvedValue({ modifiedCount: 2 });

    const stats = await svc.runOnce({ source: 'manual' });
    expect(stats.action).toBe('tighten');
    expect(stats.updatedBots).toBe(2);
    expect(stats.deltaKc).toBe(0.1);
    expect(stats.deltaVol).toBe(100_000);
    expect(stats.runningBots).toBe(28);

    // Inspect the bulkWrite ops
    expect(mockBot.bulkWrite).toHaveBeenCalledTimes(1);
    const ops = mockBot.bulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(2);
    expect(ops[0].updateOne.update.$set.autoPauseMinKcPct).toBeCloseTo(1.4);
    expect(ops[0].updateOne.update.$set.autoPauseMin24hVolUsdt).toBe(600_000);
    expect(ops[1].updateOne.update.$set.autoPauseMinKcPct).toBeCloseTo(2.1);
    expect(ops[1].updateOne.update.$set.autoPauseMin24hVolUsdt).toBe(900_000);

    // EventBus emit only when updatedBots > 0
    const eventBus = require('../src/services/eventBus');
    expect(eventBus.emit).toHaveBeenCalledWith('autoPauseAdjust:applied', expect.objectContaining({
      action: 'tighten', updatedBots: 2,
    }));
  });

  test('loosen path: 8 running < 15 min → bulkWrite with -0.1 KC / -100k vol', async () => {
    setRunningBots(8);
    setEligibleBots([
      { _id: 'b1', autoPauseMinKcPct: 1.3, autoPauseMin24hVolUsdt: 500_000 },
    ]);
    mockBot.bulkWrite.mockResolvedValue({ modifiedCount: 1 });

    const stats = await svc.runOnce({ source: 'manual' });
    expect(stats.action).toBe('loosen');
    expect(stats.deltaKc).toBe(-0.1);
    expect(stats.deltaVol).toBe(-100_000);
    expect(stats.updatedBots).toBe(1);

    const ops = mockBot.bulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.update.$set.autoPauseMinKcPct).toBeCloseTo(1.2);
    expect(ops[0].updateOne.update.$set.autoPauseMin24hVolUsdt).toBe(400_000);
  });

  test('no-op: 20 running in [15,25] → no bulkWrite, no event', async () => {
    setRunningBots(20);
    const stats = await svc.runOnce({ source: 'manual' });
    expect(stats.action).toBeNull();
    expect(stats.updatedBots).toBe(0);
    expect(mockBot.bulkWrite).not.toHaveBeenCalled();

    const eventBus = require('../src/services/eventBus');
    expect(eventBus.emit).not.toHaveBeenCalledWith('autoPauseAdjust:applied', expect.anything());
  });

  test('eligible-empty: no opted-in bots → no bulkWrite', async () => {
    setRunningBots(30);
    setEligibleBots([]);
    const stats = await svc.runOnce({ source: 'manual' });
    expect(stats.action).toBe('tighten');
    expect(stats.updatedBots).toBe(0);
    expect(stats.eligibleBots).toBe(0);
    expect(mockBot.bulkWrite).not.toHaveBeenCalled();
  });
});

describe('autoPauseAdjust.runOnce — eligibility filter', () => {
  beforeEach(async () => {
    setMasterConfig({ autoPauseAdjustEnabled: true });
    await svc.start();
  });
  afterEach(() => svc.stop());

  test('find() query excludes opted-out bots (autoPauseAdjustEnabled !== false + autoPauseEnabled !== false + !deletedAt)', async () => {
    setRunningBots(30);
    setEligibleBots([]);
    await svc.runOnce({ source: 'manual' });
    expect(mockBot.find).toHaveBeenCalledTimes(1);
    const filter = mockBot.find.mock.calls[0][0];
    expect(filter).toEqual({
      autoPauseEnabled: { $ne: false },
      autoPauseAdjustEnabled: { $ne: false },
      deletedAt: null,
    });
  });

  test('runningBots count excludes deleted/disabled', async () => {
    setRunningBots(30);
    setEligibleBots([]);
    await svc.runOnce({ source: 'manual' });
    expect(mockBot.countDocuments).toHaveBeenCalledTimes(1);
    const filter = mockBot.countDocuments.mock.calls[0][0];
    expect(filter).toEqual({
      enabled: { $ne: false },
      autoPauseEnabled: { $ne: false },
      deletedAt: null,
    });
  });
});

describe('autoPauseAdjust.runOnce — clamp behavior', () => {
  beforeEach(async () => {
    setMasterConfig({ autoPauseAdjustEnabled: true });
    await svc.start();
  });
  afterEach(() => svc.stop());

  test('clamps KC at ADJUST_KC_MAX (2.8) — only vol field updates (updatedBots=1)', async () => {
    // Bot at KC=2.8 (ADJUST max). Tighten +0.1 → clamps to 2.8 (no change). Vol updates fine.
    setRunningBots(30);
    setEligibleBots([
      { _id: 'b-max', autoPauseMinKcPct: 2.8, autoPauseMin24hVolUsdt: 1_500_000 },
    ]);
    mockBot.bulkWrite.mockResolvedValue({ modifiedCount: 1 });

    const stats = await svc.runOnce({ source: 'manual' });
    expect(stats.action).toBe('tighten');
    expect(stats.updatedBots).toBe(1); // vol still changed → bot still written

    const ops = mockBot.bulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.update.$set.autoPauseMinKcPct).toBe(2.8); // unchanged (clamped)
    expect(ops[0].updateOne.update.$set.autoPauseMin24hVolUsdt).toBe(1_600_000); // +100k
  });

  test('clamps VOL at ADJUST_VOL_MAX (2.8M) — only KC field updates (updatedBots=1)', async () => {
    setRunningBots(30);
    setEligibleBots([
      { _id: 'b-volmax', autoPauseMinKcPct: 1.3, autoPauseMin24hVolUsdt: 2_800_000 },
    ]);
    mockBot.bulkWrite.mockResolvedValue({ modifiedCount: 1 });

    const stats = await svc.runOnce({ source: 'manual' });
    expect(stats.action).toBe('tighten');
    expect(stats.updatedBots).toBe(1);

    const ops = mockBot.bulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.update.$set.autoPauseMinKcPct).toBeCloseTo(1.4);
    expect(ops[0].updateOne.update.$set.autoPauseMin24hVolUsdt).toBe(2_800_000); // unchanged (clamped)
  });

  test('skips bots where BOTH fields at ADJUST clamps (no-op write)', async () => {
    setRunningBots(30);
    setEligibleBots([
      { _id: 'b-both', autoPauseMinKcPct: 2.8, autoPauseMin24hVolUsdt: 2_800_000 },
    ]);

    const stats = await svc.runOnce({ source: 'manual' });
    expect(stats.action).toBe('tighten');
    expect(stats.updatedBots).toBe(0);
    expect(stats.skippedClamped).toBe(1);
    expect(mockBot.bulkWrite).not.toHaveBeenCalled(); // empty ops array → no bulkWrite
  });

  test('skips bots at ADJUST_KC_MIN (0.8) when loosening (only vol updates → updatedBots=1)', async () => {
    setRunningBots(8);
    setEligibleBots([
      { _id: 'b-kcmin', autoPauseMinKcPct: 0.8, autoPauseMin24hVolUsdt: 500_000 },
    ]);
    mockBot.bulkWrite.mockResolvedValue({ modifiedCount: 1 });

    const stats = await svc.runOnce({ source: 'manual' });
    expect(stats.action).toBe('loosen');
    expect(stats.updatedBots).toBe(1);

    const ops = mockBot.bulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.update.$set.autoPauseMinKcPct).toBe(0.8); // unchanged (clamped)
    expect(ops[0].updateOne.update.$set.autoPauseMin24hVolUsdt).toBe(400_000);
  });
});

describe('autoPauseAdjust.runOnce — telemetry persistence', () => {
  beforeEach(async () => {
    setMasterConfig({ autoPauseAdjustEnabled: true });
    await svc.start();
  });
  afterEach(() => svc.stop());

  test('persists scheduler-level telemetry to AppConfig after tick', async () => {
    setRunningBots(30);
    setEligibleBots([{ _id: 'b1', autoPauseMinKcPct: 1.3, autoPauseMin24hVolUsdt: 500_000 }]);
    mockBot.bulkWrite.mockResolvedValue({ modifiedCount: 1 });

    await svc.runOnce({ source: 'manual' });

    expect(mockAppConfig.updateOne).toHaveBeenCalled();
    const updateArg = mockAppConfig.updateOne.mock.calls[0][1];
    expect(updateArg.$set).toHaveProperty('autoPauseAdjustLastRunAt');
    expect(updateArg.$set).toHaveProperty('autoPauseAdjustLastStats');
    expect(updateArg.$set).toHaveProperty('autoPauseAdjustLastError', null);
    expect(updateArg.$set.autoPauseAdjustLastStats.action).toBe('tighten');
  });

  test('writes per-bot telemetry (lastCheckedAt + lastActionAt + lastStats)', async () => {
    setRunningBots(30);
    setEligibleBots([{ _id: 'b1', autoPauseMinKcPct: 1.3, autoPauseMin24hVolUsdt: 500_000 }]);
    mockBot.bulkWrite.mockResolvedValue({ modifiedCount: 1 });

    await svc.runOnce({ source: 'manual' });

    const ops = mockBot.bulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.update.$set).toHaveProperty('autoPauseAdjustLastCheckedAt');
    expect(ops[0].updateOne.update.$set).toHaveProperty('autoPauseAdjustLastActionAt');
    expect(ops[0].updateOne.update.$set.autoPauseAdjustLastStats).toEqual({
      runningBots: 30,
      action: 'tighten',
      deltaKc: 0.1,
      deltaVol: 100_000,
      prevKc: 1.3,
      prevVol: 500_000,
      newKc: 1.4,
      newVol: 600_000,
    });
  });
});
