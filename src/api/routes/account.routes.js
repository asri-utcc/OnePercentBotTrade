'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const binanceRest = require('../../binance/binanceRest');
const logger = require('../../utils/logger');

const router = express.Router();

router.get('/balance', requireAuth, async (req, res) => {
  try {
    const acc = await binanceRest.getAccount();
    const balances = (acc.balances || [])
      .filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map((b) => ({
        asset: b.asset,
        free: parseFloat(b.free),
        locked: parseFloat(b.locked),
        total: parseFloat(b.free) + parseFloat(b.locked),
      }));
    res.json({ balances, canTrade: acc.canTrade, accountType: acc.accountType });
  } catch (err) {
    if (err.code === 'NO_API_KEYS') {
      return res.status(400).json({ error: 'API keys not configured' });
    }
    logger.error({ err: err.message }, 'balance fetch failed');
    res.status(500).json({ error: err.message });
  }
});

router.get('/open-orders', requireAuth, async (req, res) => {
  try {
    const { symbol } = req.query;
    const orders = await binanceRest.getOpenOrders(symbol ? { symbol: symbol.toUpperCase() } : {});
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/open-orders', requireAuth, async (req, res) => {
  try {
    const { symbol } = req.body || {};
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const resp = await binanceRest.cancelAllOpenOrders({ symbol: symbol.toUpperCase() });
    res.json({ resp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;