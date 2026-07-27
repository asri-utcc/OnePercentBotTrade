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
let currentPrice = null; // latest close price from kline:update WS (for live % PnL/% to TP on Positions tab)

/* Charts */
let priceChart = null;
let candleSeries = null;
let basisSeries = null;   // EMA (Keltner basis)
let upperSeries = null;   // Upper Keltner Channel
let lowerSeries = null;   // Lower Keltner Channel
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
      // Fast path: if Positions tab is active, do a targeted re-render + soft refresh
      if (activeTab === 'positions') {
        // Update in-place trade state for instant UI; refresh() follows for full sync
        const t = detail.trades.find((x) => x._id === p.tradeId);
        if (t && p.state) t.state = p.state;
        renderPositions();
        renderSummary();
      }
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
    // feed live price to Positions tab (% PnL / % to TP)
    const newPrice = parseFloat(p.kline.close);
    if (!isNaN(newPrice) && newPrice > 0) {
      currentPrice = newPrice;
      if (activeTab === 'positions') renderPositions();
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
    await LUX_CONFIRM.callBotWithPassword('POST', `/api/bots/${BOT_ID}/enable`, {}, 'เปิดบอท');
    await refresh();
  };
  document.getElementById('disable-btn').onclick = async () => {
    await LUX_CONFIRM.callBotWithPassword('POST', `/api/bots/${BOT_ID}/disable`, {}, 'หยุดบอท');
    await refresh();
  };
  const forceBtn = document.getElementById('force-close-bot-btn');
  if (forceBtn) forceBtn.onclick = forceCloseBotFlow;
  const loadOlderBtn = document.getElementById('btn-load-older');
  if (loadOlderBtn) loadOlderBtn.onclick = loadOlderCandles;

  // Per-trade Force Close via event delegation (cards re-render every refresh)
  const desk = document.getElementById('positions-list');
  const mob = document.getElementById('positions-mob');
  if (desk) desk.addEventListener('click', onPositionListClick);
  if (mob) mob.addEventListener('click', onPositionListClick);
}

async function onPositionListClick(ev) {
  const btn = ev.target.closest('.btn-force-close');
  if (!btn) return;
  const tradeId = btn.dataset.tradeId;
  if (!tradeId) return;
  const trade = (detail.trades || []).find((t) => String(t._id) === String(tradeId));
  if (!trade) return;
  await forceClosePositionFlow(trade);
}

async function forceClosePositionFlow(trade) {
  const target = {
    name: trade.symbol || '-',
    symbol: trade.symbol || '-',
    timeframe: trade.timeframe || '-',
  };
  const pw = await LUX_CONFIRM.luxConfirm({
    variant: 'danger',
    icon: '🛑',
    title: 'ยืนยันบังคับปิด position',
    sub: `จะยกเลิก SELL (ถ้ามี) แล้ว MARKET SELL freeQty (ถ้ามี asset) หรือ synthetic-close`,
    message: `ไม้ ${trade._id} (${trade.symbol}, state=${trade.state}, qty=${Number(trade.buyQty || 0).toFixed(6)}) — ปิดเลยหรือไม่?`,
    target, requirePassword: true,
    dangerNote: 'บอทยังคงทำงานต่อ — เฉพาะไม้นี้ที่ถูกปิด (ถ้าจะปิดทั้งบอทให้ใช้ปุ่ม ⛔ Force Close บอท)',
    confirmLabel: 'บังคับปิดไม้นี้', confirmGlyph: '🛑',
  });
  if (pw === null) return;
  try {
    const resp = await LUX_CONFIRM.callBotWithPassword(
      'POST',
      `/api/bots/${BOT_ID}/trades/${trade._id}/force-close`,
      { password: pw || undefined },
      `force-close position ${trade._id}`,
    );
    const mode = resp && resp.result && resp.result.mode;
    await LUX_CONFIRM.luxAlert({
      variant: 'success',
      icon: '✅',
      title: 'บังคับปิดไม้สำเร็จ',
      message: `mode=${mode || 'unknown'} · pnl=${(resp.result && resp.result.pnl != null) ? resp.result.pnl.toFixed(4) : '-'} USDT`,
    });
    await refresh();
  } catch (err) {
    await LUX_CONFIRM.luxAlert({
      variant: 'danger', icon: '⚠️', title: 'บังคับปิดไม้ไม่สำเร็จ', message: err.message,
    });
  }
}

async function forceCloseBotFlow() {
  if (!detail || !detail.bot) return;
  const open = (detail.trades || []).filter((t) => OPEN_TRADE_STATES.includes(t.state));
  if (open.length === 0) {
    await LUX_CONFIRM.luxAlert({
      variant: 'info', icon: 'ℹ️', title: 'ไม่มี position ที่เปิดอยู่', message: 'บอทนี้ไม่มี trade ค้าง — ไม่ต้องบังคับปิด',
    });
    return;
  }
  const bot = detail.bot;
  const target = { name: bot.name || bot.symbol, symbol: bot.symbol, timeframe: bot.timeframe };
  const pw = await LUX_CONFIRM.luxConfirm({
    variant: 'danger',
    icon: '⛔',
    title: 'ยืนยันบังคับปิดทั้งบอท',
    sub: `จะปิด ${open.length} positions แล้วหยุดบอททันที`,
    message: `บอท ${bot.name || bot.symbol} (${bot.symbol}/${bot.timeframe}) — ปิดทั้งหมดและหยุดบอท?`,
    target, requirePassword: true,
    dangerNote: 'บอทจะถูก disable หลัง force-close ทุกไม้ — ต้องกด ▶ เริ่มใหม่เองเมื่อต้องการ',
    confirmLabel: 'บังคับปิดบอท', confirmGlyph: '⛔',
  });
  if (pw === null) return;
  try {
    const resp = await LUX_CONFIRM.callBotWithPassword(
      'POST',
      `/api/bots/${BOT_ID}/force-close`,
      { password: pw || undefined, disableBot: true },
      `force-close bot ${bot.symbol}`,
    );
    let msg = `ปิด ${resp.closedTrades.length} ไม้ (errors: ${resp.errors.length}) · disabled: ${resp.disabled ? 'ใช่' : 'ไม่'}`;
    if (resp.closedTrades.length) {
      msg += '\n\nรายละเอียด:\n' + resp.closedTrades.map((c) =>
        `  • ${c.tradeId}  ${c.symbol}  mode=${c.mode}  pnl=${Number(c.pnl || 0).toFixed(4)}`
      ).join('\n');
    }
    if (resp.errors.length) {
      msg += '\n\nข้อผิดพลาด:\n' + resp.errors.map((e) => `  • ${e.tradeId || e.stage || '-'}  ${e.error}`).join('\n');
    }
    await LUX_CONFIRM.luxAlert({
      variant: resp.errors.length ? 'warning' : 'success',
      icon: resp.errors.length ? '⚠️' : '✅',
      title: 'บังคับปิดบอทเสร็จสิ้น',
      message: msg,
    });
    await refresh();
  } catch (err) {
    await LUX_CONFIRM.luxAlert({
      variant: 'danger', icon: '⚠️', title: 'บังคับปิดบอทไม่สำเร็จ', message: err.message,
    });
  }
}

/* ── Fetch ────────────────────────────────────────────── */
async function refresh() {
  try {
    // limit=200 → fetch up to 200 trades/signals so chart has enough
    // BUY/SELL history to draw across all 150 candles (initial load).
    detail = await API.get(`/api/bots/${BOT_ID}/details?limit=200`);
    renderAll();
  } catch (err) {
    console.error('refresh failed', err);
    if (err.message && err.message.includes('not found')) {
      alert('Bot not found');
      location.href = '/bots.html';
    }
  }
}

// re-render THB equivalents once nav.js publishes the FX rate
document.addEventListener('fx:updated', () => {
  if (detail) {
    renderSummary();
    if (activeTab === 'positions') renderPositions();
  }
});
// also re-render if FX was already cached by nav.js before this script ran
if (window.__fxReady && detail) {
  renderSummary();
  if (activeTab === 'positions') renderPositions();
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
  renderPositions();
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

  const ts = fmtTime(new Date());
  document.getElementById('hero-updated').textContent = `อัปเดตล่าสุด: ${ts}`;

  document.getElementById('enable-btn').style.display = b.enabled ? 'none' : '';
  document.getElementById('disable-btn').style.display = b.enabled ? '' : 'none';
}

function renderMetaChips() {
  try {
    const b = detail.bot;
    document.getElementById('hero-symbol').textContent = `${b.symbol}`;
    document.getElementById('hero-tf').textContent = `⏱ ${b.timeframe}`;
    document.getElementById('hero-enabled').textContent = b.enabled ? '● ENABLED' : '○ DISABLED';
    document.getElementById('hero-enabled').className = 'chip ' + (b.enabled ? 'bull' : '');
    const uptimeEl = document.getElementById('hero-uptime');
    if (b.enabled && b.enabledAt) {
      const sec = Math.floor((Date.now() - new Date(b.enabledAt).getTime()) / 1000);
      uptimeEl.textContent = `⏱ uptime: ${formatUptime(sec)}`;
      uptimeEl.style.color = 'var(--bull-1)';
    } else {
      uptimeEl.textContent = '⏱ uptime: -';
      uptimeEl.style.color = 'var(--text-4)';
    }
    document.getElementById('hero-id').textContent = `id: ${b._id.slice(-8)}`;
  } catch (err) {
    console.error('renderMetaChips', err);
  }
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
  const month = detail.monthStats || { trades: 0, pnl: 0 };
  const monthPnl = month.pnl || 0;
  const monthTrades = month.trades || 0;

  const tilePnl = document.getElementById('tile-pnl');
  tilePnl.classList.remove('is-bull', 'is-bear', 'is-gold');
  if (totalPnl > 0) tilePnl.classList.add('is-bull');
  else if (totalPnl < 0) tilePnl.classList.add('is-bear');
  else tilePnl.classList.add('is-gold');

  const totalThb = window.usdtToThb ? window.usdtToThb(totalPnl) : '';
  const pnlEl = document.getElementById('stat-pnl');
  pnlEl.innerHTML = `${formatUsdt(totalPnl)}${totalThb ? `<span class="thb-eq" style="display:block;font-size:0.85rem;opacity:0.8;font-weight:500;">${totalThb}</span>` : ''}`;
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
    const todayThb = window.usdtToThb ? window.usdtToThb(todayPnl) : '';
    const todayEl = document.getElementById('stat-today-pnl');
    todayEl.innerHTML = `${formatUsdt(todayPnl)}${todayThb ? `<span class="thb-eq" style="display:block;font-size:0.85rem;opacity:0.8;font-weight:500;">${todayThb}</span>` : ''}`;
    todayEl.className = 'value ' + (todayPnl > 0 ? 'pnl-bull' : todayPnl < 0 ? 'pnl-bear' : '');
    document.getElementById('stat-today-pnl-sub').textContent = `USDT · ${todayTrades} ไม้`;
  }
  const tileTT = document.getElementById('tile-today-trades');
  if (tileTT) {
    document.getElementById('stat-today-trades').textContent = todayTrades;
    const todayThbTxt = window.usdtToThb ? window.usdtToThb(todayPnl) : '';
    const todayUsdt = todayPnl >= 0 ? `กำไร ${formatUsdt(todayPnl)} USDT` : (todayPnl < 0 ? `ขาดทุน ${formatUsdt(Math.abs(todayPnl))} USDT` : 'ยังไม่มี');
    document.getElementById('stat-today-trades-sub').textContent = todayThbTxt ? `${todayUsdt} (${todayThbTxt})` : todayUsdt;
  }

  // Month stats
  const tileMonth = document.getElementById('tile-month-pnl');
  if (tileMonth) {
    tileMonth.classList.remove('is-bull', 'is-bear', 'is-gold');
    if (monthPnl > 0) tileMonth.classList.add('is-bull');
    else if (monthPnl < 0) tileMonth.classList.add('is-bear');
    else tileMonth.classList.add('is-gold');
    const monthThb = window.usdtToThb ? window.usdtToThb(monthPnl) : '';
    const monthEl = document.getElementById('stat-month-pnl');
    monthEl.innerHTML = `${formatUsdt(monthPnl)}${monthThb ? `<span class="thb-eq" style="display:block;font-size:0.85rem;opacity:0.8;font-weight:500;">${monthThb}</span>` : ''}`;
    monthEl.className = 'value ' + (monthPnl > 0 ? 'pnl-bull' : monthPnl < 0 ? 'pnl-bear' : '');
    document.getElementById('stat-month-pnl-sub').textContent = `${monthTrades} ไม้ · เดือนนี้`;
  }
  const tileMT = document.getElementById('tile-month-trades');
  if (tileMT) {
    document.getElementById('stat-month-trades').textContent = monthTrades;
    const monthThbTxt = window.usdtToThb ? window.usdtToThb(monthPnl) : '';
    const monthUsdt = monthPnl >= 0 ? `กำไร ${formatUsdt(monthPnl)} USDT` : (monthPnl < 0 ? `ขาดทุน ${formatUsdt(Math.abs(monthPnl))} USDT` : 'ยังไม่มี');
    document.getElementById('stat-month-trades-sub').textContent = monthThbTxt ? `${monthUsdt} (${monthThbTxt})` : monthUsdt;
  }

  // sparkline for PnL (cumulative of last 20 closed trades)
  drawSpark('spark-pnl', buildPnlSeries(), totalPnl >= 0 ? 'bull' : 'bear');

  // Show/hide "Force Close บอท" button — only when there are open positions AND bot is enabled
  const forceBtn = document.getElementById('force-close-bot-btn');
  if (forceBtn) {
    const hasOpen = (detail.trades || []).some((t) => OPEN_TRADE_STATES.includes(t.state));
    forceBtn.style.display = (b.enabled && hasOpen) ? '' : 'none';
  }
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
    <div class="row"><span class="k">BUY Placed</span><span class="v" style="font-size:0.78rem;">${t.buyPlacedAt ? fmtTime(t.buyPlacedAt) : '-'}</span></div>
    <div class="row"><span class="k">SELL OrderId</span><span class="v code" style="font-size:0.75rem;">${t.sellOrderId || '-'}</span></div>
    <div class="row"><span class="k">Target Sell</span><span class="v">${t.targetSellPrice != null ? t.targetSellPrice.toFixed(4) : '-'}</span></div>
    <div class="row"><span class="k">Retry</span><span class="v">${t.retryCount ?? 0} / ${detail.bot.retryMax ?? 1}</span></div>
    ${t.error ? `<div class="row"><span class="k">Note</span><span class="v" style="color:var(--bear-1);font-size:0.78rem;">${escapeHtml(t.error)}</span></div>` : ''}
    <div class="retry-bar" title="Slots: ${usedSlots}/${retryMax}">${segs.join('')}</div>`;
}

/* ── Positions tab (open trades) ─────────────────────── */
const OPEN_TRADE_STATES = ['placed', 'filled', 'holding', 'selling', 'retrying'];

function computePositionMetrics(t) {
  const entry = Number(t.buyPrice) || 0;
  const qty   = Number(t.buyQty)   || 0;
  const tp    = Number(t.targetSellPrice) || 0;
  const px    = (currentPrice && currentPrice > 0) ? currentPrice : entry;

  // % PnL on the position (mark-to-market)
  const pnlPct = entry > 0 ? ((px - entry) / entry) * 100 : 0;
  // Unrealized PnL = mark-to-market vs entry × qty
  const unrealizedUsdt = (px - entry) * qty;

  // % to TP = how much the CURRENT PRICE must go UP to reach TP
  //   e.g. entry 100, current 100.10, TP 100.25 → pctToTp = (0.15/100.10)*100 ≈ 0.1499%
  //   if current ≥ tp → already at/over TP → 0% (bar empty)
  //   if tp not yet set (waiting for BUY fill) → null
  let pctToTp = null;
  let tpReached = false;
  if (tp > 0 && px > 0) {
    if (px >= tp) {
      pctToTp = 0;
      tpReached = true;
    } else {
      pctToTp = ((tp - px) / px) * 100;
    }
  }

  // Bar fill = % of total TP-distance still remaining from current price
  //   total = ((tp - entry) / entry) * 100  (e.g. +0.25%)
  //   remaining = pctToTp
  //   bar = remaining / total * 100, clamped 0..100
  //   → 100% bar = just entered, 0% = at TP. Bar shrinks as price climbs.
  let barPct = 0;
  const totalPathPct = (tp > 0 && entry > 0) ? ((tp - entry) / entry) * 100 : 0;
  if (pctToTp != null && totalPathPct > 0) {
    barPct = (pctToTp / totalPathPct) * 100;
    if (barPct < 0) barPct = 0;
    if (barPct > 100) barPct = 100;
  }

  // Duration since buyFilledAt (or buyPlacedAt if not yet filled)
  const startAt = t.buyFilledAt || t.buyPlacedAt || t.createdAt;
  const durMs = startAt ? (Date.now() - new Date(startAt).getTime()) : 0;

  return {
    entry, qty, tp, px,
    pnlPct, unrealizedUsdt,
    pctToTp, tpReached, barPct, totalPathPct,
    durMs,
  };
}

function renderPositionCard(t) {
  const m = computePositionMetrics(t);
  const ageTxt = m.durMs > 0 ? formatDuration(m.durMs) : '—';
  const thbUpnl = window.usdtToThb ? window.usdtToThb(m.unrealizedUsdt) : '';
  const thbPx   = window.usdtToThb ? window.usdtToThb(m.px) : '';
  const thbVal  = window.usdtToThb ? window.usdtToThb(m.entry * m.qty) : '';
  const pnlCls  = m.pnlPct >= 0 ? 'pnl-bull' : 'pnl-bear';
  const pnlSign = m.pnlPct >= 0 ? '+' : '';
  const barPct  = Math.round(m.barPct || 0);

  // Label: "% to TP" = how much current price must go UP to reach TP
  //   e.g. entry 100, current 100.10, TP 100.25 → "ต้องขึ้นอีก 0.150%"
  let tpLabel;
  if (m.pctToTp == null) {
    tpLabel = '⚠️ รอ BUY fill';
  } else if (m.tpReached) {
    tpLabel = '🎯 ถึง TP แล้ว!';
  } else {
    tpLabel = `ต้องขึ้นอีก ${m.pctToTp.toFixed(3)}% ถึง TP`;
  }

  // progress section sub-label = "TP at X.XXXX · path เดิม +Y.YY%"
  let progressSub;
  if (m.tp > 0) {
    progressSub = `TP at ${m.tp.toFixed(4)} · path เดิม ${m.totalPathPct >= 0 ? '+' : ''}${m.totalPathPct.toFixed(3)}%`;
  } else {
    progressSub = 'TP ยังไม่ตั้ง';
  }

  // TP cell sub-line
  let tpSub;
  if (m.tp > 0) {
    if (m.tpReached) {
      tpSub = `เกิน TP แล้ว +${(-((m.px - m.tp) / m.tp) * 100).toFixed(3)}%`;
    } else {
      tpSub = `${m.totalPathPct >= 0 ? '+' : ''}${m.totalPathPct.toFixed(3)}% above entry`;
    }
  } else {
    tpSub = 'ยังไม่ได้ตั้ง (รอ BUY fill)';
  }

  // entry sub-line
  const entrySub = t.buyFilledAt
    ? `filled ${fmtDateTime(t.buyFilledAt)}`
    : (t.buyPlacedAt ? `placed ${fmtDateTime(t.buyPlacedAt)}` : 'placed');

  return `
    <div class="position-card ${pnlCls}" data-trade-id="${escapeHtml(String(t._id || ''))}">
      <div class="pos-head">
        <div class="left">
          <span class="sym-tag">${escapeHtml(t.symbol || '-')}</span>
          <span class="tf-tag">${escapeHtml(t.timeframe || '-')}</span>
          <span class="status-pill is-${STATE_COLORS[t.state] || ''}">${escapeHtml(t.state || '-')}</span>
          <span class="retry-pill" title="retry slots">🔄 ${t.retryCount ?? 0}/${detail.bot.retryMax ?? 1}</span>
        </div>
        <div class="right">
          <span class="pos-age" title="เปิดมานาน"><span class="age-icon">⏱</span> ${ageTxt}</span>
        </div>
      </div>

      <div class="pos-grid">
        <div class="cell">
          <span class="k">Entry</span>
          <span class="v mono">${m.entry > 0 ? m.entry.toFixed(4) : '-'}</span>
          <span class="sub">${entrySub}</span>
        </div>
        <div class="cell">
          <span class="k">Qty</span>
          <span class="v mono">${m.qty > 0 ? m.qty.toFixed(6) : '-'}</span>
          <span class="sub">${thbVal ? `≈ ${thbVal} (THB)` : `≈ ${(m.qty * m.entry).toFixed(2)} USDT`}</span>
        </div>
        <div class="cell">
          <span class="k">Current</span>
          <span class="v mono ${pnlCls}">${m.px > 0 ? m.px.toFixed(4) : '-'}</span>
          ${thbPx ? `<span class="sub thb-eq">${thbPx}</span>` : ''}
        </div>
        <div class="cell">
          <span class="k">TP Target</span>
          <span class="v mono">${m.tp > 0 ? m.tp.toFixed(4) : '—'}</span>
          <span class="sub">${tpSub}</span>
        </div>
        <div class="cell">
          <span class="k">Unrealized PnL</span>
          <span class="v mono ${pnlCls}">${pnlSign}${m.unrealizedUsdt.toFixed(4)} USDT</span>
          ${thbUpnl ? `<span class="sub thb-eq">${thbUpnl}</span>` : ''}
        </div>
        <div class="cell">
          <span class="k">% PnL</span>
          <span class="v mono ${pnlCls}">${pnlSign}${m.pnlPct.toFixed(3)}%</span>
        </div>
      </div>

      <div class="pos-progress">
        <div class="pos-progress-label ${m.tpReached ? 'tp-reached' : ''}">
          <span>${tpLabel}</span>
          ${m.tp > 0 ? `<span class="text-muted-3" style="font-size:0.7rem;">${progressSub}</span>` : ''}
        </div>
        <div class="pct-bar" title="bar = % ระยะที่เหลือจากราคาปัจจุบันไปยัง TP (100% = เพิ่งเปิด, 0% = ถึง TP)">
          <div class="pct-bar-fill ${pnlCls}" style="width:${barPct}%;"></div>
        </div>
      </div>

      <div class="pos-foot">
        <span class="pair"><span>Order:</span><strong class="code">${t.buyOrderId || '—'}</strong></span>
        ${t.sellOrderId ? `<span class="pair"><span>SELL:</span><strong class="code">${t.sellOrderId}</strong></span>` : ''}
        ${t.error ? `<span class="last-err">⚠️ ${escapeHtml(t.error)}</span>` : ''}
        <button type="button" class="btn-lux btn-bear btn-sm btn-force-close" data-trade-id="${escapeHtml(String(t._id || ''))}" title="บังคับปิดไม้นี้ (ยกเลิก SELL + MARKET SELL หรือ synthetic close)">🛑 Force Close</button>
      </div>
    </div>`;
}

function renderPositionCardMobile(t) {
  const m = computePositionMetrics(t);
  const ageTxt = m.durMs > 0 ? formatDuration(m.durMs) : '—';
  const thbUpnl = window.usdtToThb ? window.usdtToThb(m.unrealizedUsdt) : '';
  const pnlCls  = m.pnlPct >= 0 ? 'pnl-bull' : 'pnl-bear';
  const pnlSign = m.pnlPct >= 0 ? '+' : '';
  const barPct  = Math.round(m.barPct || 0);

  let tpLabel;
  if (m.pctToTp == null) {
    tpLabel = '⚠️ รอ BUY fill';
  } else if (m.tpReached) {
    tpLabel = '🎯 ถึง TP แล้ว!';
  } else {
    tpLabel = `ต้องขึ้นอีก ${m.pctToTp.toFixed(3)}%`;
  }

  return `
    <div class="mob-card position-mob">
      <div class="top">
        <span class="status-pill is-${STATE_COLORS[t.state] || ''}">${escapeHtml(t.state || '-')}</span>
        <span class="ts" style="color:var(--text-3);font-size:0.72rem;">⏱ ${ageTxt} · 🔄 ${t.retryCount ?? 0}/${detail.bot.retryMax ?? 1}</span>
      </div>
      <div class="row"><span class="k">Entry</span><span class="v">${m.entry > 0 ? m.entry.toFixed(4) : '-'}</span></div>
      <div class="row"><span class="k">Qty</span><span class="v">${m.qty > 0 ? m.qty.toFixed(6) : '-'}</span></div>
      <div class="row"><span class="k">Current</span><span class="v ${pnlCls}">${m.px > 0 ? m.px.toFixed(4) : '-'}</span></div>
      <div class="row"><span class="k">TP Target</span><span class="v">${m.tp > 0 ? m.tp.toFixed(4) : '—'}</span></div>
      <div class="row"><span class="k">% PnL</span><span class="v ${pnlCls}">${pnlSign}${m.pnlPct.toFixed(3)}%</span></div>
      <div class="row"><span class="k">Unrealized</span><span class="v ${pnlCls}">${pnlSign}${m.unrealizedUsdt.toFixed(4)} USDT${thbUpnl ? ` (${thbUpnl})` : ''}</span></div>
      <div class="row"><span class="k">Order</span><span class="v code">${t.buyOrderId || '—'}</span></div>
      <div class="row"><span class="k">% to TP</span><span class="v ${m.tpReached ? 'tp-reached' : ''}">${m.pctToTp == null ? '—' : `${m.pctToTp.toFixed(3)}%`}</span></div>
      <div class="pos-progress" style="margin-top:0.5rem;">
        <div class="pct-bar"><div class="pct-bar-fill ${pnlCls}" style="width:${barPct}%;"></div></div>
        <div class="pos-progress-label ${m.tpReached ? 'tp-reached' : ''}" style="margin-top:0.25rem;font-size:0.72rem;">
          ${tpLabel}
        </div>
      </div>
      <div style="margin-top:0.5rem;text-align:right;">
        <button type="button" class="btn-lux btn-bear btn-sm btn-force-close" data-trade-id="${escapeHtml(String(t._id || ''))}" title="บังคับปิดไม้นี้">🛑 Force Close</button>
      </div>
    </div>`;
}

function renderPositions() {
  const desk = document.getElementById('positions-list');
  const mob  = document.getElementById('positions-mob');
  const meta = document.getElementById('positions-price-meta');
  if (!desk) return;

  const open = (detail.trades || []).filter((t) => OPEN_TRADE_STATES.includes(t.state));
  document.getElementById('positions-count-label').textContent = `${open.length} ไม้`;
  document.getElementById('tab-positions-badge').textContent = open.length;

  if (meta) {
    if (currentPrice && currentPrice > 0) {
      meta.textContent = `ราคา: ${currentPrice.toFixed(4)}`;
    } else {
      meta.textContent = 'รอข้อมูลราคา…';
    }
  }

  if (open.length === 0) {
    desk.innerHTML = `<div class="empty-positions">ไม่มี position ที่เปิดอยู่ตอนนี้ — เมื่อ BUY fill แล้วจะปรากฏที่นี่ทันที พร้อม % PnL, % to TP และอายุแบบ realtime</div>`;
    if (mob) mob.innerHTML = '';
    return;
  }

  // sort by createdAt desc (newest first)
  open.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  desk.innerHTML = open.map(renderPositionCard).join('');
  if (mob) mob.innerHTML = open.map(renderPositionCardMobile).join('');
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
    { k: 'Retry time',      v: `${formatRetryTime(b.retryTimeMin)}` },
    { k: 'Retry max',       v: `${b.retryMax ?? 1} ครั้ง` },
    { k: 'KC Mult', v: `${b.kcMult ?? 1.5} (${(b.kcMult ?? 1.5) < 1.5 ? 'KC แคบ — sensitive' : (b.kcMult ?? 1.5) > 1.5 ? 'KC กว้าง — conservative' : 'ค่าเดิม'})` },
    { k: 'Stop Loss (upper-KC)', v: b.stopLossOnUpperKC ? '🛑 เปิด — ปิด position ขาดทุนเมื่อราคาทะลุ upper-KC' : '⏸ ปิดอยู่' },
    { k: 'Auto-update TP%', v: b.autoUpdateTp
        ? `⏰ เปิด — recompute ทุกต้นชั่วโมง${b.updateTpAt ? ` (ล่าสุด: ${fmtDateTime(b.updateTpAt)})` : ''}`
        : '⏸ ปิดอยู่' },
    { k: 'Enabled',         v: b.enabled ? '✅ เปิดใช้งาน' : '⏸ ปิดอยู่' },
    { k: 'Last Signal',     v: b.lastSignalAt ? fmtDateTime(b.lastSignalAt) : '-' },
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
        <td><span class="ts">${fmtDateTime(t.createdAt)}</span></td>
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
          <span class="ts" style="color:var(--text-3);font-size:0.72rem;">${fmtDateTime(t.createdAt)}</span>
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
        <td><span class="ts">${fmtDateTime(s.createdAt)}</span></td>
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
          <span class="ts" style="color:var(--text-3);font-size:0.72rem;">${fmtDateTime(s.createdAt)}</span>
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
        <span class="ts">${fmtDateTime(s.createdAt)}</span>
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

// Adaptive price-axis formatter — ปรับจำนวนทศนิยมตามขนาดราคา
//   ≥1000 → 2,  ≥1 → 4,  ≥0.01 → 4,  ≥0.0001 → 5,  <0.0001 → 6
function chartPriceFormatter(price) {
  if (price === null || price === undefined || !Number.isFinite(price)) return '';
  const abs = Math.abs(price);
  if (abs >= 1000) return price.toFixed(2);
  if (abs >= 1) return price.toFixed(4);
  if (abs >= 0.01) return price.toFixed(4);
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
      // FIX-2026-07-22: TradingView-like timeline
      rightOffset: 12,
      shiftVisibleRangeOnNewBar: true,
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: false },
    },
    crosshair: {
      vertLine: { color: 'rgba(245,184,0,0.4)', width: 1, style: 3, labelBackgroundColor: '#f5b800' },
      horzLine: { color: 'rgba(245,184,0,0.4)', width: 1, style: 3, labelBackgroundColor: '#f5b800' },
    },
    // FIX-2026-07-22: adaptive decimal places on price axis (เหรียญราคาต่ำเห็นรายละเอียดชัด)
    localization: {
      priceFormatter: chartPriceFormatter,
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
  // EMA (Keltner basis) — gold
  basisSeries = priceChart.addLineSeries({
    color: '#f5b800',
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  // Upper Keltner Channel — orange
  upperSeries = priceChart.addLineSeries({
    color: '#ff7849',
    lineWidth: 1,
    lineStyle: 2, // dashed
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  // Lower Keltner Channel — violet
  lowerSeries = priceChart.addLineSeries({
    color: '#a78bfa',
    lineWidth: 1,
    lineStyle: 2, // dashed
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

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

// ─── Bar countdown (TradingView-style — เวลาที่เหลือก่อนแท่งปัจจุบันปิด) ──
let _countdownTimer = null;

function tfToMs(tf) {
  // รองรับ "1m" "3m" "15m" "1h" "4h" "1d" → milliseconds
  const m = String(tf || '').match(/^(\d+)([mhd])$/);
  if (!m) return 60_000;
  const n = parseInt(m[1], 10);
  if (m[2] === 'm') return n * 60_000;
  if (m[2] === 'h') return n * 3_600_000;
  return n * 86_400_000;
}

function startBarCountdown() {
  stopBarCountdown();
  const wrap = document.getElementById('bar-countdown');
  const fill = document.getElementById('bar-countdown-fill');
  const text = document.getElementById('bar-countdown-text');
  if (!wrap || !fill || !text) return;
  if (!detail || !detail.bot || !_chartKlines.length) return;

  wrap.hidden = false;
  const tf = detail.bot.timeframe;
  const durationMs = tfToMs(tf);

  const update = () => {
    const last = _chartKlines[_chartKlines.length - 1];
    if (!last || !last.openTime) return;
    const closeTime = last.openTime + durationMs;
    const remainingMs = Math.max(0, closeTime - Date.now());
    const elapsedMs = durationMs - remainingMs;
    const progress = Math.max(0, Math.min(1, elapsedMs / durationMs));

    fill.style.width = `${(progress * 100).toFixed(2)}%`;
    const remSec = Math.ceil(remainingMs / 1000);
    const mm = Math.floor(remSec / 60);
    const ss = remSec % 60;
    text.textContent = `⏱ เหลือ ${mm}:${String(ss).padStart(2, '0')} · ${tf}`;

    // เมื่อแท่งปิด → รอให้แท่งใหม่เข้ามาแล้วนับต่อ
    if (remainingMs <= 0) {
      stopBarCountdown();
      setTimeout(() => { renderPriceChart().then(startBarCountdown); }, 1500);
    }
  };

  update();
  _countdownTimer = setInterval(update, 1000);
}

function stopBarCountdown() {
  if (_countdownTimer) {
    clearInterval(_countdownTimer);
    _countdownTimer = null;
  }
}

// ─── Price chart state ──────────────────────────────────────────────
let _chartKlines = [];              // current visible klines (raw, with openTime ms)
let _chartBasis = [];               // parallel to _chartKlines, values or null
let _chartUpper = [];
let _chartLower = [];
let _chartSignals = [];             // parallel S1 markers array, length <= _chartKlines.length
// Track earliest openTime (ms) so "Load older" knows where to query from
let _chartEarliestOpenTime = null;

async function renderPriceChart() {
  if (!priceChart || !detail || !detail.bot) return;
  const { symbol, timeframe } = detail.bot;
  const loading = document.getElementById('price-chart-loading');
  try {
    // FIX-2026-07-24: pass per-bot kcMult + s1OnlyDown (default 1.5, false)
    const kcMult = detail.bot.kcMult ?? 1.5;
    const s1OnlyDown = detail.bot.s1OnlyDown ? 'true' : 'false';
    const resp = await API.get(`/api/chart/klines?symbol=${symbol}&timeframe=${timeframe}&limit=150&kcMult=${kcMult}&s1OnlyDown=${s1OnlyDown}`);
    if (!resp.klines || resp.klines.length === 0) {
      if (loading) loading.textContent = 'ไม่มีข้อมูลแท่งเทียน';
      return;
    }
    _chartKlines = resp.klines;
    // เก็บ keltner เป็น array parallel กับ klines (index i คือ i-th candle) — เพื่อ prepend ได้ง่าย
    _chartBasis = (resp.keltner && resp.keltner.basis) || [];
    _chartUpper = (resp.keltner && resp.keltner.upper) || [];
    _chartLower = (resp.keltner && resp.keltner.lower) || [];
    _chartSignals = resp.signals || [];
    _chartEarliestOpenTime = _chartKlines[0].openTime;
    _drawPriceChart({ fit: true });
    // FIX-2026-07-22: เริ่มนับถอยหลังของแท่งปัจจุบัน (TradingView-style)
    startBarCountdown();
    // Initial: assume older data exists, enable button
    const btn = document.getElementById('btn-load-older');
    if (btn) {
      btn.disabled = false;
      btn.dataset.loading = '0';
    }
    if (loading) loading.style.display = 'none';
  } catch (err) {
    console.error('renderPriceChart', err);
    if (loading) loading.textContent = `❌ ${err.message}`;
  }
}

/**
 * Render current _chartKlines (and parallel keltner arrays) to the chart series.
 * @param {{fit?: boolean}} opts — if fit=true, fitContent after re-render (only on first load)
 */
function _drawPriceChart({ fit = false } = {}) {
  if (!priceChart) return;
  const candleData = _chartKlines.map((k) => ({
    time: Math.floor(k.openTime / 1000),
    open: parseFloat(k.open),
    high: parseFloat(k.high),
    low: parseFloat(k.low),
    close: parseFloat(k.close),
  }));
  lastKline = candleData[candleData.length - 1];
  // seed currentPrice for Positions tab
  const lastPx = parseFloat(lastKline && lastKline.close);
  if (!isNaN(lastPx) && lastPx > 0) currentPrice = lastPx;

  // สร้าง series data จาก parallel arrays (length = _chartKlines.length)
  const basis = [];
  const upper = [];
  const lower = [];
  for (let i = 0; i < _chartKlines.length; i += 1) {
    const t = Math.floor(_chartKlines[i].openTime / 1000);
    if (_chartBasis[i] != null) basis.push({ time: t, value: _chartBasis[i] });
    if (_chartUpper[i] != null) upper.push({ time: t, value: _chartUpper[i] });
    if (_chartLower[i] != null) lower.push({ time: t, value: _chartLower[i] });
  }

  candleSeries.setData(candleData);
  basisSeries.setData(basis);
  upperSeries.setData(upper);
  lowerSeries.setData(lower);

  // signal markers (S1)
  const sigMarkers = (_chartSignals || []).map((s) => ({
    time: Math.floor(s.openTime / 1000),
    position: 'belowBar',
    color: '#3b82f6',
    shape: 'arrowUp',
    text: 'S1',
  }));

  // overlays: historical BUY/SELL markers from detail.trades
  const overlayMarkers = [];
  const firstCandleT = candleData[0].time;
  const lastCandleT = candleData[candleData.length - 1].time;
  const findCandleIdx = (epochSec) => {
    if (epochSec < firstCandleT || epochSec > lastCandleT) return -1;
    return candleData.findIndex((c) => c.time >= epochSec);
  };

  for (const t of detail.trades || []) {
    const buyAt = t.buyFilledAt || t.buyPlacedAt;
    if (buyAt) {
      const buyT = Math.floor(new Date(buyAt).getTime() / 1000);
      const idx = findCandleIdx(buyT);
      if (idx >= 0) {
        overlayMarkers.push({
          time: candleData[idx].time,
          position: 'inBar',
          color: '#f5b800',                 // gold — แยกจาก S1 (blue) และ SELL-win (green)
          shape: 'arrowUp',
          text: t.buyPrice != null ? `B ${t.buyPrice.toFixed(4)}` : 'B',
        });
      }
    }

    if (t.realizedPnl != null) {
      const sellAt = t.sellFilledAt || t.sellPlacedAt;
      if (sellAt) {
        const sellT = Math.floor(new Date(sellAt).getTime() / 1000);
        const idx = findCandleIdx(sellT);
        if (idx >= 0) {
          const win = t.realizedPnl >= 0;
          overlayMarkers.push({
            time: candleData[idx].time,
            position: 'aboveBar',
            color: win ? '#00e5b8' : '#ff4d6d',
            shape: 'arrowDown',             // ลูกศรลง = "ออกจาก position"
            text: `S ${win ? '+' : ''}${t.realizedPnl.toFixed(2)}`,
          });
        }
      }
    }
  }
  candleSeries.setMarkers([...sigMarkers, ...overlayMarkers]);

  // Update header counter
  const cnt = document.getElementById('chart-candles-count');
  if (cnt) cnt.textContent = candleData.length.toLocaleString();

  if (fit) priceChart.timeScale().fitContent();
}

/**
 * Fetch 300 older candles, prepend to existing data, re-render.
 * Preserves user's current visible time range.
 */
async function loadOlderCandles() {
  if (!priceChart || !detail || !detail.bot) return;
  const { symbol, timeframe } = detail.bot;
  const btn = document.getElementById('btn-load-older');
  if (!btn || btn.disabled || btn.dataset.loading === '1') return;
  if (_chartEarliestOpenTime == null) return;

  btn.dataset.loading = '1';
  const originalLabel = btn.innerHTML;
  btn.innerHTML = '⏳ กำลังโหลด…';
  btn.disabled = true;

  // Capture visible range BEFORE prepend so we can restore it after
  let savedRange = null;
  try {
    savedRange = priceChart.timeScale().getVisibleLogicalRange();
  } catch (e) { /* chart may not be ready */ }

  try {
    // ขอแท่งที่เก่ากว่า open time ของ candle แรก
    const kcMult = detail.bot.kcMult ?? 1.5;
    const s1OnlyDown = detail.bot.s1OnlyDown ? 'true' : 'false';
    const resp = await API.get(
      `/api/chart/klines?symbol=${symbol}&timeframe=${timeframe}&limit=300&kcMult=${kcMult}&s1OnlyDown=${s1OnlyDown}&endTime=${_chartEarliestOpenTime}`
    );
    if (!resp.klines || resp.klines.length === 0) {
      btn.innerHTML = '🚫 หมดประวัติแล้ว';
      btn.disabled = true;
      return;
    }

    // Deduplicate by openTime (Binance sometimes returns overlap if endTime exactly equals an openTime)
    const existingTs = new Set(_chartKlines.map((k) => k.openTime));
    const olderOnly = resp.klines.filter((k) => !existingTs.has(k.openTime));

    if (olderOnly.length === 0) {
      btn.innerHTML = '🚫 หมดประวัติแล้ว';
      btn.disabled = true;
      return;
    }

    // ──── Align keltner/signals to the response's klines (parallel arrays) ────
    // resp.keltner.basis/upper/lower are parallel to resp.klines ตามลำดับ
    // เราจะ slice ส่วนที่ตรงกับ olderOnly แล้ว prepend
    const respKlines = resp.klines;
    const basisArr = (resp.keltner && resp.keltner.basis) || [];
    const upperArr = (resp.keltner && resp.keltner.upper) || [];
    const lowerArr = (resp.keltner && resp.keltner.lower) || [];
    const sigArr = resp.signals || [];

    // Map: openTime → index in respKlines เพื่อ slice keltner ตามด้วย
    const respIdxByOpenTime = new Map(respKlines.map((k, i) => [k.openTime, i]));

    const olderBasis = [];
    const olderUpper = [];
    const olderLower = [];
    for (const k of olderOnly) {
      const idx = respIdxByOpenTime.get(k.openTime);
      if (idx != null) {
        olderBasis[idx] != null ? olderBasis.push(basisArr[idx]) : olderBasis.push(null);
        olderUpper[idx] != null ? olderUpper.push(upperArr[idx]) : olderUpper.push(null);
        olderLower[idx] != null ? olderLower.push(lowerArr[idx]) : olderLower.push(null);
      } else {
        olderBasis.push(null);
        olderUpper.push(null);
        olderLower.push(null);
      }
    }
    // S1 signals: filter เฉพาะที่อยู่ใน olderOnly slice
    const olderTsSet = new Set(olderOnly.map((k) => k.openTime));
    const olderSignals = sigArr.filter((s) => olderTsSet.has(s.openTime));

    // Prepend (olderOnly + olderBasis/Upper/Lower/Signals + existing arrays)
    _chartKlines = olderOnly.concat(_chartKlines);
    _chartBasis = olderBasis.concat(_chartBasis);
    _chartUpper = olderUpper.concat(_chartUpper);
    _chartLower = olderLower.concat(_chartLower);
    _chartSignals = olderSignals.concat(_chartSignals);
    _chartEarliestOpenTime = _chartKlines[0].openTime;

    _drawPriceChart({ fit: false });

    // FIX-2026-07-22: รีสตาร์ท countdown หลัง load older (openTime ของแท่งสุดท้ายอาจเปลี่ยน)
    startBarCountdown();

    // Restore visible range — shift by number of candles added so user's view stays put
    if (savedRange) {
      const added = olderOnly.length;
      try {
        priceChart.timeScale().setVisibleLogicalRange({
          from: savedRange.from + added,
          to: savedRange.to + added,
        });
      } catch (e) { /* ignore — chart may auto-fit if range invalid */ }
    }

    // Disable button if Binance returned fewer than 300 (end of available history)
    if (resp.klines.length < 300) {
      btn.innerHTML = '🚫 หมดประวัติแล้ว';
      btn.disabled = true;
    } else {
      btn.innerHTML = originalLabel;
      btn.disabled = false;
    }
  } catch (err) {
    console.error('loadOlderCandles', err);
    btn.innerHTML = `❌ ${err.message}`.slice(0, 60);
    btn.disabled = false;
  } finally {
    btn.dataset.loading = '0';
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
// ─── Timezone helpers (force Asia/Bangkok +07:00) ──────
const TZ = 'Asia/Bangkok';
const _dttmFmt = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const _dtFmt    = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const _tmFmt    = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function fmtDateTime(d) { return d ? _dttmFmt.format(new Date(d)) : '-'; }
function fmtDate(d)     { return d ? _dtFmt.format(new Date(d))    : '-'; }
function fmtTime(d)     { return d ? _tmFmt.format(new Date(d))    : '-'; }
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function formatUptime(sec) {
  if (!sec && sec !== 0) return '-';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}
// FIX-2026-07-24: format retry time — รองรับทศนิยม เช่น 0.5 → "30s", 1 → "1m", 1.5 → "1m 30s"
function formatRetryTime(min) {
  const m = Number(min);
  if (!Number.isFinite(m)) return String(min);
  if (m < 1) return `${Math.round(m * 60)}s`;
  const wholeMin = Math.floor(m);
  const secs = Math.round((m - wholeMin) * 60);
  if (secs === 0) return `${wholeMin}m`;
  if (secs === 60) return `${wholeMin + 1}m`;
  return `${wholeMin}m ${secs}s`;
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();