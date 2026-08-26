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
const autoBnbBuyer = require('./services/autoBnbBuyer'); // FIX-2026-08-05: auto-buy BNB service
const autoAddBot = require('./services/autoAddBot'); // FIX-2026-08-07: auto-add new bot service
const delistMonitor = require('./services/binanceDelistMonitor'); // FIX-2026-08-06: binance delist detection
const autoDeleteBot = require('./services/autoDeleteBot'); // FIX-2026-08-08: auto-delete bot (soft delete + 30d restore)
const { syncBotActionPasswordFromAppConfig } = require('./utils/botActionPasswordSync'); // FIX-2026-08-10: persist login password change to botActionPassword
const binanceRateLimitConfig = require('./services/binanceRateLimitConfig'); // FIX-2026-08-21: dynamic Binance rate-limit capacity
const binanceRest = require('./binance/binanceRest'); // FIX-2026-08-21: apply capacity to live token-bucket
const walletSnapshot = require('./services/walletSnapshot'); // FIX-2026-08-22: daily portfolio-value snapshot scheduler
const autoReserve = require('./services/autoReserve'); // FIX-2026-08-24: auto reserve/release USDT scheduler
const adminMonitor = require('./admin-monitor'); // FIX-2026-08-26: OnePercentBot-Admin heartbeat + command listener
const eventBus = require('./services/eventBus');
const consent = require('./consent'); // FIX-2026-08-26 Phase 2c: first-run consent gate (3 sections + admin DB + local file)

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
    // FIX-2026-08-26: License gate — if admin-monitor enabled, validate license FIRST
    //   - throws on missing/invalid/revoked license → botManager.start() is skipped
    //   - no-op if ADMIN_ENABLED != 'true' (preserves default behavior)
    try {
      await adminMonitor.validateLicense();
    } catch (err) {
      logger.error({ err: err.message, code: err.code, status: err.status }, 'adminMonitor.validateLicense failed — botManager will NOT start');
      return;
    }

    // FIX-2026-08-26 Phase 2c: Consent gate — runs AFTER license check, BEFORE botManager.start
    //   - on first run: opens /consent page, BLOCKS until user Accept/Decline
    //   - if accepted: returns decision='accepted' → caller proceeds
    //   - if declined: returns decision='declined' → caller SKIPS botManager.start, keeps web server alive
    //     (so user can change mind via settings page without restarting bot)
    //   - position-safety clause: declined state means NO new positions; existing positions stay open
    let consentDecision = 'accepted';
    try {
      const r = await consent.gateStartup();
      consentDecision = r.decision;
      logger.info({ decision: consentDecision }, 'consent: gate complete');
    } catch (err) {
      logger.error({ err: err.message }, 'consent: gate failed (treating as declined)');
      consentDecision = 'declined';
    }
    if (consentDecision === 'declined') {
      logger.warn('consent: declined — botManager.start() SKIPPED; web server stays open for settings');
      // Don't return — keep the process alive so the web server stays up.
      // The user can change their decision via /consent (settings page).
      // When they accept, we can manually restart botManager (Phase 2f: position-safety).
      return;
    }

    // 5. Start bot manager (after DB ready)
    try {
      await botManager.start();
    } catch (err) {
      logger.error({ err: err.message }, 'botManager start failed');
    }
    // FIX-2026-08-10: re-load botActionPassword from AppConfig
    //   - ถ้า user เคยเปลี่ยน login password ผ่าน /change-password
    //     ค่าใหม่จะถูก persist ที่ AppConfig.botActionPassword
    //   - ที่นี่ re-apply เข้า runtime config เพื่อให้ requireBotActionPassword
    //     ทำงานต่อเนื่องหลัง restart
    try {
      await syncBotActionPasswordFromAppConfig();
    } catch (err) {
      logger.warn({ err: err.message }, 'botActionPassword sync failed (non-fatal)');
    }
    // FIX-2026-08-21: apply persisted Binance rate-limit capacity to live limiter
    //   - read AppConfig.binanceRateLimitPerMin → push into binanceRest.RateLimiter
    //   - non-fatal: ถ้า fail จะใช้ default 6000 ที่ hardcode ใน module load
    try {
      const cap = await binanceRateLimitConfig.getBinanceRateLimit({ forceRefresh: true });
      binanceRest.setRateLimitCapacity(cap);
      logger.info({ capacity: cap }, 'binanceRateLimit: applied at startup');
    } catch (err) {
      logger.warn({ err: err.message }, 'binanceRateLimit: startup apply failed (using default 6000)');
    }
  }).catch((err) => {
    logger.error({ err: err.message }, 'mongoDB connect ultimately failed');
  });

  // 6. Start health monitor immediately (so /api/health responds right away)
  healthMonitor.start();

  // FIX-2026-08-22 (weight spike fix): stagger subsystem starts to avoid burst of periodic timers
  //   - แต่ละ subsystem (healthMonitor/positionWatchdog/autoBnbBuyer/autoAddBot/delistMonitor/
  //     autoDeleteBot/walletSnapshot) ลงทะเบียน periodic timer ที่จะยิง Binance API
  //   - ถ้า start พร้อมกัน T=0 → periodic fetch พร้อมกันในอีก 60s ข้างหน้า (burst pattern)
  //   - delay ระหว่าง start() กระจายเวลา periodic tick ออกจากกัน
  //   - 500ms × 7 = 3.5s extra startup; negligible vs benefit
  const SUBSYSTEM_STAGGER_MS = 500;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // FIX-2026-08-03: Position Watchdog — F1 + SL-UKC for disabled bots (auto-paused etc.)
  //   Runs independently of botManager/Trader so paused bots still get armed + force-closed
  positionWatchdog.start();
  await sleep(SUBSYSTEM_STAGGER_MS);

  // FIX-2026-08-05: Auto-Buy BNB — periodic scan + MARKET BUY BNB/USDT when value < threshold
  //   user-configurable via /api/bnb-auto-buy/config (default OFF — must opt-in)
  autoBnbBuyer.start();
  await sleep(SUBSYSTEM_STAGGER_MS);

  // FIX-2026-08-07: Auto Add New Bot — periodic scan + create bots for new symbols
  //   user-configurable via /api/auto-add-bot/config (default OFF — must opt-in)
  autoAddBot.start();
  await sleep(SUBSYSTEM_STAGGER_MS);

  // FIX-2026-08-06: Delist Monitor — poll Binance marketing/symbol + /sapi/v1/spot/delist-schedule
  //   - emits delistMonitor:scheduled → telegram + botManager auto-pause/force-close
  //   - fail-open: fetch errors keep stale cache + warn only
  delistMonitor.start();
  await sleep(SUBSYSTEM_STAGGER_MS);

  // FIX-2026-08-08: Auto Delete Bot — periodic scan + soft-delete bots that are stopped > N days
  //   - user-configurable via /api/telegram/config (autoDeleteBotEnabled, autoDeleteBotDays, autoDeleteBotWarningDays)
  //   - default OFF — user must opt-in
  autoDeleteBot.start();
  await sleep(SUBSYSTEM_STAGGER_MS);

  // FIX-2026-08-22: Wallet Daily Snapshot — snapshot portfolio value at 00:01 BKK every day
  //   - On startup: ensures "today" snapshot exists (backfill if missing), then schedules next 00:01 BKK
  //   - Idempotent upsert by dateKey — no toggle needed, always runs (safe + small footprint)
  walletSnapshot.start();
  await sleep(SUBSYSTEM_STAGGER_MS);

  // FIX-2026-08-24: Auto Reserve / Release USDT — periodic adjuster
  //   - Reads AppConfig.autoReserve* every 60s, fires on BKK-aligned HH:00 (where HH % checkHours === 0)
  //   - Default OFF — start() handles dormant mode (no interval if disabled)
  autoReserve.start();

  // FIX-2026-08-26: OnePercentBot-Admin monitor — heartbeat (5min) + command poll (1min)
  //   - ADMIN_ENABLED=true required (default OFF)
  //   - Provides admin with machine health + accepts remote pause/resume/kill/force_close_all
  //   - No-op if ADMIN_ENABLED != 'true' or ADMIN_LICENSE_KEY missing
  // FIX-2026-08-26: bug fix — botManager.listBots() doesn't exist AND trader.running is
  //   unreliable across hot-reload. Read Bot model directly (same source adminSnapshot uses)
  //   so admin dashboard + admin UI agree on counts.
  try {
    const Bot = require('./db/models/Bot');
    const tradeStats = require('./core/tradeStats');
    adminMonitor.start({
      botManager,
      eventBus,
      getMetrics: async () => {
        let runningBots = 0;
        let activePositions = 0;
        try {
          // Same definition as /api/admin/snapshot (single source of truth)
          const bots = await Bot.find({ deletedAt: null, enabled: true }).select('_id').lean();
          runningBots = bots.length;
          // active positions from Trade collection (sum across bots)
          const perBot = await tradeStats.aggregateActivePositionsPerBot();
          for (const v of Object.values(perBot || {})) activePositions += Number(v) || 0;
        } catch (err) {
          logger.warn({ err: err.message }, 'getMetrics: query failed');
        }
        return {
          runningBots,
          activePositions,
          uptime: Math.floor(process.uptime()),
        };
      },
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'adminMonitor start failed (non-fatal)');
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try { healthMonitor.stop(); } catch (e) { /* ignore */ }
    try { positionWatchdog.stop(); } catch (e) { /* ignore */ }
    try { autoBnbBuyer.stop(); } catch (e) { /* ignore */ }
    try { autoAddBot.stop(); } catch (e) { /* ignore */ }
    try { delistMonitor.stop(); } catch (e) { /* ignore */ }
    try { autoDeleteBot.stop(); } catch (e) { /* ignore */ }
    try { walletSnapshot.stop(); } catch (e) { /* ignore */ }
    try { autoReserve.stop(); } catch (e) { /* ignore */ }
    try { adminMonitor.stop(); } catch (e) { /* ignore */ }
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