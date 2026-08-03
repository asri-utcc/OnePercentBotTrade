'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const coinInfo = require('../../core/coinInfo');

const router = express.Router();

/**
 * GET /api/coins/info/:symbol
 * FIX-2026-08-01: aggregate coin info จาก Binance
 *   - exchangeInfo: baseAsset/quoteAsset/status/lotSize/tickSize/notional
 *   - ticker/24hr: lastPrice/priceChangePct/quoteVolume/count
 *   - cache 5 นาที (server-side)
 *   - ใช้แสดงในบอท card + scan-volatility
 */
router.get('/info/:symbol', requireAuth, async (req, res) => {
  try {
    const data = await coinInfo.getCoinInfo(req.params.symbol);
    res.json({ ok: true, coin: data });
  } catch (err) {
    const status = err.message && err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
