'use strict';

const config = require('../../../config');
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

module.exports = { requireAuth, requireBotActionPassword };