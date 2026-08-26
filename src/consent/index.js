'use strict';

/**
 * FIX-2026-08-26 Phase 2c-v2: Consent gate — public entry point (Hybrid).
 *
 *   Two flows:
 *
 *   1. gateStartup()
 *      Called from server.js AFTER adminMonitor.validateLicense() but BEFORE
 *      botManager.start(). Decision matrix:
 *
 *        - consent disabled (CONSENT_ENABLED != 'true') → 'accepted' immediately
 *        - previously accepted → 'accepted' immediately
 *        - previously declined → 'declined' immediately (no web start — /consent on 6015 is reachable)
 *        - pending (first run):
 *            • log hint URL pointing to bot's main port (6015) at /consent
 *            • arm fallback timer; if user hasn't engaged within `fallbackDelayMs`
 *              (default 60s) and still pending, start 6017 (legacy fallback) so
 *              the user can still decide if they never visited 6015.
 *            • wait for handlers.emitter 'decision' event (resolves on accept/decline)
 *            • clear fallback timer + stop 6017 if it ever started
 *      Returns: { decision: 'accepted'|'declined', server: web | null }
 *
 *   2. openSettingsPage()
 *      Called from /api/system/consent-settings (admin/CLI) to re-open the
 *      consent server on 6017 without blocking. Used when user wants to change
 *      their mind via the dedicated standalone server instead of /consent on 6015.
 */

const config = require('./config');
const storage = require('./storage');
const web = require('./web');
const handlers = require('./handlers');
const botCfg = require('../../config'); // bot-level HOST + PORT for hint URL
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'consent' }) : rootLogger;

/**
 * Returns one of: 'accepted' | 'declined' | 'pending'
 */
function currentStatus() {
  return handlers.getStatus();
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

  if (decision === 'declined') {
    // FIX-2026-08-26 Phase 2c-v2: declined → don't start 6017; the user can flip via /consent on 6015.
    //   server.js subscribes to handlers.emitter for auto-resume on declined→accepted.
    logger.info(
      'consent: previously declined — botManager.start SKIPPED; user can change via /consent'
    );
    return { decision: 'declined', server: null };
  }

  // ─── Pending (first run): Hybrid flow ────────────────────────────────
  const hintHost = (botCfg.host === '0.0.0.0' || botCfg.host === '::') ? '127.0.0.1' : (botCfg.host || '127.0.0.1');
  const hintUrl = `http://${hintHost}:${botCfg.port}/consent`;
  logger.info(
    { hintUrl, fallbackDelayMs: config.fallbackDelayMs },
    'consent: pending — open the URL above to decide (fallback server will start if ignored)'
  );

  // Race the fallback timer against the user decision
  let fallbackTimer = null;
  let fallbackStarted = false;
  const fallbackDelayMs = Number(config.fallbackDelayMs);

  const fallbackArmed = new Promise((resolve) => {
    if (fallbackDelayMs === -1) {
      // -1 = never start fallback
      logger.info('consent: fallback disabled (CONSENT_FALLBACK_DELAY_MS=-1)');
      return;
    }
    fallbackTimer = setTimeout(async () => {
      // Only fire if still pending AND user has not engaged the 6015 endpoint
      const stillPending = handlers.getStatus() === 'pending';
      const notEngaged = !handlers.hasEngaged();
      if (!stillPending) {
        logger.info('consent: fallback skipped (decision already made)');
        return resolve('already_decided');
      }
      if (!notEngaged) {
        logger.info('consent: fallback skipped (user already engaged 6015 /consent)');
        return resolve('engaged');
      }
      try {
        logger.warn(
          { fallbackDelayMs, hintUrl },
          'consent: user did not engage 6015 — starting legacy 6017 fallback'
        );
        await web.start();
        fallbackStarted = true;
        return resolve('fallback_started');
      } catch (err) {
        if (err && err.code === 'EADDRINUSE') {
          logger.warn('consent: fallback EADDRINUSE — 6017 already in use, keeping waiting');
          return resolve('fallback_eaddrinuse');
        }
        logger.error({ err: err.message }, 'consent: fallback start failed (keeping waiting)');
        return resolve('fallback_failed');
      }
    }, fallbackDelayMs);
    // Don't hold the event loop — fallback is best-effort, not required for correctness
    if (fallbackTimer.unref) fallbackTimer.unref();
  });

  // Wait for the user decision (from 6015 OR 6017)
  const decisionPromise = new Promise((resolve) => {
    handlers.emitter.once('decision', (payload) => resolve({ ...payload, viaFallback: fallbackStarted }));
  });

  // Race: first wins, then clean up
  const result = await new Promise((resolve) => {
    let settled = false;
    const settle = (winner) => {
      if (settled) return;
      settled = true;
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      resolve(winner);
    };
    fallbackArmed.then((why) => {
      // Fallback either fired (started/errored) OR was a no-op (already_decided/engaged/-1).
      // Don't resolve unless it actually started 6017 — otherwise we wait for the decision.
      if (why === 'fallback_started' || why === 'fallback_eaddrinuse' || why === 'fallback_failed') {
        // Fallback started (or tried) — keep waiting for the decision event.
        // The decision event will resolve the race.
        logger.debug({ why }, 'consent: fallback outcome — waiting for decision event');
      } else {
        // No fallback needed — wait for decision event.
        logger.debug({ why }, 'consent: no fallback needed — waiting for decision event');
      }
    });
    decisionPromise.then(settle);
  });

  logger.info(
    { decision: result.decision, source: result.source, viaFallback: result.viaFallback },
    'consent: user decided'
  );

  // Stop 6017 if it ever started (it's no longer needed once a decision is recorded)
  if (fallbackStarted) {
    web.stop().catch((err) => logger.warn({ err: err.message }, 'consent: post-decision 6017 stop failed'));
  }

  return { decision: result.decision, server: fallbackStarted ? web : null };
}

/**
 * Re-open the consent server on 6017 in settings mode (already-decided flow).
 * Server auto-stops after 60s if user doesn't interact.
 * Useful when admin wants to nudge the user to re-decide via a separate port.
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