'use strict';

// FIX-2026-07-29: PnL Calendar + Cumulative PnL Chart
//   - month grid heatmap (green/red intensity = |PnL|/maxAbs)
//   - cumulative PnL area chart (lightweight-charts) with USDT ↔ THB toggle
//   - per-bot filter + WS live updates on trade:update

// ─── State ───────────────────────────────────────────
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth() + 1; // 1..12
let currentBotId = '';
let currencyMode = 'USDT'; // 'USDT' | 'THB'
let calendarData = null; // last /calendar response
let pnlChart = null;
let pnlSeries = null;
let lastSoldUpdateAt = 0; // debounce WS burst refresh
const WS_DEBOUNCE_MS = 1000;

// ─── chartBaseOptions (mirror bot-detail.js:929-966) ─
function chartPriceFormatter(price) {
  const abs = Math.abs(price);
  if (abs >= 1000) return price.toFixed(2);
  if (abs >= 1) return price.toFixed(4);
  if (abs >= 0.01) return price.toFixed(5);
  if (abs >= 0.0001) return price.toFixed(5);
  return price.toFixed(6);
}

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
      rightOffset: 12,
      shiftVisibleRangeOnNewBar: true,
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: false },
    },
    crosshair: {
      vertLine: { color: 'rgba(245,184,0,0.4)', width: 1, style: 3, labelBackgroundColor: '#f5b800' },
      horzLine: { color: 'rgba(245,184,0,0.4)', width: 1, style: 3, labelBackgroundColor: '#f5b800' },
    },
    localization: { priceFormatter: chartPriceFormatter },
  };
}

// ─── Formatters ──────────────────────────────────────
function formatUsdt(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(4)}`;
}

function tileClass(pnl) {
  if (pnl > 0) return 'is-bull';
  if (pnl < 0) return 'is-bear';
  return 'is-gold';
}

function tileThb(usdt) {
  if (usdt == null || !Number.isFinite(usdt)) return '';
  if (!window.__fx || !window.__fx.rate) return '';
  const thb = usdt * window.__fx.rate;
  const sign = thb >= 0 ? '+' : '';
  return `${sign}${thb.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} THB`;
}

// ─── Bots dropdown ───────────────────────────────────
async function loadBots() {
  try {
    const bots = await API.get('/api/bots');
    const sel = document.getElementById('pnl-bot-filter');
    bots.forEach((b) => {
      const opt = document.createElement('option');
      opt.value = b._id;
      const status = b.enabled ? '🟢' : '⚪';
      opt.textContent = `${status} ${b.name} (${b.symbol}/${b.timeframe})`;
      sel.appendChild(opt);
    });
  } catch (err) {
    console.warn('pnl: loadBots failed', err);
  }
}

// ─── Fetch + render calendar ─────────────────────────
async function loadCalendar() {
  const params = new URLSearchParams({ year: currentYear, month: currentMonth });
  if (currentBotId) params.set('botId', currentBotId);
  try {
    calendarData = await API.get(`/api/pnl/calendar?${params}`);
    renderKPITiles(calendarData);
    renderCalendar(calendarData);
  } catch (err) {
    console.warn('pnl: loadCalendar failed', err);
    const cal = document.getElementById('pnl-calendar');
    cal.innerHTML = `<div class="text-center py-5 text-muted-3" style="grid-column: 1 / -1;">โหลดข้อมูลล้มเหลว: ${escapeHtml(err.message || 'unknown')}</div>`;
  }
}

// ─── KPI tiles ───────────────────────────────────────
function renderKPITiles(data) {
  const { totals, bestDay, worstDay } = data;
  const tiles = [
    {
      label: 'Total PnL',
      value: formatUsdt(totals.pnl),
      sub: tileThb(totals.pnl),
      cls: tileClass(totals.pnl),
    },
    {
      label: 'Win Rate',
      value: `${totals.winRate}%`,
      sub: `${totals.wins}W / ${totals.losses}L`,
      cls: 'is-gold',
    },
    {
      label: 'Total Trades',
      value: totals.trades,
      sub: 'ไม้',
      cls: 'is-info',
    },
    {
      label: 'Best Day',
      value: bestDay ? formatUsdt(bestDay.pnl) : '—',
      sub: bestDay ? bestDay.date.slice(5) : '—',
      cls: bestDay ? tileClass(bestDay.pnl) : 'muted',
    },
    {
      label: 'Worst Day',
      value: worstDay ? formatUsdt(worstDay.pnl) : '—',
      sub: worstDay ? worstDay.date.slice(5) : '—',
      cls: worstDay ? tileClass(worstDay.pnl) : 'muted',
    },
  ];
  document.getElementById('pnl-stats-row').innerHTML = tiles
    .map(
      (t) => `<div class="stat-tile ${t.cls}">
        <div class="tile-label">${t.label}</div>
        <div class="tile-value">${t.value}</div>
        ${t.sub ? `<div class="tile-sub">${escapeHtml(t.sub)}</div>` : ''}
      </div>`,
    )
    .join('');
}

// ─── Calendar render (heatmap intensity) ─────────────
function renderCalendar(data) {
  const { year, month, days } = data;
  const cal = document.getElementById('pnl-calendar');
  cal.innerHTML = '';

  // 1) Weekday headers (Mon-first)
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d) => {
    const h = document.createElement('div');
    h.className = 'pnl-cal-weekday';
    h.textContent = d;
    cal.appendChild(h);
  });

  // 2) First-day offset (Mon=0..Sun=6)
  const firstDay = new Date(year, month - 1, 1).getDay(); // 0=Sun
  const offset = (firstDay + 6) % 7; // shift so Mon=0
  for (let i = 0; i < offset; i++) {
    const blank = document.createElement('div');
    blank.className = 'pnl-cal-cell is-empty';
    cal.appendChild(blank);
  }

  // 3) Max |pnl| for heatmap intensity scaling (clamp >=1 กันหาร 0)
  const maxAbs = Math.max(
    1,
    ...days.filter((d) => d.trades > 0).map((d) => Math.abs(d.pnl)),
  );

  // 4) Render each day cell
  days.forEach((day) => {
    const cell = document.createElement('div');
    cell.className = 'pnl-cal-cell';
    if (day.trades === 0) {
      cell.classList.add('is-empty');
    } else {
      const cls = day.pnl > 0 ? 'is-bull' : day.pnl < 0 ? 'is-bear' : 'is-flat';
      cell.classList.add(cls);
      const intensity = Math.min(1, Math.abs(day.pnl) / maxAbs);
      cell.style.setProperty('--intensity', (0.18 + intensity * 0.82).toFixed(2));
    }
    const dayNum = parseInt(day.date.slice(-2), 10);
    const pnlCls = day.pnl > 0 ? 'pnl-bull' : day.pnl < 0 ? 'pnl-bear' : '';
    cell.innerHTML = `
      <div class="pnl-cal-day-num">${dayNum}</div>
      ${
        day.trades > 0
          ? `<div class="pnl-cal-pnl ${pnlCls}">${formatUsdt(day.pnl)}</div>
             <div class="pnl-cal-trades">${day.trades} ไม้</div>`
          : ''
      }
    `;
    cell.title =
      day.trades > 0
        ? `${day.date}\nPnL: ${formatUsdt(day.pnl)} USDT\nWins: ${day.wins} · Losses: ${day.losses}\nTrades: ${day.trades}`
        : day.date;
    cal.appendChild(cell);
  });

  // Update month label
  document.getElementById('pnl-month-label').textContent = new Date(
    year,
    month - 1,
    1,
  ).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  document.getElementById('pnl-month-range').textContent =
    `${year}-${String(month).padStart(2, '0')} · ${days.filter((d) => d.trades > 0).length} วันที่เทรด`;
}

// ─── Chart load + render ─────────────────────────────
async function loadChart() {
  const lastDay = new Date(currentYear, currentMonth, 0).getDate();
  const from = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
  const to = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const params = new URLSearchParams({ from, to });
  if (currentBotId) params.set('botId', currentBotId);
  try {
    const data = await API.get(`/api/pnl/series?${params}`);
    renderPnlChart(data.trades || []);
    document.getElementById('pnl-chart-range').textContent = `${from} → ${to} · ${data.count} ไม้`;
  } catch (err) {
    console.warn('pnl: loadChart failed', err);
    document.getElementById('pnl-chart-range').textContent = `โหลดล้มเหลว: ${err.message || 'unknown'}`;
  }
}

function renderPnlChart(trades) {
  const container = document.getElementById('pnl-chart');
  if (pnlChart) {
    pnlChart.remove();
    pnlChart = null;
    pnlSeries = null;
  }
  container.innerHTML = '';

  const w = container.clientWidth || 800;
  const h = 380;
  pnlChart = LightweightCharts.createChart(container, chartBaseOptions(w, h));
  pnlSeries = pnlChart.addAreaSeries({});

  if (!trades.length) {
    pnlSeries.setData([]);
    return;
  }

  // Build cumulative points (USDT หรือ THB ตาม currencyMode)
  const fxRate = currencyMode === 'THB' && window.__fx && window.__fx.rate ? window.__fx.rate : 1;
  let cum = 0;
  const pts = trades.map((t) => {
    const inc = currencyMode === 'THB' ? t.realizedPnl * fxRate : t.realizedPnl;
    cum += inc;
    return {
      time: Math.floor(new Date(t.sellFilledAt).getTime() / 1000),
      value: parseFloat(cum.toFixed(currencyMode === 'THB' ? 2 : 4)),
    };
  });

  const bull = cum >= 0;
  pnlSeries.applyOptions({
    topColor: bull ? 'rgba(0,229,184,0.45)' : 'rgba(255,77,109,0.45)',
    bottomColor: bull ? 'rgba(0,229,184,0.04)' : 'rgba(255,77,109,0.04)',
    lineColor: bull ? '#00e5b8' : '#ff4d6d',
    baseValue: { type: 'price', price: 0 },
    priceFormat: {
      type: currencyMode === 'THB' ? 'price' : 'price',
      precision: currencyMode === 'THB' ? 2 : 4,
      minMove: currencyMode === 'THB' ? 0.01 : 0.0001,
    },
  });
  pnlSeries.setData(pts);
  pnlSeries.createPriceLine({
    price: 0,
    color: 'rgba(255,255,255,0.18)',
    lineStyle: 2,
    title: 'break-even',
  });
  pnlChart.timeScale().fitContent();
}

// ─── Currency toggle ─────────────────────────────────
function onCurrencyChange(newMode) {
  currencyMode = newMode;
  document.getElementById('pnl-currency-usdt').classList.toggle('active', newMode === 'USDT');
  document.getElementById('pnl-currency-thb').classList.toggle('active', newMode === 'THB');
  loadChart();
}

// ─── Helpers ─────────────────────────────────────────
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Live updates (debounced) ────────────────────────
function setupWS() {
  if (typeof WSClient === 'undefined' || !WSClient.start) return;
  WSClient.start();
  WSClient.on('trade:update', async ({ state }) => {
    if (state !== 'sold') return;
    const now = Date.now();
    if (now - lastSoldUpdateAt < WS_DEBOUNCE_MS) return; // debounce burst
    lastSoldUpdateAt = now;
    await Promise.all([loadCalendar(), loadChart()]);
  });
}

// ─── Wire up ─────────────────────────────────────────
function setupNav() {
  document.getElementById('pnl-prev-month').addEventListener('click', () => {
    currentMonth -= 1;
    if (currentMonth < 1) {
      currentMonth = 12;
      currentYear -= 1;
    }
    loadCalendar();
    loadChart();
  });
  document.getElementById('pnl-next-month').addEventListener('click', () => {
    currentMonth += 1;
    if (currentMonth > 12) {
      currentMonth = 1;
      currentYear += 1;
    }
    loadCalendar();
    loadChart();
  });
  document.getElementById('pnl-today').addEventListener('click', () => {
    const now = new Date();
    currentYear = now.getFullYear();
    currentMonth = now.getMonth() + 1;
    loadCalendar();
    loadChart();
  });
  document.getElementById('pnl-bot-filter').addEventListener('change', (e) => {
    currentBotId = e.target.value;
    loadCalendar();
    loadChart();
  });
  document.getElementById('pnl-currency-usdt').addEventListener('click', () => onCurrencyChange('USDT'));
  document.getElementById('pnl-currency-thb').addEventListener('click', () => onCurrencyChange('THB'));

  // FX updates — re-render chart when rate changes (THB mode only)
  document.addEventListener('fx:updated', () => {
    if (currencyMode === 'THB') loadChart();
  });

  // Resize handler for chart
  window.addEventListener('resize', () => {
    if (!pnlChart) return;
    const container = document.getElementById('pnl-chart');
    pnlChart.applyOptions({ width: container.clientWidth || 800 });
  });
}

// ─── Init ────────────────────────────────────────────
(async () => {
  setupNav();
  await loadBots();
  await Promise.all([loadCalendar(), loadChart()]);
  setupWS();
})();