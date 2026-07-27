'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const fxService = require('../../services/fxService');
const logger = require('../../utils/logger');

const router = express.Router();

/**
 * GET /api/fx/usdt-thb
 * Returns USDT → THB exchange rate.
 *
 * Response:
 *   {
 *     rate: 33.28,           // THB per 1 USDT
 *     source: 'exchangerate-api' | 'coingecko',
 *     fetchedAt: 1783814551000,    // ms epoch when source was queried
 *     ageSec: 142,                 // age in seconds at time of response
 *     stale: false,                // true if past TTL but still serving cached value
 *     ttlMs: 600000,               // cache TTL in ms (informational)
 *   }
 *
 * 200 with rate even if cache is stale (stale-while-revalidate).
 * 503 only when cache is empty AND all sources fail.
 * 401 if not authenticated (requireAuth).
 */
router.get('/usdt-thb', requireAuth, async (req, res) => {
  try {
    const result = await fxService.getUsdtToThb();
    res.json({
      rate: result.rate,
      source: result.source,
      fetchedAt: result.fetchedAt,
      ageSec: result.ageSec,
      stale: !!result.stale,
      ttlMs: fxService.CACHE_TTL_MS,
    });
  } catch (err) {
    if (err && err.status === 503) {
      logger.warn({ err: err.message }, 'fx: serving 503 (no cache, all sources failed)');
      return res.status(503).json({ error: err.message });
    }
    logger.error({ err: err.message }, 'fx: usdt-thb failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
