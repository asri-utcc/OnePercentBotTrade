'use strict';

const mongoose = require('mongoose');

const SIGNAL_TYPES = ['S1'];
const SIGNAL_OUTCOMES = ['detected', 'order_placed', 'filled', 'expired', 'failed', 'skipped'];

const signalSchema = new mongoose.Schema(
  {
    botId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bot', default: null, index: true },
    symbol: { type: String, required: true, uppercase: true },
    timeframe: { type: String, required: true },
    type: { type: String, enum: SIGNAL_TYPES, required: true },
    candleOpenTime: { type: Date, required: true },
    candleCloseTime: { type: Date, required: true },
    closePrice: { type: Number, required: true },
    basisKC: { type: Number, required: true },
    upperKC: { type: Number, required: true },
    lowerKC: { type: Number, required: true },
    bgState: { type: Number, required: true },    // 0/1/2/3 ตาม Pine Script bg_state
    bgPrev: { type: Number, required: true },
    outcome: { type: String, enum: SIGNAL_OUTCOMES, default: 'detected' },
    tradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trade', default: null },
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

signalSchema.index({ symbol: 1, timeframe: 1, candleCloseTime: -1 });

module.exports = mongoose.model('Signal', signalSchema);
module.exports.SIGNAL_TYPES = SIGNAL_TYPES;
module.exports.SIGNAL_OUTCOMES = SIGNAL_OUTCOMES;