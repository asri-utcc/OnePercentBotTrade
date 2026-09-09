'use strict';

/**
 * PM2 ecosystem config for FAIZ instance (friend distribution — same host as owner)
 *
 * FIX-2026-09-09: Multi-instance support
 *
 * Usage:
 *   npm run pm2:start:faiz    # start with PM2 (--env production)
 *   npm run pm2:stop:faiz
 *   npm run pm2:reload:faiz
 *   npm run pm2:delete:faiz
 *   npm run pm2:logs:faiz
 *
 * Required env file: .env.faiz (sibling of ecosystem.faiz.config.js)
 * Required pre-seeded: data/faiz-machine-id.txt (run scripts/pre-seed-machine-id.js faiz)
 *
 * Differences from ecosystem.config.js (owner instance):
 *   - name: 'onepercentbot-faiz'
 *   - PORT=2026, HOST=127.0.0.1 (in .env.faiz)
 *   - MONGODB_URI=...onepercentbottrade_faiz
 *   - log files: logs/faiz-pm2-out.log, logs/faiz-pm2-error.log
 *   - PID file: separate
 *
 * Both instances share the SAME Binance IP weight budget — owner must coordinate
 * via AppConfig.binanceRateLimitPerMin (admin UI → Settings → Rate Limit).
 * Recommended: 3000 per instance when running 2, 2000 when running 3.
 */

module.exports = {
  apps: [
    {
      name: 'onepercentbot-faiz',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 10000,
      wait_ready: false,
      listen_timeout: 10000,
      // Load env from .env.faiz — PM2 will overlay these on top of the env block below
      // (use --env production to pick up NODE_ENV=production; .env.faiz holds the rest)
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },
      // Separate log files (avoid mixing with owner instance)
      error_file: './logs/faiz-pm2-error.log',
      out_file: './logs/faiz-pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // PID file — separate from owner
      pid_file: './logs/faiz.pid',
    },
  ],
};
