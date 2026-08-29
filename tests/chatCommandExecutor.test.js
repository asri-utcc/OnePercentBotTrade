'use strict';

/**
 * Phase 4-2026-08-29 — commandExecutor.chat_message handler tests.
 *
 *   - Adds message to local ring buffer
 *   - Emits 'chat:message' on eventBus
 *   - Empty text → returns ok:false
 *   - Truncates text to 2000 chars
 */

const mockEmit = jest.fn();

jest.mock('../src/services/eventBus', () => ({
  getEventBus: () => ({ emit: mockEmit, on: jest.fn(), removeAllListeners: jest.fn() }),
}));

const chatLocalStore = require('../src/services/chatLocalStore');
const executor = require('../src/admin-monitor/commandExecutor');

describe('commandExecutor.chat_message (Phase 4)', () => {
  let ctx;
  beforeEach(() => {
    chatLocalStore.clear();
    mockEmit.mockClear();
    ctx = {
      botManager: {
        pause: jest.fn(), resume: jest.fn(), kill: jest.fn(),
        forceCloseAll: jest.fn(), setConfig: jest.fn(),
      },
      eventBus: { emit: mockEmit },
    };
  });

  test('emits chat:message on eventBus', async () => {
    const r = await executor.execute(
      {
        commandId: 'cmd-1',
        type: 'chat_message',
        payload: {
          id: 'msg-1',
          scope: 'community',
          text: 'hello community',
          displayName: 'admin',
          createdAt: '2026-08-29T10:00:00.000Z',
        },
      },
      ctx
    );
    expect(r.action).toBe('chat_message');
    expect(mockEmit).toHaveBeenCalledWith('chat:message', expect.objectContaining({
      id: 'msg-1',
      scope: 'community',
      fromAdmin: true,
      text: 'hello community',
    }));
  });

  test('adds to local ring buffer', async () => {
    await executor.execute(
      {
        commandId: 'cmd-2',
        type: 'chat_message',
        payload: {
          id: 'msg-2', scope: 'dm', text: 'private hi',
          displayName: 'admin', toMachineId: 'machine-1',
          createdAt: '2026-08-29T10:00:00.000Z',
        },
      },
      ctx
    );
    const dms = chatLocalStore.getMessages('dm');
    expect(dms.length).toBe(1);
    expect(dms[0].text).toBe('private hi');
    expect(dms[0].fromAdmin).toBe(true);
    expect(dms[0].toMachineId).toBe('machine-1');
    // DM from admin increments unread
    expect(chatLocalStore.getUnread('dm')).toBe(1);
  });

  test('empty text returns ok:false without emitting', async () => {
    const r = await executor.execute(
      { commandId: 'cmd-3', type: 'chat_message', payload: { text: '' } },
      ctx
    );
    expect(r.ok).toBe(false);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('truncates text to 2000 chars', async () => {
    const longText = 'a'.repeat(5000);
    await executor.execute(
      { commandId: 'cmd-4', type: 'chat_message', payload: { id: 'x', text: longText } },
      ctx
    );
    const args = mockEmit.mock.calls[0][1];
    expect(args.text.length).toBe(2000);
  });

  test('unknown command type throws', async () => {
    await expect(executor.execute({ commandId: 'x', type: 'unknown' }, ctx)).rejects.toThrow(/Unknown command type/);
  });
});