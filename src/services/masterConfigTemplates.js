'use strict';

/**
 * FIX-2026-08-13: Master Config Templates — pure-function helpers
 *
 * Single source of truth for:
 *   - the template field whitelist (mirror of POST /api/bots/bulk-update in bot.routes.js)
 *   - name normalization + uniqueness check
 *   - payload sanitization (drop unknown keys)
 *   - ID generation (crypto.randomUUID)
 *
 * Mirrors src/services/botDefaults.js style — no DB, no Express → easy unit tests.
 */

const crypto = require('crypto');

const MAX_TEMPLATES = 50;
const MAX_NAME_LEN = 50;

// Mirror of allowed[] in bot.routes.js POST /bulk-update (~lines 2117-2142).
// Keep in sync manually. Refactor bot.routes.js to import this list in a follow-up PR.
// FIX-2026-08-21: bulk-update whitelist was missing cbv3Enabled/cbv3LockHours → "no valid
//   fields in settings" when user toggled CBv3 via Master Config. Backend route now includes
//   them (matching this template). Same drift pattern as the 2026-08-14 import-export silent-drop.
const ALLOWED_TEMPLATE_FIELDS = [
  'capitalPerTrade', 'maxTrades', 'tpPercent', 'retryTimeMin', 'retryMax',
  'timeframe', 'stopLossOnUpperKC', 'autoUpdateTp', 'kcMult', 'minSpreadTicks',
  's1OnlyDown', 'xs1Enabled', 'cbEnabled', 'cbv2Enabled', 'cbv2LockHours', 'safeTradeEnabled',
  'safeTradeTrendlineEnabled', 'safeTradeNoTradeEnabled',
  'autoPauseEnabled', 'autoPauseMinKcPct', 'autoPauseMin24hVolUsdt',
  // FIX-2026-08-29: auto-pause threshold auto-adjust per-bot opt-in
  'autoPauseAdjustEnabled',
  // FIX-2026-08-30: Auto-Timing (Phase 4) per-bot tristate (null|true|false = inherit/force-on/force-off)
  'autoTimingEnabled',
  'suggestTpWindow', 'autoArmStopLossOnUKC', 'autoArmLossPct', 'autoArmAgeHours', 'slUkcTriggerOnProfit',
  'tpTrendMultiplier', 'tpTrendEnabled',
  'dcaEnabled', 'dcaMaxLayers',
  'martingaleEnabled', 'martingaleMultiplier', 'martingaleMaxLayerNotional',
  'dynamicSizeEnabled', 'cbAutoUnlockEnabled', 'cbAutoUnlockThresholdPct',
  'cbv3Enabled', 'cbv3LockHours',
  'cbv5Enabled', 'cbv5LockHours',
  'cbv5KcLen', 'cbv5KcMult',
  'cbv5PivotLookback', 'cbv5PivotLeftLen', 'cbv5PivotRightLen',
  'cbv5StrictBreak', 'cbv5UseVolume',
  'cbv5VolMaLen', 'cbv5VolMultiplier', 'cbv5DebounceCandles',
  // FIX-2026-08-14: Add defaultSymbol + defaultTimeframe so Bot Defaults can be exported/imported
  // via the same template pipeline. These keys are stored on AppConfig.botDefaults (not on Bot docs).
  'defaultSymbol', 'defaultTimeframe',
  // FIX-2026-09-02: Round-down Capital (opt-in per-bot) — Master Config / Bot Defaults / Template support
  'roundDownCapitalEnabled', 'roundDownCapitalMin',
];

function newTemplateId() {
  return crypto.randomUUID();
}

function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim();
}

// Validate a new/rename name → { ok, name, error }
function validateName(raw) {
  const name = normalizeName(raw);
  if (!name) return { ok: false, error: 'name is required' };
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `name length max ${MAX_NAME_LEN} chars (got ${name.length})` };
  }
  return { ok: true, name };
}

// Drop unknown keys; return sanitized settings + dropped count
function sanitizeSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { settings: {}, dropped: 0 };
  }
  const out = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (ALLOWED_TEMPLATE_FIELDS.includes(k)) out[k] = v;
    else dropped += 1;
  }
  return { settings: out, dropped };
}

// Return existing entry by id (case-sensitive id, never user-supplied).
// Returns null on miss / null input / non-array input.
function findById(templates, id) {
  if (!Array.isArray(templates) || !id) return null;
  return templates.find((t) => t && t.id === id) || null;
}

// Find index by id (for Mongo positional operator). Returns -1 on miss.
function findIndexById(templates, id) {
  if (!Array.isArray(templates) || !id) return -1;
  return templates.findIndex((t) => t && t.id === id);
}

// Case-insensitive name collision (against existing list, optionally excluding an id for rename).
// Returns true if a different template already uses this name.
function isNameTaken(templates, rawName, excludeId = null) {
  if (!Array.isArray(templates)) return false;
  const key = normalizeName(rawName).toUpperCase();
  if (!key) return false;
  return templates.some((t) => t && t.id !== excludeId && normalizeName(t.name).toUpperCase() === key);
}

// Build a new entry for save.
function buildEntry({ name, settings }) {
  const now = new Date();
  return {
    id: newTemplateId(),
    name,
    settings,
    createdAt: now,
    updatedAt: now,
  };
}

// Project list to lightweight metadata (no settings field) — for GET list endpoint.
function toMetadataList(templates) {
  if (!Array.isArray(templates)) return [];
  return templates.map((t) => ({
    id: t.id,
    name: t.name,
    fieldCount: t.settings && typeof t.settings === 'object' ? Object.keys(t.settings).length : 0,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));
}

module.exports = {
  MAX_TEMPLATES,
  MAX_NAME_LEN,
  ALLOWED_TEMPLATE_FIELDS,
  newTemplateId,
  normalizeName,
  validateName,
  sanitizeSettings,
  findById,
  findIndexById,
  isNameTaken,
  buildEntry,
  toMetadataList,
};
