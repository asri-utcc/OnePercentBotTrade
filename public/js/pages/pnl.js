'use strict';

// FIX-2026-07-29: PnL Calendar + Cumulative PnL Chart
//   - month grid heatmap (green/red intensity = |PnL|/maxAbs)
//   - cumulative PnL area chart (lightweight-charts) with USDT ↔ THB toggle
//   - per-bot filter + WS live updates on trade:update

// ─── State ───────────────────────────────────────────
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth() + 1; // 1..12
let currentBotId = '';
// FIX-2026-07-31: map botId → symbol — ใช้กับ PriceFormat เพื่อรู้ precision ต่อบอท
const botSymbolById = new Map();
let currencyMode = 'USDT'; // 'USDT' | 'THB'
let calendarData = null; // last /calendar response
let pnlChart = null;
let pnlSeries = null;
let lastSoldUpdateAt = 0; // debounce WS burst refresh
const WS_DEBOUNCE_MS = 1000;

// FIX-2026-07-31: ใช้ Binance tickSize precision (authoritative) — fallback heuristic
//   botSymbolById map ใช้หา symbol จาก botId filter ปัจจุบัน
function chartPriceFormatter(price) {
  if (price === null || price === undefined || !Number.isFinite(price)) return '';
  let symbol = null;
  if (currentBotId) symbol = botSymbolById.get(currentBotId) || null;
  if (window.PriceFormat) return window.PriceFormat.format(price, symbol);
  // fallback heuristic (เดิม)
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
    // FIX-2026-07-29 v8: ไม่ใช้ autoSize — chart จะถูกบีบเป็น 71px ตาม container จริง
    //   แล้ว painter อ่าน value=null ตอน render frame แรก
    //   fix: ใช้ fixed width/height ที่ >= 600px + ResizeObserver ตามจังหวะ
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

// FIX-2026-07-29: compact THB formatter สำหรับใน calendar cell (ใช้ k/M suffix)
function formatThbInline(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1000000) return `${sign}${(abs / 1000000).toFixed(2)}M`;
  if (abs >= 10000)   return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${abs.toFixed(0)}`;
}

// ─── Bots dropdown ───────────────────────────────────
async function loadBots() {
  try {
    const resp = await API.get('/api/bots');
    // FIX-2026-07-29: /api/bots คืน {bots: [...]} (ไม่ใช่ array ตรงๆ)
    const bots = Array.isArray(resp) ? resp : (resp.bots || []);
    const sel = document.getElementById('pnl-bot-filter');
    bots.forEach((b) => {
      const opt = document.createElement('option');
      opt.value = b._id;
      const status = b.enabled ? '🟢' : '⚪';
      opt.textContent = `${status} ${b.name} (${b.symbol}/${b.timeframe})`;
      sel.appendChild(opt);
    botSymbolById.set(b._id, b.symbol);
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
  // FIX-2026-08-01: helper — บังคับ class ให้ดูง่าย
  //   - pnl > 0 → is-bull (เขียว)
  //   - pnl < 0 → is-bear (แดง)
  //   - pnl = 0 → is-flat (เทา, ไม่ใช่ทอง — สีทองหมายถึง Win Rate)
  const tileClassForPnL = (v) => {
    if (v > 0) return 'is-bull';
    if (v < 0) return 'is-bear';
    return 'is-flat';
  };
  const tiles = [
    {
      label: 'Total PnL',
      value: formatUsdt(totals.pnl),
      sub: `${totals.wins}W / ${totals.losses}L`,
      subThb: tileThb(totals.pnl),
      icon: totals.pnl >= 0 ? '📈' : '📉',
      cls: tileClassForPnL(totals.pnl),
    },
    {
      label: 'Gross Profit',
      value: `+${(totals.grossProfit || 0).toFixed(4)}`,
      sub: `${totals.wins}W · avg +${(totals.avgWin || 0).toFixed(4)}/ไม้`,
      subThb: tileThb(totals.grossProfit || 0),
      icon: '✅',
      cls: 'is-bull',
    },
    {
      label: 'Gross Loss',
      value: formatUsdt(totals.grossLoss || 0),
      sub: `${totals.losses}L · avg ${(totals.avgLoss || 0).toFixed(4)}/ไม้`,
      subThb: tileThb(totals.grossLoss || 0),
      icon: '🛑',
      cls: 'is-bear',
    },
    {
      label: 'Win Rate',
      value: `${totals.winRate}%`,
      sub: `${totals.wins}W / ${totals.losses}L`,
      subThb: null,
      icon: '🎯',
      cls: 'is-gold',
    },
    {
      label: 'Total Trades',
      value: totals.trades,
      sub: 'ไม้',
      subThb: null,
      icon: '📊',
      cls: 'is-info',
    },
    {
      label: 'Best Day',
      value: bestDay ? formatUsdt(bestDay.pnl) : '—',
      sub: bestDay ? bestDay.date.slice(5) : '—',
      subThb: bestDay ? tileThb(bestDay.pnl) : null,
      icon: '🏆',
      cls: bestDay && bestDay.pnl > 0 ? 'is-bull' : 'is-flat',
    },
    {
      label: 'Worst Day',
      value: worstDay ? formatUsdt(worstDay.pnl) : '—',
      sub: worstDay ? worstDay.date.slice(5) : '—',
      subThb: worstDay ? tileThb(worstDay.pnl) : null,
      icon: '💀',
      cls: worstDay && worstDay.pnl < 0 ? 'is-bear' : 'is-flat',
    },
  ];
  document.getElementById('pnl-stats-row').innerHTML = tiles
    .map(
      (t) => `<div class="stat-tile ${t.cls}">
        <div class="tile-label">${escapeHtml(t.label)}${t.icon ? ` <span class="glyph">${t.icon}</span>` : ''}</div>
        <div class="tile-value">${t.value}</div>
        ${t.sub ? `<div class="tile-sub">${escapeHtml(t.sub)}</div>` : ''}
        ${t.subThb ? `<div class="sub-thb">🇹🇭 ${escapeHtml(t.subThb)}</div>` : ''}
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
      // FIX-2026-07-29 (v2): ใช้ class แทน calc+rgba alpha (calc() ใน rgba alpha ไม่เสถียร + ทำให้ day-num หายเมื่อ intensity=0)
      //   - intensity >= 0.55 → .is-on-bright → dark text + light shadow บน saturated bg
      //   - intensity < 0.55  → ค่า default → light text + dark shadow บน faded bg
      if (intensity >= 0.55) cell.classList.add('is-on-bright');
    }
    const dayNum = parseInt(day.date.slice(-2), 10);
    const pnlCls = day.pnl > 0 ? 'pnl-bull' : day.pnl < 0 ? 'pnl-bear' : '';
    // FIX-2026-07-29: เพิ่ม THB equivalent ใต้ USDT pnl (ถ้ามี FX rate)
    const thb = (window.__fx && window.__fx.rate) ? (day.pnl * window.__fx.rate) : null;
    const thbLine = thb != null && day.trades > 0
      ? `<div class="pnl-cal-thb ${pnlCls}">≈ ฿${formatThbInline(thb)}</div>`
      : '';
    cell.innerHTML = `
      <div class="pnl-cal-day-num">${dayNum}</div>
      ${
        day.trades > 0
          ? `<div class="pnl-cal-pnl ${pnlCls}">${formatUsdt(day.pnl)}</div>
             ${thbLine}
             <div class="pnl-cal-trades">${day.trades} ไม้</div>`
          : ''
      }
    `;
    cell.title =
      day.trades > 0
        ? `${day.date}\nPnL: ${formatUsdt(day.pnl)} USDT${thb != null ? ' (≈ ฿' + formatThbInline(thb) + ')' : ''}\nGross Profit: +${(day.grossProfit || 0).toFixed(4)} USDT (${day.wins}W)\nGross Loss: ${(day.grossLoss || 0).toFixed(4)} USDT (${day.losses}L)\nTrades: ${day.trades}\n(คลิกเพื่อดูรายละเอียด)`
        : day.date;
    // FIX-2026-07-29: คลิกที่ cell (ที่มี trades) → เปิด modal รายละเอียดของวันนั้น
    if (day.trades > 0) {
      cell.classList.add('is-clickable');
      cell.addEventListener('click', () => openDayModal(day));
    }
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

// ─── Day-detail modal (FIX-2026-07-29) ─────────────────
// คลิกที่ cell ใน calendar → modal แสดงรายการเทรดทั้งหมดของวันนั้น
let _modalOverlay = null;

async function openDayModal(day) {
  // 1) Lazy-build modal DOM (ครั้งเดียว)
  if (!_modalOverlay) buildModalSkeleton();
  const overlay = _modalOverlay;
  const body = overlay.querySelector('#pnl-modal-body');
  const titleEl = overlay.querySelector('#pnl-modal-title');
  const totalEl = overlay.querySelector('#pnl-modal-total');

  titleEl.textContent = `📊 ${day.date}`;
  // FIX-2026-08-01: แสดง grossProfit + grossLoss + มูลค่า THB ครบใน modal header
  const grossProfit = (day.grossProfit || 0);
  const grossLoss = (day.grossLoss || 0);
  const total = day.pnl;
  const fxRate = (window.__fx && window.__fx.rate) ? window.__fx.rate : null;
  const thb = fxRate != null ? (total * fxRate) : null;
  const grossProfitThb = fxRate != null ? (grossProfit * fxRate) : null;
  const grossLossThb = fxRate != null ? (grossLoss * fxRate) : null;
  const totalSignCls = total > 0 ? 'is-bull' : (total < 0 ? 'is-bear' : '');
  totalEl.innerHTML = `
    <div class="pnl-modal-summary-row">
      <span class="pnl-modal-main-pnl ${totalSignCls}">${formatUsdt(total)} <span class="unit">USDT</span></span>
      ${thb != null ? `<span class="pnl-modal-thb ${totalSignCls}">≈ ${thb >= 0 ? '+' : ''}฿${formatThbInline(thb)}</span>` : '<span class="muted">FX ไม่พร้อม</span>'}
    </div>
    <div class="pnl-modal-gl-row">
      <span class="gl-pill is-bull" title="ผลรวมไม้ที่กำไร — ${day.wins} ไม้">
        <span class="gl-label">กำไร</span>
        +${grossProfit.toFixed(4)} USDT
        ${grossProfitThb != null ? `<span class="gl-thb">≈ +฿${formatThbInline(grossProfitThb)}</span>` : ''}
        <span class="gl-count">(${day.wins}W)</span>
      </span>
      <span class="gl-pill is-bear" title="ผลรวมไม้ที่ขาดทุน — ${day.losses} ไม้">
        <span class="gl-label">ขาดทุน</span>
        ${grossLoss.toFixed(4)} USDT
        ${grossLossThb != null ? `<span class="gl-thb">≈ ฿${formatThbInline(Math.abs(grossLossThb))}</span>` : ''}
        <span class="gl-count">(${day.losses}L)</span>
      </span>
      <span class="muted">· ${day.trades} ไม้ · ${day.trades ? Math.round((day.wins / day.trades) * 100) : 0}% win</span>
    </div>
  `;
  body.innerHTML = '<div class="text-center py-4 text-muted-3">กำลังโหลด…</div>';
  overlay.classList.add('is-open');

  // 2) Fetch trades for that day (ใช้ endpoint เดียวกับ history)
  try {
    const params = new URLSearchParams({ from: day.date, to: day.date });
    if (currentBotId) params.set('botId', currentBotId);
    const data = await API.get(`/api/pnl/day?${params}`);
    renderModalTrades(body, data.trades || []);
  } catch (err) {
    body.innerHTML = `<div class="text-center py-4 text-muted-3">โหลดล้มเหลว: ${escapeHtml(err.message || 'unknown')}</div>`;
  }
}

function renderModalTrades(container, trades) {
  if (!trades.length) {
    container.innerHTML = '<div class="text-center py-4 text-muted-3">ไม่มีไม้</div>';
    return;
  }
  // FIX-2026-08-01: เรียงจากใหม่สุดขึ้นก่อน (sellFilledAt DESC)
  const sortedTrades = [...trades].sort((a, b) => {
    const at = a.sellFilledAt ? new Date(a.sellFilledAt).getTime() : 0;
    const bt = b.sellFilledAt ? new Date(b.sellFilledAt).getTime() : 0;
    return bt - at;
  });
  const rows = sortedTrades.map((t) => {
    const pnl = t.realizedPnl || 0;
    const cls = pnl > 0 ? 'pnl-bull' : pnl < 0 ? 'pnl-bear' : '';
    const ts = t.sellFilledAt ? new Date(t.sellFilledAt).toLocaleString('th-TH', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : '';
    const thb = (window.__fx && window.__fx.rate) ? (pnl * window.__fx.rate) : null;
    // FIX-2026-08-02: DCA stack — show layer count + BEP instead of single-entry view
    const isDcaStack = t.isDcaStack === true;
    const dcaBadge = isDcaStack
      ? `<span class="dca-pill" title="DCA stack — ${t.dcaLayerCount || '?'} layers, BEP=${Number(t.stackBep || t.buyPrice || 0).toFixed(8)}">📚 L${t.dcaLayerCount || '?'}</span>`
      : '';
    const entryDisplay = isDcaStack
      ? `<span title="stack BEP">${t.stackBep ? PriceFormat.format(parseFloat(t.stackBep), t.symbol) : '—'}</span>`
      : (t.entryPrice ? PriceFormat.format(parseFloat(t.entryPrice), t.symbol) : '—');
    const qtyDisplay = isDcaStack
      ? `${t.stackTotalQty ? parseFloat(t.stackTotalQty).toFixed(4) : (t.qty ? parseFloat(t.qty).toFixed(4) : '—')}`
      : (t.qty ? parseFloat(t.qty).toFixed(4) : '—');
    return `<tr>
      <td><span class="badge-bot">${escapeHtml(t.botName || '?')}</span></td>
      <td>${escapeHtml(t.symbol || '')} ${dcaBadge}</td>
      <td class="text-end">${entryDisplay}</td>
      <td class="text-end">${t.exitPrice ? PriceFormat.format(parseFloat(t.exitPrice), t.symbol) : '—'}</td>
      <td class="text-end">${qtyDisplay}</td>
      <td class="text-end ${cls}">${formatUsdt(pnl)}${thb != null ? `<br><span class="thb-sub">≈ ฿${formatThbInline(thb)}</span>` : ''}</td>
      <td class="text-end muted">${ts}</td>
      <td>${SellReasons.renderSellReasonPill(t.sellReason, t.sellReasonDetail)}</td>
    </tr>`;
  }).join('');
  container.innerHTML = `
    <table class="pnl-modal-table">
      <thead>
        <tr>
          <th>Bot</th><th>Symbol</th>
          <th class="text-end">Entry</th><th class="text-end">Exit</th>
          <th class="text-end">Qty</th>
          <th class="text-end">PnL</th>
          <th class="text-end">เวลา</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function buildModalSkeleton() {
  const overlay = document.createElement('div');
  overlay.className = 'pnl-modal-overlay';
  overlay.innerHTML = `
    <div class="pnl-modal-card">
      <div class="pnl-modal-header">
        <h5 id="pnl-modal-title">—</h5>
        <button type="button" class="pnl-modal-close" aria-label="ปิด">✕</button>
      </div>
      <div id="pnl-modal-total" class="pnl-modal-total"></div>
      <div id="pnl-modal-body" class="pnl-modal-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  // close handlers
  overlay.querySelector('.pnl-modal-close').addEventListener('click', () => overlay.classList.remove('is-open'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('is-open'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.classList.remove('is-open'); });
  _modalOverlay = overlay;
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
    console.log('[pnl] series', { count: data.count, sample: data.trades?.[0] });
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

  if (!trades.length) {
    document.getElementById('pnl-chart-range').textContent = 'ไม่มีไม้ในช่วงนี้';
    return;
  }

  // Build cumulative points (USDT หรือ THB ตาม currencyMode)
  const fxRate = currencyMode === 'THB' && window.__fx && window.__fx.rate ? window.__fx.rate : 1;
  let cum = 0;
  const pts = [];
  let badDataCount = 0;
  for (const t of trades) {
    const inc = currencyMode === 'THB' ? t.realizedPnl * fxRate : t.realizedPnl;
    if (typeof inc !== 'number' || !isFinite(inc)) { badDataCount++; continue; }
    cum += inc;
    const ts = new Date(t.sellFilledAt).getTime();
    if (!isFinite(ts)) { badDataCount++; continue; }
    pts.push({
      time: Math.floor(ts / 1000),
      value: parseFloat(cum.toFixed(currencyMode === 'THB' ? 2 : 4)),
    });
  }
  // FIX-2026-07-29 v9: lightweight-charts v4 ต้องการ sorted + unique time
  //   duplicate time → painter งง → "Value is null"
  const seenTime = new Set();
  const deduped = [];
  let dupCount = 0;
  for (const p of pts) {
    if (seenTime.has(p.time)) { dupCount++; continue; }
    seenTime.add(p.time);
    deduped.push(p);
  }
  deduped.sort((a, b) => a.time - b.time);

  console.log('[pnl] v9 data check', { trades: trades.length, pts: pts.length, deduped: deduped.length, badData: badDataCount, dups: dupCount, sampleFirst: deduped[0], sampleLast: deduped[deduped.length - 1] });

  if (!deduped.length) {
    document.getElementById('pnl-chart-range').textContent = 'ไม่มีข้อมูล valid';
    return;
  }

  // FIX-2026-07-29 (v9): width=600 ก็ยัง error → ปัญหาน่าจะเป็น timing ของ internal RAF loop
  //   fix: ใช้ minimal options (ตัด crosshair/handle* ออก) เพื่อให้ lightweight-charts render simple ที่สุด
  const chartW = Math.max(container.clientWidth, 600);
  const chartH = 380;
  const lastVal = deduped[deduped.length - 1].value;
  const bull = lastVal >= 0;
  pnlChart = LightweightCharts.createChart(container, {
    width: chartW,
    height: chartH,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#94a3b8',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.04)' },
      horzLines: { color: 'rgba(255,255,255,0.04)' },
    },
    rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
    timeScale: {
      borderColor: 'rgba(255,255,255,0.06)',
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 12,
    },
  });
  pnlSeries = pnlChart.addLineSeries({
    color: bull ? '#00e5b8' : '#ff4d6d',
    lineWidth: 2,
  });
  pnlSeries.setData(deduped);
  pnlSeries.createPriceLine({
    price: 0,
    color: 'rgba(255,255,255,0.35)',
    lineWidth: 1,
    lineStyle: 2,
    title: 'break-even',
  });
  pnlChart.timeScale().fitContent();
  console.log('[pnl] chart rendered v9', { pts: deduped.length, last: lastVal, w: chartW });
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

  // Resize handler for chart — FIX v8: ใช้ parent width (lux-card) แทน container
  //   container.clientWidth อาจจะยังแคบเพราะ calendar grid
  //   ใช้ max(window width * 0.9, 600) เพื่อให้ chart ใหญ่เสมอ
  window.addEventListener('resize', () => {
    if (!pnlChart) return;
    const w = Math.max(window.innerWidth * 0.85, 600);
    pnlChart.applyOptions({ width: w });
    pnlChart.timeScale().fitContent();
  });
}

// ─── Init ────────────────────────────────────────────
(async () => {
  setupNav();
  // FIX-2026-07-31: preload Binance tickSize precision สำหรับ PriceFormat
  if (window.PriceFormat) await window.PriceFormat.load();
  await loadBots();
  await Promise.all([loadCalendar(), loadChart()]);
  setupWS();
})();