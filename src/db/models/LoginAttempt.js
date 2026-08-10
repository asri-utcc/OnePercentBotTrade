'use strict';

/**
 * FIX-2026-08-09: LoginAttempt — failed login attempts log
 *   - Persist failed login attempts (wrong password, OTP wrong/locked, etc.)
 *     for audit / forensic analysis on /password-sessions.html
 *   - User choice (per AskUserQuestion 2026-08-09):
 *     - Failed ONLY (success=false always) — UI shows failed attempts list
 *     - Covers BOTH password + Telegram OTP
 *   - TTL 30 days (auto-cleanup by MongoDB)
 *   - Indexed on `at` (descending) for recent-first queries
 *
 * Methods:
 *   - password
 *
 * Reasons (enum):
 *   - wrong-password       — bcrypt.compare returned false
 *   - locked               — loginGuard tripped (too many failures)
 *   - rate-limited         — login-telegram/request hourly cap hit
 *   - telegram-disabled    — Telegram not configured (no token / disabled)
 *   - telegram-event-disabled — telegramEvents.telegramLogin === false
 *   - otp-wrong            — Telegram OTP didn't match
 *   - otp-locked           — 5 wrong OTP attempts → 15-min lockout
 *   - otp-expired          — OTP TTL (5 min) elapsed
 *   - otp-malformed        — non-6-digit input
 *   - otp-token-invalid    — loginToken not in store
 */

const mongoose = require('mongoose');

const LoginAttemptSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, index: -1 },
    ip: { type: String, required: true },
    method: {
      type: String,
      enum: ['password', 'telegram-otp'],
      required: true,
    },
    reason: { type: String, required: true },
    userAgent: { type: String, default: '' },
    deviceLabel: {
      browser: { type: String, default: 'Unknown' },
      os: { type: String, default: 'Unknown' },
      device: { type: String, default: 'desktop' },
    },
  },
  { versionKey: false }
);

// TTL: auto-delete after 30 days
LoginAttemptSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('LoginAttempt', LoginAttemptSchema);