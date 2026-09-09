'use strict';

/**
 * FIX-2026-09-09: OneClick Update — auth gates for update endpoints.
 *
 *   `/api/app/update-status` and `/api/app/apply-update` must only work for
 *   locally logged-in admins (NOT public, NOT license-key-only — license key
 *   alone shouldn't expose update control to a friend's machine if their
 *   local web UI is exposed).
 *
 *   Reuses the existing session-auth check pattern from src/app.js (line 224):
 *     if (!req.session || !req.session.authenticated) return res.status(401)
 *   But we also forbid update operations while another update is in flight.
 */

const orchestrator = require('../services/updateOrchestrator');

function requireSessionAuth(req, res, next) {
  if (!req.session || !req.session.authenticated) {
    return res.status(401).json({ error: 'login required' });
  }
  next();
}

function denyIfBusy(req, res, next) {
  const status = orchestrator.getStatus();
  if (status.inFlight) {
    return res.status(409).json({
      error: 'an update is already in progress',
      state: status.state,
    });
  }
  next();
}

module.exports = {
  requireSessionAuth,
  denyIfBusy,
};
