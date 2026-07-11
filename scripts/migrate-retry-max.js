'use strict';

/**
 * Migrate existing bot documents to add retryMax field if missing.
 * - บอทเก่าที่สร้างก่อน deploy retryMax จะไม่มี field นี้
 * - ใส่ default = 1 (ตาม schema default)
 * - run: node scripts/migrate-retry-max.js
 */

const mongoose = require('mongoose');
const config = require('../config');
const Bot = require('../src/db/models/Bot');
const logger = require('../src/utils/logger');

async function main() {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
  logger.info('connected to MongoDB');

  const result = await Bot.updateMany(
    { retryMax: { $exists: false } },
    { $set: { retryMax: 1 } }
  );
  logger.info({ matched: result.matchedCount, modified: result.modifiedCount }, 'migration done');

  const bots = await Bot.find().select('name symbol retryMax').lean();
  logger.info({ bots }, 'current bots');
  await mongoose.disconnect();
}

main().catch((err) => {
  logger.error({ err: err.message }, 'migration failed');
  process.exit(1);
});