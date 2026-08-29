'use strict';

/**
 * Phase 4-2026-08-29 — chat.routes.js unit tests.
 *
 *   - POST /api/chat/send: validates text, scopes, queues via chatOutbox (mocked)
 *   - GET /api/chat/history: reads from chatLocalStore
 *   - GET /api/chat/threads: returns DM summary
 *   - GET /api/chat/unread: returns counters
 *   - POST /api/chat/read: resets unread
 *   - GET /api/chat/display-name: returns current + resolved
 *   - PUT /api/chat/display-name: validates + persists to AppConfig (mocked)
 *
 *   Uses an in-memory app + http + bypass requireAuth by mocking the middleware
 *   to always call next().
 */

const http = require('http');
const express = require('express');

const mockEnqueue = jest.fn(() => ({ queued: true, id: 'mock-client-id' }));
const mockConfig = { enabled: true, url: 'http://127.0.0.1:1', licenseKey: 'lk', customerTag: 'shop-A' };

jest.mock('../src/admin-monitor', () => ({
  config: mockConfig,
  chatOutbox: { enqueue: mockEnqueue },
  chatInbox: { _state: () => ({}) },
}));

jest.mock('../src/api/middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
}));

// In-memory AppConfig mock
const mockAppConfigFindOne = jest.fn(() => ({
  lean: async () => mockAppConfigDoc,
}));
const mockAppConfigFindOneAndUpdate = jest.fn(async () => ({ ...mockAppConfigDoc, chatDisplayName: 'updated' }));
const mockAppConfigDoc = { chatDisplayName: '', telegramChatId: '' };
jest.mock('../src/db/models/AppConfig', () => {
  const fn = function () {};
  fn.findOne = mockAppConfigFindOne;
  fn.findOneAndUpdate = mockAppConfigFindOneAndUpdate;
  return fn;
});

const chatLocalStore = require('../src/services/chatLocalStore');
const chatRoutes = require('../src/api/routes/chat.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRoutes);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(server, method, p, body, headers = {}) {
  const { port } = server.address();
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const opts = {
    host: '127.0.0.1', port, method, path: p,
    headers: {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      ...headers,
    },
  };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch (e) { /* keep raw */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('chat routes (Phase 4)', () => {
  let server;
  beforeAll(async () => {
    server = await listen(buildApp());
  });
  afterAll(async () => {
    await closeServer(server);
  });
  beforeEach(() => {
    chatLocalStore.clear();
    mockEnqueue.mockClear();
    mockEnqueue.mockReturnValue({ queued: true, id: 'mock-client-id' });
    mockAppConfigDoc.chatDisplayName = '';
  });

  test('POST /api/chat/send requires text', async () => {
    const r = await request(server, 'POST', '/api/chat/send', { scope: 'community' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/text/);
  });

  test('POST /api/chat/send with text queues via chatOutbox', async () => {
    const r = await request(server, 'POST', '/api/chat/send', { scope: 'community', text: 'hello' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.queued).toBe(true);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ scope: 'community', text: 'hello' }));
  });

  test('POST /api/chat/send admin disabled → records locally + returns queued:false', async () => {
    mockConfig.enabled = false;
    const r = await request(server, 'POST', '/api/chat/send', { scope: 'community', text: 'local only' });
    expect(r.status).toBe(200);
    expect(r.body.queued).toBe(false);
    expect(mockEnqueue).not.toHaveBeenCalled();
    const local = chatLocalStore.getMessages('community');
    expect(local.length).toBe(1);
    mockConfig.enabled = true;
  });

  test('GET /api/chat/history returns messages', async () => {
    chatLocalStore.addMessage({ id: 'a', scope: 'community', text: 'hi', displayName: 'op', createdAt: '2026-08-29T10:00:00.000Z' });
    const r = await request(server, 'GET', '/api/chat/history?scope=community');
    expect(r.status).toBe(200);
    expect(r.body.messages.length).toBe(1);
    expect(r.body.scope).toBe('community');
  });

  test('GET /api/chat/threads returns single admin thread', async () => {
    chatLocalStore.addMessage({ id: 'a', scope: 'dm', fromAdmin: true, text: 'hi', displayName: 'admin', createdAt: '2026-08-29T10:00:00.000Z' });
    const r = await request(server, 'GET', '/api/chat/threads');
    expect(r.status).toBe(200);
    expect(r.body.threads.length).toBe(1);
    expect(r.body.threads[0].threadId).toBe('admin');
    expect(r.body.threads[0].unreadCount).toBe(1);
  });

  test('GET /api/chat/unread returns counters', async () => {
    chatLocalStore.addMessage({ id: 'a', scope: 'dm', fromAdmin: true, text: 'hi', displayName: 'admin' });
    const r = await request(server, 'GET', '/api/chat/unread');
    expect(r.status).toBe(200);
    expect(r.body.dm).toBe(1);
  });

  test('POST /api/chat/read resets scope', async () => {
    chatLocalStore.addMessage({ id: 'a', scope: 'dm', fromAdmin: true, text: 'hi', displayName: 'admin' });
    expect(chatLocalStore.getUnread('dm')).toBe(1);
    const r = await request(server, 'POST', '/api/chat/read', { scope: 'dm' });
    expect(r.status).toBe(200);
    expect(r.body.unread.dm).toBe(0);
  });

  test('GET /api/chat/display-name returns resolved', async () => {
    chatLocalStore.setCustomerTag('shop-A');
    const r = await request(server, 'GET', '/api/chat/display-name');
    expect(r.status).toBe(200);
    expect(r.body.resolved).toBe('shop-A');
  });

  test('PUT /api/chat/display-name persists', async () => {
    const r = await request(server, 'PUT', '/api/chat/display-name', { displayName: 'alice' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.displayName).toBe('alice');
    expect(mockAppConfigFindOneAndUpdate).toHaveBeenCalled();
    expect(chatLocalStore.getDisplayName()).toBe('alice');
  });

  test('PUT /api/chat/display-name rejects empty', async () => {
    const r = await request(server, 'PUT', '/api/chat/display-name', { displayName: '' });
    expect(r.status).toBe(400);
  });

  test('PUT /api/chat/display-name strips angle brackets', async () => {
    const r = await request(server, 'PUT', '/api/chat/display-name', { displayName: '<script>x</script>' });
    expect(r.status).toBe(200);
    expect(r.body.displayName).not.toContain('<');
    expect(r.body.displayName).not.toContain('>');
  });
});