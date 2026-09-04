'use strict';

/**
 * FIX-2026-09-04: Default-alignment regression tests for CB family (round-5 audit followup).
 *
 * **User directive (2026-09-04):**
 *   "ลบ tier template ออกให้หมด ... ไม่มีการเข้ามาแทรกแซงจากแอกมิน"
 *
 * Round 4 (a6a8e5b) flipped botDefaults.js + tierTemplates.js + Bot.js:cbv5 + HTML defaults.
 * Round 5 (this file) guards the remaining alignment:
 *   - Bot.js schema defaults for cbv2Enabled + cbv3Enabled
 *   - admin.routes.js BOT_DEFAULTS_SCHEMA (Reset-bot-defaults button)
 *   - settings.js BD_RECOMMENDED (Reset-to-recommended button)
 *   - trader.js Branch B (forceCBv5) — must respect master toggle
 *
 * These tests are text-based contract tests — they read the source files and assert
 * the default values match the user directive. Cheaper than spinning up MongoDB +
 * DOM mocks, and they catch drift early.
 *
 * **Failure modes caught:**
 *   - Schema default drift (someone reverts Bot.js default to true)
 *   - "Reset to recommended/bot-defaults" button silently re-enables CB family
 *   - Branch B bypassing master CBv5 toggle (forceCBv5 can turn CBv5 ON even when
 *     admin disabled the global master switch)
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

describe('CB family default alignment (FIX-2026-09-04 audit followup)', () => {
  describe('Bot.js schema defaults (cbv2/cbv3 = false)', () => {
    let schemaSrc;
    beforeAll(() => {
      schemaSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'src/db/models/Bot.js'),
        'utf8'
      );
    });

    test('cbv2Enabled schema default is false (was true — caused invisible divergence with cbEnabled=false)', () => {
      const match = schemaSrc.match(/cbv2Enabled:\s*\{\s*type:\s*Boolean,\s*default:\s*(true|false)/);
      expect(match).not.toBeNull();
      expect(match[1]).toBe('false');
    });

    test('cbv3Enabled schema default is false (was true — LISTA hit by CBv3 today)', () => {
      const match = schemaSrc.match(/cbv3Enabled:\s*\{\s*type:\s*Boolean,\s*default:\s*(true|false)/);
      expect(match).not.toBeNull();
      expect(match[1]).toBe('false');
    });

    test('cbv5Enabled schema default is still false (round-1 regression guard)', () => {
      const match = schemaSrc.match(/cbv5Enabled:\s*\{\s*type:\s*Boolean,\s*default:\s*(true|false)/);
      expect(match).not.toBeNull();
      expect(match[1]).toBe('false');
    });
  });

  describe('admin.routes.js BOT_DEFAULTS_SCHEMA (cbv2/cbv3 = false)', () => {
    let src;
    beforeAll(() => {
      src = fs.readFileSync(
        path.join(REPO_ROOT, 'src/api/routes/admin.routes.js'),
        'utf8'
      );
    });

    test('BOT_DEFAULTS_SCHEMA cbv2Enabled: false (was true — Reset button would flip new bots ON)', () => {
      const re = /BOT_DEFAULTS_SCHEMA\s*=\s*\{[\s\S]*?cbv2Enabled:\s*(true|false)/;
      const match = src.match(re);
      expect(match).not.toBeNull();
      expect(match[1]).toBe('false');
    });

    test('BOT_DEFAULTS_SCHEMA cbv3Enabled: false', () => {
      const re = /BOT_DEFAULTS_SCHEMA\s*=\s*\{[\s\S]*?cbv3Enabled:\s*(true|false)/;
      const match = src.match(re);
      expect(match).not.toBeNull();
      expect(match[1]).toBe('false');
    });

    test('BOT_DEFAULTS_SCHEMA cbv5Enabled: false (round-1 regression guard)', () => {
      const re = /BOT_DEFAULTS_SCHEMA\s*=\s*\{[\s\S]*?cbv5Enabled:\s*(true|false)/;
      const match = src.match(re);
      expect(match).not.toBeNull();
      expect(match[1]).toBe('false');
    });
  });

  describe('settings.js BD_RECOMMENDED (cbv2/cbv3 = false)', () => {
    let src;
    beforeAll(() => {
      src = fs.readFileSync(
        path.join(REPO_ROOT, 'public/js/pages/settings.js'),
        'utf8'
      );
    });

    test('BD_RECOMMENDED cbv2Enabled: false', () => {
      const re = /BD_RECOMMENDED\s*=\s*\{[\s\S]*?cbv2Enabled:\s*(true|false)/;
      const match = src.match(re);
      expect(match).not.toBeNull();
      expect(match[1]).toBe('false');
    });

    test('BD_RECOMMENDED cbv3Enabled: false', () => {
      const re = /BD_RECOMMENDED\s*=\s*\{[\s\S]*?cbv3Enabled:\s*(true|false)/;
      const match = src.match(re);
      expect(match).not.toBeNull();
      expect(match[1]).toBe('false');
    });

    test('BD_RECOMMENDED cbv5Enabled: false (round-1 regression guard)', () => {
      const re = /BD_RECOMMENDED\s*=\s*\{[\s\S]*?cbv5Enabled:\s*(true|false)/;
      const match = src.match(re);
      expect(match).not.toBeNull();
      expect(match[1]).toBe('false');
    });
  });

  describe('trader.js pre-BUY CBv5 — Branch B master toggle check (FIX-2026-09-04)', () => {
    let src;
    let block;
    beforeAll(() => {
      src = fs.readFileSync(
        path.join(REPO_ROOT, 'src/core/trader.js'),
        'utf8'
      );
      // Locate the pre-BUY CBv5 block: starts at `cbv5AutoTimingForce = this._autoTimingDecision?.forceCBv5`
      // and ends just before `fetchAndEvaluateCBv5`. Capture the AND/OR chain.
      const blockMatch = src.match(/const cbv5AutoTimingForce[\s\S]{0,2500}?cbPatternEvaluator\.fetchAndEvaluateCBv5/);
      expect(blockMatch).not.toBeNull();
      block = blockMatch[0];
    });

    test('Block found: pre-BUY CBv5 chain located in trader.js', () => {
      expect(block).toContain('cbv5AutoTimingForce');
      expect(block).toContain('cbv5PreGate');
      expect(block).toContain('licenseService.isFeatureEnabled(\'cbv5\')');
    });

    test('Branch A (cbv5Enabled !== false clause) includes cbv5MasterToggle.isMasterCbv5Enabled()', () => {
      // First clause of the OR. Should check master toggle.
      const branchA = block.match(/\(this\.bot\.cbv5Enabled[\s\S]{0,500}?isMasterCbv5Enabled\(\)/);
      expect(branchA).not.toBeNull();
    });

    test('Branch B (forceCBv5 clause) includes cbv5MasterToggle.isMasterCbv5Enabled() — FIX-2026-09-04', () => {
      // Second clause of the OR. Previously did NOT check master toggle — fixed today.
      const branchB = block.match(/\(cbv5AutoTimingForce[\s\S]{0,300}?await\s+cbv5MasterToggle\.isMasterCbv5Enabled\(\)/);
      expect(branchB).not.toBeNull();
    });

    test('No silent divergence: pre-BUY CBv5 block has exactly 2 isMasterCbv5Enabled() checks (Branch A + Branch B)', () => {
      // Each branch must independently respect master toggle — guard against future drift.
      const masterToggleCount = (block.match(/isMasterCbv5Enabled\(\)/g) || []).length;
      expect(masterToggleCount).toBe(2);
    });
  });
});
