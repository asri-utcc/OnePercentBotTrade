'use strict';

/**
 * Chart Monitor — grid of mini-charts for all running bots.
 *   - Page: /chart-monitor.html
 *   - Data: GET /api/bots (full list) + GET /api/bots/:id/mini-chart (per-bot chart)
 *          + GET /api/bots/positions (cross-bot open positions snapshot)
 *   - Live updates: WS 'kline:update' (current candle) + 'trade:update' (markers)
 *   - Heartbeat: /api/health (same poll as bots.html)
 *   - Marker refresh: every 120s (fallback if WS misses)
 *
 * Layout: responsive grid (1 col mobile / 2 cols tablet / 3 cols desktop / 4 cols wide)
 * Each card: header (name + symbol + TF + status) → KPI row (price / positions / today PnL) → mini-chart
 *
 * 2026-08-06 additions:
 *   - Open Positions panel above chart grid (re-uses shared PositionCard.renderCard)
 *     - click a card → opens #cmPositionModal with detailed view + actions
 *   - TP sell price line drawn on each mini-chart for bots with active positions
 */

const _cmMiniCharts = new Map(); // botId -> { chart, candleSeries, basisSeries, upperSeries, lowerSeries, klines, symbol, timeframe, el, tpPriceLines: [...] }
const _cmRefreshTimers = new Map(); // botId -> setInterval handle
const _cmLazyObserver = (typeof IntersectionObserver !== 'undefined') ? new IntersectionObserver(onCmLazyLoad, { rootMargin: '200px' }) : null;
const _cmLazyPending = new Set(); // botIds pending lazy load

let _cmBots = []; // full bot list (cache)
let _cmSignals = null; // latest signals response (from /api/bots/chart-monitor/signals)
let _cmSignalMapByBot = new Map(); // botId -> per-bot summary (for highlight + prediction)
let _cmPositions = null; // latest open positions snapshot (from /api/bots/positions)
let _cmPositionsAsOf = null;
let _cmPositionsByBot = new Map(); // botId -> positions[] (for TP line drawing)
let _cmFilter = 'running-with-position'; // 'running' | 'stopped' | 'all' | 'running-with-position' (default: 2026-08-06)
let _cmSort = 'default'; // 'default' | 'name' | 'symbol' | 'pnl' | 'tf'
let _cmPositionModal = null; // bootstrap.Modal instance for #cmPositionModal

async function init() {
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me || !me.authenticated) {
    location.href = '/login.html';
    return;
  }

  // Load price format helpers (used in KPI labels)
  if (window.PriceFormat) await window.PriceFormat.load();

  // Filter + sort handlers
  document.getElementById('cm-filter-status').addEventListener('change', (e) => {
    _cmFilter = e.target.value;
    renderGrid();
  });
  document.getElementById('cm-sort').addEventListener('change', (e) => {
    _cmSort = e.target.value;
    renderGrid();
  });
  document.getElementById('cm-refresh-btn').addEventListener('click', () => {
    loadBots().catch((err) => console.warn('chart-monitor refresh:', err));
  });

  // Positions refresh button (uses fresh=1 → Binance bookTicker)
  const preBtn = document.getElementById('cm-positions-refresh');
  if (preBtn) preBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't trigger collapse toggle
    loadCmPositions({ fresh: true }).catch((e2) => console.warn('chart-monitor positions refresh:', e2.message));
  });

  // Positions card collapse/expand (2026-08-06) — default collapsed, state persisted in localStorage
  initCmPositionsCollapse();

  // Today PnL tile click → open today's pnl modal (2026-08-06)
  const pnlTile = document.getElementById('cm-stat-pnl-tile');
  if (pnlTile) pnlTile.addEventListener('click', () => openTodayPnlModal().catch((e) => console.warn('chart-monitor pnl modal:', e.message)));

  // Click handler for position cards (delegated on the grid)
  const posList = document.getElementById('cm-positions-list');
  if (posList) posList.addEventListener('click', onCmPositionCardClick);

  // Bootstrap modal instance for position detail
  const modalEl = document.getElementById('cmPositionModal');
  if (modalEl && window.bootstrap) {
    _cmPositionModal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
  }

  // Start WS for live candle updates
  WSClient.start();

  // First load
  await loadBots();
  await loadSignals();
  await loadCmPositions();
  await loadHealth();
  // 2026-08-06: BNB fuel gauge (mirror bots.html)
  loadCmBnbStatus().catch(() => {});

  // Heartbeat polling
  setInterval(() => { loadHealth().catch(() => {}); }, 15_000);

  // Signals refresh — 60s (server cache is 30s)
  setInterval(() => { loadSignals().catch((e) => console.debug('chart-monitor signals refresh:', e.message)); }, 60_000);

  // 2026-08-06: BNB gauge poll — 60s (server cache 30s, balance changes slowly)
  setInterval(() => { loadCmBnbStatus().catch(() => {}); }, 60_000);

  // Positions refresh — 30s (cache uses klineCache; user-triggered fresh mode uses Binance bookTicker)
  setInterval(() => { loadCmPositions().catch((e) => console.debug('chart-monitor positions refresh:', e.message)); }, 30_000);

  // Bind WS live updates
  bindCmWs();

  // Beforeunload cleanup
  window.addEventListener('beforeunload', teardownCmCharts);
}

/* ════════════════════════════════════════════════════════════════════
 * Data loading
 * ════════════════════════════════════════════════════════════════════ */

async function loadBots() {
  try {
    // FIX-2026-08-02: ?expand=1 → include volatility, quality, trendline (full bot card snapshot)
    const resp = await API.get('/api/bots?expand=1');
    _cmBots = resp.bots || [];
    renderSummary();
    renderGrid();
  } catch (err) {
    console.error('chart-monitor /api/bots failed:', err);
    document.getElementById('cm-grid').innerHTML = `
      <div class="lux-card">
        <div class="lux-body">
          <div class="alert alert-danger mb-0">⚠️ โหลดข้อมูลบอทไม่สำเร็จ: ${err.message}</div>
        </div>
      </div>`;
  }
}

async function loadHealth() {
  try {
    const status = await API.get('/api/health');
    renderHeartbeat(status);
  } catch (err) {
    // silently ignore — heartbeat is best-effort
  }
}

/* ════════════════════════════════════════════════════════════════════
 * BNB fuel gauge (2026-08-06) — mirror bots.html `loadBnbStatus`
 *   - GET /api/account/bnb-status returns:
 *       { bnbQty, bnbUsdtPrice, bnbValueUsdt, isLow, threshold,
 *         gaugeTargetUsdt, gaugePct, gaugeZone (healthy|low|critical) }
 *   - Updates:
 *       #cm-bnb-gauge-status  → emoji + label + pct
 *       #cm-bnb-gauge-value   → "X.XX / Y.YY USDT"
 *       #cm-bnb-gauge-fill    → width + zone class
 *       #cm-bnb-low-banner    → shown when isLow=true
 *   - Fail-open: hide banner + reset gauge to 0% on error
 * ════════════════════════════════════════════════════════════════════ */
async function loadCmBnbStatus() {
  const banner = document.getElementById('cm-bnb-low-banner');
  const detail = document.getElementById('cm-bnb-low-detail');
  if (!banner || !detail) return; // elements not rendered (wrong page)
  try {
    const resp = await API.get('/api/account/bnb-status');

    // (1) low-balance banner
    if (resp && resp.isLow) {
      const qty = resp.bnbQty != null ? Number(resp.bnbQty).toFixed(4) : '?';
      const price = resp.bnbUsdtPrice != null ? Number(resp.bnbUsdtPrice).toFixed(2) : '?';
      const value = resp.bnbValueUsdt != null ? Number(resp.bnbValueUsdt).toFixed(4) : '?';
      detail.textContent = `${qty} BNB × ${price} USDT = ${value} USDT (ต่ำกว่า $${resp.threshold})`;
      banner.hidden = false;
      banner.style.display = 'flex';
    } else {
      banner.hidden = true;
      banner.style.display = 'none';
    }

    // (2) oil gauge — zone color + width + value label
    const statusEl = document.getElementById('cm-bnb-gauge-status');
    const valueEl  = document.getElementById('cm-bnb-gauge-value');
    const fillEl   = document.getElementById('cm-bnb-gauge-fill');
    if (statusEl && valueEl && fillEl) {
      const pct = Number(resp.gaugePct) || 0;
      const zone = resp.gaugeZone || 'low';
      const target = Number(resp.gaugeTargetUsdt) || 10;
      const value = Number(resp.bnbValueUsdt) || 0;
      const emoji = zone === 'healthy' ? '🟢' : zone === 'low' ? '🟡' : '🔴';
      const label = zone === 'healthy' ? 'Healthy' : zone === 'low' ? 'Low' : 'Critical';
      statusEl.textContent = `${emoji} ${label} (${pct.toFixed(0)}%)`;
      statusEl.className = zone === 'healthy' ? 'text-success'
                         : zone === 'critical' ? 'text-danger'
                         : 'text-warning';
      valueEl.textContent = `${value.toFixed(2)} / ${target.toFixed(2)} USDT`;
      fillEl.style.width = `${pct}%`;
      fillEl.className = `bnb-gauge-fill is-${zone}`;
    }
  } catch (err) {
    // fail-open: hide banner, reset gauge
    banner.hidden = true;
    banner.style.display = 'none';
    const fillEl = document.getElementById('cm-bnb-gauge-fill');
    if (fillEl) { fillEl.style.width = '0%'; fillEl.className = 'bnb-gauge-fill'; }
  }
}

async function loadSignals() {
  try {
    const resp = await API.get('/api/bots/chart-monitor/signals');
    _cmSignals = resp;
    _cmSignalMapByBot = new Map((resp.bots || []).map((b) => [String(b.botId), b]));
    renderLatestSignalsPanel();
    // Re-render cards so highlight/prediction/blocked badges refresh
    renderGrid();
  } catch (err) {
    console.warn('chart-monitor /api/bots/chart-monitor/signals failed:', err);
    renderLatestSignalsPanel();
  }
}

/* ════════════════════════════════════════════════════════════════════
 * Open Positions — reuse /api/bots/positions (same source as bots.html modal)
 *   - default: klineCache snapshot (fast)
 *   - explicit refresh (user clicks 🔄): ?fresh=1 (Binance bookTicker)
 * ════════════════════════════════════════════════════════════════════ */

async function loadCmPositions(opts = {}) {
  const url = opts.fresh ? '/api/bots/positions?fresh=1' : '/api/bots/positions';
  const btn = document.getElementById('cm-positions-refresh');
  let prevLabel = null;
  if (opts.fresh && btn) {
    prevLabel = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.innerHTML = '⏳ กำลังโหลด…';
  }
  try {
    const resp = await API.get(url);
    _cmPositions = resp;
    _cmPositionsAsOf = resp.asOf;
    // Build per-bot position index for TP line drawing
    _cmPositionsByBot = new Map();
    for (const p of (resp.positions || [])) {
      const key = String(p.botId || '');
      if (!key) continue;
      if (!_cmPositionsByBot.has(key)) _cmPositionsByBot.set(key, []);
      _cmPositionsByBot.get(key).push(p);
    }
    renderCmPositionsPanel();
    // Re-draw TP lines on charts that have already loaded
    redrawAllCmTpLines();
  } catch (err) {
    console.warn('chart-monitor /api/bots/positions failed:', err);
    renderCmPositionsPanel();
  } finally {
    if (opts.fresh && btn) {
      btn.disabled = false;
      btn.classList.remove('is-loading');
      if (prevLabel != null) btn.innerHTML = prevLabel;
    }
  }
}

function getCmLivePriceForPosition(p) {
  if (p.currentPrice && p.currentPrice > 0) return p.currentPrice;
  return Number(p.buyPrice) || 0;
}

function renderCmPositionsPanel() {
  const listEl = document.getElementById('cm-positions-list');
  const countEl = document.getElementById('cm-positions-count');
  const subEl = document.getElementById('cm-positions-sub');
  if (!listEl) return;
  const positions = (_cmPositions && _cmPositions.positions) || [];
  if (countEl) countEl.textContent = positions.length;

  const fmt2 = (d) => new Date(d || Date.now()).toLocaleTimeString('th-TH', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });

  if (subEl) {
    const source = _cmPositions && _cmPositions.fresh
      ? '<span class="cm-positions-source is-binance" title="ราคาจาก Binance bookTicker">🟢 Binance</span>'
      : '<span class="cm-positions-source is-cache" title="ราคาจาก klineCache (อาจเก่า กด Refresh)">⚪ cache</span>';
    const failed = (_cmPositions && _cmPositions.freshFailedSymbols) || [];
    const failedNote = failed.length > 0
      ? ` · <span class="text-warning" title="${escapeHtml(failed.join(','))}">⚠️ ${failed.length} sym fallback</span>`
      : '';
    subEl.innerHTML = `${positions.length} ไม้ · อัปเดต ${fmt2(_cmPositionsAsOf)} · ${source}${failedNote}`;
  }

  if (positions.length === 0) {
    listEl.innerHTML = '<div class="cm-positions-empty">ไม่มี position ที่เปิดอยู่ — เมื่อบอท BUY fill จะปรากฏที่นี่ (คลิกเพื่อดู modal)</div>';
    return;
  }

  const opts = {
    botLink: true,
    showRetry: true,
    forceCloseBtnClass: 'btn-force-close-cm',
    chartBtnClass: 'btn-chart-link-cm',
  };
  listEl.innerHTML = positions
    .map((p) => window.PositionCard.renderCard(
      { ...p, _id: p.tradeId },
      getCmLivePriceForPosition(p),
      { ...opts, botName: p.botName || p.symbol },
    ))
    .join('');
}

/* ════════════════════════════════════════════════════════════════════
 * Click handler for position cards on chart-monitor
 *   - clicking a card (not the inner buttons) → opens detail modal
 *   - clicking Force Close button → confirm + API call (same as bots.html)
 * ════════════════════════════════════════════════════════════════════ */

async function onCmPositionCardClick(ev) {
  // Force Close button
  const fcBtn = ev.target.closest('.btn-force-close-cm');
  if (fcBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    const tradeId = fcBtn.dataset.tradeId;
    const botId = fcBtn.dataset.botId;
    if (!tradeId || !botId) return;
    const pos = _cmPositions && _cmPositions.positions.find((p) => p.tradeId === tradeId);
    if (!pos) return;
    try {
      const pw = await window.LUX_CONFIRM.luxConfirm({
        variant: 'danger',
        icon: '🛑',
        title: 'ยืนยันบังคับปิด position',
        sub: 'จะยกเลิก SELL (ถ้ามี) แล้ว MARKET SELL freeQty (หรือ synthetic close ถ้า asset หายไปแล้ว)',
        message: `ไม้ ${tradeId.slice(-8)} (${pos.symbol}, ${pos.timeframe}, state=${pos.state}) — ปิดเลยหรือไม่?`,
        target: { name: pos.botName || pos.symbol, symbol: pos.symbol, timeframe: pos.timeframe },
        requirePassword: true,
        dangerNote: 'บอทยังคงทำงานต่อ — เฉพาะไม้นี้ที่ถูกปิด',
        confirmLabel: 'บังคับปิดไม้นี้',
        confirmGlyph: '🛑',
      });
      if (pw === null) return;
      await window.LUX_CONFIRM.callBotWithPassword(
        'POST',
        `/api/bots/${botId}/trades/${tradeId}/force-close`,
        { password: pw || undefined },
        `force-close ${pos.symbol}`,
      );
      await loadCmPositions();
    } catch (err) {
      await window.LUX_CONFIRM.luxAlert({
        variant: 'danger', icon: '⚠️', title: 'บังคับปิดไม่สำเร็จ',
        message: err.message || String(err),
      });
    }
    return;
  }

  // Chart button (don't open modal — let the link do its thing)
  if (ev.target.closest('.btn-chart-link-cm')) return;

  // Otherwise: open detail modal with the same card
  const card = ev.target.closest('.position-card');
  if (!card) return;
  const tradeId = card.dataset.tradeId;
  if (!tradeId) return;
  const pos = _cmPositions && _cmPositions.positions.find((p) => p.tradeId === tradeId);
  if (!pos) return;
  openCmPositionModal(pos);
}

function openCmPositionModal(pos) {
  const titleEl = document.getElementById('cmPositionModalTitle');
  const subEl = document.getElementById('cmPositionModalSub');
  const bodyEl = document.getElementById('cmPositionModalBody');
  if (!bodyEl) return;
  const px = getCmLivePriceForPosition(pos);
  if (titleEl) titleEl.textContent = `${pos.symbol} · ${pos.timeframe}`;
  if (subEl) {
    const pnlSign = pos.buyPrice && px ? (px >= pos.buyPrice ? '+' : '') : '';
    const pnlPct = pos.buyPrice && px ? ((px - pos.buyPrice) / pos.buyPrice * 100) : 0;
    subEl.textContent = `ไม้ ${String(pos.tradeId || '').slice(-8)} · state=${pos.state} · ${pnlSign}${pnlPct.toFixed(3)}% unrealized`;
  }
  bodyEl.innerHTML = window.PositionCard.renderCard(
    { ...pos, _id: pos.tradeId },
    px,
    {
      botLink: true,
      showRetry: true,
      forceCloseBtnClass: 'btn-force-close-cm-modal',
      chartBtnClass: 'btn-chart-link-cm-modal',
    },
  );
  if (_cmPositionModal) _cmPositionModal.show();
}

/* ════════════════════════════════════════════════════════════════════
 * Summary tiles
 * ════════════════════════════════════════════════════════════════════ */

function renderSummary() {
  const running = _cmBots.filter((b) => !!b.enabled);
  const stopped = _cmBots.filter((b) => !b.enabled);
  // 2026-08-06: Today PnL = ALL bots (mirror bots.html) — not running-only
  //   prior behavior: running.reduce(...) produced a different number than bots.html "Today PnL" tile
  //   because stopped bots' todayPnl was excluded. User flagged the discrepancy.
  const todayPnl = _cmBots.reduce((sum, b) => sum + (b.todayPnl || 0), 0);
  const todayTrades = _cmBots.reduce((s, b) => s + (b.todayTrades || 0), 0);
  const up = running.filter((b) => b.emaState === 'above').length;
  const down = running.filter((b) => b.emaState === 'below').length;

  setText('cm-stat-running', running.length);
  setText('cm-stat-running-sub', `จาก ${_cmBots.length} บอททั้งหมด`);
  setText('cm-stat-stopped', stopped.length);

  // Today PnL — 4-decimal precision (mirror bots.html) + THB sub-line via window.usdtToThb
  const pnlEl = document.getElementById('cm-stat-pnl');
  if (pnlEl) {
    const pnlClass = todayPnl > 0 ? 'pnl-bull' : todayPnl < 0 ? 'pnl-bear' : '';
    pnlEl.className = 'value ' + pnlClass;
    const todayThb = window.usdtToThb ? window.usdtToThb(todayPnl) : '';
    pnlEl.innerHTML = `${todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(4)}${todayThb ? `<span class="thb-eq">${todayThb}</span>` : ''}`;
  }
  setText('cm-stat-pnl-sub', `${todayTrades} ไม้ · วันนี้`);

  setText('cm-stat-up', up);
  setText('cm-stat-down', down);

  // Color the PnL tile
  const pnlTile = document.getElementById('cm-stat-pnl-tile');
  if (pnlTile) {
    pnlTile.classList.remove('is-bull', 'is-bear', 'is-gold');
    if (todayPnl > 0) pnlTile.classList.add('is-bull');
    else if (todayPnl < 0) pnlTile.classList.add('is-bear');
    else pnlTile.classList.add('is-gold');
  }
  // Strong down tile color
  const downTile = document.getElementById('cm-stat-down-tile');
  if (downTile) {
    downTile.classList.remove('is-bear', 'is-violet');
    downTile.classList.add('is-bear');
  }

  // heartbeat bot count
  setText('hb-bots-count', running.length);
}

/* ════════════════════════════════════════════════════════════════════
 * Open Positions card — collapse/expand (2026-08-06)
 *   - default state: collapsed (per UX request)
 *   - state persisted in localStorage so user choice sticks across reloads
 *   - click anywhere on header row toggles; refresh button uses stopPropagation
 * ════════════════════════════════════════════════════════════════════ */
const CM_POS_COLLAPSE_KEY = 'cm.positions.collapsed.v1';
function initCmPositionsCollapse() {
  const card = document.getElementById('cm-positions-card');
  const header = document.getElementById('cm-positions-header');
  if (!card || !header) return;
  // Default: collapsed (UX request). Read user override if any.
  let collapsed = true;
  try {
    const stored = localStorage.getItem(CM_POS_COLLAPSE_KEY);
    if (stored === '0' || stored === '1') collapsed = stored === '1';
  } catch (_) { /* localStorage unavailable */ }
  const apply = () => {
    card.classList.toggle('is-collapsed', collapsed);
  };
  apply();
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    apply();
    try { localStorage.setItem(CM_POS_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (_) {}
  });
}

/* ════════════════════════════════════════════════════════════════════
 * Today PnL modal (2026-08-06)
 *   - click on Today PnL tile → open modal showing today's trades
 *   - SAME UX/content as clicking a day cell in pnl.html (openDayModal)
 *   - uses /api/pnl/day?from=today&to=today endpoint
 *   - reuses .pnl-modal-* CSS classes from app.css (no new CSS needed)
 *   - fx rate from window.__fx (set by nav.js on Binance bookTicker poll)
 * ════════════════════════════════════════════════════════════════════ */
let _cmPnlModalOverlay = null;

function formatUsdtPnl(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(4)}`;
}

function formatThbInlinePnl(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1000000) return `${sign}${(abs / 1000000).toFixed(2)}M`;
  if (abs >= 10000)   return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${abs.toFixed(0)}`;
}

function todayDateStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function openTodayPnlModal() {
  if (!_cmPnlModalOverlay) buildCmPnlModalSkeleton();
  const overlay = _cmPnlModalOverlay;
  const body = overlay.querySelector('#cm-pnl-modal-body');
  const titleEl = overlay.querySelector('#cm-pnl-modal-title');
  const totalEl = overlay.querySelector('#cm-pnl-modal-total');

  const today = todayDateStr();
  titleEl.textContent = `📊 ${today} · Today`;
  body.innerHTML = '<div class="text-center py-4 text-muted-3">กำลังโหลด…</div>';
  totalEl.innerHTML = '<div class="text-muted-3">กำลังโหลด…</div>';
  overlay.classList.add('is-open');

  try {
    const data = await API.get(`/api/pnl/day?from=${today}&to=${today}`);
    const totals = data.totals || { pnl: 0, grossProfit: 0, grossLoss: 0, wins: 0, losses: 0 };
    const fxRate = (window.__fx && window.__fx.rate) ? window.__fx.rate : null;
    const total = totals.pnl || 0;
    const grossProfit = totals.grossProfit || 0;
    const grossLoss = totals.grossLoss || 0;
    const thb = fxRate != null ? (total * fxRate) : null;
    const grossProfitThb = fxRate != null ? (grossProfit * fxRate) : null;
    const grossLossThb = fxRate != null ? (grossLoss * fxRate) : null;
    const totalSignCls = total > 0 ? 'is-bull' : (total < 0 ? 'is-bear' : '');

    totalEl.innerHTML = `
      <div class="pnl-modal-summary-row">
        <span class="pnl-modal-main-pnl ${totalSignCls}">${formatUsdtPnl(total)} <span class="unit">USDT</span></span>
        ${thb != null ? `<span class="pnl-modal-thb ${totalSignCls}">≈ ${thb >= 0 ? '+' : ''}฿${formatThbInlinePnl(thb)}</span>` : '<span class="muted">FX ไม่พร้อม</span>'}
      </div>
      <div class="pnl-modal-gl-row">
        <span class="gl-pill is-bull" title="ผลรวมไม้ที่กำไร — ${totals.wins} ไม้">
          <span class="gl-label">กำไร</span>
          +${grossProfit.toFixed(4)} USDT
          ${grossProfitThb != null ? `<span class="gl-thb">≈ +฿${formatThbInlinePnl(grossProfitThb)}</span>` : ''}
          <span class="gl-count">(${totals.wins}W)</span>
        </span>
        <span class="gl-pill is-bear" title="ผลรวมไม้ที่ขาดทุน — ${totals.losses} ไม้">
          <span class="gl-label">ขาดทุน</span>
          ${grossLoss.toFixed(4)} USDT
          ${grossLossThb != null ? `<span class="gl-thb">≈ ฿${formatThbInlinePnl(Math.abs(grossLossThb))}</span>` : ''}
          <span class="gl-count">(${totals.losses}L)</span>
        </span>
        <span class="muted">· ${data.count || 0} ไม้ · ${data.count ? Math.round((totals.wins / data.count) * 100) : 0}% win</span>
      </div>
    `;
    renderCmPnlModalTrades(body, data.trades || []);
  } catch (err) {
    body.innerHTML = `<div class="text-center py-4 text-muted-3">โหลดล้มเหลว: ${escapeHtml(err.message || 'unknown')}</div>`;
    totalEl.innerHTML = '';
  }
}

function renderCmPnlModalTrades(container, trades) {
  if (!trades.length) {
    container.innerHTML = '<div class="text-center py-4 text-muted-3">วันนี้ยังไม่มีเทรดปิด</div>';
    return;
  }
  // เรียงจากใหม่สุดขึ้นก่อน (sellFilledAt DESC) — เหมือน pnl.js
  const sorted = [...trades].sort((a, b) => {
    const at = a.sellFilledAt ? new Date(a.sellFilledAt).getTime() : 0;
    const bt = b.sellFilledAt ? new Date(b.sellFilledAt).getTime() : 0;
    return bt - at;
  });
  const rows = sorted.map((t) => {
    const pnl = t.realizedPnl || 0;
    const cls = pnl > 0 ? 'pnl-bull' : pnl < 0 ? 'pnl-bear' : '';
    const ts = t.sellFilledAt ? new Date(t.sellFilledAt).toLocaleString('th-TH', {
      hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short', hour12: false, timeZone: 'Asia/Bangkok',
    }) : '';
    const thb = (window.__fx && window.__fx.rate) ? (pnl * window.__fx.rate) : null;
    const isDcaStack = t.isDcaStack === true;
    const dcaBadge = isDcaStack
      ? `<span class="dca-pill" title="DCA stack — ${t.dcaLayerCount || '?'} layers">📚 L${t.dcaLayerCount || '?'}</span>`
      : '';
    const entryDisplay = isDcaStack
      ? `<span title="stack BEP">${t.stackBep ? window.PriceFormat.format(parseFloat(t.stackBep), t.symbol) : '—'}</span>`
      : (t.entryPrice ? window.PriceFormat.format(parseFloat(t.entryPrice), t.symbol) : '—');
    const qtyDisplay = isDcaStack
      ? `${t.stackTotalQty ? parseFloat(t.stackTotalQty).toFixed(4) : (t.qty ? parseFloat(t.qty).toFixed(4) : '—')}`
      : (t.qty ? parseFloat(t.qty).toFixed(4) : '—');
    const reasonPill = (window.SellReasons && window.SellReasons.renderSellReasonPill)
      ? window.SellReasons.renderSellReasonPill(t.sellReason, t.sellReasonDetail)
      : (t.sellReason || '—');
    return `<tr>
      <td><span class="badge-bot">${escapeHtml(t.botName || '?')}</span></td>
      <td>${escapeHtml(t.symbol || '')} ${dcaBadge}</td>
      <td class="text-end">${entryDisplay}</td>
      <td class="text-end">${t.exitPrice ? window.PriceFormat.format(parseFloat(t.exitPrice), t.symbol) : '—'}</td>
      <td class="text-end">${qtyDisplay}</td>
      <td class="text-end ${cls}">${formatUsdtPnl(pnl)}${thb != null ? `<br><span class="thb-sub">≈ ฿${formatThbInlinePnl(thb)}</span>` : ''}</td>
      <td class="text-end muted">${ts}</td>
      <td>${reasonPill}</td>
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

function buildCmPnlModalSkeleton() {
  const overlay = document.createElement('div');
  overlay.className = 'pnl-modal-overlay';
  overlay.innerHTML = `
    <div class="pnl-modal-card">
      <div class="pnl-modal-header">
        <h5 id="cm-pnl-modal-title">—</h5>
        <button type="button" class="pnl-modal-close" aria-label="ปิด">✕</button>
      </div>
      <div id="cm-pnl-modal-total" class="pnl-modal-total"></div>
      <div id="cm-pnl-modal-body" class="pnl-modal-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('.pnl-modal-close').addEventListener('click', () => overlay.classList.remove('is-open'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('is-open'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.classList.remove('is-open'); });
  _cmPnlModalOverlay = overlay;
}

/* ════════════════════════════════════════════════════════════════════
 * Grid rendering
 * ════════════════════════════════════════════════════════════════════ */

function renderGrid() {
  const grid = document.getElementById('cm-grid');
  const empty = document.getElementById('cm-empty');
  const filtered = _cmBots.filter((b) => {
    if (_cmFilter === 'running') return !!b.enabled;
    if (_cmFilter === 'running-with-position') return !!b.enabled || (b.activePositionsCount || 0) > 0;
    if (_cmFilter === 'stopped') return !b.enabled;
    return true;
  });
  const sorted = sortCmBots(filtered, _cmSort);

  // teardown existing chart instances (they'll be re-created on re-render)
  teardownCmCharts();

  document.getElementById('cm-showing-count').textContent =
    sorted.length === _cmBots.length
      ? `${_cmBots.length} บอท`
      : `${sorted.length} / ${_cmBots.length} บอท`;

  if (sorted.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  // Render cards (HTML only — mini-charts lazy-load via IntersectionObserver)
  grid.innerHTML = sorted.map((b) => renderCardHtml(b)).join('');

  // Register IntersectionObserver targets
  if (_cmLazyObserver) {
    grid.querySelectorAll('.cm-minichart[data-bot-id]').forEach((el) => {
      const botId = el.dataset.botId;
      _cmLazyPending.add(botId);
      _cmLazyObserver.observe(el);
    });
  } else {
    // fallback: load all immediately
    grid.querySelectorAll('.cm-minichart[data-bot-id]').forEach((el) => {
      loadCmMiniChart(el.dataset.botId, el, el.dataset.symbol, el.dataset.timeframe).catch((err) => {
        console.warn(`chart-monitor mini-chart ${el.dataset.botId}:`, err);
        el.innerHTML = `<div class="cm-minichart-error">⚠️ โหลดไม่สำเร็จ</div>`;
      });
    });
  }
}

function renderCardHtml(b) {
  const isRunning = !!b.enabled;
  const hasError = !!b.lastError;
  const hasWarning = !!b.warning;
  const todayPnl = b.todayPnl || 0;
  const todayPnlClass = todayPnl > 0 ? 'is-bull' : todayPnl < 0 ? 'is-bear' : 'is-gold';
  const lastClose = b.lastClose;
  const emaState = b.emaState || 'warmup';
  const emaZoneClass = emaState === 'above' ? 'zone-1' : emaState === 'below' ? 'zone-3' : 'zone-0';
  const emaZoneLabel = emaState === 'above' ? 'Strong Up' : emaState === 'below' ? 'Strong Down' : emaState === 'warmup' ? 'Warmup' : '—';

  const statusClass = !isRunning ? 'is-stopped' : hasError ? 'is-error' : hasWarning ? 'is-warning' : 'is-running';
  const statusText = !isRunning ? '⏸ STOPPED' : hasError ? '⚠ ERROR' : hasWarning ? '⚠ WARN' : '▶ RUNNING';

  // ─── Signal-derived decorations (highlight + prediction + blocked badges) ──
  const sig = _cmSignalMapByBot.get(String(b._id));
  const hasLiveSignal = !!(sig && sig.hasLiveSignal);
  const prediction = sig && sig.prediction ? sig.prediction : null;
  const lastSignal = sig && sig.lastSignal ? sig.lastSignal : null;
  const prevSignal = sig && sig.prevSignal ? sig.prevSignal : null;
  const blockedReasons = (lastSignal && lastSignal.blockedReasons) || (prevSignal && prevSignal.blockedReasons) || [];

  const cardClasses = ['cm-card'];
  if (!isRunning) cardClasses.push('is-stopped');
  if (hasError) cardClasses.push('is-error');
  if (hasLiveSignal) cardClasses.push('is-hot');
  if (prediction && prediction.code === 'near-s1') cardClasses.push('is-near-s1');

  // Prediction pill: 🌡️ near-s1 / 🚀 strong-up / 📉 strong-down / ➡️ above-basis
  let predictionHtml = '';
  if (prediction && prediction.label) {
    const pCode = prediction.code || 'unknown';
    predictionHtml = `<span class="cm-prediction cm-pred-${pCode}" title="${escapeHtml(prediction.label)}">${escapeHtml(prediction.label)}</span>`;
  }

  // Signal badge: 🔥 HOT เมื่อแท่งล่าสุดหรือก่อนหน้ามี S1
  let signalBadgeHtml = '';
  if (hasLiveSignal && lastSignal) {
    const signalPillClass = lastSignal.status === 'blocked' ? 'cm-signal-pill is-blocked' : 'cm-signal-pill is-active';
    const signalText = lastSignal.status === 'blocked' ? 'S1 (ข้าม)' : '🔥 S1 LIVE';
    const signalTitle = lastSignal.status === 'blocked'
      ? `S1 ติดที่แท่งล่าสุด แต่ถูกบล็อก: ${lastSignal.blockedReasons.map(r => r.text).join(' · ')}`
      : `S1 ติดที่แท่งล่าสุด — บอทกำลังเข้า BUY`;
    signalBadgeHtml = `<span class="${signalPillClass}" title="${escapeHtml(signalTitle)}">${signalText}</span>`;
  }

  // Blocked badges (per-bot's most recent blocked reason) — show as small chips
  let blockedBadgesHtml = '';
  if (blockedReasons.length > 0) {
    blockedBadgesHtml = `<div class="cm-blocked-row">${blockedReasons.map((r) => {
      const cls = `cm-blocked-pill kind-${r.kind}`;
      return `<span class="${cls}" title="${escapeHtml(r.text)}">${escapeHtml(r.text)}</span>`;
    }).join('')}</div>`;
  }

  const lastCloseStr = (lastClose != null && window.PriceFormat) ? window.PriceFormat.format(lastClose, b.symbol) : (lastClose != null ? Number(lastClose).toFixed(4) : '—');
  const posCount = b.activePositionsCount || 0;

  return `
    <div class="${cardClasses.join(' ')}" data-bot-card data-bot-id="${b._id}">
      <div class="cm-card-header">
        <span class="cm-card-name" title="${escapeHtml(b.name || b.symbol)}">${escapeHtml(b.name || b.symbol)}</span>
        <span class="cm-card-symbol">${escapeHtml(b.symbol || '')}</span>
        <span class="cm-card-tf">${escapeHtml(b.timeframe || '')}</span>
        <span class="cm-status ${statusClass}">${statusText}</span>
      </div>

      ${signalBadgeHtml ? `<div class="cm-signal-row">${signalBadgeHtml}</div>` : ''}

      <div class="cm-kpi-row">
        <div class="cm-kpi">
          <span class="k-value">${lastCloseStr}</span>
          <span class="k-label">ราคาล่าสุด</span>
        </div>
        <div class="cm-kpi">
          <span class="k-value">${posCount}</span>
          <span class="k-label">positions</span>
        </div>
        <div class="cm-kpi">
          <span class="k-value ${todayPnlClass}">${formatUsdtSafe(todayPnl)}</span>
          <span class="k-label">Today PnL</span>
        </div>
      </div>

      <div class="text-muted-2 small d-flex gap-2 align-items-center flex-wrap" style="font-size:0.7rem;">
        <span>Zone:</span>
        <span class="cm-zone-pill ${emaZoneClass}">${emaZoneLabel}</span>
        ${predictionHtml}
        <span class="ms-auto">${b.todayTrades || 0} trades วันนี้</span>
      </div>

      ${blockedBadgesHtml}

      <div class="cm-minichart" data-mini-chart data-bot-id="${b._id}" data-symbol="${escapeHtml(b.symbol || '')}" data-timeframe="${escapeHtml(b.timeframe || '')}">
        <div class="cm-minichart-loading">⏳ กำลังโหลดแท่งเทียด…</div>
      </div>

      <div class="cm-card-footer">
        <span>ทุน/ไม้: <strong>${formatUsdtSafe(b.capitalPerTrade || 0)}</strong> · max: ${b.maxTrades || 0}</span>
        <a href="/bot-detail.html?id=${b._id}" title="เปิดหน้ารายละเอียดบอท">📊 Detail →</a>
      </div>
    </div>`;
}

function sortCmBots(arr, sortKey) {
  const copy = arr.slice();
  if (sortKey === 'name')    copy.sort((a, b) => (a.name || a.symbol).localeCompare(b.name || b.symbol));
  if (sortKey === 'symbol')  copy.sort((a, b) => (a.symbol || '').localeCompare(b.symbol || ''));
  if (sortKey === 'pnl')     copy.sort((a, b) => (b.todayPnl || 0) - (a.todayPnl || 0));
  if (sortKey === 'tf')      copy.sort((a, b) => (a.timeframe || '').localeCompare(b.timeframe || ''));
  if (sortKey === 'default') {
    // Mirror bots.html: enabled first, then totalCapital desc, then createdAt desc
    copy.sort((a, b) => {
      if (!!b.enabled !== !!a.enabled) return (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0);
      const ta = (a.capitalPerTrade || 0) * (a.maxTrades || 0);
      const tb = (b.capitalPerTrade || 0) * (b.maxTrades || 0);
      if (tb !== ta) return tb - ta;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
  }
  return copy;
}

/* ════════════════════════════════════════════════════════════════════
 * Lazy-load + mini-chart rendering (mirrors bots.js pattern)
 * ════════════════════════════════════════════════════════════════════ */

function onCmLazyLoad(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const el = entry.target;
    const botId = el.dataset.botId;
    if (_cmLazyPending.has(botId)) {
      _cmLazyPending.delete(botId);
      _cmLazyObserver.unobserve(el);
      loadCmMiniChart(botId, el, el.dataset.symbol, el.dataset.timeframe).catch((err) => {
        console.warn(`chart-monitor mini-chart ${botId}:`, err);
        el.innerHTML = `<div class="cm-minichart-error">⚠️ โหลดไม่สำเร็จ</div>`;
      });
    }
  }
}

async function loadCmMiniChart(botId, el, symbol, timeframe) {
  // teardown previous if any
  if (_cmMiniCharts.has(botId)) {
    try { _cmMiniCharts.get(botId).chart.remove(); } catch (_) {}
    _cmMiniCharts.delete(botId);
  }
  if (typeof LightweightCharts === 'undefined') {
    el.innerHTML = `<div class="cm-minichart-error">lightweight-charts ไม่พร้อมใช้งาน</div>`;
    return;
  }

  const resp = await API.get(`/api/bots/${botId}/mini-chart?limit=40`);
  if (!resp.klines || resp.klines.length === 0) {
    el.innerHTML = `<div class="cm-minichart-error">— ไม่มีข้อมูล —</div>`;
    return;
  }

  // build container
  el.innerHTML = '';
  const w = el.clientWidth || 360;
  const h = 140;
  const numBars = resp.klines.length;
  const barSpacing = Math.max(3, Math.min(7, Math.floor(w / numBars)));

  const chart = LightweightCharts.createChart(el, {
    width: w,
    height: h,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#94a3b8',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.03)' },
      horzLines: { color: 'rgba(255,255,255,0.03)' },
    },
    rightPriceScale: {
      borderVisible: false,
      scaleMargins: { top: 0.08, bottom: 0.08 },
    },
    timeScale: {
      borderVisible: false,
      visible: false,
      rightOffset: Math.max(2, Math.round(numBars * 0.10)),
      barSpacing,
      handleScroll: false,
      handleScale: false,
    },
    crosshair: {
      vertLine: { visible: false },
      horzLine: { visible: false },
    },
  });

  const candleSeries = chart.addCandlestickSeries({
    upColor: '#00e5b8', downColor: '#ff4d6d',
    borderUpColor: '#00e5b8', borderDownColor: '#ff4d6d',
    wickUpColor: '#00e5b8', wickDownColor: '#ff4d6d',
    maxBarCount: numBars,
  });
  const basisSeries = chart.addLineSeries({
    color: '#f5b800', lineWidth: 1,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  const upperSeries = chart.addLineSeries({
    color: '#ff7849', lineWidth: 1, lineStyle: 2,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  const lowerSeries = chart.addLineSeries({
    color: '#a78bfa', lineWidth: 1, lineStyle: 2,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });

  const candleData = resp.klines.map((k) => ({
    time: Math.floor(k.openTime / 1000),
    open: k.open, high: k.high, low: k.low, close: k.close,
  }));
  candleSeries.setData(candleData);

  const basisData = [], upperData = [], lowerData = [];
  for (let i = 0; i < resp.klines.length; i += 1) {
    const t = Math.floor(resp.klines[i].openTime / 1000);
    if (resp.keltner.basis[i] != null) {
      basisData.push({ time: t, value: resp.keltner.basis[i] });
      upperData.push({ time: t, value: resp.keltner.upper[i] });
      lowerData.push({ time: t, value: resp.keltner.lower[i] });
    }
  }
  basisSeries.setData(basisData);
  upperSeries.setData(upperData);
  lowerSeries.setData(lowerData);

  const s1Markers = (resp.signals || []).map((s) => ({
    time: Math.floor(s.openTime / 1000),
    position: 'belowBar',
    color: '#22c55e',
    shape: 'arrowUp',
    text: 'S1',
  }));
  const allMarkers = [...s1Markers, ...(resp.tradeMarkers || [])];
  if (allMarkers.length > 0) candleSeries.setMarkers(allMarkers);

  chart.applyOptions({ timeScale: { barSpacing, rightOffset: Math.max(2, Math.round(numBars * 0.10)) } });

  _cmMiniCharts.set(botId, {
    chart, candleSeries, basisSeries, upperSeries, lowerSeries,
    klines: resp.klines.slice(), symbol, timeframe,
    tpPriceLines: [], // lightweight-charts PriceLine objects for each TP (one per open position)
  });

  // 2026-08-06: draw TP sell price lines for any active positions on this bot
  drawCmTpLinesForBot(botId);

  // 120s poll for marker refresh + KC re-sync (matches bots.js)
  if (_cmRefreshTimers.has(botId)) clearInterval(_cmRefreshTimers.get(botId));
  _cmRefreshTimers.set(botId, setInterval(() => {
    refreshCmMiniChart(botId).catch((e) => console.debug(`chart-monitor refresh ${botId}:`, e.message));
  }, 120_000));

  // Resize observer
  const ro = new ResizeObserver(() => {
    const w2 = el.clientWidth || 360;
    const newBarSpacing = Math.max(3, Math.min(7, Math.floor(w2 / numBars)));
    chart.applyOptions({ width: w2, timeScale: { barSpacing: newBarSpacing } });
  });
  ro.observe(el);
  _cmMiniCharts.get(botId)._ro = ro;
}

async function refreshCmMiniChart(botId) {
  const entry = _cmMiniCharts.get(botId);
  if (!entry) return;
  const resp = await API.get(`/api/bots/${botId}/mini-chart?limit=40`);
  const s1Markers = (resp.signals || []).map((s) => ({
    time: Math.floor(s.openTime / 1000),
    position: 'belowBar',
    color: '#22c55e',
    shape: 'arrowUp',
    text: 'S1',
  }));
  const allMarkers = [...s1Markers, ...(resp.tradeMarkers || [])];
  if (allMarkers.length > 0) entry.candleSeries.setMarkers(allMarkers);
  entry.klines = resp.klines.slice();
  const { basis, upper, lower } = resp.keltner || { basis: [], upper: [], lower: [] };
  const basisData = [], upperData = [], lowerData = [];
  for (let i = 0; i < resp.klines.length; i += 1) {
    const t = Math.floor(resp.klines[i].openTime / 1000);
    if (basis[i] != null) {
      basisData.push({ time: t, value: basis[i] });
      upperData.push({ time: t, value: upper[i] });
      lowerData.push({ time: t, value: lower[i] });
    }
  }
  if (basisData.length) entry.basisSeries.setData(basisData);
  if (upperData.length) entry.upperSeries.setData(upperData);
  if (lowerData.length) entry.lowerSeries.setData(lowerData);
  // 2026-08-06: refresh TP lines too (positions may have changed)
  drawCmTpLinesForBot(botId);
}

/* ════════════════════════════════════════════════════════════════════
 * TP price lines — draw horizontal line at each open position's targetSellPrice
 *   - lightweight-charts `createPriceLine` on candleSeries
 *   - hot-pink + dashed so it stands out against KC bands
 *   - one line per active position (capped at 4 visible to avoid clutter on DCA stacks)
 *   - re-runs on every loadCmPositions (positions changed) + chart refresh
 * ════════════════════════════════════════════════════════════════════ */

function clearCmTpLines(botId) {
  const entry = _cmMiniCharts.get(botId);
  if (!entry) return;
  if (Array.isArray(entry.tpPriceLines)) {
    for (const line of entry.tpPriceLines) {
      try { entry.candleSeries.removePriceLine(line); } catch (_) {}
    }
  }
  entry.tpPriceLines = [];
}

function drawCmTpLinesForBot(botId) {
  const entry = _cmMiniCharts.get(botId);
  if (!entry) return;
  clearCmTpLines(botId);
  const positions = _cmPositionsByBot.get(String(botId)) || [];
  if (positions.length === 0) return;
  // Only draw positions that have a valid targetSellPrice + matching symbol
  const sym = entry.symbol;
  const valid = positions.filter((p) =>
    p.symbol === sym
    && Number.isFinite(Number(p.targetSellPrice))
    && Number(p.targetSellPrice) > 0);
  if (valid.length === 0) return;
  // Cap visible lines to keep mini-chart readable (DCA stacks can have many)
  const MAX_LINES = 4;
  const shown = valid.slice(0, MAX_LINES);
  // 2026-08-06: TP lines = brand gold/yellow (#f5b800) consistently — uniform color for all DCA layers
  //   was palette ['#f472b6', '#22d3ee', '#a3e635', '#fbbf24'] (pink/cyan/lime/yellow)
  //   user feedback: pink clashed with mini-chart, switch to single yellow brand color
  const TP_LINE_COLOR = '#f5b800';
  shown.forEach((p, idx) => {
    const tp = Number(p.targetSellPrice);
    // 2026-08-06: TP label = "TP" only (drop symbol suffix to avoid clutter)
    const title = valid.length > MAX_LINES && idx === MAX_LINES - 1
      ? `TP (+${valid.length - MAX_LINES + 1} more)`
      : 'TP';
    try {
      const line = entry.candleSeries.createPriceLine({
        price: tp,
        color: TP_LINE_COLOR,
        lineWidth: 1,
        lineStyle: 2, // LightweightCharts LineStyle.Dashed
        axisLabelVisible: true,
        title,
      });
      entry.tpPriceLines.push(line);
    } catch (err) {
      console.debug(`TP line draw failed for ${botId}/${p.symbol}:`, err.message);
    }
  });
}

function redrawAllCmTpLines() {
  for (const botId of _cmMiniCharts.keys()) {
    drawCmTpLinesForBot(botId);
  }
}

/* ════════════════════════════════════════════════════════════════════
 * WS live updates
 * ════════════════════════════════════════════════════════════════════ */

function bindCmWs() {
  if (typeof WSClient === 'undefined') return;

  WSClient.on('kline:update', (p) => {
    if (!p || !p.kline) return;
    for (const [botId, entry] of _cmMiniCharts.entries()) {
      if (entry.symbol !== p.symbol || entry.timeframe !== p.interval) continue;
      const k = p.kline;
      const t = Math.floor(k.openTime / 1000);
      entry.candleSeries.update({
        time: t,
        open: parseFloat(k.open),
        high: parseFloat(k.high),
        low: parseFloat(k.low),
        close: parseFloat(k.close),
      });
    }
  });

  // When a bot's status changes (start/stop), refresh the grid to update pills
  WSClient.on('bot:status', () => {
    loadBots().catch((e) => console.debug('chart-monitor bot:status refresh:', e.message));
    loadSignals().catch((e) => console.debug('chart-monitor signals refresh:', e.message));
  });
  WSClient.on('trade:update', () => {
    // re-fetch every bot's chart to get fresh markers (cheap, ~120s poll already exists)
    for (const botId of _cmMiniCharts.keys()) {
      refreshCmMiniChart(botId).catch((e) => console.debug(`chart-monitor trade:update ${botId}:`, e.message));
    }
    // 2026-08-06: positions panel also reacts to trade updates (BUY/SELL fired)
    loadCmPositions().catch((e) => console.debug('chart-monitor positions trade:update:', e.message));
  });
}

/* ════════════════════════════════════════════════════════════════════
 * Heartbeat
 * ════════════════════════════════════════════════════════════════════ */

function renderHeartbeat(status) {
  const sym = (ok) => ok ? '🟢' : '🔴';
  const known = (ok, label) => `${sym(ok)} ${label}`;
  const fmt = (ok) => ok ? 'is-ok' : 'is-error';
  const set = (id, label, ok) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('is-ok', 'is-error');
    el.classList.add(fmt(ok));
    const lbl = el.querySelector('.hb-label');
    if (lbl) lbl.innerHTML = label;
  };
  set('hb-mongodb',  `🗄️ MongoDB`,        !!status.mongodb);
  set('hb-binance',  `🔌 Binance API`,     !!status.binance);
  set('hb-marketws', `📡 Market WS`,       !!status.marketWs);
  set('hb-userws',   `👤 User Stream`,     !!status.userStream);
  const overall = !!(status.mongodb && status.binance && status.marketWs);
  set('hb-overall',  `Overall: <strong>${overall ? '🟢 OK' : '🔴 DEGRADED'}</strong>`, overall);
  const ts = status.ts ? new Date(status.ts).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '-';
  setText('hb-ts', ts);
}

/* ════════════════════════════════════════════════════════════════════
 * Cleanup
 * ════════════════════════════════════════════════════════════════════ */

function teardownCmCharts() {
  for (const [, entry] of _cmMiniCharts.entries()) {
    try { if (entry._ro) entry._ro.disconnect(); } catch (_) {}
    try { entry.chart.remove(); } catch (_) {}
  }
  _cmMiniCharts.clear();
  for (const [, t] of _cmRefreshTimers.entries()) clearInterval(t);
  _cmRefreshTimers.clear();
  _cmLazyPending.clear();
}

/* ════════════════════════════════════════════════════════════════════
 * 20 latest signals panel — top 20 most recent S1 signals across all running bots
 * ════════════════════════════════════════════════════════════════════ */

function renderLatestSignalsPanel() {
  const panel = document.getElementById('cm-latest-signals');
  const countEl = document.getElementById('cm-latest-signals-count');
  const tsEl = document.getElementById('cm-latest-signals-ts');
  if (!panel) return;
  const signals = (_cmSignals && _cmSignals.signals) || [];
  if (countEl) countEl.textContent = signals.length > 0 ? `${signals.length} รายการ` : 'ไม่มี';
  if (tsEl && _cmSignals && _cmSignals.asOf) {
    const asOf = new Date(_cmSignals.asOf).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    tsEl.textContent = `อัปเดต ${asOf}`;
  }

  if (signals.length === 0) {
    panel.innerHTML = `<div class="cm-latest-empty">ยังไม่มี S1 signal ในบอทที่รันอยู่ — รอบอท fire แท่งใหม่</div>`;
    return;
  }

  const rows = signals.map((s) => {
    const ageTxt = formatAgeSafe(s.ageMs);
    const priceTxt = (s.close != null && window.PriceFormat) ? window.PriceFormat.format(s.close, s.symbol) : (s.close != null ? Number(s.close).toFixed(4) : '—');
    const blockedHtml = (s.blockedReasons && s.blockedReasons.length > 0)
      ? `<div class="cm-ls-reasons">${s.blockedReasons.map((r) => `<span class="cm-blocked-pill kind-${r.kind}">${escapeHtml(r.text)}</span>`).join('')}</div>`
      : '';
    const statusCls = s.status === 'blocked' ? 'is-blocked' : 'is-active';
    const statusIcon = s.status === 'blocked' ? '⛔' : '✅';
    // 2026-08-06: add absolute date+time sub-line under the relative age
    const dtTxt = s.openTime ? formatCmSignalDateTime(s.openTime) : '';
    return `
      <div class="cm-ls-row ${statusCls}">
        <div class="cm-ls-left">
          <span class="cm-ls-status">${statusIcon}</span>
          <div class="cm-ls-body">
            <div class="cm-ls-bot">${escapeHtml(s.name)} <span class="cm-ls-meta">${escapeHtml(s.symbol)} · ${escapeHtml(s.timeframe)}</span></div>
            <div class="cm-ls-time">${ageTxt} · bg ${s.bgPrev}→${s.bgState}</div>
            ${dtTxt ? `<div class="cm-ls-datetime">📅 ${dtTxt}</div>` : ''}
          </div>
        </div>
        <div class="cm-ls-right">
          <div class="cm-ls-price">${priceTxt}</div>
          ${blockedHtml}
        </div>
      </div>`;
  }).join('');
  panel.innerHTML = rows;
}

function formatAgeSafe(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} วินาทีที่แล้ว`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} นาทีที่แล้ว`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ชั่วโมงที่แล้ว`;
  const day = Math.floor(hr / 24);
  return `${day} วันที่แล้ว`;
}

// 2026-08-06: absolute date+time formatter for S1 signal rows
//   - แสดง "วัน/เดือน ปี HH:MM" ในเขตเวลา Asia/Bangkok
//   - ถ้าเป็นวันเดียวกับวันนี้ → "วันนี้ HH:MM"
//   - ถ้าเป็นเมื่อวาน → "เมื่อวาน HH:MM"
function formatCmSignalDateTime(openTime) {
  if (!openTime || !isFinite(openTime)) return '';
  const d = new Date(openTime);
  if (isNaN(d.getTime())) return '';
  const fmtTime = d.toLocaleTimeString('th-TH', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const today = new Date();
  const isSameDay = d.toDateString() === today.toDateString();
  if (isSameDay) return `วันนี้ ${fmtTime}`;
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (isYesterday) return `เมื่อวาน ${fmtTime}`;
  // FIX-2026-08-06: แสดงวันที่เต็ม — ใช้รูปแบบสั้น "6 ส.ค." (ไทย) เพื่อไม่ให้ row ยาวเกิน
  const dateStr = d.toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short',
  });
  return `${dateStr} ${fmtTime}`;
}

/* ════════════════════════════════════════════════════════════════════
 * Helpers
 * ════════════════════════════════════════════════════════════════════ */

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function formatUsdtSafe(v) {
  if (v == null || !isFinite(v)) return '0.00';
  const abs = Math.abs(v);
  if (abs >= 10000) return `${v < 0 ? '-' : ''}${(abs / 1000).toFixed(2)}k`;
  return `${v < 0 ? '-' : ''}${abs.toFixed(2)}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

init();
