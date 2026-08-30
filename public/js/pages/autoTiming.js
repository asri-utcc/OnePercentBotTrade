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
    `<option value="${act}" ${act === a ? 'selected' : ''}>${actionBadgeEmoji(act)} ${act}</option>`).join('');
}

// UX-2026-08-30: visual cue for action dropdown — color-coded chip + emoji prefix
function actionBadgeEmoji(action) {
  const m = {
    allow: '✅', limit: '⚠️', encourage: '✨', stimulate: '⭐', suppress: '🚫',
  };
  return m[action] || '·';
}
function actionBadgeClass(action) {
  // used to color the first <td> in each row to scan suppress/limit at a glance
  const m = {
    allow: 'at-act-allow', limit: 'at-act-limit', encourage: 'at-act-encourage',
    stimulate: 'at-act-stimulate', suppress: 'at-act-suppress',
  };
  return m[action] || 'at-act-allow';
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
      <tr data-band="${safeBandName}" class="${actionBadgeClass(action)}">
        <td class="text-start align-middle">
          <div class="at-band-name"><code>${safeBandName}</code></div>
          <div class="text-muted small">${escapeHtml(bandLabel)}</div>
        </td>
        <td class="align-middle">
          <select class="form-select form-select-sm at-action" id="at-action-${safeBandName}" title="action หลัก">
            ${selectedAction(savedBand, def)}
          </select>
          <div class="at-act-emoji text-center small" id="at-act-emoji-${safeBandName}">${actionBadgeEmoji(action)} ${escapeHtml(action)}</div>
        </td>
        <td class="align-middle">
          <input type="number" step="0.05" min="0" max="3" class="form-control form-control-sm at-nomult text-center" id="at-nomult-${safeBandName}" value="${notionalMult}" title="× notional (0=block, 0.5=half, 1.2=+20%)" />
        </td>
        <td class="align-middle">
          <input type="number" step="1" min="0" max="50" class="form-control form-control-sm at-tp text-center" id="at-tp-${safeBandName}" value="${tpTighten}" title="ลด TP% จาก auto TP เช่น 20 → TP ตก 20% (0=keep)" />
        </td>
        <td class="align-middle">
          <input type="number" step="1" min="0" max="50" class="form-control form-control-sm at-sl text-center" id="at-sl-${safeBandName}" value="${slTighten}" title="ลด SL threshold (0=keep)" />
        </td>
        <td class="text-center align-middle">
          <input type="checkbox" class="form-check-input at-st1" id="at-st1-${safeBandName}" ${st1 ? 'checked' : ''} title="force ST1 — green-candle only" />
        </td>
        <td class="text-center align-middle">
          <input type="checkbox" class="form-check-input at-st2" id="at-st2-${safeBandName}" ${st2 ? 'checked' : ''} title="force ST2 — LuxAlgo red pivot-low" />
        </td>
        <td class="text-center align-middle">
          <input type="checkbox" class="form-check-input at-st3" id="at-st3-${safeBandName}" ${st3 ? 'checked' : ''} title="force ST3 — bearish-engulfing absence" />
        </td>
        <td class="text-center align-middle">
          <input type="checkbox" class="form-check-input at-cbv5" id="at-cbv5-${safeBandName}" ${cbv5 ? 'checked' : ''} title="force CBv5 — Support-Zone breaker" />
        </td>
        <td class="align-middle">
          <input type="number" step="0.05" min="0.5" max="2" class="form-control form-control-sm at-kc text-center" id="at-kc-${safeBandName}" value="${kcMult}" title="× minKcPct (0.5..2.0; <1=loosen)" />
        </td>
        <td class="align-middle">
          <input type="number" step="1" min="0" max="100" class="form-control form-control-sm at-mc text-center" id="at-mc-${safeBandName}" value="${maxCC === '' ? '' : maxCC}" placeholder="∞" title="max concurrent positions (เว้นว่าง=ไม่จำกัด)" />
        </td>
        <td class="align-middle">
          <input type="number" step="1" min="0" max="100" class="form-control form-control-sm at-mtd text-center" id="at-mtd-${safeBandName}" value="${maxTD === '' ? '' : maxTD}" placeholder="∞" title="max BUY/day (เว้นว่าง=ไม่จำกัด)" />
        </td>
        <td class="text-center align-middle">
          <button type="button" class="btn btn-outline-secondary btn-sm at-reset" data-band="${safeBandName}" title="reset row → default">↺</button>
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

    <h6 class="mt-4 mb-2">📖 Action legend (ก่อนปรับ knob)
      <a href="#" class="ms-2 small text-muted" id="at-legend-toggle">ซ่อน / แสดง</a>
    </h6>
    <div class="at-action-legend table-responsive" id="at-action-legend-table">
      <table class="table table-sm align-middle mb-3" style="min-width:600px;">
        <thead class="table-light">
          <tr>
            <th style="width:140px;">action</th>
            <th>ความหมาย</th>
            <th>ผลจริงต่อ BUY</th>
          </tr>
        </thead>
        <tbody>
          <tr class="at-row-allow">
            <td><strong>✅ allow</strong></td>
            <td>"<strong>ผ่านปกติ</strong>" — slot นี้ทำงานได้ตามปกติ ไม่ override อะไรเลย (default intent ของบอท)</td>
            <td>BUY ตาม <code>bot config</code> เดิม (notional เต็ม, TP auto, STx ตามที่บอทตั้ง, no clamp)</td>
          </tr>
          <tr class="at-row-stimulate">
            <td><strong>⭐ stimulate</strong></td>
            <td>"<strong>ดีมาก</strong>" — slot นี้ผลงานดีเด่น ดัน notional เพิ่มขึ้น</td>
            <td><code>notional × 1.2</code> (ดัน +20%) — entry ใหญ่ขึ้นเมื่อชนะบ่อย, TP/SL unchanged</td>
          </tr>
          <tr class="at-row-encourage">
            <td><strong>✨ encourage</strong></td>
            <td>"<strong>ดี</strong>" — slot ค่อนข้างดี กระตุ้นเบาๆ</td>
            <td><code>notional × 1.1</code> (boost +10%) — เพิ่มเล็กน้อย, ไม่บีบ TP/SL</td>
          </tr>
          <tr class="at-row-limit">
            <td><strong>⚠️ limit</strong></td>
            <td>"<strong>ระวัง</strong>" — slot พอใช้ได้แต่ควรลดความเสี่ยง</td>
            <td><code>notional × 0.5</code> + <strong>tight TP 30%</strong> + <strong>force ST1</strong> (green only) + <code>maxCC</code>/<code>maxTD</code> caps</td>
          </tr>
          <tr class="at-row-suppress">
            <td><strong>🚫 suppress</strong></td>
            <td>"<strong>ห้าม</strong>" — slot มีประวัติแย่มาก → block ไม่ให้ BUY ผ่าน</td>
            <td><code>notional = 0 → SKIP BUY</code> + Tier 2 cool-down <strong>90 วัน</strong> (กัน decay re-allow) + alert <code>autoTimingSuppressHit</code></td>
          </tr>
        </tbody>
      </table>
      <div class="alert alert-secondary small py-2 px-3 mb-3">
        💡 <strong>ทางลัด:</strong> <em>stricter</em> = allow → encourage → stimulate → limit → suppress (เรียงจาก "ผ่าน" → "ห้าม"; stimulate/encourage ทั้งคู่คือ "boost แต่ไม่ลดความเสี่ยง").<br />
        ⚙️ <strong>ค่า default ในแต่ละ band</strong> ตั้งให้ตรงกับประสบการณ์ทั่วไป (≤10 นาที = stimulate, 1–12 ชม. = allow, >2 วัน = suppress); กด <code>↺</code> reset row กลับเป็นค่า default ได้ทุกเมื่อ.
      </div>
    </div>

    <h6 class="mt-4 mb-2">🎚 Per-band knobs (5 bands × 10 attrs)
      <a href="#" class="ms-2 small text-muted" id="at-bands-help-link">📘 คำอธิบายแต่ละคอลัมน์</a>
    </h6>
    <div class="alert alert-secondary small py-2 px-3 mb-2" id="at-bands-help" style="display:none;">
      <strong>📘 Cheat-sheet:</strong>
      <ul class="mb-1">
        <li><strong>action</strong> — เลือก Suppress / Limit / Encourage / Stimulate / Allow; เป็นตัวคุม <em>overall vibe</em> ของ slot นี้</li>
        <li><strong>notional×</strong> — ตัวคูณ notional; <code>0</code> = block, <code>0.5</code> = ลดครึ่ง, <code>1.2</code> = +20% (ใช้กับ floor/ceiling ด้านบน)</li>
        <li><strong>TP tight %</strong> — <strong>ลด</strong> TP% <em>จาก auto-TP ที่ตั้งไว้</em> (เช่น TP ตั้งไว้ 0.5%, ตั้ง TP tight=20 → TP ตกเหลือ ~0.4%); <code>0</code> = ใช้ค่าเดิม</li>
        <li><strong>SL tight %</strong> — <strong>ลด</strong> SL threshold (คล้าย TP tight); <code>0</code> = ไม่บีบ</li>
        <li>
          <strong>fST1/fST2/fST3/fCBv5</strong> — <span class="badge bg-info text-dark">slot-aware</span> เปิดที่นี่ = จะทำงานเฉพาะ
          <em>ช่วงเวลาที่ heatmap-classifier เลือก band นี้</em> (เช่น ถ้า cell "จันทร์ 14:00" classify ได้ <code>lt12h</code> = allow, <em>และ</em> แถว <code>lt12h</code> ติ๊ก <code>fST1</code> = on,
          บอทจะถูกบังคับ green-candle only เฉพาะจันทร์ 14:00 เท่านั้น) — นอกช่วง slot ที่ classify ออกมาเป็น band นี้ บอทใช้ค่า default ตาม <code>bot.safeTradeEnabled</code> / <code>bot.cbv5Enabled</code> ตามปกติ
        </li>
        <li>
          <strong>ทำไมไม่มี fCBv3</strong> — CBv3 ไม่ใช่ breaker ตัวใหม่ แต่เป็น "<strong>CBv2 architecture + ST3 upper-TF</strong>" (อยู่ใน master toggle <code>cbVersion</code> = v3); ถ้าอยากได้ CBv3-สไตล์ใน slot นี้
          ให้ติ๊ก <code>fST3</code> + ตั้ง main Settings → <em>CB Version</em> = v3 (ระบบจะเปิด ST3 upper-TF ทุกที่อยู่แล้ว + fST3 บีบใน slot นี้เพิ่ม)
        </li>
        <li><strong>minKc×</strong> — ตัวคูณ <code>autoPauseMinKcPct</code> ของบอท (0.5..2.0; ลด = อนุญาตให้ %KC ต่ำลง)</li>
        <li><strong>maxCC</strong> — จำกัด positions เปิดพร้อมกันจาก cell นี้ (เว้นว่าง = ∞)</li>
        <li><strong>maxTD</strong> — จำกัด BUY/day จาก cell นี้ (เว้นว่าง = ∞)</li>
        <li><strong>↺</strong> — reset row กลับค่า default</li>
      </ul>
    </div>

    <div class="at-bands-scroll">
      <table class="table table-sm table-bordered align-middle text-center mb-2 at-bands-table" id="at-bands-table">
        <colgroup>
          <col style="width:160px;">  <!-- band -->
          <col style="width:140px;">  <!-- action -->
          <col style="width:90px;">   <!-- notional× -->
          <col style="width:90px;">   <!-- TP tight -->
          <col style="width:90px;">   <!-- SL tight -->
          <col style="width:60px;">   <!-- fST1 -->
          <col style="width:60px;">   <!-- fST2 -->
          <col style="width:60px;">   <!-- fST3 -->
          <col style="width:60px;">   <!-- fCBv5 -->
          <col style="width:80px;">   <!-- minKc× -->
          <col style="width:80px;">   <!-- maxCC -->
          <col style="width:80px;">   <!-- maxTD -->
          <col style="width:60px;">   <!-- ↺ -->
        </colgroup>
        <thead class="table-light">
          <tr class="at-bands-superhdr text-muted-2 small">
            <th colspan="2" class="text-start">🪪 Slot</th>
            <th colspan="3">💵 Notional &amp; Exit</th>
            <th colspan="4">🔒 Force filters</th>
            <th>📏 KC adj.</th>
            <th colspan="2">⏱ Daily limits</th>
            <th></th>
          </tr>
          <tr>
            <th class="text-start" title="ชื่อ hold-band (lt10m/lt1h/...) + label ภาษาไทย">band</th>
            <th title="action หลัก — คุม overall vibe ของ slot นี้">action</th>
            <th title="ตัวคูณ notional บน base (0 = block, 0.5 = ลดครึ่ง, 1.2 = +20%)">notional×</th>
            <th title="ลด TP% จากค่า auto TP ที่ตั้งไว้ (เช่น 20 → TP ตก 20% ของ 0.5% = ~0.4%)">TP tight %</th>
            <th title="ลด SL threshold (คล้าย TP tight)">SL tight %</th>
            <th title="slot-aware: บังคับ ST1 (green-candle) เฉพาะ cell ที่ classify เป็น band นี้">fST1</th>
            <th title="slot-aware: บังคับ ST2 (LuxAlgo red pivot-low) เฉพาะ cell ที่ classify เป็น band นี้">fST2</th>
            <th title="slot-aware: บังคับ ST3 (no-trade pattern) เฉพาะ cell ที่ classify เป็น band นี้ — ใช้ร่วมกับ main Settings CB Version=v3 เพื่อเลียนแบบ CBv3">fST3</th>
            <th title="slot-aware: บังคับ CBv5 (Support-Zone breaker) เฉพาะ cell ที่ classify เป็น band นี้">fCBv5</th>
            <th title="× บน autoPauseMinKcPct (0.5..2.0; ต่ำกว่า 1 = ผ่อน)">minKc×</th>
            <th title="max positions เปิดพร้อมกันจาก cell นี้ (เว้นว่าง = ∞)">maxCC</th>
            <th title="max BUY/day จาก cell นี้ (เว้นว่าง = ∞)">maxTD</th>
            <th title="reset row กลับค่า default">↺</th>
          </tr>
        </thead>
        <tbody>${bandRows}</tbody>
      </table>
    </div>
    <div class="text-muted small mb-2">
      💡 <strong>Tip:</strong> แต่ละ cell (จันทร์ 02:00, อังคาร 14:00, ...) จะใช้ knob ของ <em>hold-band</em> ที่ cell นั้น classify ได้; ค่าเริ่มต้นทำเครื่องหมายด้วย <code>↺</code>
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
    // re-stamp row class + emoji caption
    const actionSel = row.querySelector('.at-action');
    if (actionSel && typeof actionSel.onchange === 'function') actionSel.onchange();
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

  // UX-2026-08-30: help-block toggle
  const helpLink = document.getElementById('at-bands-help-link');
  const helpBlock = document.getElementById('at-bands-help');
  if (helpLink && helpBlock) {
    helpLink.onclick = (e) => {
      e.preventDefault();
      const visible = helpBlock.style.display !== 'none';
      helpBlock.style.display = visible ? 'none' : 'block';
      helpLink.textContent = visible ? '📘 คำอธิบายแต่ละคอลัมน์' : '❌ ปิดคำอธิบาย';
    };
  }

  // UX-2026-08-30: action legend toggle (default open)
  const legendLink = document.getElementById('at-legend-toggle');
  const legendTable = document.getElementById('at-action-legend-table');
  if (legendLink && legendTable) {
    legendLink.onclick = (e) => {
      e.preventDefault();
      const visible = legendTable.style.display !== 'none';
      legendTable.style.display = visible ? 'none' : 'block';
    };
  }

  // UX-2026-08-30: action dropdown — update row colour + emoji caption live
  document.querySelectorAll('#at-bands-table .at-action').forEach((sel) => {
    sel.onchange = () => {
      const row = sel.closest('tr');
      const bandId = row && row.getAttribute('data-band');
      if (!row || !bandId) return;
      const action = sel.value || 'allow';
      // strip existing action class
      const classesToStrip = ['at-act-allow', 'at-act-limit', 'at-act-encourage', 'at-act-stimulate', 'at-act-suppress'];
      classesToStrip.forEach((c) => row.classList.remove(c));
      row.classList.add(actionBadgeClass(action));
      const cap = document.getElementById('at-act-emoji-' + bandId);
      if (cap) cap.innerHTML = actionBadgeEmoji(action) + ' ' + escapeHtml(action);
    };
  });

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
      // re-stamp row class + emoji caption from new action value
      const actionSel = row.querySelector('.at-action');
      if (actionSel && typeof actionSel.onchange === 'function') actionSel.onchange();
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
