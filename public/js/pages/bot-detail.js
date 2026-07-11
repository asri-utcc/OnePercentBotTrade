'use strict';

/* ─────────────────────────────────────────────────────────
   Bot Detail — premium dark theme, tabs, mobile-responsive
   ───────────────────────────────────────────────────────── */

const BOT_ID = new URLSearchParams(location.search).get('id');
window.NAV_ACTIVE = 'detail';
window.NAV_BOT_ID = BOT_ID;
window.NAV_DETAIL_LABEL = 'Bot Detail';

let detail = null;
let refreshTimer = null;
let activeTab = 'overview';

/* Charts */
let priceChart = null;
let candleSeries = null;
let basisSeries = null;
let upperSeries = null;
let lowerSeries = null;
let pnlChart = null;
let pnlSeries = null;
let pnlMarkers = null;

const STATE_COLORS = {
  placed: 'placed',
  filled: 'filled',
  retrying: 'retrying',
  cancelled: 'cancelled',
  holding: 'holding',
  selling: 'selling',
  sold: 'sold',
  failed: 'failed',
  expired: 'expired',
  skipped: 'skipped',
};
const OUTCOME_CLASS = {
  detected: 'detected',
  order_placed: 'order_placed',
  filled: 'success',
  expired: 'expired',
  failed: 'failed',
  skipped: 'skipped',
};

/* ── Init ─────────────────────────────────────────────── */
async function init() {
  if (!BOT_ID) {
    location.href = '/bots.html';
    return;
  }
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me || !me.authenticated) {
    location.href = '/login.html';
    return;
  }
  WSClient.start();
  setupTabs();
  setupButtons();
  setupCharts();

  await refresh();

  // live updates
  WSClient.on('bot:status', (p) => {
    if (p.botId === BOT_ID && detail) {
      detail.bot.status = p.status;
      renderHero();
      renderSummary();
    }
  });
  WSClient.on('trade:update', (p) => {
    if (detail && p.tradeId && detail.trades.some((t) => t._id === p.tradeId)) {
      refresh();
    }
  });
  WSClient.on('bot:updated', () => refresh());
  WSClient.on('kline:update', (p) => {
    if (!detail || !p.kline || !candleSeries) return;
    if (p.kline.symbol !== detail.bot.symbol || p.interval !== detail.bot.timeframe) return;
    const lastCandle = lastKline;
    if (lastCandle && p.kline.openTime === lastCandle.openTime) {
      const updated = {
        time: p.kline.openTime / 1000,
        open: parseFloat(p.kline.open),
        high: Math.max(lastCandle.high, parseFloat(p.kline.high)),
        low: Math.min(lastCandle.low, parseFloat(p.kline.low)),
        close: parseFloat(p.kline.close),
      };
      candleSeries.update(updated);
      lastKline = updated;
    }
  });

  refreshTimer = setInterval(refresh, 15000);
}

/* ── Tabs ─────────────────────────────────────────────── */
function setupTabs() {
  document.querySelectorAll('.lux-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  document.querySelectorAll('[data-tab-link]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab(a.dataset.tabLink);
    });
  });
}
function switchTab(key) {
  activeTab = key;
  document.querySelectorAll('.lux-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === key);
  });
  document.querySelectorAll('[data-tab-panel]').forEach((p) => {
    p.style.display = p.dataset.tabPanel === key ? '' : 'none';
  });
}

/* ── Buttons ──────────────────────────────────────────── */
function setupButtons() {
  document.getElementById('refresh-btn').onclick = refresh;
  document.getElementById('edit-btn').href = `/bot-edit.html?id=${BOT_ID}`;
  document.getElementById('enable-btn').onclick = async () => {
    await API.post(`/api/bots/${BOT_ID}/enable`, {});
    await refresh();
  };
  document.getElementById('disable-btn').onclick = async () => {
    await API.post(`/api/bots/${BOT_ID}/disable`, {});
    await refresh();
  };
}

/* ── Fetch ────────────────────────────────────────────── */
async function refresh() {
  try {
    detail = await API.get(`/api/bots/${BOT_ID}/details?limit=50`);
    renderAll();
  } catch (err) {
    console.error('refresh failed', err);
    if (err.message && err.message.includes('not found')) {
      alert('Bot not found');
      location.href = '/bots.html';
    }
  }
}

/* ── Render orchestrator ──────────────────────────────── */
function renderAll() {
  if (!detail) return;
  renderHero();
  renderSummary();
  renderActiveTrade();
  renderCfgGrid('cfg-grid');
  renderCfgGrid('cfg-grid-full');
  renderCfgExtra();
  renderTrades();
  renderSignals();
  renderRecentSignals();
  renderMetaChips();
  renderPnlChart();
  renderPriceChart();
  document.title = `${detail.bot.name || detail.bot.symbol} · Bot Detail`;
}

/* ── Hero ─────────────────────────────────────────────── */
function renderHero() {
  const b = detail.bot;
  document.getElementById('bot-name').textContent = b.name || `${b.symbol} ${b.timeframe}`;

  const light = document.getElementById('hero-light');
  const lightLabel = document.getElementById('hero-light-label');
  const status = (b.status || 'idle').toLowerCase();
  light.className = 'hero-light';
  if (['waiting_fill', 'retrying', 'placed'].includes(status)) light.classList.add('is-warning');
  else if (status === 'error') light.classList.add('is-error');
  else if (['idle', 'disabled'].includes(status)) light.classList.add('is-idle');
  lightLabel.textContent = status;

  const ts = new Date().toLocaleTimeString();
  document.getElementById('hero-updated').textContent = `อัปเดตล่าสุด: ${ts}`;

  document.getElementById('enable-btn').style.display = b.enabled ? 'none' : '';
  document.getElementById('disable-btn').style.display = b.enabled ? '' : 'none';
}

function renderMetaChips() {
  const b = detail.bot;
  document.getElementById('hero-symbol').textContent = `${b.symbol}`;
  document.getElementById('hero-tf').textContent = `⏱ ${b.timeframe}`;
  document.getElementById('hero-enabled').textContent = b.enabled ? '● ENABLED' : '○ DISABLED';
  document.getElementById('hero-enabled').className = 'chip ' + (b.enabled ? 'bull' : '');
  document.getElementById('hero-id').textContent = `id: ${b._id.slice(-8)}`;
}

/* ── Summary KPIs ─────────────────────────────────────── */
function renderSummary() {
  const b = detail.bot;
  const totalPnl = b.totalPnl || 0;
  const totalTrades = b.totalTrades || 0;
  const wins = b.winTrades || 0;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100) : 0;
  const activeCount = detail.trades.filter((t) =>
    ['placed', 'filled', 'holding', 'selling', 'retrying'].includes(t.state)
  ).length;

  const today = detail.todayStats || { trades: 0, pnl: 0 };
  const todayPnl = today.pnl || 0;
  const todayTrades = today.trades || 0;

  const tilePnl = document.getElementById('tile-pnl');
  tilePnl.classList.remove('is-bull', 'is-bear', 'is-gold');
  if (totalPnl > 0) tilePnl.classList.add('is-bull');
  else if (totalPnl < 0) tilePnl.classList.add('is-bear');
  else tilePnl.classList.add('is-gold');

  const pnlEl = document.getElementById('stat-pnl');
  pnlEl.textContent = formatUsdt(totalPnl);
  pnlEl.className = 'value ' + (totalPnl > 0 ? 'pnl-bull' : totalPnl < 0 ? 'pnl-bear' : '');
  document.getElementById('stat-pnl-sub').textContent = `USDT · ${totalTrades} ไม้`;

  document.getElementById('stat-trades').textContent = totalTrades;
  document.getElementById('stat-trades-sub').textContent = `wins ${wins} · losses ${Math.max(0, totalTrades - wins)}`;

  document.getElementById('stat-winrate').textContent = `${winRate.toFixed(1)}%`;
  document.getElementById('stat-winrate-sub').textContent = totalTrades > 0
    ? `avg ${formatUsdt(totalPnl / totalTrades)}/ไม้`
    : 'ยังไม่มีไม้ปิด';

  document.getElementById('stat-active').textContent = `${activeCount} / ${b.maxTrades}`;
  document.getElementById('stat-active-sub').textContent = `ทุนรวม ${(b.capitalPerTrade * b.maxTrades).toFixed(2)} USDT`;

  // Today PnL tile
  const tileToday = document.getElementById('tile-today-pnl');
  if (tileToday) {
    tileToday.classList.remove('is-bull', 'is-bear', 'is-gold');
    if (todayPnl > 0) tileToday.classList.add('is-bull');
    else if (todayPnl < 0) tileToday.classList.add('is-bear');
    else tileToday.classList.add('is-gold');
    const todayEl = document.getElementById('stat-today-pnl');
    todayEl.textContent = formatUsdt(todayPnl);
    todayEl.className = 'value ' + (todayPnl > 0 ? 'pnl-bull' : todayPnl < 0 ? 'pnl-bear' : '');
    document.getElementById('stat-today-pnl-sub').textContent = `USDT · ${todayTrades} ไม้`;
  }
  const tileTT = document.getElementById('tile-today-trades');
  if (tileTT) {
    document.getElementById('stat-today-trades').textContent = todayTrades;
    document.getElementById('stat-today-trades-sub').textContent = todayPnl >= 0
      ? `กำไร ${formatUsdt(todayPnl)} USDT`
      : (todayPnl < 0 ? `ขาดทุน ${formatUsdt(Math.abs(todayPnl))} USDT` : 'ยังไม่มี');
  }

  // sparkline for PnL (cumulative of last 20 closed trades)
  drawSpark('spark-pnl', buildPnlSeries(), totalPnl >= 0 ? 'bull' : 'bear');
}

/* ── Active trade ─────────────────────────────────────── */
function renderActiveTrade() {
  const panel = document.getElementById('trade-panel');
  const content = document.getElementById('trade-content');
  const ageEl = document.getElementById('trade-age');
  const t = detail.activeTrade;
  if (!t) {
    panel.classList.add('empty');
    content.innerHTML = '<div class="text-muted-3">ไม่มี active trade</div>';
    ageEl.textContent = '';
    return;
  }
  panel.classList.remove('empty');

  const ageMs = Date.now() - new Date(t.createdAt).getTime();
  ageEl.textContent = `age: ${formatDuration(ageMs)}`;

  const retryMax = (detail.bot.retryMax ?? 1) + 1; // +1 = initial placement + retries
  const usedSlots = (t.retryCount ?? 0) + 1; // +1 = initial
  const segs = [];
  for (let i = 0; i < retryMax; i++) {
    let cls = 'seg';
    if (i < usedSlots) cls += ' used';
    else if (i === usedSlots && ['placed', 'retrying', 'waiting_fill'].includes(t.state)) cls += ' active';
    segs.push(`<div class="${cls}"></div>`);
  }

  const stateClass = STATE_COLORS[t.state] || '';
  const buyStatusClass = STATE_COLORS[(t.buyStatus || '').toLowerCase()] || '';

  content.innerHTML = `
    <div class="row"><span class="k">State</span><span class="v"><span class="status-pill is-${stateClass}">${t.state}</span></span></div>
    <div class="row"><span class="k">Symbol · TF</span><span class="v">${t.symbol} · ${t.timeframe}</span></div>
    <div class="row"><span class="k">BUY OrderId</span><span class="v code" style="font-size:0.75rem;">${t.buyOrderId || '-'}</span></div>
    <div class="row"><span class="k">BUY Price</span><span class="v">${t.buyPrice != null ? t.buyPrice.toFixed(4) : '-'}</span></div>
    <div class="row"><span class="k">BUY Qty</span><span class="v">${t.buyQty != null ? t.buyQty.toFixed(6) : '-'}</span></div>
    <div class="row"><span class="k">BUY Status</span><span class="v"><span class="status-pill is-${buyStatusClass}">${t.buyStatus || '-'}</span></span></div>
    <div class="row"><span class="k">BUY Placed</span><span class="v" style="font-size:0.78rem;">${t.buyPlacedAt ? new Date(t.buyPlacedAt).toLocaleTimeString() : '-'}</span></div>
    <div class="row"><span class="k">SELL OrderId</span><span class="v code" style="font-size:0.75rem;">${t.sellOrderId || '-'}</span></div>
    <div class="row"><span class="k">Target Sell</span><span class="v">${t.targetSellPrice != null ? t.targetSellPrice.toFixed(4) : '-'}</span></div>
    <div class="row"><span class="k">Retry</span><span class="v">${t.retryCount ?? 0} / ${detail.bot.retryMax ?? 1}</span></div>
    ${t.error ? `<div class="row"><span class="k">Note</span><span class="v" style="color:var(--bear-1);font-size:0.78rem;">${escapeHtml(t.error)}</span></div>` : ''}
    <div class="retry-bar" title="Slots: ${usedSlots}/${retryMax}">${segs.join('')}</div>`;
}

/* ── Config grids ─────────────────────────────────────── */
function renderCfgGrid(id) {
  const b = detail.bot;
  const cells = [
    { k: 'Symbol',         v: b.symbol },
    { k: 'Timeframe',      v: b.timeframe },
    { k: 'ทุน/ไม้',         v: `${b.capitalPerTrade} USDT` },
    { k: 'จำนวนไม้',         v: `${b.maxTrades}` },
    { k: 'ทุนรวม (virtual)', v: `${(b.capitalPerTrade * b.maxTrades).toFixed(2)} USDT` },
    { k: 'TP %',            v: `${b.tpPercent}%` },
    { k: 'Retry time',      v: `${b.retryTimeMin} นาที` },
    { k: 'Retry max',       v: `${b.retryMax ?? 1} ครั้ง` },
    { k: 'Enabled',         v: b.enabled ? '✅ เปิดใช้งาน' : '⏸ ปิดอยู่' },
    { k: 'Last Signal',     v: b.lastSignalAt ? new Date(b.lastSignalAt).toLocaleString() : '-' },
  ];
  document.getElementById(id).innerHTML = cells.map((c) => `
    <div class="detail-cell">
      <div class="k">${c.k}</div>
      <div class="v">${escapeHtml(String(c.v))}</div>
    </div>`).join('');
}
function renderCfgExtra() {
  const b = detail.bot;
  const errHtml = b.lastError
    ? `<div class="alert alert-danger mt-3"><strong>Last Error:</strong><br><span class="text-mono" style="font-size:0.82rem;">${escapeHtml(b.lastError)}</span></div>`
    : '';
  document.getElementById('cfg-extra').innerHTML = errHtml;
}

/* ── Trades ───────────────────────────────────────────── */
function renderTrades() {
  const tbody = document.getElementById('trades-tbody');
  const mob = document.getElementById('trades-mob');
  const count = detail.trades.length;
  document.getElementById('trades-count-label').textContent = `${count} รายการ`;
  document.getElementById('tab-trades-badge').textContent = count;

  if (count === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">ยังไม่มี trades</td></tr>';
    mob.innerHTML = '<div class="text-muted-3 text-center py-4">ยังไม่มี trades</div>';
    return;
  }
  tbody.innerHTML = detail.trades.map((t) => {
    const sc = STATE_COLORS[t.state] || '';
    const pnl = t.realizedPnl;
    const pnlCls = pnl == null ? '' : (pnl >= 0 ? 'pnl-bull' : 'pnl-bear');
    const pnlTxt = pnl != null ? `${pnl.toFixed(4)} (${(t.pnlPercent || 0).toFixed(2)}%)` : '-';
    return `
      <tr>
        <td><span class="ts">${new Date(t.createdAt).toLocaleString()}</span></td>
        <td><span class="status-pill is-${sc}">${t.state}</span></td>
        <td>${t.buyPrice != null ? `BUY ${t.buyPrice.toFixed(4)}` : '-'}${t.sellPrice != null ? ` → SELL ${t.sellPrice.toFixed(4)}` : ''}</td>
        <td class="num">${t.buyPrice?.toFixed(4) ?? '-'}</td>
        <td class="num">${t.buyQty?.toFixed(6) ?? '-'}</td>
        <td style="font-size:0.75rem;">${t.buyStatus || ''}${t.sellStatus ? ` → ${t.sellStatus}` : ''}</td>
        <td class="num">${t.retryCount ?? 0}</td>
        <td class="num">${t.sellPrice?.toFixed(4) ?? '-'}</td>
        <td class="num ${pnlCls}">${pnlTxt}</td>
        <td><span class="code">${t.buyOrderId || '-'}</span></td>
      </tr>`;
  }).join('');

  mob.innerHTML = detail.trades.map((t) => {
    const sc = STATE_COLORS[t.state] || '';
    const pnl = t.realizedPnl;
    const pnlCls = pnl == null ? '' : (pnl >= 0 ? 'pnl-bull' : 'pnl-bear');
    const pnlTxt = pnl != null ? `${pnl.toFixed(4)} (${(t.pnlPercent || 0).toFixed(2)}%)` : '-';
    return `
      <div class="mob-card">
        <div class="top">
          <span class="status-pill is-${sc}">${t.state}</span>
          <span class="ts" style="color:var(--text-3);font-size:0.72rem;">${new Date(t.createdAt).toLocaleString()}</span>
        </div>
        <div class="row"><span class="k">Side</span><span class="v">${t.buyPrice ? `BUY ${t.buyPrice.toFixed(4)}` : '-'}${t.sellPrice ? ` → SELL ${t.sellPrice.toFixed(4)}` : ''}</span></div>
        <div class="row"><span class="k">Qty</span><span class="v">${t.buyQty?.toFixed(6) ?? '-'}</span></div>
        <div class="row"><span class="k">Status</span><span class="v" style="font-size:0.75rem;">${t.buyStatus || ''}${t.sellStatus ? ` → ${t.sellStatus}` : ''}</span></div>
        <div class="row"><span class="k">Retry</span><span class="v">${t.retryCount ?? 0}</span></div>
        <div class="row"><span class="k">PnL</span><span class="v ${pnlCls}">${pnlTxt}</span></div>
      </div>`;
  }).join('');
}

/* ── Signals ──────────────────────────────────────────── */
function renderSignals() {
  const tbody = document.getElementById('signals-tbody');
  const mob = document.getElementById('signals-mob');
  const count = detail.signals.length;
  document.getElementById('signals-count-label').textContent = `${count} รายการ`;
  document.getElementById('tab-signals-badge').textContent = count;

  if (count === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">ยังไม่มี signals</td></tr>';
    mob.innerHTML = '<div class="text-muted-3 text-center py-4">ยังไม่มี signals</div>';
    return;
  }

  tbody.innerHTML = detail.signals.map((s) => {
    const oc = OUTCOME_CLASS[s.outcome] || '';
    const dir = (s.bgPrev === 2 && (s.bgState === 1 || s.bgState === 3))
      ? (s.bgState === 1 ? 'bull' : 'bear')
      : 'neutral';
    return `
      <tr>
        <td><span class="ts">${new Date(s.createdAt).toLocaleString()}</span></td>
        <td><span class="status-pill is-${dir === 'bull' ? 'success' : dir === 'bear' ? 'failed' : 'idle'}">${s.type}</span></td>
        <td class="num">${s.closePrice?.toFixed(4) ?? '-'}</td>
        <td style="font-size:0.78rem;">${s.bgPrev} → ${s.bgState}</td>
        <td class="num">${s.upperKC?.toFixed(4) ?? '-'}</td>
        <td class="num">${s.lowerKC?.toFixed(4) ?? '-'}</td>
        <td><span class="status-pill is-${oc}">${s.outcome}</span></td>
        <td style="font-size:0.75rem;color:var(--text-3);">${escapeHtml(s.note || '')}</td>
      </tr>`;
  }).join('');

  mob.innerHTML = detail.signals.map((s) => {
    const oc = OUTCOME_CLASS[s.outcome] || '';
    const dir = (s.bgPrev === 2 && (s.bgState === 1 || s.bgState === 3))
      ? (s.bgState === 1 ? 'bull' : 'bear')
      : 'neutral';
    return `
      <div class="mob-card">
        <div class="top">
          <span class="status-pill is-${dir === 'bull' ? 'success' : dir === 'bear' ? 'failed' : 'idle'}">${s.type}</span>
          <span class="ts" style="color:var(--text-3);font-size:0.72rem;">${new Date(s.createdAt).toLocaleString()}</span>
        </div>
        <div class="row"><span class="k">Close</span><span class="v">${s.closePrice?.toFixed(4) ?? '-'}</span></div>
        <div class="row"><span class="k">BG</span><span class="v">${s.bgPrev} → ${s.bgState}</span></div>
        <div class="row"><span class="k">KC range</span><span class="v">${s.lowerKC?.toFixed(4) ?? '-'} → ${s.upperKC?.toFixed(4) ?? '-'}</span></div>
        <div class="row"><span class="k">Outcome</span><span class="v"><span class="status-pill is-${oc}">${s.outcome}</span></span></div>
        ${s.note ? `<div class="row"><span class="k">Note</span><span class="v" style="font-size:0.72rem;color:var(--text-3);">${escapeHtml(s.note)}</span></div>` : ''}
      </div>`;
  }).join('');
}

function renderRecentSignals() {
  const container = document.getElementById('recent-signals');
  const recent = (detail.signals || []).slice(0, 5);
  if (recent.length === 0) {
    container.innerHTML = '<div class="text-muted-3 text-center py-4">ยังไม่มี signals</div>';
    return;
  }
  container.innerHTML = recent.map((s) => {
    const oc = OUTCOME_CLASS[s.outcome] || '';
    const dir = (s.bgPrev === 2 && (s.bgState === 1 || s.bgState === 3))
      ? (s.bgState === 1 ? 'bull' : 'bear')
      : 'neutral';
    return `
      <div class="signal-row">
        <span class="type-dot ${dir}"></span>
        <span class="ts">${new Date(s.createdAt).toLocaleString()}</span>
        <span class="price">${s.closePrice?.toFixed(4) ?? '-'}</span>
        <span class="bg">bg ${s.bgPrev}→${s.bgState}</span>
        <span class="outcome"><span class="status-pill is-${oc}">${s.outcome}</span></span>
        ${s.note ? `<span class="note">${escapeHtml(s.note)}</span>` : ''}
      </div>`;
  }).join('');
}

/* ── Sparkline (kept as fallback / decoration) ───────── */
function buildPnlSeries() {
  const closed = (detail.trades || [])
    .filter((t) => t.realizedPnl != null)
    .reverse(); // oldest first
  if (closed.length === 0) return [0];
  let cum = 0;
  const series = [0];
  for (const t of closed.slice(-20)) {
    cum += t.realizedPnl;
    series.push(cum);
  }
  return series;
}

function drawSpark(targetId, series, kind) {
  // No-op — PnL now rendered via proper area chart below
  const el = document.getElementById(targetId);
  if (el) el.innerHTML = '';
}

/* ── Charts (lightweight-charts) ──────────────────────── */
let lastKline = null;

function chartBaseOptions(width, height) {
  return {
    width,
    height,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#94a3b8',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.04)' },
      horzLines: { color: 'rgba(255,255,255,0.04)' },
    },
    rightPriceScale: {
      borderColor: 'rgba(255,255,255,0.06)',
      scaleMargins: { top: 0.08, bottom: 0.08 },
    },
    timeScale: {
      borderColor: 'rgba(255,255,255,0.06)',
      timeVisible: true,
      secondsVisible: false,
    },
    crosshair: {
      vertLine: { color: 'rgba(245,184,0,0.4)', width: 1, style: 3, labelBackgroundColor: '#f5b800' },
      horzLine: { color: 'rgba(245,184,0,0.4)', width: 1, style: 3, labelBackgroundColor: '#f5b800' },
    },
  };
}

function setupCharts() {
  const pc = document.getElementById('price-chart');
  const pnlEl = document.getElementById('pnl-chart');
  if (!pc || !pnlEl || typeof LightweightCharts === 'undefined') return;

  // Price chart
  priceChart = LightweightCharts.createChart(pc, chartBaseOptions(pc.clientWidth, 340));
  candleSeries = priceChart.addCandlestickSeries({
    upColor: '#00e5b8', downColor: '#ff4d6d',
    borderUpColor: '#00e5b8', borderDownColor: '#ff4d6d',
    wickUpColor: '#00e5b8', wickDownColor: '#ff4d6d',
  });
  basisSeries = priceChart.addLineSeries({ color: '#a78bfa', lineWidth: 1, title: 'EMA' });
  upperSeries = priceChart.addLineSeries({ color: '#5dc4ff', lineWidth: 1, lineStyle: 2, title: 'Upper KC' });
  lowerSeries = priceChart.addLineSeries({ color: '#5dc4ff', lineWidth: 1, lineStyle: 2, title: 'Lower KC' });

  // PnL chart
  pnlChart = LightweightCharts.createChart(pnlEl, chartBaseOptions(pnlEl.clientWidth, 180));
  pnlSeries = pnlChart.addAreaSeries({
    topColor: 'rgba(0,229,184,0.45)',
    bottomColor: 'rgba(0,229,184,0.04)',
    lineColor: '#00e5b8',
    lineWidth: 2,
    priceLineVisible: false,
  });
  pnlMarkers = pnlChart.addLineSeries({ color: 'rgba(245,184,0,0.0)', lineWidth: 0 });
  // baseline ที่ 0
  pnlSeries.applyOptions({ baseValue: { type: 'price', price: 0 } });
  // price line ที่ 0
  pnlChart.applyOptions({
    timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false },
  });

  // resize handling
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const w = Math.floor(e.contentRect.width);
      if (e.target === pc) priceChart && priceChart.applyOptions({ width: w });
      if (e.target === pnlEl) pnlChart && pnlChart.applyOptions({ width: w });
    }
  });
  ro.observe(pc);
  ro.observe(pnlEl);
}

async function renderPriceChart() {
  if (!priceChart || !detail || !detail.bot) return;
  const { symbol, timeframe } = detail.bot;
  const loading = document.getElementById('price-chart-loading');
  try {
    const resp = await API.get(`/api/chart/klines?symbol=${symbol}&timeframe=${timeframe}&limit=100`);
    if (!resp.klines || resp.klines.length === 0) {
      if (loading) loading.textContent = 'ไม่มีข้อมูลแท่งเทียน';
      return;
    }

    const candleData = resp.klines.map((k) => ({
      time: Math.floor(k.openTime / 1000),
      open: parseFloat(k.open),
      high: parseFloat(k.high),
      low: parseFloat(k.low),
      close: parseFloat(k.close),
    }));
    lastKline = candleData[candleData.length - 1];

    const basis = [];
    const upper = [];
    const lower = [];
    if (resp.keltner) {
      for (let i = 0; i < resp.klines.length; i += 1) {
        const t = Math.floor(resp.klines[i].openTime / 1000);
        if (resp.keltner.basis[i] != null) {
          basis.push({ time: t, value: resp.keltner.basis[i] });
          upper.push({ time: t, value: resp.keltner.upper[i] });
          lower.push({ time: t, value: resp.keltner.lower[i] });
        }
      }
    }

    candleSeries.setData(candleData);
    basisSeries.setData(basis);
    upperSeries.setData(upper);
    lowerSeries.setData(lower);

    // signal markers (S1)
    const sigMarkers = (resp.signals || []).map((s) => ({
      time: Math.floor(s.openTime / 1000),
      position: 'belowBar',
      color: '#00e5b8',
      shape: 'arrowUp',
      text: 'S1',
    }));
    candleSeries.setMarkers(sigMarkers);

    // overlays: trade entry/exit from detail.trades (ถ้ามี)
    const overlayMarkers = [];
    for (const t of detail.trades || []) {
      if (!t.buyPlacedAt) continue;
      const buyT = Math.floor(new Date(t.buyPlacedAt).getTime() / 1000);
      // match to nearest candle
      const idx = candleData.findIndex((c) => c.time >= buyT);
      if (idx >= 0) {
        overlayMarkers.push({
          time: candleData[idx].time,
          position: 'belowBar',
          color: t.state === 'sold' || t.realizedPnl != null ? (t.realizedPnl >= 0 ? '#00e5b8' : '#ff4d6d') : '#ffb547',
          shape: 'circle',
          text: t.state === 'sold' ? `+${(t.realizedPnl || 0).toFixed(2)}` : (t.state || 'open'),
        });
      }
    }
    candleSeries.setMarkers([...sigMarkers, ...overlayMarkers]);

    priceChart.timeScale().fitContent();
    if (loading) loading.style.display = 'none';
  } catch (err) {
    console.error('renderPriceChart', err);
    if (loading) loading.textContent = `❌ ${err.message}`;
  }
}

function renderPnlChart() {
  if (!pnlChart || !detail) return;
  const closed = (detail.trades || [])
    .filter((t) => t.realizedPnl != null && (t.sellFilledAt || t.createdAt));
  const meta = document.getElementById('pnl-chart-meta');
  const loading = document.getElementById('pnl-chart-loading');

  if (closed.length === 0) {
    pnlSeries.setData([]);
    if (meta) meta.textContent = '0 ไม้ปิด';
    if (loading) loading.style.display = '';
    return;
  }
  if (loading) loading.style.display = 'none';

  // sort ascending by close time
  closed.sort((a, b) => new Date(a.sellFilledAt || a.createdAt) - new Date(b.sellFilledAt || b.createdAt));

  let cum = 0;
  const pts = [];
  for (const t of closed) {
    cum += t.realizedPnl;
    const tms = new Date(t.sellFilledAt || t.createdAt).getTime();
    pts.push({ time: Math.floor(tms / 1000), value: parseFloat(cum.toFixed(4)) });
  }
  // ensure strictly increasing times
  const dedup = [];
  for (const p of pts) {
    if (dedup.length === 0 || dedup[dedup.length - 1].time < p.time) dedup.push(p);
    else dedup[dedup.length - 1] = p;
  }
  if (dedup.length === 0) return;

  // color = pick based on final value
  const final = dedup[dedup.length - 1].value;
  const bull = final >= 0;
  pnlSeries.applyOptions({
    topColor: bull ? 'rgba(0,229,184,0.45)' : 'rgba(255,77,109,0.45)',
    bottomColor: bull ? 'rgba(0,229,184,0.04)' : 'rgba(255,77,109,0.04)',
    lineColor: bull ? '#00e5b8' : '#ff4d6d',
  });
  pnlSeries.setData(dedup);

  // baseline price line ที่ 0
  try { pnlSeries.createPriceLine({ price: 0, color: 'rgba(255,255,255,0.18)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'break-even' }); } catch (_) {}

  if (meta) {
    meta.innerHTML = `${closed.length} ไม้ปิด · <span class="${bull ? 'pnl-bull' : 'pnl-bear'}">${final >= 0 ? '+' : ''}${final.toFixed(4)} USDT</span>`;
  }

  pnlChart.timeScale().fitContent();
}

/* ── Helpers ──────────────────────────────────────────── */
function formatUsdt(v) {
  if (v == null || isNaN(v)) return '0.00';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 100) return `${sign}${abs.toFixed(2)}`;
  if (abs >= 1) return `${sign}${abs.toFixed(3)}`;
  return `${sign}${abs.toFixed(4)}`;
}
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();