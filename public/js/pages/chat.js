'use strict';

/**
 * Phase 4-2026-08-29 / CHAT-V2-2026-08-31 — Operator chat page (/chat.html)
 *
 * Two tabs: Community (everyone) | DM Admin (single thread).
 * Polls /api/chat/history every 5s; listens on /ws/dashboard for 'chat:message'
 * (forwarded to window CustomEvent by ws-client.js).
 *
 * Phase 4 chat v2 features:
 *   - color + icon rendering (operator's persisted identity)
 *   - day-divider + burst timestamp suppression
 *   - reply/quote inline above message body
 *   - attachment rendering (image thumb / file link → modal preview)
 *   - 📎 button → file picker → upload (500KB cap, 5/day quota)
 *   - color swatch picker + icon dropdown (settings row)
 */

(function () {
  const POLL_MS = 5000;
  const BURST_GAP_MS = 5 * 60 * 1000;

  const OPERATOR_COLORS = ['#4a9eff', '#22c55e', '#eab308', '#a855f7', '#ec4899', '#06b6d4', '#f97316', '#84cc16'];
  const SYSTEM_ICONS = ['🦊', '🐱', '🐶', '🐼', '🦁', '🐯', '🐸', '🐵', '🦉', '🦅', '🐢', '🐧', '🐳', '🦋', '🐝', '🐞', '🌸', '🌺', '🌻', '🍀'];
  const ADMIN_COLOR = '#ef4444';
  const ADMIN_ICON = '🛡';

  let _view = 'community';
  let _messages = [];
  let _since = null;
  // FIX 2026-09-01: auth-state tracking so we don't pre-emptively hit
  // requireAuth endpoints before login (no more 401 spam in console)
  let _authed = false;
  // FIX 2026-09-01: safeStorage wrapper — Edge Tracking Prevention in strict
  // mode logs a console warning BEFORE the throw, so try/catch alone isn't
  // enough. We probe once at module-load and skip storage entirely if blocked.
  let _storageOK = (function () {
    try { sessionStorage.setItem('__probe', '1'); sessionStorage.removeItem('__probe'); return true; }
    catch (_) { return false; }
  })();
  const _ssGet = (k) => { if (!_storageOK) return null; try { return sessionStorage.getItem(k); } catch (_) { return null; } };
  const _ssSet = (k, v) => { if (!_storageOK) return; try { sessionStorage.setItem(k, v); } catch (_) {} };
  let _pollHandle = null;
  let _historyCursor = null;
  let _replyTo = null;
  let _myColor = '';
  let _myIcon = '';
  let _pendingFile = null;
  let _quota = { used: 0, limit: 5, remaining: 5, resetAt: null };

  // ── Helpers ──
  function _el(id) { return document.getElementById(id); }
  function _escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function _formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return d.toLocaleString();
  }
  function _formatTimeExact(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString();
  }
  function _bkkDayKey(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const bkkMs = d.getTime() + (7 * 60 * 60 * 1000);
    const bkk = new Date(bkkMs);
    const y = bkk.getUTCFullYear();
    const m = String(bkk.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(bkk.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  function _ownerTag(m, mine) {
    if (mine) return { icon: '🏷', label: 'you' };
    if (m.fromAdmin) return { icon: '🛡', label: m.fromAdmin };
    if (m.fromMachineId) return { icon: '🏷', label: m.fromMachineId.slice(0, 8) };
    return { icon: '?', label: 'unknown' };
  }
  function _colorOf(m, mine) {
    if (mine) return _myColor || OPERATOR_COLORS[0];
    if (m.fromAdmin) return ADMIN_COLOR;
    return m.color || OPERATOR_COLORS[0];
  }
  function _iconOf(m, mine) {
    if (mine) return _myIcon || SYSTEM_ICONS[0];
    if (m.fromAdmin) return ADMIN_ICON;
    return m.icon || SYSTEM_ICONS[0];
  }
  function _setStatus(msg, level) {
    const el = _el('chat-status');
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.textContent = msg;
    el.className = `chat-status ${level || 'info'}`;
  }

  function _updateCharCount() {
    const ta = _el('chat-send-text');
    const counter = _el('chat-send-count');
    if (!ta || !counter) return;
    const n = (ta.value || '').length;
    counter.textContent = `${n} / 2000`;
  }

  function _updateQuotaBar() {
    const bar = _el('chat-quota-bar');
    if (!bar) return;
    if (_quota.limit == null) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    bar.innerHTML = `📁 <strong>${_quota.used}/${_quota.limit}</strong> used today · resets at 00:00 BKK`;
  }

  // ── Identity rendering row (compact chip → popover) ──
  function _renderIdentityRow() {
    const row = _el('chat-identity-row');
    if (!row) return;
    // FIX 2026-08-31: compact chip — single button shows current color+icon,
    // popover opens full picker. Avoids 28-button row taking 3 lines of space.
    const c = _myColor || '#888';
    const ic = _myIcon || '👤';
    row.innerHTML = `
      <button type="button" id="chat-identity-chip" class="chat-identity-chip" style="border-color:${c};color:${c};" title="เปลี่ยนสี/ไอคอน">
        <span class="chat-identity-chip-icon" style="color:${c}">${ic}</span>
        <span class="chat-identity-chip-text">${_myColor || _myIcon ? 'เปลี่ยน' : 'เลือกสี/ไอคอน'}</span>
      </button>
      <div id="chat-identity-popover" class="chat-identity-popover hidden">
        <div class="chat-popover-section">
          <div class="chat-popover-label">🎨 สี</div>
          <div class="chat-popover-colors">
            ${OPERATOR_COLORS.map((cc) =>
              `<button type="button" class="chat-swatch" data-color="${cc}" style="background:${cc};${_myColor === cc ? 'outline:2px solid #fff;' : ''}" title="${cc}"></button>`
            ).join('')}
          </div>
        </div>
        <div class="chat-popover-section">
          <div class="chat-popover-label">🐾 ไอคอน</div>
          <div class="chat-popover-icons">
            ${SYSTEM_ICONS.map((ii) =>
              `<button type="button" class="chat-icon-btn" data-icon="${ii}" style="${_myIcon === ii ? 'outline:2px solid #fff;' : ''}">${ii}</button>`
            ).join('')}
          </div>
        </div>
      </div>
    `;
    const chip = _el('chat-identity-chip');
    const pop = _el('chat-identity-popover');
    if (chip && pop) {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        pop.classList.toggle('hidden');
      });
      document.addEventListener('click', (e) => {
        if (!pop.contains(e.target) && e.target !== chip) pop.classList.add('hidden');
      });
      pop.querySelectorAll('.chat-swatch').forEach((b) =>
        b.addEventListener('click', () => { _setMyColor(b.dataset.color); pop.classList.add('hidden'); })
      );
      pop.querySelectorAll('.chat-icon-btn').forEach((b) =>
        b.addEventListener('click', () => { _setMyIcon(b.dataset.icon); pop.classList.add('hidden'); })
      );
    }
  }

  async function _loadMyIdentity() {
    try {
      const r = await API.get('/api/chat/identity');
      _myColor = r.color || '';
      _myIcon = r.icon || '';
      _authed = true; // FIX 2026-09-01: auth confirmed
    } catch (err) {
      // FIX 2026-09-01: detect "not logged in" so we don't spam quota/history polls
      if (err && err.status === 401) { _authed = false; return; }
    }
    _renderIdentityRow();
  }

  async function _setMyColor(c) {
    _myColor = c;
    _renderIdentityRow();
    try { await API.put('/api/chat/identity', { color: c }); } catch (_) {}
  }
  async function _setMyIcon(i) {
    _myIcon = i;
    _renderIdentityRow();
    try { await API.put('/api/chat/identity', { icon: i }); } catch (_) {}
  }

  async function _loadQuota() {
    // FIX 2026-09-01: skip the call entirely if we know the user isn't authed
    // (otherwise the 401 itself shows up in browser console even though we catch it)
    if (!_authed) { _updateQuotaBar(); return; }
    try {
      const r = await API.get('/api/chat/quota');
      _quota = r || _quota;
      _authed = true;
    } catch (err) {
      if (err && err.status === 401) _authed = false;
      else console.warn('chat: quota load failed', err);
    }
    _updateQuotaBar();
  }

  // ── Rendering with day-divider + burst suppression ──
  function renderMessages() {
    const wrap = _el('chat-messages');
    if (!wrap) return;
    if (_messages.length === 0) {
      wrap.innerHTML = '<p class="chat-empty">ยังไม่มีข้อความ — เป็นคนแรกที่ทักทาย!</p>';
      return;
    }
    const sorted = _messages.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    let prevDay = null, prevAt = null, prevFrom = null;
    const rows = [];
    for (const m of sorted) {
      const at = m.createdAt ? new Date(m.createdAt).getTime() : 0;
      const day = _bkkDayKey(m.createdAt);
      if (day && day !== prevDay) {
        rows.push(`<div class="chat-day-divider"><span>${_escape(day)}</span></div>`);
      }
      const isFirstOfBurst = !prevAt || (at - prevAt > BURST_GAP_MS) || (prevFrom !== (m.fromAdmin ? 'admin' : m.fromMachineId));
      prevDay = day; prevAt = at;
      prevFrom = m.fromAdmin ? 'admin' : m.fromMachineId;

      const mine = !!m.fromMachineId && !m.fromAdmin;
      const cls = mine ? 'chat-msg mine' : 'chat-msg';
      const who = m.displayName || (mine ? 'me' : 'admin');
      const owner = _ownerTag(m, mine);
      const ownerTitle = m.fromMachineId || m.fromAdmin || '';
      const color = _colorOf(m, mine);
      const icon = _iconOf(m, mine);

      const replyHtml = (m.replyTo && m.replyTo.id)
        ? `<div class="chat-msg-quote" data-reply-id="${_escape(m.replyTo.id)}">↪️ <strong>${_escape(m.replyTo.displayName || '')}</strong>: ${_escape((m.replyTo.text || '').slice(0, 80))}</div>`
        : '';
      const attachHtml = _renderAttachment(m.attachment);

      const tsHtml = isFirstOfBurst
        ? `<span class="chat-msg-time chat-msg-time-burst" title="${_escape(_formatTimeExact(m.createdAt))}">${_escape(_formatTime(m.createdAt))}</span>`
        : `<span class="chat-msg-time"></span>`;

      rows.push(`
        <div class="${cls}" data-msg-id="${_escape(m.id)}" style="border-left:4px solid ${color};background:${mine ? 'transparent' : _rgbaBg(color)};">
          <div class="chat-msg-meta">
            <span class="chat-msg-icon" style="color:${color}">${_escape(icon)}</span>
            <strong>${_escape(who)}</strong>
            <span class="chat-msg-owner" title="${_escape(ownerTitle)}">${owner.icon} ${_escape(owner.label)}</span>
            ${tsHtml}
          </div>
          ${replyHtml}
          ${attachHtml}
          <div class="chat-msg-text">${_escape(m.text)}</div>
        </div>
      `);
    }
    wrap.innerHTML = rows.join('');
    wrap.scrollTop = wrap.scrollHeight;
    _bindMessageHandlers(wrap);
  }

  function _rgbaBg(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 'transparent';
    const v = m[1];
    const r = parseInt(v.slice(0, 2), 16);
    const g = parseInt(v.slice(2, 4), 16);
    const b = parseInt(v.slice(4, 6), 16);
    return `rgba(${r},${g},${b},0.06)`;
  }

  function _renderAttachment(att) {
    if (!att || !att.id) return '';
    const name = att.name || 'file';
    const sizeKb = Math.max(1, Math.round((att.sizeBytes || 0) / 1024));
    const safeUrl = att.url || `/api/chat/attachments/${encodeURIComponent(att.id)}`;
    // FIX 2026-09-01: if the server has flagged the attachment as deleted
    // (e.g. admin removed it, or quota reset cleaned it up), render a tombstone
    // instead of an <img> that 404s in the console.
    if (att.deleted) {
      const icon = att.kind === 'image' ? '🖼' : '📄';
      return `<div class="chat-attachment-tombstone">
        <span class="chat-attachment-tombstone-icon">${icon}</span>
        <span class="chat-attachment-tombstone-text"><del>${_escape(name)}</del> · removed</span>
      </div>`;
    }
    if (att.kind === 'image') {
      // FIX 2026-09-01: onerror fallback in case the file disappears between the
      // initial render and a later lazy-load (race during admin delete).
      return `<a href="${_escape(safeUrl)}" target="_blank" rel="noopener" class="chat-attachment-thumb" data-attachment-id="${_escape(att.id)}" data-attachment-kind="image" data-attachment-name="${_escape(name)}" data-attachment-url="${_escape(safeUrl)}">
        <img src="${_escape(safeUrl)}" alt="${_escape(name)}" loading="lazy" onerror="this.closest('.chat-attachment-thumb').classList.add('chat-attachment-broken');this.replaceWith(Object.assign(document.createElement('div'),{className:'chat-attachment-tombstone',innerHTML:'<span class=\'chat-attachment-tombstone-icon\'>🖼</span><span class=\'chat-attachment-tombstone-text\'><del>'+this.alt.replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'})[c])+'</del> · removed</span>'}));" />
        <div class="chat-attachment-meta">🖼 ${_escape(name)} · ${sizeKb} KB</div>
      </a>`;
    }
    return `<a href="${_escape(safeUrl)}" target="_blank" rel="noopener" class="chat-attachment-link" data-attachment-id="${_escape(att.id)}" data-attachment-kind="text" data-attachment-name="${_escape(name)}" data-attachment-url="${_escape(safeUrl)}">📄 ${_escape(name)} · ${sizeKb} KB</a>`;
  }

  function _bindMessageHandlers(wrap) {
    wrap.querySelectorAll('.chat-msg-quote').forEach((q) => {
      q.addEventListener('click', () => {
        const rid = q.dataset.replyId;
        const target = wrap.querySelector(`[data-msg-id="${rid}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('chat-msg-flash');
          setTimeout(() => target.classList.remove('chat-msg-flash'), 1500);
        }
      });
    });
    wrap.querySelectorAll('.chat-attachment-thumb, .chat-attachment-link').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        _showAttachmentPreview({
          id: a.dataset.attachmentId,
          kind: a.dataset.attachmentKind,
          name: a.dataset.attachmentName,
          url: a.dataset.attachmentUrl,
        });
      });
    });
  }

  function _showAttachmentPreview({ id, kind, name, url }) {
    const overlay = document.createElement('div');
    overlay.className = 'chat-attachment-preview-overlay';
    const body = (kind === 'image')
      ? `<img src="${_escape(url)}" alt="${_escape(name)}" style="max-width:90vw;max-height:80vh;" />`
      : `<div class="chat-attachment-preview-text">📄 <strong>${_escape(name)}</strong></div>`;
    overlay.innerHTML = `
      <div class="chat-attachment-preview-modal">
        <div class="chat-attachment-preview-head">
          <span>📎 ${_escape(name)}</span>
          <div>
            <a href="#" data-action="download" class="chat-attachment-download">⬇ Download</a>
            <button class="chat-attachment-close">✕</button>
          </div>
        </div>
        <div class="chat-attachment-preview-body">${body}</div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.classList.contains('chat-attachment-close')) {
        document.body.removeChild(overlay);
        return;
      }
      // FIX 2026-09-01: download via fetch+blob so same-origin cookie auth is
      // sent (browser direct <a download href> ignores cookies → "needs authorization")
      const dl = e.target.closest('[data-action="download"]');
      if (dl) {
        e.preventDefault();
        _downloadAttachment(url, name).catch((err) => {
          // FIX 2026-09-01 audit C11: use themed modal instead of native alert()
          // (native alert blocks UI thread + violates bot-toast-modal-alert pattern)
          AdminModalAlert.alert('Download failed: ' + (err && err.message || 'unknown'), 'error');
        });
      }
    });
  }

  async function _downloadAttachment(url, name) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = name || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }

  // ── Reply/quote ──
  function _setReply(msg) {
    _replyTo = msg ? { id: msg.id, displayName: msg.displayName, text: msg.text } : null;
    const banner = _el('chat-reply-banner');
    if (!banner) return;
    if (_replyTo) {
      banner.innerHTML = `↪️ Replying to <strong>${_escape(_replyTo.displayName)}</strong>: ${_escape((_replyTo.text || '').slice(0, 80))} <button class="chat-reply-cancel" type="button">✕</button>`;
      banner.classList.remove('hidden');
      banner.querySelector('.chat-reply-cancel').addEventListener('click', () => _setReply(null));
    } else {
      banner.classList.add('hidden');
      banner.innerHTML = '';
    }
  }

  // ── Polling ──
  function _mergeMessages(existing, incoming) {
    const seen = new Set();
    for (const m of existing) {
      if (m.id) seen.add('id:' + m.id);
      if (m.clientId) seen.add('cid:' + m.clientId);
    }
    const out = existing.slice();
    for (const m of incoming) {
      const k1 = m.id ? 'id:' + m.id : null;
      const k2 = m.clientId ? 'cid:' + m.clientId : null;
      if (k1 && seen.has(k1)) continue;
      if (k2 && seen.has(k2)) continue;
      const dupIdx = out.findIndex(
        (x) => !x._optimistic && x.createdAt === m.createdAt && x.text === m.text
      );
      if (dupIdx !== -1) continue;
      out.push(m);
      if (k1) seen.add(k1);
      if (k2) seen.add(k2);
    }
    return out;
  }

  async function loadHistory({ reset = false } = {}) {
    try {
      const params = new URLSearchParams({ scope: _view });
      if (!reset && _since) params.set('since', _since);
      const r = await API.get('/api/chat/history?' + params.toString());
      const incoming = r.messages || [];
      if (reset) {
        _messages = _mergeMessages([], incoming).reverse();
      } else {
        _messages = _mergeMessages(_messages, incoming);
      }
      if (incoming.length > 0) {
        _since = incoming[incoming.length - 1].createdAt;
      }
      try { await API.post('/api/chat/read', { scope: _view }); } catch (_) {}
      renderMessages();
      _setStatus('');
    } catch (err) {
      _setStatus('Load failed: ' + err.message, 'error');
    }
  }

  function startPolling() {
    if (_pollHandle) return;
    _pollHandle = setInterval(() => loadHistory({ reset: false }), POLL_MS);
  }
  function stopPolling() {
    if (_pollHandle) { clearInterval(_pollHandle); _pollHandle = null; }
  }

  // ── Send ──
  async function _uploadAttachment(file) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/chat/attachments', {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      // FIX 2026-08-31: extract string error (was producing "[object Object]"
      // when admin returns {ok:false, error:{nested:...}})
      let msg = json.message || json.error;
      if (typeof msg !== 'string') {
        msg = (msg && (msg.error || msg.message)) || `HTTP ${r.status}`;
      }
      const err = new Error(typeof msg === 'string' ? msg : `HTTP ${r.status}`);
      err.status = r.status;
      err.body = json;
      throw err;
    }
    if (json.quota) _quota = json.quota;
    _updateQuotaBar();
    return json.attachment;
  }

  async function sendMessage(e) {
    if (e) e.preventDefault();
    const ta = _el('chat-send-text');
    const text = (ta.value || '').trim();
    if (!text && !_pendingFile) return;
    const btn = _el('chat-send-btn');
    btn.disabled = true;
    try {
      let attachment = null;
      if (_pendingFile) {
        try {
          attachment = await _uploadAttachment(_pendingFile);
        } catch (err) {
          _setStatus('Upload failed: ' + err.message, 'error');
          return;
        }
      }
      const body = { scope: _view, text };
      if (_replyTo) {
        body.replyTo = {
          id: _replyTo.id,
          displayName: _replyTo.displayName,
          text: (String(_replyTo.text || '')).slice(0, 100),
        };
      }
      if (attachment) body.attachment = attachment;
      if (_myColor) body.color = _myColor;
      if (_myIcon) body.icon = _myIcon;

      const r = await API.post('/api/chat/send', body);
      _authed = true; // FIX 2026-09-01: just verified auth works
      ta.value = '';
      _pendingFile = null;
      _clearPendingFile();
      _updateCharCount();
      const tempClientId = r && r.id ? r.id : null;
      _messages.push({
        scope: _view,
        fromAdmin: false,
        fromMachineId: 'local',
        displayName: _el('chat-display-name-input').value || 'me',
        text,
        color: _myColor || null,
        icon: _myIcon || null,
        replyTo: body.replyTo || null,
        attachment: body.attachment || null,
        createdAt: new Date().toISOString(),
        clientId: tempClientId,
        _optimistic: true,
      });
      _since = _messages[_messages.length - 1].createdAt;
      renderMessages();
      _setReply(null);
      _setStatus('');
      // FIX 2026-09-01: quota is already updated inside _uploadAttachment on success;
      // calling _loadQuota() again here was redundant AND produced a noisy 401 when
      // send happened with file (upload) but quota path lost auth-state momentarily.
      // Also skip when not authed to prevent 401 in console for text-only sends on
      // un-authed tabs.
    } catch (err) {
      if (err && err.status === 401) _authed = false; // FIX 2026-09-01
      _setStatus(err.message || 'Send failed', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  function _clearPendingFile() {
    const inp = _el('chat-file-input');
    if (inp) inp.value = '';
    const preview = _el('chat-file-preview');
    if (preview) {
      preview.classList.add('hidden');
      preview.innerHTML = '';
    }
  }

  function _onFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) {
      _pendingFile = null;
      _clearPendingFile();
      return;
    }
    if (file.size > 500 * 1024) {
      _setStatus('File too large (max 500KB)', 'error');
      e.target.value = '';
      return;
    }
    _pendingFile = file;
    const preview = _el('chat-file-preview');
    if (!preview) return;
    preview.classList.remove('hidden');
    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      preview.innerHTML = `<img src="${url}" alt="preview" /> <span>${_escape(file.name)} · ${Math.round(file.size / 1024)} KB</span> <button type="button" class="chat-file-clear">✕</button>`;
    } else {
      preview.innerHTML = `<span>📄 ${_escape(file.name)} · ${Math.round(file.size / 1024)} KB</span> <button type="button" class="chat-file-clear">✕</button>`;
    }
    preview.querySelector('.chat-file-clear').addEventListener('click', () => {
      _pendingFile = null;
      _clearPendingFile();
    });
  }

  // ── View switching ──
  function setView(v) {
    _view = v;
    _messages = [];
    _since = null;
    _historyCursor = null;
    document.querySelectorAll('.chat-tab-btn').forEach((b) => b.classList.remove('active'));
    if (v === 'community') {
      _el('chat-tab-community').classList.add('active');
      _el('chat-pane-title').textContent = '🌍 Community';
      _el('chat-pane-sub').textContent = 'ทุกคนเห็น — operators + admin';
      _el('chat-thread-meta').textContent = '';
    } else {
      _el('chat-tab-dm').classList.add('active');
      _el('chat-pane-title').textContent = '📨 DM Admin';
      _el('chat-pane-sub').textContent = 'ข้อความส่วนตัวถึง admin';
      _el('chat-thread-meta').textContent = 'admin';
    }
    loadHistory({ reset: true });
  }

  // ── Display name ──
  async function loadDisplayName() {
    try {
      const r = await API.get('/api/chat/display-name');
      const input = _el('chat-display-name-input');
      input.value = r.resolved || '';
      input.placeholder = `default: ${r.resolved || '(unset)'}`;
    } catch (_) {}
  }

  async function saveDisplayName() {
    const input = _el('chat-display-name-input');
    const value = input.value.trim();
    if (!value) {
      _setStatus('Display name cannot be empty', 'error');
      return;
    }
    try {
      const r = await API.put('/api/chat/display-name', { displayName: value });
      input.value = r.displayName;
      const flash = _el('chat-saved-flash');
      flash.classList.add('show');
      setTimeout(() => flash.classList.remove('show'), 1500);
      _setStatus('');
    } catch (err) {
      _setStatus(err.message || 'Save failed', 'error');
    }
  }

  // ── Live event hook ──
  function onLiveMessage(payload) {
    if (!payload) return;
    if (payload.scope !== _view) return;
    if (payload.clientId) {
      const optIdx = _messages.findIndex((m) => m._optimistic && m.clientId === payload.clientId);
      if (optIdx !== -1) {
        _messages[optIdx] = { ...payload, _optimistic: false };
        _since = payload.createdAt;
        renderMessages();
        try { API.post('/api/chat/read', { scope: _view }); } catch (_) {}
        return;
      }
    }
    const exists = _messages.some((m) =>
      (m.id && m.id === payload.id) ||
      (payload.clientId && m.clientId && m.clientId === payload.clientId) ||
      (m.createdAt === payload.createdAt && m.text === payload.text && !m._optimistic)
    );
    if (!exists) {
      _messages.push(payload);
      _since = payload.createdAt;
      renderMessages();
    }
    try { API.post('/api/chat/read', { scope: _view }); } catch (_) {}
  }

  // ── Init ──
  function init() {
    _el('chat-send-form').addEventListener('submit', sendMessage);
    const ta = _el('chat-send-text');
    ta.addEventListener('input', _updateCharCount);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });
    _el('chat-tab-community').addEventListener('click', () => setView('community'));
    _el('chat-tab-dm').addEventListener('click', () => setView('dm'));
    _el('chat-display-name-save').addEventListener('click', saveDisplayName);
    const fileInp = _el('chat-file-input');
    if (fileInp) fileInp.addEventListener('change', _onFileSelected);
    const fileBtn = _el('chat-file-btn');
    if (fileBtn && fileInp) {
      fileBtn.addEventListener('click', () => fileInp.click());
    }
    window.addEventListener('chat:message', (e) => onLiveMessage(e.detail));
    loadDisplayName();
    _loadMyIdentity();
    _loadQuota();
    loadHistory({ reset: true });
    startPolling();
    if (typeof WSClient !== 'undefined' && WSClient.start) WSClient.start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();