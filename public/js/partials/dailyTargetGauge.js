'use strict';

/**
 * 2026-08-06: Daily Profit Target gauge — HORIZONTAL BAR (BNB fuel-gauge style)
 *
 * Layout (3 rows):
 *   Row 1: 🎯 ฿<PnL>  <USDT>  <pct %>   <status emoji+label>   |  <target pill ✎>
 *   Row 2: [========== horizontal progress bar ==========]   ← zone color
 *   Row 3: Trades · Win% · +Win · −Loss            ℹ สรุป
 *
 * Behavior:
 *   • 5 zones: cold (steel) → warming (gold) → hot (bull green) →
 *              achieved (rainbow shimmer + 🎉 confetti) → loss (red, bar empty)
 *   • Click target pill → inline editor (PUT /api/daily-target)
 *   • Click anywhere else (incl. bar) → breakdown popover
 *   • WS 'trade:update' (state==='sold') → optimistic +1 trade/PnL + flash,
 *     server reconcile after 1.5s
 *   • Polling fallback every 60s + day-rollover refresh at next BKK midnight
 *
 * Self-mounted: inserts a sibling <div id="dtb"> right after .app-nav on
 * every page that has nav (skips login). No HTML edits required per-page.
 */

(function mountDailyTargetBar() {
  const nav = document.getElementById('app-nav');
  if (!nav) return;
  if (window.NAV_ACTIVE === 'login') return;

  // ─── DOM ──────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.className = 'daily-target-bar is-loading';
  wrap.id = 'dtb';
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', 'Daily Profit Target gauge');
  wrap.innerHTML = `
    <div class="dtb-inner">

      <!-- Row 1: PnL number + target pill + info -->
      <div class="dtb-row dtb-row-main">
        <div class="dtb-number">
          <span class="dtb-number-emoji" id="dtb-emoji">🎯</span>
          <span class="dtb-number-value" id="dtb-value">฿0.00</span>
          <span class="dtb-number-usdt" id="dtb-usdt">0.00 USDT</span>
          <span class="dtb-number-pct" id="dtb-pct">0%</span>
          <span class="dtb-number-status" id="dtb-status">Today PnL</span>
        </div>
        <button type="button" class="dtb-target" id="dtb-target-btn" title="คลิกเพื่อแก้เป้าหมาย">
          <span class="dtb-target-label">🎯 เป้า</span>
          <span class="dtb-target-value" id="dtb-target-value">฿100</span>
          <span class="dtb-target-edit">✎</span>
        </button>
        <span class="dtb-target-edit-wrap" id="dtb-target-edit-wrap">
          <input type="number" class="dtb-target-input" id="dtb-target-input"
                 min="1" max="1000000" step="1" />
          <button type="button" class="dtb-target-save" id="dtb-target-save">Save</button>
          <button type="button" class="dtb-target-cancel" id="dtb-target-cancel">✕</button>
        </span>
        <button type="button" class="dtb-info" id="dtb-info-btn" title="ดูสรุปแบบละเอียด">ℹ สรุป</button>
      </div>

      <!-- Row 2: horizontal bar -->
      <div class="dtb-row dtb-row-bar">
        <div class="dtb-bar-track">
          <div class="dtb-bar-fill" id="dtb-bar-fill" style="width:0%;"></div>
        </div>
      </div>
    </div>

    <!-- Popover (breakdown) -->
    <div class="dtb-popover" id="dtb-popover" role="dialog" aria-label="Daily target breakdown">
      <h6>📊 สรุปวันนี้</h6>
      <div class="dtb-popover-row"><span class="label">Today PnL (USDT)</span><span id="dtb-pop-pnl-usdt">0.0000</span></div>
      <div class="dtb-popover-row"><span class="label">Today PnL (THB)</span><span id="dtb-pop-pnl">฿0.00</span></div>
      <div class="dtb-popover-row"><span class="label">Target (THB)</span><span id="dtb-pop-target">฿0</span></div>
      <div class="dtb-popover-row"><span class="label">% ของเป้า</span><span id="dtb-pop-pct">0%</span></div>
      <div class="dtb-popover-row"><span class="label">Zone</span><span id="dtb-pop-zone">cold</span></div>
      <div class="dtb-popover-row"><span class="label">Trades</span><span id="dtb-pop-trades">0</span></div>
      <div class="dtb-popover-row"><span class="label">Win rate</span><span id="dtb-pop-wr">—</span></div>
      <div class="dtb-popover-row"><span class="label">+ Gross win</span><span class="val-win" id="dtb-pop-gw">฿0</span></div>
      <div class="dtb-popover-row"><span class="label">− Gross loss</span><span class="val-loss" id="dtb-pop-gl">฿0</span></div>
      <div class="dtb-popover-row"><span class="label">FX (USDT→THB)</span><span id="dtb-pop-fx">—</span></div>
      <div class="dtb-popover-hint">
        🎯 เป้าหมาย THB/วัน — ตั้งค่าได้ที่ปุ่ม ✎ ขวาบน หรือใน <a href="/settings.html">Settings</a>
      </div>
      <button type="button" class="dtb-share" id="dtb-share-btn" title="สร้างการ์ดแชร์ผลประจำวัน (PNG 800×1000)">
        📸 สร้างการ์ดแชร์
      </button>
    </div>
  `;

  nav.parentNode.insertBefore(wrap, nav.nextSibling);

  // ─── Element refs ──────────────────────────────────────────────
  const elBar       = wrap;
  const elFill      = document.getElementById('dtb-bar-fill');
  const elEmoji     = document.getElementById('dtb-emoji');
  const elValue     = document.getElementById('dtb-value');
  const elUsdt      = document.getElementById('dtb-usdt');
  const elPct       = document.getElementById('dtb-pct');
  const elStatus    = document.getElementById('dtb-status');
  const elTargetBtn = document.getElementById('dtb-target-btn');
  const elTargetVal = document.getElementById('dtb-target-value');
  const elEditWrap  = document.getElementById('dtb-target-edit-wrap');
  const elEditInput = document.getElementById('dtb-target-input');
  const elEditSave  = document.getElementById('dtb-target-save');
  const elEditCancel= document.getElementById('dtb-target-cancel');
  const elInfoBtn   = document.getElementById('dtb-info-btn');
  const elShareBtn  = document.getElementById('dtb-share-btn');
  const elPopover   = document.getElementById('dtb-popover');
  const popPnlUsdt  = document.getElementById('dtb-pop-pnl-usdt');
  const popPnl      = document.getElementById('dtb-pop-pnl');
  const popTarget   = document.getElementById('dtb-pop-target');
  const popPct      = document.getElementById('dtb-pop-pct');
  const popZone     = document.getElementById('dtb-pop-zone');
  const popTrades   = document.getElementById('dtb-pop-trades');
  const popWr       = document.getElementById('dtb-pop-wr');
  const popGw       = document.getElementById('dtb-pop-gw');
  const popGl       = document.getElementById('dtb-pop-gl');
  const popFx       = document.getElementById('dtb-pop-fx');

  // Stats are now ONLY shown in the popover (per UX feedback — bar was too wide)
  // The element IDs in the popover still get populated below.

  // State
  let lastData = null;
  let prevAchieved = false;
  let renderRaf = null;
  let animPnl = { from: 0, to: 0, startedAt: 0 };
  let pollTimer = null;
  let reconcileTimer = null;

  // ─── Helpers ──────────────────────────────────────────────────
  function fmtThb(n, opts = {}) {
    if (n == null || !isFinite(n)) return '฿0';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const max = opts.max != null ? opts.max : (abs >= 100000 ? 1 : abs >= 10000 ? 1 : abs >= 100 ? 2 : 2);
    return `${sign}฿${abs.toFixed(max)}`;
  }
  function fmtUsdt(n, opts = {}) {
    if (n == null || !isFinite(n)) return '0.00 USDT';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const max = opts.max != null ? opts.max : 4;
    return `${sign}${abs.toFixed(max)} USDT`;
  }

  const ZONE_META = {
    cold:     { emoji: '🥶', label: 'ยังเย็น — ลุยต่อ!' },
    warming:  { emoji: '🔥', label: 'กำลังอุ่น — ใกล้แล้ว' },
    hot:      { emoji: '🚀', label: 'ร้อนแรง — ใกล้เป้า!' },
    achieved: { emoji: '🏆', label: 'ทะลุเป้าแล้ว 🎉' },
    loss:     { emoji: '💔', label: 'ขาดทุนวันนี้' },
  };

  function applyZone(zone) {
    elBar.classList.remove('zone-cold', 'zone-warming', 'zone-hot', 'zone-achieved', 'zone-loss');
    elBar.classList.add(`zone-${zone}`);
    const m = ZONE_META[zone] || ZONE_META.cold;
    if (elEmoji) elEmoji.textContent = m.emoji;
    if (elStatus) elStatus.textContent = m.label;
  }

  function applyBar(pct) {
    // Visual width: clamp to 0..100. Loss zone shows empty bar (red number outside).
    let widthPct;
    if (pct <= 0)         widthPct = 0;     // loss = empty (red number carries the bad news)
    else if (pct >= 100)  widthPct = 100;   // achieved = full
    else                  widthPct = pct;
    if (elFill) elFill.style.width = `${widthPct}%`;
  }

  // Smooth count-up for the big PnL number
  function animateValueTo(target) {
    animPnl.from = animPnl.to;
    animPnl.to = target;
    animPnl.startedAt = performance.now();
    if (renderRaf) cancelAnimationFrame(renderRaf);
    const dur = 600;
    const step = (now) => {
      const t = Math.min(1, (now - animPnl.startedAt) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = animPnl.from + (animPnl.to - animPnl.from) * eased;
      if (elValue) elValue.textContent = fmtThb(v, { max: 2 });
      if (t < 1) renderRaf = requestAnimationFrame(step);
    };
    renderRaf = requestAnimationFrame(step);
  }

  function fireConfetti() {
    const c = document.createElement('div');
    c.className = 'dtb-confetti';
    wrap.appendChild(c);
    const colors = ['#f5b800', '#ffd76a', '#00e5b8', '#5dc4ff', '#a78bfa', '#ff4d6d'];
    const N = 18;
    for (let i = 0; i < N; i++) {
      const s = document.createElement('span');
      const angle = (Math.PI * 2 * i) / N + (Math.random() - 0.5) * 0.4;
      const dist = 60 + Math.random() * 60;
      const cx = Math.cos(angle) * dist;
      const cy = Math.sin(angle) * dist - 30;
      const rot = (Math.random() - 0.5) * 720;
      s.style.background = colors[i % colors.length];
      s.style.setProperty('--cx', `${cx}px`);
      s.style.setProperty('--cy', `${cy}px`);
      s.style.setProperty('--rot', `${rot}deg`);
      s.style.animationDelay = `${Math.random() * 100}ms`;
      c.appendChild(s);
    }
    setTimeout(() => c.remove(), 1600);
  }

  function applyData(d, { animate = true } = {}) {
    if (!d) return;
    lastData = d;

    // Big PnL (THB)
    const v = Number(d.todayPnlThb) || 0;
    if (animate) animateValueTo(v);
    else { animPnl.to = v; if (elValue) elValue.textContent = fmtThb(v, { max: 2 }); }

    // USDT + pct + zone + bar
    if (elUsdt)   elUsdt.textContent   = fmtUsdt(Number(d.todayPnlUsdt) || 0);
    if (elPct)    elPct.textContent    = `${Math.round(Number(d.pct) || 0)}%`;
    if (elTargetVal) elTargetVal.textContent = `฿${Math.round(Number(d.targetThb) || 100)}`;
    applyZone(d.zone);
    applyBar(Number(d.pct) || 0);

    // Mini stats are no longer in the bar — only shown in the popover below

    // Popover
    if (popPnlUsdt) popPnlUsdt.textContent = fmtUsdt(Number(d.todayPnlUsdt) || 0);
    if (popPnl)     popPnl.textContent     = fmtThb(v, { max: 2 });
    if (popTarget)  popTarget.textContent  = `฿${Math.round(Number(d.targetThb) || 100)}`;
    if (popPct)     popPct.textContent     = `${(Number(d.pct) || 0).toFixed(1)}%`;
    if (popZone)    popZone.textContent    = d.zone || 'cold';
    if (popTrades)  popTrades.textContent  = `${d.todayTrades ?? 0} (${d.todayWins ?? 0}W/${d.todayLosses ?? 0}L)`;
    if (popWr)      popWr.textContent      = d.todayTrades
      ? `${(Number(d.winRate) || 0).toFixed(1)}%`
      : '—';
    if (popGw)      popGw.textContent      = fmtThb(Number(d.todayGrossProfit) * (Number(d.fxRate) || 0), { max: 0 });
    if (popGl)      popGl.textContent      = fmtThb(Number(d.todayGrossLoss)   * (Number(d.fxRate) || 0), { max: 0 });
    if (popFx)      popFx.textContent      = d.fxRate ? Number(d.fxRate).toFixed(2) : '—';

    // Confetti on transition into achieved (and only once)
    if (d.zone === 'achieved' && !prevAchieved && animate) {
      fireConfetti();
      if (elValue) {
        elValue.classList.remove('is-flash');
        void elValue.offsetWidth;
        elValue.classList.add('is-flash');
      }
    }
    prevAchieved = (d.zone === 'achieved');

    elBar.classList.remove('is-loading');
  }

  async function refresh() {
    try {
      const d = await API.get('/api/daily-target');
      applyData(d, { animate: false });
    } catch (err) {
      console.warn('dailyTarget: refresh failed', err && err.message);
      elBar.classList.remove('is-loading');
    }
  }

  // ─── Target edit handlers ──────────────────────────────────────
  function openEditor() {
    const current = lastData ? Math.round(Number(lastData.targetThb) || 100) : 100;
    elEditInput.value = String(current);
    elTargetBtn.style.display = 'none';
    elEditWrap.classList.add('is-open');
    setTimeout(() => { elEditInput.focus(); elEditInput.select(); }, 0);
  }
  function closeEditor() {
    elEditWrap.classList.remove('is-open');
    elTargetBtn.style.display = '';
  }
  async function saveTarget() {
    const v = parseFloat(elEditInput.value);
    if (!Number.isFinite(v) || v < 1 || v > 1000000) {
      elEditInput.style.borderColor = 'var(--bear-1)';
      setTimeout(() => { elEditInput.style.borderColor = ''; }, 800);
      return;
    }
    elEditSave.disabled = true;
    try {
      await API.put('/api/daily-target', { targetThb: v });
      closeEditor();
      await refresh();
    } catch (err) {
      console.warn('dailyTarget: save failed', err && err.message);
      elEditInput.style.borderColor = 'var(--bear-1)';
      setTimeout(() => { elEditInput.style.borderColor = ''; }, 800);
    } finally {
      elEditSave.disabled = false;
    }
  }
  elTargetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditor();
  });
  elEditCancel.addEventListener('click', closeEditor);
  elEditSave.addEventListener('click', saveTarget);
  elEditInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveTarget();
    else if (e.key === 'Escape') closeEditor();
  });

  // ─── Popover (click anywhere except target-btn + edit + info) ───
  function togglePopover(e) {
    if (elEditWrap.contains(e.target)) return;
    if (elPopover.contains(e.target)) return;
    if (elTargetBtn.contains(e.target)) return;
    elPopover.classList.toggle('is-open');
  }
  elBar.addEventListener('click', togglePopover);
  elInfoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    elPopover.classList.toggle('is-open');
  });

  // ─── Share card (lazy-load shareCard.js ครั้งแรกที่กดปุ่ม) ───────────────
  let shareCardLoading = false;
  function loadShareCard() {
    return new Promise((resolve, reject) => {
      if (window.ShareCard) return resolve(window.ShareCard);
      if (shareCardLoading) {
        // รอจนกว่า script จะ load เสร็จ
        const check = setInterval(() => {
          if (window.ShareCard) { clearInterval(check); resolve(window.ShareCard); }
        }, 50);
        setTimeout(() => { clearInterval(check); reject(new Error('ShareCard load timeout')); }, 5000);
        return;
      }
      shareCardLoading = true;
      const s = document.createElement('script');
      s.src = '/js/partials/shareCard.js?v=2026-09-02-h1';
      s.async = true;
      s.onload = () => resolve(window.ShareCard);
      s.onerror = () => reject(new Error('shareCard.js load failed'));
      document.head.appendChild(s);
    });
  }
  if (elShareBtn) {
    elShareBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!lastData) {
        elShareBtn.textContent = '⏳ รอข้อมูล...';
        setTimeout(() => { if (elShareBtn) elShareBtn.textContent = '📸 สร้างการ์ดแชร์'; }, 1200);
        return;
      }
      const original = elShareBtn.textContent;
      elShareBtn.disabled = true;
      elShareBtn.textContent = '⏳ กำลังโหลด...';
      try {
        const ShareCard = await loadShareCard();
        ShareCard.showPreview(lastData);
      } catch (err) {
        console.warn('ShareCard load failed', err);
        elShareBtn.textContent = '❌ โหลดไม่สำเร็จ';
      } finally {
        setTimeout(() => {
          elShareBtn.disabled = false;
          elShareBtn.textContent = original;
        }, 600);
      }
    });
  }
  document.addEventListener('click', (e) => {
    if (!elBar.contains(e.target) && !elPopover.contains(e.target)) {
      elPopover.classList.remove('is-open');
    }
  });

  // ─── WS live update: optimistic + debounced reconcile ──────────
  function scheduleReconcile() {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(refresh, 1500);
  }
  if (typeof WSClient !== 'undefined') {
    WSClient.on('trade:update', (p) => {
      if (!p) return;
      if (p.state === 'sold' && p.realizedPnl != null && lastData) {
        const next = JSON.parse(JSON.stringify(lastData));
        const fxRate = Number(next.fxRate) || 0;
        const incThb = Number(p.realizedPnl) * fxRate;
        next.todayPnlUsdt = Number(next.todayPnlUsdt || 0) + Number(p.realizedPnl);
        next.todayPnlThb  = Number(next.todayPnlThb  || 0) + incThb;
        next.todayTrades  = (next.todayTrades || 0) + 1;
        if (Number(p.realizedPnl) > 0) {
          next.todayWins = (next.todayWins || 0) + 1;
          next.todayGrossProfit = Number(next.todayGrossProfit || 0) + Number(p.realizedPnl);
        } else if (Number(p.realizedPnl) < 0) {
          next.todayLosses = (next.todayLosses || 0) + 1;
          next.todayGrossLoss = Number(next.todayGrossLoss || 0) + Number(p.realizedPnl);
        }
        next.winRate = next.todayTrades ? (next.todayWins / next.todayTrades) * 100 : 0;
        next.pct = next.targetThb > 0
          ? Math.max(-100, Math.min(200, (next.todayPnlThb / next.targetThb) * 100))
          : 0;
        next.zone = next.pct >= 100 ? 'achieved'
                  : next.pct >= 70  ? 'hot'
                  : next.pct >= 30  ? 'warming'
                  : next.pct >= 0   ? 'cold' : 'loss';
        next.remainingThb = next.targetThb - next.todayPnlThb;
        applyData(next, { animate: true });
        scheduleReconcile();
      } else {
        scheduleReconcile();
      }
    });
  }

  // ─── Polling fallback (60s) ────────────────────────────────────
  pollTimer = setInterval(refresh, 60 * 1000);

  // ─── Day-rollover refresh (BKK midnight + 5s) ──────────────────
  function scheduleRolloverRefresh() {
    // FIX-2026-08-08: same +7h offset fix as backend startOfTodayBkk().
    //   Previous pattern mis-identified BKK date during 00:00–06:59 BKK —
    //   the timer would fire 23h late instead of 5s after the next BKK midnight.
    //   Polling fallback (60s) was masking the bug; data was still correct via API.
    const now = new Date();
    const bkkMs = now.getTime() + 7 * 60 * 60_000;
    const bkk = new Date(bkkMs);
    const nextMidnightUtc = Date.UTC(
      bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate() + 1,
      -7, 0, 5
    );
    const wait = Math.max(60_000, nextMidnightUtc - Date.now());
    setTimeout(() => { refresh(); scheduleRolloverRefresh(); }, wait);
  }

  refresh();
  scheduleRolloverRefresh();

  window.__dtb = {
    refresh,
    openEditor,
    closeEditor,
    get data() { return lastData; },
  };
})();