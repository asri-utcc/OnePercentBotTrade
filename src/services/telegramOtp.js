'use strict';

/**
 * 2026-08-09: Telegram OTP — in-memory OTP service for alternative login channel
 *
 * Pattern: mirror `src/utils/loginGuard.js` (in-memory Map + sliding window + periodic cleanup)
 *
 * - loginToken = server-issued opaque handle (NOT session ID — session doesn't exist yet at OTP request time)
 * - codeHash = sha256(code + pepper) — never store plaintext code
 * - verify uses crypto.timingSafeEqual for anti-timing-attack
 *
 * Rate limits:
 *   - TTL: 5 min per OTP
 *   - Max 5 wrong verify attempts → lock 15 min
 *   - Hourly cap: 20 requests/hour (allows ~4 login attempts/hour worst case)
 *
 * Usage:
 *   const result = telegramOtp.requestOtp();
 *   if (!result.ok) return res.status(429).json(...);
 *   await telegramNotifier.sendNow('telegramLogin', { code: result.code, expiresInMin: 5 });
 *   res.cookie('tg_login_token', result.loginToken, ...);
 *
 *   const result = telegramOtp.verifyOtp(loginToken, inputCode);
 *   if (!result.ok) return res.status(400).json(...);
 *   req.session.authenticated = true;
 */

const crypto = require('crypto');
const config = require('../../config');
const logger = require('../utils/logger');

// In-memory store: loginToken -> entry
const store = new Map();

const OTP_TTL_MS = 5 * 60 * 1000;            // 5 min expiry
const MAX_ATTEMPTS = 5;                      // wrong verify → lock
const LOCKOUT_MS = 15 * 60 * 1000;           // 15 min lockout
const HOURLY_WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_HOUR = 20;            // 20/hr total — supports 4 login attempts/hr worst case

function _pepper() { return config.encryptionKey || 'no-pepper'; }

function _hash(code) {
  return crypto.createHash('sha256').update(String(code) + _pepper()).digest('hex');
}

function _now() { return Date.now(); }

function _genCode() {
  // 6-digit zero-padded (avoid leading-zero issues)
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, '0');
}

function _genLoginToken() {
  // 32-byte random hex (opaque, unguessable)
  return crypto.randomBytes(32).toString('hex');
}

// Periodic cleanup — remove expired entries
const cleanupTimer = setInterval(() => {
  const now = _now();
  for (const [token, e] of store.entries()) {
    if (e.expiresAt < now && (!e.lockedUntil || e.lockedUntil < now)) {
      store.delete(token);
    }
  }
}, 60 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();

// Sliding window of recent OTP requests (hourly cap)
let _recentRequests = [];

/**
 * Request a new OTP for login.
 * @returns { ok, code, loginToken, expiresInSec, error?, retryAfterSec? }
 */
function requestOtp() {
  const now = _now();

  // Hourly cap (sliding window)
  _recentRequests = _recentRequests.filter((t) => t > now - HOURLY_WINDOW_MS);
  if (_recentRequests.length >= MAX_REQUESTS_PER_HOUR) {
    return {
      ok: false,
      error: 'OTP request ถูกจำกัด — ลองใหม่ใน 1 ชั่วโมง',
      retryAfterSec: 3600,
    };
  }

  const loginToken = _genLoginToken();
  const code = _genCode();
  const codeHash = _hash(code);
  store.set(loginToken, {
    codeHash,
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    lockedUntil: 0,
    createdAt: now,
    lastRequestAt: now,
  });
  _recentRequests.push(now);

  return { ok: true, code, loginToken, expiresInSec: OTP_TTL_MS / 1000 };
}

/**
 * Verify an OTP and consume the login token on success.
 * @param {string} loginToken — opaque token from requestOtp
 * @param {string} inputCode — 6-digit code from user
 * @returns { ok, loginToken, error?, retryAfterSec? }
 */
function verifyOtp(loginToken, inputCode) {
  if (!loginToken || typeof loginToken !== 'string') {
    return { ok: false, error: 'OTP token ไม่�ูกต้อง — กดขอ OTP ใหม่' };
  }
  const now = _now();
  const entry = store.get(loginToken);
  if (!entry) {
    return { ok: false, error: 'OTP token ไม่ถูกต้องหรือหมดอายุ — กดขอ OTP ใหม่' };
  }
  if (entry.lockedUntil && entry.lockedUntil > now) {
    return {
      ok: false,
      error: '�ูก lock เนื่องจากใส่ผิดหลายครั้ง — รอ 15 นาที',
      retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000),
    };
  }
  if (entry.expiresAt < now) {
    store.delete(loginToken);
    return { ok: false, error: 'OTP หมดอายุ — �ดขอ OTP ใหม่' };
  }
  if (!/^\d{6}$/.test(String(inputCode || ''))) {
    return { ok: false, error: 'OTP ต้องเป็นตัวเลข 6 หลัก' };
  }
  const inputHash = _hash(String(inputCode));
  const a = Buffer.from(entry.codeHash, 'hex');
  const b = Buffer.from(inputHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    entry.attempts++;
    if (entry.attempts >= MAX_ATTEMPTS) {
      entry.lockedUntil = now + LOCKOUT_MS;
      logger.warn(
        { loginTokenPrefix: loginToken.slice(0, 8) + '...' },
        'telegram-otp: locked (too many wrong attempts)'
      );
      return {
        ok: false,
        error: 'ใส่ OTP ผิดหลายครั้ง — lock 15 นาที',
        retryAfterSec: LOCKOUT_MS / 1000,
      };
    }
    return {
      ok: false,
      error: `OTP ไม่ถูกต้อง (เหลืออีก ${MAX_ATTEMPTS - entry.attempts} �รั้ง)`,
    };
  }
  // success — consume the entry (single-use)
  store.delete(loginToken);
  return { ok: true, loginToken };
}

/**
 * Test helpers / introspection — not used in production code paths
 */
function _getStoreSize() { return store.size; }
function _clearAll() {
  store.clear();
  _recentRequests = [];
}

module.exports = {
  requestOtp,
  verifyOtp,
  OTP_TTL_MS,
  MAX_ATTEMPTS,
  LOCKOUT_MS,
  // exposed for tests only
  _getStoreSize,
  _clearAll,
};
