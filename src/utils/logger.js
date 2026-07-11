'use strict';

const pino = require('pino');
const config = require('../../config');

const isDev = config.env === 'development';

const logger = pino({
  level: config.logLevel,
  base: { service: 'onepercentbottrade' },
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service',
        },
      }
    : undefined,
});

module.exports = logger;