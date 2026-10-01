'use strict';

/**
 * FIX-2026-10-01: Task Monitor — central registry for timers, one-shot workers, and opt-in caches.
 *
 * Backed by an in-process Map. No I/O. No persistence — task snapshot is read on demand from any
 * module that wants to expose it (e.g. healthMonitor.getStatus(), WS push to admin Task Monitor).
 *
 * Public surface:
 *  - registerTask(meta)               — declare a task. Idempotent by `name`. See shape.
 *  - recordFire(name, {durationMs, error}) — called by wrappers (scheduledInterval + _instrumentedInterval)
 *  - registerCache(name, info)       — opt-in for caches that want to surface
 *  - unregisterTask(name)              — drop a task (rare; usually on stop())
 *  - getTaskSnapshot()               — full list + caches + summary (what WS pushes to admin)
 *  - getSummary()                     — counts only (cheaper, used in getStatus() KPI strip)
 *
 * Task meta shape:
 *  {
 *    name:        string — e.g. "positionWatchdog.tick"
 *    type:        "scheduled" | "manual" | "oneshot"
 *    owner:       string — e.g. "service:positionWatchdog" or "bot:<botId>"
 *    intervalMs:  number — for "scheduled"; null for "manual"
 *    source:      "scheduledInterval" | "instrumented" | "manual"
 *    nextFireAt:  number — epoch ms (best-effort, for "scheduled" only)
 *    fireCount:   number — total fires observed (incremented by recordFire)
 *    lastFireAt:  number — epoch ms of last fire
 *    lastDurationMs: number — duration of last fire
 *    lastError:   string | null — message of last error
 *    lastErrorAt: number — epoch ms of last error
 *    registeredAt: number — epoch ms when registered
 *  }
 */

const logger = require('./logger');

class TaskRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this._tasks = new Map();
    /** @type {Map<string, object>} */
    this._caches = new Map();
    // FIX-2026-10-02: weight attribution — buckets for rolling 1min and all-time
    //   { taskName: { minuteStart: epochMs, minuteCount: number, totalCount: number } }
    /** @type {Map<string, {minAt: number, minCount: number, totalCount: number}>} */
    this._weightBuckets = new Map();
  }

  /**
   * Register or update a task. Idempotent on `name`.
   * Existing record keeps its fireCount/lastFireAt/lastError unless explicitly overwritten.
   */
  registerTask(meta) {
    if (!meta || !meta.name) {
      logger.warn({ meta }, 'taskRegistry.registerTask: missing name — ignored');
      return null;
    }
    const now = Date.now();
    const prev = this._tasks.get(meta.name) || {};
    const merged = {
      name: meta.name,
      type: meta.type || prev.type || 'manual',
      owner: meta.owner || prev.owner || 'unknown',
      intervalMs: meta.intervalMs != null ? meta.intervalMs : prev.intervalMs || null,
      source: meta.source || prev.source || 'manual',
      nextFireAt: meta.nextFireAt != null ? meta.nextFireAt : prev.nextFireAt || null,
      fireCount: prev.fireCount || 0,
      lastFireAt: prev.lastFireAt || 0,
      lastDurationMs: prev.lastDurationMs || 0,
      lastError: prev.lastError || null,
      lastErrorAt: prev.lastErrorAt || 0,
      registeredAt: prev.registeredAt || now,
      updatedAt: now,
    };
    this._tasks.set(meta.name, merged);
    return merged;
  }

  /**
   * Record a fire event. Updates fireCount, lastFireAt, lastDurationMs, lastError/At.
   */
  recordFire(name, { durationMs, error } = {}) {
    const t = this._tasks.get(name);
    if (!t) {
      // Auto-register as "oneshot" so we don't lose data; logger debug-level
      this.registerTask({ name, type: 'oneshot', owner: 'unregistered', source: 'manual' });
    }
    const task = this._tasks.get(name);
    task.fireCount += 1;
    task.lastFireAt = Date.now();
    if (typeof durationMs === 'number') task.lastDurationMs = Math.round(durationMs * 100) / 100;
    if (error) {
      task.lastError = error.message || String(error);
      task.lastErrorAt = Date.now();
    }
    if (task.intervalMs) {
      task.nextFireAt = Date.now() + task.intervalMs;
    }
    return task;
  }

  /**
   * Opt-in cache surface. Caches that want to show on Task Monitor call this with
   * a getter returning current stats. We snapshot the values at registration time;
   * for live values, callers can call registerCache() on every tick (cheap).
   */
  registerCache(name, info) {
    if (!name) return null;
    const merged = {
      name,
      size: info && typeof info.size === 'number' ? info.size : null,
      ageMs: info && typeof info.ageMs === 'number' ? info.ageMs : null,
      hitRate: info && typeof info.hitRate === 'number' ? info.hitRate : null,
      hitCount: info && typeof info.hitCount === 'number' ? info.hitCount : null,
      missCount: info && typeof info.missCount === 'number' ? info.missCount : null,
      updatedAt: Date.now(),
    };
    this._caches.set(name, merged);
    return merged;
  }

  unregisterTask(name) {
    return this._tasks.delete(name);
  }

  unregisterCache(name) {
    return this._caches.delete(name);
  }

  /**
   * FIX-2026-10-02: attribute weight consumption to a task.
   * Called from binanceRest publicGet/publicPost/signedRequest on response.
   *
   *   - weightDelta: integer (typically 1-80). Can be 0 if Binance didn't respond
   *     or weight header missing.
   *   - endpointLabel: optional short name (e.g. 'getAccount', 'getKlines') so we can
   *     break down WHICH API endpoint within a timer is the culprit — lets the user
   *     drill from "task X uses 200 weight/min" → "because it calls getAccount 40×".
   *     Default 'unknown' if caller doesn't supply.
   *   - Auto-buckets into rolling 1-minute window (per task) so UI can show "weight/min"
   *   - All-time total kept per task for sort-by-total
   *
   * Safe to call from anywhere — never throws. If `taskName` is unknown, it gets
   * lazily registered under owner='untracked' so attribution is preserved.
   */
  attributeWeight(taskName, weightDelta, endpointLabel = 'unknown') {
    if (!taskName || !weightDelta) return;
    if (!this._tasks.has(taskName)) {
      this.registerTask({ name: taskName, type: 'manual', owner: 'untracked', source: 'manual' });
    }
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    let b = this._weightBuckets.get(taskName);
    if (!b) {
      b = {
        minAt: minute, minCount: 0, totalCount: 0,
        // per-endpoint breakdown
        perEndpoint: {},   // { endpointLabel: { minAt, minCount, totalCount } }
      };
      this._weightBuckets.set(taskName, b);
    }
    if (b.minAt !== minute) {
      // New minute — keep last bucket for "previous minute" comparison in UI
      b.prevMinCount = b.minCount;
      b.minAt = minute;
      b.minCount = 0;
    }
    b.minCount += weightDelta;
    b.totalCount += weightDelta;
    if (!b.perEndpoint[endpointLabel]) {
      b.perEndpoint[endpointLabel] = { minAt: minute, minCount: 0, totalCount: 0, prevMinCount: 0 };
    }
    const ep = b.perEndpoint[endpointLabel];
    if (ep.minAt !== minute) {
      ep.prevMinCount = ep.minCount;
      ep.minAt = minute;
      ep.minCount = 0;
    }
    ep.minCount += weightDelta;
    ep.totalCount += weightDelta;
    // Update task metadata for snapshot
    const t = this._tasks.get(taskName);
    if (t) {
      t.weightLastMinute = b.minCount;
      t.weightPrevMinute = b.prevMinCount || 0;
      t.weightTotal = b.totalCount;
      t.weightAttributedAt = now;
    }
  }

  /**
   * Returns tasks sorted by weight/min DESC + total. Includes 'untracked'
   * synthetic row for calls outside any tracked context.
   * Each row also includes `endpoints[]` breakdown so the user can drill from
   * "task X uses 200 weight/min" → "because getAccount 80 + getKlines 60 + ..."
   */
  getWeightAttribution() {
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    const rows = [];
    for (const [taskName, b] of this._weightBuckets.entries()) {
      const t = this._tasks.get(taskName);
      const isCurrentMin = b.minAt === minute;
      const endpoints = Object.entries(b.perEndpoint || {}).map(([label, ep]) => ({
        endpoint: label,
        weightPerMin: ep.minAt === minute ? ep.minCount : 0,
        weightPrevMin: ep.prevMinCount || 0,
        weightTotal: ep.totalCount,
      })).sort((a, b) => b.weightPerMin - a.weightPerMin || b.weightTotal - a.weightTotal);
      rows.push({
        taskName,
        owner: t ? (t.owner || 'untracked') : 'untracked',
        type: t ? (t.type || 'manual') : 'manual',
        weightPerMin: isCurrentMin ? b.minCount : 0,
        weightPrevMin: b.prevMinCount || 0,
        weightTotal: b.totalCount,
        lastFireAt: t ? (t.lastFireAt || 0) : 0,
        endpoints,
        tracked: !!t,
      });
    }
    rows.sort((a, b) => (b.weightPerMin - a.weightPerMin) || (b.weightTotal - a.weightTotal));
    return { sampledAt: now, minute, tasks: rows };
  }

  /**
   * Full snapshot — used by WS push payload to admin.
   */
  getTaskSnapshot() {
    const tasks = Array.from(this._tasks.values()).sort((a, b) => {
      // Sort: errors first, then by lastFireAt desc
      if (a.lastError && !b.lastError) return -1;
      if (!a.lastError && b.lastError) return 1;
      return (b.lastFireAt || 0) - (a.lastFireAt || 0);
    });
    const caches = Array.from(this._caches.values());
    const summary = this.getSummary();
    return {
      tasks,
      caches,
      summary,
      sampledAt: Date.now(),
    };
  }

  /**
   * Counts only — cheap, used by healthMonitor.getStatus() in every /health response.
   */
  getSummary() {
    let scheduled = 0, manual = 0, oneshot = 0, errorsLastHour = 0;
    const owners = new Set();
    const hourAgo = Date.now() - 3600 * 1000;
    for (const t of this._tasks.values()) {
      if (t.type === 'scheduled') scheduled++;
      else if (t.type === 'manual') manual++;
      else if (t.type === 'oneshot') oneshot++;
      if (t.lastErrorAt && t.lastErrorAt >= hourAgo) errorsLastHour++;
      if (t.owner) owners.add(t.owner);
    }
    return {
      totalTasks: this._tasks.size,
      scheduled,
      manual,
      oneshot,
      errorsLastHour,
      uniqueOwners: owners.size,
      cacheCount: this._caches.size,
      sampledAt: Date.now(),
    };
  }

  // Test/diagnostic helpers
  _clear() {
    this._tasks.clear();
    this._caches.clear();
  }
  size() { return this._tasks.size; }
}

module.exports = new TaskRegistry();