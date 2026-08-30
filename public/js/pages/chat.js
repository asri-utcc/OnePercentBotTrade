'use strict';

/**
 * Phase 4-2026-08-29 — Operator chat page (/chat.html)
 *
 * Two tabs: Community (everyone) | DM Admin (single thread).
 * Polls /api/chat/history every 5s; listens on /ws/dashboard for 'chat:message'
 * (forwarded to window CustomEvent by ws-client.js).
 */

(function () {
  const POLL_MS = 5000;
  let _view = 'community';
  let _messages = [];
  let _since = null;
  let _pollHandle = null;
  let _historyCursor = null; // ISO of latest seen msg in our buffer

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
  // Phase 4-2026-08-30: identity tag for impersonation prevention.
  //   - admin-sourced: 🛡 admin (the admin username is stable & JWT-bound)
  //   - operator-sourced: 🏷 <machineId.slice(0,8)> (unique per bot install)
  //   - own (mine): same operator tag — confirms which bot you are
  function _ownerTag(m, mine) {
    if (mine) return { icon: '🏷', label: 'you' };
    if (m.fromAdmin) return { icon: '🛡', label: m.fromAdmin };
    if (m.fromMachineId) return { icon: '🏷', label: m.fromMachineId.slice(0, 8) };
    return { icon: '?', label: 'unknown' };
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

  // ── Rendering ──
  function renderMessages() {
    const wrap = _el('chat-messages');
    if (!wrap) return;
    if (_messages.length === 0) {
      wrap.innerHTML = '<p class="chat-empty">ยังไม่มีข้อความ — เป็นคนแรกที่ทักทาย!</p>';
      return;
    }
    // Render newest-first array in chronological (oldest-first) order for chat
    const sorted = _messages.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    wrap.innerHTML = sorted.map((m) => {
      const mine = !!m.fromMachineId && !m.fromAdmin;
      const cls = mine ? 'chat-msg mine' : 'chat-msg';
      const who = m.displayName || (mine ? 'me' : 'admin');
      const owner = _ownerTag(m, mine);
      const ownerTitle = m.fromMachineId || m.fromAdmin || '';
      return `
        <div class="${cls}">
          <div class="chat-msg-meta">
            <strong>${_escape(who)}</strong>
            <span class="chat-msg-owner" title="${_escape(ownerTitle)}">${owner.icon} ${_escape(owner.label)}</span>
            <span>${_escape(_formatTime(m.createdAt))}</span>
          </div>
          <div class="chat-msg-text">${_escape(m.text)}</div>
        </div>
      `;
    }).join('');
    wrap.scrollTop = wrap.scrollHeight;
  }

  // ── Polling ──
  // Phase 4-FIX-2026-08-30: defensive dedupe — even with server-side dedupe,
  // legacy browser state may contain messages from before the fix. On every
  // load, drop incoming entries that already exist (by id or clientId) or
  // that match an existing non-optimistic entry by (createdAt + text).
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
      // Fallback: same text+createdAt from a prior non-optimistic entry
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
        // Phase 4-FIX-2026-08-30: dedupe incoming itself in case the server
        // returned duplicates (legacy state from before this fix).
        _messages = _mergeMessages([], incoming).reverse();
      } else {
        _messages = _mergeMessages(_messages, incoming);
      }
      if (incoming.length > 0) {
        _since = incoming[incoming.length - 1].createdAt;
      }
      // mark read on view
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
  async function sendMessage(e) {
    if (e) e.preventDefault();
    const ta = _el('chat-send-text');
    const text = (ta.value || '').trim();
    if (!text) return;
    const btn = _el('chat-send-btn');
    btn.disabled = true;
    try {
      const r = await API.post('/api/chat/send', { scope: _view, text });
      ta.value = '';
      _updateCharCount();
      const tempClientId = r && r.id ? r.id : null;
      // Optimistic local append — Phase 4-FIX-2026-08-30: tag with clientId so
      // onLiveMessage can replace this placeholder when the inbox echo arrives
      // (avoids the "send 1 → see 2" duplicate).
      _messages.push({
        scope: _view,
        fromAdmin: false,
        fromMachineId: 'local',
        displayName: _el('chat-display-name-input').value || 'me',
        text,
        createdAt: new Date().toISOString(),
        clientId: tempClientId,
        _optimistic: true,
      });
      _since = _messages[_messages.length - 1].createdAt;
      renderMessages();
      _setStatus('');
    } catch (err) {
      _setStatus(err.message || 'Send failed', 'error');
    } finally {
      btn.disabled = false;
    }
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
    // Phase 4-FIX-2026-08-30: replace optimistic placeholder if clientId matches.
    //   Otherwise (admin→bot or unrelated), de-dup by id or by (createdAt + text).
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
    // Phase 4-2026-08-30: Enter sends, Shift+Enter inserts newline (textarea).
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });
    _el('chat-tab-community').addEventListener('click', () => setView('community'));
    _el('chat-tab-dm').addEventListener('click', () => setView('dm'));
    _el('chat-display-name-save').addEventListener('click', saveDisplayName);
    window.addEventListener('chat:message', (e) => onLiveMessage(e.detail));
    loadDisplayName();
    loadHistory({ reset: true });
    startPolling();
    // Start WS so 'chat:message' events arrive live (via chatInbox poll + command)
    if (typeof WSClient !== 'undefined' && WSClient.start) WSClient.start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();