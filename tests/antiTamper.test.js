'use strict';

/**
 * FIX-2026-08-27 Phase 3a C1: antiTamper.js tests
 *
 *   We mock fs.createReadStream + fs.readdirSync to control the file tree without
 *   touching the real bot source. Verifies:
 *     - hash manifest is deterministic
 *     - hash changes when file content changes
 *     - hash unchanged when src unchanged
 *     - empty expected → skipped (ok:true, skipped:true)
 *     - expected match → ok:true
 *     - expected mismatch → ok:false + mismatches array + eventBus emit
 *     - cache: 2nd call within TTL doesn't re-walk
 *     - force=true bypasses cache
 *     - excludes node_modules/ + non-.js files
 */

const fs = require('fs');
const path = require('path');

// Mutable mock state (jest hoists jest.mock above these assignments,
// so use module-scope refs inside the factory — only via `mock` prefix)
const mockTree = new Map();
let mockDirs = [];

const mockEmit = jest.fn();

jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  const _stream = require('stream');
  return {
    ...real,
    readdirSync: jest.fn((dir) => {
      const _path = require('path');
      const resolved = _path.resolve(dir);
      const out = [];
      const seen = new Set();
      for (const p of mockTree.keys()) {
        if (_path.dirname(p) === resolved && !seen.has(_path.basename(p))) {
          seen.add(_path.basename(p));
          out.push({ name: _path.basename(p), isFile: () => true, isDirectory: () => false });
        }
      }
      for (const d of mockDirs) {
        if (_path.dirname(d) === resolved && !seen.has(_path.basename(d))) {
          seen.add(_path.basename(d));
          out.push({ name: _path.basename(d), isFile: () => false, isDirectory: () => true });
        }
      }
      return out;
    }),
    createReadStream: jest.fn((filePath) => {
      const _path = require('path');
      const content = mockTree.get(_path.resolve(filePath)) || '';
      const r = new _stream.Readable();
      r._read = () => {};
      // Push synchronously in next tick to ensure listeners attached first
      process.nextTick(() => r.push(Buffer.from(content)));
      process.nextTick(() => r.push(null));
      return r;
    }),
  };
});

jest.mock('../src/services/eventBus', () => ({
  getEventBus: () => ({ emit: mockEmit, on: jest.fn(), removeAllListeners: jest.fn() }),
}));

const antiTamper = require('../src/services/antiTamper');

function setupTree(files) {
  mockTree.clear();
  mockDirs = [];
  for (const [p, content] of Object.entries(files)) {
    mockTree.set(path.resolve(p), content);
    let parent = path.dirname(path.resolve(p));
    while (parent !== path.dirname(parent)) {
      if (!mockDirs.includes(parent)) mockDirs.push(parent);
      parent = path.dirname(parent);
    }
  }
}

describe('antiTamper.checkIntegrity (FIX-2026-08-27)', () => {
  beforeEach(() => {
    antiTamper._resetCache();
    mockEmit.mockClear();
    fs.readdirSync.mockClear();
    fs.createReadStream.mockClear();
  });

  test('hash manifest is deterministic across calls', async () => {
    setupTree({
      '/fake/src/a.js': 'module.exports = 1;',
      '/fake/src/b.js': 'module.exports = 2;',
      '/fake/src/sub/c.js': 'module.exports = 3;',
    });
    const r1 = await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: null });
    antiTamper._resetCache();
    const r2 = await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: null });
    expect(r1.manifestHash).toBe(r2.manifestHash);
    expect(r1.fileCount).toBe(3);
  });

  test('hash changes when file content changes', async () => {
    setupTree({ '/fake/src/a.js': 'v1' });
    const r1 = await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: null });
    antiTamper._resetCache();
    mockTree.set(path.resolve('/fake/src/a.js'), 'v2');
    const r2 = await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: null });
    expect(r1.manifestHash).not.toBe(r2.manifestHash);
  });

  test('empty expected → skipped (ok:true, skipped:true)', async () => {
    setupTree({ '/fake/src/a.js': 'x' });
    const r = await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: null });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.fileCount).toBe(1);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('expected match → ok:true, no event emit', async () => {
    setupTree({ '/fake/src/a.js': 'x' });
    const r1 = await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: null });
    const r2 = await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: r1.manifestHash });
    expect(r2.ok).toBe(true);
    expect(r2.skipped).toBeUndefined();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('expected mismatch → ok:false + mismatches + eventBus emit', async () => {
    setupTree({ '/fake/src/a.js': 'x' });
    const r = await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: 'wrong-hash-value' });
    expect(r.ok).toBe(false);
    expect(Array.isArray(r.mismatches)).toBe(true);
    expect(r.mismatches.length).toBeGreaterThan(0);
    expect(mockEmit).toHaveBeenCalledWith('antiTamper:detected', expect.objectContaining({
      mismatches: expect.any(Array),
      manifestHash: expect.any(String),
    }));
  });

  test('cache: 2nd call within TTL reuses manifest', async () => {
    setupTree({ '/fake/src/a.js': 'x' });
    const r1 = await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: null });
    const readdirCountAfterFirst = fs.readdirSync.mock.calls.length;
    const r2 = await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: null });
    expect(r1.manifestHash).toBe(r2.manifestHash);
    expect(fs.readdirSync.mock.calls.length).toBe(readdirCountAfterFirst);
  });

  test('force=true bypasses cache', async () => {
    setupTree({ '/fake/src/a.js': 'x' });
    const r1 = await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: null });
    const readdirCountAfterFirst = fs.readdirSync.mock.calls.length;
    const r2 = await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: null, force: true });
    expect(r1.manifestHash).toBe(r2.manifestHash);
    expect(fs.readdirSync.mock.calls.length).toBeGreaterThan(readdirCountAfterFirst);
  });

  test('excludes node_modules/, .cache/, non-.js files', async () => {
    setupTree({
      '/fake/src/a.js': 'js file',
      '/fake/src/node_modules/b.js': 'should be skipped',
      '/fake/src/readme.md': 'should be skipped',
      '/fake/src/.cache/c.js': 'should be skipped',
    });
    const r = await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: null });
    expect(r.fileCount).toBe(1);
  });

  test('getLastTamperState reflects last check (FIX-2026-08-27 C1c)', async () => {
    setupTree({ '/fake/src/a.js': 'x' });
    expect(antiTamper.getLastTamperState()).toBeNull();
    await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: null });
    const s = antiTamper.getLastTamperState();
    expect(s).not.toBeNull();
    expect(s.ok).toBe(true);
    expect(s.skipped).toBe(true);
    expect(s.manifestHash).toBeDefined();
    expect(s.fileCount).toBe(1);
  });

  test('getLastTamperState captures mismatch', async () => {
    setupTree({ '/fake/src/a.js': 'x' });
    await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: 'wrong-hash' });
    const s = antiTamper.getLastTamperState();
    expect(s.ok).toBe(false);
    expect(s.mismatches).toEqual(['a.js']);
  });

  test('cache hit updates lastTamperState without re-hashing', async () => {
    setupTree({ '/fake/src/a.js': 'x' });
    await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: null });
    const readdirCount = fs.readdirSync.mock.calls.length;
    // Second call within TTL: no new walk, but state still updates
    await antiTamper.checkIntegrity({ srcDir: '/fake/src', licenseCodeHash: 'any-hash' });
    expect(fs.readdirSync.mock.calls.length).toBe(readdirCount);
    const s = antiTamper.getLastTamperState();
    expect(s.ok).toBe(false); // because we passed a non-matching hash on the cached result
  });
});
