#!/usr/bin/env node
'use strict';

/**
 * recover-sell-orphan.js — FIX-2026-08-02
 *
 * SELL MARKET สำหรับ orphan balance — กรณีที่ Binance มี base asset เหลืออยู่
 * แต่ DB ไม่ track (เกิดจาก Phase 1 race หรือ manual partial-sell)
 *
 * ต่างจาก recover-orphan-trades.js ตรงที่:
 *   - script นี้สร้าง SELL MARKET order จริง (live action)
 *   - ต้องการ --bot=<id> + --qty=<amount> explicit
 *   - ตรวจ minNotional ก่อนยิง
 *   - ไม่ต้องเช็ค DB — แค่ยืนยัน bot symbol/timeframe
 *
 * ใช้งาน:
 *   node scripts/recover-sell-orphan.js --bot=6a5f193ac5d569064ef643a2 --qty=2.4
 *   node scripts/recover-sell-orphan.js --bot=<id> --qty=2.4 --dry-run       # default
 *   node scripts/recover-sell-orphan.js --bot=<id> --qty=2.4 --execute      # apply
 *
 * ความเสี่ยง:
 *   - ยิง SELL MARKET จริง → ได้ราคาตลาด (slippage + fees)
 *   - เงิน USDT จะเข้า free balance ของ Binance
 *   - ไม่มี DB trade ติดตาม — แต่ bot.totalPnl ไม่ได้รับ (เป็น manual recovery)
 *
 * ปลอดภัยเพราะ:
 *   - default = --dry-run (แสดงแค่ action ที่จะทำ)
 *   - ตรวจ minNotional + lot size ก่อนยิง
 *   - ตรวจ balance available ก่อนยิง
 *   - สร้าง log file
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Bot = require('../src/db/models/Bot');
const binanceRest = require('../src/binance/binanceRest');
const symbolInfo = require('../src/binance/symbolInfo');

const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = !EXECUTE;
const BOT_ID = (process.argv.find((a) => a.startsWith('--bot=')) || '').slice('--bot='.length) || null;
const QTY_ARG = (process.argv.find((a) => a.startsWith('--qty=')) || '').slice('--qty='.length) || null;
const QTY = QTY_ARG ? parseFloat(QTY_ARG) : null;

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `recover-sell-orphan-${new Date().toISOString().slice(0, 10)}.log`);
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(line) {
  const ts = new Date().toISOString();
  const out = `[${ts}] ${line}`;
  console.log(out);
  logStream.write(out + '\n');
}

async function main() {
  await require('../src/db/connection').connect();
  log(`=== recover-sell-orphan START === mode=${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);

  // ─── Validate args ─────────────────────────────────────────────────────
  if (!BOT_ID) {
    log(`ERROR: missing --bot=<id>`);
    process.exit(2);
  }
  if (!QTY || !Number.isFinite(QTY) || QTY <= 0) {
    log(`ERROR: missing/invalid --qty=${QTY_ARG}`);
    process.exit(2);
  }
  log(`bot: ${BOT_ID}, qty: ${QTY}`);

  // ─── Load bot ──────────────────────────────────────────────────────────
  const bot = await Bot.findById(BOT_ID).lean();
  if (!bot) {
    log(`ERROR: bot ${BOT_ID} not found`);
    process.exit(2);
  }
  log(`bot: ${bot.symbol}/${bot.timeframe} enabled=${bot.enabled !== false}`);

  // ─── Load symbol info ──────────────────────────────────────────────────
  await symbolInfo.loadSymbol(bot.symbol);
  const info = symbolInfo.getCached(bot.symbol);
  if (!info) {
    log(`ERROR: symbol ${bot.symbol} not found in symbolInfo cache`);
    process.exit(2);
  }
  const baseAsset = info.baseAsset; // 'DEXE'
  const quoteAsset = info.quoteAsset; // 'USDT'
  const minNotional = info.notional ? parseFloat(info.notional.minNotional.toString()) : 0;
  const lotSize = info.lotSize ? parseFloat(info.lotSize.minQty.toString()) : 0;
  const tickSize = info.priceFilter ? parseFloat(info.priceFilter.tickSize.toString()) : 0;
  log(`symbol: ${bot.symbol} base=${baseAsset} quote=${quoteAsset} minNotional=${minNotional} lotSize=${lotSize} tickSize=${tickSize}`);

  // ─── Check balance ─────────────────────────────────────────────────────
  const account = await binanceRest.getAccount();
  const bal = (account.balances || []).find((b) => b.asset === baseAsset);
  if (!bal) {
    log(`ERROR: no balance for ${baseAsset}`);
    process.exit(2);
  }
  const freeQty = parseFloat(bal.free);
  const lockedQty = parseFloat(bal.locked);
  log(`balance: ${baseAsset} free=${freeQty} locked=${lockedQty} total=${freeQty + lockedQty}`);

  if (freeQty < QTY) {
    log(`ERROR: free balance ${freeQty} < requested qty ${QTY}`);
    process.exit(2);
  }

  // ─── Check ticker ──────────────────────────────────────────────────────
  const ticker = await binanceRest.get24hrTickers({ symbol: bot.symbol });
  const lastPrice = parseFloat(ticker.lastPrice || ticker.bidPrice || 0);
  if (!lastPrice) {
    log(`ERROR: no ticker for ${bot.symbol}`);
    process.exit(2);
  }
  const notional = QTY * lastPrice;
  log(`ticker: lastPrice=${lastPrice} notional=${notional.toFixed(2)} ${quoteAsset}`);

  // ─── Validate minNotional + lot size ───────────────────────────────────
  if (notional < minNotional) {
    log(`ERROR: notional ${notional.toFixed(2)} < minNotional ${minNotional} (smaller than dust)`);
    process.exit(2);
  }
  if (QTY < lotSize) {
    log(`ERROR: qty ${QTY} < lotSize ${lotSize}`);
    process.exit(2);
  }

  // ─── Show final action ─────────────────────────────────────────────────
  log(`\nACTION: ${DRY_RUN ? '[DRY-RUN] would SELL' : 'WILL SELL'} ${QTY} ${baseAsset} at MARKET on ${bot.symbol} (~${notional.toFixed(2)} ${quoteAsset})`);

  if (DRY_RUN) {
    log(`pass --execute to actually send the order`);
    await mongoose.disconnect();
    process.exit(0);
  }

  // ─── EXECUTE: place SELL MARKET ────────────────────────────────────────
  try {
    const orderResp = await binanceRest.newOrder({
      symbol: bot.symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: QTY.toString(),
      recvWindow: 5000,
    });
    log(`✅ SELL MARKET placed: orderId=${orderResp.orderId} status=${orderResp.status} executedQty=${orderResp.executedQty} cumQuote=${orderResp.cumQuote}`);
    log(`💰 Proceeds: ${orderResp.cumQuote} ${quoteAsset} (≈ avg ${(parseFloat(orderResp.cumQuote) / parseFloat(orderResp.executedQty)).toFixed(6)} ${quoteAsset}/${baseAsset})`);
    log(`NOTE: bot.totalPnl NOT updated (this is a manual recovery, not a bot trade)`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    log(`❌ SELL MARKET failed: ${err.message}`);
    log(JSON.stringify(err.body || err, null, 2));
    await mongoose.disconnect();
    process.exit(1);
  }
}

main().catch((err) => {
  log(`FATAL: ${err.message}\n${err.stack}`);
  process.exit(1);
});
