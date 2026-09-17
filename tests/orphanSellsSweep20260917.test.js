'use strict';

/**
 * FIX-2026-09-17: orphan-SELL sweeper regression tests
 *
 * Background:
 *   - ZENUSDT (faiz) stuck in state='selling' for 8 days with SELL alive on Binance
 *     (LIMIT_MAKER GTC has no TTL). botManager.reconcilePendingTrades() had an explicit
 *     silent no-op at the SELL-alive + state='selling' branch (legacy fix to prevent
 *     double-fire on restart) — silent capital lock until manual cancel.
 *   - Phase C adds an age-based sweeper: if sellOrderId is NEW on Binance + state='selling'
 *     AND sellPlacedAt ageH >= AppConfig.orphanSellMaxAgeHours (default 24) →
 *     forceCloseTrade({source:'orphan-recovery-sweep'}) + override sellReason.
 *
 * This test guards against the same regression class by source-checking:
 *   1. AppConfig schema has 3 new fields (orphanSellMaxAgeHours + 2 telemetry)
 *   2. admin.routes whitelist accepts orphanSellMaxAgeHours + clamps to 1..168
 *   3. masterConfigModal.js exposes mc-orphanSellMaxAgeHours field
 *   4. saveMasterToggles() forwards orphanSellMaxAgeHours to PUT /api/admin/app-config
 *   5. botManager.js calls forceClose.forceCloseTrade with 'orphan-recovery-sweep' source
 *   6. botManager.js calls reconcileTelemetry.recordTick after sweep
 *   7. reconcileTelemetry.js persists to AppConfig.orphanRecoveryLastStats + LastRunAt
 *
 * All checks are source-level (file read + regex) — no DB/network — so the test runs
 * under 50ms and catches the 4-layer-whitelist-style regressions cheaply.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP_CONFIG_SRC = readSrc('src/db/models/AppConfig.js');
const ADMIN_ROUTES_SRC = readSrc('src/api/routes/admin.routes.js');
const MASTER_CONFIG_MODAL_SRC = readSrc('public/js/partials/masterConfigModal.js');
const BOT_MANAGER_SRC = readSrc('src/core/botManager.js');
const RECONCILE_TELEMETRY_SRC = readSrc('src/services/reconcileTelemetry.js');

describe('FIX-2026-09-17 orphan-SELL sweeper wiring', () => {
  describe('AppConfig schema', () => {
    test('declares orphanSellMaxAgeHours with 1..168 range', () => {
      // Match the field with type Number and min/max bounds
      expect(APP_CONFIG_SRC).toMatch(
        /orphanSellMaxAgeHours\s*:\s*\{\s*type\s*:\s*Number[\s\S]*?min\s*:\s*1[\s\S]*?max\s*:\s*168/s
      );
    });

    test('declares orphanRecoveryLastStats + LastRunAt telemetry fields', () => {
      expect(APP_CONFIG_SRC).toMatch(
        /orphanRecoveryLastStats\s*:\s*\{\s*type\s*:\s*Object\s*,\s*default\s*:\s*null\s*\}/s
      );
      expect(APP_CONFIG_SRC).toMatch(
        /orphanRecoveryLastRunAt\s*:\s*\{\s*type\s*:\s*Date\s*,\s*default\s*:\s*null\s*\}/s
      );
    });

    test('orphanSellMaxAgeHours has default 24 (matches backend reconcilePendingTrades fallback)', () => {
      expect(APP_CONFIG_SRC).toMatch(/orphanSellMaxAgeHours\s*:\s*\{\s*type\s*:\s*Number\s*,\s*default\s*:\s*24\b/);
    });
  });

  describe('admin.routes.js whitelist + clamp', () => {
    test('PUT /api/admin/app-config whitelist accepts orphanSellMaxAgeHours as number', () => {
      expect(ADMIN_ROUTES_SRC).toMatch(/orphanSellMaxAgeHours\s*:\s*['"]number['"]/);
    });

    test('orphanSellMaxAgeHours clamp 1..168 in admin.routes.js', () => {
      // The clamp pattern: Math.max(1, Math.min(168, set.orphanSellMaxAgeHours))
      const clamped = new RegExp(
        /set\.orphanSellMaxAgeHours\s*=\s*Math\.max\(\s*1\s*,\s*Math\.min\(\s*168\s*,\s*set\.orphanSellMaxAgeHours\s*\)\s*\)/
      );
      expect(ADMIN_ROUTES_SRC).toMatch(clamped);
    });
  });

  describe('masterConfigModal.js UI surface (closes 4-layer whitelist chain)', () => {
    test('MASTER_CONFIG_FIELDS exposes mc-orphanSellMaxAgeHours with 1..168 bounds', () => {
      // Match the field entry: id/key/label containing orphanSellMaxAgeHours
      const entry = new RegExp(
        /id\s*:\s*['"]mc-orphanSellMaxAgeHours['"][\s\S]{0,200}?key\s*:\s*['"]orphanSellMaxAgeHours['"][\s\S]{0,200}?max\s*:\s*['"]168['"]/
      );
      expect(MASTER_CONFIG_MODAL_SRC).toMatch(entry);
    });

    test('saveMasterToggles() forwards orphanSellMaxAgeHours to PUT /api/admin/app-config', () => {
      // The numeric input is read inside saveMasterToggles and added to payload
      const forwardPattern = /payload\.orphanSellMaxAgeHours\s*=\s*orphanVal/;
      expect(MASTER_CONFIG_MODAL_SRC).toMatch(forwardPattern);
      // And the input id is referenced in the read path
      expect(MASTER_CONFIG_MODAL_SRC).toMatch(/getElementById\(['"]mc-orphanSellMaxAgeHours['"]\)/);
    });
  });

  describe('botManager.js sweeper logic', () => {
    test('reconcilePendingTrades() reads orphanSellMaxAgeHours from AppConfig at sweep start', () => {
      // The sweep starts with reading threshold
      expect(BOT_MANAGER_SRC).toMatch(
        /AppConfig\.findOne\(\s*\{\s*key\s*:\s*['"]singleton['"]/
      );
      expect(BOT_MANAGER_SRC).toMatch(/orphanSellMaxAgeHours/);
    });

    test('sweeper calls forceClose.forceCloseTrade with source orphan-recovery-sweep', () => {
      // The force-close call inside the orphan branch must pass source='orphan-recovery-sweep'
      expect(BOT_MANAGER_SRC).toMatch(
        /forceClose\.forceCloseTrade\(\s*\{[\s\S]{0,200}source\s*:\s*['"]orphan-recovery-sweep['"]/
      );
    });

    test('sweeper overrides sellReason to orphan_recovery_sweeper after force-close', () => {
      expect(BOT_MANAGER_SRC).toMatch(
        /sellReason\s*:\s*['"]orphan_recovery_sweeper['"]/
      );
    });

    test('sweeper tracks scanned/cancelled/forced/errors counters', () => {
      // These counters must be incremented in the orphan branch
      const counterRe = (name) => new RegExp(`sweepStats\\.${name}\\+\\+`);
      expect(BOT_MANAGER_SRC).toMatch(counterRe('scanned'));
      expect(BOT_MANAGER_SRC).toMatch(counterRe('cancelled'));
      expect(BOT_MANAGER_SRC).toMatch(counterRe('forced'));
      expect(BOT_MANAGER_SRC).toMatch(counterRe('errors'));
    });

    test('sweeper calls reconcileTelemetry.recordTick after loop', () => {
      expect(BOT_MANAGER_SRC).toMatch(/require\(['"]\.\.\/services\/reconcileTelemetry['"]\)/);
      expect(BOT_MANAGER_SRC).toMatch(/reconcileTelemetry\.recordTick\(\s*sweepStats\s*\)/);
    });
  });

  describe('reconcileTelemetry.js persistence', () => {
    test('persists orphanRecoveryLastStats + orphanRecoveryLastRunAt to AppConfig singleton', () => {
      expect(RECONCILE_TELEMETRY_SRC).toMatch(/AppConfig\.updateOne\(/);
      expect(RECONCILE_TELEMETRY_SRC).toMatch(/orphanRecoveryLastStats/);
      expect(RECONCILE_TELEMETRY_SRC).toMatch(/orphanRecoveryLastRunAt/);
    });

    test('recordTick guards persist failure as warn log (no throw to caller)', () => {
      // The .catch on updateOne is critical — caller is reconcilePendingTrades which
      // should not crash on telemetry failure (non-essential)
      expect(RECONCILE_TELEMETRY_SRC).toMatch(/\.catch\(\s*\(err\)\s*=>\s*logger\.warn/);
    });
  });
});
