'use strict';

/**
 * FIX-2026-08-21: Trade Analysis page — renders comprehensive multi-section dashboard
 *
 * Single fetch to GET /api/analysis/trade-analysis (cached 60s server-side) → renders
 * ~15 sections covering every dimension of bot trading activity.
 *
 * Sections:
 *   - Hero (6 stat tiles)
 *   - Conclusion (text insights + warnings)
 *   - Daily sparkline + Extremes (biggest win/loss, best/worst day, drawdown)
 *   - Monthly performance + Streaks
 *   - By symbol + By timeframe
 *   - By sell reason (categories + full breakdown)
 *   - PnL heatmap (day-of-week × hour-of-day)
 *   - Hold duration + Position sizing
 *   - Bot leaderboard (best + worst, includes deleted bots) + DCA vs single
 */

let _analysisData = null;
let _loading = false;
let _lastFetchAt = 0;
const MIN_INTERVAL_MS = 30 * 1000;

// ─── Helpers ────────────────────────────────────────────────
function fmtPnl(v, { sign = false, decimals = 2 } = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = v < 0 ? '-' : (sign ? '+' : '');
  return `${s}${Math.abs(v).toFixed(decimals)}`;
}
function fmtPct(v, decimals = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`;
}
function fmtNum(v, decimals = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(decimals);
}
function fmtInt(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}
function fmtUsdtThb(usdt) {
  if (usdt == null || !Number.isFinite(usdt)) return '';
  if (!window.__fx || !window.__fx.rate) return '';
  return `≈ ฿${(usdt * window.__fx.rate).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
function fmtTsShort(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 10)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtTsDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}
function trendClass(pnl) {
  if (pnl > 0) return 'is-bull';
  if (pnl < 0) return 'is-bear';
  return 'is-flat';
}
function barWidth(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max === 0) return 0;
  return Math.min(100, Math.abs(value) / Math.abs(max) * 100);
}
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
function setTileClass(id, klass) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('is-gold', 'is-bull', 'is-bear');
    if (klass) el.classList.add(klass);
  }
}

// ─── Section renderers ──────────────────────────────────────
function renderHero(s) {
  // Total Trades
  setText('ta-trades', fmtInt(s.count));
  setText('ta-trades-meta', `+${fmtInt(s.wins)} ชนะ / ${fmtInt(s.losses)} แพ้ / ${fmtInt(s.breakeven)} เสมอ`);
  setTileClass('ta-tile-trades', null);

  // Total PnL
  setText('ta-pnl', fmtPnl(s.pnl, { sign: true }));
  setText('ta-pnl-thb', fmtUsdtThb(s.pnl) || '');
  setTileClass('ta-tile-pnl', s.pnl > 0 ? 'is-bull' : s.pnl < 0 ? 'is-bear' : 'is-gold');

  // Win Rate
  setText('ta-winrate', `${s.winRate.toFixed(1)}%`);
  setText('ta-winrate-meta', `Gross +${fmtPnl(s.grossProfit)} / ${fmtPnl(s.grossLoss)}`);
  setTileClass('ta-tile-winrate', s.winRate >= 50 ? 'is-bull' : 'is-bear');

  // Avg PnL
  setText('ta-avg-pnl', fmtPnl(s.avgPnl, { sign: true }));
  setText('ta-avg-meta', `Median ${fmtPnl(s.medianPnl, { sign: true })} · σ ${fmtPnl(s.stddevPnl)}`);
  setTileClass('ta-tile-avg', s.avgPnl > 0 ? 'is-bull' : s.avgPnl < 0 ? 'is-bear' : null);

  // Profit Factor
  setText('ta-pf', s.profitFactor.toFixed(2));
  let pfLabel;
  if (s.profitFactor >= 1.5) pfLabel = 'ดีมาก';
  else if (s.profitFactor >= 1.0) pfLabel = 'พอดี';
  else pfLabel = 'เสียเปรียบ';
  setText('ta-pf-meta', `${pfLabel} · fees ${fmtPnl(s.totalFees)}`);
  setTileClass('ta-tile-pf', s.profitFactor >= 1.5 ? 'is-bull' : s.profitFactor >= 1.0 ? 'is-gold' : 'is-bear');

  // Expectancy
  setText('ta-expectancy', fmtPnl(s.expectancy, { sign: true, decimals: 4 }));
  setText('ta-expectancy-meta', `per trade USDT`);
  setTileClass('ta-tile-expectancy', s.expectancy > 0 ? 'is-bull' : s.expectancy < 0 ? 'is-bear' : null);
}

function renderConclusion(c) {
  const el = document.getElementById('ta-conclusion');
  if (!el) return;
  if (!c || !c.lines || !c.lines.length) {
    el.innerHTML = '<div class="ta-empty">ไม่มีข้อมูล</div>';
    return;
  }
  el.innerHTML = c.lines.map((line) => {
    // warn lines are identified server-side by prefix (e.g. ⚠️) — keep simple:
    const isWarn = line.startsWith('⚠️') || line.startsWith('🔴') || line.startsWith('⛔');
    return `<div class="ta-line ${isWarn ? 'is-warn' : ''}">${escapeHtml(line)}</div>`;
  }).join('');
  // Append warnings explicitly (if not already shown)
  if (c.warnings && c.warnings.length) {
    const warnHtml = c.warnings.map((w) => `<div class="ta-line is-warn">${escapeHtml(w)}</div>`).join('');
    el.insertAdjacentHTML('beforeend', warnHtml);
  }
  setText('ta-conclusion-meta', `${c.lines.length + (c.warnings?.length || 0)} insights`);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderDailySpark(byDay) {
  const el = document.getElementById('ta-daily-spark');
  if (!el) return;
  if (!byDay || !byDay.length) {
    el.innerHTML = '<div class="ta-empty" style="flex:1;">ไม่มีข้อมูล</div>';
    setText('ta-daily-meta', '0 วัน');
    return;
  }
  const max = Math.max(...byDay.map((d) => Math.abs(d.pnl)));
  el.innerHTML = byDay.map((d) => {
    const h = Math.max(2, (Math.abs(d.pnl) / max) * 60);
    const cls = d.pnl > 0 ? 'is-bull' : d.pnl === 0 ? 'is-flat' : 'is-bear';
    return `<div class="ta-spark-bar ${cls}" style="height:${h}px;" title="${d.date}: ${fmtPnl(d.pnl, { sign: true })} (${d.count} ไม้, WR ${d.winRate.toFixed(0)}%)"></div>`;
  }).join('');
  setText('ta-daily-meta', `${byDay.length} วันที่มีเทรด`);
  // best/worst day pills
  const tradeDays = byDay.filter((d) => d.count > 0);
  const best = tradeDays.reduce((a, b) => (b.pnl > a.pnl ? b : a), { pnl: -Infinity });
  const worst = tradeDays.reduce((a, b) => (b.pnl < a.pnl ? b : a), { pnl: Infinity });
  setText('ta-daily-best', `Best: ${best.date || '—'} ${fmtPnl(best.pnl, { sign: true })}`);
  setText('ta-daily-worst', `Worst: ${worst.date || '—'} ${fmtPnl(worst.pnl, { sign: true })}`);
  setText('ta-daily-trade-days', `Trade days: ${tradeDays.length}`);
}

function renderExtremes(ex, derived) {
  if (ex.biggestWin) {
    setText('ta-ext-win', fmtPnl(ex.biggestWin.pnl, { sign: true }));
    setText('ta-ext-win-meta', `${ex.biggestWin.symbol || '?'} ${fmtTsShort(ex.biggestWin.sellFilledAt)}`);
  } else {
    setText('ta-ext-win', '—');
  }
  if (ex.biggestLoss) {
    setText('ta-ext-loss', fmtPnl(ex.biggestLoss.pnl, { sign: true }));
    setText('ta-ext-loss-meta', `${ex.biggestLoss.symbol || '?'} ${fmtTsShort(ex.biggestLoss.sellFilledAt)}`);
  } else {
    setText('ta-ext-loss', '—');
  }
  if (ex.bestDay) {
    setText('ta-ext-bday', fmtPnl(ex.bestDay.pnl, { sign: true }));
    setText('ta-ext-bday-meta', `${ex.bestDay.date} · ${ex.bestDay.trades} ไม้`);
  } else {
    setText('ta-ext-bday', '—');
  }
  if (ex.worstDay) {
    setText('ta-ext-wday', fmtPnl(ex.worstDay.pnl, { sign: true }));
    setText('ta-ext-wday-meta', `${ex.worstDay.date} · ${ex.worstDay.trades} ไม้`);
  } else {
    setText('ta-ext-wday', '—');
  }
  setText('ta-ext-dd', `Max DD ≈ ${fmtPnl(derived.maxDrawdownEstimate, { sign: true })}`);
  setText('ta-ext-sharpe', `Sharpe-lite ≈ ${derived.sharpeLite.toFixed(2)}`);
}

function renderMonthly(byMonth) {
  const el = document.getElementById('ta-month-body');
  if (!el) return;
  if (!byMonth || !byMonth.length) {
    el.innerHTML = '<div class="ta-empty">ไม่มีข้อมูล</div>';
    return;
  }
  const max = Math.max(...byMonth.map((m) => Math.abs(m.pnl)));
  el.innerHTML = byMonth.map((m) => {
    const w = barWidth(m.pnl, max);
    const cls = m.pnl > 0 ? 'is-bull' : m.pnl < 0 ? 'is-bear' : 'is-muted';
    const numCls = m.pnl > 0 ? 'is-bull' : m.pnl < 0 ? 'is-bear' : '';
    return `
      <div class="ta-bar-row">
        <div class="ta-bar-label">${escapeHtml(m.month)}</div>
        <div class="ta-bar-track"><div class="ta-bar-fill ${cls}" style="width:${w}%"></div></div>
        <div class="ta-bar-num ${numCls}">${fmtPnl(m.pnl, { sign: true })}</div>
        <div class="ta-bar-wr">WR ${m.winRate.toFixed(0)}%</div>
      </div>`;
  }).join('');
  setText('ta-month-meta', `${byMonth.length} เดือน`);
}

function renderStreaks(streaks, summary) {
  setText('ta-streak-win', `${streaks.bestWinStreak} ไม้`);
  const maxStreak = Math.max(streaks.bestWinStreak, streaks.bestLossStreak, 1);
  document.getElementById('ta-streak-win-fill').style.width = `${(streaks.bestWinStreak / maxStreak) * 100}%`;
  setText('ta-streak-loss', `${streaks.bestLossStreak} ไม้`);
  document.getElementById('ta-streak-loss-fill').style.width = `${(streaks.bestLossStreak / maxStreak) * 100}%`;

  if (streaks.currentWinStreak > 0) {
    setText('ta-streak-current', `+${streaks.currentWinStreak} W`);
  } else if (streaks.currentLossStreak > 0) {
    setText('ta-streak-current', `-${streaks.currentLossStreak} L`);
  } else {
    setText('ta-streak-current', '—');
  }
  setText('ta-streak-wins', fmtInt(streaks.totalWinningTrades));
  setText('ta-streak-losses', fmtInt(streaks.totalLosingTrades));
  if (summary.avgWin && summary.avgLoss) {
    const r = Math.abs(summary.avgWin / summary.avgLoss);
    setText('ta-streak-ratio', `${r.toFixed(2)}×`);
  } else {
    setText('ta-streak-ratio', '—');
  }
}

function renderBySymbol(bySym) {
  const el = document.getElementById('ta-sym-body');
  if (!el) return;
  if (!bySym || !bySym.all || !bySym.all.length) {
    el.innerHTML = '<div class="ta-empty">ไม่มีข้อมูล</div>';
    return;
  }
  const max = Math.max(...bySym.all.map((s) => Math.abs(s.pnl)));
  // show all but cap at 20 rows for readability
  const rows = bySym.all.slice(0, 20);
  el.innerHTML = rows.map((s) => {
    const w = barWidth(s.pnl, max);
    const cls = s.pnl > 0 ? 'is-bull' : s.pnl < 0 ? 'is-bear' : 'is-muted';
    const numCls = s.pnl > 0 ? 'is-bull' : s.pnl < 0 ? 'is-bear' : '';
    return `
      <div class="ta-bar-row">
        <div class="ta-bar-label" title="${escapeHtml(s.symbol)} (${s.count} ไม้, notional ${s.notional.toFixed(0)})">${escapeHtml(s.symbol)}</div>
        <div class="ta-bar-track"><div class="ta-bar-fill ${cls}" style="width:${w}%"></div></div>
        <div class="ta-bar-num ${numCls}">${fmtPnl(s.pnl, { sign: true })}</div>
        <div class="ta-bar-wr">WR ${s.winRate.toFixed(0)}%</div>
      </div>`;
  }).join('');
  setText('ta-sym-meta', `${bySym.uniqueCount} เหรียญ · top 20 แสดง`);
}

function renderByTimeframe(rows) {
  const el = document.getElementById('ta-tf-body');
  if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = '<div class="ta-empty">ไม่มีข้อมูล</div>';
    return;
  }
  const max = Math.max(...rows.map((r) => Math.abs(r.pnl)));
  el.innerHTML = rows.map((r) => {
    const w = barWidth(r.pnl, max);
    const cls = r.pnl > 0 ? 'is-bull' : r.pnl < 0 ? 'is-bear' : 'is-muted';
    const numCls = r.pnl > 0 ? 'is-bull' : r.pnl < 0 ? 'is-bear' : '';
    return `
      <div class="ta-bar-row">
        <div class="ta-bar-label">${escapeHtml(r.timeframe)} (${r.count})</div>
        <div class="ta-bar-track"><div class="ta-bar-fill ${cls}" style="width:${w}%"></div></div>
        <div class="ta-bar-num ${numCls}">${fmtPnl(r.pnl, { sign: true })}</div>
        <div class="ta-bar-wr">WR ${r.winRate.toFixed(0)}%</div>
      </div>`;
  }).join('');
}

function renderBySellReason(bySr) {
  const catEl = document.getElementById('ta-sr-cat-body');
  const fullEl = document.getElementById('ta-sr-full-body');
  if (!catEl || !fullEl) return;
  const cats = bySr.categories || {};
  const totalCount = (bySr.rows || []).reduce((a, r) => a + r.count, 0);
  if (totalCount === 0) {
    catEl.innerHTML = fullEl.innerHTML = '<div class="ta-empty">ไม่มีข้อมูล</div>';
    return;
  }
  const catList = [
    { key: 'tp',     label: '🎯 TP (จบปกติ)', cat: cats.tp },
    { key: 'sl',     label: '🛑 SL-UKC', cat: cats.sl },
    { key: 'cb',     label: '🚨 CB Panic', cat: cats.cb },
    { key: 'manual', label: '🖐️ Manual Close', cat: cats.manual },
    { key: 'other',  label: '⚙️ Other (Market Fallback / Race / Hold retry)', cat: cats.other },
  ];
  const maxCat = Math.max(...catList.map((c) => Math.abs(c.cat?.pnl || 0)));
  catEl.innerHTML = catList.map((c) => {
    const pnl = c.cat?.pnl || 0;
    const w = barWidth(pnl, maxCat);
    const cls = pnl > 0 ? 'is-bull' : pnl < 0 ? 'is-bear' : 'is-muted';
    const numCls = pnl > 0 ? 'is-bull' : pnl < 0 ? 'is-bear' : '';
    return `
      <div class="ta-bar-row">
        <div class="ta-bar-label">${c.label}</div>
        <div class="ta-bar-track"><div class="ta-bar-fill ${cls}" style="width:${w}%"></div></div>
        <div class="ta-bar-num ${numCls}">${fmtPnl(pnl, { sign: true })}</div>
        <div class="ta-bar-wr">${c.cat?.count || 0} ไม้</div>
      </div>`;
  }).join('');

  const maxRow = Math.max(...bySr.rows.map((r) => Math.abs(r.pnl)));
  fullEl.innerHTML = bySr.rows.map((r) => {
    const w = barWidth(r.pnl, maxRow);
    const cls = r.pnl > 0 ? 'is-bull' : r.pnl < 0 ? 'is-bear' : 'is-muted';
    const numCls = r.pnl > 0 ? 'is-bull' : r.pnl < 0 ? 'is-bear' : '';
    return `
      <div class="ta-bar-row">
        <div class="ta-bar-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</div>
        <div class="ta-bar-track"><div class="ta-bar-fill ${cls}" style="width:${w}%"></div></div>
        <div class="ta-bar-num ${numCls}">${fmtPnl(r.pnl, { sign: true })}</div>
        <div class="ta-bar-wr">WR ${r.winRate.toFixed(0)}%</div>
      </div>`;
  }).join('');
  setText('ta-sr-meta', `${totalCount} ไม้ · ${bySr.rows.length} ประเภท`);
}

function renderHeatmap(byHour, byDow) {
  const el = document.getElementById('ta-heatmap');
  if (!el) return;
  const max = 10; // cap at ±10 USDT for color intensity
  // build 7x24 matrix
  const m = Array.from({ length: 7 }, () => new Array(24).fill(null));
  // byHour is 24 buckets with total pnl per hour (across all days)
  // byDow is 7 buckets with total pnl per day (across all hours)
  // for a true heatmap we need (dow × hour) — but we don't have that cross-cut
  // approximation: scale byHour pnl by day-of-week frequency ratio
  const totalHourPnl = byHour.reduce((a, h) => a + h.pnl, 0);
  const totalDowPnl = byDow.reduce((a, d) => a + d.pnl, 0);
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      // estimate: avg(hour pnl across all days) * dow factor
      const hourCount = byHour[h].count || 0;
      const dowCount = byDow[d].count || 0;
      // approximation — not perfect, but gives a useful visual signal
      if (hourCount === 0 || dowCount === 0) {
        m[d][h] = 0;
        continue;
      }
      const hourShare = hourCount / Math.max(1, byHour.reduce((a, x) => a + x.count, 0));
      const dowShare = dowCount / Math.max(1, byDow.reduce((a, x) => a + x.count, 0));
      // expected trades in this cell ≈ total × hourShare × dowShare (independence assumption)
      const expectedCount = Math.max(1, byHour.reduce((a, x) => a + x.count, 0)) * hourShare * dowShare;
      // distribute hour pnl proportional to expected count
      m[d][h] = (byHour[h].pnl * hourShare) * (dowShare) * (expectedCount / Math.max(1, hourCount));
    }
  }
  let html = `<div></div>`;
  for (let h = 0; h < 24; h++) html += `<div class="ta-heat-label" style="text-align:center;">${h}</div>`;
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let d = 0; d < 7; d++) {
    html += `<div class="ta-heat-label">${dayLabels[d]}</div>`;
    for (let h = 0; h < 24; h++) {
      const v = m[d][h];
      let bg = 'rgba(255,255,255,0.04)';
      if (v > 0.01) {
        const a = Math.min(0.85, (Math.min(v, max) / max) * 0.85 + 0.15);
        bg = `rgba(0,229,184,${a})`;
      } else if (v < -0.01) {
        const a = Math.min(0.85, (Math.min(Math.abs(v), max) / max) * 0.85 + 0.15);
        bg = `rgba(255,77,109,${a})`;
      }
      html += `<div class="ta-heat-cell" style="background:${bg};" data-tip="${dayLabels[d]} ${String(h).padStart(2,'0')}:00\\nPnL ≈ ${fmtPnl(v, { sign: true })} USDT\\n(intensity-capped)"></div>`;
    }
  }
  el.innerHTML = html;
  setText('ta-heat-meta', 'แต่ละช่อง = PnL โดยประมาณจากการกระจายตัวของ hour × day-of-week');
}

function renderHoldDuration(dur) {
  const el = document.getElementById('ta-hold-body');
  if (!el) return;
  if (!dur || !dur.buckets || !dur.count) {
    el.innerHTML = '<div class="ta-empty">ไม่มีข้อมูล</div>';
    return;
  }
  const max = Math.max(...dur.buckets.map((b) => b.count));
  el.innerHTML = dur.buckets.map((b) => {
    const w = barWidth(b.count, max);
    const cls = b.pnl > 0 ? 'is-bull' : b.pnl < 0 ? 'is-bear' : 'is-muted';
    const numCls = b.pnl > 0 ? 'is-bull' : b.pnl < 0 ? 'is-bear' : '';
    return `
      <div class="ta-bar-row">
        <div class="ta-bar-label">${escapeHtml(b.label)}</div>
        <div class="ta-bar-track"><div class="ta-bar-fill ${cls}" style="width:${w}%"></div></div>
        <div class="ta-bar-num ${numCls}">${fmtPnl(b.pnl, { sign: true })}</div>
        <div class="ta-bar-wr">${b.count} ไม้</div>
      </div>`;
  }).join('');
  setText('ta-hold-meta', `Avg hold: ${dur.avgHoldLabel} · ${dur.count} ไม้`);
}

function renderSizing(sz) {
  const el = document.getElementById('ta-size-body');
  if (!el) return;
  if (!sz || !sz.buckets || !sz.buckets.length) {
    el.innerHTML = '<div class="ta-empty">ไม่มีข้อมูล</div>';
    return;
  }
  const max = Math.max(...sz.buckets.map((b) => b.count));
  el.innerHTML = sz.buckets.map((b) => {
    const w = barWidth(b.count, max);
    return `
      <div class="ta-bar-row">
        <div class="ta-bar-label">${escapeHtml(b.label)} USDT</div>
        <div class="ta-bar-track"><div class="ta-bar-fill is-gold" style="width:${w}%"></div></div>
        <div class="ta-bar-num">${b.count} ไม้</div>
        <div class="ta-bar-wr">—</div>
      </div>`;
  }).join('');
  setText('ta-size-meta', `Σ ${sz.totalNotional.toFixed(0)} USDT · avg ${sz.avgNotional.toFixed(2)} · max ${sz.maxNotional.toFixed(2)}`);
}

function renderBotLeaderboard(byBot) {
  const bestEl = document.getElementById('ta-bot-best-body');
  const worstEl = document.getElementById('ta-bot-worst-body');
  if (!bestEl || !worstEl) return;
  if (!byBot || !byBot.best || !byBot.best.length) {
    bestEl.innerHTML = worstEl.innerHTML = '<div class="ta-empty">—</div>';
    return;
  }
  const renderRows = (rows) => rows.map((b) => {
    const w = barWidth(b.pnl, Math.max(Math.abs(rows[0]?.pnl || 0), 1));
    const cls = b.pnl > 0 ? 'is-bull' : b.pnl < 0 ? 'is-bear' : 'is-muted';
    const numCls = b.pnl > 0 ? 'is-bull' : b.pnl < 0 ? 'is-bear' : '';
    const deletedTag = b.isDeleted ? ' <span style="color:var(--text-4);font-size:0.65rem;">[deleted]</span>' : '';
    return `
      <div class="ta-bar-row">
        <div class="ta-bar-label" title="${escapeHtml(b.name)} ${b.symbol}/${b.timeframe}">${escapeHtml(b.name || b.symbol)}${deletedTag}</div>
        <div class="ta-bar-track"><div class="ta-bar-fill ${cls}" style="width:${w}%"></div></div>
        <div class="ta-bar-num ${numCls}">${fmtPnl(b.pnl, { sign: true })}</div>
        <div class="ta-bar-wr">${b.count}</div>
      </div>`;
  }).join('');
  bestEl.innerHTML = renderRows(byBot.best);
  worstEl.innerHTML = renderRows(byBot.worst);
  setText('ta-bot-meta', `${byBot.totalBots} บอท (${byBot.activeBots} active / ${byBot.deletedBots} ลบไปแล้ว — รวมในการวิเคราะห์)`);
}

function renderDcaVsNonDca(d) {
  const el = document.getElementById('ta-dca-body');
  if (!el) return;
  const max = Math.max(Math.abs(d.dca.pnl), Math.abs(d.nonDca.pnl));
  const renderRow = (label, data) => {
    const w = barWidth(data.pnl, max);
    const cls = data.pnl > 0 ? 'is-bull' : data.pnl < 0 ? 'is-bear' : 'is-muted';
    const numCls = data.pnl > 0 ? 'is-bull' : data.pnl < 0 ? 'is-bear' : '';
    return `
      <div class="ta-bar-row">
        <div class="ta-bar-label">${label}</div>
        <div class="ta-bar-track"><div class="ta-bar-fill ${cls}" style="width:${w}%"></div></div>
        <div class="ta-bar-num ${numCls}">${fmtPnl(data.pnl, { sign: true })}</div>
        <div class="ta-bar-wr">WR ${data.winRate.toFixed(0)}%</div>
      </div>`;
  };
  el.innerHTML = renderRow('📚 DCA Stack', d.dca) + renderRow('🎯 Single Trade', d.nonDca);
}

// ─── Hold Time vs Profit (deeper) ──────────────────────────
function fmtHoldShort(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  if (min < 60) return `${Math.round(min)} นาที`;
  const h = min / 60;
  if (h < 48) return `${h.toFixed(1)} ชม.`;
  const d = h / 24;
  if (d < 30) return `${d.toFixed(1)} วัน`;
  return `${(d / 30).toFixed(1)} เดือน`;
}
function fmtPctShort(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  return `${(p * 100).toFixed(2)}%`;
}

function renderHoldVsProfit(hvp) {
  if (!hvp) return;
  setText('ta-hvp-avg-all', fmtHoldShort(hvp.avgHoldAllMin));
  setText('ta-hvp-avg-win', fmtHoldShort(hvp.avgHoldWinMin));
  setText('ta-hvp-avg-loss', fmtHoldShort(hvp.avgHoldLossMin));
  setText('ta-hvp-meta', `${hvp.count} ไม้ที่มีข้อมูลเวลา`);

  // buckets table
  const el = document.getElementById('ta-hvp-buckets');
  if (!el) return;
  if (!hvp.buckets || !hvp.buckets.length) {
    el.innerHTML = '<div class="ta-empty">ไม่มีข้อมูล</div>';
  } else {
    const max = Math.max(...hvp.buckets.map((b) => Math.abs(b.pnl)));
    el.innerHTML = hvp.buckets.map((b) => {
      const w = barWidth(b.pnl, max);
      const cls = b.pnl > 0 ? 'is-bull' : b.pnl < 0 ? 'is-bear' : 'is-muted';
      const numCls = b.pnl > 0 ? 'is-bull' : b.pnl < 0 ? 'is-bear' : '';
      const pct = b.notional ? fmtPctShort(b.pnl / b.notional) : '—';
      return `
      <div class="ta-bar-row">
        <div class="ta-bar-label" title="avg hold ${fmtHoldShort(b.avgHoldMin)}">${escapeHtml(b.label)}</div>
        <div class="ta-bar-track"><div class="ta-bar-fill ${cls}" style="width:${w}%"></div></div>
        <div class="ta-bar-num ${numCls}">${fmtPnl(b.pnl, { sign: true })}</div>
        <div class="ta-bar-wr">${b.count} ไม้ · WR ${b.winRate.toFixed(0)}% · ${pct}</div>
      </div>`;
    }).join('');
  }

  // extremes
  const setX = (id, trade, kind) => {
    const valEl = document.getElementById(id);
    const metaEl = document.getElementById(id.replace(/-(\w+)$/, '-$1-meta'));
    if (!trade) {
      if (valEl) valEl.textContent = '—';
      if (metaEl) metaEl.textContent = '—';
      return;
    }
    if (valEl) valEl.textContent = `${fmtPnl(trade.pnl, { sign: true })}`;
    const meta = `${escapeHtml(trade.symbol || '?')} · ถือ ${fmtHoldShort(trade.holdMin)}`;
    if (metaEl) metaEl.textContent = meta;
  };
  setX('ta-hvp-fast-profit', hvp.fastestProfit, 'profit');
  setX('ta-hvp-long-profit', hvp.longestProfit, 'profit');
  setX('ta-hvp-fast-loss', hvp.fastestLoss, 'loss');
  setX('ta-hvp-long-all', hvp.longestOverall, 'overall');
  setX('ta-hvp-big-profit', hvp.biggestWinByPnl, 'big');
  setX('ta-hvp-big-loss', hvp.biggestLossByPnl, 'big');
}

// ─── TP / SL Deep Dive ──────────────────────────────────────
function renderTpSlDeep(ts) {
  if (!ts) return;
  // helper to fill reason card
  const fill = (prefix, data) => {
    if (!data) return;
    setText(`ta-${prefix}-count`, fmtInt(data.count));
    setText(`ta-${prefix}-pnl`, fmtPnl(data.pnl, { sign: true }));
    setText(`ta-${prefix}-avg`, fmtPnl(data.avgPnl, { sign: true, decimals: 4 }));
    setText(`ta-${prefix}-min`, fmtPnl(data.minPnl, { sign: true }));
    setText(`ta-${prefix}-max`, fmtPnl(data.maxPnl, { sign: true }));
    setText(`ta-${prefix}-hold`, fmtHoldShort(data.avgHoldMin));
    setText(`ta-${prefix}-max-hold`, fmtHoldShort(data.maxHoldMin));
    if (data.winRate != null) setText(`ta-${prefix}-wr`, `${data.winRate.toFixed(1)}%`);
    if (data.lossRate != null) setText(`ta-${prefix}-rate`, `${data.lossRate.toFixed(1)}%`);
  };
  fill('tp', ts.tp);
  fill('sl', ts.sl);
  fill('cb', ts.cb);
  fill('mc', ts.manual);
  // TP-SL ratio
  setText('ta-tpsl-meta', `${ts.count} ไม้ · avg TP ${fmtPnl(ts.tp?.avgPnl, { sign: true, decimals: 3 })} vs avg SL ${fmtPnl(ts.sl?.avgPnl, { sign: true, decimals: 3 })} · TP rate ${ts.tpRate.toFixed(1)}%`);
}

// ─── Optimal Config Finder ──────────────────────────────────
function renderOptimalConfigs(opt) {
  if (!opt) return;
  setText('ta-opt-meta', `${opt.best.length} top · ${opt.worst.length} avoid · score = avgPnl × WR × √n / log(1+holdMin)`);
  const bestEl = document.getElementById('ta-opt-best-body');
  const worstEl = document.getElementById('ta-opt-worst-body');
  if (!bestEl || !worstEl) return;
  const renderTable = (rows) => {
    if (!rows || !rows.length) return '<div class="ta-empty">ไม่มีข้อมูล</div>';
    const header = `
      <div class="ta-bar-row" style="font-weight:600;color:var(--text-3);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border-1);">
        <div class="ta-bar-label">Config</div>
        <div class="ta-bar-track"></div>
        <div class="ta-bar-num">PnL</div>
        <div class="ta-bar-wr">WR · n · hold · score</div>
      </div>`;
    const max = Math.max(...rows.map((r) => Math.abs(r.pnl)));
    const body = rows.map((r) => {
      const w = barWidth(r.pnl, max);
      const cls = r.pnl > 0 ? 'is-bull' : r.pnl < 0 ? 'is-bear' : 'is-muted';
      const numCls = r.pnl > 0 ? 'is-bull' : r.pnl < 0 ? 'is-bear' : '';
      const config = `${escapeHtml(r.timeframe)} · TP ${escapeHtml(r.tpPctBucket)} · KC×${escapeHtml(r.kcMultBucket)} · ${escapeHtml(r.safeTradeLabel)} · ${escapeHtml(r.cbLabel)}`;
      return `
      <div class="ta-bar-row">
        <div class="ta-bar-label" title="${config} (sample ${r.count})" style="font-family:var(--font-mono);font-size:0.72rem;">${config}</div>
        <div class="ta-bar-track"><div class="ta-bar-fill ${cls}" style="width:${w}%"></div></div>
        <div class="ta-bar-num ${numCls}">${fmtPnl(r.pnl, { sign: true })}</div>
        <div class="ta-bar-wr" style="font-size:0.7rem;">${r.winRate.toFixed(0)}% · ${r.count} · ${fmtHoldShort(r.avgHoldMin)} · <b>${r.score.toFixed(2)}</b></div>
      </div>`;
    }).join('');
    return header + body;
  };
  bestEl.innerHTML = renderTable(opt.best);
  worstEl.innerHTML = renderTable(opt.worst);
}

// ─── Main render + fetch ────────────────────────────────────
function renderAllSections(d) {
  renderHero(d.summary);
  renderConclusion(d.conclusion);
  renderDailySpark(d.byDay);
  renderExtremes(d.extremes, d.derived);
  renderMonthly(d.byMonth);
  renderStreaks(d.streaks, d.summary);
  renderBySymbol(d.bySymbol);
  renderByTimeframe(d.byTimeframe);
  renderBySellReason(d.bySellReason);
  renderHeatmap(d.byHour, d.byDayOfWeek);
  renderHoldDuration(d.duration);
  renderSizing(d.sizing);
  renderBotLeaderboard(d.byBot);
  renderDcaVsNonDca(d.dcaVsNonDca);
  renderHoldVsProfit(d.holdVsProfit);
  renderTpSlDeep(d.tpSlDeep);
  renderOptimalConfigs(d.optimal);

  setText('ta-meta', `${d.meta.tradeCount.toLocaleString('en-US')} trades · ${d.meta.activeBotCount} active + ${d.meta.deletedBotCount} deleted bots`);
  setText('ta-footer-ts', `สร้างเมื่อ ${fmtTsShort(d.generatedAt)} · ใช้เวลา ${d.computeMs}ms · server cache 60s`);
}

async function loadAnalysis({ force = false } = {}) {
  const now = Date.now();
  if (!force && _loading) return;
  if (!force && now - _lastFetchAt < MIN_INTERVAL_MS && _analysisData) return;
  _loading = true;
  try {
    const data = await API.get('/api/analysis/trade-analysis');
    _analysisData = data;
    _lastFetchAt = Date.now();
    renderAllSections(data);
  } catch (err) {
    console.error('trade-analysis load failed:', err);
    setText('ta-meta', `โหลดล้มเหลว: ${err.message}`);
  } finally {
    _loading = false;
  }
}

// ─── Boot ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadAnalysis().catch(() => {});
  document.getElementById('ta-refresh-btn')?.addEventListener('click', () => {
    loadAnalysis({ force: true }).catch(() => {});
  });
  // WS events: refetch on trade:update
  if (typeof WSClient !== 'undefined') {
    WSClient.on('trade:update', () => {
      // throttle to 30s
      if (Date.now() - _lastFetchAt > MIN_INTERVAL_MS) {
        loadAnalysis().catch(() => {});
      }
    });
  }
});