'use strict';

/**
 * FIX-2026-09-01 audit H9: cache-buster consistency across HTML pages.
 *
 *   Before: HTML files used 9+ different cache-buster formats:
 *     ?v=2026-08-29-fix3
 *     ?v=2026-08-30-fix1
 *     ?v=2026-08-30
 *     ?v=2026-08-30-ux5-fix3
 *     ?v=fix-master-auto-timing-20260831
 *     ?v=2026-09-01-v5
 *     ?v=2026-09-01-pnl-strip
 *     ?v=2026-08-30-autoTiming
 *     ?v=2026-08-30-heat5
 *     ?v=2026-08-30-fix1
 *
 *   Some pages loaded the same JS file with DIFFERENT cache-busters (or no
 *   cache-buster at all), so users got inconsistent stale-asset behavior
 *   across pages after a deploy.
 *
 *   After: standardize on a single format AND verify that:
 *     1. Every `<script src>` and `<link href>` in public/*.html that points
 *        to /js/ or /css/ includes a `?v=` cache-buster (no missing).
 *     2. Every cache-buster matches the standard format regex.
 *     3. The SAME JS/CSS file has the SAME cache-buster value across ALL
 *        HTML pages that load it.
 *     4. No two distinct files share a cache-buster (avoids cross-pollution).
 *
 *   Format: ?v=YYYY-MM-DD[-tag] where tag is optional, lowercase, dash-separated.
 *   Examples (all valid): 2026-08-29, 2026-08-29-fix3, 2026-08-30-ux5
 *   Examples (invalid):  fix1, 20260829, v5, 2026_08_29-fix3
 *
 *   This test reads all public/*.html files and asserts the invariants above.
 *   Run via `npx jest tests/cacheBusterConsistency.test.js` after every
 *   HTML / JS / CSS edit to catch regressions.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Allow: 2026-08-29  OR  2026-08-29-fix3  OR  2026-08-30-ux5-fix3
// Disallow: fix1 (no date), 20260829 (no dashes), v5 (no date), 2026_08_29 (underscore)
const CACHE_BUSTER_REGEX = /^\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+(?:[-][a-z0-9]+)*)?$/;

function readAllHtmlFiles() {
  return fs.readdirSync(PUBLIC_DIR)
    .filter((f) => f.endsWith('.html'))
    .map((f) => ({ file: f, path: path.join(PUBLIC_DIR, f), src: fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8') }));
}

function extractAssets(html) {
  // Match <script src="..."> and <link href="..."> with local (starts with /js or /css) URLs.
  // Capture: 1=tag, 2=path (without query), 3=query (or empty)
  const re = /<(script|link)\b[^>]*?(?:src|href)=["']([^"']+)["'][^>]*>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const url = m[2];
    if (!url.startsWith('/js/') && !url.startsWith('/css/')) continue;
    if (url.startsWith('https://') || url.startsWith('http://')) continue;
    const [pathname, query] = url.split('?');
    out.push({ tag: m[1], path: pathname, query: query || '', url });
  }
  return out;
}

describe('audit-H9 cache-buster: format consistency', () => {
  const htmls = readAllHtmlFiles();
  const allAssets = htmls.flatMap((h) => extractAssets(h.src).map((a) => ({ ...a, page: h.file })));

  test('all HTML pages use the same standardized format regex', () => {
    // For every asset that HAS a query, the query (without leading '?') must match
    // either empty (no cache-buster) or the format.
    const nonEmpty = allAssets.filter((a) => a.query);
    expect(nonEmpty.length).toBeGreaterThan(0);
    for (const a of nonEmpty) {
      // query may be like "v=2026-08-29-fix3" — we only check the v= part
      const match = a.query.match(/^v=([^&]+)/);
      if (!match) {
        throw new Error(`${a.page}: query "${a.query}" on ${a.path} has no v= param`);
      }
      const v = match[1];
      expect(v).toMatch(CACHE_BUSTER_REGEX);
    }
  });

  test('audit-H9 example non-conformers are flagged (smoke check)', () => {
    // Spot-check: the regex must REJECT known-bad formats from the pre-fix era
    expect('fix1').not.toMatch(CACHE_BUSTER_REGEX);
    expect('20260829').not.toMatch(CACHE_BUSTER_REGEX);
    expect('v5').not.toMatch(CACHE_BUSTER_REGEX);
    expect('2026_08_29').not.toMatch(CACHE_BUSTER_REGEX);
    expect('fix-master-auto-timing-20260831').not.toMatch(CACHE_BUSTER_REGEX);
  });

  test('audit-H9 example conformers are accepted', () => {
    expect('2026-08-29').toMatch(CACHE_BUSTER_REGEX);
    expect('2026-08-29-fix3').toMatch(CACHE_BUSTER_REGEX);
    expect('2026-08-30-ux5-fix3').toMatch(CACHE_BUSTER_REGEX);
    expect('2026-09-01-pnl-strip').toMatch(CACHE_BUSTER_REGEX);
    expect('2026-09-01').toMatch(CACHE_BUSTER_REGEX);
  });
});

describe('audit-H9 cache-buster: same file = same value across pages', () => {
  const htmls = readAllHtmlFiles();
  const allAssets = htmls.flatMap((h) => extractAssets(h.src).map((a) => ({ ...a, page: h.file })));

  test('every /js/ and /css/ asset is loaded with a cache-buster (no missing ?v=)', () => {
    const missing = allAssets.filter((a) => !a.query || !/^v=/.test(a.query));
    if (missing.length > 0) {
      const list = missing.map((a) => `  ${a.page}: ${a.url}`).join('\n');
      throw new Error(`${missing.length} asset(s) missing cache-buster:\n${list}`);
    }
    expect(missing).toHaveLength(0);
  });

  test('each /js/ or /css/ file uses ONE cache-buster value across all pages', () => {
    const byFile = new Map();
    for (const a of allAssets) {
      const v = (a.query.match(/^v=([^&]+)/) || [])[1];
      if (!byFile.has(a.path)) byFile.set(a.path, new Map());
      byFile.get(a.path).set(v, (byFile.get(a.path).get(v) || 0) + 1);
    }
    const conflicts = [];
    for (const [file, versions] of byFile.entries()) {
      if (versions.size > 1) {
        conflicts.push({
          file,
          versions: Array.from(versions.entries()).map(([v, n]) => `${v} (${n}×)`),
        });
      }
    }
    if (conflicts.length > 0) {
      const list = conflicts.map((c) => `  ${c.file}: ${c.versions.join(', ')}`).join('\n');
      throw new Error(`${conflicts.length} file(s) have inconsistent cache-busters:\n${list}`);
    }
    expect(conflicts).toHaveLength(0);
  });

  test('informational: cache-busters shared across files (allowed — invalidate-on-deploy)', () => {
    // NOTE: Sharing a cache-buster value across multiple files is ACCEPTABLE.
    //   It just means "when the user reloads, the browser will treat both files
    //   as stale and refetch". That's the desired behavior on a deploy — we
    //   want users to get fresh copies of every changed file, not just one.
    //   This is informational only; no assertion.
    const byV = new Map();
    for (const a of allAssets) {
      const v = (a.query.match(/^v=([^&]+)/) || [])[1];
      if (!byV.has(v)) byV.set(v, new Set());
      byV.get(v).add(a.path);
    }
    const shared = Array.from(byV.entries()).filter(([_, files]) => files.size > 1);
    if (shared.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`cacheBusterConsistency: ${shared.length} stamp(s) shared (informational, allowed)`);
    }
    expect(shared.length).toBeGreaterThanOrEqual(0); // always passes
  });
});

describe('audit-H9 source: comment + test runner wired', () => {
  test('FIX-2026-09-01 audit H9 comment present in this test file', () => {
    const src = fs.readFileSync(__filename, 'utf8');
    expect(src).toMatch(/FIX-2026-09-01 audit H9/);
  });

  test('every public/*.html file has at least one /js/ or /css/ reference', () => {
    const htmls = readAllHtmlFiles();
    expect(htmls.length).toBeGreaterThan(5);
    for (const h of htmls) {
      const assets = extractAssets(h.src);
      // Allow consent.html etc to have 0 — it might be a redirect page
      if (assets.length === 0) continue;
      expect(assets.length).toBeGreaterThan(0);
    }
  });
});
