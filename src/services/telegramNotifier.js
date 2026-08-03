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
  // FIX-2026-08-02: DCA + BEP stack events (per user request: full notifications, not compact)
  dcaLayerAdded: true, dcaTargetHit: true, dcaMaxLayersHit: true,
};
const DEFAULT_THRESHOLDS = { positionLossPct: 2, positionProfitPct: 1, positionStuckMin: 30 };

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

const PNL_SCAN_INTERVAL_MS = 30 * 1000;   // 30s
const STUCK_SCAN_INTERVAL_MS = 60 * 1000; // 60s
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
const lastSummarySent = { day: null, week: null, month: null };

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
async function dispatch(eventKey, payload) {
  const cfg = await loadConfig();
  if (!cfg.enabled || !cfg.hasToken || !cfg.chatId) return false;
  if (!cfg.events[eventKey]) return false;
  const text = renderMessage(eventKey, payload, cfg);
  if (!text) return false;
  return sendTelegram(cfg.token, cfg.chatId, text);
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
        // FIX-2026-08-01: structured sellReason — บอกว่า SELL trigger มาจากอะไร
        //   - ไม่แสดงถ้า p.reason ว่าง (backwards compat — trade เก่าไม่มี field)
        let reasonLine = '';
        if (p.reason) {
          const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
          const REASON_LABELS = {
            tp_hit:                 '🎯 TP target hit',
            tp_trend_boosted:       '🎯 TP (trend-boosted)',
            cb_panic:                '🚨 Circuit-breaker panic-close',
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
          const reasonDetail = p.reasonDetail ? truncate(String(p.reasonDetail), 80) : '';
          reasonLine = reasonDetail
            ? `\nReason: ${reasonLabel} (${reasonDetail})`
            : `\nReason: ${reasonLabel}`;
        }
        return `${emoji} SELL filled\nBot: ${p.botName}\nSymbol: ${p.symbol}\nQty: ${formatQty(p.qty)} @${formatPrice(p.price, p.symbol)}\nP&L: ${sign}${pnl.toFixed(4)} USDT${pctInline}${reasonLine}${thbLine}${balLine}`;
      }
      case 'insufficientBalance':
        return `💸 Insufficient USDT\nBot: ${p.botName}\nSymbol: ${p.symbol}\n${p.note || ''}`.trim();
      case 'botEnabled':
        return `▶️ Bot enabled\nBot: ${p.botName}`;
      case 'botDisabled':
        return `⏸ Bot disabled\nBot: ${p.botName}`;
      case 'botDeleted':
        return `🗑 Bot deleted\nBot: ${p.name || p.botId || '(unknown)'}`;
      case 'positionLoss':
        return `🔻 Position loss > ${cfg.thresholds.positionLossPct}%\nBot: ${p.botName}\nSymbol: ${p.symbol}\nPnL: ${p.pnlPct.toFixed(2)}%`;
      case 'positionProfit':
        return `🔺 Position profit > ${cfg.thresholds.positionProfitPct}%\nBot: ${p.botName}\nSymbol: ${p.symbol}\nPnL: +${p.pnlPct.toFixed(2)}%`;
      case 'positionStuck':
        return `⏳ Position open > ${cfg.thresholds.positionStuckMin}m\nBot: ${p.botName}\nSymbol: ${p.symbol}\nHeld: ${p.heldMin}m`;
      // FIX-2026-07-26: เตือน NET TP ต่ำกว่า threshold
      case 'tpLowPnL':
        return `📉 TP ต่ำเกินไป\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'})\nTP (NET): ${p.tpPct != null ? p.tpPct.toFixed(3) : '?'}%\nThreshold: ${p.threshold != null ? p.threshold.toFixed(3) : '0.2'}%\n\nแนะนำ: ปรับ capitalPerTrade สูงขึ้น · เพิ่ม kcMult · หรือปิด autoUpdateTp`;
      // FIX-2026-08-01: Circuit-breaker (CB) panic-sell — เดิมชื่อ case 'sls1PanicClose'
      case 'cbPanicClose':
        return `🚨 Circuit-breaker panic-sell — ปิดทุก position\nBot: ${p.botName}\nSymbol: ${p.symbol} (${p.timeframe || '?'})\n3 แท่งติด red + below lowerKC → กันกราฟไหล\nClosed: ${p.closedCount} ไม้\nLowerKC: ${p.lastLower || '?'}`;
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
      // FIX-2026-07-26: สรุปการเทรดรายวัน/สัปดาห์/เดือน
      case 'dailySummary':
      case 'weeklySummary':
      case 'monthlySummary':
        return renderSummaryMessage(eventKey, p, cfg);
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

function formatQty(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return String(q);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(8);
}

// FIX-2026-07-31: ใช้ tickSize จาก Binance (authoritative per-symbol) — ก่อนหน้านี้ heuristic
//   >=1 → 6 dp, <1 → 10 dp (over-precise สำหรับ low-price coins เช่น ZILUSDT)
//   ZILUSDT จริงควรแสดง 6 dp (เช่น "0.014500") ตาม PRICE_FILTER.tickSize
//   ส่ง symbol ตาม payload.p.symbol เพื่อ lookup tickSize ที่ถูกต้อง
function formatPrice(p, symbol) {
  return symbolInfo.formatPrice(p, symbol);
}

// ─── HTTPS send (with 1 retry on transient errors) ────
function sendTelegram(token, chatId, text) {
  return new Promise((resolve) => {
    let attempt = 0;
    const tryOnce = () => {
      attempt += 1;
      const body = JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      });
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
}

// ─── Lifecycle ────────────────────────────────────────
// FIX-2026-07-24: mark async + return Promise so caller สามารถ .catch() ได้
//   (เดิมเป็น sync function → caller `.catch()` throws "Cannot read properties of undefined")
async function start() {
  bindEventHandlers();
  if (pnlTimer) clearInterval(pnlTimer);
  if (stuckTimer) clearInterval(stuckTimer);
  if (summaryTimer) clearInterval(summaryTimer);
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
  // initial scan หลัง 5s (ให้ eventBus + bookTicker warm up)
  setTimeout(() => {
    scanOpenPositions().catch((err) => logger.warn({ err: err.message }, 'telegramNotifier: initial scan failed'));
  }, 5000);
  // initial config load
  loadConfig(true).catch(() => {});
  logger.info({ pnlSec: PNL_SCAN_INTERVAL_MS / 1000, stuckSec: STUCK_SCAN_INTERVAL_MS / 1000 }, 'telegramNotifier: started');
}

function stop() {
  if (pnlTimer) { clearInterval(pnlTimer); pnlTimer = null; }
  if (stuckTimer) { clearInterval(stuckTimer); stuckTimer = null; }
  if (summaryTimer) { clearInterval(summaryTimer); summaryTimer = null; }
  eventBus.removeAllListeners('trade:update');
  eventBus.removeAllListeners('bot:enabled');
  eventBus.removeAllListeners('bot:disabled');
  eventBus.removeAllListeners('bot:deleted');
  eventBus.removeAllListeners('insufficient:balance');
  eventBus.removeAllListeners('tp:low'); // FIX-2026-07-26
  eventBus.removeAllListeners('bookTicker');
  usdtBalanceCache = null; // FIX-2026-07-27: reset balance cache
  bound = false;
  logger.info('telegramNotifier: stopped');
}

module.exports = {
  start,
  stop,
  reloadConfig,
  // exposed for telegram.routes.js POST /test
  sendNow: dispatch,
};
