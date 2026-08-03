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
const volatilityForBot = require('../../core/volatilityForBot'); // 2026-07-31: per-bot volatility snapshot (KC + TP + 24h vol)
const qualityIndicator = require('../../core/qualityIndicator'); // FIX-2026-08-01: Bot Quality Indicator (0-4 score)
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
    // FIX-2026-07-31: ส่ง symbolInfo map (tickSize/pricePrecision) — client ใช้แทน hardcoded heuristic
    const data = await symbolInfo.listSymbols();
    res.json(data); // { symbols: [...], symbolInfo: { 'BTCUSDT': { tickSize, pricePrecision } } }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bots ────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    // FIX-2026-08-02: ?expand=1 → include volatility snapshot (1.5s) + quality (5s on cold cache)
    //   - default: skip BOTH — compact mode hides the tiles anyway, quality pill shows "—" until warm
    //   - expand mode (user clicks "Expand") → re-fetch with ?expand=1 to populate tiles
    //   - background fetch: /api/bots?quality=1 to warm quality cache without blocking first paint
    const includeVolatility = req.query.expand === '1';
    const includeQuality = req.query.quality === '1' || req.query.expand === '1';
    // FIX-2026-07-24: เรียง enabled ก่อน (true=1 มาก่อน false=0) → บอทที่เปิดอยู่ลอยขึ้นบนสุดอัตโนมัติ
    //   - secondary sort: createdAt desc (บอทใหม่อยู่บนสุดภายใน group)
    const bots = await Bot.find().sort({ enabled: -1, createdAt: -1 }).lean();
    // FIX-2026-08-02: run aggregations in parallel (independent)
    const [todayMap, monthMap, activePosMap] = await Promise.all([
      aggregateTodayPerBot(),
      aggregateMonthPerBot(),
      aggregateActivePositionsPerBot(),
    ]);
    // 2026-07-31: per-bot volatility snapshot (KC min + TP suggestion + 24h volume)
    //   - reuse tpUpdater.computeSuggestedTpForBot + get24hrTickers ผ่าน volatilityForBot helper
    //   - concurrency-6 กัน burst (Binance public weight limit)
    //   - FIX-2026-08-02: only when ?expand=1 (default = skip for fast first paint)
    const volSnapshots = includeVolatility
      ? await volatilityForBot.mapWithConcurrency(
          bots, 6, (b) => volatilityForBot.computeBotVolatilitySnapshot(b)
        )
      : bots.map(() => ({}));
    // FIX-2026-08-01: Bot Quality Indicator — 0-4 score per bot (shared top-N + per-bot cache)
    // FIX-2026-08-02: skip on cold default load (5s) — cache warm = 0ms anyway
    //   - cached values still returned (server reads perBotCache before returning)
    //   - explicit ?quality=1 forces full compute
    const qualitySnaps = includeQuality
      ? await qualityIndicator.computeBotsQuality(bots)
      : bots.map((b) => qualityIndicator.getCachedOnly(b) || {});
    // เพิ่ม totalCapital virtual + today/month stats + price/EMA indicator + volatility snapshot
    const enriched = bots.map((b, idx) => {
      const t = todayMap.get(String(b._id)) || { todayTrades: 0, todayPnl: 0 };
      const m = monthMap.get(String(b._id)) || { monthTrades: 0, monthPnl: 0 };
      const indicator = computeBotIndicator(b);
      const vol = volSnapshots[idx] || {};
      const q = qualitySnaps[idx] || {};
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
        // 2026-07-31: volatility snapshot (for expand-mode tiles)
        volKcMinPct: vol.kcMinPct ?? null,
        volKcMinPctDisplay: vol.kcMinPctDisplay ?? null,
        volSuggestedTpPct: vol.suggestedTpPct ?? null,
        volTrendState: vol.trendState ?? null,
        volTrendTF: vol.trendTF ?? null,
        volTpOverridden: !!vol.tpOverridden,
        volRawSuggestedTpPct: vol.rawSuggestedTpPct ?? null,
        volFeeBufferPct: vol.feeBufferPct ?? null,
        volQuoteVolume24h: vol.quoteVolume24h ?? null,
        volQuoteVolume24hDisplay: vol.quoteVolume24hDisplay ?? null,
        volOk: !!vol.ok,
        volError: vol.error || null,
        volCached: !!vol.cached,
        volMs: vol.ms ?? null,
        // FIX-2026-08-01: Bot Quality Indicator flat fields (mirror vol* pattern)
        qualityScore: q.score ?? null,
        qualityColor: q.color || 'gray',
        qualityUpdatedAt: q.updatedAt || null,
        qualityCached: !!q.cached,
        qualityEnabled: q.enabled !== false,
      };
    });
    res.json({ bots: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bots/positions ───────────────────────────
// 2026-07-30: Aggregate ALL open positions across every bot
//   - filter by 7-state open set (ตรงกับ aggregateActivePositionsPerBot() ที่ line 107)
//   - enrich ด้วย bot name + retryMax + currentPrice จาก klineCache
//   - return { asOf, count, totalCostUsdt, totalUnrealizedUsdt, positions: [...] }
//   ใช้ในหน้า /bots.html สำหรับ Open Positions tile + modal รายละเอียด
// IMPORTANT: declare BEFORE /:id route เพื่อหลีกเลี่ยง Express match "positions" เป็น id
const OPEN_POSITIONS_STATES_FOR_API = ['placed', 'partial_wait', 'filled', 'retrying', 'holding', 'selling', 'stopping'];

router.get('/positions', requireAuth, async (req, res) => {
  try {
    // FIX-2026-08-03: ?fresh=1 — bypass klineCache (in-memory, may be stale when WS dropped)
    //   and fetch latest bookTicker per unique symbol directly from Binance REST.
    //   ใช้ตอน user กดปุ่ม Refresh ใน Open Positions modal (หน้า /bots.html)
    //   - ลด impact: ใช้ bookTicker (weight=2/symbol) แทน get24hr (weight=2/symbol) → same weight
    //   - dedupe by symbol → 1 Binance call ต่อ symbol ไม่ใช่ต่อ position
    //   - เก็บ fresh price ใน Map<symbol, midPrice> แล้วใช้แทน klineCache snapshot
    const freshMode = req.query.fresh === '1' || req.query.fresh === 'true';
    let freshPriceMap = null;
    if (freshMode) {
      freshPriceMap = new Map();
    }
    const trades = await Trade.find({ state: { $in: OPEN_POSITIONS_STATES_FOR_API } })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    if (trades.length === 0) {
      return res.json({ asOf: new Date().toISOString(), count: 0, totalCostUsdt: 0, totalUnrealizedUsdt: 0, positions: [] });
    }
    const botIds = [...new Set(trades.map((t) => String(t.botId)))];
    const bots = await Bot.find({ _id: { $in: botIds } }).select('_id name symbol timeframe retryMax').lean();
    const botMap = new Map(bots.map((b) => [String(b._id), b]));

    // FIX-2026-08-03: fetch fresh bookTicker per unique symbol (Promise.all — parallel)
    //   - ใช้ midPrice = (bidPrice + askPrice) / 2 (bookTicker ไม่มี lastPrice)
    //   - ถ้า fetch fail → ใช้ klineCache fallback (เดิม) → PnL ไม่พัง
    //   - mark freshFailedSymbols ใน response เพื่อ UI แสดง warning ถ้าจำเป็น
    let freshFailedSymbols = [];
    if (freshMode) {
      const uniqueSymbols = [...new Set(trades.map((t) => t.symbol))];
      const settled = await Promise.allSettled(
        uniqueSymbols.map(async (sym) => {
          const ticker = await binanceRest.getBookTicker(sym);
          const bid = parseFloat(ticker.bidPrice);
          const ask = parseFloat(ticker.askPrice);
          if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
            throw new Error(`bookTicker invalid for ${sym}`);
          }
          return { sym, midPrice: (bid + ask) / 2 };
        })
      );
      for (let i = 0; i < settled.length; i += 1) {
        const s = settled[i];
        const sym = uniqueSymbols[i];
        if (s.status === 'fulfilled' && s.value && Number.isFinite(s.value.midPrice)) {
          freshPriceMap.set(sym, s.value.midPrice);
        } else {
          freshFailedSymbols.push(sym);
          logger.warn({ symbol: sym, err: s.reason && s.reason.message }, 'positions ?fresh=1 — bookTicker fetch failed, will fallback to klineCache');
        }
      }
    }

    const positions = trades.map((t) => {
      const bot = botMap.get(String(t.botId)) || {};
      // price resolution priority:
      //   1. freshMode + freshPriceMap → midPrice from Binance bookTicker (authoritative)
      //   2. klineCache.getCurrent() → WS kline (fast but may be stale)
      //   3. buyPrice fallback (PnL = 0)
      let currentPrice = 0;
      let priceSource = 'klineCache';
      if (freshMode && freshPriceMap && freshPriceMap.has(t.symbol)) {
        currentPrice = freshPriceMap.get(t.symbol);
        priceSource = 'binance-bookTicker';
      } else {
        const current = klineCache.getCurrent(t.symbol, t.timeframe);
        currentPrice = current ? parseFloat(current.close) : (Number(t.buyPrice) || 0);
        priceSource = current ? 'klineCache' : 'buyPrice';
      }
      const qty = Number(t.buyQty) || 0;
      const entry = Number(t.buyPrice) || 0;
      const cost = Number(t.buyQuoteQty) || (entry * qty);
      const unrealizedUsdt = (currentPrice - entry) * qty;
      return {
        tradeId: String(t._id),
        botId: String(t.botId),
        botName: bot.name || bot.symbol || '',
        symbol: t.symbol,
        timeframe: t.timeframe,
        state: t.state,
        buyOrderId: t.buyOrderId,
        buyPrice: t.buyPrice,
        buyQty: t.buyQty,
        buyQuoteQty: t.buyQuoteQty,
        buyFilledAt: t.buyFilledAt,
        buyPlacedAt: t.buyPlacedAt,
        targetSellPrice: t.targetSellPrice,
        sellOrderId: t.sellOrderId,
        retryCount: t.retryCount ?? 0,
        botRetryMax: bot.retryMax ?? 1,
        error: t.error || '',
        // FIX-2026-08-01: SL-armed flags (F1) — exposed for position card badge (🛡️ Au)
        //   - useStopLossOnUKC=true = trader._autoArmStopLossOnUKC armed (loss>10% + age>4h)
        //   - autoArmedAt = timestamp when armed (audit)
        useStopLossOnUKC: t.useStopLossOnUKC === true,
        autoArmedAt: t.autoArmedAt || null,
        createdAt: t.createdAt,
        currentPrice,
        priceSource, // FIX-2026-08-03: 'binance-bookTicker' | 'klineCache' | 'buyPrice' — exposed for UI badge
        _costUsdt: cost,
        _unrealizedUsdt: unrealizedUsdt,
      };
    });
    const totalCost = positions.reduce((s, p) => s + (p._costUsdt || 0), 0);
    const totalUnrealized = positions.reduce((s, p) => s + (p._unrealizedUsdt || 0), 0);
    res.json({
      asOf: new Date().toISOString(),
      count: positions.length,
      totalCostUsdt: totalCost,
      totalUnrealizedUsdt: totalUnrealized,
      // FIX-2026-08-03: ?fresh=1 metadata — UI ใช้แสดง badge "Binance" vs "cache"
      fresh: freshMode,
      priceSources: {
        binance: positions.filter((p) => p.priceSource === 'binance-bookTicker').length,
        klineCache: positions.filter((p) => p.priceSource === 'klineCache').length,
        buyPrice: positions.filter((p) => p.priceSource === 'buyPrice').length,
      },
      freshFailedSymbols,
      positions: positions.map(({ _costUsdt, _unrealizedUsdt, ...p }) => p),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'list open positions failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bots/:id ────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id).lean();
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const indicator = computeBotIndicator(bot);
    // FIX-2026-08-01: enrich with Bot Quality Indicator fields (mirror vol* pattern)
    let q = {};
    try {
      q = await qualityIndicator.computeBotQuality(bot);
    } catch (qErr) {
      logger.warn({ botId: String(bot._id), err: qErr.message }, 'bot: qualityIndicator.computeBotQuality failed (non-fatal)');
    }
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
        // FIX-2026-08-01: Bot Quality Indicator flat fields
        qualityScore: q.score ?? null,
        qualityColor: q.color || 'gray',
        qualityUpdatedAt: q.updatedAt || null,
        qualityCached: !!q.cached,
        qualityEnabled: q.enabled !== false,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bots/:id/quality ────────────────────────
// FIX-2026-08-01: full breakdown for the Quality Indicator modal
//   - 4 criteria details (value + threshold + pass + extras)
//   - works even when enabled=false (returns enabled:false, breakdown:null)
//   - ไม่ผ่าน per-bot cache (modal ต้องการข้อมูลสด — bypass TTL by using computeBotQuality)
//     (computeBotQuality เองใช้ cache 5min; modal เปิดเร็วๆนี้จะได้ cache hit ตามธรรมชาติ)
router.get('/:id/quality', requireAuth, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id).lean();
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const q = await qualityIndicator.computeBotQuality(bot);
    res.json({
      botId: String(bot._id),
      symbol: bot.symbol,
      timeframe: bot.timeframe,
      enabled: q.enabled,
      score: q.score,
      color: q.color,
      updatedAt: q.updatedAt,
      cached: q.cached,
      breakdown: q.breakdown || null,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'GET /api/bots/:id/quality failed');
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

    // FIX-2026-08-03: validate Martingale requires DCA mode (Martingale เป็น DCA-only strategy)
    //   - ป้องกัน Martingale ถูกเปิดโดยไม่ตั้งใจ (e.g. client bug, manual API call)
    //   - reject early ก่อน Bot.create เพื่อไม่ให้เกิด bot doc ครึ่งๆ
    if (data.martingaleEnabled === true && data.dcaEnabled !== true) {
      return res.status(400).json({
        error: 'martingaleEnabled requires dcaEnabled=true (Martingale is a DCA-mode-only strategy)',
      });
    }

    const bot = await Bot.create({
      name: data.name || `${symbol} ${timeframe}`,
      symbol,
      timeframe,
      capitalPerTrade: parseFloat(data.capitalPerTrade ?? defaults.capitalPerTrade),
      maxTrades: parseInt(data.maxTrades ?? defaults.maxTrades, 10),
      tpPercent: parseFloat(data.tpPercent ?? defaults.tpPercent),
      // FIX-2026-08-02: DCA + BEP stack mode (opt-in, default off — backward compatible)
      //   - false (default) → พฤติกรรมเดิม 1 BUY → 1 SELL (no change)
      //   - true → 1 บอท = 1 open DCA stack, S1 แต่ละครั้งจะเพิ่ม layer เข้า stack
      //   - dcaMaxLayers: จำนวน layer สูงสุด (default 3, range 1-100)
      dcaEnabled: data.dcaEnabled === true,
      dcaMaxLayers: Math.min(100, Math.max(1, parseInt(data.dcaMaxLayers ?? 3, 10))),
      // FIX-2026-08-03: DCA + Martingale sizing (opt-in, default off — backward compatible 100%)
      //   - martingaleEnabled requires dcaEnabled=true (validated below)
      //   - layer N notional = capitalPerTrade × mult^(N-1), capped by martingaleMaxLayerNotional
      //   - ปลอดภัย: ไม่มีบอทไหนถูกบังคับ Martingale อัตโนมัติ
      martingaleEnabled: data.martingaleEnabled === true,
      martingaleMultiplier: Math.min(3, Math.max(1, parseFloat(data.martingaleMultiplier ?? 1.5))),
      martingaleMaxLayerNotional: Math.min(10000, Math.max(1, parseFloat(data.martingaleMaxLayerNotional ?? 100))),
      // FIX-2026-07-24: parseFloat เพื่อรองรับทศนิยม (0.5 = 30 วินาที)
      // FIX-2026-07-25: clamp 0.1..60 ตาม schema (mirror PUT route)
      retryTimeMin: Math.min(60, Math.max(0.1, parseFloat(data.retryTimeMin ?? defaults.retryTimeMin))),
      retryMax: parseInt(data.retryMax ?? 1, 10),
      // FIX-2026-07-24: kcMult validation — clamp 0.5..5 (default 1.5)
      kcMult: Math.min(5, Math.max(0.5, parseFloat(data.kcMult ?? 1.5))),
      // FIX-2026-07-24: minSpreadTicks (0..10, default 1) — per-bot spread tolerance
      minSpreadTicks: Math.min(10, Math.max(0, parseInt(data.minSpreadTicks ?? 1, 10))),
      // FIX-2026-07-25: suggestTpWindow (30..1000, default 500) — bars for Min %KC calc
      suggestTpWindow: Math.min(1000, Math.max(30, parseInt(data.suggestTpWindow ?? 500, 10))),
      // FIX-2026-07-24: s1OnlyDown (default false) — skip bg 2→1 (ซื้อตอนราคาสูง)
      s1OnlyDown: data.s1OnlyDown === true,
      // FIX-2026-07-25: xs1Enabled (default true) — per-bot XS1 anti-dump gate toggle
      //   - true (default): skip S1 เมื่อ candle-wide dump pattern
      //   - false: ใช้สัญญาณดั้งเดิม (ไม่ skip)
      xs1Enabled: data.xs1Enabled !== false,
      // FIX-2026-08-01: cbEnabled (default true) — per-bot Circuit-breaker (CB) panic-sell toggle — เดิมชื่อ sls1Enabled
      //   - true (default): panic-close ALL positions เมื่อ 3 แท่งติด close<lowerKC + open<lowerKC + แดง
      //   - false: ไม่ panic-close (เสี่ยงขาดทุนต่อถ้ากราฟไหล)
      cbEnabled: data.cbEnabled !== false,
      // FIX-2026-08-01: safeTradeEnabled (default true) — per-bot safe-trade filter toggle
      //   - true (default): ก่อนวาง BUY ให้เช็ค super-upper TF (4h/1d/1w ตาม bot TF) ว่าเป็นแท่งเขียว/เหนือ EMA20
      //   - false: ซื้อทันที (พฤติกรรมเดิม)
      safeTradeEnabled: data.safeTradeEnabled !== false,
      // FIX-2026-08-01: autoPauseEnabled (default true) — per-bot auto-pause on low Min-%KC toggle
      //   - true (default): ทุก 5 min ตรวจ Min-%KC(30 bars) — ถ้า < autoPauseMinKcPct → set enabled=false + auto-resume เมื่อกลับมา
      //   - false: ไม่ตรวจ (พฤติกรรมเดิม)
      autoPauseEnabled: data.autoPauseEnabled !== false,
      autoPauseMinKcPct: Math.min(50, Math.max(0.1, parseFloat(data.autoPauseMinKcPct ?? 2))),
      // FIX-2026-07-31: autoArmStopLossOnUKC (default true) — per-bot auto-arm SL-on-UKC toggle
      //   - true (default): auto-arm trade.useStopLossOnUKC=true เมื่อ position loss >10% + age >4h
      //   - false: ไม่ auto-arm (SL-on-UKC จะไม่ trigger แม้ bot.stopLossOnUpperKC=true)
      autoArmStopLossOnUKC: data.autoArmStopLossOnUKC !== false,
      // FIX-2026-07-31: tpTrendMultiplier (default 2, clamp 1..10) — TP ×N when upper-TF trend=upper
      //   - 1 = off (no multiplier)
      //   - 2 = double (default: 0.2% → 0.4%)
      tpTrendMultiplier: Math.min(10, Math.max(1, parseFloat(data.tpTrendMultiplier ?? 2))),
      // FIX-2026-08-01: tpTrendEnabled (per-bot toggle, default true)
      //   - true → คูณ tpPercent ด้วย tpTrendMultiplier เมื่อ upper-TF trend=upper
      //   - false → ใช้ tpPercent ตรงๆ (ไม่สนใจ trend)
      tpTrendEnabled: data.tpTrendEnabled !== false,
      stopLossOnUpperKC: data.stopLossOnUpperKC === true, // FIX-2026-07-23: stop-loss toggle
      autoUpdateTp: data.autoUpdateTp === true, // FIX-2026-07-23: TP auto-update toggle
      // FIX-2026-07-31: รับ enabled จาก client — ถ้า true → enable ทันทีหลัง create
      //   - default: false (เดิม) — preserve current behavior
      //   - enabled: true ถ้า client ส่ง data.enabled === true (atomic create+enable ใน 1 round-trip)
      enabled: data.enabled === true,
      status: data.enabled === true ? 'starting' : 'idle',
    });

    // FIX-2026-07-31: atomic auto-enable — ถ้า enabled=true ให้เริ่มเทรดทันที
    //   - ต้อง await enableBot เพื่อให้แน่ใจว่า trader spawn สำเร็จก่อนตอบ response
    //   - ถ้า enable ล้มเหลว → คืน 201 + warning (bot ถูกสร้างแล้ว แต่ยังไม่ได้ enable)
    if (data.enabled === true) {
      try {
        const enabledBot = await botManager.enableBot(bot._id);
        return res.status(201).json({ bot: enabledBot, autoEnabled: true });
      } catch (err) {
        logger.warn({ botId: String(bot._id), err: err.message }, 'create bot: auto-enable failed (bot saved but trader not started)');
        return res.status(201).json({
          bot,
          autoEnabled: false,
          autoEnableError: err.message,
        });
      }
    }

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
    const allowed = ['name', 'capitalPerTrade', 'maxTrades', 'tpPercent', 'retryTimeMin', 'retryMax', 'timeframe', 'stopLossOnUpperKC', 'autoUpdateTp', 'kcMult', 'minSpreadTicks', 's1OnlyDown', 'xs1Enabled', 'cbEnabled', 'safeTradeEnabled', 'autoPauseEnabled', 'autoPauseMinKcPct', 'suggestTpWindow', 'autoArmStopLossOnUKC', 'tpTrendMultiplier', 'tpTrendEnabled', 'dcaEnabled', 'dcaMaxLayers', 'martingaleEnabled', 'martingaleMultiplier', 'martingaleMaxLayerNotional'];

    for (const k of allowed) {
      if (data[k] !== undefined) {
        if (k === 'capitalPerTrade' || k === 'tpPercent' || k === 'kcMult') {
          bot[k] = parseFloat(data[k]);
        } else if (k === 'tpTrendMultiplier') {
          // FIX-2026-07-31 (F2): TP ×N multiplier clamp 1..10
          bot[k] = Math.min(10, Math.max(1, parseFloat(data[k])));
        } else if (k === 'tpTrendEnabled') {
          // FIX-2026-08-01: per-bot toggle for TP trend multiplier (default true)
          bot[k] = data[k] === true || data[k] === 'true';
        } else if (k === 'dcaEnabled') {
          // FIX-2026-08-02: DCA mode toggle (default false = backward compatible)
          //   - ไม่ rewrite open trade (existing ใช้ trade.isDcaStack เป็น defensive signal)
          bot[k] = data[k] === true || data[k] === 'true';
        } else if (k === 'dcaMaxLayers') {
          // FIX-2026-08-02: DCA max layers (1-100, integer)
          bot[k] = Math.min(100, Math.max(1, parseInt(data[k], 10)));
        } else if (k === 'martingaleEnabled') {
          // FIX-2026-08-03: DCA + Martingale toggle (default false — backward compat 100%)
          bot[k] = data[k] === true || data[k] === 'true';
        } else if (k === 'martingaleMultiplier') {
          // FIX-2026-08-03: Martingale multiplier (1.0..3.0, default 1.5)
          bot[k] = Math.min(3, Math.max(1, parseFloat(data[k])));
        } else if (k === 'martingaleMaxLayerNotional') {
          // FIX-2026-08-03: Martingale per-layer notional cap (1..10000 USDT, default 100)
          bot[k] = Math.min(10000, Math.max(1, parseFloat(data[k])));
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

    // FIX-2026-08-03: Martingale requires DCA (post-merge check — effective state after this PUT)
    //   - effectiveMartingale = data.martingaleEnabled ?? existing martingaleEnabled
    //   - effectiveDca = data.dcaEnabled ?? existing dcaEnabled
    //   - reject ถ้าจะเปิด Martingale แต่ DCA ปิด (ทั้งกรณี enable ใหม่ + กรณี DCA ถูก disable แต่ลืม Martingale)
    const effectiveDca = data.dcaEnabled !== undefined ? (data.dcaEnabled === true || data.dcaEnabled === 'true') : bot.dcaEnabled === true;
    const effectiveMartingale = data.martingaleEnabled !== undefined ? (data.martingaleEnabled === true || data.martingaleEnabled === 'true') : bot.martingaleEnabled === true;
    if (effectiveMartingale && !effectiveDca) {
      return res.status(400).json({
        error: 'martingaleEnabled requires dcaEnabled=true (Martingale is a DCA-mode-only strategy)',
      });
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

    // 2026-07-31: invalidate per-bot volatility snapshot cache เมื่อ timeframe / suggestTpWindow เปลี่ยน
    //   - ของเดิม: cache key รวม timeframe+window → ถ้าแก้แล้ว key เปลี่ยน entry เก่าจะถูกทิ้งเองตอน TTL expire
    //   - เรียก invalidate เพื่อล้างทันที ลด confusion ตอน user แก้ window แล้วอยากเห็นค่าใหม่ทันที
    if (data.timeframe !== undefined || data.suggestTpWindow !== undefined) {
      try {
        volatilityForBot.invalidate(bot.symbol, bot.timeframe);
      } catch (_) { /* non-fatal */ }
    }

    // FIX-2026-08-01: invalidate per-bot Quality Indicator cache เมื่อ timeframe เปลี่ยน
    //   - kcMult / s1OnlyDown / xs1Enabled / cbEnabled changes ก็ควร recompute — แต่ใช้ key เดิม (symbol+tf)
    //     ดังนั้น invalidate แค่ครั้งเดียวตอน PUT พอ (next compute จะอ่าน bot.kcMult ใหม่)
    if (data.timeframe !== undefined || data.kcMult !== undefined) {
      try {
        qualityIndicator.invalidate(bot.symbol, bot.timeframe);
      } catch (_) { /* non-fatal */ }
    }

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

// ─── POST /api/bots/:id/clear-warning ──────────────────
// FIX-2026-08-01: ผู้ใช้กด × ปิด warning banner (1h latched alert) ได้เอง
//   - clear warning + warningAt fields ใน DB
//   - ไม่เปลี่ยน bot.status (warning = informational overlay, ไม่ใช่ error state)
//   - ส่ง bot:updated WS event เพื่อให้ dashboard refresh
router.post('/:id/clear-warning', requireAuth, async (req, res) => {
  try {
    const upd = await Bot.updateOne(
      { _id: req.params.id },
      { $set: { warning: '', warningAt: null } }
    );
    if (upd.matchedCount === 0) return res.status(404).json({ error: 'Bot not found' });
    const bot = await Bot.findById(req.params.id).lean();
    eventBus.emit('bot:updated', { botId: req.params.id });
    logger.info({ botId: req.params.id.toString() }, 'bot: clear-warning — warning cleared by user');
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
    // FIX-2026-08-02: auto-floor — ถ้า NET TP < 0.281% → override เป็น 0.281% (single source of truth จาก tpUpdater)
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

// FIX-2026-08-01: Master Config — bulk-update หลายบอทพร้อมกัน (clobber mode per user choice)
//   - body: { botIds: [string], settings: { ... } }
//   - apply fields ทั้งหมดใน settings ไปยังทุกบอทที่เลือก (whitelist)
//   - invalidate cache + emit bot:updated สำหรับแต่ละบอท
router.post('/bulk-update', requireAuth, async (req, res) => {
  try {
    const { botIds, settings } = req.body || {};
    if (!Array.isArray(botIds) || botIds.length === 0) {
      return res.status(400).json({ error: 'botIds must be a non-empty array' });
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ error: 'settings must be an object' });
    }
    const allowed = [
      'capitalPerTrade', 'maxTrades', 'tpPercent', 'retryTimeMin', 'retryMax',
      'timeframe', 'stopLossOnUpperKC', 'autoUpdateTp', 'kcMult', 'minSpreadTicks',
      's1OnlyDown', 'xs1Enabled', 'cbEnabled', 'safeTradeEnabled',
      'autoPauseEnabled', 'autoPauseMinKcPct',
      'suggestTpWindow', 'autoArmStopLossOnUKC', 'tpTrendMultiplier', 'tpTrendEnabled',
      'dcaEnabled', 'dcaMaxLayers',
      // FIX-2026-08-03: Martingale fields (Master Config support)
      'martingaleEnabled', 'martingaleMultiplier', 'martingaleMaxLayerNotional',
    ];
    const update = {};
    for (const k of allowed) {
      if (k in settings) update[k] = settings[k];
    }
    if (Number.isFinite(update.autoPauseMinKcPct)) update.autoPauseMinKcPct = Math.max(0.1, Math.min(50, update.autoPauseMinKcPct));
    if (Number.isFinite(update.tpPercent)) update.tpPercent = Math.max(0.1, Math.min(100, update.tpPercent));
    if (Number.isFinite(update.kcMult)) update.kcMult = Math.max(0.5, Math.min(5, update.kcMult));
    if (Number.isFinite(update.capitalPerTrade)) update.capitalPerTrade = Math.max(0.00000001, update.capitalPerTrade);
    // FIX-2026-08-02: DCA field validation
    if ('dcaEnabled' in update) update.dcaEnabled = update.dcaEnabled === true || update.dcaEnabled === 'true';
    if (Number.isFinite(update.dcaMaxLayers)) update.dcaMaxLayers = Math.max(1, Math.min(100, Math.floor(update.dcaMaxLayers)));
    // FIX-2026-08-03: Martingale field validation
    if ('martingaleEnabled' in update) update.martingaleEnabled = update.martingaleEnabled === true || update.martingaleEnabled === 'true';
    if (Number.isFinite(update.martingaleMultiplier)) update.martingaleMultiplier = Math.max(1, Math.min(3, update.martingaleMultiplier));
    if (Number.isFinite(update.martingaleMaxLayerNotional)) update.martingaleMaxLayerNotional = Math.max(1, Math.min(10000, update.martingaleMaxLayerNotional));

    // FIX-2026-08-03: bulk-update Martingale-requires-DCA validation
    //   - bulk mode applies same settings to many bots — must check that after merge,
    //     no bot ends up with martingaleEnabled=true but dcaEnabled!=true
    //   - easiest check: if Martingale is on in update, DCA must also be on in update (or pre-existing)
    //     → for simplicity, we require both to be set together (user-friendly fail-fast)
    if (update.martingaleEnabled === true && update.dcaEnabled !== true) {
      return res.status(400).json({
        error: 'martingaleEnabled requires dcaEnabled=true in the same bulk-update (Martingale is DCA-only)',
      });
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'no valid fields in settings' });
    }

    // FIX-2026-08-02: validate timeframe against Binance-allowed intervals (fail-fast)
    //   - trading ใน chart.routes.js ใช้ config.binanceIntervals whitelist เดียวกัน
    if ('timeframe' in update && !config.binanceIntervals.includes(update.timeframe)) {
      return res.status(400).json({ error: `Invalid timeframe: ${update.timeframe}. Allowed: ${config.binanceIntervals.join(', ')}` });
    }

    // FIX-2026-08-02: snapshot before-state เพื่อ detect TF change → trader restart
    //   - เก็บ _id/symbol/timeframe/enabled ของแต่ละบอท (ก่อน update)
    //   - ใช้ตอน post-update เพื่อตัดสินใจว่าบอทไหนต้อง stopTrader/spawnTrader ใหม่
    const tfChangeBotIds = [];
    if ('timeframe' in update) {
      const before = await Bot.find({ _id: { $in: botIds } }).select('_id symbol timeframe enabled').lean();
      for (const b of before) {
        if (b.timeframe !== update.timeframe && b.enabled !== false) {
          tfChangeBotIds.push(String(b._id));
        }
      }
    }

    const result = await Bot.updateMany({ _id: { $in: botIds } }, { $set: update });

    // FIX-2026-08-02: restart trader สำหรับบอทที่ TF เปลี่ยนจริง + ยัง enabled
    //   - trader caches interval ใน kline subscription + indicator cache ตอน spawn
    //     → ถ้าไม่ restart, bot:updated จะ refresh this.bot.timeframe แต่ logic ยังใช้ TF เก่า
    //   - stopTrader + spawnTrader sequentially ต่อบอท กัน race กับ in-flight signal
    let traderRestarts = 0;
    const restartErrors = [];
    for (const id of tfChangeBotIds) {
      try {
        await botManager.stopTrader(id);
        const fresh = await Bot.findById(id);
        if (!fresh) continue;
        await botManager.spawnTrader(fresh);
        traderRestarts += 1;
      } catch (err) {
        restartErrors.push({ botId: id, err: err.message });
        logger.warn({ botId: id, err: err.message }, 'bulk-update: trader restart failed after TF change');
      }
    }
    if (restartErrors.length > 0) {
      logger.warn({ count: restartErrors.length, errors: restartErrors }, 'bulk-update: some trader restarts failed');
    }

    for (const id of botIds) {
      try { eventBus.emit('bot:updated', { botId: String(id) }); } catch (_) {}
      try {
        const b = await Bot.findById(id).lean();
        if (b) {
          volatilityForBot.invalidate(b.symbol, b.timeframe);
          qualityIndicator.invalidate(b.symbol, b.timeframe);
        }
      } catch (_) {}
    }
    logger.info({
      botIds: botIds.length,
      modified: result.modifiedCount,
      fields: Object.keys(update),
      traderRestarts,
    }, 'bots: bulk-update applied');
    res.json({
      ok: true,
      modified: result.modifiedCount,
      fields: Object.keys(update),
      traderRestarts,
      traderRestartErrors: restartErrors,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'bot bulk-update failed');
    res.status(500).json({ error: err.message });
  }
});

// FIX-2026-08-02: admin — invalidate volatilityForBot cache (60s TTL force-expired)
//   - ใช้เมื่อเปลี่ยน TP-fork constants หรือ floor config (cache เก็บค่าเก่า)
//   - ไม่ต้องการ body — clear ทั้งหมด
//   - requireBotActionPassword เพราะเป็น admin-level action (ไม่ใช่ user-flow)
router.post('/invalidate-volatility-cache', requireAuth, requireBotActionPassword, async (req, res) => {
  try {
    let cleared = false;
    if (typeof volatilityForBot._resetCache === 'function') {
      volatilityForBot._resetCache();
      cleared = true;
    }
    logger.info('admin: volatilityForBot cache invalidated');
    res.json({ ok: true, cleared });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FIX-2026-08-02: Master Config — bulk enable/disable (lifecycle action)
//   - แยกจาก /bulk-update เพราะเป็น lifecycle action (ต้องใช้ BOT_ACTION_PASSWORD)
//   - body: { botIds: [string], action: 'enable' | 'disable', password?: string }
//   - แต่ละ bot ผ่าน botManager.enableBot/disableBot (DB + spawn/stop trader + emit events)
//   - response: { ok: true, action, results: [{ botId, ok, error? }], succeeded, failed }
router.post('/bulk-toggle', requireAuth, requireBotActionPassword, async (req, res) => {
  try {
    const { botIds, action } = req.body || {};
    if (!Array.isArray(botIds) || botIds.length === 0) {
      return res.status(400).json({ error: 'botIds must be a non-empty array' });
    }
    if (action !== 'enable' && action !== 'disable') {
      return res.status(400).json({ error: "action must be 'enable' or 'disable'" });
    }
    // cap เพื่อกัน DoS (operator error กด select all + 50 บอท = race risk)
    if (botIds.length > 100) {
      return res.status(400).json({ error: 'botIds must be <= 100 per request' });
    }

    const results = [];
    let succeeded = 0;
    let failed = 0;
    // รัน sequentially เพื่อไม่ให้ trader spawn/in-flight log ปนกัน + กัน Binance weight spike
    for (const id of botIds) {
      try {
        const bot = action === 'enable'
          ? await botManager.enableBot(id)
          : await botManager.disableBot(id);
        results.push({ botId: String(id), ok: true, name: bot.name || bot.symbol });
        succeeded += 1;
      } catch (err) {
        results.push({ botId: String(id), ok: false, error: err.message });
        failed += 1;
      }
    }

    // FIX-2026-08-02: invalidate caches ของทุกบอทที่สำเร็จ (เผื่อ action ในอนาคตมี config-affecting effects)
    for (const r of results) {
      if (r.ok) {
        try {
          const b = await Bot.findById(r.botId).lean();
          if (b) {
            volatilityForBot.invalidate(b.symbol, b.timeframe);
            qualityIndicator.invalidate(b.symbol, b.timeframe);
          }
        } catch (_) { /* ignore — non-fatal */ }
      }
    }

    logger.info({
      action,
      requested: botIds.length,
      succeeded,
      failed,
    }, 'bots: bulk-toggle applied');
    res.json({ ok: true, action, succeeded, failed, results });
  } catch (err) {
    logger.error({ err: err.message }, 'bot bulk-toggle failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// FIX-2026-08-01: start Bot Quality Indicator refresh loop at module load
//   - เรียก init() ตอน Express require ไฟล์นี้ (=ตอน server start)
//   - refreshMs/qualityEnabled/thresholds มาจาก AppConfig (reload-able via PUT /config)
qualityIndicator.init().catch((err) => logger.error({ err: err.message }, 'qualityIndicator.init failed at startup'));