'use strict';

/**
 * FIX-2026-08-26: Admin monitor config loader
 *
 * Reads env vars (set in .env or process.env):
 *   ADMIN_ENABLED         - 'true' to enable (default: false)
 *   ADMIN_URL             - admin server URL (e.g., http://localhost:6016)
 *   ADMIN_LICENSE_KEY     - license key issued by admin CLI
 *   ADMIN_HEARTBEAT_MS    - heartbeat interval in ms (default: 300000 = 5 min)
 *   ADMIN_POLL_MS         - command poll interval in ms (default: 60000 = 1 min)
 *
 *   FIX-2026-08-27: HMAC verification (Bug B fix)
 *   ADMIN_COMMAND_HMAC_SECRET - shared HMAC secret for command signature
 *     - If unset, falls back to process.env.JWT_SECRET (admin's signing secret)
 *     - If still unset, derives deterministically via SHA-256(licenseKey + ':cmd-hmac:v1')
 *     - This means commands signed by admin are verifiable by bot without
 *       any extra env coordination (the licenseKey is already shared).
 *
 * If ADMIN_ENABLED is not 'true', the module is dormant (no-op).
 */

const path = require('path');
const crypto = require('crypto');

function _bool(s, def = false) {
  if (s === undefined || s === null || s === '') return def;
  return String(s).toLowerCase() === 'true';
}

function _int(s, def) {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : def;
}

/**
 * FIX-2026-08-27: derive deterministic HMAC secret from licenseKey when no
 * explicit env is set. This lets admin and bot agree on a signature secret
 * without additional env wiring (licenseKey is already shared).
 * Returns null only if licenseKey is empty (in which case verifySignature
 * will reject all commands anyway).
 */
function _deriveCommandHmacSecret(licenseKey) {
  if (!licenseKey) return null;
  return crypto
    .createHash('sha256')
    .update(`${licenseKey}:cmd-hmac:v1`)
    .digest('hex');
}

const _licenseKey = process.env.ADMIN_LICENSE_KEY || '';
const _envSecret = process.env.ADMIN_COMMAND_HMAC_SECRET
  || process.env.JWT_SECRET
  || _deriveCommandHmacSecret(_licenseKey);

const config = {
  enabled: _bool(process.env.ADMIN_ENABLED, false),
  url: process.env.ADMIN_URL || 'http://localhost:6016',
  licenseKey: _licenseKey,
  // FIX-2026-08-26: per-customer watermark tag. Echoed in every heartbeat to admin.
  //   If code is leaked and run by an unauthorized machine, the tag still
  //   identifies which customer it came from. Set per-customer at delivery time.
  customerTag: process.env.ADMIN_CUSTOMER_TAG || '',
  heartbeatMs: _int(process.env.ADMIN_HEARTBEAT_MS, 300000),
  pollMs: _int(process.env.ADMIN_POLL_MS, 60000),
  // FIX-2026-08-26: local bot URL (used by snapshotSender to fetch local snapshot)
  //   Defaults to http://127.0.0.1:6015 (bot default port).
  botUrl: process.env.ADMIN_BOT_URL || process.env.BOT_URL || 'http://127.0.0.1:6015',
  snapshotMs: _int(process.env.ADMIN_SNAPSHOT_MS, 300000),
  botVersion: require(path.join(__dirname, '..', '..', 'package.json')).version,
  // FIX-2026-08-27: HMAC secret for command signature verification (Bug B).
  // Null only if licenseKey empty (verifySignature rejects all commands then).
  commandHmacSecret: _envSecret,
  // Source of the secret (for logging / diagnostics) — never log the secret itself.
  commandHmacSource: process.env.ADMIN_COMMAND_HMAC_SECRET
    ? 'env:ADMIN_COMMAND_HMAC_SECRET'
    : process.env.JWT_SECRET
      ? 'env:JWT_SECRET'
      : 'derived:licenseKey',
};

module.exports = config;
