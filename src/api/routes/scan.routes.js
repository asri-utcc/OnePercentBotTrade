'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const config = require('../../../config');
const logger = require('../../utils/logger');
const volatilityScanner = require('../../core/volatilityScanner');

const router = express.Router();

/**
 * POST /api/scan/volatility
 *
 * Body (all optional, defaults shown):
 *   timeframe        "5m"      1m..1M per config.binanceIntervals
 *   threshold        0.5       vol_pct threshold in %
 *   window           20        rolling window in bars (for volatility stats)
 *   tpWindow         500       FIX-2026-07-23: bars for kcMinPct (%TP แนะนำ)
 *   topN             100       top N symbols by 24h quoteVolume
 *   minQuoteVolume   1_000_000 skip pairs with 24h quoteVolume below this
 *   minPctBarsAbove  0.30      filter: pct_bars must be >= this
 *   trends           [...]     array subset of ['uptrend','downtrend','sideways']
 *   concurrency      8         max parallel klines fetches
 *   responseLimit    50        trim ranked list to this many entries for client
 *
 * Response: { universe, scanned, ranked[<=responseLimit], threshold, window, tpWindow, scanMs, trends }
 */
router.post('/volatility', requireAuth, async (req, res) => {
  try {
    const {
      timeframe = '5m',
      threshold = 0.5,
      window = 20,
      tpWindow = 500,
      topN = 100,
      minQuoteVolume = 1_000_000,
      minPctBarsAbove = 0.30,
      trends = ['uptrend', 'downtrend', 'sideways'],
      concurrency = 8,
      responseLimit = 50,
    } = req.body || {};

    if (!config.binanceIntervals.includes(timeframe)) {
      return res.status(400).json({
        error: `Invalid timeframe: ${timeframe}. Allowed: ${config.binanceIntervals.join(', ')}`,
      });
    }
    const safeTopN = Math.min(Math.max(parseInt(topN, 10) || 100, 5), 300);
    const safeWindow = Math.min(Math.max(parseInt(window, 10) || 20, 5), 20000);
    const safeTpWindow = Math.min(Math.max(parseInt(tpWindow, 10) || 500, 20), 20000);
    const safeConcurrency = Math.min(Math.max(parseInt(concurrency, 10) || 8, 1), 16);
    const safeLimit = Math.min(Math.max(parseInt(responseLimit, 10) || 50, 5), 200);

    logger.info({
      timeframe, threshold, window: safeWindow, tpWindow: safeTpWindow, topN: safeTopN,
      minQuoteVolume, minPctBarsAbove, trends,
    }, 'volatility scan requested');

    const start = Date.now();
    const result = await volatilityScanner.scanUniverse({
      timeframe,
      threshold: parseFloat(threshold),
      window: safeWindow,
      tpWindow: safeTpWindow,
      topN: safeTopN,
      minQuoteVolume: parseFloat(minQuoteVolume),
      minPctBarsAbove: parseFloat(minPctBarsAbove),
      trends,
      concurrency: safeConcurrency,
    });
    const ms = Date.now() - start;
    logger.info({
      scanned: result.scanned,
      ranked: result.ranked.length,
      window: result.window, tpWindow: result.tpWindow, ms, trends,
    }, 'volatility scan complete');

    res.json({
      ...result,
      trends: Array.from(new Set((Array.isArray(trends) ? trends : [trends]))),
      ranked: result.ranked.slice(0, safeLimit),
      scanMs: ms,
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'volatility scan failed');
    res.status(500).json({ error: err.message || 'volatility scan failed' });
  }
});

module.exports = router;