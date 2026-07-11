'use strict';

const urlParams = new URLSearchParams(location.search);
const botId = urlParams.get('id');
let bot = null;

async function init() {
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me || !me.authenticated) {
    location.href = '/login.html';
    return;
  }
  if (!botId) {
    location.href = '/bots.html';
    return;
  }

  await loadBot();
}

async function loadBot() {
  try {
    const resp = await API.get(`/api/bots/${botId}`);
    bot = resp.bot;
    render();
  } catch (err) {
    document.getElementById('bot-edit-content').innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

function render() {
  const container = document.getElementById('bot-edit-content');
  container.innerHTML = `
    <div class="lux-header"><span class="title">⚙️ ${escapeHtml(bot.name || bot.symbol)}</span><span class="text-muted-3" style="font-size:0.78rem;">${bot.symbol} · ${bot.timeframe}</span></div>
    <div class="lux-body">
    <form id="edit-form">
      <div class="mb-3">
        <label class="form-label">ชื่อบอท</label>
        <input type="text" class="form-control" id="f-name" value="${bot.name || ''}" />
      </div>
      <div class="row">
        <div class="col-md-6 mb-3">
          <label class="form-label">คู่เทรด (แก้ไม่ได้)</label>
          <input type="text" class="form-control" value="${bot.symbol}" disabled />
        </div>
        <div class="col-md-6 mb-3">
          <label class="form-label">Timeframe</label>
          <select class="form-select" id="f-timeframe">
            ${['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'].map((tf) =>
              `<option value="${tf}" ${tf === bot.timeframe ? 'selected' : ''}>${tf}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="row">
        <div class="col-md-6 mb-3">
          <label class="form-label">ทุนต่อไม้ (USDT)</label>
          <input type="number" class="form-control" id="f-capital" value="${bot.capitalPerTrade}" step="0.01" min="1" />
        </div>
        <div class="col-md-6 mb-3">
          <label class="form-label">จำนวนไม้</label>
          <input type="number" class="form-control" id="f-maxtrades" value="${bot.maxTrades}" step="1" min="1" max="100" />
        </div>
      </div>
      <div class="row">
        <div class="col-md-6 mb-3">
          <label class="form-label">TP %</label>
          <input type="number" class="form-control" id="f-tp" value="${bot.tpPercent}" step="0.01" min="0.001" />
          <small class="text-muted">บอทจะบวก fee buffer (0.15-0.2%) อัตโนมัติ</small>
        </div>
        <div class="col-md-6 mb-3">
          <label class="form-label">Retry time (นาที)</label>
          <input type="number" class="form-control" id="f-retry" value="${bot.retryTimeMin}" step="1" min="1" max="60" />
        </div>
      </div>
      <div class="row">
        <div class="col-md-6 mb-3">
          <label class="form-label">Retry max (ครั้งที่วางใหม่ได้)</label>
          <input type="number" class="form-control" id="f-retry-max" value="${bot.retryMax ?? 1}" step="1" min="0" max="10" />
          <small class="text-muted">0 = วางครั้งเดียว ไม่ retry; 1 = วางใหม่ได้ 1 ครั้งถ้า bid ขยับ</small>
        </div>
      </div>
      <div class="alert alert-info" id="f-total"></div>
      <div class="text-danger small mb-3" id="f-error"></div>
      <button type="submit" class="btn btn-primary">💾 บันทึก</button>
      <a href="/bots.html" class="btn btn-secondary ms-2">กลับ</a>
    </form>
    </div>
  `;

  document.getElementById('edit-form').onsubmit = save;
  ['f-capital', 'f-maxtrades'].forEach((id) => {
    document.getElementById(id).addEventListener('input', updateTotal);
  });
  updateTotal();
}

function updateTotal() {
  const cap = parseFloat(document.getElementById('f-capital').value) || 0;
  const max = parseInt(document.getElementById('f-maxtrades').value) || 0;
  document.getElementById('f-total').textContent = `ทุนรวมที่ต้องเตรียม: ${(cap * max).toFixed(2)} USDT`;
}

async function save(e) {
  e.preventDefault();
  document.getElementById('f-error').textContent = '';
  const data = {
    name: document.getElementById('f-name').value,
    timeframe: document.getElementById('f-timeframe').value,
    capitalPerTrade: parseFloat(document.getElementById('f-capital').value),
    maxTrades: parseInt(document.getElementById('f-maxtrades').value, 10),
    tpPercent: parseFloat(document.getElementById('f-tp').value),
    retryTimeMin: parseInt(document.getElementById('f-retry').value, 10),
    retryMax: parseInt(document.getElementById('f-retry-max').value, 10),
  };
  try {
    await API.put(`/api/bots/${botId}`, data);
    alert('บันทึกแล้ว');
    await loadBot();
  } catch (err) {
    document.getElementById('f-error').textContent = err.message;
  }
}

init();

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}