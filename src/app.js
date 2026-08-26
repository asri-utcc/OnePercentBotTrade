'use strict';

const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const cookieParser = require('cookie-parser'); // 2026-08-09: Telegram Login — read tg_login_token cookie
const path = require('path');

const config = require('../config');
const logger = require('./utils/logger');
const { ErrorRateLimiter } = require('./utils/errorRateLimiter');

// Rate-limit noisy ECONNREFUSED errors (e.g. during MongoDB outage) so
// we don't fill the log with one line per failed request.
const errorRateLimiter = new ErrorRateLimiter({ windowMs: 60_000, maxPerWindow: 5 });

const authRoutes = require('./api/routes/auth.routes');
const licenseRoutes = require('./api/routes/license.routes'); // FIX-2026-08-26 Phase 3a: /api/license/* for Settings page UI
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
// 2026-08-19: Wallet — holdings + USDT reserve
const walletRoutes = require('./api/routes/wallet.routes');
// FIX-2026-07-24: Telegram + History (ใหม่)
const telegramRoutes = require('./api/routes/telegram.routes');
const historyRoutes = require('./api/routes/history.routes');
// FIX-2026-07-29: PnL Calendar + PnL Chart (ใหม่)
const pnlRoutes = require('./api/routes/pnl.routes');
// 2026-08-06: Daily Profit Target gauge (radial gauge below navbar)
const dailyTargetRoutes = require('./api/routes/dailyTarget.routes');
// 2026-08-23: Live Binance API weight gauge (navbar pill)
const rateLimitRoutes = require('./api/routes/rateLimit.routes');
// FIX-2026-08-26 Phase 2c-v2: Consent routes on the bot's main port —
//   public (no requireAuth) so first-run users can decide before logging in.
const consentRoutes = require('./api/routes/consent.routes');

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

  // 2026-08-09: Cookie parser (ต้องมาก่อน session — ใช้ใน /api/auth/login-telegram/* เพื่ออ่าน tg_login_token)
  app.use(cookieParser());

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

  // 2026-08-09: Password & Sessions Manager — update lastSeenAt ทุก authenticated request
  //   - ใช้สำหรับแสดง "last active 5 min ago" ในหน้า Sessions Manager
  //   - skip /api/auth/login + /api/auth/status (ยังไม่ authenticate)
  //   - throttle: เขียน session ทุก 60s ต่อ session (กัน Mongo write storm)
  app.use((req, res, next) => {
    if (!req.session || !req.session.authenticated) return next();
    if (req.path.startsWith('/api/auth/login') || req.path.startsWith('/api/auth/status')) return next();
    const now = Date.now();
    const last = req.session.lastSeenAt ? new Date(req.session.lastSeenAt).getTime() : 0;
    if (now - last >= 60 * 1000) {
      req.session.lastSeenAt = new Date().toISOString();
    }
    next();
  });

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
  app.use('/api/license', licenseRoutes); // FIX-2026-08-26 Phase 3a: license info + refresh for Settings UI
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
  app.use('/api/wallet', walletRoutes); // 2026-08-19: wallet holdings + USDT reserve
  // FIX-2026-07-24: register telegram + history
  app.use('/api/telegram', telegramRoutes);
  // FIX-2026-07-29: register pnl (calendar + series)
  app.use('/api/pnl', pnlRoutes);
  app.use('/api/history', historyRoutes);
  app.use('/api/daily-target', dailyTargetRoutes); // 2026-08-06: Daily Profit Target gauge
  app.use('/api/system', rateLimitRoutes); // 2026-08-23: live Binance API weight gauge
  app.use('/api/coins', require('./api/routes/coin.routes')); // FIX-2026-08-01: coin info aggregator
// FIX-2026-08-21: Trade Analysis aggregator (includes soft-deleted bots)
app.use('/api/analysis', require('./api/routes/analysis.routes'));
// FIX-2026-08-26: Admin Snapshot — read-only aggregated bot state for OnePercentBot-Admin
app.use('/api/admin/snapshot', require('./api/routes/adminSnapshot.routes'));

// FIX-2026-08-26 Phase 2c-v2: Consent routes (public; first-run users can decide pre-login)
app.use('/api/consent', consentRoutes);

// FIX-2026-08-26: App version endpoint — public, used by navbar to show user what version is running
app.get('/api/app/version', (_req, res) => {
  res.json({ version: require('../package.json').version });
});

  // Health
  app.get('/health', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // FIX-2026-08-26 Phase 2c-v2: Top-level /consent (full-page) MUST be registered BEFORE
  //   the auth-gating static catch-all below — otherwise the user would be redirected
  //   to /login.html instead of seeing the consent form. Public on purpose: consent
  //   must be reachable pre-login so the first-run overlay on /login.html works.
  app.get('/consent', consentRoutes.page);

  // ─── Static files (HTML auth-gated) ──────────────────────────────
  // 2026-08-10: ล็อค HTML/JS ทุกหน้ายกเว้น login + favicon + CSS + /js/api.js
  //   - ป้องกัน AI/AI-coding-tool scrape HTML/JS labels + feature names + modal flow
  //   - session lookup จาก MongoDB เกิดขึ้นอยู่แล้ว (express-session global) → overhead ≈ 0
  //   - ไฟล์ HTML ที่ต้อง auth → Cache-Control: no-store (กัน back-button cache leak หลัง logout)
  //   - Public (whitelist): /login.html, /favicon.svg, /css/*, /js/api.js, /js/botConfigIO.js
  //   - ทุก path อื่น → ต้อง session.authenticated === true ถึงจะเห็นเนื้อหา
  const PUBLIC_EXACT = new Set(['/login.html', '/favicon.svg', '/consent']); // FIX-2026-08-26 Phase 2c-v2: /consent reachable pre-login (top-level handler also registers it, belt-and-braces)
  const PUBLIC_PREFIXES = ['/css/', '/js/api.js', '/js/botConfigIO.js'];

  function isPublicStaticPath(p) {
    if (PUBLIC_EXACT.has(p)) return true;
    return PUBLIC_PREFIXES.some((prefix) => p.startsWith(prefix));
  }

  const serveStatic = express.static(config.paths.public, {
    index: 'index.html',
    setHeaders: (res, filePath) => {
      // HTML ที่ต้อง auth → ห้าม cache (กัน back-button cache leak หลัง logout)
      // Public HTML (login.html) → browser cache ได้ตามปกติ (Etag + 304)
      if (filePath.endsWith('.html') && !filePath.endsWith('login.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
      }
    },
  });

  app.get(/^\/(?!api\/|health).*/, (req, res, next) => {
    // 1. Public static → serve ทันที ไม่ต้อง auth (login.html, favicon, CSS, core JS)
    if (isPublicStaticPath(req.path)) {
      return serveStatic(req, res, next);
    }

    // 2. Auth required
    if (!req.session || req.session.authenticated !== true) {
      // Programmatic / non-browser → JSON 401
      if (!req.accepts('html')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      // Browser → redirect to login (เก็บ original URL ไว้ redirect กลับหลัง login)
      const redirectTo = encodeURIComponent(req.originalUrl || req.path);
      logger.debug({ path: req.path, ip: req.ip }, 'static: redirect to login (unauthenticated)');
      return res.redirect(`/login.html?next=${redirectTo}`);
    }

    // 3. Authenticated → serve static. ถ้าไฟล์ไม่มี → fallback to index.html (SPA)
    return serveStatic(req, res, (err) => {
      if (err && err.statusCode === 404) {
        return res.sendFile(path.join(config.paths.public, 'index.html'));
      }
      return next(err);
    });
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