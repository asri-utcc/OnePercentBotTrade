'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Signal = require('../../db/models/Signal');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const { symbol, timeframe, botId, limit = 100 } = req.query;
    const q = {};
    if (symbol) q.symbol = symbol.toUpperCase();
    if (timeframe) q.timeframe = timeframe;
    if (botId) q.botId = botId;

    // FIX-2026-08-04: cap limit at 500 to prevent unbounded queries from misbehaving clients
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const signals = await Signal.find(q).sort({ candleCloseTime: -1 }).limit(safeLimit).lean();
    res.json({ signals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;