'use strict';

/**
 * FIX-2026-08-08: Admin routes — system-level toggles + force-run endpoints
 *   - GET /api/admin/app-config — read current AppConfig (master toggles visible to UI)
 *   - PUT /api/admin/app-config — update master toggles (DPS tunables + DPS safety, CB Auto-Unlock, Auto Delete Bot)
 *   - POST /api/admin/auto-delete-run — force-run autoDeleteBot 1 cycle immediately
 *   - POST /api/admin/dps-reset-all — clear DPS state on every bot
 *
 * Auth:
 *   - requireAuth (user must be logged in)
 *   - master toggle update: requireSettingsPassword (admin-level — same pattern as settings)
 *   - auto-delete-run / dps-reset-all: requireBotActionPassword (admin-level — same pattern as unlock-cbv2)
 */

const express = require('express');
const router = express.Router();
const AppConfig = require('../../db/models/AppConfig');
const Bot = require('../../db/models/Bot');
const masterConfig = require('../../core/masterConfig');
const cbVersion = require('../../core/cbVersion');
const autoDeleteBot = require('../../services/autoDeleteBot');
const autoPauseAdjust = require('../../services/autoPauseAdjust');
const configBackup = require('../../services/configBackup');
const licenseService = require('../../services/licenseService');
const eventBus = require('../../services/eventBus');
const masterConfigTemplates = require('../../services/masterConfigTemplates');
const logger = require('../../utils/logger');
const { requireAuth } = require('../middleware/auth');

// Middleware stubs (mirror existing settings.js / bot.routes.js password pattern)
// FIX-2026-08-24: removed requireSettingsPassword + requireBotActionPassword fallbacks —
//   per user request, no password gate on admin routes anymore. requireAuth alone is
//   sufficient (session-based auth). Destructive single-bot actions (force-close,
//   delete, create, permanent-delete, enable/disable/unlock/restore) still use
//   requireBotActionPassword from src/api/middleware/auth.js.

// ─── GET /api/admin/app-config ─────────────────────────────────
router.get('/app-config', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (!cfg) return res.json({ config: {} });
    res.json({ config: cfg });
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: GET app-config failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/admin/app-config ─────────────────────────────────
// FIX-2026-08-08 (rev2): master toggles — DPS tunables + CB Auto-Unlock + Auto Delete Bot
//   - whitelist fields (กัน user inject field �ื่น)
//   - per-field clamp map
//   - cross-field validation: minSize<=maxSize, minLayers<=maxLayers (merge DB ก่อนเช็ค)
//   - invalidate caches so next read picks up new value within 30s
// FIX-2026-08-24: removed requireSettingsPassword per user request — in-session admin
//   action. requireSettingsPassword was already a no-op (falls back to requireAuth).
//
// FIX-2026-08-08 (rev2): DPS field clamps (ต้องตรงกับ DEFAULTS ใน dynamicPositionSizing.js)
const DPS_CLAMP = {
  dpsMinSize:        { min: 5,    max: 10000, int: false },
  dpsMaxSize:        { min: 5,    max: 10000, int: false },
  dpsMinLayers:      { min: 1,    max: 50,    int: true  },
  dpsMaxLayers:      { min: 1,    max: 50,    int: true  },
  dpsCooldownMinutes:{ min: 0,    max: 1440,  int: true  },
  dpsWinStreakCount: { min: 1,    max: 20,    int: true  },
  dpsWinStreakDeltaSize:    { min: -1000, max: 1000, int: false },
  dpsWinStreakDeltaLayers:  { min: -50,   max: 50,   int: true  },
  dpsBigWinCount:    { min: 1,    max: 20,    int: true  },
  dpsBigWinPct:      { min: 0.1,  max: 100,   int: false },
  dpsBigWinDeltaSize:       { min: -1000, max: 1000, int: false },
  dpsBigWinDeltaLayers:     { min: -50,   max: 50,   int: true  },
  dpsLossStreakCount:{ min: 1,    max: 20,    int: true  },
  dpsLossDeltaSize:  { min: -1000, max: 1000, int: false },
  dpsLossDeltaLayers:{ min: -50,   max: 50,   int: true  },
};

function _clampDpsField(name, value) {
  const r = DPS_CLAMP[name];
  if (!r) return value;
  let v = value;
  if (r.int) v = Math.round(v);
  v = Math.max(r.min, Math.min(r.max, v));
  return v;
}

router.put('/app-config', requireAuth, async (req, res) => {
  try {
    const whitelist = {
      masterDynamicSizeEnabled: 'boolean',
      masterCbAutoUnlockEnabled: 'boolean',
      autoDeleteBotEnabled: 'boolean',
      autoDeleteBotDays: 'number',
      autoDeleteBotWarningDays: 'number',
      cbVersion: 'string',
      // FIX-2026-08-08 (rev2): DPS tunables (15 numbers)
      dpsMinSize: 'number', dpsMaxSize: 'number',
      dpsMinLayers: 'number', dpsMaxLayers: 'number',
      dpsCooldownMinutes: 'number',
      dpsWinStreakCount: 'number', dpsWinStreakDeltaSize: 'number', dpsWinStreakDeltaLayers: 'number',
      dpsBigWinCount: 'number', dpsBigWinPct: 'number', dpsBigWinDeltaSize: 'number', dpsBigWinDeltaLayers: 'number',
      dpsLossStreakCount: 'number', dpsLossDeltaSize: 'number', dpsLossDeltaLayers: 'number',
      // FIX-2026-08-08 (rev2): DPS safety (3 booleans)
      dpsRespectBotCapital: 'boolean',
      dpsResetHistoryOnFire: 'boolean',
      dpsDryRun: 'boolean',
    };
    const set = {};
    for (const [k, t] of Object.entries(whitelist)) {
      if (req.body[k] === undefined) continue;
      if (t === 'boolean') set[k] = !!req.body[k];
      else if (t === 'number') {
        const n = parseFloat(req.body[k]);
        if (Number.isFinite(n)) set[k] = n;
      } else if (t === 'string') {
        if (typeof req.body[k] === 'string') set[k] = req.body[k];
      }
    }
    // validate cbVersion enum
    if (set.cbVersion && !['v2', 'v3'].includes(set.cbVersion)) delete set.cbVersion;
    // FIX-2026-08-08 (rev2): apply DPS clamps (per-field)
    for (const name of Object.keys(DPS_CLAMP)) {
      if (set[name] != null) set[name] = _clampDpsField(name, set[name]);
    }
    // validate ranges (existing)
    if (set.autoDeleteBotDays != null) {
      set.autoDeleteBotDays = Math.max(7, Math.min(365, set.autoDeleteBotDays));
    }
    if (set.autoDeleteBotWarningDays != null) {
      set.autoDeleteBotWarningDays = Math.max(1, Math.min(30, set.autoDeleteBotWarningDays));
    }

    // FIX-2026-08-08 (rev2): cross-field DPS validation (merge DB เดิม + set ใหม่ก่อนเช็ค)
    //   - ต้องทำหลัง clamp เพื่อให้ค่าที่ส่งมาเกินช่วงก็โดนบีบก่อน
    const wantsMinSize   = set.dpsMinSize   != null;
    const wantsMaxSize   = set.dpsMaxSize   != null;
    const wantsMinLayers = set.dpsMinLayers != null;
    const wantsMaxLayers = set.dpsMaxLayers != null;
    if (wantsMinSize || wantsMaxSize || wantsMinLayers || wantsMaxLayers) {
      const current = await AppConfig.findOne({ key: 'singleton' }).lean();
      const merged = {
        dpsMinSize:   wantsMinSize   ? set.dpsMinSize   : (current ? current.dpsMinSize   : 6),
        dpsMaxSize:   wantsMaxSize   ? set.dpsMaxSize   : (current ? current.dpsMaxSize   : 15),
        dpsMinLayers: wantsMinLayers ? set.dpsMinLayers : (current ? current.dpsMinLayers : 1),
        dpsMaxLayers: wantsMaxLayers ? set.dpsMaxLayers : (current ? current.dpsMaxLayers : 5),
      };
      if (merged.dpsMinSize > merged.dpsMaxSize) {
        return res.status(400).json({ error: `ขนาดไม้: ขั้นต่ำ (${merged.dpsMinSize}) ต้องไม่เกิน ขั้นสูง (${merged.dpsMaxSize})` });
      }
      if (merged.dpsMinLayers > merged.dpsMaxLayers) {
        return res.status(400).json({ error: `จำนวนไม้: ขั้นต่ำ (${merged.dpsMinLayers}) ต้องไม่เกิน ขั้นสูง (${merged.dpsMaxLayers})` });
      }
    }

    if (Object.keys(set).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    const updated = await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: set },
      { new: true, upsert: true }
    ).lean();
    // invalidate caches so next read picks up new value
    masterConfig.invalidateCache();
    cbVersion.invalidateCache();
    logger.info({ botId: null, set }, 'admin: app-config updated');
    res.json({ ok: true, config: updated });
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: PUT app-config failed');
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// FIX-2026-08-21: Binance API rate-limit capacity (token-bucket)
//   - GET /api/admin/rate-limit
//       → return current capacity + live limiter status (tokens/used estimate)
//   - PUT /api/admin/rate-limit
//       → user updates capacity (clamp 500..120000) — applies to live limiter
//       → when 1 server รันหลาย instance / หลายระบบ ให้หาร capacity กัน
//         เช่น 2 ระบบ → capacity = 6000 / 2 = 3000 ต่อ instance
//   - requireSettingsPassword (admin-level — same as PUT /app-config)
//
// Response shape:
//   {
//     capacity: 6000,
//     min: 500,
//     max: 120000,
//     default: 6000,
//     limiter: { tokens, usedEstimated, refillRate, lastRefill }
//   }
// ═══════════════════════════════════════════════════════════════════════
const rateLimitConfig = require('../../services/binanceRateLimitConfig');
const binanceRest = require('../../binance/binanceRest');

router.get('/rate-limit', requireAuth, async (req, res) => {
  try {
    const capacity = await rateLimitConfig.getBinanceRateLimit();
    res.json({
      capacity,
      min: rateLimitConfig.MIN_VALUE,
      max: rateLimitConfig.MAX_VALUE,
      default: rateLimitConfig.DEFAULT_VALUE,
      limiter: binanceRest.getRateLimitStatus(),
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: GET rate-limit failed');
    res.status(500).json({ error: err.message });
  }
});

router.put('/rate-limit', requireAuth, async (req, res) => {
  try {
    const raw = req.body && req.body.capacity;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({ error: `capacity ต้องเป็นจำนวนเต็มบวก (ได้รับ: ${raw})` });
    }
    if (n < rateLimitConfig.MIN_VALUE) {
      return res.status(400).json({
        error: `capacity ขั้นต่ำ ${rateLimitConfig.MIN_VALUE} (ได้รับ: ${n}) — Binance แจ้งเตือนถ้าใช้ต่ำกว่านี้`,
      });
    }
    if (n > rateLimitConfig.MAX_VALUE) {
      return res.status(400).json({
        error: `capacity ขั้นสูง ${rateLimitConfig.MAX_VALUE} (ได้รับ: ${n}) — ต้องใช้ Binance Bot Account ถึงจะได้มากกว่า 6000`,
      });
    }
    // persist to DB
    const updated = await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: { binanceRateLimitPerMin: n } },
      { new: true, upsert: true }
    ).lean();
    // drop cache + apply to live limiter (in-place, no restart needed)
    rateLimitConfig.invalidateCache(n);
    const applyResult = await binanceRest.setRateLimitCapacity(n);
    logger.info(
      { previous: applyResult && applyResult.ok ? null : applyResult, newCapacity: n, dbCapacity: updated.binanceRateLimitPerMin },
      'admin: binance rate-limit updated'
    );
    res.json({
      ok: true,
      capacity: n,
      dbCapacity: updated.binanceRateLimitPerMin,
      limiter: binanceRest.getRateLimitStatus(),
    });
  } catch (err) {
    logger.warn({ err: err.message, body: req.body }, 'admin: PUT rate-limit failed');
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// FIX-2026-08-29: Auto-pause threshold auto-adjust (master settings + run-now)
//   - GET /api/admin/auto-pause-adjust
//       → return current AppConfig.autoPauseAdjust* + scheduler status + lastStats
//       → include live count of "running" bots (enabled && autoPauseEnabled && !deletedAt)
//       → include count of opted-out bots (autoPauseAdjustEnabled=false but eligible otherwise)
//   - PUT /api/admin/auto-pause-adjust
//       → update AppConfig fields (clamp on save)
//       → call autoPauseAdjust.reloadConfig() to install/clear interval in-place
//   - POST /api/admin/auto-pause-adjust/run-now
//       → force-tick the scheduler (manual run, bypasses interval)
//       → returns runOnce stats for instant UI feedback
//   - requireAuth (admin-level — same as other master config endpoints)
// ═══════════════════════════════════════════════════════════════════════
router.get('/auto-pause-adjust', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    const [
      runningBots,
      eligibleBots,
      optedOutBots,
    ] = await Promise.all([
      Bot.countDocuments({ enabled: { $ne: false }, autoPauseEnabled: { $ne: false }, deletedAt: null }),
      Bot.countDocuments({ autoPauseEnabled: { $ne: false }, autoPauseAdjustEnabled: { $ne: false }, deletedAt: null }),
      Bot.countDocuments({ autoPauseEnabled: { $ne: false }, autoPauseAdjustEnabled: false, deletedAt: null }),
    ]);
    const status = autoPauseAdjust.getStatus();
    res.json({
      ok: true,
      settings: {
        enabled: cfg ? cfg.autoPauseAdjustEnabled === true : false,
        minBots: cfg ? cfg.autoPauseAdjustMinBots : autoPauseAdjust.DEFAULT_MIN_BOTS,
        maxBots: cfg ? cfg.autoPauseAdjustMaxBots : autoPauseAdjust.DEFAULT_MAX_BOTS,
        intervalMs: cfg ? cfg.autoPauseAdjustIntervalMs : autoPauseAdjust.DEFAULT_INTERVAL_MS,
        kcStep: cfg ? cfg.autoPauseAdjustKcStep : autoPauseAdjust.DEFAULT_KC_STEP,
        volStep: cfg ? cfg.autoPauseAdjustVolStep : autoPauseAdjust.DEFAULT_VOL_STEP,
        lastRunAt: cfg ? cfg.autoPauseAdjustLastRunAt : null,
        lastStats: cfg ? cfg.autoPauseAdjustLastStats : null,
        lastError: cfg ? cfg.autoPauseAdjustLastError : null,
      },
      status,
      counts: {
        running: runningBots,
        eligible: eligibleBots,
        optedOut: optedOutBots,
      },
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: GET auto-pause-adjust failed');
    res.status(500).json({ error: err.message });
  }
});

router.put('/auto-pause-adjust', requireAuth, async (req, res) => {
  try {
    const set = {};
    // FIX-2026-08-29: validate + clamp each field
    if (req.body.enabled !== undefined) set.autoPauseAdjustEnabled = !!req.body.enabled;
    if (req.body.minBots !== undefined) {
      const n = parseFloat(req.body.minBots);
      if (Number.isFinite(n)) set.autoPauseAdjustMinBots = Math.max(1, Math.min(1000, n));
    }
    if (req.body.maxBots !== undefined) {
      const n = parseFloat(req.body.maxBots);
      if (Number.isFinite(n)) set.autoPauseAdjustMaxBots = Math.max(1, Math.min(1000, n));
    }
    if (req.body.intervalMs !== undefined) {
      const n = parseFloat(req.body.intervalMs);
      if (Number.isFinite(n)) set.autoPauseAdjustIntervalMs = Math.max(60_000, Math.min(24 * 60 * 60 * 1000, n));
    }
    if (req.body.kcStep !== undefined) {
      const n = parseFloat(req.body.kcStep);
      if (Number.isFinite(n)) set.autoPauseAdjustKcStep = Math.max(0.01, Math.min(5, n));
    }
    if (req.body.volStep !== undefined) {
      const n = parseFloat(req.body.volStep);
      if (Number.isFinite(n)) set.autoPauseAdjustVolStep = Math.max(1_000, Math.min(100_000_000, n));
    }
    // cross-field: minBots must be < maxBots
    const merged = {
      minBots: set.autoPauseAdjustMinBots != null ? set.autoPauseAdjustMinBots : null,
      maxBots: set.autoPauseAdjustMaxBots != null ? set.autoPauseAdjustMaxBots : null,
    };
    if (merged.minBots != null && merged.maxBots != null && merged.minBots >= merged.maxBots) {
      return res.status(400).json({ error: `minBots (${merged.minBots}) ต้องน้อยกว่า maxBots (${merged.maxBots})` });
    }
    if (Object.keys(set).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    const updated = await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: set },
      { new: true, upsert: true }
    ).lean();
    // apply in-place: reload config (install/clear interval based on enabled)
    await autoPauseAdjust.reloadConfig();
    logger.info({ set }, 'admin: auto-pause-adjust settings updated');
    res.json({ ok: true, config: updated });
  } catch (err) {
    logger.warn({ err: err.message, body: req.body }, 'admin: PUT auto-pause-adjust failed');
    res.status(500).json({ error: err.message });
  }
});

// FIX-2026-08-29: enrich run-now response with counts + bounds so UI can show
//   "why did nothing visibly change?" detail (running/eligible/optedOut + ADJUST_* bounds).
const { ADJUST_KC_MIN, ADJUST_KC_MAX, ADJUST_VOL_MIN, ADJUST_VOL_MAX } = require('../../services/autoPauseAdjust');

router.post('/auto-pause-adjust/run-now', requireAuth, async (req, res) => {
  try {
    const stats = await autoPauseAdjust.runOnce({ source: 'manual' });
    // Counts snapshot (so UI can show "X eligible / Y opted out / Z running")
    const [runningBots, eligibleDocs, optedOutDocs] = await Promise.all([
      Bot.countDocuments({ enabled: { $ne: false }, autoPauseEnabled: { $ne: false }, deletedAt: null }),
      Bot.countDocuments({ autoPauseEnabled: { $ne: false }, autoPauseAdjustEnabled: { $ne: false }, deletedAt: null }),
      Bot.countDocuments({ autoPauseEnabled: { $ne: false }, autoPauseAdjustEnabled: false, deletedAt: null }),
    ]);
    logger.info({ stats }, 'admin: auto-pause-adjust run-now completed');
    res.json({
      ok: true,
      stats,
      counts: { runningBots, eligibleBots: eligibleDocs, optedOutBots: optedOutDocs },
      bounds: { kcMin: ADJUST_KC_MIN, kcMax: ADJUST_KC_MAX, volMin: ADJUST_VOL_MIN, volMax: ADJUST_VOL_MAX },
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: auto-pause-adjust run-now failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/auto-delete-run ───────────────────────────
// FIX-2026-08-08: force-tick autoDeleteBot — useful for testing + manual scheduling
//   - returns stats object from tick()
//   - if tick is already running → returns { skipped: 'in-progress' }
// FIX-2026-08-24: removed requireBotActionPassword per user request — manual auto-delete
//   run is in-session admin action (no destructive irreversible effect — only soft-delete).
router.post('/auto-delete-run', requireAuth, async (req, res) => {
  try {
    const stats = await autoDeleteBot.tick();
    logger.info({ stats }, 'admin: auto-delete-run completed');
    res.json({ ok: true, stats });
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: auto-delete-run failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/bot-defaults ─────────────────────────────────
// FIX-2026-08-08 (rev3): Bot Defaults — ค่าเริ่มต้นตอนสร้างบอทใหม่
//   - GET: คืนค่า defaults ปัจจุบัน (merge DB กับ schema default)
//   - PUT: อัปเดตค่า + clamp/validate ตาม Bot schema constraints
//   - whitelist fields (กัน user inject field อื่น)
//   - per-field clamp (mirror POST /api/bots + Bot model)
const BOT_DEFAULTS_CLAMP = {
  capitalPerTrade:           { min: 1,     max: 100000 },
  maxTrades:                 { min: 1,     max: 1000,   int: true },
  tpPercent:                 { min: 0.001, max: 100 },
  retryTimeMin:              { min: 0.1,   max: 60 },
  retryMax:                  { min: 0,     max: 10,     int: true },
  kcMult:                    { min: 0.5,   max: 5 },
  minSpreadTicks:            { min: 0,     max: 10,     int: true },
  suggestTpWindow:           { min: 30,    max: 1000,   int: true },
  dcaMaxLayers:              { min: 1,     max: 100,    int: true },
  martingaleMultiplier:      { min: 1.0,   max: 3.0 },
  martingaleMaxLayerNotional:{ min: 1,     max: 10000 },
  cbv2LockHours:             { min: 0.5,   max: 168 },
  cbv3LockHours:             { min: 0.5,   max: 168 },
  cbv5LockHours:             { min: 0.5,   max: 168 },
  cbv5KcLen:                 { min: 5,     max: 100,    int: true },
  cbv5KcMult:                { min: 0.5,   max: 5 },
  cbv5PivotLookback:         { min: 2,     max: 10,     int: true },
  cbv5PivotLeftLen:          { min: 2,     max: 50,     int: true },
  cbv5PivotRightLen:         { min: 2,     max: 50,     int: true },
  cbv5VolMaLen:              { min: 5,     max: 100,    int: true },
  cbv5VolMultiplier:         { min: 1.0,   max: 10 },
  cbv5DebounceCandles:      { min: 1,     max: 20,     int: true },
  cbAutoUnlockThresholdPct:  { min: 0.5,   max: 5.0 },
  autoPauseMinKcPct:         { min: 0.1,   max: 50 },
  autoPauseMin24hVolUsdt:    { min: 0,     max: 1_000_000_000, int: true },
  autoArmLossPct:            { min: 1,     max: 99 },
  autoArmAgeHours:           { min: 0.5,   max: 999 },
  tpTrendMultiplier:         { min: 1,     max: 10 },
};

// Schema defaults (mirror POST /api/bots logic — แหล่ง single source of truth)
const BOT_DEFAULTS_SCHEMA = {
  capitalPerTrade: 9,
  maxTrades: 1,
  tpPercent: 0.1,
  retryTimeMin: 0.2,
  retryMax: 8,
  kcMult: 1.2,
  minSpreadTicks: 1,
  suggestTpWindow: 30,
  dcaEnabled: false,
  dcaMaxLayers: 3,
  martingaleEnabled: false,
  martingaleMultiplier: 1.5,
  martingaleMaxLayerNotional: 100,
  s1OnlyDown: false,
  xs1Enabled: true,
  cbEnabled: true,
  cbv2Enabled: true,
  cbv2LockHours: 8,
  cbv3Enabled: true,
  cbv3LockHours: 8,
  cbv5Enabled: true,
  cbv5LockHours: 4,
  cbv5KcLen: 20,
  cbv5KcMult: 1.2,
  cbv5PivotLookback: 3,
  cbv5PivotLeftLen: 5,
  cbv5PivotRightLen: 5,
  cbv5StrictBreak: true,
  cbv5UseVolume: true,
  cbv5VolMaLen: 20,
  cbv5VolMultiplier: 1.5,
  cbv5DebounceCandles: 5,
  cbAutoUnlockEnabled: false,
  cbAutoUnlockThresholdPct: 1.0,
  dynamicSizeEnabled: true,
  safeTradeEnabled: true,
  safeTradeTrendlineEnabled: false,
  safeTradeNoTradeEnabled: false,
  autoPauseEnabled: true,
  autoPauseMinKcPct: 2,
  autoPauseMin24hVolUsdt: 1_000_000,
  autoArmStopLossOnUKC: true,
  autoArmLossPct: 6.3,
  autoArmAgeHours: 4,
  slUkcTriggerOnProfit: false,
  tpTrendEnabled: true,
  tpTrendMultiplier: 2,
  autoUpdateTp: true,
  stopLossOnUpperKC: false,
  defaultSymbol: 'BNBUSDT',
  defaultTimeframe: '3m',
};

function _clampBotDefault(name, value) {
  const r = BOT_DEFAULTS_CLAMP[name];
  if (!r) return value;
  let v = value;
  if (r.int) v = Math.round(v);
  v = Math.max(r.min, Math.min(r.max, v));
  return v;
}

function _readBotDefaults(cfg) {
  const stored = (cfg && cfg.botDefaults) || {};
  return { ...BOT_DEFAULTS_SCHEMA, ...stored };
}

router.get('/bot-defaults', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    res.json({ defaults: _readBotDefaults(cfg) });
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: GET bot-defaults failed');
    res.status(500).json({ error: err.message });
  }
});

router.put('/bot-defaults', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    // whitelist: only known fields (number/string/boolean)
    const BOOLEAN_FIELDS = [
      'dcaEnabled', 'martingaleEnabled',
      's1OnlyDown', 'xs1Enabled', 'cbEnabled', 'cbv2Enabled', 'cbv3Enabled',
      'cbv5Enabled', 'cbv5StrictBreak', 'cbv5UseVolume',
      'cbAutoUnlockEnabled', 'dynamicSizeEnabled',
      'safeTradeEnabled', 'safeTradeTrendlineEnabled', 'safeTradeNoTradeEnabled',
      'autoPauseEnabled', 'autoPauseAdjustEnabled', 'autoArmStopLossOnUKC',
      'slUkcTriggerOnProfit', 'tpTrendEnabled', 'autoUpdateTp', 'stopLossOnUpperKC',
    ];
    const NUMBER_FIELDS = [
      'capitalPerTrade', 'maxTrades', 'tpPercent', 'retryTimeMin', 'retryMax',
      'kcMult', 'minSpreadTicks', 'suggestTpWindow',
      'dcaMaxLayers', 'martingaleMultiplier', 'martingaleMaxLayerNotional',
      'cbv2LockHours', 'cbv3LockHours', 'cbv5LockHours',
      'cbv5KcLen', 'cbv5KcMult', 'cbv5PivotLookback', 'cbv5PivotLeftLen', 'cbv5PivotRightLen',
      'cbv5VolMaLen', 'cbv5VolMultiplier', 'cbv5DebounceCandles',
      'cbAutoUnlockThresholdPct',
      'autoPauseMinKcPct', 'autoPauseMin24hVolUsdt', 'autoArmLossPct', 'autoArmAgeHours', 'tpTrendMultiplier',
    ];
    const STRING_FIELDS = ['defaultSymbol', 'defaultTimeframe'];

    const update = {};
    for (const k of BOOLEAN_FIELDS) {
      if (typeof body[k] === 'boolean') update[k] = body[k];
    }
    for (const k of NUMBER_FIELDS) {
      if (body[k] === undefined) continue;
      const n = parseFloat(body[k]);
      if (Number.isFinite(n)) update[k] = _clampBotDefault(k, n);
    }
    for (const k of STRING_FIELDS) {
      if (typeof body[k] === 'string') {
        const s = body[k].trim();
        if (s) update[k] = k === 'defaultSymbol' ? s.toUpperCase() : s;
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // 2026-08-08 (rev3): Martingale requires DCA mode (validate before write)
    if (update.martingaleEnabled === true && update.dcaEnabled === false) {
      // check DB สำหรับ dcaEnabled ปัจจุบัน (อาจไม่ได้อยู่ใน update)
      const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
      const mergedDca = update.dcaEnabled !== undefined ? update.dcaEnabled : (cfg && cfg.botDefaults && cfg.botDefaults.dcaEnabled);
      if (mergedDca !== true) {
        return res.status(400).json({ error: 'martingaleEnabled requires dcaEnabled=true (Martingale is a DCA-mode-only strategy)' });
      }
    }
    // DPS mutually exclusive with DCA/Martingale
    if (update.dynamicSizeEnabled !== false && (update.dcaEnabled === true || update.martingaleEnabled === true)) {
      return res.status(400).json({ error: 'dynamicSizeEnabled is mutually exclusive with dcaEnabled/martingaleEnabled' });
    }

    // merge กับ defaults เดิมเพื่อไม่ให้ field ที่ไม่ได้ส่งมาหาย
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    const prev = _readBotDefaults(cfg);
    const merged = { ...prev, ...update };

    await AppConfig.updateOne(
      { key: 'singleton' },
      { $set: { botDefaults: merged } },
      { upsert: true }
    );

    logger.info({ botId: null, updated: Object.keys(update) }, 'admin: bot-defaults updated');
    res.json({ ok: true, defaults: merged });
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: PUT bot-defaults failed');
    res.status(500).json({ error: err.message });
  }
});
// FIX-2026-08-08 (rev2): เคลียร์ DPS state (dynamicSizeCurrent / dynamicLayersCurrent /
//   dynamicSizeLastResults / dynamicSizeCooldownUntil / dynamicSizeLastEvaluatedAt) ทุกบอท
//   - สำหรับกรณี state เพี้ยนจากการ migrate / config เปลี่ยน / ต้องการเริ่มนับใหม่ทั้งระบบ
//   - ต้องมี requireBotActionPassword — กระทบบอทจำนวนมาก
//   - sync in-memory trader snapshot ถ้ามี trader ทำงานอยู่
// FIX-2026-08-24: removed requireBotActionPassword per user request — admin batch DPS
//   reset is in-session admin action (reversible — bots can re-accumulate DPS state).
router.post('/dps-reset-all', requireAuth, async (req, res) => {
  try {
    const dps = require('../../core/dynamicPositionSizing');
    const botManager = require('../../core/botManager');
    const reset = dps.resetStateUpdate();
    const result = await Bot.updateMany({}, { $set: reset });
    const matched = result.matchedCount || 0;
    const modified = result.modifiedCount || 0;
    // sync in-memory snapshots ของ trader ที่กำลังรันอยู่
    let syncedInMem = 0;
    try {
      const traders = botManager.traders;
      if (traders && typeof traders.values === 'function') {
        for (const trader of traders.values()) {
          if (trader && trader.bot) {
            Object.assign(trader.bot, reset);
            syncedInMem++;
          }
        }
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'admin: dps-reset-all — in-memory sync skipped (botManager not ready)');
    }
    eventBus.emit('bot:bulk-updated', { reason: 'dps-reset-all', count: modified });
    logger.info({ matched, modified, syncedInMem }, 'admin: dps-reset-all — DPS state cleared on all bots');
    res.json({ ok: true, matched, modified, syncedInMem });
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: dps-reset-all failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// ════════════════════════════════════════════════════════════════════════════════════════════
// FIX-2026-08-13: Master Config Templates — CRUD on AppConfig.masterConfigTemplates
//   - GET    /api/admin/master-config-templates              list (metadata only)
//   - GET    /api/admin/master-config-templates/:id          full entry (with settings)
//   - POST   /api/admin/master-config-templates              create
//   - PUT    /api/admin/master-config-templates/:id          rename and/or replace settings
//   - DELETE /api/admin/master-config-templates/:id          delete
//
// Auth: requireSettingsPassword (mutates persistent AppConfig — same pattern as
//   PUT /api/admin/app-config). Falls back to requireAuth if middleware missing.
// ════════════════════════════════════════════════════════════════════════════════════════════

// Lightweight metadata list (id + name + fieldCount + timestamps).
// Modal dropdown only needs these — full settings fetched on demand.
router.get('/master-config-templates', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    const templates = (cfg && cfg.masterConfigTemplates) || [];
    res.json({ templates: masterConfigTemplates.toMetadataList(templates) });
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: GET master-config-templates failed');
    res.status(500).json({ error: err.message });
  }
});

// Full entry (with settings) — frontend calls this on Load click.
router.get('/master-config-templates/:id', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    const templates = (cfg && cfg.masterConfigTemplates) || [];
    const entry = masterConfigTemplates.findById(templates, req.params.id);
    if (!entry) return res.status(404).json({ error: 'template not found' });
    res.json({ template: entry });
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: GET master-config-templates/:id failed');
    res.status(500).json({ error: err.message });
  }
});

// Create new template — body: { name, settings, overwrite?: boolean }
// sanitizeSettings() drops unknown keys; per-field clamping is deferred to
// /api/bots/bulk-update (so user sees validation errors at the apply step).
router.post('/master-config-templates', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    const templates = (cfg && cfg.masterConfigTemplates) || [];

    // overwrite:true + same name → reuse existing entry (preserves id + createdAt)
    const v = masterConfigTemplates.validateName(req.body && req.body.name);
    if (!v.ok) return res.status(400).json({ error: v.error });

    // Find existing entry with same name (case-insensitive). excludeId=null because POST never edits an existing id.
    const existingByName = templates.find((t) => t && masterConfigTemplates.isNameTaken([t], v.name, null));

    if (existingByName) {
      if (req.body && req.body.overwrite === true) {
        // Update existing entry's settings (preserve id + createdAt)
        const idx = templates.indexOf(existingByName);
        const { settings, dropped } = masterConfigTemplates.sanitizeSettings(req.body && req.body.settings);
        if (Object.keys(settings).length === 0) {
          return res.status(400).json({ error: 'ต้องมีอย่างน้อย 1 field ใน settings' });
        }
        const updated = await AppConfig.findOneAndUpdate(
          { key: 'singleton' },
          { $set: {
            [`masterConfigTemplates.${idx}.settings`]: settings,
            [`masterConfigTemplates.${idx}.updatedAt`]: new Date(),
          } },
          { new: true, upsert: true }
        ).lean();
        const entry = (updated.masterConfigTemplates || [])[idx];
        logger.info({ botId: null, id: existingByName.id, name: v.name, dropped }, 'admin: master-config-template overwritten');
        return res.json({ ok: true, template: entry, droppedFields: dropped, total: (updated.masterConfigTemplates || []).length });
      }
      return res.status(409).json({ error: `ชื่อ "${v.name}" มีอยู่แล้ว`, existingId: existingByName.id });
    }

    // New entry path
    if (templates.length >= masterConfigTemplates.MAX_TEMPLATES) {
      return res.status(400).json({ error: `ถึงขีดจำกัด ${masterConfigTemplates.MAX_TEMPLATES} templates แล้ว — กรุณาลบของเก่าก่อน` });
    }
    const { settings, dropped } = masterConfigTemplates.sanitizeSettings(req.body && req.body.settings);
    if (Object.keys(settings).length === 0) {
      return res.status(400).json({ error: 'ต้องมีอย่างน้อย 1 field ใน settings' });
    }
    const entry = masterConfigTemplates.buildEntry({ name: v.name, settings });
    const updated = await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $push: { masterConfigTemplates: entry } },
      { new: true, upsert: true }
    ).lean();
    logger.info({ botId: null, id: entry.id, name: entry.name, dropped }, 'admin: master-config-template created');
    res.json({ ok: true, template: entry, droppedFields: dropped, total: (updated.masterConfigTemplates || []).length });
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: POST master-config-templates failed');
    res.status(500).json({ error: err.message });
  }
});

// Update — body: { name?, settings? } (at least one required).
router.put('/master-config-templates/:id', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    const templates = (cfg && cfg.masterConfigTemplates) || [];
    const idx = masterConfigTemplates.findIndexById(templates, req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'template not found' });

    const update = { updatedAt: new Date() };
    if (req.body && req.body.name !== undefined) {
      const v = masterConfigTemplates.validateName(req.body.name);
      if (!v.ok) return res.status(400).json({ error: v.error });
      if (masterConfigTemplates.isNameTaken(templates, v.name, req.params.id)) {
        return res.status(409).json({ error: `ชื่อ "${v.name}" มีอยู่แล้ว` });
      }
      update.name = v.name;
    }
    if (req.body && req.body.settings !== undefined) {
      const { settings, dropped } = masterConfigTemplates.sanitizeSettings(req.body.settings);
      if (Object.keys(settings).length === 0) {
        return res.status(400).json({ error: 'ต้องมีอย่างน้อย 1 field ใน settings' });
      }
      update.settings = settings;
      logger.info({ id: req.params.id, dropped }, 'admin: master-config-template settings updated');
    }
    if (!update.name && !update.settings) {
      return res.status(400).json({ error: 'ต้องส่ง name หรือ settings อย่างน้อย 1 อย่าง' });
    }

    // Build positional $set
    const setOps = {
      [`masterConfigTemplates.${idx}.updatedAt`]: update.updatedAt,
    };
    if (update.name) setOps[`masterConfigTemplates.${idx}.name`] = update.name;
    if (update.settings) setOps[`masterConfigTemplates.${idx}.settings`] = update.settings;

    const updated = await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: setOps },
      { new: true, upsert: true }
    ).lean();
    const newEntry = (updated.masterConfigTemplates || [])[idx];
    logger.info({ id: req.params.id }, 'admin: master-config-template updated');
    res.json({ ok: true, template: newEntry });
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: PUT master-config-templates/:id failed');
    res.status(500).json({ error: err.message });
  }
});

// Delete
router.delete('/master-config-templates/:id', requireAuth, async (req, res) => {
  try {
    const updated = await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $pull: { masterConfigTemplates: { id: req.params.id } } },
      { new: true, upsert: true }
    ).lean();
    const remaining = (updated.masterConfigTemplates || []).length;
    logger.info({ id: req.params.id, remaining }, 'admin: master-config-template deleted');
    res.json({ ok: true, remaining });
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: DELETE master-config-templates/:id failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── Config Backup & Restore (FIX-2026-08-29) ──────────────────────────
// 4 routes — all requireAuth only (per 2026-08-24 admin policy).
// License gate: features.configBackup (default ON for legacy licenses).
// Sections: apiKeys, telegram, appConfig, positions, bots, license (readonly), others.

function _checkConfigBackupLicense(res) {
  if (!licenseService.isFeatureEnabled('configBackup')) {
    res.status(403).json({ error: 'feature-disabled', feature: 'configBackup' });
    return false;
  }
  return true;
}

router.get('/config/backup/preview', requireAuth, async (req, res) => {
  if (!_checkConfigBackupLicense(res)) return;
  try {
    const preview = await configBackup.previewBackupPayload();
    logger.info({ totalSize: preview.totalSizeBytes }, 'admin: GET config/backup/preview');
    res.json(preview);
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: GET config/backup/preview failed');
    res.status(500).json({ error: err.message });
  }
});

router.post('/config/backup', requireAuth, async (req, res) => {
  if (!_checkConfigBackupLicense(res)) return;
  try {
    const sectionsRaw = req.body && req.body.sections;
    if (sectionsRaw !== undefined && !Array.isArray(sectionsRaw)) {
      return res.status(400).json({ error: 'sections must be an array or omitted' });
    }
    const sections = Array.isArray(sectionsRaw) ? sectionsRaw : null;
    const payload = await configBackup.buildBackupPayload({ sections: sections || undefined });
    const sizeBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (sizeBytes > configBackup.MAX_BACKUP_BYTES) {
      return res.status(413).json({ error: `backup too large: ${sizeBytes} bytes (max ${configBackup.MAX_BACKUP_BYTES})` });
    }
    logger.info({ sections: sections || 'all', sizeBytes }, 'admin: POST config/backup');
    res.json({ ok: true, payload, sizeBytes });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    logger.warn({ err: err.message }, 'admin: POST config/backup failed');
    res.status(500).json({ error: err.message });
  }
});

router.post('/config/restore/preview', requireAuth, async (req, res) => {
  if (!_checkConfigBackupLicense(res)) return;
  try {
    const payload = req.body && req.body.payload;
    const sectionsRaw = req.body && req.body.sections;
    if (sectionsRaw !== undefined && !Array.isArray(sectionsRaw)) {
      return res.status(400).json({ error: 'sections must be an array or omitted' });
    }
    const sections = Array.isArray(sectionsRaw) ? sectionsRaw : null;
    if (!payload) return res.status(400).json({ error: 'missing payload' });
    const v = configBackup.parseBackupPayload(payload);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const preview = await configBackup.previewRestorePayload(v.payload, sections || undefined);
    logger.info({ sections: sections || 'all' }, 'admin: POST config/restore/preview');
    res.json(preview);
  } catch (err) {
    logger.warn({ err: err.message }, 'admin: POST config/restore/preview failed');
    res.status(500).json({ error: err.message });
  }
});

router.post('/config/restore', requireAuth, async (req, res) => {
  if (!_checkConfigBackupLicense(res)) return;
  try {
    const payload = req.body && req.body.payload;
    const sectionsRaw = req.body && req.body.sections;
    if (sectionsRaw !== undefined && !Array.isArray(sectionsRaw)) {
      return res.status(400).json({ error: 'sections must be an array or omitted' });
    }
    const sections = Array.isArray(sectionsRaw) ? sectionsRaw : null;
    const mode = (req.body && req.body.mode) || 'merge';
    const dryRun = !!(req.body && req.body.dryRun);
    if (!payload) return res.status(400).json({ error: 'missing payload' });
    if (mode !== 'replace' && mode !== 'merge') {
      return res.status(400).json({ error: `mode must be 'replace' or 'merge' (got '${mode}')` });
    }
    const v = configBackup.parseBackupPayload(payload);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const result = await configBackup.applyRestore({
      payload: v.payload,
      sections: sections || undefined,
      mode,
      dryRun,
    });
    if (!dryRun) {
      try { eventBus.emit('admin:config-restored', { sections: sections || 'all', mode, machineId: v.payload.machineId }); } catch (_) { /* ignore */ }
    }
    logger.info({ sections: sections || 'all', mode, dryRun, results: result.results }, 'admin: POST config/restore');
    res.json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    logger.warn({ err: err.message }, 'admin: POST config/restore failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
