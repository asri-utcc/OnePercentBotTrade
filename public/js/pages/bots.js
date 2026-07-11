'use strict';

let bots = [];

async function init() {
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me || !me.authenticated) {
    location.href = '/login.html';
    return;
  }

  WSClient.start();
  setupEventHandlers();
  await loadSymbols();
  await loadBots();
  await loadBalance();
  await loadApiKeysStatus();

  WSClient.on('bot:status', (p) => {
    const bot = bots.find((b) => b._id === p.botId);
    if (bot) {
      bot.status = p.status;
      renderBots();
    }
  });
  WSClient.on('bot:updated', () => loadBots());
  WSClient.on('trade:update', () => loadBots());
  WSClient.on('health:update', (s) => renderHeartbeat(s));

  // โหลด health ครั้งแรก (กรณี WS ยังไม่ติด)
  API.get('/api/health').then((s) => renderHeartbeat(s)).catch(() => {});

  document.getElementById('logout-btn').onclick = async (e) => {
    e.preventDefault();
    await API.post('/api/auth/logout', {});
    location.href = '/login.html';
  };
}

function setupEventHandlers() {
  document.getElementById('new-bot-btn').onclick = () => {
    document.getElementById('nb-error').textContent = '';
    document.getElementById('nb-total').textContent = '';
    updateNewBotTotal();
  };

  ['nb-capital', 'nb-maxtrades'].forEach((id) => {
    document.getElementById(id).addEventListener('input', updateNewBotTotal);
  });

  document.getElementById('nb-create').onclick = createBot;
  document.getElementById('refresh-balance').onclick = loadBalance;
  document.getElementById('ak-save').onclick = saveApiKeys;
}

function updateNewBotTotal() {
  const cap = parseFloat(document.getElementById('nb-capital').value) || 0;
  const max = parseInt(document.getElementById('nb-maxtrades').value) || 0;
  document.getElementById('nb-total').textContent = `ทุนรวมที่ต้องเตรียม: ${(cap * max).toFixed(2)} USDT`;
}

async function loadSymbols() {
  try {
    const resp = await API.get('/api/bots/symbols');
    const select = document.getElementById('nb-symbol');
    select.innerHTML = '';
    for (const s of resp.symbols) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === 'BNBUSDT') opt.selected = true;
      select.appendChild(opt);
    }
  } catch (err) {
    console.error('loadSymbols', err);
  }
}

async function loadBots() {
  try {
    const resp = await API.get('/api/bots');
    bots = resp.bots;
    renderBots();
    renderStats();
  } catch (err) {
    console.error('loadBots', err);
  }
}

async function loadBalance() {
  try {
    const resp = await API.get('/api/account/balance');
    const usdt = resp.balances.find((b) => b.asset === 'USDT');
    const bnb = resp.balances.find((b) => b.asset === 'BNB');
    const others = resp.balances.filter((b) => !['USDT', 'BNB'].includes(b.asset) && b.total > 0);
    document.getElementById('balance-summary').innerHTML = `
      <strong>USDT:</strong> ${usdt ? usdt.total.toFixed(2) : '0.00'}
      ${bnb ? ` | <strong>BNB:</strong> ${bnb.total.toFixed(4)}` : ''}
      ${others.length > 0 ? ` | <strong>อื่นๆ:</strong> ${others.length} assets` : ''}
    `;
  } catch (err) {
    document.getElementById('balance-summary').textContent = `(ไม่สามารถโหลด: ${err.message})`;
  }
}

async function loadApiKeysStatus() {
  try {
    const resp = await API.get('/api/auth/api-keys/status');
    if (!resp.configured) {
      document.getElementById('show-api-keys-modal').classList.add('btn-danger');
      document.getElementById('show-api-keys-modal').classList.remove('btn-outline-warning');
    } else {
      document.getElementById('show-api-keys-modal').classList.remove('btn-danger');
      document.getElementById('show-api-keys-modal').classList.add('btn-outline-warning');
      document.getElementById('ak-bnb').checked = !!resp.useBnbForFees;
    }
  } catch (err) { /* ignore */ }
}

function renderBots() {
  const container = document.getElementById('bots-list');
  if (bots.length === 0) {
    container.innerHTML = '<div class="alert alert-secondary">ยังไม่มีบอท — คลิก <strong>+ New Bot</strong> เพื่อเริ่มต้น</div>';
    return;
  }
  container.innerHTML = bots.map((b) => {
    const statusClass = b.enabled ? 'enabled' : '';
    const statusBadge = statusPillHtml(b.status);
    const pnl = b.totalPnl || 0;
    const pnlClass = pnl > 0 ? 'pnl-bull' : pnl < 0 ? 'pnl-bear' : '';
    return `
      <div class="bot-card ${statusClass}" data-bot-id="${b._id}">
        <div class="row1">
          <div class="left">
            <span class="name">${escapeHtml(b.name || b.symbol)}</span>
            <span class="sym-tag">${b.symbol}</span>
            <span class="tf-tag">${b.timeframe}</span>
            ${statusBadge}
          </div>
          <div class="right">
            <a href="/bot-detail.html?id=${b._id}" class="btn-lux btn-info btn-sm">📊 Detail</a>
            <a href="/bot-edit.html?id=${b._id}" class="btn-lux btn-gold btn-sm">⚙️ Edit</a>
            ${b.enabled
              ? `<button class="btn-lux btn-sm" onclick="toggleBot('${b._id}', false)">⏸ หยุด</button>`
              : `<button class="btn-lux btn-bull btn-sm" onclick="toggleBot('${b._id}', true)">▶ เริ่ม</button>`}
            <button class="btn-lux btn-bear btn-sm" onclick="deleteBot('${b._id}')">🗑</button>
          </div>
        </div>
        <div class="row2">
          <span class="pair"><span>ทุน:</span><strong>$${b.capitalPerTrade} × ${b.maxTrades} = $${b.totalCapital.toFixed(2)}</strong></span>
          <span class="pair"><span>TP:</span><strong>${b.tpPercent}%</strong></span>
          <span class="pair"><span>Retry:</span><strong>${b.retryTimeMin}m · max ${b.retryMax ?? 1}</strong></span>
          <span class="pair"><span>PnL:</span><strong class="${pnlClass}">${pnl.toFixed(4)} USDT</strong></span>
          <span class="pair"><span>Trades:</span><strong>${b.totalTrades || 0} (W ${b.winTrades || 0})</strong></span>
        </div>
        ${b.lastError ? `<div class="last-err">⚠️ ${escapeHtml(b.lastError)}</div>` : ''}
      </div>`;
  }).join('');
}

function statusPillHtml(status) {
  const cls = (status || 'idle').toLowerCase();
  return `<span class="status-pill is-${cls}">${cls}</span>`;
}

function renderStats() {
  const enabled = bots.filter((b) => b.enabled).length;
  document.getElementById('stat-active').textContent = enabled;

  const totalTrades = bots.reduce((s, b) => s + (b.totalTrades || 0), 0);
  const totalWins = bots.reduce((s, b) => s + (b.winTrades || 0), 0);
  const totalPnl = bots.reduce((s, b) => s + (b.totalPnl || 0), 0);
  const losses = Math.max(0, totalTrades - totalWins);

  document.getElementById('stat-trades').textContent = totalTrades;
  const wr = totalTrades > 0 ? ((totalWins / totalTrades) * 100) : 0;
  document.getElementById('stat-winrate').textContent = `${wr.toFixed(1)}%`;
  document.getElementById('stat-winrate-sub').textContent = `${totalWins} wins · ${losses} losses`;

  const tile = document.getElementById('tile-pnl');
  tile.classList.remove('is-bull', 'is-bear', 'is-gold');
  if (totalPnl > 0) tile.classList.add('is-bull');
  else if (totalPnl < 0) tile.classList.add('is-bear');
  else tile.classList.add('is-gold');

  const pnlEl = document.getElementById('stat-pnl');
  pnlEl.textContent = totalPnl.toFixed(4);
  pnlEl.className = 'value ' + (totalPnl > 0 ? 'pnl-bull' : totalPnl < 0 ? 'pnl-bear' : '');
}

async function createBot() {
  const data = {
    name: document.getElementById('nb-name').value || undefined,
    symbol: document.getElementById('nb-symbol').value,
    timeframe: document.getElementById('nb-timeframe').value,
    capitalPerTrade: parseFloat(document.getElementById('nb-capital').value),
    maxTrades: parseInt(document.getElementById('nb-maxtrades').value, 10),
    tpPercent: parseFloat(document.getElementById('nb-tp').value),
    retryTimeMin: parseInt(document.getElementById('nb-retry').value, 10),
    retryMax: parseInt(document.getElementById('nb-retry-max').value, 10),
  };
  try {
    await API.post('/api/bots', data);
    bootstrap.Modal.getInstance(document.getElementById('newBotModal')).hide();
    await loadBots();
  } catch (err) {
    document.getElementById('nb-error').textContent = err.message;
  }
}

window.toggleBot = async (id, enable) => {
  try {
    await API.post(`/api/bots/${id}/${enable ? 'enable' : 'disable'}`, {});
    await loadBots();
  } catch (err) {
    alert(err.message);
  }
};

window.deleteBot = async (id) => {
  if (!confirm('ลบบอทนี้?')) return;
  try {
    await API.del(`/api/bots/${id}`);
    await loadBots();
  } catch (err) {
    alert(err.message);
  }
};

async function saveApiKeys() {
  const binanceApiKey = document.getElementById('ak-key').value;
  const binanceApiSecret = document.getElementById('ak-secret').value;
  const useBnbForFees = document.getElementById('ak-bnb').checked;
  try {
    await API.put('/api/auth/api-keys', { binanceApiKey, binanceApiSecret, useBnbForFees });
    bootstrap.Modal.getInstance(document.getElementById('apiKeysModal')).hide();
    await loadApiKeysStatus();
    await loadBalance();
    alert('บันทึก API keys แล้ว — กรุณา restart server เพื่อให้ User Data Stream ทำงาน');
  } catch (err) {
    document.getElementById('ak-error').textContent = err.message;
  }
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Heartbeat rendering ─────────────────────────────
function setHb(pillId, ok, extra) {
  const el = document.getElementById(pillId);
  if (!el) return;
  const dot = el.querySelector('.hb-dot');
  // remove old classes
  el.classList.remove('is-ok', 'is-warning', 'is-error');
  dot.classList.remove('bg-ok', 'bg-warning', 'bg-error');
  if (ok === true) {
    el.classList.add('is-ok');
    dot.classList.add('bg-ok');
  } else if (ok === 'warning') {
    el.classList.add('is-warning');
    dot.classList.add('bg-warning');
  } else if (ok === false) {
    el.classList.add('is-error');
    dot.classList.add('bg-error');
  } else {
    dot.classList.remove('bg-ok', 'bg-warning', 'bg-error');
  }
  if (extra !== undefined) {
    const labelEl = el.querySelector('.hb-label');
    if (labelEl) labelEl.innerHTML = extra;
  }
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

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function renderHeartbeat(status) {
  if (!status || !status.components) return;

  const c = status.components;

  // Overall
  const overallOk = status.overall === 'ok' ? true : (status.overall === 'warning' ? 'warning' : false);
  setHb('hb-overall', overallOk, `Overall: <strong>${status.overall}</strong>`);

  // MongoDB
  if (c.mongodb) setHb('hb-mongodb', c.mongodb.ok, `MongoDB: <strong>${c.mongodb.state}</strong>`);

  // Binance REST
  if (c.binanceRest) {
    const binanceLabel = c.binanceRest.hasApiKeys
      ? `Binance API: ${c.binanceRest.ok ? '✅' : '❌'} ${c.binanceRest.latencyMs ? c.binanceRest.latencyMs + 'ms' : ''}`
      : `Binance API: ⚠️ no keys`;
    setHb('hb-binance', c.binanceRest.ok && c.binanceRest.hasApiKeys ? true : (c.binanceRest.hasApiKeys ? false : 'warning'), binanceLabel);
  }

  // Market WS
  if (c.marketWs) setHb('hb-marketws', c.marketWs.ok, `Market WS: <strong>${c.marketWs.subscribedStreams}</strong> streams`);

  // User Data Stream
  if (c.userDataWs) setHb('hb-userws', c.userDataWs.ok, `User Stream: <strong>${c.userDataWs.ok ? 'live' : 'off'}</strong>`);

  // Bots
  if (c.botManager) {
    setText('hb-bots-count', c.botManager.activeTraders);
    setHb('hb-bots', c.botManager.running, `Bots: <strong>${c.botManager.activeTraders}</strong> active`);
  }

  // Uptime + ts
  setText('hb-uptime', `Uptime: ${formatUptime(status.uptimeSec)}`);
  setText('hb-ts', status.ts ? new Date(status.ts).toLocaleTimeString() : '-');
}

init();