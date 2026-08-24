'use strict';

/**
 * 2026-08-19: Wallet page — holdings + USDT reserve
 * 2026-08-22: Added 2 charts:
 *   1. Account Estimate Value — daily snapshot @ 00:01 BKK (WalletSnapshot collection)
 *   2. USDT PnL (cumulative) — Trade.realizedPnl aggregate, refreshed on every SELL
 *
 *   - loadBalances()        : GET /api/wallet/balances → render table + hero totals
 *   - loadReserve()         : GET /api/wallet/reserve  → render slider + chips + usable grid
 *   - saveReserve(value)    : PUT /api/wallet/reserve  (no password gate — 2026-08-24)
 *                              uses API.put() directly
 *   - loadPortfolioChart()  : GET /api/wallet/portfolio-history?range=…
 *   - loadPnlChart()        : GET /api/wallet/pnl-series?range=…
 *
 * Refresh cadence:
 *   - On page load
 *   - On WS 'account:update' / 'balance:update' (debounced 30s — same as nav.js)
 *   - On WS 'trade:update' (state='sold') → refresh pnl chart + balance
 *   - Polling fallback every 60s
 *
 * Formatters: reuses window.formatUsdt / formatThb / __fx from nav.js
 */

(function walletPage() {
  const els = {
    refreshBtn:        document.getElementById('wallet-refresh-btn'),
    heroUsdt:          document.getElementById('wallet-total-usdt'),
    heroUsdtMeta:      document.getElementById('wallet-total-usdt-meta'),
    heroThb:           document.getElementById('wallet-total-thb'),
    heroThbMeta:       document.getElementById('wallet-total-thb-meta'),
    heroCount:         document.getElementById('wallet-count'),
    heroCountMeta:     document.getElementById('wallet-count-meta'),
    reserveCard:       document.getElementById('wallet-reserve-card'),
    reserveCurrent:    document.getElementById('wallet-reserve-current'),
    reserveSlider:     document.getElementById('wallet-reserve-slider'),
    reserveInput:      document.getElementById('wallet-reserve-input'),
    usableTotal:       document.getElementById('wallet-usable-total'),
    usableReserve:     document.getElementById('wallet-usable-reserve'),
    usableUsable:      document.getElementById('wallet-usable-usable'),
    saveBtn:           document.getElementById('wallet-reserve-save'),
    cancelBtn:         document.getElementById('wallet-reserve-cancel'),
    warn:              document.getElementById('wallet-reserve-warn'),
    bar:               document.getElementById('wallet-reserve-bar'),
    barFill:           document.getElementById('wallet-reserve-bar-fill'),
    barPct:            document.getElementById('wallet-reserve-pct'),
    help:              document.getElementById('wallet-reserve-help'),
    // FIX-2026-08-24: Auto-Reserve switch + summary
    autoReserveSwitch: document.getElementById('auto-reserve-switch'),
    autoReserveSummary: document.getElementById('auto-reserve-summary'),
    tableMeta:         document.getElementById('wallet-table-meta'),
    tableWrap:         document.getElementById('wallet-table-wrap'),
    tbody:             document.getElementById('wallet-tbody'),
    ordersMeta:        document.getElementById('wallet-orders-meta'),
    ordersTbody:       document.getElementById('wallet-orders-tbody'),
    ordersRefreshBtn:  document.getElementById('wallet-orders-refresh'),
    footerTs:          document.getElementById('wallet-footer-ts'),
    // Charts
    portfolioContainer: document.getElementById('portfolio-chart-container'),
    portfolioMetaCount: document.getElementById('portfolio-meta-count'),
    portfolioMetaFirst: document.getElementById('portfolio-meta-first'),
    portfolioMetaLast:  document.getElementById('portfolio-meta-last'),
    portfolioMetaChange: document.getElementById('portfolio-meta-change'),
    portfolioMetaUpdated: document.getElementById('portfolio-meta-updated'),
    portfolioRangeChips: document.querySelectorAll('#portfolio-range-chips .wallet-range-chip'),
    portfolioCurrencyBtns: document.querySelectorAll('#portfolio-currency-toggle button'),
    pnlContainer: document.getElementById('pnl-chart-container'),
    pnlMetaTrades: document.getElementById('pnl-meta-trades'),
    pnlMetaWins: document.getElementById('pnl-meta-wins'),
    pnlMetaLosses: document.getElementById('pnl-meta-losses'),
    pnlMetaWinrate: document.getElementById('pnl-meta-winrate'),
    pnlMetaTotal: document.getElementById('pnl-meta-total'),
    pnlMetaUpdated: document.getElementById('pnl-meta-updated'),
    pnlRangeChips: document.querySelectorAll('#pnl-range-chips .wallet-range-chip'),
    pnlCurrencyBtns: document.querySelectorAll('#pnl-currency-toggle button'),
  };
  const chips = Array.from(document.querySelectorAll('.wallet-chip, .wallet-quick-btn'));

  // Local state
  let _savedReserve = 0;        // last value persisted on server
  let _draftReserve = 0;        // value user is editing (synced to slider + input)
  let _totalUsdt = 0;           // last known USDT balance from /api/wallet/reserve
  let _lastLoadAt = 0;
  let _lastBalanceFetchAt = 0;
  let _lastOrdersFetchAt = 0;
  let _lastPortfolioFetchAt = 0;
  let _lastPnlFetchAt = 0;
  const BALANCE_MIN_INTERVAL_MS = 30 * 1000;
  const ORDERS_MIN_INTERVAL_MS = 30 * 1000;
  const CHART_MIN_INTERVAL_MS = 30 * 1000;

  // Chart state
  let _portfolioRange = '30D';
  let _portfolioCurrency = 'USDT'; // 'USDT' | 'THB'
  let _pnlRange = '30D';
  let _pnlCurrency = 'USDT';      // 'USDT' | 'THB' — USDT primary, THB uses current FX rate
  let _portfolioChart = null;
  let _portfolioSeries = null;
  let _pnlChart = null;
  let _pnlSeries = null;
  let _pnlBaselineSeries = null;
  let _lastPortfolioData = null;
  let _lastPnlData = null;

  // ─── helpers ──────────────────────────────────────────────────────────────
  function fmtUsdt(n) {
    if (n == null || !isFinite(n)) return '—';
    const v = Number(n);
    const sign = v < 0 ? '-' : '';
    const abs = Math.abs(v);
    if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(2)}k`;
    return `${sign}${abs.toFixed(2)}`;
  }
  function fmtThb(n) {
    if (n == null || !isFinite(n)) return '—';
    const v = Number(n);
    const abs = Math.abs(v);
    if (abs >= 1000000) return `฿${(abs / 1000000).toFixed(2)}M`;
    if (abs >= 10000)   return `฿${(abs / 1000).toFixed(1)}k`;
    return `฿${abs.toFixed(0)}`;
  }
  function fmtQty(n) {
    if (n == null || !isFinite(n)) return '—';
    const abs = Math.abs(Number(n));
    if (abs === 0) return '0';
    if (abs >= 1000) return Number(n).toFixed(2);
    if (abs >= 1) return Number(n).toFixed(4);
    if (abs >= 0.001) return Number(n).toFixed(6);
    return Number(n).toPrecision(4);
  }
  function fmtPct(n) {
    if (n == null || !isFinite(n)) return '—';
    return `${Number(n).toFixed(1)}%`;
  }
  function fmtSigned(n, fmt = 'usdt') {
    if (n == null || !isFinite(n)) return '—';
    const v = Number(n);
    const fn = fmt === 'thb' ? fmtThb : fmtUsdt;
    if (v > 0) return `+${fn(v)}`;
    if (v < 0) return fn(v);
    return fn(0);
  }

  function setText(el, text) { if (el) el.textContent = text; }

  function setReserveDraft(v, fromUser) {
    const n = Math.max(0, Math.floor(Number(v) || 0));
    _draftReserve = n;
    if (fromUser !== 'slider') els.reserveSlider.value = String(Math.min(n, Number(els.reserveSlider.max) || 0));
    if (fromUser !== 'input')  els.reserveInput.value  = String(n);
    syncChipsActive();
    syncReserveDisplay();
    syncDirtyFlag();
  }

  function syncChipsActive() {
    for (const c of chips) {
      // Skip delta quick-buttons (±5/±10) — they represent "add N" not a fixed target
      if (c.dataset.reserveDelta != null) {
        c.classList.remove('is-active');
        continue;
      }
      const v = c.dataset.reserve;
      const target = (v === 'max') ? _totalUsdt : parseFloat(v);
      const isActive = Math.abs(_draftReserve - target) < 0.5;
      c.classList.toggle('is-active', isActive);
    }
  }

  function syncReserveDisplay() {
    if (_draftReserve > 0) {
      els.reserveCurrent.classList.remove('is-zero');
      setText(els.reserveCurrent, `${fmtUsdt(_draftReserve)} USDT`);
    } else {
      els.reserveCurrent.classList.add('is-zero');
      setText(els.reserveCurrent, '0 USDT');
    }
    // usable grid
    const usable = Math.max(0, _totalUsdt - _draftReserve);
    setText(els.usableTotal,   `${fmtUsdt(_totalUsdt)} USDT`);
    setText(els.usableReserve, `${fmtUsdt(_draftReserve)} USDT`);
    setText(els.usableUsable,  `${fmtUsdt(usable)} USDT`);
    // over-reserved banner
    if (_draftReserve > _totalUsdt && _totalUsdt > 0) {
      els.warn.className = 'wallet-warn-banner';
      els.warn.style.display = '';
      els.warn.innerHTML = `⚠️ กั๊กเงิน (${fmtUsdt(_draftReserve)}) เกินยอด USDT ที่มี (${fmtUsdt(_totalUsdt)}) — บอทจะใช้เงินไม่ได้เลยจนกว่าจะลด reserve`;
      els.reserveCard.classList.add('is-over');
      els.reserveCard.classList.remove('is-active');
    } else if (_draftReserve > 0) {
      els.warn.style.display = 'none';
      els.warn.innerHTML = '';
      els.reserveCard.classList.add('is-active');
      els.reserveCard.classList.remove('is-over');
    } else {
      els.warn.style.display = 'none';
      els.warn.innerHTML = '';
      els.reserveCard.classList.remove('is-active', 'is-over');
    }
    // progress bar (reserved vs total) — cap visual at 100%
    const pct = _totalUsdt > 0 ? Math.min(100, (_draftReserve / _totalUsdt) * 100) : 0;
    if (_draftReserve > 0 || _totalUsdt > 0) {
      els.bar.style.display = '';
      els.barPct.style.display = '';
      els.barFill.style.width = `${pct}%`;
      setText(els.barPct, `${pct.toFixed(0)}% ของ USDT ที่ถูกกั๊ก`);
    } else {
      els.bar.style.display = 'none';
      els.barPct.style.display = 'none';
    }
  }

  function syncDirtyFlag() {
    const dirty = _draftReserve !== _savedReserve;
    els.saveBtn.disabled = !dirty;
    els.saveBtn.style.opacity = dirty ? '1' : '0.55';
    els.cancelBtn.style.display = dirty ? '' : 'none';
    if (dirty) {
      els.help.textContent = `มีการแก้ — กด 💾 บันทึก (ยังไม่บันทึก: ${fmtUsdt(_draftReserve)} USDT)`;
    } else {
      els.help.textContent = 'ใช้ slider / chip / พิมพ์ตัวเลข แล้วกดบันทึก';
    }
  }

  // ─── Loaders ──────────────────────────────────────────────────────────────
  async function loadReserve(force = false) {
    const now = Date.now();
    if (!force && (now - _lastLoadAt) < BALANCE_MIN_INTERVAL_MS) return null;
    _lastLoadAt = now;
    try {
      const r = await API.get('/api/wallet/reserve');
      _savedReserve = Number(r.reserveUsdt) || 0;
      _totalUsdt = Number(r.totalUsdt) || 0;
      // Slider max = total (cap if 0 → cap at savedReserve for UI sanity)
      const sliderMax = Math.max(_totalUsdt, _savedReserve, 100);
      els.reserveSlider.max = String(Math.ceil(sliderMax));
      // Reset draft to saved (unless user already has unsaved edits AND no force)
      if (force || _draftReserve === 0 || els.saveBtn.disabled === false) {
        // Only overwrite if user hasn't dirtied — keep their in-progress edit
        if (force || els.saveBtn.disabled) {
          setReserveDraft(_savedReserve, null);
        }
      }
      syncReserveDisplay();
      return r;
    } catch (err) {
      const msg = (err && err.body && err.body.error) || err.message || 'unknown';
      setText(els.usableTotal, '⚠');
      setText(els.usableReserve, '⚠');
      setText(els.usableUsable, '⚠');
      els.help.textContent = `❌ โหลด reserve ไม่สำเร็จ: ${msg}`;
      return null;
    }
  }

  async function loadBalances() {
    const now = Date.now();
    if ((now - _lastBalanceFetchAt) < BALANCE_MIN_INTERVAL_MS) return null;
    _lastBalanceFetchAt = now;
    try {
      const r = await API.get('/api/wallet/balances');
      renderBalances(r);
      return r;
    } catch (err) {
      const msg = (err && err.body && err.body.error) || err.message || 'unknown';
      const code = (err && err.body && err.body.binanceCode) || '';
      els.tbody.innerHTML = `<tr><td class="empty" colspan="6">
        <div class="wallet-empty">
          <span class="big-emoji">⚠️</span>
          โหลด holdings ไม่สำเร็จ<br/>
          <span class="wallet-row-meta">${code ? `Binance ${code} · ` : ''}${msg}</span>
        </div>
      </td></tr>`;
      return null;
    }
  }

  function renderBalances(r) {
    const balances = r.balances || [];
    // Hero
    setText(els.heroUsdt, fmtUsdt(r.totalValueUsdt));
    setText(els.heroUsdtMeta, balances.length ? `${balances.length} coins shown` : '');
    if (r.totalValueThb != null) {
      setText(els.heroThb, fmtThb(r.totalValueThb));
      const fxTxt = r.fxRate ? `FX ${r.fxRate.toFixed(2)} THB/USDT${r.fxStale ? ' (stale)' : ''}` : '';
      setText(els.heroThbMeta, fxTxt);
    } else {
      setText(els.heroThb, '—');
      setText(els.heroThbMeta, r.fxRate ? '' : 'FX unavailable');
    }
    setText(els.heroCount, String(r.count));
    const threshold = r.minValueThb || 1;
    setText(els.heroCountMeta, `value > ฿${threshold}`);

    // Table
    setText(els.tableMeta, `${balances.length} coins · ฿${threshold}+ only`);

    if (balances.length === 0) {
      els.tbody.innerHTML = `<tr><td class="empty" colspan="6">
        <div class="wallet-empty">
          <span class="big-emoji">📭</span>
          ไม่มีเหรียญที่มีมูลค่าเกิน ฿${threshold}<br/>
          <span class="wallet-row-meta">(ฝุ่น/dust จะถูกซ่อนไว้)</span>
        </div>
      </td></tr>`;
    } else {
      els.tbody.innerHTML = balances.map((b) => {
        const lockedTxt = b.locked > 0 ? `<div class="wallet-row-meta">+${fmtQty(b.locked)} locked</div>` : '';
        const valuePct = fmtPct(b.pctOfPortfolio);
        const barFill = Math.min(100, Number(b.pctOfPortfolio) || 0);
        const iconCls = b.isStable ? 'wallet-asset-icon is-stable' : 'wallet-asset-icon';
        const stableBadge = b.isStable ? '<span class="wallet-row-meta">stable</span>' : '';
        return `<tr>
          <td>
            <div class="${iconCls}">
              ${b.asset}
              ${stableBadge}
            </div>
            ${lockedTxt}
          </td>
          <td class="num">
            <div>${fmtQty(b.free)}</div>
            ${b.locked > 0 ? `<div class="wallet-row-meta">locked ${fmtQty(b.locked)}</div>` : ''}
          </td>
          <td class="num">${b.asset === 'USDT' ? '1.00' : fmtUsdt(b.priceUsdt)}</td>
          <td class="num"><b>${fmtUsdt(b.valueUsdt)}</b></td>
          <td class="num">${b.valueThb != null ? fmtThb(b.valueThb) : '—'}</td>
          <td class="num">
            <div>${valuePct}</div>
            <div class="wallet-progress-bar" style="height:4px;"><div class="wallet-progress-fill" style="width:${barFill}%;"></div></div>
          </td>
        </tr>`;
      }).join('');
    }

    // Footer
    const dt = new Date(r.ts || Date.now());
    const timeStr = dt.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setText(els.footerTs, `อัปเดตล่าสุด ${timeStr}`);
  }

  // ─── Open Orders loader + renderer ─────────────────────────────────────────
  // Uses existing /api/account/open-orders endpoint (weight 80 on Binance for ALL orders)
  async function loadOpenOrders(force = false) {
    const now = Date.now();
    if (!force && (now - _lastOrdersFetchAt) < ORDERS_MIN_INTERVAL_MS) return null;
    _lastOrdersFetchAt = now;
    try {
      const r = await API.get('/api/account/open-orders');
      renderOpenOrders(r.orders || []);
      return r;
    } catch (err) {
      const msg = (err && err.body && err.body.error) || err.message || 'unknown';
      const code = (err && err.body && err.body.binanceCode) || '';
      els.ordersTbody.innerHTML = `<tr><td class="empty" colspan="9">
        <div class="wallet-empty">
          <span class="big-emoji">⚠️</span>
          โหลด open orders ไม่สำเร็จ<br/>
          <span class="wallet-row-meta">${code ? `Binance ${code} · ` : ''}${msg}</span>
        </div>
      </td></tr>`;
      setText(els.ordersMeta, 'โหลดไม่สำเร็จ');
      return null;
    }
  }

  function fmtAge(tsMs) {
    if (!tsMs || !isFinite(tsMs)) return '—';
    const diffMs = Date.now() - tsMs;
    if (diffMs < 0) return '0s';
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.floor(hr / 24);
    return `${day}d`;
  }

  function renderOpenOrders(orders) {
    setText(els.ordersMeta, `${orders.length} order${orders.length === 1 ? '' : 's'} ค้างบน Binance`);

    if (orders.length === 0) {
      els.ordersTbody.innerHTML = `<tr><td class="empty" colspan="9">
        <div class="wallet-empty">
          <span class="big-emoji">✅</span>
          ไม่มีคำสั่งค้าง — พอร์ตเคลียร์<br/>
          <span class="wallet-row-meta">(LIMIT_MAKER ของบอทจะ fill ทันทีที่ราคาตรง)</span>
        </div>
      </td></tr>`;
      return;
    }

    // sort by time desc (newest first)
    const sorted = orders.slice().sort((a, b) => (b.time || 0) - (a.time || 0));

    els.ordersTbody.innerHTML = sorted.map((o) => {
      const side = String(o.side || '').toUpperCase();
      const isBuy = side === 'BUY';
      const sideClass = isBuy ? 'wallet-side-badge is-buy' : 'wallet-side-badge is-sell';
      const price = parseFloat(o.price);
      const origQty = parseFloat(o.origQty);
      const executedQty = parseFloat(o.executedQty) || 0;
      const cummQuote = parseFloat(o.cummulativeQuoteQty) || 0;
      // Total value in USDT (or quote asset) — use origQty * price for "intent"
      const totalQuote = (price * origQty) || 0;
      const filledPct = origQty > 0 ? Math.min(100, (executedQty / origQty) * 100) : 0;
      const type = String(o.type || '').replace('_', ' ');
      const age = fmtAge(o.time);
      const orderId = String(o.orderId || '');
      const clientOrderId = String(o.clientOrderId || '');
      // short clientOrderId display (bot orders have "x-..." prefix)
      const clientShort = clientOrderId.length > 20
        ? clientOrderId.slice(0, 12) + '…' + clientOrderId.slice(-4)
        : clientOrderId;
      return `<tr>
        <td><span class="${sideClass}">${side}</span></td>
        <td><b>${o.symbol}</b></td>
        <td><span class="wallet-order-type">${type}</span></td>
        <td class="num">${isFinite(price) ? price.toFixed(price < 1 ? 6 : 4) : '—'}</td>
        <td class="num">${isFinite(origQty) ? fmtQty(origQty) : '—'}</td>
        <td class="num">
          <div class="d-flex align-items-center justify-content-end">
            <span class="wallet-order-progress" title="${executedQty} / ${origQty} (${filledPct.toFixed(1)}%)">
              <span class="wallet-order-progress-fill" style="width:${filledPct}%;"></span>
            </span>
            <span>${filledPct.toFixed(0)}%</span>
          </div>
          <div class="wallet-row-meta">${fmtQty(executedQty)} filled</div>
        </td>
        <td class="num"><b>${fmtUsdt(totalQuote)}</b></td>
        <td class="num">${age}</td>
        <td>
          <div class="wallet-row-meta" title="${orderId}">#${orderId.slice(-8)}</div>
          <div class="wallet-row-meta" title="${clientOrderId}">${clientShort}</div>
        </td>
      </tr>`;
    }).join('');
  }

  // ─── Save reserve ─────────────────────────────────────────────────────────
  async function saveReserve() {
    if (_draftReserve === _savedReserve) {
      els.help.textContent = 'ไม่มีอะไรเปลี่ยน';
      return;
    }
    const prevText = els.saveBtn.textContent;
    els.saveBtn.disabled = true;
    els.saveBtn.textContent = '⏳ กำลังบันทึก…';
    try {
      // 2026-08-24: กั๊กเงินไม่ต้องใช้ password (ปุ่ม +5/+10/-5/-10 ทำให้ต้องกดบ่อย)
      const r = await API.put('/api/wallet/reserve', { reserveUsdt: _draftReserve });
      _savedReserve = Number((r && r.reserveUsdt) || 0);
      if (r && typeof r.totalUsdt === 'number') {
        _totalUsdt = r.totalUsdt;
        const sliderMax = Math.max(_totalUsdt, _savedReserve, 100);
        els.reserveSlider.max = String(Math.ceil(sliderMax));
      }
      syncReserveDisplay();
      syncChipsActive();
      syncDirtyFlag();
      els.help.textContent = `✅ บันทึกแล้ว · บอทจะใช้ USDT ได้สูงสุด ${fmtUsdt(Math.max(0, _totalUsdt - _savedReserve))} USDT`;
      // FIX-2026-08-20: refresh nav pill so "usable / total" updates without
      // waiting for the next 60s poll or WS event.
      if (typeof window.__navRefreshReserve === 'function') {
        window.__navRefreshReserve();
      }
    } catch (err) {
      const msg = (err && err.body && err.body.error) || err.message || 'unknown';
      els.help.textContent = `❌ บันทึกไม่สำเร็จ: ${msg}`;
    } finally {
      els.saveBtn.textContent = prevText;
      els.saveBtn.disabled = false;
    }
  }

  function cancelEdit() {
    setReserveDraft(_savedReserve, null);
  }

  // ─── Auto-Reserve (FIX-2026-08-24) ────────────────────────────────────────
  //   - small switch in reserve card header
  //   - status line shows: target poles + next check time + last action
  //   - toggle → PUT /api/wallet/auto-reserve/config (debounced 200ms)
  let _autoReserveCfg = null;
  let _autoReserveStatus = null;
  let _autoReserveDebounceTimer = null;

  function fmtTimeLocal(d) {
    if (!d) return '—';
    return new Date(d).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  }

  function computeNextCheckHour(checkHours) {
    if (!checkHours || !Number.isFinite(checkHours)) return '—';
    const now = new Date();
    const curH = now.getHours();
    const nextH = (Math.floor(curH / checkHours) + 1) * checkHours;
    if (nextH >= 24) return '00:00 (พรุ่งนี้)';
    return `${String(nextH).padStart(2, '0')}:00`;
  }

  function syncAutoReserveUI() {
    if (!els.autoReserveSwitch || !els.autoReserveSummary) return;
    const enabled = !!(els.autoReserveSwitch && els.autoReserveSwitch.checked);
    const cfg = _autoReserveCfg || {};
    if (!enabled) {
      els.autoReserveSummary.textContent = 'OFF';
      els.autoReserveSummary.style.color = 'var(--text-3)';
      return;
    }
    const poleCount = cfg.poleCount || 3;
    const next = computeNextCheckHour(cfg.checkHours || 4);
    els.autoReserveSummary.textContent = `ON · target ${poleCount} poles · ตรวจ ${next}`;
    els.autoReserveSummary.style.color = 'var(--gold-1)';
  }

  async function loadAutoReserveStatus(force = false) {
    try {
      const r = await API.get('/api/wallet/auto-reserve/config');
      _autoReserveCfg = (r && r.config) || null;
      _autoReserveStatus = (r && r.status) || null;
      if (els.autoReserveSwitch && _autoReserveCfg) {
        // Only set if not user-dirty
        if (!_autoReserveSwitchBusy) {
          els.autoReserveSwitch.checked = _autoReserveCfg.enabled === true;
        }
      }
      syncAutoReserveUI();
      return r;
    } catch (err) {
      const msg = (err && err.body && err.body.error) || err.message || 'unknown';
      if (els.autoReserveSummary) {
        els.autoReserveSummary.textContent = `⚠ ${msg}`;
        els.autoReserveSummary.style.color = 'var(--bear-1)';
      }
      return null;
    }
  }

  let _autoReserveSwitchBusy = false;
  async function onAutoReserveSwitchChange() {
    if (!els.autoReserveSwitch) return;
    const newEnabled = els.autoReserveSwitch.checked;
    _autoReserveSwitchBusy = true;
    try {
      // debounce 200ms in case user double-toggles
      if (_autoReserveDebounceTimer) clearTimeout(_autoReserveDebounceTimer);
      _autoReserveDebounceTimer = setTimeout(async () => {
        try {
          const r = await API.put('/api/wallet/auto-reserve/config', { enabled: newEnabled });
          _autoReserveCfg = (r && r.config) || _autoReserveCfg;
          syncAutoReserveUI();
          // After enable, refresh reserve display (service may have immediately fired)
          if (newEnabled) {
            loadReserve(true);
          }
        } catch (err) {
          const msg = (err && err.body && err.body.error) || err.message || 'unknown';
          // revert switch on failure
          if (els.autoReserveSwitch) els.autoReserveSwitch.checked = !newEnabled;
          syncAutoReserveUI();
          if (els.help) els.help.textContent = `❌ Auto-Reserve toggle failed: ${msg}`;
        } finally {
          _autoReserveSwitchBusy = false;
        }
      }, 200);
    } catch (e) {
      _autoReserveSwitchBusy = false;
    }
  }

  // ─── Charts: helpers + setup ─────────────────────────────────────────────

  function fmtTimeShort(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleString('th-TH', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function sharedChartOptions(container) {
    const w = container.clientWidth || 600;
    return {
      width: w,
      height: 280,
      layout: {
        background: { type: 'solid', color: 'rgba(7,11,20,0.55)' },
        textColor: '#cbd5e1',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.05)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
      },
      crosshair: { mode: 1 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: false },
    };
  }

  function setupPortfolioChart() {
    if (!els.portfolioContainer) return;
    _portfolioChart = LightweightCharts.createChart(els.portfolioContainer, sharedChartOptions(els.portfolioContainer));
    _portfolioSeries = _portfolioChart.addAreaSeries({
      topColor: 'rgba(245,184,0,0.55)',
      bottomColor: 'rgba(245,184,0,0.04)',
      lineColor: '#f5b800',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    // gold baseline at 0
    _portfolioSeries.applyOptions({ baseValue: { type: 'price', price: 0 } });

    // resize handling
    const ro = new ResizeObserver(() => {
      const w = els.portfolioContainer.clientWidth || 600;
      _portfolioChart && _portfolioChart.applyOptions({ width: w });
    });
    ro.observe(els.portfolioContainer);

    // Bangkok timezone formatter
    _portfolioChart.timeScale().applyOptions({
      tickMarkFormatter: (timeSec) => {
        try { return fmtTimeShort(new Date(timeSec * 1000)); }
        catch (_) { return ''; }
      },
    });
  }

  function setupPnlChart() {
    if (!els.pnlContainer) return;
    _pnlChart = LightweightCharts.createChart(els.pnlContainer, sharedChartOptions(els.pnlContainer));
    _pnlSeries = _pnlChart.addAreaSeries({
      topColor: 'rgba(0,229,184,0.55)',
      bottomColor: 'rgba(0,229,184,0.04)',
      lineColor: '#00e5b8',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    _pnlSeries.applyOptions({ baseValue: { type: 'price', price: 0 } });
    // price line at 0 (break-even)
    _pnlSeries.createPriceLine({
      price: 0,
      color: 'rgba(255,255,255,0.35)',
      lineWidth: 1,
      lineStyle: 2,
      title: 'break-even',
    });

    const ro = new ResizeObserver(() => {
      const w = els.pnlContainer.clientWidth || 600;
      _pnlChart && _pnlChart.applyOptions({ width: w });
    });
    ro.observe(els.pnlContainer);

    _pnlChart.timeScale().applyOptions({
      tickMarkFormatter: (timeSec) => {
        try { return fmtTimeShort(new Date(timeSec * 1000)); }
        catch (_) { return ''; }
      },
    });
  }

  function valueForPortfolioPoint(p) {
    if (_portfolioCurrency === 'THB') return p.totalThb != null ? p.totalThb : (p.totalUsdt * (p.fxRate || 0));
    return p.totalUsdt;
  }
  function valueFmt(v) { return _portfolioCurrency === 'THB' ? fmtThb(v) : fmtUsdt(v); }

  // FX rate (cached from window.__fx — populated by nav.js)
  function currentFxRate() {
    const fx = window.__fx;
    return (fx && Number(fx.rate) > 0) ? Number(fx.rate) : null;
  }
  function valueForPnlPoint(cumUsdt) {
    if (_pnlCurrency === 'THB') {
      const rate = currentFxRate();
      return rate ? cumUsdt * rate : null;
    }
    return cumUsdt;
  }
  function pnlFmt(v) {
    if (v == null) return '—';
    return _pnlCurrency === 'THB' ? fmtThb(v) : fmtUsdt(v);
  }

  function renderPortfolioData(data) {
    if (!_portfolioSeries) return;
    const allPoints = (data.points || []).slice();
    if (data.livePoint) allPoints.push(data.livePoint);
    if (allPoints.length === 0) {
      _portfolioSeries.setData([]);
      setText(els.portfolioMetaCount, '0');
      setText(els.portfolioMetaFirst, '—');
      setText(els.portfolioMetaLast, '—');
      els.portfolioMetaChange.classList.remove('is-pos', 'is-neg');
      setText(els.portfolioMetaChange, '—');
      setText(els.portfolioMetaUpdated, '—');
      return;
    }
    // dedupe by time (livePoint could collide with today's snapshot)
    const seen = new Set();
    const deduped = [];
    for (const p of allPoints) {
      if (!seen.has(p.time)) {
        seen.add(p.time);
        deduped.push(p);
      }
    }
    deduped.sort((a, b) => a.time - b.time);
    const seriesData = deduped.map((p) => ({ time: p.time, value: valueForPortfolioPoint(p) }));
    _portfolioSeries.setData(seriesData);
    _portfolioChart.timeScale().fitContent();

    const first = deduped[0];
    const last = deduped[deduped.length - 1];
    const firstVal = valueForPortfolioPoint(first);
    const lastVal = valueForPortfolioPoint(last);
    const change = lastVal - firstVal;
    const changePct = firstVal > 0 ? (change / firstVal) * 100 : 0;
    setText(els.portfolioMetaCount, String(deduped.length));
    setText(els.portfolioMetaFirst, `${valueFmt(firstVal)} (${fmtTimeShort(new Date(first.time * 1000))})`);
    setText(els.portfolioMetaLast, `${valueFmt(lastVal)} (${fmtTimeShort(new Date(last.time * 1000))})`);
    const chEl = els.portfolioMetaChange;
    chEl.classList.remove('is-pos', 'is-neg');
    if (change > 0) chEl.classList.add('is-pos');
    else if (change < 0) chEl.classList.add('is-neg');
    setText(chEl, `${fmtSigned(change, _portfolioCurrency.toLowerCase())} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`);
    setText(els.portfolioMetaUpdated, fmtTimeShort(data.ts || Date.now()));
  }

  function renderPnlData(data) {
    if (!_pnlSeries) return;
    const allPoints = (data.points || []).slice();
    if (allPoints.length === 0) {
      _pnlSeries.setData([]);
      setText(els.pnlMetaTrades, '0');
      setText(els.pnlMetaWins, '0');
      setText(els.pnlMetaLosses, '0');
      setText(els.pnlMetaWinrate, '—');
      els.pnlMetaTotal.classList.remove('is-pos', 'is-neg');
      setText(els.pnlMetaTotal, '—');
      setText(els.pnlMetaUpdated, '—');
      return;
    }
    // FIX-2026-08-22: lightweight-charts requires STRICTLY INCREASING time.
    //   Previous code prepended a baseline point at `allPoints[0].time` with value=0 —
    //   that created a duplicate time → setData threw → chart silently rendered empty.
    //   The series now starts at the first trade's cumulative PnL value (which IS the
    //   anchor point of the curve). Backend still returns baselinePoint for API contract
    //   compat but frontend ignores it.
    //   Also defensive: dedupe by time (last-write-wins) in case 2 trades have the same
    //   sellFilledAt timestamp at second-resolution.
    const byTime = new Map();
    for (const p of allPoints) {
      const v = valueForPnlPoint(p.cumPnlUsdt);
      if (v == null) continue; // skip THB points without FX
      byTime.set(p.time, { time: p.time, value: v }); // last-write-wins
    }
    const seriesData = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    if (seriesData.length === 0) {
      _pnlSeries.setData([]);
      return;
    }
    _pnlSeries.setData(seriesData);
    _pnlChart.timeScale().fitContent();

    const totalUsdt = data.totalPnlUsdt || 0;
    const total = valueForPnlPoint(totalUsdt);
    const currencyLabel = _pnlCurrency;
    setText(els.pnlMetaTrades, String(data.count));
    setText(els.pnlMetaWins, String(data.wins));
    setText(els.pnlMetaLosses, String(data.losses));
    setText(els.pnlMetaWinrate, `${data.winRate || 0}%`);
    const totEl = els.pnlMetaTotal;
    totEl.classList.remove('is-pos', 'is-neg');
    if (total != null && total > 0) totEl.classList.add('is-pos');
    else if (total != null && total < 0) totEl.classList.add('is-neg');
    // THB fallback: show — if FX rate unavailable
    if (total == null) {
      setText(totEl, '— (FX unavailable)');
    } else {
      setText(totEl, `${pnlFmt(total)} ${currencyLabel}`);
    }
    setText(els.pnlMetaUpdated, fmtTimeShort(data.ts || Date.now()));
  }

  // ─── Charts: data fetchers ──────────────────────────────────────────────
  async function loadPortfolioChart(force = false) {
    const now = Date.now();
    if (!force && (now - _lastPortfolioFetchAt) < CHART_MIN_INTERVAL_MS) return null;
    _lastPortfolioFetchAt = now;
    try {
      const data = await API.get(`/api/wallet/portfolio-history?range=${encodeURIComponent(_portfolioRange)}`);
      _lastPortfolioData = data;
      renderPortfolioData(data);
      return data;
    } catch (err) {
      console.warn('[wallet] portfolio-history failed:', err && err.message);
      return null;
    }
  }

  async function loadPnlChart(force = false) {
    const now = Date.now();
    if (!force && (now - _lastPnlFetchAt) < CHART_MIN_INTERVAL_MS) return null;
    _lastPnlFetchAt = now;
    try {
      const data = await API.get(`/api/wallet/pnl-series?range=${encodeURIComponent(_pnlRange)}`);
      _lastPnlData = data;
      renderPnlData(data);
      return data;
    } catch (err) {
      console.warn('[wallet] pnl-series failed:', err && err.message);
      return null;
    }
  }

  // Re-render existing data when currency toggle changes (no refetch)
  function reRenderPortfolioFromCache() {
    if (_lastPortfolioData) renderPortfolioData(_lastPortfolioData);
  }
  function reRenderPnlFromCache() {
    if (_lastPnlData) renderPnlData(_lastPnlData);
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────
  function wire() {
    // Slider
    els.reserveSlider.addEventListener('input', (e) => {
      setReserveDraft(parseFloat(e.target.value) || 0, 'slider');
    });
    // Number input
    els.reserveInput.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      setReserveDraft(Number.isFinite(v) ? v : 0, 'input');
    });
    els.reserveInput.addEventListener('blur', () => {
      // sync input back from draft (clamps)
      els.reserveInput.value = String(_draftReserve);
    });
    // Chips
    for (const c of chips) {
      c.addEventListener('click', () => {
        // Delta chips (±5, ±10): adjust current draft by the delta
        const deltaStr = c.dataset.reserveDelta;
        if (deltaStr != null) {
          const delta = parseInt(deltaStr, 10);
          if (!Number.isFinite(delta)) return;
          setReserveDraft(_draftReserve + delta, 'chip');
          return;
        }
        // Fixed-value chips (0, 50, 100, 1000, Max): set draft to exact value
        const v = c.dataset.reserve;
        const target = (v === 'max') ? Math.floor(_totalUsdt) : parseFloat(v);
        if (!Number.isFinite(target)) return;
        setReserveDraft(target, 'chip');
      });
    }
    // Save / Cancel
    els.saveBtn.addEventListener('click', saveReserve);
    els.cancelBtn.addEventListener('click', cancelEdit);
    // FIX-2026-08-24: Auto-Reserve switch
    if (els.autoReserveSwitch) {
      els.autoReserveSwitch.addEventListener('change', onAutoReserveSwitchChange);
    }
    // Refresh
    els.refreshBtn.addEventListener('click', () => {
      _lastLoadAt = 0;
      _lastBalanceFetchAt = 0;
      _lastOrdersFetchAt = 0;
      _lastPortfolioFetchAt = 0;
      _lastPnlFetchAt = 0;
      Promise.all([
        loadReserve(true),
        loadBalances(),
        loadOpenOrders(true),
        loadPortfolioChart(true),
        loadPnlChart(true),
        loadAutoReserveStatus(true),
      ]);
    });

    // Open Orders refresh button
    if (els.ordersRefreshBtn) {
      els.ordersRefreshBtn.addEventListener('click', () => loadOpenOrders(true));
    }

    // Portfolio range chips
    els.portfolioRangeChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        const range = chip.dataset.range;
        if (!range || range === _portfolioRange) return;
        els.portfolioRangeChips.forEach((c) => c.classList.toggle('is-active', c.dataset.range === range));
        _portfolioRange = range;
        loadPortfolioChart(true);
      });
    });
    // Portfolio currency toggle
    els.portfolioCurrencyBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const cur = btn.dataset.currency;
        if (!cur || cur === _portfolioCurrency) return;
        els.portfolioCurrencyBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.currency === cur));
        _portfolioCurrency = cur;
        reRenderPortfolioFromCache();
      });
    });
    // PnL range chips
    els.pnlRangeChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        const range = chip.dataset.range;
        if (!range || range === _pnlRange) return;
        els.pnlRangeChips.forEach((c) => c.classList.toggle('is-active', c.dataset.range === range));
        _pnlRange = range;
        loadPnlChart(true);
      });
    });
    // PnL currency toggle
    els.pnlCurrencyBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const cur = btn.dataset.currency;
        if (!cur || cur === _pnlCurrency) return;
        els.pnlCurrencyBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.currency === cur));
        _pnlCurrency = cur;
        reRenderPnlFromCache();
      });
    });

    // WS hooks — refresh on Binance user-data stream updates (debounced via minInterval)
    if (typeof WSClient !== 'undefined') {
      const onAcct = () => {
        _lastLoadAt = 0; // allow immediate refresh
        _lastBalanceFetchAt = 0;
        _lastPortfolioFetchAt = 0;
        // Don't refresh pnl here — only on actual SELL fill (below)
        Promise.all([
          loadReserve(true),
          loadBalances(),
          loadOpenOrders(true),
          loadPortfolioChart(true),
        ]);
      };
      const onOrder = () => {
        _lastOrdersFetchAt = 0;
        loadOpenOrders(true);
      };
      const onTradeUpdate = (payload) => {
        // Trade SOLD → refresh pnl series + balances (portfolio chart reuses same data path)
        if (payload && payload.state === 'sold') {
          _lastPnlFetchAt = 0;
          _lastBalanceFetchAt = 0;
          _lastPortfolioFetchAt = 0;
          Promise.all([
            loadBalances(),
            loadPortfolioChart(true),
            loadPnlChart(true),
            loadOpenOrders(true),
          ]);
        }
      };
      WSClient.on('account:update', onAcct);
      WSClient.on('balance:update', onAcct);
      WSClient.on('order:update', onOrder); // Binance order update → refresh open orders
      WSClient.on('trade:update', onTradeUpdate);
      // FIX-2026-08-24: autoReserve:adjusted → refresh reserve display + status line
      WSClient.on('autoReserve:adjusted', (payload) => {
        if (payload && typeof payload.afterReserve === 'number') {
          _savedReserve = payload.afterReserve;
          if (typeof payload.totalUsdt === 'number') _totalUsdt = payload.totalUsdt;
          // Reset slider max to fit new reserve
          const sliderMax = Math.max(_totalUsdt, _savedReserve, 100);
          els.reserveSlider.max = String(Math.ceil(sliderMax));
          if (els.saveBtn.disabled) {
            setReserveDraft(_savedReserve, null);
          }
          syncReserveDisplay();
          syncChipsActive();
          syncDirtyFlag();
        }
        loadAutoReserveStatus(true);
      });
    }

    // Polling fallback every 60s
    setInterval(() => {
      loadReserve();
      loadBalances();
      loadOpenOrders();
      loadPortfolioChart();
      loadPnlChart();
      loadAutoReserveStatus();
    }, 60 * 1000);

    // initial state
    setReserveDraft(0, null);
    syncReserveDisplay();

    // Setup charts (must happen AFTER DOM has #portfolio-chart-container + #pnl-chart-container)
    setupPortfolioChart();
    setupPnlChart();

    // Re-render PnL chart when FX rate updates (THB mode only — re-render avoids stale FX)
    document.addEventListener('fx:updated', () => {
      if (_pnlCurrency === 'THB') reRenderPnlFromCache();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    wire();
    // initial load — all endpoints (force=true to bypass debounce)
    Promise.all([
      loadReserve(true),
      loadBalances(),
      loadOpenOrders(true),
      loadPortfolioChart(true),
      loadPnlChart(true),
      loadAutoReserveStatus(true),
    ]);
  });
})();
