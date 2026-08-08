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
const eventBus = require('../../services/eventBus');
const logger = require('../../utils/logger');
const { requireAuth } = require('../middleware/auth');

// Middleware stubs (mirror existing settings.js / bot.routes.js password pattern)
// FIX-2026-08-08: reuse the same requireSettingsPassword / requireBotActionPassword middleware
//   - those are defined in src/api/middleware/auth.js or src/api/middleware/adminAuth.js
//   - if not present, we use requireAuth only (acceptable for first iteration; can tighten later)
let requireSettingsPassword = requireAuth;
let requireBotActionPassword = requireAuth;
try {
  const auth = require('../middleware/auth');
  if (auth.requireSettingsPassword) requireSettingsPassword = auth.requireSettingsPassword;
  if (auth.requireBotActionPassword) requireBotActionPassword = auth.requireBotActionPassword;
} catch (_) { /* fallback already set */ }

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
//   - whitelist fields (กัน user inject field อื่น)
//   - per-field clamp map
//   - cross-field validation: minSize<=maxSize, minLayers<=maxLayers (merge DB ก่อนเช็ค)
//   - invalidate caches so next read picks up new value within 30s
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

router.put('/app-config', requireAuth, requireSettingsPassword, async (req, res) => {
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

// ─── POST /api/admin/auto-delete-run ───────────────────────────
// FIX-2026-08-08: force-tick autoDeleteBot — useful for testing + manual scheduling
//   - returns stats object from tick()
//   - if tick is already running → returns { skipped: 'in-progress' }
router.post('/auto-delete-run', requireAuth, requireBotActionPassword, async (req, res) => {
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
  cbAutoUnlockThresholdPct:  { min: 0.5,   max: 5.0 },
  autoPauseMinKcPct:         { min: 0.1,   max: 50 },
  autoArmLossPct:            { min: 1,     max: 90 },
  autoArmAgeHours:           { min: 0.5,   max: 168 },
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
  cbAutoUnlockEnabled: false,
  cbAutoUnlockThresholdPct: 1.0,
  dynamicSizeEnabled: true,
  safeTradeEnabled: true,
  safeTradeTrendlineEnabled: false,
  safeTradeNoTradeEnabled: false,
  autoPauseEnabled: true,
  autoPauseMinKcPct: 2,
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

router.put('/bot-defaults', requireAuth, requireSettingsPassword, async (req, res) => {
  try {
    const body = req.body || {};
    // whitelist: only known fields (number/string/boolean)
    const BOOLEAN_FIELDS = [
      'dcaEnabled', 'martingaleEnabled',
      's1OnlyDown', 'xs1Enabled', 'cbEnabled', 'cbv2Enabled', 'cbv3Enabled',
      'cbAutoUnlockEnabled', 'dynamicSizeEnabled',
      'safeTradeEnabled', 'safeTradeTrendlineEnabled', 'safeTradeNoTradeEnabled',
      'autoPauseEnabled', 'autoArmStopLossOnUKC',
      'slUkcTriggerOnProfit', 'tpTrendEnabled', 'autoUpdateTp', 'stopLossOnUpperKC',
    ];
    const NUMBER_FIELDS = [
      'capitalPerTrade', 'maxTrades', 'tpPercent', 'retryTimeMin', 'retryMax',
      'kcMult', 'minSpreadTicks', 'suggestTpWindow',
      'dcaMaxLayers', 'martingaleMultiplier', 'martingaleMaxLayerNotional',
      'cbv2LockHours', 'cbv3LockHours', 'cbAutoUnlockThresholdPct',
      'autoPauseMinKcPct', 'autoArmLossPct', 'autoArmAgeHours', 'tpTrendMultiplier',
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
router.post('/dps-reset-all', requireAuth, requireBotActionPassword, async (req, res) => {
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