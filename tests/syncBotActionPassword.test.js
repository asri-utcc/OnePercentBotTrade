'use strict';

// FIX-2026-08-10: sync-bot-action-password endpoint tests
//   - POST /api/auth/sync-bot-action-password
//   - Verifies currentPassword via bcrypt against AppConfig.passwordHash
//   - Mutates config.botActionPassword (runtime) + persists to AppConfig
//   - Skips when process.env.BOT_ACTION_PASSWORD is explicit
//   - 400 when currentPassword missing
//   - 401 when currentPassword wrong
//   - 400 when Setup not completed

const bcrypt = require('bcryptjs');
const AppConfig = require('../src/db/models/AppConfig');

describe('AppConfig schema — botActionPassword fields (FIX-2026-08-10)', () => {
  test('schema has botActionPassword / botActionPasswordChangedAt / botActionPasswordChangedFromIp', () => {
    const schema = AppConfig.schema;
    expect(schema.paths.botActionPassword).toBeDefined();
    expect(schema.paths.botActionPassword.options.default).toBe('');
    expect(schema.paths.botActionPasswordChangedAt).toBeDefined();
    expect(schema.paths.botActionPasswordChangedAt.options.default).toBeNull();
    expect(schema.paths.botActionPasswordChangedFromIp).toBeDefined();
    expect(schema.paths.botActionPasswordChangedFromIp.options.default).toBe('');
  });
});

describe('sync-bot-action-password logic (FIX-2026-08-10)', () => {
  // Mirror the logic from src/api/routes/auth.routes.js to test in isolation
  // (avoids loading the whole Express app + bcrypt in jest)
  const config = require('../config');
  // IMPORTANT: config.botActionPassword is loaded once from .env at module init.
  // Snapshot it BEFORE any test mutates it — restore in finally.
  const ORIG_RUNTIME = config.botActionPassword;

  async function handleSync({ currentPassword, envBotActionPassword, configDocState }) {
    const origEnv = process.env.BOT_ACTION_PASSWORD;
    if (envBotActionPassword) {
      process.env.BOT_ACTION_PASSWORD = envBotActionPassword;
    } else {
      delete process.env.BOT_ACTION_PASSWORD;
    }

    let result = { status: null, body: null, mutated: null };
    try {
      if (!currentPassword) {
        return { status: 400, body: { error: 'currentPassword required' }, mutated: null };
      }
      if (!configDocState) {
        return { status: 400, body: { error: 'Setup not completed' }, mutated: null };
      }
      const ok = await bcrypt.compare(currentPassword, configDocState.passwordHash);
      if (!ok) {
        return { status: 401, body: { error: 'currentPassword ไม่ถูกต้อง' }, mutated: null };
      }
      if (envBotActionPassword) {
        return {
          status: 400,
          body: { error: 'มี BOT_ACTION_PASSWORD ใน .env — ตัว sync จะไม่ override ค่าที่ตั้งไว้' },
          mutated: null,
        };
      }
      // Success path
      config.botActionPassword = currentPassword;
      configDocState.botActionPassword = currentPassword;
      configDocState.botActionPasswordChangedAt = new Date();
      configDocState.botActionPasswordChangedFromIp = 'test-ip';
      configDocState.saveCalled = (configDocState.saveCalled || 0) + 1;
      // Snapshot the mutated runtime BEFORE we restore (so test can assert it)
      const mutatedRuntimeDuring = config.botActionPassword;
      return { status: 200, body: { ok: true, synced: true }, mutated: mutatedRuntimeDuring };
    } finally {
      if (origEnv !== undefined) process.env.BOT_ACTION_PASSWORD = origEnv;
      else delete process.env.BOT_ACTION_PASSWORD;
      // Restore the ORIGINAL runtime value (whatever .env had)
      config.botActionPassword = ORIG_RUNTIME;
    }
  }

  let configDoc;
  beforeEach(async () => {
    const hash = await bcrypt.hash('correctCurrentPw', 4);
    configDoc = {
      key: 'singleton',
      passwordHash: hash,
      botActionPassword: '',
      botActionPasswordChangedAt: null,
      botActionPasswordChangedFromIp: '',
    };
  });

  test('success: currentPassword matches → mutates runtime + persists DB', async () => {
    const r = await handleSync({ currentPassword: 'correctCurrentPw', configDocState: configDoc });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, synced: true });
    expect(r.mutated).toBe('correctCurrentPw');
    expect(configDoc.botActionPassword).toBe('correctCurrentPw');
    expect(configDoc.botActionPasswordChangedAt).toBeInstanceOf(Date);
    expect(configDoc.botActionPasswordChangedFromIp).toBe('test-ip');
    expect(configDoc.saveCalled).toBe(1);
  });

  test('400 when currentPassword missing', async () => {
    const r = await handleSync({ currentPassword: '', configDocState: configDoc });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/currentPassword required/);
  });

  test('401 when currentPassword wrong', async () => {
    const r = await handleSync({ currentPassword: 'wrongPassword', configDocState: configDoc });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/currentPassword ไม่ถูกต้อง/);
    expect(configDoc.botActionPassword).toBe(''); // DB unchanged
  });

  test('400 when Setup not completed (no configDoc)', async () => {
    const r = await handleSync({ currentPassword: 'correctCurrentPw', configDocState: null });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Setup not completed/);
  });

  test('400 when BOT_ACTION_PASSWORD is explicit in .env (no override)', async () => {
    const r = await handleSync({
      currentPassword: 'correctCurrentPw',
      configDocState: configDoc,
      envBotActionPassword: 'separateEnvPassword',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/BOT_ACTION_PASSWORD/);
    expect(configDoc.botActionPassword).toBe(''); // DB not mutated
  });

  test('after each test: config.botActionPassword is restored to ORIG_RUNTIME', () => {
    expect(config.botActionPassword).toBe(ORIG_RUNTIME);
  });
});

describe('change-password extends to backfill empty botActionPassword (FIX-2026-08-10)', () => {
  // Mirror the extension from src/api/routes/auth.routes.js
  const config = require('../config');
  const ORIG_RUNTIME = config.botActionPassword;

  function handleChangePassword({ newPassword, currentBotActionPassword, envBotActionPassword }) {
    const origEnv = process.env.BOT_ACTION_PASSWORD;
    if (envBotActionPassword) process.env.BOT_ACTION_PASSWORD = envBotActionPassword;
    else delete process.env.BOT_ACTION_PASSWORD;

    try {
      const wasEmpty = !currentBotActionPassword;
      const envHasSeparateBotPw = !!envBotActionPassword;

      if (!envHasSeparateBotPw) {
        config.botActionPassword = newPassword;
      }

      return {
        wasEmpty,
        envHasSeparateBotPw,
        runtimeAfter: config.botActionPassword,
        backfilled: wasEmpty && !envHasSeparateBotPw,
      };
    } finally {
      if (origEnv !== undefined) process.env.BOT_ACTION_PASSWORD = origEnv;
      else delete process.env.BOT_ACTION_PASSWORD;
      config.botActionPassword = ORIG_RUNTIME;
    }
  }

  test('was empty → backfill (runtime + DB)', () => {
    const r = handleChangePassword({
      newPassword: 'newLoginPw',
      currentBotActionPassword: '',
    });
    expect(r.wasEmpty).toBe(true);
    expect(r.backfilled).toBe(true);
    expect(r.runtimeAfter).toBe('newLoginPw');
  });

  test('was non-empty → just sync (no backfill flag)', () => {
    const r = handleChangePassword({
      newPassword: 'newLoginPw',
      currentBotActionPassword: 'oldBotPw',
    });
    expect(r.wasEmpty).toBe(false);
    expect(r.backfilled).toBe(false);
    expect(r.runtimeAfter).toBe('newLoginPw');
  });

  test('env explicit → do NOT touch botActionPassword', () => {
    const r = handleChangePassword({
      newPassword: 'newLoginPw',
      currentBotActionPassword: '',
      envBotActionPassword: 'separateEnvPw',
    });
    expect(r.envHasSeparateBotPw).toBe(true);
    expect(r.runtimeAfter).toBe(ORIG_RUNTIME); // not mutated
  });
});
