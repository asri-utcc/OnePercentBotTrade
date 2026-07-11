'use strict';

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

  document.getElementById('result').innerHTML = '<div class="alert alert-info">กำลังรัน backtest...</div>';

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

  document.getElementById('result').innerHTML = `
    <div class="card">
      <div class="card-header"><strong>📊 ผล Backtest</strong> — ${params.symbol} ${params.timeframe} (${params.from} → ${params.to})</div>
      <div class="card-body">
        <div class="row g-2 mb-3">
          <div class="col-md-2"><div class="stat-tile"><div class="value">${resp.signalsCount}</div><div class="label">Signals (S1)</div></div></div>
          <div class="col-md-2"><div class="stat-tile"><div class="value ${fillClass}">${s.fillRate.toFixed(1)}%</div><div class="label">Buy Fill Rate</div></div></div>
          <div class="col-md-2"><div class="stat-tile"><div class="value ${exitClass}">${s.exitRate.toFixed(1)}%</div><div class="label">Exit Rate</div></div></div>
          <div class="col-md-2"><div class="stat-tile"><div class="value ${winClass}">${s.winRate.toFixed(1)}%</div><div class="label">Win Rate (realized)</div></div></div>
          <div class="col-md-2"><div class="stat-tile"><div class="value ${pnlClass}">${s.totalPnl.toFixed(4)}</div><div class="label">Total PnL (USDT)</div></div></div>
          <div class="col-md-2"><div class="stat-tile"><div class="value ${pnlClass}">${s.totalPnlPercent.toFixed(3)}%</div><div class="label">PnL %</div></div></div>
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

        <h6>ตัวอย่าง 20 ไม้แรก</h6>
        <table class="table table-sm table-striped">
          <thead>
            <tr>
              <th>Signal Time</th>
              <th>Buy</th>
              <th>Target</th>
              <th>Sell</th>
              <th>Buy</th>
              <th>Exit</th>
              <th>PnL</th>
              <th>%</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            ${resp.sample.map((t) => `
              <tr>
                <td>${new Date(t.signalTime).toLocaleString()}</td>
                <td>${t.buyPrice.toFixed(4)}</td>
                <td>${t.targetSellPrice.toFixed(4)}</td>
                <td>${t.sellPrice ? t.sellPrice.toFixed(4) : '-'}</td>
                <td>${t.buyFilled ? '✅' : '❌'}</td>
                <td>${t.sellFilled ? '✅' : '⏱'}</td>
                <td class="${(t.realizedPnl || 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}">${(t.realizedPnl || 0).toFixed(4)}</td>
                <td class="${(t.pnlPercent || 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}">${(t.pnlPercent || 0).toFixed(3)}%</td>
                <td><small class="text-muted">${t.exitReason || '-'}</small></td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <div class="alert alert-light small mt-2">
          <strong>ℹ️ Execution Model: <code>${resp.executionModel || 'unknown'}</code></strong> (No Stop Loss, max ${params.maxConcurrentTrades || 10} ไม้พร้อมกัน)
          <ul class="mb-1">
            <li><strong>BUY price</strong>: ใช้ <code>candle close</code> เป็น proxy สำหรับ <em>best bid</em> (บอทจริงใช้ bid จาก bookTicker WS ตอนปิดแท่ง → ต่ำกว่า close 1–10 bps ในตลาดผันผวน)</li>
            <li><strong>Buy Fill</strong>: นับเป็น fill เมื่อ <code>low ≤ P AND close ≥ P AND volume &gt; 0</code> (post-only bid ที่ wick ลงเด้งกลับจะไม่ถูกนับ fill) ภายใน 6 แท่ง — ถ้าไม่ fill คือยกเลิก → ไม่มี PnL</li>
            <li><strong>Buy timestamp</strong>: <code>openTime + stepMs/2</code> (กลางแท่ง) — สะท้อนว่า maker order มัก fill ระหว่างแท่ง ไม่ใช่ตอนปิด</li>
            <li><strong>Sell Fill</strong>: ต้องรอให้ราคาขึ้นไปแตะ target (future candle high ≥ target) — <strong>ไม่มี stop loss</strong> ถ้าไม่ fill → ถือต่อจนกว่าข้อมูลจะหมด (ยังไม่นับ PnL)</li>
            <li><strong>Slot Limit</strong>: ถ้าเปิดไม้ครบ ${params.maxConcurrentTrades || 10} → skip signal ใหม่ (ไม่เปิดเกิน)</li>
            <li><strong>Qty</strong>: floor ตาม stepSize ของ symbol (เช่น BNBUSDT = 0.01) — ถ้า notional &lt; minNotional จะ skip</li>
          </ul>
          ⚠️ ในชีวิตจริง ยังมี slippage, network delay, partial fills ที่โมเดลนี้ไม่ได้ครอบคลุม
        </div>
      </div>
    </div>
  `;
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
            <th>Signals</th><th>Fill%</th><th>Exit%</th><th>Win%</th><th>W/L</th><th>PnL</th><th>PnL %</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${resp.results.map((r) => {
            const pnlClass = (r.totalPnl || 0) >= 0 ? 'pnl-positive' : 'pnl-negative';
            const modelBadge = r.executionModel
              ? `<span class="badge bg-secondary" title="Execution model">${r.executionModel}</span>`
              : '<span class="text-muted small">unknown</span>';
            return `
              <tr>
                <td>${new Date(r.createdAt).toLocaleString()}</td>
                <td>${r.symbol}</td>
                <td>${r.timeframe}</td>
                <td>${new Date(r.from).toLocaleDateString()} - ${new Date(r.to).toLocaleDateString()}</td>
                <td>${modelBadge}</td>
                <td>${r.signalsCount}</td>
                <td>${(r.fillRate || 0).toFixed(0)}%</td>
                <td>${(r.exitRate || 0).toFixed(0)}%</td>
                <td>${(r.winRate || 0).toFixed(1)}%</td>
                <td>${r.wins || 0}/${r.losses || 0}</td>
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

init();