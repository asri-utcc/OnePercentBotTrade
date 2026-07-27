'use strict';

/**
 * One-shot migration — backfill Bot.totalActiveMs for currently-enabled bots.
 *
 * ใช้หลังจาก deploy ฟีเจอร์ "cumulative active time" เพื่อให้บอทที่เปิดอยู่แล้ว
 * มีค่า totalActiveMs ตั้งต้นจาก session ปัจจุบัน — ไม่ต้องรอปิด-เปิดใหม่รอบแรก.
 *
 * - enabled bots: totalActiveMs = (now - enabledAt); enabledAt คงเดิม (live counter ต่อ)
 * - disabled bots: ไม่แตะ — พิมพ์รายการไว้ให้เห็น (เราไม่มี event log ของ enable/disable history
 *   เลยประมาณเวลาสะสมของบอทที่ปิดอยู่ไม่ได้ — ค่าจะเริ่มนับจาก 0 จนกว่าจะ enable รอบใหม่)
 *
 * Usage:
 *   node scripts/backfill-total-active.js           # prompt YES
 *   node scripts/backfill-total-active.js --force   # skip prompt (FORCE_YES=1 also works)
 */

const readline = require('readline');

const db = require('../src/db/connection');
const Bot = require('../src/db/models/Bot');

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve((a || '').trim()); });
  });
}

function fmtDuration(ms) {
  if (ms == null || ms <= 0) return '0 นาที';
  const now = new Date();
  const past = new Date(now.getTime() - ms);
  let years = now.getFullYear() - past.getFullYear();
  let months = now.getMonth() - past.getMonth();
  let days = now.getDate() - past.getDate();
  let hours = now.getHours() - past.getHours();
  let minutes = now.getMinutes() - past.getMinutes();
  if (minutes < 0) { minutes += 60; hours -= 1; }
  if (hours < 0)   { hours += 24; days -= 1; }
  if (days < 0) {
    const prevMonthLastDay = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    days += prevMonthLastDay;
    months -= 1;
  }
  if (months < 0) { months += 12; years -= 1; }
  const u = [];
  if (years > 0)   u.push(`${years} ปี`);
  if (months > 0)  u.push(`${months} เดือน`);
  if (days > 0)    u.push(`${days} วัน`);
  if (hours > 0)   u.push(`${hours} ชั่วโมง`);
  if (minutes > 0) u.push(`${minutes} นาที`);
  const top = u.slice(0, 3);
  return top.length ? top.join(' ') : `${Math.floor(ms / 1000)} วินาที`;
}

async function main() {
  const force = process.argv.includes('--force') || process.env.FORCE_YES === '1';

  await db.connect();
  const all = await Bot.find().lean();

  const enabled = all.filter((b) => b.enabled && b.enabledAt);
  const disabled = all.filter((b) => !b.enabled);
  const stale = all.filter((b) => b.enabled && !b.enabledAt); // data inconsistency

  console.log(`\n=== Backfill Bot.totalActiveMs ===`);
  console.log(`Total bots: ${all.length}`);
  console.log(`  enabled (will backfill): ${enabled.length}`);
  console.log(`  disabled (skipped):      ${disabled.length}`);
  console.log(`  enabled but no enabledAt (skipped — data inconsistency): ${stale.length}\n`);

  if (enabled.length === 0) {
    console.log('Nothing to backfill. Exiting.');
    await db.disconnect();
    return;
  }

  const now = Date.now();
  console.log('Will apply the following updates:');
  for (const b of enabled) {
    const sessionMs = now - new Date(b.enabledAt).getTime();
    console.log(
      `  • ${(b.name || b.symbol).padEnd(22)} ` +
      `enabledAt=${new Date(b.enabledAt).toISOString()}  ` +
      `→ totalActiveMs = ${sessionMs}ms  (${fmtDuration(sessionMs)})`
    );
  }
  console.log(`\n(enabledAt จะไม่ถูกแตะ — live uptime counter ยังนับต่อจากเดิม)`);

  if (disabled.length > 0) {
    console.log('\nDisabled bots (no history available — totalActiveMs คงเป็น 0):');
    for (const b of disabled) {
      console.log(`  - ${(b.name || b.symbol).padEnd(22)} current totalActiveMs=${b.totalActiveMs || 0}`);
    }
  }

  if (!force) {
    const ans = await ask('\nพิมพ์ YES (ตัวพิมพ์ใหญ่) เพื่อยืนยันการ backfill: ');
    if (ans !== 'YES') {
      console.log('ยกเลิก.');
      await db.disconnect();
      return;
    }
  } else {
    console.log('\n--force หรือ FORCE_YES=1 — ข้าม confirmation prompt');
  }

  console.log('\n... backfilling ...');
  let updated = 0;
  for (const b of enabled) {
    const sessionMs = now - new Date(b.enabledAt).getTime();
    if (sessionMs <= 0) continue;
    const res = await Bot.updateOne(
      { _id: b._id },
      { $set: { totalActiveMs: sessionMs } }   // enabledAt คงเดิม
    );
    if (res.modifiedCount === 1) updated += 1;
  }

  console.log(`\n=== Done ===`);
  console.log(`Updated ${updated}/${enabled.length} bot(s).`);
  console.log('ตรวจสอบผลลัพธ์: บอร์ด → แต่ละการ์ดจะมี 🕒 Active: <duration> ในแถวข้อมูล');

  await db.disconnect();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});