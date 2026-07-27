'use strict';

const Decimal = require('decimal.js');
const binanceRest = require('../binance/binanceRest');
const symbolInfo = require('../binance/symbolInfo');
const fees = require('../binance/fees');
const klineCache = require('../services/klineCache');
const eventBus = require('../services/eventBus');
const signalEngine = require('./signalEngine');
const logger = require('../utils/logger');
const Bot = require('../db/models/Bot');
const Trade = require('../db/models/Trade');
const Signal = require('../db/models/Signal');

/**
 * Trader class — state machine ต่อบอท สำหรับ maker-only BUY → TP SELL
 *
 * States:
 *  - idle: รอ S1 signal บนแท่งล่าสุด
 *  - waiting_buy_fill: วาง BUY แล้ว รอ fill (retry loop)
 *  - holding: มี base asset แล้ว กำลังจะวาง/วาง SELL แล้ว
 *  - waiting_sell_fill: วาง SELL แล้ว รอ fill
 *  - error: เกิดข้อผิดพลาด หยุดชั่วคราว
 *
 * Robustness patches:
 *  - FIX 1: SELL reject → MARKET fallback + holding retry (กัน stranded position)
 *  - FIX 2: cancelAndRecheck คืนค่า + checkBuyOrder handle PARTIALLY_FILLED + defer
 *    เมื่อ cancel/getOrder ไม่แน่ใจ (กัน mark cancelled ทั้งที่ order ยังมีชีวิต)
 *  - FIX 3: WS handler ใช้ Map<clientOrderId, trade> + DB fallback (กัน drop event
 *    ของ trade เก่าหลัง rePlaceBuy)
 *  - FIX 4: Mutex handleBuyFilled (กัน double-SELL จาก WS+retryTimer race)
 *  - FIX 6: makeClientOrderId เพิ่ม random suffix (กัน -2010 Duplicate)
 *  - FIX 7: WS update handle PARTIALLY_FILLED/CANCELED/EXPIRED (กัน silent drop)
 */
class Trader {
  constructor(bot) {
    this.bot = bot;
    this.running = false;
    this.currentTrade = null;
    this.retryCheckTimer = null;
    this.holdingRetryTimer = null;
    this.currentBookTicker = null;
    this.lastSignalIndex = -1; // index ของแท่งที่ S1 ล่าสุดที่เคย trigger แล้ว (กันยิงซ้ำ)

    // FIX 3: Map clientOrderId → trade เพื่อให้ WS update หา trade ที่ถูกต้อง
    // แม้ currentTrade จะถูก replace ไปแล้ว (เช่น หลัง cancel-and-replace)
    this.tradesByClientOrderId = new Map();

    // FIX 4: Mutex per tradeId กัน handleBuyFilled ถูกเรียก 2 ครั้งพร้อมกัน
    this.handleBuyFilledLocks = new Map();

    // FIX-2026-07-21: per-bot BUY cooldown — กันยิง BUY รัวใน 1 วินาที
    //   เคสที่เจอ: reconcileKlines replay หลาย candles → onCandleClosed ยิง 5 BUY ใน 1 วินาที
    //   ทำให้ทุนโดนหักหลายไม้ก่อน SELL ตัวแรกจะ sell ได้ → orphan trade (BUY filled แต่ไม่มีของเหลือ)
    this.lastBuyPlacedAt = 0;            // epoch ms ของ BUY order ล่าสุดที่วางสำเร็จ
    this.buyCooldownMs = 3000;           // อย่างน้อย 3 วินาที ระหว่าง BUY orders
    this.buyInFlight = false;            // กัน onCandleClosed ที่มาพร้อมกัน 2 เส้นทาง (WS + sweep) เข้า placeBuy พร้อมกัน

    // FIX-2026-07-23: partial-fill watcher timer + reconcileAccountBalance throttle
    this.partialFillTimer = null;
    this._lastReconcileBalanceMs = 0;
    // FIX-2026-07-23: deadline tracking for partial-fill finalizer (instance-only, not persisted)
    this.partialFillDeadlineAt = null;
    this._partialFillTradeId = null;
    // FIX P1.3: explicit init กัน undefined reference
    this.reconcileInFlight = false;
    // FIX P1.5: holding retry counter (instance-level) — กัน retry loop infinite
    this.holdingRetryCount = 0;
    // FIX P2.5: stop-loss check mutex — กัน WS + sweep ยิงพร้อมกัน
    this.stopLossCheckInFlight = false;
    // FIX P2.1: serialized bot:status emit — กัน race ระหว่าง error/idle/selling
    this._statusEmitQueue = Promise.resolve();
  }

  // ─── FIX P2.1: serialized bot:status emit ──────────────────────────
  //   กัน race ระหว่าง error/idle/selling emit ที่อาจมาพร้อมกัน
  //   - ทุก status change ต้องผ่าน helper นี้เพื่อให้ DB update + emit เป็น sequential
  //   - ถ้าเปลี่ยน status หลายครั้งใน hot path → จะเรียงตามลำดับ ไม่ข้าม
  _setBotStatus(status, { lastError = null, extra = {} } = {}) {
    const update = { status, ...extra };
    if (lastError !== null) update.lastError = lastError;
    // chain ต่อ queue — Promise.resolve() เป็น resolved เสมอ แต่ละ call จะรอ call ก่อนหน้า
    this._statusEmitQueue = this._statusEmitQueue
      .catch(() => {}) // swallow error จาก previous call
      .then(async () => {
        try {
          await Bot.updateOne({ _id: this.bot._id }, { $set: update });
          // mirror local state เพื่อให้ onCandleClosed check this.bot.status เห็นค่าล่าสุด
          this.bot.status = status;
          if (lastError !== null) this.bot.lastError = lastError;
          eventBus.emit('bot:status', { botId: this.bot._id, status });
        } catch (err) {
          logger.warn({ err: err.message, botId: this.bot._id.toString(), status }, 'trader: _setBotStatus failed');
        }
      });
    return this._statusEmitQueue;
  }

  // ─── Lifecycle ─────────────────────────────────────
  start() {
    this.running = true;
    logger.info({ botId: this.bot._id.toString(), symbol: this.bot.symbol, tf: this.bot.timeframe }, 'trader start');

    // subscribe WS streams
    eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });

    // FIX-2026-07-15: restore lastSignalCloseTime from DB → populate lastSignalIndex using cached klines
    //   (กัน WS missed kline:closed ตอน bot start — replay candle ที่ close ไปแล้วและยังไม่ process)
    if (this.bot.lastSignalCloseTime) {
      const klines = klineCache.getAll(this.bot.symbol, this.bot.timeframe);
      if (klines.length > 0) {
        const idx = klines.findIndex((k) => k.closeTime === this.bot.lastSignalCloseTime);
        this.lastSignalIndex = idx >= 0 ? idx : (klines.length - 1);
        logger.info({
          botId: this.bot._id.toString(),
          lastSignalCloseTime: this.bot.lastSignalCloseTime,
          restoredIdx: this.lastSignalIndex,
          klineCount: klines.length,
        }, 'trader: lastSignalIndex restored from DB');
      }
    }

    // FIX-2026-07-15: schedule periodic "kline sweep" to catch missed closes (WS gap safety net)
    //   - ดึง latest 5 candles จาก REST every SWEEP_INTERVAL_MS
    //   - ถ้า candle.closeTime > lastSignalCloseTime → เรียก onCandleClosed() ทันที
    //   - guard sweepInFlight กัน overlap
    this.sweepTimer = null;
    this.sweepInFlight = false;
    this.sweepTimer = setInterval(() => {
      if (!this.running || this.sweepInFlight) return;
      this.sweepInFlight = true;
      this.reconcileKlines('periodic-sweep')
        .catch((err) => logger.warn({ err: err.message }, 'trader: periodic sweep failed'))
        .finally(() => { this.sweepInFlight = false; });
    }, SWEEP_INTERVAL_MS);

    // FIX-2026-07-15: also reconcile on WS reconnect (immediate catch-up vs 90s sweep wait)
    this._marketReconnectHandler = () => {
      // เล็กน้อย debounce กัน reconnect storm (Binance อาจ reconnect หลายรอบ)
      if (this._marketReconnectDebounce) clearTimeout(this._marketReconnectDebounce);
      this._marketReconnectDebounce = setTimeout(() => {
        if (!this.running) return;
        this.reconcileKlines('ws-reconnect').catch((err) =>
          logger.warn({ err: err.message }, 'trader: ws-reconnect sweep failed')
        );
      }, 500);
    };
    eventBus.on('market:reconnected', this._marketReconnectHandler);

    // FIX-2026-07-15: startup sweep — catch up missed closes ถ้า bot เพิ่ง restart
    //   (รอ 2s ให้ klineCache warm-up เสร็จก่อน)
    setTimeout(() => {
      if (!this.running) return;
      this.reconcileKlines('startup').catch((err) =>
        logger.warn({ err: err.message }, 'trader: startup sweep failed')
      );
      // FIX-2026-07-23: หลัง startup sweep ตรวจ Binance balance ของบอทนี้
      //   ถ้ามี base asset ค้างโดยไม่มี active trade → log orphan + sync BUY order ที่ยังมีชีวิต
      setTimeout(() => {
        if (!this.running) return;
        this.reconcileAccountBalance({ force: true }).catch((err) =>
          logger.warn({ err: err.message }, 'trader: startup reconcileAccountBalance failed')
        );
      }, 4000);
    }, 2000);

    // bookTicker handler — เก็บ bid ล่าสุด
    this._bookTickerHandler = (t) => {
      if (t.symbol === this.bot.symbol) this.currentBookTicker = t;
    };
    eventBus.on('bookTicker', this._bookTickerHandler);

    // kline:closed handler
    this._klineHandler = (payload) => {
      if (payload.symbol !== this.bot.symbol || payload.timeframe !== this.bot.timeframe) return;
      this.onCandleClosed(payload.candle);
    };
    eventBus.on('kline:closed', this._klineHandler);

    // FIX 3 + FIX-2026-07-13: order update handler ใช้ Map lookup + DB fallback
    // (FIX-2026-07-13: _registerTrade บางที register แค่ {buyClientOrderId, sellClientOrderId}
    //  → trade snapshot ไม่มี buyPrice → handleSellFilled pnl.net=NaN → DB ไม่อัปเดต
    //  แก้โดยเช็ค trade.buyPrice ก่อน — ถ้าไม่มีก็ re-fetch จาก DB เพื่อให้ได้ full doc)
    this._orderHandler = async (update) => {
      if (update.symbol !== this.bot.symbol) return;
      const c = update.clientOrderId || '';
      if (!c) return;

      // Fast path: in-memory map (อาจเป็น partial doc จาก _registerTrade minimal)
      let trade = this.tradesByClientOrderId.get(c);

      // FIX-2026-07-13: full doc จำเป็นต้องมี buyPrice สำหรับ handleSellFilled → ถ้า Map hit แต่ doc ไม่มี buyPrice → re-fetch
      if (trade && (trade.buyPrice == null || trade.buyPrice === undefined)) {
        trade = null;
      }

      // Fallback: DB lookup (กรณี restart, trade จาก round ก่อนหน้า, หรือ fast path เป็น partial doc)
      if (!trade) {
        try {
          trade = await Trade.findOne({
            botId: this.bot._id,
            $or: [{ buyClientOrderId: c }, { sellClientOrderId: c }],
          }).lean();
        } catch (err) {
          logger.warn({ err: err.message, c }, 'trader: order handler DB lookup failed');
          return;
        }
      }
      if (!trade) return;

      // Dispatch ตาม clientOrderId — ไม่พึ่ง currentTrade
      if (trade.buyClientOrderId === c) {
        await this.onBuyOrderUpdate(update, trade);
      } else if (trade.sellClientOrderId === c) {
        await this.onSellOrderUpdate(update, trade);
      }
    };
    eventBus.on('order:update', this._orderHandler);

    // FIX-2026-07-24: subscribe bot:updated เพื่อ refresh this.bot (kcMult, s1OnlyDown, minSpreadTicks, ...)
    //   - ปัญหา: เมื่อ user แก้ค่าใน UI ตอนบอท run อยู่ บอทไม่ reload (cache this.bot ตอน spawn)
    //     → mini chart เห็นสัญญาณ (ที่ใช้ค่าใหม่จาก API ตอน page load) ก่อนบอท 3 นาที
    //   - fix: ผูก bot:updated → fetch fresh this.bot แล้ว assign กลับ
    //     จุดใช้งาน (kcMult, s1OnlyDown, minSpreadTicks) จะเห็นค่าใหม่รอบถัดไป
    this._botUpdatedHandler = async ({ botId } = {}) => {
      if (!botId || String(botId) !== String(this.bot._id)) return;
      try {
        const fresh = await Bot.findById(this.bot._id).lean();
        if (!fresh) return;
        // FIX-2026-07-24: refresh เฉพาะ tunable fields (ไม่แตะ status/currentTrade เพราะจัดการใน hot path)
        // FIX P2.2: ใช้ **blacklist** แทน whitelist — refresh ทุก field ยกเว้น hot-path state
        //   เดิม whitelist = 13 fields → ถ้า dev เพิ่ม field ใหม่แล้วลืม update array = bug
        //   fix: blacklist เฉพาะ fields ที่ต้อง preserve (status, currentTrade, lastSignalCloseTime, etc.)
        const preservedKeys = ['_id', 'status', 'lastSignalCloseTime', 'lastSignalAt', 'totalPnl', 'totalTrades', 'winTrades', 'lastError', 'createdAt', 'updatedAt', '__v'];
        for (const k of Object.keys(fresh)) {
          if (preservedKeys.includes(k)) continue;
          if (k in this.bot) {
            // refresh field ที่อยู่ใน instance แล้ว
            this.bot[k] = fresh[k];
          }
        }
        logger.info({
          botId: this.bot._id.toString(),
          kcMult: this.bot.kcMult,
          s1OnlyDown: this.bot.s1OnlyDown,
          minSpreadTicks: this.bot.minSpreadTicks,
        }, 'trader: bot config refreshed from bot:updated event');
      } catch (err) {
        logger.warn({ err: err.message, botId: this.bot._id.toString() }, 'trader: bot:updated refresh failed');
      }
    };
    eventBus.on('bot:updated', this._botUpdatedHandler);
  }

  async stop() {
    this.running = false;
    if (this.retryCheckTimer) {
      clearTimeout(this.retryCheckTimer);
      this.retryCheckTimer = null;
    }
    if (this.holdingRetryTimer) {
      clearTimeout(this.holdingRetryTimer);
      this.holdingRetryTimer = null;
    }
    // FIX-2026-07-15: clear sweep timer + reconnect debounce
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this._marketReconnectDebounce) {
      clearTimeout(this._marketReconnectDebounce);
      this._marketReconnectDebounce = null;
    }
    if (this._bookTickerHandler) eventBus.off('bookTicker', this._bookTickerHandler);
    if (this._klineHandler) eventBus.off('kline:closed', this._klineHandler);
    if (this._orderHandler) eventBus.off('order:update', this._orderHandler);
    if (this._marketReconnectHandler) eventBus.off('market:reconnected', this._marketReconnectHandler);
    if (this._botUpdatedHandler) eventBus.off('bot:updated', this._botUpdatedHandler);
    this.tradesByClientOrderId.clear();
    this.handleBuyFilledLocks.clear();
    logger.info({ botId: this.bot._id.toString() }, 'trader stopped');
    eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
  }

  // ─── FIX 3 helpers: register/unregister trade ใน Map ────
  _registerTrade(trade) {
    if (!trade) return;
    if (trade.buyClientOrderId) this.tradesByClientOrderId.set(trade.buyClientOrderId, trade);
    if (trade.sellClientOrderId) this.tradesByClientOrderId.set(trade.sellClientOrderId, trade);
  }

  _unregisterTrade(trade) {
    if (!trade) return;
    if (trade.buyClientOrderId) this.tradesByClientOrderId.delete(trade.buyClientOrderId);
    if (trade.sellClientOrderId) this.tradesByClientOrderId.delete(trade.sellClientOrderId);
  }

  // ─── FIX-2026-07-23: Stop Loss on upper-KC ─────────────────────────────────
  // เรียกจาก onCandleClosed หลังจาก S1 detection เสร็จ
  //   - gate: bot.stopLossOnUpperKC ต้องเปิดอยู่
  //   - คำนวณ upper-KC ของ timeframe นี้
  //   - ถ้า candle.close > upperKC → scan active trades ที่ state='selling' + buyPrice > close (ขาดทุน)
  //   - force close ทีละ trade (cancel SELL + MARKET SELL)
  async _checkStopLossOnUpperKC(candle) {
    // FIX E7: gate running + flag
    if (!this.running) return;
    if (!this.bot.stopLossOnUpperKC) return;

    // FIX P2.5: mutex กัน concurrent invocation (WS + sweep อาจ trigger พร้อมกัน)
    //   ถ้า in-flight อยู่ → skip (อีก call จะจบเร็วๆ นี้อยู่แล้ว)
    if (this.stopLossCheckInFlight) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: stop-loss check already in flight, skip');
      return;
    }
    this.stopLossCheckInFlight = true;
    try {

    // FIX E3: warm-up guard
    const klines = klineCache.getAll(this.bot.symbol, this.bot.timeframe);
    if (!klines || klines.length < 21) return;

    // FIX E3: คำนวณ upper-KC ของแท่งล่าสุด (re-use signalEngine.computeBgStates)
    const { upper } = signalEngine.computeBgStates({
      closes: klines.map((k) => k.close),
      highs: klines.map((k) => k.high),
      lows: klines.map((k) => k.low),
      length: 20,
      mult: this.bot.kcMult || 1.5, // FIX-2026-07-24: per-bot kcMult
      useTrueRange: true,
    });
    const upperKC = upper[upper.length - 1];
    if (upperKC == null) return;

    const closePrice = parseFloat(candle.close);
    // FIX: candle ต้องปิดเหนือ upperKC เท่านั้น → trigger
    if (closePrice <= upperKC) return;

    // FIX E5: หา trades ที่กำลัง selling + ยังขาดทุน (buyPrice > close)
    //   ถ้า buyPrice < close (กำไร) → ไม่แตะ ปล่อยให้ TP ทำงานต่อ
    let targets;
    try {
      targets = await Trade.find({
        botId: this.bot._id,
        state: 'selling',
        buyPrice: { $gt: closePrice },
      }).lean();
    } catch (err) {
      logger.warn({ err: err.message }, 'trader: stop_loss_upper_kc — Trade.find failed');
      return;
    }

    if (!targets || targets.length === 0) {
      // log debug only (เคสปกติ — candle ทะลุ upper-kc แต่ไม่มี trade ขาดทุน)
      logger.debug({
        botId: this.bot._id.toString(),
        symbol: this.bot.symbol,
        timeframe: this.bot.timeframe,
        closePrice, upperKC: upperKC.toFixed(6),
      }, 'trader: stop_loss_upper_kc — close > upperKC but no losing trade to force-close');
      return;
    }

    logger.warn({
      botId: this.bot._id.toString(),
      symbol: this.bot.symbol,
      timeframe: this.bot.timeframe,
      closePrice, upperKC: upperKC.toFixed(6),
      targets: targets.length,
      tradeIds: targets.map((t) => t._id.toString()),
    }, 'trader: stop_loss_upper_kc — close > upperKC, force-closing losing positions');

    // FIX E6: loop ทีละ trade (atomic per-trade กัน race)
    for (const t of targets) {
      if (!this.running) break;
      try {
        await this._stopLossForceClose(t, { upperKC, closePrice });
      } catch (err) {
        logger.error({
          err: err.message, stack: err.stack,
          tradeId: t._id.toString(),
        }, 'trader: stop_loss_force_close — exception');
      }
    }
    } finally {
      // FIX P2.5: release mutex — ใช้ finally กัน throw ค้าง flag
      this.stopLossCheckInFlight = false;
    }
  }

  // FIX-2026-07-23: stop-loss force close — atomic claim → cancel live SELL → MARKET SELL
  async _stopLossForceClose(trade, ctx) {
    // FIX E1: atomic claim (state='selling' → 'stopping') กัน 2 trigger พร้อมกัน
    //   - onSellOrderUpdate (WS) จะเห็น state='stopping' และ skip (FILLED → handleSellFilled guard)
    //   - onCandleClosed รอบถัดไปจะเห็น state != 'selling' ไม่ trigger ซ้ำ
    const claim = await Trade.findOneAndUpdate(
      { _id: trade._id, state: 'selling' },
      {
        $set: {
          state: 'stopping',
          error: `stop_loss_upper_kc triggered (close=${ctx.closePrice} > upperKC=${ctx.upperKC.toFixed(6)})`,
        },
      },
      { new: true }
    );
    if (!claim) {
      // someone else handled (WS SELL fill, or concurrent stop-loss path)
      logger.debug({
        tradeId: trade._id.toString(),
      }, 'trader: stop_loss_force_close — state no longer selling, abort');
      return;
    }

    // 1. cancel live SELL ก่อน (idempotent — -2011 Unknown order ก็ ignore)
    if (trade.sellOrderId) {
      try {
        await binanceRest.cancelOrder({
          symbol: this.bot.symbol,
          orderId: trade.sellOrderId,
        });
        logger.info({
          botId: this.bot._id.toString(),
          tradeId: trade._id.toString(),
          sellOrderId: trade.sellOrderId,
        }, 'trader: stop_loss_force_close — cancelled live SELL');
      } catch (err) {
        // -2011 Unknown order (already filled/cancelled) → log info, continue
        const fe = binanceRest.formatBinanceError(err);
        if (fe.code === -2011) {
          // CRITICAL FIX (FIX-2026-07-23b): -2011 อาจหมายถึง SELL เพิ่ง FILL ที่ TP target
          //   - ถ้า fill แล้วจริง → ห้าม place MARKET SELL อีก (จะ double-sell)
          //   - ต้อง re-fetch order → ถ้า status=FILLED → record fill แทน, ออกจาก stop-loss flow
          //   - ถ้า status=CANCELED → asset ยังอยู่ → ทำ MARKET SELL ตามปกติ
          try {
            const fresh = await binanceRest.getOrder({
              symbol: this.bot.symbol,
              orderId: trade.sellOrderId,
            });
            if (fresh && fresh.status === 'FILLED') {
              const filledQty = parseFloat(fresh.executedQty);
              const avgSell = parseFloat(fresh.price)
                || parseFloat(fresh.avgPrice)
                || (parseFloat(fresh.cummulativeQuoteQty) / filledQty);
              const feeRate = fees.getMakerRate();
              const pnl = fees.calcPnl({
                buyPrice: parseFloat(trade.buyPrice),
                sellPrice: avgSell,
                qty: filledQty,
                feeRate,
              });
              const upd = await Trade.updateOne(
                { _id: claim._id, state: 'stopping' },
                {
                  state: 'sold',
                  sellOrderId: fresh.orderId,
                  sellPrice: avgSell,
                  sellQty: filledQty,
                  sellQuoteQty: parseFloat(fresh.cummulativeQuoteQty),
                  sellStatus: 'FILLED',
                  sellFilledAt: new Date(fresh.updateTime || Date.now()),
                  realizedPnl: pnl.net,
                  pnlPercent: pnl.pnlPercent,
                  error: `stop_loss_upper_kc — SELL already filled at TP before stop-loss cancelled (close=${ctx.closePrice} > upperKC=${ctx.upperKC.toFixed(6)})`,
                }
              );
              if (upd.modifiedCount === 1) {
                await Bot.updateOne(
                  { _id: this.bot._id },
                  {
                    $inc: {
                      totalPnl: pnl.net,
                      totalTrades: 1,
                      winTrades: (pnl.net > 0 ? 1 : 0),
                    },
                    $set: { status: 'idle', lastError: '' },
                  }
                );
                this._unregisterTrade(trade);
                if (this.currentTrade && this.currentTrade._id.toString() === trade._id.toString()) {
                  this.currentTrade = null;
                }
                eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
                eventBus.emit('trade:update', { tradeId: claim._id, state: 'sold' });
                logger.warn({
                  botId: this.bot._id.toString(),
                  tradeId: claim._id.toString(),
                  sellOrderId: trade.sellOrderId,
                  filledQty, avgSell, pnl: pnl.net,
                }, 'trader: stop_loss_force_close — SELL already FILLED at TP, recorded (no MARKET placed)');
              } else {
                logger.debug({
                  tradeId: claim._id.toString(),
                }, 'trader: stop_loss_force_close — race with WS handleSellFilled, abort');
              }
              return; // ออกจาก stop-loss flow — ไม่ place MARKET SELL
            }
            // status = CANCELED หรืออื่นๆ → asset ยังอยู่ → ทำ MARKET SELL ตามปกติ
            logger.info({
              tradeId: trade._id.toString(),
              sellOrderId: trade.sellOrderId,
              freshStatus: fresh.status,
            }, 'trader: stop_loss_force_close — SELL gone but not FILLED, proceeding to MARKET');
          } catch (fetchErr) {
            // getOrder fail (เช่น network) → fallback ไป MARKET SELL ตามปกติ (ตามเดิม)
            logger.warn({
              err: fetchErr.message,
              tradeId: trade._id.toString(),
              sellOrderId: trade.sellOrderId,
            }, 'trader: stop_loss_force_close — getOrder after -2011 failed, proceeding to MARKET');
          }
        } else {
          logger.warn({
            err: fe,
            tradeId: trade._id.toString(),
            sellOrderId: trade.sellOrderId,
          }, 'trader: stop_loss_force_close — cancel SELL failed, proceeding to MARKET anyway');
        }
      }
    }

    // 2. MARKET SELL (re-use _emergencyMarketSell — guard ตอนนี้รวม 'stopping' แล้ว)
    const qty = parseFloat(trade.sellQty) || parseFloat(trade.buyQty) || 0;
    const buyPrice = parseFloat(trade.buyPrice) || 0;
    const targetSell = parseFloat(trade.targetSellPrice) || 0;
    if (qty <= 0 || buyPrice <= 0) {
      logger.error({
        tradeId: claim._id.toString(),
        qty, buyPrice,
      }, 'trader: stop_loss_force_close — invalid qty/buyPrice, marking failed');
      await Trade.updateOne(
        { _id: claim._id, state: 'stopping' },
        { state: 'failed', error: 'stop_loss: invalid qty/buyPrice' }
      );
      return;
    }

    const ok = await this._emergencyMarketSell(
      claim,
      qty,
      buyPrice,
      targetSell,
      `stop_loss_upper_kc (close=${ctx.closePrice} > upperKC=${ctx.upperKC.toFixed(6)})`,
    );

    if (!ok) {
      // FIX E4: MARKET fail → fallback ไป holding + scheduleHoldingRetry
      logger.error({
        tradeId: claim._id.toString(),
      }, 'trader: stop_loss_force_close — MARKET SELL failed, fallback to holding retry');
      await Trade.updateOne(
        { _id: claim._id },
        { state: 'holding', error: 'stop_loss MARKET SELL failed — will retry' }
      );
      await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
      eventBus.emit('trade:update', { tradeId: claim._id, state: 'holding' });
      this.scheduleHoldingRetry(claim, qty, buyPrice, targetSell);
    }
  }

  // ─── Signal Detection ─────────────────────────────
  async onCandleClosed(candle, opts = {}) {
    if (!this.running) return;
    if (!this.bot.enabled) return;

    // ต้อง warm-up ก่อน
    if (!signalEngine.isWarmedUp(klineCache.size(this.bot.symbol, this.bot.timeframe))) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: waiting for warm-up');
      return;
    }

    // FIX P1.1: status='error' recovery — ถ้าบอทค้างใน error (เช่น placeBuy throw ตอน candle นี้)
    //   → ก่อน process candle ใหม่ reset เป็น idle เพื่อให้ trade loop กลับมาทำงาน
    //   - เดิม: ค้างที่ 'error' จนกว่า user จะ manually restart → bot ตาย
    //   - fix: candle ใหม่มา = auto-recover (สมมุติว่า error นั้น transient)
    if (this.bot.status === 'error' && !opts.replay) {
      logger.info({
        botId: this.bot._id.toString(),
        candleCloseTime: candle.closeTime,
      }, 'trader: auto-recovering from status=error on new candle');
      this._setBotStatus('idle', { lastError: '' });
    }

    // FIX-2026-07-15: in replay mode (called by reconcileKlines), candle อาจจะอยู่ "ก่อน"
    //   candles ที่ in-memory klineCache มีอยู่ ณ ปัจจุบัน (เพราะ WS ได้รับ candles ใหม่กว่าไปแล้ว)
    //   - ต้อง push candle นี้เข้า cache ก่อน (เพื่อให้ signal detection รันบน history ที่ตรง)
    //   - แล้ว advance lastSignalIndex ให้ตรง candle ที่ replay
    // - ในโหมดปกติ (จาก WS kline:closed), candle คือล่าสุดของ cache อยู่แล้ว
    // - ใช้ klineCache.seed() (มีอยู่แล้ว) โดยอ่าน cache ปัจจุบัน + append candle แล้วเขียนกลับ
    //   (หลีกเลี่ยงการเพิ่ม method ใหม่ใน klineCache)
    let replayedKlines = false;
    if (opts.replay) {
      const klines = klineCache.getAll(this.bot.symbol, this.bot.timeframe);
      // ถ้า candle.closeTime > cache.lastCandleCloseTime → append เข้า cache (replay candle ใหม่กว่าที่ cache มี)
      if (klines.length === 0 || candle.closeTime > klines[klines.length - 1].closeTime) {
        const symbol = this.bot.symbol;
        const timeframe = this.bot.timeframe;
        const merged = klines.concat([{
          symbol,
          timeframe,
          openTime: candle.openTime,
          closeTime: candle.closeTime,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume || 0,
          isClosed: true,
        }]);
        // seed() จะ slice(-maxCandles) ให้อัตโนมัติ
        klineCache.seed(merged);
        replayedKlines = true;
      }
    }

    const klines = klineCache.getAll(this.bot.symbol, this.bot.timeframe);
    const latestIdx = klines.length - 1;
    // FIX-2026-07-15: during replay, candle อาจจะอยู่ก่อน lastSignalIndex ใน array
    //   แต่ยังใหม่กว่า bot.lastSignalCloseTime (ที่ persist ใน DB)
    //   - ปัญหาเดิม: ใช้ `latestIdx <= lastSignalIndex` → replay candle เก่าใน cache = skip ทั้งหมด
    //   - fix: ถ้า opts.replay ให้ใช้ lastSignalCloseTime (DB) เป็น gate
    //          ถ้าไม่ใช่ replay → ใช้ lastSignalIndex (in-memory) เหมือนเดิม
    if (opts.replay) {
      const lastSigMs = this.bot.lastSignalCloseTime || 0;
      if (candle.closeTime <= lastSigMs) return; // signal เก่าแล้ว (เคย process แล้ว)
    } else {
      if (latestIdx <= this.lastSignalIndex) return; // signal เก่าแล้ว
    }

    // FIX-2026-07-15: ในโหมด replay ต้องตรวจ S1 ที่ candle ที่กำลัง replay (อาจจะอยู่ก่อน cache tail)
    //   ปัญหาเดิม: checkS1OnLatestCandle ตรวจแค่ klines[klines.length-1] (cache tail)
    //   ถ้า candle ที่ replay อยู่ก่อน cache tail จะตรวจผิด candle
    //   fix: ใช้ detectS1Signals แล้วเลือก signal ที่ closeTime ตรงกับ candle.closeTime
    //        ถ้าไม่ใช่ replay → checkS1OnLatestCandle เหมือนเดิม
    let signal = null;
    let xs1Skipped = false;
    // FIX-2026-07-25: per-bot XS1 toggle
    //   - xs1Enabled=true (default) → skip candle-wide dump (XS1=skip)
    //   - xs1Enabled=false → ใช้สัญญาณดั้งเดิม (S1 ปกติ, ไม่ skip)
    const s1Opts = {
      mult: this.bot.kcMult || 1.5,
      onlyDown: !!this.bot.s1OnlyDown,
      xs1Enabled: this.bot.xs1Enabled !== false,
    };
    if (opts.replay) {
      // FIX-2026-07-24: per-bot kcMult
      // FIX-2026-07-24: ส่ง onlyDown ตาม bot.s1OnlyDown (ถ้า true → skip bg 2→1)
      // FIX-2026-07-25: ส่ง xs1Enabled ตาม bot.xs1Enabled (per-bot toggle)
      const { signals } = signalEngine.detectS1Signals(klines, s1Opts);
      // หา signal ที่มี closeTime === candle.closeTime และใหม่กว่า lastSignalCloseTime
      const lastSigMs = this.bot.lastSignalCloseTime || 0;
      for (let i = signals.length - 1; i >= 0; i -= 1) {
        const s = signals[i];
        if (s.closeTime === candle.closeTime && s.closeTime > lastSigMs) {
          signal = s;
          break;
        }
      }
      // FIX-2026-07-25: ถ้า candle นี้เป็น S1 base match แต่ถูก filter จาก XS1
      //   → บันทึก audit row เพื่อให้เห็นใน Trade & Signal History
      if (!signal) {
        const baseCheck = signalEngine.checkS1OnLatestCandle(klines, s1Opts);
        // FIX-2026-07-25: ถ้า xs1Enabled=false → ไม่นับเป็น xs1Skipped (สัญญาณดั้งเดิมไม่ต้อง skip)
        if (baseCheck.xs1 && baseCheck.signal && this.bot.xs1Enabled !== false) {
          const s = baseCheck.signal;
          if (s.closeTime === candle.closeTime && s.closeTime > lastSigMs) {
            xs1Skipped = true;
            logger.info({
              botId: this.bot._id.toString(),
              symbol: this.bot.symbol,
              candleCloseTime: candle.closeTime,
              close: s.close,
              basisKC: s.basisKC, lowerKC: s.lowerKC,
            }, 'S1 signal skipped (XS1 anti-dump)');
            try {
              await Signal.create({
                botId: this.bot._id,
                symbol: this.bot.symbol,
                timeframe: this.bot.timeframe,
                type: 'S1',
                candleOpenTime: new Date(s.openTime),
                candleCloseTime: new Date(s.closeTime),
                closePrice: s.close,
                basisKC: s.basisKC,
                upperKC: s.upperKC,
                lowerKC: s.lowerKC,
                bgState: s.bgState,
                bgPrev: s.bgPrev,
                outcome: 'skipped',
                note: 'xs1_dumped',
              });
            } catch (err) {
              logger.warn({ err: err.message }, 'trader: failed to save xs1 audit row');
            }
          }
        }
      }
      if (xs1Skipped) {
        // FIX P1.6: ตอนนี้ persist audit แล้ว → early return พร้อม run stop-loss (mirror live path)
        //   เดิม: xs1Skipped = true แต่ flow ทำต่อ → hit `if (!signal) return` โดยไม่ run stop-loss
        //   fix: return ที่นี่แทน + รัน _checkStopLossOnUpperKC เพื่อ parity กับ live path
        this._checkStopLossOnUpperKC(candle).catch((err) =>
          logger.error({ err: err.message, stack: err.stack }, 'trader: stop_loss check threw'));
        return;
      }
    } else {
      // FIX-2026-07-24: per-bot kcMult + s1OnlyDown (skip bg 2→1)
      // FIX-2026-07-25: คืน { signal, xs1 } — xs1=true = S1 base match แต่ candle-wide dump → skip
      // FIX-2026-07-25: per-bot xs1Enabled toggle (false = ใช้สัญญาณดั้งเดิม, ไม่ skip)
      const live = signalEngine.checkS1OnLatestCandle(klines, s1Opts);
      // FIX-2026-07-25: ถ้า xs1Enabled=false → ไม่ skip แม้ live.xs1=true (ใช้ signal ปกติ)
      if (live.xs1 && this.bot.xs1Enabled !== false) {
        // FIX-2026-07-25: S1 base match แต่ candle-wide dump → skip ทันที + persist audit
        logger.info({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          candleCloseTime: candle.closeTime,
          close: candle.close,
          basisKC: live.signal ? live.signal.basisKC : null,
          lowerKC: live.signal ? live.signal.lowerKC : null,
        }, 'S1 signal skipped (XS1 anti-dump)');
        try {
          if (live.signal) {
            await Signal.create({
              botId: this.bot._id,
              symbol: this.bot.symbol,
              timeframe: this.bot.timeframe,
              type: 'S1',
              candleOpenTime: new Date(live.signal.openTime),
              candleCloseTime: new Date(live.signal.closeTime),
              closePrice: live.signal.close,
              basisKC: live.signal.basisKC,
              upperKC: live.signal.upperKC,
              lowerKC: live.signal.lowerKC,
              bgState: live.signal.bgState,
              bgPrev: live.signal.bgPrev,
              outcome: 'skipped',
              note: 'xs1_dumped',
            });
          }
        } catch (err) {
          logger.warn({ err: err.message }, 'trader: failed to save xs1 audit row');
        }
        // stop-loss check ยังคงต้องรัน
        this._checkStopLossOnUpperKC(candle).catch((err) =>
          logger.error({ err: err.message, stack: err.stack }, 'trader: stop_loss check threw'));
        return;
      }
      signal = live.signal;
    }
    if (!signal) {
      // FIX-2026-07-23: ไม่มี S1 signal แต่ candle ใหม่ — ยังต้องเช็ค stop-loss (อาจมี position ขาดทุนที่ต้องปิด)
      //   - ไม่ return เพราะ stop-loss เป็น concern แยกจาก S1 detection
      //   - run async แบบไม่ block (ถ้า throw ก็ catch ในตัวเอง)
      this._checkStopLossOnUpperKC(candle).catch((err) =>
        logger.error({ err: err.message, stack: err.stack }, 'trader: stop_loss check threw'));
      return;
    }
    // FIX-2026-07-23: มี S1 signal — ก่อนจะ place BUY ให้ปิด losing position ก่อน (ถ้ามี)
    //   - เคส candle ทะลุ upper-KC และมี position ขาดทุน → ปิดก่อน แล้วค่อยเปิดใหม่ (ถ้า TP รอบใหม่มา)
    //   - ถ้าไม่มี stop-loss path → ไม่กระทบ S1 signal ปกติ
    this._checkStopLossOnUpperKC(candle).catch((err) =>
      logger.error({ err: err.message, stack: err.stack }, 'trader: stop_loss check threw'));

    // กันยิงซ้ำ
    this.lastSignalIndex = latestIdx;
    // FIX-2026-07-15: persist lastSignalCloseTime (epoch ms) for crash/WS-gap recovery
    const candleCloseMs = candle.closeTime;
    Bot.updateOne(
      { _id: this.bot._id },
      { $max: { lastSignalCloseTime: candleCloseMs }, lastSignalAt: new Date() }
    ).catch((err) => logger.warn({ err: err.message }, 'trader: persist lastSignalCloseTime failed'));
    this.bot.lastSignalCloseTime = candleCloseMs;
    if (opts.replay && replayedKlines) {
      logger.info({
        botId: this.bot._id.toString(),
        trigger: opts.trigger || 'replay',
        candleCloseMs,
      }, 'trader: replay signal accepted');
    }

    logger.info({
      botId: this.bot._id.toString(),
      symbol: this.bot.symbol,
      candleCloseTime: candle.closeTime,
      close: signal.close,
    }, 'S1 signal detected');

    // บันทึก signal
    let signalDoc;
    try {
      signalDoc = await Signal.create({
        botId: this.bot._id,
        symbol: this.bot.symbol,
        timeframe: this.bot.timeframe,
        type: 'S1',
        candleOpenTime: new Date(candle.openTime),
        candleCloseTime: new Date(candle.closeTime),
        closePrice: signal.close,
        basisKC: signal.basisKC,
        upperKC: signal.upperKC,
        lowerKC: signal.lowerKC,
        bgState: signal.bgState,
        bgPrev: signal.bgPrev,
        outcome: 'detected',
      });
    } catch (err) {
      logger.error({ err: err.message }, 'trader: failed to save signal');
      return;
    }

    eventBus.emit('signal:new', { signalId: signalDoc._id, signal: signalDoc });

    // FIX-2026-07-13b: ลบ single-position lock เดิม — `currentTrade` ไม่ใช่ตัวนับ trade ทั้งหมด
    //   (มันเป็น pointer ของ trade ที่กำลัง retry/monitor เท่านั้น, ไม่ใช่ active slot counter)
    //   การล็อกที่บรรทัดเดิมทำให้บอท single-position ตลอด ทั้งที่ออกแบบให้รัน maxTrades ไม้พร้อมกัน
    //   ตอนนี้ใช้แค่ Trade.countDocuments เช็ค slot ตามที่ตั้งใจไว้

    // เช็คจำนวนไม้ (นับ trades ที่ยังไม่จบ — placed/filled/holding/selling)
    const activeTrades = await Trade.countDocuments({
      botId: this.bot._id,
      state: { $in: ['placed', 'filled', 'holding', 'selling'] },
    });
    if (activeTrades >= this.bot.maxTrades) {
      logger.info({
        botId: this.bot._id.toString(),
        activeTrades, maxTrades: this.bot.maxTrades,
      }, 'trader: max trades reached');
      await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'maxTrades reached' });
      return;
    }

    await this.placeBuy(signalDoc, candle);
  }

  // ─── BUY logic ─────────────────────────────────────
  async placeBuy(signalDoc, candle) {
    try {
      // FIX-2026-07-21: กัน placeBuy รัวจากหลายเส้นทาง (WS kline:closed + reconcileKlines sweep
      //   หรือ 2 sweep ที่มาชนกัน). ถ้ามี BUY กำลังวางอยู่ → skip signal นี้ทันที
      //   (จะถูก process รอบหน้าเมื่อ BUY ก่อนหน้าเสร็จ)
      if (this.buyInFlight) {
        logger.info({
          botId: this.bot._id.toString(),
          signalId: signalDoc._id.toString(),
        }, 'trader: skip BUY — another BUY in flight');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'buy_in_flight' });
        return;
      }

      // FIX-2026-07-21: per-bot cooldown ระหว่าง BUY orders — กัน 5 BUY ใน 1 วินาที
      //   ถ้า BUY ล่าสุดยังไม่ผ่าน cooldown → skip (signal จะถูก process รอบถัดไปถ้า candle ใหม่มา)
      const sinceLastBuy = Date.now() - this.lastBuyPlacedAt;
      if (this.lastBuyPlacedAt > 0 && sinceLastBuy < this.buyCooldownMs) {
        const waitMs = this.buyCooldownMs - sinceLastBuy;
        logger.info({
          botId: this.bot._id.toString(),
          signalId: signalDoc._id.toString(),
          sinceLastBuyMs: sinceLastBuy,
          waitMs,
        }, 'trader: skip BUY — cooldown active');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: `cooldown_${waitMs}ms` });
        // schedule retry ตอน cooldown หมด (กัน drop signal ที่อาจ valid)
        setTimeout(() => {
          if (this.running && this.bot.enabled && !this.buyInFlight) {
            logger.info({ botId: this.bot._id.toString() }, 'trader: cooldown expired — re-evaluating placeBuy');
            // re-enter placeBuy — internal guards จะเช็คอีกครั้ง
            this.placeBuy(signalDoc, candle).catch((err) =>
              logger.warn({ err: err.message }, 'trader: cooldown retry failed'));
          }
        }, waitMs).unref();
        return;
      }

      this.buyInFlight = true;

      // 1. ตรวจว่ามี symbol info
      if (!symbolInfo.getCached(this.bot.symbol)) {
        await symbolInfo.loadSymbol(this.bot.symbol);
      }

      // 2. กำหนด BUY price ที่ post-only safe (LIMIT_MAKER)
      //    FIX-2026-07-24 (v2): per-bot minSpreadTicks + no-skip เมื่อ spread แคบ
      //    - bot.minSpreadTicks (default 1):
      //        * 1 → ใช้ bid ตรงๆ (post-only guaranteed: bid < ask) — เหมาะ low-cap (RIF)
      //        * 2 → ต้องมี margin 1 tick: ใช้ bid - tickSize — เหมาะ mid/high-cap
      //        * 0 → ไม่สนใจ spread (อันตราย)
      //    - ถ้า bid >= ask (spread collapsed): ใช้ ask - tickSize (forced post-only)
      //    - ถ้าไม่มี bookTicker: fallback candle.close (suboptimal — log warning)
      //    - เดิม v1: skip เมื่อ spread < 2 ticks → RIF โดน skip ทุก signal
      //      fix v2: ไม่ skip แล้ว — ใช้ bid ตรงๆ + retry path ที่ step 8 กัน -2010
      const ticker = this.currentBookTicker;
      const info = symbolInfo.getCached(this.bot.symbol);
      const tickSize = info.priceFilter.tickSize;
      const tickDec = new Decimal(tickSize);
      // FIX-2026-07-24: per-bot minSpreadTicks (default 1, fallback 1)
      const minSpreadTicks = Number(this.bot.minSpreadTicks ?? 1);

      let bid;
      let ask;
      let refPrice;
      if (ticker && ticker.bid && ticker.ask) {
        bid = ticker.bid;
        ask = ticker.ask;
        const spread = new Decimal(ask).minus(bid);
        if (bid >= ask) {
          // spread collapsed (bid >= ask): ใช้ ask - 1 tick
          refPrice = new Decimal(ask).minus(tickSize);
          logger.warn({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            bid, ask, refPrice: refPrice.toString(),
          }, 'trader: spread collapsed (bid >= ask) — clamping BUY price to ask - tickSize');
        } else if (spread.lessThan(tickDec.times(minSpreadTicks))) {
          // FIX-2026-07-24 (v2): spread < minSpreadTicks ticks → ใช้ bid ตรงๆ
          //   (post-only guaranteed: bid < ask, fill เร็ว)
          //   ถ้า -2010 ตอน place order → retry path ที่ step 8 จัดการให้
          refPrice = new Decimal(bid);
          logger.info({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            bid, ask, spread: spread.toString(), tickSize, minSpreadTicks,
            refPrice: refPrice.toString(),
          }, 'trader: tight spread — using bid directly (post-only guaranteed, retry path will handle -2010)');
        } else {
          // ปกติ: ใช้ bid - 1 tick (safety กัน bookTicker stale)
          refPrice = new Decimal(bid).minus(tickSize);
        }
      } else {
        // no fresh ticker — risky fallback
        refPrice = candle.close;
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
        }, 'trader: no bookTicker for BUY price selection, falling back to candle.close');
      }

      // 3. คำนวณ qty
      const { qty } = symbolInfo.calcQtyFromCapital({
        symbol: this.bot.symbol,
        capitalUSDT: this.bot.capitalPerTrade,
        price: parseFloat(refPrice.toString()),
      });

      // 4. floor price ตาม tickSize — รับประกันว่า price < ask (post-only safe)
      const buyPrice = symbolInfo.floorPrice(refPrice, tickSize).toString();

      // 5. validate
      const validation = symbolInfo.validateOrder({ symbol: this.bot.symbol, price: buyPrice, qty });
      if (!validation.ok) {
        logger.warn({ botId: this.bot._id.toString(), reason: validation.reason }, 'trader: order validation failed');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'failed', note: validation.reason });
        this.buyInFlight = false; // FIX-2026-07-21: release on early-return
        await this.failSignal(signalDoc, `validation: ${validation.reason}`);
        return;
      }

      // 6. ── Pre-flight USDT balance check (FIX-2026-07-21: ใช้ free + locked) ──
      // ตรวจว่ามี USDT พอจ่าย notional + fee buffer
      //   - ก่อนหน้านี้ใช้แค่ free — ทำให้ locked USDT (BUY order ที่ match แล้วแต่ยังไม่ settled)
      //     ถูกนับซ้ำ → บอทคิดว่ามีเงินพอ แต่จริงๆ committed ไปแล้วใน BUY ก่อนหน้า
      //   - fix: ใช้ (free + locked) — accurate committed balance
      const requiredNotional = parseFloat(buyPrice) * parseFloat(qty);
      const feeBufferRate = fees.getMakerRate();
      const requiredWithBuffer = requiredNotional * (1 + feeBufferRate);

      try {
        const account = await binanceRest.getAccount();
        const usdtBal = (account.balances || []).find((b) => b.asset === 'USDT');
        const freeUsdt = usdtBal ? parseFloat(usdtBal.free) : 0;
        const lockedUsdt = usdtBal ? parseFloat(usdtBal.locked) : 0;
        const availableUsdt = freeUsdt + lockedUsdt; // FIX-2026-07-21
        if (availableUsdt < requiredWithBuffer) {
          const reason = `insufficient USDT balance: have ${availableUsdt.toFixed(4)} (free ${freeUsdt.toFixed(4)} + locked ${lockedUsdt.toFixed(4)}), need ${requiredWithBuffer.toFixed(4)} (notional ${requiredNotional.toFixed(4)} + fee buffer)`;
          logger.warn({ botId: this.bot._id.toString(), freeUsdt, lockedUsdt, requiredWithBuffer }, 'trader: balance check failed');
          await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: reason });
          this.buyInFlight = false; // FIX-2026-07-21: release on early-return
          await this.failSignal(signalDoc, reason);
          return;
        }
        logger.debug({ botId: this.bot._id.toString(), freeUsdt, lockedUsdt, requiredWithBuffer }, 'trader: balance check ok');
      } catch (balErr) {
        // ถ้า fetch balance fail (เช่น API key ไม่มี permission) — log warning แต่ไม่ block
        logger.warn({ err: balErr.message }, 'trader: balance pre-check failed (continuing)');
      }

      // 7. สร้าง Trade document
      const clientOrderId = this.makeClientOrderId('buy', candle.closeTime, 0);
      const trade = await Trade.create({
        botId: this.bot._id,
        signalId: signalDoc._id,
        symbol: this.bot.symbol,
        timeframe: this.bot.timeframe,
        buyClientOrderId: clientOrderId,
        buyPrice: parseFloat(buyPrice),
        buyQty: parseFloat(qty),
        buyPlacedAt: new Date(),
        buyStatus: 'NEW',
        state: 'placed',
        targetSellPrice: null,
      });
      this.currentTrade = trade;
      this._registerTrade(trade); // FIX 3

      // 8. วาง LIMIT_MAKER BUY (post-only) — ถ้า price จะ match ทันที = reject ทันที
      //    FIX-2026-07-24 (v2): ถ้า -2010 post-only rejected → retry 1 ครั้ง ด้วย ask - tickSize
      //      - bookTicker อาจ stale 200-500ms (ask ขยับลง) → ใช้ fresh ask จากอีก call ก่อน retry
      //      - ถ้า retry ก็ -2010 อีก → fail ตามเดิม (ไม่ infinite loop)
      let orderResp = await binanceRest.newOrder({
        symbol: this.bot.symbol,
        side: 'BUY',
        type: 'LIMIT_MAKER',
        quantity: qty,
        price: buyPrice,
        newClientOrderId: clientOrderId,
        recvWindow: config_recvWindow(),
      }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

      // FIX-2026-07-24 (v2): retry path — refetch fresh bookTicker แล้วลองด้วย ask - tickSize
      if (orderResp.error && orderResp.error.code === -2010) {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          placedPrice: buyPrice,
          binanceMsg: orderResp.error.msg,
        }, 'trader: -2010 on first attempt — refetching bookTicker and retrying with ask - tickSize');

        // refetch bookTicker (refresh stale data)
        try {
          const fresh = await binanceRest.getBookTicker(this.bot.symbol);
          if (fresh && fresh.bidPrice && fresh.askPrice) {
            const freshAsk = fresh.askPrice;
            const retryPrice = symbolInfo.floorPrice(new Decimal(freshAsk).minus(tickSize), tickSize).toString();
            const retryClientOrderId = this.makeClientOrderId('buy', candle.closeTime, 1);
            logger.info({
              botId: this.bot._id.toString(),
              symbol: this.bot.symbol,
              freshAsk,
              retryPrice,
            }, 'trader: retrying BUY with ask - tickSize (fresh bookTicker)');
            orderResp = await binanceRest.newOrder({
              symbol: this.bot.symbol,
              side: 'BUY',
              type: 'LIMIT_MAKER',
              quantity: qty,
              price: retryPrice,
              newClientOrderId: retryClientOrderId,
              recvWindow: config_recvWindow(),
            }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

            // update trade record's buyPrice + clientOrderId ถ้า retry สำเร็จ
            if (!orderResp.error) {
              await Trade.updateOne(
                { _id: trade._id },
                { buyPrice: parseFloat(retryPrice), buyClientOrderId: retryClientOrderId }
              );
              // FIX P3.2: sync in-memory Map<clientOrderId, trade> immediately
              //   - ปัญหา: retry สร้าง order ใหม่ด้วย clientOrderId ใหม่ → Map ยังมี key เก่า
              //     WS event ที่มาตามมาจะถูก Map.get(newId) → undefined → fall through DB lookup
              //     DB lookup อาจให้ partial doc (ไม่มี buyPrice) → ทำให้ handleSellFilled pnl=NaN
              //   - fix: unregister key เก่า + register key ใหม่ + update this.currentTrade/this.trade
              //     ทันทีที่ retry สำเร็จ ก่อน WS event จะมา
              const oldClientOrderId = trade.buyClientOrderId;
              if (oldClientOrderId && oldClientOrderId !== retryClientOrderId) {
                this.tradesByClientOrderId.delete(oldClientOrderId);
              }
              trade.buyClientOrderId = retryClientOrderId;
              trade.buyPrice = parseFloat(retryPrice);
              this.tradesByClientOrderId.set(retryClientOrderId, trade);
              if (this.currentTrade && String(this.currentTrade._id) === String(trade._id)) {
                this.currentTrade.buyClientOrderId = retryClientOrderId;
                this.currentTrade.buyPrice = parseFloat(retryPrice);
              }
              logger.info({
                botId: this.bot._id.toString(),
                symbol: this.bot.symbol,
                buyPrice: retryPrice,
                oldClientOrderId,
                newClientOrderId: retryClientOrderId,
              }, 'trader: retry succeeded — updated trade buyPrice + re-registered clientOrderId in Map');
            }
          }
        } catch (retryErr) {
          logger.warn({ err: retryErr.message }, 'trader: retry refetch/place failed');
          // fall through — orderResp.error ยังคงอยู่ → fail ตามปกติ
        }
      }

      if (orderResp.error) {
        const isPostOnly = orderResp.error.code === -2010;
        // FIX-2026-07-24: ใช้ msg จริงจาก Binance แทนการ assume "spread collapsed"
        //   - เดิม hardcode "bid X >= ask Y (spread collapsed)" ทั้งที่ spread จริงอาจปกติ
        //   - root cause: bookTicker ที่ใช้คำนวณ price อาจ stale (200-500ms ก่อน place order)
        //     → ask ขยับลงมาต่ำกว่า price ตอนที่ order ไปถึง Binance → -2010 post-only rejected
        //   - ข้อความใหม่: บอกทั้ง snapshot เก่า + Binance msg จริง + แนะนำ root cause
        const binanceMsg = orderResp.error.msg || '(no message)';
        const detail = isPostOnly
          ? `BUY -2010 post-only rejected (snapshot bid=${bid} ask=${ask}, placed=${buyPrice}) — Binance: ${binanceMsg}. bookTicker อาจ stale ตอน place order; ลอง retry ด้วย price ที่ต่ำกว่า ask มากขึ้น`
          : `BUY ${orderResp.error.code}: ${binanceMsg}`;
        logger.warn({
          botId: this.bot._id.toString(),
          err: orderResp.error,
          bid, ask, buyPrice, detail,
        }, 'trader: BUY order rejected');
        await Trade.updateOne(
          { _id: trade._id },
          { state: 'failed', error: detail }
        );
        await Signal.updateOne({ _id: signalDoc._id }, {
          outcome: 'failed',
          note: isPostOnly
            ? `BUY -2010 (placed ${buyPrice} ≥ ask ${ask} ตอนส่ง order) · snapshot bid=${bid} · Binance: ${binanceMsg}`
            : `BUY ${orderResp.error.code}: ${binanceMsg}`,
        });
        this._unregisterTrade(trade); // FIX 3
        this.currentTrade = null;
        this.buyInFlight = false; // FIX-2026-07-21: release on early-return
        eventBus.emit('trade:update', { tradeId: trade._id, state: 'failed' });
        return;
      }

      await Trade.updateOne(
        { _id: trade._id },
        {
          buyOrderId: orderResp.orderId,
          buyStatus: orderResp.status,
          buyPlacedAt: new Date(orderResp.transactTime || Date.now()),
        }
      );
      this.currentTrade.buyOrderId = orderResp.orderId;
      this.currentTrade.buyStatus = orderResp.status;

      logger.info({
        botId: this.bot._id.toString(),
        orderId: orderResp.orderId,
        price: buyPrice,
        qty,
        clientOrderId,
      }, 'trader: BUY placed');

      // FIX-2026-07-21: stamp cooldown + release inFlight flag เมื่อ BUY วางสำเร็จ
      this.lastBuyPlacedAt = Date.now();
      this.buyInFlight = false;

      // FIX P2.1+P3.4: ใช้ _setBotStatus serialized — กัน race กับ error/idle
      this._setBotStatus('waiting_fill', { lastError: '', extra: { lastSignalAt: new Date() } });
      eventBus.emit('trade:update', { tradeId: trade._id, state: 'placed' });

      // 9. Schedule retry check (เช็คสถานะทุก retryTimeMin นาที)
      await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'order_placed' });
      this.scheduleRetryCheck(candle, signalDoc);
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'trader: placeBuy error');
      // FIX-2026-07-21: release flag on error path too
      this.buyInFlight = false;
      // FIX P2.1+P3.4: serialized error status (ถ้า candle ใหม่มา = P1.1 จะ reset เป็น idle)
      this._setBotStatus('error', { lastError: err.message });
    }
  }

  // helper: บันทึก failure + reset state
  async failSignal(signalDoc, note) {
    await Bot.updateOne({ _id: this.bot._id }, { status: 'idle', lastError: note });
    this.currentTrade = null;
    eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
    // FIX-2026-07-24: dedicated event สำหรับ Telegram notifier — เดิมไม่มี event สำหรับ "เงินหมด"
    //   note ขึ้นต้นด้วย "insufficient USDT balance" เมื่อ balance check fail (trader.js:761)
    if (typeof note === 'string' && note.startsWith('insufficient USDT balance')) {
      eventBus.emit('insufficient:balance', {
        botId: this.bot._id,
        symbol: this.bot.symbol,
        note,
      });
    }
  }

  scheduleRetryCheck(candle, signalDoc) {
    if (!this.running) return;
    if (this.retryCheckTimer) clearTimeout(this.retryCheckTimer);
    this.retryCheckTimer = setTimeout(() => {
      this.checkBuyOrder(signalDoc, candle);
    }, this.bot.retryTimeMin * 60 * 1000);
  }

  async checkBuyOrder(signalDoc, candle) {
    if (!this.running || !this.currentTrade) return;
    try {
      const trade = this.currentTrade;
      // FIX-2026-07-23 #3: state guard — ถ้า trade เคลื่อนผ่าน 'placed' ไปแล้ว (เช่น
      // handlePartialBuyFill ย้ายไป 'selling' หลังจาก partial fill) → อย่าทำ cancel/replace
      // เพราะ BUY อาจถูก cancel ไปแล้ว + SELL กำลัง pending อยู่ → เราจะ overwrite state='selling'
      // เป็น 'cancelled' ทำให้ SELL กลายเป็น orphan ที่ DB ไม่รู้จัก
      if (trade.state !== 'placed') {
        logger.debug({
          botId: this.bot._id.toString(),
          tradeId: trade._id?.toString(),
          state: trade.state,
          orderId: trade.buyOrderId,
        }, 'trader: checkBuyOrder — trade no longer placed, skipping retry');
        if (this.retryCheckTimer) {
          clearTimeout(this.retryCheckTimer);
          this.retryCheckTimer = null;
        }
        return;
      }
      // 1. ดึงสถานะ order
      const order = await binanceRest.getOrder({
        symbol: this.bot.symbol,
        orderId: trade.buyOrderId,
      }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

      if (order.error) {
        logger.error({ botId: this.bot._id.toString(), err: order.error }, 'trader: getOrder failed');
        this.scheduleRetryCheck(candle, signalDoc);
        return;
      }

      // 2. ตรวจสถานะ
      if (order.status === 'FILLED') {
        await this.handleBuyFilled(trade, order, signalDoc);
        return;
      }

      if (order.status === 'PARTIALLY_FILLED') {
        // partial → จัดการส่วนที่ได้ + cancel ที่เหลือ
        logger.info({ botId: this.bot._id.toString(), executedQty: order.executedQty }, 'trader: partial fill');
        await this.handlePartialBuyFill(trade, order, signalDoc, candle);
        return;
      }

      // 3. NEW / ACCEPTED — ยังไม่ fill → เช็ค best bid
      const newBid = this.currentBookTicker ? this.currentBookTicker.bid : null;
      const originalPrice = trade.buyPrice;
      const retryMax = this.bot.retryMax ?? 1;
      const priceThreshold = 0.000001; // 0.0001%

      // ถ้าไม่มี bookTicker → รอรอบหน้า
      if (!newBid) {
        this.scheduleRetryCheck(candle, signalDoc);
        return;
      }

      const movedEnough = Math.abs(newBid - originalPrice) / originalPrice > priceThreshold;
      const remainingRetries = retryMax - (trade.retryCount || 0);

      if (movedEnough && remainingRetries > 0) {
        // bid ขยับเกิน threshold → cancel + re-place
        logger.info({
          botId: this.bot._id.toString(),
          originalPrice,
          newBid,
          retryCount: trade.retryCount + 1,
          retryMax,
        }, 'trader: best bid moved → cancel & re-place');

        // FIX 2: cancelAndRecheck คืนค่า — เราตัดสินใจตามสถานะจริงเท่านั้น
        const cancelResult = await this.cancelAndRecheck(trade);
        const reCheck = await binanceRest.getOrder({
          symbol: this.bot.symbol,
          orderId: trade.buyOrderId,
        }).catch(() => null);

        // Case A: order FILLED ระหว่าง cancel → handle normally
        if (reCheck && reCheck.status === 'FILLED') {
          await this.handleBuyFilled(trade, reCheck, signalDoc);
          return;
        }

        // Case B: PARTIALLY_FILLED → handle partial
        if (reCheck && reCheck.status === 'PARTIALLY_FILLED') {
          logger.info({ botId: this.bot._id.toString(), executedQty: reCheck.executedQty }, 'trader: partial fill during retry');
          await this.handlePartialBuyFill(trade, reCheck, signalDoc, candle);
          return;
        }

        // FIX 2 Case C: cancel REST call fail + order NEW → อย่า mark cancelled
        // (order อาจยังมีชีวิตอยู่ เราจะเสีย asset ถ้า mark cancelled แล้ว replace)
        if (reCheck && reCheck.status === 'NEW' && !cancelResult.ok) {
          logger.warn({
            botId: this.bot._id.toString(),
            cancelError: cancelResult.error,
          }, 'trader: cancel failed + order still NEW → defer retry, do NOT mark cancelled');
          this.scheduleRetryCheck(candle, signalDoc);
          return;
        }

        // FIX 2 Case D: getOrder fail + cancel ไม่ได้ confirmed -2011 → อย่า mark cancelled
        if (!reCheck && !cancelResult.wasUnknown) {
          logger.warn({ botId: this.bot._id.toString() }, 'trader: cannot determine order state, deferring');
          this.scheduleRetryCheck(candle, signalDoc);
          return;
        }

        // Case E: confirmed CANCELLED / EXPIRED → ปลอดภัย re-place
        if (reCheck && (reCheck.status === 'CANCELED' || reCheck.status === 'EXPIRED')) {
          await Trade.updateOne(
            { _id: trade._id },
            { state: 'cancelled', buyStatus: reCheck.status }
          );
          await this.rePlaceBuy(trade, signalDoc, candle, newBid);
          return;
        }

        // Fallback (ไม่ควรมาถึง) — defer ไว้ก่อน
        logger.error({
          botId: this.bot._id.toString(),
          reCheck, cancelResult,
        }, 'trader: unexpected state in cancel-and-replace, deferring');
        this.scheduleRetryCheck(candle, signalDoc);
        return;
      }

      if (movedEnough && remainingRetries <= 0) {
        // bid ขยับ แต่ retry หมดแล้ว → cancel + จบรอบ (signal expired)
        logger.info({
          botId: this.bot._id.toString(),
          originalPrice,
          newBid,
          retryCount: trade.retryCount,
          retryMax,
        }, 'trader: bid moved but retryMax reached → cancel & expire signal');

        const cancelResult = await this.cancelAndRecheck(trade);
        const reCheck = await binanceRest.getOrder({
          symbol: this.bot.symbol,
          orderId: trade.buyOrderId,
        }).catch(() => null);

        if (reCheck && reCheck.status === 'FILLED') {
          // match พอดีระหว่าง cancel → ดำเนินการขายตามปกติ
          await this.handleBuyFilled(trade, reCheck, signalDoc);
          return;
        }

        if (reCheck && reCheck.status === 'PARTIALLY_FILLED') {
          await this.handlePartialBuyFill(trade, reCheck, signalDoc, candle);
          return;
        }

        // ยืนยัน cancelled แล้วเท่านั้น → expire
        if (reCheck && (reCheck.status === 'CANCELED' || reCheck.status === 'EXPIRED')) {
          await Trade.updateOne(
            { _id: trade._id },
            { state: 'cancelled', buyStatus: reCheck.status, error: `retryMax (${retryMax}) reached` }
          );
          await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'expired', note: `retryMax ${retryMax} reached, bid moved` });
          await Bot.updateOne({ _id: this.bot._id }, { status: 'idle', lastError: `signal expired: retryMax ${retryMax} reached` });
          this._unregisterTrade(trade); // FIX 3
          this.currentTrade = null;
          eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
          return;
        }

        // ไม่แน่ใจ → defer แทน expire
        logger.warn({
          botId: this.bot._id.toString(),
          reCheck, cancelResult,
        }, 'trader: retryMax reached but order state unclear, deferring');
        this.scheduleRetryCheck(candle, signalDoc);
        return;
      }

      // 4. bid ยังอยู่ที่เดิม (order ยังอยู่ใน best bid) → รอรอบถัดไป
      logger.debug({
        botId: this.bot._id.toString(),
        orderPrice: originalPrice,
        bestBid: newBid,
        retryCount: trade.retryCount,
        retryMax,
      }, 'trader: order still at best bid → wait for next retry cycle');
      this.scheduleRetryCheck(candle, signalDoc);
    } catch (err) {
      logger.error({ err: err.message }, 'trader: checkBuyOrder error');
    }
  }

  // FIX 2: cancel order + คืนค่าให้ caller ตัดสินใจ
  // -2011 = Unknown order (อาจ fill ไปแล้ว) → ถือว่า ok, wasUnknown=true
  // error อื่น ๆ → ok=false, error=...
  async cancelAndRecheck(trade) {
    const cancelResp = await binanceRest.cancelOrder({
      symbol: this.bot.symbol,
      orderId: trade.buyOrderId,
    }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

    if (cancelResp.error && cancelResp.error.code === -2011) {
      // Order already filled/cancelled/expired — this is informational, not a failure
      logger.debug({ botId: this.bot._id.toString(), orderId: trade.buyOrderId }, 'trader: cancel got -2011 (order already gone)');
      return { ok: true, wasUnknown: true, error: cancelResp.error };
    }
    if (cancelResp.error) {
      logger.warn({ botId: this.bot._id.toString(), err: cancelResp.error }, 'trader: cancel failed (non -2011)');
      return { ok: false, wasUnknown: false, error: cancelResp.error };
    }
    return { ok: true, wasUnknown: false };
  }

  async rePlaceBuy(prevTrade, signalDoc, candle, newBid) {
    try {
      const info = symbolInfo.getCached(this.bot.symbol);
      const tickSize = info.priceFilter.tickSize;
      const ticker = this.currentBookTicker;

      // เหมือน placeBuy: clamp BUY price ให้ < ask กัน -2010 post-only rejected
      let refPrice;
      let bidForLog;
      let askForLog;
      if (ticker && ticker.bid && ticker.ask && newBid) {
        bidForLog = ticker.bid;
        askForLog = ticker.ask;
        if (newBid < ticker.ask) {
          refPrice = newBid;
        } else {
          refPrice = new Decimal(ticker.ask).minus(tickSize);
          logger.warn({
            botId: this.bot._id.toString(),
            bid: ticker.bid, ask: ticker.ask, newBid, refPrice: refPrice.toString(),
          }, 'trader: rePlace — spread collapsed, clamping to ask - tickSize');
        }
      } else {
        refPrice = newBid || candle.close;
      }

      const buyPrice = symbolInfo.floorPrice(refPrice, tickSize).toString();

      // safety net — floor ยังให้ price >= ask (เช่น tickSize มากกว่า spread) → abort
      if (bidForLog !== undefined && askForLog !== undefined && parseFloat(buyPrice) >= askForLog) {
        logger.warn({
          botId: this.bot._id.toString(),
          bid: bidForLog, ask: askForLog, buyPrice,
        }, 'trader: rePlaceBuy clamped price still >= ask, aborting');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'expired', note: 'spread too tight to re-place' });
        await Bot.updateOne({ _id: this.bot._id }, { status: 'idle' });
        this._unregisterTrade(prevTrade); // FIX 3
        this.currentTrade = null;
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
        return;
      }

      const validation = symbolInfo.validateOrder({ symbol: this.bot.symbol, price: buyPrice, qty: prevTrade.buyQty });
      if (!validation.ok) {
        logger.warn({ botId: this.bot._id.toString(), reason: validation.reason }, 'trader: rePlace validation failed');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'expired', note: validation.reason });
        await Bot.updateOne({ _id: this.bot._id }, { status: 'idle' });
        this._unregisterTrade(prevTrade); // FIX 3
        this.currentTrade = null;
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
        return;
      }

      const newClientOrderId = this.makeClientOrderId('buy', candle.closeTime, prevTrade.retryCount + 1);
      const orderResp = await binanceRest.newOrder({
        symbol: this.bot.symbol,
        side: 'BUY',
        type: 'LIMIT_MAKER',
        quantity: prevTrade.buyQty.toString(),
        price: buyPrice,
        newClientOrderId: newClientOrderId,
        recvWindow: config_recvWindow(),
      }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

      if (orderResp.error) {
        logger.warn({
          botId: this.bot._id.toString(),
          err: orderResp.error,
          bid: bidForLog, ask: askForLog, buyPrice,
        }, 'trader: rePlace rejected');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'expired', note: 'rePlace rejected' });
        await Bot.updateOne({ _id: this.bot._id }, { status: 'idle' });
        this._unregisterTrade(prevTrade); // FIX 3
        this.currentTrade = null;
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
        return;
      }

      // FIX 3: unregister trade เก่า (BUY clientOrderId เปลี่ยน) — แต่ SELL (ถ้ามี) ยังคงอยู่
      // prevTrade มีแค่ buyClientOrderId (ยังไม่มี sell) เลย unregister ได้ตรง ๆ
      this._unregisterTrade(prevTrade);

      const newTrade = await Trade.create({
        botId: this.bot._id,
        signalId: signalDoc._id,
        symbol: this.bot.symbol,
        timeframe: this.bot.timeframe,
        buyClientOrderId: newClientOrderId,
        buyPrice: parseFloat(buyPrice),
        buyQty: prevTrade.buyQty,
        buyPlacedAt: new Date(),
        buyStatus: orderResp.status,
        buyOrderId: orderResp.orderId,
        retryCount: prevTrade.retryCount + 1,
        state: 'placed',
      });
      this.currentTrade = newTrade;
      this._registerTrade(newTrade); // FIX 3

      eventBus.emit('trade:update', { tradeId: newTrade._id, state: 'placed' });
      this.scheduleRetryCheck(candle, signalDoc);
    } catch (err) {
      logger.error({ err: err.message }, 'trader: rePlaceBuy error');
    }
  }

  // FIX 4: handleBuyFilled mutex ป้องกัน double-SELL จาก WS+retryTimer race
  async handleBuyFilled(trade, order, signalDoc) {
    const tradeId = trade._id.toString();
    if (this.handleBuyFilledLocks.has(tradeId)) {
      logger.debug({ tradeId }, 'trader: handleBuyFilled already running, skip duplicate');
      return this.handleBuyFilledLocks.get(tradeId);
    }
    const promise = this._handleBuyFilledImpl(trade, order, signalDoc);
    this.handleBuyFilledLocks.set(tradeId, promise);
    try {
      return await promise;
    } finally {
      this.handleBuyFilledLocks.delete(tradeId);
    }
  }

  async _handleBuyFilledImpl(trade, order, signalDoc) {
    try {
      const filledQty = parseFloat(order.executedQty);
      const avgPrice = parseFloat(order.price) || parseFloat(order.cummulativeQuoteQty) / filledQty;

      // FIX 1: idempotent state update — ใช้ guard { state: 'placed' | 'filled' | 'retrying' }
      // กัน double-update ถ้า 2 path (WS + retry) มาถึงพร้อมกัน
      const upd = await Trade.updateOne(
        {
          _id: trade._id,
          state: { $in: ['placed', 'filled', 'retrying', 'holding'] },
        },
        {
          state: 'filled',
          buyStatus: 'FILLED',
          buyPrice: avgPrice,
          buyQty: filledQty,
          buyQuoteQty: parseFloat(order.cummulativeQuoteQty),
          buyFilledAt: new Date(order.updateTime || Date.now()),
        }
      );
      if (upd.modifiedCount === 0) {
        // ถูก process ไปแล้ว (state เปลี่ยนเป็น selling/sold/cancelled)
        logger.debug({ tradeId: trade._id.toString() }, 'trader: handleBuyFilled skipped — trade already in terminal state');
        return;
      }

      // FIX-2026-07-24: emit 'filled' (BUY filled) เพื่อให้ telegramNotifier ส่ง buyFilled
      //   - ก่อนหน้านี้ state กระโดด placed -> filled -> selling โดยไม่ emit 'filled'
      //   - telegramNotifier filter เฉพาะ 'holding' / 'sold' → skip 'filled' และ 'selling'
      //   - ผลคือ BUY filled ไม่เคยถูกแจ้งเตือน
      eventBus.emit('trade:update', { tradeId: trade._id, state: 'filled' });

      // คำนวณ sell price
      const feeRate = fees.getMakerRate();
      const sellPriceRaw = fees.calcSellPrice({
        buyPrice: avgPrice,
        tpPercent: this.bot.tpPercent,
        feeRate,
      });
      const info = symbolInfo.getCached(this.bot.symbol);
      const sellPrice = symbolInfo.roundPrice(sellPriceRaw, info.priceFilter.tickSize).toString();

      // FIX 1: ถ้า validation fail (เช่น tick size / min notional) → MARKET fallback
      const validation = symbolInfo.validateOrder({ symbol: this.bot.symbol, price: sellPrice, qty: filledQty });
      if (!validation.ok) {
        logger.warn({ reason: validation.reason }, 'trader: SELL validation failed → MARKET fallback');
        const ok = await this._emergencyMarketSell(trade, filledQty, avgPrice, sellPrice, `validation: ${validation.reason}`);
        if (!ok) {
          // FIX 1: schedule retry แทนการค้างเฉย ๆ
          await Trade.updateOne({ _id: trade._id }, { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: validation.reason });
          await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
          eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
          eventBus.emit('trade:update', { tradeId: trade._id, state: 'holding' });
          this.scheduleHoldingRetry(trade, filledQty, avgPrice, sellPrice);
        }
        return;
      }

      // FIX 1: ลอง LIMIT_MAKER ก่อน — ถ้า reject (-2010 Duplicate, MIN_NOTIONAL ฯลฯ)
      // → fallback เป็น MARKET ทันที (emergency exit)
      const sellClientOrderId = this.makeClientOrderId('sell', order.updateTime || Date.now(), trade.retryCount || 0);
      const sellResp = await binanceRest.newOrder({
        symbol: this.bot.symbol,
        side: 'SELL',
        type: 'LIMIT_MAKER',
        quantity: filledQty.toString(),
        price: sellPrice,
        newClientOrderId: sellClientOrderId,
        recvWindow: config_recvWindow(),
      }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

      if (sellResp.error) {
        logger.warn({
          err: sellResp.error,
          tradeId: trade._id.toString(),
        }, 'trader: SELL LIMIT_MAKER rejected → trying MARKET fallback');

        const ok = await this._emergencyMarketSell(trade, filledQty, avgPrice, sellPrice,
          `${sellResp.error.code}: ${sellResp.error.msg}`);
        if (!ok) {
          // ทั้ง LIMIT และ MARKET fail → mark holding + schedule retry
          await Trade.updateOne({
            _id: trade._id,
            state: { $in: ['filled', 'holding'] },
          }, { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: `${sellResp.error.code}: ${sellResp.error.msg}` });
          await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
          eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
          eventBus.emit('trade:update', { tradeId: trade._id, state: 'holding' });
          this.scheduleHoldingRetry(trade, filledQty, avgPrice, sellPrice);
        }
        return;
      }

      await Trade.updateOne(
        { _id: trade._id },
        {
          sellOrderId: sellResp.orderId,
          sellClientOrderId,
          sellPrice: parseFloat(sellPrice),
          sellQty: filledQty,
          sellStatus: sellResp.status,
          sellPlacedAt: new Date(),
          targetSellPrice: parseFloat(sellPrice),
          state: 'selling',
        }
      );
      this.currentTrade.sellOrderId = sellResp.orderId;
      this.currentTrade.sellClientOrderId = sellClientOrderId;
      this.currentTrade.state = 'selling';
      // FIX 3: register sell clientOrderId ใน Map (กรณี currentTrade เปลี่ยนทีหลัง)
      this._registerTrade({ buyClientOrderId: trade.buyClientOrderId, sellClientOrderId });

      logger.info({
        botId: this.bot._id.toString(),
        buyPrice: avgPrice,
        sellPrice,
        qty: filledQty,
      }, 'trader: SELL placed');

      await Bot.updateOne({ _id: this.bot._id }, { status: 'selling', lastError: '' });
      await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'filled' });
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'selling' });
      eventBus.emit('trade:update', { tradeId: trade._id, state: 'selling' });
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'trader: handleBuyFilled error');
    }
  }

  // FIX 1: emergency MARKET SELL — ป้องกัน asset stranded
  // return true ถ้าสำเร็จ (state → selling), false ถ้า fail (ต้อง schedule retry)
  async _emergencyMarketSell(trade, qty, buyPrice, targetSellPrice, reasonNote) {
    try {
      const marketSellId = this.makeClientOrderId('em-sell', Date.now(), 0);
      const resp = await binanceRest.newOrder({
        symbol: this.bot.symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: qty.toString(),
        newClientOrderId: marketSellId,
        recvWindow: config_recvWindow(),
      }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

      if (resp.error) {
        logger.error({
          err: resp.error,
          tradeId: trade._id.toString(),
        }, 'trader: EMERGENCY MARKET SELL also failed');
        return false;
      }

      // MARKET fill ทันที → คำนวณ avgPrice จาก fills หรือใช้ cummulativeQuoteQty/executedQty
      const avgSell = parseFloat(resp.price)
        || parseFloat(resp.avgPrice)
        || (parseFloat(resp.cummulativeQuoteQty) / parseFloat(resp.executedQty));
      const executed = parseFloat(resp.executedQty);

      // คำนวณ PnL ทันที (เพราะ market fill)
      const feeRate = fees.getMakerRate();
      const pnl = fees.calcPnl({
        buyPrice,
        sellPrice: avgSell,
        qty: executed,
        feeRate,
      });

      await Trade.updateOne(
        {
          _id: trade._id,
          // FIX-2026-07-23: เพิ่ม 'stopping' เพื่อให้ stop-loss path (atomic claim → 'stopping') ใช้ฟังก์ชันนี้ได้
          state: { $in: ['filled', 'holding', 'stopping'] },
        },
        {
          state: 'sold',
          sellOrderId: resp.orderId,
          sellClientOrderId: marketSellId,
          sellPrice: avgSell,
          sellQty: executed,
          sellQuoteQty: parseFloat(resp.cummulativeQuoteQty),
          sellStatus: resp.status,
          sellFilledAt: new Date(resp.updateTime || Date.now()),
          sellPlacedAt: new Date(),
          targetSellPrice: parseFloat(targetSellPrice),
          realizedPnl: pnl.net,
          pnlPercent: pnl.pnlPercent,
          error: `${reasonNote} → MARKET fallback used`,
        }
      );

      // update bot stats — ใช้ $inc (atomic) กัน lost update
      await Bot.updateOne(
        { _id: this.bot._id },
        {
          $inc: {
            totalPnl: pnl.net,
            totalTrades: 1,
            winTrades: (pnl.net > 0 ? 1 : 0),
          },
          $set: { status: 'idle', lastError: '' },
        }
      );

      this._unregisterTrade(trade);
      this.currentTrade = null;
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
      eventBus.emit('trade:update', { tradeId: trade._id, state: 'sold' });
      logger.warn({
        tradeId: trade._id.toString(),
        pnl: pnl.net,
        avgSell,
      }, 'trader: EMERGENCY MARKET SELL succeeded');
      return true;
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'trader: _emergencyMarketSell error');
      return false;
    }
  }

  // FIX 1: schedule holding retry — พยายาม SELL ใหม่ทุก 30s สำหรับ stranded positions
  // FIX P1.5: เปลี่ยนเป็น async เพื่อรองรับ counter guard ที่มี await
  async scheduleHoldingRetry(trade, qty, buyPrice, targetSellPrice) {
    if (this.holdingRetryTimer) clearTimeout(this.holdingRetryTimer);
    if (!this.running) return;

    // FIX P1.5: counter ป้องกัน retry loop infinite — max 10 ครั้ง (~10 นาที)
    //   เดิม: schedule 60s เรื่อยๆ ไม่จำกัด → ถ้า MARKET SELL fail ตลอด (เช่น API key หมดสิทธิ์) → ค้างเป็นชั่วโมง
    //   fix: นับ counter, ถ้าเกิน 10 ครั้ง → mark stuck + alert telegram แทนการ retry
    const MAX_HOLDING_RETRIES = 10;
    this.holdingRetryCount += 1;
    if (this.holdingRetryCount > MAX_HOLDING_RETRIES) {
      logger.error({
        tradeId: trade._id.toString(),
        botId: this.bot._id.toString(),
        symbol: this.bot.symbol,
        retryCount: this.holdingRetryCount - 1,
        maxRetries: MAX_HOLDING_RETRIES,
      }, 'trader: holding retry exhausted — MANUAL INTERVENTION REQUIRED');
      // alert telegram — ใช้ eventBus เพื่อไม่ couple กับ telegramNotifier
      eventBus.emit('insufficient:balance', {
        botId: this.bot._id,
        symbol: this.bot.symbol,
        note: `⚠️ Holding retry exhausted after ${MAX_HOLDING_RETRIES} attempts — manual intervention required (trade ${trade._id})`,
      });
      // mark stuck ใน trade เพื่อให้เห็นใน UI
      await Trade.updateOne(
        { _id: trade._id, state: 'holding' },
        { state: 'holding', error: `stuck: holding_retry_exhausted_${MAX_HOLDING_RETRIES}` }
      ).catch(() => null);
      // reset counter เพื่อไม่ให้ค้าง
      this.holdingRetryCount = 0;
      return;
    }

    this.holdingRetryTimer = setTimeout(async () => {
      if (!this.running) return;
      try {
        // เช็คว่า trade ยังเป็น holding + มี asset จริง
        const fresh = await Trade.findById(trade._id);
        if (!fresh || fresh.state !== 'holding') {
          logger.info({ tradeId: trade._id.toString(), state: fresh?.state }, 'trader: holding retry — trade no longer holding, abort');
          // FIX P1.5: reset counter เมื่อ state เปลี่ยน (success path)
          this.holdingRetryCount = 0;
          return;
        }

        // ตรวจ base asset balance จริง
        // FIX: เช็ค free + locked เพราะ asset อาจถูก lock ใน SELL order ที่ค้างอยู่
        // (เคยมีเคส: SELL reject → asset ถูก lock ใน orphan order → free=0 แต่ locked > 0
        //         → retry loop forever โดยไม่ realize ว่า SELL ยังมีชีวิตอยู่)
        const baseAsset = this.bot.symbol.replace(/USDT$|USDC$|BUSD$/, '');
        const account = await binanceRest.getAccount();
        const bal = (account.balances || []).find((b) => b.asset === baseAsset);
        const freeQty = bal ? parseFloat(bal.free) : 0;
        const lockedQty = bal ? parseFloat(bal.locked) : 0;
        const totalQty = freeQty + lockedQty;

        if (totalQty < qty * 0.95) {
          logger.warn({
            tradeId: trade._id.toString(),
            freeQty, lockedQty, totalQty, expected: qty, baseAsset,
            retryCount: this.holdingRetryCount,
          }, 'trader: holding retry — asset balance too low (free+locked < expected), will retry in 60s');
          this.scheduleHoldingRetry(trade, qty, buyPrice, targetSellPrice);
          return;
        }

        // FIX: ถ้า trade มี sellOrderId อยู่แล้ว → เช็ค order status ก่อน
        // (กรณี SELL ถูก place ไปแล้วแต่ trade.state ยัง stuck ที่ holding)
        if (trade.sellOrderId) {
          const order = await binanceRest.getOrder({
            symbol: this.bot.symbol,
            orderId: trade.sellOrderId,
          }).catch(() => null);
          if (order) {
            if (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') {
              logger.warn({
                tradeId: trade._id.toString(),
                sellOrderId: trade.sellOrderId,
                orderStatus: order.status,
                lockedQty,
              }, 'trader: holding retry — asset locked in live SELL, syncing DB to selling');
              await Trade.updateOne(
                { _id: trade._id, state: 'holding' },
                { state: 'selling', sellStatus: order.status }
              );
              // FIX P1.5: reset counter เมื่อเจอ live SELL
              this.holdingRetryCount = 0;
              return; // SELL ยังมีชีวิต → ปล่อยให้ order:update handler จัดการต่อ
            }
            if (order.status === 'FILLED') {
              logger.warn({
                tradeId: trade._id.toString(),
                sellOrderId: trade.sellOrderId,
              }, 'trader: holding retry — SELL FILLED, finalizing via handleSellFilled');
              this.currentTrade = fresh;
              // FIX-2026-07-13: ใช้ order.cummulativeQuoteQty/executedQty ถ้า order.avgPrice หายไป
              // (LIMIT_MAKER SELL ที่ fill แบบเต็ม → Binance อาจไม่ส่ง avgPrice แต่มี price=TP ซึ่งไม่ใช่ fill price จริง)
              const filledQty = parseFloat(order.executedQty);
              const cumQuote = parseFloat(order.cummulativeQuoteQty);
              const realAvgPrice = (order.avgPrice && parseFloat(order.avgPrice))
                || (cumQuote && filledQty > 0 ? cumQuote / filledQty : 0);
              await this.handleSellFilled({
                executedQty: order.executedQty,
                avgPrice: realAvgPrice,
                cumulativeQuoteQty: order.cummulativeQuoteQty,
                ts: order.updateTime,
              }, fresh);
              // FIX P1.5: reset counter หลัง success
              this.holdingRetryCount = 0;
              return;
            }
            if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
              logger.warn({
                tradeId: trade._id.toString(),
                sellOrderId: trade.sellOrderId,
                orderStatus: order.status,
              }, 'trader: holding retry — sellOrderId is CANCELED/EXPIRED, clearing it');
              await Trade.updateOne(
                { _id: trade._id, state: 'holding' },
                { $unset: { sellOrderId: '', sellClientOrderId: '' } }
              );
              trade.sellOrderId = null;
              trade.sellClientOrderId = null;
              // fall through to MARKET SELL below
            }
          }
        }

        logger.warn({
          tradeId: trade._id.toString(),
          freeQty, qty,
          retryCount: this.holdingRetryCount,
        }, 'trader: holding retry — found asset, attempting MARKET SELL');

        // ลอง MARKET ก่อน (LIMIT_MAKER มัก reject ซ้ำด้วยสาเหตุเดิม)
        const retrySellId = this.makeClientOrderId('retry-sell', Date.now(), 0);
        const resp = await binanceRest.newOrder({
          symbol: this.bot.symbol,
          side: 'SELL',
          type: 'MARKET',
          quantity: freeQty.toString(),
          newClientOrderId: retrySellId,
          recvWindow: config_recvWindow(),
        }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

        if (resp.error) {
          logger.error({ err: resp.error, tradeId: trade._id.toString(), retryCount: this.holdingRetryCount }, 'trader: holding retry MARKET SELL failed');
          // FIX P1.5: counter จะถูก increment ใน scheduleHoldingRetry call ถัดไป
          //   ถ้าเกิน MAX_HOLDING_RETRIES จะ alert + abort
          if (this.running) {
            this.holdingRetryTimer = setTimeout(() => this.scheduleHoldingRetry(trade, qty, buyPrice, targetSellPrice), 60 * 1000);
          }
          return;
        }

        const avgSell = parseFloat(resp.price)
          || parseFloat(resp.avgPrice)
          || (parseFloat(resp.cummulativeQuoteQty) / parseFloat(resp.executedQty));
        const executed = parseFloat(resp.executedQty);
        const feeRate = fees.getMakerRate();
        const pnl = fees.calcPnl({
          buyPrice,
          sellPrice: avgSell,
          qty: executed,
          feeRate,
        });

        await Trade.updateOne(
          { _id: trade._id, state: 'holding' },
          {
            state: 'sold',
            sellOrderId: resp.orderId,
            sellClientOrderId: retrySellId,
            sellPrice: avgSell,
            sellQty: executed,
            sellQuoteQty: parseFloat(resp.cummulativeQuoteQty),
            sellStatus: resp.status,
            sellFilledAt: new Date(resp.updateTime || Date.now()),
            sellPlacedAt: new Date(),
            realizedPnl: pnl.net,
            pnlPercent: pnl.pnlPercent,
            targetSellPrice: parseFloat(targetSellPrice),
          }
        );

        await Bot.updateOne(
          { _id: this.bot._id },
          {
            $inc: {
              totalPnl: pnl.net,
              totalTrades: 1,
              winTrades: (pnl.net > 0 ? 1 : 0),
            },
            $set: { status: 'idle', lastError: '' },
          }
        );

        this._unregisterTrade(trade);
        if (this.currentTrade && this.currentTrade._id.toString() === trade._id.toString()) {
          this.currentTrade = null;
        }
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
        eventBus.emit('trade:update', { tradeId: trade._id, state: 'sold' });
        // FIX P1.5: reset counter เมื่อ recover สำเร็จ
        this.holdingRetryCount = 0;
        logger.warn({
          tradeId: trade._id.toString(),
          pnl: pnl.net,
          avgSell,
        }, 'trader: holding retry — RECOVERED stranded position via MARKET SELL');
      } catch (err) {
        logger.error({ err: err.message, tradeId: trade._id.toString() }, 'trader: holding retry failed');
        // schedule อีก 60s
        if (this.running) {
          this.holdingRetryTimer = setTimeout(() => this.scheduleHoldingRetry(trade, qty, buyPrice, targetSellPrice), 60 * 1000);
        }
      }
    }, 30 * 1000);
  }

  async handlePartialBuyFill(trade, order, signalDoc, candle) {
    // วาง SELL เฉพาะส่วนที่ fill แล้ว + cancel ที่เหลือ
    try {
      const filledQty = parseFloat(order.executedQty);
      if (filledQty <= 0) {
        this.scheduleRetryCheck(candle, signalDoc);
        return;
      }
      const avgPrice = parseFloat(order.avgPrice)
        || (parseFloat(order.cummulativeQuoteQty) / filledQty);
      const cumQuote = parseFloat(order.cummulativeQuoteQty);

      // ─── FIX-2026-07-23 #1: atomic claim + idempotency guard ────────────────
      // กัน race condition ระหว่าง WS path (onBuyOrderUpdate) กับ timer path
      // (checkBuyOrder) ที่อาจเห็น PARTIALLY_FILLED พร้อมกัน — ตัวที่ 2 ต้อง abort
      const claim = await Trade.findOneAndUpdate(
        { _id: trade._id, state: 'placed' },
        {
          $set: {
            state: 'filled',
            buyStatus: 'PARTIALLY_FILLED',
            buyQty: filledQty,
            buyPrice: avgPrice,
            buyQuoteQty: cumQuote,
            buyFilledAt: new Date(),
          },
        },
        { new: true }
      );
      if (!claim) {
        // Lost the race — อีก path ได้ claim ไปแล้ว (state เปลี่ยนเป็น 'filled'/'selling'/...)
        const current = await Trade.findById(trade._id).select('state').lean();
        logger.info({
          tradeId: trade._id.toString(),
          currentState: current && current.state,
        }, 'trader: handlePartialBuyFill — already handled by another path, abort');
        return;
      }

      // ─── FIX-2026-07-23 #2: NOTIONAL pre-check ──────────────────────────
      // ถ้า filled qty × price < MIN_NOTIONAL → อย่า cancel remaining BUY
      //   ปล่อยให้ fill เพิ่มจนกว่าจะผ่าน (กัน SELL rejection loop)
      const symCached = symbolInfo.getCached(this.bot.symbol);
      if (symCached && symCached.notional && symCached.notional.minNotional) {
        const minNotional = parseFloat(symCached.notional.minNotional.toString());
        const notionalNow = filledQty * avgPrice;
        if (notionalNow < minNotional) {
          logger.warn({
            tradeId: claim._id.toString(),
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            filledQty, avgPrice,
            notional: notionalNow.toFixed(4),
            minNotional,
          }, 'trader: partial fill below MIN_NOTIONAL — leaving BUY open for accumulation');
          // คง BUY order ไว้, schedule watcher poll ทุก 30s
          this.schedulePartialFillWatch(claim);
          return;
        }
      }

      // ─── ตอนนี้พอจะขายได้ → cancel remaining BUY ก่อน ─────────────────────
      await binanceRest.cancelOrder({
        symbol: this.bot.symbol,
        orderId: trade.buyOrderId,
      }).catch(() => null);

      const feeRate = fees.getMakerRate();
      const sellPriceRaw = fees.calcSellPrice({
        buyPrice: avgPrice,
        tpPercent: this.bot.tpPercent,
        feeRate,
      });
      const info = symbolInfo.getCached(this.bot.symbol);
      const sellPrice = symbolInfo.roundPrice(sellPriceRaw, info.priceFilter.tickSize).toString();

      const sellClientOrderId = this.makeClientOrderId('sell', Date.now(), trade.retryCount || 0);
      const sellResp = await binanceRest.newOrder({
        symbol: this.bot.symbol,
        side: 'SELL',
        type: 'LIMIT_MAKER',
        quantity: filledQty.toString(),
        price: sellPrice,
        newClientOrderId: sellClientOrderId,
        recvWindow: config_recvWindow(),
      }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

      if (sellResp.error) {
        // FIX 1: MARKET fallback ก่อน mark holding
        const ok = await this._emergencyMarketSell(trade, filledQty, avgPrice, sellPrice,
          `partial-fill SELL rejected: ${sellResp.error.code}`);
        if (!ok) {
          await Trade.updateOne({ _id: trade._id }, { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: `${sellResp.error.code}: ${sellResp.error.msg}` });
          await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
          eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
          this.scheduleHoldingRetry(trade, filledQty, avgPrice, sellPrice);
        }
        return;
      }

      await Trade.updateOne(
        { _id: trade._id },
        {
          sellOrderId: sellResp.orderId,
          sellClientOrderId,
          sellPrice: parseFloat(sellPrice),
          sellQty: filledQty,
          sellStatus: sellResp.status,
          targetSellPrice: parseFloat(sellPrice),
          state: 'selling',
        }
      );
      this.currentTrade.state = 'selling';
      this.currentTrade.sellOrderId = sellResp.orderId;
      this.currentTrade.sellClientOrderId = sellClientOrderId;
      // FIX-2026-07-23 #3: cancel pending retry timer — BUY already cancelled,
      // SELL is now in flight. checkBuyOrder would otherwise fire 60s later and
      // (without state guard) overwrite state='selling' with 'cancelled'.
      if (this.retryCheckTimer) {
        clearTimeout(this.retryCheckTimer);
        this.retryCheckTimer = null;
      }
      this._registerTrade({ buyClientOrderId: trade.buyClientOrderId, sellClientOrderId });

      await Bot.updateOne({ _id: this.bot._id }, { status: 'selling', lastError: '' });
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'selling' });
      eventBus.emit('trade:update', { tradeId: trade._id, state: 'selling' });
    } catch (err) {
      logger.error({ err: err.message }, 'trader: handlePartialBuyFill error');
    }
  }

  // ─── FIX-2026-07-23 #3: partial-fill watcher ────────────────────────────────
  // - poll สถานะ BUY order ที่ถูกทิ้งไว้ (filledQty × price < MIN_NOTIONAL)
  // - เมื่อ fill เพิ่มจนพอ → ยกเลิก BUY, วาง SELL ตามปกติ
  // - เมื่อ BUY ถูก CANCELED/EXPIRED ภายนอก → สร้าง recovery record
  // - FIX-2026-07-23: deadline tracking — เก็บ partialFillDeadlineAt = buyPlacedAt + retryTimeMin×retryMax
  //   เมื่อครบ deadline → checkPartialFill เรียก _finalizePartialAfterDeadline ตาม notional
  // FIX P3.1: persist deadline ใน DB → restore ได้หลัง bot restart (เดิม instance-only)
  schedulePartialFillWatch(trade) {
    if (this.partialFillTimer) {
      clearTimeout(this.partialFillTimer);
      this.partialFillTimer = null;
    }
    if (!this.running || !trade || !trade._id) return;
    const tradeIdStr = trade._id.toString();
    // FIX-2026-07-23: คำนวณ deadline ตาม retryTimeMin × retryMax (นาที)
    //   - ถ้าไม่มี buyPlacedAt (เช่น recovery record) → ใช้ now เป็น base
    //   - FIX P3.1: persist ใน DB ด้วย — restore ได้หลัง restart
    const retryMax = this.bot.retryMax ?? 1;
    const retryTimeMin = this.bot.retryTimeMin ?? 1;
    const placedAtMs = trade.buyPlacedAt ? new Date(trade.buyPlacedAt).getTime() : Date.now();
    const deadlineMs = placedAtMs + retryTimeMin * retryMax * 60 * 1000;
    this.partialFillDeadlineAt = deadlineMs;
    this._partialFillTradeId = tradeIdStr;
    // FIX P3.1: persist deadline ลง DB แบบ fire-and-forget
    Trade.updateOne(
      { _id: trade._id },
      { $set: { partialFillDeadlineAt: new Date(deadlineMs) } }
    ).catch((err) => logger.warn({ err: err.message, tradeId: tradeIdStr }, 'trader: persist partialFillDeadline failed'));
    logger.info({
      botId: this.bot._id.toString(),
      tradeId: tradeIdStr,
      placedAtMs,
      deadlineMs,
      retryTimeMin,
      retryMax,
      deadlineAt: new Date(deadlineMs).toISOString(),
    }, 'trader: partial-fill watch scheduled with deadline');
    this.partialFillTimer = setTimeout(async () => {
      try {
        await this.checkPartialFill(tradeIdStr);
      } catch (err) {
        logger.error({ err: err.message, tradeId: tradeIdStr }, 'trader: checkPartialFill crashed');
      }
    }, 30 * 1000);
  }

  async checkPartialFill(tradeIdStr) {
    const fresh = await Trade.findById(tradeIdStr);
    if (!fresh) return;
    if (this.bot._id.toString() !== fresh.botId.toString()) return;

    // ถ้า state เปลี่ยนแล้ว (someone else handled) → หยุด watch
    if (fresh.state !== 'filled' || fresh.buyStatus !== 'PARTIALLY_FILLED') {
      logger.debug({
        tradeId: tradeIdStr, currentState: fresh.state, currentBuyStatus: fresh.buyStatus,
      }, 'trader: partial-fill watch — trade no longer in filled/partial state, stop');
      return;
    }

    // FIX P3.1: restore deadline จาก DB (ถ้า instance var หายไป เช่น หลัง restart)
    if (!this.partialFillDeadlineAt && fresh.partialFillDeadlineAt) {
      this.partialFillDeadlineAt = new Date(fresh.partialFillDeadlineAt).getTime();
      logger.info({
        tradeId: tradeIdStr,
        restoredDeadlineMs: this.partialFillDeadlineAt,
      }, 'trader: partial-fill watch — restored deadline from DB after restart');
    }

    let order;
    try {
      order = await binanceRest.getOrder({
        symbol: this.bot.symbol,
        orderId: fresh.buyOrderId,
      });
    } catch (err) {
      logger.warn({ err: err.message, tradeId: tradeIdStr }, 'trader: partial-fill watch — getOrder failed, retry in 30s');
      this.schedulePartialFillWatch(fresh);
      return;
    }
    if (!order || !order.orderId) {
      this.schedulePartialFillWatch(fresh);
      return;
    }

    const filledQty = parseFloat(order.executedQty);
    const avgPrice = parseFloat(order.avgPrice)
      || (parseFloat(order.cummulativeQuoteQty) / filledQty);

    // FIX-2026-07-23: deadline gate — ถ้าเลย retryTimeMin × retryMax แล้ว → ตัดสินใจ accept_partial หรือ top_up_market
    //   - ผู้ใช้ต้องการ "รอให้ครบ retry window ก่อนตัดสินใจ" ไม่ใช่ trigger SELL ทันทีที่ notional ≥ MIN_NOTIONAL
    //   - deadlineAt set ใน schedulePartialFillWatch ครั้งแรก; ถ้า partialFillTimer ยัง tick อยู่แต่ state
    //     ถูก handle จาก WS path → check นี้จะไม่ trigger (อยู่ใน closure)
    const now = Date.now();
    const deadlinePassed = this.partialFillDeadlineAt && now >= this.partialFillDeadlineAt;

    // ถ้า BUY fill ครบหมดแล้ว → handle normally
    if (order.status === 'FILLED') {
      logger.info({
        tradeId: tradeIdStr,
        filledQty, avgPrice,
      }, 'trader: partial-fill watch — BUY now fully FILLED, processing SELL');
      const sig = fresh.signalId ? await Signal.findById(fresh.signalId).catch(() => null) : null;
      const candle = { closeTime: Date.now(), close: avgPrice };
      await this.handleBuyFilled(fresh, order, sig);
      return;
    }

    // BUY ยังเปิดอยู่ (NEW/PARTIALLY_FILLED) → เช็คว่า notional พอหรือยัง
    if (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') {
      const symCached = symbolInfo.getCached(this.bot.symbol);
      const minNotional = symCached && symCached.notional && symCached.notional.minNotional
        ? parseFloat(symCached.notional.minNotional.toString()) : 0;
      const notional = filledQty * avgPrice;

      // ── FIX-2026-07-23 DEADLINE BRANCH ─────────────────────────────────
      // ครบ retry window แล้ว → ตัดสินใจทันที (ไม่รอ notional gate)
      if (deadlinePassed) {
        const sig = fresh.signalId ? await Signal.findById(fresh.signalId).catch(() => null) : null;
        if (notional >= minNotional && minNotional > 0) {
          logger.info({
            tradeId: tradeIdStr,
            filledQty, notional: notional.toFixed(4), minNotional,
            deadlineMs: this.partialFillDeadlineAt,
            nowMs: now,
          }, 'trader: deadline passed — filledNotional ≥ minNotional → accept_partial path');
          await this._finalizePartialAfterDeadline(fresh, order, sig, { mode: 'accept_partial' });
        } else {
          logger.info({
            tradeId: tradeIdStr,
            filledQty, notional: notional.toFixed(4), minNotional,
            deadlineMs: this.partialFillDeadlineAt,
            nowMs: now,
          }, 'trader: deadline passed — filledNotional < minNotional → top_up_market path');
          await this._finalizePartialAfterDeadline(fresh, order, sig, { mode: 'top_up_market' });
        }
        return;
      }
      // ── ก่อน deadline: notional พอแล้ว → เดิม trigger handlePartialBuyFill ทันที ──
      //   แต่ตามที่ผู้ใช้ขอใหม่: "รอจนครบ retry window ก่อน" — ดังนั้นเราเปลี่ยนเป็น schedule ต่อ
      //   (ไม่ trigger SELL ทันทีเมื่อ notional gate ผ่าน เพราะผู้ใช้อยากให้ "เผื่อ" fill ต่อจนครบ deadline)
      if (notional >= minNotional && minNotional > 0) {
        logger.debug({
          tradeId: tradeIdStr,
          filledQty, notional: notional.toFixed(4), minNotional,
          msToDeadline: this.partialFillDeadlineAt ? this.partialFillDeadlineAt - now : null,
        }, 'trader: partial-fill watch — notional now ≥ minNotional, but waiting for deadline before triggering SELL');
        this.schedulePartialFillWatch(fresh);
        return;
      }
      // ยังไม่พอ → schedule อีก 30s
      logger.debug({
        tradeId: tradeIdStr,
        filledQty, notional: notional.toFixed(4), minNotional,
        msToDeadline: this.partialFillDeadlineAt ? this.partialFillDeadlineAt - now : null,
      }, 'trader: partial-fill watch — still below MIN_NOTIONAL, retry in 30s');
      this.schedulePartialFillWatch(fresh);
      return;
    }

    if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
      // BUY ถูก cancel ภายนอก — ถ้ามีบางส่วน fill → พยายาม recover
      if (filledQty > 0) {
        const symCached = symbolInfo.getCached(this.bot.symbol);
        const minNotional = symCached && symCached.notional && symCached.notional.minNotional
          ? parseFloat(symCached.notional.minNotional.toString()) : 0;
        const notional = filledQty * avgPrice;
        if (notional >= minNotional && minNotional > 0) {
          logger.warn({
            tradeId: tradeIdStr,
            filledQty, notional: notional.toFixed(4),
          }, 'trader: partial-fill watch — BUY cancelled but sellable, triggering SELL');
          await Trade.updateOne({ _id: fresh._id }, { state: 'placed' });
          const sig = fresh.signalId ? await Signal.findById(fresh.signalId).catch(() => null) : null;
          const candle = { closeTime: Date.now(), close: avgPrice };
          await this.handlePartialBuyFill(fresh, order, sig, candle);
          return;
        }
        // ไม่พอขาย → mark 'failed' (dust_orphan)
        logger.error({
          tradeId: tradeIdStr, symbol: this.bot.symbol,
          filledQty, notional: notional.toFixed(4), minNotional,
        }, 'trader: partial-fill watch — dust_orphan (BUY cancelled externally, qty below MIN_NOTIONAL)');
        await Trade.updateOne(
          { _id: fresh._id, state: 'filled' },
          {
            state: 'failed',
            buyStatus: order.status,
            buyQty: filledQty,
            buyPrice: avgPrice,
            buyQuoteQty: parseFloat(order.cummulativeQuoteQty),
            error: `dust_orphan ${notional.toFixed(4)} < ${minNotional} (BUY cancelled externally, manual recovery needed)`,
          }
        );
        eventBus.emit('trade:update', { tradeId: fresh._id, state: 'failed' });
        return;
      }
      // ไม่มี fill เลย → cancel ตามปกติ
      await Trade.updateOne(
        { _id: fresh._id, state: 'filled' },
        { state: 'cancelled', buyStatus: order.status }
      );
      eventBus.emit('trade:update', { tradeId: fresh._id, state: 'cancelled' });
      return;
    }
  }

  // ─── FIX-2026-07-23: partial-fill deadline finalizers ──────────────────────
  // เรียกหลัง retryTimeMin × retryMax นาที:
  //   - mode='accept_partial' → filledNotional ≥ MIN_NOTIONAL → place SELL ตาม TP
  //   - mode='top_up_market' → filledNotional < MIN_NOTIONAL → MARKET BUY เพิ่มแล้ว place SELL
  // ใช้ atomic claim (state='placed') เพื่อกัน race กับ handlePartialBuyFill (WS path)
  async _finalizePartialAfterDeadline(trade, order, signalDoc, { mode }) {
    // FIX V1: atomic claim — ตั้ง state='partial_wait' ก่อน helper อื่นเข้ามา claim 'placed'
    const claim = await Trade.findOneAndUpdate(
      { _id: trade._id, state: 'placed' },
      {
        $set: {
          state: 'partial_wait',
          partialDecisionAt: new Date(),
          partialDecisionMode: mode,
        },
      },
      { new: true }
    );
    if (!claim) {
      // Lost the race — handler อื่น (WS path, onBuyOrderUpdate, handlePartialBuyFill) claim ไปแล้ว
      // หรือ trade ถูกยกเลิกจากภายนอก ก็ปล่อยให้ handler นั้น process ต่อ
      const cur = await Trade.findById(trade._id).select('state').lean();
      logger.info({
        tradeId: trade._id.toString(),
        requestedMode: mode,
        currentState: cur && cur.state,
      }, 'trader: deadline handler — already moved on (state != placed), abort');
      return;
    }

    logger.info({
      botId: this.bot._id.toString(),
      tradeId: claim._id.toString(),
      mode,
      filledQty: parseFloat(order.executedQty),
      avgPrice: parseFloat(order.avgPrice || 0),
    }, 'trader: deadline handler — atomic claim won, dispatching');

    try {
      if (mode === 'accept_partial') {
        await this._placeSellForPartialFill(claim, order);
      } else {
        await this._topUpAndSell(claim, order);
      }
    } catch (err) {
      // FIX V9: bot stuck ใน 'partial_wait' ถ้า helper crash → fail-safe
      logger.error({
        err: err.message, stack: err.stack,
        tradeId: claim._id.toString(), mode,
      }, 'trader: deadline handler failed — marking trade as failed');
      try {
        await Trade.updateOne(
          { _id: claim._id },
          { state: 'failed', error: `deadline handler (${mode}): ${err.message}` }
        );
        await Bot.updateOne(
          { _id: this.bot._id },
          { status: 'error', lastError: `deadline handler failed: ${err.message}` }
        );
        this._unregisterTrade(claim);
        if (this.currentTrade && this.currentTrade._id.toString() === claim._id.toString()) {
          this.currentTrade = null;
        }
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'error' });
        eventBus.emit('trade:update', { tradeId: claim._id, state: 'failed' });
      } catch (cleanupErr) {
        logger.error({ err: cleanupErr.message }, 'trader: deadline handler cleanup failed');
      }
    }
  }

  // ── _placeSellForPartialFill — accept_partial path (filledNotional ≥ MIN_NOTIONAL) ──
  // 1. re-fetch BUY order เพื่อ catch late fills (FIX V2)
  // 2. update trade ด้วย avg BUY price จริง (FIX V7)
  // 3. cancel BUY (idempotent)
  // 4. place SELL ตาม TP
  async _placeSellForPartialFill(trade, order) {
    // FIX V2: re-fetch order เพื่อ catch late fills ระหว่าง cancel-confirm
    let fresh;
    try {
      fresh = await binanceRest.getOrder({
        symbol: this.bot.symbol,
        orderId: trade.buyOrderId,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'trader: accept_partial — re-fetch BUY failed, using order snapshot');
      fresh = order;
    }
    const filledQty = parseFloat(fresh.executedQty || order.executedQty);
    const cumQuote = parseFloat(fresh.cummulativeQuoteQty || order.cummulativeQuoteQty || 0);
    const avgPrice = parseFloat(fresh.avgPrice)
      || (cumQuote > 0 && filledQty > 0 ? cumQuote / filledQty : parseFloat(order.avgPrice || order.price || 0));

    if (filledQty <= 0 || avgPrice <= 0) {
      logger.error({
        tradeId: trade._id.toString(),
        freshStatus: fresh.status, filledQty, avgPrice,
      }, 'trader: accept_partial — invalid filledQty/avgPrice, marking failed');
      await Trade.updateOne(
        { _id: trade._id, state: 'partial_wait' },
        { state: 'failed', error: 'accept_partial: invalid filledQty/avgPrice' }
      );
      return;
    }

    // FIX V7: update trade ด้วย avg BUY price จริง (อาจต่างจาก buyPrice แรก)
    await Trade.updateOne(
      { _id: trade._id, state: 'partial_wait' },
      {
        buyQty: filledQty,
        buyPrice: avgPrice,
        buyQuoteQty: cumQuote,
        buyStatus: fresh.status,
        buyFilledAt: new Date(fresh.updateTime || Date.now()),
        state: 'filled',
      }
    );

    // FIX V6: idempotent cancel (ถ้า CANCELED แล้ว → no-op)
    await binanceRest.cancelOrder({
      symbol: this.bot.symbol,
      orderId: trade.buyOrderId,
    }).catch(() => null);

    // FIX V8: เช็ค MIN_NOTIONAL อีกครั้ง (เผื่อ race ทำให้ notional ลดลง) → MARKET SELL fallback
    const symCached = symbolInfo.getCached(this.bot.symbol);
    const minNotional = symCached && symCached.notional && symCached.notional.minNotional
      ? parseFloat(symCached.notional.minNotional.toString()) : 0;
    if (filledQty * avgPrice < minNotional) {
      logger.warn({
        tradeId: trade._id.toString(),
        filledQty, avgPrice, notional: (filledQty * avgPrice).toFixed(4), minNotional,
      }, 'trader: accept_partial — notional below MIN_NOTIONAL at deadline, fallback to MARKET SELL');
      const ok = await this._emergencyMarketSell(trade, filledQty, avgPrice, 0,
        'partial-fill accept_partial below MIN_NOTIONAL at deadline');
      if (!ok) {
        await Trade.updateOne(
          { _id: trade._id, state: 'filled' },
          { state: 'holding', error: 'accept_partial MARKET SELL fallback failed' }
        );
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        eventBus.emit('trade:update', { tradeId: trade._id, state: 'holding' });
        this.scheduleHoldingRetry(trade, filledQty, avgPrice, 0);
      }
      return;
    }

    // Place SELL ตาม TP — extract logic จาก handlePartialBuyFill
    const feeRate = fees.getMakerRate();
    const sellPriceRaw = fees.calcSellPrice({
      buyPrice: avgPrice,
      tpPercent: this.bot.tpPercent,
      feeRate,
    });
    const info = symbolInfo.getCached(this.bot.symbol);
    const tickSize = info.priceFilter.tickSize;
    const sellPrice = symbolInfo.roundPrice(sellPriceRaw, tickSize).toString();

    const validation = symbolInfo.validateOrder({ symbol: this.bot.symbol, price: sellPrice, qty: filledQty });
    if (!validation.ok) {
      logger.warn({
        reason: validation.reason, tradeId: trade._id.toString(),
      }, 'trader: accept_partial — SELL validation failed → MARKET fallback');
      const ok = await this._emergencyMarketSell(trade, filledQty, avgPrice, sellPrice,
        `accept_partial validation: ${validation.reason}`);
      if (!ok) {
        await Trade.updateOne(
          { _id: trade._id, state: 'filled' },
          { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: validation.reason }
        );
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        eventBus.emit('trade:update', { tradeId: trade._id, state: 'holding' });
        this.scheduleHoldingRetry(trade, filledQty, avgPrice, sellPrice);
      }
      return;
    }

    const sellClientOrderId = this.makeClientOrderId('sell', Date.now(), trade.retryCount || 0);
    const sellResp = await binanceRest.newOrder({
      symbol: this.bot.symbol,
      side: 'SELL',
      type: 'LIMIT_MAKER',
      quantity: filledQty.toString(),
      price: sellPrice,
      newClientOrderId: sellClientOrderId,
      recvWindow: config_recvWindow(),
    }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

    if (sellResp.error) {
      logger.warn({
        err: sellResp.error, tradeId: trade._id.toString(),
      }, 'trader: accept_partial — SELL LIMIT_MAKER rejected → MARKET fallback');
      const ok = await this._emergencyMarketSell(trade, filledQty, avgPrice, sellPrice,
        `accept_partial SELL rejected: ${sellResp.error.code}`);
      if (!ok) {
        await Trade.updateOne(
          { _id: trade._id, state: 'filled' },
          { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: `${sellResp.error.code}: ${sellResp.error.msg}` }
        );
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        eventBus.emit('trade:update', { tradeId: trade._id, state: 'holding' });
        this.scheduleHoldingRetry(trade, filledQty, avgPrice, sellPrice);
      }
      return;
    }

    // SELL placed → state='selling'
    await Trade.updateOne(
      { _id: trade._id, state: 'filled' },
      {
        sellOrderId: sellResp.orderId,
        sellClientOrderId,
        sellPrice: parseFloat(sellPrice),
        sellQty: filledQty,
        sellStatus: sellResp.status,
        sellPlacedAt: new Date(),
        targetSellPrice: parseFloat(sellPrice),
        state: 'selling',
      }
    );
    this.currentTrade.sellOrderId = sellResp.orderId;
    this.currentTrade.sellClientOrderId = sellClientOrderId;
    this.currentTrade.state = 'selling';
    this._registerTrade({ buyClientOrderId: trade.buyClientOrderId, sellClientOrderId });
    // FIX-2026-07-23 #3: cancel pending retry timer
    if (this.retryCheckTimer) {
      clearTimeout(this.retryCheckTimer);
      this.retryCheckTimer = null;
    }

    logger.info({
      botId: this.bot._id.toString(),
      tradeId: trade._id.toString(),
      buyPrice: avgPrice, sellPrice, qty: filledQty,
    }, 'trader: accept_partial — SELL placed');

    await Bot.updateOne({ _id: this.bot._id }, { status: 'selling', lastError: '' });
    eventBus.emit('bot:status', { botId: this.bot._id, status: 'selling' });
    eventBus.emit('trade:update', { tradeId: trade._id, state: 'selling' });
  }

  // ── _topUpAndSell — top_up_market path (filledNotional < MIN_NOTIONAL) ──
  // 1. re-fetch BUY order (FIX V2)
  // 2. cancel LIMIT_MAKER BUY (ปลดล็อก USDT)
  // 3. MARKET BUY เพิ่มเติมตาม remainingNotional (FIX V3 best-effort)
  // 4. คำนวณ avgBuyPrice รวมทั้งสองส่วน (FIX V7)
  // 5. place SELL ตาม TP
  async _topUpAndSell(trade, order) {
    // FIX V2: re-fetch order
    let fresh;
    try {
      fresh = await binanceRest.getOrder({
        symbol: this.bot.symbol,
        orderId: trade.buyOrderId,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'trader: top_up — re-fetch BUY failed, using order snapshot');
      fresh = order;
    }
    const filledQty = parseFloat(fresh.executedQty || order.executedQty);
    const cumQuote = parseFloat(fresh.cummulativeQuoteQty || order.cummulativeQuoteQty || 0);
    const avgPrice = parseFloat(fresh.avgPrice)
      || (cumQuote > 0 && filledQty > 0 ? cumQuote / filledQty : parseFloat(order.avgPrice || order.price || 0));
    const filledNotional = filledQty * avgPrice;
    const capital = parseFloat(this.bot.capitalPerTrade) || 0;
    const remainingNotional = Math.max(0, capital - filledNotional);

    logger.info({
      tradeId: trade._id.toString(),
      filledQty, avgPrice, filledNotional: filledNotional.toFixed(4),
      capital, remainingNotional: remainingNotional.toFixed(4),
    }, 'trader: top_up — starting');

    // ดึงราคาตลาดปัจจุบัน
    let currentAsk = 0;
    try {
      const ticker = await binanceRest.get24hrTickers({ symbol: this.bot.symbol });
      currentAsk = parseFloat(ticker.askPrice || ticker.lastPrice || 0);
    } catch (err) {
      logger.warn({ err: err.message }, 'trader: top_up — get24hrTickers failed');
    }
    if (currentAsk <= 0) {
      logger.warn({
        tradeId: trade._id.toString(),
      }, 'trader: top_up — cannot read current ask, falling back to accept_partial');
      // ตั้ง state กลับเป็น 'placed' เพื่อให้ _placeSellForPartialFill atomic claim ได้
      await Trade.updateOne({ _id: trade._id, state: 'partial_wait' }, { state: 'placed' });
      return this._placeSellForPartialFill(trade, fresh);
    }

    const info = symbolInfo.getCached(this.bot.symbol);
    const stepSize = info.lotSize.stepSize;
    const minNotional = parseFloat(info.notional.minNotional.toString());

    // FIX V3: best-effort top-up — qty จาก remainingNotional / currentAsk, floor ตาม stepSize
    const topUpRawQty = symbolInfo.roundQty(remainingNotional / currentAsk, stepSize);
    let topUpQty = parseFloat(topUpRawQty.toString());

    // sanity check: top-up notional ≥ minNotional ไหม
    if (topUpQty * currentAsk < minNotional) {
      logger.warn({
        tradeId: trade._id.toString(),
        remainingNotional: remainingNotional.toFixed(4),
        topUpQty, currentAsk,
        projectedNotional: (topUpQty * currentAsk).toFixed(4), minNotional,
      }, 'trader: top_up — remaining USDT insufficient for meaningful top-up, falling back to accept_partial');
      await Trade.updateOne({ _id: trade._id, state: 'partial_wait' }, { state: 'placed' });
      return this._placeSellForPartialFill(trade, fresh);
    }

    // FIX V2: cancel LIMIT_MAKER BUY ก่อน MARKET BUY (ปลดล็อก USDT)
    try {
      await binanceRest.cancelOrder({
        symbol: this.bot.symbol,
        orderId: trade.buyOrderId,
      });
    } catch (err) {
      // ถ้า cancel fail (order อาจถูก cancel ไปแล้ว) → log แต่ทำต่อ
      logger.warn({
        err: err.message, tradeId: trade._id.toString(),
      }, 'trader: top_up — cancel LIMIT_MAKER BUY failed (continuing)');
    }

    // FIX V4: place MARKET BUY top-up
    let topUpResp;
    try {
      topUpResp = await binanceRest.newOrder({
        symbol: this.bot.symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: topUpQty.toString(),
        newClientOrderId: this.makeClientOrderId('topup', Date.now()),
        newOrderRespType: 'FULL',
        recvWindow: config_recvWindow(),
      });
    } catch (err) {
      const fe = binanceRest.formatBinanceError(err);
      logger.warn({
        err: fe, tradeId: trade._id.toString(),
      }, 'trader: top_up — MARKET BUY failed, falling back to accept_partial');
      await Trade.updateOne({ _id: trade._id, state: 'partial_wait' }, { state: 'placed' });
      return this._placeSellForPartialFill(trade, fresh);
    }
    if (topUpResp.error) {
      logger.warn({
        err: topUpResp.error, tradeId: trade._id.toString(),
      }, 'trader: top_up — MARKET BUY rejected, falling back to accept_partial');
      await Trade.updateOne({ _id: trade._id, state: 'partial_wait' }, { state: 'placed' });
      return this._placeSellForPartialFill(trade, fresh);
    }

    const topUpExecuted = parseFloat(topUpResp.executedQty);
    const topUpQuote = parseFloat(topUpResp.cummulativeQuoteQty);
    const totalQty = filledQty + topUpExecuted;
    const totalQuote = cumQuote + topUpQuote;
    const avgBuyPrice = totalQty > 0 ? totalQuote / totalQty : avgPrice;

    logger.info({
      tradeId: trade._id.toString(),
      topUpOrderId: topUpResp.orderId,
      topUpQty: topUpExecuted, topUpQuote: topUpQuote.toFixed(4),
      totalQty, avgBuyPrice: avgBuyPrice.toFixed(6), totalQuote: totalQuote.toFixed(4),
    }, 'trader: top_up — MARKET BUY executed');

    // FIX V7: update trade ด้วย avg BUY price รวม top-up + topUpOrderId
    await Trade.updateOne(
      { _id: trade._id, state: 'partial_wait' },
      {
        buyQty: totalQty,
        buyPrice: avgBuyPrice,
        buyQuoteQty: totalQuote,
        buyStatus: 'FILLED',
        buyFilledAt: new Date(),
        topUpOrderId: topUpResp.orderId,
        state: 'filled',
      }
    );

    // FIX V8: เช็ค MIN_NOTIONAL ก่อน place SELL
    const sellNotional = totalQty * avgBuyPrice;
    if (sellNotional < minNotional) {
      logger.warn({
        tradeId: trade._id.toString(),
        totalQty, avgBuyPrice, sellNotional: sellNotional.toFixed(4), minNotional,
      }, 'trader: top_up — total notional still below MIN_NOTIONAL, MARKET SELL fallback');
      const ok = await this._emergencyMarketSell(trade, totalQty, avgBuyPrice, 0,
        'top_up_market total still below MIN_NOTIONAL');
      if (!ok) {
        await Trade.updateOne(
          { _id: trade._id, state: 'filled' },
          { state: 'holding', error: 'top_up MARKET SELL fallback failed' }
        );
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        eventBus.emit('trade:update', { tradeId: trade._id, state: 'holding' });
        this.scheduleHoldingRetry(trade, totalQty, avgBuyPrice, 0);
      }
      return;
    }

    // Place SELL ตาม TP (avgBuyPrice รวม top-up)
    const feeRate = fees.getMakerRate();
    const sellPriceRaw = fees.calcSellPrice({
      buyPrice: avgBuyPrice,
      tpPercent: this.bot.tpPercent,
      feeRate,
    });
    const tickSize = info.priceFilter.tickSize;
    const sellPrice = symbolInfo.roundPrice(sellPriceRaw, tickSize).toString();

    const sellClientOrderId = this.makeClientOrderId('sell', Date.now(), trade.retryCount || 0);
    const sellResp = await binanceRest.newOrder({
      symbol: this.bot.symbol,
      side: 'SELL',
      type: 'LIMIT_MAKER',
      quantity: totalQty.toString(),
      price: sellPrice,
      newClientOrderId: sellClientOrderId,
      recvWindow: config_recvWindow(),
    }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

    if (sellResp.error) {
      logger.warn({
        err: sellResp.error, tradeId: trade._id.toString(),
      }, 'trader: top_up — SELL LIMIT_MAKER rejected → MARKET fallback');
      const ok = await this._emergencyMarketSell(trade, totalQty, avgBuyPrice, sellPrice,
        `top_up_market SELL rejected: ${sellResp.error.code}`);
      if (!ok) {
        await Trade.updateOne(
          { _id: trade._id, state: 'filled' },
          { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: `${sellResp.error.code}: ${sellResp.error.msg}` }
        );
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        eventBus.emit('trade:update', { tradeId: trade._id, state: 'holding' });
        this.scheduleHoldingRetry(trade, totalQty, avgBuyPrice, sellPrice);
      }
      return;
    }

    await Trade.updateOne(
      { _id: trade._id, state: 'filled' },
      {
        sellOrderId: sellResp.orderId,
        sellClientOrderId,
        sellPrice: parseFloat(sellPrice),
        sellQty: totalQty,
        sellStatus: sellResp.status,
        sellPlacedAt: new Date(),
        targetSellPrice: parseFloat(sellPrice),
        state: 'selling',
      }
    );
    this.currentTrade.sellOrderId = sellResp.orderId;
    this.currentTrade.sellClientOrderId = sellClientOrderId;
    this.currentTrade.state = 'selling';
    this._registerTrade({ buyClientOrderId: trade.buyClientOrderId, sellClientOrderId });
    if (this.retryCheckTimer) {
      clearTimeout(this.retryCheckTimer);
      this.retryCheckTimer = null;
    }

    logger.info({
      botId: this.bot._id.toString(),
      tradeId: trade._id.toString(),
      buyPrice: avgBuyPrice, sellPrice, qty: totalQty,
      topUpOrderId: topUpResp.orderId,
    }, 'trader: top_up_market — SELL placed');

    await Bot.updateOne({ _id: this.bot._id }, { status: 'selling', lastError: '' });
    eventBus.emit('bot:status', { botId: this.bot._id, status: 'selling' });
    eventBus.emit('trade:update', { tradeId: trade._id, state: 'selling' });
  }

  // ─── FIX-2026-07-23 #4: startup reconciliation ─────────────────────────────
  // Scan Binance balance for this bot's base asset; if found and DB has no active
  // trade that explains it → log a clear orphan warning. Caller decides whether
  // to create a recovery trade. Throttled to once per 5 minutes per bot.
  async reconcileAccountBalance({ force = false } = {}) {
    if (!this.running) return null;
    const now = Date.now();
    if (!force && now - this._lastReconcileBalanceMs < 5 * 60 * 1000) return null;
    this._lastReconcileBalanceMs = now;

    try {
      const baseAsset = this.bot.symbol.replace(/USDT$|USDC$|BUSD$/, '');
      const account = await binanceRest.getAccount();
      const bal = (account.balances || []).find((b) => b.asset === baseAsset);
      const freeQty = bal ? parseFloat(bal.free) : 0;
      const lockedQty = bal ? parseFloat(bal.locked) : 0;
      const totalQty = freeQty + lockedQty;

      // ถ้าไม่มี base asset เลย → ไม่ต้องทำอะไร
      if (totalQty <= 0) return { ok: true, reason: 'no_balance' };

      // หา active trades ของบอทนี้ (ทั้งหมด ไม่ใช่แค่ล่าสุด — FIX P1.4 multi-trade aggregation)
      const allActive = await Trade.find({
        botId: this.bot._id,
        state: { $in: ['placed', 'filled', 'holding', 'selling'] },
      }).lean();

      // ใช้ active ตัวล่าสุดสำหรับ partial-fill watch (back-compat)
      const active = allActive.length > 0
        ? allActive.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
        : null;

      // FIX P1.4: aggregate expectedFree จาก **all** filled/holding trades
      //   เดิม: ใช้แค่ trade ล่าสุด → ถ้ามี 2 filled trades (maxTrades=2) trade เก่าจะถูก mark เป็น orphan
      //   fix: รวม buyQty - sellQty ของทุก filled/holding trades
      //   หมายเหตุ: 'placed' ยังไม่ถือว่า free (อยู่ใน BUY order lock) / 'selling' ก็เช่นกัน (SELL order lock)
      let expectedFreeFromActive = 0;
      for (const t of allActive) {
        if ((t.state === 'filled' || t.state === 'holding') && t.buyQty) {
          expectedFreeFromActive += parseFloat(t.buyQty) - (parseFloat(t.sellQty) || 0);
        }
      }

      // ถ้า free qty มากกว่า 0 และไม่มี active trade → อาจเป็น orphan
      // (ถ้ามี active trade state='selling' → freeQty ควรเป็น 0 อยู่แล้ว เพราะถูก lock)
      const orphanFree = Math.max(0, freeQty - expectedFreeFromActive);

      if (orphanFree > 0.0000001 || lockedQty > 0) {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          baseAsset,
          freeQty, lockedQty, totalQty,
          activeTradeId: active ? active._id.toString() : null,
          activeState: active ? active.state : null,
          activeBuyQty: active ? active.buyQty : null,
          activeCount: allActive.length,
          expectedFree: expectedFreeFromActive,
          orphanFree,
        }, 'trader: reconcileAccountBalance — unexpected base-asset balance on Binance (orphan?)');

        // ถ้ามี locked qty ใน BUY order → ตรวจ BUY order ที่ยังมีชีวิต
        if (lockedQty > 0 && active && active.buyOrderId && active.state === 'placed') {
          const liveOrder = await binanceRest.getOrder({
            symbol: this.bot.symbol,
            orderId: active.buyOrderId,
          }).catch(() => null);
          if (liveOrder) {
            logger.info({
              tradeId: active._id.toString(),
              buyOrderId: active.buyOrderId,
              liveStatus: liveOrder.status,
              executedQty: liveOrder.executedQty,
              originalQty: liveOrder.origQty,
            }, 'trader: reconcileAccountBalance — live BUY order found, syncing to watch');
            // ถ้า status เปลี่ยนจากที่ DB คิด → trigger handler
            if (liveOrder.status === 'PARTIALLY_FILLED') {
              const sig = active.signalId
                ? await Signal.findById(active.signalId).catch(() => null) : null;
              const candle = { closeTime: Date.now(), close: parseFloat(liveOrder.price) };
              await this.handlePartialBuyFill(active, liveOrder, sig, candle);
            } else if (liveOrder.status === 'FILLED') {
              const sig = active.signalId
                ? await Signal.findById(active.signalId).catch(() => null) : null;
              await this.handleBuyFilled(active, liveOrder, sig);
            }
          }
        }

        return {
          ok: true,
          reason: 'orphan_or_partial_locked',
          freeQty, lockedQty, orphanFree,
          activeTradeId: active && active._id.toString(),
          activeCount: allActive.length,
        };
      }

      return { ok: true, reason: 'balanced', freeQty, lockedQty, expectedFree: expectedFreeFromActive };
    } catch (err) {
      logger.warn({
        botId: this.bot._id.toString(),
        symbol: this.bot.symbol,
        err: err.message,
      }, 'trader: reconcileAccountBalance error (non-fatal)');
      return { ok: false, reason: 'error', err: err.message };
    }
  }

  // ─── Order update handler (จาก User Data Stream) ─
  // FIX 3: รับ trade parameter (จาก Map/DB lookup) ไม่พึ่ง currentTrade
  // FIX 7: handle ทุก status (FILLED/PARTIALLY_FILLED/CANCELED/EXPIRED)
  async onBuyOrderUpdate(update, trade) {
    if (!trade) return;
    if (update.status === 'FILLED') {
      logger.info({ botId: this.bot._id.toString(), orderId: update.orderId, avgPrice: update.avgPrice }, 'trader: BUY FILLED (via WS)');
      binanceRest.getOrder({
        symbol: this.bot.symbol,
        orderId: update.orderId,
      }).then(async (order) => {
        if (!order) return;
        // ดึง signal doc จาก trade
        const sig = trade.signalId ? await Signal.findById(trade.signalId).catch(() => null) : null;
        await this.handleBuyFilled(trade, order, sig);
      }).catch((err) => logger.error({ err: err.message }, 'trader: onBuyOrderUpdate getOrder failed'));
      return;
    }
    if (update.status === 'PARTIALLY_FILLED') {
      logger.info({ botId: this.bot._id.toString(), orderId: update.orderId, executedQty: update.executedQty }, 'trader: BUY PARTIALLY_FILLED (via WS)');
      binanceRest.getOrder({
        symbol: this.bot.symbol,
        orderId: update.orderId,
      }).then(async (order) => {
        if (!order) return;
        const sig = trade.signalId ? await Signal.findById(trade.signalId).catch(() => null) : null;
        // ส่ง candle หลอก ๆ (cancel ที่เหลือทำใน handlePartialBuyFill)
        const candle = { closeTime: Date.now(), close: parseFloat(update.avgPrice || order.price) };
        await this.handlePartialBuyFill(trade, order, sig, candle);
      }).catch((err) => logger.error({ err: err.message }, 'trader: onBuyOrderUpdate partial getOrder failed'));
      return;
    }
    if (update.status === 'CANCELED' || update.status === 'EXPIRED') {
      // FIX 7: handle WS cancel/expire สำหรับ BUY ที่ state='placed'
      if (trade.state === 'placed') {
        logger.info({ botId: this.bot._id.toString(), orderId: update.orderId, status: update.status }, 'trader: BUY cancelled externally');
        await Trade.updateOne(
          { _id: trade._id, state: 'placed' },
          { state: 'cancelled', buyStatus: update.status }
        );
        if (this.currentTrade && this.currentTrade._id.toString() === trade._id.toString()) {
          this._unregisterTrade(trade);
          this.currentTrade = null;
          await Bot.updateOne({ _id: this.bot._id }, { status: 'idle' });
          eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
        }
      }
    }
  }

  async onSellOrderUpdate(update, trade) {
    if (!trade) return;
    if (update.status === 'FILLED') {
      logger.info({ botId: this.bot._id.toString(), orderId: update.orderId, avgPrice: update.avgPrice }, 'trader: SELL FILLED (via WS)');
      // FIX 3: ส่ง trade ไปด้วยเพื่อให้ handleSellFilled ใช้ trade ที่ถูกต้อง (ไม่ใช่ currentTrade)
      await this.handleSellFilled(update, trade);
      return;
    }
    if (update.status === 'PARTIALLY_FILLED') {
      logger.info({ botId: this.bot._id.toString(), orderId: update.orderId, executedQty: update.executedQty }, 'trader: SELL PARTIALLY_FILLED (via WS)');
      // ส่งไป handleSellFilled ตามปกติ (ส่วนใหญ่จะ fill ที่เหลือใน tick ถัดไป)
      await this.handleSellFilled(update, trade);
      return;
    }
    if (update.status === 'CANCELED' || update.status === 'EXPIRED') {
      if (trade.state === 'selling') {
        logger.warn({ botId: this.bot._id.toString(), orderId: update.orderId, status: update.status }, 'trader: SELL cancelled externally');
        // ยังถือ asset → schedule holding retry แทนการทิ้ง
        await Trade.updateOne(
          { _id: trade._id, state: 'selling' },
          { state: 'holding', sellStatus: update.status, error: `SELL ${update.status.toLowerCase()}` }
        );
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        eventBus.emit('trade:update', { tradeId: trade._id, state: 'holding' });
        // retry MARKET ทุก 30s
        this.scheduleHoldingRetry(trade, trade.sellQty, trade.buyPrice, trade.targetSellPrice);
      }
    }
  }

  // FIX 3: รับ trade parameter — ไม่ใช้ this.currentTrade โดยตรง (กัน stale reference)
  async handleSellFilled(update, tradeParam) {
    try {
      let trade = tradeParam || this.currentTrade;
      if (!trade) {
        logger.warn({ update }, 'trader: handleSellFilled called without trade context');
        return;
      }
      // FIX-2026-07-13: ถ้า trade ไม่มี buyPrice (เคยเกิดจาก _registerTrade minimal)
      // → re-fetch จาก DB เพื่อให้ pnl.net valid (กัน 'Cast to Number failed for NaN at realizedPnl')
      if (trade.buyPrice == null || trade.buyPrice === undefined) {
        try {
          const fresh = await Trade.findById(trade._id).lean();
          if (fresh && fresh.buyPrice != null) {
            logger.warn({
              tradeId: trade._id.toString(),
              orderId: update.orderId,
            }, 'trader: handleSellFilled — trade snapshot missing buyPrice, re-fetched from DB');
            trade = fresh;
          }
        } catch (err) {
          logger.error({ err: err.message }, 'trader: handleSellFilled DB re-fetch failed');
          return;
        }
        if (trade.buyPrice == null || trade.buyPrice === undefined) {
          logger.error({
            tradeId: trade._id.toString(),
            orderId: update.orderId,
          }, 'trader: handleSellFilled ABORT — buyPrice still missing after DB re-fetch');
          return;
        }
      }
      const sellQty = parseFloat(update.executedQty);
      const sellPrice = parseFloat(update.avgPrice) || (parseFloat(update.cumulativeQuoteQty) / sellQty);
      const feeRate = fees.getMakerRate();
      const pnl = fees.calcPnl({
        buyPrice: trade.buyPrice,
        sellPrice,
        qty: sellQty,
        feeRate,
      });

      // Idempotent guard: กัน double-update ถ้า WS มาซ้ำ
      // FIX-2026-07-23b: เพิ่ม 'stopping' เพื่อให้ stop-loss flow ที่ atomic claim ไปแล้ว
      //   แต่ Binance ยังส่ง WS SELL FILLED หลัง cancel (-2011) → handler นี้ต้อง update DB
      //   - ถ้า handleSellFilled ไม่ match guard → trade ค้างใน 'stopping' + _emergencyMarketSell จะทำ MARKET ซ้ำ
      //   - ถ้า handleSellFilled match → 'stopping' → 'sold' ด้วยราคาจริงของ LIMIT_MAKER fill (ถูกต้อง)
      //   - atomic guard กัน _emergencyMarketSell race: ใคร update 'sold' ก่อนชนะ
      const upd = await Trade.updateOne(
        {
          _id: trade._id,
          state: { $in: ['selling', 'holding', 'stopping'] },
        },
        {
          state: 'sold',
          sellStatus: 'FILLED',
          sellPrice,
          sellQty,
          sellQuoteQty: parseFloat(update.cumulativeQuoteQty),
          sellFilledAt: new Date(update.ts || Date.now()),
          realizedPnl: pnl.net,
          pnlPercent: pnl.pnlPercent,
        }
      );
      if (upd.modifiedCount === 0) {
        logger.debug({ tradeId: trade._id.toString() }, 'trader: handleSellFilled skipped — already sold');
        return;
      }

      // update bot stats — ใช้ $inc (atomic) แทน read-modify-write เพื่อกัน
      // lost update เวลา trader instance ถือ snapshot เก่า (เคยทำให้
      // totalTrades ตกหล่นเมื่อ 2 trade ปิดใกล้กัน หรือระหว่าง restart)
      await Bot.updateOne(
        { _id: this.bot._id },
        {
          $inc: {
            totalPnl: pnl.net,
            totalTrades: 1,
            winTrades: (pnl.net > 0 ? 1 : 0),
          },
          $set: { status: 'idle', lastError: '' },
        }
      );

      this._unregisterTrade(trade);
      if (this.currentTrade && this.currentTrade._id.toString() === trade._id.toString()) {
        this.currentTrade = null;
      }
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
      eventBus.emit('trade:update', { tradeId: trade._id, state: 'sold' });
      logger.info({
        botId: this.bot._id.toString(),
        pnl: pnl.net,
        pnlPercent: pnl.pnlPercent.toFixed(4),
      }, 'trader: SELL FILLED, round complete');
    } catch (err) {
      logger.error({ err: err.message }, 'trader: handleSellFilled error');
    }
  }

  // ─── Helpers ───────────────────────────────────────

  /**
   * FIX-2026-07-15: Periodic sweep — fetch latest 5 candles via REST แล้ว replay onCandleClosed
   * สำหรับ candle ที่ close ไปแล้วและยังไม่ถูก process (เช่น WS หลุดระหว่าง close)
   *
   * @param {string} trigger — 'periodic-sweep' | 'ws-reconnect' | 'startup'
   */
  async reconcileKlines(trigger = 'periodic-sweep') {
    if (!this.running) {
      logger.debug({ botId: this.bot._id.toString(), trigger }, 'trader: reconcileKlines skipped (not running)');
      return;
    }
    if (this.reconcileInFlight) {
      logger.debug({ botId: this.bot._id.toString(), trigger }, 'trader: reconcileKlines skipped (already in flight)');
      return;
    }
    this.reconcileInFlight = true;
    try {
      // FIX-2026-07-15: ดึง candles ตั้งแต่ candle ถัดจาก signal ล่าสุด
      //   ปัญหาเดิม (v3): max(lastSignalCloseMs, cacheLastCloseMs)+1
      //     → cache.lastCloseTime มาจาก forming candle (closeTime > now) → startTime เป็นอนาคต → Binance คืน len=0
      //   ปัญหาเดิม (v5): ใช้ max(lastSignalCloseMs, latestClosedInCacheMs) → cache tail advance ทุก tick
      //     → startTime ขยับตาม cache → fetch แค่ 1 candle forming ตลอด → ไม่เคยดึง candles เก่าใน cache
      //   fix (v6): ใช้แค่ lastSignalCloseMs
      //     → Binance คืน candles ทั้งหมดตั้งแต่ signal ล่าสุด (รวม candles ที่อยู่ใน cache แล้ว)
      //     → onCandleClosed({replay:true}) จะใช้ detectS1Signals(klines) รันบน full cache
      //        → หา signal ที่ closeTime ตรงกับ candle ที่ replay → save signal + place BUY
      const lastSignalCloseMs = this.bot.lastSignalCloseTime || 0;
      const nowMs = Date.now();

      // FIX: fresh-bot guard — ถ้าบอทเพิ่ง enabled (lastSignalCloseTime = 0) ห้าม replay
      //   historical candles เพราะจะไป trigger BUY บน S1 เก่าที่เกิดก่อน start
      //   (เคยเจอ user รายงาน: "กด Start แล้วบอทเปิดออร์เดอร์ทันทีทั้งที่กราฟยังไม่มีสัญญาณ")
      //   fix: ดึง candles 2 แท่งล่าสุด, set cursor ไปที่แท่ง closed ล่าสุด, ไม่เรียก onCandleClosed
      //        → ปล่อยให้ WS handle candle close ที่เกิดขึ้นหลัง start เท่านั้น
      if (lastSignalCloseMs === 0) {
        const initParams = {
          symbol: this.bot.symbol,
          interval: this.bot.timeframe,
          limit: 2,
        };
        const initRaw = await binanceRest.getKlines(initParams);
        let latestClosedMs = 0;
        for (const k of (initRaw || [])) {
          const ct = k[6];
          if (ct <= nowMs && ct > latestClosedMs) latestClosedMs = ct;
        }
        if (latestClosedMs > 0) {
          await Bot.updateOne(
            { _id: this.bot._id },
            { $set: { lastSignalCloseTime: latestClosedMs } }
          ).catch((err) => logger.warn({ err: err.message }, 'trader: seed lastSignalCloseTime failed'));
          this.bot.lastSignalCloseTime = latestClosedMs;
          logger.info({
            botId: this.bot._id.toString(),
            trigger,
            latestClosedMs,
            nowMs,
          }, 'trader: fresh bot — cursor seeded to latest closed, skipped historical replay');
        } else {
          logger.debug({ botId: this.bot._id.toString(), trigger }, 'trader: fresh bot — no closed candles yet');
        }
        return;
      }

      const params = {
        symbol: this.bot.symbol,
        interval: this.bot.timeframe,
        limit: 200,
      };
      if (lastSignalCloseMs > 0) params.startTime = lastSignalCloseMs + 1;
      const raw = await binanceRest.getKlines(params);
      if (!Array.isArray(raw) || raw.length === 0) {
        logger.debug({ botId: this.bot._id.toString(), trigger, lastSignalCloseMs }, 'trader: reconcileKlines — no klines returned');
        return;
      }

      let replayed = 0;
      let actuallySeeded = 0;
      let skipped = 0;
      let advancedToMs = lastSignalCloseMs;
      for (const k of raw) {
        const openTime = k[0];
        const closeTime = k[6];
        if (closeTime > nowMs) { skipped += 1; continue; } // ยังไม่ close (current forming candle) — skip
        if (closeTime <= lastSignalCloseMs) { skipped += 1; continue; } // เคย process signal แล้ว
        if (closeTime === openTime) { skipped += 1; continue; } // sanity
        // Replay — onCandleClosed({replay:true}) จะ:
        //   1) append candle เข้า cache (ถ้าใหม่กว่า cache tail)
        //   2) run detectS1Signals(klines) บน full cache
        //   3) ถ้าเจอ S1 ที่ closeTime ตรงกับ candle นี้ → save Signal + place BUY
        const beforeCacheSize = klineCache.size(this.bot.symbol, this.bot.timeframe);
        await this.onCandleClosed({
          openTime,
          closeTime,
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          isClosed: true,
        }, { replay: true, trigger });
        replayed += 1;
        if (closeTime > advancedToMs) advancedToMs = closeTime;
        const afterCacheSize = klineCache.size(this.bot.symbol, this.bot.timeframe);
        if (afterCacheSize > beforeCacheSize) actuallySeeded += 1;
      }

      // FIX-2026-07-15: advance lastSignalCloseTime แม้ไม่เจอ S1 (กัน re-fetch ซ้ำรอบหน้า)
      if (advancedToMs > lastSignalCloseMs) {
        await Bot.updateOne(
          { _id: this.bot._id },
          { $max: { lastSignalCloseTime: advancedToMs } }
        ).catch((err) => logger.warn({ err: err.message }, 'trader: advance lastSignalCloseTime failed'));
        this.bot.lastSignalCloseTime = advancedToMs;
      }

      if (replayed > 0) {
        logger.info({
          botId: this.bot._id.toString(),
          trigger,
          replayed,
          actuallySeeded,
          skipped,
          fromMs: lastSignalCloseMs,
          advancedToMs,
        }, 'trader: reconciled missed candle closes');
      } else {
        logger.debug({
          botId: this.bot._id.toString(),
          trigger,
          checked: raw.length,
          skipped,
          lastSignalCloseMs,
        }, 'trader: sweep ok, no missed closes');
      }
    } catch (err) {
      // ไม่ throw — sweep ล้มเหลวไม่ควรหยุดบอท
      logger.warn({ botId: this.bot._id.toString(), trigger, err: err.message, stack: err.stack }, 'trader: reconcileKlines error');
    } finally {
      this.reconcileInFlight = false;
    }
  }

  // FIX 6: เพิ่ม random suffix กัน -2010 Duplicate order sent
  // (กรณี retry ที่ ts+retry+side ตรงกัน)
  makeClientOrderId(side, refTs, retry) {
    const ts = typeof refTs === 'number' ? refTs : new Date(refTs).getTime();
    const shortBot = this.bot._id.toString().slice(-6);
    const rand = Math.random().toString(36).slice(2, 8); // 6-char random
    return `b${shortBot}-${ts}-${retry}-${side}-${rand}`.slice(0, 36); // Binance limit 36 chars
  }
}

function config_recvWindow() {
  // lazy load เพื่อไม่ให้เกิด circular
  return require('../../config').binance.recvWindow;
}

// FIX-2026-07-15: periodic kline sweep interval (ms) — safety net against missed kline:closed events
//   WS reconnect storms ดูดูดสังเกตได้ทุกๆ 1-2 วินาที, แต่ละครั้งทำให้ candle close อาจหายไป
//   ดังนั้น sweep ทุก 90s → กลบ gap ภายใน 90s (เคสเดิมพลาดไป 1.5 ชม. ก่อน user เห็น)
const SWEEP_INTERVAL_MS = 90 * 1000;

module.exports = Trader;