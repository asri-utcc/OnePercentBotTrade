'use strict';

/**
 * Phase 4-2026-08-29 — Chat inbox (admin → bot).
 *
 * Every chatInboxMs (default 5s), polls the admin server for new messages
 * addressed to this machine: community messages + DMs where toMachineId === us.
 *
 * Each new message is:
 *   1. Stored in chatLocalStore ring buffer (admin is canonical)
 *   2. Emitted on eventBus as 'chat:message' → dashboardWs broadcasts to browser
 *
 * Cursor: latest message's `createdAt` ISO timestamp.
 *
 * Public API:
 *   - start({ intervalMs? })
 *   - stop()
 *   - pollOnce()  → test helper
 *   - _state()    → test helper
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('./config');
const { getMachineId } = require('./machineId');
const rootLogger = require('../utils/logger');
const chatLocalStore = require('../services/chatLocalStore');

const logger = rootLogger.child ? rootLogger.child({ module: 'admin-monitor/chatInbox' }) : rootLogger;

const DEFAULT_INTERVAL_MS = config.chatInboxMs || 5000;
const POLL_LIMIT = 50;

let _intervalHandle = null;
let _intervalMs = DEFAULT_INTERVAL_MS;
let _cursor = null;       // ISO string of latest seen message
let _lastServerTime = null;
let _lastError = null;
let _lastFetchedCount = 0;
let _pollInFlight = false;

function _httpJson(method, targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', ...headers },
      timeout: 10000,
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try {
          const json = text ? JSON.parse(text) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else {
            const err = new Error(json.message || json.error || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.body = json;
            reject(err);
          }
        } catch (e) {
          reject(new Error(`Invalid JSON: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('ChatInbox HTTP timeout')));
    req.end();
  });
}

async function pollOnce() {
  if (_pollInFlight) return { fetched: 0, skipped: 'in_flight' };
  if (!config.enabled) return { fetched: 0, skipped: 'admin_disabled' };
  if (!config.licenseKey) return { fetched: 0, skipped: 'no_license' };
  _pollInFlight = true;
  try {
    const params = new URLSearchParams();
    if (_cursor) params.set('since', _cursor);
    params.set('limit', String(POLL_LIMIT));
    const url = `${config.url}/api/instances/${encodeURIComponent(getMachineId())}/chat/inbox?${params.toString()}`;
    const res = await _httpJson('GET', url, {
      'X-License-Key': config.licenseKey,
    });
    const messages = Array.isArray(res.messages) ? res.messages : [];
    let count = 0;
    for (const m of messages) {
      chatLocalStore.addMessage(m);
      count++;
      // Emit on eventBus (dashboardWs forwards to browser)
      try {
        const { getEventBus } = require('../services/eventBus');
        const bus = getEventBus && getEventBus();
        if (bus && typeof bus.emit === 'function') {
          bus.emit('chat:message', m);
        }
      } catch (_) { /* eventBus optional */ }
      _cursor = m.createdAt;
    }
    _lastServerTime = res.serverTime || new Date().toISOString();
    _lastFetchedCount = count;
    _lastError = null;
    return { fetched: count };
  } catch (err) {
    _lastError = err.message || String(err);
    logger.warn({ err: _lastError }, 'admin-monitor/chatInbox: poll failed');
    return { fetched: 0, error: _lastError };
  } finally {
    _pollInFlight = false;
  }
}

function start({ intervalMs } = {}) {
  if (!config.enabled) {
    logger.info('admin-monitor/chatInbox: disabled (admin not enabled)');
    return;
  }
  if (!config.licenseKey) {
    logger.warn('admin-monitor/chatInbox: skipped (no ADMIN_LICENSE_KEY)');
    return;
  }
  if (intervalMs) _intervalMs = intervalMs;
  if (_intervalHandle) return;
  _intervalHandle = setInterval(() => {
    pollOnce().catch(() => {});
  }, _intervalMs);
  logger.info({ intervalMs: _intervalMs }, 'admin-monitor/chatInbox: started');
}

function stop() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
    logger.info('admin-monitor/chatInbox: stopped');
  }
}

function _state() {
  return {
    cursor: _cursor,
    intervalMs: _intervalMs,
    inFlight: _pollInFlight,
    running: !!_intervalHandle,
    lastServerTime: _lastServerTime,
    lastError: _lastError,
    lastFetchedCount: _lastFetchedCount,
  };
}

function _reset() {
  stop();
  _cursor = null;
  _lastServerTime = null;
  _lastError = null;
  _lastFetchedCount = 0;
  _intervalMs = DEFAULT_INTERVAL_MS;
  _pollInFlight = false;
}

module.exports = {
  pollOnce,
  start,
  stop,
  _state,
  _reset,
};
