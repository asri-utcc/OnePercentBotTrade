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
 *
 * SAFETY_LIMIT = 300000 — รองรับ:
 *   - 1m  × ~200 วัน
 *   - 3m  × ~600 วัน (~1.6 ปี)   ← รวม 3m × 1 ปี (~175k)
 *   - 5m  × ~1000 วัน (~2.7 ปี)
 *   - 15m × ~3000 วัน (~8 ปี)
 *   - 1h  × ~35 ปี
 * ถ้าเกิน limit จะ log warning + return truncated data + ตั้ง result.truncated=true
 */
async function fetchKlines({ symbol, interval, fromMs, toMs, onProgress = null }) {
  const all = [];
  let cursor = fromMs;
  const stepMs = intervalToMs(interval) * 1000;
  // FIX 2026-07-13: SAFETY_LIMIT เดิม 5000 ตัดข้อมูลเงียบ ๆ เวลาขอ > 17 วัน บน 5m
  //   เพิ่มเป็น 100,000 รองรับ 3–6 เดือนบน 5m
  // FIX 2026-07-13 (round 2): bump เป็น 300,000 รองรับ 3m × 1 ปี (~175k)
  const SAFETY_LIMIT = 300000;

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
    if (onProgress) onProgress(all.length);
  }

  const truncated = all.length >= SAFETY_LIMIT && cursor < toMs;
  return { klines: all, truncated };
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
  // จำนวนไม้ที่เปิดพร้อมกันสูงสุดตลอด simulation (peak concurrency)
  // ใช้ดูว่า bot ต้องการ maxConcurrentTrades ≥ เท่าไหร่ถึงจะรองรับช่วงที่ราคาไม่ TP
  let maxConcurrentTradesUsed = 0;
  const trackPeak = () => {
    if (activeExits.length > maxConcurrentTradesUsed) {
      maxConcurrentTradesUsed = activeExits.length;
    }
  };

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
    // ⚠️ ใช้ filter ทั้ง array ไม่ใช่ shift() ที่หัว เพราะ array ไม่เรียงตาม exitIdx:
    //   - tp_hit       → exitIdx = sellCandleIdx (อาจน้อย)
    //   - still_holding → exitIdx = klines.length (มากสุด)
    // ถ้า shift() แค่หัว จะ block entries ที่อยู่หลัง still_holding และ exit ไปแล้ว
    // → activeExits.length มากเกินจริง → max_concurrent_skip ทั้ง ๆ ที่ slot ว่าง
    // in-place filter (activeExits is const):
    const remaining = activeExits.filter((e) => e.exitIdx >= idx);
    activeExits.length = 0;
    activeExits.push(...remaining);
    trackPeak(); // track ไม้ที่เหลืออยู่หลัง cleanup (ก่อน push ใหม่)

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
      trackPeak(); // track หลัง push (TP hit ที่ยังไม่ close)
      // BUY/SELL fill timestamp = กลางแท่ง (openTime + stepMs/2)
      // สะท้อนว่า maker order มัก fill ระหว่างแท่ง ไม่ใช่ตอนปิดพอดี
      const buyFilledAtMs = stepMs > 0 ? klines[buyCandleIdx].openTime + Math.floor(stepMs / 2) : klines[buyCandleIdx].closeTime;
      const sellFilledAtMs = stepMs > 0 ? klines[sellCandleIdx].openTime + Math.floor(stepMs / 2) : klines[sellCandleIdx].closeTime;
      trades.push({
        signalTime: new Date(sig.openTime),
        candleCloseTime: new Date(sig.closeTime),
        buyPrice,
        targetSellPrice: target,
        sellPrice,
        buyFilled: true,
        sellFilled: true,
        buyFilledAt: new Date(buyFilledAtMs),
        sellFilledAt: new Date(sellFilledAtMs),
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
      trackPeak(); // track หลัง push (still_holding ถือต่อจนจบข้อมูล)
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

  return { trades, maxConcurrentTradesUsed };
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

  const { klines, truncated } = await fetchKlines({
    symbol,
    interval: timeframe,
    fromMs,
    toMs,
  });

  if (truncated) {
    logger.warn({
      symbol,
      timeframe,
      requestedDays: Math.round((toMs - fromMs) / 86400000),
      actualCandles: klines.length,
      actualDays: Math.round((klines[klines.length - 1].openTime - klines[0].openTime) / 86400000),
    }, 'backtest: klines truncated by SAFETY_LIMIT — requested range exceeds fetch cap');
  }

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
    truncated,
    actualDays: klines.length > 1
      ? Math.round((klines[klines.length - 1].openTime - klines[0].openTime) / 86400000)
      : 0,
  }, 'backtest: signals detected');

  const feeRate = fees.getMakerRate({ useBnbForFees });

  const { trades, maxConcurrentTradesUsed } = simulateTrades({
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
  // เพิ่ม peak concurrency เข้า stats (track ไว้ระหว่าง simulate)
  stats.maxConcurrentTradesUsed = maxConcurrentTradesUsed;

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
    maxConcurrentTradesUsed,
  }, 'backtest: complete');

  return {
    result,
    signals,
    trades,
    stats,
    truncated,        // FIX 2026-07-13: แจ้งให้ UI รู้ว่าข้อมูลถูกตัดจาก SAFETY_LIMIT
    requestedDays: Math.round((toMs - fromMs) / 86400000),
    actualDays: klines.length > 1
      ? Math.round((klines[klines.length - 1].openTime - klines[0].openTime) / 86400000)
      : 0,
    candlesFetched: klines.length,
  };
}

module.exports = {
  fetchKlines,
  intervalToMs,
  simulateTrades,
  summarize,
  runBacktest,
  runMultiBacktest, // FIX-2026-07-30: multi-bot backtest with shared capital pool
};

/**
 * FIX-2026-07-30: Multi-bot backtest engine
 *   - input: { totalCapital, from, to, bots: [{symbol, timeframe, tpPercent, capitalPerTrade, maxConcurrentTrades, useBnbForFees, maxBuyWait}] }
 *   - แต่ละบอท pre-fetch klines + generate signals แยก
 *   - รวม signals ทั้งหมด → เรียงตาม openTime (asc)
 *   - shared simulator: ตรวจ "sum(capitalPerTrade ของ active ทุกบอท) <= totalCapital" ก่อน BUY
 *     - ถ้าเกิน → skip signal นั้น (mark skipped: 'capital_exhausted')
 *   - per-bot stats + combined stats
 *   - output: { perBot: [{botId, symbol, timeframe, trades, stats, skipped}], combined: {trades, stats, capitalUsagePeak}, peaks }
 */
async function runMultiBacktest(params) {
  const {
    totalCapital,
    from,
    to,
    bots = [],
  } = params;

  if (!totalCapital || totalCapital <= 0) throw new Error('totalCapital required (> 0)');
  if (!bots.length) throw new Error('bots[] required (>= 1)');
  if (!from || !to) throw new Error('from, to required');

  const fromMs = typeof from === 'string' ? new Date(from).getTime() : from;
  const toMs = typeof to === 'string' ? new Date(to).getTime() : to;
  const totalCap = new Decimal(totalCapital);

  // 1) Pre-fetch klines + signals per bot (parallel)
  const botInputs = await Promise.all(bots.map(async (b, idx) => {
    const botId = b.botId || `bot_${idx}`;
    const feeRate = fees.getMakerRate({ useBnbForFees: !!b.useBnbForFees });
    const { klines, truncated } = await fetchKlines({
      symbol: b.symbol.toUpperCase(),
      interval: b.timeframe,
      fromMs,
      toMs,
    });
    if (klines.length < 50) throw new Error(`${b.symbol}: not enough klines (${klines.length})`);
    // FIX-2026-07-30: per-bot KC multiplier — ส่ง opts.mult เข้า computeBgStates/detectS1Signals
    const signalOpts = {
      mult: b.kcMult != null ? parseFloat(b.kcMult) : 1.5,
      xs1Enabled: b.xs1Enabled !== false, // default true
    };
    const states = signalEngine.computeBgStates(klines, signalOpts);
    const signals = signalEngine.detectS1Signals(klines, signalOpts);
    let stepSizeStr = null;
    let minNotional = new Decimal('10');
    try {
      const info = await symbolInfo.loadSymbol(b.symbol.toUpperCase());
      if (info.lotSize) stepSizeStr = info.lotSize.stepSize.toString();
      if (info.minNotional) minNotional = new Decimal(info.minNotional.toString());
    } catch (_) { /* keep defaults */ }
    return {
      botId,
      cfg: {
        symbol: b.symbol.toUpperCase(),
        timeframe: b.timeframe,
        tpPercent: parseFloat(b.tpPercent),
        capitalPerTrade: parseFloat(b.capitalPerTrade),
        feeRate,
        maxBuyWait: b.maxBuyWait != null ? parseInt(b.maxBuyWait, 10) : 6,
        maxConcurrentTrades: parseInt(b.maxConcurrentTrades, 10),
        stepSize: stepSizeStr,
        minNotional,
        kcMult: signalOpts.mult,
      },
      klines,
      signals: signals.map((s) => ({ ...s, botId })),
      truncated,
      candlesFetched: klines.length,
    };
  }));

  // 2) Merge signals across bots + sort by openTime asc
  const merged = [];
  for (const bi of botInputs) {
    for (const s of bi.signals) merged.push({ ...s, _cfg: bi.cfg, _klines: bi.klines });
  }
  merged.sort((a, b) => a.openTime - b.openTime);

  // 3) Shared capital pool simulator
  // Active trades = array of { botId, exitIdx, capitalUsed }
  const activeExits = [];
  let peakCapitalUsed = new Decimal(0);
  let peakConcurrentTrades = 0;
  let capitalExhaustedSkips = 0;

  // Per-bot trade arrays (เก็บแยก เพื่อ summary per-bot)
  const perBotTrades = {};
  for (const bi of botInputs) perBotTrades[bi.botId] = [];

  const allTrades = [];
  for (const sig of merged) {
    const cfg = sig._cfg;
    const idx = sig.index;
    const buyPrice = sig.close;
    const target = new Decimal(buyPrice).mul(1 + cfg.tpPercent / 100 + 2 * cfg.feeRate).toNumber();
    const stepMs = sig._klines.length >= 2 ? (sig._klines[1].openTime - sig._klines[0].openTime) : 0;

    // Qty calc
    let qty;
    try {
      const rawQty = new Decimal(cfg.capitalPerTrade).div(new Decimal(buyPrice));
      qty = floorQtyToStep(rawQty, cfg.stepSize);
    } catch (_) {
      qty = new Decimal(cfg.capitalPerTrade / buyPrice);
    }
    const notional = qty.mul(new Decimal(buyPrice));

    // Cleanup active trades that exit before this idx
    const before = activeExits.length;
    const remaining = activeExits.filter((e) => e.exitIdx >= idx);
    activeExits.length = 0;
    activeExits.push(...remaining);

    // Track peak concurrency (across all bots)
    if (activeExits.length > peakConcurrentTrades) peakConcurrentTrades = activeExits.length;

    // ─── Check per-bot concurrent slot ─────────────
    const activeForBot = activeExits.filter((e) => e.botId === sig.botId).length;
    if (activeForBot >= cfg.maxConcurrentTrades) {
      // slot เต็ม → skip (เหมือน single-bot behavior)
      perBotTrades[sig.botId].push({
        signalTime: new Date(sig.openTime),
        candleCloseTime: new Date(sig.closeTime),
        buyPrice,
        exitReason: 'max_concurrent_skip',
        realizedPnl: 0,
      });
      continue;
    }

    // ─── Check shared capital pool ────────────────
    const currentUsed = activeExits.reduce((s, e) => s + e.capitalUsed, 0);
    if (currentUsed + cfg.capitalPerTrade > totalCap.toNumber()) {
      capitalExhaustedSkips++;
      perBotTrades[sig.botId].push({
        signalTime: new Date(sig.openTime),
        candleCloseTime: new Date(sig.closeTime),
        buyPrice,
        exitReason: 'capital_exhausted_skip',
        realizedPnl: 0,
      });
      continue;
    }

    // ─── Buy fill check (เหมือน single) ────────────
    const candle = sig._klines[idx];
    const low = candle.low;
    const close = candle.close;
    const volume = candle.volume;
    if (!(low <= buyPrice && close >= buyPrice && volume > 0)) {
      // post-only bid skip (บอทจริงตามลง = ไม่นับ)
      continue;
    }

    // ─── Open trade ──────────────────────────────
    // Find exit: scan forward for TP hit
    let exitIdx = sig._klines.length; // still holding by default
    for (let j = idx + 1; j < sig._klines.length; j++) {
      if (sig._klines[j].high >= target) { exitIdx = j; break; }
      if (j - idx >= cfg.maxBuyWait) break;
    }
    const exitCandle = exitIdx < sig._klines.length ? sig._klines[exitIdx] : null;
    const exitPrice = exitCandle ? exitCandle.high : null;
    let pnl = null;
    if (exitPrice != null) {
      const gross = new Decimal(exitPrice).minus(new Decimal(buyPrice)).mul(qty);
      const feeBuy = new Decimal(buyPrice).mul(qty).mul(cfg.feeRate);
      const feeSell = new Decimal(exitPrice).mul(qty).mul(cfg.feeRate);
      pnl = gross.minus(feeBuy).minus(feeSell).toNumber();
    }

    const trade = {
      botId: sig.botId,
      symbol: cfg.symbol,
      timeframe: cfg.timeframe,
      signalTime: new Date(sig.openTime),
      candleCloseTime: new Date(sig.closeTime),
      buyTime: new Date(sig.openTime + stepMs / 2),
      buyPrice,
      qty: qty.toNumber(),
      notional: notional.toNumber(),
      exitTime: exitCandle ? new Date(exitCandle.openTime + stepMs / 2) : null,
      exitPrice,
      target,
      // FIX-2026-07-30: ใช้ field names ตรงกับ summarize() — exitReason + realizedPnl
      exitReason: exitPrice != null ? 'tp_hit' : 'still_holding',
      realizedPnl: pnl,
      pnlPct: pnl != null ? (pnl / cfg.capitalPerTrade) * 100 : null,
      capitalUsed: cfg.capitalPerTrade,
    };
    allTrades.push(trade);
    perBotTrades[sig.botId].push(trade);

    // Track active capital usage
    activeExits.push({ botId: sig.botId, exitIdx, capitalUsed: cfg.capitalPerTrade });
    const newUsed = activeExits.reduce((s, e) => s + e.capitalUsed, 0);
    if (newUsed > peakCapitalUsed.toNumber()) peakCapitalUsed = new Decimal(newUsed);
  }

  // 4) Per-bot stats + combined stats
  const perBot = botInputs.map((bi) => {
    const trades = perBotTrades[bi.botId].filter((t) => t.exitReason === 'tp_hit' || t.exitReason === 'still_holding');
    const skipped = perBotTrades[bi.botId].filter((t) => t.exitReason === 'max_concurrent_skip' || t.exitReason === 'capital_exhausted_skip').length;
    const stats = summarize(trades);
    return {
      botId: bi.botId,
      symbol: bi.cfg.symbol,
      timeframe: bi.cfg.timeframe,
      tpPercent: bi.cfg.tpPercent,
      kcMult: bi.cfg.kcMult,
      capitalPerTrade: bi.cfg.capitalPerTrade,
      maxConcurrentTrades: bi.cfg.maxConcurrentTrades,
      candlesFetched: bi.candlesFetched,
      truncated: bi.truncated,
      signalsCount: bi.signals.length,
      tradesCount: trades.length,
      skippedCount: skipped,
      stats,
    };
  });

  const closedTrades = allTrades.filter((t) => t.exitReason === 'tp_hit' || t.exitReason === 'still_holding');
  const combinedStats = summarize(closedTrades);

  // Store result
  const storedTrades = closedTrades.length > 500 ? closedTrades.slice(0, 250).concat(closedTrades.slice(-250)) : closedTrades;

  let savedId = null;
  try {
    const doc = await BacktestResult.create({
      symbol: bots.map((b) => b.symbol).join('+'),
      timeframe: 'multi',
      from: new Date(fromMs),
      to: new Date(toMs),
      executionModel: 'v4_maker_fill_multi',
      params: {
        totalCapital,
        bots: bots.map((b) => ({
          symbol: b.symbol, timeframe: b.timeframe, tpPercent: b.tpPercent,
          capitalPerTrade: b.capitalPerTrade, maxConcurrentTrades: b.maxConcurrentTrades,
        })),
        model: 'realistic_v3_multi',
      },
      signalsCount: merged.length,
      tradesSimulated: closedTrades.length,
      ...combinedStats,
      trades: storedTrades,
    });
    savedId = doc._id.toString();
  } catch (e) {
    logger.warn({ err: e.message }, 'multi backtest: failed to save result (non-fatal)');
  }

  return {
    id: savedId,
    executionModel: 'v4_maker_fill_multi',
    totalCapital,
    from: new Date(fromMs),
    to: new Date(toMs),
    perBot,
    combined: {
      tradesCount: closedTrades.length,
      skippedCapitalCount: capitalExhaustedSkips,
      peakCapitalUsed: peakCapitalUsed.toNumber(),
      peakConcurrentTrades,
      stats: combinedStats,
      trades: storedTrades,
    },
  };
}