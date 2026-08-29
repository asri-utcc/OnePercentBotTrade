'use strict';

/**
 * FIX-2026-08-26: Admin monitor — entry point
 *
 * Composes heartbeat sender + command listener + license gate.
 * Wired from src/server.js; no-op if ADMIN_ENABLED != 'true'.
 *
 * Usage:
 *   const adminMonitor = require('./admin-monitor');
 *   // Optional: validate license upfront (throws on failure)
 *   await adminMonitor.validateLicense();
 *   adminMonitor.start({
 *     botManager,        // must have: pause, resume, kill, forceCloseAll, setConfig
 *     eventBus,          // optional — for emit('admin:message'|'admin:license_revoked')
 *     getMetrics: () => ({ runningBots, activePositions, ... }),
 *   });
 *
 * If not enabled, start() is a no-op (existing bots are unaffected).
 */

const config = require('./config');
const heartbeat = require('./heartbeat');
const commandListener = require('./commandListener');
const licenseGate = require('./licenseGate');
const snapshotSender = require('./snapshotSender');
const phoneHomeMonitor = require('./phoneHomeMonitor'); // FIX-2026-08-26 Phase 2f
const chatOutbox = require('./chatOutbox');              // Phase 4-2026-08-29
const chatInbox = require('./chatInbox');                  // Phase 4-2026-08-29
const { getMachineId } = require('./machineId');
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'admin-monitor' }) : rootLogger;

/**
 * Validate license with admin. Throws on failure.
 * Call BEFORE botManager.start() if admin-monitor is enabled.
 * If admin-monitor is disabled, this is a no-op (returns null).
 */
async function validateLicense() {
  if (!config.enabled) return null;
  if (!config.licenseKey) {
    const err = new Error('ADMIN_ENABLED=true but ADMIN_LICENSE_KEY missing');
    err.code = 'NO_LICENSE_KEY';
    throw err;
  }
  return licenseGate.validate({ throwOnFail: true });
}

function start({ botManager, eventBus, getMetrics } = {}) {
  if (!config.enabled) {
    logger.info('admin-monitor: disabled (set ADMIN_ENABLED=true to enable)');
    return;
  }
  if (!config.licenseKey) {
    logger.warn('admin-monitor: enabled but ADMIN_LICENSE_KEY missing — skipping');
    return;
  }

  const machineId = getMachineId();
  logger.info({
    machineId: machineId.slice(0, 12) + '...',
    url: config.url,
    heartbeatMs: config.heartbeatMs,
    pollMs: config.pollMs,
    botVersion: config.botVersion,
    customerTag: config.customerTag || '(none)',
  }, 'admin-monitor: starting');

  heartbeat.start({ metricsGetter: getMetrics });
  commandListener.start({ botManager, eventBus });
  licenseGate.start({ botManager });
  snapshotSender.start();
  // FIX-2026-08-26 Phase 2f: phone-home monitor subscribes to admin:contact_success events
  phoneHomeMonitor.start();
  // Phase 4-2026-08-29: Chat outbox/inbox pollers
  chatOutbox.start();
  chatInbox.start();
}

function stop() {
  heartbeat.stop();
  commandListener.stop();
  licenseGate.stop();
  snapshotSender.stop();
  phoneHomeMonitor.stop();
  chatOutbox.stop();
  chatInbox.stop();
  logger.info('admin-monitor: stopped');
}

module.exports = {
  start, stop, config, getMachineId,
  validateLicense, licenseGate,
  chatOutbox, chatInbox,   // Phase 4-2026-08-29
};
