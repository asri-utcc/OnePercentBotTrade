'use strict';

const mongoose = require('mongoose');

const BOT_STATUSES = ['idle', 'waiting_fill', 'holding', 'selling', 'error', 'disabled'];

const botSchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    symbol: { type: String, required: true, uppercase: true, trim: true, default: 'BNBUSDT' },
    timeframe: { type: String, required: true, default: '5m' },
    capitalPerTrade: { type: Number, required: true, default: 10, min: 0.00000001 },
    maxTrades: { type: Number, required: true, default: 10, min: 1, max: 1000 },
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
    // FIX-2026-07-25: per-bot TP suggestion window (bars) — default 500 (match current behavior)
    //   - ใช้กับ /api/bots/suggest-tp + tpUpdater auto-update (single source of truth)
    //   - range 30..1000 — ค่าน้อย = Min %KC จากช่วงสั้น (sensitive ต่อ squeeze ล่าสุด)
    //   - ค่ามาก = Min %KC จากช่วงยาว (conservative จับ squeeze ที่ลึก)
    //   - trend TF ยังคงใช้ 30 bars fixed (ไม่ override ได้)
    suggestTpWindow: { type: Number, default: 500, min: 30, max: 1000 },
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

botSchema.set('toJSON', { virtuals: true });
botSchema.set('toObject', { virtuals: true });

botSchema.index({ enabled: 1, symbol: 1 });

module.exports = mongoose.model('Bot', botSchema);
module.exports.BOT_STATUSES = BOT_STATUSES;