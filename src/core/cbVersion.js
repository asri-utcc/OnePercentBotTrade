'use strict';

/**
 * FIX-2026-08-08: Feature #2 — CB Version routing (v2 vs v3)
 *   - cbVersion is a global AppConfig setting (default 'v3')
 *   - 'v2' = CBv2 only (4 red candles below lowerKC → cooldown)
 *   - 'v3' = CBv2 + ST3 same-candle on upper-TF (default)
 *   - Per-bot cbv3LockedUntil / cbv3LockReason / cbv3LastFiredAt mirror CBv2 schema
 *   - Per-bot cbv3 enabled is implied by AppConfig.cbVersion === 'v3' (no per-bot toggle)
 *     — keeping logic single-source-of-truth
 *   - effective version cached per tick (avoid Mongo roundtrip per candle)
 */

const AppConfig = require('../db/models/AppConfig');
const logger = require('../utils/logger');

const CACHE_MS = 30 * 1000; // 30s — AppConfig.cbVersion doesn't change often
let _cached = { version: 'v3', at: 0 };

async function getActiveVersion() {
  const now = Date.now();
  if ((now - _cached.at) < CACHE_MS) return _cached.version;
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    const v = (cfg && (cfg.cbVersion === 'v2' || cfg.cbVersion === 'v3')) ? cfg.cbVersion : 'v3';
    _cached = { version: v, at: now };
    return v;
  } catch (err) {
    logger.warn({ err: err.message }, 'cbVersion: AppConfig read failed, fallback to v3');
    return 'v3';
  }
}

function invalidateCache() {
  _cached = { version: 'v3', at: 0 };
}

module.exports = {
  getActiveVersion,
  invalidateCache,
};
