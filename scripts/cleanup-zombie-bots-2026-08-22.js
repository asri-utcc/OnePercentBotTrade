'use strict';

/**
 * FIX-2026-08-22: One-shot script — clean up ZOMBIE bots (soft-deleted but enabled=true).
 *
 * Background:
 *   - kaito/gps incident: บอทถูก auto-pause → user กด soft-delete → vol ฟื้น → auto-RESUME
 *     branch ใน botManager.checkAutoPauseBots() ตั้ง enabled=true + spawnTrader ใหม่
 *     ทั้งที่ deletedAt != null → trader ยังเปิด BUY ต่อจนกว่า process จะ crash
 *   - Loader filter ไม่กรอง deletedAt (botManager.js:949) + RESUME branch ไม่เช็ค deletedAt
 *     (botManager.js:1095) → บอทที่ user ลบแล้วถูก "ชุบชีวิต" โดยไม่ตั้งใจ
 *
 * What this script does:
 *   1. หา Bot ที่ deletedAt != null AND enabled === true (zombie state)
 *   2. สำหรับแต่ละบอท:
 *      - force-close positions ที่ค้าง (state ∈ FORCE_OPEN_STATES) → ใช้ cleanupOrphanTrades({ botId })
 *      - set enabled=false + status='disabled' + reset autoPauseReason
 *      - เก็บ audit (deletedAt, reDisabledAt, forcedCloseCount) ใน logs/zombie-cleanup-*.json
 *   3. ถ้ามี zombie running trader ค้างอยู่ใน botManager.traders Map → skip (script นี้รันแบบ standalone
 *      ไม่มี access ถึง in-memory state; PM2 restart after deploy จะ kill zombie trader เอง)
 *
 * Usage:
 *   node scripts/cleanup-zombie-bots-2026-08-22.js              # dry-run (default)
 *   FORCE_YES=1 node scripts/cleanup-zombie-bots-2026-08-22.js # apply changes
 *   node scripts/cleanup-zombie-bots-2026-08-22.js --dry-run   # explicit dry-run (skip FORCE_YES)
 *
 * Output:
 *   - console: per-bot status + summary
 *   - logs/zombie-cleanup-YYYYMMDD-HHMM.json: full report (zombies[], summary, ts)
 *
 * NOTE: ต้องรันหลังจาก deploy fix (botManager.js + trader.js) แล้วเท่านั้น
 *       ก่อนหน้า fix: zombie อาจเกิดใหม่ได้อีก (auto-RESUME จะไม่ trigger เพราะเงื่อนไข healthy
 *       ไม่เปลี่ยน แต่ถ้า vol ฟื้นหลัง fix แล้ว — RESUME branch จะถูก guard แล้ว)
 */

const path = require('path');
const fs = require('fs');

const db = require('../src/db/connection');
const logger = require('../src/utils/logger');
const forceClose = require('../src/core/forceClose');
const Bot = require('../src/db/models/Bot');

function isDryRun() {
  if (process.argv.includes('--dry-run')) return true;
  return process.env.FORCE_YES !== '1';
}

function fmtTs(d) {
  if (!d) return '(null)';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '(invalid)';
  return dt.toISOString();
}

async function main() {
  const dryRun = isDryRun();
  const startedAt = new Date();

  console.log('=== Zombie Bot Cleanup (FIX-2026-08-22) ===');
  console.log(`Mode: ${dryRun ? 'DRY-RUN (no writes)' : 'APPLY (FORCE_YES=1)'}`);
  console.log(`Started at: ${fmtTs(startedAt)}`);

  await db.connect();

  // Find zombies: soft-deleted AND enabled=true
  const zombies = await Bot.find({
    deletedAt: { $ne: null },
    enabled: true,
  }).lean();

  console.log(`\nFound ${zombies.length} zombie bot(s) (deletedAt!=null && enabled=true)\n`);

  if (zombies.length === 0) {
    console.log('Nothing to clean. Exiting.');
    await db.disconnect();
    return { zombies: [], summary: { total: 0, disabled: 0, forceClosed: 0, errors: 0 } };
  }

  // Print details before any change
  for (const z of zombies) {
    console.log(`- _id=${z._id}  symbol=${z.symbol}  tf=${z.timeframe}  name=${z.name || '(none)'}`);
    console.log(`   deletedAt=${fmtTs(z.deletedAt)}  enabled=${z.enabled}  status=${z.status}  autoPauseReason=${z.autoPauseReason || '(null)'}`);
    console.log(`   enabledAt=${fmtTs(z.enabledAt)}  scheduledDeleteAt=${fmtTs(z.scheduledDeleteAt)}`);
  }

  if (dryRun) {
    console.log('\n[DRY-RUN] Re-run with FORCE_YES=1 to apply changes.');
    console.log('[DRY-RUN] No DB writes performed.');
    await db.disconnect();
    return { zombies: zombies.map(z => ({ id: String(z._id), symbol: z.symbol, deletedAt: z.deletedAt })), summary: { total: zombies.length, disabled: 0, forceClosed: 0, errors: 0, dryRun: true } };
  }

  // Apply: force-close positions first, then disable bot
  const summary = { total: zombies.length, disabled: 0, forceClosed: 0, errors: 0, items: [] };
  for (const z of zombies) {
    const item = { id: String(z._id), symbol: z.symbol, tf: z.timeframe, name: z.name, deletedAt: z.deletedAt, disabled: false, forceClosedTrades: 0, errors: [] };

    // 1) Force-close open positions for this bot
    try {
      const result = await forceClose.cleanupOrphanTrades({ botId: z._id });
      item.forceClosedTrades = (result && result.cleaned) ? result.cleaned.length : 0;
      summary.forceClosed += item.forceClosedTrades;
      if (result && result.errors && result.errors.length) {
        for (const e of result.errors) item.errors.push(`forceClose: ${e.tradeId || '?'} → ${e.error || 'unknown'}`);
      }
    } catch (err) {
      item.errors.push(`forceClose threw: ${err.message}`);
      summary.errors += 1;
    }

    // 2) Disable the bot (clean enabled=false + clear autoPauseReason)
    try {
      const upd = await Bot.updateOne(
        { _id: z._id },
        {
          $set: {
            enabled: false,
            enabledAt: null,
            status: 'disabled',
            // Clear autoPauseReason so future auto-pause scans don't try to RESUME again
            // (loader filter ใหม่ตัด deletedAt แล้ว — แต่ defense-in-depth)
            autoPauseReason: null,
            autoPauseSkipReason: null,
            autoPauseLastActionAt: new Date(),
          },
        }
      );
      item.disabled = (upd && upd.modifiedCount) > 0;
      if (item.disabled) summary.disabled += 1;
    } catch (err) {
      item.errors.push(`Bot.updateOne threw: ${err.message}`);
      summary.errors += 1;
    }

    console.log(`\n  ✅ ${z.symbol} (${z.name || z._id})`);
    console.log(`     forceClosedTrades=${item.forceClosedTrades}  disabled=${item.disabled}  errors=${item.errors.length}`);
    for (const e of item.errors) console.log(`     ❌ ${e}`);
    summary.items.push(item);
  }

  // Persist report
  const tsTag = startedAt.toISOString().replace(/[-:T]/g, '').slice(0, 13); // YYYYMMDDHHMM
  const reportPath = path.join(__dirname, '..', 'logs', `zombie-cleanup-${tsTag}.json`);
  const reportDir = path.dirname(reportPath);
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    dryRun,
    summary,
  }, null, 2));

  console.log('\n=== Result ===');
  console.log(`Total zombies:    ${summary.total}`);
  console.log(`Disabled:        ${summary.disabled}`);
  console.log(`Force-closed:    ${summary.forceClosed} trade(s)`);
  console.log(`Errors:          ${summary.errors}`);
  console.log(`\nReport saved to: ${reportPath}`);

  await db.disconnect();
  return { summary };
}

main()
  .then((result) => {
    process.exit(result && result.summary && result.summary.errors > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('FATAL:', err.stack || err.message);
    process.exit(2);
  });