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
   * FIX 5: ตอนนี้จับ orphan ได้ทุก state (placed/filled/holding/cancelled/selling)
   * - BUY filled แต่ trade state ไม่ใช่ selling → handleBuyFilled
   * - BUY placed แต่ state stuck (cancelled/holding) + order FILLED → handleBuyFilled
   * - SELL placed + state=selling + order FILLED → handleSellFilled
   */
  async reconcilePendingTrades() {
    const pending = await Trade.find({
      state: { $in: ['placed', 'filled', 'holding', 'cancelled', 'selling'] },
    });

    for (const trade of pending) {
      try {
        const bot = await Bot.findById(trade.botId);
        if (!bot) continue;
        const Signal = require('../db/models/Signal');

        // ตรวจ BUY order (กรณี state=placed หรือ cancelled ที่ BUY อาจ fill จริง)
        if (trade.buyOrderId) {
          const order = await binanceRest.getOrder({
            symbol: trade.symbol,
            orderId: trade.buyOrderId,
          }).catch(() => null);
          if (order) {
            // BUY filled จริง — ไม่ว่า trade.state จะเป็นอะไร ต้อง proceed SELL
            if (order.status === 'FILLED' || order.status === 'PARTIALLY_FILLED') {
              // skip ถ้า trade เป็น selling/sold อยู่แล้ว (normal path)
              if (['selling', 'sold'].includes(trade.state)) {
                logger.debug({ tradeId: trade._id.toString(), dbState: trade.state }, 'reconcile: BUY filled, trade already in selling/sold — skip');
              } else {
                logger.warn({
                  tradeId: trade._id.toString(),
                  dbState: trade.state,
                  orderStatus: order.status,
                  botId: trade.botId.toString(),
                }, 'reconcile: ORPHAN detected — BUY filled but DB state stuck');

                const sig = trade.signalId ? await Signal.findById(trade.signalId).catch(() => null) : null;
                const trader = this.traders.get(bot._id.toString());
                if (trader) {
                  trader.currentTrade = trade;
                  await trader.handleBuyFilled(trade, order, sig);
                } else {
                  // ไม่มี trader (บอท disabled) → mark filled + ปล่อยให้ user/manual reconcile
                  logger.warn({
                    tradeId: trade._id.toString(),
                    botId: trade.botId.toString(),
                  }, 'reconcile: BUY filled but no live trader — DB updated to filled, manual SELL needed');
                  await Trade.updateOne(
                    { _id: trade._id },
                    {
                      state: 'filled',
                      buyStatus: order.status,
                      buyFilledAt: new Date(order.updateTime || Date.now()),
                      buyPrice: parseFloat(order.price) || parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty),
                      buyQty: parseFloat(order.executedQty),
                      buyQuoteQty: parseFloat(order.cummulativeQuoteQty),
                    }
                  );
                }
              }
            } else if ((order.status === 'CANCELED' || order.status === 'EXPIRED') && trade.state === 'placed') {
              // BUY ถูก cancel จริง — sync DB
              logger.info({ tradeId: trade._id.toString() }, 'reconcile: BUY cancelled/expired, marking DB');
              await Trade.updateOne({ _id: trade._id }, { state: 'cancelled', buyStatus: order.status });
            }
          }
        }

        // ตรวจ SELL order (กรณี state=selling หรือ holding ที่ SELL อาจ fill จริง)
        if (trade.sellOrderId) {
          const order = await binanceRest.getOrder({
            symbol: trade.symbol,
            orderId: trade.sellOrderId,
          }).catch(() => null);
          if (order) {
            if (order.status === 'FILLED' && trade.state !== 'sold') {
              logger.warn({
                tradeId: trade._id.toString(),
                dbState: trade.state,
                botId: trade.botId.toString(),
              }, 'reconcile: ORPHAN — SELL filled but DB state not sold');
              const trader = this.traders.get(bot._id.toString());
              if (trader) {
                trader.currentTrade = trade;
                await trader.handleSellFilled({
                  executedQty: order.executedQty,
                  avgPrice: order.price || order.avgPrice,
                  cumulativeQuoteQty: order.cummulativeQuoteQty,
                  ts: order.updateTime,
                }, trade);
              } else {
                // ไม่มี trader → mark sold + คำนวณ PnL inline
                const feeRate = require('../binance/fees').getMakerRate();
                const sellPrice = parseFloat(order.price || order.avgPrice) || (parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty));
                const pnl = require('../binance/fees').calcPnl({
                  buyPrice: trade.buyPrice,
                  sellPrice,
                  qty: parseFloat(order.executedQty),
                  feeRate,
                });
                await Trade.updateOne(
                  { _id: trade._id },
                  {
                    state: 'sold',
                    sellStatus: 'FILLED',
                    sellPrice,
                    sellQty: parseFloat(order.executedQty),
                    sellQuoteQty: parseFloat(order.cummulativeQuoteQty),
                    sellFilledAt: new Date(order.updateTime || Date.now()),
                    realizedPnl: pnl.net,
                    pnlPercent: pnl.pnlPercent,
                  }
                );
              }
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