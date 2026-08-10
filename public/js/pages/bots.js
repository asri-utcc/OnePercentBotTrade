'use strict';

// luxConfirm / luxAlert / bindPasswordToggles / callBotWithPassword used to be
// defined here. They now live in public/js/luxConfirm.js (loaded before this
// script in both bots.html and bot-detail.html). Backwards-compat aliases were
// set on `window.*` inside that file, so this existing call-sites below
// continue to work without churn.

let bots = [];

// ── 2026-07-31: View mode toggle (compact | expand) — persisted in localStorage ────────
const BOT_VIEW_MODE_KEY = 'botsListViewMode';
// FIX-2026-08-05: track last rendered view mode — used by renderBots() to force-rebuild
//   cards when user toggles compact↔expand (without this, masterSetChanged stays false on
//   toggle, so the .is-compact/.is-expand class on existing cards never updates → กราฟ+tiles ค้างซ่อน)
let _lastRenderedViewMode = null;
function getBotViewMode() {
  try {
    const v = localStorage.getItem(BOT_VIEW_MODE_KEY);
    return v === 'expand' ? 'expand' : 'compact'; // default = compact (per user)
  } catch (_) { return 'compact'; }
}
function setBotViewMode(mode) {
  try { localStorage.setItem(BOT_VIEW_MODE_KEY, mode); } catch (_) { /* ignore */ }
  const compactBtn = document.getElementById('vm-compact');
  const expandBtn = document.getElementById('vm-expand');
  if (compactBtn) compactBtn.classList.toggle('is-active', mode === 'compact');
  if (expandBtn) expandBtn.classList.toggle('is-active', mode === 'expand');
}
function wireViewModeToggle() {
  const compactBtn = document.getElementById('vm-compact');
  const expandBtn = document.getElementById('vm-expand');
  if (!compactBtn || !expandBtn) return;
  setBotViewMode(getBotViewMode()); // sync initial UI state
  // FIX-2026-08-02: if user prefers expand mode, load volatility snapshot on init (cold cache may take ~1.5s)
  const initMode = getBotViewMode();
  if (initMode === 'expand') {
    loadBots({ expand: true }).catch(() => {});
  }
  compactBtn.addEventListener('click', () => {
    if (getBotViewMode() === 'compact') return;
    setBotViewMode('compact');
    // FIX-2026-08-05: renderBots() detects viewModeChanged → force-rebuild cards with .is-compact
    //   (cards เดิมที่มี class .is-expand จะถูกแทนที่ด้วย .is-compact → CSS ซ่อนกราฟ+tiles ทันที)
    renderBots();
  });
  expandBtn.addEventListener('click', () => {
    if (getBotViewMode() === 'expand') return;
    setBotViewMode('expand');
    // FIX-2026-08-02: re-fetch with ?expand=1 to get volatility snapshot (for tiles)
    //   - cached snapshot reused if recent (60s server-side)
    // FIX-2026-08-05: loadBots() internally calls renderBots() ซึ่งจะ trigger rebuild
    //   ผ่าน viewModeChanged → ไม่ต้องเรียก renderBots() ซ้ำ
    loadBots({ expand: true }).catch(() => {});
  });
}

// ── 2026-07-30: Open Positions (cross-bot) state ─────────
let openPositionsData = null;       // { asOf, count, totalCostUsdt, totalUnrealizedUsdt, positions: [...] }
let openPositionsAsOf = null;       // last fetch timestamp
let tradeIdToBotId = new Map();     // tradeId -> botId (used by WS trade:update handler)
let modalPriceOverrides = new Map();// tradeId -> live close price (UNUSED 2026-08-03 — WS price auto-update ถูกปิดแล้ว)
let currentModalOp = null;          // bootstrap.Modal instance for #openPositionsModal

// ── FIX-2026-08-05: Bot search & filter (client-side) ────────
//   - text search: match name / symbol / timeframe / status (case-insensitive)
//   - filter chips: multi-select (AND logic) — running / stopped / has-position /
//     has-error / has-warning / dca
//   - chip state persisted in localStorage (BOT_FILTER_KEY) — refresh แล้ว state คงอยู่
//   - search query NOT persisted (always fresh on reload)
//   - counter "X/Y" shown next to title when filter is active
const BOT_FILTER_KEY = 'botsListFilter';
const botFilter = {
  query: '',          // search input value (transient)
  chips: new Set(),   // active filter chip keys (persisted)
};

function loadBotFilter() {
  try {
    const raw = localStorage.getItem(BOT_FILTER_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.chips)) {
      botFilter.chips = new Set(parsed.chips.filter((c) => typeof c === 'string'));
    }
  } catch (_) { /* ignore corrupt JSON */ }
}
function saveBotFilter() {
  try {
    localStorage.setItem(BOT_FILTER_KEY, JSON.stringify({
      chips: [...botFilter.chips],
    }));
  } catch (_) { /* ignore quota / private mode */ }
}

function botMatchesFilters(b) {
  // text search: name + symbol + timeframe + status (case-insensitive substring)
  if (botFilter.query) {
    const q = botFilter.query.toLowerCase();
    const hay = [
      b.name || '',
      b.symbol || '',
      b.timeframe || '',
      b.status || '',
    ].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  // chip filters (AND — ทุก chip ที่ active ต้องผ่าน)
  if (botFilter.chips.size > 0) {
    const now = Date.now();
    // FIX-2026-08-08: Feature #4 — cooldown sub-categories
    const cbv2Active = b.cbv2LockedUntil && new Date(b.cbv2LockedUntil).getTime() > now;
    const cbv3Active = b.cbv3LockedUntil && new Date(b.cbv3LockedUntil).getTime() > now;
    const dcaFrozen = b.dcaFrozen === true || b.dcaCooldownUntil && new Date(b.dcaCooldownUntil).getTime() > now;
    const sellPartialFrozen = b.sellPartialFrozen === true;
    const anyCooldown = cbv2Active || cbv3Active || dcaFrozen || sellPartialFrozen;
    for (const chip of botFilter.chips) {
      switch (chip) {
        case 'running':      if (!b.enabled) return false; break;
        case 'stopped':      if (b.enabled)  return false; break;
        case 'has-position': if (!((b.activePositionsCount || 0) > 0)) return false; break;
        case 'has-error':    if (!b.lastError)   return false; break;
        case 'has-warning':  if (!b.warning)     return false; break;
        case 'dca':          if (!b.dcaEnabled)  return false; break;
        // FIX-2026-08-08: Feature #4 — Cooldown sub-categories
        case 'cooldown':       if (!anyCooldown) return false; break;
        case 'cbv2-cooldown':  if (!cbv2Active)  return false; break;
        case 'cbv3-cooldown':  if (!cbv3Active)  return false; break;
        default: break; // unknown chip → ignore
      }
    }
  }
  return true;
}

function getFilteredBots() {
  // fast path: no filter active → return original array reference (surgical in-place update works)
  if (!botFilter.query && botFilter.chips.size === 0) return bots;
  return bots.filter(botMatchesFilters);
}

function isFilterActive() {
  return botFilter.query.length > 0 || botFilter.chips.size > 0;
}

function updateFilterCounter() {
  const counter = document.getElementById('bot-filter-counter');
  if (!counter) return;
  const total = bots.length;
  if (total === 0) {
    counter.textContent = '0';
    counter.classList.remove('is-filtered');
    counter.title = 'ยังไม่มีบอท';
    return;
  }
  if (isFilterActive()) {
    const visible = getFilteredBots().length;
    counter.textContent = `${visible}/${total}`;
    counter.classList.add('is-filtered');
    counter.title = `แสดง ${visible} จาก ${total} บอท`;
  } else {
    counter.textContent = `${total}`;
    counter.classList.remove('is-filtered');
    counter.title = `ทั้งหมด ${total} บอท`;
  }
}

function renderNoResultsEmpty() {
  const parts = [];
  if (botFilter.query) parts.push(`search: <code>${escapeHtml(botFilter.query)}</code>`);
  if (botFilter.chips.size > 0) {
    parts.push(`chips: ${[...botFilter.chips].map((c) => `<code>${escapeHtml(c)}</code>`).join(', ')}`);
  }
  return `
    <div class="bot-search-empty">
      <span class="glyph">🔍</span>
      <div class="ttl">ไม่พบบอทที่ตรงกับเงื่อนไข</div>
      <div class="sub">${parts.length > 0 ? 'กำลังกรอง: ' + parts.join(' · ') : 'ลองค้นหาด้วยคำอื่น หรือเปลี่ยน filter'}</div>
      <button class="btn-lux btn-bear btn-sm" type="button" id="bot-search-empty-clear">✕ ล้างตัวกรอง</button>
    </div>
  `;
}

function applyBotFilter() {
  // Surgical renderBots() will pick up the new filter via getFilteredBots() — no need to teardown charts here
  renderBots();
}

function updateClearAllVisibility() {
  const clearAll = document.getElementById('bot-filter-clear');
  if (!clearAll) return;
  clearAll.hidden = !isFilterActive();
}

function clearBotFilter() {
  botFilter.query = '';
  botFilter.chips.clear();
  saveBotFilter();
  // sync DOM
  const input = document.getElementById('bot-search-input');
  if (input) input.value = '';
  const clearBtn = document.getElementById('bot-search-clear');
  if (clearBtn) clearBtn.hidden = true;
  document.querySelectorAll('.bot-chip[data-filter]').forEach((el) => {
    el.classList.remove('is-active');
  });
  updateClearAllVisibility();
  applyBotFilter();
}

function setupBotSearch() {
  const input = document.getElementById('bot-search-input');
  const clearBtn = document.getElementById('bot-search-clear');
  const clearAllBtn = document.getElementById('bot-filter-clear');
  const chipsContainer = document.getElementById('bot-filter-chips');
  if (!input || !chipsContainer) return;

  // restore persisted chip state
  loadBotFilter();
  for (const chip of botFilter.chips) {
    const el = chipsContainer.querySelector(`.bot-chip[data-filter="${chip}"]`);
    if (el) el.classList.add('is-active');
  }
  updateClearAllVisibility();

  // search input: in-memory filter is fast — no debounce needed
  input.addEventListener('input', (e) => {
    botFilter.query = String(e.target.value || '').trim();
    if (clearBtn) clearBtn.hidden = botFilter.query.length === 0;
    updateClearAllVisibility();
    applyBotFilter();
  });

  // ESC ล้าง search (เมื่อ input focused)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && botFilter.query) {
      e.preventDefault();
      input.value = '';
      botFilter.query = '';
      if (clearBtn) clearBtn.hidden = true;
      updateClearAllVisibility();
      applyBotFilter();
    }
  });

  // × button (clear search)
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      botFilter.query = '';
      clearBtn.hidden = true;
      input.focus();
      updateClearAllVisibility();
      applyBotFilter();
    });
  }

  // chip click: toggle is-active + persist + re-render
  chipsContainer.addEventListener('click', (e) => {
    const chip = e.target.closest('.bot-chip[data-filter]');
    if (!chip) return;
    const key = chip.dataset.filter;
    if (botFilter.chips.has(key)) {
      botFilter.chips.delete(key);
      chip.classList.remove('is-active');
    } else {
      botFilter.chips.add(key);
      chip.classList.add('is-active');
    }
    saveBotFilter();
    updateClearAllVisibility();
    applyBotFilter();
  });

  // "ล้างทั้งหมด" button
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', clearBotFilter);
  }

  // empty-state "ล้างตัวกรอง" button (delegated — ปุ่มนี้ถูกสร้างใหม่ทุก render)
  const botsList = document.getElementById('bots-list');
  if (botsList) {
    botsList.addEventListener('click', (e) => {
      if (e.target.closest('#bot-search-empty-clear')) {
        clearBotFilter();
      }
    });
  }
}

// ── FIX-2026-08-01: Bot Quality Indicator pill (badge for bot card) ─────
//   - HTML returned by buildQualityBadge — string template (uses escapeHtml from below)
//   - คลิก → delegated ใน init() → qualityModal.openQualityModal(bot)
function buildQualityBadge(b) {
  if (b.qualityEnabled === false || b.qualityScore == null) {
    return '<span class="quality-pill is-gray" title="Quality Indicator ถูกปิดหรือยังโหลดไม่เสร็จ">—</span>';
  }
  const updated = b.qualityUpdatedAt ? new Date(b.qualityUpdatedAt).toLocaleTimeString('th-TH') : '-';
  const tip = `คลิกเพื่อดู breakdown · อัปเดตล่าสุด: ${updated}`;
  return `<span class="quality-pill is-${b.qualityColor || 'gray'}" data-quality-trigger="${escapeHtml(String(b._id))}" title="${escapeHtml(tip)}">${b.qualityScore}/4</span>`;
}

// ── FIX-2026-08-03: Safe-trade filter #2 (trendline) badge ─────────────
//   - แสดงสถานะ live ว่าราคา last close อยู่เหนือเส้น trendline support บน upper-TF หรือไม่
//   - อัปเดตทุก 60s จาก botManager scanner → /api/bots response มี tlStatus/tlGapPct/tlUpdatedAt
//   - status ∈ 'pass' | 'blocked' | 'warmup' | 'insufficient_data' | 'api_error' | 'no_trend_tf'
//   - เมื่อ filter ปิด (b.tlEnabled !== true) → ซ่อน badge ทั้งหมด (ไม่ให้รก UI)
//   - เมื่อ filter เปิดแต่ยังไม่ scan (b.tlStatus == null) → แสดง ⏳ pending
function buildTrendlineBadge(b) {
  if (b.tlEnabled !== true) return ''; // filter OFF → ไม่แสดง
  const status = b.tlStatus;
  const tfUpper = b.tlTrendTF || '?';
  const lastClose = b.tlLastClose;
  const tlValue = b.tlTrendlineValue;
  const gap = b.tlGapPct;
  const updatedAt = b.tlUpdatedAt ? new Date(b.tlUpdatedAt).toLocaleTimeString('th-TH') : '-';

  // Common: compose tooltip showing lastClose + trendline + gap + TF + updated time
  const tipLines = [
    `📐 Safe-trade filter #2 (trendline support)`,
    `Upper-TF: ${tfUpper}`,
    lastClose != null ? `Last close: ${Number(lastClose).toFixed(6)}` : null,
    tlValue != null ? `Trendline: ${Number(tlValue).toFixed(6)}` : null,
    gap != null ? `Gap: ${gap >= 0 ? '+' : ''}${Number(gap).toFixed(2)}%` : null,
    `อัปเดตล่าสุด: ${updatedAt}`,
  ].filter(Boolean).join('\n');

  // Render per status
  if (status === 'pass') {
    const gapTxt = gap != null ? `+${Number(gap).toFixed(2)}%` : '';
    return `<span class="trendline-pill is-pass" title="${escapeHtml(tipLines)}">📐 ✅ ${gapTxt}</span>`;
  }
  if (status === 'blocked') {
    const gapTxt = gap != null ? `${Number(gap).toFixed(2)}%` : '';
    return `<span class="trendline-pill is-blocked" title="${escapeHtml(tipLines)}">📐 ❌ ${gapTxt}</span>`;
  }
  if (status === 'warmup') {
    return `<span class="trendline-pill is-warmup" title="${escapeHtml(tipLines)}">📐 ⏳ warmup</span>`;
  }
  if (status === 'insufficient_data') {
    return `<span class="trendline-pill is-warn" title="${escapeHtml(tipLines)}">📐 ⚠️ data</span>`;
  }
  if (status === 'api_error') {
    return `<span class="trendline-pill is-warn" title="${escapeHtml(tipLines)}">📐 ⚠️ api</span>`;
  }
  if (status === 'no_trend_tf') {
    return `<span class="trendline-pill is-warn" title="${escapeHtml(tipLines)}">📐 ⚠️ no-tf</span>`;
  }
  // status == null (not yet scanned) or unknown
  return `<span class="trendline-pill is-pending" title="Safe-trade #2 filter เปิดอยู่ — รอ scanner tick (≤ 60s)">📐 — pending</span>`;
}

// FIX-2026-08-06: delist badge — แสดงเมื่อ symbol มีความเสี่ยงจะถูก delist
//   - isDelisted → ❌ DELISTED (red pill) — symbol ถูก delist ไปแล้ว
//   - daysUntil <= 3 → 🚨 DELIST 2.4d (red) — ใกล้ถึงเวลา force-close
//   - daysUntil <= 7 → ⚠️ DELIST 5.2d (orange) — ใกล้ถึงเวลา block BUY
//   - daysUntil > 7 → 📅 DELIST 14d (yellow) — มี schedule แต่ยังมีเวลา
//   - isAtRisk (Monitoring tag only, no schedule) → 👁️ MONITORING (gray) — early warning
//   - ถ้าไม่มี flag ใดเลย → ไม่แสดง (empty)
function buildDelistBadge(b) {
  if (b.isDelisted === true) {
    return `<span class="delist-pill is-delisted" title="Symbol ถูก delist ไปแล้ว">❌ DELISTED</span>`;
  }
  if (b.daysUntil != null && Number.isFinite(b.daysUntil)) {
    const dt = b.delistDateIso ? new Date(b.delistDateIso).toLocaleString('th-TH') : '?';
    const days = b.daysUntil.toFixed(1);
    let cls = 'is-scheduled';
    let icon = '📅';
    if (b.daysUntil <= 3) { cls = 'is-urgent'; icon = '🚨'; }
    else if (b.daysUntil <= 7) { cls = 'is-warning'; icon = '⚠️'; }
    const tip = `Binance Delist Schedule\nDelist: ${dt}\nDays until: ${days}\n• ≤ 7d: block new BUY\n• ≤ 3d: force-close position`;
    return `<span class="delist-pill ${cls}" title="${escapeHtml(tip)}">${icon} DELIST ${days}d</span>`;
  }
  if (b.isAtRisk === true) {
    return `<span class="delist-pill is-monitoring" title="Binance ติด Monitoring tag — early warning">👁️ MONITORING</span>`;
  }
  return '';
}


async function init() {
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me || !me.authenticated) {
    location.href = '/login.html';
    return;
  }

  WSClient.start();
  setupEventHandlers();
  // FIX-2026-08-02: parallelize — 6 independent loads run concurrently (was sequential ~3s, now ~1.7s)
  //   - loadSymbols → /api/bots/symbols (used for "New Bot" modal only)
  //   - PriceFormat.load → /api/bots/symbols (precision tickSize for price formatting)
  //   - loadBots → /api/bots (compact mode = no volatility snapshot, fast)
  //   - loadBalance → /api/account/balance
  //   - loadApiKeysStatus → /api/auth/api-keys/status
  //   - refreshPnlShortcut → /api/pnl/summary/today (label only)
  //   - loadOpenPositions → /api/bots/positions (cross-bot open positions tile)
  await Promise.all([
    loadSymbols(),
    window.PriceFormat ? window.PriceFormat.load() : Promise.resolve(),
    loadBots(),
    loadBalance(),
    loadApiKeysStatus(),
    refreshPnlShortcut(),
    loadOpenPositions(),
    loadBnbStatus(), // FIX-2026-08-05: BNB low-balance warning banner
  ]);

  // FIX-2026-08-02: kick off slow quality compute in background — first paint shows pills "—"
  //   - server returns getCachedOnly() which is 0ms if cached, null otherwise
  //   - this background fetch forces full compute + warms cache for next loads
  setTimeout(() => {
    API.get('/api/bots?quality=1').then((resp) => {
      if (resp && resp.bots) {
        // merge quality scores into local bots array
        for (const fresh of resp.bots) {
          const local = bots.find((b) => String(b._id) === String(fresh._id));
          if (local) {
            local.qualityScore = fresh.qualityScore;
            local.qualityColor = fresh.qualityColor;
            local.qualityUpdatedAt = fresh.qualityUpdatedAt;
            local.qualityCached = fresh.qualityCached;
          }
        }
        renderBots();
      }
    }).catch(() => { /* fail-safe — pill stays "—" */ });
  }, 1500); // 1.5s after first paint — กัน Binance weight contention

  // FIX-2026-07-31: wire Compact/Expand toggle (default = compact)
  wireViewModeToggle();

  // FIX-2026-08-05: wire search input + filter chips (persisted in localStorage)
  setupBotSearch();

  // FIX-2026-07-31: deep-link จาก scan-volatility — ?newBot=1&symbol=BTCUSDT&tf=5m
  //   - pre-fill symbol/timeframe ใน create modal แล้วเปิดอัตโนมัติ
  //   - ลบ query params ออกจาก URL หลังเปิด modal (back/refresh ไม่ trigger ซ้ำ)
  //   - FIX-2026-08-07: name auto-fill ย้ายไป show.bs.modal handler (autoFillNewBotName) — รูปแบบ "<BASE>(bAdd)"
  const params = new URLSearchParams(location.search);
  if (params.get('newBot') === '1') {
    const symbol = params.get('symbol');
    const tf = params.get('tf');
    if (symbol) document.getElementById('nb-symbol').value = String(symbol).toUpperCase();
    if (tf) document.getElementById('nb-timeframe').value = tf;
    // ลบ query ออกจาก URL
    const cleanUrl = location.pathname;
    history.replaceState(null, '', cleanUrl);
    // เปิด modal (delay เล็กน้อยเพื่อให้ Bootstrap init เสร็จ)
    setTimeout(() => {
      const modalEl = document.getElementById('newBotModal');
      if (modalEl && window.bootstrap && bootstrap.Modal) {
        bootstrap.Modal.getOrCreateInstance(modalEl).show();
      }
    }, 200);
  }

  // re-render once nav.js publishes the FX rate (so THB equivalents appear)
  document.addEventListener('fx:updated', () => {
    if (bots.length > 0) {
      renderBots();
      renderStats();
    }
    if (openPositionsData) renderOpenPositionsModalBody(); // 2026-07-30: refresh THB in modal
  });
  // also re-render if FX was already cached by nav.js before this script ran
  if (window.__fxReady && bots.length > 0) {
    renderBots();
    renderStats();
  }
  if (window.__fxReady && openPositionsData) renderOpenPositionsModalBody();

  WSClient.on('bot:status', (p) => {
    const bot = bots.find((b) => b._id === p.botId);
    if (bot) {
      bot.status = p.status;
      renderBots();
    }
  });
  WSClient.on('bot:updated', () => loadBots());
  WSClient.on('trade:update', (p) => {
    // FIX-2026-07-23: lightweight update — update active count + status of affected bot
    //   โดยไม่ต้อง loadBots() ทุกครั้ง (ลด network + flicker)
    const bot = bots.find((b) => b._id === p.botId);
    if (bot) {
      // ดึง active count ใหม่ — fallback loadBots() ถ้า trade มี botId ที่ไม่รู้จัก
      if (p.botId) {
        // update highlight class แบบ in-place ก่อน แล้ว trigger loadBots ที่ background
        renderBots();
      } else {
        loadBots();
      }
    } else {
      loadBots();
    }
    // FIX-2026-07-29: refresh PnL shortcut label เมื่อมี SELL fill (today's PnL เปลี่ยน)
    if (p && p.state === 'sold') refreshPnlShortcut();
    // 2026-07-30: refetch open positions when any relevant trade transitions
    //   - always refresh on sold/cancelled/failed (positions count drops)
    //   - refresh when known tradeId transitions (BUY→filled, SELL→selling/stopping)
    //   - refresh when payload has no tradeId (defensive — global event)
    const isExitState = p && ['sold', 'cancelled', 'failed'].includes(p.state);
    const isKnown = p && p.tradeId && tradeIdToBotId.has(p.tradeId);
    if (!p || !p.tradeId || isKnown || isExitState) {
      loadOpenPositions();
    }
  });
  WSClient.on('health:update', (s) => renderHeartbeat(s));

  // FIX-2026-07-23: realtime EMA + price update จาก WS kline
  //   - ฟัง kline:update ทุกตัว → match กับ bot card → update tile in-place (ไม่ re-render ทั้ง card)
  //   - FIX-2026-08-03: ลบ live mark-to-market สำหรับ Open Positions modal ออก
  //     (user ต้องการกด Refresh เอง — ไม่ให้ราคาใน modal เด้งตาม WS tick)
  //     เก็บเฉพาะ bot card EMA update (ตัวเลขนั้นสำคัญกับ signal decision)
  WSClient.on('kline:update', (p) => {
    if (!p || !p.kline || !p.interval) return;
    const symbol = p.kline.symbol;
    const interval = p.interval;
    const close = parseFloat(p.kline.close);
    if (!Number.isFinite(close) || close <= 0) return;
    // หา bot ที่ตรงกัน — ใช้ data-symbol/data-timeframe attribute
    const cards = document.querySelectorAll(`.bot-card-v2[data-symbol="${symbol}"][data-timeframe="${interval}"]`);
    cards.forEach((card) => updateCardEma(card, close));
    // FIX-2026-08-03: modal price override ถูกปิด (เดิมอัปเดต modalPriceOverrides + re-render modal ทุก tick)
    //   - ตอนนี้ modal จะ refresh ก็ต่อเมื่อ user กดปุ่ม "🔄 Refresh" (loadOpenPositions({ fresh: true }))
  });

  // FIX-2026-08-03: ลบ 30s fallback poll ออก — user ต้องการกด Refresh เองเท่านั้น
  //   - เดิมตั้งใจไว้กัน WS ตกหล่น แต่ user บ่นว่าราคากระโดดบ่อย/อัปเดตไม่ทัน → ควบคุมเอง
  //   - modal tile count ยังอัปเดตผ่าน trade:update WS handler (เมื่อ BUY/SELL fill → position count เปลี่ยน)
  //   - modal price/PnL จะอยู่นิ่งจนกว่า user จะกดปุ่ม 🔄 Refresh ใน modal (loadOpenPositions({ fresh: true }))

  // FIX-2026-08-04: re-fetch bot list (with quality scores) ทุก 120s
  //   - ลดจาก 60s → 120s (ลด DB load) — display อาจ delay 5-15s แต่ bot operations intact
  //   - ยังได้ live updates ผ่าน WS kline:update (EMA tile) + trade:update (active positions)
  //   - surgical renderBots() ไม่ rebuild DOM เว้นแต่ bot set เปลี่ยน
  setInterval(() => { loadBots().catch(() => {}); }, 120_000);

  // FIX-2026-08-05: refresh BNB low-balance banner ทุก 60s
  //   - backend cache 30s → frontend poll 60s พอ (max 2 calls/min ไม่กระทบ Binance weight)
  //   - independent จาก loadBots — banner ต้องอัปเดตเร็วกว่า bot list เมื่อ BNB ลดลง
  setInterval(() => { loadBnbStatus().catch(() => {}); }, 60_000);

  // FIX-2026-08-01: click delegation สำหรับ Quality Indicator pill — เปิด modal
  document.getElementById('bots-list').addEventListener('click', (e) => {
    const el = e.target.closest('[data-quality-trigger]');
    if (!el) return;
    const id = el.getAttribute('data-quality-trigger');
    const bot = bots.find((b) => String(b._id) === String(id));
    if (bot && window.qualityModal) window.qualityModal.openQualityModal(bot);
  });

  // โหลด health ครั้งแรก (กรณี WS ยังไม่ติด)
  API.get('/api/health').then((s) => renderHeartbeat(s)).catch(() => {});

  document.getElementById('logout-btn').onclick = async (e) => {
    e.preventDefault();
    await API.post('/api/auth/logout', {});
    location.href = '/login.html';
  };

  // Wire the password show/hide eye toggles for every modal on the page
  bindPasswordToggles();
}

function setupEventHandlers() {
  document.getElementById('new-bot-btn').onclick = () => {
    document.getElementById('nb-error').textContent = '';
    document.getElementById('nb-password').value = '';
    updateNewBotTotal();
  };
  // FIX-2026-08-01: Master Config — bulk-edit หลายบอทพร้อมกัน
  const masterBtn = document.getElementById('btn-master-config');
  if (masterBtn) masterBtn.onclick = () => window.masterConfigModal && window.masterConfigModal.openMasterConfigModal();

  ['nb-capital', 'nb-maxtrades'].forEach((id) => {
    document.getElementById(id).addEventListener('input', updateNewBotTotal);
  });

  document.getElementById('nb-create').onclick = createBot;
  document.getElementById('refresh-balance').onclick = loadBalance;
  document.getElementById('ak-save').onclick = saveApiKeys;
  document.getElementById('nb-tp-recommend').onclick = recommendNewBotTp;
  // FIX-2026-07-29: shortcut → /pnl.html
  document.getElementById('pnl-shortcut-btn').onclick = () => { location.href = '/pnl.html'; };

  // FIX-2026-08-07: New Bot modal life-cycle hooks
  //   - บน show.bs.modal: auto-fill name จาก symbol (BTCUSDT → BTC(bAdd)) และ auto-trigger ✨ Get TP%
  //   - ใช้ symbol change → re-derive name (ถ้า name ยังเป็น auto-fill pattern)
  //   - ครอบคลุมทั้ง click "+ New Bot" และ deep-link จาก scan-volatility
  // FIX-2026-08-08 (rev3): apply Bot Defaults (จาก /settings.html section 1️⃣) — pre-fill inputs ตอนเปิด modal
  const newBotModalEl = document.getElementById('newBotModal');
  if (newBotModalEl) {
    newBotModalEl.addEventListener('show.bs.modal', async () => {
      // delay เล็กน้อยเพื่อให้ deep-link handler (set nb-symbol/nb-timeframe) เสร็จก่อน
      // และ fetch Bot Defaults → pre-fill (ถ้า user ยังไม่เคยแก้ field นั้น)
      await applyBotDefaultsToNewBot();
      setTimeout(() => {
        autoFillNewBotName();
        // FIX-2026-08-07: auto-trigger ✨ Get เพื่อให้ TP% default = NET จาก Min %KC(window) + EMA20 trend
        autoTriggerNewBotTp();
        // FIX-2026-08-08: hide CBv2 OR CBv3 section based on AppConfig.cbVersion (master toggle)
        // FIX-2026-08-10: CBv5 ⚙️ ขั้นสูง toggle (advanced params)
        const advToggle = document.getElementById('nb-cbv5-advanced-toggle');
        const adv = document.getElementById('nb-cbv5-advanced');
        if (advToggle && adv && !advToggle._cbv5AdvBound) {
          advToggle._cbv5AdvBound = true;
          advToggle.addEventListener('click', () => {
            const show = adv.style.display === 'none';
            adv.style.display = show ? '' : 'none';
            advToggle.textContent = show ? '⚙️ ซ่อนขั้นสูง' : '⚙️ ขั้นสูง (KC + Pivot + Volume)';
          });
        }
        applyCbVersionToNewBot();
      }, 50);
    });
  }

  // FIX-2026-08-08: apply cbVersion to new-bot modal — hide the inactive CB version
  //   - fetched from /api/admin/app-config
  //   - shows only the active version's section + matching badge text
  //   - safe if endpoint returns 401 (fallback to v3 default)
  async function applyCbVersionToNewBot() {
    try {
      const resp = await API.get('/api/admin/app-config');
      const ver = resp?.config?.cbVersion || 'v3';
      window._newBotCbVersion = ver;
      const cbv2El = document.getElementById('nb-cbv2-section');
      const cbv3El = document.getElementById('nb-cbv3-section');
      if (cbv2El) cbv2El.style.display = ver === 'v2' ? '' : 'none';
      if (cbv3El) cbv3El.style.display = ver === 'v3' ? '' : 'none';
      // FIX-2026-08-10: CBv5 always visible (independent of cbVersion)
      const cbv5El = document.getElementById('nb-cbv5-section');
      if (cbv5El) cbv5El.style.display = '';
      const badge = document.getElementById('nb-cbv-version-badge');
      if (badge) badge.textContent = ver;
    } catch (e) {
      window._newBotCbVersion = 'v3';
      console.warn('applyCbVersionToNewBot failed:', e.message);
    }
  }
  // FIX-2026-08-08 (rev3): apply Bot Defaults จาก AppConfig → pre-fill New Bot modal
  //   - fetched from /api/admin/bot-defaults
  //   - ใช้เฉพาะ field ที่ user ยังไม่เคยแก้ใน session นี้ (กัน override หลัง user พิมพ์เอง)
  //   - ถ้า API fail → ใช้ HTML default (เดิม)
  async function applyBotDefaultsToNewBot() {
    if (window._botDefaultsApplied) return; // ใช้ครั้งเดียวต่อ session
    try {
      const resp = await API.get('/api/admin/bot-defaults');
      const d = resp && resp.defaults ? resp.defaults : {};
      const set = (id, val) => { const el = document.getElementById(id); if (el != null && val != null) el.value = val; };
      const setChecked = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
      // ทุน & ความเสี่ยง
      set('nb-capital', d.capitalPerTrade);
      set('nb-maxtrades', d.maxTrades);
      set('nb-tp', d.tpPercent);
      set('nb-retry', d.retryTimeMin);
      set('nb-retry-max', d.retryMax);
      set('nb-kc-mult', d.kcMult);
      set('nb-min-spread', d.minSpreadTicks);
      set('nb-suggest-tp-window', d.suggestTpWindow);
      set('nb-dca-max-layers', d.dcaMaxLayers);
      set('nb-cbv2-lock-hours', d.cbv2LockHours);
      set('nb-cbv3-lock-hours', d.cbv3LockHours);
      // FIX-2026-08-10: CBv5 (Support Zone CB) defaults
      set('nb-cbv5-lock-hours', d.cbv5LockHours);
      set('nb-cbv5-kc-len', d.cbv5KcLen);
      set('nb-cbv5-kc-mult', d.cbv5KcMult);
      set('nb-cbv5-pivot-lookback', d.cbv5PivotLookback);
      set('nb-cbv5-pivot-left', d.cbv5PivotLeftLen);
      set('nb-cbv5-pivot-right', d.cbv5PivotRightLen);
      set('nb-cbv5-vol-ma-len', d.cbv5VolMaLen);
      set('nb-cbv5-vol-mult', d.cbv5VolMultiplier);
      set('nb-cbv5-debounce', d.cbv5DebounceCandles);
      set('nb-cb-auto-unlock-threshold', d.cbAutoUnlockThresholdPct);
      set('nb-auto-pause-min-kc', d.autoPauseMinKcPct);
      set('nb-auto-pause-min-24h-vol', d.autoPauseMin24hVolUsdt); // FIX-2026-08-10: 24h vol guard
      set('nb-auto-arm-loss-pct', d.autoArmLossPct);
      set('nb-auto-arm-age-hours', d.autoArmAgeHours);
      set('nb-tp-trend-multiplier', d.tpTrendMultiplier);
      // Booleans
      setChecked('nb-s1-only-down', d.s1OnlyDown);
      setChecked('nb-xs1-enabled', d.xs1Enabled);
      setChecked('nb-cb-enabled', d.cbEnabled);
      setChecked('nb-cbv2-enabled', d.cbv2Enabled);
      setChecked('nb-cbv3-enabled', d.cbv3Enabled);
      // FIX-2026-08-10: CBv5 booleans
      setChecked('nb-cbv5-enabled', d.cbv5Enabled);
      setChecked('nb-cbv5-strict-break', d.cbv5StrictBreak);
      setChecked('nb-cbv5-use-volume', d.cbv5UseVolume);
      setChecked('nb-cb-auto-unlock-enabled', d.cbAutoUnlockEnabled);
      setChecked('nb-dynamic-size-enabled', d.dynamicSizeEnabled);
      setChecked('nb-safe-trade-enabled', d.safeTradeEnabled);
      setChecked('nb-safe-trade-trendline-enabled', d.safeTradeTrendlineEnabled);
      setChecked('nb-safe-trade-no-trade-enabled', d.safeTradeNoTradeEnabled);
      setChecked('nb-auto-pause-enabled', d.autoPauseEnabled);
      setChecked('nb-auto-arm-stop-loss-ukc', d.autoArmStopLossOnUKC);
      setChecked('nb-sl-ukc-trigger-on-profit', d.slUkcTriggerOnProfit);
      setChecked('nb-tp-trend-enabled', d.tpTrendEnabled);
      setChecked('nb-auto-update-tp', d.autoUpdateTp);
      setChecked('nb-stop-loss-upper-kc', d.stopLossOnUpperKC);
      setChecked('nb-dca-enabled', d.dcaEnabled);
      // Default symbol/timeframe
      if (d.defaultSymbol) set('nb-symbol', d.defaultSymbol);
      if (d.defaultTimeframe) set('nb-timeframe', d.defaultTimeframe);
      // refresh total capital display
      if (typeof updateNewBotTotal === 'function') updateNewBotTotal();
      window._botDefaultsApplied = true;
    } catch (e) {
      // fail-open — ใช้ HTML default (เดิม)
      console.warn('applyBotDefaultsToNewBot failed:', e.message);
    }
  }
  // ถ้า user เปลี่ยน symbol — re-derive name ถ้ายังเป็น auto-fill pattern
  const symbolEl = document.getElementById('nb-symbol');
  if (symbolEl) symbolEl.addEventListener('change', autoFillNewBotName);

  // 2026-07-30: Open Positions modal lifecycle + force-close handler
  const opModalEl = document.getElementById('openPositionsModal');
  if (opModalEl) {
    currentModalOp = bootstrap.Modal.getOrCreateInstance(opModalEl);
    opModalEl.addEventListener('show.bs.modal', () => {
      // always refetch fresh data when opening (so user sees the latest)
      loadOpenPositions().then(() => renderOpenPositionsModalBody());
    });
    opModalEl.addEventListener('shown.bs.modal', () => {
      currentModalOp._isShown = true;
      // re-render once to apply price overrides + final state
      renderOpenPositionsModalBody();
    });
    opModalEl.addEventListener('hidden.bs.modal', () => {
      currentModalOp._isShown = false;
    });
  }
  const refreshBtn = document.getElementById('opm-refresh');
  if (refreshBtn) refreshBtn.onclick = () => {
    // FIX-2026-08-03: refresh button now hits /api/bots/positions?fresh=1
    //   - bypasses klineCache (in-memory, may be stale when WS dropped)
    //   - fetches latest bookTicker per symbol directly from Binance
    //   - shows loading state on the button + sub line
    loadOpenPositions({ fresh: true }).then(() => renderOpenPositionsModalBody());
  };
  const opList = document.getElementById('opm-list');
  if (opList) opList.addEventListener('click', onOpenPositionsClick);
  const opMob = document.getElementById('opm-mob');
  if (opMob) opMob.addEventListener('click', onOpenPositionsClick);
}

// FIX-2026-07-29: label = "PnL $X.XX" (today's realized PnL across all bots) — refresh on load + 60s + WS
async function refreshPnlShortcut() {
  const label = document.getElementById('pnl-shortcut-label');
  if (!label) return;
  try {
    // today range (server local TZ = Asia/Bangkok)
    const now = new Date();
    const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const to = from;
    const data = await API.get(`/api/pnl/day?from=${from}&to=${to}`);
    const pnl = (data.trades || []).reduce((a, t) => a + (t.realizedPnl || 0), 0);
    const sign = pnl >= 0 ? '+' : '';
    const cls = pnl >= 0 ? 'is-bull' : 'is-bear';
    const color = pnl >= 0 ? '#00e5b8' : '#ff4d6d';
    label.innerHTML = `<span class="${cls}" style="color:${color};font-weight:700;">📅 PnL ${sign}$${Math.abs(pnl).toFixed(2)}</span>`;
    label.title = `${data.count} ไม้วันนี้\nกดเพื่อเปิดหน้า PnL Calendar`;
  } catch (err) {
    label.innerHTML = '📅 PnL …';
  }
}

/**
 * FIX-2026-07-23: "Get recommend TP%" button (create modal)
 *   - ใช้ symbol + timeframe ที่ user เลือกอยู่ใน modal
 *   - window = 500 bars
 *   - ใส่ suggestedTpPct ลงใน #nb-tp
 */
/**
 * FIX-2026-08-07: auto-fill bot name จาก symbol เมื่อเปิด New Bot modal
 *   - BTCUSDT → "BTC(bAdd)" · HFTUSDT → "HFT(bAdd)"
 *   - ตรวจ pattern เดิมเพื่อรู้ว่า name เป็น auto-fill หรือ user พิมพ์เอง
 *   - ถ้า name ว่าง หรือ ตรง pattern "<BASE>(bAdd)" → re-derive
 *   - ถ้า user พิมพ์อย่างอื่น → ไม่แตะ
 */
function autoFillNewBotName() {
  const nameEl = document.getElementById('nb-name');
  const symbolEl = document.getElementById('nb-symbol');
  if (!nameEl || !symbolEl) return;
  const symbol = String(symbolEl.value || '').toUpperCase().trim();
  if (!symbol) return;
  // base = strip "USDT" suffix (case-insensitive)
  const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
  const autoName = `${base}(bAdd)`;
  const current = String(nameEl.value || '').trim();
  // auto-fill pattern: empty, or matches "<BASE>(bAdd)" (case-insensitive)
  const isAutoPattern = !current || /^[A-Z0-9]+\(bAdd\)$/i.test(current);
  if (isAutoPattern) {
    nameEl.value = autoName;
  }
}

/**
 * FIX-2026-08-07: auto-trigger ✨ Get TP% on modal open
 *   - หลังจาก nb-symbol + nb-timeframe ถูกตั้ง (จาก deep-link หรือ default)
 *   - เรียก recommendNewBotTp() เพื่อให้ TP% default = NET จาก Min %KC(window) + EMA20 trend
 *   - กัน trigger ซ้ำถ้าเพิ่งกดไปแล้ว (ใช้ flag)
 */
let _newBotTpAutoTriggered = false;
function autoTriggerNewBotTp() {
  if (_newBotTpAutoTriggered) return;
  const symbolEl = document.getElementById('nb-symbol');
  const tfEl = document.getElementById('nb-timeframe');
  if (!symbolEl || !tfEl) return;
  if (!symbolEl.value || !tfEl.value) return;
  _newBotTpAutoTriggered = true;
  // reset flag หลัง 2s (กัน modal ปิด-เปิดใหม่ trigger ซ้ำ)
  setTimeout(() => { _newBotTpAutoTriggered = false; }, 2000);
  recommendNewBotTp();
}

async function recommendNewBotTp() {
  const btn = document.getElementById('nb-tp-recommend');
  const hint = document.getElementById('nb-tp-hint');
  const symbol = document.getElementById('nb-symbol').value;
  const timeframe = document.getElementById('nb-timeframe').value;
  // FIX-2026-08-07: อ่าน TP suggest window จาก input (default 30) ไม่ใช่ hardcoded 500
  const suggestWindow = parseInt(document.getElementById('nb-suggest-tp-window').value, 10) || 30;
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('is-loading');
  btn.innerHTML = '⏳';
  hint.innerHTML = `<span class="text-warning">กำลังคำนวณ Min %KC(${suggestWindow} bars) + EMA20 trend จาก Binance…</span>`;
  try {
    const resp = await API.post('/api/bots/suggest-tp', { symbol, timeframe, window: suggestWindow });
    const tpInput = document.getElementById('nb-tp');
    if (resp.suggestedTpPct == null) {
      hint.innerHTML = `<span class="text-warning">⚠️ trend ยัง warmup (${resp.trendTF || 'n/a'}) — ลองใหม่อีกครั้งในอีกสักครู่</span>`;
    } else {
      // FIX-2026-07-23: server ส่ง TP มาในรูป x.xx1 + หัก fee buffer (round-trip) แล้ว
      //   - suggestedTpPct = NET · rawSuggestedTpPct = GROSS · feeBufferPct = round-trip %
      tpInput.value = resp.suggestedTpPct.toFixed(3);
      const trendGlyph = resp.trendState === 'upper' ? '🟢 ▲' : '🔴 ▼';
      const tfLabel = resp.trendTF || '';
      const grossPct = resp.rawSuggestedTpPct != null ? resp.rawSuggestedTpPct.toFixed(3) : 'n/a';
      const feePct = resp.feeBufferPct != null ? resp.feeBufferPct.toFixed(2) : '0.2';
      hint.innerHTML = `<span class="text-success">✅ ใช้ ${resp.suggestedTpPct.toFixed(3)}% &nbsp;= &nbsp;gross ${grossPct}% − fee ${feePct}% &nbsp;· &nbsp;Min %KC=${resp.kcMinPct.toFixed(3)}% &nbsp;· &nbsp;EMA20(${tfLabel}) ${trendGlyph} ${resp.trendState} (gap ${(resp.trendGapPct >= 0 ? '+' : '') + resp.trendGapPct.toFixed(2)}%)</span>`;
    }
  } catch (err) {
    hint.innerHTML = `<span class="text-danger">❌ คำนวณล้มเหลว: ${err.message || 'unknown'}</span>`;
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    btn.innerHTML = originalLabel;
  }
}

function updateNewBotTotal() {
  const cap = parseFloat(document.getElementById('nb-capital').value) || 0;
  const max = parseInt(document.getElementById('nb-maxtrades').value) || 0;
  document.getElementById('nb-total-val').textContent = `${(cap * max).toFixed(2)} `;
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

async function loadBots(opts = {}) {
  try {
    // FIX-2026-08-02: ?expand=1 → server includes volatility snapshot (1.5s on cold cache)
    //   - default (compact) = skip vol → fast first paint (~200ms)
    //   - expand mode = need vol tiles, so pass expand=1
    const viewMode = getBotViewMode();
    const expand = opts.expand != null ? opts.expand : (viewMode === 'expand' && !opts.skipVol);
    const url = expand ? '/api/bots?expand=1' : '/api/bots';
    const resp = await API.get(url);
    bots = resp.bots;
    seedBotsEmaCache(bots); // FIX-2026-07-23: seed EMA cache for realtime updates
    // FIX-2026-08-01: prefetch coin info for all unique symbols (cache 5min server-side)
    prefetchCoinInfos(bots).catch((e) => console.warn('coinInfo prefetch', e));
    renderBots();
    renderStats();
  } catch (err) {
    console.error('loadBots', err);
  }
}

// FIX-2026-08-01: prefetch coin info per unique symbol + cache in window.coinInfoCache
//   - dedupe by symbol (multiple bots same symbol → 1 fetch)
//   - skip symbols already in cache (TTL 5min server-side → align client cache)
//   - fail-safe: if fetch fails, card shows "—" instead of crashing
const coinInfoCache = new Map(); // symbol -> { data, ts }
async function prefetchCoinInfos(bots) {
  const symbols = [...new Set(bots.map((b) => b.symbol).filter(Boolean))];
  const now = Date.now();
  const toFetch = symbols.filter((s) => !coinInfoCache.has(s) || (now - coinInfoCache.get(s).ts) > 5 * 60 * 1000);
  await Promise.all(toFetch.map(async (sym) => {
    try {
      const r = await API.get(`/api/coins/info/${encodeURIComponent(sym)}`);
      coinInfoCache.set(sym, { data: r.coin, ts: now });
    } catch (err) {
      // cache failure so we don't retry every render
      coinInfoCache.set(sym, { data: null, ts: now, error: err.message });
    }
  }));
}
function getCoinInfo(symbol) {
  const e = coinInfoCache.get(symbol);
  return e ? e.data : null;
}

/**
 * FIX-2026-08-01: renderCoinChip(coin, symbol)
 *   - แสดง chips: status (🟢/🔴), 24h % (สีเขียว/แดง), baseAsset + lot/tick summary
 *   - ใช้บน bot card + scan-volatility rows
 *   - ถ้า coin=null → แสดง "⏳ กำลังโหลด..."
 */
function renderCoinChip(coin, symbol) {
  if (!coin) {
    return `<span class="coin-chip coin-chip-loading" title="กำลังโหลด coin info">⏳ ${escapeHtml(symbol)}</span>`;
  }
  const statusEmoji = coin.status === 'TRADING' ? '🟢' : (coin.status === 'BREAK' ? '🟡' : '🔴');
  const statusTitle = `Binance: ${coin.status} · base=${coin.baseAsset} · quote=${coin.quoteAsset}`;

  // FIX-2026-08-01: full name (จาก BAPI marketing list) — ถ้ามีแสดง tooltip + ข้อความเพิ่ม
  const fullName = coin.fullName || '';
  const logoUrl = coin.logo || '';
  const logoHtml = logoUrl
    ? `<img class="coin-chip-logo" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(fullName)}" loading="lazy" onerror="this.style.display='none'">`
    : '';
  const fullNameHtml = fullName && fullName !== coin.baseAsset
    ? ` <span class="coin-chip-fullname" title="${escapeHtml(fullName)}">${escapeHtml(fullName)}</span>`
    : '';

  // 24h change color
  const pct = coin.priceChangePct;
  let pctHtml = '<span class="muted">—</span>';
  if (pct != null && Number.isFinite(pct)) {
    const cls = pct >= 0 ? 'pct-up' : 'pct-down';
    const sign = pct >= 0 ? '+' : '';
    pctHtml = `<span class="${cls}">${sign}${pct.toFixed(2)}%</span>`;
  }

  // lot/tick summary (truncate)
  const lot = coin.lotSize ? `min ${formatTick(coin.lotSize.minQty)}` : '';
  const tick = coin.priceFilter ? `tick ${formatTick(coin.priceFilter.tickSize)}` : '';

  // FIX-2026-08-01: tooltip รวม fullName + CMC rank + circulating supply
  const cmcLine = (coin.cmcRank != null)
    ? ` · CMC#${coin.cmcRank}`
    : '';
  const supplyLine = (coin.circulatingSupply != null)
    ? ` · circ ${formatSupplyShort(coin.circulatingSupply)}`
    : '';

  return `
    <span class="coin-chip" title="${escapeHtml(statusTitle)} · ${escapeHtml(fullName || coin.baseAsset)}${cmcLine} · lot ${lot} · ${tick} · vol24h ${coin.quoteVolume ? Number(coin.quoteVolume).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '?'} USDT${supplyLine}">
      ${logoHtml}
      ${statusEmoji} <strong>${escapeHtml(coin.baseAsset)}</strong>${fullNameHtml}
      <span class="coin-chip-sep">·</span>
      24h ${pctHtml}
    </span>
  `;
}

// FIX-2026-08-01: format supply ให้อ่านง่าย (1.2M / 850K / 12.5B)
function formatSupplyShort(v) {
  if (v == null || !Number.isFinite(v)) return '';
  const n = Number(v);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return String(n);
}

function formatTick(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return String(v);
  // ตัด trailing zeros
  let s = n.toString();
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
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

// FIX-2026-08-05: BNB low-balance warning banner — แสดงเมื่อ BNB value < $1 USDT
//   - threshold $1 (คงที่) เพื่อให้ banner แสดงเร็วกว่า telegram (default $0.5)
//   - poll ทุก 60s (balance เปลี่ยนช้า, cache backend 30s ลด Binance weight)
//   - fail-open: �่อน banner ถ้า fetch fail (ไม่ให้รบกวน UI)
// FIX-2026-08-05: BNB oil gauge (horizontal fuel-bar — % ของ user target)
//   - target อ่านจาก AppConfig.bnbGaugeTargetUsdt (default 10 USDT)
//   - zone: healthy ≥ 70% / low 30-70% / critical < 30%
//   - ใช้ response เดียวกับ banner (ไม่เพิ่ม fetch — reuse 60s setInterval)
async function loadBnbStatus() {
  const banner = document.getElementById('bnb-low-banner');
  const detail = document.getElementById('bnb-low-detail');
  if (!banner || !detail) return; // element ยังไม่ render (ยังอยู่ page อื่น)
  try {
    const resp = await API.get('/api/account/bnb-status');

    // ── (1) low-balance banner ───────────────────────
    if (resp && resp.isLow) {
      const qty = resp.bnbQty != null ? Number(resp.bnbQty).toFixed(4) : '?';
      const price = resp.bnbUsdtPrice != null ? Number(resp.bnbUsdtPrice).toFixed(2) : '?';
      const value = resp.bnbValueUsdt != null ? Number(resp.bnbValueUsdt).toFixed(4) : '?';
      detail.textContent = `${qty} BNB × ${price} USDT = ${value} USDT (ต่ำกว่า $${resp.threshold})`;
      banner.hidden = false;
      banner.style.display = 'flex'; // override inline display:none
    } else {
      banner.hidden = true;
      banner.style.display = 'none';
    }

    // ── (2) oil gauge (FIX-2026-08-05) ────────────────
    const statusEl = document.getElementById('bnb-gauge-status');
    const valueEl  = document.getElementById('bnb-gauge-value');
    const fillEl   = document.getElementById('bnb-gauge-fill');
    if (statusEl && valueEl && fillEl) {
      const pct = Number(resp.gaugePct) || 0;
      const zone = resp.gaugeZone || 'low';
      const target = Number(resp.gaugeTargetUsdt) || 10;
      const value = Number(resp.bnbValueUsdt) || 0;
      const emoji = zone === 'healthy' ? '🟢' : zone === 'low' ? '�' : '🔴';
      const label = zone === 'healthy' ? 'Healthy' : zone === 'low' ? 'Low' : 'Critical';
      statusEl.textContent = `${emoji} ${label} (${pct.toFixed(0)}%)`;
      statusEl.className = zone === 'healthy' ? 'text-success'
                         : zone === 'critical' ? 'text-danger'
                         : 'text-warning';
      valueEl.textContent = `${value.toFixed(2)} / ${target.toFixed(2)} USDT`;
      fillEl.style.width = `${pct}%`;
      fillEl.className = `bnb-gauge-fill is-${zone}`;
    }
  } catch (err) {
    // fail-open: ซ่อน banner ถ้า fetch fail (ไม่ให้รบกวน UI)
    banner.hidden = true;
    banner.style.display = 'none';
    // gauge → reset to 0 width (fail-open — ไม่โชว์ค่าผิด)
    const fillEl = document.getElementById('bnb-gauge-fill');
    if (fillEl) { fillEl.style.width = '0%'; fillEl.className = 'bnb-gauge-fill'; }
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

/* ════════════════════════════════════════════════════════════════════
 * 2026-07-30: Open Positions (cross-bot) — load + render + force close
 *   - tile count ในแถว KPI (อัปเดตจาก /api/bots/positions)
 *   - modal รายละเอียดแต่ละ position + summary tiles + Force Close
 *   - WS handlers: trade:update → refetch ; kline:update → live mark-to-market
 * ════════════════════════════════════════════════════════════════════ */

async function loadOpenPositions(opts = {}) {
  // FIX-2026-08-03: opts.fresh = true → ?fresh=1 → bypass klineCache, fetch Binance bookTicker directly
  //   - ปุ่ม Refresh ใน modal ใช้ fresh mode (ไม่พึ่ง WS kline cache)
  //   - WS-driven paths (trade:update, fallback poll) ใช้ default (cache) — เร็วและทันที
  const url = opts.fresh ? '/api/bots/positions?fresh=1' : '/api/bots/positions';
  const btn = document.getElementById('opm-refresh');
  let prevLabel = null;
  if (opts.fresh && btn) {
    prevLabel = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.innerHTML = '⏳ กำลังโหลด…';
  }
  try {
    const resp = await API.get(url);
    openPositionsData = resp;
    openPositionsAsOf = resp.asOf;
    // rebuild tradeId → botId map (used by trade:update handler to detect relevant events)
    tradeIdToBotId = new Map((resp.positions || []).map((p) => [p.tradeId, p.botId]));
    // FIX-2026-08-03: modalPriceOverrides ถูกปิดแล้ว (ไม่มี WS price update เข้ามา) — no cleanup needed
    renderStatOpenPositions();
    if (currentModalOp && currentModalOp._isShown) renderOpenPositionsModalBody();
  } catch (err) {
    console.error('loadOpenPositions', err);
  } finally {
    if (opts.fresh && btn) {
      btn.disabled = false;
      btn.classList.remove('is-loading');
      if (prevLabel != null) btn.innerHTML = prevLabel;
    }
  }
}

function renderStatOpenPositions() {
  const count = openPositionsData ? openPositionsData.count : 0;
  const tile = document.getElementById('stat-open-positions');
  if (tile) tile.textContent = String(count);
  const sub = document.getElementById('stat-open-positions-sub');
  if (sub) {
    sub.textContent = count === 0
      ? 'ไม่มี position ที่เปิดอยู่ · คลิกเพื่อดู'
      : `${count} ไม้ · คลิกเพื่อดูรายละเอียด`;
  }
}

/**
 * Get live price for a position:
 *   - FIX-2026-08-03: ลบ WS kline:update override ออก (modalPriceOverrides ไม่ถูก update แล้ว)
 *   - ตอนนี้ใช้ currentPrice จาก server snapshot เท่านั้น
 *     → cache mode (klineCache) ตอน modal open / trade:update event
 *     → fresh mode (Binance bookTicker) ตอน user กดปุ่ม "🔄 Refresh"
 *   - fallback → buyPrice (PnL = 0, ไม่ crash)
 */
function getLivePriceForPosition(p) {
  if (p.currentPrice && p.currentPrice > 0) return p.currentPrice;
  return Number(p.buyPrice) || 0;
}

function renderOpenPositionsModalBody() {
  if (!openPositionsData) return;
  const open = openPositionsData.positions || [];
  const fmt2 = (d) => new Date(d || Date.now()).toLocaleTimeString('th-TH', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  // FIX-2026-08-03: show price source badge in sub line — Binance vs cache
  //   - fresh=true → "Binance bookTicker" badge (authoritative)
  //   - fresh=false → "cache" badge (may be stale)
  //   - freshFailedSymbols → show warning note
  const sub = document.getElementById('opm-sub');
  if (sub) {
    const botIds = new Set(open.map((p) => p.botId));
    const sourceBadge = openPositionsData.fresh
      ? '<span class="lux-badge lux-badge-bull" title="ดึงราคาตรงจาก Binance bookTicker — แม่นยำที่สุด">🟢 Binance</span>'
      : '<span class="lux-badge lux-badge-gray" title="ราคาจาก klineCache in-memory — อาจเก่า ถ้า WS dropped กด Refresh">⚪ cache</span>';
    const failed = openPositionsData.freshFailedSymbols || [];
    const failedNote = failed.length > 0
      ? ` · <span class="text-warning" title="${escapeHtml(failed.join(','))}">⚠️ ${failed.length} sym fallback</span>`
      : '';
    sub.innerHTML = `${open.length} ไม้ · จาก ${botIds.size} บอท · อัปเดต ${fmt2(openPositionsAsOf)} · ${sourceBadge}${failedNote}`;
  }

  // compute aggregates (cost + unrealized) using live price
  let totalCost = 0;
  let totalUpnl = 0;
  for (const p of open) {
    const cost = Number(p.buyQuoteQty) || ((Number(p.buyPrice) || 0) * (Number(p.buyQty) || 0));
    const entry = Number(p.buyPrice) || 0;
    const px = getLivePriceForPosition(p);
    const qty = Number(p.buyQty) || 0;
    totalCost += cost;
    totalUpnl += (px - entry) * qty;
  }

  const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  set('opm-count', String(open.length));
  set('opm-cost', `${totalCost.toFixed(2)} USDT`);
  const upnlSign = totalUpnl >= 0 ? '+' : '';
  set('opm-upnl', `${upnlSign}${totalUpnl.toFixed(4)} USDT`);
  const upnlEl = document.getElementById('opm-upnl');
  if (upnlEl) {
    upnlEl.className = 'v mono ' + (totalUpnl > 0 ? 'pnl-bull' : totalUpnl < 0 ? 'pnl-bear' : '');
  }
  set('opm-cost-thb', window.usdtToThb ? window.usdtToThb(totalCost) : '');
  set('opm-upnl-thb', window.usdtToThb ? window.usdtToThb(totalUpnl) : '');
  set('opm-asof', fmt2(openPositionsAsOf));

  const listEl = document.getElementById('opm-list');
  const mobEl = document.getElementById('opm-mob');
  if (!listEl) return;
  if (open.length === 0) {
    listEl.innerHTML = '<div class="empty-positions">ไม่มี position ที่เปิดอยู่ตอนนี้ — เมื่อ BUY fill หรือวาง SELL แล้วจะปรากฏที่นี่ทันที พร้อม % PnL และอายุแบบ realtime</div>';
    if (mobEl) mobEl.innerHTML = '';
    return;
  }
  // ใช้ shared partial — แสดง bot name + link + retry pill (ต่างจาก bot-detail ที่ซ่อน retry)
  const opts = { botLink: true, showRetry: true, forceCloseBtnClass: 'btn-force-close-opm' };
  listEl.innerHTML = open
    .map((p) => window.PositionCard.renderCard({ ...p, _id: p.tradeId }, getLivePriceForPosition(p), { ...opts, botName: p.botName || p.symbol }))
    .join('');
  if (mobEl) {
    mobEl.innerHTML = open
      .map((p) => window.PositionCard.renderCardMobile({ ...p, _id: p.tradeId }, getLivePriceForPosition(p), { ...opts, botName: p.botName || p.symbol }))
      .join('');
  }
}

/**
 * Click handler for #opm-list / #opm-mob — handle "🛑 Force Close" per card
 *   - ใช้ LUX_CONFIRM.luxConfirm + callBotWithPassword (ตามที่ bot-detail ใช้)
 *   - ต่างจาก btn-force-close ปกติ: ใช้ class `.btn-force-close-opm` เพื่อแยก event scope
 */
async function onOpenPositionsClick(ev) {
  const btn = ev.target.closest('.btn-force-close-opm');
  if (!btn) return;
  ev.preventDefault();
  ev.stopPropagation();
  const tradeId = btn.dataset.tradeId;
  const botId = btn.dataset.botId;
  if (!tradeId || !botId) return;
  const pos = openPositionsData && openPositionsData.positions.find((p) => p.tradeId === tradeId);
  if (!pos) return;

  // confirm prompt
  const pw = await window.LUX_CONFIRM.luxConfirm({
    variant: 'danger',
    icon: '🛑',
    title: 'ยืนยันบังคับปิด position',
    sub: 'จะยกเลิก SELL (ถ้ามี) แล้ว MARKET SELL freeQty (หรือ synthetic close ถ้า asset หายไปแล้ว)',
    message: `ไม้ ${tradeId.slice(-8)} (${pos.symbol}, ${pos.timeframe}, state=${pos.state}) — ปิดเลยหรือไม่?`,
    target: { name: pos.botName || pos.symbol, symbol: pos.symbol, timeframe: pos.timeframe },
    requirePassword: true,
    dangerNote: 'บอทยังคงทำงานต่อ — เฉพาะไม้นี้ที่ถูกปิด',
    confirmLabel: 'บังคับปิดไม้นี้',
    confirmGlyph: '🛑',
  });
  if (pw === null) return; // cancelled
  try {
    await window.LUX_CONFIRM.callBotWithPassword(
      'POST',
      `/api/bots/${botId}/trades/${tradeId}/force-close`,
      { password: pw || undefined },
      `force-close ${pos.symbol}`
    );
    // refetch ทันที — card จะหายไปเมื่อ backend เปลี่ยน state เป็น sold
    await loadOpenPositions();
  } catch (err) {
    await window.LUX_CONFIRM.luxAlert({
      variant: 'danger',
      icon: '⚠️',
      title: 'บังคับปิดไม่สำเร็จ',
      message: err.message || String(err),
    });
  }
}

function renderBots() {
  const container = document.getElementById('bots-list');
  // counter update เสมอ (รวมกรณี bots.length === 0)
  updateFilterCounter();
  if (bots.length === 0) {
    container.innerHTML = '<div class="alert alert-secondary">ยังไม่มีบอท — คลิก <strong>+ New Bot</strong> เพื่อเริ่มต้น</div>';
    teardownMiniCharts();
    return;
  }
  // FIX-2026-08-05: filter applied — อาจมี 0 บอทที่ตรงเงื่อนไข
  const visible = getFilteredBots();
  if (visible.length === 0) {
    // ไม่มีบอทตรงกับ search/filter — แสดง empty state (replace DOM + teardown charts)
    container.innerHTML = renderNoResultsEmpty();
    teardownMiniCharts();
    return;
  }
  // ── FIX-2026-08-05: แยก "master set changed" vs "filter changed" ────────────
  //   - master set changed (new bot added / removed / reordered) → full rebuild + chart re-init
  //   - filter changed only → toggle CSS .is-hidden-by-filter บนการ์ด (no DOM thrash, no chart re-init)
  //   - WS kline:update → updateCardEma() mutates tile in-place (works on hidden cards too)
  //   - WS trade:update → updates active count + PnL via in-place mutation
  const existingIds = new Set();
  const existingCards = container.querySelectorAll('[data-bot-id]');
  existingCards.forEach((el) => existingIds.add(el.dataset.botId));
  const masterIds = new Set(bots.map((b) => String(b._id)));
  const masterSetChanged = existingIds.size !== masterIds.size
    || [...existingIds].some((id) => !masterIds.has(id))
    || [...masterIds].some((id) => !existingIds.has(id));
  // FIX-2026-08-05: view mode change (compact↔expand) ต้อง rebuild การ์ดด้วย
  //   - เดิมเช็คแค่ masterSetChanged ทำให้ class .is-compact/.is-expand บนการ์ดไม่เปลี่ยน
  //   - ส่งผลให้ CSS rule .bot-card-v2.is-compact .bc-minichart-wrap { display:none } ยังคงซ่อนกราฟ+tiles
  //   - ตอนผู้ใช้กด Expand จึงไม่เห็นอะไรเปลี่ยนแปลง
  const viewMode = getBotViewMode();
  const viewModeChanged = _lastRenderedViewMode !== null && _lastRenderedViewMode !== viewMode;
  if (masterSetChanged || viewModeChanged) {
    teardownMiniCharts();
    container.innerHTML = bots.map(renderBotCard).join('');
    if (viewMode === 'expand') {
      setupMiniCharts();
    }
    _lastRenderedViewMode = viewMode;
  }
  // Apply filter visibility (CSS hide) — runs in BOTH rebuild + same-set cases
  //   - ไม่ต้อง teardown charts เมื่อ filter เปลี่ยน (cards ที่ hidden ยังเก็บ state ไว้)
  //   - เมื่อ user ล้าง filter → การ์ดที่ซ่อนอยู่จะกลับมาแสดงทันที (มี state + chart พร้อม)
  const visibleIds = new Set(visible.map((b) => String(b._id)));
  for (const card of container.querySelectorAll('.bot-card-v2')) {
    const id = card.dataset.botId;
    const isHidden = !visibleIds.has(id);
    card.classList.toggle('is-hidden-by-filter', isHidden);
  }
  // Surgical in-place mutation of frequently-changing fields (active count, today PnL, status)
  for (const b of visible) {
    updateBotCardInPlace(b);
  }
}

// FIX-2026-08-04: surgical in-place update for fields that change frequently
//   - Active positions count + tile class
//   - Today PnL ($ + count + class)
//   - Total PnL (when changed)
//   - Status pill (state change)
//   - LastError / Warning text + visibility
//   - run-badge (enabled toggle reflected elsewhere via reload, but defensive)
function updateBotCardInPlace(b) {
  const el = document.querySelector(`#bots-list [data-bot-id="${b._id}"]`);
  if (!el) return;

  // Active positions count
  const activeCount = b.activePositionsCount || 0;
  const activeTile = el.querySelector('.bc-tile-active');
  if (activeTile) {
    if (activeCount > 0) {
      activeTile.classList.add('has-active');
    } else {
      activeTile.classList.remove('has-active');
    }
    const activeVal = activeTile.querySelector('[data-active-count]');
    if (activeVal) {
      const newText = `${activeCount} ไม้`;
      if (activeVal.textContent !== newText) {
        activeVal.textContent = newText;
      }
    }
  }

  // Today PnL
  const todayPnl = b.todayPnl || 0;
  const todayTrades = b.todayTrades || 0;
  const pnlTile = el.querySelector('.bc-tile-pnl');
  if (pnlTile) {
    const pnlText = `${todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(4)}`;
    const valueEl = pnlTile.querySelector('.tile-value');
    const subEl = pnlTile.querySelector('.tile-sub');
    if (valueEl && valueEl.textContent !== pnlText) {
      valueEl.textContent = pnlText;
    }
    if (subEl) {
      const subText = `${todayTrades} ไม้ · USDT`;
      if (subEl.textContent !== subText) {
        subEl.textContent = subText;
      }
    }
    const wantClass = todayPnl > 0 ? 'pnl-bull' : todayPnl < 0 ? 'pnl-bear' : '';
    if (valueEl && valueEl.className.indexOf(wantClass) === -1) {
      valueEl.classList.remove('pnl-bull', 'pnl-bear');
      if (wantClass) valueEl.classList.add(wantClass);
    }
  }

  // Status pill (state change)
  const statusBadge = el.querySelector('.bc-meta .status-pill');
  if (statusBadge) {
    const wantHtml = statusPillHtml(b.status);
    const wrap = document.createElement('div');
    wrap.innerHTML = wantHtml;
    const newHtml = wrap.innerHTML;
    if (statusBadge.outerHTML !== newHtml) {
      statusBadge.outerHTML = newHtml;
    }
  }

  // LastError: hide row if cleared, show if set
  let errEl = el.querySelector('.bc-err');
  if (b.lastError) {
    if (!errEl) {
      const statsEl = el.querySelector('.bc-stats');
      if (statsEl) {
        const div = document.createElement('div');
        div.className = 'bc-err';
        div.innerHTML = `<span class="bc-err-msg">⚠️ ${escapeHtml(b.lastError)}</span><button class="bc-err-dismiss" type="button" title="ปิดการแจ้งเตือนนี้" aria-label="dismiss" onclick="dismissBotError('${b._id}', this)">×</button>`;
        statsEl.insertAdjacentHTML('afterend', div.outerHTML);
      }
    } else {
      const msg = errEl.querySelector('.bc-err-msg');
      if (msg && msg.textContent !== `⚠️ ${b.lastError}`) {
        msg.textContent = `⚠️ ${b.lastError}`;
      }
    }
  } else if (errEl) {
    errEl.remove();
  }

  // Warning: same pattern
  let warnEl = el.querySelector('.bc-warn');
  if (b.warning) {
    if (!warnEl) {
      const errElAfter = el.querySelector('.bc-err') || el.querySelector('.bc-stats');
      if (errElAfter) {
        const div = document.createElement('div');
        div.className = 'bc-warn';
        div.innerHTML = `<span class="bc-warn-msg">⏰ ${escapeHtml(b.warning)}</span><button class="bc-warn-dismiss" type="button" title="ปิดการแจ้งเตือนนี้" aria-label="dismiss" onclick="dismissBotWarning('${b._id}', this)">×</button>`;
        errElAfter.insertAdjacentHTML('afterend', div.outerHTML);
      }
    } else {
      const msg = warnEl.querySelector('.bc-warn-msg');
      if (msg && msg.textContent !== `⏰ ${b.warning}`) {
        msg.textContent = `⏰ ${b.warning}`;
      }
    }
  } else if (warnEl) {
    warnEl.remove();
  }

  // FIX-2026-08-07: CBv2 cooldown banner live update (HYBRID mode — บอทยัง enable)
  const cbv2LockedUntil = b.cbv2LockedUntil && new Date(b.cbv2LockedUntil).getTime() > Date.now();
  const lockEl = el.querySelector('.bc-cbv2-cooldown');
  if (cbv2LockedUntil) {
    const lockMsg = `⏸ CBv2 cooldown until ${new Date(b.cbv2LockedUntil).toLocaleString()} (${b.cbv2LockReason || 'cbv2_panic'}) — 🔓 ปลด cooldown`;
    if (!lockEl) {
      const ref = el.querySelector('.bc-warn') || el.querySelector('.bc-err') || el.querySelector('.bc-stats');
      if (ref) {
        const div = document.createElement('div');
        div.className = 'bc-cbv2-cooldown';
        div.innerHTML = `<span class="bc-cbv2-cooldown-msg">${lockMsg}</span>`;
        ref.insertAdjacentHTML('afterend', div.outerHTML);
      }
    } else {
      const msg = lockEl.querySelector('.bc-cbv2-cooldown-msg');
      if (msg && msg.textContent !== lockMsg) msg.textContent = lockMsg;
    }
    if (!el.classList.contains('has-cbv2-cooldown')) el.classList.add('has-cbv2-cooldown');
  } else if (lockEl) {
    lockEl.remove();
    el.classList.remove('has-cbv2-cooldown');
  }

  // FIX-2026-08-08: Feature #2 — CBv3 cooldown banner live update (mirror CBv2)
  const cbv3LockedUntil = b.cbv3LockedUntil && new Date(b.cbv3LockedUntil).getTime() > Date.now();
  const cbv3LockEl = el.querySelector('.bc-cbv3-cooldown');
  if (cbv3LockedUntil) {
    const cbv3LockMsg = `⏸ CBv3 cooldown until ${new Date(b.cbv3LockedUntil).toLocaleString()} (${b.cbv3LockReason || 'cbv3_panic'}) — 🔓 ปลด cooldown`;
    if (!cbv3LockEl) {
      const ref = el.querySelector('.bc-cbv2-cooldown') || el.querySelector('.bc-warn') || el.querySelector('.bc-err') || el.querySelector('.bc-stats');
      if (ref) {
        const div = document.createElement('div');
        div.className = 'bc-cbv3-cooldown';
        div.innerHTML = `<span class="bc-cbv3-cooldown-msg">${cbv3LockMsg}</span>`;
        ref.insertAdjacentHTML('afterend', div.outerHTML);
      }
    } else {
      const msg = cbv3LockEl.querySelector('.bc-cbv3-cooldown-msg');
      if (msg && msg.textContent !== cbv3LockMsg) msg.textContent = cbv3LockMsg;
    }
    if (!el.classList.contains('has-cbv3-cooldown')) el.classList.add('has-cbv3-cooldown');
  } else if (cbv3LockEl) {
    cbv3LockEl.remove();
    el.classList.remove('has-cbv3-cooldown');
  }

  // Run/Stop badge (defensive — usually handled by page reload on toggle)
  const runBadge = el.querySelector('.run-badge');
  if (runBadge) {
    const wantText = b.enabled ? '▶ RUNNING' : '⏸ STOPPED';
    const wantClass = b.enabled ? 'on' : 'off';
    if (runBadge.textContent !== wantText) runBadge.textContent = wantText;
    if (runBadge.classList.contains('on') !== b.enabled) {
      runBadge.classList.toggle('on', b.enabled);
      runBadge.classList.toggle('off', !b.enabled);
    }
  }
}

/**
 * FIX-2026-07-23: Bot card v2 — clearer layout, EMA20 indicator, active-position highlight
 *   - Header: name + symbol + TF + status pill + run/stop badge (เด่น)
 *   - 3 main tiles: Price vs EMA20 (with arrow) | Active positions | Today PnL
 *   - Stats row: TP, capital, total PnL, uptime
 *   - Action bar: Detail / Edit / Start-Stop / Delete
 *   - Class flags:
 *       .is-running — green tint, บอทที่กำลังรัน
 *       .is-disabled — dimmed, บอทที่หยุดอยู่
 *       .has-position — orange/gold accent, บอทที่กำลังถือ position อยู่
 *       .has-error — red accent, บอทที่มี lastError
 *       .has-warning — amber accent, บอทที่มี warning (e.g. SELL partial-fill latched 1h)
 *       .ema-above / .ema-below — tile color (green/red) สำหรับ price vs EMA
 */
function renderBotCard(b) {
  const statusBadge = statusPillHtml(b.status);
  const isRunning = !!b.enabled;
  const hasPosition = (b.activePositionsCount || 0) > 0;
  const hasError = !!b.lastError;
  const hasWarning = !!b.warning;
  // FIX-2026-08-06: CBv2 lock badge — แสดงเมื่อ cbv2LockedUntil > now
  const hasCbv2Lock = b.cbv2LockedUntil && new Date(b.cbv2LockedUntil).getTime() > Date.now();
  // FIX-2026-08-08: Feature #2 — CBv3 lock badge (mirror CBv2)
  const hasCbv3Lock = b.cbv3LockedUntil && new Date(b.cbv3LockedUntil).getTime() > Date.now();

  // class flags for highlight
  const classes = ['bot-card-v2'];
  if (isRunning) classes.push('is-running'); else classes.push('is-disabled');
  if (hasPosition) classes.push('has-position');
  if (hasError) classes.push('has-error');
  if (hasWarning) classes.push('has-warning');
  if (hasCbv2Lock) classes.push('has-cbv2-cooldown');
  if (hasCbv3Lock) classes.push('has-cbv3-cooldown');
  // FIX-2026-07-31: view mode (compact | expand) — drives CSS visibility of chart + tiles
  const viewMode = getBotViewMode();
  classes.push(viewMode === 'compact' ? 'is-compact' : 'is-expand');

  // ── Stats
  const todayPnl = b.todayPnl || 0;
  const todayTrades = b.todayTrades || 0;
  const todayClass = todayPnl > 0 ? 'pnl-bull' : todayPnl < 0 ? 'pnl-bear' : '';
  const todayThb = window.usdtToThb ? window.usdtToThb(todayPnl) : '';

  const totalPnl = b.totalPnl || 0;
  const totalPnlClass = totalPnl > 0 ? 'pnl-bull' : totalPnl < 0 ? 'pnl-bear' : '';
  const totalPnlThb = window.usdtToThb ? window.usdtToThb(totalPnl) : '';

  const uptime = isRunning ? formatUptime((Date.now() - new Date(b.enabledAt).getTime()) / 1000) : '-';
  const active = formatActiveDuration(b.activeDurationMs || 0);

  // ── EMA / Price tile
  const lastClose = b.lastClose;
  const ema20 = b.ema20;
  const emaGap = b.emaGapPct;
  const emaState = b.emaState || 'warmup'; // 'above' | 'below' | 'warmup'
  // FIX-2026-07-31: use Binance tickSize precision (authoritative) — fallback heuristic
  const priceDigits = window.PriceFormat ? window.PriceFormat.digits(b.symbol, lastClose) : window.PriceFormat.heuristicDigits(lastClose);
  let emaTileContent;
  if (emaState === 'warmup' || lastClose == null) {
    emaTileContent = `
      <div class="tile-label">Price · EMA20</div>
      <div class="tile-value">… <span class="muted">กำลัง warm-up</span></div>
      <div class="tile-sub muted">รอข้อมูลจาก ${b.timeframe}</div>
    `;
  } else {
    const arrow = emaState === 'above' ? '▲' : '▼';
    const gapCls = emaState === 'above' ? 'pnl-bull' : 'pnl-bear';
    const gapSign = emaGap >= 0 ? '+' : '';
    emaTileContent = `
      <div class="tile-label">Price · EMA20</div>
      <div class="tile-value" data-ema-price>${lastClose.toFixed(priceDigits)}</div>
      <div class="tile-sub ${gapCls}" data-ema-sub>
        ${arrow} EMA ${ema20.toFixed(priceDigits)} · <strong>${gapSign}${emaGap.toFixed(2)}%</strong>
      </div>
    `;
  }

  // ── Active positions tile
  const activeCount = b.activePositionsCount || 0;
  const maxTrades = b.maxTrades || 0;
  let activeTileContent;
  if (!isRunning) {
    activeTileContent = `
      <div class="tile-label">Active</div>
      <div class="tile-value muted">—</div>
      <div class="tile-sub muted">หยุดอยู่</div>
    `;
  } else if (activeCount === 0) {
    activeTileContent = `
      <div class="tile-label">Active</div>
      <div class="tile-value">0 ไม้</div>
      <div class="tile-sub muted">รอ signal</div>
    `;
  } else {
    const pct = maxTrades > 0 ? Math.round((activeCount / maxTrades) * 100) : 0;
    activeTileContent = `
      <div class="tile-label">Active</div>
      <div class="tile-value pos-active" data-active-count>${activeCount} ไม้</div>
      <div class="tile-sub">จาก ${maxTrades} max (${pct}%)</div>
    `;
  }

  // ── Today PnL tile
  let todayTileContent;
  if (!isRunning && todayTrades === 0) {
    todayTileContent = `
      <div class="tile-label">Today</div>
      <div class="tile-value muted">—</div>
      <div class="tile-sub muted">ยังไม่เทรดวันนี้</div>
    `;
  } else {
    todayTileContent = `
      <div class="tile-label">Today</div>
      <div class="tile-value ${todayClass}">${todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(4)}</div>
      <div class="tile-sub ${todayClass}">${todayTrades} ไม้ · USDT${todayThb ? ` · <span class="thb-eq">${todayThb}</span>` : ''}</div>
    `;
  }

  // ── 2026-07-31: Volatility row (Min-%KC + %TP suggested + 24h volume)
  //   - server enrich ส่ง volKcMinPct / volSuggestedTpPct / volQuoteVolume24h + display strings
  //   - highlight: Min-%KC < 1.2% → is-low (warn), 24h vol < 1,000,000 USDT → is-low (warn)
  //   - tile แสดงเฉพาะ expand mode (CSS ซ่อนเมื่อ .is-compact)
  const KC_MIN_LOW_THRESHOLD_PCT = 1.2;   // %
  const VOL24H_LOW_THRESHOLD_USDT = 1e6;  // 1,000,000 USDT
  const kcMinPctNum = b.volKcMinPct != null ? Number(b.volKcMinPct) : null; // already percent (e.g. 1.23 = 1.23%)
  const kcMinLow = kcMinPctNum != null && kcMinPctNum < KC_MIN_LOW_THRESHOLD_PCT;
  const vol24hLow = b.volQuoteVolume24h != null && Number(b.volQuoteVolume24h) < VOL24H_LOW_THRESHOLD_USDT;
  const trendArrow = b.volTrendState === 'upper' ? '↑' : b.volTrendState === 'lower' ? '↓' : '•';
  const trendWord  = b.volTrendState === 'upper' ? 'up' : b.volTrendState === 'lower' ? 'lo' : '—';
  // FIX-2026-08-02: TP floor override badge — threshold bumped 0.1% → 0.281%, override 0.111% → 0.281%
  const tpOverrideBadge = b.volTpOverridden ? ' <span class="lux-badge lux-badge-warn" title="NET TP ต่ำกว่า 0.281% — auto-floor ใช้ 0.281% แทน">⚙️ floor</span>' : '';

  // Min-%KC tile
  let kcMinTileContent;
  if (!b.volOk || kcMinPctNum == null) {
    kcMinTileContent = `
      <div class="tile-label">Min-%KC (${b.suggestTpWindow || 500})</div>
      <div class="tile-value muted">—</div>
      <div class="tile-sub muted" title="${escapeHtml(b.volError || 'warming up')}">${b.volError ? 'API error' : 'warming up'}</div>
    `;
  } else {
    kcMinTileContent = `
      <div class="tile-label">Min-%KC (${b.suggestTpWindow || 500} bars)</div>
      <div class="tile-value">${kcMinPctNum.toFixed(2)}%</div>
      <div class="tile-sub muted">lower window · ${trendArrow} ${trendWord}</div>
    `;
  }

  // %TP suggested tile (NET, x.xx1) — trend-aware
  let tpSuggTileContent;
  if (!b.volOk || b.volSuggestedTpPct == null) {
    tpSuggTileContent = `
      <div class="tile-label">TP แนะนำ %</div>
      <div class="tile-value muted">—</div>
      <div class="tile-sub muted">${b.volError ? 'API error' : 'trend warm-up'}</div>
    `;
  } else {
    const trendCls = b.volTrendState === 'upper' ? 'pnl-bull' : b.volTrendState === 'lower' ? 'pnl-bear' : '';
    const trendLabel = b.volTrendState === 'upper' ? 'upper TF' : b.volTrendState === 'lower' ? 'lower TF' : 'warmup';
    const tfLabel = b.volTrendTF ? ` · ${b.volTrendTF}` : '';
    tpSuggTileContent = `
      <div class="tile-label">TP แนะนำ % (NET)</div>
      <div class="tile-value">${b.volSuggestedTpPct.toFixed(3)}%${tpOverrideBadge}</div>
      <div class="tile-sub ${trendCls}">${trendArrow} ${trendLabel}${tfLabel}</div>
    `;
  }

  // 24h volume tile
  let vol24hTileContent;
  if (b.volQuoteVolume24h == null || !b.volQuoteVolume24hDisplay) {
    vol24hTileContent = `
      <div class="tile-label">24h Volume</div>
      <div class="tile-value muted">—</div>
      <div class="tile-sub muted">${b.volError ? 'API error' : '—'}</div>
    `;
  } else {
    const usdtLabel = ` (${b.volQuoteVolume24h.toLocaleString('en-US', { maximumFractionDigits: 0 })} USDT)`;
    vol24hTileContent = `
      <div class="tile-label">24h Volume (USDT)</div>
      <div class="tile-value">${b.volQuoteVolume24hDisplay} USDT</div>
      <div class="tile-sub muted">quoteVol${usdtLabel}</div>
    `;
  }

  // FIX-2026-08-01: coin-info chips (status + 24h % + lot/tick) — ใช้ getCoinInfo()
  //   - ดึงจาก window.coinInfoCache ที่ prefetch ใน loadBots()
  //   - ถ้ายังโหลดไม่เสร็จ → fallback '—'
  const ci = (typeof getCoinInfo === 'function') ? getCoinInfo(b.symbol) : null;
  const coinChip = renderCoinChip(ci, b.symbol);

  // FIX-2026-08-01: Bot Quality Indicator pill (between statusBadge + coinChip)
  const qualityBadge = buildQualityBadge(b);

  // FIX-2026-08-02: DCA mode badge — แสดงเมื่อเปิด DCA stack mode
  const dcaBadge = b.dcaEnabled
    ? `<span class="dca-pill" title="DCA + BEP Stack Mode — max ${b.dcaMaxLayers || 3} layers">📚 DCA${b.dcaMaxLayers ? `/${b.dcaMaxLayers}` : ''}</span>`
    : '';

  // FIX-2026-08-03: Safe-trade filter #2 (trendline) live badge — แสดงเมื่อ filter เปิด
  const trendlineBadge = buildTrendlineBadge(b);

  // FIX-2026-08-06: Binance delist badge — แสดงเมื่อ symbol �ีความเสี่ยงจะถูก delist
  const delistBadge = buildDelistBadge(b);

  return `
    <div class="${classes.join(' ')}" data-bot-id="${b._id}" data-symbol="${b.symbol}" data-timeframe="${b.timeframe}">
      <div class="bc-head">
        <div class="bc-head-left">
          <div class="bc-title">${escapeHtml(b.name || b.symbol)}</div>
          <div class="bc-meta">
            <span class="sym-tag">${b.symbol}</span>
            <span class="tf-tag">${b.timeframe}</span>
            ${statusBadge}
            ${qualityBadge}
            ${dcaBadge}
            ${trendlineBadge}
            ${delistBadge}
            ${coinChip}
          </div>
        </div>
        <div class="bc-head-right">
          <span class="run-badge ${isRunning ? 'on' : 'off'}">${isRunning ? '▶ RUNNING' : '⏸ STOPPED'}</span>
        </div>
      </div>
      ${isRunning
        ? `<div class="bc-minichart-wrap" data-mini-wrap>
             <div class="bc-minichart" data-mini-chart data-bot-id="${b._id}" data-symbol="${b.symbol}" data-timeframe="${b.timeframe}">
               <div class="bc-minichart-loading">⏳ โหลด…</div>
             </div>
             <div class="bc-minichart-legend">
               <span class="lg-dot lg-up"></span>Upper KC
               <span class="lg-dot lg-ema"></span>EMA20
               <span class="lg-dot lg-lo"></span>Lower KC
               <span class="lg-mk lg-buy">▲B</span>
               <span class="lg-mk lg-sell">▼S</span>
               <span class="lg-mk lg-sig">S1</span>
             </div>
           </div>`
        : ''}
      <div class="bc-tiles">
        <div class="bc-tile bc-tile-ema ema-${emaState}">
          ${emaTileContent}
        </div>
        <div class="bc-tile bc-tile-active ${activeCount > 0 ? 'has-active' : ''}">
          ${activeTileContent}
        </div>
        <div class="bc-tile bc-tile-pnl">
          ${todayTileContent}
        </div>
        <div class="bc-tile bc-tile-kcmin ${kcMinLow ? 'is-low' : ''}" title="${kcMinLow ? 'Min-%KC < 1.2% — volatility ต่ำ TP แนะนำจะน้อย' : 'Min %KC ตลอด suggestTpWindow'}">
          ${kcMinTileContent}
        </div>
        <div class="bc-tile bc-tile-tpsugg ${b.volTpOverridden ? 'is-floor' : ''}" title="%TP NET ที่คำนวณจาก minKC + trend (NET = หัก fee แล้ว)">
          ${tpSuggTileContent}
        </div>
        <div class="bc-tile bc-tile-vol24h ${vol24hLow ? 'is-low' : ''}" title="${vol24hLow ? '24h volume < 1,000,000 USDT — liquidity ต่ำ' : '24h quote volume (USDT)'}">
          ${vol24hTileContent}
        </div>
      </div>
      <div class="bc-stats">
        <span class="stat"><span class="lbl">TP</span><strong>${b.tpPercent}%${b.tpOnFloor ? ' <span class="lux-badge lux-badge-warn" title="NET TP ต่ำกว่า 0.281% — auto-floor ใช้ 0.281% แทน">⚙️ floor</span>' : ''}</strong></span>
        <span class="stat"><span class="lbl">ทุน</span><strong>$${b.capitalPerTrade} × ${b.maxTrades} = $${b.totalCapital.toFixed(2)}</strong></span>
        <span class="stat"><span class="lbl">Retry</span><strong>${formatRetryTime(b.retryTimeMin)} × ${b.retryMax ?? 1}</strong></span>
        <span class="stat"><span class="lbl">⏱ Uptime</span><strong>${uptime}</strong></span>
        <span class="stat"><span class="lbl">🕒 Active</span><strong>${active}</strong></span>
        <span class="stat"><span class="lbl">PnL สะสม</span><strong class="${totalPnlClass}">${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} USDT${totalPnlThb ? ` <span class="thb-eq">${totalPnlThb}</span>` : ''}</strong></span>
        <span class="stat"><span class="lbl">Trades</span><strong>${b.totalTrades || 0} (W ${b.winTrades || 0})</strong></span>
      </div>
      ${b.lastError ? `<div class="bc-err"><span class="bc-err-msg">⚠️ ${escapeHtml(b.lastError)}</span><button class="bc-err-dismiss" type="button" title="ปิดการแจ้งเตือนนี้" aria-label="dismiss" onclick="dismissBotError('${b._id}', this)">×</button></div>` : ''}
      ${b.warning ? `<div class="bc-warn"><span class="bc-warn-msg">⏰ ${escapeHtml(b.warning)}</span><button class="bc-warn-dismiss" type="button" title="ปิดการแจ้งเตือนนี้" aria-label="dismiss" onclick="dismissBotWarning('${b._id}', this)">×</button></div>` : ''}
      ${hasCbv2Lock ? `<div class="bc-cbv2-cooldown"><span class="bc-cbv2-cooldown-msg">⏸ CBv2 cooldown until ${new Date(b.cbv2LockedUntil).toLocaleString()} <span class="text-muted">(${escapeHtml(b.cbv2LockReason || 'cbv2_panic')})</span> — <a href="/bot-edit.html?id=${b._id}">🔓 ปลด cooldown</a></span></div>` : ''}
      ${hasCbv3Lock ? `<div class="bc-cbv3-cooldown"><span class="bc-cbv3-cooldown-msg">⏸ CBv3 cooldown until ${new Date(b.cbv3LockedUntil).toLocaleString()} <span class="text-muted">(${escapeHtml(b.cbv3LockReason || 'cbv3_panic')})</span> — <a href="/bot-edit.html?id=${b._id}">🔓 ปลด cooldown</a></span></div>` : ''}
      ${b.dynamicSizeEnabled === true ? `<div class="bc-dps-indicator" title="DPS — size ${b.dynamicSizeEffective || b.dynamicSizeCurrent || '?'} / layers ${b.dynamicLayersEffective || b.dynamicLayersCurrent || '?'}${b.dynamicSizeInCooldown ? ' (cooldown)' : ''}"><span class="bc-dps-label">📊 DPS</span><span class="bc-dps-value">$${b.dynamicSizeEffective || b.dynamicSizeCurrent || '?'} × ${b.dynamicLayersEffective || b.dynamicLayersCurrent || '?'} layers${b.dynamicSizeInCooldown ? ' ⏸' : ''}</span></div>` : ''}
      <div class="bc-actions">
        <a href="/bot-detail.html?id=${b._id}" class="btn-lux btn-info btn-sm">📊 Detail</a>
        <a href="/bot-edit.html?id=${b._id}" class="btn-lux btn-gold btn-sm">⚙️ Edit</a>
        ${isRunning
          ? `<button class="btn-lux btn-warn btn-sm" onclick="toggleBot('${b._id}', false)">⏸ หยุด</button>`
          : `<button class="btn-lux btn-bull btn-sm" onclick="toggleBot('${b._id}', true)">▶ เริ่ม</button>`}
        <button class="btn-lux btn-bear btn-sm" onclick="deleteBot('${b._id}')">🗑</button>
      </div>
    </div>
  `;
}

/**
 * FIX-2026-07-23: in-place EMA tile update จาก WS kline:update
 *   - ใช้ closes ที่เก็บใน window.botsEmaCache (Map<botId, { closes: number[] }>)
 *   - seed จาก server response ครั้งแรก
 *   - append close ใหม่ → คำนวณ EMA20 ใหม่ → update DOM
 *   - ไม่ re-render card ทั้งใบ (กัน flicker)
 */
const botsEmaCache = new Map(); // botId -> { closes: number[] }

function seedBotsEmaCache(botList) {
  // FIX-2026-07-23: seed จาก emaCloses (last 20 closes) ที่ server ส่งมา
  //   - ถ้า server ส่งมาครบ 20 closes → client EMA ตรงกับ server ตั้งแต่ render แรก
  //   - ถ้าไม่มี (warmup) → fallback ใช้ lastClose 20 ตัว (จะ refine เมื่อ WS kline มาใหม่)
  for (const b of botList) {
    if (botsEmaCache.has(b._id)) continue; // already seeded — preserve WS-accumulated closes
    if (Array.isArray(b.emaCloses) && b.emaCloses.length >= 20) {
      botsEmaCache.set(b._id, { closes: b.emaCloses.slice(-20) });
    } else if (b.lastClose != null) {
      botsEmaCache.set(b._id, { closes: new Array(20).fill(b.lastClose) });
    }
  }
}

function updateCardEma(cardEl, newClose) {
  const botId = cardEl.dataset.botId;
  const symbol = cardEl.dataset.symbol;
  const interval = cardEl.dataset.timeframe;
  if (!botId || !symbol || !interval) return;

  // update cache
  let cache = botsEmaCache.get(botId);
  if (!cache) {
    cache = { closes: new Array(20).fill(newClose) };
    botsEmaCache.set(botId, cache);
  } else {
    cache.closes.push(newClose);
    if (cache.closes.length > 100) cache.closes = cache.closes.slice(-100); // keep manageable
  }

  // ถ้ามี < 20 closes → ยัง warmup
  if (cache.closes.length < 20) return;

  // คำนวณ EMA20
  const closes = cache.closes.slice(-20);
  const k = 2 / (20 + 1);
  let ema = closes.slice(0, 20).reduce((a, b) => a + b, 0) / 20; // SMA seed
  for (let i = 1; i < closes.length; i += 1) {
    ema = closes[i] * k + ema * (1 - k);
  }

  const emaState = newClose >= ema ? 'above' : 'below';
  const gapPct = ((newClose - ema) / ema) * 100;
  const gapSign = gapPct >= 0 ? '+' : '';
  // FIX-2026-07-31: ใช้ PriceFormat (Binance tickSize) — ส่ง symbol มาด้วย
  const priceDigits = window.PriceFormat ? window.PriceFormat.digits(symbol, newClose) : window.PriceFormat.heuristicDigits(newClose);

  // update DOM (lightweight — no re-render)
  const tileEl = cardEl.querySelector('.bc-tile-ema');
  const priceEl = cardEl.querySelector('[data-ema-price]');
  const subEl = cardEl.querySelector('[data-ema-sub]');
  if (tileEl) {
    tileEl.classList.remove('ema-above', 'ema-below', 'ema-warmup');
    tileEl.classList.add(`ema-${emaState}`);
  }
  if (priceEl) priceEl.textContent = newClose.toFixed(priceDigits);
  if (subEl) {
    subEl.className = `tile-sub ${emaState === 'above' ? 'pnl-bull' : 'pnl-bear'}`;
    const arrow = emaState === 'above' ? '▲' : '▼';
    subEl.innerHTML = `${arrow} EMA ${ema.toFixed(priceDigits)} · <strong>${gapSign}${gapPct.toFixed(2)}%</strong>`;
  }
}

function statusPillHtml(status) {
  const cls = (status || 'idle').toLowerCase();
  return `<span class="status-pill is-${cls}">${cls}</span>`;
}

function renderStats() {
  const enabled = bots.filter((b) => b.enabled).length;
  document.getElementById('stat-active').textContent = enabled;

  // FIX-2026-07-31: ทุนแนะนำรวม — ผลรวม capitalPerTrade * maxTrades ของ "บอทที่เปิดอยู่" เท่านั้น
  //   ตามที่ user ขอ: นับเฉพาะบอทที่ enabled เพราะบอทที่ปิด/stopped ไม่ได้ใช้ทุน
  //   ถ้าไม่มีบอทเปิดอยู่เลย → แสดง 0.00 + "ยังไม่มีบอททำงาน"
  const enabledBots = bots.filter((b) => b.enabled);
  const totalCapital = enabledBots.reduce((s, b) => s + (b.totalCapital || ((b.capitalPerTrade || 0) * (b.maxTrades || 0))), 0);
  const capEl = document.getElementById('stat-recommended-capital');
  const capSubEl = document.getElementById('stat-recommended-capital-sub');
  if (capEl) {
    const capThb = window.usdtToThb ? window.usdtToThb(totalCapital) : '';
    capEl.innerHTML = `${totalCapital.toFixed(2)}${capThb ? `<span class="thb-eq" style="display:block;font-size:0.85rem;opacity:0.8;font-weight:500;">${capThb}</span>` : ''}`;
    if (capSubEl) {
      capSubEl.textContent = enabledBots.length > 0
        ? `จากบอทที่เปิดอยู่ ${enabledBots.length} บอท`
        : 'ยังไม่มีบอททำงาน';
    }
  }

  const totalTrades = bots.reduce((s, b) => s + (b.totalTrades || 0), 0);
  const totalWins = bots.reduce((s, b) => s + (b.winTrades || 0), 0);
  const totalPnl = bots.reduce((s, b) => s + (b.totalPnl || 0), 0);
  const todayTrades = bots.reduce((s, b) => s + (b.todayTrades || 0), 0);
  const todayPnl = bots.reduce((s, b) => s + (b.todayPnl || 0), 0);
  const monthTrades = bots.reduce((s, b) => s + (b.monthTrades || 0), 0);
  const monthPnl = bots.reduce((s, b) => s + (b.monthPnl || 0), 0);
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
  const totalThb = window.usdtToThb ? window.usdtToThb(totalPnl) : '';
  pnlEl.innerHTML = `${totalPnl.toFixed(4)}${totalThb ? `<span class="thb-eq" style="display:block;font-size:0.85rem;opacity:0.8;font-weight:500;">${totalThb}</span>` : ''}`;
  pnlEl.className = 'value ' + (totalPnl > 0 ? 'pnl-bull' : totalPnl < 0 ? 'pnl-bear' : '');

  // Today stats
  const tileToday = document.getElementById('tile-today-pnl');
  tileToday.classList.remove('is-bull', 'is-bear', 'is-gold');
  if (todayPnl > 0) tileToday.classList.add('is-bull');
  else if (todayPnl < 0) tileToday.classList.add('is-bear');
  else tileToday.classList.add('is-gold');

  const todayEl = document.getElementById('stat-today-pnl');
  const todayThb = window.usdtToThb ? window.usdtToThb(todayPnl) : '';
  todayEl.innerHTML = `${todayPnl.toFixed(4)}${todayThb ? `<span class="thb-eq" style="display:block;font-size:0.85rem;opacity:0.8;font-weight:500;">${todayThb}</span>` : ''}`;
  todayEl.className = 'value ' + (todayPnl > 0 ? 'pnl-bull' : todayPnl < 0 ? 'pnl-bear' : '');
  document.getElementById('stat-today-pnl-sub').textContent = `${todayTrades} ไม้ · วันนี้`;

  document.getElementById('stat-today-trades').textContent = todayTrades;

  // Month stats
  const tileMonth = document.getElementById('tile-month-pnl');
  if (tileMonth) {
    tileMonth.classList.remove('is-bull', 'is-bear', 'is-gold');
    if (monthPnl > 0) tileMonth.classList.add('is-bull');
    else if (monthPnl < 0) tileMonth.classList.add('is-bear');
    else tileMonth.classList.add('is-gold');

    const monthEl = document.getElementById('stat-month-pnl');
    const monthThb = window.usdtToThb ? window.usdtToThb(monthPnl) : '';
    monthEl.innerHTML = `${monthPnl.toFixed(4)}${monthThb ? `<span class="thb-eq" style="display:block;font-size:0.85rem;opacity:0.8;font-weight:500;">${monthThb}</span>` : ''}`;
    monthEl.className = 'value ' + (monthPnl > 0 ? 'pnl-bull' : monthPnl < 0 ? 'pnl-bear' : '');
    document.getElementById('stat-month-pnl-sub').textContent = `${monthTrades} ไม้ · เดือนนี้`;

    document.getElementById('stat-month-trades').textContent = monthTrades;
  }
}

// ─── callBotWithPassword now lives in /js/luxConfirm.js (loaded before this script) ────
// The backwards-compat global window.callBotWithPassword is set there too.

async function createBot() {
  const data = {
    name: document.getElementById('nb-name').value || undefined,
    symbol: document.getElementById('nb-symbol').value,
    timeframe: document.getElementById('nb-timeframe').value,
    capitalPerTrade: parseFloat(document.getElementById('nb-capital').value),
    maxTrades: parseInt(document.getElementById('nb-maxtrades').value, 10),
    tpPercent: parseFloat(document.getElementById('nb-tp').value),
    // FIX-2026-07-24: parseFloat — รองรับทศนิยม (0.5 = 30 วินาที)
    retryTimeMin: parseFloat(document.getElementById('nb-retry').value),
    retryMax: parseInt(document.getElementById('nb-retry-max').value, 10),
    kcMult: parseFloat(document.getElementById('nb-kc-mult').value) || 1.5, // FIX-2026-07-24: per-bot KC multiplier
    minSpreadTicks: parseInt(document.getElementById('nb-min-spread').value, 10) || 1, // FIX-2026-07-24: per-bot min spread (ticks)
    suggestTpWindow: parseInt(document.getElementById('nb-suggest-tp-window').value, 10) || 500, // FIX-2026-07-25: per-bot TP suggestion window
    // FIX-2026-08-02: DCA + BEP stack mode (opt-in, default off — backward compatible)
    dcaEnabled: document.getElementById('nb-dca-enabled') ? document.getElementById('nb-dca-enabled').checked : false,
    dcaMaxLayers: document.getElementById('nb-dca-max-layers') ? parseInt(document.getElementById('nb-dca-max-layers').value, 10) || 3 : 3,
    stopLossOnUpperKC: document.getElementById('nb-stop-loss-upper-kc').checked, // FIX-2026-07-23
    s1OnlyDown: document.getElementById('nb-s1-only-down').checked, // FIX-2026-07-24: skip bg 2→1
    xs1Enabled: document.getElementById('nb-xs1-enabled').checked, // FIX-2026-07-25: per-bot XS1 anti-dump toggle (default true)
    cbEnabled: document.getElementById('nb-cb-enabled').checked, // FIX-2026-08-01: per-bot Circuit-breaker panic-sell toggle (default true) — เดิมชื่อ sls1Enabled
    // FIX-2026-08-08: only send the ACTIVE CB version's fields (other section is display:none)
    //   - cached cbVersion via window._mcCache?.cbVersion (set by applyCbVersionToNewBot)
    cbv2Enabled: (window._newBotCbVersion || 'v3') === 'v2' ? document.getElementById('nb-cbv2-enabled').checked : true,
    cbv2LockHours: (window._newBotCbVersion || 'v3') === 'v2' ? parseFloat(document.getElementById('nb-cbv2-lock-hours').value) : 8,
    cbv3Enabled: (window._newBotCbVersion || 'v3') === 'v3' ? document.getElementById('nb-cbv3-enabled').checked : true,
    cbv3LockHours: (window._newBotCbVersion || 'v3') === 'v3' ? parseFloat(document.getElementById('nb-cbv3-lock-hours').value) || 8 : 8,
    // FIX-2026-08-10: CBv5 (Support Zone + Deepest Low + Volume Filter) — independent of cbVersion
    cbv5Enabled: document.getElementById('nb-cbv5-enabled') ? document.getElementById('nb-cbv5-enabled').checked : true,
    cbv5LockHours: parseFloat(document.getElementById('nb-cbv5-lock-hours').value) || 4,
    cbv5KcLen: parseInt(document.getElementById('nb-cbv5-kc-len').value, 10) || 20,
    cbv5KcMult: parseFloat(document.getElementById('nb-cbv5-kc-mult').value) || 1.2,
    cbv5PivotLookback: parseInt(document.getElementById('nb-cbv5-pivot-lookback').value, 10) || 3,
    cbv5PivotLeftLen: parseInt(document.getElementById('nb-cbv5-pivot-left').value, 10) || 5,
    cbv5PivotRightLen: parseInt(document.getElementById('nb-cbv5-pivot-right').value, 10) || 5,
    cbv5StrictBreak: document.getElementById('nb-cbv5-strict-break').checked,
    cbv5UseVolume: document.getElementById('nb-cbv5-use-volume').checked,
    cbv5VolMaLen: parseInt(document.getElementById('nb-cbv5-vol-ma-len').value, 10) || 20,
    cbv5VolMultiplier: parseFloat(document.getElementById('nb-cbv5-vol-mult').value) || 1.5,
    cbv5DebounceCandles: parseInt(document.getElementById('nb-cbv5-debounce').value, 10) || 5,
    // FIX-2026-08-08: Feature #3 — CB Auto-Unlock (opt-in, default false)
    cbAutoUnlockEnabled: document.getElementById('nb-cb-auto-unlock-enabled') ? document.getElementById('nb-cb-auto-unlock-enabled').checked : false,
    cbAutoUnlockThresholdPct: parseFloat(document.getElementById('nb-cb-auto-unlock-threshold') ? document.getElementById('nb-cb-auto-unlock-threshold').value : 1.0) || 1.0,
    // FIX-2026-08-08: Feature #1 — Dynamic Position Sizing (default ON)
    dynamicSizeEnabled: document.getElementById('nb-dynamic-size-enabled') ? document.getElementById('nb-dynamic-size-enabled').checked : true,
    safeTradeEnabled: document.getElementById('nb-safe-trade-enabled').checked, // FIX-2026-08-01: per-bot safe-trade filter (default ON)
    safeTradeTrendlineEnabled: document.getElementById('nb-safe-trade-trendline-enabled').checked, // FIX-2026-08-03: Safe-trade filter #2 (LuxAlgo trendline) — opt-in, default OFF
    safeTradeNoTradeEnabled: document.getElementById('nb-safe-trade-no-trade-enabled').checked, // FIX-2026-08-05: Safe-trade filter #3 (no-trade engulfing/SS) — opt-in, default OFF
    autoPauseEnabled: document.getElementById('nb-auto-pause-enabled').checked, // FIX-2026-08-01: per-bot auto-pause on low Min-%KC (default ON)
    autoPauseMinKcPct: parseFloat(document.getElementById('nb-auto-pause-min-kc').value) || 2, // FIX-2026-08-01: auto-pause threshold %
    autoPauseMin24hVolUsdt: parseFloat(document.getElementById('nb-auto-pause-min-24h-vol').value) || 1000000, // FIX-2026-08-10: 24h volume guard (USDT, default 1M)
    autoArmStopLossOnUKC: document.getElementById('nb-auto-arm-stop-loss-ukc').checked, // FIX-2026-07-31 (F1): per-bot auto-arm SL-on-UKC toggle (default true)
    autoArmLossPct: parseFloat(document.getElementById('nb-auto-arm-loss-pct').value) || 10, // FIX-2026-08-03: F1 loss threshold (1..90, default 10)
    autoArmAgeHours: parseFloat(document.getElementById('nb-auto-arm-age-hours').value) || 4, // FIX-2026-08-03: F1 age threshold (0.5..168, default 4)
    slUkcTriggerOnProfit: document.getElementById('nb-sl-ukc-trigger-on-profit').checked, // FIX-2026-08-03: SL-UKC trigger on profit (default false)
    tpTrendEnabled: document.getElementById('nb-tp-trend-enabled').checked, // FIX-2026-08-01: per-bot TP trend ×N master toggle (default true)
    tpTrendMultiplier: parseFloat(document.getElementById('nb-tp-trend-multiplier').value) || 2, // FIX-2026-07-31 (F2): per-bot TP ×N multiplier (1..10, default 2)
    autoUpdateTp: document.getElementById('nb-auto-update-tp').checked, // FIX-2026-07-23: TP auto-update toggle
    // FIX-2026-07-31: ส่ง enabled ตาม checkbox — atomic create + enable ใน 1 round-trip
    enabled: document.getElementById('nb-auto-enable').checked === true,
    password: document.getElementById('nb-password').value || undefined, // up-front pw if user typed it
  };
  const btn = document.getElementById('nb-create');
  const errEl = document.getElementById('nb-error');
  errEl.textContent = '';
  btn.classList.add('is-loading');
  btn.disabled = true;
  try {
    const resp = await callBotWithPassword('POST', '/api/bots', data, 'สร้างบอท');
    // FIX-2026-07-31: ถ้า auto-enable ล้มเหลว → แสดง warning แต่ไม่ block (bot ถูกสร้างแล้ว)
    let warn = '';
    if (resp && resp.autoEnabled === false && resp.autoEnableError) {
      warn = `\n⚠️ บอทถูกสร้างแล้ว แต่เริ่มเทรดไม่สำเร็จ: ${resp.autoEnableError}`;
    }
    bootstrap.Modal.getInstance(document.getElementById('newBotModal')).hide();
    await loadBots();
    if (warn) {
      // แสดง warning ใน toast/alert zone (ถ้ามี) หรือ console
      console.warn('createBot auto-enable warning:', warn);
      try { alert(warn.trim()); } catch (_) { /* ignore */ }
    }
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }
}

/**
 * FIX-2026-07-23: dismiss error banner
 *   - optimistic UI: hide banner immediately (no flicker waiting for WS roundtrip)
 *   - call POST /api/bots/:id/clear-error to clear lastError in DB
 *   - update local bots[] cache so subsequent re-renders don't bring it back
 */
window.dismissBotError = async (botId, btnEl) => {
  // optimistic: hide the banner immediately
  const banner = btnEl && btnEl.closest('.bc-err');
  if (banner) banner.style.display = 'none';
  // clear local cache so re-render doesn't bring it back
  const bot = bots.find((b) => b._id === botId);
  if (bot) bot.lastError = '';
  // remove .has-error class on the card
  const card = btnEl && btnEl.closest('.bot-card-v2');
  if (card) card.classList.remove('has-error');
  try {
    await API.post(`/api/bots/${botId}/clear-error`, {});
  } catch (err) {
    console.error('dismissBotError', err);
    // restore banner if API failed
    if (banner) banner.style.display = '';
    if (bot && err && err.response) {
      // re-fetch bots to restore correct state
      await loadBots().catch(() => {});
    }
  }
};

// FIX-2026-08-01: dismiss warning banner (mirror dismissBotError)
//   - ใช้เมื่อ user กดปิด warning (1h latched alert) → POST /api/bots/:id/clear-warning
//   - optimistic UI: ซ่อน banner ทันที + ลบ .has-warning class
//   - ถ้า API fail → restore + re-fetch
window.dismissBotWarning = async (botId, btnEl) => {
  const banner = btnEl && btnEl.closest('.bc-warn');
  if (banner) banner.style.display = 'none';
  const bot = bots.find((b) => b._id === botId);
  if (bot) {
    bot.warning = '';
    bot.warningAt = null;
  }
  const card = btnEl && btnEl.closest('.bot-card-v2');
  if (card) card.classList.remove('has-warning');
  try {
    await API.post(`/api/bots/${botId}/clear-warning`, {});
  } catch (err) {
    console.error('dismissBotWarning', err);
    if (banner) banner.style.display = '';
    if (bot && err && err.response) {
      await loadBots().catch(() => {});
    }
  }
};

window.toggleBot = async (id, enable) => {
  const bot = bots.find((b) => b._id === id);
  const variant = enable ? 'success' : 'warning';
  const icon = enable ? '▶️' : '⏸';
  const title = enable ? 'ยืนยันการเปิดบอท' : 'ยืนยันการหยุดบอท';
  const sub = enable
    ? 'บอทจะเริ่ม scan ตลาดและเปิด order ตาม signal — ใช้ทุนตามที่ตั้งไว้ทันที'
    : 'บอทจะหยุดเปิดไม้ใหม่ — trades ที่กำลังถืออยู่จะยังคงทำงานต่อตามปกติ';
  const dangerNote = !enable
    ? 'บอทที่กำลังถืออยู่จะไม่ถูกบังคับปิด — ต้องรอให้แต่ละไม้ปิดเองตาม TP/timeout'
    : null;
  const target = bot ? { name: bot.name || bot.symbol, symbol: bot.symbol, timeframe: bot.timeframe } : null;
  const pw = await luxConfirm({
    variant, icon, title, sub,
    message: enable ? 'เปิดให้บอทนี้ทำงานหรือไม่?' : 'หยุดบอทนี้หรือไม่?',
    target, requirePassword: true, dangerNote,
    confirmLabel: enable ? 'เปิดบอท' : 'หยุดบอท',
    confirmGlyph: enable ? '▶' : '⏸',
  });
  if (pw === null) return;
  try {
    await callBotWithPassword('POST', `/api/bots/${id}/${enable ? 'enable' : 'disable'}`, { password: pw || undefined }, enable ? 'เปิดบอท' : 'ปิดบอท');
    await loadBots();
  } catch (err) {
    await luxAlert({
      variant: 'danger',
      icon: '⚠️',
      title: enable ? 'เปิดบอทไม่สำเร็จ' : 'หยุดบอทไม่สำเร็จ',
      sub: '', message: err.message, dangerNote: null,
    });
  }
};

window.deleteBot = async (id) => {
  const bot = bots.find((b) => b._id === id);
  const target = bot ? { name: bot.name || bot.symbol, symbol: bot.symbol, timeframe: bot.timeframe } : null;
  const pw = await luxConfirm({
    variant: 'danger',
    icon: '🗑️',
    title: 'ยืนยันการลบบอท',
    sub: 'การลบจะลบบอทและ meta ทั้งหมด — ไม่สามารถกู้คืนได้',
    message: 'ลบบอทนี้อย่างถาวร?',
    target, requirePassword: true,
    dangerNote: 'คำเตือน: บอทจะหยุดทำงานทันที — trades ที่กำลังถือจะถูกทิ้งค้างไว้ (ต้องจัดการเอง)',
    confirmLabel: 'ลบบอท',
    confirmGlyph: '🗑',
  });
  if (pw === null) return;
  try {
    await callBotWithPassword('DELETE', `/api/bots/${id}`, { password: pw || undefined }, 'ลบบอท');
    await loadBots();
  } catch (err) {
    await luxAlert({
      variant: 'danger',
      icon: '⚠️',
      title: 'ลบบอทไม่สำเร็จ',
      sub: '', message: err.message, dangerNote: null,
    });
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

// FIX-2026-07-24: format retry time — รองรับทศนิยม เช่น 0.5 → "30s", 1 → "1m", 1.5 → "1m 30s"
function formatRetryTime(min) {
  const m = Number(min);
  if (!Number.isFinite(m)) return String(min);
  if (m < 1) return `${Math.round(m * 60)}s`;
  const wholeMin = Math.floor(m);
  const secs = Math.round((m - wholeMin) * 60);
  if (secs === 0) return `${wholeMin}m`;
  if (secs === 60) return `${wholeMin + 1}m`;
  return `${wholeMin}m ${secs}s`;
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

/**
 * Format cumulative active duration (ms) using calendar-aware units,
 * showing the top 3 non-zero units (e.g. "1 ปี 6 เดือน 3 วัน", "4 เดือน 3 วัน 6 ชั่วโมง",
 * "1 วัน 8 ชั่วโมง 40 นาที", "1 ชั่วโมง 15 นาที").
 * ใช้ Date arithmetic เพื่อความแม่นยำของเดือน/ปี (รองรับ leap year, เดือน 28-31 วัน).
 */
function formatActiveDuration(ms) {
  if (ms == null || ms <= 0) return '0 นาที';
  const now = new Date();
  const past = new Date(now.getTime() - ms);

  let years = now.getFullYear() - past.getFullYear();
  let months = now.getMonth() - past.getMonth();
  let days = now.getDate() - past.getDate();
  let hours = now.getHours() - past.getHours();
  let minutes = now.getMinutes() - past.getMinutes();

  // Normalize (ยืมจากหน่วยที่ใหญ่กว่า)
  if (minutes < 0) { minutes += 60; hours -= 1; }
  if (hours < 0)   { hours += 24; days -= 1; }
  if (days < 0) {
    // จำนวนวันของเดือนก่อนหน้า
    const prevMonthLastDay = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    days += prevMonthLastDay;
    months -= 1;
  }
  if (months < 0) { months += 12; years -= 1; }

  const units = [];
  if (years > 0)   units.push({ v: years,   u: 'ปี' });
  if (months > 0)  units.push({ v: months,  u: 'เดือน' });
  if (days > 0)    units.push({ v: days,    u: 'วัน' });
  if (hours > 0)   units.push({ v: hours,   u: 'ชั่วโมง' });
  if (minutes > 0) units.push({ v: minutes, u: 'นาที' });

  const top = units.slice(0, 3);
  if (top.length === 0) {
    const sec = Math.floor(ms / 1000);
    return `${sec} วินาที`;
  }
  return top.map((u) => `${u.v} ${u.u}`).join(' ');
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
  setText('hb-ts', status.ts ? new Date(status.ts).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '-');
}

/* ════════════════════════════════════════════════════════════════════
 * FIX-2026-07-24: Mini chart สำหรับบอทที่ enabled ในหน้า /bots.html
 *   - lightweight-charts (CDN) ขนาด ~280x100
 *   - แสดง: candle + EMA20 + Upper KC + Lower KC + S1 signal + BUY/SELL markers
 *   - ดึงข้อมูลจาก /api/bots/:id/mini-chart?limit=30 (single round-trip)
 *   - live update: WS 'kline:update' → update last candle; 'trade:update' → re-fetch markers
 *   - cleanup teardownMiniCharts() ก่อน renderBots() ทุกครั้ง กัน memory leak
 * ════════════════════════════════════════════════════════════════════ */

// map botId -> { chart, candleSeries, basisSeries, upperSeries, lowerSeries, candleData, klines, symbol, timeframe }
const _miniCharts = new Map();
// map botId -> setInterval handle for periodic refresh (fallback if WS misses)
const _miniChartRefreshTimers = new Map();

function teardownMiniCharts() {
  for (const [, entry] of _miniCharts.entries()) {
    try { entry.chart.remove(); } catch (e) { /* ignore */ }
  }
  _miniCharts.clear();
  for (const [, t] of _miniChartRefreshTimers.entries()) {
    clearInterval(t);
  }
  _miniChartRefreshTimers.clear();
}

function setupMiniCharts() {
  if (typeof LightweightCharts === 'undefined') {
    console.warn('mini-chart: lightweight-charts not loaded, skipping');
    return;
  }
  document.querySelectorAll('[data-mini-chart]').forEach((el) => {
    const botId = el.dataset.botId;
    const symbol = el.dataset.symbol;
    const timeframe = el.dataset.timeframe;
    loadMiniChart(botId, el, symbol, timeframe).catch((err) => {
      console.warn(`mini-chart ${botId}:`, err);
      el.innerHTML = `<div class="bc-minichart-error">⚠️ โหลดไม่สำเร็จ</div>`;
    });
  });
}

async function loadMiniChart(botId, el, symbol, timeframe) {
  const resp = await API.get(`/api/bots/${botId}/mini-chart?limit=40`);
  if (!resp.klines || resp.klines.length === 0) {
    el.innerHTML = `<div class="bc-minichart-error">— ไม่มีข้อมูล —</div>`;
    return;
  }

  // build initial container
  el.innerHTML = '';
  const w = el.clientWidth || 360;
  const h = 140;

  // FIX-2026-07-24 v2: mini chart sizing — กันแท่งอ้วน/สูงเกิน
  //   - barSpacing dynamic: clamp 4–7 px/bar ตามความกว้าง container + จำนวน bars
  //   - hide time axis ทั้งหมด (mini chart ไม่ต้องการ label เวลา — กันซ้อนทับ)
  //   - ขยายเป็น 40 bars
  //   - คำนวณใหม่ทุกครั้งที่ resize (responsive PC ↔ mobile)
  const numBars = resp.klines.length;
  const barSpacing = Math.max(3, Math.min(7, Math.floor(w / numBars)));

  const chart = LightweightCharts.createChart(el, {
    width: w,
    height: h,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#94a3b8',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.03)' },
      horzLines: { color: 'rgba(255,255,255,0.03)' },
    },
    rightPriceScale: {
      borderVisible: false,
      scaleMargins: { top: 0.08, bottom: 0.08 },
    },
    timeScale: {
      borderVisible: false,
      // FIX-2026-07-24 v2: hide time axis ทั้งหมด — กัน labels ซ้อนทับและประหยัดแนวตั้ง
      visible: false,
      rightOffset: 2,
      barSpacing,
      handleScroll: false,
      handleScale: false,
    },
    crosshair: {
      vertLine: { visible: false },
      horzLine: { visible: false },
    },
  });

  // candle
  const candleSeries = chart.addCandlestickSeries({
    upColor: '#00e5b8', downColor: '#ff4d6d',
    borderUpColor: '#00e5b8', borderDownColor: '#ff4d6d',
    wickUpColor: '#00e5b8', wickDownColor: '#ff4d6d',
    maxBarCount: numBars,
  });
  // EMA20 (basis)
  const basisSeries = chart.addLineSeries({
    color: '#f5b800', lineWidth: 1,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  // Upper KC (dashed)
  const upperSeries = chart.addLineSeries({
    color: '#ff7849', lineWidth: 1, lineStyle: 2,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  // Lower KC (dashed)
  const lowerSeries = chart.addLineSeries({
    color: '#a78bfa', lineWidth: 1, lineStyle: 2,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });

  // seed data
  const candleData = resp.klines.map((k) => ({
    time: Math.floor(k.openTime / 1000),
    open: k.open, high: k.high, low: k.low, close: k.close,
  }));
  candleSeries.setData(candleData);

  const basisData = [];
  const upperData = [];
  const lowerData = [];
  for (let i = 0; i < resp.klines.length; i += 1) {
    const t = Math.floor(resp.klines[i].openTime / 1000);
    if (resp.keltner.basis[i] != null) {
      basisData.push({ time: t, value: resp.keltner.basis[i] });
      upperData.push({ time: t, value: resp.keltner.upper[i] });
      lowerData.push({ time: t, value: resp.keltner.lower[i] });
    }
  }
  basisSeries.setData(basisData);
  upperSeries.setData(upperData);
  lowerSeries.setData(lowerData);

  // FIX-2026-07-24: markers — S1 signals (small arrow), BUY/SELL (text marks)
  const s1Markers = (resp.signals || []).map((s) => ({
    time: Math.floor(s.openTime / 1000),
    position: 'belowBar',
    color: '#22c55e',
    shape: 'arrowUp',
    text: 'S1',
  }));
  const allMarkers = [...s1Markers, ...(resp.tradeMarkers || [])];
  if (allMarkers.length > 0) candleSeries.setMarkers(allMarkers);

  // FIX-2026-07-24 v2: ไม่เรียก fitContent() — ใช้ explicit barSpacing แทน เพื่อให้แท่งไม่อ้วน
  chart.applyOptions({ timeScale: { barSpacing, rightOffset: 2 } });

  // store + cleanup-on-replace
  _miniCharts.set(botId, {
    chart, candleSeries, basisSeries, upperSeries, lowerSeries,
    klines: resp.klines.slice(), symbol, timeframe,
  });

  // re-fetch markers ทุก 60s (BUY/SELL ใหม่ที่ fill ระหว่างรอบ)
  // (WS kline:update จัดการ live candle, แต่ trade markers ต้อง re-fetch จาก DB)
  if (_miniChartRefreshTimers.has(botId)) clearInterval(_miniChartRefreshTimers.get(botId));
  // FIX-2026-08-04: 60s → 120s (ลด kline API load — แต่ WS kline:update ยัง update candles real-time)
  _miniChartRefreshTimers.set(botId, setInterval(() => {
    refreshMiniChartMarkers(botId).catch((e) => console.debug(`mini-chart refresh ${botId}:`, e.message));
  }, 120_000));

  // FIX-2026-07-24 v2: ResizeObserver — ปรับ width + barSpacing ใหม่ทั้งคู่ตาม container (responsive)
  const ro = new ResizeObserver(() => {
    const w2 = el.clientWidth || 360;
    const newBarSpacing = Math.max(3, Math.min(7, Math.floor(w2 / numBars)));
    chart.applyOptions({ width: w2, timeScale: { barSpacing: newBarSpacing } });
  });
  ro.observe(el);
  const prevEntry = _miniCharts.get(botId);
  if (prevEntry) prevEntry._ro = ro;
}

async function refreshMiniChartMarkers(botId) {
  const entry = _miniCharts.get(botId);
  if (!entry) return;
  const resp = await API.get(`/api/bots/${botId}/mini-chart?limit=40`);
  const s1Markers = (resp.signals || []).map((s) => ({
    time: Math.floor(s.openTime / 1000),
    position: 'belowBar',
    color: '#22c55e',
    shape: 'arrowUp',
    text: 'S1',
  }));
  const allMarkers = [...s1Markers, ...(resp.tradeMarkers || [])];
  if (allMarkers.length > 0) entry.candleSeries.setMarkers(allMarkers);
  // sync klines cache (ใช้สำหรับ live update จาก WS)
  entry.klines = resp.klines.slice();
  // sync EMA/KC (ค่าเปลี่ยนเมื่อมีแท่งใหม่)
  const { basis, upper, lower } = resp.keltner || { basis: [], upper: [], lower: [] };
  const basisData = [];
  const upperData = [];
  const lowerData = [];
  for (let i = 0; i < resp.klines.length; i += 1) {
    const t = Math.floor(resp.klines[i].openTime / 1000);
    if (basis[i] != null) {
      basisData.push({ time: t, value: basis[i] });
      upperData.push({ time: t, value: upper[i] });
      lowerData.push({ time: t, value: lower[i] });
    }
  }
  if (basisData.length) entry.basisSeries.setData(basisData);
  if (upperData.length) entry.upperSeries.setData(upperData);
  if (lowerData.length) entry.lowerSeries.setData(lowerData);
}

// FIX-2026-07-24: WS live update — candle (kline:update) + BUY/SELL markers (trade:update หรือ bot:status change)
(function bindMiniChartWS() {
  // wait จนกว่า WSClient จะ start
  if (typeof WSClient === 'undefined') return;
  // subscribe หลัง init เพื่อให้แน่ใจว่า WS พร้อม
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      WSClient.on('kline:update', (p) => {
        if (!p || !p.kline) return;
        for (const [botId, entry] of _miniCharts.entries()) {
          if (entry.symbol !== p.symbol || entry.timeframe !== p.interval) continue;
          const k = p.kline;
          const t = Math.floor(k.openTime / 1000);
          entry.candleSeries.update({
            time: t,
            open: parseFloat(k.open),
            high: parseFloat(k.high),
            low: parseFloat(k.low),
            close: parseFloat(k.close),
          });
        }
      });
      // เมื่อ trade fill ใหม่ → re-fetch markers
      WSClient.on('trade:update', (p) => {
        if (!p || !p.tradeId) return;
        // หา botId จาก Trade — แต่ payload ไม่มี botId โดยตรง
        // (cheap path: refresh markers ของทุกบอทที่มี chart อยู่ — N<=10 ก็ไม่เปลือง API)
        for (const botId of _miniCharts.keys()) {
          refreshMiniChartMarkers(botId).catch(() => {});
        }
      });
      // FIX-2026-08-02: signal:new → re-fetch markers ทันที (เดิมพึ่ง trade:update ซึ่งจะมาหลังจาก trade ถูก place)
      //   - ทำให้ bot-detail chart (ซึ่ง subscribe signal:new) sync กับ mini-chart ได้ทันที
      //   - กรณี signal ไม่ได้ place trade (เช่น maxTrades ถึง limit, safe-trade block) mini-chart ก็ยัง update marker
      WSClient.on('signal:new', (p) => {
        if (!p || !p.signal) return;
        const signalBotId = String(p.signal.botId || '');
        if (!signalBotId) return;
        if (_miniCharts.has(signalBotId)) {
          refreshMiniChartMarkers(signalBotId).catch(() => {});
        }
      });
      WSClient.on('bot:updated', () => loadBots());
    }, 100);
  });
})();

init();