'use strict';

/**
 * 2026-09-02: Share Daily PnL Card — send to Telegram
 * ────────────────────────────────────────────────────────────────────────────
 * Frontend generates SVG card + rasterizes to PNG, then POSTs the PNG as
 * base64 + caption. This route decrypts the user's saved Telegram bot
 * token (AES-256-GCM in AppConfig) and forwards the photo via
 * Telegram Bot API `sendPhoto`.
 *
 * POST /api/share-card/send-telegram
 *   body: { pngBase64: string, caption?: string }
 *   res : { ok: true }  |  { ok: false, error: string }
 *
 * Security:
 *   - requireAuth (session cookie) — only logged-in owner can send
 *   - PNG size cap 4 MB (base64 ~5.5 MB — fits under express.json limit 5 MB)
 *   - caption cap 1024 chars (Telegram limit)
 *   - No token leaks — only used server-side, never echoed
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const AppConfig = require('../../db/models/AppConfig');
const telegramNotifier = require('../../services/telegramNotifier');
const { decrypt } = require('../../services/crypto');
const logger = require('../../utils/logger');

const router = express.Router();

// PNG size cap: 4 MB binary → ~5.5 MB base64 (fits under express.json 5 MB limit)
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const MAX_CAPTION_LEN = 1024;

router.post('/send-telegram', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const pngBase64 = typeof body.pngBase64 === 'string' ? body.pngBase64.trim() : '';
    const caption = typeof body.caption === 'string' ? body.caption.slice(0, MAX_CAPTION_LEN) : '';

    if (!pngBase64) {
      return res.status(400).json({ ok: false, error: 'pngBase64 required' });
    }
    // Strip optional data-URL prefix ("data:image/png;base64,...")
    const cleanBase64 = pngBase64.replace(/^data:image\/\w+;base64,/, '');
    let pngBuffer;
    try {
      pngBuffer = Buffer.from(cleanBase64, 'base64');
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'invalid base64' });
    }
    if (pngBuffer.length === 0) {
      return res.status(400).json({ ok: false, error: 'empty PNG' });
    }
    if (pngBuffer.length > MAX_PNG_BYTES) {
      return res.status(413).json({
        ok: false,
        error: `PNG too large (${(pngBuffer.length / 1024 / 1024).toFixed(2)} MB > 2 MB cap)`,
      });
    }
    // PNG magic-byte sniff
    const magic = pngBuffer.slice(0, 8);
    const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!magic.equals(expected)) {
      return res.status(400).json({ ok: false, error: 'not a valid PNG (magic-byte mismatch)' });
    }

    // Load Telegram config (encrypted token + chatId)
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (!cfg || !cfg.telegramBotTokenEnc) {
      return res.status(400).json({
        ok: false,
        error: 'Telegram bot token not configured — ตั้งค่าได้ที่ Settings → Telegram',
      });
    }
    if (!cfg.telegramChatId) {
      return res.status(400).json({
        ok: false,
        error: 'Telegram chatId not configured',
      });
    }

    let token;
    try {
      token = decrypt({
        ciphertext: cfg.telegramBotTokenEnc,
        iv: cfg.telegramBotTokenIv,
        authTag: cfg.telegramBotTokenAuthTag,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'shareCard: token decrypt failed');
      return res.status(500).json({ ok: false, error: 'token decrypt failed' });
    }
    if (!token) {
      return res.status(500).json({ ok: false, error: 'empty token after decrypt' });
    }

    // Forward to Telegram
    const ok = await telegramNotifier.sendTelegramPhoto(
      token,
      cfg.telegramChatId,
      pngBuffer,
      caption,
    );
    if (ok) {
      logger.info({ captionLen: caption.length, pngBytes: pngBuffer.length }, 'shareCard: photo sent to telegram');
      return res.json({ ok: true });
    }
    return res.status(502).json({ ok: false, error: 'Telegram API rejected (network or auth error)' });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'shareCard: send-telegram failed');
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
