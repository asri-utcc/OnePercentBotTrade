'use strict';

/**
 * FIX-2026-08-09: loginAudit — log failed login attempts to MongoDB
 *
 * Why: Sessions Manager page (`/password-sessions.html`) now has a 'Failed Logins' tab
 *      showing recent failed attempts (wrong password, OTP wrong, locked, etc.)
 *
 * Used by:
 *   - src/api/routes/auth.routes.js (5 failure sites: /login + /login-telegram/*)
 *
 * Persisted to LoginAttempt collection (src/db/models/LoginAttempt.js):
 *   - TTL 30 days (auto-cleanup)
 *   - Indexed on `at` (desc) for recent-first queries
 *
 * Failure-safe: errors here MUST NOT propagate to caller (logging must never
 *   break the actual auth flow). Errors go to logger.warn only.
 */

const LoginAttempt = require('../db/models/LoginAttempt');
const { parseDeviceLabel } = require('./deviceLabel');
const logger = require('./logger');

const VALID_METHODS = new Set(['password', 'telegram-otp']);
const VALID_REASONS = new Set([
  'wrong-password',
  'locked',
  'rate-limited',
  'telegram-disabled',
  'telegram-event-disabled',
  'otp-wrong',
  'otp-locked',
  'otp-expired',
  'otp-malformed',
  'otp-token-invalid',
]);

/**
 * Persist a failed login attempt. Best-effort: never throws.
 *
 * @param {object} args
 * @param {string} args.ip — client IP
 * @param {'password'|'telegram-otp'} args.method
 * @param {string} args.reason — see VALID_REASONS
 * @param {string} [args.userAgent] — request User-Agent
 * @param {string} [args.attemptedPassword] — FIX-2026-08-10: password used (password method only).
 *   Plaintext stored (max 256 chars) so admin can audit against their old passwords.
 *   Ignored for telegram-otp + rate-limited/locked (no password was tried).
 */
async function logFailedLoginAttempt(args) {
  try {
    const { ip, method, reason, userAgent = '', attemptedPassword = '' } = args || {};
    if (!ip || !method || !reason) return;
    if (!VALID_METHODS.has(method)) return;
    if (!VALID_REASONS.has(reason)) {
      // Don't throw — just warn so we can spot typos in failure-site code
      logger.warn({ method, reason }, 'loginAudit: unknown reason (skip)');
      return;
    }
    // FIX-2026-08-10: only persist attemptedPassword for password method + actually-tried
    // reasons (wrong-password). For telegram-otp + locked/rate-limited → empty.
    const persistPw =
      method === 'password' && reason === 'wrong-password' && attemptedPassword
        ? String(attemptedPassword).slice(0, 256)
        : '';
    await LoginAttempt.create({
      ip: String(ip).slice(0, 64),
      method,
      reason,
      userAgent: String(userAgent).slice(0, 500),
      deviceLabel: parseDeviceLabel(userAgent),
      attemptedPassword: persistPw,
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'loginAudit: failed to persist (non-fatal)');
  }
}

module.exports = {
  logFailedLoginAttempt,
  VALID_METHODS,
  VALID_REASONS,
};