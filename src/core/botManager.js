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
const indicators = require('./indicators'); // FIX-2026-08-01: keltnerChannel() for auto-pause Min-%KC scan
// FIX-2026-08-03: Safe-trade filter #2 (trendline) — live status module for bot card badge
//   - per-bot 60s cache + concurrency-6 batch scan (mirror volatilityForBot pattern)
//   - botManager.scheduleTrendlineStatusScan() populates _trendlineStatusCache for /api/bots
const trendlineForBot = require('./trendlineForBot');

// FIX-2026-07-14: periodic reconcile interval (ms) — safety net กัน WS event หลุด
//   FIX-2026-08-04: 2 นาที → 5 นาที (ลด Binance account API load) — reconcilePendingTrades เป็น defensive WS-miss sweep
//   ยังเร็วพอที่จะจับ SELL filled ที่หลุด และช้าพอที่จะลด Binance weight
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

// FIX-2026-08-01: auto-pause on low Min-%KC (default ON per bot)
//   - ทุก 5 นาที: scan Min-%KC(30 bars) — ถ้า < autoPauseMinKcPct → set enabled=false
//   - ถ้า ≥ threshold (และเคยถูก auto-pause) → auto-resume (vol_recovered)
//   - ตรวจเฉพาะบอทที่ autoPauseEnabled !== false (default true)
// FIX-2026-08-04: 5min → 10min (auto-pause check เป็น read-only volatility scan — ไม่กระทบ bot operations)
const AUTO_PAUSE_INTERVAL_MS = 10 * 60 * 1000;
let autoPauseTimer = null;

// FIX-2026-08-03: Safe-trade filter #2 (trendline) — live status scanner
//   - every 60s (matches trendlineForBot CACHE_TTL_MS) for bots with safeTradeTrendlineEnabled=true
//   - populates module-level _trendlineStatusCache Map for /api/bots response
// FIX-2026-08-04: decouple scan interval from cache TTL — scan every 120s (ลด Binance kline API load)
//   - cache TTL 60s ยังคงเดิม (trendlineForBot.CACHE_TTL_MS) — แค่ scan tick ห่างขึ้น
// FIX-2026-08-04 v2: 120s → 600s (10 min) + filter enabled: true only (ลด Binance load อีก 5 เท่า)
//   - trader.js path (BUY-time check) เป็น on-demand — ไม่กระทบ BUY
//   - DISABLED bots: cache freeze ที่ค่าล่าสุด (แสดง stale data บน bot card pill)
//   - Mitigated: invalidateTrendlineCache ใน enableBot() — clear cache on re-enable → next scan fresh
//   - **read-only** — never blocks BUY; trader.js path is the only place that blocks
const TRENDLINE_SCAN_INTERVAL_MS = 10 * 60 * 1000;
let trendlineScanTimer = null;
// FIX-2026-08-03: in-memory cache: botId → {status, trendTF, lastClose, trendlineValue, gapPct, pivotCount, updatedAt}
//   - keyed by botId string; refreshed every TRENDLINE_SCAN_INTERVAL_MS
//   - cleared on bot delete; invalidated when timeframe changes (see botUpdate handler)
const _trendlineStatusCache = new Map();

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

    // FIX-2026-08-01: auto-pause scanner (ทุก 5 นาที: pause/resume ตาม Min-%KC 30 bars)
    autoPauseTimer = setInterval(() => {
      checkAutoPauseBots().catch((err) => logger.warn({ err: err.message }, 'botManager: auto-pause tick failed'));
    }, AUTO_PAUSE_INTERVAL_MS);
    if (autoPauseTimer && typeof autoPauseTimer.unref === 'function') autoPauseTimer.unref();
    logger.info({ intervalMs: AUTO_PAUSE_INTERVAL_MS }, 'botManager: auto-pause scanner scheduled');

    // FIX-2026-08-03: Safe-trade #2 (trendline) live status scanner
    //   - ทุก 60s scan บอทที่ safeTradeTrendlineEnabled=true → populate _trendlineStatusCache
    //   - UI bot card badge reads from this cache via /api/bots response (sl fields)
    //   - immediate first scan (non-blocking) so badge shows on page load
    trendlineScanTimer = setInterval(() => {
      checkTrendlineStatusBots().catch((err) => logger.warn({ err: err.message }, 'botManager: trendline status tick failed'));
    }, TRENDLINE_SCAN_INTERVAL_MS);
    if (trendlineScanTimer && typeof trendlineScanTimer.unref === 'function') trendlineScanTimer.unref();
    setImmediate(() => {
      checkTrendlineStatusBots().catch((err) => logger.warn({ err: err.message }, 'botManager: trendline status initial scan failed'));
    });
    logger.info({ intervalMs: TRENDLINE_SCAN_INTERVAL_MS }, 'botManager: trendline status scanner scheduled');

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
    // FIX-2026-08-01: หยุด auto-pause scanner timer
    if (autoPauseTimer) { clearInterval(autoPauseTimer); autoPauseTimer = null; }
    // FIX-2026-08-03: หยุด trendline status scanner timer + clear cache
    if (trendlineScanTimer) { clearInterval(trendlineScanTimer); trendlineScanTimer = null; }
    _trendlineStatusCache.clear();
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
            // FIX-2026-07-31 (BUG-22): don't call handleBuyFilled for PARTIALLY_FILLED — the BUY
            //   is still open and filling more. Calling handleBuyFilled would place a SELL for
            //   current executedQty while the remainder of the BUY keeps filling → over-exposure.
            //   Let the trader manage PARTIALLY_FILLED via its own schedulePartialFillWatch.
            if (order.status === 'FILLED') {
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
            } else if (order.status === 'PARTIALLY_FILLED') {
              // FIX-2026-07-31 (BUG-22): partial BUY in-progress — let trader manage via
              //   schedulePartialFillWatch. Don't call handleBuyFilled (would over-expose).
              logger.debug({
                tradeId: trade._id.toString(),
                dbState: trade.state,
                executedQty: order.executedQty,
              }, 'reconcile: BUY partially filled in-progress, skip — trader manages');
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
                  // FIX-2026-07-31 (BUG-21): `return` aborted the entire reconcile pass for ALL
                  //   remaining trades — should be `continue` so we move on to next trade.
                  continue;
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

        // FIX-2026-07-31 (BUG-13): orphan holding with no sellOrderId — re-arm scheduleHoldingRetry
        //   เดิม: reconcile path ต้องการ sellOrderId + CANCELED/EXPIRED → trade no sellOrderId ค้างตลอด
        //   ใหม่: ถ้า trade.state='holding' และไม่มี sellOrderId → สั่ง trader ให้ scheduleHoldingRetry
        if (trade.state === 'holding' && !trade.sellOrderId) {
          const trader = this.traders.get(bot._id.toString());
          if (trader && trader.running) {
            logger.warn({
              tradeId: trade._id.toString(),
              botId: bot._id.toString(),
              symbol: bot.symbol,
              buyQty: trade.buyQty,
              buyFilledQty: trade.buyFilledQty,
            }, 'reconcile: ORPHAN holding with no sellOrderId — re-arming scheduleHoldingRetry');
            const fresh = await Trade.findById(trade._id);
            if (fresh && fresh.state === 'holding') {
              const qty = parseFloat(fresh.buyFilledQty || fresh.buyQty) || 0;
              const buyPrice = parseFloat(fresh.buyPrice) || 0;
              const targetSell = parseFloat(fresh.targetSellPrice) || 0;
              if (qty > 0 && buyPrice > 0) {
                trader.scheduleHoldingRetry(fresh, qty, buyPrice, targetSell);
              } else {
                logger.warn({
                  tradeId: fresh._id.toString(),
                  qty, buyPrice, targetSell,
                }, 'reconcile: orphan holding has no buyQty/buyPrice — cannot re-arm');
              }
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

  // FIX (GIGGLE incident 2026-08-05): stale-cursor reset on re-enable
  //   - on manual enable OR auto-resume, if lastSignalCloseTime is older than STALE_CURSOR_THRESHOLD_MS
  //     → re-seed to latestClosed BEFORE spawnTrader()
  //   - ป้องกัน reconcileKlines('startup') ดึง historical candles 200 แท่ง (ช่วง pause/disable)
  //     แล้ว S1 detector ยิง BUY บนแท่งเก่าหลายชั่วโมงก่อน (ghost BUY bug)
  //   - safe: cursor advances monotonically ($max guard ใน trader reconcileKlines กันย้อนหลังอยู่แล้ว)
  //   - mutate `bot.lastSignalCloseTime` ใน place + persist DB เพื่อให้ spawnTrader() ส่งค่าใหม่ให้ Trader ctor
  async _resetStaleReplayCursorOnEnable(bot) {
    const STALE_CURSOR_THRESHOLD_MS = 30 * 60 * 1000; // 30 นาที
    const lastSignalCloseMs = bot.lastSignalCloseTime || 0;
    const nowMs = Date.now();
    const cursorAgeMs = nowMs - lastSignalCloseMs;
    // fresh cursor (≤ 30 min) → ไม่ต้อง reset (reconcileKlines จะดึงแค่ 1-2 แท่งที่หายไป)
    if (lastSignalCloseMs > 0 && cursorAgeMs <= STALE_CURSOR_THRESHOLD_MS) return;

    let latestClosedMs = 0;
    try {
      const raw = await binanceRest.getKlines({
        symbol: bot.symbol,
        interval: bot.timeframe,
        limit: 2,
      });
      for (const k of (raw || [])) {
        const ct = k[6];
        if (ct <= nowMs && ct > latestClosedMs) latestClosedMs = ct;
      }
    } catch (err) {
      logger.warn({ botId: String(bot._id), symbol: bot.symbol, err: err.message },
        'botManager: _resetStaleReplayCursorOnEnable — getKlines failed, skipping reset');
      return;
    }
    if (latestClosedMs === 0) return; // ยังไม่มี closed candle (เดือนใหม่, exchange ปิด ฯลฯ)

    await Bot.updateOne({ _id: bot._id }, { $set: { lastSignalCloseTime: latestClosedMs } });
    bot.lastSignalCloseTime = latestClosedMs;
    logger.info({
      botId: String(bot._id),
      symbol: bot.symbol,
      timeframe: bot.timeframe,
      prevCursorMs: lastSignalCloseMs,
      cursorAgeMs,
      newCursorMs: latestClosedMs,
    }, 'botManager: stale replay cursor reset on re-enable (skip historical replay)');
  }

  async enableBot(botId) {
    const bot = await Bot.findById(botId);
    if (!bot) throw new Error('Bot not found');
    // FIX 2026-08-05: reset stale cursor ก่อน spawnTrader (กัน ghost BUY จาก reconcileKlines replay)
    await this._resetStaleReplayCursorOnEnable(bot);
    bot.enabled = true;
    bot.enabledAt = new Date();
    bot.status = 'idle';
    await bot.save();
    await this.spawnTrader(bot);
    eventBus.emit('bot:updated', { botId });
    // FIX-2026-07-24: action-specific event สำหรับ Telegram notifier (bot:updated payload ไม่มี verb)
    eventBus.emit('bot:enabled', { botId });
    // FIX-2026-08-04 v3: invalidate trendline cache + scan immediately (fresh badge on re-enable)
    //   - เดิม: only invalidate → stale นาน 10 นาที (รอ next 600s tick)
    //   - ใหม่: invalidate + fire-and-forget scanSingleBot() → fresh badge ภายใน ~200ms
    //   - หากไม่มี safeTradeTrendlineEnabled → skip (no Binance call wasted)
    if (bot.safeTradeTrendlineEnabled === true) {
      invalidateTrendlineCache(bot.symbol, bot.timeframe);
      scanSingleBot(bot).catch((err) => {
        logger.warn({ botId: String(bot._id), symbol: bot.symbol, err: err.message }, 'botManager: enableBot → scanSingleBot failed');
      });
    }
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

// FIX-2026-08-01: Auto-pause scanner — ทุก 5 นาที ตรวจ Min-%KC(30 bars) ของทุกบอทที่ autoPauseEnabled !== false
//   - ถ้า minKcPct < threshold และบอท enabled → PAUSE (set enabled=false + telegram + stop trader)
//   - ถ้า minKcPct >= threshold และบอท auto-paused ก่อนหน้า (autoPauseReason === 'low_vol') → RESUME
//   - auto-resume เฉพาะบอทที่ถูก auto-pause (ไม่ resume บอทที่ user ปิดเอง)
async function checkAutoPauseBots() {
  let bots;
  try {
    bots = await Bot.find({ autoPauseEnabled: { $ne: false } }).lean();
  } catch (err) {
    logger.warn({ err: err.message }, 'botManager: checkAutoPauseBots — Bot.find failed');
    return;
  }
  if (!bots || bots.length === 0) return;

  const telegramNotifier = require('../services/telegramNotifier');
  const now = new Date();

  for (const b of bots) {
    try {
      const raw = await binanceRest.getKlines({ symbol: b.symbol, interval: b.timeframe, limit: 50 });
      if (!Array.isArray(raw) || raw.length < 25) continue;
      const highs = raw.map((k) => parseFloat(k[2]));
      const lows = raw.map((k) => parseFloat(k[3]));
      const closes = raw.map((k) => parseFloat(k[4]));
      const kc = indicators.keltnerChannel(highs, lows, closes, 20, b.kcMult || 1.5);
      const tail = kc.width.slice(-30).filter((w) => w != null && Number.isFinite(w));
      if (tail.length < 5) continue;
      const minKcPct = Math.min(...tail);
      const threshold = b.autoPauseMinKcPct != null ? b.autoPauseMinKcPct : 2;

      const update = { autoPauseLastCheckedAt: now };

      if (minKcPct < threshold && b.enabled !== false) {
        // ─── PAUSE ────────────────────────────────────────────────────
        Object.assign(update, {
          enabled: false,
          enabledAt: null,
          status: 'idle',
          autoPauseLastActionAt: now,
          autoPauseReason: 'low_vol',
        });
        await Bot.updateOne({ _id: b._id }, { $set: update });
        eventBus.emit('bot:disabled', { botId: String(b._id), reason: 'auto_pause_low_kc', minKcPct });
        try {
          await telegramNotifier.sendNow('botDisabled', {
            botId: String(b._id),
            botName: b.name || b.symbol,
            symbol: b.symbol,
            timeframe: b.timeframe,
            reason: `auto-pause: Min-%KC=${minKcPct.toFixed(2)}% < ${threshold}%`,
          });
        } catch (_) { /* non-fatal */ }
        const trader = this.traders.get(String(b._id));
        if (trader) await trader.stop('auto_pause_low_kc').catch(() => {});
        logger.info({ botId: String(b._id), minKcPct, threshold }, 'botManager: auto-paused bot (low Min-%KC)');
      } else if (minKcPct >= threshold && b.enabled === false && b.autoPauseReason === 'low_vol') {
        // ─── RESUME (เฉพาะบอทที่เคยถูก auto-pause) ──────────────────
        Object.assign(update, {
          enabled: true,
          enabledAt: now,
          autoPauseLastActionAt: now,
          autoPauseReason: 'vol_recovered',
        });
        await Bot.updateOne({ _id: b._id }, { $set: update });
        // FIX 2026-08-05 (GIGGLE): reset stale cursor ก่อน spawnTrader (กัน ghost BUY จาก reconcileKlines replay)
        //   - b เป็น plain object จาก .find() → mutate directly แล้ว persist ผ่าน helper
        await this._resetStaleReplayCursorOnEnable(b);
        eventBus.emit('bot:enabled', { botId: String(b._id), reason: 'auto_resume_vol_recovered', minKcPct });
        try {
          await telegramNotifier.sendNow('botEnabled', {
            botId: String(b._id),
            botName: b.name || b.symbol,
            symbol: b.symbol,
            timeframe: b.timeframe,
            reason: `auto-resume: Min-%KC=${minKcPct.toFixed(2)}% ≥ ${threshold}%`,
          });
        } catch (_) { /* non-fatal */ }
        // re-spawn trader (mirror enableBot behavior — without totalActiveMs accrual since autoPause is short)
        await this.spawnTrader({ _id: b._id, ...b }).catch((err) => logger.warn({ botId: String(b._id), err: err.message }, 'botManager: auto-resume spawn failed'));
        logger.info({ botId: String(b._id), minKcPct, threshold }, 'botManager: auto-resumed bot (vol recovered)');
      } else {
        // ปกติ: แค่ update timestamp
        await Bot.updateOne({ _id: b._id }, { $set: update });
      }
    } catch (err) {
      logger.warn({ botId: String(b._id), err: err.message }, 'botManager: auto-pause check failed');
    }
  }
}

module.exports = new BotManager();

// FIX-2026-08-03: Export helpers for routes (pattern mirrors module.exports = new BotManager() above)
module.exports.getTrendlineStatusForBots = getTrendlineStatusForBots;
module.exports.invalidateTrendlineCache = invalidateTrendlineCache;

// FIX-2026-08-03: Trendline status scanner — refresh _trendlineStatusCache ทุก 60s
//   - ตรวจเฉพาะบอทที่ safeTradeTrendlineEnabled === true (ลด Binance calls)
//   - ใช้ trendlineForBot.mapWithConcurrency(6) กัน burst weight
//   - **read-only** — ไม่มี side effect กับ trade state
//   - emit 'bot:trendline_status_changed' event เมื่อ status เปลี่ยน (เพื่อให้ telegram notifier แจ้งได้)
// FIX-2026-08-04 v3: extract scanSingleBot() — reuse จาก enableBot() เพื่อ refresh badge ทันทีหลัง enable
//   - เดิม enable → invalidate → รอ 600s scan tick → stale 10 นาที
//   - ใหม่ enable → invalidate → scanSingleBot() ทันที (Binance ~200ms) → fresh badge
//   - transition event: หาก scanSingleBot ครั้งแรกที่ prev=undefined → skip notification (กัน spam)
async function scanSingleBot(bot, precomputedSnap) {
  const botId = String(bot._id);
  const prev = _trendlineStatusCache.get(botId);
  let snap = precomputedSnap;
  if (!snap) {
    try {
      snap = await trendlineForBot.computeBotTrendlineSnapshot(bot);
    } catch (err) {
      logger.warn({ botId, symbol: bot.symbol, err: err.message }, 'botManager: scanSingleBot — computeBotTrendlineSnapshot failed');
      return;
    }
  }
  const now = Date.now();
  _trendlineStatusCache.set(botId, {
    status: snap.status || 'unknown',
    trendTF: snap.trendTF || null,
    lastClose: snap.lastClose != null ? snap.lastClose : null,
    trendlineValue: snap.trendlineValue != null ? snap.trendlineValue : null,
    gapPct: snap.gapPct != null ? Number(snap.gapPct) : null,
    pivotCount: snap.pivotCount || 0,
    updatedAt: now,
    cached: !!snap.cached,
    ms: snap.ms != null ? snap.ms : null,
    error: snap.error || null,
  });
  // Detect transition (only meaningful states: pass ↔ blocked) — skip if prev undefined (initial)
  if (prev && prev.status !== snap.status && (snap.status === 'pass' || snap.status === 'blocked')
      && (prev.status === 'pass' || prev.status === 'blocked')) {
    try {
      const telegramNotifier = require('../services/telegramNotifier');
      await telegramNotifier.sendNow('trendlineStatusChanged', {
        botId,
        botName: bot.name || bot.symbol,
        symbol: bot.symbol,
        timeframe: bot.timeframe,
        trendTF: snap.trendTF,
        prevStatus: prev.status,
        newStatus: snap.status,
        lastClose: snap.lastClose,
        trendlineValue: snap.trendlineValue,
        gapPct: snap.gapPct,
      });
    } catch (_) { /* non-fatal */ }
    eventBus.emit('bot:trendline_status_changed', {
      botId, symbol: bot.symbol, prevStatus: prev.status, newStatus: snap.status,
      lastClose: snap.lastClose, trendlineValue: snap.trendlineValue, gapPct: snap.gapPct,
    });
  }
  logger.debug({ botId, symbol: bot.symbol, status: snap.status }, 'botManager: scanSingleBot done');
}

async function checkTrendlineStatusBots() {
  let bots;
  try {
    // FIX-2026-08-04 v2: filter enabled: true only — disabled bots freeze cache at last value
    //   - เหตุผล: disabled bot ไม่ทำการเทรดอยู่แล้ว → status แค่แสดง stale info ไม่มีประโยชน์
    //   - ลด Binance kline load ลง 5 เท่า (เฉพาะ enabled bots scan)
    //   - เมื่อ enable bot ใหม่ → invalidateTrendlineCache() + scanSingleBot() ใน enableBot() → fresh ทันที
    bots = await Bot.find({ safeTradeTrendlineEnabled: true, enabled: true }).lean();
  } catch (err) {
    logger.warn({ err: err.message }, 'botManager: checkTrendlineStatusBots — Bot.find failed');
    return;
  }
  if (!bots || bots.length === 0) {
    // ลบ cache entries สำหรับบอทที่ปิด filter แล้ว (cleanup)
    return;
  }

  // FIX-2026-08-04 v3: parallel fetch snapshots (concurrency 6), then sequential cache update via scanSingleBot
  //   - decoupling: scanSingleBot(bot, snap) handles cache-set + transition event (reusable from enableBot)
  //   - single Binance call per bot per tick (no duplication)
  const now = Date.now();
  const snapshots = await trendlineForBot.mapWithConcurrency(
    bots, 6, (b) => trendlineForBot.computeBotTrendlineSnapshot(b)
  );
  for (let i = 0; i < bots.length; i += 1) {
    await scanSingleBot(bots[i], snapshots[i]);
  }

  logger.debug({ count: bots.length, ts: now }, 'botManager: trendline status scan done');
}

// FIX-2026-08-03: accessor for /api/bots route — returns slim fields for bot card badge
function getTrendlineStatusForBots(botIds) {
  const out = {};
  for (const id of botIds) {
    const s = _trendlineStatusCache.get(String(id));
    if (s) out[String(id)] = s;
  }
  return out;
}

// FIX-2026-08-03: cache invalidation when timeframe changes (called from botUpdate + bulk-update routes)
//   - mirrors volatilityForBot.invalidate(symbol, timeframe) pattern
function invalidateTrendlineCache(symbol, timeframe) {
  trendlineForBot.invalidate(symbol, timeframe);
  // Also clear in-memory status cache for any bot with this symbol+tf
  // (we don't have botId here so scan will rebuild on next tick — acceptable)
  _trendlineStatusCache.clear();
}