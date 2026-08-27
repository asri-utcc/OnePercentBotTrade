'use strict';

const crypto = require('crypto');
const config = require('../../../config');
const adminMonitorConfig = require('../../admin-monitor/config');
const logger = require('../../utils/logger');

/**
 * Session-based auth middleware
 * - ดู req.session.authenticated
 * - ถ้าไม่ authenticated → 401
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated === true) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * FIX-2026-08-27: license-key auth for admin-proxy endpoints.
 *
 * Allows requests with a valid `X-License-Key` header (matching the bot's own
 * `ADMIN_LICENSE_KEY`) to access selected read-only endpoints (e.g. positions)
 * without a session cookie. This is what admin uses when proxying its dashboard
 * calls back to the bot.
 *
 * Security model:
 *   - Admin issued the licenseKey itself; it's not a public secret
 *   - Endpoint usage is gated by IP/network (admin talks to bot on localhost)
 *   - Comparison uses timingSafeEqual to prevent timing leaks
 *   - Falls back to session cookie if header missing (so the existing browser
 *     flow still works)
 *
 * Use case: admin's `/api/instances/admin/:machineId/positions` proxy hits
 *   GET http://127.0.0.1:6015/api/bots/positions?machineId=xxx
 *   with X-License-Key: P4RMHSRU-... — without this middleware the bot rejects
 *   with 401 because there's no session cookie, and the admin proxy converts
 *   that to 502 to the user's browser.
 */
function requireAuthOrLicenseKey(req, res, next) {
  // 1) existing session path — unchanged
  if (req.session && req.session.authenticated === true) {
    return next();
  }
  // 2) license-key header path
  const provided = (req.get('X-License-Key') || '').trim();
  const expected = (adminMonitorConfig.licenseKey || '').trim();
  if (!expected) {
    logger.warn({ path: req.path, ip: req.ip }, 'admin-proxy: bot has no ADMIN_LICENSE_KEY set — cannot verify X-License-Key');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!provided) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // timingSafeEqual requires equal-length buffers
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    logger.warn({ path: req.path, ip: req.ip, hasHeader: true }, 'admin-proxy: X-License-Key mismatch');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

/**
 * FIX-2026-08-24 (P2 audit): extract requireBotActionPassword to shared middleware
 *   - เดิม: local function ใน bot.routes.js อย่างเดียว → analysis.routes.js, wallet.routes.js
 *     re-implement หรือ skip → inconsistent auth posture
 *   - fix: export จาก middleware/auth.js, bot.routes.js use shared version
 *   - check password จาก body.password, header X-Bot-Action-Password, query ?password=
 *   - ถ้า config.botActionPassword ว่าง → reject (force secure by default)
 */
function requireBotActionPassword(req, res, next) {
  const expected = (config.botActionPassword || '').trim();
  if (!expected) {
    logger.warn({ path: req.path, ip: req.ip }, 'bot action blocked: BOT_ACTION_PASSWORD not configured');
    return res.status(503).json({
      error: 'Bot actions are disabled because BOT_ACTION_PASSWORD is not set. Set it in .env to enable create/delete/enable/disable.',
    });
  }
  const provided = (
    (req.body && req.body.password)
    || req.get('X-Bot-Action-Password')
    || req.query.password
    || ''
  ).toString().trim();
  if (!provided || provided !== expected) {
    logger.warn({ path: req.path, ip: req.ip, hasPassword: !!provided }, 'bot action blocked: invalid/missing password');
    return res.status(403).json({ error: 'Invalid or missing password for bot action' });
  }
  next();
}

module.exports = { requireAuth, requireAuthOrLicenseKey, requireBotActionPassword };