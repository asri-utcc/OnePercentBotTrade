'use strict';

/**
 * FIX-2026-08-26: Admin command listener
 *
 * Periodically polls admin server for pending commands targeting this machine.
 * Verifies HMAC signature, then dispatches to executor.
 * Reports execution result back to admin.
 *
 * Uses HMAC-SHA256 with shared secret:
 *   - ADMIN_COMMAND_HMAC_SECRET env (preferred), OR
 *   - JWT_SECRET env, OR
 *   - SHA-256(licenseKey + ':cmd-hmac:v1') derived deterministically
 *
 * The signature is over JSON.stringify({ commandId, type, payload, issuedAt })
 * — must match admin's signCommand() formula exactly.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const config = require('./config');
const { getMachineId } = require('./machineId');
const executor = require('./commandExecutor');
const eventBus = require('../services/eventBus'); // FIX-2026-08-26 Phase 2f
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'admin-monitor/listener' }) : rootLogger;

const processStartTime = Date.now();

// FIX-2026-09-01 audit C1: command-replay protection window.
//   Without this, any captured signed command (e.g. via unencrypted network or
//   malicious bot extension) can be replayed until the command's Mongo expiresAt
//   (default ttlSeconds=3600 = 1h). 5 min window is short enough to defeat
//   mass-replay but generous enough for legitimate clock skew across the
//   admin ↔ bot boundary.
const MAX_COMMAND_SKEW_MS = 5 * 60 * 1000;

/**
 * FIX-2026-08-27 Bug B: Verify HMAC-SHA256 signature from admin.
 *
 * Returns:
 *   { ok: true }   when signature matches
 *   { ok: false, reason: <string> }  otherwise
 *
 * Uses crypto.timingSafeEqual to prevent timing attacks.
 * If config.commandHmacSecret is null (licenseKey empty), all commands reject.
 *
 * FIX-2026-09-01 audit C1: also enforces an `issuedAt` skew window of
 * MAX_COMMAND_SKEW_MS (5 min default) so a captured signed command cannot be
 * replayed across the full 1h Mongo TTL window.
 */
function verifySignature(cmd) {
  const { commandId, type, payload, issuedAt, signature } = cmd;
  const secret = config.commandHmacSecret;
  if (!secret) {
    return { ok: false, reason: 'no_hmac_secret_configured' };
  }
  if (!signature || typeof signature !== 'string') {
    return { ok: false, reason: 'missing_signature' };
  }
  // FIX-2026-09-01 audit C1: timestamp-window check BEFORE signature check
  // (no point computing HMAC if we're going to reject by skew anyway).
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
    return { ok: false, reason: 'missing_issuedAt' };
  }
  const skew = Math.abs(Date.now() - issuedAt);
  if (skew > MAX_COMMAND_SKEW_MS) {
    return { ok: false, reason: `timestamp_skew:${skew}ms>${MAX_COMMAND_SKEW_MS}ms` };
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify({ commandId, type, payload, issuedAt }))
    .digest('hex');
  // timingSafeEqual requires equal-length buffers
  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(signature, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch (e) {
    return { ok: false, reason: 'invalid_signature_encoding' };
  }
  if (sigBuf.length !== expBuf.length || sigBuf.length === 0) {
    return { ok: false, reason: 'signature_length_mismatch' };
  }
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}

function httpGet(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      timeout: 10000,
    }, (res) => {
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
    req.on('timeout', () => req.destroy(new Error('Command poll timed out')));
    req.end();
  });
}

function httpPost(targetUrl, body, headers = {}) {
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
            const err = new Error(json.message || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            reject(err);
          }
        } catch (e) {
          reject(new Error(`Invalid JSON: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Command report timed out')));
    req.write(data);
    req.end();
  });
}

class CommandListener {
  constructor() {
    this.interval = null;
    this.inFlight = false;
    this.tickCount = 0;
    this.lastPollAt = null;
    this.lastError = null;
    this.ctx = {};
  }

  start(ctx = {}) {
    if (!config.enabled) {
      logger.info('admin-monitor: listener disabled');
      return;
    }
    if (!config.licenseKey) {
      logger.warn('admin-monitor: ADMIN_LICENSE_KEY not set, listener disabled');
      return;
    }
    this.ctx = ctx;
    this._installInterval();
    logger.info({
      url: config.url,
      intervalMs: config.pollMs,
    }, 'admin-monitor: command listener started');
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('admin-monitor: command listener stopped');
    }
  }

  _installInterval() {
    if (this.interval) return;
    this._poll();
    this.interval = setInterval(() => this._poll(), config.pollMs);
  }

  async _poll() {
    if (this.inFlight) return; // skip if previous still running
    this.inFlight = true;
    this.tickCount++;
    try {
      const machineId = getMachineId();
      const url = `${config.url}/api/instances/${encodeURIComponent(machineId)}/commands`;
      const { commands } = await httpGet(url, { 'X-License-Key': config.licenseKey });
      this.lastPollAt = Date.now();
      this.lastError = null;
      // FIX-2026-08-26 Phase 2f: notify phone-home monitor on success
      try { eventBus.emit('admin:contact_success', { source: 'command_poll' }); } catch (e) { /* ignore */ }

      if (commands && commands.length > 0) {
        logger.info({ count: commands.length }, 'admin-monitor: fetched pending commands');
        for (const cmd of commands) {
          await this._executeAndReport(cmd);
        }
      }
    } catch (err) {
      this.lastError = err.message;
      // Only log first failure + every 30th to avoid spam
      if (this.tickCount === 1 || this.tickCount % 30 === 0) {
        logger.warn({ err: err.message, status: err.status, tick: this.tickCount }, 'admin-monitor: poll failed');
      }
      // FIX-2026-08-26: race recovery — first poll can fire before heartbeat registers
      //   the machine in admin DB. Retry once after 500ms if 403 "forbidden".
      if (err.status === 403 && this.tickCount === 1) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const retryMachineId = getMachineId();
          const retryUrl = `${config.url}/api/instances/${encodeURIComponent(retryMachineId)}/commands`;
          const { commands: retryCommands } = await httpGet(retryUrl, { 'X-License-Key': config.licenseKey });
          if (retryCommands && retryCommands.length > 0) {
            logger.info({ count: retryCommands.length }, 'admin-monitor: retry fetched pending commands');
            for (const cmd of retryCommands) {
              await this._executeAndReport(cmd);
            }
          }
          this.lastError = null;
        } catch (retryErr) {
          // swallow — already logged above
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  async _executeAndReport(cmd) {
    const { commandId, type } = cmd;
    // FIX-2026-08-27 Bug B: verify HMAC signature BEFORE executing.
    // Reject forged/tampered commands and report failure back to admin.
    const sigResult = verifySignature(cmd);
    if (!sigResult.ok) {
      logger.warn({
        commandId, type, reason: sigResult.reason,
      }, 'admin-monitor: command signature verification failed — rejecting');
      try {
        await this._reportResult(commandId, 'failed', null, `signature_invalid:${sigResult.reason}`);
      } catch (_) { /* swallow report failure */ }
      return;
    }
    try {
      const result = await executor.execute(cmd, this.ctx);
      await this._reportResult(commandId, 'completed', result, null);
    } catch (err) {
      logger.error({ commandId, type, err: err.message }, 'admin-monitor: command execution failed');
      await this._reportResult(commandId, 'failed', null, err.message).catch(() => {});
    }
  }

  async _reportResult(commandId, status, result, error) {
    const url = `${config.url}/api/instances/command-result`;
    return httpPost(url,
      { commandId, status, result, error },
      { 'X-License-Key': config.licenseKey }
    );
  }
}

module.exports = new CommandListener();
