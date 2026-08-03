'use strict';

// FIX-2026-07-24: Settings page (Telegram config)
//   - 3 sections: Connection / Events / Thresholds / Master switch
//   - ใช้ form-check pattern จาก public/js/pages/bot-edit.js (เหมือน stopLoss/autoUpdateTp)
//   - reload on every PUT/DELETE เพราะ backend เรียก notifier.reloadConfig() ให้แล้ว

let cfg = null; // cached config

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
  };
  if (!Number.isFinite(thresholds.positionLossPct) || !Number.isFinite(thresholds.positionProfitPct) || !Number.isFinite(thresholds.positionStuckMin)) {
    setStatus('thresholds-status', '❌ ค่าต้องเป็นตัวเลข', true);
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

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
