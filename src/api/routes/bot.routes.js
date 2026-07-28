'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Bot = require('../../db/models/Bot');
const Trade = require('../../db/models/Trade');
const config = require('../../../config');
const botManager = require('../../core/botManager');
const symbolInfo = require('../../binance/symbolInfo');
const forceClose = require('../../core/forceClose');
const klineCache = require('../../services/klineCache');
const indicators = require('../../core/indicators');
const volatilityScanner = require('../../core/volatilityScanner');
const binanceRest = require('../../binance/binanceRest');
const signalEngine = require('../../core/signalEngine');
const fees = require('../../binance/fees');
const tpUpdater = require('../../core/tpUpdater'); // FIX-2026-07-28: applyMinNetTpFloor (single source of truth)
const logger = require('../../utils/logger');
const eventBus = require('../../services/eventBus');

/**
 * FIX-2026-07-23: format TP ให้เป็นทศนิยม 3 ตำแหน่ง โดยหลักพัน (ตำแหน่งที่ 3) ต้องเป็น 1 เสมอ
 *   - floor ทศนิยมที่ 2 แล้ว +0.001 → output อยู่ในรูป x.xx1 เสมอ
 *   - เช่น 0.3502 → 0.351, 0.123 → 0.121, 0.0008 → 0.001, 0.999 → 0.991
 *   - ใช้สำหรับ suggest-tp response + บอทที่ enable autoUpdateTp (ให้ output ที่จำง่าย + เทียบง่าย)
 */
function formatTpToXxx1(value) {
  if (value == null || !Number.isFinite(value)) return value;
  const truncated2 = Math.floor(value * 100) / 100;
  return Number((truncated2 + 0.001).toFixed(3));
}

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
 * FIX-2026-07-23: Active position count per bot — trades ที่ยังเปิดอยู่ (BUY/SELL รอ fill หรือถือ position)
 *   ใช้ใน dashboard card เพื่อ highlight บอทที่กำลังมี position ค้าง
 *   Returns Map<botIdString, count>
 */
async function aggregateActivePositionsPerBot() {
  const rows = await Trade.aggregate([
    { $match: {
      state: { $in: ['placed', 'partial_wait', 'filled', 'retrying', 'holding', 'selling', 'stopping'] },
    } },
    { $group: { _id: '$botId', count: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), r.count);
  return map;
}

/**
 * FIX-2026-07-23: คำนวณ price indicator สำหรับ bot card
 *   - lastClose = ราคาปิดแท่งล่าสุด (หรือราคา real-time ของแท่งที่กำลังสร้าง)
 *   - ema20 = EMA(closes, 20) ของ timeframe ของบอท
 *   - emaGapPct = (lastClose - ema20) / ema20 * 100
 *   - emaState = 'above' | 'below' | 'warmup'
 *   - closes (last 20) = seed ให้ client คำนวณ EMA realtime ได้แม่นยำตั้งแต่ render แรก
 *
 *   ใช้ klineCache (in-memory) — ไม่ต้อง fetch ใหม่ → เร็วและ realtime (อัปเดตทุก WS kline tick)
 *   ถ้ายังไม่ warm-up (< 20 klines) → return emaState='warmup'
 */
function computeBotIndicator(bot) {
  const klines = klineCache.getAll(bot.symbol, bot.timeframe);
  const current = klineCache.getCurrent(bot.symbol, bot.timeframe);
  if (klines.length === 0 && !current) {
    return { lastClose: null, ema20: null, emaGapPct: null, emaState: 'warmup', closes: [] };
  }
  // ใช้แท่งปัจจุบัน (กำลังสร้าง) ถ้ามี — ให้ price realtime แม่นยำที่สุด
  let lastClose = null;
  if (current) lastClose = parseFloat(current.close);
  if (lastClose == null && klines.length > 0) {
    const last = klines[klines.length - 1];
    lastClose = parseFloat(last.close);
  }
  // คำนวณ EMA20 บน closes ของ klines + current (ถ้ามี)
  let closesForEma;
  if (current) {
    // รวมแท่งปัจจุบันเข้าไปด้วย (append ไม่ replace)
    closesForEma = klines.map((k) => parseFloat(k.close));
    closesForEma.push(parseFloat(current.close));
  } else {
    closesForEma = klines.map((k) => parseFloat(k.close));
  }
  // FIX-2026-07-23: return last 20 closes เพื่อให้ client seed EMA cache ได้แม่นยำ
  const closesForClient = closesForEma.slice(-20);

  if (closesForEma.length < 20) {
    return { lastClose, ema20: null, emaGapPct: null, emaState: 'warmup', closes: closesForClient };
  }
  const emaArr = indicators.ema(closesForEma, 20);
  const ema20 = emaArr[emaArr.length - 1];
  if (ema20 == null || ema20 === 0) {
    return { lastClose, ema20: null, emaGapPct: null, emaState: 'warmup', closes: closesForClient };
  }
  const emaGapPct = ((lastClose - ema20) / ema20) * 100;
  const emaState = lastClose >= ema20 ? 'above' : 'below';
  return { lastClose, ema20, emaGapPct, emaState, closes: closesForClient };
}

/**
 * Cumulative active duration (ms) for a bot:
 *   totalActiveMs + (now - enabledAt) if currently enabled, else 0
 */
function computeActiveDurationMs(bot) {
  const base = bot && bot.totalActiveMs ? bot.totalActiveMs : 0;
  if (bot && bot.enabled && bot.enabledAt) {
    return base + (Date.now() - new Date(bot.enabledAt).getTime());
  }
  return base;
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
    // FIX-2026-07-24: เรียง enabled ก่อน (true=1 มาก่อน false=0) → บอทที่เปิดอยู่ลอยขึ้นบนสุดอัตโนมัติ
    //   - secondary sort: createdAt desc (บอทใหม่อยู่บนสุดภายใน group)
    const bots = await Bot.find().sort({ enabled: -1, createdAt: -1 }).lean();
    const todayMap = await aggregateTodayPerBot();
    const monthMap = await aggregateMonthPerBot();
    const activePosMap = await aggregateActivePositionsPerBot();
    // เพิ่ม totalCapital virtual + today/month stats + price/EMA indicator
    const enriched = bots.map((b) => {
      const t = todayMap.get(String(b._id)) || { todayTrades: 0, todayPnl: 0 };
      const m = monthMap.get(String(b._id)) || { monthTrades: 0, monthPnl: 0 };
      const indicator = computeBotIndicator(b);
      return {
        ...b,
        totalCapital: (b.capitalPerTrade || 0) * (b.maxTrades || 0),
        todayTrades: t.todayTrades,
        todayPnl: t.todayPnl,
        monthTrades: m.monthTrades,
        monthPnl: m.monthPnl,
        activeDurationMs: computeActiveDurationMs(b),
        // FIX-2026-07-23: dashboard card extras
        activePositionsCount: activePosMap.get(String(b._id)) || 0,
        lastClose: indicator.lastClose,
        ema20: indicator.ema20,
        emaGapPct: indicator.emaGapPct,
        emaState: indicator.emaState,
        emaCloses: indicator.closes, // last 20 closes for client EMA seed
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
    const indicator = computeBotIndicator(bot);
    res.json({
      bot: {
        ...bot,
        totalCapital: (bot.capitalPerTrade || 0) * (bot.maxTrades || 0),
        activePositionsCount: await Trade.countDocuments({
          botId: bot._id,
          state: { $in: ['placed', 'partial_wait', 'filled', 'retrying', 'holding', 'selling', 'stopping'] },
        }),
        lastClose: indicator.lastClose,
        ema20: indicator.ema20,
        emaGapPct: indicator.emaGapPct,
        emaState: indicator.emaState,
        emaCloses: indicator.closes,
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
      // FIX-2026-07-24: parseFloat เพื่อรองรับทศนิยม (0.5 = 30 วินาที)
      // FIX-2026-07-25: clamp 0.1..60 ตาม schema (mirror PUT route)
      retryTimeMin: Math.min(60, Math.max(0.1, parseFloat(data.retryTimeMin ?? defaults.retryTimeMin))),
      retryMax: parseInt(data.retryMax ?? 1, 10),
      // FIX-2026-07-24: kcMult validation — clamp 0.5..5 (default 1.5)
      kcMult: Math.min(5, Math.max(0.5, parseFloat(data.kcMult ?? 1.5))),
      // FIX-2026-07-24: minSpreadTicks (0..10, default 1) — per-bot spread tolerance
      minSpreadTicks: Math.min(10, Math.max(0, parseInt(data.minSpreadTicks ?? 1, 10))),
      // FIX-2026-07-24: s1OnlyDown (default false) — skip bg 2→1 (ซื้อตอนราคาสูง)
      s1OnlyDown: data.s1OnlyDown === true,
      // FIX-2026-07-25: xs1Enabled (default true) — per-bot XS1 anti-dump gate toggle
      //   - true (default): skip S1 เมื่อ candle-wide dump pattern
      //   - false: ใช้สัญญาณดั้งเดิม (ไม่ skip)
      xs1Enabled: data.xs1Enabled !== false,
      stopLossOnUpperKC: data.stopLossOnUpperKC === true, // FIX-2026-07-23: stop-loss toggle
      autoUpdateTp: data.autoUpdateTp === true, // FIX-2026-07-23: TP auto-update toggle
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
    const allowed = ['name', 'capitalPerTrade', 'maxTrades', 'tpPercent', 'retryTimeMin', 'retryMax', 'timeframe', 'stopLossOnUpperKC', 'autoUpdateTp', 'kcMult', 'minSpreadTicks', 's1OnlyDown', 'xs1Enabled', 'suggestTpWindow'];

    for (const k of allowed) {
      if (data[k] !== undefined) {
        if (k === 'capitalPerTrade' || k === 'tpPercent' || k === 'kcMult') {
          bot[k] = parseFloat(data[k]);
        } else if (k === 'maxTrades' || k === 'retryTimeMin' || k === 'retryMax' || k === 'minSpreadTicks' || k === 'suggestTpWindow') {
          // FIX-2026-07-24: minSpreadTicks clamp 0..10
          // FIX-2026-07-25: retryTimeMin ต้อง parseFloat (รองรับ 0.1..60) ไม่ใช่ parseInt — เดิมใช้ parseInt ตัดทศนิยมทิ้ง → "0.1" กลายเป็น 0 → validation fail
          if (k === 'minSpreadTicks') {
            bot[k] = Math.min(10, Math.max(0, parseInt(data[k], 10)));
          } else if (k === 'retryTimeMin') {
            // FIX-2026-07-25: เก็บทศนิยม (e.g. 0.5 = 30s) สำหรับ timeframe สั้น — clamp 0.1..60 ตาม schema
            bot[k] = Math.min(60, Math.max(0.1, parseFloat(data[k])));
          } else if (k === 'suggestTpWindow') {
            // FIX-2026-07-25: TP suggestion window clamp 30..1000 bars
            bot[k] = Math.min(1000, Math.max(30, parseInt(data[k], 10)));
          } else {
            bot[k] = parseInt(data[k], 10);
          }
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

    // FIX-2026-07-24: emit bot:updated เพื่อให้ trader.js hot-reload tunable fields
    //   (kcMult, s1OnlyDown, minSpreadTicks, ...) โดยไม่ต้อง restart
    //   - ก่อนหน้านี้: ถ้า bot.enabled → stop+spawn (ใช้เวลา 2-3s, อาจ miss signal)
    //   - ตอนนี้: emit → trader subscribe refresh this.bot in-place → S1 ตรวจด้วยค่าใหม่ทันที
    eventBus.emit('bot:updated', { botId: String(bot._id) });

    // ถ้า enabled → restart trader (ยังคง stop+spawn เพื่อ reload symbolInfo cache + reconnect)
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
    // FIX-2026-07-24: emit bot:deleted สำหรับ Telegram notifier (เดิมไม่มี — silent delete)
    eventBus.emit('bot:deleted', { botId: String(bot._id), name: bot.name });
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

// ─── POST /api/bots/:id/clear-error ──────────────────
// FIX-2026-07-23: ผู้ใช้สามารถกด × ปิด banner error ได้เอง
//   - clear lastError field ใน DB
//   - ไม่เปลี่ยน bot.status (ถ้าเคย error ก็ยังคง error อยู่จนกว่าจะ recover เอง)
//   - ส่ง bot:updated WS event เพื่อให้ dashboard refresh
router.post('/:id/clear-error', requireAuth, async (req, res) => {
  try {
    const upd = await Bot.updateOne(
      { _id: req.params.id },
      { $set: { lastError: '' } }
    );
    if (upd.matchedCount === 0) return res.status(404).json({ error: 'Bot not found' });
    const bot = await Bot.findById(req.params.id).lean();
    eventBus.emit('bot:updated', { botId: req.params.id });
    logger.info({ botId: req.params.id.toString() }, 'bot: clear-error — lastError cleared by user');
    res.json({ ok: true, bot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bots/suggest-tp ────────────────────────
// FIX-2026-07-23: ปุ่ม "Get recommend TP%" ในหน้า create/edit bot
//   Body: { symbol, timeframe, window?: 500 }
//   - fetch klines (symbol, timeframe) ตามจำนวน bars (default 500)
//   - คำนวณ Keltner Channel(20, 1.5) → Min %KC over window
//   - คำนวณ EMA20 trend ของ upper-TF (จาก TREND_TF_MAP)
//   - Return: suggestedTpPct = minKC/4 (upper) หรือ minKC/8 (lower)
//             + meta (trendState, trendTF, kcMinPct, lastClose, trendGapPct)
//   ใช้ requireAuth (ไม่ต้องใช้ botActionPassword — เป็น read-only calculation)
router.post('/suggest-tp', requireAuth, async (req, res) => {
  const start = Date.now();
  try {
    const { symbol, timeframe, window: windowBars } = req.body || {};
    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ error: 'symbol is required' });
    }
    if (!timeframe || !config.binanceIntervals.includes(timeframe)) {
      return res.status(400).json({
        error: `Invalid timeframe: ${timeframe}. Allowed: ${config.binanceIntervals.join(', ')}`,
      });
    }
    const window = Math.min(Math.max(parseInt(windowBars, 10) || 500, 30), 1000);

    // 1) fetch main TF klines (default 500 bars)
    const needsPagination = window > 1000; // safety — current default 500 < 1000
    const rawMain = needsPagination
      ? await binanceRest.getKlinesPaginated({
        symbol, interval: timeframe, totalLimit: window, batchLimit: 1000,
      })
      : await binanceRest.getKlines({
        symbol, interval: timeframe, limit: window,
      });
    const mainKlines = rawMain.map((k) => ({
      openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      closeTime: k[6],
    }));
    if (mainKlines.length < 20) {
      return res.status(400).json({
        error: `Not enough klines for ${symbol}/${timeframe}: got ${mainKlines.length}, need >= 20`,
      });
    }

    // 2) compute KC(20, 1.5) → Min %KC over the full window
    const highs = mainKlines.map((k) => k.high);
    const lows = mainKlines.map((k) => k.low);
    const closes = mainKlines.map((k) => k.close);
    const kc = indicators.keltnerChannel(highs, lows, closes, 20, 1.5);
    const kcWidths = kc.width.filter((w) => w != null && Number.isFinite(w));
    const kcMinPct = kcWidths.length ? Math.min(...kcWidths) : 0;

    // 3) upper-TF trend — fetch 30 bars + compute EMA20
    const trendTF = volatilityScanner.TREND_TF_MAP[timeframe] || null;
    let trend = { trendTF, trendEma20: null, trendLastClose: closes[closes.length - 1], trendGapPct: null, trendState: 'warmup' };
    if (trendTF && trendTF !== timeframe) {
      try {
        const rawTrend = await binanceRest.getKlines({
          symbol, interval: trendTF, limit: 30,
        });
        const trendKlines = rawTrend.map((k) => ({
          openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
          low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
          closeTime: k[6],
        }));
        trend = volatilityScanner.computeTrend(trendKlines, trendTF);
      } catch (err) {
        logger.warn({ symbol, timeframe, trendTF, err: err.message }, 'suggest-tp: trend klines fetch failed — using warmup');
      }
    }

    // 4) suggestedTpPct = upper → minKC/4, lower → minKC/8, warmup → null
    // FIX-2026-07-23: ลบ round-trip fee (2*feeRate) ทันที เพราะ user ต้องการเห็นค่า NET ที่จะได้จริงหลังหัก fee
    //   - เช่น raw 0.541% (gross, ก่อน fee) − 0.21% (round-trip) = 0.331% (net, ที่ user ตั้งใน bot.tpPercent)
    //   - trader.calcSellPrice() จะ "+2*feeRate" กลับตอนวาง SELL order → sell target = 0.541% (gross) → net หลัง fee = 0.331%
    //   - feeBufferPct ใช้ fees.getMakerRate() * 2 * 100 — derive จาก config จริง (BNB on → 0.15%, off → 0.2%)
    const feeRate = fees.getMakerRate();
    const feeBufferPct = Number((feeRate * 2 * 100).toFixed(4)); // 0.2 หรือ 0.15
    const rawSuggestedTpPct = trend.trendState === 'warmup' || !kcMinPct
      ? null
      : (trend.trendState === 'upper' ? kcMinPct / 4 : kcMinPct / 8);
    const netSuggestedTpPct = rawSuggestedTpPct == null
      ? null
      : Math.max(0, rawSuggestedTpPct - feeBufferPct);
    // FIX-2026-07-28: auto-floor — ถ้า NET TP < 0.1% → override เป็น 0.111% (single source of truth จาก tpUpdater)
    const floored = tpUpdater.applyMinNetTpFloor(netSuggestedTpPct);
    // FIX-2026-07-23: format TP ให้เป็นทศนิยม 3 ตำแหน่ง โดยหลักพัน (ตำแหน่งที่ 3) ต้องเป็น 1 เสมอ
    //   - floor ทศนิยมที่ 2 แล้ว +0.001 → output อยู่ในรูป x.xx1 เสมอ (หลีกเลี่ยง TP = 0.350 vs 0.351 แล้วเทียบไม่ตรง)
    //   - apply กับ NET value (ที่จะให้ user เห็น/เก็บใน bot.tpPercent)
    const suggestedTpPct = floored.value == null ? null : formatTpToXxx1(floored.value);

    const ms = Date.now() - start;
    logger.info({
      symbol, timeframe, window, trendTF, trendState: trend.trendState,
      kcMinPct, rawSuggestedTpPct, feeBufferPct, netSuggestedTpPct, suggestedTpPct, ms,
      tpOverridden: floored.overridden, rawNetBeforeOverride: floored.rawNetBeforeOverride,
    }, floored.overridden ? 'suggest-tp: done (auto-floor applied)' : 'suggest-tp: done');

    res.json({
      symbol,
      timeframe,
      window,
      trendTF: trend.trendTF,
      trendState: trend.trendState,
      trendGapPct: trend.trendGapPct,
      trendEma20: trend.trendEma20,
      trendLastClose: trend.trendLastClose,
      lastClose: closes[closes.length - 1],
      kcMinPct,
      rawSuggestedTpPct, // gross (ก่อนหัก fee)
      feeBufferPct, // 0.21 (หรือ 0.15 ถ้า BNB on)
      netSuggestedTpPct, // raw net (ก่อน formatTpToXxx1)
      suggestedTpPct, // formatted x.xx1 → ค่าที่ user ควรเก็บใน bot.tpPercent
      // FIX-2026-07-28: surface auto-floor info ให้ UI แสดง tooltip
      tpOverridden: floored.overridden,
      rawNetBeforeOverride: floored.rawNetBeforeOverride,
      ms,
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'suggest-tp failed');
    res.status(500).json({ error: err.message || 'suggest-tp failed' });
  }
});

// ─── GET /api/bots/:id/mini-chart ─────────────────────
// FIX-2026-07-24: mini chart สำหรับ bot list — ข้อมูลครบใน call เดียว
//   - klines (default 30 แท่ง) + keltner (basis/upper/lower) + signals (S1 markers)
//   - tradeMarkers (BUY/SELL markers) จาก Trade collection ภายใน window
//   - ใช้ในหน้า /bots.html วาด lightweight-charts ในแต่ละ enabled bot card (~280x120 px)
router.get('/:id/mini-chart', requireAuth, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id).lean();
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 5), 200);

    const raw = await binanceRest.getKlines({
      symbol: bot.symbol,
      interval: bot.timeframe,
      limit,
    });
    const klines = raw.map((k) => {
      const [openTime, open, high, low, close, volume, closeTime] = k;
      return {
        openTime,
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: parseFloat(volume),
        closeTime,
      };
    });
    if (klines.length === 0) {
      return res.json({ symbol: bot.symbol, timeframe: bot.timeframe, klines: [], keltner: { basis: [], upper: [], lower: [] }, signals: [], tradeMarkers: [] });
    }

    // FIX-2026-07-24: compute KC + S1 signals ตาม per-bot kcMult + s1OnlyDown (default 1.5)
    // FIX-2026-07-25: xs1Enabled (per-bot toggle) — match trader's behavior for scan-volatility preview
    const { signals, basis, upper, lower } = signalEngine.detectS1Signals(klines, {
      mult: bot.kcMult || 1.5,
      onlyDown: !!bot.s1OnlyDown,
      xs1Enabled: bot.xs1Enabled !== false,
    });

    // FIX-2026-07-24: ดึง BUY/SELL markers จาก Trade collection ภายใน window
    //   - เฉพาะ state ที่มีการเทรดจริง (filled/selling/sold — ไม่นับ placed/cancelled/failed)
    //   - ใช้ buyFilledAt + sellFilledAt เป็นเวลา (ถ้ามี)
    const earliestOpenTime = klines[0].openTime;
    const trades = await Trade.find({
      botId: bot._id,
      state: { $in: ['filled', 'selling', 'sold', 'holding', 'stopping'] },
      $or: [
        { buyFilledAt: { $gte: new Date(earliestOpenTime) } },
        { sellFilledAt: { $gte: new Date(earliestOpenTime) } },
      ],
    })
      .sort({ buyFilledAt: 1, sellFilledAt: 1 })
      .limit(200)
      .lean();

    const tradeMarkers = [];
    for (const t of trades) {
      if (t.buyFilledAt && t.buyPrice && !Number.isNaN(t.buyPrice)) {
        tradeMarkers.push({
          time: Math.floor(new Date(t.buyFilledAt).getTime() / 1000),
          position: 'belowBar',
          color: '#22c55e',
          shape: 'arrowUp',
          text: 'B',
        });
      }
      if (t.sellFilledAt && t.sellPrice && !Number.isNaN(t.sellPrice)) {
        tradeMarkers.push({
          time: Math.floor(new Date(t.sellFilledAt).getTime() / 1000),
          position: 'aboveBar',
          color: '#ef4444',
          shape: 'arrowDown',
          text: 'S',
        });
      }
    }
    // lightweight-charts ไม่ยอมรับ 2 markers ที่ time เดียวกัน — sort + dedup by time+shape
    const seen = new Set();
    const dedupMarkers = [];
    for (const m of tradeMarkers.sort((a, b) => a.time - b.time)) {
      const key = `${m.time}-${m.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedupMarkers.push(m);
    }

    res.json({
      symbol: bot.symbol,
      timeframe: bot.timeframe,
      klines,
      keltner: { basis, upper, lower },
      signals,
      tradeMarkers: dedupMarkers,
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'mini-chart failed');
    res.status(500).json({ error: err.message || 'mini-chart failed' });
  }
});

// ─── POST /api/bots/:id/trades/:tradeId/force-close ────
// ปิด 1 trade แบบ manual (cancel SELL + MARKET SELL freeQty, หรือ synthetic close ถ้า asset หายไปแล้ว)
// FIX: bot ไม่ถูก disable — กลับมาทำงานต่อได้ทันทีหลัง force-close
router.post('/:id/trades/:tradeId/force-close', requireAuth, requireBotActionPassword, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const trade = await Trade.findOne({ _id: req.params.tradeId, botId: bot._id });
    if (!trade) return res.status(404).json({ error: 'Trade not found for this bot' });
    if (!forceClose.FORCE_OPEN_STATES.includes(trade.state)) {
      return res.status(400).json({ error: `Trade state is "${trade.state}" — only ${forceClose.FORCE_OPEN_STATES.join('/')} are force-closable` });
    }
    const allowMarketSell = req.body.allowMarketSell !== false; // default true; allow override for cleanup scripts
    const result = await forceClose.forceCloseTrade({ trade, bot, allowMarketSell });
    if (!result.ok) {
      return res.status(502).json({ error: result.error || 'force-close failed', result });
    }
    logger.warn({
      botId: bot._id.toString(),
      tradeId: trade._id.toString(),
      mode: result.mode,
      pnl: result.pnl,
      actorIp: req.ip,
    }, 'force-close trade (API)');
    res.json({ ok: true, result });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'force-close trade failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bots/:id/force-close ────────────────────
// ปิดทุก open trade + disable bot (ใช้เคสบอทค้างหลายไม้)
router.post('/:id/force-close', requireAuth, requireBotActionPassword, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const allowMarketSell = req.body.allowMarketSell !== false;
    const disableBot = req.body.disableBot !== false; // default true
    const result = await forceClose.forceCloseBot({
      botId: bot._id,
      allowMarketSell,
      disableBot,
    });
    logger.warn({
      botId: bot._id.toString(),
      closed: result.closedTrades.length,
      errors: result.errors.length,
      disabled: result.disabled,
      actorIp: req.ip,
    }, 'force-close bot (API)');
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'force-close bot failed');
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
      bot: {
        ...bot,
        totalCapital: (bot.capitalPerTrade || 0) * (bot.maxTrades || 0),
        activeDurationMs: computeActiveDurationMs(bot),
      },
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