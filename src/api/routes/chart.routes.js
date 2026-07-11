'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const binanceRest = require('../../binance/binanceRest');
const signalEngine = require('../../core/signalEngine');
const config = require('../../../config');
const logger = require('../../utils/logger');

const router = express.Router();

// ดึง klines + คำนวณ KC + S1 markers + trades
router.get('/klines', requireAuth, async (req, res) => {
  try {
    const { symbol, timeframe, limit = 200 } = req.query;
    if (!symbol || !timeframe) {
      return res.status(400).json({ error: 'symbol and timeframe required' });
    }
    if (!config.binanceIntervals.includes(timeframe)) {
      return res.status(400).json({ error: 'invalid timeframe' });
    }

    const raw = await binanceRest.getKlines({
      symbol,
      interval: timeframe,
      limit: Math.min(parseInt(limit, 10), 1000),
    });

    const klines = raw.map((k) => {
      const [openTime, open, high, low, close, volume, closeTime] = k;
      return {
        openTime,
        closeTime,
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: parseFloat(volume),
      };
    });

    const { signals, basis, upper, lower, bg } = signalEngine.detectS1Signals(klines);

    res.json({
      symbol,
      timeframe,
      klines,
      keltner: { basis, upper, lower },
      bgStates: bg,
      signals,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'chart klines failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;