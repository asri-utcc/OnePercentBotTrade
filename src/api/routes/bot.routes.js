'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Bot = require('../../db/models/Bot');
const Trade = require('../../db/models/Trade');
const config = require('../../../config');
const botManager = require('../../core/botManager');
const symbolInfo = require('../../binance/symbolInfo');
const logger = require('../../utils/logger');

const router = express.Router();

/**
 * Middleware: ต้องใส่ password สำหรับ action อันตราย (สร้าง/ลบ/เปิด/ปิดบอท)
 * ป้องกันคนเปิด browser ที่ login ค้างไว้แล้วเผลอกด หรือ CSRF
 * รับ password จาก body.password, header X-Bot-Action-Password, หรือ query ?password=
 * ถ้า config.botActionPassword ว่าง → reject ทุก action (force secure by default)
 */
function requireBotActionPassword(req, res, next) {
  const expected = (config.botActionPassword || '').trim();
  if (!expected) {
    logger.warn({ path: req.path, ip: req.ip }, 'bot action blocked: BOT_ACTION_PASSWORD not configured');
    return res.status(503).json({
      error: 'Bot actions are disabled because BOT_ACTION_PASSWORD is not set. Set it in .env to enable create/delete/enable/disable.',
    });
  }
  const provided = (
    (req.body && req.body.password)
    || req.get('X-Bot-Action-Password')
    || req.query.password
    || ''
  ).toString().trim();
  if (!provided || provided !== expected) {
    logger.warn({ path: req.path, ip: req.ip, hasPassword: !!provided }, 'bot action blocked: invalid/missing password');
    return res.status(403).json({ error: 'Invalid or missing password for bot action' });
  }
  next();
}

/**
 * Start of "today" in server local timezone (00:00:00 local).
 * Used to compute todayTrades / todayPnl aggregates.
 */
function startOfTodayLocal() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Start of "this month" in server local timezone (day 1, 00:00:00 local).
 * Used to compute monthTrades / monthPnl aggregates.
 */
function startOfMonthLocal() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Aggregate todayTrades + todayPnl grouped by botId.
 * Returns Map<botIdString, { todayTrades, todayPnl }>.
 */
async function aggregateTodayPerBot() {
  const since = startOfTodayLocal();
  const rows = await Trade.aggregate([
    { $match: { sellFilledAt: { $gte: since }, realizedPnl: { $ne: null } } },
    { $group: {
      _id: '$botId',
      todayTrades: { $sum: 1 },
      todayPnl: { $sum: '$realizedPnl' },
    } },
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), { todayTrades: r.todayTrades, todayPnl: r.todayPnl });
  return map;
}

/**
 * Aggregate monthTrades + monthPnl grouped by botId (since day 1 of current month).
 * Returns Map<botIdString, { monthTrades, monthPnl }>.
 */
async function aggregateMonthPerBot() {
  const since = startOfMonthLocal();
  const rows = await Trade.aggregate([
    { $match: { sellFilledAt: { $gte: since }, realizedPnl: { $ne: null } } },
    { $group: {
      _id: '$botId',
      monthTrades: { $sum: 1 },
      monthPnl: { $sum: '$realizedPnl' },
    } },
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), { monthTrades: r.monthTrades, monthPnl: r.monthPnl });
  return map;
}

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
    const todayMap = await aggregateTodayPerBot();
    const monthMap = await aggregateMonthPerBot();
    // เพิ่ม totalCapital virtual + today/month stats
    const enriched = bots.map((b) => {
      const t = todayMap.get(String(b._id)) || { todayTrades: 0, todayPnl: 0 };
      const m = monthMap.get(String(b._id)) || { monthTrades: 0, monthPnl: 0 };
      return {
        ...b,
        totalCapital: (b.capitalPerTrade || 0) * (b.maxTrades || 0),
        todayTrades: t.todayTrades,
        todayPnl: t.todayPnl,
        monthTrades: m.monthTrades,
        monthPnl: m.monthPnl,
      };
    });
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
router.post('/', requireAuth, requireBotActionPassword, async (req, res) => {
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
      retryMax: parseInt(data.retryMax ?? 1, 10),
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
    const allowed = ['name', 'capitalPerTrade', 'maxTrades', 'tpPercent', 'retryTimeMin', 'retryMax', 'timeframe'];

    for (const k of allowed) {
      if (data[k] !== undefined) {
        if (k === 'capitalPerTrade' || k === 'tpPercent') {
          bot[k] = parseFloat(data[k]);
        } else if (k === 'maxTrades' || k === 'retryTimeMin' || k === 'retryMax') {
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
router.delete('/:id', requireAuth, requireBotActionPassword, async (req, res) => {
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
router.post('/:id/enable', requireAuth, requireBotActionPassword, async (req, res) => {
  try {
    const bot = await botManager.enableBot(req.params.id);
    res.json({ bot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bots/:id/disable ───────────────────────
router.post('/:id/disable', requireAuth, requireBotActionPassword, async (req, res) => {
  try {
    const bot = await botManager.disableBot(req.params.id);
    res.json({ bot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bots/:id/details ────────────────────────
// รวม bot + recent trades + recent signals + active trade
router.get('/:id/details', requireAuth, async (req, res) => {
  try {
    const Signal = require('../../db/models/Signal');
    const bot = await Bot.findById(req.params.id).lean();
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const trades = await Trade.find({ botId: bot._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    const signals = await Signal.find({ botId: bot._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const activeTrade = trades.find((t) =>
      ['placed', 'filled', 'holding', 'selling', 'retrying'].includes(t.state)
    ) || null;

    // today's stats for this bot (in server local time)
    const sinceToday = startOfTodayLocal();
    const todayStats = await Trade.aggregate([
      { $match: { botId: bot._id, sellFilledAt: { $gte: sinceToday }, realizedPnl: { $ne: null } } },
      { $group: { _id: null, todayTrades: { $sum: 1 }, todayPnl: { $sum: '$realizedPnl' } } },
    ]);
    const today = todayStats[0] || { todayTrades: 0, todayPnl: 0 };

    // this month's stats for this bot
    const sinceMonth = startOfMonthLocal();
    const monthStats = await Trade.aggregate([
      { $match: { botId: bot._id, sellFilledAt: { $gte: sinceMonth }, realizedPnl: { $ne: null } } },
      { $group: { _id: null, monthTrades: { $sum: 1 }, monthPnl: { $sum: '$realizedPnl' } } },
    ]);
    const month = monthStats[0] || { monthTrades: 0, monthPnl: 0 };

    res.json({
      bot: { ...bot, totalCapital: (bot.capitalPerTrade || 0) * (bot.maxTrades || 0) },
      activeTrade,
      trades,
      signals,
      todayStats: { trades: today.todayTrades || 0, pnl: today.todayPnl || 0 },
      monthStats: { trades: month.monthTrades || 0, pnl: month.monthPnl || 0 },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'bot details failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;