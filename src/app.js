'use strict';

const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');

const config = require('../config');
const logger = require('./utils/logger');
const { ErrorRateLimiter } = require('./utils/errorRateLimiter');

// Rate-limit noisy ECONNREFUSED errors (e.g. during MongoDB outage) so
// we don't fill the log with one line per failed request.
const errorRateLimiter = new ErrorRateLimiter({ windowMs: 60_000, maxPerWindow: 5 });

const authRoutes = require('./api/routes/auth.routes');
const botRoutes = require('./api/routes/bot.routes');
const tradeRoutes = require('./api/routes/trade.routes');
const signalRoutes = require('./api/routes/signal.routes');
const chartRoutes = require('./api/routes/chart.routes');
const backtestRoutes = require('./api/routes/backtest.routes');
const accountRoutes = require('./api/routes/account.routes');
const fxRoutes = require('./api/routes/fx.routes');
const healthRoutes = require('./api/routes/health.routes');
const scanRoutes = require('./api/routes/scan.routes');
const bnbAutoBuyRoutes = require('./api/routes/bnbAutoBuy.routes'); // FIX-2026-08-05: auto-buy BNB
const autoAddBotRoutes = require('./api/routes/autoAddBot.routes'); // FIX-2026-08-07: auto add new bot
const adminRoutes = require('./api/routes/admin.routes'); // FIX-2026-08-08: master config + admin endpoints
// FIX-2026-07-24: Telegram + History (ใหม่)
const telegramRoutes = require('./api/routes/telegram.routes');
const historyRoutes = require('./api/routes/history.routes');
// FIX-2026-07-29: PnL Calendar + PnL Chart (ใหม่)
const pnlRoutes = require('./api/routes/pnl.routes');
// 2026-08-06: Daily Profit Target gauge (radial gauge below navbar)
const dailyTargetRoutes = require('./api/routes/dailyTarget.routes');

function createApp() {
  const app = express();

  app.set('trust proxy', 1);

  // ─── Security headers (lightweight — ไม่ใช้ helmet เพื่อลด dependencies) ─
  app.use((req, res, next) => {
    // ป้องกัน MIME sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // ป้องกัน clickjacking
    res.setHeader('X-Frame-Options', 'DENY');
    // ปิด XSS filter ของ browser (แนะนำโดย OWASP — เพราะ buggy)
    res.setHeader('X-XSS-Protection', '0');
    // บอก browser ว่าเราไม่ควรถูก embed ที่อื่น (กัน referer leak)
    res.setHeader('Referrer-Policy', 'no-referrer');
    // ถ้าใช้ HTTPS (ผ่าน reverse proxy) — บอก browser ให้ upgrade
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    // API responses ไม่ควร cache
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
    // Static JS/CSS — บังคับให้ browser revalidate ทุกครั้ง (กัน cache ของโค้ดใหม่
    // ที่ user แก้แล้ว แต่ browser ยังโหลดไฟล์เก่า) — Express.static จะตั้ง ETag อยู่แล้ว
    // ส่ง 304 ถ้าไฟล์ไม่เปลี่ยน เลยไม่เปลือง bandwidth
    if (/\.(js|css|html)$/.test(req.path) || req.path === '/') {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Session
  app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 วัน
      sameSite: 'lax',
      // secure: true ถ้าใช้ HTTPS (ต้อง trust proxy ก่อน)
      secure: false, // เปลี่ยนเป็น 'auto' ถ้ามี HTTPS reverse proxy
    },
    store: MongoStore.create({
      mongoUrl: config.mongoUri,
      collectionName: 'sessions',
      ttl: 7 * 24 * 60 * 60,
    }),
  }));

  // Request log
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      logger.debug({ method: req.method, url: req.url, status: res.statusCode, ms }, 'http');
    });
    next();
  });

  // API
  app.use('/api/auth', authRoutes);
  app.use('/api/bots', botRoutes);
  app.use('/api/trades', tradeRoutes);
  app.use('/api/signals', signalRoutes);
  app.use('/api/chart', chartRoutes);
  app.use('/api/backtest', backtestRoutes);
  app.use('/api/account', accountRoutes);
  app.use('/api/fx', fxRoutes);
  app.use('/api/health', healthRoutes);
  app.use('/api/scan', scanRoutes);
  app.use('/api/bnb-auto-buy', bnbAutoBuyRoutes); // FIX-2026-08-05
  app.use('/api/auto-add-bot', autoAddBotRoutes); // FIX-2026-08-07
  app.use('/api/admin', adminRoutes); // FIX-2026-08-08: master config + force-run autoDeleteBot
  // FIX-2026-07-24: register telegram + history
  app.use('/api/telegram', telegramRoutes);
  // FIX-2026-07-29: register pnl (calendar + series)
  app.use('/api/pnl', pnlRoutes);
  app.use('/api/history', historyRoutes);
  app.use('/api/daily-target', dailyTargetRoutes); // 2026-08-06: Daily Profit Target gauge
  app.use('/api/coins', require('./api/routes/coin.routes')); // FIX-2026-08-01: coin info aggregator

  // Health
  app.get('/health', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // Static files (dashboard)
  app.use(express.static(config.paths.public));

  // SPA fallback: ส่ง index.html สำหรับ routes ที่ไม่ใช่ API
  app.get(/^\/(?!api\/|health).*/, (req, res) => {
    res.sendFile(path.join(config.paths.public, 'index.html'));
  });

  // Error handler
  app.use((err, req, res, next) => {
    // Rate-limit noisy ECONNREFUSED so we don't spam logs during DB outages.
    // Still surface 503 to the client so dashboard can show a clear error.
    if (err && err.message && err.message.includes('ECONNREFUSED')) {
      const shouldLog = errorRateLimiter.shouldLog('ECONNREFUSED');
      if (shouldLog) {
        logger.error(
          { err: err.message, suppressed: errorRateLimiter.count('ECONNREFUSED') > 1, stack: err.stack },
          'request error (mongo unreachable)'
        );
      }
      return res.status(503).json({ error: 'Database temporarily unavailable, retrying…' });
    }
    logger.error({ err: err.message, stack: err.stack }, 'request error');
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  });

  return app;
}

module.exports = { createApp };