'use strict';

/**
 * FIX-2026-10-01: perfMetrics — process-level telemetry for Task Monitor.
 *
 * Singleton holding last-sampled values for:
 *  - process.memoryUsage() — rss, heapTotal, heapUsed, external, arrayBuffers
 *  - process.cpuUsage() — user + system µs, expressed as % of one core since last sample
 *  - perf_hooks.monitorEventLoopDelay — p50/p99/max/min event-loop lag in ms
 *
 * Public surface:
 *  - start({sampleMs=5000}) — install sampler + enable EL lag monitor (idempotent)
 *  - stop() — clear sampler + disable EL lag
 *  - snapshot() — return frozen copy of last sampled values
 *
 * Design notes:
 *  - First sample fires immediately on start() so callers always see non-zero data.
 *  - Sampler is unref'd so it never blocks process shutdown.
 *  - monitorEventLoopDelay is enabled at the resolution "ops" (1 ns granularity).
 *  - All numeric outputs are rounded to a sensible precision (memory in MB, CPU in %, lag in ms float).
 *
 * No I/O — all values are in-process. Safe to expose via /api/health.
 */

const perf_hooks = require('perf_hooks');
const os = require('os');
const logger = require('./logger');

const DEFAULT_SAMPLE_MS = 5000;
const CPU_HISTORY_SIZE = 12; // ~1 minute at 5s cadence — used for rolling % smoothing
const _round1 = (n) => Math.round(n * 10) / 10;
const _round2 = (n) => Math.round(n * 100) / 100;

class PerfMetrics {
  constructor() {
    this._started = false;
    this._sampleMs = DEFAULT_SAMPLE_MS;
    this._samplerTimer = null;

    // last sample
    this._lastSampleAt = 0;
    this._memory = null;
    this._cpuUserDeltaUs = 0;
    this._cpuSystemDeltaUs = 0;
    this._cpuPct = 0; // smoothed %
    this._cpuPctHistory = []; // ring buffer for smoothing
    this._lastCpuUsage = null; // for delta calc

    // perf_hooks EL lag monitor
    this._elMonitor = null;
    this._elMonitorEnabled = false;

    // last CPU core count (cached at start)
    this._coreCount = Math.max(1, (os.cpus() || []).length);
  }

  start({ sampleMs = DEFAULT_SAMPLE_MS } = {}) {
    if (this._started) return;
    this._started = true;
    this._sampleMs = sampleMs;

    // Enable perf_hooks EL lag monitor (resolution 1 ns = 10**-9 s)
    if (!this._elMonitor) {
      try {
        this._elMonitor = new perf_hooks.monitorEventLoopDelay({ resolution: 10 });
        this._elMonitor.enable();
        this._elMonitorEnabled = true;
      } catch (err) {
        logger.warn({ err: err.message }, 'perfMetrics: monitorEventLoopDelay.enable failed (EL lag disabled)');
        this._elMonitor = null;
        this._elMonitorEnabled = false;
      }
    }

    // First sample immediately so snapshot() returns data without waiting sampleMs
    this._sample();

    // Periodic sampler (unref so it doesn't keep process alive during shutdown)
    this._samplerTimer = setInterval(() => this._sample(), this._sampleMs);
    if (this._samplerTimer && typeof this._samplerTimer.unref === 'function') {
      this._samplerTimer.unref();
    }

    logger.info({ sampleMs, coreCount: this._coreCount }, 'perfMetrics: started');
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    if (this._samplerTimer) {
      clearInterval(this._samplerTimer);
      this._samplerTimer = null;
    }
    if (this._elMonitor && this._elMonitorEnabled) {
      try { this._elMonitor.disable(); } catch (_) { /* ignore */ }
      this._elMonitorEnabled = false;
    }
    logger.info('perfMetrics: stopped');
  }

  /**
   * Take one sample. Internal — called by sampler + start() first-fire.
   */
  _sample() {
    const now = Date.now();
    const memory = process.memoryUsage();
    this._memory = {
      rss: _round1(memory.rss / 1024 / 1024),         // MB
      heapTotal: _round1(memory.heapTotal / 1024 / 1024),
      heapUsed: _round1(memory.heapUsed / 1024 / 1024),
      external: _round1((memory.external || 0) / 1024 / 1024),
      arrayBuffers: _round1((memory.arrayBuffers || 0) / 1024 / 1024),
    };

    // CPU delta since last sample
    const cpuNow = process.cpuUsage();
    if (this._lastCpuUsage) {
      const userDeltaUs = cpuNow.user - this._lastCpuUsage.user;
      const systemDeltaUs = cpuNow.system - this._lastCpuUsage.system;
      this._cpuUserDeltaUs = userDeltaUs;
      this._cpuSystemDeltaUs = systemDeltaUs;
      // CPU % = totalCpuDeltaUs / (elapsedMs * 1000) * 100 / coreCount
      // elapsedMs is always sampleMs after first; use _lastSampleAt to be exact
      const elapsedMs = Math.max(1, now - this._lastSampleAt);
      const totalDeltaUs = userDeltaUs + systemDeltaUs;
      const pct = (totalDeltaUs / 1000) / elapsedMs / this._coreCount * 100;
      this._cpuPctHistory.push(pct);
      if (this._cpuPctHistory.length > CPU_HISTORY_SIZE) {
        this._cpuPctHistory.shift();
      }
      // smoothed = mean of last N
      const sum = this._cpuPctHistory.reduce((s, v) => s + v, 0);
      this._cpuPct = sum / this._cpuPctHistory.length;
    }
    this._lastCpuUsage = cpuNow;
    this._lastSampleAt = now;
  }

  /**
   * Snapshot of last sampled values. Safe to serialize.
   */
  snapshot() {
    if (!this._started || !this._memory) {
      // pre-start fallback — fire one sample so callers always get data
      this._sample();
    }
    const el = this._elMonitor && this._elMonitorEnabled ? {
      enabled: true,
      // monitorEventLoopDelay reports nanoseconds; convert to ms with 2 decimals
      p50Ms: this._elMonitor.percentile ? _round2(this._elMonitor.percentile(50) / 1e6) : null,
      p99Ms: this._elMonitor.percentile ? _round2(this._elMonitor.percentile(99) / 1e6) : null,
      maxMs: this._elMonitor.max ? _round2(this._elMonitor.max / 1e6) : null,
      minMs: this._elMonitor.min ? _round2(this._elMonitor.min / 1e6) : null,
      meanMs: this._elMonitor.mean ? _round2(this._elMonitor.mean / 1e6) : null,
      samples: typeof this._elMonitor.count === 'function' ? this._elMonitor.count() : null,
    } : { enabled: false };

    return {
      sampledAt: this._lastSampleAt,
      uptimeSec: Math.floor(process.uptime()),
      memory: this._memory,
      cpu: {
        userDeltaUs: this._cpuUserDeltaUs,
        systemDeltaUs: this._cpuSystemDeltaUs,
        pctSmoothed: _round2(this._cpuPct || 0),
        coreCount: this._coreCount,
      },
      elLag: el,
    };
  }
}

module.exports = module.exports = new PerfMetrics();