'use strict';

/**
 * Phase 4-2026-08-29 — chatOutbox unit tests.
 *
 *   - enqueue trims text and assigns clientId
 *   - drainOnce POSTs each pending message to admin
 *   - 5xx leaves message in queue, increments attempts
 *   - 4xx drops message
 *   - 20 attempts cap drops message
 *   - Admin disabled → drainOnce returns skipped
 */

const http = require('http');
const path = require('path');

// In-memory mock for admin-monitor/config so we can flip enabled/disabled without env mutation
let mockConfig = { enabled: true, url: 'http://127.0.0.1:1', licenseKey: 'lk-test', customerTag: 'shop-A' };

jest.mock('../src/admin-monitor/config', () => mockConfig);

const mockGetMachineId = jest.fn(() => 'machine-abc-123');
jest.mock('../src/admin-monitor/machineId', () => ({ getMachineId: mockGetMachineId }));

const chatLocalStore = require('../src/services/chatLocalStore');
const chatOutbox = require('../src/admin-monitor/chatOutbox');

describe('chatOutbox (Phase 4)', () => {
  let _originalRequest;
  let _requestMock;

  beforeEach(() => {
    chatOutbox._reset();
    chatLocalStore.clear();
    mockConfig.enabled = true;
    mockConfig.url = 'http://127.0.0.1:1';
    mockConfig.licenseKey = 'lk-test';
    _requestMock = jest.fn();
    _originalRequest = http.request;
    http.request = _requestMock;
  });

  afterEach(() => {
    http.request = _originalRequest;
  });

  function _mockResponse(status, body) {
    const { EventEmitter } = require('events');
    // Build a fresh emitter PER REQUEST so multiple sequential drains in one test work.
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

  test('enqueue assigns clientId + optimistically adds to local store', () => {
    const r = chatOutbox.enqueue({ scope: 'community', text: 'hello' });
    expect(r.queued).toBe(true);
    expect(typeof r.id).toBe('string');
    const local = chatLocalStore.getMessages('community');
    expect(local.length).toBe(1);
    expect(local[0].text).toBe('hello');
  });

  test('enqueue trims text to 2000 chars', () => {
    const longText = 'a'.repeat(3000);
    const r = chatOutbox.enqueue({ scope: 'community', text: longText });
    expect(r.queued).toBe(true);
    const local = chatLocalStore.getMessages('community');
    expect(local[0].text.length).toBe(2000);
  });

  test('enqueue rejects empty text', () => {
    expect(() => chatOutbox.enqueue({ scope: 'community', text: '' })).toThrow();
    expect(() => chatOutbox.enqueue({ scope: 'community', text: '   ' })).toThrow();
  });

  test('drainOnce POSTs each message with license header', async () => {
    _mockResponse(200, { ok: true });
    chatOutbox.enqueue({ scope: 'community', text: 'hi' });
    const r = await chatOutbox.drainOnce();
    expect(r.sent).toBe(1);
    expect(_requestMock).toHaveBeenCalledTimes(1);
    const opts = _requestMock.mock.calls[0][0];
    expect(opts.headers['X-License-Key']).toBe('lk-test');
    expect(opts.path).toContain('/api/instances/machine-abc-123/chat/send');
  });

  test('5xx leaves message in queue with retry', async () => {
    _mockResponse(500, { error: 'internal' });
    chatOutbox.enqueue({ scope: 'community', text: 'retry me' });
    const r = await chatOutbox.drainOnce();
    expect(r.sent).toBe(0);
    expect(chatOutbox._state().queueLength).toBe(1);
  });

  test('4xx drops message', async () => {
    _mockResponse(400, { error: 'bad text' });
    chatOutbox.enqueue({ scope: 'community', text: 'bad' });
    const r = await chatOutbox.drainOnce();
    expect(r.sent).toBe(0);
    expect(chatOutbox._state().queueLength).toBe(0);
  });

  test('admin disabled → drain skipped', async () => {
    mockConfig.enabled = false;
    chatOutbox.enqueue({ scope: 'community', text: 'hi' });
    const r = await chatOutbox.drainOnce();
    expect(r.skipped).toBe('admin_disabled');
  });

  test('no license → drain skipped', async () => {
    mockConfig.licenseKey = '';
    chatOutbox.enqueue({ scope: 'community', text: 'hi' });
    const r = await chatOutbox.drainOnce();
    expect(r.skipped).toBe('no_license');
  });

  test('batch size caps drain per tick', async () => {
    _mockResponse(200, { ok: true });
    for (let i = 0; i < 15; i++) {
      chatOutbox.enqueue({ scope: 'community', text: `m${i}` });
    }
    const r = await chatOutbox.drainOnce();
    expect(r.sent).toBeLessThanOrEqual(10);
    // remaining still in queue
    expect(chatOutbox._state().queueLength).toBeGreaterThan(0);
  });

  test('20 attempts → drop message', async () => {
    _mockResponse(500, { error: 'internal' });
    chatOutbox.enqueue({ scope: 'community', text: 'never' });
    for (let i = 0; i < 25; i++) {
      await chatOutbox.drainOnce();
    }
    expect(chatOutbox._state().queueLength).toBe(0);
  });
});