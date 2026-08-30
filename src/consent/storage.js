'use strict';

/**
 * FIX-2026-08-26 Phase 2c: Local consent storage
 *
 *   Stores the user's first-run decision (and any later settings change) in a
 *   small JSON file on disk. Defense-in-depth alongside the admin DB record.
 *
 *   Schema:
 *     {
 *       decision: 'accepted' | 'declined',
 *       consentVersion: '1',
 *       decidedAt: ISO8601,
 *       source: 'first_run' | 'settings_change',
 *       previousDecision?: 'accepted' | 'declined' | null,
 *     }
 *
 *   The bot reads this on startup to decide whether to start trading or block
 *   on the consent web page.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'consent-storage' }) : rootLogger;

/**
 * Read the local consent file. Returns:
 *   { status: 'absent' }                          — never decided
 *   { status: 'pending', record }                 — partial write (treat as absent)
 *   { status: 'decided', decision, ...record }    — explicit decision on disk
 */
function read() {
  try {
    if (!fs.existsSync(config.filePath)) return { status: 'absent' };
    const raw = fs.readFileSync(config.filePath, 'utf8');
    const record = JSON.parse(raw);
    if (!record.decision || !['accepted', 'declined'].includes(record.decision)) {
      return { status: 'pending', record };
    }
    return { status: 'decided', ...record };
  } catch (err) {
    logger.warn({ err: err.message, filePath: config.filePath }, 'consent file read failed');
    return { status: 'absent' };
  }
}

/**
 * Persist a decision. Atomic write (tmp + rename) so a crash mid-write can't
 * produce a half-decided file.
 */
function write({ decision, source = 'first_run', previousDecision = null }) {
  const record = {
    decision,
    consentVersion: config.version,
    decidedAt: new Date().toISOString(),
    source,
    previousDecision,
  };
  const tmp = config.filePath + '.tmp';
  fs.mkdirSync(path.dirname(config.filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, config.filePath);
  logger.info({
    decision, source, filePath: config.filePath, version: config.version,
  }, 'consent: local record saved');
}

/**
 * Convenience: returns the current decision or null if not yet decided.
 */
function currentDecision() {
  const r = read();
  return r.status === 'decided' ? r.decision : null;
}

/**
 * FIX-2026-08-30 Phase 3b-7: Force re-consent support.
 *
 *   Delete the local consent file so the bot re-enters first-run state.
 *   - Atomic single-file unlink (no tmp+rename needed for a delete).
 *   - Returns { ok, existed } so callers know if anything actually changed.
 *   - Never throws; logs and returns { ok:false, error } on filesystem failure.
 *
 *   Called by consentHandlers.forceReset() which is invoked from the
 *   commandExecutor's `force_reconsent` handler (admin → bot command queue).
 */
function deleteConsentFile() {
  try {
    if (fs.existsSync(config.filePath)) {
      fs.unlinkSync(config.filePath);
      logger.info({ filePath: config.filePath }, 'consent: local file deleted (force re-consent)');
      return { ok: true, existed: true };
    }
    return { ok: true, existed: false };
  } catch (err) {
    logger.warn({ err: err.message, filePath: config.filePath }, 'consent: delete failed');
    return { ok: false, existed: false, error: err.message };
  }
}

module.exports = { read, write, currentDecision, delete: deleteConsentFile };