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
    const { symbol, timeframe, limit = 200, endTime, kcMult, s1OnlyDown } = req.query;
    if (!symbol || !timeframe) {
      return res.status(400).json({ error: 'symbol and timeframe required' });
    }
    if (!config.binanceIntervals.includes(timeframe)) {
      return res.status(400).json({ error: 'invalid timeframe' });
    }

    const klineArgs = {
      symbol,
      interval: timeframe,
      limit: Math.min(parseInt(limit, 10), 1000),
    };
    // ถ้ามี endTime (epoch ms) ให้ดึงแท่งเก่ากว่าเวลานั้น (ใช้กับ "Load older trades")
    if (endTime) {
      const et = parseInt(endTime, 10);
      if (Number.isFinite(et) && et > 0) klineArgs.endTime = et;
    }

    const raw = await binanceRest.getKlines(klineArgs);

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

    // FIX-2026-07-24: per-bot KC mult + s1OnlyDown (frontend ส่ง bot.kcMult, bot.s1OnlyDown มาเป็น query string)
    const mult = kcMult != null && Number.isFinite(parseFloat(kcMult))
      ? Math.min(5, Math.max(0.5, parseFloat(kcMult)))
      : 1.5;
    const onlyDown = s1OnlyDown === 'true' || s1OnlyDown === '1';
    const { signals, basis, upper, lower, bg } = signalEngine.detectS1Signals(klines, { mult, onlyDown });

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