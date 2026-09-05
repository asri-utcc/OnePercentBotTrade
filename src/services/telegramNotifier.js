'use strict';

// FIX-2026-07-24: Telegram notifier service
//   - subscribe eventBus singleton (src/services/eventBus.js)
//   - ส่งข้อความไป Telegram ผ่าน https.request (Node built-in, ไม่เพิ่ม dependency)
//   - periodic scan ทุก 30s/60s สำหรับ position PnL threshold + stuck duration
//   - anti-spam ผ่าน tradeNotifyState Map (per-trade crossing latch + stuck-once latch)
//   - persist config ใน AppConfig (token encrypted AES-256-GCM ผ่าน src/services/crypto.js)

const https = require('https');
const logger = require('../utils/logger');
const eventBus = require('./eventBus');
const AppConfig = require('../db/models/AppConfig');
const Trade = require('../db/models/Trade');
const Bot = require('../db/models/Bot');
const { encrypt, decrypt } = require('./crypto');
const fxService = require('./fxService'); // FIX-2026-07-26: USDT→THB สำหรับ sellFilled PnL THB
const binanceRest = require('../binance/binanceRest'); // FIX-2026-07-27: USDT balance remain หลัง fill
const symbolInfo = require('../binance/symbolInfo'); // FIX-2026-07-31: formatPrice ตาม tickSize (authoritative)
const alertConfig = require('./alertConfig'); // FIX-2026-08-27 Phase 3b-2: custom alert thresholds (cbPanicMinPositions + quietHours)

// ─── Defaults (mirror AppConfig schema) ───────────────
const DEFAULT_EVENTS = {
  buyFilled: true, sellFilled: true, insufficientBalance: true,
  botEnabled: true, botDisabled: true, botDeleted: true,
  positionLoss: true, positionProfit: true, positionStuck: true,
  // FIX-2026-07-26: สรุปการเทรดรายวัน/สัปดาห์/เดือน (3 messages — ส่งพร้อมกันตอน HH:00:00)
  dailySummary: true, weeklySummary: true, monthlySummary: true,
  // FIX-2026-07-26: เตือนเมื่อ NET TP% ต่ำกว่า threshold (0.2%) — เฉพาะบอทที่เปิด autoUpdateTp
  tpLowPnL: true,
  // FIX-2026-08-01: Circuit-breaker (CB) panic-sell — เดิมชื่อ sls1PanicClose (ไม่มีใน list มาก่อน)
  cbPanicClose: true,
  // FIX-2026-08-06: CBv2 — sustained 3-candle breach lock (strict CB + lock บอท cbv2LockHours hours)
  cbv2PanicClose: true,
  // FIX-2026-08-06: แจ้งเมื่อบอทถูก lock (cbv2 lock activate) — anti-spam: ส่งครั้งเดียวต่อ lock
  botLocked: true,
  // FIX-2026-08-03: Safe-trade filter #2 (trendline) status transitions pass↔blocked (anti-spam: เฉพาะ transition)
  trendlineStatusChanged: true,
  // FIX-2026-08-02: DCA + BEP stack events (per user request: full notifications, not compact)
  dcaLayerAdded: true, dcaTargetHit: true, dcaMaxLayersHit: true,
  // FIX-2026-08-05: BNB balance low alert — กัน BNB-empty fee-deduct incident ซ้ำ (เติม BNB ก่อนหมด)
  bnbLowBalance: true,
  // FIX-2026-08-05: Auto-Buy BNB — ผลของการเติม BNB (success/failed/skipped) — critical ดูแต่ละครั้ง
  bnbAutoBuy: true,
  // FIX-2026-08-06: Binance delist monitor — แจ้งเมื่อ symbol ติด Monitoring tag / เข้า delist schedule
  //   - delistDetected: confirmed delist (Binance ประกาศแล้ว มี delistTime) — anti-spam latch กันซ้ำ
  //   - delistMonitoring: early warning (Binance ติด Monitoring tag แต่ยังไม่ประกาศวัน) — critical warning
  delistDetected: true,
  delistMonitoring: true,
  // FIX-2026-08-06: delist-driven force-close (จาก botManager.checkDelistScheduleBots Phase B)
  positionForceClosed: true,
  // FIX-2026-08-06: SELL slippage warning — SELL fill below target > 3% (severe slip, often MARKET fallback)
  //   - แจ้งเตือนเพื่อให้ตรวจสอบ (อาจเป็น holding-retry MARKET หรือ admin close)
  slippageWarning: true,
  // FIX-2026-08-07: Auto Add New Bot — แจ้งเตือนเมื่อระบบ auto-create บอทใหม่
  //   - ส่งทุกครั้งที่มีการสร้างบอทจาก autoAddBot service (manual/periodic)
  autoAddBotCreated: true,
  // FIX-2026-08-23: Auto Add Bot restore + activate soft-deleted bot
  autoAddBotRestored: true,
  // FIX-2026-08-08: Feature #1 — Dynamic Position Sizing resize notification (size/layers changed)
  //   - แจ้งเฉพาะเมื่อ size หรือ layers เปลี่ยนจริง (changed=true)
  //   - ระบุ reason (3-wins / 2-wins-2pct / loss) + before/after
  dpsResize: true,
  // FIX-2026-08-08: Feature #2 — CBv3 panic-close (mirror cbv2PanicClose but with ST3 upper-TF)
  cbv3PanicClose: true,
  // FIX-2026-08-10: Feature #6 — CBv5 panic-close (Support Zone broken — independent of cbVersion)
  cbv5PanicClose: true,
  // FIX-2026-08-08: Feature #3 — Auto unlock cooldown (CB auto-unlocked after 3 profitable signals)
  //   - แจ้งเมื่อระบบปลด cooldown ให้บอทอัตโนมัติ (3+ signals > threshold)
  botAutoUnlocked: true,
  // FIX-2026-08-08: Feature #5 — Auto Delete Bot (soft-delete) lifecycle events
  //   - autoDeleteBotWarning: แจ้งล่วงหน้า N วันก่อน soft-delete
  //   - autoDeleteBotRemoved: แจ้งเมื่อ soft-delete แล้ว
  autoDeleteBotWarning: true,
  autoDeleteBotRemoved: true,
  // FIX-2026-08-09: Telegram Login — alternative login channel (ส่ง OTP 6 หลักเข้า Telegram)
  //   - ใช้แทน password เมื่อลืม — ไม่ใช่ 2FA
  //   - default ON (user ปิดเองได้ใน Settings > Telegram Events)
  telegramLogin: true,
  // FIX-2026-08-24: Login brute-force lock alert — แจ้ง admin เมื่อ IP/account ถูก lock
  //   - trigger: loginGuard escalation (level 1+) หรือ account lock
  //   - caller latches per-IP via loginGuard (1 alert ต่อ lock event)
  //   - default ON — admin ควรรู้ทันทีถ้ามี brute-force attempt
  loginLocked: true,
  // FIX-2026-08-14: Orphan BUY filled on disabled bot — BUY filled แต่บอทปิดอยู่
  //   (trader ถูก stop ไปแล้ว) → ไม่มีใคร place SELL → ค้างใน DB state='filled' + balance ค้างบน Binance
  //   ก่อนหน้านี้ silent log → user ไม่รู้จนกว่าจะสังเกตเห็น "10 positions vs 9 open orders" ใน UI
  //   ตอนนี้ส่ง telegram alert ทันที + latch ใน DB (orphanLatchedAt) กัน spam ทุก 5 นาที
  orphanBuyFilled: true,
  // FIX-2026-08-30 / Phase 4: Auto-Timing (heatmap-driven entry gate) — premium feature, default OFF
  //   - autoTimingWeeklySummary: สรุป actions + tier-2 promotions + suppress hits รายสัปดาห์ (Mon 00:05)
  //   - autoTimingSuppressHit: แจ้งเมื่อ trader ข้าม BUY เพราะ Suppress cell (latch 1/bot/day)
  autoTimingWeeklySummary: false,
  autoTimingSuppressHit: false,
};
const DEFAULT_THRESHOLDS = {
  positionLossPct: 2, positionProfitPct: 1, positionStuckMin: 30,
  // FIX-2026-08-05: BNB low-balance alert threshold (USDT value of BNB qty × BNB/USDT price)
  //   - ถ้า (bnbQty × bnbUsdtPrice) < threshold → แจ้งเตือน (default $0.50)
  bnbLowBalanceUsdt: 0.5,
  // FIX-2026-08-27 Phase 3b-2: Custom Alert Thresholds (per-event filters)
  //   - cbPanicMinPositions: suppress CB panic-close if closedCount < N (default 1 = always send)
  //   - quietHours*: suppress ALL alerts during [start, end) window (default OFF)
  cbPanicMinPositions: 1,
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
};

// Anti-spam: per-trade state เพื่อกัน flood
//   side: 'loss' | 'profit' | null — last side ที่แจ้งไปแล้ว (notify เฉพาะตอน crossing)
//   stuckNotified: bool — set true หลังแจ้ง stuck ครั้งแรก, reset ตอน trade จบ
const tradeNotifyState = new Map(); // tradeId -> { side, stuckNotified }

// In-memory price cache (last bookTicker per symbol)
const lastBookTicker = new Map(); // symbol -> { bid, ask, ts }

// FIX-2026-07-27: USDT balance cache (free + locked) — กัน Binance hammering
//   - cache TTL 10s (พอสำหรับ burst BUY/SELL ในรอบเดียว)
//   - ถ้า fetch fail → return null (ไม่แสดง balance remain)
let usdtBalanceCache = null; // { free, locked, total, ts }
const USDT_BALANCE_CACHE_MS = 10 * 1000;

async function fetchUsdtBalance() {
  const now = Date.now();
  if (usdtBalanceCache && (now - usdtBalanceCache.ts) < USDT_BALANCE_CACHE_MS) {
    return usdtBalanceCache;
  }
  try {
    const acc = await binanceRest.getAccount();
    const row = (acc.balances || []).find((b) => b.asset === 'USDT');
    if (!row) {
      usdtBalanceCache = { free: 0, locked: 0, total: 0, ts: now };
      return usdtBalanceCache;
    }
    const free = parseFloat(row.free) || 0;
    const locked = parseFloat(row.locked) || 0;
    usdtBalanceCache = { free, locked, total: free + locked, ts: now };
    return usdtBalanceCache;
  } catch (err) {
    logger.warn({ err: err.message }, 'telegramNotifier: fetchUsdtBalance failed');
    return null;
  }
}

// FIX-2026-08-05: BNB balance cache — qty + USDT value, shared with frontend
//   - 30s TTL (longer than USDT cache 10s — BNB is for fee, not active trading)
//   - usdtValue = bnbQty × BNBUSDT bid (ใช้ bid เพราะถ้า sell BNB จะได้ราคา bid)
//   - ถ้า fetch fail → return null + keep stale cache (ไม่ invalidate ทันที — fail-open)
//   - shared กับ /api/account/bnb-status ผ่าน module.exports.getBnbBalanceCached
let bnbBalanceCache = null; // { qty, usdtPrice, usdtValue, ts }
const BNB_BALANCE_CACHE_MS = 30 * 1000;

async function fetchBnbBalance() {
  const now = Date.now();
  if (bnbBalanceCache && (now - bnbBalanceCache.ts) < BNB_BALANCE_CACHE_MS) return bnbBalanceCache;
  try {
    const acc = await binanceRest.getAccount();
    const row = (acc.balances || []).find((b) => b.asset === 'BNB');
    const qty = row ? (parseFloat(row.free) || 0) + (parseFloat(row.locked) || 0) : 0;
    // BNB/USDT price — prefer in-memory lastBookTicker (free, WS-driven)
    //   - fallback REST bookTicker ถ้าไม่มี bot BNBUSDT → lastBookTicker ว่าง
    let usdtPrice = 0;
    const cached = lastBookTicker.get('BNBUSDT');
    if (cached && cached.bid && (now - cached.ts) < 60_000) {
      usdtPrice = parseFloat(cached.bid);
    } else {
      const ticker = await binanceRest.getBookTicker('BNBUSDT');
      usdtPrice = parseFloat(ticker.bidPrice) || 0;
    }
    const usdtValue = qty * usdtPrice;
    bnbBalanceCache = { qty, usdtPrice, usdtValue, ts: now };
    return bnbBalanceCache;
  } catch (err) {
    logger.warn({ err: err.message }, 'telegramNotifier: fetchBnbBalance failed');
    return null;
  }
}

function invalidateBnbBalanceCache() {
  bnbBalanceCache = null;
}

function getBnbBalanceCached() {
  return bnbBalanceCache; // may be null if never fetched
}

// FIX-2026-08-04: 30s → 120s (ลด DB load — telegram PnL scan เป็น read-only display)
const PNL_SCAN_INTERVAL_MS = 120 * 1000;
const STUCK_SCAN_INTERVAL_MS = 180 * 1000; // FIX-2026-08-04: 60s → 180s (read-only scan)
const TELEGRAM_API_TIMEOUT_MS = 8000;
const CONFIG_RELOAD_MS = 60 * 1000; // 60s in-memory config cache

let pnlTimer = null;
let stuckTimer = null;
let summaryTimer = null; // FIX-2026-07-26: check ทุก 60s ว่าถึงเวลาส่ง summary หรือยัง
let configCache = null;
let configLoadedAt = 0;
let bound = false;
// FIX-2026-07-26: last sent timestamp ต่อ period (กันส่งซ้ำในรอบ tick เดียวกัน)
//   - daily: 'YYYY-MM-DD', weekly: 'YYYY-Www', monthly: 'YYYY-MM'
const lastSummarySent = { day: null, week: null, month: null, autoTimingWeek: null };

// ─── Config loader ────────────────────────────────────
async function loadConfig(force = false) {
  const now = Date.now();
  if (!force && configCache && (now - configLoadedAt) < CONFIG_RELOAD_MS) return configCache;
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    const hasToken = !!(cfg && cfg.telegramBotTokenEnc && cfg.telegramBotTokenEnc.length > 0);
    let token = null;
    if (hasToken) {
      try {
        token = decrypt({
          ciphertext: cfg.telegramBotTokenEnc,
          iv: cfg.telegramBotTokenIv,
          authTag: cfg.telegramBotTokenAuthTag,
        });
      } catch (err) {
        logger.warn({ err: err.message }, 'telegramNotifier: token decrypt failed — token may be corrupted');
        token = null;
      }
    }
    configCache = {
      enabled: !!(cfg && cfg.telegramEnabled),
      hasToken,
      token,
      chatId: (cfg && cfg.telegramChatId) || '',
      events: Object.assign({}, DEFAULT_EVENTS, (cfg && cfg.telegramEvents) || {}),
      thresholds: Object.assign({}, DEFAULT_THRESHOLDS, (cfg && cfg.telegramThresholds) || {}),
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'telegramNotifier: loadConfig failed');
    configCache = {
      enabled: false, hasToken: false, token: null, chatId: '',
      events: DEFAULT_EVENTS, thresholds: DEFAULT_THRESHOLDS,
    };
  }
  configLoadedAt = now;
  return configCache;
}

async function reloadConfig() {
  return loadConfig(true);
}

// ─── Public dispatcher ────────────────────────────────
// eventKey: 'buyFilled' | 'sellFilled' | 'insufficientBalance' | 'botEnabled'
//          | 'botDisabled' | 'botDeleted' | 'positionLoss' | 'positionProfit' | 'positionStuck'
//
// FIX-2026-08-12 (audit Q12): per-bot CB panic-close dedup latch.
//   - trader + watchdog + manual force-close can fire CB panic-close for same bot
//     within 60s. Without dedup, user gets 2-3 duplicate alerts.
//   - Latch: per-bot per-version (v2/v3/v5) last-notified timestamp. Suppress
//     if < 60s. Reset on bot:unlocked event (user manually clears cooldown).
const CB_DEDUP_EVENTS = new Set(['cbv2PanicClose', 'cbv3PanicClose', 'cbv5PanicClose']);
const CB_DEDUP_WINDOW_MS = 60 * 1000; // 60s
const _cbNotifiedAt = new Map(); // key: `${version}:${botId}` → ms

function _checkCbDedup(eventKey, payload) {
  if (!CB_DEDUP_EVENTS.has(eventKey)) return true;
  const botId = payload && payload.botId;
  if (!botId) return true; // no botId → don't dedup (allow)
  const version = eventKey.replace('cbv', '').replace('PanicClose', ''); // '2'|'3'|'5'
  const key = `${version}:${botId}`;
  const now = Date.now();
  const last = _cbNotifiedAt.get(key);
  if (last && (now - last) < CB_DEDUP_WINDOW_MS) {
    logger.info({
      eventKey, botId, version,
      lastNotifiedMs: last,
      skippedMs: now - last,
    }, 'telegramNotifier: CB panic-close deduped (recently sent)');
    return false;
  }
  _cbNotifiedAt.set(key, now);
  return true;
}

function _resetCbDedup(botId) {
  if (!botId) return;
  for (const key of _cbNotifiedAt.keys()) {
    if (key.endsWith(`:${botId}`)) _cbNotifiedAt.delete(key);
  }
}

async function dispatch(eventKey, payload) {
  const cfg = await loadConfig();
  if (!cfg.enabled || !cfg.hasToken || !cfg.chatId) return false;
  if (!cfg.events[eventKey]) return false;
  if (!_checkCbDedup(eventKey, payload)) return false;
  // FIX-2026-08-27 Phase 3b-2: per-event threshold filters (after dedup, before render)
  //   - CB panic-close: suppress if closedCount < cbPanicMinPositions
  //   - quiet hours: suppress ALL alerts during [start, end) window (default OFF)
  //   - critical alerts (anti-tamper, login-locked) bypass via cbPanicMinPositions check
  //     because they're not in CB_DEDUP_EVENTS set, so shouldAlertCbPanic is skipped
  if (CB_DEDUP_EVENTS.has(eventKey)) {
    if (!alertConfig.shouldAlertCbPanic(payload && payload.closedCount, cfg.thresholds)) {
      logger.info({
        eventKey, botId: payload && payload.botId,
        closedCount: payload && payload.closedCount,
        cbPanicMinPositions: cfg.thresholds.cbPanicMinPositions,
      }, 'telegramNotifier: CB panic-close suppressed (below cbPanicMinPositions)');
      return false;
    }
  }
  if (alertConfig.isInQuietHours(new Date(), cfg.thresholds)) {
    logger.info({
      eventKey, botId: payload && payload.botId,
      quietStart: cfg.thresholds.quietHoursStart,
      quietEnd: cfg.thresholds.quietHoursEnd,
    }, 'telegramNotifier: alert suppressed (quiet hours)');
    return false;
  }
  const result = renderMessage(eventKey, payload, cfg);
  if (!result) return false;
  // 2026-08-09: renderMessage อาจ return { text, parseMode } สำหรับ event ที่ต้องการ HTML
  //   - backward-compat: ถ้า return string (เก่า) → ใช้ text ตรงๆ
  const text = typeof result === 'string' ? result : result.text;
  const parseMode = typeof result === 'object' ? result.parseMode : undefined;
  if (!text) return false;
  return sendTelegram(cfg.token, cfg.chatId, text, { parseMode });
}

function renderMessage(eventKey, p, cfg) {
  try {
    switch (eventKey) {
      case 'buyFilled': {
        // FIX-2026-07-26: แสดง "รายการที่ N ของวันนี้" (นับ trades ที่ buyFilledAt อยู่ในวันเดียวกัน ตาม bot)
        const tradeNum = p.dailyTradeNumber || '?';
        const total = p.dailyTradeTotal || '?';
        // FIX-2026-07-27: USDT balance remain หลัง BUY fill — แสดง THB เทียบเท่าด้วย
        let balLine = '';
        if (p.usdtTotal != null) {
          const thbEq = p.fxRate != null ? Number((p.usdtTotal * p.fxRate).toFixed(2)) : null;
          balLine = thbEq != null
            ? `\nUSDT remain: ${p.usdtTotal.toFixed(2)} (≈ ${thbEq.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} THB)`
            : `\nUSDT remain: ${p.usdtTotal.toFixed(2)}`;
        }
        // FIX-2026-08-02: target sell price (TP + fee buffer) — ผู้ใช้ขอเพิ่มเพื่อเห็นจุดปิดกำไรทันทีหลัง BUY
        // FIX-2026-08-02 (TP-NET clarity): แสดงทั้ง Gross markup และ NET profit (หลังหัก fee 2 ข้าง)
        //   - Gross = (sellPrice - buyPrice) / buyPrice × 100 = tp% + 2×feeRate
        //   - NET = bot.tpPercent × tpTrendMultiplier (ถ้า trend=upper) = กำไรที่ user จะได้รับจริง
        //   - ก่อนหน้านี้ label เขียนว่า "%pnl" แต่คำนวณ gross — user เข้าใจผิดว่าเป็น NET
        let targetSellLine = '';
        if (p.targetSellPrice != null && Number.isFinite(Number(p.targetSellPrice)) && p.price != null && Number.isFinite(Number(p.price)) && Number(p.price) > 0) {
          const sellP = Number(p.targetSellPrice);
          const buyP = Number(p.price);
          const grossPct = ((sellP - buyP) / buyP) * 100;
          const tpEff = Number.isFinite(Number(p.tpEffective)) ? Number(p.tpEffective) : null;
          const tpMult = Number.isFinite(Number(p.tpTrendMultiplier)) ? Number(p.tpTrendMultiplier) : null;
          const tpBase = Number.isFinite(Number(p.tpBase)) ? Number(p.tpBase) : null;
          if (tpEff != null) {
            // Annotate "×N" เฉพาะเมื่อ multiplier > 1 และ trend logic ทำงานจริง
            let multTag = '';
            if (p.tpTrendEnabled === true && tpMult != null && tpMult > 1 && tpBase != null) {
              // verify tpEff ตรงกับ tpBase × tpMult (within 1e-6) ก่อน tag
              if (Math.abs(tpEff - tpBase * tpMult) < 1e-6) {
                multTag = ` (×${tpMult})`;
              }
            }
            targetSellLine = `\n🎯 Target Sell: ${formatPrice(sellP, p.symbol)} (Gross +${grossPct.toFixed(3)}%, NET +${tpEff.toFixed(3)}%${multTag})`;
          } else {
            // fallback: legacy trade without TP context — show gross only
            targetSellLine = `\n🎯 Target Sell: ${formatPrice(sellP, p.symbol)} (Gross +${grossPct.toFixed(3)}%)`;
          }
        } else if (p.targetSellPrice != null && Number.isFinite(Number(p.targetSellPrice))) {
          targetSellLine = `\n🎯 Target Sell: ${formatPrice(p.targetSellPrice, p.symbol)}`;
        }
        return `🟢 BUY filled #${tradeNum}/${total} (วันนี้)\nBot: ${p.botName}\nSymbol: ${p.symbol}\nQty: ${formatQty(p.qty)}\nPrice: ${formatPrice(p.price, p.symbol)}${targetSellLine}${balLine}`;
      }
      case 'sellFilled': {
        const pnl = Number(p.realizedPnl) || 0;
        const sign = pnl >= 0 ? '+' : '';
        const emoji = pnl >= 0 ? '💰' : '🟥';
        // FIX-2026-07-27: P&L % อยู่ในวงเล็บต่อท้ายบรรทัด USDT
        const pnlPct = p.pnlPercent != null ? Number(p.pnlPercent) : null;
        const pctInline = pnlPct != null ? ` (${sign}${pnlPct.toFixed(2)}%)` : '';
        // FIX-2026-07-26: P&L in THB บรรทัดถัดไป
        const pnlThb = p.pnlThb != null ? Number(p.pnlThb) : null;
        const thbLine = pnlThb != null
          ? `\nP&L: ${sign}${pnlThb.toFixed(2)} THB (1 USDT ≈ ${p.fxRate ? p.fxRate.toFixed(2) : '?'} THB)`
          : '';
        // FIX-2026-07-27: USDT balance remain หลัง SELL fill — แสดง THB เทียบเท่า
        let balLine = '';
        if (p.usdtTotal != null) {
          const thbEq = p.fxRate != null ? Number((p.usdtTotal * p.fxRate).toFixed(2)) : null;
          balLine = thbEq != null
            ? `\nUSDT remain: ${p.usdtTotal.toFixed(2)}  (≈ ${thbEq.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} THB)`
            : `\nUSDT remain: ${p.usdtTotal.toFixed(2)}`;
        }
        // FIX-2026-08-13: Today P&L (running sum across all bots from start of local day)
        //   - ใช้ aggregateTrades range ที่คำนวณใน handler (รวม trade ปัจจุบันแล้ว)
        //   - แสดง USDT + THB บรรทัดเดียวกัน เพื่อให้ user เห็นภาพรวมวันนี้ทันทีหลัง fill
        let todayPnlLine = '';
        if (p.todayPnlUsdt != null && Number.isFinite(Number(p.todayPnlUsdt))) {
          const tpnl = Number(p.todayPnlUsdt);
          const tsign = tpnl >= 0 ? '+' : '';
          const tthb = p.todayPnlThb != null && Number.isFinite(Number(p.todayPnlThb))
            ? Number(p.todayPnlThb).toFixed(2)
            : '?';
          todayPnlLine = `\nToday P&L: ${tsign}${tpnl.toFixed(2)} USDT ~ ${tthb} THB`;
        }
        // FIX-2026-08-01: structured sellReason — บอกว่า SELL trigger มาจากอะไร
        //   - ไม่แสดงถ้า p.reason ว่าง (backwards compat — trade เก่าไม่มี field)
        let reasonLine = '';
        if (p.reason) {
          const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
          const REASON_LABELS = {
            // FIX-2026-08-09: cbv3_panic — CRITICAL FIX (was missing from enum → silent data loss)
            cbv3_panic:                      '💎 CBv3 sustained panic-close (CBv2 + ST3 upper-TF, HYBRID)',
            // FIX-2026-08-09: แยก SL-UKC F1-armed vs manual
            sl_ukc_f1_armed:                 '🛑 Stop-loss upper-KC (auto-armed by F1)',
            sl_ukc_manual:                   '🛑 Stop-loss upper-KC (manually armed)',
            // FIX-2026-08-09: แยก 4 sources ของ manual close
            manual_api_force_close_trade:    '🔧 Force-close (UI 1 trade)',
            manual_api_force_close_bot:      '🔧 Force-close bot (UI)',
            manual_api_watchdog:             '🛡️ Watchdog force-close (DISABLED bot)',
            manual_api_cleanup_script:       '🧹 Cleanup script (synthetic)',
            // FIX-2026-08-09: DCA stack reasons
            dca_target_hit:                  '📚 DCA stack target hit',
            dca_stack_force_close:           '📚 DCA stack force-closed',
            dca_stack_stop_loss:             '📚 DCA stack SL-UKC',
            tp_hit:                 '🎯 TP target hit',
            tp_trend_boosted:       '🎯 TP (trend-boosted)',
            cb_panic:                '🚨 Circuit-breaker panic-close',
            cbv2_panic:                      '💎 CBv2 sustained panic-close (HYBRID — bot stays enabled)',
            cbv5_panic:                      '💎 CBv5 panic-close (Support Zone broken — deepest pivot low + lowerKC)',
            stop_loss_upper_kc:     '🛑 Stop-loss (upper KC)',
            market_fallback:        '⚠️ Market fallback',
            manual_api_market:      '🔧 Manual API (market)',
            manual_api_synthetic:   '🔧 Manual API (synthetic)',
            race_recovery_filled:   '🏁 Race recovery',
            holding_retry_recovered:'🔄 Holding retry recovered',
            holding_retry_exhausted:'❌ Holding retry exhausted',
            partial_sell_finalized: '⏸️ Partial-sell finalized',
            bot_disabled:           '⛔ Bot disabled',
            unknown:                '❓ Unknown',
          };
          const reasonLabel = REASON_LABELS[p.reason] || p.reason;
          // FIX-2026-08-09: shorten detail + add Context line for richer info (held duration, F1-armed, PnL%)
          //   - detail was: 'manual close via API — MARKET @ 0.10753 qty=93.5' (redundant with Qty line)
          //   - new: position context (held time, F1-armed, loss%) — answers 'why this triggered'
          const reasonDetail = p.reasonDetail ? truncate(String(p.reasonDetail), 80) : '';
          const contextLine = p.context ? truncate(String(p.context), 100) : '';
          reasonLine = reasonDetail
            ? `\nReason: ${reasonLabel} (${reasonDetail})`
            : `\nReason: ${reasonLabel}`;
          if (contextLine) {
            reasonLine += `\nContext: ${contextLine}`;
          }
        }
        return `${emoji} SELL filled\nBot: ${p.botName}\nSymbol: ${p.symbol}\nQty: ${formatQty(p.qty)} @${formatPrice(p.price, p.symbol)}\nP&L: ${sign}${pnl.toFixed(4)} USDT${pctInline}${reasonLine}${thbLine}${todayPnlLine}${balLine}`;
      }
      case 'insufficientBalance':
        return `💸 Insufficient USDT\nBot: ${p.botName}\nSymbol: ${p.symbol}\n${p.note || ''}`.trim();
      case 'botEnabled':
        return `▶️ Bot enabled\nBot: ${p.botName}`;
      case 'botDisabled':
        return `⏸ Bot disabled\nBot: ${p.botName}`;
      // FIX-2026-08-14: Orphan BUY filled on disabled bot — DB state='filled' แต่ Binance ไม่มี SELL
      //   - บอทถูก disable ไปแล้ว (manual/auto-pause) แต่ BUY เพิ่ง fill → trader ถูก stop ไปแล้ว
      //   - reconcile จะ alert ซ้ำทุก 5 นาที → กัน spam ด้วย orphanLatchedAt ใน DB (caller latch)
      case 'orphanBuyFilled': {
        const filledAgo = p.buyFilledAt ? Math.round((Date.now() - new Date(p.buyFilledAt).getTime()) / 60000) : null;
        const agoTxt = filledAgo != null ? ` (เมื่อ ${filledAgo} นาทีที่แล้ว)` : '';
        const reasonLine = p.autoPauseReason ? `\nAuto-pause reason: ${p.autoPauseReason}` : '';
        // FIX-2026-09-05: auto-recovery พยายามวาง SELL ให้แล้วแต่ล้มเหลว → บอกสาเหตุตรงๆ
        //   (alert นี้ยิงเฉพาะตอน "กู้ไม่สำเร็จ" — ถ้ากู้ได้ reconcile จะไม่ส่งเลย)
        const recLine = p.recoveryError ? `\nAuto-recovery failed: ${p.recoveryError}` : '';
        return `🚨 ORPHAN BUY filled on DISABLED bot${agoTxt}\nBot: ${p.botName} (enabled=${p.botEnabled}, status=${p.botStatus})\nSymbol: ${p.symbol}\nBuy order: ${p.buyOrderId}\nQty: ${p.buyQty != null ? p.buyQty : '?'} @ ${p.buyPrice != null ? p.buyPrice : '?'} USDT${reasonLine}${recLine}\n\n⚠️ ไม่มี SELL order บน Binance — ต้อง re-enable bot หรือ force-close ด้วยตัวเอง`;
      }
      case 'botDeleted':
        return `🗑 Bot deleted\nBot: ${p.name || p.botId || '(unknown)'}`;
      case 'positionLoss':
        return `🔻 Position loss > ${cfg.thresholds.positionLossPct}%\nBot: ${p.botName}\nSymbol: ${p.symbol}\nPnL: ${p.pnlPct.toFixed(2)}%`;
      case 'positionProfit':
        return `🔺 Position profit > ${cfg.thresholds.positionProfitPct}%\nBot: ${p.botName}\nSymbol: ${p.symbol}\nPnL: +${p.pnlPct.toFixed(2)}%`;
      case 'positionStuck':
        return `⏳ Position open > ${cfg.thresholds.positionStuckMin}m\nBot: ${p.botName}\nSymbol: ${p.symbol}\nHeld: ${p.heldMin}m`;
      // FIX-2026-08-05: BNB balance low — กัน BNB-empty fee-deduct incident ซ้ำ
      //   - trigger เมื่อ (bnbQty × bnbUsdtPrice) < threshold (default $0.50)
      //   - latch: ส่งครั้งเดียวต่อ crossing (down→below→up→below) — กัน spam ทุก 5 นาที
      case 'bnbLowBalance':
        return `💎 BNB balance ต่ำ\nQty: ${p.bnbQty != null ? p.bnbQty.toFixed(4) : '?'} BNB\nPrice: ${p.bnbUsdtPrice != null ? p.bnbUsdtPrice.toFixed(2) : '?'} USDT\nValue: ${p.bnbValueUsdt != null ? p.bnbValueUsdt.toFixed(4) : '?'} USDT\nThreshold: ${p.threshold != null ? p.threshold.toFixed(2) : '0.50'} USDT\n\n⚠️ Binance จะหัก fee 0.1% จาก base asset เมื่อ BNB หมด — เติม BNB ด่วน`;
      // FIX-2026-08-05: Auto-Buy BNB — ผลของการเติม BNB อัตโนมัติ (success/failed/skipped)
      case 'bnbAutoBuy': {
        if (p.kind === 'success') {
          const qtyBought = p.bnbQtyBought != null ? p.bnbQtyBought.toFixed(4) : '?';
          const price = p.bnbPriceFilled != null ? p.bnbPriceFilled.toFixed(2) : '?';
          const spent = p.usdtSpent != null ? p.usdtSpent.toFixed(2) : '?';
          const before = p.bnbQtyBefore != null ? p.bnbQtyBefore.toFixed(4) : '?';
          const orderId = p.orderId || '?';
          const source = p.source === 'manual' ? '🖐 manual' : '⏰ auto';
          return `💎 Auto-Buy BNB สำเร็จ (${source})\nBought: ${qtyBought} BNB @ ${price} USDT\nSpent: ${spent} USDT\nBNB before: ${before} BNB (value ${p.bnbValueBefore != null ? p.bnbValueBefore.toFixed(4) : '?'} USDT)\nThreshold: ${p.threshold != null ? p.threshold.toFixed(2) : '0.50'} USDT\nOrder: ${orderId}`;
        } else if (p.kind === 'failed') {
          return `❌ Auto-Buy BNB ล้มเหลว\nReason: ${p.reason || p.msg || 'unknown'}\nCode: ${p.code || '?'}\nTopUp: ${p.topUpUsdt != null ? p.topUpUsdt.toFixed(2) : '?'} USDT\n\nตรวจสอบ API keys + USDT balance + BNB minNotional`;
        } else {
          let detail = '';
          if (p.reason === 'insufficient_usdt') detail = `USDT free: ${p.usdtAvail != null ? p.usdtAvail.toFixed(2) : '?'} (need ${p.needed != null ? p.needed.toFixed(2) : '?'})`;
          else if (p.reason === 'daily_cap') detail = `Spent today: ${p.spentToday != null ? p.spentToday.toFixed(2) : '?'} / ${p.cap != null ? p.cap.toFixed(2) : '?'} USDT`;
          return `⏸ Auto-Buy BNB skipped\nReason: ${p.reason || '?'}${detail ? '\n' + detail : ''}`;
        }
      }
      // FIX-2026-07-26: เตือน NET TP ต่ำกว่า threshold
      case 'tpLowPnL':
        return `📉 TP ต่ำเกินไป\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'})\nTP (NET): ${p.tpPct != null ? p.tpPct.toFixed(3) : '?'}%\nThreshold: ${p.threshold != null ? p.threshold.toFixed(3) : '0.2'}%\n\nแนะนำ: ปรับ capitalPerTrade สูงขึ้น · เพิ่ม kcMult · หรือปิด autoUpdateTp`;
      // FIX-2026-08-01: Circuit-breaker (CB) panic-sell — เดิมชื่อ case 'sls1PanicClose'
      case 'cbPanicClose':
        return `🚨 Circuit-breaker panic-sell — ปิดทุก position\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'})\n3 แท่งติด red + below lowerKC → กันกราฟไหล\nClosed: ${p.closedCount} ไม้\nLowerKC: ${p.lastLower || '?'}`;
      // FIX-2026-08-07: CBv2 HYBRID — sustained 3-candle breach → force-close + cooldown S1 BUY (bot ยัง enabled)
      case 'cbv2PanicClose':
        return `💎 CBv2 sustained panic-sell — ปิดทุก position + cooldown BUY\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'})\n4 แท่งติด red + below lowerKC → กันกราฟไหลต่อเนื่อง\nClosed: ${p.closedCount} ไม้\nCooldown: ${p.lockHours || '?'} ชั่วโมง (until ${p.lockedUntil || '?'})\nLowerKC: ${p.lastLower || '?'}\n\n⏸ บอทยัง enable + Auto-pause/resume ยังทำงานปกติ — แค่กั้น S1 BUY ระหว่าง cooldown\n📌 Manual clear cooldown: POST /api/bots/<id>/unlock-cbv2`;
      // FIX-2026-08-07: HYBRID — บอทถูกบังคับ cooldown (BUY suppressed) — บอทยังรัน ไม่ disable
      case 'botLocked':
        return `⏸ Bot cooldown (CBv2)\nBot: ${p.botName}\nReason: ${p.reason || 'cbv2_panic'}\nCooldown until: ${p.lockedUntil || '?'}\nDuration: ${p.lockHours || '?'} ชั่วโมง\n\n📌 บอทยัง enable — แค่กั้น BUY ระหว่าง cooldown (Auto-pause/resume ยังทำงานแยก)\n📌 Manual clear: POST /api/bots/<id>/unlock-cbv2`;
      // FIX-2026-08-03: Safe-trade filter #2 (trendline) status transition (pass ↔ blocked)
      //   - แจ้งเฉพาะตอน transition (กัน spam) — first scan หรือ warmup ไม่ส่ง
      //   - ตัวอย่าง: "📐 BNBUSDT 5m — trendline: pass → blocked (price 605 < TL 612.3, gap -1.20%)"
      case 'trendlineStatusChanged': {
        const prev = p.prevStatus || '?';
        const curr = p.newStatus || '?';
        const arrow = curr === 'pass' ? '✅ pass' : '❌ blocked';
        const gap = p.gapPct != null ? p.gapPct.toFixed(2) : '?';
        return `📐 Trendline status: ${prev} → ${arrow}\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'} → ${p.trendTF || '?'})\nLast close: ${p.lastClose != null ? p.lastClose.toFixed(6) : '?'}\nTrendline: ${p.trendlineValue != null ? p.trendlineValue.toFixed(6) : '?'}\nGap: ${gap}%`;
      }
      // FIX-2026-07-30: SELL PARTIALLY_FILLED — บอทจะไม่ mark sold ทันที รอ fill ที่เหลือ
      case 'sellPartialFill':
        return `⚠️ SELL PARTIALLY_FILLED — ยังไม่ปิด position\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'})\nOrder: ${p.orderId}\nFilled: ${p.executedQty} / ${p.sellQty} (remaining ${p.remainingQty})\nAvg: ${p.avgPrice}\nกำลังรอ fill ที่เหลือ — deadline finalizer จะทำงานอัตโนมัติ`;
      // FIX-2026-08-01: SELL partial-fill freeze (24h policy — keep SELL LIVE)
      case 'sellPartialFrozen':
        return `🧊 SELL partial-fill FREEZE — ไม่ cancel + ไม่ MARKET replace\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'})\nTrade: ${p.tradeId}\nOrder: ${p.orderId}\nFilled: ${p.executedSoFar} / ${p.sellQty} (remaining ${p.remainingQty})\nAvg: ${p.avgPrice}\nBelowMinLot: ${p.belowMinLot ? '⚠️ ใช่' : 'ไม่'}\nFreezeReason: ${p.freezeReason || '-'}\n\n⏳ Keep SELL order LIVE รอ fill ที่เหลือเอง (24h deadline)\n📌 Manual cancel/new SELL allowed ถ้าต้องการ`;
      // FIX-2026-08-01: SELL partial-fill LATCHED alert (1h after detection still partial)
      case 'sellPartialLatched':
        return `⏰ SELL partial-fill LATCHED — ไม่คืบหน้าเกิน 1h\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'})\nTrade: ${p.tradeId}\nOrder: ${p.orderId}\nFilled: ${p.executedSoFar} / ${p.sellQty} (remaining ${p.remainingQty})\nAvg: ${p.avgPrice}\nElapsed: ${p.elapsedMin || '?'} min\nReason: ${p.reason || '-'}\n\n🚨 ตรวจสอบ position + พิจารณา manual cancel/new SELL\n⚠️ 1h alert นี้จะส่งครั้งเดียวต่อ trade (latched)`;
      // FIX-2026-07-30: SELL partial-finalized — ผลลัพธ์หลัง deadline
      case 'sellPartialFinalized': {
        const modeLabel = p.mode === 'fully_filled_during_finalize' ? '✅ fill ครบระหว่างรอ'
          : p.mode === 'market_remaining' ? '🚑 MARKET SELL ที่เหลือ'
          : '🪨 dust → holding retry';
        return `🔧 SELL partial-finalized — ${modeLabel}\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'})\nTrade: ${p.tradeId}\nExecuted ก่อนหน้า: ${p.executedSoFar != null ? p.executedSoFar : '-'}\nMARKET sold: ${p.remainingSold != null ? p.remainingSold : (p.remainingQty != null ? p.remainingQty : '-')} @ ~${(p.markPrice || p.totalAvgPrice) ? formatPrice(p.markPrice || p.totalAvgPrice, p.symbol) : '-'}\nPnL: ${p.pnl != null ? p.pnl.toFixed(4) : '-'} USDT`;
      }
      // FIX-2026-07-30: reconcile ตรวจเจอ DB=sold แต่ Binance SELL order ยังไม่ FILLED
      case 'sellOrphanDetected':
        return `🚨 SELL orphan detected (reconcile)\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'})\nTrade: ${p.tradeId}\nDB says sold but Binance SELL ${p.orderId} status = ${p.liveStatus}\nExecuted: ${p.executedQty} / ${p.origQty}\n→ ตรวจสอบด้วยตัวเอง — manual recovery หรือปล่อยให้ fill เอง`;
      // FIX-2026-08-06: SELL slippage warning — SELL filled below target > 3%
      //   - reason: TP hit / market_fallback / manual_api_market / holding_retry_recovered
      //   - indicates price dropped between BUY and SELL fill (MARKET fallback path)
      case 'slippageWarning': {
        const slipPct = p.slipPct != null ? Number(p.slipPct).toFixed(2) : '?';
        const sellPrice = p.sellPrice != null ? formatPrice(Number(p.sellPrice), p.symbol) : '?';
        const target = p.targetSellPrice != null ? formatPrice(Number(p.targetSellPrice), p.symbol) : '?';
        const pnlPct = p.pnlPercent != null ? Number(p.pnlPercent).toFixed(2) : '?';
        const reason = p.sellReason || 'unknown';
        return `📉 SELL slippage warning (${slipPct}%)\nBot: ${p.botName}\nSymbol: ${p.symbol}\nReason: ${reason}\nSold: ${sellPrice} (target was ${target})\nP&L: ${pnlPct}%\nTrade: ${p.tradeId}\n→ fill ต่ำกว่า target > 3% — ตรวจสอบ TP target + MARKET fallback path`;
      }
      // FIX-2026-08-07: Auto Add New Bot — แจ้งเตือนเมื่อ auto-create บอทใหม่
      //   - bot ถูกสร้างในสถานะ DISABLED — ต้องไปเปิดเองที่หน้า bots.html
      //   - ส่งทุกครั้งที่ autoAddBot service สร้างบอท (manual/periodic)
      case 'autoAddBotCreated': {
        const score = p.score != null ? p.score.toFixed(2) : '?';
        const kcMin = p.kcMinPct != null ? p.kcMinPct.toFixed(3) : '?';
        const tp = p.suggestedTpPct != null ? p.suggestedTpPct.toFixed(3) : '?';
        const tf = p.timeframe || '?';
        const ae = p.autoEnabled === true;
        // FIX-2026-08-07: บอก user ว่าบอทเริ่มเทรดแล้ว (default ON) หรือยัง DISABLED
        const tail = ae
          ? '\n\n▶️ บอทเริ่มเทรดทันทีแล้ว (spawnTrader) · ดูสถานะที่ /bots.html'
          : '\n\n⏸ บอทอยู่ในสถานะ DISABLED — ไปเปิดที่หน้า bots.html ถ้าต้องการเทรด';
        return `🤖 Auto Add New Bot — สร้างบอทใหม่อัตโนมัติ\nBot: ${p.botName}\nSymbol: ${p.symbol} (${tf})\nScore: ${score}\nkcMin: ${kcMin}%\nTP (NET): ${tp}%${tail}`;
      }
      // FIX-2026-08-23: Auto Add Bot — restore + activate บอท soft-deleted ที่ symbol ตรงเกณฑ์
      //   - ต่างจาก autoAddBotCreated ตรงที่: เป็นบอทเดิม (มี trade history) — ไม่ใช่บอทใหม่
      //   - แจ้ง user ว่า restore เพราะ minKC กลับมาตรงเกณฑ์ + มีบอทเก่าค้างอยู่
      case 'autoAddBotRestored': {
        const score = p.score != null ? p.score.toFixed(2) : '?';
        const kcMin = p.kcMinPct != null ? p.kcMinPct.toFixed(3) : '?';
        const tp = p.suggestedTpPct != null ? p.suggestedTpPct.toFixed(3) : '?';
        const tf = p.timeframe || '?';
        const ae = p.autoEnabled === true;
        const days = p.daysSinceDelete || 0;
        const tail = ae
          ? `\n\n▶️ บอทเริ่มเทรดทันทีแล้ว (spawnTrader) · ดูสถานะที่ /bots.html`
          : `\n\n⏸ บอทอยู่ในสถานะ DISABLED — ไปเปิดที่หน้า bots.html ถ้าต้องการเทรด`;
        return `🤖↩️ Auto Add Bot — restore + activate บอทเก่าอัตโนมัติ\nBot: ${p.botName}\nSymbol: ${p.symbol} (${tf})\nScore: ${score}\nkcMin: ${kcMin}%\nTP (NET): ${tp}%\nRestore window: ${days}d since soft-delete${tail}`;
      }
      // FIX-2026-08-08: Feature #2 — CBv3 panic-close (mirror cbv2PanicClose but with ST3 upper-TF gate)
      case 'cbv3PanicClose':
        return `💎 CBv3 panic-sell (CBv2 + ST3) — ปิดทุก position + cooldown BUY\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'})\nCBv2 + ST3 no-trade on upper-TF → กันกราฟไหลต่อเนื่อง\nClosed: ${p.closedCount} ไม้\nCooldown: ${p.lockHours || '?'} ชั่วโมง (until ${p.lockedUntil || '?'})\nLowerKC: ${p.lastLower || '?'}\n\n⏸ บอทยัง enable + Auto-pause/resume ยังทำงานปกติ — แค่กั้น S1 BUY ระหว่าง cooldown\n📌 Manual clear cooldown: POST /api/bots/<id>/unlock-cbv2`;
      // FIX-2026-08-10: CBv5 — Support Zone broken (lowerKC + deepest pivot low + bearish + volume spike)
      //   - HYBRID mode: bot stays enabled, blocks S1 BUY until cooldown expires
      //   - independent of cbVersion enum (works alongside CBv2 or CBv3)
      case 'cbv5PanicClose':
        return `💎 CBv5 panic-sell (Support Zone broken) — ปิดทุก position + cooldown BUY\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'})\nLowerKC break + ทลาย deepest pivot low (${p.deepestLow != null ? p.deepestLow.toFixed(6) : '?'}) + ${p.isBearish ? 'bearish' : 'wick'} + ${p.isHighVolume ? 'volume spike' : 'normal vol'} → โครงสร้าง support พัง\nClosed: ${p.closedCount} ไม้\nCooldown: ${p.lockHours || '?'} ชั่วโมง (until ${p.lockedUntil || '?'})\nLowerKC: ${p.lastLower != null ? p.lastLower.toFixed(6) : '?'}\n\n⏸ บอทยัง enable + Auto-pause/resume ยังทำงานปกติ — แค่กั้น S1 BUY ระหว่าง cooldown\n📌 Manual clear cooldown: POST /api/bots/<id>/unlock-cbv2`;
      // FIX-2026-08-08: Feature #1 — Dynamic Position Sizing resize (size changed)
      //   - reason: '3-wins' | '2-wins-2pct' | 'loss' (ตัวเลขเปลี่ยนตาม config)
      //   - before/after show current USDT size
      // FIX-2026-08-08 (rev2): ค่า clamp/cooldown มาจาก payload (ตั้งได้ที่ /settings.html section 🔟)
      //   + dry-run mode: คำนวณ + แจ้งเตือน แต่ไม่ได้ปรับจริง
      // FIX-2026-09-03: layer-removal — DPS now only auto-tunes size (layers owned by separate function).
      //   beforeLayers / afterLayers / minLayers / maxLayers segments removed from telegram payload.
      case 'dpsResize': {
        const cdMin = Number.isFinite(Number(p.cooldownMinutes)) ? Number(p.cooldownMinutes) : 5;
        const bMinS = p.minSize ?? 6, bMaxS = p.maxSize ?? 15;
        const head = p.dryRun
          ? '🧪 DPS (DRY-RUN — คำนวณเฉยๆ ไม่ได้ปรับจริง)'
          : '📊 DPS resize (Dynamic Position Sizing)';
        return `${head}\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'})\nReason: ${p.reason || '?'}\nBefore: $${p.beforeSize ?? '?'}\nAfter: $${p.afterSize ?? '?'}\nLast trade: pnl ${p.pnlPct != null ? Number(p.pnlPct).toFixed(2) + '%' : '?'} (${p.isWin ? 'WIN' : 'LOSS'})\nCooldown: ${cdMin} นาที (กัน whipsaw)\n\n💡 clamp: $${bMinS}..$${bMaxS} — ปรับได้ที่ Settings 🔟`;
      }

      // FIX-2026-08-08: Feature #3 — Auto unlock cooldown (CB unlocked after 3+ profitable signals)
      case 'botAutoUnlocked':
        return `🔓 Cooldown ปลดอัตโนมัติ (3+ profitable signals)\nBot: ${p.botName}\nSymbol: ${p.symbol}\nSignals found: ${p.signalsFound || '?'}\nThreshold: ${p.threshold || '?'}%\nSource: cbAutoUnlock service\n\n✅ บอทกลับมาเทรดได้แล้ว (BUY gate reset)`;
      // FIX-2026-08-08: Feature #5 — Auto Delete Bot — warning (แจ้งล่วงหน้า N วัน)
      case 'autoDeleteBotWarning':
        return `⏰ Auto Delete Bot — แจ้งล่วงหน้า\nBot: ${p.botName}\nSymbol: ${p.symbol}\nDowntime: ${p.downtimeDays || '?'} วัน (threshold ${p.thresholdDays || '?'} วัน)\nRemaining: ${p.remainingDays || '?'} วัน\n\n⚠️ บอทจะถูก soft-delete (เก็บ 30 วัน แล้วลบถาวร) — ถ้าต้องการเก็บไว้ → enable บอทในหน้า bots.html`;
      // FIX-2026-08-08: Feature #5 — Auto Delete Bot — soft-deleted (เก็บไว้ 30 วัน restore ได้)
      case 'autoDeleteBotRemoved':
        return `🗑 Auto Delete Bot — soft-deleted\nBot: ${p.botName}\nSymbol: ${p.symbol}\nDowntime: ${p.downtimeDays || '?'} วัน (threshold ${p.thresholdDays || '?'} �ัน)\n\n📌 Restore ได้ภายใน 30 วัน ผ่าน POST /api/bots/<id>/restore\n📌 หลัง 30 วัน จะถูกลบถาวร (admin cleanup script)`;
      // FIX-2026-08-09: Telegram Login — alternative login channel (OTP 6 หลักใช้แทน password เมื่อลืม)
      //   - NOT 2FA — ใช้แทน password
      //   - HTML parse_mode สำหรับ <b>/<code> tag (return { text, parseMode: 'HTML' } แทน string)
      case 'telegramLogin': {
        const code = (p && p.code) || '------';
        const mins = (p && p.expiresInMin) || 5;
        return {
          text:
            `🔐 <b>Login OTP</b>\n\n` +
            `รหัสเข้าสู่ระบบของคุณ: <code>${code}</code>\n\n` +
            `⏱ หมดอายุใน ${mins} นาที\n` +
            `ใช้ได้ครั้งเดียว\n\n` +
            `📌 ถ้าไม่ได้ขอเข้าสู่ระบบ → ไม่ต้องสนใจ OTP นี้\n` +
            `<i>OnePercentBotTrade · ${new Date().toISOString()}</i>`,
          parseMode: 'HTML',
        };
      }
      // FIX-2026-08-24: Login brute-force lock alert — IP/account ถูก lock (progressive backoff + escalation)
      //   - p = { ip, userAgent, ipLockoutLevel, ipLocked, accountLocked, retryAfterSec }
      //   - level: 1 = 15 min, 2 = 30 min, 3+ = 60 min (cap)
      //   - accountLocked = true → distributed brute-force signal (5 fails across หลาย IP)
      //   - ไม่มี latch ในตัว — caller latches ผ่าน loginGuard (1 alert ต่อ lock event)
      case 'loginLocked': {
        const level = p.ipLockoutLevel || 1;
        const mins = p.retryAfterSec ? Math.ceil(p.retryAfterSec / 60) : '?';
        const ipLocked = p.ipLocked !== false;
        const accountLocked = p.accountLocked === true;
        const reasonTag = accountLocked
          ? '🔒 Distributed brute-force (account-level)'
          : ipLocked ? `🔒 IP locked (level ${level})` : '⚠️';
        const uaShort = p.userAgent ? String(p.userAgent).slice(0, 80) : 'unknown';
        return {
          text:
            `🚨 <b>Brute-force LOCK alert</b>\n\n` +
            `${reasonTag}\n` +
            `IP: <code>${p.ip || 'unknown'}</code>\n` +
            `Lock duration: ${mins} นาที\n` +
            `User-Agent: <code>${escapeHtml(uaShort)}</code>\n\n` +
            `📌 ถ้าไม่ใช่คุณ → เปลี่ยน password ทันที + เช็ค /password-sessions.html\n` +
            `<i>OnePercentBotTrade · ${new Date().toISOString()}</i>`,
          parseMode: 'HTML',
        };
      }
      // FIX-2026-08-02: DCA + BEP stack events (full notifications, not compact — per user request)
      case 'dcaLayerAdded': {
        const layerIdx = p.layerIndex || '?';
        const layerCnt = p.layerCount || '?';
        const maxLayers = p.maxLayers || '?';
        const layerPrice = p.layerPrice != null ? formatPrice(Number(p.layerPrice), p.symbol) : '?';
        const layerQty = p.layerQty != null ? formatQty(Number(p.layerQty)) : '?';
        const bep = p.stackBep != null ? formatPrice(Number(p.stackBep), p.symbol) : '?';
        const totalQty = p.stackTotalQty != null ? formatQty(Number(p.stackTotalQty)) : '?';
        const totalSpent = p.stackTotalSpent != null ? Number(p.stackTotalSpent).toFixed(2) : '?';
        const target = p.targetSellPrice != null ? formatPrice(Number(p.targetSellPrice), p.symbol) : '?';
        const tpBase = p.tpBase != null ? Number(p.tpBase).toFixed(3) : '?';
        const tpMult = p.tpTrendMultiplier != null ? Number(p.tpTrendMultiplier).toFixed(2) : '1';
        return `🟢 DCA Layer ${layerIdx}/${layerCnt} (max ${maxLayers}) filled\nBot: ${p.botName}\nSymbol: ${p.symbol}\nLayer: ${layerQty} @ ${layerPrice}\nStack BEP: ${bep} (spent ${totalSpent} USDT, total ${totalQty})\n🎯 Target Sell: ${target} (TP base ${tpBase}%, ×${tpMult})`;
      }
      case 'dcaTargetHit': {
        const layerCnt = p.layerCount || '?';
        const bep = p.stackBep != null ? formatPrice(Number(p.stackBep), p.symbol) : '?';
        const sellPrice = p.sellPrice != null ? formatPrice(Number(p.sellPrice), p.symbol) : '?';
        const totalQty = p.stackTotalQty != null ? formatQty(Number(p.stackTotalQty)) : '?';
        const pnl = p.realizedPnl != null ? Number(p.realizedPnl) : 0;
        const sign = pnl >= 0 ? '+' : '';
        const pnlPct = p.pnlPercent != null ? Number(p.pnlPercent) : null;
        const pctInline = pnlPct != null ? ` (${sign}${pnlPct.toFixed(2)}%)` : '';
        return `🎯 DCA Stack CLOSED — TP target hit!\nBot: ${p.botName}\nSymbol: ${p.symbol}\nLayers: ${layerCnt} | BEP: ${bep} | Sold: ${sellPrice}\nQty: ${totalQty}\nP&L: ${sign}${pnl.toFixed(4)} USDT${pctInline}`;
      }
      case 'dcaMaxLayersHit':
        return `⚠️ DCA Max Layers Reached — skip BUY\nBot: ${p.botName}\nSymbol: ${p.symbol}\nStack already at ${p.layerCount}/${p.maxLayers} layers\nNo new layer will be added until SELL fills or stack closes`;
      // FIX-2026-08-06: Binance delist detected (confirmed — symbol appears in /sapi/v1/spot/delist-schedule)
      //   - triggered by delistMonitor:scheduled event (first time a symbol enters schedule)
      //   - telegramNotifier marks symbol as notified via delistMonitor.markNotified() (anti-spam latch)
      //   - botManager auto-pause + force-close runs in parallel
      case 'delistDetected': {
        const dt = p.delistTime != null ? new Date(p.delistTime).toISOString() : '?';
        const days = p.daysUntil != null ? p.daysUntil.toFixed(2) : '?';
        return `🚨 Binance DELIST detected\nSymbol: ${p.symbol}\nDelist time: ${dt}\nDays until: ${days}\n\n⚠️ บอททุกตัวที่ trade ${p.symbol}:\n• Auto-paused (ภายใน 7 �ัน)\n• Force-close position (ภายใน 3 วัน)\n• Block new BUY\n\n🔗 Binance announcement: https://www.binance.com/en/support/announcement/list/161`;
      }
      // FIX-2026-08-06: Binance Monitoring tag (early warning — symbol ไม่มี delist date แต่เ�ี่ยง)
      //   - ไม่ block trade แค่แจ้งเตือน
      case 'delistMonitoring': {
        const tagList = Array.isArray(p.tags) ? p.tags.join(', ') : (p.tags || 'Monitoring');
        return `⚠️ Binance Monitoring tag — ${p.symbol}\nTags: ${tagList}\n\nSymbol นี้อยู่ในรายการติดตามของ Binance (ยังไม่ประกา� delist)\n• บอทยังเปิด position ใหม่ได้ (ไม่ block)\n• แต่ควรเฝ้าระวัง + พิจารณาลดขนาด position`;
      }
      // FIX-2026-08-06: positionForceClosed (delist-driven) — ส่งจาก botManager.checkDelistScheduleBots
      case 'positionForceClosed': {
        const pnl = p.pnl != null ? Number(p.pnl) : 0;
        const sign = pnl >= 0 ? '+' : '';
        const modeLabel = p.mode === 'market' ? 'MARKET SELL' : (p.mode || 'limit');
        return `🚨 Force-close: Binance delist in ${p.daysUntil != null ? p.daysUntil.toFixed(1) : '?'}d\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'})\nTrade: ${p.tradeId}\nMode: ${modeLabel}\nPnL: ${sign}${pnl.toFixed(4)} USDT\nReason: ${p.reason || 'binance_delist'}`;
      }
      // FIX-2026-07-26: สรุปการเทรดรายวัน/สัปดาห์/เดือน
      case 'dailySummary':
      case 'weeklySummary':
      case 'monthlySummary':
        return renderSummaryMessage(eventKey, p, cfg);
      // FIX-2026-08-30 / Phase 4: Auto-Timing events
      case 'autoTimingWeeklySummary':
        return renderAutoTimingWeeklySummary(p);
      case 'autoTimingSuppressHit':
        return renderAutoTimingSuppressHit(p);
      default:
        logger.warn({ eventKey }, 'telegramNotifier: unknown event key (renderMessage skipped)');
        return null;
    }
  } catch (err) {
    logger.warn({ err: err.message, eventKey }, 'telegramNotifier: renderMessage failed');
    return null;
  }
}

// FIX-2026-07-26: render summary message (daily/weekly/monthly)
//   - p = { period: 'day'|'week'|'month', label: '2026-07-26', trades: number, wins: number, losses: number,
//           pnlUsdt: number, pnlThb: number, fxRate: number, perBot: [{ name, trades, pnlUsdt, pnlThb }] }
function renderSummaryMessage(eventKey, p, cfg) {
  const titles = {
    dailySummary: { icon: '📅', label: 'รายวัน', period: 'วัน' },
    weeklySummary: { icon: '📆', label: 'รายสัปดาห์', period: 'สัปดาห์' },
    monthlySummary: { icon: '🗓', label: 'รายเดือน', period: 'เดือน' },
  };
  const t = titles[eventKey];
  const sign = p.pnlUsdt >= 0 ? '+' : '';
  const emoji = p.pnlUsdt >= 0 ? '💚' : '🟥';
  const winRate = p.trades > 0 ? ((p.wins / p.trades) * 100).toFixed(1) : '0.0';
  const thbLine = p.pnlThb != null
    ? `\nP&L: ${sign}${p.pnlThb.toFixed(2)} THB`
    : '';
  const perBotLines = (p.perBot || []).slice(0, 10).map((b) => {
    const bsign = b.pnlUsdt >= 0 ? '+' : '';
    const bEmoji = b.pnlUsdt >= 0 ? '🟢' : '🔴';
    return `  ${bEmoji} ${b.name} (${b.symbol}): ${b.trades} ไม้ · ${bsign}${b.pnlUsdt.toFixed(4)} USDT`;
  }).join('\n');
  const moreLine = (p.perBot || []).length > 10
    ? `\n  … +${(p.perBot || []).length - 10} บอทอื่น`
    : '';
  return `${t.icon} สรุปการเทรด${t.label} (${p.rangeLabel})\n` +
    `Trades: ${p.trades} (wins=${p.wins}, losses=${p.losses}, win rate=${winRate}%)\n` +
    `P&L: ${sign}${p.pnlUsdt.toFixed(4)} USDT${thbLine}\n` +
    `ต่อบอท:\n${perBotLines}${moreLine}`;
}

// FIX-2026-08-30 / Phase 4: Auto-Timing render helpers
function renderAutoTimingSuppressHit(p) {
  // p = { botName, symbol, timeframe, day, hour, action, reason, holdBand }
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dow = dows[p.day] || ('D' + p.day);
  const tf = p.timeframe || '?';
  const reason = p.reason || 'suppressed';
  const action = p.action || 'suppress';
  const band = p.holdBand || '';
  return `⏱ Auto-Timing Suppress\n` +
    `Bot: ${p.botName}\n` +
    `Symbol: ${p.symbol} (${tf})\n` +
    `Slot: ${dow} ${String(p.hour).padStart(2, '0')}:00\n` +
    `Action: ${action}${band ? ' · band=' + band : ''}\n` +
    `Reason: ${reason}`;
}

function renderAutoTimingWeeklySummary(p) {
  // p = { rangeLabel, totalDecisions, byAction: { suppress, limit, encourage, stimulate, allow },
  //       tier2Promotions, suppressedHits, suppressedBotNames }
  const a = p.byAction || {};
  const byActLine = [
    a.suppress ? `🚫 Suppress ${a.suppress}` : null,
    a.limit ? `⚠️ Limit ${a.limit}` : null,
    a.stimulate ? `⭐ Stimulate ${a.stimulate}` : null,
    a.encourage ? `✨ Encourage ${a.encourage}` : null,
    a.allow ? `✅ Allow ${a.allow}` : null,
  ].filter(Boolean).join(' · ');
  const tier2 = p.tier2Promotions != null ? p.tier2Promotions : 0;
  const suppressedHits = p.suppressedHits != null ? p.suppressedHits : 0;
  const suppressedNames = (p.suppressedBotNames && p.suppressedBotNames.length > 0)
    ? `\nSuppressed: ${p.suppressedBotNames.slice(0, 5).join(', ')}${p.suppressedBotNames.length > 5 ? ` (+${p.suppressedBotNames.length - 5} more)` : ''}` : '';
  return `⏱ Auto-Timing Weekly Summary (${p.rangeLabel || 'this week'})\n` +
    `Decisions: ${p.totalDecisions != null ? p.totalDecisions : 0} (${byActLine || 'n/a'})\n` +
    `Tier 2 promotions: ${tier2}\n` +
    `Suppressed hits: ${suppressedHits}${suppressedNames}`;
}

function formatQty(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return String(q);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(8);
}

// FIX-2026-08-24: escapeHtml — ใช้กับ user-controlled text ใน loginLocked message
//   (กัน HTML injection เข้า telegram message ผ่าน userAgent)
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// FIX-2026-07-31: ใช้ tickSize จาก Binance (authoritative per-symbol) — ก่อนหน้านี้ heuristic
//   >=1 → 6 dp, <1 → 10 dp (over-precise สำหรับ low-price coins เช่น ZILUSDT)
//   ZILUSDT จริงควรแสดง 6 dp (เช่น "0.014500") ตาม PRICE_FILTER.tickSize
//   ส่ง symbol ตาม payload.p.symbol เพื่อ lookup tickSize ที่ถูกต้อง
function formatPrice(p, symbol) {
  return symbolInfo.formatPrice(p, symbol);
}

// ─── HTTPS send (with 1 retry on transient errors) ────
// FIX-2026-08-09: opts.parseMode (string | undefined) — เมื่อตั้งค่าจะเพิ่ม `parse_mode` ใน body (HTML/MarkdownV2)
function sendTelegram(token, chatId, text, opts = {}) {
  return new Promise((resolve) => {
    let attempt = 0;
    const tryOnce = () => {
      attempt += 1;
      const payload = {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      };
      if (opts.parseMode) payload.parse_mode = opts.parseMode;
      const body = JSON.stringify(payload);
      const req = https.request({
        method: 'POST',
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: TELEGRAM_API_TIMEOUT_MS,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return resolve(true);
          }
          const transient = res.statusCode === 429 || res.statusCode >= 500;
          if (transient && attempt < 2) {
            return setTimeout(tryOnce, 500);
          }
          logger.warn(
            { status: res.statusCode, body: buf.slice(0, 200) },
            'telegramNotifier: sendMessage failed',
          );
          resolve(false);
        });
      });
      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });
      req.on('error', (err) => {
        if (attempt < 2) return setTimeout(tryOnce, 500);
        logger.warn({ err: err.message }, 'telegramNotifier: sendMessage network error');
        resolve(false);
      });
      req.write(body);
      req.end();
    };
    tryOnce();
  });
}

// ─── sendPhoto (multipart/form-data) ──────────────────
// 2026-09-02: shareCard → Telegram photo upload
//   - Accepts PNG buffer (caller must validate size + magic bytes)
//   - caption optional (Telegram limit 1024 chars — caller enforces)
//   - 1 retry on transient errors (429 / 5xx) — same as sendMessage
function sendTelegramPhoto(token, chatId, photoBuffer, caption = '') {
  return new Promise((resolve) => {
    let attempt = 0;
    const tryOnce = () => {
      attempt += 1;
      // Build multipart/form-data body manually (no extra deps)
      const boundary = `----formdata-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const parts = [];
      // chat_id field
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`,
      ));
      // caption field (optional)
      if (caption) {
        const capBuf = Buffer.from(caption, 'utf8');
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n`,
        ));
        parts.push(capBuf);
        parts.push(Buffer.from('\r\n'));
      }
      // photo file field
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="share-card.png"\r\nContent-Type: image/png\r\n\r\n`,
      ));
      parts.push(photoBuffer);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
      const body = Buffer.concat(parts);

      const req = https.request({
        method: 'POST',
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendPhoto`,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: TELEGRAM_API_TIMEOUT_MS,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return resolve(true);
          }
          const transient = res.statusCode === 429 || res.statusCode >= 500;
          if (transient && attempt < 2) {
            return setTimeout(tryOnce, 500);
          }
          logger.warn(
            { status: res.statusCode, body: buf.slice(0, 300) },
            'telegramNotifier: sendPhoto failed',
          );
          resolve(false);
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => {
        if (attempt < 2) return setTimeout(tryOnce, 500);
        logger.warn({ err: err.message }, 'telegramNotifier: sendPhoto network error');
        resolve(false);
      });
      req.write(body);
      req.end();
    };
    tryOnce();
  });
}

// ─── Event handlers ───────────────────────────────────
function bindEventHandlers() {
  if (bound) return;
  bound = true;

  // trade:update → BUY/SELL filled detection
  // FIX-2026-07-24: รับ state 'filled' (BUY filled) ด้วย
  //   - trader.js emit states: 'placed' (BUY placed) → 'filled' (BUY filled) → 'selling' (SELL placed) → 'sold' (SELL filled)
  //   - เดิม filter เฉพาะ 'holding' / 'sold' → skip 'filled' = ไม่มี BUY notify
  // FIX-2026-07-26: BUY filled → นับ "รายการที่ N ของวันนี้" + SELL filled → เพิ่ม P&L THB
  eventBus.on('trade:update', async ({
    tradeId,
    state,
    targetSellPrice: eventTargetSellPrice,
    // FIX-2026-08-02 (TP-NET clarity): TP context from trader.js — used to show both gross markup and NET profit
    tpBase: eventTpBase,
    tpEffective: eventTpEffective,
    tpTrendMultiplier: eventTpTrendMultiplier,
    tpTrendEnabled: eventTpTrendEnabled,
    feeRate: eventFeeRate,
  } = {}) => {
    try {
      // FIX-2026-07-24: รับ 'filled' (BUY filled) และ 'holding' (fallback) เป็น BUY signal
      //   - 'selling' (SELL placed) เป็น intermediate → ไม่แจ้ง (กัน spam)
      //   - 'sold' = SELL filled
      //   - 'placed' / 'cancelled' / 'failed' → ไม่แจ้ง
      if (state !== 'filled' && state !== 'holding' && state !== 'sold') return;
      const trade = await Trade.findById(tradeId).lean();
      if (!trade) return;
      const cfg = await loadConfig();

      // BUY filled (state='filled' = BUY filled, state='holding' = position มีอยู่แต่ SELL ยังไม่ place)
      if ((state === 'filled' || state === 'holding') && cfg.events.buyFilled && trade.buyFilledAt) {
        // De-dup: ถ้าแจ้ง BUY filled ไปแล้วในรอบนี้ ไม่ส่งซ้ำ
        const id = String(trade._id);
        const st = tradeNotifyState.get(id) || { side: null, stuckNotified: false, buyNotified: false };
        if (!st.buyNotified) {
          const bot = await Bot.findById(trade.botId, 'name symbol').lean();
          // FIX-2026-07-26: นับ "รายการที่ N ของวันนี้" **รวมทุกบอท** — trades ที่ buyFilledAt อยู่ในวันเดียวกัน (local TZ)
          //   (เดิมนับ per-bot — user เปลี่ยนเป็น global เพื่อเห็นภาพรวมวันนี้ทั้งหมด)
          const dayStart = new Date(trade.buyFilledAt);
          dayStart.setHours(0, 0, 0, 0);
          const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
          const dailyTrades = await Trade.countDocuments({
            buyFilledAt: { $gte: dayStart, $lt: dayEnd },
            buyStatus: { $in: ['FILLED', 'PARTIALLY_FILLED'] },
            // นับเฉพาะที่ fill จริง (ไม่ใช่ placed/cancelled)
          });
          // FIX-2026-07-27: USDT balance remain หลัง BUY fill (fail-safe — null ถ้า fetch ล้ม)
          const bal = await fetchUsdtBalance();
          // FIX-2026-07-27: FX rate สำหรับแสดง USDT→THB เทียบเท่า (fail-safe — null ถ้า fetch ล้ม)
          let fxRate = null;
          try {
            fxRate = (await fxService.getUsdtToThb()).rate;
          } catch (err) {
            logger.warn({ err: err.message }, 'telegramNotifier: FX fetch failed — buyFilled will omit THB equivalent');
          }
          // FIX-2026-08-02: prefer event payload's targetSellPrice (มาจาก trader.js ก่อน emit)
          //   - ก่อนหน้านี้อ่านจาก trade.targetSellPrice ใน DB → ได้ null เพราะ trader.js ยังไม่ persist
          //   - ตอนนี้ trader.js ส่ง targetSellPrice มาใน event payload แล้ว → ใช้ก่อน, fallback จาก DB
          const targetSellPrice = eventTargetSellPrice != null && Number.isFinite(Number(eventTargetSellPrice))
            ? Number(eventTargetSellPrice)
            : (trade.targetSellPrice != null ? Number(trade.targetSellPrice) : null);
          // FIX-2026-08-02 (TP-NET clarity): prefer TP context from event payload (ส่งจาก trader.js ก่อน emit 'filled')
          //   - tpEffective = NET target = bot.tpPercent × tpTrendMultiplier (if trend=upper)
          //   - tpBase = bot.tpPercent เดิม (ก่อนคูณ)
          //   - tpTrendMultiplier = 1 หรือค่าที่ตั้งในบอท (default 2)
          //   - feeRate = roundtrip fee rate ที่ใช้คำนวณ gross buffer
          //   - fallback จาก DB targetSellPrice ใช้ประมาณค่า (best-effort NET = (targetSellPrice - buyPrice) / buyPrice - 2*feeRate)
          const tpBase = Number.isFinite(Number(eventTpBase)) ? Number(eventTpBase)
            : (trade.targetSellPrice != null && Number.isFinite(Number(trade.buyPrice)) && Number(trade.buyPrice) > 0 && Number.isFinite(Number(eventFeeRate))
                ? Math.max(0, ((Number(trade.targetSellPrice) - Number(trade.buyPrice)) / Number(trade.buyPrice)) * 100 - 2 * Number(eventFeeRate) * 100)
                : null);
          const tpEffective = Number.isFinite(Number(eventTpEffective)) ? Number(eventTpEffective) : null;
          const tpTrendMultiplier = Number.isFinite(Number(eventTpTrendMultiplier)) ? Number(eventTpTrendMultiplier) : null;
          const tpTrendEnabled = eventTpTrendEnabled === true;
          const feeRate = Number.isFinite(Number(eventFeeRate)) ? Number(eventFeeRate) : null;
          await dispatch('buyFilled', {
            botId: trade.botId,
            botName: bot ? bot.name : '?',
            symbol: trade.symbol,
            qty: trade.buyQty,
            price: trade.buyPrice,
            dailyTradeNumber: dailyTrades, // FIX-2026-07-26: รายการที่ N ของวันนี้ (ทุกบอท)
            dailyTradeTotal: dailyTrades, // ตอนนี้ใช้ตัวเดียวกัน (total filled วันนี้)
            usdtFree: bal ? bal.free : null,   // FIX-2026-07-27: USDT free
            usdtLocked: bal ? bal.locked : null, // FIX-2026-07-27: USDT locked (ถ้ามี SELL pending)
            usdtTotal: bal ? bal.total : null,   // FIX-2026-07-27: USDT total (free+locked)
            fxRate, // FIX-2026-07-27: USDT→THB rate (ใช้คำนวณ THB equivalent ของ balance remain)
            targetSellPrice, // FIX-2026-08-02: TP target (จาก event payload ก่อน, fallback DB)
            tpBase, // FIX-2026-08-02 (TP-NET clarity): bot.tpPercent base (NET)
            tpEffective, // FIX-2026-08-02 (TP-NET clarity): NET target = tpBase × tpTrendMultiplier if trend=upper
            tpTrendMultiplier, // FIX-2026-08-02 (TP-NET clarity): 1 or multiplier used
            tpTrendEnabled, // FIX-2026-08-02 (TP-NET clarity): true if trend logic ran
            feeRate, // FIX-2026-08-02 (TP-NET clarity): roundtrip feeRate used for buffer
          });
          st.buyNotified = true;
          tradeNotifyState.set(id, st);
        }
      }

      // SELL filled (state='sold')
      if (state === 'sold' && cfg.events.sellFilled) {
        const bot = await Bot.findById(trade.botId, 'name symbol').lean();
        const pnlUsdt = trade.realizedPnl || 0;
        // FIX-2026-07-26: fetch FX rate (USDT→THB) — fail-safe (ถ้า fetch ล้มเหลว ส่งแค่ USDT)
        let pnlThb = null;
        let fxRate = null;
        try {
          const fx = await fxService.getUsdtToThb();
          fxRate = fx.rate;
          pnlThb = Number((pnlUsdt * fxRate).toFixed(2));
        } catch (err) {
          logger.warn({ err: err.message }, 'telegramNotifier: FX fetch failed — sellFilled will omit THB');
        }
        // FIX-2026-07-27: USDT balance remain หลัง SELL fill (fail-safe)
        const bal = await fetchUsdtBalance();
        // FIX-2026-08-13: Today P&L (running sum) — sum-only $group ของ realizedPnl across all bots
        //   - ใช้ Trade.aggregate ตรงๆ (ไม่ Bot.find / ไม่ perBot map) เพราะที่นี่ต้องการแค่ pnlUsdt
        //   - include trade ปัจจุบันในช่วง [startOfLocalDay(now), now+60s] (this trade already has sellFilledAt)
        //   - ถ้า aggregate ล้ม → ไม่แสดง line นี้ (template guard ด้วย Number.isFinite)
        let todayPnlUsdt = null;
        let todayPnlThb = null;
        try {
          const tStart = startOfLocalDay(new Date());
          const tEnd = new Date(Date.now() + 60_000); // include trade นี้ (saved ~now)
          const rows = await Trade.aggregate([
            { $match: { sellFilledAt: { $gte: tStart, $lt: tEnd }, realizedPnl: { $ne: null } } },
            { $group: { _id: null, pnlUsdt: { $sum: '$realizedPnl' } } },
          ]);
          todayPnlUsdt = rows && rows[0] ? Number(rows[0].pnlUsdt) || 0 : 0;
          if (fxRate != null && Number.isFinite(fxRate)) {
            todayPnlThb = Number((todayPnlUsdt * fxRate).toFixed(2));
          }
        } catch (err) {
          logger.warn({ err: err.message }, 'telegramNotifier: todayPnl aggregate failed — omit Today P&L line');
        }
        // FIX-2026-08-09: compute position Context (held duration, F1-armed signal, partial-fill flag)
        //   - ใช้บอกผู้ใช้ว่า trade นี้อยู่ในสถานะอะไรก่อน close (ทำไมถึง trigger)
        //   - cap at 100 chars ใน template (truncate helper)
        const contextParts = [];
        try {
          const buyFilledAt = trade.buyFilledAt ? new Date(trade.buyFilledAt).getTime() : null;
          const sellFilledAtMs = trade.sellFilledAt ? new Date(trade.sellFilledAt).getTime() : null;
          if (buyFilledAt && sellFilledAtMs) {
            const heldMs = sellFilledAtMs - buyFilledAt;
            const heldMin = Math.round(heldMs / 60000);
            const heldDisplay = heldMin < 60
              ? `${heldMin} นาที`
              : heldMin < 1440
                ? `${(heldMin / 60).toFixed(1)} ชม.`
                : `${Math.round(heldMin / 1440)} วัน`;
            contextParts.push(`ถือ ${heldDisplay}`);
          }
          if (trade.useStopLossOnUKC === true && trade.autoArmedAt) {
            contextParts.push('F1-armed SL-UKC');
          }
          if (trade.isPartialSell === true) {
            contextParts.push('partial-fill');
          }
        } catch (_) { /* non-fatal */ }
        const context = contextParts.join(' · ');
        await dispatch('sellFilled', {
          botId: trade.botId,
          botName: bot ? bot.name : '?',
          symbol: trade.symbol,
          qty: trade.sellQty || trade.buyQty,
          price: trade.sellPrice,
          realizedPnl: pnlUsdt,
          pnlPercent: trade.pnlPercent != null ? trade.pnlPercent : null, // FIX-2026-07-27: P&L % เทียบ buyQuoteQty
          pnlThb, // FIX-2026-07-26: P&L in THB (null ถ้า FX fetch ล้มเหลว)
          fxRate, // FIX-2026-07-26: rate ที่ใช้ (debug)
          usdtFree: bal ? bal.free : null,   // FIX-2026-07-27
          usdtLocked: bal ? bal.locked : null, // FIX-2026-07-27
          usdtTotal: bal ? bal.total : null,   // FIX-2026-07-27
          // FIX-2026-08-01: structured sellReason — render "Reason: …" line in template
          reason: trade.sellReason || null,
          reasonDetail: trade.sellReasonDetail || null,
          // FIX-2026-08-09: position context line (held duration + F1-armed flag + partial-fill)
          context: context || null,
          // FIX-2026-08-13: Today P&L running sum across all bots (USDT + THB equivalent)
          todayPnlUsdt, // null ถ้า aggregate ล้ม — template จะ skip line
          todayPnlThb,  // null ถ้า fxRate unavailable — template จะแสดง '?'
        });
        // Reset anti-spam state เมื่อ trade จบ
        tradeNotifyState.delete(String(trade._id));
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: trade:update handler error');
    }
  });

  eventBus.on('bot:enabled', async ({ botId }) => {
    try {
      const bot = await Bot.findById(botId, 'name').lean();
      if (!bot) return;
      await dispatch('botEnabled', { botId, botName: bot.name });
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: bot:enabled handler error');
    }
  });

  eventBus.on('bot:disabled', async ({ botId }) => {
    try {
      const bot = await Bot.findById(botId, 'name').lean();
      if (!bot) return;
      await dispatch('botDisabled', { botId, botName: bot.name });
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: bot:disabled handler error');
    }
  });

  // FIX-2026-08-07: bot:cooldown event — HYBRID CBv2 (BUY suppressed) แจ้งเตือน cooldown state
  //   - payload จาก trader._checkCBv2PanicClose: { botId, lockedUntil, lockHours, reason }
  //   - HYBRID: บอทยัง enable, แค่กั้น BUY — message ใช้ template 'botLocked' (เดิม)
  //   - ส่งครั้งเดียวต่อ cooldown event (no latch needed — trader จะส่งครั้งเดียวต่อ fire)
  //
  // FIX-2026-08-12 (audit Q12): bot:unlocked event — reset CB dedup latch
  //   - When user manually clears cooldown via POST /api/bots/:id/unlock-cbv2,
  //     the next CB fire should be allowed to send a telegram (no dedup).
  eventBus.on('bot:unlocked', async (p) => {
    if (p && p.botId) _resetCbDedup(p.botId);
  });

  eventBus.on('bot:cooldown', async (p) => {
    try {
      if (!p || !p.botId) return;
      const bot = await Bot.findById(p.botId, 'name').lean();
      if (!bot) return;
      await dispatch('botLocked', {
        botId: p.botId,
        botName: bot.name,
        reason: p.reason || 'cbv2_panic',
        lockedUntil: p.lockedUntil ? new Date(p.lockedUntil).toISOString() : null,
        lockHours: p.lockHours || null,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: bot:cooldown handler error');
    }
  });

  eventBus.on('bot:deleted', async (p) => {
    try {
      await dispatch('botDeleted', p);
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: bot:deleted handler error');
    }
  });

  eventBus.on('insufficient:balance', async (p) => {
    try {
      const bot = await Bot.findById(p.botId, 'name').lean();
      await dispatch('insufficientBalance', { ...p, botName: bot ? bot.name : '?' });
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: insufficient:balance handler error');
    }
  });

  // FIX-2026-07-26: TP low warning (จาก tpUpdater.js — NET TP% < threshold)
  //   - tpUpdater เป็นคนจัดการ anti-spam latch แล้ว (1 ครั้งต่อบอท จนกว่า TP จะ recover)
  //   - dispatcher ส่งตรงผ่าน tpLowPnL eventKey
  eventBus.on('tp:low', async (p) => {
    try {
      const bot = await Bot.findById(p.botId, 'name').lean();
      await dispatch('tpLowPnL', {
        botId: p.botId,
        botName: bot ? bot.name : (p.botName || '?'),
        symbol: p.symbol,
        timeframe: p.timeframe,
        tpPct: p.tpPct,
        threshold: p.threshold,
        autoUpdateTp: p.autoUpdateTp,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: tp:low handler error');
    }
  });

  // FIX-2026-08-02: DCA + BEP stack events (3 new subscribers)
  eventBus.on('dcaLayerAdded', async (p) => {
    try {
      const bot = await Bot.findById(p.botId, 'name').lean();
      await dispatch('dcaLayerAdded', {
        botId: p.botId,
        botName: bot ? bot.name : (p.botName || '?'),
        symbol: p.symbol,
        layerIndex: p.layerIndex,
        layerCount: p.dcaLayerCount,
        maxLayers: p.maxLayers,
        layerPrice: p.layerPrice,
        layerQty: p.layerQty,
        stackBep: p.stackBep,
        stackTotalQty: p.stackTotalQty,
        stackTotalSpent: p.stackTotalSpent,
        targetSellPrice: p.targetSellPrice,
        tpBase: p.tpBase,
        tpEffective: p.tpEffective,
        tpTrendMultiplier: p.tpTrendMultiplier,
        tpTrendEnabled: p.tpTrendEnabled,
        feeRate: p.feeRate,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: dcaLayerAdded handler error');
    }
  });

  eventBus.on('dcaTargetHit', async (p) => {
    try {
      const bot = await Bot.findById(p.botId, 'name').lean();
      await dispatch('dcaTargetHit', {
        botId: p.botId,
        botName: bot ? bot.name : (p.botName || '?'),
        symbol: p.symbol,
        layerCount: p.layerCount,
        stackBep: p.stackBep,
        stackTotalQty: p.stackTotalQty,
        stackTotalSpent: p.stackTotalSpent,
        sellPrice: p.sellPrice,
        sellQty: p.sellQty,
        realizedPnl: p.realizedPnl,
        pnlPercent: p.pnlPercent,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: dcaTargetHit handler error');
    }
  });

  eventBus.on('dcaMaxLayersHit', async (p) => {
    try {
      const bot = await Bot.findById(p.botId, 'name').lean();
      await dispatch('dcaMaxLayersHit', {
        botId: p.botId,
        botName: bot ? bot.name : (p.botName || '?'),
        symbol: p.symbol,
        layerCount: p.layerCount,
        maxLayers: p.maxLayers,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: dcaMaxLayersHit handler error');
    }
  });

  // bookTicker → cache price (ใช้กับ periodic PnL scan)
  eventBus.on('bookTicker', (t) => {
    if (!t || !t.symbol) return;
    lastBookTicker.set(t.symbol, { bid: t.bid, ask: t.ask, ts: t.ts });
  });

  // FIX-2026-08-05: Auto-Buy BNB events
  eventBus.on('bnbAutoBuySuccess', async (p) => {
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled || !cfg.hasToken) return;
      await dispatch('bnbAutoBuy', {
        kind: 'success',
        bnbQtyBought: p.bnbQtyBought,
        usdtSpent: p.usdtSpent,
        bnbPriceFilled: p.bnbPriceFilled,
        orderId: p.orderId,
        bnbQtyBefore: p.bnbQtyBefore,
        bnbValueBefore: p.bnbValueBefore,
        threshold: p.threshold,
        topUpUsdt: p.topUpUsdt,
        source: p.source,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: bnbAutoBuySuccess handler error');
    }
  });
  eventBus.on('bnbAutoBuyFailed', async (p) => {
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled || !cfg.hasToken) return;
      await dispatch('bnbAutoBuy', {
        kind: 'failed',
        reason: p.reason,
        code: p.code,
        msg: p.msg,
        topUpUsdt: p.topUpUsdt,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: bnbAutoBuyFailed handler error');
    }
  });
  eventBus.on('bnbAutoBuySkipped', async (p) => {
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled || !cfg.hasToken) return;
      await dispatch('bnbAutoBuy', {
        kind: 'skipped',
        reason: p.reason,
        usdtAvail: p.usdtAvail,
        needed: p.needed,
        spentToday: p.spentToday,
        cap: p.cap,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: bnbAutoBuySkipped handler error');
    }
  });
  // FIX-2026-08-06: Binance delist monitor events
  //   - delistMonitor:scheduled → dispatch('delistDetected') with anti-spam latch via delistMonitor.markNotified()
  //   - delistMonitor:monitoring-added → dispatch('delistMonitoring') per-symbol (early warning, no latch)
  //   - delistMonitor:schedule-cleared → log only (Binance cancelled delisting)
  eventBus.on('delistMonitor:scheduled', async (p) => {
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled || !cfg.hasToken || !p || !p.symbol) return;
      const delistMonitor = require('./binanceDelistMonitor');
      if (delistMonitor.wasNotified(p.symbol)) {
        logger.debug({ symbol: p.symbol }, 'telegramNotifier: delist already notified — skip duplicate');
        return;
      }
      const daysUntil = (p.delistTime - Date.now()) / (24 * 60 * 60 * 1000);
      await dispatch('delistDetected', {
        symbol: p.symbol,
        delistTime: p.delistTime,
        delistDateIso: p.delistDateIso,
        daysUntil,
      });
      delistMonitor.markNotified(p.symbol);
    } catch (err) {
      logger.warn({ err: err.message, symbol: p && p.symbol }, 'telegramNotifier: delistMonitor:scheduled handler error');
    }
  });
  eventBus.on('delistMonitor:monitoring-added', async (p) => {
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled || !cfg.hasToken || !p || !Array.isArray(p.symbols)) return;
      for (const symbol of p.symbols) {
        await dispatch('delistMonitoring', { symbol, tags: ['Monitoring'] });
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: delistMonitor:monitoring-added handler error');
    }
  });
  eventBus.on('delistMonitor:schedule-cleared', async (p) => {
    if (!p || !p.symbol) return;
    logger.info({ symbol: p.symbol }, 'telegramNotifier: delist schedule cleared (no-op)');
  });

  // FIX-2026-08-07: Auto Add New Bot — relay autoAddBot:created event
  //   - ส่งทุกครั้งที่ autoAddBot service สร้างบอทใหม่ (ทั้ง manual/periodic)
  //   - bot ถูกสร้างในสถานะ DISABLED — message เตือน user ให้ไปเปิดเอง
  eventBus.on('autoAddBot:created', async (p) => {
    try {
      if (!p || !p.botId) return;
      await dispatch('autoAddBotCreated', {
        botId: p.botId,
        botName: p.botName || '(auto)',
        symbol: p.symbol,
        timeframe: p.timeframe,
        score: p.score,
        kcMinPct: p.kcMinPct,
        suggestedTpPct: p.suggestedTpPct,
        autoEnabled: p.autoEnabled === true, // FIX-2026-08-07: แยก message ระหว่าง "เริ่มเทรดแล้ว" vs "DISABLED รอเปิด"
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: autoAddBot:created handler error');
    }
  });
  // FIX-2026-08-23: Auto Add Bot — relay autoAddBot:restored event
  //   - ส่งเมื่อ autoAddBot service restore + activate บอท soft-deleted ที่ symbol ตรงเกณฑ์
  //   - event ต่างหากจาก autoAddBot:created — เพราะเป็นบอทเก่า (มี trade history) ไม่ใช่บอทใหม่
  eventBus.on('autoAddBot:restored', async (p) => {
    try {
      if (!p || !p.botId) return;
      await dispatch('autoAddBotRestored', {
        botId: p.botId,
        botName: p.botName || '(restored)',
        symbol: p.symbol,
        timeframe: p.timeframe,
        score: p.score,
        kcMinPct: p.kcMinPct,
        suggestedTpPct: p.suggestedTpPct,
        daysSinceDelete: p.daysSinceDelete || 0,
        autoEnabled: p.autoEnabled === true,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: autoAddBot:restored handler error');
    }
  });

  // FIX-2026-08-30 / Phase 4: Auto-Timing Suppress Hit
  //   - emitted from services/autoTiming.decideForBot() latched at 1/bot/day per cell
  //   - p = { botId, botName, symbol, timeframe, day, hour, action, reason, holdBand }
  eventBus.on('autoTiming:suppressHit', async (p) => {
    try {
      if (!p || !p.botId) return;
      await dispatch('autoTimingSuppressHit', {
        botId: p.botId,
        botName: p.botName,
        symbol: p.symbol,
        timeframe: p.timeframe,
        day: p.day,
        hour: p.hour,
        action: p.action || 'suppress',
        reason: p.reason || 'cell_suppressed',
        holdBand: p.holdBand,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'telegramNotifier: autoTiming:suppressHit handler error');
    }
  });
}

// ─── Periodic scan (PnL threshold + stuck duration) ───
async function scanOpenPositions() {
  const cfg = await loadConfig();
  if (!cfg.enabled || !cfg.hasToken) return;
  const lossThr = Number(cfg.thresholds.positionLossPct);
  const profitThr = Number(cfg.thresholds.positionProfitPct);
  const stuckMin = Number(cfg.thresholds.positionStuckMin);

  // Quick gate: ถ้าทุก event off ไม่ต้อง query
  if (!cfg.events.positionLoss && !cfg.events.positionProfit && !cfg.events.positionStuck) return;

  const trades = await Trade.find({
    state: { $in: ['holding', 'selling'] },
  }).select('_id botId symbol buyPrice buyFilledAt buyQty').lean();

  if (trades.length === 0) return;

  const botIds = [...new Set(trades.map((t) => String(t.botId)))];
  const bots = await Bot.find({ _id: { $in: botIds } }, 'name').lean();
  const botNameMap = new Map(bots.map((b) => [String(b._id), b.name]));

  const now = Date.now();
  for (const t of trades) {
    const id = String(t._id);
    let st = tradeNotifyState.get(id);
    if (!st) {
      st = { side: null, stuckNotified: false, buyNotified: false };
      tradeNotifyState.set(id, st);
    }
    const botName = botNameMap.get(id) || '?';

    // ─── PnL crossing (only if we have a price) ───
    const tk = lastBookTicker.get(t.symbol);
    if (tk && t.buyPrice && Number.isFinite(tk.bid)) {
      const bid = Number(tk.bid);
      const pnlPct = ((bid - t.buyPrice) / t.buyPrice) * 100;

      const inLossZone = pnlPct <= -Math.abs(lossThr);
      const inProfitZone = pnlPct >= Math.abs(profitThr);
      const inNeutral = !inLossZone && !inProfitZone;

      if (cfg.events.positionLoss && inLossZone && st.side !== 'loss') {
        await dispatch('positionLoss', { botId: t.botId, botName, symbol: t.symbol, pnlPct });
        st.side = 'loss';
      } else if (cfg.events.positionProfit && inProfitZone && st.side !== 'profit') {
        await dispatch('positionProfit', { botId: t.botId, botName, symbol: t.symbol, pnlPct });
        st.side = 'profit';
      } else if (inNeutral) {
        // กลับเข้า neutral → reset latch เพื่อให้ next crossing re-fire
        st.side = null;
      }
      tradeNotifyState.set(id, st);
    } else if (!tk) {
      logger.debug({ symbol: t.symbol, tradeId: id }, 'telegramNotifier: scan skipping (no bookTicker)');
    }

    // ─── Stuck check ───
    if (cfg.events.positionStuck && !st.stuckNotified && t.buyFilledAt) {
      const heldMs = now - new Date(t.buyFilledAt).getTime();
      const heldMin = Math.floor(heldMs / 60000);
      if (heldMin >= stuckMin) {
        await dispatch('positionStuck', { botId: t.botId, botName, symbol: t.symbol, heldMin });
        st.stuckNotified = true;
        tradeNotifyState.set(id, st);
      }
    }
  }
}

// ─── Summary scanner (FIX-2026-07-26) ────────────────
// ทุก 60s tick — เช็คว่าถึงเวลาส่ง summary หรือยัง:
//   - daily: ส่งตอน 00:00 (start of new day = end of previous day)
//   - weekly: ส่งตอนจบ week (00:00 ของวันจันทร์ — start of new week)
//   - monthly: ส่งตอนจบ month (00:00 ของวันที่ 1 ของเดือนใหม่)
// ใช้ "ย้อนหลัง" จาก now เช่น "daily ส่งตอน 00:00 → query ข้อมูล 00:00 ของเมื่อวาน ถึง 00:00 วันนี้"
const SUMMARY_SCAN_INTERVAL_MS = 60 * 1000;

function getLocalDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getLocalWeekKey(d) {
  // ISO week number: Monday=1, Sunday=7
  const tmp = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = (tmp.getDay() + 6) % 7; // Monday=0
  tmp.setDate(tmp.getDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(tmp.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((tmp.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${tmp.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function getLocalMonthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function startOfLocalDay(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

// aggregate trades → { trades, wins, losses, pnlUsdt, perBot: [{ name, symbol, trades, pnlUsdt }] }
async function aggregateTrades(startDate, endDate) {
  const trades = await Trade.find({
    sellFilledAt: { $gte: startDate, $lt: endDate },
    realizedPnl: { $ne: null },
  }).select('_id botId symbol realizedPnl').lean();
  const bots = await Bot.find({ _id: { $in: trades.map((t) => t.botId) } }, 'name').lean();
  const botNameMap = new Map(bots.map((b) => [String(b._id), b.name]));
  let pnlUsdt = 0;
  let wins = 0;
  let losses = 0;
  const perBotMap = new Map();
  for (const t of trades) {
    const pnl = Number(t.realizedPnl) || 0;
    pnlUsdt += pnl;
    if (pnl > 0) wins += 1; else if (pnl < 0) losses += 1;
    const key = `${t.botId}|${t.symbol}`;
    const cur = perBotMap.get(key) || { botId: t.botId, name: botNameMap.get(String(t.botId)) || '?', symbol: t.symbol, trades: 0, pnlUsdt: 0 };
    cur.trades += 1;
    cur.pnlUsdt += pnl;
    perBotMap.set(key, cur);
  }
  return {
    trades: trades.length,
    wins,
    losses,
    pnlUsdt,
    perBot: Array.from(perBotMap.values()).sort((a, b) => b.pnlUsdt - a.pnlUsdt),
  };
}

async function scanAndDispatchSummaries() {
  const cfg = await loadConfig();
  if (!cfg.enabled || !cfg.hasToken || !cfg.chatId) return;
  if (!cfg.events.dailySummary && !cfg.events.weeklySummary && !cfg.events.monthlySummary) return;

  // fetch FX rate (USDT→THB) — fail-safe
  let fxRate = null;
  try { fxRate = (await fxService.getUsdtToThb()).rate; } catch (err) {
    logger.warn({ err: err.message }, 'telegramNotifier: summary FX fetch failed — THB omitted');
  }

  const now = new Date();
  const todayKey = getLocalDateKey(now);

  // ─── Daily: ส่งตอน HH:00:00 (ใชม้งานกี่ชั่วโมงแล้ว trade ของเมื่อวาน) — ใช้ "end-of-day" trigger:
  //   - ส่ง daily summary เมื่อ lastSummarySent.day !== todayKey
  //   - query: 00:00 ของเมื่อวาน → 00:00 วันนี้
  if (cfg.events.dailySummary && lastSummarySent.day !== todayKey) {
    // รอให้ครบอย่างน้อย 5 นาทีของวันใหม่ก่อน (กัน race) — ใช้เวลาเป็น 00:05+
    if (now.getHours() === 0 && now.getMinutes() >= 5) {
      const endDate = startOfLocalDay(now);
      const startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
      try {
        const agg = await aggregateTrades(startDate, endDate);
        const pnlThb = fxRate != null ? Number((agg.pnlUsdt * fxRate).toFixed(2)) : null;
        const yesterday = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
        await dispatch('dailySummary', {
          ...agg,
          pnlThb,
          fxRate,
          rangeLabel: getLocalDateKey(yesterday),
        });
        lastSummarySent.day = todayKey;
      } catch (err) {
        logger.warn({ err: err.message }, 'telegramNotifier: dailySummary failed');
      }
    }
  }

  // ─── Weekly: ส่งตอนจบ week (00:00 ของวันจันทร์) ───
  const weekKey = getLocalWeekKey(now);
  if (cfg.events.weeklySummary && lastSummarySent.week !== weekKey) {
    // เช็คว่าเป็นวันจันทร์ 00:05+
    if (now.getDay() === 1 && now.getHours() === 0 && now.getMinutes() >= 5) {
      // ย้อนหลัง 7 วัน (Mon 00:00 → Sun 24:00 = Mon 00:00 of current week)
      const endDate = startOfLocalDay(now);
      const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
      try {
        const agg = await aggregateTrades(startDate, endDate);
        const pnlThb = fxRate != null ? Number((agg.pnlUsdt * fxRate).toFixed(2)) : null;
        await dispatch('weeklySummary', {
          ...agg,
          pnlThb,
          fxRate,
          rangeLabel: weekKey,
        });
        lastSummarySent.week = weekKey;
      } catch (err) {
        logger.warn({ err: err.message }, 'telegramNotifier: weeklySummary failed');
      }
    }
  }

  // ─── Monthly: ส่งตอนจบ month (00:00 ของวันที่ 1 ของเดือนใหม่) ───
  // FIX-2026-08-01: label = เดือนที่ถูกสรุป (ก่อนหน้า) ไม่ใช่เดือนปัจจุบัน
  //   - ก่อนแก้: rangeLabel = current month (2026-08) → user งง เพราะ trades ของ July
  //   - หลังแก้: rangeLabel = previous month (2026-07) ตรงกับช่วงเวลาที่ aggregate
  const monthKey = getLocalMonthKey(now);
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthKey = getLocalMonthKey(prevMonthDate);
  if (cfg.events.monthlySummary && lastSummarySent.month !== prevMonthKey) {
    if (now.getDate() === 1 && now.getHours() === 0 && now.getMinutes() >= 5) {
      // ย้อนหลังเดือนที่แล้ว (วันที่ 1 เดือนก่อนหน้า → วันที่ 1 เดือนปัจจุบัน)
      const endDate = startOfLocalDay(now);
      const startDate = new Date(endDate.getFullYear(), endDate.getMonth() - 1, 1);
      try {
        const agg = await aggregateTrades(startDate, endDate);
        const pnlThb = fxRate != null ? Number((agg.pnlUsdt * fxRate).toFixed(2)) : null;
        await dispatch('monthlySummary', {
          ...agg,
          pnlThb,
          fxRate,
          rangeLabel: prevMonthKey,
        });
        lastSummarySent.month = prevMonthKey;
      } catch (err) {
        logger.warn({ err: err.message }, 'telegramNotifier: monthlySummary failed');
      }
    }
  }

  // ─── Auto-Timing Weekly Summary (FIX-2026-08-30 / Phase 4) ───
  //   - ใช้ AutoTimingLog 7 วันล่าสุด (Mon 00:00 → Sun 24:00) — ส่งพร้อม weeklySummary
  //   - รวม byAction + tier2Promotions + suppressedHits + top suppressed bot names
  if (cfg.events.autoTimingWeeklySummary && lastSummarySent.autoTimingWeek !== weekKey) {
    if (now.getDay() === 1 && now.getHours() === 0 && now.getMinutes() >= 5) {
      try {
        const AutoTimingLog = require('../db/models/AutoTimingLog');
        const Bot = require('../db/models/Bot');
        const endDate = startOfLocalDay(now);
        const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
        const logs = await AutoTimingLog.find({
          ts: { $gte: startDate, $lt: endDate },
        }).select({ action: 1, blocked: 1, botId: 1 }).lean();
        const byAction = { suppress: 0, limit: 0, encourage: 0, stimulate: 0, allow: 0 };
        let suppressedHits = 0;
        const suppressedBotIds = new Set();
        for (const r of (logs || [])) {
          if (byAction[r.action] != null) byAction[r.action] += 1;
          if (r.blocked && r.action === 'suppress') {
            suppressedHits += 1;
            if (r.botId) suppressedBotIds.add(String(r.botId));
          }
        }
        // lookup bot names (capped 100)
        const botIdArr = [...suppressedBotIds].slice(0, 100);
        const bots = botIdArr.length > 0
          ? await Bot.find({ _id: { $in: botIdArr } }).select({ name: 1 }).lean()
          : [];
        const suppressedBotNames = bots.map((b) => b.name).filter(Boolean);
        await dispatch('autoTimingWeeklySummary', {
          rangeLabel: weekKey,
          totalDecisions: (logs || []).length,
          byAction,
          tier2Promotions: 0, // tracked via autoTimingLastStats — not joined here for simplicity
          suppressedHits,
          suppressedBotNames,
        });
        lastSummarySent.autoTimingWeek = weekKey;
      } catch (err) {
        logger.warn({ err: err.message }, 'telegramNotifier: autoTimingWeeklySummary failed');
      }
    }
  }
}

// ─── Lifecycle ────────────────────────────────────────
// FIX-2026-07-24: mark async + return Promise so caller สามารถ .catch() ได้
//   (เดิมเป็น sync function → caller `.catch()` throws "Cannot read properties of undefined")
// FIX-2026-08-05: BNB low-balance scanner (crossing-latch anti-spam)
//   - scan ทุก 5 นาที (read-only Binance getAccount + bookTicker, shared cache 30s)
//   - ส่ง telegram เฉพาะ crossing down→below threshold (latch=true)
//   - reset latch เมื่อ BNB กลับขึ้นเหนือ threshold → รอบใหม่พร้อมส่ง
const BNB_BALANCE_SCAN_INTERVAL_MS = 5 * 60 * 1000;
let bnbBalanceTimer = null;
let bnbBalanceNotified = false; // latch: true = เคยแจ้งแล้วในรอบปัจจุบัน, reset เมื่อ BNB กลับเหนือ threshold

async function scanBnbBalance() {
  const cfg = await loadConfig();
  if (!cfg.enabled || !cfg.hasToken) return;
  if (!cfg.events.bnbLowBalance) return;
  const balance = await fetchBnbBalance();
  if (!balance) return;
  const threshold = Number(cfg.thresholds.bnbLowBalanceUsdt);
  if (!Number.isFinite(threshold) || threshold <= 0) return;
  const isLow = balance.usdtValue < threshold && balance.qty > 0;
  if (isLow && !bnbBalanceNotified) {
    await dispatch('bnbLowBalance', {
      bnbQty: balance.qty,
      bnbUsdtPrice: balance.usdtPrice,
      bnbValueUsdt: balance.usdtValue,
      threshold,
    });
    bnbBalanceNotified = true;
  } else if (!isLow && bnbBalanceNotified) {
    bnbBalanceNotified = false;
    logger.info({ bnbQty: balance.qty, bnbValueUsdt: balance.usdtValue }, 'telegramNotifier: BNB balance recovered above threshold');
  }
}

async function start() {
  bindEventHandlers();
  if (pnlTimer) clearInterval(pnlTimer);
  if (stuckTimer) clearInterval(stuckTimer);
  if (summaryTimer) clearInterval(summaryTimer);
  if (bnbBalanceTimer) clearInterval(bnbBalanceTimer); // FIX-2026-08-05
  pnlTimer = setInterval(() => {
    scanOpenPositions().catch((err) => logger.warn({ err: err.message }, 'telegramNotifier: pnl scan failed'));
  }, PNL_SCAN_INTERVAL_MS);
  stuckTimer = setInterval(() => {
    scanOpenPositions().catch((err) => logger.warn({ err: err.message }, 'telegramNotifier: stuck scan failed'));
  }, STUCK_SCAN_INTERVAL_MS);
  // FIX-2026-07-26: summary scanner — เช็คทุก 60s ว่าถึงเวลาส่ง summary หรือยัง
  summaryTimer = setInterval(() => {
    scanAndDispatchSummaries().catch((err) => logger.warn({ err: err.message }, 'telegramNotifier: summary scan failed'));
  }, SUMMARY_SCAN_INTERVAL_MS);
  // FIX-2026-08-05: BNB balance scanner — เช็คทุก 5 นาทีว่า BNB value ต่ำกว่า threshold หรือไม่
  bnbBalanceTimer = setInterval(() => {
    scanBnbBalance().catch((err) => logger.warn({ err: err.message }, 'telegramNotifier: bnb balance scan failed'));
  }, BNB_BALANCE_SCAN_INTERVAL_MS);
  // initial scan หลัง 5s (ให้ eventBus + bookTicker warm up)
  setTimeout(() => {
    scanOpenPositions().catch((err) => logger.warn({ err: err.message }, 'telegramNotifier: initial scan failed'));
  }, 5000);
  // FIX-2026-08-05: initial BNB scan หลัง 10s (รอ bookTicker cache warm up)
  setTimeout(() => {
    scanBnbBalance().catch((err) => logger.warn({ err: err.message }, 'telegramNotifier: initial bnb scan failed'));
  }, 10000);
  // initial config load
  loadConfig(true).catch(() => {});
  logger.info({
    pnlSec: PNL_SCAN_INTERVAL_MS / 1000,
    stuckSec: STUCK_SCAN_INTERVAL_MS / 1000,
    bnbSec: BNB_BALANCE_SCAN_INTERVAL_MS / 1000, // FIX-2026-08-05
  }, 'telegramNotifier: started');
}

function stop() {
  if (pnlTimer) { clearInterval(pnlTimer); pnlTimer = null; }
  if (stuckTimer) { clearInterval(stuckTimer); stuckTimer = null; }
  if (summaryTimer) { clearInterval(summaryTimer); summaryTimer = null; }
  if (bnbBalanceTimer) { clearInterval(bnbBalanceTimer); bnbBalanceTimer = null; } // FIX-2026-08-05
  eventBus.removeAllListeners('trade:update');
  eventBus.removeAllListeners('bot:enabled');
  eventBus.removeAllListeners('bot:disabled');
  eventBus.removeAllListeners('bot:cooldown'); // FIX-2026-08-07: HYBRID CBv2 cooldown event
  eventBus.removeAllListeners('bot:deleted');
  eventBus.removeAllListeners('insufficient:balance');
  eventBus.removeAllListeners('tp:low'); // FIX-2026-07-26
  eventBus.removeAllListeners('autoAddBot:created'); // FIX-2026-08-07
  eventBus.removeAllListeners('autoAddBot:restored'); // FIX-2026-08-23
  eventBus.removeAllListeners('bookTicker');
  usdtBalanceCache = null; // FIX-2026-07-27: reset balance cache
  bnbBalanceCache = null; // FIX-2026-08-05: reset BNB cache
  bnbBalanceNotified = false; // FIX-2026-08-05: reset latch
  // FIX-2026-08-06: delist monitor event listeners
  eventBus.removeAllListeners('delistMonitor:scheduled');
  eventBus.removeAllListeners('delistMonitor:monitoring-added');
  eventBus.removeAllListeners('delistMonitor:schedule-cleared');
  bound = false;
  logger.info('telegramNotifier: stopped');
}

module.exports = {
  start,
  stop,
  reloadConfig,
  // exposed for telegram.routes.js POST /test
  sendNow: dispatch,
  // FIX-2026-08-05: expose BNB cache สำหรับ /api/account/bnb-status route (shared cache, no extra Binance call)
  getBnbBalanceCached,
  invalidateBnbBalanceCache,
  // 2026-09-02: shareCard → Telegram photo upload (multipart/form-data)
  sendTelegramPhoto,
};
