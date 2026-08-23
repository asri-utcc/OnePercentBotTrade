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

/**
 * POST /api/coins/info-bulk
 * FIX-2026-08-22 (weight spike): bulk fetch coin info for many symbols in 2 API calls
 *   - body: { symbols: string[] } (1..500)
 *   - response: { ok: true, coins: Record<sym, data> }
 *   - ลดจาก N×22 weight (parallel calls) → 22 weight (1 ticker + 1 exchangeInfo)
 *   - existing GET /info/:symbol ยังคงไว้สำหรับ single-symbol fallback
 */
router.post('/info-bulk', requireAuth, async (req, res) => {
  const symbols = req.body && req.body.symbols;
  if (!Array.isArray(symbols)) {
    return res.status(400).json({ error: 'symbols must be an array' });
  }
  if (symbols.length === 0) {
    return res.json({ ok: true, coins: {} });
  }
  if (symbols.length > 500) {
    return res.status(400).json({ error: 'symbols must be 1..500 items' });
  }
  try {
    const coins = await coinInfo.getCoinInfosBulk(symbols);
    res.json({ ok: true, coins });
  } catch (err) {
    // FIX-2026-08-22: CIRCUIT_OPEN จาก non-critical read path → 503 ให้ client retry
    if (err.code === 'CIRCUIT_OPEN') {
      return res.status(503).json({
        error: 'binance rate limit circuit open',
        code: 'CIRCUIT_OPEN',
        retryAfterSec: err.circuitSnapshot ? Math.ceil((err.circuitSnapshot.cooldownRemainingMs || 0) / 1000) : 30,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
