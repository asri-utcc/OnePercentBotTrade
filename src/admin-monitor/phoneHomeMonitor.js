'use strict';

/**
 * FIX-2026-08-26 Phase 2f: Phone-home monitor
 *
 *   Tracks when the bot last successfully contacted the admin server.
 *   If contact is lost for >48h, transitions to PHONE_HOME_DOWN state
 *   and emits 'phonehome:down' on eventBus.
 *
 *   Per user design (position-safety clause 2026-08-26):
 *     - bot will PAUSE (no new positions) when phone-home is down
 *     - existing positions REMAIN OPEN with TP/SL still active
 *     - never force-close positions on disconnect
 *
 *   Tracked events (each updates lastContactAt):
 *     - heartbeat success (adminMonitor.heartbeat._tick success)
 *     - license validate success (adminMonitor.licenseGate.validate success)
 *     - command poll success (adminMonitor.commandListener._poll success)
 *     - snapshot send success
 *
 *   Recovery: any successful contact resets state to UP.
 */

const config = require('./config');
const eventBus = require('../services/eventBus');
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'admin-monitor/phonehome' }) : rootLogger;

const GRACE_HOURS = 48;
const GRACE_MS = GRACE_HOURS * 3600 * 1000;
const WARN_AT_HOURS = 36; // emit 'phonehome:warn' at 36h
const WARN_AT_MS = WARN_AT_HOURS * 3600 * 1000;
const TICK_MS = 5 * 60 * 1000; // 5min check

let lastContactAt = null;
let lastState = null; // 'up' | 'warn' | 'down' | 'never'
let interval = null;

function recordContact(source) {
  const prev = lastContactAt;
  lastContactAt = Date.now();
  if (prev === null) {
    logger.info({ source }, 'phoneHomeMonitor: first contact recorded');
  } else if (lastState === 'down' || lastState === 'warn') {
    logger.info({
      source,
      wasDownSince: prev ? new Date(prev).toISOString() : null,
      gapMs: prev ? Date.now() - prev : null,
    }, 'phoneHomeMonitor: phone-home recovered');
  }
  if (lastState !== 'up') {
    lastState = 'up';
    eventBus.emit('phonehome:up', { source, lastContactAt });
  }
}

function _elapsedSinceContact() {
  if (lastContactAt === null) return Infinity;
  return Date.now() - lastContactAt;
}

/**
 * Public API:
 *   isEnabled():       is admin-monitor enabled?
 *   isPhoneHomeDown(): are we past the 48h grace period?
 *   getLastContactAt(): timestamp of last successful contact (ms) or null
 *   getRemainingMs():  ms remaining before phone-home-down (Infinity if never)
 *   start()/stop():    lifecycle
 */
function isEnabled() {
  return !!(config.enabled && config.licenseKey);
}
function isPhoneHomeDown() {
  if (!isEnabled()) return false; // no admin = no phone-home policy
  if (lastContactAt === null) return false; // never had contact yet → don't punish
  return _elapsedSinceContact() >= GRACE_MS;
}
function getLastContactAt() { return lastContactAt; }
function getRemainingMs() {
  if (lastContactAt === null) return Infinity;
  return Math.max(0, GRACE_MS - _elapsedSinceContact());
}

function _check() {
  if (!isEnabled()) return;
  if (lastContactAt === null) {
    if (lastState !== 'never') {
      lastState = 'never';
      logger.info('phoneHomeMonitor: never contacted (no admin contact since boot)');
    }
    return;
  }
  const elapsed = _elapsedSinceContact();
  if (elapsed >= GRACE_MS) {
    if (lastState !== 'down') {
      lastState = 'down';
      logger.warn({
        elapsedHours: (elapsed / 3600000).toFixed(1),
        graceHours: GRACE_HOURS,
        lastContactAt: new Date(lastContactAt).toISOString(),
      }, 'phoneHomeMonitor: phone-home DOWN — bot will pause new positions');
      eventBus.emit('phonehome:down', {
        lastContactAt,
        elapsedMs: elapsed,
        graceMs: GRACE_MS,
      });
    }
  } else if (elapsed >= WARN_AT_MS) {
    if (lastState !== 'warn') {
      lastState = 'warn';
      logger.warn({
        elapsedHours: (elapsed / 3600000).toFixed(1),
        warnAtHours: WARN_AT_HOURS,
        remainingHours: ((GRACE_MS - elapsed) / 3600000).toFixed(1),
      }, 'phoneHomeMonitor: phone-home degraded (warn threshold)');
      eventBus.emit('phonehome:warn', {
        lastContactAt,
        elapsedMs: elapsed,
        remainingMs: GRACE_MS - elapsed,
      });
    }
  }
}

function start() {
  if (interval) return;
  if (!isEnabled()) {
    logger.info('phoneHomeMonitor: disabled (admin-monitor off)');
    return;
  }
  // listen to eventBus for contact-success events (emitted by heartbeat/command/validate modules)
  eventBus.on('admin:contact_success', (payload) => recordContact(payload?.source || 'unknown'));
  // initial check
  _check();
  interval = setInterval(_check, TICK_MS);
  logger.info({
    graceHours: GRACE_HOURS,
    warnAtHours: WARN_AT_HOURS,
    tickMs: TICK_MS,
  }, 'phoneHomeMonitor: started');
}

function stop() {
  if (interval) {
    clearInterval(interval);
    interval = null;
    logger.info('phoneHomeMonitor: stopped');
  }
}

module.exports = {
  start, stop,
  isEnabled, isPhoneHomeDown,
  getLastContactAt, getRemainingMs,
  recordContact, // expose for direct callers
};