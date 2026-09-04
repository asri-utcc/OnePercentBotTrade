'use strict';

/**
 * Phase 4-2026-08-29 — Local chat endpoints for operator UI.
 *
 *   POST /api/chat/send           — enqueue message (community or dm)
 *   GET  /api/chat/history        — load messages from local ring buffer
 *   GET  /api/chat/threads        — list DM threads (v1: single 'admin' thread)
 *   GET  /api/chat/unread         — unread counts for badge
 *   POST /api/chat/read           — mark thread(s) read
 *   GET  /api/chat/display-name   — get current displayName + resolved default
 *   PUT  /api/chat/display-name   — operator sets their own displayName
 *
 *   requireAuth: yes (operator must be logged in)
 *   No CSRF token (same JSON API pattern as other bot endpoints).
 *
 *   Outbox delivery happens in admin-monitor/chatOutbox.js (poller posts to admin).
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const AppConfig = require('../../db/models/AppConfig');
const chatLocalStore = require('../../services/chatLocalStore');
const adminMonitor = require('../../admin-monitor');

const router = express.Router();

const MAX_TEXT_LENGTH = 2000;
const MAX_NAME_LENGTH = 32;
const MAX_COLOR_LENGTH = 16;
const MAX_ICON_LENGTH = 8;

function _badRequest(res, msg) { return res.status(400).json({ error: msg }); }

// POST /api/chat/send — body: { scope: 'community'|'dm', text, clientId?, replyTo?, color?, icon? }
router.post('/send', requireAuth, async (req, res) => {
  try {
    const scope = req.body?.scope === 'dm' ? 'dm' : 'community';
    const text = String(req.body?.text || '').slice(0, MAX_TEXT_LENGTH);
    const replyTo = req.body?.replyTo || null;
    const color = req.body?.color || null;
    const icon = req.body?.icon || null;
    if (!text.trim()) return _badRequest(res, 'text required');
    if (text.length > MAX_TEXT_LENGTH) return _badRequest(res, `text exceeds ${MAX_TEXT_LENGTH}`);
    const clientId = req.body?.clientId ? String(req.body.clientId).slice(0, 80) : undefined;

    if (!adminMonitor.config.enabled) {
      // Admin not enabled — still record locally so the operator sees their own message
      const localId = clientId || require('crypto').randomUUID();
      const nowIso = new Date().toISOString();
      chatLocalStore.addMessage({
        id: localId,
        clientId: localId,
        scope,
        fromAdmin: false,
        fromMachineId: 'local',
        displayName: chatLocalStore.resolveDisplayName(),
        text,
        createdAt: nowIso,
        color, icon, replyTo,
      });
      return res.json({
        ok: true,
        queued: false,
        id: localId,
        message: {
          id: localId,
          clientId: localId,
          scope,
          text,
          displayName: chatLocalStore.resolveDisplayName(),
          createdAt: nowIso,
          color, icon, replyTo,
        },
      });
    }
    const result = adminMonitor.chatOutbox.enqueue({ scope, text, clientId, color, icon, replyTo });
    res.json({ ok: true, queued: true, id: result.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chat/history?scope=community|dm&since=<iso>&limit=50
router.get('/history', requireAuth, (req, res) => {
  const scope = req.query.scope === 'dm' ? 'dm' : 'community';
  const since = req.query.since ? String(req.query.since) : null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const messages = chatLocalStore.getMessages(scope, since, limit);
  res.json({
    scope,
    serverTime: new Date().toISOString(),
    messages,
    cursor: messages.length ? messages[0].createdAt : null, // newest-first, top is newest
  });
});

// GET /api/chat/threads — DM thread summary (v1: single 'admin' thread)
router.get('/threads', requireAuth, (req, res) => {
  // We only have 1 thread in v1 — the admin DM thread
  const unread = chatLocalStore.getUnread('dm');
  const lastDm = chatLocalStore.getMessages('dm', null, 1)[0] || null;
  res.json({
    threads: [
      {
        threadId: 'admin',
        displayName: 'admin',
        lastMessage: lastDm ? lastDm.text : '',
        lastAt: lastDm ? lastDm.createdAt : null,
        lastFromAdmin: lastDm ? !!lastDm.fromAdmin : false,
        unreadCount: unread,
      },
    ],
  });
});

// GET /api/chat/unread — counts for navbar badge
router.get('/unread', requireAuth, (req, res) => {
  res.json(chatLocalStore.getAllUnread());
});

// POST /api/chat/read — body: { scope: 'community'|'dm' }
router.post('/read', requireAuth, (req, res) => {
  const scope = req.body?.scope === 'dm' ? 'dm' : 'community';
  chatLocalStore.markRead(scope);
  res.json({ ok: true, unread: chatLocalStore.getAllUnread() });
});

// GET /api/chat/display-name — current + resolved default
router.get('/display-name', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    chatLocalStore.setDisplayName((cfg && cfg.chatDisplayName) || '');
    res.json({
      displayName: chatLocalStore.getDisplayName(),
      resolved: chatLocalStore.resolveDisplayName(),
      defaultSource: cfg?.chatDisplayName ? 'config' : (chatLocalStore._buffers ? 'fallback' : 'fallback'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/chat/display-name — body: { displayName }
router.put('/display-name', requireAuth, async (req, res) => {
  try {
    const raw = String(req.body?.displayName || '').slice(0, MAX_NAME_LENGTH);
    // Strip control chars + angle brackets (mirror admin sanitize, simpler v1)
    const clean = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/[<>]/g, '').trim();
    if (!clean) return _badRequest(res, 'displayName required');
    if (clean.length > MAX_NAME_LENGTH) return _badRequest(res, `displayName exceeds ${MAX_NAME_LENGTH}`);
    await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: { chatDisplayName: clean } },
      { upsert: true, new: true }
    );
    chatLocalStore.setDisplayName(clean);
    res.json({ ok: true, displayName: clean, resolved: clean });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chat/identity — returns own chat color/icon (moved here 2026-09-04 after
//   attachments feature was removed; previously lived in chatAttachments.routes.js)
router.get('/identity', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    res.json({
      displayName: (cfg && cfg.chatDisplayName) || '',
      color: (cfg && cfg.chatColor) || '',
      icon: (cfg && cfg.chatIcon) || '',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/chat/identity — body: { color?, icon? }
router.put('/identity', requireAuth, async (req, res) => {
  try {
    const { color, icon } = req.body || {};
    const update = {};
    if (color !== undefined) update.chatColor = String(color || '').slice(0, MAX_COLOR_LENGTH);
    if (icon !== undefined) update.chatIcon = String(icon || '').slice(0, MAX_ICON_LENGTH);
    if (Object.keys(update).length === 0) return _badRequest(res, 'no fields');
    const cfg = await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: update },
      { upsert: true, new: true }
    ).lean();
    res.json({
      ok: true,
      color: cfg.chatColor || '',
      icon: cfg.chatIcon || '',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
