'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const backtester = require('../../core/backtester');
const BacktestResult = require('../../db/models/BacktestResult');
const config = require('../../../config');
const logger = require('../../utils/logger');

const router = express.Router();

router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      symbol,
      timeframe,
      from,
      to,
      tpPercent = 0.1,
      capitalPerTrade = 10,
      useBnbForFees = false,
      maxConcurrentTrades = 10,
    } = req.body || {};

    if (!symbol || !timeframe || !from || !to) {
      return res.status(400).json({ error: 'symbol, timeframe, from, to required' });
    }
    if (!config.binanceIntervals.includes(timeframe)) {
      return res.status(400).json({ error: 'invalid timeframe' });
    }

    logger.info({ symbol, timeframe, from, to }, 'backtest requested');

    const result = await backtester.runBacktest({
      symbol: symbol.toUpperCase(),
      timeframe,
      from,
      to,
      tpPercent: parseFloat(tpPercent),
      capitalPerTrade: parseFloat(capitalPerTrade),
      useBnbForFees: !!useBnbForFees,
      maxConcurrentTrades: parseInt(maxConcurrentTrades, 10),
    });

    res.json({
      id: result.result._id,
      executionModel: result.result.executionModel,
      stats: result.stats,
      signalsCount: result.signals.length,
      tradesCount: result.trades.length,
      // FIX 2026-07-13: แจ้ง UI ว่าข้อมูลถูกตัดจาก SAFETY_LIMIT (ใช้กรณีขอช่วงยาวเกิน cap)
      truncated: result.truncated,
      candlesFetched: result.candlesFetched,
      requestedDays: result.requestedDays,
      actualDays: result.actualDays,
      // ส่ง trades ทั้งหมดที่เก็บไว้ (ถ้า > 500 trades จะถูกตัดเป็น head+tail 250+250 ฝั่ง server)
      // ฝั่ง client จะแบ่งหน้าเอง 20/page
      trades: result.trades,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'backtest failed');
    res.status(500).json({ error: err.message });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const results = await BacktestResult.find().sort({ createdAt: -1 }).limit(50).lean();
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const result = await BacktestResult.findById(req.params.id).lean();
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FIX-2026-07-30: Multi-bot backtest — shared capital pool + per-bot stats
router.post('/multi', requireAuth, async (req, res) => {
  try {
    const { totalCapital, from, to, bots = [] } = req.body || {};

    if (!totalCapital || totalCapital <= 0) {
      return res.status(400).json({ error: 'totalCapital required (> 0)' });
    }
    if (!bots.length) {
      return res.status(400).json({ error: 'bots[] required (>= 1)' });
    }
    if (!from || !to) {
      return res.status(400).json({ error: 'from, to required (YYYY-MM-DD)' });
    }
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      if (!b.symbol || !b.timeframe) {
        return res.status(400).json({ error: `bots[${i}]: symbol + timeframe required` });
      }
      if (!config.binanceIntervals.includes(b.timeframe)) {
        return res.status(400).json({ error: `bots[${i}]: invalid timeframe "${b.timeframe}"` });
      }
    }

    logger.info({ totalCapital, botCount: bots.length, from, to }, 'multi-bot backtest requested');

    const result = await backtester.runMultiBacktest({
      totalCapital: parseFloat(totalCapital),
      from,
      to,
      bots: bots.map((b) => ({
        symbol: b.symbol,
        timeframe: b.timeframe,
        tpPercent: parseFloat(b.tpPercent != null ? b.tpPercent : 0.1),
        capitalPerTrade: parseFloat(b.capitalPerTrade != null ? b.capitalPerTrade : 10),
        maxConcurrentTrades: parseInt(b.maxConcurrentTrades != null ? b.maxConcurrentTrades : 10, 10),
        maxBuyWait: parseInt(b.maxBuyWait != null ? b.maxBuyWait : 6, 10),
        useBnbForFees: !!b.useBnbForFees,
        kcMult: b.kcMult != null ? parseFloat(b.kcMult) : 1.5,
        xs1Enabled: b.xs1Enabled !== false,
      })),
    });

    res.json(result);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'multi-bot backtest failed');
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await BacktestResult.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;