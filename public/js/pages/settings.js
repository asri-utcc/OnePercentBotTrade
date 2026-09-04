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
let autoPauseAdjustCfg = null; // FIX-2026-08-29: auto-pause threshold auto-adjust config
let consentStatus = null;  // FIX-2026-08-26 Phase 3a: GET /api/consent/status for Settings page
let licenseInfo = null;   // FIX-2026-08-26 Phase 3a: GET /api/license/info for Settings page
let configBackupPreview = null; // FIX-2026-08-29: GET /api/admin/config/backup/preview
let autoTimingCfg = null; // FIX-2026-08-30 / Phase 4: Auto-Timing config

async function init() {
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me || !me.authenticated) {
    location.href = '/login.html';
    return;
  }
  await loadConfig();
  await loadChatDisplayName();
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
    // FIX-2026-08-29: Auto-pause threshold auto-adjust (master settings)
    try {
      autoPauseAdjustCfg = await API.get('/api/admin/auto-pause-adjust');
    } catch (err) {
      console.warn('auto-pause-adjust config load failed:', err.message);
      autoPauseAdjustCfg = {
        ok: false,
        settings: { enabled: false, minBots: 15, maxBots: 25, intervalMs: 3600000, kcStep: 0.1, volStep: 100000, lastRunAt: null, lastStats: null, lastError: null },
        status: {},
        counts: { running: 0, eligible: 0, optedOut: 0 },
      };
    }
    // FIX-2026-08-26 Phase 3a: Consent + License status for Settings page
    try {
      consentStatus = await API.get('/api/consent/status');
    } catch (err) {
      console.warn('consent status load failed:', err.message);
      consentStatus = { decision: null, consentVersion: null, consentEnabled: false };
    }
    // FIX-2026-08-29: Config Backup preview (counts/sizes per section)
    try {
      configBackupPreview = await API.get('/api/admin/config/backup/preview');
    } catch (err) {
      console.warn('config-backup preview load failed:', err.message);
      configBackupPreview = { ok: false, error: err.message, counts: {}, warnings: [] };
    }
    try {
      licenseInfo = await API.get('/api/license/info');
    } catch (err) {
      console.warn('license info load failed:', err.message);
      licenseInfo = { license: null, lastValidatedAt: null, adminMonitorEnabled: false, machineId: '—' };
    }
    // FIX-2026-08-30 / Phase 4: Auto-Timing master config (5-band editor + Save/Run-now)
    if (window.AutoTimingUI && typeof window.AutoTimingUI.loadConfig === 'function') {
      autoTimingCfg = await window.AutoTimingUI.loadConfig();
    } else {
      autoTimingCfg = { config: null, status: null, bands: [], defaultBands: {} };
    }
    render();
    // FIX-2026-08-30 / Phase 4: Auto-Timing uses its own renderer, bind its section events after render()
    if (window.AutoTimingUI && typeof window.AutoTimingUI.bind === 'function') {
      window.AutoTimingUI.bind();
    }
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
          <!-- FIX-2026-08-26 Phase 3a: Consent & License chip -->
          <a href="#group-consent" class="lux-chip">📜 Consent &amp; License</a>
          <!-- FIX-2026-08-29: Config Backup & Restore chip -->
          <a href="#group-data" class="lux-chip">💾 Backup &amp; Restore</a>
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
        ${renderAutoPauseAdjustSection()}
        ${(function () {
          // FIX-2026-08-30 / Phase 4: Auto-Timing section (5-band table editor + Save/Run-now)
          if (window.AutoTimingUI && typeof window.AutoTimingUI.render === 'function') {
            window.AUTO_TIMING_CFG = autoTimingCfg;
            return window.AutoTimingUI.render();
          }
          return '';
        })()}
        ${renderCbVersionSection()}
        ${renderDpsSection()}
        ${renderDailyTargetSection()}

        <!-- ════════ 🛡️ กลุ่มที่ 4: ความปลอดภัย ════════ -->
        <h5 id="group-safety" class="settings-group-title">🛡️ ความปลอดภัย</h5>
        <p class="text-muted-3 small mb-3">Auto-Buy BNB + safety toggles</p>

        ${renderBnbSection()}

        <!-- ════════ 💬 กลุ่มที่ 5: Chat Display Name (Phase 4-2026-08-29) ════════ -->
        <h5 id="group-chat" class="settings-group-title">💬 Chat Display Name</h5>
        <p class="text-muted-3 small mb-3">ชื่อที่จะแสดงใน Community Room + DM กับ admin</p>

        ${renderChatDisplayNameSection()}

        <!-- ════════ 📜 กลุ่มที่ 6: Consent & License (FIX-2026-08-26) ════════ -->
        <h5 id="group-consent" class="settings-group-title">📜 Consent &amp; License</h5>
        <p class="text-muted-3 small mb-3">การยินยอมให้ดำเนินการ + รายละเอียด License</p>

        ${renderConsentSection()}
        ${renderLicenseSection()}

        <!-- ════════ 💾 กลุ่มที่ 7: Backup & Restore (FIX-2026-08-29) ════════ -->
        <h5 id="group-data" class="settings-group-title">💾 Backup &amp; Restore</h5>
        <p class="text-muted-3 small mb-3">สำรองและกู้คืนการตั้งค่าทั้งระบบเป็นไฟล์ .json</p>

        ${renderConfigBackupSection()}

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
      <!-- FIX-2026-09-02: Round-down Capital — min notional threshold (USDT) -->
      <div class="col-md-3">
        <label class="form-label" for="bd-round-down-capital-min">📉 Round-down min (USDT)</label>
        <input type="number" class="form-control" id="bd-round-down-capital-min" value="${d.roundDownCapitalMin ?? 5.5}" step="0.1" min="1" max="10000" />
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
      <!-- FIX-2026-09-02: Round-down Capital toggle (opt-in per-bot) -->
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-round-down-capital-enabled" ${d.roundDownCapitalEnabled ? 'checked' : ''} />
          <span class="form-check-label">💸 Round-down ทุนเมื่อเงินไม่พอ</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-label" for="bd-auto-timing-enabled">⏱️ Auto-Timing (heatmap-driven)</label>
        <select class="form-select form-select-sm" id="bd-auto-timing-enabled">
      </div>
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-auto-pause-adjust-enabled" ${d.autoPauseAdjustEnabled === true ? 'checked' : ''} />
          <span class="form-check-label">🎚️ Auto-pause threshold auto-adjust</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-label" for="bd-auto-timing-enabled">⏱️ Auto-Timing (heatmap-driven)</label>
        <select class="form-select form-select-sm" id="bd-auto-timing-enabled">
          <option value="inherit" ${(d.autoTimingEnabled === null || d.autoTimingEnabled === undefined) ? 'selected' : ''}>🟢 Inherit master</option>
          <option value="true" ${d.autoTimingEnabled === true ? 'selected' : ''}>✅ Force ON</option>
          <option value="false" ${d.autoTimingEnabled === false ? 'selected' : ''}>🚫 Force OFF</option>
        </select>
        <small class="text-muted-3 d-block mt-1">Tristate: inherit / force-on / force-off</small>
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

    <hr class="my-3" />
    <h6 class="text-muted mb-2">🚨 Circuit-Breaker panic-close <small>(Phase 3b-2)</small></h6>
    <div class="row g-3">
      <div class="col-md-4">
        <label class="form-label">CB panic min positions <span class="text-muted">(≥ แจ้งเตือน)</span></label>
        <input type="number" class="form-control" id="th-cbPanicMin" value="${Number.isFinite(Number(th.cbPanicMinPositions)) ? Number(th.cbPanicMinPositions) : 1}" step="1" min="1" max="100" />
        <small class="text-muted">เช่น <code>1</code> = แจ้งทุก panic-close · <code>3</code> = แจ้งเฉพาะ panic ≥ 3 ไม้ (ลด noise สำหรับ basic-tier)</small>
      </div>
    </div>

    <hr class="my-3" />
    <h6 class="text-muted mb-2">🌙 Quiet Hours <small>(Phase 3b-2)</small></h6>
    <div class="row g-3 align-items-end">
      <div class="col-md-3">
        <div class="form-check form-switch">
          <input class="form-check-input" type="checkbox" id="th-quietHoursEnabled" ${th.quietHoursEnabled === true ? 'checked' : ''} />
          <label class="form-check-label" for="th-quietHoursEnabled"><strong>เปิด Quiet Hours</strong> — ระงับ alert ทุกประเภทในช่วงเวลาที่กำหนด</label>
        </div>
      </div>
      <div class="col-md-2">
        <label class="form-label">เริ่ม <span class="text-muted">(HH:mm)</span></label>
        <input type="time" class="form-control" id="th-quietHoursStart" value="${typeof th.quietHoursStart === 'string' ? th.quietHoursStart : '22:00'}" />
      </div>
      <div class="col-md-2">
        <label class="form-label">สิ้นสุด <span class="text-muted">(HH:mm)</span></label>
        <input type="time" class="form-control" id="th-quietHoursEnd" value="${typeof th.quietHoursEnd === 'string' ? th.quietHoursEnd : '07:00'}" />
      </div>
      <div class="col-md-5">
        <small class="text-muted">
          เช่น <code>22:00–07:00</code> = ระงับทุกคืน (wrap midnight) ·
          <code>09:00–17:00</code> = ระงับช่วงกลางวัน ·
          ปิด = แจ้งตลอด 24 ชม. (default)
        </small>
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
      <br /><strong>Last fire:</strong> ${lastRunAt} · tickCount=${tickCount} <span class="text-muted-3">(อัปเดตเฉพาะตอนยิงจริงที่ HH:00 BKK ตาม checkHours — ไม่ใช่ทุก 60s tick)</span>
      ${lastStats ? `<br /><strong>Last stats:</strong> outcome=${escapeHtml(lastStats.outcome || '—')} · action=${escapeHtml(lastStats.action || '—')} · deltaUsdt=${lastStats.deltaUsdt ?? 0} · usablePole=${lastStats.usablePoleCount ?? '?'} · lossPole=${lastStats.lossPoleCount ?? 0} · available=${lastStats.availablePoleCount ?? '?'} · target=${lastStats.targetPoleCount ?? '?'} · positions=${lastStats.positionCount ?? 0}` : ''}
      ${status.lastRunError ? `<br /><strong>Last error:</strong> <span class="text-danger">${escapeHtml(status.lastRunError)}</span>` : ''}
    </div>
  `);
}

// ─── 🛒 Section: Auto-adjust Auto-pause thresholds (FIX-2026-08-29) ───
function renderAutoPauseAdjustSection() {
  const cfg = (autoPauseAdjustCfg && autoPauseAdjustCfg.settings) || {};
  const status = (autoPauseAdjustCfg && autoPauseAdjustCfg.status) || {};
  const counts = (autoPauseAdjustCfg && autoPauseAdjustCfg.counts) || {};
  const enabled = !!cfg.enabled;
  const lastRunAt = cfg.lastRunAt ? new Date(cfg.lastRunAt).toLocaleString() : '—';
  const lastStats = cfg.lastStats || null;
  const tickCount = status.tickCount != null ? status.tickCount : 0;
  const inFlight = status.inFlight ? '⏳ in-flight' : '';
  // intervalMs → human friendly (15m/30m/1h/2h/3h/4h/6h/12h/24h)
  // FIX-2026-08-30: default is now 30min (was 1h) per user request
  const intervalMs = Number(cfg.intervalMs) || (30 * 60 * 1000);
  const intervalHours = intervalMs / (60 * 60 * 1000);
  const intervalMinutes = Math.round(intervalMs / (60 * 1000));
  const intervalOptions = [
    { ms: 15 * 60 * 1000, label: '15 นาที' },
    { ms: 30 * 60 * 1000, label: '30 นาที' },
    { ms: 60 * 60 * 1000, label: '1 ชม.' },
    { ms: 2 * 60 * 60 * 1000, label: '2 ชม.' },
    { ms: 3 * 60 * 60 * 1000, label: '3 ชม.' },
    { ms: 4 * 60 * 60 * 1000, label: '4 ชม.' },
    { ms: 6 * 60 * 60 * 1000, label: '6 ชม.' },
    { ms: 12 * 60 * 60 * 1000, label: '12 ชม.' },
    { ms: 24 * 60 * 60 * 1000, label: '24 ชม.' },
  ];
  return section('sec-auto-pause-adjust', '🔧', 'Auto-adjust Auto-pause thresholds — ปรับ KC/Vol ตามจำนวนบอทที่รัน', false, `
    <div class="alert alert-info small mb-3">
      <strong>📌 วิธีทำงาน:</strong> ทุก <code>intervalMs</code> ระบบจะนับจำนวน running bots (ที่เปิดใช้ Auto-pause):
      <br />• ถ้า <code>running &gt; maxBots</code> → <strong>tighten</strong> thresholds (<code>+kcStep%</code>, <code>+volStep</code> USDT) — บอทที่ %KC/Vol ต่ำจะถูก pause เพิ่ม
      <br />• ถ้า <code>running &lt; minBots</code> → <strong>loosen</strong> thresholds (<code>-kcStep%</code>, <code>-volStep</code> USDT) — บอทที่ pause อยู่จะ resume กลับมา
      <br />• ถ้าอยู่ในช่วง <code>[minBots, maxBots]</code> → no-op
      <br />⚠️ <strong>ปรับเฉพาะบอทที่ <code>autoPauseAdjustEnabled=true</code></strong> (per-bot opt-out — default ON)
    </div>

    <div class="mb-3">
      <label class="form-check form-switch">
        <input type="checkbox" class="form-check-input" id="apa-enabled" ${enabled ? 'checked' : ''} />
        <span class="form-check-label"><strong>เปิด Auto-adjust</strong> — ระบบจะปรับ Min-%KC และ Min 24h Vol thresholds อัตโนมัติ</span>
      </label>
    </div>

    <div class="row g-3">
      <div class="col-md-3">
        <label class="form-label">🔻 Min bots (loosen ถ้า &lt;)</label>
        <input type="number" class="form-control" id="apa-min" value="${cfg.minBots ?? 15}" step="1" min="1" max="1000" />
        <small class="text-muted">running &lt; นี้ → loosen (default 15)</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">🔺 Max bots (tighten ถ้า &gt;)</label>
        <input type="number" class="form-control" id="apa-max" value="${cfg.maxBots ?? 25}" step="1" min="1" max="1000" />
        <small class="text-muted">running &gt; นี้ → tighten (default 25)</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">⏱ Check interval</label>
        <select class="form-select" id="apa-interval">
          ${intervalOptions.map((o) => `<option value="${o.ms}" ${intervalMs === o.ms ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
        <small class="text-muted">default 1 ชม. · หลังปรับระบบจะ tick ทันที (first-fire)</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">📏 KC step (%)</label>
        <input type="number" class="form-control" id="apa-kcstep" value="${cfg.kcStep ?? 0.1}" step="0.05" min="0.01" max="5" />
        <small class="text-muted">ปรับ Min-%KC ครั้งละกี่ % (default 0.1)</small>
      </div>
    </div>
    <div class="row g-3 mt-1">
      <div class="col-md-3">
        <label class="form-label">💵 Vol step (USDT)</label>
        <input type="number" class="form-control" id="apa-volstep" value="${cfg.volStep ?? 100000}" step="10000" min="1000" max="100000000" />
        <small class="text-muted">ปรับ Min 24h Vol ครั้งละกี่ USDT (default 100K)</small>
      </div>
    </div>

    <div class="alert alert-warning small mt-3 mb-2">
      <strong>🔒 Operational clamps (FIX-2026-08-30)</strong> — กำหนดขอบเขตที่ Auto-adjust �ะปรับ thresholds ไม่ให้เกินช่วงนี้:
      <br />• KC clamp: <code>[KcClampMin, KcClampMax]</code>% — ถ้า bot ชนขอบเ�ตนี้แล้ว ระบบจะ skip (ไม่เขียน no-op)
      <br />• Vol clamp: <code>[VolClampMin, VolClampMax]</code> USDT — เหมือนกันสำหรับ Min 24h Vol
      <br />⚠️ ต้องให้ <code>kcClampMin &lt; kcClampMax</code> และ <code>volClampMin &lt; volClampMax</code>
    </div>

    <div class="row g-3 mt-1">
      <div class="col-md-3">
        <label class="form-label">🔻 KC clamp min (%)</label>
        <input type="number" class="form-control" id="apa-kc-clamp-min" value="${cfg.kcClampMin ?? 0.8}" step="0.1" min="0.1" max="50" />
        <small class="text-muted">Min-%KC ขั้นต่ำ (default 0.8)</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">� KC clamp max (%)</label>
        <input type="number" class="form-control" id="apa-kc-clamp-max" value="${cfg.kcClampMax ?? 2.8}" step="0.1" min="0.1" max="50" />
        <small class="text-muted">Min-%KC สูงสุด (default 2.8)</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">🔻 Vol clamp min (USDT)</label>
        <input type="number" class="form-control" id="apa-vol-clamp-min" value="${cfg.volClampMin ?? 100000}" step="10000" min="0" max="1000000000" />
        <small class="text-muted">Min 24h Vol ขั้นต่ำ (default 100K)</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">🔺 Vol clamp max (USDT)</label>
        <input type="number" class="form-control" id="apa-vol-clamp-max" value="${cfg.volClampMax ?? 2800000}" step="100000" min="0" max="1000000000" />
        <small class="text-muted">Min 24h Vol สูงสุด (default 2.8M)</small>
      </div>
    </div>

    <div class="mt-3">
      <button type="button" class="btn btn-primary" id="btn-save-apa">💾 บันทึก Auto-adjust</button>
      <button type="button" class="btn btn-outline-warning ms-2" id="btn-trigger-apa">🖐 Run now</button>
      <span class="ms-2 text-muted small" id="apa-status"></span>
    </div>

    <div class="text-muted small mt-3">
      <strong>สถานะ:</strong> ${enabled ? '🟢 enabled' : '⚪ disabled'} · interval=${escapeHtml(intervalMinutes < 60 ? intervalMinutes + ' นาที' : intervalHours + 'h')} · minBots=${cfg.minBots ?? 15} · maxBots=${cfg.maxBots ?? 25} · kcStep=${cfg.kcStep ?? 0.1} · volStep=${cfg.volStep ?? 100000} ${inFlight}
      <br /><strong>Clamps (FIX-2026-08-30):</strong> KC [${cfg.kcClampMin ?? 0.8}, ${cfg.kcClampMax ?? 2.8}]% · Vol [${(cfg.volClampMin ?? 100000).toLocaleString()}, ${(cfg.volClampMax ?? 2800000).toLocaleString()}] USDT
      <br /><strong>Counts:</strong> running=${counts.running ?? '?'} · eligible=${counts.eligible ?? '?'} · optedOut=${counts.optedOut ?? '?'}
      <br /><strong>Last fire:</strong> ${lastRunAt} · tickCount=${tickCount}
      ${lastStats ? `<br /><strong>Last stats:</strong> outcome=${escapeHtml(lastStats.outcome || '—')} · action=${escapeHtml(lastStats.action || '—')} · running=${lastStats.runningBots ?? '?'} · updated=${lastStats.updatedBots ?? 0} · prevKcAvg=${lastStats.prevKcAvg != null ? Number(lastStats.prevKcAvg).toFixed(2) : '?'} · newKcAvg=${lastStats.newKcAvg != null ? Number(lastStats.newKcAvg).toFixed(2) : '?'}` : ''}
      ${cfg.lastError ? `<br /><strong>Last error:</strong> <span class="text-danger">${escapeHtml(cfg.lastError)}</span>` : ''}
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
// FIX-2026-09-03: layer-removal — DPS now only auto-tunes size (layers owned by separate function).
//   5 layer inputs removed from renderDpsSection (Min layers, Max layers, Δ layers in Rules 1/2/3).
function renderDpsSection() {
  const dcfg = (adminCfg && adminCfg.config) || {};
  const dps = {
    dpsMinSize:   Number.isFinite(Number(dcfg.dpsMinSize))   ? Number(dcfg.dpsMinSize)   : 6,
    dpsMaxSize:   Number.isFinite(Number(dcfg.dpsMaxSize))   ? Number(dcfg.dpsMaxSize)   : 15,
    dpsCooldownMinutes: Number.isFinite(Number(dcfg.dpsCooldownMinutes)) ? Number(dcfg.dpsCooldownMinutes) : 5,
    dpsWinStreakCount:    Number.isFinite(Number(dcfg.dpsWinStreakCount))    ? Number(dcfg.dpsWinStreakCount)    : 3,
    dpsWinStreakDeltaSize:    Number.isFinite(Number(dcfg.dpsWinStreakDeltaSize))    ? Number(dcfg.dpsWinStreakDeltaSize)    : 1,
    dpsBigWinCount:    Number.isFinite(Number(dcfg.dpsBigWinCount))    ? Number(dcfg.dpsBigWinCount)    : 2,
    dpsBigWinPct:      Number.isFinite(Number(dcfg.dpsBigWinPct))      ? Number(dcfg.dpsBigWinPct)      : 2.0,
    dpsBigWinDeltaSize:    Number.isFinite(Number(dcfg.dpsBigWinDeltaSize))    ? Number(dcfg.dpsBigWinDeltaSize)    : 2,
    dpsLossStreakCount: Number.isFinite(Number(dcfg.dpsLossStreakCount)) ? Number(dcfg.dpsLossStreakCount) : 1,
    dpsLossDeltaSize:   Number.isFinite(Number(dcfg.dpsLossDeltaSize))   ? Number(dcfg.dpsLossDeltaSize)   : -2,
    dpsRespectBotCapital:  dcfg.dpsRespectBotCapital  !== false,
    dpsResetHistoryOnFire: dcfg.dpsResetHistoryOnFire !== false,
    dpsDryRun:             dcfg.dpsDryRun === true,
  };
  return section('sec-dps', '📊', 'Dynamic Position Sizing (DPS) — auto-tune size', false, `
    <div class="row g-3">
      <div class="col-md-4">
        <label class="form-label">📐 Min size (USDT)</label>
        <input type="number" class="form-control dps-input" id="dps-min-size" value="${dps.dpsMinSize}" step="0.01" min="5" max="10000" data-dps="dpsMinSize" />
      </div>
      <div class="col-md-4">
        <label class="form-label">📐 Max size (USDT)</label>
        <input type="number" class="form-control dps-input" id="dps-max-size" value="${dps.dpsMaxSize}" step="0.01" min="5" max="10000" data-dps="dpsMaxSize" />
      </div>
      <div class="col-md-4">
        <label class="form-label">⏱ Cooldown (นาที)</label>
        <input type="number" class="form-control dps-input" id="dps-cooldown" value="${dps.dpsCooldownMinutes}" step="1" min="0" max="1440" data-dps="dpsCooldownMinutes" />
      </div>
    </div>

    <hr />

    <div class="row g-3">
      <div class="col-md-12">
        <strong class="text-muted-3">กฎ 1 · ชนะติดกัน N ไม้</strong>
      </div>
      <div class="col-md-6">
        <label class="form-label">จำนวนไม้ชนะติด</label>
        <input type="number" class="form-control dps-input" id="dps-r1-count" value="${dps.dpsWinStreakCount}" step="1" min="1" max="20" data-dps="dpsWinStreakCount" />
      </div>
      <div class="col-md-6">
        <label class="form-label">Δ size</label>
        <input type="number" class="form-control dps-input" id="dps-r1-dsize" value="${dps.dpsWinStreakDeltaSize}" step="0.1" min="-1000" max="1000" data-dps="dpsWinStreakDeltaSize" />
      </div>
    </div>

    <div class="row g-3 mt-1">
      <div class="col-md-12">
        <strong class="text-muted-3">กฎ 2 · N ไม้ล่าสุดกำไร ≥ X% ทุกไม้</strong>
      </div>
      <div class="col-md-4">
        <label class="form-label">จำนวนไม้ย้อนหลัง</label>
        <input type="number" class="form-control dps-input" id="dps-r2-count" value="${dps.dpsBigWinCount}" step="1" min="1" max="20" data-dps="dpsBigWinCount" />
      </div>
      <div class="col-md-4">
        <label class="form-label">% กำไรขั้นต่ำต่อไม้</label>
        <input type="number" class="form-control dps-input" id="dps-r2-pct" value="${dps.dpsBigWinPct}" step="0.1" min="0.1" max="100" data-dps="dpsBigWinPct" />
      </div>
      <div class="col-md-4">
        <label class="form-label">Δ size</label>
        <input type="number" class="form-control dps-input" id="dps-r2-dsize" value="${dps.dpsBigWinDeltaSize}" step="0.1" min="-1000" max="1000" data-dps="dpsBigWinDeltaSize" />
      </div>
    </div>

    <div class="row g-3 mt-1">
      <div class="col-md-12">
        <strong class="text-muted-3">กฎ 3 · แพ้ติดกัน N ไม้</strong>
      </div>
      <div class="col-md-6">
        <label class="form-label">จำนวนไม้แพ้ติด</label>
        <input type="number" class="form-control dps-input" id="dps-r3-count" value="${dps.dpsLossStreakCount}" step="1" min="1" max="20" data-dps="dpsLossStreakCount" />
      </div>
      <div class="col-md-6">
        <label class="form-label">Δ size</label>
        <input type="number" class="form-control dps-input" id="dps-r3-dsize" value="${dps.dpsLossDeltaSize}" step="0.1" min="-1000" max="1000" data-dps="dpsLossDeltaSize" />
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

// ─── 📜 Section: Consent status (FIX-2026-08-26) ──────────────────
// Phase 4-2026-08-29: Chat Display Name — operator's identity in community room + DM to admin
function renderChatDisplayNameSection() {
  return section('sec-chat-display-name', '💬', 'Chat Display Name — ชื่อที่แสดงในแชท', false, `
    <div class="alert alert-info small mb-3">
      <strong>📌 ใช้ที่ไหน:</strong> ชื่อนี้จะแสดงเมื่อคุณโพสต์ใน <a href="/chat.html">Community Room</a> หรือส่ง DM ให้ admin
      · ถ้าไม่ตั้ง ระบบจะใช้ <code>customerTag</code> หรือ 8 ตัวแรกของ machineId เป็น fallback
      · แก้ไขได้ตลอด — มีผลกับข้อความถัดไปที่ส่ง
    </div>

    <div class="row g-3 align-items-end">
      <div class="col-md-6">
        <label class="form-label">ชื่อที่จะแสดง <span class="text-muted small">(1-32 ตัวอักษร)</span></label>
        <input type="text" class="form-control" id="f-chat-display-name" maxlength="32" placeholder="เช่น alice, alice-shopA" />
        <div class="form-text text-muted small mt-1" id="f-chat-display-name-help">Loading...</div>
      </div>
      <div class="col-md-3">
        <button type="button" class="btn btn-primary" id="btn-save-chat-display-name">💾 บันทึกชื่อ</button>
      </div>
      <div class="col-md-3">
        <a href="/chat.html" class="btn btn-outline-info">💬 เปิดหน้าแชท</a>
      </div>
    </div>

    <div id="chat-display-name-status" class="ms-2 small mt-2"></div>
  `);
}

function renderConsentSection() {
  const status = consentStatus || { decision: null, consentVersion: null, consentEnabled: false };
  const decision = status.decision; // 'accepted' | 'declined' | null
  const version = status.consentVersion || '—';
  const decidedAt = status.decidedAt ? new Date(status.decidedAt).toLocaleString() : '—';
  const source = status.source || '—'; // 'first_run' | 'settings_change'
  const consentEnabled = !!status.consentEnabled;

  let badge = '⚪ Pending';
  let badgeClass = 'text-muted-3';
  if (decision === 'accepted') { badge = '🟢 Accepted'; badgeClass = 'text-success'; }
  else if (decision === 'declined') { badge = '🔴 Declined'; badgeClass = 'text-danger'; }
  if (!consentEnabled) { badge = '⚪ Disabled'; badgeClass = 'text-muted-3'; }

  return section('sec-consent', '📜', 'Consent — การยินยอมให้บอททำงาน', false, `
    <div class="alert alert-info small mb-3">
      <strong>📌 Consent คืออะไร:</strong> เอกสารสรุปความเสี่ยง + การเชื่อมต่อ + การโทรออก (phone-home)
      ที่ผู้ใช้ต้องอ่านและยอมรับก่อนบอทเริ่มเทรด · บังคับใช้ครั้งเดียวต่อเครื่อง (เก็บใน local + admin DB)
    </div>

    <div class="row g-3">
      <div class="col-md-3">
        <label class="form-label">📊 สถานะปัจจุบัน</label>
        <div class="fs-5 ${badgeClass}"><strong>${badge}</strong></div>
      </div>
      <div class="col-md-3">
        <label class="form-label">📅 Document version</label>
        <div><code>${escapeHtml(version)}</code></div>
      </div>
      <div class="col-md-3">
        <label class="form-label">🕐 Decided at</label>
        <div class="text-muted small">${escapeHtml(decidedAt)}</div>
      </div>
      <div class="col-md-3">
        <label class="form-label">📝 Source</label>
        <div class="text-muted small"><code>${escapeHtml(source)}</code></div>
      </div>
    </div>

    <div class="mt-3 d-flex align-items-center flex-wrap">
      <a href="/consent" class="btn btn-primary" id="btn-open-consent">📝 เปิดหน้า Consent</a>
      <button type="button" class="btn btn-outline-info ms-2" id="btn-reload-consent">🔄 Refresh สถานะ</button>
      <span class="ms-3 text-muted small" id="consent-status"></span>
    </div>

    <div class="text-muted small mt-3">
      <strong>หมายเหตุ:</strong> การเปลี่ยน decision ต้องเปิดหน้า /consent แล้วเลือก Accept / Decline อีกครั้ง
      · หากต้องการ reset consent (เช่น ทดสอบ first-run flow) ให้รัน <code>npm run consent:reset</code> ในโฟลเดอร์บอท
    </div>
  `);
}

// ─── 📜 Section: License details (FIX-2026-08-26) ──────────────────
function renderLicenseSection() {
  const info = licenseInfo || { license: null, lastValidatedAt: null, adminMonitorEnabled: false, machineId: '—' };
  const lic = info.license || null;
  const enabled = !!info.adminMonitorEnabled;
  const machineId = info.machineId || '—';
  const lastValidatedAt = info.lastValidatedAt ? new Date(info.lastValidatedAt).toLocaleString() : '—';

  if (!enabled) {
    return section('sec-license', '🪪', 'License — รายละเอียด License (Admin Monitor)', false, `
      <div class="alert alert-warning small mb-3">
        <strong>⚪ Admin Monitor ปิดอยู่</strong> — บอทเครื่องนี้ไม่ได้เชื่อมต่อกับ admin server
        (<code>ADMIN_MONITOR_URL</code> หรือ <code>LICENSE_KEY</code> ว่าง) · ไม่มี License ให้แสดง
      </div>
      <div class="text-muted small">machineId: <code>${escapeHtml(machineId)}</code></div>
    `);
  }

  if (!lic) {
    return section('sec-license', '🪪', 'License — รายละเอียด License (Admin Monitor)', false, `
      <div class="alert alert-warning small mb-3">
        <strong>⏳ ยังไม่ได้ validate License</strong> — บอทยังไม่เคยติดต่อ admin server สำเร็จ
        · กดปุ่ม <em>🔄 Refresh License</em> เพื่อลองใหม่
      </div>
      <div class="mt-3">
        <button type="button" class="btn btn-primary" id="btn-refresh-license">🔄 Refresh License</button>
        <span class="ms-2 text-muted small" id="license-status"></span>
      </div>
      <div class="text-muted small mt-3">machineId: <code>${escapeHtml(machineId)}</code></div>
    `);
  }

  // Tier badge color
  const tier = (lic.tier || 'unknown').toLowerCase();
  const tierBadgeClass = {
    'free': 'bg-secondary',
    'pro': 'bg-primary',
    'enterprise': 'bg-warning text-dark',
  }[tier] || 'bg-secondary';

  // Features chips
  const features = lic.features || {};
  const featureChips = Object.keys(features).length === 0
    ? '<span class="text-muted small">—</span>'
    : Object.entries(features).map(([k, v]) => {
        const enabled = !!v;
        return `<span class="badge ${enabled ? 'bg-success' : 'bg-light text-dark border'} me-1 mb-1">${enabled ? '✓' : '✗'} ${escapeHtml(k)}</span>`;
      }).join(' ');

  // Expires at
  const expiresAt = lic.expiresAt ? new Date(lic.expiresAt).toLocaleString() : '—';
  const maxBots = (lic.maxBots != null) ? lic.maxBots : '—';
  const maxMachines = (lic.maxMachines != null) ? lic.maxMachines : '—';
  const customerTag = lic.customerTag || '—';
  const owner = lic.owner || '—';

  return section('sec-license', '🪪', 'License — รายละเอียด License (Admin Monitor)', false, `
    <div class="alert alert-info small mb-3">
      <strong>📌 License นี้:</strong> ผูกกับ <code>${escapeHtml(machineId)}</code> (this machine)
      · admin server ตรวจ license key + heartbeat ทุก 60s
      · <code>lastValidatedAt</code> = admin ตอบกลับล่าสุดเมื่อไหร่
    </div>

    <div class="row g-3">
      <div class="col-md-3">
        <label class="form-label">🏷 Tier</label>
        <div><span class="badge ${tierBadgeClass} fs-6">${escapeHtml(tier.toUpperCase())}</span></div>
      </div>
      <div class="col-md-3">
        <label class="form-label">👤 Owner</label>
        <div><code>${escapeHtml(owner)}</code></div>
      </div>
      <div class="col-md-3">
        <label class="form-label">🏢 Customer Tag</label>
        <div><code>${escapeHtml(customerTag)}</code></div>
      </div>
      <div class="col-md-3">
        <label class="form-label">📅 Expires at</label>
        <div class="text-muted small">${escapeHtml(expiresAt)}</div>
      </div>
      <div class="col-md-3">
        <label class="form-label">🤖 Max bots</label>
        <div><code>${escapeHtml(String(maxBots))}</code></div>
      </div>
      <div class="col-md-3">
        <label class="form-label">🖥 Max machines</label>
        <div><code>${escapeHtml(String(maxMachines))}</code></div>
      </div>
      <div class="col-md-6">
        <label class="form-label">🕐 Last validated</label>
        <div class="text-muted small">${escapeHtml(lastValidatedAt)}</div>
      </div>
    </div>

    <div class="mt-3">
      <label class="form-label">✨ Features</label>
      <div>${featureChips}</div>
    </div>

    <div class="mt-3 d-flex align-items-center flex-wrap">
      <button type="button" class="btn btn-outline-primary" id="btn-refresh-license">🔄 Refresh License</button>
      <span class="ms-3 text-muted small" id="license-status"></span>
    </div>

    <div class="text-muted small mt-3">
      <strong>หมายเหตุ:</strong> License key อยู่ใน <code>.env</code> (<code>LICENSE_KEY</code>) · การเปลี่ยน key
      ต้อง restart bot · ถ้า license หมดอายุบอทจะหยุดเทรดใหม่ (positions เดิมยังจัดการต่อตาม TP/SL ปกติ)
    </div>
  `);
}

// ─── 💾 Config Backup & Restore (FIX-2026-08-29) ────────────────────────
function renderConfigBackupSection() {
  const preview = configBackupPreview || { ok: false, counts: {}, warnings: [] };
  const counts = preview.counts || {};
  const c = (n) => (counts[n] && Number.isFinite(counts[n].count)) ? counts[n].count : 0;
  const sizeKB = (n) => {
    const b = (counts[n] && Number.isFinite(counts[n].sizeBytes)) ? counts[n].sizeBytes : 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  };
  const present = (n) => !!(counts[n] && counts[n].present);
  const encryptionWarn = preview.encryptionAvailable === false
    ? '<div class="alert alert-danger small mb-3">⚠️ <strong>ENCRYPTION_KEY ไม่พร้อม</strong> — encrypted blobs (apiKeys, telegram token) จะถูกเขียนแต่ไม่สามารถ decrypt ได้ตอน restore</div>'
    : '';
  const licenseWarn = '<div class="alert alert-secondary small mb-3">ℹ️ License section: backup เป็น metadata เท่านั้น · restore = no-op (license admin-issued)</div>';
  return section('sec-config-backup', '💾', 'Config Backup & Restore — สำรอง/กู้คืนการตั้งค่าทั้งระบบ', false, `
    <div class="alert alert-info small mb-3">
      <strong>📌 วิธีใช้:</strong> สำรอง config เป็นไฟล์ <code>.json</code> หรือกู้คืนจากไฟล์
      · เลือกได้ว่าจะ backup/restore เฉพาะส่วน (api keys / telegram / app config / positions / bots / license / others)
      · ⚠️ <strong>Encryption caveat:</strong> apiKeys + telegram token ถูกเข้ารหัส AES-256-GCM — restore บนเครื่องอื่นต้องใช้ <code>ENCRYPTION_KEY</code> เดียวกันใน <code>.env</code>
    </div>
    ${encryptionWarn}
    ${licenseWarn}
    <div class="row g-3">
      <div class="col-md-6">
        <button type="button" class="lux-btn lux-btn-primary w-100" id="cfg-backup-btn">
          📥 Backup → Download .json
        </button>
      </div>
      <div class="col-md-6">
        <button type="button" class="lux-btn lux-btn-warning w-100" id="cfg-restore-btn">
          📤 Restore from .json
        </button>
      </div>
    </div>
    <div class="row g-2 mt-2 text-muted-3 small">
      <div class="col-md-4"><strong>📊 Sections (live counts):</strong></div>
      <div class="col-md-8">
        <span class="badge bg-secondary me-1">🔑 apiKeys ${present('apiKeys') ? '✓' : '—'}</span>
        <span class="badge bg-secondary me-1">📨 telegram ${present('telegram') ? '✓' : '—'}</span>
        <span class="badge bg-secondary me-1">⚙️ appConfig ${c('appConfig') > 0 ? Object.keys(counts.appConfig.data || {}).length + ' fields' : '—'}</span>
        <span class="badge bg-info me-1">📦 positions ${c('positions')} open</span>
        <span class="badge bg-info me-1">🤖 bots ${c('bots')} (${counts.bots && counts.bots.enabled || 0} enabled)</span>
        <span class="badge bg-secondary me-1">🪪 license ${present('license') ? '✓' : '—'}</span>
      </div>
    </div>
    <div id="cfg-backup-status" class="ms-2 small mt-2"></div>
    <div class="text-muted-3 small mt-3">
      🛡️ <strong>Pre-restore safety:</strong> ก่อน restore ทุกครั้ง ระบบจะ snapshot config ปัจจุบันไปยัง <code>data/configbackup-pre-restore-{ISO}.json</code> อัตโนมัติ (Windows-safe path)
      · ถ้า restore ล้มเหลว สามารถกู้คืนจาก snapshot นั้นได้
    </div>
  `);
}

function buildBackupFilename(sections) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tag = (sections && sections.length === 7) ? 'all' : (sections || []).map((s) => s.slice(0, 3)).join('-');
  return `onepct-backup-${tag}-${stamp}.json`;
}

async function openBackupModal() {
  const preview = configBackupPreview || { ok: false, counts: {} };
  const counts = preview.counts || {};
  const sections = ['apiKeys', 'telegram', 'appConfig', 'positions', 'bots', 'license', 'others'];
  const labels = {
    apiKeys: '🔑 apiKeys (Binance API key/secret)',
    telegram: '📨 telegram (token + chatId + events + thresholds)',
    appConfig: '⚙️ appConfig (master toggles + botDefaults + masterConfigTemplates)',
    positions: '📦 positions (open trades only)',
    bots: '🤖 bots (full Bot collection)',
    license: '🪪 license (metadata only — restore skipped)',
    others: '🔮 others (placeholder)',
  };
  const checkboxes = sections.map((s) => {
    const info = counts[s] || {};
    const present = !!info.present;
    const count = info.count != null ? info.count : 0;
    const sz = info.sizeBytes || 0;
    const sizeLabel = sz > 0 ? ` · ${(sz / 1024).toFixed(1)} KB` : '';
    const countLabel = (s === 'bots' || s === 'positions') ? `${count} ${s === 'bots' ? 'บอท' : 'trades'} · ` : '';
    const readonlyNote = (s === 'license') ? ' · restore=skip' : '';
    return `
      <div class="form-check mb-2">
        <input class="form-check-input" type="checkbox" id="cfg-sec-${s}" value="${s}" ${(s === 'license' || s === 'others') ? 'checked' : 'checked'}>
        <label class="form-check-label" for="cfg-sec-${s}">
          <strong>${labels[s]}</strong>
          <span class="text-muted small">· ${present ? `present · ${countLabel}size ${sizeLabel}${sizeLabel}${readonlyNote}` : 'empty'}</span>
        </label>
      </div>`;
  }).join('');

  const html = `
    <div class="mb-3">
      <h6 class="mb-2">📥 เลือก sections ที่จะ backup:</h6>
      ${checkboxes}
    </div>
    <div class="alert alert-info small">
      ระบบจะสร้างไฟล์ <code>.json</code> พร้อม metadata (เวลา, machineId, encryption note) แล้ว download ลงเครื่อง
    </div>
  `;
  // Use AdminModalAlert.confirmHtml — renders innerHTML + OK/Cancel buttons
  const proceed = await AdminModalAlert.confirmHtml({
    title: '📥 Backup Config — เลือก sections',
    html,
    level: 'info',
    okLabel: '📥 Download',
    cancelLabel: 'ยกเลิก',
    wideBox: true,
  });
  if (!proceed) return;
  const selected = sections.filter((s) => document.getElementById(`cfg-sec-${s}`)?.checked);
  if (selected.length === 0) {
    await AdminModalAlert.alert('ต้องเลือกอย่างน้อย 1 section', 'warn');
    return;
  }
  setStatus('cfg-backup-status', '⏳ กำลังสร้าง backup...');
  try {
    const resp = await API.post('/api/admin/config/backup', { sections: selected });
    const payload = resp.payload || resp;
    const filename = buildBackupFilename(selected);
    if (window.botConfigIO && typeof window.botConfigIO.triggerDownload === 'function') {
      window.botConfigIO.triggerDownload(filename, payload);
    } else {
      // fallback: create blob + click
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 100);
    }
    const sizeKB = resp.sizeBytes ? `${(resp.sizeBytes / 1024).toFixed(1)} KB` : `${(JSON.stringify(payload).length / 1024).toFixed(1)} KB`;
    setStatus('cfg-backup-status', `✅ Downloaded ${filename} · ${sizeKB}`);
    await AdminModalAlert.alert(`✅ Backup สำเร็จ!\n\n${filename}\n${sizeKB}\n\nsections: ${selected.join(', ')}`, 'success');
    // reload preview
    configBackupPreview = await API.get('/api/admin/config/backup/preview').catch(() => configBackupPreview);
    render();
  } catch (err) {
    setStatus('cfg-backup-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
    await AdminModalAlert.alert('❌ Backup ล้มเหลว: ' + (err.body && err.body.error ? err.body.error : err.message), 'error');
  }
}

async function openRestoreModal() {
  if (!window.botConfigIO || typeof window.botConfigIO.pickJsonFile !== 'function') {
    await AdminModalAlert.alert('❌ ต้องโหลด botConfigIO.js ก่อน (รีเฟรชหน้านี้)', 'error');
    return;
  }
  const file = await window.botConfigIO.pickJsonFile();
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    await AdminModalAlert.alert(`❌ ไฟล์ใหญ่เกิน 10 MiB (${(file.size / 1024 / 1024).toFixed(2)} MB)`, 'error');
    return;
  }
  // Read + parse
  const text = await file.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch (err) {
    await AdminModalAlert.alert('❌ ไฟล์ไม่ใช่ JSON: ' + err.message, 'error');
    return;
  }
  // Validate
  if (payload.version !== 'onepercentbot-config-backup-1') {
    await AdminModalAlert.alert(`❌ version ไม่ตรงกัน: ${payload.version || 'missing'} (ต้องการ onepercentbot-config-backup-1)`, 'error');
    return;
  }
  const available = Object.keys(payload.sections || {}).filter((k) => payload.sections[k] && payload.sections[k].present !== false);

  // Get diff preview from server
  let diff;
  try {
    diff = await API.post('/api/admin/config/restore/preview', { payload, sections: available });
  } catch (err) {
    await AdminModalAlert.alert('❌ preview ล้มเหลว: ' + (err.body && err.body.error ? err.body.error : err.message), 'error');
    return;
  }

  const sections = ['apiKeys', 'telegram', 'appConfig', 'positions', 'bots', 'license', 'others'].filter((s) => available.includes(s));
  const checkboxes = sections.map((s) => {
    const sec = payload.sections[s] || {};
    const info = diff.sections[s] || {};
    const desc = (s === 'positions') ? `${(sec.data || []).length} trades` :
                 (s === 'bots') ? `${(sec.data || []).length} บอท` :
                 (s === 'license') ? 'metadata only (restore skipped)' :
                 (s === 'others') ? 'placeholder' : 'config fields';
    const diffLabel = (info.willCreate != null) ? `· will create ${info.willCreate}` :
                      (info.fieldsToChange != null) ? `· ${info.fieldsToChange} fields` :
                      (info.willSkip ? `· ${info.willSkip}` : '');
    return `
      <div class="form-check mb-2">
        <input class="form-check-input" type="checkbox" id="cfg-restore-sec-${s}" value="${s}" ${s === 'license' || s === 'others' ? 'disabled' : 'checked'}>
        <label class="form-check-label" for="cfg-restore-sec-${s}">
          <strong>${s}</strong> · ${desc} <span class="text-muted small">${diffLabel}</span>
          ${s === 'license' ? '<span class="badge bg-secondary ms-1">readonly</span>' : ''}
        </label>
      </div>`;
  }).join('');

  const machineWarn = (payload.machineId && payload.encryption && payload.encryption.note) ?
    `<div class="alert alert-warning small mt-2">⚠️ ${escapeHtml(payload.encryption.note)}<br>backup machineId: <code>${escapeHtml(String(payload.machineId).slice(0, 16))}</code>...</div>` : '';

  const html = `
    <div class="mb-3">
      <h6 class="mb-2">📤 Restore sections จาก <code>${escapeHtml(file.name)}</code>:</h6>
      ${checkboxes}
      ${machineWarn}
    </div>
    <div class="mb-3">
      <label class="form-label"><strong>Mode:</strong></label>
      <select class="form-select" id="cfg-restore-mode">
        <option value="merge" selected>Merge — fill empty fields only (safe)</option>
        <option value="replace">Replace — overwrite all fields (irreversible)</option>
      </select>
      <small class="text-muted">Merge แนะนำสำหรับ restore ปกติ · Replace ใช้เมื่อต้องการ overwrite ทั้งหมด</small>
    </div>
    <div class="alert alert-warning small">
      ⚠️ ก่อน restore ระบบจะ snapshot config ปัจจุบันไป <code>data/configbackup-pre-restore-{ISO}.json</code> อัตโนมัติ
    </div>
  `;
  const proceed = await AdminModalAlert.confirmHtml({
    title: '📤 Restore Config — เลือก sections + mode',
    html,
    level: 'warn',
    okLabel: '📤 Restore',
    cancelLabel: 'ยกเลิก',
    wideBox: true,
  });
  if (!proceed) return;
  const selected = sections.filter((s) => {
    const cb = document.getElementById(`cfg-restore-sec-${s}`);
    return cb && cb.checked && !cb.disabled;
  });
  if (selected.length === 0) {
    await AdminModalAlert.alert('ต้องเลือกอย่างน้อย 1 section', 'warn');
    return;
  }
  const mode = document.getElementById('cfg-restore-mode').value;
  setStatus('cfg-backup-status', `⏳ กำลัง restore ${selected.length} sections (mode=${mode})...`);
  try {
    const result = await API.post('/api/admin/config/restore', { payload, sections: selected, mode, dryRun: false });
    const lines = [];
    lines.push(`✅ Restore เสร็จ (mode=${result.mode || mode})`);
    if (result.preRestore && result.preRestore.path) {
      lines.push(`🛡️ pre-restore snapshot: ${result.preRestore.path} (${(result.preRestore.sizeBytes / 1024).toFixed(1)} KB)`);
    }
    const results = result.results || {};
    for (const [name, r] of Object.entries(results)) {
      if (r.error) lines.push(`❌ ${name}: ${r.error}`);
      else if (r.skipped && typeof r.skipped === 'string') lines.push(`⏸ ${name}: ${r.skipped}`);
      else lines.push(`✅ ${name}: changed=${r.changed || 0} created=${r.created || 0} updated=${r.updated || 0} skipped=${r.skipped || 0}`);
    }
    await AdminModalAlert.alert(lines.join('\n'), results && Object.values(results).some((r) => r.error) ? 'warn' : 'success');
    setStatus('cfg-backup-status', `✅ Restore เสร็จ · ${selected.length} sections`);
    await loadConfig();
  } catch (err) {
    setStatus('cfg-backup-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
    await AdminModalAlert.alert('❌ Restore ล้มเหลว: ' + (err.body && err.body.error ? err.body.error : err.message), 'error');
  }
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
  // Phase 4-2026-08-29: Chat display name
  const saveChatName = document.getElementById('btn-save-chat-display-name');
  if (saveChatName) saveChatName.onclick = saveChatDisplayName;
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

  // FIX-2026-08-29: Auto-adjust Auto-pause thresholds
  const sapa = document.getElementById('btn-save-apa');
  if (sapa) sapa.onclick = saveAutoPauseAdjust;
  const tapa = document.getElementById('btn-trigger-apa');
  if (tapa) tapa.onclick = triggerAutoPauseAdjust;

  // FIX-2026-08-30 / Phase 4: Auto-Timing (Save / Run-now / Reset bands)
  if (window.AutoTimingUI && typeof window.AutoTimingUI.bind === 'function') {
    window.AutoTimingUI.bind();
  }

  // FIX-2026-08-29: Config Backup & Restore
  const cbBackup = document.getElementById('cfg-backup-btn');
  if (cbBackup) cbBackup.onclick = openBackupModal;
  const cbRestore = document.getElementById('cfg-restore-btn');
  if (cbRestore) cbRestore.onclick = openRestoreModal;

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

  // FIX-2026-08-26 Phase 3a: Consent + License refresh buttons
  const reloadConsent = document.getElementById('btn-reload-consent');
  if (reloadConsent) reloadConsent.onclick = reloadConsentStatus;
  const refreshLicense = document.getElementById('btn-refresh-license');
  if (refreshLicense) refreshLicense.onclick = refreshLicenseInfo;
}

// FIX-2026-08-26 Phase 3a: reload consent status without full page reload
async function reloadConsentStatus() {
  try {
    consentStatus = await API.get('/api/consent/status');
    setStatus('consent-status', '✓ Refresh แล้ว');
    render();
  } catch (err) {
    setStatus('consent-status', '✗ ' + err.message, true);
  }
}

// FIX-2026-08-26 Phase 3a: trigger /api/license/refresh then re-render
async function refreshLicenseInfo() {
  try {
    setStatus('license-status', '⏳ กำลัง validate...');
    licenseInfo = await API.post('/api/license/refresh', {});
    setStatus('license-status', '✓ License refreshed');
    render();
  } catch (err) {
    setStatus('license-status', '✗ ' + (err.message || 'failed'), true);
  }
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
  const ok = await AdminModalAlert.confirm({
    title: '🗑️ ลบ Telegram Token',
    message: 'ลบ Telegram token และ disable การแจ้งเตือน?',
    level: 'warn',
    okLabel: '✕ ลบ',
  });
  if (!ok) return;
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

// Phase 4-2026-08-29: Chat Display Name loaders
async function loadChatDisplayName() {
  try {
    const r = await API.get('/api/chat/display-name');
    const input = document.getElementById('f-chat-display-name');
    const help = document.getElementById('f-chat-display-name-help');
    if (input) input.value = r.displayName || '';
    if (help) {
      const src = r.displayName ? 'ตั้งเอง' : `fallback: ${r.resolved}`;
      help.textContent = `ปัจจุบัน: "${r.resolved}" (${src})`;
    }
  } catch (err) {
    const help = document.getElementById('f-chat-display-name-help');
    if (help) help.textContent = '❌ ' + err.message;
  }
}

async function saveChatDisplayName() {
  const input = document.getElementById('f-chat-display-name');
  const value = (input && input.value || '').trim();
  const statusEl = document.getElementById('chat-display-name-status');
  if (!value) {
    if (statusEl) statusEl.innerHTML = '<span class="text-danger">❌ กรุณากรอกชื่อ</span>';
    return;
  }
  try {
    const r = await API.put('/api/chat/display-name', { displayName: value });
    if (statusEl) statusEl.innerHTML = '<span class="text-success">✅ บันทึกแล้ว — ข้อความถัดไปจะใช้ชื่อนี้</span>';
    await loadChatDisplayName();
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span class="text-danger">❌ ${escapeHtml(err.message || 'unknown')}</span>`;
  }
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
  const cbMin = parseInt(document.getElementById('th-cbPanicMin').value, 10);
  const thresholds = {
    positionLossPct:   parseFloat(document.getElementById('th-loss').value),
    positionProfitPct: parseFloat(document.getElementById('th-profit').value),
    positionStuckMin:  parseInt(document.getElementById('th-stuck').value, 10),
    bnbLowBalanceUsdt: parseFloat(document.getElementById('th-bnbLow').value),
    // FIX-2026-08-27 Phase 3b-2: custom alert thresholds
    cbPanicMinPositions: cbMin,
    quietHoursEnabled:   document.getElementById('th-quietHoursEnabled').checked,
    quietHoursStart:     document.getElementById('th-quietHoursStart').value || '22:00',
    quietHoursEnd:       document.getElementById('th-quietHoursEnd').value || '07:00',
  };
  if (!Number.isFinite(thresholds.positionLossPct) || !Number.isFinite(thresholds.positionProfitPct) || !Number.isFinite(thresholds.positionStuckMin)) {
    setStatus('thresholds-status', '❌ ค่าต้องเป็นตัวเลข', true);
    return;
  }
  if (!Number.isFinite(thresholds.bnbLowBalanceUsdt) || thresholds.bnbLowBalanceUsdt < 0.05) {
    setStatus('thresholds-status', '❌ BNB low threshold ต้อง ≥ 0.05 USDT', true);
    return;
  }
  if (!Number.isFinite(cbMin) || cbMin < 1 || cbMin > 100 || Math.floor(cbMin) !== cbMin) {
    setStatus('thresholds-status', '❌ CB panic min ต้องเป็นจำนวนเต็ม 1..100', true);
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
    const ok = await AdminModalAlert.confirm({
      title: '⚠️ เปิด Auto-Buy BNB',
      message: '⚠️ จะเปิด Auto-Buy BNB ใช่หรือไม่?\n\n' +
        'ระบบจะ MARKET BUY BNB/USDT ด้วยเงินจริงอัตโนมัติ ' +
        'เมื่อ BNB value < threshold (' + thresholdUsdt + ' USDT)\n\n' +
        'TopUp: ' + topUpUsdt + ' USDT · Interval: ' + checkIntervalMin + ' นาที\n' +
        'Daily cap: ' + maxUsdtPerDay + ' USDT\n\n' +
        'แน่ใจหรือไม่?',
      level: 'warn',
      okLabel: 'เปิด Auto-Buy',
    });
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
  const ok = await AdminModalAlert.confirm({
    title: '⚠️ Manual BNB Buy',
    message: '⚠️ จะสั่งซื้อ BNB/USDT MARKET BUY ทันที?\n\nสำหรับ top-up BNB แบบ manual (bypass enabled flag)\n\n💰 ค่าเงินจริง — แน่ใจหรือไม่?',
    level: 'warn',
    okLabel: '🛒 Buy Now',
  });
  if (!ok) return;
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
    const ok = await AdminModalAlert.confirm({
      title: '⚠️ เปิด Auto Add Bot',
      message: '⚠️ จะเปิด Auto Add New Bot ใช่หรือไม่?\n\n' +
        'ระบบจะสแกน + สร้างบอทใหม่อัตโนมัติทุก ' + intervalMin + ' นาที\n' +
        'Max ' + maxPerRun + ' บอทต่อรอบ · Min %KC > ' + minKcPct + '\n' +
        'Name prefix: ' + namePrefix + ' (เช่น BTC' + namePrefix + ')\n\n' +
        (autoEnable ? '▶️ Auto-enable: ON — บอทที่สร้างจะเริ่มเทรดทันที' : '⏸ Auto-enable: OFF — บอทจะอยู่ในสถานะ DISABLED'),
      level: 'warn',
      okLabel: 'เปิด Auto Add',
    });
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
  const ok = await AdminModalAlert.confirm({
    title: '⚠️ Run Auto Add Bot Now',
    message: '⚠️ จะ Run Auto Add Bot ทันที (bypass enabled flag)?\n\nระบบจะสแกน + filter + create บอทใหม่ทันที\nหรือ restore + activate บอท soft-deleted ที่ symbol ตรงเกณฑ์ (ถ้า Auto-restore เปิดอยู่)\nบอทจะอยู่ในสถานะ DISABLED — ต้องเปิดเอง',
    level: 'warn',
    okLabel: '▶️ Run Now',
  });
  if (!ok) return;
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
          requirePassword: false,
        })
      : await AdminModalAlert.confirm({
          title: '🤖 เปิด Auto Reserve',
          message: `🤖 Auto Reserve จะปรับ USDT Reserve อัตโนมัติทุก ๆ ${checkHours} ชั่วโมง\n\n` +
            `เป้า: ${poleCount} ไม้ × ${usdtPerPole} = ${poleCount * usdtPerPole} USDT\n` +
            `ทุกครั้งจะกั๊ก/ปล่อยครั้งละ ${stepUsdt} USDT\n\n` +
            `⚠️ ถ้าเปิดแล้ว ระบบจะรันทันทีหลังบันทึก\n\nต้องการเปิดหรือไม่?`,
          level: 'warn',
          okLabel: 'เปิด Auto Reserve',
        });
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
          'ระบบจะคำนวณ usable + loss poles แล้วปรับ reserve ทันที',
        confirmLabel: 'รันเลย',
        cancelLabel: 'ยกเลิก',
        requirePassword: false,
      })
    : await AdminModalAlert.confirm({
      title: '🤖 Run Auto Reserve Now',
      message: '🤖 จะรัน Auto Reserve ทันที (bypass checkHours + enabled flag)?\n\nระบบจะคำนวณ usable + loss poles แล้วปรับ reserve ทันที',
      level: 'warn',
      okLabel: '▶️ Run Now',
    });
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
    setStatus('ar-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
  }
}

// ════════ Auto-adjust Auto-pause thresholds (FIX-2026-08-29) ════════
async function saveAutoPauseAdjust() {
  const enabled = !!document.getElementById('apa-enabled').checked;
  const minBots = parseInt(document.getElementById('apa-min').value, 10);
  const maxBots = parseInt(document.getElementById('apa-max').value, 10);
  const intervalMs = parseInt(document.getElementById('apa-interval').value, 10);
  const kcStep = parseFloat(document.getElementById('apa-kcstep').value);
  const volStep = parseFloat(document.getElementById('apa-volstep').value);
  // FIX-2026-08-30: configurable operational clamps (KC % and Vol USDT)
  const kcClampMin = parseFloat(document.getElementById('apa-kc-clamp-min').value);
  const kcClampMax = parseFloat(document.getElementById('apa-kc-clamp-max').value);
  const volClampMin = parseFloat(document.getElementById('apa-vol-clamp-min').value);
  const volClampMax = parseFloat(document.getElementById('apa-vol-clamp-max').value);
  // validate (mirror backend clamp)
  if (!Number.isFinite(minBots) || minBots < 1 || minBots > 1000) { setStatus('apa-status', '❌ minBots ต้องอยู่ระหว่าง 1..1000', true); return; }
  if (!Number.isFinite(maxBots) || maxBots < 1 || maxBots > 1000) { setStatus('apa-status', '❌ maxBots ต้องอยู่ระหว่าง 1..1000', true); return; }
  if (minBots >= maxBots) { setStatus('apa-status', '❌ minBots ต้องน้อยกว่า maxBots', true); return; }
  if (!Number.isFinite(intervalMs) || intervalMs < 60_000 || intervalMs > 24 * 60 * 60 * 1000) { setStatus('apa-status', '❌ intervalMs ต้องอยู่ระหว่าง 60000..86400000', true); return; }
  if (!Number.isFinite(kcStep) || kcStep < 0.01 || kcStep > 5) { setStatus('apa-status', '❌ kcStep ต้องอยู่ระหว่าง 0.01..5', true); return; }
  if (!Number.isFinite(volStep) || volStep < 1000 || volStep > 100_000_000) { setStatus('apa-status', '❌ volStep ต้องอยู่ระหว่าง 1000..100000000', true); return; }
  // FIX-2026-08-30: clamps validation (mirrors backend clamp)
  if (!Number.isFinite(kcClampMin) || kcClampMin < 0.1 || kcClampMin > 50) { setStatus('apa-status', '❌ kcClampMin ต้องอยู่ระหว่าง 0.1..50', true); return; }
  if (!Number.isFinite(kcClampMax) || kcClampMax < 0.1 || kcClampMax > 50) { setStatus('apa-status', '❌ kcClampMax ต้องอยู่ระหว่าง 0.1..50', true); return; }
  if (kcClampMin >= kcClampMax) { setStatus('apa-status', '❌ kcClampMin ต้องน้อยกว่า kcClampMax', true); return; }
  if (!Number.isFinite(volClampMin) || volClampMin < 0 || volClampMin > 1_000_000_000) { setStatus('apa-status', '❌ volClampMin ต้องอยู่ระหว่าง 0..1000000000', true); return; }
  if (!Number.isFinite(volClampMax) || volClampMax < 0 || volClampMax > 1_000_000_000) { setStatus('apa-status', '❌ volClampMax ต้องอยู่ระหว่าง 0..1000000000', true); return; }
  if (volClampMin >= volClampMax) { setStatus('apa-status', '❌ volClampMin ต้องน้อยกว่า volClampMax', true); return; }
  try {
    const resp = await API.put('/api/admin/auto-pause-adjust', {
      enabled, minBots, maxBots, intervalMs, kcStep, volStep,
      kcClampMin, kcClampMax, volClampMin, volClampMax,
    });
    setStatus('apa-status', '✅ บันทึกแล้ว · scheduler ' + (enabled ? '▶️ running' : '⏹ stopped') + ' (reloadConfig applied)');
    await loadConfig();
  } catch (err) {
    setStatus('apa-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
  }
}

async function triggerAutoPauseAdjust() {
  const proceed = window.LUX_CONFIRM
    ? await window.LUX_CONFIRM({
        title: 'Run Auto-adjust ทันที',
        message:
          '🔧 จะรัน Auto-adjust Auto-pause thresholds ทันที (bypass intervalMs)\n\n' +
          'ระบบจะนับ running bots แล้วปรับ Min-%KC/Min-Vol thresholds ของบอทที่ autoPauseAdjustEnabled=true ทันที',
        confirmLabel: 'รันเลย',
        cancelLabel: 'ยกเลิก',
        requirePassword: false,
      })
    : await AdminModalAlert.confirm({
      title: '🔧 Run Auto-adjust Now',
      message: '🔧 จะรัน Auto-adjust Auto-pause thresholds ทันที (bypass intervalMs)?\n\nระบบจะนับ running bots แล้วปรับ Min-%KC/Min-Vol thresholds ของบอทที่ autoPauseAdjustEnabled=true ทันที',
      level: 'warn',
      okLabel: '▶️ Run Now',
    });
  if (!proceed) return;
  setStatus('apa-status', '⏳ กำลังรัน...');
  try {
    const resp = await API.post('/api/admin/auto-pause-adjust/run-now', {});
    const s = (resp && resp.stats) || {};
    const c = (resp && resp.counts) || {};
    const b = (resp && resp.bounds) || {};
    // FIX-2026-08-29: build a prominent modal summary so user clearly sees whether
    // the system did work even when no bots were updated (e.g. running already in-range).
    const lines = [];
    lines.push(`📊 running = ${s.runningBots ?? c.runningBots ?? '?'} (eligible=${c.eligibleBots ?? '?'}, opted-out=${c.optedOutBots ?? '?'})`);
    if (b.kcMin != null) lines.push(`📏 bounds: KC [${b.kcMin}, ${b.kcMax}]% · Vol [${b.volMin?.toLocaleString()}, ${b.volMax?.toLocaleString()}] USDT`);
    if (s.outcome === 'failed_apply') {
      lines.push(`❌ apply failed: ${s.error || 'unknown'}`);
    } else if (s.skipped) {
      lines.push(`⏸ skipped: ${s.skipped}${s.skipped === 'license-disabled' ? ' (ต้องเปิด autoPauseMinKc feature ใน license)' : ''}`);
    } else if (s.action === 'tighten') {
      lines.push(`🔺 TIGHTEN · running ${s.runningBots} > max ${s.maxBots}`);
      lines.push(`Δ kc = +${s.deltaKc}% · Δ vol = +${(s.deltaVol || 0).toLocaleString()} USDT`);
      lines.push(`✅ updated ${s.updatedBots} bot(s)${s.skippedClamped ? ` · skipped-clamped ${s.skippedClamped}` : ''}`);
    } else if (s.action === 'loosen') {
      lines.push(`🔻 LOOSEN · running ${s.runningBots} < min ${s.minBots}`);
      lines.push(`Δ kc = ${s.deltaKc}% · Δ vol = ${(s.deltaVol || 0).toLocaleString()} USDT`);
      lines.push(`✅ updated ${s.updatedBots} bot(s)${s.skippedClamped ? ` · skipped-clamped ${s.skippedClamped}` : ''}`);
      if ((s.updatedBots || 0) === 0) {
        lines.push(`💡 0 bot updated — eligible bots อาจอยู่ที่ KC=${b.kcMin}% / Vol=${b.volMin?.toLocaleString()} bounds แล้ว (ลองลด minBots/maxBots หรือ loosen steps)`);
      }
    } else {
      lines.push(`ℹ️ no action — running ${s.runningBots ?? '?'} ∈ [${s.minBots ?? '?'}, ${s.maxBots ?? '?'}]`);
      lines.push(`💡 ถ้าอยากเห็นการเปลี่ยนแปลง: ลด minBots ให้น้อยกว่า running (→ LOOSEN) หรือเพิ่ม maxBots ให้น้อยกว่า running (→ TIGHTEN)`);
    }
    const level = (s.outcome === 'failed_apply' || s.error) ? 'error'
      : (s.skipped ? 'warn' : (s.updatedBots > 0 ? 'success' : 'info'));
    await AdminModalAlert.alert(lines.join('\n'), level);
    setStatus('apa-status', lines[0] + (lines[1] ? ' — ' + lines[1] : ''));
    await loadConfig();
  } catch (err) {
    setStatus('apa-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
    await AdminModalAlert.alert('❌ Run now failed: ' + (err.body && err.body.error ? err.body.error : err.message), 'error');
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
  const cooldown  = int('dps-cooldown');

  if (!Number.isFinite(minSize) || minSize < 5 || minSize > 10000) { setStatus('dps-status', '❌ Min size ต้องอยู่ระหว่าง 5..10000', true); return; }
  if (!Number.isFinite(maxSize) || maxSize < 5 || maxSize > 10000) { setStatus('dps-status', '❌ Max size ต้องอยู่ระหว่าง 5..10000', true); return; }
  if (minSize > maxSize) { setStatus('dps-status', '❌ Min size ต้องไม่เกิน Max size', true); return; }
  // FIX-2026-09-03: layer-removal — minLayers/maxLayers validations dropped (DPS only auto-tunes size)
  if (!Number.isFinite(cooldown) || cooldown < 0 || cooldown > 1440) { setStatus('dps-status', '❌ Cooldown ต้องอยู่ระหว่าง 0..1440', true); return; }

  const r1Count    = int('dps-r1-count');
  const r1DSize    = num('dps-r1-dsize');
  const r2Count    = int('dps-r2-count');
  const r2Pct      = num('dps-r2-pct');
  const r2DSize    = num('dps-r2-dsize');
  const r3Count    = int('dps-r3-count');
  const r3DSize    = num('dps-r3-dsize');
  if (![r1Count, r2Count, r3Count].every((v) => Number.isFinite(v) && v >= 1 && v <= 20)) { setStatus('dps-status', '❌ จำนวนไม้ (count) ต้องอยู่ระหว่าง 1..20', true); return; }
  if (!Number.isFinite(r2Pct) || r2Pct < 0.1 || r2Pct > 100) { setStatus('dps-status', '❌ % กำไรขั้นต่ำต่อไม้ ต้องอยู่ระหว่าง 0.1..100', true); return; }
  // FIX-2026-09-03: layer-removal — r*DLayers validations dropped (only size deltas remain)
  for (const [name, v] of [['r1DSize', r1DSize], ['r2DSize', r2DSize], ['r3DSize', r3DSize]]) {
    if (!Number.isFinite(v)) { setStatus('dps-status', `❌ ${name} ต้องเป็นตัวเลข`, true); return; }
  }

  const payload = {
    dpsMinSize: minSize, dpsMaxSize: maxSize,
    dpsCooldownMinutes: cooldown,
    dpsWinStreakCount: r1Count, dpsWinStreakDeltaSize: r1DSize,
    dpsBigWinCount: r2Count, dpsBigWinPct: r2Pct, dpsBigWinDeltaSize: r2DSize,
    dpsLossStreakCount: r3Count, dpsLossDeltaSize: r3DSize,
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
  const ok = await AdminModalAlert.confirm({
    title: '🔄 เคลียร์ DPS State',
    message: 'เคลียร์ DPS state ทุกบอท?\n\n(ระบบจะ reset state และ re-evaluate ใหม่ในรอบถัดไป)',
    level: 'warn',
    okLabel: '🔄 Reset',
  });
  if (!ok) return;
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
  // FIX-2026-09-04: align with round-4 directive — CB family default OFF (was true, caused invisible divergence)
  cbv2Enabled: false,
  cbv2LockHours: 8,
  cbv3Enabled: false,
  cbv3LockHours: 8,
  // FIX-2026-09-03: CBv5 opt-in (was true) — see src/services/tierTemplates.js
  cbv5Enabled: false,
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
  autoPauseAdjustEnabled: true, // FIX-2026-08-29: per-bot opt-in for auto-adjust (default ON)
  autoArmStopLossOnUKC: true,
  autoArmLossPct: 6.3,
  autoArmAgeHours: 4,
  slUkcTriggerOnProfit: false,
  tpTrendEnabled: true,
  tpTrendMultiplier: 2,
  autoUpdateTp: true,
  stopLossOnUpperKC: false,
  // FIX-2026-09-02: Round-down Capital (opt-in per-bot — default OFF, min 5.5 USDT)
  roundDownCapitalEnabled: false,
  roundDownCapitalMin: 5.5,
};

async function saveBotDefaults() {
  const el = (id) => document.getElementById(id);
  const num = (id) => parseFloat(el(id).value);
  const int = (id) => parseInt(el(id).value, 10);
  const str = (id) => (el(id).value || '').trim();
  const isChecked = (id) => el(id) ? el(id).checked : false;
  // FIX-2026-08-30: tristate helper for autoTimingEnabled (inherit/true/false)
  const tristate = (id) => {
    const v = el(id) ? el(id).value : 'inherit';
    return v === 'true' ? true : v === 'false' ? false : null;
  };

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
    // FIX-2026-08-30: Auto-Timing per-bot tristate (inherit/force-on/force-off)
    autoTimingEnabled: tristate('bd-auto-timing-enabled'),
    autoPauseAdjustEnabled: isChecked('bd-auto-pause-adjust-enabled'), // FIX-2026-08-29: per-bot opt-in for auto-adjust (mirror botDefaults)
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
    // FIX-2026-09-02: Round-down Capital (opt-in per-bot)
    roundDownCapitalEnabled: isChecked('bd-round-down-capital-enabled'),
    roundDownCapitalMin: num('bd-round-down-capital-min'),
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
  // FIX-2026-09-02: Round-down min notional threshold (USDT, 1..10000)
  if (!Number.isFinite(payload.roundDownCapitalMin) || payload.roundDownCapitalMin < 1 || payload.roundDownCapitalMin > 10000) errors.push('Round-down min 1..10000');
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
  const ok = await AdminModalAlert.confirm({
    title: '↩️ Reset Bot Defaults',
    message: '↩️ Reset Bot Defaults เป็นค่าแนะนำ (recommended)?\n\nค่าที่ตั้งไว้จะถูกเขียนทับด้วยค่า default',
    level: 'warn',
    okLabel: '↩️ Reset',
  });
  if (!ok) return;
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
  if (mode === 'replace' && !(await AdminModalAlert.confirm({
    title: '📥 Import Bot Defaults',
    message: 'Import จะทับค่า Bot Defaults ทั้งหมด — แน่ใจมั้ย?',
    level: 'warn',
    okLabel: '📥 Replace All',
  }))) return;
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