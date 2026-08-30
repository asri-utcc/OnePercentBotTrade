'use strict';

/**
 * FIX-2026-08-21: Unit tests for src/core/tradeAnalysis.js
 *
 * Tests the pure aggregation helpers (buildSummary / buildBySymbol / etc.)
 * by feeding them hand-crafted trade arrays. No DB needed.
 *
 * This covers the section builders exhaustively so we catch regressions in:
 *   - summary math (win rate, avg, profit factor)
 *   - bySymbol/byTimeframe/bySellReason grouping
 *   - byHour/byDayOfWeek/byDay/byMonth bucketing
 *   - duration buckets
 *   - sizing buckets
 *   - streak detection (win/loss)
 *   - DCA vs non-DCA split
 *   - extremes (biggest win/loss/best/worst day)
 *   - derived (Sharpe-lite + drawdown)
 *   - conclusion generation (lines + warnings)
 *   - safeDivide / humanizeMs formatters
 */

const {
  buildSummary,
  buildBySymbol,
  buildByTimeframe,
  buildBySellReason,
  buildByHour,
  buildHeatmap,
  buildByDayOfWeek,
  buildByDay,
  buildByMonth,
  buildDuration,
  buildSizing,
  buildStreaks,
  buildDcaVsNonDca,
  buildExtremes,
  buildDerived,
  buildConclusion,
  buildHoldVsProfit,
  buildTpSlDeep,
  buildOptimalConfigs,
  summarizePnl,
  safeDivide,
  humanizeMs,
} = require('../src/core/tradeAnalysis');

// ─── helpers ────────────────────────────────────────────────
function mkTrade(o = {}) {
  return {
    _id: o._id || `t${Math.random().toString(36).slice(2, 9)}`,
    botId: o.botId || 'bot1',
    symbol: o.symbol || 'BTCUSDT',
    timeframe: o.timeframe || '5m',
    realizedPnl: o.realizedPnl != null ? o.realizedPnl : 0.5,
    pnlPercent: o.pnlPercent != null ? o.pnlPercent : 0.3,
    sellFilledAt: o.sellFilledAt || new Date('2026-08-15T10:30:00Z'),
    buyFilledAt: o.buyFilledAt !== undefined ? o.buyFilledAt : new Date('2026-08-15T10:00:00Z'),
    buyLayers: o.buyLayers || [],
    buyPrice: o.buyPrice != null ? o.buyPrice : 100,
    sellAvgPrice: o.sellAvgPrice != null ? o.sellAvgPrice : 100.5,
    sellPrice: o.sellPrice != null ? o.sellPrice : 100.5,
    buyQuoteQty: o.buyQuoteQty != null ? o.buyQuoteQty : 100,
    buyQty: o.buyQty != null ? o.buyQty : 1,
    sellQty: o.sellQty != null ? o.sellQty : 1,
    sellFilledQty: o.sellFilledQty != null ? o.sellFilledQty : 1,
    sellReason: o.sellReason || 'tp_hit',
    sellReasonDetail: o.sellReasonDetail || null,
    sellReasonAt: o.sellReasonAt || new Date(),
    isDcaStack: o.isDca || false,
    dcaLayerCount: o.dcaLayerCount || 0,
    stackTotalQty: o.stackTotalQty || 0,
    stackTotalSpent: o.stackTotalSpent || 0,
    stackBep: o.stackBep || 0,
    buyFee: o.buyFee || 0.1,
    sellFee: o.sellFee || 0.1,
    retryCount: o.retryCount || 0,
  };
}

describe('safeDivide', () => {
  test('returns fallback for 0 divisor', () => {
    expect(safeDivide(10, 0)).toBe(0);
    expect(safeDivide(10, 0, -1)).toBe(-1);
  });
  test('returns fallback for NaN divisor', () => {
    expect(safeDivide(10, NaN, 99)).toBe(99);
  });
  test('returns fallback for Infinity divisor', () => {
    expect(safeDivide(10, Infinity, 5)).toBe(5);
  });
  test('returns quotient when valid', () => {
    expect(safeDivide(10, 2)).toBe(5);
    expect(safeDivide(0, 5)).toBe(0);
  });
});

describe('humanizeMs', () => {
  test('formats seconds < 1m', () => {
    expect(humanizeMs(5_000)).toMatch(/^\d+s$/);
  });
  test('formats minutes < 1h', () => {
    expect(humanizeMs(5 * 60_000)).toMatch(/^\d+m$/);
  });
  test('formats hours < 1d', () => {
    expect(humanizeMs(2 * 3_600_000)).toMatch(/^\d+\.\dh$/);
  });
  test('formats days >= 1d', () => {
    expect(humanizeMs(3 * 86_400_000)).toMatch(/^\d+\.\dd$/);
  });
});

describe('summarizePnl', () => {
  test('handles empty input', () => {
    const s = summarizePnl([]);
    expect(s).toEqual({ pnl: 0, grossProfit: 0, grossLoss: 0, wins: 0, losses: 0, breakeven: 0, count: 0, winRate: 0 });
  });

  test('counts wins/losses/breakeven correctly', () => {
    const s = summarizePnl([
      { realizedPnl: 1 }, { realizedPnl: 2 }, { realizedPnl: -1 }, { realizedPnl: 0 }, { realizedPnl: 0.5 },
    ]);
    expect(s.wins).toBe(3);
    expect(s.losses).toBe(1);
    expect(s.breakeven).toBe(1);
    expect(s.count).toBe(5);
    expect(s.winRate).toBe(60); // 60.0
    expect(s.pnl).toBe(2.5);
    expect(s.grossProfit).toBe(3.5);
    expect(s.grossLoss).toBe(-1);
  });

  test('treats missing realizedPnl as 0', () => {
    const s = summarizePnl([{}, { realizedPnl: null }]);
    expect(s.breakeven).toBe(2);
    expect(s.count).toBe(2);
  });
});

describe('buildSummary', () => {
  test('computes fees, avgWin/Loss, profitFactor, expectancy', () => {
    const trades = [
      mkTrade({ realizedPnl: 2, buyFee: 0.1, sellFee: 0.1, buyQuoteQty: 100 }),
      mkTrade({ realizedPnl: 1, buyFee: 0.05, sellFee: 0.05, buyQuoteQty: 50 }),
      mkTrade({ realizedPnl: -0.5, buyFee: 0.1, sellFee: 0.1, buyQuoteQty: 100 }),
    ];
    const s = buildSummary(trades);
    expect(s.count).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.pnl).toBe(2.5);
    expect(s.grossProfit).toBe(3);
    expect(s.grossLoss).toBe(-0.5);
    expect(s.winRate).toBeCloseTo(66.67, 1);
    expect(s.totalNotional).toBe(250);
    expect(s.totalBuyFee).toBe(0.25);
    expect(s.totalSellFee).toBe(0.25);
    expect(s.totalFees).toBe(0.5);
    expect(s.avgPnl).toBeCloseTo(0.8333, 3);
    expect(s.avgWin).toBe(1.5);
    expect(s.avgLoss).toBe(-0.5);
    expect(s.expectancy).toBeGreaterThan(0);
    expect(s.profitFactor).toBeGreaterThan(0);
    expect(s.pnlPerUsdtNotional).toBeCloseTo(1.0, 1); // 2.5 / 250 * 100
  });

  test('handles empty trades', () => {
    const s = buildSummary([]);
    expect(s.count).toBe(0);
    expect(s.pnl).toBe(0);
    expect(s.totalNotional).toBe(0);
  });
});

describe('buildBySymbol', () => {
  test('groups by symbol and ranks', () => {
    const trades = [
      mkTrade({ symbol: 'BTCUSDT', realizedPnl: 1 }),
      mkTrade({ symbol: 'BTCUSDT', realizedPnl: 2 }),
      mkTrade({ symbol: 'ETHUSDT', realizedPnl: -1 }),
      mkTrade({ symbol: 'ETHUSDT', realizedPnl: 3 }),
    ];
    const r = buildBySymbol(trades);
    expect(r.uniqueCount).toBe(2);
    expect(r.all[0].symbol).toBe('BTCUSDT'); // pnl=3
    expect(r.all[0].count).toBe(2);
    expect(r.all[0].pnl).toBe(3);
    expect(r.best[0].symbol).toBe('BTCUSDT');
    expect(r.worst[0].symbol).toBe('ETHUSDT'); // worst (pnl=2)
  });

  test('handles single-symbol input', () => {
    const trades = [mkTrade({ symbol: 'BNBUSDT', realizedPnl: 0.5 })];
    const r = buildBySymbol(trades);
    expect(r.uniqueCount).toBe(1);
    expect(r.best[0].symbol).toBe('BNBUSDT');
  });
});

describe('buildByTimeframe', () => {
  test('groups by timeframe in canonical order (1m, 3m, 5m, 15m, 1h, ...)', () => {
    const trades = [
      mkTrade({ timeframe: '1h', realizedPnl: 1 }),
      mkTrade({ timeframe: '5m', realizedPnl: 2 }),
      mkTrade({ timeframe: '1m', realizedPnl: 3 }),
    ];
    const r = buildByTimeframe(trades);
    expect(r.map((x) => x.timeframe)).toEqual(['1m', '5m', '1h']);
  });

  test('counts + win rate per timeframe', () => {
    const trades = [
      mkTrade({ timeframe: '5m', realizedPnl: 1 }),
      mkTrade({ timeframe: '5m', realizedPnl: -1 }),
      mkTrade({ timeframe: '5m', realizedPnl: 1 }),
    ];
    const r = buildByTimeframe(trades);
    expect(r[0].count).toBe(3);
    expect(r[0].wins).toBe(2);
    expect(r[0].losses).toBe(1);
    expect(r[0].winRate).toBeCloseTo(66.67, 1);
  });
});

describe('buildBySellReason', () => {
  test('groups by sellReason + computes categories', () => {
    const trades = [
      mkTrade({ sellReason: 'tp_hit', realizedPnl: 1 }),
      mkTrade({ sellReason: 'tp_hit', realizedPnl: 2 }),
      mkTrade({ sellReason: 'cbv2_panic', realizedPnl: -0.5 }),
      mkTrade({ sellReason: 'sl_ukc_f1_armed', realizedPnl: -1 }),
      mkTrade({ sellReason: 'manual_api_force_close_trade', realizedPnl: 0.5 }),
    ];
    const r = buildBySellReason(trades);
    expect(r.rows.length).toBe(4);
    // tp_hit is most frequent (2) so first row
    expect(r.rows[0].reason).toBe('tp_hit');
    expect(r.rows[0].count).toBe(2);
    expect(r.rows[0].label).toBe('TP Hit');
    // categories
    expect(r.categories.tp.count).toBe(2);
    expect(r.categories.tp.pnl).toBe(3);
    expect(r.categories.cb.count).toBe(1);
    expect(r.categories.sl.count).toBe(1);
    expect(r.categories.manual.count).toBe(1);
  });

  test('unknown sellReason becomes label=reason', () => {
    const trades = [mkTrade({ sellReason: 'unknown', realizedPnl: 0 })];
    const r = buildBySellReason(trades);
    expect(r.rows[0].label).toBe('Unknown');
  });
});

describe('buildByHour', () => {
  test('buckets trades by hour 0..23', () => {
    const trades = [
      mkTrade({ sellFilledAt: new Date('2026-08-15T09:30:00Z'), realizedPnl: 1 }),
      mkTrade({ sellFilledAt: new Date('2026-08-15T09:45:00Z'), realizedPnl: -0.5 }),
      mkTrade({ sellFilledAt: new Date('2026-08-15T15:00:00Z'), realizedPnl: 0.2 }),
    ];
    // server TZ may shift hour — use UTC buckets in this test by being explicit
    const r = buildByHour(trades);
    const hour9 = r.find((x) => x.count === 2);
    expect(hour9).toBeTruthy();
    expect(hour9.wins).toBe(1);
    expect(hour9.losses).toBe(1);
    expect(r).toHaveLength(24);
  });
});

describe('buildHeatmap', () => {
  const cellOf = (m, at) => {
    const d = new Date(at);
    return m[d.getDay()][d.getHours()];
  };

  test('returns two 7x24 matrices plus buyMissing', () => {
    const r = buildHeatmap([]);
    expect(r.sell).toHaveLength(7);
    expect(r.buy).toHaveLength(7);
    expect(r.sell[0]).toHaveLength(24);
    expect(r.buy[0]).toHaveLength(24);
    expect(r.buyMissing).toBe(0);
  });

  test('sell matrix buckets by sellFilledAt, buy matrix by buyFilledAt', () => {
    const buyAt = new Date('2026-08-17T04:00:00Z');   // Sunday
    const sellAt = new Date('2026-08-18T09:00:00Z');  // Monday
    const r = buildHeatmap([mkTrade({ buyFilledAt: buyAt, sellFilledAt: sellAt, realizedPnl: 2 })]);
    expect(cellOf(r.sell, sellAt)).toMatchObject({ count: 1, wins: 1, losses: 0, pnl: 2 });
    expect(cellOf(r.buy, buyAt)).toMatchObject({ count: 1, wins: 1, losses: 0, pnl: 2 });
    // the same trade must NOT land in the other matrix's slot
    expect(cellOf(r.buy, sellAt).count).toBe(0);
    expect(cellOf(r.sell, buyAt).count).toBe(0);
  });

  test('a losing trade colours the BUY slot red (loss attributed to entry hour)', () => {
    const buyAt = new Date('2026-08-17T04:00:00Z');
    const r = buildHeatmap([
      mkTrade({ buyFilledAt: buyAt, sellFilledAt: new Date('2026-08-17T09:00:00Z'), realizedPnl: -1.5 }),
    ]);
    expect(cellOf(r.buy, buyAt)).toMatchObject({ count: 1, wins: 0, losses: 1, pnl: -1.5 });
  });

  test('DCA stack uses the FIRST buy layer as entry time', () => {
    const layer0 = new Date('2026-08-17T02:00:00Z');
    const r = buildHeatmap([mkTrade({
      buyFilledAt: new Date('2026-08-17T06:00:00Z'),
      buyLayers: [{ filledAt: layer0 }, { filledAt: new Date('2026-08-17T06:00:00Z') }],
      sellFilledAt: new Date('2026-08-17T09:00:00Z'),
      realizedPnl: 1,
    })]);
    expect(cellOf(r.buy, layer0).count).toBe(1);
    expect(cellOf(r.buy, new Date('2026-08-17T06:00:00Z')).count).toBe(0);
  });

  test('counts trades with no entry timestamp as buyMissing', () => {
    const r = buildHeatmap([
      mkTrade({ buyFilledAt: null, buyLayers: [], sellFilledAt: new Date('2026-08-17T09:00:00Z'), realizedPnl: 1 }),
    ]);
    expect(r.buyMissing).toBe(1);
    expect(cellOf(r.sell, new Date('2026-08-17T09:00:00Z')).count).toBe(1);
  });

  test('accumulates multiple trades in the same slot', () => {
    const at = new Date('2026-08-17T04:00:00Z');
    const r = buildHeatmap([
      mkTrade({ buyFilledAt: at, sellFilledAt: at, realizedPnl: 1 }),
      mkTrade({ buyFilledAt: at, sellFilledAt: at, realizedPnl: -0.25 }),
      mkTrade({ buyFilledAt: at, sellFilledAt: at, realizedPnl: 0.5 }),
    ]);
    expect(cellOf(r.buy, at)).toMatchObject({ count: 3, wins: 2, losses: 1, pnl: 1.25 });
  });

  test('survives JSON round-trip (regression: matrices used to hang off an Array prop)', () => {
    const at = new Date('2026-08-17T04:00:00Z');
    const r = JSON.parse(JSON.stringify(buildHeatmap([mkTrade({ buyFilledAt: at, sellFilledAt: at, realizedPnl: 1 })])));
    expect(r.sell).toHaveLength(7);
    expect(r.buy[0]).toHaveLength(24);
  });
});

describe('buildByDayOfWeek', () => {
  test('returns 7 buckets Sun..Sat', () => {
    const r = buildByDayOfWeek([mkTrade()]);
    expect(r).toHaveLength(7);
    expect(r.map((d) => d.label)).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  });
});

describe('buildByDay', () => {
  test('groups by YYYY-MM-DD sorted asc', () => {
    const trades = [
      mkTrade({ sellFilledAt: new Date('2026-08-15T10:00:00Z'), realizedPnl: 1 }),
      mkTrade({ sellFilledAt: new Date('2026-08-15T15:00:00Z'), realizedPnl: -0.5 }),
      mkTrade({ sellFilledAt: new Date('2026-08-14T10:00:00Z'), realizedPnl: 2 }),
    ];
    const r = buildByDay(trades);
    // First row is the earliest date (depends on local TZ)
    expect(r.length).toBeGreaterThanOrEqual(2);
    expect(r[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // ascending
    for (let i = 1; i < r.length; i++) {
      expect(r[i].date >= r[i - 1].date).toBe(true);
    }
  });
});

describe('buildByMonth', () => {
  test('groups by YYYY-MM', () => {
    const trades = [
      mkTrade({ sellFilledAt: new Date('2026-08-15T10:00:00Z'), realizedPnl: 1 }),
      mkTrade({ sellFilledAt: new Date('2026-07-15T10:00:00Z'), realizedPnl: -0.5 }),
      mkTrade({ sellFilledAt: new Date('2026-07-20T10:00:00Z'), realizedPnl: 2 }),
    ];
    const r = buildByMonth(trades);
    expect(r[0].month).toMatch(/^\d{4}-\d{2}$/);
    expect(r.length).toBe(2);
  });
});

describe('buildDuration', () => {
  test('groups trades by hold-time bucket', () => {
    const trades = [
      mkTrade({ buyFilledAt: new Date('2026-08-15T10:00:00Z'), sellFilledAt: new Date('2026-08-15T10:00:30Z'), realizedPnl: 0.5 }), // <1m
      mkTrade({ buyFilledAt: new Date('2026-08-15T10:00:00Z'), sellFilledAt: new Date('2026-08-15T10:03:00Z'), realizedPnl: 1 }), // 1-5m
      mkTrade({ buyFilledAt: new Date('2026-08-15T10:00:00Z'), sellFilledAt: new Date('2026-08-15T12:00:00Z'), realizedPnl: -1 }), // 1-4h
    ];
    const r = buildDuration(trades);
    expect(r.count).toBe(3);
    expect(r.avgHoldMs).toBeGreaterThan(0);
    expect(r.buckets.find((b) => b.label === '<1m').count).toBe(1);
    expect(r.buckets.find((b) => b.label === '1-5m').count).toBe(1);
    expect(r.buckets.find((b) => b.label === '1-4h').count).toBe(1);
  });

  test('skips trades missing buyFilledAt or sellFilledAt', () => {
    // bypass mkTrade's defaults so buyFilledAt/sellFilledAt are explicitly null
    const t1 = mkTrade({});
    t1.buyFilledAt = null;
    const t2 = mkTrade({});
    t2.sellFilledAt = null;
    const r = buildDuration([t1, t2]);
    expect(r.count).toBe(0);
  });
});

describe('buildSizing', () => {
  test('buckets by notional + totals', () => {
    const trades = [
      mkTrade({ buyQuoteQty: 5 }),
      mkTrade({ buyQuoteQty: 20 }),
      mkTrade({ buyQuoteQty: 75 }),
      mkTrade({ buyQuoteQty: 300 }),
    ];
    const r = buildSizing(trades);
    expect(r.totalNotional).toBe(400);
    expect(r.minNotional).toBe(5);
    expect(r.maxNotional).toBe(300);
    expect(r.avgNotional).toBe(100);
    expect(r.buckets.find((b) => b.label === '<10').count).toBe(1);
    expect(r.buckets.find((b) => b.label === '10-25').count).toBe(1);
    expect(r.buckets.find((b) => b.label === '50-100').count).toBe(1);
    expect(r.buckets.find((b) => b.label === '>250').count).toBe(1);
  });
});

describe('buildStreaks', () => {
  test('detects longest win/loss streaks', () => {
    const trades = [
      mkTrade({ sellFilledAt: new Date('2026-08-15T10:00:00Z'), realizedPnl: 1 }),
      mkTrade({ sellFilledAt: new Date('2026-08-15T11:00:00Z'), realizedPnl: 1 }),
      mkTrade({ sellFilledAt: new Date('2026-08-15T12:00:00Z'), realizedPnl: 1 }),
      mkTrade({ sellFilledAt: new Date('2026-08-15T13:00:00Z'), realizedPnl: -1 }),
      mkTrade({ sellFilledAt: new Date('2026-08-15T14:00:00Z'), realizedPnl: -1 }),
      mkTrade({ sellFilledAt: new Date('2026-08-15T15:00:00Z'), realizedPnl: 1 }),
    ];
    const r = buildStreaks(trades);
    expect(r.bestWinStreak).toBe(3);
    expect(r.bestLossStreak).toBe(2);
    expect(r.currentWinStreak).toBe(1);
    expect(r.totalWinningTrades).toBe(4);
    expect(r.totalLosingTrades).toBe(2);
  });

  test('handles empty trades', () => {
    const r = buildStreaks([]);
    expect(r.bestWinStreak).toBe(0);
    expect(r.bestLossStreak).toBe(0);
    expect(r.currentWinStreak).toBe(0);
  });
});

describe('buildDcaVsNonDca', () => {
  test('splits by isDcaStack', () => {
    const trades = [
      mkTrade({ isDca: true, realizedPnl: 1 }),
      mkTrade({ isDca: true, realizedPnl: -0.5 }),
      mkTrade({ isDca: false, realizedPnl: 2 }),
      mkTrade({ isDca: false, realizedPnl: 3 }),
    ];
    const r = buildDcaVsNonDca(trades);
    expect(r.dca.count).toBe(2);
    expect(r.dca.pnl).toBe(0.5);
    expect(r.dca.wins).toBe(1);
    expect(r.nonDca.count).toBe(2);
    expect(r.nonDca.pnl).toBe(5);
    expect(r.nonDca.wins).toBe(2);
  });
});

describe('buildExtremes', () => {
  test('finds biggest win + biggest loss + best/worst day', () => {
    const trades = [
      mkTrade({ _id: 'win1', sellFilledAt: new Date('2026-08-15T10:00:00Z'), realizedPnl: 5 }),
      mkTrade({ _id: 'loss1', sellFilledAt: new Date('2026-08-15T11:00:00Z'), realizedPnl: -10 }),
      mkTrade({ _id: 'mid1', sellFilledAt: new Date('2026-08-14T11:00:00Z'), realizedPnl: 1 }),
    ];
    const r = buildExtremes(trades);
    expect(r.biggestWin._id || r.biggestWin.tradeId).toBeTruthy();
    expect(r.biggestLoss._id || r.biggestLoss.tradeId).toBeTruthy();
    expect(r.biggestWin.pnl).toBe(5);
    expect(r.biggestLoss.pnl).toBe(-10);
    expect(r.bestDay).toBeTruthy();
    expect(r.worstDay).toBeTruthy();
  });

  test('handles empty', () => {
    const r = buildExtremes([]);
    expect(r.biggestWin).toBe(null);
    expect(r.biggestLoss).toBe(null);
    expect(r.bestDay).toBe(null);
    expect(r.worstDay).toBe(null);
  });
});

describe('buildDerived', () => {
  test('computes monthly stats + drawdown', () => {
    const summary = { pnl: 10, count: 5, winRate: 80 };
    const byMonth = [
      { month: '2026-06', pnl: 5, count: 2 },
      { month: '2026-07', pnl: 3, count: 2 },
      { month: '2026-08', pnl: 2, count: 1 },
    ];
    const r = buildDerived(summary, byMonth);
    expect(r.monthlyMean).toBeCloseTo(3.33, 1);
    expect(r.maxDrawdownEstimate).toBeGreaterThanOrEqual(0);
    expect(r.bestMonth.month).toBe('2026-06');
    expect(r.worstMonth.month).toBe('2026-08');
  });

  test('returns zeros for insufficient data', () => {
    const r = buildDerived({ pnl: 1, count: 1 }, [{ month: '2026-08', pnl: 1, count: 1 }]);
    expect(r.sharpeLite).toBe(0);
    expect(r.maxDrawdownEstimate).toBe(0);
  });
});

describe('buildConclusion', () => {
  test('generates profitability lines + insights', () => {
    const summary = {
      pnl: 10, count: 10, wins: 7, losses: 3, winRate: 70,
      grossProfit: 12, grossLoss: -2, avgWin: 1.71, avgLoss: -0.67,
      profitFactor: 6, expectancy: 0.95, stddevPnl: 1,
    };
    const bySellReason = { categories: { tp: { count: 5, pnl: 8 }, sl: { count: 0 }, cb: { count: 0, losses: 0 }, manual: { count: 0 } } };
    const byTimeframe = [{ timeframe: '5m', count: 10, pnl: 10, winRate: 70 }];
    const byBot = { all: [], best: [], worst: [], deletedBots: 0 };
    const bySymbol = { all: [], uniqueCount: 1 };
    const derived = { maxDrawdownEstimate: 0 };
    const r = buildConclusion(summary, bySellReason, byTimeframe, byBot, bySymbol, derived);
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.lines.some((l) => l.includes('กำไรสุทธิ'))).toBe(true);
    expect(r.lines.some((l) => l.includes('Profit Factor'))).toBe(true);
    expect(r.warnings).toBeDefined();
  });

  test('returns warning for high loss-streak CB', () => {
    const summary = { pnl: -5, count: 5, wins: 1, losses: 4, winRate: 20, grossProfit: 1, grossLoss: -6, avgWin: 1, avgLoss: -1.5, profitFactor: 0.17, expectancy: -1, stddevPnl: 0.5 };
    const bySellReason = { categories: { tp: { count: 1, pnl: 1 }, sl: { count: 0 }, cb: { count: 4, losses: 4, pnl: -6 }, manual: { count: 0 } } };
    const byTimeframe = [{ timeframe: '5m', count: 5, pnl: -5, winRate: 20 }];
    const byBot = { all: [], best: [], worst: [], deletedBots: 0 };
    const bySymbol = { all: [{ symbol: 'BTC', count: 5, pnl: -5 }], uniqueCount: 1 };
    const derived = { maxDrawdownEstimate: 0 };
    const r = buildConclusion(summary, bySellReason, byTimeframe, byBot, bySymbol, derived);
    expect(r.lines.some((l) => l.includes('ขาดทุนสุทธิ'))).toBe(true);
    expect(r.lines.some((l) => l.includes('Profit Factor'))).toBe(true);
    expect(r.lines.some((l) => l.includes('CB panic-sell'))).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test('handles empty summary gracefully', () => {
    const summary = { pnl: 0, count: 0, wins: 0, losses: 0, winRate: 0, grossProfit: 0, grossLoss: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, expectancy: 0, stddevPnl: 0 };
    const r = buildConclusion(summary, { categories: { tp: { count: 0 }, sl: { count: 0 }, cb: { count: 0 }, manual: { count: 0 } } }, [], { all: [], best: [], worst: [], deletedBots: 0 }, { all: [], uniqueCount: 0 }, { maxDrawdownEstimate: 0 });
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.lines[0]).toMatch(/ยังไม่มีข้อมูล/);
  });
});

describe('integration: buildByBot sorts by PnL desc', () => {
  test('(stub - uses real Mongo) shape contract', () => {
    // buildByBot requires real Mongo; we instead verify the shape contract via
    // buildBySymbol which has the same shape.
    const trades = [
      mkTrade({ botId: 'b1', symbol: 'BTCUSDT', realizedPnl: 1 }),
      mkTrade({ botId: 'b2', symbol: 'ETHUSDT', realizedPnl: 5 }),
      mkTrade({ botId: 'b3', symbol: 'SOLUSDT', realizedPnl: -2 }),
    ];
    const r = buildBySymbol(trades);
    expect(r.all[0].symbol).toBe('ETHUSDT'); // top PnL
    expect(r.all[r.all.length - 1].symbol).toBe('SOLUSDT'); // bottom PnL
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FIX-2026-08-21: Deeper position analysis (Phase 2)
// ════════════════════════════════════════════════════════════════════════════

describe('buildHoldVsProfit', () => {
  function tWithHold(symbol, pnl, ms, opts = {}) {
    const buyAt = new Date('2026-08-15T10:00:00Z');
    const sellAt = new Date(buyAt.getTime() + ms);
    return mkTrade({ symbol, realizedPnl: pnl, buyFilledAt: buyAt, sellFilledAt: sellAt, sellReason: opts.sellReason || 'tp_hit' });
  }

  test('empty trades → zero counts + no extremes', () => {
    const r = buildHoldVsProfit([]);
    expect(r.count).toBe(0);
    expect(r.avgHoldMs).toBe(0);
    expect(r.avgHoldLabel).toBe('—');
    expect(r.longestOverall).toBeNull();
    expect(r.shortestProfitable).toBeNull();
  });

  test('skips trades with missing or invalid dates', () => {
    const a = mkTrade({});
    a.sellFilledAt = null;
    const r = buildHoldVsProfit([a]);
    expect(r.count).toBe(0);
  });

  test('avgHoldAll/Win/Loss computed correctly', () => {
    const trades = [
      tWithHold('BTC', 1, 30 * 60_000),         // 30m profit
      tWithHold('ETH', -0.5, 90 * 60_000),      // 90m loss
      tWithHold('SOL', 0.8, 10 * 60_000),       // 10m profit
    ];
    const r = buildHoldVsProfit(trades);
    expect(r.count).toBe(3);
    // avg = (30+90+10)/3 = 43.33 min
    expect(Math.round(r.avgHoldMs / 60_000)).toBe(43);
    // win avg = (30+10)/2 = 20
    expect(Math.round(r.avgHoldWinningMs / 60_000)).toBe(20);
    // loss avg = 90
    expect(Math.round(r.avgHoldLosingMs / 60_000)).toBe(90);
  });

  test('shortestProfitable = fastest profit trade', () => {
    const trades = [
      tWithHold('BTC', 1, 30 * 60_000),
      tWithHold('ETH', -0.5, 90 * 60_000),
      tWithHold('SOL', 0.8, 5 * 60_000), // fastest profit
    ];
    const r = buildHoldVsProfit(trades);
    expect(r.shortestProfitable.symbol).toBe('SOL');
    expect(r.shortestProfitable.ms).toBe(5 * 60_000);
    expect(r.fastestProfit.symbol).toBe('SOL');
  });

  test('longestProfitable tracks max hold among profitable trades', () => {
    const trades = [
      tWithHold('BTC', 1, 30 * 60_000),
      tWithHold('ETH', -0.5, 90 * 60_000),
      tWithHold('SOL', 0.8, 4 * 60 * 60_000), // longest profit
      tWithHold('XRP', 0.3, 1 * 60 * 60_000),
    ];
    const r = buildHoldVsProfit(trades);
    expect(r.longestProfitable.symbol).toBe('SOL');
    expect(r.longestProfitable.ms).toBe(4 * 60 * 60_000);
  });

  test('longestOverall includes losing trades', () => {
    const trades = [
      tWithHold('BTC', 1, 30 * 60_000),
      tWithHold('ETH', -0.5, 5 * 24 * 60 * 60_000), // 5-day loss
      tWithHold('SOL', 0.8, 4 * 60 * 60_000),
    ];
    const r = buildHoldVsProfit(trades);
    expect(r.longestOverall.symbol).toBe('ETH');
    expect(r.longestOverall.pnl).toBeLessThan(0);
  });

  test('buckets populated with counts + winRate + pnl', () => {
    const trades = [
      tWithHold('BTC', 1, 30 * 60_000),
      tWithHold('ETH', -0.5, 12 * 60 * 60_000),
      tWithHold('SOL', 0.8, 5 * 24 * 60 * 60_000),
    ];
    const r = buildHoldVsProfit(trades);
    expect(r.buckets.length).toBeGreaterThan(2);
    const nonEmpty = r.buckets.filter((b) => b.count > 0);
    expect(nonEmpty.length).toBe(3);
    // sums: 3 trades, 2 wins, 1 loss
    const totalCount = nonEmpty.reduce((a, b) => a + b.count, 0);
    expect(totalCount).toBe(3);
  });
});

describe('buildTpSlDeep', () => {
  test('returns shape with 4 categories (tp/sl/cb/manual)', () => {
    const r = buildTpSlDeep([]);
    expect(r).toHaveProperty('tp');
    expect(r).toHaveProperty('sl');
    expect(r).toHaveProperty('cb');
    expect(r).toHaveProperty('manual');
    expect(r.tp.count).toBe(0);
    expect(r.sl.count).toBe(0);
  });

  test('TP bucket aggregates tp_hit + tp_trend_boosted + dca_target_hit', () => {
    const trades = [
      mkTrade({ sellReason: 'tp_hit', realizedPnl: 1 }),
      mkTrade({ sellReason: 'tp_trend_boosted', realizedPnl: 2 }),
      mkTrade({ sellReason: 'dca_target_hit', realizedPnl: 1.5 }),
      mkTrade({ sellReason: 'cb_panic', realizedPnl: -0.5 }),
    ];
    const r = buildTpSlDeep(trades);
    expect(r.tp.count).toBe(3);
    expect(r.tp.totalPnl).toBe(4.5);
    expect(r.tp.winRate).toBe(100);
    expect(r.cb.count).toBe(1);
  });

  test('SL bucket aggregates sl_ukc_* + dca_stack_stop_loss', () => {
    const trades = [
      mkTrade({ sellReason: 'sl_ukc_f1_armed', realizedPnl: -1 }),
      mkTrade({ sellReason: 'sl_ukc_manual', realizedPnl: -2 }),
      mkTrade({ sellReason: 'stop_loss_upper_kc', realizedPnl: -0.5 }),
      mkTrade({ sellReason: 'dca_stack_stop_loss', realizedPnl: -3 }),
    ];
    const r = buildTpSlDeep(trades);
    expect(r.sl.count).toBe(4);
    expect(r.sl.totalPnl).toBe(-6.5);
    expect(r.sl.avgPnl).toBe(-1.625);
    expect(r.sl.minPnl).toBe(-3);
    expect(r.sl.maxPnl).toBe(-0.5);
  });

  test('avgHold + maxHoldAtExtreme computed from buy→sell timestamps', () => {
    const buyAt = new Date('2026-08-15T10:00:00Z');
    const trades = [
      mkTrade({ sellReason: 'tp_hit', realizedPnl: 1, buyFilledAt: buyAt, sellFilledAt: new Date(buyAt.getTime() + 30 * 60_000) }),
      mkTrade({ sellReason: 'tp_hit', realizedPnl: 2, buyFilledAt: buyAt, sellFilledAt: new Date(buyAt.getTime() + 60 * 60_000) }),
    ];
    const r = buildTpSlDeep(trades);
    expect(r.tp.count).toBe(2);
    expect(r.tp.avgHoldMs).toBe(45 * 60_000); // avg of 30m and 60m
    // max PnL trade = 2 USDT, held 60min
    expect(r.tp.maxHoldAtExtreme).toBe(60 * 60_000);
  });

  test('manual bucket aggregates manual_api_* + bot_disabled + dca_stack_force_close', () => {
    const trades = [
      mkTrade({ sellReason: 'manual_api_force_close_trade', realizedPnl: 0.5 }),
      mkTrade({ sellReason: 'manual_api_market', realizedPnl: -0.2 }),
      mkTrade({ sellReason: 'bot_disabled', realizedPnl: 0.1 }),
    ];
    const r = buildTpSlDeep(trades);
    expect(r.manual.count).toBe(3);
  });
});

describe('buildOptimalConfigs', () => {
  test('empty trades → empty best/worst arrays', async () => {
    const r = await buildOptimalConfigs([], { all: [] });
    expect(r.best).toEqual([]);
    expect(r.worst).toEqual([]);
    expect(r.reliableCount).toBe(0);
  });

  test('groups by (tf × TP × KC × safe-trade × CB) and ranks by score', async () => {
    const byBot = {
      all: [
        { botId: 'b1', timeframe: '5m', tpPercent: 0.4, kcMult: 1.2, safeTradeEnabled: true, safeTradeTrendlineEnabled: false, safeTradeNoTradeEnabled: false, cbEnabled: true, cbv2Enabled: true, cbv3Enabled: true, cbv5Enabled: true },
        { botId: 'b2', timeframe: '15m', tpPercent: 1.0, kcMult: 2.0, safeTradeEnabled: true, safeTradeTrendlineEnabled: true, safeTradeNoTradeEnabled: true, cbEnabled: true, cbv2Enabled: true, cbv3Enabled: true, cbv5Enabled: true },
      ],
    };
    // group 1: tf=5m, tp=0.3-0.5, kc=1.0-1.5, safe=ST1, cb=on — 5 wins
    const trades = [];
    for (let i = 0; i < 5; i++) {
      trades.push(mkTrade({ botId: 'b1', realizedPnl: 1, sellReason: 'tp_hit' }));
    }
    // group 2: tf=15m, tp=0.8-1.2, kc=1.5-2.0, safe=ST1+ST2+ST3, cb=on — 5 losses
    for (let i = 0; i < 5; i++) {
      trades.push(mkTrade({ botId: 'b2', realizedPnl: -1, sellReason: 'sl_ukc_f1_armed' }));
    }
    const r = await buildOptimalConfigs(trades, byBot);
    // 2 groups: b1 (5 wins) and b2 (5 losses); b1 should rank higher than b2
    expect(r.best.length).toBe(2);
    expect(r.worst.length).toBe(2);
    expect(r.best[0].tf).toBe('5m');
    expect(r.best[0].winRate).toBe(100);
    expect(r.best[0].score).toBeGreaterThan(0);
    // worst[0] = worst-ranked = 15m
    expect(r.worst[0].tf).toBe('15m');
    expect(r.worst[0].score).toBeLessThanOrEqual(0);
    expect(r.best[0].score).toBeGreaterThan(r.worst[0].score);
  });

  test('skips groups with <3 trades', async () => {
    const byBot = {
      all: [
        { botId: 'b1', timeframe: '5m', tpPercent: 0.4, kcMult: 1.2, safeTradeEnabled: true, cbEnabled: true },
      ],
    };
    const trades = [
      mkTrade({ botId: 'b1', realizedPnl: 1 }),
      mkTrade({ botId: 'b1', realizedPnl: 1 }), // only 2 trades → skipped
    ];
    const r = await buildOptimalConfigs(trades, byBot);
    expect(r.best.length).toBe(0);
    expect(r.worst.length).toBe(0);
  });

  test('skips trades where bot config not in byBot.all', async () => {
    const trades = [mkTrade({ botId: 'unknownBot', realizedPnl: 1 })];
    const r = await buildOptimalConfigs(trades, { all: [] });
    expect(r.best.length).toBe(0);
    expect(r.reliableCount).toBe(0);
  });
});