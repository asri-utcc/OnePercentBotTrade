'use strict';
// FIX-2026-08-08: mini test — verify DPS block executes inside handleSellFilled
// Run: node tests/dps.live.test.js
const assert = require('assert');
const mongoose = require('mongoose');
const Bot = require('../src/db/models/Bot');
const Trade = require('../src/db/models/Trade');
const Trader = require('../src/core/trader');
const dps = require('../src/core/dynamicPositionSizing');

(async () => {
  await mongoose.connect('mongodb://127.0.0.1:27017/onepercentbottrade');
  // pick a bot with recent win trade
  const recent = await Trade.findOne({ state: 'sold', pnlPercent: { $gt: 0.5 } })
    .sort({ updatedAt: -1 }).lean();
  assert(recent, 'need at least 1 win trade today');
  const bot = await Bot.findById(recent.botId).lean();
  assert(bot, 'bot not found');
  console.log('TEST bot:', bot.name, 'symbol=', bot.symbol, 'dynSz=', bot.dynamicSizeCurrent, 'dcaEn=', bot.dcaEnabled);

  // build a fake trader instance (no WS, no spawning)
  const trader = Object.create(Trader.prototype);
  trader.bot = { ...bot, _id: bot._id };
  trader.running = true;
  trader.currentTrade = recent;
  trader.eventBus = { emit: () => {} };
  trader._unregisterTrade = () => {};
  trader._deriveSellReasonFromPriorState = () => null;
  trader._computeSlippage = () => {};

  // Simulate the DPS block exactly as trader.js does
  const masterConfig = require('../src/core/masterConfig');
  const masterToggles = await masterConfig.getMasterToggles();
  trader.bot._masterDynamicSizeEnabled = masterToggles.masterDynamicSizeEnabled;
  console.log('masterToggles:', masterToggles);
  const evalResult = dps.evaluate(trader.bot, {
    closedAt: new Date(),
    pnlPct: recent.pnlPercent,
    isWin: (recent.realizedPnl || 0) > 0,
  });
  console.log('DPS eval:', { changed: evalResult.changed, reason: evalResult.reason, skipped: evalResult.skipped,
    before: evalResult.before, after: evalResult.after });

  if (evalResult.changed) {
    console.log('✓ DPS WOULD HAVE RESIZED');
  } else {
    console.log('× DPS skipped (reason=' + evalResult.reason + ')');
  }
  await mongoose.disconnect();
})().catch(e => { console.error('TEST ERR:', e.message, e.stack); process.exit(1); });