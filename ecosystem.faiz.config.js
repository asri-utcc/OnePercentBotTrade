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

const fs = require('fs');
const path = require('path');

/**
 * Load .env.faiz into a flat object so we can inline it into PM2's `env` block.
 * Why not `env_file:`? PM2 6.x's env_file is unreliable across versions; inlining
 * via the `env` block is the most portable — every PM2 release honors it.
 * Format: KEY=VALUE per line, # comments, no quoting/escaping needed for our keys.
 */
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[ecosystem.faiz] Required env file missing: ${filePath}`);
  }
  const out = {};
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    out[key] = val;
  }
  return out;
}

const FAIZ_ENV = loadEnvFile(path.resolve(__dirname, '.env.faiz'));

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
      // FIX-2026-09-09: Inline .env.faiz into env block (PM2's env_file is
      //   flaky across versions; inlining is the most portable — every PM2
      //   release honors the `env` block). NODE_ENV can still be toggled via
      //   `--env production|development` without touching .env.faiz.
      env: {
        ...FAIZ_ENV,
        NODE_ENV: 'production',
      },
      env_development: {
        ...FAIZ_ENV,
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
