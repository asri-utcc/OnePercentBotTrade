'use strict';

// ─── Timezone helpers (force Asia/Bangkok +07:00) ──────
const TZ = 'Asia/Bangkok';
const _btDtFmt = new Intl.DateTimeFormat('th-TH', {
  timeZone: TZ,
  year: 'numeric', month: 'short', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});
const _btDateFmt = new Intl.DateTimeFormat('th-TH', {
  timeZone: TZ,
  year: 'numeric', month: 'short', day: '2-digit',
  hour12: false,
});
function fmtDateTime(d) { return d ? _btDtFmt.format(new Date(d)) : '-'; }
function fmtDate(d)     { return d ? _btDateFmt.format(new Date(d)) : '-'; }

// ─── State สำหรับ pagination ของ trades table ────
let tradesState = { all: [], page: 0, pageSize: 20 };

// ─── State สำหรับ sort ของ Still Holding Positions table ────
let stillSortState = { key: 'candlesHeld', dir: 'desc' };
let stillPositionsCache = [];  // raw positions array (sortable)

function setTradesState(all) {
  tradesState = { all: all || [], page: 0, pageSize: 20 };
}

// ─── Still Holding Positions table — sort + render helpers ────────
function stillSortValue(p, key, type) {
  if (type === 'date') {
    const v = p[key];
    return v ? new Date(v).getTime() : 0;
  }
  const raw = p[key];
  if (raw == null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function renderStillTbody() {
  const tbody = document.getElementById('mb-still-tbody');
  if (!tbody) return;
  const { key, dir } = stillSortState;
  // Determine sort type from header (defaults to num for safety)
  const th = document.querySelector(`#mb-still-holding th[data-sort-key="${key}"]`);
  const type = th ? th.getAttribute('data-sort-type') : 'num';
  const mult = dir === 'asc' ? 1 : -1;
  const sorted = stillPositionsCache.slice().sort((a, b) => {
    const va = stillSortValue(a, key, type);
    const vb = stillSortValue(b, key, type);
    if (va < vb) return -1 * mult;
    if (va > vb) return 1 * mult;
    // tiebreak: botIndex asc กัน row order เรียงไม่สม่ำเสมอ
    const ai = (a.botIndex != null) ? a.botIndex : 999;
    const bi = (b.botIndex != null) ? b.botIndex : 999;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  });
  tbody.innerHTML = sorted.map(stillRowHtml).join('');
}

function stillRowHtml(p) {
  const upnlCls = p.unrealizedPnl > 0 ? 'pnl-positive' : (p.unrealizedPnl < 0 ? 'pnl-negative' : '');
  const barPct = stillBarPct(p);
  const tpLabel = p.tpReached
    ? `<span class="pnl-positive">🎯 ถึง TP แล้ว</span>`
    : `ขึ้นอีก ${(p.pctToTp || 0).toFixed(3)}%`;
  const botIndexLabel = (p.botIndex != null && p.botIndex >= 0) ? `#${p.botIndex + 1}` : '';
  return `<tr>
    <td><span class="text-muted-3" style="font-family:var(--mono);font-size:0.78em;">${escapeHtml(botIndexLabel)}</span></td>
    <td><strong>${escapeHtml(p.symbol || '')}</strong><br><span class="text-muted-3" style="font-size:0.78em;">${escapeHtml(p.timeframe || '')}</span></td>
    <td>${stillFmtDt(p.signalTime)}</td>
    <td>${stillFmtDt(p.buyFilledAt)}</td>
    <td class="mono">${PriceFormat.format(p.buyPrice, p.symbol)}</td>
    <td class="mono">${PriceFormat.format(p.targetSellPrice, p.symbol)}</td>
    <td class="mono">${(p.qty || 0).toFixed(6)}</td>
    <td class="mono">$${(p.notional || 0).toFixed(2)}</td>
    <td class="mono">${stillDurLabel(p.candlesHeld)}</td>
    <td class="mono">${PriceFormat.format(p.lastClose, p.symbol)}</td>
    <td>
      <div class="${upnlCls}" style="font-weight:700;">${(p.unrealizedPnl >= 0 ? '+' : '') + (p.unrealizedPnl || 0).toFixed(4)} <small>USDT</small></div>
      <div class="${upnlCls}" style="font-size:0.78em;">${(p.unrealizedPnlPercent >= 0 ? '+' : '') + (p.unrealizedPnlPercent || 0).toFixed(3)}%</div>
    </td>
    <td style="min-width:140px;">
      <div class="mb-tp-text" style="font-size:0.78em;color:var(--text-3);margin-bottom:2px;">${tpLabel}</div>
      <div class="mb-tp-bar"><div class="mb-tp-fill ${upnlCls}" style="width:${Math.round(barPct)}%;"></div></div>
    </td>
  </tr>`;
}

function stillFmtDt(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('th-TH', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok',
    });
  } catch (_) { return String(d); }
}

function stillDurLabel(n) {
  if (n == null) return '—';
  if (n < 60) return `${n} แท่ง`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d2 = Math.floor(h / 24);
  return `${d2}d ${h % 24}h`;
}

function stillBarPct(p) {
  if (p.totalPathPct == null || p.totalPathPct <= 0) return 0;
  const lastC = p.lastClose || 0;
  const entry = p.buyPrice || 0;
  const tp = p.targetSellPrice || 0;
  if (!tp || !entry) return 0;
  if (p.tpReached) return 100;
  const left = (tp - lastC) / tp;
  const total = (tp - entry) / entry;
  return total > 0 ? Math.max(0, Math.min(100, (1 - left / total) * 100)) : 0;
}

function onStillHeaderClick(ev) {
  const th = ev.target.closest('th.mb-sortable');
  if (!th) return;
  const key = th.getAttribute('data-sort-key');
  if (!key) return;
  if (stillSortState.key === key) {
    stillSortState.dir = stillSortState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    stillSortState.key = key;
    stillSortState.dir = 'desc';
  }
  // re-render header arrows + body
  const table = th.closest('table');
  if (table) {
    table.querySelectorAll('th.mb-sortable').forEach((h) => {
      const active = h.getAttribute('data-sort-key') === stillSortState.key;
      const arrow = active ? (stillSortState.dir === 'asc' ? ' ▲' : ' ▼') : '';
      h.classList.toggle('is-active', active);
      // Strip any trailing arrow from current label (keep label + hint), then append fresh arrow
      const raw = h.textContent.replace(/[▲▼]\s*$/, '').trimEnd();
      h.textContent = raw + arrow;
    });
  }
  renderStillTbody();
}

function renderTradesPage() {
  const { all, page, pageSize } = tradesState;
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * pageSize;
  const end = Math.min(start + pageSize, all.length);
  const slice = all.slice(start, end);

  const tbody = document.getElementById('trades-tbody');
  if (!tbody) return;
  // FIX 2026-07-30: detect multi-bot mode (any trade has symbol/tf from bot)
  const isMultiBot = all.some((t) => t.symbol && t.timeframe);
  tbody.innerHTML = slice.map((t) => `
    <tr>
      ${isMultiBot ? `<td><small class="text-muted-3">${escapeHtml(t.symbol || '')} <span style="opacity:0.6;">${t.timeframe || ''}</span></small></td>` : ''}
      <td>${fmtDateTime(t.signalTime)}</td>
      <td>${t.buyFilledAt ? fmtDateTime(t.buyFilledAt) : '<span class="text-muted">—</span>'}</td>
      <td>${PriceFormat.format(t.buyPrice, t.symbol)}</td>
      <td>${t.sellFilledAt ? fmtDateTime(t.sellFilledAt) : '<span class="text-muted">—</span>'}</td>
      <td>${PriceFormat.format(t.targetSellPrice, t.symbol)}</td>
      <td>${t.sellPrice != null ? PriceFormat.format(t.sellPrice, t.symbol) : '-'}</td>
      <td>${t.buyFilled ? '✅' : '❌'}</td>
      <td>${t.sellFilled ? '✅' : (t.buyFilled ? '⏱' : '—')}</td>
      <td class="${(t.realizedPnl || 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}">${(t.realizedPnl || 0).toFixed(4)}</td>
      <td class="${(t.pnlPercent || 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}">${(t.pnlPercent || 0).toFixed(3)}%</td>
      <td><small class="text-muted">${t.exitReason || '-'}</small></td>
    </tr>
  `).join('');

  const label = document.getElementById('trades-page-label');
  if (label) label.textContent = `หน้า ${safePage + 1} / ${totalPages} · แสดง ${start + 1}–${end} จาก ${all.length}`;

  const prev = document.getElementById('trades-prev');
  const next = document.getElementById('trades-next');
  if (prev) prev.disabled = safePage === 0;
  if (next) next.disabled = safePage >= totalPages - 1;
}

window.tradesPageGo = (delta) => {
  const totalPages = Math.max(1, Math.ceil(tradesState.all.length / tradesState.pageSize));
  tradesState.page = Math.min(Math.max(0, tradesState.page + delta), totalPages - 1);
  renderTradesPage();
  const tbl = document.getElementById('trades-table-wrap');
  if (tbl) tbl.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

async function init() {
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me || !me.authenticated) {
    location.href = '/login.html';
    return;
  }

  // FIX-2026-07-31: preload tickSize cache (ZILUSDT ต้องแสดง 6 dp ไม่ใช่ 4)
  await window.PriceFormat.load().catch(() => {});
  await loadSymbols();
  setDefaultDates();
  document.getElementById('b-run').onclick = runBacktest;
  await loadHistory();
  await mbInit(); // FIX-2026-07-30: multi-bot backtest
}

async function loadSymbols() {
  try {
    const resp = await API.get('/api/bots/symbols');
    const select = document.getElementById('b-symbol');
    select.innerHTML = '';
    for (const s of resp.symbols) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === 'BNBUSDT') opt.selected = true;
      select.appendChild(opt);
    }
  } catch (err) { console.error(err); }
}

function setDefaultDates() {
  const today = new Date();
  const month = new Date();
  month.setDate(today.getDate() - 30);
  document.getElementById('b-to').value = today.toISOString().split('T')[0];
  document.getElementById('b-from').value = month.toISOString().split('T')[0];
}

async function runBacktest() {
  const data = {
    symbol: document.getElementById('b-symbol').value,
    timeframe: document.getElementById('b-timeframe').value,
    from: document.getElementById('b-from').value,
    to: document.getElementById('b-to').value,
    tpPercent: parseFloat(document.getElementById('b-tp').value),
    capitalPerTrade: parseFloat(document.getElementById('b-capital').value),
    maxConcurrentTrades: parseInt(document.getElementById('b-maxtrades').value, 10),
    useBnbForFees: document.getElementById('b-bnb').checked,
  };

  // hint estimate wait time for long ranges (3m × 1y ≈ 175k candles ≈ 30–90s)
  const days = Math.max(1, Math.round((new Date(data.to) - new Date(data.from)) / 86400000));
  document.getElementById('result').innerHTML =
    `<div class="alert alert-info">⏳ กำลังรัน backtest ${data.symbol} ${data.timeframe} (${days} วัน) — อาจใช้เวลา 10–60 วินาที สำหรับช่วงยาว ๆ</div>`;

  try {
    const resp = await API.post('/api/backtest', data);
    renderResult(resp, data);
    await loadHistory();
  } catch (err) {
    document.getElementById('result').innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

function renderResult(resp, params) {
  const s = resp.stats;
  const pnlClass = s.totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
  const winClass = s.winRate >= 50 ? 'pnl-positive' : 'pnl-negative';

  // Buy fill rate (เข้าไม้ได้จริง) vs Sell exit rate (ออกไม้ได้ครบ)
  const fillClass = s.fillRate >= 70 ? 'pnl-positive' : (s.fillRate >= 40 ? 'pnl-warning' : 'pnl-negative');
  const exitClass = s.exitRate >= 70 ? 'pnl-positive' : (s.exitRate >= 40 ? 'pnl-warning' : 'pnl-negative');

  // Max concurrent trades used (peak concurrency)
  // - แดงเมื่อใกล้ max (≥80%) = สัญญาณว่า slot เต็มบ่อย → ควรเพิ่ม maxConcurrentTrades
  // - เหลืองเมื่อใช้ ≥50%
  // - ปกติเมื่อใช้น้อย
  const maxSlot = params.maxConcurrentTrades || 10;
  const peakUsed = s.maxConcurrentTradesUsed || 0;
  const peakRatio = maxSlot > 0 ? (peakUsed / maxSlot) * 100 : 0;
  const peakClass = peakRatio >= 80 ? 'pnl-negative' : (peakRatio >= 50 ? 'pnl-warning' : 'pnl-positive');
  const peakLabel = `${peakUsed} / ${maxSlot}`;

  // FIX 2026-07-13: เตือนเมื่อ fetchKlines ตัดข้อมูล (ช่วงที่ขอ > 6 เดือนบน 5m)
  const truncated = !!resp.truncated;
  const truncationHtml = truncated ? `
    <div class="alert alert-warning small mb-2">
      <strong>⚠️ ข้อมูลถูกตัดจาก SAFETY_LIMIT:</strong>
      ขอช่วง <code>${resp.requestedDays}</code> วัน แต่ดึงได้แค่
      <code>${resp.candlesFetched}</code> แท่ง (~${resp.actualDays} วัน)
      — backtest รันบนช่วงแค่ <code>${params.from} → ${params.to}</code> จริง ๆ ไม่ครบ
    </div>` : '';

  // เก็บ trades ทั้งหมด + reset หน้า
  setTradesState(resp.trades || []);

  document.getElementById('result').innerHTML = `
    <div class="card">
      <div class="card-header"><strong>📊 ผล Backtest</strong> — ${params.symbol} ${params.timeframe} (${params.from} → ${params.to})</div>
      <div class="card-body">
        ${truncationHtml}
        <div class="row g-2 mb-3">
          <div class="col-md-2"><div class="stat-tile"><div class="value">${resp.signalsCount}</div><div class="label">Signals (S1)</div></div></div>
          <div class="col-md-2"><div class="stat-tile"><div class="value ${fillClass}">${s.fillRate.toFixed(1)}%</div><div class="label">Buy Fill Rate</div></div></div>
          <div class="col-md-2"><div class="stat-tile"><div class="value ${exitClass}">${s.exitRate.toFixed(1)}%</div><div class="label">Exit Rate</div></div></div>
          <div class="col-md-2"><div class="stat-tile"><div class="value ${winClass}">${s.winRate.toFixed(1)}%</div><div class="label">Win Rate (realized)</div></div></div>
          <div class="col-md-2"><div class="stat-tile"><div class="value ${pnlClass}">${s.totalPnl.toFixed(4)}</div><div class="label">Total PnL (USDT)</div></div></div>
          <div class="col-md-2"><div class="stat-tile"><div class="value ${pnlClass}">${s.totalPnlPercent.toFixed(3)}%</div><div class="label">PnL %</div></div></div>
        </div>

        <div class="row g-2 mb-3">
          <div class="col-md-3">
            <div class="stat-tile" title="จำนวนไม้ที่เปิดพร้อมกันสูงสุดในช่วง simulation — ถ้าใกล้ max แสดงว่าช่วงนั้นเทรนลงแรงและ TP ยาก ควรพิจารณาเพิ่ม maxConcurrentTrades">
              <div class="value ${peakClass}">${peakLabel}</div>
              <div class="label">Peak Concurrent / Max</div>
            </div>
          </div>
          <div class="col-md-9 text-muted small d-flex align-items-center">
            ${peakRatio >= 80
              ? `<span class="pnl-negative">⚠️ ใช้ slot สูงถึง ${peakRatio.toFixed(0)}% ของ max — มี Skip (เต็ม) ${s.maxConcurrentSkipCount || 0} ครั้ง พิจารณาเพิ่ม <code>maxConcurrentTrades</code></span>`
              : (peakRatio >= 50
                ? `<span class="pnl-warning">📊 ใช้ slot สูงสุด ${peakRatio.toFixed(0)}% ของ max — เริ่มมีช่วงที่หลายไม้ค้างพร้อมกัน</span>`
                : `<span>✅ peak usage ${peakRatio.toFixed(0)}% ของ max — slot เพียงพอ`)}
          </div>
        </div>

        <div class="row g-2 mb-3">
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.tpHitCount}</div><div class="label">TP hit ✓</div></div></div>
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.cbPanicCount || 0}</div><div class="label">CB panic</div></div></div>
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.stopLossUpperKcCount || 0}</div><div class="label">SL-UKC</div></div></div>
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.stillHoldingCount || 0}</div><div class="label">ยังถืออยู่</div></div></div>
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.noBuyFillCount}</div><div class="label">No buy fill</div></div></div>
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.belowMinNotionalCount || 0}</div><div class="label">Below min</div></div></div>
        </div>

        <div class="row g-2 mb-3 text-muted small">
          <div class="col-md-3">Avg PnL/signal: <strong>${s.avgPnlPerSignal.toFixed(4)}</strong> USDT</div>
          <div class="col-md-3">Total fees: <strong>${s.totalFees.toFixed(4)}</strong> USDT</div>
          <div class="col-md-3">Unrealized PnL: <strong>${(s.totalUnrealizedPnl || 0).toFixed(4)}</strong> USDT (ยังถืออยู่)</div>
          <div class="col-md-3">Max DD: <strong class="pnl-negative">${s.maxDrawdown.toFixed(4)}</strong> USDT (${(s.maxDrawdownPercent || 0).toFixed(1)}%)</div>
        </div>

        <div id="trades-table-wrap">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <h6 class="mb-0">📋 รายการเทรดทั้งหมด (${(resp.trades || []).length} ไม้)</h6>
            <div class="d-flex align-items-center gap-2">
              <button id="trades-prev" class="btn btn-sm btn-outline-secondary" onclick="tradesPageGo(-1)">◀ ก่อนหน้า</button>
              <span id="trades-page-label" class="text-muted small"></span>
              <button id="trades-next" class="btn btn-sm btn-outline-secondary" onclick="tradesPageGo(1)">ถัดไป ▶</button>
            </div>
          </div>
          <div class="table-responsive">
            <table class="table table-sm table-striped">
              <thead>
                <tr>
                  <th>Signal Time</th>
                  <th>Buy Time</th>
                  <th>Buy</th>
                  <th>Sell Time</th>
                  <th>Target</th>
                  <th>Sell</th>
                  <th>Buy</th>
                  <th>Exit</th>
                  <th>PnL</th>
                  <th>%</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody id="trades-tbody"></tbody>
            </table>
          </div>
        </div>

        <div class="alert alert-light small mt-2">
          <strong>ℹ️ Execution Model: <code>${resp.executionModel || 'unknown'}</code></strong> (No Stop Loss, max ${params.maxConcurrentTrades || 10} ไม้พร้อมกัน)
          <ul class="mb-1">
            <li><strong>BUY price</strong>: ใช้ <code>candle close</code> เป็น proxy สำหรับ <em>best bid</em> (บอทจริงใช้ bid จาก bookTicker WS ตอนปิดแท่ง → ต่ำกว่า close 1–10 bps ในตลาดผันผวน)</li>
            <li><strong>Buy Fill</strong>: นับเป็น fill เมื่อ <code>low ≤ P AND close ≥ P AND volume &gt; 0</code> (post-only bid ที่ wick ลงเด้งกลับจะไม่ถูกนับ fill) ภายใน 6 แท่ง — ถ้าไม่ fill คือยกเลิก → ไม่มี PnL</li>
            <li><strong>Buy timestamp</strong>: <code>openTime + stepMs/2</code> (กลางแท่ง) — สะท้อนว่า maker order มัก fill ระหว่างแท่ง ไม่ใช่ตอนปิด</li>
            <li><strong>Sell timestamp</strong>: <code>openTime + stepMs/2</code> (กลางแท่ง) เช่นเดียวกับ BUY</li>
            <li><strong>Sell Fill</strong>: ต้องรอให้ราคาขึ้นไปแตะ target (future candle high ≥ target) — <strong>ไม่มี stop loss</strong> ถ้าไม่ fill → ถือต่อจนกว่าข้อมูลจะหมด (ยังไม่นับ PnL)</li>
            <li><strong>Slot Limit</strong>: ถ้าเปิดไม้ครบ ${params.maxConcurrentTrades || 10} → skip signal ใหม่ (ไม่เปิดเกิน)</li>
            <li><strong>Qty</strong>: floor ตาม stepSize ของ symbol (เช่น BNBUSDT = 0.01) — ถ้า notional &lt; minNotional จะ skip</li>
          </ul>
          ⚠️ ในชีวิตจริง ยังมี slippage, network delay, partial fills ที่โมเดลนี้ไม่ได้ครอบคลุม
        </div>
      </div>
    </div>
  `;

  renderTradesPage();
}

async function loadHistory() {
  try {
    const resp = await API.get('/api/backtest');
    const container = document.getElementById('history');
    if (!resp.results || resp.results.length === 0) {
      container.innerHTML = '<div class="text-muted">ยังไม่มีประวัติ</div>';
      return;
    }
    container.innerHTML = `
      <table class="table table-sm">
        <thead>
          <tr>
            <th>เวลา</th><th>Symbol</th><th>TF</th><th>ช่วง</th><th>Model</th>
            <th>Signals</th><th>Fill%</th><th>Exit%</th><th>Skip</th><th>W/L</th>
            <th>Peak Conc.</th><th>PnL</th><th>PnL %</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${resp.results.map((r) => {
            const pnlClass = (r.totalPnl || 0) >= 0 ? 'pnl-positive' : 'pnl-negative';
            const modelBadge = r.executionModel
              ? `<span class="badge bg-secondary" title="Execution model">${r.executionModel}</span>`
              : '<span class="text-muted small">unknown</span>';
            // peak concurrent = peak / maxConcurrentTrades (จาก params)
            // ถ้า doc เก่าไม่มี r.params.maxConcurrentTrades (บันทึกก่อน schema update) → แสดง peak อย่างเดียว
            const peakUsed = r.maxConcurrentTradesUsed || 0;
            const maxSlot = r.params ? r.params.maxConcurrentTrades : null;
            const peakCell = maxSlot ? `${peakUsed}/${maxSlot}` : `${peakUsed} / <span class="text-muted" title="doc เก่า — บันทึกก่อน schema update">?</span>`;
            const peakRatio = maxSlot > 0 ? (peakUsed / maxSlot) * 100 : 0;
            const peakCls = maxSlot && peakRatio >= 80 ? 'pnl-negative' : (maxSlot && peakRatio >= 50 ? 'pnl-warning' : '');
            const peakTitle = maxSlot
              ? `peak concurrent / maxConcurrentTrades = ${peakUsed}/${maxSlot}`
              : `peak concurrent = ${peakUsed} (max ไม่ได้บันทึกไว้ใน doc เก่า)`;
            return `
              <tr>
                <td>${fmtDateTime(r.createdAt)}</td>
                <td>${r.symbol}</td>
                <td>${r.timeframe}</td>
                <td>${fmtDate(r.from)} - ${fmtDate(r.to)}</td>
                <td>${modelBadge}</td>
                <td>${r.signalsCount}</td>
                <td>${(r.fillRate || 0).toFixed(0)}%</td>
                <td>${(r.exitRate || 0).toFixed(0)}%</td>
                <td class="${(r.maxConcurrentSkipCount || 0) > 0 ? 'pnl-negative' : 'text-muted'}" title="จำนวนครั้งที่ bot ต้อง skip สัญญาณเพราะ slot เต็ม — ถ้าเยอะควรเพิ่ม maxConcurrentTrades">${r.maxConcurrentSkipCount || 0}</td>
                <td>${r.wins || 0}/${r.losses || 0}</td>
                <td class="${peakCls}" title="${peakTitle}">${peakCell}</td>
                <td class="${pnlClass}">${(r.totalPnl || 0).toFixed(4)}</td>
                <td class="${pnlClass}">${(r.totalPnlPercent || 0).toFixed(3)}%</td>
                <td><button class="btn btn-sm btn-outline-danger" onclick="deleteBacktest('${r._id}')">🗑</button></td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    console.error(err);
  }
}

window.deleteBacktest = async (id) => {
  if (!confirm('ลบ?')) return;
  await API.del(`/api/backtest/${id}`);
  await loadHistory();
};

// ────────────────────────────────────────────────────────────
// FIX-2026-07-30: Multi-bot backtest (shared capital pool)
// ────────────────────────────────────────────────────────────
const TF_OPTIONS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d'];
const mbState = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'],
  rows: [],
};

function mbDefaultRows() {
  return [
    { symbol: 'BTCUSDT', timeframe: '5m', tpPercent: 0.1, kcMult: 1.5, capitalPerTrade: 10, maxConcurrentTrades: 10,
      xs1Enabled: true, cbEnabled: true, stopLossOnUpperKC: false },
    { symbol: 'ETHUSDT', timeframe: '5m', tpPercent: 0.1, kcMult: 1.5, capitalPerTrade: 10, maxConcurrentTrades: 10,
      xs1Enabled: true, cbEnabled: true, stopLossOnUpperKC: false },
  ];
}

// FIX-2026-07-30: คำนวณทุนรวมที่แนะนำ ≥ ผลรวม maxConcurrent × capitalPerTrade ของทุกบอท
function mbSuggestCapital() {
  const needed = mbState.rows.reduce((sum, r) => sum + (parseFloat(r.capitalPerTrade) || 0) * (parseInt(r.maxConcurrentTrades, 10) || 0), 0);
  return needed;
}

async function mbLoadSymbols() {
  try {
    const resp = await API.get('/api/bots/symbols');
    const syms = (resp && resp.symbols) || [];
    if (syms.length) mbState.symbols = syms;
  } catch (_) { /* fallback to defaults */ }
}

function mbRenderRows() {
  const container = document.getElementById('mb-rows');
  if (!container) return;
  container.innerHTML = '';
  mbState.rows.forEach((row, idx) => {
    const el = document.createElement('div');
    el.className = 'mb-row';
    const symbolOpts = mbState.symbols.map((s) => `<option value="${s}" ${s === row.symbol ? 'selected' : ''}>${s}</option>`).join('');
    const tfOpts = TF_OPTIONS.map((tf) => `<option value="${tf}" ${tf === row.timeframe ? 'selected' : ''}>${tf}</option>`).join('');
    el.innerHTML = `
      <select data-i="${idx}" data-k="symbol">${symbolOpts}</select>
      <select data-i="${idx}" data-k="timeframe">${tfOpts}</select>
      <input type="number" step="0.01" min="0.05" value="${row.tpPercent}" data-i="${idx}" data-k="tpPercent" title="TP%" />
      <input type="number" step="0.1" min="0.5" max="5" value="${row.kcMult ?? 1.5}" data-i="${idx}" data-k="kcMult" title="KC Multiplier (default 1.5)" />
      <input type="number" step="0.01" min="1" value="${row.capitalPerTrade}" data-i="${idx}" data-k="capitalPerTrade" title="ทุน/ไม้" />
      <input type="number" step="1" min="1" max="100" value="${row.maxConcurrentTrades}" data-i="${idx}" data-k="maxConcurrentTrades" title="Max ไม้" />
      <div class="mb-toggles" title="XS1 = กรองสัญญาณเทียม, CB = panic-sell เมื่อทะลุ lowerKC, SL-UKC = หยุดขาดทุนเมื่อปิดทะลุ upper-KC">
        <label class="mb-toggle" title="XS1 (candle-wide dump filter)">
          <input type="checkbox" data-i="${idx}" data-k="xs1Enabled" ${row.xs1Enabled !== false ? 'checked' : ''} />
          <span>XS1</span>
        </label>
        <label class="mb-toggle" title="CB (panic-sell 3 red below lowerKC)">
          <input type="checkbox" data-i="${idx}" data-k="cbEnabled" ${row.cbEnabled !== false ? 'checked' : ''} />
          <span>CB</span>
        </label>
        <label class="mb-toggle" title="StopLoss on upper-KC (close &gt; upperKC + loss only)">
          <input type="checkbox" data-i="${idx}" data-k="stopLossOnUpperKC" ${row.stopLossOnUpperKC === true ? 'checked' : ''} />
          <span>SL-UKC</span>
        </label>
      </div>
      <button class="mb-del" data-i="${idx}" title="ลบบอท">✕</button>
    `;
    container.appendChild(el);
  });
  container.querySelectorAll('select,input').forEach((el) => {
    el.addEventListener('change', (e) => {
      const i = parseInt(e.target.dataset.i, 10);
      const k = e.target.dataset.k;
      let v;
      if (e.target.type === 'checkbox') v = e.target.checked;
      else if (e.target.type === 'number') v = parseFloat(e.target.value);
      else v = e.target.value;
      mbState.rows[i][k] = v;
      // FIX-2026-07-30: hint ทุนรวมขั้นต่ำ
      const hint = document.getElementById('mb-capital-hint');
      if (hint) hint.textContent = `ขั้นต่ำที่แนะนำ: $${mbSuggestCapital()}`;
    });
  });
  container.querySelectorAll('.mb-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const i = parseInt(e.target.dataset.i, 10);
      mbState.rows.splice(i, 1);
      mbRenderRows();
    });
  });
}

async function mbRun() {
  const totalCapital = parseFloat(document.getElementById('mb-capital').value);
  const from = document.getElementById('mb-from').value;
  const to = document.getElementById('mb-to').value;
  const out = document.getElementById('mb-result');
  if (!totalCapital || totalCapital <= 0) { out.innerHTML = '<div class="alert alert-warning">ใส่ทุนรวม</div>'; return; }
  if (!from || !to) { out.innerHTML = '<div class="alert alert-warning">เลือกวันที่</div>'; return; }
  if (!mbState.rows.length) { out.innerHTML = '<div class="alert alert-warning">เพิ่มบอทอย่างน้อย 1 ตัว</div>'; return; }

  // FIX-2026-07-30: เตือนถ้าทุนไม่พอ (จะทำให้หลายไม้ถูก skip เพราะ capital exhausted)
  const needed = mbSuggestCapital();
  if (totalCapital < needed) {
    const confirm = window.confirm(
      `⚠️ ทุนรวม ($${totalCapital}) น้อยกว่าที่ควรใช้ ($${needed})\n` +
      `(ผลรวม Max ไม้ × ทุน/ไม้ ของทุกบอท)\n\n` +
      `จะมี skip เยอะเพราะทุนเต็ม — ดำเนินการต่อหรือไม่?`
    );
    if (!confirm) return;
  }

  out.innerHTML = '<div class="text-center py-4 text-muted-3">⏳ กำลังรัน multi-bot backtest (อาจใช้เวลา 10–30s)…</div>';
  const t0 = Date.now();
  try {
    const resp = await API.post('/api/backtest/multi', { totalCapital, from, to, bots: mbState.rows });
    const ms = Date.now() - t0;
    mbRenderResult(resp, ms);
  } catch (err) {
    out.innerHTML = `<div class="alert alert-danger">ผิดพลาด: ${escapeHtml(err.message || 'unknown')}</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function mbRenderResult(resp, ms) {
  const out = document.getElementById('mb-result');
  const { perBot = [], combined = {}, totalCapital } = resp;
  const s = combined.stats || {};
  const totalPnl = s.totalPnl || 0;
  const pnlCls = totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
  const winCls = (s.winRate || 0) >= 50 ? 'pnl-positive' : 'pnl-negative';
  const fillClass = (s.fillRate || 0) >= 70 ? 'pnl-positive' : ((s.fillRate || 0) >= 40 ? 'pnl-warning' : 'pnl-negative');
  const exitClass = (s.exitRate || 0) >= 70 ? 'pnl-positive' : ((s.exitRate || 0) >= 40 ? 'pnl-warning' : 'pnl-negative');

  // Total peak / max across all bots (peak = sum ของ maxConcurrentTrades ของทุกบอท)
  const totalMaxSlots = perBot.reduce((s2, b) => s2 + (b.maxConcurrentTrades || 0), 0);
  const peakRatio = totalMaxSlots > 0 ? ((combined.peakConcurrentTrades || 0) / totalMaxSlots) * 100 : 0;
  const peakClass = peakRatio >= 80 ? 'pnl-negative' : (peakRatio >= 50 ? 'pnl-warning' : 'pnl-positive');
  const peakLabel = `${combined.peakConcurrentTrades || 0} / ${totalMaxSlots}`;

  const peakCapRatio = totalCapital > 0 ? ((combined.peakCapitalUsed || 0) / totalCapital) * 100 : 0;

  // FIX 2026-07-30: warning banner เมื่อ below_min_notional เป็น skip หลัก (>50% ของ signals)
  // ปกติเกิดเมื่อ capital/trade น้อยเกินไปสำหรับราคา symbol (เช่น BTC@$110K + $10/trade = $9.90 < $10 minNotional)
  const totalSignals = perBot.reduce((sum, b) => sum + (b.signalsCount || 0), 0);
  const belowMinTotal = combined.belowMinNotionalCount || 0;
  const belowMinRatio = totalSignals > 0 ? (belowMinTotal / totalSignals) * 100 : 0;
  const belowMinWarn = belowMinRatio > 50 ? `
    <div class="alert alert-warning small mb-2">
      <strong>⚠️ Below-min-notional:</strong> ${belowMinTotal}/${totalSignals} (${belowMinRatio.toFixed(0)}%) สัญญาณถูก skip เพราะ notional &lt; Binance minNotional
      — <strong>เพิ่ม "ทุน/ไม้"</strong> ให้ ≥ minNotional ของ symbol (BTC@$110K ต้อง ≥ ~$11)
    </div>` : '';

  const summary = `
    <div class="lux-card mb-3" style="border: 1px solid rgba(245,184,0,0.3);">
      ${belowMinWarn}
      <div class="lux-header">
        <span class="title">📊 Multi-Bot Combined Result · ${ms}ms</span>
        <span class="text-muted-3" style="font-size:0.8rem;">ทุนรวม $${totalCapital} · Peak ใช้ $${(combined.peakCapitalUsed || 0).toFixed(2)} (${peakCapRatio.toFixed(0)}%)</span>
      </div>
      <div class="lux-body">
        <div class="row g-2 mb-3">
          <div class="col-md-2"><div class="stat-tile"><div class="value ${pnlCls}">${totalPnl.toFixed(4)}</div><div class="label">Total PnL (USDT)</div></div></div>
          <div class="col-md-2"><div class="stat-tile"><div class="value ${pnlCls}">${(s.totalPnlPercent || 0).toFixed(3)}%</div><div class="label">PnL %</div></div></div>
          <div class="col-md-2"><div class="stat-tile"><div class="value ${winCls}">${(s.winRate || 0).toFixed(1)}%</div><div class="label">Win Rate</div></div></div>
          <div class="col-md-2"><div class="stat-tile"><div class="value ${fillClass}">${(s.fillRate || 0).toFixed(1)}%</div><div class="label">Buy Fill Rate</div></div></div>
          <div class="col-md-2"><div class="stat-tile"><div class="value ${exitClass}">${(s.exitRate || 0).toFixed(1)}%</div><div class="label">Exit Rate</div></div></div>
          <div class="col-md-2"><div class="stat-tile" title="จำนวนไม้ที่เปิดพร้อมกันสูงสุดในช่วง simulation (ข้ามทุกบอท)"><div class="value ${peakClass}">${peakLabel}</div><div class="label">Peak Conc. / Max</div></div></div>
        </div>

        <div class="row g-2 mb-3">
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.tpHitCount || 0}</div><div class="label">TP hit ✓</div></div></div>
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.cbPanicCount || 0}</div><div class="label">CB panic</div></div></div>
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.stopLossUpperKcCount || 0}</div><div class="label">SL-UKC</div></div></div>
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.stillHoldingCount || 0}</div><div class="label">ยังถืออยู่</div></div></div>
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.noBuyFillCount || 0}</div><div class="label">No buy fill</div></div></div>
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.belowMinNotionalCount || 0}</div><div class="label">Below min</div></div></div>
        </div>

        <div class="row g-2 mb-3 text-muted small">
          <div class="col-md-2"><strong>Trades:</strong> ${combined.tradesCount || 0}</div>
          <div class="col-md-2"><strong>W/L:</strong> ${s.wins || 0}/${s.losses || 0}</div>
          <div class="col-md-2">Avg PnL/signal: <strong>${(s.avgPnlPerSignal || 0).toFixed(4)}</strong> USDT</div>
          <div class="col-md-2">Total fees: <strong>${(s.totalFees || 0).toFixed(4)}</strong> USDT</div>
          <div class="col-md-2">Unrealized: <strong>${(s.totalUnrealizedPnl || 0).toFixed(4)}</strong> USDT</div>
          <div class="col-md-2">Max DD: <strong class="pnl-negative">${(s.maxDrawdown || 0).toFixed(4)}</strong> USDT (${(s.maxDrawdownPercent || 0).toFixed(1)}%)</div>
        </div>
      </div>
    </div>
  `;

  // Per-bot table with peak slot usage
  const botRows = perBot.map((b) => {
    const bs = b.stats || {};
    const cls = (bs.totalPnl || 0) >= 0 ? 'pnl-positive' : 'pnl-negative';
    const peakUsed = b.maxConcurrentTradesUsed || 0;
    const peakBotRatio = (b.maxConcurrentTrades || 0) > 0 ? (peakUsed / b.maxConcurrentTrades) * 100 : 0;
    const peakBotCls = peakBotRatio >= 80 ? 'pnl-negative' : (peakBotRatio >= 50 ? 'pnl-warning' : 'pnl-positive');
    // FIX-2026-07-31: per-bot toggles badge (XS1 / CB / SL-UKC)
    const togBadge = (on, label) => `<span class="mb-toggle-badge ${on ? 'is-on' : 'is-off'}" title="${label} ${on ? 'เปิด' : 'ปิด'}">${label}</span>`;
    const badges = [
      togBadge(b.xs1Enabled !== false, 'XS1'),
      togBadge(b.cbEnabled !== false, 'CB'),
      togBadge(b.stopLossOnUpperKC === true, 'SL-UKC'),
    ].join(' ');
    return `<div class="mb-bot-row">
      <div><strong>${escapeHtml(b.symbol)}</strong> <span class="text-muted-3" style="font-size:0.85em;">${b.timeframe} · TP ${b.tpPercent}% · KC×${b.kcMult ?? 1.5} · $${b.capitalPerTrade}/ไม้ · max ${b.maxConcurrentTrades}</span>
        <div class="mb-badges">${badges}</div></div>
      <div class="${cls}">${(bs.totalPnl || 0).toFixed(4)}</div>
      <div>${b.tradesCount || 0} <span class="mb-skip-note">(${b.skippedCount || 0} skip)</span></div>
      <div>${bs.wins || 0}W/${bs.losses || 0}L</div>
      <div>${(bs.winRate || 0).toFixed(1)}%</div>
      <div class="${peakBotCls}" title="Peak slot usage ${peakUsed}/${b.maxConcurrentTrades} (${peakBotRatio.toFixed(0)}%)">${peakUsed}/${b.maxConcurrentTrades}</div>
      <div>${(bs.avgPnlPerSignal || 0).toFixed(4)}</div>
    </div>`;
  }).join('');

  // FIX 2026-07-30: ตาราง positions ที่ยังถืออยู่ — mark-to-market ด้วย last close
  stillPositionsCache = (combined.stillHoldingPositions || []).slice();
  const stillTotalUnrealized = combined.stillHoldingTotalUnrealized || 0;
  const stillTotalCls = stillTotalUnrealized > 0 ? 'pnl-positive' : (stillTotalUnrealized < 0 ? 'pnl-negative' : '');
  const themeHeader = (key, label, type) => {
    const active = stillSortState.key === key;
    const arrow = active ? (stillSortState.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const cls = active ? 'mb-sortable is-active' : 'mb-sortable';
    const hint = type === 'num' ? ' 🔢' : (type === 'date' ? ' 🕒' : '');
    return `<th class="${cls}" data-sort-key="${key}" data-sort-type="${type}" style="cursor:pointer;user-select:none;" title="คลิกเพื่อเรียงลำดับ">${label}${hint}${arrow}</th>`;
  };
  const stillSection = `
    <div class="lux-card mb-3" id="mb-still-holding">
      <div class="lux-header">
        <span class="title">📂 Positions ที่ยังถืออยู่ (${stillPositionsCache.length} ไม้)</span>
        <span class="text-muted-3" style="font-size:0.8rem;">
          Mark-to-market @ last close · Unrealized รวม:
          <strong class="${stillTotalCls}">${stillTotalUnrealized >= 0 ? '+' : ''}${stillTotalUnrealized.toFixed(4)} USDT</strong>
        </span>
      </div>
      <div class="lux-body">
        ${stillPositionsCache.length === 0
          ? `<div class="text-muted small" style="padding:1rem 0;">ไม่มี position ค้าง — ทุกไม้ปิดที่ TP แล้วหรือถูก skip ก่อน buy fill</div>`
          : `<div class="table-responsive">
            <table class="table table-sm table-striped mb-still-table">
              <thead>
                <tr>
                  ${themeHeader('botIndex', '#', 'num')}
                  ${themeHeader('symbol', 'Symbol / TF', 'text')}
                  ${themeHeader('signalTime', 'Signal Time', 'date')}
                  ${themeHeader('buyFilledAt', 'BUY Time', 'date')}
                  ${themeHeader('buyPrice', 'BUY Price', 'num')}
                  ${themeHeader('targetSellPrice', 'TP Target', 'num')}
                  ${themeHeader('qty', 'Qty', 'num')}
                  ${themeHeader('notional', 'Capital', 'num')}
                  ${themeHeader('candlesHeld', 'Candles Held', 'num')}
                  ${themeHeader('lastClose', 'Last Close', 'num')}
                  ${themeHeader('unrealizedPnl', 'Unrealized PnL', 'num')}
                  ${themeHeader('pctToTp', 'ระยะถึง TP', 'num')}
                </tr>
              </thead>
              <tbody id="mb-still-tbody"></tbody>
            </table>
          </div>`}
      </div>
    </div>
  `;

  // Trades table (paginated, mirror single-bot render)
  const tradesAll = (combined.trades || []).slice();
  setTradesState(tradesAll);

  out.innerHTML = summary + `
    <div class="lux-card mb-3">
      <div class="lux-header"><span class="title">🤖 Per-Bot Breakdown</span></div>
      <div class="lux-body">
        <div class="mb-bot-row" style="font-weight:700;color:var(--text-3);text-transform:uppercase;font-size:0.78em;">
          <div>Bot</div>
          <div>PnL (USDT)</div>
          <div>Trades</div>
          <div>W/L</div>
          <div>Win%</div>
          <div title="Peak slot usage / max">Peak</div>
          <div>Avg/ไม้</div>
        </div>
        ${botRows}
      </div>
    </div>

    ${stillSection}

    <div id="trades-table-wrap" class="lux-card">
      <div class="lux-header">
        <span class="title">📋 รายการเทรดทั้งหมด (${tradesAll.length} ไม้)</span>
        <div class="d-flex align-items-center gap-2">
          <button id="trades-prev" class="btn btn-sm btn-outline-secondary" onclick="tradesPageGo(-1)">◀ ก่อนหน้า</button>
          <span id="trades-page-label" class="text-muted small"></span>
          <button id="trades-next" class="btn btn-sm btn-outline-secondary" onclick="tradesPageGo(1)">ถัดไป ▶</button>
        </div>
      </div>
      <div class="lux-body">
        <div class="table-responsive">
          <table class="table table-sm table-striped">
            <thead>
              <tr>
                <th>Bot</th>
                <th>Signal Time</th>
                <th>Buy Time</th>
                <th>Buy</th>
                <th>Sell Time</th>
                <th>Target</th>
                <th>Sell</th>
                <th>Buy</th>
                <th>Exit</th>
                <th>PnL</th>
                <th>%</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody id="trades-tbody"></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="alert alert-light small mt-2">
      <strong>ℹ️ Multi-Bot Execution Model: <code>${resp.executionModel || 'v4_maker_fill_multi'}</code></strong>
      <ul class="mb-1">
        <li><strong>BUY fill</strong>: scan future candles (idx+1 ถึง idx+maxBuyWait) ต้อง <code>low ≤ P AND close ≥ P AND volume &gt; 0</code></li>
        <li><strong>SELL fill</strong>: scan to end of data — <strong>ไม่มี stop loss</strong></li>
        <li><strong>Shared capital pool</strong>: ทุกบอทแข่งกันใช้ทุนรวม — ถ้าเกิน → skip (capital_exhausted)</li>
        <li><strong>Per-bot slot</strong>: แต่ละบอทมี maxConcurrentTrades เป็นของตัวเอง (ไม่ share)</li>
        <li><strong>Skip types</strong>: no_buy_fill · below_min_notional · max_concurrent_skip · capital_exhausted_skip</li>
      </ul>
    </div>
  `;

  renderTradesPage();
  renderStillTbody();
  // FIX 2026-07-30: wire sortable header clicks (delegated on the table since it's rebuilt every run)
  const stillTable = out.querySelector('#mb-still-holding table.mb-still-table');
  if (stillTable && !stillTable.dataset.sortWired) {
    stillTable.addEventListener('click', onStillHeaderClick);
    stillTable.dataset.sortWired = '1';
  }
}

async function mbInit() {
  await mbLoadSymbols();
  mbState.rows = mbDefaultRows();
  mbRenderRows();
  // Pre-fill dates (last 14 days)
  const today = new Date();
  const past = new Date(today.getTime() - 14 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  document.getElementById('mb-from').value = fmt(past);
  document.getElementById('mb-to').value = fmt(today);
  // FIX-2026-07-30: hint ทุนขั้นต่ำเริ่มต้น
  const hint = document.getElementById('mb-capital-hint');
  if (hint) hint.textContent = `ขั้นต่ำที่แนะนำ: $${mbSuggestCapital()}`;
  // FIX-2026-07-30: default ทุนรวม = ขั้นต่ำที่แนะนำ
  const capitalInput = document.getElementById('mb-capital');
  if (capitalInput && !capitalInput.value) capitalInput.value = mbSuggestCapital();
  document.getElementById('mb-add-row').addEventListener('click', () => {
    const last = mbState.rows[mbState.rows.length - 1];
    const newRow = last
      ? { ...last }
      : { symbol: mbState.symbols[0] || 'BTCUSDT', timeframe: '5m', tpPercent: 0.1, kcMult: 1.5, capitalPerTrade: 10, maxConcurrentTrades: 5 };
    mbState.rows.push(newRow);
    mbRenderRows();
    if (hint) hint.textContent = `ขั้นต่ำที่แนะนำ: $${mbSuggestCapital()}`;
  });
  document.getElementById('mb-run').addEventListener('click', mbRun);
}

init();