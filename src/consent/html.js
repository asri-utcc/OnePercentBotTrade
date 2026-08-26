'use strict';

/**
 * FIX-2026-08-26 Phase 2c: Consent page HTML renderer.
 *
 *   Inline CSS + minimal JS. Self-contained — no external deps.
 *   Layout: formal document style (light background, serif font, numbered
 *   sections, single final acknowledgement checkbox).
 *
 *   Behavior:
 *     - User must tick the single "I have read and accept all conditions"
 *       checkbox before Accept/Decline buttons unlock
 *     - Accept: POST <actionBase>/accept → reload page
 *     - Decline: POST <actionBase>/decline → confirm modal → reload
 *     - If `currentDecision` provided (settings change mode), show banner
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
      <section class="cs-section">
        <h2><span class="cs-clause-num">${i + 1}.</span> <span class="lang-en">${escapeHtml(s.title.en)}</span><span class="lang-th">${escapeHtml(s.title.th)}</span></h2>
        <div class="cs-body">
          <div class="lang-en">${en}</div>
          <div class="lang-th">${th}</div>
        </div>
      </section>
    `;
  }).join('');
}

function pageHtml({ sections, currentDecision, decisionBanner, actionBase = '/consent' }) {
  const acceptAction = escapeHtml(actionBase + '/accept');
  const declineAction = escapeHtml(actionBase + '/decline');
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
      <small class="lang-en">(you may revise your decision below)</small>
      <small class="lang-th">(สามารถแก้ไขการตัดสินใจด้านล่าง)</small>
    </div>` : '';

  const consentVersion = escapeHtml(require('./config').version);
  const docDate = new Date().toISOString().slice(0, 10);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Consent and Agreement — OnePercentBot</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #f4f4f1; color: #1a1a1a; }
  body {
    font-family: 'Times New Roman', Georgia, serif;
    line-height: 1.65; padding: 32px 20px;
  }
  .cs-container { max-width: 760px; margin: 0 auto; background: #ffffff; border: 1px solid #c8c8c8; padding: 48px 56px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  header.cs-header {
    text-align: center;
    border-bottom: 2px solid #1a1a1a;
    padding-bottom: 18px;
    margin-bottom: 28px;
  }
  header.cs-header h1 {
    font-size: 22px;
    font-weight: bold;
    letter-spacing: 1px;
    margin-bottom: 4px;
  }
  header.cs-header .cs-subtitle {
    font-size: 13px; color: #555;
    font-style: italic; letter-spacing: 0.5px;
  }
  header.cs-header .cs-meta {
    font-size: 11px; color: #777;
    margin-top: 8px; letter-spacing: 0.5px;
  }
  .lang-en { display: block; }
  .lang-th { display: block; font-size: 0.92em; color: #555; margin-top: 2px; }
  .cs-section { margin-bottom: 22px; }
  .cs-section h2 {
    font-size: 15px; font-weight: bold; margin-bottom: 10px;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .cs-clause-num {
    display: inline-block; margin-right: 6px; font-weight: bold;
  }
  .cs-body { font-size: 14px; text-align: justify; }
  .cs-body p { margin-bottom: 8px; text-indent: 1.5em; }
  .cs-body p:first-child { text-indent: 0; }
  .cs-status {
    background: #f8f8f5; border: 1px solid #c8c8c8;
    padding: 10px 14px; margin-bottom: 20px; font-size: 13px;
  }
  .cs-status-accepted { color: #1a6b1a; }
  .cs-status-declined { color: #8b1a1a; }
  .cs-status small { color: #777; display: block; margin-top: 4px; }
  .cs-banner {
    padding: 10px 14px; border: 1px solid; margin-bottom: 20px; font-size: 13px;
  }
  .cs-banner.error { background: #fdf3f3; border-color: #8b1a1a; }
  .cs-banner.success { background: #f3fdf5; border-color: #1a6b1a; }
  .cs-banner.info { background: #f3f7fd; border-color: #1a4a8b; }
  .cs-ack {
    border-top: 1px solid #1a1a1a;
    border-bottom: 1px solid #1a1a1a;
    padding: 16px 0; margin: 28px 0 24px;
    background: #fafaf7;
  }
  .cs-ack label {
    display: flex; gap: 12px; align-items: flex-start;
    cursor: pointer; font-size: 14px; font-weight: bold;
  }
  .cs-ack input[type=checkbox] {
    width: 18px; height: 18px; margin-top: 3px; cursor: pointer;
    flex-shrink: 0;
  }
  .cs-ack .cs-ack-note {
    font-size: 12px; color: #777; font-weight: normal;
    margin-top: 8px; padding-left: 30px; font-style: italic;
  }
  .cs-actions {
    display: flex; gap: 16px; justify-content: space-between;
    margin-top: 24px; padding-top: 20px;
  }
  .cs-btn {
    flex: 1; max-width: 240px;
    padding: 12px 20px; border: 1px solid; border-radius: 0;
    cursor: pointer; font-size: 14px; font-weight: bold;
    font-family: 'Times New Roman', Georgia, serif;
    letter-spacing: 1px; text-transform: uppercase;
    background: #ffffff;
  }
  .cs-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .cs-btn-accept { border-color: #1a1a1a; color: #1a1a1a; }
  .cs-btn-accept:hover:not(:disabled) { background: #1a1a1a; color: #ffffff; }
  .cs-btn-decline { border-color: #555; color: #555; }
  .cs-btn-decline:hover:not(:disabled) { background: #555; color: #ffffff; }
  footer.cs-footer {
    margin-top: 32px; padding-top: 16px;
    border-top: 1px solid #c8c8c8;
    font-size: 11px; color: #777; text-align: center;
    font-style: italic;
  }
  @media (max-width: 600px) {
    body { padding: 12px; }
    .cs-container { padding: 24px 20px; }
    .cs-actions { flex-direction: column; }
    .cs-btn { max-width: 100%; }
  }
</style>
</head>
<body>
<div class="cs-container">
  <header class="cs-header">
    <h1 class="lang-en">Consent and Agreement</h1>
    <h1 class="lang-th">คำยินยอมและข้อตกลง</h1>
    <p class="cs-subtitle lang-en">OnePercentBot — Automated Cryptocurrency Trading Software</p>
    <p class="cs-subtitle lang-th">OnePercentBot — ซอฟต์แวร์เทรดคริปโตอัตโนมัติ</p>
    <p class="cs-meta">Document version ${consentVersion} · Issued ${docDate}</p>
  </header>

  ${bannerHtml}
  ${statusHtml}

  <form id="cs-form" method="POST">
    ${renderSections(sections)}

    <div class="cs-ack">
      <label>
        <input type="checkbox" id="cs-ack-box" />
        <span>
          <span class="lang-en">I have read the entire document above and accept all conditions.</span>
          <span class="lang-th">ฉันอ่านเอกสารทั้งหมดข้างต้นแล้ว และยอมรับทุกเงื่อนไข</span>
        </span>
      </label>
      <p class="cs-ack-note">
        <span class="lang-en">Both buttons will become available once this box is ticked.</span>
        <span class="lang-th">ปุ่มทั้งสองจะใช้งานได้เมื่อทำเครื่องหมายที่ช่องนี้แล้ว</span>
      </p>
    </div>

    <div class="cs-actions">
      <button type="submit" formaction="${declineAction}" class="cs-btn cs-btn-decline" id="cs-decline" disabled>
        <span class="lang-en">Decline</span>
        <span class="lang-th">ไม่ตกลง</span>
      </button>
      <button type="submit" formaction="${acceptAction}" class="cs-btn cs-btn-accept" id="cs-accept" disabled>
        <span class="lang-en">Accept</span>
        <span class="lang-th">ตกลง</span>
      </button>
    </div>
  </form>

  <footer class="cs-footer">
    <p class="lang-en">Your decision is recorded locally on this machine and on the operator's administration server for audit purposes. The decision may be revised at any time by resubmitting this form.</p>
    <p class="lang-th">การตัดสินใจของท่านจะถูกบันทึกไว้ในเครื่องนี้และบน administration server ของผู้พัฒนา เพื่อการตรวจสอบ ท่านสามารถแก้ไขการตัดสินใจได้ตลอดเวลาโดยส่งแบบฟอร์มนี้อีกครั้ง</p>
  </footer>
</div>

<script>
(function() {
  var box = document.getElementById('cs-ack-box');
  var btns = document.querySelectorAll('#cs-accept, #cs-decline');
  function updateButtons() {
    btns.forEach(function(b) { b.disabled = !box.checked; });
  }
  box.addEventListener('change', updateButtons);
  updateButtons();

  // Decline confirm
  var form = document.getElementById('cs-form');
  form.addEventListener('submit', function(e) {
    if (e.submitter && e.submitter.id === 'cs-decline') {
      if (!confirm('Declining will pause the bot immediately. No new trading positions will be opened. Existing open positions, if any, will continue to be managed under their existing take-profit and stop-loss rules.\\n\\nDo you wish to decline?')) {
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