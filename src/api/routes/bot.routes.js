'use strict';

const express = require('express');
// FIX-2026-08-24 (P1 audit): bulk operations stagger — must match botManager.SPAWN_STAGGER_MS
const SPAWN_STAGGER_MS = 300;
const { requireAuth, requireAuthOrLicenseKey } = require('../middleware/auth');
const Bot = require('../../db/models/Bot');
const Trade = require('../../db/models/Trade');
const config = require('../../../config');
const { getBotDefaults, buildBotCreatePayload } = require('../../services/botDefaults'); // FIX-2026-08-09: share defaults source with autoAddBot
const licenseService = require('../../services/licenseService'); // FIX-2026-08-27 Phase 3b-1: pass tier to buildBotCreatePayload
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
const trendlineForBot = require('../../core/trendlineForBot'); // FIX-2026-08-03: Safe-trade #2 (trendline) live status for bot card badge
const prediction = require('../../core/prediction'); // FIX-2026-08-05: upper-KC + predicted loss for AU prediction panel
const dps = require('../../core/dynamicPositionSizing'); // FIX-2026-08-08 (rev2): DPS state reset helper
const tradeStats = require('../../core/tradeStats'); // FIX-2026-08-20: aggregate today/month/all-time per bot (extracted for testability)
const fxService = require('../../services/fxService'); // FIX-2026-08-26: per-position unrealized PnL THB (for machine-detail + admin machines view)
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

const { requireBotActionPassword } = require('../middleware/auth');

const router = express.Router();

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
    // FIX-2026-08-02: ?expand=1 → include volatility snapshot (1.5s)
    //   - default: skip — compact mode hides the tiles anyway
    //   - expand mode (user clicks "Expand") → re-fetch with ?expand=1 to populate tiles
    const includeVolatility = req.query.expand === '1';
    // FIX-2026-08-08: Feature #5 — exclude soft-deleted bots by default; ?includeDeleted=1 to show them
    const includeDeleted = req.query.includeDeleted === '1';
    // FIX-2026-07-24: เรียง enabled ก่อน (true=1 มาก่อน false=0) → บอทที่เปิดอยู่ลอยขึ้นบนสุดอัตโนมัติ
    //   - secondary sort: createdAt desc (บอทใหม่อยู่บนสุดภายใน group)
    const filter = includeDeleted ? {} : { deletedAt: null };
    const bots = await Bot.find(filter).sort({ enabled: -1, createdAt: -1 }).lean();
    // FIX-2026-08-02: run aggregations in parallel (independent)
    // FIX-2026-08-20: extract to tradeStats module for testability
    const [todayMap, monthMap, activePosMap, allTimeGlobal] = await Promise.all([
      tradeStats.aggregateTodayPerBot(),
      tradeStats.aggregateMonthPerBot(),
      tradeStats.aggregateActivePositionsPerBot(),
      tradeStats.aggregateAllTimeGlobal(), // ใช้แทน sum(b.totalTrades) เพราะรวม trades จาก soft-deleted bots ด้วย
    ]);
    // 2026-07-31: per-bot volatility snapshot (KC min + TP suggestion + 24h volume)
    //   - reuse tpUpdater.computeSuggestedTpForBot + get24hrTickers ผ่าน volatilityForBot helper
    //   - concurrency-6 กัน burst (Binance public weight limit)
    //   - FIX-2026-08-02: only when ?expand=1 (default = skip for fast first paint)
    //   - FIX-2026-08-22 (perf): skip Binance-heavy enrichment for soft-deleted bots
    //     - deleted bots ไม่มี trader → klineCache ว่าง → ทุก call = cache miss → fetch Binance ใหม่
    //     - bots[] ยังคงรวม deleted (เพื่อ UI แสดง 🗑 badge) แต่ vol fields = sentinel (UI fallback "—")
    //     - ประหยัด ~3 Binance calls per deleted bot (get24hrTickers + tpUpdater klines × N)
    const EMPTY_VOL = {
      ok: false, error: 'bot_deleted', cached: true,
      kcMinPct: null, kcMinPctDisplay: null, suggestedTpPct: null,
      trendState: null, trendTF: null, tpOverridden: false,
      rawSuggestedTpPct: null, feeBufferPct: null,
      quoteVolume24h: null, quoteVolume24hDisplay: null,
    };
    const deletedCount = bots.filter((b) => b.deletedAt).length;
    if (deletedCount > 0) {
      logger.info({ deletedCount, totalBots: bots.length }, 'bots: skipped vol enrichment for soft-deleted bots');
    }
    const volSnapshots = includeVolatility
      ? await volatilityForBot.mapWithConcurrency(bots, 6, (b) =>
          b.deletedAt ? Promise.resolve(EMPTY_VOL) : volatilityForBot.computeBotVolatilitySnapshot(b)
        )
      : bots.map(() => EMPTY_VOL);
    // FIX-2026-08-03: Safe-trade #2 (trendline) — read in-memory status cache populated by botManager
    //   - ไม่เรียก Binance ที่นี่ (พึ่ง botManager's 60s scan) — เพื่อ /api/bots response time คงที่
    //   - ถ้าบอทปิด filter → status=null (UI แสดง "off")
    //   - ถ้ายังไม่ scan (cold start) → status=null → UI แสดง "—"
    const trendlineStatusMap = botManager.getTrendlineStatusForBots(bots.map((b) => String(b._id)));
    // เพิ่ม totalCapital virtual + today/month stats + price/EMA indicator + volatility snapshot
    const enriched = bots.map((b, idx) => {
      const t = todayMap.get(String(b._id)) || { todayTrades: 0, todayPnl: 0 };
      const m = monthMap.get(String(b._id)) || { monthTrades: 0, monthPnl: 0 };
      const indicator = computeBotIndicator(b);
      const vol = volSnapshots[idx] || {};
      // FIX-2026-08-03: trendline status — null when filter OFF, null when not yet scanned
      const tlEnabled = b.safeTradeTrendlineEnabled === true;
      const tl = tlEnabled ? trendlineStatusMap[String(b._id)] : null;
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
        // FIX-2026-08-03: Safe-trade filter #2 (trendline) — live badge fields
        //   - tlEnabled: ค่าจากบอท (bot.safeTradeTrendlineEnabled)
        //   - tlStatus: 'pass' | 'blocked' | 'warmup' | 'insufficient_data' | 'api_error' | 'no_trend_tf' | null (when disabled or not yet scanned)
        //   - tlGapPct: ((lastClose - trendlineValue) / trendlineValue) * 100  (null when warmup/error)
        //   - tlUpdatedAt: ms epoch when cache was refreshed (null when not yet scanned)
        //   - UI ใช้สร้าง badge: tlEnabled=false → "off", tlStatus='pass' → "✅", 'blocked' → "❌", etc.
        tlEnabled,
        tlStatus: tl ? tl.status : null,
        tlTrendTF: tl ? tl.trendTF : null,
        tlLastClose: tl ? tl.lastClose : null,
        tlTrendlineValue: tl ? tl.trendlineValue : null,
        tlGapPct: tl ? tl.gapPct : null,
        tlPivotCount: tl ? tl.pivotCount : 0,
        tlUpdatedAt: tl ? tl.updatedAt : null,
        tlCached: tl ? !!tl.cached : false,
        // FIX-2026-08-06: delist risk fields (mirror coinInfo endpoint)
        //   - isAtRisk: Binance "Monitoring" tag (early warning, ยังเปิด position ได้)
        //   - isDelisted: delistTime already passed (ห้ามเทรด)
        //   - delistTime: epoch ms (null = ไม่มี schedule)
        //   - delistDateIso: ISO string (UI แสดง)
        //   - daysUntil: �ำนวนวันก่อน delist (null = ไม่มี schedule)
        //   - ถ้า delistMonitor ยังไม่ start → ทุก field = null/false (UI แสดง "—" / ไม่มี badge)
        ...(() => {
          try {
            const delistMonitor = require('../../services/binanceDelistMonitor');
            const risk = delistMonitor.getRiskInfoFor(b.symbol);
            return {
              isAtRisk: risk ? risk.isAtRisk : false,
              isDelisted: risk ? risk.isDelisted : false,
              delistTime: risk ? risk.delistTime : null,
              delistDateIso: risk ? risk.delistDateIso : null,
              daysUntil: risk ? risk.daysUntil : null,
            };
          } catch (_) {
            return { isAtRisk: false, isDelisted: false, delistTime: null, delistDateIso: null, daysUntil: null };
          }
        })(),
        // FIX-2026-08-08: Feature #1 — Dynamic Position Sizing fields (effective values for UI)
        //   - dynamicSizeEffective: ค่าที่ใช้จริง (fallback = capitalPerTrade)
        //   - dynamicLayersEffective: ค่าที่ใช้จริง (fallback = maxTrades)
        //   - dynamicSizeInCooldown: อยู่ในช่วง cooldown (กัน rapid resize)
        dynamicSizeEffective: Number.isFinite(b.dynamicSizeCurrent) ? b.dynamicSizeCurrent : (b.capitalPerTrade || 0),
        dynamicLayersEffective: Number.isFinite(b.dynamicLayersCurrent) ? b.dynamicLayersCurrent : (b.maxTrades || 0),
        dynamicSizeInCooldown: b.dynamicSizeCooldownUntil && new Date(b.dynamicSizeCooldownUntil).getTime() > Date.now(),
        // FIX-2026-08-08: Feature #2 — CB Cooldown state (sub-categories for filter)
        //   - cbCooldown: { active, reason, version, until, msLeft } — used by bots.html filter
        //   - version: 'v2' | 'v3' | null (depends on AppConfig.cbVersion)
        //   - reason: 'cbv2_panic' | 'cbv3_panic' | null
        cbCooldown: (() => {
          const now = Date.now();
          const cbv2LockedUntilMs = b.cbv2LockedUntil ? new Date(b.cbv2LockedUntil).getTime() : 0;
          const cbv3LockedUntilMs = b.cbv3LockedUntil ? new Date(b.cbv3LockedUntil).getTime() : 0;
          const cbv2Active = cbv2LockedUntilMs > now;
          const cbv3Active = cbv3LockedUntilMs > now;
          if (cbv3Active) {
            return { active: true, reason: 'cbv3_panic', version: 'v3', until: b.cbv3LockedUntil, msLeft: cbv3LockedUntilMs - now };
          }
          if (cbv2Active) {
            return { active: true, reason: 'cbv2_panic', version: 'v2', until: b.cbv2LockedUntil, msLeft: cbv2LockedUntilMs - now };
          }
          return { active: false, reason: null, version: null, until: null, msLeft: 0 };
        })(),
        // FIX-2026-08-08: Feature #3 — Auto Unlock Cooldown fields
        cbAutoUnlockEnabled: !!b.cbAutoUnlockEnabled,
        cbAutoUnlockThresholdPct: Number.isFinite(b.cbAutoUnlockThresholdPct) ? b.cbAutoUnlockThresholdPct : 1.0,
        cbAutoUnlockSignalsFound: b.cbAutoUnlockSignalsFound || 0,
        // FIX-2026-08-08: Feature #5 — Auto Delete Bot fields
        deletedAt: b.deletedAt || null,
        scheduledDeleteAt: b.scheduledDeleteAt || null,
        deleteDaysSince: b.deletedAt ? Math.floor((Date.now() - new Date(b.deletedAt).getTime()) / (1000 * 60 * 60 * 24)) : null,
      };
    });
    res.json({
      bots: enriched,
      // FIX-2026-08-20: global all-time stats — aggregate จาก Trade collection (source of truth)
      //   - รวม trades จาก soft-deleted bots ด้วย (ต่างจาก sum(b.totalTrades) ที่ filter ออก)
      //   - ใช้กับ summary tiles: Total Trades / Win Rate / Total PnL
      globalStats: {
        allTimeTrades: allTimeGlobal.totalTrades,
        allTimeWins: allTimeGlobal.totalWins,
        allTimePnl: allTimeGlobal.totalPnl,
      },
    });
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

// FIX-2026-08-03: Safe-trade filter #2 (trendline) — live status endpoint
//   - GET /api/bots/safe-trade-trendline → returns map of botId → status (all bots)
//   - GET /api/bots/safe-trade-trendline/:botId → returns single bot status (force refresh on ?fresh=1)
//   - data from in-memory cache (populated by botManager 60s scan) — fast, no Binance call
//   - when ?fresh=1 on per-bot route: bypass cache and recompute (single Binance fetch)
router.get('/safe-trade-trendline', requireAuth, async (req, res) => {
  try {
    const bots = await Bot.find({ safeTradeTrendlineEnabled: true }, { _id: 1 }).lean();
    const botIds = bots.map((b) => String(b._id));
    const statusMap = botManager.getTrendlineStatusForBots(botIds);
    res.json({ asOf: Date.now(), count: botIds.length, statuses: statusMap });
  } catch (err) {
    logger.error({ err: err.message }, 'bots: GET /safe-trade-trendline failed');
    res.status(500).json({ error: err.message });
  }
});

router.get('/safe-trade-trendline/:botId', requireAuth, async (req, res) => {
  try {
    const { botId } = req.params;
    if (req.query.fresh === '1') {
      // Bypass cache — single Binance fetch
      const bot = await Bot.findById(botId).lean();
      if (!bot) return res.status(404).json({ error: 'bot not found' });
      const snap = await trendlineForBot.computeBotTrendlineSnapshot(bot);
      return res.json({ asOf: Date.now(), botId, snapshot: snap });
    }
    // Cached path — read from botManager's in-memory map
    const statusMap = botManager.getTrendlineStatusForBots([botId]);
    const snapshot = statusMap[botId] || null;
    if (!snapshot) {
      // bot may have filter disabled, not yet scanned, or doesn't exist
      const bot = await Bot.findById(botId).lean();
      if (!bot) return res.status(404).json({ error: 'bot not found' });
      if (bot.safeTradeTrendlineEnabled !== true) {
        return res.json({ asOf: Date.now(), botId, snapshot: { status: 'disabled' } });
      }
      return res.json({ asOf: Date.now(), botId, snapshot: null, hint: 'not yet scanned (wait up to 60s after botManager start)' });
    }
    res.json({ asOf: Date.now(), botId, snapshot });
  } catch (err) {
    logger.error({ err: err.message, botId: req.params.botId }, 'bots: GET /safe-trade-trendline/:botId failed');
    res.status(500).json({ error: err.message });
  }
});

router.get('/positions', requireAuthOrLicenseKey, async (req, res) => {
  try {
    // FIX-2026-08-03: ?fresh=1 — bypass klineCache (in-memory, may be stale when WS dropped)
    //   and fetch latest bookTicker per unique symbol directly from Binance REST.
    //   ใช้ตอน user กดปุ่ม Refresh ใน Open Positions modal (หน้า /bots.html)
    //   - ลด impact: ใช้ bookTicker (weight=2/symbol) แทน get24hr (weight=2/symbol) → same weight
    //   - dedupe by symbol → 1 Binance call ต่อ symbol ไม่ใช่ต่อ position
    //   - เก็บ fresh price ใน Map<symbol, midPrice> แล้วใช้แทน klineCache snapshot
    const freshMode = req.query.fresh === '1' || req.query.fresh === 'true';
    // FIX-2026-08-23: ?noPrediction=1 — skip upper-KC prediction computation
    //   - Chart Monitor page renders PositionCard without the AU prediction panel,
    //     so the heavy computeUpperKCPrices + computePredictionForTrade work is wasted.
    //   - Saves: 1 klines REST per unique (symbol, tf) on cold cache + per-position compute.
    //   - Response fields (upperKC, predictedSellPrice, predictedLossUsdt, ...) become null.
    //   - Default behavior unchanged for bots.html (which DOES use the prediction panel).
    const skipPrediction = req.query.noPrediction === '1';
    let freshPriceMap = null;
    if (freshMode) {
      freshPriceMap = new Map();
    }
    const trades = await Trade.find({ state: { $in: OPEN_POSITIONS_STATES_FOR_API } })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    if (trades.length === 0) {
      return res.json({ asOf: new Date().toISOString(), count: 0, totalCostUsdt: 0, totalUnrealizedUsdt: 0, totalUnrealizedThb: 0, positions: [] });
    }
    const botIds = [...new Set(trades.map((t) => String(t.botId)))];
    // FIX-2026-08-05: include kcMult for upper-KC prediction (per-bot mult)
    // FIX-2026-08-22: include deletedAt/enabled/autoPauseReason/disabledAt — frontend needs to show
    //   "🗑 Bot ถูกลบ" / "⏸ Auto-paused" badges in Open Positions modal + offer Restore button
    //   (positions of soft-deleted bots keep showing because bot doc still exists in DB)
    const bots = await Bot.find({ _id: { $in: botIds } })
      .select('_id name symbol timeframe retryMax kcMult enabled deletedAt autoPauseReason disabledAt scheduledDeleteAt deleteNotificationSentAt')
      .lean();
    const botMap = new Map(bots.map((b) => [String(b._id), b]));

    // FIX-2026-08-08 ACTUSDT orphan-positions: filter out trades whose botId doesn't exist in bots
    //   - previous code fell back to `|| {}` at L520 which silently kept ghost positions
    //     (ACTUSDT trade 6a75d52f...e9 lived in DB after ACT(bAdd) bot was hard-deleted)
    //   - new: drop the trade from the response, count it in `orphanFiltered` so admin sees the count
    //   - log a single warning per request (idempotent — same orphanId won't spam logs)
    //   - ghost trade cleanup should be done via permanent-delete (now correctly synthesizes) or
    //     via /admin/orphan-trades reconciliation script
    const orphanTradeIds = [];
    const validTrades = trades.filter((t) => {
      if (botMap.has(String(t.botId))) return true;
      orphanTradeIds.push(String(t._id));
      return false;
    });
    if (orphanTradeIds.length > 0) {
      logger.warn({
        orphanCount: orphanTradeIds.length,
        orphanTradeIds,
        orphanBotIds: [...new Set(trades.filter((t) => !botMap.has(String(t.botId))).map((t) => String(t.botId)))],
      }, 'positions: orphan trades filtered (botId missing in bots collection) — run cleanupOrphanTrades or permanent-delete to reconcile');
    }

    // FIX-2026-08-08: Stopped-bot price bypass — klineCache is frozen after trader.stop()
    //   (Binance WS kline:update stops flowing), so positions of disabled bots show stale prices
    //   in the default non-fresh mode. Pre-fetch live bookTicker per unique symbol of stopped bots
    //   so Chart Monitor's 10s auto-refresh can update them too.
    //   Cost: 1 bookTicker call (weight=2) per unique stopped-bot symbol per /positions request.
    //   Safe even with 10s polling (Binance limit = 1200 weight/min).
    const disabledBotIds = new Set(bots.filter((b) => !b.enabled).map((b) => String(b._id)));
    const stoppedBotSymbols = new Set();
    for (const t of validTrades) {
      if (disabledBotIds.has(String(t.botId))) stoppedBotSymbols.add(t.symbol);
    }
    let stoppedBotPriceMap = new Map();
    let stoppedBotFetchFailed = [];
    if (stoppedBotSymbols.size > 0) {
      const uniqueSymbols = [...stoppedBotSymbols];
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
          stoppedBotPriceMap.set(sym, s.value.midPrice);
        } else {
          stoppedBotFetchFailed.push(sym);
          logger.warn({ symbol: sym, err: s.reason && s.reason.message }, 'positions stopped-bot price fetch failed, will fallback to klineCache');
        }
      }
    }

    // FIX-2026-08-05: pre-compute upper-KC for each unique (symbol, timeframe) pair
    //   - primary: zero Binance weight (klineCache in-memory)
    //   - fallback: REST getKlines when klineCache warmup (e.g. disabled bot / no trader running) — 1 call per unique pair
    // FIX-2026-08-23: skip prediction entirely when ?noPrediction=1 (Chart Monitor optimization)
    let upperKCMap = new Map();
    let usdtToThbRate = null;
    if (!skipPrediction) {
      const uniqueKCItems = [];
      const seenKCKeys = new Set();
      for (const t of validTrades) {
        const bot = botMap.get(String(t.botId));
        if (!bot) continue;
        const k = prediction.makeKey(t.symbol, t.timeframe);
        if (seenKCKeys.has(k)) continue;
        seenKCKeys.add(k);
        uniqueKCItems.push({ symbol: t.symbol, timeframe: t.timeframe, kcMult: bot.kcMult });
      }
      upperKCMap = await prediction.computeUpperKCPrices(uniqueKCItems, { restFallback: true });

      // OPTIONAL: USDT→THB rate for predicted loss display (graceful fallback if not available)
      try {
        const fxMod = require('../../services/fxService');
        if (fxMod && typeof fxMod.getUsdtToThb === 'function') {
          const rate = await fxMod.getUsdtToThb().catch(() => null);
          if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
            usdtToThbRate = rate;
          }
        }
      } catch (_) { /* ignore — service may not exist */ }
    }

    // FIX-2026-08-03: fetch fresh bookTicker per unique symbol (Promise.all — parallel)
    //   - ใช้ midPrice = (bidPrice + askPrice) / 2 (bookTicker ไม่มี lastPrice)
    //   - ถ้า fetch fail → ใช้ klineCache fallback (เดิม) → PnL ไม่พัง
    //   - mark freshFailedSymbols ใน response เพื่อ UI แสดง warning ถ้าจำเป็น
    let freshFailedSymbols = [];
    if (freshMode) {
      const uniqueSymbols = [...new Set(validTrades.map((t) => t.symbol))];
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

    const positions = validTrades.map((t) => {
      const bot = botMap.get(String(t.botId));
      // FIX-2026-08-08 ACTUSDT orphan-fix: bot lookup is guaranteed to succeed (filtered above).
      //   Defensive guard retained to avoid throwing if upstream filter regresses.
      if (!bot) {
        logger.error({ tradeId: String(t._id), botId: String(t.botId) }, 'positions: unexpected ghost trade (filter regression?)');
        return null;
      }
      // price resolution priority:
      //   1. freshMode + freshPriceMap → midPrice from Binance bookTicker (authoritative)
      //   2. FIX-2026-08-08: stopped-bot bookTicker → bypass frozen klineCache for disabled bots
      //   3. klineCache.getCurrent() → WS kline (fast but may be stale)
      //   4. buyPrice fallback (PnL = 0)
      let currentPrice = 0;
      let priceSource = 'klineCache';
      if (freshMode && freshPriceMap && freshPriceMap.has(t.symbol)) {
        currentPrice = freshPriceMap.get(t.symbol);
        priceSource = 'binance-bookTicker';
      } else if (stoppedBotPriceMap.has(t.symbol)) {
        currentPrice = stoppedBotPriceMap.get(t.symbol);
        priceSource = 'binance-bookTicker-stopped-bot';
      } else {
        const current = klineCache.getCurrent(t.symbol, t.timeframe);
        currentPrice = current ? parseFloat(current.close) : (Number(t.buyPrice) || 0);
        priceSource = current ? 'klineCache' : 'buyPrice';
      }
      const qty = Number(t.buyQty) || 0;
      const entry = Number(t.buyPrice) || 0;
      const cost = Number(t.buyQuoteQty) || (entry * qty);
      const unrealizedUsdt = (currentPrice - entry) * qty;

      // FIX-2026-08-05: upper-KC prediction — ใช้แสดงใน AU prediction panel (position card)
      //   - zero Binance weight (อ่านจาก klineCache in-memory)
      //   - DCA stacks: refPrice = stackBep, qty = stackTotalQty (handled in computePredictionForTrade)
      // FIX-2026-08-23: skip entirely when ?noPrediction=1 (Chart Monitor doesn't render AU panel)
      let pred = null;
      let upperKCInfo = null;
      if (!skipPrediction) {
        const upperKCKey = prediction.makeKey(t.symbol, t.timeframe);
        upperKCInfo = upperKCMap.get(upperKCKey);
        pred = prediction.computePredictionForTrade(t, upperKCInfo, usdtToThbRate);
      }

      return {
        tradeId: String(t._id),
        botId: String(t.botId),
        botName: bot.name || bot.symbol || '',
        // FIX-2026-08-22: expose bot lifecycle flags — frontend shows badges + Restore button
        //   when position belongs to a soft-deleted or auto-paused bot
        botDeletedAt: bot.deletedAt || null,
        botEnabled: bot.enabled !== false,
        botAutoPauseReason: bot.autoPauseReason || null,
        botDisabledAt: bot.disabledAt || null,
        botScheduledDeleteAt: bot.scheduledDeleteAt || null,
        botDeleteNotifiedAt: bot.deleteNotificationSentAt || null,
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
        //   - useStopLossOnUKC=true = trader._autoArmStopLossOnUKC armed (loss>autoArmLossPct + age>autoArmAgeHours)
        //   - autoArmedAt = timestamp when armed (audit)
        // FIX-2026-08-03: expose per-trade snapshot ของ thresholds ตอน arm — positionCard.js ใช้แสดง "stuck-like" highlight
        useStopLossOnUKC: t.useStopLossOnUKC === true,
        autoArmedAt: t.autoArmedAt || null,
        autoArmLossPct: t.autoArmLossPct ?? null,
        autoArmAgeHours: t.autoArmAgeHours ?? null,
        createdAt: t.createdAt,
        currentPrice,
        priceSource, // FIX-2026-08-03: 'binance-bookTicker' | 'klineCache' | 'buyPrice' — exposed for UI badge
        // FIX-2026-08-05: upper-KC + predicted exit fields (used by AU prediction panel)
        //   - null = warmup (<20 cached candles) — UI shows "⏳ upper-KC ยังไม่พร้อม"
        //   - predictedLossUsdt: positive = predicted profit, negative = predicted loss (aligned with realizedPnl semantics)
        upperKC: pred && Number.isFinite(pred.upperKC) ? pred.upperKC : null,
        predictedSellPrice: pred && Number.isFinite(pred.predictedSellPrice) ? pred.predictedSellPrice : null,
        predictedLossUsdt: pred && Number.isFinite(pred.predictedLossUsdt) ? pred.predictedLossUsdt : null,
        predictedLossPct: pred && Number.isFinite(pred.predictedLossPct) ? pred.predictedLossPct : null,
        predictedLossThb: pred && Number.isFinite(pred.predictedLossThb) ? pred.predictedLossThb : null,
        predictionWarmup: !!(pred && pred.warmup),
        predictionComputedAt: upperKCInfo && upperKCInfo.computedAt ? upperKCInfo.computedAt : null,
        kcCachedCandles: pred && Number.isFinite(pred.cachedCandles) ? pred.cachedCandles : 0,
        predictionSource: upperKCInfo && upperKCInfo.source ? upperKCInfo.source : null, // 'klineCache' | 'binance-rest' | 'warmup'
        kcMult: bot.kcMult ?? null,
        _costUsdt: cost,
        _unrealizedUsdt: unrealizedUsdt,
      };
    });
    // FIX-2026-08-08 ACTUSDT orphan-fix: filter out the defensive nulls (shouldn't happen since
    //   validTrades pre-filtered, but kept as a safety net).
    const positionsClean = positions.filter((p) => p !== null);
    const totalCost = positionsClean.reduce((s, p) => s + (p._costUsdt || 0), 0);
    const totalUnrealized = positionsClean.reduce((s, p) => s + (p._unrealizedUsdt || 0), 0);
    // FIX-2026-08-26: per-position unrealized PnL in THB (for /machine-detail.html + admin machines tab)
    //   - convertUsdtToThb returns null if FX rate unavailable — UI shows "—" rather than 0
    //   - on null we keep _unrealizedThb: null (NOT 0) so frontend can distinguish "unknown" from "0 PnL"
    //   - compute in parallel for all positions via Promise.all (single shared rate fetch inside fxService)
    const unrealizedThbResults = await Promise.all(
      positionsClean.map((p) => fxService.convertUsdtToThb(p._unrealizedUsdt || 0))
    );
    positionsClean.forEach((p, i) => {
      p._unrealizedThb = Number.isFinite(unrealizedThbResults[i]) ? unrealizedThbResults[i] : null;
    });
    const totalUnrealizedThb = positionsClean.reduce(
      (s, p) => s + (Number.isFinite(p._unrealizedThb) ? p._unrealizedThb : 0),
      0,
    );
    res.json({
      asOf: new Date().toISOString(),
      count: positionsClean.length,
      totalCostUsdt: totalCost,
      totalUnrealizedUsdt: totalUnrealized,
      // FIX-2026-08-26: wrap-level THB totals for dashboard / admin machines tab
      //   - 0 when all per-position THB are null (FX rate unavailable) — UI can detect via priceSources
      totalUnrealizedThb: Number.isFinite(totalUnrealizedThb) ? totalUnrealizedThb : null,
      // FIX-2026-08-03: ?fresh=1 metadata — UI ใช้แสดง badge "Binance" vs "cache"
      fresh: freshMode,
      priceSources: {
        binance: positionsClean.filter((p) => p.priceSource === 'binance-bookTicker').length,
        binanceStoppedBot: positionsClean.filter((p) => p.priceSource === 'binance-bookTicker-stopped-bot').length,
        klineCache: positionsClean.filter((p) => p.priceSource === 'klineCache').length,
        buyPrice: positionsClean.filter((p) => p.priceSource === 'buyPrice').length,
      },
      freshFailedSymbols,
      stoppedBotFetchFailed,
      // FIX-2026-08-08: orphan-filter metadata — UI/admin can see how many ghosts were dropped
      orphanFiltered: orphanTradeIds.length,
      orphanTradeIds,
      // FIX-2026-08-26: keep _unrealizedUsdt + _unrealizedThb per position (used by machine-detail page + admin tab)
      positions: positionsClean.map(({ _costUsdt, ...p }) => p),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'list open positions failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bots/chart-monitor/signals ─────────────────────────
// 2026-08-06: Chart Monitor page aggregation
//   - Per-bot: current zone + prediction label + last 2 signals (with blocked reasons)
//   - Cross-bot: top 50 latest signals across all running bots
//   - 2026-08-20: enrich with Signal DB outcome (filled / skipped / expired / etc.) + note
//     so the page shows WHY each signal got that result (retry max, เงินไม่พอ, safetrade, ...)
//   - "blockedReasons" mirrors the runtime gates:
//       * xs1 (XS1 candle-wide dump filter, when xs1Enabled=true)
//       * s1OnlyDown (when s1OnlyDown=true and signal is Strong Up)
//       * noTrade (Bearish Engulfing / Shooting Star on upper TF, when safeTradeNoTradeEnabled=true)
//       * trendline (when safeTradeTrendlineEnabled=true and tlStatus=blocked)
//   - 30s in-memory cache (page refreshes don't re-hit Binance)
//   - per-bot: klineCache-first (0 weight) + REST fallback only when cache cold
//   - significant Binance weight only when a bot has safeTradeNoTradeEnabled=true (then 1 REST per such bot for upper TF)
let _cmSignalsCache = null;
const CM_SIGNALS_CACHE_MS = 30_000;
const CM_SIGNALS_TOP_LIMIT = 50;
router.get('/chart-monitor/signals', requireAuth, async (req, res) => {
  try {
    const forceRefresh = req.query.fresh === '1';
    if (!forceRefresh && _cmSignalsCache && (Date.now() - _cmSignalsCache.at) < CM_SIGNALS_CACHE_MS) {
      return res.json(_cmSignalsCache.data);
    }

    const bots = await Bot.find({ enabled: true }).lean();
    const trendlineMap = botManager.getTrendlineStatusForBots(bots.map((b) => String(b._id)));

    // Per-bot summary (concurrency-4 — klineCache-heavy, only noTrade filter falls through to REST)
    const perBot = await volatilityForBot.mapWithConcurrency(bots, 4, async (bot) => {
      try {
        const cached = klineCache.getAll(bot.symbol, bot.timeframe);
        if (!cached || cached.length < 50) return null;

        const fullKlines = cached.map((c) => ({
          openTime: c.openTime,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
          closeTime: c.closeTime,
        }));

        const xs1On = bot.xs1Enabled !== false;
        const s1Opts = {
          mult: bot.kcMult != null ? parseFloat(bot.kcMult) : 1.5,
          onlyDown: !!bot.s1OnlyDown,
          xs1Enabled: xs1On,
        };

        // Filtered S1 (what the bot actually fires)
        const detected = signalEngine.detectS1Signals(fullKlines, s1Opts);
        const { signals, basis, upper, lower, bg } = detected;

        // Raw S1 (without xs1) — for "ข้าม candle-wide dump" annotation
        let rawSignalTimes = null;
        if (xs1On) {
          const raw = signalEngine.detectS1Signals(fullKlines, { ...s1Opts, xs1Enabled: false });
          rawSignalTimes = new Set(raw.signals.map((s) => s.openTime));
        }

        // NoTrade filter (upper TF) — same logic as checkNoTradeOnUpperTF but in-memory
        const noTradeEnabled = bot.safeTradeNoTradeEnabled === true;
        const trendTF = volatilityScanner.TREND_TF_MAP[bot.timeframe];
        let noTradeUpperKlines = null;
        let noTradePerBar = null;
        let noTradeLastKind = null;
        let noTradeReason = null;
        if (noTradeEnabled && trendTF) {
          try {
            const raw = await binanceRest.getKlines({
              symbol: bot.symbol,
              interval: trendTF,
              limit: 30,
            });
            if (Array.isArray(raw) && raw.length >= 21) {
              noTradeUpperKlines = raw.map((k) => ({
                openTime: k[0],
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                closeTime: k[6],
              }));
              noTradePerBar = signalEngine.computeNoTradePerBar(noTradeUpperKlines, { mult: s1Opts.mult });
              const last = noTradePerBar[noTradePerBar.length - 1];
              noTradeLastKind = last ? last.kind : null;
            }
          } catch (_) {
            noTradeReason = 'api_error_open';
          }
        }

        // Trendline status
        const tl = bot.safeTradeTrendlineEnabled === true ? trendlineMap[String(bot._id)] : null;

        // Helper: หา upper-TF bar index ที่มี openTime <= signal.openTime
        const findUpperIdx = (openTime) => {
          if (!noTradeUpperKlines) return -1;
          // binary search for last bar with openTime <= target
          let lo = 0, hi = noTradeUpperKlines.length - 1, ans = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (noTradeUpperKlines[mid].openTime <= openTime) { ans = mid; lo = mid + 1; }
            else { hi = mid - 1; }
          }
          return ans;
        };

        // Build enriched signals with blocked reasons
        const enrichedSignals = signals.map((s) => {
          const blockedReasons = [];
          // XS1: filtered out by xs1Enabled
          if (xs1On && rawSignalTimes && !rawSignalTimes.has(s.openTime)) {
            blockedReasons.push({ kind: 'xs1', text: 'ข้าม candle-wide dump (XS1)' });
          }
          // s1OnlyDown: skip Strong Up
          if (s1Opts.onlyDown && s.bgState === 1) {
            blockedReasons.push({ kind: 's1OnlyDown', text: 's1OnlyDown (skip Strong Up)' });
          }
          // NoTrade: upper TF bar at signal time has nt/nt1
          if (noTradeEnabled && noTradePerBar) {
            const idx = findUpperIdx(s.openTime);
            if (idx >= 0) {
              const kind = noTradePerBar[idx]?.kind;
              if (kind === 'nt' || kind === 'nt1') {
                const label = kind === 'nt' ? 'Bearish Engulfing/SS' : 'no-trade continuation';
                blockedReasons.push({ kind: 'noTrade', text: `ข้าม ${label} บน ${trendTF}` });
              }
            }
          }
          // Trendline: tlStatus=blocked at signal time (we sample current status; per-signal history is hard)
          if (tl && tl.status === 'blocked') {
            const gapTxt = (tl.gapPct != null) ? ` (gap ${tl.gapPct.toFixed(2)}%)` : '';
            blockedReasons.push({ kind: 'trendline', text: `ข้าม trendline${gapTxt}` });
          }
          return {
            botId: String(bot._id),
            name: bot.name || bot.symbol,
            symbol: bot.symbol,
            timeframe: bot.timeframe,
            openTime: s.openTime,
            close: s.close,
            bgState: s.bgState,
            bgPrev: s.bgPrev,
            ageMs: Date.now() - s.openTime,
            status: blockedReasons.length > 0 ? 'blocked' : 'active',
            blockedReasons,
          };
        });

        // Prediction label — based on LAST CLOSED candle bg state (in-progress candle is [-1])
        const lastClosedIdx = fullKlines.length - 2;
        const lastClosedBg = lastClosedIdx >= 0 ? bg[lastClosedIdx] : null;
        const lastCandle = fullKlines[fullKlines.length - 1];
        const lastClosedCandle = fullKlines[lastClosedIdx];
        const lastCandleBg = bg[bg.length - 1];

        let predictionLabel = null;
        let predictionCode = 'unknown';
        let nearS1 = false;
        if (lastClosedCandle != null && lastClosedBg != null) {
          if (lastClosedBg === 2) {
            predictionLabel = '🌡️ Weak zone — ใกล้ S1';
            predictionCode = 'near-s1';
            nearS1 = true;
          } else if (lastClosedBg === 1) {
            predictionLabel = '🚀 Strong Up ล่าสุด';
            predictionCode = 'strong-up';
          } else if (lastClosedBg === 3) {
            predictionLabel = '📉 Strong Down ล่าสุด';
            predictionCode = 'strong-down';
          } else if (lastClosedBg === 0) {
            predictionLabel = '➡️ Above basis';
            predictionCode = 'above-basis';
          }
        }
        // Bonus: if in-progress candle already broke upper/lower, upgrade label
        if (lastCandle && lastCandleBg != null && lastCandleBg !== lastClosedBg) {
          if (lastCandleBg === 1) { predictionLabel = '🚀 Breakout แท่งนี้'; predictionCode = 'breakout'; }
          if (lastCandleBg === 3) { predictionLabel = '📉 Breakdown แท่งนี้'; predictionCode = 'breakdown'; }
        }

        // Last 2 signals — lastSignal highlighted if on last or previous closed candle
        const lastSignal = enrichedSignals[enrichedSignals.length - 1] || null;
        const prevSignal = enrichedSignals[enrichedSignals.length - 2] || null;
        const lastCandleOpenTime = lastCandle?.openTime;
        const lastClosedOpenTime = lastClosedCandle?.openTime;
        let hasLiveSignal = false;
        if (lastSignal && lastCandleOpenTime != null) {
          hasLiveSignal = lastSignal.openTime === lastCandleOpenTime || lastSignal.openTime === lastClosedOpenTime;
        }
        // EMA20 + gap%
        const ema20 = basis[basis.length - 1];
        const emaGapPct = (lastCandle && ema20) ? ((lastCandle.close - ema20) / ema20) * 100 : null;

        return {
          botId: String(bot._id),
          name: bot.name || bot.symbol,
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          lastClose: lastCandle?.close,
          ema20,
          emaGapPct,
          currentZone: { bgState: lastClosedBg, code: predictionCode, label: predictionLabel, nearS1 },
          prediction: { label: predictionLabel, code: predictionCode, nearS1 },
          // For the highlight: include lastSignal + prevSignal
          lastSignal: hasLiveSignal ? lastSignal : null,
          prevSignal: prevSignal,
          hasLiveSignal,
          // All enriched signals (for top-50 aggregation)
          _signals: enrichedSignals,
          // Snapshot of configs that affect the highlight color
          s1OnlyDown: s1Opts.onlyDown,
          xs1Enabled: xs1On,
          noTradeEnabled,
          noTradeTrendTF: trendTF || null,
          noTradeLastKind,
          trendlineStatus: tl ? tl.status : null,
        };
      } catch (err) {
        logger.warn({ botId: String(bot._id), err: err.message }, 'chart-monitor signal per-bot failed');
        return null;
      }
    });

    const validBots = perBot.filter(Boolean);

    // Aggregate + sort all signals across all running bots ONCE
    const allSignals = validBots.flatMap((b) => b._signals || []);
    allSignals.sort((a, b) => b.openTime - a.openTime);
    // 2026-08-20: top 50 (was 20) — show full action detail of every recent signal
    const top50 = allSignals.slice(0, CM_SIGNALS_TOP_LIMIT);

    // 2026-08-20: merge Signal DB outcome + note into each enriched signal so the
    //   📡 S1 Signals ล่าสุด panel can show the reason (filled / safetrade1 /
    //   retry max / เงินไม่พอ / dca_max_layers / ...). Match by (botId, candleOpenTime).
    //   - in-memory `s.openTime` is the candle open ms; DB stores it as Date.
    //   - safeTrade blockedReasons are still kept alongside DB outcome for the existing pill UX.
    try {
      const SignalModel = require('../../db/models/Signal');
      if (top50.length > 0) {
        const botIds = [...new Set(top50.map((s) => s.botId))];
        const sinceMs = top50[top50.length - 1].openTime - 1; // inclusive lower bound
        const dbRows = await SignalModel.find({
          botId: { $in: botIds },
          candleOpenTime: { $gte: new Date(sinceMs) },
        })
          .select({ botId: 1, candleOpenTime: 1, outcome: 1, note: 1, tradeId: 1, _id: 0 })
          .lean();
        // Build index: key = `${botId}::${candleOpenTimeMs}` → row
        const dbIdx = new Map();
        for (const row of dbRows) {
          const key = `${String(row.botId)}::${new Date(row.candleOpenTime).getTime()}`;
          dbIdx.set(key, row);
        }
        for (const s of top50) {
          const row = dbIdx.get(`${s.botId}::${s.openTime}`);
          if (row) {
            s.outcome = row.outcome || null;
            s.outcomeNote = row.note || '';
            s.tradeId = row.tradeId ? String(row.tradeId) : null;
          } else {
            // No DB record yet (signal just detected this second, not yet persisted,
            // OR detected long ago + trader restarted without DB backfill)
            s.outcome = s.status === 'blocked' ? 'skipped_predicted' : 'pending';
            s.outcomeNote = s.status === 'blocked' ? 'in-memory block' : '';
            s.tradeId = null;
          }
        }
      }
    } catch (sigDbErr) {
      logger.warn({ err: sigDbErr.message }, 'chart-monitor signals: outcome enrichment failed (non-fatal)');
    }

    const data = {
      asOf: Date.now(),
      cachedForMs: CM_SIGNALS_CACHE_MS,
      count: { running: bots.length, computed: validBots.length, signals: allSignals.length, top: top50.length },
      signals: top50,
      bots: validBots.map((b) => ({
        botId: b.botId,
        name: b.name,
        symbol: b.symbol,
        timeframe: b.timeframe,
        lastClose: b.lastClose,
        ema20: b.ema20,
        emaGapPct: b.emaGapPct,
        currentZone: b.currentZone,
        prediction: b.prediction,
        lastSignal: b.lastSignal,
        prevSignal: b.prevSignal,
        hasLiveSignal: b.hasLiveSignal,
        s1OnlyDown: b.s1OnlyDown,
        xs1Enabled: b.xs1Enabled,
        noTradeEnabled: b.noTradeEnabled,
        noTradeTrendTF: b.noTradeTrendTF,
        noTradeLastKind: b.noTradeLastKind,
        trendlineStatus: b.trendlineStatus,
      })),
    };

    _cmSignalsCache = { at: Date.now(), data };
    res.json(data);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'chart-monitor signals failed');
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
        // FIX-2026-08-06: delist risk fields (mirror /api/bots list)
        ...(() => {
          try {
            const delistMonitor = require('../../services/binanceDelistMonitor');
            const risk = delistMonitor.getRiskInfoFor(bot.symbol);
            return {
              isAtRisk: risk ? risk.isAtRisk : false,
              isDelisted: risk ? risk.isDelisted : false,
              delistTime: risk ? risk.delistTime : null,
              delistDateIso: risk ? risk.delistDateIso : null,
              daysUntil: risk ? risk.daysUntil : null,
            };
          } catch (_) {
            return { isAtRisk: false, isDelisted: false, delistTime: null, delistDateIso: null, daysUntil: null };
          }
        })(),
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

    // FIX-2026-08-09: ใช้ botDefaults helper เดียวกับ autoAddBot
    //   - ก่อนหน้านี้ inline `AppConfig.findOne({key:'singleton'})` + local pickDefault
    //   - ตอนนี้: แชร์ logic กับ autoAddBot._createBotFor() — ไม่มี drift อีก
    //   - ถ้า user แก้ Settings section 1️⃣ Bot Defaults → apply ทั้ง manual + auto paths
    const botDefaults = await getBotDefaults();

    const symbol = (data.symbol || botDefaults.defaultSymbol || defaults.symbol).toString().toUpperCase();
    const timeframe = data.timeframe || botDefaults.defaultTimeframe || defaults.timeframe;

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
      // validate capital vs minNotional (ใช้ resolve แล้วจาก buildBotCreatePayload ด้านล่าง แต่เช็คเบื้องต้นจาก override ก่อนเพื่อ fail-fast)
      const capitalCandidate = parseFloat(data.capitalPerTrade ?? botDefaults.capitalPerTrade ?? defaults.capitalPerTrade);
      if (info.notional && capitalCandidate < info.notional.minNotional.toNumber()) {
        return res.status(400).json({
          error: `capitalPerTrade ${capitalCandidate} ต่ำกว่า minNotional ${info.notional.minNotional.toString()} ของ ${symbol}`,
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

    // FIX-2026-08-08: Feature #1 — Dynamic Position Sizing mutally exclusive with DCA stack mode
    //   - DPS adjusts size/layers per-trade based on win/loss history
    //   - DCA stack mode manages its own size/layers per layer (BEP-driven)
    //   - ทั้ง 2 ระบบปรับ size พร้อมกัน → conflict; user ต้องเลือกอย่างใดอย่างหนึ่ง
    const dpsEnabled = data.dynamicSizeEnabled !== false; // default true (lenient)
    if (dpsEnabled && (data.dcaEnabled === true || data.martingaleEnabled === true)) {
      return res.status(400).json({
        error: 'dynamicSizeEnabled is mutually exclusive with dcaEnabled/martingaleEnabled (Dynamic Position Sizing adjusts size per-trade; DCA stack manages its own layers). Disable one of them.',
      });
    }

    // FIX-2026-08-09: build payload จาก helper เดียว (DRY — share with autoAddBot)
    //   - data = req.body (explicit user input)
    //   - botDefaults = AppConfig.botDefaults (Settings section 1️⃣)
    //   - defaults = config.defaults (env-level fallback)
    const payload = buildBotCreatePayload({
      overrides: data,
      botDefaults,
      fallbacks: defaults,
      tier: licenseService.getTier ? licenseService.getTier() : null, // sync; cached licenseGate.lastLicense.tier
    });

    // `enabled` / `status` เป็น flow control (ไม่ใช่ default) — ใส่ที่นี่
    //   - default: false (เดิม) — preserve current behavior
    //   - enabled: true ถ้า client ส่ง data.enabled === true (atomic create+enable ใน 1 round-trip)
    payload.enabled = data.enabled === true;
    payload.status = data.enabled === true ? 'starting' : 'idle';

    const bot = await Bot.create(payload);

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
    // FIX-2026-08-08 (rev2): จำค่าเดิมไว้ตรวจว่า user แก้ capital/maxTrades เองหรือไม่ (แก้บั๊ก A4)
    const _prevCapital = bot.capitalPerTrade;
    const _prevMaxTrades = bot.maxTrades;
    const allowed = ['name', 'capitalPerTrade', 'maxTrades', 'tpPercent', 'retryTimeMin', 'retryMax', 'timeframe', 'stopLossOnUpperKC', 'autoUpdateTp', 'kcMult', 'minSpreadTicks', 's1OnlyDown', 'xs1Enabled', 'cbEnabled', 'cbv2Enabled', 'cbv2LockHours', 'cbv3Enabled', 'cbv3LockHours', 'safeTradeEnabled', 'safeTradeTrendlineEnabled', 'autoPauseEnabled', 'autoPauseMinKcPct', 'autoPauseMin24hVolUsdt', 'suggestTpWindow', 'autoArmStopLossOnUKC', 'autoArmLossPct', 'autoArmAgeHours', 'slUkcTriggerOnProfit', 'tpTrendMultiplier', 'tpTrendEnabled', 'dcaEnabled', 'dcaMaxLayers', 'martingaleEnabled', 'martingaleMultiplier', 'martingaleMaxLayerNotional', 'safeTradeNoTradeEnabled', 'dynamicSizeEnabled', 'cbAutoUnlockEnabled', 'cbAutoUnlockThresholdPct', // FIX-2026-08-05: audit fix — missing from allowed list caused bot-edit save to silently drop the field  // FIX-2026-08-06: CBv2 fields (cbv2Enabled, cbv2LockHours)  // FIX-2026-08-08: Feature #1+3 (dynamicSizeEnabled, cbAutoUnlockEnabled, cbAutoUnlockThresholdPct)  // FIX-2026-08-08: CBv3 fields (cbv3Enabled, cbv3LockHours) — added to whitelist for bulk update + bot-edit save  // FIX-2026-08-10: 24h vol guard field for Auto Pause-Resume  // FIX-2026-08-14: CBv5 fields (12 advanced params) — silent-drop bug exposed by botConfigIO import feature
      'cbv5Enabled', 'cbv5LockHours',
      'cbv5KcLen', 'cbv5KcMult',
      'cbv5PivotLookback', 'cbv5PivotLeftLen', 'cbv5PivotRightLen',
      'cbv5StrictBreak', 'cbv5UseVolume',
      'cbv5VolMaLen', 'cbv5VolMultiplier',
      'cbv5DebounceCandles',
    ];

    for (const k of allowed) {
      if (data[k] !== undefined) {
        if (k === 'capitalPerTrade' || k === 'tpPercent' || k === 'kcMult') {
          bot[k] = parseFloat(data[k]);
        } else if (k === 'tpTrendMultiplier') {
          // FIX-2026-07-31 (F2): TP ×N multiplier clamp 1..10
          bot[k] = Math.min(10, Math.max(1, parseFloat(data[k])));
        } else if (k === 'autoArmLossPct') {
          // FIX-2026-08-03 / EXT-2026-08-20: per-bot auto-arm loss threshold % (1..99, default 10)
          bot[k] = Math.min(99, Math.max(1, parseFloat(data[k])));
        } else if (k === 'autoArmAgeHours') {
          // FIX-2026-08-03 / EXT-2026-08-20: per-bot auto-arm age threshold hours (0.5..999, default 4)
          bot[k] = Math.min(999, Math.max(0.5, parseFloat(data[k])));
        } else if (k === 'slUkcTriggerOnProfit') {
          // FIX-2026-08-03: SL-UKC trigger on profitable positions (default false)
          bot[k] = data[k] === true || data[k] === 'true';
        } else if (k === 'safeTradeNoTradeEnabled') {
          // FIX-2026-08-05: Pine no-trade engulfing/SS filter (default false — opt-in)
          bot[k] = data[k] === true || data[k] === 'true';
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
        } else if (k === 'cbv2Enabled') {
          // FIX-2026-08-06: CBv2 sustained panic-sell toggle (default true)
          bot[k] = data[k] === true || data[k] === 'true';
        } else if (k === 'cbv2LockHours') {
          // FIX-2026-08-06: CBv2 lock duration hours (0.5..168, default 8)
          bot[k] = Math.min(168, Math.max(0.5, parseFloat(data[k])));
        } else if (k === 'dynamicSizeEnabled') {
          // FIX-2026-08-08: Feature #1 — Dynamic Position Sizing toggle (default ON)
          bot[k] = data[k] === true || data[k] === 'true';
        } else if (k === 'cbAutoUnlockEnabled') {
          // FIX-2026-08-08: Feature #3 — Auto Unlock Cooldown (default OFF)
          bot[k] = data[k] === true || data[k] === 'true';
        } else if (k === 'cbAutoUnlockThresholdPct') {
          // FIX-2026-08-08: Feature #3 — threshold Pct (0.5..5.0, default 1.0)
          bot[k] = Math.min(5.0, Math.max(0.5, parseFloat(data[k])));
        } else if (k === 'autoPauseMin24hVolUsdt') {
          // FIX-2026-08-10: 24h volume guard for Auto Pause-Resume (0..1B USDT, default 1M, integer)
          bot[k] = Math.min(1_000_000_000, Math.max(0, Math.round(parseFloat(data[k]))));
        } else if (k === 'cbv5Enabled' || k === 'cbv5StrictBreak' || k === 'cbv5UseVolume') {
          // FIX-2026-08-14: CBv5 boolean toggles — default true (cbv5Enabled) / true (strictBreak, useVolume)
          bot[k] = data[k] === true || data[k] === 'true';
        } else if (k === 'cbv5LockHours') {
          // FIX-2026-08-14: CBv5 lock duration (0.5..168, default 4)
          bot[k] = Math.min(168, Math.max(0.5, parseFloat(data[k])));
        } else if (k === 'cbv5KcLen') {
          // FIX-2026-08-14: KC length (5..100, integer, default 20)
          bot[k] = Math.min(100, Math.max(5, Math.floor(parseFloat(data[k]))));
        } else if (k === 'cbv5KcMult') {
          // FIX-2026-08-14: KC multiplier (0.5..5.0, default 1.2)
          bot[k] = Math.min(5, Math.max(0.5, parseFloat(data[k])));
        } else if (k === 'cbv5PivotLookback') {
          // FIX-2026-08-14: pivot lookback (2..10, integer, default 3)
          bot[k] = Math.min(10, Math.max(2, Math.floor(parseFloat(data[k]))));
        } else if (k === 'cbv5PivotLeftLen' || k === 'cbv5PivotRightLen') {
          // FIX-2026-08-14: pivot left/right lengths (2..50, integer, default 5)
          bot[k] = Math.min(50, Math.max(2, Math.floor(parseFloat(data[k]))));
        } else if (k === 'cbv5VolMaLen') {
          // FIX-2026-08-14: Volume MA length (5..100, integer, default 20)
          bot[k] = Math.min(100, Math.max(5, Math.floor(parseFloat(data[k]))));
        } else if (k === 'cbv5VolMultiplier') {
          // FIX-2026-08-14: volume spike multiplier (1.0..10.0, default 1.5)
          bot[k] = Math.min(10, Math.max(1.0, parseFloat(data[k])));
        } else if (k === 'cbv5DebounceCandles') {
          // FIX-2026-08-14: debounce candles (1..20, integer, default 5)
          bot[k] = Math.min(20, Math.max(1, Math.floor(parseFloat(data[k]))));
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

    // FIX-2026-08-08: Feature #1 — Dynamic Position Sizing mutually exclusive with DCA (post-merge check)
    //   - effectiveDps = data.dynamicSizeEnabled ?? existing dynamicSizeEnabled
    //   - reject ถ้าจะเปิด DPS แต่ DCA/Martingale เปิดอยู่ (ทั้งกรณี enable ใหม่ + กรณี DCA ถูกปิดแต่ DPS ถูก enable)
    const effectiveDps = data.dynamicSizeEnabled !== undefined
      ? (data.dynamicSizeEnabled === true || data.dynamicSizeEnabled === 'true')
      : bot.dynamicSizeEnabled !== false; // default true (matching schema default)
    if (effectiveDps && (effectiveDca || effectiveMartingale)) {
      return res.status(400).json({
        error: 'dynamicSizeEnabled is mutually exclusive with dcaEnabled/martingaleEnabled (Dynamic Position Sizing adjusts size per-trade; DCA stack manages its own layers). Disable one of them.',
      });
    }

    // FIX-2026-08-08 (rev2): reset DPS state เมื่อ user แก้ capitalPerTrade/maxTrades เอง (แก้บั๊ก A4)
    //   เดิม: dynamicSizeCurrent override buyNotionalUSDT ถาวร → แก้ capital ในหน้า bot-edit ไม่มีผลเลย
    //   ใหม่: ค่าที่ user ตั้งมีผลทันที แล้ว DPS เริ่มนับ streak ใหม่จากฐานใหม่
    if (bot.capitalPerTrade !== _prevCapital || bot.maxTrades !== _prevMaxTrades) {
      Object.assign(bot, dps.resetStateUpdate());
      logger.info({
        botId: bot._id.toString(),
        capital: `${_prevCapital} → ${bot.capitalPerTrade}`,
        maxTrades: `${_prevMaxTrades} → ${bot.maxTrades}`,
      }, 'bot.routes: capital/maxTrades changed by user → DPS state reset');
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

    // FIX-2026-08-03: invalidate Safe-trade #2 (trendline) cache เมื่อ timeframe เปลี่ยน
    //   - TREND_TF_MAP[timeframe] resolves different upper-TF → must re-fetch
    //   - also clears botManager's in-memory status cache so next scan rebuilds immediately
    if (data.timeframe !== undefined) {
      try {
        trendlineForBot.invalidate(bot.symbol, bot.timeframe);
        botManager.invalidateTrendlineCache(bot.symbol, bot.timeframe);
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
// FIX-2026-08-08: Feature #5 — soft delete (sets deletedAt) instead of hard delete
//   - stop trader if running
//   - set deletedAt = now (Bot retains in DB for 30 days)
//   - hard delete: out of scope for user (admin can run cleanup script)
//   - restore via POST /api/bots/:id/restore
//   - permanently delete via DELETE /api/bots/:id/permanent (admin-only)
router.delete('/:id', requireAuth, requireBotActionPassword, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    if (bot.enabled) {
      await botManager.stopTrader(bot._id);
    }
    // FIX-2026-08-08: soft delete instead of hard delete (autoDeleteBot + restore workflow)
    await Bot.updateOne(
      { _id: bot._id },
      { $set: { deletedAt: new Date(), enabled: false, status: 'disabled' } }
    );
    // FIX-2026-07-24: emit bot:deleted สำหรับ Telegram notifier (เดิมไม่มี — silent delete)
    eventBus.emit('bot:deleted', { botId: String(bot._id), name: bot.name });
    res.json({ ok: true, softDeleted: true, deletedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bots/:id/restore ────────────────────────
// FIX-2026-08-08: Feature #5 — restore a soft-deleted bot (within 30-day window)
router.post('/:id/restore', requireAuth, requireBotActionPassword, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    if (!bot.deletedAt) {
      return res.status(400).json({ error: 'Bot is not soft-deleted', deletedAt: null });
    }
    // FIX-2026-08-08: restore window check (30 days from deletedAt)
    const daysSinceDelete = (Date.now() - new Date(bot.deletedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceDelete > 30) {
      return res.status(400).json({
        error: 'Bot is beyond the 30-day restore window. Contact admin for backup restore.',
        daysSinceDelete: Math.floor(daysSinceDelete),
      });
    }
    bot.deletedAt = null;
    bot.scheduledDeleteAt = null;
    bot.deleteNotificationSentAt = null;
    bot.status = 'idle';
    await bot.save();
    eventBus.emit('bot:updated', { botId: String(bot._id) });
    logger.info({ botId: bot._id.toString() }, 'bot: restore — soft-deleted bot restored');
    res.json({ ok: true, bot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/bots/:id/permanent ───────────────────
// FIX-2026-08-08: Feature #5 — permanent delete (admin-only, requires password)
//   - bypasses 30-day window
//   - use for cleanup or user-requested immediate delete
// FIX-2026-08-08 ACTUSDT orphan-prevention: cleanup OPEN_STATES trades BEFORE Bot.deleteOne
//   - previous code deleted the Bot doc while leaving OPEN_STATES trades behind → ghost positions
//     reappeared in /api/bots/positions forever (no bot to attribute them to)
//   - fix: stop trader → cleanupOrphanTrades (synthetic-close, state='sold', sellStatus='FORCED_SYNTHETIC') → delete Bot
//   - admin should reconcile actual Binance fills separately (PnL will be 0 in the synthetic close —
//     manually re-edit if real fills were discovered after the fact, like we did for trade 6a75d52f)
router.delete('/:id/permanent', requireAuth, requireBotActionPassword, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    // 1) Stop trader (cancels any live orders on Binance)
    if (bot.enabled) {
      try {
        await botManager.stopTrader(bot._id);
      } catch (stopErr) {
        logger.warn({ botId: bot._id.toString(), err: stopErr.message }, 'bot.routes permanent-delete: stopTrader failed (continuing)');
      }
    }
    // 2) Synthetic-close any OPEN_STATES trades — prevents ghost positions
    let cleanup = { cleaned: [], errors: [] };
    try {
      cleanup = await forceClose.cleanupOrphanTrades({ botId: bot._id });
    } catch (cleanupErr) {
      logger.warn({ botId: bot._id.toString(), err: cleanupErr.message }, 'bot.routes permanent-delete: cleanupOrphanTrades failed (will still delete bot)');
    }
    // 3) Now safe to delete the Bot doc (all trades are 'sold' — no orphan positions will remain)
    await Bot.deleteOne({ _id: bot._id });
    eventBus.emit('bot:deleted', { botId: String(bot._id), name: bot.name, permanent: true });
    logger.warn({
      botId: bot._id.toString(),
      actorIp: req.ip,
      cleanedTrades: cleanup.cleaned.length,
      cleanupErrors: cleanup.errors.length,
    }, 'bot: permanent delete (admin)');
    res.json({
      ok: true,
      permanent: true,
      cleanup: {
        cleaned: cleanup.cleaned.length,
        errors: cleanup.errors.length,
        trades: cleanup.cleaned,
        errorDetails: cleanup.errors,
      },
    });
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

// ─── POST /api/bots/:id/unlock-cbv2 ──────────────────
// FIX-2026-08-07: HYBRID mode — ผู้ใช้กดปลด CBv2 cooldown (manual clear) ก่อน cbv2LockHours หมด
//   - HYBRID: CBv2 ไม่ disable บอท ไม่ override Auto-pause — endpoint นี้แค่ clear cooldown fields
//   - clear cbv2LockedUntil + cbv2LockReason + cbv2LastFiredAt ใน DB
//   - reset trader._cbv2FiredAt = 0 ใน instance (ถ้า trader ยังรัน) เพื่อให้ BUY gate ปลดทันที
//   - ไม่แตะ bot.enabled / bot.status / autoPauseReason — เป็นอิสระจาก Auto-pause
//   - ส่ง bot:updated + bot:unlocked event
//   - ใช้ requireBotActionPassword เพราะ unlock = admin-level action
// FIX-2026-08-08: Feature #2 — ปลด CBv3 ด้วยพร้อมกัน (shared endpoint — mutually exclusive in time but both fields cleared for cleanliness)
// FIX-2026-08-10: CBv5 added — clear CBv5 fields too (HYBRID unlock covers all 3 versions)
router.post('/:id/unlock-cbv2', requireAuth, requireBotActionPassword, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    if (!bot.cbv2LockReason && !bot.cbv3LockReason && !bot.cbv5LockReason) {
      return res.status(400).json({
        error: 'Bot is not CB-cooldown',
        cbv2LockedUntil: bot.cbv2LockedUntil,
        cbv3LockedUntil: bot.cbv3LockedUntil,
        cbv5LockedUntil: bot.cbv5LockedUntil,
      });
    }
    const wasLockedUntil = bot.cbv2LockedUntil;
    const wasLockReason = bot.cbv2LockReason;
    const wasCbv3LockedUntil = bot.cbv3LockedUntil;
    const wasCbv3LockReason = bot.cbv3LockReason;
    const wasCbv5LockedUntil = bot.cbv5LockedUntil;
    const wasCbv5LockReason = bot.cbv5LockReason;
    // FIX-2026-08-08: clear BOTH CBv2 + CBv3 fields (shared unlock endpoint)
    // FIX-2026-08-10: also clear CBv5 fields
    bot.cbv2LockedUntil = null;
    bot.cbv2LockReason = null;
    bot.cbv2LastFiredAt = null;
    bot.cbv3LockedUntil = null;
    bot.cbv3LockReason = null;
    bot.cbv3LastFiredAt = null;
    bot.cbv5LockedUntil = null;
    bot.cbv5LockReason = null;
    bot.cbv5LastFiredAt = null;
    await bot.save();

    // FIX-2026-08-07: reset in-memory trader._cbv2FiredAt (เพื่อให้ BUY gate ปลดทันที ไม่ต้องรอ restart)
    // FIX-2026-08-08: also reset _cbv3FiredAt
    // FIX-2026-08-10: also reset _cbv5FiredAt
    try {
      const botManager = require('../../core/botManager');
      const trader = botManager.traders && botManager.traders.get(String(req.params.id));
      if (trader) {
        trader._cbv2FiredAt = 0;
        trader._cbv3FiredAt = 0;
        trader._cbv5FiredAt = 0;
        logger.info({ botId: req.params.id.toString() }, 'bot: unlock-cbv2 — trader._cbv2FiredAt + _cbv3FiredAt + _cbv5FiredAt reset');
      }
    } catch (err) {
      // non-fatal: trader instance may not exist (bot disabled / not running)
      logger.warn({ err: err.message }, 'bot: unlock-cbv2 — trader reset failed (bot not running?)');
    }

    eventBus.emit('bot:updated', { botId: req.params.id });
    eventBus.emit('bot:unlocked', {
      botId: req.params.id,
      source: 'manual',
      wasLockedUntil, wasLockReason,
      wasCbv3LockedUntil, wasCbv3LockReason,
      wasCbv5LockedUntil, wasCbv5LockReason,
    });
    logger.info({
      botId: req.params.id.toString(),
      wasLockedUntil, wasLockReason,
      wasCbv3LockedUntil, wasCbv3LockReason,
      wasCbv5LockedUntil, wasCbv5LockReason,
    }, 'bot: unlock-cbv2 — CBv2+CBv3+CBv5 cooldown cleared by user');
    const fresh = await Bot.findById(req.params.id).lean();
    res.json({ ok: true, bot: fresh });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bots/:id/dps-reset ─────────────────────
// FIX-2026-08-08 (rev2): เคลียร์ DPS state ของบอทเดียว
//   - dynamicSizeCurrent/dynamicLayersCurrent → null (กลับไปใช้ capitalPerTrade/maxTrades)
//   - dynamicSizeLastResults → [] (เริ่มนับ streak ใหม่)
//   - ใช้เมื่อ state เพี้ยน หรืออยากให้ค่าที่ตั้งเองมีผลทันที
// FIX-2026-08-24: removed requireBotActionPassword per user request — DPS reset is
//   now treated as in-session admin action (same level as bulk-update). Operators
//   can still force-clear DPS state from bot-detail.html without password prompt.
router.post('/:id/dps-reset', requireAuth, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const before = { size: bot.dynamicSizeCurrent, layers: bot.dynamicLayersCurrent };
    Object.assign(bot, dps.resetStateUpdate());
    await bot.save();

    // sync in-memory trader snapshot (ไม่ต้องรอ restart)
    try {
      const trader = botManager.traders && botManager.traders.get(String(req.params.id));
      if (trader && trader.bot) Object.assign(trader.bot, dps.resetStateUpdate());
    } catch (err) {
      logger.warn({ err: err.message }, 'bot: dps-reset — trader snapshot sync failed (bot not running?)');
    }

    eventBus.emit('bot:updated', { botId: req.params.id });
    logger.info({ botId: req.params.id.toString(), before }, 'bot: dps-reset — DPS state cleared by user');
    const fresh = await Bot.findById(req.params.id).lean();
    res.json({ ok: true, before, bot: fresh });
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
// FIX-2026-08-04: ใช้ klineCache (server-side, populated by WS) ก่อน fall back ไป Binance REST
//   - cache hit: 0 Binance weight (KC + signal values match bot trader's exactly — same data source)
//   - cache miss: fall back 1 REST call (cold start / disabled bot / insufficient history)
//   - สำคัญ: คำนวณ KC + signals จาก FULL cached klines (ไม่ใช่ slice ก่อน) แล้ว slice ผลลัพธ์ทีหลัง
//     เพื่อให้ EMA seed (SMA 20 แรก) ใช้ประวัติยาวเหมือนที่ bot trader ใช้ → signals ตรงกัน 100%
//   - klineCache ถูก seed ตอน spawnTrader() (limit=200) → mini-chart default limit=40 cache hit เกือบ 100%
router.get('/:id/mini-chart', requireAuth, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id).lean();
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 5), 2000);

    // FIX-2026-08-04: try klineCache first (zero Binance weight)
    //   - format already matches: openTime/open/high/low/close/volume/closeTime (epoch ms)
    //   - includes in-progress candle (last entry = current if not closed)
    let fullKlines;
    let usedCache = false;
    const cached = klineCache.getAll(bot.symbol, bot.timeframe);
    if (cached.length >= Math.max(limit, 21)) {
      // ต้องมีอย่างน้อย max(limit, 21) → เพื่อ EMA warmup + ตัด slice หลังคำนวณ KC
      fullKlines = cached.map((c) => ({
        openTime: c.openTime,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume),
        closeTime: c.closeTime,
      }));
      usedCache = true;
      logger.debug({ botId: req.params.id, symbol: bot.symbol, tf: bot.timeframe, limit, cacheSize: cached.length }, 'mini-chart: cache hit');
    } else {
      // FIX-2026-08-04: cache insufficient (cold start / disabled bot / WS not seeded yet) → fall back to REST
      //   - fetch extra candles (limit + 20) เพื่อให้ EMA seed มี history พอ
      const fetchLimit = Math.min(limit + 20, 2000);
      const raw = await binanceRest.getKlines({
        symbol: bot.symbol,
        interval: bot.timeframe,
        limit: fetchLimit,
      });
      fullKlines = raw.map((k) => {
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
      logger.debug({ botId: req.params.id, symbol: bot.symbol, tf: bot.timeframe, limit, cacheSize: cached.length, fetched: fullKlines.length }, 'mini-chart: cache miss → REST fallback');
    }
    if (fullKlines.length === 0) {
      return res.json({ symbol: bot.symbol, timeframe: bot.timeframe, klines: [], keltner: { basis: [], upper: [], lower: [] }, signals: [], tradeMarkers: [] });
    }

    // FIX-2026-08-04: คำนวณ KC + S1 signals จาก FULL klines ก่อน → signals ตรงกับ bot trader
    // FIX-2026-07-24: per-bot kcMult + s1OnlyDown (default 1.5, false)
    // FIX-2026-07-25: xs1Enabled (per-bot toggle) — match trader's behavior for scan-volatility preview
    const { signals: allSignals, basis: fullBasis, upper: fullUpper, lower: fullLower } = signalEngine.detectS1Signals(fullKlines, {
      mult: bot.kcMult || 1.5,
      onlyDown: !!bot.s1OnlyDown,
      xs1Enabled: bot.xs1Enabled !== false,
    });

    // FIX-2026-08-04: slice last `limit` candles (พร้อม parallel keltner + signals) สำหรับ response
    const total = fullKlines.length;
    const startIdx = Math.max(0, total - limit);
    const klines = fullKlines.slice(startIdx);
    const basis = fullBasis.slice(startIdx);
    const upper = fullUpper.slice(startIdx);
    const lower = fullLower.slice(startIdx);
    // filter signals เฉพาะที่อยู่ใน slice
    const earliestOpenTime = klines[0].openTime;
    const signals = allSignals.filter((s) => s.openTime >= earliestOpenTime);

    // FIX-2026-07-24: ดึง BUY/SELL markers จาก Trade collection ภายใน window
    //   - เฉพาะ state ที่มีการเทรดจริง (filled/selling/sold — ไม่นับ placed/cancelled/failed)
    //   - ใช้ buyFilledAt + sellFilledAt เป็นเวลา (ถ้ามี)
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
    // FIX-2026-08-09: pass source='api' (UI) → sellReason = 'manual_api_force_close_trade'
    const result = await forceClose.forceCloseTrade({ trade, bot, allowMarketSell, source: 'api' });
    if (!result.ok) {
      return res.status(502).json({ error: result.error || 'force-close failed', result });
    }
    // FIX-2026-08-09: หลัง force-close เ�ร็จ — override sellReason ให้ระบุ source ชัด
    //   - forceCloseTrade({source:'api'}) จะตั้ง sellReason='manual_api_market' (generic)
    //   - เปลี่ยนเป็น 'manual_api_force_close_trade' เพื่อให้ filter/group รู้ว่าเป็น UI 1 trade
    await Trade.updateOne(
      { _id: trade._id, state: 'sold' },
      {
        $set: {
          sellReason: 'manual_api_force_close_trade',
          sellReasonSource: 'bot.routes.force-close-trade',
          sellReasonAt: new Date(),
        },
      }
    ).catch((err) => logger.warn({ err: err.message }, 'bot.routes: override sellReason after force-close-trade failed (non-fatal)'));
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
    // FIX-2026-08-09: pass source='api' (UI) → sellReason = 'manual_api_force_close_bot'
    const result = await forceClose.forceCloseBot({
      botId: bot._id,
      allowMarketSell,
      disableBot,
      source: 'api',
    });
    // FIX-2026-08-09: override sellReason ของ trades ที่เพิ่งปิด → 'manual_api_force_close_bot'
    //   - bulk update สำหรับ trades ที่เพิ่งถูก closed (state='sold')
    if (result.closedTrades && result.closedTrades.length > 0) {
      const tradeIds = result.closedTrades.map((t) => t.tradeId);
      await Trade.updateMany(
        { _id: { $in: tradeIds }, state: 'sold' },
        {
          $set: {
            sellReason: 'manual_api_force_close_bot',
            sellReasonSource: 'bot.routes.force-close-bot',
            sellReasonAt: new Date(),
          },
        }
      ).catch((err) => logger.warn({ err: err.message }, 'bot.routes: override sellReason after force-close-bot failed (non-fatal)'));
    }
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

    // FIX-2026-08-05: decorate open trades with upper-KC + predicted exit (zero Binance weight via klineCache)
    //   - single-bot detail page shows same AU prediction panel as cross-bot /api/bots/positions modal
    //   - reuse the same prediction helper for consistency
    let detailUsdtToThbRate = null;
    try {
      const fxMod = require('../../services/fxService');
      if (fxMod && typeof fxMod.getUsdtToThb === 'function') {
        const rate = await fxMod.getUsdtToThb().catch(() => null);
        if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
          detailUsdtToThbRate = rate;
        }
      }
    } catch (_) { /* ignore */ }
    const detailUpperKCMap = await prediction.computeUpperKCPrices([
      { symbol: bot.symbol, timeframe: bot.timeframe, kcMult: bot.kcMult },
    ], { restFallback: true });
    const detailKCInfo = detailUpperKCMap.get(prediction.makeKey(bot.symbol, bot.timeframe));
    const decorateWithPrediction = (t) => {
      if (!t) return t;
      const pred = prediction.computePredictionForTrade(t, detailKCInfo, detailUsdtToThbRate);
      return {
        ...t,
        upperKC: pred && Number.isFinite(pred.upperKC) ? pred.upperKC : null,
        predictedSellPrice: pred && Number.isFinite(pred.predictedSellPrice) ? pred.predictedSellPrice : null,
        predictedLossUsdt: pred && Number.isFinite(pred.predictedLossUsdt) ? pred.predictedLossUsdt : null,
        predictedLossPct: pred && Number.isFinite(pred.predictedLossPct) ? pred.predictedLossPct : null,
        predictedLossThb: pred && Number.isFinite(pred.predictedLossThb) ? pred.predictedLossThb : null,
        predictionWarmup: !!(pred && pred.warmup),
        predictionComputedAt: detailKCInfo && detailKCInfo.computedAt ? detailKCInfo.computedAt : null,
        kcCachedCandles: pred && Number.isFinite(pred.cachedCandles) ? pred.cachedCandles : 0,
        predictionSource: detailKCInfo && detailKCInfo.source ? detailKCInfo.source : null,
        kcMult: bot.kcMult ?? null,
      };
    };

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
      activeTrade: decorateWithPrediction(activeTrade),
      trades: trades.map(decorateWithPrediction),
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
// FIX-2026-08-24: removed requireBotActionPassword per user request — bulk-update is
//   an in-session admin action. Used by Master Config "ใช้ค่ากับบอทที่เลือก" — no
//   password prompt needed since user is already authenticated.
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
      's1OnlyDown', 'xs1Enabled', 'cbEnabled', 'cbv2Enabled', 'cbv2LockHours', 'cbv3Enabled', 'cbv3LockHours', 'safeTradeEnabled',
      // FIX-2026-08-03: Safe-trade filter #2 (trendline) — bulk-update support
      'safeTradeTrendlineEnabled',
      // FIX-2026-08-05: Safe-trade filter #3 (no-trade engulfing/SS) — bulk-update support
      'safeTradeNoTradeEnabled',
      'autoPauseEnabled', 'autoPauseMinKcPct', 'autoPauseMin24hVolUsdt',
      'suggestTpWindow', 'autoArmStopLossOnUKC', 'autoArmLossPct', 'autoArmAgeHours', 'slUkcTriggerOnProfit',
      'tpTrendMultiplier', 'tpTrendEnabled',
      'dcaEnabled', 'dcaMaxLayers',
      // FIX-2026-08-03: Martingale fields (Master Config support)
      'martingaleEnabled', 'martingaleMultiplier', 'martingaleMaxLayerNotional',
      // FIX-2026-08-08: Feature #1+3 — DPS + Auto Unlock Cooldown (Master Config support)
      'dynamicSizeEnabled', 'cbAutoUnlockEnabled', 'cbAutoUnlockThresholdPct',
      // FIX-2026-08-10: CBv5 (Support Zone + Deepest Low + Volume Filter) — bulk-update support
      //   CBv5 is independent of cbVersion enum — runs parallel with CBv2/CBv3.
      'cbv5Enabled', 'cbv5LockHours',
      // CBv5 advanced params (KC + Pivot + Volume + Debounce)
      'cbv5KcLen', 'cbv5KcMult',
      'cbv5PivotLookback', 'cbv5PivotLeftLen', 'cbv5PivotRightLen',
      'cbv5StrictBreak', 'cbv5UseVolume',
      'cbv5VolMaLen', 'cbv5VolMultiplier',
      'cbv5DebounceCandles',
    ];
    const update = {};
    for (const k of allowed) {
      if (k in settings) update[k] = settings[k];
    }
    if (Number.isFinite(update.autoPauseMinKcPct)) update.autoPauseMinKcPct = Math.max(0.1, Math.min(50, update.autoPauseMinKcPct));
    // FIX-2026-08-10: 24h vol guard clamp (0..1B USDT, integer)
    if (Number.isFinite(update.autoPauseMin24hVolUsdt)) update.autoPauseMin24hVolUsdt = Math.max(0, Math.min(1_000_000_000, Math.round(update.autoPauseMin24hVolUsdt)));
    // FIX-2026-08-03 / EXT-2026-08-20: F1 auto-arm thresholds + profit trigger (bulk-update support)
    if (Number.isFinite(update.autoArmLossPct)) update.autoArmLossPct = Math.max(1, Math.min(99, update.autoArmLossPct));
    if (Number.isFinite(update.autoArmAgeHours)) update.autoArmAgeHours = Math.max(0.5, Math.min(999, update.autoArmAgeHours));
    if ('slUkcTriggerOnProfit' in update) update.slUkcTriggerOnProfit = update.slUkcTriggerOnProfit === true || update.slUkcTriggerOnProfit === 'true';
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
    // FIX-2026-08-06: CBv2 field validation (bulk-update support)
    if ('cbv2Enabled' in update) update.cbv2Enabled = update.cbv2Enabled === true || update.cbv2Enabled === 'true';
    if (Number.isFinite(update.cbv2LockHours)) update.cbv2LockHours = Math.max(0.5, Math.min(168, update.cbv2LockHours));
    // FIX-2026-08-08: CBv3 field validation (bulk-update support)
    if ('cbv3Enabled' in update) update.cbv3Enabled = update.cbv3Enabled === true || update.cbv3Enabled === 'true';
    if (Number.isFinite(update.cbv3LockHours)) update.cbv3LockHours = Math.max(0.5, Math.min(168, update.cbv3LockHours));
    // FIX-2026-08-10: CBv5 field validation (bulk-update support)
    if ('cbv5Enabled' in update) update.cbv5Enabled = update.cbv5Enabled === true || update.cbv5Enabled === 'true';
    if (Number.isFinite(update.cbv5LockHours)) update.cbv5LockHours = Math.max(0.5, Math.min(168, update.cbv5LockHours));
    // FIX-2026-08-10: CBv5 advanced params validation (KC + Pivot + Volume + Debounce)
    if (Number.isFinite(update.cbv5KcLen)) update.cbv5KcLen = Math.max(5, Math.min(100, Math.floor(update.cbv5KcLen)));
    if (Number.isFinite(update.cbv5KcMult)) update.cbv5KcMult = Math.max(0.5, Math.min(5, update.cbv5KcMult));
    if (Number.isFinite(update.cbv5PivotLookback)) update.cbv5PivotLookback = Math.max(2, Math.min(10, Math.floor(update.cbv5PivotLookback)));
    if (Number.isFinite(update.cbv5PivotLeftLen)) update.cbv5PivotLeftLen = Math.max(2, Math.min(50, Math.floor(update.cbv5PivotLeftLen)));
    if (Number.isFinite(update.cbv5PivotRightLen)) update.cbv5PivotRightLen = Math.max(2, Math.min(50, Math.floor(update.cbv5PivotRightLen)));
    if ('cbv5StrictBreak' in update) update.cbv5StrictBreak = update.cbv5StrictBreak === true || update.cbv5StrictBreak === 'true';
    if ('cbv5UseVolume' in update) update.cbv5UseVolume = update.cbv5UseVolume === true || update.cbv5UseVolume === 'true';
    if (Number.isFinite(update.cbv5VolMaLen)) update.cbv5VolMaLen = Math.max(5, Math.min(100, Math.floor(update.cbv5VolMaLen)));
    if (Number.isFinite(update.cbv5VolMultiplier)) update.cbv5VolMultiplier = Math.max(1.0, Math.min(10, update.cbv5VolMultiplier));
    if (Number.isFinite(update.cbv5DebounceCandles)) update.cbv5DebounceCandles = Math.max(1, Math.min(20, Math.floor(update.cbv5DebounceCandles)));

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
    // FIX-2026-08-24 (P1 audit): stagger between TF-change restarts
    //   - เดิม 50-500 บอท TF เปลี่ยนพร้อมกัน → 50×30=1500 weight burst → 418 IP ban
    //   - fix: sleep SPAWN_STAGGER_MS ระหว่าง iterations → average ~70 calls/s (ใต้ refill 100/s)
    let traderRestarts = 0;
    const restartErrors = [];
    for (let i = 0; i < tfChangeBotIds.length; i++) {
      const id = tfChangeBotIds[i];
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
      // stagger between iterations — skip after last
      if (i < tfChangeBotIds.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, SPAWN_STAGGER_MS));
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
// FIX-2026-08-24: removed requireBotActionPassword per user request — cache
//   invalidation is a no-op admin convenience, no destructive side-effects.
router.post('/invalidate-volatility-cache', requireAuth, async (req, res) => {
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
// FIX-2026-08-24: removed requireBotActionPassword per user request — bulk-toggle is
//   in-session admin action (start/stop multiple bots at once).
router.post('/bulk-toggle', requireAuth, async (req, res) => {
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
    // FIX-2026-08-24 (P1 audit): stagger between iterations
    //   - 100 bots × enable path อาจ spawn trader → symbolInfo.loadSymbol(weight 20) × 100 = 2000 weight burst
    //   - fix: sleep SPAWN_STAGGER_MS between iterations → average ~3 bots/s
    for (let i = 0; i < botIds.length; i++) {
      const id = botIds[i];
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
      // FIX-2026-08-24 (P1 audit): stagger between iterations — skip after last
      if (i < botIds.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, SPAWN_STAGGER_MS));
      }
    }

    // FIX-2026-08-02: invalidate caches ของทุกบอทที่สำเร็จ (เผื่อ action ในอนาคตมี config-affecting effects)
    for (const r of results) {
      if (r.ok) {
        try {
          const b = await Bot.findById(r.botId).lean();
          if (b) {
            volatilityForBot.invalidate(b.symbol, b.timeframe);
            // FIX-2026-08-03: invalidate Safe-trade #2 (trendline) cache after TF change
            try {
              trendlineForBot.invalidate(b.symbol, b.timeframe);
              botManager.invalidateTrendlineCache(b.symbol, b.timeframe);
            } catch (_) { /* ignore */ }
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

// FIX-2026-08-22: Master Config — bulk-restore บอทที่ถูก soft-delete หลายตัวพร้อมกัน
//   - ใช้ requireBotActionPassword เพราะ restore = lifecycle action (เ�มือน bulk-toggle)
//   - body: { botIds: [string], password?: string }
//   - ทำทีละตัว sequentially — ป้องกัน race + emit bot:updated ต่อบอท
//   - แต่ละบอท restore ผ่าน logic เดียวกับ POST /:id/restore (clear deletedAt, scheduledDeleteAt, deleteNotificationSentAt)
//   - ไม่ spawn trader ใหม่ — user ต้องกด "▶️ Start" แยกต่างหาก (เพื่อให้ตัดสินใจเอง)
//   - response: { ok: true, results: [{ botId, ok, error?, daysSinceDelete? }], succeeded, failed }
// FIX-2026-08-24: removed requireBotActionPassword per user request — bulk-restore
//   is in-session admin action (restore soft-deleted bots).
router.post('/bulk-restore', requireAuth, async (req, res) => {
  try {
    const { botIds } = req.body || {};
    if (!Array.isArray(botIds) || botIds.length === 0) {
      return res.status(400).json({ error: 'botIds must be a non-empty array' });
    }
    // cap เพื่อกัน DoS (เหมือน bulk-toggle)
    if (botIds.length > 100) {
      return res.status(400).json({ error: 'botIds must be <= 100 per request' });
    }

    const results = [];
    let succeeded = 0;
    let failed = 0;
    // รัน sequentially — restore = simple DB write + emit event (no Binance call → safe to sequential)
    for (const id of botIds) {
      try {
        const bot = await Bot.findById(id);
        if (!bot) {
          throw new Error('Bot not found');
        }
        if (!bot.deletedAt) {
          // skip silently — frontend filter ควรป้องกันไม่ให้ส่งบอทที่ยังไม่ลบ
          //   แต่ถ้าส่งมาจริง ๆ → �ายงาน ok=false เพื่อให้ UI แสดง feedback
          throw new Error('Bot is not soft-deleted');
        }
        const daysSinceDelete = (Date.now() - new Date(bot.deletedAt).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceDelete > 30) {
          throw new Error('Bot is beyond the 30-day restore window. Contact admin for backup restore.');
        }
        bot.deletedAt = null;
        bot.scheduledDeleteAt = null;
        bot.deleteNotificationSentAt = null;
        bot.status = 'idle';
        await bot.save();
        eventBus.emit('bot:updated', { botId: String(bot._id) });
        results.push({ botId: String(id), ok: true, name: bot.name || bot.symbol, daysSinceDelete: Math.floor(daysSinceDelete) });
        succeeded += 1;
      } catch (err) {
        results.push({ botId: String(id), ok: false, error: err.message });
        failed += 1;
      }
    }

    logger.info({
      requested: botIds.length,
      succeeded,
      failed,
    }, 'bots: bulk-restore applied');
    res.json({ ok: true, succeeded, failed, results });
  } catch (err) {
    logger.error({ err: err.message }, 'bot bulk-restore failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;