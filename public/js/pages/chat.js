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
      return `
        <div class="${cls}">
          <div class="chat-msg-meta">
            <strong>${_escape(who)}</strong>
            <span>${_escape(_formatTime(m.createdAt))}</span>
          </div>
          <div class="chat-msg-text">${_escape(m.text)}</div>
        </div>
      `;
    }).join('');
    wrap.scrollTop = wrap.scrollHeight;
  }

  // ── Polling ──
  async function loadHistory({ reset = false } = {}) {
    try {
      const params = new URLSearchParams({ scope: _view });
      if (!reset && _since) params.set('since', _since);
      const r = await API.get('/api/chat/history?' + params.toString());
      const incoming = r.messages || [];
      if (reset) {
        _messages = incoming.slice().reverse(); // newest-first from API
      } else {
        _messages = _messages.concat(incoming);
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
      await API.post('/api/chat/send', { scope: _view, text });
      ta.value = '';
      _updateCharCount();
      // Optimistic local append — also wait for the next poll to reconcile
      _messages.push({
        scope: _view,
        fromAdmin: false,
        fromMachineId: 'local',
        displayName: _el('chat-display-name-input').value || 'me',
        text,
        createdAt: new Date().toISOString(),
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
    // Append if matching view
    if (payload.scope === _view) {
      // De-dup by id + createdAt
      const exists = _messages.some((m) => (m.id && m.id === payload.id) || (m.createdAt === payload.createdAt && m.text === payload.text));
      if (!exists) {
        _messages.push(payload);
        _since = payload.createdAt;
        renderMessages();
      }
      try { API.post('/api/chat/read', { scope: _view }); } catch (_) {}
    }
  }

  // ── Init ──
  function init() {
    _el('chat-send-form').addEventListener('submit', sendMessage);
    _el('chat-send-text').addEventListener('input', _updateCharCount);
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