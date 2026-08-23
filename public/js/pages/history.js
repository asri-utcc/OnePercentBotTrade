'use strict';

// FIX-2026-07-24: Trade + Signal history page
//   - 3 tabs: Trades / Signals / Both
//   - Filter: bot dropdown, date range (default today)
//   - Filter (FIX-2026-07-24 +): chip multi-select สำหรับ trade state + signal outcome
//   - Default: hide failed/cancelled/skipped (sane defaults ตามที่ user ขอ)
//   - Quick action: "All" / "Hide failed" buttons
//   - Daily stats: trades count + wins/losses + pnl + skipped signals (refresh ทุก 60s)
//   - Mobile: detect <768px → mob-card list
//   - Signals filter = currently-enabled bots (per backend)

const TRADE_STATES = ['placed', 'partial_wait', 'filled', 'retrying', 'cancelled', 'holding', 'stopping', 'selling', 'partial_sell_wait', 'sold', 'failed'];
const SIGNAL_OUTCOMES = ['detected', 'order_placed', 'filled', 'expired', 'failed', 'skipped'];
// FIX-2026-07-24: mirror backend default — เก็บในตัวแปรเพื่อให้ "Hide failed" ทำงานถูก
const DEFAULT_HIDE_TRADE = ['failed', 'cancelled'];
const DEFAULT_HIDE_SIGNAL = ['failed', 'skipped'];

let state = {
  kind: 'both',
  botId: '',
  from: todayISO(),
  to: todayISO(),
  // FIX-2026-07-24: filter state — null = ใช้ backend default
  tradeStates: null,    // null | Set<string> | 'all' (string sentinel)
  signalOutcomes: null, // null | Set<string> | 'all'
};
let bots = [];

// FIX-2026-08-02: %PnL helper — realized / (buyPrice * buyQty) * 100
//   - ใช้ buyPrice * buyQty (notional ตอนซื้อ) เป็น baseline
//   - ถ้า buyPrice/buyQty ไม่ครบ → คืน NaN (UI แสดง —)
//   - ใช้ได้ทั้ง trades table + mobile card + 'all' view
function pnlPctOf(t) {
  const buyPrice = Number(t && t.buyPrice);
  const buyQty = Number(t && t.buyQty);
  const realized = Number(t && t.realizedPnl);
  if (!Number.isFinite(buyPrice) || !Number.isFinite(buyQty) || buyQty <= 0) return NaN;
  if (!Number.isFinite(realized)) return NaN;
  return (realized / (buyPrice * buyQty)) * 100;
}

function pnlPctClass(p) {
  return p > 0.0001 ? 'text-success' : p < -0.0001 ? 'text-danger' : '';
}

function pnlPctStr(p) {
  return Number.isFinite(p) ? (p >= 0 ? '+' : '') + p.toFixed(2) + '%' : '—';
}
let statsTimer = null;
let loadTimer = null;

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function init() {
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me || !me.authenticated) {
    location.href = '/login.html';
    return;
  }
  // FIX-2026-07-31: preload tickSize cache ก่อน — ZILUSDT ต้องแสดง 6 dp ไม่ใช่ 4
  await window.PriceFormat.load().catch(() => {});
  renderSkeleton();
  await Promise.all([loadBots(), loadStats(), loadHistory()]);
  statsTimer = setInterval(loadStats, 60000);
}

function renderSkeleton() {
  const isMobile = window.matchMedia('(max-width:768px)').matches;
  document.getElementById('history-content').innerHTML = `
    <div class="lux-header">
      <span class="title">📊 ประวัติการเทรด + สัญญาณ</span>
    </div>
    <div class="lux-body">

      <!-- Tabs -->
      <div class="lux-tabs mb-3" role="tablist">
        <button class="lux-tab ${state.kind === 'trades' ? 'active' : ''}" data-kind="trades" type="button">📈 Trades</button>
        <button class="lux-tab ${state.kind === 'signals' ? 'active' : ''}" data-kind="signals" type="button">📡 Signals</button>
        <button class="lux-tab ${state.kind === 'both' ? 'active' : ''}" data-kind="both" type="button">🔀 Both</button>
      </div>

      <!-- Filters -->
      <div class="row g-2 mb-3 align-items-end">
        <div class="col-md-4 col-12">
          <label class="form-label small text-muted">Bot</label>
          <select class="form-select form-select-sm" id="f-bot">
            <option value="">ทุกบอท (enabled)</option>
          </select>
        </div>
        <div class="col-md-3 col-6">
          <label class="form-label small text-muted">From</label>
          <input type="date" class="form-control form-control-sm" id="f-from" value="${state.from}" />
        </div>
        <div class="col-md-3 col-6">
          <label class="form-label small text-muted">To</label>
          <input type="date" class="form-control form-control-sm" id="f-to" value="${state.to}" />
        </div>
        <div class="col-md-2 col-12">
          <button type="button" class="btn btn-sm btn-primary w-100" id="btn-refresh">🔄 Refresh</button>
        </div>
      </div>

      <!-- FIX-2026-07-24: state/outcome filter chips (per-kind, swap on tab change) -->
      <div class="filter-chips-wrap mb-3" id="filter-chips">
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="text-muted small">Filter:</span>
          <button type="button" class="chip-quick ${state.tradeStates === 'all' || state.signalOutcomes === 'all' ? '' : 'active'}" data-quick="default" title="ซ่อน failed/cancelled/skipped">✂️ Hide failed</button>
          <button type="button" class="chip-quick ${state.tradeStates === 'all' || state.signalOutcomes === 'all' ? 'active' : ''}" data-quick="all" title="แสดงทั้งหมด">🌐 All</button>
          <div id="chip-trade-states" class="d-inline-flex flex-wrap gap-1 ms-2"></div>
          <div id="chip-signal-outcomes" class="d-inline-flex flex-wrap gap-1 ms-2"></div>
          <span class="text-muted small ms-auto" id="filter-meta"></span>
        </div>
      </div>

      <!-- Table (desktop) -->
      ${isMobile ? '' : `
      <div class="lux-table-wrap">
        <table class="lux-table">
          <thead><tr id="th-row"></tr></thead>
          <tbody id="history-tbody"></tbody>
        </table>
      </div>`}

      <!-- Cards (mobile) -->
      <div class="mob-card-list" id="history-cards" style="${isMobile ? '' : 'display:none;'}"></div>

      <div class="text-muted small mt-3" id="meta"></div>
    </div>
  `;

  // Bind events
  document.querySelectorAll('.lux-tab').forEach((b) => {
    b.onclick = () => {
      state.kind = b.dataset.kind;
      renderSkeleton();
      debouncedLoadHistory();
    };
  });
  document.getElementById('f-bot').onchange = (e) => { state.botId = e.target.value; debouncedLoadHistory(); };
  document.getElementById('f-from').onchange = (e) => { state.from = e.target.value; debouncedLoadHistory(); };
  document.getElementById('f-to').onchange = (e) => { state.to = e.target.value; debouncedLoadHistory(); };
  document.getElementById('btn-refresh').onclick = () => { loadHistory(); loadStats(); };
  // FIX-2026-07-24: quick action chips
  document.querySelectorAll('.chip-quick').forEach((b) => {
    b.onclick = () => {
      const q = b.dataset.quick;
      if (q === 'all') {
        state.tradeStates = 'all';
        state.signalOutcomes = 'all';
      } else {
        // 'default' = null → backend default
        state.tradeStates = null;
        state.signalOutcomes = null;
      }
      renderChips();
      debouncedLoadHistory();
    };
  });
  window.addEventListener('resize', onResize, { passive: true });
  renderChips();
}

// FIX-2026-07-24: render chip group ตาม tab ที่ active
//   - trades/both  → trade state chips
//   - signals/both → signal outcome chips
//   - both         → ทั้งสอง group (สลับ active ตาม state.kind ของแต่ละ kind)
function renderChips() {
  const tradeWrap = document.getElementById('chip-trade-states');
  const signalWrap = document.getElementById('chip-signal-outcomes');
  if (!tradeWrap || !signalWrap) return;
  // helper: หา set ที่ active
  const getActive = (val, defaultList) => {
    if (val === 'all') return new Set(TRADE_STATES); // sentinel 'all' ใช้กับทุก list
    if (val === null) return new Set(defaultList);
    if (val instanceof Set) return val;
    return new Set(defaultList);
  };
  const activeTrade = getActive(state.tradeStates, TRADE_STATES.filter((s) => !DEFAULT_HIDE_TRADE.includes(s)));
  const activeSignal = getActive(state.signalOutcomes, SIGNAL_OUTCOMES.filter((s) => !DEFAULT_HIDE_SIGNAL.includes(s)));

  const renderGroup = (wrap, list, active, onClick) => {
    wrap.innerHTML = list.map((v) => {
      const on = active.has(v);
      const isDefault = (state.tradeStates === null || state.signalOutcomes === null);
      // ถ้า default mode และ chip นี้อยู่ใน default-hide list → แสดง muted
      const isHiddenByDefault = (on === false) && isDefault;
      return `<button type="button" class="chip ${on ? 'active' : ''} ${isHiddenByDefault ? 'muted' : ''}" data-val="${v}">${escapeHtml(v)}</button>`;
    }).join('');
    wrap.querySelectorAll('.chip').forEach((b) => {
      b.onclick = () => onClick(b.dataset.val);
    });
  };

  // trade states chips
  if (state.kind === 'trades' || state.kind === 'both') {
    renderGroup(tradeWrap, TRADE_STATES, activeTrade, (v) => {
      // toggle chip ใน active set
      if (state.tradeStates === 'all') {
        // เริ่มจาก all → เอาออก 1 ตัว → ได้ Set
        const next = new Set(TRADE_STATES);
        next.delete(v);
        state.tradeStates = next;
      } else {
        const cur = state.tradeStates instanceof Set ? new Set(state.tradeStates) : new Set(TRADE_STATES.filter((s) => !DEFAULT_HIDE_TRADE.includes(s)));
        if (cur.has(v)) cur.delete(v);
        else cur.add(v);
        state.tradeStates = cur;
      }
      renderChips();
      debouncedLoadHistory();
    });
    tradeWrap.style.display = '';
  } else {
    tradeWrap.style.display = 'none';
  }

  // signal outcomes chips
  if (state.kind === 'signals' || state.kind === 'both') {
    renderGroup(signalWrap, SIGNAL_OUTCOMES, activeSignal, (v) => {
      if (state.signalOutcomes === 'all') {
        const next = new Set(SIGNAL_OUTCOMES);
        next.delete(v);
        state.signalOutcomes = next;
      } else {
        const cur = state.signalOutcomes instanceof Set ? new Set(state.signalOutcomes) : new Set(SIGNAL_OUTCOMES.filter((s) => !DEFAULT_HIDE_SIGNAL.includes(s)));
        if (cur.has(v)) cur.delete(v);
        else cur.add(v);
        state.signalOutcomes = nextSafeSignal(v, cur);
      }
      renderChips();
      debouncedLoadHistory();
    });
    signalWrap.style.display = '';
  } else {
    signalWrap.style.display = 'none';
  }

  // update quick button active state
  const isAll = state.tradeStates === 'all' || state.signalOutcomes === 'all';
  const isDefault = state.tradeStates === null && state.signalOutcomes === null;
  document.querySelectorAll('.chip-quick').forEach((b) => {
    const q = b.dataset.quick;
    if (q === 'all') b.classList.toggle('active', isAll);
    else b.classList.toggle('active', isDefault);
  });
}

// FIX-2026-07-24: helper กันพลาด — return Set ที่ถูกต้อง
function nextSafeSignal(v, cur) {
  if (cur.has(v)) cur.delete(v);
  else cur.add(v);
  return cur;
}

function onResize() {
  // simple re-render ถ้า mobile state เปลี่ยน
  const isMobile = window.matchMedia('(max-width:768px)').matches;
  const tableWrap = document.querySelector('.lux-table-wrap');
  const cardsWrap = document.getElementById('history-cards');
  if (!tableWrap || !cardsWrap) return;
  if (isMobile) {
    tableWrap.style.display = 'none';
    cardsWrap.style.display = '';
  } else {
    tableWrap.style.display = '';
    cardsWrap.style.display = 'none';
  }
}

function debouncedLoadHistory() {
  if (loadTimer) clearTimeout(loadTimer);
  loadTimer = setTimeout(() => loadHistory(), 250);
}

async function loadBots() {
  try {
    const resp = await API.get('/api/bots?limit=500');
    bots = resp.bots || [];
    const sel = document.getElementById('f-bot');
    if (!sel) return;
    bots.forEach((b) => {
      const opt = document.createElement('option');
      opt.value = b._id;
      opt.textContent = `${b.enabled ? '🟢' : '⚪'} ${b.name || b.symbol}`;
      sel.appendChild(opt);
    });
  } catch (err) {
    console.error('loadBots failed:', err);
  }
}

async function loadStats() {
  try {
    const stats = await API.get(`/api/history/stats?date=${state.from}`);
    document.getElementById('stat-trades').textContent = stats.trades.count;
    document.getElementById('stat-wl').textContent = `${stats.trades.wins} / ${stats.trades.losses}`;
    const pnlEl = document.getElementById('stat-pnl');
    const pnl = Number(stats.trades.pnl) || 0;
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(4);
    pnlEl.className = 'v ' + (pnl > 0 ? 'text-success' : pnl < 0 ? 'text-danger' : '');
    document.getElementById('stat-skip').textContent = stats.signals.skipped;
  } catch (err) {
    console.error('loadStats failed:', err);
  }
}

async function loadHistory() {
  try {
    const params = new URLSearchParams({
      kind: state.kind,
      from: state.from,
      to: state.to,
      limit: '200',
    });
    if (state.botId) params.set('botId', state.botId);
    // FIX-2026-07-24: ส่ง filter CSV
    //   - 'all' → tradeStates=all (ไม่ filter)
    //   - null  → ไม่ส่ง (backend ใช้ default)
    //   - Set   → CSV
    if (state.tradeStates === 'all') {
      params.set('tradeStates', 'all');
    } else if (state.tradeStates instanceof Set) {
      if (state.tradeStates.size > 0) params.set('tradeStates', Array.from(state.tradeStates).join(','));
    }
    if (state.signalOutcomes === 'all') {
      params.set('signalOutcomes', 'all');
    } else if (state.signalOutcomes instanceof Set) {
      if (state.signalOutcomes.size > 0) params.set('signalOutcomes', Array.from(state.signalOutcomes).join(','));
    }
    const resp = await API.get('/api/history?' + params.toString());
    renderItems(resp.items || [], resp.bots || []);
    // FIX-2026-07-24: update filter-meta + meta line
    const filterMeta = document.getElementById('filter-meta');
    if (filterMeta && resp.filter) {
      const f = resp.filter;
      filterMeta.textContent = `effective: trades=[${(f.tradeStates || []).join(', ')}] · signals=[${(f.signalOutcomes || []).join(', ')}]`;
    }
    const meta = document.getElementById('meta');
    if (meta) {
      meta.textContent = `แสดง ${resp.items ? resp.items.length : 0} รายการ · kind=${resp.kind} · from=${state.from} to=${state.to}` +
        (resp.counts ? ` · (raw: trades=${resp.counts.trades}, signals=${resp.counts.signals})` : '');
    }
  } catch (err) {
    console.error('loadHistory failed:', err);
    const tbody = document.getElementById('history-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="20" class="empty text-danger">❌ ${escapeHtml(err.message)}</td></tr>`;
    const cards = document.getElementById('history-cards');
    if (cards) cards.innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message)}</div>`;
  }
}

function renderItems(items, botList) {
  const botMap = new Map(botList.map((b) => [String(b._id), b]));
  const isMobile = window.matchMedia('(max-width:768px)').matches;

  if (isMobile) {
    renderMobileCards(items, botMap);
    return;
  }
  renderTable(items, botMap);
}

function renderTable(items, botMap) {
  const thRow = document.getElementById('th-row');
  const tbody = document.getElementById('history-tbody');
  if (!thRow || !tbody) return;

  // Column definitions per kind
  let headers = [];
  let rowRender = () => '';
  if (state.kind === 'trades') {
    headers = ['Time', 'Bot', 'Symbol', 'Side', 'Qty', 'Price', 'P&L', '%', 'State', 'Reason'];
    rowRender = (t) => {
      const bot = botMap.get(String(t.botId)) || {};
      const pnl = Number(t.realizedPnl);
      const pnlClass = Number.isFinite(pnl) ? (pnl > 0 ? 'text-success' : pnl < 0 ? 'text-danger' : '') : '';
      const pnlStr = Number.isFinite(pnl) ? (pnl >= 0 ? '+' : '') + pnl.toFixed(4) : '—';
      // FIX-2026-08-02: %PnL column = realizedPnl / (buyPrice * buyQty) * 100
      const pct = pnlPctOf(t);
      const pctClass = pnlPctClass(pct);
      // FIX-2026-08-02: DCA stack badge — show layer count on Symbol cell + BEP hint on Price cell
      const dcaBadge = t.isDcaStack === true
        ? `<span class="dca-pill" title="DCA stack — ${t.dcaLayerCount || '?'} layers, BEP=${Number(t.stackBep || t.buyPrice || 0).toFixed(8)}">📚 L${t.dcaLayerCount || '?'}</span>`
        : '';
      const priceCell = t.isDcaStack === true
        ? `${formatPrice(t.symbol, t.sellPrice || t.stackBep || t.buyPrice)}<div class="muted" style="font-size:0.7rem;">BEP ${Number(t.stackBep || 0).toFixed(8)}</div>`
        : formatPrice(t.symbol, t.sellPrice || t.buyPrice);
      return `
        <tr>
          <td class="ts">${formatTime(t.createdAt)}</td>
          <td>${escapeHtml(bot.name || '?')}</td>
          <td class="code">${escapeHtml(t.symbol || '?')} ${dcaBadge}</td>
          <td><span class="status-pill ${t.buyFilledAt ? 'is-buy' : ''}">${t.buyFilledAt ? 'BUY' : (t.sellFilledAt ? 'SELL' : '—')}</span></td>
          <td class="num">${formatNum(t.sellQty || t.buyQty)}</td>
          <td class="num">${priceCell}</td>
          <td class="num ${pnlClass}">${pnlStr}</td>
          <td class="num ${pctClass}">${pnlPctStr(pct)}</td>
          <td><span class="status-pill state-${escapeHtml(t.state || '?')}">${escapeHtml(t.state || '?')}</span></td>
          <td>${SellReasons.renderSellReasonPill(t.sellReason, t.sellReasonDetail)}</td>
        </tr>`;
    };
  } else if (state.kind === 'signals') {
    headers = ['Time', 'Bot', 'Symbol/TF', 'Type', 'Close', 'Basis', 'Upper', 'Lower', 'BG', 'Outcome'];
    rowRender = (s) => {
      const bot = botMap.get(String(s.botId)) || {};
      return `
        <tr>
          <td class="ts">${formatTime(s.candleCloseTime)}</td>
          <td>${escapeHtml(bot.name || '?')}</td>
          <td class="code">${escapeHtml(s.symbol || '?')}/${escapeHtml(s.timeframe || '?')}</td>
          <td>${escapeHtml(s.type || '?')}</td>
          <td class="num">${formatPrice(s.symbol, s.closePrice)}</td>
          <td class="num">${formatPrice(s.symbol, s.basisKC)}</td>
          <td class="num">${formatPrice(s.symbol, s.upperKC)}</td>
          <td class="num">${formatPrice(s.symbol, s.lowerKC)}</td>
          <td class="num">${s.bgState ?? '—'}</td>
          <td><span class="status-pill outcome-${escapeHtml(s.outcome || '?')}">${escapeHtml(s.outcome || '?')}</span></td>
        </tr>`;
    };
  } else {
    headers = ['Time', 'Kind', 'Bot', 'Symbol', 'Summary', 'Status', 'Reason'];
    rowRender = (it) => {
      const isTrade = it._kind === 'trade';
      const bot = botMap.get(String(it.botId)) || {};
      let summary = '', status = '';
      if (isTrade) {
        const pnl = Number(it.realizedPnl);
        const pnlClass = Number.isFinite(pnl) ? (pnl > 0 ? 'text-success' : pnl < 0 ? 'text-danger' : '') : '';
        // FIX-2026-08-02: เพิ่ม %PnL ใน summary (both view) — ใช้ helper เดียวกับ desktop table
        const pct = pnlPctOf(it);
        const pctClass = pnlPctClass(pct);
        summary = `<span class="${pnlClass}">qty ${formatNum(it.sellQty || it.buyQty)} @ ${formatPrice(it.symbol, it.sellPrice || it.buyPrice)}</span> · <span class="${pctClass}">${pnlPctStr(pct)}</span>`;
        status = `<span class="status-pill state-${escapeHtml(it.state || '?')}">${escapeHtml(it.state || '?')}</span>`;
      } else {
        summary = `${escapeHtml(it.type || 'S1')} · close ${formatPrice(it.symbol, it.closePrice)} · bg ${it.bgState ?? '?'}`;
        status = `<span class="status-pill outcome-${escapeHtml(it.outcome || '?')}">${escapeHtml(it.outcome || '?')}</span>`;
      }
      const time = isTrade ? it.createdAt : it.candleCloseTime;
      const reasonCell = isTrade ? SellReasons.renderSellReasonPill(it.sellReason, it.sellReasonDetail) : '—';
      return `
        <tr>
          <td class="ts">${formatTime(time)}</td>
          <td><span class="status-pill ${isTrade ? 'is-trade' : 'is-signal'}">${isTrade ? 'TRADE' : 'SIGNAL'}</span></td>
          <td>${escapeHtml(bot.name || '?')}</td>
          <td class="code">${escapeHtml(it.symbol || '?')}</td>
          <td>${summary}</td>
          <td>${status}</td>
          <td>${reasonCell}</td>
        </tr>`;
    };
  }

  thRow.innerHTML = headers.map((h) => `<th>${h}</th>`).join('');

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${headers.length}" class="empty">ไม่มีข้อมูล</td></tr>`;
    return;
  }
  tbody.innerHTML = items.map(rowRender).join('');
}

function renderMobileCards(items, botMap) {
  const cards = document.getElementById('history-cards');
  if (!cards) return;
  if (items.length === 0) {
    cards.innerHTML = `<div class="empty">ไม่มีข้อมูล</div>`;
    return;
  }
  cards.innerHTML = items.map((it) => {
    const isTrade = it._kind === 'trade';
    const bot = botMap.get(String(it.botId)) || {};
    const time = isTrade ? it.createdAt : it.candleCloseTime;
    if (isTrade) {
      const pnl = Number(it.realizedPnl);
      const pnlClass = Number.isFinite(pnl) ? (pnl > 0 ? 'text-success' : pnl < 0 ? 'text-danger' : '') : '';
      // FIX-2026-08-02: %PnL ใน mobile card ด้วย (parity กับ desktop table)
      const pct = pnlPctOf(it);
      const pctClass = pnlPctClass(pct);
      const dcaBadgeMobile = it.isDcaStack === true
        ? `<span class="dca-pill" title="DCA stack — ${it.dcaLayerCount || '?'} layers">📚 L${it.dcaLayerCount || '?'}</span>`
        : '';
      return `
        <div class="mob-card">
          <div class="d-flex justify-content-between">
            <span class="status-pill is-trade">TRADE</span>
            <span class="ts">${formatTime(time)}</span>
          </div>
          <div class="mob-row"><b>${escapeHtml(bot.name || '?')}</b> · ${escapeHtml(it.symbol || '?')} ${dcaBadgeMobile}</div>
          <div class="mob-row">qty ${formatNum(it.sellQty || it.buyQty)} @ ${formatPrice(it.symbol, it.sellPrice || it.buyPrice)}</div>
          <div class="mob-row ${pnlClass}">P&L: ${Number.isFinite(pnl) ? (pnl >= 0 ? '+' : '') + pnl.toFixed(4) : '—'}</div>
          <div class="mob-row ${pctClass}">%PnL: ${pnlPctStr(pct)}</div>
          <div class="mob-row"><span class="status-pill state-${escapeHtml(it.state || '?')}">${escapeHtml(it.state || '?')}</span></div>
          <div class="mob-row">Reason: ${SellReasons.renderSellReasonPill(it.sellReason, it.sellReasonDetail)}</div>
        </div>`;
    }
    return `
      <div class="mob-card">
        <div class="d-flex justify-content-between">
          <span class="status-pill is-signal">SIGNAL</span>
          <span class="ts">${formatTime(time)}</span>
        </div>
        <div class="mob-row"><b>${escapeHtml(bot.name || '?')}</b> · ${escapeHtml(it.symbol || '?')}/${escapeHtml(it.timeframe || '?')}</div>
        <div class="mob-row">${escapeHtml(it.type || 'S1')} · close ${formatPrice(it.symbol, it.closePrice)} · bg ${it.bgState ?? '?'}</div>
        <div class="mob-row"><span class="status-pill outcome-${escapeHtml(it.outcome || '?')}">${escapeHtml(it.outcome || '?')}</span></div>
      </div>`;
  }).join('');
}

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mo} ${hh}:${mm}:${ss}`;
}

function formatNum(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  if (x === 0) return '0';
  if (Math.abs(x) >= 1) return x.toFixed(4);
  return x.toFixed(8);
}

// FIX-2026-07-31: format price ตาม tickSize (authoritative per-symbol) — แทน formatNum heuristic
//   ใช้กับ price fields เท่านั้น (qty ใช้ formatNum ต่อ)
function formatPrice(symbol, n) {
  return window.PriceFormat ? PriceFormat.format(n, symbol) : formatNum(n);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
