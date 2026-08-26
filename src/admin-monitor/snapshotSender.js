'use strict';

/**
 * FIX-2026-08-26: Snapshot sender — bot pushes aggregated state to admin
 *
 * Every SNAPSHOT_MS (default 5 min), the bot:
 *   1. Fetches aggregated snapshot from its own /api/admin/snapshot endpoint
 *   2. POSTs it to admin's /api/instances/snapshot
 *
 * Admin stores in Snapshot collection. UI reads from there.
 *
 * Why this pattern (bot pushes) instead of (admin pulls):
 *   - Bot already has DB connection — admin would need one too
 *   - Pushing once per 5min is cheaper than 10 polls from 10 admins
 *   - Simpler error recovery — bot logs once, retries next tick
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('./config');
const { getMachineId } = require('./machineId');
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'admin-monitor/snapshot' }) : rootLogger;

const DEFAULT_SNAPSHOT_MS = config.snapshotMs || 300000;

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
      timeout: 30000,
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
    req.on('timeout', () => req.destroy(new Error('Snapshot HTTP timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function _postJson(targetUrl, body, headers = {}) {
  return _httpJson('POST', targetUrl, body, headers);
}

function _getJson(targetUrl, headers = {}) {
  return _httpJson('GET', targetUrl, null, headers);
}

/**
 * Fetch local snapshot from bot's own /api/admin/snapshot endpoint.
 * Uses the same loopback connection — no extra auth needed since the
 * request originates from the same process (we're calling our own server).
 *
 * For simplicity: just import the aggregation logic directly via HTTP
 * against our own port. In test/dev, can use ADMIN_URL as the local URL.
 */
async function _fetchLocalSnapshot() {
  const url = `${config.botUrl}/api/admin/snapshot`;
  return _getJson(url, { 'X-License-Key': config.licenseKey });
}

class SnapshotSender {
  constructor() {
    this.interval = null;
    this.tickCount = 0;
    this.lastSentAt = null;
    this.lastError = null;
    this.lastSnapshotId = null;
    this.intervalMs = DEFAULT_SNAPSHOT_MS;
  }

  start({ intervalMs } = {}) {
    if (!config.enabled) {
      logger.info('admin-monitor: snapshot sender disabled');
      return;
    }
    if (!config.licenseKey) {
      logger.warn('admin-monitor: snapshot sender skipped (no ADMIN_LICENSE_KEY)');
      return;
    }
    if (intervalMs) this.intervalMs = intervalMs;
    if (this.interval) return;
    this._installInterval();
    logger.info({ intervalMs: this.intervalMs }, 'admin-monitor: snapshot sender started');
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('admin-monitor: snapshot sender stopped');
    }
  }

  _installInterval() {
    if (this.interval) return;
    this._tick();
    this.interval = setInterval(() => this._tick(), this.intervalMs);
  }

  async _tick() {
    this.tickCount++;
    try {
      const snapshot = await _fetchLocalSnapshot();
      const machineId = getMachineId();
      const payload = {
        machineId,
        asOf: snapshot.asOf,
        uptime: snapshot.uptime,
        totals: snapshot.totals,
        bots: snapshot.bots,
        config: snapshot.config,
      };
      const res = await _postJson(`${config.url}/api/instances/snapshot`, payload, {
        'X-License-Key': config.licenseKey,
      });
      this.lastSentAt = Date.now();
      this.lastSnapshotId = res.snapshotId;
      this.lastError = null;
      if (this.tickCount === 1 || this.tickCount % 12 === 0) {
        logger.info({
          tick: this.tickCount,
          snapshotId: res.snapshotId,
          totalBots: snapshot.totals.totalBots,
          runningBots: snapshot.totals.runningBots,
          todayPnl: snapshot.totals.todayPnl,
        }, 'admin-monitor: snapshot sent');
      }
    } catch (err) {
      this.lastError = err.message;
      if (this.tickCount === 1 || this.tickCount % 12 === 0) {
        logger.warn({
          err: err.message,
          status: err.status,
          tick: this.tickCount,
        }, 'admin-monitor: snapshot send failed');
      }
    }
  }
}

module.exports = new SnapshotSender();
