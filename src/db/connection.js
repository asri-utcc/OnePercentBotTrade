'use strict';

const mongoose = require('mongoose');
const config = require('../../config');
const logger = require('../utils/logger');

mongoose.set('strictQuery', true);

const MASKED_URI = config.mongoUri.replace(/\/\/[^@]*@/, '//***@');

/**
 * Connect to MongoDB with infinite retries.
 *
 * - Initial connect loops forever with capped exponential backoff
 *   (1s, 2s, 4s, 8s, 16s, 30s, 30s, ...) — guarantees the bot eventually
 *   comes up even if mongod takes minutes to start.
 * - After initial connect, mongoose's own driver auto-reconnects on
 *   'disconnected'/'error' events; we just log them.
 */
async function connect() {
  mongoose.connection.on('connected', () => {
    logger.info(`MongoDB connected: ${MASKED_URI}`);
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected — driver will auto-reconnect');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected');
  });
  mongoose.connection.on('error', (err) => {
    logger.error({ err: err.message }, 'MongoDB error');
  });

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  let attempt = 0;
  while (mongoose.connection.readyState !== 1) {
    attempt += 1;
    try {
      await mongoose.connect(config.mongoUri, {
        serverSelectionTimeoutMS: 5000,
        heartbeatFrequencyMS: 10000,
      });
      logger.info({ attempt }, 'MongoDB connect succeeded');
      return mongoose.connection;
    } catch (err) {
      const wait = Math.min(1000 * 2 ** Math.min(attempt - 1, 5), 30000);
      logger.warn({ attempt, waitMs: wait, err: err.message }, 'MongoDB connect retrying (infinite)');
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function disconnect() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

module.exports = { connect, disconnect, mongoose };