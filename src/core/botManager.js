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
// FIX-2026-07-23: TP auto-updater (per-bot autoUpdateTp toggle → top-of-hour recompute)
const tpUpdater = require('./tpUpdater');

// FIX-2026-07-14: periodic reconcile interval (ms) — safety net กัน WS event หลุด
//   2 นาที ตามที่ user ระบุ (1–3 นาที) — เร็วพอที่จะจับ SELL filled ภายใน 2 นาที,
//   ช้าพอที่จะไม่ spam Binance API
const RECONCILE_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Bot Manager — spawn/stop Trader ต่อ bot, จัดการ WS subscriptions
 * + seed klineCache ด้วย historical data ตอนเริ่ม
 */
class BotManager {
  constructor() {
    this.traders = new Map(); // botId -> Trader
    this.running = false;
    // FIX-2026-07-14: periodic reconciliation timer (safety net for missed WS updates)
    //   reconcilePendingTrades() เดิมรันแค่ครั้งเดียวตอน startup — ถ้า WS event หลุดระหว่าง runtime
    //   (listenkey expired, network blip, race กับ idempotent guard) จะมี position ที่ SELL fill แล้วบน Binance
    //   แต่ trade.state ยัง stuck ที่ 'selling' ใน DB → ระบบค้าง
    //   fix: ยิง reconcilePendingTrades() ทุก RECONCILE_INTERVAL_MS (default 2 นาที)
    this.reconcileTimer = null;
    this.reconcileInFlight = false; // guard กัน overlap ถ้า reconcile รอบก่อนยังไม่จบ
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

    // ซ่อม Bot totals (totalPnl/totalTrades/winTrades) ให้ตรงกับ Trade collection
    // (กัน drift จาก read-modify-write race ที่เคยทำให้ totalTrades ตกหล่น)
    await this.recomputeBotStats();

    // FIX-2026-07-14: schedule periodic reconcile (safety net)
    //   - ห่าง RECONCILE_INTERVAL_MS (default 2 นาที) — กัน WS event หลุดระหว่าง runtime
    //   - clearInterval ตอน stop()
    //   - guard reconcileInFlight กัน overlap กรณี reconcile นาน (เช่น reconcile 50 trades)
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = setInterval(() => {
      if (!this.running || this.reconcileInFlight) return;
      this.reconcileInFlight = true;
      this.reconcilePendingTrades()
        .catch((err) => logger.error({ err: err.message }, 'botManager: periodic reconcile failed'))
        .finally(() => { this.reconcileInFlight = false; });
    }, RECONCILE_INTERVAL_MS);
    logger.info({ intervalMs: RECONCILE_INTERVAL_MS }, 'botManager: periodic reconcile scheduled');

    // FIX-2026-07-23: schedule TP auto-updater (recompute TP% top-of-hour สำหรับบอทที่ autoUpdateTp=true)
    tpUpdater.scheduleHourlyTpUpdate();

    // FIX-2026-07-24: start Telegram notifier (subscribe eventBus + periodic PnL scan)
    const telegramNotifier = require('../services/telegramNotifier');
    telegramNotifier.start().catch((e) => logger.warn({ err: e.message }, 'telegramNotifier start failed'));

    // FIX-2026-07-14: sync Binance server time on startup (กัน -1021 timestamp drift)
    binanceRest.refreshServerTimeOffset()
      .then((offsetMs) => logger.info({ offsetMs }, 'botManager: initial Binance time-sync done'))
      .catch((err) => logger.warn({ err: err.message }, 'botManager: initial Binance time-sync failed'));
  }

  async stop() {
    this.running = false;
    // FIX-2026-07-14: clear periodic reconcile timer ด้วย
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    // FIX-2026-07-23: หยุด TP auto-updater timer
    tpUpdater.stopHourlyTpUpdate();
    // FIX-2026-07-24: หยุด Telegram notifier (clear listeners + timers)
    try { require('../services/telegramNotifier').stop(); } catch (e) { /* ignore */ }
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
            } else if (order.status === 'NEW' && trade.state === 'placed') {
              // FIX: BUY ค้างที่ state=placed นานเกิน retry budget → cancel + sync DB
              // (กันเคสที่ bot restart ระหว่างรอ retry → in-memory retry state หาย
              //  → BUY order ค้างบน Binance แบบไม่มีใครดูแล)
              // เกณฑ์: retryTimeMin × (retryMax + 1) นาที — ตามสเปคที่ user กำหนด
              //         "wait 1 min, retry 1 min, if still no fill → cancel ไม่เทรดรอบนั้น"
              const retryBudgetMs = (bot.retryTimeMin || 1) * 60 * 1000 * ((bot.retryMax || 1) + 1);
              const placedAt = trade.buyPlacedAt ? new Date(trade.buyPlacedAt).getTime() : 0;
              const ageMs = placedAt ? Date.now() - placedAt : Infinity;
              if (ageMs > retryBudgetMs) {
                logger.warn({
                  tradeId: trade._id.toString(),
                  orderId: trade.buyOrderId,
                  ageMs,
                  retryBudgetMs,
                  botId: trade.botId.toString(),
                }, 'reconcile: stuck BUY beyond retry budget — cancelling');
                let cancelResp;
                try {
                  cancelResp = await binanceRest.cancelOrder({
                    symbol: trade.symbol,
                    orderId: trade.buyOrderId,
                  });
                } catch (err) {
                  const ferr = binanceRest.formatBinanceError(err);
                  if (ferr && ferr.code === -2011) {
                    // already gone — sync DB ตามสถานะจริง (NEW/CANCELED) แล้วปล่อยผ่าน
                    logger.info({ tradeId: trade._id.toString() }, 'reconcile: stuck BUY already gone (-2011), marking cancelled');
                    await Trade.updateOne({ _id: trade._id }, { state: 'cancelled', buyStatus: 'CANCELED' });
                    // FIX: เคลียร์ bot.status + trader.currentTrade ด้วยเหมือนกรณี cancel สำเร็จ
                    await Bot.updateOne(
                      { _id: trade.botId, status: { $in: ['waiting_fill', 'holding', 'selling', 'error'] } },
                      { $set: { status: 'idle', lastError: null } }
                    );
                    const traderAfter = this.traders.get(bot._id.toString());
                    if (traderAfter && traderAfter.currentTrade && traderAfter.currentTrade._id.toString() === trade._id.toString()) {
                      traderAfter._unregisterTrade(trade);
                      traderAfter.currentTrade = null;
                      eventBus.emit('bot:status', { botId: bot._id, status: 'idle' });
                      logger.info({ botId: bot._id.toString(), tradeId: trade._id.toString() }, 'reconcile: cleared trader.currentTrade after stuck BUY already gone (-2011)');
                    }
                  } else {
                    logger.error({
                      tradeId: trade._id.toString(),
                      code: ferr && ferr.code,
                      msg: ferr && ferr.msg,
                    }, 'reconcile: stuck BUY cancel failed — will retry next reconcile cycle');
                  }
                  // ไม่ mark DB ทิ้ง — ให้ reconcile รอบหน้าลองใหม่
                  return;
                }
                logger.info({
                  tradeId: trade._id.toString(),
                  orderId: trade.buyOrderId,
                  status: cancelResp.status,
                }, 'reconcile: stuck BUY cancelled — marking DB cancelled');
                await Trade.updateOne({
                  _id: trade._id,
                }, {
                  state: 'cancelled',
                  buyStatus: cancelResp.status || 'CANCELED',
                });
                // FIX: รีเซ็ต bot.status กลับเป็น idle + clear currentTrade ของ trader (ถ้ามี)
                // (ถ้าไม่เคลียร์ บอทจะติด 'waiting_fill' และ skip signal ใหม่ทุกตัว — เคสนี้เคยเกิด 21:09 / 21:21)
                await Bot.updateOne(
                  { _id: trade.botId, status: { $in: ['waiting_fill', 'holding', 'selling', 'error'] } },
                  { $set: { status: 'idle', lastError: null } }
                );
                const traderAfter = this.traders.get(bot._id.toString());
                if (traderAfter && traderAfter.currentTrade && traderAfter.currentTrade._id.toString() === trade._id.toString()) {
                  traderAfter._unregisterTrade(trade);
                  traderAfter.currentTrade = null;
                  eventBus.emit('bot:status', { botId: bot._id, status: 'idle' });
                  logger.info({ botId: bot._id.toString(), tradeId: trade._id.toString() }, 'reconcile: cleared trader.currentTrade after stuck BUY cancel');
                }
              }
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
                // ไม่มี trader → mark sold + คำนวณ PnL inline + อัปเดต Bot totals
                // (FIX: ก่อนหน้านี้ลืมอัปเดต Bot → totalTrades ตกหล่นทำให้ todayTrades > totalTrades)
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
                // FIX: อัปเดต Bot totals ด้วย $inc (กัน lost update)
                await Bot.updateOne(
                  { _id: trade.botId },
                  {
                    $inc: {
                      totalPnl: pnl.net,
                      totalTrades: 1,
                      winTrades: (pnl.net > 0 ? 1 : 0),
                    },
                  }
                );
              }
            } else if ((order.status === 'CANCELED' || order.status === 'EXPIRED') && trade.state !== 'cancelled') {
              // FIX: SELL ถูก cancel/expire (เช่น manual cancel หรือ TTL) แต่ DB state ยังเป็น selling
              // เคยเกิด: cancel แล้ว trade stuck ที่ selling → scheduleHoldingRetry loop forever
              // → แก้โดย sync state กลับเป็น holding + เคลียร์ sellOrderId → ให้ trader re-place
              logger.warn({
                tradeId: trade._id.toString(),
                dbState: trade.state,
                sellOrderId: trade.sellOrderId,
                orderStatus: order.status,
                botId: trade.botId.toString(),
              }, 'reconcile: ORPHAN — SELL cancelled/expired but DB state still selling, reverting to holding');
              await Trade.updateOne(
                { _id: trade._id, state: { $in: ['selling', 'placed', 'filled'] } },
                {
                  state: 'holding',
                  sellStatus: order.status,
                  $unset: { sellOrderId: '', sellClientOrderId: '' },
                }
              );
              // ถ้ามี trader live ให้ sync currentTrade + trigger holding retry
              const trader = this.traders.get(bot._id.toString());
              if (trader) {
                const fresh = await Trade.findById(trade._id);
                if (fresh) {
                  trader.currentTrade = fresh;
                  logger.info({
                    tradeId: fresh._id.toString(),
                    botId: bot._id.toString(),
                  }, 'reconcile: re-armed holding retry after SELL cancel detected');
                  trader.scheduleHoldingRetry(fresh, fresh.buyQty, fresh.buyPrice, fresh.targetSellPrice);
                }
              }
            } else if (order.status === 'NEW' && trade.state === 'selling') {
              // FIX: SELL ยังมีชีวิตอยู่ — ไม่ต้องทำอะไร
              // (เคยมี bug: restart แล้ว reconcile วนซ้ำหรือไป trigger handleSellFilled ซ้ำ)
              // แค่ log debug เพื่อ visibility
              logger.debug({
                tradeId: trade._id.toString(),
                sellOrderId: trade.sellOrderId,
              }, 'reconcile: SELL still NEW on book, trade in selling state — skip');
            }
          }
        }
      } catch (err) {
        logger.error({ err: err.message, tradeId: trade._id.toString() }, 'reconcile error');
      }
    }
  }

  /**
   * Recompute Bot totals (totalPnl/totalTrades/winTrades) from Trade collection.
   * ใช้ตอน startup เพื่อซ่อมค่าที่ตกหล่นจาก read-modify-write race ก่อนหน้านี้
   * (idempotent — รันกี่ครั้งก็ได้ผลเดิม)
   */
  async recomputeBotStats() {
    try {
      const bots = await Bot.find().lean();
      for (const bot of bots) {
        const stats = await Trade.aggregate([
          {
            $match: {
              botId: bot._id,
              state: 'sold',
              realizedPnl: { $ne: null },
            },
          },
          {
            $group: {
              _id: null,
              totalPnl: { $sum: '$realizedPnl' },
              totalTrades: { $sum: 1 },
              winTrades: { $sum: { $cond: [{ $gt: ['$realizedPnl', 0] }, 1, 0] } },
            },
          },
        ]);
        const s = stats[0] || { totalPnl: 0, totalTrades: 0, winTrades: 0 };
        // ใช้ $set แทน (overwrite) เพราะ aggregate เป็น source of truth
        await Bot.updateOne(
          { _id: bot._id },
          {
            $set: {
              totalPnl: s.totalPnl,
              totalTrades: s.totalTrades,
              winTrades: s.winTrades,
            },
          }
        );
        if (s.totalTrades !== (bot.totalTrades || 0)) {
          logger.warn({
            botId: bot._id.toString(),
            symbol: bot.symbol,
            old: { totalPnl: bot.totalPnl, totalTrades: bot.totalTrades, winTrades: bot.winTrades },
            new: { totalPnl: s.totalPnl, totalTrades: s.totalTrades, winTrades: s.winTrades },
          }, 'botManager: recomputed bot totals (fixed drift from lost updates)');
        }
      }
    } catch (err) {
      logger.error({ err: err.message }, 'botManager: recomputeBotStats failed');
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
    // FIX-2026-07-24: action-specific event สำหรับ Telegram notifier (bot:updated payload ไม่มี verb)
    eventBus.emit('bot:enabled', { botId });
    return bot;
  }

  async disableBot(botId) {
    const bot = await Bot.findById(botId);
    if (!bot) throw new Error('Bot not found');
    // สะสมเวลา enabled รอบนี้เข้า totalActiveMs ก่อนเคลียร์ enabledAt
    if (bot.enabledAt) {
      const sessionMs = Date.now() - new Date(bot.enabledAt).getTime();
      if (sessionMs > 0) bot.totalActiveMs = (bot.totalActiveMs || 0) + sessionMs;
    }
    bot.enabled = false;
    bot.enabledAt = null;
    bot.status = 'idle';
    await bot.save();
    await this.stopTrader(botId);
    eventBus.emit('bot:updated', { botId });
    // FIX-2026-07-24: action-specific event สำหรับ Telegram notifier
    eventBus.emit('bot:disabled', { botId });
    return bot;
  }

  /**
   * Flush cumulative active time for every enabled bot (called on graceful shutdown).
   * ป้องกันข้อมูลเวลาหายเมื่อ PM2 kill server หรือ SIGTERM ก่อนผู้ใช้กด disable
   */
  async flushActiveTimeOnShutdown() {
    try {
      const enabled = await Bot.find({ enabled: true, enabledAt: { $ne: null } });
      const now = Date.now();
      for (const b of enabled) {
        const sessionMs = now - new Date(b.enabledAt).getTime();
        if (sessionMs > 0) {
          await Bot.updateOne(
            { _id: b._id },
            { $inc: { totalActiveMs: sessionMs } }
          );
        }
      }
      if (enabled.length) {
        logger.info({ count: enabled.length }, 'flushed totalActiveMs on shutdown');
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'flushActiveTimeOnShutdown failed');
    }
  }
}

module.exports = new BotManager();