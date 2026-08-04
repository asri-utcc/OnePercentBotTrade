'use strict';

const http = require('http');
const config = require('../config');
const logger = require('./utils/logger');
const db = require('./db/connection');
const { createApp } = require('./app');
const dashboardWs = require('./realtime/dashboardWs');
const botManager = require('./core/botManager');
const healthMonitor = require('./services/healthMonitor');
const positionWatchdog = require('./services/positionWatchdog');

async function main() {
  logger.info({ env: config.env, port: config.port }, 'starting OnePercentBotTrade');

  // 1. Create app
  const app = createApp();
  const server = http.createServer(app);

  // 2. Attach dashboard WS (must happen before listen so upgrade handler is registered)
  dashboardWs.attach(server);

  // 3. Start listening immediately (so port 6015 is reachable even if MongoDB is down)
  //    HOST=127.0.0.1 (default, ปลอดภัย) หรือ HOST=0.0.0.0 (forward port ได้)
  server.listen(config.port, config.host, () => {
    const displayHost = config.host === '0.0.0.0' ? '0.0.0.0 (all interfaces)' : config.host;
    logger.info(`🚀 listening on http://${displayHost}:${config.port}`);
    logger.info(`📊 Dashboard: http://localhost:${config.port}/`);
    if (config.host === '0.0.0.0') {
      logger.warn('⚠️  Bound to 0.0.0.0 — server reachable from any network interface. Ensure firewall + login guard is configured.');
    }
  });

  // 4. Connect MongoDB in background (retry forever, doesn't block listen)
  db.connect().then(async () => {
    // 5. Start bot manager (after DB ready)
    try {
      await botManager.start();
    } catch (err) {
      logger.error({ err: err.message }, 'botManager start failed');
    }
  }).catch((err) => {
    logger.error({ err: err.message }, 'mongoDB connect ultimately failed');
  });

  // 6. Start health monitor immediately (so /api/health responds right away)
  healthMonitor.start();

  // FIX-2026-08-03: Position Watchdog — F1 + SL-UKC for disabled bots (auto-paused etc.)
  //   Runs independently of botManager/Trader so paused bots still get armed + force-closed
  positionWatchdog.start();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try { healthMonitor.stop(); } catch (e) { /* ignore */ }
    try { positionWatchdog.stop(); } catch (e) { /* ignore */ }
    try { await botManager.flushActiveTimeOnShutdown(); } catch (e) { /* ignore */ }
    try { await botManager.stop(); } catch (e) { /* ignore */ }
    server.close(() => {
      db.disconnect().finally(() => {
        process.exit(0);
      });
    });
    setTimeout(() => {
      logger.warn('force exit after 10s');
      process.exit(1);
    }, 10000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.error({ err: err.message, stack: err.stack }, 'uncaughtException');
  });
  process.on('unhandledRejection', (err) => {
    logger.error({ err: err && err.message ? err.message : err }, 'unhandledRejection');
  });
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal error during startup');
  process.exit(1);
});