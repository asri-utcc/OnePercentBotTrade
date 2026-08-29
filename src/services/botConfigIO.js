'use strict';

/**
 * FIX-2026-08-14: Bot Config Import/Export — pure-function helpers
 *
 * Single source of truth for the universal JSON schema used across 4 UI surfaces:
 *   - Master Config modal (📋 Templates panel)
 *   - bot-edit page
 *   - New Bot modal
 *   - Bot Defaults section (Settings)
 *
 * The `type` field is just an origin hint; the `settings` object works identically
 * across all surfaces (cross-surface compatible).
 *
 * Browser-side DOM helpers (parseImportFile, applyToForm, triggerDownload) live in
 * public/js/botConfigIO.js and wrap these pure helpers.
 *
 * Mirrors src/services/masterConfigTemplates.js style — no DB, no Express.
 */

const { ALLOWED_TEMPLATE_FIELDS } = require('./masterConfigTemplates');

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 1_048_576; // 1 MiB
const ALLOWED_IMPORT_TYPES = ['bot', 'master-template', 'bot-defaults'];

// Build the canonical 52-key whitelist (50 masterConfigTemplates + 2 bot defaults).
// Re-export for both backend + frontend consumption.
const ALLOWED_FIELD_KEYS = [...ALLOWED_TEMPLATE_FIELDS];

// Field type registry — used for coercion in sanitizeImportSettings.
// (We don't enforce type coercion for STRING_FIELDS — they may be null.)
const NUMBER_FIELDS = new Set([
  'capitalPerTrade', 'maxTrades', 'tpPercent', 'retryTimeMin', 'retryMax',
  'kcMult', 'minSpreadTicks', 'suggestTpWindow',
  'dcaMaxLayers', 'martingaleMultiplier', 'martingaleMaxLayerNotional',
  'cbv2LockHours', 'cbv3LockHours', 'cbv5LockHours',
  'cbv5KcLen', 'cbv5KcMult', 'cbv5PivotLookback', 'cbv5PivotLeftLen', 'cbv5PivotRightLen',
  'cbv5VolMaLen', 'cbv5VolMultiplier', 'cbv5DebounceCandles',
  'cbAutoUnlockThresholdPct',
  'autoPauseMinKcPct', 'autoPauseMin24hVolUsdt',
  'autoArmLossPct', 'autoArmAgeHours',
  'tpTrendMultiplier',
]);

const BOOLEAN_FIELDS = new Set([
  'dcaEnabled', 'martingaleEnabled',
  's1OnlyDown', 'xs1Enabled',
  'cbEnabled', 'cbv2Enabled', 'cbv3Enabled', 'cbv5Enabled',
  'cbv5StrictBreak', 'cbv5UseVolume',
  'cbAutoUnlockEnabled',
  'dynamicSizeEnabled',
  'safeTradeEnabled', 'safeTradeTrendlineEnabled', 'safeTradeNoTradeEnabled',
  'autoPauseEnabled',
  // FIX-2026-08-29: auto-pause threshold auto-adjust per-bot opt-in (added to ALLOWED_TEMPLATE_FIELDS)
  'autoPauseAdjustEnabled',
  'autoArmStopLossOnUKC', 'slUkcTriggerOnProfit',
  'tpTrendEnabled', 'autoUpdateTp', 'stopLossOnUpperKC',
]);

const STRING_FIELDS = new Set([
  'defaultSymbol', 'defaultTimeframe', 'timeframe',
]);

// ──────────────────────────────────────────────────────────────────────────────
// buildExportPayload — pure, no I/O
// ──────────────────────────────────────────────────────────────────────────────
//
// Returns a JSON-serializable object conforming to the schema.
// Defensive: extra meta fields are silently dropped; null/undefined args normalized.
//
function buildExportPayload({
  type,
  name,
  source,
  settings,
  botSymbol = null,
  botTimeframe = null,
  cbVersion = null,
} = {}) {
  const cleanSettings = (settings && typeof settings === 'object' && !Array.isArray(settings))
    ? settings
    : {};

  const meta = {
    source: source || 'unknown',
    fieldCount: Object.keys(cleanSettings).length,
  };
  if (botSymbol) meta.botSymbol = botSymbol;
  if (botTimeframe) meta.botTimeframe = botTimeframe;
  if (cbVersion) meta.cbVersion = cbVersion;

  return {
    schemaVersion: SCHEMA_VERSION,
    type: type || 'master-template',
    exportedAt: new Date().toISOString(),
    name: name || 'Unnamed',
    meta,
    settings: cleanSettings,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// sanitizeImportSettings — drops unknown keys + coerces types defensively
// ──────────────────────────────────────────────────────────────────────────────
//
// Type coercion (defensive — JSON-from-spreadsheet or human-edited may have wrong types):
//   - NUMBER_FIELDS: string numbers ("9") → numbers; non-numeric → dropped
//   - BOOLEAN_FIELDS: "true"/"false" → bool; everything else strict-equal to true
//   - STRING_FIELDS: passed through verbatim (null preserved)
//   - unknown keys: dropped silently + counted
//
function sanitizeImportSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { settings: {}, dropped: 0 };
  }
  const out = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!ALLOWED_FIELD_KEYS.includes(k)) {
      dropped += 1;
      continue;
    }
    if (NUMBER_FIELDS.has(k)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[k] = v;
      } else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(parseFloat(v))) {
        out[k] = parseFloat(v);
      } else {
        dropped += 1; // cannot coerce to number
      }
      continue;
    }
    if (BOOLEAN_FIELDS.has(k)) {
      if (typeof v === 'boolean') {
        out[k] = v;
      } else if (v === 'true' || v === '1' || v === 1) {
        out[k] = true;
      } else if (v === 'false' || v === '0' || v === 0 || v === null) {
        out[k] = false;
      } else {
        out[k] = v === true; // strict
      }
      continue;
    }
    if (STRING_FIELDS.has(k)) {
      // Preserve string values; null is allowed (caller may want to clear)
      if (typeof v === 'string' || v === null) {
        out[k] = v;
      } else {
        out[k] = String(v);
      }
      continue;
    }
    // Fallback for safety — should be unreachable
    out[k] = v;
  }
  return { settings: out, dropped };
}

// ──────────────────────────────────────────────────────────────────────────────
// checkMutuallyExclusive — returns array of human-readable warnings (non-fatal)
// ──────────────────────────────────────────────────────────────────────────────
//
// Rules:
//   1. martingaleEnabled===true + dcaEnabled===false → "Martingale requires DCA mode"
//   2. dynamicSizeEnabled===true + (dcaEnabled or martingaleEnabled) → "DPS mutually exclusive"
//   3. cbEnabled===false + cbAutoUnlockEnabled===true → "CB Auto-Unlock requires CB enabled"
//   4. cbv5Enabled===true but cbVersion='v2' → "CBv5 fields will be silently dropped"
//
function checkMutuallyExclusive(settings) {
  if (!settings || typeof settings !== 'object') return [];
  const warnings = [];

  if (settings.martingaleEnabled === true && settings.dcaEnabled === false) {
    warnings.push('Martingale requires DCA mode');
  }
  if (
    settings.dynamicSizeEnabled === true
    && (settings.dcaEnabled === true || settings.martingaleEnabled === true)
  ) {
    warnings.push('DPS (Dynamic Position Sizing) is mutually exclusive with DCA/Martingale');
  }
  if (settings.cbEnabled === false && settings.cbAutoUnlockEnabled === true) {
    warnings.push('CB Auto-Unlock requires CB enabled');
  }
  // CBv5 backend filtering is handled at save-time per master cbVersion; this is informational
  return warnings;
}

// ──────────────────────────────────────────────────────────────────────────────
// validateImportPayload — structural validation (version, type, shape)
// ──────────────────────────────────────────────────────────────────────────────
//
// Returns { ok, error, payload, warnings }.
// `payload` is the parsed object (already JSON.parsed). `settings` is NOT yet sanitized
// (caller should call sanitizeImportSettings on payload.settings).
//
function validateImportPayload(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Invalid payload: not an object' };
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      error: `Unsupported schemaVersion: ${parsed.schemaVersion} (this app expects ${SCHEMA_VERSION})`,
    };
  }
  if (!ALLOWED_IMPORT_TYPES.includes(parsed.type)) {
    return {
      ok: false,
      error: `Unknown type: ${parsed.type} (allowed: ${ALLOWED_IMPORT_TYPES.join(', ')})`,
    };
  }
  if (!parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings)) {
    return { ok: false, error: 'Missing or invalid settings object' };
  }
  return {
    ok: true,
    payload: parsed,
    warnings: checkMutuallyExclusive(parsed.settings),
  };
}

module.exports = {
  // Constants
  SCHEMA_VERSION,
  MAX_FILE_BYTES,
  ALLOWED_IMPORT_TYPES,
  ALLOWED_FIELD_KEYS,
  NUMBER_FIELDS,
  BOOLEAN_FIELDS,
  STRING_FIELDS,

  // Pure helpers
  buildExportPayload,
  sanitizeImportSettings,
  checkMutuallyExclusive,
  validateImportPayload,
};
