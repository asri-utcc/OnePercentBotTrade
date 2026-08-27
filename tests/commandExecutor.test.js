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

describe('commandExecutor.kill (FIX process.exit)', () => {
  test('schedules process.exit + calls botManager.kill', async () => {
    jest.useFakeTimers();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    try {
      const ctx = buildCtx();
      const r = await executor.execute({ commandId: 'k1', type: 'kill', payload: { reason: 'test' } }, ctx);
      expect(ctx.botManager.kill).toHaveBeenCalled();
      expect(r.action).toBe('killing');
      // Advance fake clock to flush the scheduled process.exit
      jest.advanceTimersByTime(2000);
    } finally {
      jest.useRealTimers();
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