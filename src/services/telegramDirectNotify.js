'use strict';

/**
 * FIX-2026-08-26 Phase 2e: Telegram direct (one-off) notify
 *
 *   Used by commandExecutor to send ad-hoc messages to the user (e.g.
 *   "your machine has been marked unauthorized; please contact ...")
 *   Bypasses the eventBus subscription pattern because admin-triggered
 *   messages are one-shot, not tied to trading events.
 *
 *   Reads telegram config from AppConfig (same source as telegramNotifier):
 *     telegramEnabled + telegramBotToken (encrypted) + telegramChatId
 *
 *   Returns true if message was sent, false if telegram not configured
 *   or send failed. Never throws.
 */

const https = require('https');
const AppConfig = require('../db/models/AppConfig');
const { decrypt } = require('./crypto');
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'telegram-direct' }) : rootLogger;

const TELEGRAM_API_TIMEOUT_MS = 8000;

async function loadTelegramCreds() {
  try {
    const cfg = await AppConfig.findOne({ key: 'telegram' }).lean();
    if (!cfg || !cfg.telegramEnabled || !cfg.telegramChatId) return null;

    let token = null;
    if (cfg.telegramBotTokenEnc && cfg.telegramBotTokenIv && cfg.telegramBotTokenAuthTag) {
      try {
        token = decrypt({
          ciphertext: cfg.telegramBotTokenEnc,
          iv: cfg.telegramBotTokenIv,
          authTag: cfg.telegramBotTokenAuthTag,
        });
      } catch (err) {
        logger.warn({ err: err.message }, 'telegram-direct: token decrypt failed');
        return null;
      }
    }
    if (!token) return null;
    return { token, chatId: cfg.telegramChatId };
  } catch (err) {
    logger.warn({ err: err.message }, 'telegram-direct: loadConfig failed');
    return null;
  }
}

function sendTelegramOnce(token, chatId, text) {
  return new Promise((resolve) => {
    const payload = { chat_id: chatId, text, disable_web_page_preview: true };
    const body = JSON.stringify(payload);
    const req = https.request({
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: TELEGRAM_API_TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else {
          logger.warn({ status: res.statusCode, body: buf.slice(0, 200) }, 'telegram-direct: sendMessage failed');
          resolve(false);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => {
      logger.warn({ err: err.message }, 'telegram-direct: network error');
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Send an ad-hoc message to the user's Telegram chat (if configured).
 * Returns true on success, false otherwise. Never throws.
 */
async function sendAdminMessage(text) {
  const creds = await loadTelegramCreds();
  if (!creds) {
    logger.info('telegram-direct: not configured (no token/chatId) — message dropped');
    return false;
  }
  const ok = await sendTelegramOnce(creds.token, creds.chatId, text);
  if (ok) logger.info({ textLen: (text || '').length }, 'telegram-direct: sent');
  return ok;
}

module.exports = { sendAdminMessage };