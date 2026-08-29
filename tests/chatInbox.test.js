'use strict';

/**
 * Phase 4-2026-08-29 — chatInbox unit tests.
 *
 *   - pollOnce GETs /api/instances/:id/chat/inbox with since cursor
 *   - Incoming messages added to local store + eventBus emit
 *   - DM from admin increments unread; community does not
 *   - Cursor advances on each successful poll
 *   - 5xx/network errors leave cursor untouched
 *   - admin disabled → skipped
 */

const http = require('http');
const { EventEmitter } = require('events');

let mockConfig = { enabled: true, url: 'http://127.0.0.1:1', licenseKey: 'lk-test' };
jest.mock('../src/admin-monitor/config', () => mockConfig);

const mockGetMachineId = jest.fn(() => 'machine-abc-123');
jest.mock('../src/admin-monitor/machineId', () => ({ getMachineId: mockGetMachineId }));

const mockEventBusEmit = jest.fn();
jest.mock('../src/services/eventBus', () => ({
  getEventBus: () => ({ emit: mockEventBusEmit, on: jest.fn(), removeAllListeners: jest.fn() }),
}));

const chatLocalStore = require('../src/services/chatLocalStore');
const chatInbox = require('../src/admin-monitor/chatInbox');

describe('chatInbox (Phase 4)', () => {
  let _originalRequest;
  let _requestMock;

  beforeEach(() => {
    chatInbox._reset();
    chatLocalStore.clear();
    mockEventBusEmit.mockClear();
    mockConfig.enabled = true;
    mockConfig.licenseKey = 'lk-test';
    _requestMock = jest.fn();
    _originalRequest = http.request;
    http.request = _requestMock;
  });

  afterEach(() => {
    http.request = _originalRequest;
  });

  function _mockResponse(status, body) {
    _requestMock.mockImplementation((opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = status;
      const req = new EventEmitter();
      req.write = jest.fn();
      req.end = jest.fn(() => process.nextTick(() => {
        cb(res);
        setImmediate(() => {
          res.emit('data', Buffer.from(JSON.stringify(body)));
          res.emit('end');
        });
      }));
      req.destroy = jest.fn();
      return req;
    });
  }

  test('pollOnce fetches and stores messages', async () => {
    _mockResponse(200, {
      messages: [
        { id: 'a', scope: 'community', fromAdmin: false, text: 'hi', displayName: 'op', createdAt: '2026-08-29T10:00:00.000Z' },
      ],
      serverTime: '2026-08-29T10:00:01.000Z',
    });
    const r = await chatInbox.pollOnce();
    expect(r.fetched).toBe(1);
    const local = chatLocalStore.getMessages('community');
    expect(local.length).toBe(1);
  });

  test('emits chat:message on eventBus', async () => {
    _mockResponse(200, {
      messages: [
        { id: 'a', scope: 'community', fromAdmin: true, text: 'admin says', displayName: 'admin', createdAt: '2026-08-29T10:00:00.000Z' },
      ],
      serverTime: '2026-08-29T10:00:01.000Z',
    });
    await chatInbox.pollOnce();
    expect(mockEventBusEmit).toHaveBeenCalledWith('chat:message', expect.objectContaining({ id: 'a', scope: 'community' }));
  });

  test('DM from admin increments unread', async () => {
    _mockResponse(200, {
      messages: [
        { id: 'd1', scope: 'dm', fromAdmin: true, text: 'private', displayName: 'admin', createdAt: '2026-08-29T10:00:00.000Z' },
      ],
      serverTime: '2026-08-29T10:00:01.000Z',
    });
    await chatInbox.pollOnce();
    expect(chatLocalStore.getUnread('dm')).toBe(1);
  });

  test('cursor advances on success and is sent on next poll', async () => {
    _mockResponse(200, {
      messages: [
        { id: 'a', scope: 'community', fromAdmin: false, text: '1', displayName: 'op', createdAt: '2026-08-29T10:00:00.000Z' },
      ],
      serverTime: '2026-08-29T10:00:01.000Z',
    });
    await chatInbox.pollOnce();
    // First poll has no cursor yet → URL does NOT include since
    const firstOpts = _requestMock.mock.calls[0][0];
    expect(firstOpts.path).not.toContain('since=');
    expect(chatInbox._state().cursor).toBe('2026-08-29T10:00:00.000Z');
    // Second poll should include since=
    await chatInbox.pollOnce();
    const secondOpts = _requestMock.mock.calls[1][0];
    expect(secondOpts.path).toContain('since=');
  });

  test('5xx leaves cursor untouched', async () => {
    _mockResponse(500, { error: 'server' });
    const r = await chatInbox.pollOnce();
    expect(r.error).toBeTruthy();
    expect(chatInbox._state().cursor).toBe(null);
  });

  test('admin disabled → skipped', async () => {
    mockConfig.enabled = false;
    const r = await chatInbox.pollOnce();
    expect(r.skipped).toBe('admin_disabled');
    expect(_requestMock).not.toHaveBeenCalled();
  });

  test('no license → skipped', async () => {
    mockConfig.licenseKey = '';
    const r = await chatInbox.pollOnce();
    expect(r.skipped).toBe('no_license');
  });
});