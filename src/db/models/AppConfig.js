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
        // FIX-2026-08-24: Login brute-force lock alert — แจ้ง admin เมื่อ IP/account ถูก lock
        loginLocked: true,
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
    // FIX-2026-09-04: DLC master kill-switch (default false — opt-in rollout)
    //   - when false, all bots silently fall back to legacy maxTrades gate
    //   - when true, per-bot dlcEnabled is respected (each bot still opts in individually)
    masterDlcEnabled: { type: Boolean, default: false },
    // FIX-2026-09-06: AUv2 master kill-switch (default false — opt-in rollout)
    //   - when false, all bots silently skip AUv2 scheduler regardless of per-bot flag
    //   - when true, per-bot auv2Enabled is respected (each bot still opts in individually)
    //   - Note: key is "auv2Enabled" (no "master" prefix) to match codebase pattern (cbEnabled,
    //     autoArmStopLossOnUKC, dlcEnabled, etc.) — see [[onepercentbot-master-config-autoTiming-fix]]
    auv2Enabled: { type: Boolean, default: false },

  // FIX-2026-09-17: Orphan-SELL sweeper config — auto-cancel + force-close
  //   trades where LIMIT_MAKER SELL has been alive on Binance > N hours
  //   and DB state is still 'selling'. The reconcile sweep previously
  //   silent-no-op'd this case (botManager.js:1103-1110 — design assumption
  //   was that Binance GTC would expire naturally, but GTC doesn't expire).
  //
  //   When age >= orphanSellMaxAgeHours:
  //     1. Cancel stuck SELL on Binance
  //     2. forceCloseTrade({ allowMarketSell: true, source: 'orphan-recovery-sweep' })
  //     3. Mark sellReason = 'orphan_recovery_sweeper'
  //     4. Emit eventBus 'trade:closed' → telegramNotifier fires
  //
  //   Default 24h: balances "give legitimate TP targets time to fill" vs
  //   "don't let stale SELLs accumulate". Adjustable via Master Config Modal
  //   (added in Phase B).
  //
  //   Range: 1..168 hours (1 week max). Set to a very high value to disable.
  orphanSellMaxAgeHours: { type: Number, default: 24, min: 1, max: 168 },

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-08 (rev2): DPS tunables — ย้ายจาก hardcode ใน dynamicPositionSizing.js
    //   - ปรับได้จากหน้า /settings.html section 🔟
    //   - default = ค่าเดิมทุกตัว → DB เดิมที่ยังไม่มี field เหล่านี้ ทำงานเหมือนเดิมเป๊ะ
    //   - validation/clamp อยู่ที่ admin.routes.js (PUT /api/admin/app-config)
    //   - engine อ่านผ่าน masterConfig.getDpsConfig() (cache 30s)
    // FIX-2026-09-03: layer-removal — DPS now only auto-tunes size.
    //   - 5 layer fields removed: dpsMinLayers, dpsMaxLayers, dpsWinStreakDeltaLayers,
    //     dpsBigWinDeltaLayers, dpsLossDeltaLayers (migrate-dps-layers-2026-09-03.js $unseats them)
    // ═══════════════════════════════════════════════════════════════════════
    // ── ขอบเขต (ขนาดไม้) ──
    dpsMinSize: { type: Number, default: 6 },     // USDT ต่อไม้ ขั้นต่ำ
    dpsMaxSize: { type: Number, default: 15 },    // USDT ต่อไม้ ขั้นสูง
    dpsCooldownMinutes: { type: Number, default: 5 }, // cooldown ระหว่าง resize (นาที)
    // ── Rule 1: ชนะติดกัน N ไม้ ──
    dpsWinStreakCount: { type: Number, default: 3 },
    dpsWinStreakDeltaSize: { type: Number, default: 1 },
    // ── Rule 2: N ไม้ล่าสุดกำไร > X% ทุกไม้ ──
    dpsBigWinCount: { type: Number, default: 2 },
    dpsBigWinPct: { type: Number, default: 2.0 },
    dpsBigWinDeltaSize: { type: Number, default: 2 },
    // ── Rule 3: แพ้ติดกัน N ไม้ ──
    dpsLossStreakCount: { type: Number, default: 1 },
    dpsLossDeltaSize: { type: Number, default: -2 },
    // ── safety ──
    dpsRespectBotCapital: { type: Boolean, default: true },  // anchored clamp — band ครอบ capitalPerTrade เสมอ
    dpsResetHistoryOnFire: { type: Boolean, default: true }, // กฎยิงแล้วเคลียร์ streak
    dpsDryRun: { type: Boolean, default: false },            // คำนวณ + แจ้งเตือน แต่ไม่เขียนจริง

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-09-04: Dynamic Layer Control (DLC) master tunables
    //   - default fleet-wide loss-threshold; per-bot override via Bot.dlcBaseLossPct
    //   - validation/clamp อยู่ที่ admin.routes.js (PUT /api/admin/app-config)
    //   - engine อ่านผ่าน masterConfig.getDlcConfig() (cache 30s)
    // ═══════════════════════════════════════════════════════════════════════
    dlcBaseLossPct: { type: Number, default: -10 }, // % loss threshold per layer step (negative)

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
        // FIX-2026-09-02: CBv5 default OFF (was true; mismatch with buildBotCreatePayload fallback created
        //   20-bot fleet-wide divergence where cbEnabled=false users were force-closed by CBv5).
        cbv5Enabled: false,
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
    // FIX-2026-08-24: Auto Reserve / Release USDT — periodic adjuster
    //   - enabled: master switch (default false — user must opt-in)
    //   - poleCount: target # of poles reserved (default 3) — 1 pole = usdtPerPole USDT
    //   - usdtPerPole: USDT value of 1 pole (default 10)
    //   - lossThresholdPct: positions with unrealized loss% < this count as 1 pole (default 2)
    //     e.g. pole=3, lossThrPct=2 → 3 loss positions (each < 2%) = 3 poles "reserved"
    //   - checkHours: trigger every N hours aligned to BKK HH:00 boundary (default 4 → 00/04/08/12/16/20)
    //   - stepUsdt: amount to add/remove per action (default 10)
    //   - lastRunAt/lastStats/lastError: telemetry (persist across restart)
    //   - Engine: src/services/autoReserve.js (singleton scheduler)
    // ═══════════════════════════════════════════════════════════════════════
    autoReserveEnabled:          { type: Boolean, default: false },
    autoReservePoleCount:        { type: Number,  default: 3,   min: 1,   max: 100 },
    autoReserveUsdtPerPole:      { type: Number,  default: 10,  min: 1,   max: 1000 },
    autoReserveLossThresholdPct: { type: Number,  default: 2,   min: 0.1, max: 50 },
    autoReserveCheckHours:       { type: Number,  default: 4,   min: 1,   max: 24 },
    autoReserveStepUsdt:         { type: Number,  default: 10,  min: 1,   max: 1000 },
    autoReserveLastRunAt:        { type: Date,    default: null },
    autoReserveLastStats:        { type: Object,  default: null },
    autoReserveLastError:        { type: String,  default: null },

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

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-08-29: Auto-pause threshold auto-adjust (master settings)
    //   - enabled: master switch (default false — user must opt-in)
    //   - target min/max running bot count window:
    //     running bots ที่ autoPauseEnabled !== false + deletedAt == null + enabled !== false
    //   - intervalMs: scheduler tick period (default 1h = 3600000)
    //   - kcStep / volStep: amount to adjust per action (default 0.1 / 100000)
    //     ถ้า running > max → tighten (+kcStep, +volStep)
    //     ถ้า running < min → loosen (-kcStep, -volStep)
    //     ถ้าในช่วง → no-op
    //   - clamp bounds: autoPauseMinKcPct ∈ [0.1, 50], autoPauseMin24hVolUsdt ∈ [0, 1e9]
    //   - lastRunAt / lastStats / lastError: telemetry (persist across restart)
    //   - engine: src/services/autoPauseAdjust.js (singleton scheduler)
    // ═══════════════════════════════════════════════════════════════════════
    autoPauseAdjustEnabled:    { type: Boolean, default: false },
    autoPauseAdjustMinBots:    { type: Number,  default: 15, min: 1, max: 1000 },
    autoPauseAdjustMaxBots:    { type: Number,  default: 25, min: 1, max: 1000 },
    autoPauseAdjustIntervalMs: { type: Number,  default: 60 * 60 * 1000, min: 60_000, max: 24 * 60 * 60 * 1000 },
    autoPauseAdjustKcStep:     { type: Number,  default: 0.1, min: 0.01, max: 5 },
    autoPauseAdjustVolStep:    { type: Number,  default: 100_000, min: 1_000, max: 100_000_000 },
    autoPauseAdjustLastRunAt:  { type: Date,    default: null },
    autoPauseAdjustLastStats:  { type: Object,  default: null },
    autoPauseAdjustLastError:  { type: String,  default: null },

    // �══════════════════════════════════════════════════════════════════════
    // Auto-Timing (Phase 4 — Heatmap-driven entry gate)
    //   - Master toggle; per-bot opt-in lives in Bot.autoTimingEnabled (null = inherit)
    //   - Lookback window (7..90d, default 30d) with linear-step weighting:
    //       days 1..recentDays → autoTimingRecentWeight (default 1.5)
    //       days recentDays+1..lookbackDays → autoTimingNormalWeight (default 1.0)
    //   - 2-tier evidence model: recent rolling + persistent lifetime + cool-down
    //   - Bands: 5 tiers from src/core/holdBands.js, each with 10 knobs
    //     (see src/core/autoTimingDefaults.js for the canonical defaults)
    //   - Confidence: enforce when n ≥ autoTimingMinTradesEnforce,
    //                 show-only when n ≥ autoTimingMinTradesShow, else ignore
    //   - Clamp: skip BUY when computed notional < autoTimingMinNotionalFloorUSDT,
    //            cap at autoTimingMaxNotionalCeilingUSDT
    //   - License-gated: licenseService.isFeatureEnabled('autoTiming')
    //   - engine: src/services/autoTiming.js (singleton scheduler, 30-min interval)
    // ═══════════════════════════════════════════════════════════════════════
    autoTimingEnabled:           { type: Boolean, default: false },
    autoTimingLookbackDays:      { type: Number,  default: 30, min: 7, max: 90 },
    autoTimingRecentDays:        { type: Number,  default: 7,  min: 1, max: 30 },
    autoTimingRecentWeight:      { type: Number,  default: 1.5, min: 1.0, max: 2.5 },
    autoTimingNormalWeight:      { type: Number,  default: 1.0, min: 0.5, max: 1.5 },
    autoTimingSuppressCooldownDays: { type: Number, default: 90, min: 30, max: 365 },
    autoTimingMinTradesEnforce:  { type: Number,  default: 10, min: 1, max: 100 },
    autoTimingMinTradesShow:     { type: Number,  default: 3,  min: 1, max: 50 },
    // FIX-2026-08-31: Hold-time metric selector — 'median' (default, outlier-robust)
    //   or 'p75' (more sensitive to "stuck" / �อย cells). Determines which statistic
    //   is used to bucket a cell into the 5-band table (lt10m/lt1h/lt12h/lt48h/gt48h).
    autoTimingHoldMetric:        { type: String, enum: ['median','p75'], default: 'median' },
    autoTimingBands:             { type: Object,  default: () => require('../../core/autoTimingDefaults').getDefaultBandsClone() },
    autoTimingMinNotionalFloorUSDT:   { type: Number, default: 10, min: 1 },
    autoTimingMaxNotionalCeilingUSDT: { type: Number, default: 200, min: 10 },
    autoTimingLastRunAt:         { type: Date,    default: null },
    autoTimingLastStats:         { type: Object,  default: null },
    autoTimingLastError:         { type: String,  default: null },

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-09-06: AUv2 — Auto-Underwater v2 scheduler telemetry
    //   - singleton scheduler (autoUnderwaterV2.js) writes last-run + last-stats
    //   - lastError for incident investigation (best-effort; non-fatal)
    //   - intervalMs configurable from Master Config (default 180s — mirror positionWatchdog)
    // ═══════════════════════════════════════════════════════════════════════
    auv2IntervalMs:      { type: Number, default: 180000, min: 60000, max: 900000 },
    auv2LastRunAt:       { type: Date,   default: null },
    auv2LastStats:       { type: Object, default: null },
    auv2LastError:       { type: String, default: null },

    // ═══════════════════════════════════════════════════════════════════════
    // FIX-2026-09-17: orphan-SELL sweeper telemetry — written by reconcileTelemetry.js
    //   from botManager.reconcilePendingTrades() on each tick where orphans found
    //   - stats: { scanned, cancelled, forced, errors } — Phase D /api/health/schedulers reads
    //   - Mongoose strict mode would silently drop these $set fields if not declared
    // ═══════════════════════════════════════════════════════════════════════
    orphanRecoveryLastStats: { type: Object, default: null },
    orphanRecoveryLastRunAt: { type: Date,   default: null },

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 4-2026-08-29: Chat System — Operator display name
    //   - Used as identity when posting to admin community room or DM
    //   - Empty → resolved at send time: customerTag || first 8 chars of machineId
    //   - 1..32 chars (sanitized via chatService.sanitizeDisplayName)
    //   - Set from Settings section / chat.html; persisted across restart
    // ═══════════════════════════════════════════════════════════════════════
    chatDisplayName: { type: String, default: '', maxlength: 32 },

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 4 CHAT-V2-2026-08-31: Per-operator chat identity
    //   - chatColor: hex (#RRGGBB) from admin's OPERATOR_COLORS allowlist (no red)
    //   - chatIcon:  emoji from admin's SYSTEM_ICONS allowlist
    //   - Both empty → admin resolves defaults from machineId hash at write time
    //   - Per-operator (admin may override; operator's own value wins if set)
    // ═══════════════════════════════════════════════════════════════════════
    chatColor: { type: String, default: '', maxlength: 16 },
    chatIcon:  { type: String, default: '', maxlength: 8 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AppConfig', appConfigSchema);