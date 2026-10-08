'use strict';

/**
 * 2026-10-08: CapitalFlow — Binance deposit/withdraw history tracker
 *
 * ที่มา:
 *   - ผู้ใช้เติมเงินเข้า Binance บ่อย หลายเหรียญ (USDT, XRP, DOGE, XLM, ETH ฯลฯ)
 *   - ต้องการทราบ "งบประมาณสะสมที่เติมเข้ามา" (Net Deposited) เพื่อให้บอท
 *     ตัดสินใจได้อย่างมีสติ ไม่เผื่อเงินที่ไม่มี และไม่อดเงินเมื่อมีโอกาสดีๆ
 *
 * ข้อมูล:
 *   - ดึงจาก Binance SAPI:
 *       GET /sapi/v1/capital/deposit/hisrec   (require "Enable Withdrawals" permission)
 *       GET /sapi/v1/capital/withdraw/history (require "Enable Withdrawals" permission)
 *   - upsert โดย `key` (composite `{type}:{txId}`) — idempotent
 *   - แปลงเป็น USDT @ time of transaction (ใช้ kline 1m/daily) — see capitalFlowService
 *
 * Schema:
 *   - key:        "deposit:<txId>" | "withdraw:<txId>"  (unique, idempotent upsert)
 *   - type:       'deposit' | 'withdraw'
 *   - asset:      'USDT', 'XRP', 'BTC' ... (uppercase)
 *   - amount:     raw amount from Binance (gross — what user clicked)
 *   - transactionFee: 0 for deposit, withdrawal fee (Binance deduces from gross)
 *   - usdtValue:  amount × priceUsdt @ insertTime
 *                signed: + for deposit (money in), - for withdraw (money out)
 *   - priceUsdt:  price at insertTime (1m kline close, daily fallback, or 1.0 stablecoin)
 *   - priceSource:'kline' | 'current' | 'fallback' | 'stablecoin'
 *   - insertTime: Date (Binance insertTime/applyTime ms epoch)
 *   - txId:       on-chain transaction hash (or Binance internal id fallback)
 *   - binanceId:  Binance internal id (for debugging)
 *   - network:    'BSC', 'ETH', 'BTC' ... (Binance-asset network)
 *   - status:     '1'=success (deposit), '6'=completed (withdraw), or other raw Binance status
 *   - walletType: '0'=Spot, '1'=Funding, '2'=etc (per Binance docs)
 *   - transferType: '0'=external, '1'=internal (per Binance docs)
 *   - syncedAt:   Date (last successful upsert time)
 *
 * Idempotency:
 *   - upsert by `key` — re-syncing same row is no-op
 *
 * Indexes:
 *   - key unique (upsert key)
 *   - { type: 1, insertTime: -1 } (range query by type)
 *   - { asset: 1 } (filter by coin)
 *   - { insertTime: -1 } (sort)
 */

const mongoose = require('mongoose');

const capitalFlowSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['deposit', 'withdraw'],
      required: true,
    },
    asset: {
      type: String,
      required: true,
      uppercase: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    transactionFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    usdtValue: {
      type: Number,
      required: true,
      // signed: +deposit, -withdraw (we store NET — see sign convention in service)
    },
    priceUsdt: {
      type: Number,
      required: true,
      min: 0,
    },
    priceSource: {
      type: String,
      enum: ['kline', 'current', 'fallback', 'stablecoin', 'unknown'],
      default: 'unknown',
    },
    insertTime: {
      type: Date,
      required: true,
      index: true,
    },
    txId: {
      type: String,
      default: '',
    },
    binanceId: {
      type: String,
      default: '',
    },
    network: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      default: '',
    },
    walletType: {
      type: String,
      default: '',
    },
    transferType: {
      type: String,
      default: '',
    },
    raw: {
      // full Binance response for debug — kept small (no nested objects except primitives)
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    syncedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

capitalFlowSchema.index({ type: 1, insertTime: -1 });
capitalFlowSchema.index({ asset: 1 });
capitalFlowSchema.index({ insertTime: -1 });

const CapitalFlow = mongoose.model('CapitalFlow', capitalFlowSchema);
module.exports = CapitalFlow;
