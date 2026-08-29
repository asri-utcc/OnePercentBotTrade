'use strict';

const WebSocket = require('ws');
const url = require('url');
const eventBus = require('../services/eventBus');
const logger = require('../utils/logger');

const EVENTS_TO_FORWARD = [
  'bot:status',
  'bot:updated',
  'signal:new',
  'trade:update',
  'order:update',
  'kline:update',
  'account:update',
  'health:update',
  'rateLimit:update', // FIX-2026-08-23: live Binance API weight pill on navbar
  'autoReserve:adjusted', // FIX-2026-08-24: auto reserve/release USDT event → refresh wallet UI
  // FIX-2026-08-27 Bug A: show_message cmd → toast on dashboard
  //   Emitted by commandExecutor.show_message → all connected WS clients show toast.
  'admin:message',
  // Phase 4-2026-08-29: chat message arrives via admin command OR via chatInbox poll.
  //   Emitted from commandExecutor.chat_message() and admin-monitor/chatInbox.js.
  //   Browser ws-client.js forwards to AdminToast + window CustomEvent for chatWidget.js.
  'chat:message',
];

/**
 * Dashboard WebSocket — push events จาก eventBus ไปยัง dashboard clients
 * Authentication: ตรวจ session cookie ผ่าน express-session ที่ share กัน (parse signed cookie)
 * สำหรับ v1 ง่ายๆ: ตรวจ sid cookie แล้วเทียบใน store
 */
class DashboardWs {
  constructor() {
    this.wss = null;
    this.clients = new Set();
  }

  attach(server) {
    const wss = new WebSocket.Server({ noServer: true });
    this.wss = wss;

    server.on('upgrade', (req, socket, head) => {
      const { pathname } = url.parse(req.url);
      if (pathname !== '/ws/dashboard') {
        return; // ไม่ใช่ของเรา ปล่อย
      }

      // auth: ตรวจ session
      this._isAuthenticated(req)
        .then((ok) => {
          if (!ok) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
          });
        })
        .catch((err) => {
          logger.warn({ err: err.message }, 'ws auth error');
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        });
    });

    wss.on('connection', (ws) => {
      logger.info('dashboard WS client connected');
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));

      ws.on('message', (raw) => {
        // client → server: รับเฉพาะ ping
        try {
          const msg = JSON.parse(raw.toString('utf8'));
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          }
        } catch (e) { /* ignore */ }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info('dashboard WS client disconnected');
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });

    // forward events
    for (const evt of EVENTS_TO_FORWARD) {
      eventBus.on(evt, (payload) => {
        const msg = JSON.stringify({ type: evt, payload, ts: Date.now() });
        for (const client of this.clients) {
          if (client.readyState === WebSocket.OPEN) {
            try { client.send(msg); } catch (e) { /* ignore */ }
          }
        }
      });
    }

    logger.info('dashboard WebSocket attached at /ws/dashboard');
  }

  async _isAuthenticated(req) {
    // Parse cookie
    const cookieHeader = req.headers.cookie || '';
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map((c) => {
        const [k, ...v] = c.trim().split('=');
        return [k, decodeURIComponent(v.join('='))];
      })
    );

    const sid = cookies['connect.sid'];
    if (!sid) return false;

    // ตรวจ session โดยตรงใน MongoStore
    const session = await new Promise((resolve) => {
      // ใช้ connect-mongo โดยตรง
      const MongoStore = require('connect-mongo');
      const config = require('../../config');
      const store = MongoStore.create({
        mongoUrl: config.mongoUri,
        collectionName: 'sessions',
      });
      // sid จะมี prefix "s:" ตามด้วย signed value
      const id = sid.startsWith('s:') ? sid.slice(2).split('.')[0] : sid;
      store.get(id, (err, sess) => {
        if (err) resolve(null);
        else resolve(sess);
      });
    });

    return session && session.authenticated === true;
  }
}

module.exports = new DashboardWs();