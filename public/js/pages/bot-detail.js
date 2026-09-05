'use strict';

/* ─────────────────────────────────────────────────────────
   Bot Detail — premium dark theme, tabs, mobile-responsive
   ───────────────────────────────────────────────────────── */

const BOT_ID = new URLSearchParams(location.search).get('id');
window.NAV_ACTIVE = 'detail';
window.NAV_BOT_ID = BOT_ID;
window.NAV_DETAIL_LABEL = 'Bot Detail';

let detail = null;
let refreshTimer = null;
let activeTab = 'overview';
let currentPrice = null; // latest close price from kline:update WS (for live % PnL/% to TP on Positions tab)

/* Charts */
let priceChart = null;
let candleSeries = null;
let basisSeries = null;   // EMA (Keltner basis)
let upperSeries = null;   // Upper Keltner Channel
let lowerSeries = null;   // Lower Keltner Channel
let pnlChart = null;
let pnlSeries = null;
let pnlMarkers = null;

const STATE_COLORS = {
  placed: 'placed',
  filled: 'filled',
  retrying: 'retrying',
  cancelled: 'cancelled',
  holding: 'holding',
  selling: 'selling',
  sold: 'sold',
  failed: 'failed',
  expired: 'expired',
  skipped: 'skipped',
};
const OUTCOME_CLASS = {
  detected: 'detected',
  order_placed: 'order_placed',
  filled: 'success',
  expired: 'expired',
  failed: 'failed',
  skipped: 'skipped',
};

/* ── Init ─────────────────────────────────────────────── */
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
  setupTabs();
  setupButtons();
  setupCharts();

  // FIX-2026-07-31: preload Binance tickSize precision สำหรับ PriceFormat
  if (window.PriceFormat) await window.PriceFormat.load();

  await refresh();

  // live updates
  WSClient.on('bot:status', (p) => {
    if (p.botId === BOT_ID && detail) {
      detail.bot.status = p.status;
      renderHero();
      renderSummary();
    }
  });
  WSClient.on('trade:update', (p) => {
    if (detail && p.tradeId && detail.trades.some((t) => t._id === p.tradeId)) {
      // Fast path: if Positions tab is active, do a targeted re-render + soft refresh
      if (activeTab === 'positions') {
        // Update in-place trade state for instant UI; refresh() follows for full sync
        const t = detail.trades.find((x) => x._id === p.tradeId);
        if (t && p.state) t.state = p.state;
        renderPositions();
        renderSummary();
      }
      refresh();
    }
  });
  WSClient.on('bot:updated', () => refresh());
  // FIX-2026-08-02: signal:new → re-render price chart ทันที (sync กับ mini-chart ของหน้า /bots.html)
  //   - เดิม bot-detail chart รอ 15s polling หรือ bar-close countdown → ทำให้ S1 marker ใหม่ไม่ขึ้นทันที
  //   - กรณี signal ไม่ได้ place trade (maxTrades ถึง limit / safe-trade block) ไม่มี trade:update → อาจไม่ refresh เลย
  WSClient.on('signal:new', (p) => {
    if (!p || !p.signal || !detail) return;
    if (String(p.signal.botId) !== String(BOT_ID)) return;
    if (priceChart) renderPriceChart();
  });
  WSClient.on('kline:update', (p) => {
    if (!detail || !p.kline || !candleSeries) return;
    if (p.kline.symbol !== detail.bot.symbol || p.interval !== detail.bot.timeframe) return;
    const lastCandle = lastKline;
    if (lastCandle && p.kline.openTime === lastCandle.openTime) {
      const updated = {
        time: p.kline.openTime / 1000,
        open: parseFloat(p.kline.open),
        high: Math.max(lastCandle.high, parseFloat(p.kline.high)),
        low: Math.min(lastCandle.low, parseFloat(p.kline.low)),
        close: parseFloat(p.kline.close),
      };
      candleSeries.update(updated);
      lastKline = updated;
    }
    // feed live price to Positions tab (% PnL / % to TP)
    const newPrice = parseFloat(p.kline.close);
    if (!isNaN(newPrice) && newPrice > 0) {
      currentPrice = newPrice;
      if (activeTab === 'positions') renderPositions();
    }
  });

  // FIX-2026-08-04: 15s → 30s (ลด load — bot-detail page เป็น read-only display, WS push จัดการ live ticks)
  refreshTimer = setInterval(refresh, 30000);
}

/* ── Tabs ─────────────────────────────────────────────── */
function setupTabs() {
  document.querySelectorAll('.lux-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  document.querySelectorAll('[data-tab-link]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab(a.dataset.tabLink);
    });
  });
}
function switchTab(key) {
  activeTab = key;
  document.querySelectorAll('.lux-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === key);
  });
  document.querySelectorAll('[data-tab-panel]').forEach((p) => {
    p.style.display = p.dataset.tabPanel === key ? '' : 'none';
  });
}

/* ── Buttons ──────────────────────────────────────────── */
function setupButtons() {
  document.getElementById('refresh-btn').onclick = refresh;
  document.getElementById('edit-btn').href = `/bot-edit.html?id=${BOT_ID}`;
  document.getElementById('enable-btn').onclick = async () => {
    await LUX_CONFIRM.callBotWithPassword('POST', `/api/bots/${BOT_ID}/enable`, {}, 'เปิดบอท');
    await refresh();
  };
  document.getElementById('disable-btn').onclick = async () => {
    await LUX_CONFIRM.callBotWithPassword('POST', `/api/bots/${BOT_ID}/disable`, {}, 'หยุดบอท');
    await refresh();
  };
  const forceBtn = document.getElementById('force-close-bot-btn');
  if (forceBtn) forceBtn.onclick = forceCloseBotFlow;
  const loadOlderBtn = document.getElementById('btn-load-older');
  if (loadOlderBtn) loadOlderBtn.onclick = loadOlderCandles;

  // Per-trade Force Close via event delegation (cards re-render every refresh)
  const desk = document.getElementById('positions-list');
  const mob = document.getElementById('positions-mob');
  if (desk) desk.addEventListener('click', onPositionListClick);
  if (mob) mob.addEventListener('click', onPositionListClick);
}

async function onPositionListClick(ev) {
  // FIX-2026-08-02: support both regular .btn-force-close (PositionCard) + .btn-force-close-dca (StackCard)
  const btn = ev.target.closest('.btn-force-close, .btn-force-close-dca');
  if (!btn) return;
  const tradeId = btn.dataset.tradeId;
  if (!tradeId) return;
  const trade = (detail.trades || []).find((t) => String(t._id) === String(tradeId));
  if (!trade) return;
  if (trade.isDcaStack === true) {
    await forceCloseDcaStackFlow(trade);
  } else {
    await forceClosePositionFlow(trade);
  }
}

async function forceCloseDcaStackFlow(stack) {
  const layerCount = Number(stack.dcaLayerCount) || (stack.buyLayers?.length || 0);
  const totalQty = Number(stack.stackTotalQty) || 0;
  const totalSpent = Number(stack.stackTotalSpent) || 0;
  const target = {
    name: stack.symbol || '-',
    symbol: stack.symbol || '-',
    timeframe: stack.timeframe || '-',
  };
  const pw = await LUX_CONFIRM.luxConfirm({
    variant: 'danger',
    icon: '📚',
    title: 'ยืนยันบังคับปิด DCA stack',
    sub: `จะยกเลิก aggregate SELL (ถ้ามี) แล้ว MARKET SELL ${totalQty.toFixed(6)} (ทั้ง stack)`,
    message: `Stack ${stack._id} (${stack.symbol}, state=${stack.state}, layers=${layerCount}, total spent=${totalSpent.toFixed(2)} USDT, BEP=${Number(stack.stackBep || 0).toFixed(8)}) — ปิดทั้ง stack เลยหรือไม่?`,
    target, requirePassword: true,
    dangerNote: 'บอทยังคงทำงานต่อ — เฉพาะ stack นี้ที่ถูกปิด (sellReason=dca_stack_force_close)',
    confirmLabel: 'บังคับปิด stack', confirmGlyph: '📚',
  });
  if (pw === null) return;
  try {
    const resp = await LUX_CONFIRM.callBotWithPassword(
      'POST',
      `/api/bots/${BOT_ID}/trades/${stack._id}/force-close`,
      { password: pw || undefined },
      `force-close DCA stack ${stack._id}`,
    );
    const mode = resp && resp.result && resp.result.mode;
    const layers = (resp.result && resp.result.layerCount) || layerCount;
    await LUX_CONFIRM.luxAlert({
      variant: 'success',
      icon: '✅',
      title: 'บังคับปิด DCA stack สำเร็จ',
      message: `mode=${mode || 'unknown'} · layers=${layers} · pnl=${(resp.result && resp.result.pnl != null) ? resp.result.pnl.toFixed(4) : '-'} USDT`,
    });
    await refresh();
  } catch (err) {
    await LUX_CONFIRM.luxAlert({
      variant: 'danger', icon: '⚠️', title: 'บังคับปิด stack ไม่สำเร็จ', message: err.message,
    });
  }
}

async function forceClosePositionFlow(trade) {
  const target = {
    name: trade.symbol || '-',
    symbol: trade.symbol || '-',
    timeframe: trade.timeframe || '-',
  };
  const pw = await LUX_CONFIRM.luxConfirm({
    variant: 'danger',
    icon: '🛑',
    title: 'ยืนยันบังคับปิด position',
    sub: `จะยกเลิก SELL (ถ้ามี) แล้ว MARKET SELL freeQty (ถ้ามี asset) หรือ synthetic-close`,
    message: `ไม้ ${trade._id} (${trade.symbol}, state=${trade.state}, qty=${Number(trade.buyQty || 0).toFixed(6)}) — ปิดเลยหรือไม่?`,
    target, requirePassword: true,
    dangerNote: 'บอทยังคงทำงานต่อ — เฉพาะไม้นี้ที่ถูกปิด (ถ้าจะปิดทั้งบอทให้ใช้ปุ่ม ⛔ Force Close บอท)',
    confirmLabel: 'บังคับปิดไม้นี้', confirmGlyph: '🛑',
  });
  if (pw === null) return;
  try {
    const resp = await LUX_CONFIRM.callBotWithPassword(
      'POST',
      `/api/bots/${BOT_ID}/trades/${trade._id}/force-close`,
      { password: pw || undefined },
      `force-close position ${trade._id}`,
    );
    const mode = resp && resp.result && resp.result.mode;
    await LUX_CONFIRM.luxAlert({
      variant: 'success',
      icon: '✅',
      title: 'บังคับปิดไม้สำเร็จ',
      message: `mode=${mode || 'unknown'} · pnl=${(resp.result && resp.result.pnl != null) ? resp.result.pnl.toFixed(4) : '-'} USDT`,
    });
    await refresh();
  } catch (err) {
    await LUX_CONFIRM.luxAlert({
      variant: 'danger', icon: '⚠️', title: 'บังคับปิดไม้ไม่สำเร็จ', message: err.message,
    });
  }
}

async function forceCloseBotFlow() {
  if (!detail || !detail.bot) return;
  const open = (detail.trades || []).filter((t) => OPEN_TRADE_STATES.includes(t.state));
  if (open.length === 0) {
    await LUX_CONFIRM.luxAlert({
      variant: 'info', icon: 'ℹ️', title: 'ไม่มี position ที่เปิดอยู่', message: 'บอทนี้ไม่มี trade ค้าง — ไม่ต้องบังคับปิด',
    });
    return;
  }
  const bot = detail.bot;
  const target = { name: bot.name || bot.symbol, symbol: bot.symbol, timeframe: bot.timeframe };
  const pw = await LUX_CONFIRM.luxConfirm({
    variant: 'danger',
    icon: '⛔',
    title: 'ยืนยันบังคับปิดทั้งบอท',
    sub: `จะปิด ${open.length} positions แล้วหยุดบอททันที`,
    message: `บอท ${bot.name || bot.symbol} (${bot.symbol}/${bot.timeframe}) — ปิดทั้งหมดและหยุดบอท?`,
    target, requirePassword: true,
    dangerNote: 'บอทจะถูก disable หลัง force-close ทุกไม้ — ต้องกด ▶ เริ่มใหม่เองเมื่อต้องการ',
    confirmLabel: 'บังคับปิดบอท', confirmGlyph: '⛔',
  });
  if (pw === null) return;
  try {
    const resp = await LUX_CONFIRM.callBotWithPassword(
      'POST',
      `/api/bots/${BOT_ID}/force-close`,
      { password: pw || undefined, disableBot: true },
      `force-close bot ${bot.symbol}`,
    );
    let msg = `ปิด ${resp.closedTrades.length} ไม้ (errors: ${resp.errors.length}) · disabled: ${resp.disabled ? 'ใช่' : 'ไม่'}`;
    if (resp.closedTrades.length) {
      msg += '\n\nรายละเอียด:\n' + resp.closedTrades.map((c) =>
        `  • ${c.tradeId}  ${c.symbol}  mode=${c.mode}  pnl=${Number(c.pnl || 0).toFixed(4)}`
      ).join('\n');
    }
    if (resp.errors.length) {
      msg += '\n\nข้อผิดพลาด:\n' + resp.errors.map((e) => `  • ${e.tradeId || e.stage || '-'}  ${e.error}`).join('\n');
    }
    await LUX_CONFIRM.luxAlert({
      variant: resp.errors.length ? 'warning' : 'success',
      icon: resp.errors.length ? '⚠️' : '✅',
      title: 'บังคับปิดบอทเสร็จสิ้น',
      message: msg,
    });
    await refresh();
  } catch (err) {
    await LUX_CONFIRM.luxAlert({
      variant: 'danger', icon: '⚠️', title: 'บังคับปิดบอทไม่สำเร็จ', message: err.message,
    });
  }
}

/* ── Fetch ────────────────────────────────────────────── */
async function refresh() {
  try {
    // limit=200 → fetch up to 200 trades/signals so chart has enough
    // BUY/SELL history to draw across all 150 candles (initial load).
    detail = await API.get(`/api/bots/${BOT_ID}/details?limit=200`);
    renderAll();
  } catch (err) {
    console.error('refresh failed', err);
    if (err.message && err.message.includes('not found')) {
      await AdminModalAlert.alert('Bot not found', 'warn');
      location.href = '/bots.html';
    }
  }
}

// re-render THB equivalents once nav.js publishes the FX rate
document.addEventListener('fx:updated', () => {
  if (detail) {
    renderSummary();
    if (activeTab === 'positions') renderPositions();
  }
});
// also re-render if FX was already cached by nav.js before this script ran
if (window.__fxReady && detail) {
  renderSummary();
  if (activeTab === 'positions') renderPositions();
}

/* ── Render orchestrator ──────────────────────────────── */
function renderAll() {
  if (!detail) return;
  renderHero();
  renderSummary();
  renderActiveTrade();
  renderCfgGrid('cfg-grid');
  renderCfgGrid('cfg-grid-full');
  renderCfgExtra();
  renderPositions();
  renderTrades();
  renderSignals();
  renderRecentSignals();
  renderMetaChips();
  renderPnlChart();
  renderPriceChart();
  document.title = `${detail.bot.name || detail.bot.symbol} · Bot Detail`;
}

/* ── Hero ─────────────────────────────────────────────── */
function renderHero() {
  const b = detail.bot;
  document.getElementById('bot-name').textContent = b.name || `${b.symbol} ${b.timeframe}`;

  const light = document.getElementById('hero-light');
  const lightLabel = document.getElementById('hero-light-label');
  const status = (b.status || 'idle').toLowerCase();
  light.className = 'hero-light';
  if (['waiting_fill', 'retrying', 'placed'].includes(status)) light.classList.add('is-warning');
  else if (status === 'error') light.classList.add('is-error');
  else if (['idle', 'disabled'].includes(status)) light.classList.add('is-idle');
  lightLabel.textContent = status;

  const ts = fmtTime(new Date());
  document.getElementById('hero-updated').textContent = `อัปเดตล่าสุด: ${ts}`;

  document.getElementById('enable-btn').style.display = b.enabled ? 'none' : '';
  document.getElementById('disable-btn').style.display = b.enabled ? '' : 'none';
}

function renderMetaChips() {
  try {
    const b = detail.bot;
    document.getElementById('hero-symbol').textContent = `${b.symbol}`;
    document.getElementById('hero-tf').textContent = `⏱ ${b.timeframe}`;
    document.getElementById('hero-enabled').textContent = b.enabled ? '● ENABLED' : '○ DISABLED';
    document.getElementById('hero-enabled').className = 'chip ' + (b.enabled ? 'bull' : '');
    const uptimeEl = document.getElementById('hero-uptime');
    if (b.enabled && b.enabledAt) {
      const sec = Math.floor((Date.now() - new Date(b.enabledAt).getTime()) / 1000);
      uptimeEl.textContent = `⏱ uptime: ${formatUptime(sec)}`;
      uptimeEl.style.color = 'var(--bull-1)';
    } else {
      uptimeEl.textContent = '⏱ uptime: -';
      uptimeEl.style.color = 'var(--text-4)';
    }
    document.getElementById('hero-id').textContent = `id: ${b._id.slice(-8)}`;

    // FIX-2026-08-06: Delist pill + banner (mirror buildDelistBadge in bots.js)
    renderDelistInfo(b);
  } catch (err) {
    console.error('renderMetaChips', err);
  }
}

// FIX-2026-08-06: แสดง delist pill + warning banner ที่ header
//   - ใช้ field ที่ /api/bots/:id ส่งมา (isAtRisk, isDelisted, delistTime, delistDateIso, daysUntil)
function renderDelistInfo(b) {
  const pill = document.getElementById('hero-delist');
  const banner = document.getElementById('delist-banner');
  if (!pill || !banner) return;

  let pillClass = '';
  let pillText = '';
  let pillTitle = '';

  if (b.isDelisted === true) {
    pillClass = 'is-delisted';
    pillText = '❌ DELISTED';
    pillTitle = 'Symbol ถูก delist ไปแล้ว';
  } else if (b.daysUntil != null && Number.isFinite(b.daysUntil)) {
    const dt = b.delistDateIso ? new Date(b.delistDateIso).toLocaleString('th-TH') : '?';
    const days = b.daysUntil.toFixed(1);
    if (b.daysUntil <= 3) {
      pillClass = 'is-urgent';
      pillText = `🚨 DELIST ${days}d`;
    } else if (b.daysUntil <= 7) {
      pillClass = 'is-warning';
      pillText = `⚠️ DELIST ${days}d`;
    } else {
      pillClass = 'is-scheduled';
      pillText = `📅 DELIST ${days}d`;
    }
    pillTitle = `Binance Delist Schedule\nDelist: ${dt}\nDays until: ${days}\n• ≤ 7d: block new BUY\n• ≤ 3d: force-close position`;
  } else if (b.isAtRisk === true) {
    pillClass = 'is-monitoring';
    pillText = '👁️ MONITORING';
    pillTitle = 'Binance ติด Monitoring tag — early warning';
  }

  if (pillText) {
    pill.className = `delist-pill ${pillClass}`;
    pill.textContent = pillText;
    pill.title = pillTitle;
    pill.style.display = '';
  } else {
    pill.style.display = 'none';
  }

  // Banner — แสดงเฉพาะตอนมี delist schedule (ไม่ใช่ early warning อย่างเดียว)
  if (b.daysUntil != null && Number.isFinite(b.daysUntil)) {
    const dt = b.delistDateIso ? new Date(b.delistDateIso).toLocaleString('th-TH') : '?';
    const days = b.daysUntil.toFixed(1);
    let bannerClass = 'is-scheduled';
    let bannerText = `📅 Binance Delist Schedule: <strong>${dt}</strong> (${days} วัน)`;
    if (b.daysUntil <= 3) {
      bannerClass = 'is-urgent';
      bannerText = `🚨 <strong>URGENT:</strong> Binance จะ delist ${b.symbol} ในอีก <strong>${days} วัน</strong> (${dt}) — บอทนี้จะถูก auto-pause + force-close position`;
    } else if (b.daysUntil <= 7) {
      bannerClass = 'is-warning';
      bannerText = `⚠️ <strong>WARNING:</strong> Binance จะ delist ${b.symbol} ในอีก <strong>${days} วัน</strong> (${dt}) — บอทจะ block การเปิด position ใหม่`;
    }
    banner.className = `delist-banner ${bannerClass}`;
    banner.innerHTML = bannerText;
    banner.style.display = '';
  } else {
    banner.style.display = 'none';
  }
}

/* ── Summary KPIs ─────────────────────────────────────── */
function renderSummary() {
  const b = detail.bot;
  const totalPnl = b.totalPnl || 0;
  const totalTrades = b.totalTrades || 0;
  const wins = b.winTrades || 0;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100) : 0;
  const activeCount = detail.trades.filter((t) =>
    ['placed', 'filled', 'holding', 'selling', 'retrying'].includes(t.state)
  ).length;

  const today = detail.todayStats || { trades: 0, pnl: 0 };
  const todayPnl = today.pnl || 0;
  const todayTrades = today.trades || 0;
  const month = detail.monthStats || { trades: 0, pnl: 0 };
  const monthPnl = month.pnl || 0;
  const monthTrades = month.trades || 0;

  const tilePnl = document.getElementById('tile-pnl');
  tilePnl.classList.remove('is-bull', 'is-bear', 'is-gold');
  if (totalPnl > 0) tilePnl.classList.add('is-bull');
  else if (totalPnl < 0) tilePnl.classList.add('is-bear');
  else tilePnl.classList.add('is-gold');

  const totalThb = window.usdtToThb ? window.usdtToThb(totalPnl) : '';
  const pnlEl = document.getElementById('stat-pnl');
  pnlEl.innerHTML = `${formatUsdt(totalPnl)}${totalThb ? `<span class="thb-eq" style="display:block;font-size:0.85rem;opacity:0.8;font-weight:500;">${totalThb}</span>` : ''}`;
  pnlEl.className = 'value ' + (totalPnl > 0 ? 'pnl-bull' : totalPnl < 0 ? 'pnl-bear' : '');
  document.getElementById('stat-pnl-sub').textContent = `USDT · ${totalTrades} ไม้`;

  document.getElementById('stat-trades').textContent = totalTrades;
  document.getElementById('stat-trades-sub').textContent = `wins ${wins} · losses ${Math.max(0, totalTrades - wins)}`;

  document.getElementById('stat-winrate').textContent = `${winRate.toFixed(1)}%`;
  document.getElementById('stat-winrate-sub').textContent = totalTrades > 0
    ? `avg ${formatUsdt(totalPnl / totalTrades)}/ไม้`
    : 'ยังไม่มีไม้ปิด';

  document.getElementById('stat-active').textContent = `${activeCount} / ${b.maxTrades}`;
  document.getElementById('stat-active-sub').textContent = `ทุนรวม ${(b.capitalPerTrade * b.maxTrades).toFixed(2)} USDT`;

  // Today PnL tile
  const tileToday = document.getElementById('tile-today-pnl');
  if (tileToday) {
    tileToday.classList.remove('is-bull', 'is-bear', 'is-gold');
    if (todayPnl > 0) tileToday.classList.add('is-bull');
    else if (todayPnl < 0) tileToday.classList.add('is-bear');
    else tileToday.classList.add('is-gold');
    const todayThb = window.usdtToThb ? window.usdtToThb(todayPnl) : '';
    const todayEl = document.getElementById('stat-today-pnl');
    todayEl.innerHTML = `${formatUsdt(todayPnl)}${todayThb ? `<span class="thb-eq" style="display:block;font-size:0.85rem;opacity:0.8;font-weight:500;">${todayThb}</span>` : ''}`;
    todayEl.className = 'value ' + (todayPnl > 0 ? 'pnl-bull' : todayPnl < 0 ? 'pnl-bear' : '');
    document.getElementById('stat-today-pnl-sub').textContent = `USDT · ${todayTrades} ไม้`;
  }
  const tileTT = document.getElementById('tile-today-trades');
  if (tileTT) {
    document.getElementById('stat-today-trades').textContent = todayTrades;
    const todayThbTxt = window.usdtToThb ? window.usdtToThb(todayPnl) : '';
    const todayUsdt = todayPnl >= 0 ? `กำไร ${formatUsdt(todayPnl)} USDT` : (todayPnl < 0 ? `ขาดทุน ${formatUsdt(Math.abs(todayPnl))} USDT` : 'ยังไม่มี');
    document.getElementById('stat-today-trades-sub').textContent = todayThbTxt ? `${todayUsdt} (${todayThbTxt})` : todayUsdt;
  }

  // Month stats
  const tileMonth = document.getElementById('tile-month-pnl');
  if (tileMonth) {
    tileMonth.classList.remove('is-bull', 'is-bear', 'is-gold');
    if (monthPnl > 0) tileMonth.classList.add('is-bull');
    else if (monthPnl < 0) tileMonth.classList.add('is-bear');
    else tileMonth.classList.add('is-gold');
    const monthThb = window.usdtToThb ? window.usdtToThb(monthPnl) : '';
    const monthEl = document.getElementById('stat-month-pnl');
    monthEl.innerHTML = `${formatUsdt(monthPnl)}${monthThb ? `<span class="thb-eq" style="display:block;font-size:0.85rem;opacity:0.8;font-weight:500;">${monthThb}</span>` : ''}`;
    monthEl.className = 'value ' + (monthPnl > 0 ? 'pnl-bull' : monthPnl < 0 ? 'pnl-bear' : '');
    document.getElementById('stat-month-pnl-sub').textContent = `${monthTrades} ไม้ · เดือนนี้`;
  }
  const tileMT = document.getElementById('tile-month-trades');
  if (tileMT) {
    document.getElementById('stat-month-trades').textContent = monthTrades;
    const monthThbTxt = window.usdtToThb ? window.usdtToThb(monthPnl) : '';
    const monthUsdt = monthPnl >= 0 ? `กำไร ${formatUsdt(monthPnl)} USDT` : (monthPnl < 0 ? `ขาดทุน ${formatUsdt(Math.abs(monthPnl))} USDT` : 'ยังไม่มี');
    document.getElementById('stat-month-trades-sub').textContent = monthThbTxt ? `${monthUsdt} (${monthThbTxt})` : monthUsdt;
  }

  // sparkline for PnL (cumulative of last 20 closed trades)
  drawSpark('spark-pnl', buildPnlSeries(), totalPnl >= 0 ? 'bull' : 'bear');

  // Show/hide "Force Close บอท" button — only when there are open positions AND bot is enabled
  const forceBtn = document.getElementById('force-close-bot-btn');
  if (forceBtn) {
    const hasOpen = (detail.trades || []).some((t) => OPEN_TRADE_STATES.includes(t.state));
    forceBtn.style.display = (b.enabled && hasOpen) ? '' : 'none';
  }
}

/* ── Active trade ─────────────────────────────────────── */
function renderActiveTrade() {
  const panel = document.getElementById('trade-panel');
  const content = document.getElementById('trade-content');
  const ageEl = document.getElementById('trade-age');
  const t = detail.activeTrade;
  if (!t) {
    panel.classList.add('empty');
    content.innerHTML = '<div class="text-muted-3">ไม่มี active trade</div>';
    ageEl.textContent = '';
    return;
  }
  panel.classList.remove('empty');

  const ageMs = Date.now() - new Date(t.createdAt).getTime();
  ageEl.textContent = `age: ${formatDuration(ageMs)}`;

  const retryMax = (detail.bot.retryMax ?? 1) + 1; // +1 = initial placement + retries
  const usedSlots = (t.retryCount ?? 0) + 1; // +1 = initial
  const segs = [];
  for (let i = 0; i < retryMax; i++) {
    let cls = 'seg';
    if (i < usedSlots) cls += ' used';
    else if (i === usedSlots && ['placed', 'retrying', 'waiting_fill'].includes(t.state)) cls += ' active';
    segs.push(`<div class="${cls}"></div>`);
  }

  const stateClass = STATE_COLORS[t.state] || '';
  const buyStatusClass = STATE_COLORS[(t.buyStatus || '').toLowerCase()] || '';

  content.innerHTML = `
    <div class="row"><span class="k">State</span><span class="v"><span class="status-pill is-${escapeHtml(stateClass)}">${escapeHtml(t.state)}</span>${t.state === 'sold' ? SellReasons.renderSellReasonPill(t.sellReason, t.sellReasonDetail) : ''}</span></div>
    <div class="row"><span class="k">Symbol · TF</span><span class="v">${escapeHtml(t.symbol)} · ${escapeHtml(t.timeframe)}</span></div>
    <div class="row"><span class="k">BUY OrderId</span><span class="v code" style="font-size:0.75rem;">${escapeHtml(t.buyOrderId) || '-'}</span></div>
    <div class="row"><span class="k">BUY Price</span><span class="v">${t.buyPrice != null ? PriceFormat.format(t.buyPrice, t.symbol) : '-'}</span></div>
    <div class="row"><span class="k">BUY Qty</span><span class="v">${t.buyQty != null ? Number(t.buyQty).toFixed(6) : '-'}</span></div>
    <div class="row"><span class="k">BUY Status</span><span class="v"><span class="status-pill is-${escapeHtml(buyStatusClass)}">${escapeHtml(t.buyStatus) || '-'}</span></span></div>
    <div class="row"><span class="k">BUY Placed</span><span class="v" style="font-size:0.78rem;">${t.buyPlacedAt ? fmtTime(t.buyPlacedAt) : '-'}</span></div>
    <div class="row"><span class="k">SELL OrderId</span><span class="v code" style="font-size:0.75rem;">${escapeHtml(t.sellOrderId) || '-'}</span></div>
    <div class="row"><span class="k">Target Sell</span><span class="v">${t.targetSellPrice != null ? PriceFormat.format(t.targetSellPrice, t.symbol) : '-'}</span></div>
    <div class="row"><span class="k">Retry</span><span class="v">${Number(t.retryCount ?? 0)} / ${Number(detail.bot.retryMax ?? 1)}</span></div>
    ${t.error ? `<div class="row"><span class="k">Note</span><span class="v" style="color:var(--bear-1);font-size:0.78rem;">${escapeHtml(t.error)}</span></div>` : ''}
    <div class="retry-bar" title="Slots: ${usedSlots}/${retryMax}">${segs.join('')}</div>`;
}

/* ── Positions tab (open trades) ───────────────────────
 * 2026-07-30: computePositionMetrics / renderPositionCard / renderPositionCardMobile
 *   ถูก extract ไปยัง public/js/partials/positionCard.js (shared partial)
 *   ใช้ซ้ำได้ทั้ง bot-detail page นี้ + modal ในหน้า /bots.html
 *   - OPEN_TRADE_STATES ยังคงอยู่ที่นี่เพราะใช้เฉพาะ bot-detail
 */
const OPEN_TRADE_STATES = ['placed', 'filled', 'holding', 'selling', 'retrying'];

function renderPositions() {
  const desk = document.getElementById('positions-list');
  const mob  = document.getElementById('positions-mob');
  const meta = document.getElementById('positions-price-meta');
  if (!desk) return;

  const isDcaBot = detail.bot && detail.bot.dcaEnabled === true;
  const allTrades = detail.trades || [];

  // FIX-2026-08-02: DCA mode — render stack card for the open DCA stack (single-stack mode)
  //   Non-DCA bots fall through to existing per-trade PositionCard rendering (no change).
  if (isDcaBot && window.StackCard) {
    const openStack = allTrades.find((t) => t.isDcaStack === true
      && StackCard.OPEN_DCA_STATES.includes(t.state));
    document.getElementById('positions-count-label').textContent = openStack ? '1 stack' : '0 stack';
    document.getElementById('tab-positions-badge').textContent = openStack ? 1 : 0;

    if (meta) {
      if (currentPrice && currentPrice > 0) {
        meta.textContent = `ราคา: ${PriceFormat.format(currentPrice, detail.bot.symbol)}`;
      } else {
        meta.textContent = 'รอข้อมูลราคา…';
      }
    }

    if (!openStack) {
      desk.innerHTML = `<div class="empty-positions">ไม่มี DCA stack ที่เปิดอยู่ — เมื่อ S1 signal มา layer แรกจะเปิด stack ทันที จากนั้น layer ถัดไปจะถูกเพิ่มเข้า stack เดิมจนถึง ${detail.bot.dcaMaxLayers || 3} layers</div>`;
      if (mob) mob.innerHTML = '';
      return;
    }

    const stackOpts = {
      maxLayers: detail.bot.dcaMaxLayers || 3,
      forceCloseBtnClass: 'btn-force-close',
    };
    desk.innerHTML = window.StackCard.renderCard(openStack, currentPrice, stackOpts);
    if (mob) mob.innerHTML = window.StackCard.renderCardMobile(openStack, currentPrice, stackOpts);
    return;
  }

  const open = allTrades.filter((t) => OPEN_TRADE_STATES.includes(t.state));
  document.getElementById('positions-count-label').textContent = `${open.length} ไม้`;
  document.getElementById('tab-positions-badge').textContent = open.length;

  if (meta) {
    if (currentPrice && currentPrice > 0) {
      meta.textContent = `ราคา: ${PriceFormat.format(currentPrice, detail.bot.symbol)}`;
    } else {
      meta.textContent = 'รอข้อมูลราคา…';
    }
  }

  if (open.length === 0) {
    desk.innerHTML = `<div class="empty-positions">ไม่มี position ที่เปิดอยู่ตอนนี้ — เมื่อ BUY fill แล้วจะปรากฏที่นี่ทันที พร้อม % PnL, % to TP และอายุแบบ realtime</div>`;
    if (mob) mob.innerHTML = '';
    return;
  }

  // sort by createdAt desc (newest first)
  open.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // 2026-07-30: ใช้ shared partial (positionCard.js) — markup เหมือนกันกับ modal ในหน้า /bots.html
  //   - showRetry: false  → ไม่โชว์ retry pill (สำหรับ single bot ไม่ต้องการ)
  //   - forceCloseBtnClass: 'btn-force-close' → ใช้กับ handler เดิมใน onPositionListClick
  //   - ไม่ใส่ botName / botLink (อยู่ในหน้าบอทนี้อยู่แล้ว)
  const cardOpts = { showRetry: false, forceCloseBtnClass: 'btn-force-close' };
  desk.innerHTML = open.map((t) => window.PositionCard.renderCard(t, currentPrice, cardOpts)).join('');
  if (mob) mob.innerHTML = open.map((t) => window.PositionCard.renderCardMobile(t, currentPrice, cardOpts)).join('');
}

/* ── Config grids ─────────────────────────────────────── */
function renderCfgGrid(id) {
  const b = detail.bot;
  const cells = [
    { k: 'Symbol',         v: b.symbol },
    { k: 'Timeframe',      v: b.timeframe },
    { k: 'ทุน/ไม้',         v: `${b.capitalPerTrade} USDT` },
    { k: 'จำนวนไม้',         v: `${b.maxTrades}` },
    { k: 'ทุนรวม (virtual)', v: `${(b.capitalPerTrade * b.maxTrades).toFixed(2)} USDT` },
    { k: 'TP %',            v: `${b.tpPercent}%` },
    { k: 'Retry time',      v: `${formatRetryTime(b.retryTimeMin)}` },
    { k: 'Retry max',       v: `${b.retryMax ?? 1} ครั้ง` },
    { k: 'KC Mult', v: `${b.kcMult ?? 1.5} (${(b.kcMult ?? 1.5) < 1.5 ? 'KC แคบ — sensitive' : (b.kcMult ?? 1.5) > 1.5 ? 'KC กว้าง — conservative' : 'ค่าเดิม'})` },
    { k: 'Stop Loss (upper-KC)', v: b.stopLossOnUpperKC ? '🛑 เปิด — ปิด position ขาดทุนเมื่อราคาทะลุ upper-KC' : '⏸ ปิดอยู่' },
    { k: 'AUv2 (F1 v2)', v: b.auv2Enabled
        ? `🌊 เปิด — ขายเมื่ออายุ ≥ ${b.auv2MinAgeHours ?? 24}ชม. + loss ตื้นกว่า ${b.auv2LossMode === 'thb' ? `${b.auv2MaxLossThb ?? 200} THB` : `${b.auv2MaxLossPct ?? 5}%`} (hard cap ${b.auv2MaxWaitDays ?? 7} วัน)`
        : '⏸ ปิดอยู่' },
    { k: 'Auto-update TP%', v: b.autoUpdateTp
        ? `⏰ เปิด — recompute ทุกต้นชั่วโมง${b.updateTpAt ? ` (ล่าสุด: ${fmtDateTime(b.updateTpAt)})` : ''}`
        : '⏸ ปิดอยู่' },
    { k: 'Enabled',         v: b.enabled ? '✅ เปิดใช้งาน' : '⏸ ปิดอยู่' },
    { k: 'Last Signal',     v: b.lastSignalAt ? fmtDateTime(b.lastSignalAt) : '-' },
  ];
  document.getElementById(id).innerHTML = cells.map((c) => `
    <div class="detail-cell">
      <div class="k">${c.k}</div>
      <div class="v">${escapeHtml(String(c.v))}</div>
    </div>`).join('');
}
function renderCfgExtra() {
  const b = detail.bot;
  const errHtml = b.lastError
    ? `<div class="alert alert-danger mt-3"><strong>Last Error:</strong><br><span class="text-mono" style="font-size:0.82rem;">${escapeHtml(b.lastError)}</span></div>`
    : '';
  document.getElementById('cfg-extra').innerHTML = errHtml;
}

/* ── Trades ───────────────────────────────────────────── */
function renderTrades() {
  const tbody = document.getElementById('trades-tbody');
  const mob = document.getElementById('trades-mob');
  const count = detail.trades.length;
  document.getElementById('trades-count-label').textContent = `${count} รายการ`;
  document.getElementById('tab-trades-badge').textContent = count;

  if (count === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty">ยังไม่มี trades</td></tr>';
    mob.innerHTML = '<div class="text-muted-3 text-center py-4">ยังไม่มี trades</div>';
    return;
  }
  tbody.innerHTML = detail.trades.map((t) => {
    const sc = STATE_COLORS[t.state] || '';
    const pnl = t.realizedPnl;
    const pnlCls = pnl == null ? '' : (pnl >= 0 ? 'pnl-bull' : 'pnl-bear');
    const pnlTxt = pnl != null ? `${pnl.toFixed(4)} (${(t.pnlPercent || 0).toFixed(2)}%)` : '-';
    return `
      <tr>
        <td><span class="ts">${escapeHtml(fmtDateTime(t.createdAt))}</span></td>
        <td><span class="status-pill is-${escapeHtml(sc)}">${escapeHtml(t.state)}</span></td>
        <td>${t.buyPrice != null ? `BUY ${PriceFormat.format(t.buyPrice, t.symbol)}` : '-'}${t.sellPrice != null ? ` → SELL ${PriceFormat.format(t.sellPrice, t.symbol)}` : ''}</td>
        <td class="num">${t.buyPrice != null ? PriceFormat.format(t.buyPrice, t.symbol) : '-'}</td>
        <td class="num">${t.buyQty != null ? Number(t.buyQty).toFixed(6) : '-'}</td>
        <td style="font-size:0.75rem;">${escapeHtml(t.buyStatus) || ''}${t.sellStatus ? ` → ${escapeHtml(t.sellStatus)}` : ''}</td>
        <td class="num">${Number(t.retryCount ?? 0)}</td>
        <td class="num">${t.sellPrice != null ? PriceFormat.format(t.sellPrice, t.symbol) : '-'}</td>
        <td class="num ${pnlCls}">${pnlTxt}</td>
        <td>${SellReasons.renderSellReasonPill(t.sellReason, t.sellReasonDetail)}</td>
        <td><span class="code">${escapeHtml(t.buyOrderId) || '-'}</span></td>
      </tr>`;
  }).join('');

  mob.innerHTML = detail.trades.map((t) => {
    const sc = STATE_COLORS[t.state] || '';
    const pnl = t.realizedPnl;
    const pnlCls = pnl == null ? '' : (pnl >= 0 ? 'pnl-bull' : 'pnl-bear');
    const pnlTxt = pnl != null ? `${pnl.toFixed(4)} (${(t.pnlPercent || 0).toFixed(2)}%)` : '-';
    return `
      <div class="mob-card">
        <div class="top">
          <span class="status-pill is-${sc}">${t.state}</span>
          <span class="ts" style="color:var(--text-3);font-size:0.72rem;">${fmtDateTime(t.createdAt)}</span>
        </div>
        <div class="row"><span class="k">Side</span><span class="v">${t.buyPrice ? `BUY ${PriceFormat.format(t.buyPrice, t.symbol)}` : '-'}${t.sellPrice ? ` → SELL ${PriceFormat.format(t.sellPrice, t.symbol)}` : ''}</span></div>
        <div class="row"><span class="k">Qty</span><span class="v">${t.buyQty?.toFixed(6) ?? '-'}</span></div>
        <div class="row"><span class="k">Status</span><span class="v" style="font-size:0.75rem;">${t.buyStatus || ''}${t.sellStatus ? ` → ${t.sellStatus}` : ''}</span></div>
        <div class="row"><span class="k">Retry</span><span class="v">${t.retryCount ?? 0}</span></div>
        <div class="row"><span class="k">PnL</span><span class="v ${pnlCls}">${pnlTxt}</span></div>
        <div class="row"><span class="k">Reason</span><span class="v">${SellReasons.renderSellReasonPill(t.sellReason, t.sellReasonDetail)}</span></div>
      </div>`;
  }).join('');
}

/* ── Signals ──────────────────────────────────────────── */
// FIX-2026-09-05: enrich outcome text for UI clarity (mirrors chart-monitor.js).
//   - DB 'detected' rows are TRANSIENT (save ตอนเจอ S1 ก่อน gate chain)
//   - ถ้าเก่าเกิน threshold = stuck → แสดง '⚠️ stuck — gate ไม่อัปเดต'
//   - threshold = max(5min, 2× timeframe)
function _enrichSignalOutcome(s) {
  if (!s) return s;
  if (s.outcome !== 'detected') return s;
  const tf = s.timeframe || '3m';
  const m = String(tf).match(/^(\d+)([mhd])$/);
  let tfMs = 60_000;
  if (m) {
    const n = parseInt(m[1], 10);
    tfMs = n * (m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000);
  }
  const staleMs = Math.max(5 * 60_000, 2 * tfMs);
  const created = s.createdAt ? new Date(s.createdAt).getTime() : 0;
  if (created && Date.now() - created > staleMs) {
    // shallow clone to avoid mutating source
    return Object.assign({}, s, {
      _enrichedOutcome: 'stale_detected',
      _enrichedLabel: '⚠️ stuck — gate ไม่อัปเดต',
    });
  }
  return Object.assign({}, s, {
    _enrichedOutcome: 'detected',
    _enrichedLabel: '⏳ กำลังประมวลผล',
  });
}

function renderSignals() {
  const tbody = document.getElementById('signals-tbody');
  const mob = document.getElementById('signals-mob');
  const count = detail.signals.length;
  document.getElementById('signals-count-label').textContent = `${count} รายการ`;
  document.getElementById('tab-signals-badge').textContent = count;

  if (count === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">ยังไม่มี signals</td></tr>';
    mob.innerHTML = '<div class="text-muted-3 text-center py-4">ยังไม่มี signals</div>';
    return;
  }

  tbody.innerHTML = detail.signals.map((rawS) => {
    const s = _enrichSignalOutcome(rawS);
    const oc = OUTCOME_CLASS[s._enrichedOutcome] || OUTCOME_CLASS[s.outcome] || '';
    const label = s._enrichedLabel || s.outcome;
    const dir = (s.bgPrev === 2 && (s.bgState === 1 || s.bgState === 3))
      ? (s.bgState === 1 ? 'bull' : 'bear')
      : 'neutral';
    // FIX-2026-09-05: tooltip อธิบายเมื่อ outcome เป็น stale_detected
    const staleTitle = s._enrichedOutcome === 'stale_detected'
      ? 'outcome: detected (stale)\n— candle close เกิน max(5min, 2×TF) แล้ว แต่ outcome ยังไม่เปลี่ยน\n— trader crash / gate exception ระหว่าง pm2 reload'
      : '';
    return `
      <tr>
        <td><span class="ts">${fmtDateTime(s.createdAt)}</span></td>
        <td><span class="status-pill is-${dir === 'bull' ? 'success' : dir === 'bear' ? 'failed' : 'idle'}">${s.type}</span></td>
        <td class="num">${s.closePrice != null ? PriceFormat.format(s.closePrice, s.symbol) : '-'}</td>
        <td style="font-size:0.78rem;">${s.bgPrev} → ${s.bgState}</td>
        <td class="num">${s.upperKC != null ? PriceFormat.format(s.upperKC, s.symbol) : '-'}</td>
        <td class="num">${s.lowerKC != null ? PriceFormat.format(s.lowerKC, s.symbol) : '-'}</td>
        <td><span class="status-pill is-${oc}"${staleTitle ? ` title="${escapeHtml(staleTitle)}"` : ''}>${escapeHtml(label)}</span></td>
        <td style="font-size:0.75rem;color:var(--text-3);">${escapeHtml(s.note || '')}</td>
      </tr>`;
  }).join('');

  mob.innerHTML = detail.signals.map((rawS) => {
    const s = _enrichSignalOutcome(rawS);
    const oc = OUTCOME_CLASS[s._enrichedOutcome] || OUTCOME_CLASS[s.outcome] || '';
    const label = s._enrichedLabel || s.outcome;
    const dir = (s.bgPrev === 2 && (s.bgState === 1 || s.bgState === 3))
      ? (s.bgState === 1 ? 'bull' : 'bear')
      : 'neutral';
    return `
      <div class="mob-card">
        <div class="top">
          <span class="status-pill is-${dir === 'bull' ? 'success' : dir === 'bear' ? 'failed' : 'idle'}">${s.type}</span>
          <span class="ts" style="color:var(--text-3);font-size:0.72rem;">${fmtDateTime(s.createdAt)}</span>
        </div>
        <div class="row"><span class="k">Close</span><span class="v">${s.closePrice != null ? PriceFormat.format(s.closePrice, s.symbol) : '-'}</span></div>
        <div class="row"><span class="k">BG</span><span class="v">${s.bgPrev} → ${s.bgState}</span></div>
        <div class="row"><span class="k">KC range</span><span class="v">${s.lowerKC != null ? PriceFormat.format(s.lowerKC, s.symbol) : '-'} → ${s.upperKC != null ? PriceFormat.format(s.upperKC, s.symbol) : '-'}</span></div>
        <div class="row"><span class="k">Outcome</span><span class="v"><span class="status-pill is-${oc}">${escapeHtml(label)}</span></span></div>
        ${s.note ? `<div class="row"><span class="k">Note</span><span class="v" style="font-size:0.72rem;color:var(--text-3);">${escapeHtml(s.note)}</span></div>` : ''}
      </div>`;
  }).join('');
}

function renderRecentSignals() {
  const container = document.getElementById('recent-signals');
  const recent = (detail.signals || []).slice(0, 5);
  if (recent.length === 0) {
    container.innerHTML = '<div class="text-muted-3 text-center py-4">ยังไม่มี signals</div>';
    return;
  }
  container.innerHTML = recent.map((rawS) => {
    const s = _enrichSignalOutcome(rawS);
    const oc = OUTCOME_CLASS[s._enrichedOutcome] || OUTCOME_CLASS[s.outcome] || '';
    const label = s._enrichedLabel || s.outcome;
    const dir = (s.bgPrev === 2 && (s.bgState === 1 || s.bgState === 3))
      ? (s.bgState === 1 ? 'bull' : 'bear')
      : 'neutral';
    return `
      <div class="signal-row">
        <span class="type-dot ${dir}"></span>
        <span class="ts">${fmtDateTime(s.createdAt)}</span>
        <span class="price">${s.closePrice != null ? PriceFormat.format(s.closePrice, s.symbol) : '-'}</span>
        <span class="bg">bg ${s.bgPrev}→${s.bgState}</span>
        <span class="outcome"><span class="status-pill is-${oc}">${escapeHtml(label)}</span></span>
        ${s.note ? `<span class="note">${escapeHtml(s.note)}</span>` : ''}
      </div>`;
  }).join('');
}

/* ── Sparkline (kept as fallback / decoration) ───────── */
function buildPnlSeries() {
  const closed = (detail.trades || [])
    .filter((t) => t.realizedPnl != null)
    .reverse(); // oldest first
  if (closed.length === 0) return [0];
  let cum = 0;
  const series = [0];
  for (const t of closed.slice(-20)) {
    cum += t.realizedPnl;
    series.push(cum);
  }
  return series;
}

function drawSpark(targetId, series, kind) {
  // No-op — PnL now rendered via proper area chart below
  const el = document.getElementById(targetId);
  if (el) el.innerHTML = '';
}

/* ── Charts (lightweight-charts) ──────────────────────── */
let lastKline = null;

// FIX-2026-07-31: ใช้ Binance tickSize precision (authoritative) — fallback heuristic
//   ZILUSDT tickSize = 0.000001 → 6 ตำแหน่ง (ตรงกับ Binance UI)
//   detail.bot.symbol คือ symbol ของบอทปัจจุบัน
function chartPriceFormatter(price) {
  if (price === null || price === undefined || !Number.isFinite(price)) return '';
  const symbol = detail && detail.bot ? detail.bot.symbol : null;
  if (window.PriceFormat) return window.PriceFormat.format(price, symbol);
  // fallback heuristic (เดิม)
  const abs = Math.abs(price);
  if (abs >= 1000) return price.toFixed(2);
  if (abs >= 1) return price.toFixed(4);
  if (abs >= 0.01) return price.toFixed(4);
  if (abs >= 0.0001) return price.toFixed(5);
  return price.toFixed(6);
}

function chartBaseOptions(width, height) {
  return {
    width,
    height,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#94a3b8',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.04)' },
      horzLines: { color: 'rgba(255,255,255,0.04)' },
    },
    rightPriceScale: {
      borderColor: 'rgba(255,255,255,0.06)',
      scaleMargins: { top: 0.08, bottom: 0.08 },
    },
    timeScale: {
      borderColor: 'rgba(255,255,255,0.06)',
      timeVisible: true,
      secondsVisible: false,
      // FIX-2026-07-22: TradingView-like timeline
      rightOffset: 12,
      shiftVisibleRangeOnNewBar: true,
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: false },
    },
    crosshair: {
      vertLine: { color: 'rgba(245,184,0,0.4)', width: 1, style: 3, labelBackgroundColor: '#f5b800' },
      horzLine: { color: 'rgba(245,184,0,0.4)', width: 1, style: 3, labelBackgroundColor: '#f5b800' },
    },
    // FIX-2026-07-22: adaptive decimal places on price axis (เหรียญราคาต่ำเห็นรายละเอียดชัด)
    localization: {
      priceFormatter: chartPriceFormatter,
    },
  };
}

function setupCharts() {
  const pc = document.getElementById('price-chart');
  const pnlEl = document.getElementById('pnl-chart');
  if (!pc || !pnlEl || typeof LightweightCharts === 'undefined') return;

  // Price chart
  priceChart = LightweightCharts.createChart(pc, chartBaseOptions(pc.clientWidth, 340));
  candleSeries = priceChart.addCandlestickSeries({
    upColor: '#00e5b8', downColor: '#ff4d6d',
    borderUpColor: '#00e5b8', borderDownColor: '#ff4d6d',
    wickUpColor: '#00e5b8', wickDownColor: '#ff4d6d',
  });
  // EMA (Keltner basis) — gold
  basisSeries = priceChart.addLineSeries({
    color: '#f5b800',
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  // Upper Keltner Channel — orange
  upperSeries = priceChart.addLineSeries({
    color: '#ff7849',
    lineWidth: 1,
    lineStyle: 2, // dashed
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  // Lower Keltner Channel — violet
  lowerSeries = priceChart.addLineSeries({
    color: '#a78bfa',
    lineWidth: 1,
    lineStyle: 2, // dashed
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  // PnL chart
  pnlChart = LightweightCharts.createChart(pnlEl, chartBaseOptions(pnlEl.clientWidth, 180));
  pnlSeries = pnlChart.addAreaSeries({
    topColor: 'rgba(0,229,184,0.45)',
    bottomColor: 'rgba(0,229,184,0.04)',
    lineColor: '#00e5b8',
    lineWidth: 2,
    priceLineVisible: false,
  });
  pnlMarkers = pnlChart.addLineSeries({ color: 'rgba(245,184,0,0.0)', lineWidth: 0 });
  // baseline ที่ 0
  pnlSeries.applyOptions({ baseValue: { type: 'price', price: 0 } });
  // price line ที่ 0
  pnlChart.applyOptions({
    timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false },
  });

  // resize handling
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const w = Math.floor(e.contentRect.width);
      if (e.target === pc) priceChart && priceChart.applyOptions({ width: w });
      if (e.target === pnlEl) pnlChart && pnlChart.applyOptions({ width: w });
    }
  });
  ro.observe(pc);
  ro.observe(pnlEl);
}

// ─── Bar countdown (TradingView-style — เวลาที่เหลือก่อนแท่งปัจจุบันปิด) ──
let _countdownTimer = null;

function tfToMs(tf) {
  // รองรับ "1m" "3m" "15m" "1h" "4h" "1d" → milliseconds
  const m = String(tf || '').match(/^(\d+)([mhd])$/);
  if (!m) return 60_000;
  const n = parseInt(m[1], 10);
  if (m[2] === 'm') return n * 60_000;
  if (m[2] === 'h') return n * 3_600_000;
  return n * 86_400_000;
}

function startBarCountdown() {
  stopBarCountdown();
  const wrap = document.getElementById('bar-countdown');
  const fill = document.getElementById('bar-countdown-fill');
  const text = document.getElementById('bar-countdown-text');
  if (!wrap || !fill || !text) return;
  if (!detail || !detail.bot || !_chartKlines.length) return;

  wrap.hidden = false;
  const tf = detail.bot.timeframe;
  const durationMs = tfToMs(tf);

  const update = () => {
    const last = _chartKlines[_chartKlines.length - 1];
    if (!last || !last.openTime) return;
    const closeTime = last.openTime + durationMs;
    const remainingMs = Math.max(0, closeTime - Date.now());
    const elapsedMs = durationMs - remainingMs;
    const progress = Math.max(0, Math.min(1, elapsedMs / durationMs));

    fill.style.width = `${(progress * 100).toFixed(2)}%`;
    const remSec = Math.ceil(remainingMs / 1000);
    const mm = Math.floor(remSec / 60);
    const ss = remSec % 60;
    text.textContent = `⏱ เหลือ ${mm}:${String(ss).padStart(2, '0')} · ${tf}`;

    // เมื่อแท่งปิด → รอให้แท่งใหม่เข้ามาแล้วนับต่อ
    if (remainingMs <= 0) {
      stopBarCountdown();
      setTimeout(() => { renderPriceChart().then(startBarCountdown); }, 1500);
    }
  };

  update();
  _countdownTimer = setInterval(update, 1000);
}

function stopBarCountdown() {
  if (_countdownTimer) {
    clearInterval(_countdownTimer);
    _countdownTimer = null;
  }
}

// ─── Price chart state ──────────────────────────────────────────────
let _chartKlines = [];              // current visible klines (raw, with openTime ms)
let _chartBasis = [];               // parallel to _chartKlines, values or null
let _chartUpper = [];
let _chartLower = [];
let _chartSignals = [];             // parallel S1 markers array, length <= _chartKlines.length
// Track earliest openTime (ms) so "Load older" knows where to query from
let _chartEarliestOpenTime = null;

async function renderPriceChart() {
  if (!priceChart || !detail || !detail.bot) return;
  const { symbol, timeframe } = detail.bot;
  const loading = document.getElementById('price-chart-loading');
  try {
    // FIX-2026-07-24: pass per-bot kcMult + s1OnlyDown (default 1.5, false)
    const kcMult = detail.bot.kcMult ?? 1.5;
    const s1OnlyDown = detail.bot.s1OnlyDown ? 'true' : 'false';
    const resp = await API.get(`/api/chart/klines?symbol=${symbol}&timeframe=${timeframe}&limit=150&kcMult=${kcMult}&s1OnlyDown=${s1OnlyDown}`);
    if (!resp.klines || resp.klines.length === 0) {
      if (loading) loading.textContent = 'ไม่มีข้อมูลแท่งเทียน';
      return;
    }
    _chartKlines = resp.klines;
    // เก็บ keltner เป็น array parallel กับ klines (index i คือ i-th candle) — เพื่อ prepend ได้ง่าย
    _chartBasis = (resp.keltner && resp.keltner.basis) || [];
    _chartUpper = (resp.keltner && resp.keltner.upper) || [];
    _chartLower = (resp.keltner && resp.keltner.lower) || [];
    _chartSignals = resp.signals || [];
    _chartEarliestOpenTime = _chartKlines[0].openTime;
    _drawPriceChart({ fit: true });
    // FIX-2026-07-22: เริ่มนับถอยหลังของแท่งปัจจุบัน (TradingView-style)
    startBarCountdown();
    // Initial: assume older data exists, enable button
    const btn = document.getElementById('btn-load-older');
    if (btn) {
      btn.disabled = false;
      btn.dataset.loading = '0';
    }
    if (loading) loading.style.display = 'none';
  } catch (err) {
    console.error('renderPriceChart', err);
    if (loading) loading.textContent = `❌ ${err.message}`;
  }
}

/**
 * Render current _chartKlines (and parallel keltner arrays) to the chart series.
 * @param {{fit?: boolean}} opts — if fit=true, fitContent after re-render (only on first load)
 */
function _drawPriceChart({ fit = false } = {}) {
  if (!priceChart) return;
  const candleData = _chartKlines.map((k) => ({
    time: Math.floor(k.openTime / 1000),
    open: parseFloat(k.open),
    high: parseFloat(k.high),
    low: parseFloat(k.low),
    close: parseFloat(k.close),
  }));
  lastKline = candleData[candleData.length - 1];
  // seed currentPrice for Positions tab
  const lastPx = parseFloat(lastKline && lastKline.close);
  if (!isNaN(lastPx) && lastPx > 0) currentPrice = lastPx;

  // สร้าง series data จาก parallel arrays (length = _chartKlines.length)
  const basis = [];
  const upper = [];
  const lower = [];
  for (let i = 0; i < _chartKlines.length; i += 1) {
    const t = Math.floor(_chartKlines[i].openTime / 1000);
    if (_chartBasis[i] != null) basis.push({ time: t, value: _chartBasis[i] });
    if (_chartUpper[i] != null) upper.push({ time: t, value: _chartUpper[i] });
    if (_chartLower[i] != null) lower.push({ time: t, value: _chartLower[i] });
  }

  candleSeries.setData(candleData);
  basisSeries.setData(basis);
  upperSeries.setData(upper);
  lowerSeries.setData(lower);

  // signal markers (S1)
  const sigMarkers = (_chartSignals || []).map((s) => ({
    time: Math.floor(s.openTime / 1000),
    position: 'belowBar',
    color: '#3b82f6',
    shape: 'arrowUp',
    text: 'S1',
  }));

  // overlays: historical BUY/SELL markers from detail.trades
  const overlayMarkers = [];
  const firstCandleT = candleData[0].time;
  const lastCandleT = candleData[candleData.length - 1].time;
  const findCandleIdx = (epochSec) => {
    if (epochSec < firstCandleT || epochSec > lastCandleT) return -1;
    return candleData.findIndex((c) => c.time >= epochSec);
  };

  for (const t of detail.trades || []) {
    const buyAt = t.buyFilledAt || t.buyPlacedAt;
    if (buyAt) {
      const buyT = Math.floor(new Date(buyAt).getTime() / 1000);
      const idx = findCandleIdx(buyT);
      if (idx >= 0) {
        overlayMarkers.push({
          time: candleData[idx].time,
          position: 'inBar',
          color: '#f5b800',                 // gold — แยกจาก S1 (blue) และ SELL-win (green)
          shape: 'arrowUp',
          text: t.buyPrice != null ? `B ${PriceFormat.format(t.buyPrice, t.symbol)}` : 'B',
        });
      }
    }

    if (t.realizedPnl != null) {
      const sellAt = t.sellFilledAt || t.sellPlacedAt;
      if (sellAt) {
        const sellT = Math.floor(new Date(sellAt).getTime() / 1000);
        const idx = findCandleIdx(sellT);
        if (idx >= 0) {
          const win = t.realizedPnl >= 0;
          overlayMarkers.push({
            time: candleData[idx].time,
            position: 'aboveBar',
            color: win ? '#00e5b8' : '#ff4d6d',
            shape: 'arrowDown',             // ลูกศรลง = "ออกจาก position"
            text: `S ${win ? '+' : ''}${t.realizedPnl.toFixed(2)}`,
          });
        }
      }
    }
  }
  candleSeries.setMarkers([...sigMarkers, ...overlayMarkers]);

  // Update header counter
  const cnt = document.getElementById('chart-candles-count');
  if (cnt) cnt.textContent = candleData.length.toLocaleString();

  if (fit) priceChart.timeScale().fitContent();
}

/**
 * Fetch 300 older candles, prepend to existing data, re-render.
 * Preserves user's current visible time range.
 */
async function loadOlderCandles() {
  if (!priceChart || !detail || !detail.bot) return;
  const { symbol, timeframe } = detail.bot;
  const btn = document.getElementById('btn-load-older');
  if (!btn || btn.disabled || btn.dataset.loading === '1') return;
  if (_chartEarliestOpenTime == null) return;

  btn.dataset.loading = '1';
  const originalLabel = btn.innerHTML;
  btn.innerHTML = '⏳ กำลังโหลด…';
  btn.disabled = true;

  // Capture visible range BEFORE prepend so we can restore it after
  let savedRange = null;
  try {
    savedRange = priceChart.timeScale().getVisibleLogicalRange();
  } catch (e) { /* chart may not be ready */ }

  try {
    // ขอแท่งที่เก่ากว่า open time ของ candle แรก
    const kcMult = detail.bot.kcMult ?? 1.5;
    const s1OnlyDown = detail.bot.s1OnlyDown ? 'true' : 'false';
    const resp = await API.get(
      `/api/chart/klines?symbol=${symbol}&timeframe=${timeframe}&limit=300&kcMult=${kcMult}&s1OnlyDown=${s1OnlyDown}&endTime=${_chartEarliestOpenTime}`
    );
    if (!resp.klines || resp.klines.length === 0) {
      btn.innerHTML = '🚫 หมดประวัติแล้ว';
      btn.disabled = true;
      return;
    }

    // Deduplicate by openTime (Binance sometimes returns overlap if endTime exactly equals an openTime)
    const existingTs = new Set(_chartKlines.map((k) => k.openTime));
    const olderOnly = resp.klines.filter((k) => !existingTs.has(k.openTime));

    if (olderOnly.length === 0) {
      btn.innerHTML = '🚫 หมดประวัติแล้ว';
      btn.disabled = true;
      return;
    }

    // ──── Align keltner/signals to the response's klines (parallel arrays) ────
    // resp.keltner.basis/upper/lower are parallel to resp.klines ตามลำดับ
    // เราจะ slice ส่วนที่ตรงกับ olderOnly แล้ว prepend
    const respKlines = resp.klines;
    const basisArr = (resp.keltner && resp.keltner.basis) || [];
    const upperArr = (resp.keltner && resp.keltner.upper) || [];
    const lowerArr = (resp.keltner && resp.keltner.lower) || [];
    const sigArr = resp.signals || [];

    // Map: openTime → index in respKlines เพื่อ slice keltner ตามด้วย
    const respIdxByOpenTime = new Map(respKlines.map((k, i) => [k.openTime, i]));

    const olderBasis = [];
    const olderUpper = [];
    const olderLower = [];
    for (const k of olderOnly) {
      const idx = respIdxByOpenTime.get(k.openTime);
      if (idx != null) {
        olderBasis[idx] != null ? olderBasis.push(basisArr[idx]) : olderBasis.push(null);
        olderUpper[idx] != null ? olderUpper.push(upperArr[idx]) : olderUpper.push(null);
        olderLower[idx] != null ? olderLower.push(lowerArr[idx]) : olderLower.push(null);
      } else {
        olderBasis.push(null);
        olderUpper.push(null);
        olderLower.push(null);
      }
    }
    // S1 signals: filter เฉพาะที่อยู่ใน olderOnly slice
    const olderTsSet = new Set(olderOnly.map((k) => k.openTime));
    const olderSignals = sigArr.filter((s) => olderTsSet.has(s.openTime));

    // Prepend (olderOnly + olderBasis/Upper/Lower/Signals + existing arrays)
    _chartKlines = olderOnly.concat(_chartKlines);
    _chartBasis = olderBasis.concat(_chartBasis);
    _chartUpper = olderUpper.concat(_chartUpper);
    _chartLower = olderLower.concat(_chartLower);
    _chartSignals = olderSignals.concat(_chartSignals);
    _chartEarliestOpenTime = _chartKlines[0].openTime;

    _drawPriceChart({ fit: false });

    // FIX-2026-07-22: รีสตาร์ท countdown หลัง load older (openTime ของแท่งสุดท้ายอาจเปลี่ยน)
    startBarCountdown();

    // Restore visible range — shift by number of candles added so user's view stays put
    if (savedRange) {
      const added = olderOnly.length;
      try {
        priceChart.timeScale().setVisibleLogicalRange({
          from: savedRange.from + added,
          to: savedRange.to + added,
        });
      } catch (e) { /* ignore — chart may auto-fit if range invalid */ }
    }

    // Disable button if Binance returned fewer than 300 (end of available history)
    if (resp.klines.length < 300) {
      btn.innerHTML = '🚫 หมดประวัติแล้ว';
      btn.disabled = true;
    } else {
      btn.innerHTML = originalLabel;
      btn.disabled = false;
    }
  } catch (err) {
    console.error('loadOlderCandles', err);
    btn.innerHTML = `❌ ${err.message}`.slice(0, 60);
    btn.disabled = false;
  } finally {
    btn.dataset.loading = '0';
  }
}

function renderPnlChart() {
  if (!pnlChart || !detail) return;
  const closed = (detail.trades || [])
    .filter((t) => t.realizedPnl != null && (t.sellFilledAt || t.createdAt));
  const meta = document.getElementById('pnl-chart-meta');
  const loading = document.getElementById('pnl-chart-loading');

  if (closed.length === 0) {
    pnlSeries.setData([]);
    if (meta) meta.textContent = '0 ไม้ปิด';
    if (loading) loading.style.display = '';
    return;
  }
  if (loading) loading.style.display = 'none';

  // sort ascending by close time
  closed.sort((a, b) => new Date(a.sellFilledAt || a.createdAt) - new Date(b.sellFilledAt || b.createdAt));

  let cum = 0;
  const pts = [];
  for (const t of closed) {
    cum += t.realizedPnl;
    const tms = new Date(t.sellFilledAt || t.createdAt).getTime();
    pts.push({ time: Math.floor(tms / 1000), value: parseFloat(cum.toFixed(4)) });
  }
  // ensure strictly increasing times
  const dedup = [];
  for (const p of pts) {
    if (dedup.length === 0 || dedup[dedup.length - 1].time < p.time) dedup.push(p);
    else dedup[dedup.length - 1] = p;
  }
  if (dedup.length === 0) return;

  // color = pick based on final value
  const final = dedup[dedup.length - 1].value;
  const bull = final >= 0;
  pnlSeries.applyOptions({
    topColor: bull ? 'rgba(0,229,184,0.45)' : 'rgba(255,77,109,0.45)',
    bottomColor: bull ? 'rgba(0,229,184,0.04)' : 'rgba(255,77,109,0.04)',
    lineColor: bull ? '#00e5b8' : '#ff4d6d',
  });
  pnlSeries.setData(dedup);

  // baseline price line ที่ 0
  try { pnlSeries.createPriceLine({ price: 0, color: 'rgba(255,255,255,0.18)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'break-even' }); } catch (_) {}

  if (meta) {
    meta.innerHTML = `${closed.length} ไม้ปิด · <span class="${bull ? 'pnl-bull' : 'pnl-bear'}">${final >= 0 ? '+' : ''}${final.toFixed(4)} USDT</span>`;
  }

  pnlChart.timeScale().fitContent();
}

/* ── Helpers ──────────────────────────────────────────── */
function formatUsdt(v) {
  if (v == null || isNaN(v)) return '0.00';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 100) return `${sign}${abs.toFixed(2)}`;
  if (abs >= 1) return `${sign}${abs.toFixed(3)}`;
  return `${sign}${abs.toFixed(4)}`;
}
// ─── Timezone helpers (force Asia/Bangkok +07:00) ──────
const TZ = 'Asia/Bangkok';
const _dttmFmt = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const _dtFmt    = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const _tmFmt    = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function fmtDateTime(d) { return d ? _dttmFmt.format(new Date(d)) : '-'; }
function fmtDate(d)     { return d ? _dtFmt.format(new Date(d))    : '-'; }
function fmtTime(d)     { return d ? _tmFmt.format(new Date(d))    : '-'; }
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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

init();