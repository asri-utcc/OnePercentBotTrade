'use strict';

// FIX-2026-08-01: Bot Quality Indicator breakdown modal
//   - คลิกที่ pill (bot card หรือ bot-detail hero) → เปิด modal นี้
//   - โหลด /api/bots/:id/quality → แสดง 4 criteria (Volume / Top50 / Squeeze / Trend)
//   - hand-rolled overlay (mirror .pnl-modal-* pattern ใน pnl.js)
//   - public API: window.qualityModal.openQualityModal(bot)

(function () {
  let overlay = null;

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function ensureSkeleton() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'quality-modal-overlay';
    overlay.innerHTML = `
      <div class="quality-modal-card">
        <div class="quality-modal-header">
          <h5 id="qm-title">🎯 Quality Indicator</h5>
          <button type="button" class="quality-modal-close" aria-label="ปิด">✕</button>
        </div>
        <div class="quality-modal-body" id="qm-body">
          <div class="text-muted-3 text-center py-3">กำลังโหลด…</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.quality-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('is-open')) close();
    });
    return overlay;
  }

  function close() {
    if (overlay) overlay.classList.remove('is-open');
  }

  function fmtVal(c) {
    if (c.value == null) return '-';
    if (c.k === 'Volume') return Number(c.value).toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (c.k === 'Top50') return c.value != null ? `#${c.value} / ${c.threshold || '-'}` : '-';
    return `${Number(c.value).toFixed(1)}%`;
  }

  function fmtThr(c) {
    if (c.threshold == null) return '-';
    if (c.k === 'Volume') return `≥ ${Number(c.threshold).toLocaleString('en-US')} USDT`;
    if (c.k === 'Top50') return `top ${c.threshold}`;
    if (c.k === 'Squeeze') return `≥ ${c.threshold}% (KC width < ${c.kcTightPct != null ? c.kcTightPct : '-'}%)`;
    if (c.k === 'Trend') return `≥ ${c.threshold}% (EMA20 on ${c.trendTF || '-'} · ${c.trendState || '-'})`;
    return String(c.threshold);
  }

  async function openQualityModal(bot) {
    if (!bot || !bot._id) return;
    const o = ensureSkeleton();
    document.getElementById('qm-title').textContent = `🎯 Quality — ${bot.symbol} ${bot.timeframe}`;
    o.classList.add('is-open');
    const body = document.getElementById('qm-body');
    body.innerHTML = '<div class="text-muted-3 text-center py-3">กำลังโหลด…</div>';
    try {
      const data = await API.get(`/api/bots/${bot._id}/quality`);
      if (!data.enabled) {
        body.innerHTML = '<div class="alert alert-warning">⚠️ Quality Indicator ถูกปิดอยู่ (Settings → 🎯 Quality Indicator)</div>';
        return;
      }
      const b = data.breakdown || {};
      const crits = ['Volume', 'Top50', 'Squeeze', 'Trend'].map((k) => {
        const lower = k.toLowerCase();
        const row = b[lower] || {};
        return {
          k,
          value: row.value,
          threshold: row.threshold,
          pass: !!row.pass,
          kcTightPct: row.kcTightPct,
          trendTF: row.trendTF,
          trendState: row.trendState,
          error: row.error,
          reason: row.reason,
        };
      });
      const rows = crits.map((c) => `
        <div class="quality-criterion-row">
          <span class="k">${c.k}${c.reason ? ` <span class="text-muted-3" style="font-size:0.7rem;">(${c.reason})</span>` : ''}</span>
          <span class="v">${fmtVal(c)}</span>
          <span class="t">${fmtThr(c)}</span>
          <span class="p ${c.pass ? 'is-pass' : 'is-fail'}">${c.pass ? 'PASS' : 'FAIL'}</span>
        </div>`).join('');
      const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('th-TH') : '-';
      const cachedLabel = data.cached ? ' (cached)' : '';
      const scoreLabel = data.score != null ? `${data.score}/4` : '—';
      body.innerHTML = `
        <div class="quality-summary">
          <div class="score-pill quality-pill is-${data.color || 'gray'}">${scoreLabel}</div>
          <div>
            <div style="font-weight:600;">คะแนนรวม: ${scoreLabel}</div>
            <div class="text-muted-3" style="font-size:0.78rem;">อัปเดตล่าสุด: ${updated}${cachedLabel}</div>
          </div>
        </div>
        <div>${rows}</div>
        <div class="text-muted-3 mt-3" style="font-size:0.78rem;">
          Threshold ตั้งได้ที่ <a href="/settings.html">Settings → 🎯 Quality Indicator</a>
        </div>`;
    } catch (err) {
      body.innerHTML = `<div class="alert alert-danger">โหลด quality ล้มเหลว: ${escapeHtml(err.message)}</div>`;
    }
  }

  window.qualityModal = { openQualityModal, close };
})();
