'use strict';

const BOT_ID = new URLSearchParams(location.search).get('id');
let detail = null;
let refreshTimer = null;

const STATE_COLORS = {
  placed: 'warning',
  filled: 'info',
  retrying: 'warning',
  cancelled: 'secondary',
  holding: 'info',
  selling: 'info',
  sold: 'success',
  failed: 'danger',
};
const OUTCOME_COLORS = {
  detected: 'secondary',
  order_placed: 'warning',
  filled: 'success',
  expired: 'secondary',
  failed: 'danger',
  skipped: 'secondary',
};

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
  setupButtons();
  await refresh();

  // subscribe to live updates for this bot
  WSClient.on('bot:status', (p) => {
    if (p.botId === BOT_ID && detail) {
      detail.bot.status = p.status;
      renderHeader();
    }
  });
  WSClient.on('trade:update', (p) => {
    if (detail && p.tradeId && detail.trades.some((t) => t._id === p.tradeId)) {
      refresh();
    }
  });
  WSClient.on('bot:updated', () => refresh());

  // auto-refresh every 10s
  refreshTimer = setInterval(refresh, 10000);

  document.getElementById('logout-btn').onclick = async (e) => {
    e.preventDefault();
    await API.post('/api/auth/logout', {});
    location.href = '/login.html';
  };
}

function setupButtons() {
  document.getElementById('refresh-btn').onclick = refresh;
  document.getElementById('edit-btn').href = `/bot-edit.html?id=${BOT_ID}`;
  document.getElementById('enable-btn').onclick = async () => {
    await API.post(`/api/bots/${BOT_ID}/enable`, {});
    await refresh();
  };
  document.getElementById('disable-btn').onclick = async () => {
    await API.post(`/api/bots/${BOT_ID}/disable`, {});
    await refresh();
  };
}

async function refresh() {
  try {
    detail = await API.get(`/api/bots/${BOT_ID}/details?limit=50`);
    renderAll();
  } catch (err) {
    console.error('refresh failed', err);
    if (err.message && err.message.includes('not found')) {
      alert('Bot not found');
      location.href = '/bots.html';
    }
  }
}

function renderAll() {
  renderHeader();
  renderStats();
  renderConfig();
  renderActiveTrade();
  renderTrades();
  renderSignals();
}

function renderHeader() {
  const bot = detail.bot;
  document.getElementById('bot-name').textContent = bot.name || `${bot.symbol} ${bot.timeframe}`;
  document.getElementById('bot-name-link').textContent = bot.name || `${bot.symbol} ${bot.timeframe}`;
  document.title = `${bot.name || bot.symbol} - Bot Detail`;
  document.getElementById('bot-symbol').textContent = bot.symbol;
  document.getElementById('bot-tf').textContent = bot.timeframe;
  document.getElementById('bot-status-badge').innerHTML = statusBadgeHtml(bot.status);
  document.getElementById('enable-btn').style.display = bot.enabled ? 'none' : 'inline-block';
  document.getElementById('disable-btn').style.display = bot.enabled ? 'inline-block' : 'none';
}

function renderStats() {
  const bot = detail.bot;
  const totalPnl = bot.totalPnl || 0;
  const totalTrades = bot.totalTrades || 0;
  const wins = bot.winTrades || 0;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0';
  const activeCount = detail.trades.filter((t) =>
    ['placed', 'filled', 'holding', 'selling', 'retrying'].includes(t.state)
  ).length;

  const pnlEl = document.getElementById('stat-pnl');
  pnlEl.textContent = totalPnl.toFixed(4);
  pnlEl.className = `value ${totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`;
  document.getElementById('stat-trades').textContent = totalTrades;
  document.getElementById('stat-winrate').textContent = `${winRate}%`;
  document.getElementById('stat-active').textContent = `${activeCount} / ${bot.maxTrades}`;
}

function renderConfig() {
  const bot = detail.bot;
  document.getElementById('cfg-symbol').textContent = bot.symbol;
  document.getElementById('cfg-tf').textContent = bot.timeframe;
  document.getElementById('cfg-cap').textContent = `${bot.capitalPerTrade} USDT`;
  document.getElementById('cfg-max').textContent = bot.maxTrades;
  document.getElementById('cfg-total').textContent = `${(bot.capitalPerTrade * bot.maxTrades).toFixed(2)} USDT`;
  document.getElementById('cfg-tp').textContent = `${bot.tpPercent}%`;
  document.getElementById('cfg-retry-time').textContent = `${bot.retryTimeMin} นาที`;
  document.getElementById('cfg-retry-max').textContent = `${bot.retryMax ?? 1} ครั้ง`;
  document.getElementById('cfg-enabled').innerHTML = bot.enabled
    ? '<span class="badge bg-success">enabled</span>'
    : '<span class="badge bg-secondary">disabled</span>';
  document.getElementById('cfg-last-signal').textContent = bot.lastSignalAt
    ? new Date(bot.lastSignalAt).toLocaleString()
    : '-';
  document.getElementById('cfg-last-error').textContent = bot.lastError || '-';
}

function renderActiveTrade() {
  const body = document.getElementById('active-trade-body');
  const t = detail.activeTrade;
  if (!t) {
    body.innerHTML = '<div class="text-muted">ไม่มี active trade</div>';
    return;
  }
  const ageMs = Date.now() - new Date(t.createdAt).getTime();
  const ageMin = Math.floor(ageMs / 60000);
  const ageSec = Math.floor((ageMs % 60000) / 1000);
  body.innerHTML = `
    <table class="table table-sm mb-0">
      <tbody>
        <tr><th>State</th><td><span class="badge bg-${STATE_COLORS[t.state] || 'secondary'}">${t.state}</span></td></tr>
        <tr><th>Symbol</th><td>${t.symbol} ${t.timeframe}</td></tr>
        <tr><th>BUY OrderId</th><td><code>${t.buyOrderId || '-'}</code></td></tr>
        <tr><th>BUY Price</th><td>${t.buyPrice ?? '-'}</td></tr>
        <tr><th>BUY Qty</th><td>${t.buyQty ?? '-'}</td></tr>
        <tr><th>BUY Status</th><td><span class="badge bg-${STATE_COLORS[t.buyStatus?.toLowerCase()] || 'secondary'}">${t.buyStatus || '-'}</span></td></tr>
        <tr><th>BUY Placed</th><td>${t.buyPlacedAt ? new Date(t.buyPlacedAt).toLocaleTimeString() : '-'}</td></tr>
        <tr><th>SELL OrderId</th><td><code>${t.sellOrderId || '-'}</code></td></tr>
        <tr><th>Target Sell</th><td>${t.targetSellPrice ?? '-'}</td></tr>
        <tr><th>Retry count</th><td>${t.retryCount ?? 0} / ${detail.bot.retryMax ?? 1}</td></tr>
        <tr><th>Age</th><td>${ageMin}m ${ageSec}s</td></tr>
        <tr><th>Note</th><td class="text-danger small">${escapeHtml(t.error || '')}</td></tr>
      </tbody>
    </table>`;
}

function renderTrades() {
  const tbody = document.getElementById('trades-tbody');
  document.getElementById('trades-count').textContent = detail.trades.length;
  if (detail.trades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted p-3">ยังไม่มี trades</td></tr>';
    return;
  }
  tbody.innerHTML = detail.trades.map((t) => {
    const pnlClass = (t.realizedPnl || 0) >= 0 ? 'pnl-positive' : 'pnl-negative';
    const pnlText = t.realizedPnl != null ? `${t.realizedPnl.toFixed(4)} (${(t.pnlPercent || 0).toFixed(3)}%)` : '-';
    return `
      <tr>
        <td><small>${new Date(t.createdAt).toLocaleString()}</small></td>
        <td><span class="badge bg-${STATE_COLORS[t.state] || 'secondary'}">${t.state}</span></td>
        <td>${t.buyPrice ? `BUY ${t.buyPrice.toFixed(4)}` : '-'}${t.sellPrice ? ` → SELL ${t.sellPrice.toFixed(4)}` : ''}</td>
        <td>${t.buyPrice?.toFixed(4) ?? '-'}</td>
        <td>${t.buyQty?.toFixed(6) ?? '-'}</td>
        <td><small>${t.buyStatus || ''}${t.sellStatus ? ` → ${t.sellStatus}` : ''}</small></td>
        <td>${t.retryCount ?? 0}</td>
        <td class="${pnlClass}"><small>${pnlText}</small></td>
        <td><small><code>${t.buyOrderId || '-'}</code></small></td>
      </tr>`;
  }).join('');
}

function renderSignals() {
  const tbody = document.getElementById('signals-tbody');
  document.getElementById('signals-count').textContent = detail.signals.length;
  if (detail.signals.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted p-3">ยังไม่มี signals</td></tr>';
    return;
  }
  tbody.innerHTML = detail.signals.map((s) => `
    <tr>
      <td><small>${new Date(s.createdAt).toLocaleString()}</small></td>
      <td><span class="badge bg-info">${s.type}</span></td>
      <td>${s.closePrice?.toFixed(4) ?? '-'}</td>
      <td><small>${s.bgPrev} → ${s.bgState}</small></td>
      <td>${s.upperKC?.toFixed(4) ?? '-'}</td>
      <td>${s.lowerKC?.toFixed(4) ?? '-'}</td>
      <td><span class="badge bg-${OUTCOME_COLORS[s.outcome] || 'secondary'}">${s.outcome}</span></td>
      <td><small class="text-muted">${escapeHtml(s.note || '')}</small></td>
    </tr>`).join('');
}

function statusBadgeHtml(status) {
  const colors = {
    idle: 'secondary', waiting_fill: 'warning', holding: 'info',
    selling: 'info', error: 'danger', disabled: 'secondary',
  };
  return `<span class="badge bg-${colors[status] || 'secondary'}">${status}</span>`;
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();