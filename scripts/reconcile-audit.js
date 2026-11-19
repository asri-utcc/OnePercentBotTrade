#!/usr/bin/env node
'use strict';

/**
 * FIX-2026-11-19: run the read-only DB ↔ Binance reconcile audit once and print the issues.
 *   node scripts/reconcile-audit.js            # print only
 *   node scripts/reconcile-audit.js --notify   # also send Telegram if issues found
 */

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
const mongoose = require('mongoose');
const config = require('../config');
const reconcileAudit = require('../src/services/reconcileAudit');

(async () => {
  await mongoose.connect(config.mongoUri);
  const issues = await reconcileAudit.runOnce({ notify: process.argv.includes('--notify') });
  if (issues.length === 0) console.log('✅ DB matches Binance');
  for (const i of issues) console.log(`[${i.type}] ${i.detail}`);
  await mongoose.disconnect();
  process.exit(issues.length ? 2 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
