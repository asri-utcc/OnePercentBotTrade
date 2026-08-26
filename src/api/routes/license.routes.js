'use strict';

/**
 * FIX-2026-08-26 Phase 3a: License info endpoint
 *
 *   Exposes the bot's current license state (already in process memory via
 *   licenseGate) to authenticated clients for the Settings page UI.
 *
 *   GET /api/license/info        — current cached license + lastValidatedAt
 *   POST /api/license/refresh    — re-run validate() now (returns fresh payload)
 *
 *   requireAuth: yes — license details are private to the operator.
 */

const express = require('express');
const licenseGate = require('../../admin-monitor/licenseGate');
const config = require('../../admin-monitor/config');
const { getMachineId } = require('../../admin-monitor/machineId');
const fxService = require('../../services/fxService'); // for THB conversion helper
const rootLogger = require('../../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'license-routes' }) : rootLogger;

const router = express.Router();

function _payload() {
  const license = licenseGate.lastLicense;
  const lastValidatedAt = licenseGate.lastValidatedAt;
  const adminMonitorEnabled = !!(config.enabled && config.licenseKey);
  return {
    license: license || null, // null when admin disabled / not yet validated
    lastValidatedAt: lastValidatedAt || null,
    adminMonitorEnabled,
    machineId: getMachineId(),
  };
}

router.get('/info', (_req, res) => {
  try {
    res.json(_payload());
  } catch (err) {
    logger.error({ err: err.message }, 'license-routes: info failed');
    res.status(500).json({ error: 'license_info_failed' });
  }
});

router.post('/refresh', async (_req, res) => {
  if (!config.enabled || !config.licenseKey) {
    return res.status(400).json({ error: 'admin_monitor_disabled' });
  }
  try {
    // validate() updates _lastValidLicense + _lastValidatedAt on success
    await licenseGate.validate({ throwOnFail: false });
    res.json(_payload());
  } catch (err) {
    logger.warn({ err: err.message }, 'license-routes: refresh failed');
    res.status(err.status || 500).json({ error: 'license_refresh_failed', message: err.message });
  }
});

module.exports = router;
