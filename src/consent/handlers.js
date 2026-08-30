'use strict';

/**
 * FIX-2026-08-26 Phase 2c-v2: Consent Hybrid — transport-agnostic decision core.
 *
 *   Single source of truth for "user made a consent decision". Both the legacy
 *   standalone server (src/consent/web.js on port 6017) and the new Express
 *   routes on the bot's main port (src/api/routes/consent.routes.js, /consent
 *   on 6015) call into this module.
 *
 *   Responsibilities:
 *     - validate the decision
 *     - race-guard against double-clicks (one in-flight write at a time)
 *     - persist to local file via storage.write (atomic tmp+rename)
 *     - best-effort push to admin via api.pushDecision (never blocks the response)
 *     - emit 'decision' event so gateStartup + openSettingsPage can react
 *
 *   Pure logic — no Express / http imports, trivially unit-testable.
 *
 *   Race semantics:
 *     - Two simultaneous recordDecision() calls for the same decision → second
 *       awaits the first; both receive the same result; one write + one push +
 *       one emit.
 *     - Conflicting decisions within ms → last write wins on disk (tmp+rename is
 *       safe). First emit wins the gate (gateStartup uses .once()). recordDecision
 *       logs a warn if previousDecision was just written (<2s) and differs.
 */

const { EventEmitter } = require('events');
const storage = require('./storage');
const api = require('./api');
const text = require('./text');
const adminConfig = require('../admin-monitor/config');
const { getMachineId } = require('../admin-monitor/machineId');
const config = require('./config');
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'consent-handlers' }) : rootLogger;

// ─── module-level state ───────────────────────────────────────────────

const emitter = new EventEmitter();
emitter.setMaxListeners(50); // multiple subscribers in tests + openSettingsPage + gateStartup

let _inFlight = null;        // promise of the current recordDecision call (or null)
let _engaged = false;        // set when user loads /consent or /api/consent/status on 6015
let _lastWriteAt = 0;        // for race-detection warnings
let _lastWriteDecision = null;
let _awaitingReconsent = false;  // FIX-2026-08-30 Phase 3b-7: true between forceReset() and the next recordDecision('accepted')

let _sectionsCache = null;   // sections are static per process (adminMonitorEnabled is stable)

// ─── engagement tracking ──────────────────────────────────────────────

function markEngaged() { _engaged = true; }
function hasEngaged() { return _engaged; }
function _resetEngagedForTest() { _engaged = false; }

// ─── status ───────────────────────────────────────────────────────────

function getStatus() {
  // Match consent/index.js currentStatus() semantics: when consent is disabled,
  // always return 'accepted' so the login overlay never blocks the operator.
  if (!config.enabled) return 'accepted';
  return storage.currentDecision() || 'pending';
}

function getStatusPayload() {
  const decision = getStatus();
  // FIX-2026-08-26 Phase 3a: enrich with decidedAt + source + previousDecision
  //   for the Settings page "Consent" card (read-only audit metadata).
  //   - decidedAt may be null when status='accepted' due to consentEnabled=false
  //     (config.disabled fast-path), in which case the operator never decided anything
  let decidedAt = null;
  let source = null;
  let previousDecision = null;
  if (config.enabled) {
    const r = storage.read();
    if (r.status === 'decided') {
      decidedAt = r.decidedAt || null;
      source = r.source || null;
      previousDecision = r.previousDecision || null;
    }
  }
  return {
    decision,
    consentVersion: config.version,
    adminMonitorEnabled: !!(adminConfig.enabled && adminConfig.licenseKey),
    consentEnabled: !!config.enabled,
    decidedAt,
    source,
    previousDecision,
  };
}

function getSections() {
  if (!_sectionsCache) {
    const adminMonitorEnabled = !!(adminConfig.enabled && adminConfig.licenseKey);
    // text.js exports the buildSections function as its module.exports (not as a named prop)
    const buildSections = text.default || text;
    _sectionsCache = buildSections({ adminMonitorEnabled });
  }
  return _sectionsCache;
}

// ─── record decision ──────────────────────────────────────────────────

async function recordDecision({ decision, source: sourceOverride, port } = {}) {
  if (decision !== 'accepted' && decision !== 'declined') {
    const err = new Error(`invalid decision: ${decision}`);
    err.statusCode = 400;
    throw err;
  }

  // Idempotency: same decision already on disk → no-op
  const current = storage.currentDecision();
  if (current === decision) {
    logger.info({ decision, port }, 'consent-handlers: already decided, no-op');
    return {
      decision,
      previousDecision: current,
      source: 'noop',
      pushed: false,
      alreadyDecided: true,
    };
  }

  // Race guard: serialise concurrent writes
  if (_inFlight) {
    logger.info({ decision, port }, 'consent-handlers: serialising behind in-flight write');
    return _inFlight;
  }

  _inFlight = (async () => {
    const previousDecision = storage.currentDecision();
    const source = sourceOverride || (previousDecision ? 'settings_change' : 'first_run');
    const machineId = getMachineId();

    // Race-warning: a different decision was written <2s ago — log so the operator
    // can spot a misclick on a different port.
    if (_lastWriteAt && (Date.now() - _lastWriteAt) < 2000 && _lastWriteDecision !== decision) {
      logger.warn({
        previous: _lastWriteDecision,
        incoming: decision,
        port, source,
      }, 'consent-handlers: conflicting decisions within 2s — last write wins on disk');
    }

    // 1) Persist locally first (atomic). If this throws, surface the error.
    storage.write({ decision, source, previousDecision });

    _lastWriteAt = Date.now();
    _lastWriteDecision = decision;

    // 2) Best-effort push to admin. Never blocks the HTTP response.
    let pushed = false;
    try {
      pushed = await api.pushDecision({
        machineId,
        decision,
        consentVersion: config.version,
        source,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'consent-handlers: push threw (unexpected)');
    }

    // 3) Emit for gateStartup + openSettingsPage listeners
    const payload = { decision, source, previousDecision, port };
    try { emitter.emit('decision', payload); } catch (err) {
      logger.warn({ err: err.message }, 'consent-handlers: emitter threw');
    }

    logger.info({ decision, source, previousDecision, port, pushed }, 'consent-handlers: decision recorded');
    // FIX-2026-08-30 Phase 3b-7: clear awaiting-reconsent flag on accept (force_reconsent → user accepts)
    if (decision === 'accepted') _awaitingReconsent = false;
    return { decision, previousDecision, source, pushed, alreadyDecided: false };
  })().finally(() => {
    _inFlight = null;
  });

  return _inFlight;
}

/**
 * FIX-2026-08-30 Phase 3b-7: Force re-consent (admin → bot).
 *
 *   Called from commandExecutor's `force_reconsent` handler when admin clicks
 *   the "Force Re-consent" button in Machine Detail.
 *
 *   Steps (idempotent):
 *     1) Delete local consent file → next /api/consent/status returns 'pending'
 *     2) Reset _engaged flag → next /consent page load sets it again
 *     3) Emit 'consent:reconsent_required' → server.js logs + ensures botManager
 *        is paused (commandExecutor already paused, but the listener is the
 *        single source of truth for "paused because consent pending" state).
 *
 *   Does NOT push to admin (admin already knows it queued the command).
 *   Does NOT call recordDecision (no user input yet — we only stage the prompt).
 */
async function forceReset({ source = 'admin_force_reconsent', port } = {}) {
  const del = storage.delete();
  _engaged = false;
  _awaitingReconsent = true;  // FIX-2026-08-30 Phase 3b-7: signal server.js listener to resume botManager on next accept
  try {
    emitter.emit('consent:reconsent_required', {
      source,
      port: port || null,
      fileDeleted: del.ok,
      fileExisted: !!del.existed,
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'consent-handlers: forceReset emitter threw');
  }
  logger.info({
    source, port, fileDeleted: del.ok, fileExisted: !!del.existed, error: del.error,
  }, 'consent-handlers: forceReset');
  return { ok: del.ok, fileDeleted: del.ok, fileExisted: !!del.existed, error: del.error };
}

/**
 * FIX-2026-08-30 Phase 3b-7: Server.js polls this to detect when the user
 *   accepts after a force_reconsent (file was deleted → previousDecision=null
 *   on the next decision, so the standard 'declined→accepted' branch doesn't fire).
 */
function isAwaitingReconsent() { return _awaitingReconsent; }

// ─── exports ──────────────────────────────────────────────────────────

module.exports = {
  emitter,
  getStatus,
  getStatusPayload,
  getSections,
  recordDecision,
  forceReset,
  isAwaitingReconsent,
  markEngaged,
  hasEngaged,
  // for tests
  _resetEngagedForTest,
};