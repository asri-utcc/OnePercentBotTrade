'use strict';

const Decimal = require('decimal.js');
const binanceRest = require('../binance/binanceRest');
const symbolInfo = require('../binance/symbolInfo');
const fees = require('../binance/fees');
const signalEngine = require('./signalEngine');
const BacktestResult = require('../db/models/BacktestResult');
const logger = require('../utils/logger');

/**
 * ดึง klines ย้อนหลังจาก Binance (loop ถ้าเกิน 1000 แท่ง)
 */
async function fetchKlines({ symbol, interval, fromMs, toMs }) {
  const all = [];
  let cursor = fromMs;
  const stepMs = intervalToMs(interval) * 1000;
  const SAFETY_LIMIT = 5000;

  while (cursor < toMs && all.length < SAFETY_LIMIT) {
    const limit = Math.min(1000, SAFETY_LIMIT - all.length);
    const resp = await binanceRest.getKlines({
      symbol,
      interval,
      startTime: cursor,
      endTime: toMs,
      limit,
    });

    if (!resp || resp.length === 0) break;

    for (const k of resp) {
      const [openTime, open, high, low, close, volume, closeTime] = k;
      all.push({
        openTime,
        openTimeISO: new Date(openTime).toISOString(),
        closeTime,
        closeTimeISO: new Date(closeTime).toISOString(),
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: parseFloat(volume),
      });
    }

    const lastOpenTime = resp[resp.length - 1][0];
    cursor = lastOpenTime + stepMs;

    if (resp.length < limit) break;
  }

  return all;
}

function intervalToMs(interval) {
  const m = interval.match(/^(\d+)([mhdwM])$/);
  if (!m) throw new Error(`Invalid interval: ${interval}`);
  const n = parseInt(m[1], 10);
  const u = m[2];
  switch (u) {
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    case 'w': return n * 86400 * 7;
    case 'M': return n * 86400 * 30;
    default: throw new Error(`Unsupported interval unit: ${u}`);
  }
}

/**
 * Floor qty ตาม stepSize (e.g. "0.01000000" → precision 2)
 */
function floorQtyToStep(rawQty, stepSizeStr) {
  if (!stepSizeStr) return new Decimal(rawQty);
  const step = new Decimal(stepSizeStr);
  if (step.isZero()) return new Decimal(rawQty);
  return new Decimal(rawQty).div(step).floor().mul(step);
}

/**
 * Simulate trades from S1 signals — realistic model matching LIVE bot behavior.
 *
 * Rules (ตรงกับ bot จริง):
 * 1. BUY ที่ราคา signal close (assume เป็น best bid)
 *    → fill ก็ต่อเมื่อ future candle's low <= buyPrice (ภายใน maxBuyWait แท่ง)
 *    → ถ้าไม่ fill → ยกเลิก → ไม่มี PnL
 * 2. ถ้า bot มี slot เต็ม (เปิดไม้อยู่ maxConcurrentTrades ไม้) → skip signal
 * 3. SELL ที่ target price (buyPrice × (1 + tp% + 2×fee))
 *    → fill ก็ต่อเมื่อ future candle's high >= target
 *    → **ไม่มี stop loss** → ถ้าไม่ fill ภายในข้อมูล → mark as 'still_holding'
 *       (ในชีวิตจริงจะถือต่อจน TP ถึง ไม่บังคับขาย)
 * 4. qty ถูก floor ตาม stepSize ของ symbol (ไม่ปัดขึ้น)
 * 5. ถ้า notional < minNotional → skip (Binance จะปฏิเสธ)
 *
 * @param klines, signals, opts {tpPercent, capitalPerTrade, feeRate,
 *        maxBuyWait, maxConcurrentTrades, stepSize, minNotional}
 */
function simulateTrades({ klines, signals, opts }) {
  const {
    tpPercent = 0.1,
    capitalPerTrade = 10,
    feeRate = 0.00075,
    maxBuyWait = 6,
    maxConcurrentTrades = 10,
    stepSize = null,
    minNotional = new Decimal('10'),
  } = opts;

  const trades = [];
  // Active trades: เรียงตาม exitIdx ascending (FIFO) เพื่อ clean up เร็ว
  const activeExits = []; // array of { buyCandleIdx, exitIdx }

  // หา stepMs ของชุด klines (ใช้สำหรับ BUY fill timestamp = กลางแท่ง)
  const stepMs = klines.length >= 2 ? (klines[1].openTime - klines[0].openTime) : 0;

  for (const sig of signals) {
    const idx = sig.index;
    const buyPrice = sig.close;
    const target = new Decimal(buyPrice).mul(1 + tpPercent / 100 + 2 * feeRate).toNumber();

    // ─── Calculate qty (floor to stepSize) ───────────────
    let qty;
    try {
      const rawQty = new Decimal(capitalPerTrade).div(new Decimal(buyPrice));
      qty = floorQtyToStep(rawQty, stepSize);
    } catch (e) {
      qty = new Decimal(capitalPerTrade / buyPrice);
    }

    const notional = qty.mul(new Decimal(buyPrice));

    // ─── Clean up active trades ที่ปิดก่อน candle idx ───
    while (activeExits.length > 0 && activeExits[0].exitIdx < idx) {
      activeExits.shift();
    }

    // ─── Check concurrent slot ────────────────────────
    if (activeExits.length >= maxConcurrentTrades) {
      trades.push({
        signalTime: new Date(sig.openTime),
        candleCloseTime: new Date(sig.closeTime),
        buyPrice,
        targetSellPrice: target,
        sellPrice: null,
        buyFilled: false,
        sellFilled: false,
        qty: qty.toNumber(),
        notional: notional.toNumber(),
        grossPnl: 0,
        fees: 0,
        realizedPnl: 0,
        pnlPercent: 0,
        exitReason: 'max_concurrent_skip',
        bgState: sig.bgState,
      });
      continue;
    }

    // ─── Notional check ─────────────────────────────────
    if (notional.lessThan(minNotional)) {
      trades.push({
        signalTime: new Date(sig.openTime),
        candleCloseTime: new Date(sig.closeTime),
        buyPrice,
        targetSellPrice: target,
        sellPrice: null,
        buyFilled: false,
        sellFilled: false,
        qty: qty.toNumber(),
        notional: notional.toNumber(),
        grossPnl: 0,
        fees: 0,
        realizedPnl: 0,
        pnlPercent: 0,
        exitReason: 'below_min_notional',
        bgState: sig.bgState,
      });
      continue;
    }

    // ─── Phase 1: BUY fill check ─────────────────────────
    // Maker BUY ที่ราคา P จะ fill ก็ต่อเมื่อ:
    //   - candle นั้น dip ลงไปถึง P (low ≤ P)  = "มี taker ขายทับ bid เรา"
    //   - แล้วปิดเหนือ P (close ≥ P)          = "หลังจาก fill แล้ว price ไม่ลงต่อ"
    //                                              (post-only bid ตามลง = ไม่นับ)
    //   - และ volume > 0                       = กัน edge case candle ว่างเปล่า
    // เงื่อนไขเดิม (low ≤ P อย่างเดียว) นับ wick ลงเด้งกลับเป็น fill ทั้งหมด → overcount
    let buyFilled = false;
    let buyCandleIdx = null;
    const buyEnd = Math.min(klines.length, idx + 1 + maxBuyWait);

    for (let j = idx + 1; j < buyEnd; j += 1) {
      const c = klines[j];
      if (c.low <= buyPrice && c.close >= buyPrice && c.volume > 0) {
        buyFilled = true;
        buyCandleIdx = j;
        break;
      }
    }

    if (!buyFilled) {
      trades.push({
        signalTime: new Date(sig.openTime),
        candleCloseTime: new Date(sig.closeTime),
        buyPrice,
        targetSellPrice: target,
        sellPrice: null,
        buyFilled: false,
        sellFilled: false,
        qty: qty.toNumber(),
        notional: notional.toNumber(),
        grossPnl: 0,
        fees: 0,
        realizedPnl: 0,
        pnlPercent: 0,
        exitReason: 'no_buy_fill',
        bgState: sig.bgState,
      });
      continue;
    }

    // ─── Phase 2: SELL fill check (ไม่มี stop loss — รอจนถึง TP หรือจบข้อมูล) ─
    let sellFilled = false;
    let sellPrice = null;
    let sellCandleIdx = null;

    for (let j = buyCandleIdx + 1; j < klines.length; j += 1) {
      if (klines[j].high >= target) {
        sellFilled = true;
        sellPrice = target;
        sellCandleIdx = j;
        break;
      }
    }

    if (sellFilled) {
      const pnlResult = fees.calcPnl({
        buyPrice,
        sellPrice,
        qty: qty.toNumber(),
        feeRate,
      });
      activeExits.push({ buyCandleIdx, exitIdx: sellCandleIdx });
      // BUY fill timestamp = กลางแท่ง (openTime + stepMs/2)
      // สะท้อนว่า maker order มัก fill ระหว่างแท่ง ไม่ใช่ตอนปิดพอดี
      const buyFilledAtMs = stepMs > 0 ? klines[buyCandleIdx].openTime + Math.floor(stepMs / 2) : klines[buyCandleIdx].closeTime;
      trades.push({
        signalTime: new Date(sig.openTime),
        candleCloseTime: new Date(sig.closeTime),
        buyPrice,
        targetSellPrice: target,
        sellPrice,
        buyFilled: true,
        sellFilled: true,
        buyFilledAt: new Date(buyFilledAtMs),
        sellFilledAt: new Date(klines[sellCandleIdx].closeTime),
        qty: qty.toNumber(),
        notional: notional.toNumber(),
        grossPnl: pnlResult.gross,
        fees: pnlResult.fees,
        realizedPnl: pnlResult.net,
        pnlPercent: pnlResult.pnlPercent,
        exitReason: 'tp_hit',
        bgState: sig.bgState,
      });
    } else {
      // ไม่มี stop loss → ถือต่อจนกว่าข้อมูลจะหมด → ยังไม่นับ PnL (unrealized)
      activeExits.push({ buyCandleIdx, exitIdx: klines.length });
      const lastClose = klines[klines.length - 1].close;
      const unrealizedPnlResult = fees.calcPnl({
        buyPrice,
        sellPrice: lastClose,
        qty: qty.toNumber(),
        feeRate,
      });
      const buyFilledAtMs = stepMs > 0 ? klines[buyCandleIdx].openTime + Math.floor(stepMs / 2) : klines[buyCandleIdx].closeTime;
      trades.push({
        signalTime: new Date(sig.openTime),
        candleCloseTime: new Date(sig.closeTime),
        buyPrice,
        targetSellPrice: target,
        sellPrice: null,
        buyFilled: true,
        sellFilled: false,
        buyFilledAt: new Date(buyFilledAtMs),
        sellFilledAt: null,
        qty: qty.toNumber(),
        notional: notional.toNumber(),
        grossPnl: 0,
        fees: 0,
        realizedPnl: 0,
        pnlPercent: 0,
        unrealizedPnl: unrealizedPnlResult.net, // บอกให้รู้ว่าถ้าปิดวันนี้จะเป็นเท่าไหร่
        exitReason: 'still_holding',
        bgState: sig.bgState,
      });
    }
  }

  return trades;
}

/**
 * คำนวณ summary statistics จาก trades array
 *
 * Note: Win Rate = wins / signals (ทุก signal นับรวม ไม่ใช่แค่ filled)
 * เพื่อให้สะท้อนคุณภาพของสัญญาณจริง ไม่ใช่ optimistic view
 */
function summarize(trades) {
  const signals = trades.length;
  const tpHit = trades.filter((t) => t.exitReason === 'tp_hit').length;
  const stillHolding = trades.filter((t) => t.exitReason === 'still_holding').length;
  const noBuyFill = trades.filter((t) => t.exitReason === 'no_buy_fill').length;
  const maxConcurrentSkip = trades.filter((t) => t.exitReason === 'max_concurrent_skip').length;
  const belowMinNotional = trades.filter((t) => t.exitReason === 'below_min_notional').length;
  const buyFilled = tpHit + stillHolding;
  const sellFilled = tpHit;

  // wins/losses นับตาม realizedPnl จริง (ไม่ใช่สถานะ fill) — เพื่อให้สะท้อน P&L จริง
  const wins = trades.filter((t) => t.realizedPnl > 0).length;
  const losses = trades.filter((t) => t.realizedPnl < 0).length;
  const breakeven = trades.filter((t) => t.realizedPnl === 0).length;

  const totalPnl = trades.reduce((s, t) => s + (t.realizedPnl || 0), 0);
  const totalFees = trades.reduce((s, t) => s + (t.fees || 0), 0);
  const totalNotional = trades.reduce((s, t) => s + (t.notional || 0), 0);
  const totalPnlPercent = totalNotional > 0 ? (totalPnl / totalNotional) * 100 : 0;

  // Win Rate (realized PnL based): wins / (wins + losses)
  // สะท้อนว่าเมื่อเข้าไม้จริงแล้วกี่เปอร์เซ็นต์ที่กำไร
  const realized = wins + losses;
  const winRate = realized > 0 ? (wins / realized) * 100 : 0;

  // Signal Success Rate: TP hit / signals (คุณภาพของสัญญาณ)
  const signalSuccessRate = signals > 0 ? (tpHit / signals) * 100 : 0;

  const fillRate = signals > 0 ? (buyFilled / signals) * 100 : 0;
  const exitRate = signals > 0 ? (sellFilled / signals) * 100 : 0;

  // Max drawdown บน equity curve (cumulative PnL) + consecutive losses
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  let consecLosses = 0;
  let maxConsecLosses = 0;
  for (const t of trades) {
    equity += t.realizedPnl || 0;
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
    if (t.realizedPnl < 0) {
      consecLosses += 1;
      if (consecLosses > maxConsecLosses) maxConsecLosses = consecLosses;
    } else {
      consecLosses = 0;
    }
  }
  // Max DD as % of peak equity (cap at 100% — can't lose more than what you had)
  const maxDrawdownPercent = peak > 0 ? Math.min((maxDD / peak) * 100, 100) : 0;

  // Profit Factor = sum(wins) / |sum(losses)| — ยิ่งสูงยิ่งดี (>1 = profitable)
  const sumWins = trades.filter((t) => t.realizedPnl > 0).reduce((s, t) => s + t.realizedPnl, 0);
  const sumLosses = Math.abs(trades.filter((t) => t.realizedPnl < 0).reduce((s, t) => s + t.realizedPnl, 0));
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? Infinity : 0);

  // Average PnL per signal (expectancy)
  const avgPnlPerSignal = signals > 0 ? totalPnl / signals : 0;

  return {
    signalsCount: signals,
    buyFilledCount: buyFilled,
    sellFilledCount: sellFilled,
    noBuyFillCount: noBuyFill,
    stillHoldingCount: stillHolding,
    maxConcurrentSkipCount: maxConcurrentSkip,
    belowMinNotionalCount: belowMinNotional,
    tpHitCount: tpHit,
    wins,
    losses,
    breakeven,
    winRate,                // TP hits / signals (ไม่มี loss เพราะไม่มี stop loss)
    signalSuccessRate,      // TP hits / signals (เหมือน winRate ในโหมดนี้)
    fillRate,               // buy filled / signals
    exitRate,               // TP filled / signals
    totalPnl,
    totalPnlPercent,
    totalFees,
    totalNotional,
    totalUnrealizedPnl: trades.reduce((s, t) => s + (t.unrealizedPnl || 0), 0),
    avgPnlPerSignal,
    maxDrawdown: maxDD,
    maxDrawdownPercent,
    maxConsecutiveLosses: maxConsecLosses,
    profitFactor,
  };
}

async function runBacktest(params) {
  const {
    symbol,
    timeframe,
    from,
    to,
    tpPercent = 0.1,
    capitalPerTrade = 10,
    useBnbForFees = false,
    maxBuyWait = 6,
    maxConcurrentTrades = 10,
  } = params;

  const fromMs = typeof from === 'string' ? new Date(from).getTime() : from;
  const toMs = typeof to === 'string' ? new Date(to).getTime() : to;

  logger.info({ symbol, timeframe, fromMs, toMs }, 'backtest: fetching klines');

  const klines = await fetchKlines({
    symbol,
    interval: timeframe,
    fromMs,
    toMs,
  });

  if (klines.length < 50) {
    throw new Error(`Not enough klines: got ${klines.length}, need >= 50`);
  }

  // Load symbol info for stepSize + minNotional
  let stepSizeStr = null;
  let minNotional = new Decimal('10');
  try {
    const info = await symbolInfo.loadSymbol(symbol);
    if (info.lotSize) stepSizeStr = info.lotSize.stepSize.toString();
    if (info.notional) minNotional = info.notional.minNotional;
  } catch (err) {
    logger.warn({ err: err.message }, 'backtest: symbol info load failed (using defaults)');
  }

  const { signals } = signalEngine.detectS1Signals(klines);

  logger.info({
    symbol, timeframe, klines: klines.length, signals: signals.length,
    stepSize: stepSizeStr, minNotional: minNotional.toString(),
  }, 'backtest: signals detected');

  const feeRate = fees.getMakerRate({ useBnbForFees });

  const trades = simulateTrades({
    klines,
    signals,
    opts: {
      tpPercent,
      capitalPerTrade,
      feeRate,
      maxBuyWait,
      maxConcurrentTrades,
      stepSize: stepSizeStr,
      minNotional,
    },
  });

  const stats = summarize(trades);

  const storedTrades = trades.length > 500 ? trades.slice(0, 250).concat(trades.slice(-250)) : trades;

  const result = await BacktestResult.create({
    symbol,
    timeframe,
    from: new Date(fromMs),
    to: new Date(toMs),
    // executionModel: รหัสโมเดลที่ใช้ (สำหรับ audit/comparison ผล backtest ต่างรุ่น)
    //  v4_maker_fill: BUY fill = (low ≤ P) AND (close ≥ P) AND (volume > 0)
    //                 BUY price = candle close (proxy for best bid)
    //                 BUY timestamp = mid-candle (openTime + stepMs/2)
    //                 SELL fill = high ≥ target, no stop loss
    executionModel: 'v4_maker_fill',
    params: {
      tpPercent,
      capitalPerTrade,
      feeRate,
      maxBuyWait,
      maxConcurrentTrades,
      stepSize: stepSizeStr,
      minNotional: minNotional.toString(),
      model: 'realistic_v3_no_stoploss',
    },
    signalsCount: signals.length,
    tradesSimulated: trades.length,
    ...stats,
    trades: storedTrades,
  });

  logger.info({
    id: result._id.toString(),
    symbol,
    timeframe,
    signals: signals.length,
    fillRate: stats.fillRate.toFixed(1),
    exitRate: stats.exitRate.toFixed(1),
    winRate: stats.winRate.toFixed(1),
    totalPnl: stats.totalPnl.toFixed(2),
  }, 'backtest: complete');

  return { result, signals, trades, stats };
}

module.exports = {
  fetchKlines,
  intervalToMs,
  simulateTrades,
  summarize,
  runBacktest,
};