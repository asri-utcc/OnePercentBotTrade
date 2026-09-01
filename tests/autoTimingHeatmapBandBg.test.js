/**
 * FIX-2026-09-01: Auto-Timing heatmap modal — mojibake + hold-band background overlay.
 *
 * Contract tests verifying the modal source file:
 *   1. No broken JS \xNN byte-escape sequences remain (e.g. \xc3\x97 → mojibake "Ã—")
 *   2. AT_HM_BAND_RGB constant present with all 5 HOLD_BANDS keys + rgb tuples
 *   3. Each cell renders a <div class="at-hm-band-bg"> with inline rgba(...) bg color
 *   4. Legend has a Hold-band row with 5 colored dots (≤10 นาที ... >2 วัน)
 *   5. CSS file defines .at-hm-band-bg (absolute fill, z-index 0)
 *   6. Tooltip includes band label (e.g. "1–12 ชม.")
 *   7. settings.html cache-buster bumped (2026-09-01-band-bg)
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

// Strip JS line + block comments for accurate grep (avoid matching inside comments).
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[\s;,(])\/\/[^\n]*/g, '$1');
const jsCode = stripComments(jsRaw);

describe('autoTiming.js — mojibake fix', () => {
  test('no broken \\xNN byte-escape sequences remain', () => {
    // These were UTF-8 bytes written as Latin-1 escapes (\xc3\x97, \xe2\x80\x94, etc.)
    // causing mojibake like "Ã—" and "â‰¥". All should be replaced with proper
    // Unicode characters or correct \uNNNN escapes.
    expect(jsCode).not.toMatch(/\\xc3\\x[0-9a-fA-F]{2}/);
    expect(jsCode).not.toMatch(/\\xe2\\x[0-9a-fA-F]{2}/);
    expect(jsCode).not.toMatch(/\\xf0\\x[0-9a-fA-F]{2}/);
    expect(jsCode).not.toMatch(/\\xc2\\x[0-9a-fA-F]{2}/);
  });

  test('uses proper Unicode chars (×, —, ≥, ≤, •) or literal Unicode', () => {
    // The legitimate \u25cf (●) escape is still used in the legend, so we allow it.
    // Other chars should be literal Unicode.
    expect(jsCode).toContain('×');
    expect(jsCode).toContain('—');
    expect(jsCode).toContain('≥');
    expect(jsCode).toContain('≤');
    expect(jsCode).toContain('•');
    expect(jsCode).toContain('⛔');
    expect(jsCode).toContain('🚫');
    expect(jsCode).toContain('📐');
  });
});

describe('autoTiming.js — hold-band background overlay', () => {
  test('AT_HM_BAND_RGB constant maps all 5 HOLD_BANDS keys', () => {
    expect(jsCode).toMatch(/const AT_HM_BAND_RGB = \{[\s\S]*?lt10m:[\s\S]*?lt1h:[\s\S]*?lt12h:[\s\S]*?lt48h:[\s\S]*?gt48h:[\s\S]*?\};/);
  });

  test('AT_HM_BAND_RGB values are rgb tuples (no rgba, no hex)', () => {
    const block = jsCode.match(/const AT_HM_BAND_RGB = \{[\s\S]*?\};/)[0];
    // Each entry should be 'r,g,b' format
    expect(block).toMatch(/lt10m:\s*'0,170,255'/);
    expect(block).toMatch(/lt1h:\s*'0,229,184'/);
    expect(block).toMatch(/lt12h:\s*'255,209,102'/);
    expect(block).toMatch(/lt48h:\s*'255,159,67'/);
    expect(block).toMatch(/gt48h:\s*'255,77,109'/);
  });

  test('AT_HM_BAND_LABEL provides human-readable Thai labels', () => {
    expect(jsCode).toMatch(/AT_HM_BAND_LABEL/);
    expect(jsCode).toMatch(/≤10\s*นาที/);
    expect(jsCode).toMatch(/≤1\s*ชม\./);
    expect(jsCode).toMatch(/≤12\s*ชม\./);
    expect(jsCode).toMatch(/≤48\s*ชม\./);
    expect(jsCode).toMatch(/>2\s*วัน/);
  });

  test('each cell renders a <div class="at-hm-band-bg"> layer', () => {
    expect(jsCode).toContain('<div class="at-hm-band-bg" style="background-color: rgba(\' + bandRgb + \', 0.18);"></div>');
  });

  test('cell band-bg uses bandRgb variable (not hardcoded color)', () => {
    // Ensure the bg is data-driven from AT_HM_BAND_RGB via bandRgb
    const cellBlock = jsCode.match(/<div class="at-hm-band-bg"[\s\S]{0,200}<\/div>/);
    expect(cellBlock).not.toBeNull();
    expect(cellBlock[0]).toContain('bandRgb');
    expect(cellBlock[0]).toContain('0.18'); // alpha
  });

  test('tooltip includes bandId + AT_HM_BAND_LABEL lookup', () => {
    // Line 582: 'band: ' + bandId + ' (' + (AT_HM_BAND_LABEL[bandId] || '?') + ')'
    expect(jsCode).toContain("'band: ' + bandId + ' (' + (AT_HM_BAND_LABEL[bandId] || '?') + ')'");
  });

  test('legend has Hold-band row with 5 colored rgba dots', () => {
    // Anchor: from <div class="at-hm-legend"> up to and including the </div> closing tag
    const legendMatch = jsCode.match(/<div class="at-hm-legend">[\s\S]*?<\/div>/);
    expect(legendMatch).not.toBeNull();
    const legend = legendMatch[0];
    expect(legend).toContain('Hold-band');
    expect(legend).toContain('rgba(0,170,255,0.45)');
    expect(legend).toContain('rgba(0,229,184,0.45)');
    expect(legend).toContain('rgba(255,209,102,0.45)');
    expect(legend).toContain('rgba(255,159,67,0.45)');
    expect(legend).toContain('rgba(255,77,109,0.45)');
  });
});

describe('app.css — .at-hm-band-bg layer', () => {
  test('defines .at-hm-band-bg as absolute fill with z-index 0', () => {
    expect(cssRaw).toMatch(/\.at-hm-table tbody td\.at-hm-cell \.at-hm-band-bg\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*z-index:\s*0[^}]*\}/);
  });

  test('.at-hm-wr-strip has z-index 1 (above band-bg)', () => {
    expect(cssRaw).toMatch(/\.at-hm-table tbody td\.at-hm-cell \.at-hm-wr-strip\s*\{\s*z-index:\s*1;\s*\}/);
  });

  test('content layers (dot/n/wr-pct/tier2/block) have position relative + z-index 2', () => {
    const block = cssRaw.match(/\.at-hm-table tbody td\.at-hm-cell \.at-hm-act-dot,[\s\S]*?\.at-hm-block\s*\{[^}]+\}/);
    expect(block).not.toBeNull();
    expect(block[0]).toContain('position: relative');
    expect(block[0]).toContain('z-index: 2');
  });
});

describe('settings.html — cache-buster bumped', () => {
  test('script tag uses 2026-09-01-* cache-buster', () => {
    expect(htmlRaw).toMatch(/autoTiming\.js\?v=2026-09-01-(band-bg|pnl-strip)/);
  });
});
