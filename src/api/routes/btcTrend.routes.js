'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const btcTrendMonitor = require('../../services/btcTrendMonitor');

const router = express.Router();

/**
 * FIX-2026-09-21: BTC Trend Pattern — current mode snapshot
 *
 * Returns the latest computed mode for BTCUSDT 1h (computed by the
 * background btcTrendMonitor service). UI mini-widget (Settings page)
 * polls this endpoint every ~60s to render the current mode badge.
 *
 * No historical data — read-only state of the singleton monitor.
 */
router.get('/current', requireAuth, (_req, res) => {
  try {
    res.json(btcTrendMonitor.getState());
  } catch (err) {
    res.status(500).json({ error: err.message || 'btc-trend current failed' });
  }
});

module.exports = router;