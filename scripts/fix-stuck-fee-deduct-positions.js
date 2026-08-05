#!/usr/bin/env node
'use strict';

/**
 * fix-stuck-fee-deduct-positions.js — FIX-2026-08-05
 *
 * One-time recovery: positions ที่ค้างใน state='holding' เพราะ BNB หมด
 * → Binance หัก 0.1% fee จาก base asset (VIC/COTI/HOME/HFT/NIL ฯลฯ)
 * → Trader วาง SELL ด้วย buyQty เต็ม → -2010 "insufficient balance"
 * → HOLDING retry ด้วย freeQty 0.999×buyQty → -1013 "LOT_SIZE"
 *
 * สำหรับ trade ที่ระบุใน STUCK_TRADE_IDS:
 *   1. โหลด trade + bot
 *   2. ดึง LOT_SIZE filter จาก symbolInfo (stepSize, minQty)
 *   3. ดึง free balance ปัจจุบันจาก Binance /api/v3/account
 *   4. Compute sellQty = roundDown(freeQty หรือ buyQty×0.999 แล้วแต่ค่าน้อยกว่า)
 *   5. ดึง bookTicker (bid/ask) → midPrice
 *   6. ถ้า midPrice ≥ TP target → ยิง **MARKET SELL** (ออกทันที)
 *      ถ้า midPrice < TP target → ยิง **LIMIT_MAKER SELL @ TP** (รอ TP)
 *   7. update trade: state='selling', sellOrderId, sellQty, sellPlacedAt
 *
 * Usage:
 *   node scripts/fix-stuck-fee-deduct-positions.js              # dry-run (default)
 *   node scripts/fix-stuck-fee-deduct-positions.js --execute    # place orders จริง
 *
 * Safety:
 *   - default = dry-run แสดงแผนอย่างเดียว
 *   - updateOne ทุกครั้ง filter ด้วย state='holding' กันเขียนทับโดยไม่ตั้งใจ
 *   - เขียน log file ทุก action
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();
const config = require('../config');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');
const binanceRest = require('../src/binance/binanceRest');
const symbolInfo = require('../src/binance/symbolInfo');

const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = !EXECUTE;

const API_KEY = config.binance.apiKey;
const API_SECRET = config.binance.apiSecret;
const BASE_URL = config.binance.restBase || 'https://api.binance.com';

/**
 * directSignedRequest — bypass binanceRest.signedRequest (FIX-2026-08-05b)
 *   - binanceRest.signedRequest caches time offset 5 นาที — local clock drift ทำให้ -1021
 *   - ใน script รันนอก pm2, local clock ของ Windows runner เลื่อน +1.8 วินาทีจาก Binance
 *   - ทางแก้: fetch Binance serverTime แล้วใช้ค่านั้นเป็น timestamp ตรงๆ (apply +200ms safety)
 */
function directSignedRequest(method, path, params = {}) {
  return new Promise((resolve, reject) => {
    // Fetch server time first
    const timeReq = https.get(`${BASE_URL}/api/v3/time`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const { serverTime } = JSON.parse(data);
          const timestamp = serverTime + 200; // 200ms safety buffer
          const qsRaw = { ...params, recvWindow: 5000, timestamp };
          const queryString = Object.entries(qsRaw)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');
          const sig = crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
          const url = `${BASE_URL}${path}?${queryString}&signature=${sig}`;

          const opts = {
            method,
            hostname: new URL(BASE_URL).hostname,
            path: url.replace(BASE_URL, ''),
            headers: { 'X-MBX-APIKEY': API_KEY },
          };
          const req2 = https.request(opts, (r) => {
            let body = '';
            r.on('data', (c) => { body += c; });
            r.on('end', () => {
              try {
                const j = JSON.parse(body);
                if (r.statusCode >= 400) return reject(new Error(`binance ${r.statusCode}: ${JSON.stringify(j).slice(0, 300)}`));
                resolve(j);
              } catch (e) {
                reject(new Error(`parse error (status ${r.statusCode}): ${body.slice(0, 300)}`));
              }
            });
          });
          req2.on('error', reject);
          req2.end();
        } catch (e) { reject(e); }
      });
    });
    timeReq.on('error', reject);
  });
}

// FIX-2026-08-05: 5 trades ที่ติด holding เพราะ BNB-empty fee deduction
const STUCK_TRADE_IDS = [
  '6a72555c37d90627a0d49e19', // VICUSDT
  '6a72570a37d90627a0d4a0e5', // COTIUSDT
  '6a72571637d90627a0d4a109', // HOMEUSDT
  '6a725cc337d90627a0d4add9', // HFTUSDT
  '6a725e3737d90627a0d4b122', // NILUSDT
];

const FEE_RATE = 0.001; // Binance Spot standard fee when paying with BNB disabled

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `fix-stuck-fee-${new Date().toISOString().slice(0, 10)}.log`);
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(line) {
  const ts = new Date().toISOString();
  const out = `[${ts}] ${line}`;
  console.log(out);
  logStream.write(out + '\n');
}

/**
 * Get FREE balance of base asset for a symbol (Binance Spot account).
 */
async function getFreeBalance(symbol) {
  // FIX-2026-08-05c: use direct signed axios to fetch /api/v3/account balances
  //   - binanceRest.signedRequest has stale time-offset cache → -1021 errors in standalone scripts
  //   - directSignedRequest already defined above uses fresh serverTime each call → reliable
  const acct = await directSignedRequest('GET', '/api/v3/account', {});
  const base = symbolInfo.loadSymbol ? null : null; // placeholder
  // baseAsset is loaded separately — pass it via a quick getExchangeInfo or skip via map
  const info = await symbolInfo.loadSymbol(symbol);
  const baseAsset = info?.baseAsset;
  if (!baseAsset) throw new Error(`unknown baseAsset for ${symbol}`);
  const bal = (acct.balances || []).find((b) => b.asset === baseAsset);
  return bal ? parseFloat(bal.free) : 0;
}

/**
 * Round qty DOWN to the nearest valid multiple of stepSize.
 * Returns integer-or-Decimal qty value.
 */
function roundQtyDown(qty, stepSizeStr) {
  if (!stepSizeStr) return qty;
  const step = parseFloat(stepSizeStr);
  if (step <= 0) return qty;
  return Math.floor(qty / step) * step;
}

async function fixOne(tradeIdStr) {
  const trade = await Trade.findById(tradeIdStr).lean();
  if (!trade) throw new Error(`Trade ${tradeIdStr} not found`);
  if (trade.state !== 'holding') {
    log(`[skip] ${trade.symbol} trade=${tradeIdStr} state=${trade.state} — not holding`);
    return null;
  }

  const bot = await Bot.findById(trade.botId).lean();
  if (!bot) throw new Error(`Bot ${trade.botId} not found`);

  const info = await symbolInfo.loadSymbol(trade.symbol);
  if (!info || !info.lotSize) {
    throw new Error(`symbolInfo missing/lotSize missing for ${trade.symbol}`);
  }

  // 1. live balance (real-time from Binance)
  let freeQty = null;
  try {
    freeQty = await getFreeBalance(trade.symbol);
  } catch (err) {
    log(`       [WARN] getFreeBalance failed: ${err.message} — falling back to buyQty × 0.999`);
  }

  // 2. intended qty = 99.9% of buyQty (fee 0.1% was already deducted from base at BUY time)
  const intendedQty = parseFloat(trade.buyQty) * (1 - FEE_RATE);

  // 3. take the smaller of free and intended, then round down to stepSize with safety buffer
  //    - if free is available, use min(free, intended) * 0.998 (0.2% safety for dust/orderbook noise)
  //    - if free fetch failed, fall back to intendedQty
  const targetRaw = freeQty != null
    ? Math.min(freeQty, intendedQty) * 0.998
    : intendedQty;
  const sellQty = roundQtyDown(targetRaw, info.lotSize.stepSize);

  if (sellQty <= 0 || sellQty < parseFloat(info.lotSize.minQty)) {
    log(`[skip] ${trade.symbol} sellQty=${sellQty} after rounding (free=${freeQty}, intended=${intendedQty.toFixed(4)}, stepSize=${info.lotSize.stepSize}, minQty=${info.lotSize.minQty})`);
    return null;
  }

  // 4. current market price
  let ticker;
  try {
    ticker = await binanceRest.getBookTicker(trade.symbol);
  } catch (err) {
    log(`       [bookTicker error] ${err.message} | status=${err.response?.status} | body=${JSON.stringify(err.response?.data || {}).slice(0, 300)}`);
    throw err;
  }
  const bid = parseFloat(ticker.bidPrice);
  const ask = parseFloat(ticker.askPrice);
  const midPrice = (bid + ask) / 2;
  const targetSellPrice = parseFloat(trade.targetSellPrice);

  // 5. choose MARKET vs LIMIT_MAKER
  const useMarket = midPrice >= targetSellPrice;
  const orderType = useMarket ? 'MARKET' : 'LIMIT_MAKER';
  const orderPrice = useMarket ? null : parseFloat(targetSellPrice.toFixed(info.pricePrecision || 8));

  log(`[plan] ${trade.symbol} trade=${tradeIdStr} bot=${bot.symbol}/${bot.timeframe}`);
  log(`       BUY: qty=${trade.buyQty} price=${trade.buyPrice}`);
  log(`       ${freeQty != null ? `Free Binance balance = ${freeQty}` : `Free balance (skipped — using buyQty × ${(1 - FEE_RATE)})`} ${info.baseAsset}`);
  log(`       Intended qty (buyQty × ${(1 - FEE_RATE)}) = ${intendedQty.toFixed(8)}`);
  log(`       stepSize=${info.lotSize.stepSize} minQty=${info.lotSize.minQty}`);
  log(`       Computed sellQty = ${sellQty} (rounded down from ${targetRaw.toFixed(8)})`);
  log(`       TP target = ${targetSellPrice} | current bid=${bid} ask=${ask} mid=${midPrice.toFixed(8)}`);
  log(`       Mode: ${orderType}${orderPrice ? ` @ ${orderPrice}` : ''}`);

  if (DRY_RUN) {
    log(`       [DRY-RUN] no order placed`);
    return { tradeId: tradeIdStr, symbol: trade.symbol, sellQty, midPrice, targetSellPrice, useMarket };
  }

  // 6. place order (use directSignedRequest to avoid binanceRest -1021 stale-offset issue)
  const clientOrderId = `fix-fee-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const orderParams = {
    symbol: trade.symbol,
    side: 'SELL',
    type: orderType,
    quantity: sellQty.toString(),
    newClientOrderId: clientOrderId,
  };
  if (orderType === 'LIMIT_MAKER') {
    orderParams.price = orderPrice.toString();
  }

  let orderResp;
  try {
    orderResp = await directSignedRequest('POST', '/api/v3/order', orderParams);
  } catch (err) {
    log(`[ERROR] ${trade.symbol} newOrder failed: ${err.message}`);
    // Try to parse Binance error JSON out of the error message
    let errJson;
    try { errJson = JSON.parse(err.message.split(':')[1] || '{}'); } catch (_) {}
    return { tradeId: tradeIdStr, error: errJson || err.message };
  }

  const sellOrderId = orderResp.orderId;
  const executedQty = parseFloat(orderResp.executedQty || sellQty);
  const sellPrice = parseFloat(orderResp.price) || orderPrice || targetSellPrice;

  // 7. atomic update — only if trade is still 'holding' to avoid races
  const upd = await Trade.updateOne(
    { _id: trade._id, state: 'holding' },
    {
      state: 'selling',
      sellOrderId,
      sellClientOrderId: clientOrderId,
      sellQty: executedQty,
      sellPrice,
      sellStatus: orderResp.status,
      sellPlacedAt: new Date(),
      targetSellPrice: parseFloat(targetSellPrice),
      error: null,
    }
  );

  if (upd.modifiedCount === 0) {
    log(`[WARN] ${trade.symbol} trade=${tradeIdStr} state changed before update — cancelling newly placed SELL ${sellOrderId}`);
    await binanceRest.cancelOrder({ symbol: trade.symbol, orderId: sellOrderId }).catch(() => null);
    return { tradeId: tradeIdStr, sellOrderId, status: 'cancelled-orphan' };
  }

  await Bot.updateOne({ _id: bot._id }, { status: 'selling', lastError: null });
  log(`[OK] ${trade.symbol} order=${sellOrderId} qty=${executedQty} type=${orderType}`);

  return {
    tradeId: tradeIdStr,
    symbol: trade.symbol,
    sellOrderId,
    sellQty: executedQty,
    sellPrice,
    mode: orderType,
  };
}

async function main() {
  await require('../src/db/connection').connect();
  log(`=== fix-stuck-fee-deduct-positions START mode=${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'} ===`);
  log(`Patched trades: ${STUCK_TRADE_IDS.length}`);

  const results = [];
  for (const tid of STUCK_TRADE_IDS) {
    try {
      const r = await fixOne(tid);
      results.push(r);
    } catch (err) {
      log(`[fatal] ${tid}: ${err.message}`);
      results.push({ tradeId: tid, error: err.message });
    }
  }

  log(`=== DONE ===`);
  log(`Summary: ${results.length} processed`);
  results.forEach((r) => {
    if (!r) return;
    if (r.error) log(`  - ${r.symbol || r.tradeId}: ERROR ${r.error.code || ''} ${r.error.msg || r.error}`);
    else if (r.status) log(`  - ${r.tradeId}: ${r.status}`);
    else if (r.useMarket !== undefined) log(`  - ${r.symbol}: would place ${r.useMarket ? 'MARKET' : 'LIMIT_MAKER'} qty=${r.sellQty}`);
    else log(`  - ${r.symbol}: sellOrderId=${r.sellOrderId} qty=${r.sellQty} type=${r.mode}`);
  });

  await mongoose.disconnect();
  logStream.end();
}

main().catch((err) => {
  console.error(err);
  logStream.end();
  process.exit(1);
});
