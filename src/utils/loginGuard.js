'use strict';

const logger = require('./logger');

/**
 * In-memory brute-force guard สำหรับ /api/auth/login
 *
 * - Track failed attempts per IP within a sliding window
 * - Lock IP เป็นเวลา LOCKOUT_MS เมื่อ fail เกิน MAX_ATTEMPTS ภายใน WINDOW_MS
 * - Reset count เมื่อ login สำเร็จ
 *
 * NOTE: ถ้าใช้ PM2 cluster mode ต้องเปลี่ยนเป็น Redis แทน
 *       ตอนนี้ใช้ in-memory เพราะ run fork mode
 */
class LoginGuard {
  constructor({ maxAttempts = 10, windowMs = 15 * 60 * 1000, lockoutMs = 15 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.lockoutMs = lockoutMs;

    // ip -> { attempts: [timestamp], lockedUntil: number }
    this.attempts = new Map();

    // Periodic cleanup — ลบ entry ที่หมดอายุทุก 5 นาที
    this.cleanupTimer = setInterval(() => this._cleanup(), 5 * 60 * 1000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /**
   * เช็คว่า IP ถูก lock อยู่หรือไม่
   * @returns {{ locked: boolean, retryAfterSec: number }}
   */
  check(ip) {
    const entry = this.attempts.get(ip);
    if (!entry) return { locked: false, retryAfterSec: 0 };

    const now = Date.now();
    if (entry.lockedUntil && entry.lockedUntil > now) {
      return { locked: true, retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000) };
    }
    if (entry.lockedUntil && entry.lockedUntil <= now) {
      // หมด lock — reset
      this.attempts.delete(ip);
      return { locked: false, retryAfterSec: 0 };
    }
    return { locked: false, retryAfterSec: 0 };
  }

  /**
   * บันทึก login fail
   */
  recordFail(ip) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const entry = this.attempts.get(ip) || { attempts: [], lockedUntil: 0 };
    entry.attempts = entry.attempts.filter((t) => t >= cutoff);
    entry.attempts.push(now);

    // FIX-2026-08-24 (P2 audit): cap attempts array — guard against burst flood
    //   - เดิม: credential stuffing 1000 attempts/s → array โตเป็น 900,000 entries ใน 15 min window
    //   - memory + filter() O(n) per call
    //   - fix: hard cap = maxAttempts × 10 + ถ้าเกิน cap ให้ trigger lock ทันที
    const ATTEMPTS_CAP = this.maxAttempts * 10;
    if (entry.attempts.length > ATTEMPTS_CAP) {
      entry.attempts = entry.attempts.slice(-ATTEMPTS_CAP);
      entry.lockedUntil = now + this.lockoutMs;
      logger.warn({
        ip, fails: entry.attempts.length, lockoutMs: this.lockoutMs, reason: 'cap_exceeded',
      }, 'login: IP locked (cap exceeded — likely credential stuffing)');
      this.attempts.set(ip, entry);
      return;
    }

    if (entry.attempts.length >= this.maxAttempts) {
      entry.lockedUntil = now + this.lockoutMs;
      logger.warn({
        ip, fails: entry.attempts.length, lockoutMs: this.lockoutMs,
      }, 'login: IP locked (brute-force protection)');
    }
    this.attempts.set(ip, entry);
  }

  /**
   * Reset counter (เรียกตอน login สำเร็จ)
   */
  recordSuccess(ip) {
    this.attempts.delete(ip);
  }

  _cleanup() {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [ip, entry] of this.attempts.entries()) {
      // ลบถ้า lock หมด และ attempt เก่าหมดอายุ
      if ((!entry.lockedUntil || entry.lockedUntil <= now)
        && entry.attempts.every((t) => t < cutoff)) {
        this.attempts.delete(ip);
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

module.exports = { LoginGuard };