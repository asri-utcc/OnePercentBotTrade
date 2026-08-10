'use strict';

// FIX-2026-08-10: syncBotActionPasswordFromAppConfig tests
//   - Reads AppConfig.botActionPassword and overrides config.botActionPassword
//   - Respects explicit process.env.BOT_ACTION_PASSWORD (does not override)
//   - Failure-safe (DB errors are logged + swallowed)
//
// AppConfig.findOne is overridden per-test (after require), so no module-level
// jest.mock is needed.

const path = require('path');
const configPath = path.resolve(__dirname, '../config');
const config = require(configPath);
const AppConfig = require('../src/db/models/AppConfig');
const { syncBotActionPasswordFromAppConfig } = require('../src/utils/botActionPasswordSync');

describe('syncBotActionPasswordFromAppConfig (FIX-2026-08-10)', () => {
  const ORIG_ENV = process.env.BOT_ACTION_PASSWORD;
  const ORIG_CONFIG_VALUE = config.botActionPassword;
  let origFindOne;

  beforeEach(() => {
    delete process.env.BOT_ACTION_PASSWORD;
    config.botActionPassword = '';
    origFindOne = AppConfig.findOne;
  });
  afterEach(() => {
    AppConfig.findOne = origFindOne;
  });
  afterAll(() => {
    if (ORIG_ENV !== undefined) process.env.BOT_ACTION_PASSWORD = ORIG_ENV;
    else delete process.env.BOT_ACTION_PASSWORD;
    config.botActionPassword = ORIG_CONFIG_VALUE;
  });

  test('applies AppConfig value when env is not explicit', async () => {
    AppConfig.findOne = () => ({
      lean: async () => ({ key: 'singleton', botActionPassword: 'dbPassword123' }),
    });
    const r = await syncBotActionPasswordFromAppConfig();
    expect(r.applied).toBe(true);
    expect(r.source).toBe('appconfig');
    expect(r.value).toBe('dbPassword123');
    expect(config.botActionPassword).toBe('dbPassword123');
  });

  test('skips when process.env.BOT_ACTION_PASSWORD is explicitly set', async () => {
    process.env.BOT_ACTION_PASSWORD = 'envPassword456';
    AppConfig.findOne = () => ({
      lean: async () => ({ key: 'singleton', botActionPassword: 'dbPassword123' }),
    });
    const r = await syncBotActionPasswordFromAppConfig();
    expect(r.applied).toBe(false);
    expect(r.source).toBe('env');
    expect(config.botActionPassword).toBe('');
  });

  test('skips when AppConfig has no botActionPassword', async () => {
    AppConfig.findOne = () => ({
      lean: async () => ({ key: 'singleton', botActionPassword: '' }),
    });
    const r = await syncBotActionPasswordFromAppConfig();
    expect(r.applied).toBe(false);
    expect(r.source).toBe('env');
    expect(config.botActionPassword).toBe('');
  });

  test('skips when no AppConfig document exists', async () => {
    AppConfig.findOne = () => ({
      lean: async () => null,
    });
    const r = await syncBotActionPasswordFromAppConfig();
    expect(r.applied).toBe(false);
    expect(r.source).toBe('none');
  });

  test('trims whitespace from AppConfig value', async () => {
    AppConfig.findOne = () => ({
      lean: async () => ({ key: 'singleton', botActionPassword: '  pwdWithSpaces  ' }),
    });
    await syncBotActionPasswordFromAppConfig();
    expect(config.botActionPassword).toBe('pwdWithSpaces');
  });

  test('DB error is swallowed (does not throw)', async () => {
    AppConfig.findOne = () => ({
      lean: async () => { throw new Error('mock DB failure'); },
    });
    const r = await syncBotActionPasswordFromAppConfig();
    expect(r.applied).toBe(false);
    expect(r.source).toBe('none');
  });
});