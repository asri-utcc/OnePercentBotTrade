'use strict';

/**
 * FIX-2026-09-02: Lock down the mobile-nav logout placement + main page redirect.
 * FIX-2026-09-23: Main page is now /pnl.html (was /chart-monitor.html).
 *
 * Two regressions to prevent:
 *   1. Mobile-only logout (in hamburger menu) — desktop header keeps its btn-lux Logout.
 *   2. Brand link in nav.js points to /pnl.html (the landing page).
 *
 * These are pure-string assertions against the partial source — no DOM, no runtime.
 * Easier to maintain than a jsdom-based snapshot and catches accidental edits.
 */

const fs = require('fs');
const path = require('path');

const NAV_JS = path.join(__dirname, '..', 'public', 'js', 'partials', 'nav.js');
const APP_CSS = path.join(__dirname, '..', 'public', 'css', 'app.css');
const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');

function read(p) { return fs.readFileSync(p, 'utf8'); }

describe('FIX-2026-09-02 nav: mobile logout lives in mobile menu', () => {
  const src = read(NAV_JS);

  test('desktop logout button id is "logout-btn" and is hidden on mobile (d-none d-md-inline-block)', () => {
    // The desktop header logout must NOT show on mobile — Bootstrap utility class.
    const desktopMatch = src.match(/<button[^>]*id="logout-btn"[^>]*>/);
    expect(desktopMatch).not.toBeNull();
    expect(desktopMatch[0]).toMatch(/class="[^"]*\bd-none\b[^"]*\bd-md-inline-block\b/);
  });

  test('mobile logout button id is "logout-btn-mobile" and lives inside #mobile-menu', () => {
    const mobileMatch = src.match(/<button[^>]*id="logout-btn-mobile"[^>]*>/);
    expect(mobileMatch).not.toBeNull();
    // Verify it lives inside the mobile-menu block.
    const mobileBlock = src.match(/<div class="mobile-menu[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/);
    expect(mobileBlock).not.toBeNull();
    expect(mobileBlock[0]).toMatch(/id="logout-btn-mobile"/);
  });

  test('logout click handler is attached to BOTH desktop and mobile buttons', () => {
    expect(src).toMatch(/getElementById\(['"]logout-btn['"]\)/);
    expect(src).toMatch(/getElementById\(['"]logout-btn-mobile['"]\)/);
  });
});

describe('FIX-2026-09-23 nav: brand link points to /pnl.html (main page)', () => {
  const src = read(NAV_JS);
  const indexSrc = read(INDEX_HTML);

  test('brand link in nav.js uses /pnl.html', () => {
    const brandMatch = src.match(/<a class="brand"[^>]*href="([^"]+)"/);
    expect(brandMatch).not.toBeNull();
    expect(brandMatch[1]).toBe('/pnl.html');
  });

  test('index.html still redirects authenticated users to /pnl.html', () => {
    expect(indexSrc).toMatch(/location\.href\s*=\s*['"]\/pnl\.html['"]/);
  });
});

describe('FIX-2026-09-02 css: nav-pill-logout styles reset native button chrome + add danger hue', () => {
  const css = read(APP_CSS);

  test('.app-nav .nav-pill.nav-pill-logout style block exists', () => {
    expect(css).toMatch(/\.app-nav\s+\.nav-pill\.nav-pill-logout\s*\{/);
  });

  test('mobile-menu .nav-pill-logout gets a top divider + red color', () => {
    const mobileRule = css.match(/\.app-nav\s+\.mobile-menu\s+\.nav-pill\.nav-pill-logout\s*\{[\s\S]*?\}/);
    expect(mobileRule).not.toBeNull();
    expect(mobileRule[0]).toMatch(/border-top:\s*1px\s+solid/);
  });
});
