'use strict';

/**
 * FIX-2026-08-21: Trade Analysis API — single endpoint /api/analysis/trade-analysis
 *
 * Returns a comprehensive multi-section aggregation over the entire Trade collection
 * (including trades from soft-deleted bots) for the Trade Analysis page.
 *
 * Query params:
 *   - since=<ISO date>     (optional) — limit to trades sellFilledAt >= since
 *
 * Sections returned (see src/core/tradeAnalysis.js for full schema):
 *   summary, bySymbol, byTimeframe, bySellReason, byHour, byDayOfWeek, byDay,
 *   byMonth, byBot, duration, sizing, streaks, dcaVsNonDca, extremes, derived,
 *   holdVsProfit, tpSlDeep, optimal, conclusion, meta
 *
 * The endpoint is cached server-side for 60s to keep dashboard snappy and avoid
 * hammering MongoDB when multiple users open the page simultaneously.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { aggregateTradeAnalysis } = require('../../core/tradeAnalysis');
const logger = require('../../utils/logger');

const router = express.Router();

// 60-second cache (single-slot — analysis page is shared across users)
let _cache = { at: 0, key: null, value: null };
const CACHE_TTL_MS = 60 * 1000;

function getCacheKey(req) {
  return req.query.since || '';
}

router.get('/trade-analysis', requireAuth, async (req, res) => {
  try {
    const key = getCacheKey(req);
    const now = Date.now();

    if (_cache.value && _cache.key === key && (now - _cache.at) < CACHE_TTL_MS) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(_cache.value);
    }

    const result = await aggregateTradeAnalysis({ since: req.query.since || null });

    _cache = { at: now, key, value: result };
    res.setHeader('X-Cache', 'MISS');
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'analysis.trade-analysis failed');
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manual cache invalidation (admin-only optional future hook)
router.post('/trade-analysis/invalidate', requireAuth, async (_req, res) => {
  _cache = { at: 0, key: null, value: null };
  res.json({ ok: true, invalidated: true });
});

module.exports = router;