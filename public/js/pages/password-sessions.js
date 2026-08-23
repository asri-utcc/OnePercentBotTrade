'use strict';

/**
 * Password & Sessions Manager — 2026-08-09
 *
 * Features:
 *   1. Change password (with optional "kill all other sessions" checkbox)
 *   2. Personal password hint (textarea ≤500) — เตือนความจำส่วนตัว
 *   3. Password notes / audit log (textarea ≤1000)
 *   4. Last changed info (when + from which IP)
 *   5. Active sessions list (device + IP + last seen) — kill individual session
 *   6. "Kill all other sessions" button
 *   7. Failed Logins tab — list of wrong-password / OTP failures (TTL 30 days)
 *
 * Auth: requireAuth (login only) — ไม่ต้องใช้ bot-action password
 *       (เพราะ user ต้อง verify ด้วย currentPassword อยู่แล้ว)
 */

let state = {
  passwordInfo: null,
  sessions: [],
  currentSid: null,
  loginAttempts: [],
  attemptsFilter: { method: '', reason: '' },
};

async function init() {
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me || !me.authenticated) {
    location.href = '/login.html';
    return;
  }
  await loadAll();
}

async function loadAll() {
  // load parallel
  let pwInfo = null;
  let sessions = null;
  let attempts = null;
  try {
    pwInfo = await API.get('/api/auth/password-info');
  } catch (e) {
    pwInfo = {
      hint: '', note: '', lastChangedAt: null, lastChangedFromIp: '',
      botActionPasswordChangedAt: null, botActionPasswordChangedFromIp: '',
    };
    console.warn('password-info load failed:', e.message);
  }
  try {
    const r = await API.get('/api/auth/sessions');
    sessions = r.sessions || [];
    state.currentSid = r.currentSid;
  } catch (e) {
    sessions = [];
    console.warn('sessions load failed:', e.message);
  }
  try {
    const r = await API.get('/api/auth/login-attempts?limit=100');
    attempts = r.attempts || [];
  } catch (e) {
    attempts = [];
    console.warn('login-attempts load failed:', e.message);
  }
  state.passwordInfo = pwInfo;
  state.sessions = sessions;
  state.loginAttempts = attempts;
  render();
}

// ─── Helpers ───────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeAgo(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return 'เมื่อกี้';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} วินาทีที่แล้ว`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} นาทีที่แล้ว`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ชั่วโมงที่แล้ว`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} วันที่แล้ว`;
  return new Date(iso).toLocaleString();
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return '—';
  return d.toLocaleString('th-TH', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function deviceIcon(label) {
  if (!label) return '🖥️';
  if (label.device === 'phone') return '📱';
  if (label.device === 'tablet') return '�';
  if (label.browser === 'CLI') return '⌨️';
  return '🖥️';
}

function deviceLabel(s) {
  const dl = s.deviceLabel || {};
  const browser = dl.browser || 'Unknown';
  const os = dl.os || 'Unknown';
  return `${browser} บน ${os}`;
}

// ─── Renderers ──────────────────────────────────────────
function render() {
  const pw = state.passwordInfo || {};
  const html = `
    ${renderChangePasswordSection()}
    ${renderBotPasswordSyncSection()}
    ${renderHintSection(pw)}
    ${renderSessionsSection()}
    ${renderFailedLoginsSection()}
  `;
  document.getElementById('content').innerHTML = `
    <div class="lux-body">
      <div class="alert alert-info small mb-4">
        <strong>🛡️ เคล็ดลับความปลอดภัย:</strong>
        เปลี่ยน password เป็นประจำ + ตรวจ Active Sessions เพื่อให้แน่ใจว่าไม่มี device แปลกปลอม login ค้างไว้
        · ถ้าเจอ IP/device ที่ไม่รู้จัก → กด ✕ ลบทันที + เปลี่ยน password
      </div>
      ${html}
    </div>
  `;
  bindEvents();
}

// 1. Change Password section
function renderChangePasswordSection() {
  const lastChanged = state.passwordInfo?.lastChangedAt
    ? `เปลี่ยนล่าสุด: <strong>${escapeHtml(formatDateTime(state.passwordInfo.lastChangedAt))}</strong> จาก IP <code>${escapeHtml(state.passwordInfo.lastChangedFromIp || '—')}</code>`
    : '<span class="text-muted-3">ยังไม่เคยเปลี่ยน password (ใช้ค่าจากตอน setup)</span>';
  return `
    <details class="lux-details" open>
      <summary class="lux-details-summary">
        <span>🔐</span>
        <span>เปลี่ยน Password</span>
      </summary>
      <div class="lux-details-body">
        <div class="small mb-3 text-muted-3">${lastChanged}</div>

        <div class="row g-3">
          <div class="col-md-4">
            <label class="form-label">Current password</label>
            <div class="input-group">
              <input type="password" class="form-control" id="pw-current" autocomplete="current-password" />
              <button class="btn btn-outline-secondary" type="button" data-toggle="pw-current" title="แสดง/ซ่อน">
                👁
              </button>
            </div>
          </div>
          <div class="col-md-4">
            <label class="form-label">New password</label>
            <div class="input-group">
              <input type="password" class="form-control" id="pw-new" autocomplete="new-password" minlength="6" />
              <button class="btn btn-outline-secondary" type="button" data-toggle="pw-new" title="แสดง/ซ่อน">👁</button>
            </div>
            <small class="text-muted">อย่างน้อย 6 ตัวอักษร</small>
          </div>
          <div class="col-md-4">
            <label class="form-label">Confirm new password</label>
            <div class="input-group">
              <input type="password" class="form-control" id="pw-confirm" autocomplete="new-password" minlength="6" />
              <button class="btn btn-outline-secondary" type="button" data-toggle="pw-confirm" title="แสดง/ซ่อน">👁</button>
            </div>
          </div>
        </div>

        <div class="form-check mt-3">
          <input class="form-check-input" type="checkbox" id="pw-kill-others" checked />
          <label class="form-check-label" for="pw-kill-others">
            <strong>Force logout</strong> ทุก device อื่นหลังเปลี่ยน password (แนะนำ)
          </label>
        </div>

        <div class="mt-3 d-flex gap-2">
          <button class="btn btn-primary" id="pw-submit">🔑 เปลี่ยน Password</button>
          <span id="pw-status" class="small align-self-center"></span>
        </div>
      </div>
    </details>
  `;
}

// 1b. Bot Password Sync section (FIX-2026-08-10)
//   ใช้แก้กรณี unlock cooldown / สร้างบอท / หยุดบอท ยังใช้ password เก่า
//   เพราะ AppConfig.botActionPassword ว่าง (เปลี่ยน login password ก่อน sync fix deploy)
//   Sync จะ backfill botActionPassword = login password ปัจจุบัน (ต้อง verify ด้วย currentPassword)
function renderBotPasswordSyncSection() {
  const pw = state.passwordInfo || {};
  const syncedAt = pw.botActionPasswordChangedAt;
  const syncedIp = pw.botActionPasswordChangedFromIp || '';
  let statusHtml;
  if (syncedAt) {
    statusHtml = `<span class="text-success small">✅ Synced: <strong>${escapeHtml(formatDateTime(syncedAt))}</strong> �าก IP <code>${escapeHtml(syncedIp || '—')}</code></span>`;
  } else {
    statusHtml = `<span class="text-warning small">⚠️ �ังไม่เคย sync — bot action (unlock cooldown / สร้า�บอท / หยุดบอท) อาจใช้ password เก่า</span>`;
  }
  return `
    <details class="lux-details">
      <summary class="lux-details-summary">
        <span>🔄</span>
        <span>Sync Bot Password (unlock cooldown / สร้างบอท)</span>
      </summary>
      <div class="lux-details-body">
        <div class="alert alert-info small mb-3">
          <strong>📋 ใช้เมื่อ:</strong> หน้า <strong>unlock cooldown</strong>, <strong>สร้างบอท</strong>, <strong>หยุดบอท</strong>
          หรือ <strong>ยกเลิก cooldown</strong> ยังคงต้องใช้ password <strong>เก่า</strong> ที่ตั้งไว้ตอนแรก
          · กด <strong>Sync</strong> เพื่อบังคับให้ใช้ password ปัจจุบัน (ต้องกรอก current password เพื่อยืนยัน)
          · หลัง sync แล้ว <strong>ครั้งถัดไป</strong>ที่ unlock/create/stop จะใ�้ password ใหม่ได้ทันที
        </div>

        <div class="mb-2">
          ${statusHtml}
        </div>

        <div class="row g-2 align-items-end">
          <div class="col-md-7">
            <label class="form-label small">Current login password (เพื่อยืนยันตัวตน)</label>
            <div class="input-group">
              <input type="password" class="form-control" id="botpw-current" autocomplete="current-password" />
              <button class="btn btn-outline-secondary" type="button" data-toggle="botpw-current" title="แสดง/ซ่อน">👁</button>
            </div>
          </div>
          <div class="col-md-5">
            <button class="btn btn-warning w-100" id="botpw-sync-btn">🔄 Sync Bot Password กับ Login Password</button>
          </div>
        </div>
        <div class="small mt-2" id="botpw-status"></div>
      </div>
    </details>
  `;
}

// 2. Password Hint section
function renderHintSection(pw) {
  return `
    <details class="lux-details">
      <summary class="lux-details-summary">
        <span>💡</span>
        <span>Password Hint & Notes</span>
      </summary>
      <div class="lux-details-body">
        <div class="alert alert-warning small mb-3">
          ⚠️ <strong>สำหรับเตือนความจำส่วนตัวเท่านั้น</strong> — ไม่ใช่ security feature
          · คนที่ login เข้าระบบได้จะเ�็นข้อความนี้
          · <strong>ห้าม</strong>เขียน password จริงลงในนี้
        </div>

        <div class="mb-3">
          <label class="form-label">💡 Password Hint <span class="text-muted-3">(≤500 ตัวอักษร)</span></label>
          <textarea class="form-control" id="pw-hint" rows="2" maxlength="500" placeholder="เช่น &quot;อันที่ใช้กับเมลทำงาน&quot;">${escapeHtml(pw.hint || '')}</textarea>
          <div class="d-flex justify-content-between mt-1">
            <small class="text-muted">ตัวอย่าง: ใช้รหัสเดียวกับ WiFi บ้าน, อันที่จำง่ายสุด, อันที่ตั้งตอนย้ายบริษัท</small>
            <small class="text-muted-3" id="pw-hint-count">0 / 500</small>
          </div>
        </div>

        <div class="mb-3">
          <label class="form-label">📝 Notes / Security Log <span class="text-muted-3">(≤1000 ตัวอักษร)</span></label>
          <textarea class="form-control" id="pw-note" rows="4" maxlength="1000" placeholder="เช่น: rotated 2026-08-09 หลังเจอ login จาก IP ที่ไม่รู้จัก\n- ใช้ password manager X\n- 2FA: SMS only">${escapeHtml(pw.note || '')}</textarea>
          <div class="d-flex justify-content-between mt-1">
            <small class="text-muted">บันทึก audit log ส่วนตัว — เ�่น เมื่อเปลี่ยน ทำไม ใช้ password manager อะไร</small>
            <small class="text-muted-3" id="pw-note-count">0 / 1000</small>
          </div>
        </div>

        <div class="mt-3 d-flex gap-2">
          <button class="btn btn-primary" id="pw-info-save">💾 �ันทึก Hint/Notes</button>
          <span id="pw-info-status" class="small align-self-center"></span>
        </div>
      </div>
    </details>
  `;
}

// 3. Sessions Manager section
function renderSessionsSection() {
  const sessions = state.sessions || [];
  const othersCount = sessions.filter((s) => !s.isCurrent).length;
  const sessionRows = sessions.length === 0
    ? `<div class="text-muted-3 small py-3 text-center">ไม่พบ active session</div>`
    : sessions.map((s) => renderSessionRow(s)).join('');

  return `
    <details class="lux-details" open>
      <summary class="lux-details-summary">
        <span>🖥️</span>
        <span>Active Sessions <span class="text-muted-3 small">(${sessions.length})</span></span>
      </summary>
      <div class="lux-details-body">
        <div class="alert alert-info small mb-3">
          <strong>📋 ใช้ตรวจสอบ:</strong> ดูว่ามี device/IP แปลกปลอม login ค้างไว้หรือไม่
          · กด <strong>✕</strong> ลบ session ที่ไม่รู้จักทันที
          · <strong>Kill All Other Sessions</strong> ฆ่าทุก session ยกเ�้นเครื่องนี้ (กัน password รั่ว)
        </div>

        <div class="d-flex justify-content-between align-items-center mb-2">
          <div class="small text-muted-3">
            ${othersCount > 0
              ? `มี <strong class="text-warning">${othersCount}</strong> session �ื่นที่กำลัง active`
              : `<strong class="text-success">✅</strong> ไม่มี session อื่น — ปลอดภัย`}
          </div>
          <button class="btn-lux btn-bear btn-sm" id="kill-others-btn" ${othersCount === 0 ? 'disabled' : ''}>
            🧹 Kill All Other Sessions
          </button>
        </div>

        <div id="sessions-list">
          ${sessionRows}
        </div>

        <div class="mt-3 small text-muted-3">
          <strong>💡 เคล็ดลับ:</strong>
          ถ้าเห็น IP ที่ไม่รู้จัก → กด ✕ ลบทันที + ไปที่
          <a href="/settings.html">Settings</a> �รวจ Telegram + เปลี่ยน Binance API key
        </div>
      </div>
    </details>
  `;
}

function renderSessionRow(s) {
  const ip = escapeHtml(s.loginIp || 'unknown');
  const ua = escapeHtml((s.userAgent || '').slice(0, 120));
  const label = deviceLabel(s);
  const icon = deviceIcon(s.deviceLabel);
  const isCurrent = s.isCurrent;
  const loginAt = formatDateTime(s.loginAt);
  const lastSeen = timeAgo(s.lastSeenAt);
  const badge = isCurrent
    ? `<span class="badge bg-success ms-2">📍 This device</span>`
    : `<span class="badge bg-secondary ms-2">other device</span>`;

  return `
    <div class="session-row ${isCurrent ? 'is-current' : ''}" data-sid="${escapeHtml(s.sid)}">
      <div class="d-flex align-items-start justify-content-between gap-2">
        <div style="min-width: 0; flex: 1;">
          <div style="font-weight:600;">
            ${icon} ${escapeHtml(label)} ${badge}
          </div>
          <div class="small text-muted-3 mt-1" style="word-break: break-all;">
            🌐 IP: <code>${ip}</code>
          </div>
          <div class="small text-muted-3 mt-1">
            🔑 Login: ${loginAt} · 👁 Last active: ${lastSeen}
          </div>
          ${ua ? `<div class="small text-muted-3 mt-1" style="opacity:0.7;font-family:var(--font-mono);font-size:0.72rem;">${ua}</div>` : ''}
        </div>
        ${isCurrent
          ? `<button class="btn-lux btn-sm btn-ghost" disabled title="ไม่สามารถลบ session ปัจจุบัน">✕</button>`
          : `<button class="btn-lux btn-sm btn-bear" data-kill-sid="${escapeHtml(s.sid)}" title="Logout จากเครื่องนี้">✕ ลบ</button>`
        }
      </div>
    </div>
  `;
}

// 4. Failed Logins section (FIX-2026-08-09)
function renderFailedLoginsSection() {
  const attempts = state.loginAttempts || [];
  const f = state.attemptsFilter || {};
  // Apply client-side filters
  const filtered = attempts.filter((a) => {
    if (f.method && a.method !== f.method) return false;
    if (f.reason && a.reason !== f.reason) return false;
    return true;
  });
  const rows = filtered.length === 0
    ? `<div class="text-muted-3 small py-3 text-center">ไม่พบรายการ (TTL 30 วัน)</div>`
    : filtered.map((a) => renderAttemptRow(a)).join('');

  // Build reason options dynamically (from current data) so we only show reasons that exist
  const seenReasons = new Set(attempts.map((a) => a.reason).filter(Boolean));
  const REASON_LABEL = {
    'wrong-password':        'Wrong password',
    'locked':                'Locked (brute-force)',
    'rate-limited':          'Rate limited',
    'telegram-disabled':     'Telegram disabled',
    'telegram-event-disabled': 'Telegram event off',
    'otp-wrong':             'OTP wrong',
    'otp-locked':            'OTP locked',
    'otp-expired':           'OTP expired',
    'otp-malformed':         'OTP malformed',
    'otp-token-invalid':     'OTP token invalid',
  };

  return `
    <details class="lux-details">
      <summary class="lux-details-summary">
        <span>🚨</span>
        <span>Failed Logins <span class="text-muted-3 small">(${filtered.length}/${attempts.length})</span></span>
      </summary>
      <div class="lux-details-body">
        <div class="alert alert-warning small mb-3">
          <strong>📋 ใช้ตรวจสอบ:</strong> attempts ที่ login ด้วย password ผิด / OTP ผิด / ถูก lock
          · <strong>${attempts.length}</strong> attempts ใน 30 วันที่ผ่านมา
          · ถ้าเห็น IP ที่ไม่รู้จักหลายครั้ง → เปลี่ยน password + เช็ค Binance API key
        </div>

        <div class="d-flex flex-wrap gap-2 align-items-center mb-3">
          <label class="small text-muted-3">Method:</label>
          <select class="form-select form-select-sm" id="filter-method" style="width:auto;">
            <option value="" ${!f.method ? 'selected' : ''}>ทั้งหมด</option>
            <option value="password" ${f.method === 'password' ? 'selected' : ''}>🔑 Password</option>
            <option value="telegram-otp" ${f.method === 'telegram-otp' ? 'selected' : ''}>📨 Telegram OTP</option>
          </select>
          <label class="small text-muted-3 ms-2">Reason:</label>
          <select class="form-select form-select-sm" id="filter-reason" style="width:auto;">
            <option value="" ${!f.reason ? 'selected' : ''}>ทั้งหมด</option>
            ${Array.from(seenReasons).sort().map((r) =>
              `<option value="${escapeHtml(r)}" ${f.reason === r ? 'selected' : ''}>${escapeHtml(REASON_LABEL[r] || r)}</option>`
            ).join('')}
          </select>
          <button class="btn-lux btn-sm ms-auto" id="refresh-attempts-btn">🔄 Refresh</button>
        </div>

        <div id="attempts-list">
          ${rows}
        </div>
      </div>
    </details>
  `;
}

function renderAttemptRow(a) {
  const ip = escapeHtml(a.ip || 'unknown');
  const at = formatDateTime(a.at);
  const ago = timeAgo(a.at);
  const dl = a.deviceLabel || {};
  const label = `${dl.browser || 'Unknown'} บน ${dl.os || 'Unknown'}`;
  const icon = deviceIcon(dl);
  const ua = escapeHtml((a.userAgent || '').slice(0, 120));
  const REASON_BADGE = {
    'wrong-password':           '<span class="badge bg-danger">wrong password</span>',
    'locked':                   '<span class="badge bg-danger">🔒 locked</span>',
    'rate-limited':             '<span class="badge bg-warning text-dark">⏱ rate limited</span>',
    'telegram-disabled':        '<span class="badge bg-secondary">telegram disabled</span>',
    'telegram-event-disabled':  '<span class="badge bg-secondary">telegram event off</span>',
    'otp-wrong':                '<span class="badge bg-danger">OTP wrong</span>',
    'otp-locked':               '<span class="badge bg-danger">OTP locked</span>',
    'otp-expired':              '<span class="badge bg-warning text-dark">OTP expired</span>',
    'otp-malformed':            '<span class="badge bg-warning text-dark">OTP malformed</span>',
    'otp-token-invalid':        '<span class="badge bg-secondary">OTP token invalid</span>',
  };
  const methodIcon = a.method === 'telegram-otp' ? '📨' : '🔑';
  const methodLabel = a.method === 'telegram-otp' ? 'Telegram OTP' : 'Password';

  // FIX-2026-08-10: show attempted password (masked by default, click to reveal)
  //   Only for password-method attempts; empty for OTP/locked/rate-limited
  const attemptedPw = (a.attemptedPassword || '').trim();
  const hasPw = a.method === 'password' && attemptedPw.length > 0;
  const pwRow = hasPw ? `
    <div class="small mt-1" style="font-family: var(--font-mono);">
      🔑 ใช้รหัส: <code class="attempt-pw" data-pw="${escapeHtml(attemptedPw)}">${escapeHtml(maskPassword(attemptedPw))}</code>
      <button class="btn-lux btn-xs ms-1 toggle-pw-btn" title="แสดง/ซ่อนรหัสที่ใช้">👁</button>
    </div>` : '';

  return `
    <div class="attempt-row">
      <div class="d-flex align-items-start justify-content-between gap-2">
        <div style="min-width: 0; flex: 1;">
          <div style="font-weight:600;">
            ${methodIcon} ${escapeHtml(methodLabel)}
            ${REASON_BADGE[a.reason] || `<span class="badge bg-secondary">${escapeHtml(a.reason)}</span>`}
          </div>
          <div class="small text-muted-3 mt-1" style="word-break: break-all;">
            🌐 IP: <code>${ip}</code>
            · ${icon} ${escapeHtml(label)}
          </div>
          <div class="small text-muted-3 mt-1">
            ⏱ ${ago} · <span title="${escapeHtml(at)}">${escapeHtml(at)}</span>
          </div>
          ${pwRow}
          ${ua ? `<div class="small text-muted-3 mt-1" style="opacity:0.7;font-family:var(--font-mono);font-size:0.72rem;">${ua}</div>` : ''}
        </div>
      </div>
    </div>
  `;
}

// FIX-2026-08-10: maskPassword — UI-safe display of attempted password
//   Rules: empty → '—'; 1-2 chars → as-is; 3 chars → a*c; 4+ chars → first 2 + stars + last 1
function maskPassword(raw) {
  if (!raw) return '—';
  const s = String(raw);
  const len = s.length;
  if (len <= 2) return s;
  if (len === 3) return s[0] + '*' + s[2];
  return s.slice(0, 2) + '*'.repeat(len - 3) + s.slice(-1);
}

// ─── Events ────────────────────────────────────────────
function bindEvents() {
  // Toggle password visibility
  document.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-toggle');
      const input = document.getElementById(targetId);
      if (!input) return;
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '🙈';
      } else {
        input.type = 'password';
        btn.textContent = '👁';
      }
    });
  });

  // Submit change password
  const submitBtn = document.getElementById('pw-submit');
  if (submitBtn) submitBtn.addEventListener('click', onChangePassword);

  // Allow Enter to submit
  ['pw-current', 'pw-new', 'pw-confirm'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onChangePassword();
    });
  });

  // Bot password sync (FIX-2026-08-10)
  const botpwBtn = document.getElementById('botpw-sync-btn');
  if (botpwBtn) botpwBtn.addEventListener('click', onSyncBotPassword);
  const botpwInput = document.getElementById('botpw-current');
  if (botpwInput) botpwInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSyncBotPassword();
  });

  // Hint + Note
  const hintEl = document.getElementById('pw-hint');
  const noteEl = document.getElementById('pw-note');
  if (hintEl) {
    updateCount(hintEl, 'pw-hint-count', 500);
    hintEl.addEventListener('input', () => updateCount(hintEl, 'pw-hint-count', 500));
  }
  if (noteEl) {
    updateCount(noteEl, 'pw-note-count', 1000);
    noteEl.addEventListener('input', () => updateCount(noteEl, 'pw-note-count', 1000));
  }
  const saveBtn = document.getElementById('pw-info-save');
  if (saveBtn) saveBtn.addEventListener('click', onSaveHint);

  // Kill individual session
  document.querySelectorAll('[data-kill-sid]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sid = btn.getAttribute('data-kill-sid');
      await killSession(sid, btn);
    });
  });

  // Kill all others
  const killAllBtn = document.getElementById('kill-others-btn');
  if (killAllBtn) killAllBtn.addEventListener('click', killOthers);

  // Failed Logins: filter dropdowns + refresh
  const methodSel = document.getElementById('filter-method');
  const reasonSel = document.getElementById('filter-reason');
  if (methodSel) methodSel.addEventListener('change', () => {
    state.attemptsFilter.method = methodSel.value;
    render();
  });
  if (reasonSel) reasonSel.addEventListener('change', () => {
    state.attemptsFilter.reason = reasonSel.value;
    render();
  });
  const refreshBtn = document.getElementById('refresh-attempts-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshAttempts);

  // FIX-2026-08-10: Failed Logins — toggle reveal attempted password (event delegation)
  const attemptsList = document.getElementById('attempts-list');
  if (attemptsList) {
    attemptsList.addEventListener('click', (e) => {
      const btn = e.target.closest('.toggle-pw-btn');
      if (!btn) return;
      const code = btn.previousElementSibling;
      if (!code || !code.classList.contains('attempt-pw')) return;
      const raw = code.getAttribute('data-pw') || '';
      const revealed = code.getAttribute('data-revealed') === '1';
      if (revealed) {
        code.textContent = maskPassword(raw);
        code.setAttribute('data-revealed', '0');
        btn.textContent = '👁';
      } else {
        code.textContent = raw;
        code.setAttribute('data-revealed', '1');
        btn.textContent = '🙈';
      }
    });
  }
}

function updateCount(el, countId, max) {
  const counter = document.getElementById(countId);
  if (!counter) return;
  const len = el.value.length;
  counter.textContent = `${len} / ${max}`;
  counter.style.color = len > max * 0.9 ? 'var(--warn-1)' : 'var(--text-4)';
}

async function onChangePassword() {
  const current = document.getElementById('pw-current').value;
  const next = document.getElementById('pw-new').value;
  const confirm = document.getElementById('pw-confirm').value;
  const killOthers = document.getElementById('pw-kill-others').checked;
  const statusEl = document.getElementById('pw-status');
  const submitBtn = document.getElementById('pw-submit');

  if (!next || next.length < 6) {
    return setStatus(statusEl, '❌ Password ใหม่ต้องยาวอย่างน้อย 6 ตัวอักษร', 'bear');
  }
  if (next !== confirm) {
    return setStatus(statusEl, '❌ Password ใหม่กับ Confirm ไม่ตรงกัน', 'bear');
  }
  if (current && current === next) {
    return setStatus(statusEl, '❌ Password ใหม่ต้องไม่เหมือนของเดิม', 'bear');
  }

  submitBtn.disabled = true;
  setStatus(statusEl, '⏳ กำลังเปลี่ยน password…', 'muted');
  try {
    const r = await API.post('/api/auth/change-password', {
      currentPassword: current,
      newPassword: next,
      killOthers,
    });
    const killed = r.killedCount ? ` · logout ${r.killedCount} device อื่น` : '';
    setStatus(statusEl, `✅ เปลี่ยน password สำเร็จ${killed}`, 'bull');
    // clear inputs
    document.getElementById('pw-current').value = '';
    document.getElementById('pw-new').value = '';
    document.getElementById('pw-confirm').value = '';
    // reload
    setTimeout(() => loadAll(), 800);
  } catch (err) {
    setStatus(statusEl, `❌ ${err.message}`, 'bear');
  } finally {
    submitBtn.disabled = false;
  }
}

async function onSyncBotPassword() {
  const current = document.getElementById('botpw-current').value;
  const statusEl = document.getElementById('botpw-status');
  const btn = document.getElementById('botpw-sync-btn');

  if (!current) {
    return setStatus(statusEl, '❌ กรอก current login password เพื่อยืนยัน', 'bear');
  }

  btn.disabled = true;
  setStatus(statusEl, '⏳ กำลัง sync…', 'muted');
  try {
    await API.post('/api/auth/sync-bot-action-password', { currentPassword: current });
    setStatus(statusEl, '✅ Sync สำเร็จ — unlock cooldown / สร้างบอท / หยุดบอท จะใช้ password นี้ทันที', 'bull');
    document.getElementById('botpw-current').value = '';
    // reload to update "Synced:" timestamp
    setTimeout(() => loadAll(), 800);
  } catch (err) {
    setStatus(statusEl, `❌ ${err.message}`, 'bear');
  } finally {
    btn.disabled = false;
  }
}

async function onSaveHint() {
  const hint = document.getElementById('pw-hint').value;
  const note = document.getElementById('pw-note').value;
  const statusEl = document.getElementById('pw-info-status');
  const btn = document.getElementById('pw-info-save');

  btn.disabled = true;
  setStatus(statusEl, '⏳ กำลังบันทึก…', 'muted');
  try {
    const r = await API.put('/api/auth/password-info', {
      passwordHint: hint,
      passwordNote: note,
    });
    setStatus(statusEl, '✅ บันทึก hint/notes แล้ว', 'bull');
    state.passwordInfo = {
      ...state.passwordInfo,
      hint: r.hint,
      note: r.note,
      lastChangedAt: r.lastChangedAt,
      lastChangedFromIp: r.lastChangedFromIp,
    };
  } catch (err) {
    setStatus(statusEl, `❌ ${err.message}`, 'bear');
  } finally {
    btn.disabled = false;
  }
}

async function killSession(sid, btn) {
  if (!confirm(`ลบ session นี้?\nDevice ที่ login ด้วย session นี้จะถูก logout ทันที และต้อง login ใหม่`)) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ �ำลังลบ…';
  }
  try {
    await API.del(`/api/auth/sessions/${encodeURIComponent(sid)}`);
    // remove row from UI
    const row = document.querySelector(`.session-row[data-sid="${cssEscape(sid)}"]`);
    if (row) row.style.transition = 'opacity 0.3s', row.style.opacity = '0.3';
    setTimeout(() => loadAll(), 300);
  } catch (err) {
    alert(`ลบ session ไม่สำเร็จ: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '✕ ลบ'; }
  }
}

async function killOthers() {
  const othersCount = (state.sessions || []).filter((s) => !s.isCurrent).length;
  if (othersCount === 0) return;
  if (!confirm(`Logout ${othersCount} device อื่นทันที?\n\nDevice เหล่านั้นจะต้อง login ใหม่ด้วย password ปัจจุบัน`)) return;
  const btn = document.getElementById('kill-others-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ กำลังลบ…'; }
  try {
    const r = await API.post('/api/auth/sessions/kill-others', {});
    setTimeout(() => loadAll(), 300);
    // success indicator (auto-clears on reload)
  } catch (err) {
    alert(`Kill all others ไม่สำเร็จ: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '🧹 Kill All Other Sessions'; }
  }
}

// FIX-2026-08-09: refresh failed-logins list (button + 60s interval)
async function refreshAttempts() {
  const btn = document.getElementById('refresh-attempts-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳…'; }
  try {
    const r = await API.get('/api/auth/login-attempts?limit=100');
    state.loginAttempts = r.attempts || [];
    render();
  } catch (err) {
    alert(`Refresh ไม่สำเร็จ: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
  }
}

function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/"/g, '\\"');
}

function setStatus(el, msg, kind) {
  if (!el) return;
  el.textContent = msg;
  el.style.color = kind === 'bull' ? 'var(--bull-1)'
    : kind === 'bear' ? 'var(--bear-1)'
    : kind === 'warn' ? 'var(--warn-1)'
    : 'var(--text-3)';
  if (kind === 'bull') {
    setTimeout(() => {
      if (el.textContent === msg) el.textContent = '';
    }, 4000);
  }
}

// auto-refresh sessions + attempts every 60s
setInterval(async () => {
  try {
    const [sessRes, attRes] = await Promise.all([
      API.get('/api/auth/sessions'),
      API.get('/api/auth/login-attempts?limit=100'),
    ]);
    state.sessions = sessRes.sessions || [];
    state.currentSid = sessRes.currentSid;
    state.loginAttempts = attRes.attempts || [];
    // re-render only the affected sections (lightweight)
    const sessList = document.getElementById('sessions-list');
    if (sessList) {
      sessList.innerHTML = (state.sessions || []).map((s) => renderSessionRow(s)).join('');
      document.querySelectorAll('[data-kill-sid]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const sid = btn.getAttribute('data-kill-sid');
          await killSession(sid, btn);
        });
      });
    }
    const attList = document.getElementById('attempts-list');
    if (attList) {
      const f = state.attemptsFilter || {};
      const filtered = state.loginAttempts.filter((a) =>
        (!f.method || a.method === f.method) && (!f.reason || a.reason === f.reason)
      );
      attList.innerHTML = filtered.length === 0
        ? `<div class="text-muted-3 small py-3 text-center">ไม่พบรายการ (TTL 30 วัน)</div>`
        : filtered.map((a) => renderAttemptRow(a)).join('');
    }
  } catch (_) { /* silent */ }
}, 60 * 1000);

init();
