'use strict';

/**
 * FIX-2026-09-17: Safety defaults — env-var → AppConfig bootstrap
 *
 * Background:
 *   - AppConfig schema has many safety toggles with `default: false` (opt-in pattern)
 *     (e.g. auv2Enabled, waitingSellRecoveryEnabled, cbEnabled, cbv2Enabled, etc.)
 *   - Without env override, fresh instance boots with all safety toggles OFF
 *     → scheduler no-ops forever → silent-off class of bugs (BERAUSDT, ZENUSDT)
 *   - User had to manually flip `AppConfig.auv2Enabled = true` post-deploy
 *     → next deployment, same problem
 *
 * Design:
 *   - Env vars ONLY SEED — they do NOT auto-override existing DB values
 *   - If DB has the field explicitly set (true or false) → respect it
 *   - If DB doesn't have the field yet (fresh install) → apply env var
 *   - This means env vars set during setup → permanent on first run;
 *     changing env later does NOT change already-stored config (use UI/Master Config)
 *
 * Env vars supported (all OPTIONAL — leave blank for schema defaults):
 *   - AUV2_ENABLED=true|false          → auv2Enabled (master toggle)
 *   - AUV2_MIN_AGE_HOURS=N             → auv2MinAgeHours (master default)
 *   - AUV2_MAX_LOSS_PCT=N              → auv2MaxLossPct (master default)
 *   - AUV2_MAX_LOSS_THB=N              → auv2MaxLossThb (master default)
 *   - AUV2_MAX_WAIT_DAYS=N             → auv2MaxWaitDays (master default)
 *   - ORPHAN_SELL_MAX_AGE_HOURS=N      → orphanSellMaxAgeHours (1..168)
 *   - WAITING_SELL_RECOVERY_ENABLED=true|false  → waitingSellRecoveryEnabled
 *   - WAITING_SELL_RECOVERY_INTERVAL_MS=N       → waitingSellRecoveryIntervalMs
 *
 * Pure helper — testable without mocks. Does NOT touch DB directly;
 * caller (auth.routes.js setup OR scripts/seed-appconfig-from-env.js) writes
 * the returned object via $set on AppConfig.updateOne().
 */

const ENV_DEFAULTS = {
  auv2Enabled: {
    env: 'AUV2_ENABLED',
    type: 'boolean',
    schemaDefault: false,
    description: 'AUv2 master kill-switch (F1 auto-arm v2 shallow-loss exit)',
  },
  auv2MinAgeHours: {
    env: 'AUV2_MIN_AGE_HOURS',
    type: 'number',
    min: 0.5,
    max: 999,
    schemaDefault: 24,
    description: 'AUv2 — minimum position age before shallow-loss check fires',
  },
  auv2MaxLossPct: {
    env: 'AUV2_MAX_LOSS_PCT',
    type: 'number',
    min: 0.1,
    max: 50,
    schemaDefault: 5,
    description: 'AUv2 — max loss % (pct mode) for shallow-loss trigger',
  },
  auv2MaxLossThb: {
    env: 'AUV2_MAX_LOSS_THB',
    type: 'number',
    min: 1,
    max: 100000,
    schemaDefault: 200,
    description: 'AUv2 — max loss THB (thb mode) for shallow-loss trigger',
  },
  auv2MaxWaitDays: {
    env: 'AUV2_MAX_WAIT_DAYS',
    type: 'number',
    min: 0,
    max: 90,
    schemaDefault: 0,
    description: 'AUv2 — hard cap (days); 0=disabled, >0=force-sell after N days regardless of loss',
  },
  orphanSellMaxAgeHours: {
    env: 'ORPHAN_SELL_MAX_AGE_HOURS',
    type: 'number',
    min: 1,
    max: 168,
    schemaDefault: 24,
    description: 'Orphan-SELL sweeper threshold — when SELL alive on Binance > N hours, auto-cancel + force-close',
  },
  waitingSellRecoveryEnabled: {
    env: 'WAITING_SELL_RECOVERY_ENABLED',
    type: 'boolean',
    schemaDefault: true,
    description: 'Re-place SELL for recovery-injected trades when PRICE_FILTER passes (default TRUE)',
  },
  waitingSellRecoveryIntervalMs: {
    env: 'WAITING_SELL_RECOVERY_INTERVAL_MS',
    type: 'number',
    min: 1 * 60 * 60 * 1000,
    max: 24 * 60 * 60 * 1000,
    schemaDefault: 4 * 60 * 60 * 1000,
    description: 'waiting_sell_recovery scheduler interval (1h..24h, default 4h)',
  },
};

/**
 * Pure helper — compute env-derived fields.
 *
 * @param {object} existing  — current AppConfig doc (or {} for fresh deploy)
 * @param {object} env       — process.env (or test fixture)
 * @returns {object} { fields: {key:value}, sources: {key:'env'|'existing'} }
 *
 * For each known field:
 *   - If existing[key] is already set (not null/undefined) → 'existing' (don't override)
 *   - Else if env[envName] is set + valid → 'env' (apply)
 *   - Else → omit (use schema default)
 */
function computeSafetyDefaults(existing = {}, env = process.env) {
  const fields = {};
  const sources = {};
  const skipped = [];

  for (const [key, spec] of Object.entries(ENV_DEFAULTS)) {
    const existingVal = existing[key];
    if (existingVal !== undefined && existingVal !== null) {
      sources[key] = 'existing';
      continue; // respect explicit DB value (don't override)
    }
    const raw = env[spec.env];
    if (raw === undefined || raw === null || raw === '') {
      skipped.push({ key, env: spec.env, reason: 'not set' });
      continue;
    }
    let parsed;
    if (spec.type === 'boolean') {
      // Accept: true|false|1|0|yes|no (case-insensitive)
      const lc = String(raw).toLowerCase().trim();
      if (['true', '1', 'yes', 'on'].includes(lc)) parsed = true;
      else if (['false', '0', 'no', 'off'].includes(lc)) parsed = false;
      else {
        skipped.push({ key, env: spec.env, reason: `invalid boolean: ${raw}` });
        continue;
      }
    } else {
      // number
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) {
        skipped.push({ key, env: spec.env, reason: `invalid number: ${raw}` });
        continue;
      }
      if (spec.min != null && n < spec.min) {
        skipped.push({ key, env: spec.env, reason: `below min ${spec.min}: ${n}` });
        continue;
      }
      if (spec.max != null && n > spec.max) {
        skipped.push({ key, env: spec.env, reason: `above max ${spec.max}: ${n}` });
        continue;
      }
      parsed = n;
    }
    fields[key] = parsed;
    sources[key] = 'env';
  }

  return { fields, sources, skipped };
}

/**
 * Apply env-derived fields to an AppConfig doc (in-memory).
 * Returns { changed: bool, applied: string[] }.
 * Caller decides whether to .save() or .updateOne().
 */
function applySafetyDefaults(configDoc, env = process.env) {
  const existing = configDoc.toObject ? configDoc.toObject() : configDoc;
  const { fields, sources } = computeSafetyDefaults(existing, env);
  const applied = [];
  for (const [k, v] of Object.entries(fields)) {
    configDoc[k] = v;
    applied.push(`${k}=${v} (from ${sources[k]})`);
  }
  return { changed: applied.length > 0, applied };
}

module.exports = {
  ENV_DEFAULTS,
  computeSafetyDefaults,
  applySafetyDefaults,
};
