'use strict';

/* ─────────────────────────────────────────────────────────
   SellReason — shared label/emoji/color map + render function
   ───────────────────────────────────────────────────────── */

(function () {
  // FIX-2026-08-01: structured sellReason tracking — ทุก SELL fill ต้องบอกได้ว่ามาจากอะไร
  //   - enum values mirror backend src/db/models/Trade.js SELL_REASONS
  //   - label = short tag shown in pill (e.g. "TP", "CB")
  //   - emoji = companion icon (1 char)
  //   - category = CSS suffix for color (bull/bear/warn/manual/neutral)
  //   - tooltip = full explanation (shown on hover)
  const SELL_REASONS = {
    tp_hit:                  { label: 'TP',     emoji: '🎯', category: 'bull',    tooltip: 'TP target hit (normal LIMIT_MAKER fill)' },
    tp_trend_boosted:        { label: 'TP+',    emoji: '🎯', category: 'bull',    tooltip: 'TP hit with tpTrendMultiplier > 1 (trend-boosted)' },
    cb_panic:                { label: 'CB',     emoji: '🚨', category: 'bear',    tooltip: 'Circuit-breaker (3-candle lowerKC breach) — panic-close ALL positions' },
    // FIX-2026-08-07: CBv2 sustained panic-sell (4 consecutive red candles below lowerKC) + cooldown BUY (HYBRID)
    cbv2_panic:              { label: 'CBv2',   emoji: '💎', category: 'bear',    tooltip: 'CBv2 sustained panic-sell (4 consecutive red candles below lowerKC) + cooldown S1 BUY for cbv2LockHours hours (HYBRID — bot stays enabled)' },
    stop_loss_upper_kc:      { label: 'SL',     emoji: '🛑', category: 'bear',    tooltip: 'Stop-loss on upper-KC (close > upperKC + position at loss)' },
    market_fallback:         { label: 'MKT',    emoji: '⚠️', category: 'warn',    tooltip: 'MARKET fallback (LIMIT rejected / MIN_NOTIONAL breach / validation fail)' },
    manual_api_market:       { label: 'API',    emoji: '🔧', category: 'manual',  tooltip: 'Manual close via API (MARKET branch)' },
    manual_api_synthetic:    { label: 'API-S',  emoji: '🔧', category: 'manual',  tooltip: 'Manual close via API (synthetic — asset missing on exchange)' },
    race_recovery_filled:    { label: 'RACE',   emoji: '🏁', category: 'neutral', tooltip: 'Race recovery — SELL already FILLED at TP before stop-loss cancelled' },
    holding_retry_recovered: { label: 'HOLD-R', emoji: '🔄', category: 'neutral', tooltip: 'Holding retry recovered via MARKET (after WS disconnects)' },
    holding_retry_exhausted: { label: 'HOLD-X', emoji: '❌', category: 'warn',    tooltip: 'Holding retry exhausted (10x — gave up)' },
    partial_sell_finalized:  { label: 'PART',   emoji: '⏸', category: 'neutral', tooltip: 'Partial-sell freeze deadline finalization (MARKET filled remaining)' },
    bot_disabled:            { label: 'OFF',    emoji: '⛔', category: 'bear',    tooltip: 'Bot disabled — forced close all positions' },
    // FIX-2026-08-02: DCA stack reasons — TP-fill closes whole stack (single SELL covers all layers)
    dca_target_hit:          { label: 'DCA-TP', emoji: '📚', category: 'bull',    tooltip: 'DCA stack closed at BEP+TP (aggregate SELL filled)' },
    dca_stack_force_close:   { label: 'DCA-FC', emoji: '📚', category: 'manual',  tooltip: 'DCA stack force-closed (manual API / bot disable) — uses stack BEP' },
    dca_stack_stop_loss:     { label: 'DCA-SL', emoji: '📚', category: 'bear',    tooltip: 'DCA stack SL-UKC force-close (stackBEP > close, loss) — uses stack BEP' },
    unknown:                 { label: '?',      emoji: '❓', category: 'neutral', tooltip: 'Unknown sell reason (derive fallback)' },
  };

  function escape(s) {
    return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // FIX-2026-08-01: renderSellReasonPill(reason, detail) → HTML string
  //   - reason null/undefined → "—" placeholder (backwards compat: old trades)
  //   - reason unknown enum → fall back to 'unknown' meta
  //   - detail appended to tooltip (truncated at 200 chars)
  function renderSellReasonPill(reason, detail) {
    if (!reason) return '<span class="muted">—</span>';
    const meta = SELL_REASONS[reason] || SELL_REASONS.unknown;
    let tip = meta.tooltip;
    if (detail) {
      const d = String(detail);
      tip += ' — ' + (d.length > 200 ? d.slice(0, 199) + '…' : d);
    }
    return `<span class="sell-reason-pill is-${meta.category}" title="${escape(tip)}">${meta.emoji} ${meta.label}</span>`;
  }

  // FIX-2026-08-01: lookupMeta(reason) → raw meta object (for telegram / logger / etc.)
  function lookupMeta(reason) {
    return SELL_REASONS[reason] || SELL_REASONS.unknown;
  }

  window.SellReasons = {
    SELL_REASONS,
    renderSellReasonPill,
    lookupMeta,
  };
})();
