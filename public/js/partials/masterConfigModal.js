'use strict';

/* ─────────────────────────────────────────────────────────
   Master Config Modal — bulk-edit หลายบอทพร้อมกัน (clobber mode)
   - FIX-2026-08-01
   - ดึง list บอททั้งหมด → default tick ทุกบอทที่ enabled
   - ฟอร์มเดียวกับ edit bot form + safe-trade + auto-pause
   - "Set to N bots" → POST /api/bots/bulk-update (clobber ทุก field)
   ───────────────────────────────────────────────────────── */

(function () {
  let overlay = null;
  let cachedBots = [];

  // FIX-2026-08-02: เพิ่ม timeframe (select) — valid Binance intervals (mirror config.binanceIntervals)
  //   - เลือก "—" (empty value) = ไม่เปลี่ยน TF
  //   - เลือกค่าอื่น → overwrite TF (backend จะ restart trader ให้อัตโนมัติ)
  const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];
  const FIELDS = [
    { id: 'mc-capitalPerTrade',  key: 'capitalPerTrade',   type: 'number', step: '0.01', min: '0.00000001', label: '💵 ทุนต่อไม้ (USDT)' },
    { id: 'mc-maxTrades',        key: 'maxTrades',         type: 'number', step: '1', min: '1', max: '1000', label: '🔢 จำนวนไม้สูงสุด' },
    { id: 'mc-tpPercent',        key: 'tpPercent',         type: 'number', step: '0.05', min: '0.001', label: '🎯 TP%' },
    { id: 'mc-retryTimeMin',     key: 'retryTimeMin',      type: 'number', step: '0.1', min: '0.1', max: '60', label: '⏱️ Retry min (นาที)' },
    { id: 'mc-retryMax',         key: 'retryMax',          type: 'number', step: '1', min: '0', max: '10', label: '🔁 Retry max ครั้ง' },
    { id: 'mc-kcMult',           key: 'kcMult',            type: 'number', step: '0.1', min: '0.5', max: '5', label: '📏 KC multiplier' },
    { id: 'mc-minSpreadTicks',   key: 'minSpreadTicks',    type: 'number', step: '1', min: '0', max: '10', label: '📐 Min spread (ticks)' },
    { id: 'mc-suggestTpWindow',  key: 'suggestTpWindow',   type: 'number', step: '10', min: '30', max: '1000', label: '🪟 Suggest TP window (bars)' },
    { id: 'mc-tpTrendMultiplier', key: 'tpTrendMultiplier', type: 'number', step: '1', min: '1', max: '10', label: '✖️ TP trend multiplier' },
    { id: 'mc-autoPauseMinKcPct', key: 'autoPauseMinKcPct', type: 'number', step: '0.1', min: '0.1', max: '50', label: '⏸️ Auto-pause Min-%KC threshold' },
    { id: 'mc-timeframe',        key: 'timeframe',         type: 'select', options: TIMEFRAMES, label: '⏰ Timeframe (TF) · เปลี่ยนแล้ว restart trader' },
  ];

  const TOGGLES = [
    { id: 'mc-s1OnlyDown',          key: 's1OnlyDown',          label: 'S1 only down (bg 2→3)' },
    { id: 'mc-xs1Enabled',          key: 'xs1Enabled',          label: '🛡️ XS1 anti-dump gate' },
    { id: 'mc-cbEnabled',           key: 'cbEnabled',           label: '🚨 Circuit-breaker panic-sell' },
    { id: 'mc-safeTradeEnabled',    key: 'safeTradeEnabled',    label: '🛡️ Safe-trade filter' },
    { id: 'mc-stopLossOnUpperKC',   key: 'stopLossOnUpperKC',   label: '🛑 Stop-loss on upper KC' },
    { id: 'mc-autoUpdateTp',        key: 'autoUpdateTp',        label: '⏰ Auto-update TP ทุกต้นชั่วโมง' },
    { id: 'mc-autoArmStopLossOnUKC', key: 'autoArmStopLossOnUKC', label: '🛡️ Auto-arm SL-on-UKC' },
    { id: 'mc-tpTrendEnabled',      key: 'tpTrendEnabled',      label: '✖️ TP trend ×N enabled' },
    { id: 'mc-autoPauseEnabled',    key: 'autoPauseEnabled',    label: '⏸️ Auto-pause on low Min-%KC' },
  ];

  function ensureSkeleton() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'quality-modal-overlay';
    overlay.innerHTML = `
      <div class="quality-modal-card" style="max-width:880px;">
        <div class="quality-modal-header">
          <h5 id="mc-title">⚙️ Master Config — ตั้งค่าหลายบอทพร้อมกัน</h5>
          <button type="button" class="quality-modal-close" aria-label="ปิด">✕</button>
        </div>
        <div class="quality-modal-body" id="mc-body">
          <div class="text-muted-3 text-center py-3">กำลังโหลด…</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.quality-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('is-open')) close(); });
    return overlay;
  }

  function close() { if (overlay) overlay.classList.remove('is-open'); }

  function escapeHtml(s) {
    return s == null ? '' : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function openMasterConfigModal() {
    const o = ensureSkeleton();
    o.classList.add('is-open');
    const body = document.getElementById('mc-body');
    body.innerHTML = '<div class="text-muted-3 text-center py-3">กำลังโหลดบอท…</div>';
    try {
      const resp = await API.get('/api/bots');
      cachedBots = resp.bots || [];
      if (cachedBots.length === 0) {
        body.innerHTML = '<div class="alert alert-warning">ไม่มีบอทในระบบ</div>';
        return;
      }
      renderForm(body);
      bindSubmit();
    } catch (err) {
      body.innerHTML = `<div class="alert alert-danger">โหลดบอทล้มเหลว: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderForm(container) {
    // Bot checklist
    const botListHtml = cachedBots.map((b) => {
      const checked = b.enabled !== false ? 'checked' : '';
      const status = b.enabled !== false ? '🟢' : '⏸';
      return `
        <label class="form-check d-flex align-items-center gap-2 mb-1" style="cursor:pointer;">
          <input type="checkbox" class="form-check-input mc-bot-check" data-bot-id="${escapeHtml(b._id)}" ${checked} />
          <span>${status} <code>${escapeHtml(b.symbol)}</code> · ${escapeHtml(b.timeframe)} · ${escapeHtml(b.name || '(no name)')}</span>
        </label>`;
    }).join('');

    // FIX-2026-08-02: render type='select' แตกต่างจาก type='number' เพราะ options ต้อง list ตาม Binance intervals
    const fieldHtml = FIELDS.map((f) => {
      if (f.type === 'select') {
        const optionsHtml = (f.options || []).map((opt) =>
          `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`
        ).join('');
        return `
        <div class="col-md-6 mb-2">
          <label class="form-label">${f.label}</label>
          <select class="form-select form-select-sm mc-field mc-field-select" id="${f.id}" data-key="${f.key}">
            <option value="" selected>(ไม่เปลี่ยน)</option>
            ${optionsHtml}
          </select>
        </div>`;
      }
      return `
      <div class="col-md-6 mb-2">
        <label class="form-label">${f.label}</label>
        <input type="${f.type}" class="form-control form-control-sm mc-field" id="${f.id}" data-key="${f.key}" step="${f.step || ''}" min="${f.min || ''}" max="${f.max || ''}" placeholder="(ไม่เปลี่ยน)" />
      </div>`;
    }).join('');

    // FIX-2026-08-02: tri-state radios แทน checkbox — รองรับ ON / OFF / leave
    //   - default = leave as-is (radio "" ไม่ส่ง key)
    //   - "true" / "false" ส่งค่าจริง ทำให้เปิดสามารถ "ปิด" toggle เดิมที่เปิดอยู่ได้
    //   - แสดง current value ของบอทแรกที่เลือก (hint) เพื่อให้ user รู้สถานะปัจจุบัน
    const firstSelectedId = (cachedBots.find((b) => b.enabled !== false) || cachedBots[0] || {})._id;
    const toggleHtml = TOGGLES.map((t) => {
      const cur = (cachedBots.find((b) => String(b._id) === String(firstSelectedId)) || {})[t.key];
      const curLabel = cur === true ? 'เปิด' : cur === false ? 'ปิด' : 'default';
      return `
      <div class="col-md-6 mb-2 d-flex align-items-center gap-2">
        <span class="flex-grow-1" style="font-size:0.85rem;">${t.label} <small class="text-muted-3">· ตอนนี้: <strong>${curLabel}</strong></small></span>
        <label class="form-check-inline mb-0" title="ไม่เปลี่ยน">
          <input type="radio" name="mc-tog-${t.id}" value="" class="form-check-input mc-toggle-mode" data-key="${t.key}" checked />
          <span>—</span>
        </label>
        <label class="form-check-inline mb-0" title="เปิด">
          <input type="radio" name="mc-tog-${t.id}" value="true" class="form-check-input mc-toggle-mode" data-key="${t.key}" />
          <span style="color:#4ade80;">✅</span>
        </label>
        <label class="form-check-inline mb-0" title="ปิด">
          <input type="radio" name="mc-tog-${t.id}" value="false" class="form-check-input mc-toggle-mode" data-key="${t.key}" />
          <span style="color:#ff6b6b;">❌</span>
        </label>
      </div>`;
    }).join('');

    container.innerHTML = `
      <div class="alert alert-warning" style="font-size:0.85rem;">
        ⚠️ <strong>Clobber mode</strong>: ทุก field ที่ติ๊ก/กรอกจะ overwrite ค่าเดิมของบอทที่เลือก (fields ที่ไม่แตะจะไม่เปลี่ยน)
        <br/>⏰ <strong>Timeframe</strong>: ถ้าเปลี่ยน TF ของบอทที่เปิดอยู่ ระบบจะ <u>restart trader</u> อัตโนมัติ (kline subscription + cache ต้อง rebuild) — กระทบไม้ที่ถืออยู่ชั่วครู่
      </div>
      <h6 class="text-muted-3 mb-2">📋 เลือกบอท (${cachedBots.length} ตัว · default: เฉพาะบอทที่ enabled)</h6>
      <div class="mb-2 d-flex gap-2">
        <button type="button" class="btn btn-sm btn-outline-gold" id="mc-select-all">เลือกทั้งหมด</button>
        <button type="button" class="btn btn-sm btn-outline-gold" id="mc-select-none">ไม่เลือกเลย</button>
        <button type="button" class="btn btn-sm btn-outline-gold" id="mc-select-enabled">เฉพาะที่ enabled</button>
      </div>
      <div class="mb-3 p-2" style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); border-radius:8px; max-height:160px; overflow-y:auto;">
        ${botListHtml}
      </div>

      <!-- FIX-2026-08-02: Master Config bulk enable/disable (lifecycle) — แยกจาก config update -->
      <div class="mb-2 d-flex gap-2 flex-wrap">
        <button type="button" class="btn btn-sm btn-outline-success" id="mc-toggle-start" title="บอทจะเริ่ม scan ตลาดและเปิด order ตาม signal">▶️ Start selected</button>
        <button type="button" class="btn btn-sm btn-outline-warning" id="mc-toggle-stop" title="บอทจะหยุดเปิดไม้ใหม่ — trades ที่ถืออยู่ยังทำงานตามเดิม">⏸ Stop selected</button>
        <span class="ms-2 text-muted small" id="mc-toggle-status"></span>
      </div>

      <hr />
      <h6 class="text-muted-3 mb-2">🔢 ตัวเลข (กรอกเฉพาะ field ที่ต้องการเปลี่ยน)</h6>
      <div class="row g-2 mb-3">${fieldHtml}</div>

      <hr />
      <h6 class="text-muted-3 mb-2">🔘 Toggle (— ไม่เปลี่ยน / ✅ เปิด / ❌ ปิด)</h6>
      <div class="row g-2 mb-3">${toggleHtml}</div>

      <div class="mt-3 d-flex align-items-center gap-2">
        <button type="button" class="btn btn-primary" id="mc-submit">💾 Set to N bots</button>
        <button type="button" class="btn btn-secondary" id="mc-cancel">ยกเลิก</button>
        <span class="ms-2 text-muted small" id="mc-status"></span>
      </div>
    `;

    // Bind select-all / select-none / select-enabled
    document.getElementById('mc-select-all').onclick = () => {
      container.querySelectorAll('.mc-bot-check').forEach((c) => { c.checked = true; });
    };
    document.getElementById('mc-select-none').onclick = () => {
      container.querySelectorAll('.mc-bot-check').forEach((c) => { c.checked = false; });
    };
    document.getElementById('mc-select-enabled').onclick = () => {
      container.querySelectorAll('.mc-bot-check').forEach((c, i) => {
        c.checked = (cachedBots[i] && cachedBots[i].enabled !== false);
      });
    };
    document.getElementById('mc-cancel').onclick = close;
    // FIX-2026-08-02: Master Config bulk Start/Stop — แยก handler จาก config-submit
    //   - callBotWithPassword จะ prompt password ผ่าน themed modal อัตโนมัติ (กรณี server ตอบ 403/503)
    //   - on success: reload bot list + ปิด modal
    document.getElementById('mc-toggle-start').onclick = () => bulkToggle('enable', '▶️ Start');
    document.getElementById('mc-toggle-stop').onclick = () => bulkToggle('disable', '⏸ Stop');
  }

  function bindSubmit() {
    document.getElementById('mc-submit').onclick = submit;
  }

  async function submit() {
    const status = document.getElementById('mc-status');
    // Collect selected botIds
    const selectedBotIds = Array.from(document.querySelectorAll('.mc-bot-check:checked')).map((c) => c.getAttribute('data-bot-id'));
    if (selectedBotIds.length === 0) {
      status.textContent = '❌ เลือกบอทอย่างน้อย 1 ตัว';
      status.style.color = '#ff6b6b';
      return;
    }

    // Collect numeric fields (only if value is non-empty)
    // FIX-2026-08-02: แยก branch — select element (timeframe) ส่งค่าเป็น string, ไม่ parseFloat
    const settings = {};
    document.querySelectorAll('.mc-field').forEach((el) => {
      const v = el.value;
      if (v === '' || v == null) return;
      if (el.classList.contains('mc-field-select')) {
        // Select (timeframe) — ส่ง string ตรง ๆ (backend validate against binanceIntervals)
        settings[el.getAttribute('data-key')] = v;
      } else {
        const num = parseFloat(v);
        if (Number.isFinite(num)) {
          settings[el.getAttribute('data-key')] = num;
        }
      }
    });

    // Collect toggles — tri-state radios (— / ✅ / ❌)
    // - value "" (default) → ไม่ส่ง key (leave as-is)
    // - value "true" / "false" → ส่งค่าจริง (clobber ค่าเดิม)
    document.querySelectorAll('.mc-toggle-mode').forEach((el) => {
      if (el.checked && el.value !== '') {
        settings[el.getAttribute('data-key')] = (el.value === 'true');
      }
    });

    if (Object.keys(settings).length === 0) {
      status.textContent = '❌ กรอก field อย่างน้อย 1 อย่าง หรือติ๊ก toggle อย่างนั้น 1 อย่าง';
      status.style.color = '#ff6b6b';
      return;
    }

    // Confirm clobber
    const ok = window.confirm(`⚠️ ยืนยัน: overwrite ${Object.keys(settings).length} fields บน ${selectedBotIds.length} บอท\n\nFields ที่จะเปลี่ยน:\n${Object.keys(settings).join(', ')}`);
    if (!ok) return;

    status.textContent = '⏳ กำลังส่ง…';
    status.style.color = 'var(--text-3)';
    try {
      const resp = await API.post('/api/bots/bulk-update', { botIds: selectedBotIds, settings });
      // FIX-2026-08-02: แสดง trader restart count ด้วย (กรณีเปลี่ยน TF) เพื่อให้ user รู้ว่าบอทจะ offline ชั่วครู่
      const restartInfo = resp.traderRestarts > 0
        ? ` · restart trader ${resp.traderRestarts} ตัว`
        : '';
      const restartErrInfo = (resp.traderRestartErrors && resp.traderRestartErrors.length > 0)
        ? ` · ⚠️ restart fail ${resp.traderRestartErrors.length}`
        : '';
      status.textContent = `✅ สำเร็จ — แก้ไข ${resp.modified}/${selectedBotIds.length} บอท (${resp.fields.length} fields)${restartInfo}${restartErrInfo}`;
      status.style.color = (resp.traderRestartErrors && resp.traderRestartErrors.length > 0) ? '#ffa500' : '#4ade80';
      // Refresh bots list
      setTimeout(() => {
        close();
        if (typeof window.loadBots === 'function') window.loadBots();
        // Also dispatch event for any listeners
        try { window.dispatchEvent(new CustomEvent('bots:bulk-updated')); } catch (_) {}
      }, 1500);
    } catch (err) {
      status.textContent = '❌ ' + err.message;
      status.style.color = '#ff6b6b';
    }
  }

  window.masterConfigModal = {
    openMasterConfigModal,
    close,
  };

  // FIX-2026-08-02: bulk toggle handler — Start / Stop บอทที่เลือกหลายตัวพร้อมกัน
  //   - ใช้ callBotWithPassword ซึ่ง prompt password ผ่าน themed modal อัตโนมัติถ้า server ขอ
  //   - แสดงผล per-bot (✅ start/⏹ stop + ลิสต์บอทที่ล้มเหลว) ใน #mc-toggle-status
  async function bulkToggle(action, label) {
    const status = document.getElementById('mc-toggle-status');
    const selectedBotIds = Array.from(document.querySelectorAll('.mc-bot-check:checked')).map((c) => c.getAttribute('data-bot-id'));
    if (selectedBotIds.length === 0) {
      status.textContent = '❌ เลือกบอทอย่างน้อย 1 ตัว';
      status.style.color = '#ff6b6b';
      return;
    }
    const verb = action === 'enable' ? 'เปิด' : 'หยุด';
    const ok = window.confirm(`⚠️ ยืนยัน${verb} ${selectedBotIds.length} บอท?`);
    if (!ok) return;

    status.textContent = `⏳ กำลัง${verb}…`;
    status.style.color = 'var(--text-3)';
    try {
      // callBotWithPassword จะ first-try แล้ว prompt ถ้า 403/503 — URL มี /bulk-toggle ใหม่ ใช้ default warning icon
      const resp = await window.LUX_CONFIRM.callBotWithPassword(
        'POST',
        '/api/bots/bulk-toggle',
        { botIds: selectedBotIds, action },
        `${verb} ${selectedBotIds.length} บอท`,
      );
      const results = resp.results || [];
      const failed = results.filter((r) => !r.ok);
      const succeeded = results.filter((r) => r.ok);
      if (failed.length === 0) {
        status.textContent = `✅ สำเร็จ — ${verb} ${succeeded.length} บอท`;
        status.style.color = '#4ade80';
      } else {
        const failedNames = failed.map((r) => {
          const bot = cachedBots.find((b) => String(b._id) === String(r.botId));
          return `${bot ? (bot.name || bot.symbol) : r.botId}: ${r.error}`;
        }).join('; ');
        status.textContent = `⚠️ สำเร็จ ${succeeded.length}/${results.length}, ล้มเหลว ${failed.length} — ${failedNames}`;
        status.style.color = '#ffa500';
      }
      // Refresh bots list (อัพเดท enabled status) หลังผ่านไป 1.5s
      setTimeout(() => {
        close();
        if (typeof window.loadBots === 'function') window.loadBots();
        try { window.dispatchEvent(new CustomEvent('bots:bulk-updated')); } catch (_) {}
      }, 1500);
    } catch (err) {
      status.textContent = '❌ ' + (err.message || err);
      status.style.color = '#ff6b6b';
    }
  }
})();