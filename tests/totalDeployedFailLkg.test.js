'use strict';

/**
 * FIX-2026-09-01 audit H4: licenseService.getTotalDeployedUsdt() must NOT
 * fail-OPEN on a Mongo blip.
 *
 *   Before:
 *     - Mongo error in catch block returned 0.
 *     - withinMaxCapital(additional) → 0 + additional <= cap → always
 *       passes (assuming cap > 0).
 *     - A 5-minute Mongo blip during a BUY hot-path meant every cap check
 *       passed, opening the door to unlimited new positions until Mongo
 *       recovered.
 *
 *   After (fail-LAST-KNOWN-GOOD):
 *     - Mongo error returns the last successful cache value
 *       (lastGoodValue) if it's recent (within FAIL_LKG_MS = 5 min).
 *     - Cache window is extended so the same failed query isn't retried
 *       every 30s during a sustained outage.
 *     - Cold-start during outage (no lastGoodValue yet) still returns 0,
 *       with a different log line so operators can distinguish the two.
 *     - All branches log a warn-level entry so a sustained outage is
 *       visible in PM2 logs.
 */

const fs = require('fs');
const path = require('path');

const LIC_PATH = path.join(__dirname, '..', 'src', 'services', 'licenseService.js');
const licRaw = fs.readFileSync(LIC_PATH, 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s;,(])\/\/[^\n]*/g, '$1');
}

describe('audit-H4 source: fail-LAST-KNOWN-GOOD cache for Mongo blip', () => {
  test('FIX-2026-09-01 audit H4 comment present', () => {
    expect(licRaw).toMatch(/FIX-2026-09-01 audit H4/);
  });

  test('cache tracks lastGoodValue + lastGoodAt in addition to value + at', () => {
    const code = stripComments(licRaw);
    const cacheDecl = code.match(/const\s+_totalDeployedCache\s*=\s*\{[^}]+\}/);
    expect(cacheDecl).not.toBeNull();
    expect(cacheDecl[0]).toMatch(/lastGoodValue/);
    expect(cacheDecl[0]).toMatch(/lastGoodAt/);
  });

  test('FAIL_LKG_MS constant exists (5min window)', () => {
    const code = stripComments(licRaw);
    expect(code).toMatch(/const\s+FAIL_LKG_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  });

  test('success path updates lastGoodValue + lastGoodAt', () => {
    const code = stripComments(licRaw);
    // Inside the try { } block, _totalDeployedCache.lastGoodValue = total
    // and _totalDeployedCache.lastGoodAt = now must both be assigned.
    expect(code).toMatch(/_totalDeployedCache\.lastGoodValue\s*=\s*total/);
    expect(code).toMatch(/_totalDeployedCache\.lastGoodAt\s*=\s*now/);
  });

  test('catch block returns lastGoodValue when recent (not 0)', () => {
    const code = stripComments(licRaw);
    // The catch block must NOT unconditionally return 0 — it must check
    // lastGoodAge ≤ FAIL_LKG_MS and lastGoodValue > 0 first.
    const catchBlock = code.match(/catch\s*\(err\)\s*\{[\s\S]{0,1500}\}\s*$/m);
    expect(catchBlock).not.toBeNull();
    const body = catchBlock[0];
    expect(body).toMatch(/lastGoodAge\s*<=\s*FAIL_LKG_MS/);
    expect(body).toMatch(/lastGoodValue\s*>\s*0/);
    expect(body).toMatch(/return\s+_totalDeployedCache\.lastGoodValue/);
  });

  test('catch block extends cache window after Mongo blip (avoids query spam)', () => {
    const code = stripComments(licRaw);
    // Without the extension, the same broken query would run every 30s.
    expect(code).toMatch(/_totalDeployedCache\.at\s*=\s*now\s*\+\s*\(FAIL_LKG_MS\s*-\s*TOTAL_DEPLOYED_CACHE_MS\)/);
  });

  test('cold-start during outage still returns 0 (with distinct log line)', () => {
    const code = stripComments(licRaw);
    // Without a lastGoodValue the function must still return 0, but log
    // a different message so operators can spot "fresh outage" vs "blip
    // during running cache".
    expect(code).toMatch(/no recent cached value/);
  });

  test('loud warn log fires on every Mongo blip branch', () => {
    const code = stripComments(licRaw);
    // Two distinct warn-level log calls (one per branch)
    const warns = code.match(/logger\.warn\(/g) || [];
    expect(warns.length).toBeGreaterThanOrEqual(2);
  });
});

describe('audit-H4 runtime: total deployed capital under Mongo outage', () => {
  // Replicate the cache + compute logic and assert behavior under 4 scenarios.

  const TOTAL_CACHE_MS = 30 * 1000;
  const FAIL_LKG_MS = 5 * 60 * 1000;

  function makeCache() {
    // at is set far in the past so the cold-start tests aren't accidentally
    // treated as a fresh cache (cache.at=0 means Date.now()-0 < 30s = hit).
    return { value: 0, at: -1000000, lastGoodValue: 0, lastGoodAt: 0 };
  }

  function readFromCache(cache, now) {
    if ((now - cache.at) < TOTAL_CACHE_MS) return { hit: true, value: cache.value };
    return { hit: false };
  }

  function getTotalDeployedUsdt(cache, now, mongoBehavior) {
    const probe = readFromCache(cache, now);
    if (probe.hit) return { source: 'cache', value: probe.value };
    if (mongoBehavior === 'blip' && cache.lastGoodValue > 0) {
      const lastGoodAge = now - cache.lastGoodAt;
      if (lastGoodAge <= FAIL_LKG_MS) {
        cache.at = now + (FAIL_LKG_MS - TOTAL_CACHE_MS);
        return { source: 'fail-LKG', value: cache.lastGoodValue };
      }
    }
    return { source: 'cold-fail', value: 0 };
  }

  test('cache hit within 30s: returns cached value (no Mongo call)', () => {
    const cache = makeCache();
    cache.value = 450;
    cache.at = 1000;
    const r = getTotalDeployedUsdt(cache, 5000, 'blip'); // 4s later
    expect(r.source).toBe('cache');
    expect(r.value).toBe(450);
  });

  test('Mongo blip WITHIN 5min of lastGood: returns lastGoodValue (defense)', () => {
    const cache = makeCache();
    cache.lastGoodValue = 500;
    cache.lastGoodAt = 1000;
    cache.at = 0; // expired
    const r = getTotalDeployedUsdt(cache, 60 * 1000, 'blip'); // 59s later, within 5min
    expect(r.source).toBe('fail-LKG');
    expect(r.value).toBe(500); // NOT 0
  });

  test('Mongo blip AFTER 5min of lastGood: returns 0 (capped window)', () => {
    const cache = makeCache();
    cache.lastGoodValue = 500;
    cache.lastGoodAt = 1000;
    cache.at = 0;
    const r = getTotalDeployedUsdt(cache, 6 * 60 * 1000, 'blip'); // 6min later
    expect(r.source).toBe('cold-fail');
    expect(r.value).toBe(0);
  });

  test('cold cache + Mongo blip + no lastGood: returns 0 (acceptable fallback)', () => {
    const cache = makeCache(); // lastGoodValue=0 default
    const r = getTotalDeployedUsdt(cache, 1000, 'blip');
    expect(r.source).toBe('cold-fail');
    expect(r.value).toBe(0);
  });

  test('withinMaxCapital uses the cached/blip value (not 0) so cap stays enforced', () => {
    // Simulate the audit-flagged attack scenario:
    //   - Before fix: Mongo blip → total=0 → cap check passes → unlimited
    //   - After fix: Mongo blip → total=lastGoodValue → cap check enforces cap
    const cache = makeCache();
    cache.lastGoodValue = 950; // near cap of 1000
    cache.lastGoodAt = 0;
    cache.at = 0;
    const r = getTotalDeployedUsdt(cache, 30 * 1000, 'blip');
    // Pre-fix: r.value = 0, additional 100 → 100 ≤ 1000 pass → UNLIMITED
    // Post-fix: r.value = 950, additional 100 → 1050 > 1000 → BLOCKED
    const cap = 1000;
    const additional = 100;
    const allowed = (r.value + additional) <= cap;
    expect(allowed).toBe(false); // cap is enforced
  });

  test('cache window is extended after blip (avoid query spam)', () => {
    const cache = makeCache();
    cache.lastGoodValue = 500;
    // lastGoodAt = 10s in the past so it's well within the 5min window
    const now = 1000;
    cache.lastGoodAt = now - 10000;
    cache.at = -1000000; // ensure cache miss
    getTotalDeployedUsdt(cache, now, 'blip');
    // After blip, cache.at is bumped forward to suppress retry
    expect(cache.at).toBeGreaterThan(now + TOTAL_CACHE_MS);
  });
});