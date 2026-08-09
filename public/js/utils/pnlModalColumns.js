'use strict';

/* ─────────────────────────────────────────────────────────
   PnL Modal Columns — shared column definitions + toggle logic
   ─────────────────────────────────────────────────────────
   Used by both pnl.html (openDayModal) and chart-monitor.html
   (openTodayPnlModal). Both modals call /api/pnl/day and show
   the same trade rows, so column rendering + toggle UI is
   identical.
   ───────────────────────────────────────────────────────── */

(function () {
  // Shared localStorage key (same between pnl.html + chart-monitor.html)
  const COL_STORAGE_KEY = 'pnl-modal-columns-v1';

  // FIX-2026-08-09 (rev2): ลบ `essential` lock — ผู้ใช้สามารถปิดทุกคอลัมน์ได้
  //   - กัน empty table ด้วย default check = 1 column แรกเสมอ
  //   - 'mobileDefault' คือ visibility ตอน first-visit บนมือถือ
  //   - 'desktopDefault' คือ visibility ตอน first-visit บน desktop
  //   - render(t) คือ function ที่ return HTML สำหรับ 1 cell
  const COLUMN_DEFS = [
    {
      id: 'bot', label: 'Bot', desktopDefault: true, mobileDefault: true,
      sample: 'SYN',
      render: (t) => `<span class="badge-bot">${escHtml(t.botName || '?')}</span>`,
    },
    {
      id: 'symbol', label: 'Symbol', desktopDefault: true, mobileDefault: true,
      sample: 'SYNUSDT',
      render: (t) => {
        const isDcaStack = t.isDcaStack === true;
        const dcaBadge = isDcaStack
          ? `<span class="dca-pill" title="DCA stack — ${t.dcaLayerCount || '?'} layers, BEP=${Number(t.stackBep || t.buyPrice || 0).toFixed(8)}">📚 L${t.dcaLayerCount || '?'}</span>`
          : '';
        return `${escHtml(t.symbol || '')} ${dcaBadge}`;
      },
    },
    {
      id: 'entryPrice', label: 'Entry', desktopDefault: true, mobileDefault: false, sample: '0.00123',
      render: (t) => {
        const isDcaStack = t.isDcaStack === true;
        return isDcaStack
          ? `<span title="stack BEP">${t.stackBep ? window.PriceFormat.format(parseFloat(t.stackBep), t.symbol) : '—'}</span>`
          : (t.entryPrice ? window.PriceFormat.format(parseFloat(t.entryPrice), t.symbol) : '—');
      },
    },
    {
      id: 'exitPrice', label: 'Exit', desktopDefault: true, mobileDefault: false, sample: '0.00145',
      render: (t) => t.exitPrice ? window.PriceFormat.format(parseFloat(t.exitPrice), t.symbol) : '—',
    },
    {
      id: 'entryQty', label: 'Entry Qty', desktopDefault: false, mobileDefault: false, sample: '1.5000',
      render: (t) => {
        const q = t.entryQty != null ? parseFloat(t.entryQty) : null;
        return q != null && Number.isFinite(q) ? q.toFixed(4) : '—';
      },
    },
    {
      id: 'exitQty', label: 'Exit Qty', desktopDefault: false, mobileDefault: false, sample: '1.4500',
      render: (t) => {
        const q = t.exitQty != null ? parseFloat(t.exitQty) : null;
        if (q == null || !Number.isFinite(q)) return '—';
        const isPartial = t.isPartialSell === true || (t.entryQty && q < parseFloat(t.entryQty));
        const partialBadge = isPartial
          ? ` <span class="partial-fill-warn" title="Partial-fill: SELL filled ${q} จาก ${t.entryQty} (ขาด ${(parseFloat(t.entryQty) - q).toFixed(4)})">⚠️</span>`
          : '';
        return `${q.toFixed(4)}${partialBadge}`;
      },
    },
    {
      id: 'pnl', label: 'PnL', desktopDefault: true, mobileDefault: true, sample: '+1.23',
      render: (t) => {
        const pnl = t.realizedPnl || 0;
        const cls = pnl > 0 ? 'pnl-bull' : pnl < 0 ? 'pnl-bear' : '';
        const thb = (window.__fx && window.__fx.rate) ? (pnl * window.__fx.rate) : null;
        return `<span class="${cls}">${formatUsdt(pnl)}</span>${thb != null ? `<br><span class="thb-sub">≈ ฿${formatThbInline(thb)}</span>` : ''}`;
      },
    },
    {
      id: 'time', label: 'เวลา', desktopDefault: true, mobileDefault: false, sample: '14:30',
      render: (t) => {
        const ts = t.sellFilledAt
          ? new Date(t.sellFilledAt).toLocaleString('th-TH', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })
          : '';
        return `<span class="muted">${ts}</span>`;
      },
    },
    {
      id: 'reason', label: 'Reason', desktopDefault: true, mobileDefault: true, sample: '🎯',
      render: (t) => window.SellReasons
        ? window.SellReasons.renderSellReasonPill(t.sellReason, t.sellReasonDetail)
        : (escHtml(t.sellReason || '—')),
    },
  ];

  function isMobile() {
    return window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
  }

  function defaultsForCurrentViewport() {
    return COLUMN_DEFS.filter((c) => (isMobile() ? c.mobileDefault : c.desktopDefault)).map((c) => c.id);
  }

  function loadVisibleColumns() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(COL_STORAGE_KEY) || 'null'); } catch (_) {}
    if (Array.isArray(saved)) {
      const validIds = new Set(COLUMN_DEFS.map((c) => c.id));
      return saved.filter((id) => validIds.has(id));
    }
    return defaultsForCurrentViewport();
  }

  function saveVisibleColumns(ids) {
    try { localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(ids)); } catch (_) {}
  }

  // Render trades table (returns innerHTML for tbody + thead)
  // Caller provides formatUsdt + formatThbInline + escHtml helpers (different files have different copies)
  function buildTableHtml(trades, helpers) {
    const { escHtml, formatUsdt, formatThbInline } = helpers;
    const visibleIds = loadVisibleColumns();
    const visibleCols = COLUMN_DEFS.filter((c) => visibleIds.includes(c.id));
    const sortedTrades = [...trades].sort((a, b) => {
      const at = a.sellFilledAt ? new Date(a.sellFilledAt).getTime() : 0;
      const bt = b.sellFilledAt ? new Date(b.sellFilledAt).getTime() : 0;
      return bt - at;
    });
    const rightAligned = new Set(['entryPrice', 'exitPrice', 'entryQty', 'exitQty', 'pnl']);
    const rows = sortedTrades.map((t) => {
      return `<tr>${visibleCols.map((c) => {
        const align = rightAligned.has(c.id) ? 'text-end' : '';
        // pass helpers to render
        const html = c.render(t, { formatUsdt, formatThbInline, escHtml });
        return `<td class="${align}" data-col="${c.id}">${html}</td>`;
      }).join('')}</tr>`;
    }).join('');
    const headerCells = visibleCols.map((c) => {
      const align = rightAligned.has(c.id) ? 'text-end' : '';
      return `<th class="${align}" data-col="${c.id}">${escHtml(c.label)}</th>`;
    }).join('');
    return {
      html: `<thead><tr>${headerCells}</tr></thead><tbody>${rows}</tbody>`,
      visibleIds,
      visibleCols,
    };
  }

  function renderColumnMenu(menu, onChange) {
    const isMobileView = isMobile();
    const items = COLUMN_DEFS.map((col) => {
      const visibleIds = loadVisibleColumns();
      const checked = visibleIds.includes(col.id);
      return `<label class="pnl-col-menu-item">
        <input type="checkbox" data-col="${col.id}" ${checked ? 'checked' : ''}/>
        <span>${escHtml(col.label)}</span>
        <span class="col-sample">${escHtml(col.sample)}</span>
      </label>`;
    }).join('');
    const mobileHint = isMobileView
      ? `<div class="pnl-col-menu-mobile-hint">📱 โหมดมือถือ — ปิดคอลัมน์ที่ไม่จำเป็นเพื่อให้อ่านง่าย</div>`
      : '';
    menu.innerHTML = `
      <div class="pnl-col-menu-header">เลือกคอลัมน์ที่จะแสดง (${loadVisibleColumns().length}/${COLUMN_DEFS.length})</div>
      ${items}
      ${mobileHint}
      <div class="pnl-col-menu-actions">
        <button type="button" data-action="all">แสดงทั้งหมด</button>
        <button type="button" data-action="none">ปิดทั้งหมด</button>
        <button type="button" data-action="reset">รีเซ็ต</button>
      </div>
    `;
    // checkbox handlers
    menu.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const colId = cb.getAttribute('data-col');
        const current = new Set(loadVisibleColumns());
        if (cb.checked) current.add(colId); else current.delete(colId);
        saveVisibleColumns([...current]);
        renderColumnMenu(menu, onChange); // refresh header count
        if (typeof onChange === 'function') onChange();
      });
    });
    // action buttons
    menu.querySelectorAll('.pnl-col-menu-actions button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        let ids;
        if (action === 'all') ids = COLUMN_DEFS.map((c) => c.id);
        else if (action === 'none') ids = []; // empty table — ผู้ใช้เลือกเอง
        else if (action === 'reset') ids = defaultsForCurrentViewport();
        saveVisibleColumns(ids);
        renderColumnMenu(menu, onChange);
        if (typeof onChange === 'function') onChange();
      });
    });
  }

  // Local helpers — if formatUsdt/formatThbInline not provided, fallback
  function formatUsdt(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    const sign = v >= 0 ? '+' : '';
    return `${sign}${v.toFixed(4)}`;
  }
  function formatThbInline(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    const sign = v < 0 ? '-' : '';
    const abs = Math.abs(v);
    if (abs >= 1000000) return `${sign}${(abs / 1000000).toFixed(2)}M`;
    if (abs >= 10000)   return `${sign}${(abs / 1000).toFixed(1)}k`;
    return `${sign}${abs.toFixed(0)}`;
  }
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  window.PnlModalColumns = {
    COLUMN_DEFS,
    COL_STORAGE_KEY,
    isMobile,
    loadVisibleColumns,
    saveVisibleColumns,
    defaultsForCurrentViewport,
    buildTableHtml,
    renderColumnMenu,
  };
})();
