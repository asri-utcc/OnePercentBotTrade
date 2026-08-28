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
      setTimeout(() => this._connect(), this.reconnectDelay);
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