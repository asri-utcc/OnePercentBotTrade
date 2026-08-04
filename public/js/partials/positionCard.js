'use strict';
/**
 * 2026-07-30: Shared position card partial.
 *   - extracted from public/js/pages/bot-detail.js (computePositionMetrics + renderPositionCard + renderPositionCardMobile + formatDuration + fmtDateTime)
 *   - reused by:
 *       • bot-detail.html  (single bot, no bot-link, no retry count visible by default → use { showRetry: false, forceCloseBtnClass: 'btn-force-close' })
 *       • bots.html        (cross-bot modal, with bot link + retry count → use { botName, botLink: true, showRetry: true, forceCloseBtnClass: 'btn-force-close-opm' })
 *
 *   Markup reuses existing CSS classes: .position-card, .pos-grid, .pct-bar, .pos-foot, .pnl-bull/bear, .tp-reached ฯลฯ
 *   Output element class for force-close button: opts.forceCloseBtnClass (default 'btn-force-close') — ต่างจากกันเพื่อให้ modal-level handler รู้ว่าเป็น card ใน modal
 */

window.PositionCard = {
  OPEN_STATES: ['placed', 'partial_wait', 'filled', 'retrying', 'holding', 'selling', 'stopping'],
  STATE_COLORS: {
    placed: 'placed', filled: 'filled', retrying: 'retrying', cancelled: 'cancelled',
    holding: 'holding', selling: 'selling', sold: 'sold', failed: 'failed',
    stopping: 'stopping', partial_wait: 'placed',
  },

  computeMetrics(t, currentPrice) {
    const entry = Number(t.buyPrice) || 0;
    const qty = Number(t.buyQty) || 0;
    const tp = Number(t.targetSellPrice) || 0;
    const px = (currentPrice && currentPrice > 0) ? currentPrice : entry;

    const pnlPct = entry > 0 ? ((px - entry) / entry) * 100 : 0;
    const unrealizedUsdt = (px - entry) * qty;

    let pctToTp = null;
    let tpReached = false;
    if (tp > 0 && px > 0) {
      if (px >= tp) { pctToTp = 0; tpReached = true; }
      else pctToTp = ((tp - px) / px) * 100;
    }

    const totalPathPct = (tp > 0 && entry > 0) ? ((tp - entry) / entry) * 100 : 0;
    let barPct = 0;
    if (pctToTp != null && totalPathPct > 0) {
      barPct = (pctToTp / totalPathPct) * 100;
      if (barPct < 0) barPct = 0;
      if (barPct > 100) barPct = 100;
    }

    const startAt = t.buyFilledAt || t.buyPlacedAt || t.createdAt;
    const durMs = startAt ? (Date.now() - new Date(startAt).getTime()) : 0;

    return {
      entry, qty, tp, px,
      symbol: t.symbol, // FIX-2026-07-31: thread symbol through for PriceFormat (was dropped → forced .toFixed(4) → ZILUSDT showed 4 dp instead of 6)
      pnlPct, unrealizedUsdt,
      pctToTp, tpReached, barPct, totalPathPct,
      durMs,
    };
  },

  formatDuration(ms) {
    if (ms == null || ms <= 0) return '—';
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
    return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  },

  fmtDateTime(d) {
    if (!d) return '-';
    return new Intl.DateTimeFormat('th-TH', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(d));
  },

  escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  },

  /**
   * Desktop card
   *   t: trade object (must have _id or tradeId, buyPrice, buyQty, targetSellPrice, symbol, timeframe, state, buyOrderId, sellOrderId?, retryCount?, botRetryMax?, error?, buyFilledAt?, buyPlacedAt?, createdAt?)
   *   currentPrice: number (mark-to-market)
   *   opts:
   *     - botName: string|null — ชื่อบอท (แสดง ribbon ด้านล่าง sym-tag)
   *     - botLink: bool — ทำให้ sym-tag เป็น link ไป /bot-detail.html?id=<botId>
   *     - showRetry: bool (default false) — แสดง retry pill "🔄 N/M"
   *     - forceCloseBtnClass: string (default 'btn-force-close') — class ของปุ่ม Force Close (ใช้แยก event listener ระหว่าง modal)
   *     - retryMax: number — ถ้าไม่ใส่ t.botRetryMax
   */
  renderCard(t, currentPrice, opts = {}) {
    const m = this.computeMetrics(t, currentPrice);
    const ageTxt = m.durMs > 0 ? this.formatDuration(m.durMs) : '—';
    const thbUpnl = window.usdtToThb ? window.usdtToThb(m.unrealizedUsdt) : '';
    const thbPx = window.usdtToThb ? window.usdtToThb(m.px) : '';
    const thbVal = window.usdtToThb ? window.usdtToThb(m.entry * m.qty) : '';
    const pnlCls = m.pnlPct >= 0 ? 'pnl-bull' : 'pnl-bear';
    const pnlSign = m.pnlPct >= 0 ? '+' : '';
    const barPct = Math.round(m.barPct || 0);

    // FIX-2026-08-01: SL-armed badge (F1) — แสดงเมื่อ trade.useStopLossOnUKC === true
    //   - คำนวณจาก backend (trader.js _autoArmStopLossOnUKC) เมื่อ position ขาดทุน > loss% + age > age ชม.
    //   - แสดง 🛡️ Au pill + .is-sl-armed class (CSS border highlight)
    //   - threshold mirror ในฝั่ง client เพื่อ defensive UX: ถ้า threshold ตรง + flag ยังไม่มา → ก็ highlight รอ
    // FIX-2026-08-03: per-trade snapshot fields (autoArmLossPct / autoArmAgeHours) override hardcoded defaults
    //   - ก่อนหน้านี้ STUCK_LOSS_THRESHOLD_PCT = 10 + STUCK_AGE_THRESHOLD_MS = 4h ตายตัว
    //   - ตอนนี้ backend snapshot thresholds ตอน arm (เก็บใน trade.autoArmLossPct / autoArmAgeHours) — fallback 10% / 4h ถ้า field ว่าง
    const armedAt = t.autoArmedAt ? new Date(t.autoArmedAt) : null;
    const isArmed = t.useStopLossOnUKC === true;
    const STUCK_LOSS_THRESHOLD_PCT = (typeof t.autoArmLossPct === 'number' && t.autoArmLossPct > 0)
      ? t.autoArmLossPct : 10;
    const STUCK_AGE_THRESHOLD_MS = (typeof t.autoArmAgeHours === 'number' && t.autoArmAgeHours > 0)
      ? t.autoArmAgeHours * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
    const stuckLike = !isArmed
      && m.pnlPct <= -STUCK_LOSS_THRESHOLD_PCT
      && m.durMs >= STUCK_AGE_THRESHOLD_MS
      && (t.state === 'selling' || t.state === 'holding' || t.state === 'filled');
    const slArmedCls = isArmed ? 'is-sl-armed' : (stuckLike ? 'is-stuck-likely' : '');

    let tpLabel;
    if (m.pctToTp == null) tpLabel = '⚠️ รอ BUY fill';
    else if (m.tpReached) tpLabel = '🎯 ถึง TP แล้ว!';
    else tpLabel = `ต้องขึ้นอีก ${m.pctToTp.toFixed(3)}% ถึง TP`;

    let progressSub;
    if (m.tp > 0) {
      progressSub = `TP at ${PriceFormat.format(m.tp, m.symbol)} · path เดิม ${m.totalPathPct >= 0 ? '+' : ''}${m.totalPathPct.toFixed(3)}%`;
    } else {
      progressSub = 'TP ยังไม่ตั้ง';
    }

    let tpSub;
    if (m.tp > 0) {
      if (m.tpReached) {
        tpSub = `เกิน TP แล้ว +${(-((m.px - m.tp) / m.tp) * 100).toFixed(3)}%`;
      } else {
        tpSub = `${m.totalPathPct >= 0 ? '+' : ''}${m.totalPathPct.toFixed(3)}% above entry`;
      }
    } else {
      tpSub = 'ยังไม่ได้ตั้ง (รอ BUY fill)';
    }

    const entrySub = t.buyFilledAt
      ? `filled ${this.fmtDateTime(t.buyFilledAt)}`
      : (t.buyPlacedAt ? `placed ${this.fmtDateTime(t.buyPlacedAt)}` : 'placed');

    const tradeId = String(t._id || t.tradeId || '');
    const botId = String(t.botId || '');
    const symTagHref = opts.botLink && botId ? `/bot-detail.html?id=${botId}` : '#';
    const symTag = opts.botLink
      ? `<a class="sym-tag" href="${this.escapeHtml(symTagHref)}" style="text-decoration:none;">${this.escapeHtml(t.symbol || '-')}</a>`
      : `<span class="sym-tag">${this.escapeHtml(t.symbol || '-')}</span>`;
    const stateColor = this.STATE_COLORS[t.state] || '';
    const fcCls = opts.forceCloseBtnClass || 'btn-force-close';
    const retryMax = (t.botRetryMax != null ? t.botRetryMax : (opts.retryMax != null ? opts.retryMax : 1));

    // FIX-2026-08-03: Chart button — deep-link ไป /chart.html?symbol=XXX&tf=YYY
    //   - target=_blank เปิดแท็บใหม่ (กัน modal ปิด/เปิดใหม่ + ให้ user ดูคู่กันได้)
    //   - ใช้ในหน้า bots.html (cross-bot Open Positions modal) ผ่าน opts.chartBtnClass
    const chartCls = opts.chartBtnClass || 'btn-chart-link';
    const chartHref = (t.symbol && t.timeframe)
      ? `/chart.html?symbol=${encodeURIComponent(t.symbol)}&tf=${encodeURIComponent(t.timeframe)}`
      : '#';

    // FIX-2026-08-01: SL-armed pill — tooltip บอก armed-at + reason
    const slArmedPill = isArmed
      ? `<span class="sl-armed-pill" title="Auto-armed SL-on-UKC (loss>10% & age>4h) — armed ${armedAt ? this.fmtDateTime(armedAt) : ''}">🛡️ Au</span>`
      : (stuckLike
        ? `<span class="sl-armed-pill is-pending" title="ยังไม่ได้ arm — รอ candle close ถัดไป (loss>10% + age>4h)">⏳ Au-pending</span>`
        : '');

    return `
      <div class="position-card ${pnlCls} ${slArmedCls}" data-trade-id="${this.escapeHtml(tradeId)}" data-bot-id="${this.escapeHtml(botId)}">
        <div class="pos-head">
          <div class="left">
            ${symTag}
            <span class="tf-tag">${this.escapeHtml(t.timeframe || '-')}</span>
            <span class="status-pill is-${stateColor}">${this.escapeHtml(t.state || '-')}</span>
            ${slArmedPill}
            ${opts.showRetry ? `<span class="retry-pill" title="retry slots">🔄 ${t.retryCount ?? 0}/${retryMax}</span>` : ''}
          </div>
          <div class="right">
            <span class="pos-age" title="เปิดมานาน"><span class="age-icon">⏱</span> ${ageTxt}</span>
          </div>
        </div>
        ${opts.botName ? `<div class="pos-bot-name">${this.escapeHtml(opts.botName)}</div>` : ''}
        <div class="pos-grid">
          <div class="cell">
            <span class="k">Entry</span>
            <span class="v mono">${m.entry > 0 ? PriceFormat.format(m.entry, m.symbol) : '-'}</span>
            <span class="sub">${entrySub}</span>
          </div>
          <div class="cell">
            <span class="k">Qty</span>
            <span class="v mono">${m.qty > 0 ? m.qty.toFixed(6) : '-'}</span>
            <span class="sub">${thbVal ? `≈ ${thbVal} (THB)` : `≈ ${(m.qty * m.entry).toFixed(2)} USDT`}</span>
          </div>
          <div class="cell">
            <span class="k">Current</span>
            <span class="v mono ${pnlCls}">${m.px > 0 ? PriceFormat.format(m.px, m.symbol) : '-'}</span>
            ${thbPx ? `<span class="sub thb-eq">${thbPx}</span>` : ''}
          </div>
          <div class="cell">
            <span class="k">TP Target</span>
            <span class="v mono">${m.tp > 0 ? PriceFormat.format(m.tp, m.symbol) : '—'}</span>
            <span class="sub">${tpSub}</span>
          </div>
          <div class="cell">
            <span class="k">Unrealized PnL</span>
            <span class="v mono ${pnlCls}">${pnlSign}${m.unrealizedUsdt.toFixed(4)} USDT</span>
            ${thbUpnl ? `<span class="sub thb-eq">${thbUpnl}</span>` : ''}
          </div>
          <div class="cell">
            <span class="k">% PnL</span>
            <span class="v mono ${pnlCls}">${pnlSign}${m.pnlPct.toFixed(3)}%</span>
          </div>
        </div>
        <div class="pos-progress">
          <div class="pos-progress-label ${m.tpReached ? 'tp-reached' : ''}">
            <span>${tpLabel}</span>
            ${m.tp > 0 ? `<span class="text-muted-3" style="font-size:0.7rem;">${progressSub}</span>` : ''}
          </div>
          <div class="pct-bar" title="bar = % ระยะที่เหลือจากราคาปัจจุบันไปยัง TP (100% = เพิ่งเปิด, 0% = ถึง TP)">
            <div class="pct-bar-fill ${pnlCls}" style="width:${barPct}%;"></div>
          </div>
        </div>
        <div class="pos-foot">
          <span class="pair"><span>Order:</span><strong class="code">${this.escapeHtml(t.buyOrderId || '—')}</strong></span>
          ${t.sellOrderId ? `<span class="pair"><span>SELL:</span><strong class="code">${this.escapeHtml(t.sellOrderId)}</strong></span>` : ''}
          ${t.error ? `<span class="last-err">⚠️ ${this.escapeHtml(t.error)}</span>` : ''}
          <a class="btn-lux btn-info btn-sm ${chartCls}" href="${this.escapeHtml(chartHref)}" target="_blank" rel="noopener" data-trade-id="${this.escapeHtml(tradeId)}" title="เปิดกราฟ ${this.escapeHtml(t.symbol || '')} ${this.escapeHtml(t.timeframe || '')} ในแท็บใหม่">📈 Chart</a>
          <button type="button" class="btn-lux btn-bear btn-sm ${fcCls}" data-trade-id="${this.escapeHtml(tradeId)}" data-bot-id="${this.escapeHtml(botId)}" title="บังคับปิดไม้นี้ (ยกเลิก SELL + MARKET SELL หรือ synthetic close)">🛑 Force Close</button>
        </div>
      </div>`;
  },

  /**
   * Mobile card — stacked layout (1 column, .position-mob class for left border color)
   */
  renderCardMobile(t, currentPrice, opts = {}) {
    const m = this.computeMetrics(t, currentPrice);
    const ageTxt = m.durMs > 0 ? this.formatDuration(m.durMs) : '—';
    const thbUpnl = window.usdtToThb ? window.usdtToThb(m.unrealizedUsdt) : '';
    const pnlCls = m.pnlPct >= 0 ? 'pnl-bull' : 'pnl-bear';
    const pnlSign = m.pnlPct >= 0 ? '+' : '';
    const barPct = Math.round(m.barPct || 0);

    // FIX-2026-08-01: SL-armed detection (mirror desktop)
    const armedAt = t.autoArmedAt ? new Date(t.autoArmedAt) : null;
    const isArmed = t.useStopLossOnUKC === true;
    const STUCK_LOSS_THRESHOLD_PCT = 10;
    const STUCK_AGE_THRESHOLD_MS = 4 * 60 * 60 * 1000;
    const stuckLike = !isArmed
      && m.pnlPct <= -STUCK_LOSS_THRESHOLD_PCT
      && m.durMs >= STUCK_AGE_THRESHOLD_MS
      && (t.state === 'selling' || t.state === 'holding' || t.state === 'filled');
    const slArmedCls = isArmed ? 'is-sl-armed' : (stuckLike ? 'is-stuck-likely' : '');

    let tpLabel;
    if (m.pctToTp == null) tpLabel = '⚠️ รอ BUY fill';
    else if (m.tpReached) tpLabel = '🎯 ถึง TP แล้ว!';
    else tpLabel = `ต้องขึ้นอีก ${m.pctToTp.toFixed(3)}%`;

    const tradeId = String(t._id || t.tradeId || '');
    const botId = String(t.botId || '');
    const stateColor = this.STATE_COLORS[t.state] || '';
    const fcCls = opts.forceCloseBtnClass || 'btn-force-close';
    const retryMax = (t.botRetryMax != null ? t.botRetryMax : (opts.retryMax != null ? opts.retryMax : 1));

    // FIX-2026-08-03: Chart button (mobile) — mirror desktop
    const chartCls = opts.chartBtnClass || 'btn-chart-link';
    const chartHref = (t.symbol && t.timeframe)
      ? `/chart.html?symbol=${encodeURIComponent(t.symbol)}&tf=${encodeURIComponent(t.timeframe)}`
      : '#';

    const slArmedPill = isArmed
      ? `<span class="sl-armed-pill" title="Auto-armed SL-on-UKC — armed ${armedAt ? this.fmtDateTime(armedAt) : ''}">🛡️ Au</span>`
      : (stuckLike
        ? `<span class="sl-armed-pill is-pending" title="ยังไม่ได้ arm — รอ candle close ถัดไป">⏳ Au-pending</span>`
        : '');

    return `
      <div class="mob-card position-mob ${pnlCls} ${slArmedCls}" data-trade-id="${this.escapeHtml(tradeId)}" data-bot-id="${this.escapeHtml(botId)}">
        <div class="top">
          <span class="status-pill is-${stateColor}">${this.escapeHtml(t.state || '-')}</span>
          ${slArmedPill}
          <span class="ts" style="color:var(--text-3);font-size:0.72rem;">⏱ ${ageTxt} · 🔄 ${t.retryCount ?? 0}/${retryMax}</span>
        </div>
        <div class="row"><span class="k">Symbol</span><span class="v mono">${this.escapeHtml(t.symbol || '-')} · ${this.escapeHtml(t.timeframe || '-')}</span></div>
        ${opts.botName ? `<div class="row"><span class="k">บอท</span><span class="v" style="color:var(--gold-2);font-weight:600;">${this.escapeHtml(opts.botName)}</span></div>` : ''}
        <div class="row"><span class="k">Entry</span><span class="v">${m.entry > 0 ? PriceFormat.format(m.entry, m.symbol) : '-'}</span></div>
        <div class="row"><span class="k">Qty</span><span class="v">${m.qty > 0 ? m.qty.toFixed(6) : '-'}</span></div>
        <div class="row"><span class="k">Current</span><span class="v ${pnlCls}">${m.px > 0 ? PriceFormat.format(m.px, m.symbol) : '-'}</span></div>
        <div class="row"><span class="k">TP Target</span><span class="v">${m.tp > 0 ? PriceFormat.format(m.tp, m.symbol) : '—'}</span></div>
        <div class="row"><span class="k">% PnL</span><span class="v ${pnlCls}">${pnlSign}${m.pnlPct.toFixed(3)}%</span></div>
        <div class="row"><span class="k">Unrealized</span><span class="v ${pnlCls}">${pnlSign}${m.unrealizedUsdt.toFixed(4)} USDT${thbUpnl ? ` (${thbUpnl})` : ''}</span></div>
        <div class="row"><span class="k">Order</span><span class="v code">${this.escapeHtml(t.buyOrderId || '—')}</span></div>
        <div class="row"><span class="k">% to TP</span><span class="v ${m.tpReached ? 'tp-reached' : ''}">${m.pctToTp == null ? '—' : `${m.pctToTp.toFixed(3)}%`}</span></div>
        <div class="pos-progress" style="margin-top:0.5rem;">
          <div class="pct-bar"><div class="pct-bar-fill ${pnlCls}" style="width:${barPct}%;"></div></div>
          <div class="pos-progress-label ${m.tpReached ? 'tp-reached' : ''}" style="margin-top:0.25rem;font-size:0.72rem;">
            ${tpLabel}
          </div>
        </div>
        <div style="margin-top:0.5rem;text-align:right;">
          <a class="btn-lux btn-info btn-sm ${chartCls}" href="${this.escapeHtml(chartHref)}" target="_blank" rel="noopener" data-trade-id="${this.escapeHtml(tradeId)}" title="เปิดกราฟ ${this.escapeHtml(t.symbol || '')} ${this.escapeHtml(t.timeframe || '')} ในแท็บใหม่">📈 Chart</a>
          <button type="button" class="btn-lux btn-bear btn-sm ${fcCls}" data-trade-id="${this.escapeHtml(tradeId)}" data-bot-id="${this.escapeHtml(botId)}" title="บังคับปิดไม้นี้">🛑 Force Close</button>
        </div>
      </div>`;
  },
};
