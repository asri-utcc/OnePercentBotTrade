'use strict';

const mongoose = require('mongoose');

// Singleton: เก็บแค่ document เดียว (key = 'singleton')
const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'singleton', unique: true },
    // password hash จาก bcrypt (เก็บที่นี่เพื่อ persist ระหว่าง restart)
    passwordHash: { type: String, default: '' },
    passwordSetAt: { type: Date, default: null },

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
      }),
    },
    telegramThresholds: {
      type: Object,
      default: () => ({ positionLossPct: 2, positionProfitPct: 1, positionStuckMin: 30 }),
    },

    // FIX-2026-08-01: Bot Quality Indicator (mirror telegramThresholds pattern)
    //   - qualityEnabled: master switch — ถ้าปิด, computeBotQuality returns {enabled:false,score:null,color:'gray'}
    //   - qualityRefreshMs: shared top-N cache TTL (60s..1h clamp), default 5min
    //   - qualityThresholds: { volumeMinUSDT, topN, kcTightPct, squeezeMinPct, trendMinPct }
    qualityEnabled:  { type: Boolean, default: true },
    qualityRefreshMs: { type: Number,  default: 5 * 60 * 1000 },
    qualityThresholds: {
      type: Object,
      default: () => ({
        volumeMinUSDT: 100_000,
        topN: 50,
        kcTightPct: 1.0,
        squeezeMinPct: 40,
        trendMinPct: 50,
      }),
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
  },
  { timestamps: true }
);

module.exports = mongoose.model('AppConfig', appConfigSchema);