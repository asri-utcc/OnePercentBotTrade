'use strict';

const binanceRest = require('../binance/binanceRest');
const { marketWs, userDataWs } = require('../binance/binanceWs');
const symbolInfo = require('../binance/symbolInfo');
const klineCache = require('../services/klineCache');
const eventBus = require('../services/eventBus');
const logger = require('../utils/logger');
const Bot = require('../db/models/Bot');
const Trade = require('../db/models/Trade');
const Trader = require('./trader');

/**
 * Bot Manager — spawn/stop Trader ต่อ bot, จัดการ WS subscriptions
 * + seed klineCache ด้วย historical data ตอนเริ่ม
 */
class BotManager {
  constructor() {
    this.traders = new Map(); // botId -> Trader
    this.running = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    logger.info('botManager start');

    // Start market WS
    marketWs.start();

    // Start user data stream (ถ้ามี keys)
    await userDataWs.start();

    // Load all enabled bots
    const bots = await Bot.find({ enabled: true });
    for (const bot of bots) {
      try {
        await this.spawnTrader(bot);
      } catch (err) {
        logger.error({ err: err.message, botId: bot._id.toString() }, 'botManager: spawn failed');
      }
    }

    // Reconciliation: เช็ค Trade ที่ค้างจาก crash ก่อนหน้า
    await this.reconcilePendingTrades();
  }

  async stop() {
    this.running = false;
    for (const [id, trader] of this.traders.entries()) {
      try { await trader.stop(); } catch (e) { /* ignore */ }
    }
    this.traders.clear();
    marketWs.stop();
    await userDataWs.stop();
    logger.info('botManager stopped');
  }

  async spawnTrader(bot) {
    if (this.traders.has(bot._id.toString())) {
      logger.warn({ botId: bot._id.toString() }, 'trader already running');
      return;
    }

    // Load symbol info
    try {
      await symbolInfo.loadSymbol(bot.symbol);
    } catch (err) {
      logger.warn({ botId: bot._id.toString(), err: err.message }, 'symbol info load failed');
    }

    // Seed klineCache
    await this.seedKlines(bot);

    // Subscribe WS
    marketWs.subscribeMarket(bot.symbol, bot.timeframe);

    // Start trader
    const trader = new Trader(bot);
    trader.start();
    this.traders.set(bot._id.toString(), trader);

    logger.info({ botId: bot._id.toString(), symbol: bot.symbol, tf: bot.timeframe }, 'trader spawned');
  }

  async stopTrader(botId) {
    const id = botId.toString();
    const trader = this.traders.get(id);
    if (!trader) return;

    await trader.stop();
    this.traders.delete(id);

    // หา symbol/tf ของ bot นี้
    const bot = await Bot.findById(botId).catch(() => null);
    if (bot) {
      // ดูว่ายังมี bot อื่นที่ใช้ symbol/tf นี้อยู่ไหม
      const otherBot = await Bot.findOne({
        _id: { $ne: botId },
        symbol: bot.symbol,
        timeframe: bot.timeframe,
        enabled: true,
      });
      if (!otherBot) {
        marketWs.unsubscribeMarket(bot.symbol, bot.timeframe);
      }
    }
    logger.info({ botId: id }, 'trader stopped');
  }

  async seedKlines(bot) {
    if (klineCache.size(bot.symbol, bot.timeframe) >= 100) return; // มีข้อมูลพอแล้ว

    try {
      const klines = await binanceRest.getKlines({
        symbol: bot.symbol,
        interval: bot.timeframe,
        limit: 200,
      });

      const candles = klines.map((k) => {
        const [openTime, open, high, low, close, volume, closeTime] = k;
        return {
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          openTime,
          open: parseFloat(open),
          high: parseFloat(high),
          low: parseFloat(low),
          close: parseFloat(close),
          volume: parseFloat(volume),
          closeTime,
          isClosed: true,
        };
      });
      klineCache.seed(candles);
      logger.info({ symbol: bot.symbol, tf: bot.timeframe, count: candles.length }, 'klines seeded');
    } catch (err) {
      logger.error({ err: err.message }, 'klines seed failed');
    }
  }

  /**
   * Reconcile pending trades จาก crash ก่อนหน้า
   */
  async reconcilePendingTrades() {
    const pending = await Trade.find({
      state: { $in: ['placed', 'filled', 'selling'] },
    });

    for (const trade of pending) {
      try {
        const bot = await Bot.findById(trade.botId);
        if (!bot) continue;

        // ตรวจ BUY order
        if (trade.buyOrderId && ['placed'].includes(trade.state)) {
          const order = await binanceRest.getOrder({
            symbol: trade.symbol,
            orderId: trade.buyOrderId,
          }).catch(() => null);
          if (order) {
            if (order.status === 'FILLED' || order.status === 'PARTIALLY_FILLED') {
              logger.info({ tradeId: trade._id.toString() }, 'reconcile: BUY filled but missed');
              // ปล่อยให้ user แก้เอง หรือจะ trigger handleBuyFilled ก็ได้
              // ที่นี่เราจะ mark เป็น filled และพยายามวาง SELL
              const sig = await require('../db/models/Signal').findById(trade.signalId);
              if (sig) {
                const trader = this.traders.get(bot._id.toString());
                if (trader) {
                  trader.currentTrade = trade;
                  await trader.handleBuyFilled(trade, order, sig);
                }
              }
            } else if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
              await Trade.updateOne({ _id: trade._id }, { state: 'cancelled', buyStatus: order.status });
            }
          }
        }

        // ตรวจ SELL order
        if (trade.sellOrderId && trade.state === 'selling') {
          const order = await binanceRest.getOrder({
            symbol: trade.symbol,
            orderId: trade.sellOrderId,
          }).catch(() => null);
          if (order && order.status === 'FILLED') {
            logger.info({ tradeId: trade._id.toString() }, 'reconcile: SELL filled but missed');
            const trader = this.traders.get(bot._id.toString());
            if (trader) {
              trader.currentTrade = trade;
              await trader.handleSellFilled({
                executedQty: order.executedQty,
                avgPrice: order.price,
                cumulativeQuoteQty: order.cummulativeQuoteQty,
                ts: order.updateTime,
              });
            }
          }
        }
      } catch (err) {
        logger.error({ err: err.message, tradeId: trade._id.toString() }, 'reconcile error');
      }
    }
  }

  // ─── Lifecycle handlers (called from API) ──────────
  async enableBot(botId) {
    const bot = await Bot.findById(botId);
    if (!bot) throw new Error('Bot not found');
    bot.enabled = true;
    bot.enabledAt = new Date();
    bot.status = 'idle';
    await bot.save();
    await this.spawnTrader(bot);
    eventBus.emit('bot:updated', { botId });
    return bot;
  }

  async disableBot(botId) {
    const bot = await Bot.findById(botId);
    if (!bot) throw new Error('Bot not found');
    bot.enabled = false;
    bot.enabledAt = null;
    bot.status = 'idle';
    await bot.save();
    await this.stopTrader(botId);
    eventBus.emit('bot:updated', { botId });
    return bot;
  }
}

module.exports = new BotManager();