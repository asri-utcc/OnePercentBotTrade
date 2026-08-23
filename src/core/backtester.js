'use strict';

const Decimal = require('decimal.js');
const binanceRest = require('../binance/binanceRest');
const symbolInfo = require('../binance/symbolInfo');
const fees = require('../binance/fees');
const signalEngine = require('./signalEngine');
const BacktestResult = require('../db/models/BacktestResult');
const logger = require('../utils/logger');
const volatilityScanner = require('./volatilityScanner'); // FIX-2026-08-03: TREND_TF_MAP for safe-trade #2 trendline

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

// FIX-2026-08-03: Safe-trade #2 (trendline) backtest support — pre-compute upper-TF trendline
//   - ดึง upper-TF klines ครอบคลุม from/to range, คำนวณ trendline per upper-TF bar
//   - return null ถ้า TREND_TF_MAP ไม่มี entry, fetch fail, หรือข้อมูลไม่พอ (fail-open)
//   - trendTF = volatilityScanner.TREND_TF_MAP[timeframe] (เช่น 3m/5m→1h, 15m→4h)
//   - ใช้ computeTrendlinePivotLows() ตัวเดียวกับ live trader (single source of truth)
async function _computeBacktestTrendline({ symbol, timeframe, fromMs, toMs, fetchFn }) {
  const trendTF = volatilityScanner.TREND_TF_MAP[timeframe];
  if (!trendTF) return null;
  try {
    const result = await fetchFn({ symbol, interval: trendTF, fromMs, toMs });
    const upperRaw = result.klines || result; // tolerate {klines, truncated} or array
    if (!Array.isArray(upperRaw) || upperRaw.length < 50) return null;
    const upperKlines = upperRaw.map((k) => ({
      openTime: k.openTime,
      open: parseFloat(k.open),
      high: parseFloat(k.high),
      low: parseFloat(k.low),
      close: parseFloat(k.close),
    }));
    const upperTrendline = signalEngine.computeTrendlinePivotLows(upperKlines);
    if (!upperTrendline) return null;
    return { trendTF, upperKlines, upperTrendline };
  } catch (err) {
    logger.warn({ symbol, timeframe, trendTF, err: err.message }, 'backtest: trendline fetch failed — fail-open');
    return null;
  }
}

// FIX-2026-08-03: per-signal trendline lookup via binary search
//   - หา rightmost upperKlines[j].openTime <= mainBarOpenTime → return upperTrendline[j]
//   - return null ถ้า mainBarOpenTime < upperKlines[0].openTime (warmup)
function _trendlineAt(mainBarOpenTime, upperKlines, upperTrendline) {
  let lo = 0, hi = upperKlines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (upperKlines[mid].openTime <= mainBarOpenTime) { ans = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  if (ans < 0) return null;
  return upperTrendline[ans];
}

// FIX-2026-08-05: Safe-trade filter #3 — pre-compute per-bar nt/nt1/none for backtest range
//   - Mirror _computeBacktestTrendline but uses computeNoTradePerBar
//   - kcMult passed from bot.kcMult (per-bot, FIX: consistent กับ S1 + live behavior)
//   - Returns null when no trendTF / fetch failed / insufficient data → backtest fails-OPEN
async function _computeBacktestNoTrade({ symbol, timeframe, kcMult, fromMs, toMs, fetchFn }) {
  const trendTF = volatilityScanner.TREND_TF_MAP[timeframe];
  if (!trendTF) return null;
  try {
    const result = await fetchFn({ symbol, interval: trendTF, fromMs, toMs });
    const upperRaw = result.klines || result;
    if (!Array.isArray(upperRaw) || upperRaw.length < 21) return null;
    const upperKlines = upperRaw.map((k) => ({
      openTime: k.openTime,
      open: parseFloat(k.open),
      high: parseFloat(k.high),
      low: parseFloat(k.low),
      close: parseFloat(k.close),
    }));
    const perBar = signalEngine.computeNoTradePerBar(upperKlines, { mult: kcMult });
    return { trendTF, upperKlines, perBar };
  } catch (err) {
    logger.warn({ symbol, timeframe, trendTF, err: err.message }, 'backtest: no-trade fetch failed — fail-open');
    return null;
  }
}

// FIX-2026-08-05: lookup per-bar no-trade kind for a given main bar openTime (binary search)
function _noTradeAt(mainBarOpenTime, upperKlines, perBar) {
  let lo = 0, hi = upperKlines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (upperKlines[mid].openTime <= mainBarOpenTime) { ans = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  if (ans < 0) return 'none';
  const entry = perBar[ans];
  return (entry && entry.kind) || 'none';
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
 * FIX-2026-08-02: DCA stack BEP — totalSpent / totalQty (weighted average across layers).
 * Used by both runDcaBacktest and runMultiBacktest DCA pass.
 */
function computeBEP(layers) {
  let totalSpent = new Decimal(0);
  let totalQty = new Decimal(0);
  for (const ly of layers) {
    totalSpent = totalSpent.plus(new Decimal(ly.price).mul(new Decimal(ly.qty)));
    totalQty = totalQty.plus(new Decimal(ly.qty));
  }
  if (totalQty.isZero()) return { totalQty: 0, totalSpent: 0, bep: 0 };
  return {
    totalQty: totalQty.toNumber(),
    totalSpent: totalSpent.toNumber(),
    bep: totalSpent.div(totalQty).toNumber(),
  };
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
    // FIX-2026-08-03: SL-UKC + F1 + profit toggle (Option B parity)
    stopLossOnUpperKC = false,
    autoArmStopLossOnUKC = false,
    slUkcTriggerOnProfit = false,
    // FIX-2026-08-03: Safe-trade filter #2 (trendline) — pre-computed upper-TF trendline data
    //   - if null/undefined: filter disabled (skip the check)
    //   - if {trendTF, upperKlines, upperTrendline}: filter enabled, check per-signal
    trendlineData = null,
    // FIX-2026-08-05: Safe-trade filter #3 (no-trade engulfing/SS) — pre-computed per-bar
    noTradeData = null,
  } = opts;

  // FIX-2026-08-03: build cfg object ที่ inner scope ใช้อ่าน (mirror DCA closeOpenStack pattern)
  const cfg = {
    stopLossOnUpperKC: stopLossOnUpperKC === true,
    autoArmStopLossOnUKC: autoArmStopLossOnUKC === true,
    slUkcTriggerOnProfit: slUkcTriggerOnProfit === true,
  };

  // FIX-2026-08-03: trendline filter enabled flag (truthy if data provided)
  const trendlineEnabled = trendlineData != null
    && Array.isArray(trendlineData.upperKlines)
    && Array.isArray(trendlineData.upperTrendline);

  // FIX-2026-08-05: no-trade filter enabled flag (truthy if per-bar data provided)
  const noTradeEnabled = noTradeData != null
    && Array.isArray(noTradeData.upperKlines)
    && Array.isArray(noTradeData.perBar);

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

    // ─── FIX-2026-08-03: Safe-trade #2 (trendline) filter ───────────────
    //   - check LuxAlgo red pivot-low trendline (pre-computed from upper-TF)
    //   - ถ้า buyPrice <= trendline value at signal time → skip (record as safe_trade_trendline_block)
    //   - FAIL-OPEN semantics: ถ้า trendline ไม่พร้อม (warmup, null) → ผ่าน (ไม่ block)
    //   - ทำก่อน concurrent slot check เพื่อไม่ให้ filter consume slot
    if (trendlineEnabled) {
      const tlValue = _trendlineAt(sig.openTime, trendlineData.upperKlines, trendlineData.upperTrendline);
      if (tlValue != null && Number.isFinite(tlValue) && buyPrice <= tlValue) {
        const gapPct = ((buyPrice - tlValue) / tlValue) * 100;
        trades.push({
          signalTime: new Date(sig.openTime),
          candleCloseTime: new Date(sig.closeTime),
          buyPrice,
          targetSellPrice: target,
          sellPrice: null,
          buyFilled: false,
          sellFilled: false,
          qty: 0,
          notional: 0,
          grossPnl: 0,
          fees: 0,
          realizedPnl: 0,
          pnlPercent: 0,
          exitReason: 'safe_trade_trendline_block',
          bgState: sig.bgState,
          // custom audit fields (kept on tradeSim via extra fields)
          trendlineValue: Number(tlValue.toFixed(8)),
          gapPct: Number(gapPct.toFixed(3)),
        });
        continue; // skip this signal — do NOT consume concurrent slot
      }
    }

    // ─── FIX-2026-08-05: Safe-trade #3 (no-trade engulfing/SS) filter ───────────────
    //   - check Pine "No-Trade Signal Engine" per-bar (pre-computed from upper-TF)
    //   - �้า upper-TF bar matching sig.openTime มี lastKind === 'nt' | 'nt1' → skip
    //   - FAIL-OPEN semantics: ถ้า noTrade ไม่พร้อม (warmup, null) → ผ่าน (ไม่ block)
    //   - ทำก่อน concurrent slot check เพื่อไม่ให้ filter consume slot
    if (noTradeEnabled) {
      const lastKind = _noTradeAt(sig.openTime, noTradeData.upperKlines, noTradeData.perBar);
      if (lastKind === 'nt' || lastKind === 'nt1') {
        trades.push({
          signalTime: new Date(sig.openTime),
          candleCloseTime: new Date(sig.closeTime),
          buyPrice,
          targetSellPrice: target,
          sellPrice: null,
          buyFilled: false,
          sellFilled: false,
          qty: 0,
          notional: 0,
          grossPnl: 0,
          fees: 0,
          realizedPnl: 0,
          pnlPercent: 0,
          exitReason: 'safe_trade_no_trade_block',
          bgState: sig.bgState,
          lastKind,
          trendTF: noTradeData.trendTF,
        });
        continue; // skip this signal — do NOT consume concurrent slot
      }
    }

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
  // FIX-2026-07-31: นับ exit ใหม่ — cb_panic + stop_loss_upper_kc (per-bot toggle)
  const cbPanic = trades.filter((t) => t.exitReason === 'cb_panic').length;
  // FIX-2026-08-06: CBv2 sustained panic-sell (sustained 3-candle breach lock)
  const cbv2Panic = trades.filter((t) => t.exitReason === 'cbv2_panic').length;
  const stopLossUpperKc = trades.filter((t) => t.exitReason === 'stop_loss_upper_kc').length;
  // buyFilled = ทุก exit ที่เป็นการเปิดไม้จริง (รวม panic + SL exit)
  const buyFilled = tpHit + stillHolding + cbPanic + cbv2Panic + stopLossUpperKc;
  // sellFilled = ทุก exit ที่ปิดไม้จริง (ยังไม่ปิด = stillHolding)
  const sellFilled = tpHit + cbPanic + cbv2Panic + stopLossUpperKc;

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
  // FIX-2026-07-31: exit-by-reason breakdown (ใหม่ — UI ดูได้)
  const exitClosedCount = sellFilled; // alias เพื่อความชัดเจน
  const exitTpPct = signals > 0 ? (tpHit / signals) * 100 : 0;
  const exitCbPct = signals > 0 ? (cbPanic / signals) * 100 : 0;
  const exitCbv2Pct = signals > 0 ? (cbv2Panic / signals) * 100 : 0; // FIX-2026-08-06
  const exitStopLossPct = signals > 0 ? (stopLossUpperKc / signals) * 100 : 0;

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
    cbPanicCount: cbPanic,                  // FIX-2026-07-31: new exit reason
    cbv2PanicCount: cbv2Panic,                  // FIX-2026-08-06: CBv2 sustained panic-sell
    stopLossUpperKcCount: stopLossUpperKc,      // FIX-2026-07-31: new exit reason
    exitTpPct,                                  // % exit by TP
    exitCbPct,                                // % exit by CB panic
    exitCbv2Pct,                                // % exit by CBv2 panic  // FIX-2026-08-06
    exitStopLossPct,                            // % exit by upper-KC stop-loss
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
    // FIX-2026-08-03: SL-UKC + F1 + profit toggle (Option B parity with live trader)
    stopLossOnUpperKC = false,
    autoArmStopLossOnUKC = false,
    slUkcTriggerOnProfit = false,
    // FIX-2026-08-03: Safe-trade filter #2 (trendline) — opt-in per-bar filter
    safeTradeTrendlineEnabled = false,
    // FIX-2026-08-05: Safe-trade filter #3 (no-trade engulfing/SS) — opt-in per-bar filter
    safeTradeNoTradeEnabled = false,
    kcMult = 1.5,
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

  // FIX-2026-08-03: pre-compute trendline if filter enabled (single fetch for full range)
  let trendlineData = null;
  if (safeTradeTrendlineEnabled === true) {
    trendlineData = await _computeBacktestTrendline({
      symbol, timeframe, fromMs, toMs, fetchFn: fetchKlines,
    });
    if (trendlineData) {
      logger.info({
        symbol, trendTF: trendlineData.trendTF,
        upperBars: trendlineData.upperKlines.length,
      }, 'backtest: trendline pre-computed');
    } else {
      logger.warn({ symbol, timeframe }, 'backtest: trendline pre-compute failed — fail-open');
    }
  }

  // FIX-2026-08-05: pre-compute no-trade (engulfing/SS) per-bar if filter enabled
  let noTradeData = null;
  if (safeTradeNoTradeEnabled === true) {
    noTradeData = await _computeBacktestNoTrade({
      symbol, timeframe, kcMult, fromMs, toMs, fetchFn: fetchKlines,
    });
    if (noTradeData) {
      logger.info({
        symbol, trendTF: noTradeData.trendTF,
        upperBars: noTradeData.upperKlines.length,
      }, 'backtest: no-trade pre-computed');
    } else {
      logger.warn({ symbol, timeframe }, 'backtest: no-trade pre-compute failed — fail-open');
    }
  }

  logger.info({
    symbol, timeframe, klines: klines.length, signals: signals.length,
    stepSize: stepSizeStr, minNotional: minNotional.toString(),
    truncated,
    safeTradeTrendlineEnabled: !!safeTradeTrendlineEnabled,
    safeTradeNoTradeEnabled: !!safeTradeNoTradeEnabled,
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
      // FIX-2026-08-03: SL-UKC + F1 + profit toggle (Option B parity with live trader)
      stopLossOnUpperKC,
      autoArmStopLossOnUKC,
      slUkcTriggerOnProfit,
      // FIX-2026-08-03: Safe-trade filter #2 (trendline) — pre-computed upper-TF data
      trendlineData,
      // FIX-2026-08-05: Safe-trade filter #3 (no-trade engulfing/SS) — pre-computed upper-TF per-bar
      noTradeData,
    },
  });

  const stats = summarize(trades);
  // เพิ่ม peak concurrency เข้า stats (track ไว้ระหว่าง simulate)
  stats.maxConcurrentTradesUsed = maxConcurrentTradesUsed;
  // FIX-2026-08-03: count Safe-trade trendline blocked signals (separate from noBuyFillCount)
  stats.safeTradeTrendlineBlocked = trades.filter((t) => t.exitReason === 'safe_trade_trendline_block').length;
  // FIX-2026-08-05: count Safe-trade no-trade blocked signals
  stats.safeTradeNoTradeBlocked = trades.filter((t) => t.exitReason === 'safe_trade_no_trade_block').length;

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

/**
 * FIX-2026-08-02: DCA + BEP stack backtest simulator
 *
 * Single-stack mode: 1 bot = 1 open DCA stack at a time.
 * Each S1 signal either:
 *   - opens a new stack (layer 1)
 *   - adds a layer to the existing stack (until dcaMaxLayers)
 *   - is skipped (max layers reached)
 *
 * On every layer fill: recompute BEP (totalSpent/totalQty) + replace aggregate SELL at stackBep+TP.
 *
 * Exit priority (NO CB in DCA mode):
 *   1. SL-UKC on stack BEP (loss only, per-bot toggle + autoArmStopLossOnUKC)
 *   2. TP hit on aggregate SELL
 *
 * Stats: count stacks (not layers) for trade count + win/loss.
 *
 * stillHoldingPositions[] returns DCA stacks still open at end of range, with:
 *   { stackId, layerCount, totalQty, totalSpent, stackBep, targetSellPrice,
 *     unrealizedPnl, unrealizedPnlPercent, candlesHeld }
 */
async function runDcaBacktest(params) {
  const {
    symbol,
    timeframe,
    from,
    to,
    tpPercent = 0.1,
    capitalPerTrade = 10,
    dcaMaxLayers = 3,
    useBnbForFees = false,
    maxBuyWait = 6,
    kcMult = 1.5,
    xs1Enabled = true,
    stopLossOnUpperKC = false,
    autoArmStopLossOnUKC = false,
    // FIX-2026-08-03: F1 thresholds + SL-UKC profit toggle (Option B parity)
    autoArmLossPct = 10,
    autoArmAgeHours = 4,
    slUkcTriggerOnProfit = false,
    // FIX-2026-08-03: DCA + Martingale sizing (opt-in, default off — parity with trader.js)
    //   - martingaleEnabled=false (default) → ทุก layer ใช้ capitalPerTrade เท่ากัน (พฤติกรรมเดิม)
    //   - martingaleEnabled=true → layer N notional = capitalPerTrade × mult^(N-1) (capped by maxLayerNotional)
    martingaleEnabled = false,
    martingaleMultiplier = 1.5,
    martingaleMaxLayerNotional = 100,
    // FIX-2026-08-03: Safe-trade filter #2 (trendline) — opt-in per-bar filter
    //   - ไม่แนะนำสำหรับ DCA mode (DCA �ื้อ dip — filter นี้ block dip-buy)
    safeTradeTrendlineEnabled = false,
    // FIX-2026-08-05: Safe-trade filter #3 (no-trade engulfing/SS) — opt-in per-bar filter
    safeTradeNoTradeEnabled = false,
  } = params;

  if (!symbol || !timeframe || !from || !to) {
    throw new Error('symbol, timeframe, from, to required');
  }
  if (!Number.isInteger(dcaMaxLayers) || dcaMaxLayers < 1 || dcaMaxLayers > 100) {
    throw new Error('dcaMaxLayers must be integer 1-100');
  }
  // FIX-2026-08-03: Martingale input validation
  if (martingaleEnabled && (!Number.isFinite(martingaleMultiplier) || martingaleMultiplier < 1.0 || martingaleMultiplier > 3.0)) {
    throw new Error('martingaleMultiplier must be 1.0..3.0');
  }
  if (!Number.isFinite(martingaleMaxLayerNotional) || martingaleMaxLayerNotional < 1) {
    throw new Error('martingaleMaxLayerNotional must be >= 1');
  }

  // FIX-2026-08-03: DCA + Martingale per-layer notional helper (parity with trader._computeDcaLayerNotional)
  //   - layerIndex is 1-based (1 for first layer, 2 for second, ...)
  //   - When martingaleEnabled=false → return capitalPerTrade (unchanged, backward compat)
  const computeLayerNotional = (layerIndex) => {
    if (!martingaleEnabled) return parseFloat(capitalPerTrade) || 0;
    const idx = Math.max(1, parseInt(layerIndex, 10) || 1);
    const mult = parseFloat(martingaleMultiplier) || 1.5;
    const raw = (parseFloat(capitalPerTrade) || 0) * Math.pow(mult, idx - 1);
    return Math.min(raw, parseFloat(martingaleMaxLayerNotional) || 100);
  };

  const fromMs = typeof from === 'string' ? new Date(from).getTime() : from;
  const toMs = typeof to === 'string' ? new Date(to).getTime() : to;

  logger.info({
    symbol, timeframe, fromMs, toMs, tpPercent, capitalPerTrade, dcaMaxLayers,
  }, 'dca-backtest: fetching klines');

  const { klines, truncated } = await fetchKlines({
    symbol,
    interval: timeframe,
    fromMs,
    toMs,
  });

  if (truncated) {
    logger.warn({
      symbol, timeframe,
      requestedDays: Math.round((toMs - fromMs) / 86400000),
      actualCandles: klines.length,
      actualDays: klines.length > 1
        ? Math.round((klines[klines.length - 1].openTime - klines[0].openTime) / 86400000)
        : 0,
    }, 'dca-backtest: klines truncated by SAFETY_LIMIT');
  }

  if (klines.length < 50) {
    throw new Error(`Not enough klines: got ${klines.length}, need >= 50`);
  }

  // Symbol info for stepSize + minNotional
  let stepSizeStr = null;
  let minNotional = new Decimal('10');
  try {
    const info = await symbolInfo.loadSymbol(symbol);
    if (info.lotSize) stepSizeStr = info.lotSize.stepSize.toString();
    if (info.notional && info.notional.minNotional) {
      minNotional = info.notional.minNotional instanceof Decimal
        ? info.notional.minNotional
        : new Decimal(info.notional.minNotional.toString());
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'dca-backtest: symbol info load failed (using defaults)');
  }

  // Signals + KC arrays for SL-UKC
  const signalOpts = {
    mult: parseFloat(kcMult),
    xs1Enabled: xs1Enabled !== false,
    cbEnabled: false, // DCA mode disables CB (per design — no panic-sell)
  };
  const sigResult = signalEngine.detectS1Signals(klines, signalOpts);
  const { signals, upper: upperKC, lower: lowerKC } = sigResult;
  // Note: lowerKC unused in DCA mode (CB disabled). Kept here for parity / future use.

  // FIX-2026-08-03: pre-compute trendline if filter enabled (DCA single-stack mode)
  let trendlineData = null;
  if (safeTradeTrendlineEnabled === true) {
    trendlineData = await _computeBacktestTrendline({
      symbol, timeframe, fromMs, toMs, fetchFn: fetchKlines,
    });
    if (trendlineData) {
      logger.info({
        symbol, trendTF: trendlineData.trendTF,
        upperBars: trendlineData.upperKlines.length,
      }, 'dca-backtest: trendline pre-computed');
    } else {
      logger.warn({ symbol, timeframe }, 'dca-backtest: trendline pre-compute failed — fail-open');
    }
  }
  const trendlineEnabled = trendlineData != null && Array.isArray(trendlineData.upperKlines);

  // FIX-2026-08-05: pre-compute no-trade per-bar (engulfing/SS) for DCA backtest
  let noTradeData = null;
  if (safeTradeNoTradeEnabled === true) {
    noTradeData = await _computeBacktestNoTrade({
      symbol, timeframe, kcMult, fromMs, toMs, fetchFn: fetchKlines,
    });
    if (noTradeData) {
      logger.info({
        symbol, trendTF: noTradeData.trendTF,
        upperBars: noTradeData.upperKlines.length,
      }, 'dca-backtest: no-trade pre-computed');
    } else {
      logger.warn({ symbol, timeframe }, 'dca-backtest: no-trade pre-compute failed — fail-open');
    }
  }
  const noTradeEnabled = noTradeData != null
    && Array.isArray(noTradeData.upperKlines)
    && Array.isArray(noTradeData.perBar);

  logger.info({
    symbol, timeframe, klines: klines.length, signals: signals.length,
    dcaMaxLayers, stepSize: stepSizeStr, minNotional: minNotional.toString(),
    safeTradeTrendlineEnabled: !!safeTradeTrendlineEnabled,
    safeTradeNoTradeEnabled: !!safeTradeNoTradeEnabled,
  }, 'dca-backtest: signals detected');

  const feeRate = fees.getMakerRate({ useBnbForFees });
  const stepMs = klines.length >= 2 ? (klines[1].openTime - klines[0].openTime) : 0;

  // FIX-2026-08-03: trendline blocked counter (separate stat for DCA)
  let safeTradeTrendlineBlocked = 0;
  // FIX-2026-08-05: no-trade blocked counter — ST#3 is disabled for DCA bots
  //   (mirror UI warning "not recommended for DCA") → counter stays 0 for DCA path
  let safeTradeNoTradeBlocked = 0;

  // ─── Simulate DCA stack flow per signal ────────────────────────
  // Active stack: at most 1 stack per bot at any time.
  // Each signal either opens a new stack or adds a layer (until maxLayers).
  const trades = []; // one entry per SIGNAL (records add attempts + max-hit skips)
  const stacks = []; // one entry per CLOSED stack (the primary "trade" unit for stats)
  let openStack = null; // { stackId, layers: [{price, qty, filledAtMs}], layerCount, totalQty, totalSpent, stackBep, targetSellPrice, sellFilled, sellFilledAtMs, exitReason, exitPrice }
  let stackCounter = 0;

  // helper: compute TP target from stackBep (same fee buffer as non-DCA path)
  const computeDcaTpTarget = (stackBep) => {
    return new Decimal(stackBep).mul(1 + tpPercent / 100 + 2 * feeRate).toNumber();
  };

  for (const sig of signals) {
    const idx = sig.index;
    const buyPrice = sig.close;

    // ─── FIX-2026-08-03: Safe-trade #2 (trendline) filter ───────────────
    //   - DCA mode: filter blocks layer-add when price < LuxAlgo trendline
    //   - ⚠️ ไม่แนะนำเปิดกับ DCA (DCA intent = buy dips; filter = block dip-buys)
    //   - FAIL-OPEN: trendline ไม่พร้อม → ผ่าน
    if (trendlineEnabled) {
      const tlValue = _trendlineAt(sig.openTime, trendlineData.upperKlines, trendlineData.upperTrendline);
      if (tlValue != null && Number.isFinite(tlValue) && buyPrice <= tlValue) {
        const gapPct = ((buyPrice - tlValue) / tlValue) * 100;
        trades.push({
          signalTime: new Date(sig.openTime),
          candleCloseTime: new Date(sig.closeTime),
          buyPrice,
          layerIndex: openStack ? (openStack.layerCount + 1) : 1,
          layerCountAfter: 0,
          buyFilled: false,
          sellFilled: false,
          qty: 0,
          notional: 0,
          exitReason: 'safe_trade_trendline_block',
          bgState: sig.bgState,
          trendlineValue: Number(tlValue.toFixed(8)),
          gapPct: Number(gapPct.toFixed(3)),
        });
        safeTradeTrendlineBlocked += 1;
        continue; // skip this layer-add
      }
    }

    // ─── FIX-2026-08-05: Safe-trade #3 (no-trade engulfing/SS) filter ───────────────
    //   - DCA mode: filter blocks layer-add when upper-TF lastKind === 'nt' | 'nt1'
    //   - ⚠️ ไม่แนะนำเปิดกับ DCA (filter นี้ block dip-buy → ขัดกับ DCA intent)
    //   - FAIL-OPEN: noTrade ไม่พร้อม → ผ่าน
    //   - AUDIT-FIX-2026-08-05: ST#3 disabled for DCA bots (mirror live trader.js bypass)
    //     - bot.dcaEnabled จริงหลัง merge จาก cfg.dcaEnabled ?? false
    //   - ถ้า DCA bypass: counter ยัง track ตามปกติ (เพื่อ visibility) — counter จะเป็น 0 ในทางปฏิบัติ
    if (noTradeEnabled && !dcaEnabled) {
      const lastKind = _noTradeAt(sig.openTime, noTradeData.upperKlines, noTradeData.perBar);
      if (lastKind === 'nt' || lastKind === 'nt1') {
        trades.push({
          signalTime: new Date(sig.openTime),
          candleCloseTime: new Date(sig.closeTime),
          buyPrice,
          layerIndex: openStack ? (openStack.layerCount + 1) : 1,
          layerCountAfter: 0,
          buyFilled: false,
          sellFilled: false,
          qty: 0,
          notional: 0,
          exitReason: 'safe_trade_no_trade_block',
          bgState: sig.bgState,
          lastKind,
          trendTF: noTradeData.trendTF,
        });
        safeTradeNoTradeBlocked += 1; // FIX-2026-08-05: parity with ST#2 trendline counter
        continue; // skip this layer-add
      }
    }

    // ─── Layer 1: open new stack ───────────────────────
    if (!openStack) {
      const buyCandleResult = await tryFillBuy({
        klines, sigIdx: idx, buyPrice, maxBuyWait, stepMs,
      });
      if (!buyCandleResult.filled) {
        trades.push({
          signalTime: new Date(sig.openTime),
          candleCloseTime: new Date(sig.closeTime),
          buyPrice,
          layerIndex: 1,
          layerCountAfter: 0,
          buyFilled: false,
          sellFilled: false,
          qty: 0,
          notional: 0,
          exitReason: 'no_buy_fill',
          bgState: sig.bgState,
        });
        continue;
      }
      const qty = computeLayerQty(buyPrice, computeLayerNotional(1), stepSizeStr);
      const notional = new Decimal(buyPrice).mul(new Decimal(qty));
      if (notional.lessThan(minNotional)) {
        trades.push({
          signalTime: new Date(sig.openTime),
          candleCloseTime: new Date(sig.closeTime),
          buyPrice,
          layerIndex: 1,
          layerCountAfter: 0,
          buyFilled: false,
          sellFilled: false,
          qty: qty.toNumber(),
          notional: notional.toNumber(),
          exitReason: 'below_min_notional',
          bgState: sig.bgState,
        });
        continue;
      }
      const stackId = `dca_${++stackCounter}`;
      const layer = { price: buyPrice, qty: qty.toNumber(), filledAtMs: buyCandleResult.filledAtMs };
      const layers = [layer];
      const { bep } = computeBEP(layers);
      const targetSellPrice = computeDcaTpTarget(bep);
      openStack = {
        stackId,
        botId: 'dca',
        symbol,
        timeframe,
        openedAtMs: sig.openTime,
        signalCloseTimeMs: sig.closeTime,
        layers,
        layerCount: 1,
        totalQty: qty.toNumber(),
        totalSpent: notional.toNumber(),
        stackBep: bep,
        targetSellPrice,
        // exit fields
        sellFilled: false,
        sellFilledAtMs: null,
        exitReason: null,
        exitPrice: null,
        sellCandleIdx: null,
        candlesHeld: 0,
      };
      trades.push({
        signalTime: new Date(sig.openTime),
        candleCloseTime: new Date(sig.closeTime),
        buyPrice,
        layerIndex: 1,
        layerCountAfter: 1,
        buyFilled: true,
        sellFilled: false,
        qty: qty.toNumber(),
        notional: notional.toNumber(),
        exitReason: 'layer_added',
        stackId,
        bgState: sig.bgState,
      });
      continue;
    }

    // ─── Layer 2+: try add to existing stack ────────────
    if (openStack.layerCount >= dcaMaxLayers) {
      // max layers reached → skip
      trades.push({
        signalTime: new Date(sig.openTime),
        candleCloseTime: new Date(sig.closeTime),
        buyPrice,
        layerIndex: openStack.layerCount + 1,
        layerCountAfter: openStack.layerCount,
        buyFilled: false,
        sellFilled: false,
        qty: 0,
        notional: 0,
        exitReason: 'dca_max_layers_hit',
        stackId: openStack.stackId,
        bgState: sig.bgState,
      });
      continue;
    }

    // Try to fill new layer BUY at sig.close
    const buyCandleResult = await tryFillBuy({
      klines, sigIdx: idx, buyPrice, maxBuyWait, stepMs,
    });
    if (!buyCandleResult.filled) {
      trades.push({
        signalTime: new Date(sig.openTime),
        candleCloseTime: new Date(sig.closeTime),
        buyPrice,
        layerIndex: openStack.layerCount + 1,
        layerCountAfter: openStack.layerCount,
        buyFilled: false,
        sellFilled: false,
        qty: 0,
        notional: 0,
        exitReason: 'no_buy_fill',
        stackId: openStack.stackId,
        bgState: sig.bgState,
      });
      continue;
    }
    const layerIndex = openStack.layerCount + 1;
    const qty = computeLayerQty(buyPrice, computeLayerNotional(layerIndex), stepSizeStr);
    const notional = new Decimal(buyPrice).mul(new Decimal(qty));
    if (notional.lessThan(minNotional)) {
      trades.push({
        signalTime: new Date(sig.openTime),
        candleCloseTime: new Date(sig.closeTime),
        buyPrice,
        layerIndex,
        layerCountAfter: openStack.layerCount,
        buyFilled: false,
        sellFilled: false,
        qty: qty.toNumber(),
        notional: notional.toNumber(),
        exitReason: 'below_min_notional',
        stackId: openStack.stackId,
        bgState: sig.bgState,
      });
      continue;
    }

    // Append layer + recompute BEP + new aggregate target
    openStack.layers.push({ price: buyPrice, qty: qty.toNumber(), filledAtMs: buyCandleResult.filledAtMs });
    openStack.layerCount += 1;
    const { totalQty, totalSpent, bep } = computeBEP(openStack.layers);
    openStack.totalQty = totalQty;
    openStack.totalSpent = totalSpent;
    openStack.stackBep = bep;
    openStack.targetSellPrice = computeDcaTpTarget(bep);

    trades.push({
      signalTime: new Date(sig.openTime),
      candleCloseTime: new Date(sig.closeTime),
      buyPrice,
      layerIndex: openStack.layerCount,
      layerCountAfter: openStack.layerCount,
      buyFilled: true,
      sellFilled: false,
      qty: qty.toNumber(),
      notional: notional.toNumber(),
      exitReason: 'layer_added',
      stackId: openStack.stackId,
      bgState: sig.bgState,
    });
  }

  // ─── After all signals: walk candles for exit (SL-UKC or TP) for open stack ──
  // Find each stack's first-layer BUY candle idx (approx by buyPrice match in stack.layers[0])
  // For simplicity, scan from each layer's filledAtMs onward.
  if (openStack) {
    closeOpenStack({
      openStack, klines, stepMs, feeRate,
      stopLossOnUpperKC, autoArmStopLossOnUKC,
      upperKC,
    });
    stacks.push(openStack);
    openStack = null;
  }

  // ─── Build stack-level trades[] for stats ──────────────
  // Each stack that closes becomes one Trade-shaped entry.
  const stackTrades = stacks.map((s) => buildStackTradeRecord(s, feeRate));

  // Aggregate stats from stackTrades + signal-level trades for skip counts
  const stats = buildDcaStats({ stackTrades, signalTrades: trades });

  // Store result (cap to 500 stacks)
  const storedStacks = stackTrades.length > 500
    ? stackTrades.slice(0, 250).concat(stackTrades.slice(-250))
    : stackTrades;

  let savedId = null;
  try {
    const doc = await BacktestResult.create({
      symbol,
      timeframe,
      from: new Date(fromMs),
      to: new Date(toMs),
      executionModel: 'v4_maker_fill_dca',
      params: {
        tpPercent,
        capitalPerTrade,
        dcaMaxLayers,
        feeRate,
        maxBuyWait,
        stepSize: stepSizeStr,
        minNotional: minNotional.toString(),
        kcMult: parseFloat(kcMult),
        xs1Enabled: xs1Enabled !== false,
        stopLossOnUpperKC: stopLossOnUpperKC === true,
        autoArmStopLossOnUKC: autoArmStopLossOnUKC === true,
        // FIX-2026-08-03: F1 thresholds + SL-UKC profit toggle (Option B parity)
        autoArmLossPct: parseFloat(autoArmLossPct) || 10,
        autoArmAgeHours: parseFloat(autoArmAgeHours) || 4,
        slUkcTriggerOnProfit: slUkcTriggerOnProfit === true,
        // FIX-2026-08-03: persist Martingale params for reproducibility
        martingaleEnabled: martingaleEnabled === true,
        martingaleMultiplier: parseFloat(martingaleMultiplier) || 1.5,
        martingaleMaxLayerNotional: parseFloat(martingaleMaxLayerNotional) || 100,
        model: 'realistic_v3_dca_nostoploss',
      },
      signalsCount: signals.length,
      tradesSimulated: stackTrades.length,
      ...stats,
      trades: storedStacks,
    });
    savedId = doc._id.toString();
  } catch (e) {
    logger.warn({ err: e.message }, 'dca-backtest: failed to save result (non-fatal)');
  }

  logger.info({
    id: savedId,
    symbol, timeframe,
    signals: signals.length,
    stacks: stackTrades.length,
    layers: trades.filter((t) => t.exitReason === 'layer_added').length,
    dcaTargetHits: stats.dcaTargetHitCount,
    stillHolding: stats.dcaStillHoldingCount,
  }, 'dca-backtest: complete');

  // stillHoldingPositions = DCA stacks still open at end of range (mark-to-market)
  // For now: if openStack is null at end, all stacks closed → empty list
  // (openStack already pushed in closeOpenStack above when present)
  const stillHoldingPositions = [];

  return {
    id: savedId,
    executionModel: 'v4_maker_fill_dca',
    symbol,
    timeframe,
    from: new Date(fromMs),
    to: new Date(toMs),
    signalsCount: signals.length,
    stacksCount: stackTrades.length,
    stats,
    stacks: storedStacks,
    signalTrades: trades, // per-signal record (layer adds + skips)
    truncated,
    requestedDays: Math.round((toMs - fromMs) / 86400000),
    actualDays: klines.length > 1
      ? Math.round((klines[klines.length - 1].openTime - klines[0].openTime) / 86400000)
      : 0,
    candlesFetched: klines.length,
    stillHoldingPositions,
    // FIX-2026-08-03: Safe-trade trendline filter blocked count (per-bar stat for DCA mode)
    safeTradeTrendlineBlocked,
    // FIX-2026-08-05: no-trade filter blocked count (parity with ST#2 trendline)
    safeTradeNoTradeBlocked,
  };
}

// ─── DCA helpers (local) ──────────────────────────────────────

/**
 * Try to fill a LIMIT_MAKER BUY at buyPrice within maxBuyWait candles after sigIdx.
 * Returns { filled, filledAtMs, candleIdx }.
 */
async function tryFillBuy({ klines, sigIdx, buyPrice, maxBuyWait, stepMs }) {
  const buyEnd = Math.min(klines.length, sigIdx + 1 + maxBuyWait);
  for (let j = sigIdx + 1; j < buyEnd; j += 1) {
    const c = klines[j];
    if (c.low <= buyPrice && c.close >= buyPrice && c.volume > 0) {
      const filledAtMs = stepMs > 0 ? c.openTime + Math.floor(stepMs / 2) : c.closeTime;
      return { filled: true, filledAtMs, candleIdx: j };
    }
  }
  return { filled: false, filledAtMs: null, candleIdx: null };
}

function computeLayerQty(buyPrice, capitalPerTrade, stepSizeStr) {
  try {
    const rawQty = new Decimal(capitalPerTrade).div(new Decimal(buyPrice));
    return floorQtyToStep(rawQty, stepSizeStr);
  } catch (_) {
    return new Decimal(capitalPerTrade / buyPrice);
  }
}

/**
 * Walk forward from stack's first layer fill, looking for SL-UKC or TP hit.
 * Mutates openStack: sets sellFilled, sellFilledAtMs, exitReason, exitPrice, sellCandleIdx, candlesHeld.
 */
function closeOpenStack({ openStack, klines, stepMs, feeRate, stopLossOnUpperKC, autoArmStopLossOnUKC, upperKC }) {
  // Start scanning from layer 1's candle (approx by layers[0].filledAtMs → candle idx)
  // Use layers[0].filledAtMs to find the candle
  const firstLayerAtMs = openStack.layers[0].filledAtMs;
  let startCandleIdx = 0;
  for (let i = 0; i < klines.length; i += 1) {
    if (klines[i].closeTime >= firstLayerAtMs) {
      startCandleIdx = i;
      break;
    }
  }
  const armed = stopLossOnUpperKC || autoArmStopLossOnUKC;

  for (let j = startCandleIdx + 1; j < klines.length; j += 1) {
    const candle = klines[j];
    const candleClose = parseFloat(candle.close);
    const candleHigh = parseFloat(candle.high);
    // 1) SL-UKC: only when armed + close > upperKC[j] + stackBep > close (loss only)
    if (armed && upperKC && upperKC[j] != null
        && candleClose > upperKC[j] && openStack.stackBep > candleClose) {
      openStack.sellFilled = true;
      openStack.sellFilledAtMs = stepMs > 0 ? candle.openTime + Math.floor(stepMs / 2) : candle.closeTime;
      openStack.exitReason = 'dca_stack_stop_loss';
      openStack.exitPrice = candleClose;
      openStack.sellCandleIdx = j;
      openStack.candlesHeld = j - startCandleIdx;
      return;
    }
    // 2) TP hit (candle.high >= targetSellPrice)
    if (candleHigh >= openStack.targetSellPrice) {
      openStack.sellFilled = true;
      openStack.sellFilledAtMs = stepMs > 0 ? candle.openTime + Math.floor(stepMs / 2) : candle.closeTime;
      openStack.exitReason = 'dca_target_hit';
      openStack.exitPrice = openStack.targetSellPrice;
      openStack.sellCandleIdx = j;
      openStack.candlesHeld = j - startCandleIdx;
      return;
    }
  }

  // No exit found → still_holding
  openStack.sellFilled = false;
  openStack.sellFilledAtMs = null;
  openStack.exitReason = 'dca_still_holding';
  openStack.exitPrice = null;
  openStack.sellCandleIdx = null;
  openStack.candlesHeld = klines.length - 1 - startCandleIdx;
}

/**
 * Convert a closed stack to a Trade-shaped record (mirror non-DCA shape).
 */
function buildStackTradeRecord(stack, feeRate) {
  let pnl = 0, gross = 0, fees = 0, unrealizedPnl = 0;
  if (stack.exitReason === 'dca_target_hit' || stack.exitReason === 'dca_stack_stop_loss') {
    const grossD = new Decimal(stack.exitPrice).minus(new Decimal(stack.stackBep)).mul(new Decimal(stack.totalQty));
    const feeBuy = new Decimal(stack.stackBep).mul(new Decimal(stack.totalQty)).mul(feeRate);
    const feeSell = new Decimal(stack.exitPrice).mul(new Decimal(stack.totalQty)).mul(feeRate);
    gross = grossD.toNumber();
    fees = feeBuy.plus(feeSell).toNumber();
    pnl = grossD.minus(feeBuy).minus(feeSell).toNumber();
  } else if (stack.exitReason === 'dca_still_holding') {
    // mark-to-market using last close — caller passes lastClose via stack.lastClose? Not needed here.
    // (For brevity, leave unrealizedPnl=0 — UI can recompute if needed)
    unrealizedPnl = 0;
  }
  const lastLayerSignalMs = stack.signalCloseTimeMs;
  return {
    stackId: stack.stackId,
    botId: stack.botId,
    symbol: stack.symbol,
    timeframe: stack.timeframe,
    layerCount: stack.layerCount,
    layers: stack.layers,
    buyPrice: stack.stackBep, // mirror for parity
    buyQty: stack.totalQty,
    totalSpent: stack.totalSpent,
    stackBep: stack.stackBep,
    targetSellPrice: stack.targetSellPrice,
    sellPrice: stack.exitPrice,
    buyFilled: true,
    sellFilled: stack.sellFilled,
    candlesHeld: stack.candlesHeld,
    grossPnl: gross,
    fees,
    realizedPnl: pnl,
    unrealizedPnl,
    pnlPercent: stack.totalSpent > 0 ? (pnl / stack.totalSpent) * 100 : 0,
    exitReason: stack.exitReason,
    openedAt: new Date(stack.openedAtMs),
    closedAt: stack.sellFilledAtMs != null ? new Date(stack.sellFilledAtMs) : null,
    signalCloseTime: new Date(lastLayerSignalMs),
    isDcaStack: true,
  };
}

/**
 * Build aggregate stats from closed stacks + signal-level skip records.
 */
function buildDcaStats({ stackTrades, signalTrades }) {
  const stacks = stackTrades.length;
  const dcaTargetHit = stackTrades.filter((s) => s.exitReason === 'dca_target_hit').length;
  const dcaStopLoss = stackTrades.filter((s) => s.exitReason === 'dca_stack_stop_loss').length;
  const dcaStillHolding = stackTrades.filter((s) => s.exitReason === 'dca_still_holding').length;

  const wins = stackTrades.filter((s) => s.realizedPnl > 0).length;
  const losses = stackTrades.filter((s) => s.realizedPnl < 0).length;

  const totalPnl = stackTrades.reduce((s, t) => s + (t.realizedPnl || 0), 0);
  const totalFees = stackTrades.reduce((s, t) => s + (t.fees || 0), 0);
  const totalNotional = stackTrades.reduce((s, t) => s + (t.totalSpent || 0), 0);
  const totalLayers = signalTrades.filter((t) => t.exitReason === 'layer_added').length;
  const maxLayerHits = signalTrades.filter((t) => t.exitReason === 'dca_max_layers_hit').length;
  const noBuyFills = signalTrades.filter((t) => t.exitReason === 'no_buy_fill').length;
  const belowMin = signalTrades.filter((t) => t.exitReason === 'below_min_notional').length;

  return {
    signalsCount: signalTrades.length,
    stacksCount: stacks,
    layersCount: totalLayers,
    dcaTargetHitCount: dcaTargetHit,
    dcaStackStopLossCount: dcaStopLoss,
    dcaStillHoldingCount: dcaStillHolding,
    dcaMaxLayersHitCount: maxLayerHits,
    noBuyFillCount: noBuyFills,
    belowMinNotionalCount: belowMin,
    wins,
    losses,
    winRate: (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0,
    stackSuccessRate: stacks > 0 ? (dcaTargetHit / stacks) * 100 : 0,
    totalPnl,
    totalFees,
    totalNotional,
    totalPnlPercent: totalNotional > 0 ? (totalPnl / totalNotional) * 100 : 0,
    avgPnlPerStack: stacks > 0 ? totalPnl / stacks : 0,
    avgLayersPerStack: stacks > 0 ? totalLayers / stacks : 0,
  };
}

module.exports = {
  fetchKlines,
  intervalToMs,
  simulateTrades,
  summarize,
  runBacktest,
  runDcaBacktest, // FIX-2026-08-02: DCA + BEP stack backtest simulator
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
    // FIX-2026-07-30: per-bot KC multiplier — ส่ง opts.mult เข้า detectS1Signals
    //   detectS1Signals(klines, opts) returns { signals, basis, upper, lower, bg }
    // FIX-2026-07-31: cache upperKC/lowerKC arrays + opens/closes ไว้ใน botInputs
    //   ใช้ใน Phase 2 SELL scan loop สำหรับ CB pattern + upper-KC stop-loss
    const signalOpts = {
      mult: b.kcMult != null ? parseFloat(b.kcMult) : 1.5,
      xs1Enabled: b.xs1Enabled !== false, // default true
      // FIX-2026-08-02: DCA mode forces CB off (no panic-sell in DCA mode per design)
      cbEnabled: b.dcaEnabled === true ? false : (b.cbEnabled !== false), // default true (parity กับ live bot)
      // FIX-2026-08-06: CBv2 sustained panic-sell (default true, DCA mode disables per parity)
      cbv2Enabled: b.dcaEnabled === true ? false : (b.cbv2Enabled !== false),
      stopLossOnUpperKC: b.stopLossOnUpperKC === true, // FIX-2026-07-31: default false (per user choice)
    };
    const sigResult = signalEngine.detectS1Signals(klines, signalOpts);
    const { signals, upper: upperKC, lower: lowerKC, bg: bgArr } = sigResult;
    const opensArr = klines.map((k) => parseFloat(k.open));
    const closesArr = klines.map((k) => parseFloat(k.close));

    // FIX-2026-08-03: pre-compute trendline if this bot enabled the filter
    let trendlineData = null;
    if (b.safeTradeTrendlineEnabled === true) {
      trendlineData = await _computeBacktestTrendline({
        symbol: b.symbol.toUpperCase(), timeframe: b.timeframe, fromMs, toMs, fetchFn: fetchKlines,
      });
    }
    // FIX-2026-08-05: pre-compute no-trade (engulfing/SS) per-bar if this bot enabled
    let noTradeData = null;
    if (b.safeTradeNoTradeEnabled === true) {
      noTradeData = await _computeBacktestNoTrade({
        symbol: b.symbol.toUpperCase(),
        timeframe: b.timeframe,
        kcMult: signalOpts.mult,
        fromMs, toMs, fetchFn: fetchKlines,
      });
    }
    let stepSizeStr = null;
    let minNotional = new Decimal('10');
    try {
      const info = await symbolInfo.loadSymbol(b.symbol.toUpperCase());
      if (info.lotSize) stepSizeStr = info.lotSize.stepSize.toString();
      // FIX 2026-07-30: เดิมใช้ info.minNotional (undefined) → ตกไปใช้ default $10
      //   Binance จริง ๆ อาจ minNotional สูงกว่า (เช่น BTCUSDT = $50+)
      if (info.notional && info.notional.minNotional) {
        minNotional = info.notional.minNotional instanceof Decimal
          ? info.notional.minNotional
          : new Decimal(info.notional.minNotional.toString());
      }
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
        // FIX-2026-07-31: per-bot toggles ใช้ใน Phase 2 SELL scan
        xs1Enabled: signalOpts.xs1Enabled,
        cbEnabled: signalOpts.cbEnabled,
        stopLossOnUpperKC: signalOpts.stopLossOnUpperKC,
        // FIX-2026-08-02: DCA per-bot toggles
        dcaEnabled: b.dcaEnabled === true,
        dcaMaxLayers: b.dcaMaxLayers != null ? parseInt(b.dcaMaxLayers, 10) : 3,
        autoArmStopLossOnUKC: b.autoArmStopLossOnUKC === true,
        // FIX-2026-08-03: F1 thresholds + SL-UKC profit toggle (Option B parity)
        autoArmLossPct: b.autoArmLossPct != null ? parseFloat(b.autoArmLossPct) : 10,
        autoArmAgeHours: b.autoArmAgeHours != null ? parseFloat(b.autoArmAgeHours) : 4,
        slUkcTriggerOnProfit: b.slUkcTriggerOnProfit === true,
        // FIX-2026-08-03: Martingale per-bot toggles (parity with live trader._computeDcaLayerNotional)
        //   - default off (false) → ทุก DCA layer ใช้ capitalPerTrade เท่ากัน
        //   - ใช้เฉพาะเมื่อ dcaEnabled=true (validated ใน bot.routes.js + backtest.routes.js)
        martingaleEnabled: b.martingaleEnabled === true,
        martingaleMultiplier: b.martingaleMultiplier != null ? parseFloat(b.martingaleMultiplier) : 1.5,
        martingaleMaxLayerNotional: b.martingaleMaxLayerNotional != null ? parseFloat(b.martingaleMaxLayerNotional) : 100,
      },
      klines,
      signals: signals.map((s) => ({ ...s, botId })),
      // FIX-2026-07-31: เก็บ arrays เพิ่มเพื่อใช้ตรวจ CB + upper-KC ใน Phase 2
      upperKC,
      lowerKC,
      bgArr,
      opensArr,
      closesArr,
      // FIX-2026-08-03: pre-computed LuxAlgo trendline for per-bot safe-trade #2 filter
      trendlineData,
      // FIX-2026-08-05: pre-computed no-trade (engulfing/SS) per-bar for per-bot safe-trade #3
      noTradeData,
      truncated,
      candlesFetched: klines.length,
    };
  }));

  // 2) Merge signals across bots + sort by openTime asc
  // FIX-2026-07-31 (BUG): ต้องแนบ upperKC/lowerKC/opensArr/closesArr ลงใน merged signal
  //   เพราะ Phase 2 SELL scan อ่าน sig.lowerKC / sig.opensArr / sig.closesArr — ถ้าไม่แนบมา CB/SL-UKC จะไม่ทำงานเลย
  //   (ก่อนหน้านี้ใส่แค่ _cfg + _klines → sig.lowerKC เป็น undefined → check ตกไปที่ TP เท่านั้น)
  const merged = [];
  for (const bi of botInputs) {
    for (const s of bi.signals) {
      merged.push({
        ...s,
        _cfg: bi.cfg,
        _klines: bi.klines,
        _upperKC: bi.upperKC,
        _lowerKC: bi.lowerKC,
        _opensArr: bi.opensArr,
        _closesArr: bi.closesArr,
        // FIX-2026-08-03: propagate trendline data per-signal (may be null if filter off)
        _trendlineData: bi.trendlineData,
        // FIX-2026-08-05: propagate no-trade per-bar (may be null if filter off)
        _noTradeData: bi.noTradeData,
      });
    }
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
  // FIX 2026-07-30: per-bot peak concurrency tracking
  const perBotPeak = {};
  for (const bi of botInputs) perBotPeak[bi.botId] = 0;

  for (const sig of merged) {
    const cfg = sig._cfg;
    const idx = sig.index;
    const buyPrice = sig.close;

    // FIX-2026-08-02: DCA bots are simulated separately (per-bot stack).
    // The non-DCA simulator below is for per-trade (maxConcurrentTrades) flow only.
    // We collect DCA signals and process them in a dedicated pass after this loop.
    if (cfg.dcaEnabled) {
      continue;
    }

    // FIX-2026-08-03: Safe-trade #2 (trendline) filter — multi-bot per-signal check
    //   - ใช้ per-bot pre-computed trendline (sig._trendlineData)
    //   - FAIL-OPEN: trendline ไม่พร้อม → ผ่าน
    //   - ทำก่อน concurrent slot check เ�ื่อไม่ให้ filter consume slot
    if (sig._trendlineData && Array.isArray(sig._trendlineData.upperKlines)) {
      const tlValue = _trendlineAt(sig.openTime, sig._trendlineData.upperKlines, sig._trendlineData.upperTrendline);
      if (tlValue != null && Number.isFinite(tlValue) && buyPrice <= tlValue) {
        const targetForRecord = new Decimal(buyPrice).mul(1 + cfg.tpPercent / 100 + 2 * cfg.feeRate).toNumber();
        const gapPct = ((buyPrice - tlValue) / tlValue) * 100;
        perBotTrades[sig.botId].push({
          signalTime: new Date(sig.openTime),
          candleCloseTime: new Date(sig.closeTime),
          buyPrice,
          targetSellPrice: targetForRecord,
          sellPrice: null,
          buyFilled: false,
          sellFilled: false,
          qty: 0,
          notional: 0,
          grossPnl: 0,
          fees: 0,
          realizedPnl: 0,
          pnlPercent: 0,
          exitReason: 'safe_trade_trendline_block',
          bgState: sig.bgState,
          trendlineValue: Number(tlValue.toFixed(8)),
          gapPct: Number(gapPct.toFixed(3)),
        });
        continue; // skip this signal — do NOT consume slot or capital
      }
    }

    // FIX-2026-08-05: Safe-trade #3 (no-trade engulfing/SS) filter — multi-bot per-signal check
    //   - ใช้ per-bot pre-computed noTradeData (sig._noTradeData)
    //   - FAIL-OPEN: ไม่พร้อม → ผ่าน
    if (sig._noTradeData && Array.isArray(sig._noTradeData.upperKlines) && Array.isArray(sig._noTradeData.perBar)) {
      const lastKind = _noTradeAt(sig.openTime, sig._noTradeData.upperKlines, sig._noTradeData.perBar);
      if (lastKind === 'nt' || lastKind === 'nt1') {
        const targetForRecord = new Decimal(buyPrice).mul(1 + cfg.tpPercent / 100 + 2 * cfg.feeRate).toNumber();
        perBotTrades[sig.botId].push({
          signalTime: new Date(sig.openTime),
          candleCloseTime: new Date(sig.closeTime),
          buyPrice,
          targetSellPrice: targetForRecord,
          sellPrice: null,
          buyFilled: false,
          sellFilled: false,
          qty: 0,
          notional: 0,
          grossPnl: 0,
          fees: 0,
          realizedPnl: 0,
          pnlPercent: 0,
          exitReason: 'safe_trade_no_trade_block',
          bgState: sig.bgState,
          lastKind,
          trendTF: sig._noTradeData.trendTF,
        });
        continue; // skip this signal — do NOT consume slot or capital
      }
    }

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
    const remaining = activeExits.filter((e) => e.exitIdx >= idx);
    activeExits.length = 0;
    activeExits.push(...remaining);

    // Track peak concurrency (across all bots + per-bot)
    if (activeExits.length > peakConcurrentTrades) peakConcurrentTrades = activeExits.length;
    const activeForBotNow = activeExits.filter((e) => e.botId === sig.botId).length;
    if (activeForBotNow > perBotPeak[sig.botId]) perBotPeak[sig.botId] = activeForBotNow;

    // ─── Check per-bot concurrent slot ─────────────
    if (activeForBotNow >= cfg.maxConcurrentTrades) {
      // slot เต็ม → skip (เหมือน single-bot behavior)
      perBotTrades[sig.botId].push({
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
        exitReason: 'capital_exhausted_skip',
      });
      continue;
    }

    // ─── Buy fill check (FIX 2026-07-30: scan FUTURE candles เหมือน simulateTrades) ─────
    // เดิมเช็ค candle เดียวกับ signal candle เท่านั้น → always pass → overcount
    // จริง ๆ maker BUY ที่ราคา P จะ fill ก็ต่อเมื่อ candle ถัดไป dip ลงถึง P แล้วปิดเหนือ P
    let buyFilled = false;
    let buyCandleIdx = null;
    const buyEnd = Math.min(sig._klines.length, idx + 1 + cfg.maxBuyWait);
    for (let j = idx + 1; j < buyEnd; j += 1) {
      const c = sig._klines[j];
      if (c.low <= buyPrice && c.close >= buyPrice && c.volume > 0) {
        buyFilled = true;
        buyCandleIdx = j;
        break;
      }
    }

    if (!buyFilled) {
      perBotTrades[sig.botId].push({
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
      });
      continue;
    }

    // ─── Notional check (FIX 2026-07-30: ขาดไปก่อนหน้านี้) ────────
    if (notional.lessThan(cfg.minNotional)) {
      perBotTrades[sig.botId].push({
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
      });
      continue;
    }

    // ─── Phase 2: SELL fill check (FIX-2026-07-31: priority-ordered exits) ─────────
    // Priority (earliest exit wins):
    //   1. CB panic-sell (unconditional, allow profit) — match live _checkCBPanicClose
    //   2. Stop loss on upper-KC (only at loss) — match live _checkStopLossOnUpperKC
    //   3. TP hit (existing)
    // FIX-2026-07-31 (BUG): อ่าน sig._lowerKC/_upperKC/_opensArr/_closesArr (ไม่ใช่ sig.lowerKC แบบเดิมที่ไม่ได้แนบ)
    let sellFilled = false;
    let sellCandleIdx = null;
    let exitMode = 'tp'; // 'tp' | 'cb_panic' | 'cbv2_panic' | 'stop_loss_upper_kc'
    let exitPrice = null;
    for (let j = buyCandleIdx + 1; j < sig._klines.length; j += 1) {
      const candle = sig._klines[j];
      const candleClose = parseFloat(candle.close);
      const candleOpen = parseFloat(candle.open);
      const candleHigh = parseFloat(candle.high);
      // FIX-2026-08-06: CBv2 sustained panic-sell (priority over CB) — 4 consecutive red candles below lowerKC
      //   - เช็ค CBv2 ก่อน CB เพราะ CBv2 เป็น pattern ที่ stricter (ต้อง match ทั้ง i และ i-1)
      //   - เมื่อ CBv2 match → exit ที่ cbv2_panic (ไม่ใช่ cb_panic เพราะ user-visible reason ต่างกัน)
      if (cfg.cbv2Enabled && sig._lowerKC && sig._lowerKC[j] != null
          && signalEngine.isCBv2At(j, sig._opensArr, sig._closesArr, sig._lowerKC)) {
        sellFilled = true;
        sellCandleIdx = j;
        exitMode = 'cbv2_panic';
        exitPrice = candleClose;
        break;
      }
      // 1) CB pattern (3 red candles below lowerKC) → panic-close at close (unconditional)
      if (cfg.cbEnabled && sig._lowerKC && sig._lowerKC[j] != null
          && signalEngine.isCBAt(j, sig._opensArr, sig._closesArr, sig._lowerKC)) {
        sellFilled = true;
        sellCandleIdx = j;
        exitMode = 'cb_panic';
        exitPrice = candleClose;
        break;
      }
      // 2) Upper-KC stop-loss (close > upperKC + buyPrice > close) → close at close (loss only)
      // FIX-2026-08-03: Option B parity — non-DCA backtester ใช้ OR semantic (armed = stopLossOnUpperKC || autoArmStopLossOnUKC)
      //   - เดิม: เช็คแค่ cfg.stopLossOnUpperKC → bug! บอทที่ AU=on, SL-UKC=off backtest ไม่ trigger (ต่างจาก DCA backtest)
      //   - ใหม่: armed = stopLossOnUpperKC OR autoArmStopLossOnUKC → live == backtest
      // FIX-2026-08-03: slUkcTriggerOnProfit — default false = loss only, true = any close>upperKC
      const armed = cfg.stopLossOnUpperKC || cfg.autoArmStopLossOnUKC;
      const profitOk = cfg.slUkcTriggerOnProfit === true || buyPrice > candleClose;
      if (armed && sig._upperKC && sig._upperKC[j] != null
          && candleClose > sig._upperKC[j] && profitOk) {
        sellFilled = true;
        sellCandleIdx = j;
        exitMode = 'stop_loss_upper_kc';
        exitPrice = candleClose;
        break;
      }
      // 3) TP hit (existing)
      if (candleHigh >= target) {
        sellFilled = true;
        sellCandleIdx = j;
        exitMode = 'tp';
        exitPrice = target;
        break;
      }
    }

    const exitIdx = sellCandleIdx != null ? sellCandleIdx : sig._klines.length;
    // FIX-2026-07-31: exitPrice อาจเป็น target (TP) หรือ candleClose (CB/UpperKC SL) หรือ null (still_holding)
    const finalExitPrice = sellFilled ? exitPrice : null;

    let pnl = null;
    let grossVal = 0;
    let feesVal = 0;
    // FIX 2026-07-30: still_holding — mark-to-market ด้วย last close เพื่อให้ UI แสดง unrealized ได้
    let lastClose = sellFilled ? finalExitPrice : (sig._klines[sig._klines.length - 1] ? sig._klines[sig._klines.length - 1].close : buyPrice);
    let unrealizedPnlVal = 0;
    if (sellFilled) {
      const gross = new Decimal(finalExitPrice).minus(new Decimal(buyPrice)).mul(qty);
      const feeBuy = new Decimal(buyPrice).mul(qty).mul(cfg.feeRate);
      const feeSell = new Decimal(finalExitPrice).mul(qty).mul(cfg.feeRate);
      pnl = gross.minus(feeBuy).minus(feeSell).toNumber();
      grossVal = gross.toNumber();
      feesVal = feeBuy.plus(feeSell).toNumber();
    } else {
      // still_holding — unrealized vs last close (รวม round-trip fee buffer ที่เหลือต้องจ่ายตอนขาย)
      const gross = new Decimal(lastClose).minus(new Decimal(buyPrice)).mul(qty);
      const feeBuy = new Decimal(buyPrice).mul(qty).mul(cfg.feeRate);
      const feeSell = new Decimal(lastClose).mul(qty).mul(cfg.feeRate);
      unrealizedPnlVal = gross.minus(feeBuy).minus(feeSell).toNumber();
    }

    // BUY/SELL fill timestamp = กลางแท่ง (openTime + stepMs/2) — ตรงกับ single-bot
    const buyFilledAtMs = stepMs > 0 ? sig._klines[buyCandleIdx].openTime + Math.floor(stepMs / 2) : sig._klines[buyCandleIdx].closeTime;
    const sellFilledAtMs = sellCandleIdx != null
      ? (stepMs > 0 ? sig._klines[sellCandleIdx].openTime + Math.floor(stepMs / 2) : sig._klines[sellCandleIdx].closeTime)
      : null;

    // FIX-2026-07-31: exitReason รวมใหม่ — cb_panic / stop_loss_upper_kc / tp_hit / still_holding
    const exitReason = sellFilled ? exitMode : 'still_holding';

    const trade = {
      botId: sig.botId,
      symbol: cfg.symbol,
      timeframe: cfg.timeframe,
      signalTime: new Date(sig.openTime),
      candleCloseTime: new Date(sig.closeTime),
      buyFilledAt: new Date(buyFilledAtMs),
      sellFilledAt: sellFilledAtMs != null ? new Date(sellFilledAtMs) : null,
      buyPrice,
      targetSellPrice: target,
      sellPrice: finalExitPrice,
      lastClose: sellFilled ? null : lastClose, // FIX 2026-07-30: only for still_holding
      buyFilled: true,
      sellFilled,
      qty: qty.toNumber(),
      notional: notional.toNumber(),
      grossPnl: grossVal,
      fees: feesVal,
      realizedPnl: pnl,
      unrealizedPnl: sellFilled ? 0 : unrealizedPnlVal,
      pnlPercent: pnl != null ? (pnl / notional.toNumber()) * 100 : 0,
      unrealizedPnlPercent: !sellFilled && notional.toNumber() > 0 ? (unrealizedPnlVal / notional.toNumber()) * 100 : 0,
      exitReason,
      capitalUsed: cfg.capitalPerTrade,
      // FIX 2026-07-30: candles held = candles ตั้งแต่ BUY fill จนถึงแท่งสุดท้ายของข้อมูล
      candlesHeld: sellFilled ? (sellCandleIdx - buyCandleIdx) : (sig._klines.length - 1 - buyCandleIdx),
    };
    allTrades.push(trade);
    perBotTrades[sig.botId].push(trade);

    // Track active capital usage
    activeExits.push({ botId: sig.botId, exitIdx, capitalUsed: cfg.capitalPerTrade });
    const newUsed = activeExits.reduce((s, e) => s + e.capitalUsed, 0);
    if (newUsed > peakCapitalUsed.toNumber()) peakCapitalUsed = new Decimal(newUsed);
    const newActiveForBot = activeExits.filter((e) => e.botId === sig.botId).length;
    if (newActiveForBot > perBotPeak[sig.botId]) perBotPeak[sig.botId] = newActiveForBot;
  }

  // 3b) FIX-2026-08-02: DCA stack simulator pass — per bot, single-stack mode.
  //   DCA bots bypass the per-trade simulator above. Here we simulate each DCA bot's stack
  //   using the same helpers as runDcaBacktest (tryFillBuy, computeBEP, closeOpenStack).
  //   DCA capital still respects the shared pool: each layer = cfg.capitalPerTrade reserved.
  // FIX-2026-08-03: DCA + Martingale sizing (parity with runDcaBacktest + trader._computeDcaLayerNotional)
  //   - layerNotional(layerIdx) helper applies multiplier^(idx-1) when cfg.martingaleEnabled=true
  //   - capital pool reservation uses layerNotional per layer (not flat cfg.capitalPerTrade)
  const dcaBots = botInputs.filter((bi) => bi.cfg.dcaEnabled);
  if (dcaBots.length > 0) {
    for (const bi of dcaBots) {
      const cfg = bi.cfg;
      const klines = bi.klines;
      const stepMs = klines.length >= 2 ? (klines[1].openTime - klines[0].openTime) : 0;
      let stackCounter = 0;
      let openStack = null;
      // FIX-2026-08-03: per-bot layer notional helper (mirrors runDcaBacktest.computeLayerNotional)
      const layerNotional = (idx) => {
        if (!cfg.martingaleEnabled) return parseFloat(cfg.capitalPerTrade) || 0;
        const i = Math.max(1, parseInt(idx, 10) || 1);
        const mult = parseFloat(cfg.martingaleMultiplier) || 1.5;
        const raw = (parseFloat(cfg.capitalPerTrade) || 0) * Math.pow(mult, i - 1);
        return Math.min(raw, parseFloat(cfg.martingaleMaxLayerNotional) || 100);
      };

      // Sort signals ascending by index for deterministic order
      const sortedSignals = [...bi.signals].sort((a, b) => a.index - b.index);

      for (const sig of sortedSignals) {
        const buyPrice = sig.close;

        // FIX-2026-08-03: Safe-trade #2 (trendline) filter — DCA per-signal check (multi-bot)
        //   - mirror runDcaBacktest pattern
        //   - ⚠️ ไม่แนะนำเปิดกับ DCA (DCA ซื้อ dip — filter นี้ block dip-buy)
        if (bi.trendlineData && Array.isArray(bi.trendlineData.upperKlines)) {
          const tlValue = _trendlineAt(sig.openTime, bi.trendlineData.upperKlines, bi.trendlineData.upperTrendline);
          if (tlValue != null && Number.isFinite(tlValue) && buyPrice <= tlValue) {
            const gapPct = ((buyPrice - tlValue) / tlValue) * 100;
            perBotTrades[bi.botId].push({
              signalTime: new Date(sig.openTime),
              candleCloseTime: new Date(sig.closeTime),
              buyPrice,
              layerIndex: openStack ? (openStack.layerCount + 1) : 1,
              layerCountAfter: 0,
              buyFilled: false,
              sellFilled: false,
              qty: 0,
              notional: 0,
              exitReason: 'safe_trade_trendline_block',
              stackId: null,
              trendlineValue: Number(tlValue.toFixed(8)),
              gapPct: Number(gapPct.toFixed(3)),
            });
            continue; // skip this layer-add
          }
        }

        // ─── Layer 1: open new stack ───────────────────────────
        if (!openStack) {
          const buyRes = await tryFillBuy({
            klines, sigIdx: sig.index, buyPrice,
            maxBuyWait: cfg.maxBuyWait, stepMs,
          });
          if (!buyRes.filled) {
            perBotTrades[bi.botId].push({
              signalTime: new Date(sig.openTime),
              candleCloseTime: new Date(sig.closeTime),
              buyPrice,
              layerIndex: 1,
              layerCountAfter: 0,
              buyFilled: false,
              sellFilled: false,
              qty: 0,
              notional: 0,
              exitReason: 'no_buy_fill',
              stackId: null,
            });
            continue;
          }
          // Shared capital pool check (each layer costs layerNotional(1) — fixed or Martingale-scaled)
          const capBefore = activeExits.reduce((s, e) => s + e.capitalUsed, 0);
          if (capBefore + layerNotional(1) > totalCap.toNumber()) {
            capitalExhaustedSkips++;
            perBotTrades[bi.botId].push({
              signalTime: new Date(sig.openTime),
              candleCloseTime: new Date(sig.closeTime),
              buyPrice,
              layerIndex: 1,
              layerCountAfter: 0,
              buyFilled: false,
              sellFilled: false,
              qty: 0,
              notional: 0,
              exitReason: 'capital_exhausted_skip',
              stackId: null,
            });
            continue;
          }
          const qty = computeLayerQty(buyPrice, layerNotional(1), cfg.stepSize);
          const notional = new Decimal(buyPrice).mul(new Decimal(qty));
          if (notional.lessThan(cfg.minNotional)) {
            perBotTrades[bi.botId].push({
              signalTime: new Date(sig.openTime),
              candleCloseTime: new Date(sig.closeTime),
              buyPrice,
              layerIndex: 1,
              layerCountAfter: 0,
              buyFilled: false,
              sellFilled: false,
              qty: qty.toNumber(),
              notional: notional.toNumber(),
              exitReason: 'below_min_notional',
              stackId: null,
            });
            continue;
          }
          const stackId = `dca_${bi.botId}_${++stackCounter}`;
          const layer = { price: buyPrice, qty: qty.toNumber(), filledAtMs: buyRes.filledAtMs };
          const { bep } = computeBEP([layer]);
          const targetSellPrice = new Decimal(bep)
            .mul(1 + cfg.tpPercent / 100 + 2 * cfg.feeRate).toNumber();
          openStack = {
            stackId,
            botId: bi.botId,
            symbol: cfg.symbol,
            timeframe: cfg.timeframe,
            openedAtMs: sig.openTime,
            signalCloseTimeMs: sig.closeTime,
            layers: [layer],
            layerCount: 1,
            totalQty: qty.toNumber(),
            totalSpent: notional.toNumber(),
            stackBep: bep,
            targetSellPrice,
            sellFilled: false,
            sellFilledAtMs: null,
            exitReason: null,
            exitPrice: null,
            sellCandleIdx: null,
            candlesHeld: 0,
          };
          // Reserve shared capital for this stack
          activeExits.push({
            botId: bi.botId,
            exitIdx: klines.length, // will update on close
            capitalUsed: layerNotional(1),
            isDcaStack: true,
            stackId,
          });
          if (activeExits.length > peakConcurrentTrades) peakConcurrentTrades = activeExits.length;
          const newUsed = activeExits.reduce((s, e) => s + e.capitalUsed, 0);
          if (newUsed > peakCapitalUsed.toNumber()) peakCapitalUsed = new Decimal(newUsed);
          perBotTrades[bi.botId].push({
            signalTime: new Date(sig.openTime),
            candleCloseTime: new Date(sig.closeTime),
            buyPrice,
            layerIndex: 1,
            layerCountAfter: 1,
            buyFilled: true,
            sellFilled: false,
            qty: qty.toNumber(),
            notional: notional.toNumber(),
            exitReason: 'layer_added',
            stackId,
          });
          continue;
        }

        // ─── Layer 2+: try add layer ────────────────────────────
        if (openStack.layerCount >= cfg.dcaMaxLayers) {
          perBotTrades[bi.botId].push({
            signalTime: new Date(sig.openTime),
            candleCloseTime: new Date(sig.closeTime),
            buyPrice,
            layerIndex: openStack.layerCount + 1,
            layerCountAfter: openStack.layerCount,
            buyFilled: false,
            sellFilled: false,
            qty: 0,
            notional: 0,
            exitReason: 'dca_max_layers_hit',
            stackId: openStack.stackId,
          });
          continue;
        }
        // Shared capital check (each layer costs layerNotional(layerIdx) — Martingale-scaled)
        const layerIdx = openStack.layerCount + 1;
        const capBeforeLayer = activeExits.reduce((s, e) => s + e.capitalUsed, 0);
        if (capBeforeLayer + layerNotional(layerIdx) > totalCap.toNumber()) {
          capitalExhaustedSkips++;
          perBotTrades[bi.botId].push({
            signalTime: new Date(sig.openTime),
            candleCloseTime: new Date(sig.closeTime),
            buyPrice,
            layerIndex: layerIdx,
            layerCountAfter: openStack.layerCount,
            buyFilled: false,
            sellFilled: false,
            qty: 0,
            notional: 0,
            exitReason: 'capital_exhausted_skip',
            stackId: openStack.stackId,
          });
          continue;
        }
        const buyRes = await tryFillBuy({
          klines, sigIdx: sig.index, buyPrice,
          maxBuyWait: cfg.maxBuyWait, stepMs,
        });
        if (!buyRes.filled) {
          perBotTrades[bi.botId].push({
            signalTime: new Date(sig.openTime),
            candleCloseTime: new Date(sig.closeTime),
            buyPrice,
            layerIndex: layerIdx,
            layerCountAfter: openStack.layerCount,
            buyFilled: false,
            sellFilled: false,
            qty: 0,
            notional: 0,
            exitReason: 'no_buy_fill',
            stackId: openStack.stackId,
          });
          continue;
        }
        const qty = computeLayerQty(buyPrice, layerNotional(layerIdx), cfg.stepSize);
        const notional = new Decimal(buyPrice).mul(new Decimal(qty));
        if (notional.lessThan(cfg.minNotional)) {
          perBotTrades[bi.botId].push({
            signalTime: new Date(sig.openTime),
            candleCloseTime: new Date(sig.closeTime),
            buyPrice,
            layerIndex: openStack.layerCount + 1,
            layerCountAfter: openStack.layerCount,
            buyFilled: false,
            sellFilled: false,
            qty: qty.toNumber(),
            notional: notional.toNumber(),
            exitReason: 'below_min_notional',
            stackId: openStack.stackId,
          });
          continue;
        }
        // Append layer + recompute BEP + new target
        openStack.layers.push({ price: buyPrice, qty: qty.toNumber(), filledAtMs: buyRes.filledAtMs });
        openStack.layerCount += 1;
        const { totalQty, totalSpent, bep } = computeBEP(openStack.layers);
        openStack.totalQty = totalQty;
        openStack.totalSpent = totalSpent;
        openStack.stackBep = bep;
        openStack.targetSellPrice = new Decimal(bep)
          .mul(1 + cfg.tpPercent / 100 + 2 * cfg.feeRate).toNumber();
        // Reserve additional capital for the new layer (Martingale-scaled notional)
        activeExits.push({
          botId: bi.botId,
          exitIdx: klines.length,
          capitalUsed: layerNotional(layerIdx),
          isDcaStack: true,
          stackId: openStack.stackId,
        });
        if (activeExits.length > peakConcurrentTrades) peakConcurrentTrades = activeExits.length;
        const newUsed = activeExits.reduce((s, e) => s + e.capitalUsed, 0);
        if (newUsed > peakCapitalUsed.toNumber()) peakCapitalUsed = new Decimal(newUsed);
        perBotTrades[bi.botId].push({
          signalTime: new Date(sig.openTime),
          candleCloseTime: new Date(sig.closeTime),
          buyPrice,
          layerIndex: openStack.layerCount,
          layerCountAfter: openStack.layerCount,
          buyFilled: true,
          sellFilled: false,
          qty: qty.toNumber(),
          notional: notional.toNumber(),
          exitReason: 'layer_added',
          stackId: openStack.stackId,
        });
      }

      // ─── Close any open stack at end of range ────────────────
      if (openStack) {
        closeOpenStack({
          openStack, klines, stepMs, feeRate: cfg.feeRate,
          stopLossOnUpperKC: cfg.stopLossOnUpperKC,
          autoArmStopLossOnUKC: cfg.autoArmStopLossOnUKC,
          upperKC: bi.upperKC,
        });
        // Remove from activeExits (stack closed)
        const idx = activeExits.findIndex((e) => e.stackId === openStack.stackId);
        if (idx >= 0) activeExits.splice(idx, 1);
        // Append the closed stack as a Trade-shaped record
        const stackTrade = buildStackTradeRecord(openStack, cfg.feeRate);
        allTrades.push(stackTrade);
        perBotTrades[bi.botId].push(stackTrade);
        // Update perBotPeak — DCA stack holds 1 slot
        const activeForBot = activeExits.filter((e) => e.botId === bi.botId).length;
        if (activeForBot > perBotPeak[bi.botId]) perBotPeak[bi.botId] = activeForBot;
      }
    }
  }

  // 4) Per-bot stats + combined stats
  // FIX 2026-07-30: ส่ง trades ทั้งหมด (รวม skip types) เข้า summarize() — เพื่อให้นับ no_buy_fill,
  //   below_min_notional, max_concurrent_skip, capital_exhausted_skip ได้ครบ
  // FIX-2026-07-31: opened/closed trades include cb_panic + stop_loss_upper_kc exits
  const openedExitReasons = new Set([
    'tp_hit', 'still_holding', 'cb_panic', 'cbv2_panic', 'stop_loss_upper_kc',
    // FIX-2026-08-02: DCA stack exit reasons — counted as opened "stacks"
    'dca_target_hit', 'dca_stack_stop_loss', 'dca_still_holding',
  ]);
  const perBot = botInputs.map((bi) => {
    const allBotTrades = perBotTrades[bi.botId];
    const stats = summarize(allBotTrades);
    const openedTrades = allBotTrades.filter((t) => openedExitReasons.has(t.exitReason));
    const dcaStacks = allBotTrades.filter((t) => t.isDcaStack === true);
    const isDca = bi.cfg.dcaEnabled === true;
    // FIX-2026-08-03: Safe-trade trendline blocked count per-bot
    const safeTradeTrendlineBlocked = allBotTrades.filter((t) => t.exitReason === 'safe_trade_trendline_block').length;
    return {
      botId: bi.botId,
      symbol: bi.cfg.symbol,
      timeframe: bi.cfg.timeframe,
      tpPercent: bi.cfg.tpPercent,
      kcMult: bi.cfg.kcMult,
      capitalPerTrade: bi.cfg.capitalPerTrade,
      maxConcurrentTrades: bi.cfg.maxConcurrentTrades,
      xs1Enabled: bi.cfg.xs1Enabled != null ? bi.cfg.xs1Enabled : true,
      cbEnabled: bi.cfg.cbEnabled != null ? bi.cfg.cbEnabled : true,
      stopLossOnUpperKC: bi.cfg.stopLossOnUpperKC === true,
      // FIX-2026-08-02: DCA mode params + stats
      dcaEnabled: isDca,
      dcaMaxLayers: bi.cfg.dcaMaxLayers || 3,
      autoArmStopLossOnUKC: bi.cfg.autoArmStopLossOnUKC === true,
      // FIX-2026-08-03: F1 thresholds + SL-UKC profit toggle (Option B parity)
      autoArmLossPct: bi.cfg.autoArmLossPct ?? 10,
      autoArmAgeHours: bi.cfg.autoArmAgeHours ?? 4,
      slUkcTriggerOnProfit: bi.cfg.slUkcTriggerOnProfit === true,
      // FIX-2026-08-03: Safe-trade #2 (trendline) filter — per-bot block count
      safeTradeTrendlineEnabled: bi.trendlineData != null,
      // FIX-2026-08-05: include no-trade filter status in per-bot summary
      safeTradeNoTradeEnabled: bi.noTradeData != null,
      safeTradeTrendlineBlocked,
      // FIX-2026-08-05: no-trade filter blocked count (per-bot, mirror ST#2 trendline)
      //   - count from allBotTrades where exitReason === 'safe_trade_no_trade_block'
      safeTradeNoTradeBlocked: allBotTrades.filter((t) => t.exitReason === 'safe_trade_no_trade_block').length,
      candlesFetched: bi.candlesFetched,
      truncated: bi.truncated,
      signalsCount: bi.signals.length,
      // DCA bots: count stacks (not layers). Non-DCA: count trades.
      tradesCount: isDca ? dcaStacks.length : openedTrades.length,
      stacksCount: isDca ? dcaStacks.length : null, // null for non-DCA bots
      skippedCount: allBotTrades.length - (isDca ? dcaStacks.length : openedTrades.length),
      maxConcurrentTradesUsed: perBotPeak[bi.botId] || 0,
      stats,
    };
  });

  const closedTrades = allTrades.filter((t) => openedExitReasons.has(t.exitReason));
  // FIX 2026-07-30: combinedStats = summarize over ALL trades (รวม skip) เพื่อให้นับ skip types ได้
  const combinedStats = summarize(allTrades);

  // FIX 2026-07-30: รายละเอียดทุก position ที่ยังถืออยู่ที่จบ window — ให้ UI backtest แสดงเป็นตารางได้
  //   ใช้สำหรับ "ยังไม่ถึง TP แต่ยังไม่ปิด" → mark-to-market ด้วย last close + bots list
  // FIX-2026-08-02: รวม DCA still_holding stacks (unrealizedPnl vs last close)
  const lastCloseBySymbol = {};
  for (const bi of botInputs) {
    if (bi.klines.length > 0) {
      lastCloseBySymbol[bi.cfg.symbol] = parseFloat(bi.klines[bi.klines.length - 1].close);
    }
  }
  const stillHoldingPositions = allTrades
    .filter((t) => t.exitReason === 'still_holding' || t.exitReason === 'dca_still_holding')
    .map((t) => {
      const isDca = t.isDcaStack === true;
      const entry = isDca ? (t.stackBep || 0) : (t.buyPrice || 0);
      const tp = isDca ? (t.targetSellPrice || 0) : (t.targetSellPrice || 0);
      const lastC = isDca ? (lastCloseBySymbol[t.symbol] || 0) : (t.lastClose || 0);
      // mark-to-market for DCA stacks using stackBep + totalQty
      let unrealizedPnl = t.unrealizedPnl || 0;
      let unrealizedPnlPct = t.unrealizedPnlPercent || 0;
      if (isDca && lastC > 0 && t.totalSpent > 0) {
        // rough PnL vs stackBep at last close (no fee buffer on unrealized)
        unrealizedPnl = (lastC - entry) * (t.totalQty || 0);
        unrealizedPnlPct = t.totalSpent > 0 ? (unrealizedPnl / t.totalSpent) * 100 : 0;
      }
      const pnlPct = entry > 0 ? ((lastC - entry) / entry) * 100 : 0;
      const totalPathPct = entry > 0 && tp > 0 ? ((tp - entry) / entry) * 100 : 0;
      const pctToTp = tp > 0 && lastC > 0 && lastC < tp ? ((tp - lastC) / lastC) * 100 : 0;
      const tpReached = tp > 0 && lastC >= tp;
      return {
        botId: t.botId,
        botIndex: bots.findIndex((b) => (b.botId || `bot_${bots.indexOf(b)}`) === t.botId),
        symbol: t.symbol,
        timeframe: t.timeframe,
        signalTime: t.signalTime,
        candleCloseTime: t.candleCloseTime,
        buyFilledAt: t.buyFilledAt,
        buyPrice: entry,
        targetSellPrice: tp,
        qty: t.qty,
        notional: t.notional,
        capitalUsed: t.capitalUsed,
        lastClose: lastC,
        unrealizedPnl,
        unrealizedPnlPercent: unrealizedPnlPct,
        pnlPercent: pnlPct,
        totalPathPct,
        pctToTp,
        tpReached,
        candlesHeld: t.candlesHeld,
        // DCA-specific fields (null for non-DCA)
        isDcaStack: isDca,
        stackId: t.stackId || null,
        stackBep: isDca ? t.stackBep : null,
        layerCount: isDca ? t.layerCount : null,
        totalQty: isDca ? t.totalQty : null,
        totalSpent: isDca ? t.totalSpent : null,
      };
    });

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
          kcMult: b.kcMult,
          capitalPerTrade: b.capitalPerTrade, maxConcurrentTrades: b.maxConcurrentTrades,
          xs1Enabled: b.xs1Enabled !== false,
          cbEnabled: b.cbEnabled !== false,
          // FIX-2026-08-06: CBv2 sustained panic-sell (default true)
          cbv2Enabled: b.cbv2Enabled !== false,
          cbv2LockHours: b.cbv2LockHours != null ? parseFloat(b.cbv2LockHours) : 8,
          stopLossOnUpperKC: b.stopLossOnUpperKC === true,
          // FIX-2026-08-02: persist DCA params per bot
          dcaEnabled: b.dcaEnabled === true,
          dcaMaxLayers: b.dcaMaxLayers != null ? parseInt(b.dcaMaxLayers, 10) : 3,
          autoArmStopLossOnUKC: b.autoArmStopLossOnUKC === true,
          // FIX-2026-08-03: persist F1 thresholds + SL-UKC profit toggle for reproducibility
          autoArmLossPct: b.autoArmLossPct != null ? parseFloat(b.autoArmLossPct) : 10,
          autoArmAgeHours: b.autoArmAgeHours != null ? parseFloat(b.autoArmAgeHours) : 4,
          slUkcTriggerOnProfit: b.slUkcTriggerOnProfit === true,
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
      // FIX 2026-07-30: expose every skip counter (ให้ UI แสดงเหมือน single backtest)
      skippedCapitalCount: capitalExhaustedSkips,
      noBuyFillCount: combinedStats.noBuyFillCount,
      maxConcurrentSkipCount: combinedStats.maxConcurrentSkipCount,
      belowMinNotionalCount: combinedStats.belowMinNotionalCount,
      stillHoldingCount: combinedStats.stillHoldingCount,
      tpHitCount: combinedStats.tpHitCount,
      peakCapitalUsed: peakCapitalUsed.toNumber(),
      peakConcurrentTrades,
      stats: combinedStats,
      trades: storedTrades,
      // FIX 2026-07-30: รายละเอียด positions ที่ยังถืออยู่ (mark-to-market ด้วย last close)
      stillHoldingPositions,
      stillHoldingCount: stillHoldingPositions.length,
      stillHoldingTotalUnrealized: stillHoldingPositions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0),
    },
  };
}