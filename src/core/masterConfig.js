'use strict';

/**
 * FIX-2026-08-08: Master Config helper — central source of truth for system-level toggles
 *   - reads AppConfig once per 30s (cached)
 *   - used by DPS evaluate, CB auto-unlock, auto-delete-bot
 *   - returns false for any unset field (defensive)
 *
 * Toggles:
 *   - masterDynamicSizeEnabled: default true (DPS on)
 *   - masterCbAutoUnlockEnabled: default false (user must opt-in globally)
 *   - masterAutoDeleteBotEnabled: alias of AppConfig.autoDeleteBotEnabled (already exists)
 */

const AppConfig = require('../db/models/AppConfig');
const dps = require('./dynamicPositionSizing');
const dlc = require('./dlc');
const logger = require('../utils/logger');

const CACHE_MS = 30 * 1000;
const _cache = {
  at: 0,
  masterDynamicSizeEnabled: true,
  masterCbAutoUnlockEnabled: false,
  masterAutoDeleteBotEnabled: false,
  // FIX-2026-09-04: DLC master kill-switch (default false — opt-in rollout)
  masterDlcEnabled: false,
};

// FIX-2026-08-08 (rev2): DPS tunables cache — แยก slot แต่ใช้ TTL เดียวกัน
const _dpsCache = {
  at: 0,
  cfg: dps.normalizeConfig(null), // = DEFAULTS
};

// FIX-2026-09-04: DLC tunables cache — same TTL as DPS, own slot
const _dlcCache = {
  at: 0,
  cfg: dlc.normalizeConfig(null), // = DEFAULTS
};

/**
 * FIX-2026-08-08 (rev2): map AppConfig doc → DPS engine config
 *   - field ที่ไม่มี/เป็น null → normalizeConfig() จะ fallback เป็น DEFAULTS ให้เอง
 *   - dpsCooldownMinutes (นาที, UI) → cooldownMs (engine)
 */
function _mapDpsConfig(cfg) {
  if (!cfg) return dps.normalizeConfig(null);
  const cooldownMin = Number(cfg.dpsCooldownMinutes);
  return dps.normalizeConfig({
    minSize: cfg.dpsMinSize,
    maxSize: cfg.dpsMaxSize,
    cooldownMs: Number.isFinite(cooldownMin) ? cooldownMin * 60 * 1000 : null,
    winStreakCount: cfg.dpsWinStreakCount,
    winStreakDeltaSize: cfg.dpsWinStreakDeltaSize,
    bigWinCount: cfg.dpsBigWinCount,
    bigWinPct: cfg.dpsBigWinPct,
    bigWinDeltaSize: cfg.dpsBigWinDeltaSize,
    lossStreakCount: cfg.dpsLossStreakCount,
    lossDeltaSize: cfg.dpsLossDeltaSize,
    respectBotCapital: cfg.dpsRespectBotCapital,
    resetHistoryOnFire: cfg.dpsResetHistoryOnFire,
    dryRun: cfg.dpsDryRun,
  });
}

// FIX-2026-09-04: map AppConfig doc → DLC engine config
function _mapDlcConfig(cfg) {
  if (!cfg) return dlc.normalizeConfig(null);
  return dlc.normalizeConfig({
    baseLossPct: cfg.dlcBaseLossPct,
  });
}

async function getMasterToggles() {
  const now = Date.now();
  if ((now - _cache.at) < CACHE_MS) return _cache;
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (cfg) {
      _cache.masterDynamicSizeEnabled = cfg.masterDynamicSizeEnabled !== false; // default true
      _cache.masterCbAutoUnlockEnabled = cfg.masterCbAutoUnlockEnabled === true;  // default false
      _cache.masterAutoDeleteBotEnabled = cfg.autoDeleteBotEnabled === true;      // default false
      // FIX-2026-09-04: DLC master gate
      _cache.masterDlcEnabled = cfg.masterDlcEnabled === true; // default false (opt-in)
      // อ่านรอบเดียว → เติม DPS cache ไปเลย (ประหยัด query)
      _dpsCache.cfg = _mapDpsConfig(cfg);
      _dpsCache.at = now;
      // FIX-2026-09-04: same trick for DLC cache
      _dlcCache.cfg = _mapDlcConfig(cfg);
      _dlcCache.at = now;
    }
    _cache.at = now;
  } catch (err) {
    logger.warn({ err: err.message }, 'masterConfig: AppConfig read failed, using cached/default');
  }
  return _cache;
}

/**
 * FIX-2026-08-08 (rev2): getDpsConfig — DPS tunables (cache 30s เหมือน master toggles)
 *   - fail-safe: อ่าน DB ไม่ได้ → คืนค่า cache เดิม/DEFAULTS (DPS ไม่มีวันพังเพราะ config)
 */
async function getDpsConfig() {
  const now = Date.now();
  if ((now - _dpsCache.at) < CACHE_MS) return _dpsCache.cfg;
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    _dpsCache.cfg = _mapDpsConfig(cfg);
    _dpsCache.at = now;
  } catch (err) {
    logger.warn({ err: err.message }, 'masterConfig: DPS config read failed, using cached/default');
  }
  return _dpsCache.cfg;
}

/**
 * FIX-2026-09-04: getDlcConfig — DLC tunables (cache 30s, mirrors getDpsConfig)
 *   - fail-safe: อ่าน DB ไม่ได้ → คืนค่า cache เดิม/DEFAULTS
 */
async function getDlcConfig() {
  const now = Date.now();
  if ((now - _dlcCache.at) < CACHE_MS) return _dlcCache.cfg;
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    _dlcCache.cfg = _mapDlcConfig(cfg);
    _dlcCache.at = now;
  } catch (err) {
    logger.warn({ err: err.message }, 'masterConfig: DLC config read failed, using cached/default');
  }
  return _dlcCache.cfg;
}

function invalidateCache() {
  _cache.at = 0;
  _dpsCache.at = 0;
  _dlcCache.at = 0;
}

module.exports = {
  getMasterToggles,
  getDpsConfig,
  getDlcConfig,
  invalidateCache,
};
