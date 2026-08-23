'use strict';

/**
 * FIX-2026-08-08: Feature #2 — CB Version routing (v2 vs v3)
 *   - cbVersion is a global AppConfig setting (default 'v3') — selects WHICH
 *     panic-sell handler fires (mutually exclusive):
 *       'v2' → CBv2 handler fires (4 red candles below lowerKC → cooldown)
 *       'v3' → CBv3 handler fires (CBv2 pattern + ST3 upper-TF same-candle)
 *   - Per-bot opt-out (independent of cbVersion):
 *       bot.cbv2Enabled === false → CBv2 handler skips this bot
 *       bot.cbv3Enabled === false → CBv3 handler skips this bot
 *     Default both = true. User can disable CBv3 per-bot even when cbVersion='v3'.
 *   - FIX-2026-08-09: cbv3Enabled field added to Bot.js schema (was missing —
 *     Mongoose strict mode silently dropped saves; per-bot opt-out UI broken).
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
