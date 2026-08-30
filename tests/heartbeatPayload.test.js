'use strict';

/**
 * FIX-2026-08-31: Heartbeat payload test (port + publicIp).
 *
 *   Spawns a real localhost HTTP server, points admin-monitor config at it,
 *   calls heartbeat.sendOnce(), and verifies the captured payload contains:
 *     - port (from main config PORT env, default 6015)
 *     - publicIp (from mocked publicIpService, may be null)
 *
 *   All other dependencies are stubbed via jest.mock so the test stays
 *   hermetic and avoids touching the network for ipify / github.
 */

const http = require('http');

// Stub publicIpService so we don't hit api.ipify.org
const mockGetPublicIp = jest.fn(async () => '203.0.113.42');
jest.mock('../src/services/publicIpService', () => ({
  getPublicIp: (...args) => mockGetPublicIp(...args),
  _resetCache: () => {},
}));

// Set PORT to a known value before any config requires happen
process.env.PORT = '6015';
process.env.ADMIN_URL = 'http://127.0.0.1:0';
process.env.ADMIN_ENABLED = 'false'; // skip heartbeat *start()* which needs a license key

const heartbeat = require('../src/admin-monitor/heartbeat');

function startEchoServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        server.lastBody = body;
        server.lastHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, serverTime: Date.now() }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

describe('heartbeat.sendOnce() payload (FIX-2026-08-31)', () => {
  let server, port;
  let heartbeatConfig;

  beforeAll(async () => {
    ({ server, port } = await startEchoServer());
    // Patch the admin-monitor config URL to point to our local server
    heartbeatConfig = require('../src/admin-monitor/config');
    heartbeatConfig.url = `http://127.0.0.1:${port}`;
    heartbeatConfig.licenseKey = 'TEST-LIC-KEY';
    heartbeatConfig.enabled = true;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  beforeEach(() => {
    mockGetPublicIp.mockClear();
    mockGetPublicIp.mockResolvedValue('203.0.113.42');
    server.lastBody = null;
    server.lastHeaders = null;
  });

  test('payload includes port (6015) and publicIp (mocked ipify value)', async () => {
    await heartbeat.sendOnce();
    expect(server.lastBody).toBeTruthy();
    const payload = JSON.parse(server.lastBody);
    expect(payload.port).toBe(6015);
    expect(payload.publicIp).toBe('203.0.113.42');
  });

  test('payload falls back to publicIp=null when ipify service returns null', async () => {
    mockGetPublicIp.mockResolvedValueOnce(null);
    await heartbeat.sendOnce();
    const payload = JSON.parse(server.lastBody);
    expect(payload.publicIp).toBeNull();
    // port should still be set
    expect(payload.port).toBe(6015);
  });

  test('X-License-Key header is sent', async () => {
    await heartbeat.sendOnce();
    expect(server.lastHeaders['x-license-key']).toBe('TEST-LIC-KEY');
  });

  test('payload omits / normalises publicIp even if ipify throws (best-effort)', async () => {
    mockGetPublicIp.mockRejectedValueOnce(new Error('ipify service blew up'));
    await heartbeat.sendOnce();
    const payload = JSON.parse(server.lastBody);
    // sendOnce should never throw — publicIp gracefully null in the catch
    expect(payload.publicIp).toBeNull();
    expect(payload.machineId).toMatch(/^[a-f0-9]{32}/); // 32-char machine id
  });
});
