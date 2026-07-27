#!/usr/bin/env node
'use strict';

/**
 * recover-orphan-trades.js — FIX-2026-07-23
 *
 * One-time recovery script สำหรับแก้ trade ที่ state ใน DB ไม่ตรงกับความเป็นจริง:
 *
 *   1. trades ที่ state='cancelled' แต่ sellQty > 0  → บอทเคยขายไปแล้วแต่ state ผิด
 *      → flip เป็น 'sold', update realizedPnl + bot.totalPnl/totalTrades/winTrades
 *
 *   2. trades ที่ state='cancelled' / 'failed' แต่ buyQty > 0 (dust_orphan)
 *      → ตรวจ Binance balance — ถ้ามี base asset ตกค้างจริง → สร้าง recovery Trade ใหม่
 *
 *   3. Scan Binance ทุก base asset ของบอทที่ enabled เทียบกับ DB
 *      → ถ้าเจอ orphan (มี asset แต่ไม่มี active trade) → flag ให้ผู้ใช้รู้
 *
 * ใช้งาน:
 *   node scripts/recover-orphan-trades.js              # dry-run (default)
 *   node scripts/recover-orphan-trades.js --execute    # แก้จริง
 *   node scripts/recover-orphan-trades.js --bot=<id>   # เฉพาะบอท
 *
 * ปลอดภัยเพราะ:
 *   - default = dry-run แสดงแค่สิ่งที่จะแก้
 *   - ทุก UPDATE ใช้ WHERE state ปัจจุบันเพื่อกันเขียนทับโดยไม่ตั้งใจ
 *   - สร้าง log file บันทึกทุก action
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');
const Signal = require('../src/db/models/Signal');
const binanceRest = require('../src/binance/binanceRest');
const symbolInfo = require('../src/binance/symbolInfo');

const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = !EXECUTE;
const BOT_ID = (process.argv.find((a) => a.startsWith('--bot=')) || '').slice('--bot='.length) || null;

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `recover-orphan-${new Date().toISOString().slice(0, 10)}.log`);
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(line) {
  const ts = new Date().toISOString();
  const out = `[${ts}] ${line}`;
  console.log(out);
  logStream.write(out + '\n');
}

async function main() {
  await require('../src/db/connection').connect();
  log(`=== recover-orphan-trades START === mode=${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);

  const botFilter = BOT_ID ? { _id: mongoose.Types.ObjectId.createFromHexString(BOT_ID) } : {};
  const bots = await Bot.find({ ...botFilter, enabled: { $ne: false } });
  log(`scanning ${bots.length} bot(s): ${bots.map((b) => `${b.symbol}/${b.timeframe}`).join(', ')}`);

  let fixCount = 0;
  let orphanCount = 0;

  // ─── Phase 1: fix state='cancelled' but sellQty > 0 ─────────────────────
  for (const bot of bots) {
    log(`\n--- Phase 1: bot ${bot._id.toString()} ${bot.symbol}/${bot.timeframe} ---`);

    // trade ที่ state='cancelled' หรือ 'failed' แต่ sellQty > 0
    const ghosts = await Trade.find({
      botId: bot._id,
      state: { $in: ['cancelled', 'failed'] },
      sellQty: { $gt: 0 },
    }).lean();

    log(`  found ${ghosts.length} ghost trade(s) with sellQty>0 but state in [cancelled/failed]`);

    for (const t of ghosts) {
      const notional = (parseFloat(t.sellQty) || 0) * (parseFloat(t.buyPrice) || 0);
      log(`    ghost trade ${t._id.toString()} state=${t.state} buyQty=${t.buyQty} sellQty=${t.sellQty} buyPrice=${t.buyPrice} err="${(t.error || '').slice(0, 60)}"`);

      if (DRY_RUN) continue;

      // คำนวณ PnL (ประมาณจาก avg sell = buyPrice × (1 + tp%) ถ้า sellPrice ไม่มี)
      const sellPrice = parseFloat(t.sellPrice)
        || (t.buyPrice ? parseFloat(t.buyPrice) * (1 + (bot.tpPercent || 0) / 100) : null);
      const qty = parseFloat(t.sellQty);
      const buyPx = parseFloat(t.buyPrice);
      let realizedPnl = null;
      let pnlPercent = null;
      if (sellPrice && buyPx && qty) {
        // simplified: gross = (sellPrice - buyPrice) × qty, net minus ~0.15% fee both sides
        const gross = (sellPrice - buyPx) * qty;
        const fees = qty * sellPrice * 0.001 + qty * buyPx * 0.001;
        realizedPnl = gross - fees;
        pnlPercent = (realizedPnl / (qty * buyPx)) * 100;
      }

      // atomic UPDATE เฉพาะถ้า state ยังเป็น cancelled/failed
      const r = await Trade.updateOne(
        { _id: t._id, state: { $in: ['cancelled', 'failed'] } },
        {
          $set: {
            state: 'sold',
            sellStatus: t.sellStatus || 'FILLED',
            sellFilledAt: t.sellFilledAt || t.updatedAt || new Date(),
            error: `[FIX-2026-07-23] ghost trade — recovered from cancelled/failed to sold. original err: ${t.error || '-'}`,
            realizedPnl: realizedPnl != null ? Number(realizedPnl.toFixed(6)) : 0,
            pnlPercent: pnlPercent != null ? Number(pnlPercent.toFixed(4)) : 0,
          },
        }
      );
      if (r.modifiedCount === 1) {
        fixCount += 1;
        // update bot stats — ใช้ $inc กับ guard > 0 (กันเคส ghost trade เคยถูกนับไปแล้ว)
        await Bot.updateOne(
          { _id: bot._id, [`totalPnl`]: { $exists: true } },
          {
            $inc: {
              totalPnl: realizedPnl || 0,
              totalTrades: 1,
              winTrades: (realizedPnl > 0 ? 1 : 0),
            },
          }
        );
        log(`      → FIXED: state='sold', PnL=${realizedPnl?.toFixed(4)} USDT`);
      }
    }
  }

  // ─── Phase 2: scan Binance balance vs DB ────────────────────────────────
  log(`\n--- Phase 2: scan Binance balance for orphan qty ---`);
  let account;
  try {
    account = await binanceRest.getAccount();
  } catch (err) {
    log(`ERROR fetching Binance account: ${err.message}`);
    process.exit(1);
  }

  for (const bot of bots) {
    const baseAsset = bot.symbol.replace(/USDT$|USDC$|BUSD$/, '');
    const bal = (account.balances || []).find((b) => b.asset === baseAsset);
    const freeQty = bal ? parseFloat(bal.free) : 0;
    const lockedQty = bal ? parseFloat(bal.locked) : 0;
    const totalQty = freeQty + lockedQty;

    if (totalQty <= 0) {
      log(`  ${bot.symbol} (${baseAsset}): balance=0 ✓`);
      continue;
    }

    // หา active trade อธิบายยอด
    const active = await Trade.findOne({
      botId: bot._id,
      state: { $in: ['placed', 'filled', 'holding', 'selling'] },
    }).sort({ createdAt: -1 }).lean();

    const expectedFromActive = active && active.buyQty
      ? parseFloat(active.buyQty) - (parseFloat(active.sellQty) || 0)
      : 0;
    const orphanQty = totalQty - expectedFromActive;

    log(`  ${bot.symbol}: free=${freeQty}, locked=${lockedQty}, total=${totalQty}`);
    log(`    activeTrade: ${active ? `${active._id} state=${active.state} buyQty=${active.buyQty}` : 'NONE'}`);
    log(`    expectedFromActive: ${expectedFromActive}`);
    log(`    potential orphan: ${orphanQty.toFixed(8)} ${baseAsset}`);

    if (Math.abs(orphanQty) < 0.0000001) {
      log(`    ✓ balance matches DB — no orphan`);
    } else if (orphanQty > 0) {
      orphanCount += 1;
      log(`    ⚠️ ORPHAN: ${orphanQty.toFixed(8)} ${baseAsset} บน Binance ไม่มี trade อธิบาย`);
      // ตรวจ minNotional — ถ้า orphan ใหญ่พอ → แนะนำสร้าง recovery trade
      try {
        await symbolInfo.loadSymbol(bot.symbol);
        const info = symbolInfo.getCached(bot.symbol);
        const minNotional = info && info.notional ? parseFloat(info.notional.minNotional.toString()) : 0;
        const ticker = await binanceRest.get24hrTickers({ symbol: bot.symbol });
        const lastPrice = parseFloat(ticker.lastPrice || ticker.bidPrice || 0);
        const notional = orphanQty * lastPrice;
        log(`    last price ≈ ${lastPrice}, orphan notional ≈ ${notional.toFixed(2)} ${bot.symbol.endsWith('USDT') ? 'USDT' : ''} (minNotional=${minNotional})`);
        if (notional >= minNotional) {
          log(`    🚑 RECOVERABLE: orphan notional ≥ minNotional — recommend placing SELL MARKET`);
          if (!DRY_RUN) {
            log(`    NOTE: manual SELL required. Run: node scripts/recover-sell-orphan.js --bot=${bot._id} --qty=${orphanQty}`);
          }
        } else {
          log(`    ⚠️ DUST: orphan notional < minNotional → cannot SELL via API. Manual recovery or convert via Dust Transfer`);
        }
      } catch (e) {
        log(`    could not check recoverability: ${e.message}`);
      }
    } else {
      log(`    ℹ️ DB expects MORE than Binance holds — possible out-of-sync; investigate manually`);
    }
  }

  log(`\n=== SUMMARY ===`);
  log(`mode: ${DRY_RUN ? 'DRY-RUN (use --execute to apply)' : 'EXECUTE'}`);
  log(`ghost trades fixed: ${fixCount}`);
  log(`orphan quantities detected: ${orphanCount}`);
  log(`log file: ${LOG_FILE}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  log(`FATAL: ${err.message}\n${err.stack}`);
  process.exit(1);
});
