'use strict';

/**
 * FIX-2026-08-26 Phase 2c: Push consent decision to admin DB.
 *
 *   Called whenever the user makes a decision (first-run or settings change).
 *   Uses the same HTTP client + X-License-Key auth as adminMonitor's heartbeat,
 *   but is a separate endpoint: POST /api/instances/consent.
 *
 *   Best-effort: if admin is unreachable, we still write to local file first;
 *   on next successful heartbeat the bot will re-push to retry.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('../admin-monitor/config');
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'consent-api' }) : rootLogger;

/**
 * Push the consent decision to admin. Returns true on 2xx, false otherwise.
 * Never throws — callers should log + continue regardless.
 */
async function pushDecision({ machineId, decision, consentVersion, source }) {
  if (!config.enabled || !config.licenseKey || !config.url) {
    logger.info('consent: admin-monitor not enabled — skipping push');
    return false;
  }
  const body = JSON.stringify({ machineId, decision, consentVersion, source });
  let urlObj;
  try {
    urlObj = new URL('/api/instances/consent', config.url);
  } catch (err) {
    logger.warn({ err: err.message }, 'consent: admin URL invalid');
    return false;
  }
  const lib = urlObj.protocol === 'https:' ? https : http;
  const opts = {
    method: 'POST',
    hostname: urlObj.hostname,
    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
    path: urlObj.pathname,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-License-Key': config.licenseKey,
    },
    timeout: 5000,
  };
  return new Promise((resolve) => {
    const req = lib.request(opts, (res) => {
      // drain
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          logger.info({ statusCode: res.statusCode, decision }, 'consent: pushed to admin');
          resolve(true);
        } else {
          logger.warn({ statusCode: res.statusCode, decision }, 'consent: admin returned non-2xx');
          resolve(false);
        }
      });
    });
    req.on('error', (err) => {
      logger.warn({ err: err.message }, 'consent: admin push failed (network)');
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.write(body);
    req.end();
  });
}

module.exports = { pushDecision };