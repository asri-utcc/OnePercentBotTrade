'use strict';

// FIX-2026-07-24: Settings page (Telegram config)
//   - 3 sections: Connection / Events / Thresholds / Master switch
//   - ใช้ form-check pattern จาก public/js/pages/bot-edit.js (เหมือน stopLoss/autoUpdateTp)
//   - reload on every PUT/DELETE เพราะ backend เรียก notifier.reloadConfig() ให้แล้ว

let cfg = null; // cached config
let bnbCfg = null; // FIX-2026-08-05: auto-buy BNB config
let dailyTarget = null; // 2026-08-06: daily target gauge config
let autoAddBotCfg = null; // FIX-2026-08-07: auto add new bot config
let adminCfg = null; // FIX-2026-08-08 (rev2): DPS tunables (PUT /api/admin/app-config)

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
    // FIX-2026-08-05: load auto-buy BNB config (แยก endpoint, ไม่กระทบโหลดครั้งแรกถ้า fail)
    try {
      bnbCfg = await API.get('/api/bnb-auto-buy/config');
    } catch (err) {
      console.warn('auto-buy BNB config load failed:', err.message);
      // FIX-2026-08-05: include gaugeTargetUsdt in fallback
      bnbCfg = { enabled: false, topUpUsdt: 5.5, thresholdUsdt: 0.5, checkIntervalMin: 60, cooldownMin: 30, maxUsdtPerDay: 50, gaugeTargetUsdt: 10, status: {} };
    }
    // 2026-08-06: daily target gauge config (แยก endpoint เพื่อให้ fail-open ได้)
    try {
      dailyTarget = await API.get('/api/daily-target');
    } catch (err) {
      console.warn('daily-target config load failed:', err.message);
      dailyTarget = { targetThb: 100 };
    }
    // FIX-2026-08-07: Auto Add New Bot config (full form in section 7️⃣)
    try {
      autoAddBotCfg = await API.get('/api/auto-add-bot/config');
    } catch (err) {
      console.warn('auto-add-bot config load failed:', err.message);
      autoAddBotCfg = {
        enabled: false, intervalMin: 60, minKcPct: 2, maxPerRun: 5,
        scanTimeframe: '3m', scanThreshold: 0.5, scanWindow: 500, scanTpWindow: 30,
        scanTopN: 100, scanMinVol: 1_000_000, scanMinPct: 0.30,
        scanTrends: ['uptrend', 'downtrend', 'sideways'], telegramNotify: true,
        autoEnable: true, // FIX-2026-08-07: auto-enable บอทที่เพิ่งสร้าง
        namePrefix: '(bAdd)', // 2026-08-08: editable prefix
        status: {},
      };
    }
    // FIX-2026-08-08 (rev2): DPS tunables (admin/app-config) — fail-open default ใช้ DEFAULTS ของ engine
    try {
      adminCfg = await API.get('/api/admin/app-config');
    } catch (err) {
      console.warn('admin app-config load failed:', err.message);
      adminCfg = { config: {} };
    }
    render();
  } catch (err) {
    document.getElementById('settings-content').innerHTML =
      `<div class="lux-body"><div class="alert alert-danger">โหลด config ล้มเหลว: ${escapeHtml(err.message)}</div></div>`;
  }
}

function render() {
  const ev = cfg.events || {};
  const th = cfg.thresholds || {};
  const qth = cfg.qualityThresholds || {};
  const qEnabled = cfg.qualityEnabled !== false; // default true
  const qRefreshMin = Math.round((Number.isFinite(cfg.qualityRefreshMs) ? cfg.qualityRefreshMs : 5 * 60 * 1000) / 60000);
  // FIX-2026-08-05: bnbCfg defaults (กัน null/undefined)
  bnbCfg = bnbCfg || { enabled: false, topUpUsdt: 5.5, thresholdUsdt: 0.5, checkIntervalMin: 60, cooldownMin: 30, maxUsdtPerDay: 50, gaugeTargetUsdt: 10, status: {} };
  // FIX-2026-08-07: autoAddBotCfg defaults (กัน null/undefined)
  autoAddBotCfg = autoAddBotCfg || {
    enabled: false, intervalMin: 60, minKcPct: 2, maxPerRun: 5,
    scanTimeframe: '3m', scanThreshold: 0.5, scanWindow: 500, scanTpWindow: 30,
    scanTopN: 100, scanMinVol: 1_000_000, scanMinPct: 0.30,
    scanTrends: ['uptrend', 'downtrend', 'sideways'], telegramNotify: true,
    autoEnable: true, namePrefix: '(bAdd)', status: {},
  };
  const aabStatus = autoAddBotCfg.status || {};
  const aabLastRunAt = aabStatus.lastRunAt ? new Date(aabStatus.lastRunAt).toLocaleString() : '—';
  const aabTickCount = aabStatus.tickCount != null ? aabStatus.tickCount : 0;
  const aabInFlight = aabStatus.inFlight ? '⏳ in-flight' : '';
  const aabTrends = autoAddBotCfg.scanTrends || ['uptrend', 'downtrend', 'sideways'];
  const aabLastStats = aabStatus.lastStats || null;
  // FIX-2026-08-08 (rev2): DPS tunables — ดึงจาก adminCfg (PUT /api/admin/app-config)
  //   - default ตรงกับ DEFAULTS ใน src/core/dynamicPositionSizing.js
  adminCfg = adminCfg || { config: {} };
  const dcfg = adminCfg.config || {};
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
    dpsRespectBotCapital:  dcfg.dpsRespectBotCapital  !== false, // default true
    dpsResetHistoryOnFire: dcfg.dpsResetHistoryOnFire !== false, // default true
    dpsDryRun:             dcfg.dpsDryRun === true,             // default false
  };
  // live preview ของกฎ (อัพเดตทุกครั้งที่ user แก้ค่า)
  const dpsPreview = () => {
    const r1 = `ชนะติด ${dps.dpsWinStreakCount} ไม้ → Δsize ${dps.dpsWinStreakDeltaSize >= 0 ? '+' : ''}${dps.dpsWinStreakDeltaSize}, Δlayers ${dps.dpsWinStreakDeltaLayers >= 0 ? '+' : ''}${dps.dpsWinStreakDeltaLayers}`;
    const r2 = `${dps.dpsBigWinCount} ไม้ล่าสุดกำไร ≥ ${dps.dpsBigWinPct}% ทุกไม้ → Δsize ${dps.dpsBigWinDeltaSize >= 0 ? '+' : ''}${dps.dpsBigWinDeltaSize}, Δlayers ${dps.dpsBigWinDeltaLayers >= 0 ? '+' : ''}${dps.dpsBigWinDeltaLayers}`;
    const r3 = `แพ้ติด ${dps.dpsLossStreakCount} ไม้ → Δsize ${dps.dpsLossDeltaSize >= 0 ? '+' : ''}${dps.dpsLossDeltaSize}, Δlayers ${dps.dpsLossDeltaLayers >= 0 ? '+' : ''}${dps.dpsLossDeltaLayers}`;
    const band = `Size: ${dps.dpsMinSize}..${dps.dpsMaxSize} USDT · Layers: ${dps.dpsMinLayers}..${dps.dpsMaxLayers} · Cooldown ${dps.dpsCooldownMinutes} นาที`;
    return { r1, r2, r3, band };
  };
  const dpsPrev = dpsPreview();
  const status = cfg.hasToken && cfg.chatId
    ? (cfg.enabled ? '🟢 live' : '🟡 token only')
    : '⚪ not configured';

  const html = `
    <div class="lux-header">
      <span class="title">📡 Telegram notifications</span>
      <span class="text-muted-3" style="font-size:0.85rem;">สถานะ: ${status}</span>
    </div>
    <div class="lux-body">

      <!-- ── Connection ─────────────────────────── -->
      <h6 class="text-muted-3 mb-3 mt-2">1️⃣ การเชื่อมต่อ</h6>

      <div class="mb-3">
        <label class="form-label">🤖 Bot Token <span class="text-muted">(จาก @BotFather; เก็บแบบ encrypted)</span></label>
        <div class="input-group">
          <input type="password" class="form-control" id="f-token" placeholder="${cfg.hasToken ? '•••••• (token ถูกตั้งไว้แล้ว — พิมพ์ใหม่เพื่อเปลี่ยน)' : 'เช่น 7123456789:AAH...token...'}" autocomplete="off" />
          <button type="button" class="btn btn-primary" id="btn-set-token">🔑 ตั้ง Token</button>
          <button type="button" class="btn btn-outline-danger" id="btn-clear-token" ${cfg.hasToken ? '' : 'disabled'}>🗑 ลบ Token</button>
        </div>
        <small class="text-muted">รูปแบบ: <code>&lt;bot_id&gt;:&lt;35+ chars&gt;</code> · ถ้าใส่ token ผิด จะ fail ที่ /test</small>
      </div>

      <div class="mb-3">
        <label class="form-label">💬 Chat ID <span class="text-muted">(ของคุณ หรือ group; ไม่ต้องเป็น secret)</span></label>
        <div class="input-group">
          <input type="text" class="form-control" id="f-chat-id" value="${escapeHtml(cfg.chatId || '')}" placeholder="เช่น 123456789 หรือ -100xxxxxxxx" />
          <button type="button" class="btn btn-primary" id="btn-save-chat">💾 บันทึก Chat ID</button>
        </div>
        <small class="text-muted">วิธีหา: ส่ง <code>/start</code> ให้บอท แล้วเรียก <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code></small>
      </div>

      <div class="mb-3">
        <button type="button" class="btn btn-outline-primary" id="btn-test">📨 ส่งข้อความทดสอบ</button>
        <span class="ms-2 text-muted small" id="test-status"></span>
      </div>

      <!-- ── Master switch ──────────────────────── -->
      <div class="mb-4 mt-3">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="f-enabled" ${cfg.enabled ? 'checked' : ''} />
          <span class="form-check-label"><strong>เปิดใช้งาน Telegram</strong> — ถ้าปิดจะไม่ส่งข้อความใดๆ (config ยังอยู่)</span>
        </label>
      </div>

      <hr />

      <!-- ── Events ────────────────────────────── -->
      <h6 class="text-muted-3 mb-3">2️⃣ เลือก Event ที่จะแจ้งเตือน</h6>

      <div class="row g-3">
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-buyFilled" ${ev.buyFilled ? 'checked' : ''} />
            <span class="form-check-label">🟢 <strong>BUY filled</strong> <small class="text-muted d-block">บอทซื้อสำเร็จ (state=holding)</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-sellFilled" ${ev.sellFilled ? 'checked' : ''} />
            <span class="form-check-label">💰 <strong>SELL filled</strong> <small class="text-muted d-block">บอทขายสำเร็จ พร้อม P&L</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-insufficientBalance" ${ev.insufficientBalance ? 'checked' : ''} />
            <span class="form-check-label">⚠️ <strong>เงินหมด</strong> <small class="text-muted d-block">USDT ไม่พอสำหรับเทรด</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-botEnabled" ${ev.botEnabled ? 'checked' : ''} />
            <span class="form-check-label">▶️ <strong>เปิดบอท</strong> <small class="text-muted d-block">บอทถูก enable</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-botDisabled" ${ev.botDisabled ? 'checked' : ''} />
            <span class="form-check-label">⏸ <strong>ปิดบอท</strong> <small class="text-muted d-block">บอทถูก disable</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-botDeleted" ${ev.botDeleted ? 'checked' : ''} />
            <span class="form-check-label">🗑 <strong>ลบบอท</strong> <small class="text-muted d-block">บอทถูกลบออกจากระบบ</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-positionLoss" ${ev.positionLoss ? 'checked' : ''} />
            <span class="form-check-label">🔻 <strong>Position loss</strong> <small class="text-muted d-block">ขาดทุนเกิน threshold (ดู #3)</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-positionProfit" ${ev.positionProfit ? 'checked' : ''} />
            <span class="form-check-label">🔺 <strong>Position profit</strong> <small class="text-muted d-block">กำไรเกิน threshold</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-positionStuck" ${ev.positionStuck ? 'checked' : ''} />
            <span class="form-check-label">⏳ <strong>Position stuck</strong> <small class="text-muted d-block">เปิด position นานเกิน threshold</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-dailySummary" ${ev.dailySummary !== false ? 'checked' : ''} />
            <span class="form-check-label">📅 <strong>สรุปรายวัน</strong> <small class="text-muted d-block">ส่งที่ 00:05 ของวันถัดไป</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-weeklySummary" ${ev.weeklySummary !== false ? 'checked' : ''} />
            <span class="form-check-label">📆 <strong>สรุปรายสัปดาห์</strong> <small class="text-muted d-block">ส่งที่จันทร์ 00:05 ของสัปดาห์ถัดไป</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-monthlySummary" ${ev.monthlySummary !== false ? 'checked' : ''} />
            <span class="form-check-label">🗓 <strong>สรุปรายเดือน</strong> <small class="text-muted d-block">ส่งที่วันที่ 1 00:05 ของเดือนถัดไป</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-tpLowPnL" ${ev.tpLowPnL !== false ? 'checked' : ''} />
            <span class="form-check-label">⚠️ <strong>TP ต่ำเกินไป</strong> <small class="text-muted d-block">NET TP &lt; 0.2% (เฉพาะบอทที่เปิด autoUpdateTp)</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-cbPanicClose" ${ev.cbPanicClose !== false ? 'checked' : ''} />
            <span class="form-check-label">🚨 <strong>Circuit-breaker panic-sell</strong> <small class="text-muted d-block">3 แท่งติด red + below lowerKC → panic-close ALL positions</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-cbv2PanicClose" ${ev.cbv2PanicClose !== false ? 'checked' : ''} />
            <span class="form-check-label">💎 <strong>CBv2 sustained panic-sell</strong> <small class="text-muted d-block">4 แท่งติด red + below lowerKC → panic-close + cooldown BUY cbv2LockHours hours (HYBRID: บอทยัง enable)</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-botLocked" ${ev.botLocked !== false ? 'checked' : ''} />
            <span class="form-check-label">⏸ <strong>Bot cooldown (CBv2)</strong> <small class="text-muted d-block">บอทถูกบังคับ cooldown S1 BUY จาก CBv2 (HYBRID: บอทยัง enable, Auto-pause ยังทำงานแยก)</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-cbv3PanicClose" ${ev.cbv3PanicClose !== false ? 'checked' : ''} />
            <span class="form-check-label">💎 <strong>CBv3 panic-sell (CBv2 + ST3)</strong> <small class="text-muted d-block">4 แท่งติด red + ST3 no-trade บน upper-TF → panic-close + cooldown BUY (Feature #2, default v3)</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-dpsResize" ${ev.dpsResize !== false ? 'checked' : ''} />
            <span class="form-check-label">📊 <strong>DPS resize</strong> <small class="text-muted d-block">แจ้งเมื่อ size/layers เปลี่ยนจริง — มี reason + before/after (Feature #1)</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-botAutoUnlocked" ${ev.botAutoUnlocked !== false ? 'checked' : ''} />
            <span class="form-check-label">🔓 <strong>CB Auto-unlock</strong> <small class="text-muted d-block">Cooldown ปลดอัตโนมัติ (3+ profitable signals) — Feature #3</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-autoDeleteBotWarning" ${ev.autoDeleteBotWarning !== false ? 'checked' : ''} />
            <span class="form-check-label">⏰ <strong>Auto Delete — แจ้งล่วงหน้า</strong> <small class="text-muted d-block">แจ้งก่อน soft-delete (Feature #5)</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-autoDeleteBotRemoved" ${ev.autoDeleteBotRemoved !== false ? 'checked' : ''} />
            <span class="form-check-label">🗑 <strong>Auto Delete — soft-deleted</strong> <small class="text-muted d-block">แจ้งเมื่อบอทถูก soft-delete (restore ได้ 30 วัน)</small></span>
          </label>
        </div>
        <div class="col-md-6">
          <label class="form-check">
            <input type="checkbox" class="form-check-input" id="ev-bnbLowBalance" ${ev.bnbLowBalance !== false ? 'checked' : ''} />
            <span class="form-check-label">💎 <strong>BNB balance ต่ำ</strong> <small class="text-muted d-block">BNB value &lt; threshold (แจ้งเติม BNB ก่อน fee ถูกหักจาก base)</small></span>
          </label>
        </div>
      </div>

      <div class="mt-3">
        <button type="button" class="btn btn-primary" id="btn-save-events">💾 บันทึก Events</button>
        <span class="ms-2 text-muted small" id="events-status"></span>
      </div>

      <hr />

      <!-- ── Thresholds ─────────────────────────── -->
      <h6 class="text-muted-3 mb-3">3️⃣ Threshold (สำหรับ position events)</h6>

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
          <small class="text-muted">เช่น <code>0.5</code> = แจ้งเมื่อ BNB value &lt; $0.50 (banner ที่ /bots.html ใช้ $1 คงที่)</small>
        </div>
      </div>

      <div class="mt-3">
        <button type="button" class="btn btn-primary" id="btn-save-thresholds">💾 บันทึก Thresholds</button>
        <span class="ms-2 text-muted small" id="thresholds-status"></span>
      </div>

      <div class="text-muted small mt-4">
        <strong>หมายเหตุ:</strong> ระบบจะสแกน open positions ทุก 30s (PnL) และ 60s (stuck); การแจ้งจะเกิดตอน <em>crossing</em> เข้า threshold เท่านั้น (ไม่ spam) — และ stuck จะแจ้งครั้งเดียวต่อ trade
      </div>

      <hr />

      <!-- ── FIX-2026-08-01: Bot Quality Indicator ────── -->
      <h6 class="text-muted-3 mb-3">4️⃣ 🎯 Quality Indicator <small class="text-muted-3">(0–4 per bot, click pill to drill down)</small></h6>

      <div class="mb-3">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="q-enabled" ${qEnabled ? 'checked' : ''} />
          <span class="form-check-label"><strong>เปิด Quality Indicator</strong> — ถ้าปิดจะไม่คำนวณ score ใดๆ (cache clears)</span>
        </label>
      </div>

      <div class="row g-3">
        <div class="col-md-6">
          <label class="form-label">💰 Volume threshold (USDT)</label>
          <input type="number" class="form-control" id="q-vol" value="${qth.volumeMinUSDT != null ? qth.volumeMinUSDT : 100000}" step="1000" min="0" />
          <small class="text-muted">24h quote volume ≥ ค่านี้ถึงจะ pass</small>
        </div>
        <div class="col-md-6">
          <label class="form-label">🏆 Top-N size</label>
          <input type="number" class="form-control" id="q-topn" value="${qth.topN != null ? qth.topN : 50}" step="1" min="1" max="500" />
          <small class="text-muted">top-N symbols by 24h quote volume</small>
        </div>
        <div class="col-md-4">
          <label class="form-label">📏 KC tight % (&lt; = tight)</label>
          <input type="number" class="form-control" id="q-kc" value="${qth.kcTightPct != null ? qth.kcTightPct : 1.0}" step="0.1" min="0.01" max="50" />
        </div>
        <div class="col-md-4">
          <label class="form-label">💧 Squeeze min % (≥ pass)</label>
          <input type="number" class="form-control" id="q-sq" value="${qth.squeezeMinPct != null ? qth.squeezeMinPct : 40}" step="1" min="0" max="100" />
          <small class="text-muted">% ของ 50 แท่งที่ KC &lt; tight</small>
        </div>
        <div class="col-md-4">
          <label class="form-label">📈 Trend min % (≥ pass)</label>
          <input type="number" class="form-control" id="q-tr" value="${qth.trendMinPct != null ? qth.trendMinPct : 50}" step="1" min="0" max="100" />
          <small class="text-muted">% ของ bars เหนือ EMA20 บน upper-TF</small>
        </div>
        <div class="col-md-4">
          <label class="form-label">🔄 Refresh interval (นาที)</label>
          <input type="number" class="form-control" id="q-refresh" value="${qRefreshMin}" step="1" min="1" max="60" />
          <small class="text-muted">default 5 นาที (60s..1h clamp)</small>
        </div>
      </div>

      <div class="mt-3">
        <button type="button" class="btn btn-primary" id="btn-save-quality">💾 บันทึก Quality Indicator</button>
        <span class="ms-2 text-muted small" id="quality-status"></span>
      </div>

      <div class="text-muted small mt-4">
        <strong>สูตรคะแนน:</strong> Volume (≥) + Top50 (≤N) + Squeeze (% ≥) + Trend (upper-TF + EMA20%) → 0–4
        <br />สี: <span class="quality-pill is-red">0</span>
        <span class="quality-pill is-orange">1</span>
        <span class="quality-pill is-yellow">2</span>
        <span class="quality-pill is-green">3–4</span>
      </div>

      <hr />

      <!-- ── FIX-2026-08-05: Auto-Buy BNB ──────────────────────────────── -->
      <h6 class="text-muted-3 mb-3">5️⃣ 💎 Auto-Buy BNB <small class="text-muted-3">(MARKET BUY BNB/USDT อัตโนมัติเมื่อ BNB value &lt; threshold)</small></h6>

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
          <small class="text-muted">จำนวน USDT ต่อการซื้อแต่ละครั้ง (≥ 5 USDT ตาม BNB minNotional)</small>
        </div>
        <div class="col-md-4">
          <label class="form-label">⚠️ Trigger threshold (USDT)</label>
          <input type="number" class="form-control" id="bnb-threshold" value="${bnbCfg.thresholdUsdt}" step="0.05" min="0.1" max="100" />
          <small class="text-muted">ซื้อเมื่อ BNB value &lt; ค่านี้</small>
        </div>
        <div class="col-md-4">
          <label class="form-label">⏱ Check interval (นาที)</label>
          <input type="number" class="form-control" id="bnb-interval" value="${bnbCfg.checkIntervalMin}" step="5" min="5" max="1440" />
          <small class="text-muted">ความถี่ในการตรวจ (default 60 = 1 ชม.)</small>
        </div>
        <div class="col-md-4">
          <label class="form-label">🛑 Cooldown (นาที)</label>
          <input type="number" class="form-control" id="bnb-cooldown" value="${bnbCfg.cooldownMin}" step="5" min="0" max="1440" />
          <small class="text-muted">เวลารอขั้นต่ำระหว่างการซื้อ (กัน burst)</small>
        </div>
        <div class="col-md-4">
          <label class="form-label">📊 Daily cap (USDT)</label>
          <input type="number" class="form-control" id="bnb-dailycap" value="${bnbCfg.maxUsdtPerDay}" step="5" min="0" max="10000" />
          <small class="text-muted">เพดานการใช้จ่าย USDT ต่อวัน (กัน runaway)</small>
        </div>
        <div class="col-md-4">
          <label class="form-label">💎 Gauge target (USDT)</label>
          <input type="number" class="form-control" id="bnb-gauge-target" value="${bnbCfg.gaugeTargetUsdt ?? 10}" step="1" min="1" max="100" />
          <small class="text-muted">เป้าหมาย 100% ของ fuel gauge (default 10 USDT)</small>
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
        <br /><strong>Audit log:</strong> <a href="/api/bnb-auto-buy/logs" target="_blank">GET /api/bnb-auto-buy/logs</a> (50 รายการล่าสุด)
      </div>

      <hr />

      <!-- ── 2026-08-06: Daily Profit Target gauge (radial arc below navbar) ── -->
      <h6 class="text-muted-3 mb-3">6️⃣ 🎯 Daily Profit Target <small class="text-muted-3">(เกจเป้ากำไรรายวันใต้ navbar · หน่วย THB)</small></h6>

      <div class="row g-3">
        <div class="col-md-6">
          <label class="form-label">🎯 เป้าหมาย THB ต่อวัน <span class="text-muted">(default 100)</span></label>
          <input type="number" class="form-control" id="dt-target" value="${Math.round(Number((dailyTarget && dailyTarget.targetThb) || 100))}" step="10" min="1" max="1000000" />
          <small class="text-muted">เกจใต้ navbar จะ fill 100% เมื่อ todayPnL ≥ เป้านี้ (THB) · ใช้ FX ปัจจุบัน USDT→THB ในการคำนวณ</small>
        </div>
        <div class="col-md-6 d-flex align-items-end">
          <div class="text-muted-3 small w-100">
            <div><strong>Today PnL:</strong> <span id="dt-preview-pnl">—</span></div>
            <div><strong>Pct ของเป้า:</strong> <span id="dt-preview-pct">—</span></div>
            <div><strong>Zone:</strong> <span id="dt-preview-zone">—</span></div>
            <div class="mt-1"><em>แก้แล้วกด Save — gauge bar ด้านบนจะ refresh ทันที</em></div>
          </div>
        </div>
      </div>

      <div class="mt-3">
        <button type="button" class="btn btn-primary" id="btn-save-dt">💾 บันทึกเป้าหมาย</button>
        <span class="ms-2 text-muted small" id="dt-status"></span>
      </div>

      <hr />

      <!-- ── FIX-2026-08-07: Auto Add New Bot (full form) ──────────── -->
      <h6 class="text-muted-3 mb-3">7️⃣ 🤖 Auto Add New Bot <small class="text-muted-3">(สแกน + สร้างบอทใหม่อัตโนมัติทุก N นาที · บอทอยู่ในสถานะ DISABLED ต้องเปิดเอง)</small></h6>

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
          <small class="text-muted">ต้องเปิด event <code>autoAddBotCreated</code> ในหัวข้อ 2️⃣ ด้วย</small>
        </div>
      </div>
      <div class="row g-3 mt-1">
        <div class="col-md-12">
          <label class="form-check form-switch">
            <input class="form-check-input" type="checkbox" id="aab-auto-enable" ${autoAddBotCfg.autoEnable !== false ? 'checked' : ''} />
            <span class="form-check-label">
              <strong>▶️ Auto-enable บอทที่เพิ่งสร้างทันที</strong>
              — เรียก <code>botManager.enableBot()</code> หลัง create → spawn Trader + เริ่มเทรดเลย · ถ้าปิดจะสร้างบอทในสถานะ DISABLED ไว้รอ user เปิดเองที่ <a href="/bots.html">bots.html</a>
            </span>
          </label>
        </div>
      </div>
      <div class="row g-3 mt-1">
        <div class="col-md-6">
          <label class="form-label">🏷 Name Prefix <span class="text-muted">(ต่อท้ายชื่อบอทที่ auto-add สร้าง)</span></label>
          <input type="text" class="form-control" id="aab-name-prefix" value="${escapeHtml(autoAddBotCfg.namePrefix || '(bAdd)')}" maxlength="32" placeholder="(bAdd)" />
          <small class="text-muted">ตัวอย่าง: ถ้าใส่ <code>(bAdd)</code> → ชื่อบอทที่สร้างคือ <code>BTC(bAdd)</code> · ใส่ว่างได้ (fallback เป็น <code>(bAdd)</code>) · max 32 chars</small>
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

      <hr />

      <!-- ── FIX-2026-08-08: Feature #2 — CB Version (v2 vs v3) ──────── -->
      <h6 class="text-muted-3 mb-3">8️⃣ ⚡ CB Version <small class="text-muted-3">(เลือกระหว่าง CBv2 / CBv3 — Feature #2)</small></h6>

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

      <hr />

      <!-- ── FIX-2026-08-08: Feature #5 — Auto Delete Bot ──────── -->
      <h6 class="text-muted-3 mb-3">9️⃣ 🗑 Auto Delete Bot <small class="text-muted-3">(soft-delete + 30 วัน restore window)</small></h6>

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

      <hr />

      <!-- ── FIX-2026-08-08 (rev2): DPS — Dynamic Position Sizing tunables ─── -->
      <h6 class="text-muted-3 mb-3">🔟 📊 Dynamic Position Sizing (DPS) <small class="text-muted-3">(auto-tune ขนาดไม้ + จำนวนไม้หลังปิด position)</small></h6>

      <div class="row g-3">
        <div class="col-md-3">
          <label class="form-label">📐 Min size (USDT)</label>
          <input type="number" class="form-control dps-input" id="dps-min-size" value="${dps.dpsMinSize}" step="0.01" min="5" max="10000" data-dps="dpsMinSize" />
          <small class="text-muted">5..10000</small>
        </div>
        <div class="col-md-3">
          <label class="form-label">📐 Max size (USDT)</label>
          <input type="number" class="form-control dps-input" id="dps-max-size" value="${dps.dpsMaxSize}" step="0.01" min="5" max="10000" data-dps="dpsMaxSize" />
          <small class="text-muted">5..10000 · ต้อง ≥ Min</small>
        </div>
        <div class="col-md-3">
          <label class="form-label">🪜 Min layers</label>
          <input type="number" class="form-control dps-input" id="dps-min-layers" value="${dps.dpsMinLayers}" step="1" min="1" max="50" data-dps="dpsMinLayers" />
          <small class="text-muted">1..50</small>
        </div>
        <div class="col-md-3">
          <label class="form-label">🪜 Max layers</label>
          <input type="number" class="form-control dps-input" id="dps-max-layers" value="${dps.dpsMaxLayers}" step="1" min="1" max="50" data-dps="dpsMaxLayers" />
          <small class="text-muted">1..50 · ต้อง ≥ Min</small>
        </div>
        <div class="col-md-3">
          <label class="form-label">⏱ Cooldown (นาที)</label>
          <input type="number" class="form-control dps-input" id="dps-cooldown" value="${dps.dpsCooldownMinutes}" step="1" min="0" max="1440" data-dps="dpsCooldownMinutes" />
          <small class="text-muted">0..1440 · กัน whipsaw หลังปรับ</small>
        </div>
      </div>

      <hr />

      <div class="row g-3">
        <div class="col-md-12">
          <strong class="text-muted-3">กฎ 1 · ชนะติดกัน N ไม้ (ยกระดับความเสี่ยงเมื่อชนะรวด)</strong>
        </div>
        <div class="col-md-4">
          <label class="form-label">จำนวนไม้ชนะติด</label>
          <input type="number" class="form-control dps-input" id="dps-r1-count" value="${dps.dpsWinStreakCount}" step="1" min="1" max="20" data-dps="dpsWinStreakCount" />
          <small class="text-muted">1..20 (default 3)</small>
        </div>
        <div class="col-md-4">
          <label class="form-label">Δ size (USDT)</label>
          <input type="number" class="form-control dps-input" id="dps-r1-dsize" value="${dps.dpsWinStreakDeltaSize}" step="0.1" min="-1000" max="1000" data-dps="dpsWinStreakDeltaSize" />
          <small class="text-muted">-1000..1000 · ค่าบวก = เพิ่มขนาด</small>
        </div>
        <div class="col-md-4">
          <label class="form-label">Δ layers</label>
          <input type="number" class="form-control dps-input" id="dps-r1-dlayers" value="${dps.dpsWinStreakDeltaLayers}" step="1" min="-50" max="50" data-dps="dpsWinStreakDeltaLayers" />
          <small class="text-muted">-50..50 · ค่าบวก = เพิ่มไม้</small>
        </div>
      </div>

      <div class="row g-3 mt-1">
        <div class="col-md-12">
          <strong class="text-muted-3">กฎ 2 · N ไม้ล่าสุดกำไร ≥ X% ทุกไม้ (กำไรใหญ่ต่อเนื่อง)</strong>
        </div>
        <div class="col-md-3">
          <label class="form-label">จำนวนไม้ย้อนหลัง</label>
          <input type="number" class="form-control dps-input" id="dps-r2-count" value="${dps.dpsBigWinCount}" step="1" min="1" max="20" data-dps="dpsBigWinCount" />
          <small class="text-muted">1..20 (default 2)</small>
        </div>
        <div class="col-md-3">
          <label class="form-label">% กำไรขั้นต่ำต่อไม้</label>
          <input type="number" class="form-control dps-input" id="dps-r2-pct" value="${dps.dpsBigWinPct}" step="0.1" min="0.1" max="100" data-dps="dpsBigWinPct" />
          <small class="text-muted">0.1..100 (default 2%)</small>
        </div>
        <div class="col-md-3">
          <label class="form-label">Δ size (USDT)</label>
          <input type="number" class="form-control dps-input" id="dps-r2-dsize" value="${dps.dpsBigWinDeltaSize}" step="0.1" min="-1000" max="1000" data-dps="dpsBigWinDeltaSize" />
          <small class="text-muted">-1000..1000</small>
        </div>
        <div class="col-md-3">
          <label class="form-label">Δ layers</label>
          <input type="number" class="form-control dps-input" id="dps-r2-dlayers" value="${dps.dpsBigWinDeltaLayers}" step="1" min="-50" max="50" data-dps="dpsBigWinDeltaLayers" />
          <small class="text-muted">-50..50</small>
        </div>
      </div>

      <div class="row g-3 mt-1">
        <div class="col-md-12">
          <strong class="text-muted-3">กฎ 3 · แพ้ติดกัน N ไม้ (ลดความเสี่ยงหลังขาดทุน)</strong>
        </div>
        <div class="col-md-4">
          <label class="form-label">จำนวนไม้แพ้ติด</label>
          <input type="number" class="form-control dps-input" id="dps-r3-count" value="${dps.dpsLossStreakCount}" step="1" min="1" max="20" data-dps="dpsLossStreakCount" />
          <small class="text-muted">1..20 (default 1)</small>
        </div>
        <div class="col-md-4">
          <label class="form-label">Δ size (USDT)</label>
          <input type="number" class="form-control dps-input" id="dps-r3-dsize" value="${dps.dpsLossDeltaSize}" step="0.1" min="-1000" max="1000" data-dps="dpsLossDeltaSize" />
          <small class="text-muted">-1000..1000 · ค่าลบ = ลดขนาด</small>
        </div>
        <div class="col-md-4">
          <label class="form-label">Δ layers</label>
          <input type="number" class="form-control dps-input" id="dps-r3-dlayers" value="${dps.dpsLossDeltaLayers}" step="1" min="-50" max="50" data-dps="dpsLossDeltaLayers" />
          <small class="text-muted">-50..50 · ค่าลบ = ลดไม้</small>
        </div>
      </div>

      <hr />

      <div class="row g-3">
        <div class="col-md-12"><strong class="text-muted-3">ความปลอดภัย</strong></div>
        <div class="col-md-4">
          <label class="form-check form-switch">
            <input type="checkbox" class="form-check-input" id="dps-respect" ${dps.dpsRespectBotCapital ? 'checked' : ''} />
            <span class="form-check-label">🔒 Respect bot capital (anchored clamp) — ค่า capitalPerTrade ของบอทจะอยู่ในช่วงเสมอ · ปิด = ใช้ band ตรงๆ</span>
          </label>
        </div>
        <div class="col-md-4">
          <label class="form-check form-switch">
            <input type="checkbox" class="form-check-input" id="dps-reset" ${dps.dpsResetHistoryOnFire ? 'checked' : ''} />
            <span class="form-check-label">♻️ Reset history on fire — กฎยิงแล้วเคลียร์ streak กันยิงซ้ำ · ปิด = ต่อยอด streak เดิม</span>
          </label>
        </div>
        <div class="col-md-4">
          <label class="form-check form-switch">
            <input type="checkbox" class="form-check-input" id="dps-dryrun" ${dps.dpsDryRun ? 'checked' : ''} />
            <span class="form-check-label">🧪 Dry-run mode — คำนวณ + แจ้งเตือน แต่<strong>ไม่ปรับจริง</strong> · ใช้ตอนทดสอบกฎ</span>
          </label>
        </div>
      </div>

      <div class="alert alert-secondary mt-3 mb-2 p-2 small">
        <strong>📜 กฎที่จะใช้:</strong>
        <ul class="mb-1">
          <li>${dpsPrev.r1}</li>
          <li>${dpsPrev.r2}</li>
          <li>${dpsPrev.r3}</li>
        </ul>
        <div class="text-muted">${dpsPrev.band}${dps.dpsRespectBotCapital ? ' · anchored clamp ON' : ''}${dps.dpsDryRun ? ' · 🧪 DRY-RUN' : ''}</div>
      </div>

      <div class="mt-2">
        <button type="button" class="btn btn-primary" id="btn-save-dps">💾 บันทึก DPS</button>
        <button type="button" class="btn btn-outline-warning ms-2" id="btn-dps-reset-all">🗑 Reset state ทุกบอท</button>
        <span class="ms-2 text-muted small" id="dps-status"></span>
      </div>

      <div class="text-muted small mt-2">
        <strong>Engine:</strong> อ่านค่าจาก AppConfig ทุก 30s (cache invalidates เมื่อบันทึก) ·
        <strong>Kill switch:</strong> Master Config → DPS Master OFF ปิดได้ทันทีทั้งระบบ ·
        <strong>Per-bot:</strong> แก้ capitalPerTrade หรือ maxTrades → DPS state ของบอทนั้นถูก reset อัตโนมัติ
      </div>

    </div>
  `;

  document.getElementById('settings-content').innerHTML = html;
  bindEvents();
}

function bindEvents() {
  document.getElementById('btn-set-token').onclick = setToken;
  document.getElementById('btn-clear-token').onclick = clearToken;
  document.getElementById('btn-save-chat').onclick = saveChatId;
  document.getElementById('btn-test').onclick = sendTest;
  document.getElementById('f-enabled').onchange = toggleEnabled;
  document.getElementById('btn-save-events').onclick = saveEvents;
  document.getElementById('btn-save-thresholds').onclick = saveThresholds;
  const sq = document.getElementById('btn-save-quality');
  if (sq) sq.onclick = saveQualityThresholds;
  // FIX-2026-08-05: auto-buy BNB
  const sb = document.getElementById('btn-save-bnb');
  if (sb) sb.onclick = saveAutoBuyBnb;
  const tb = document.getElementById('btn-trigger-bnb');
  if (tb) tb.onclick = triggerAutoBuyBnb;
  // 2026-08-06: daily target gauge
  const sdt = document.getElementById('btn-save-dt');
  if (sdt) sdt.onclick = saveDailyTarget;
  const dtInput = document.getElementById('dt-target');
  if (dtInput) dtInput.addEventListener('input', updateDailyTargetPreview);
  // populate preview now
  updateDailyTargetPreview();
  // FIX-2026-08-07: auto add new bot
  const saab = document.getElementById('btn-save-aab');
  if (saab) saab.onclick = saveAutoAddBot;
  const taab = document.getElementById('btn-trigger-aab');
  if (taab) taab.onclick = triggerAutoAddBot;
  // FIX-2026-08-08: Feature #2 — CB Version (v2 vs v3)
  const scbv = document.getElementById('btn-save-cbversion');
  if (scbv) scbv.onclick = saveCbVersion;
  // FIX-2026-08-08: Feature #5 — Auto Delete Bot
  const sadb = document.getElementById('btn-save-adb');
  if (sadb) sadb.onclick = saveAutoDeleteBot;
  // FIX-2026-08-08 (rev2): DPS tunables (section 🔟)
  const sdps = document.getElementById('btn-save-dps');
  if (sdps) sdps.onclick = saveDpsConfig;
  const rdps = document.getElementById('btn-dps-reset-all');
  if (rdps) rdps.onclick = resetDpsStateAll;
  // telegram label sync on toggle
  const aabTg = document.getElementById('aab-tg');
  const aabTgLabel = document.getElementById('aab-tg-label');
  if (aabTg && aabTgLabel) {
    aabTg.addEventListener('change', () => {
      aabTgLabel.textContent = aabTg.checked ? 'เปิด' : 'ปิด';
    });
  }
}

// 2026-08-06: live preview of zone + pct as user edits target value
function updateDailyTargetPreview() {
  const v = parseFloat((document.getElementById('dt-target') || {}).value);
  const pnlThb = Number(dailyTarget && dailyTarget.todayPnlThb) || 0;
  const pnlUsdt = Number(dailyTarget && dailyTarget.todayPnlUsdt) || 0;
  const target = Number.isFinite(v) && v > 0 ? v : 100;
  const pct = target > 0 ? Math.max(-100, Math.min(200, (pnlThb / target) * 100)) : 0;
  const zone = pct >= 100 ? '🏆 achieved'
             : pct >= 70  ? '🚀 hot'
             : pct >= 30  ? '🔥 warming'
             : pct >= 0   ? '🥶 cold' : '💔 loss';
  const elPnl = document.getElementById('dt-preview-pnl');
  const elPct = document.getElementById('dt-preview-pct');
  const elZone = document.getElementById('dt-preview-zone');
  if (elPnl) elPnl.textContent = `฿${pnlThb.toFixed(2)} (${pnlUsdt.toFixed(4)} USDT)`;
  if (elPct) elPct.textContent = `${pct.toFixed(1)}%`;
  if (elZone) elZone.textContent = `${zone} (${pct >= 100 ? '🎉 ทะลุเป้า!' : pct < 0 ? 'ขาดทุน' : 'กำลังไป'})`;
}

// 2026-08-06: save Daily Target value + tell the gauge bar to refresh
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
    // nudge gauge partial to re-fetch immediately
    if (window.__dtb && typeof window.__dtb.refresh === 'function') {
      window.__dtb.refresh();
    }
  } catch (err) {
    setStatus('dt-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
  }
}

function setStatus(elId, msg, isError = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.className = 'ms-2 small ' + (isError ? 'text-danger' : 'text-success');
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 5000);
}

async function setToken() {
  const token = (document.getElementById('f-token').value || '').trim();
  if (!token) {
    setStatus('test-status', 'กรุณาใส่ token', true);
    return;
  }
  try {
    await API.put('/api/telegram/token', { token });
    document.getElementById('f-token').value = '';
    setStatus('test-status', '✅ token บันทึกแล้ว');
    await loadConfig();
  } catch (err) {
    setStatus('test-status', '❌ ' + err.message, true);
  }
}

async function clearToken() {
  if (!confirm('ลบ Telegram token และ disable การแจ้งเตือน?')) return;
  try {
    await API.del('/api/telegram/token');
    setStatus('test-status', '✅ ลบ token แล้ว');
    await loadConfig();
  } catch (err) {
    setStatus('test-status', '❌ ' + err.message, true);
  }
}

async function saveChatId() {
  const chatId = (document.getElementById('f-chat-id').value || '').trim();
  try {
    await API.put('/api/telegram/config', { chatId });
    setStatus('test-status', '✅ บันทึก Chat ID แล้ว');
    await loadConfig();
  } catch (err) {
    setStatus('test-status', '❌ ' + err.message, true);
  }
}

async function sendTest() {
  const chatId = (document.getElementById('f-chat-id').value || '').trim();
  try {
    await API.post('/api/telegram/test', chatId ? { chatId } : {});
    setStatus('test-status', '✅ ส่งข้อความทดสอบสำเร็จ');
    await loadConfig();
  } catch (err) {
    setStatus('test-status', '❌ ' + (err.body && err.body.detail ? err.body.detail : err.message), true);
  }
}

async function toggleEnabled() {
  const enabled = document.getElementById('f-enabled').checked;
  try {
    await API.put('/api/telegram/config', { enabled });
    setStatus('test-status', enabled ? '✅ เปิดใช้งานแล้ว' : '⏸ ปิดใช้งานแล้ว');
    await loadConfig();
  } catch (err) {
    setStatus('test-status', '❌ ' + err.message, true);
    await loadConfig(); // restore checkbox state
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
    // FIX-2026-07-26: สรุปการเทรด
    dailySummary:        document.getElementById('ev-dailySummary').checked,
    weeklySummary:       document.getElementById('ev-weeklySummary').checked,
    monthlySummary:      document.getElementById('ev-monthlySummary').checked,
    // FIX-2026-07-26: TP ต่ำเกินไป
    tpLowPnL:            document.getElementById('ev-tpLowPnL').checked,
    cbPanicClose:       document.getElementById('ev-cbPanicClose').checked,
    // FIX-2026-08-06: CBv2 panic-sell + bot locked events (default true)
    cbv2PanicClose:     document.getElementById('ev-cbv2PanicClose').checked,
    botLocked:          document.getElementById('ev-botLocked').checked,
    // FIX-2026-08-08: Feature #1 — Dynamic Position Sizing resize (size/layers changed)
    dpsResize:         document.getElementById('ev-dpsResize').checked,
    // FIX-2026-08-08: Feature #2 — CBv3 (CBv2 + ST3 upper-TF)
    cbv3PanicClose:     document.getElementById('ev-cbv3PanicClose').checked,
    // FIX-2026-08-08: Feature #3 — Auto Unlock Cooldown (CB unlocked after 3+ profitable signals)
    botAutoUnlocked:    document.getElementById('ev-botAutoUnlocked').checked,
    // FIX-2026-08-08: Feature #5 — Auto Delete Bot lifecycle events
    autoDeleteBotWarning:  document.getElementById('ev-autoDeleteBotWarning').checked,
    autoDeleteBotRemoved:  document.getElementById('ev-autoDeleteBotRemoved').checked,
    // FIX-2026-08-05: BNB balance ต่ำ — กัน BNB-empty fee-deduct incident
    bnbLowBalance:      document.getElementById('ev-bnbLowBalance').checked,
  };
  try {
    await API.put('/api/telegram/config', { events });
    setStatus('events-status', '✅ บันทึกแล้ว');
    await loadConfig();
  } catch (err) {
    setStatus('events-status', '❌ ' + err.message, true);
  }
}

async function saveThresholds() {
  const thresholds = {
    positionLossPct:   parseFloat(document.getElementById('th-loss').value),
    positionProfitPct: parseFloat(document.getElementById('th-profit').value),
    positionStuckMin:  parseInt(document.getElementById('th-stuck').value, 10),
    // FIX-2026-08-05: BNB low-balance threshold (USDT value ของ BNB ที่ trigger alert)
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
  } catch (err) {
    setStatus('thresholds-status', '❌ ' + err.message, true);
  }
}

// FIX-2026-08-01: save Bot Quality Indicator settings
//   - PUT /api/telegram/config with qualityEnabled + qualityRefreshMs + qualityThresholds
//   - backend calls qualityIndicator.reloadConfig() → clears caches + restarts refresh timer
async function saveQualityThresholds() {
  const qualityEnabled = !!document.getElementById('q-enabled').checked;
  const refreshMin = parseInt(document.getElementById('q-refresh').value, 10);
  const qualityThresholds = {
    volumeMinUSDT:  parseFloat(document.getElementById('q-vol').value),
    topN:           parseInt(document.getElementById('q-topn').value, 10),
    kcTightPct:     parseFloat(document.getElementById('q-kc').value),
    squeezeMinPct:  parseFloat(document.getElementById('q-sq').value),
    trendMinPct:    parseFloat(document.getElementById('q-tr').value),
  };
  if (!Number.isFinite(qualityThresholds.volumeMinUSDT) ||
      !Number.isFinite(qualityThresholds.topN) ||
      !Number.isFinite(qualityThresholds.kcTightPct) ||
      !Number.isFinite(qualityThresholds.squeezeMinPct) ||
      !Number.isFinite(qualityThresholds.trendMinPct) ||
      !Number.isFinite(refreshMin)) {
    setStatus('quality-status', '❌ ค่าต้องเป็นตัวเลข', true);
    return;
  }
  try {
    await API.put('/api/telegram/config', {
      qualityEnabled,
      qualityRefreshMs: Math.max(1, Math.min(60, refreshMin)) * 60_000,
      qualityThresholds,
    });
    setStatus('quality-status', '✅ บันทึกแล้ว · cache จะ refresh ทันที');
    await loadConfig();
  } catch (err) {
    setStatus('quality-status', '❌ ' + err.message, true);
  }
}

// FIX-2026-08-05: save Auto-Buy BNB config
//   - PUT /api/bnb-auto-buy/config with boolean + numbers
//   - backend calls autoBnbBuyer.reloadConfig() → restart timer with new interval
async function saveAutoBuyBnb() {
  const enabled        = !!document.getElementById('bnb-enabled').checked;
  const topUpUsdt      = parseFloat(document.getElementById('bnb-topUp').value);
  const thresholdUsdt  = parseFloat(document.getElementById('bnb-threshold').value);
  const checkIntervalMin = parseInt(document.getElementById('bnb-interval').value, 10);
  const cooldownMin    = parseInt(document.getElementById('bnb-cooldown').value, 10);
  const maxUsdtPerDay  = parseFloat(document.getElementById('bnb-dailycap').value);
  // FIX-2026-08-05: BNB oil gauge target (ส่งไป endpoint เดียวกัน — gauge ไม่ต้องแยก endpoint)
  const gaugeTargetUsdt = parseFloat(document.getElementById('bnb-gauge-target').value);

  // basic validation
  if (!Number.isFinite(topUpUsdt) || topUpUsdt < 5 || topUpUsdt > 100) {
    setStatus('bnb-status', '❌ TopUp ต้องอยู่ระหว่าง 5–100 USDT', true);
    return;
  }
  if (!Number.isFinite(thresholdUsdt) || thresholdUsdt < 0.1 || thresholdUsdt > 100) {
    setStatus('bnb-status', '❌ Threshold ต้องอยู่ระหว่าง 0.1–100 USDT', true);
    return;
  }
  if (!Number.isFinite(checkIntervalMin) || checkIntervalMin < 5 || checkIntervalMin > 1440) {
    setStatus('bnb-status', '❌ Check interval ต้องอยู่ระหว่าง 5–1440 นาที', true);
    return;
  }
  if (!Number.isFinite(cooldownMin) || cooldownMin < 0 || cooldownMin > 1440) {
    setStatus('bnb-status', '⏸ Cooldown ต้องอยู่ระหว่าง 0–1440 นาที', true);
    return;
  }
  if (!Number.isFinite(maxUsdtPerDay) || maxUsdtPerDay < 0 || maxUsdtPerDay > 10000) {
    setStatus('bnb-status', '❌ Daily cap ต้องอยู่ระหว่าง 0–10000 USDT', true);
    return;
  }
  // FIX-2026-08-05: gauge target validation (1..100 USDT)
  if (!Number.isFinite(gaugeTargetUsdt) || gaugeTargetUsdt < 1 || gaugeTargetUsdt > 100) {
    setStatus('bnb-status', '❌ Gauge target ต้องอยู่ระหว่าง 1–100 USDT', true);
    return;
  }

  // extra: กันเปิด enabled โดยไม่ตั้งใจ → 2-step confirm
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
      // revert checkbox
      document.getElementById('bnb-enabled').checked = false;
      return;
    }
  }

  try {
    const resp = await API.put('/api/bnb-auto-buy/config', {
      enabled, topUpUsdt, thresholdUsdt, checkIntervalMin, cooldownMin, maxUsdtPerDay,
      // FIX-2026-08-05: BNB oil gauge target — ส่งไปด้วย (route จะอัปเดต field แยก)
      gaugeTargetUsdt,
    });
    setStatus('bnb-status', '✅ บันทึกแล้ว' + (resp.enabled ? ' · Auto-Buy BNB 🟢 ON' : ' · Auto-Buy BNB ⚪ OFF'));
    await loadConfig();
  } catch (err) {
    setStatus('bnb-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
  }
}

// FIX-2026-08-05: manual trigger — bypass enabled flag (สำหรับ test หรือ emergency top-up)
//   - ส่งคำสั่งจริง → ต้อง confirm
async function triggerAutoBuyBnb() {
  if (!confirm(
    '⚠️ จะสั่งซื้อ BNB/USDT MARKET BUY ทันที?\n\n' +
    'สำหรับ top-up BNB แบบ manual (bypass enabled flag)\n\n' +
    'ค่าเงินจริง — แน่ใจหรือไม่?'
  )) return;
  setStatus('bnb-status', '⏳ กำลังส่งคำสั่ง...');
  try {
    const result = await API.post('/api/bnb-auto-buy/trigger', {});
    const ok = result && result.result && result.result.outcome;
    setStatus('bnb-status', '✅ ' + (ok ? 'ส่งคำสั่งสำเร็จ (outcome: ' + ok + ')' : 'เสร็จแล้ว'));
    await loadConfig();
  } catch (err) {
    // 409 = already running → ไม่ถือเป็น error
    if (err.status === 409) {
      setStatus('bnb-status', '⏳ มีคำสั่งกำลังทำงานอยู่ — ลองใหม่ภายหลัง');
    } else {
      setStatus('bnb-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
    }
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// FIX-2026-08-08: Feature #2 — save CB Version (v2 / v3)
async function saveCbVersion() {
  const v = document.getElementById('cb-version').value;
  if (v !== 'v2' && v !== 'v3') {
    setStatus('cbversion-status', '❌ ต้องเลือก v2 หรือ v3', true);
    return;
  }
  try {
    await API.put('/api/telegram/config', { cbVersion: v });
    setStatus('cbversion-status', `✅ บันทึกแล้ว · CB version = ${v} (cache 30s จะ refresh)`);
    await loadConfig();
  } catch (err) {
    setStatus('cbversion-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
  }
}

// FIX-2026-08-08: Feature #5 — save Auto Delete Bot config
async function saveAutoDeleteBot() {
  const enabled = !!document.getElementById('adb-enabled').checked;
  const days = parseInt(document.getElementById('adb-days').value, 10);
  const warningDays = parseInt(document.getElementById('adb-warndays').value, 10);
  if (!Number.isFinite(days) || days < 7 || days > 365) {
    setStatus('adb-status', '❌ Days ต้องอยู่ระหว่าง 7..365', true);
    return;
  }
  if (!Number.isFinite(warningDays) || warningDays < 1 || warningDays > 30) {
    setStatus('adb-status', '❌ Warning days ต้องอยู่ระหว่าง 1..30', true);
    return;
  }
  try {
    await API.put('/api/telegram/config', {
      autoDeleteBotEnabled: enabled,
      autoDeleteBotDays: days,
      autoDeleteBotWarningDays: warningDays,
    });
    setStatus('adb-status', `✅ บันทึกแล้ว · Auto Delete ${enabled ? '🟢 ON' : '⚪ OFF'} · ${days} วัน / warning ${warningDays} วัน`);
    await loadConfig();
  } catch (err) {
    setStatus('adb-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
  }
}

// FIX-2026-08-08 (rev2): DPS — save tunables via PUT /api/admin/app-config
//   - validate ฝั่ง client ก่อน (min ≤ max, count ≥ 1)
//   - backend ทำ clamp + cross-field validation + return 400 ถ้าไม่ผ่าน
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
  } catch (err) {
    setStatus('dps-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
  }
}

// FIX-2026-08-08 (rev2): DPS — reset state ทุกบอท (เคลียร์ history/size/cooldown)
async function resetDpsStateAll() {
  if (!confirm('เคลียร์ DPS state ทุกบอท? (dynamicSizeCurrent / dynamicSizeLastResults ทั้งหมดจะเริ่มนับใหม่)')) return;
  setStatus('dps-status', '⏳ กำลัง reset…');
  try {
    const resp = await API.post('/api/admin/dps-reset-all', {});
    setStatus('dps-status', `✅ reset แล้ว · matched ${resp.matched} · modified ${resp.modified} · in-memory ${resp.syncedInMem}`);
  } catch (err) {
    setStatus('dps-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
  }
}

// FIX-2026-08-07: Auto Add New Bot — save full config
async function saveAutoAddBot() {
  const enabled = !!document.getElementById('aab-enabled').checked;
  const intervalMin = parseInt(document.getElementById('aab-interval').value, 10);
  const minKcPct = parseFloat(document.getElementById('aab-min-kc').value);
  const maxPerRun = parseInt(document.getElementById('aab-max-per-run').value, 10);
  const telegramNotify = !!document.getElementById('aab-tg').checked;
  const autoEnable = !!document.getElementById('aab-auto-enable').checked; // FIX-2026-08-07
  // 2026-08-08: name prefix (string, fallback "(bAdd)" — server-side sanitize อีกชั้น)
  const namePrefixRaw = (document.getElementById('aab-name-prefix').value || '').trim();
  const namePrefix = namePrefixRaw.slice(0, 32) || '(bAdd)';
  const scanTimeframe = document.getElementById('aab-tf').value;
  const scanThreshold = parseFloat(document.getElementById('aab-thr').value);
  const scanWindow = parseInt(document.getElementById('aab-win').value, 10);
  const scanTpWindow = parseInt(document.getElementById('aab-tpwin').value, 10);
  const scanTopN = parseInt(document.getElementById('aab-topn').value, 10);
  const scanMinVol = parseFloat(document.getElementById('aab-minvol').value);
  // scanMinPct: form gives 0..100, convert to 0..1
  const scanMinPctRaw = parseFloat(document.getElementById('aab-minpct').value);
  const scanMinPct = Number.isFinite(scanMinPctRaw) ? Math.max(0, Math.min(1, scanMinPctRaw / 100)) : 0.30;
  const trends = [];
  if (document.getElementById('aab-trend-up').checked) trends.push('uptrend');
  if (document.getElementById('aab-trend-down').checked) trends.push('downtrend');
  if (document.getElementById('aab-trend-side').checked) trends.push('sideways');

  // validation (mirror route constraints)
  if (!Number.isFinite(intervalMin) || intervalMin < 5 || intervalMin > 1440) {
    setStatus('aab-status', '❌ Interval ต้องอยู่ระหว่าง 5–1440 นาที', true);
    return;
  }
  if (!Number.isFinite(minKcPct) || minKcPct < 0 || minKcPct > 50) {
    setStatus('aab-status', '❌ Min %KC ต้องอยู่ระหว่าง 0–50', true);
    return;
  }
  if (!Number.isFinite(maxPerRun) || maxPerRun < 1 || maxPerRun > 50) {
    setStatus('aab-status', '❌ Max bots/run ต้องอยู่ระหว่าง 1–50', true);
    return;
  }
  if (trends.length === 0) {
    setStatus('aab-status', '❌ ต้องเลือก Trend อย่างน้อย 1 อัน', true);
    return;
  }
  if (!Number.isFinite(scanThreshold) || scanThreshold < 0.1 || scanThreshold > 100) {
    setStatus('aab-status', '❌ % Vol threshold ต้องอยู่ระหว่าง 0.1–100', true);
    return;
  }
  if (!Number.isFinite(scanWindow) || scanWindow < 5 || scanWindow > 20000) {
    setStatus('aab-status', '❌ Window ต้องอยู่ระหว่าง 5–20000', true);
    return;
  }
  if (!Number.isFinite(scanTpWindow) || scanTpWindow < 20 || scanTpWindow > 1000) {
    setStatus('aab-status', '❌ TP Window ต้องอยู่ระหว่าง 20–1000', true);
    return;
  }
  if (!Number.isFinite(scanTopN) || scanTopN < 20 || scanTopN > 300) {
    setStatus('aab-status', '❌ Top N ต้องอยู่ระหว่าง 20–300', true);
    return;
  }
  if (!Number.isFinite(scanMinVol) || scanMinVol < 0) {
    setStatus('aab-status', '❌ Min 24h Vol ต้อง ≥ 0', true);
    return;
  }

  // safety: 2-step confirm when enabling
  if (enabled && autoAddBotCfg && !autoAddBotCfg.enabled) {
    const ok = confirm(
      '⚠️ จะเปิด Auto Add New Bot ใช่หรือไม่?\n\n' +
      'ระบบจะสแกน + สร้างบอทใหม่อัตโนมัติทุก ' + intervalMin + ' นาที\n' +
      'Max ' + maxPerRun + ' บอทต่อรอบ · Min %KC > ' + minKcPct + '\n' +
      'Name prefix: ' + namePrefix + ' (เช่น BTC' + namePrefix + ')\n\n' +
      (autoEnable
        ? '▶️ Auto-enable: ON — บอทที่สร้างจะเริ่มเทรดทันที (spawn Trader)'
        : '⏸ Auto-enable: OFF — บอทจะอยู่ในสถานะ DISABLED ต้องเปิดเอง')
    );
    if (!ok) {
      document.getElementById('aab-enabled').checked = false;
      return;
    }
  }

  setStatus('aab-status', '⏳ กำลังบันทึก...');
  try {
    const resp = await API.put('/api/auto-add-bot/config', {
      enabled, intervalMin, minKcPct, maxPerRun, telegramNotify, autoEnable,
      namePrefix, // 2026-08-08: editable prefix
      scanTimeframe, scanThreshold, scanWindow, scanTpWindow,
      scanTopN, scanMinVol, scanMinPct, scanTrends: trends,
    });
    setStatus('aab-status',
      '✅ บันทึกแล้ว'
      + (resp.enabled ? ' · Auto Add Bot 🟢 ON' : ' · Auto Add Bot ⚪ OFF')
      + (resp.autoEnable ? ' · Auto-enable ▶️ ON' : ' · Auto-enable ⏸ OFF')
      + ' · prefix=' + (resp.namePrefix || '(bAdd)')
    );
    await loadConfig();
  } catch (err) {
    setStatus('aab-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
  }
}

// FIX-2026-08-07: Auto Add New Bot — manual trigger (bypass enabled flag)
async function triggerAutoAddBot() {
  if (!confirm(
    '⚠️ จะ Run Auto Add Bot ทันที (bypass enabled flag)?\n\n' +
    'ระบบจะสแกน + filter + create บอทใหม่ทันที\n' +
    'บอทจะอยู่ในสถานะ DISABLED — ต้องเปิดเอง'
  )) return;
  setStatus('aab-status', '⏳ กำลังสแกน...');
  try {
    const resp = await API.post('/api/auto-add-bot/run', {});
    const r = resp.result || {};
    const list = (r.createdList || []).map((b) => `${b.symbol} (score ${(b.score || 0).toFixed(2)}, kcMin ${(b.kcMinPct || 0).toFixed(3)}%)`).join(', ');
    if (r.created > 0) {
      setStatus('aab-status', `✅ สร้าง ${r.created} บอทจาก ${r.candidates} candidates · ${list}`);
    } else if (r.outcome === 'failed_scan') {
      setStatus('aab-status', '❌ scan failed: ' + (r.error || 'unknown'), true);
    } else if (r.skipped) {
      setStatus('aab-status', '⏸ ' + r.skipped);
    } else {
      setStatus('aab-status', `ℹ️ scanned ${r.scanned ?? '?'} · candidates ${r.candidates ?? 0} · created 0`);
    }
    await loadConfig();
  } catch (err) {
    if (err.status === 409) {
      setStatus('aab-status', '⏳ มีคำสั่งกำลังทำงานอยู่ — ลองใหม่ภายหลัง');
    } else {
      setStatus('aab-status', '❌ ' + (err.body && err.body.error ? err.body.error : err.message), true);
    }
  }
}

init();
