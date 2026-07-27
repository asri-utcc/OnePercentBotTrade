'use strict';

// luxConfirm / luxAlert / bindPasswordToggles / callBotWithPassword used to be
// defined here. They now live in public/js/luxConfirm.js (loaded before this
// script in both bots.html and bot-detail.html). Backwards-compat aliases were
// set on `window.*` inside that file, so this existing call-sites below
// continue to work without churn.

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

  // re-render once nav.js publishes the FX rate (so THB equivalents appear)
  document.addEventListener('fx:updated', () => {
    if (bots.length > 0) {
      renderBots();
      renderStats();
    }
  });
  // also re-render if FX was already cached by nav.js before this script ran
  if (window.__fxReady && bots.length > 0) {
    renderBots();
    renderStats();
  }

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
  });
  WSClient.on('health:update', (s) => renderHeartbeat(s));

  // FIX-2026-07-23: realtime EMA + price update จาก WS kline
  //   - ฟัง kline:update ทุกตัว → match กับ bot card → update tile in-place (ไม่ re-render ทั้ง card)
  WSClient.on('kline:update', (p) => {
    if (!p || !p.kline || !p.interval) return;
    const symbol = p.kline.symbol;
    const interval = p.interval;
    const close = parseFloat(p.kline.close);
    if (!Number.isFinite(close) || close <= 0) return;
    // หา bot ที่ตรงกัน — ใช้ data-symbol/data-timeframe attribute
    const cards = document.querySelectorAll(`.bot-card-v2[data-symbol="${symbol}"][data-timeframe="${interval}"]`);
    cards.forEach((card) => updateCardEma(card, close));
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

  ['nb-capital', 'nb-maxtrades'].forEach((id) => {
    document.getElementById(id).addEventListener('input', updateNewBotTotal);
  });

  document.getElementById('nb-create').onclick = createBot;
  document.getElementById('refresh-balance').onclick = loadBalance;
  document.getElementById('ak-save').onclick = saveApiKeys;
  document.getElementById('nb-tp-recommend').onclick = recommendNewBotTp;
}

/**
 * FIX-2026-07-23: "Get recommend TP%" button (create modal)
 *   - ใช้ symbol + timeframe ที่ user เลือกอยู่ใน modal
 *   - window = 500 bars
 *   - ใส่ suggestedTpPct ลงใน #nb-tp
 */
async function recommendNewBotTp() {
  const btn = document.getElementById('nb-tp-recommend');
  const hint = document.getElementById('nb-tp-hint');
  const symbol = document.getElementById('nb-symbol').value;
  const timeframe = document.getElementById('nb-timeframe').value;
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('is-loading');
  btn.innerHTML = '⏳';
  hint.innerHTML = '<span class="text-warning">กำลังคำนวณ Min %KC(500 bars) + EMA20 trend จาก Binance…</span>';
  try {
    const resp = await API.post('/api/bots/suggest-tp', { symbol, timeframe, window: 500 });
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

async function loadBots() {
  try {
    const resp = await API.get('/api/bots');
    bots = resp.bots;
    seedBotsEmaCache(bots); // FIX-2026-07-23: seed EMA cache for realtime updates
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
  // FIX-2026-07-24: cleanup เก่าก่อน — ป้องกัน memory leak จาก lightweight-charts instances ค้าง
  teardownMiniCharts();
  container.innerHTML = bots.map(renderBotCard).join('');
  // FIX-2026-07-24: วาด mini charts หลัง DOM พร้อม — เฉพาะบอทที่ enabled
  setupMiniCharts();
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
 *       .ema-above / .ema-below — tile color (green/red) สำหรับ price vs EMA
 */
function renderBotCard(b) {
  const statusBadge = statusPillHtml(b.status);
  const isRunning = !!b.enabled;
  const hasPosition = (b.activePositionsCount || 0) > 0;
  const hasError = !!b.lastError;

  // class flags for highlight
  const classes = ['bot-card-v2'];
  if (isRunning) classes.push('is-running'); else classes.push('is-disabled');
  if (hasPosition) classes.push('has-position');
  if (hasError) classes.push('has-error');

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
  const priceDigits = computePriceDigits(lastClose);
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

  return `
    <div class="${classes.join(' ')}" data-bot-id="${b._id}" data-symbol="${b.symbol}" data-timeframe="${b.timeframe}">
      <div class="bc-head">
        <div class="bc-head-left">
          <div class="bc-title">${escapeHtml(b.name || b.symbol)}</div>
          <div class="bc-meta">
            <span class="sym-tag">${b.symbol}</span>
            <span class="tf-tag">${b.timeframe}</span>
            ${statusBadge}
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
      </div>
      <div class="bc-stats">
        <span class="stat"><span class="lbl">TP</span><strong>${b.tpPercent}%</strong></span>
        <span class="stat"><span class="lbl">ทุน</span><strong>$${b.capitalPerTrade} × ${b.maxTrades} = $${b.totalCapital.toFixed(2)}</strong></span>
        <span class="stat"><span class="lbl">Retry</span><strong>${formatRetryTime(b.retryTimeMin)} × ${b.retryMax ?? 1}</strong></span>
        <span class="stat"><span class="lbl">⏱ Uptime</span><strong>${uptime}</strong></span>
        <span class="stat"><span class="lbl">🕒 Active</span><strong>${active}</strong></span>
        <span class="stat"><span class="lbl">PnL สะสม</span><strong class="${totalPnlClass}">${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} USDT${totalPnlThb ? ` <span class="thb-eq">${totalPnlThb}</span>` : ''}</strong></span>
        <span class="stat"><span class="lbl">Trades</span><strong>${b.totalTrades || 0} (W ${b.winTrades || 0})</strong></span>
      </div>
      ${b.lastError ? `<div class="bc-err"><span class="bc-err-msg">⚠️ ${escapeHtml(b.lastError)}</span><button class="bc-err-dismiss" type="button" title="ปิดการแจ้งเตือนนี้" aria-label="dismiss" onclick="dismissBotError('${b._id}', this)">×</button></div>` : ''}
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
 * จำนวนทศนิยมที่เหมาะสมกับราคา (เหมือน chartPriceFormatter)
 */
function computePriceDigits(price) {
  if (price == null || !Number.isFinite(price)) return 4;
  const abs = Math.abs(price);
  if (abs >= 1000) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 4;
  if (abs >= 0.0001) return 5;
  return 6;
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
  const priceDigits = computePriceDigits(newClose);

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
    stopLossOnUpperKC: document.getElementById('nb-stop-loss-upper-kc').checked, // FIX-2026-07-23
    autoUpdateTp: document.getElementById('nb-auto-update-tp').checked, // FIX-2026-07-23: TP auto-update toggle
    password: document.getElementById('nb-password').value || undefined, // up-front pw if user typed it
  };
  const btn = document.getElementById('nb-create');
  const errEl = document.getElementById('nb-error');
  errEl.textContent = '';
  btn.classList.add('is-loading');
  btn.disabled = true;
  try {
    await callBotWithPassword('POST', '/api/bots', data, 'สร้างบอท');
    bootstrap.Modal.getInstance(document.getElementById('newBotModal')).hide();
    await loadBots();
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
  _miniChartRefreshTimers.set(botId, setInterval(() => {
    refreshMiniChartMarkers(botId).catch((e) => console.debug(`mini-chart refresh ${botId}:`, e.message));
  }, 60_000));

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
  const resp = await API.get(`/api/bots/${botId}/mini-chart?limit=30`);
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
      WSClient.on('bot:updated', () => loadBots());
    }, 100);
  });
})();

init();