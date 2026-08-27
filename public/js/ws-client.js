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
   * FIX-2026-08-27 Bug A: show admin:message as a top-right toast.
   * Auto-dismiss after 6s (errors stay 10s). Click to dismiss early.
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
 * Renders a top-right sliding toast. Multiple toasts stack vertically.
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
    const container = this.ensureContainer();
    const toast = document.createElement('div');
    const bg = level === 'error' ? '#dc2626'
      : level === 'warn' ? '#f59e0b'
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
    const prefix = level === 'error' ? '⛔ '
      : level === 'warn' ? '⚠️ '
      : '📨 ';
    toast.textContent = prefix + text;
    toast.title = 'Click to dismiss';
    toast.addEventListener('click', () => this._dismiss(toast));
    container.appendChild(toast);
    const ttl = (level === 'error' ? 10000 : 6000);
    setTimeout(() => this._dismiss(toast), ttl);
  },

  _dismiss(toast) {
    if (!toast || !toast.parentNode) return;
    toast.style.transition = 'opacity .2s, transform .2s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => toast.remove(), 220);
  },
};

window.WSClient = WSClient;
window.AdminToast = AdminToast;