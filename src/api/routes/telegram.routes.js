'use strict';

// FIX-2026-07-24: Telegram configuration + test endpoints
//   - token encrypted AES-256-GCM ผ่าน src/services/crypto.js
//   - ทุก PUT/DELETE เรียก notifier.reloadConfig() เพื่อ invalidate cache ทันที
//   - ไม่ใช้ requireBotActionPassword (เป็น config ไม่ใช่ destructive action)

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const AppConfig = require('../../db/models/AppConfig');
const { encrypt, decrypt } = require('../../services/crypto');
const notifier = require('../../services/telegramNotifier');
const qualityIndicator = require('../../core/qualityIndicator'); // FIX-2026-08-01: settings block lives in same /config endpoint
const logger = require('../../utils/logger');

const router = express.Router();

// GET /api/telegram/config — return config (ไม่คืน token)
router.get('/config', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    res.json({
      chatId: (cfg && cfg.telegramChatId) || '',
      events: (cfg && cfg.telegramEvents) || {},
      // 2026-08-09: expose telegramLogin toggle (alternative login channel — NOT 2FA)
      //   - default true (mirror AppConfig schema default)
      telegramLogin: (cfg && cfg.telegramEvents && typeof cfg.telegramEvents.telegramLogin === 'boolean')
        ? cfg.telegramEvents.telegramLogin
        : true,
      thresholds: (cfg && cfg.telegramThresholds) || {},
      enabled: !!(cfg && cfg.telegramEnabled),
      hasToken: !!(cfg && cfg.telegramBotTokenEnc),
      // FIX-2026-08-01: Bot Quality Indicator settings (mirror telegramThresholds pattern)
      //   - qualityEnabled: default true (mirror schema default — undefined doc fields → true)
      //   - qualityRefreshMs: default 5 min
      //   - qualityThresholds: spread defaults if doc field is empty/missing
      qualityEnabled:    cfg && typeof cfg.qualityEnabled === 'boolean' ? cfg.qualityEnabled : true,
      qualityRefreshMs:  (cfg && Number.isFinite(cfg.qualityRefreshMs)) ? cfg.qualityRefreshMs : 5 * 60 * 1000,
      qualityThresholds: Object.assign(
        { volumeMinUSDT: 100000, topN: 50, kcTightPct: 1.0, squeezeMinPct: 40, trendMinPct: 50 },
        (cfg && cfg.qualityThresholds) || {},
      ),
      // FIX-2026-08-08: CB Version (global setting — Feature #2)
      //   - 'v2' = CBv2 only (4 red candles below lowerKC → cooldown)
      //   - 'v3' = CBv2 + ST3 same-candle on upper-TF (default)
      cbVersion: (cfg && cfg.cbVersion) || 'v3',
      // FIX-2026-08-08: Auto Delete Bot (global setting — Feature #5)
      autoDeleteBotEnabled:   !!(cfg && cfg.autoDeleteBotEnabled),
      autoDeleteBotDays:      (cfg && Number.isFinite(cfg.autoDeleteBotDays)) ? cfg.autoDeleteBotDays : 30,
      autoDeleteBotWarningDays: (cfg && Number.isFinite(cfg.autoDeleteBotWarningDays)) ? cfg.autoDeleteBotWarningDays : 3,
      autoDeleteBotLastRunAt: (cfg && cfg.autoDeleteBotLastRunAt) || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/telegram/config — update chatId + events + thresholds + enabled
router.put('/config', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const update = {};
    if (typeof body.chatId === 'string') update.telegramChatId = body.chatId.trim();
    if (body.events && typeof body.events === 'object' && !Array.isArray(body.events)) {
      update.telegramEvents = body.events;
    }
    // 2026-08-09: Telegram Login toggle (alternative login channel)
    //   - รับ top-level `telegramLogin: bool` → merge เข้า telegramEvents
    if (typeof body.telegramLogin === 'boolean') {
      update.telegramEvents = Object.assign(
        {},
        update.telegramEvents || (await AppConfig.findOne({ key: 'singleton' }).lean())?.telegramEvents || {},
        { telegramLogin: body.telegramLogin },
      );
    }
    if (body.thresholds && typeof body.thresholds === 'object' && !Array.isArray(body.thresholds)) {
      update.telegramThresholds = body.thresholds;
    }
    if (typeof body.enabled === 'boolean') update.telegramEnabled = body.enabled;

    // FIX-2026-08-01: Bot Quality Indicator (mirror telegramThresholds pattern)
    let qualityChanged = false;
    if (typeof body.qualityEnabled === 'boolean') {
      update.qualityEnabled = body.qualityEnabled;
      qualityChanged = true;
    }
    if (Number.isFinite(body.qualityRefreshMs)) {
      update.qualityRefreshMs = Math.max(60_000, Math.min(60 * 60 * 1000, body.qualityRefreshMs));
      qualityChanged = true;
    }
    if (body.qualityThresholds && typeof body.qualityThresholds === 'object' && !Array.isArray(body.qualityThresholds)) {
      const t = body.qualityThresholds;
      const clean = {};
      if (Number.isFinite(t.volumeMinUSDT)) clean.volumeMinUSDT = Math.max(0, t.volumeMinUSDT);
      if (Number.isFinite(t.topN)) clean.topN = Math.max(1, Math.min(500, t.topN));
      if (Number.isFinite(t.kcTightPct)) clean.kcTightPct = Math.max(0.01, Math.min(50, t.kcTightPct));
      if (Number.isFinite(t.squeezeMinPct)) clean.squeezeMinPct = Math.max(0, Math.min(100, t.squeezeMinPct));
      if (Number.isFinite(t.trendMinPct)) clean.trendMinPct = Math.max(0, Math.min(100, t.trendMinPct));
      update.qualityThresholds = clean;
      qualityChanged = true;
    }

    // FIX-2026-08-08: CB Version (Feature #2) — global toggle
    if (body.cbVersion === 'v2' || body.cbVersion === 'v3') {
      update.cbVersion = body.cbVersion;
    }
    // FIX-2026-08-08: Auto Delete Bot (Feature #5) — global settings
    if (typeof body.autoDeleteBotEnabled === 'boolean') {
      update.autoDeleteBotEnabled = body.autoDeleteBotEnabled;
    }
    if (Number.isFinite(body.autoDeleteBotDays)) {
      update.autoDeleteBotDays = Math.max(7, Math.min(365, parseInt(body.autoDeleteBotDays, 10)));
    }
    if (Number.isFinite(body.autoDeleteBotWarningDays)) {
      update.autoDeleteBotWarningDays = Math.max(1, Math.min(30, parseInt(body.autoDeleteBotWarningDays, 10)));
    }

    await AppConfig.updateOne({ key: 'singleton' }, { $set: update });
    await notifier.reloadConfig();
    if (qualityChanged) {
      try {
        await qualityIndicator.reloadConfig();
      } catch (qErr) {
        logger.warn({ err: qErr.message }, 'telegram: qualityIndicator.reloadConfig failed (non-fatal)');
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/telegram/token — set encrypted bot token
router.put('/token', requireAuth, async (req, res) => {
  try {
    const token = ((req.body && req.body.token) || '').trim();
    if (!token) return res.status(400).json({ error: 'token required' });
    // Telegram bot token format: <bot_id>:<35+ chars>; allow common shapes
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
      return res.status(400).json({ error: 'Invalid bot token format (expected "<id>:<35+ alphanumeric chars>")' });
    }
    const enc = encrypt(token);
    await AppConfig.updateOne(
      { key: 'singleton' },
      { $set: {
        telegramBotTokenEnc: enc.ciphertext,
        telegramBotTokenIv: enc.iv,
        telegramBotTokenAuthTag: enc.authTag,
      } },
    );
    await notifier.reloadConfig();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/telegram/token — clear token + disable
router.delete('/token', requireAuth, async (req, res) => {
  try {
    await AppConfig.updateOne(
      { key: 'singleton' },
      { $set: {
        telegramBotTokenEnc: '',
        telegramBotTokenIv: '',
        telegramBotTokenAuthTag: '',
        telegramEnabled: false,
      } },
    );
    await notifier.reloadConfig();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/telegram/test — send a test message to chatId
router.post('/test', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (!cfg || !cfg.telegramBotTokenEnc) {
      return res.status(400).json({ error: 'Bot token not set' });
    }
    const chatId = ((req.body && req.body.chatId) || cfg.telegramChatId || '').trim();
    if (!chatId) {
      return res.status(400).json({ error: 'chatId required' });
    }
    let token;
    try {
      token = decrypt({
        ciphertext: cfg.telegramBotTokenEnc,
        iv: cfg.telegramBotTokenIv,
        authTag: cfg.telegramBotTokenAuthTag,
      });
    } catch (err) {
      return res.status(500).json({ error: 'Token decrypt failed — encryption key may have changed' });
    }
    // Direct send (ไม่ผ่าน notifier เพราะอาจจะยังไม่ enabled)
    const body = JSON.stringify({
      chat_id: chatId,
      text: '🔔 OnePercentBotTrade test message',
      disable_web_page_preview: true,
    });
    const result = await new Promise((resolve) => {
      const r = require('https').request({
        method: 'POST',
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 8000,
      }, (resp) => {
        let buf = '';
        resp.on('data', (c) => (buf += c));
        resp.on('end', () => resolve({ status: resp.statusCode, body: buf }));
      });
      r.on('error', (err) => resolve({ status: 0, body: err.message }));
      r.on('timeout', () => { r.destroy(new Error('timeout')); });
      r.write(body);
      r.end();
    });
    if (result.status >= 200 && result.status < 300) {
      return res.json({ ok: true });
    }
    let parsed = null;
    try { parsed = JSON.parse(result.body); } catch (e) { /* keep null */ }
    return res.status(502).json({
      error: 'Telegram API error',
      status: result.status,
      detail: parsed ? parsed.description : result.body.slice(0, 200),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'telegram test endpoint failed');
    res.status(500).json({ error: err.message });
  }
});

// FIX-2026-07-24: debug endpoint — trigger trade:update event ใน context ของ running process
//   ใช้ทดสอบว่า telegramNotifier handler ทำงาน (เพราะ script แยก process จะ share eventBus ไม่ได้)
//   body: { tradeId?: string, state: 'filled'|'holding'|'sold' }
//   - ถ้าไม่ส่ง tradeId → หา trade ล่าสุดที่ตรงเงื่อนไข
router.post('/debug/trigger', requireAuth, async (req, res) => {
  try {
    const eventBus = require('../../services/eventBus');
    const Trade = require('../../db/models/Trade');
    const { tradeId, state = 'sold' } = req.body || {};
    let id = tradeId;
    if (!id) {
      const filter = state === 'sold' ? { state: 'sold' }
        : state === 'filled' ? { state: { $in: ['selling', 'filled', 'holding'] }, buyFilledAt: { $ne: null } }
        : { state: 'holding' };
      const t = await Trade.findOne(filter).sort({ updatedAt: -1, createdAt: -1 }).lean();
      if (!t) return res.status(404).json({ error: `no trade found for state=${state}` });
      id = t._id;
    }
    logger.info({ tradeId: String(id), state }, 'telegram: debug trigger emit trade:update');
    eventBus.emit('trade:update', { tradeId: id, state });
    res.json({ ok: true, tradeId: id, state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
