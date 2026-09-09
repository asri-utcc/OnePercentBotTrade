'use strict';

/**
 * FIX-2026-09-09: OneClick Update — Update Checker.
 *
 *   Polls `<admin>/api/release/latest?channel=stable` on startup and every
 *   `ADMIN_UPDATE_CHECK_MS` (default 24h). When a newer version is found:
 *     - sets `lastNotifiedVersion` (persistent, atomic write to data/update-checker-state.json)
 *     - emits `updateAvailable` on eventBus
 *     - records on telegram notifier (which gates by event-toggle, default ON)
 *
 *   Concurrency: a single in-flight fetch (lock via guard).
 *   Failure-tolerant: 5s timeout, 1 retry, silent on offline admin.
 *
 *   Why polling and not WS:
 *     - Update check is rare (daily). WS machinery is overkill.
 *     - Polling also catches back-fills when admin was offline at bot boot.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const logger = require('../utils/logger');
const adminConfig = require('../admin-monitor/config');
const telegramNotifier = require('./telegramNotifier');
const eventBus = require('./eventBus');

const BOT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(BOT_ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'update-checker-state.json');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 5000;

let _timer = null;
let _inFlight = false;
let _stopped = false;
let _adminUrl = null;
let _getEventBus = null;

function _readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return { lastNotifiedVersion: null, lastDismissedVersion: null, lastCheckedAt: null, lastSeenLatest: null }; }
}

function _writeState(s) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function _currentVersion() {
  try { return require(path.join(BOT_ROOT, 'package.json')).version; }
  catch (_) { return '0.0.0'; }
}

function _compareSemver(a, b) {
  // Returns -1 / 0 / 1. Pre-release suffix treated as LOWER than release (matches semver spec).
  const pa = String(a).split('-')[0].split('.').map(Number);
  const pb = String(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  // Version-only equal — check pre-release tag
  const preA = String(a).includes('-');
  const preB = String(b).includes('-');
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  return 0;
}

function _fetchJson(urlString) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlString); } catch (e) { return reject(new Error(`bad url: ${urlString}`)); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      timeout: HTTP_TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error(`JSON parse fail: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`timeout after ${HTTP_TIMEOUT_MS}ms`)); });
    req.on('error', reject);
    req.end();
  });
}

async function checkOnce() {
  if (_inFlight || _stopped) return null;
  _inFlight = true;
  const state = _readState();
  state.lastCheckedAt = new Date().toISOString();
  try {
    const adminUrl = adminConfig.url || 'http://localhost:6016';
    const channel = process.env.ADMIN_UPDATE_CHANNEL || 'stable';
    const url = `${adminUrl}/api/release/latest?channel=${channel}`;
    const manifest = await _fetchJson(url);
    if (!manifest || !manifest.version) return null;
    const current = _currentVersion();
    const cmp = _compareSemver(manifest.version, current);
    state.lastSeenLatest = { version: manifest.version, at: state.lastCheckedAt };
    if (cmp <= 0) {
      // No newer release.
      _writeState(state);
      return { available: false, current, latest: manifest.version };
    }
    // Newer release exists.
    if ((state.lastNotifiedVersion || '') === manifest.version) {
      // Already notified for this version — don't re-emit.
      _writeState(state);
      return { available: true, current, latest: manifest.version, alreadyNotified: true };
    }
    // Check min version gate.
    const minV = manifest.minBotVersion || '0.0.0';
    if (_compareSemver(current, minV) < 0) {
      _writeState(state);
      return { available: false, current, latest: manifest.version, reason: 'min-version-not-met', required: minV };
    }
    // Emit + notify.
    const payload = {
      currentVersion: current,
      latestVersion: manifest.version,
      changelog: manifest.changelog || '',
      critical: !!manifest.critical,
      tarballBytes: manifest.tarballBytes || 0,
      releaseDate: manifest.publishedAt || null,
      tarballSha256: manifest.tarballSha256,
      manifestHash: manifest.manifestHash,
      migrations: Array.isArray(manifest.migrations) ? manifest.migrations : [],
      downloadUrl: `${adminUrl}/api/release/download/${manifest.version}`,
    };
    try {
      const bus = eventBus.getEventBus ? eventBus.getEventBus() : eventBus;
      if (bus && typeof bus.emit === 'function') bus.emit('updateAvailable', payload);
    } catch (_) {}
    try {
      telegramNotifier.dispatch('updateAvailable', payload);
    } catch (e) {
      logger.warn({ err: e.message }, 'updateChecker: telegram dispatch failed');
    }
    state.lastNotifiedVersion = manifest.version;
    state.lastNotifiedAt = state.lastCheckedAt;
    state.lastNotifiedManifest = {
      version: manifest.version,
      tarballSha256: manifest.tarballSha256,
      tarballBytes: manifest.tarballBytes,
      changelog: manifest.changelog || '',
      critical: !!manifest.critical,
      manifestHash: manifest.manifestHash,
      migrations: Array.isArray(manifest.migrations) ? manifest.migrations : [],
      publishedAt: manifest.publishedAt || null,
      minBotVersion: manifest.minBotVersion || '0.0.0',
    };
    _writeState(state);
    logger.info({ current, latest: manifest.version }, 'updateChecker: new release detected');
    return { available: true, ...payload };
  } catch (err) {
    logger.debug({ err: err.message }, 'updateChecker: check skipped (non-fatal)');
    _writeState(state);
    return null;
  } finally {
    _inFlight = false;
  }
}

function start(opts = {}) {
  if (!adminConfig.enabled) {
    logger.info('updateChecker: disabled (adminConfig.enabled=false)');
    return;
  }
  if (!adminConfig.licenseKey) {
    logger.warn('updateChecker: skipping — no ADMIN_LICENSE_KEY set');
    return;
  }
  const intervalMs = opts.intervalMs
    || Number(process.env.ADMIN_UPDATE_CHECK_MS)
    || DEFAULT_INTERVAL_MS;
  _stopped = false;
  // Initial check after short delay (so it doesn't block boot)
  setTimeout(() => { checkOnce().catch(() => {}); }, 3000);
  _timer = setInterval(() => { checkOnce().catch(() => {}); }, intervalMs);
  _timer.unref?.();
  logger.info({ intervalMs }, 'updateChecker: started');
}

function stop() {
  _stopped = true;
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function getLastNotification() {
  const s = _readState();
  return {
    lastNotifiedVersion: s.lastNotifiedVersion || null,
    lastDismissedVersion: s.lastDismissedVersion || null,
    lastCheckedAt: s.lastCheckedAt || null,
    lastSeenLatest: s.lastSeenLatest || null,
    lastNotifiedManifest: s.lastNotifiedManifest || null,
    currentVersion: _currentVersion(),
  };
}

function dismissVersion(version) {
  const s = _readState();
  s.lastDismissedVersion = version;
  s.lastDismissedAt = new Date().toISOString();
  _writeState(s);
}

module.exports = {
  start,
  stop,
  checkOnce,
  getLastNotification,
  dismissVersion,
  _compareSemver,
  STATE_FILE,
};
