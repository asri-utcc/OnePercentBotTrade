'use strict';

const mongoose = require('mongoose');

// FIX-2026-08-01: เพิ่ม 'starting' สำหรับ atomic create+enable (POST /api/bots ที่ data.enabled=true)
//   - ใช้ตอน create บอทที่ enable=true ทันที — เป็น transient state ก่อน botManager.enableBot() ทำงานเสร็จ
//   - เมื่อ enable สำเร็จจะถูกเปลี่ยนเป็น 'idle' (รอ S1 signal) → 'waiting_fill' (มี trade เปิดอยู่)
const BOT_STATUSES = ['idle', 'starting', 'waiting_fill', 'holding', 'selling', 'error', 'disabled'];

const botSchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    symbol: { type: String, required: true, uppercase: true, trim: true, default: 'BNBUSDT' },
    timeframe: { type: String, required: true, default: '5m' },
    capitalPerTrade: { type: Number, required: true, default: 10, min: 0.00000001 },
    maxTrades: { type: Number, required: true, default: 10, min: 1, max: 1000 },
    // FIX-2026-08-02: DCA + BEP stack mode (opt-in, default off — backward compatible)
    //   - false (default) → พฤติกรรมเดิม 1 BUY → 1 SELL (no change)
    //   - true → 1 บอท = 1 open DCA stack ในเวลาเดียว, S1 แต่ละครั้งจะเพิ่ม layer เข้า stack
    //   - เมื่อ layer ใหม่ fill → recompute BEP = totalSpent/totalQty → cancel SELL เก่า + place ใหม่ที่ BEP+TP
    //   - SL-UKC apply per-stack (ใช้ BEP) แทน per-trade
    //   - CB panic-sell ถูก disable ทั้งหมดใน DCA mode (matches "no cut loss" ของ DCA strategy)
    dcaEnabled: { type: Boolean, default: false },
    dcaMaxLayers: {
      type: Number,
      default: 3,
      min: 1,
      max: 100,
      validate: {
        validator: Number.isInteger,
        message: 'dcaMaxLayers must be an integer between 1 and 100',
      },
    },
    // FIX-2026-08-03: DCA + Martingale sizing (opt-in, default off — backward compatible 100%)
    //   - false (default) → ทุก DCA layer ใช้ capitalPerTrade เท่ากัน (พฤติกรรมเดิม)
    //   - true → layer N notional = capitalPerTrade × martingaleMultiplier^(N-1)
    //     เช่น mult=1.5, layers=3 → [10, 15, 22.5] USDT (รวม 47.5 vs fixed 30)
    //   - apply เฉพาะ DCA mode (martingaleEnabled requires dcaEnabled=true — validate ใน routes)
    //   - Martingale ไม่ retro-apply กับ layer เก่า (ใช้ actual qty จาก buyLayers เสมอ)
    //   - per-layer size cap (martingaleMaxLayerNotional) กันไม่ให้ layer สูงๆ ใหญ่เกินไป
    martingaleEnabled: { type: Boolean, default: false },
    martingaleMultiplier: {
      type: Number,
      default: 1.5,
      min: 1.0,
      max: 3.0,
    },
    // FIX-2026-08-03: per-layer notional cap (USDT) — safety guard กัน layer สูงๆ ใหญ่เกินไป
    //   - เช่น mult=2.0, layers=5, capital=10 → layer 5 = 10×16 = 160 USDT (vs cap 50 = 50)
    //   - default 100 USDT (สูงพอสำหรับส่วนใหญ่ — override ได้ใน bot-edit)
    martingaleMaxLayerNotional: {
      type: Number,
      default: 100,
      min: 1,
      max: 10000,
    },
    tpPercent: { type: Number, required: true, default: 0.1, min: 0.001 },
    // FIX-2026-07-24: รองรับทศนิยม (เช่น 0.5 = 30 วินาที) — ใช้สำหรับ timeframe สั้น (1m/3m) ที่รอ 1 นาทีนานเกิน
    retryTimeMin: { type: Number, required: true, default: 1, min: 0.1, max: 60 },
    retryMax: { type: Number, required: true, default: 1, min: 0, max: 10 },
    // FIX-2026-07-24: KC multiplier — ปรับความกว้างของ Keltner Channel ได้ต่อบอท (default 1.5 = KC เดิม)
    //   - ค่าน้อย → KC แคบ → signal S1 เกิดบ่อย (sensitive)
    //   - ค่ามาก → KC กว้าง → signal S1 เกิดน้อย (conservative)
    //   - apply กับทุก KC computation (signalEngine.computeBgStates/detectS1Signals, mini-chart, suggest-tp, scan-volatility)
    kcMult: { type: Number, required: true, default: 1.5, min: 0.5, max: 5 },
    // FIX-2026-07-23: stop-loss เมื่อราคาปิด candle ทะลุ upper-Keltner Channel
    //   - trigger บน kline:closed (close > upperKC ของ timeframe บอท)
    //   - ทำงานเฉพาะ state='selling' + buyPrice > candle.close (ยังขาดทุน)
    //   - cancel LIMIT_MAKER SELL ค้าง + MARKET SELL ทันที
    stopLossOnUpperKC: { type: Boolean, default: false },
    // FIX-2026-07-23: auto-update TP% — ระบบจะ recompute TP% จาก Min %KC(500 bars) + EMA20 trend(upper-TF)
    //   ทุกๆ ต้นชั่วโมง (cron-style, top-of-hour) แล้ว persist ลง bot.tpPercent
    //   - default false (ผู้ใช้ต้องเปิดเองต่อบอท)
    //   - updateTpAt: เวลาที่ update ล่าสุด (epoch ms) — ใช้แสดงใน UI และกัน update ซ้ำในรอบเดียวกัน
    autoUpdateTp: { type: Boolean, default: false },
    updateTpAt: { type: Number, default: null },
    enabled: { type: Boolean, default: false },
    enabledAt: { type: Date, default: null }, // เวลาที่ enable ล่าสุด (reset ทุกครั้งที่ disable→enable)
    totalActiveMs: { type: Number, default: 0 }, // เวลาเปิดสะสมทั้งหมด (ms) — บวกเพิ่มตอน disable, บวกต่อตอน enabled
    status: { type: String, enum: BOT_STATUSES, default: 'idle' },
    activeTrades: { type: Number, default: 0 },
    lastSignalAt: { type: Date, default: null },
    // FIX-2026-07-15: last signal candle close time (epoch ms) — persisted across restarts / WS reconnects
    //   ปัญหาเดิม: trader.lastSignalIndex เป็น in-memory → WS reconnect gap → kline:closed event หาย
    //   → signal รอบถัดไปถูก skip ตลอด จนกว่าจะ restart
    //   fix: เก็บ lastSignalCloseTime ใน DB + sweep candles ที่หายไปเมื่อ reconnect
    lastSignalCloseTime: { type: Number, default: null },
    lastError: { type: String, default: '' },
    // FIX-2026-08-01: per-bot warning (latched alerts) — แสดงใน UI badge
    //   - เมื่อมี trade ในบอทที่ partial-fill เกิน 1h → set warning message
    //   - reset เมื่อ trade ออกจาก selling state (SELL fill/cancel/freeze)
    warning: { type: String, default: '' },
    warningAt: { type: Date, default: null },
    // FIX-2026-07-24: per-bot minimum spread (in ticks) ที่ยอมให้ BUY ได้
    //   - low-cap coin เช่น RIF มี spread = 1 tick เสมอ → ถ้า default 2 = skip ทุก signal
    //   - ค่า 1 = ใช้ bid ตรงๆ (post-only guaranteed, fill เร็ว) — เหมาะกับ low-cap
    //   - ค่า 2 = ต้องมี margin >= 1 tick เพื่อ safety (เดิม) — เหมาะกับ mid/high-cap
    //   - ค่า 0 = ไม่สนใจ spread เลย (อันตราย อย่าใช้)
    minSpreadTicks: { type: Number, default: 1, min: 0, max: 10 },
    // FIX-2026-07-24: per-bot S1 = only bg 2→3 (skip bg 2→1 ที่ซื้อตอนราคาสูง)
    //   - default false (พฤติกรรมเดิม) เพื่อไม่กระทบบอทที่เปิดอยู่
    //   - true → S1 = (bg_prev=2 AND bg=3) เท่านั้น (ลง) — ปลอดภัยกว่า เพราะซื้อตอนราคาลง
    //   - bg 2→1 = ราคากลับเข้า Strong Up = ซื้อที่จุดสูง = อันตราย
    s1OnlyDown: { type: Boolean, default: false },
    // FIX-2026-07-25: per-bot XS1 anti-dump gate toggle (default true — match current behavior)
    //   - true  → skip S1 เมื่อ candle-wide dump pattern (XS1 = true)
    //   - false → ใช้สัญญาณดั้งเดิม (ไม่ skip แม้ candle-wide dump) — สำหรับบอทที่อยาก S1 ตามปกติ
    //   - ใช้ pattern A/B เดิม: (close<lowerKC && open>basisKC) หรือ (open[1]>basisKC[1] && close[1]<basisKC[1] && close<lowerKC && open<basisKC)
    xs1Enabled: { type: Boolean, default: true },
    // FIX-2026-07-30: per-bot circuit-breaker (CB) panic-sell toggle (default true) — เดิมชื่อ sls1Enabled
    //   - true (default): panic-close ALL positions เมื่อ 3 แท่งติด close<lowerKC + open<lowerKC + แดง
    //   - false: ไม่ panic-close (เสี่ยงขาดทุนต่อถ้ากราฟไหล)
    cbEnabled: { type: Boolean, default: true },
    // FIX-2026-08-01: timestamp เมื่อ CB panic-sell ทำงานล่าสุด — เดิมชื่อ sls1LastFiredAt
    //   - persist โดย _checkCBPanicClose หลัง force-close loop สำเร็จ
    //   - restore ใน start() เพื่อ continue suppression ข้าม bot restart
    //   - ไม่ใช่ anti-spam latch โดยตรง (cbCheckInFlight mutex ทำหน้าที่นั้น)
    //   - audit trail สำหรับ dashboard "🚨 CB fired at HH:MM:SS"
    cbLastFiredAt: { type: Date, default: null },
    // FIX-2026-08-01: per-bot safe-trade filter (default ON)
    //   - On S1 buy signal: check super-upper TF (3m/5m→4h, 15m→1d, 1h→1w) — SAFE_TRADE_SUPER_TF_MAP
    //   - PASS = lastClose > open (green) OR lastClose > ema20 (uptrend) → ผ่านเข้า BUY
    //   - FAIL-OPEN on Binance error (API outage ไม่บล็อกการเทรด)
    safeTradeEnabled: { type: Boolean, default: true },
    // FIX-2026-08-03: per-bot safe-trade filter #2 — LuxAlgo red pivot-low trendline (opt-in, default OFF)
    //   - true: ก่อนวาง BUY ตรวจ upper-TF (TREND_TF_MAP) ว่าราคาปัจจุบัน "เหนือ" trendline support ที่ลากจาก pivot low ล่าสุด
    //   - false (default): ปิด filter นี้ (พฤติกรรมเดิม — ไม่กรอง trendline)
    //   - FAIL-OPEN on Binance error / warmup / insufficient data (mirror safeTradeEnabled)
    //   - **ไม่แนะนำให้เปิดกับบอท DCA** (DCA ซื้อ dip โดยเฉพาะ — filter นี้ block dip-buy → ขัดกับ DCA intent)
    //   - Ported from Pine "Trendlines with Breaks" by LuxAlgo (CC BY-NC-SA 4.0); slope=ATR(14)/14*1.0
    safeTradeTrendlineEnabled: { type: Boolean, default: false },
    // FIX-2026-08-01: per-bot auto-pause on low Min-%KC (default ON)
    //   - ทุก 5 min: scan Min-%KC(30 bars) — ถ้า < autoPauseMinKcPct (default 2%) → set enabled=false
    //   - ถ้า ≥ threshold (และเคยถูก auto-pause) → auto-resume (vol_recovered)
    //   - ดูแลใน botManager.checkAutoPauseBots()
    autoPauseEnabled: { type: Boolean, default: true },
    autoPauseMinKcPct: { type: Number, default: 2, min: 0.1, max: 50 },
    autoPauseLastCheckedAt: { type: Date, default: null },
    autoPauseLastActionAt: { type: Date, default: null },
    autoPauseReason: { type: String, default: null }, // 'low_vol' | 'vol_recovered' | null
    // FIX-2026-07-31: auto-arm SL-on-UKC for stuck losing positions (per-bot toggle, default true)
    //   - เมื่อ position ขาดทุน > autoArmLossPct + เปิดมา > autoArmAgeHours → trader set trade.useStopLossOnUKC=true
    //   - _checkStopLossOnUpperKC จะยอม trigger เฉพาะ trade ที่มี flag นี้
    autoArmStopLossOnUKC: { type: Boolean, default: true },
    // FIX-2026-08-03: per-bot auto-arm loss threshold (%)
    //   - paired with autoArmStopLossOnUKC — set trade.useStopLossOnUKC=true when position loss > X%
    //   - default 10% (matches original hard-coded threshold); range 1..90
    autoArmLossPct: { type: Number, default: 10, min: 1, max: 90 },
    // FIX-2026-08-03: per-bot auto-arm age threshold (hours)
    //   - default 4h (matches original hard-coded threshold); range 0.5..168 (1 week)
    autoArmAgeHours: { type: Number, default: 4, min: 0.5, max: 168 },
    // FIX-2026-08-03: SL-UKC trigger on profitable positions (default false — backward compat)
    //   - false (default): SL-UKC only fires when buyPrice > close (loss only) — original behavior
    //   - true: SL-UKC fires whenever candle.close > upperKC (profit OR loss) — strict upper-band exit
    slUkcTriggerOnProfit: { type: Boolean, default: false },
    // FIX-2026-07-31: TP trend multiplier — เมื่อ upper-TF close > EMA20 → tpPercent *= tpTrendMultiplier
    //   - default 2 (0.2% → 0.4%)
    //   - range 1..10 (1 = no multiplier, 10 = aggressive)
    //   - apply เฉพาะ position ใหม่ (เมื่อ BUY fill) — ไม่กระทบ in-flight SELL
    tpTrendMultiplier: { type: Number, default: 2, min: 1, max: 10 },
    // FIX-2026-08-01: per-bot toggle for tpTrendMultiplier (default on)
    //   - true (default): คูณ tpPercent ด้วย tpTrendMultiplier เมื่อ upper-TF trend=upper
    //   - false: ใช้ tpPercent ตรงๆ (ไม่สนใจ trend) — เหมือนยุคก่อน F2
    tpTrendEnabled: { type: Boolean, default: true },
    // FIX-2026-07-25: per-bot TP suggestion window (bars) — default 500 (match current behavior)
    //   - ใช้กับ /api/bots/suggest-tp + tpUpdater auto-update (single source of truth)
    //   - range 30..1000 — ค่าน้อย = Min %KC จากช่วงสั้น (sensitive ต่อ squeeze ล่าสุด)
    //   - ค่ามาก = Min %KC จากช่วงยาว (conservative จับ squeeze ที่ลึก)
    //   - trend TF ยังคงใช้ 30 bars fixed (ไม่ override ได้)
    suggestTpWindow: { type: Number, default: 500, min: 30, max: 1000 },
    // FIX-2026-08-02: TP auto-floor flag — true เมื่อ bot.tpPercent ถูก override เป็น 0.281%
    //   (เนื่องจาก NET TP ต่ำกว่า 0.281% — low-volatility regime)
    //   - persist ไว้ให้ UI แสดง badge + log + warning
    //   - reset เป็น false เมื่อ NET TP กลับมา >= 0.281%
    tpOnFloor: { type: Boolean, default: false },
    // สถิติสะสม
    totalPnl: { type: Number, default: 0 },
    totalTrades: { type: Number, default: 0 },
    winTrades: { type: Number, default: 0 },
  },
  { timestamps: true }
);

botSchema.virtual('totalCapital').get(function totalCapital() {
  return this.capitalPerTrade * this.maxTrades;
});

// FIX-2026-08-02: DCA max capital — capitalPerTrade × dcaMaxLayers (used for UI display + safety check)
botSchema.virtual('dcaMaxCapital').get(function dcaMaxCapital() {
  if (!this.dcaEnabled) return 0;
  return this.capitalPerTrade * this.dcaMaxLayers;
});

botSchema.set('toJSON', { virtuals: true });
botSchema.set('toObject', { virtuals: true });

botSchema.index({ enabled: 1, symbol: 1 });
// FIX-2026-08-04: performance indexes — drives bots list sort, auto-pause/trendline/tpUpdater scans
//   - enabled + createdAt — GET /api/bots default sort (replaces COLLSCAN sort)
//   - autoPauseEnabled (partial) — botManager.checkAutoPauseBots every 10min
//   - safeTradeTrendlineEnabled (partial) — botManager.checkTrendlineStatusBots every 120s
//   - autoUpdateTp (partial) — tpUpdater.scheduleHourlyTpUpdate every hour
botSchema.index({ enabled: 1, createdAt: -1 });
botSchema.index(
  { autoPauseEnabled: 1 },
  { partialFilterExpression: { autoPauseEnabled: true } }
);
botSchema.index(
  { safeTradeTrendlineEnabled: 1 },
  { partialFilterExpression: { safeTradeTrendlineEnabled: true } }
);
botSchema.index(
  { autoUpdateTp: 1 },
  { partialFilterExpression: { autoUpdateTp: true } }
);

module.exports = mongoose.model('Bot', botSchema);
module.exports.BOT_STATUSES = BOT_STATUSES;