'use strict';

// FIX-2026-08-10: clientIp utility tests
//   - Header priority order: CF-Connecting-IP → X-Real-IP → XFF → req.ips → req.ip → socket
//   - Empty/missing values fall through cleanly
//   - Always returns a non-empty string

const { getClientIp } = require('../src/utils/clientIp');

function mockReq({ headers = {}, ip, ips, socket } = {}) {
  return {
    headers,
    ip,
    ips,
    socket: socket || { remoteAddress: undefined },
  };
}

describe('getClientIp (FIX-2026-08-10)', () => {
  test('returns "unknown" when req is null/undefined', () => {
    expect(getClientIp(null)).toBe('unknown');
    expect(getClientIp(undefined)).toBe('unknown');
  });

  test('CF-Connecting-IP takes highest priority (Cloudflare)', () => {
    const req = mockReq({
      headers: {
        'cf-connecting-ip': '203.0.113.5',
        'x-real-ip': '10.0.0.1',
        'x-forwarded-for': '198.51.100.1, 10.0.0.1',
      },
      ip: '127.0.0.1',
    });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });

  test('X-Real-IP used when no CF header (nginx)', () => {
    const req = mockReq({
      headers: {
        'x-real-ip': '10.0.0.1',
        'x-forwarded-for': '198.51.100.1, 10.0.0.1',
      },
      ip: '127.0.0.1',
    });
    expect(getClientIp(req)).toBe('10.0.0.1');
  });

  test('X-Forwarded-For leftmost IP (multi-hop proxy chain)', () => {
    const req = mockReq({
      headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.1, 10.0.0.1' },
      ip: '127.0.0.1',
    });
    expect(getClientIp(req)).toBe('198.51.100.7');
  });

  test('req.ips[0] used when XFF absent but trust proxy populated', () => {
    const req = mockReq({
      headers: {},
      ip: '127.0.0.1',
      ips: ['198.51.100.7', '127.0.0.1'],
    });
    expect(getClientIp(req)).toBe('198.51.100.7');
  });

  test('req.ip used as fallback when no headers and no ips chain', () => {
    const req = mockReq({ headers: {}, ip: '192.168.1.42' });
    expect(getClientIp(req)).toBe('192.168.1.42');
  });

  test('socket.remoteAddress used as last resort', () => {
    const req = mockReq({
      headers: {},
      ip: undefined,
      socket: { remoteAddress: '10.0.0.99' },
    });
    expect(getClientIp(req)).toBe('10.0.0.99');
  });

  test('returns "unknown" when nothing is available', () => {
    const req = mockReq({ headers: {}, ip: undefined, socket: {} });
    expect(getClientIp(req)).toBe('unknown');
  });

  test('trims whitespace from header values', () => {
    const req = mockReq({
      headers: { 'x-forwarded-for': '   198.51.100.7   ,  10.0.0.1  ' },
    });
    expect(getClientIp(req)).toBe('198.51.100.7');
  });

  test('empty header values fall through to next source', () => {
    const req = mockReq({
      headers: {
        'cf-connecting-ip': '',
        'x-real-ip': '   ',
        'x-forwarded-for': '198.51.100.7',
      },
    });
    expect(getClientIp(req)).toBe('198.51.100.7');
  });

  test('handles IPv6 addresses', () => {
    const req = mockReq({ headers: { 'x-forwarded-for': '2001:db8::1, 10.0.0.1' } });
    expect(getClientIp(req)).toBe('2001:db8::1');
  });

  test('debug option does not throw (silent noop if logger missing)', () => {
    const req = mockReq({ headers: { 'cf-connecting-ip': '203.0.113.5' } });
    expect(() => getClientIp(req, { debug: true })).not.toThrow();
  });
});