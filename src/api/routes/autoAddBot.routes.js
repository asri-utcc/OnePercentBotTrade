'use strict';

/**
 * FIX-2026-08-07: Auto Add New Bot REST routes
 *
 * Endpoints:
 *   GET   /api/auto-add-bot/config   — current config + status
 *   PUT   /api/auto-add-bot/config   — update config + reload service
 *   POST  /api/auto-add-bot/run      — manual trigger (runOnce bypass disabled flag)
 *   GET   /api/auto-add-bot/status   — live status snapshot
 *
 * Pattern mirror: src/api/routes/bnbAutoBuy.routes.js
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const AppConfig = require('../../db/models/AppConfig');
const autoAddBot = require('../../services/autoAddBot');
const logger = require('../../utils/logger');

const router = express.Router();

// ─── Defaults (mirror AppConfig schema) ─────────────────────────
const DEFAULTS = {
  enabled: false,
  intervalMin: 60,
  minKcPct: 2,
  maxPerRun: 5,
  scanTimeframe: '3m',
  scanThreshold: 0.5,
  scanWindow: 500,
  scanTpWindow: 30,
  scanTopN: 100,
  scanMinVol: 1_000_000,
  scanMinPct: 0.30,
  scanTrends: ['uptrend', 'downtrend', 'sideways'],
  telegramNotify: true,
  autoEnable: true, // FIX-2026-08-07: spawnTrader ทันทีหลัง create (default ON)
  namePrefix: '(bAdd)', // 2026-08-08: prefix สำหรับชื่อบอทที่ auto-add สร้าง (เดิม hardcode)
};

// 2026-08-08: sanitize namePrefix (trim + cap 32 chars) + fallback เป็น default
function sanitizeNamePrefix(raw) {
  if (raw == null) return DEFAULTS.namePrefix;
  const s = String(raw).trim();
  if (!s) return DEFAULTS.namePrefix;
  return s.slice(0, 32);
}

function readConfig(cfg) {
  if (!cfg) return { ...DEFAULTS };
  return {
    enabled: cfg.autoAddBotEnabled === true,
    intervalMin: Math.max(5, Number(cfg.autoAddBotIntervalMin) || DEFAULTS.intervalMin),
    minKcPct: Number(cfg.autoAddBotMinKcPct) || DEFAULTS.minKcPct,
    maxPerRun: Math.max(1, Number(cfg.autoAddBotMaxPerRun) || DEFAULTS.maxPerRun),
    scanTimeframe: cfg.autoAddBotScanTimeframe || DEFAULTS.scanTimeframe,
    scanThreshold: Number(cfg.autoAddBotScanThreshold) || DEFAULTS.scanThreshold,
    scanWindow: Math.max(5, Number(cfg.autoAddBotScanWindow) || DEFAULTS.scanWindow),
    scanTpWindow: Math.max(20, Number(cfg.autoAddBotScanTpWindow) || DEFAULTS.scanTpWindow),
    scanTopN: Math.max(20, Number(cfg.autoAddBotScanTopN) || DEFAULTS.scanTopN),
    scanMinVol: Number(cfg.autoAddBotScanMinVol) || DEFAULTS.scanMinVol,
    scanMinPct: Number(cfg.autoAddBotScanMinPct) || DEFAULTS.scanMinPct,
    scanTrends: Array.isArray(cfg.autoAddBotScanTrends) && cfg.autoAddBotScanTrends.length > 0
      ? cfg.autoAddBotScanTrends
      : DEFAULTS.scanTrends,
    telegramNotify: cfg.autoAddBotTelegramNotify !== false,
    autoEnable: cfg.autoAddBotAutoEnable !== false, // FIX-2026-08-07: default true
    namePrefix: sanitizeNamePrefix(cfg.autoAddBotNamePrefix), // 2026-08-08: editable prefix
    lastRunAt: cfg.autoAddBotLastRunAt || null,
    lastStats: cfg.autoAddBotLastStats || null,
    lastError: cfg.autoAddBotLastError || null,
  };
}

// ─── GET /config — คืน config + status ของ service ─────────────
router.get('/config', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    const status = autoAddBot.getStatus();
    res.json({
      ...readConfig(cfg),
      status,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'autoAddBot: GET /config failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /config — อัปเดต config + restart timer ────────────────
router.put('/config', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const update = {};
    if (typeof body.enabled === 'boolean') {
      update.autoAddBotEnabled = body.enabled;
    }
    if (typeof body.intervalMin === 'number' && body.intervalMin >= 5 && body.intervalMin <= 1440) {
      update.autoAddBotIntervalMin = body.intervalMin;
    }
    if (typeof body.minKcPct === 'number' && body.minKcPct >= 0 && body.minKcPct <= 50) {
      update.autoAddBotMinKcPct = body.minKcPct;
    }
    if (typeof body.maxPerRun === 'number' && body.maxPerRun >= 1 && body.maxPerRun <= 50) {
      update.autoAddBotMaxPerRun = body.maxPerRun;
    }
    if (typeof body.scanTimeframe === 'string' && body.scanTimeframe.length > 0) {
      update.autoAddBotScanTimeframe = body.scanTimeframe;
    }
    if (typeof body.scanThreshold === 'number' && body.scanThreshold >= 0.1 && body.scanThreshold <= 100) {
      update.autoAddBotScanThreshold = body.scanThreshold;
    }
    if (typeof body.scanWindow === 'number' && body.scanWindow >= 5 && body.scanWindow <= 20000) {
      update.autoAddBotScanWindow = body.scanWindow;
    }
    if (typeof body.scanTpWindow === 'number' && body.scanTpWindow >= 20 && body.scanTpWindow <= 1000) {
      update.autoAddBotScanTpWindow = body.scanTpWindow;
    }
    if (typeof body.scanTopN === 'number' && body.scanTopN >= 20 && body.scanTopN <= 300) {
      update.autoAddBotScanTopN = body.scanTopN;
    }
    if (typeof body.scanMinVol === 'number' && body.scanMinVol >= 0) {
      update.autoAddBotScanMinVol = body.scanMinVol;
    }
    if (typeof body.scanMinPct === 'number' && body.scanMinPct >= 0 && body.scanMinPct <= 1) {
      update.autoAddBotScanMinPct = body.scanMinPct;
    }
    if (Array.isArray(body.scanTrends) && body.scanTrends.length > 0) {
      const validTrends = body.scanTrends.filter((t) => ['uptrend', 'downtrend', 'sideways'].includes(t));
      if (validTrends.length > 0) update.autoAddBotScanTrends = validTrends;
    }
    if (typeof body.telegramNotify === 'boolean') {
      update.autoAddBotTelegramNotify = body.telegramNotify;
    }
    // FIX-2026-08-07: auto-enable บอทที่เพิ่งสร้าง (default true)
    if (typeof body.autoEnable === 'boolean') {
      update.autoAddBotAutoEnable = body.autoEnable;
    }
    // 2026-08-08: name prefix (string) — sanitize + cap 32 chars (fallback "(bAdd)" ถ้าว่าง)
    if (typeof body.namePrefix === 'string') {
      update.autoAddBotNamePrefix = sanitizeNamePrefix(body.namePrefix);
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'no valid fields to update' });
    }

    await AppConfig.updateOne({ key: 'singleton' }, { $set: update }, { upsert: true });
    // restart timer (install if newly enabled, clear if newly disabled, restart if interval changed)
    await autoAddBot.reloadConfig();

    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    res.json({
      ok: true,
      ...readConfig(cfg),
      status: autoAddBot.getStatus(),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'autoAddBot: PUT /config failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /run — manual trigger (สำหรับ test + immediate action) ──
//   - bypass enabled flag (force=true)
//   - ใช้สำหรับ test หรือ "Run now" จาก UI
router.post('/run', requireAuth, async (req, res) => {
  try {
    if (autoAddBot.inFlight) {
      return res.status(409).json({ error: 'autoAddBot already running' });
    }
    const result = await autoAddBot.runOnce({ source: 'manual', force: true });
    res.json({ ok: true, result });
  } catch (err) {
    logger.error({ err: err.message }, 'autoAddBot: POST /run failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /status — live status snapshot ─────────────────────────
router.get('/status', requireAuth, (req, res) => {
  try {
    res.json(autoAddBot.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;