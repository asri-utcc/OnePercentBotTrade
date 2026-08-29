'use strict';

/**
 * FIX-2026-08-21: Trade Analysis aggregations — used by /trade-analysis page
 *
 * Design principles:
 *   - All aggregates include trades from soft-deleted bots (ต่างจาก bot.totalTrades
 *     cumulative counter ที่ถูก filter ออกเมื่อ bot ถูก autoDeleteBot)
 *   - Source of truth = Trade collection (state='sold' + realizedPnl != null)
 *   - Single function `aggregateTradeAnalysis()` returns one big object — frontend
 *     renders it directly without doing more aggregation (saves dev time + bugs)
 *   - Each aggregation is independent + best-effort (failure in one section does
 *     not break the whole page — return partial data with `{ ok: false, error }` flag)
 *
 * Sections returned:
 *   - summary         — all-time totals (count/winRate/totalPnl/grossProfit/grossLoss/...)
 *   - bySymbol        — top symbols by trades + PnL + win rate
 *   - byTimeframe     — count/PnL/win rate per timeframe (1m,3m,5m,15m,1h,...)
 *   - bySellReason    — distribution of sellReason enum + per-reason PnL/win rate
 *   - byHour          — hour-of-day distribution (0..23) with PnL
 *   - byDayOfWeek     — Sun..Sat distribution with PnL
 *   - byMonth         — month bucket (YYYY-MM) with PnL + win rate + equity curve
 *   - byDay           — daily timeseries (YYYY-MM-DD) — for sparkline
 *   - byBot           — top performers + top losers (incl. deleted bots)
 *   - duration        — buy-to-sell hold time buckets + avg
 *   - sizing          — capital (notional) distribution + total volume
 *   - streaks         — current/best/longest win & loss streaks
 *   - dcaVsNonDca     — DCA stack vs single-trade breakdown
 *   - extremes        — biggest win, biggest loss, best day, worst day
 *   - derived         — profit factor / expectancy / avg win vs avg loss ratio / Sharpe-lite
 *   - conclusion      — text conclusions + recommendations for the user (Thai-friendly)
 *   - meta            — asOf timestamp + firstTradeAt + lastTradeAt + activeBotCount
 */

const mongoose = require('mongoose');
const Trade = require('../db/models/Trade');
const Bot = require('../db/models/Bot');

const SELL_REASON_LABELS = {
  tp_hit: 'TP Hit',
  tp_trend_boosted: 'TP Boosted',
  dca_target_hit: 'DCA TP Hit',
  sl_ukc_f1_armed: 'SL-UKC (F1 armed)',
  sl_ukc_manual: 'SL-UKC (manual)',
  stop_loss_upper_kc: 'SL-UKC (legacy)',
  dca_stack_stop_loss: 'DCA SL-UKC',
  cb_panic: 'CB Panic',
  cbv2_panic: 'CBv2 Panic',
  cbv3_panic: 'CBv3 Panic',
  cbv5_panic: 'CBv5 Panic',
  market_fallback: 'Market Fallback',
  race_recovery_filled: 'Race Recovery',
  holding_retry_recovered: 'Holding Retry',
  holding_retry_exhausted: 'Holding Retry (x)',
  partial_sell_finalized: 'Partial-Sell Frozen',
  manual_api_force_close_trade: 'Manual API (single)',
  manual_api_force_close_bot: 'Manual API (bot)',
  manual_api_watchdog: 'Manual Watchdog',
  manual_api_cleanup_script: 'Manual Cleanup',
  manual_api_market: 'Manual Market',
  manual_api_synthetic: 'Manual Synthetic',
  dca_stack_force_close: 'DCA Stack Close',
  bot_disabled: 'Bot Disabled',
  unknown: 'Unknown',
};

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => `${i}:00`);

// ─── Helpers ────────────────────────────────────────────
function safeDivide(a, b, fallback = 0) {
  if (!b || !Number.isFinite(b)) return fallback;
  const r = a / b;
  return Number.isFinite(r) ? r : fallback;
}

function fmtPct(v) {
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(2));
}

function summarizePnl(rows) {
  // rows = [{ realizedPnl, ... }]
  let pnl = 0, grossProfit = 0, grossLoss = 0, wins = 0, losses = 0, breakeven = 0;
  for (const r of rows) {
    const v = Number(r.realizedPnl) || 0;
    pnl += v;
    if (v > 0) { grossProfit += v; wins += 1; }
    else if (v < 0) { grossLoss += v; losses += 1; }
    else breakeven += 1;
  }
  const total = wins + losses + breakeven;
  return { pnl: Number(pnl.toFixed(4)), grossProfit: Number(grossProfit.toFixed(4)), grossLoss: Number(grossLoss.toFixed(4)), wins, losses, breakeven, count: total, winRate: total ? fmtPct((wins / total) * 100) : 0 };
}

async function fetchAllSoldTrades({ since = null } = {}) {
  // Lean cursor over state='sold' + realizedPnl != null (mirror tradeStats.aggregateAllTimeGlobal)
  // We stream the docs because we want per-trade analysis (not just sums)
  //   - for very large DB (>50k trades) consider sampling or moving to map-reduce
  //   - current realistic size is 1k–5k trades → safe to materialize in memory
  const q = { state: 'sold', realizedPnl: { $ne: null } };
  if (since) q.sellFilledAt = { $gte: since };
  const cursor = Trade.find(q)
    .select('_id botId symbol timeframe realizedPnl pnlPercent sellFilledAt buyFilledAt buyPrice sellAvgPrice sellPrice buyQuoteQty buyQty sellQty sellFilledQty sellReason sellReasonDetail sellReasonAt isDcaStack dcaLayerCount stackTotalQty stackTotalSpent stackBep buyFee sellFee retryCount')
    .lean()
    .cursor({ batchSize: 500 });
  const out = [];
  for await (const t of cursor) out.push(t);
  return out;
}

// ─── Section builders ──────────────────────────────────

function buildSummary(trades) {
  const s = summarizePnl(trades);
  const totalNotional = trades.reduce((a, t) => a + (Number(t.buyQuoteQty) || 0), 0);
  const totalBuyFee = trades.reduce((a, t) => a + (Number(t.buyFee) || 0), 0);
  const totalSellFee = trades.reduce((a, t) => a + (Number(t.sellFee) || 0), 0);
  const pnls = trades.map((t) => Number(t.realizedPnl) || 0).filter(Number.isFinite);
  pnls.sort((a, b) => a - b);
  const median = pnls.length ? pnls[Math.floor(pnls.length / 2)] : 0;
  const sumAbs = trades.reduce((a, t) => a + Math.abs(Number(t.realizedPnl) || 0), 0);
  const pnlsSorted = pnls.slice();
  const n = pnlsSorted.length;
  const variance = n > 1 ? pnlsSorted.reduce((a, v) => a + Math.pow(v - s.pnl / n, 2), 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  // Compute avgWin / avgLoss into locals so expectancy can reuse them (avoid {...s} override confusion)
  const avgWin = s.wins ? Number((s.grossProfit / s.wins).toFixed(4)) : 0;
  const avgLoss = s.losses ? Number((s.grossLoss / s.losses).toFixed(4)) : 0;
  const lossRate = s.count ? (s.losses / s.count) : 0;
  // expectancy per trade = (winRate * avgWin) - (lossRate * |avgLoss|)
  const expectancy = s.count
    ? Number(((s.winRate / 100) * avgWin - lossRate * Math.abs(avgLoss)).toFixed(4))
    : 0;
  return {
    ...s,
    totalNotional: Number(totalNotional.toFixed(2)),
    totalBuyFee: Number(totalBuyFee.toFixed(4)),
    totalSellFee: Number(totalSellFee.toFixed(4)),
    totalFees: Number((totalBuyFee + totalSellFee).toFixed(4)),
    avgPnl: s.count ? Number((s.pnl / s.count).toFixed(4)) : 0,
    avgWin,
    avgLoss,
    medianPnl: Number(median.toFixed(4)),
    stddevPnl: Number(stddev.toFixed(4)),
    profitFactor: sumAbs ? Number((s.grossProfit / Math.abs(s.grossLoss || 1)).toFixed(2)) : 0,
    expectancy,
    pnlPerUsdtNotional: totalNotional ? Number(((s.pnl / totalNotional) * 100).toFixed(3)) : 0,
  };
}

function buildBySymbol(trades) {
  const map = new Map();
  for (const t of trades) {
    const k = t.symbol || '?';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  const rows = [];
  for (const [symbol, items] of map.entries()) {
    const s = summarizePnl(items);
    const notional = items.reduce((a, t) => a + (Number(t.buyQuoteQty) || 0), 0);
    rows.push({
      symbol,
      count: s.count,
      wins: s.wins,
      losses: s.losses,
      pnl: s.pnl,
      grossProfit: s.grossProfit,
      grossLoss: s.grossLoss,
      winRate: s.winRate,
      notional: Number(notional.toFixed(2)),
      avgPnl: s.count ? Number((s.pnl / s.count).toFixed(4)) : 0,
    });
  }
  rows.sort((a, b) => b.pnl - a.pnl);
  return {
    best: rows.filter((r) => r.count > 0).slice(0, 10),
    worst: rows.filter((r) => r.count > 0).slice(-10).reverse(),
    all: rows,
    uniqueCount: rows.length,
  };
}

function buildByTimeframe(trades) {
  const map = new Map();
  for (const t of trades) {
    const k = t.timeframe || '?';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  const rows = [];
  for (const [tf, items] of map.entries()) {
    const s = summarizePnl(items);
    rows.push({ timeframe: tf, count: s.count, wins: s.wins, losses: s.losses, pnl: s.pnl, grossProfit: s.grossProfit, grossLoss: s.grossLoss, winRate: s.winRate });
  }
  // Sort by canonical order (1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 1d, 1w)
  const tfOrder = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'];
  rows.sort((a, b) => {
    const ai = tfOrder.indexOf(a.timeframe);
    const bi = tfOrder.indexOf(b.timeframe);
    if (ai === -1 && bi === -1) return a.timeframe.localeCompare(b.timeframe);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return rows;
}

function buildBySellReason(trades) {
  const map = new Map();
  for (const t of trades) {
    const k = t.sellReason || 'unknown';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  const rows = [];
  for (const [reason, items] of map.entries()) {
    const s = summarizePnl(items);
    rows.push({
      reason,
      label: SELL_REASON_LABELS[reason] || reason,
      count: s.count,
      wins: s.wins,
      losses: s.losses,
      pnl: s.pnl,
      grossProfit: s.grossProfit,
      grossLoss: s.grossLoss,
      winRate: s.winRate,
    });
  }
  rows.sort((a, b) => b.count - a.count);
  // group into "categories" for the conclusion
  const tpLike = ['tp_hit', 'tp_trend_boosted', 'dca_target_hit'];
  const slLike = ['sl_ukc_f1_armed', 'sl_ukc_manual', 'stop_loss_upper_kc', 'dca_stack_stop_loss'];
  const cbLike = ['cb_panic', 'cbv2_panic', 'cbv3_panic', 'cbv5_panic'];
  const manualLike = ['manual_api_force_close_trade', 'manual_api_force_close_bot', 'manual_api_watchdog', 'manual_api_cleanup_script', 'manual_api_market', 'manual_api_synthetic', 'bot_disabled', 'dca_stack_force_close'];
  const otherLike = ['market_fallback', 'race_recovery_filled', 'holding_retry_recovered', 'holding_retry_exhausted', 'partial_sell_finalized', 'unknown'];

  function aggCats(keys) {
    const subset = rows.filter((r) => keys.includes(r.reason));
    const cat = summarizePnl(subset.map((r) => ({ realizedPnl: r.pnl, wins: r.wins, losses: r.losses })));
    // NOTE: summarizePnl signature expects rows with realizedPnl — here we re-aggregate
    // from the reason rows' pnl to keep the helper consistent.
    const totalPnl = subset.reduce((a, r) => a + r.pnl, 0);
    const totalWins = subset.reduce((a, r) => a + r.wins, 0);
    const totalLosses = subset.reduce((a, r) => a + r.losses, 0);
    const totalCount = subset.reduce((a, r) => a + r.count, 0);
    return {
      count: totalCount,
      wins: totalWins,
      losses: totalLosses,
      pnl: Number(totalPnl.toFixed(4)),
      winRate: totalCount ? fmtPct((totalWins / totalCount) * 100) : 0,
    };
  }

  return {
    rows,
    categories: {
      tp: aggCats(tpLike),
      sl: aggCats(slLike),
      cb: aggCats(cbLike),
      manual: aggCats(manualLike),
      other: aggCats(otherLike),
    },
  };
}

function buildByHour(trades) {
  const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, label: HOUR_LABELS[h], count: 0, wins: 0, losses: 0, pnl: 0 }));
  // FIX-2026-08-29: also build the (dow × hour) CROSS-CUT matrix for the heatmap
  // so the frontend doesn't need to do an independence approximation. Each cell is
  // { pnl, count, wins, losses } — count/wins/losses enable density-based shading later.
  const matrix = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ pnl: 0, count: 0, wins: 0, losses: 0 })));
  for (const t of trades) {
    if (!t.sellFilledAt) continue;
    const d = new Date(t.sellFilledAt).getDay();
    const h = new Date(t.sellFilledAt).getHours();
    const v = Number(t.realizedPnl) || 0;
    buckets[h].count += 1;
    buckets[h].pnl = Number((buckets[h].pnl + v).toFixed(4));
    if (v > 0) buckets[h].wins += 1;
    else if (v < 0) buckets[h].losses += 1;
    // Cross-cut
    matrix[d][h].count += 1;
    matrix[d][h].pnl = Number((matrix[d][h].pnl + v).toFixed(4));
    if (v > 0) matrix[d][h].wins += 1;
    else if (v < 0) matrix[d][h].losses += 1;
  }
  buckets.matrix = matrix;
  return buckets;
}

function buildByDayOfWeek(trades) {
  const buckets = DOW_LABELS.map((label, i) => ({ dayIndex: i, label, count: 0, wins: 0, losses: 0, pnl: 0 }));
  for (const t of trades) {
    if (!t.sellFilledAt) continue;
    const d = new Date(t.sellFilledAt).getDay();
    const v = Number(t.realizedPnl) || 0;
    buckets[d].count += 1;
    buckets[d].pnl = Number((buckets[d].pnl + v).toFixed(4));
    if (v > 0) buckets[d].wins += 1;
    else if (v < 0) buckets[d].losses += 1;
  }
  return buckets;
}

function buildByDay(trades) {
  const map = new Map();
  for (const t of trades) {
    if (!t.sellFilledAt) continue;
    const k = new Date(t.sellFilledAt).toISOString().slice(0, 10); // YYYY-MM-DD
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  const rows = [];
  for (const [date, items] of map.entries()) {
    const s = summarizePnl(items);
    rows.push({ date, count: s.count, wins: s.wins, losses: s.losses, pnl: s.pnl, winRate: s.winRate });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

function buildByMonth(trades) {
  const map = new Map();
  for (const t of trades) {
    if (!t.sellFilledAt) continue;
    const k = new Date(t.sellFilledAt).toISOString().slice(0, 7); // YYYY-MM
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  const rows = [];
  for (const [month, items] of map.entries()) {
    const s = summarizePnl(items);
    rows.push({ month, count: s.count, wins: s.wins, losses: s.losses, pnl: s.pnl, grossProfit: s.grossProfit, grossLoss: s.grossLoss, winRate: s.winRate });
  }
  rows.sort((a, b) => a.month.localeCompare(b.month));
  return rows;
}

async function buildByBot(trades) {
  const botMap = new Map();
  for (const t of trades) {
    const k = String(t.botId);
    if (!botMap.has(k)) botMap.set(k, []);
    botMap.get(k).push(t);
  }
  const botIds = [...botMap.keys()];
  // include deleted bots (no filter on deletedAt) + extra fields needed for optimal-config correlation
  const bots = await Bot.find({ _id: { $in: botIds.map((id) => new mongoose.Types.ObjectId(id)) } })
    .select('_id name symbol timeframe deletedAt capitalPerTrade maxTrades kcMult tpPercent safeTradeEnabled safeTradeTrendlineEnabled safeTradeNoTradeEnabled cbEnabled cbv2Enabled cbv3Enabled cbv5Enabled dynamicSizeEnabled xs1Enabled')
    .lean();
  const botInfo = Object.fromEntries(bots.map((b) => [String(b._id), b]));
  const rows = [];
  for (const [botId, items] of botMap.entries()) {
    const s = summarizePnl(items);
    const info = botInfo[botId] || {};
    const notional = items.reduce((a, t) => a + (Number(t.buyQuoteQty) || 0), 0);
    rows.push({
      botId,
      name: info.name || '(unnamed)',
      symbol: info.symbol || items[0]?.symbol || '?',
      timeframe: info.timeframe || items[0]?.timeframe || '?',
      deletedAt: info.deletedAt || null,
      isDeleted: !!info.deletedAt,
      // 2026-08-21: expose bot config snapshot for optimal-config analysis (frontend + correlation)
      //   - "current" config (not point-in-time) — close enough for an analysis page
      kcMult: info.kcMult ?? null,
      tpPercent: info.tpPercent ?? null,
      safeTradeEnabled: info.safeTradeEnabled !== false, // default ON
      safeTradeTrendlineEnabled: info.safeTradeTrendlineEnabled === true,
      safeTradeNoTradeEnabled: info.safeTradeNoTradeEnabled === true,
      cbEnabled: info.cbEnabled !== false,
      cbv2Enabled: info.cbv2Enabled !== false,
      cbv3Enabled: info.cbv3Enabled !== false,
      cbv5Enabled: info.cbv5Enabled !== false,
      dynamicSizeEnabled: info.dynamicSizeEnabled !== false,
      xs1Enabled: info.xs1Enabled !== false,
      count: s.count,
      wins: s.wins,
      losses: s.losses,
      pnl: s.pnl,
      grossProfit: s.grossProfit,
      grossLoss: s.grossLoss,
      winRate: s.winRate,
      notional: Number(notional.toFixed(2)),
    });
  }
  rows.sort((a, b) => b.pnl - a.pnl);
  return {
    best: rows.filter((r) => r.count > 0).slice(0, 10),
    worst: rows.filter((r) => r.count > 0).slice(-10).reverse(),
    all: rows,
    totalBots: rows.length,
    activeBots: rows.filter((r) => !r.isDeleted).length,
    deletedBots: rows.filter((r) => r.isDeleted).length,
  };
}

function buildDuration(trades) {
  // Buy→Sell hold time buckets: <1m, 1-5m, 5-15m, 15-60m, 1-4h, 4-24h, >24h
  const buckets = [
    { label: '<1m', minMs: 0, maxMs: 60_000, count: 0, wins: 0, losses: 0, pnl: 0 },
    { label: '1-5m', minMs: 60_000, maxMs: 5 * 60_000, count: 0, wins: 0, losses: 0, pnl: 0 },
    { label: '5-15m', minMs: 5 * 60_000, maxMs: 15 * 60_000, count: 0, wins: 0, losses: 0, pnl: 0 },
    { label: '15-60m', minMs: 15 * 60_000, maxMs: 60 * 60_000, count: 0, wins: 0, losses: 0, pnl: 0 },
    { label: '1-4h', minMs: 60 * 60_000, maxMs: 4 * 60 * 60_000, count: 0, wins: 0, losses: 0, pnl: 0 },
    { label: '4-24h', minMs: 4 * 60 * 60_000, maxMs: 24 * 60 * 60_000, count: 0, wins: 0, losses: 0, pnl: 0 },
    { label: '>24h', minMs: 24 * 60 * 60_000, maxMs: Infinity, count: 0, wins: 0, losses: 0, pnl: 0 },
  ];
  let totalMs = 0, count = 0;
  for (const t of trades) {
    if (!t.buyFilledAt || !t.sellFilledAt) continue;
    const ms = new Date(t.sellFilledAt) - new Date(t.buyFilledAt);
    if (!Number.isFinite(ms) || ms < 0) continue;
    totalMs += ms;
    count += 1;
    for (const b of buckets) {
      if (ms >= b.minMs && ms < b.maxMs) {
        b.count += 1;
        const v = Number(t.realizedPnl) || 0;
        b.pnl = Number((b.pnl + v).toFixed(4));
        if (v > 0) b.wins += 1;
        else if (v < 0) b.losses += 1;
        break;
      }
    }
  }
  const avgMs = count ? Math.round(totalMs / count) : 0;
  return {
    avgHoldMs: avgMs,
    avgHoldLabel: count ? humanizeMs(avgMs) : '—',
    count,
    buckets,
  };
}

function humanizeMs(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function buildSizing(trades) {
  let totalNotional = 0, totalQty = 0, minNotional = Infinity, maxNotional = 0;
  const buckets = [
    { label: '<10', min: 0, max: 10, count: 0 },
    { label: '10-25', min: 10, max: 25, count: 0 },
    { label: '25-50', min: 25, max: 50, count: 0 },
    { label: '50-100', min: 50, max: 100, count: 0 },
    { label: '100-250', min: 100, max: 250, count: 0 },
    { label: '>250', min: 250, max: Infinity, count: 0 },
  ];
  for (const t of trades) {
    const n = Number(t.buyQuoteQty) || 0;
    const q = Number(t.buyQty) || 0;
    if (n > 0) {
      totalNotional += n;
      totalQty += q;
      if (n < minNotional) minNotional = n;
      if (n > maxNotional) maxNotional = n;
      for (const b of buckets) {
        if (n >= b.min && n < b.max) { b.count += 1; break; }
      }
    }
  }
  return {
    totalNotional: Number(totalNotional.toFixed(2)),
    totalQty: Number(totalQty.toFixed(6)),
    avgNotional: trades.length ? Number((totalNotional / trades.length).toFixed(2)) : 0,
    minNotional: minNotional === Infinity ? 0 : Number(minNotional.toFixed(2)),
    maxNotional: Number(maxNotional.toFixed(2)),
    buckets,
  };
}

function buildStreaks(trades) {
  // Sort ascending by sellFilledAt for chronological streak detection
  const sorted = trades
    .filter((t) => t.sellFilledAt)
    .slice()
    .sort((a, b) => new Date(a.sellFilledAt) - new Date(b.sellFilledAt));
  let curWin = 0, curLoss = 0, bestWin = 0, bestLoss = 0, totalWins = 0, totalLosses = 0;
  for (const t of sorted) {
    const v = Number(t.realizedPnl) || 0;
    if (v > 0) { curWin += 1; curLoss = 0; totalWins += 1; bestWin = Math.max(bestWin, curWin); }
    else if (v < 0) { curLoss += 1; curWin = 0; totalLosses += 1; bestLoss = Math.max(bestLoss, curLoss); }
  }
  return {
    currentWinStreak: curWin,
    currentLossStreak: curLoss,
    bestWinStreak: bestWin,
    bestLossStreak: bestLoss,
    totalWinningTrades: totalWins,
    totalLosingTrades: totalLosses,
  };
}

function buildDcaVsNonDca(trades) {
  const dca = trades.filter((t) => t.isDcaStack === true);
  const nonDca = trades.filter((t) => !t.isDcaStack);
  const s1 = summarizePnl(dca);
  const s2 = summarizePnl(nonDca);
  return {
    dca: { count: s1.count, wins: s1.wins, losses: s1.losses, pnl: s1.pnl, grossProfit: s1.grossProfit, grossLoss: s1.grossLoss, winRate: s1.winRate },
    nonDca: { count: s2.count, wins: s2.wins, losses: s2.losses, pnl: s2.pnl, grossProfit: s2.grossProfit, grossLoss: s2.grossLoss, winRate: s2.winRate },
  };
}

function buildExtremes(trades) {
  if (!trades.length) {
    return { biggestWin: null, biggestLoss: null, bestDay: null, worstDay: null };
  }
  let biggestWin = trades[0], biggestLoss = trades[0];
  for (const t of trades) {
    if ((Number(t.realizedPnl) || 0) > (Number(biggestWin.realizedPnl) || 0)) biggestWin = t;
    if ((Number(t.realizedPnl) || 0) < (Number(biggestLoss.realizedPnl) || 0)) biggestLoss = t;
  }
  const dayMap = buildByDay(trades);
  const dayWithPnl = dayMap.filter((d) => d.count > 0);
  const bestDay = dayWithPnl.length ? dayWithPnl.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null;
  const worstDay = dayWithPnl.length ? dayWithPnl.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null;
  return {
    biggestWin: { tradeId: biggestWin._id, symbol: biggestWin.symbol, botId: biggestWin.botId, pnl: Number(biggestWin.realizedPnl) || 0, sellFilledAt: biggestWin.sellFilledAt, sellReason: biggestWin.sellReason },
    biggestLoss: { tradeId: biggestLoss._id, symbol: biggestLoss.symbol, botId: biggestLoss.botId, pnl: Number(biggestLoss.realizedPnl) || 0, sellFilledAt: biggestLoss.sellFilledAt, sellReason: biggestLoss.sellReason },
    bestDay: bestDay ? { date: bestDay.date, pnl: bestDay.pnl, trades: bestDay.count } : null,
    worstDay: worstDay ? { date: worstDay.date, pnl: worstDay.pnl, trades: worstDay.count } : null,
  };
}

function buildDerived(summary, byMonth) {
  // Sharpe-lite (annualized) — only meaningful if we have enough monthly buckets
  const months = byMonth.filter((m) => m.count > 0);
  if (months.length < 2) {
    return { sharpeLite: 0, monthlyMean: 0, monthlyStddev: 0, maxDrawdownEstimate: 0 };
  }
  const rets = months.map((m) => m.pnl);
  const mean = rets.reduce((a, v) => a + v, 0) / rets.length;
  const variance = rets.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / rets.length;
  const stddev = Math.sqrt(variance);
  // Equity curve → max drawdown
  let peak = 0, dd = 0, equity = 0;
  for (const m of months) {
    equity += m.pnl;
    if (equity > peak) peak = equity;
    const cur = peak - equity;
    if (cur > dd) dd = cur;
  }
  return {
    sharpeLite: stddev > 0 ? Number(((mean / stddev) * Math.sqrt(12)).toFixed(2)) : 0,
    monthlyMean: Number(mean.toFixed(4)),
    monthlyStddev: Number(stddev.toFixed(4)),
    maxDrawdownEstimate: Number(dd.toFixed(4)),
    bestMonth: months.length ? months.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null,
    worstMonth: months.length ? months.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// FIX-2026-08-21: Position Analysis — deeper dive into hold-time × profit
//   - Identifies "scalps vs swing" behavior, fastest/longest profitable trades
//   - Used by Trade Analysis page (section: ⏳ Hold Time vs Profit)
// ════════════════════════════════════════════════════════════════════════════

function bucketForMs(ms) {
  if (ms < 60_000) return 0;
  if (ms < 5 * 60_000) return 1;
  if (ms < 15 * 60_000) return 2;
  if (ms < 60 * 60_000) return 3;
  if (ms < 4 * 60 * 60_000) return 4;
  if (ms < 24 * 60 * 60_000) return 5;
  return 6;
}

const HOLD_BUCKETS_DEF = [
  { label: '<1m',    minMs: 0,                 maxMs: 60_000 },
  { label: '1-5m',   minMs: 60_000,            maxMs: 5 * 60_000 },
  { label: '5-15m',  minMs: 5 * 60_000,        maxMs: 15 * 60_000 },
  { label: '15-60m', minMs: 15 * 60_000,       maxMs: 60 * 60_000 },
  { label: '1-4h',   minMs: 60 * 60_000,       maxMs: 4 * 60 * 60_000 },
  { label: '4-24h',  minMs: 4 * 60 * 60_000,   maxMs: 24 * 60 * 60_000 },
  { label: '>24h',   minMs: 24 * 60 * 60_000,  maxMs: Infinity },
];

function buildHoldVsProfit(trades) {
  // per-bucket stats + per-trade hold time + extremes
  const buckets = HOLD_BUCKETS_DEF.map((b) => ({
    label: b.label,
    minMs: b.minMs,
    maxMs: b.maxMs,
    count: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    avgPnl: 0,
    avgHoldMs: 0,
    winRate: 0,
  }));
  let totalHoldMs = 0, holdCount = 0;
  let winHoldMs = 0, winCount = 0;
  let lossHoldMs = 0, lossCount = 0;
  // extremes
  let longestOverall = null;
  let longestProfitable = null;
  let shortestProfitable = null;
  let fastestProfit = null; // shortest hold that was profitable (already covered by shortestProfitable, kept for clarity)
  let biggestProfitHoldMs = null;
  let biggestLossHoldMs = null;
  let fastestLoss = null;

  for (const t of trades) {
    if (!t.buyFilledAt || !t.sellFilledAt) continue;
    const ms = new Date(t.sellFilledAt) - new Date(t.buyFilledAt);
    if (!Number.isFinite(ms) || ms < 0) continue;
    const pnl = Number(t.realizedPnl) || 0;
    totalHoldMs += ms;
    holdCount += 1;
    const bi = bucketForMs(ms);
    const b = buckets[bi];
    b.count += 1;
    b.pnl = Number((b.pnl + pnl).toFixed(4));
    if (pnl > 0) { b.wins += 1; winHoldMs += ms; winCount += 1; }
    else if (pnl < 0) { b.losses += 1; lossHoldMs += ms; lossCount += 1; }

    // extremes
    if (!longestOverall || ms > longestOverall.ms) {
      longestOverall = { tradeId: t._id, symbol: t.symbol, botId: t.botId, ms, pnl, sellReason: t.sellReason, sellFilledAt: t.sellFilledAt };
    }
    if (pnl > 0) {
      if (!longestProfitable || ms > longestProfitable.ms) {
        longestProfitable = { tradeId: t._id, symbol: t.symbol, botId: t.botId, ms, pnl, sellReason: t.sellReason, sellFilledAt: t.sellFilledAt };
      }
      if (!shortestProfitable || ms < shortestProfitable.ms) {
        shortestProfitable = { tradeId: t._id, symbol: t.symbol, botId: t.botId, ms, pnl, sellReason: t.sellReason, sellFilledAt: t.sellFilledAt };
      }
      if (!biggestProfitHoldMs || pnl > biggestProfitHoldMs.pnl) {
        biggestProfitHoldMs = { tradeId: t._id, symbol: t.symbol, botId: t.botId, ms, pnl, sellReason: t.sellReason, sellFilledAt: t.sellFilledAt };
      }
    } else if (pnl < 0) {
      if (!biggestLossHoldMs || pnl < biggestLossHoldMs.pnl) {
        biggestLossHoldMs = { tradeId: t._id, symbol: t.symbol, botId: t.botId, ms, pnl, sellReason: t.sellReason, sellFilledAt: t.sellFilledAt };
      }
      if (!fastestLoss || ms < fastestLoss.ms) {
        fastestLoss = { tradeId: t._id, symbol: t.symbol, botId: t.botId, ms, pnl, sellReason: t.sellReason, sellFilledAt: t.sellFilledAt };
      }
    }
  }

  // finalize bucket stats
  for (const b of buckets) {
    if (b.count > 0) {
      // recompute avgHold for bucket from individual trades is more accurate but costly — we use bucket midpoint approximation
      b.avgHoldMs = Math.round((b.minMs + (Number.isFinite(b.maxMs) ? b.maxMs : b.minMs + 24 * 60 * 60_000)) / 2);
      b.avgPnl = Number((b.pnl / b.count).toFixed(4));
      b.winRate = Number(((b.wins / b.count) * 100).toFixed(2));
    }
  }

  return {
    avgHoldMs: holdCount ? Math.round(totalHoldMs / holdCount) : 0,
    avgHoldLabel: holdCount ? humanizeMs(Math.round(totalHoldMs / holdCount)) : '—',
    avgHoldWinningMs: winCount ? Math.round(winHoldMs / winCount) : 0,
    avgHoldWinningLabel: winCount ? humanizeMs(Math.round(winHoldMs / winCount)) : '—',
    avgHoldLosingMs: lossCount ? Math.round(lossHoldMs / lossCount) : 0,
    avgHoldLosingLabel: lossCount ? humanizeMs(Math.round(lossHoldMs / lossCount)) : '—',
    count: holdCount,
    buckets,
    longestOverall,
    longestProfitable,
    shortestProfitable,
    fastestProfit: shortestProfitable,
    biggestProfitHoldMs,
    biggestLossHoldMs,
    fastestLoss,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// FIX-2026-08-21: TP / SL Deep Dive — per-reason deep statistics
//   - TP fills: count / avg profit / min / max / avg hold / hold at max profit
//   - SL fills: count / avg loss / min loss / max loss / avg hold / hold at max loss
//   - CB + Manual mirrors for cross-reason comparison
// ════════════════════════════════════════════════════════════════════════════

function buildTpSlDeep(trades) {
  const TP_REASONS = ['tp_hit', 'tp_trend_boosted', 'dca_target_hit'];
  const SL_REASONS = ['sl_ukc_f1_armed', 'sl_ukc_manual', 'stop_loss_upper_kc', 'dca_stack_stop_loss'];
  const CB_REASONS = ['cb_panic', 'cbv2_panic', 'cbv3_panic', 'cbv5_panic'];
  const MANUAL_REASONS = ['manual_api_force_close_trade', 'manual_api_force_close_bot', 'manual_api_watchdog', 'manual_api_cleanup_script', 'manual_api_market', 'manual_api_synthetic', 'bot_disabled', 'dca_stack_force_close'];

  function summarizeReasons(reasons, { side }) {
    const subset = trades.filter((t) => reasons.includes(t.sellReason));
    if (!subset.length) {
      return {
        count: 0, totalPnl: 0, winRate: 0,
        avgPnl: 0, minPnl: 0, maxPnl: 0,
        avgHoldMs: 0, avgHoldLabel: '—',
        maxHoldAtExtreme: 0,
        extreme: null,
      };
    }
    let totalPnl = 0, totalHold = 0, countWithHold = 0;
    let minPnl = Infinity, maxPnl = -Infinity;
    let minT = subset[0], maxT = subset[0];
    let maxHoldT = subset[0];
    for (const t of subset) {
      const pnl = Number(t.realizedPnl) || 0;
      totalPnl += pnl;
      if (pnl < minPnl) { minPnl = pnl; minT = t; }
      if (pnl > maxPnl) { maxPnl = pnl; maxT = t; }
      if (t.buyFilledAt && t.sellFilledAt) {
        const ms = new Date(t.sellFilledAt) - new Date(t.buyFilledAt);
        if (Number.isFinite(ms) && ms >= 0) {
          totalHold += ms;
          countWithHold += 1;
          if (!maxHoldT || ms > (new Date(maxHoldT.sellFilledAt) - new Date(maxHoldT.buyFilledAt))) {
            maxHoldT = t;
          }
        }
      }
    }
    const wins = subset.filter((t) => (Number(t.realizedPnl) || 0) > 0).length;
    const avgHold = countWithHold ? Math.round(totalHold / countWithHold) : 0;
    const maxHoldMs = maxHoldT && maxHoldT.buyFilledAt && maxHoldT.sellFilledAt
      ? new Date(maxHoldT.sellFilledAt) - new Date(maxHoldT.buyFilledAt)
      : 0;
    const extreme = side === 'profit' ? maxT : minT;
    return {
      count: subset.length,
      totalPnl: Number(totalPnl.toFixed(4)),
      winRate: Number(((wins / subset.length) * 100).toFixed(2)),
      avgPnl: Number((totalPnl / subset.length).toFixed(4)),
      minPnl: Number(minPnl.toFixed(4)),
      maxPnl: Number(maxPnl.toFixed(4)),
      avgHoldMs: avgHold,
      avgHoldLabel: countWithHold ? humanizeMs(avgHold) : '—',
      maxHoldAtExtreme: maxHoldMs,
      maxHoldAtExtremeLabel: maxHoldMs ? humanizeMs(maxHoldMs) : '—',
      extreme: extreme ? {
        tradeId: extreme._id,
        symbol: extreme.symbol,
        botId: extreme.botId,
        pnl: Number(extreme.realizedPnl) || 0,
        ms: maxHoldMs,
          sellReason: extreme.sellReason,
          sellFilledAt: extreme.sellFilledAt,
        } : null,
    };
  }

  return {
    tp: summarizeReasons(TP_REASONS, { side: 'profit' }),
    sl: summarizeReasons(SL_REASONS, { side: 'loss' }),
    cb: summarizeReasons(CB_REASONS, { side: 'loss' }),
    manual: summarizeReasons(MANUAL_REASONS, { side: 'loss' }),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// FIX-2026-08-21: Optimal Config Finder — correlation analysis
//   - Group trades by (timeframe + TP% bucket + kcMult bucket + safe-trade combo + CB combo)
//   - Compute composite score: high avgPnl × high winRate / short avgHoldMs
//   - Surface top-N "recipes" + worst-N to avoid
//   - Goal: identify bot configs with low loss probability, short hold time, high profit
// ════════════════════════════════════════════════════════════════════════════

function bucketTpPct(v) {
  if (v == null) return '?';
  if (v <= 0.3) return '≤0.3%';
  if (v <= 0.5) return '0.3-0.5%';
  if (v <= 0.8) return '0.5-0.8%';
  if (v <= 1.2) return '0.8-1.2%';
  if (v <= 2.0) return '1.2-2.0%';
  return '>2%';
}
function bucketKcMult(v) {
  if (v == null) return '?';
  if (v <= 1.0) return '≤1.0';
  if (v <= 1.5) return '1.0-1.5';
  if (v <= 2.0) return '1.5-2.0';
  if (v <= 2.5) return '2.0-2.5';
  return '>2.5';
}
function safeTradeLabel(b) {
  // represent safe-trade filter combination as compact label
  const parts = [];
  if (b.safeTradeEnabled !== false) parts.push('ST1');
  if (b.safeTradeTrendlineEnabled) parts.push('ST2');
  if (b.safeTradeNoTradeEnabled) parts.push('ST3');
  if (parts.length === 0) return 'none';
  return parts.join('+');
}
function cbLabel(b) {
  const on = [];
  if (b.cbEnabled !== false) on.push('CB');
  if (b.cbv2Enabled !== false) on.push('CBv2');
  if (b.cbv3Enabled !== false) on.push('CBv3');
  if (b.cbv5Enabled !== false) on.push('CBv5');
  return on.join('+') || 'off';
}

async function buildOptimalConfigs(trades, byBot) {
  // Build botId → config lookup from byBot.all (which now has kcMult, tpPercent, safeTrade*, cb*)
  const botCfg = Object.fromEntries((byBot?.all || []).map((b) => [String(b.botId), b]));
  const groups = new Map();

  for (const t of trades) {
    const cfg = botCfg[String(t.botId)];
    if (!cfg) continue; // skip if bot config not found (shouldn't happen since we already enriched byBot)
    const tf = cfg.timeframe || t.timeframe || '?';
    const tpBucket = bucketTpPct(cfg.tpPercent);
    const kcBucket = bucketKcMult(cfg.kcMult);
    const st = safeTradeLabel(cfg);
    const cb = cbLabel(cfg);
    const key = `${tf}|${tpBucket}|${kcBucket}|${st}|${cb}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        tf,
        tpBucket,
        kcBucket,
        safeTrade: st,
        cb,
        trades: [],
      });
    }
    groups.get(key).trades.push(t);
  }

  const rows = [];
  for (const g of groups.values()) {
    if (g.trades.length < 3) continue; // need at least 3 trades for meaningful signal
    const s = summarizePnl(g.trades);
    let totalHold = 0, holdCount = 0;
    for (const t of g.trades) {
      if (t.buyFilledAt && t.sellFilledAt) {
        const ms = new Date(t.sellFilledAt) - new Date(t.buyFilledAt);
        if (Number.isFinite(ms) && ms >= 0) {
          totalHold += ms;
          holdCount += 1;
        }
      }
    }
    const avgHoldMs = holdCount ? Math.round(totalHold / holdCount) : 0;
    const avgHoldMin = avgHoldMs / 60_000;
    const notional = g.trades.reduce((a, t) => a + (Number(t.buyQuoteQty) || 0), 0);
    const pnlPerNotional = notional > 0 ? (s.pnl / notional) * 100 : 0;
    // composite score (interpretable):
    //   - high avgPnl is good
    //   - high winRate is good
    //   - low avgHoldMin is good (log scale to avoid extreme penalization)
    //   - more trades = more reliable (sqrt)
    // score = avgPnl * (winRate/100) * sqrt(count) / log(1 + avgHoldMin)
    const score = Number(((s.count ? s.pnl / s.count : 0)
      * (s.winRate / 100)
      * Math.sqrt(s.count)
      / Math.log(1 + Math.max(0.1, avgHoldMin))).toFixed(4));
    rows.push({
      key: g.key,
      tf: g.tf,
      tpBucket: g.tpBucket,
      kcBucket: g.kcBucket,
      safeTrade: g.safeTrade,
      cb: g.cb,
      count: s.count,
      wins: s.wins,
      losses: s.losses,
      pnl: s.pnl,
      avgPnl: s.count ? Number((s.pnl / s.count).toFixed(4)) : 0,
      winRate: s.winRate,
      avgHoldMs,
      avgHoldLabel: avgHoldMs ? humanizeMs(avgHoldMs) : '—',
      pnlPerNotional: Number(pnlPerNotional.toFixed(3)),
      notional: Number(notional.toFixed(2)),
      score,
    });
  }

  rows.sort((a, b) => b.score - a.score);
  const reliable = rows.filter((r) => r.count >= 5);
  return {
    best: reliable.slice(0, 10),
    worst: reliable.slice(-10).reverse(),
    allGroupCount: groups.size,
    reliableCount: reliable.length,
  };
}

function buildConclusion(summary, bySellReason, byTimeframe, byBot, bySymbol, derived, deeper) {
  const { holdVsProfit, tpSlDeep, optimal } = deeper || {};
  const lines = [];
  const warnings = [];

  // overall verdict
  if (summary.count === 0) {
    lines.push('⚪ ยังไม่มีข้อมูลเทรด — รอการเทรดครั้งแรกก่อนครับ');
    return { lines, warnings };
  }

  // profitability
  if (summary.pnl > 0) {
    lines.push(`✅ กำไรสุทธิ +${summary.pnl.toFixed(2)} USDT (Win Rate ${summary.winRate}%, ชนะ ${summary.wins}/${summary.count})`);
  } else if (summary.pnl < 0) {
    lines.push(`⚠️ ขาดทุนสุทธิ ${summary.pnl.toFixed(2)} USDT (Win Rate ${summary.winRate}%, แพ้ ${summary.losses}/${summary.count})`);
  } else {
    lines.push(`➖ เสมอตัว — ${summary.count} ไม้รวม Win Rate ${summary.winRate}%`);
  }

  // profit factor / expectancy
  if (summary.profitFactor >= 1.5) lines.push(`💎 Profit Factor ${summary.profitFactor} (ดีมาก — gross profit มากกว่า gross loss ${summary.profitFactor} เท่า)`);
  else if (summary.profitFactor >= 1.0) lines.push(`🟡 Profit Factor ${summary.profitFactor} (พอดี — กำลังทำกำไรแต่บาง)`);
  else if (summary.grossLoss < 0) lines.push(`🔴 Profit Factor ${summary.profitFactor} (เสียเปรียบ — gross loss มากกว่า gross profit)`);

  if (summary.expectancy > 0) lines.push(`📈 Expectancy ต่อไม้ +${summary.expectancy.toFixed(4)} USDT (เป็นบวก = ระบบทำเงินได้ในระยะยาว)`);
  else if (summary.expectancy < 0) lines.push(`📉 Expectancy ต่อไม้ ${summary.expectancy.toFixed(4)} USDT (เป็นลบ = ระบบขาดทุนคาดหวังในระยะยาว)`);

  // avg win vs avg loss
  if (summary.avgLoss !== 0 && summary.avgWin !== 0) {
    const ratio = Math.abs(summary.avgWin / summary.avgLoss);
    if (ratio >= 1.5) lines.push(`⚖️ Avg Win / Avg Loss = ${ratio.toFixed(2)}× (ไม้ชนะใหญ่กว่าไม้แพ้ ${ratio.toFixed(2)} เท่า — ดี)`);
    else if (ratio < 1.0) lines.push(`⚖️ Avg Win / Avg Loss = ${ratio.toFixed(2)}× (ไม้ชนะเล็กกว่าไม้แพ้ — ต้องเพิ่ม TP หรือลด SL)`);
  }

  // sell reason insight
  const { categories } = bySellReason;
  if (categories.tp.count > 0) {
    const tpPct = (categories.tp.count / summary.count) * 100;
    lines.push(`🎯 TP (จบปกติ) ${categories.tp.count} ไม้ (${tpPct.toFixed(0)}%) — กำไร +${categories.tp.pnl.toFixed(2)} USDT`);
  }
  if (categories.cb.count > 0) {
    lines.push(`🚨 CB panic-sell ${categories.cb.count} ไม้ — กระทบ PnL ${categories.cb.pnl.toFixed(2)} USDT`);
    if (categories.cb.losses / categories.cb.count > 0.7) warnings.push('CB panic-sell ส่วนใหญ่ขาดทุน — พิจารณาตรวจ Min %KC หรือ pause บอทที่มี %KC ต่ำ');
  }
  if (categories.sl.count > 0) {
    lines.push(`🛑 SL-UKC ${categories.sl.count} ไม้ — กระทบ PnL ${categories.sl.pnl.toFixed(2)} USDT (ตัดขาดทุนก่อนลึก)`);
  }
  if (categories.manual.count > 0) {
    lines.push(`🖐️ Manual close ${categories.manual.count} ไม้ — PnL ${categories.manual.pnl.toFixed(2)} USDT`);
  }

  // timeframe insight
  if (byTimeframe.length > 0) {
    const bestTf = byTimeframe.reduce((a, b) => (b.pnl > a.pnl ? b : a));
    const worstTf = byTimeframe.reduce((a, b) => (b.pnl < a.pnl ? b : a));
    lines.push(`⏱️ Timeframe ที่ทำกำไรสุทธิดีสุด: ${bestTf.timeframe} (+${bestTf.pnl.toFixed(2)}, ${bestTf.count} ไม้, WR ${bestTf.winRate}%)`);
    if (worstTf.timeframe !== bestTf.timeframe && worstTf.pnl < 0) {
      lines.push(`⏱️ Timeframe ที่ขาดทุนสุทธิ: ${worstTf.timeframe} (${worstTf.pnl.toFixed(2)}, ${worstTf.count} ไม้, WR ${worstTf.winRate}%)`);
      warnings.push(`Timeframe ${worstTf.timeframe} ขาดทุนสุทธิ — พิจารณาปรับ TP/KC หรือ disable บอท ${worstTf.timeframe}`);
    }
  }

  // symbol insight
  if (bySymbol.uniqueCount > 1) {
    const lossSymbols = bySymbol.all.filter((s) => s.count >= 3 && s.pnl < 0);
    if (lossSymbols.length > 0) {
      const worstSym = lossSymbols.reduce((a, b) => (b.pnl < a.pnl ? b : a));
      lines.push(`💱 เหรียญที่ขาดทุนสุทธิ: ${worstSym.symbol} (${worstSym.count} ไม้, ${worstSym.pnl.toFixed(2)} USDT)`);
    }
  }

  // bot leaderboard
  if (byBot.all.length > 0) {
    const topBot = byBot.best[0];
    if (topBot && topBot.count >= 3) {
      lines.push(`🏆 บอทที่ทำกำไรสุทธิดีสุด: ${topBot.name || topBot.symbol} (${topBot.symbol}/${topBot.timeframe}) — +${topBot.pnl.toFixed(2)} USDT, ${topBot.count} ไม้, WR ${topBot.winRate}%`);
    }
    if (byBot.worst[0] && byBot.worst[0].pnl < -1) {
      lines.push(`📉 บอทที่ขาดทุนสุทธิมากสุด: ${byBot.worst[0].name || byBot.worst[0].symbol} — ${byBot.worst[0].pnl.toFixed(2)} USDT (${byBot.worst[0].count} ไม้)`);
    }
    if (byBot.deletedBots > 0) {
      lines.push(`🗑️ รวม ${byBot.deletedBots} บอทที่ถูกลบไปแล้ว — ข้อมูลยังถูกนับรวมในการวิเคราะห์นี้`);
    }
  }

  // drawdown
  if (derived.maxDrawdownEstimate > 1) {
    lines.push(`📉 Max Drawdown (ประมาณจากยอดสะสมรายเดือน): -${derived.maxDrawdownEstimate.toFixed(2)} USDT`);
  }

  // risk insight
  if (summary.stddevPnl > 0 && summary.count > 10) {
    const cv = summary.stddevPnl / Math.max(0.0001, Math.abs(summary.avgPnl));
    if (cv > 5) warnings.push('ค่า PnL ผันผวนสูง (CV > 5) — แต่ละไม้มีผลลัพธ์กว้าง พิจารณาลดขนาด position');
  }

  // ─── FIX-2026-08-21: deeper position insights ───
  if (holdVsProfit && holdVsProfit.count > 0) {
    // overall avg hold + fastest profitable
    lines.push(`⏱️ เวลาถือเฉลี่ย: ${holdVsProfit.avgHoldLabel} (ชนะ ${holdVsProfit.avgHoldWinningLabel} / แพ้ ${holdVsProfit.avgHoldLosingLabel})`);
    if (holdVsProfit.shortestProfitable && holdVsProfit.shortestProfitable.ms < 5 * 60_000) {
      lines.push(`⚡ Scalp เร็วสุดที่กำไรได้: ${humanizeMs(holdVsProfit.shortestProfitable.ms)} → +${(holdVsProfit.shortestProfitable.pnl || 0).toFixed(2)} USDT`);
    }
    if (holdVsProfit.longestProfitable && holdVsProfit.longestProfitable.ms > 4 * 60 * 60_000) {
      const hrs = holdVsProfit.longestProfitable.ms / 3_600_000;
      lines.push(`🐢 ถือนานสุดที่ยังกำไรได้: ${hrs.toFixed(1)} ชม. → +${(holdVsProfit.longestProfitable.pnl || 0).toFixed(2)} USDT`);
    }
    // bucket insights: which bucket is best?
    const viable = holdVsProfit.buckets.filter((b) => b.count >= 5);
    if (viable.length >= 2) {
      const best = viable.reduce((a, b) => (b.pnl > a.pnl ? b : a));
      const worst = viable.reduce((a, b) => (b.pnl < a.pnl ? b : a));
      if (best.pnl > 0) {
        lines.push(`🏆 ช่วงเวลาที่ทำกำไรสุทธิดีสุด: ถือ ${best.label} (${best.count} ไม้, +${best.pnl.toFixed(2)} USDT, WR ${best.winRate.toFixed(0)}%)`);
      }
      if (worst.pnl < 0 && worst.label !== best.label) {
        warnings.push(`ช่วงเวลาถือ ${worst.label} ขาดทุนสุทธิ ${worst.pnl.toFixed(2)} USDT — พิจารณาปรับ TP/SL หรือเพิ่ม deadline timeout`);
      }
      // overnight profitable bucket — high-confidence signal
      const ov = viable.find((b) => b.label === '>24h');
      if (ov && ov.count >= 3 && ov.winRate >= 60 && ov.pnl > 0) {
        lines.push(`🌙 ถือข้ามคืน (>24h) แล้วยังกำไร: ${ov.count} ไม้ (WR ${ov.winRate.toFixed(0)}%, +${ov.pnl.toFixed(2)} USDT)`);
      } else if (ov && ov.count >= 3 && ov.pnl < 0) {
        warnings.push(`ถือข้ามคืน (>24h) ขาดทุน ${ov.pnl.toFixed(2)} USDT — ควรเพิ่ม SL/deadline เพื่อตัดขาดทุนก่อน`);
      }
    }
  }

  // TP / SL deep insight
  if (tpSlDeep) {
    if (tpSlDeep.tp.count > 0) {
      lines.push(`🎯 TP เฉลี่ย +${tpSlDeep.tp.avgPnl.toFixed(2)} USDT/ไม้ · min ${tpSlDeep.tp.minPnl.toFixed(2)} · max ${tpSlDeep.tp.maxPnl.toFixed(2)} · ถือเฉลี่ย ${tpSlDeep.tp.avgHoldLabel}`);
    }
    if (tpSlDeep.sl.count > 0) {
      lines.push(`🛑 SL เฉลี่ย ${tpSlDeep.sl.avgPnl.toFixed(2)} USDT/ไม้ · min ${tpSlDeep.sl.minPnl.toFixed(2)} · max ${tpSlDeep.sl.maxPnl.toFixed(2)} · ถือเฉลี่ย ${tpSlDeep.sl.avgHoldLabel}`);
      // SL biggest loss — how long was it held?
      if (tpSlDeep.sl.maxHoldAtExtreme > 60 * 60_000) {
        lines.push(`⏳ ไม้ SL ที่ขาดทุนหนักสุด ถือมาแล้ว ${tpSlDeep.sl.maxHoldAtExtremeLabel} — ควรพิจารณา SL tighter หรือ deadline เร็วขึ้น`);
      }
    }
  }

  // Optimal config insights
  if (optimal && optimal.best && optimal.best.length > 0) {
    const top = optimal.best[0];
    lines.push(`🧬 Config ที่ดีที่สุด (top score): ${top.tf} · TP ${top.tpBucket} · KC ${top.kcBucket} · ${top.safeTrade} · ${top.cb} → ${top.count} ไม้, WR ${top.winRate.toFixed(0)}%, +${top.pnl.toFixed(2)} USDT, ถือเฉลี่ย ${top.avgHoldLabel}`);
    if (optimal.worst && optimal.worst.length > 0) {
      const bad = optimal.worst[0];
      warnings.push(`Config ที่ควรหลีกเลี่ยง: ${bad.tf} · TP ${bad.tpBucket} · KC ${bad.kcBucket} · ${bad.safeTrade} · ${bad.cb} → ${bad.count} ไม้, WR ${bad.winRate.toFixed(0)}%, ${bad.pnl.toFixed(2)} USDT`);
    }
  }

  return { lines, warnings };
}

// ─── Main entrypoint ────────────────────────────────────

async function aggregateTradeAnalysis({ since = null } = {}) {
  const t0 = Date.now();
  const trades = await fetchAllSoldTrades({ since });

  const summary = buildSummary(trades);
  const bySymbol = buildBySymbol(trades);
  const byTimeframe = buildByTimeframe(trades);
  const bySellReason = buildBySellReason(trades);
  const byHour = buildByHour(trades);
  const byDayOfWeek = buildByDayOfWeek(trades);
  const byDay = buildByDay(trades);
  const byMonth = buildByMonth(trades);
  const byBot = await buildByBot(trades);
  const duration = buildDuration(trades);
  const sizing = buildSizing(trades);
  const streaks = buildStreaks(trades);
  const dcaVsNonDca = buildDcaVsNonDca(trades);
  const extremes = buildExtremes(trades);
  const derived = buildDerived(summary, byMonth);
  // FIX-2026-08-21: deeper position analysis
  const holdVsProfit = buildHoldVsProfit(trades);
  const tpSlDeep = buildTpSlDeep(trades);
  const optimal = await buildOptimalConfigs(trades, byBot);
  const conclusion = buildConclusion(summary, bySellReason, byTimeframe, byBot, bySymbol, derived, { holdVsProfit, tpSlDeep, optimal });

  // meta
  const firstTradeAt = trades.length
    ? trades.reduce((a, t) => (!a || new Date(t.sellFilledAt) < new Date(a) ? t.sellFilledAt : a), null)
    : null;
  const lastTradeAt = trades.length
    ? trades.reduce((a, t) => (!a || new Date(t.sellFilledAt) > new Date(a) ? t.sellFilledAt : a), null)
    : null;

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    computeMs: Date.now() - t0,
    meta: {
      tradeCount: trades.length,
      activeBotCount: byBot.activeBots,
      deletedBotCount: byBot.deletedBots,
      firstTradeAt,
      lastTradeAt,
      sellReasonLabels: SELL_REASON_LABELS,
    },
    summary,
    bySymbol,
    byTimeframe,
    bySellReason,
    byHour,
    byDayOfWeek,
    byDay,
    byMonth,
    byBot,
    duration,
    sizing,
    streaks,
    dcaVsNonDca,
    extremes,
    derived,
    holdVsProfit,
    tpSlDeep,
    optimal,
    conclusion,
  };
}

module.exports = {
  aggregateTradeAnalysis,
  // exported for tests
  buildSummary,
  buildBySymbol,
  buildByTimeframe,
  buildBySellReason,
  buildByHour,
  buildByDayOfWeek,
  buildByDay,
  buildByMonth,
  buildDuration,
  buildSizing,
  buildStreaks,
  buildDcaVsNonDca,
  buildExtremes,
  buildDerived,
  buildHoldVsProfit,
  buildTpSlDeep,
  buildOptimalConfigs,
  buildConclusion,
  summarizePnl,
  safeDivide,
  humanizeMs,
  SELL_REASON_LABELS,
  HOUR_LABELS,
  DOW_LABELS,
};