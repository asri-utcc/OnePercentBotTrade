'use strict';

// FIX-2026-08-01: manual cleanup for SNXXB trade 6a6d0d4daad13eff82c7dce7
//   - BUY 1.11 SNXXB → SELL 0.73 @ 9.34 (FILLED) → SELL 0.38 partial-fill (stuck, MIN_LOT precision)
//   - Cancel/replace เกิดก่อน FREEZE policy deploy → trade stuck ใน 'holding' + holding retry loop
//   - Manual intervention: mark 0.73 sold + track 0.38 SNXXB dust เป็น manual_cleanup

require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const TRADE_ID = '6a6d0d4daad13eff82c7dce7';
  const BOT_ID = '6a6a36d122c0a989e674d796';

  const trade = await Trade.findById(TRADE_ID);
  if (!trade) {
    console.error('Trade not found');
    process.exit(1);
  }
  console.log('Current state:', trade.state, 'sellStatus:', trade.sellStatus);
  console.log('sellFilledQty:', trade.sellFilledQty, 'sellAvgPrice:', trade.sellAvgPrice);

  // Confirm before writing
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(`Mark TRADE ${TRADE_ID} as 'sold' (FORCED_LOT_BELOW_MIN, 0.73 sold @ 9.34, 0.38 SNXXB dust)? [y/N]: `, resolve);
  });
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Cancelled');
    process.exit(0);
  }

  const result = await Trade.updateOne(
    { _id: TRADE_ID },
    {
      $set: {
        state: 'sold',
        sellStatus: 'FORCED_LOT_BELOW_MIN',
        sellQty: 0.73,
        sellPrice: 9.34,
        sellFilledQty: 0.73,
        sellAvgPrice: 9.34,
        sellCumulativeQuoteQty: 6.8182,
        sellFilledAt: new Date(),
        sellFreezeReason: 'manual_cleanup_2026-08-01',
        sellFreezeAt: new Date(),
        error: '0.38 SNXXB dust — cannot be sold (MIN_LOT precision). Manual cleanup. PnL partial: 0.73 sold @ 9.34, 0.38 SNXXB stuck on Binance.',
        lastError: 'manual_cleanup: 0.38 SNXXB below MIN_LOT',
        realizedPnl: (9.34 - 9.30) * 0.73, // 0.0292 USDT
      },
    }
  );
  console.log('Trade updated:', result.modifiedCount);

  await Bot.updateOne(
    { _id: BOT_ID },
    { $set: { status: 'idle', lastError: '' } }
  );
  console.log('Bot -> idle');

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
