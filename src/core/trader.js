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
  }

  // ─── Lifecycle ─────────────────────────────────────
  start() {
    this.running = true;
    logger.info({ botId: this.bot._id.toString(), symbol: this.bot.symbol, tf: this.bot.timeframe }, 'trader start');

    // subscribe WS streams
    eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });

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

    // FIX 3: order update handler ใช้ Map lookup + DB fallback
    this._orderHandler = async (update) => {
      if (update.symbol !== this.bot.symbol) return;
      const c = update.clientOrderId || '';
      if (!c) return;

      // Fast path: in-memory map
      let trade = this.tradesByClientOrderId.get(c);

      // Fallback: DB lookup (กรณี restart หรือ trade จาก round ก่อนหน้า)
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
    if (this._bookTickerHandler) eventBus.off('bookTicker', this._bookTickerHandler);
    if (this._klineHandler) eventBus.off('kline:closed', this._klineHandler);
    if (this._orderHandler) eventBus.off('order:update', this._orderHandler);
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

  // ─── Signal Detection ─────────────────────────────
  async onCandleClosed(candle) {
    if (!this.running) return;
    if (!this.bot.enabled) return;

    // ต้อง warm-up ก่อน
    if (!signalEngine.isWarmedUp(klineCache.size(this.bot.symbol, this.bot.timeframe))) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: waiting for warm-up');
      return;
    }

    const klines = klineCache.getAll(this.bot.symbol, this.bot.timeframe);
    const latestIdx = klines.length - 1;
    if (latestIdx <= this.lastSignalIndex) return; // signal เก่าแล้ว

    const signal = signalEngine.checkS1OnLatestCandle(klines);
    if (!signal) return;

    // กันยิงซ้ำ
    this.lastSignalIndex = latestIdx;

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

    // เช็คเงื่อนไขก่อนเทรด
    if (this.currentTrade && ['placed', 'filled', 'holding', 'selling'].includes(this.currentTrade.state)) {
      logger.info({ botId: this.bot._id.toString() }, 'trader: skip signal (already has active trade)');
      await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'active trade exists' });
      return;
    }

    // เช็คจำนวนไม้
    const activeTrades = await Trade.countDocuments({
      botId: this.bot._id,
      state: { $in: ['placed', 'filled', 'holding', 'selling'] },
    });
    if (activeTrades >= this.bot.maxTrades) {
      logger.info({ botId: this.bot._id.toString(), activeTrades }, 'trader: max trades reached');
      await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'maxTrades reached' });
      return;
    }

    await this.placeBuy(signalDoc, candle);
  }

  // ─── BUY logic ─────────────────────────────────────
  async placeBuy(signalDoc, candle) {
    try {
      // 1. ตรวจว่ามี symbol info
      if (!symbolInfo.getCached(this.bot.symbol)) {
        await symbolInfo.loadSymbol(this.bot.symbol);
      }

      // 2. กำหนด BUY price ที่ post-only safe (LIMIT_MAKER)
      //    - ถ้ามี bookTicker: ใช้ bid ถ้า bid < ask (ปกติ)
      //    - ถ้า bid >= ask (spread collapsed): ใช้ ask - 1 tick แล้ว floor ตาม tickSize
      //      เพื่อให้ price < ask (Binance จะไม่ reject -2010 post-only)
      //    - ถ้าไม่มี bookTicker: fallback candle.close (suboptimal — log warning)
      const ticker = this.currentBookTicker;
      const info = symbolInfo.getCached(this.bot.symbol);
      const tickSize = info.priceFilter.tickSize;

      let bid;
      let ask;
      let refPrice;
      if (ticker && ticker.bid && ticker.ask) {
        bid = ticker.bid;
        ask = ticker.ask;
        if (bid < ask) {
          refPrice = bid;
        } else {
          // spread collapsed — place at ask - 1 tick (still post-only safe)
          refPrice = new Decimal(ask).minus(tickSize);
          logger.warn({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            bid, ask, refPrice: refPrice.toString(),
          }, 'trader: spread collapsed (bid >= ask) — clamping BUY price to ask - tickSize');
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
        await this.failSignal(signalDoc, `validation: ${validation.reason}`);
        return;
      }

      // 6. ── Pre-flight USDT balance check ──
      // ตรวจว่ามี USDT พอจ่าย notional + fee buffer
      const requiredNotional = parseFloat(buyPrice) * parseFloat(qty);
      const feeBufferRate = fees.getMakerRate();
      const requiredWithBuffer = requiredNotional * (1 + feeBufferRate);

      try {
        const account = await binanceRest.getAccount();
        const usdtBal = (account.balances || []).find((b) => b.asset === 'USDT');
        const freeUsdt = usdtBal ? parseFloat(usdtBal.free) : 0;
        if (freeUsdt < requiredWithBuffer) {
          const reason = `insufficient USDT balance: have ${freeUsdt.toFixed(4)}, need ${requiredWithBuffer.toFixed(4)} (notional ${requiredNotional.toFixed(4)} + fee buffer)`;
          logger.warn({ botId: this.bot._id.toString(), freeUsdt, requiredWithBuffer }, 'trader: balance check failed');
          await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: reason });
          await this.failSignal(signalDoc, reason);
          return;
        }
        logger.debug({ botId: this.bot._id.toString(), freeUsdt, requiredWithBuffer }, 'trader: balance check ok');
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
      const orderResp = await binanceRest.newOrder({
        symbol: this.bot.symbol,
        side: 'BUY',
        type: 'LIMIT_MAKER',
        quantity: qty,
        price: buyPrice,
        newClientOrderId: clientOrderId,
        recvWindow: config_recvWindow(),
      }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

      if (orderResp.error) {
        const isPostOnly = orderResp.error.code === -2010;
        const detail = isPostOnly
          ? `BUY -2010 (post-only rejected): bid=${bid} ask=${ask} price=${buyPrice}`
          : `${orderResp.error.code}: ${orderResp.error.msg}`;
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
            ? `BUY -2010: bid ${bid} >= ask ${ask} (spread collapsed)`
            : 'BUY order rejected',
        });
        this._unregisterTrade(trade); // FIX 3
        this.currentTrade = null;
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

      await Bot.updateOne({ _id: this.bot._id }, { status: 'waiting_fill', lastSignalAt: new Date() });
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'waiting_fill' });
      eventBus.emit('trade:update', { tradeId: trade._id, state: 'placed' });

      // 9. Schedule retry check (เช็คสถานะทุก retryTimeMin นาที)
      await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'order_placed' });
      this.scheduleRetryCheck(candle, signalDoc);
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'trader: placeBuy error');
      await Bot.updateOne({ _id: this.bot._id }, { status: 'error', lastError: err.message });
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'error' });
    }
  }

  // helper: บันทึก failure + reset state
  async failSignal(signalDoc, note) {
    await Bot.updateOne({ _id: this.bot._id }, { status: 'idle', lastError: note });
    this.currentTrade = null;
    eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
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

      await Bot.updateOne({ _id: this.bot._id }, { status: 'selling' });
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
          state: { $in: ['filled', 'holding'] },
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
          $set: { status: 'idle' },
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
  scheduleHoldingRetry(trade, qty, buyPrice, targetSellPrice) {
    if (this.holdingRetryTimer) clearTimeout(this.holdingRetryTimer);
    if (!this.running) return;

    this.holdingRetryTimer = setTimeout(async () => {
      if (!this.running) return;
      try {
        // เช็คว่า trade ยังเป็น holding + มี asset จริง
        const fresh = await Trade.findById(trade._id);
        if (!fresh || fresh.state !== 'holding') {
          logger.info({ tradeId: trade._id.toString(), state: fresh?.state }, 'trader: holding retry — trade no longer holding, abort');
          return;
        }

        // ตรวจ base asset balance จริง
        const baseAsset = this.bot.symbol.replace(/USDT$|USDC$|BUSD$/, '');
        const account = await binanceRest.getAccount();
        const bal = (account.balances || []).find((b) => b.asset === baseAsset);
        const freeQty = bal ? parseFloat(bal.free) : 0;

        if (freeQty < qty * 0.95) {
          logger.warn({
            tradeId: trade._id.toString(),
            freeQty, expected: qty, baseAsset,
          }, 'trader: holding retry — asset balance mismatch, will retry in 60s');
          this.scheduleHoldingRetry(trade, qty, buyPrice, targetSellPrice);
          return;
        }

        logger.warn({
          tradeId: trade._id.toString(),
          freeQty, qty,
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
          logger.error({ err: resp.error, tradeId: trade._id.toString() }, 'trader: holding retry MARKET SELL failed');
          // schedule อีก 60s
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
            $set: { status: 'idle' },
          }
        );

        this._unregisterTrade(trade);
        if (this.currentTrade && this.currentTrade._id.toString() === trade._id.toString()) {
          this.currentTrade = null;
        }
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
        eventBus.emit('trade:update', { tradeId: trade._id, state: 'sold' });
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
      // cancel remaining
      await binanceRest.cancelOrder({
        symbol: this.bot.symbol,
        orderId: trade.buyOrderId,
      }).catch(() => null);

      // แล้วเอาไปวางขาย
      const avgPrice = parseFloat(order.cummulativeQuoteQty) / filledQty;
      await Trade.updateOne(
        { _id: trade._id },
        {
          state: 'filled',
          buyStatus: 'PARTIALLY_FILLED',
          buyPrice: avgPrice,
          buyQty: filledQty,
          buyQuoteQty: parseFloat(order.cummulativeQuoteQty),
          buyFilledAt: new Date(),
        }
      );

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
      this._registerTrade({ buyClientOrderId: trade.buyClientOrderId, sellClientOrderId });

      await Bot.updateOne({ _id: this.bot._id }, { status: 'selling' });
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'selling' });
      eventBus.emit('trade:update', { tradeId: trade._id, state: 'selling' });
    } catch (err) {
      logger.error({ err: err.message }, 'trader: handlePartialBuyFill error');
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
      const trade = tradeParam || this.currentTrade;
      if (!trade) {
        logger.warn({ update }, 'trader: handleSellFilled called without trade context');
        return;
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
      const upd = await Trade.updateOne(
        {
          _id: trade._id,
          state: { $in: ['selling', 'holding'] },
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
          $set: { status: 'idle' },
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

module.exports = Trader;