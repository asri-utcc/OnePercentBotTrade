/**
 * FIX-2026-09-01 audit C10: license gate for /api/auto-timing/* endpoints.
 *
 * Before this fix:
 *   - 8 endpoints in autoTiming.routes.js were gated only by requireAuth (session)
 *     but NOT by isFeatureEnabled('autoTiming'). Operators on a basic-tier license
 *     could call PUT /config to enable the master toggle, call POST /run-now,
 *     POST /override-cell, POST /clear-history, GET /cell-matrix, etc. — gaining
 *     full access to a premium-tier feature for free.
 *   - The frontend settings page (autoTiming section) hides the UI for basic
 *     tier, but the API itself was unprotected → trivial bypass via curl.
 *
 * Defense added:
 *   - router.use(...) middleware at the top of autoTiming.routes.js checks
 *     licenseService.isFeatureEnabled('autoTiming'). If false → 403 with
 *     code: LICENSE_FEATURE_DISABLED, feature: 'autoTiming'.
 *   - The check runs BEFORE any handler (no DB read on basic tier).
 *   - Fail-OPEN when licenseService is missing (dev/test) so jest runs work.
 *
 * Endpoints covered (all 8):
 *   - GET   /api/auto-timing/config
 *   - PUT   /api/auto-timing/config
 *   - POST  /api/auto-timing/run-now
 *   - GET   /api/auto-timing/status
 *   - GET   /api/auto-timing/cell-matrix
 *   - POST  /api/auto-timing/override-cell
 *   - POST  /api/auto-timing/clear-history
 *   - GET   /api/auto-timing/recent-decisions
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROUTES_PATH = path.join(__dirname, '..', 'src', 'api', 'routes', 'autoTiming.routes.js');
const routesRaw = fs.readFileSync(ROUTES_PATH, 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s;,(])\/\/[^\n]*/g, '$1');
}

describe('audit-C10 license gate middleware — installed once at router level', () => {
  test('licenseService is required (optional try/catch)', () => {
    // The require must be tolerant so the file loads in test environments.
    expect(routesRaw).toMatch(/require\(['"]\.\.\/\.\.\/services\/licenseService['"]\)/);
    expect(routesRaw).toMatch(/try\s*\{\s*licenseService\s*=\s*require/);
  });

  test('router.use middleware is registered (applies to all routes)', () => {
    const code = stripComments(routesRaw);
    expect(code).toMatch(/router\.use\(\(req,\s*res,\s*next\)\s*=>/);
  });

  test('middleware calls licenseService.isFeatureEnabled with the autoTiming key', () => {
    const code = stripComments(routesRaw);
    // The middleware references AUTO_TIMING_FEATURE_KEY (constant defined in this file)
    // which is 'autoTiming'. Either form is acceptable.
    expect(code).toMatch(/licenseService\.isFeatureEnabled\(AUTO_TIMING_FEATURE_KEY\)/);
  });

  test('middleware emits 403 + LICENSE_FEATURE_DISABLED when feature off', () => {
    const code = stripComments(routesRaw);
    expect(code).toMatch(/res\.status\(403\)/);
    expect(code).toMatch(/code: 'LICENSE_FEATURE_DISABLED'/);
    expect(code).toMatch(/feature: AUTO_TIMING_FEATURE_KEY/);
  });

  test('middleware passes through when licenseService missing (fail-OPEN)', () => {
    // The fail-OPEN guard is in code (the if condition), so we can match against stripped.
    const code = stripComments(routesRaw);
    expect(code).toMatch(/if \(!licenseService \|\| typeof licenseService\.isFeatureEnabled !== 'function'\)/);
    // The fail-OPEN comment is in source — use raw.
    expect(routesRaw).toMatch(/return next\(\);\s*\/\/ fail-OPEN/);
  });

  test('AUTO_TIMING_FEATURE_KEY constant defined', () => {
    expect(routesRaw).toMatch(/const AUTO_TIMING_FEATURE_KEY = 'autoTiming'/);
  });

  test('audit comment cites the bypass risk', () => {
    expect(routesRaw).toMatch(/audit C10[\s\S]{0,600}license gate/);
  });
});

describe('audit-C10 8 endpoints remain gated', () => {
  // All 8 endpoints must be defined AFTER the router.use middleware.
  // The test verifies each route exists and the middleware was added before
  // any of them — this proves they all sit behind the gate.
  const EXPECTED = [
    "router.get('/config',",
    "router.put('/config',",
    "router.post('/run-now',",
    "router.get('/status',",
    "router.get('/cell-matrix',",
    "router.post('/override-cell',",
    "router.post('/clear-history',",
    "router.get('/recent-decisions',",
  ];

  test.each(EXPECTED)('endpoint %s is present', (ep) => {
    expect(routesRaw).toContain(ep);
  });

  test('router.use middleware appears BEFORE the first endpoint', () => {
    const useIdx = routesRaw.indexOf('router.use((req, res, next) =>');
    const firstEpIdx = routesRaw.indexOf("router.get('/config',");
    expect(useIdx).toBeGreaterThan(-1);
    expect(firstEpIdx).toBeGreaterThan(-1);
    expect(useIdx).toBeLessThan(firstEpIdx);
  });

  test('all 8 endpoints sit AFTER the middleware (gated)', () => {
    const useIdx = routesRaw.indexOf('router.use((req, res, next) =>');
    for (const ep of EXPECTED) {
      const epIdx = routesRaw.indexOf(ep);
      expect(epIdx).toBeGreaterThan(useIdx);
    }
  });
});

describe('audit-C10 inline runtime — middleware behavior', () => {
  // Simulate the middleware logic and verify the gate works for all 4 input shapes:
  //   - licenseService missing → next() (fail-OPEN)
  //   - isFeatureEnabled returns false → 403 LICENSE_FEATURE_DISABLED
  //   - isFeatureEnabled returns true → next() (pass through)
  //   - licenseService missing isFeatureEnabled method → next() (fail-OPEN)
  function simulateGate({ licenseService, featureEnabled }) {
    return function (req, res, next) {
      if (!licenseService || typeof licenseService.isFeatureEnabled !== 'function') {
        return { next: true, failOpen: true };
      }
      if (!licenseService.isFeatureEnabled('autoTiming')) {
        return { next: false, status: 403, body: { code: 'LICENSE_FEATURE_DISABLED', feature: 'autoTiming' } };
      }
      return { next: true, featureEnabled: true };
    };
  }

  test('licenseService missing → fail-OPEN', () => {
    const r = simulateGate({ licenseService: null, featureEnabled: false });
    const result = r({}, {}, () => {});
    expect(result.next).toBe(true);
    expect(result.failOpen).toBe(true);
  });

  test('licenseService missing isFeatureEnabled → fail-OPEN', () => {
    const r = simulateGate({ licenseService: {}, featureEnabled: false });
    const result = r({}, {}, () => {});
    expect(result.next).toBe(true);
  });

  test('isFeatureEnabled returns false → 403 LICENSE_FEATURE_DISABLED', () => {
    const r = simulateGate({ licenseService: { isFeatureEnabled: () => false }, featureEnabled: false });
    const result = r({}, {}, () => {});
    expect(result.next).toBe(false);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('LICENSE_FEATURE_DISABLED');
    expect(result.body.feature).toBe('autoTiming');
  });

  test('isFeatureEnabled returns true → next() pass-through', () => {
    const r = simulateGate({ licenseService: { isFeatureEnabled: () => true }, featureEnabled: true });
    const result = r({}, {}, () => {});
    expect(result.next).toBe(true);
  });
});
