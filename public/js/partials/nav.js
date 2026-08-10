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

  const links = [
    { key: 'bots',          href: '/bots.html',     label: '🤖 Bots' },
    { key: 'detail',        href: botId ? `/bot-detail.html?id=${botId}` : '/bots.html', label: '📊 Detail' },
    { key: 'chart-monitor', href: '/chart-monitor.html', label: '📊 Chart Monitor' }, // 2026-08-06: grid of mini-charts for running bots
    { key: 'chart',         href: '/chart.html',    label: '📈 Chart' },
    { key: 'backtest',      href: '/backtest.html', label: '🧪 Backtest' },
    { key: 'scan',          href: '/scan-volatility.html', label: '🎰 Scan' },
    { key: 'pnl',           href: '/pnl.html',      label: '📅 PnL' },               // FIX-2026-07-29
    { key: 'history',       href: '/history.html',  label: '📜 History' },           // FIX-2026-07-24
    { key: 'security',      href: '/password-sessions.html', label: '🔑 Security' }, // 2026-08-09: Password & Sessions Manager
    { key: 'settings',      href: '/settings.html', label: '⚙️ Settings' },          // FIX-2026-07-24
  ].filter((l) => l.key !== 'detail' || botId); // hide detail if no botId

  const desktopHtml = `
    <div class="d-flex align-items-center gap-2 flex-wrap" style="max-width: 1400px; margin: 0 auto;">
      <a class="brand" href="/bots.html">
        <img src="/favicon.svg" alt="OnePercentBotTrade" class="brand-logo" />
        <span>OnePercent<span style="color:var(--gold-1);">%</span>BotTrade</span>
      </a>
      <nav class="desktop-menu d-none d-md-flex align-items-center gap-1 ms-3">
        ${links.map((l) => `<a class="nav-pill ${active === l.key ? 'active' : ''}" href="${l.href}">${l.label}</a>`).join('')}
      </nav>
      <div class="ms-auto d-flex align-items-center gap-2">
        <span class="balance-pill" id="nav-balance" title="ยอด USDT จาก Binance + ค่าเงิน THB">
          <span class="balance-icon">💰</span>
          <span class="balance-text" id="nav-balance-text">
            <span class="balance-usdt" id="nav-balance-usdt">…</span>
            <span class="balance-thb" id="nav-balance-thb" style="display:none;"></span>
          </span>
        </span>
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

  // ─── Balance + FX pill ────────────────────────────
  // skip on the login page
  if (active === 'login') return;

  const usdtEl = document.getElementById('nav-balance-usdt');
  const thbEl = document.getElementById('nav-balance-thb');
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

  function applyUsdtToBalance(usdtFree, usdtLocked) {
    const total = (Number(usdtFree) || 0) + (Number(usdtLocked) || 0);
    if (!isFinite(total) || total <= 0) {
      setUsdtText('— USDT');
      setThbText('');
      return;
    }
    setUsdtText(formatUsdt(total));
    if (fxRate && fxRate > 0) {
      setThbText(`≈ ฿${formatThb(total * fxRate)}`);
    } else {
      setThbText('');
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
      return true;
    } catch (_) {
      return false;
    }
  }

  // FIX-2026-07-14: balance refresh ที่ rate-limit + graceful failure
  //   - ปัญหาเดิม: WS disconnect/reconnect storm → onAccountUpdate ยิง refreshBalance() ทุกครั้ง
  //     → /api/account/balance ยิง Binance ถี่เกินไป → Binance -1021 timestamp drift → 400
  //     → UI ขึ้น "Balance 400 ไม่สามารถโหลด"
  //   - fix: minInterval 30s ระหว่าง refresh (lastFetchAt); failure แสดง "⚠ Binance" + tooltip
  let _lastBalanceFetchAt = 0;
  const BALANCE_MIN_INTERVAL_MS = 30 * 1000;
  let _lastBalanceErrorMsg = '';

  async function refreshBalance(force = false) {
    const now = Date.now();
    // Rate-limit: ถ้า fetch สำเร็จเมื่อกี้ this minute, skip (ยกเว้น force)
    if (!force && (now - _lastBalanceFetchAt) < BALANCE_MIN_INTERVAL_MS) return false;
    _lastBalanceFetchAt = now;
    try {
      const r = await API.get('/api/account/balance');
      const usdt = (r.balances || []).find((b) => b.asset === 'USDT');
      if (!usdt) { setUsdtText('— USDT'); setThbText(''); return true; }
      applyUsdtToBalance(usdt.free, usdt.locked);
      _lastBalanceErrorMsg = '';
      // FIX-2026-07-14: ลบ error class ออกเมื่อสำเร็จ
      const pill = document.getElementById('nav-balance');
      if (pill) pill.classList.remove('is-error');
      return true;
    } catch (err) {
      const status = err.status || null;
      const body = err.body || {};
      const detail = body.binanceCode
        ? `${body.binanceCode} · ${body.error || ''}`.trim()
        : (body.error || err.message || 'unknown');
      _lastBalanceErrorMsg = `${status || 'err'} · ${detail}`;
      setUsdtText('⚠ Binance');
      setThbText('');
      const pill = document.getElementById('nav-balance');
      if (pill) {
        pill.title = `Binance API error: ${_lastBalanceErrorMsg}\n(ระบบซ่อมอัตโนมัติด้วย server-time sync; refresh อีกครั้งใน 30s)`;
        pill.classList.add('is-error');
      }
      return false;
    }
  }

  async function refreshAll() {
    // FX first (lightweight, cached) so we can convert immediately
    const ok = await refreshFx();
    await refreshBalance();
    return ok;
  }

  // initial fetch (best-effort — never throws, never breaks UI)
  (async () => {
    setUsdtText('...');
    setThbText('');
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
    };
    WSClient.on('account:update', onAccountUpdate);
    WSClient.on('balance:update', onAccountUpdate);
  }
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
