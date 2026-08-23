'use strict';

/**
 * One-shot recovery for BONKUSDT orphan holding (2026-08-22).
 *
 * v2: smart balance-aware — uses forceCloseTrade which itself does:
 *   branch 1 freeQty > 0     → round qty to stepSize, MARKET SELL
 *   branch 2 lockedQty > 0    → cancelAllOpenOrders then re-check
 *   branch 3 freeQty==locked==0 → synthetic close (no SELL)
 *
 * Background:
 *   - BUY filled 2,795,031 BONK @ 0.00000320 (12:46 BKK) but SELL never placed
 *   - Holding retry exhausted (10/10)
 *   - Subsequent trader retry at 13:37 got -2010 (insufficient balance) → BONK
 *     may have been settled off (or never arrived on Binance)
 *   - Binance 418 IP ban escalating (now ~13 min wait)
 *
 * This script:
 *   1. Wait ONCE (one getServerTime) for ban to lift
 *   2. Query Binance account for actual BONK balance
 *   3. Call forceCloseBot — picks correct branch automatically
 *   4. Verify + audit report
 *
 * Reusable: pass --botId=<id> or --symbol=BONKUSDT
 *
 * Run:    node scripts/forceclose-orphan-2026-08-22-bonk.js
 *         FORCE_YES=1 node scripts/forceclose-orphan-2026-08-22-bonk.js
 */

const path = require('path');
const fs = require('fs');
const config = require('../config');
const db = require('../src/db/connection');
const logger = require('../src/utils/logger');
const br = require('../src/binance/binanceRest');
const forceClose = require('../src/core/forceClose');
const Bot = require('../src/db/models/Bot');
const Trade = require('../src/db/models/Trade');

const TARGET_SYMBOL = 'BONKUSDT';
// Read current rate-limit ban from binanceRest so we sync with the in-process limiter
const POLL_INTERVAL_MS = 30 * 1000;     // 30s — gentle on weight
const MAX_WAIT_MS = 20 * 60 * 1000;     // 20 min ceiling

function parseArgs() {
  const args = { symbol: TARGET_SYMBOL };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--botId=')) args.botId = a.split('=')[1];
    else if (a.startsWith('--symbol=')) args.symbol = a.split('=')[1].toUpperCase();
  }
  return args;
}

/**
 * Wait for rate-limit ban (in-process limiter + Binance 418) to clear.
 * Returns true if cleared, false if MAX_WAIT_MS exceeded.
 */
async function waitForBanToLift() {
  const deadline = Date.now() + MAX_WAIT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    // cheap: read limiter status without making API call
    const status = br.getRateLimitStatus();
    if (status.banUntilMs === 0 || status.banUntilMs <= Date.now()) {
      try {
        // br.getServerTime() returns the serverTime number directly (not {serverTime})
        const ts = await br.getServerTime();
        const ms = Number(ts);
        if (Number.isFinite(ms) && ms > 0) {
          logger.info({ attempt, serverTime: new Date(ms).toISOString() }, '✅ ban lifted — getServerTime OK');
          return true;
        }
        logger.warn({ attempt, ts }, 'waitForBanToLift: getServerTime returned non-finite (continuing)');
      } catch (err) {
        const m = err.message || '';
        if (/418/.test(m)) {
          // 418 sets banUntilMs in limiter; loop will wait for it
          logger.info({ attempt, err: m }, '⏳ 418 returned — limiter will set ban window');
        } else if (/429/.test(m)) {
          logger.info({ attempt, err: m }, '⏳ 429 — back off');
        } else {
          logger.info({ attempt, err: m }, '⏳ API error (continuing)');
        }
      }
    } else {
      const waitSec = Math.max(1, Math.round((status.banUntilMs - Date.now()) / 1000));
      logger.info({ attempt, waitSec, banUntilMs: status.banUntilMs }, '⏳ local ban in effect');
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  logger.error({ attempt }, 'waitForBanToLift: exceeded MAX_WAIT_MS');
  return false;
}

async function main() {
  const args = parseArgs();
  logger.warn({ args }, 'forceclose-orphan-2026-08-22-bonk (v2): starting');

  await db.connect();

  const botQuery = args.botId ? { _id: args.botId } : { symbol: args.symbol };
  const bot = await Bot.findOne(botQuery).catch(() => null);
  if (!bot) {
    logger.error({ botQuery }, 'bot not found');
    await db.disconnect();
    process.exit(2);
  }
  logger.info({
    botId: bot._id.toString(),
    symbol: bot.symbol,
    enabled: bot.enabled,
    status: bot.status,
  }, 'bot located');

  const orphans = await Trade.find({
    botId: bot._id,
    state: { $in: forceClose.FORCE_OPEN_STATES },
  }).lean();
  if (!orphans.length) {
    logger.warn({ botId: bot._id.toString() }, 'no orphan trades — nothing to force-close');
    await db.disconnect();
    process.exit(0);
  }
  logger.warn({
    botId: bot._id.toString(),
    count: orphans.length,
    trades: orphans.map((t) => ({
      _id: t._id.toString(),
      state: t.state,
      buyQty: t.buyQty,
      buyPrice: t.buyPrice,
      buyFilledAt: t.buyFilledAt,
      error: t.error,
      holdingRetryCount: t.holdingRetryCount,
    })),
  }, 'orphan trades located');

  if (process.env.FORCE_YES !== '1') {
    const readline = require('readline');
    const ans = await new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`\nพิมพ์ YES เพื่อ force-close ${orphans.length} orphan trade(s) of ${bot.symbol}: `, (a) => {
        rl.close();
        resolve((a || '').trim());
      });
    });
    if (ans !== 'YES') {
      logger.warn('user cancelled');
      await db.disconnect();
      process.exit(0);
    }
  }

  // 1. Wait for ban to lift
  const ok = await waitForBanToLift();
  if (!ok) {
    logger.error('ban did not lift in time — aborting');
    await db.disconnect();
    process.exit(3);
  }

  // 2. Pre-check actual Binance balance (1 signed call, weight 20)
  let preBalance = null;
  try {
    const acc = await br.getAccount();
    const base = bot.symbol.replace(/USDT$|USDC$|BUSD$/, '');
    const bal = (acc.balances || []).find((b) => b.asset === base);
    preBalance = bal ? { base, free: parseFloat(bal.free), locked: parseFloat(bal.locked) } : { base, free: 0, locked: 0 };
    logger.info(preBalance, 'Binance balance snapshot');
  } catch (err) {
    logger.warn({ err: err.message }, 'balance snapshot failed (will rely on forceCloseTrade to check)');
  }

  // 3. forceCloseBot — does its own balance check via resolveBaseAsset,
  //    so the right branch runs automatically:
  //      freeQty > 0         → round + MARKET SELL
  //      freeQty == locked==0 → synthetic close
  const result = await forceClose.forceCloseBot({
    botId: bot._id,
    allowMarketSell: true,   // allow MARKET if freeQty > 0
    disableBot: false,       // keep enabled so bot can resume after
    source: 'cleanup_script',
  });

  logger.warn({
    closedTrades: result.closedTrades,
    errors: result.errors,
    disabled: result.disabled,
  }, 'forceCloseBot: done');

  // 4. Audit report
  const report = {
    script: 'forceclose-orphan-2026-08-22-bonk (v2)',
    timestamp: new Date().toISOString(),
    botId: bot._id.toString(),
    symbol: bot.symbol,
    preBalance,
    orphanCount: orphans.length,
    closedTrades: result.closedTrades,
    errors: result.errors,
    disabled: result.disabled,
  };
  const logsDir = path.join(__dirname, '..', 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) { /* ignore */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const reportPath = path.join(logsDir, `forceclose-orphan-${stamp}.json`);
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    logger.info({ reportPath }, 'audit report written');
  } catch (err) {
    logger.warn({ err: err.message }, 'could not write audit report');
  }

  await db.disconnect();
  process.exit(result.errors.length ? 4 : 0);
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'FATAL');
  process.exit(1);
});
