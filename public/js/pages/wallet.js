'use strict';

/**
 * 2026-08-19: Wallet page — holdings + USDT reserve
 *
 *   - loadBalances()        : GET /api/wallet/balances → render table + hero totals
 *   - loadReserve()         : GET /api/wallet/reserve  → render slider + chips + usable grid
 *   - saveReserve(value)    : PUT /api/wallet/reserve  (gated by bot-action password)
 *                              uses window.callBotWithPassword() — same pattern as
 *                              enable/disable bot in bots.js
 *
 * Refresh cadence:
 *   - On page load
 *   - On WS 'account:update' / 'balance:update' (debounced 30s — same as nav.js)
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
    tableMeta:         document.getElementById('wallet-table-meta'),
    tableWrap:         document.getElementById('wallet-table-wrap'),
    tbody:             document.getElementById('wallet-tbody'),
    ordersMeta:        document.getElementById('wallet-orders-meta'),
    ordersTbody:       document.getElementById('wallet-orders-tbody'),
    ordersRefreshBtn:  document.getElementById('wallet-orders-refresh'),
    footerTs:          document.getElementById('wallet-footer-ts'),
  };
  const chips = Array.from(document.querySelectorAll('.wallet-chip'));

  // Local state
  let _savedReserve = 0;        // last value persisted on server
  let _draftReserve = 0;        // value user is editing (synced to slider + input)
  let _totalUsdt = 0;           // last known USDT balance from /api/wallet/reserve
  let _lastLoadAt = 0;
  let _lastBalanceFetchAt = 0;
  let _lastOrdersFetchAt = 0;
  const BALANCE_MIN_INTERVAL_MS = 30 * 1000;
  const ORDERS_MIN_INTERVAL_MS = 30 * 1000;

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
      const r = await window.callBotWithPassword(
        'PUT',
        '/api/wallet/reserve',
        { reserveUsdt: _draftReserve },
        'บันทึกการกั๊กเงิน'
      );
      _savedReserve = Number((r && r.reserveUsdt) || 0);
      if (r && typeof r.totalUsdt === 'number') {
        _totalUsdt = r.totalUsdt;
        const sliderMax = Math.max(_totalUsdt, _savedReserve, 100);
        els.reserveSlider.max = String(Math.ceil(sliderMax));
      }
      syncReserveDisplay();
      syncChipsActive();
      syncDirtyFlag();
      els.help.textContent = `✅ บันท�กแล้ว · บอทจะใช้ USDT ได้สูงสุด ${fmtUsdt(Math.max(0, _totalUsdt - _savedReserve))} USDT`;
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
        const v = c.dataset.reserve;
        const target = (v === 'max') ? Math.floor(_totalUsdt) : parseFloat(v);
        if (!Number.isFinite(target)) return;
        setReserveDraft(target, 'chip');
      });
    }
    // Save / Cancel
    els.saveBtn.addEventListener('click', saveReserve);
    els.cancelBtn.addEventListener('click', cancelEdit);
    // Refresh
    els.refreshBtn.addEventListener('click', () => {
      _lastLoadAt = 0;
      _lastBalanceFetchAt = 0;
      Promise.all([loadReserve(true), loadBalances(), loadOpenOrders(true)]);
    });

    // Open Orders refresh button
    if (els.ordersRefreshBtn) {
      els.ordersRefreshBtn.addEventListener('click', () => loadOpenOrders(true));
    }

    // WS hooks — refresh on Binance user-data stream updates (debounced via minInterval)
    if (typeof WSClient !== 'undefined') {
      const onAcct = () => {
        _lastLoadAt = 0; // allow immediate refresh
        _lastBalanceFetchAt = 0;
        Promise.all([loadReserve(true), loadBalances(), loadOpenOrders(true)]);
      };
      const onOrder = () => {
        _lastOrdersFetchAt = 0;
        loadOpenOrders(true);
      };
      WSClient.on('account:update', onAcct);
      WSClient.on('balance:update', onAcct);
      WSClient.on('order:update', onOrder); // Binance order update → refresh open orders
    }

    // Polling fallback every 60s
    setInterval(() => {
      loadReserve();
      loadBalances();
      loadOpenOrders();
    }, 60 * 1000);

    // initial state
    setReserveDraft(0, null);
    syncReserveDisplay();
  }

  document.addEventListener('DOMContentLoaded', () => {
    wire();
    // initial load — both endpoints
    Promise.all([loadReserve(true), loadBalances(), loadOpenOrders(true)]);
  });
})();