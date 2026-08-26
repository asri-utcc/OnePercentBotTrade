'use strict';

/**
 * FIX-2026-08-26: Heartbeat sender
 *
 * Periodically POST /api/instances/heartbeat to admin server with:
 *   - machineId
 *   - licenseKey
 *   - hostname, platform, nodeVersion, botVersion
 *   - metrics (runningBots, activePositions, uptime, errors)
 *
 * Failure is logged but never crashes the bot.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const os = require('os');
const config = require('./config');
const { getMachineId, getHostInfo } = require('./machineId');
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'admin-monitor/heartbeat' }) : rootLogger;

/**
 * Build current metrics snapshot.
 * Caller provides a getter so we don't import bot internals (avoid circular deps).
 */
async function buildMetrics(metricsGetter) {
  if (typeof metricsGetter === 'function') {
    try {
      return await metricsGetter();
    } catch (err) {
      logger.warn({ err: err.message }, 'metrics getter failed');
    }
  }
  return {
    runningBots: 0,
    activePositions: 0,
    uptime: Math.floor(process.uptime()),
    errors: 0,
  };
}

/**
 * POST JSON to admin server. Returns parsed response or throws.
 */
function postJson(targetUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const opts = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        ...headers,
      },
      timeout: 10000,
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try {
          const json = text ? JSON.parse(text) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            const err = new Error(json.message || json.error || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.body = json;
            reject(err);
          }
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Heartbeat request timed out'));
    });
    req.write(data);
    req.end();
  });
}

/**
 * Send one heartbeat.
 */
async function sendOnce(metricsGetter) {
  const machineId = getMachineId();
  const host = getHostInfo();
  const metrics = await buildMetrics(metricsGetter);

  const payload = {
    machineId,
    hostname: host.hostname,
    platform: host.platform,
    nodeVersion: process.version,
    botVersion: config.botVersion,
    metrics,
  };

  const headers = {
    'X-License-Key': config.licenseKey,
  };

  return postJson(`${config.url}/api/instances/heartbeat`, payload, headers);
}

class HeartbeatSender {
  constructor() {
    this.interval = null;
    this.tickCount = 0;
    this.lastSentAt = null;
    this.lastError = null;
    this.lastResponse = null;
    this.metricsGetter = null;
  }

  start({ metricsGetter } = {}) {
    if (!config.enabled) {
      logger.info('admin-monitor: heartbeat disabled');
      return;
    }
    if (!config.licenseKey) {
      logger.warn('admin-monitor: ADMIN_LICENSE_KEY not set, heartbeat disabled');
      return;
    }
    this.metricsGetter = metricsGetter;
    this._installInterval();
    logger.info({
      url: config.url,
      intervalMs: config.heartbeatMs,
      machineId: getMachineId().slice(0, 12) + '...',
    }, 'admin-monitor: heartbeat started');
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('admin-monitor: heartbeat stopped');
    }
  }

  _installInterval() {
    if (this.interval) return;
    // Send one immediately, then every N ms
    this._tick();
    this.interval = setInterval(() => this._tick(), config.heartbeatMs);
  }

  async _tick() {
    this.tickCount++;
    try {
      const res = await sendOnce(this.metricsGetter);
      this.lastSentAt = Date.now();
      this.lastError = null;
      this.lastResponse = res;
      if (this.tickCount === 1 || this.tickCount % 12 === 0) {
        // Log first tick + every hour (12 ticks at 5min interval)
        logger.info({ tick: this.tickCount, serverTime: res.serverTime }, 'admin-monitor: heartbeat sent');
      }
    } catch (err) {
      this.lastError = err.message;
      logger.warn({
        err: err.message,
        status: err.status,
        tick: this.tickCount,
      }, 'admin-monitor: heartbeat failed');
    }
  }
}

module.exports = new HeartbeatSender();
module.exports.sendOnce = sendOnce;
