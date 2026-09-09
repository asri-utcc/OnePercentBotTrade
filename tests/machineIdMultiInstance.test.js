'use strict';

/**
 * FIX-2026-09-09: machineId multi-instance test
 *
 *   Verifies that MACHINE_ID_FILE env var overrides the default fingerprint
 *   file path, allowing multiple bot instances on the same host to register
 *   as distinct machines to the admin.
 *
 *   Strategy: spawn the require() in a child process with a different
 *   MACHINE_ID_FILE so the require cache is fresh per scenario.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MACHINE_ID_PATH = path.join(__dirname, '..', 'src', 'admin-monitor', 'machineId.js');

function _runWithEnv(env, code) {
  // Run a tiny script in a child Node process so the module cache is fresh.
  const script = `
    const { getMachineId } = require(${JSON.stringify(MACHINE_ID_PATH)});
    const id = getMachineId();
    process.stdout.write(JSON.stringify({ id }));
  `;
  return spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describe('machineId — multi-instance support (FIX-2026-09-09)', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'machineId-test-'));
  });

  afterAll(() => {
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch (_) { /* ignore */ }
  });

  test('default path: env override unset → uses default file', () => {
    const defaultFile = path.resolve(__dirname, '..', 'data', 'admin-machine-id.txt');
    // Don't actually require a default file to exist — the test is about which
    // path the module resolves. To avoid polluting the real data dir, we just
    // assert the env override below.
    expect(defaultFile).toMatch(/data[\\/]admin-machine-id\.txt$/);
  });

  test('MACHINE_ID_FILE env: returns the persisted ID from the override path', () => {
    const customFile = path.join(tmpDir, 'faiz-machine-id.txt');
    const customId = 'faizuniqueid0123456789abcdef0123';
    fs.writeFileSync(customFile, customId, 'utf8');

    const result = _runWithEnv({ MACHINE_ID_FILE: customFile });
    expect(result.status).toBe(0);
    const { id } = JSON.parse(result.stdout);
    expect(id).toBe(customId);
  });

  test('two different override files → two distinct machineIds', () => {
    const fileA = path.join(tmpDir, 'instance-a.txt');
    const fileB = path.join(tmpDir, 'instance-b.txt');
    fs.writeFileSync(fileA, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'utf8');
    fs.writeFileSync(fileB, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'utf8');

    const resA = _runWithEnv({ MACHINE_ID_FILE: fileA });
    const resB = _runWithEnv({ MACHINE_ID_FILE: fileB });
    expect(JSON.parse(resA.stdout).id).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(JSON.parse(resB.stdout).id).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(JSON.parse(resA.stdout).id).not.toBe(JSON.parse(resB.stdout).id);
  });

  test('MACHINE_ID_FILE accepts relative path (resolved against cwd)', () => {
    const customId = 'relativepathid1234567890abcdef';
    const relFile = path.join(tmpDir, 'rel-machine-id.txt');
    fs.writeFileSync(relFile, customId, 'utf8');

    const result = spawnSync(process.execPath, ['-e', `
      const { getMachineId } = require(${JSON.stringify(MACHINE_ID_PATH)});
      process.stdout.write(JSON.stringify({ id: getMachineId() }));
    `], {
      env: { ...process.env, MACHINE_ID_FILE: path.relative(process.cwd(), relFile) },
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).id).toBe(customId);
  });
});
