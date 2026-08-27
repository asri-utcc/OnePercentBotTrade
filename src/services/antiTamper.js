'use strict';

/**
 * FIX-2026-08-27 Phase 3a C1: Anti-tamper service
 *
 *   On startup (and periodically), compute SHA-256 of every .js file under src/
 *   and compare against `license.codeHash` (set by admin when license issued).
 *
 *   If mismatch:
 *     - emit `antiTamper:detected` event (consumed by eventBus → admin command queue)
 *     - return { ok: false, mismatches: [...] }
 *
 *   Why: catches "patched bot" attempts where operator replaces bot source with
 *   modified copy (e.g. removing license checks, raising capital limits, etc.).
 *   Admin sets codeHash in License schema; if hash changes, mismatch → admin gets
 *   alert + can issue `notify_unauthorized` with reason `code_tampered`.
 *
 *   Notes:
 *     - excludes node_modules/, *.test.js, *.bak, .cache/
 *     - uses streaming hash to keep memory low (single 1KB buffer)
 *     - caches the result for `CACHE_TTL_MS` so periodic checks don't hash every time
 *     - non-blocking: returns Promise but caller can await
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getEventBus } = require('./eventBus');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — periodic checks
const HASH_ALGO = 'sha256';
const IGNORE_DIRS = new Set(['node_modules', '.cache', '.git', 'coverage', 'logs']);
const IGNORE_EXTS = new Set(['.bak', '.tmp', '.log']);
const IGNORE_FILES = new Set(['.DS_Store']);

let _lastResult = null;
let _lastHashedAt = 0;

function _shouldSkip(filePath) {
  const parts = filePath.split(path.sep);
  for (const p of parts) {
    if (IGNORE_DIRS.has(p)) return true;
  }
  const base = path.basename(filePath);
  if (IGNORE_FILES.has(base)) return true;
  const ext = path.extname(filePath);
  if (IGNORE_EXTS.has(ext)) return true;
  return false;
}

function _walkSrc(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (err) { continue; } // permission denied or deleted mid-walk
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        stack.push(full);
      } else if (ent.isFile() && ent.name.endsWith('.js')) {
        if (!_shouldSkip(full)) out.push(full);
      }
    }
  }
  return out.sort(); // deterministic order → stable hash
}

function _hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(HASH_ALGO);
    const s = fs.createReadStream(filePath, { highWaterMark: 1024 });
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function _computeManifest(srcDir) {
  const files = _walkSrc(srcDir);
  // FIX-2026-08-27: parallel hashing via Promise.all (small fan-out, low memory)
  const entries = await Promise.all(files.map(async (fp) => {
    const rel = path.relative(srcDir, fp).replace(/\\/g, '/');
    const hash = await _hashFile(fp);
    return { file: rel, hash };
  }));
  // Manifest hash = sorted entries joined, then re-hashed
  const m = crypto.createHash(HASH_ALGO);
  for (const e of entries) m.update(`${e.file}:${e.hash}\n`);
  const manifestHash = m.digest('hex');
  return { manifestHash, entries, fileCount: entries.length };
}

/**
 * Compute anti-tamper check.
 * @param {Object} options
 * @param {string} options.srcDir - absolute path to src/ (default: project/src)
 * @param {string} options.licenseCodeHash - hash to compare against (from License.codeHash)
 * @param {boolean} options.force - bypass cache
 * @returns {Promise<{ok: boolean, manifestHash: string, fileCount: number, mismatches?: string[]}>}
 */
async function checkIntegrity({ srcDir, licenseCodeHash, force = false } = {}) {
  const now = Date.now();
  if (!force && _lastResult && (now - _lastHashedAt) < CACHE_TTL_MS) {
    return _compare(_lastResult, licenseCodeHash);
  }

  const root = srcDir || path.join(__dirname, '..'); // project/src
  const result = await _computeManifest(root);
  _lastResult = result;
  _lastHashedAt = now;

  const cmp = _compare(result, licenseCodeHash);
  if (!cmp.ok) {
    logger.warn({
      mismatches: cmp.mismatches ? cmp.mismatches.length : null,
      fileCount: cmp.fileCount,
    }, 'anti-tamper: mismatch detected');
    try {
      const bus = getEventBus();
      bus.emit('antiTamper:detected', {
        mismatches: cmp.mismatches || [],
        manifestHash: cmp.manifestHash,
        fileCount: cmp.fileCount,
        detectedAt: new Date().toISOString(),
      });
    } catch (e) {
      logger.warn({ err: e.message }, 'anti-tamper: eventBus emit failed (non-fatal)');
    }
  } else {
    logger.info({ manifestHash: result.manifestHash.slice(0, 16), fileCount: result.fileCount }, 'anti-tamper: integrity OK');
  }
  return cmp;
}

function _compare(result, expected) {
  if (!expected || typeof expected !== 'string') {
    // No expected hash → can't verify; treat as ok-but-skipped
    return { ok: true, skipped: true, manifestHash: result.manifestHash, fileCount: result.fileCount };
  }
  if (result.manifestHash === expected) {
    return { ok: true, manifestHash: result.manifestHash, fileCount: result.fileCount };
  }
  // Mismatch — return full manifest so caller can identify changed files
  // (without expected file→hash map we can only say "some file changed"; deeper
  //  comparison requires storing the per-file expected hashes too — future work)
  return {
    ok: false,
    manifestHash: result.manifestHash,
    fileCount: result.fileCount,
    mismatches: result.entries.map((e) => e.file), // worst-case: all files might have changed
  };
}

/**
 * Reset cache (for tests / forced re-check after deploy)
 */
function _resetCache() {
  _lastResult = null;
  _lastHashedAt = 0;
}

module.exports = {
  checkIntegrity,
  _resetCache,
  _computeManifest, // exposed for tests
  HASH_ALGO,
  CACHE_TTL_MS,
};
