'use strict';

/**
 * 2026-09-08: Share Daily PnL Card — send to Telegram (multipart upload)
 * ────────────────────────────────────────────────────────────────────────────
 * Frontend rasterizes SVG card to PNG, then POSTs the PNG as multipart/form-data
 * (binary, not base64) + caption. This route decrypts the user's saved
 * Telegram bot token (AES-256-GCM in AppConfig) and forwards the photo via
 * Telegram Bot API `sendPhoto`.
 *
 * POST /api/share-card/send-telegram   (multipart/form-data)
 *   fields: photo (file, PNG ≤ 2 MB), caption (string ≤ 1024)
 *   res   : { ok: true }  |  { ok: false, error: string }
 *
 * Why multipart (not JSON+base64)?
 *   - Base64 inflates payload by 27% (binary → 4-bit ASCII)
 *   - Was hitting Express body-parser 1 MB limit (HTTP 413) at full 800×1100 @ 0.95 quality
 *   - Multipart passes raw binary to multer memory storage → no overhead
 *   - Telegram's sendPhoto API is multipart-native, so this matches its wire format
 *
 * Security:
 *   - requireAuth (session cookie) — only logged-in owner can send
 *   - multer memory storage + 2 MB hard cap on the photo field
 *   - PNG magic-byte sniff (rejects non-PNG disguised uploads)
 *   - caption cap 1024 chars (Telegram limit)
 *   - No token leaks — only used server-side, never echoed
 */

const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const AppConfig = require('../../db/models/AppConfig');
const telegramNotifier = require('../../services/telegramNotifier');
const { decrypt } = require('../../services/crypto');
const logger = require('../../utils/logger');

const router = express.Router();

// PNG size cap: 2 MB binary (multipart = no base64 overhead)
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MAX_CAPTION_LEN = 1024;

// Multer: memory storage, single file in field "photo"
//   - fileSize limit = MAX_PNG_BYTES (rejects oversized before we read the buffer)
//   - fileFilter accepts PNG mime only (cheap pre-check; magic-byte sniff happens after)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PNG_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'image/png') return cb(null, true);
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'photo must be image/png'));
  },
});

router.post('/send-telegram', requireAuth, (req, res) => {
  // Wrap multer in a promise so async error handling is clean
  upload.single('photo')(req, res, async (multerErr) => {
    if (multerErr) {
      // fileFilter rejection → 400; size limit → 413; other → 500
      if (multerErr instanceof multer.MulterError) {
        if (multerErr.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ ok: false, error: `PNG too large (> ${MAX_PNG_BYTES / 1024 / 1024} MB cap)` });
        }
        return res.status(400).json({ ok: false, error: multerErr.message });
      }
      return res.status(500).json({ ok: false, error: multerErr.message });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: 'photo file required (field name: photo)' });
    }

    const pngBuffer = req.file.buffer;
    const caption = typeof req.body.caption === 'string' ? req.body.caption.slice(0, MAX_CAPTION_LEN) : '';

    // PNG magic-byte sniff (defense in depth — multer already filtered by mime, but a
    // crafted file with .png mime could still be non-PNG bytes)
    const magic = pngBuffer.slice(0, 8);
    const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!magic.equals(expected)) {
      return res.status(400).json({ ok: false, error: 'not a valid PNG (magic-byte mismatch)' });
    }

    try {
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
        logger.info(
          { captionLen: caption.length, pngBytes: pngBuffer.length, mime: req.file.mimetype },
          'shareCard: photo sent to telegram'
        );
        return res.json({ ok: true });
      }
      return res.status(502).json({ ok: false, error: 'Telegram API rejected (network or auth error)' });
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'shareCard: send-telegram failed');
      res.status(500).json({ ok: false, error: err.message });
    }
  });
});

module.exports = router;
