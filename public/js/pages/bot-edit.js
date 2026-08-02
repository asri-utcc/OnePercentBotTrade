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
    const resp = await API.get(`/api/bots/${botId}`);
    bot = resp.bot;
    render();
  } catch (err) {
    document.getElementById('bot-edit-content').innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

function render() {
  const container = document.getElementById('bot-edit-content');
  // FIX-2026-08-03: tab-based layout — Classic + DCA tabs (single <form> wraps both panels)
  container.innerHTML = `
    <div class="lux-header"><span class="title">⚙️ ${escapeHtml(bot.name || bot.symbol)}</span><span class="text-muted-3" style="font-size:0.78rem;">${bot.symbol} · ${bot.timeframe}</span></div>
    <div class="lux-body">
    <form id="edit-form">
      <!-- TAB BAR — reuses .lux-tabs pattern from bot-detail.html -->
      <div class="lux-tabs" id="edit-tabs">
        <button type="button" class="lux-tab active" data-tab="classic">⚙️ ตั้งค่าบอท</button>
        <button type="button" class="lux-tab" data-tab="dca">📚 DCA + BEP Stack <span class="badge" id="dca-state-badge">${bot.dcaEnabled ? 'ON' : 'OFF'}</span></button>
      </div>

      <!-- TAB PANEL 1: Classic (default visible) -->
      <section data-tab-panel="classic">
        <div class="mb-3">
          <label class="form-label">ชื่อบอท</label>
          <input type="text" class="form-control" id="f-name" value="${bot.name || ''}" />
        </div>
        <div class="row">
          <div class="col-md-6 mb-3">
            <label class="form-label">คู่เทรด (แก้ไม่ได้)</label>
            <input type="text" class="form-control" value="${bot.symbol}" disabled />
          </div>
          <div class="col-md-6 mb-3">
            <label class="form-label">Timeframe</label>
            <select class="form-select" id="f-timeframe">
              ${['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'].map((tf) =>
                `<option value="${tf}" ${tf === bot.timeframe ? 'selected' : ''}>${tf}</option>`
              ).join('')}
            </select>
          </div>
        </div>
        <div class="row">
          <div class="col-md-6 mb-3">
            <label class="form-label">ทุนต่อไม้ (USDT)</label>
            <input type="number" class="form-control" id="f-capital" value="${bot.capitalPerTrade}" step="0.01" min="1" />
          </div>
          <div class="col-md-6 mb-3">
            <label class="form-label">จำนวนไม้</label>
            <input type="number" class="form-control" id="f-maxtrades" value="${bot.maxTrades}" step="1" min="1" max="100" />
          </div>
        </div>
        <div class="row">
          <div class="col-md-6 mb-3">
            <label class="form-label d-flex justify-content-between align-items-center">
              <span>TP %</span>
              <button type="button" class="btn btn-sm btn-outline-warning" id="f-tp-recommend" title="คำนวณ TP% จาก Min %KC(500 bars) + trend(upper-TF)">
                ✨ Get recommend TP%
              </button>
            </label>
            <input type="number" class="form-control" id="f-tp" value="${bot.tpPercent}" step="0.01" min="0.001" />
            <small class="text-muted" id="f-tp-hint">บอทจะบวก fee buffer (0.15-0.2%) อัตโนมัติ</small>
          </div>
          <div class="col-md-6 mb-3">
            <label class="form-label">Retry time (นาที)</label>
            <input type="number" class="form-control" id="f-retry" value="${bot.retryTimeMin}" step="0.1" min="0.1" max="60" />
            <small class="text-muted">ทศนิยมได้ เช่น 0.5 = 30 วินาที, 0.1 = 6 วินาที (เหมาะกับ timeframe 1m/3m)</small>
          </div>
        </div>
        <div class="row">
          <div class="col-md-6 mb-3">
            <label class="form-label">Retry max (ครั้งที่วางใหม่ได้)</label>
            <input type="number" class="form-control" id="f-retry-max" value="${bot.retryMax ?? 1}" step="1" min="0" max="10" />
            <small class="text-muted">0 = วางครั้งเดียว ไม่ retry; 1 = วางใหม่ได้ 1 ครั้งถ้า bid ขยับ</small>
          </div>
          <div class="col-md-6 mb-3">
            <label class="form-label">KC Multiplier <span title="ความกว้างของ Keltner Channel (default 1.5) — ค่าน้อย KC แคบ → signal S1 บ่อย, ค่ามาก KC กว้าง → signal น้อย">ⓘ</span></label>
            <input type="number" class="form-control" id="f-kc-mult" value="${bot.kcMult ?? 1.5}" step="0.1" min="0.5" max="5" />
            <small class="text-muted">range 0.5–5 (default 1.5 เป็น KC ปกติ)</small>
          </div>
        </div>
        <div class="row">
          <div class="col-md-6 mb-3">
            <label class="form-label">Min spread (ticks) <span title="จำนวน tick ขั้นต่ำที่ต้องมีระหว่าง bid-ask ก่อนวาง BUY — 1 = ใช้ bid ตรงๆ (post-only, เหมาะ low-cap), 2 = ต้องมี margin 1 tick (เหมาะ mid/high-cap)">ⓘ</span></label>
            <input type="number" class="form-control" id="f-min-spread" value="${bot.minSpreadTicks ?? 1}" step="1" min="0" max="10" />
            <small class="text-muted">0=ไม่สนใจ, 1=ใช้ bid (low-cap), 2=ต้อง margin 1 tick (default 1)</small>
          </div>
          <div class="col-md-6 mb-3"></div>
        </div>
        <div class="mb-3">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="f-s1-only-down" ${bot.s1OnlyDown ? 'checked' : ''} />
            <span class="form-check-label">📉 <strong>S1 = เฉพาะ bg 2→3 (ลงเท่านั้น)</strong> — ข้าม bg 2→1 (ซื้อตอนราคาสูง)</span>
          </label>
          <small class="text-muted d-block mt-1">
            bg_state: 1=Strong Up (เขียว), 2=Weak Down (ม่วง), 3=Strong Down (แดง)
            · S1 ปกติ = bg_prev=2 AND (bg=1 OR bg=3) · ถ้าเปิด toggle นี้ S1 = bg_prev=2 AND bg=3 (ลง) — ปลอดภัยกว่า
          </small>
        </div>
        <div class="mb-3">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="f-xs1-enabled" ${bot.xs1Enabled !== false ? 'checked' : ''} />
            <span class="form-check-label">🚫 <strong>XS1 anti-dump gate</strong> — ข้าม S1 เมื่อ candle-wide dump (ป้องกันซื้อตอนราคาไหลเร็ว)</span>
          </label>
          <small class="text-muted d-block mt-1">
            XS1 = (close &lt; lowerKC AND open &gt; basisKC) หรือ (open[1] &gt; basisKC[1] AND close[1] &lt; basisKC[1] AND close &lt; lowerKC AND open &lt; basisKC)
            · <strong>เปิด (default)</strong>: skip S1 เมื่อเจอ candle-wide dump (XS1 pattern)
            · <strong>ปิด</strong>: ใช้สัญญาณดั้งเดิม S1 ปกติ (ไม่ skip แม้ candle-wide dump)
          </small>
        </div>
        <div class="mb-3">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="f-stop-loss-upper-kc" ${bot.stopLossOnUpperKC ? 'checked' : ''} />
            <span class="form-check-label">🛑 <strong>ปิด position อัตโนมัติเมื่อราคาปิดทะลุ upper-KC</strong> (เฉพาะตอนขาดทุน)</span>
          </label>
          <small class="text-muted d-block mt-1">
            ตรวจทุก <code>kline:closed</code>: ถ้า <code>candle.close &gt; upperKC</code> และ position ยังขาดทุน → cancel LIMIT_MAKER SELL ค้าง + MARKET SELL ทันที
          </small>
        </div>
        <div class="mb-3">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="f-cb-enabled" ${bot.cbEnabled !== false ? 'checked' : ''} />
            <span class="form-check-label">🚨 <strong>Circuit-breaker panic-sell — ปิดทุก position เมื่อกราฟดิ่ง 3 แท่งติด</strong></span>
          </label>
          <small class="text-muted d-block mt-1">
            ตรวจทุก <code>kline:closed</code>: ถ้าแท่งปัจจุบัน + 3 แท่งก่อนหน้าทุกแท่ง "แดง (open &gt; close) AND open &lt; lowerKC AND close &lt; lowerKC"
            → cancel SELL ค้าง + MARKET SELL ทันทีทุก position ในบอท (ทั้งกำไรและขาดทุน) เพื่อกันกราฟไหลลงแล้วไม่ขึ้นอีก
            · <strong>เปิด (default)</strong>: panic-close ทุก position เมื่อ pattern ตรง
            · <strong>ปิด</strong>: ไม่แตะ — ใช้ logic เดิม (อาจขาดทุนต่อถ้ากราฟไหล)
          </small>
        </div>
        <div class="mb-3">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="f-safe-trade-enabled" ${bot.safeTradeEnabled !== false ? 'checked' : ''} />
            <span class="form-check-label">🛡️ <strong>Safe-trade filter</strong> — ก่อนซื้อตรวจ super-upper TF (3m/5m→4h, 15m→1d, 1h→1w)</span>
          </label>
          <small class="text-muted d-block mt-1">
            · PASS = lastClose &gt; open (แท่งเขียว) OR lastClose &gt; ema20 (uptrend)
            · FAIL-OPEN on Binance error
          </small>
        </div>
        <div class="mb-3">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="f-auto-pause-enabled" ${bot.autoPauseEnabled !== false ? 'checked' : ''} />
            <span class="form-check-label">⏸️ <strong>Auto-pause on low Min-%KC</strong> — หยุดบอทอัตโนมัติเมื่อ Min-%KC ต่ำกว่า threshold</span>
          </label>
        </div>
        <div class="mb-3">
          <label for="f-auto-pause-min-kc" class="form-label">📉 Auto-pause Min-%KC threshold (%)</label>
          <input type="number" class="form-control form-control-sm" id="f-auto-pause-min-kc" value="${bot.autoPauseMinKcPct ?? 2}" step="0.1" min="0.1" max="50" />
          <small class="text-muted d-block mt-1">ค่า default: 2% — ถ้า Min-%KC ต่ำกว่านี้จะ pause บอท (auto-resume เมื่อกลับมา)</small>
        </div>
        <div class="mb-3">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="f-auto-arm-stop-loss-ukc" ${bot.autoArmStopLossOnUKC !== false ? 'checked' : ''} />
            <span class="form-check-label">🛡️ <strong>Auto-arm SL-on-UKC สำหรับ position ที่ขาดทุนค้างนาน</strong> (loss &gt; 10% + age &gt; 4h)</span>
          </label>
          <small class="text-muted d-block mt-1">
            ตรวจทุก <code>kline:closed</code>: ถ้า position ในบอทนี้อยู่ใน state <code>selling</code> และ <strong>ขาดทุน &gt; 10%</strong> + <strong>เปิดมา &gt; 4 ชั่วโมง</strong>
            → ระบบจะ set <code>trade.useStopLossOnUKC = true</code> ให้อัตโนมัติ (per-trade flag) → จากนั้น <em>stop-loss on upper-KC</em> (toggle ด้านบน) จะยอม trigger
            · <strong>เปิด (default)</strong>: auto-arm flag เพื่อป้องกัน position ค้างยาวขาดทุนต่อ
            · <strong>ปิด</strong>: ไม่ arm flag — SL-on-UKC จะไม่ trigger แม้ toggle ด้านบนเปิดอยู่
          </small>
        </div>
        <div class="mb-3">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="f-auto-update-tp" ${bot.autoUpdateTp ? 'checked' : ''} />
            <span class="form-check-label">⏰ <strong>อัพเดท TP% อัตโนมัติทุกต้นชั่วโมง</strong></span>
          </label>
          <small class="text-muted d-block mt-1">
            ระบบจะ recompute TP% จาก Min %KC(window) + EMA20 trend(upper-TF) แล้ว persist ทุก <code>HH:00:00</code> (top-of-hour)
            ${bot.updateTpAt ? `· อัพเดทล่าสุด: <strong>${new Date(bot.updateTpAt).toLocaleString('th-TH')}</strong>` : '· ยังไม่เคยอัพเดทอัตโนมัติ'}
          </small>
        </div>
        <div class="row mb-3">
          <div class="col-md-6">
            <label class="form-label">📏 <strong>TP suggestion window (bars)</strong></label>
            <input type="number" class="form-control" id="f-suggest-tp-window" value="${bot.suggestTpWindow ?? 500}" step="10" min="30" max="1000" />
            <small class="text-muted">
              bars ที่ใช้คำนวณ Min %KC สำหรับ TP% — ใช้กับปุ่ม "Get recommend TP%" + auto-update
              · ค่าน้อย (e.g. 100) = sensitive ต่อ squeeze ล่าสุด
              · ค่ามาก (e.g. 800) = conservative จับ squeeze ที่ลึก
              · default 500
            </small>
          </div>
          <div class="col-md-6">
            <label class="form-label">📈 <strong>TP trend multiplier ×N</strong> <span title="เมื่อ upper-TF (e.g. 1h for 3m bot) close > EMA20 → ใช้ tpPercent × multiplier ตอนเปิด position ใหม่">ⓘ</span></label>
            <label class="form-check form-switch mb-2">
              <input type="checkbox" class="form-check-input" id="f-tp-trend-enabled" ${bot.tpTrendEnabled !== false ? 'checked' : ''} />
              <span class="form-check-label"><strong>เปิดใช้ TP trend ×N</strong> (default: เปิด)</span>
            </label>
            <input type="number" class="form-control" id="f-tp-trend-multiplier" value="${bot.tpTrendMultiplier ?? 2}" step="0.1" min="1" max="10" />
            <small class="text-muted">
              เมื่อ upper-TF trend above EMA20 → TP% จะคูณตัวนี้ (e.g. 0.2% × 2 = 0.4%)
              · <strong>1</strong> = ไม่คูณ (no multiplier — ใช้ค่านี้เมื่อปิด toggle หรืออยากคงที่)
              · <strong>2</strong> = double (default: 0.2% → 0.4%)
              · <strong>3-10</strong> = aggressive
              · apply เฉพาะ position ใหม่ — ไม่กระทบ in-flight SELL
              · cache 60s + warmup/lower → ไม่คูณ
              · <strong>ปิด toggle</strong> ด้านบน = ใช้ tpPercent ตรงๆ ไม่สนใจ trend + ไม่ call Binance API
            </small>
          </div>
        </div>
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
        <div class="mb-3">
          <label for="f-dca-max-layers" class="form-label">📊 <strong>DCA max layers</strong></label>
          <input type="number" class="form-control" id="f-dca-max-layers" value="${bot.dcaMaxLayers ?? 3}" step="1" min="1" max="100" />
          <small class="text-muted d-block mt-1">
            จำนวน layer สูงสุดต่อ stack (default 3, range 1-100)
            · max capital = <strong id="dca-max-cap">${((bot.capitalPerTrade || 10) * (bot.dcaMaxLayers || 3)).toFixed(2)} USDT</strong> (capitalPerTrade × maxLayers)
          </small>
        </div>
        <div class="mb-3" id="dca-cb-warning" style="display:${bot.dcaEnabled ? '' : 'none'};">
          <div class="alert alert-warning small mb-0">
            ⚠️ <strong>เมื่อเปิด DCA:</strong>
            CB panic-sell จะถูก disable อัตโนมัติ &nbsp;·&nbsp;
            SL-UKC จะใช้ <strong>stack BEP</strong> แทนราคาเดี่ยว
          </div>
        </div>
      </section>

      <!-- FOOTER — outside any panel, always visible -->
      <div class="alert alert-info" id="f-total"></div>
      <div class="text-danger small mb-3" id="f-error"></div>
      <button type="submit" class="btn btn-primary">💾 บันทึก</button>
      <a href="/bots.html" class="btn btn-secondary ms-2">กลับ</a>
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

  document.getElementById('edit-form').onsubmit = save;
  ['f-capital', 'f-maxtrades'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      updateTotal();
      updateDcaMaxCap();
    });
  });
  document.getElementById('f-tp-recommend').onclick = recommendTp;

  // FIX-2026-08-03: live-update DCA max-capital formula + DCA ↔ CB toggle interaction
  function updateDcaMaxCap() {
    const cap = parseFloat(document.getElementById('f-capital').value) || 0;
    const layers = parseInt(document.getElementById('f-dca-max-layers').value, 10) || 3;
    const el = document.getElementById('dca-max-cap');
    if (el) el.textContent = `${(cap * layers).toFixed(2)} USDT`;
  }
  const _dcaMaxLayers = document.getElementById('f-dca-max-layers');
  if (_dcaMaxLayers) _dcaMaxLayers.addEventListener('input', updateDcaMaxCap);

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
    if (autoSwitchTab && dcaOn) switchTab('dca'); // user-confirmed: jump to DCA tab when enabled
  }
  const _dcaToggle = document.getElementById('f-dca-enabled');
  if (_dcaToggle) _dcaToggle.addEventListener('change', () => refreshDcaUi({ autoSwitchTab: true }));
  refreshDcaUi();

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
    safeTradeEnabled: document.getElementById('f-safe-trade-enabled').checked, // FIX-2026-08-01: per-bot safe-trade filter (default ON)
    autoPauseEnabled: document.getElementById('f-auto-pause-enabled').checked, // FIX-2026-08-01: per-bot auto-pause on low Min-%KC (default ON)
    autoPauseMinKcPct: parseFloat(document.getElementById('f-auto-pause-min-kc').value) || 2, // FIX-2026-08-01: auto-pause threshold %
    autoArmStopLossOnUKC: document.getElementById('f-auto-arm-stop-loss-ukc').checked, // FIX-2026-07-31 (F1): per-bot auto-arm SL-on-UKC toggle (default true)
    tpTrendEnabled: document.getElementById('f-tp-trend-enabled').checked, // FIX-2026-08-01: per-bot TP trend ×N master toggle (default true)
    tpTrendMultiplier: parseFloat(document.getElementById('f-tp-trend-multiplier').value), // FIX-2026-07-31 (F2): per-bot TP ×N multiplier (1..10, default 2)
    autoUpdateTp: document.getElementById('f-auto-update-tp').checked, // FIX-2026-07-23: TP auto-update toggle
    suggestTpWindow: parseInt(document.getElementById('f-suggest-tp-window').value, 10), // FIX-2026-07-25: per-bot TP suggestion window (30..1000)
    kcMult: parseFloat(document.getElementById('f-kc-mult').value), // FIX-2026-07-24: per-bot KC multiplier
    minSpreadTicks: parseInt(document.getElementById('f-min-spread').value, 10), // FIX-2026-07-24: per-bot min spread (ticks) — RIF = 1
    // FIX-2026-08-02: DCA + BEP stack mode (opt-in, default off — backward compatible)
    dcaEnabled: document.getElementById('f-dca-enabled').checked,
    dcaMaxLayers: parseInt(document.getElementById('f-dca-max-layers').value, 10) || 3,
  };
  try {
    await API.put(`/api/bots/${botId}`, data);
    alert('บันทึกแล้ว');
    await loadBot();
  } catch (err) {
    document.getElementById('f-error').textContent = err.message;
  }
}

init();

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}