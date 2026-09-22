'use strict';
const fs = require('fs');
const path = require('path');
const envContent = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/onepercentbottrade';
const mongoose = require('mongoose');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const tradeId = '6aae4d5eaa1d23232da13097';
  const botId = '6a9feb931385620104b53b3d';

  console.log('=== Current Trade state in DB ===');
  const trade = await Trade.findById(tradeId).lean();
  console.log(JSON.stringify(trade, null, 2));

  console.log('\n=== Current Bot state in DB ===');
  const bot = await Bot.findById(botId).lean();
  // Print only relevant fields
  console.log(JSON.stringify({
    _id: bot._id,
    name: bot.name,
    symbol: bot.symbol,
    status: bot.status,
    enabled: bot.enabled,
    enabledAt: bot.enabledAt,
    disabledAt: bot.disabledAt,
    autoPauseReason: bot.autoPauseReason,
    totalPnl: bot.totalPnl,
    totalTrades: bot.totalTrades,
    winTrades: bot.winTrades,
    lossTrades: bot.lossTrades,
    lastError: bot.lastError,
    activeTrades: bot.activeTrades,
  }, null, 2));

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
