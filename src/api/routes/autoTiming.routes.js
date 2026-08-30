'use strict';

/**
 * FIX-2026-08-30 / Phase 4: Auto-Timing REST routes
 *
 * Endpoints:
 *   GET   /api/auto-timing/config           — current config + status
 *   PUT   /api/auto-timing/config           — update config (master toggle + knobs) + reload service
 *   POST  /api/auto-timing/run-now          — manual trigger (bypass interval)
 *   GET   /api/auto-timing/status           — live status (running, inFlight, timer, config summary)
 *   GET   /api/auto-timing/cell-matrix      — current 7x24 decision matrix (suppress/limit/etc.)
 *   POST  /api/auto-timing/override-cell    — set per-bot override { day:hour → action }
 *   POST  /api/auto-timing/clear-history    — wipe AutoTimingLifetime (reset Tier 2 cool-downs)
 *   GET   /api/auto-timing/recent-decisions — last N AutoTimingLog entries (debug / debugging UI)
 *
 * Pattern mirror: src/api/routes/autoAddBot.routes.js + bnbAutoBuy.routes.js
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const AppConfig = require('../../db/models/AppConfig');
const Bot = require('../../db/models/Bot');
const AutoTiming = require('../../services/autoTiming');
const AutoTimingLifetime = require('../../db/models/AutoTimingLifetime');
const AutoTimingLog = require('../../db/models/AutoTimingLog');
const { getDefaultBandsClone, validateBandOverride, VALID_ACTIONS } = require('../../core/autoTimingDefaults');
const { HOLD_BANDS } = require('../../core/holdBands');
const { aggregateByCell } = require('../../services/autoTiming');
const Trade = require('../../db/models/Trade');
const logger = require('../../utils/logger');

const router = express.Router();

// Whitelist of fields the PUT /config accepts (P2 audit hardening — never trust client keys)
const PUT_FIELDS = [
  'autoTimingEnabled',
  'autoTimingLookbackDays',
  'autoTimingRecentDays',
  'autoTimingRecentWeight',
  'autoTimingNormalWeight',
  'autoTimingSuppressCooldownDays',
  'autoTimingMinTradesEnforce',
  'autoTimingMinTradesShow',
  'autoTimingBands',
  'autoTimingMinNotionalFloorUSDT',
  'autoTimingMaxNotionalCeilingUSDT',
  'autoTimingIntervalMs',
];

// Numeric validators
function boundedNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

// ─── GET /config — current config + service status ────────────────────
router.get('/config', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    const status = AutoTiming.getStatus();
    res.json({
      config: cfg ? extractConfig(cfg) : null,
      status,
      bands: HOLD_BANDS,
      defaultBands: getDefaultBandsClone(),
      validActions: VALID_ACTIONS,
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'autoTiming: GET /config failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /config — update config + reload service ──────────────────────
router.put('/config', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const update = {};
    const errors = [];

    // Master toggle
    if (body.autoTimingEnabled !== undefined) {
      update.autoTimingEnabled = !!body.autoTimingEnabled;
    }
    // Bounded numeric fields
    const numericFields = [
      ['autoTimingLookbackDays', 7, 90],
      ['autoTimingRecentDays', 1, 30],
      ['autoTimingRecentWeight', 1.0, 2.5],
      ['autoTimingNormalWeight', 0.5, 1.5],
      ['autoTimingSuppressCooldownDays', 30, 365],
      ['autoTimingMinTradesEnforce', 1, 100],
      ['autoTimingMinTradesShow', 1, 50],
      ['autoTimingMinNotionalFloorUSDT', 1, 1000],
      ['autoTimingMaxNotionalCeilingUSDT', 10, 10000],
      ['autoTimingIntervalMs', 60_000, 24 * 60 * 60 * 1000],
    ];
    for (const [key, min, max] of numericFields) {
      if (body[key] !== undefined) {
        const v = boundedNumber(body[key], min, max);
        if (v === null) errors.push(`${key} must be a number in [${min},${max}]`);
        else update[key] = v;
      }
    }
    // Bands validation
    if (body.autoTimingBands !== undefined) {
      if (typeof body.autoTimingBands !== 'object' || Array.isArray(body.autoTimingBands)) {
        errors.push('autoTimingBands must be an object keyed by bandId');
      } else {
        const cleanBands = {};
        for (const bandId of Object.keys(body.autoTimingBands)) {
          const raw = body.autoTimingBands[bandId];
          if (!raw || typeof raw !== 'object') {
            errors.push(`bands.${bandId} must be an object`);
            continue;
          }
          const { cleaned, errors: bandErrors } = validateBandOverride(bandId, raw, []);
          if (bandErrors.length > 0) errors.push(...bandErrors);
          else cleanBands[bandId] = Object.assign({ bandId }, cleaned);
        }
        if (Object.keys(cleanBands).length > 0) update.autoTimingBands = cleanBands;
      }
    }
    // Cross-field invariant: floor <= ceiling
    if (update.autoTimingMinNotionalFloorUSDT != null && update.autoTimingMaxNotionalCeilingUSDT != null) {
      if (update.autoTimingMinNotionalFloorUSDT > update.autoTimingMaxNotionalCeilingUSDT) {
        errors.push('Min floor must be ≤ Max ceiling');
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_failed', errors });
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'no_valid_fields' });
    }

    await AppConfig.updateOne({ key: 'singleton' }, { $set: update });
    // Reload engine so live config picks up changes immediately
    try { await AutoTiming.reloadConfig(); } catch (_) { /* non-fatal */ }

    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    res.json({ ok: true, config: cfg ? extractConfig(cfg) : null, status: AutoTiming.getStatus() });
  } catch (err) {
    logger.warn({ err: err.message }, 'autoTiming: PUT /config failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /run-now — manual trigger ────────────────────────────────────
router.post('/run-now', requireAuth, async (req, res) => {
  try {
    const result = await AutoTiming.runOnce({ source: 'manual' });
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.warn({ err: err.message }, 'autoTiming: POST /run-now failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /status — live snapshot ───────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  try {
    res.json({ status: AutoTiming.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /cell-matrix — current 7x24 decision matrix ────────────────────
//   Recomputes the same way runOnce does but returns the matrix for UI display.
//   Does NOT write Tier 2 (read-only).
router.get('/cell-matrix', requireAuth, async (req, res) => {
  try {
    if (!AutoTiming._config) await AutoTiming._loadConfig();
    if (!AutoTiming._config || !AutoTiming._config.enabled) {
      return res.json({ ok: false, reason: 'master_disabled', matrix: null });
    }
    const nowMs = Date.now();
    const sinceMs = nowMs - AutoTiming._config.lookbackDays * 86400_000;
    const trades = await Trade.find({
      sellFilledAt: { $ne: null, $gte: new Date(sinceMs) },
      buyFilledAt: { $ne: null },
    }).select({ buyFilledAt: 1, sellFilledAt: 1, pnlUSDT: 1 }).lean();

    const cellMap = aggregateByCell(trades, AutoTiming._config, nowMs);

    const tier2Docs = await AutoTimingLifetime.find({}).lean();
    const tier2ByCell = new Map();
    for (const d of tier2Docs) tier2ByCell.set(`${d.day}:${d.hour}`, d);

    const { classify } = require('../../core/autoTimingClassifier');
    const matrix = [];
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const cellStats = cellMap.get(`${day}:${hour}`) || {
          bucket: { day, hour }, n: 0, winRate: 0, pnlUSDT: 0, medianHoldMin: 0,
        };
        const tier2 = tier2ByCell.get(`${day}:${hour}`) || null;
        const result = classify(cellStats, tier2, AutoTiming._config, nowMs);
        matrix.push({
          day, hour,
          bandId: result.bandId,
          action: result.action,
          blocked: result.blocked,
          confidence: result.confidence,
          tier2Hit: result.tier2Hit,
          metrics: result.metrics,
        });
      }
    }
    res.json({ ok: true, matrix, generatedAt: nowMs });
  } catch (err) {
    logger.warn({ err: err.message }, 'autoTiming: GET /cell-matrix failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /override-cell — set per-bot override ────────────────────────
//   body: { botId, day, hour, action }
//   action must be in VALID_ACTIONS (or null to clear)
router.post('/override-cell', requireAuth, async (req, res) => {
  try {
    const { botId, day, hour, action } = req.body || {};
    if (!botId) return res.status(400).json({ error: 'botId_required' });
    if (typeof day !== 'number' || day < 0 || day > 6) {
      return res.status(400).json({ error: 'day_must_be_0_to_6' });
    }
    if (typeof hour !== 'number' || hour < 0 || hour > 23) {
      return res.status(400).json({ error: 'hour_must_be_0_to_23' });
    }
    if (action !== null && !VALID_ACTIONS.includes(action)) {
      return res.status(400).json({ error: 'invalid_action', validActions: VALID_ACTIONS });
    }
    const bot = await Bot.findById(botId).select('autoTimingOverrideCell').lean();
    if (!bot) return res.status(404).json({ error: 'bot_not_found' });

    const overrides = (bot.autoTimingOverrideCell && typeof bot.autoTimingOverrideCell === 'object')
      ? Object.assign({}, bot.autoTimingOverrideCell) : {};
    const key = `${day}:${hour}`;
    if (action === null) delete overrides[key];
    else overrides[key] = action;

    await Bot.updateOne({ _id: botId }, { $set: { autoTimingOverrideCell: overrides } });
    res.json({ ok: true, botId, overrides });
  } catch (err) {
    logger.warn({ err: err.message }, 'autoTiming: POST /override-cell failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /clear-history — wipe Tier 2 cool-downs ──────────────────────
router.post('/clear-history', requireAuth, async (req, res) => {
  try {
    const result = await AutoTimingLifetime.deleteMany({});
    res.json({ ok: true, deleted: result.deletedCount || 0 });
  } catch (err) {
    logger.warn({ err: err.message }, 'autoTiming: POST /clear-history failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /recent-decisions — last N AutoTimingLog entries ───────────────
router.get('/recent-decisions', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const botId = req.query.botId || null;
    const filter = {};
    if (botId) filter.botId = String(botId);
    const docs = await AutoTimingLog.find(filter).sort({ ts: -1 }).limit(limit).lean();
    res.json({ ok: true, decisions: docs, count: docs.length });
  } catch (err) {
    logger.warn({ err: err.message }, 'autoTiming: GET /recent-decisions failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── helpers ───────────────────────────────────────────────────────────
function extractConfig(cfg) {
  if (!cfg) return null;
  return {
    autoTimingEnabled: cfg.autoTimingEnabled === true,
    autoTimingLookbackDays: cfg.autoTimingLookbackDays,
    autoTimingRecentDays: cfg.autoTimingRecentDays,
    autoTimingRecentWeight: cfg.autoTimingRecentWeight,
    autoTimingNormalWeight: cfg.autoTimingNormalWeight,
    autoTimingSuppressCooldownDays: cfg.autoTimingSuppressCooldownDays,
    autoTimingMinTradesEnforce: cfg.autoTimingMinTradesEnforce,
    autoTimingMinTradesShow: cfg.autoTimingMinTradesShow,
    autoTimingBands: cfg.autoTimingBands,
    autoTimingMinNotionalFloorUSDT: cfg.autoTimingMinNotionalFloorUSDT,
    autoTimingMaxNotionalCeilingUSDT: cfg.autoTimingMaxNotionalCeilingUSDT,
    autoTimingIntervalMs: cfg.autoTimingIntervalMs,
    autoTimingLastRunAt: cfg.autoTimingLastRunAt,
    autoTimingLastStats: cfg.autoTimingLastStats,
    autoTimingLastError: cfg.autoTimingLastError,
  };
}

// Export whitelist for use in other routes (admin-panel)
router.PUT_FIELDS = PUT_FIELDS;

module.exports = router;
