'use strict';

/**
 * FIX-2026-08-26 Phase 2c: Consent gate — public entry point.
 *
 *   Two flows:
 *
 *   1. gateStartup()
 *      Called from server.js AFTER adminMonitor.validateLicense() but BEFORE
 *      botManager.start(). If user has NOT accepted:
 *        - starts the consent web server
 *        - waits for 'decision' event
 *        - if accepted: caller proceeds to start botManager
 *        - if declined: caller skips botManager, keeps server running for
 *          settings access (so user can change mind without restarting)
 *      If user HAS accepted (or consent disabled): resolves immediately.
 *
 *   2. openSettingsPage()
 *      Called from /api/system/consent-settings (admin/CLI) to re-open the
 *      consent server without blocking. Useful when user wants to change
 *      their mind without restarting the bot.
 */

const config = require('./config');
const storage = require('./storage');
const web = require('./web');
const adminConfig = require('../admin-monitor/config');
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'consent' }) : rootLogger;

/**
 * Returns one of: 'accepted' | 'declined' | 'pending'
 */
function currentStatus() {
  if (!config.enabled) return 'accepted'; // consent disabled = always proceed
  return storage.currentDecision() || 'pending';
}

/**
 * Gate the startup. Returns the decision the bot should proceed with:
 *   'accepted'  → caller should start botManager
 *   'declined'  → caller should NOT start botManager (keep web server running)
 */
async function gateStartup() {
  if (!config.enabled) {
    logger.info('consent: disabled via CONSENT_ENABLED — skipping gate');
    return { decision: 'accepted', server: null };
  }

  const decision = storage.currentDecision();
  if (decision === 'accepted') {
    logger.info('consent: previously accepted — proceeding');
    return { decision: 'accepted', server: null };
  }

  // Pending or declined → start web server, wait for explicit decision
  await web.start();

  // If currently declined, the server is already running in "settings" mode
  // (auto-stops in 60s). For first-run (pending), we wait indefinitely until
  // user clicks Accept or Decline.
  if (decision === 'declined') {
    logger.info('consent: previously declined — server open for settings change (60s window)');
    return { decision: 'declined', server: web };
  }

  // Pending: wait for the decision event
  logger.info('consent: pending — block until user decides on web page');
  const result = await new Promise((resolve) => {
    web.once('decision', (payload) => resolve(payload));
  });

  logger.info({ decision: result.decision }, 'consent: user decided');
  return { decision: result.decision, server: web };
}

/**
 * Re-open the consent server in settings mode (already-decided flow).
 * Server auto-stops after 60s if user doesn't interact.
 */
async function openSettingsPage() {
  if (!config.enabled) return null;
  await web.start();
  return web;
}

module.exports = {
  currentStatus,
  gateStartup,
  openSettingsPage,
  web,
};