'use strict';

const urlParams = new URLSearchParams(location.search);
const botId = urlParams.get('id');
let bot = null;
// FIX-2026-08-02: Tab state — always defaults to classic on page load (no localStorage persistence)
let activeTab = 'classic'; // 'classic' | 'dca'

async function init() {
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me || !me.authenticated) {
    location.href = '/login.html';
    return;
  }
  if (!botId) {
    location.href = '/bots.html';
    return;
  }

  await loadBot();
}

async function loadBot() {
  try {
    // FIX-2026-08-08: fetch bot + AppConfig in parallel (cbVersion is global — needed to render the correct CB section)
    const [resp, cfgResp] = await Promise.all([
      API.get(`/api/bots/${botId}`),
      API.get('/api/admin/app-config').catch(() => ({ config: {} })),
    ]);
    bot = resp.bot;
    bot.cbVersion = cfgResp?.config?.cbVersion || 'v3';
    render();
  } catch (err) {
    document.getElementById('bot-edit-content').innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

function render() {
  const container = document.getElementById('bot-edit-content');
  const hasActiveCbCooldown = [bot.cbv2LockedUntil, bot.cbv3LockedUntil]
    .some((until) => until && new Date(until).getTime() > Date.now());
  // FIX-2026-08-03: tab-based layout — Classic + DCA tabs (single <form> wraps both panels)
  container.innerHTML = `
    <div class="lux-header"><span class="title">⚙️ ${escapeHtml(bot.name || bot.symbol)}</span><span class="text-muted-3" style="font-size:0.78rem;">${escapeHtml(bot.symbol)} · ${escapeHtml(bot.timeframe)}</span></div>
    <div class="lux-body">
    <form id="edit-form">
      <!-- TAB BAR — reuses .lux-tabs pattern from bot-detail.html -->
      <div class="lux-tabs" id="edit-tabs">
        <button type="button" class="lux-tab active" data-tab="classic">⚙️ ตั้งค่าบอท</button>
        <button type="button" class="lux-tab" data-tab="dca">📚 DCA + BEP Stack <span class="badge" id="dca-state-badge">${bot.dcaEnabled ? 'ON' : 'OFF'}</span></button>
      </div>

      <!-- TAB PANEL 1: Classic (default visible) -->
      <section data-tab-panel="classic" class="bot-settings-form">
        <details class="lux-details" id="f-group-basic" data-settings-group="basic" open>
          <summary class="lux-details-summary">
            <span class="bot-settings-group-icon">🪪</span>
            <span class="bot-settings-group-title">ข้อมูลบอทและเงินทุน</span>
            <span class="bot-settings-group-hint">ชื่อ · คู่เทรด · Timeframe · ทุน</span>
          </summary>
          <div class="lux-details-body">
            <div class="bot-settings-grid">
              <div class="bot-settings-field is-full">
                <label class="form-label" for="f-name">ชื่อบอท</label>
                <input type="text" class="form-control" id="f-name" value="${escapeHtml(bot.name || '')}" />
              </div>
              <div class="bot-settings-field">
                <label class="form-label">คู่เทรด (แก้ไขไม่ได้)</label>
                <input type="text" class="form-control" value="${escapeHtml(bot.symbol)}" disabled />
              </div>
              <div class="bot-settings-field">
                <label class="form-label" for="f-timeframe">กรอบเวลา (Timeframe)</label>
                <select class="form-select" id="f-timeframe">
                  ${['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'].map((tf) =>
                    `<option value="${tf}" ${tf === bot.timeframe ? 'selected' : ''}>${tf}</option>`
                  ).join('')}
                </select>
              </div>
              <div class="bot-settings-field">
                <label class="form-label" for="f-capital">ทุนต่อไม้ (USDT)</label>
                <input type="number" class="form-control" id="f-capital" value="${bot.capitalPerTrade}" step="0.01" min="1" />
              </div>
              <div class="bot-settings-field">
                <label class="form-label" for="f-maxtrades">จำนวนไม้สูงสุด</label>
                <input type="number" class="form-control" id="f-maxtrades" value="${bot.maxTrades}" step="1" min="1" max="100" />
              </div>
              <!-- FIX-2026-09-02: Round-down Capital (opt-in per-bot) — ลด notional ให้พอดียอดคงเหลือเมื่อเงินไม่พอ -->
              <div class="bot-settings-option is-full">
                <label class="form-check form-switch mb-0">
                  <input type="checkbox" class="form-check-input" id="f-round-down-capital-enabled" ${bot.roundDownCapitalEnabled ? 'checked' : ''} />
                  <span class="form-check-label">💸 <strong>Round-down ทุนเมื่อเงินไม่พอ</strong> — ปรับ notional ลงเพื่อให้เปิด order ได้</span>
                </label>
                <div class="bot-settings-dependent">
                  <label class="form-label" for="f-round-down-capital-min">ขั้นต่ำที่ round ได้ (USDT)</label>
                  <input type="number" class="form-control form-control-sm" id="f-round-down-capital-min" value="${bot.roundDownCapitalMin ?? 5.5}" step="0.1" min="1" max="10000" />
                  <small class="text-muted">ถ้า round แล้ว &lt; min → ยังคง skip signal (default 5.5)</small>
                </div>
              </div>
            </div>
          </div>
        </details>

        <details class="lux-details" id="f-group-entry" data-settings-group="entry">
          <summary class="lux-details-summary">
            <span class="bot-settings-group-icon">📥</span>
            <span class="bot-settings-group-title">เงื่อนไขเข้าและการวาง BUY</span>
            <span class="bot-settings-group-hint">S1 · XS1 · Retry · KC · Spread</span>
          </summary>
          <div class="lux-details-body">
            <div class="bot-settings-grid">
              <div class="bot-settings-field">
                <label class="form-label" for="f-retry">เวลารอก่อนลองซื้อใหม่ (นาที)</label>
                <input type="number" class="form-control" id="f-retry" value="${bot.retryTimeMin}" step="0.1" min="0.1" max="60" />
                <small class="text-muted">ทศนิยมได้ เช่น 0.5 = 30 วินาที</small>
              </div>
              <div class="bot-settings-field">
                <label class="form-label" for="f-retry-max">จำนวนครั้งที่ลองใหม่สูงสุด</label>
                <input type="number" class="form-control" id="f-retry-max" value="${bot.retryMax ?? 1}" step="1" min="0" max="10" />
                <small class="text-muted">0 = วางครั้งเดียว ไม่ retry</small>
              </div>
              <div class="bot-settings-field">
                <label class="form-label" for="f-kc-mult">ความกว้าง KC (Multiplier)</label>
                <input type="number" class="form-control" id="f-kc-mult" value="${bot.kcMult ?? 1.5}" step="0.1" min="0.5" max="5" />
                <small class="text-muted">ค่าน้อย = channel แคบและเกิด S1 บ่อยขึ้น</small>
              </div>
              <div class="bot-settings-field">
                <label class="form-label" for="f-min-spread">ระยะห่างราคา BUY ขั้นต่ำ (ticks)</label>
                <input type="number" class="form-control" id="f-min-spread" value="${bot.minSpreadTicks ?? 1}" step="1" min="0" max="10" />
                <small class="text-muted">0 = ไม่กรอง · 1 = ใช้ bid · 2 = ต้องมี margin 1 tick</small>
              </div>
              <div class="bot-settings-option is-full">
                <label class="form-check form-switch">
                  <input type="checkbox" class="form-check-input" id="f-s1-only-down" ${bot.s1OnlyDown ? 'checked' : ''} />
                  <span class="form-check-label">📉 <strong>S1 เฉพาะ bg 2→3 (ขาลง)</strong> — ข้าม bg 2→1 เพื่อลดการซื้อราคาสูง</span>
                </label>
                <small class="text-muted d-block mt-1">เปิด: รับเฉพาะ bg_prev=2 และ bg=3 · ปิด: รับทั้ง bg=1 และ bg=3</small>
              </div>
              <div class="bot-settings-option is-full">
                <label class="form-check form-switch">
                  <input type="checkbox" class="form-check-input" id="f-xs1-enabled" ${bot.xs1Enabled !== false ? 'checked' : ''} />
                  <span class="form-check-label">🚫 <strong>XS1 anti-dump gate</strong> — ข้าม S1 เมื่อพบ candle-wide dump</span>
                </label>
                <small class="text-muted d-block mt-1">ช่วยป้องกันการซื้อระหว่างราคากำลังไหลลงเร็ว</small>
              </div>
            </div>
          </div>
        </details>

        <details class="lux-details" id="f-group-tp" data-settings-group="tp" open>
          <summary class="lux-details-summary">
            <span class="bot-settings-group-icon">🎯</span>
            <span class="bot-settings-group-title">Take Profit และการขาย</span>
            <span class="bot-settings-group-hint">TP% สุทธิ · Auto-update · Trend ×N</span>
          </summary>
          <div class="lux-details-body">
            <div class="bot-settings-grid">
              <div class="bot-settings-field">
                <label class="form-label d-flex justify-content-between align-items-center" for="f-tp">
                  <span>กำไรเป้าหมายสุทธิ (TP%)</span>
                  <button type="button" class="btn btn-sm btn-outline-warning" id="f-tp-recommend" title="คำนวณ TP% จาก Min %KC + trend ของ upper-TF">✨ Get</button>
                </label>
                <input type="number" class="form-control" id="f-tp" value="${bot.tpPercent}" step="0.01" min="0.001" />
                <small class="text-muted" id="f-tp-hint">ระบบบวก fee buffer ให้ตอนคำนวณราคาขาย</small>
              </div>
              <div class="bot-settings-field">
                <label class="form-label" for="f-suggest-tp-window">ช่วงข้อมูลแนะนำ TP (แท่ง)</label>
                <input type="number" class="form-control" id="f-suggest-tp-window" value="${bot.suggestTpWindow ?? 500}" step="10" min="30" max="1000" />
                <small class="text-muted">จำนวนแท่งที่ใช้หา Min %KC สำหรับปุ่ม Get และ Auto-update</small>
              </div>
              <div class="bot-settings-option is-full">
                <label class="form-check form-switch">
                  <input type="checkbox" class="form-check-input" id="f-auto-update-tp" ${bot.autoUpdateTp ? 'checked' : ''} />
                  <span class="form-check-label">⏰ <strong>อัปเดต TP% อัตโนมัติทุกต้นชั่วโมง</strong></span>
                </label>
                <small class="text-muted d-block mt-1">
                  คำนวณใหม่จาก Min %KC และ EMA20 ของ upper-TF ทุก HH:00
                  ${bot.updateTpAt ? `· ล่าสุด: <strong>${new Date(bot.updateTpAt).toLocaleString('th-TH')}</strong>` : '· ยังไม่เคยอัปเดตอัตโนมัติ'}
                </small>
              </div>
              <div class="bot-settings-option is-full">
                <label class="form-check form-switch mb-0">
                  <input type="checkbox" class="form-check-input" id="f-tp-trend-enabled" ${bot.tpTrendEnabled !== false ? 'checked' : ''} />
                  <span class="form-check-label">📈 <strong>ขยาย TP ตามแนวโน้ม (Trend ×N)</strong></span>
                </label>
                <div class="bot-settings-dependent">
                  <label class="form-label" for="f-tp-trend-multiplier">ตัวคูณ TP เมื่อ upper-TF อยู่เหนือ EMA20</label>
                  <input type="number" class="form-control" id="f-tp-trend-multiplier" value="${bot.tpTrendMultiplier ?? 2}" step="0.1" min="1" max="10" />
                  <small class="text-muted">1 = ไม่คูณ · 2 = สองเท่า · มีผลเฉพาะ position ใหม่</small>
                </div>
              </div>
            </div>
          </div>
        </details>

        <details class="lux-details" id="f-group-automation" data-settings-group="automation">
          <summary class="lux-details-summary">
            <span class="bot-settings-group-icon">⚙️</span>
            <span class="bot-settings-group-title">ระบบอัตโนมัติและขนาด Position</span>
            <span class="bot-settings-group-hint">DPS · Auto-pause</span>
          </summary>
          <div class="lux-details-body">
            <div class="bot-settings-grid">
              <div class="bot-settings-option">
                <label class="form-check form-switch">
                  <input type="checkbox" class="form-check-input" id="f-dynamic-size-enabled" ${bot.dynamicSizeEnabled !== false ? 'checked' : ''} />
                  <span class="form-check-label">📊 <strong>Dynamic Position Sizing (DPS)</strong></span>
                </label>
                <small class="text-muted d-block mt-1">
                  ปรับทุนและจำนวนไม้ตามประวัติเทรด · ข้ามเมื่อใช้ DCA/Martingale
                  <br />Current: <code>$${bot.dynamicSizeEffective != null ? bot.dynamicSizeEffective : (bot.dynamicSizeCurrent != null ? bot.dynamicSizeCurrent : bot.capitalPerTrade)} × ${bot.dynamicLayersEffective != null ? bot.dynamicLayersEffective : (bot.dynamicLayersCurrent != null ? bot.dynamicLayersCurrent : bot.maxTrades)} layers</code>
                </small>
              </div>
              <div class="bot-settings-option">
                <label class="form-check form-switch mb-0">
                  <input type="checkbox" class="form-check-input" id="f-auto-pause-enabled" ${bot.autoPauseEnabled !== false ? 'checked' : ''} />
                  <span class="form-check-label">⏸️ <strong>หยุดบอทเมื่อ Min-%KC หรือ 24h Vol ต่ำ</strong></span>
                </label>
                <div class="bot-settings-dependent">
                  <div class="row g-2">
                    <div class="col-md-6">
                      <label class="form-label" for="f-auto-pause-min-kc">Min-%KC threshold (%)</label>
                      <input type="number" class="form-control form-control-sm" id="f-auto-pause-min-kc" value="${bot.autoPauseMinKcPct ?? 2}" step="0.1" min="0.1" max="50" />
                      <small class="text-muted">pause เมื่อ Keltner Channel width ต่ำกว่า</small>
                    </div>
                    <div class="col-md-6">
                      <label class="form-label" for="f-auto-pause-min-24h-vol">Min 24h Vol (USDT)</label>
                      <input type="number" class="form-control form-control-sm" id="f-auto-pause-min-24h-vol" value="${bot.autoPauseMin24hVolUsdt ?? 1000000}" step="1000" min="0" />
                      <small class="text-muted">pause เมื่อ 24h quote-volume ต่ำกว่า; resume ต้องผ่านทั้ง 2 เงื่อนไข</small>
                    </div>
                  </div>
                  <div class="form-check form-switch mt-2">
                    <input type="checkbox" class="form-check-input" id="f-auto-pause-adjust-enabled" ${bot.autoPauseAdjustEnabled !== false ? 'checked' : ''} />
                    <label class="form-check-label" for="f-auto-pause-adjust-enabled">🔧 <strong>ให้ Auto-adjust threshold</strong> (เมื่อ master เปิด)</label>
                    <small class="text-muted d-block mt-1">ระบบจะปรับ KC/Vol thresholds อัตโนมัติตามจำนวนบอทที่รัน — uncheck เพื่อ opt-out</small>
                  </div>
                </div>
              </div>
              <div class="bot-settings-option mt-2">
                <label class="form-label small mb-1" for="f-auto-timing-enabled">⏱️ <strong>Auto-Timing</strong> (heatmap-driven entry gate)</label>
                <select class="form-select form-select-sm" id="f-auto-timing-enabled" style="max-width:220px;">
                  <option value="inherit" ${bot.autoTimingEnabled === null || bot.autoTimingEnabled === undefined ? 'selected' : ''}>🟢 Inherit master (default)</option>
                  <option value="true" ${bot.autoTimingEnabled === true ? 'selected' : ''}>✅ Force ON for this bot</option>
                  <option value="false" ${bot.autoTimingEnabled === false ? 'selected' : ''}>🚫 Force OFF for this bot</option>
                </select>
                <small class="text-muted d-block mt-1">null = inherit AppConfig.autoTimingEnabled; true/false = explicit override. ต้องเปิด license feature <code>autoTiming</code> ด้วย</small>
                </div>
              </div>
            </div>
          </div>
        </details>

        <details class="lux-details" id="f-group-risk" data-settings-group="risk" ${hasActiveCbCooldown ? 'open' : ''}>
          <summary class="lux-details-summary">
            <span class="bot-settings-group-icon">🛑</span>
            <span class="bot-settings-group-title">Stop Loss และ Circuit Breaker</span>
            <span class="bot-settings-group-hint">SL-UKC · Auto-arm · CB · Cooldown</span>
          </summary>
          <div class="lux-details-body">
            <div class="bot-settings-grid">
              <div class="bot-settings-option is-full">
                <label class="form-check form-switch">
                  <input type="checkbox" class="form-check-input" id="f-stop-loss-upper-kc" ${bot.stopLossOnUpperKC ? 'checked' : ''} />
                  <span class="form-check-label">🛑 <strong>Stop Loss เมื่อแท่งปิดเหนือ Upper-KC</strong></span>
                </label>
                <small class="text-muted d-block mt-1">เมื่อ position ขาดทุนและแท่งปิดเหนือ Upper-KC ระบบจะยกเลิก SELL เดิมแล้ว MARKET SELL</small>
              </div>
              <div class="bot-settings-option is-full">
                <label class="form-check form-switch mb-0">
                  <input type="checkbox" class="form-check-input" id="f-auto-arm-stop-loss-ukc" ${bot.autoArmStopLossOnUKC !== false ? 'checked' : ''} />
                  <span class="form-check-label">🛡️ <strong>เปิดใช้ SL-UKC อัตโนมัติเมื่อขาดทุนนาน</strong></span>
                </label>
                <div class="bot-settings-dependent bot-settings-grid">
                  <div>
                    <label class="form-label" for="f-auto-arm-loss-pct">ขาดทุนขั้นต่ำ (%)</label>
                    <input type="number" class="form-control" id="f-auto-arm-loss-pct" value="${bot.autoArmLossPct ?? 10}" step="0.5" min="1" max="99" />
                  </div>
                  <div>
                    <label class="form-label" for="f-auto-arm-age-hours">อายุ Position ขั้นต่ำ (ชม.)</label>
                    <input type="number" class="form-control" id="f-auto-arm-age-hours" value="${bot.autoArmAgeHours ?? 4}" step="0.5" min="0.5" max="999" />
                  </div>
                </div>
                <small class="text-muted d-block mt-2">เมื่อครบทั้ง loss% และอายุ ระบบจะ arm safety flag ให้ position นั้น</small>
              </div>
              <div class="bot-settings-option is-full">
                <label class="form-check form-switch">
                  <input type="checkbox" class="form-check-input" id="f-sl-ukc-trigger-on-profit" ${bot.slUkcTriggerOnProfit ? 'checked' : ''} />
                  <span class="form-check-label">💰 <strong>ให้ SL-UKC ปิด Position ที่กำไรด้วย</strong></span>
                </label>
                <small class="text-muted d-block mt-1">เปิด = exit at upper band ทั้งกำไรและขาดทุน · DCA ใช้ BEP loss-only เสมอ</small>
              </div>
              <div class="bot-settings-option is-full">
                <label class="form-check form-switch">
                  <input type="checkbox" class="form-check-input" id="f-cb-enabled" ${bot.cbEnabled !== false ? 'checked' : ''} />
                  <span class="form-check-label">🚨 <strong>Circuit Breaker (CB)</strong> — Panic-sell เมื่อกราฟดิ่ง 3 แท่งติด</span>
                </label>
                <small class="text-muted d-block mt-1">DCA mode จะปิด CB อัตโนมัติ เพื่อคงนโยบาย no-cut-loss ของ stack</small>
              </div>

              ${bot.cbVersion === 'v2' ? `
              <div class="bot-settings-option is-full">
                <label class="form-check form-switch mb-0">
                  <input type="checkbox" class="form-check-input" id="f-cbv2-enabled" ${bot.cbv2Enabled !== false ? 'checked' : ''} />
                  <span class="form-check-label">💎 <strong>CBv2</strong> — Panic-sell 4 แท่ง + ล็อก S1 BUY</span>
                </label>
                <div class="bot-settings-dependent">
                  <label for="f-cbv2-lock-hours" class="form-label">ระยะเวลา Cooldown (ชั่วโมง)</label>
                  <input type="number" class="form-control form-control-sm" id="f-cbv2-lock-hours" min="0.5" max="168" step="0.5" value="${bot.cbv2LockHours != null ? bot.cbv2LockHours : 8}" />
                  <small class="text-muted">0.5–168 ชม. · บอทยัง enable และ Auto-pause/resume ยังทำงานแยก</small>
                </div>
                ${bot.cbv2LockedUntil && new Date(bot.cbv2LockedUntil).getTime() > Date.now() ? `
                <div class="alert alert-warning mt-2 mb-0 bc-cbv2-cooldown-banner" id="bc-cbv2-cooldown-banner">
                  <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
                    <div>
                      ⏸ <strong>CBv2 cooldown active</strong> until ${new Date(bot.cbv2LockedUntil).toLocaleString()}
                      <span class="text-muted ms-2" data-cbv2-countdown="${new Date(bot.cbv2LockedUntil).toISOString()}"></span>
                      <br /><small class="text-muted">เหตุผล: ${bot.cbv2LockReason || 'cbv2_panic'}</small>
                    </div>
                    <button type="button" class="btn btn-sm btn-outline-warning" id="btn-unlock-cbv2" onclick="unlockCBv2Now('${bot._id}')">🔓 ปลด Cooldown ตอนนี้</button>
                  </div>
                </div>` : ''}
              </div>
              ` : `
              <div class="bot-settings-option is-full">
                <label class="form-check form-switch mb-0">
                  <input type="checkbox" class="form-check-input" id="f-cbv3-enabled" ${bot.cbv3Enabled !== false ? 'checked' : ''} />
                  <span class="form-check-label">💎 <strong>CBv3</strong> — CBv2 + ST3 บน Upper-TF</span>
                </label>
                <div class="bot-settings-dependent">
                  <label for="f-cbv3-lock-hours" class="form-label">ระยะเวลา Cooldown (ชั่วโมง)</label>
                  <input type="number" class="form-control form-control-sm" id="f-cbv3-lock-hours" min="0.5" max="168" step="0.5" value="${bot.cbv3LockHours != null ? bot.cbv3LockHours : 8}" />
                  <small class="text-muted">0.5–168 ชม. · Active version: <span id="cbv-active-version-badge" class="lux-badge lux-badge-warn">${bot.cbVersion || 'v3'}</span></small>
                </div>
                ${bot.cbv3Enabled !== false && bot.safeTradeNoTradeEnabled !== true ? `
                <div class="alert alert-info mt-2 mb-0" role="alert" data-testid="cbv3-decoupled-info">
                  <small><strong>ℹ️ Decoupled mode:</strong> Safe Trade #3 ปิดอยู่ แต่ CBv3 ยังใช้ ST3 ภายในเพื่อเบรกเฉพาะเหวจริง</small>
                </div>` : ''}
                ${bot.cbv3LockedUntil && new Date(bot.cbv3LockedUntil).getTime() > Date.now() ? `
                <div class="alert alert-warning mt-2 mb-0 bc-cbv3-cooldown-banner">
                  <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
                    <div>
                      ⏸ <strong>CBv3 cooldown active</strong> until ${new Date(bot.cbv3LockedUntil).toLocaleString()}
                      <br /><small class="text-muted">เหตุผล: ${bot.cbv3LockReason || 'cbv3_panic'}</small>
                    </div>
                    <button type="button" class="btn btn-sm btn-outline-warning" id="btn-unlock-cbv3" onclick="unlockCBv2Now('${bot._id}')">🔓 ปลด Cooldown ตอนนี้</button>
                  </div>
                </div>` : ''}
              </div>
              `}

              ${(() => {
                const cbv2Active = bot.cbv2LockedUntil && new Date(bot.cbv2LockedUntil).getTime() > Date.now();
                const cbv3Active = bot.cbv3LockedUntil && new Date(bot.cbv3LockedUntil).getTime() > Date.now();
                if (bot.cbVersion === 'v2' && cbv2Active) return '';
                if (bot.cbVersion === 'v3' && cbv3Active) return '';
                if (!cbv2Active && !cbv3Active) return '';
                const activeUntil = cbv2Active ? bot.cbv2LockedUntil : bot.cbv3LockedUntil;
                const version = cbv2Active ? 'v2' : 'v3';
                const reason = cbv2Active ? (bot.cbv2LockReason || 'cbv2_panic') : (bot.cbv3LockReason || 'cbv3_panic');
                return `
                <div class="alert alert-warning mb-0 bc-cbv-cross-cooldown-banner is-full">
                  <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
                    <div>
                      ⏸ <strong>CB${version} cooldown active (cross-version)</strong> until ${new Date(activeUntil).toLocaleString()}
                      <br /><small class="text-muted">Active version คือ ${bot.cbVersion || 'v3'} · เหตุผล: ${reason}</small>
                    </div>
                    <button type="button" class="btn btn-sm btn-outline-warning" id="btn-unlock-cbv-cross" onclick="unlockCBv2Now('${bot._id}')">🔓 ปลด Cooldown ตอนนี้</button>
                  </div>
                </div>`;
              })()}

              <!-- FIX-2026-08-10: CBv5 (Support Zone Circuit Breaker) — independent of cbVersion -->
              <div class="bot-settings-option is-full" id="cbv5-section">
                <label class="form-check form-switch mb-0">
                  <input type="checkbox" class="form-check-input" id="f-cbv5-enabled" ${bot.cbv5Enabled !== false ? 'checked' : ''} />
                  <span class="form-check-label">💎 <strong>CBv5</strong> — Support Zone + Deepest Low + Volume</span>
                </label>
                <div class="bot-settings-dependent">
                  <label for="f-cbv5-lock-hours" class="form-label">ระยะเวลา Cooldown (ชั่วโมง)</label>
                  <input type="number" class="form-control form-control-sm" id="f-cbv5-lock-hours" min="0.5" max="168" step="0.5" value="${bot.cbv5LockHours != null ? bot.cbv5LockHours : 4}" />
                  <small class="text-muted">0.5–168 ชม. · ทำงานขนานกับ CBv2/CBv3 (อิสระจาก cbVersion) — 4-condition confirmation: lower-KC + deepest pivot low + bearish + volume spike</small>
                  <button type="button" class="btn btn-sm btn-link ps-0 mt-1" id="f-cbv5-advanced-toggle">⚙️ ขั้นสูง (KC + Pivot + Volume)</button>
                  <div id="f-cbv5-advanced" style="display:none">
                    <div class="row g-2 mt-1">
                      <div class="col-6"><label class="form-label small">KC length</label><input type="number" class="form-control form-control-sm" id="f-cbv5-kc-len" min="5" max="100" step="1" value="${bot.cbv5KcLen != null ? bot.cbv5KcLen : 20}" /></div>
                      <div class="col-6"><label class="form-label small">KC multiplier</label><input type="number" class="form-control form-control-sm" id="f-cbv5-kc-mult" min="0.5" max="5" step="0.1" value="${bot.cbv5KcMult != null ? bot.cbv5KcMult : 1.2}" /></div>
                      <div class="col-6"><label class="form-label small">Pivot lookback (count)</label><input type="number" class="form-control form-control-sm" id="f-cbv5-pivot-lookback" min="2" max="10" step="1" value="${bot.cbv5PivotLookback != null ? bot.cbv5PivotLookback : 3}" /></div>
                      <div class="col-6"><label class="form-label small">Pivot left length</label><input type="number" class="form-control form-control-sm" id="f-cbv5-pivot-left" min="2" max="50" step="1" value="${bot.cbv5PivotLeftLen != null ? bot.cbv5PivotLeftLen : 5}" /></div>
                      <div class="col-6"><label class="form-label small">Pivot right length</label><input type="number" class="form-control form-control-sm" id="f-cbv5-pivot-right" min="2" max="50" step="1" value="${bot.cbv5PivotRightLen != null ? bot.cbv5PivotRightLen : 5}" /></div>
                      <div class="col-6"><label class="form-label small">Volume MA length</label><input type="number" class="form-control form-control-sm" id="f-cbv5-vol-ma-len" min="5" max="100" step="1" value="${bot.cbv5VolMaLen != null ? bot.cbv5VolMaLen : 20}" /></div>
                      <div class="col-6"><label class="form-label small">Volume multiplier</label><input type="number" class="form-control form-control-sm" id="f-cbv5-vol-mult" min="1.0" max="10" step="0.1" value="${bot.cbv5VolMultiplier != null ? bot.cbv5VolMultiplier : 1.5}" /></div>
                      <div class="col-6"><label class="form-label small">Debounce candles</label><input type="number" class="form-control form-control-sm" id="f-cbv5-debounce" min="1" max="20" step="1" value="${bot.cbv5DebounceCandles != null ? bot.cbv5DebounceCandles : 5}" /></div>
                      <div class="col-12 mt-2">
                        <label class="form-check form-switch mb-0">
                          <input type="checkbox" class="form-check-input" id="f-cbv5-strict-break" ${bot.cbv5StrictBreak !== false ? 'checked' : ''} />
                          <span class="form-check-label small">ต้องเป็น bearish candle (close &lt; open)</span>
                        </label>
                        <label class="form-check form-switch mb-0 mt-1">
                          <input type="checkbox" class="form-check-input" id="f-cbv5-use-volume" ${bot.cbv5UseVolume !== false ? 'checked' : ''} />
                          <span class="form-check-label small">ใช้ volume filter (volume &gt; MA × multiplier)</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
                ${bot.cbv5LockedUntil && new Date(bot.cbv5LockedUntil).getTime() > Date.now() ? `
                <div class="alert alert-warning mt-2 mb-0 bc-cbv5-cooldown-banner">
                  <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
                    <div>
                      ⏸ <strong>CBv5 cooldown active</strong> until ${new Date(bot.cbv5LockedUntil).toLocaleString()}
                      <span class="text-muted ms-2" data-cbv5-countdown="${new Date(bot.cbv5LockedUntil).toISOString()}"></span>
                      <br /><small class="text-muted">เหตุผล: ${bot.cbv5LockReason || 'cbv5_panic'}</small>
                    </div>
                    <button type="button" class="btn btn-sm btn-outline-warning" id="btn-unlock-cbv5" onclick="unlockCBv2Now('${bot._id}')">🔓 ปลด Cooldown ตอนนี้</button>
                  </div>
                </div>` : ''}
              </div>

              <div class="bot-settings-option is-full">
                <label class="form-check form-switch mb-0">
                  <input type="checkbox" class="form-check-input" id="f-cb-auto-unlock-enabled" ${bot.cbAutoUnlockEnabled === true ? 'checked' : ''} />
                  <span class="form-check-label">🔓 <strong>ปลด CB Cooldown อัตโนมัติ</strong></span>
                </label>
                <div class="bot-settings-dependent">
                  <label for="f-cb-auto-unlock-threshold" class="form-label">กำไรขั้นต่ำของสัญญาณ (%)</label>
                  <input type="number" class="form-control form-control-sm" id="f-cb-auto-unlock-threshold" min="0.5" max="5" step="0.1" value="${bot.cbAutoUnlockThresholdPct != null ? bot.cbAutoUnlockThresholdPct : 1.0}" />
                  <small class="text-muted">ปลดเมื่อพบ profitable signals อย่างน้อย 3 ครั้ง · พบแล้ว: ${bot.cbAutoUnlockSignalsFound != null ? bot.cbAutoUnlockSignalsFound : 0}</small>
                </div>
              </div>
            </div>
          </div>
        </details>

        <details class="lux-details" id="f-group-safe-trade" data-settings-group="safe-trade">
          <summary class="lux-details-summary">
            <span class="bot-settings-group-icon">🛡️</span>
            <span class="bot-settings-group-title">ตัวกรอง Safe Trade ก่อนซื้อ</span>
            <span class="bot-settings-group-hint">แนวโน้มใหญ่ · Trendline · Bearish pattern</span>
          </summary>
          <div class="lux-details-body">
            <div class="bot-settings-grid">
              <div class="bot-settings-option is-full">
                <label class="form-check form-switch">
                  <input type="checkbox" class="form-check-input" id="f-safe-trade-enabled" ${bot.safeTradeEnabled !== false ? 'checked' : ''} />
                  <span class="form-check-label">🛡️ <strong>Safe Trade #1 — แนวโน้ม Super Upper-TF</strong></span>
                </label>
                <small class="text-muted d-block mt-1">ผ่านเมื่อแท่งล่าสุดเป็นเขียวหรือราคาปิดเหนือ EMA20 · FAIL-OPEN เมื่อ Binance error</small>
              </div>
              <div class="bot-settings-option is-full">
                <label class="form-check form-switch">
                  <input type="checkbox" class="form-check-input" id="f-safe-trade-trendline-enabled" ${bot.safeTradeTrendlineEnabled === true ? 'checked' : ''} />
                  <span class="form-check-label">📐 <strong>Safe Trade #2 — Trendline Support</strong></span>
                </label>
                <small class="text-muted d-block mt-1">ข้าม BUY เมื่อราคาต่ำกว่าเส้น LuxAlgo pivot-low บน upper-TF · ไม่แนะนำสำหรับ DCA</small>
              </div>
              <div class="bot-settings-option is-full">
                <label class="form-check form-switch">
                  <input type="checkbox" class="form-check-input" id="f-safe-trade-no-trade-enabled" ${bot.safeTradeNoTradeEnabled === true ? 'checked' : ''} />
                  <span class="form-check-label">🚫 <strong>Safe Trade #3 — Bearish Engulfing / Shooting Star</strong></span>
                </label>
                <small class="text-muted d-block mt-1">ข้าม BUY เมื่อ upper-TF มี no-trade pattern แบบ real-time · ไม่แนะนำสำหรับ DCA · FAIL-OPEN เมื่อข้อมูลไม่พอ</small>
              </div>
            </div>
          </div>
        </details>
      </section>

      <!-- TAB PANEL 2: DCA + BEP Stack (hidden by default) -->
      <section data-tab-panel="dca" style="display:none;">
        <div class="alert alert-info mb-3" style="font-size:0.88rem;">
          <strong>📚 DCA + BEP Stack Mode</strong> — โหมดแยกต่างหากจากบอทปกติ
          <br/>เมื่อเปิด DCA บอทจะทำงานในโหมด "stack" (1 บอท = 1 open stack เท่านั้น):
          ทุก S1 BUY จะเพิ่ม layer เข้า stack เดิมแทนที่จะสร้าง trade ใหม่ — แล้ว cancel + replace SELL
          ด้วย target ใหม่ที่ BEP+TP เดียว (recompute BEP = totalSpent/totalQty ทุกครั้ง)
        </div>
        <div class="mb-3">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="f-dca-enabled" ${bot.dcaEnabled ? 'checked' : ''} />
            <span class="form-check-label">📚 <strong>เปิดใช้ DCA + BEP Stack Mode</strong> — เหมาะกับ "no cut loss" strategy (default: ปิด)</span>
          </label>
          <small class="text-muted d-block mt-1">
            ทุก S1 BUY จะเพิ่ม layer เข้า stack เดิม (recompute BEP = totalSpent/totalQty)
            · <strong>ปิด (default)</strong>: พฤติกรรมเดิม 1 BUY → 1 SELL (ไม่กระทบบอทที่เปิดอยู่)
            · <strong>เปิด</strong>: stack mode — เหมาะกับ "no cut loss" strategy
          </small>
        </div>

        <!-- FIX-2026-08-03: TP% mirror — read-only, sourced from Classic tab -->
        <div class="card border-info mb-3" id="dca-tp-mirror">
          <div class="card-body py-2">
            <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
              <div>
                <strong>🎯 TP% (จาก Classic tab)</strong>
                <code class="ms-2" id="dca-tp-value">—</code>
              </div>
              <button type="button" class="btn btn-sm btn-outline-info" id="dca-tp-edit-link">
                ✏️ แก้ที่ Classic tab
              </button>
            </div>
            <small class="text-muted d-block mt-2">
              DCA ใช้ <code>TP% × tpTrendMultiplier</code> × <strong>stack BEP</strong>
              · SELL target = <code>stackBEP × (1 + TP%/100 + 2×fee)</code>
              · TP% เปลี่ยนใน Classic tab → มีผล layer ถัดไป (ไม่ retroactive)
            </small>
          </div>
        </div>

        <div class="mb-3">
          <label for="f-dca-max-layers" class="form-label">📊 <strong>DCA max layers</strong></label>
          <input type="number" class="form-control" id="f-dca-max-layers" value="${bot.dcaMaxLayers ?? 3}" step="1" min="1" max="100" />
          <small class="text-muted d-block mt-1">
            จำนวน layer สูงสุดต่อ stack (default 3, range 1-100)
          </small>
        </div>

        <!-- FIX-2026-08-03: Max-capital card (prominent) -->
        <div class="card border-warning mb-3">
          <div class="card-body py-2">
            <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
              <div>
                <strong>💰 Max capital ต่อ stack</strong>
                <code class="ms-2" id="dca-max-cap-prominent">—</code>
              </div>
              <small class="text-muted">
                <span id="dca-mc-capital">—</span> (capitalPerTrade) × <span id="dca-mc-layers">—</span> (maxLayers)
              </small>
            </div>
          </div>
        </div>

        <!-- FIX-2026-08-03: Exit-policy summary banner (computed from flags) -->
        <div class="alert alert-primary mb-3" id="dca-exit-policy" style="font-size:0.85rem;">
          <strong>🛡️ Exit policy:</strong> <span id="dca-exit-text">กำลังโหลด…</span>
        </div>

        <!-- FIX-2026-08-03: Feature compatibility matrix -->
        <div class="mb-3">
          <label class="form-label"><strong>🧩 Feature compatibility ในโหมด DCA</strong></label>
          <div class="row g-2 small">
            <div class="col-md-6">
              <ul class="list-unstyled mb-0">
                <li class="mb-1">✅ <strong>TP% / TP trend ×N</strong> — ใช้กับ stack BEP</li>
                <li class="mb-1">✅ <strong>Auto-update TP</strong> — เปลี่ยน TP% อัตโนมัติทุกชั่วโมง</li>
                <li class="mb-1">✅ <strong>suggest-tp-window</strong> — Min %KC window</li>
                <li class="mb-1">✅ <strong>XS1, S1-only-down, safe-trade</strong> — per-layer</li>
                <li class="mb-1">✅ <strong>auto-pause, kcMult, minSpread, retry</strong> — per-layer</li>
                <li class="mb-1">⚠️ <strong>🎲 Martingale sizing</strong> — opt-in ดูส่วนด้านล่าง</li>
              </ul>
            </div>
            <div class="col-md-6">
              <ul class="list-unstyled mb-0">
                <li class="mb-1">⚠️ <strong>SL-UKC</strong> — ใช้ <em>stack BEP</em> (ต้องเปิดจาก Classic)</li>
                <li class="mb-1">⚠️ <strong>autoArm SL-UKC</strong> — gate ต่อ stack (loss% + age ตั้งค่าได้ที่ Classic tab)</li>
                <li class="mb-1">❌ <strong>CB panic-sell</strong> — �ปิดอัตโนมัติใน DCA mode</li>
                <li class="mb-1">❌ <strong>maxTrades</strong> — ไม่ cap DCA (ใช้ dcaMaxLayers แทน)</li>
              </ul>
            </div>
          </div>
        </div>

        <!-- FIX-2026-08-03: Example flow diagram -->
        <div class="alert alert-secondary mb-3" style="font-size:0.85rem;">
          <strong>📖 ตัวอย่าง flow (capitalPerTrade=10, dcaMaxLayers=3):</strong>
          <ol class="mb-0 mt-2 ps-3">
            <li>S1 #1 → <strong>layer 1</strong> BUY 10 USDT @ $100 → BEP=$100 → SELL ที่ BEP+TP</li>
            <li>S1 #2 → <strong>layer 2</strong> BUY 10 USDT @ $90 → BEP=$95 → cancel SELL เดิม, place SELL ใหม่ที่ BEP=$95+TP</li>
            <li>S1 #3 → <strong>layer 3</strong> BUY 10 USDT @ $80 → BEP=$90 → cancel SELL เดิม, place SELL ใหม่ที่ BEP=$90+TP</li>
            <li>S1 #4 → <strong>skip</strong> (dcaMaxLayersHit) — รอ SELL fill ที่ BEP+TP</li>
          </ol>
        </div>

        <!-- FIX-2026-08-03: 🎲 Martingale sizing section (DCA-only, opt-in) -->
        <div class="card border-danger mb-3" id="dca-martingale-section" style="display:${bot.dcaEnabled ? '' : 'none'};">
          <div class="card-body">
            <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
              <strong>🎲 DCA + Martingale sizing</strong>
              <span class="badge" id="dca-martingale-state-badge">${bot.martingaleEnabled ? 'ON' : 'OFF'}</span>
            </div>
            <div class="mb-2">
              <label class="form-check mb-2">
                <input type="checkbox" class="form-check-input" id="f-martingale-enabled" ${bot.martingaleEnabled ? 'checked' : ''} />
                <span class="form-check-label">
                  เปิดใช้ <strong>Martingale sizing</strong> — layer ถัดไปใหญ่ขึ้นตาม multiplier
                </span>
              </label>
              <small class="text-muted d-block">
                default <strong>ปิด</strong> (ทุก layer ใช้ capitalPerTrade เท่ากัน) — เปิดแล้ว layer N = capitalPerTrade × multiplier^(N-1)
              </small>
            </div>

            <div class="row g-2">
              <div class="col-md-6 mb-2">
                <label class="form-label small">Multiplier (×)</label>
                <input type="number" class="form-control form-control-sm" id="f-martingale-multiplier"
                       value="${bot.martingaleMultiplier ?? 1.5}" step="0.1" min="1.0" max="3.0" />
                <small class="text-muted">range 1.0..3.0 (1.5 = balanced, 2.0 = aggressive, 1.0 = เท่ากับ fixed)</small>
              </div>
              <div class="col-md-6 mb-2">
                <label class="form-label small">Per-layer notional cap (USDT)</label>
                <input type="number" class="form-control form-control-sm" id="f-martingale-max-notional"
                       value="${bot.martingaleMaxLayerNotional ?? 100}" step="1" min="1" max="10000" />
                <small class="text-muted">กัน layer สูงๆ ใหญ่เกินไป (default 100)</small>
              </div>
            </div>

            <!-- Layer evolution preview -->
            <div class="alert alert-light small mt-2 mb-0" style="font-size:0.78rem;">
              <strong>📊 Layer sizing preview</strong>
              <table class="table table-sm table-borderless mb-0 mt-1" style="font-size:0.78rem;">
                <thead>
                  <tr>
                    <th>Layer</th>
                    <th class="text-end">Notional (USDT)</th>
                    <th class="text-end">Cumulative</th>
                  </tr>
                </thead>
                <tbody id="dca-martingale-preview-rows">
                  <!-- filled by JS -->
                </tbody>
              </table>
            </div>

            <div class="alert alert-warning small mt-2 mb-0" style="font-size:0.78rem;">
              ⚠️ <strong>Martingale = aggressive sizing.</strong> ใช้ร่วมกับ SL-UKC + autoArm เสมอ —
              layer ใหญ่ขึ้นแปรผกผันกับ max-loss ถ้าราคาวิ่งต่ำกว่า BEP
            </div>
          </div>
        </div>

        <!-- FIX-2026-08-03: Backtest quick-link -->
        <div class="d-flex gap-2 mb-3 flex-wrap">
          <a href="/backtest.html?botId=${botId}&dcaMode=1" class="btn btn-sm btn-outline-primary">
            🧪 รัน DCA Backtest
          </a>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="dca-show-stats-btn">
            📊 คำอธิบาย backtest stats
          </button>
        </div>
        <div class="collapse mb-3" id="dca-stats-info">
          <div class="card card-body bg-light small">
            <strong>สถิติที่ดูได้จาก DCA backtest:</strong>
            <ul class="mb-0 mt-1">
              <li><code>stacksCount</code> — total stacks opened</li>
              <li><code>dcaTargetHitCount</code> — TP fills closing whole stack</li>
              <li><code>dcaStackStopLossCount</code> — SL-UKC force-closes</li>
              <li><code>dcaMaxLayersHitCount</code> — signals skipped ที่ layer cap</li>
              <li><code>avgLayersPerStack</code> — fill efficiency</li>
              <li><code>stackSuccessRate</code> — (dcaTargetHit / stacksCount)</li>
            </ul>
          </div>
        </div>

        <div class="mb-3" id="dca-cb-warning" style="display:${bot.dcaEnabled ? '' : 'none'};">
          <div class="alert alert-warning small mb-0">
            ⚠️ <strong>เมื่อเปิด DCA:</strong>
            CB panic-sell จะถูก disable อัตโนมัติ (no cut loss) &nbsp;·&nbsp;
            SL-UKC จะใช้ <strong>stack BEP</strong> แทนราคาเดี่ยว &nbsp;·&nbsp;
            ต้องเปิด SL-UKC จาก Classic tab + แนะนำให้เปิด <strong>autoArm SL-UKC</strong> ด้วย
          </div>
        </div>
      </section>

      <!-- FIX-2026-08-03: Confirmation modal — toggle DCA ON -->
      <div class="modal fade" id="dca-enable-modal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header bg-warning-subtle">
              <h5 class="modal-title">📚 เปิด DCA + BEP Stack Mode</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body">
              <p><strong>สิ่งที่จะเปลี่ยน (เริ่มจาก S1 ตัวถัดไป หลัง save):</strong></p>
              <ul>
                <li>S1 ตัวถัดไปจะ <strong>เปิด DCA stack ใหม่</strong> (1 BUY = 1 layer)</li>
                <li>S1 ตัวถัดไปๆ จะ <strong>เพิ่ม layer</strong> เข้า stack เดิม (สูงสุด <code id="dca-modal-max-layers">3</code> layers)</li>
                <li>SELL จะถูก cancel + replace ทุกครั้งที่ BEP เปลี่ยน</li>
                <li>CB panic-sell จะ <strong>ปิดอัตโนมัติ</strong> (no cut loss)</li>
              </ul>
              <p><strong>สิ่งที่ไม่เปลี่ยน:</strong></p>
              <ul>
                <li>🟢 <strong>trade (classic) ที่เปิดอยู่ตอนนี้</strong> จะ flow ต่อเป็น 1 BUY → 1 SELL ตามเดิม</li>
                <li>🟢 TP% / TP trend / SL-UKC / safe-trade ฯลฯ ทำงานเหมือนเดิม</li>
              </ul>
              <div class="alert alert-info small mb-0">
                ℹ️ เริ่มมีผล <strong>ตั้งแต่ S1 ตัวถัดไป</strong> หลัง save — ไม่กระทบ trade ที่เปิดอยู่
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal" id="dca-enable-cancel">ยกเลิก</button>
              <button type="button" class="btn btn-primary" id="dca-enable-confirm">✅ เข้าใจแล้ว — เปิด DCA</button>
            </div>
          </div>
        </div>
      </div>

      <!-- FIX-2026-08-03: Confirmation modal — toggle DCA OFF (with open stack) -->
      <div class="modal fade" id="dca-disable-modal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header bg-warning-subtle">
              <h5 class="modal-title">📚 ปิด DCA + BEP Stack Mode</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body">
              <div class="alert alert-warning">
                ⚠️ บอทนี้มี <strong>DCA stack ที่ยังเปิดอยู่</strong>
              </div>
              <p><strong>สิ่งที่จะเกิดขึ้น:</strong></p>
              <ul>
                <li>🟢 <strong>Stack ปัจจุบันจะ flow ต่อเป็น DCA</strong> จนกว่าจะปิด (TP hit / SL-UKC / force-close)</li>
                <li>🔄 S1 ตัวถัดไป (หลัง stack ปิด) จะกลับเป็น <strong>classic mode</strong> — 1 BUY = 1 SELL</li>
                <li>🔄 CB panic-sell จะ <strong>กลับมาเปิด</strong> หลัง stack ปิด</li>
              </ul>
              <div class="alert alert-info small mb-0">
                ℹ️ การเปลี่ยนแปลง <strong>มีผลตั้งแต่ S1 ตัวถัดไป</strong> — ไม่กระทบ stack ที่กำลังเปิดอยู่
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal" id="dca-disable-cancel">ยกเลิก</button>
              <button type="button" class="btn btn-warning" id="dca-disable-confirm">ปิด DCA (current stack จะ flow ต่อ)</button>
            </div>
          </div>
        </div>
      </div>

      <!-- FOOTER — outside any panel, always visible -->
      <div class="bot-settings-actions mt-3">
        <div class="bot-settings-status">
          <div class="alert alert-info mb-1" id="f-total"></div>
          <div class="text-danger small" id="f-error"></div>
        </div>
        <!-- FIX-2026-08-14: Import/Export file-based -->
        <div class="d-flex gap-2 flex-wrap mb-2 w-100">
          <button type="button" class="btn btn-sm btn-outline-secondary" id="f-export-config" title="บันทึกค่าตั้งค่าทั้งหมดเป็นไฟล์ JSON">📤 Export</button>
          <button type="button" class="btn btn-sm btn-outline-info" id="f-import-replace" title="โหลดไฟล์ทับฟอร์มทั้งหมด (symbol ไม่ถูกแก้)">📥 Import (Replace)</button>
          <button type="button" class="btn btn-sm btn-outline-info" id="f-import-merge" title="โหลดไฟล์แบบ merge · อัพเดทเฉพาะ field ที่อยู่ในไฟล์">📥 Import (Merge)</button>
        </div>
        <div id="f-io-status" class="text-muted small mb-2 w-100"></div>
        <button type="submit" class="btn btn-primary">💾 บันทึก</button>
        <a href="/bots.html" class="btn btn-secondary">กลับ</a>
      </div>
    </form>
    </div>
  `;

  // FIX-2026-08-03: tab switcher (reuses bot-detail.js pattern)
  function switchTab(key) {
    activeTab = key;
    document.querySelectorAll('.lux-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === key);
    });
    document.querySelectorAll('[data-tab-panel]').forEach((p) => {
      p.style.display = p.dataset.tabPanel === key ? '' : 'none';
    });
  }
  document.querySelectorAll('.lux-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  const editForm = document.getElementById('edit-form');
  editForm.onsubmit = save;
  editForm.addEventListener('invalid', (event) => {
    const group = event.target.closest('details.lux-details');
    if (group) group.open = true;
  }, true);
  ['f-capital', 'f-maxtrades'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      updateTotal();
      updateDcaMaxCap();
    });
  });
  document.getElementById('f-tp-recommend').onclick = recommendTp;

  // FIX-2026-08-14: Import/Export file-based (cross-surface compatible JSON)
  //   - Export reads CURRENT bot values (from bot object, not stale form) for accuracy
  //   - Import skips 'symbol' (immutable after create) + auto-refreshes DCA-dependent UI
  const exportConfigBtn = document.getElementById('f-export-config');
  if (exportConfigBtn) exportConfigBtn.onclick = exportConfigToFile;
  const importReplaceBtn = document.getElementById('f-import-replace');
  if (importReplaceBtn) importReplaceBtn.onclick = () => importConfigFromFile('replace');
  const importMergeBtn = document.getElementById('f-import-merge');
  if (importMergeBtn) importMergeBtn.onclick = () => importConfigFromFile('merge');

  function setIoStatus(msg, variant) {
    const el = document.getElementById('f-io-status');
    if (!el) return;
    el.textContent = msg || '';
    const colors = { danger: '#ff6b6b', success: '#4ade80', warn: '#ffa500' };
    el.style.color = colors[variant] || 'var(--text-3)';
  }

  function exportConfigToFile() {
    if (!window.botConfigIO) { setIoStatus('❌ botConfigIO module ไม่โหลด', 'danger'); return; }
    if (!bot) { setIoStatus('❌ ยังโหลดบอทไม่เสร็จ', 'danger'); return; }
    // Pull settings from the loaded bot object (authoritative — not stale form values)
    const settings = {};
    const keys = window.botConfigIO.ALLOWED_FIELD_KEYS;
    for (const k of keys) {
      if (bot[k] !== undefined && bot[k] !== null) settings[k] = bot[k];
    }
    const fieldCount = Object.keys(settings).length;
    if (fieldCount === 0) { setIoStatus('❌ บอทไม่มี config fields', 'danger'); return; }
    const payload = window.botConfigIO.buildExportPayload({
      type: 'bot',
      name: bot.name || bot.symbol || 'bot',
      source: 'bot-edit',
      settings,
      botSymbol: bot.symbol,
      botTimeframe: bot.timeframe,
      cbVersion: bot.cbVersion,
    });
    const filename = window.botConfigIO.buildExportFilename('bot', bot.symbol || 'bot');
    window.botConfigIO.triggerDownload(filename, payload);
    setIoStatus(`✅ Export ${fieldCount} fields → ${filename}`, 'success');
  }

  async function importConfigFromFile(mode) {
    if (!window.botConfigIO) { setIoStatus('❌ botConfigIO module ไม่โหลด', 'danger'); return; }
    if (!bot) { setIoStatus('❌ ยังโหลดบอทไม่เสร็จ', 'danger'); return; }
    if (mode === 'replace' && !(await AdminModalAlert.confirm({ title: '⚠️ Import (Replace Mode)', message: 'Import จะทับฟอร์มทั้งหมด (ยกเว้น symbol ที่ล็อกไว้) — แน่ใจมั้ย?', level: 'warn', okLabel: 'Import' }))) return;
    setIoStatus('⏳ กำลังเลือกไฟล์…');
    const file = await window.botConfigIO.pickJsonFile();
    if (!file) { setIoStatus('ยกเลิก', 'warn'); return; }
    setIoStatus(`⏳ กำลังอ่าน ${file.name}…`);
    const result = await window.botConfigIO.parseImportFile(file);
    if (!result.ok) { setIoStatus('❌ ' + result.error, 'danger'); return; }
    const sanitize = result.sanitizeResult;
    // skipKey='symbol' is defensive — symbol not in whitelist, but explicit is safer
    const { applied, skipped } = window.botConfigIO.applyToForm(sanitize.settings, 'bot-edit', { mode, skipKey: 'symbol' });
    // Timeframe mismatch warning (Save will restart trader)
    const fileTf = sanitize.settings.timeframe;
    const tfWarning = (fileTf && fileTf !== bot.timeframe)
      ? `⚠️ Timeframe ${fileTf} ≠ ${bot.timeframe} — Save จะ restart trader`
      : '';
    // Run DCA refresh chain (DCA + Martingale + CB visibility depend on applied values)
    try {
      updateDcaMaxCap();
      updateDcaTpMirror();
      updateDcaExitPolicy();
      updateDcaMartingaleVisibility();
      updateDcaMartingalePreview();
      refreshDcaUi({ autoSwitchTab: false });
      updateTotal();
    } catch (_) { /* non-fatal — leave stale UI if any ref missing */ }
    const parts = [`✅ Import ${applied} fields (${mode})`];
    if (sanitize.dropped > 0) parts.push(`dropped ${sanitize.dropped} unknown`);
    if (skipped.length > 0) parts.push(`skipped ${skipped.length}`);
    const warnings = result.warnings || [];
    if (warnings.length) parts.push(`⚠️ ${warnings.join('; ')}`);
    if (tfWarning) parts.push(tfWarning);
    setIoStatus(parts.join(' · '), (warnings.length || tfWarning) ? 'warn' : 'success');
  }

  // FIX-2026-08-03: live-update DCA max-capital formula + max-capital card
  function updateDcaMaxCap() {
    const cap = parseFloat(document.getElementById('f-capital').value) || 0;
    const layers = parseInt(document.getElementById('f-dca-max-layers').value, 10) || 3;
    const total = (cap * layers).toFixed(2);
    const elProminent = document.getElementById('dca-max-cap-prominent');
    const elMc = document.getElementById('dca-mc-capital');
    const elLy = document.getElementById('dca-mc-layers');
    if (elProminent) elProminent.textContent = `${total} USDT`;
    if (elMc) elMc.textContent = cap.toFixed(2);
    if (elLy) elLy.textContent = layers;
  }
  const _dcaMaxLayers = document.getElementById('f-dca-max-layers');
  if (_dcaMaxLayers) _dcaMaxLayers.addEventListener('input', updateDcaMaxCap);

  // FIX-2026-08-03: TP% mirror — read-only display, sourced from Classic tab inputs
  function updateDcaTpMirror() {
    const tp = parseFloat(document.getElementById('f-tp').value) || 0;
    const trendOn = document.getElementById('f-tp-trend-enabled').checked;
    const mult = parseFloat(document.getElementById('f-tp-trend-multiplier').value) || 1;
    const effective = trendOn ? tp * mult : tp;
    const el = document.getElementById('dca-tp-value');
    if (el) {
      el.textContent = trendOn
        ? `${tp.toFixed(3)}% (effective ${effective.toFixed(3)}% เมื่อ trend=upper × ${mult})`
        : `${tp.toFixed(3)}%`;
    }
    updateDcaExitPolicy();
  }
  ['f-tp', 'f-tp-trend-enabled', 'f-tp-trend-multiplier'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateDcaTpMirror);
  });
  // FIX-2026-08-03: re-compute DCA exit-policy banner when F1 thresholds change
  ['f-auto-arm-loss-pct', 'f-auto-arm-age-hours'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateDcaExitPolicy);
  });
  const _tpEditLink = document.getElementById('dca-tp-edit-link');
  if (_tpEditLink) {
    _tpEditLink.addEventListener('click', () => {
      switchTab('classic');
      const tpGroup = document.getElementById('f-group-tp');
      if (tpGroup) tpGroup.open = true;
      const tpInput = document.getElementById('f-tp');
      if (tpInput) {
        tpInput.focus();
        tpInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  // FIX-2026-08-03: exit-policy banner — compute from SL-UKC + auto-arm flags
  function updateDcaExitPolicy() {
    const dcaOn = document.getElementById('f-dca-enabled').checked;
    const slUkc = document.getElementById('f-stop-loss-upper-kc').checked;
    const autoArm = document.getElementById('f-auto-arm-stop-loss-ukc').checked;
    const lossPct = parseFloat(document.getElementById('f-auto-arm-loss-pct').value) || 10;
    const ageHours = parseFloat(document.getElementById('f-auto-arm-age-hours').value) || 4;
    const el = document.getElementById('dca-exit-text');
    if (!el) return;
    if (!dcaOn) {
      el.textContent = 'DCA ปิดอยู่ — ใช้ logic เดิม (TP + CB panic-sell)';
      return;
    }
    if (slUkc && autoArm) {
      el.innerHTML = `<strong>TP</strong> + <strong>SL-UKC</strong> (จะ trigger เมื่อ stack BEP ขาดทุน &gt; ${lossPct}% และอายุ &gt; ${ageHours}h หลัง layer สุดท้าย + candle ปิดเหนือ upper-KC)`;
    } else if (slUkc && !autoArm) {
      el.innerHTML = '<strong>TP</strong> + <strong>SL-UKC</strong> (immediate — จะ trigger ทันทีที่ขาดทุน + candle &gt; upper-KC) — ⚠️ ปิด autoArm = SL ไวกว่า TP เสมอ';
    } else if (!slUkc && autoArm) {
      el.innerHTML = '<strong>TP</strong> เท่านั้น (auto-arm จะถูกบล็อคเพราะ SL-UKC ปิด — ใช้ OR semantic ก็ยังไม่ trigger) — ⚠️ ไม่มี loss exit!';
    } else {
      el.innerHTML = '<strong>TP</strong> เท่านั้น — ⚠️ ไม่มี loss exit! เปิด SL-UKC จาก Classic tab ถ้าอยากมี stop loss';
    }
  }

  // FIX-2026-08-03: DCA + Martingale layer preview — shows per-layer notional + cumulative
  //   - parity with trader._computeDcaLayerNotional (capitalPerTrade × mult^(i-1), capped)
  function updateDcaMartingalePreview() {
    const tbody = document.getElementById('dca-martingale-preview-rows');
    if (!tbody) return;
    const cap = parseFloat(document.getElementById('f-capital').value) || 0;
    const layers = Math.min(100, Math.max(1, parseInt(document.getElementById('f-dca-max-layers').value, 10) || 3));
    const martOn = document.getElementById('f-martingale-enabled').checked;
    const mult = parseFloat(document.getElementById('f-martingale-multiplier').value) || 1.5;
    const layerCap = parseFloat(document.getElementById('f-martingale-max-notional').value) || 100;
    const rows = [];
    let cumulative = 0;
    for (let i = 1; i <= layers; i++) {
      let notional;
      if (!martOn) {
        notional = cap;
      } else {
        const raw = cap * Math.pow(mult, i - 1);
        notional = Math.min(raw, layerCap);
      }
      cumulative += notional;
      const cappedTag = (martOn && (cap * Math.pow(mult, i - 1)) > layerCap) ? ' <span class="badge bg-warning">cap</span>' : '';
      rows.push(
        `<tr>
          <td>Layer ${i}</td>
          <td class="text-end">${notional.toFixed(2)}${cappedTag}</td>
          <td class="text-end">${cumulative.toFixed(2)}</td>
        </tr>`
      );
    }
    tbody.innerHTML = rows.join('');
    // Update badge
    const badge = document.getElementById('dca-martingale-state-badge');
    if (badge) badge.textContent = martOn ? 'ON' : 'OFF';
  }

  // FIX-2026-08-03: show/hide Martingale section when DCA enabled changes
  function updateDcaMartingaleVisibility() {
    const dcaOn = document.getElementById('f-dca-enabled').checked;
    const section = document.getElementById('dca-martingale-section');
    if (section) section.style.display = dcaOn ? '' : 'none';
    if (dcaOn) updateDcaMartingalePreview();
  }
  // Martingale field listeners
  ['f-martingale-enabled', 'f-martingale-multiplier', 'f-martingale-max-notional'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateDcaMartingalePreview);
    if (el) el.addEventListener('change', updateDcaMartingalePreview);
  });
  // Recompute preview when capital / max-layers change (live)
  ['f-capital', 'f-dca-max-layers'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateDcaMartingalePreview);
  });
  // When DCA toggle flips, show/hide Martingale section
  const _dcaToggleForMartingale = document.getElementById('f-dca-enabled');
  if (_dcaToggleForMartingale) {
    _dcaToggleForMartingale.addEventListener('change', updateDcaMartingaleVisibility);
  }
  // Initial render
  updateDcaMartingaleVisibility();

  // FIX-2026-08-03: DCA toggle — show confirmation modal when state changes
  function refreshDcaUi({ autoSwitchTab = false } = {}) {
    const dcaOn = document.getElementById('f-dca-enabled').checked;
    const cbEl = document.getElementById('f-cb-enabled');
    const warn = document.getElementById('dca-cb-warning');
    const badge = document.getElementById('dca-state-badge');
    if (cbEl) {
      cbEl.disabled = dcaOn;
      // Forcibly uncheck when DCA on (visual only — backend gets false via save())
      if (dcaOn) cbEl.checked = false;
    }
    if (warn) warn.style.display = dcaOn ? '' : 'none';
    if (badge) badge.textContent = dcaOn ? 'ON' : 'OFF';
    updateDcaExitPolicy();
    if (autoSwitchTab && dcaOn) switchTab('dca'); // user-confirmed: jump to DCA tab when enabled
  }
  const _dcaToggle = document.getElementById('f-dca-enabled');
  if (_dcaToggle) {
    _dcaToggle.addEventListener('change', async (e) => {
      const wasDcaOn = !!bot.dcaEnabled; // DB state
      const isDcaOnNow = e.target.checked;
      if (isDcaOnNow && !wasDcaOn) {
        // Toggle ON — show confirmation modal
        const modalMaxLayers = document.getElementById('dca-modal-max-layers');
        if (modalMaxLayers) modalMaxLayers.textContent = bot.dcaMaxLayers ?? 3;
        const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('dca-enable-modal'));
        modal.show();
      } else if (!isDcaOnNow && wasDcaOn) {
        // Toggle OFF — check if open DCA stack exists
        try {
          const resp = await API.get(`/api/trades?botId=${botId}&isDcaStack=true&state=selling`);
          const openStack = (resp.trades || []).find((t) => t.isDcaStack);
          if (openStack) {
            const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('dca-disable-modal'));
            modal.show();
          } else {
            refreshDcaUi({ autoSwitchTab: false });
          }
        } catch (err) {
          // If API fails, just proceed without modal
          refreshDcaUi({ autoSwitchTab: false });
        }
      } else {
        refreshDcaUi({ autoSwitchTab: false });
      }
    });
    // Modal confirm/cancel buttons
    document.getElementById('dca-enable-confirm').addEventListener('click', () => {
      bootstrap.Modal.getInstance(document.getElementById('dca-enable-modal'))?.hide();
      refreshDcaUi({ autoSwitchTab: true });
    });
    document.getElementById('dca-enable-cancel').addEventListener('click', () => {
      document.getElementById('f-dca-enabled').checked = false;
      bootstrap.Modal.getInstance(document.getElementById('dca-enable-modal'))?.hide();
      refreshDcaUi({ autoSwitchTab: false });
    });
    document.getElementById('dca-disable-confirm').addEventListener('click', () => {
      bootstrap.Modal.getInstance(document.getElementById('dca-disable-modal'))?.hide();
      refreshDcaUi({ autoSwitchTab: false });
    });
    document.getElementById('dca-disable-cancel').addEventListener('click', () => {
      document.getElementById('f-dca-enabled').checked = true;
      bootstrap.Modal.getInstance(document.getElementById('dca-disable-modal'))?.hide();
      refreshDcaUi({ autoSwitchTab: false });
    });
  }
  refreshDcaUi();

  // FIX-2026-08-03: Backtest stats toggle
  const _statsBtn = document.getElementById('dca-show-stats-btn');
  if (_statsBtn) {
    _statsBtn.addEventListener('click', () => {
      const collapse = bootstrap.Collapse.getOrCreateInstance(document.getElementById('dca-stats-info'));
      collapse.toggle();
    });
  }

  // Initialize mirror + max-capital + exit-policy
  updateDcaMaxCap();
  updateDcaTpMirror();
  updateDcaExitPolicy();

  // FIX-2026-08-03: live-update exit-policy when SL-UKC / auto-arm changes
  ['f-stop-loss-upper-kc', 'f-auto-arm-stop-loss-ukc'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', updateDcaExitPolicy);
  });

  // FIX-2026-08-10: CBv5 ⚙️ ขั้นสูง toggle (advanced params)
  const advToggle = document.getElementById('f-cbv5-advanced-toggle');
  const adv = document.getElementById('f-cbv5-advanced');
  if (advToggle && adv) {
    advToggle.addEventListener('click', () => {
      const show = adv.style.display === 'none';
      adv.style.display = show ? '' : 'none';
      advToggle.textContent = show ? '⚙️ ซ่อนขั้นสูง' : '⚙️ ขั้นสูง (KC + Pivot + Volume)';
    });
  }

  updateTotal();
}

/**
 * FIX-2026-07-23: "Get recommend TP%" button
 *   - ใช้ symbol + timeframe ของบอท
 *   - window = 500 bars
 *   - คำนวณ Min %KC + EMA20 trend (upper-TF) ผ่าน /api/bots/suggest-tp
 *   - ใส่ suggestedTpPct ลงใน #f-tp
 */
async function recommendTp() {
  if (!bot) return;
  const btn = document.getElementById('f-tp-recommend');
  const hint = document.getElementById('f-tp-hint');
  const tfSelect = document.getElementById('f-timeframe');
  const tf = tfSelect ? tfSelect.value : bot.timeframe;
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('is-loading');
  btn.innerHTML = '⏳ กำลังคำนวณ…';
  hint.innerHTML = '<span class="text-warning">กำลังคำนวณ Min %KC(500 bars) + EMA20 trend จาก Binance…</span>';
  try {
    const resp = await API.post('/api/bots/suggest-tp', { symbol: bot.symbol, timeframe: tf, window: 500 });
    const tpInput = document.getElementById('f-tp');
    if (resp.suggestedTpPct == null) {
      hint.innerHTML = `<span class="text-warning">⚠️ trend ยัง warmup (${resp.trendTF || 'n/a'}) — ลองใหม่อีกครั้งในอีกสักครู่</span>`;
    } else {
      // FIX-2026-07-23: server ส่ง TP มาในรูป x.xx1 แล้ว + หัก fee buffer (round-trip) แล้ว
      //   - suggestedTpPct = NET (ที่ user เก็บใน bot.tpPercent)
      //   - rawSuggestedTpPct = GROSS (ก่อนหัก fee — เช่น 0.541%)
      //   - trader จะ +2*feeRate กลับตอนวาง SELL → sell target ≈ gross → net = tpPercent หลังหัก fee
      tpInput.value = resp.suggestedTpPct.toFixed(3);
      const trendGlyph = resp.trendState === 'upper' ? '🟢 ▲' : '🔴 ▼';
      const tfLabel = resp.trendTF || '';
      const grossPct = resp.rawSuggestedTpPct != null ? resp.rawSuggestedTpPct.toFixed(3) : 'n/a';
      const feePct = resp.feeBufferPct != null ? resp.feeBufferPct.toFixed(2) : '0.2';
      // FIX-2026-08-02: แสดง auto-floor badge ถ้า NET TP ต่ำกว่า threshold → override เป็น 0.281% (เดิม 0.111%)
      const floorBadge = resp.tpOverridden
        ? ` &nbsp;<span class="lux-badge lux-badge-warn" title="NET TP ต่ำกว่า 0.281% — auto-floor ใช้ 0.281% แทน (raw ${resp.rawNetBeforeOverride != null ? resp.rawNetBeforeOverride.toFixed(3) : '?'}%)">⚙️ auto-floor</span>`
        : '';
      hint.innerHTML = `<span class="text-success">✅ ใช้ ${resp.suggestedTpPct.toFixed(3)}% &nbsp;= &nbsp;gross ${grossPct}% − fee ${feePct}% &nbsp;· &nbsp;Min %KC=${resp.kcMinPct.toFixed(3)}% &nbsp;· &nbsp;EMA20(${tfLabel}) ${trendGlyph} ${resp.trendState} (gap ${(resp.trendGapPct >= 0 ? '+' : '') + resp.trendGapPct.toFixed(2)}%)${floorBadge}</span>`;
    }
  } catch (err) {
    hint.innerHTML = `<span class="text-danger">❌ คำนวณล้มเหลว: ${escapeHtml(err.message || 'unknown')}</span>`;
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    btn.innerHTML = originalLabel;
  }
}

function updateTotal() {
  const cap = parseFloat(document.getElementById('f-capital').value) || 0;
  const max = parseInt(document.getElementById('f-maxtrades').value) || 0;
  document.getElementById('f-total').textContent = `ทุนรวมที่ต้องเตรียม: ${(cap * max).toFixed(2)} USDT`;
}

async function save(e) {
  e.preventDefault();
  document.getElementById('f-error').textContent = '';
  const data = {
    name: document.getElementById('f-name').value,
    timeframe: document.getElementById('f-timeframe').value,
    capitalPerTrade: parseFloat(document.getElementById('f-capital').value),
    maxTrades: parseInt(document.getElementById('f-maxtrades').value, 10),
    tpPercent: parseFloat(document.getElementById('f-tp').value),
    // FIX-2026-07-24: parseFloat — รองรับทศนิยม (0.5 = 30 วินาที)
    retryTimeMin: parseFloat(document.getElementById('f-retry').value),
    retryMax: parseInt(document.getElementById('f-retry-max').value, 10),
    stopLossOnUpperKC: document.getElementById('f-stop-loss-upper-kc').checked, // FIX-2026-07-23
    s1OnlyDown: document.getElementById('f-s1-only-down').checked, // FIX-2026-07-24: skip bg 2→1 (ซื้อตอนราคาสูง)
    xs1Enabled: document.getElementById('f-xs1-enabled').checked, // FIX-2026-07-25: per-bot XS1 anti-dump toggle (default true)
    cbEnabled: document.getElementById('f-cb-enabled').checked, // FIX-2026-08-01: per-bot Circuit-breaker panic-sell toggle (default true) — เดิมชื่อ sls1Enabled
    // FIX-2026-08-08: only send CBv2 OR CBv3 (based on AppConfig.cbVersion) — the other section is hidden in UI
    cbv2Enabled: bot.cbVersion === 'v2' ? document.getElementById('f-cbv2-enabled').checked : bot.cbv2Enabled, // FIX-2026-08-06: CBv2 sustained panic-sell toggle (default true)
    cbv2LockHours: bot.cbVersion === 'v2' ? parseFloat(document.getElementById('f-cbv2-lock-hours').value) : bot.cbv2LockHours, // FIX-2026-08-06: CBv2 lock hours (0.5..168)
    cbv3Enabled: bot.cbVersion === 'v3' ? document.getElementById('f-cbv3-enabled').checked : bot.cbv3Enabled, // FIX-2026-08-08: Feature #2 — CBv3 toggle + lock hours (mirror CBv2)
    cbv3LockHours: bot.cbVersion === 'v3' ? parseFloat(document.getElementById('f-cbv3-lock-hours').value) : bot.cbv3LockHours,
    // FIX-2026-08-10: CBv5 (Support Zone + Deepest Low + Volume Filter) — independent of cbVersion
    cbv5Enabled: document.getElementById('f-cbv5-enabled').checked,
    cbv5LockHours: parseFloat(document.getElementById('f-cbv5-lock-hours').value) || 4,
    cbv5KcLen: parseInt(document.getElementById('f-cbv5-kc-len').value, 10) || 20,
    cbv5KcMult: parseFloat(document.getElementById('f-cbv5-kc-mult').value) || 1.2,
    cbv5PivotLookback: parseInt(document.getElementById('f-cbv5-pivot-lookback').value, 10) || 3,
    cbv5PivotLeftLen: parseInt(document.getElementById('f-cbv5-pivot-left').value, 10) || 5,
    cbv5PivotRightLen: parseInt(document.getElementById('f-cbv5-pivot-right').value, 10) || 5,
    cbv5StrictBreak: document.getElementById('f-cbv5-strict-break').checked,
    cbv5UseVolume: document.getElementById('f-cbv5-use-volume').checked,
    cbv5VolMaLen: parseInt(document.getElementById('f-cbv5-vol-ma-len').value, 10) || 20,
    cbv5VolMultiplier: parseFloat(document.getElementById('f-cbv5-vol-mult').value) || 1.5,
    cbv5DebounceCandles: parseInt(document.getElementById('f-cbv5-debounce').value, 10) || 5,
    // FIX-2026-08-08: Feature #3 — CB Auto-Unlock toggle + threshold
    cbAutoUnlockEnabled: document.getElementById('f-cb-auto-unlock-enabled').checked,
    cbAutoUnlockThresholdPct: parseFloat(document.getElementById('f-cb-auto-unlock-threshold').value),
    // FIX-2026-08-08: Feature #1 — Dynamic Position Sizing toggle
    dynamicSizeEnabled: document.getElementById('f-dynamic-size-enabled').checked,
    safeTradeEnabled: document.getElementById('f-safe-trade-enabled').checked, // FIX-2026-08-01: per-bot safe-trade filter (default ON)
    safeTradeTrendlineEnabled: document.getElementById('f-safe-trade-trendline-enabled').checked, // FIX-2026-08-03: Safe-trade filter #2 (LuxAlgo trendline) — opt-in, default OFF
    safeTradeNoTradeEnabled: document.getElementById('f-safe-trade-no-trade-enabled').checked, // FIX-2026-08-05: Safe-trade filter #3 (no-trade engulfing/SS) — opt-in, default OFF
    autoPauseEnabled: document.getElementById('f-auto-pause-enabled').checked, // FIX-2026-08-01: per-bot auto-pause on low Min-%KC (default ON)
    autoPauseMinKcPct: parseFloat(document.getElementById('f-auto-pause-min-kc').value) || 2, // FIX-2026-08-01: auto-pause threshold %
    autoPauseMin24hVolUsdt: parseFloat(document.getElementById('f-auto-pause-min-24h-vol').value) || 1000000, // FIX-2026-08-10: 24h volume guard (USDT, default 1M)
    autoPauseAdjustEnabled: document.getElementById('f-auto-pause-adjust-enabled').checked, // FIX-2026-08-29: per-bot opt-in for auto-adjust (default ON)
    autoTimingEnabled: (() => { // FIX-2026-08-30 / Phase 4: 3-state — null=inherit, true=force on, false=force off
      const v = document.getElementById('f-auto-timing-enabled').value;
      return v === 'true' ? true : v === 'false' ? false : null;
    })(),
    autoArmStopLossOnUKC: document.getElementById('f-auto-arm-stop-loss-ukc').checked, // FIX-2026-07-31 (F1): per-bot auto-arm SL-on-UKC toggle (default true)
    autoArmLossPct: parseFloat(document.getElementById('f-auto-arm-loss-pct').value) || 10, // FIX-2026-08-03 / EXT-2026-08-20: per-bot F1 loss threshold (1..99, default 10)
    autoArmAgeHours: parseFloat(document.getElementById('f-auto-arm-age-hours').value) || 4, // FIX-2026-08-03 / EXT-2026-08-20: per-bot F1 age threshold (0.5..999, default 4)
    slUkcTriggerOnProfit: document.getElementById('f-sl-ukc-trigger-on-profit').checked, // FIX-2026-08-03: SL-UKC trigger on profit (default false)
    tpTrendEnabled: document.getElementById('f-tp-trend-enabled').checked, // FIX-2026-08-01: per-bot TP trend ×N master toggle (default true)
    tpTrendMultiplier: parseFloat(document.getElementById('f-tp-trend-multiplier').value), // FIX-2026-07-31 (F2): per-bot TP ×N multiplier (1..10, default 2)
    autoUpdateTp: document.getElementById('f-auto-update-tp').checked, // FIX-2026-07-23: TP auto-update toggle
    suggestTpWindow: parseInt(document.getElementById('f-suggest-tp-window').value, 10), // FIX-2026-07-25: per-bot TP suggestion window (30..1000)
    kcMult: parseFloat(document.getElementById('f-kc-mult').value), // FIX-2026-07-24: per-bot KC multiplier
    minSpreadTicks: parseInt(document.getElementById('f-min-spread').value, 10), // FIX-2026-07-24: per-bot min spread (ticks) — RIF = 1
    // FIX-2026-08-02: DCA + BEP stack mode (opt-in, default off — backward compatible)
    dcaEnabled: document.getElementById('f-dca-enabled').checked,
    dcaMaxLayers: parseInt(document.getElementById('f-dca-max-layers').value, 10) || 3,
    // FIX-2026-08-03: DCA + Martingale sizing (opt-in, default off — backward compatible 100%)
    //   - server validates martingaleEnabled requires dcaEnabled=true (400 if violated)
    //   - default values mirror Bot schema defaults
    martingaleEnabled: document.getElementById('f-martingale-enabled').checked,
    martingaleMultiplier: parseFloat(document.getElementById('f-martingale-multiplier').value) || 1.5,
    martingaleMaxLayerNotional: parseFloat(document.getElementById('f-martingale-max-notional').value) || 100,
    // FIX-2026-09-02: Round-down Capital (opt-in per-bot) — ลด notional ให้พอดียอดคงเหลือ
    roundDownCapitalEnabled: document.getElementById('f-round-down-capital-enabled').checked,
    roundDownCapitalMin: parseFloat(document.getElementById('f-round-down-capital-min').value) || 5.5,
  };
  try {
    await API.put(`/api/bots/${botId}`, data);
    await AdminModalAlert.show({ title: '✅ บันทึกแล้ว', message: 'บันทึกการตั้งค่าบอทเรียบร้อย', level: 'success' });
    await loadBot();
  } catch (err) {
    document.getElementById('f-error').textContent = err.message;
  }
}

// FIX-2026-08-07: manual clear CBv2 cooldown (HYBRID mode) — ลบ cbv2LockedUntil + cbv2LockReason + reset trader._cbv2FiredAt
//   - try ก่อนแบบไม่ใส่ password → ถ้า 403 → prompt แล้ว retry (mirror callBotWithPassword pattern)
//   - ใช้ body.password แทน header X-Bot-Action-Password (ตรงกับ standard pattern ใน luxConfirm.callBotWithPassword)
window.unlockCBv2Now = async (id) => {
  const ok = await AdminModalAlert.confirm({
    title: '🔓 ปลด CBv2 Cooldown',
    message: 'ปลด CBv2 cooldown ตอนนี้?\n\n(ต้องใช้ BOT_ACTION_PASSWORD)',
    level: 'warn',
    okLabel: '🔓 ปลด Cooldown',
  });
  if (!ok) return;
  const btn = document.getElementById('btn-unlock-cbv2');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ กำลังปลด cooldown...'; }
  try {
    let resp;
    try {
      // first attempt — no password
      resp = await API.post(`/api/bots/${id}/unlock-cbv2`, {});
    } catch (err) {
      if (!err || (err.status !== 403 && err.status !== 503)) throw err;
      const pw = await AdminModalAlert.prompt({
        title: '🔐 BOT_ACTION_PASSWORD',
        message: 'กรอก BOT_ACTION_PASSWORD:',
        level: 'warn',
        okLabel: 'ยืนยัน',
        inputType: 'password',
      });
      if (!pw) throw new Error('ยกเลิก (ไม่ได้ใส่รหัส)');
      // retry — ใส่ password ใน body (backend รับ req.body.password)
      resp = await API.post(`/api/bots/${id}/unlock-cbv2`, { password: pw });
    }
    await AdminModalAlert.show({ title: '✅ สำเร็จ', message: 'ปลด CBv2 cooldown เรียบร้อย — S1 BUY กลับมาทำงานตามปกติ', level: 'success' });
    if (resp && resp.bot) {
      // refresh the page to clear the cooldown banner
      location.reload();
    }
  } catch (err) {
    await AdminModalAlert.show({ title: '⛔ ล้มเหลว', message: 'ปลด cooldown ล้มเหลว: ' + (err.response?.data?.error || err.body?.error || err.message), level: 'error' });
    if (btn) { btn.disabled = false; btn.textContent = '🔓 ปลด cooldown ตอนนี้'; }
  }
};

// FIX-2026-08-06: live countdown for CBv2 lock banner (HH:MM:SS remaining)
function startCbv2Countdown() {
  const el = document.querySelector('[data-cbv2-countdown]');
  if (!el) return;
  const target = new Date(el.getAttribute('data-cbv2-countdown')).getTime();
  function tick() {
    const ms = target - Date.now();
    if (ms <= 0) { el.textContent = '(expired → auto-resume pending)'; return; }
    const hh = Math.floor(ms / 3600000);
    const mm = Math.floor((ms % 3600000) / 60000);
    const ss = Math.floor((ms % 60000) / 1000);
    el.textContent = `(เหลือ ${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')})`;
    setTimeout(tick, 1000);
  }
  tick();
}
startCbv2Countdown();

init();

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}