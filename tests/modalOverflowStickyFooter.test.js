'use strict';

/**
 * FIX-2026-09-01 audit H11: Modal overflow + sticky footer on .lux-modal.
 *
 *   Before: .modal-content.lux-modal had `overflow: hidden` and no flex
 *   column. When the modal body grew taller than the viewport (e.g. a long
 *   dangerNote + many cam-target rows + the password block), the body
 *   overflowed the dialog and the footer (ยกเลิก / ยืนยัน buttons) was
 *   pushed off-screen. Users had to scroll the page itself to reach the
 *   confirm button — a critical UX bug for the confirmActionModal which
 *   gates destructive operations like force-close / delete bot.
 *
 *   Fix:
 *     1. .modal-content.lux-modal becomes a flex column with max-height
 *        capped at calc(100vh - 3rem).
 *     2. .modal-header and .modal-footer have flex-shrink: 0 — never collapse.
 *     3. .modal-body has overflow-y: auto + min-height: 0 — scrolls internally
 *        when content is taller than the dialog.
 *     4. .modal-footer.lux-modal-footer has position: sticky + bottom: 0 —
 *        even if a legacy browser doesn't honour the flex layout, the footer
 *        stays visually pinned.
 *
 *   The audit applies to ALL .lux-modal modals across the dashboard. CSS is
 *   global so every modal that uses `.lux-modal` benefits.
 */

const fs = require('fs');
const path = require('path');

const CSS_PATH = path.join(__dirname, '..', 'public', 'css', 'app.css');
const css = fs.readFileSync(CSS_PATH, 'utf8');

function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}
const cssCode = stripCssComments(css);

describe('audit-H11 modal: .lux-modal flex-column + max-height cap', () => {
  test('.modal-content.lux-modal has flex-direction: column', () => {
    // The rule must be inside the .modal-content.lux-modal block.
    // We use a permissive search to find the block.
    const blockMatch = cssCode.match(/\.modal-content\.lux-modal\s*\{[^}]*\}/);
    expect(blockMatch).not.toBeNull();
    const block = blockMatch[0];
    expect(block).toMatch(/display\s*:\s*flex/);
    expect(block).toMatch(/flex-direction\s*:\s*column/);
    expect(block).toMatch(/max-height\s*:\s*calc\(100vh\s*-\s*3rem\)/);
  });
});

describe('audit-H11 modal: header + footer do not shrink', () => {
  // The fix uses a combined selector for header + footer (same rule applies
  // to both). Test that the combined rule contains flex-shrink: 0 and that
  // BOTH selectors are listed.
  test('.modal-content.lux-modal .modal-header + .modal-footer combined rule has flex-shrink: 0', () => {
    // Find the combined selector block
    const combined = cssCode.match(/\.modal-content\.lux-modal\s+\.modal-header\s*,\s*\.modal-content\.lux-modal\s+\.modal-footer\s*\{[^}]*\}/);
    expect(combined).not.toBeNull();
    expect(combined[0]).toMatch(/flex-shrink\s*:\s*0/);
  });

  test('header selector is present in the combined rule', () => {
    const combined = cssCode.match(/\.modal-content\.lux-modal\s+\.modal-header\s*,\s*\.modal-content\.lux-modal\s+\.modal-footer\s*\{[^}]*\}/);
    expect(combined).not.toBeNull();
    expect(combined[0]).toMatch(/\.modal-content\.lux-modal\s+\.modal-header/);
  });

  test('footer selector is present in the combined rule', () => {
    const combined = cssCode.match(/\.modal-content\.lux-modal\s+\.modal-header\s*,\s*\.modal-content\.lux-modal\s+\.modal-footer\s*\{[^}]*\}/);
    expect(combined).not.toBeNull();
    expect(combined[0]).toMatch(/\.modal-content\.lux-modal\s+\.modal-footer/);
  });
});

describe('audit-H11 modal: body scrolls internally', () => {
  test('.modal-content.lux-modal .modal-body has overflow-y: auto', () => {
    const blockMatch = cssCode.match(/\.modal-content\.lux-modal\s+\.modal-body\s*\{[^}]*\}/);
    expect(blockMatch).not.toBeNull();
    expect(blockMatch[0]).toMatch(/overflow-y\s*:\s*auto/);
  });

  test('.modal-content.lux-modal .modal-body has flex: 1 1 auto + min-height: 0', () => {
    // The flex+min-height pattern is what makes overflow-y work inside a flex
    // parent. Without min-height: 0 the body grows past max-height and pushes
    // the footer out anyway.
    const blockMatch = cssCode.match(/\.modal-content\.lux-modal\s+\.modal-body\s*\{[^}]*\}/);
    expect(blockMatch).not.toBeNull();
    expect(blockMatch[0]).toMatch(/flex\s*:\s*1\s+1\s+auto/);
    expect(blockMatch[0]).toMatch(/min-height\s*:\s*0/);
  });
});

describe('audit-H11 modal: footer sticky + position', () => {
  test('.lux-modal-footer has position: sticky + bottom: 0', () => {
    const blockMatch = cssCode.match(/\.modal-content\.lux-modal\s+\.modal-footer\.lux-modal-footer\s*\{[^}]*\}/);
    expect(blockMatch).not.toBeNull();
    expect(blockMatch[0]).toMatch(/position\s*:\s*sticky/);
    expect(blockMatch[0]).toMatch(/bottom\s*:\s*0/);
  });
});

describe('audit-H11 modal: existing visual properties preserved', () => {
  test('gradient background + border + border-radius still applied', () => {
    // Sanity check: the refactor did not strip the original visual properties.
    const blockMatch = cssCode.match(/\.modal-content\.lux-modal\s*\{[^}]*\}/);
    expect(blockMatch).not.toBeNull();
    expect(blockMatch[0]).toMatch(/background\s*:\s*linear-gradient/);
    expect(blockMatch[0]).toMatch(/border\s*:\s*1px solid/);
    expect(blockMatch[0]).toMatch(/border-radius/);
    expect(blockMatch[0]).toMatch(/box-shadow/);
  });

  test('overflow:hidden retained on the outer container', () => {
    // .lux-modal needs overflow:hidden to clip the rounded corners + animated
    // header gradient. The body now scrolls INSIDE the container instead.
    const blockMatch = cssCode.match(/\.modal-content\.lux-modal\s*\{[^}]*\}/);
    expect(blockMatch).not.toBeNull();
    expect(blockMatch[0]).toMatch(/overflow\s*:\s*hidden/);
  });
});

describe('audit-H11 modal: source annotation', () => {
  test('FIX-2026-09-01 audit H11 comment present in CSS', () => {
    expect(css).toMatch(/FIX-2026-09-01 audit H11/);
  });
});

describe('audit-H11 modal: HTML markup unchanged (no class additions needed)', () => {
  // The fix is CSS-only; the existing #confirmActionModal HTML markup in
  // bots.html / bot-detail.html / wallet.html uses .lux-modal + .lux-modal-header
  // + .lux-modal-footer + standard Bootstrap modal-body/modal-footer, which
  // is exactly what the new CSS targets. No HTML changes required.
  const HTML_FILES = [
    path.join(__dirname, '..', 'public', 'bots.html'),
    path.join(__dirname, '..', 'public', 'bot-detail.html'),
    path.join(__dirname, '..', 'public', 'wallet.html'),
  ];

  for (const htmlPath of HTML_FILES) {
    const pageName = path.basename(htmlPath);
    test(`${pageName}: #confirmActionModal uses .lux-modal + .lux-modal-footer`, () => {
      const html = fs.readFileSync(htmlPath, 'utf8');
      expect(html).toMatch(/id=["']confirmActionModal["'][\s\S]{0,500}class=["'][^"']*lux-modal/);
      expect(html).toMatch(/class=["'][^"']*lux-modal-footer/);
      // The modal-body and modal-footer are Bootstrap standard classes — no
      // class change required.
      expect(html).toMatch(/class=["']modal-body["']/);
      expect(html).toMatch(/class=["']modal-footer[^"']*["']/);
    });
  }
});

describe('audit-H11 modal: regression — flex-shrink/overflow contract integrity', () => {
  // If someone removes the combined flex-shrink:0 rule in the future, the
  // body would re-grow past max-height and the footer would scroll out. This
  // test is a regression guard.
  test('combined header+footer rule still applies flex-shrink:0', () => {
    const combined = cssCode.match(/\.modal-content\.lux-modal\s+\.modal-header\s*,\s*\.modal-content\.lux-modal\s+\.modal-footer\s*\{[^}]*\}/);
    expect(combined).not.toBeNull();
    expect(combined[0]).toMatch(/flex-shrink\s*:\s*0/);
  });
});