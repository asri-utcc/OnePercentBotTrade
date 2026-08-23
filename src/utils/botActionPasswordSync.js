'use strict';

/**
 * FIX-2026-08-10: Sync AppConfig.botActionPassword → runtime config at startup.
 *
 * Why:
 *   - config.botActionPassword is loaded once from .env at startup
 *   - If user changes their login password via /change-password, we ALSO update
 *     AppConfig.botActionPassword + runtime config (see auth.routes.js)
 *   - But after a restart, the runtime config falls back to the .env value
 *     unless we re-read from AppConfig on boot
 *
 * Behavior:
 *   - If AppConfig.botActionPassword is non-empty → override config.botActionPassword
 *   - If AppConfig.botActionPassword is empty → keep .env value (fallback)
 *   - If process.env.BOT_ACTION_PASSWORD is set explicitly → respect it (do NOT
 *     override with AppConfig value, because user explicitly chose a separate password)
 *
 * Caller: src/server.js → right after db.connect() resolves.
 */

const config = require('../../config');
const AppConfig = require('../db/models/AppConfig');
const logger = require('./logger');

/**
 * Apply AppConfig.botActionPassword to runtime config (if conditions allow).
 * @returns {Promise<{applied: boolean, source: 'appconfig'|'env'|'none', value: string}>}
 */
async function syncBotActionPasswordFromAppConfig() {
  try {
    const doc = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (!doc) return { applied: false, source: 'none', value: '' };

    const envExplicit = !!process.env.BOT_ACTION_PASSWORD;
    const dbValue = (doc.botActionPassword || '').trim();

    if (envExplicit) {
      // User set BOT_ACTION_PASSWORD in .env explicitly — don't touch
      return { applied: false, source: 'env', value: config.botActionPassword || '' };
    }
    if (!dbValue) {
      // FIX-2026-08-10: inconsistent state — DB has no botActionPassword yet (login password
      // was changed BEFORE sync fix deployed) → runtime falls back to .env DASHBOARD_PASSWORD
      // (which is the OLD password). User must click "Sync" button in Settings to fix.
      if (config.botActionPassword && (doc.passwordLastChangedAt || doc.passwordSetAt)) {
        logger.warn(
          {
            passwordLastChangedAt: doc.passwordLastChangedAt || doc.passwordSetAt,
            runtimeLen: (config.botActionPassword || '').length,
          },
          'botActionPassword: inconsistent state — AppConfig.botActionPassword empty but login password was changed. ' +
          'Click "Sync Bot Password" in Password & Sessions Manager to backfill.'
        );
      }
      // Nothing in DB — keep .env fallback (DASHBOARD_PASSWORD or empty)
      return { applied: false, source: 'env', value: config.botActionPassword || '' };
    }

    // DB has a value, no explicit .env override → apply
    config.botActionPassword = dbValue;
    logger.info(
      { changedAt: doc.botActionPasswordChangedAt || null },
      'botActionPassword: synced from AppConfig (login password changes will keep this in sync)'
    );
    return { applied: true, source: 'appconfig', value: dbValue };
  } catch (err) {
    logger.warn({ err: err.message }, 'botActionPassword: AppConfig sync failed (non-fatal)');
    return { applied: false, source: 'none', value: '' };
  }
}

module.exports = { syncBotActionPasswordFromAppConfig };