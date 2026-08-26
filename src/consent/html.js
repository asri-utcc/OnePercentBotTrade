'use strict';

/**
 * FIX-2026-08-26 Phase 2c: Consent page HTML renderer.
 *
 *   Inline CSS + minimal JS. Self-contained — no external deps.
 *   Layout: dark theme matching the bot dashboard.
 *   Behavior:
 *     - user MUST tick each section's "I have read and understood" box
 *     - Accept/Decline buttons stay disabled until ALL boxes ticked
 *     - Accept: POST /consent/accept → reload page
 *     - Decline: POST /consent/decline → confirm modal → reload
 *     - if `currentDecision` provided (settings change mode), show banner
 */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderSections(sections) {
  return sections.map((s, i) => {
    const en = s.body.en.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
    const th = s.body.th.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
    return `
      <section class="cs-section" data-section="${escapeHtml(s.id)}">
        <h2><span class="lang-en">${escapeHtml(s.title.en)}</span><span class="lang-th">${escapeHtml(s.title.th)}</span></h2>
        <div class="cs-body">
          <div class="lang-en">${en}</div>
          <div class="lang-th">${th}</div>
        </div>
        <label class="cs-tick">
          <input type="checkbox" class="cs-read" data-section="${escapeHtml(s.id)}" />
          <span class="lang-en">I have read and understood this section.</span>
          <span class="lang-th">ฉันได้อ่านและเข้าใจในส่วนนี้แล้ว</span>
        </label>
      </section>
    `;
  }).join('');
}

function pageHtml({ sections, currentDecision, decisionBanner }) {
  const bannerHtml = decisionBanner ? `
    <div class="cs-banner ${escapeHtml(decisionBanner.kind)}">
      <span class="lang-en">${escapeHtml(decisionBanner.en)}</span>
      <span class="lang-th">${escapeHtml(decisionBanner.th)}</span>
    </div>` : '';

  const statusHtml = currentDecision ? `
    <div class="cs-status">
      <span class="lang-en">Current decision on this machine:</span>
      <span class="lang-th">สถานะปัจจุบันของเครื่องนี้:</span>
      <strong class="cs-status-${escapeHtml(currentDecision)}">${escapeHtml(currentDecision.toUpperCase())}</strong>
      <small class="lang-en">(you can change this below)</small>
      <small class="lang-th">(เปลี่ยนได้ด้านล่าง)</small>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>OnePercentBot — Consent</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f1419; color: #e6e6e6; line-height: 1.6; padding: 24px;
  }
  .cs-container { max-width: 820px; margin: 0 auto; }
  header.cs-header { margin-bottom: 24px; }
  header.cs-header h1 { font-size: 26px; margin-bottom: 6px; }
  header.cs-header p { color: #8b95a5; font-size: 14px; }
  .lang-en { display: block; }
  .lang-th { display: block; color: #b8c2d0; font-size: 0.92em; margin-top: 2px; }
  .cs-section {
    background: #1a1f29; border: 1px solid #2d3748; border-radius: 10px;
    padding: 20px; margin-bottom: 16px;
  }
  .cs-section h2 { font-size: 18px; margin-bottom: 12px; color: #4a9eff; }
  .cs-body { font-size: 14px; margin-bottom: 16px; }
  .cs-body p { margin-bottom: 8px; }
  .cs-body code { background: #0f1419; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  .cs-tick {
    display: flex; gap: 10px; align-items: flex-start; cursor: pointer;
    padding: 10px; background: #0f1419; border-radius: 6px; font-size: 13px;
  }
  .cs-tick input[type=checkbox] { width: 18px; height: 18px; margin-top: 2px; cursor: pointer; }
  .cs-status {
    background: #1a1f29; border: 1px solid #2d3748; border-radius: 8px;
    padding: 12px 16px; margin-bottom: 16px; font-size: 13px;
  }
  .cs-status-accepted { color: #4ade80; }
  .cs-status-declined { color: #f87171; }
  .cs-status small { color: #8b95a5; display: block; margin-top: 4px; }
  .cs-banner {
    padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 13px;
  }
  .cs-banner.error { background: #3a0f0f; border: 1px solid #ef4444; }
  .cs-banner.success { background: #0f3a2c; border: 1px solid #4ade80; }
  .cs-banner.info { background: #0f2a3a; border: 1px solid #60a5fa; }
  .cs-actions {
    display: flex; gap: 12px; justify-content: center; margin-top: 24px;
    padding-top: 24px; border-top: 1px solid #2d3748;
  }
  .cs-btn {
    padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer;
    font-size: 15px; font-weight: 600;
  }
  .cs-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .cs-btn-accept { background: #4ade80; color: #0f1419; }
  .cs-btn-accept:hover:not(:disabled) { background: #22c55e; }
  .cs-btn-decline { background: #ef4444; color: white; }
  .cs-btn-decline:hover:not(:disabled) { background: #dc2626; }
  footer.cs-footer { text-align: center; margin-top: 32px; color: #8b95a5; font-size: 12px; }
  @media (max-width: 600px) {
    body { padding: 12px; }
    .cs-section { padding: 16px; }
    .cs-btn { padding: 10px 16px; font-size: 14px; }
  }
</style>
</head>
<body>
<div class="cs-container">
  <header class="cs-header">
    <h1>🛡️ OnePercentBot — First-Run Consent</h1>
    <p class="lang-en">Please read each section carefully and confirm before continuing.</p>
    <p class="lang-th">กรุณาอ่านแต่ละส่วนให้ละเอียดและยืนยันก่อนดำเนินการต่อ</p>
  </header>

  ${bannerHtml}
  ${statusHtml}

  <form id="cs-form" method="POST">
    ${renderSections(sections)}

    <div class="cs-actions">
      <button type="submit" formaction="/consent/accept" class="cs-btn cs-btn-accept" id="cs-accept" disabled>
        <span class="lang-en">✅ I Accept</span>
        <span class="lang-th">✅ ยอมรับ</span>
      </button>
      <button type="submit" formaction="/consent/decline" class="cs-btn cs-btn-decline" id="cs-decline" disabled>
        <span class="lang-en">❌ I Decline</span>
        <span class="lang-th">❌ ไม่ยอมรับ</span>
      </button>
    </div>
  </form>

  <footer class="cs-footer">
    <p class="lang-en">Consent version ${escapeHtml(require('./config').version)}. Your decision is stored locally and on the admin server (defense in depth).</p>
    <p class="lang-th">Consent version ${escapeHtml(require('./config').version)}. การตัดสินใจถูกเก็บที่เครื่องและ admin server (ป้องกันสองชั้น)</p>
  </footer>
</div>

<script>
(function() {
  var boxes = document.querySelectorAll('.cs-read');
  var btns = document.querySelectorAll('#cs-accept, #cs-decline');
  function updateButtons() {
    var all = Array.prototype.every.call(boxes, function(b) { return b.checked; });
    btns.forEach(function(b) { b.disabled = !all; });
  }
  boxes.forEach(function(b) { b.addEventListener('change', updateButtons); });

  // Decline confirm
  var form = document.getElementById('cs-form');
  form.addEventListener('submit', function(e) {
    if (e.submitter && e.submitter.id === 'cs-decline') {
      if (!confirm('Decline will pause the bot immediately — no new positions will be opened. Existing positions remain open per the position-safety clause.\\n\\nAre you sure?')) {
        e.preventDefault();
      }
    }
  });
})();
</script>
</body>
</html>`;
}

module.exports = { pageHtml };