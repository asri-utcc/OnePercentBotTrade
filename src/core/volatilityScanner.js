'use strict';

/**
 * Volatility Scanner — scans the Binance USDT spot universe and ranks
 * symbols by a multi-factor "swing strength" score.
 *
 * Scoring formula (per spec):
 *
 *   score = 0.4 * (avg_vol / threshold)
 *         + 0.3 * (pct_bars_above_threshold)
 *         + 0.2 * (current_ATR_pct / threshold)
 *         + 0.1 * (max_vol / threshold)
 *
 * where
 *   vol_pct per bar   = (high - low) / low * 100
 *   ATR%              = ATR(14) / close * 100
 *   BBW               = (upper - lower) / basis   (BB period=20, mult=2)
 *
 * The scanner is the heavy-lifting backend for /api/scan/volatility —
 * it intentionally lives on the server so the client doesn't have to
 * fan-out 100+ klines calls.
 */

const binanceRest = require('../binance/binanceRest');
const { atr, bollingerBands, keltnerChannel, ema } = require('./indicators');
const fees = require('../binance/fees'); // FIX-2026-07-25: TP net = gross - feeBuffer (match suggest-tp route)

// FIX-2026-07-25: format TP ให้เป็นทศนิยม 3 ตำแหน่ง โดยหลักพัน (ตำแหน่งที่ 3) ต้องเป็น 1 เสมอ
//   - floor ทศนิยมที่ 2 แล้ว +0.001 → output อยู่ในรูป x.xx1 เสมอ
//   - mirror logic จาก bot.routes.js (POST /suggest-tp) และ tpUpdater.js — single source of truth
function formatTpToXxx1(value) {
  if (value == null || !Number.isFinite(value)) return value;
  const truncated2 = Math.floor(value * 100) / 100;
  return Number((truncated2 + 0.001).toFixed(3));
}
const logger = require('../utils/logger');

// Binance /api/v3/klines caps each call at 1000 bars. Anything > 1000 must
// be paginated via endTime loop — see binanceRest.getKlinesPaginated.
const BINANCE_KLINE_BATCH_LIMIT = 1000;

// Leveraged-token prefix regex — UP/DOWN/BULL/BEAR tokens trade differently
// and shouldn't be ranked alongside spot pairs.
const LEVERAGED_PREFIX = /^(UP|DOWN|BULL|BEAR)[A-Z0-9]+USDT$/;

// Trend thresholds — slope of half-window SMA in %.
const TREND_UP_THRESHOLD = 0.5;   // +0.5% over the window → uptrend
const TREND_DOWN_THRESHOLD = -0.5; // -0.5% over the window → downtrend

// FIX-2026-07-23: Mapping สำหรับ "trend timeframe" (upper-TF) ของแต่ละ scan timeframe
//   ใช้คำนวณ EMA20 trend เพื่อบอกว่าราคา "อยู่บน" หรือ "อยู่ล่าง" EMA20 ของ TF ที่ใหญ่กว่า
//   และใช้คำนวณ %TP ที่แนะนำ
//   - upper-TF ที่ใหญ่กว่า scan TF → กรอง noise ของ timeframe เล็กออก
//   - สูตร %TP: trend upper → minKC/4, trend lower → minKC/8 (มาจาก "KC squeeze → breakout" logic)
//   - default fallback: ถ้า scan TF ไม่อยู่ใน map → ใช้ TF ถัดไปที่ใหญ่กว่า
const TREND_TF_MAP = {
  '1m':  '30m',
  '3m':  '1h',
  '5m':  '1h',
  '15m': '4h',
  '30m': '6h',
  '1h':  '1d',
  '2h':  '1d',
  '4h':  '1w',
  '6h':  '1w',
  '8h':  '1w',
  '12h': '1w',
  '1d':  '1w',
  '3d':  '1w',
  '1w':  '1M',
  '1M':  '1M', // ไม่มี TF ใหญ่กว่าใน Binance — fallback ใช้ตัวเอง (จะได้ trend warmup เสมอ)
};

// EMA20 trend — ต้องใช้ klines กี่แท่ง?
//   EMA20 warmup ต้องการ 20 แท่ง → fetch 30 เพื่อ safety margin
const TREND_KLINE_LIMIT = 30;

/**
 * Classify trend direction over the last `window` bars using SMA slope.
 *
 * Method: split the window in half → compare SMA of first half vs second half.
 * This is robust against wicks in the most recent bar.
 *
 *   slope >  +0.5% → 'uptrend'
 *   slope <  -0.5% → 'downtrend'
 *   otherwise      → 'sideways'
 *
 * @param {Array} klines
 * @param {number} window
 * @returns {'uptrend' | 'downtrend' | 'sideways'}
 */
function classifyTrend(klines, window) {
  const slice = klines.slice(-window);
  if (slice.length < 4) return 'sideways';
  const closes = slice.map((k) => k.close);
  const half = Math.max(2, Math.floor(closes.length / 2));
  const sma = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const firstSMA = sma(closes.slice(0, half));
  const lastSMA = sma(closes.slice(-half));
  if (firstSMA <= 0) return 'sideways';
  const slopePct = ((lastSMA - firstSMA) / firstSMA) * 100;
  if (slopePct > TREND_UP_THRESHOLD) return 'uptrend';
  if (slopePct < TREND_DOWN_THRESHOLD) return 'downtrend';
  return 'sideways';
}

const VALID_TRENDS = ['uptrend', 'downtrend', 'sideways'];

/**
 * FIX-2026-07-23: คำนวณ EMA20 trend ของ upper-timeframe
 *   - รับ klines ของ TF ที่ใหญ่กว่า scan TF (เช่น scan 5m → trend 1h)
 *   - คำนวณ EMA(closes, 20)
 *   - เปรียบเทียบ lastClose กับ EMA20
 *     - lastClose >= EMA20 → 'upper' (ราคาอยู่บนเส้น)
 *     - lastClose <  EMA20 → 'lower' (ราคาอยู่ใต้เส้น)
 *     - < 20 closes → 'warmup'
 *
 * @param {Array|null} klines  klines ของ upper-TF (null ถ้า fetch fail)
 * @param {string|null} trendTF TF ที่ใช้ (null ถ้า scan TF == trend TF เช่น 1M)
 * @returns {{ trendTF, trendEma20, trendLastClose, trendGapPct, trendState }}
 */
function computeTrend(klines, trendTF) {
  const base = { trendTF: trendTF || null, trendEma20: null, trendLastClose: null, trendGapPct: null, trendState: 'warmup' };
  if (!klines || klines.length < 20 || !trendTF) return base;
  const closes = klines.map((k) => k.close);
  const emaArr = ema(closes, 20);
  const lastIdx = emaArr.length - 1;
  const ema20 = emaArr[lastIdx];
  const lastClose = closes[closes.length - 1];
  if (ema20 == null || !Number.isFinite(ema20) || ema20 <= 0 || lastClose == null) return base;
  const gapPct = ((lastClose - ema20) / ema20) * 100;
  return {
    trendTF,
    trendEma20: ema20,
    trendLastClose: lastClose,
    trendGapPct: gapPct,
    trendState: lastClose >= ema20 ? 'upper' : 'lower',
  };
}

/**
 * Run a scan over the Binance USDT spot universe.
 *
 * @param {Object} opts
 * @param {string} [opts.timeframe='5m']
 * @param {number} [opts.threshold=0.5]   vol_pct threshold in %
 * @param {number} [opts.window=20]        rolling window in bars (for avg_vol, max_vol, pct_bars)
 * @param {number} [opts.tpWindow=500]     FIX-2026-07-23: window for kcMinPct used by %TP แนะนำ column
 *                                          — ค่าแยกจาก `window` เพราะ Min %KC ควรดูยาว window กว้าง
 *                                          เพื่อจับ squeeze ที่ลึก → TP ที่เหมาะสม
 *                                          — ค่า default 500 ตรงกับ Get TP% endpoint
 * @param {number} [opts.topN=100]        top N symbols by 24h quoteVolume
 * @param {number} [opts.minQuoteVolume=1_000_000]  skip pairs with lower 24h quoteVolume
 * @param {number} [opts.minPctBarsAbove=0.30]  filter: pct_bars must be >= this
 * @param {number} [opts.concurrency=8]   max parallel klines fetches
 * @param {number} [opts.klineLimit=null] override kline fetch limit (default: max(window, tpWindow) + 50)
 *
 * @returns {Promise<{
 *   universe: string[],
 *   scanned: number,
 *   ranked:  Array<{ symbol, score, avgVol, maxVol, volStd, pctBarsAboveThreshold,
 *                    currentAtrPct, currentBbw, lastClose, lastVolume, windowBars,
 *                    trendTF, trendEma20, trendGapPct, trendState,
 *                    kcMinPct, kcMaxPct, kcAvgPct, suggestedTpPct, tpWindow }>,
 *   threshold: number,
 *   window: number,
 *   tpWindow: number,
 * }>}
 */
async function scanUniverse({
  timeframe = '5m',
  threshold = 0.5,
  window = 20,
  tpWindow = 500,
  topN = 100,
  minQuoteVolume = 1_000_000,
  minPctBarsAbove = 0.30,
  // Trend filter — array of 'uptrend' | 'downtrend' | 'sideways'.
  // Default: all three included (no filtering).
  trends = ['uptrend', 'downtrend', 'sideways'],
  concurrency = 8,
  klineLimit = null,
} = {}) {
  // FIX-2026-07-23: ใช้ max(window, tpWindow) เพื่อให้มี klines พอสำหรับทั้ง volatility stats และ kcMinPct
  const effectiveWindow = Math.max(window, tpWindow);
  const safeKlineLimit = klineLimit || (effectiveWindow + 50);

  // Normalize + validate trends
  const trendSet = new Set(
    (Array.isArray(trends) ? trends : [trends])
      .filter((t) => VALID_TRENDS.includes(t))
  );
  if (trendSet.size === 0) {
    trendSet.add('uptrend');
    trendSet.add('downtrend');
    trendSet.add('sideways');
  }

  // 1) Fetch all 24hr tickers in one call (weight 80) — has quoteVolume but
  //    NO `status` field, so halted symbols appear with stale data.
  const tickers = await binanceRest.get24hrTickers();

  // 2) Fetch exchangeInfo once (weight 20) — gives us `status` for every
  //    symbol. We need this to filter out BREAK / HALT symbols which still
  //    return volume from /ticker/24hr but cannot actually be traded.
  const exchangeInfo = await binanceRest.getExchangeInfo({});
  const statusBySymbol = new Map();
  for (const s of exchangeInfo.symbols || []) {
    if (s && s.symbol) statusBySymbol.set(s.symbol, s);
  }

  // 3) Build universe: USDT pairs, status=TRADING, exclude leveraged tokens,
  //    sort by quoteVolume, take topN.
  // Note: ticker/24hr has ZERO-TRADE symbols (count=0) for some pairs —
  //    also drop those (no real activity even if status=TRADING).
  const universe = tickers
    .filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT'))
    .filter((t) => !LEVERAGED_PREFIX.test(t.symbol))
    .map((t) => {
      const info = statusBySymbol.get(t.symbol);
      const status = info ? info.status : null;
      const allowed = info ? info.isSpotTradingAllowed : false;
      return { symbol: t.symbol, quoteVolume: parseFloat(t.quoteVolume), count: parseInt(t.count, 10) || 0, status, allowed };
    })
    .filter((t) => t.status === 'TRADING' && t.allowed)
    .filter((t) => t.count > 0)
    .filter((t) => t.quoteVolume >= minQuoteVolume)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, topN)
    .map((t) => t.symbol);

  logger.info({
    universeSize: universe.length, timeframe, window, threshold,
    exchangeInfoSize: statusBySymbol.size,
  }, 'volatility scan: universe selected');

  // 3) Fetch klines for each symbol with concurrency cap.
  //    If safeKlineLimit > 1000, use paginated fetcher (Binance caps
  //    single-call at 1000 bars — silently truncates otherwise).
  const needsPagination = safeKlineLimit > BINANCE_KLINE_BATCH_LIMIT;

  // FIX-2026-07-23: also fetch upper-TF klines (for EMA20 trend + suggested %TP)
  const trendTF = TREND_TF_MAP[timeframe] || null;
  const needsTrendKlines = !!trendTF && trendTF !== timeframe;
  if (trendTF) {
    logger.info({ scanTF: timeframe, trendTF, needsFetch: needsTrendKlines }, 'volatility scan: trend timeframe selected');
  }

  const fetched = await mapWithConcurrency(universe, concurrency, async (symbol) => {
    try {
      const mainFetch = needsPagination
        ? binanceRest.getKlinesPaginated({
          symbol,
          interval: timeframe,
          totalLimit: safeKlineLimit,
          batchLimit: BINANCE_KLINE_BATCH_LIMIT,
        })
        : binanceRest.getKlines({
          symbol,
          interval: timeframe,
          limit: safeKlineLimit,
        });
      // FIX-2026-07-23: trend klines fetch พร้อมกัน (independent failure)
      const trendFetch = needsTrendKlines
        ? binanceRest.getKlines({
          symbol,
          interval: trendTF,
          limit: TREND_KLINE_LIMIT,
        }).catch((err) => {
          logger.warn({ symbol, trendTF, err: err.message }, 'volatility scan: trend klines fetch failed');
          return null;
        })
        : Promise.resolve(null);

      const [raw, rawTrend] = await Promise.all([mainFetch, trendFetch]);
      const klines = raw.map((k) => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
      }));
      const trendKlines = rawTrend
        ? rawTrend.map((k) => ({
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          closeTime: k[6],
        }))
        : null;
      return { symbol, klines, trendKlines, trendTF };
    } catch (err) {
      logger.warn({ symbol, err: err.message }, 'volatility scan: klines fetch failed');
      return { symbol, klines: null, error: err.message };
    }
  });

  if (needsPagination) {
    const fetchedOk = fetched.filter((f) => f.klines);
    const avgBars = fetchedOk.length
      ? Math.round(fetchedOk.reduce((s, f) => s + f.klines.length, 0) / fetchedOk.length)
      : 0;
    logger.info({
      safeKlineLimit, universeSize: universe.length, avgBars,
      batchesPerSymbol: Math.ceil(safeKlineLimit / BINANCE_KLINE_BATCH_LIMIT),
    }, 'volatility scan: paginated klines fetched');
  }

  // 4) Compute per-symbol stats (drop those without enough data)
  const stats = [];
  for (const r of fetched) {
    if (!r.klines || r.klines.length < effectiveWindow + 14) continue;
    const s = computeStats(r.symbol, r.klines, { window, tpWindow, threshold });
    s.trend = classifyTrend(r.klines, window);

    // FIX-2026-07-23: EMA20 trend (upper-TF) + suggested %TP
    const trend = computeTrend(r.trendKlines, r.trendTF);
    s.trendTF = trend.trendTF;
    s.trendEma20 = trend.trendEma20;
    s.trendLastClose = trend.trendLastClose;
    s.trendGapPct = trend.trendGapPct;
    s.trendState = trend.trendState; // 'upper' | 'lower' | 'warmup'
    s.tpWindow = tpWindow;
    // FIX-2026-07-25: TP net = gross - feeBuffer + formatTpToXxx1 (match suggest-tp route + tpUpdater)
    //   - gross: upper → minKC/4, lower → minKC/8, warmup → null
    //   - net: max(0, gross - feeBuffer) — เป็นค่าที่ user จะเห็นใน Get TP% button + auto-update
    //   - trader.calcSellPrice() จะ +2*feeRate กลับตอนวาง SELL → sell target = gross → net หลังหัก fee
    const feeRate = fees.getMakerRate();
    const feeBufferPct = Number((feeRate * 2 * 100).toFixed(4)); // 0.2 (off) หรือ 0.15 (BNB on)
    const rawTp = trend.trendState === 'warmup' || !s.kcMinPct
      ? null
      : (trend.trendState === 'upper' ? s.kcMinPct / 4 : s.kcMinPct / 8);
    s.suggestedTpGross = rawTp; // FIX-2026-07-25: เก็บ gross ด้วย (สำหรับ UI แสดง detail)
    s.feeBufferPct = feeBufferPct; // FIX-2026-07-25: เก็บ fee buffer ที่ใช้ (debug + UI)
    const netTp = rawTp == null ? null : Math.max(0, rawTp - feeBufferPct);
    s.suggestedTpPct = netTp == null ? null : formatTpToXxx1(netTp);

    stats.push(s);
  }

  // 5) Filter by minimum pct_bars_above_threshold AND selected trends, sort by score desc
  const ranked = stats
    .filter((s) => s.pctBarsAboveThreshold >= minPctBarsAbove)
    .filter((s) => trendSet.has(s.trend))
    .sort((a, b) => b.score - a.score);

  logger.info({
    universe: universe.length,
    fetchedOk: fetched.filter((f) => f.klines).length,
    computed: stats.length,
    ranked: ranked.length,
    window, tpWindow, trends: Array.from(trendSet),
  }, 'volatility scan: complete');

  return {
    universe,
    scanned: fetched.length,
    ranked,
    threshold,
    window,
    tpWindow,
  };
}

/**
 * Compute volatility stats for a single symbol's klines.
 *
 * Pure function — given klines, returns the same shape regardless of source.
 *
 * @param {string} symbol
 * @param {Array}  klines
 * @param {Object} opts
 * @param {number} opts.window    bars to use for volatility stats (avg_vol, max_vol, pct_bars_above)
 * @param {number} opts.tpWindow  FIX-2026-07-23: bars to use for kcMinPct (Min %KC for %TP แนะนำ)
 *                                — ค่า default 500 (ตรงกับ Get TP% endpoint)
 *                                — แยกจาก window เพราะ Min %KC ควรดู window ยาวกว่า
 *                                  เพื่อจับ squeeze ที่ลึก → TP ที่เหมาะสม
 * @param {number} opts.threshold vol_pct threshold in %
 */
function computeStats(symbol, klines, { window, tpWindow = 500, threshold }) {
  const slice = klines.slice(-window);

  // Per-bar vol_pct = (high - low) / low * 100
  const volPcts = slice.map((k) => (k.low > 0 ? ((k.high - k.low) / k.low) * 100 : 0));

  const sum = volPcts.reduce((acc, v) => acc + v, 0);
  const avgVol = volPcts.length ? sum / volPcts.length : 0;
  const maxVol = volPcts.length ? Math.max(...volPcts) : 0;
  const variance = volPcts.length
    ? volPcts.reduce((acc, v) => acc + (v - avgVol) ** 2, 0) / volPcts.length
    : 0;
  const volStd = Math.sqrt(variance);
  const barsAbove = volPcts.filter((v) => v > threshold).length;
  const pctBarsAboveThreshold = volPcts.length ? barsAbove / volPcts.length : 0;

  // ATR(14) — Wilder-smoothed. Use the FULL klines so the warmup uses real history.
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const closes = klines.map((k) => k.close);
  const atrSeries = atr(highs, lows, closes, 14);
  const lastAtr = atrSeries.length ? atrSeries[atrSeries.length - 1] : 0;
  const lastClose = closes[closes.length - 1] || 0;
  const currentAtrPct = lastClose > 0 ? (lastAtr / lastClose) * 100 : 0;

  // BBW(20, 2) — use full klines
  const bb = bollingerBands(closes, 20, 2);
  const currentBbw = bb.width.length ? (bb.width[bb.width.length - 1] || 0) : 0;

  // KC width % — Keltner Channel (period=20, mult=1.5)
  //   FIX-2026-07-23: kcMinPct = min ของ width over `tpWindow` bars (default 500)
  //                   kcMaxPct/kcAvgPct = min/max ของ width over `window` bars (default 20) — ใช้สำหรับ volatility stats
  //   - kcMinPct ต้องใช้ window ยาว เพื่อจับ squeeze ที่ลึก (ราคาเคยแคบมากๆ ในอดีต → TP ควรเล็ก)
  //   - kcMaxPct/kcAvgPct ใช้ window สั้น เพื่อบอก "ความเหวี่ยงปัจจุบัน" (window 20 bars = ~5h ที่ TF 15m)
  const kc = keltnerChannel(highs, lows, closes, 20, 1.5);
  const kcStartIdxTp = klines.length - tpWindow;
  const kcWidthsTp = [];
  for (let i = Math.max(0, kcStartIdxTp); i < klines.length; i += 1) {
    const w = kc.width[i];
    if (w != null && Number.isFinite(w)) kcWidthsTp.push(w);
  }
  const kcMinPct = kcWidthsTp.length ? Math.min(...kcWidthsTp) : 0;

  const kcStartIdxW = klines.length - window;
  const kcWidthsW = [];
  for (let i = Math.max(0, kcStartIdxW); i < klines.length; i += 1) {
    const w = kc.width[i];
    if (w != null && Number.isFinite(w)) kcWidthsW.push(w);
  }
  const kcMaxPct = kcWidthsW.length ? Math.max(...kcWidthsW) : 0;
  const kcAvgPct = kcWidthsW.length ? kcWidthsW.reduce((a, b) => a + b, 0) / kcWidthsW.length : 0;

  // Multi-factor score
  const safeThr = threshold > 0 ? threshold : 0.0001;
  const score = (
    0.4 * (avgVol / safeThr)
    + 0.3 * pctBarsAboveThreshold
    + 0.2 * (currentAtrPct / safeThr)
    + 0.1 * (maxVol / safeThr)
  );

  return {
    symbol,
    score,
    avgVol,
    maxVol,
    volStd,
    pctBarsAboveThreshold,
    currentAtrPct,
    currentBbw,
    kcMinPct,
    kcMaxPct,
    kcAvgPct,
    lastClose,
    lastVolume: klines[klines.length - 1].volume,
    windowBars: window,
  };
}

/**
 * Map over items with a concurrency limit. Returns an array of results
 * in the same order as the input.
 */
async function mapWithConcurrency(items, limit, mapper) {
  const out = new Array(items.length);
  if (items.length === 0) return out;
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      out[idx] = await mapper(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = {
  scanUniverse,
  computeStats,
  classifyTrend,
  computeTrend,
  mapWithConcurrency,
  VALID_TRENDS,
  TREND_TF_MAP,
};