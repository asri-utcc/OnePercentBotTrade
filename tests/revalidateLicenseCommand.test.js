'use strict';

/**
 * FIX-2026-09-01 audit H5: admin tier/license edit → immediate bot re-validation.
 *
 *   Before: when admin PATCHed a license (tier/maxBots/maxCapital/features),
 *     the bot's `_lastValidLicense` cache stayed stale until the next periodic
 *     re-validate (REVALIDATE_MS = 1h). During that window the user kept
 *     trading under the OLD tier's caps (e.g. pro maxCapital=10000 still active
 *     after admin downgraded to basic maxCapital=100).
 *
 *   After: admin queues a `revalidate_license` command for every machine on the
 *     licenseKey. The bot's commandExecutor handler calls licenseGate.validate()
 *     synchronously → cache updates within ≤ADMIN_POLL_MS (default 60s).
 *
 *   This test verifies the BOT-SIDE handler:
 *     - calls licenseGate.validate({throwOnFail:false})
 *     - emits 'license:revalidated' event with the new tier
 *     - returns ok:true when validate succeeds
 *     - returns ok:false when validate returns null (license revoked/invalid)
 *     - handles require() failure gracefully
 *     - includes the changes[] list in the return payload (for audit)
 */

const eventBus = require('../src/services/eventBus');

jest.mock('../src/admin-monitor/licenseGate', () => ({
  validate: jest.fn(),
}));

const licenseGate = require('../src/admin-monitor/licenseGate');
const { handlers } = require('../src/admin-monitor/commandExecutor');

describe('audit-H5 commandExecutor.revalidate_license (FIX-2026-09-01)', () => {
  let emitted;
  let emitSpy;

  beforeEach(() => {
    licenseGate.validate.mockReset();
    emitted = [];
    emitSpy = jest.spyOn(eventBus, 'emit').mockImplementation((evt, payload) => {
      emitted.push({ event: evt, payload });
    });
  });

  afterEach(() => {
    emitSpy.mockRestore();
  });

  function makeCtx() {
    return {
      botManager: { pause: jest.fn(), resume: jest.fn(), setConfig: jest.fn() },
      eventBus,
    };
  }

  test('calls licenseGate.validate() with throwOnFail:false', async () => {
    licenseGate.validate.mockResolvedValueOnce({ license: { tier: 'pro' } });
    const ctx = makeCtx();
    await handlers.revalidate_license({}, ctx);
    expect(licenseGate.validate).toHaveBeenCalledWith({ throwOnFail: false });
  });

  test('returns ok:true + new tier when validate succeeds', async () => {
    licenseGate.validate.mockResolvedValueOnce({ license: { tier: 'basic' }, machine: { status: 'online' } });
    const ctx = makeCtx();
    const r = await handlers.revalidate_license({ reason: 'tier_downgrade' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.validated).toBe(true);
    expect(r.tier).toBe('basic');
    expect(r.action).toBe('revalidate_license');
    expect(r.changes).toEqual([]);
  });

  test('returns ok:false when validate returns null (revoked/invalid)', async () => {
    licenseGate.validate.mockResolvedValueOnce(null);
    const ctx = makeCtx();
    const r = await handlers.revalidate_license({ reason: 'license_expired' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.validated).toBe(false);
    expect(r.tier).toBe(null);
  });

  test('emits license:revalidated event with new tier + features + changes', async () => {
    licenseGate.validate.mockResolvedValueOnce({
      license: {
        tier: 'enterprise',
        features: { telegram: true, cbv5: true, autoReserve: false },
      },
    });
    const ctx = makeCtx();
    await handlers.revalidate_license(
      { reason: 'feature_toggle', changes: ['features.autoReserve', 'tier'] },
      ctx
    );
    const evt = emitted.find((e) => e.event === 'license:revalidated');
    expect(evt).toBeDefined();
    expect(evt.payload.tier).toBe('enterprise');
    expect(evt.payload.features.autoReserve).toBe(false);
    expect(evt.payload.changes).toEqual(['features.autoReserve', 'tier']);
    expect(evt.payload.validated).toBe(true);
    expect(typeof evt.payload.ts).toBe('number');
  });

  test('handles validate() throw without crashing (returns ok:false)', async () => {
    licenseGate.validate.mockRejectedValueOnce(new Error('network timeout'));
    const ctx = makeCtx();
    const r = await handlers.revalidate_license({ reason: 'network_blip' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.validated).toBe(false);
  });

  test('changes array is coerced to string list (audit-safe)', async () => {
    licenseGate.validate.mockResolvedValueOnce({ license: { tier: 'pro' } });
    const ctx = makeCtx();
    const r = await handlers.revalidate_license(
      { changes: ['tier', 42, null, 'features.cb'] },
      ctx
    );
    expect(r.changes).toEqual(['tier', '42', 'null', 'features.cb']);
  });

  test('default reason is "admin_license_edit" (audit-friendly default)', async () => {
    licenseGate.validate.mockResolvedValueOnce({ license: { tier: 'pro' } });
    const ctx = makeCtx();
    const r = await handlers.revalidate_license({}, ctx);
    expect(r.changes).toEqual([]);
    expect(r.validated).toBe(true);
    const evt = emitted.find((e) => e.event === 'license:revalidated');
    expect(evt.payload.reason).toBe('admin_license_edit');
  });
});

describe('audit-H5 source-level: handler is registered in commandExecutor', () => {
  const fs = require('fs');
  const path = require('path');
  const EXEC_PATH = path.join(__dirname, '..', 'src', 'admin-monitor', 'commandExecutor.js');

  test('FIX-2026-09-01 audit H5 comment present in source', () => {
    const src = fs.readFileSync(EXEC_PATH, 'utf8');
    expect(src).toMatch(/FIX-2026-09-01 audit H5/);
  });

  test('revalidate_license handler is wired into handlers map', () => {
    const src = fs.readFileSync(EXEC_PATH, 'utf8');
    expect(src).toMatch(/async\s+revalidate_license\s*\(/);
  });
});
