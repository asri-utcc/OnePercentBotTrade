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
// FIX-2026-08-23: concurrency cap on mini-chart loading — without this, fast scrolls
//   trigger 20+ simultaneous /api/bots/:id/mini-chart + createChart() calls → browser spike
const _CM_MAX_CONCURRENT_CHARTS = 3;
const _cmChartInFlight = new Set(); // botIds currently loading a chart
const _cmChartQueue = []; // FIFO of { botId, el } waiting for a free slot

let _cmBots = []; // full bot list (cache)
let _cmSignals = null; // latest signals response (from /api/bots/chart-monitor/signals)
let _cmSignalMapByBot = new Map(); // botId -> per-bot summary (for highlight + prediction)
let _cmPositions = null; // latest open positions snapshot (from /api/bots/positions)
let _cmPositionsAsOf = null;
let _cmPositionsByBot = new Map(); // botId -> positions[] (for TP line drawing)
let _cmFilter = 'running-with-position'; // 'running' | 'stopped' | 'all' | 'running-with-position' (default: 2026-08-06)
let _cmSort = 'default'; // 'default' | 'name' | 'symbol' | 'pnl' | 'tf'
let _cmPositionModal = null; // bootstrap.Modal instance for #cmPositionModal

// FIX-2026-08-23: debounce renderGrid() — bot:status WS triggers both loadBots()+loadSignals()
//   which each call renderGrid → 2× full teardown per event. Coalesce into a single delayed render.
let _cmRenderGridTimer = null;
function scheduleRenderGrid() {
  if (_cmRenderGridTimer) clearTimeout(_cmRenderGridTimer);
  _cmRenderGridTimer = setTimeout(() => {
    _cmRenderGridTimer = null;
    renderGrid();
  }, 250);
}

// 2026-08-08: Auto-refresh toggle for Open Positions panel — default OFF on every page load.
// State is NOT persisted; reload always resets to OFF.
let _cmPositionsAuto = false;
let _cmPositionsAutoTimer = null;
const CM_POS_AUTO_INTERVAL_MS = 10_000;

function startCmPositionsAutoRefresh() {
  if (_cmPositionsAutoTimer) return; // already running
  _cmPositionsAutoTimer = setInterval(() => {
    loadCmPositions().catch((e) => console.debug('chart-monitor positions auto-refresh:', e.message));
  }, CM_POS_AUTO_INTERVAL_MS);
}

function stopCmPositionsAutoRefresh() {
  if (_cmPositionsAutoTimer) {
    clearInterval(_cmPositionsAutoTimer);
    _cmPositionsAutoTimer = null;
  }
}

function setCmPositionsAuto(on) {
  _cmPositionsAuto = !!on;
  const btn = document.getElementById('cm-positions-auto');
  if (btn) {
    btn.classList.toggle('is-on', _cmPositionsAuto);
    btn.classList.toggle('is-off', !_cmPositionsAuto);
    btn.setAttribute('aria-pressed', _cmPositionsAuto ? 'true' : 'false');
    const label = btn.querySelector('.cm-auto-label');
    if (label) label.textContent = _cmPositionsAuto ? 'Auto: ON' : 'Auto';
    btn.title = _cmPositionsAuto
      ? `Auto Refresh ON (ทุก ${CM_POS_AUTO_INTERVAL_MS / 1000}s) — คลิกเพื่อปิด`
      : 'Auto Refresh OFF (default) — คลิกเพื่อเปิด';
  }
  if (_cmPositionsAuto) startCmPositionsAutoRefresh();
  else stopCmPositionsAutoRefresh();
}

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

  // 2026-08-08: Auto-refresh toggle for Open Positions — default OFF on every page load
  const autoBtn = document.getElementById('cm-positions-auto');
  if (autoBtn) {
    autoBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger collapse toggle
      setCmPositionsAuto(!_cmPositionsAuto);
    });
  }
  // Ensure UI reflects OFF state on init (defensive — HTML already has is-off)
  setCmPositionsAuto(false);

  // Positions card collapse/expand (2026-08-06) — default collapsed, state persisted in localStorage
  initCmPositionsCollapse();

  // Mini-chart grid collapse/expand (2026-09-06) — default EXPANDED (charts are the main content)
  initCmGridCollapse();

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

  // FIX-2026-08-22: delegated click handler on modal body for Force Close button
  //   - เดิม modal ไม่มี handler → กด Force Close ใน modal ไม่ทำงาน
  const modalBodyEl = document.getElementById('cmPositionModalBody');
  if (modalBodyEl) modalBodyEl.addEventListener('click', onCmPositionModalBodyClick);

  // Bootstrap modal instance for expand chart (2026-08-06) + Load more/Reset buttons
  initCmExpandModal();

  // Delegated click handler for expand button (🔍) on each card
  const cmGrid = document.getElementById('cm-grid');
  if (cmGrid) cmGrid.addEventListener('click', onCmCardActionClick);

  // Start WS for live candle updates
  WSClient.start();

  // First load (FIX-2026-08-23: parallel — 3 round-trips fire together, faster first paint)
  await Promise.all([loadBots(), loadSignals(), loadCmPositions()]);
  // 2026-08-06: BNB fuel gauge (mirror bots.html)
  loadCmBnbStatus().catch(() => {});

  // Signals refresh — 60s (server cache is 30s)
  setInterval(() => { loadSignals().catch((e) => console.debug('chart-monitor signals refresh:', e.message)); }, 60_000);

  // 2026-08-06: BNB gauge poll — 60s (server cache 30s, balance changes slowly)
  setInterval(() => { loadCmBnbStatus().catch(() => {}); }, 60_000);

  // FIX-2026-08-23: Master Config button (mirror bots.html) — bulk-edit many bots at once
  const cmMasterBtn = document.getElementById('btn-cm-master-config');
  if (cmMasterBtn) {
    cmMasterBtn.addEventListener('click', () => {
      if (window.masterConfigModal) window.masterConfigModal.openMasterConfigModal();
      else console.warn('masterConfigModal not loaded — check /js/partials/masterConfigModal.js');
    });
  }
  // When Master Config finishes a bulk-update, refresh chart-monitor bots list
  //   so cards reflect new TP/auto-pause/etc. settings immediately.
  window.addEventListener('bots:bulk-updated', () => {
    loadBots().catch((e) => console.debug('chart-monitor master-config refresh:', e.message));
  });

  // Positions refresh — 30s (cache uses klineCache; user-triggered fresh mode uses Binance bookTicker)
  // 2026-08-08: gated by Auto Refresh toggle (default OFF). WS trade:update still refreshes
  // independently on actual BUY/SELL events (event-driven, not polling).
  // setInterval removed; polling now driven by startCmPositionsAutoRefresh()

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
    // FIX-2026-08-23: removed ?expand=1 — chart-monitor doesn't render volatility tiles.
    //   Default /api/bots response already skips volatility snapshot (cheap path).
    //   Saved: ~1-2s on cold cache (no Binance vol snapshot).
    const resp = await API.get('/api/bots');
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
    // FIX-2026-08-23: debounce — coalesce with bot:status-driven renderGrid bursts
    scheduleRenderGrid();
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
  // FIX-2026-08-23: append ?noPrediction=1 — chart-monitor PositionCard doesn't render
  //   the AU prediction panel, so skip the heavy upper-KC pre-compute on the server.
  //   Saves: 1 REST klines call per unique (symbol, tf) on cold cache + per-position compute.
  const url = opts.fresh ? '/api/bots/positions?fresh=1&noPrediction=1' : '/api/bots/positions?noPrediction=1';
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
    updateCmPositionsTotals(0, 0, 0);
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

  // 2026-08-08: Update header totals (Cost + Unrealized PnL + THB) from API response
  const resp = _cmPositions || {};
  updateCmPositionsTotals(positions.length, Number(resp.totalCostUsdt) || 0, Number(resp.totalUnrealizedUsdt) || 0);
}

/**
 * 2026-08-08: Update the header totals (Total Cost + Unrealized PnL + % + THB)
 * - Lives next to "Open Positions [N]" in the panel header
 * - Hidden when positions.length === 0
 * - PnL color mirrors cards (pnl-bull / pnl-bear) for visual consistency
 * - THB sub-line via window.usdtToThb (mirror Today PnL tile + cards)
 */
function updateCmPositionsTotals(count, totalCost, totalPnl) {
  const totalsEl = document.getElementById('cm-positions-totals');
  if (!totalsEl) return;
  if (count === 0) {
    totalsEl.hidden = true;
    return;
  }
  totalsEl.hidden = false;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost * 100) : 0;
  const sign = totalPnl >= 0 ? '+' : '';
  const costEl = document.getElementById('cm-pt-cost');
  const pnlEl = document.getElementById('cm-pt-pnl');
  const pnlPctEl = document.getElementById('cm-pt-pnl-pct');
  const costThbEl = document.getElementById('cm-pt-cost-thb');
  const pnlThbEl = document.getElementById('cm-pt-pnl-thb');
  if (costEl) costEl.textContent = Number(totalCost).toFixed(2);
  if (pnlEl) {
    pnlEl.textContent = `${sign}${Number(totalPnl).toFixed(4)}`;
    pnlEl.classList.toggle('pnl-bull', totalPnl >= 0);
    pnlEl.classList.toggle('pnl-bear', totalPnl < 0);
  }
  if (pnlPctEl) pnlPctEl.textContent = `(${sign}${totalPnlPct.toFixed(3)}%)`;
  // THB equivalents — small, subtle (uses existing .thb-eq style)
  if (costThbEl) {
    const thb = (typeof window.usdtToThb === 'function') ? window.usdtToThb(totalCost) : '';
    costThbEl.textContent = thb ? ` ${thb}` : '';
  }
  if (pnlThbEl) {
    const thb = (typeof window.usdtToThb === 'function') ? window.usdtToThb(totalPnl) : '';
    pnlThbEl.textContent = thb ? ` ${thb}` : '';
  }
}

/* ════════════════════════════════════════════════════════════════════
 * Click handler for position cards on chart-monitor
 *   - clicking a card (not the inner buttons) → opens detail modal
 *   - clicking Force Close button → confirm + API call (same as bots.html)
 * ════════════════════════════════════════════════════════════════════ */

async function onCmPositionCardClick(ev) {
  // Force Close button (grid variant)
  const fcBtn = ev.target.closest('.btn-force-close-cm');
  if (fcBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    await _doCmForceClose(fcBtn, { closeModal: false });
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

/**
 * FIX-2026-08-22: Click handler for position detail modal body
 *   - Force Close button (.btn-force-close-cm-modal) → same flow as grid (confirm + API + refetch)
 *     - เดิม modal ไม่มี delegated handler → กด Force Close ใน modal ไม่ทำงาน
 *   - Chart button (.btn-chart-link-cm-modal) → ปล่อยให้ <a target=_blank> ทำงานเอง
 *   - ปิด modal หลัง force-close สำเร็จ เพื่อให้เห็น grid ที่อัปเดตแล้ว
 */
async function onCmPositionModalBodyClick(ev) {
  // Force Close button (modal variant)
  const fcBtn = ev.target.closest('.btn-force-close-cm-modal');
  if (fcBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    await _doCmForceClose(fcBtn, { closeModal: true });
    return;
  }

  // Expand chart button (FIX-2026-08-22) — mirror 🔍 บน mini-chart cards
  //   - ใช้ expand modal เดียวกับ grid (500 bars + KC + S1 markers + TP lines)
  //   - ปิด position modal ก่อน → เปิด expand modal ทับ (back จาก expand กลับมาที่ grid)
  const expBtn = ev.target.closest('[data-action="expand-chart"]');
  if (expBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    if (_cmPositionModal) _cmPositionModal.hide();
    _doCmExpandChart(expBtn);
    return;
  }

  // Chart button (don't interfere — let <a target=_blank> open in new tab)
  if (ev.target.closest('.btn-chart-link-cm-modal')) return;
}

/**
 * FIX-2026-08-22: Shared force-close flow (used by both grid + modal handlers)
 *   - btn: the .btn-force-close-cm[/-modal] element (must have data-trade-id + data-bot-id)
 *   - opts.closeModal: true → hide _cmPositionModal after success (modal context)
 *   - Finds the live position from _cmPositions.positions; if missing, warns + returns
 *   - Mirrors bots.html onOpenPositionsClick (LUX_CONFIRM.luxConfirm + callBotWithPassword)
 */
async function _doCmForceClose(btn, opts = {}) {
  const tradeId = btn.dataset.tradeId;
  const botId = btn.dataset.botId;
  if (!tradeId || !botId) return;
  const pos = _cmPositions && _cmPositions.positions.find((p) => p.tradeId === tradeId);
  if (!pos) {
    await window.LUX_CONFIRM.luxAlert({
      variant: 'warning', icon: '⚠️', title: 'ไม้นี้ปิดไปแล้ว',
      message: 'Position นี้ไม่อยู่ในรายการ open แล้ว — กรุณาปิด modal แล้วรีเฟรช',
    });
    return;
  }
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
    if (opts.closeModal && _cmPositionModal) _cmPositionModal.hide();
    await loadCmPositions();
  } catch (err) {
    await window.LUX_CONFIRM.luxAlert({
      variant: 'danger', icon: '⚠️', title: 'บังคับปิดไม่สำเร็จ',
      message: err.message || String(err),
    });
  }
}

/* 2026-08-06: Card action click delegation (currently: expand chart button)
 * FIX-2026-08-22: refactored → shared with modal handler via _doCmExpandChart()
 */
function onCmCardActionClick(ev) {
  const btn = ev.target.closest('[data-action="expand-chart"]');
  if (!btn) return;
  ev.preventDefault();
  ev.stopPropagation();
  _doCmExpandChart(btn);
}

/**
 * FIX-2026-08-22: Shared expand-chart flow (used by both grid + modal handlers)
 *   - btn: any element with data-action="expand-chart" + data-bot-id
 *   - Looks up the bot via _cmBots, inits _cmExpandChart state, opens #cmExpandModal
 *   - No-op if bot not found (caller should already have gated)
 */
function _doCmExpandChart(btn) {
  const botId = btn.dataset.botId;
  if (!botId) return;
  const bot = _cmBots.find((b) => String(b._id) === String(botId));
  if (!bot) return;
  // Init _cmExpandChart entry so loadExpandChart has somewhere to write
  _cmExpandChart = {
    chart: null, candleSeries: null, basisSeries: null, upperSeries: null, lowerSeries: null,
    botId, symbol: bot.symbol, timeframe: bot.timeframe, limit: 0, ro: null, tpPriceLines: [],
  };
  openCmExpandModal(botId).catch((e) => console.warn('expand modal:', e.message));
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
      expandBtnClass: 'btn-expand-chart-cm-modal',
    },
  );
  if (_cmPositionModal) _cmPositionModal.show();
}

/* ════════════════════════════════════════════════════════════════════
 * Expand mini-chart modal (2026-08-06)
 *   - click 🔍 on any card → opens this modal
 *   - default 500 bars (larger view, all features preserved)
 *     - candle series + KC bands (basis/upper/lower)
 *     - S1 markers + BUY/SELL trade markers
 *     - TP price lines (one per open position)
 *     - signal badge + zone pill + prediction label (from _cmSignalMapByBot)
 *   - Load more button: increments limit by 500 (up to backend cap 2000)
 *   - Reset button: back to 500
 *   - WS kline:update still updates the live candle
 *   - Cleanup: chart removed on modal hide (avoids memory leak)
 * ════════════════════════════════════════════════════════════════════ */
let _cmExpandModal = null;
let _cmExpandChart = null; // { chart, candleSeries, basisSeries, upperSeries, lowerSeries, botId, limit, tpPriceLines: [], ro }
let _cmExpandInitialLimit = 500;
let _cmExpandLoadStep = 500;
const CM_EXPAND_MAX_LIMIT = 2000;

function initCmExpandModal() {
  const modalEl = document.getElementById('cmExpandModal');
  if (!modalEl || !window.bootstrap) return;
  _cmExpandModal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
  // Wire Load more / Reset buttons (once)
  const loadMore = document.getElementById('cmExpandLoadMore');
  const reset = document.getElementById('cmExpandReset');
  if (loadMore) loadMore.addEventListener('click', () => {
    if (!_cmExpandChart) return;
    const next = Math.min(_cmExpandChart.limit + _cmExpandLoadStep, CM_EXPAND_MAX_LIMIT);
    if (next === _cmExpandChart.limit) {
      setExpandStats(`ถึงขีดจำกัดแล้ว (${CM_EXPAND_MAX_LIMIT} แท่ง)`);
      return;
    }
    loadExpandChart(next).catch((e) => console.warn('expand load more:', e.message));
  });
  if (reset) reset.addEventListener('click', () => {
    loadExpandChart(_cmExpandInitialLimit).catch((e) => console.warn('expand reset:', e.message));
  });
  // Cleanup on hide
  modalEl.addEventListener('hidden.bs.modal', teardownCmExpandChart);
}

async function openCmExpandModal(botId) {
  const bot = _cmBots.find((b) => String(b._id) === String(botId));
  if (!bot) return;
  if (!_cmExpandModal) initCmExpandModal();
  if (!_cmExpandModal) return;
  // Title + sub
  const titleEl = document.getElementById('cmExpandModalTitle');
  const subEl = document.getElementById('cmExpandModalSub');
  if (titleEl) titleEl.textContent = `${bot.name || bot.symbol}`;
  if (subEl) {
    const todayPnl = bot.todayPnl || 0;
    const pnlSign = todayPnl > 0 ? '+' : todayPnl < 0 ? '' : '';
    subEl.innerHTML = `<span class="cm-card-symbol">${escapeHtml(bot.symbol || '')}</span> <span class="cm-card-tf">${escapeHtml(bot.timeframe || '')}</span> · PnL ${pnlSign}${todayPnl.toFixed(4)} USDT · ${bot.todayTrades || 0} ไม้`;
  }
  // Signal row (mirror card decorations: signal pill + zone + prediction + blocked)
  renderExpandSignalRow(bot);
  // Reset body before show
  const wrap = document.getElementById('cmExpandChartWrap');
  if (wrap) wrap.innerHTML = '<div class="cm-minichart-loading">⏳ กำลังโหลด…</div>';
  _cmExpandModal.show();
  await loadExpandChart(_cmExpandInitialLimit);
}

async function loadExpandChart(limit) {
  if (!_cmExpandChart || !_cmExpandChart.botId) return;
  const botId = _cmExpandChart.botId;
  const bot = _cmBots.find((b) => String(b._id) === String(botId));
  if (!bot) return;
  const wrap = document.getElementById('cmExpandChartWrap');
  const statsEl = document.getElementById('cmExpandStats');
  if (statsEl) statsEl.textContent = `⏳ กำลังโหลด ${limit} แท่ง…`;
  try {
    const resp = await API.get(`/api/bots/${botId}/mini-chart?limit=${limit}`);
    _cmExpandChart.limit = limit;
    // (Re)create chart if first load OR limit changed and we want fresh
    if (!_cmExpandChart.chart) {
      if (wrap) wrap.innerHTML = '';
      const w = wrap ? (wrap.clientWidth || 900) : 900;
      const h = wrap ? (wrap.clientHeight || 500) : 500;
      const chart = LightweightCharts.createChart(wrap, {
        width: w,
        height: h,
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
          rightOffset: 6,
          handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
          handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, mouseWheelPan: true },
        },
        crosshair: {
          vertLine: { color: 'rgba(245,184,0,0.4)', width: 1, style: 3, labelBackgroundColor: '#f5b800' },
          horzLine: { color: 'rgba(245,184,0,0.4)', width: 1, style: 3, labelBackgroundColor: '#f5b800' },
        },
      });
      const candleSeries = chart.addCandlestickSeries({
        upColor: '#00e5b8', downColor: '#ff4d6d',
        borderUpColor: '#00e5b8', borderDownColor: '#ff4d6d',
        wickUpColor: '#00e5b8', wickDownColor: '#ff4d6d',
      });
      const basisSeries = chart.addLineSeries({ color: '#f5b800', lineWidth: 1 });
      const upperSeries = chart.addLineSeries({ color: '#ff7849', lineWidth: 1, lineStyle: 2 });
      const lowerSeries = chart.addLineSeries({ color: '#a78bfa', lineWidth: 1, lineStyle: 2 });
      _cmExpandChart.chart = chart;
      _cmExpandChart.candleSeries = candleSeries;
      _cmExpandChart.basisSeries = basisSeries;
      _cmExpandChart.upperSeries = upperSeries;
      _cmExpandChart.lowerSeries = lowerSeries;
      // Resize observer
      const ro = new ResizeObserver(() => {
        const w2 = wrap ? wrap.clientWidth : 900;
        const h2 = wrap ? wrap.clientHeight : 500;
        chart.applyOptions({ width: w2, height: h2 });
      });
      ro.observe(wrap);
      _cmExpandChart.ro = ro;
    }
    // Set data
    if (!resp.klines || resp.klines.length === 0) {
      if (wrap) wrap.innerHTML = '<div class="cm-minichart-error">— ไม่มีข้อมูล —</div>';
      return;
    }
    const candleData = resp.klines.map((k) => ({
      time: Math.floor(k.openTime / 1000),
      open: k.open, high: k.high, low: k.low, close: k.close,
    }));
    _cmExpandChart.candleSeries.setData(candleData);
    const basisData = [], upperData = [], lowerData = [];
    for (let i = 0; i < resp.klines.length; i += 1) {
      const t = Math.floor(resp.klines[i].openTime / 1000);
      if (resp.keltner.basis[i] != null) {
        basisData.push({ time: t, value: resp.keltner.basis[i] });
        upperData.push({ time: t, value: resp.keltner.upper[i] });
        lowerData.push({ time: t, value: resp.keltner.lower[i] });
      }
    }
    _cmExpandChart.basisSeries.setData(basisData);
    _cmExpandChart.upperSeries.setData(upperData);
    _cmExpandChart.lowerSeries.setData(lowerData);
    // Markers: S1 + BUY/SELL
    const s1Markers = (resp.signals || []).map((s) => ({
      time: Math.floor(s.openTime / 1000),
      position: 'belowBar', color: '#22c55e', shape: 'arrowUp', text: 'S1',
    }));
    const allMarkers = [...s1Markers, ...(resp.tradeMarkers || [])];
    if (allMarkers.length > 0) _cmExpandChart.candleSeries.setMarkers(allMarkers);
    // TP lines
    drawCmExpandTpLines();
    // Stats
    if (statsEl) {
      const from = resp.klines[0] ? new Date(resp.klines[0].openTime).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '?';
      const to = resp.klines[resp.klines.length - 1] ? new Date(resp.klines[resp.klines.length - 1].openTime).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '?';
      statsEl.textContent = `${resp.klines.length} แท่ง · ${from} → ${to}`;
    }
    // First load: fit content (show all data). Load more: keep current view (new bars appear on left).
    // Reset: fit content (back to default 500).
    if (limit === _cmExpandInitialLimit) {
      // small timeout so chart is fully painted before fitContent measures
      setTimeout(() => {
        try { _cmExpandChart.chart.timeScale().fitContent(); } catch (_) {}
      }, 50);
    }
    // (else: Load more — keep current visible range; new data on left auto-shifts in)
  } catch (err) {
    if (wrap) wrap.innerHTML = `<div class="cm-minichart-error">⚠️ โหลดไม่สำเร็จ: ${escapeHtml(err.message || 'unknown')}</div>`;
  }
}

function setExpandStats(text) {
  const el = document.getElementById('cmExpandStats');
  if (el) el.textContent = text;
}

function renderExpandSignalRow(bot) {
  const rowEl = document.getElementById('cmExpandSignalRow');
  if (!rowEl) return;
  const sig = _cmSignalMapByBot.get(String(bot._id));
  const hasLiveSignal = !!(sig && sig.hasLiveSignal);
  const prediction = sig && sig.prediction ? sig.prediction : null;
  const lastSignal = sig && sig.lastSignal ? sig.lastSignal : null;
  const prevSignal = sig && sig.prevSignal ? sig.prevSignal : null;
  const blockedReasons = (lastSignal && lastSignal.blockedReasons) || (prevSignal && prevSignal.blockedReasons) || [];
  const isRunning = !!bot.enabled;
  const hasError = !!bot.lastError;
  const hasWarning = !!bot.warning;
  const statusClass = !isRunning ? 'is-stopped' : hasError ? 'is-error' : hasWarning ? 'is-warning' : 'is-running';
  const statusText = !isRunning ? '⏸ STOPPED' : hasError ? '⚠ ERROR' : hasWarning ? '⚠ WARN' : '▶ RUNNING';
  const emaState = bot.emaState || 'warmup';
  const emaZoneClass = emaState === 'above' ? 'zone-1' : emaState === 'below' ? 'zone-3' : 'zone-0';
  const emaZoneLabel = emaState === 'above' ? 'Strong Up' : emaState === 'below' ? 'Strong Down' : emaState === 'warmup' ? 'Warmup' : '—';
  // Status
  let html = `<span class="cm-status ${statusClass}">${statusText}</span>`;
  // Zone pill
  html += `<span class="cm-zone-pill ${emaZoneClass}">Zone: ${emaZoneLabel}</span>`;
  // Prediction
  if (prediction && prediction.label) {
    const pCode = prediction.code || 'unknown';
    html += `<span class="cm-prediction cm-pred-${pCode}" title="${escapeHtml(prediction.label)}">${escapeHtml(prediction.label)}</span>`;
  }
  // S1 signal pill
  if (hasLiveSignal && lastSignal) {
    const signalPillClass = lastSignal.status === 'blocked' ? 'cm-signal-pill is-blocked' : 'cm-signal-pill is-active';
    const signalText = lastSignal.status === 'blocked' ? 'S1 (ข้าม)' : '🔥 S1 LIVE';
    const signalTitle = lastSignal.status === 'blocked'
      ? `S1 ติดที่แท่งล่าสุด แต่ถูกบล็อก: ${lastSignal.blockedReasons.map(r => r.text).join(' · ')}`
      : `S1 ติดที่แท่งล่าสุด — บอทกำลังเข้า BUY`;
    html += `<span class="${signalPillClass}" title="${escapeHtml(signalTitle)}">${signalText}</span>`;
  }
  // Blocked badges
  if (blockedReasons.length > 0) {
    html += `<div class="cm-blocked-row">${blockedReasons.map((r) => {
      return `<span class="cm-blocked-pill kind-${r.kind}" title="${escapeHtml(r.text)}">${escapeHtml(r.text)}</span>`;
    }).join('')}</div>`;
  }
  rowEl.innerHTML = html;
}

function clearCmExpandTpLines() {
  if (!_cmExpandChart || !_cmExpandChart.candleSeries) return;
  if (Array.isArray(_cmExpandChart.tpPriceLines)) {
    for (const line of _cmExpandChart.tpPriceLines) {
      try { _cmExpandChart.candleSeries.removePriceLine(line); } catch (_) {}
    }
  }
  _cmExpandChart.tpPriceLines = [];
}

function drawCmExpandTpLines() {
  if (!_cmExpandChart || !_cmExpandChart.candleSeries) return;
  clearCmExpandTpLines();
  const botId = _cmExpandChart.botId;
  const positions = _cmPositionsByBot.get(String(botId)) || [];
  if (positions.length === 0) return;
  const sym = _cmExpandChart.symbol;
  const valid = positions.filter((p) =>
    p.symbol === sym
    && Number.isFinite(Number(p.targetSellPrice))
    && Number(p.targetSellPrice) > 0);
  if (valid.length === 0) return;
  const MAX_LINES = 4;
  const shown = valid.slice(0, MAX_LINES);
  // 2026-08-06: TP lines = blue (#3b82f6) — switched from yellow after user feedback
  //   was: '#f5b800' (gold) → '#3b82f6' (blue) for clear contrast vs KC bands
  const TP_LINE_COLOR = '#3b82f6';
  shown.forEach((p, idx) => {
    const tp = Number(p.targetSellPrice);
    const title = valid.length > MAX_LINES && idx === MAX_LINES - 1
      ? `TP (+${valid.length - MAX_LINES + 1} more)`
      : 'TP';
    try {
      const line = _cmExpandChart.candleSeries.createPriceLine({
        price: tp,
        color: TP_LINE_COLOR,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title,
      });
      _cmExpandChart.tpPriceLines.push(line);
    } catch (err) {
      console.debug(`expand TP line draw failed for ${botId}/${p.symbol}:`, err.message);
    }
  });
}

function teardownCmExpandChart() {
  if (!_cmExpandChart) return;
  try { if (_cmExpandChart.ro) _cmExpandChart.ro.disconnect(); } catch (_) {}
  try { if (_cmExpandChart.chart) _cmExpandChart.chart.remove(); } catch (_) {}
  _cmExpandChart = null;
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
 * Mini-chart grid card — collapse/expand (2026-09-06)
 *   - mirror cm-positions-card UX (clickable header + ▾ toggle button)
 *   - default state: EXPANDED (mini-charts are the main content of this page)
 *   - state persisted in localStorage so user choice sticks across reloads
 * ════════════════════════════════════════════════════════════════════ */
const CM_GRID_COLLAPSE_KEY = 'cm.grid.collapsed.v1';
function initCmGridCollapse() {
  const card = document.getElementById('cm-grid-card');
  const header = document.getElementById('cm-grid-header');
  if (!card || !header) return;
  let collapsed = false;
  try {
    const stored = localStorage.getItem(CM_GRID_COLLAPSE_KEY);
    if (stored === '0' || stored === '1') collapsed = stored === '1';
  } catch (_) { /* localStorage unavailable */ }
  const apply = () => {
    card.classList.toggle('is-collapsed', collapsed);
  };
  apply();
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    apply();
    try { localStorage.setItem(CM_GRID_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (_) {}
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
        <div class="pnl-modal-net-label">Net PnL <span class="pnl-modal-net-hint" title="ผลรวมสุทธิ: กำไร − ขาดทุน (Net = Gross Profit + Gross Loss)">✓ Net</span></div>
        <span class="pnl-modal-main-pnl ${totalSignCls}">${formatUsdtPnl(total)} <span class="unit">USDT</span></span>
        ${thb != null ? `<span class="pnl-modal-thb ${totalSignCls}">≈ ${thb >= 0 ? '+' : ''}฿${formatThbInlinePnl(thb)}</span>` : '<span class="muted">FX ไม่พร้อม</span>'}
      </div>
      <div class="pnl-modal-gl-row">
        <span class="pnl-modal-gl-prefix" title="Gross Profit / Gross Loss — แยกตามทิศทางของไม้ (ไม่หักลบกัน)">แยกตามทิศทาง:</span>
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
    // stash for column-toggle re-render + update count badge
    _cmPnlModalOverlay._lastTrades = data.trades || [];
    const countEl = overlay.querySelector('#cm-pnl-col-count');
    if (countEl) {
      const visibleIds = window.PnlModalColumns.loadVisibleColumns();
      const total = window.PnlModalColumns.COLUMN_DEFS.length;
      countEl.textContent = `${visibleIds.length}/${total}`;
    }
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
  // FIX-2026-08-09 (rev2): delegate to shared module — same as pnl.html modal
  //   - entry/exit prices now come from t.entryPrice/t.exitPrice (set by pnl.routes.js from buyPrice/sellAvgPrice)
  //   - entry/exit qty columns available
  //   - column toggle UI in modal header (shared localStorage key with pnl.html)
  const table = window.PnlModalColumns.buildTableHtml(trades, {
    escHtml: escapeHtml,
    formatUsdt: formatUsdtPnl,
    formatThbInline: formatThbInlinePnl,
  });
  container.innerHTML = `<table class="pnl-modal-table">${table.html}</table>`;
}

function buildCmPnlModalSkeleton() {
  const overlay = document.createElement('div');
  overlay.className = 'pnl-modal-overlay';
  overlay.innerHTML = `
    <div class="pnl-modal-card">
      <div class="pnl-modal-header">
        <h5 id="cm-pnl-modal-title">—</h5>
        <div class="pnl-modal-actions">
          <button type="button" id="cm-pnl-col-toggle" class="pnl-col-toggle-btn" aria-label="เลือกคอลัมน์">
            <span>⚙️ คอลัมน์</span>
            <span class="count" id="cm-pnl-col-count">—</span>
          </button>
          <button type="button" class="pnl-modal-close" aria-label="ปิด">✕</button>
        </div>
        <div id="cm-pnl-col-menu" class="pnl-col-menu" style="display:none;"></div>
      </div>
      <div id="cm-pnl-modal-total" class="pnl-modal-total"></div>
      <div id="cm-pnl-modal-body" class="pnl-modal-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('.pnl-modal-close').addEventListener('click', () => overlay.classList.remove('is-open'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('is-open'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.classList.remove('is-open'); });

  // FIX-2026-08-09 (rev2): column toggle handler — shared with pnl.html
  const toggleBtn = overlay.querySelector('#cm-pnl-col-toggle');
  const menu = overlay.querySelector('#cm-pnl-col-menu');
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.style.display === 'none') {
      renderCmColumnMenu(menu);
      menu.style.display = 'block';
    } else {
      menu.style.display = 'none';
    }
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== toggleBtn && !toggleBtn.contains(e.target)) {
      menu.style.display = 'none';
    }
  });
  _cmPnlModalOverlay = overlay;
}

function renderCmColumnMenu(menu) {
  const onChange = () => {
    const body = _cmPnlModalOverlay.querySelector('#cm-pnl-modal-body');
    if (body && _cmPnlModalOverlay._lastTrades) {
      renderCmPnlModalTrades(body, _cmPnlModalOverlay._lastTrades);
    }
    const countEl = _cmPnlModalOverlay.querySelector('#cm-pnl-col-count');
    if (countEl) {
      const visibleIds = window.PnlModalColumns.loadVisibleColumns();
      const total = window.PnlModalColumns.COLUMN_DEFS.length;
      countEl.textContent = `${visibleIds.length}/${total}`;
    }
  };
  window.PnlModalColumns.renderColumnMenu(menu, onChange);
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
  // 2026-09-06: also update the count badge in the new collapsible mini-chart header
  const gridCountEl = document.getElementById('cm-grid-count');
  if (gridCountEl) gridCountEl.textContent = sorted.length;

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
    // fallback: IO unavailable — enqueue all (cap protects us from a spike)
    grid.querySelectorAll('.cm-minichart[data-bot-id]').forEach((el) => {
      _enqueueCmMiniChart(el.dataset.botId, el);
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
        <button type="button" class="cm-card-expand" data-bot-id="${b._id}" data-action="expand-chart" title="เปิดขยาย (500 แท่ง, โหลดเพิ่มได้)" aria-label="เปิดขยาย">🔍</button>
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
    // 2026-09-06: per user request — sort by held positions desc, then running before stopped
    //   Priority:
    //     1) activePositionsCount desc (จำนวนไม้ที่ถือ มาก→น้อย)
    //     2) enabled desc (running → stopped)
    //   Tie-breaker: totalCapital desc, then createdAt desc (matches old behavior)
    copy.sort((a, b) => {
      const pa = (a.activePositionsCount || 0);
      const pb = (b.activePositionsCount || 0);
      if (pb !== pa) return pb - pa;
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
      _enqueueCmMiniChart(botId, el);
    }
  }
}

// FIX-2026-08-23: FIFO worker queue with concurrency cap.
//   - At most _CM_MAX_CONCURRENT_CHARTS (3) mini-chart loads in-flight at once.
//   - Cards still load in viewport order; off-screen cards wait their turn.
//   - Prevents 50+ concurrent /api/bots/:id/mini-chart requests when user scrolls fast.
function _enqueueCmMiniChart(botId, el) {
  if (_cmChartInFlight.has(botId) || _cmChartQueue.some((q) => q.botId === botId)) return;
  _cmChartQueue.push({ botId, el });
  _drainCmChartQueue();
}

function _drainCmChartQueue() {
  while (_cmChartInFlight.size < _CM_MAX_CONCURRENT_CHARTS && _cmChartQueue.length > 0) {
    const { botId, el } = _cmChartQueue.shift();
    _cmChartInFlight.add(botId);
    loadCmMiniChart(botId, el, el.dataset.symbol, el.dataset.timeframe)
      .catch((err) => {
        console.warn(`chart-monitor mini-chart ${botId}:`, err);
        el.innerHTML = `<div class="cm-minichart-error">⚠️ โหลดไม่สำเร็จ</div>`;
      })
      .finally(() => {
        _cmChartInFlight.delete(botId);
        _drainCmChartQueue();
      });
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

  // FIX-2026-08-23: skip 120s polling when there's nothing to refresh — saves N concurrent
  //   /api/bots/:id/mini-chart calls every 2 minutes for bots with no S1/position activity.
  //   - WS kline:update already keeps the live candle current (no polling needed for that)
  //   - Polling only needed when markers or TP lines can change
  const hasS1Markers = s1Markers.length > 0;
  const hasPosition = (_cmPositionsByBot.get(String(botId)) || []).some((p) =>
    p.symbol === symbol && Number.isFinite(Number(p.targetSellPrice)) && Number(p.targetSellPrice) > 0);
  if (!hasS1Markers && !hasPosition) {
    // Nothing to refresh — let WS handle live candle updates
    return;
  }

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
  // 2026-08-06: TP lines = blue (#3b82f6) — switched from yellow after user feedback
  //   was: '#f5b800' (gold) → '#3b82f6' (blue) for clear contrast vs KC bands
  const TP_LINE_COLOR = '#3b82f6';
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
    // 2026-08-06: also update expand modal chart if open
    if (_cmExpandChart && _cmExpandChart.chart && _cmExpandChart.symbol === p.symbol && _cmExpandChart.timeframe === p.interval) {
      const k = p.kline;
      const t = Math.floor(k.openTime / 1000);
      try {
        _cmExpandChart.candleSeries.update({
          time: t,
          open: parseFloat(k.open),
          high: parseFloat(k.high),
          low: parseFloat(k.low),
          close: parseFloat(k.close),
        });
      } catch (_) { /* candle not in series (e.g. past load limit) — ignore */ }
    }
  });

  // When a bot's status changes (start/stop), refresh the grid to update pills
  // FIX-2026-08-23: coalesce loadBots+loadSignals into a single debounced renderGrid
  //   (both functions independently called renderGrid before → 2× full teardown per event)
  WSClient.on('bot:status', () => {
    Promise.all([
      loadBots().catch((e) => console.debug('chart-monitor bot:status refresh:', e.message)),
      loadSignals().catch((e) => console.debug('chart-monitor signals refresh:', e.message)),
    ]).then(() => scheduleRenderGrid());
  });
  WSClient.on('trade:update', (p) => {
    // FIX-2026-08-23: refresh only the affected bot's chart, not all of them.
    //   trade:update payload includes botId (confirmed in src/core/botManager.js:678,
    //   src/core/forceClose.js:438, etc.) — fallback to "refresh all" if botId is absent.
    const targetBotId = p && p.botId ? String(p.botId) : null;
    if (targetBotId && _cmMiniCharts.has(targetBotId)) {
      refreshCmMiniChart(targetBotId).catch((e) => console.debug(`chart-monitor trade:update ${targetBotId}:`, e.message));
    } else if (!targetBotId) {
      // Legacy event without botId — refresh all (safe fallback)
      for (const botId of _cmMiniCharts.keys()) {
        refreshCmMiniChart(botId).catch((e) => console.debug(`chart-monitor trade:update ${botId}:`, e.message));
      }
    }
    // 2026-08-06: positions panel also reacts to trade updates (BUY/SELL fired)
    loadCmPositions().catch((e) => console.debug('chart-monitor positions trade:update:', e.message));
    // 2026-08-06: redraw TP lines on expand modal if open
    if (_cmExpandChart && _cmExpandChart.chart) {
      setTimeout(() => drawCmExpandTpLines(), 0);
    }
  });
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
 * 50 latest signals panel — top 50 most recent S1 signals across all running bots
 * 2026-08-20: each row now shows the SIGNAL ACTION (DB outcome + note):
 *   - filled / order_placed (trade opened)
 *   - skipped: maxTrades, safe_trade_block, safetrade (ST#1/ST#2/ST#3),
 *              cbv5_pre_buy_block / cb_suppress / cbv2/v3/v5_cooldown,
 *              buy_in_flight, cooldown_*, symbol_delisted, dca_*
 *   - expired: retry max / spread tight / rePlace rejected
 *   - failed: validation error / hard failures
 *   - pending: detected but not yet decided (warm-up, cache-cold)
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
    // 2026-08-20: action badge (filled / safetrade / retry max / เงินไม่พอ / ...)
    const action = formatSignalAction(s);
    const actionHtml = action
      ? `<div class="cm-ls-action-row"><span class="cm-ls-action ${action.cls}" title="${escapeHtml(action.title)}">${escapeHtml(action.label)}</span>${action.tradeLink}</div>`
      : '';
    return `
      <div class="cm-ls-row ${statusCls}" data-bot-id="${escapeHtml(s.botId || '')}" role="link" tabindex="0" title="คลิกเพื่อเปิดหน้า bot-detail">
        <div class="cm-ls-left">
          <span class="cm-ls-status">${statusIcon}</span>
          <div class="cm-ls-body">
            <div class="cm-ls-bot">${escapeHtml(s.name)} <span class="cm-ls-meta">${escapeHtml(s.symbol)} · ${escapeHtml(s.timeframe)}</span><span class="cm-ls-arrow" aria-hidden="true">↗</span></div>
            <div class="cm-ls-time">${ageTxt} · bg ${s.bgPrev}→${s.bgState}</div>
            ${dtTxt ? `<div class="cm-ls-datetime">📅 ${dtTxt}</div>` : ''}
            ${actionHtml}
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

/* 2026-08-24: delegated click handler — click row → open bot-detail.html?id=<botId>
 *   - Same URL pattern as the per-card "📊 Detail →" link (bots.js:1945, chart-monitor.js:1287)
 *   - Skip clicks on the inline "cm-ls-trade-link" anchor (it already opens /history.html in new tab)
 *   - Keyboard accessible: Enter / Space on a focused row also navigates
 *   - Bound once at module load (NOT inside renderLatestSignalsPanel) so we don't re-bind on every refresh
 */
(function bindCmLatestSignalsNav() {
  const panel = document.getElementById('cm-latest-signals');
  if (!panel || panel.__cmNavBound) return;
  panel.__cmNavBound = true;
  panel.addEventListener('click', (e) => {
    // Don't hijack clicks on inline links (e.g. → trade to /history.html)
    if (e.target.closest('a')) return;
    const row = e.target.closest('.cm-ls-row');
    if (!row) return;
    const botId = row.getAttribute('data-bot-id');
    if (!botId) return;
    window.location.href = `/bot-detail.html?id=${encodeURIComponent(botId)}`;
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('a')) return;
    const row = e.target.closest('.cm-ls-row');
    if (!row) return;
    e.preventDefault();
    const botId = row.getAttribute('data-bot-id');
    if (!botId) return;
    window.location.href = `/bot-detail.html?id=${encodeURIComponent(botId)}`;
  });
})();

/* 2026-08-20: map (outcome + note) → {cls, label, title, tradeLink}
 *   - `cls`  = "is-filled" / "is-skipped" / "is-expired" / "is-failed" / "is-pending" / ...
 *   - `label` = short pill text ("filled", "safe-trade #1", "retry max", "เงินไม่พอ", ...)
 *   - `title` = tooltip with the full `note` text (good for debugging)
 *   - `tradeLink` = optional "→ trade" anchor if a tradeId is present (filled/order_placed rows)
 *
 * 2026-08-20 rev2: when no DB row exists for a non-blocked signal, distinguish:
 *   - FRESH candle (closeTime + 90s > now) → "⏳ pending" (trader เขียน DB อยู่)
 *   - PAST candle (เกิน timeframe + grace)  → "❓ ไม่มีบันทึก" (historical scan, trader ไม่ process)
 *   - เดิมแสดง "⏳ pending" ทั้งคู่ ทำให้สับสน
 */
function formatSignalAction(s) {
  if (!s) return null;
  const tradeId = s.tradeId || null;
  const note = (s.outcomeNote || '').toString().trim();

  // ─── Derive outcome (with smarter non-DB fallback) ───
  let outcome = s.outcome || null;
  // FIX-2026-09-05: stale-detected upgrade.
  //   - 'detected' เป็น transient state (save ตอนเจอ S1 ก่อน gate chain ทำงาน)
  //   - ปกติจะถูก update เป็น skipped/filled/failed ภายในไม่กี่วินาที
  //   - ถ้า candle close เกิน threshold แล้วยังเป็น detected = "stale"
  //     แสดงว่า trader crash ก่อน update หรือ gate exception
  //   - threshold = max(5min, 2× timeframe) เพื่อรองรับ 1h/4h TF ที่ต้องใช้เวลานาน
  let isStaleDetected = false;
  if (outcome === 'detected' && s.openTime) {
    const openMs = Number(s.openTime) || 0;
    const tfMs = timeframeToMs(s.timeframe);
    const closeMs = openMs + tfMs;
    const staleMs = Math.max(5 * 60_000, 2 * tfMs);
    if (Date.now() > closeMs + staleMs) {
      isStaleDetected = true;
      outcome = 'stale_detected';
    }
  }
  if (!outcome) {
    // No DB row → classify by in-memory status + candle age
    if (s.status === 'blocked') {
      outcome = 'skipped_predicted';
    } else {
      // Compute candleCloseTime = openTime + timeframeMs
      const openTime = Number(s.openTime) || 0;
      const tfMs = timeframeToMs(s.timeframe);
      const closeTime = openTime + tfMs;
      const now = Date.now();
      const FRESH_GRACE_MS = 90_000; // 90s after candle close
      if (closeTime + FRESH_GRACE_MS > now) {
        outcome = 'pending'; // trader ยังไม่ทันเขียน DB
      } else {
        outcome = 'no_audit'; // trader ไม่เคย process (historical)
      }
    }
  }

  // Build the trade link if applicable
  let tradeLink = '';
  if (tradeId && (outcome === 'filled' || outcome === 'order_placed')) {
    const last8 = tradeId.slice(-8);
    tradeLink = ` <a class="cm-ls-trade-link" href="/history.html?trade=${encodeURIComponent(tradeId)}" target="_blank" rel="noopener" title="เปิดไม้ในหน้า History">${last8} →</a>`;
  }

  // 1) outcome → base (cls, label)
  // FIX-2026-09-05: detected label now reflects transient state (was '🎯 detected' — ทำให้ user
  //   เข้าใจผิดว่าเป็น final outcome). stale_detected ใหม่สำหรับ rows ที่ note='awaiting_gate_evaluation'
  //   นานเกิน threshold = trader crash / gate exception
  const OUTCOME_BASE = {
    filled:            { cls: 'is-filled',            label: '✅ filled' },
    order_placed:      { cls: 'is-order_placed',      label: '📤 order_placed' },
    skipped:           { cls: 'is-skipped',           label: '⏭ skipped' },
    skipped_predicted: { cls: 'is-skipped_predicted', label: '⏭ predicted skip' },
    expired:           { cls: 'is-expired',           label: '⌛ expired' },
    failed:            { cls: 'is-failed',            label: '❌ failed' },
    detected:          { cls: 'is-detected',          label: '⏳ กำลังประมวลผล' },
    stale_detected:    { cls: 'is-stale-detected',    label: '⚠️ stuck — gate ไม่อัปเดต' },
    pending:           { cls: 'is-pending',           label: '⏳ pending' },
    no_audit:          { cls: 'is-no-audit',          label: '❓ ไม่มีบันทึก' },
  };

  // 2) note→label overrides (carry the friendly reason)
  const NOTE_TO_LABEL = [
    { match: /^retryMax.*reached/i,           label: '🔁 retry max' },
    { match: /^spread too tight/i,             label: '↔️ spread tight' },
    { match: /^rePlace rejected/i,             label: '🚫 rePlace reject' },
    { match: /^maxTrades reached/i,            label: '🚦 maxTrades' },
    { match: /^safe_trade_block/i,             label: '🛡 safe-trade #1' },
    { match: /^safe_trade_trendline_block/i,   label: '📈 trendline (ST#2)' },
    { match: /^safe_trade_no_trade_block/i,    label: '🚫 no-trade (ST#3)' },
    { match: /^cbv5_pre_buy_block/i,           label: '🔐 CBv5 pre-buy' },
    { match: /^cb_suppress/i,                  label: '🔐 CB suppress' },
    { match: /^cbv2_cooldown/i,                label: '🔐 CBv2 cooldown' },
    { match: /^cbv3_cooldown/i,                label: '🔐 CBv3 cooldown' },
    { match: /^cbv5_cooldown/i,                label: '🔐 CBv5 cooldown' },
    { match: /^buy_in_flight/i,                label: '🔄 BUY in flight' },
    { match: /^cooldown_/i,                    label: '⏳ cooldown' },
    { match: /^symbol_delisted/i,              label: '🚫 delisted' },
    { match: /^delist_in_\d+d/i,               label: '⚠️ delist soon' },
    { match: /^dca_max_layers/i,               label: '🧱 DCA max layer' },
    { match: /^dca_buy_in_flight/i,            label: '🧱 DCA in flight' },
    { match: /^dca_claim_lost/i,               label: '🧱 DCA claim lost' },
    { match: /^insufficient USDT balance/i,    label: '💸 เงินไม่พอ' },
  ];

  const base = OUTCOME_BASE[outcome] || { cls: 'is-no-audit', label: outcome };
  let finalLabel = base.label;
  if (note) {
    for (const rule of NOTE_TO_LABEL) {
      if (rule.match.test(note)) { finalLabel = rule.label; break; }
    }
  }

  // Compose title — show note + raw outcome + (when no_audit) explanation
  const titleParts = [`outcome: ${outcome}`];
  if (note) titleParts.push(note);
  if (tradeId) titleParts.push(`trade: ${tradeId}`);
  if (outcome === 'stale_detected') {
    // FIX-2026-09-05: explain why a detected-row is flagged stuck so users understand
    //   โดยไม่ต้องเปิด pm2 logs
    titleParts.push('— candle close เกิน max(5min, 2×TF) แล้ว แต่ outcome ยังไม่เปลี่ยน');
    titleParts.push('— สาเหตุที่พบบ่อย: trader crash / gate exception / DLC await throw');
    titleParts.push('— ดู pm2 logs ช่วงเวลานั้น + restart trader ถ้าจำเป็น');
  } else if (outcome === 'no_audit') {
    titleParts.push('— scan เจอ S1 แต่ trader ไม่เคย process แท่งนี้ (historical scanner)');
  } else if (outcome === 'pending') {
    titleParts.push('— trader กำลัง process อยู่ รอสักครู่');
  } else if (outcome === 'skipped_predicted') {
    titleParts.push('— in-memory block (DB row pending / ไม่เคยเขียน)');
  } else if (outcome === 'detected' && note === 'awaiting_gate_evaluation') {
    // FIX-2026-09-05: fresh detected = transient state รอ gate chain
    titleParts.push('— transient state: กำลัง evaluate DLC / AutoTiming / ST#1-3 / CBv5');
    titleParts.push('— จะถูก update เป็น skipped/filled/failed ภายในไม่กี่วินาที');
  }
  const title = titleParts.join('\n');

  return { cls: base.cls, label: finalLabel, title, tradeLink };
}

// Helper: timeframe string → milliseconds (used to classify fresh vs past signals)
function timeframeToMs(tf) {
  if (!tf) return 60_000;
  const m = String(tf).match(/^(\d+)([mhd])$/);
  if (!m) return 60_000;
  const n = parseInt(m[1], 10);
  if (m[2] === 'm') return n * 60_000;
  if (m[2] === 'h') return n * 60 * 60_000;
  if (m[2] === 'd') return n * 24 * 60 * 60_000;
  return 60_000;
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
