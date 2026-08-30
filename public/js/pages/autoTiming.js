'use strict';

// FIX-2026-08-30 / Phase 4: Auto-Timing Settings UI
//   - Master toggle + lookback/recent weighting/cooldown knobs
//   - 5-band editor (1 row per band: action + 10 knobs + "Reset to default")
//   - Save + Run-now + reset-to-defaults
//   - Wired by settings.js:renderAutoTimingSection() mount + bindAutoTimingSection()
//   - Sits between Auto-adjust Auto-pause (renderAutoPauseAdjustSection) and CB Version

window.AUTO_TIMING_VALID_ACTIONS = ['allow', 'limit', 'encourage', 'stimulate', 'suppress'];

function getAutoTimingCfg() {
  // settings.js sets window.AUTO_TIMING_CFG before calling render()
  return window.AUTO_TIMING_CFG || { config: null, status: null, bands: [], defaultBands: {} };
}

function getAutoTimingDefaultBands() {
  return getAutoTimingCfg().defaultBands || {};
}

function bandActionsFor(bandId) {
  return window.AUTO_TIMING_VALID_ACTIONS
    .map((a) => `<option value="${a}">${a}</option>`).join('');
}

function selectedAction(band, defaultBand) {
  const a = (band && band.action) || (defaultBand && defaultBand.action) || 'allow';
  return window.AUTO_TIMING_VALID_ACTIONS.map((act) =>
    `<option value="${act}" ${act === a ? 'selected' : ''}>${act}</option>`).join('');
}

function numOr(v, fallback) {
  return (v === undefined || v === null || Number.isNaN(Number(v))) ? fallback : Number(v);
}

function renderAutoTimingSection() {
  const data = getAutoTimingCfg();
  const cfg = (data && data.config) || {};
  const status = (data && data.status) || {};
  // bands[] is HOLD_BANDS from API ({id, maxMin, rgb, label}); or fall back to Object.keys(defaults)
  const bandsArr = (data && data.bands) || [];
  const bandIds = (bandsArr.length > 0 && bandsArr[0] && bandsArr[0].id)
    ? bandsArr.map((b) => b.id)
    : Object.keys(getAutoTimingDefaultBands());
  const defaults = getAutoTimingDefaultBands();
  const enabled = !!cfg.autoTimingEnabled;
  const lookback = numOr(cfg.autoTimingLookbackDays, 30);
  const recent = numOr(cfg.autoTimingRecentDays, 7);
  const recentW = numOr(cfg.autoTimingRecentWeight, 1.5);
  const normalW = numOr(cfg.autoTimingNormalWeight, 1.0);
  const cooldown = numOr(cfg.autoTimingSuppressCooldownDays, 90);
  const minEnforce = numOr(cfg.autoTimingMinTradesEnforce, 10);
  const minShow = numOr(cfg.autoTimingMinTradesShow, 3);
  const floor = numOr(cfg.autoTimingMinNotionalFloorUSDT, 10);
  const ceiling = numOr(cfg.autoTimingMaxNotionalCeilingUSDT, 200);
  const lastRunAt = cfg.autoTimingLastRunAt ? new Date(cfg.autoTimingLastRunAt).toLocaleString() : '—';
  const lastStats = cfg.autoTimingLastStats || null;
  const tickCount = status.tickCount != null ? status.tickCount : 0;
  const inFlight = status.inFlight ? '⏳ in-flight' : '';

  // Build the band-indexed view: walk through bandIds (HOLD_BANDS[].id or defaults key)
  const bandRows = bandIds.map((bandId, idx) => {
    const bandLabel = (bandsArr.length > 0 && bandsArr[idx] && bandsArr[idx].label)
      ? bandsArr[idx].label : bandId;
    const bandName = bandId;
    const savedBand = (cfg.autoTimingBands && cfg.autoTimingBands[bandId]) || {};
    const def = (defaults[bandId]) || {};
    const action = savedBand.action || def.action || 'allow';
    const notionalMult = numOr(savedBand.notionalMult, def.notionalMult != null ? def.notionalMult : 1);
    const tpTighten = numOr(savedBand.tpTightenPct, def.tpTightenPct != null ? def.tpTightenPct : 0);
    const slTighten = numOr(savedBand.slTightenPct, def.slTightenPct != null ? def.slTightenPct : 0);
    const st1 = !!(savedBand.forceST1 != null ? savedBand.forceST1 : def.forceST1);
    const st2 = !!(savedBand.forceST2 != null ? savedBand.forceST2 : def.forceST2);
    const st3 = !!(savedBand.forceST3 != null ? savedBand.forceST3 : def.forceST3);
    const cbv5 = !!(savedBand.forceCBv5 != null ? savedBand.forceCBv5 : def.forceCBv5);
    const kcMult = numOr(savedBand.minKcMult, def.minKcMult != null ? def.minKcMult : 1);
    const maxCC = savedBand.maxConcurrent != null ? savedBand.maxConcurrent : (def.maxConcurrent != null ? def.maxConcurrent : '');
    const maxTD = savedBand.maxTradesPerDay != null ? savedBand.maxTradesPerDay : (def.maxTradesPerDay != null ? def.maxTradesPerDay : '');
    const safeBandName = escapeHtml(bandName);

    return `
      <tr data-band="${safeBandName}">
        <td class="text-start align-middle"><code>${safeBandName}</code> <span class="text-muted small">${escapeHtml(bandLabel)}</span></td>
        <td class="align-middle">
          <select class="form-select form-select-sm at-action" id="at-action-${safeBandName}">
            ${selectedAction(savedBand, def)}
          </select>
        </td>
        <td class="align-middle">
          <input type="number" step="0.05" min="0" max="3" class="form-control form-control-sm at-nomult" id="at-nomult-${safeBandName}" value="${notionalMult}" title="Multiplier บน base notional" />
        </td>
        <td class="align-middle">
          <input type="number" step="1" min="0" max="50" class="form-control form-control-sm at-tp" id="at-tp-${safeBandName}" value="${tpTighten}" title="% ลด TP" />
        </td>
        <td class="align-middle">
          <input type="number" step="1" min="0" max="50" class="form-control form-control-sm at-sl" id="at-sl-${safeBandName}" value="${slTighten}" title="% ลด SL" />
        </td>
        <td class="text-center align-middle">
          <input type="checkbox" class="form-check-input at-st1" id="at-st1-${safeBandName}" ${st1 ? 'checked' : ''} title="forceST1 green candle" />
        </td>
        <td class="text-center align-middle">
          <input type="checkbox" class="form-check-input at-st2" id="at-st2-${safeBandName}" ${st2 ? 'checked' : ''} title="forceST2 LuxAlgo" />
        </td>
        <td class="text-center align-middle">
          <input type="checkbox" class="form-check-input at-st3" id="at-st3-${safeBandName}" ${st3 ? 'checked' : ''} title="forceST3 no-trade" />
        </td>
        <td class="text-center align-middle">
          <input type="checkbox" class="form-check-input at-cbv5" id="at-cbv5-${safeBandName}" ${cbv5 ? 'checked' : ''} title="force CBv5" />
        </td>
        <td class="align-middle">
          <input type="number" step="0.05" min="0.5" max="2" class="form-control form-control-sm at-kc" id="at-kc-${safeBandName}" value="${kcMult}" title="× on autoPauseMinKcPct" />
        </td>
        <td class="align-middle">
          <input type="number" step="1" min="0" max="100" class="form-control form-control-sm at-mc" id="at-mc-${safeBandName}" value="${maxCC === '' ? '' : maxCC}" placeholder="∞" title="max concurrent (null=∞)" />
        </td>
        <td class="align-middle">
          <input type="number" step="1" min="0" max="100" class="form-control form-control-sm at-mtd" id="at-mtd-${safeBandName}" value="${maxTD === '' ? '' : maxTD}" placeholder="∞" title="max trades/day (null=∞)" />
        </td>
        <td class="text-center align-middle">
          <button type="button" class="btn btn-outline-secondary btn-sm at-reset" data-band="${safeBandName}" title="Reset row to default">↺</button>
        </td>
      </tr>
    `;
  }).join('');

  return sectionHTML('sec-auto-timing', '⏱', 'Auto-Timing — Heatmap-driven entry gate (Suppress/Limit/Allow/Stimulate)', false, `
    <div class="alert alert-info small mb-3">
      <strong>📌 วิธีทำงาน:</strong> ทุก 30 นาทีระบบ aggregate trades 30 วันล่าสุด (weighted) ลงใน 7×24 cells (day-of-week × hour-of-day)
      แล้ว classify per <em>hold-band</em> (lt10m/lt1h/lt12h/lt48h/gt48h) เป็น <code>Suppress / Limit / Encourage / Stimulate / Allow</code>.
      <br />• Suppress → block BUY · Limit → ลด notional + tight TP + force ST1 · Encourage → bump notional 1.1× · Stimulate → +20% notional · Allow → pass-through
      <br />⚠️ <strong>License:</strong> ต้องเปิด feature <code>autoTiming</code> ใน license + per-bot opt-in <code>bot.autoTimingEnabled=true</code>
    </div>

    <div class="mb-3">
      <label class="form-check form-switch">
        <input type="checkbox" class="form-check-input" id="at-enabled" ${enabled ? 'checked' : ''} />
        <span class="form-check-label"><strong>เปิด Auto-Timing</strong> — master toggle (per-bot ยังต้อง opt-in ในช่อง Bot)</span>
      </label>
    </div>

    <h6 class="mt-3 mb-2">📚 Aggregation knobs</h6>
    <div class="row g-3">
      <div class="col-md-3">
        <label class="form-label">📅 Lookback (วัน)</label>
        <input type="number" class="form-control form-control-sm" id="at-lookback" value="${lookback}" min="7" max="90" />
        <small class="text-muted">window หลัก (default 30)</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">⭐ Recent days</label>
        <input type="number" class="form-control form-control-sm" id="at-recent" value="${recent}" min="1" max="30" />
        <small class="text-muted">1–N = × recent_weight</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">⚖️ Recent ×</label>
        <input type="number" step="0.05" class="form-control form-control-sm" id="at-recentw" value="${recentW}" min="1" max="2.5" />
        <small class="text-muted">× weight บน recent window</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">⚖️ Normal ×</label>
        <input type="number" step="0.05" class="form-control form-control-sm" id="at-normalw" value="${normalW}" min="0.5" max="1.5" />
        <small class="text-muted">× weight บน window ปกติ</small>
      </div>
    </div>
    <div class="row g-3 mt-1">
      <div class="col-md-3">
        <label class="form-label">❄️ Suppress cooldown (วัน)</label>
        <input type="number" class="form-control form-control-sm" id="at-cooldown" value="${cooldown}" min="30" max="365" />
        <small class="text-muted">Tier 2 ever-bad lock</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">📊 Min trades (enforce)</label>
        <input type="number" class="form-control form-control-sm" id="at-minEnforce" value="${minEnforce}" min="1" max="100" />
        <small class="text-muted">≥ = apply band action</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">👁 Min trades (show)</label>
        <input type="number" class="form-control form-control-sm" id="at-minShow" value="${minShow}" min="1" max="50" />
        <small class="text-muted">[show, enforce) = advisory</small>
      </div>
    </div>

    <h6 class="mt-4 mb-2">💵 Notional clamp</h6>
    <div class="row g-3">
      <div class="col-md-3">
        <label class="form-label">🔻 Min floor (USDT)</label>
        <input type="number" class="form-control form-control-sm" id="at-floor" value="${floor}" min="1" max="1000" />
        <small class="text-muted">below → SKIP BUY</small>
      </div>
      <div class="col-md-3">
        <label class="form-label">🔺 Max ceiling (USDT)</label>
        <input type="number" class="form-control form-control-sm" id="at-ceiling" value="${ceiling}" min="10" max="10000" />
        <small class="text-muted">above → cap only</small>
      </div>
    </div>

    <h6 class="mt-4 mb-2">🎚 Per-band knobs (5 bands × 10 attrs)</h6>
    <div class="table-responsive">
      <table class="table table-sm table-bordered align-middle text-center mb-2" id="at-bands-table">
        <thead class="table-light">
          <tr>
            <th>band</th>
            <th>action</th>
            <th>notional×</th>
            <th>TP↓%</th>
            <th>SL↓%</th>
            <th>fST1</th>
            <th>fST2</th>
            <th>fST3</th>
            <th>fCBv5</th>
            <th>minKc×</th>
            <th>maxCC</th>
            <th>maxTD</th>
            <th>↺</th>
          </tr>
        </thead>
        <tbody>${bandRows}</tbody>
      </table>
    </div>

    <div class="mt-3">
      <button type="button" class="btn btn-primary" id="btn-save-at">💾 บันทึก Auto-Timing</button>
      <button type="button" class="btn btn-outline-warning ms-2" id="btn-trigger-at">🖐 Run now</button>
      <button type="button" class="btn btn-outline-secondary ms-2" id="btn-reset-all-at">↺ Reset bands → defaults</button>
      <span class="ms-2 text-muted small" id="at-status"></span>
    </div>

    <div class="text-muted small mt-3">
      <strong>สถานะ:</strong> ${enabled ? '🟢 enabled' : '⚪ disabled'} · interval=${status.intervalMinutes || '?'}min · lastRunAt=${lastRunAt} · tickCount=${tickCount} ${inFlight}
      ${lastStats ? `<br /><strong>Last stats:</strong> ${escapeHtml(JSON.stringify(lastStats))}` : ''}
      ${cfg.autoTimingLastError ? `<br /><strong>Last error:</strong> <span class="text-danger">${escapeHtml(cfg.autoTimingLastError)}</span>` : ''}
    </div>
  `);
}

function sectionHTML(id, icon, title, defaultOpen, body) {
  // local copy of settings.js `section()` to keep the file standalone
  const openAttr = defaultOpen ? 'open' : '';
  return `
    <details id="${id}" class="lux-details mb-3" ${openAttr}>
      <summary class="lux-summary">
        <span class="lux-icon">${icon}</span>
        <span class="lux-title">${escapeHtml(title)}</span>
      </summary>
      <div class="lux-body">${body}</div>
    </details>
  `;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collectAutoTimingBands() {
  const defaults = getAutoTimingDefaultBands();
  const rows = document.querySelectorAll('#at-bands-table tbody tr');
  const bands = {};
  rows.forEach((row) => {
    const bandId = row.getAttribute('data-band');
    const def = defaults[bandId] || {};
    const action = (row.querySelector('.at-action') || {}).value || def.action || 'allow';
    const numIn = (sel) => {
      const el = row.querySelector(sel);
      if (!el) return undefined;
      const v = el.value;
      if (v === '' || v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const cb = (sel) => {
      const el = row.querySelector(sel);
      return el ? !!el.checked : undefined;
    };
    const cleaned = {
      bandId,
      action,
    };
    const nomult = numIn('.at-nomult');
    if (nomult !== undefined && nomult !== null) cleaned.notionalMult = nomult;
    const tp = numIn('.at-tp');
    if (tp !== undefined && tp !== null) cleaned.tpTightenPct = tp;
    const sl = numIn('.at-sl');
    if (sl !== undefined && sl !== null) cleaned.slTightenPct = sl;
    ['.at-st1', '.at-st2', '.at-st3', '.at-cbv5'].forEach((sel, i) => {
      const keys = ['forceST1', 'forceST2', 'forceST3', 'forceCBv5'];
      const v = cb(sel);
      if (v !== undefined) cleaned[keys[i]] = v;
    });
    const kcMult = numIn('.at-kc');
    if (kcMult !== undefined && kcMult !== null) cleaned.minKcMult = kcMult;
    const mc = numIn('.at-mc');
    if (mc !== undefined) cleaned.maxConcurrent = mc;
    const mtd = numIn('.at-mtd');
    if (mtd !== undefined) cleaned.maxTradesPerDay = mtd;
    bands[bandId] = cleaned;
  });
  return bands;
}

async function saveAutoTimingSection() {
  const setStatus = (text, isError) => {
    const el = document.getElementById('at-status');
    if (el) {
      el.textContent = text;
      el.className = 'ms-2 small ' + (isError ? 'text-danger' : 'text-success');
    }
  };
  const enabled = !!document.getElementById('at-enabled').checked;
  const lookback = parseInt(document.getElementById('at-lookback').value, 10);
  const recent = parseInt(document.getElementById('at-recent').value, 10);
  const recentW = parseFloat(document.getElementById('at-recentw').value);
  const normalW = parseFloat(document.getElementById('at-normalw').value);
  const cooldown = parseInt(document.getElementById('at-cooldown').value, 10);
  const minEnforce = parseInt(document.getElementById('at-minEnforce').value, 10);
  const minShow = parseInt(document.getElementById('at-minShow').value, 10);
  const floor = parseFloat(document.getElementById('at-floor').value);
  const ceiling = parseFloat(document.getElementById('at-ceiling').value);
  if (floor > ceiling) { setStatus('❌ floor ต้อง ≤ ceiling', true); return; }
  const bands = collectAutoTimingBands();
  try {
    const resp = await API.put('/api/auto-timing/config', {
      autoTimingEnabled: enabled,
      autoTimingLookbackDays: lookback,
      autoTimingRecentDays: recent,
      autoTimingRecentWeight: recentW,
      autoTimingNormalWeight: normalW,
      autoTimingSuppressCooldownDays: cooldown,
      autoTimingMinTradesEnforce: minEnforce,
      autoTimingMinTradesShow: minShow,
      autoTimingMinNotionalFloorUSDT: floor,
      autoTimingMaxNotionalCeilingUSDT: ceiling,
      autoTimingBands: bands,
    });
    setStatus('✅ บันทึกแล้ว · scheduler ' + (enabled ? '▶️ running' : '⏹ stopped') + ' · reload applied');
    if (window.SOUND_SUCCESS) window.SOUND_SUCCESS();
    // refresh in-memory cfg (visual values already mirror the input fields)
    if (typeof window.AutoTimingUI.loadConfig === 'function') {
      await window.AutoTimingUI.loadConfig();
    }
  } catch (err) {
    const msg = (err && err.body && err.body.error) || err.message || 'unknown';
    const errs = (err && err.body && err.body.errors) || [];
    setStatus('❌ ' + msg + (errs.length ? ' — ' + errs.join('; ') : ''), true);
  }
}

async function triggerAutoTimingSection() {
  const setStatus = (text, isError) => {
    const el = document.getElementById('at-status');
    if (el) {
      el.textContent = text;
      el.className = 'ms-2 small ' + (isError ? 'text-danger' : 'text-success');
    }
  };
  setStatus('⏳ กำลังรัน...');
  try {
    const resp = await API.post('/api/auto-timing/run-now', {});
    setStatus('✅ run-now เสร็จ · ok=' + (resp && resp.ok));
  } catch (err) {
    setStatus('❌ ' + (err.message || 'failed'), true);
  }
}

function resetAutoTimingBandsToDefaults() {
  const defaults = getAutoTimingDefaultBands();
  document.querySelectorAll('#at-bands-table tbody tr').forEach((row) => {
    const bandId = row.getAttribute('data-band');
    const def = defaults[bandId] || {};
    const setVal = (sel, v) => { const el = row.querySelector(sel); if (el != null) el.value = v === null || v === undefined ? '' : v; };
    const setChecked = (sel, v) => { const el = row.querySelector(sel); if (el) el.checked = !!v; };
    setVal('.at-action', def.action || 'allow');
    setVal('.at-nomult', def.notionalMult != null ? def.notionalMult : 1);
    setVal('.at-tp', def.tpTightenPct != null ? def.tpTightenPct : 0);
    setVal('.at-sl', def.slTightenPct != null ? def.slTightenPct : 0);
    setChecked('.at-st1', def.forceST1);
    setChecked('.at-st2', def.forceST2);
    setChecked('.at-st3', def.forceST3);
    setChecked('.at-cbv5', def.forceCBv5);
    setVal('.at-kc', def.minKcMult != null ? def.minKcMult : 1);
    setVal('.at-mc', def.maxConcurrent != null ? def.maxConcurrent : '');
    setVal('.at-mtd', def.maxTradesPerDay != null ? def.maxTradesPerDay : '');
  });
  const el = document.getElementById('at-status');
  if (el) {
    el.textContent = '↺ Bands reset to defaults — กด "บันทึก" เพื่อ apply';
    el.className = 'ms-2 small text-warning';
  }
}

function bindAutoTimingSectionEvents() {
  const btnSave = document.getElementById('btn-save-at');
  if (btnSave) btnSave.onclick = saveAutoTimingSection;
  const btnTrigger = document.getElementById('btn-trigger-at');
  if (btnTrigger) btnTrigger.onclick = triggerAutoTimingSection;
  const btnResetAll = document.getElementById('btn-reset-all-at');
  if (btnResetAll) btnResetAll.onclick = resetAutoTimingBandsToDefaults;
  document.querySelectorAll('.at-reset').forEach((btn) => {
    btn.onclick = () => {
      const bandId = btn.getAttribute('data-band');
      const def = (getAutoTimingDefaultBands())[bandId] || {};
      const row = document.querySelector(`#at-bands-table tr[data-band="${bandId}"]`);
      if (!row) return;
      const setVal = (sel, v) => { const el = row.querySelector(sel); if (el != null) el.value = v === null || v === undefined ? '' : v; };
      const setChecked = (sel, v) => { const el = row.querySelector(sel); if (el) el.checked = !!v; };
      setVal('.at-action', def.action || 'allow');
      setVal('.at-nomult', def.notionalMult != null ? def.notionalMult : 1);
      setVal('.at-tp', def.tpTightenPct != null ? def.tpTightenPct : 0);
      setVal('.at-sl', def.slTightenPct != null ? def.slTightenPct : 0);
      setChecked('.at-st1', def.forceST1);
      setChecked('.at-st2', def.forceST2);
      setChecked('.at-st3', def.forceST3);
      setChecked('.at-cbv5', def.forceCBv5);
      setVal('.at-kc', def.minKcMult != null ? def.minKcMult : 1);
      setVal('.at-mc', def.maxConcurrent != null ? def.maxConcurrent : '');
      setVal('.at-mtd', def.maxTradesPerDay != null ? def.maxTradesPerDay : '');
    };
  });
}

// expose
window.AutoTimingUI = {
  render: renderAutoTimingSection,
  bind: bindAutoTimingSectionEvents,
  save: saveAutoTimingSection,
  trigger: triggerAutoTimingSection,
  resetBands: resetAutoTimingBandsToDefaults,
  loadConfig: async function () {
    try {
      const r = await API.get('/api/auto-timing/config');
      window.AUTO_TIMING_CFG = r;
      return r;
    } catch (err) {
      console.warn('auto-timing config load failed:', err.message);
      window.AUTO_TIMING_CFG = { config: null, status: null, bands: [], defaultBands: {} };
      return window.AUTO_TIMING_CFG;
    }
  },
};
