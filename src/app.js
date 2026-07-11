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
const healthRoutes = require('./api/routes/health.routes');

function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Session
  app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 วัน
      sameSite: 'lax',
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
  app.use('/api/health', healthRoutes);

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