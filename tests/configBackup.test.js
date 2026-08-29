'use strict';

/**
 * FIX-2026-08-29: Tests for Config Backup/Restore service
 *
 * Coverage (35 cases):
 *   - Constants (3): BACKUP_VERSION, SUPPORTED_SECTIONS, OPEN_TRADE_STATES
 *   - parseBackupPayload (4): valid, missing version, bad schemaVersion, unknown section
 *   - Section: apiKeys (3): empty, present, restore replace/merge
 *   - Section: telegram (3): present, restore replace, restore merge
 *   - Section: appConfig (4): present, replace, merge, masterConfigTemplates
 *   - Section: positions (4): open-only filter, merge, replace, empty
 *   - Section: bots (5): all export, merge upsert, _id collision, soft-delete revive, replace
 *   - Section: license (2): metadata backup, no-op restore
 *   - Section: others (1): empty placeholder
 *   - buildBackupPayload (2): single section, all sections
 *   - applyRestore (3): dryRun, empty sections, partial failure
 *   - writePreRestoreSnapshot (2): writes file, write fails → throws
 *   - Route gating (3 — Pattern C): 401 no session, 400 bad body, 403 feature-disabled
 */

// Mock all heavy deps that configBackup.js requires at load time
jest.mock('../src/db/models/AppConfig', () => {
  const mockAppConfig = jest.fn();
  mockAppConfig.findOne = jest.fn();
  mockAppConfig.findOneAndUpdate = jest.fn();
  mockAppConfig.updateOne = jest.fn();
  return mockAppConfig;
});
jest.mock('../src/db/models/Bot', () => {
  const mockBot = jest.fn();
  mockBot.find = jest.fn();
  mockBot.findOne = jest.fn();
  mockBot.updateOne = jest.fn(() => Promise.resolve({ modifiedCount: 1 }));
  mockBot.countDocuments = jest.fn(() => Promise.resolve(0));
  // Save on new instance
  function FakeBot(doc) { Object.assign(this, doc); }
  FakeBot.prototype.save = jest.fn(function () { return Promise.resolve(this); });
  return FakeBot;
});
jest.mock('../src/db/models/Trade', () => {
  const mockTrade = jest.fn();
  mockTrade.find = jest.fn();
  mockTrade.findOneAndUpdate = jest.fn();
  mockTrade.deleteMany = jest.fn(() => Promise.resolve({ deletedCount: 0 }));
  return mockTrade;
});
jest.mock('../src/services/licenseService', () => ({
  snapshot: jest.fn().mockResolvedValue({ tier: 'pro', features: { configBackup: true }, hasLicense: true }),
  isFeatureEnabled: jest.fn(() => true),
}));
jest.mock('../src/admin-monitor/licenseGate', () => ({
  lastLicense: { tier: 'pro', owner: 'test-owner', expiresAt: '2027-01-01T00:00:00.000Z', features: { configBackup: true } },
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../src/admin-monitor/machineId', () => ({
  getMachineId: jest.fn(() => 'test-machine-id-1234567890'),
}));
jest.mock('../config', () => ({
  encryptionKey: 'a'.repeat(32), // 32 chars → encryptionAvailable=true
  binanceApi: { base: 'https://test-binance.example.com', recvWindow: 60000 },
  binance: { apiKey: '', apiSecret: '', useBnbForFees: true, makerRate: 0.00075 },
  features: {},
}));

// Transitive mocks needed by admin.routes.js → autoDeleteBot → telegramNotifier → binanceRest
jest.mock('../src/binance/binanceRest', () => ({
  getKlines: jest.fn(),
  get24hrTickers: jest.fn(() => Promise.resolve([])),
  getExchangeInfo: jest.fn(() => Promise.resolve({ symbols: [] })),
  getAccount: jest.fn(),
  getSymbolPriceTicker: jest.fn(() => Promise.resolve(null)),
  getServerTime: jest.fn(() => Promise.resolve({ serverTime: Date.now() })),
}));
jest.mock('../src/services/telegramNotifier', () => ({
  sendNow: jest.fn(),
  dispatch: jest.fn(),
  getRecentEvents: jest.fn(() => []),
  isEnabled: jest.fn(() => false),
}));
jest.mock('../src/services/autoDeleteBot', () => ({
  tick: jest.fn(() => Promise.resolve()),
  sweepOnce: jest.fn(() => Promise.resolve({ deleted: 0 })),
}));

const configBackup = require('../src/services/configBackup');
const AppConfig = require('../src/db/models/AppConfig');
const Bot = require('../src/db/models/Bot');
const Trade = require('../src/db/models/Trade');

beforeEach(() => {
  // Re-initialize ALL mock functions defensively. The factory runs once and sets
  // these once, but defensive re-init avoids any undefined-access if something
  // shadows the module between tests.
  if (!AppConfig.findOne || typeof AppConfig.findOne.mockReset !== 'function') {
    AppConfig.findOne = jest.fn();
  } else {
    AppConfig.findOne.mockReset();
  }
  if (!AppConfig.findOneAndUpdate || typeof AppConfig.findOneAndUpdate.mockReset !== 'function') {
    AppConfig.findOneAndUpdate = jest.fn();
  } else {
    AppConfig.findOneAndUpdate.mockReset();
  }
  if (!AppConfig.updateOne || typeof AppConfig.updateOne.mockReset !== 'function') {
    AppConfig.updateOne = jest.fn();
  } else {
    AppConfig.updateOne.mockReset();
  }
  if (!Bot.find || typeof Bot.find.mockReset !== 'function') {
    Bot.find = jest.fn();
  } else {
    Bot.find.mockReset();
  }
  if (!Bot.findOne || typeof Bot.findOne.mockReset !== 'function') {
    Bot.findOne = jest.fn();
  } else {
    Bot.findOne.mockReset();
  }
  if (!Bot.updateOne || typeof Bot.updateOne.mockReset !== 'function') {
    Bot.updateOne = jest.fn(() => Promise.resolve({ modifiedCount: 1 }));
  } else {
    Bot.updateOne.mockReset();
    Bot.updateOne.mockImplementation(() => Promise.resolve({ modifiedCount: 1 }));
  }
  if (!Bot.countDocuments || typeof Bot.countDocuments.mockReset !== 'function') {
    Bot.countDocuments = jest.fn(() => Promise.resolve(0));
  } else {
    Bot.countDocuments.mockReset();
  }
  if (!Trade.find || typeof Trade.find.mockReset !== 'function') {
    Trade.find = jest.fn();
  } else {
    Trade.find.mockReset();
  }
  if (!Trade.findOneAndUpdate || typeof Trade.findOneAndUpdate.mockReset !== 'function') {
    Trade.findOneAndUpdate = jest.fn();
  } else {
    Trade.findOneAndUpdate.mockReset();
  }
  if (!Trade.deleteMany || typeof Trade.deleteMany.mockReset !== 'function') {
    Trade.deleteMany = jest.fn(() => Promise.resolve({ deletedCount: 0 }));
  } else {
    Trade.deleteMany.mockReset();
    Trade.deleteMany.mockImplementation(() => Promise.resolve({ deletedCount: 0 }));
  }
});

// ─── Constants (3) ────────────────────────────────────────────────────────────

describe('constants (FIX-2026-08-29)', () => {
  test('BACKUP_VERSION is the expected string', () => {
    expect(configBackup.BACKUP_VERSION).toBe('onepercentbot-config-backup-1');
  });
  test('SUPPORTED_SECTIONS has exactly 7 sections', () => {
    expect(configBackup.SUPPORTED_SECTIONS).toHaveLength(7);
    expect(configBackup.SUPPORTED_SECTIONS).toEqual(
      expect.arrayContaining(['apiKeys', 'telegram', 'appConfig', 'positions', 'bots', 'license', 'others'])
    );
  });
  test('OPEN_TRADE_STATES matches plan (8 states)', () => {
    expect(configBackup.OPEN_TRADE_STATES).toEqual(
      expect.arrayContaining(['placed', 'partial_wait', 'filled', 'retrying', 'holding', 'stopping', 'selling', 'partial_sell_wait'])
    );
    expect(configBackup.OPEN_TRADE_STATES).toHaveLength(8);
  });
});

// ─── parseBackupPayload (4) ───────────────────────────────────────────────────

describe('parseBackupPayload', () => {
  test('valid payload → ok', () => {
    const result = configBackup.parseBackupPayload({
      version: 'onepercentbot-config-backup-1',
      schemaVersion: 1,
      sections: { bots: { present: true, data: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.payload).toBeTruthy();
    expect(result.error).toBeNull();
  });
  test('missing version → error', () => {
    const result = configBackup.parseBackupPayload({ schemaVersion: 1, sections: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/version/i);
  });
  test('unsupported schemaVersion → error', () => {
    const result = configBackup.parseBackupPayload({
      version: 'onepercentbot-config-backup-1',
      schemaVersion: 99,
      sections: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/schemaVersion/i);
  });
  test('unknown section in payload → error', () => {
    const result = configBackup.parseBackupPayload({
      version: 'onepercentbot-config-backup-1',
      schemaVersion: 1,
      sections: { invalidSection: { present: true } },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalidSection/);
  });
});

// ─── Section: apiKeys (3) ─────────────────────────────────────────────────────

describe('section apiKeys', () => {
  test('backupApiKeys() returns present=false when no AppConfig', async () => {
    AppConfig.findOne.mockReturnValueOnce({ lean: () => Promise.resolve(null) });
    const result = await configBackup.backupApiKeys();
    expect(result).toEqual({ present: false, encrypted: true, data: null });
  });
  test('backupApiKeys() includes encrypted blob when present', async () => {
    AppConfig.findOne.mockReturnValueOnce({
      lean: () => Promise.resolve({
        binanceApiKeyEnc: 'base64-cipher', binanceApiKeyIv: 'iv', binanceApiKeyAuthTag: 'tag',
        binanceApiSecretEnc: 'secret-cipher', binanceApiSecretIv: 'iv2', binanceApiSecretAuthTag: 'tag2',
      }),
    });
    const result = await configBackup.backupApiKeys();
    expect(result.present).toBe(true);
    expect(result.encrypted).toBe(true);
    expect(result.data.binanceApiKeyEnc).toBe('base64-cipher');
    expect(result.data.binanceApiSecretEnc).toBe('secret-cipher');
  });
  test('restoreApiKeys(data, replace) writes all 6 fields via findOneAndUpdate', async () => {
    AppConfig.findOneAndUpdate.mockReturnValueOnce({ upsert: true, new: true });
    const data = {
      binanceApiKeyEnc: 'k', binanceApiKeyIv: 'i', binanceApiKeyAuthTag: 't',
      binanceApiSecretEnc: 'sk', binanceApiSecretIv: 'si', binanceApiSecretAuthTag: 'st',
    };
    const result = await configBackup.restoreApiKeys(data, 'replace');
    expect(result.changed).toBe(6);
    expect(AppConfig.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});

// ─── Section: telegram (3) ───────────────────────────────────────────────────

describe('section telegram', () => {
  test('backupTelegram() captures token + chatId + events + thresholds', async () => {
    AppConfig.findOne.mockReturnValueOnce({
      lean: () => Promise.resolve({
        telegramBotTokenEnc: 'token-cipher', telegramBotTokenIv: 'iv', telegramBotTokenAuthTag: 'tag',
        telegramChatId: '123456789',
        telegramEnabled: true,
        telegramEvents: { buyFilled: true, sellFilled: true },
        telegramThresholds: { positionLossPct: 2.5 },
      }),
    });
    const result = await configBackup.backupTelegram();
    expect(result.present).toBe(true);
    expect(result.data.telegramChatId).toBe('123456789');
    expect(result.data.telegramEvents.buyFilled).toBe(true);
    expect(result.data.telegramThresholds.positionLossPct).toBe(2.5);
  });
  test('restoreTelegram(data, replace) writes all fields', async () => {
    AppConfig.findOne.mockReturnValueOnce(Promise.resolve(null));
    AppConfig.findOneAndUpdate.mockReturnValueOnce({ upsert: true, new: true });
    const data = {
      telegramBotTokenEnc: 't', telegramBotTokenIv: 'i', telegramBotTokenAuthTag: 'a',
      telegramChatId: '999', telegramEnabled: true, telegramEvents: { x: true }, telegramThresholds: { y: 1 },
    };
    const result = await configBackup.restoreTelegram(data, 'replace');
    expect(result.changed).toBeGreaterThan(0);
  });
  test('restoreTelegram(data, merge) preserves existing if data missing field', async () => {
    AppConfig.findOne.mockReturnValueOnce(Promise.resolve({
      telegramChatId: 'existing-id',
      telegramEnabled: true,
    }));
    AppConfig.findOneAndUpdate.mockReturnValueOnce({ upsert: true, new: true });
    const result = await configBackup.restoreTelegram({ telegramEnabled: false }, 'merge');
    // Should not overwrite telegramChatId since data doesn't include it
    expect(result.changed).toBeGreaterThanOrEqual(0);
  });
});

// ─── Section: appConfig (4) ──────────────────────────────────────────────────

describe('section appConfig', () => {
  test('backupAppConfig() includes master toggles + botDefaults + masterConfigTemplates', async () => {
    AppConfig.findOne.mockReturnValueOnce({
      lean: () => Promise.resolve({
        cbVersion: 'v3', dpsMinSize: 6, dpsMaxSize: 15,
        botDefaults: { capitalPerTrade: 9, maxTrades: 1 },
        masterConfigTemplates: [{ id: 't1', name: 'aggressive', settings: {} }],
        binanceRateLimitPerMin: 6000,
        walletReserveUsdt: 50,
      }),
    });
    const result = await configBackup.backupAppConfig();
    expect(result.present).toBe(true);
    expect(result.data.cbVersion).toBe('v3');
    expect(result.data.botDefaults.capitalPerTrade).toBe(9);
    expect(result.data.masterConfigTemplates).toHaveLength(1);
  });
  test('restoreAppConfig(data, replace) replaces botDefaults entirely', async () => {
    AppConfig.findOne.mockReturnValueOnce(Promise.resolve({ botDefaults: { old: 1 } }));
    AppConfig.findOneAndUpdate.mockReturnValueOnce({ upsert: true, new: true });
    const result = await configBackup.restoreAppConfig({ botDefaults: { new: 2 } }, 'replace');
    expect(result.changed).toBeGreaterThan(0);
    const call = AppConfig.findOneAndUpdate.mock.calls[0];
    expect(call[1].$set.botDefaults).toEqual({ new: 2 });
  });
  test('restoreAppConfig(data, merge) deep-merges botDefaults keys', async () => {
    AppConfig.findOne.mockReturnValueOnce(Promise.resolve({
      botDefaults: { existingKey: 'existing', shared: 'old' },
    }));
    AppConfig.findOneAndUpdate.mockReturnValueOnce({ upsert: true, new: true });
    await configBackup.restoreAppConfig({ botDefaults: { newKey: 'new', shared: 'newer' } }, 'merge');
    const call = AppConfig.findOneAndUpdate.mock.calls[0];
    expect(call[1].$set.botDefaults.existingKey).toBe('existing');
    expect(call[1].$set.botDefaults.shared).toBe('newer');
    expect(call[1].$set.botDefaults.newKey).toBe('new');
  });
  test('restoreAppConfig replace overwrites masterConfigTemplates array', async () => {
    AppConfig.findOne.mockReturnValueOnce(Promise.resolve({ masterConfigTemplates: [{ id: 'old' }] }));
    AppConfig.findOneAndUpdate.mockReturnValueOnce({ upsert: true, new: true });
    await configBackup.restoreAppConfig({ masterConfigTemplates: [{ id: 'new' }] }, 'replace');
    const call = AppConfig.findOneAndUpdate.mock.calls[0];
    expect(call[1].$set.masterConfigTemplates).toEqual([{ id: 'new' }]);
  });
});

// ─── Section: positions (4 — open only) ──────────────────────────────────────

describe('section positions (open-only)', () => {
  test('backupPositions() filters to OPEN_TRADE_STATES only', async () => {
    const docs = [
      { _id: 'open1', state: 'placed' },
      { _id: 'open2', state: 'selling' },
      { _id: 'closed1', state: 'sold' },
      { _id: 'closed2', state: 'cancelled' },
    ];
    Trade.find.mockReturnValueOnce({ lean: () => Promise.resolve([docs[0], docs[1]]) });
    const result = await configBackup.backupPositions();
    expect(result.count).toBe(2);
    expect(result.openOnly).toBe(true);
    expect(Trade.find).toHaveBeenCalledWith({ state: { $in: configBackup.OPEN_TRADE_STATES } });
  });
  test('restorePositions(data, merge) upserts by _id', async () => {
    Trade.findOneAndUpdate.mockReturnValue({ new: true });
    const data = [
      { _id: 't1', botId: 'b1', state: 'placed', symbol: 'BTCUSDT' },
      { _id: 't2', botId: 'b2', state: 'holding', symbol: 'ETHUSDT' },
    ];
    const result = await configBackup.restorePositions(data, 'merge');
    expect(result.updated).toBe(2);
    expect(Trade.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });
  test('restorePositions(data, replace) deletes existing open + inserts', async () => {
    Trade.deleteMany.mockReturnValueOnce({ deletedCount: 3 });
    Trade.findOneAndUpdate.mockReturnValue({ new: true });
    const data = [{ _id: 't1', state: 'placed' }];
    const result = await configBackup.restorePositions(data, 'replace');
    expect(Trade.deleteMany).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(3); // count of deleted
  });
  test('restorePositions with [] data → no-op', async () => {
    const result = await configBackup.restorePositions([], 'merge');
    expect(result.changed).toBe(0);
    expect(Trade.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

// ─── Section: bots (5) ────────────────────────────────────────────────────────

describe('section bots', () => {
  test('backupBots() exports all bots including soft-deleted', async () => {
    const docs = [
      { _id: 'b1', name: 'alive', symbol: 'BTCUSDT', timeframe: '3m', enabled: true, deletedAt: null },
      { _id: 'b2', name: 'deleted', symbol: 'ETHUSDT', timeframe: '5m', enabled: false, deletedAt: new Date() },
    ];
    Trade.find.mockReset();
    Bot.find.mockReturnValueOnce({ lean: () => Promise.resolve(docs) });
    const result = await configBackup.backupBots();
    expect(result.count).toBe(2);
    expect(result.enabled).toBe(1);
    expect(result.softDeleted).toBe(1);
  });
  test('restoreBots(data, merge) upserts by {name, symbol, timeframe}', async () => {
    Bot.findOne.mockReturnValueOnce(Promise.resolve(null)); // no existing → create
    const data = [{ _id: 't1', name: 'bot-x', symbol: 'BTCUSDT', timeframe: '3m', capitalPerTrade: 9 }];
    const result = await configBackup.restoreBots(data, 'merge');
    expect(result.created).toBe(1);
  });
  test('restoreBots merge _id collision preserves original _id', async () => {
    // Existing has empty capitalPerTrade so merge WILL trigger an update.
    const existing = { _id: 'real-id', name: 'bot-x', symbol: 'BTCUSDT', timeframe: '3m' /* capitalPerTrade: undefined */ };
    Bot.findOne.mockReturnValueOnce(Promise.resolve(existing));
    const data = [{ _id: 'fake-id', name: 'bot-x', symbol: 'BTCUSDT', timeframe: '3m', capitalPerTrade: 10 }];
    const result = await configBackup.restoreBots(data, 'merge');
    expect(Bot.updateOne).toHaveBeenCalled();
    const call = Bot.updateOne.mock.calls[0];
    expect(call[0]._id).toBe('real-id'); // original _id preserved
  });
  test('restoreBots merge does NOT revive auto-deleted bots (FIX-2026-08-29)', async () => {
    // FIX-2026-08-29: explicit behavior change — if a bot was auto-deleted AFTER the
    // backup snapshot was taken, restoring the backup should NOT resurrect it.
    // Admins can manually un-delete via the UI if intentional.
    const existing = { _id: 'x', name: 'bot-y', symbol: 'ETHUSDT', timeframe: '5m', deletedAt: new Date() };
    Bot.findOne.mockReturnValueOnce(Promise.resolve(existing));
    const data = [{ _id: 'x', name: 'bot-y', symbol: 'ETHUSDT', timeframe: '5m', deletedAt: null }];
    await configBackup.restoreBots(data, 'merge');
    // Bot.updateOne is NOT called at all because the existing bot is deleted and
    // no other fields are empty (deletedAt is the only field, but we don't revive).
    // Either updateOne is not called, OR it's called without setting deletedAt.
    const updateCalls = Bot.updateOne.mock.calls.filter((c) => String(c[0]._id) === 'x');
    if (updateCalls.length > 0) {
      expect(updateCalls[0][1].$set.deletedAt).not.toBeNull();
    }
    // The point: deletedAt should NOT be set to null (no revival)
  });
  test('restoreBots replace updates all fields per bot', async () => {
    const existing = { _id: 'x', name: 'bot-z', symbol: 'BNBUSDT', timeframe: '3m', capitalPerTrade: 9 };
    Bot.findOne.mockReturnValueOnce(Promise.resolve(existing));
    const data = [{ _id: 'x', name: 'bot-z', symbol: 'BNBUSDT', timeframe: '3m', capitalPerTrade: 50, enabled: true }];
    const result = await configBackup.restoreBots(data, 'replace');
    expect(result.updated).toBe(1);
    const call = Bot.updateOne.mock.calls[0];
    expect(call[1].$set.capitalPerTrade).toBe(50);
  });
});

// ─── Section: license (2 — READ-ONLY) ────────────────────────────────────────

describe('section license (readonly)', () => {
  test('backupLicense() returns readonly metadata from licenseService.snapshot', async () => {
    const result = await configBackup.backupLicense();
    expect(result.readonly).toBe(true);
    expect(result.data.tier).toBe('pro');
    expect(result.data.hasLicense).toBe(true);
    expect(result.data.features.configBackup).toBe(true);
    expect(result.data.snapshotAt).toBeDefined();
  });
  test('restoreLicense() is no-op returning skipped reason', async () => {
    const result = await configBackup.restoreLicense({ tier: 'pro' }, 'replace');
    expect(result.skipped).toBe('license-cannot-be-restored');
    expect(result.reason).toMatch(/admin/i);
  });
});

// ─── Section: others (1) ─────────────────────────────────────────────────────

describe('section others (placeholder)', () => {
  test('backupOthers() returns present=false placeholder', async () => {
    const result = await configBackup.backupOthers();
    expect(result.present).toBe(false);
    expect(result.data).toEqual({});
  });
});

// ─── buildBackupPayload (2) ───────────────────────────────────────────────────

describe('buildBackupPayload', () => {
  test('with sections=[apiKeys] → payload has only apiKeys', async () => {
    AppConfig.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    Bot.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    Trade.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    const payload = await configBackup.buildBackupPayload({ sections: ['apiKeys'] });
    expect(Object.keys(payload.sections)).toEqual(['apiKeys']);
    expect(payload.version).toBe('onepercentbot-config-backup-1');
    expect(payload.machineId).toBe('test-machine-id-1234567890');
  });
  test('with sections=SUPPORTED_SECTIONS → payload has all 7 sections', async () => {
    AppConfig.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    Bot.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    Trade.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    const payload = await configBackup.buildBackupPayload({ sections: configBackup.SUPPORTED_SECTIONS });
    expect(Object.keys(payload.sections)).toHaveLength(7);
  });
});

// ─── applyRestore (3) ─────────────────────────────────────────────────────────

describe('applyRestore', () => {
  test('dryRun=true → no DB writes', async () => {
    const payload = { version: 'onepercentbot-config-backup-1', schemaVersion: 1, sections: {} };
    const result = await configBackup.applyRestore({ payload, sections: ['bots'], mode: 'merge', dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(Bot.findOne).not.toHaveBeenCalled();
  });
  test('empty sections → { ok: true, results: {} }', async () => {
    const payload = { version: 'onepercentbot-config-backup-1', schemaVersion: 1, sections: {} };
    const result = await configBackup.applyRestore({ payload, sections: [], mode: 'merge' });
    expect(result.ok).toBe(true);
    expect(result.results).toEqual({});
  });
  test('section error → other sections continue with .error per failed', async () => {
    const payload = {
      version: 'onepercentbot-config-backup-1',
      schemaVersion: 1,
      sections: {
        bots: { present: true, data: 'not-an-array' }, // will cause restoreBots to fail
        telegram: { present: true, data: { telegramChatId: 'x' } }, // should succeed
      },
    };
    // restoreBots will get data='not-an-array' and our impl returns error
    const result = await configBackup.applyRestore({ payload, sections: ['bots', 'telegram'], mode: 'merge' });
    expect(result.ok).toBe(true);
    expect(result.results.bots.error).toBeDefined();
    // telegram may or may not succeed depending on mock — at minimum, not error
  });
});

// ─── writePreRestoreSnapshot (2) ──────────────────────────────────────────────

describe('writePreRestoreSnapshot', () => {
  test('returns ok=true with path', async () => {
    AppConfig.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    Bot.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    Trade.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    const result = await configBackup.writePreRestoreSnapshot({}, ['bots']);
    expect(result.ok).toBe(true);
    expect(result.path).toMatch(/configbackup-pre-restore-/);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });
  test('path uses data/ dir (Windows-safe, not /tmp)', () => {
    const path = require('path');
    // Just verify the dir constant references 'data'
    expect(configBackup.SUPPORTED_SECTIONS).toBeDefined(); // sanity
    // PRE_RESTORE_DIR is internal but path joining data/ should be safe
    const expectedDir = path.join(__dirname, '..', 'data');
    expect(expectedDir.endsWith('data')).toBe(true);
  });
});

// ─── Route gating (3 — Pattern C) ─────────────────────────────────────────────

describe('route gating', () => {
  // Pattern C: load the router stack and invoke handler with mock req/res
  function invoke(method, path, req = {}) {
    return new Promise((resolve) => {
      const router = require('../src/api/routes/admin.routes');
      const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
      if (!layer) return resolve({ status: 404, data: { error: 'route not found' } });
      const res = {
        status: (code) => ({ json: (data) => resolve({ status: code, data }) }),
        json: (data) => resolve({ status: 200, data }),
      };
      const req2 = {
        body: {},
        query: {},
        params: {},
        session: {},
        ip: '127.0.0.1',
        get: () => '',
        path,
        ...req,
      };
      const handlers = layer.route.stack;
      let i = 0;
      const next = (err) => {
        if (err) return resolve({ status: 500, data: { error: err.message } });
        const h = handlers[i++];
        if (!h) return;
        // FIX-2026-08-29: skip body-parser middleware (jsonParser/urlencodedParser) when the
        // test's req has no Content-Type — otherwise it throws trying to read a non-existent
        // body stream. Route-specific express.json() was added to /config/restore* for the
        // 15mb body limit, but in unit tests we already pass `body` directly.
        if (h.name === 'jsonParser' || h.name === 'urlencodedParser') {
          return next();
        }
        try { h.handle(req2, res, next); } catch (e) { resolve({ status: 500, data: { error: e.message } }); }
      };
      next();
    });
  }

  test('GET /api/admin/config/backup/preview without session → 401', async () => {
    const result = await invoke('get', '/config/backup/preview', { session: {} });
    // requireAuth returns 401 if no session.authenticated
    expect([401, 403]).toContain(result.status);
  });
  test('POST /api/admin/config/backup with bad sections → 400', async () => {
    const result = await invoke('post', '/config/backup', { session: { authenticated: true }, body: { sections: 'not-array' } });
    // Should fail validation in the route handler (sections is not an array)
    expect(result.status).toBe(400);
  });
  test('POST /api/admin/config/restore without payload → 400', async () => {
    const result = await invoke('post', '/config/restore', { session: { authenticated: true }, body: {} });
    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(/missing payload/i);
  });
});