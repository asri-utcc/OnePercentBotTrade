'use strict';

/**
 * FIX-2026-09-09: SESSION_COOKIE_NAME — per-instance cookie collision fix
 *
 *   Verifies config.sessionCookieName reads the SESSION_COOKIE_NAME env var
 *   (default 'connect.sid' for back-compat). Multi-instance deployments
 *   rely on unique cookie names so two bots on different ports don't
 *   overwrite each other's session cookie in the same browser.
 *
 *   Strategy: spawn a fresh Node child per scenario so the require cache
 *   for ../config is cold.
 */

const { spawnSync } = require('child_process');

const CONFIG_PATH = require('path').resolve(__dirname, '..', 'config');

function _runWithEnv(env) {
  const script = `
    const cfg = require(${JSON.stringify(CONFIG_PATH)});
    process.stdout.write(JSON.stringify({ name: cfg.sessionCookieName }));
  `;
  return spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describe('config.sessionCookieName (FIX-2026-09-09)', () => {
  test('default value when SESSION_COOKIE_NAME unset (single-instance back-compat)', () => {
    const env = { SESSION_SECRET: 'x'.repeat(64), ENCRYPTION_KEY: 'x'.repeat(32) };
    delete env.SESSION_COOKIE_NAME;
    const result = _runWithEnv(env);
    expect(result.status).toBe(0);
    const { name } = JSON.parse(result.stdout);
    expect(name).toBe('connect.sid');
  });

  test('reads SESSION_COOKIE_NAME when set (multi-instance)', () => {
    const env = {
      SESSION_SECRET: 'x'.repeat(64),
      ENCRYPTION_KEY: 'x'.repeat(32),
      SESSION_COOKIE_NAME: 'connect.sid.faiz',
    };
    const result = _runWithEnv(env);
    expect(result.status).toBe(0);
    const { name } = JSON.parse(result.stdout);
    expect(name).toBe('connect.sid.faiz');
  });

  test('two distinct SESSION_COOKIE_NAME values yield two distinct configs', () => {
    const a = _runWithEnv({ SESSION_SECRET: 'x'.repeat(64), ENCRYPTION_KEY: 'x'.repeat(32), SESSION_COOKIE_NAME: 'connect.sid.gigi' });
    const b = _runWithEnv({ SESSION_SECRET: 'x'.repeat(64), ENCRYPTION_KEY: 'x'.repeat(32), SESSION_COOKIE_NAME: 'connect.sid.faiz' });
    expect(JSON.parse(a.stdout).name).toBe('connect.sid.gigi');
    expect(JSON.parse(b.stdout).name).toBe('connect.sid.faiz');
    expect(JSON.parse(a.stdout).name).not.toBe(JSON.parse(b.stdout).name);
  });

  test('empty string falls back to default (empty treated as unset)', () => {
    const env = { SESSION_SECRET: 'x'.repeat(64), ENCRYPTION_KEY: 'x'.repeat(32), SESSION_COOKIE_NAME: '' };
    const result = _runWithEnv(env);
    expect(result.status).toBe(0);
    const { name } = JSON.parse(result.stdout);
    expect(name).toBe('connect.sid');
  });
});
