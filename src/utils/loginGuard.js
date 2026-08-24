'use strict';

const logger = require('./logger');

/**
 * FIX-2026-08-24: Brute-force protection สำหรับ /api/auth/login
 *
 * Layered defense:
 *   1. **Progressive backoff** — fail 1-3 = no delay; 4-6 = 5s; 7-9 = 30s (response carries `nextDelayMs`)
 *   2. **Hard lockout** at maxAttempts (default 10) — 15 min base, escalates on repeat offenses
 *   3. **Lockout escalation** — repeat lockout ภายใน 1 ชม. จะ lock นานขึ้น: level 1 = 15m, level 2 = 30m, level 3+ = 60m (cap)
 *   4. **Per-account lockout** — track ตาม passwordHash (bcrypt hash) → distributed brute-force (หลาย IP) ก็โดน
 *   5. **Burst cap** — credential stuffing flood จะ trigger lock ทันทีเมื่อเกิน maxAttempts × 10
 *
 * NOTE: ถ้าใช้ PM2 cluster mode ต้องเปลี่ยนเป็น Redis แทน
 *       ตอนนี้ใช้ in-memory เพราะ run fork mode
 */

// FIX-2026-08-24 (P2 audit): cap attempts array — guard against burst flood
//   - เดิม: credential stuffing 1000 attempts/s → array โตเป็น 900,000 entries ใน 15 min window
//   - memory + filter() O(n) per call
//   - fix: hard cap = maxAttempts × 10 + ถ้าเกิน cap ให้ trigger lock ทันที
const ATTEMPTS_CAP_MULTIPLIER = 10;

// FIX-2026-08-24: progressive backoff tiers — ลด bcrypt load + ทำให้ user เห็น feedback
//   tier 0: 0..3 fails → 0ms (no artificial delay)
//   tier 1: 4..6 fails → 5s   ("Too many attempts. Wait 5s.")
//   tier 2: 7..9 fails → 30s  ("Too many attempts. Wait 30s.")
//   tier 3: 10+ fails → locked (handled by check(), not here)
const PROGRESSIVE_TIER_THRESHOLDS = [4, 7, 10];
const PROGRESSIVE_TIER_DELAYS_MS = [5000, 30000, 0]; // last entry unused (locked path)

function progressiveDelayMs(failCount) {
  if (failCount >= PROGRESSIVE_TIER_THRESHOLDS[2]) return -1; // signal "locked"
  if (failCount >= PROGRESSIVE_TIER_THRESHOLDS[1]) return PROGRESSIVE_TIER_DELAYS_MS[1];
  if (failCount >= PROGRESSIVE_TIER_THRESHOLDS[0]) return PROGRESSIVE_TIER_DELAYS_MS[0];
  return 0;
}

// FIX-2026-08-24: lockout escalation tiers — repeat offender ภายใน 1 ชม. → lock นานขึ้น
//   level 1 = 15 min (base)
//   level 2 = 30 min (escalated)
//   level 3+ = 60 min (cap)
//   reset level เมื่อ lockout ครั้งล่าสุดเกิน LOCKOUT_LEVEL_WINDOW_MS มาแล้ว (1h)
const LOCKOUT_TIERS_MS = [
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
];
const LOCKOUT_LEVEL_WINDOW_MS = 60 * 60 * 1000;

// FIX-2026-08-24: per-account lockout — defense against distributed brute-force
//   - threshold ต่ำกว่า per-IP (5 vs 10) เพราะ distributed signal = suspicious
//   - key = bcrypt hash (stable until password change → reset on change-password)
const ACCOUNT_MAX_ATTEMPTS = 5;

class LoginGuard {
  constructor({ maxAttempts = 10, windowMs = 15 * 60 * 1000, lockoutMs = 15 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.lockoutMs = lockoutMs; // base lockout (level 1 fallback)

    // ip -> { attempts: [ts], lockedUntil, lockoutLevel, lastLockoutAt }
    this.ipEntries = new Map();

    // FIX-2026-08-24: passwordHash -> { attempts: [ts], lockedUntil }
    //   ใช้ bcrypt hash เป็น key (stable per-password, reset เมื่อ user เปลี่ยน password)
    this.accountEntries = new Map();

    // Periodic cleanup — ลบ entry ที่หมดอายุทุก 5 นาที
    this.cleanupTimer = setInterval(() => this._cleanup(), 5 * 60 * 1000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /**
   * เช็คว่า IP ถูก lock อยู่หรือไม่
   * @returns {{ locked: boolean, retryAfterSec: number, lockoutLevel?: number }}
   */
  check(ip) {
    const entry = this.ipEntries.get(ip);
    if (!entry) return { locked: false, retryAfterSec: 0, lockoutLevel: 0 };

    const now = Date.now();
    if (entry.lockedUntil && entry.lockedUntil > now) {
      return {
        locked: true,
        retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000),
        lockoutLevel: entry.lockoutLevel || 1,
      };
    }
    if (entry.lockedUntil && entry.lockedUntil <= now) {
      // หมด lock — clear entry (level จะ reset ตอน lock ครั้งถัดไปถ้าเกิน 1h)
      this.ipEntries.delete(ip);
      return { locked: false, retryAfterSec: 0, lockoutLevel: 0 };
    }
    return { locked: false, retryAfterSec: 0, lockoutLevel: entry.lockoutLevel || 0 };
  }

  /**
   * FIX-2026-08-24: rich status (extends check() with attemptsRemaining + nextDelayMs for UI)
   * @returns {{
   *   locked: boolean,
   *   retryAfterSec: number,
   *   lockoutLevel: number,
   *   attemptsRemaining: number,
   *   nextDelayMs: number,
   *   maxAttempts: number
   * }}
   */
  getStatus(ip) {
    const checkResult = this.check(ip);
    const entry = this.ipEntries.get(ip);
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const failCount = entry ? entry.attempts.filter((t) => t >= cutoff).length : 0;
    const attemptsRemaining = Math.max(0, this.maxAttempts - failCount);
    let nextDelayMs = 0;
    if (!checkResult.locked) {
      const delay = progressiveDelayMs(failCount);
      nextDelayMs = delay > 0 ? delay : 0;
    }
    return {
      ...checkResult,
      attemptsRemaining,
      nextDelayMs,
      maxAttempts: this.maxAttempts,
    };
  }

  /**
   * บันทึก login fail (อัปเดต IP + account counters)
   * @param {string} ip
   * @param {string} [passwordHash] — bcrypt hash (สำหรับ per-account lockout)
   */
  recordFail(ip, passwordHash) {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    // FIX-2026-08-24: if entry ถูก lock อยู่แล้ว → absorb fail แต่ไม่ trigger lock ใหม่
    //   - ป้องกัน rapid re-escalation: attacker ยิง 1000 req/s ขณะ lock → recordFail 1000 ครั้ง
    //     จะ escalate level ขึ้นเรื่อยๆ จนถึง cap ทันที (1 ms)
    //   - หลัง lockout หมด → attempts ถูก reset (entry ถูก delete ใน check()) → fail ครั้งถัดไปนับใหม่
    const existing = this.ipEntries.get(ip);
    if (existing && existing.lockedUntil && existing.lockedUntil > now) {
      return;
    }

    const entry = existing || {
      attempts: [], lockedUntil: 0, lockoutLevel: 0, lastLockoutAt: 0,
    };
    entry.attempts = entry.attempts.filter((t) => t >= cutoff);
    entry.attempts.push(now);

    // FIX-2026-08-24 (P2 audit): cap attempts array — guard against burst flood
    //   - เดิม: credential stuffing 1000 attempts/s → array โตเป็น 900,000 entries ใน 15 min window
    //   - memory + filter() O(n) per call
    //   - fix: hard cap = maxAttempts * 10 + ถ้าเกิน cap ให้ trigger lock ทันที
    const ATTEMPTS_CAP = this.maxAttempts * ATTEMPTS_CAP_MULTIPLIER;
    if (entry.attempts.length > ATTEMPTS_CAP) {
      entry.attempts = entry.attempts.slice(-ATTEMPTS_CAP);
      this._triggerIpLockout(ip, entry, now, 'cap_exceeded');
      // Still record account fail even if IP lock fires (in case attacker rotates IP)
      if (passwordHash) this.recordFailAccount(passwordHash, now);
      return;
    }

    if (entry.attempts.length >= this.maxAttempts) {
      this._triggerIpLockout(ip, entry, now, 'brute_force');
      if (passwordHash) this.recordFailAccount(passwordHash, now);
      return;
    }
    this.ipEntries.set(ip, entry);

    // Per-account tracking if hash provided
    if (passwordHash) this.recordFailAccount(passwordHash, now);
  }

  /**
   * FIX-2026-08-24: บันทึก per-account fail (เรียกจาก recordFail เมื่อมี passwordHash)
   *   - threshold ต่ำกว่า IP (5 vs 10) — distributed brute-force signal
   *   - key = bcrypt hash (resets เมื่อ user เปลี่ยน password)
   */
  recordFailAccount(passwordHash, now = Date.now()) {
    if (!passwordHash) return;
    const cutoff = now - this.windowMs;
    const entry = this.accountEntries.get(passwordHash) || { attempts: [], lockedUntil: 0 };
    entry.attempts = entry.attempts.filter((t) => t >= cutoff);
    entry.attempts.push(now);

    const ATTEMPTS_CAP = this.maxAttempts * ATTEMPTS_CAP_MULTIPLIER;
    if (entry.attempts.length > ATTEMPTS_CAP) {
      entry.attempts = entry.attempts.slice(-ATTEMPTS_CAP);
      entry.lockedUntil = now + this.lockoutMs;
      logger.warn({
        hashPrefix: String(passwordHash).slice(0, 8) + '...',
        fails: entry.attempts.length,
        reason: 'cap_exceeded',
      }, 'login: account locked (cap exceeded)');
    } else if (entry.attempts.length >= ACCOUNT_MAX_ATTEMPTS) {
      entry.lockedUntil = now + this.lockoutMs;
      logger.warn({
        hashPrefix: String(passwordHash).slice(0, 8) + '...',
        fails: entry.attempts.length,
        lockoutMs: this.lockoutMs,
      }, 'login: account locked (brute-force protection)');
    }
    this.accountEntries.set(passwordHash, entry);
  }

  /**
   * FIX-2026-08-24: per-account lock check (called before bcrypt compare)
   * @returns {{ locked: boolean, retryAfterSec: number }}
   */
  checkAccount(passwordHash) {
    if (!passwordHash) return { locked: false, retryAfterSec: 0 };
    const entry = this.accountEntries.get(passwordHash);
    if (!entry) return { locked: false, retryAfterSec: 0 };
    const now = Date.now();
    if (entry.lockedUntil && entry.lockedUntil > now) {
      return { locked: true, retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000) };
    }
    if (entry.lockedUntil && entry.lockedUntil <= now) {
      this.accountEntries.delete(passwordHash);
      return { locked: false, retryAfterSec: 0 };
    }
    return { locked: false, retryAfterSec: 0 };
  }

  /**
   * Reset counter (เรียกตอน login สำเร็จ — reset ทั้ง IP และ account)
   */
  recordSuccess(ip, passwordHash) {
    this.ipEntries.delete(ip);
    if (passwordHash) this.accountEntries.delete(passwordHash);
  }

  /**
   * FIX-2026-08-24: internal — trigger IP lockout + escalation logic
   */
  _triggerIpLockout(ip, entry, now, reason) {
    // Escalate lockout level if previous lockout was within LOCKOUT_LEVEL_WINDOW_MS
    if (entry.lastLockoutAt && (now - entry.lastLockoutAt) < LOCKOUT_LEVEL_WINDOW_MS) {
      entry.lockoutLevel = Math.min(entry.lockoutLevel + 1, LOCKOUT_TIERS_MS.length);
    } else {
      entry.lockoutLevel = 1;
    }
    const tier = LOCKOUT_TIERS_MS[entry.lockoutLevel - 1] || this.lockoutMs;
    entry.lockedUntil = now + tier;
    entry.lastLockoutAt = now;

    logger.warn({
      ip,
      fails: entry.attempts.length,
      lockoutMs: tier,
      lockoutLevel: entry.lockoutLevel,
      reason,
    }, `login: IP locked (${reason}) — level ${entry.lockoutLevel}`);

    this.ipEntries.set(ip, entry);
  }

  _cleanup() {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [ip, entry] of this.ipEntries.entries()) {
      // ลบถ้า lock หมด และ attempt เก่าหมดอายุ
      if ((!entry.lockedUntil || entry.lockedUntil <= now)
        && entry.attempts.every((t) => t < cutoff)) {
        this.ipEntries.delete(ip);
      }
    }
    for (const [hash, entry] of this.accountEntries.entries()) {
      if ((!entry.lockedUntil || entry.lockedUntil <= now)
        && entry.attempts.every((t) => t < cutoff)) {
        this.accountEntries.delete(hash);
      }
    }
  }

  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

module.exports = {
  LoginGuard,
  progressiveDelayMs,
  PROGRESSIVE_TIER_THRESHOLDS,
  PROGRESSIVE_TIER_DELAYS_MS,
  LOCKOUT_TIERS_MS,
  LOCKOUT_LEVEL_WINDOW_MS,
  ACCOUNT_MAX_ATTEMPTS,
};