'use strict';

/**
 * Shared top navigation partial.
 * Renders into <nav class="app-nav" id="app-nav"></nav> on every page.
 *
 * Pages set window.NAV_ACTIVE = 'bots' | 'chart' | 'backtest' | 'detail'
 * Pages set window.NAV_BOT_ID = '...' (optional, for detail page)
 */

(function renderNav() {
  const active = window.NAV_ACTIVE || '';
  const botId = window.NAV_BOT_ID || '';
  const detailLabel = window.NAV_DETAIL_LABEL || 'Bot Detail';

  const links = [
    { key: 'bots',     href: '/bots.html',     label: '🤖 Bots' },
    { key: 'detail',   href: botId ? `/bot-detail.html?id=${botId}` : '/bots.html', label: '📊 Detail' },
    { key: 'chart',    href: '/chart.html',    label: '📈 Chart' },
    { key: 'backtest', href: '/backtest.html', label: '🧪 Backtest' },
  ].filter((l) => l.key !== 'detail' || botId); // hide detail if no botId

  const desktopHtml = `
    <div class="d-flex align-items-center gap-2 flex-wrap" style="max-width: 1400px; margin: 0 auto;">
      <a class="brand" href="/bots.html">
        <span class="brand-mark"></span>
        <span>OnePercent<span style="color:var(--gold-1);">%</span>BotTrade</span>
      </a>
      <nav class="desktop-menu d-none d-md-flex align-items-center gap-1 ms-3">
        ${links.map((l) => `<a class="nav-pill ${active === l.key ? 'active' : ''}" href="${l.href}">${l.label}</a>`).join('')}
      </nav>
      <div class="ms-auto d-flex align-items-center gap-2">
        <span class="ws-status" id="ws-status"><span class="ws-dot"></span><span id="ws-status-label">offline</span></span>
        ${active !== 'login' ? `<button class="btn-lux btn-sm" id="logout-btn" type="button">Logout</button>` : ''}
        <button class="nav-toggle d-md-none" type="button" id="nav-toggle" aria-label="Toggle menu">☰</button>
      </div>
    </div>
    <div class="mobile-menu d-md-none" id="mobile-menu" style="display:none;">
      <div class="d-flex flex-column gap-1">
        ${links.map((l) => `<a class="nav-pill ${active === l.key ? 'active' : ''}" href="${l.href}">${l.label}</a>`).join('')}
      </div>
    </div>`;

  const target = document.getElementById('app-nav');
  if (target) target.innerHTML = desktopHtml;

  // hamburger toggle
  const toggle = document.getElementById('nav-toggle');
  const menu = document.getElementById('mobile-menu');
  if (toggle && menu) {
    toggle.addEventListener('click', () => {
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });
  }

  // logout handler (if present)
  const lo = document.getElementById('logout-btn');
  if (lo) {
    lo.addEventListener('click', async (e) => {
      e.preventDefault();
      try { await API.post('/api/auth/logout', {}); } catch (_) {}
      location.href = '/login.html';
    });
  }

  // ws status pill class swap
  const wsEl = document.getElementById('ws-status');
  const wsLabel = document.getElementById('ws-status-label');
  // hook into WSClient._setStatus if present
  if (typeof WSClient !== 'undefined') {
    const orig = WSClient._setStatus.bind(WSClient);
    WSClient._setStatus = function (text) {
      if (wsLabel) wsLabel.textContent = text.replace(/^[^\w]+/, '').trim() || text;
      if (wsEl) {
        wsEl.classList.remove('live', 'dead');
        if (/🟢|live|connected/i.test(text)) wsEl.classList.add('live');
        else if (/🔴|offline|reconnect|dead|error/i.test(text)) wsEl.classList.add('dead');
      }
    };
  }
})();