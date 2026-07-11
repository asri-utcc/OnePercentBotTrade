'use strict';

const mongoose = require('mongoose');

const TRADE_STATES = [
  'placed',         // BUY order วางแล้ว รอ fill
  'filled',         // BUY fill แล้ว กำลังจะวาง SELL
  'retrying',       // cancel + re-place BUY (best bid ขยับ)
  'cancelled',      // cancel แล้ว ไม่ได้ fill (signal expired หรือ user cancel)
  'holding',        // มี base asset แล้ว รอวาง/รอ fill SELL
  'selling',        // SELL order วางแล้ว รอ fill
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
    sellQty: { type: Number, default: null },
    sellQuoteQty: { type: Number, default: null },
    sellFee: { type: Number, default: 0 },
    sellFeeAsset: { type: String, default: '' },
    sellStatus: { type: String, default: '' },
    sellFilledAt: { type: Date, default: null },
    sellPlacedAt: { type: Date, default: null },
    targetSellPrice: { type: Number, default: null }, // ราคาเป้าหมาย (TP + fee buffer)

    retryCount: { type: Number, default: 0 },

    state: { type: String, enum: TRADE_STATES, default: 'placed', index: true },
    realizedPnl: { type: Number, default: null },     // กำไรขาดทุนจริง (USDT)
    pnlPercent: { type: Number, default: null },      // % เทียบ buyQuoteQty

    error: { type: String, default: '' },
  },
  { timestamps: true }
);

tradeSchema.index({ botId: 1, state: 1 });
tradeSchema.index({ symbol: 1, createdAt: -1 });

module.exports = mongoose.model('Trade', tradeSchema);
module.exports.TRADE_STATES = TRADE_STATES;