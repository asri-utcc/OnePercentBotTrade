'use strict';

const WSClient = {
  ws: null,
  listeners: new Map(),
  reconnectDelay: 1000,

  start() {
    if (this.ws) return;
    this._connect();
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
};

window.WSClient = WSClient;