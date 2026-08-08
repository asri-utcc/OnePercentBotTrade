'use strict';

const mongoose = require('mongoose');

const TRADE_STATES = [
  'placed',         // BUY order วางแล้ว รอ fill
  'partial_wait',   // FIX-2026-07-23: deadline handler กำลังตัดสินใจ top-up/accept (atomic claim guard)
  'filled',         // BUY fill แล้ว กำลังจะวาง SELL
  'retrying',       // cancel + re-place BUY (best bid ขยับ)
  'cancelled',      // cancel แล้ว ไม่ได้ fill (signal expired หรือ user cancel)
  'holding',        // มี base asset แล้ว รอวาง/รอ fill SELL
  'stopping',       // FIX-2026-07-23: stop-loss handler กำลังจะ force close (atomic claim guard)
  'selling',        // SELL order วางแล้ว รอ fill
  'partial_sell_wait', // FIX-2026-07-30: SELL partial-finalize atomic claim guard (mirror partial_wait)
  'sold',           // SELL fill แล้ว จบรอบ
  'failed',         // error
];

const tradeSchema = new mongoose.Schema(
  {
    botId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bot', required: true, index: true },
    signalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Signal', default: null },
    symbol: { type: String, required: true, uppercase: true },
    timeframe: { type: String, required: true },

    // BUY side
    buyOrderId: { type: Number, default: null },
    buyClientOrderId: { type: String, default: null },
    buyPrice: { type: Number, default: null },        // ราคาเฉลี่ยที่ fill (avgPrice)
    buyQty: { type: Number, default: null },
    buyQuoteQty: { type: Number, default: null },     // qty * price (USDT ใช้จริง)
    buyFee: { type: Number, default: 0 },
    buyFeeAsset: { type: String, default: '' },
    buyStatus: { type: String, default: '' },         // NEW/PARTIALLY_FILLED/FILLED/CANCELED/...
    buyFilledAt: { type: Date, default: null },
    buyPlacedAt: { type: Date, default: null },

    // SELL side
    sellOrderId: { type: Number, default: null },
    sellClientOrderId: { type: String, default: null },
    sellPrice: { type: Number, default: null },
    sellQty: { type: Number, default: null },         // total order qty
    sellFilledQty: { type: Number, default: null },   // FIX-2026-07-30: cumulative filled qty (SELL side)
    sellAvgPrice: { type: Number, default: null },    // FIX-2026-07-30: avg price of filled portion
    sellCumulativeQuoteQty: { type: Number, default: null }, // FIX-2026-07-30: cumulative quote ที่รับจริง
    sellQuoteQty: { type: Number, default: null },
    sellFee: { type: Number, default: 0 },
    sellFeeAsset: { type: String, default: '' },
    sellStatus: { type: String, default: '' },
    sellFilledAt: { type: Date, default: null },
    sellPlacedAt: { type: Date, default: null },
    targetSellPrice: { type: Number, default: null }, // ราคาเป้าหมาย (TP + fee buffer)

    // FIX-2026-08-02: DCA + BEP stack fields (only used when bot.dcaEnabled=true)
    //   - 1 Trade doc = 1 stack; buyLayers เก็บทุก BUY layer
    //   - scalar buyPrice/buyQty/buyQuoteQty mirror stackBep/stackTotalQty/stackTotalSpent เพื่อ backward compat
    //     (PnL/retry/recon code ที่อ่าน scalar fields ยังทำงานได้)
    stackId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true }, // self-ref สำหรับ DCA stack (first layer)
    isDcaStack: { type: Boolean, default: false, index: true },
    dcaLayerIndex: { type: Number, default: null, min: 1 }, // layer number ที่กำลังจะซื้อ/กำลังซื้อ
    dcaLayerCount: { type: Number, default: 0, min: 0 }, // จำนวน layer ที่ fill แล้ว
    buyLayers: [{
      layerIndex: { type: Number, required: true, min: 1 },
      orderId: { type: Number, default: null },
      clientOrderId: { type: String, default: null },
      price: { type: Number, required: true, min: 0 },
      qty: { type: Number, required: true, min: 0 },
      quoteQty: { type: Number, default: 0, min: 0 },
      fee: { type: Number, default: 0, min: 0 },
      feeAsset: { type: String, default: '' },
      status: { type: String, default: 'FILLED' },
      filledAt: { type: Date, default: null },
      placedAt: { type: Date, default: null },
    }],
    stackTotalQty: { type: Number, default: 0, min: 0 },
    stackTotalSpent: { type: Number, default: 0, min: 0 },
    stackBep: { type: Number, default: null, min: 0 },
    stackTargetSellPrice: { type: Number, default: null, min: 0 },
    stackClosedAt: { type: Date, default: null },
    // FIX-2026-08-02: transient lock flag — true ขณะกำลัง add layer (BUY in flight + SELL cancel/replace)
    //   - ใช้ atomic-claim กัน 2 S1 signals พร้อมกัน และกัน SELL cancel/replace ระหว่าง layer add
    dcaAdding: { type: Boolean, default: false },

    retryCount: { type: Number, default: 0 },

    // FIX-2026-07-31 (BUG-12): per-trade holding retry counter (replaces shared this.holdingRetryCount)
    //   แต่ละ stranded position มี budget แยก → multi-trade bots ไม่แย่ง counter กัน
    //   Reset เมื่อ trade ออกจาก holding state (sold/cancelled/failed)
    holdingRetryCount: { type: Number, default: 0 },

    // FIX-2026-07-23: partial-fill deadline decision tracking (optional, default null)
    partialDecisionAt: { type: Date, default: null },
    partialDecisionMode: { type: String, default: null }, // 'accept_partial' | 'top_up_market'
    topUpOrderId: { type: Number, default: null },
    // FIX P3.1: persist partial-fill deadline timestamp → restore ได้หลัง bot restart
    //   เดิมเก็บใน instance only → restart ระหว่าง partial fill → deadline หาย → partialFillWatcher ค้าง
    partialFillDeadlineAt: { type: Date, default: null },

    // FIX-2026-07-30: SELL partial-fill tracking — mirror BUY pattern (DEXE orphan incident)
    sellPartialDeadlineAt: { type: Date, default: null },      // persisted deadline for restart-recovery
    partialSellDecisionAt: { type: Date, default: null },      // timestamp when finalizer atomic-claim won
    partialSellDecisionMode: { type: String, default: null },  // 'market_topup' | 'fully_filled'

    // FIX-2026-07-30: reconcile orphan detection — mark trades ที่ DB=sold แต่ Binance SELL order != FILLED
    soldVerifiedAt: { type: Date, default: null },             // set เมื่อ reconcile ตรวจสอบ Binance แล้ว
    orphanDetected: { type: Boolean, default: false },          // true = DB กับ Binance ขัดกัน (audit flag)
    orphanReason: { type: String, default: null },              // reason สำหรับ orphan (e.g. 'SELL PARTIALLY_FILLED')

    // FIX-2026-07-31: auto-arm SL-on-UKC flag (per-trade)
    //   - set true เมื่อ position loss > autoArmLossPct AND age > autoArmAgeHours AND bot.autoArmStopLossOnUKC=true
    //   - _checkStopLossOnUpperKC filter: state='selling' AND useStopLossOnUKC===true
    //   - reset เป็น false เมื่อ trade ออกจาก selling state (sold/failed/cancelled)
    useStopLossOnUKC: { type: Boolean, default: false },
    autoArmedAt: { type: Date, default: null },                  // timestamp when armed (audit)
    // FIX-2026-08-03: snapshot ของ bot thresholds ตอนที่ arm (per-trade)
    //   - positionCard.js ใช้ค่านี้แสดง "stuck-like" highlight ที่ตรงกับ threshold ตอน arm (ไม่ใช่ค่าปัจจุบันของบอทที่อาจเปลี่ยนทีหลัง)
    //   - reset เป็น null ตอน state ออกจาก selling (เหมือน useStopLossOnUKC)
    autoArmLossPct: { type: Number, default: null },             // snapshot of bot.autoArmLossPct ตอน arm (1..90)
    autoArmAgeHours: { type: Number, default: null },            // snapshot of bot.autoArmAgeHours ตอน arm (0.5..168)

    // FIX-2026-08-01: SELL partial-fill latching alert (1h after detection still partial)
    //   - sellPartialDetectedAt = timestamp แรกที่ตรวจเจอ SELL partial-fill (ไม่ reset ทุกครั้งที่ poll)
    //   - ใช้เป็น latch: ถ้า (now - sellPartialDetectedAt) >= 1h และยัง partial-fill → emit warning + telegram
    //   - sellPartialLatchedAt = timestamp ที่เคย latch alert ไปแล้ว (กัน re-latch ทุก 30s poll)
    //   - sellPartialLatchedReason = 'no_progress' | 'remaining_unchanged' (audit)
    //   - reset เมื่อ state ออกจาก 'selling' (sold/failed/cancelled)
    sellPartialDetectedAt: { type: Date, default: null },
    sellPartialLatchedAt: { type: Date, default: null },
    sellPartialLatchedReason: { type: String, default: null },

    // FIX-2026-08-05: SELL placement in-flight flag — atomic guard กัน DUPLICATE SELL
    //   - HOMEUSDT incident (2026-08-05T00:20:04): scheduleHoldingRetry มี async gap ระหว่าง clearTimeout
    //     กับ setTimeout — 2 timers เข้าพร้อมกัน, ทั้ง 2 วาง MARKET SELL, ทั้ง 2 fill → orphan SELL กิน 882 HOME
    //   - fix: ก่อน place SELL order ใน scheduleHoldingRetry / _emergencyMarketSell ทำ atomic claim
    //     `findOneAndUpdate({_id, state:'holding'/'filled', sellInFlight:{$ne:true}}, {sellInFlight:true})`
    //   - ถ้า claim fail → path อื่นกำลัง place SELL อยู่ → abort (กัน duplicate โดยไม่พึ่ง timer dedup)
    //   - reset เป็น null เมื่อ trade ออกจาก holding (sold/failed/cancelled) หรือ SELL place fail
    sellInFlight: { type: Boolean, default: false },
    sellInFlightAt: { type: Date, default: null },

    state: { type: String, enum: TRADE_STATES, default: 'placed', index: true },
    realizedPnl: { type: Number, default: null },     // กำไรขาดทุนจริง (USDT)
    pnlPercent: { type: Number, default: null },      // % เทียบ buyQuoteQty

    error: { type: String, default: '' },

    // FIX-2026-08-01: structured sellReason tracking — ทุก SELL fill ต้องบอกได้ว่ามาจากอะไร
    //   - sellReason: enum บอกประเภทของ trigger (TP hit, force close, stop-loss, panic-sell, etc.)
    //   - sellReasonDetail: free-text สำหรับ debug (e.g. "close=0.01632 < lowerKC=0.01644")
    //   - sellReasonAt: timestamp ตอนที่ reason ถูก set
    //   - sellReasonSource: ชื่อ function ที่ set (debug only — _forceCloseTradeNow / handleSellFilled / etc.)
    //   - backfill ไม่ต้องทำ — trade เก่าจะ default null → frontend แสดง '—'
    sellReason: {
      type: String,
      enum: [
        'tp_hit',                   // normal TP fill (LIMIT_MAKER filled ที่ TP target)
        'tp_trend_boosted',         // TP hit with tpTrendMultiplier > 1
        'cb_panic',                 // FIX-2026-08-01: Circuit-breaker (3-candle lowerKC breach) panic-close — เดิมชื่อ sls1_panic
        'cbv2_panic',               // FIX-2026-08-06: CBv2 sustained 3-candle breach (4 consecutive red candles below lowerKC) panic-close + lock บอท cbv2LockHours ชั่วโมง
        'stop_loss_upper_kc',       // Stop loss on upper-KC
        'market_fallback',          // MARKET fallback (LIMIT reject / MIN_NOTIONAL breach / validation fail)
        'manual_api_market',        // Manual close via API (MARKET branch)
        'manual_api_synthetic',     // Manual close via API (synthetic — asset missing)
        'race_recovery_filled',     // Race recovery — SELL already filled at TP before SL cancelled
        'holding_retry_recovered',  // scheduleHoldingRetry recovered via MARKET
        'holding_retry_exhausted',  // Holding retry 10x exhausted
        'partial_sell_finalized',   // partial-sell freeze deadline finalization
        'bot_disabled',             // bot disabled, forced close
        'dca_target_hit',           // FIX-2026-08-02: DCA stack aggregate SELL filled at BEP+TP
        'dca_stack_force_close',    // FIX-2026-08-02: DCA stack force-close (user/API/bot disabled)
        'dca_stack_stop_loss',      // FIX-2026-08-02: DCA stack SL-UKC force-close (stack BEP > close + loss threshold)
        'unknown',                  // fallback (ไม่ควรเกิด — derive จาก prior state ไม่ได้)
      ],
      default: null,
      index: true,
    },
    sellReasonDetail: { type: String, default: null },
    sellReasonAt: { type: Date, default: null, index: true },
    sellReasonSource: { type: String, default: null },
  },
  { timestamps: true }
);

tradeSchema.index({ botId: 1, state: 1 });
tradeSchema.index({ symbol: 1, createdAt: -1 });
// FIX-2026-08-02: DCA stack indexes — find open stack for bot, find stack by stackId
tradeSchema.index({ botId: 1, isDcaStack: 1, state: 1 });
tradeSchema.index({ botId: 1, stackId: 1 });
// FIX-2026-08-04: performance indexes — drives PnL/series/day, telegram aggregate, positionWatchdog, bot-detail
//   - sellFilledAt_-1 + realizedPnl (partial) — pnl.calendar, pnl.series, pnl.day, telegram aggregateTrades
//   - buyFilledAt_-1 + buyStatus — telegram BUY-fill handler (per BUY fill event)
//   - botId + useStopLossOnUKC + state — positionWatchdog Phase 1+2 + trader F1 arm query
//   - botId + sellFilledAt / buyFilledAt — bot-detail mini-chart $or, pnl endpoints
//   - botId + createdAt — history/pnl list endpoints
tradeSchema.index(
  { sellFilledAt: -1, realizedPnl: 1 },
  { partialFilterExpression: { realizedPnl: { $exists: true } } }
);
tradeSchema.index({ buyFilledAt: -1, buyStatus: 1 });
tradeSchema.index({ botId: 1, useStopLossOnUKC: 1, state: 1 });
tradeSchema.index({ botId: 1, sellFilledAt: -1 });
tradeSchema.index({ botId: 1, buyFilledAt: -1 });
tradeSchema.index({ botId: 1, createdAt: -1 });

const Trade = mongoose.model('Trade', tradeSchema);
module.exports = Trade;
module.exports.TRADE_STATES = TRADE_STATES;
module.exports.SELL_REASONS = Trade.schema.path('sellReason').enumValues;