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
    disabledAt: { type: Date, default: null }, // FIX-2026-08-08: เวลาที่ disable ล่าสุด (set on disableBot) — autoDeleteBot ใช้เป็น downtime anchor แทน createdAt (กันบอทที่ enable นานแล้วโดนลบทันทีหลัง disable)
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
    // FIX-2026-08-06: CBv2 — sustained 3-candle breach lock (stricter than CB)
    //   - fires เมื่อ CB pattern (isCBAt) matches ทั้ง current AND previous candle (i.e. 4 red candles ติด below lowerKC)
    //   - on fire: force-close all positions + lock บอทเป็นเวลา cbv2LockHours hours (default 8, range 0.5..168)
    //   - lock overrides Auto-pause-resume: ถ้า cbv2LockedUntil > now → auto-resume blocked (user ต้อง manual ปลดล็อค หรือรอให้ lock หมดเวลา)
    //   - lock expiry → auto-resume path ทำงานปกติ (เฉพาะ Min-%KC >= threshold) เหมือน Auto-pause
    //   - manual unlock via POST /api/bots/:id/unlock-cbv2 (BOT_ACTION_PASSWORD required)
    // FIX-2026-09-04: align with buildBotCreatePayload strict semantics (was default: true, caused
    //   invisible divergence with cbEnabled=false — 2 bAdd bots hit CBv2)
    cbv2Enabled: { type: Boolean, default: false },
    cbv2LockHours: { type: Number, default: 8, min: 0.5, max: 168 },
    cbv2LockedUntil: { type: Date, default: null },
    cbv2LockReason: { type: String, default: null }, // 'cbv2_panic' | null
    cbv2LastFiredAt: { type: Date, default: null }, // FIX-2026-08-06: cross-restart restore (informational + audit)
    // FIX-2026-08-01: per-bot safe-trade filter (default ON)
    //   - On S1 buy signal: check super-upper TF (3m/5m→4h, 15m→1d, 1h→1w) — SAFE_TRADE_SUPER_TF_MAP
    //   - PASS = lastClose > open (green ONLY) — strict; แดง → block ทันทีไม่สน EMA20 (FIX-2026-08-19)
    //   - FAIL-OPEN on Binance error (API outage ไม่บล็อกการเทรด)
    safeTradeEnabled: { type: Boolean, default: true },
    // FIX-2026-08-03: per-bot safe-trade filter #2 — LuxAlgo red pivot-low trendline (opt-in, default OFF)
    //   - true: ก่อนวาง BUY ตรวจ upper-TF (TREND_TF_MAP) ว่าราคาปัจจุบัน "เหนือ" trendline support ที่ลากจาก pivot low ล่าสุด
    //   - false (default): ปิด filter นี้ (พฤติกรรมเดิม — ไม่กรอง trendline)
    //   - FAIL-OPEN on Binance error / warmup / insufficient data (mirror safeTradeEnabled)
    //   - **ไม่แนะนำให้เปิดกับบอท DCA** (DCA ซื้อ dip โดยเฉพาะ — filter นี้ block dip-buy → ขัดกับ DCA intent)
    //   - Ported from Pine "Trendlines with Breaks" by LuxAlgo (CC BY-NC-SA 4.0); slope=ATR(14)/14*1.0
    safeTradeTrendlineEnabled: { type: Boolean, default: false },
    // FIX-2026-08-05: Safe-trade filter #3 — Pine "No-Trade Signal Engine" (engulfing + shooting star)
    //   - true: ก่อนวาง BUY ตรวจ upper-TF (TREND_TF_MAP) ว่าแท่งล่าสุดมี "nt"/"nt1" pattern หรือไม่
    //   - false (default): ปิด filter นี้ (พฤติกรรมเดิม — ไม่กรอง no-trade pattern)
    //   - FAIL-OPEN on Binance error / insufficient data (mirror ST#1/ST#2)
    //   - **ไม่แนะนำสำหรับบอท DCA** (DCA ซื้อ dip — filter นี้ block dip-buy → ขัดกับ DCA intent)
    //   - Keltner Channel: kcLen=20 fixed, kcMult = bot.kcMult (FIX: ใช้ per-bot ให้ consistent กับ S1 detection)
    //   - Patterns: Bearish Engulfing (1-bar / 2-bar) + Shooting Star ที่อยู่ใน upper KC zone
    //   - State machine: เมื่อ trigger → ครอบคลุม 2 แท่งแดงถัดไป (matches Pine `redCountRemaining=2`)
    //   - **Real-time check**: ตรวจแท่งปัจจุบัน แม้ยังไม่ close (Binance REST คืนแท่งที่ยังสร้างไม่เสร็จ
    //     → close = last price แบบ live) — Pine run ทุก tick อยู่แล้ว จึงเป็นธรรมชาติเดียวกัน
    safeTradeNoTradeEnabled: { type: Boolean, default: false },
    // FIX-2026-08-01: per-bot auto-pause on low Min-%KC (default ON)
    //   - ทุก 5 min: scan Min-%KC(30 bars) — ถ้า < autoPauseMinKcPct (default 2%) → set enabled=false
    //   - ถ้า ≥ threshold (และเคยถูก auto-pause) → auto-resume (vol_recovered)
    //   - ดูแลใน botManager.checkAutoPauseBots()
    autoPauseEnabled: { type: Boolean, default: true },
    autoPauseMinKcPct: { type: Number, default: 2, min: 0.1, max: 50 },
    // FIX-2026-08-10: per-bot 24h quote-volume guard for Auto Pause-Resume
    //   - เพิ่มเงื่อนไขที่ 2: นอกจาก Min-%KC ต่ำแล้ว ถ้า 24h Vol (USDT) < threshold ก็ pause
    //   - resume gate ต้องผ่านทั้ง 2 เงื่อนไข (%KC healthy AND 24h vol healthy)
    //   - default 1,000,000 USDT กรองเหรียญเล็ก-illiquid ออก; clamp [0, 1e9]
    autoPauseMin24hVolUsdt: { type: Number, default: 1_000_000, min: 0, max: 1_000_000_000 },
    autoPauseLastCheckedAt: { type: Date, default: null },
    autoPauseLastActionAt: { type: Date, default: null },
    autoPauseReason: { type: String, default: null }, // 'low_vol' | 'low_24h_vol' | 'vol_recovered' | 'binance_delist' | null
    // FIX-2026-08-22: เหตุผลที่ auto-pause ถูก SKIP (เก็บไว้ audit + UI) — ตอนนี้มีแค่ 'buy_in_flight'
    //   เกิดขึ้นเมื่อ bot เข้าเงื่อนไข pause (low_vol / low_24h_vol) แต่มี BUY order ค้างอยู่
    //   → checkAutoPauseBots() skip pause เพื่อกัน orphan position (trader.stop() ฆ่า SELL-placement handler)
    //   cleared เมื่อ pause/resume สำเร็จ
    autoPauseSkipReason: { type: String, default: null, index: true }, // 'buy_in_flight' | null
    // FIX-2026-08-29: Auto-pause threshold auto-adjust (opt-in per bot, default ON)
    //   - เมื่อ master autoPauseAdjustEnabled=true → scheduler นับจำนวน running bots
    //     ที่ autoPauseEnabled !== false; ถ้า > max → เพิ่ม autoPauseMinKcPct/vol threshold
    //     (บอทที่ %KC ต่ำ/24hVol ต่ำจะถูก pause เพิ่ม); ถ้า < min → ลด threshold (resume ได้มากขึ้น)
    //   - false: บอทนี้ไม่ถูกปรับ threshold (per-bot opt-out)
    //   - ใช้ร่วมกับ autoPauseEnabled: ถ้า autoPauseEnabled=false บอทไม่มี threshold ให้ปรับ
    autoPauseAdjustEnabled: { type: Boolean, default: true },
    // FIX-2026-08-29: telemetry — last action timestamp + last stats (UI roll-up)
    autoPauseAdjustLastCheckedAt: { type: Date, default: null },
    autoPauseAdjustLastActionAt: { type: Date, default: null },
    autoPauseAdjustLastStats: { type: Object, default: null }, // { runningBots, action: 'tighten'|'loosen'|null, deltaKc, deltaVol, prevKc, prevVol, newKc, newVol }

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-30 / Phase 4 — Auto-Timing (Heatmap-driven entry gate)
    //   - Master toggle lives in AppConfig.autoTimingEnabled (premium feature).
    //   - Per-bot opt-in: null = inherit master, true/false = explicit override.
    //   - overrideCell: optional manual override map of "day:hour" → action
    //     e.g. { "1:3": "suppress", "6:14": "stimulate" } — wins over classifier output.
    //   - lastEvaluatedAt: telemetry for UI; null = never evaluated.
    //   - Only entry-time decisions are gated (DCA layers 2/3 always pass through).
    // ═══════════════════════════════════════════════════════════════════════
    autoTimingEnabled:        { type: Boolean, default: null },        // null = inherit, true/false = explicit
    autoTimingOverrideCell:   { type: Object,  default: null },        // { '0:4': 'suppress', ... } or null
    autoTimingLastEvaluatedAt: { type: Date,    default: null },
    autoTimingLastDecision:    { type: Object,  default: null },       // { day, hour, bandId, action, blocked, reason }
    // FIX-2026-07-31: auto-arm SL-on-UKC for stuck losing positions (per-bot toggle, default true)
    //   - เมื่อ position ขาดทุน > autoArmLossPct + เปิดมา > autoArmAgeHours → trader set trade.useStopLossOnUKC=true
    //   - _checkStopLossOnUpperKC จะยอม trigger เฉพาะ trade ที่มี flag นี้
    autoArmStopLossOnUKC: { type: Boolean, default: true },
    // FIX-2026-08-03 / EXT-2026-08-20: per-bot auto-arm loss threshold (%)
    //   - paired with autoArmStopLossOnUKC — set trade.useStopLossOnUKC=true when position loss > X%
    //   - default 10% (matches original hard-coded threshold); range 1..99
    autoArmLossPct: { type: Number, default: 10, min: 1, max: 99 },
    // FIX-2026-08-03 / EXT-2026-08-20: per-bot auto-arm age threshold (hours)
    //   - default 4h (matches original hard-coded threshold); range 0.5..999
    autoArmAgeHours: { type: Number, default: 4, min: 0.5, max: 999 },
    // FIX-2026-08-03: SL-UKC trigger on profitable positions (default false — backward compat)
    //   - false (default): SL-UKC only fires when buyPrice > close (loss only) — original behavior
    //   - true: SL-UKC fires whenever candle.close > upperKC (profit OR loss) — strict upper-band exit
    slUkcTriggerOnProfit: { type: Boolean, default: false },
    // FIX-2026-09-06: AUv2 — Auto-Underwater v2 (F1 auto-arm v2)
    //   - same age+loss gate as F1 auto-arm แต่ trigger ด้วย "loss ตื้นพอ" แทน SL-UKC
    //   - ต่างจาก F1: F1 arm SL-UKC flag แล้วรอ close > upperKC; AUv2 MARKET SELL ทันที
    //   - default OFF — opt-in ชัดเจน (mirror cbv5Enabled pattern)
    auv2Enabled: { type: Boolean, default: false },
    // FIX-2026-09-06: AUv2 age threshold (hours) — position ต้องถืออย่างน้อยเท่านี้ก่อนตรวจ loss
    //   - default 24h — กัน trigger ทันทีหลังซื้อ
    auv2MinAgeHours: { type: Number, default: 24, min: 0.5, max: 999 },
    // FIX-2026-09-06: AUv2 loss metric mode
    //   - 'pct' (default): trigger เมื่อ loss% shallower than auv2MaxLossPct
    //   - 'thb': trigger เมื่อ lossTHB shallower than auv2MaxLossThb (ใช้ fxService.convertUsdtToThb)
    auv2LossMode: { type: String, enum: ['pct', 'thb'], default: 'pct' },
    // FIX-2026-09-06: AUv2 max loss% threshold (only when mode='pct')
    //   - signed semantics: trigger เมื่อ lossPct > -auv2MaxLossPct (e.g., -4.9% triggers, -10% waits)
    //   - default 5% (range 0.1..50)
    auv2MaxLossPct: { type: Number, default: 5, min: 0.1, max: 50 },
    // FIX-2026-09-06: AUv2 max loss THB threshold (only when mode='thb')
    //   - signed semantics: trigger เมื่อ lossTHB > -auv2MaxLossThb
    //   - default 200 THB (range 1..100000)
    auv2MaxLossThb: { type: Number, default: 200, min: 1, max: 100000 },
    // FIX-2026-09-06: AUv2 hard cap (days) — force sell เมื่อ position ถือเกิน cap ไม่ว่า loss เท่าไหร่
    //   - 0 = no cap (default 7 — ป้องกัน "ถือข้ามเดือน")
    auv2MaxWaitDays: { type: Number, default: 0, min: 0, max: 90 },
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

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-08: Feature #1 — Dynamic Position Sizing (auto-tune size)
    //   - enabled: master toggle (default true — matches user's request)
    //   - mutually exclusive กับ DCA / Martingale (validator ใน routes)
    //   - logic (ทุกครั้งที่ SELL fill 1 closed position):
    //       * last 3 closed positions all win → size +1 USDT
    //       * last 2 closed positions >2% profit each → size +2 USDT
    //       * last closed position loss → size -2 (≥6)
    //   - bounds: size 6..15 USDT
    //   - dynamicSizeCurrent = effective value (snapshot, NOT source of truth)
    //     — source of truth = evaluate() ใน trader.handleSellFilled hook
    //   - dynamicSizeCooldownUntil: กัน rapid resize (default 5 min) — ป้องกัน whipsaw
    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-09-03: layer-removal — DPS now only auto-tunes size.
    //   layers (maxTrades) ถูกควบคุมโดยฟังก์ชันแยก — ไม่อยู่ใน DPS contract อีกต่อไป
    dynamicSizeEnabled: { type: Boolean, default: true },
    dynamicSizeCurrent: { type: Number, default: null },        // null = use capitalPerTrade
    dynamicSizeLastEvaluatedAt: { type: Date, default: null },
    dynamicSizeCooldownUntil: { type: Date, default: null },   // 5 min cooldown after each eval
    dynamicSizeLastResults: {                                    // last 3 closed positions (most recent first)
      type: [{
        closedAt: Date,
        pnlPct: Number,
        isWin: Boolean,
      }],
      default: [],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-09-04: Dynamic Layer Control (DLC) — position-aware layer gate
    //   - Replaces maxTrades gate with smart gate: each new layer requires
    //     existing positions to be deep enough in loss
    //   - threshold[i] = dlcBaseLossPct * (k - i), k=open positions, i=0=oldest
    //     example (base=-10):
    //       k=1, i=0 → threshold=-10  (1 open position must be <-10% to add pos#2)
    //       k=2, i=0 → threshold=-20, i=1 → threshold=-10
    //       k=3, i=0 → threshold=-30, i=1 → -20, i=2 → -10
    //   - mutex: dlcEnabled requires dcaEnabled=false AND martingaleEnabled=false
    //     (enforced in bot.routes.js + UI disable in bot-edit.js)
    //   - snapshot/restore maxTrades on toggle (dlcPrevMaxTrades):
    //       DLC OFF→ON: snapshot maxTrades to dlcPrevMaxTrades, set maxTrades=1
    //       DLC ON→OFF: restore dlcPrevMaxTrades, clear snapshot
    //   - master gate: AppConfig.masterDlcEnabled (default false → opt-in rollout)
    //   - PnL for open positions computed on-the-fly from currentPrice vs buyPrice
    //     (Trade.pnlPercent is null until SELL fills — see src/core/dlc.js)
    // ═══════════════════════════════════════════════════════════════════════
    dlcEnabled:       { type: Boolean, default: false },
    dlcBaseLossPct:   { type: Number,  default: -10, min: -95, max: -1 },
    dlcPrevMaxTrades: { type: Number,  default: null },                // snapshot of user's maxTrades before DLC takeover

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-09-02: Round-down Capital (opt-in per-bot — ลด notional ให้พอดี
    //   กับยอด USDT ที่ใช้ได้ เมื่อเงินไม่พอ)
    //   - เดิม: ถ้า available USDT < capitalPerTrade + fee buffer → skip signal
    //   - ใหม่: ถ้า enabled + adjusted >= roundDownCapitalMin → place BUY
    //     ด้วย notional ที่ round ลง (2 decimals) เพื่อให้เปิด order ได้
    //   - roundDownCapitalMin: ขั้นต่ำที่ยอม (USDT) — ถ้า round แล้ว < min
    //     → ยังคง skip เหมือนเดิม (กัน order เล็กเกินไป)
    //   - default OFF + min=5.5 USDT → opt-in, ไม่กระทบบอทเดิม
    //   - ทำงานใน trader.placeBuy() balance-check block — single source of truth
    //     ครอบคลุม DCA layer 2/3 / DPS-resized / AutoTiming-notional ทุก path
    // ═══════════════════════════════════════════════════════════════════════
    roundDownCapitalEnabled: { type: Boolean, default: false },
    roundDownCapitalMin:     { type: Number,  default: 5.5, min: 1, max: 10000 },

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-08: Feature #2 — CBv3 (CBv2 + ST3 same-candle on upper-TF)
    //   - global routing: AppConfig.cbVersion = 'v2' | 'v3' (default 'v3')
    //     - 'v2' → only CBv2 handler fires (CBv3 returns early)
    //     - 'v3' → only CBv3 handler fires (CBv2 returns early)
    //   - per-bot opt-out: cbv3Enabled=false → CBv3 handler skipped for that bot
    //     (mirrors cbv2Enabled — useful when user wants CBv3 off but keep CBv2's
    //      no-ST3 safety net by switching cbVersion='v2')
    //   - cbv3LockHours (default 8, range 0.5..168): mirror CBv2
    //   - cbv3LockedUntil + cbv3LockReason persist across restart
    //   - cbv3LastFiredAt: audit + trader._cbv3FiredAt restore
    //   - FIX-2026-08-09: cbv3Enabled + cbv3LockHours fields were MISSING from
    //     schema before — Mongoose strict mode silently dropped them on save,
    //     breaking per-bot opt-out UI. Added to mirror cbv2* fields.
    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-09-04: align with buildBotCreatePayload strict semantics (was default: true, caused
    //   invisible divergence with cbEnabled=false — LISTA hit by CBv3 today)
    cbv3Enabled: { type: Boolean, default: false },
    cbv3LockHours: { type: Number, default: 8, min: 0.5, max: 168 },
    cbv3LockedUntil: { type: Date, default: null },
    cbv3LockReason: { type: String, default: null }, // 'cbv3_panic' | null
    cbv3LastFiredAt: { type: Date, default: null },

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-10: Feature #6 — CBv5 (Support Zone Circuit Breaker)
    //   - independent of cbVersion enum (CBv5 works alongside CBv2 OR CBv3)
    //   - trigger conditions (4-fold confirmation per Pine Script):
    //       (1) close < lowerKC      — Keltner Channel breakout down
    //       (2) close < deepestLow   — broken ALL recent pivot-low support
    //       (3) close < open          — bearish candle (if strictBreak=true)
    //       (4) volume > volMA × mult — volume spike (if useVolume=true)
    //   - debounce: 5 candles (anti-spam, not confirmation) — same Pine default
    //   - on fire: force-close all positions + lock บอทเป็นเวลา cbv5LockHours hours (default 4, range 0.5..168)
    //   - cross-cooldown interaction with CBv2/CBv3 (see cbCrossCooldown.js):
    //       Direction A (CBv5 → CBv2/v3 fires): cancel CBv5, apply CBv2/v3
    //       Direction B (CBv2/v3 → CBv5 fires): take max(remaining, new CBv5)
    //   - manual unlock via POST /api/bots/:id/unlock-cbv2 (HYBRID — clears all 3 versions)
    //   - watchdog Phase 5 covers DISABLED/PAUSED bots (gated by bot.cbv5Enabled)
    // ═══════════════════════════════════════════════════════════════════════
    cbv5Enabled: { type: Boolean, default: false }, // FIX-2026-09-02: align with buildBotCreatePayload strict semantics (was default: true, caused invisible divergence with cbEnabled=false)
    cbv5LockHours: { type: Number, default: 4, min: 0.5, max: 168 },
    cbv5LockedUntil: { type: Date, default: null },
    cbv5LockReason: { type: String, default: null }, // 'cbv5_panic' | null
    cbv5LastFiredAt: { type: Date, default: null },
    // CBv5 tunable parameters (per-bot, mirror Pine Script inputs)
    cbv5KcLen: { type: Number, default: 20, min: 5, max: 100 },
    cbv5KcMult: { type: Number, default: 1.2, min: 0.5, max: 5.0 },
    cbv5PivotLookback: { type: Number, default: 3, min: 2, max: 10 },
    cbv5PivotLeftLen: { type: Number, default: 5, min: 2, max: 50 },
    cbv5PivotRightLen: { type: Number, default: 5, min: 2, max: 50 },
    cbv5StrictBreak: { type: Boolean, default: true },
    cbv5UseVolume: { type: Boolean, default: true },
    cbv5VolMaLen: { type: Number, default: 20, min: 5, max: 100 },
    cbv5VolMultiplier: { type: Number, default: 1.5, min: 1.0, max: 10.0 },
    cbv5DebounceCandles: { type: Number, default: 5, min: 1, max: 20 },

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-08: Feature #3 — Auto Unlock Cooldown (CBv2/CBv3)
    //   - enabled: per-bot toggle (default false — user must opt-in)
    //   - threshold Pct: ต้องการ signal close > threshold% เทียบกับราคา signal
    //   - count: จำนวน signals ที่ match threshold (reset เมื่อ CB fires ครั้งใหม่)
    //   - if count >= 3 → unlock ทันที (no whipsaw guard per user request)
    // ═══════════════════════════════════════════════════════════════════════
    cbAutoUnlockEnabled: { type: Boolean, default: false },
    cbAutoUnlockThresholdPct: { type: Number, default: 1.0, min: 0.5, max: 5.0 },
    cbAutoUnlockCheckedAt: { type: Date, default: null },
    cbAutoUnlockSignalsFound: { type: Number, default: 0 },

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-08: Feature #5 — Auto Delete Bot (soft delete + restore)
    //   - deletedAt: timestamp when soft-deleted (set by autoDeleteBot service)
    //   - restore window: 30 days from deletedAt → after that, hard delete
    //   - scheduledDeleteAt: when bot is scheduled for deletion (system-set)
    //   - deleteNotificationSentAt: when 3-day warning was sent (no duplicate alerts)
    //   - when deletedAt is set: bots list API excludes (unless ?includeDeleted)
    // ═══════════════════════════════════════════════════════════════════════
    deletedAt: { type: Date, default: null },
    scheduledDeleteAt: { type: Date, default: null },
    deleteNotificationSentAt: { type: Date, default: null },

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