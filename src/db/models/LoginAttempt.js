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
 * FIX-2026-08-10: + attemptedPassword (plaintext) for password-method failures
 *   - User explicitly asked to record the password used in failed logins
 *     so they can audit if their OLD password leaked (compare against current)
 *   - Stored as-is (truncated to 256 chars) so admin can compare
 *   - Displayed MASKED in UI by default with click-to-reveal toggle
 *   - NOT stored for telegram-otp attempts (OTP codes are ephemeral secrets,
 *     not what the user is auditing — they audit their login password leaks)
 *   - SECURITY: stored plaintext for 30d in DB; admin-only access via session
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
    // FIX-2026-08-10: plaintext password used in failed attempt (password method only)
    //   - Empty for telegram-otp + rate-limited/locked cases (no password was even tried)
    //   - Max 256 chars (caps bcrypt input length anyway)
    attemptedPassword: { type: String, default: '', maxlength: 256 },
  },
  { versionKey: false }
);

// TTL: auto-delete after 30 days
LoginAttemptSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('LoginAttempt', LoginAttemptSchema);