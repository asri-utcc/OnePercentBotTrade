/**
 * FIX-2026-09-01: Auto-Timing heatmap modal — PnL/trade shading (Option A).
 *
 * Replaces WR strip with PnL/trade strip so Auto-Timing modal agrees with Trade
 * Analysis heatmap. Contract tests verify:
 *   1. Old WR strip code removed, new PnL strip in place
 *   2. pnlPerTrade / pnlOpacity / pnlColor / pnlSign locals computed correctly
 *   3. at-hm-pnl-strip div renders with inline pnlColor/pnlOpacity
 *   4. at-hm-pnl-val shows signed USDT/trade when n >= minShow
 *   5. Tooltip includes pnl/trade line
 *   6. Legend explains PnL/trade strip (no more WR strip)
 *   7. CSS .at-hm-pnl-strip + .at-hm-pnl-val exist
 *   8. settings.html cache-buster bumped
 */
'use strict';

const fs = require('fs');
const path = require('path');

const JS_PATH = path.join(__dirname, '..', 'public', 'js', 'pages', 'autoTiming.js');
const CSS_PATH = path.join(__dirname, '..', 'public', 'css', 'app.css');
const HTML_PATH = path.join(__dirname, '..', 'public', 'settings.html');

const jsRaw = fs.readFileSync(JS_PATH, 'utf8');
const cssRaw = fs.readFileSync(CSS_PATH, 'utf8');
const htmlRaw = fs.readFileSync(HTML_PATH, 'utf8');

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[\s;,(])\/\/[^\n]*/g, '$1');
const jsCode = stripComments(jsRaw);

describe('autoTiming.js — PnL/trade strip replaces WR strip', () => {
  test('old WR strip locals removed', () => {
    expect(jsCode).not.toMatch(/const wrOpacity/);
    expect(jsCode).not.toMatch(/const wrColor/);
  });

  test('new PnL strip locals computed', () => {
    expect(jsCode).toMatch(/const pnlPerTrade = /);
    expect(jsCode).toMatch(/const pnlOpacity = /);
    expect(jsCode).toMatch(/const pnlColor = /);
    expect(jsCode).toMatch(/const pnlSign = /);
  });

  test('pnlColor uses red/yellow/green thresholds (±0.02 USDT)', () => {
    expect(jsCode).toMatch(/pnlPerTrade\s*>\s*0\.02\s*\?\s*'#00e5b8'/);
    expect(jsCode).toMatch(/pnlPerTrade\s*<\s*-0\.02\s*\?\s*'#ff4d6d'/);
    expect(jsCode).toMatch(/:\s*'#f5b800'/);
  });

  test('cell renders <div class="at-hm-pnl-strip"> with inline color/opacity', () => {
    expect(jsCode).toContain('<div class="at-hm-pnl-strip" style="background-color:\' + pnlColor + \'; opacity:\' + pnlOpacity + \';\"></div>');
  });

  test('old <div class="at-hm-wr-strip"> div no longer present', () => {
    expect(jsCode).not.toMatch(/<div class="at-hm-wr-strip"/);
  });

  test('PnL/trade value rendered when n >= minShow', () => {
    expect(jsCode).toContain('<div class="at-hm-pnl-val" title="PnL per trade">' + '\' + pnlSign + pnlPerTrade.toFixed(2) + \'</div>\'');
  });

  test('PnL/trade value NOT rendered when n < minShow', () => {
    // Wrapped in (n >= minShow ? ... : '')
    expect(jsCode).toContain('(n >= minShow ? \'<div class="at-hm-pnl-val" title="PnL per trade">\' + pnlSign + pnlPerTrade.toFixed(2) + \'</div>\' : \'\')');
  });

  test('tooltip shows pnl/trade line', () => {
    expect(jsCode).toContain("'pnl/trade: ' + pnlSign + pnlPerTrade.toFixed(4) + ' USDT'");
  });

  test('legend has PnL/trade strip row (no more WR strip row)', () => {
    const legendMatch = jsCode.match(/<div class="at-hm-legend">[\s\S]*?<\/div>/);
    expect(legendMatch).not.toBeNull();
    const legend = legendMatch[0];
    expect(legend).toContain('PnL/trade strip');
    expect(legend).not.toContain('WR strip');
    expect(legend).toContain('+ profit');
    expect(legend).toContain('≈ 0');
    expect(legend).toContain('− loss');
  });

  test('info-box describes new 3-layer visual model', () => {
    expect(jsCode).toContain('Top strip</strong> = PnL/trade');
    expect(jsCode).toContain('Number below = USDT/trade');
  });
});

describe('app.css — PnL strip + value styles', () => {
  test('defines .at-hm-pnl-strip with z-index 1', () => {
    expect(cssRaw).toMatch(/\.at-hm-table tbody td\.at-hm-cell \.at-hm-pnl-strip\s*\{[^}]*position:\s*absolute[^}]*height:\s*4px[^}]*z-index:\s*1[^}]*\}/);
  });

  test('defines .at-hm-pnl-val for the PnL/trade number', () => {
    expect(cssRaw).toMatch(/\.at-hm-table tbody td\.at-hm-cell \.at-hm-pnl-val\s*\{[^}]*font-family:\s*var\(--font-mono\)/);
  });
});

describe('settings.html — cache-buster bumped', () => {
  test('script tag uses v=2026-09-01-pnl-strip', () => {
    expect(htmlRaw).toMatch(/autoTiming\.js\?v=2026-09-01-pnl-strip/);
  });
});
