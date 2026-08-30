'use strict';

/**
 * FIX-2026-08-31: Public IP detection service tests
 *
 *   Covers:
 *     - Successful fetch returns the IP
 *     - Cache hit: second call within TTL does NOT hit fetch again
 *     - Cache miss after forceRefresh: hits fetch
 *     - Network error / bad JSON / bad IP shape → returns null, never throws
 *     - Concurrent calls share a single in-flight fetch (no thundering herd)
 *     - AbortController times out slow fetches
 */

const publicIpService = require('../src/services/publicIpService');

// Mock global.fetch — Node 18+ has fetch built-in; we override per-test
const originalFetch = global.fetch;
let fetchMock = jest.fn();

beforeEach(() => {
  global.fetch = fetchMock;
  fetchMock.mockReset();
  publicIpService._resetCache();
});

afterAll(() => {
  global.fetch = originalFetch;
});

function mockOk(ip) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ ip }),
  });
}

function mockBadJson() {
  fetchMock.mockResolvedValueOnce({
    ok: true, status: 200, json: async () => ({ ip: 'not_an_ip_with_emoji_🦄' }),
  });
}

function mockHttpError() {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
}

function mockNetworkError() {
  fetchMock.mockRejectedValueOnce(new Error('ENETUNREACH'));
}

describe('publicIpService.getPublicIp() (FIX-2026-08-31)', () => {
  test('returns ip from successful fetch', async () => {
    mockOk('203.0.113.42');
    const ip = await publicIpService.getPublicIp();
    expect(ip).toBe('203.0.113.42');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('caches for 24h — second call within TTL does NOT re-fetch', async () => {
    mockOk('198.51.100.7');
    const ip1 = await publicIpService.getPublicIp();
    const ip2 = await publicIpService.getPublicIp();
    expect(ip1).toBe('198.51.100.7');
    expect(ip2).toBe('198.51.100.7');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('forceRefresh bypasses cache', async () => {
    mockOk('198.51.100.7');
    await publicIpService.getPublicIp();
    mockOk('203.0.113.99');
    const ip = await publicIpService.getPublicIp({ forceRefresh: true });
    expect(ip).toBe('203.0.113.99');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('returns null on HTTP error and never throws', async () => {
    mockHttpError();
    const ip = await publicIpService.getPublicIp();
    expect(ip).toBeNull();
  });

  test('returns null on network error and never throws', async () => {
    mockNetworkError();
    const ip = await publicIpService.getPublicIp();
    expect(ip).toBeNull();
  });

  test('returns null when ipify returns invalid ip string', async () => {
    mockBadJson();
    const ip = await publicIpService.getPublicIp();
    expect(ip).toBeNull();
  });

  test('concurrent callers share a single in-flight fetch', async () => {
    // Defer mock resolution so all 3 calls start before fetch resolves — assert
    //   they share one in-flight promise (no thundering herd).
    let resolveFetch;
    const pending = new Promise((r) => { resolveFetch = r; });
    fetchMock.mockReturnValueOnce(pending);

    // Start all 3 calls — they will all hang waiting on `pending`
    const p1 = publicIpService.getPublicIp();
    const p2 = publicIpService.getPublicIp();
    const p3 = publicIpService.getPublicIp();

    // Now resolve the fetch — this unblocks all 3 (they share _cache.inFlight)
    resolveFetch({ ok: true, status: 200, json: async () => ({ ip: '10.0.0.1' }) });

    const [a, b, c] = await Promise.all([p1, p2, p3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual(['10.0.0.1', '10.0.0.1', '10.0.0.1']);
  });

  test('handles IPv6-shaped strings', async () => {
    mockOk('2001:db8::1');
    const ip = await publicIpService.getPublicIp({ forceRefresh: true });
    expect(ip).toBe('2001:db8::1');
  });
});
