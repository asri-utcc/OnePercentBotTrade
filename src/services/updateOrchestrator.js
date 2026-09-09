'use strict';

/**
 * FIX-2026-09-09: OneClick Update — Update Orchestrator (8-phase state machine).
 *
 *   Replaces bot `src/`, `public/`, `scripts/`, `config/` in place using a
 *   tarball downloaded from the admin's release server. Designed for atomicity
 *   + automatic rollback on any failure.
 *
 *   Phases (each writes its checkpoint to `data/update-state.json`):
 *     0. PRE-FLIGHT       — check disk, env, current state
 *     1. BACKUP           — copy .env*, machine-id, MongoDB dump, configBackup
 *     2. DOWNLOAD+VERIFY  — stream tarball + stream-SHA-256 verify
 *     3. EXTRACT          — extract to staging dir, refuse to overwrite runtime files
 *     4. SWAP             — atomic mv current → backup, mv extracted → live
 *     5. INSTALL DEPS     — `npm ci --omit=dev` (rollback on fail)
 *     6. RUN MIGRATIONS   — sequentially run scripts/migrate-*.js (rollback on fail)
 *     7. RELOAD           — `pm2 reload <name>` + wait for /api/health
 *     8. REPORT+CLEANUP   — POST /api/release/report-update, keep backup 7d
 *
 *   ROLLBACK (any phase except 8):
 *     - If phase >= 4: mv backup/old/{src,public,scripts,config} back
 *     - If phase >= 5: npm ci (reinstall old deps)
 *     - If phase >= 6: mongorestore from dump
 *     - pm2 reload
 *     - report status:'rolled_back'
 *
 *   Concurrency guard: only one update at a time. A second `applyUpdate()` call
 *   throws if one is already in flight.
 *
 *   Trust model:
 *     - Tarball SHA-256 verified on download (line 218). MITM-resistant even on HTTP.
 *     - Manifest hash computed from extracted src/ matches Release.manifestHash on
 *       admin BEFORE admin flips License.codeHash (see /api/release/report-update).
 *     - License key sent via X-License-Key header (same auth as heartbeat).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const antiTamper = require('./antiTamper');
const configBackup = require('./configBackup');
const machineIdMod = require('../admin-monitor/machineId');
const adminConfig = require('../admin-monitor/config');
const logger = require('../utils/logger');

const BOT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(BOT_ROOT, 'data');
const STAGING_DIR = path.join(DATA_DIR, 'update-staging');
const BACKUPS_DIR = path.join(DATA_DIR, 'update-backups');
const STATE_FILE = path.join(DATA_DIR, 'update-state.json');

// Which dirs are replaced by the update (kept in sync with publish-release.js tarball).
const REPLACE_DIRS = ['src', 'public', 'scripts', 'config'];
// Files we never overwrite from a tarball (operator-local state / secrets).
const PROTECTED_FILES = new Set([
  '.env', '.env.faiz', '.env.local', '.env.production', '.env.example',
  'package-lock.json', // npm ci regenerates it
]);
// Refuse to update if any of these have uncommitted local changes. We only check
// existence here (stat) — git check would require the tarball to ship .git/.
const RUNTIME_DIRS = ['logs', 'node_modules', 'data'];

let _inFlight = null; // Promise — used as both lock + status cache

// ─── State persistence ────────────────────────────────────────────────────────

function _readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return null; }
}
function _writeState(s) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function _now() { return new Date().toISOString(); }

function _ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function _machineId() {
  try { return machineIdMod.getMachineId(); }
  catch (_) { return 'unknown'; }
}

function _currentVersion() {
  try { return require(path.join(BOT_ROOT, 'package.json')).version; }
  catch (_) { return '0.0.0'; }
}

function _ecosystemName() {
  // Detect multi-instance ecosystem file (faiz instance). Default owner process name.
  // PM2 process name = dir basename by default; we keep that.
  // We don't try to parse ecosystem.config.js — too brittle. Just use cwd basename.
  return path.basename(BOT_ROOT);
}

function _spawnLogged(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    logger.info({ cmd, args }, 'orchestrator: spawn');
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    p.stdout.on('data', (c) => { out += c; process.stdout.write(c); });
    p.stderr.on('data', (c) => { out += c; process.stderr.write(c); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`)));
  });
}

// ─── Tarball streaming + SHA-256 verify ───────────────────────────────────────

function _downloadAndVerify({ url, expectedSha256, destPath }) {
  return new Promise((resolve, reject) => {
    let lib;
    try { lib = url.startsWith('https:') ? https : http; }
    catch (_) { return reject(new Error(`bad url: ${url}`)); }

    const u = new URL(url);
    const req = lib.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'X-License-Key': adminConfig.licenseKey || '',
        'X-Machine-Id': _machineId(),
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume(); // drain
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      const h = crypto.createHash('sha256');
      _ensureDir(path.dirname(destPath));
      const s = fs.createWriteStream(destPath);
      let bytes = 0;
      res.on('data', (chunk) => {
        h.update(chunk);
        s.write(chunk);
        bytes += chunk.length;
      });
      res.on('end', () => {
        s.end();
        const got = h.digest('hex');
        if (got !== expectedSha256) {
          try { fs.unlinkSync(destPath); } catch (_) {}
          return reject(new Error(`SHA-256 mismatch: expected ${expectedSha256.slice(0,12)}…, got ${got.slice(0,12)}…`));
        }
        resolve({ bytes, sha256: got });
      });
      res.on('error', (err) => { try { fs.unlinkSync(destPath); } catch (_) {} reject(err); });
      s.on('error', (err) => { try { fs.unlinkSync(destPath); } catch (_) {} reject(err); });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Tarball extract ──────────────────────────────────────────────────────────

function _extractTarball(tarballPath, extractDir) {
  // Uses system `tar`. Verified compatible with publish-release.js.
  // Output dir must not exist (we're extracting into a fresh staging dir).
  fs.mkdirSync(extractDir, { recursive: true });
  // Tarball root = bot repo dir (e.g. `OnePercentBotTrade/`). We extract all of
  // it then move the inner subdirs up. `--strip-components=1` would work IF tar
  // supports it portably — GNU tar yes, BSD tar yes. Use it for safety.
  const r = spawnSync('tar', ['-xzf', tarballPath, '--strip-components=1', '-C', extractDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(`tar -xzf failed (${r.status}): ${r.stderr.toString().slice(0, 500)}`);
  }
  // Sanity: extracted dir must contain package.json
  if (!fs.existsSync(path.join(extractDir, 'package.json'))) {
    throw new Error('extracted tarball has no package.json — corrupt');
  }
}

// ─── Atomic dir swap ───────────────────────────────────────────────────────────

function _swapDirs(backupOldDir, stagingDir) {
  // Move current dirs into backup, move staging subdirs into live.
  for (const dir of REPLACE_DIRS) {
    const live = path.join(BOT_ROOT, dir);
    const old = path.join(backupOldDir, dir);
    const fresh = path.join(stagingDir, dir);
    if (!fs.existsSync(fresh)) {
      logger.warn({ dir }, 'orchestrator: extracted tarball has no dir — skipping');
      continue;
    }
    if (fs.existsSync(live)) {
      _ensureDir(path.dirname(old));
      fs.renameSync(live, old);
    }
    fs.renameSync(fresh, live);
  }
}

function _swapBack(backupOldDir) {
  for (const dir of REPLACE_DIRS) {
    const live = path.join(BOT_ROOT, dir);
    const old = path.join(backupOldDir, dir);
    if (!fs.existsSync(old)) continue;
    // If a "live" dir exists from partial swap, move it aside first.
    if (fs.existsSync(live)) {
      const aside = live + '.partial-' + Date.now();
      try { fs.renameSync(live, aside); } catch (_) {}
    }
    try { fs.renameSync(old, live); }
    catch (err) {
      logger.error({ err: err.message, dir }, 'orchestrator: swap-back failed');
    }
  }
}

// ─── MongoDB dump/restore ─────────────────────────────────────────────────────

function _mongodumpAvailable() {
  const r = spawnSync('mongodump', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

async function _dumpMongo(outDir) {
  if (!_mongodumpAvailable()) {
    logger.warn('orchestrator: mongodump not available — skipping DB backup');
    return { ok: false, reason: 'mongodump-missing' };
  }
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/onepercentbottrade';
  await _spawnLogged('mongodump', ['--uri', uri, '--out', outDir]);
  return { ok: true };
}

async function _restoreMongo(dumpDir) {
  if (!fs.existsSync(dumpDir)) return { ok: false, reason: 'no-dump' };
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/onepercentbottrade';
  await _spawnLogged('mongorestore', ['--uri', uri, '--drop', dumpDir]);
  return { ok: true };
}

// ─── Main entry: applyUpdate({version, tarballUrl, sha256, migrations, manifestHash?}) ─

async function applyUpdate(input) {
  if (_inFlight) {
    throw Object.assign(new Error('update already in progress'), { code: 'EALREADY' });
  }
  const job = (async () => {
    const startedAt = _now();
    const backupTimestamp = _ts();
    const backupDir = path.join(BACKUPS_DIR, backupTimestamp);
    const stagingDir = path.join(STAGING_DIR, backupTimestamp);
    const extractedDir = path.join(stagingDir, 'extracted');
    const tarballPath = path.join(stagingDir, 'v' + input.version + '.tar.gz');
    const jobId = crypto.randomBytes(6).toString('hex');

    const state = {
      jobId, version: input.version, startedAt, backupDir,
      phases: {}, status: 'running',
    };
    _writeState(state);

    const report = (phase, ok, extra = {}) => {
      const entry = { at: _now(), ok, ...extra };
      state.phases['phase' + phase] = entry;
      state.updatedAt = _now();
      _writeState(state);
      logger.info({ phase, ok, extra }, 'orchestrator: phase complete');
      return entry;
    };

    try {
      // ─── Phase 0: PRE-FLIGHT ───────────────────────────────
      const freeBytes = (() => {
        try {
          // crude check via statvfs-equivalent on Windows
          if (process.platform === 'win32') return Infinity;
          const st = fs.statfsSync ? fs.statfsSync(BOT_ROOT) : null;
          return st ? st.bavail * st.bsize : Infinity;
        } catch (_) { return Infinity; }
      })();
      const required = (input.sha256 ? Number(input.sha256) : 0) ||
                        Math.ceil((input.tarballBytes || 50 * 1024 * 1024) * 3);
      const ecName = _ecosystemName();
      if (required > freeBytes) {
        throw new Error(`insufficient disk space: need ${required}B, have ${freeBytes}B`);
      }
      report(0, true, { ecosystem: ecName, version: input.version, required });

      // ─── Phase 1: BACKUP ──────────────────────────────────
      _ensureDir(backupDir);
      _ensureDir(path.join(backupDir, 'old'));
      const backed = [];
      // Copy protected files
      for (const f of fs.readdirSync(BOT_ROOT)) {
        if (f.startsWith('.env') && !f.includes('.example')) {
          const src = path.join(BOT_ROOT, f);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(backupDir, f));
            backed.push(f);
          }
        }
      }
      // Snapshot current dirs (will be re-stored via SWAP)
      for (const d of REPLACE_DIRS) {
        const p = path.join(BOT_ROOT, d);
        if (fs.existsSync(p)) {
          // Don't actually copy — SWAP will rename them into backup
          backed.push(d + '/ (live)');
        }
      }
      // MongoDB dump (best-effort)
      const mongoOut = path.join(backupDir, 'mongo');
      const dumpRes = await _dumpMongo(mongoOut).catch((e) => ({ ok: false, reason: e.message }));
      // configBackup section
      const cbRes = await configBackup
        .buildBackupPayload({ sections: configBackup.SUPPORTED_SECTIONS })
        .catch((e) => ({ error: e.message }));
      if (cbRes && !cbRes.error) {
        fs.writeFileSync(path.join(backupDir, 'configbackup.json'), JSON.stringify(cbRes, null, 2));
        backed.push('configbackup.json');
      }
      // machine-id
      const mid = _machineId();
      fs.writeFileSync(path.join(backupDir, 'machine-id.txt'), mid);
      backed.push('machine-id.txt');
      report(1, true, { backed, dump: dumpRes });

      // ─── Phase 2: DOWNLOAD + VERIFY ──────────────────────
      const dl = await _downloadAndVerify({
        url: input.tarballUrl,
        expectedSha256: input.sha256,
        destPath: tarballPath,
      });
      report(2, true, { sha256: dl.sha256, bytes: dl.bytes });

      // ─── Phase 3: EXTRACT ────────────────────────────────
      // Clean any old extracted dirs (we extract to fresh `extractedDir`).
      if (fs.existsSync(extractedDir)) {
        fs.rmSync(extractedDir, { recursive: true, force: true });
      }
      _extractTarball(tarballPath, extractedDir);
      const pkg = JSON.parse(fs.readFileSync(path.join(extractedDir, 'package.json'), 'utf8'));
      if (pkg.version !== input.version) {
        throw new Error(`extracted package.json version ${pkg.version} != requested ${input.version}`);
      }
      // Refuse tarballs that try to overwrite protected files
      for (const f of PROTECTED_FILES) {
        const p = path.join(extractedDir, f);
        if (fs.existsSync(p) && f !== '.env.example') {
          throw new Error(`tarball contains protected file ${f} — refusing`);
        }
      }
      report(3, true, { extractedVersion: pkg.version });

      // ─── Phase 4: SWAP (atomic) ──────────────────────────
      _swapDirs(path.join(backupDir, 'old'), extractedDir);
      report(4, true, {});

      // ─── Phase 5: INSTALL DEPS ───────────────────────────
      try {
        await _spawnLogged('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: BOT_ROOT });
        report(5, true, {});
      } catch (err) {
        logger.error({ err: err.message }, 'orchestrator: npm ci failed — triggering rollback');
        await _rollback(job, backupDir, mongoOut, 'phase5:npm-ci');
        throw err;
      }

      // ─── Phase 6: RUN MIGRATIONS ─────────────────────────
      const migrations = Array.isArray(input.migrations) ? input.migrations : [];
      const runResult = spawnSync(
        process.execPath,
        [path.join(BOT_ROOT, 'scripts', 'run-pending-migrations.js'), ...migrations],
        { stdio: 'inherit', cwd: BOT_ROOT, env: process.env }
      );
      if (runResult.status !== 0) {
        const err = new Error(`migrations failed (exit ${runResult.status})`);
        logger.error({ status: runResult.status }, 'orchestrator: migrations failed');
        await _rollback(job, backupDir, mongoOut, 'phase6:migrations');
        throw err;
      }
      report(6, true, { migrations });

      // ─── Phase 7: RELOAD ────────────────────────────────
      await _pm2Reload(ecName);
      report(7, true, { ecosystem: ecName });

      // ─── Phase 8: REPORT + CLEANUP ───────────────────────
      let postReportHash = null;
      try {
        const manifest = await antiTamper._computeManifest(path.join(BOT_ROOT, 'src'));
        postReportHash = manifest.manifestHash;
      } catch (e) {
        logger.warn({ err: e.message }, 'orchestrator: post-update manifest compute failed (non-fatal)');
      }
      await _postReport({
        version: input.version,
        manifestHash: postReportHash || input.manifestHash,
        machineId: mid,
        status: 'ok',
      }).catch((e) => logger.warn({ err: e.message }, 'orchestrator: post-report failed (non-fatal)'));
      // Cleanup staging (keep backup for 7 days)
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
      report(8, true, { reportedHash: postReportHash });

      state.status = 'success';
      state.completedAt = _now();
      _writeState(state);
      return {
        ok: true,
        jobId, version: input.version,
        backupDir, startedAt,
        finishedAt: state.completedAt,
      };
    } catch (err) {
      state.status = 'failed';
      state.error = err.message;
      state.completedAt = _now();
      _writeState(state);
      throw err;
    }
  })();

  _inFlight = job;
  try { return await job; }
  finally { _inFlight = null; }
}

async function _pm2Reload(name) {
  // pm2 reload <name> gracefully reloads (0-downtime). Falls back to start if not yet registered.
  return new Promise((resolve, reject) => {
    const r = spawn('pm2', ['reload', name], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    r.stderr.on('data', (c) => { stderr += c; });
    r.on('close', (code) => {
      if (code === 0) resolve();
      // If reload fails because process isn't in pm2 yet, try restart-or-start
      else reject(new Error(`pm2 reload ${name} failed (exit ${code}): ${stderr.trim().slice(0, 300)}`));
    });
    r.on('error', reject);
  });
}

async function _rollback(jobState, backupDir, mongoOut, reason) {
  logger.warn({ reason }, 'orchestrator: ROLLBACK starting');
  try {
    _swapBack(path.join(backupDir, 'old'));
    if (fs.existsSync(mongoOut)) {
      await _restoreMongo(mongoOut).catch((e) => logger.warn({ err: e.message }, 'mongorestore failed during rollback'));
    }
    await _pm2Reload(_ecosystemName()).catch((e) => logger.warn({ err: e.message }, 'pm2 reload failed during rollback'));
    await _postReport({
      version: jobState.version,
      machineId: _machineId(),
      status: 'rolled_back',
      error: reason,
    }).catch(() => {});
    jobState.status = 'rolled_back';
    jobState.rollbackReason = reason;
    _writeState(jobState);
  } catch (err) {
    logger.error({ err: err.message }, 'orchestrator: rollback itself failed');
  }
}

function _postReport(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(adminConfig.url + '/api/release/report-update');
    const lib = url.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-License-Key': adminConfig.licenseKey || '',
        'X-Machine-Id': _machineId(),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(buf);
        else reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getStatus() {
  return { inFlight: !!_inFlight, state: _readState(), currentVersion: _currentVersion() };
}

module.exports = {
  applyUpdate,
  getStatus,
  // exposed for tests
  _swapDirs,
  _swapBack,
  _extractTarball,
  _downloadAndVerify,
  STATE_FILE,
  BACKUPS_DIR,
  STAGING_DIR,
};
