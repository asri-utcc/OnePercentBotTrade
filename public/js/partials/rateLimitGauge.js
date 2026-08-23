'use strict';

/**
 * FIX-2026-08-23: Live Binance API weight gauge — navbar pill
 *
 * Layout (inside the existing navbar `.ms-auto` cluster, before #logout-btn):
 *   ⚡  42%  ▓▓▓░░░  2,520
 *
 * Click the pill → small popover with:
 *   • Circuit breaker state (CLOSED / OPEN / HALF_OPEN)
 *   • Used / capacity
 *   • Refill rate (tokens / sec)
 *   • Ban remaining seconds
 *   • ⚙ Rate-limit settings  → /settings.html
 *
 * Sources (in priority order):
 *   1. WebSocket event 'rateLimit:update' (pushed by healthMonitor every 5s)
 *   2. Initial fetch  GET /api/system/rate-limit
 *   3. Polling fallback every 30s (covers brief WS disconnects)
 *
 * Color zones (matches the dailyTargetBar zone-class pattern):
 *   cold     (<50%)     → bull green
 *   warming  (50-79%)   → gold
 *   hot      (80-94%)   → orange
 *   danger   (≥95% or circuit-breaker open) → bear red, pulses
 *
 * Self-mounted: no HTML edits per page beyond loading this script.
 * Skipped on login (NAV_ACTIVE === 'login') — login page has no session.
 */

(function mountRateLimitGauge() {
  const nav = document.getElementById('app-nav');
  if (!nav) return;
  if (window.NAV_ACTIVE === 'login') return;
  if (document.getElementById('nav-rate-limit')) return; // idempotent

  // ─── DOM: pill ──────────────────────────────────────────────────
  const pill = document.createElement('span');
  pill.className = 'nav-pill nav-rate-limit zone-cold';
  pill.id = 'nav-rate-limit';
  pill.title = 'Binance API weight usage (live)';
  pill.setAttribute('role', 'button');
  pill.setAttribute('aria-label', 'Binance API weight usage');
  pill.innerHTML = `
    <span class="rl-glyph" aria-hidden="true">⚡</span>
    <span class="rl-pct" id="rl-pct">…%</span>
    <span class="rl-bar-track" aria-hidden="true"><span class="rl-bar-fill" id="rl-bar-fill" style="width:0%;"></span></span>
    <span class="rl-tokens" id="rl-tokens">…</span>
  `;

  // ─── DOM: popover (sibling of nav so position:absolute is scoped to body) ──
  const popover = document.createElement('div');
  popover.className = 'rl-popover';
  popover.id = 'rl-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Binance rate limit detail');
  popover.style.display = 'none';
  popover.innerHTML = `
    <div class="rl-pop-header">
      <span class="rl-pop-glyph">⚡</span>
      <strong>Binance API weight</strong>
    </div>
    <div class="rl-pop-row"><span>Circuit breaker</span><span id="rl-cb-state" class="val">…</span></div>
    <div class="rl-pop-row"><span>Used</span><span id="rl-used" class="val">…/…</span></div>
    <div class="rl-pop-row"><span>Refill rate</span><span id="rl-refill" class="val">…/s</span></div>
    <div class="rl-pop-row"><span>Ban resets in</span><span id="rl-ban" class="val">…</span></div>
    <div class="rl-pop-hint">Capacity = binanceRateLimitPerMin (default 6,000 / min)</div>
    <a class="rl-pop-link" href="/settings.html">⚙ Rate-limit settings →</a>
  `;

  // ─── Insert pill INSIDE nav (.ms-auto), before logout button ──
  const msAuto = nav.querySelector('.ms-auto');
  if (!msAuto) return; // defensive — nav.js should have rendered by now
  const logoutBtn = msAuto.querySelector('#logout-btn');
  if (logoutBtn) {
    msAuto.insertBefore(pill, logoutBtn);
  } else {
    msAuto.appendChild(pill);
  }

  // Popover sits at body level so position:absolute anchors to viewport
  document.body.appendChild(popover);

  // ─── Element refs ──────────────────────────────────────────────
  const elPct = document.getElementById('rl-pct');
  const elFill = document.getElementById('rl-bar-fill');
  const elTokens = document.getElementById('rl-tokens');
  const elCbState = document.getElementById('rl-cb-state');
  const elUsed = document.getElementById('rl-used');
  const elRefill = document.getElementById('rl-refill');
  const elBan = document.getElementById('rl-ban');

  // ─── Formatting helpers ─────────────────────────────────────────
  function fmtNum(n) {
    const v = Math.round(Number(n) || 0);
    return v.toLocaleString('en-US');
  }
  function pctToZone(pct, cbState) {
    if (cbState && cbState !== 'closed' && cbState !== 'CLOSED') return 'danger';
    if (pct >= 95) return 'danger';
    if (pct >= 80) return 'hot';
    if (pct >= 50) return 'warming';
    return 'cold';
  }
  function cbStateLabel(s) {
    if (!s) return '—';
    const u = String(s).toUpperCase();
    if (u === 'CLOSED') return '<span class="rl-tag rl-tag-ok">closed</span>';
    if (u === 'OPEN') return '<span class="rl-tag rl-tag-bad">OPEN</span>';
    if (u === 'HALF_OPEN' || u === 'HALF-OPEN') return '<span class="rl-tag rl-tag-warn">half-open</span>';
    return `<span class="rl-tag">${u}</span>`;
  }

  // ─── Render ─────────────────────────────────────────────────────
  let lastData = null;
  function apply(d) {
    if (!d || typeof d !== 'object') return;
    lastData = d;
    const pct = Math.max(0, Math.min(100, Number(d.usedPct) || 0));
    const cb = d.circuitBreaker || null;
    const cbState = cb ? cb.state : null;
    const zone = pctToZone(pct, cbState);

    // pill
    elPct.textContent = pct + '%';
    elFill.style.width = pct + '%';
    elTokens.textContent = fmtNum(d.usedEstimated);
    pill.className = 'nav-pill nav-rate-limit zone-' + zone;

    // popover rows
    elCbState.innerHTML = cbStateLabel(cbState);
    elUsed.textContent = `${fmtNum(d.usedEstimated)} / ${fmtNum(d.capacity)}`;
    const refillPerSec = (Number(d.refillRate) || 0) * 1000; // refillRate is tokens/ms
    elRefill.textContent = isFinite(refillPerSec) ? `${fmtNum(refillPerSec)} / s` : '—';
    // .innerHTML (ไม่ใช่ .textContent) เพราะ branch "none" มี <span class="rl-tag">
    //   data มาจาก binanceRest.getRateLimitStatus() ฝั่งเราเอง → ไม่มี XSS risk
    elBan.innerHTML = d.banRemainingSec > 0
      ? `${fmtNum(d.banRemainingSec)} s`
      : '<span class="rl-tag rl-tag-ok">none</span>';

    // update tooltip too
    pill.title = `Binance API weight: ${pct}% used · circuit ${cbState || '—'} · ban ${d.banRemainingSec || 0}s`;
  }

  // ─── Click → popover ─────────────────────────────────────────────
  function positionPopover() {
    const r = pill.getBoundingClientRect();
    const popWidth = 260; // approx; CSS min-width 240 + padding
    let left = Math.max(8, r.right - popWidth + window.scrollX);
    let top = r.bottom + 8 + window.scrollY;
    // keep on-screen if viewport is narrow
    if (left + popWidth > window.scrollX + window.innerWidth - 8) {
      left = Math.max(8, window.scrollX + window.innerWidth - popWidth - 8);
    }
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
  }
  function openPopover() {
    popover.style.display = 'block';
    positionPopover();
  }
  function closePopover() {
    popover.style.display = 'none';
  }
  function togglePopover() {
    if (popover.style.display === 'none') openPopover();
    else closePopover();
  }
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePopover();
  });
  document.addEventListener('click', (e) => {
    if (popover.style.display === 'none') return;
    if (pill.contains(e.target) || popover.contains(e.target)) return;
    closePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopover();
  });
  window.addEventListener('resize', () => {
    if (popover.style.display !== 'none') positionPopover();
  });
  window.addEventListener('scroll', () => {
    if (popover.style.display !== 'none') positionPopover();
  });

  // ─── Initial fetch + polling fallback ────────────────────────────
  let pollTimer = null;
  async function refresh() {
    try {
      const d = await API.get('/api/system/rate-limit');
      apply(d);
    } catch (err) {
      // swallow — pill keeps last state; do not console-spam
    }
  }

  // ─── WS live updates ─────────────────────────────────────────────
  function ensureWs() {
    if (typeof WSClient === 'undefined') return;
    if (!WSClient.start) return;
    if (!WSClient.ws) WSClient.start();
    WSClient.on('rateLimit:update', apply);
  }

  refresh().then(() => {
    ensureWs();
    pollTimer = setInterval(refresh, 30_000);
  });

  // Expose for debug / tests
  window.__rl = { refresh, apply, get data() { return lastData; } };
})();