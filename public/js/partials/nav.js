'use strict';

/**
 * Shared top navigation partial.
 * Renders into <nav class="app-nav" id="app-nav"></nav> on every page.
 *
 * Pages set window.NAV_ACTIVE = 'bots' | 'chart' | 'backtest' | 'detail'
 * Pages set window.NAV_BOT_ID = '...' (optional, for detail page)
 * Pages set window.NAV_DETAIL_LABEL = '...' (optional, label for detail pill)
 *
 * The balance pill shows live USDT + THB equivalent, refreshed:
 *   • On initial page load (via /api/account/balance + /api/fx/usdt-thb)
 *   • Every 60s (polling fallback)
 *   • On WS event 'account:update' / 'balance:update' (when Binance user data stream fires)
 *
 * FX rate is cached client-side for 5 minutes (server TTL is 10 min).
 */

(function renderNav() {
  const active = window.NAV_ACTIVE || '';
  const botId = window.NAV_BOT_ID || '';
  const detailLabel = window.NAV_DETAIL_LABEL || 'Bot Detail';

  const allLinks = [
    { key: 'bots',          href: '/bots.html',     label: '🤖 Bots' },
    { key: 'detail',        href: botId ? `/bot-detail.html?id=${botId}` : '/bots.html', label: '📊 Detail' },
    { key: 'chart-monitor', href: '/chart-monitor.html', label: '📊 Chart Monitor' }, // 2026-08-06: grid of mini-charts for running bots
    { key: 'chart',         href: '/chart.html',    label: '📈 Chart' },
    { key: 'backtest',      href: '/backtest.html', label: '🧪 Backtest' },
    { key: 'scan',          href: '/scan-volatility.html', label: '🎰 Scan' },
    { key: 'pnl',           href: '/pnl.html',      label: '📅 PnL' },               // FIX-2026-07-29
    { key: 'history',       href: '/history.html',  label: '📜 History' },           // FIX-2026-07-24
    { key: 'analysis',      href: '/trade-analysis.html', label: '📊 Trade Analysis' }, // FIX-2026-08-21: comprehensive analysis page
    { key: 'wallet',        href: '/wallet.html',   label: '💼 Wallet' },            // 2026-08-19: holdings + USDT reserve
    { key: 'security',      href: '/password-sessions.html', label: '🔑 Security' }, // 2026-08-09: Password & Sessions Manager
    { key: 'settings',      href: '/settings.html', label: '⚙️ Settings' },          // FIX-2026-07-24
    { key: 'chat',          href: '/chat.html',     label: '💬 Chat' },              // Phase 4-2026-08-29: community + DM
  ];
  // FIX-2026-08-28 B6: hide chart-monitor link when license disables it
  //   - features fetched from /api/license/info (already exposed, no new endpoint)
  //   - default ON if license missing (legacy compat) — see licenseService.isFeatureEnabled
  let _licenseFeatures = window.__licenseFeatures || null;
  try {
    const cached = sessionStorage.getItem('__licenseFeatures');
    if (cached) _licenseFeatures = JSON.parse(cached);
  } catch (_) {}
  let links = allLinks;
  if (_licenseFeatures && _licenseFeatures.chartMonitor === false) {
    links = links.filter((l) => l.key !== 'chart-monitor');
  }
  // hide detail if no botId
  links = links.filter((l) => l.key !== 'detail' || botId);

  const desktopHtml = `
    <div class="d-flex align-items-center gap-2 flex-wrap" style="max-width: 1400px; margin: 0 auto;">
      <a class="brand" href="/chart-monitor.html">
        <img src="/favicon.svg" alt="OnePercentBotTrade" class="brand-logo" />
        <span>OnePercent<span style="color:var(--gold-1);">%</span>BotTrade</span>
      </a>
      <nav class="desktop-menu d-none d-md-flex align-items-center gap-1 ms-3">
        ${links.map((l) => `<a class="nav-pill ${active === l.key ? 'active' : ''}" href="${l.href}">${l.label}</a>`).join('')}
      </nav>
      <div class="ms-auto d-flex align-items-center gap-2">
        <span class="balance-pill" id="nav-balance" title="ยอด USDT จาก Binance + �่าเงิน THB">
          <span class="balance-icon">💰</span>
          <span class="balance-text" id="nav-balance-text">
            <span class="balance-usdt" id="nav-balance-usdt">…</span>
            <span class="balance-thb" id="nav-balance-thb" style="display:none;"></span>
          </span>
        </span>
        <span class="balance-reserve-pill" id="nav-reserve-pill" title="USDT ที่กั๊กไว้ — บอทใช้ไม่ได้" style="display:none;">
          <span class="reserve-glyph">🛡</span>
          <span class="reserve-text" id="nav-reserve-text">0</span>
        </span>
        <span class="ws-status" id="ws-status"><span class="ws-dot"></span><span id="ws-status-label">offline</span></span>
        <!-- FIX-2026-08-27 Phase 3a: consent status REMOVED from navbar (per user feedback —
             annoying clutter). Users can check consent status on the Settings page
             under the 🛡️ Consent & License group. -->
        <!-- FIX-2026-08-26: bot version pill — surfaces the running version to the user -->
        <span class="version-pill" id="nav-version" title="Bot version ที่กำลังรันอยู่">v…</span>
        <!-- Phase 4-2026-08-29: Chat badge pill — shows unread DM count, links to /chat.html -->
        <a class="chat-pill" id="nav-chat-pill" href="/chat.html" title="Community + DM กับ admin" style="display:none;">
          💬 <span id="nav-chat-badge" class="chat-badge hidden">0</span>
        </a>
        ${active !== 'login' ? `<button class="btn-lux btn-sm d-none d-md-inline-block" id="logout-btn" type="button">Logout</button>` : ''}
        <button class="nav-toggle d-md-none" type="button" id="nav-toggle" aria-label="Toggle menu">☰</button>
      </div>
    </div>
    <div class="mobile-menu d-md-none" id="mobile-menu" style="display:none;">
      <div class="d-flex flex-column gap-1">
        ${links.map((l) => `<a class="nav-pill ${active === l.key ? 'active' : ''}" href="${l.href}">${l.label}</a>`).join('')}
        ${active !== 'login' ? `<button class="nav-pill nav-pill-logout" id="logout-btn-mobile" type="button">🚪 Logout</button>` : ''}
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

  // logout handler (header button on desktop + mobile menu button)
  async function handleLogout(e) {
    e.preventDefault();
    try { await API.post('/api/auth/logout', {}); } catch (_) {}
    location.href = '/login.html';
  }
  const loDesktop = document.getElementById('logout-btn');
  if (loDesktop) loDesktop.addEventListener('click', handleLogout);
  const loMobile = document.getElementById('logout-btn-mobile');
  if (loMobile) loMobile.addEventListener('click', handleLogout);

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

  // ─── Balance + FX pill ────────────────────────────
  // skip on the login page
  if (active === 'login') return;

  // FIX-2026-08-26: fetch bot version once and show in navbar pill
  const versionEl = document.getElementById('nav-version');
  if (versionEl) {
    API.get('/api/app/version').then((r) => {
      versionEl.textContent = `v${r.version}`;
    }).catch(() => {
      versionEl.textContent = 'v?';
    });
  }

  // FIX-2026-08-27 Phase 3a: consent status poller REMOVED from navbar (per user feedback).
  //   Users check consent status on Settings page → 🛡️ Consent & License group.

  // Phase 4-2026-08-29: chat unread badge (DM only — community is always visible)
  const chatPillEl = document.getElementById('nav-chat-pill');
  const chatBadgeEl = document.getElementById('nav-chat-badge');
  async function refreshChatBadge() {
    if (!chatBadgeEl) return;
    try {
      const r = await API.get('/api/chat/unread');
      const n = (r && typeof r.dm === 'number') ? r.dm : 0;
      if (n > 0) {
        chatBadgeEl.textContent = n > 99 ? '99+' : String(n);
        chatBadgeEl.classList.remove('hidden');
        if (chatPillEl) chatPillEl.style.display = '';
      } else {
        chatBadgeEl.classList.add('hidden');
        if (chatPillEl) chatPillEl.style.display = 'none';
      }
    } catch (_) { /* silent */ }
  }
  refreshChatBadge();
  setInterval(refreshChatBadge, 30000);
  // Listen for live chat:message events to update badge immediately
  window.addEventListener('chat:message', (e) => {
    if (e && e.detail && e.detail.scope === 'dm' && e.detail.fromAdmin) refreshChatBadge();
  });

  const usdtEl = document.getElementById('nav-balance-usdt');
  const thbEl = document.getElementById('nav-balance-thb');
  const pillEl = document.getElementById('nav-balance');
  const reservePillEl = document.getElementById('nav-reserve-pill');
  const reserveTextEl = document.getElementById('nav-reserve-text');
  if (!usdtEl) return;

  // Client-side FX cache (5 min) — also exposed globally so page scripts
  // (bots.js, bot-detail.js) can show THB-equivalent next to USDT PnL.
  let fxRate = null;
  let fxSource = null;
  let fxFetchedAt = 0;
  const FX_CLIENT_TTL_MS = 5 * 60 * 1000;

  function publishFx() {
    window.__fx = {
      rate: fxRate,
      source: fxSource,
      fetchedAt: fxFetchedAt,
      ageSec: fxFetchedAt ? Math.floor((Date.now() - fxFetchedAt) / 1000) : null,
      stale: fxFetchedAt ? (Date.now() - fxFetchedAt > FX_CLIENT_TTL_MS) : true,
    };
    window.__fxReady = fxRate != null;
  }
  publishFx(); // initial empty state

  function setUsdtText(text) { if (usdtEl) usdtEl.textContent = text; }
  function setThbText(text)   { if (thbEl) { thbEl.textContent = text; thbEl.style.display = text ? '' : 'none'; } }
  function setReserveText(text) { if (reserveTextEl) reserveTextEl.textContent = text; }

  // Shared state for combined balance + reserve render (FIX-2026-08-20)
  let _totalUsdt = null;
  let _reserveUsdt = 0;
  let _isOverReserved = false;
  let _balanceErrorMsg = null;

  function renderPill() {
    if (_balanceErrorMsg) {
      setUsdtText('⚠ Binance');
      setThbText('');
      if (reservePillEl) reservePillEl.style.display = 'none';
      if (pillEl) {
        pillEl.classList.add('is-error');
        pillEl.classList.remove('is-reserved', 'is-over-reserved');
        pillEl.title = `Binance API error: ${_balanceErrorMsg}\n(refresh อีกครั้งใน 30s)`;
      }
      return;
    }
    if (_totalUsdt == null || !isFinite(_totalUsdt) || _totalUsdt <= 0) {
      setUsdtText('— USDT');
      setThbText('');
      if (reservePillEl) reservePillEl.style.display = 'none';
      if (pillEl) pillEl.classList.remove('is-error', 'is-reserved', 'is-over-reserved');
      return;
    }
    if (pillEl) pillEl.classList.remove('is-error');

    const total = _totalUsdt;
    const reserve = _reserveUsdt || 0;
    const usable = Math.max(0, total - reserve);
    const hasReserve = reserve > 0;

    // Main USDT text — "usable / total" when reserved, otherwise just total
    if (hasReserve) {
      setUsdtText(`${formatUsdt(usable)} / ${formatUsdt(total)}`);
    } else {
      setUsdtText(formatUsdt(total));
    }

    // THB line — based on usable when reserved, otherwise total
    const thbBase = hasReserve ? usable : total;
    if (fxRate && fxRate > 0) {
      setThbText(`≈ ฿${formatThb(thbBase * fxRate)}`);
    } else {
      setThbText('');
    }

    // Pill state classes + tooltip
    if (pillEl) {
      if (_isOverReserved || (hasReserve && reserve > total)) {
        pillEl.classList.add('is-over-reserved');
        pillEl.classList.remove('is-reserved');
        const reserveThb = fxRate ? ` (≈ ฿${formatThb(reserve * fxRate)})` : '';
        pillEl.title =
          `� กั๊กเงิน (${formatUsdt(reserve)}${reserveThb}) เกินยอด USDT ที่มี (${formatUsdt(total)})\n` +
          `บอทจะใช้เงินไม่ได้จนกว่าจะลด reserve — ไปตั้งที่ /wallet.html`;
      } else if (hasReserve) {
        pillEl.classList.add('is-reserved');
        pillEl.classList.remove('is-over-reserved');
        const reserveThb = fxRate ? ` (≈ ฿${formatThb(reserve * fxRate)})` : '';
        pillEl.title =
          `USDT ที่บอทใช้ได้: ${formatUsdt(usable)} / �ั้งหมด: ${formatUsdt(total)}\n` +
          `🛡 Reserved: ${formatUsdt(reserve)}${reserveThb}`;
      } else {
        pillEl.classList.remove('is-reserved', 'is-over-reserved');
        pillEl.title = 'ยอด USDT จาก Binance (ยังไม่ได้ตั้งการกั๊กเงิน — ไปตั้งได้ที่ /wallet.html)';
      }
    }

    // Secondary 🛡 pill — visible only when reserve > 0
    if (reservePillEl && reserveTextEl) {
      if (hasReserve) {
        reservePillEl.style.display = '';
        setReserveText(formatUsdt(reserve));
        reservePillEl.classList.toggle('is-over', _isOverReserved || reserve > total);
        const reserveThb2 = fxRate ? ` (≈ ฿${formatThb(reserve * fxRate)})` : '';
        reservePillEl.title = `🛡 กั๊กเงิน ${formatUsdt(reserve)} USDT${reserveThb2} — บอทใช้ไม่ได้\nไปแก้ที่ /wallet.html`;
      } else {
        reservePillEl.style.display = 'none';
      }
    }
  }

  async function refreshFx() {
    try {
      const r = await API.get('/api/fx/usdt-thb');
      fxRate = r.rate;
      fxSource = r.source;
      fxFetchedAt = r.fetchedAt || Date.now();
      publishFx();
      // notify page scripts that may be waiting on FX to render THB
      document.dispatchEvent(new CustomEvent('fx:updated', { detail: window.__fx }));
      // FX affects THB text — re-render pill (FIX-2026-08-20)
      renderPill();
      return true;
    } catch (_) {
      return false;
    }
  }

  // FIX-2026-07-14: balance refresh ที่ rate-limit + graceful failure
  //   - ปัญหาเดิม: WS disconnect/reconnect storm → onAccountUpdate ยิง refreshBalance() ทุกครั้ง
  //     → /api/account/balance �ิง Binance ถี่เกินไป → Binance -1021 timestamp drift → 400
  //     → UI ขึ้น "Balance 400 ไม่สามารถโหลด"
  //   - fix: minInterval 30s ระหว่าง refresh (lastFetchAt); failure แสดง "⚠ Binance" + tooltip
  let _lastBalanceFetchAt = 0;
  const BALANCE_MIN_INTERVAL_MS = 30 * 1000;

  async function refreshBalance(force = false) {
    const now = Date.now();
    // Rate-limit: ถ้า fetch สำเร็จเมื่อกี้ this minute, skip (ยกเ�้น force)
    if (!force && (now - _lastBalanceFetchAt) < BALANCE_MIN_INTERVAL_MS) return false;
    _lastBalanceFetchAt = now;
    try {
      const r = await API.get('/api/account/balance');
      const usdt = (r.balances || []).find((b) => b.asset === 'USDT');
      if (!usdt) {
        _totalUsdt = null;
      } else {
        _totalUsdt = (Number(usdt.free) || 0) + (Number(usdt.locked) || 0);
      }
      _balanceErrorMsg = null;
      renderPill();
      return true;
    } catch (err) {
      const status = err.status || null;
      const body = err.body || {};
      const detail = body.binanceCode
        ? `${body.binanceCode} · ${body.error || ''}`.trim()
        : (body.error || err.message || 'unknown');
      _balanceErrorMsg = `${status || 'err'} · ${detail}`;
      renderPill();
      return false;
    }
  }

  // Reserve refresh — reads /api/wallet/reserve. 10s client cache to match
  // the 10s server-side cache in src/services/walletReserve.js.
  // FIX-2026-08-20: combined with balance to render "usable / total" pill.
  let _lastReserveFetchAt = 0;
  const RESERVE_MIN_INTERVAL_MS = 10 * 1000;

  async function refreshReserve(force = false) {
    const now = Date.now();
    if (!force && (now - _lastReserveFetchAt) < RESERVE_MIN_INTERVAL_MS) return false;
    _lastReserveFetchAt = now;
    try {
      const r = await API.get('/api/wallet/reserve');
      _reserveUsdt = Number(r.reserveUsdt) || 0;
      _isOverReserved = !!r.isOverReserved;
      renderPill();
      return true;
    } catch (_) {
      // Non-fatal — keep stale reserve value, do not break pill
      return false;
    }
  }

  async function refreshAll() {
    // FX first (lightweight, cached) so we can convert immediately
    const ok = await refreshFx();
    await Promise.all([refreshBalance(true), refreshReserve(true)]);
    return ok;
  }

  // initial fetch (best-effort — never throws, never breaks UI)
  (async () => {
    setUsdtText('...');
    setThbText('');
    // FIX-2026-08-28 B6: refresh license features for nav-link gating
    API.get('/api/license/info').then((r) => {
      if (r && r.license && r.license.features) {
        window.__licenseFeatures = r.license.features;
        try { sessionStorage.setItem('__licenseFeatures', JSON.stringify(r.license.features)); } catch (_) {}
      }
    }).catch(() => {});
    await refreshAll();
  })();

  // polling fallback every 60s — refreshBalance มี minInterval 30s กัน WS storm อยู่แล้ว
  setInterval(refreshAll, 60 * 1000);

  // refresh FX every 5 min regardless of balance refresh
  setInterval(refreshFx, 5 * 60 * 1000);

  // live updates from WS — re-fetch balance on Binance user data events
  // FIX-2026-07-14: WS storm กันด้วย BALANCE_MIN_INTERVAL_MS ใน refreshBalance
  if (typeof WSClient !== 'undefined') {
    const onAccountUpdate = () => {
      refreshBalance();
      refreshReserve(true); // reserve ผูกกับ USDT balance → refresh ด้วย (FIX-2026-08-20)
    };
    WSClient.on('account:update', onAccountUpdate);
    WSClient.on('balance:update', onAccountUpdate);
  }

  // FIX-2026-08-20: expose refresh hooks so wallet.js (and others) can
  // re-fetch balance/reserve after a mutation without waiting for the 60s
  // poll or the next WS event.
  window.__navRefreshReserve = () => refreshReserve(true);
  window.__navRefreshBalance = () => refreshBalance(true);
  window.__navRefreshAll = () => { refreshBalance(true); refreshReserve(true); };
})();

// ─── Formatters (exported for use by page renderers) ──
function formatUsdt(v) {
  if (v == null || isNaN(v)) return '0.00';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 10000) return `${sign}${(abs / 1000).toFixed(2)}k`;
  return `${sign}${abs.toFixed(2)}`;
}
function formatThb(v) {
  if (v == null || isNaN(v)) return '0';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1000000) return `${sign}${(abs / 1000000).toFixed(2)}M`;
  if (abs >= 10000)   return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${abs.toFixed(0)}`;
}
window.navFormatUsdt = formatUsdt;
window.navFormatThb = formatThb;

/**
 * Convert USDT value to THB string using the cached FX rate (populated by nav.js).
 * Returns '' if FX is not yet loaded.
 */
window.usdtToThb = function usdtToThb(usdtValue, opts = {}) {
  const fx = window.__fx;
  if (!fx || !fx.rate || fx.rate <= 0 || usdtValue == null || !isFinite(usdtValue)) return '';
  const thb = Number(usdtValue) * fx.rate;
  if (opts.raw) return thb;
  return `≈ ฿${formatThb(thb)}`;
};
