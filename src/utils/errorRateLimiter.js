'use strict';

/**
 * Sliding-window rate limiter for noisy errors.
 *
 * Purpose: when something floods the error log (e.g. ECONNREFUSED during
 * a MongoDB outage), we don't want one log line per failed request — that
 * would fill gigabytes of log disk in minutes.
 *
 * Strategy:
 *  - keep a per-key list of recent event timestamps
 *  - `shouldLog(key)` returns true for the first N events in any window,
 *    then false until the window slides past the oldest event
 *
 * Periodic cleanup (every 5 min) drops keys with empty windows to prevent
 * unbounded Map growth.
 */
class ErrorRateLimiter {
  constructor({ windowMs = 60000, maxPerWindow = 5, cleanupIntervalMs = 5 * 60 * 1000 } = {}) {
    this.windowMs = windowMs;
    this.maxPerWindow = maxPerWindow;
    this.events = new Map();
    this.cleanupTimer = setInterval(() => this._cleanup(), cleanupIntervalMs);
    // Don't keep the event loop alive just for cleanup
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /**
   * Record an event and return whether it should be logged.
   * @param {string} key - error category (e.g. 'ECONNREFUSED')
   * @returns {boolean} true if within rate limit, false if suppressed
   */
  shouldLog(key) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const arr = this.events.get(key) || [];
    const recent = arr.filter((t) => t >= cutoff);
    recent.push(now);
    this.events.set(key, recent);
    return recent.length <= this.maxPerWindow;
  }

  /**
   * How many events have been recorded for `key` in the current window.
   */
  count(key) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const arr = this.events.get(key) || [];
    return arr.filter((t) => t >= cutoff).length;
  }

  _cleanup() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, arr] of this.events.entries()) {
      const recent = arr.filter((t) => t >= cutoff);
      if (recent.length === 0) {
        this.events.delete(key);
      } else if (recent.length !== arr.length) {
        this.events.set(key, recent);
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

module.exports = { ErrorRateLimiter };