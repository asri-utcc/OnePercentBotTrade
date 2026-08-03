'use strict';
/**
 * 2026-08-02: DCA stack card partial — mirrors positionCard.js shape.
 *   - Renders current DCA stack state: layer count, BEP, target SELL, partial-fill frozen flag
 *   - Reuses same CSS classes (.position-card, .pos-grid, .pos-head, .pos-foot) for consistency
 *   - Shows per-layer breakdown table when buyLayers[] present
 *
 *   Usage: bot-detail.html renders this card when bot.dcaEnabled === true AND an open stack exists.
 *          Falls through to existing PositionCard for non-DCA bots (no behavior change).
 */

window.StackCard = {
  OPEN_DCA_STATES: ['placed', 'filled', 'holding', 'selling', 'retrying', 'partial_wait', 'partial_sell_wait', 'stopping'],

  escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  fmtDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString();
  },

  fmtDur(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  },

  computeMetrics(stack, currentPrice) {
    const bep = Number(stack.stackBep) || 0;
    const totalQty = Number(stack.stackTotalQty) || 0;
    const totalSpent = Number(stack.stackTotalSpent) || 0;
    const tp = Number(stack.stackTargetSellPrice) || 0;
    const px = (currentPrice && currentPrice > 0) ? currentPrice : bep;

    const pnlPct = bep > 0 ? ((px - bep) / bep) * 100 : 0;
    const unrealizedUsdt = (px - bep) * totalQty;

    let pctToTp = null;
    let tpReached = false;
    let totalPathPct = bep > 0 && tp > 0 ? ((tp - bep) / bep) * 100 : 0;
    if (tp > 0 && px > 0) {
      if (px >= tp) {
        tpReached = true;
        pctToTp = 0;
      } else {
        pctToTp = ((tp - px) / px) * 100;
      }
    }

    return { bep, totalQty, totalSpent, tp, px, pnlPct, unrealizedUsdt, pctToTp, tpReached, totalPathPct };
  },

  renderCard(stack, currentPrice, opts = {}) {
    const m = this.computeMetrics(stack, currentPrice);
    const maxLayers = (opts.maxLayers != null ? opts.maxLayers : 3);
    const layerCount = Number(stack.dcaLayerCount) || stack.buyLayers?.length || 0;
    const isFrozen = !!stack.sellPartialLatchedAt || !!stack.sellPartialDetectedAt;
    const slArmed = !!stack.useStopLossOnUKC;
    const trendMult = Number(stack.tpTrendMultiplier) || 1;

    const pnlCls = m.unrealizedUsdt > 0 ? 'pnl-bull' : (m.unrealizedUsdt < 0 ? 'pnl-bear' : '');

    // age from first layer
    let ageMs = 0;
    if (stack.buyLayers && stack.buyLayers.length > 0) {
      const first = stack.buyLayers[0].filledAt || stack.buyLayers[0].placedAt || stack.openedAt;
      if (first) ageMs = Date.now() - new Date(first).getTime();
    } else if (stack.openedAt) {
      ageMs = Date.now() - new Date(stack.openedAt).getTime();
    }
    const ageTxt = this.fmtDur(ageMs);

    let tpLabel;
    if (m.tpReached) tpLabel = '🎯 ถึง TP แล้ว!';
    else if (m.pctToTp != null) tpLabel = `ต้องขึ้นอีก ${m.pctToTp.toFixed(3)}% ถึง TP`;
    else tpLabel = '⚠️ รอ layer fill';

    const layersHtml = (stack.buyLayers || []).map((ly) => {
      const filledAt = ly.filledAt ? this.fmtDateTime(ly.filledAt) : '-';
      const px = Number(ly.price) || 0;
      const qty = Number(ly.qty) || 0;
      return `<tr>
        <td>${ly.layerIndex ?? '-'}</td>
        <td class="mono">${px > 0 ? px.toFixed(8) : '-'}</td>
        <td class="mono">${qty.toFixed(6)}</td>
        <td>${filledAt}</td>
      </tr>`;
    }).join('');

    const layersTable = layersHtml ? `
      <div class="stack-layers-wrap">
        <div class="k">Per-layer</div>
        <table class="stack-layers">
          <thead><tr><th>L</th><th>Price</th><th>Qty</th><th>Filled at</th></tr></thead>
          <tbody>${layersHtml}</tbody>
        </table>
      </div>` : '';

    const trendTag = trendMult > 1 ? `<span class="trend-pill" title="TP trend multiplier applied">×${trendMult.toFixed(1)}</span>` : '';
    const slArmedPill = slArmed
      ? `<span class="sl-armed-pill" title="SL-UKC armed on stack BEP">🛡️ Au</span>`
      : '';
    const frozenPill = isFrozen
      ? `<span class="frozen-pill" title="SELL partial-fill frozen (no cancel, no replace)">🧊 Frozen</span>`
      : '';

    const tradeId = String(stack._id || stack.tradeId || '');
    const botId = String(stack.botId || '');

    return `
      <div class="position-card ${pnlCls}" data-trade-id="${this.escapeHtml(tradeId)}" data-bot-id="${this.escapeHtml(botId)}">
        <div class="pos-head">
          <div class="left">
            <span class="sym-tag">${this.escapeHtml(stack.symbol || '-')}</span>
            <span class="tf-tag">${this.escapeHtml(stack.timeframe || '-')}</span>
            <span class="status-pill is-${stack.state || 'selling'}">${this.escapeHtml(stack.state || '-')}</span>
            <span class="dca-pill" title="DCA stack mode">📚 DCA ${layerCount}/${maxLayers}</span>
            ${slArmedPill}
            ${frozenPill}
            ${trendTag}
          </div>
          <div class="right">
            <span class="pos-age" title="เปิดมานาน"><span class="age-icon">⏱</span> ${ageTxt}</span>
          </div>
        </div>
        <div class="pos-grid">
          <div class="cell">
            <span class="k">BEP (avg)</span>
            <span class="v mono">${m.bep > 0 ? (window.PriceFormat?.format(m.bep, stack.symbol) || m.bep.toFixed(8)) : '-'}</span>
            <span class="sub">${layerCount} layer${layerCount === 1 ? '' : 's'}</span>
          </div>
          <div class="cell">
            <span class="k">Total Qty</span>
            <span class="v mono">${m.totalQty > 0 ? m.totalQty.toFixed(6) : '-'}</span>
            <span class="sub">≈ ${m.totalSpent.toFixed(2)} USDT spent</span>
          </div>
          <div class="cell">
            <span class="k">Current</span>
            <span class="v mono ${pnlCls}">${m.px > 0 ? (window.PriceFormat?.format(m.px, stack.symbol) || m.px.toFixed(8)) : '-'}</span>
            <span class="sub">vs BEP ${m.pnlPct >= 0 ? '+' : ''}${m.pnlPct.toFixed(3)}%</span>
          </div>
          <div class="cell">
            <span class="k">TP Target</span>
            <span class="v mono">${m.tp > 0 ? (window.PriceFormat?.format(m.tp, stack.symbol) || m.tp.toFixed(8)) : '—'}</span>
            <span class="sub">${tpLabel}</span>
          </div>
          <div class="cell">
            <span class="k">Unrealized PnL</span>
            <span class="v mono ${pnlCls}">${m.unrealizedUsdt >= 0 ? '+' : ''}${m.unrealizedUsdt.toFixed(4)} USDT</span>
            <span class="sub">on ${m.totalQty.toFixed(4)} ${(stack.symbol || '').replace(/USDT$/, '')}</span>
          </div>
        </div>
        ${layersTable}
        <div class="pos-foot">
          <div class="foot-meta">
            ${stack.sellOrderId ? `<span title="SELL order id">🎯 SELL #${this.escapeHtml(String(stack.sellOrderId).slice(-8))}</span>` : ''}
            ${stack.stackId ? `<span title="stackId">stack ${this.escapeHtml(String(stack.stackId).slice(-8))}</span>` : ''}
          </div>
          <div class="foot-actions">
            <button class="btn btn-sm btn-force-close-dca" data-trade-id="${this.escapeHtml(tradeId)}" data-bot-id="${this.escapeHtml(botId)}">
              Force Close Stack
            </button>
          </div>
        </div>
      </div>
    `;
  },

  renderCardMobile(stack, currentPrice, opts = {}) {
    // Compact version — same as renderCard but in single column
    const html = this.renderCard(stack, currentPrice, opts);
    return html;
  },
};
