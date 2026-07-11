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
    retryTimeMin: { type: Number, required: true, default: 1, min: 1, max: 60 },
    retryMax: { type: Number, required: true, default: 1, min: 0, max: 10 },
    enabled: { type: Boolean, default: false },
    status: { type: String, enum: BOT_STATUSES, default: 'idle' },
    activeTrades: { type: Number, default: 0 },
    lastSignalAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
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