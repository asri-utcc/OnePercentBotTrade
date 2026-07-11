'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Trade = require('../../db/models/Trade');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const { botId, symbol, limit = 100, state } = req.query;
    const q = {};
    if (botId) q.botId = botId;
    if (symbol) q.symbol = symbol.toUpperCase();
    if (state) q.state = state;

    const trades = await Trade.find(q).sort({ createdAt: -1 }).limit(parseInt(limit, 10)).lean();
    res.json({ trades });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const trade = await Trade.findById(req.params.id).lean();
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    res.json({ trade });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;