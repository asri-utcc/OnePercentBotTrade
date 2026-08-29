'use strict';

/**
 * FIX-2026-08-26: Admin command executor
 *
 * Receives commands from admin (via commandListener) and executes them locally.
 * Signature verification is done in commandListener before reaching here.
 *
 * Supported commands:
 *   - pause:             stop opening new positions (existing positions still managed)
 *   - resume:            re-enable trading
 *   - kill:              graceful shutdown of bot
 *   - force_close_all:   close all open positions immediately (delegate to botManager)
 *   - show_message:      notify user — emit admin:message (→ dashboard toast) + try Telegram
 *   - update_config:     apply a config patch (limited safe keys only)
 *   - revoke_license:    mark license as revoked locally + stop trading
 *
 * FIX-2026-08-27: HMAC verification moved to commandListener (Bug B).
 *   Executor trusts the listener to have already verified.
 */

const config = require('./config');
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'admin-monitor/executor' }) : rootLogger;

/**
 * Command handlers. Each takes (payload, ctx) and returns { ok, result }.
 */
const handlers = {
  async pause(payload, ctx) {
    ctx.botManager?.pause?.(payload?.reason || 'admin_command');
    return { ok: true, action: 'paused' };
  },

  async resume(payload, ctx) {
    ctx.botManager?.resume?.();
    return { ok: true, action: 'resumed' };
  },

  async kill(payload, ctx) {
    logger.warn({ reason: payload?.reason }, 'admin: kill command received — shutting down');
    ctx.botManager?.kill?.();
    // Schedule graceful shutdown
    setTimeout(() => process.exit(0), 1000);
    return { ok: true, action: 'killing' };
  },

  async force_close_all(payload, ctx) {
    const closed = await ctx.botManager?.forceCloseAll?.(payload?.reason || 'admin_command');
    return { ok: true, action: 'force_close_all', closedCount: closed ?? null };
  },

  /**
   * FIX-2026-08-27 Bug A: surface admin messages to the user.
   *   - emits 'admin:message' on eventBus → dashboardWs forwards to all dashboard WS clients
   *     → frontend shows a toast (see public/js/ws-client.js)
   *   - best-effort Telegram send via telegramDirectNotify (only fires if TG configured)
   *   - never throws (telegram failure is logged, not raised)
   */
  async show_message(payload, ctx) {
    const message = String(payload?.message || '');
    const level = (payload?.level === 'warn' || payload?.level === 'error') ? payload.level : 'info';
    logger[level]({ adminMessage: message, payload }, 'admin: message for user');
    ctx.eventBus?.emit?.('admin:message', {
      message,
      level,
      source: 'admin',
      ts: Date.now(),
    });
    // Telegram fallback: if configured, also push to user's TG chat
    try {
      const telegramDirectNotify = require('../services/telegramDirectNotify');
      // Fire-and-forget; sendAdminMessage never throws
      telegramDirectNotify
        .sendAdminMessage(`📨 Admin: ${message}`)
        .then((sent) => {
          if (sent) logger.info({ messageLen: message.length }, 'admin:message → Telegram delivered');
          else logger.info('admin:message → Telegram not configured or send failed (non-fatal)');
        })
        .catch((e) => logger.warn({ err: e.message }, 'admin:message → Telegram throw (non-fatal)'));
    } catch (e) {
      // require() itself failed (rare) — log and continue
      logger.warn({ err: e.message }, 'admin:message → telegramDirectNotify require failed');
    }
    return { ok: true, message, telegramQueued: true };
  },

  async update_config(payload, ctx) {
    // Only allow safe config keys (whitelist)
    const SAFE_KEYS = ['logLevel', 'feature:scanVolatility', 'autoReserveEnabled'];
    const changes = {};
    for (const [k, v] of Object.entries(payload?.config || {})) {
      if (SAFE_KEYS.includes(k)) {
        changes[k] = v;
        ctx.botManager?.setConfig?.(k, v);
      }
    }
    return { ok: true, applied: changes };
  },

  async revoke_license(payload, ctx) {
    logger.error({ reason: payload?.reason }, 'admin: license revoked — stopping bot');
    ctx.botManager?.pause?.('license_revoked');
    ctx.botManager?.setConfig?.('licenseRevoked', true);
    ctx.eventBus?.emit?.('admin:license_revoked', payload);
    return { ok: true, action: 'revoked' };
  },

  /**
   * Phase 4-2026-08-29: chat_message — admin→bot DM or community message.
   *   payload shape: { id, scope, text, displayName, createdAt, fromAdmin: true, toMachineId }
   *   - adds to local ring buffer (admin already canonical; this is a backup path
   *     for the small window between admin POST /api/instances/.../chat/send and the
   *     bot's own chatInbox poll — ensures browser sees it ~immediately).
   *   - emits 'chat:message' on eventBus → dashboardWs broadcasts to all browser tabs.
   */
  async chat_message(payload, ctx) {
    const msg = {
      id: String(payload?.id || ''),
      scope: payload?.scope === 'dm' ? 'dm' : 'community',
      fromAdmin: true,
      fromMachineId: null,
      toMachineId: payload?.toMachineId || null,
      displayName: String(payload?.displayName || 'admin').slice(0, 64),
      text: String(payload?.text || '').slice(0, 2000),
      createdAt: payload?.createdAt || new Date().toISOString(),
    };
    if (!msg.text) {
      logger.warn('admin: chat_message ignored (empty text)');
      return { ok: false, reason: 'empty' };
    }
    try {
      const chatLocalStore = require('../services/chatLocalStore');
      chatLocalStore.addMessage(msg);
    } catch (e) {
      logger.warn({ err: e.message }, 'admin: chat_message localStore add failed');
    }
    ctx.eventBus?.emit?.('chat:message', msg);
    logger.info({
      id: msg.id,
      scope: msg.scope,
      toMachineId: msg.toMachineId ? msg.toMachineId.slice(0, 12) + '...' : null,
      len: msg.text.length,
    }, 'admin: chat_message delivered');
    return { ok: true, action: 'chat_message' };
  },

  // FIX-2026-08-26 Phase 2e: notify user via Telegram about unauthorized state
  //   - sends ad-hoc message to user's TG chat (if configured)
  //   - admin can include 'message' (default contact info) + 'reason' (audit)
  //   - never blocks on TG failure (returns ok:false)
  async notify_unauthorized(payload, ctx) {
    const reason = payload?.reason || 'unspecified';
    const contactInfo = payload?.contactInfo || '082-2621774 (คุณ อัสรี)';
    const customMessage = payload?.message || null;
    const suspendAt = payload?.suspendAt || null; // ISO; when bot will be paused
    const text = customMessage || [
      '⚠️ Your OnePercentBot machine has been flagged as UNAUTHORIZED.',
      `Reason: ${reason}`,
      `Bot will pause new positions at: ${suspendAt || '(already past)'}`,
      '',
      'What to do:',
      `1. Contact the developer: ${contactInfo}`,
      '2. Investigate why your license was flagged',
      '3. Resolve the issue within 24 hours to avoid suspension',
      '',
      'Your existing positions remain open and will be managed by TP/SL as usual.',
      'The bot will only STOP opening NEW positions — your money stays yours.',
    ].join('\n');
    const telegramDirectNotify = require('../services/telegramDirectNotify');
    const sent = await telegramDirectNotify.sendAdminMessage(text);
    return { ok: true, action: 'notify_unauthorized', telegramSent: sent };
  },
};

/**
 * Execute a command. Throws on unsupported type.
 *
 * FIX-2026-08-27: signature verification is the listener's responsibility,
 * not the executor's. We trust the listener.
 */
async function execute(command, ctx = {}) {
  const { commandId, type, payload } = command;

  if (!handlers[type]) {
    throw new Error(`Unknown command type: ${type}`);
  }

  logger.info({
    commandId,
    type,
    hmacSource: config.commandHmacSource,
  }, 'admin-monitor: executing command');

  const result = await handlers[type](payload || {}, ctx);
  logger.info({ commandId, type, result }, 'admin-monitor: command completed');
  return result;
}

module.exports = { execute, handlers };
