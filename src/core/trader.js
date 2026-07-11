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
 */
class Trader {
  constructor(bot) {
    this.bot = bot;
    this.running = false;
    this.currentTrade = null;
    this.retryCheckTimer = null;
    this.currentBookTicker = null;
    this.lastSignalIndex = -1; // index ของแท่งที่ S1 ล่าสุดที่เคย trigger แล้ว (กันยิงซ้ำ)
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

    // order update handler
    this._orderHandler = (update) => {
      if (update.symbol !== this.bot.symbol) return;
      if (!this.currentTrade) return;
      const c = update.clientOrderId || '';
      if (this.currentTrade.buyClientOrderId && c === this.currentTrade.buyClientOrderId) {
        this.onBuyOrderUpdate(update);
      } else if (this.currentTrade.sellClientOrderId && c === this.currentTrade.sellClientOrderId) {
        this.onSellOrderUpdate(update);
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
    if (this._bookTickerHandler) eventBus.off('bookTicker', this._bookTickerHandler);
    if (this._klineHandler) eventBus.off('kline:closed', this._klineHandler);
    if (this._orderHandler) eventBus.off('order:update', this._orderHandler);
    logger.info({ botId: this.bot._id.toString() }, 'trader stopped');
    eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
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

      // 2. ใช้ bid price ล่าสุด (bookTicker) หรือ close ของแท่งถ้ายังไม่มี
      const bid = this.currentBookTicker ? this.currentBookTicker.bid : candle.close;

      // 3. คำนวณ qty
      const { qty } = symbolInfo.calcQtyFromCapital({
        symbol: this.bot.symbol,
        capitalUSDT: this.bot.capitalPerTrade,
        price: bid,
      });

      // 4. round price ตาม tickSize (ใช้ bid ตรงๆ สำหรับ maker)
      const info = symbolInfo.getCached(this.bot.symbol);
      const buyPrice = symbolInfo.roundPrice(bid, info.priceFilter.tickSize).toString();

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
        logger.warn({ botId: this.bot._id.toString(), err: orderResp.error }, 'trader: BUY order rejected');
        await Trade.updateOne(
          { _id: trade._id },
          { state: 'failed', error: `${orderResp.error.code}: ${orderResp.error.msg}` }
        );
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'failed', note: 'BUY order rejected' });
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

        await this.cancelAndRecheck(trade);
        const reCheck = await binanceRest.getOrder({
          symbol: this.bot.symbol,
          orderId: trade.buyOrderId,
        }).catch(() => null);

        if (reCheck && reCheck.status === 'FILLED') {
          await this.handleBuyFilled(trade, reCheck, signalDoc);
          return;
        }

        await Trade.updateOne(
          { _id: trade._id },
          { state: 'cancelled', buyStatus: 'CANCELED' }
        );
        // re-place
        await this.rePlaceBuy(trade, signalDoc, candle, newBid);
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

        await this.cancelAndRecheck(trade);
        const reCheck = await binanceRest.getOrder({
          symbol: this.bot.symbol,
          orderId: trade.buyOrderId,
        }).catch(() => null);

        if (reCheck && reCheck.status === 'FILLED') {
          // match พอดีระหว่าง cancel → ดำเนินการขายตามปกติ
          await this.handleBuyFilled(trade, reCheck, signalDoc);
          return;
        }

        await Trade.updateOne(
          { _id: trade._id },
          { state: 'cancelled', buyStatus: 'CANCELED', error: `retryMax (${retryMax}) reached` }
        );
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'expired', note: `retryMax ${retryMax} reached, bid moved` });
        await Bot.updateOne({ _id: this.bot._id }, { status: 'idle', lastError: `signal expired: retryMax ${retryMax} reached` });
        this.currentTrade = null;
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
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

  // helper: cancel order พร้อม swallow -2011 (Unknown order) ที่อาจเกิดจาก match ไปแล้ว
  async cancelAndRecheck(trade) {
    const cancelResp = await binanceRest.cancelOrder({
      symbol: this.bot.symbol,
      orderId: trade.buyOrderId,
    }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));
    if (cancelResp.error && cancelResp.error.code !== -2011) {
      logger.warn({ botId: this.bot._id.toString(), err: cancelResp.error }, 'trader: cancel failed');
    }
  }

  async rePlaceBuy(prevTrade, signalDoc, candle, newBid) {
    try {
      const info = symbolInfo.getCached(this.bot.symbol);
      const buyPrice = symbolInfo.roundPrice(newBid, info.priceFilter.tickSize).toString();

      const validation = symbolInfo.validateOrder({ symbol: this.bot.symbol, price: buyPrice, qty: prevTrade.buyQty });
      if (!validation.ok) {
        logger.warn({ botId: this.bot._id.toString(), reason: validation.reason }, 'trader: rePlace validation failed');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'expired', note: validation.reason });
        await Bot.updateOne({ _id: this.bot._id }, { status: 'idle' });
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
        logger.warn({ botId: this.bot._id.toString(), err: orderResp.error }, 'trader: rePlace rejected');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'expired', note: 'rePlace rejected' });
        await Bot.updateOne({ _id: this.bot._id }, { status: 'idle' });
        this.currentTrade = null;
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
        return;
      }

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

      eventBus.emit('trade:update', { tradeId: newTrade._id, state: 'placed' });
      this.scheduleRetryCheck(candle, signalDoc);
    } catch (err) {
      logger.error({ err: err.message }, 'trader: rePlaceBuy error');
    }
  }

  async handleBuyFilled(trade, order, signalDoc) {
    try {
      const filledQty = parseFloat(order.executedQty);
      const avgPrice = parseFloat(order.price) || parseFloat(order.cummulativeQuoteQty) / filledQty;

      await Trade.updateOne(
        { _id: trade._id },
        {
          state: 'filled',
          buyStatus: 'FILLED',
          buyPrice: avgPrice,
          buyQty: filledQty,
          buyQuoteQty: parseFloat(order.cummulativeQuoteQty),
          buyFilledAt: new Date(order.updateTime || Date.now()),
        }
      );

      // คำนวณ sell price
      const feeRate = fees.getMakerRate();
      const sellPriceRaw = fees.calcSellPrice({
        buyPrice: avgPrice,
        tpPercent: this.bot.tpPercent,
        feeRate,
      });
      const info = symbolInfo.getCached(this.bot.symbol);
      const sellPrice = symbolInfo.roundPrice(sellPriceRaw, info.priceFilter.tickSize).toString();

      const validation = symbolInfo.validateOrder({ symbol: this.bot.symbol, price: sellPrice, qty: filledQty });
      if (!validation.ok) {
        logger.warn({ reason: validation.reason }, 'trader: SELL validation failed (will hold asset)');
        await Trade.updateOne({ _id: trade._id }, { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: validation.reason });
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        eventBus.emit('trade:update', { tradeId: trade._id, state: 'holding' });
        return;
      }

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
        logger.warn({ err: sellResp.error }, 'trader: SELL order rejected (will hold asset)');
        await Trade.updateOne({ _id: trade._id }, { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: `${sellResp.error.code}: ${sellResp.error.msg}` });
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        eventBus.emit('trade:update', { tradeId: trade._id, state: 'holding' });
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
        await Trade.updateOne({ _id: trade._id }, { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: `${sellResp.error.code}: ${sellResp.error.msg}` });
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
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

      await Bot.updateOne({ _id: this.bot._id }, { status: 'selling' });
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'selling' });
      eventBus.emit('trade:update', { tradeId: trade._id, state: 'selling' });
    } catch (err) {
      logger.error({ err: err.message }, 'trader: handlePartialBuyFill error');
    }
  }

  // ─── Order update handler (จาก User Data Stream) ─
  onBuyOrderUpdate(update) {
    if (!this.currentTrade) return;
    if (update.status === 'FILLED') {
      logger.info({ botId: this.bot._id.toString(), orderId: update.orderId, avgPrice: update.avgPrice }, 'trader: BUY FILLED (via WS)');
      // ดึง order เต็มเพื่อให้แน่ใจ
      binanceRest.getOrder({
        symbol: this.bot.symbol,
        orderId: update.orderId,
      }).then(async (order) => {
        if (this.currentTrade) {
          const sig = await Signal.findById(this.currentTrade.signalId);
          await this.handleBuyFilled(this.currentTrade, order, sig);
        }
      }).catch((err) => logger.error({ err: err.message }, 'trader: onBuyOrderUpdate getOrder failed'));
    }
  }

  onSellOrderUpdate(update) {
    if (!this.currentTrade) return;
    if (update.status === 'FILLED') {
      logger.info({ botId: this.bot._id.toString(), orderId: update.orderId, avgPrice: update.avgPrice }, 'trader: SELL FILLED (via WS)');
      this.handleSellFilled(update);
    }
  }

  async handleSellFilled(update) {
    try {
      const trade = this.currentTrade;
      const sellQty = parseFloat(update.executedQty);
      const sellPrice = parseFloat(update.avgPrice) || (parseFloat(update.cumulativeQuoteQty) / sellQty);
      const feeRate = fees.getMakerRate();
      const pnl = fees.calcPnl({
        buyPrice: trade.buyPrice,
        sellPrice,
        qty: sellQty,
        feeRate,
      });

      await Trade.updateOne(
        { _id: trade._id },
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

      // update bot stats
      const newTotal = (this.bot.totalPnl || 0) + pnl.net;
      const newCount = (this.bot.totalTrades || 0) + 1;
      const newWin = (this.bot.winTrades || 0) + (pnl.net > 0 ? 1 : 0);
      await Bot.updateOne(
        { _id: this.bot._id },
        {
          totalPnl: newTotal,
          totalTrades: newCount,
          winTrades: newWin,
          status: 'idle',
        }
      );

      this.currentTrade = null;
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
  makeClientOrderId(side, refTs, retry) {
    // botId-time-retry-side (deterministic, idempotent)
    const ts = typeof refTs === 'number' ? refTs : new Date(refTs).getTime();
    const shortBot = this.bot._id.toString().slice(-6);
    return `b${shortBot}-${ts}-${retry}-${side}`.slice(0, 36); // Binance limit 36 chars
  }
}

function config_recvWindow() {
  // lazy load เพื่อไม่ให้เกิด circular
  return require('../../config').binance.recvWindow;
}

module.exports = Trader;