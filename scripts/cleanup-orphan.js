'use strict';

/**
 * One-shot interactive script — synthetic-close orphan trades (no MARKET SELL).
 *
 * Usage:  node scripts/cleanup-orphan.js [symbol]
 *   e.g.  node scripts/cleanup-orphan.js          # all bots
 *         node scripts/cleanup-orphan.js DEXEUSDT # restrict to one symbol
 *
 * Prompts an ARE-YOU-SURE confirmation; prints every trade before changing
 * anything; writes a small JSON report to logs/orphan-cleanup-YYYYMMDD-HHMM.json
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const config = require('../config');
const db = require('../src/db/connection');
const logger = require('../src/utils/logger');
const forceClose = require('../src/core/forceClose');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve((a || '').trim()); });
  });
}

async function main() {
  const symbol = process.argv[2] || null;
  await db.connect();

  const query = { state: { $in: forceClose.FORCE_OPEN_STATES } };
  const open = await Trade.find(query).populate('botId');
  const target = symbol ? open.filter((t) => t.botId && t.botId.symbol === symbol.toUpperCase()) : open;

  console.log(`\n=== Orphan Cleanup (synthetic only — ไม่ยิง MARKET SELL) ===`);
  console.log(`Filter symbol: ${symbol || '(all)'}`);
  console.log(`Found: ${target.length} orphan trades\n`);
  if (target.length === 0) {
    console.log('Nothing to clean. Exiting.');
    await db.disconnect();
    return;
  }

  for (const t of target) {
    const bot = t.botId || {};
    console.log(`- ${t._id.toString()}  ${bot.symbol || '?'}/${bot.timeframe || '?'}  state=${t.state}  buyPx=${t.buyPrice}  qty=${t.buyQty}  buyOrder=${t.buyOrderId}  sellOrder=${t.sellOrderId}`);
    console.log(`   bot=${bot.name || '(none)'}  enabled=${bot.enabled}  createdAt=${t.createdAt && t.createdAt.toISOString()}`);
  }

  if (process.env.FORCE_YES === '1') {
    console.log('\nFORCE_YES=1 — skipping confirmation prompt');
  } else {
    const ans = await ask('\nพิมพ์ YES (ตัวพิมพ์ใหญ่) เพื่อยืนยันการ synthetic-close ทั้งหมด: ');
    if (ans !== 'YES') {
      console.log('ยกเลิก.');
      await db.disconnect();
      return;
    }
  }

  console.log('\n... cleaning ...');
  const summary = await forceClose.cleanupOrphanTrades({ symbol });

  console.log('\n=== Result ===');
  console.log(`Cleaned: ${summary.cleaned.length}`);
  for (const c of summary.cleaned) {
    console.log(`  ✅ ${c.tradeId}  ${c.symbol}  mode=${c.mode}${c.error ? `  err=${c.error}` : ''}`);
  }
  if (summary.errors.length) {
    console.log(`Errors: ${summary.errors.length}`);
    for (const e of summary.errors) {
      console.log(`  ❌ ${e.tradeId}  ${e.error}`);
    }
  }

  // Write a small JSON report next to logs/ for audit.
  const logsDir = path.join(__dirname, '..', 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) { /* ignore */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const reportPath = path.join(logsDir, `orphan-cleanup-${stamp}.json`);
  try {
    fs.writeFileSync(reportPath, JSON.stringify({ symbol, cleaned: summary.cleaned, errors: summary.errors }, null, 2));
    console.log(`\nReport: ${reportPath}`);
  } catch (err) {
    console.log(`(could not write report: ${err.message})`);
  }

  await db.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
