'use strict';

// FIX-2026-08-08 (rev3): Settings page rewrite
//   - 4 main groups: 🤖 บอท, 📢 แจ้งเตือน, 🛒 การซื้อขาย, 🛡️ ความปลอดภัย
//   - แต่ละกลุ่มใช้ .lux-details (collapsible <details>) เพื่อลด scroll
//   - Bot Defaults section ใหม่ — ตั้งค่า default ทุก field ที่ใช้ตอนสร้างบอท
//   - รวมฟังก์ชั่นเดิมทั้งหมด (Telegram / BNB Auto-Buy / Daily Target / Auto Add Bot /
//     CB Version / Auto Delete / DPS) — เพิ่มเติม Bot Defaults เป็น section 1️⃣ ใหม่

let cfg = null;        // telegram config
let bnbCfg = null;     // FIX-2026-08-05: auto-buy BNB config
let dailyTarget = null; // 2026-08-06: daily target gauge config
let autoAddBotCfg = null; // FIX-2026-08-07: auto add new bot config
let adminCfg = null;   // FIX-2026-08-08 (rev2): DPS tunables
let botDefaults = null; // FIX-2026-08-08 (rev3): Bot Defaults
let rateLimit = null;  // FIX-2026-08-21: Binance API rate-limit capacity
let autoReserveCfg = null; // FIX-2026-08-24: auto reserve/release USDT config

async function init() {
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me || !me.authenticated) {
    location.href = '/login.html';
    return;
  }
  await loadConfig();
}

async function loadConfig() {
  try {
    cfg = await API.get('/api/telegram/config');
    try {
      bnbCfg = await API.get('/api/bnb-auto-buy/config');
    } catch (err) {
      console.warn('auto-buy BNB config load failed:', err.message);
      bnbCfg = { enabled: false, topUpUsdt: 5.5, thresholdUsdt: 0.5, checkIntervalMin: 60, cooldownMin: 30, maxUsdtPerDay: 50, gaugeTargetUsdt: 10, status: {} };
    }
    try {
      dailyTarget = await API.get('/api/daily-target');
    } catch (err) {
      console.warn('daily-target config load failed:', err.message);
      dailyTarget = { targetThb: 100 };
    }
    try {
      autoAddBotCfg = await API.get('/api/auto-add-bot/config');
    } catch (err) {
      console.warn('auto-add-bot config load failed:', err.message);
      autoAddBotCfg = {
        enabled: false, intervalMin: 60, minKcPct: 2, maxPerRun: 5,
        scanTimeframe: '3m', scanThreshold: 0.5, scanWindow: 500, scanTpWindow: 30,
        scanTopN: 100, scanMinVol: 1_000_000, scanMinPct: 0.30,
        scanTrends: ['uptrend', 'downtrend', 'sideways'], telegramNotify: true,
        autoEnable: true,
        namePrefix: '(bAdd)',
        status: {},
      };
    }
    try {
      adminCfg = await API.get('/api/admin/app-config');
    } catch (err) {
      console.warn('admin app-config load failed:', err.message);
      adminCfg = { config: {} };
    }
    // FIX-2026-08-08 (rev3): Bot Defaults
    try {
      const resp = await API.get('/api/admin/bot-defaults');
      botDefaults = (resp && resp.defaults) ? resp.defaults : {};
    } catch (err) {
      console.warn('bot-defaults load failed:', err.message);
      botDefaults = {};
    }
    // FIX-2026-08-21: Binance API rate-limit
    try {
      rateLimit = await API.get('/api/admin/rate-limit');
    } catch (err) {
      console.warn('rate-limit load failed:', err.message);
      rateLimit = { capacity: 6000, min: 500, max: 120000, default: 6000, limiter: { tokens: 0 } };
    }
    // FIX-2026-08-24: Auto Reserve / Release USDT
    try {
      const r = await API.get('/api/wallet/auto-reserve/config');
      autoReserveCfg = r;
    } catch (err) {
      console.warn('auto-reserve config load failed:', err.message);
      autoReserveCfg = { config: { enabled: false, poleCount: 3, usdtPerPole: 10, lossThresholdPct: 2, checkHours: 4, stepUsdt: 10 }, status: {} };
    }
    render();
  } catch (err) {
    document.getElementById('settings-content').innerHTML =
      `<div class="lux-body"><div class="alert alert-danger">โหลด config ล้มเหลว: ${escapeHtml(err.message)}</div></div>`;
  }
}

function render() {
  // apply defaults กัน null/undefined
  bnbCfg = bnbCfg || { enabled: false, topUpUsdt: 5.5, thresholdUsdt: 0.5, checkIntervalMin: 60, cooldownMin: 30, maxUsdtPerDay: 50, gaugeTargetUsdt: 10, status: {} };
  autoAddBotCfg = autoAddBotCfg || {
    enabled: false, intervalMin: 60, minKcPct: 2, maxPerRun: 5,
    scanTimeframe: '3m', scanThreshold: 0.5, scanWindow: 500, scanTpWindow: 30,
    scanTopN: 100, scanMinVol: 1_000_000, scanMinPct: 0.30,
    scanTrends: ['uptrend', 'downtrend', 'sideways'], telegramNotify: true,
    autoEnable: true, namePrefix: '(bAdd)', status: {},
  };
  adminCfg = adminCfg || { config: {} };
  botDefaults = botDefaults || {};

  const ev = (cfg && cfg.events) || {};
  const th = (cfg && cfg.thresholds) || {};
  const aabStatus = autoAddBotCfg.status || {};
  const aabLastRunAt = aabStatus.lastRunAt ? new Date(aabStatus.lastRunAt).toLocaleString() : '—';
  const aabTickCount = aabStatus.tickCount != null ? aabStatus.tickCount : 0;
  const aabInFlight = aabStatus.inFlight ? '⏳ in-flight' : '';
  const aabTrends = autoAddBotCfg.scanTrends || ['uptrend', 'downtrend', 'sideways'];
  const aabLastStats = aabStatus.lastStats || null;
  const status = cfg && cfg.hasToken && cfg.chatId
    ? (cfg.enabled ? '🟢 live' : '🟡 token only')
    : '⚪ not configured';

  const html = `
    <div class="lux-card">
      <div class="lux-body">
        <!-- Quick navigation chips -->
        <div class="d-flex flex-wrap gap-2 mb-4" id="settings-chips">
          <a href="#group-bot" class="lux-chip">🤖 บอท</a>
          <a href="#group-notify" class="lux-chip">📢 แจ้งเตือน</a>
          <a href="#group-trading" class="lux-chip">🛒 การซื้อขาย</a>
          <a href="#group-safety" class="lux-chip">🛡️ ความปลอดภัย</a>
        </div>

        <!-- ════════ 🤖 กลุ่มที่ 1: บอท ════════ -->
        <h5 id="group-bot" class="settings-group-title">🤖 บอท</h5>
        <p class="text-muted-3 small mb-3">ตั้งค่าค่าเริ่มต้นสำหรับบอทใหม่ + ระบบอัตโนมัติที่เกี่ยวกับบอท</p>

        ${renderBotDefaultsSection()}
        ${renderAutoAddBotSection(aabStatus, aabLastRunAt, aabTickCount, aabInFlight, aabTrends, aabLastStats)}
        ${renderAutoDeleteSection()}

        <!-- ════════ 📢 กลุ่มที่ 2: แจ้งเตือน ════════ -->
        <h5 id="group-notify" class="settings-group-title">📢 การแจ้งเตือน</h5>
        <p class="text-muted-3 small mb-3">Telegram + Threshold สำหรับ position events</p>

        ${renderTelegramConnectionSection(status)}
        ${renderTelegramEventsSection(ev)}
        ${renderTelegramThresholdsSection(th)}

        <!-- ════════ 🛒 กลุ่มที่ 3: การซื้อขาย ════════ -->
        <h5 id="group-trading" class="settings-group-title">🛒 การซื้อขาย</h5>
        <p class="text-muted-3 small mb-3">ค่าเกี่ยวกับการเทรด (DPS + CB Version + Daily Target)</p>

        ${renderRateLimitSection()}
        ${renderAutoReserveSection()}
        ${renderCbVersionSection()}
        ${renderDpsSection()}
        ${renderDailyTargetSection()}

        <!-- ════════ 🛡️ กลุ่มที่ 4: ความปลอดภัย ════════ -->
        <h5 id="group-safety" class="settings-group-title">🛡️ ความปลอดภัย</h5>
        <p class="text-muted-3 small mb-3">Auto-Buy BNB + safety toggles</p>

        ${renderBnbSection()}

      </div>
    </div>
  `;

  document.getElementById('settings-content').innerHTML = html;
  bindEvents();
}

// ─── Helper: collapsible section ──────────────────────────────────
function section(id, icon, title, defaultOpen, body) {
  return `
    <details class="lux-details" id="${id}" ${defaultOpen ? 'open' : ''}>
      <summary class="lux-details-summary">
        <span>${icon}</span>
        <span>${escapeHtml(title)}</span>
      </summary>
      <div class="lux-details-body">
        ${body}
      </div>
    </details>
  `;
}

// ─── 🤖 Section: Bot Defaults (NEW 2026-08-08) ───────────────────
function renderBotDefaultsSection() {
  const d = botDefaults;
  return section('sec-bot-defaults', '✨', 'Bot Defaults — ค่าเริ่มต้นตอนสร้างบอทใหม่', true, `
    <div class="alert alert-info small mb-3">
      <strong>📌 วิธีใช้:</strong> ตั้งค่าเริ่มต้นทุก field ที่จะใช้ตอนสร้างบอทใหม่ (POST /api/bots)
      · ค่าเหล่านี้จะถูก pre-fill ใน New Bot modal บน <a href="/bots.html">bots.html</a>
      · บอทเดิมที่มีอยู่ไม่เปลี่ยนแปลง (ต้องแก้ทีละบอทผ่าน <a href="/bot-edit.html">bot-edit</a>)
    </div>

    <!-- ทุน & ความเสี่ยง -->
    <h6 class="text-muted-3 mb-2 mt-3">💰 ทุน & ความเสี่ยง</h6>
    <div class="row g-3">
      <div class="col-md-3">
        <label class="form-label">คู่เทรด default</label>
        <input type="text" class="form-control" id="bd-symbol" value="${escapeHtml(d.defaultSymbol || 'BNBUSDT')}" maxlength="20" />
      </div>
      <div class="col-md-3">
        <label class="form-label">Timeframe default</label>
        <select class="form-select" id="bd-tf">
          ${['1m','3m','5m','15m','30m','1h','2h','4h','1d'].map((tf) => `<option value="${tf}" ${d.defaultTimeframe === tf ? 'selected' : ''}>${tf}</option>`).join('')}
        </select>
      </div>
      <div class="col-md-3">
        <label class="form-label">ทุน/ไม้ (USDT)</label>
        <input type="number" class="form-control" id="bd-capital" value="${d.capitalPerTrade}" step="0.01" min="1" />
      </div>
      <div class="col-md-3">
        <label class="form-label">จำนวนไม้</label>
        <input type="number" class="form-control" id="bd-maxtrades" value="${d.maxTrades}" step="1" min="1" max="1000" />
      </div>
      <div class="col-md-3">
        <label class="form-label">TP % (default — ระบบจะคำนวณ ✨ Get ให้อัตโนมัติ)</label>
        <input type="number" class="form-control" id="bd-tp" value="${d.tpPercent}" step="0.001" min="0.001" />
      </div>
      <div class="col-md-3">
        <label class="form-label">Retry (นาที)</label>
        <input type="number" class="form-control" id="bd-retry" value="${d.retryTimeMin}" step="0.1" min="0.1" max="60" />
        <small class="text-muted">ทศนิยมได้ เช่น 0.5 = 30 วินาที</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">Retry max</label>
        <input type="number" class="form-control" id="bd-retry-max" value="${d.retryMax}" step="1" min="0" max="10" />
      </div>
      <div class="col-md-3">
        <label class="form-label">KC Mult</label>
        <input type="number" class="form-control" id="bd-kc-mult" value="${d.kcMult}" step="0.1" min="0.5" max="5" />
        <small class="text-muted">ความกว้างของ Keltner Channel</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">Min spread (ticks)</label>
        <input type="number" class="form-control" id="bd-min-spread" value="${d.minSpreadTicks}" step="1" min="0" max="10" />
      </div>
      <div class="col-md-3">
        <label class="form-label">TP suggest window (bars)</label>
        <input type="number" class="form-control" id="bd-suggest-tp-window" value="${d.suggestTpWindow}" step="10" min="30" max="1000" />
      </div>
    </div>

    <!-- Filters & toggles -->
    <h6 class="text-muted-3 mb-2 mt-4">🔀 Filters & Toggles</h6>
    <div class="row g-3">
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-s1-only-down" ${d.s1OnlyDown ? 'checked' : ''} />
          <span class="form-check-label">📉 S1 = bg 2→3 only (ลงเท่านั้น)</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-xs1-enabled" ${d.xs1Enabled ? 'checked' : ''} />
          <span class="form-check-label">🚫 XS1 anti-dump gate</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-cb-enabled" ${d.cbEnabled ? 'checked' : ''} />
          <span class="form-check-label">🚨 Circuit-breaker panic-sell (CB)</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-cbv2-enabled" ${d.cbv2Enabled ? 'checked' : ''} />
          <span class="form-check-label">💎 CBv2 sustained panic-sell</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-cbv3-enabled" ${d.cbv3Enabled ? 'checked' : ''} />
          <span class="form-check-label">💎 CBv3 panic-sell (CBv2 + ST3)</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-cbv5-enabled" ${d.cbv5Enabled ? 'checked' : ''} />
          <span class="form-check-label">💎 CBv5 Support Zone panic-sell</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-cb-auto-unlock-enabled" ${d.cbAutoUnlockEnabled ? 'checked' : ''} />
          <span class="form-check-label">🔓 CB Auto-Unlock</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-dynamic-size-enabled" ${d.dynamicSizeEnabled ? 'checked' : ''} />
          <span class="form-check-label">📊 Dynamic Position Sizing (DPS)</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-safe-trade-enabled" ${d.safeTradeEnabled ? 'checked' : ''} />
          <span class="form-check-label">🛡️ Safe-trade filter</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-safe-trade-trendline-enabled" ${d.safeTradeTrendlineEnabled ? 'checked' : ''} />
          <span class="form-check-label">📐 Safe-trade filter #2 (trendline)</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-safe-trade-no-trade-enabled" ${d.safeTradeNoTradeEnabled ? 'checked' : ''} />
          <span class="form-check-label">🚫 Safe-trade filter #3 (no-trade)</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-auto-pause-enabled" ${d.autoPauseEnabled ? 'checked' : ''} />
          <span class="form-check-label">⏸️ Auto-pause on low Min-%KC</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-auto-arm-stop-loss-ukc" ${d.autoArmStopLossOnUKC ? 'checked' : ''} />
          <span class="form-check-label">🛡️ Auto-arm SL-on-UKC</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-sl-ukc-trigger-on-profit" ${d.slUkcTriggerOnProfit ? 'checked' : ''} />
          <span class="form-check-label">💰 SL-UKC trigger on profit</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-tp-trend-enabled" ${d.tpTrendEnabled ? 'checked' : ''} />
          <span class="form-check-label">📈 TP trend ×N enabled</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-auto-update-tp" ${d.autoUpdateTp ? 'checked' : ''} />
          <span class="form-check-label">⏰ Auto-update TP% ทุกชั่วโมง</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-stop-loss-upper-kc" ${d.stopLossOnUpperKC ? 'checked' : ''} />
          <span class="form-check-label">🛑 Stop-Loss on upper-KC</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-dca-enabled" ${d.dcaEnabled ? 'checked' : ''} />
          <span class="form-check-label">📚 DCA + BEP stack mode</span>
        </label>
      </div>
    </div>

    <!-- CBv5 Advanced sub-section -->
    <div class="alert alert-warning bg-opacity-10 border border-warning border-opacity-25 small mb-3 mt-4">
      <strong>💎 CBv5 Advanced Setup</strong> — เงื่อนไข 4 ข้อ: <code>lowerKC break</code> + <code>deepest pivot low</code> + <code>bearish candle</code> + <code>volume spike</code> · cooldown S1 BUY <code>cbv5LockHours</code> ชม. (บอทไม่ถูกปิด)
    </div>
    <h6 class="text-muted-3 mb-2 mt-2">💎 CBv5 — Toggles ขั้นสูง</h6>
    <div class="row g-3">
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-cbv5-strict-break" ${d.cbv5StrictBreak ? 'checked' : ''} />
          <span class="form-check-label">🔒 Strict Break (ต้องปิดเหนือ lowerKC เป๊ะ)</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-cbv5-use-volume" ${d.cbv5UseVolume ? 'checked' : ''} />
          <span class="form-check-label">📊 Volume spike filter (vol × multiplier)</span>
        </label>
      </div>
    </div>

    <!-- Numeric fields -->
    <h6 class="text-muted-3 mb-2 mt-4">🔢 ค่าตัวเลข</h6>
    <div class="row g-3">
      <div class="col-md-3">
        <label class="form-label">CBv2 lock (ชม.)</label>
        <input type="number" class="form-control" id="bd-cbv2-lock-hours" value="${d.cbv2LockHours}" step="0.5" min="0.5" max="168" />
      </div>
      <div class="col-md-3">
        <label class="form-label">CBv3 lock (ชม.)</label>
        <input type="number" class="form-control" id="bd-cbv3-lock-hours" value="${d.cbv3LockHours}" step="0.5" min="0.5" max="168" />
      </div>
      <div class="col-md-3">
        <label class="form-label">💎 CBv5 lock (ชม.)</label>
        <input type="number" class="form-control" id="bd-cbv5-lock-hours" value="${d.cbv5LockHours}" step="0.5" min="0.5" max="168" />
      </div>
      <div class="col-md-3">
        <label class="form-label">💎 CBv5 KC length</label>
        <input type="number" class="form-control" id="bd-cbv5-kc-len" value="${d.cbv5KcLen}" step="1" min="5" max="100" />
      </div>
      <div class="col-md-3">
        <label class="form-label">💎 CBv5 KC mult</label>
        <input type="number" class="form-control" id="bd-cbv5-kc-mult" value="${d.cbv5KcMult}" step="0.1" min="0.5" max="5" />
      </div>
      <div class="col-md-3">
        <label class="form-label">💎 CBv5 pivot lookback</label>
        <input type="number" class="form-control" id="bd-cbv5-pivot-lookback" value="${d.cbv5PivotLookback}" step="1" min="2" max="10" />
      </div>
      <div class="col-md-3">
        <label class="form-label">💎 CBv5 pivot left length</label>
        <input type="number" class="form-control" id="bd-cbv5-pivot-left-len" value="${d.cbv5PivotLeftLen}" step="1" min="2" max="50" />
      </div>
      <div class="col-md-3">
        <label class="form-label">💎 CBv5 pivot right length</label>
        <input type="number" class="form-control" id="bd-cbv5-pivot-right-len" value="${d.cbv5PivotRightLen}" step="1" min="2" max="50" />
      </div>
      <div class="col-md-3">
        <label class="form-label">💎 CBv5 volume MA length</label>
        <input type="number" class="form-control" id="bd-cbv5-vol-ma-len" value="${d.cbv5VolMaLen}" step="1" min="5" max="100" />
      </div>
      <div class="col-md-3">
        <label class="form-label">💎 CBv5 volume multiplier ×N</label>
        <input type="number" class="form-control" id="bd-cbv5-vol-multiplier" value="${d.cbv5VolMultiplier}" step="0.1" min="1" max="10" />
      </div>
      <div class="col-md-3">
        <label class="form-label">💎 CBv5 debounce candles</label>
        <input type="number" class="form-control" id="bd-cbv5-debounce-candles" value="${d.cbv5DebounceCandles}" step="1" min="1" max="20" />
      </div>
      <div class="col-md-3">
        <label class="form-label">CB Auto-Unlock threshold (%)</label>
        <input type="number" class="form-control" id="bd-cb-auto-unlock-threshold" value="${d.cbAutoUnlockThresholdPct}" step="0.1" min="0.5" max="5" />
      </div>
      <div class="col-md-3">
        <label class="form-label">Auto-pause Min-%KC</label>
        <input type="number" class="form-control" id="bd-auto-pause-min-kc" value="${d.autoPauseMinKcPct}" step="0.1" min="0.1" max="50" />
      </div>
      <div class="col-md-3">
        <label class="form-label">Auto-pause 24h Min Vol (USDT)</label>
        <input type="number" class="form-control" id="bd-auto-pause-min-24h-vol" value="${d.autoPauseMin24hVolUsdt}" step="1000" min="0" />
      </div>
      <div class="col-md-3">
        <label class="form-label">Auto-arm loss (%)</label>
        <input type="number" class="form-control" id="bd-auto-arm-loss-pct" value="${d.autoArmLossPct}" step="0.5" min="1" max="99" />
      </div>
      <div class="col-md-3">
        <label class="form-label">Auto-arm age (ชม.)</label>
        <input type="number" class="form-control" id="bd-auto-arm-age-hours" value="${d.autoArmAgeHours}" step="0.5" min="0.5" max="999" />
      </div>
      <div class="col-md-3">
        <label class="form-label">TP trend multiplier ×N</label>
        <input type="number" class="form-control" id="bd-tp-trend-multiplier" value="${d.tpTrendMultiplier}" step="0.1" min="1" max="10" />
      </div>
      <div class="col-md-3">
        <label class="form-label">DCA Max Layers</label>
        <input type="number" class="form-control" id="bd-dca-max-layers" value="${d.dcaMaxLayers}" step="1" min="1" max="100" />
      </div>
    </div>

    <div class="mt-3 d-flex align-items-center flex-wrap">
      <button type="button" class="btn btn-primary" id="btn-save-bd">💾 บันทึก Bot Defaults</button>
      <button type="button" class="btn btn-outline-warning ms-2" id="btn-reset-bd">↩️ Reset เป็นค่าแนะนำ</button>
      <!-- FIX-2026-08-14: Import/Export file-based (cross-surface compatible JSON) -->
      <button type="button" class="btn btn-outline-secondary ms-2" id="btn-export-bd" title="บันทึกค่า Bot Defaults เป็นไฟล์ JSON">📤 Export</button>
      <button type="button" class="btn btn-outline-info ms-2" id="btn-import-bd-replace" title="โหลดไฟล์ทับฟอร์มทั้งหมด">📥 Import (Replace)</button>
      <button type="button" class="btn btn-outline-info ms-2" id="btn-import-bd-merge" title="โหลดไฟล์แบบ merge · อัพเดทเฉพาะ field ที่อยู่ในไฟล์">📥 Import (Merge)</button>
      <span class="ms-3 text-muted small" id="bd-status"></span>
    </div>

    <div class="text-muted small mt-2">
      <strong>ค่าแนะนำ:</strong> ทุน 9 USDT · TF 3m · KC×1.2 · TP 0.1% (ระบบจะคำนวณใหม่ด้วย ✨ Get) · ST#2 + ST#3 on · CBv2/CBv3 on · Auto-arm 6.3%/4h · DCA off
    </div>
  `);
}

// ─── 🤖 Section: Auto Add New Bot ────────────────────────────────
function renderAutoAddBotSection(aabStatus, aabLastRunAt, aabTickCount, aabInFlight, aabTrends, aabLastStats) {
  return section('sec-auto-add', '🤖', 'Auto Add New Bot — สแกน + สร้างบอทอัตโนมัติ', false, `
    <div class="mb-3">
      <label class="form-check form-switch">
        <input type="checkbox" class="form-check-input" id="aab-enabled" ${autoAddBotCfg.enabled ? 'checked' : ''} />
        <span class="form-check-label"><strong>เปิด Auto Add New Bot</strong> — สแกน + filter (ไม่มีบอท + Min %KC &gt; threshold) + create bot (DISABLED)</span>
      </label>
    </div>

    <div class="row g-3">
      <div class="col-md-3">
        <label class="form-label">⏱ Interval (นาที)</label>
        <input type="number" class="form-control" id="aab-interval" value="${autoAddBotCfg.intervalMin}" step="5" min="5" max="1440" />
        <small class="text-muted">ความถี่ในการสแกน (default 60 = 1 ชม. · min 5)</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">🎯 Min %KC (filter)</label>
        <input type="number" class="form-control" id="aab-min-kc" value="${autoAddBotCfg.minKcPct}" step="0.1" min="0" max="50" />
        <small class="text-muted">สร้างเฉพาะ symbol ที่ Min %KC &gt; ค่านี้</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">🛑 Max bots/run</label>
        <input type="number" class="form-control" id="aab-max-per-run" value="${autoAddBotCfg.maxPerRun}" step="1" min="1" max="50" />
        <small class="text-muted">cap ต่อรอบ scan (1..50)</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">📨 Telegram notify</label>
        <div class="form-check form-switch mt-2">
          <input class="form-check-input" type="checkbox" id="aab-tg" ${autoAddBotCfg.telegramNotify ? 'checked' : ''} />
          <label class="form-check-label" for="aab-tg">
            <span id="aab-tg-label">${autoAddBotCfg.telegramNotify ? 'เปิด' : 'ปิด'}</span>
          </label>
        </div>
        <small class="text-muted">ต้องเปิด event <code>autoAddBotCreated</code> ในกลุ่ม 📢 ด้วย</small>
      </div>
    </div>
    <div class="row g-3 mt-1">
      <div class="col-md-12">
        <label class="form-check form-switch">
          <input class="form-check-input" type="checkbox" id="aab-auto-enable" ${autoAddBotCfg.autoEnable !== false ? 'checked' : ''} />
          <span class="form-check-label">
            <strong>▶️ Auto-enable �อทที่เพิ่งสร้างทันที</strong>
            — เรียก <code>botManager.enableBot()</code> หลัง create → spawn Trader + เริ่มเทรดเลย · ถ้าปิดจะสร้างบอทในสถานะ DISABLED ไว้รอ user เปิดเองที่ <a href="/bots.html">bots.html</a>
          </span>
        </label>
      </div>
    </div>
    <div class="row g-3 mt-1">
      <div class="col-md-12">
        <label class="form-check form-switch">
          <input class="form-check-input" type="checkbox" id="aab-auto-restore" ${autoAddBotCfg.autoRestore !== false ? 'checked' : ''} />
          <span class="form-check-label">
            <strong>↩️ Auto-restore บอท soft-deleted</strong>
            — เมื่อ scan เจอ symbol ที่ตรงเกณ�์ แต่มีบอท soft-deleted อยู่ → restore + auto-enable ทันที (แทนการสร้างบอทใหม่ซ้อน) · ถ้าปิดจะสร้างบอทใหม่ (อาจซ้อนกับบอท soft-deleted)
          </span>
        </label>
      </div>
    </div>
    <div class="row g-3 mt-1">
      <div class="col-md-6">
        <label class="form-label">🏷 Name Prefix <span class="text-muted">(ต่อท้ายชื่อบอทที่ auto-add สร้าง)</span></label>
        <input type="text" class="form-control" id="aab-name-prefix" value="${escapeHtml(autoAddBotCfg.namePrefix || '(bAdd)')}" maxlength="32" placeholder="(bAdd)" />
        <small class="text-muted">ตัวอย่าง: ถ้าใส่ <code>(bAdd)</code> → ชื่อบอทที่สร้างคือ <code>BTC(bAdd)</code></small>
      </div>
    </div>

    <hr />
    <div class="text-muted-3 small mb-2">📊 Scan parameters (ใช้กับ volatilityScanner.scanUniverse)</div>
    <div class="row g-3">
      <div class="col-md-2">
        <label class="form-label">Timeframe</label>
        <select id="aab-tf" class="form-select">
          ${['1m','3m','5m','15m','30m','1h','2h','4h'].map((tf) => `<option value="${tf}" ${autoAddBotCfg.scanTimeframe === tf ? 'selected' : ''}>${tf}</option>`).join('')}
        </select>
      </div>
      <div class="col-md-2">
        <label class="form-label">% Vol thr</label>
        <input type="number" class="form-control" id="aab-thr" value="${autoAddBotCfg.scanThreshold}" step="0.1" min="0.1" max="100" />
      </div>
      <div class="col-md-2">
        <label class="form-label">Window</label>
        <input type="number" class="form-control" id="aab-win" value="${autoAddBotCfg.scanWindow}" step="50" min="5" max="20000" />
      </div>
      <div class="col-md-2">
        <label class="form-label">TP Window</label>
        <input type="number" class="form-control" id="aab-tpwin" value="${autoAddBotCfg.scanTpWindow}" step="5" min="20" max="1000" />
      </div>
      <div class="col-md-2">
        <label class="form-label">Top N</label>
        <input type="number" class="form-control" id="aab-topn" value="${autoAddBotCfg.scanTopN}" step="10" min="20" max="300" />
      </div>
      <div class="col-md-2">
        <label class="form-label">Min 24h Vol</label>
        <input type="number" class="form-control" id="aab-minvol" value="${autoAddBotCfg.scanMinVol}" step="100000" min="0" />
      </div>
      <div class="col-md-2">
        <label class="form-label">Min % bars</label>
        <input type="number" class="form-control" id="aab-minpct" value="${Math.round((autoAddBotCfg.scanMinPct || 0.30) * 100)}" step="5" min="0" max="100" />
        <small class="text-muted">ส่งเป็น 0..1 ให้ API</small>
      </div>
      <div class="col-md-10">
        <label class="form-label">Trend</label>
        <div class="d-flex gap-3 flex-wrap align-items-center">
          <label class="trend-chip uptrend">
            <input type="checkbox" id="aab-trend-up" ${aabTrends.includes('uptrend') ? 'checked' : ''} />
            <span class="chip-glyph">📈</span>
            <span class="chip-label">Uptrend</span>
          </label>
          <label class="trend-chip downtrend">
            <input type="checkbox" id="aab-trend-down" ${aabTrends.includes('downtrend') ? 'checked' : ''} />
            <span class="chip-glyph">📉</span>
            <span class="chip-label">Downtrend</span>
          </label>
          <label class="trend-chip sideways">
            <input type="checkbox" id="aab-trend-side" ${aabTrends.includes('sideways') ? 'checked' : ''} />
            <span class="chip-glyph">↔️</span>
            <span class="chip-label">Sideways</span>
          </label>
        </div>
      </div>
    </div>

    <div class="mt-3">
      <button type="button" class="btn btn-primary" id="btn-save-aab">💾 บันทึก Auto Add Bot</button>
      <button type="button" class="btn btn-outline-warning ms-2" id="btn-trigger-aab">🖐 Run now</button>
      <span class="ms-2 text-muted small" id="aab-status"></span>
    </div>

    <div class="text-muted small mt-3">
      <strong>สถานะ:</strong> ${autoAddBotCfg.enabled ? '🟢 enabled' : '⚪ disabled'} · interval=${autoAddBotCfg.intervalMin} นาที · max/run=${autoAddBotCfg.maxPerRun} · Min %KC=${autoAddBotCfg.minKcPct} · autoEnable=${autoAddBotCfg.autoEnable !== false ? '▶️ ON' : '⏸ OFF'} · namePrefix=<code>${escapeHtml(autoAddBotCfg.namePrefix || '(bAdd)')}</code> · ${aabInFlight}
      <br /><strong>Last run:</strong> ${aabLastRunAt} · tickCount=${aabTickCount}
      ${aabLastStats ? `<br /><strong>Last stats:</strong> outcome=${escapeHtml(aabLastStats.outcome || '—')} · scanned=${aabLastStats.scanned ?? '?'} · candidates=${aabLastStats.candidates ?? 0} · created=${aabLastStats.created ?? 0}${aabLastStats.createdEnabled != null ? ` (▶️ enabled ${aabLastStats.createdEnabled})` : ''}` : ''}
      ${aabStatus.lastRunError ? `<br /><strong>Last error:</strong> <span class="text-danger">${escapeHtml(aabStatus.lastRunError)}</span>` : ''}
    </div>
  `);
}

// ─── 🤖 Section: Auto Delete Bot ─────────────────────────────────
function renderAutoDeleteSection() {
  return section('sec-auto-delete', '🗑', 'Auto Delete Bot (soft delete + 30 วัน restore)', false, `
    <div class="mb-3">
      <label class="form-check form-switch">
        <input type="checkbox" class="form-check-input" id="adb-enabled" ${cfg.autoDeleteBotEnabled ? 'checked' : ''} />
        <span class="form-check-label"><strong>เปิด Auto Delete Bot</strong> — soft-delete บอทที่ปิดไว้นานเกิน N วัน (ไม่มี position + ไม่ใช่ DCA stack)</span>
      </label>
    </div>

    <div class="row g-3">
      <div class="col-md-4">
        <label class="form-label">📅 Days threshold</label>
        <input type="number" class="form-control" id="adb-days" value="${cfg.autoDeleteBotDays ?? 30}" step="1" min="7" max="365" />
        <small class="text-muted">7..365 วัน (default 30) — soft-delete หลังปิดนานเกินนี้</small>
      </div>
      <div class="col-md-4">
        <label class="form-label">⏰ Warning days (ล่วงหน้า)</label>
        <input type="number" class="form-control" id="adb-warndays" value="${cfg.autoDeleteBotWarningDays ?? 3}" step="1" min="1" max="30" />
        <small class="text-muted">1..30 วัน (default 3) — telegram แจ้งล่วงหน้าก่อนลบ</small>
      </div>
      <div class="col-md-4 d-flex align-items-end">
        <div class="text-muted-3 small w-100">
          <div><strong>Last run:</strong> <span>${cfg.autoDeleteBotLastRunAt ? new Date(cfg.autoDeleteBotLastRunAt).toLocaleString() : '—'}</span></div>
          <div><strong>Restore window:</strong> 30 วัน (POST /api/bots/<code>:id</code>/restore)</div>
        </div>
      </div>
    </div>

    <div class="mt-3">
      <button type="button" class="btn btn-primary" id="btn-save-adb">💾 บันทึก Auto Delete</button>
      <span class="ms-2 text-muted small" id="adb-status"></span>
    </div>

    <div class="text-muted small mt-3">
      <strong>Exclude:</strong> DCA-stack + Martingale (บอทที่มี layers รอดำเนินการต่อ) + บอทที่มี open positions
      <br /><strong>Last stats:</strong> ${cfg.autoDeleteBotLastStats ? `scanned=${cfg.autoDeleteBotLastStats.scanned ?? '?'} · warned=${cfg.autoDeleteBotLastStats.warned ?? 0} · deleted=${cfg.autoDeleteBotLastStats.scheduled ?? 0}` : '—'}
    </div>
  `);
}

// ─── 📢 Section: Telegram Connection ─────────────────────────────
function renderTelegramConnectionSection(status) {
  return section('sec-tg-conn', '🔗', 'Telegram — การเชื่อมต่อ', true, `
    <div class="text-muted small mb-2">สถานะ: ${status}</div>

    <div class="mb-3">
      <label class="form-label">🤖 Bot Token <span class="text-muted">(จาก @BotFather; เก็บแบบ encrypted)</span></label>
      <div class="input-group">
        <input type="password" class="form-control" id="f-token" placeholder="${cfg.hasToken ? '•••••• (token ถูกตั้งไว้แล้ว — พิมพ์ใหม่เพื่อเปลี่ยน)' : 'เช่น 7123456789:AAH...token...'}" autocomplete="off" />
        <button type="button" class="btn btn-primary" id="btn-set-token">🔑 ตั้ง Token</button>
        <button type="button" class="btn btn-outline-danger" id="btn-clear-token" ${cfg.hasToken ? '' : 'disabled'}>🗑 ลบ Token</button>
      </div>
      <small class="text-muted">รูปแบบ: <code>&lt;bot_id&gt;:&lt;35+ chars&gt;</code></small>
    </div>

    <div class="mb-3">
      <label class="form-label">💬 Chat ID <span class="text-muted">(ของคุณ หรือ group)</span></label>
      <div class="input-group">
        <input type="text" class="form-control" id="f-chat-id" value="${escapeHtml(cfg.chatId || '')}" placeholder="เช่น 123456789 หรือ -100xxxxxxxx" />
        <button type="button" class="btn btn-primary" id="btn-save-chat">💾 บันทึก Chat ID</button>
      </div>
    </div>

    <div class="mb-3">
      <button type="button" class="btn btn-outline-primary" id="btn-test">📨 ส่งข้อความทดสอบ</button>
      <span class="ms-2 text-muted small" id="test-status"></span>
    </div>

    <div class="mb-3">
      <label class="form-check form-switch">
        <input type="checkbox" class="form-check-input" id="f-enabled" ${cfg.enabled ? 'checked' : ''} />
        <span class="form-check-label"><strong>เปิดใช้งาน Telegram</strong> — ถ้าปิดจะไม่ส่งข้อความใดๆ (config ยังอยู่)</span>
      </label>
    </div>
  `);
}

// ─── 📢 Section: Telegram Events ─────────────────────────────────
function renderTelegramEventsSection(ev) {
  const events = [
    { id: 'ev-buyFilled', k: 'buyFilled', icon: '🟢', title: 'BUY filled', desc: 'บอทซื้อสำเร็จ (state=holding)' },
    { id: 'ev-sellFilled', k: 'sellFilled', icon: '💰', title: 'SELL filled', desc: 'บอทขายสำเร็จ พร้อม P&L' },
    { id: 'ev-insufficientBalance', k: 'insufficientBalance', icon: '⚠️', title: 'เงินหมด', desc: 'USDT ไม่พอสำหรับเทรด' },
    { id: 'ev-botEnabled', k: 'botEnabled', icon: '▶️', title: 'เปิดบอท', desc: 'บอทถูก enable' },
    { id: 'ev-botDisabled', k: 'botDisabled', icon: '⏸', title: 'ปิดบอท', desc: 'บอทถูก disable' },
    { id: 'ev-botDeleted', k: 'botDeleted', icon: '🗑', title: 'ลบบอท', desc: 'บอทถูกลบออกจากระบบ' },
    { id: 'ev-positionLoss', k: 'positionLoss', icon: '🔻', title: 'Position loss', desc: 'ขาดทุนเกิน threshold' },
    { id: 'ev-positionProfit', k: 'positionProfit', icon: '🔺', title: 'Position profit', desc: 'กำไรเกิน threshold' },
    { id: 'ev-positionStuck', k: 'positionStuck', icon: '⏳', title: 'Position stuck', desc: 'เปิด position นานเกิน threshold' },
    { id: 'ev-dailySummary', k: 'dailySummary', icon: '📅', title: 'สรุปรายวัน', desc: 'ส่งที่ 00:05 ของวันถัดไป', default: true },
    { id: 'ev-weeklySummary', k: 'weeklySummary', icon: '📆', title: 'สรุปรายสัปดาห์', desc: 'ส่งจันทร์ 00:05 ของสัปดาห์ถัดไป', default: true },
    { id: 'ev-monthlySummary', k: 'monthlySummary', icon: '🗓', title: 'สรุปรายเดือน', desc: 'ส่งวันที่ 1 เดือนถัดไป', default: true },
    { id: 'ev-tpLowPnL', k: 'tpLowPnL', icon: '⚠️', title: 'TP ต่ำเกินไป', desc: 'NET TP &lt; 0.2%', default: true },
    { id: 'ev-cbPanicClose', k: 'cbPanicClose', icon: '🚨', title: 'CB panic-sell', desc: '3 แท่งติด red + below lowerKC → panic-close ALL positions', default: true },
    { id: 'ev-cbv2PanicClose', k: 'cbv2PanicClose', icon: '💎', title: 'CBv2 sustained panic-sell', desc: '4 แท่งติด red + cooldown BUY', default: true },
    { id: 'ev-botLocked', k: 'botLocked', icon: '⏸', title: 'Bot cooldown (CBv2)', desc: 'บอทถูกบังคับ cooldown S1 BUY', default: true },
    { id: 'ev-cbv3PanicClose', k: 'cbv3PanicClose', icon: '💎', title: 'CBv3 panic-sell', desc: 'CBv2 + ST3 no-trade upper-TF', default: true },
    { id: 'ev-dpsResize', k: 'dpsResize', icon: '📊', title: 'DPS resize', desc: 'แจ้งเมื่อ size/layers เปลี่ยน', default: true },
    { id: 'ev-botAutoUnlocked', k: 'botAutoUnlocked', icon: '🔓', title: 'CB Auto-unlock', desc: 'Cooldown ปลดอัตโนมัติ', default: true },
    { id: 'ev-autoDeleteBotWarning', k: 'autoDeleteBotWarning', icon: '⏰', title: 'Auto Delete — แจ้งล่วงหน้า', desc: 'แจ้งก่อน soft-delete', default: true },
    { id: 'ev-autoDeleteBotRemoved', k: 'autoDeleteBotRemoved', icon: '🗑', title: 'Auto Delete — soft-deleted', desc: 'แจ้งเมื่อ soft-delete (restore ได้ 30 วัน)', default: true },
    { id: 'ev-bnbLowBalance', k: 'bnbLowBalance', icon: '💎', title: 'BNB balance ต่ำ', desc: 'BNB value &lt; threshold', default: true },
    // 2026-08-09: Telegram Login — alternative login channel (OTP 6 หลักเข้า Telegram แทน password)
    //   - ปิดได้ถ้าไม่ต้องการให้ user login ผ่าน Telegram
    { id: 'ev-telegramLogin', k: 'telegramLogin', icon: '📨', title: 'Telegram Login', desc: 'OTP 6 หลักสำหรับ login ผ่าน Telegram (ลืม password)', default: true },
  ];

  const cards = events.map((e) => {
    const checked = ev[e.k] !== undefined ? ev[e.k] : (e.default || false);
    return `
      <div class="col-md-6">
        <label class="form-check">
          <input type="checkbox" class="form-check-input" id="${e.id}" ${checked ? 'checked' : ''} />
          <span class="form-check-label">${e.icon} <strong>${e.title}</strong> <small class="text-muted d-block">${e.desc}</small></span>
        </label>
      </div>
    `;
  }).join('');

  return section('sec-tg-events', '📨', 'Telegram — Event ที่จะแจ้งเตือน', false, `
    <div class="row g-3">${cards}</div>
    <div class="mt-3">
      <button type="button" class="btn btn-primary" id="btn-save-events">💾 บันทึก Events</button>
      <span class="ms-2 text-muted small" id="events-status"></span>
    </div>
  `);
}

// ─── 📢 Section: Telegram Thresholds ────────────────────────────
function renderTelegramThresholdsSection(th) {
  return section('sec-tg-th', '📏', 'Telegram — Threshold สำหรับ position events', false, `
    <div class="row g-3">
      <div class="col-md-4">
        <label class="form-label">🔻 Loss % <span class="text-muted">(≥ แจ้งเตือน)</span></label>
        <input type="number" class="form-control" id="th-loss" value="${th.positionLossPct ?? 2}" step="0.1" min="0.1" max="100" />
        <small class="text-muted">ค่าบวก เช่น <code>2</code> = แจ้งเมื่อ PnL ≤ -2%</small>
      </div>
      <div class="col-md-4">
        <label class="form-label">🔺 Profit % <span class="text-muted">(≥ แจ้งเตือน)</span></label>
        <input type="number" class="form-control" id="th-profit" value="${th.positionProfitPct ?? 1}" step="0.1" min="0.1" max="100" />
        <small class="text-muted">เช่น <code>1</code> = แจ้งเมื่อ PnL ≥ +1%</small>
      </div>
      <div class="col-md-4">
        <label class="form-label">⏳ Stuck (นาที) <span class="text-muted">(≥ แจ้งเตือน)</span></label>
        <input type="number" class="form-control" id="th-stuck" value="${th.positionStuckMin ?? 30}" step="1" min="1" max="1440" />
        <small class="text-muted">เช่น <code>30</code> = แจ้งเมื่อเปิด ≥ 30 นาที</small>
      </div>
      <div class="col-md-4">
        <label class="form-label">💎 BNB low (USDT) <span class="text-muted">(&lt; แจ้งเตือน)</span></label>
        <input type="number" class="form-control" id="th-bnbLow" value="${th.bnbLowBalanceUsdt ?? 0.5}" step="0.05" min="0.05" max="100" />
        <small class="text-muted">เช่น <code>0.5</code> = แจ้งเมื่อ BNB value &lt; $0.50</small>
      </div>
    </div>

    <div class="mt-3">
      <button type="button" class="btn btn-primary" id="btn-save-thresholds">💾 บันทึก Thresholds</button>
      <span class="ms-2 text-muted small" id="thresholds-status"></span>
    </div>

    <div class="text-muted small mt-3">
      <strong>หมายเหตุ:</strong> สแกน open positions ทุก 30s (PnL) และ 60s (stuck); การแจ้งจะเกิดตอน <em>crossing</em> เข้า threshold เท่านั้น
    </div>
  `);
}

// ─── 🛒 Section: Binance API Rate Limit (FIX-2026-08-21) ──────────
function renderRateLimitSection() {
  const rl = rateLimit || { capacity: 6000, min: 500, max: 120000, default: 6000, limiter: { tokens: 0 } };
  const cap = Number.isFinite(rl.capacity) ? rl.capacity : 6000;
  const min = rl.min || 500;
  const max = rl.max || 120000;
  const def = rl.default || 6000;
  const usedEstimated = Math.max(0, cap - (rl.limiter && Number.isFinite(rl.limiter.tokens) ? rl.limiter.tokens : 0));
  const usedPct = cap > 0 ? Math.min(100, Math.round((usedEstimated / cap) * 100)) : 0;
  const presetHalf = Math.max(min, Math.round(def / 2));
  const presetThird = Math.max(min, Math.round(def / 3));
  const presetQuarter = Math.max(min, Math.round(def / 4));
  return section('sec-rate-limit', '🌐', 'Binance API — Rate Limit (token-bucket capacity)', false, `
    <div class="alert alert-info small mb-3">
      <strong>📌 ใช้เมื่อไหร่:</strong> ถ้า server เครื่องนี้รันหลาย instance / หลายระบบ ที่ share public IP เดียวกัน
      Binance จะนับ REQUEST_WEIGHT รวมกัน → ควรหาร capacity กัน (เช่น 2 ระบบ → ตั้ง 3000/min ต่อ instance)
      <br/><strong>ค่าเริ่มต้น:</strong> ${def} (Binance IP-based limit) · <strong>ช่วง:</strong> ${min}..${max}
      <br/><strong>Bot Account:</strong> ถ้าใช้ Binance Bot Account จะได้สูงสุด 120,000/min
    </div>

    <div class="row g-3">
      <div class="col-md-4">
        <label class="form-label">🎚 Capacity (REQUEST_WEIGHT / นาที)</label>
        <input type="number" class="form-control" id="rl-capacity" value="${cap}" step="100" min="${min}" max="${max}" />
        <small class="text-muted">ช่วง ${min}..${max} · มีผลทันที (no restart)</small>
      </div>
      <div class="col-md-8">
        <label class="form-label">⚡ Presets (จาก default ${def})</label>
        <div class="d-flex gap-2 flex-wrap">
          <button type="button" class="btn btn-outline-secondary btn-sm rl-preset" data-cap="${def}">🎯 ${def} (1 instance)</button>
          <button type="button" class="btn btn-outline-secondary btn-sm rl-preset" data-cap="${presetHalf}">½ × ${def} = ${presetHalf} (2 instances)</button>
          <button type="button" class="btn btn-outline-secondary btn-sm rl-preset" data-cap="${presetThird}">⅓ × ${def} = ${presetThird} (3 instances)</button>
          <button type="button" class="btn btn-outline-secondary btn-sm rl-preset" data-cap="${presetQuarter}">¼ × ${def} = ${presetQuarter} (4 instances)</button>
          <button type="button" class="btn btn-outline-warning btn-sm" id="rl-reset-default">↩️ Reset → ${def}</button>
        </div>
        <small class="text-muted d-block mt-1">คลิก preset เพื่อกรอกอัตโนมัติ แล้วกด 💾 บันทึก</small>
      </div>
    </div>

    <div class="mt-3">
      <button type="button" class="btn btn-primary" id="btn-save-rl">💾 บันทึก Rate Limit</button>
      <button type="button" class="btn btn-outline-info ms-2" id="btn-reload-rl">🔄 Refresh สถานะ</button>
      <span class="ms-2 text-muted small" id="rl-status"></span>
    </div>

    <div class="mt-3">
      <strong>📊 Live limiter (in-process):</strong>
      <div>capacity = <code>${cap}</code> · used ≈ <code>${usedEstimated}</code> (${usedPct}%) · tokens คงเหลือ ≈ <code>${Math.max(0, cap - usedEstimated)}</code></div>
      <div class="progress mt-2" style="height: 8px;">
        <div class="progress-bar ${usedPct > 90 ? 'bg-danger' : usedPct > 70 ? 'bg-warning' : 'bg-success'}" role="progressbar" style="width: ${usedPct}%" aria-valuenow="${usedPct}" aria-valuemin="0" aria-valuemax="100"></div>
      </div>
      <small class="text-muted mt-2 d-block">
        <strong>หมายเหตุ:</strong> ใช้ได้กับทุก Binance calls (signed + public) — binanceRest.RateLimiter token-bucket
        <br/>refill rate = <code>${(cap / 60000).toFixed(4)}</code> token/ms ≈ <code>${(cap / 60).toFixed(2)}</code> token/sec
        <br/>ถ้าเห็น <code class="text-danger">weight approaching limit</code> ใน log → ลดค่า หรือรอ spread ให้กระจายดีขึ้น
      </small>
    </div>
  `);
}

// ─── 🛒 Section: Auto Reserve / Release (FIX-2026-08-24) ─────────
function renderAutoReserveSection() {
  const cfg = (autoReserveCfg && autoReserveCfg.config) || {};
  const status = (autoReserveCfg && autoReserveCfg.status) || {};
  const enabled = !!cfg.enabled;
  const lastRunAt = status.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : '—';
  const tickCount = status.tickCount != null ? status.tickCount : 0;
  const inFlight = status.inFlight ? '⏳ in-flight' : '';
  const lastStats = status.lastStats || null;
  return section('sec-auto-reserve', '🤖', 'Auto Reserve / Release USDT — กั๊กเงินอัตโนมัติ', false, `
    <div class="alert alert-info small mb-3">
      <strong>📌 วิธีทำงาน:</strong> ทุก ๆ <code>checkHours</code> �ั่วโมง (ตามเวลา BKK) ระบบจะเช็คว่า
      <code>(usable / usdtPerPole) + จำนวน positions ที่ติดลบน้อยกว่า lossThresholdPct</code>
      เท่ากับเป้า <code>poleCount</code> หรือไม่ — ถ้ามากกว่า → กั๊กเพิ่ม, ถ้าน้อยกว่า → ปล่อย
      (ครั้งละ <code>stepUsdt</code> USDT) · ดูสวิทช์เล็ก ๆ ในหน้า <a href="/wallet.html">wallet.html</a> ก็ได้
    </div>

    <div class="mb-3">
      <label class="form-check form-switch">
        <input type="checkbox" class="form-check-input" id="ar-enabled" ${enabled ? 'checked' : ''} />
        <span class="form-check-label"><strong>เปิด Auto Reserve</strong> — ระบบจะปรับ reserve อัตโนมัติทุก � <code>checkHours</code> ชั่วโมง</span>
      </label>
    </div>

    <div class="row g-3">
      <div class="col-md-3">
        <label class="form-label">🎯 Pole count (เ�้า)</label>
        <input type="number" class="form-control" id="ar-polecount" value="${cfg.poleCount ?? 3}" step="1" min="1" max="100" />
        <small class="text-muted">จำนวนไม้ที่ต้องการให้ "สำรอง" (default 3)</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">💵 USDT / ไม้</label>
        <input type="number" class="form-control" id="ar-usdtperpole" value="${cfg.usdtPerPole ?? 10}" step="1" min="1" max="1000" />
        <small class="text-muted">มูลค่า 1 ไม้ (default 10)</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">📉 Loss threshold %</label>
        <input type="number" class="form-control" id="ar-losspct" value="${cfg.lossThresholdPct ?? 2}" step="0.1" min="0.1" max="50" />
        <small class="text-muted">positions ที่ขาดทุน &lt; นี้ → นับเป็น 1 ไม้ (default 2%)</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">⏱ Check (hours)</label>
        <select class="form-select" id="ar-checkhours">
          ${[1,2,3,4,6,8,12,24].map((h) => `<option value="${h}" ${(cfg.checkHours ?? 4) === h ? 'selected' : ''}>${h} �ม.</option>`).join('')}
        </select>
        <small class="text-muted">ต้องหาร 24 ลงตัว (default 4 → 00/04/08/12/16/20 BKK)</small>
      </div>
    </div>
    <div class="row g-3 mt-1">
      <div class="col-md-3">
        <label class="form-label">📏 Step USDT</label>
        <input type="number" class="form-control" id="ar-step" value="${cfg.stepUsdt ?? 10}" step="1" min="1" max="1000" />
        <small class="text-muted">กั๊ก/ปล่อยครั้งละกี่ USDT (default 10)</small>
      </div>
    </div>

    <div class="mt-3">
      <button type="button" class="btn btn-primary" id="btn-save-ar">💾 บันทึก Auto Reserve</button>
      <button type="button" class="btn btn-outline-warning ms-2" id="btn-trigger-ar">🖐 Run now</button>
      <span class="ms-2 text-muted small" id="ar-status"></span>
    </div>

    <div class="text-muted small mt-3">
      <strong>สถานะ:</strong> ${enabled ? '🟢 enabled' : '⚪ disabled'} · poleCount=${cfg.poleCount ?? 3} · usdtPerPole=${cfg.usdtPerPole ?? 10} · lossThreshold=${cfg.lossThresholdPct ?? 2}% · checkHours=${cfg.checkHours ?? 4} · stepUsdt=${cfg.stepUsdt ?? 10} ${inFlight}
      <br /><strong>Last run:</strong> ${lastRunAt} · tickCount=${tickCount}
      ${lastStats ? `<br /><strong>Last stats:</strong> action=${escapeHtml(lastStats.action || '—')} · deltaUsdt=${lastStats.deltaUsdt ?? 0} · usablePole=${lastStats.usablePoleCount ?? '?'} · lossPole=${lastStats.lossPoleCount ?? 0} · available=${lastStats.availablePoleCount ?? '?'} · target=${lastStats.targetPoleCount ?? '?'} · positions=${lastStats.positionCount ?? 0}` : ''}
      ${status.lastRunError ? `<br /><strong>Last error:</strong> <span class="text-danger">${escapeHtml(status.lastRunError)}</span>` : ''}
    </div>
  `);
}

// ─── 🛒 Section: CB Version ──────────────────────────────────────
function renderCbVersionSection() {
  return section('sec-cb-ver', '⚡', 'CB Version (v2 vs v3)', false, `
    <div class="row g-3">
      <div class="col-md-6">
        <label class="form-label">⚡ Active Circuit Breaker version</label>
        <select class="form-select" id="cb-version">
          <option value="v2" ${cfg.cbVersion === 'v2' ? 'selected' : ''}>v2 — CBv2 only (4 red below lowerKC → cooldown)</option>
          <option value="v3" ${cfg.cbVersion !== 'v2' ? 'selected' : ''}>v3 — CBv2 + ST3 upper-TF (default, stricter)</option>
        </select>
        <small class="text-muted">v3 = CBv2 + ST3 no-trade pattern (Bearish Engulfing / Shooting Star) บน upper-TF (3m/5m→1h, 15m→4h, 1h→1d)</small>
      </div>
    </div>

    <div class="mt-3">
      <button type="button" class="btn btn-primary" id="btn-save-cbversion">💾 บันทึก CB Version</button>
      <span class="ms-2 text-muted small" id="cbversion-status"></span>
    </div>

    <div class="text-muted small mt-3">
      <strong>คำอธิบาย:</strong>
      <ul class="mt-1">
        <li><strong>v2</strong>: panic-close + cooldown เมื่อ 4 แท่งติด red below lowerKC</li>
        <li><strong>v3</strong> (default): v2 + ST3 no-trade pattern match บน upper-TF same candle — ลด false positive จาก candle-wide dump</li>
        <li>CBv3 จะไม่ fire ถ้า CBv2 pattern match แต่ ST3 ไม่ match (v3 strict gate)</li>
        <li>ทั้ง v2/v3 mutually exclusive — เปลี่ยน version มีผลทันที (cache 30s)</li>
      </ul>
    </div>
  `);
}

// ─── 🛒 Section: DPS (Dynamic Position Sizing) ───────────────────
function renderDpsSection() {
  const dcfg = (adminCfg && adminCfg.config) || {};
  const dps = {
    dpsMinSize:   Number.isFinite(Number(dcfg.dpsMinSize))   ? Number(dcfg.dpsMinSize)   : 6,
    dpsMaxSize:   Number.isFinite(Number(dcfg.dpsMaxSize))   ? Number(dcfg.dpsMaxSize)   : 15,
    dpsMinLayers: Number.isFinite(Number(dcfg.dpsMinLayers)) ? Number(dcfg.dpsMinLayers) : 1,
    dpsMaxLayers: Number.isFinite(Number(dcfg.dpsMaxLayers)) ? Number(dcfg.dpsMaxLayers) : 5,
    dpsCooldownMinutes: Number.isFinite(Number(dcfg.dpsCooldownMinutes)) ? Number(dcfg.dpsCooldownMinutes) : 5,
    dpsWinStreakCount:    Number.isFinite(Number(dcfg.dpsWinStreakCount))    ? Number(dcfg.dpsWinStreakCount)    : 3,
    dpsWinStreakDeltaSize:    Number.isFinite(Number(dcfg.dpsWinStreakDeltaSize))    ? Number(dcfg.dpsWinStreakDeltaSize)    : 1,
    dpsWinStreakDeltaLayers:  Number.isFinite(Number(dcfg.dpsWinStreakDeltaLayers))  ? Number(dcfg.dpsWinStreakDeltaLayers)  : 1,
    dpsBigWinCount:    Number.isFinite(Number(dcfg.dpsBigWinCount))    ? Number(dcfg.dpsBigWinCount)    : 2,
    dpsBigWinPct:      Number.isFinite(Number(dcfg.dpsBigWinPct))      ? Number(dcfg.dpsBigWinPct)      : 2.0,
    dpsBigWinDeltaSize:    Number.isFinite(Number(dcfg.dpsBigWinDeltaSize))    ? Number(dcfg.dpsBigWinDeltaSize)    : 2,
    dpsBigWinDeltaLayers:  Number.isFinite(Number(dcfg.dpsBigWinDeltaLayers))  ? Number(dcfg.dpsBigWinDeltaLayers)  : 0,
    dpsLossStreakCount: Number.isFinite(Number(dcfg.dpsLossStreakCount)) ? Number(dcfg.dpsLossStreakCount) : 1,
    dpsLossDeltaSize:   Number.isFinite(Number(dcfg.dpsLossDeltaSize))   ? Number(dcfg.dpsLossDeltaSize)   : -2,
    dpsLossDeltaLayers: Number.isFinite(Number(dcfg.dpsLossDeltaLayers)) ? Number(dcfg.dpsLossDeltaLayers) : -2,
    dpsRespectBotCapital:  dcfg.dpsRespectBotCapital  !== false,
    dpsResetHistoryOnFire: dcfg.dpsResetHistoryOnFire !== false,
    dpsDryRun:             dcfg.dpsDryRun === true,
  };
  return section('sec-dps', '📊', 'Dynamic Position Sizing (DPS) — auto-tune size + layers', false, `
    <div class="row g-3">
      <div class="col-md-3">
        <label class="form-label">📐 Min size (USDT)</label>
        <input type="number" class="form-control dps-input" id="dps-min-size" value="${dps.dpsMinSize}" step="0.01" min="5" max="10000" data-dps="dpsMinSize" />
      </div>
      <div class="col-md-3">
        <label class="form-label">📐 Max size (USDT)</label>
        <input type="number" class="form-control dps-input" id="dps-max-size" value="${dps.dpsMaxSize}" step="0.01" min="5" max="10000" data-dps="dpsMaxSize" />
      </div>
      <div class="col-md-3">
        <label class="form-label">🪜 Min layers</label>
        <input type="number" class="form-control dps-input" id="dps-min-layers" value="${dps.dpsMinLayers}" step="1" min="1" max="50" data-dps="dpsMinLayers" />
      </div>
      <div class="col-md-3">
        <label class="form-label">🪜 Max layers</label>
        <input type="number" class="form-control dps-input" id="dps-max-layers" value="${dps.dpsMaxLayers}" step="1" min="1" max="50" data-dps="dpsMaxLayers" />
      </div>
      <div class="col-md-3">
        <label class="form-label">⏱ Cooldown (นาที)</label>
        <input type="number" class="form-control dps-input" id="dps-cooldown" value="${dps.dpsCooldownMinutes}" step="1" min="0" max="1440" data-dps="dpsCooldownMinutes" />
      </div>
    </div>

    <hr />

    <div class="row g-3">
      <div class="col-md-12">
        <strong class="text-muted-3">กฎ 1 · ชนะติดกัน N ไม้</strong>
      </div>
      <div class="col-md-4">
        <label class="form-label">จำนวนไม้ชนะติด</label>
        <input type="number" class="form-control dps-input" id="dps-r1-count" value="${dps.dpsWinStreakCount}" step="1" min="1" max="20" data-dps="dpsWinStreakCount" />
      </div>
      <div class="col-md-4">
        <label class="form-label">Δ size</label>
        <input type="number" class="form-control dps-input" id="dps-r1-dsize" value="${dps.dpsWinStreakDeltaSize}" step="0.1" min="-1000" max="1000" data-dps="dpsWinStreakDeltaSize" />
      </div>
      <div class="col-md-4">
        <label class="form-label">Δ layers</label>
        <input type="number" class="form-control dps-input" id="dps-r1-dlayers" value="${dps.dpsWinStreakDeltaLayers}" step="1" min="-50" max="50" data-dps="dpsWinStreakDeltaLayers" />
      </div>
    </div>

    <div class="row g-3 mt-1">
      <div class="col-md-12">
        <strong class="text-muted-3">กฎ 2 · N ไม้ล่าสุดกำไร ≥ X% ทุกไม้</strong>
      </div>
      <div class="col-md-3">
        <label class="form-label">จำนวนไม้ย้อนหลัง</label>
        <input type="number" class="form-control dps-input" id="dps-r2-count" value="${dps.dpsBigWinCount}" step="1" min="1" max="20" data-dps="dpsBigWinCount" />
      </div>
      <div class="col-md-3">
        <label class="form-label">% กำไรขั้นต่ำต่อไม้</label>
        <input type="number" class="form-control dps-input" id="dps-r2-pct" value="${dps.dpsBigWinPct}" step="0.1" min="0.1" max="100" data-dps="dpsBigWinPct" />
      </div>
      <div class="col-md-3">
        <label class="form-label">Δ size</label>
        <input type="number" class="form-control dps-input" id="dps-r2-dsize" value="${dps.dpsBigWinDeltaSize}" step="0.1" min="-1000" max="1000" data-dps="dpsBigWinDeltaSize" />
      </div>
      <div class="col-md-3">
        <label class="form-label">Δ layers</label>
        <input type="number" class="form-control dps-input" id="dps-r2-dlayers" value="${dps.dpsBigWinDeltaLayers}" step="1" min="-50" max="50" data-dps="dpsBigWinDeltaLayers" />
      </div>
    </div>

    <div class="row g-3 mt-1">
      <div class="col-md-12">
        <strong class="text-muted-3">กฎ 3 · แพ้ติดกัน N ไม้</strong>
      </div>
      <div class="col-md-4">
        <label class="form-label">จำนวนไม้แพ้ติด</label>
        <input type="number" class="form-control dps-input" id="dps-r3-count" value="${dps.dpsLossStreakCount}" step="1" min="1" max="20" data-dps="dpsLossStreakCount" />
      </div>
      <div class="col-md-4">
        <label class="form-label">Δ size</label>
        <input type="number" class="form-control dps-input" id="dps-r3-dsize" value="${dps.dpsLossDeltaSize}" step="0.1" min="-1000" max="1000" data-dps="dpsLossDeltaSize" />
      </div>
      <div class="col-md-4">
        <label class="form-label">Δ layers</label>
        <input type="number" class="form-control dps-input" id="dps-r3-dlayers" value="${dps.dpsLossDeltaLayers}" step="1" min="-50" max="50" data-dps="dpsLossDeltaLayers" />
      </div>
    </div>

    <hr />

    <div class="row g-3">
      <div class="col-md-12"><strong class="text-muted-3">ความปลอดภัย</strong></div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="dps-respect" ${dps.dpsRespectBotCapital ? 'checked' : ''} />
          <span class="form-check-label">🔒 Respect bot capital (anchored clamp)</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="dps-reset" ${dps.dpsResetHistoryOnFire ? 'checked' : ''} />
          <span class="form-check-label">♻️ Reset history on fire</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="dps-dryrun" ${dps.dpsDryRun ? 'checked' : ''} />
          <span class="form-check-label">🧪 Dry-run mode</span>
        </label>
      </div>
    </div>

    <div class="mt-3">
      <button type="button" class="btn btn-primary" id="btn-save-dps">💾 บันทึก DPS</button>
      <button type="button" class="btn btn-outline-warning ms-2" id="btn-dps-reset-all">🗑 Reset state ทุกบอท</button>
      <span class="ms-2 text-muted small" id="dps-status"></span>
    </div>

    <div class="text-muted small mt-2">
      <strong>Engine:</strong> อ่านค่าจาก AppConfig ทุก 30s · <strong>Kill switch:</strong> Master Config → DPS Master OFF ปิดได้ทันทีทั้งระบบ
    </div>
  `);
}

// ─── 🛒 Section: Daily Target ────────────────────────────────────
function renderDailyTargetSection() {
  return section('sec-daily-target', '🎯', 'Daily Profit Target (เกจใต้ navbar · หน่วย THB)', false, `
    <div class="row g-3">
      <div class="col-md-6">
        <label class="form-label">🎯 เป้าหมาย THB ต่อวัน <span class="text-muted">(default 100)</span></label>
        <input type="number" class="form-control" id="dt-target" value="${Math.round(Number((dailyTarget && dailyTarget.targetThb) || 100))}" step="10" min="1" max="1000000" />
        <small class="text-muted">เกจใต้ navbar จะ fill 100% เมื่อ todayPnL ≥ เป้านี้ (THB)</small>
      </div>
      <div class="col-md-6 d-flex align-items-end">
        <div class="text-muted-3 small w-100">
          <div><strong>Today PnL:</strong> <span id="dt-preview-pnl">—</span></div>
          <div><strong>Pct ของเป้า:</strong> <span id="dt-preview-pct">—</span></div>
          <div><strong>Zone:</strong> <span id="dt-preview-zone">—</span></div>
        </div>
      </div>
    </div>

    <div class="mt-3">
      <button type="button" class="btn btn-primary" id="btn-save-dt">💾 บันทึกเป้าหมาย</button>
      <span class="ms-2 text-muted small" id="dt-status"></span>
    </div>
  `);
}

// ─── 🛡️ Section: Auto-Buy BNB ────────────────────────────────────
function renderBnbSection() {
  return section('sec-bnb', '💎', 'Auto-Buy BNB (MARKET BUY BNB/USDT อัตโนมัติ)', false, `
    <div class="mb-3">
      <label class="form-check form-switch">
        <input type="checkbox" class="form-check-input" id="bnb-enabled" ${bnbCfg.enabled ? 'checked' : ''} />
        <span class="form-check-label"><strong>เปิด Auto-Buy BNB</strong> — <span class="text-danger">⚠️ Live trading</span> — ระบบจะ MARKET BUY BNB ด้วยเงินจริงเมื่อ BNB value ต่ำกว่า threshold</span>
      </label>
    </div>

    <div class="row g-3">
      <div class="col-md-4">
        <label class="form-label">💰 TopUp per buy (USDT)</label>
        <input type="number" class="form-control" id="bnb-topUp" value="${bnbCfg.topUpUsdt}" step="0.5" min="5" max="100" />
      </div>
      <div class="col-md-4">
        <label class="form-label">⚠️ Trigger threshold (USDT)</label>
        <input type="number" class="form-control" id="bnb-threshold" value="${bnbCfg.thresholdUsdt}" step="0.05" min="0.1" max="100" />
      </div>
      <div class="col-md-4">
        <label class="form-label">⏱ Check interval (นาที)</label>
        <input type="number" class="form-control" id="bnb-interval" value="${bnbCfg.checkIntervalMin}" step="5" min="5" max="1440" />
      </div>
      <div class="col-md-4">
        <label class="form-label">🛑 Cooldown (นาที)</label>
        <input type="number" class="form-control" id="bnb-cooldown" value="${bnbCfg.cooldownMin}" step="5" min="0" max="1440" />
      </div>
      <div class="col-md-4">
        <label class="form-label">📊 Daily cap (USDT)</label>
        <input type="number" class="form-control" id="bnb-dailycap" value="${bnbCfg.maxUsdtPerDay}" step="5" min="0" max="10000" />
      </div>
      <div class="col-md-4">
        <label class="form-label">💎 Gauge target (USDT)</label>
        <input type="number" class="form-control" id="bnb-gauge-target" value="${bnbCfg.gaugeTargetUsdt ?? 10}" step="1" min="1" max="100" />
      </div>
    </div>

    <div class="mt-3">
      <button type="button" class="btn btn-primary" id="btn-save-bnb">💾 บันทึก Auto-Buy BNB</button>
      <button type="button" class="btn btn-outline-warning ms-2" id="btn-trigger-bnb">🖐 Trigger BUY now</button>
      <span class="ms-2 text-muted small" id="bnb-status"></span>
    </div>

    <div class="text-muted small mt-3">
      <strong>สถานะ:</strong> tickCount=${bnbCfg.status && bnbCfg.status.tickCount != null ? bnbCfg.status.tickCount : 0} · lastTick=${bnbCfg.status && bnbCfg.status.lastTickAt ? new Date(bnbCfg.status.lastTickAt).toLocaleString() : '—'} · dailySpend=${bnbCfg.status && bnbCfg.status.dailySpendUsdt != null ? bnbCfg.status.dailySpendUsdt.toFixed(2) : '0.00'} USDT
      <br /><strong>Safety:</strong> ${bnbCfg.cooldownMin}-min cooldown · ${bnbCfg.maxUsdtPerDay} USDT daily cap · dailySpend reset at midnight UTC
      <br /><strong>Audit log:</strong> <a href="/api/bnb-auto-buy/logs" target="_blank">GET /api/bnb-auto-buy/logs</a>
    </div>
  `);
}

// ════════ Event handlers ════════
function bindEvents() {
  // Telegram
  const setToken = document.getElementById('btn-set-token');
  if (setToken) setToken.onclick = setTelegramToken;
  const clearToken = document.getElementById('btn-clear-token');
  if (clearToken) clearToken.onclick = clearTelegramToken;
  const saveChat = document.getElementById('btn-save-chat');
  if (saveChat) saveChat.onclick = saveChatId;
  const testBtn = document.getElementById('btn-test');
  if (testBtn) testBtn.onclick = sendTest;
  const tgEnabled = document.getElementById('f-enabled');
  if (tgEnabled) tgEnabled.onchange = toggleEnabled;
  const saveEventsBtn = document.getElementById('btn-save-events');
  if (saveEventsBtn) saveEventsBtn.onclick = saveEvents;
  const saveThBtn = document.getElementById('btn-save-thresholds');
  if (saveThBtn) saveThBtn.onclick = saveThresholds;

  // BNB
  const sb = document.getElementById('btn-save-bnb');
  if (sb) sb.onclick = saveAutoBuyBnb;
  const tb = document.getElementById('btn-trigger-bnb');
  if (tb) tb.onclick = triggerAutoBuyBnb;

  // Daily Target
  const sdt = document.getElementById('btn-save-dt');
  if (sdt) sdt.onclick = saveDailyTarget;
  const dtInput = document.getElementById('dt-target');
  if (dtInput) dtInput.addEventListener('input', updateDailyTargetPreview);
  updateDailyTargetPreview();

  // Auto Add Bot
  const saab = document.getElementById('btn-save-aab');
  if (saab) saab.onclick = saveAutoAddBot;
  const taab = document.getElementById('btn-trigger-aab');
  if (taab) taab.onclick = triggerAutoAddBot;
  const aabTg = document.getElementById('aab-tg');
  const aabTgLabel = document.getElementById('aab-tg-label');
  if (aabTg && aabTgLabel) {
    aabTg.addEventListener('change', () => {
      aabTgLabel.textContent = aabTg.checked ? 'เปิด' : 'ปิด';
    });
  }

  // CB Version
  const scbv = document.getElementById('btn-save-cbversion');
  if (scbv) scbv.onclick = saveCbVersion;

  // FIX-2026-08-24: Auto Reserve / Release USDT
  const sar = document.getElementById('btn-save-ar');
  if (sar) sar.onclick = saveAutoReserveConfig;
  const tar = document.getElementById('btn-trigger-ar');
  if (tar) tar.onclick = triggerAutoReserve;

  // Auto Delete
  const sadb = document.getElementById('btn-save-adb');
  if (sadb) sadb.onclick = saveAutoDeleteBot;

  // DPS
  const sdps = document.getElementById('btn-save-dps');
  if (sdps) sdps.onclick = saveDpsConfig;
  const rdps = document.getElementById('btn-dps-reset-all');
  if (rdps) rdps.onclick = resetDpsStateAll;

  // FIX-2026-08-21: Rate Limit
  const srl = document.getElementById('btn-save-rl');
  if (srl) srl.onclick = saveRateLimit;
  const rrl = document.getElementById('btn-reload-rl');
  if (rrl) rrl.onclick = () => loadConfig();
  const rlReset = document.getElementById('rl-reset-default');
  if (rlReset) rlReset.onclick = () => {
    const input = document.getElementById('rl-capacity');
    if (input) input.value = defCapacity();
  };
  // preset buttons — fill input + save in one click
  document.querySelectorAll('.rl-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById('rl-capacity');
      if (input) input.value = btn.getAttribute('data-cap');
      saveRateLimit();
    });
  });

  // Bot Defaults (FIX-2026-08-08 rev3)
  const sbd = document.getElementById('btn-save-bd');
  if (sbd) sbd.onclick = saveBotDefaults;
  const rbd = document.getElementById('btn-reset-bd');
  if (rbd) rbd.onclick = resetBotDefaults;
  // FIX-2026-08-14: Import/Export buttons for Bot Defaults
  const expBd = document.getElementById('btn-export-bd');
  if (expBd) expBd.onclick = exportBotDefaultsToFile;
  const impBdR = document.getElementById('btn-import-bd-replace');
  if (impBdR) impBdR.onclick = () => importBotDefaultsFromFile('replace');
  const impBdM = document.getElementById('btn-import-bd-merge');
  if (impBdM) impBdM.onclick = () => importBotDefaultsFromFile('merge');
}

// ════════ Telegram ════════
async function setTelegramToken() {
  const token = (document.getElementById('f-token').value || '').trim();
  if (!token) { setStatus('test-status', 'กรุณาใส่ token', true); return; }
  try {
    await API.put('/api/telegram/token', { token });
    document.getElementById('f-token').value = '';
    setStatus('test-status', '✅ token บันทึกแล้ว');
    await loadConfig();
  } catch (err) { setStatus('test-status', '❌ ' + err.message, true); }
}

async function clearTelegramToken() {
  if (!confirm('ลบ Telegram token และ disable การแจ้งเตือน?')) return;
  try {
    await API.del('/api/telegram/token');
    setStatus('test-status', '✅ ลบ token แล้ว');
    await loadConfig();
  } catch (err) { setStatus('test-status', '❌ ' + err.message, true); }
}

async function saveChatId() {
  const chatId = (document.getElementById('f-chat-id').value || '').trim();
  try {
    await API.put('/api/telegram/config', { chatId });
    setStatus('test-status', '✅ บันทึก Chat ID แล้ว');
    await loadConfig();
  } catch (err) { setStatus('test-status', '❌ ' + err.message, true); }
}

async function sendTest() {
  const chatId = (document.getElementById('f-chat-id').value || '').trim();
  try {
    await API.post('/api/telegram/test', chatId ? { chatId } : {});
    setStatus('test-status', '✅ ส่งข้อความทดสอบสำเร็จ');
    await loadConfig();
  } catch (err) { setStatus('test-status', '❌ ' + (err.body && err.body.detail ? err.body.detail : err.message), true); }
}

async function toggleEnabled() {
  const enabled = document.getElementById('f-enabled').checked;
  try {
    await API.put('/api/telegram/config', { enabled });
    setStatus('test-status', enabled ? '✅ เปิดใช้งานแล้ว' : '⏸ ปิดใช้งานแล้ว');
    await loadConfig();
  } catch (err) {
    setStatus('test-status', '❌ ' + err.message, true);
    await loadConfig();
  }
}

async function saveEvents() {
  const events = {
    buyFilled:           document.getElementById('ev-buyFilled').checked,
    sellFilled:          document.getElementById('ev-sellFilled').checked,
    insufficientBalance: document.getElementById('ev-insufficientBalance').checked,
    botEnabled:          document.getElementById('ev-botEnabled').checked,
    botDisabled:         document.getElementById('ev-botDisabled').checked,
    botDeleted:          document.getElementById('ev-botDeleted').checked,
    positionLoss:        document.getElementById('ev-positionLoss').checked,
    positionProfit:      document.getElementById('ev-positionProfit').checked,
    positionStuck:       document.getElementById('ev-positionStuck').checked,
    dailySummary:        document.getElementById('ev-dailySummary').checked,
    weeklySummary:       document.getElementById('ev-weeklySummary').checked,
    monthlySummary:      document.getElementById('ev-monthlySummary').checked,
    tpLowPnL:            document.getElementById('ev-tpLowPnL').checked,
    cbPanicClose:       document.getElementById('ev-cbPanicClose').checked,
    cbv2PanicClose:     document.getElementById('ev-cbv2PanicClose').checked,
    botLocked:          document.getElementById('ev-botLocked').checked,
    dpsResize:         document.getElementById('ev-dpsResize').checked,
    cbv3PanicClose:     document.getElementById('ev-cbv3PanicClose').checked,
    botAutoUnlocked:    document.getElementById('ev-botAutoUnlocked').checked,
    autoDeleteBotWarning:  document.getElementById('ev-autoDeleteBotWarning').checked,
    autoDeleteBotRemoved:  document.getElementById('ev-autoDeleteBotRemoved').checked,
    bnbLowBalance:      document.getElementById('ev-bnbLowBalance').checked,
    // 2026-08-09: Telegram Login (alternative login channel)
    telegramLogin:      document.getElementById('ev-telegramLogin').checked,
  };
  try {
    await API.put('/api/telegram/config', { events });
    setStatus('events-status', '✅ บันทึกแล้ว');
    await loadConfig();
  } catch (err) { setStatus('events-status', '❌ ' + err.message, true); }
}

async function saveThresholds() {
  const thresholds = {
    positionLossPct:   parseFloat(document.getElementById('th-loss').value),
    positionProfitPct: parseFloat(document.getElementById('th-profit').value),
    positionStuckMin:  parseInt(document.getElementById('th-stuck').value, 10),
    bnbLowBalanceUsdt: parseFloat(document.getElementById('th-bnbLow').value),
  };
  if (!Number.isFinite(thresholds.positionLossPct) || !Number.isFinite(thresholds.positionProfitPct) || !Number.isFinite(thresholds.positionStuckMin)) {
    setStatus('thresholds-status', '❌ ค่าต้องเป็นตัวเลข', true);
    return;
  }
  if (!Number.isFinite(thresholds.bnbLowBalanceUsdt) || thresholds.bnbLowBalanceUsdt < 0.05) {
    setStatus('thresholds-status', '❌ BNB low threshold ต้อง ≥ 0.05 USDT', true);
    return;
  }
  try {
    await API.put('/api/telegram/config', { thresholds });
    setStatus('thresholds-status', '✅ บันทึกแล้ว');
    await loadConfig();
  } catch (err) { setStatus('thresholds-status', '❌ ' + err.message, true); }
}

// ════════ BNB Auto-Buy ════════
async function saveAutoBuyBnb() {
  const enabled        = !!document.getElementById('bnb-enabled').checked;
  const topUpUsdt      = parseFloat(document.getElementById('bnb-topUp').value);
  const thresholdUsdt  = parseFloat(document.getElementById('bnb-threshold').value);
  const checkIntervalMin = parseInt(document.getElementById('bnb-interval').value, 10);
  const cooldownMin    = parseInt(document.getElementById('bnb-cooldown').value, 10);
  const maxUsdtPerDay  = parseFloat(document.getElementById('bnb-dailycap').value);
  const gaugeTargetUsdt = parseFloat(document.getElementById('bnb-gauge-target').value);

  if (!Number.isFinite(topUpUsdt) || topUpUsdt < 5 || topUpUsdt > 100) { setStatus('bnb-status', '❌ TopUp ต้องอยู่ระหว่าง 5–100 USDT', true); return; }
  if (!Number.isFinite(thresholdUsdt) || thresholdUsdt < 0.1 || thresholdUsdt > 100) { setStatus('bnb-status', '❌ Threshold ต้องอยู่ระหว่าง 0.1–100 USDT', true); return; }
  if (!Number.isFinite(checkIntervalMin) || checkIntervalMin < 5 || checkIntervalMin > 1440) { setStatus('bnb-status', '❌ Check interval ต้องอยู่ระหว่าง 5–1440 นาที', true); return; }
  if (!Number.isFinite(cooldownMin) || cooldownMin < 0 || cooldownMin > 1440) { setStatus('bnb-status', '⏸ Cooldown ต้องอยู่ระหว่าง 0–1440 นาที', true); return; }
  if (!Number.isFinite(maxUsdtPerDay) || maxUsdtPerDay < 0 || maxUsdtPerDay > 10000) { setStatus('bnb-status', '❌ Daily cap ต้องอยู่ระหว่าง 0–10000 USDT', true); return; }
  if (!Number.isFinite(gaugeTargetUsdt) || gaugeTargetUsdt < 1 || gaugeTargetUsdt > 100) { setStatus('bnb-status', '❌ Gauge target ต้องอยู่ระหว่าง 1–100 USDT', true); return; }

  if (enabled && !(bnbCfg && bnbCfg.enabled)) {
    const ok = confirm(
      '⚠️ จะเปิด Auto-Buy BNB ใช่หรือไม่?\n\n' +
      'ระบบจะ MARKET BUY BNB/USDT ด้วยเงินจริงอัตโนมัติ ' +
      'เมื่อ BNB value < threshold (' + thresholdUsdt + ' USDT)\n\n' +
      'TopUp: ' + topUpUsdt + ' USDT · Interval: ' + checkIntervalMin + ' นาที\n' +
      'Daily cap: ' + maxUsdtPerDay + ' USDT\n\n' +
      'แน่ใจหรือไม่?'
    );
    if (!ok) {
      document.getElementById('bnb-enabled').checked = false;
      return;
    }
  }

  try {
    const resp = await API.put('/api/bnb-auto-buy/config', {
      enabled, topUpUsdt, thresholdUsdt, checkIntervalMin, cooldownMin, maxUsdtPerDay, gaugeTargetUsdt,
    });
    setStatus('bnb-status', '✅ บันทึกแล้ว' + (resp.enabled ? ' · Auto-Buy BNB 🟢 ON' : ' · Auto-Buy BNB ⚪ OFF'));
    await loadConfig();
  } catch (err) { setStatus('bnb-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true); }
}

async function triggerAutoBuyBnb() {
  if (!confirm('⚠️ จะสั่งซื้อ BNB/USDT MARKET BUY ทันที?\n\nสำหรับ top-up BNB แบบ manual (bypass enabled flag)\n\nค่าเงินจริง — แน่ใจหรือไม่?')) return;
  setStatus('bnb-status', '⏳ กำลังส่งคำสั่ง...');
  try {
    const result = await API.post('/api/bnb-auto-buy/trigger', {});
    const ok = result && result.result && result.result.outcome;
    setStatus('bnb-status', '✅ ' + (ok ? 'ส่งคำสั่งสำเร็จ (outcome: ' + ok + ')' : 'เสร็จแล้ว'));
    await loadConfig();
  } catch (err) {
    if (err.status === 409) { setStatus('bnb-status', '⏳ มีคำสั่งกำลังทำงานอยู่ — ลองใหม่ภายหลัง'); }
    else { setStatus('bnb-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true); }
  }
}

// ════════ Daily Target ════════
function updateDailyTargetPreview() {
  const v = parseFloat((document.getElementById('dt-target') || {}).value);
  const pnlThb = Number(dailyTarget && dailyTarget.todayPnlThb) || 0;
  const pnlUsdt = Number(dailyTarget && dailyTarget.todayPnlUsdt) || 0;
  const target = Number.isFinite(v) && v > 0 ? v : 100;
  const pct = target > 0 ? Math.max(-100, Math.min(200, (pnlThb / target) * 100)) : 0;
  const zone = pct >= 100 ? '🏆 achieved' : pct >= 70 ? '🚀 hot' : pct >= 30 ? '🔥 warming' : pct >= 0 ? '🥶 cold' : '💔 loss';
  const elPnl = document.getElementById('dt-preview-pnl');
  const elPct = document.getElementById('dt-preview-pct');
  const elZone = document.getElementById('dt-preview-zone');
  if (elPnl) elPnl.textContent = `฿${pnlThb.toFixed(2)} (${pnlUsdt.toFixed(4)} USDT)`;
  if (elPct) elPct.textContent = `${pct.toFixed(1)}%`;
  if (elZone) elZone.textContent = `${zone} (${pct >= 100 ? '🎉 ทะลุเป้า!' : pct < 0 ? 'ขาดทุน' : 'กำลังไป'})`;
}

async function saveDailyTarget() {
  const v = parseFloat((document.getElementById('dt-target') || {}).value);
  if (!Number.isFinite(v) || v < 1 || v > 1000000) {
    setStatus('dt-status', '❌ ค่าต้องอยู่ระหว่าง 1 ถึง 1,000,000 THB', true);
    return;
  }
  try {
    await API.put('/api/daily-target', { targetThb: v });
    setStatus('dt-status', '✅ บันทึกแล้ว · gauge bar กำลัง refresh');
    await loadConfig();
    if (window.__dtb && typeof window.__dtb.refresh === 'function') { window.__dtb.refresh(); }
  } catch (err) { setStatus('dt-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true); }
}

// ════════ Auto Add Bot ════════
async function saveAutoAddBot() {
  const enabled = !!document.getElementById('aab-enabled').checked;
  const intervalMin = parseInt(document.getElementById('aab-interval').value, 10);
  const minKcPct = parseFloat(document.getElementById('aab-min-kc').value);
  const maxPerRun = parseInt(document.getElementById('aab-max-per-run').value, 10);
  const telegramNotify = !!document.getElementById('aab-tg').checked;
  const autoEnable = !!document.getElementById('aab-auto-enable').checked;
  const autoRestore = !!document.getElementById('aab-auto-restore').checked;
  const namePrefixRaw = (document.getElementById('aab-name-prefix').value || '').trim();
  const namePrefix = namePrefixRaw.slice(0, 32) || '(bAdd)';
  const scanTimeframe = document.getElementById('aab-tf').value;
  const scanThreshold = parseFloat(document.getElementById('aab-thr').value);
  const scanWindow = parseInt(document.getElementById('aab-win').value, 10);
  const scanTpWindow = parseInt(document.getElementById('aab-tpwin').value, 10);
  const scanTopN = parseInt(document.getElementById('aab-topn').value, 10);
  const scanMinVol = parseFloat(document.getElementById('aab-minvol').value);
  const scanMinPctRaw = parseFloat(document.getElementById('aab-minpct').value);
  const scanMinPct = Number.isFinite(scanMinPctRaw) ? Math.max(0, Math.min(1, scanMinPctRaw / 100)) : 0.30;
  const trends = [];
  if (document.getElementById('aab-trend-up').checked) trends.push('uptrend');
  if (document.getElementById('aab-trend-down').checked) trends.push('downtrend');
  if (document.getElementById('aab-trend-side').checked) trends.push('sideways');

  if (!Number.isFinite(intervalMin) || intervalMin < 5 || intervalMin > 1440) { setStatus('aab-status', '❌ Interval ต้องอยู่ระหว่าง 5–1440 นาที', true); return; }
  if (!Number.isFinite(minKcPct) || minKcPct < 0 || minKcPct > 50) { setStatus('aab-status', '❌ Min %KC ต้องอยู่ระหว่าง 0–50', true); return; }
  if (!Number.isFinite(maxPerRun) || maxPerRun < 1 || maxPerRun > 50) { setStatus('aab-status', '❌ Max bots/run ต้องอยู่ระหว่าง 1–50', true); return; }
  if (trends.length === 0) { setStatus('aab-status', '❌ ต้องเลือก Trend อย่างน้อย 1 อัน', true); return; }
  if (!Number.isFinite(scanThreshold) || scanThreshold < 0.1 || scanThreshold > 100) { setStatus('aab-status', '❌ % Vol threshold ต้องอยู่ระหว่าง 0.1–100', true); return; }
  if (!Number.isFinite(scanWindow) || scanWindow < 5 || scanWindow > 20000) { setStatus('aab-status', '❌ Window ต้องอยู่ระหว่าง 5–20000', true); return; }
  if (!Number.isFinite(scanTpWindow) || scanTpWindow < 20 || scanTpWindow > 1000) { setStatus('aab-status', '❌ TP Window ต้องอยู่ระหว่าง 20–1000', true); return; }
  if (!Number.isFinite(scanTopN) || scanTopN < 20 || scanTopN > 300) { setStatus('aab-status', '❌ Top N ต้องอยู่ระหว่าง 20–300', true); return; }
  if (!Number.isFinite(scanMinVol) || scanMinVol < 0) { setStatus('aab-status', '❌ Min 24h Vol ต้อง ≥ 0', true); return; }

  if (enabled && autoAddBotCfg && !autoAddBotCfg.enabled) {
    const ok = confirm(
      '⚠️ จะเปิด Auto Add New Bot ใช่หรือไม่?\n\n' +
      'ระบบจะสแกน + สร้างบอทใหม่อัตโนมัติทุก ' + intervalMin + ' นาที\n' +
      'Max ' + maxPerRun + ' บอทต่อรอบ · Min %KC > ' + minKcPct + '\n' +
      'Name prefix: ' + namePrefix + ' (เช่น BTC' + namePrefix + ')\n\n' +
      (autoEnable ? '▶️ Auto-enable: ON — บอทที่สร้างจะเริ่มเทรดทันที' : '⏸ Auto-enable: OFF — บอทจะอยู่ในสถานะ DISABLED')
    );
    if (!ok) { document.getElementById('aab-enabled').checked = false; return; }
  }

  setStatus('aab-status', '⏳ กำลังบันทึก...');
  try {
    const resp = await API.put('/api/auto-add-bot/config', {
      enabled, intervalMin, minKcPct, maxPerRun, telegramNotify, autoEnable, autoRestore, namePrefix,
      scanTimeframe, scanThreshold, scanWindow, scanTpWindow, scanTopN, scanMinVol, scanMinPct, scanTrends: trends,
    });
    setStatus('aab-status', '✅ บันทึกแล้ว' + (resp.enabled ? ' · Auto Add Bot 🟢 ON' : ' · Auto Add Bot ⚪ OFF') + (resp.autoEnable ? ' · Auto-enable ▶️ ON' : ' · Auto-enable ⏸ OFF') + (resp.autoRestore !== false ? ' · Auto-restore ↩️ ON' : ' · Auto-restore OFF') + ' · prefix=' + (resp.namePrefix || '(bAdd)'));
    await loadConfig();
  } catch (err) { setStatus('aab-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true); }
}

async function triggerAutoAddBot() {
  if (!confirm('⚠️ จะ Run Auto Add Bot ทันที (bypass enabled flag)?\n\nระบบจะสแกน + filter + create บอทใหม่ทันที\nหรือ restore + activate บอท soft-deleted ที่ symbol ตรงเกณ�์ (ถ้า Auto-restore เปิดอยู่)\nบอทจะอยู่ในสถานะ DISABLED — ต้องเปิดเอง')) return;
  setStatus('aab-status', '⏳ กำลังสแกน...');
  try {
    const resp = await API.post('/api/auto-add-bot/run', {});
    const r = resp.result || {};
    const list = (r.createdList || []).map((b) => `${b.symbol} (score ${(b.score || 0).toFixed(2)}, kcMin ${(b.kcMinPct || 0).toFixed(3)}%)`).join(', ');
    const restoredList = (r.restoredList || []).map((b) => `${b.symbol} (${b.daysSinceDelete || 0}d)`).join(', ');
    if (r.created > 0 || r.restored > 0) {
      const parts = [];
      if (r.created > 0) parts.push(`สร้าง ${r.created} บอท${list ? ' · ' + list : ''}`);
      if (r.restored > 0) parts.push(`↩️ restore ${r.restored} บอท${restoredList ? ' · ' + restoredList : ''}`);
      setStatus('aab-status', `✅ จาก ${r.candidates} candidates · ${parts.join(' | ')}`);
    }
    else if (r.outcome === 'failed_scan') { setStatus('aab-status', '❌ scan failed: ' + (r.error || 'unknown'), true); }
    else if (r.skipped) { setStatus('aab-status', '⏸ ' + r.skipped); }
    else { setStatus('aab-status', `ℹ️ scanned ${r.scanned ?? '?'} · candidates ${r.candidates ?? 0} · created 0 · restored 0`); }
    await loadConfig();
  } catch (err) {
    if (err.status === 409) { setStatus('aab-status', '⏳ มีคำสั่งกำลังทำงานอยู่ — ลองใหม่ภายหลัง'); }
    else { setStatus('aab-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true); }
  }
}

// ════════ CB Version ════════
async function saveCbVersion() {
  const v = document.getElementById('cb-version').value;
  if (v !== 'v2' && v !== 'v3') { setStatus('cbversion-status', '❌ ต้องเลือก v2 หรือ v3', true); return; }
  try {
    await API.put('/api/telegram/config', { cbVersion: v });
    setStatus('cbversion-status', `✅ บันทึกแล้ว · CB version = ${v} (cache 30s จะ refresh)`);
    await loadConfig();
  } catch (err) { setStatus('cbversion-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true); }
}

// ════════ Auto Reserve / Release (FIX-2026-08-24) ════════
async function saveAutoReserveConfig() {
  const enabled = !!document.getElementById('ar-enabled').checked;
  const poleCount = parseInt(document.getElementById('ar-polecount').value, 10);
  const usdtPerPole = parseFloat(document.getElementById('ar-usdtperpole').value);
  const lossThresholdPct = parseFloat(document.getElementById('ar-losspct').value);
  const checkHours = parseInt(document.getElementById('ar-checkhours').value, 10);
  const stepUsdt = parseFloat(document.getElementById('ar-step').value);
  if (!Number.isFinite(poleCount) || poleCount < 1 || poleCount > 100) {
    setStatus('ar-status', '❌ Pole count ต้องอยู่ระหว่าง 1..100', true); return;
  }
  if (!Number.isFinite(usdtPerPole) || usdtPerPole < 1 || usdtPerPole > 1000) {
    setStatus('ar-status', '❌ USDT/ไม้ ต้องอยู่ระหว่าง 1..1000', true); return;
  }
  if (!Number.isFinite(lossThresholdPct) || lossThresholdPct < 0.1 || lossThresholdPct > 50) {
    setStatus('ar-status', '❌ Loss threshold ต้องอยู่ระหว่าง 0.1..50', true); return;
  }
  if (!Number.isFinite(checkHours) || checkHours < 1 || checkHours > 24) {
    setStatus('ar-status', '❌ Check hours ต้องอยู่ระหว่าง 1..24', true); return;
  }
  if (24 % checkHours !== 0) {
    setStatus('ar-status', '❌ Check hours ต้องหาร 24 ลงตัว (1, 2, 3, 4, 6, 8, 12, 24)', true); return;
  }
  if (!Number.isFinite(stepUsdt) || stepUsdt < 1 || stepUsdt > 1000) {
    setStatus('ar-status', '❌ Step USDT �้องอยู่ระหว่าง 1..1000', true); return;
  }

  if (enabled) {
    const ok = window.LUX_CONFIRM
      ? await window.LUX_CONFIRM({
          title: 'เปิด Auto Reserve',
          message:
            `🤖 Auto Reserve จะปรับ USDT Reserve อัตโนมัติทุก ๆ ${checkHours} ชั่วโมง\n\n` +
            `เป้า: ${poleCount} ไม้ × ${usdtPerPole} = ${poleCount * usdtPerPole} USDT\n` +
            `ทุกครั้งจะกั๊ก/ปล่อยครั้งละ ${stepUsdt} USDT\n` +
            `นับ position ที่ขาดทุน < ${lossThresholdPct}% เป็น 1 ไม้\n\n` +
            `⚠️ ถ้าเปิดแล้ว ระบบจะรันทันทีหลังบันทึก (first tick)\n\n` +
            `ต้องการเปิดหรือไม่?`,
          confirmLabel: 'เปิด Auto Reserve',
          cancelLabel: 'ยกเลิก',
          password: false,
        })
      : confirm(
          `🤖 Auto Reserve จะปรับ USDT Reserve อัตโนมัติทุก ๆ ${checkHours} ชั่วโมง\n\n` +
          `เป้า: ${poleCount} ไม้ × ${usdtPerPole} = ${poleCount * usdtPerPole} USDT\n` +
          `ทุกครั้งจะกั๊ก/ปล่อยครั้งละ ${stepUsdt} USDT\n\n` +
          `⚠️ ถ้าเปิดแล้ว ระบบจะรันทันทีหลังบันทึก\n\nต้องการเปิดหรือไม่?`
        );
    if (!ok) { document.getElementById('ar-enabled').checked = false; return; }
  }

  setStatus('ar-status', '⏳ กำลังบันทึก...');
  try {
    const r = await API.put('/api/wallet/auto-reserve/config', {
      enabled, poleCount, usdtPerPole, lossThresholdPct, checkHours, stepUsdt,
    });
    const c = (r && r.config) || {};
    setStatus('ar-status', `✅ บันทึกแล้ว · ${c.enabled ? '🟢 ON' : '⚪ OFF'} · poleCount=${c.poleCount} · usdtPerPole=${c.usdtPerPole} · lossThr=${c.lossThresholdPct}% · checkHours=${c.checkHours} · step=${c.stepUsdt}`);
    await loadConfig();
  } catch (err) { setStatus('ar-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true); }
}

async function triggerAutoReserve() {
  const proceed = window.LUX_CONFIRM
    ? await window.LUX_CONFIRM({
        title: 'Run Auto Reserve ทันที',
        message:
          '🤖 จะรัน Auto Reserve ทันที (bypass checkHours + enabled flag)\n\n' +
          'ระบบจะคำนวณ usable + loss poles แล้วปรับ reserve ทันที\n' +
          '(ใช้รหัส BOT_ACTION_PASSWORD)',
        confirmLabel: 'รันเลย',
        cancelLabel: 'ยกเลิก',
        password: true,
      })
    : confirm('⚠️ จะรัน Auto Reserve ทันที (bypass checkHours + enabled flag)?\n\nระบบจะคำนวณ usable + loss poles แล้วปรับ reserve ทันที');
  if (!proceed) return;
  setStatus('ar-status', '⏳ กำลังรัน...');
  try {
    const resp = await API.post('/api/wallet/auto-reserve/run', {});
    const s = (resp && resp.stats) || {};
    if (s.outcome === 'failed_apply') { setStatus('ar-status', '❌ apply failed: ' + (s.error || 'unknown'), true); }
    else if (s.skipped) { setStatus('ar-status', '⏸ ' + s.skipped); }
    else if (s.action === 'reserve') {
      setStatus('ar-status', `🔒 RESERVE +${s.deltaUsdt} USDT · reserve ${s.beforeReserve}→${s.afterReserve} · available ${s.availablePoleCount} (target ${s.targetPoleCount})`);
    }
    else if (s.action === 'release') {
      setStatus('ar-status', `🟡 RELEASE -${s.deltaUsdt} USDT · reserve ${s.beforeReserve}→${s.afterReserve} · available ${s.availablePoleCount} (target ${s.targetPoleCount})`);
    }
    else {
      setStatus('ar-status', `ℹ️ no action · available ${s.availablePoleCount ?? '?'} = target ${s.targetPoleCount ?? '?'} (reason: ${s.reason || 'in_target'})`);
    }
    await loadConfig();
  } catch (err) {
    if (err.status === 403) { setStatus('ar-status', '🔒 รหัส BOT_ACTION_PASSWORD ไม่ถูกต้อง'); }
    else { setStatus('ar-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true); }
  }
}

// ════════ Auto Delete ════════
async function saveAutoDeleteBot() {
  const enabled = !!document.getElementById('adb-enabled').checked;
  const days = parseInt(document.getElementById('adb-days').value, 10);
  const warningDays = parseInt(document.getElementById('adb-warndays').value, 10);
  if (!Number.isFinite(days) || days < 7 || days > 365) { setStatus('adb-status', '❌ Days ต้องอยู่ระหว่าง 7..365', true); return; }
  if (!Number.isFinite(warningDays) || warningDays < 1 || warningDays > 30) { setStatus('adb-status', '❌ Warning days ต้องอยู่ระหว่าง 1..30', true); return; }
  try {
    await API.put('/api/telegram/config', { autoDeleteBotEnabled: enabled, autoDeleteBotDays: days, autoDeleteBotWarningDays: warningDays });
    setStatus('adb-status', `✅ บันทึกแล้ว · Auto Delete ${enabled ? '🟢 ON' : '⚪ OFF'} · ${days} วัน / warning ${warningDays} วัน`);
    await loadConfig();
  } catch (err) { setStatus('adb-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true); }
}

// ════════ Rate Limit (FIX-2026-08-21) ════════
function defCapacity() {
  return (rateLimit && Number.isFinite(rateLimit.default)) ? rateLimit.default : 6000;
}
function rlMin() { return (rateLimit && Number.isFinite(rateLimit.min)) ? rateLimit.min : 500; }
function rlMax() { return (rateLimit && Number.isFinite(rateLimit.max)) ? rateLimit.max : 120000; }

async function saveRateLimit() {
  const raw = document.getElementById('rl-capacity').value;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    setStatus('rl-status', '❌ ค่าต้องเป็นจำนวนเต็มบวก', true);
    return;
  }
  if (n < rlMin()) {
    setStatus('rl-status', `❌ ขั้นต่ำ ${rlMin()}`, true);
    return;
  }
  if (n > rlMax()) {
    setStatus('rl-status', `❌ ขั้นสูง ${rlMax()}`, true);
    return;
  }
  try {
    setStatus('rl-status', '⏳ กำลังอัปเดต…');
    const resp = await API.put('/api/admin/rate-limit', { capacity: n, password: window._settingsPassword });
    rateLimit = resp;
    setStatus('rl-status', `✅ บันทึกแล้ว · capacity = ${resp.capacity} · tokens = ${Math.round((resp.limiter && resp.limiter.tokens) || 0)}`);
    // re-render เพื่อ update progress bar
    setTimeout(() => loadConfig(), 600);
  } catch (err) {
    setStatus('rl-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
  }
}

// ════════ DPS ════════
async function saveDpsConfig() {
  const el = (id) => document.getElementById(id);
  const num = (id) => parseFloat(el(id).value);
  const int = (id) => parseInt(el(id).value, 10);

  const minSize   = num('dps-min-size');
  const maxSize   = num('dps-max-size');
  const minLayers = int('dps-min-layers');
  const maxLayers = int('dps-max-layers');
  const cooldown  = int('dps-cooldown');

  if (!Number.isFinite(minSize) || minSize < 5 || minSize > 10000) { setStatus('dps-status', '❌ Min size ต้องอยู่ระหว่าง 5..10000', true); return; }
  if (!Number.isFinite(maxSize) || maxSize < 5 || maxSize > 10000) { setStatus('dps-status', '❌ Max size ต้องอยู่ระหว่าง 5..10000', true); return; }
  if (minSize > maxSize) { setStatus('dps-status', '❌ Min size ต้องไม่เกิน Max size', true); return; }
  if (!Number.isFinite(minLayers) || minLayers < 1 || minLayers > 50) { setStatus('dps-status', '❌ Min layers ต้องอยู่ระหว่าง 1..50', true); return; }
  if (!Number.isFinite(maxLayers) || maxLayers < 1 || maxLayers > 50) { setStatus('dps-status', '❌ Max layers ต้องอยู่ระหว่าง 1..50', true); return; }
  if (minLayers > maxLayers) { setStatus('dps-status', '❌ Min layers ต้องไม่เกิน Max layers', true); return; }
  if (!Number.isFinite(cooldown) || cooldown < 0 || cooldown > 1440) { setStatus('dps-status', '❌ Cooldown ต้องอยู่ระหว่าง 0..1440', true); return; }

  const r1Count    = int('dps-r1-count');
  const r1DSize    = num('dps-r1-dsize');
  const r1DLayers  = int('dps-r1-dlayers');
  const r2Count    = int('dps-r2-count');
  const r2Pct      = num('dps-r2-pct');
  const r2DSize    = num('dps-r2-dsize');
  const r2DLayers  = int('dps-r2-dlayers');
  const r3Count    = int('dps-r3-count');
  const r3DSize    = num('dps-r3-dsize');
  const r3DLayers  = int('dps-r3-dlayers');
  if (![r1Count, r2Count, r3Count].every((v) => Number.isFinite(v) && v >= 1 && v <= 20)) { setStatus('dps-status', '❌ จำนวนไม้ (count) ต้องอยู่ระหว่าง 1..20', true); return; }
  if (!Number.isFinite(r2Pct) || r2Pct < 0.1 || r2Pct > 100) { setStatus('dps-status', '❌ % กำไรขั้นต่ำต่อไม้ ต้องอยู่ระหว่าง 0.1..100', true); return; }
  for (const [name, v] of [['r1DSize', r1DSize], ['r1DLayers', r1DLayers], ['r2DSize', r2DSize], ['r2DLayers', r2DLayers], ['r3DSize', r3DSize], ['r3DLayers', r3DLayers]]) {
    if (!Number.isFinite(v)) { setStatus('dps-status', `❌ ${name} ต้องเป็นตัวเลข`, true); return; }
  }

  const payload = {
    dpsMinSize: minSize, dpsMaxSize: maxSize,
    dpsMinLayers: minLayers, dpsMaxLayers: maxLayers,
    dpsCooldownMinutes: cooldown,
    dpsWinStreakCount: r1Count, dpsWinStreakDeltaSize: r1DSize, dpsWinStreakDeltaLayers: r1DLayers,
    dpsBigWinCount: r2Count, dpsBigWinPct: r2Pct, dpsBigWinDeltaSize: r2DSize, dpsBigWinDeltaLayers: r2DLayers,
    dpsLossStreakCount: r3Count, dpsLossDeltaSize: r3DSize, dpsLossDeltaLayers: r3DLayers,
    dpsRespectBotCapital: !!el('dps-respect').checked,
    dpsResetHistoryOnFire: !!el('dps-reset').checked,
    dpsDryRun: !!el('dps-dryrun').checked,
  };
  setStatus('dps-status', '⏳ กำลังบันทึก…');
  try {
    const resp = await API.put('/api/admin/app-config', payload);
    const liveCfg = (resp && resp.config) ? resp.config : payload;
    const dryFlag = liveCfg.dpsDryRun ? ' · 🧪 DRY-RUN' : '';
    setStatus('dps-status', `✅ บันทึกแล้ว · cache refresh ทันที (30s)${dryFlag}`);
    await loadConfig();
  } catch (err) { setStatus('dps-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true); }
}

async function resetDpsStateAll() {
  if (!confirm('เคลียร์ DPS state ทุกบอท?')) return;
  setStatus('dps-status', '⏳ กำลัง reset…');
  try {
    const resp = await API.post('/api/admin/dps-reset-all', {});
    setStatus('dps-status', `✅ reset แล้ว · matched ${resp.matched} · modified ${resp.modified} · in-memory ${resp.syncedInMem}`);
  } catch (err) { setStatus('dps-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true); }
}

// ════════ Bot Defaults (NEW 2026-08-08 rev3) ════════
const BD_RECOMMENDED = {
  defaultSymbol: 'BNBUSDT',
  defaultTimeframe: '3m',
  capitalPerTrade: 9,
  maxTrades: 1,
  tpPercent: 0.1,
  retryTimeMin: 0.2,
  retryMax: 8,
  kcMult: 1.2,
  minSpreadTicks: 1,
  suggestTpWindow: 30,
  dcaEnabled: false,
  dcaMaxLayers: 3,
  martingaleEnabled: false,
  martingaleMultiplier: 1.5,
  martingaleMaxLayerNotional: 100,
  s1OnlyDown: false,
  xs1Enabled: true,
  cbEnabled: true,
  cbv2Enabled: true,
  cbv2LockHours: 8,
  cbv3Enabled: true,
  cbv3LockHours: 8,
  // FIX-2026-08-14: CBv5 Advanced Setup defaults
  cbv5Enabled: true,
  cbv5LockHours: 4,
  cbv5KcLen: 20,
  cbv5KcMult: 1.2,
  cbv5PivotLookback: 3,
  cbv5PivotLeftLen: 5,
  cbv5PivotRightLen: 5,
  cbv5StrictBreak: true,
  cbv5UseVolume: true,
  cbv5VolMaLen: 20,
  cbv5VolMultiplier: 1.5,
  cbv5DebounceCandles: 5,
  cbAutoUnlockEnabled: false,
  cbAutoUnlockThresholdPct: 1.0,
  dynamicSizeEnabled: true,
  safeTradeEnabled: true,
  safeTradeTrendlineEnabled: false,
  safeTradeNoTradeEnabled: false,
  autoPauseEnabled: true,
  autoPauseMinKcPct: 2,
  autoPauseMin24hVolUsdt: 1_000_000,
  autoArmStopLossOnUKC: true,
  autoArmLossPct: 6.3,
  autoArmAgeHours: 4,
  slUkcTriggerOnProfit: false,
  tpTrendEnabled: true,
  tpTrendMultiplier: 2,
  autoUpdateTp: true,
  stopLossOnUpperKC: false,
};

async function saveBotDefaults() {
  const el = (id) => document.getElementById(id);
  const num = (id) => parseFloat(el(id).value);
  const int = (id) => parseInt(el(id).value, 10);
  const str = (id) => (el(id).value || '').trim();
  const isChecked = (id) => el(id) ? el(id).checked : false;

  const payload = {
    defaultSymbol: str('bd-symbol') || 'BNBUSDT',
    defaultTimeframe: str('bd-tf') || '3m',
    capitalPerTrade: num('bd-capital'),
    maxTrades: int('bd-maxtrades'),
    tpPercent: num('bd-tp'),
    retryTimeMin: num('bd-retry'),
    retryMax: int('bd-retry-max'),
    kcMult: num('bd-kc-mult'),
    minSpreadTicks: int('bd-min-spread'),
    suggestTpWindow: int('bd-suggest-tp-window'),
    dcaEnabled: isChecked('bd-dca-enabled'),
    dcaMaxLayers: int('bd-dca-max-layers'),
    s1OnlyDown: isChecked('bd-s1-only-down'),
    xs1Enabled: isChecked('bd-xs1-enabled'),
    cbEnabled: isChecked('bd-cb-enabled'),
    cbv2Enabled: isChecked('bd-cbv2-enabled'),
    cbv2LockHours: num('bd-cbv2-lock-hours'),
    cbv3Enabled: isChecked('bd-cbv3-enabled'),
    cbv3LockHours: num('bd-cbv3-lock-hours'),
    // FIX-2026-08-14: CBv5 advanced setup — mirror admin.routes.js whitelist
    cbv5Enabled: isChecked('bd-cbv5-enabled'),
    cbv5StrictBreak: isChecked('bd-cbv5-strict-break'),
    cbv5UseVolume: isChecked('bd-cbv5-use-volume'),
    cbv5LockHours: num('bd-cbv5-lock-hours'),
    cbv5KcLen: int('bd-cbv5-kc-len'),
    cbv5KcMult: num('bd-cbv5-kc-mult'),
    cbv5PivotLookback: int('bd-cbv5-pivot-lookback'),
    cbv5PivotLeftLen: int('bd-cbv5-pivot-left-len'),
    cbv5PivotRightLen: int('bd-cbv5-pivot-right-len'),
    cbv5VolMaLen: int('bd-cbv5-vol-ma-len'),
    cbv5VolMultiplier: num('bd-cbv5-vol-multiplier'),
    cbv5DebounceCandles: int('bd-cbv5-debounce-candles'),
    cbAutoUnlockEnabled: isChecked('bd-cb-auto-unlock-enabled'),
    cbAutoUnlockThresholdPct: num('bd-cb-auto-unlock-threshold'),
    dynamicSizeEnabled: isChecked('bd-dynamic-size-enabled'),
    safeTradeEnabled: isChecked('bd-safe-trade-enabled'),
    safeTradeTrendlineEnabled: isChecked('bd-safe-trade-trendline-enabled'),
    safeTradeNoTradeEnabled: isChecked('bd-safe-trade-no-trade-enabled'),
    autoPauseEnabled: isChecked('bd-auto-pause-enabled'),
    autoPauseMinKcPct: num('bd-auto-pause-min-kc'),
    autoPauseMin24hVolUsdt: num('bd-auto-pause-min-24h-vol'),
    autoArmStopLossOnUKC: isChecked('bd-auto-arm-stop-loss-ukc'),
    autoArmLossPct: num('bd-auto-arm-loss-pct'),
    autoArmAgeHours: num('bd-auto-arm-age-hours'),
    slUkcTriggerOnProfit: isChecked('bd-sl-ukc-trigger-on-profit'),
    tpTrendEnabled: isChecked('bd-tp-trend-enabled'),
    tpTrendMultiplier: num('bd-tp-trend-multiplier'),
    autoUpdateTp: isChecked('bd-auto-update-tp'),
    stopLossOnUpperKC: isChecked('bd-stop-loss-upper-kc'),
  };

  // validate ranges (mirror backend clamps)
  const errors = [];
  if (!Number.isFinite(payload.capitalPerTrade) || payload.capitalPerTrade < 1) errors.push('ทุน/ไม้ ≥ 1');
  if (!Number.isFinite(payload.maxTrades) || payload.maxTrades < 1 || payload.maxTrades > 1000) errors.push('จำนวนไม้ 1..1000');
  if (!Number.isFinite(payload.tpPercent) || payload.tpPercent < 0.001) errors.push('TP% ≥ 0.001');
  if (!Number.isFinite(payload.kcMult) || payload.kcMult < 0.5 || payload.kcMult > 5) errors.push('KC Mult 0.5..5');
  if (!Number.isFinite(payload.cbv2LockHours) || payload.cbv2LockHours < 0.5 || payload.cbv2LockHours > 168) errors.push('CBv2 lock 0.5..168');
  if (!Number.isFinite(payload.cbv3LockHours) || payload.cbv3LockHours < 0.5 || payload.cbv3LockHours > 168) errors.push('CBv3 lock 0.5..168');
  // FIX-2026-08-14: CBv5 validation (mirror admin.routes.js BOT_DEFAULTS_CLAMP)
  if (!Number.isFinite(payload.cbv5LockHours) || payload.cbv5LockHours < 0.5 || payload.cbv5LockHours > 168) errors.push('CBv5 lock 0.5..168');
  if (!Number.isFinite(payload.cbv5KcLen) || payload.cbv5KcLen < 5 || payload.cbv5KcLen > 100) errors.push('CBv5 KC len 5..100');
  if (!Number.isFinite(payload.cbv5KcMult) || payload.cbv5KcMult < 0.5 || payload.cbv5KcMult > 5) errors.push('CBv5 KC mult 0.5..5');
  if (!Number.isFinite(payload.cbv5PivotLookback) || payload.cbv5PivotLookback < 2 || payload.cbv5PivotLookback > 10) errors.push('CBv5 pivot lookback 2..10');
  if (!Number.isFinite(payload.cbv5PivotLeftLen) || payload.cbv5PivotLeftLen < 2 || payload.cbv5PivotLeftLen > 50) errors.push('CBv5 pivot left 2..50');
  if (!Number.isFinite(payload.cbv5PivotRightLen) || payload.cbv5PivotRightLen < 2 || payload.cbv5PivotRightLen > 50) errors.push('CBv5 pivot right 2..50');
  if (!Number.isFinite(payload.cbv5VolMaLen) || payload.cbv5VolMaLen < 5 || payload.cbv5VolMaLen > 100) errors.push('CBv5 vol MA len 5..100');
  if (!Number.isFinite(payload.cbv5VolMultiplier) || payload.cbv5VolMultiplier < 1 || payload.cbv5VolMultiplier > 10) errors.push('CBv5 vol mult 1..10');
  if (!Number.isFinite(payload.cbv5DebounceCandles) || payload.cbv5DebounceCandles < 1 || payload.cbv5DebounceCandles > 20) errors.push('CBv5 debounce 1..20');
  if (!Number.isFinite(payload.autoArmLossPct) || payload.autoArmLossPct < 1 || payload.autoArmLossPct > 99) errors.push('Auto-arm loss 1..99');
  if (!Number.isFinite(payload.autoArmAgeHours) || payload.autoArmAgeHours < 0.5 || payload.autoArmAgeHours > 999) errors.push('Auto-arm age 0.5..999');
  if (!Number.isFinite(payload.tpTrendMultiplier) || payload.tpTrendMultiplier < 1 || payload.tpTrendMultiplier > 10) errors.push('TP trend mult 1..10');
  if (errors.length > 0) {
    setStatus('bd-status', '❌ ' + errors.join(' · '), true);
    return;
  }

  setStatus('bd-status', '⏳ กำลังบันทึก...');
  try {
    await API.put('/api/admin/bot-defaults', payload);
    setStatus('bd-status', '✅ บันทึก Bot Defaults แล้ว · ใช้กับบอทใหม่ที่จะสร้างต่อจากนี้');
    await loadConfig();
  } catch (err) {
    setStatus('bd-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
  }
}

async function resetBotDefaults() {
  if (!confirm('↩️ Reset Bot Defaults เป็นค่าแนะนำ (recommended)?\n\nค่าที่ตั้งไว้จะถูกเขียนทับด้วยค่า default')) return;
  setStatus('bd-status', '⏳ กำลัง reset...');
  try {
    await API.put('/api/admin/bot-defaults', BD_RECOMMENDED);
    setStatus('bd-status', '✅ Reset เป็นค่าแนะนำแล้ว');
    await loadConfig();
  } catch (err) {
    setStatus('bd-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
  }
}

// FIX-2026-08-14: Import/Export file-based for Bot Defaults
//   - includes defaultSymbol + defaultTimeframe (the 2 extra fields)
//   - cross-surface compatible (same JSON works for Master Config + bot-edit)
async function exportBotDefaultsToFile() {
  if (!window.botConfigIO) { setStatus('bd-status', '❌ botConfigIO module ไม่โหลด', true); return; }
  // Reuse saveBotDefaults() payload shape (but as settings object only)
  // Simpler: read all bd-* inputs directly into settings object
  const settings = collectBotDefaultsFromForm();
  const fieldCount = Object.keys(settings).length;
  if (fieldCount === 0) { setStatus('bd-status', '❌ ฟอร์มว่าง', true); return; }
  const payload = window.botConfigIO.buildExportPayload({
    type: 'bot-defaults',
    name: 'Bot Defaults',
    source: 'settings',
    settings,
  });
  const filename = window.botConfigIO.buildExportFilename('bot-defaults', 'defaults');
  window.botConfigIO.triggerDownload(filename, payload);
  setStatus('bd-status', `✅ Export ${fieldCount} fields → ${filename}`);
}

async function importBotDefaultsFromFile(mode) {
  if (!window.botConfigIO) { setStatus('bd-status', '❌ botConfigIO module ไม่โหลด', true); return; }
  if (mode === 'replace' && !window.confirm('Import จะทับค่า Bot Defaults ทั้งหมด — แน่ใจมั้ย?')) return;
  setStatus('bd-status', '⏳ กำลังเลือกไฟล์…');
  const file = await window.botConfigIO.pickJsonFile();
  if (!file) { setStatus('bd-status', 'ยกเลิก'); return; }
  setStatus('bd-status', `⏳ กำลังอ่าน ${file.name}…`);
  const result = await window.botConfigIO.parseImportFile(file);
  if (!result.ok) { setStatus('bd-status', '❌ ' + result.error, true); return; }
  const sanitize = result.sanitizeResult;
  const { applied, skipped } = window.botConfigIO.applyToForm(sanitize.settings, 'bot-defaults', { mode });
  const parts = [`✅ Import ${applied} fields (${mode})`];
  if (sanitize.dropped > 0) parts.push(`dropped ${sanitize.dropped} unknown`);
  if (skipped.length > 0) parts.push(`skipped ${skipped.length}`);
  const warnings = result.warnings || [];
  if (warnings.length) parts.push(`⚠️ ${warnings.join('; ')}`);
  setStatus('bd-status', parts.join(' · '), warnings.length > 0);
}

function collectBotDefaultsFromForm() {
  if (!window.botConfigIO) return {};
  const keys = window.botConfigIO.ALLOWED_FIELD_KEYS;
  const NUM = window.botConfigIO.NUMBER_FIELDS;
  const BOOL = window.botConfigIO.BOOLEAN_FIELDS;
  const STR = window.botConfigIO.STRING_FIELDS;
  const settings = {};
  const el = (id) => document.getElementById(id);
  for (const k of keys) {
    const e = el('bd-' + window.botConfigIO.kebab(k));
    if (!e) continue;
    if (NUM.has(k)) {
      const n = parseFloat(e.value);
      if (Number.isFinite(n)) settings[k] = n;
    } else if (BOOL.has(k)) {
      settings[k] = !!e.checked;
    } else if (STR.has(k)) {
      settings[k] = (e.value || '').trim() || null;
    }
  }
  return settings;
}

// ════════ utils ════════
function setStatus(elId, msg, isError = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.className = 'ms-2 small ' + (isError ? 'text-danger' : 'text-success');
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 5000);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();