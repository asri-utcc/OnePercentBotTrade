'use strict';

/**
 * Phase 4 CHAT-V2-2026-08-31 — Bot-side attachment upload + serve proxy.
 *
 *   POST /api/chat/attachments        (multipart, requireAuth) — proxy to admin
 *   GET  /api/chat/attachments/:id    (requireAuth)             — proxy to admin
 *   GET  /api/chat/quota              (requireAuth)             — proxy to admin
 *   GET  /api/chat/identity           (requireAuth)             — own color/icon/displayName
 *   PUT  /api/chat/identity           (requireAuth)             — operator sets own color/icon
 *
 * The bot doesn't store files locally — it proxies multipart uploads through to
 * the admin's /api/instances/:machineId/chat/attachments endpoint. The bot
 * then returns the admin's response (with the attachment id) to the client.
 */

const express = require('express');
const http = require('http');
const https = require('https');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { randomUUID } = require('crypto');

const { requireAuth } = require('../middleware/auth');
const AppConfig = require('../../db/models/AppConfig');
const config = require('../../admin-monitor/config');
const { getMachineId } = require('../../admin-monitor/machineId');

const { MAX_ATTACHMENT_BYTES } = require('../../constants/chat');

const router = express.Router();

// Multer for the local receipt — we read it into memory and forward to admin.
const _upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
});

// ─── HTTP helpers (admin proxy) ──────────────────────────────────────────

function _httpJson(method, targetUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(data ? { 'Content-Length': data.length } : {}),
      },
      timeout: 15000,
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, json });
        else {
          const err = new Error(json.message || json.error || `HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          err.body = json;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('admin proxy HTTP timeout')));
    if (data) req.write(data);
    req.end();
  });
}

// Binary stream proxy: pipe admin's raw response (image/file bytes) through to client.
// Used by GET /api/chat/attachments/:id so <img src=...> and downloads work without
// buffering the file in memory.
function _httpProxyBinary(method, targetUrl, rangeHeader, clientRes, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { ...headers, ...(rangeHeader ? { Range: rangeHeader } : {}) },
      timeout: 30000,
    };
    const req = lib.request(opts, (res) => {
      // Copy status + content-type/content-length headers from admin
      const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified'];
      for (const h of passthrough) {
        if (res.headers[h]) clientRes.setHeader(h, res.headers[h]);
      }
      clientRes.status(res.statusCode);
      res.on('error', reject);
      res.pipe(clientRes);
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('admin proxy binary timeout')));
    req.end();
  });
}

function _httpMultipart({ targetUrl, file, fileFieldName, headers }) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const boundary = '----botChatBoundary' + randomUUID().replace(/-/g, '');
    const crlf = '\r\n';

    const head = Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="${fileFieldName}"; filename="${(file.originalname || 'file').replace(/[\r\n"]/g, '_')}"${crlf}` +
      `Content-Type: ${file.mimetype || 'application/octet-stream'}${crlf}${crlf}`,
      'utf8'
    );
    const tail = Buffer.from(`${crlf}--${boundary}--${crlf}`, 'utf8');
    const total = head.length + file.buffer.length + tail.length;

    const opts = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': total,
        ...headers,
      },
      timeout: 30000,
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, json });
        else {
          const err = new Error(json.message || json.error || `HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          err.body = json;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('admin proxy multipart timeout')));
    req.write(head);
    req.write(file.buffer);
    req.write(tail);
    req.end();
  });
}

// ─── POST /api/chat/attachments ──────────────────────────────────────────

router.post('/attachments', requireAuth, (req, res, next) => {
  _upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || 'upload_failed' });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'file required' });
    if (!config.enabled || !config.licenseKey) {
      return res.status(503).json({ ok: false, error: 'admin_disabled' });
    }
    const url = `${config.url}/api/instances/${encodeURIComponent(getMachineId())}/chat/attachments`;
    const { status, json } = await _httpMultipart({
      targetUrl: url,
      file: req.file,
      fileFieldName: 'file',
      headers: { 'X-License-Key': config.licenseKey },
    });
    res.status(status).json(json);
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.body || err.message });
  }
});

// ─── GET /api/chat/attachments/:id ──────────────────────────────────────

router.get('/attachments/:id', requireAuth, async (req, res) => {
  try {
    if (!config.enabled || !config.licenseKey) {
      return res.status(503).json({ ok: false, error: 'admin_disabled' });
    }
    const url = `${config.url}/api/admin/chat/attachments/${encodeURIComponent(req.params.id)}`;
    // FIX 2026-09-01: pipe admin's binary response through (was _httpJson which
    // JSON-parsed a binary stream and corrupted the bytes — images wouldn't load).
    await _httpProxyBinary('GET', url, req.headers.range, res, { 'X-License-Key': config.licenseKey });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.body || err.message });
  }
});

// ─── GET /api/chat/quota ────────────────────────────────────────────────

router.get('/quota', requireAuth, async (req, res) => {
  try {
    if (!config.enabled || !config.licenseKey) {
      return res.json({ used: 0, limit: 5, remaining: 5, resetAt: null, adminDisabled: true });
    }
    const url = `${config.url}/api/admin/chat/attachments-quota?machineId=${encodeURIComponent(getMachineId())}`;
    const r = await _httpJson('GET', url, null, { 'X-License-Key': config.licenseKey });
    res.status(r.status).json(r.json);
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.body || err.message });
  }
});

// ─── GET /api/chat/identity ─────────────────────────────────────────────

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

// ─── PUT /api/chat/identity ─────────────────────────────────────────────

router.put('/identity', requireAuth, async (req, res) => {
  try {
    const { color, icon } = req.body || {};
    const update = {};
    if (color !== undefined) update.chatColor = String(color || '').slice(0, 16);
    if (icon !== undefined) update.chatIcon = String(icon || '').slice(0, 8);
    if (Object.keys(update).length === 0) return res.status(400).json({ ok: false, error: 'no fields' });
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