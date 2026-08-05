'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const binanceRest = require('../../binance/binanceRest');
const logger = require('../../utils/logger');
// FIX-2026-08-05: shared BNB balance cache (30s TTL) — reuse ไม่เพิ่ม Binance weight
const telegramNotifier = require('../../services/telegramNotifier');

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

// FIX-2026-08-05: BNB low-balance status — ใช้แสดง warning banner บน /bots.html
//   - reuses telegramNotifier cache (30s TTL) → ไม่เพิ่ม Binance weight
//   - ถ้า cache ว่าง/หมดอายุ → inline fetch (single getAccount + bookTicker call)
//   - threshold คงที่ $1 USDT (ต่างจาก telegram ที่ใช้ค่าใน AppConfig — banner แสดงเร็วกว่า telegram)
const BNB_BANNER_THRESHOLD_USDT = 1.0;
// FIX-2026-08-05: gauge zone thresholds (ไม่ซ้อนทับ alert threshold — แยกกันคนละชั้น)
//   - pct = bnbValueUsdt / bnbGaugeTargetUsdt * 100
//   - healthy: ≥ 40% → green
//   - low: 10–40%     → gold
//   - critical: < 10% → red (pulse)
const GAUGE_HEALTHY_MIN_PCT = 40;
const GAUGE_LOW_MIN_PCT = 10;
const BNB_GAUGE_TARGET_DEFAULT = 10;

router.get('/bnb-status', requireAuth, async (req, res) => {
  try {
    let balance = telegramNotifier.getBnbBalanceCached();
    const now = Date.now();
    if (!balance || (now - balance.ts) > 30_000) {
      // cache miss/expired → inline fetch (fallback path เผื่อ telegramNotifier ยังไม่ได้ scan ครั้งแรก)
      const acc = await binanceRest.getAccount();
      const row = (acc.balances || []).find((b) => b.asset === 'BNB');
      const qty = row ? (parseFloat(row.free) || 0) + (parseFloat(row.locked) || 0) : 0;
      const ticker = await binanceRest.getBookTicker('BNBUSDT');
      const usdtPrice = parseFloat(ticker.bidPrice) || 0;
      balance = { qty, usdtPrice, usdtValue: qty * usdtPrice, ts: now };
    }
    // FIX-2026-08-05: gauge fields — read user's target from AppConfig (default 10 USDT)
    //   - pct = bnbValueUsdt / bnbGaugeTargetUsdt * 100, clamped 0..100
    //   - zone: healthy ≥ 70 / low ≥ 30 / critical < 30
    const AppConfig = require('../../db/models/AppConfig');
    const cfgDoc = await AppConfig.findOne({ key: 'singleton' }).lean().catch(() => null);
    const gaugeTarget = cfgDoc && Number(cfgDoc.bnbGaugeTargetUsdt) > 0
      ? Number(cfgDoc.bnbGaugeTargetUsdt)
      : BNB_GAUGE_TARGET_DEFAULT;
    const pctRaw = gaugeTarget > 0 ? (balance.usdtValue / gaugeTarget) * 100 : 0;
    const gaugePct = Math.max(0, Math.min(100, pctRaw));
    const gaugeZone = gaugePct >= GAUGE_HEALTHY_MIN_PCT ? 'healthy'
                    : gaugePct >= GAUGE_LOW_MIN_PCT ? 'low'
                    : 'critical';

    res.json({
      bnbQty: balance.qty,
      bnbUsdtPrice: balance.usdtPrice,
      bnbValueUsdt: balance.usdtValue,
      threshold: BNB_BANNER_THRESHOLD_USDT,
      isLow: balance.usdtValue < BNB_BANNER_THRESHOLD_USDT,
      gaugeTargetUsdt: gaugeTarget,
      gaugePct,
      gaugeZone,
      ts: balance.ts,
    });
  } catch (err) {
    const binanceErr = binanceRest.formatBinanceError(err);
    if (binanceErr && binanceErr.code === 'NO_API_KEYS') {
      return res.status(400).json({ error: 'API keys not configured' });
    }
    logger.error({ err: binanceErr.msg || err.message, binanceCode: binanceErr.code }, 'bnb-status fetch failed');
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