'use strict';

/**
 * FIX-2026-08-22: Wallet Daily Snapshot
 *
 * เก็บมูลค่าพอร์ต (USDT + THB) snapshot ตอนเที่ยงคืน BKK ทุกวัน
 * ใช้สำหรับวาดกราฟ "Account Estimate Value" ในหน้า /wallet.html
 *
 * Schema:
 *   - dateKey: 'YYYY-MM-DD' (BKK) — unique key สำหรับ upsert กัน snapshot ซ้ำวันเดียว
 *   - snapshotAt: Date (00:00:00 BKK ของ dateKey) — เวลาจริงที่ snapshot ตอนเที่ยงคืน
 *   - totalUsdt: มูลค่ารวม USDT
 *   - totalThb: มูลค่ารวม THB (snapshot ตอนนั้น)
 *   - fxRate: USDT→THB ตอน snapshot (ใช้แสดง / debug)
 *   - coinCount: จำนวนเหรียญ (value > 1 THB)
 *   - holdings: [{ asset, qty, priceUsdt, valueUsdt, valueThb }] — top holdings (เผื่อใช้ debug)
 *   - source: 'scheduler' | 'manual' (สำหรับ backfill script)
 *
 * Idempotency:
 *   - upsert by dateKey — ถ้า snapshot วันนี้มีอยู่แล้ว → update (กัน race / multi-call)
 *
 * Indexes:
 *   - dateKey unique (upsert key + chart x-axis ordering)
 *   - snapshotAt -1 (debug listing)
 */

const mongoose = require('mongoose');

const holdingSchema = new mongoose.Schema(
  {
    asset: { type: String, required: true, uppercase: true },
    qty: { type: Number, required: true, min: 0 },
    priceUsdt: { type: Number, default: null },
    valueUsdt: { type: Number, required: true, min: 0 },
    valueThb: { type: Number, default: null },
  },
  { _id: false }
);

const walletSnapshotSchema = new mongoose.Schema(
  {
    dateKey: {
      type: String,
      required: true,
      unique: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },
    snapshotAt: {
      type: Date,
      required: true,
      index: true,
    },
    totalUsdt: { type: Number, required: true, min: 0 },
    totalThb: { type: Number, default: null },
    fxRate: { type: Number, default: null },
    fxSource: { type: String, default: null },
    coinCount: { type: Number, default: 0, min: 0 },
    holdings: {
      type: [holdingSchema],
      default: [],
    },
    source: {
      type: String,
      enum: ['scheduler', 'manual', 'backfill'],
      default: 'scheduler',
    },
  },
  { timestamps: true }
);

walletSnapshotSchema.index({ snapshotAt: -1 });

const WalletSnapshot = mongoose.model('WalletSnapshot', walletSnapshotSchema);
module.exports = WalletSnapshot;
