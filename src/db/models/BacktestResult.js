'use strict';

const mongoose = require('mongoose');

const tradeSimSchema = new mongoose.Schema(
  {
    signalTime: { type: Date, required: true },
    candleCloseTime: { type: Date, required: true },
    buyPrice: { type: Number, required: true },
    targetSellPrice: { type: Number, required: true },
    sellPrice: { type: Number, default: null },        // null = ไม่ถึง TP
    buyFilled: { type: Boolean, default: false },      // BUY order ได้ fill ใน window หรือไม่
    sellFilled: { type: Boolean, default: false },     // SELL TP ได้ fill หรือไม่
    buyFilledAt: { type: Date, default: null },        // timestamp ที่ BUY fill (mid-candle)
    sellFilledAt: { type: Date, default: null },
    qty: { type: Number, required: true },
    notional: { type: Number, default: 0 },            // qty × buyPrice
    grossPnl: { type: Number, default: 0 },             // (sellPrice - buyPrice) * qty
    fees: { type: Number, default: 0 },                  // fee รวม 2 ขา (USDT)
    realizedPnl: { type: Number, default: 0 },          // grossPnl - fees
    unrealizedPnl: { type: Number, default: 0 },        // ถ้ายังถืออยู่ คิดจากราคาปิดสุดท้าย
    pnlPercent: { type: Number, default: 0 },
    exitReason: { type: String, default: '' },         // tp_hit / still_holding / no_buy_fill / max_concurrent_skip / below_min_notional
    bgState: { type: Number, required: true },
  },
  { _id: false }
);

const backtestResultSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, uppercase: true },
    timeframe: { type: String, required: true },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    // executionModel: รหัสโมเดล backtest (เปลี่ยนเมื่อ fill logic / timestamp logic เปลี่ยน)
    //   v3_simple_fill     — เงื่อนไขเดิม (low ≤ P อย่างเดียว)
    //   v4_maker_fill      — เงื่อนไขใหม่ (low ≤ P AND close ≥ P AND volume > 0)
    //                        + BUY timestamp = กลางแท่ง
    executionModel: { type: String, default: 'unknown', index: true },
    params: {
      tpPercent: { type: Number, required: true },
      capitalPerTrade: { type: Number, required: true },
      feeRate: { type: Number, required: true },
      retryModel: { type: String, default: 'simple' },
    },
    signalsCount: { type: Number, default: 0 },
    tradesSimulated: { type: Number, default: 0 },

    // ─── สถิติรายไม้ (ทั้งหมดจาก summarize()) ────────
    buyFilledCount: { type: Number, default: 0 },
    sellFilledCount: { type: Number, default: 0 },
    noBuyFillCount: { type: Number, default: 0 },
    stillHoldingCount: { type: Number, default: 0 },
    maxConcurrentSkipCount: { type: Number, default: 0 },
    belowMinNotionalCount: { type: Number, default: 0 },
    tpHitCount: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    breakeven: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    signalSuccessRate: { type: Number, default: 0 },
    fillRate: { type: Number, default: 0 },
    exitRate: { type: Number, default: 0 },

    // ─── สถิติการเงิน ──────────────────────────────
    totalPnl: { type: Number, default: 0 },
    totalPnlPercent: { type: Number, default: 0 },
    totalFees: { type: Number, default: 0 },
    totalNotional: { type: Number, default: 0 },
    totalUnrealizedPnl: { type: Number, default: 0 },
    avgPnlPerSignal: { type: Number, default: 0 },
    maxDrawdown: { type: Number, default: 0 },
    maxDrawdownPercent: { type: Number, default: 0 },
    maxConsecutiveLosses: { type: Number, default: 0 },
    profitFactor: { type: Number, default: 0 },

    trades: [tradeSimSchema],
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

backtestResultSchema.index({ symbol: 1, timeframe: 1, createdAt: -1 });

module.exports = mongoose.model('BacktestResult', backtestResultSchema);