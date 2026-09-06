'use strict';

const WSClient = {
  ws: null,
  listeners: new Map(),
  reconnectDelay: 1000,

  start() {
    if (this.ws) return;
    this._connect();
    // FIX-2026-08-27 Bug A: register default admin:message toast listener
    //   (any page that includes ws-client gets the toast for free).
    this._installAdminToast();
    // Phase 4-2026-08-29: chat:message → window CustomEvent for chatWidget / chat page
    this._installChatEventForwarder();
  },

  _connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/dashboard`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this._setStatus('🟢 live');
      console.log('WS connected');
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        const handlers = this.listeners.get(msg.type) || [];
        for (const h of handlers) h(msg.payload, msg);
      } catch (err) {
        console.error('WS message parse error', err);
      }
    };

    this.ws.onclose = () => {
      this._setStatus('🔴 offline (reconnecting)');
      // FIX-2026-09-01 audit H12: add ±25% jitter to the reconnect delay so
      //   multiple tabs/browsers hitting the same backend outage don't all
      //   reconnect at exactly the same instant (thundering-herd). Cap stays
      //   at 30s; on the next successful connect we reset to the base delay.
      const base = this.reconnectDelay;
      const jittered = Math.round(base * (0.75 + Math.random() * 0.5));
      setTimeout(() => this._connect(), jittered);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    };

    this.ws.onerror = () => {
      this.ws.close();
    };
  },

  _setStatus(text) {
    const el = document.getElementById('ws-status');
    if (el) el.textContent = text;
  },

  on(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  },

  /**
   * FIX-2026-08-27 Bug A: show admin:message as a top-right toast (info level).
   * FIX-2026-08-28 UX: warn/error levels now go to a modal alert that requires
   *   explicit OK acknowledgement — small fast toasts were being missed.
   * Safe to call multiple times — listeners accumulate; only one is installed.
   */
  _installAdminToast() {
    if (this._adminToastInstalled) return;
    this._adminToastInstalled = true;
    this.on('admin:message', (payload) => {
      try {
        const text = String(payload?.message || '');
        if (!text) return;
        const level = payload?.level || 'info';
        AdminToast.show(text, level);
      } catch (err) {
        console.error('admin:message handler failed', err);
      }
    });
  },

  /**
   * Phase 4-2026-08-29: chat:message → window CustomEvent
   *   - Emitted by admin-monitor/chatInbox (poll) and commandExecutor.chat_message
   *   - Forwards to chatWidget (toast + sound + title flash) and chat page (append)
   *   - Always shows a toast for incoming DM (info level — non-intrusive)
   */
  _installChatEventForwarder() {
    if (this._chatForwarderInstalled) return;
    this._chatForwarderInstalled = true;
    this.on('chat:message', (payload) => {
      try {
        if (!payload) return;
        // Emit as CustomEvent so any page can subscribe via addEventListener('chat:message')
        window.dispatchEvent(new CustomEvent('chat:message', { detail: payload }));
        // Show toast for incoming DM only (community is in chat page)
        if (payload.scope === 'dm' && payload.fromAdmin) {
          const who = payload.displayName || 'admin';
          AdminToast.show(`💬 ${who}: ${String(payload.text || '').slice(0, 120)}`, 'info');
        }
      } catch (err) {
        console.error('chat:message forwarder failed', err);
      }
    });
  },
};

/**
 * FIX-2026-08-27 Bug A: minimal toast utility used by ws-client admin:message handler.
 * FIX-2026-08-28 UX: warn/error levels now render as a modal alert that requires
 *   explicit OK acknowledgement (Enter or click). info keeps the sliding toast,
 *   auto-dismiss after 6s, click-to-dismiss early.
 */
const AdminToast = {
  ensureContainer() {
    let el = document.getElementById('admin-toast-container');
    if (!el) {
      el = document.createElement('div');
      el.id = 'admin-toast-container';
      el.style.cssText = [
        'position:fixed',
        'top:20px',
        'right:20px',
        'z-index:99999',
        'display:flex',
        'flex-direction:column',
        'gap:10px',
        'max-width:380px',
        'pointer-events:none',
      ].join(';');
      document.body.appendChild(el);
    }
    return el;
  },

  show(text, level = 'info') {
    // Warn + error → modal alert that requires explicit OK acknowledgement.
    // Rationale: critical admin notices (anti-tamper, license issues, license expiry)
    // were being missed because the toast auto-dismissed in 6s.
    if (level === 'warn' || level === 'error') {
      AdminModalAlert.show({
        title: level === 'error' ? '⛔ Error from Server' : '⚠️ Warning from Server',
        message: text,
        level,
      });
      return;
    }
    const container = this.ensureContainer();
    const toast = document.createElement('div');
    const bg = level === 'success' ? '#16a34a'
      : level === 'info' ? '#2563eb'
      : '#2563eb';
    toast.style.cssText = [
      'background:' + bg,
      'color:#fff',
      'padding:12px 16px',
      'border-radius:8px',
      'box-shadow:0 6px 20px rgba(0,0,0,0.25)',
      'font-size:14px',
      'line-height:1.45',
      'cursor:pointer',
      'pointer-events:auto',
      'animation:adminToastIn .25s ease-out',
    ].join(';');
    const prefix = level === 'success' ? '✅ '
      : level === 'info' ? '📨 '
      : '📨 ';
    toast.textContent = prefix + text;
    toast.title = 'Click to dismiss';
    toast.addEventListener('click', () => this._dismiss(toast));
    container.appendChild(toast);
    setTimeout(() => this._dismiss(toast), 6000);
  },

  _dismiss(toast) {
    if (!toast || !toast.parentNode) return;
    toast.style.transition = 'opacity .2s, transform .2s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => toast.remove(), 220);
  },
};

/**
 * FIX-2026-08-28 UX: modal alert used for warn/error admin:message payloads. Builds
 * a single backdrop+box into <body> with an OK button bound to Enter / click.
 * Surviving ESC dismisses too (treated as OK click). Used by AdminToast.show().
 */
const AdminModalAlert = {
  show({ title = 'Notice', message = '', level = 'warn' }) {
    const backdrop = document.createElement('div');
    backdrop.id = 'admin-modal-alert-backdrop';
    backdrop.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.75)',
      'z-index:100100', 'display:flex', 'align-items:center', 'justify-content:center',
    ].join(';');

    const box = document.createElement('div');
    const borderColor = level === 'error' ? '#ef4444' : '#f59e0b';
    box.style.cssText = [
      'background:#1a1f29', 'border:1px solid ' + borderColor,
      'border-radius:12px', 'width:440px', 'max-width:92vw',
      'padding:24px', 'box-shadow:0 16px 48px rgba(0,0,0,0.5)',
    ].join(';');

    const t = document.createElement('h4');
    t.style.cssText = 'margin:0 0 8px;font-size:16px;color:#e6e6e6;';
    t.textContent = title;

    const m = document.createElement('div');
    m.style.cssText = 'color:#cbd5e1;font-size:14px;line-height:1.5;margin:8px 0 16px;white-space:pre-wrap;word-break:break-word;';
    m.textContent = message;

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

    const ok = document.createElement('button');
    ok.textContent = 'OK';
    ok.style.cssText = [
      'background:' + (level === 'error' ? '#ef4444' : '#4a9eff'),
      'color:#fff', 'border:0', 'padding:8px 18px', 'border-radius:6px',
      'cursor:pointer', 'font-size:14px', 'font-weight:600',
    ].join(';');

    actions.appendChild(ok);
    box.appendChild(t); box.appendChild(m); box.appendChild(actions);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
    };
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); }
    };
    ok.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => ok.focus(), 50);
  },
};

window.WSClient = WSClient;
window.AdminToast = AdminToast;
window.AdminModalAlert = AdminModalAlert;

/**
 * FIX-2026-08-28 UX (extension): AdminModalAlert.confirm() and AdminModalAlert.prompt()
 * mirror native confirm()/prompt() but render styled modals (not browser-native dialogs).
 *
 * - confirm(): resolves true (OK) or false (Cancel/Esc/click-outside). The OK button
 *   color matches `level` (error/warn/info). Async — callers must `await`.
 * - prompt(): resolves the entered string (OK) or null (Cancel/Esc). Submit on Enter.
 *
 * These are the canonical replacements for `confirm()` / `prompt()` going forward.
 */
AdminModalAlert._buildBackdrop = function () {
  const backdrop = document.createElement('div');
  backdrop.style.cssText = [
    'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.75)',
    'z-index:100100', 'display:flex', 'align-items:center', 'justify-content:center',
  ].join(';');
  return backdrop;
};

AdminModalAlert._buildBox = function ({ title, message, level = 'warn', okLabel = 'OK', cancelLabel = null, withInput = false, defaultValue = '', inputPlaceholder = '', inputType = 'text' }) {
  const box = document.createElement('div');
  const borderColor = level === 'error' ? '#ef4444' : level === 'success' ? '#16a34a' : level === 'info' ? '#3b82f6' : '#f59e0b';
  box.style.cssText = [
    'background:#1a1f29', 'border:1px solid ' + borderColor,
    'border-radius:12px', 'width:480px', 'max-width:92vw',
    'padding:24px', 'box-shadow:0 16px 48px rgba(0,0,0,0.5)',
  ].join(';');

  const t = document.createElement('h4');
  t.style.cssText = 'margin:0 0 8px;font-size:16px;color:#e6e6e6;';
  t.textContent = title;
  box.appendChild(t);

  const m = document.createElement('div');
  m.style.cssText = 'color:#cbd5e1;font-size:14px;line-height:1.5;margin:8px 0 16px;white-space:pre-wrap;word-break:break-word;';
  m.textContent = message;
  box.appendChild(m);

  let inputEl = null;
  if (withInput) {
    inputEl = document.createElement('input');
    inputEl.type = inputType;
    inputEl.placeholder = inputPlaceholder;
    inputEl.value = defaultValue;
    inputEl.style.cssText = 'width:100%;padding:10px 12px;border:1px solid #2d3748;border-radius:6px;background:#0f1218;color:#e6e6e6;font-size:14px;margin-bottom:16px;box-sizing:border-box;';
    box.appendChild(inputEl);
  }

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

  let cancelBtn = null;
  if (cancelLabel) {
    cancelBtn = document.createElement('button');
    cancelBtn.textContent = cancelLabel;
    cancelBtn.style.cssText = 'background:#374151;color:#fff;border:0;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;';
    actions.appendChild(cancelBtn);
  }

  const ok = document.createElement('button');
  ok.textContent = okLabel;
  const okBg = level === 'error' ? '#ef4444' : level === 'success' ? '#16a34a' : level === 'info' ? '#3b82f6' : '#4a9eff';
  ok.style.cssText = 'background:' + okBg + ';color:#fff;border:0;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;';
  actions.appendChild(ok);
  box.appendChild(actions);
  return { box, okBtn: ok, cancelBtn, inputEl };
};

AdminModalAlert.confirm = function ({ title = 'Confirm', message = '', level = 'warn', okLabel = 'Confirm', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const backdrop = this._buildBackdrop();
    const { box, okBtn, cancelBtn } = this._buildBox({ title, message, level, okLabel, cancelLabel });
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    let closed = false;
    const cleanup = (v) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      else if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
    };
    okBtn.addEventListener('click', () => cleanup(true));
    if (cancelBtn) cancelBtn.addEventListener('click', () => cleanup(false));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(false); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => okBtn.focus(), 50);
  });
};

AdminModalAlert.prompt = function ({ title = 'Input', message = '', level = 'info', okLabel = 'OK', cancelLabel = 'Cancel', defaultValue = '', placeholder = '', inputType = 'text' } = {}) {
  return new Promise((resolve) => {
    const backdrop = this._buildBackdrop();
    const { box, okBtn, cancelBtn, inputEl } = this._buildBox({ title, message, level, okLabel, cancelLabel, withInput: true, defaultValue, inputPlaceholder: placeholder, inputType });
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    let closed = false;
    const cleanup = (v) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(v);
    };
    // FIX-2026-09-06 (defensive): always read inputEl.value AT the time of
      // submit, not from a captured reference. User repro showed
      // nameRaw= {} typeof=object on this environment even though the OK
      // button correctly disabled when input was empty — strongly suggests
      // a browser/extension was rewriting inputEl.value to a non-string.
      // Reading live + coercing to string guarantees we always get usable text.
      const readValue = () => {
        try {
          const raw = inputEl ? inputEl.value : '';
          return typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
        } catch (_) { return ''; }
      };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
      else if (e.key === 'Enter' && document.activeElement === inputEl) {
        const v = readValue();
        if (!v.trim()) return;
        e.preventDefault();
        cleanup(v);
      }
    };
    // FIX-2026-09-06: disable OK button when input is empty/whitespace-only.
    // Prevents accidental empty POSTs (e.g. user thinks they typed but IME
    // hasn't committed, or placeholder was mistaken for typed text) and gives
    // a clear visual cue. Covers new-template + rename + duplicate + password.
    const syncOkState = () => {
      const empty = !readValue().trim();
      okBtn.disabled = empty;
      okBtn.style.opacity = empty ? '0.45' : '1';
      okBtn.style.cursor = empty ? 'not-allowed' : 'pointer';
    };
    inputEl.addEventListener('input', syncOkState);
    syncOkState();
    okBtn.addEventListener('click', () => {
      if (okBtn.disabled) return;
      cleanup(readValue());
    });
    if (cancelBtn) cancelBtn.addEventListener('click', () => cleanup(null));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(null); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => { inputEl.focus(); inputEl.select(); }, 50);
  });
};

/**
 * FIX-2026-08-29: AdminModalAlert.confirmHtml({ title, html, level, okLabel, cancelLabel })
 *   Like .confirm() but the `html` message is set via innerHTML (allowing checkboxes, badges,
 *   inline styling). Use sparingly — caller is responsible for sanitizing any user-derived
 *   content (file names from upload are passed through escapeHtml).
 *   Returns Promise<boolean>.
 */
AdminModalAlert.confirmHtml = function ({ title = 'Confirm', html = '', level = 'warn', okLabel = 'OK', cancelLabel = 'Cancel', wideBox = false } = {}) {
  return new Promise((resolve) => {
    const backdrop = this._buildBackdrop();
    const { box, okBtn, cancelBtn } = this._buildBox({ title, message: '', level, okLabel, cancelLabel });
    // Override width for rich modals
    if (wideBox) {
      box.style.width = '640px';
      box.style.maxWidth = '95vw';
    }
    // Replace the (currently empty) message div with our HTML
    const m = box.querySelector('div');
    if (m) {
      m.innerHTML = html;
      m.style.maxHeight = '60vh';
      m.style.overflowY = 'auto';
      m.style.textAlign = 'left';
    }
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    let closed = false;
    const cleanup = (v) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      else if (e.key === 'Enter') {
        // Don't auto-submit if focus is on a checkbox/select/input
        const tag = (document.activeElement && document.activeElement.tagName) || '';
        if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          cleanup(true);
        }
      }
    };
    okBtn.addEventListener('click', () => cleanup(true));
    if (cancelBtn) cancelBtn.addEventListener('click', () => cleanup(false));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(false); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => okBtn.focus(), 50);
  });
};

/**
 * FIX-2026-08-28 UX: AdminModalAlert.alert(text, level) — Promise<void> wrapper around show()
 * for sites previously using native alert(). Returns when the user dismisses.
 */
AdminModalAlert.alert = function (text, level = 'warn') {
  return new Promise((resolve) => {
    const orig = this.show.bind(this);
    // Patch close to resolve the promise: monkey-patch the OK button via DOM event listener.
    const title = level === 'error' ? '⛔ Error' : level === 'success' ? '✅ Success' : level === 'info' ? 'ℹ️ Info' : '⚠️ Notice';
    // Reuse the modal flow but watch for backdrop removal to resolve.
    const observer = new MutationObserver(() => {
      if (!document.getElementById('admin-modal-alert-backdrop')) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(document.body, { childList: true, subtree: false });
    orig({ title, message: String(text == null ? '' : text), level });
  });
};
