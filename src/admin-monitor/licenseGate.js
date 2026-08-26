'use strict';

/**
 * FIX-2026-08-26: License gate — runtime enforcement of admin-issued license
 *
 * Without a valid license (or if admin revokes it), the bot refuses to start.
 * Periodic re-validation catches mid-session revocations.
 *
 * Flow:
 *   1. Bot startup → call validate() → if fails, throw → process exits
 *   2. Periodic check (every REVALIDATE_MS) → if revoked, pause botManager + emit event
 *   3. validate() uses the same admin /api/instances/validate endpoint
 *
 * Machine binding: the admin's Machine record (created by heartbeat) is required
 *   for validation to succeed. So a fresh clone on a new machine cannot run
 *   without admin first registering the machine + license.
 *
 * This is the runtime anti-piracy layer. Combined with admin's license
 * issuance flow, junior colleagues cloning the public GitHub repo cannot run
 * the bot without an admin-issued license bound to their machineId.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('./config');
const { getMachineId } = require('./machineId');
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'admin-monitor/license-gate' }) : rootLogger;

const REVALIDATE_MS = parseInt(process.env.ADMIN_LICENSE_REVALIDATE_MS || '3600000', 10); // 1h

let _botManager = null;
let _interval = null;
let _lastValidLicense = null;
let _lastValidatedAt = null;

function _postJson(targetUrl, body, headers = {}) {
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
    req.on('timeout', () => req.destroy(new Error('License validate timeout')));
    req.write(data);
    req.end();
  });
}

/**
 * One-shot validation. Throws on failure.
 * Returns license + machine info on success.
 */
async function validate({ throwOnFail = true } = {}) {
  if (!config.enabled || !config.licenseKey) {
    const err = new Error('admin-monitor disabled or ADMIN_LICENSE_KEY missing');
    err.code = 'NO_LICENSE';
    if (throwOnFail) throw err;
    return null;
  }

  const machineId = getMachineId();
  try {
    const res = await _postJson(
      `${config.url}/api/instances/validate`,
      { machineId },
      { 'X-License-Key': config.licenseKey }
    );
    _lastValidLicense = res.license;
    _lastValidatedAt = Date.now();
    logger.info({
      owner: res.license?.owner,
      tier: res.license?.tier,
      expiresAt: res.license?.expiresAt,
      machineStatus: res.machine?.status,
    }, 'license-gate: validated');
    return res;
  } catch (err) {
    logger.warn({ err: err.message, status: err.status, body: err.body }, 'license-gate: validation failed');
    if (throwOnFail) {
      const e = new Error(`License validation failed: ${err.message} (status=${err.status || 'n/a'})`);
      e.code = 'LICENSE_INVALID';
      e.status = err.status;
      e.body = err.body;
      throw e;
    }
    return null;
  }
}

/**
 * Periodic re-validation. On revocation: pause botManager + emit event.
 */
class LicenseGate {
  start({ botManager } = {}) {
    _botManager = botManager;
    if (!config.enabled) {
      logger.info('license-gate: disabled (no ADMIN_ENABLED)');
      return;
    }
    if (!config.licenseKey) {
      logger.warn('license-gate: enabled but ADMIN_LICENSE_KEY missing');
      return;
    }
    if (_interval) return;
    _interval = setInterval(() => this._tick().catch(() => {}), REVALIDATE_MS);
    logger.info({ intervalMs: REVALIDATE_MS }, 'license-gate: periodic re-validation started');
  }

  stop() {
    if (_interval) {
      clearInterval(_interval);
      _interval = null;
      logger.info('license-gate: stopped');
    }
  }

  async _tick() {
    const wasValid = !!_lastValidLicense;
    try {
      await validate({ throwOnFail: false });
      // If we were invalid and now valid (admin re-issued), resume
      if (!wasValid && _botManager?.resume) {
        logger.warn('license-gate: license restored — resuming bot');
        _botManager.resume();
      }
    } catch (err) {
      // Treat any error as "no longer valid"
      if (wasValid) {
        logger.error({ err: err.message }, 'license-gate: license became invalid — pausing bot');
        _botManager?.pause?.('license_invalidated');
        _botManager?.setConfig?.('licenseRevoked', true);
        _lastValidLicense = null;
      }
    }
  }

  get isValid() { return !!_lastValidLicense; }
  get lastLicense() { return _lastValidLicense; }
  get lastValidatedAt() { return _lastValidatedAt; }
}

module.exports = new LicenseGate();
module.exports.validate = validate;
module.exports.REVALIDATE_MS = REVALIDATE_MS;
