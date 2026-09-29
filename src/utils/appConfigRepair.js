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

/**
 * FIX-2026-09-29: Bootstrap singleton doc with schema defaults if missing.
 *   Runs only when no doc exists (fresh install). Schema-level `default:` factory
 *   functions in AppConfig.js auto-populate every field (including Object types
 *   like autoReserveBtcDrivenPresets, autoTimingBands, telegramEvents, etc.).
 *
 *   - Idempotent: no-op if doc already exists
 *   - Non-fatal: returns { created: false, error } on failure
 *   - Why this matters: without this, the first user request to read AppConfig
 *     (e.g., GET /api/wallet/auto-reserve/btc-driven on a fresh deploy) sees
 *     `null` fields. Frontend falls back to display defaults, but downstream
 *     writes (e.g., PUT presets) hit a real doc without schema defaults applied.
 *     Bootstrapping upfront ensures consistent state from the very first request.
 *
 * @param {object} args
 * @param {object} args.AppConfig  Mongoose model
 * @param {object} [args.logger]   Pino-style logger
 * @returns {Promise<{created: boolean, docFound?: boolean, error?: string}>}
 */
async function bootstrapAppConfigDefaults({ AppConfig, logger = noopLogger } = {}) {
  if (!AppConfig) {
    return { created: false, error: 'AppConfig model missing' };
  }

  let existing;
  try {
    existing = await AppConfig.findOne({ key: 'singleton' }).lean();
  } catch (e) {
    logger.warn({ err: e.message }, 'AppConfig.bootstrap: findOne failed (non-fatal)');
    return { created: false, error: e.message };
  }
  if (existing) {
    return { created: false, docFound: true };
  }

  try {
    const doc = new AppConfig({ key: 'singleton' });
    await doc.save();
    logger.info({ version: '2026-09-29' }, 'AppConfig.bootstrap: singleton created with schema defaults');
    return { created: true, docFound: false };
  } catch (e) {
    logger.warn(
      { err: e.message },
      'AppConfig.bootstrap: save failed (non-fatal — setup wizard will retry)'
    );
    return { created: false, error: e.message };
  }
}

/**
 * FIX-2026-09-29: One-shot migration — split legacy `autoReserveStepUsdt` into
 *   `autoReserveStepReserveUsdt` + `autoReserveStepReleaseUsdt` (round 3).
 *
 * Background:
 *   - Round 2 used single `autoReserveStepUsdt` field for both reserve and release.
 *   - Round 3 splits into 2 direction-specific fields.
 *   - Per memory rule ("existing DB values always WIN — env never overrides"),
 *     we mirror the legacy value to both new fields on boot, IF new fields are missing.
 *   - Legacy field is kept in schema (deprecated) for backward compat with old clients.
 *
 *   FIX-2026-09-29 (round 3 follow-up): if legacy is null/undefined/NaN AND new fields
 *   are missing, fall back to schema default (10) — covers very-old v2.5.x docs that
 *   predate the legacy field. Without this, very-old docs would have null split-step
 *   fields forever (runtime fallback masks it but DB stays inconsistent).
 *
 * Behavior:
 *   - Idempotent: if both new fields already present → no-op (returns { migrated: false })
 *   - Non-fatal: caller wraps in try/catch; returns { migrated, fields, error } on failure
 *   - Reads `autoReserveStepUsdt` from singleton doc
 *   - If valid (finite + 1..1000) → mirrors to both new fields
 *   - If invalid (null/NaN) → uses schema default (10) for missing new fields
 *
 * @param {object} args
 * @param {object} args.AppConfig  Mongoose model
 * @param {object} [args.logger]   Pino-style logger
 * @returns {Promise<{migrated: boolean, fields?: string[], error?: string, legacyValid?: boolean}>}
 */
async function migrateSplitStepFields({ AppConfig, logger = noopLogger } = {}) {
  if (!AppConfig) {
    return { migrated: false, error: 'AppConfig model missing' };
  }

  let doc;
  try {
    // FIX-2026-09-29: use .lean() — see migrateBtcDrivenPresets comment for rationale.
    //   Without .lean(), Mongoose returns schema defaults for missing fields, which
    //   causes the migration to incorrectly conclude the field is already set.
    doc = await AppConfig.findOne({ key: 'singleton' }).lean();
  } catch (e) {
    logger.warn({ err: e.message }, 'AppConfig.migrateSplitStep: findOne failed (non-fatal)');
    return { migrated: false, error: e.message };
  }

  if (!doc) {
    // Fresh deploy — no singleton yet, nothing to migrate
    return { migrated: false };
  }

  const update = {};
  const legacyRaw = Number(doc.autoReserveStepUsdt);
  const legacyValid = Number.isFinite(legacyRaw) && legacyRaw >= 1 && legacyRaw <= 1000;
  const fallbackValue = 10; // matches schema default in AppConfig.js

  if (doc.autoReserveStepReserveUsdt == null) {
    update.autoReserveStepReserveUsdt = legacyValid ? legacyRaw : fallbackValue;
  }
  if (doc.autoReserveStepReleaseUsdt == null) {
    update.autoReserveStepReleaseUsdt = legacyValid ? legacyRaw : fallbackValue;
  }

  if (Object.keys(update).length === 0) {
    return { migrated: false };
  }

  try {
    await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: update },
      { new: true, upsert: true }
    );
    logger.info(
      { version: '2026-09-29', fields: Object.keys(update), values: update, legacyValid },
      'AppConfig.migrateSplitStep: split fields ensured (legacy or default)'
    );
    return { migrated: true, fields: Object.keys(update), legacyValid };
  } catch (e) {
    logger.warn(
      { err: e.message },
      'AppConfig.migrateSplitStep: update failed (non-fatal — manual retry via repair script)'
    );
    return { migrated: false, error: e.message };
  }
}

/**
 * FIX-2026-09-29: Migrate `autoReserveBtcDrivenPresets` Object field.
 *   If the field is null/undefined OR missing required keys (conservative/aggressive),
 *   write the schema default. Same pattern as migrateSplitStepFields.
 *
 *   Frontend runtime fallback (mergePresetsWithDefaults in service layer) already
 *   handles missing fields, but this migration ensures DB state is consistent
 *   from the very first read — no surprises in admin tools, backups, or exports.
 *
 * @param {object} args
 * @param {object} args.AppConfig  Mongoose model
 * @param {object} [args.logger]   Pino-style logger
 * @returns {Promise<{migrated: boolean, error?: string}>}
 */
async function migrateBtcDrivenPresets({ AppConfig, logger = noopLogger } = {}) {
  if (!AppConfig) {
    return { migrated: false, error: 'AppConfig model missing' };
  }

  let doc;
  try {
    // FIX-2026-09-29: use .lean() to get RAW doc — Mongoose hydrates schema
    //   defaults when accessing fields via a Mongoose document, so
    //   `doc.autoReserveBtcDrivenPresets` would return the schema default
    //   even when the field is missing from MongoDB. With .lean(), we get
    //   the actual stored value (or undefined if absent), so the migration
    //   correctly detects missing fields and writes defaults.
    doc = await AppConfig.findOne({ key: 'singleton' }).lean();
  } catch (e) {
    logger.warn({ err: e.message }, 'AppConfig.migratePresets: findOne failed (non-fatal)');
    return { migrated: false, error: e.message };
  }
  if (!doc) {
    // bootstrap will handle — no doc yet
    return { migrated: false };
  }

  const current = doc.autoReserveBtcDrivenPresets;
  const valid =
    current &&
    typeof current === 'object' &&
    !Array.isArray(current) &&
    current.conservative &&
    current.aggressive &&
    typeof current.conservative === 'object' &&
    typeof current.aggressive === 'object';
  if (valid) {
    return { migrated: false };
  }

  const defaults = {
    conservative: { poleCount: 2, usdtPerPole: 6, lossThresholdPct: 4, checkHours: 6, stepReserveUsdt: 6, stepReleaseUsdt: 6 },
    aggressive:   { poleCount: 5, usdtPerPole: 9, lossThresholdPct: 2, checkHours: 2, stepReserveUsdt: 9, stepReleaseUsdt: 9 },
  };
  try {
    await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: { autoReserveBtcDrivenPresets: defaults } },
      { new: true, upsert: true }
    );
    logger.info(
      { version: '2026-09-29', keys: Object.keys(defaults) },
      'AppConfig.migratePresets: defaults written'
    );
    return { migrated: true };
  } catch (e) {
    logger.warn({ err: e.message }, 'AppConfig.migratePresets: update failed (non-fatal)');
    return { migrated: false, error: e.message };
  }
}

/**
 * FIX-2026-09-29: Migrate stepUsdt inside autoReserveBtcDrivenPresets sub-fields.
 *   Round 2 stored single `stepUsdt` inside each preset (conservative/aggressive).
 *   Round 3 splits into `stepReserveUsdt` + `stepReleaseUsdt`.
 *
 *   This is a sibling of migrateSplitStepFields but operates on the nested Object
 *   `autoReserveBtcDrivenPresets[key].stepUsdt` — top-level migration only handles
 *   the singular `autoReserveStepUsdt` field.
 *
 *   Per-key, per-field logic:
 *     - If preset has legacy `stepUsdt` (finite, 1..1000) AND new fields are missing → mirror
 *     - If preset has legacy `stepUsdt` but new fields already set → leave new fields alone (preserve)
 *     - If preset has no `stepUsdt` at all AND new fields missing → skip (schema default applied at doc-create)
 *
 *   Why this matters: legacy preset shape `{stepUsdt:6}` would cause the Settings page
 *   editable table to render empty cells (frontend checks `Number.isFinite(Number(p[f.key]))`
 *   without fallback). On save, server clamps empty → 1 USDT, silently destroying user's
 *   configured value.
 *
 * @param {object} args
 * @param {object} args.AppConfig  Mongoose model
 * @param {object} [args.logger]   Pino-style logger
 * @returns {Promise<{migrated: boolean, presets?: object, error?: string}>}
 */
async function migratePresetsSubFields({ AppConfig, logger = noopLogger } = {}) {
  if (!AppConfig) {
    return { migrated: false, error: 'AppConfig model missing' };
  }

  let doc;
  try {
    // FIX-2026-09-29: use .lean() — see migrateBtcDrivenPresets comment for rationale.
    doc = await AppConfig.findOne({ key: 'singleton' }).lean();
  } catch (e) {
    logger.warn({ err: e.message }, 'AppConfig.migratePresetsSubFields: findOne failed (non-fatal)');
    return { migrated: false, error: e.message };
  }
  if (!doc) return { migrated: false };

  const presets = doc.autoReserveBtcDrivenPresets;
  if (!presets || typeof presets !== 'object' || Array.isArray(presets)) {
    return { migrated: false };
  }

  const updated = {};
  let anyChange = false;
  for (const presetKey of Object.keys(presets)) {
    const p = presets[presetKey];
    if (!p || typeof p !== 'object') continue;

    const legacyRaw = Number(p.stepUsdt);
    const legacyValid = Number.isFinite(legacyRaw) && legacyRaw >= 1 && legacyRaw <= 1000;

    const next = { ...p };
    if (legacyValid) {
      if (next.stepReserveUsdt == null) next.stepReserveUsdt = legacyRaw;
      if (next.stepReleaseUsdt == null) next.stepReleaseUsdt = legacyRaw;
      // Also keep legacy `stepUsdt` for backward-compat reads (mirror pattern used in BTC apply)
      if (next.stepUsdt == null) next.stepUsdt = legacyRaw;
    }

    if (JSON.stringify(next) !== JSON.stringify(p)) {
      updated[presetKey] = next;
      anyChange = true;
    }
  }

  if (!anyChange) return { migrated: false };

  const merged = { ...presets, ...updated };
  try {
    await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: { autoReserveBtcDrivenPresets: merged } },
      { new: true, upsert: true }
    );
    logger.info(
      { version: '2026-09-29', updatedKeys: Object.keys(updated) },
      'AppConfig.migratePresetsSubFields: preset stepUsdt → stepReserve/stepRelease mirrored'
    );
    return { migrated: true, presets: merged };
  } catch (e) {
    logger.warn({ err: e.message }, 'AppConfig.migratePresetsSubFields: update failed (non-fatal)');
    return { migrated: false, error: e.message };
  }
}

const noopLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
};

module.exports = {
  REPAIR_VERSION,
  clampOutOfRangeNumbers,
  repairAppConfig,
  bootstrapAppConfigDefaults,
  migrateSplitStepFields,
  migrateBtcDrivenPresets,
  migratePresetsSubFields,
  DEFAULT_SKIP_PATHS,
};