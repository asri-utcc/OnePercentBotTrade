'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Bot = require('../../db/models/Bot');
const config = require('../../../config');
const botManager = require('../../core/botManager');
const symbolInfo = require('../../binance/symbolInfo');
const logger = require('../../utils/logger');

const router = express.Router();

// ดึง list symbols ที่ valid (สำหรับ dropdown)
router.get('/symbols', requireAuth, async (req, res) => {
  try {
    const symbols = await symbolInfo.listSymbols();
    res.json({ symbols });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bots ────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const bots = await Bot.find().sort({ createdAt: -1 }).lean();
    // เพิ่ม totalCapital virtual
    const enriched = bots.map((b) => ({
      ...b,
      totalCapital: (b.capitalPerTrade || 0) * (b.maxTrades || 0),
    }));
    res.json({ bots: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bots/:id ────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id).lean();
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json({
      bot: {
        ...bot,
        totalCapital: (bot.capitalPerTrade || 0) * (bot.maxTrades || 0),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bots ───────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const data = req.body || {};
    const defaults = config.defaults;

    const symbol = (data.symbol || defaults.symbol).toUpperCase();
    const timeframe = data.timeframe || defaults.timeframe;

    // validate timeframe
    if (!config.binanceIntervals.includes(timeframe)) {
      return res.status(400).json({ error: `Invalid timeframe: ${timeframe}. Allowed: ${config.binanceIntervals.join(', ')}` });
    }

    // validate symbol กับ Binance
    try {
      await symbolInfo.loadSymbol(symbol);
      const info = symbolInfo.getCached(symbol);
      if (!info.isSpotTradingAllowed) {
        return res.status(400).json({ error: `${symbol} ไม่อนุญาตให้เทรด spot` });
      }
      // validate capital vs minNotional
      const capital = parseFloat(data.capitalPerTrade ?? defaults.capitalPerTrade);
      if (info.notional && capital < info.notional.minNotional.toNumber()) {
        return res.status(400).json({
          error: `capitalPerTrade ${capital} ต่ำกว่า minNotional ${info.notional.minNotional.toString()} ของ ${symbol}`,
        });
      }
    } catch (err) {
      return res.status(400).json({ error: `Symbol validation failed: ${err.message}` });
    }

    const bot = await Bot.create({
      name: data.name || `${symbol} ${timeframe}`,
      symbol,
      timeframe,
      capitalPerTrade: parseFloat(data.capitalPerTrade ?? defaults.capitalPerTrade),
      maxTrades: parseInt(data.maxTrades ?? defaults.maxTrades, 10),
      tpPercent: parseFloat(data.tpPercent ?? defaults.tpPercent),
      retryTimeMin: parseInt(data.retryTimeMin ?? defaults.retryTimeMin, 10),
      enabled: false,
      status: 'idle',
    });

    res.status(201).json({ bot });
  } catch (err) {
    logger.error({ err: err.message }, 'create bot failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/bots/:id ────────────────────────────────
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const data = req.body || {};
    const allowed = ['name', 'capitalPerTrade', 'maxTrades', 'tpPercent', 'retryTimeMin', 'timeframe'];

    for (const k of allowed) {
      if (data[k] !== undefined) {
        if (k === 'capitalPerTrade' || k === 'tpPercent') {
          bot[k] = parseFloat(data[k]);
        } else if (k === 'maxTrades' || k === 'retryTimeMin') {
          bot[k] = parseInt(data[k], 10);
        } else {
          bot[k] = data[k];
        }
      }
    }

    // validate timeframe
    if (!config.binanceIntervals.includes(bot.timeframe)) {
      return res.status(400).json({ error: `Invalid timeframe: ${bot.timeframe}` });
    }

    // validate symbol (ไม่ให้แก้ symbol ใน v1 - ถ้าต้องการ ลบแล้วสร้างใหม่)
    try {
      await symbolInfo.loadSymbol(bot.symbol);
      const info = symbolInfo.getCached(bot.symbol);
      if (info.notional && bot.capitalPerTrade < info.notional.minNotional.toNumber()) {
        return res.status(400).json({
          error: `capitalPerTrade ${bot.capitalPerTrade} ต่ำกว่า minNotional ${info.notional.minNotional.toString()}`,
        });
      }
    } catch (err) {
      return res.status(400).json({ error: `Symbol validation failed: ${err.message}` });
    }

    await bot.save();

    // ถ้า enabled → restart trader
    if (bot.enabled) {
      try {
        await botManager.stopTrader(bot._id);
        await botManager.spawnTrader(bot);
      } catch (err) {
        logger.warn({ err: err.message, botId: bot._id.toString() }, 'restart after edit failed');
      }
    }

    res.json({ bot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/bots/:id ─────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    if (bot.enabled) {
      await botManager.stopTrader(bot._id);
    }
    await Bot.deleteOne({ _id: bot._id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bots/:id/enable ────────────────────────
router.post('/:id/enable', requireAuth, async (req, res) => {
  try {
    const bot = await botManager.enableBot(req.params.id);
    res.json({ bot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bots/:id/disable ───────────────────────
router.post('/:id/disable', requireAuth, async (req, res) => {
  try {
    const bot = await botManager.disableBot(req.params.id);
    res.json({ bot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;