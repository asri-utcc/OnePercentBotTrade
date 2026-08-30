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
function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
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
    el.innerHTML = '<div class="ta-empty">ไม่มีข้อมูลเพียงพอสำหรับสรุปผล</div>';
    return;
  }

  // FIX-2026-08-29 UX: smarter insight categorization — each line gets a category badge
  // by detecting keywords / leading emoji, and we group them into 3 buckets:
  //   - 🟢 Good news  (green border, ✅ icon)
  //   - 🟡 Watch-out  (amber border, ⚠️ icon)
  //   - 🔴 Risk       (red border, 🚨 icon)
  // This makes the section scannable at a glance instead of a wall of identical text rows.
  const categorize = (line) => {
    if (/^(🚨|⛔|🔴|หยุด|ล้ม|ขาดทุนหนัก|ลบเยอะ|เสี่ยงสูง|ติดลบลึก)/.test(line)) return 'risk';
    if (/^(⚠️|🔻|ระวัง|ต่ำกว่า|ลดลง|ชะลอ|อ่อน|แย่)/.test(line)) return 'watch';
    if (/^(✅|🎯|🏆|📈|💎|🚀|ดี|แข็ง|กำไรสูง|ชนะ)/.test(line)) return 'good';
    // Default: keyword scan
    if (/ขาดทุน|ลบ|เสี่ยง|ล้ม|ติดลบ|panic|cb/i.test(line)) return 'risk';
    if (/ควร|ปรับ|ระวัง|ต่ำ|อ่อน/i.test(line)) return 'watch';
    return 'good';
  };

  const ICONS = { good: '✅', watch: '⚠️', risk: '🚨' };
  const LABELS = { good: 'ข่าวดี', watch: 'จับตา', risk: 'ความเสี่ยง' };

  // Group lines by category while preserving order within each group
  const buckets = { good: [], watch: [], risk: [] };
  for (const line of c.lines) {
    buckets[categorize(line)].push(line);
  }
  // Append warnings to risk bucket
  if (c.warnings && c.warnings.length) {
    for (const w of c.warnings) buckets.risk.push(w);
  }

  const sectionHtml = (key, rows) => {
    if (!rows.length) return '';
    const items = rows.map((line) => `
      <div class="ta-insight-item ta-insight-${key}">
        <div class="ta-insight-icon">${ICONS[key]}</div>
        <div class="ta-insight-text">${escapeHtml(line.replace(/^[⚠️🚨✅🔴⛔🔻]+\s*/, ''))}</div>
      </div>`).join('');
    return `
      <div class="ta-insight-group">
        <div class="ta-insight-header ta-insight-header-${key}">
          <span class="ta-insight-dot"></span>
          ${LABELS[key]}
          <span class="ta-insight-count">${rows.length}</span>
        </div>
        <div class="ta-insight-list">${items}</div>
      </div>`;
  };

  // Order: risk first (most attention), then watch, then good (positive reinforcement)
  const ordered = ['risk', 'watch', 'good']
    .map((k) => sectionHtml(k, buckets[k]))
    .filter(Boolean)
    .join('');

  // Top-line verdict summary
  const totalCount = c.lines.length + (c.warnings?.length || 0);
  const verdict = buckets.risk.length > buckets.good.length
    ? { tone: 'risk', label: '⚠️ ระวัง: มีจุดที่ต้องเฝ้าดู' }
    : buckets.good.length > buckets.risk.length * 2
      ? { tone: 'good', label: '✅ ภาพรวมดี — ทำต่อตามแผน' }
      : { tone: 'watch', label: '⚖️ สมดุล — ปรับจูนต่อได้' };

  el.innerHTML = `
    <div class="ta-verdict ta-verdict-${verdict.tone}">
      <div class="ta-verdict-icon">${verdict.tone === 'good' ? '🎯' : verdict.tone === 'watch' ? '⚖️' : '🚨'}</div>
      <div class="ta-verdict-text">${verdict.label}</div>
      <div class="ta-verdict-count">${totalCount} insights · ${buckets.good.length} ดี · ${buckets.watch.length} จับตา · ${buckets.risk.length} เสี่ยง</div>
    </div>
    <div class="ta-insights-grid">${ordered}</div>`;

  setText('ta-conclusion-meta', `${totalCount} insights`);
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

// Heatmap view state — persists across re-renders so switching tab/metric
// doesn't need a round-trip to the API (the matrices for both views ship together).
const HEAT_MIN_TRADES = 3; // win-rate mode: below this a slot is too thin to read
const heatState = { heatmap: null, view: 'sell', metric: 'pnl', holdStat: 'median' };

// Hold-time bands. With a near-100% win rate the interesting question isn't whether a
// trade won but how long it sat there, so hold time gets its own non-diverging scale:
// fast is green, a multi-day bag is red.
const HOLD_BANDS = [
  { maxMin: 30, rgb: '0,229,184', label: '≤30 นาที' },
  { maxMin: 240, rgb: '255,209,102', label: '30 นาที–4 ชม.' },
  { maxMin: 1440, rgb: '255,159,67', label: '4–24 ชม.' },
  { maxMin: Infinity, rgb: '255,77,109', label: '>1 วัน' },
];

function holdBandOf(minutes) {
  return HOLD_BANDS.find((b) => minutes <= b.maxMin) || HOLD_BANDS[HOLD_BANDS.length - 1];
}

function fmtHold(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  if (minutes < 60) return Math.round(minutes) + 'm';
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const mm = Math.round(minutes % 60);
    return mm ? `${h}h ${mm}m` : `${h}h`;
  }
  const d = Math.floor(minutes / 1440);
  const h = Math.round((minutes % 1440) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

// pool = every hold time attributed to a slot, closed AND still-open. Including the
// open ones matters: a slot whose trades all turned into bags would otherwise look
// clean simply because none of them have closed yet.
function holdStatOf(pool, stat) {
  if (!pool.length) return null;
  if (stat === 'avg') return pool.reduce((a, b) => a + b, 0) / pool.length;
  const sorted = pool.slice().sort((a, b) => a - b);
  return quantile(sorted, stat === 'p75' ? 0.75 : 0.5);
}

function renderHeatmap(heatmap) {
  heatState.heatmap = heatmap || null;
  drawHeatmap();
}

function heatMatrix() {
  const hm = heatState.heatmap;
  if (!hm) return null;
  const m = heatState.view === 'buy' ? hm.buy : hm.sell;
  const ok = Array.isArray(m) && m.length === 7 && Array.isArray(m[0]) && m[0].length === 24;
  return ok ? m : null;
}

function drawHeatmap() {
  const el = document.getElementById('ta-heatmap');
  if (!el) return;
  const isWr = heatState.metric === 'wr';
  const isHold = heatState.metric === 'hold';
  const isBuy = heatState.view === 'buy';
  const matrix = heatMatrix();
  if (!matrix) {
    setText('ta-heat-meta', 'ไม่มีข้อมูล');
    setHtml('ta-heat-summary', '<div class="ta-empty">ไม่มีข้อมูล</div>');
    setHtml('ta-heat-marg-day', '<div class="ta-empty">—</div>');
    setHtml('ta-heat-marg-hour', '<div class="ta-empty">—</div>');
    const det = document.getElementById('ta-heat-detail');
    if (det) det.style.display = 'none';
    el.innerHTML = '<div class="ta-empty" style="grid-column: 1 / -1;">ไม่มีข้อมูล</div>';
    return;
  }

  // m[d][h] = the value we colour by; cellStats keeps the raw numbers for tooltips/detail.
  // pnl  → net USDT (diverging, neutral 0, cap ±10)
  // wr   → win-rate % (diverging, neutral 50, cap ±25)
  // hold → minutes held (banded green→red, lower is better)
  const cellStats = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({
    count: 0, wins: 0, losses: 0, pnl: 0, pool: [], openCount: 0,
  })));
  const m = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const thin = Array.from({ length: 7 }, () => new Array(24).fill(false));
  const hasVal = Array.from({ length: 7 }, () => new Array(24).fill(false));
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
    const cell = matrix[d][h] || {};
    const holds = Array.isArray(cell.holds) ? cell.holds : [];
    const holdsOpen = Array.isArray(cell.holdsOpen) ? cell.holdsOpen : [];
    const s = {
      count: cell.count || 0,
      wins: cell.wins || 0,
      losses: cell.losses || 0,
      pnl: Number(cell.pnl || 0),
      pool: holds.concat(holdsOpen),
      openCount: holdsOpen.length,
    };
    cellStats[d][h] = s;
    if (isHold) {
      const stat = holdStatOf(s.pool, heatState.holdStat);
      hasVal[d][h] = stat !== null;
      thin[d][h] = s.pool.length > 0 && s.pool.length < HEAT_MIN_TRADES;
      m[d][h] = stat === null ? 0 : stat;
    } else if (isWr) {
      hasVal[d][h] = s.count > 0;
      thin[d][h] = s.count > 0 && s.count < HEAT_MIN_TRADES;
      m[d][h] = s.count > 0 ? (s.wins / s.count) * 100 : 0;
    } else {
      hasVal[d][h] = s.count > 0;
      m[d][h] = s.pnl;
    }
  }

  const cap = isWr ? 25 : 10;
  const neutral = isWr ? 50 : 0;
  const fmtVal = (v, d, h) => {
    if (d != null && !hasVal[d][h]) return '—';
    if (isHold) return fmtHold(v);
    if (isWr) return v.toFixed(0) + '%';
    return fmtPnl(v, { sign: true }) + ' USDT';
  };
  // Score: higher = better, null = not eligible to be ranked. For hold time "better"
  // means shorter, so the sign flips.
  const scoreOf = (d, h) => {
    if (!hasVal[d][h]) return null;
    if (isHold) return cellStats[d][h].pool.length >= HEAT_MIN_TRADES ? -m[d][h] : null;
    if (isWr) return cellStats[d][h].count >= HEAT_MIN_TRADES ? m[d][h] - neutral : null;
    return m[d][h];
  };

  const dayLabels = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  const dayFull = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

  // Header row
  let html = '<div class="ta-heat-corner"></div>';
  for (let h = 0; h < 24; h++) {
    const show = h % 3 === 0;
    html += '<div class="ta-heat-hour-label' + (show ? '' : ' is-minor') + '">' + (show ? String(h).padStart(2, '0') : '') + '</div>';
  }

  // Aggregate stats per cell
  let bestSlot = null;
  let worstSlot = null;
  let mostActiveSlot = { d: 0, h: 0, v: 0 };
  let totalTradesInCells = 0;
  let totalWinsInCells = 0;
  let totalPnlCells = 0;
  let totalOpenInCells = 0;
  const allHolds = [];
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
    const s = cellStats[d][h];
    if (s.count > 0) {
      totalTradesInCells += s.count;
      totalWinsInCells += s.wins;
      totalPnlCells += s.pnl;
    }
    totalOpenInCells += s.openCount;
    for (const v of s.pool) allHolds.push(v);
    const activity = isHold ? s.pool.length : s.count;
    if (activity > mostActiveSlot.v) mostActiveSlot = { d, h, v: activity };
    const r = scoreOf(d, h);
    if (r === null) continue;
    // pnl mode keeps its "profitable / losing" semantics; the other metrics rank the
    // whole eligible field, because "least slow" is still worth surfacing.
    const eligibleBest = isHold || isWr ? true : r > 0;
    const eligibleWorst = isHold || isWr ? true : r < 0;
    if (eligibleBest && (!bestSlot || r > bestSlot.r)) bestSlot = { d, h, r, v: m[d][h] };
    if (eligibleWorst && (!worstSlot || r < worstSlot.r)) worstSlot = { d, h, r, v: m[d][h] };
  }
  if (bestSlot && worstSlot && bestSlot.d === worstSlot.d && bestSlot.h === worstSlot.h) worstSlot = null;

  for (let d = 0; d < 7; d++) {
    html += '<div class="ta-heat-day-label" title="' + dayFull[d] + '">' + dayLabels[d] + '</div>';
    for (let h = 0; h < 24; h++) {
      const v = m[d][h];
      const s = cellStats[d][h];
      let bg = 'rgba(255,255,255,0.04)';
      let cls = '';
      if (hasVal[d][h] && isHold) {
        // Banded scale: the band picks the hue, position inside the band the alpha,
        // so neighbouring slots in the same band are still distinguishable.
        const band = holdBandOf(v);
        const lo = HOLD_BANDS[HOLD_BANDS.indexOf(band) - 1]?.maxMin || 0;
        const span = Number.isFinite(band.maxMin) ? band.maxMin - lo : Math.max(1440, v - lo);
        const frac = Math.min(1, Math.max(0, (v - lo) / Math.max(1, span)));
        const a = (0.35 + frac * 0.5) * (thin[d][h] ? 0.45 : 1);
        bg = 'rgba(' + band.rgb + ',' + a + ')';
        cls = band === HOLD_BANDS[0] ? 'is-bull' : band === HOLD_BANDS[HOLD_BANDS.length - 1] ? 'is-bear' : '';
      } else if (hasVal[d][h]) {
        const dev = v - neutral;
        if (dev > 0.01) {
          const a = Math.min(0.85, (Math.min(dev, cap) / cap) * 0.85 + 0.15) * (thin[d][h] ? 0.45 : 1);
          bg = 'rgba(0,229,184,' + a + ')';
          cls = 'is-bull';
        } else if (dev < -0.01) {
          const a = Math.min(0.85, (Math.min(Math.abs(dev), cap) / cap) * 0.85 + 0.15) * (thin[d][h] ? 0.45 : 1);
          bg = 'rgba(255,77,109,' + a + ')';
          cls = 'is-bear';
        }
      }
      if (bestSlot && d === bestSlot.d && h === bestSlot.h) cls += ' is-peak';
      // density ring — borders grow thicker with log of trade count
      const density = isHold ? s.pool.length : s.count;
      const ringAlpha = density > 0 ? Math.min(0.35, 0.08 + Math.log10(density + 1) * 0.18) : 0;
      const densityRing = density > 0 ? (' border:1px solid rgba(255,255,255,' + ringAlpha + ');') : '';
      const holdLines = s.pool.length
        ? '• Median: ' + fmtHold(holdStatOf(s.pool, 'median')) + '\n'
          + '• Avg: ' + fmtHold(holdStatOf(s.pool, 'avg')) + '\n'
          + '• P75: ' + fmtHold(holdStatOf(s.pool, 'p75')) + '\n'
          + '• Longest: ' + fmtHold(Math.max(...s.pool)) + '\n'
          + (s.openCount ? '• ยังถืออยู่: ' + s.openCount + ' ไม้\n' : '')
        : '';
      const detailMd = '**' + dayFull[d] + ' ' + String(h).padStart(2, '0') + ':00** '
        + (isBuy ? '(เวลาที่ซื้อ)' : '(เวลาที่ขาย)') + '\n\n'
        + (isHold
          ? (s.pool.length
            ? holdLines + '• ไม้ที่ปิดแล้ว: ' + (s.pool.length - s.openCount) + '\n'
              + (thin[d][h] ? '\n⚠️ น้อยกว่า ' + HEAT_MIN_TRADES + ' ไม้ — สีจางลง\n' : '')
              + '\nคลิกเพื่อดูรายละเอียด'
            : '• (no trades in this slot)')
          : (s.count > 0
            ? '• PnL: ' + fmtPnl(s.pnl, { sign: true }) + ' USDT\n'
              + '• Trades: ' + s.count + ' (' + s.wins + 'W / ' + s.losses + 'L)\n'
              + '• Win rate: ' + ((s.wins / s.count) * 100).toFixed(0) + '%\n'
              + '• Avg/trade: ' + fmtPnl(s.pnl / s.count, { sign: true }) + ' USDT\n'
              + (thin[d][h] ? '\n⚠️ ไม้น้อยกว่า ' + HEAT_MIN_TRADES + ' ไม้ — สีจางลง\n' : '')
              + '\nคลิกเพื่อดูรายละเอียด'
            : '• (no trades in this slot)'));
      html += '<div class="ta-heat-cell ' + cls + '" style="background:' + bg + ';' + densityRing + '"'
        + ' data-d="' + d + '" data-h="' + h + '" data-pnl="' + s.pnl + '" data-count="' + s.count + '" data-wins="' + s.wins + '" data-losses="' + s.losses + '"'
        + ' data-tip="' + detailMd + '"></div>';
    }
  }
  el.innerHTML = html;

  // Click handler: show detail panel
  el.querySelectorAll('.ta-heat-cell').forEach((node) => {
    node.addEventListener('click', () => {
      const d = Number(node.getAttribute('data-d'));
      const h = Number(node.getAttribute('data-h'));
      const v = Number(node.getAttribute('data-pnl'));
      const cnt = Number(node.getAttribute('data-count'));
      const wins = Number(node.getAttribute('data-wins'));
      const losses = Number(node.getAttribute('data-losses'));
      el.querySelectorAll('.ta-heat-cell.is-active').forEach((n) => n.classList.remove('is-active'));
      node.classList.add('is-active');
      showHeatDetail(d, h, dayFull, isBuy, cellStats[d][h]);
    });
  });

  const missNote = (isBuy && heatState.heatmap && heatState.heatmap.buyMissing)
    ? ' · ' + heatState.heatmap.buyMissing + ' ไม้ไม่มีเวลาซื้อ'
    : '';
  const holdStatLabel = { median: 'Median', avg: 'Average', p75: 'P75' }[heatState.holdStat];
  const metricLabel = isHold ? ('⏱ Hold time · ' + holdStatLabel) : isWr ? 'Win rate' : 'Net PnL';
  const openNote = (isHold && isBuy && totalOpenInCells) ? ' · ' + totalOpenInCells + ' ไม้ยังถืออยู่' : '';
  setText('ta-heat-meta', (isBuy ? '🛒 เวลาที่ซื้อ' : '💰 เวลาที่ขาย') + ' · '
    + metricLabel + ' · ' + totalTradesInCells + ' ไม้' + openNote + missNote);

  // Summary tiles (4 cards)
  const winRate = totalTradesInCells > 0 ? ((totalWinsInCells / totalTradesInCells) * 100).toFixed(1) : '—';
  const avgPnlPerTrade = totalTradesInCells > 0 ? fmtPnl(totalPnlCells / totalTradesInCells, { sign: true }) : '—';
  const slotSub = (slot, fallback) => (slot
    ? (dayFull[slot.d] + ' ' + String(slot.h).padStart(2, '0') + ':00 · '
       + fmtVal(slot.v, slot.d, slot.h) + ' · '
       + (isHold ? cellStats[slot.d][slot.h].pool.length : cellStats[slot.d][slot.h].count) + ' ไม้')
    : fallback);
  const activeSub = mostActiveSlot.v > 0
    ? (dayFull[mostActiveSlot.d] + ' ' + String(mostActiveSlot.h).padStart(2, '0') + ':00')
    : 'no trades yet';
  const thinFallback = 'ยังไม่มีช่องที่ถึง ' + HEAT_MIN_TRADES + ' ไม้';
  const bestLabel = isHold
    ? (isBuy ? '⚡ ซื้อแล้วจบไวสุด' : '⚡ ขายไวสุด')
    : (isBuy ? '🏆 ซื้อแล้วดีสุด' : '🏆 ขายแล้วดีสุด');
  const worstLabel = isHold
    ? (isBuy ? '🐌 ซื้อแล้วดอยนานสุด' : '🐌 ถือนานสุด')
    : (isBuy ? '💀 ซื้อแล้วแย่สุด' : '💀 ขายแล้วแย่สุด');
  // 4th tile swaps to overall hold time in hold mode — with a ~100% win rate the
  // win-rate tile there would just read "100%" and tell you nothing.
  const overallHold = holdStatOf(allHolds, heatState.holdStat);
  const lastTile = isHold
    ? '<div class="ta-heat-summary-tile">'
        + '<span class="label">⏱ ' + holdStatLabel + ' รวม</span>'
        + '<span class="value">' + fmtHold(overallHold) + '</span>'
        + '<span class="sub">' + allHolds.length + ' ไม้'
        + (totalOpenInCells ? ' · ยังถืออยู่ ' + totalOpenInCells : '') + '</span>'
      + '</div>'
    : '<div class="ta-heat-summary-tile">'
        + '<span class="label">🎲 Win rate</span>'
        + '<span class="value">' + winRate + (totalTradesInCells > 0 ? '%' : '') + '</span>'
        + '<span class="sub">' + totalTradesInCells + ' trades · avg ' + avgPnlPerTrade + ' USDT/trade</span>'
      + '</div>';
  const summaryHtml = ''
    + '<div class="ta-heat-summary-tile is-bull">'
      + '<span class="label">' + bestLabel + '</span>'
      + '<span class="value">' + (bestSlot ? fmtVal(bestSlot.v, bestSlot.d, bestSlot.h) : '—') + '</span>'
      + '<span class="sub">' + slotSub(bestSlot, (isWr || isHold) ? thinFallback : 'no profitable slot') + '</span>'
    + '</div>'
    + '<div class="ta-heat-summary-tile is-bear">'
      + '<span class="label">' + worstLabel + '</span>'
      + '<span class="value">' + (worstSlot ? fmtVal(worstSlot.v, worstSlot.d, worstSlot.h) : '—') + '</span>'
      + '<span class="sub">' + slotSub(worstSlot, (isWr || isHold) ? thinFallback : 'no losing slot') + '</span>'
    + '</div>'
    + '<div class="ta-heat-summary-tile">'
      + '<span class="label">🎯 Most active</span>'
      + '<span class="value">' + (mostActiveSlot.v > 0 ? mostActiveSlot.v + ' trades' : '—') + '</span>'
      + '<span class="sub">' + activeSub + '</span>'
    + '</div>'
    + lastTile;
  setHtml('ta-heat-summary', summaryHtml);

  // Marginal aggregates (right column). A marginal pools the raw trades of the whole
  // row/column rather than averaging cell values — averaging would let a slot holding
  // one trade weigh as much as a slot holding fifty.
  // In hold mode the bar is one-sided (0 → slowest) since there is no neutral point.
  const margRow = (label, agg) => {
    const v = agg.value;
    let w; let cls; let side;
    if (!agg.has) {
      w = 0; cls = 'is-zero'; side = 'left:50%';
    } else if (isHold) {
      w = Math.min(100, (v / Math.max(1e-9, agg.maxAbs)) * 100);
      cls = holdBandOf(v) === HOLD_BANDS[0] ? 'is-bull' : holdBandOf(v) === HOLD_BANDS[HOLD_BANDS.length - 1] ? 'is-bear' : 'is-warn';
      side = 'left:0';
    } else {
      const dev = v - neutral;
      w = Math.min(50, (Math.abs(dev) / Math.max(1e-9, agg.maxAbs)) * 50);
      cls = dev > 0 ? 'is-bull' : dev < 0 ? 'is-bear' : 'is-zero';
      side = dev >= 0 ? 'left:50%' : 'left:' + (50 - w) + '%';
    }
    const text = !agg.has ? '—' : isHold ? fmtHold(v) : isWr ? v.toFixed(0) + '%' : fmtPnl(v, { sign: true });
    return '<div class="ta-heat-marg-row">'
      + '<span class="ta-heat-marg-label">' + label + '</span>'
      + '<div class="ta-heat-marg-bar-wrap"><div class="ta-heat-marg-bar ' + cls + '" style="width:' + w + '%;' + side + ';"></div></div>'
      + '<span class="ta-heat-marg-pnl ' + cls + '">' + text + '</span>'
      + '</div>';
  };
  const poolOf = (cells) => {
    if (isHold) {
      const pool = [];
      for (const s of cells) for (const v of s.pool) pool.push(v);
      return { has: pool.length > 0, value: pool.length ? holdStatOf(pool, heatState.holdStat) : 0 };
    }
    let count = 0; let wins = 0; let pnl = 0;
    for (const s of cells) { count += s.count; wins += s.wins; pnl += s.pnl; }
    return { has: count > 0, value: isWr ? (count ? (wins / count) * 100 : 0) : pnl };
  };
  const dayPools = Array.from({ length: 7 }, (_, d) => poolOf(cellStats[d]));
  const hourPools = Array.from({ length: 24 }, (_, h) => poolOf(Array.from({ length: 7 }, (_, d) => cellStats[d][h])));
  const maxDevOf = (pools) => Math.max(1e-9, ...pools.map((p) => {
    if (!p.has) return 0;
    return isHold ? p.value : Math.abs(p.value - neutral);
  }));
  const maxDay = maxDevOf(dayPools);
  const maxHour = maxDevOf(hourPools);
  setHtml('ta-heat-marg-day', dayPools.map((p, d) => margRow(dayLabels[d], { ...p, maxAbs: maxDay })).join(''));
  setHtml('ta-heat-marg-hour', hourPools.map((p, h) => margRow(String(h).padStart(2, '0'), { ...p, maxAbs: maxHour })).join(''));

  // Legend tracks the active metric — hold mode is banded, not diverging
  const scale = document.getElementById('ta-heat-color-scale');
  if (scale) {
    scale.innerHTML = isHold
      ? HOLD_BANDS.map((b) => '<span class="ta-heat-band"><i style="background:rgba(' + b.rgb + ',0.75)"></i>' + b.label + '</span>').join('')
      : '<span class="ta-heat-scale-label">' + (isWr ? '0%' : '-10 USDT') + '</span>'
        + '<div class="ta-heat-scale-bar"></div>'
        + '<span class="ta-heat-scale-label">' + (isWr ? '50%' : '0') + '</span>'
        + '<div class="ta-heat-scale-bar ta-heat-scale-bar-bull"></div>'
        + '<span class="ta-heat-scale-label">' + (isWr ? '100%' : '+10 USDT') + '</span>';
  }
  const sub = document.getElementById('ta-heat-holdstat');
  if (sub) sub.style.display = isHold ? '' : 'none';
}

function bindHeatmapControls() {
  document.querySelectorAll('[data-heat-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      heatState.view = btn.getAttribute('data-heat-view');
      document.querySelectorAll('[data-heat-view]').forEach((b) => b.classList.toggle('is-active', b === btn));
      drawHeatmap();
    });
  });
  document.querySelectorAll('[data-heat-metric]').forEach((btn) => {
    btn.addEventListener('click', () => {
      heatState.metric = btn.getAttribute('data-heat-metric');
      document.querySelectorAll('[data-heat-metric]').forEach((b) => b.classList.toggle('is-active', b === btn));
      drawHeatmap();
    });
  });
  document.querySelectorAll('[data-heat-hold-stat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      heatState.holdStat = btn.getAttribute('data-heat-hold-stat');
      document.querySelectorAll('[data-heat-hold-stat]').forEach((b) => b.classList.toggle('is-active', b === btn));
      drawHeatmap();
    });
  });
}

function showHeatDetail(d, h, dayFull, isBuy, stats) {
  const det = document.getElementById('ta-heat-detail');
  if (!det) return;
  const { count, wins, losses, pnl, pool, openCount } = stats;
  const wr = count > 0 ? ((wins / count) * 100).toFixed(1) : '—';
  const avg = count > 0 ? fmtPnl(pnl / count, { sign: true }) : '—';
  const pnlCls = pnl > 0 ? 'is-bull' : pnl < 0 ? 'is-bear' : 'is-info';
  const isHold = heatState.metric === 'hold';
  const statLabel = { median: 'Median hold', avg: 'Average hold', p75: 'P75 hold' }[heatState.holdStat];
  const sorted = pool.slice().sort((a, b) => a - b);
  const longest = sorted.length ? sorted[sorted.length - 1] : null;
  const closedCount = count - openCount;
  const holdTiles = pool.length
    ? '<div class="ta-heat-detail-cell is-info"><span class="label">' + statLabel + '</span><span class="value">' + fmtHold(holdStatOf(pool, heatState.holdStat)) + '</span></div>'
      + '<div class="ta-heat-detail-cell is-info"><span class="label">Avg hold</span><span class="value">' + fmtHold(holdStatOf(pool, 'avg')) + '</span></div>'
      + '<div class="ta-heat-detail-cell is-info"><span class="label">P75 hold</span><span class="value">' + fmtHold(holdStatOf(pool, 'p75')) + '</span></div>'
      + '<div class="ta-heat-detail-cell is-warn"><span class="label">Longest</span><span class="value">' + fmtHold(longest) + '</span></div>'
      + '<div class="ta-heat-detail-cell is-info"><span class="label">ยังถืออยู่</span><span class="value">' + openCount + '</span></div>'
      + '<div class="ta-heat-detail-cell is-info"><span class="label">ไม้ที่ปิดแล้ว</span><span class="value">' + closedCount + '</span></div>'
    : '';
  det.innerHTML = ''
    + '<div class="ta-heat-detail-cell is-info" style="grid-column: 1 / -1; flex-direction: row; justify-content: space-between;">'
      + '<span><strong>📍 ' + dayFull[d] + ' ' + String(h).padStart(2, '0') + ':00</strong> <span class="text-muted-3">(' + (isBuy ? 'เวลาที่ซื้อ' : 'เวลาที่ขาย') + ')</span> · ' + (count > 0 ? count + ' trades' : 'no trades yet') + '</span>'
      + '<span class="ta-heat-detail-close" id="ta-heat-detail-close">✕ ปิด</span>'
    + '</div>'
    + (isHold
      ? (holdTiles || '<div class="ta-heat-detail-cell is-info" style="grid-column: 1 / -1;"><span class="label">ยังไม่มีข้อมูลถือครองในช่องนี้</span><span></span></div>')
      : '<div class="ta-heat-detail-cell ' + pnlCls + '"><span class="label">Total PnL</span><span class="value">' + fmtPnl(pnl, { sign: true }) + ' USDT</span></div>'
        + '<div class="ta-heat-detail-cell is-info"><span class="label">Trades</span><span class="value">' + count + '</span></div>'
        + '<div class="ta-heat-detail-cell is-bull"><span class="label">Wins</span><span class="value">' + wins + '</span></div>'
        + '<div class="ta-heat-detail-cell is-bear"><span class="label">Losses</span><span class="value">' + losses + '</span></div>'
        + '<div class="ta-heat-detail-cell is-info"><span class="label">Win rate</span><span class="value">' + wr + (count > 0 ? '%' : '') + '</span></div>'
        + '<div class="ta-heat-detail-cell ' + pnlCls + '"><span class="label">Avg PnL/trade</span><span class="value">' + avg + ' USDT</span></div>');
  det.style.display = 'grid';
  const close = document.getElementById('ta-heat-detail-close');
  if (close) {
    close.addEventListener('click', () => {
      det.style.display = 'none';
      const cells = document.querySelectorAll('#ta-heatmap .ta-heat-cell.is-active');
      cells.forEach((c) => c.classList.remove('is-active'));
    });
  }
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
  // FIX-2026-08-30: use *Min fields exposed by backend (was previously reading *Ms and getting wrong scale)
  setText('ta-hvp-avg-all', fmtHoldShort(hvp.avgHoldMin));
  setText('ta-hvp-avg-win', fmtHoldShort(hvp.avgHoldWinningMin));
  setText('ta-hvp-avg-loss', fmtHoldShort(hvp.avgHoldLosingMin));
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

  // extremes — use holdMin (was reading holdMin but backend only had ms → all '—')
  const setX = (id, trade, kind) => {
    const valEl = document.getElementById(id);
    const metaEl = document.getElementById(id.replace(/-(\w+)$/, '-$1-meta'));
    if (!trade) {
      if (valEl) valEl.textContent = '—';
      if (metaEl) metaEl.textContent = '—';
      return;
    }
    if (valEl) valEl.textContent = `${fmtPnl(trade.pnl, { sign: true })}`;
    // FIX-2026-08-30: holdMin now derived in backend. Fall back to ms/60_000 if missing.
    const holdMin = trade.holdMin != null
      ? trade.holdMin
      : (trade.ms != null ? Math.round(trade.ms / 60_000) : null);
    const meta = `${escapeHtml(trade.symbol || '?')} · ถือ ${fmtHoldShort(holdMin)}`;
    if (metaEl) metaEl.textContent = meta;
  };
  setX('ta-hvp-fast-profit', hvp.fastestProfit, 'profit');
  setX('ta-hvp-long-profit', hvp.longestProfitable, 'profit');
  setX('ta-hvp-fast-loss', hvp.fastestLoss, 'loss');
  setX('ta-hvp-long-all', hvp.longestOverall, 'overall');
  setX('ta-hvp-big-profit', hvp.biggestProfitHoldMs, 'big');
  setX('ta-hvp-big-loss', hvp.biggestLossHoldMs, 'big');
}

// ─── TP / SL Deep Dive ──────────────────────────────────────
function renderTpSlDeep(ts) {
  if (!ts) return;
  // FIX-2026-08-30: backend now exposes pnl (alias of totalPnl), avgHoldMin, maxHoldMin
  //   (previously rendered '—' because frontend read .ms directly while fmtHoldShort expects minutes).
  // helper to fill reason card
  const fill = (prefix, data) => {
    if (!data) return;
    setText(`ta-${prefix}-count`, fmtInt(data.count));
    setText(`ta-${prefix}-pnl`, fmtPnl(data.pnl != null ? data.pnl : data.totalPnl, { sign: true }));
    setText(`ta-${prefix}-avg`, fmtPnl(data.avgPnl, { sign: true, decimals: 4 }));
    setText(`ta-${prefix}-min`, fmtPnl(data.minPnl, { sign: true }));
    setText(`ta-${prefix}-max`, fmtPnl(data.maxPnl, { sign: true }));
    setText(`ta-${prefix}-hold`, fmtHoldShort(data.avgHoldMin));
    setText(`ta-${prefix}-max-hold`, fmtHoldShort(data.maxHoldMin));
    if (data.winRate != null) setText(`ta-${prefix}-wr`, `${data.winRate.toFixed(1)}%`);
    // FIX-2026-08-30: lossRate is implicit (= 100 - winRate) since TP/SL summary exposes winRate only
    if (data.lossRate != null) {
      setText(`ta-${prefix}-rate`, `${data.lossRate.toFixed(1)}%`);
    } else if (data.winRate != null && (prefix === 'sl' || prefix === 'cb' || prefix === 'mc')) {
      setText(`ta-${prefix}-rate`, `${(100 - data.winRate).toFixed(1)}%`);
    }
  };
  fill('tp', ts.tp);
  fill('sl', ts.sl);
  fill('cb', ts.cb);
  fill('mc', ts.manual);
  // TP-SL ratio (FIX-2026-08-30: also compute rate from data, fallback to tpRate)
  const tpRate = ts.tp?.winRate != null ? ts.tp.winRate : (ts.tpRate || 0);
  setText('ta-tpsl-meta', `${ts.count || (ts.tp?.count || 0) + (ts.sl?.count || 0) + (ts.cb?.count || 0) + (ts.manual?.count || 0)} ไม้ · avg TP ${fmtPnl(ts.tp?.avgPnl, { sign: true, decimals: 3 })} vs avg SL ${fmtPnl(ts.sl?.avgPnl, { sign: true, decimals: 3 })} · TP rate ${tpRate.toFixed(1)}%`);
}

// ─── Sticky range toolbar ───────────────────────────────────
// The toolbar sticks under the navbar so the range picker stays reachable while
// reading the lower sections. The navbar wraps on narrow screens, so its height is
// measured rather than assumed.
function syncToolbarOffset() {
  const nav = document.getElementById('app-nav');
  if (!nav) return;
  document.documentElement.style.setProperty('--ta-nav-h', nav.offsetHeight + 'px');
}

function updateRangeHint() {
  const sel = document.getElementById('ta-range');
  const hint = document.getElementById('ta-range-hint');
  const bar = document.getElementById('ta-toolbar');
  if (!sel || !hint || !bar) return;
  const days = Number(sel.value || 0);
  bar.classList.toggle('is-filtered', days > 0);
  hint.textContent = days > 0
    ? `กำลังกรอง ${days} วันล่าสุด · ทุกส่วนในหน้านี้`
    : 'มีผลกับทุกส่วนในหน้านี้';
}

function bindStickyToolbar() {
  const bar = document.getElementById('ta-toolbar');
  if (!bar) return;
  syncToolbarOffset();
  window.addEventListener('resize', syncToolbarOffset);
  // A sentinel above the toolbar tells us when it has actually stuck, so the
  // shadow + back-to-top button only appear once it detaches from the flow.
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:absolute;height:1px;width:1px;';
  bar.parentNode.insertBefore(sentinel, bar);
  if ('IntersectionObserver' in window) {
    const nav = document.getElementById('app-nav');
    const navH = nav ? nav.offsetHeight : 56;
    new IntersectionObserver(
      ([e]) => bar.classList.toggle('is-stuck', !e.isIntersecting),
      { rootMargin: `-${navH + 4}px 0px 0px 0px`, threshold: 0 },
    ).observe(sentinel);
  }
  document.getElementById('ta-top-btn')?.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  updateRangeHint();
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
  renderHeatmap(d.heatmap);
  renderHoldDuration(d.duration);
  renderSizing(d.sizing);
  renderBotLeaderboard(d.byBot);
  renderDcaVsNonDca(d.dcaVsNonDca);
  renderHoldVsProfit(d.holdVsProfit);
  renderTpSlDeep(d.tpSlDeep);


  setText('ta-meta', `${d.meta.tradeCount.toLocaleString('en-US')} trades · ${d.meta.activeBotCount} active + ${d.meta.deletedBotCount} deleted bots`);
  setText('ta-footer-ts', `สร้างเมื่อ ${fmtTsShort(d.generatedAt)} · ใช้เวลา ${d.computeMs}ms · server cache 60s`);
}

// Changing the range re-renders every section, and section heights shift with the
// data — so pin the card the user is currently reading and restore its screen
// position afterwards instead of letting the page jump.
function captureScrollAnchor() {
  const nav = document.getElementById('app-nav');
  const bar = document.getElementById('ta-toolbar');
  const guide = (nav ? nav.offsetHeight : 56) + (bar ? bar.offsetHeight : 0) + 8;
  const cards = Array.from(document.querySelectorAll('.ta-section'));
  for (const card of cards) {
    const top = card.getBoundingClientRect().top;
    if (top >= guide - 4) return { card, offset: top };
  }
  const last = cards[cards.length - 1];
  return last ? { card: last, offset: last.getBoundingClientRect().top } : null;
}

function restoreScrollAnchor(anchor) {
  if (!anchor || !anchor.card.isConnected) return;
  const delta = anchor.card.getBoundingClientRect().top - anchor.offset;
  if (Math.abs(delta) > 1) window.scrollBy(0, delta);
}

async function loadAnalysis({ force = false, keepAnchor = false } = {}) {
  const now = Date.now();
  if (!force && _loading) return;
  if (!force && now - _lastFetchAt < MIN_INTERVAL_MS && _analysisData) return;
  _loading = true;
  try {
    const days = Number(document.getElementById('ta-range')?.value || 0);
    const qs = days > 0 ? ('?since=' + new Date(Date.now() - days * 86400000).toISOString()) : '';
    const data = await API.get('/api/analysis/trade-analysis' + qs);
    _analysisData = data;
    _lastFetchAt = Date.now();
    const anchor = keepAnchor ? captureScrollAnchor() : null;
    renderAllSections(data);
    if (anchor) requestAnimationFrame(() => restoreScrollAnchor(anchor));
  } catch (err) {
    console.error('trade-analysis load failed:', err);
    setText('ta-meta', `โหลดล้มเหลว: ${err.message}`);
  } finally {
    _loading = false;
  }
}

// ─── Boot ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindHeatmapControls();
  bindStickyToolbar();
  loadAnalysis().catch(() => {});
  document.getElementById('ta-refresh-btn')?.addEventListener('click', () => {
    loadAnalysis({ force: true, keepAnchor: true }).catch(() => {});
  });
  document.getElementById('ta-range')?.addEventListener('change', () => {
    updateRangeHint();
    loadAnalysis({ force: true, keepAnchor: true }).catch(() => {});
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