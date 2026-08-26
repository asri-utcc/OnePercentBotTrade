'use strict';

/**
 * FIX-2026-08-26 Phase 2c-v2: Consent routes on bot's main port (6015)
 *
 *   Mounted at /api/consent (JSON + POSTs) and as a top-level GET /consent (HTML).
 *   All routes are PUBLIC (no requireAuth) — consent must be reachable pre-login
 *   so the first-run overlay on /login.html can work.
 *
 *   Returns JSON to fetch-based clients and HTML to native form posts (mirrors
 *   the 6017 standalone server's UX). Same status payload semantics as
 *   handlers.getStatusPayload():
 *     { decision, consentVersion, adminMonitorEnabled, consentEnabled }
 *
 *   Rate limit: 5 POSTs/min per IP (in-memory) since the routes are unauthenticated
 *   and may be LAN-exposed.
 */

const express = require('express');
const handlers = require('../../consent/handlers');
const storage = require('../../consent/storage');
const { pageHtml } = require('../../consent/html');
const rootLogger = require('../../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'consent-routes' }) : rootLogger;

const router = express.Router();

// Light in-memory rate limit on POSTs (defence vs unauthenticated abuse)
const POST_LIMIT = 5; // per minute per IP
const _postTimestamps = new Map(); // ip -> [ts,...]
function _checkPostLimit(ip) {
  const now = Date.now();
  const win = 60_000;
  const arr = (_postTimestamps.get(ip) || []).filter((t) => now - t < win);
  if (arr.length >= POST_LIMIT) return false;
  arr.push(now);
  _postTimestamps.set(ip, arr);
  return true;
}

// Page handler — mounted at top-level GET /consent (registered separately in app.js)
// to bypass the auth-gating static catch-all. We render the same pageHtml as the
// legacy 6017 server, but with actionBase='/api/consent' so the form posts here.
function pageHandler(req, res) {
  try {
    handlers.markEngaged();
    const sections = handlers.getSections();
    const current = storage.currentDecision();
    const html = pageHtml({
      sections,
      currentDecision: current,
      actionBase: '/api/consent',
    });
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.status(200).type('html').send(html);
  } catch (err) {
    logger.error({ err: err.message }, 'consent-routes: page render failed');
    res.status(500).type('text/plain').send('Internal Server Error');
  }
}

// GET /api/consent/status — JSON status for login.html + polling
router.get('/status', (req, res) => {
  try {
    handlers.markEngaged();
    res.json(handlers.getStatusPayload());
  } catch (err) {
    logger.error({ err: err.message }, 'consent-routes: status failed');
    res.status(500).json({ error: 'status_failed' });
  }
});

// Helper: respond to POSTs (JSON or HTML depending on Accept header)
function _respondDecision(req, res, decision) {
  if ((req.headers.accept || '').includes('text/html') && !req.headers['x-fetch']) {
    // Native form post — mirror 6017 UX with a banner
    const banner = decision === 'accepted'
      ? { kind: 'success', en: 'Consent accepted. Reloading…', th: 'ยอมรับแล้ว กำลังโหลดใหม่…' }
      : { kind: 'error', en: 'Consent declined. Bot will suspend — no new positions.', th: 'ไม่ยอมรับ บอทจะระงับ — จะไม่เปิบ position ใหม่' };
    const html = pageHtml({
      sections: handlers.getSections(),
      currentDecision: decision,
      decisionBanner: banner,
      actionBase: '/api/consent',
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).type('html').send(html);
  } else {
    // JSON for fetch() callers (login.html poll + scripted clients)
    res.json({ ok: true, decision });
  }
}

// POST /api/consent/accept
router.post('/accept', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!_checkPostLimit(ip)) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  try {
    const result = await handlers.recordDecision({ decision: 'accepted', port: 6015 });
    if (result.alreadyDecided) {
      return res.json({ ok: true, decision: 'accepted', alreadyDecided: true });
    }
    _respondDecision(req, res, 'accepted');
  } catch (err) {
    logger.error({ err: err.message }, 'consent-routes: accept failed');
    res.status(err.statusCode || 500).json({ error: 'accept_failed', message: err.message });
  }
});

// POST /api/consent/decline
router.post('/decline', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!_checkPostLimit(ip)) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  try {
    const result = await handlers.recordDecision({ decision: 'declined', port: 6015 });
    if (result.alreadyDecided) {
      return res.json({ ok: true, decision: 'declined', alreadyDecided: true });
    }
    _respondDecision(req, res, 'declined');
  } catch (err) {
    logger.error({ err: err.message }, 'consent-routes: decline failed');
    res.status(err.statusCode || 500).json({ error: 'decline_failed', message: err.message });
  }
});

module.exports = router;
module.exports.page = pageHandler;