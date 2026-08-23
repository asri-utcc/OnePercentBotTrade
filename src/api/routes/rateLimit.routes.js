'use strict';

/**
 * FIX-2026-08-23: Live Binance API weight gauge endpoint
 *
 *   GET /api/system/rate-limit  → live RateLimiter snapshot for navbar pill
 *
 *   • Auth required (any logged-in user — weight is not a secret, useful for
 *     operators looking at the page when something is on fire)
 *   • NOT admin-gated (the admin endpoint at /api/admin/rate-limit also
 *     exposes min/max/default — we don't need that here)
 *   • Pure read — no DB, no I/O — directly delegates to
 *     `binanceRest.getRateLimitStatus()` which already runs in-process
 *   • No caching on the client side; navbar polls / listens via WS
 *     (see `rateLimit:update` event in dashboardWs.js)
 */

const express = require('express');
const router = express.Router();

const binanceRest = require('../../binance/binanceRest');
const { requireAuth } = require('../middleware/auth');

router.get('/rate-limit', requireAuth, (req, res) => {
  try {
    const s = binanceRest.getRateLimitStatus();
    const usedPct = s.capacity > 0
      ? Math.round((s.usedEstimated / s.capacity) * 100)
      : 0;
    res.json({
      capacity: s.capacity,
      tokens: Math.round(s.tokens),
      usedEstimated: Math.round(s.usedEstimated),
      usedPct,
      refillRate: s.refillRate, // tokens / ms
      banRemainingSec: s.banRemainingSec,
      circuitBreaker: s.circuitBreaker
        ? {
            state: s.circuitBreaker.state,                 // CLOSED / OPEN / HALF_OPEN
            usedPct: s.circuitBreaker.usedPct,             // 0-100
            cooldownRemainingMs: s.circuitBreaker.cooldownRemainingMs,
          }
        : null,
      ts: Date.now(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;