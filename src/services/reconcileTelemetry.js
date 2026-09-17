'use strict';

/**
 * reconcileTelemetry — FIX-2026-09-17
 *
 * Persists `AppConfig.orphanRecoveryLastStats` after each orphan-SELL sweep.
 * Mirrors autoUnderwaterV2.js telemetry pattern (in-memory lastStats +
 * AppConfig persistence) — keeps the 4-layer chain observable via DB query
 * or /api/health/schedulers endpoint (Phase D).
 *
 * Stats buckets:
 *   - scanned         : total orphan candidates (state='selling' + SELL alive on Binance)
 *   - cancelled       : SELL orders cancelled on Binance
 *   - forced          : forceCloseTrade ok=true (atomic claim succeeded)
 *   - errors          : cancel or forceClose failures
 *
 * NOT counted here (kept in botManager logs):
 *   - 'no-op' (still NEW, age < threshold) — too noisy to persist
 *   - 'cancelled/expired already' (FILLED/CANCELED/EXPIRED branches) — those are not orphans
 */

const AppConfig = require('../db/models/AppConfig');
const logger = require('../utils/logger');

let lastStats = null;
let lastTickAt = null;

function recordTick(stats) {
  lastStats = { ...stats, ts: Date.now() };
  lastTickAt = new Date();
  AppConfig.updateOne(
    { key: 'singleton' },
    { $set: { orphanRecoveryLastStats: lastStats, orphanRecoveryLastRunAt: lastTickAt } }
  ).catch((err) => logger.warn({ err: err.message }, 'reconcileTelemetry: persist failed'));
}

function getStatus() {
  return { lastStats, lastTickAt };
}

// Reset on module reload (PM2 reload)
function reset() {
  lastStats = null;
  lastTickAt = null;
}

module.exports = {
  recordTick,
  getStatus,
  reset,
};
