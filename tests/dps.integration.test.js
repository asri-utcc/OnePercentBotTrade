'use strict';
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const mongoose = require('mongoose');
const Bot = require('../src/db/models/Bot');
const Trade = require('../src/db/models/Trade');

// Spy logger BEFORE requiring Trader
const logger = require('../src/utils/logger');
const origInfo = logger.info.bind(logger);
const messages = [];
logger.info = function(...args) {
  if (args.length >= 2 && typeof args[1] === 'string') {
    messages.push(args[1]);
  }
  return origInfo.apply(logger, args);
};

const Trader = require('../src/core/trader');

describe('DPS integration — handleSellFilled triggers DPS', () => {
  beforeAll(async () => {
    await mongoose.connect('mongodb://127.0.0.1:27017/onepercentbottrade');
  });
  afterAll(async () => {
    logger.info = origInfo;
    await mongoose.disconnect();
  });

  test('handleSellFilled routes through DPS block without throwing', async () => {
    const recent = await Trade.findOne({ state: 'sold', pnlPercent: { $gt: 0.5 } })
      .sort({ updatedAt: -1 }).lean();
    expect(recent).toBeTruthy();
    const bot = await Bot.findById(recent.botId).lean();
    expect(bot).toBeTruthy();

    const trader = Object.create(Trader.prototype);
    trader.bot = { ...bot, _id: bot._id };
    trader.running = true;
    trader.currentTrade = recent;
    trader.eventBus = { emit: () => {} };
    trader._unregisterTrade = () => {};
    trader._deriveSellReasonFromPriorState = () => null;
    trader._computeSlippage = () => {};

    messages.length = 0;
    await trader.handleSellFilled({
      orderId: '999999999',
      executedQty: recent.sellQty,
      avgPrice: recent.sellPrice,
      cumulativeQuoteQty: (recent.sellQty * recent.sellPrice).toString(),
      ts: Date.now(),
    }, recent);

    const enteredIdx = messages.findIndex(m => m.includes('handleSellFilled entered'));
    const afterCloseIdx = messages.findIndex(m => m.includes('dpsAfterClose: size/layers updated'));
    const skippedIdx = messages.findIndex(m => m.includes('dpsAfterClose: skipped') || m.includes('DPS — skipped'));
    console.log('DEBUG messages count:', messages.length);
    console.log('  handleSellFilled entered at index:', enteredIdx);
    console.log('  dpsAfterClose: size/layers updated at index:', afterCloseIdx);
    console.log('  dpsAfterClose: skipped at index:', skippedIdx);
    console.log('  All DPS-related messages:', messages.filter(m => m.includes('DPS') || m.includes('dpsAfterClose') || m.includes('handleSellFilled') || m.includes('round complete') || m.includes('SELL FILLED')));
  }, 30000);
});