'use strict';

/**
 * FIX-2026-08-29: Config Backup & Restore
 *
 * Admin-facing feature: export the entire bot config as a JSON file (or import
 * a previous backup). The user can pick which sections to backup/restore via a
 * modal in the Settings page.
 *
 * Sections supported:
 *   - apiKeys:   binanceApiKeyEnc/Iv/AuthTag + binanceApiSecretEnc/Iv/AuthTag (encrypted blobs)
 *   - telegram:  telegramBotTokenEnc/Iv/AuthTag (encrypted) + telegramChatId + telegramEvents + telegramThresholds
 *   - appConfig: master toggles + botDefaults + masterConfigTemplates + auto* settings
 *   - positions: open Trade docs only (state ∈ OPEN_TRADE_STATES — by user request 2026-08-29)
 *   - bots:      full Bot collection (including soft-deleted)
 *   - license:   metadata only (tier, owner, expiresAt, features, hasLicense) — restore is NO-OP
 *   - others:    placeholder for future expansion (wallet, chartMonitor, etc.)
 *
 * License gating: routes require `licenseService.isFeatureEnabled('configBackup') === true`.
 * `configBackup` defaults ON for legacy licenses (`!== false`).
 *
 * Encryption caveat (CRITICAL):
 *   Encrypted blobs (apiKeys, telegram token) store AES-256-GCM ciphertext + IV + authTag.
 *   They can ONLY be decrypted with the SAME `ENCRYPTION_KEY` env-var. Cross-machine
 *   restore is technically possible (ciphertext is portable) but the api keys/tokens will
 *   fail to decrypt unless the destination has the same env. UI surfaces this warning.
 *
 * Pre-restore safety:
 *   Every restore writes `data/configbackup-pre-restore-{ISO}.json` BEFORE any DB mutations.
 *   If the file write fails (disk full / permissions) → restore aborts with 500, no mutations.
 *   The pre-restore file is a full snapshot of the affected sections (used as a manual fallback).
 *
 * Atomicity:
 *   Each section is wrapped in try/catch. One section failing does NOT abort others.
 *   UI surfaces partial-success (per-section results with `.error` if failed).
 *
 * Schema version: BACKUP_VERSION = 'onepercentbot-config-backup-1' (string), SCHEMA_VERSION = 1 (number).
 * Backwards-compat note: future versions bump SCHEMA_VERSION; parseBackupPayload() rejects unknowns.
 */

const fs = require('fs').promises;
const path = require('path');
const mongoose = require('mongoose');

const AppConfig = require('../db/models/AppConfig');
const Bot = require('../db/models/Bot');
const Trade = require('../db/models/Trade');
const licenseGate = require('../admin-monitor/licenseGate');
const licenseService = require('./licenseService');
const logger = require('../utils/logger');

const SCHEMA_VERSION = 1;
const BACKUP_VERSION = 'onepercentbot-config-backup-1';
const SUPPORTED_SECTIONS = ['apiKeys', 'telegram', 'appConfig', 'positions', 'bots', 'license', 'others'];
const MAX_BACKUP_BYTES = 10 * 1024 * 1024; // 10 MiB

// FIX-2026-08-29: open trade states — by user decision, only backup positions that are still active
const OPEN_TRADE_STATES = ['placed', 'partial_wait', 'filled', 'retrying', 'holding', 'stopping', 'selling', 'partial_sell_wait'];

// Pre-restore snapshots live in <repo>/data/ alongside the bot (Windows-safe — no /tmp)
const PRE_RESTORE_DIR = path.join(__dirname, '..', '..', 'data');

// ─── AppConfig field whitelists ───────────────────────────────────────────────
// Used to know which fields belong to which section. Keep in sync with src/db/models/AppConfig.js.

const API_KEY_FIELDS = [
  'binanceApiKeyEnc', 'binanceApiKeyIv', 'binanceApiKeyAuthTag',
  'binanceApiSecretEnc', 'binanceApiSecretIv', 'binanceApiSecretAuthTag',
];

const TELEGRAM_FIELDS = [
  'telegramBotTokenEnc', 'telegramBotTokenIv', 'telegramBotTokenAuthTag',
  'telegramChatId', 'telegramEnabled', 'telegramEvents', 'telegramThresholds',
];

// Master toggles + auto* settings + botDefaults + masterConfigTemplates — everything in AppConfig
// except api keys, telegram, and a few internal-only fields (timestamps, passwordHash, etc.).
const APP_CONFIG_FIELDS = [
  // setup + flags
  'useBnbForFees', 'setupCompleted', 'setupAt',
  // CB
  'cbVersion', 'cbv5MasterEnabled', 'masterDynamicSizeEnabled', 'masterCbAutoUnlockEnabled',
  // DPS
  'dpsMinSize', 'dpsMaxSize', 'dpsMinLayers', 'dpsMaxLayers', 'dpsCooldownMinutes',
  'dpsWinStreakCount', 'dpsWinStreakDeltaSize', 'dpsWinStreakDeltaLayers',
  'dpsBigWinCount', 'dpsBigWinPct', 'dpsBigWinDeltaSize', 'dpsBigWinDeltaLayers',
  'dpsLossStreakCount', 'dpsLossDeltaSize', 'dpsLossDeltaLayers',
  'dpsRespectBotCapital', 'dpsResetHistoryOnFire', 'dpsDryRun',
  // Rate limit
  'binanceRateLimitPerMin',
  // Wallet reserve + auto reserve
  'walletReserveUsdt',
  'autoReserveEnabled', 'autoReservePoleCount', 'autoReserveUsdtPerPole',
  'autoReserveLossThresholdPct', 'autoReserveCheckHours', 'autoReserveStepUsdt',
  // Auto-pause adjust
  'autoPauseAdjustEnabled', 'autoPauseAdjustMinBots', 'autoPauseAdjustMaxBots',
  'autoPauseAdjustIntervalMs', 'autoPauseAdjustKcStep', 'autoPauseAdjustVolStep',
  // Auto add bot
  'autoAddBotEnabled', 'autoAddBotIntervalMin',
  'autoAddBotMinKcPct', 'autoAddBotMaxPerRun',
  'autoAddBotScanTimeframe', 'autoAddBotScanThreshold', 'autoAddBotScanWindow',
  'autoAddBotScanTpWindow', 'autoAddBotScanTopN',
  'autoAddBotScanMinVol', 'autoAddBotScanMinPct', 'autoAddBotScanTrends',
  'autoAddBotTelegramNotify', 'autoAddBotAutoEnable', 'autoAddBotAutoRestore',
  'autoAddBotNamePrefix',
  // Auto delete bot
  'autoDeleteBotEnabled', 'autoDeleteBotDays', 'autoDeleteBotWarningDays',
  // Daily target + BNB
  'dailyTargetThb',
  'autoBuyBnbEnabled', 'autoBuyBnbTopUpUsdt', 'autoBuyBnbThresholdUsdt',
  'autoBuyBnbCheckIntervalMin', 'autoBuyBnbMaxUsdtPerDay', 'autoBuyBnbCooldownMin',
  'bnbGaugeTargetUsdt',
  // Bot defaults (full blob — has all 60+ fields)
  'botDefaults',
  // Master config templates
  'masterConfigTemplates',
];

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function _plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function _safeObjectId(v) {
  if (v == null) return null;
  if (v instanceof mongoose.Types.ObjectId) return v.toString();
  if (typeof v === 'string') return v;
  if (_plainObject(v) && v.$oid) return String(v.$oid);
  return null;
}

/**
 * Validate a parsed backup payload. Returns { ok, payload, error }.
 * On error: ok=false, payload=null, error=string.
 */
function parseBackupPayload(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, payload: null, error: 'Payload is not an object' };
  }
  if (json.version !== BACKUP_VERSION) {
    return { ok: false, payload: null, error: `Unsupported version: ${json.version} (expected ${BACKUP_VERSION})` };
  }
  if (json.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, payload: null, error: `Unsupported schemaVersion: ${json.schemaVersion} (expected ${SCHEMA_VERSION})` };
  }
  if (!_plainObject(json.sections)) {
    return { ok: false, payload: null, error: 'Missing or invalid sections object' };
  }
  const sections = json.sections;
  for (const name of Object.keys(sections)) {
    if (!SUPPORTED_SECTIONS.includes(name)) {
      return { ok: false, payload: null, error: `Unknown section: ${name} (allowed: ${SUPPORTED_SECTIONS.join(', ')})` };
    }
  }
  return { ok: true, payload: json, error: null };
}

/**
 * Check if encryption is available (config.encryptionKey is >= 32 chars).
 * Used by the preview endpoint to surface a warning banner.
 */
function _encryptionAvailable() {
  try {
    const config = require('../../config');
    const key = (config && config.encryptionKey) || '';
    return typeof key === 'string' && key.length >= 32;
  } catch (_) {
    return false;
  }
}

function _getMachineId() {
  try {
    const { getMachineId } = require('../admin-monitor/machineId');
    return getMachineId();
  } catch (_) {
    return 'unknown';
  }
}

function _getAppVersion() {
  try {
    const pkg = require('../../package.json');
    return pkg.version || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

// ─── Section helpers: apiKeys ─────────────────────────────────────────────────

async function backupApiKeys() {
  const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
  if (!cfg) return { present: false, encrypted: true, data: null };
  const data = {};
  let hasAny = false;
  for (const f of API_KEY_FIELDS) {
    if (cfg[f]) { data[f] = cfg[f]; hasAny = true; }
  }
  if (!hasAny) return { present: false, encrypted: true, data: null };
  return { present: true, encrypted: true, data };
}

async function restoreApiKeys(data, mode = 'merge') {
  const result = { changed: 0, created: 0, updated: 0, skipped: 0 };
  if (!data || typeof data !== 'object') return { ...result, skipped: 1, error: 'no data' };
  const cfg = await AppConfig.findOne({ key: 'singleton' });
  if (!cfg && mode === 'merge') {
    // No existing config — fall through to replace branch (upsert)
  }
  const set = {};
  for (const f of API_KEY_FIELDS) {
    if (mode === 'replace') {
      if (data[f]) set[f] = data[f];
    } else {
      // merge: only fill empty fields
      const existing = cfg ? cfg[f] : null;
      if (!existing && data[f]) set[f] = data[f];
    }
  }
  if (Object.keys(set).length === 0) return { ...result, skipped: 6, note: 'no changes' };
  await AppConfig.findOneAndUpdate(
    { key: 'singleton' },
    { $set: set },
    { upsert: true, new: true }
  );
  result.updated = Object.keys(set).length;
  result.changed = Object.keys(set).length;
  return result;
}

// ─── Section helpers: telegram ────────────────────────────────────────────────

async function backupTelegram() {
  const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
  if (!cfg) return { present: false, encrypted: false, data: null };
  const data = {};
  let hasAny = false;
  for (const f of TELEGRAM_FIELDS) {
    if (cfg[f] !== undefined && cfg[f] !== null) {
      data[f] = cfg[f];
      hasAny = true;
    }
  }
  if (!hasAny) return { present: false, encrypted: false, data: null };
  return { present: true, encrypted: false, data };
}

async function restoreTelegram(data, mode = 'merge') {
  const result = { changed: 0, created: 0, updated: 0, skipped: 0 };
  if (!data || typeof data !== 'object') return { ...result, skipped: 1, error: 'no data' };
  const cfg = await AppConfig.findOne({ key: 'singleton' });
  const set = {};
  for (const f of TELEGRAM_FIELDS) {
    if (data[f] === undefined) continue;
    if (mode === 'replace') {
      set[f] = data[f];
    } else {
      const existing = cfg ? cfg[f] : undefined;
      if (existing === undefined || existing === null || existing === '') {
        set[f] = data[f];
      }
    }
  }
  if (Object.keys(set).length === 0) return { ...result, skipped: TELEGRAM_FIELDS.length, note: 'no changes' };
  await AppConfig.findOneAndUpdate(
    { key: 'singleton' },
    { $set: set },
    { upsert: true, new: true }
  );
  result.updated = Object.keys(set).length;
  result.changed = Object.keys(set).length;
  return result;
}

// ─── Section helpers: appConfig ───────────────────────────────────────────────

async function backupAppConfig() {
  const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
  if (!cfg) return { present: false, data: null };
  const data = {};
  let count = 0;
  for (const f of APP_CONFIG_FIELDS) {
    if (cfg[f] !== undefined) {
      data[f] = cfg[f];
      count += 1;
    }
  }
  if (count === 0) return { present: false, data: null };
  return { present: true, data };
}

async function restoreAppConfig(data, mode = 'merge') {
  const result = { changed: 0, created: 0, updated: 0, skipped: 0 };
  if (!data || typeof data !== 'object') return { ...result, skipped: 1, error: 'no data' };
  const cfg = await AppConfig.findOne({ key: 'singleton' });
  const set = {};
  for (const f of APP_CONFIG_FIELDS) {
    if (data[f] === undefined) continue;
    if (mode === 'replace') {
      set[f] = data[f];
    } else {
      // merge
      if (f === 'botDefaults') {
        const existing = (cfg && cfg.botDefaults) || {};
        set[f] = { ...existing, ...(data[f] || {}) };
      } else if (f === 'masterConfigTemplates') {
        // arrays: replace on replace mode, leave existing on merge mode (admin manually picks)
        if (mode === 'replace') set[f] = data[f];
        // merge mode skips (user can manually add via UI)
      } else {
        const existing = cfg ? cfg[f] : undefined;
        if (existing === undefined || existing === null) set[f] = data[f];
      }
    }
  }
  if (Object.keys(set).length === 0) return { ...result, skipped: APP_CONFIG_FIELDS.length, note: 'no changes' };
  await AppConfig.findOneAndUpdate(
    { key: 'singleton' },
    { $set: set },
    { upsert: true, new: true }
  );
  result.updated = Object.keys(set).length;
  result.changed = Object.keys(set).length;
  return result;
}

// ─── Section helpers: positions (OPEN trades only — user decision 2026-08-29) ─

async function backupPositions() {
  const docs = await Trade.find({ state: { $in: OPEN_TRADE_STATES } }).lean();
  return { present: docs.length > 0, count: docs.length, openOnly: true, data: docs };
}

async function restorePositions(data, mode = 'merge') {
  const result = { changed: 0, created: 0, updated: 0, skipped: 0 };
  if (!Array.isArray(data)) return { ...result, skipped: 0, error: 'positions data is not array' };

  // Filter to open states only (defensive — backup guarantees this, but trust nothing)
  const incoming = data.filter((t) => OPEN_TRADE_STATES.includes(t.state));

  if (mode === 'replace') {
    // Delete all existing open trades first
    const delRes = await Trade.deleteMany({ state: { $in: OPEN_TRADE_STATES } });
    result.skipped = delRes.deletedCount || 0;
  }

  let created = 0;
  let updated = 0;
  for (const t of incoming) {
    const id = _safeObjectId(t._id);
    if (!id) { result.skipped += 1; continue; }
    // Strip _id for upsert payload (Mongoose would complain about immutable _id)
    const { _id, ...rest } = t;
    try {
      const r = await Trade.findOneAndUpdate(
        { _id: id },
        { $set: rest },
        { upsert: mode === 'replace', new: true }
      );
      if (r) {
        // Either updated (existing) or created (upsert+replace mode)
        if (mode === 'replace') created += 1;
        else updated += 1;
      }
    } catch (err) {
      result.skipped += 1;
      logger.warn({ err: err.message, tradeId: id }, 'configBackup: position upsert failed');
    }
  }
  result.created = created;
  result.updated = updated;
  result.changed = created + updated;
  return result;
}

// ─── Section helpers: bots ────────────────────────────────────────────────────

async function backupBots() {
  const docs = await Bot.find({}).lean();
  const enabled = docs.filter((b) => b.enabled === true && !b.deletedAt).length;
  const softDeleted = docs.filter((b) => b.deletedAt).length;
  return { present: docs.length > 0, count: docs.length, enabled, softDeleted, data: docs };
}

async function restoreBots(data, mode = 'merge') {
  const result = { changed: 0, created: 0, updated: 0, skipped: 0 };
  if (!Array.isArray(data)) return { ...result, skipped: 0, error: 'bots data is not array' };

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const incoming of data) {
    const name = incoming.name;
    const symbol = String(incoming.symbol || '').toUpperCase();
    const timeframe = incoming.timeframe;
    if (!name || !symbol || !timeframe) { skipped += 1; continue; }

    // Find existing by natural key
    const existing = await Bot.findOne({ name, symbol, timeframe });
    if (existing) {
      if (mode === 'replace') {
        // Update all fields except _id, runtime state, and deletedAt
        const { _id, createdAt, updatedAt, deletedAt, ...rest } = incoming;
        // Merge mode for soft-delete: if incoming has deletedAt=null and existing has it set → revive
        const mergeDeletedAt = (incoming.deletedAt == null) ? null : (existing.deletedAt || incoming.deletedAt);
        await Bot.updateOne(
          { _id: existing._id },
          { $set: { ...rest, deletedAt: mergeDeletedAt } }
        );
        updated += 1;
      } else {
        // merge: only fill empty fields, preserve runtime state
        const set = {};
        for (const [k, v] of Object.entries(incoming)) {
          if (['createdAt', 'updatedAt', '__v'].includes(k)) continue;
          if (v === undefined || v === null) continue;
          const existingVal = existing[k];
          if (existingVal === undefined || existingVal === null || existingVal === '') {
            set[k] = v;
          }
        }
        // Always revive if incoming deletedAt=null and existing has deletedAt
        if (incoming.deletedAt == null && existing.deletedAt) {
          set.deletedAt = null;
        }
        if (Object.keys(set).length > 0) {
          await Bot.updateOne({ _id: existing._id }, { $set: set });
          updated += 1;
        } else {
          skipped += 1;
        }
      }
    } else {
      // No existing — create new (strip _id, use natural key)
      const { _id, createdAt, updatedAt, __v, ...rest } = incoming;
      try {
        const doc = new Bot({ ...rest, name, symbol, timeframe });
        await doc.save();
        created += 1;
      } catch (err) {
        skipped += 1;
        logger.warn({ err: err.message, name }, 'configBackup: bot create failed');
      }
    }
  }
  result.created = created;
  result.updated = updated;
  result.skipped = skipped;
  result.changed = created + updated;
  return result;
}

// ─── Section helpers: license (READ-ONLY) ─────────────────────────────────────

async function backupLicense() {
  const lic = licenseGate.lastLicense || null;
  const snapshot = await licenseService.snapshot().catch(() => null);
  if (!lic && !snapshot) {
    return { present: false, readonly: true, data: null };
  }
  return {
    present: true,
    readonly: true,
    data: {
      tier: lic?.tier || snapshot?.tier || null,
      owner: lic?.owner || null,
      expiresAt: lic?.expiresAt || null,
      features: lic?.features || snapshot?.features || {},
      hasLicense: !!lic,
      snapshotAt: new Date().toISOString(),
    },
  };
}

async function restoreLicense(/* data, mode */) {
  // License is admin-issued only — cannot be self-restored.
  return { skipped: 'license-cannot-be-restored', reason: 'License is admin-issued only' };
}

// ─── Section helpers: others (placeholder) ─────────────────────────────────────

async function backupOthers() {
  // Placeholder for future expansion (wallet, chartMonitor, etc.)
  return { present: false, note: 'Future expansion placeholder', data: {} };
}

async function restoreOthers(/* data, mode */) {
  return { skipped: 'others-placeholder', reason: 'No data to restore yet' };
}

// ─── Section dispatcher ──────────────────────────────────────────────────────

const _SECTION_FNS = {
  apiKeys: { backup: backupApiKeys, restore: restoreApiKeys },
  telegram: { backup: backupTelegram, restore: restoreTelegram },
  appConfig: { backup: backupAppConfig, restore: restoreAppConfig },
  positions: { backup: backupPositions, restore: restorePositions },
  bots: { backup: backupBots, restore: restoreBots },
  license: { backup: backupLicense, restore: restoreLicense },
  others: { backup: backupOthers, restore: restoreOthers },
};

/**
 * Build a full backup payload for the requested sections.
 * Returns the JSON-serializable object.
 */
async function buildBackupPayload({ sections = SUPPORTED_SECTIONS } = {}) {
  if (!Array.isArray(sections) || sections.length === 0) {
    sections = [...SUPPORTED_SECTIONS];
  }
  const unknown = sections.filter((s) => !SUPPORTED_SECTIONS.includes(s));
  if (unknown.length > 0) {
    const err = new Error(`Unknown sections: ${unknown.join(', ')}`);
    err.status = 400;
    throw err;
  }

  const sectionsData = {};
  for (const name of sections) {
    const fn = _SECTION_FNS[name];
    if (!fn) { sectionsData[name] = { present: false, error: 'unknown section' }; continue; }
    try {
      sectionsData[name] = await fn.backup();
    } catch (err) {
      logger.warn({ err: err.message, section: name }, 'configBackup: section backup failed');
      sectionsData[name] = { present: false, error: err.message };
    }
  }

  return {
    version: BACKUP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    appVersion: _getAppVersion(),
    createdAt: new Date().toISOString(),
    machineId: _getMachineId(),
    appName: 'OnePercentBotTrade',
    encryption: {
      algorithm: 'aes-256-gcm',
      note: 'Encrypted blobs (apiKeys, telegram token) require SAME ENCRYPTION_KEY env-var to decrypt on restore.',
    },
    sections: sectionsData,
  };
}

/**
 * Build a lightweight preview (counts/sizes only, no full data dumps).
 * Used by GET /api/admin/config/backup/preview.
 */
async function previewBackupPayload() {
  const counts = {};
  let totalSize = 0;
  for (const name of SUPPORTED_SECTIONS) {
    try {
      const fullSection = await _SECTION_FNS[name].backup();
      let count = 0;
      if (name === 'apiKeys' || name === 'telegram' || name === 'appConfig' || name === 'others') {
        count = fullSection.present ? 1 : 0;
      } else if (name === 'positions' || name === 'bots') {
        count = fullSection.count || 0;
      } else if (name === 'license') {
        count = fullSection.present ? 1 : 0;
      }
      counts[name] = { ...fullSection, sizeBytes: 0, count };
      // quick size estimate (only if present)
      if (fullSection.present && fullSection.data) {
        counts[name].sizeBytes = Buffer.byteLength(JSON.stringify(fullSection.data || {}), 'utf8');
      }
      totalSize += counts[name].sizeBytes;
    } catch (err) {
      counts[name] = { present: false, error: err.message, count: 0, sizeBytes: 0 };
    }
  }
  const warnings = [];
  if (!_encryptionAvailable()) {
    warnings.push('ENCRYPTION_KEY is too short (<32 chars) — encrypted blobs may fail to decrypt on restore');
  }
  warnings.push('License is read-only — restore will skip the license section');
  return {
    ok: true,
    supportedSections: SUPPORTED_SECTIONS,
    counts,
    machine: { id: _getMachineId() },
    encryptionAvailable: _encryptionAvailable(),
    totalSizeBytes: totalSize,
    warnings,
  };
}

/**
 * Build a restore preview (diff against current DB). No writes.
 */
async function previewRestorePayload(payload, sections) {
  const target = (Array.isArray(sections) && sections.length > 0) ? sections : SUPPORTED_SECTIONS;
  const out = {};
  const warnings = [];
  for (const name of target) {
    if (!SUPPORTED_SECTIONS.includes(name)) {
      out[name] = { error: `unknown section: ${name}` };
      continue;
    }
    const sec = (payload && payload.sections && payload.sections[name]) || null;
    if (!sec || sec.present === false) {
      out[name] = { willChange: false, willCreate: 0, willSkip: 0 };
      continue;
    }
    if (name === 'license') {
      out[name] = { willSkip: 'license-cannot-be-restored' };
      continue;
    }
    if (name === 'others') {
      out[name] = { willSkip: 'others-placeholder' };
      continue;
    }
    if (name === 'positions') {
      const arr = Array.isArray(sec.data) ? sec.data : [];
      out[name] = { willCreate: arr.length, willSkip: 0, openOnly: sec.openOnly === true };
      continue;
    }
    if (name === 'bots') {
      const arr = Array.isArray(sec.data) ? sec.data : [];
      out[name] = { willCreate: arr.length, willUpdate: 0, willSkip: 0 };
      continue;
    }
    // For apiKeys/telegram/appConfig — count populated fields
    const data = sec.data || {};
    const fieldCount = Object.keys(data).length;
    out[name] = { willChange: fieldCount > 0, fieldsToChange: fieldCount };
  }

  if (payload && payload.machineId && payload.machineId !== _getMachineId()) {
    warnings.push(`Backup created on machine ${payload.machineId} (current: ${_getMachineId()}) — encrypted blobs may not decrypt without matching ENCRYPTION_KEY`);
  }
  if (!_encryptionAvailable()) {
    warnings.push('ENCRYPTION_KEY is too short on this machine — apiKeys/telegram restore will write ciphertext that cannot be decrypted');
  }
  return { ok: true, sections: out, warnings, mode: 'preview' };
}

/**
 * Apply a restore to the database.
 * Returns { ok, results, preRestore }.
 */
async function applyRestore({ payload, sections, mode = 'merge', dryRun = false } = {}) {
  // Convention: sections=undefined/null → all sections; sections=[] → none (no-op); sections=[..] → those.
  const target = Array.isArray(sections) ? sections : SUPPORTED_SECTIONS;
  const results = {};
  let preRestore = null;

  if (!dryRun) {
    // Write pre-restore snapshot FIRST
    const snap = await writePreRestoreSnapshot(payload, target);
    if (!snap.ok) {
      const err = new Error(`Pre-restore snapshot write failed: ${snap.error}`);
      err.status = 500;
      throw err;
    }
    preRestore = { path: snap.path, sizeBytes: snap.sizeBytes };
  }

  for (const name of target) {
    if (!SUPPORTED_SECTIONS.includes(name)) {
      results[name] = { error: `unknown section: ${name}` };
      continue;
    }
    const fn = _SECTION_FNS[name];
    if (!fn) { results[name] = { error: 'no handler' }; continue; }
    const sec = (payload && payload.sections && payload.sections[name]) || null;
    if (!sec || sec.present === false) {
      results[name] = { skipped: 'not-present-in-backup', changed: 0, created: 0, updated: 0 };
      continue;
    }
    try {
      if (dryRun) {
        results[name] = { dryRun: true, willRestore: true, mode };
      } else {
        results[name] = await fn.restore(sec.data || sec, mode);
      }
    } catch (err) {
      logger.warn({ err: err.message, section: name }, 'configBackup: section restore failed');
      results[name] = { error: err.message, changed: 0, created: 0, updated: 0 };
    }
  }

  return { ok: true, results, preRestore, mode, dryRun };
}

/**
 * Write a pre-restore snapshot to data/configbackup-pre-restore-{ISO}.json.
 * Returns { ok, path, sizeBytes } or { ok: false, error }.
 */
async function writePreRestoreSnapshot(/* payload, sections */) {
  try {
    await fs.mkdir(PRE_RESTORE_DIR, { recursive: true });
  } catch (err) {
    return { ok: false, error: `mkdir failed: ${err.message}` };
  }

  // Build a fresh snapshot of CURRENT state for all sections (so the user can recover even if partial sections were affected)
  let snapshot;
  try {
    snapshot = await buildBackupPayload({ sections: SUPPORTED_SECTIONS });
  } catch (err) {
    return { ok: false, error: `snapshot build failed: ${err.message}` };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `configbackup-pre-restore-${stamp}.json`;
  const fullPath = path.join(PRE_RESTORE_DIR, filename);
  const text = JSON.stringify(snapshot, null, 2);

  try {
    await fs.writeFile(fullPath, text, 'utf8');
    return { ok: true, path: fullPath, sizeBytes: Buffer.byteLength(text, 'utf8') };
  } catch (err) {
    return { ok: false, error: `write failed: ${err.message}` };
  }
}

module.exports = {
  SCHEMA_VERSION,
  BACKUP_VERSION,
  SUPPORTED_SECTIONS,
  MAX_BACKUP_BYTES,
  OPEN_TRADE_STATES,
  parseBackupPayload,
  buildBackupPayload,
  previewBackupPayload,
  previewRestorePayload,
  applyRestore,
  writePreRestoreSnapshot,
  // Exported for tests
  _SECTION_FNS,
  API_KEY_FIELDS,
  TELEGRAM_FIELDS,
  APP_CONFIG_FIELDS,
  backupApiKeys,
  restoreApiKeys,
  backupTelegram,
  restoreTelegram,
  backupAppConfig,
  restoreAppConfig,
  backupPositions,
  restorePositions,
  backupBots,
  restoreBots,
  backupLicense,
  restoreLicense,
  backupOthers,
  restoreOthers,
};