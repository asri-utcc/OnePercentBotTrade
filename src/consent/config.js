'use strict';

/**
 * FIX-2026-08-26 Phase 2c: Consent config loader
 *
 * Env vars (set in .env or process.env):
 *   CONSENT_ENABLED       'true' to enable first-run consent screen (default: true)
 *   CONSENT_VERSION       consent text version (audit only, NOT a re-trigger)
 *   CONSENT_WEB_PORT      port for the local consent web server (default: 6017)
 *   CONSENT_WEB_HOST      bind host (default: 127.0.0.1 — safest for settings page)
 *   CONSENT_FILE_PATH     local storage path (default: ~/.onepercentbot-consent.json)
 *   CONSENT_AUTO_OPEN     'true' to auto-open browser on first-run (default: true)
 */

const path = require('path');
const os = require('os');

function _bool(s, def = false) {
  if (s === undefined || s === null || s === '') return def;
  return String(s).toLowerCase() === 'true';
}

function _int(s, def) {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : def;
}

function _expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const config = {
  enabled: _bool(process.env.CONSENT_ENABLED, true),
  version: process.env.CONSENT_VERSION || '1',
  webPort: _int(process.env.CONSENT_WEB_PORT, 6017),
  webHost: process.env.CONSENT_WEB_HOST || '127.0.0.1',
  filePath: _expandHome(process.env.CONSENT_FILE_PATH) || path.join(os.homedir(), '.onepercentbot-consent.json'),
  autoOpen: _bool(process.env.CONSENT_AUTO_OPEN, true),
};

module.exports = config;