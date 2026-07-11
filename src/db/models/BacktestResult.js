'use strict';

const mongoose = require('mongoose');

const tradeSimSchema = new mongoose.Schema(
  {
    signalTime: { type: Date, required: true },
    candleCloseTime: { type: Date, required: true },
    buyPrice: { type: Number, required: true },
    targetSellPrice: { type: Number, required: true },
    sellPrice: { type: Number, default: null },        // null = ไม่ถึง TP
    filled: { type: Boolean, default: false },
    sellFilledAt: { type: Date, default: null },
    qty: { type: Number, required: true },
    grossPnl: { type: Number, default: 0 },             // (sellPrice - buyPrice) * qty
    fees: { type: Number, default: 0 },                  // fee รวม 2 ขา (USDT)
    realizedPnl: { type: Number, default: 0 },          // grossPnl - fees
    pnlPercent: { type: Number, default: 0 },
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
    winCount: { type: Number, default: 0 },
    lossCount: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    totalPnl: { type: Number, default: 0 },
    totalPnlPercent: { type: Number, default: 0 },
    maxDrawdown: { type: Number, default: 0 },
    maxDrawdownPercent: { type: Number, default: 0 },
    trades: [tradeSimSchema],
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

backtestResultSchema.index({ symbol: 1, timeframe: 1, createdAt: -1 });

module.exports = mongoose.model('BacktestResult', backtestResultSchema);