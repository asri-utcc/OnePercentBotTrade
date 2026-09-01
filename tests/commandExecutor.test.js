'use strict';

/**
 * FIX-2026-08-27 Bug A/B/C: tests for src/admin-monitor/commandExecutor.js
 *
 *   Covers:
 *     - show_message emits admin:message + fires Telegram best-effort (Bug A)
 *     - pause/resume delegate to botManager
 *     - force_close_all delegates and reports closedCount
 *     - kill schedules process.exit (mocked)
 *     - update_config applies only safe keys (whitelist enforced)
 *     - revoke_license pauses + emits event + sets licenseRevoked flag
 *     - notify_unauthorized sends via telegramDirectNotify (existing behaviour preserved)
 *     - execute() throws on unknown command type
 *     - execute() no longer calls verifySignature (Bug B — moved to listener)
 */

const path = require('path');

const mockEmit = jest.fn();
const mockTelegramSend = jest.fn().mockResolvedValue(true);

jest.mock('../src/services/eventBus', () => ({
  getEventBus: () => ({ emit: mockEmit, on: jest.fn(), removeAllListeners: jest.fn() }),
}));

jest.mock('../src/services/telegramDirectNotify', () => ({
  sendAdminMessage: mockTelegramSend,
}));

const executor = require('../src/admin-monitor/commandExecutor');

function buildCtx(overrides = {}) {
  return {
    botManager: {
      pause: jest.fn(),
      resume: jest.fn(),
      kill: jest.fn(),
      forceCloseAll: jest.fn().mockResolvedValue(7),
      setConfig: jest.fn(),
    },
    eventBus: { emit: mockEmit },
    ...overrides,
  };
}

beforeEach(() => {
  mockEmit.mockClear();
  mockTelegramSend.mockClear();
});

describe('commandExecutor.pause / resume', () => {
  test('pause calls botManager.pause with reason', async () => {
    const ctx = buildCtx();
    const r = await executor.execute({ commandId: 'c1', type: 'pause', payload: { reason: 'manual' } }, ctx);
    expect(ctx.botManager.pause).toHaveBeenCalledWith('manual');
    expect(r).toEqual({ ok: true, action: 'paused' });
  });

  test('pause defaults reason to "admin_command"', async () => {
    const ctx = buildCtx();
    await executor.execute({ commandId: 'c1', type: 'pause' }, ctx);
    expect(ctx.botManager.pause).toHaveBeenCalledWith('admin_command');
  });

  test('resume calls botManager.resume', async () => {
    const ctx = buildCtx();
    const r = await executor.execute({ commandId: 'c2', type: 'resume' }, ctx);
    expect(ctx.botManager.resume).toHaveBeenCalled();
    expect(r).toEqual({ ok: true, action: 'resumed' });
  });

  test('pause tolerates missing botManager (no throw)', async () => {
    const ctx = buildCtx({ botManager: undefined });
    const r = await executor.execute({ commandId: 'c1', type: 'pause' }, ctx);
    expect(r.ok).toBe(true);
  });
});

describe('commandExecutor.kill (FIX-2026-09-01 audit C12: graceful vs force)', () => {
  test('default (force=false) signals SIGTERM (graceful path)', async () => {
    jest.useFakeTimers();
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    try {
      const ctx = buildCtx();
      const r = await executor.execute({ commandId: 'k1', type: 'kill', payload: { reason: 'test' } }, ctx);
      expect(ctx.botManager.kill).not.toHaveBeenCalled(); // botManager has no .kill() — we use SIGTERM
      expect(r.action).toBe('killing_graceful');
      expect(r.reason).toBe('test');
      // Advance fake clock to flush the scheduled process.kill
      jest.advanceTimersByTime(200);
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
      killSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test('force=true calls process.exit(1) immediately (no graceful flush)', async () => {
    jest.useFakeTimers();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const ctx = buildCtx();
      const r = await executor.execute({ commandId: 'k2', type: 'kill', payload: { reason: 'emergency', force: true } }, ctx);
      expect(r.action).toBe('killing_force');
      expect(r.reason).toBe('emergency');
      jest.advanceTimersByTime(200);
      expect(exitSpy).toHaveBeenCalledWith(1);
      // SIGTERM must NOT have been called in force mode
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
      exitSpy.mockRestore();
      killSpy.mockRestore();
    }
  });

  test('force=false is the safe default — even if no reason is provided', async () => {
    jest.useFakeTimers();
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    try {
      const ctx = buildCtx();
      const r = await executor.execute({ commandId: 'k3', type: 'kill', payload: {} }, ctx);
      expect(r.action).toBe('killing_graceful');
      expect(r.reason).toBe('admin_kill');
      jest.advanceTimersByTime(200);
      expect(killSpy).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
      killSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe('commandExecutor.force_close_all', () => {
  test('returns closedCount from botManager.forceCloseAll', async () => {
    const ctx = buildCtx();
    const r = await executor.execute({ commandId: 'f1', type: 'force_close_all', payload: { reason: 'risk' } }, ctx);
    expect(ctx.botManager.forceCloseAll).toHaveBeenCalledWith('risk');
    expect(r).toEqual({ ok: true, action: 'force_close_all', closedCount: 7 });
  });

  test('closedCount is null when botManager returns undefined', async () => {
    const ctx = buildCtx();
    ctx.botManager.forceCloseAll.mockResolvedValue(undefined);
    const r = await executor.execute({ commandId: 'f1', type: 'force_close_all' }, ctx);
    expect(r.closedCount).toBeNull();
  });
});

describe('commandExecutor.show_message (FIX-2026-08-27 Bug A)', () => {
  test('emits admin:message event with message + level + ts + source', async () => {
    const ctx = buildCtx();
    const r = await executor.execute(
      { commandId: 'm1', type: 'show_message', payload: { message: 'Hello user' } },
      ctx
    );
    expect(mockEmit).toHaveBeenCalledWith('admin:message', expect.objectContaining({
      message: 'Hello user',
      level: 'info',
      source: 'admin',
      ts: expect.any(Number),
    }));
    expect(r.ok).toBe(true);
    expect(r.message).toBe('Hello user');
  });

  test('defaults missing message to empty string (no crash)', async () => {
    const ctx = buildCtx();
    const r = await executor.execute({ commandId: 'm1', type: 'show_message' }, ctx);
    expect(r.message).toBe('');
    expect(mockEmit).toHaveBeenCalledWith('admin:message', expect.objectContaining({ message: '' }));
  });

  test('level=warn passes through', async () => {
    const ctx = buildCtx();
    await executor.execute(
      { commandId: 'm1', type: 'show_message', payload: { message: 'warn pls', level: 'warn' } },
      ctx
    );
    expect(mockEmit).toHaveBeenCalledWith('admin:message', expect.objectContaining({ level: 'warn' }));
  });

  test('level=error passes through', async () => {
    const ctx = buildCtx();
    await executor.execute(
      { commandId: 'm1', type: 'show_message', payload: { message: 'fatal', level: 'error' } },
      ctx
    );
    expect(mockEmit).toHaveBeenCalledWith('admin:message', expect.objectContaining({ level: 'error' }));
  });

  test('invalid level falls back to info', async () => {
    const ctx = buildCtx();
    await executor.execute(
      { commandId: 'm1', type: 'show_message', payload: { message: 'x', level: 'screaming' } },
      ctx
    );
    expect(mockEmit).toHaveBeenCalledWith('admin:message', expect.objectContaining({ level: 'info' }));
  });

  test('best-effort Telegram send fires (fire-and-forget)', async () => {
    const ctx = buildCtx();
    await executor.execute(
      { commandId: 'm1', type: 'show_message', payload: { message: 'tg please' } },
      ctx
    );
    // The promise is scheduled async; wait one microtask flush.
    await new Promise(process.nextTick);
    expect(mockTelegramSend).toHaveBeenCalledWith(expect.stringContaining('tg please'));
  });

  test('telegram failure does NOT break show_message (returns ok:true)', async () => {
    mockTelegramSend.mockRejectedValueOnce(new Error('tg boom'));
    const ctx = buildCtx();
    const r = await executor.execute(
      { commandId: 'm1', type: 'show_message', payload: { message: 'still works' } },
      ctx
    );
    expect(r.ok).toBe(true);
    expect(mockEmit).toHaveBeenCalled(); // eventBus emit happened
  });

  test('missing eventBus does not throw', async () => {
    const ctx = buildCtx({ eventBus: undefined });
    const r = await executor.execute(
      { commandId: 'm1', type: 'show_message', payload: { message: 'silent' } },
      ctx
    );
    expect(r.ok).toBe(true);
  });

  test('number message is coerced to string (defensive)', async () => {
    const ctx = buildCtx();
    const r = await executor.execute(
      { commandId: 'm1', type: 'show_message', payload: { message: 42 } },
      ctx
    );
    expect(r.message).toBe('42');
  });
});

describe('commandExecutor.update_config', () => {
  test('applies only safe keys from whitelist', async () => {
    const ctx = buildCtx();
    const r = await executor.execute({
      commandId: 'u1',
      type: 'update_config',
      payload: {
        config: {
          logLevel: 'debug',
          'feature:scanVolatility': true,
          autoReserveEnabled: true,
          unsafeKey: 'should-be-ignored',
          pauseNewPositions: true, // not whitelisted
        },
      },
    }, ctx);
    expect(r.applied).toEqual({
      logLevel: 'debug',
      'feature:scanVolatility': true,
      autoReserveEnabled: true,
    });
    expect(ctx.botManager.setConfig).toHaveBeenCalledWith('logLevel', 'debug');
    expect(ctx.botManager.setConfig).toHaveBeenCalledWith('feature:scanVolatility', true);
    expect(ctx.botManager.setConfig).toHaveBeenCalledWith('autoReserveEnabled', true);
    expect(ctx.botManager.setConfig).not.toHaveBeenCalledWith('unsafeKey', expect.anything());
    expect(ctx.botManager.setConfig).not.toHaveBeenCalledWith('pauseNewPositions', expect.anything());
  });

  test('empty config returns empty applied map', async () => {
    const ctx = buildCtx();
    const r = await executor.execute({ commandId: 'u1', type: 'update_config' }, ctx);
    expect(r.applied).toEqual({});
    expect(ctx.botManager.setConfig).not.toHaveBeenCalled();
  });
});

describe('commandExecutor.revoke_license', () => {
  test('pauses bot + sets licenseRevoked + emits admin:license_revoked', async () => {
    const ctx = buildCtx();
    const r = await executor.execute({ commandId: 'r1', type: 'revoke_license', payload: { reason: 'tos' } }, ctx);
    expect(ctx.botManager.pause).toHaveBeenCalledWith('license_revoked');
    expect(ctx.botManager.setConfig).toHaveBeenCalledWith('licenseRevoked', true);
    expect(mockEmit).toHaveBeenCalledWith('admin:license_revoked', expect.objectContaining({ reason: 'tos' }));
    expect(r.action).toBe('revoked');
  });
});

describe('commandExecutor.notify_unauthorized', () => {
  test('sends telegram via telegramDirectNotify', async () => {
    const ctx = buildCtx();
    const r = await executor.execute({
      commandId: 'n1',
      type: 'notify_unauthorized',
      payload: { reason: 'license_violation', suspendAt: '2026-08-27T12:00:00Z' },
    }, ctx);
    expect(mockTelegramSend).toHaveBeenCalledTimes(1);
    const sentText = mockTelegramSend.mock.calls[0][0];
    expect(sentText).toContain('UNAUTHORIZED');
    expect(sentText).toContain('license_violation');
    expect(r.ok).toBe(true);
    expect(r.telegramSent).toBe(true);
  });

  test('customMessage overrides default text', async () => {
    const ctx = buildCtx();
    await executor.execute({
      commandId: 'n1',
      type: 'notify_unauthorized',
      payload: { reason: 'x', message: 'CUSTOM OVERRIDE' },
    }, ctx);
    expect(mockTelegramSend).toHaveBeenCalledWith('CUSTOM OVERRIDE');
  });
});

describe('commandExecutor.force_reconsent (FIX-2026-08-30 Phase 3b-7)', () => {
  test('pauses bot + invokes forceReset; returns expected shape', async () => {
    const ctx = buildCtx();
    ctx.botManager.pause.mockResolvedValue({ ok: true, alreadyPaused: false });
    const r = await executor.execute({
      commandId: 'fr1',
      type: 'force_reconsent',
      payload: { reason: 'admin_reset_consent', port: 6015 },
    }, ctx);
    expect(ctx.botManager.pause).toHaveBeenCalledWith('admin_reset_consent');
    expect(r.action).toBe('force_reconsent');
    expect(r.paused).toBe(true);
    expect(r.alreadyPaused).toBe(false);
    expect(r.fileDeleted).toBe(true); // real storage.delete() ran against test env
    expect(r.reason).toBe('admin_reset_consent');
    expect(r.port).toBe(6015);
  });

  test('defaults reason to admin_force_reconsent', async () => {
    const ctx = buildCtx();
    await executor.execute({ commandId: 'fr1', type: 'force_reconsent' }, ctx);
    expect(ctx.botManager.pause).toHaveBeenCalledWith('admin_force_reconsent');
  });

  test('defaults port to 6015', async () => {
    const ctx = buildCtx();
    const r = await executor.execute({ commandId: 'fr1', type: 'force_reconsent' }, ctx);
    expect(r.port).toBe(6015);
  });

  test('returns alreadyPaused=true on second invocation', async () => {
    const ctx = buildCtx();
    ctx.botManager.pause.mockResolvedValueOnce({ ok: true, alreadyPaused: false });
    ctx.botManager.pause.mockResolvedValueOnce({ ok: true, alreadyPaused: true });
    await executor.execute({ commandId: 'fr1', type: 'force_reconsent' }, ctx);
    const r2 = await executor.execute({ commandId: 'fr2', type: 'force_reconsent' }, ctx);
    expect(r2.alreadyPaused).toBe(true);
  });

  test('returns paused=false when botManager missing', async () => {
    const ctx = buildCtx({ botManager: undefined });
    const r = await executor.execute({ commandId: 'fr1', type: 'force_reconsent' }, ctx);
    expect(r.paused).toBe(false);
  });

  test('tolerates botManager.pause throwing (no handler crash)', async () => {
    const ctx = buildCtx();
    ctx.botManager.pause.mockRejectedValue(new Error('pause boom'));
    const r = await executor.execute({ commandId: 'fr1', type: 'force_reconsent' }, ctx);
    expect(r).toBeDefined();
    expect(r.action).toBe('force_reconsent');
  });

  test('isAwaitingReconsent is set after force_reconsent; cleared after recordDecision(accepted)', async () => {
    const consentHandlers = require('../src/consent/handlers');
    const ctx = buildCtx();
    await executor.execute({ commandId: 'fr1', type: 'force_reconsent' }, ctx);
    expect(consentHandlers.isAwaitingReconsent()).toBe(true);
    // Simulate user accepting via overlay
    await consentHandlers.recordDecision({ decision: 'accepted', port: 6015, source: 'settings_change' });
    expect(consentHandlers.isAwaitingReconsent()).toBe(false);
  });
});

describe('commandExecutor.execute — guard rails', () => {
  test('throws on unknown command type', async () => {
    const ctx = buildCtx();
    await expect(
      executor.execute({ commandId: 'x', type: 'made_up' }, ctx)
    ).rejects.toThrow(/Unknown command type/);
  });

  test('FIX-2026-08-27 Bug B: execute() does NOT verify signature (listener does)', async () => {
    // We pass a deliberately forged signature — executor must still run because
    // signature verification has been moved to commandListener.
    const ctx = buildCtx();
    const r = await executor.execute({
      commandId: 'p1',
      type: 'pause',
      payload: { reason: 'no-sig-check' },
      signature: 'FORGED-DEADBEEF',
      issuedAt: 0,
    }, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.botManager.pause).toHaveBeenCalledWith('no-sig-check');
  });
});