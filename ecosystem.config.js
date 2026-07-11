'use strict';

/**
 * PM2 ecosystem config for OnePercentBotTrade
 *
 * Usage:
 *   npm run pm2:start    # start with PM2
 *   npm run pm2:stop     # stop
 *   npm run pm2:restart  # restart
 *   npm run pm2:reload   # graceful reload (zero-downtime)
 *   npm run pm2:logs     # tail logs
 *   npm run pm2:status   # status
 *   npm run pm2:delete   # delete from PM2
 *   npm run pm2:monit    # monitor
 */
module.exports = {
  apps: [
    {
      name: 'onepercentbot',
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
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};