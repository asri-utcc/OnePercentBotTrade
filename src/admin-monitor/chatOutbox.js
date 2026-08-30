'use strict';

/**
 * Phase 4-2026-08-29 — Chat outbox (bot → admin).
 *
 * Operator-facing UI enqueues messages here; chatOutbox POSTs them to the
 * admin server every chatOutboxMs (default 3s) in batches of up to
 * chatOutboxBatch (default 10). Retries on 5xx/network errors; drops on 4xx
 * (caller's fault — invalid text, rate limit, etc.).
 *
 * Why a queue instead of direct POST: the UI shouldn't block on the network,
 * and we need retry-on-5xx without re-prompting the user. After successful
 * delivery, the message is also in our local ring buffer (via chatInbox poll
 * returning the same doc) — but we also optimistically append to the local
 * buffer immediately for snappy UX.
 *
 * Public API:
 *   - enqueue({ scope, text, clientId, createdAt }) → { queued: true, id }
 *   - start({ intervalMs?, batchSize? })
 *   - stop()
 *   - drainOnce()    → test helper
 *   - _state()       → test helper
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const config = require('./config');
const { getMachineId } = require('./machineId');
const rootLogger = require('../utils/logger');
const chatLocalStore = require('../services/chatLocalStore');

const logger = rootLogger.child ? rootLogger.child({ module: 'admin-monitor/chatOutbox' }) : rootLogger;

const DEFAULT_INTERVAL_MS = config.chatOutboxMs || 3000;
const DEFAULT_BATCH = config.chatOutboxBatch || 10;

const _queue = []; // FIFO of pending messages
let _intervalHandle = null;
let _intervalMs = DEFAULT_INTERVAL_MS;
let _batchSize = DEFAULT_BATCH;
let _drainInFlight = false;

function enqueue({ scope, text, clientId, createdAt, displayName }) {
  const safeScope = scope === 'dm' ? 'dm' : 'community';
  const safeText = String(text || '').slice(0, 2000);
  if (!safeText.trim()) {
    throw new Error('text required');
  }
  const safeClientId = String(clientId || randomUUID()).slice(0, 80);
  const safeCreatedAt = createdAt || new Date().toISOString();
  const msg = {
    id: safeClientId,
    scope: safeScope,
    text: safeText,
    clientId: safeClientId,
    createdAt: safeCreatedAt,
    displayName: String(displayName || chatLocalStore.resolveDisplayName()).slice(0, 32),
    _attempts: 0,
    _queuedAt: Date.now(),
  };
  _queue.push(msg);
  // Optimistic local append for snappy UX — actual server message arrives via inbox poll.
  // Phase 4-FIX-2026-08-30: also pass clientId so dedupe-by-clientId works when inbox echoes.
  chatLocalStore.addMessage({
    id: safeClientId,
    clientId: safeClientId,
    scope: safeScope,
    fromAdmin: false,
    fromMachineId: getMachineId(),
    toMachineId: safeScope === 'dm' ? null : null,
    displayName: msg.displayName,
    text: safeText,
    createdAt: safeCreatedAt,
  });
  return { queued: true, id: safeClientId };
}

function _httpJson(method, targetUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(data ? { 'Content-Length': data.length } : {}),
      },
      timeout: 10000,
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else {
          const err = new Error(json.message || json.error || `HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          err.body = json;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('ChatOutbox HTTP timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function _postOne(msg) {
  const url = `${config.url}/api/instances/${encodeURIComponent(getMachineId())}/chat/send`;
  const body = {
    scope: msg.scope,
    text: msg.text,
    clientId: msg.clientId,
    createdAt: msg.createdAt,
    displayName: msg.displayName,
  };
  return _httpJson('POST', url, body, {
    'X-License-Key': config.licenseKey,
  });
}

async function drainOnce() {
  if (_drainInFlight) return { sent: 0, skipped: 'in_flight' };
  if (!config.enabled) return { sent: 0, skipped: 'admin_disabled' };
  if (!config.licenseKey) return { sent: 0, skipped: 'no_license' };
  if (_queue.length === 0) return { sent: 0 };
  _drainInFlight = true;
  const batch = _queue.slice(0, _batchSize);
  let sent = 0;
  try {
    for (const msg of batch) {
      msg._attempts++;
      try {
        await _postOne(msg);
        // success — remove from queue
        const idx = _queue.indexOf(msg);
        if (idx !== -1) _queue.splice(idx, 1);
        sent++;
      } catch (err) {
        if (err.status && err.status >= 400 && err.status < 500) {
          // 4xx — drop (invalid text, rate limit, etc.)
          logger.warn({ clientId: msg.clientId, status: err.status, msg: err.message }, 'admin-monitor/chatOutbox: dropping 4xx');
          const idx = _queue.indexOf(msg);
          if (idx !== -1) _queue.splice(idx, 1);
        } else {
          // 5xx / network — leave in queue, cap attempts to 20
          logger.warn({ clientId: msg.clientId, attempts: msg._attempts, msg: err.message }, 'admin-monitor/chatOutbox: retry');
          if (msg._attempts >= 20) {
            logger.error({ clientId: msg.clientId }, 'admin-monitor/chatOutbox: giving up after 20 attempts');
            const idx = _queue.indexOf(msg);
            if (idx !== -1) _queue.splice(idx, 1);
          }
        }
      }
    }
  } finally {
    _drainInFlight = false;
  }
  return { sent };
}

function start({ intervalMs, batchSize } = {}) {
  if (!config.enabled) {
    logger.info('admin-monitor/chatOutbox: disabled (admin not enabled)');
    return;
  }
  if (!config.licenseKey) {
    logger.warn('admin-monitor/chatOutbox: skipped (no ADMIN_LICENSE_KEY)');
    return;
  }
  if (intervalMs) _intervalMs = intervalMs;
  if (batchSize) _batchSize = batchSize;
  if (_intervalHandle) return;
  _intervalHandle = setInterval(() => {
    drainOnce().catch((e) => logger.warn({ err: e.message }, 'admin-monitor/chatOutbox drain error'));
  }, _intervalMs);
  logger.info({ intervalMs: _intervalMs, batchSize: _batchSize }, 'admin-monitor/chatOutbox: started');
}

function stop() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
    logger.info('admin-monitor/chatOutbox: stopped');
  }
}

function _state() {
  return {
    queueLength: _queue.length,
    intervalMs: _intervalMs,
    batchSize: _batchSize,
    inFlight: _drainInFlight,
    running: !!_intervalHandle,
  };
}

/** Test helper — wipe queue + stop. */
function _reset() {
  stop();
  _queue.length = 0;
  _drainInFlight = false;
  _intervalMs = DEFAULT_INTERVAL_MS;
  _batchSize = DEFAULT_BATCH;
}

module.exports = {
  enqueue,
  drainOnce,
  start,
  stop,
  _state,
  _reset,
};
