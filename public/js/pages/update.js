'use strict';

/**
 * FIX-2026-09-09: OneClick Update — UI page module.
 *
 *   Exposes:
 *     window.refreshUpdateStatus()  — fetch /api/app/update-status, update navbar pill
 *     window.openUpdateModal()      — open the update modal (also wired to pill click)
 *
 *   Loaded AFTER ws-client.js (so AdminModalAlert is defined) on pages
 *   that opt in (e.g. dashboard, settings, bots).
 *
 *   Self-contained: no external deps. Polls update status like the
 *   version pill polls /api/app/version.
 */

(function () {
  const PILL_ID = 'nav-update-pill';
  const POLL_MS = 5 * 60 * 1000;       // 5 min — navbar pill refresh
  const MODAL_AUTO_OPEN_MS = 1500;      // after page load, if newer exists

  function _escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _fmtBytes(n) {
    if (!n || !Number.isFinite(Number(n))) return '';
    const num = Number(n);
    if (num < 1024 * 1024) return (num / 1024).toFixed(1) + ' KB';
    return (num / 1024 / 1024).toFixed(2) + ' MB';
  }

  function _renderPill(state) {
    const pill = document.getElementById(PILL_ID);
    if (!pill) return;
    if (!state || !state.available) {
      pill.style.display = 'none';
      return;
    }
    const critical = state.critical ? ' ⚠️' : '';
    pill.textContent = `🆕 v${state.latest}${critical}`;
    pill.title = `Bot update available: v${state.latest} (you are on v${state.current})`;
    pill.style.display = '';
    pill.classList.toggle('critical', !!state.critical);
  }

  async function refreshUpdateStatus() {
    try {
      const r = await API.get('/api/app/update-status');
      _renderPill(r);
      return r;
    } catch (_) {
      _renderPill(null);
      return null;
    }
  }

  function _buildModalHtml(state) {
    const critical = state.critical
      ? `<div style="margin:8px 0; padding:10px; background:#5a1818; border:1px solid #c33; border-radius:6px; color:#fcc;">⚠️ <strong>Critical release</strong> — strongly recommended.</div>`
      : '';
    const changelog = (state.changelog || '').slice(0, 1500);
    // Very basic Markdown rendering (lines + lists). No need for full MD lib here.
    const md = changelog
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^###\s+(.+)$/gm, '<h4>$1</h4>')
      .replace(/^##\s+(.+)$/gm, '<h3>$1</h3>')
      .replace(/^#\s+(.+)$/gm, '<h2>$1</h2>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^- (.+)$/gm, '• $1')
      .replace(/\n/g, '<br>');
    return `
      <div style="display:flex; gap:24px; align-items:center; margin-bottom:12px;">
        <div style="text-align:center;">
          <div style="font-size:0.78rem; opacity:0.7;">Current</div>
          <div style="font-size:1.6rem; font-family:monospace; opacity:0.85;">v${_escapeHtml(state.current)}</div>
        </div>
        <div style="font-size:1.4rem; opacity:0.5;">→</div>
        <div style="text-align:center;">
          <div style="font-size:0.78rem; opacity:0.7;">Latest</div>
          <div style="font-size:1.6rem; font-family:monospace; color:${state.critical ? '#f88' : '#7df'};">v${_escapeHtml(state.latest)}${state.critical ? ' ⚠️' : ''}</div>
        </div>
        <div style="margin-left:auto; font-size:0.78rem; opacity:0.6;">
          ${state.tarballBytes ? '📦 ' + _escapeHtml(_fmtBytes(state.tarballBytes)) : ''}
        </div>
      </div>
      ${critical}
      ${changelog ? `<details open style="margin-top:10px;"><summary><strong>Changelog</strong></summary><div style="padding:8px 4px; font-size:0.88rem; line-height:1.5; max-height:280px; overflow-y:auto;">${md}</div></details>` : ''}
      <p style="margin-top:12px; font-size:0.84rem; opacity:0.75;">
        Backup + MongoDB snapshot จะถูกสร้างก่อนติดตั้ง — ถ้า update ล้มเหลวระบบจะ rollback อัตโนมัติ
        และบอทจะกลับมาทำงานต่อบนเวอร์ชั่นเดิมทันที (pm2 reload).
      </p>
    `;
  }

  async function openUpdateModal(opts = {}) {
    const state = await refreshUpdateStatus();
    if (!state || !state.available) return false;
    if (state.dismissed === true) return false;
    const html = _buildModalHtml(state);
    const proceed = await AdminModalAlert.confirmHtml({
      title: state.critical ? '⚠️ Critical Update Available' : '🆕 Update Available',
      html,
      level: state.critical ? 'error' : 'info',
      okLabel: 'Update Now',
      cancelLabel: 'Later',
      wideBox: true,
    });
    if (proceed) return await _runUpdate(state);
    // Dismiss — record so we don't reopen modal repeatedly for same version
    try {
      await API.post('/api/app/update-dismiss', { version: state.latest });
    } catch (_) {}
    return false;
  }

  async function _runUpdate(state) {
    const progModal = _showProgressModal(state);
    try {
      const r = await API.post('/api/app/apply-update', {
        version: state.latest,
        tarballUrl: state.downloadUrl,
        sha256: state.tarballSha256,
        migrations: state.migrations || [],
        manifestHash: state.manifestHash,
        tarballBytes: state.tarballBytes,
      });
      progModal.complete(r);
      return r;
    } catch (err) {
      progModal.fail(err);
      throw err;
    }
  }

  function _showProgressModal(state) {
    const html = `
      <div id="upd-progress">
        <p style="margin-bottom:10px;"><strong>v${_escapeHtml(state.current)}</strong> → <strong>v${_escapeHtml(state.latest)}</strong></p>
        <ol id="upd-phases" style="font-size:0.88rem; line-height:1.7; padding-left:24px;">
          <li>0 pre-flight</li><li>1 backup</li><li>2 download+verify</li>
          <li>3 extract</li><li>4 swap</li><li>5 npm ci</li>
          <li>6 migrations</li><li>7 pm2 reload</li><li>8 report+cleanup</li>
        </ol>
        <pre id="upd-output" style="font-size:0.78rem; max-height:200px; overflow-y:auto; background:rgba(0,0,0,0.25); padding:8px; border-radius:6px; margin-top:10px;"></pre>
      </div>`;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:9999;';
    const box = document.createElement('div');
    box.className = 'modal-box level-info';
    box.style.cssText = 'background:#1c1f24;color:#eee;padding:22px 26px;border-radius:10px;width:520px;max-width:95vw;';
    box.innerHTML = `<h3 style="margin-top:0;">🔄 Updating…</h3>${html}`;
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    return {
      complete(r) {
        box.innerHTML = `<h3 style="margin-top:0;color:#7df;">✅ Update complete</h3>
          <p>v${_escapeHtml(state.current)} → v${_escapeHtml(state.latest)}</p>
          <p style="font-size:0.86rem; opacity:0.8;">Reloading…</p>`;
      },
      fail(err) {
        box.innerHTML = `<h3 style="margin-top:0;color:#f88;">❌ Update failed</h3>
          <p style="font-size:0.86rem;">${_escapeHtml(err.message || 'unknown')}</p>
          <p style="font-size:0.86rem; opacity:0.8;">Rollback attempted (if phase ≥ 4).</p>
          <div style="text-align:right;"><button id="upd-close" class="btn-primary">Close</button></div>`;
        const btn = document.getElementById('upd-close');
        if (btn) btn.onclick = () => backdrop.remove();
      },
    };
  }

  // ─── Wire-up ──────────────────────────────────────────────────────────────

  function _bindPill() {
    const pill = document.getElementById(PILL_ID);
    if (!pill) return;
    pill.addEventListener('click', () => openUpdateModal());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      _bindPill();
      refreshUpdateStatus().then((s) => {
        if (s && s.available && !s.dismissed) {
          setTimeout(() => openUpdateModal(), MODAL_AUTO_OPEN_MS);
        }
      });
    });
  } else {
    _bindPill();
    refreshUpdateStatus().then((s) => {
      if (s && s.available && !s.dismissed) {
        setTimeout(() => openUpdateModal(), MODAL_AUTO_OPEN_MS);
      }
    });
  }
  setInterval(() => refreshUpdateStatus(), POLL_MS);

  window.refreshUpdateStatus = refreshUpdateStatus;
  window.openUpdateModal = openUpdateModal;
})();
