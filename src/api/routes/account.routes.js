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
    // FIX-2026-07-14: format Binance error so caller/UI รู้ root cause
    //   - NO_API_KEYS → 400 (user-config issue)
    //   - Binance-side error (-1021 timestamp, -1022 signature, IP block, etc.) → 502 Bad Gateway
    //     (axios คืน message "Request failed with status code N" ซึ่งทำให้ UI เห็น "400 ไม่สามารถโหลด"
    //      แต่จริง ๆ คือ upstream Binance ไม่ใช่ client error)
    const binanceErr = binanceRest.formatBinanceError(err);
    if (binanceErr && binanceErr.code === 'NO_API_KEYS') {
      return res.status(400).json({ error: 'API keys not configured' });
    }
    logger.error({
      err: binanceErr.msg || err.message,
      binanceCode: binanceErr.code,
      binanceStatus: binanceErr.status,
    }, 'balance fetch failed');
    res.status(502).json({
      error: binanceErr.msg || err.message,
      binanceCode: binanceErr.code,
      binanceStatus: binanceErr.status,
    });
  }
});

router.get('/open-orders', requireAuth, async (req, res) => {
  try {
    const { symbol } = req.query;
    const orders = await binanceRest.getOpenOrders(symbol ? { symbol: symbol.toUpperCase() } : {});
    res.json({ orders });
  } catch (err) {
    // FIX-2026-07-14: Binance-side errors → 502, not 500
    const binanceErr = binanceRest.formatBinanceError(err);
    logger.error({ err: binanceErr.msg || err.message, binanceCode: binanceErr.code }, 'open-orders fetch failed');
    res.status(502).json({ error: binanceErr.msg || err.message, binanceCode: binanceErr.code });
  }
});

router.delete('/open-orders', requireAuth, async (req, res) => {
  try {
    const { symbol } = req.body || {};
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const resp = await binanceRest.cancelAllOpenOrders({ symbol: symbol.toUpperCase() });
    res.json({ resp });
  } catch (err) {
    const binanceErr = binanceRest.formatBinanceError(err);
    logger.error({ err: binanceErr.msg || err.message, binanceCode: binanceErr.code }, 'cancel-all-orders failed');
    res.status(502).json({ error: binanceErr.msg || err.message, binanceCode: binanceErr.code });
  }
});

module.exports = router;