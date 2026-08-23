'use strict';

const mongoose = require('mongoose');

// Singleton: เก็บแค่ document เดียว (key = 'singleton')
const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'singleton', unique: true },
    // password hash จาก bcrypt (เก�บที่นี่เพื่อ persist ระหว่าง restart)
    passwordHash: { type: String, default: '' },
    passwordSetAt: { type: Date, default: null },
    // 2026-08-09: Password & Sessions Manager
    //   - passwordHint: ข้อความเตือนควา�จำส่วนตัว (plain text, max 500) — ไม่ใช่ security feature
    //     แสดงเฉพาะ admin ที่ login แล้ว ใช้เตือนตัวเอง (เช่น "อันที่ใช้กับเมลทำงาน")
    //   - passwordNote: บันทึก security audit (plain text, max 1000) — เช่น
    //     "rotated 2026-08-09 หลังเจอ login จาก IP 185.x.x.x ที่ไม่รู้จัก"
    //   - passwordLastChangedAt / passwordLastChangedFromIp: audit trail (auto-fill เวลา change-password)
    passwordHint: { type: String, default: '', maxlength: 500 },
    passwordNote: { type: String, default: '', maxlength: 1000 },
    passwordLastChangedAt: { type: Date, default: null },
    passwordLastChangedFromIp: { type: String, default: '' },

    // FIX-2026-08-10: botActionPassword (plain text) — sync with login password
    //   - src/api/routes/bot.routes.js → requireBotActionPassword() reads config.botActionPassword
    //     ซึ่งถูก override ที่ startup จาก field นี้ (ถ้ามี)
    //   - ถ้า .env มี BOT_ACTION_PASSWORD แยก → field นี้ไม่ถูกตั้ง (ใช้ .env เดิม)
    //   - ถ้าไม่มี .env (fallback ไป DASHBOARD_PASSWORD) → field นี้จะถูกอัปเดต
    //     ทุกครั้งที่ user เปลี่ยน login password เพื่อให้ requireBotActionPassword ทำงานต่อเนื่อง
    //   - Audit: botActionPasswordChangedAt + botActionPasswordChangedFromIp
    botActionPassword: { type: String, default: '' },
    botActionPasswordChangedAt: { type: Date, default: null },
    botActionPasswordChangedFromIp: { type: String, default: '' },

    // Binance API keys (encrypted with AES-256-GCM)
    binanceApiKeyEnc: { type: String, default: '' },       // base64 ciphertext
    binanceApiSecretEnc: { type: String, default: '' },    // base64 ciphertext
    binanceApiKeyIv: { type: String, default: '' },
    binanceApiSecretIv: { type: String, default: '' },
    binanceApiKeyAuthTag: { type: String, default: '' },
    binanceApiSecretAuthTag: { type: String, default: '' },

    useBnbForFees: { type: Boolean, default: false },

    setupCompleted: { type: Boolean, default: false },
    setupAt: { type: Date, default: null },

    // FIX-2026-07-24: Telegram bot (encrypted token + plain chatId + per-event toggles + thresholds)
    //   - Token encrypted AES-256-GCM (mirror binanceApi*Enc pattern)
    //   - Chat ID is plain (ไม่ใช่ secret)
    //   - Events/Thresholds เป็น Mixed object — Mongoose ไม่ enforce schema ภายใน
    telegramBotTokenEnc:     { type: String, default: '' },
    telegramBotTokenIv:      { type: String, default: '' },
    telegramBotTokenAuthTag: { type: String, default: '' },
    telegramChatId:          { type: String, default: '' },
    telegramEnabled:         { type: Boolean, default: false },
    telegramEvents: {
      type: Object,
      default: () => ({
        buyFilled: true, sellFilled: true, insufficientBalance: true,
        botEnabled: true, botDisabled: true, botDeleted: true,
        positionLoss: true, positionProfit: true, positionStuck: true,
        // FIX-2026-07-26: สรุปการเทรด (ส่งที่ HH:00:00 ของวันใหม่/สัปดาห์ใหม่/เดือนใหม่)
        dailySummary: true, weeklySummary: true, monthlySummary: true,
        // FIX-2026-07-26: เตือน NET TP ต่ำกว่า 0.2% (เฉพาะบอทที่เปิด autoUpdateTp)
        tpLowPnL: true,
        // FIX-2026-08-07: แจ้งเตือนเมื่อ Auto Add New Bot สร้างบอทใหม่อัตโนมัติ
        autoAddBotCreated: true,
        // FIX-2026-08-23: แจ้งเตือนเมื่อ Auto Add New Bot restore + activate บอท soft-deleted
        autoAddBotRestored: true,
        // FIX-2026-08-09: Telegram Login — alternative login channel (ส่ง OTP 6 หลักเข้า Telegram แทน password)
        //   - ไม่ใช่ 2FA — ใช้แทน password เมื่อลืม
        //   - default ON (user ปิดเองได้ใน Settings > Telegram Events)
        telegramLogin: true,
      }),
    },
    telegramThresholds: {
      type: Object,
      default: () => ({ positionLossPct: 2, positionProfitPct: 1, positionStuckMin: 30 }),
    },

    // FIX-2026-08-05: Auto-Buy BNB (ป้องกัน BNB-empty fee-deduct incident)
    //   - enabled: master switch (default false — user must opt-in)
    //   - topUpUsdt: USDT amount to spend each buy (default 5.5) — must be >= BNB minNotional
    //   - thresholdUsdt: trigger when BNB value < this (default 0.5)
    //   - checkIntervalMin: how often to scan (default 60 min)
    //   - maxUsdtPerDay: safety cap (default 50) — block if (sum today) >= cap
    //   - cooldownMin: minimum minutes between buys (default 30) — กัน burst
    autoBuyBnbEnabled:        { type: Boolean, default: false },
    autoBuyBnbTopUpUsdt:      { type: Number,  default: 5.5 },
    autoBuyBnbThresholdUsdt:  { type: Number,  default: 0.5 },
    autoBuyBnbCheckIntervalMin: { type: Number, default: 60, min: 5 },
    autoBuyBnbMaxUsdtPerDay:  { type: Number,  default: 50 },
    autoBuyBnbCooldownMin:    { type: Number,  default: 30, min: 0 },
    // FIX-2026-08-05: BNB oil gauge (UI progress bar on /bots.html)
    //   - targetUsdt: 100% เมื่อ bnbValue == target (default 10 USDT)
    //   - user ตั้งได้ผ่าน Settings section 5️⃣ → บันทึกลง AppConfig
    //   - ไม่กระทบ alert/banner/auto-buy (เป็นคนละ value — gauge ใช้ดูเฉยๆ)
    bnbGaugeTargetUsdt:       { type: Number,  default: 10, min: 1, max: 100 },

    // 2026-08-06: Daily Profit Target gauge (radial gauge below navbar)
    //   - targetThb: เป้าหมายกำไรรายวัน (THB) — 100% เมื่อ todayPnlThb == targetThb
    //   - user ตั้งได้ผ่าน Settings section 6️⃣ → บันทึกลง AppConfig
    //   - default 100 THB/วัน (ตาม UX request)
    //   - gauge ไม่กระทบ trade logic — เป็น visualization อย่างเดียว
    dailyTargetThb:           { type: Number,  default: 100, min: 1, max: 1000000 },

    // FIX-2026-08-07: Auto Add New Bot — periodic scan + create new bots for new symbols
    //   - enabled: master switch (default false — user must opt-in)
    //   - intervalMin: how often to scan (default 60 min)
    //   - minKcPct: filter candidate by Min %KC(window) > threshold (default 2)
    //   - maxPerRun: cap bots created per cycle (default 5 — ปลอดภัย)
    //   - scan params: separate from scan-volatility page (default = same as page defaults 2026-08-07)
    //   - telegramNotify: emit autoAddBotCreated event when bot is created (default true)
    //   - lastRunAt/lastStats/lastError: bookkeeping (persist across restart)
    autoAddBotEnabled:        { type: Boolean, default: false },
    autoAddBotIntervalMin:    { type: Number,  default: 60, min: 5 },
    autoAddBotMinKcPct:       { type: Number,  default: 2, min: 0, max: 50 },
    autoAddBotMaxPerRun:      { type: Number,  default: 5, min: 1, max: 50 },
    autoAddBotScanTimeframe:  { type: String,  default: '3m' },
    autoAddBotScanThreshold:  { type: Number,  default: 0.5, min: 0.1, max: 100 },
    autoAddBotScanWindow:     { type: Number,  default: 500, min: 5, max: 20000 },
    autoAddBotScanTpWindow:   { type: Number,  default: 30, min: 20, max: 1000 },
    autoAddBotScanTopN:       { type: Number,  default: 100, min: 20, max: 300 },
    autoAddBotScanMinVol:     { type: Number,  default: 1_000_000, min: 0 },
    autoAddBotScanMinPct:     { type: Number,  default: 0.30, min: 0, max: 1 },
    autoAddBotScanTrends:     { type: [String], default: ['uptrend', 'downtrend', 'sideways'] },
    autoAddBotTelegramNotify: { type: Boolean, default: true },
    autoAddBotAutoEnable:     { type: Boolean, default: true },  // FIX-2026-08-07: auto-enable บอทที่เพิ่งสร้าง + spawnTrader ทันที (default ON)
    autoAddBotAutoRestore:    { type: Boolean, default: true },  // FIX-2026-08-23: restore + activate บอท soft-deleted ที่ symbol ตรงเกณฑ์ (default ON)
    // 2026-08-08: name prefix สำหรับบอทที่ auto-add สร้า� (default "(bAdd)" — เดิม hardcode)
    //   - ใช้ใน autoAddBot._createBotFor(): name = `${base}${namePrefix}`
    //   - ปลอดภัย: trim + fallback เป็น "(bAdd)" ถ้าว่าง
    autoAddBotNamePrefix:     { type: String,  default: '(bAdd)', maxlength: 32 },
    autoAddBotLastRunAt:      { type: Date,    default: null },
    autoAddBotLastStats:      { type: Object,  default: null },
    autoAddBotLastError:      { type: String,  default: null },

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-08: Feature #2 — CB Version (global setting)
    //   - 'v2' = CBv2 only (4 red candles below lowerKC → cooldown)
    //   - 'v3' = CBv2 + ST3 same-candle on upper-TF (default — recommended)
    //   - ใช้ AppConfig.cbVersion เป็น single source of truth
    //   - bot-edit form แสดง readonly badge บอกว่าใช้ version ไหน
    // ═══════════════════════════════════════════════════════════════════════
    cbVersion: { type: String, enum: ['v2', 'v3'], default: 'v3' },

    // FIX-2026-08-12 (audit Q9): Master CBv5 toggle
    //   - CBv5 was originally "independent of cbVersion" — but user contract violation
    //     because no master switch existed (per-bot cbv5Enabled only).
    //   - cbv5MasterEnabled (default true) — when false, all 4 CBv5 sites skip
    //   - per-bot cbv5Enabled still respected (user can opt-out individual bots)
    //   - Gate at: trader._checkCBv5PanicClose, trader pre-BUY, watchdog Phase 5, _cbv5SkipReason
    cbv5MasterEnabled: { type: Boolean, default: true },

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-08: Master toggles for DPS / CB Auto-Unlock
    //   - masterDynamicSizeEnabled (default true) — when false, all bots skip DPS evaluation
    //     (per-bot dynamicSizeEnabled still respected as "I want DPS off for this bot")
    //   - masterCbAutoUnlockEnabled (default false) — when true, auto-enables cbAutoUnlock
    //     across all bots (per-bot cbAutoUnlockEnabled still respected)
    // ═══════════════════════════════════════════════════════════════════════
    masterDynamicSizeEnabled: { type: Boolean, default: true },
    masterCbAutoUnlockEnabled: { type: Boolean, default: false },

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-08 (rev2): DPS tunables — ย้ายจาก hardcode ใน dynamicPositionSizing.js
    //   - ปรับได้จากหน้า /settings.html section 🔟
    //   - default = ค่าเดิมทุกตัว → DB เดิมที่ยังไม่มี field เหล่านี้ ทำงานเหมือนเดิมเป๊ะ
    //   - validation/clamp อยู่ที่ admin.routes.js (PUT /api/admin/app-config)
    //   - engine อ่านผ่าน masterConfig.getDpsConfig() (cache 30s)
    // ═══════════════════════════════════════════════════════════════════════
    // ── ขอบเขต (ขนาดไม้ + จำนวนไม้) ──
    dpsMinSize: { type: Number, default: 6 },     // USDT ต่อไม้ ขั้นต่ำ
    dpsMaxSize: { type: Number, default: 15 },    // USDT ต่อไม้ ขั้นสูง
    dpsMinLayers: { type: Number, default: 1 },   // จำนวนไม้ ขั้นต่ำ
    dpsMaxLayers: { type: Number, default: 5 },   // จำนวนไม้ ขั้นสูง
    dpsCooldownMinutes: { type: Number, default: 5 }, // cooldown ระหว่าง resize (นาที)
    // ── Rule 1: ชนะติดกัน N ไม้ ──
    dpsWinStreakCount: { type: Number, default: 3 },
    dpsWinStreakDeltaSize: { type: Number, default: 1 },
    dpsWinStreakDeltaLayers: { type: Number, default: 1 },
    // ── Rule 2: N ไม้ล่าสุดกำไร > X% ทุกไม้ ──
    dpsBigWinCount: { type: Number, default: 2 },
    dpsBigWinPct: { type: Number, default: 2.0 },
    dpsBigWinDeltaSize: { type: Number, default: 2 },
    dpsBigWinDeltaLayers: { type: Number, default: 0 },
    // ── Rule 3: แพ้ติดกัน N ไม้ ──
    dpsLossStreakCount: { type: Number, default: 1 },
    dpsLossDeltaSize: { type: Number, default: -2 },
    dpsLossDeltaLayers: { type: Number, default: -2 },
    // ── safety ──
    dpsRespectBotCapital: { type: Boolean, default: true },  // anchored clamp — band ครอบ capitalPerTrade เสมอ
    dpsResetHistoryOnFire: { type: Boolean, default: true }, // กฎยิงแล้วเคลียร์ streak
    dpsDryRun: { type: Boolean, default: false },            // คำนวณ + แจ้งเตือน แต่ไม่เขียนจริง

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-08: Feature #5 — Auto Delete Bot (global setting)
    //   - enabled: master switch (default false — user must opt-in)
    //   - days: downtime threshold (default 30, range 7..365)
    //   - warningDays: แจ้งเตือนล่วงหน้ากี่วัน (default 3)
    //   - lastRunAt: telemetry (persist across restart)
    // ═══════════════════════════════════════════════════════════════════════
    autoDeleteBotEnabled: { type: Boolean, default: false },
    autoDeleteBotDays: { type: Number, default: 30, min: 7, max: 365 },
    autoDeleteBotWarningDays: { type: Number, default: 3, min: 1, max: 30 },
    autoDeleteBotLastRunAt: { type: Date, default: null },
    autoDeleteBotLastStats: { type: Object, default: null },

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-08 (rev3): Bot Defaults — ค่าเริ่มต้นในการสร้างบอทใหม่
    //   - ใช้เป็น default ตอน POST /api/bots (ถ้า client ไม่ส่ง field มา)
    //   - ตั้ง/แก้ไขได้จากหน้า /settings.html (section 1️⃣)
    //   - รวม field ทั้งหมดที่ New Bot modal ตั้งค่าได้
    //   - หมายเหตุ: ค่า default ของแต่ละ field ตรงกับค่าที่ UI/bots.js ใช้อยู่ (ตามที่ user ขอ)
    // ═══════════════════════════════════════════════════════════════════════
    botDefaults: {
      type: Object,
      default: () => ({
        // ทุน & ความเสี่ยง
        capitalPerTrade: 9,
        maxTrades: 1,
        tpPercent: 0.1,
        retryTimeMin: 0.2,
        retryMax: 8,
        kcMult: 1.2,
        minSpreadTicks: 1,
        suggestTpWindow: 30,
        // DCA
        dcaEnabled: false,
        dcaMaxLayers: 3,
        martingaleEnabled: false,
        martingaleMultiplier: 1.5,
        martingaleMaxLayerNotional: 100,
        // Filters & toggles (default ตาม New Bot modal)
        s1OnlyDown: false,            // New Bot modal checked by default
        xs1Enabled: true,
        cbEnabled: true,              // UI default = OFF; route default = ON. Use UI default for bot modal consistency
        cbv2Enabled: true,
        cbv2LockHours: 8,
        cbv3Enabled: true,
        cbv3LockHours: 8,
        // FIX-2026-08-10: CBv5 (Support Zone Circuit Breaker) defaults — independent of cbVersion
        cbv5Enabled: true,
        cbv5LockHours: 4,
        cbv5KcLen: 20,
        cbv5KcMult: 1.2,
        cbv5PivotLookback: 3,
        cbv5PivotLeftLen: 5,
        cbv5PivotRightLen: 5,
        cbv5StrictBreak: true,
        cbv5UseVolume: true,
        cbv5VolMaLen: 20,
        cbv5VolMultiplier: 1.5,
        cbv5DebounceCandles: 5,
        cbAutoUnlockEnabled: false,
        cbAutoUnlockThresholdPct: 1.0,
        dynamicSizeEnabled: true,
        safeTradeEnabled: true,
        safeTradeTrendlineEnabled: false,  // UI checked by default in modal; we use route default (off) for safer default
        safeTradeNoTradeEnabled: false,    // UI checked by default in modal; we use route default (off) for safer default
        autoPauseEnabled: true,
        autoPauseMinKcPct: 2,
        autoPauseMin24hVolUsdt: 1_000_000,
        autoArmStopLossOnUKC: true,
        autoArmLossPct: 6.3,           // New Bot modal default
        autoArmAgeHours: 4,
        slUkcTriggerOnProfit: false,
        tpTrendEnabled: true,
        tpTrendMultiplier: 2,
        autoUpdateTp: true,
        stopLossOnUpperKC: false,
        // Default symbol + timeframe (first dropdown options)
        defaultSymbol: 'BNBUSDT',
        defaultTimeframe: '3m',
      }),
    },

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-13: Master Config Templates — user-saved setting presets
    //   - Mixed array on AppConfig singleton (cap = 50 entries)
    //   - Each entry: { id (uuid), name, settings (raw k→v, validated by bulk-update),
    //                    createdAt, updatedAt }
    //   - Name uniqueness: case-insensitive UPPER comparison on trimmed value (route-handler)
    //   - Backward compat: legacy docs without this field → route uses `|| []`
    //   - Per-entry shape validation lives in routes/admin.routes.js (helpful 400 errors)
    // ═══════════════════════════════════════════════════════════════════════
    masterConfigTemplates: {
      type: [Object],
      default: [],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length <= 50,
        message: 'masterConfigTemplates: cap = 50 entries',
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // 2026-08-19: Wallet Reserve — USDT amount locked away from bot spending
    //   - Persisted on AppConfig singleton (survives restart)
    //   - Read by trader.js balance pre-check (subtracts from availableUsdt)
    //   - UI: /wallet.html slider + quick-set chips (requireBotActionPassword to save)
    //   - In-process cache: src/services/walletReserve.js (10s TTL)
    //   - Clamp 0..1,000,000 USDT (sanity ceiling — typical user reserve is 0..1k)
    // ═══════════════════════════════════════════════════════════════════════
    walletReserveUsdt: { type: Number, default: 0, min: 0, max: 1_000_000 },

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-21: Binance API rate-limit capacity (token-bucket)
    //   - capacity (REQUEST_WEIGHT per minute) for the IP-bucket in binanceRest.js
    //   - default 6000 (= Binance standard IP-based limit)
    //   - user can lower it via Settings → 🛒 การซื้อขาย → 🌐 Binance API — Rate Limit
    //     เช่น 1 server รันหลาย instance / หลายระบบ → หาร capacity กัน
    //     clamp 500..120000 (Binance Bot Account allows up to 120,000/min)
    //   - engine: binanceRest.RateLimiter.setCapacity() (in-place, no restart)
    //   - cache: src/services/binanceRateLimitConfig.js (30s TTL, mirror cbVersion.js)
    //   - validation/clamp: PUT /api/admin/rate-limit (admin.routes.js)
    // ═══════════════════════════════════════════════════════════════════════
    binanceRateLimitPerMin: { type: Number, default: 6000, min: 500, max: 120000 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AppConfig', appConfigSchema);