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

function setTradesState(all) {
  tradesState = { all: all || [], page: 0, pageSize: 20 };
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
  tbody.innerHTML = slice.map((t) => `
    <tr>
      <td>${fmtDateTime(t.signalTime)}</td>
      <td>${t.buyFilledAt ? fmtDateTime(t.buyFilledAt) : '<span class="text-muted">—</span>'}</td>
      <td>${(t.buyPrice || 0).toFixed(4)}</td>
      <td>${t.sellFilledAt ? fmtDateTime(t.sellFilledAt) : '<span class="text-muted">—</span>'}</td>
      <td>${(t.targetSellPrice || 0).toFixed(4)}</td>
      <td>${t.sellPrice ? t.sellPrice.toFixed(4) : '-'}</td>
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
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.stillHoldingCount || 0}</div><div class="label">ยังถืออยู่</div></div></div>
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.noBuyFillCount}</div><div class="label">No buy fill</div></div></div>
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.maxConcurrentSkipCount || 0}</div><div class="label">Skip (เต็ม)</div></div></div>
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.belowMinNotionalCount || 0}</div><div class="label">Below min</div></div></div>
          <div class="col-md-2"><div class="stat-tile small-tile"><div class="value">${s.wins}/${s.losses}</div><div class="label">W/L</div></div></div>
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
    { symbol: 'BTCUSDT', timeframe: '5m', tpPercent: 0.1, kcMult: 1.5, capitalPerTrade: 10, maxConcurrentTrades: 5 },
    { symbol: 'ETHUSDT', timeframe: '5m', tpPercent: 0.1, kcMult: 1.5, capitalPerTrade: 10, maxConcurrentTrades: 5 },
  ];
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
      <button class="mb-del" data-i="${idx}" title="ลบบอท">✕</button>
    `;
    container.appendChild(el);
  });
  container.querySelectorAll('select,input').forEach((el) => {
    el.addEventListener('change', (e) => {
      const i = parseInt(e.target.dataset.i, 10);
      const k = e.target.dataset.k;
      const v = e.target.type === 'number' ? parseFloat(e.target.value) : e.target.value;
      mbState.rows[i][k] = v;
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
  const pnlCls = (s.netPnl || 0) >= 0 ? 'mb-bull' : 'mb-bear';

  const summary = `
    <div class="lux-card mb-3" style="border: 1px solid rgba(245,184,0,0.3);">
      <div class="lux-header">
        <span class="title">📊 Multi-Bot Combined Result · ${ms}ms</span>
        <span class="text-muted-3" style="font-size:0.8rem;">ทุนรวม $${totalCapital} · Peak ใช้ $${(combined.peakCapitalUsed || 0).toFixed(2)} (${Math.round(((combined.peakCapitalUsed || 0) / totalCapital) * 100)}%)</span>
      </div>
      <div class="lux-body">
        <div class="mb-result-summary">
          <div class="stat-tile ${pnlCls}"><div class="tile-label">Total PnL</div><div class="tile-value">${(s.netPnl || 0).toFixed(4)}</div><div class="tile-sub">USDT</div></div>
          <div class="stat-tile is-gold"><div class="tile-label">Win Rate</div><div class="tile-value">${(s.winRate || 0)}%</div><div class="tile-sub">${s.wins || 0}W / ${s.losses || 0}L</div></div>
          <div class="stat-tile is-info"><div class="tile-label">Trades</div><div class="tile-value">${combined.tradesCount || 0}</div><div class="tile-sub">ไม้รวม</div></div>
          <div class="stat-tile is-info"><div class="tile-label">Peak ไม้พร้อมกัน</div><div class="tile-value">${combined.peakConcurrentTrades || 0}</div><div class="tile-sub">ข้ามทุกบอท</div></div>
          <div class="stat-tile ${(combined.skippedCapitalCount || 0) > 0 ? 'is-gold' : ''}"><div class="tile-label">Skip (ทุนเต็ม)</div><div class="tile-value">${combined.skippedCapitalCount || 0}</div><div class="tile-sub">สัญญาณที่ถูก skip</div></div>
          <div class="stat-tile is-gold"><div class="tile-label">Avg PnL/ไม้</div><div class="tile-value">${(s.avgPnl || 0).toFixed(4)}</div><div class="tile-sub">USDT</div></div>
        </div>
      </div>
    </div>
  `;

  const botRows = perBot.map((b) => {
    const bs = b.stats || {};
    const cls = (bs.netPnl || 0) >= 0 ? 'mb-bull' : 'mb-bear';
    return `<div class="mb-bot-row">
      <div><strong>${escapeHtml(b.symbol)}</strong> <span class="text-muted-3" style="font-size:0.85em;">${b.timeframe} · TP ${b.tpPercent}% · KC×${b.kcMult ?? 1.5} · $${b.capitalPerTrade}/ไม้ · max ${b.maxConcurrentTrades}</span></div>
      <div class="${cls}">${(bs.netPnl || 0).toFixed(4)}</div>
      <div>${bs.trades || 0} <span class="mb-skip-note">(${b.skippedCount || 0} skip)</span></div>
      <div>${bs.wins || 0}W/${bs.losses || 0}L</div>
      <div>${bs.winRate || 0}%</div>
      <div>${(bs.avgPnl || 0).toFixed(4)}</div>
    </div>`;
  }).join('');

  out.innerHTML = summary + `
    <div class="lux-card">
      <div class="lux-header"><span class="title">🤖 Per-Bot Breakdown</span></div>
      <div class="lux-body">
        <div class="mb-bot-row" style="font-weight:700;color:var(--text-3);text-transform:uppercase;font-size:0.78em;">
          <div>Bot</div>
          <div>PnL (USDT)</div>
          <div>Trades</div>
          <div>W/L</div>
          <div>Win%</div>
          <div>Avg/ไม้</div>
        </div>
        ${botRows}
      </div>
    </div>
  `;
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
  document.getElementById('mb-add-row').addEventListener('click', () => {
    // FIX-2026-07-30: copy config จากแถวล่าสุด (เพื่อให้ตั้งค่าเหมือนกันแค่เปลี่ยน symbol)
    const last = mbState.rows[mbState.rows.length - 1];
    const newRow = last
      ? { ...last }
      : { symbol: mbState.symbols[0] || 'BTCUSDT', timeframe: '5m', tpPercent: 0.1, capitalPerTrade: 10, maxConcurrentTrades: 5 };
    mbState.rows.push(newRow);
    mbRenderRows();
  });
  document.getElementById('mb-run').addEventListener('click', mbRun);
}

init();