'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const AppConfig = require('../../db/models/AppConfig');
const autoBnbBuyer = require('../../services/autoBnbBuyer');
const logger = require('../../utils/logger');

const router = express.Router();

// ─── Defaults (mirror AppConfig schema) ─────────────────────────
const DEFAULTS = {
  enabled: false,
  topUpUsdt: 5.5,
  thresholdUsdt: 0.5,
  checkIntervalMin: 60,
  maxUsdtPerDay: 50,
  cooldownMin: 30,
  // FIX-2026-08-05: BNB oil gauge target (ส่งกลับมากับ /config — UI ใช้ hydrate ตอน load)
  gaugeTargetUsdt: 10,
};

// ─── GET /config — คืน config + status ของ service ─────────────
router.get('/config', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    const status = autoBnbBuyer.getStatus();
    res.json({
      enabled: cfg ? cfg.autoBuyBnbEnabled === true : DEFAULTS.enabled,
      topUpUsdt: cfg ? Number(cfg.autoBuyBnbTopUpUsdt) || DEFAULTS.topUpUsdt : DEFAULTS.topUpUsdt,
      thresholdUsdt: cfg ? Number(cfg.autoBuyBnbThresholdUsdt) || DEFAULTS.thresholdUsdt : DEFAULTS.thresholdUsdt,
      checkIntervalMin: cfg ? Number(cfg.autoBuyBnbCheckIntervalMin) || DEFAULTS.checkIntervalMin : DEFAULTS.checkIntervalMin,
      maxUsdtPerDay: cfg ? Number(cfg.autoBuyBnbMaxUsdtPerDay) || DEFAULTS.maxUsdtPerDay : DEFAULTS.maxUsdtPerDay,
      cooldownMin: cfg ? Number(cfg.autoBuyBnbCooldownMin) || DEFAULTS.cooldownMin : DEFAULTS.cooldownMin,
      // FIX-2026-08-05: gauge target — return from same endpoint (ไม่ต้องแยก route)
      gaugeTargetUsdt: cfg ? Number(cfg.bnbGaugeTargetUsdt) || DEFAULTS.gaugeTargetUsdt : DEFAULTS.gaugeTargetUsdt,
      status,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'bnbAutoBuy: GET /config failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /config — อัปเดต config + restart timer ────────────────
router.put('/config', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const update = {};
    if (typeof body.enabled === 'boolean') {
      update.autoBuyBnbEnabled = body.enabled;
    }
    if (typeof body.topUpUsdt === 'number' && body.topUpUsdt >= 5 && body.topUpUsdt <= 100) {
      update.autoBuyBnbTopUpUsdt = body.topUpUsdt;
    }
    if (typeof body.thresholdUsdt === 'number' && body.thresholdUsdt >= 0.1 && body.thresholdUsdt <= 100) {
      update.autoBuyBnbThresholdUsdt = body.thresholdUsdt;
    }
    if (typeof body.checkIntervalMin === 'number' && body.checkIntervalMin >= 5 && body.checkIntervalMin <= 1440) {
      update.autoBuyBnbCheckIntervalMin = body.checkIntervalMin;
    }
    if (typeof body.maxUsdtPerDay === 'number' && body.maxUsdtPerDay >= 0 && body.maxUsdtPerDay <= 10000) {
      update.autoBuyBnbMaxUsdtPerDay = body.maxUsdtPerDay;
    }
    if (typeof body.cooldownMin === 'number' && body.cooldownMin >= 0 && body.cooldownMin <= 1440) {
      update.autoBuyBnbCooldownMin = body.cooldownMin;
    }
    // FIX-2026-08-05: BNB oil gauge target (1..100 USDT)
    if (typeof body.gaugeTargetUsdt === 'number' && body.gaugeTargetUsdt >= 1 && body.gaugeTargetUsdt <= 100) {
      update.bnbGaugeTargetUsdt = body.gaugeTargetUsdt;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'no valid fields to update' });
    }

    await AppConfig.updateOne({ key: 'singleton' }, { $set: update }, { upsert: true });
    // restart timer with new interval (if interval changed)
    autoBnbBuyer.reloadConfig();

    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    res.json({
      ok: true,
      enabled: cfg.autoBuyBnbEnabled === true,
      topUpUsdt: cfg.autoBuyBnbTopUpUsdt,
      thresholdUsdt: cfg.autoBuyBnbThresholdUsdt,
      checkIntervalMin: cfg.autoBuyBnbCheckIntervalMin,
      maxUsdtPerDay: cfg.autoBuyBnbMaxUsdtPerDay,
      cooldownMin: cfg.autoBuyBnbCooldownMin,
      // FIX-2026-08-05: echo gauge target
      gaugeTargetUsdt: cfg.bnbGaugeTargetUsdt,
      status: autoBnbBuyer.getStatus(),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'bnbAutoBuy: PUT /config failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /trigger — manual buy now (สำหรับ test + emergency) ────
//   ⚠️ Live trading — ส่งคำสั่งจริง (เหมือน periodic scan แต่ bypass enabled flag)
router.post('/trigger', requireAuth, async (req, res) => {
  try {
    if (autoBnbBuyer.inFlight) {
      return res.status(409).json({ error: 'autoBnbBuyer already running' });
    }
    // Use force=true to bypass enabled flag (manual trigger overrides)
    const result = await autoBnbBuyer.runOnce({ source: 'manual', force: true });
    res.json({ ok: true, result });
  } catch (err) {
    logger.error({ err: err.message }, 'bnbAutoBuy: POST /trigger failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /logs — audit log ล่าสุด 50 รายการ ──────────────────
router.get('/logs', requireAuth, async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const BnbAutoBuyLog = mongoose.models.BnbAutoBuyLog || mongoose.model('BnbAutoBuyLog', new mongoose.Schema({
      ts: Date, outcome: String, reason: String,
      bnbQtyBefore: Number, bnbUsdtValueBefore: Number, bnbUsdtPrice: Number,
      topUpUsdt: Number, bnbQtyBought: Number, bnbPriceFilled: Number,
      orderId: Number, clientOrderId: String,
      errorCode: String, errorMsg: String, source: String,
    }, { strict: false }));
    const logs = await BnbAutoBuyLog.find({}).sort({ ts: -1 }).limit(50).lean();
    res.json({ logs, count: logs.length });
  } catch (err) {
    logger.error({ err: err.message }, 'bnbAutoBuy: GET /logs failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
