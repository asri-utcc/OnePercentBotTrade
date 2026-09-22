'use strict';

/**
 * FIX-2026-09-22: AppConfig schema self-heal — repair out-of-range numeric fields.
 *
 * Background:
 *   - On 2026-09-17, scripts/pause-sweeper.js set orphanSellMaxAgeHours=999999 on
 *     BOTH owner + faiz DBs via raw mongo write (intentionally bypassing Mongoose
 *     schema `max: 168`) to disable the orphan-SELL sweeper during emergency rollback.
 *   - MongoDB stored 999999 happily (Mongo is schemaless at the storage layer).
 *   - Any subsequent route that did `AppConfig.findOne().save()` then threw
 *     `AppConfig validation failed: orphanSellMaxAgeHours (999999) is more than
 *     maximum allowed value (168)` — even though the route only touched unrelated
 *     fields like `botActionPassword`. Example: POST /api/auth/sync-bot-action-password.
 *
 * Fix layers (this file is shared across all three):
 *   1. `clampOutOfRangeNumbers(doc, logger)` — pure helper, called from
 *      AppConfig schema `pre('save')` hook AND from boot-time repair.
 *   2. `repairAppConfig({ AppConfig, logger })` — boots-time scanner that finds
 *      the singleton, applies clamp, persists if anything changed.
 *   3. `scripts/repair-appconfig-bounds.js` — manual rescue (multi-instance).
 *
 * Why schema-level instead of route-level:
 *   - 4 `.save()` callsites in auth.routes.js (setup / change-password /
 *     sync-bot-action-password / useBnbForFees) — easy to miss one when adding new routes.
 *   - Any future Number field with min/max is automatically protected (zero new code).
 *   - Emergency scripts that bypass schema (pause-sweeper.js etc.) can keep doing so
 *     — the schema clamps back silently + emits a warning so operator is aware.
 *
 * Safety contract:
 *   - Never throws (best-effort, callers wrap in try/catch anyway).
 *   - Idempotent: clamping an already-clamped value is a no-op.
 *   - Logs every repair at `warn` level with field name + old → new value.
 *   - Does NOT touch `sweeperEmergencyPaused*` or other marker fields — operator
 *     decides when to unpause (those are intentional emergency-state, not drift).
 */

const REPAIR_VERSION = '2026-09-22';

/**
 * Walk schema paths and clamp any out-of-range Number field to its schema bounds.
 * Mutates `doc` in place (matches Mongoose pre-save hook semantics).
 *
 * @param {object} doc       Mongoose document (or plain object with .schema.paths)
 * @param {object} [opts]
 * @param {object} [opts.logger]   Pino-style logger (warn/info). Defaults to no-op.
 * @param {object} [opts.skipPaths] Set of path names to skip (e.g. emergency markers).
 * @returns {{repaired: Array<{path: string, from: number, to: number, min?: number, max?: number}>}}
 */
function clampOutOfRangeNumbers(doc, opts = {}) {
  const { logger = noopLogger, skipPaths = new Set() } = opts;
  const repaired = [];

  if (!doc || !doc.schema || !doc.schema.paths) {
    return { repaired };
  }

  for (const pathName of Object.keys(doc.schema.paths)) {
    if (skipPaths.has(pathName)) continue;

    const schemaPath = doc.schema.paths[pathName];
    if (!schemaPath || !schemaPath.options) continue;

    // Only Number fields (skip String/Boolean/Date/Object/Array/Mixed)
    if (schemaPath.instance !== 'Number') continue;

    const { min, max } = schemaPath.options;
    if (min == null && max == null) continue;

    const val = doc[pathName];
    if (typeof val !== 'number' || Number.isNaN(val)) continue;

    const belowMin = min != null && val < min;
    const aboveMax = max != null && val > max;
    if (!belowMin && !aboveMax) continue;

    const clamped = Math.max(
      min != null ? min : -Infinity,
      Math.min(max != null ? max : Infinity, val)
    );
    doc[pathName] = clamped;
    repaired.push({ path: pathName, from: val, to: clamped, min: min ?? undefined, max: max ?? undefined });
  }

  if (repaired.length && typeof logger.warn === 'function') {
    logger.warn(
      { version: REPAIR_VERSION, count: repaired.length, repaired },
      'AppConfig: clamped out-of-range numeric fields (likely legacy/emergency-script drift)'
    );
  }

  return { repaired };
}

/**
 * Boot-time / manual-time repair.
 *
 * @param {object} args
 * @param {object} args.AppConfig  Mongoose model (must already be required by caller).
 * @param {object} [args.logger]   Pino-style logger.
 * @param {string} [args.singletonKey='singleton']   Doc key filter.
 * @param {Set}    [args.skipPaths]   Paths to skip (e.g. emergency-state markers).
 * @returns {Promise<{repaired: Array, persisted: boolean, docFound: boolean}>}
 *
 *   - `persisted: false` means nothing needed repair OR repair failed (non-fatal)
 *   - `docFound: false` means no singleton doc yet (fresh deploy — nothing to do)
 *
 * Caller MUST wrap in try/catch — this function intentionally swallows persistence
 * errors and returns `{ repaired, persisted: false, error }` so the boot path stays alive.
 */
async function repairAppConfig({
  AppConfig,
  logger = noopLogger,
  singletonKey = 'singleton',
  skipPaths = DEFAULT_SKIP_PATHS,
} = {}) {
  if (!AppConfig) {
    return { repaired: [], persisted: false, docFound: false, error: 'AppConfig model missing' };
  }

  let doc;
  try {
    doc = await AppConfig.findOne({ key: singletonKey });
  } catch (e) {
    logger.warn({ err: e.message }, 'AppConfig.repair: findOne failed (non-fatal)');
    return { repaired: [], persisted: false, docFound: false, error: e.message };
  }

  if (!doc) {
    return { repaired: [], persisted: false, docFound: false };
  }

  const { repaired } = clampOutOfRangeNumbers(doc, { logger, skipPaths });
  if (!repaired.length) {
    return { repaired: [], persisted: false, docFound: true };
  }

  try {
    // Mark fields as modified — required when re-assigning primitive types on Mongoose docs
    for (const r of repaired) doc.markModified(r.path);
    await doc.save();
    logger.warn(
      { version: REPAIR_VERSION, count: repaired.length, repaired },
      'AppConfig.repair: persisted clamp'
    );
    return { repaired, persisted: true, docFound: true };
  } catch (e) {
    logger.warn(
      { err: e.message, version: REPAIR_VERSION, count: repaired.length },
      'AppConfig.repair: save() failed (non-fatal — pre-save hook will still clamp on next save)'
    );
    return { repaired, persisted: false, docFound: true, error: e.message };
  }
}

// Paths the repair tool will NOT clamp — operator-controlled emergency state.
// These are intentional flags written by emergency scripts, not drift to repair.
const DEFAULT_SKIP_PATHS = new Set([
  'sweeperEmergencyPaused',
  'sweeperEmergencyPausedAt',
  'sweeperEmergencyPauseReason',
]);

const noopLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
};

module.exports = {
  REPAIR_VERSION,
  clampOutOfRangeNumbers,
  repairAppConfig,
  DEFAULT_SKIP_PATHS,
};