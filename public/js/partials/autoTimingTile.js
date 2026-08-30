'use strict';

/**
 * FIX-2026-08-30 / Phase 4: Auto-Timing navbar tile — today's decision tally.
 *
 * Pill (inside `.ms-auto`, before logout):
 *   ⏱  Suppress 2 · Limit 5 · Stim 1 · Allow 12
 *   • Suppress → red (matched cool-down / ever-bad cells)
 *   • Limit    → orange
 *   • Stimulate→ blue
 *   • Encourage→ cyan
 *   • Allow    → green
 *
 * Popover (click the pill):
 *   • Master toggle status + lastRunAt + tickCount + interval
 *   • Today's tally per action (Suppress/Limit/Encourage/Stimulate/Allow)
 *   • Tier 2 cool-down promotions (today)
 *   • ⚙ Auto-Timing settings → /settings.html#sec-auto-timing
 *
 * Sources (priority order):
 *   1. WebSocket event 'autoTiming:update' (pushed by services/autoTiming.js after each runOnce)
 *   2. Initial fetch GET /api/auto-timing/status + GET /api/auto-timing/recent-decisions?limit=200
 *   3. Polling fallback every 60s (covers brief WS disconnects)
 *
 * Self-mounted: no HTML edits per page beyond loading this script.
 * Skipped on login (NAV_ACTIVE === 'login').
 */

(function mountAutoTimingTile() {
  const nav = document.getElementById('app-nav');
  if (!nav) return;
  if (window.NAV_ACTIVE === 'login') return;
  if (document.getElementById('nav-auto-timing')) return; // idempotent

  // ─── DOM: pill ──────────────────────────────────────────────────
  const pill = document.createElement('span');
  pill.className = 'nav-pill nav-auto-timing zone-idle';
  pill.id = 'nav-auto-timing';
  pill.title = 'Auto-Timing — heatmap-driven entry gate';
  pill.setAttribute('role', 'button');
  pill.setAttribute('aria-label', 'Auto-Timing today tally');
  pill.innerHTML = `
    <span class="at-glyph" aria-hidden="true">⏱</span>
    <span class="at-summary" id="at-summary">…</span>
  `;

  // ─── DOM: popover ───────────────────────────────────────────────
  const popover = document.createElement('div');
  popover.className = 'at-popover';
  popover.id = 'at-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Auto-Timing detail');
  popover.style.display = 'none';
  popover.innerHTML = `
    <div class="at-pop-header">
      <span class="at-pop-glyph">⏱</span>
      <strong>Auto-Timing today</strong>
    </div>
    <div class="at-pop-row"><span>Master toggle</span><span id="at-enabled" class="val">…</span></div>
    <div class="at-pop-row"><span>Last run</span><span id="at-last-run" class="val">…</span></div>
    <div class="at-pop-row"><span>Tick count</span><span id="at-tick-count" class="val">…</span></div>
    <div class="at-pop-row"><span>Trades (30d)</span><span id="at-trades-scanned" class="val">…</span></div>
    <div class="at-pop-row"><span>Tier 2 promotions</span><span id="at-tier2-promotions" class="val">…</span></div>
    <hr class="at-pop-hr" />
    <div class="at-pop-row"><span>🚫 Suppress</span><span id="at-suppress" class="val val-red">…</span></div>
    <div class="at-pop-row"><span>⚠️ Limit</span><span id="at-limit" class="val val-orange">…</span></div>
    <div class="at-pop-row"><span>⭐ Stimulate</span><span id="at-stimulate" class="val val-blue">…</span></div>
    <div class="at-pop-row"><span>✨ Encourage</span><span id="at-encourage" class="val val-cyan">…</span></div>
    <div class="at-pop-row"><span>✅ Allow</span><span id="at-allow" class="val val-green">…</span></div>
    <a class="at-pop-link" href="/settings.html#sec-auto-timing">⚙ Auto-Timing settings →</a>
  `;

  // ─── Insert pill into nav (.ms-auto) ───────────────────────────
  const msAuto = nav.querySelector('.ms-auto');
  if (!msAuto) return;
  const logoutBtn = msAuto.querySelector('#logout-btn');
  if (logoutBtn) {
    msAuto.insertBefore(pill, logoutBtn);
  } else {
    msAuto.appendChild(pill);
  }
  document.body.appendChild(popover);

  // ─── Element refs ──────────────────────────────────────────────
  const elSummary = document.getElementById('at-summary');
  const elEnabled = document.getElementById('at-enabled');
  const elLastRun = document.getElementById('at-last-run');
  const elTick = document.getElementById('at-tick-count');
  const elTrades = document.getElementById('at-trades-scanned');
  const elTier2 = document.getElementById('at-tier2-promotions');
  const elSup = document.getElementById('at-suppress');
  const elLim = document.getElementById('at-limit');
  const elSti = document.getElementById('at-stimulate');
  const elEnc = document.getElementById('at-encourage');
  const elAll = document.getElementById('at-allow');

  // ─── Popover toggle ───────────────────────────────────────────
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = pill.getBoundingClientRect();
    popover.style.display = popover.style.display === 'none' ? 'block' : 'none';
    if (popover.style.display === 'block') {
      popover.style.top = `${rect.bottom + 6}px`;
      popover.style.right = `${Math.max(8, window.innerWidth - rect.right - 4)}px`;
    }
  });
  document.addEventListener('click', (e) => {
    if (!popover.contains(e.target) && e.target !== pill) popover.style.display = 'none';
  });
  window.addEventListener('resize', () => { popover.style.display = 'none'; });

  // ─── Tally helper ──────────────────────────────────────────────
  function tallyDecisions(decisions) {
    const todayKey = new Date().toLocaleDateString(); // user-local "M/D/YYYY"
    const out = { suppress: 0, limit: 0, encourage: 0, stimulate: 0, allow: 0, _total: 0, _todayTotal: 0 };
    for (const d of (decisions || [])) {
      if (!d || !d.action) continue;
      if (out[d.action] != null) out[d.action] += 1;
      out._total += 1;
      // ts is ms epoch
      if (d.ts && new Date(Number(d.ts)).toLocaleDateString() === todayKey) {
        out._todayTotal += 1;
      }
    }
    return out;
  }

  // ─── Apply function ────────────────────────────────────────────
  function apply(wsPayload) {
    // Refresh from API for authoritative state, then update pill.
    Promise.all([
      fetch('/api/auto-timing/status', { credentials: 'include' }).then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/auto-timing/recent-decisions?limit=200', { credentials: 'include' }).then((r) => r.ok ? r.json() : null).catch(() => null),
    ]).then(([statusResp, decisionsResp]) => {
      const status = (statusResp && statusResp.status) || {};
      const decisions = (decisionsResp && decisionsResp.decisions) || [];
      const tally = tallyDecisions(decisions);
      // prefers today's tally if non-empty, falls back to "N total in last 200"
      const todayHas = tally._todayTotal > 0;
      const useT = todayHas ? tally._todayTotal : tally._total;
      const useSup = todayHas ? tally.suppress : tally.suppress;
      const useLim = todayHas ? tally.limit : tally.limit;
      const useSti = todayHas ? tally.stimulate : tally.stimulate;
      const useEnc = todayHas ? tally.encourage : tally.encourage;
      const useAll = todayHas ? tally.allow : tally.allow;

      const enabled = !!status.enabled;
      elEnabled.textContent = enabled ? '🟢 ON' : '⚪ OFF';
      elLastRun.textContent = status.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : '—';
      elTick.textContent = (status.tickCount != null ? status.tickCount : '—');
      if (wsPayload && wsPayload.tradesScanned != null) {
        elTrades.textContent = wsPayload.tradesScanned + ' (last tick)';
      } else {
        elTrades.textContent = (status.tradesScanned != null ? status.tradesScanned : '—');
      }
      if (wsPayload && wsPayload.tier2Promotions != null) {
        elTier2.textContent = wsPayload.tier2Promotions + ' (last tick)';
      } else {
        elTier2.textContent = '—';
      }
      elSup.textContent = useSup;
      elLim.textContent = useLim;
      elSti.textContent = useSti;
      elEnc.textContent = useEnc;
      elAll.textContent = useAll;

      // pill summary: dominant color reflects worst action present
      const parts = [];
      if (useSup) parts.push(`<span class="seg-red">${useSup}⛔</span>`);
      if (useLim) parts.push(`<span class="seg-orange">${useLim}⚠</span>`);
      if (useSti) parts.push(`<span class="seg-blue">${useSti}⭐</span>`);
      if (useEnc) parts.push(`<span class="seg-cyan">${useEnc}✨</span>`);
      if (parts.length === 0) {
        parts.push(`<span class="seg-green">${useAll}✅</span>`);
      }
      elSummary.innerHTML = parts.join(' ');
      pill.className = 'nav-pill nav-auto-timing zone-' + (enabled ? (useSup ? 'danger' : useLim ? 'warm' : 'live') : 'idle');
    });
  }

  // ─── Initial fetch + WS subscription + polling fallback ────────
  apply(null);
  if (window.WSClient && typeof window.WSClient.on === 'function') {
    window.WSClient.on('autoTiming:update', apply);
  }
  setInterval(() => apply(null), 60_000);
})();
