'use strict';

// Integration test: ใช้ mongodb-memory-server + run backtest จริง
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

(async () => {
  const mem = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mem.getUri();
  process.env.SESSION_SECRET = 'test-session-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  process.env.ENCRYPTION_KEY = 'test-encryption-key-aaaaaaaaaaaaaaaaaaaaaa';

  const config = require('../config');
  const db = require('../src/db/connection');
  const backtester = require('../src/core/backtester');
  const logger = require('../src/utils/logger');

  try {
    await db.connect();

    // ทดสอบ backtest จริง — BNBUSDT 5m 7 วันย้อนหลัง
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

    console.log('=== Running real backtest ===');
    console.log(`Symbol: BNBUSDT, Timeframe: 5m`);
    console.log(`From: ${from.toISOString()} To: ${to.toISOString()}`);

    const result = await backtester.runBacktest({
      symbol: 'BNBUSDT',
      timeframe: '5m',
      from: from.getTime(),
      to: to.getTime(),
      tpPercent: 0.1,
      capitalPerTrade: 10,
      useBnbForFees: false,
      maxCandlesToSell: 100,
    });

    console.log('\n=== Result ===');
    console.log('Signals detected:', result.signals.length);
    console.log('Trades simulated:', result.trades.length);
    console.log('Win count:', result.stats.winCount);
    console.log('Loss count:', result.stats.lossCount);
    console.log('Win rate:', result.stats.winRate.toFixed(2) + '%');
    console.log('Total PnL:', result.stats.totalPnl.toFixed(4), 'USDT');
    console.log('Total PnL %:', result.stats.totalPnlPercent.toFixed(2) + '%');
    console.log('Max drawdown:', result.stats.maxDrawdown.toFixed(4), 'USDT');
    console.log('Max drawdown %:', result.stats.maxDrawdownPercent.toFixed(2) + '%');

    if (result.trades.length > 0) {
      console.log('\n=== Sample trades (first 5) ===');
      for (const t of result.trades.slice(0, 5)) {
        console.log(`Signal: ${new Date(t.signalTime).toISOString()}`);
        console.log(`  Buy: ${t.buyPrice.toFixed(4)} → Target: ${t.targetSellPrice.toFixed(4)} → Sell: ${t.sellPrice ? t.sellPrice.toFixed(4) : 'NOT FILLED'}`);
        console.log(`  PnL: ${t.realizedPnl.toFixed(4)} USDT (${t.pnlPercent.toFixed(2)}%)`);
      }
    }

    await db.disconnect();
    await mem.stop();
    console.log('\n✅ Backtest completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed:', err.message);
    console.error(err.stack);
    await mem.stop().catch(() => {});
    process.exit(1);
  }
})();