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
              </ul>
            </div>
            <div class="col-md-6">
              <ul class="list-unstyled mb-0">
                <li class="mb-1">⚠️ <strong>SL-UKC</strong> — ใช้ <em>stack BEP</em> (ต้องเปิดจาก Classic)</li>
                <li class="mb-1">⚠️ <strong>autoArm SL-UKC</strong> — gate ต่อ stack (loss&gt;10% + age&gt;4h หลัง layer สุดท้าย)</li>
                <li class="mb-1">❌ <strong>CB panic-sell</strong> — ปิดอัตโนมัติใน DCA mode</li>
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
  const _tpEditLink = document.getElementById('dca-tp-edit-link');
  if (_tpEditLink) {
    _tpEditLink.addEventListener('click', () => {
      switchTab('classic');
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
    const el = document.getElementById('dca-exit-text');
    if (!el) return;
    if (!dcaOn) {
      el.textContent = 'DCA ปิดอยู่ — ใช้ logic เดิม (TP + CB panic-sell)';
      return;
    }
    if (slUkc && autoArm) {
      el.innerHTML = '<strong>TP</strong> + <strong>SL-UKC</strong> (จะ trigger เมื่อ stack BEP ขาดทุน &gt; 10% และอายุ &gt; 4h หลัง layer สุดท้าย + candle ปิดเหนือ upper-KC)';
    } else if (slUkc && !autoArm) {
      el.innerHTML = '<strong>TP</strong> + <strong>SL-UKC</strong> (immediate — จะ trigger ทันทีที่ขาดทุน + candle &gt; upper-KC) — ⚠️ ปิด autoArm = SL ไวกว่า TP เสมอ';
    } else if (!slUkc && autoArm) {
      el.innerHTML = '<strong>TP</strong> เท่านั้น (auto-arm = false เพราะ SL-UKC ปิด) — ⚠️ ไม่มี loss exit!';
    } else {
      el.innerHTML = '<strong>TP</strong> เท่านั้น — ⚠️ ไม่มี loss exit! เปิด SL-UKC จาก Classic tab ถ้าอยากมี stop loss';
    }
  }

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