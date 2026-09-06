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
  // FIX-2026-08-13: cached templates metadata (id, name, fieldCount, timestamps) — full settings
  //   are fetched on-demand via GET /api/admin/master-config-templates/:id when user clicks Load.
  let cachedTemplates = [];

  // FIX-2026-08-02: เพิ่ม timeframe (select) — valid Binance intervals (mirror config.binanceIntervals)
  //   - เลือก "—" (empty value) = ไม่เปลี่ยน TF
  //   - เลือกค่าอื่น → overwrite TF (backend จะ restart trader ให้อัตโนมัติ)
  const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];
  const MASTER_SECTIONS = [
    { id: 'basic', icon: '🪪', title: 'ข้อมูลบอทและเงินทุน', hint: 'Timeframe · ทุน · จำนวนไม้', open: true },
    { id: 'entry', icon: '📥', title: 'เงื่อนไขเข้าและการวาง BUY', hint: 'S1 · XS1 · Retry · KC · Spread' },
    { id: 'tp', icon: '🎯', title: 'Take Profit และการขาย', hint: 'TP% สุทธิ · Auto-update · Trend ×N', open: true },
    { id: 'automation', icon: '⚙️', title: 'ระบบอัตโนมัติและขนาด Position', hint: 'DPS · Auto-pause' },
    { id: 'risk', icon: '🛑', title: 'Stop Loss และ Circuit Breaker', hint: 'SL-UKC · Auto-arm · CB · Cooldown' },
    { id: 'safe-trade', icon: '🛡️', title: 'ตัวกรอง Safe Trade ก่อนซื้อ', hint: 'แนวโน้มใหญ่ · Trendline · Bearish pattern' },
  ];

  const FIELDS = [
    { id: 'mc-capitalPerTrade', key: 'capitalPerTrade', section: 'basic', order: 10, type: 'number', step: '0.01', min: '0.00000001', label: '💵 ทุนต่อไม้ (USDT)' },
    { id: 'mc-maxTrades', key: 'maxTrades', section: 'basic', order: 20, type: 'number', step: '1', min: '1', max: '1000', label: '🔢 จำนวนไม้สูงสุด' },
    // FIX-2026-09-02: Round-down Capital — ขั้นต่ำที่ยอมให้ round-down (USDT, default 5.5)
    { id: 'mc-roundDownCapitalMin', key: 'roundDownCapitalMin', section: 'basic', order: 25, type: 'number', step: '0.1', min: '1', max: '10000', label: '📉 ขั้นต่ำที่ round-down ทุนได้ (USDT)' },
    { id: 'mc-timeframe', key: 'timeframe', section: 'basic', order: 30, type: 'select', options: TIMEFRAMES, label: '⏰ กรอบเวลา (Timeframe) · เปลี่ยนแล้ว restart trader' },
    { id: 'mc-retryTimeMin', key: 'retryTimeMin', section: 'entry', order: 10, type: 'number', step: '0.1', min: '0.1', max: '60', label: '⏱️ เวลารอก่อนลองซื้อใหม่ (นาที)' },
    { id: 'mc-retryMax', key: 'retryMax', section: 'entry', order: 20, type: 'number', step: '1', min: '0', max: '10', label: '🔁 จำนวนครั้งที่ลองใหม่สูงสุด' },
    { id: 'mc-kcMult', key: 'kcMult', section: 'entry', order: 30, type: 'number', step: '0.1', min: '0.5', max: '5', label: '📏 ความกว้าง KC (Multiplier)' },
    { id: 'mc-minSpreadTicks', key: 'minSpreadTicks', section: 'entry', order: 40, type: 'number', step: '1', min: '0', max: '10', label: '📐 ระยะห่างราคา BUY ขั้นต่ำ (ticks)' },
    { id: 'mc-tpPercent', key: 'tpPercent', section: 'tp', order: 10, type: 'number', step: '0.05', min: '0.001', label: '🎯 กำไรเป้าหมายสุทธิ (TP%)' },
    { id: 'mc-suggestTpWindow', key: 'suggestTpWindow', section: 'tp', order: 20, type: 'number', step: '10', min: '30', max: '1000', label: '🪟 ช่วงข้อมูลแนะนำ TP (แท่ง)' },
    { id: 'mc-tpTrendMultiplier', key: 'tpTrendMultiplier', section: 'tp', order: 50, type: 'number', step: '1', min: '1', max: '10', label: '✖️ ตัวคูณ TP ตามแนวโน้ม' },
    { id: 'mc-autoPauseMinKcPct', key: 'autoPauseMinKcPct', section: 'automation', order: 30, type: 'number', step: '0.1', min: '0.1', max: '50', label: '⏸️ Min-%KC threshold (%)' },
    { id: 'mc-autoPauseMin24hVolUsdt', key: 'autoPauseMin24hVolUsdt', section: 'automation', order: 31, type: 'number', step: '1000', min: '0', label: '💵 Auto-pause Min 24h Vol (USDT)' },
    // FIX-2026-09-05: DLC per-bot base-loss default — sits NEXT to DPS tunables (was: invisible to user in ตั้งค่าระบบ)
    { id: 'mc-dlcBaseLossPct', key: 'dlcBaseLossPct', section: 'automation', order: 32, type: 'number', step: '0.5', min: '-95', max: '-1', label: '🪜 DLC Base Loss % (ติดลบ · ยิ่งติดลบมาก = ยิ่งต้องขาดทุนลึกก่ยเปิด layer ถัดไป)' },
    // FIX-2026-08-30 / Phase 4: per-bot Auto-Timing opt-in (3-state string → null/true/false at backend)
    { id: 'mc-autoTimingEnabled', key: 'autoTimingEnabled', section: 'automation', order: 40, type: 'select', options: ['inherit','true','false'], label: '⏱️ Auto-Timing (heatmap entry gate) · inherit=master' },
    { id: 'mc-autoArmLossPct', key: 'autoArmLossPct', section: 'risk', order: 30, type: 'number', step: '0.5', min: '1', max: '99', label: '🛡️ ขาดทุนขั้นต่ำสำหรับ Auto-arm (%)' },
    { id: 'mc-autoArmAgeHours', key: 'autoArmAgeHours', section: 'risk', order: 40, type: 'number', step: '0.5', min: '0.5', max: '999', label: '⏰ อายุ Position ขั้นต่ำสำหรับ Auto-arm (ชม.)' },
    // FIX-2026-09-06: AUv2 — Auto-Underwater v2 (F1 auto-arm variant) — Master Config bulk-update
    { id: 'mc-auv2MinAgeHours',    key: 'auv2MinAgeHours', section: 'risk', order: 51, type: 'number', step: '0.5', min: '0.5', max: '999', label: '⏰ AUv2 อายุ Position ขั้นต่ำ (ชม.) · default 24' },
    { id: 'mc-auv2LossMode',       key: 'auv2LossMode',    section: 'risk', order: 52, type: 'select', options: ['pct','thb'], label: '📐 AUv2 Loss Metric Mode · pct / thb' },
    { id: 'mc-auv2MaxLossPct',     key: 'auv2MaxLossPct',  section: 'risk', order: 53, type: 'number', step: '0.1', min: '0.1', max: '50', label: '🛡️ AUv2 ขาดทุนตื้นสุด (%) · default 5' },
    { id: 'mc-auv2MaxLossThb',     key: 'auv2MaxLossThb',  section: 'risk', order: 54, type: 'number', step: '1', min: '1', max: '100000', label: '💴 AUv2 ขาดทุนตื้นสุด (THB) · default 200' },
    { id: 'mc-auv2MaxWaitDays',    key: 'auv2MaxWaitDays', section: 'risk', order: 55, type: 'number', step: '1', min: '0', max: '90', label: '⏳ AUv2 Hard Cap (วัน) · default 7, 0=no cap' },
    { id: 'mc-cbv2LockHours', key: 'cbv2LockHours', section: 'risk', order: 80, type: 'number', step: '0.5', min: '0.5', max: '168', label: '⏱ ระยะเวลา CBv2 Cooldown (ชม.)' },
    { id: 'mc-cbv3LockHours', key: 'cbv3LockHours', section: 'risk', order: 80, type: 'number', step: '0.5', min: '0.5', max: '168', label: '⏱ ระยะเวลา CBv3 Cooldown (ชม.)' },
    { id: 'mc-cbv5LockHours', key: 'cbv5LockHours', section: 'risk', order: 81, type: 'number', step: '0.5', min: '0.5', max: '168', label: '⏱ ระยะเวลา CBv5 Cooldown (ชม.) · default 4' },
    { id: 'mc-cbAutoUnlockThreshold', key: 'cbAutoUnlockThresholdPct', section: 'risk', order: 100, type: 'number', step: '0.1', min: '0.5', max: '5', label: '🔓 กำไรขั้นต่ำสำหรับ Auto-Unlock (%)' },
  ];

  // FIX-2026-08-10: CBv5 advanced params (KC + Pivot + Volume) — displayed under a
  //   collapsible "ขั้นสูง" panel inside the risk section. Independent of cbVersion.
  //   Same defaults as botDefaults.js: kcLen=20, kcMult=1.2, pivot×3, volMaLen=20,
  //   volMultiplier=1.5, debounce=5, strictBreak=true, useVolume=true.
  const CBV5_ADVANCED_FIELDS = [
    { id: 'mc-cbv5-kc-len', key: 'cbv5KcLen', type: 'number', step: '1', min: '5', max: '100', label: '📏 KC length (EMA+ATR period)' },
    { id: 'mc-cbv5-kc-mult', key: 'cbv5KcMult', type: 'number', step: '0.1', min: '0.5', max: '5', label: '📐 KC multiplier (ความกว้าง band)' },
    { id: 'mc-cbv5-pivot-lookback', key: 'cbv5PivotLookback', type: 'number', step: '1', min: '2', max: '10', label: '🔍 Pivot lookback (จำนวน pivot lows ที่ใช้)' },
    { id: 'mc-cbv5-pivot-left', key: 'cbv5PivotLeftLen', type: 'number', step: '1', min: '2', max: '50', label: '◀ Pivot left length (แท่งซ้ายยืนยัน)' },
    { id: 'mc-cbv5-pivot-right', key: 'cbv5PivotRightLen', type: 'number', step: '1', min: '2', max: '50', label: '▶ Pivot right length (แท่งขวายืนยัน)' },
    { id: 'mc-cbv5-vol-ma-len', key: 'cbv5VolMaLen', type: 'number', step: '1', min: '5', max: '100', label: '📊 Volume MA length' },
    { id: 'mc-cbv5-vol-mult', key: 'cbv5VolMultiplier', type: 'number', step: '0.1', min: '1.0', max: '10', label: '📈 Volume spike multiplier' },
    { id: 'mc-cbv5-debounce', key: 'cbv5DebounceCandles', type: 'number', step: '1', min: '1', max: '20', label: '⏳ Debounce candles (กันยิงซ้ำติด)' },
  ];

  const CBV5_ADVANCED_TOGGLES = [
    { id: 'mc-cbv5-strict-break', key: 'cbv5StrictBreak', label: '🐻 Strict break · ต้อง bearish (close < open)' },
    { id: 'mc-cbv5-use-volume', key: 'cbv5UseVolume', label: '📈 ใช้ volume spike filter' },
  ];

  const TOGGLES = [
    // FIX-2026-09-02: Round-down Capital — basic section (อยู่ใกล้ capitalPerTrade)
    { id: 'mc-roundDownCapitalEnabled', key: 'roundDownCapitalEnabled', section: 'basic', order: 26, label: '💸 Round-down ทุนให้พอดีกับยอดคงเหลือ (เมื่อเงินไม่พอ)' },
    { id: 'mc-s1OnlyDown', key: 's1OnlyDown', section: 'entry', order: 50, label: '📉 S1 เฉพาะ bg 2→3 (ขาลง)' },
    { id: 'mc-xs1Enabled', key: 'xs1Enabled', section: 'entry', order: 60, label: '🚫 XS1 anti-dump gate' },
    { id: 'mc-autoUpdateTp', key: 'autoUpdateTp', section: 'tp', order: 30, label: '⏰ อัปเดต TP% ทุกต้นชั่วโมง' },
    { id: 'mc-tpTrendEnabled', key: 'tpTrendEnabled', section: 'tp', order: 40, label: '📈 ขยาย TP ตามแนวโน้ม (Trend ×N)' },
    { id: 'mc-dynamicSizeEnabled', key: 'dynamicSizeEnabled', section: 'automation', order: 10, label: '📊 Dynamic Position Sizing (DPS)' },
    // FIX-2026-09-05: DLC per-bot default toggle — sits NEXT to DPS master toggle
    //   - user reported "หา DLC ใน Master Config ไม่เจอ" (was only in ตั้งค่าระบบ section)
    //   - masterDlcEnabled (kill-switch) stays inline in bot-edit accordion
    { id: 'mc-dlcEnabled', key: 'dlcEnabled', section: 'automation', order: 11, label: '🪜 Dynamic Layer Control (DLC) · per-bot default (masterDlcEnabled kill-switch stays inline in bot-edit)' },
    { id: 'mc-autoPauseEnabled', key: 'autoPauseEnabled', section: 'automation', order: 20, label: '⏸️ หยุดบอทเมื่อ Min-%KC หรือ 24h Vol ต่ำ' },
    // FIX-2026-08-29: per-bot opt-in for auto-pause threshold auto-adjust (default ON)
    { id: 'mc-autoPauseAdjustEnabled', key: 'autoPauseAdjustEnabled', section: 'automation', order: 25, label: '🔧 ให้ Auto-adjust threshold ของบอทนี้' },
    { id: 'mc-stopLossOnUpperKC', key: 'stopLossOnUpperKC', section: 'risk', order: 10, label: '🛑 Stop Loss เมื่อแท่งปิดเหนือ Upper-KC' },
    { id: 'mc-autoArmStopLossOnUKC', key: 'autoArmStopLossOnUKC', section: 'risk', order: 20, label: '🛡️ เปิดใช้ SL-UKC อัตโนมัติเมื่อขาดทุนนาน' },
    // FIX-2026-09-06: AUv2 — F1 v2 (Auto-Underwater v2 shallow-loss exit gate)
    //   Per-bot opt-in (bot.auv2Enabled) — master toggle = kill-switch AppConfig.auv2Enabled
    { id: 'mc-auv2Enabled', key: 'auv2Enabled', section: 'risk', order: 21, label: '🌊 AUv2 — F1 v2 (shallow-loss exit after age)' },
    { id: 'mc-slUkcTriggerOnProfit', key: 'slUkcTriggerOnProfit', section: 'risk', order: 50, label: '💰 ให้ SL-UKC ปิด Position ที่กำไรด้วย' },
    { id: 'mc-cbEnabled', key: 'cbEnabled', section: 'risk', order: 60, label: '🚨 Circuit Breaker (CB)' },
    { id: 'mc-cbv2Enabled', key: 'cbv2Enabled', section: 'risk', order: 70, label: '💎 CBv2 — Panic-sell + Cooldown' },
    { id: 'mc-cbv3Enabled', key: 'cbv3Enabled', section: 'risk', order: 70, label: '💎 CBv3 — CBv2 + ST3 Upper-TF' },
    { id: 'mc-cbv5Enabled', key: 'cbv5Enabled', section: 'risk', order: 75, label: '💎 CBv5 — Support Zone + Deepest Low + Volume (อิสระจาก CB Version)' },
    { id: 'mc-cbAutoUnlockEnabled', key: 'cbAutoUnlockEnabled', section: 'risk', order: 90, label: '🔓 ปลด CB Cooldown อัตโนมัติ' },
    { id: 'mc-safeTradeEnabled', key: 'safeTradeEnabled', section: 'safe-trade', order: 10, label: '🛡️ Safe Trade #1 — แนวโน้ม Super Upper-TF' },
    { id: 'mc-safeTradeTrendlineEnabled', key: 'safeTradeTrendlineEnabled', section: 'safe-trade', order: 20, label: '📐 Safe Trade #2 — Trendline Support (ไม่แนะนำสำหรับ DCA)' },
    { id: 'mc-safeTradeNoTradeEnabled', key: 'safeTradeNoTradeEnabled', section: 'safe-trade', order: 30, label: '🚫 Safe Trade #3 — Bearish Engulfing / Shooting Star (ไม่แนะนำสำหรับ DCA)' },
  ];

  function ensureSkeleton() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'master-config-modal-overlay';
    overlay.innerHTML = `
      <div class="master-config-modal-card" style="max-width:880px;">
        <div class="master-config-modal-header">
          <h5 id="mc-title">⚙️ Master Config — ตั้งค่าหลายบอทพร้อมกัน</h5>
          <button type="button" class="master-config-modal-close" aria-label="ปิด">✕</button>
        </div>
        <div class="master-config-modal-body" id="mc-body">
          <div class="text-muted-3 text-center py-3">กำลังโหลด…</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.master-config-modal-close').addEventListener('click', close);
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
      // FIX-2026-08-22: include soft-deleted bots — Master Config ต้องเห็นบอททุกตัว
      //   - bots.html ตอนนี้แสดงบอท soft-deleted แล้ว (chip "🗑 Deleted")
      //   - เดิม filter { deletedAt: null } → user เห็นบอทไม่ครบ (Master Config กับ bots.html ไม่ตรงกัน)
      //   - ตอนนี้ส่ง ?includeDeleted=1 — ผู้ใช้สามารถ apply settings / Restore บอทที่ลบได้จากที่เดียว
      const resp = await API.get('/api/bots?includeDeleted=1');
      cachedBots = resp.bots || [];
      if (cachedBots.length === 0) {
        body.innerHTML = '<div class="alert alert-warning">ไม่มีบอทในระบบ</div>';
        return;
      }
      // FIX-2026-08-08: load AppConfig (master toggles + auto-delete config) in parallel
      const [cfgResp] = await Promise.all([
        API.get('/api/admin/app-config').catch((e) => ({ config: null, error: e.message })),
      ]);
      renderForm(body, cfgResp.config || {});
      bindSubmit();
    } catch (err) {
      body.innerHTML = `<div class="alert alert-danger">โหลดบอทล้มเหลว: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderForm(container, cfg) {
    cfg = cfg || {};
    const activeCbVersion = cfg.cbVersion || 'v3';
    const isCbVisible = (key) => {
      if (key === 'cbv2Enabled' || key === 'cbv2LockHours') return activeCbVersion === 'v2';
      if (key === 'cbv3Enabled' || key === 'cbv3LockHours') return activeCbVersion === 'v3';
      // FIX-2026-08-10: CBv5 is independent of cbVersion — always visible
      return true;
    };

    // FIX-2026-08-22: แสดงบอท soft-deleted ด้วย chip "🗑 DELETED" + รายชื่อสีจางลง
    //   - ตรงกับ visual language ของ bots.html (.deleted-pill + .bot-card-v2.is-deleted)
    //   - is-deleted class ใช้ text-decoration line-through เพื่อสื่อสาร "บอทนี้ถูกพักการใช้งาน"
    //   - daysSinceDelete + withinRestoreWindow เพื่อบอก user ว่า restore ได้อีกกี่วัน
    const deletedCount = cachedBots.filter((b) => !!b.deletedAt).length;
    const activeCount = cachedBots.length - deletedCount;
    const botListHtml = cachedBots.map((b) => {
      const isDeleted = !!b.deletedAt;
      // deleted → unchecked by default (ปลอดภัย: ไม่ apply settings บนบอทที่ลบ จนกว่า user �ะเลือกเอง)
      const checked = (!isDeleted && b.enabled !== false) ? 'checked' : '';
      let status;
      if (isDeleted) status = '🗑';
      else if (b.enabled !== false) status = '🟢';
      else status = '⏸';
      const deletedBadge = isDeleted
        ? (() => {
          const d = b.deletedAt ? new Date(b.deletedAt) : null;
          const daysSince = d ? Math.floor((Date.now() - d.getTime()) / 86400000) : 0;
          const withinWindow = daysSince <= 30;
          return `<span class="deleted-pill" title="ถูก soft-delete เมื่อ ${escapeHtml(d ? d.toLocaleString('th-TH') : '—')}${withinWindow ? ' — ยัง restore ได้ (ภายใน 30 วัน)' : ' — หมดเวลา restore แล้ว (เกิน 30 วัน)'}">🗑 DELETED · ${daysSince}d${withinWindow ? '' : ' ⚠️'}</span>`;
        })()
        : '';
      return `
        <label class="form-check d-flex align-items-center gap-2 mb-1 mc-bot-row ${isDeleted ? 'is-deleted' : ''}" style="cursor:pointer; ${isDeleted ? 'opacity:0.78;' : ''}">
          <input type="checkbox" class="form-check-input mc-bot-check" data-bot-id="${escapeHtml(b._id)}" ${checked} />
          <span>${status} <code>${escapeHtml(b.symbol)}</code> · ${escapeHtml(b.timeframe)} · ${escapeHtml(b.name || '(no name)')} ${deletedBadge}</span>
        </label>`;
    }).join('');

    const firstSelectedId = (cachedBots.find((b) => b.enabled !== false) || cachedBots[0] || {})._id;
    const currentBot = cachedBots.find((b) => String(b._id) === String(firstSelectedId)) || {};

    const renderField = (field) => {
      if (field.type === 'select') {
        const optionsHtml = (field.options || []).map((opt) =>
          `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`
        ).join('');
        return `
          <div class="bot-settings-field">
            <label class="form-label" for="${field.id}">${field.label}</label>
            <select class="form-select form-select-sm mc-field mc-field-select" id="${field.id}" data-key="${field.key}">
              <option value="" selected>(ไม่เปลี่ยน)</option>
              ${optionsHtml}
            </select>
          </div>`;
      }
      return `
        <div class="bot-settings-field">
          <label class="form-label" for="${field.id}">${field.label}</label>
          <input type="${field.type}" class="form-control form-control-sm mc-field" id="${field.id}" data-key="${field.key}" step="${field.step || ''}" min="${field.min || ''}" max="${field.max || ''}" placeholder="(ไม่เปลี่ยน)" />
        </div>`;
    };

    const renderToggle = (toggle) => {
      const current = currentBot[toggle.key];
      const currentLabel = current === true ? 'เปิด' : current === false ? 'ปิด' : 'default';
      return `
        <div class="bot-settings-option">
          <div class="bot-settings-master-row">
            <div style="font-size:0.85rem;">
              <strong>${toggle.label}</strong>
              <small class="text-muted-3 d-block mt-1">ค่าปัจจุบันของบอทอ้างอิง: <strong>${currentLabel}</strong></small>
            </div>
            <div class="bot-settings-tristate" role="group" aria-label="${toggle.label}">
              <label title="ไม่เปลี่ยน">
                <input type="radio" name="mc-tog-${toggle.id}" value="" class="form-check-input mc-toggle-mode" data-key="${toggle.key}" checked />
                <span>—</span>
              </label>
              <label title="เปิด">
                <input type="radio" name="mc-tog-${toggle.id}" value="true" class="form-check-input mc-toggle-mode" data-key="${toggle.key}" />
                <span style="color:#4ade80;">✅</span>
              </label>
              <label title="ปิด">
                <input type="radio" name="mc-tog-${toggle.id}" value="false" class="form-check-input mc-toggle-mode" data-key="${toggle.key}" />
                <span style="color:#ff6b6b;">❌</span>
              </label>
            </div>
          </div>
        </div>`;
    };

    const sectionsHtml = MASTER_SECTIONS.map((section) => {
      const controls = [
        ...FIELDS.filter((field) => field.section === section.id && isCbVisible(field.key)).map((field) => ({ ...field, kind: 'field' })),
        ...TOGGLES.filter((toggle) => toggle.section === section.id && isCbVisible(toggle.key)).map((toggle) => ({ ...toggle, kind: 'toggle' })),
      ].sort((a, b) => a.order - b.order);
      const controlsHtml = controls.map((control) =>
        control.kind === 'field' ? renderField(control) : renderToggle(control)
      ).join('');
      // FIX-2026-08-10: CBv5 advanced params panel (collapsible) — inject หลัง risk section
      const cbv5AdvancedHtml = section.id === 'risk' ? `
        <details class="lux-details mt-2" id="mc-cbv5-advanced-panel">
          <summary class="lux-details-summary" style="cursor:pointer;">
            <span class="bot-settings-group-icon">💎</span>
            <span class="bot-settings-group-title">CBv5 — ขั้นสูง (KC + Pivot + Volume)</span>
            <span class="bot-settings-group-hint">ปรับ kcLen, kcMult, pivot×3, vol×2, debounce, strictBreak, useVolume</span>
          </summary>
          <div class="lux-details-body">
            <div class="bot-settings-note mb-2">ค่าขั้นสูงของ CBv5 — เปลี่ยนแล้วมีผลกับการประเมิน panic-close ทันที (ไม่ต้อง restart trader) ปล่อยว่าง = ไม่เปลี่ยน</div>
            <div class="bot-settings-grid">
              ${CBV5_ADVANCED_FIELDS.map((f) => renderField({ ...f, key: f.key, id: f.id, label: f.label, type: f.type, step: f.step, min: f.min, max: f.max })).join('')}
              ${CBV5_ADVANCED_TOGGLES.map((t) => renderToggle({ ...t, key: t.key, id: t.id, label: t.label, section: 'risk' })).join('')}
            </div>
          </div>
        </details>
      ` : '';
      return `
        <details class="lux-details" id="mc-group-${section.id}" data-settings-group="${section.id}" ${section.open ? 'open' : ''}>
          <summary class="lux-details-summary">
            <span class="bot-settings-group-icon">${section.icon}</span>
            <span class="bot-settings-group-title">${section.title}</span>
            <span class="bot-settings-group-hint">${section.hint}</span>
          </summary>
          <div class="lux-details-body">
            <div class="bot-settings-grid">${controlsHtml}</div>
            ${cbv5AdvancedHtml}
          </div>
        </details>`;
    }).join('');

    container.innerHTML = `
      <div class="bot-settings-form">
        <div class="alert alert-warning mb-0" style="font-size:0.85rem;">
          ⚠️ <strong>Bulk overwrite:</strong> ระบบเปลี่ยนเฉพาะช่องที่กรอกและ Toggle ที่เลือก ✅/❌ เท่านั้น
          <br />ช่องว่างหรือ <strong>— ไม่เปลี่ยน</strong> จะคงค่าเดิม · การเปลี่ยน Timeframe จะ restart trader ของบอทที่เปิดอยู่ชั่วครู่
        </div>

        <details class="lux-details" id="mc-group-templates" data-settings-group="templates">
          <summary class="lux-details-summary">
            <span class="bot-settings-group-icon">📋</span>
            <span class="bot-settings-group-title">Templates (ตั้งค่าสำเร็จรูป)</span>
            <span class="bot-settings-group-hint">Save · Load · Rename · Duplicate · Delete</span>
          </summary>
          <div class="lux-details-body">
            <div class="bot-settings-note mb-2">
              Template เก็บเฉพาะ <strong>ค่า setting</strong> — ไม่รวมบอทที่เลือก และไม่ apply ทันที ต้องกด “ใช้ค่ากับบอทที่เลือก” อีกครั้ง
            </div>
            <div class="d-flex gap-2 flex-wrap align-items-center mb-2">
              <select class="form-select form-select-sm" id="mc-tpl-select" style="max-width:320px;">
                <option value="">— เลือก template —</option>
              </select>
              <button type="button" class="btn btn-sm btn-outline-info" id="mc-tpl-load">📥 Load</button>
              <button type="button" class="btn btn-sm btn-outline-success" id="mc-tpl-save">💾 Save</button>
              <button type="button" class="btn btn-sm btn-outline-warning" id="mc-tpl-rename">✏️ Rename</button>
              <button type="button" class="btn btn-sm btn-outline-secondary" id="mc-tpl-duplicate">📋 Duplicate</button>
              <button type="button" class="btn btn-sm btn-outline-danger" id="mc-tpl-delete">🗑️ Delete</button>
            </div>
            <!-- FIX-2026-08-14: Import/Export file-based (works across 4 surfaces) -->
            <div class="d-flex gap-2 flex-wrap align-items-center mb-2">
              <button type="button" class="btn btn-sm btn-outline-secondary" id="mc-tpl-export" title="บันทึกฟอร์มเป็นไฟล์ JSON">📤 Export ไฟล์</button>
              <button type="button" class="btn btn-sm btn-outline-info" id="mc-tpl-import-replace" title="โหลดไฟล์ทับฟอร์มทั้งหมด">📥 Import (Replace)</button>
              <button type="button" class="btn btn-sm btn-outline-info" id="mc-tpl-import-merge" title="โหลดไฟล์แบบ merge · อัพเดทเฉพาะ field ที่อยู่ในไฟล์">📥 Import (Merge)</button>
            </div>
            <div id="mc-tpl-status" class="bot-settings-status text-muted small"></div>
          </div>
        </details>

        <details class="lux-details" id="mc-group-system" data-settings-group="system" open>
          <summary class="lux-details-summary">
            <span class="bot-settings-group-icon">🛠️</span>
            <span class="bot-settings-group-title">ตั้งค่าระบบ</span>
            <span class="bot-settings-group-hint">Master switches · CB Version · Auto Delete</span>
          </summary>
          <div class="lux-details-body">
            <div class="bot-settings-note mb-3">ค่ากลุ่มนี้เป็นระดับระบบและมีผลแยกจากค่ารายบอทด้านล่าง กด “บันทึกค่าระบบ” เพื่อยืนยันเฉพาะกลุ่มนี้</div>
            <div class="row g-3">
              <div class="col-md-4">
                <div class="bot-settings-option h-100">
                  <label class="form-check form-switch d-flex align-items-start gap-2 mb-0" style="cursor:pointer;">
                    <input type="checkbox" class="form-check-input" id="mc-master-dps" ${cfg.masterDynamicSizeEnabled !== false ? 'checked' : ''} />
                    <span>📊 <strong>DPS Master</strong><small class="text-muted-3 d-block">เปิด DPS ทั้งระบบ</small></span>
                  </label>
                </div>
              </div>
              <div class="col-md-4">
                <div class="bot-settings-option h-100">
                  <label class="form-check form-switch d-flex align-items-start gap-2 mb-0" style="cursor:pointer;">
                    <input type="checkbox" class="form-check-input" id="mc-master-cb-au" ${cfg.masterCbAutoUnlockEnabled === true ? 'checked' : ''} />
                    <span>🔓 <strong>CB Auto-Unlock Master</strong><small class="text-muted-3 d-block">อนุญาต Auto-Unlock ทั้งระบบ</small></span>
                  </label>
                </div>
              </div>
              <div class="col-md-4">
                <div class="bot-settings-option h-100">
                  <label class="form-check form-switch d-flex align-items-start gap-2 mb-0" style="cursor:pointer;">
                    <input type="checkbox" class="form-check-input" id="mc-master-auto-delete" ${cfg.autoDeleteBotEnabled === true ? 'checked' : ''} />
                    <span>🗑️ <strong>Auto Delete Bot</strong><small class="text-muted-3 d-block">ลบบอทตามอายุที่กำหนด</small></span>
                  </label>
                </div>
              </div>
              <div class="col-md-6">
                <div class="bot-settings-field h-100">
                  <label class="form-label" for="mc-cb-version">💎 CB Version ที่ใช้ทั้งระบบ</label>
                  <select class="form-select form-select-sm" id="mc-cb-version">
                    <option value="v2" ${cfg.cbVersion === 'v2' ? 'selected' : ''}>v2 — 4 red candles below Lower-KC</option>
                    <option value="v3" ${(cfg.cbVersion || 'v3') === 'v3' ? 'selected' : ''}>v3 — CBv2 + ST3 Upper-TF (แนะนำ)</option>
                  </select>
                </div>
              </div>
              <div class="col-md-3">
                <div class="bot-settings-field h-100">
                  <label class="form-label" for="mc-auto-delete-days">เกณฑ์ Auto-delete (วัน)</label>
                  <input type="number" class="form-control form-control-sm" id="mc-auto-delete-days" value="${cfg.autoDeleteBotDays ?? 30}" min="7" max="365" step="1" />
                </div>
              </div>
              <div class="col-md-3">
                <div class="bot-settings-field h-100">
                  <label class="form-label" for="mc-auto-delete-warndays">แจ้งเตือนล่วงหน้า (วัน)</label>
                  <input type="number" class="form-control form-control-sm" id="mc-auto-delete-warndays" value="${cfg.autoDeleteBotWarningDays ?? 3}" min="1" max="30" step="1" />
                </div>
              </div>
              <div class="col-md-4">
                <div class="bot-settings-option h-100">
                  <label class="form-check form-switch d-flex align-items-start gap-2 mb-0" style="cursor:pointer;">
                    <input type="checkbox" class="form-check-input" id="mc-master-auto-timing" ${cfg.autoTimingEnabled === true ? 'checked' : ''} />
                    <span>⏱️ <strong>Auto-Timing Master</strong><small class="text-muted-3 d-block">เปิด Auto-Timing (heatmap-driven entry gate) ทั้งระบบ · เปิดใบ้ bot-level จะ inherit ค่านี้</small></span>
                  </label>
                </div>
              </div>
              <!-- FIX-2026-09-04: DLC master + base loss moved OUT of Master Config into inline bot-edit DLC accordion (user: "อย่าใส่ใน ตั้งค่าระบบ ใช้งานยาก") -->
            </div>
            <div class="bot-settings-actions mt-3">
              <button type="button" class="btn btn-sm btn-outline-warning" id="mc-save-master">💾 บันทึกค่าระบบ</button>
              <button type="button" class="btn btn-sm btn-outline-info" id="mc-run-auto-delete">▶ Run Auto Delete 1 รอบ</button>
              <span id="mc-master-status" class="bot-settings-status small text-muted"></span>
            </div>
            <div class="small text-muted-3 mt-2">
              Last run: <span id="mc-auto-delete-last-run">${cfg.autoDeleteBotLastRunAt ? new Date(cfg.autoDeleteBotLastRunAt).toLocaleString() : '—'}</span>
              ${cfg.autoDeleteBotLastStats ? ` · ${escapeHtml(JSON.stringify(cfg.autoDeleteBotLastStats))}` : ''}
            </div>
          </div>
        </details>

        <details class="lux-details" id="mc-group-targets" data-settings-group="targets" open>
          <summary class="lux-details-summary">
            <span class="bot-settings-group-icon">📋</span>
            <span class="bot-settings-group-title">เลือกบอทและควบคุม Start/Stop</span>
            <span class="bot-settings-group-hint">${cachedBots.length} บอท · <span style="color:#4ade80;">🟢 ${activeCount} active</span>${deletedCount > 0 ? ` · <span style="color:#ff6b6b;">� ${deletedCount} deleted</span>` : ''} · เลือก enabled เป็นค่าเริ่มต้น</span>
          </summary>
          <div class="lux-details-body">
            <div class="d-flex gap-2 flex-wrap mb-2">
              <button type="button" class="btn btn-sm btn-outline-gold" id="mc-select-all">เลือกทั้งหมด</button>
              <button type="button" class="btn btn-sm btn-outline-gold" id="mc-select-none">ไม่เลือกเลย</button>
              <button type="button" class="btn btn-sm btn-outline-gold" id="mc-select-enabled">เฉพาะที่ Enabled</button>
              ${deletedCount > 0 ? '<button type="button" class="btn btn-sm btn-outline-info" id="mc-select-not-deleted" title="เลือกเฉพาะบอทที่ยังไม่ถูกลบ (active) — มีประโยชน์เมื่อต้องการ deselect บอทที่ถูก soft-delete ออกจากรายการ">✅ เลือกบอทที่ไม่ลบ</button>' : ''}
              ${deletedCount > 0 ? '<button type="button" class="btn btn-sm btn-outline-info" id="mc-select-deleted" title="เลือกเฉพาะบอทที่ถูก soft-delete เพื่อ Restore">🗑 เลือกบอทที่ลบ</button>' : ''}
            </div>
            <div class="mb-3 p-2" style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); border-radius:8px; max-height:190px; overflow-y:auto;">
              ${botListHtml}
            </div>
            <div class="bot-settings-actions">
              <button type="button" class="btn btn-sm btn-outline-success" id="mc-toggle-start" title="เริ่ม scan ตลาดและเปิด order ตาม signal">▶️ Start ที่เลือก</button>
              <button type="button" class="btn btn-sm btn-outline-warning" id="mc-toggle-stop" title="หยุดเปิดไม้ใหม่; position ที่ถืออยู่ยังทำงานต่อ">⏸ Stop ที่เลือก</button>
              ${deletedCount > 0 ? '<button type="button" class="btn btn-sm btn-outline-info" id="mc-toggle-restore" title="Restore บอทที่ถูก soft-delete (เฉพาะบอทที่ลบเลือกอยู่)">↩️ Restore ที่เลือก</button>' : ''}
              <span class="bot-settings-status text-muted small" id="mc-toggle-status"></span>
            </div>
          </div>
        </details>

        ${sectionsHtml}


        <div class="bot-settings-actions">
          <button type="button" class="btn btn-primary" id="mc-submit">💾 ใช้ค่ากับบอทที่เลือก</button>
          <button type="button" class="btn btn-outline-info" id="mc-set-to-new-bot" title="เอาค่าที่กรอกไว้ไปตั้งเป็นค่าเริ่มต้นของบอทใหม่">📋 Set to new bot</button>
          <button type="button" class="btn btn-secondary" id="mc-cancel">ยกเลิก</button>
          <span class="bot-settings-status text-muted small" id="mc-status"></span>
        </div>
      </div>
    `;

    document.getElementById('mc-select-all').onclick = () => {
      container.querySelectorAll('.mc-bot-check').forEach((checkbox) => { checkbox.checked = true; });
    };
    document.getElementById('mc-select-none').onclick = () => {
      container.querySelectorAll('.mc-bot-check').forEach((checkbox) => { checkbox.checked = false; });
    };
    document.getElementById('mc-select-enabled').onclick = () => {
      container.querySelectorAll('.mc-bot-check').forEach((checkbox, index) => {
        checkbox.checked = cachedBots[index] && cachedBots[index].enabled !== false;
      });
    };
    document.getElementById('mc-cancel').onclick = close;
    document.getElementById('mc-toggle-start').onclick = () => bulkToggle('enable', '▶️ Start');
    // FIX-2026-08-23: select-not-deleted — เลือกเฉพาะบอท active (!deletedAt)
    //   - ใช้ deselect บอทที่ถูก soft-delete ออกจากการเลือก โดยไม่ต้องไล่ untick ทีละตัว
    //   - ปุ่มนี้แสดงเฉพาะเมื่อมีบอทที่ลบ (เรียงคู่กับ mc-select-deleted)
    const notDeletedBtn = document.getElementById('mc-select-not-deleted');
    if (notDeletedBtn) {
      notDeletedBtn.onclick = () => {
        container.querySelectorAll('.mc-bot-check').forEach((checkbox, index) => {
          checkbox.checked = cachedBots[index] && !cachedBots[index].deletedAt;
        });
      };
    }
    document.getElementById('mc-select-deleted').onclick = () => {
      container.querySelectorAll('.mc-bot-check').forEach((checkbox, index) => {
        checkbox.checked = cachedBots[index] && !!cachedBots[index].deletedAt;
      });
    };
    const restoreBtn = document.getElementById('mc-toggle-restore');
    if (restoreBtn) restoreBtn.onclick = bulkRestore;

    document.getElementById('mc-toggle-stop').onclick = () => bulkToggle('disable', '⏸ Stop');
    // FIX-2026-08-14: Set to new bot — collect form values, stash in sessionStorage, open New Bot modal
    const setNewBotBtn = document.getElementById('mc-set-to-new-bot');
    if (setNewBotBtn) setNewBotBtn.onclick = onSetToNewBot;
    const saveMaster = document.getElementById('mc-save-master');
    if (saveMaster) saveMaster.onclick = saveMasterToggles;
    const runAutoDelete = document.getElementById('mc-run-auto-delete');
    if (runAutoDelete) runAutoDelete.onclick = forceRunAutoDelete;
    // FIX-2026-08-13: wire template panel buttons
    refreshTemplateDropdown();
    const tplLoad = document.getElementById('mc-tpl-load');
    if (tplLoad) tplLoad.onclick = onTemplateLoad;
    const tplSave = document.getElementById('mc-tpl-save');
    if (tplSave) tplSave.onclick = onTemplateSave;
    const tplRename = document.getElementById('mc-tpl-rename');
    if (tplRename) tplRename.onclick = onTemplateRename;
    const tplDup = document.getElementById('mc-tpl-duplicate');
    if (tplDup) tplDup.onclick = onTemplateDuplicate;
    const tplDel = document.getElementById('mc-tpl-delete');
    if (tplDel) tplDel.onclick = onTemplateDelete;
    // FIX-2026-08-14: Import/Export buttons
    const tplExport = document.getElementById('mc-tpl-export');
    if (tplExport) tplExport.onclick = onTemplateExport;
    const tplImpReplace = document.getElementById('mc-tpl-import-replace');
    if (tplImpReplace) tplImpReplace.onclick = () => onTemplateImport('replace');
    const tplImpMerge = document.getElementById('mc-tpl-import-merge');
    if (tplImpMerge) tplImpMerge.onclick = () => onTemplateImport('merge');
  }

  // FIX-2026-08-08: save master toggles (DPS / CB Auto-Unlock / Auto Delete Bot / CB Version)
  //   - PUT /api/admin/app-config — invalidates masterConfig cache + cbVersion cache
  async function saveMasterToggles() {
    const status = document.getElementById('mc-master-status');
    const cbVerEl = document.getElementById('mc-cb-version');
    const payload = {
      masterDynamicSizeEnabled: document.getElementById('mc-master-dps').checked,
      masterCbAutoUnlockEnabled: document.getElementById('mc-master-cb-au').checked,
      autoDeleteBotEnabled: document.getElementById('mc-master-auto-delete').checked,
      autoDeleteBotDays: parseInt(document.getElementById('mc-auto-delete-days').value, 10),
      autoDeleteBotWarningDays: parseInt(document.getElementById('mc-auto-delete-warndays').value, 10),
      cbVersion: cbVerEl ? cbVerEl.value : undefined,
      // FIX-2026-08-31: System-level Auto-Timing master (AppConfig.autoTimingEnabled)
      //   Distinct from mc-autoTimingEnabled (per-bot tristate) below.
      autoTimingEnabled: document.getElementById('mc-master-auto-timing').checked,
      // FIX-2026-09-04: DLC master toggles removed from Master Config (moved inline to bot-edit DLC accordion).
      //   masterDlcEnabled + dlcBaseLossPct are still accepted via PUT /api/admin/app-config
      //   for DB-direct updates; UI exposes them next to per-bot DLC toggle.
    };
    status.textContent = '⏳ กำลังบันทึก…';
    status.style.color = 'var(--text-3)';
    try {
      const resp = await API.put('/api/admin/app-config', payload);
      status.textContent = '✅ บันทึกสำเร็จ';
      status.style.color = '#4ade80';
      setTimeout(() => {
        status.textContent = '';
        // refresh modal to show new state (CB sections toggle based on cbVersion)
        openMasterConfigModal();
      }, 1500);
    } catch (err) {
      status.textContent = '❌ ' + err.message;
      status.style.color = '#ff6b6b';
    }
  }

  // FIX-2026-08-08: force-run autoDeleteBot immediately (1 cycle)
  //   - POST /api/admin/auto-delete-run
  //   - returns stats object, displayed in modal
  async function forceRunAutoDelete() {
    const status = document.getElementById('mc-master-status');
    if (!(await AdminModalAlert.confirm({ title: '▶ Force Run Auto Delete Bot', message: 'Force run Auto Delete Bot 1 cycle? จะสแกนบอททั้งหมดและ soft-delete ตาม threshold', level: 'warn', okLabel: '▶ Run' }))) return;
    status.textContent = '⏳ กำลังรัน…';
    status.style.color = 'var(--text-3)';
    try {
      // FIX-2026-08-24: password gate removed — direct API call
      const resp = await API.post('/api/admin/auto-delete-run', {});
      status.textContent = `✅ scanned=${resp.stats?.scanned ?? '?'} · warned=${resp.stats?.warned ?? 0} · deleted=${resp.stats?.scheduled ?? 0}`;
      status.style.color = '#4ade80';
      // update last-run display
      const lastRunEl = document.getElementById('mc-auto-delete-last-run');
      if (lastRunEl) lastRunEl.textContent = new Date().toLocaleString();
    } catch (err) {
      status.textContent = '❌ ' + err.message;
      status.style.color = '#ff6b6b';
    }
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
    // - value "true" / "false" → �่งค่าจริง (clobber ค่าเดิม)
    document.querySelectorAll('.mc-toggle-mode').forEach((el) => {
      if (el.checked && el.value !== '') {
        settings[el.getAttribute('data-key')] = (el.value === 'true');
      }
    });

    // FIX-2026-08-30 / Phase 4: autoTimingEnabled is 3-state string ("inherit"/"true"/"false")
    //   Convert to real null/true/false before POST so backend whitelist accepts it.
    if ('autoTimingEnabled' in settings) {
      const v = settings.autoTimingEnabled;
      settings.autoTimingEnabled = v === 'true' ? true : v === 'false' ? false : null;
    }

    if (Object.keys(settings).length === 0) {
      status.textContent = '❌ กรอก field อย่างน้อย 1 อย่าง หรือติ๊ก toggle อย่างนั้น 1 อย่าง';
      status.style.color = '#ff6b6b';
      return;
    }

    // Confirm clobber
    const ok = await AdminModalAlert.confirm({
      title: '⚠️ Bulk Update',
      message: `ยืนยัน: overwrite ${Object.keys(settings).length} fields บน ${selectedBotIds.length} บอท\n\nFields ที่จะเปลี่ยน:\n${Object.keys(settings).join(', ')}`,
      level: 'error', okLabel: 'Overwrite',
    });
    if (!ok) return;

    status.textContent = '⏳ กำลังส่ง…';
    status.style.color = 'var(--text-3)';
    try {
      // FIX-2026-08-24: password gate removed — direct API call
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
    // FIX-2026-08-22: filter out soft-deleted bots — enableBot throws error for them
    //   - deleted bots ต้อง Restore ก่อน (ปุ่ม ↩️ Restore) — Start/Stop ห้ามใช้บนบอทที่ลบ
    //   - รายงาน skipped count ใน confirm + status เพื่อให้ user เห็นว่ามีบอทที่ข้ามไป
    const deletedSkipped = selectedBotIds.filter((id) => {
      const b = cachedBots.find((x) => String(x._id) === String(id));
      return b && b.deletedAt;
    });
    const toggleableBotIds = selectedBotIds.filter((id) => !deletedSkipped.includes(id));
    if (toggleableBotIds.length === 0) {
      status.textContent = '❌ บอทที่เลือกทั้งหมดถูก soft-delete — ใช้ปุ่ม "↩️ Restore" แทน';
      status.style.color = '#ff6b6b';
      return;
    }
    const skipNote = deletedSkipped.length > 0 ? '\n\n(ข้าม ' + deletedSkipped.length + ' บอทที่ถูก soft-delete)' : '';
    const verb = action === 'enable' ? 'เปิด' : 'หยุด';
    const ok = await AdminModalAlert.confirm({
      title: verb === 'เปิด' ? '▶️ Start Bots' : '⏸️ Stop Bots',
      message: `ยืนยัน${verb} ${toggleableBotIds.length} บอท?${skipNote}`,
      level: 'warn', okLabel: verb,
    });
    if (!ok) return;

    status.textContent = `⏳ กำลัง${verb}…`;
    status.style.color = 'var(--text-3)';
    try {
      // FIX-2026-08-24: password gate removed — direct API call
      const resp = await API.post('/api/bots/bulk-toggle', { botIds: toggleableBotIds, action });
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

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // ════════════════════════════════════════════════════════════════════════════════════════════
  // FIX-2026-08-22: bulkRestore — Restore บอทที่ถูก soft-delete หลายตัวพร้อมกัน
  //   - POST /api/bots/bulk-restore (password-protected เหมือน bulk-toggle)
  //   - filter เฉพาะบอทที่ถูก soft-delete จริง� (selected deleted bots only)
  //   - แสดง per-bot result + error ของบอทที่ล้มเหลว (เช่น เกิน 30 วัน)
  // ════════════════════════════════════════════════════════════════════════════════════════════
  async function bulkRestore() {
    const status = document.getElementById('mc-toggle-status');
    const selectedBotIds = Array.from(document.querySelectorAll('.mc-bot-check:checked')).map((c) => c.getAttribute('data-bot-id'));
    if (selectedBotIds.length === 0) {
      status.textContent = '� เลือกบอทอย่างน้อย 1 ตัว';
      status.style.color = '#ff6b6b';
      return;
    }
    // filter เฉพาะบอทที่ deleted จริง (ไม่งั้น backend จะ return 400 "Bot is not soft-deleted")
    const restoreIds = selectedBotIds.filter((id) => {
      const b = cachedBots.find((x) => String(x._id) === String(id));
      return b && b.deletedAt;
    });
    const skipped = selectedBotIds.length - restoreIds.length;
    if (restoreIds.length === 0) {
      status.textContent = '❌ บอทที่เลือกไม่มีตัวที่ถูก soft-delete — เ�ือกเฉพาะบอทที่มี chip 🗑 DELETED';
      status.style.color = '#ff6b6b';
      return;
    }
    const skipNote = skipped > 0 ? '\n\n(ข้าม ' + skipped + ' บอทที่ยังไม่ได้ลบ)' : '';
    const ok = await AdminModalAlert.confirm({
      title: '↩️ Restore Bots',
      message: `ยืนยัน Restore ${restoreIds.length} บอท?${skipNote}

บอทที่ restore แล้วจะกลับมาทำงานตามปกติ (แต่จะยังไม่ถูก Start อัตโนมัติ — ใช้ปุ่ม "▶️ Start" แยกต่างหาก)`,
      level: 'warn', okLabel: '↩️ Restore',
    });
    if (!ok) return;

    status.textContent = '⏳ กำลัง Restore…';
    status.style.color = 'var(--text-3)';
    try {
      // FIX-2026-08-24: password gate removed — direct API call
      const resp = await API.post('/api/bots/bulk-restore', { botIds: restoreIds });
      const results = resp.results || [];
      const failed = results.filter((r) => !r.ok);
      const succeeded = results.filter((r) => r.ok);
      if (failed.length === 0) {
        status.textContent = `✅ สำเร็จ — Restore ${succeeded.length} บอท`;
        status.style.color = '#4ade80';
      } else {
        const failedNames = failed.map((r) => {
          const bot = cachedBots.find((b) => String(b._id) === String(r.botId));
          return `${bot ? (bot.name || bot.symbol) : r.botId}: ${r.error}`;
        }).join('; ');
        status.textContent = `⚠️ สำเร็จ ${succeeded.length}/${results.length}, �้มเหลว ${failed.length} — ${failedNames}`;
        status.style.color = '#ffa500';
      }
      // Refresh bots list (อัพเดท deleted status) หลังผ่านไป 1.5s
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

  // FIX-2026-08-13: Templates panel — Save / Load / Rename / Duplicate / Delete
  //   - All handlers call /api/admin/master-config-templates (CRUD on AppConfig.masterConfigTemplates)
  //   - Load populates the form (preview-then-apply) — user still clicks "ใช้ค่ากับบอทที่เลือก"
  //   - Save collects form via the same logic as submit()'s collection block
  // ════════════════════════════════════════════════════════════════════════════════════════════

  async function refreshTemplateDropdown() {
    try {
      const resp = await API.get('/api/admin/master-config-templates');
      cachedTemplates = (resp && resp.templates) || [];
      const sel = document.getElementById('mc-tpl-select');
      if (!sel) return;
      const previousValue = sel.value;
      const optsHtml = cachedTemplates.map((t) => {
        const updatedDate = t.updatedAt ? new Date(t.updatedAt).toLocaleDateString('th-TH') : '';
        const label = `${escapeHtml(t.name)} · ${t.fieldCount} fields${updatedDate ? ' · ' + updatedDate : ''}`;
        return `<option value="${escapeHtml(t.id)}">${label}</option>`;
      }).join('');
      sel.innerHTML = '<option value="">— เลือก template —</option>' + optsHtml;
      // preserve previous selection if still present
      if (previousValue && cachedTemplates.some((t) => t.id === previousValue)) sel.value = previousValue;
      setTemplateStatus(`${cachedTemplates.length} templates`);
    } catch (err) {
      setTemplateStatus('️ โหลด templates ล้มเหลว: ' + err.message, 'danger');
    }
  }

  function setTemplateStatus(msg, variant) {
    const el = document.getElementById('mc-tpl-status');
    if (!el) return;
    el.textContent = msg;
    const colors = { danger: '#ff6b6b', success: '#4ade80', warn: '#ffa500' };
    el.style.color = colors[variant] || 'var(--text-3)';
  }

  // Collect current form settings (mirror of submit()'s collection logic — extracted helper)
  function collectCurrentFormSettings() {
    const settings = {};
    document.querySelectorAll('.mc-field').forEach((el) => {
      const v = el.value;
      if (v === '' || v == null) return;
      if (el.classList.contains('mc-field-select')) {
        // Select (timeframe) — ส่ง string ตรง ๆ
        settings[el.getAttribute('data-key')] = v;
      } else {
        const num = parseFloat(v);
        if (Number.isFinite(num)) {
          settings[el.getAttribute('data-key')] = num;
        }
      }
    });
    document.querySelectorAll('.mc-toggle-mode').forEach((el) => {
      if (el.checked && el.value !== '') {
        settings[el.getAttribute('data-key')] = (el.value === 'true');
      }
    });
    return settings;
  }

  // FIX-2026-08-14: "Set to new bot" — persist current Master Config values to AppConfig.botDefaults
  //   via PUT /api/admin/bot-defaults. After save, both the manual "+ New Bot" modal and the Auto
  //   Add Bot path will use these values as defaults (next time they read /api/admin/bot-defaults).
  //   - maps Master Config key 'timeframe' → 'defaultTimeframe' (single TF slot in botDefaults)
  //   - uses callBotWithPassword which prompts via themed modal on 403/503 (matches existing UI)
  //   - does NOT open New Bot modal automatically — user clicks "+ New Bot" or runs Auto Add normally
  async function onSetToNewBot() {
    const settings = collectCurrentFormSettings();
    if (Object.keys(settings).length === 0) {
      const status = document.getElementById('mc-status');
      if (status) {
        status.textContent = '❌ กรอก field หรือติ๊ก toggle อย่างน้อย 1 อย่างก่อน';
        status.style.color = '#ff6b6b';
      }
      return;
    }
    // Map Master Config keys → botDefaults keys (only timeframe differs)
    const payload = {};
    for (const [k, v] of Object.entries(settings)) {
      if (k === 'timeframe') payload.defaultTimeframe = v;
      else payload[k] = v;
    }
    const fieldCount = Object.keys(payload).length;
    if (!(await AdminModalAlert.confirm({
      title: '📋 Save as Bot Defaults',
      message: `จะตั้งค่า ${fieldCount} fields เป็นค่าเริ่มต้นของบอทใหม่ (Bot Defaults)?\n\nใช้กับ "+ New Bot" และ "Auto Add Bot" ในครั้งถัดไป`,
      level: 'warn', okLabel: 'Save as Defaults',
    }))) return;

    const status = document.getElementById('mc-status');
    if (status) {
      status.textContent = '⏳ กำลังบันทึก…';
      status.style.color = 'var(--text-3)';
    }
    try {
      // FIX-2026-08-24: password gate removed — direct API call
      await API.put('/api/admin/bot-defaults', payload);
      if (status) {
        status.textContent = `✅ บันทึก ${fieldCount} fields เป็นค่าเริ่มต้นแล้ว · ใช้กับบอทใหม่ครั้งถัดไป`;
        status.style.color = '#4ade80';
      }
    } catch (err) {
      if (status) {
        status.textContent = '❌ ' + (err.message || err);
        status.style.color = '#ff6b6b';
      }
    }
  }

  // True if user has touched any field or toggle (used to warn before Load overwrite)
  function isFormDirty() {
    for (const el of document.querySelectorAll('.mc-field')) {
      if (el.value !== '' && el.value != null) return true;
    }
    for (const el of document.querySelectorAll('.mc-toggle-mode')) {
      if (el.checked && el.value !== '') return true;
    }
    return false;
  }

  async function promptForName(title, defaultValue) {
    const v = await AdminModalAlert.prompt({
      title: title || 'กรอกชื่อ',
      defaultValue: defaultValue || '',
      placeholder: 'ตั้งชื่อ',
      level: 'info', okLabel: 'ตกลง',
    });
    return v;
  }

  function getSelectedTemplateId() {
    const sel = document.getElementById('mc-tpl-select');
    return sel ? sel.value : '';
  }

  function setSelectedTemplateId(id) {
    const sel = document.getElementById('mc-tpl-select');
    if (sel) sel.value = id || '';
  }

  async function onTemplateSave() {
    const settings = collectCurrentFormSettings();
    if (Object.keys(settings).length === 0) {
      setTemplateStatus('❌ ต้องกรอก field หรือติ๊ก toggle อย่างน้อย 1 อย่างก่อน Save', 'danger');
      return;
    }
    const selectedId = getSelectedTemplateId();
    if (selectedId) {
      const existing = cachedTemplates.find((t) => t.id === selectedId);
      if (!existing) {
        setTemplateStatus('⚠️ template ที่เลือกไม่อยู่ในรายการ — กด refresh', 'warn');
        return;
      }
      if (!(await AdminModalAlert.confirm({
        title: '⚠️ Overwrite Template',
        message: `จะ overwrite settings ของ template "${existing.name}" ใช่มั้ย? (ชื่อเดิม)`,
        level: 'warn', okLabel: 'Overwrite',
      }))) return;
      setTemplateStatus('⏳ กำลัง save…');
      try {
        const resp = await API.put(`/api/admin/master-config-templates/${encodeURIComponent(selectedId)}`, { settings });
        setTemplateStatus(`✅ บันทึกทับ "${resp.template.name}" (${Object.keys(resp.template.settings).length} fields)`, 'success');
        await refreshTemplateDropdown();
      } catch (err) {
        setTemplateStatus('❌ ' + err.message, 'danger');
      }
      return;
    }
    const name = promptForName('ตั้งชื่อ Template ใหม่ (max 50 chars):');
    if (name == null) return;
    setTemplateStatus('⏳ กำลัง save…');
    try {
      const resp = await API.post('/api/admin/master-config-templates', { name, settings });
      setTemplateStatus(`✅ สร้าง "${resp.template.name}" (${Object.keys(resp.template.settings).length} fields, dropped=${resp.droppedFields || 0})`, 'success');
      await refreshTemplateDropdown();
      setSelectedTemplateId(resp.template.id);
    } catch (err) {
      setTemplateStatus('❌ ' + err.message, 'danger');
    }
  }

  async function onTemplateLoad() {
    const id = getSelectedTemplateId();
    if (!id) { setTemplateStatus('⚠️ เลือก template ก่อน', 'warn'); return; }
    if (isFormDirty() && !(await AdminModalAlert.confirm({
      title: '⚠️ Load Template',
      message: 'ท่านมีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก — แน่ใจมั้ยที่จะ Load (จะทับฟอร์ม)?',
      level: 'warn', okLabel: 'Load ทับ',
    }))) return;
    setTemplateStatus('⏳ กำลัง load…');
    try {
      const resp = await API.get(`/api/admin/master-config-templates/${encodeURIComponent(id)}`);
      applyTemplateToForm(resp.template.settings);
      const n = Object.keys(resp.template.settings).length;
      setTemplateStatus(`✅ โหลด "${resp.template.name}" (${n} fields) — กด “ใช้ค่ากับบอทที่เลือก” เพื่อ apply`, 'success');
    } catch (err) {
      setTemplateStatus('❌ ' + err.message, 'danger');
    }
  }

  function applyTemplateToForm(settings) {
    settings = settings || {};
    // 1) Clear all fields first — start from clean state
    document.querySelectorAll('.mc-field').forEach((el) => { el.value = ''; });
    document.querySelectorAll('.mc-toggle-mode').forEach((el) => { el.checked = (el.value === ''); });
    // 2) Apply values
    let applied = 0;
    let skipped = 0;
    for (const [key, value] of Object.entries(settings)) {
      const fieldEl = document.querySelector(`.mc-field[data-key="${CSS.escape(key)}"]`);
      if (fieldEl) {
        fieldEl.value = String(value);
        applied += 1;
        continue;
      }
      // Toggles: find radio matching key + value (true/false). value="" not in settings.
      const radios = document.querySelectorAll(`.mc-toggle-mode[data-key="${CSS.escape(key)}"]`);
      let matched = false;
      for (const r of radios) {
        if (r.value === String(value)) { r.checked = true; matched = true; break; }
      }
      if (matched) applied += 1; else skipped += 1;
    }
    if (skipped > 0) {
      console.warn(`[masterConfigModal] applyTemplateToForm: ${skipped} fields skipped (likely hidden by cbVersion)`);
    }
    return applied;
  }

  async function onTemplateRename() {
    const id = getSelectedTemplateId();
    if (!id) { setTemplateStatus('⚠️ เลือก template ก่อน', 'warn'); return; }
    const existing = cachedTemplates.find((t) => t.id === id);
    if (!existing) { setTemplateStatus('⚠️ template หายไปจากรายการ', 'warn'); return; }
    const name = promptForName('เปลี่ยนชื่อ Template:', existing.name);
    if (name == null || name === existing.name) return;
    setTemplateStatus('⏳ กำลัง rename…');
    try {
      const resp = await API.put(`/api/admin/master-config-templates/${encodeURIComponent(id)}`, { name });
      setTemplateStatus(`✅ เปลี่ยนชื่อเปน "${resp.template.name}"`, 'success');
      await refreshTemplateDropdown();
      setSelectedTemplateId(resp.template.id);
    } catch (err) {
      setTemplateStatus('❌ ' + err.message, 'danger');
    }
  }

  async function onTemplateDuplicate() {
    const id = getSelectedTemplateId();
    if (!id) { setTemplateStatus('️ เลือก template ก่อน', 'warn'); return; }
    const existing = cachedTemplates.find((t) => t.id === id);
    if (!existing) { setTemplateStatus('⚠️ template หายไปจากรายการ', 'warn'); return; }
    const name = promptForName(`Duplicate "${existing.name}" — ตั้งชื่อใหม่:`, existing.name + ' (copy)');
    if (name == null) return;
    setTemplateStatus('⏳ กำลัง duplicate…');
    try {
      const full = await API.get(`/api/admin/master-config-templates/${encodeURIComponent(id)}`);
      const resp = await API.post('/api/admin/master-config-templates', { name, settings: full.template.settings });
      setTemplateStatus(`✅ Duplicate → "${resp.template.name}"`, 'success');
      await refreshTemplateDropdown();
      setSelectedTemplateId(resp.template.id);
    } catch (err) {
      setTemplateStatus('❌ ' + err.message, 'danger');
    }
  }

  async function onTemplateDelete() {
    const id = getSelectedTemplateId();
    if (!id) { setTemplateStatus('⚠️ เลือก template ก่อน', 'warn'); return; }
    const existing = cachedTemplates.find((t) => t.id === id);
    if (!existing) { setTemplateStatus('⚠️ template หายไปจากรายการ', 'warn'); return; }
    if (!(await AdminModalAlert.confirm({
      title: '🗑️ Delete Template',
      message: `ลบ template "${existing.name}" ใช่มั้ย? การกระทำนี้ไม่สามาร undo ได้`,
      level: 'error', okLabel: '🗑️ ลบ',
    }))) return;
    setTemplateStatus('⏳ กำลังลบ…');
    try {
      await API.delete(`/api/admin/master-config-templates/${encodeURIComponent(id)}`);
      setTemplateStatus(`✅ ลบ "${existing.name}" แล้ว`, 'success');
      await refreshTemplateDropdown();
      setSelectedTemplateId('');
    } catch (err) {
      setTemplateStatus('❌ ' + err.message, 'danger');
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // FIX-2026-08-14: Import/Export ไฟล์ (cross-surface compatible JSON)
  //   - Export: serialize ฟอร์มปัจจุบัน → download .json
  //   - Import: เลือกไฟล์ → parse → apply ลงฟอร์ม (Replace หรือ Merge)
  //   - shared กับ bot-edit / New Bot / Bot Defaults — type field เป็น origin hint เท่านั้น
  // ════════════════════════════════════════════════════════════════════════════════════════════

  function onTemplateExport() {
    if (!window.botConfigIO) {
      setTemplateStatus('❌ botConfigIO module ไม่ได้โหลด', 'danger');
      return;
    }
    const settings = collectCurrentFormSettings();
    const fieldCount = Object.keys(settings).length;
    if (fieldCount === 0) {
      setTemplateStatus('❌ ฟอร์มว่าง — กรอกค่าก่อน export', 'danger');
      return;
    }
    // Use selected template name (if any) as filename hint
    const selectedId = getSelectedTemplateId();
    const selectedTpl = cachedTemplates.find((t) => t.id === selectedId);
    const name = selectedTpl ? selectedTpl.name : 'form';
    const cbVersionEl = document.getElementById('mc-cb-version');
    const cbVersion = cbVersionEl ? cbVersionEl.value : null;
    const payload = window.botConfigIO.buildExportPayload({
      type: 'master-template',
      name,
      source: 'master-config',
      settings,
      cbVersion,
    });
    const filename = window.botConfigIO.buildExportFilename('master-template', name);
    window.botConfigIO.triggerDownload(filename, payload);
    setTemplateStatus(`✅ Export ${fieldCount} fields → ${filename}`, 'success');
  }

  async function onTemplateImport(mode) {
    if (!window.botConfigIO) {
      setTemplateStatus('❌ botConfigIO module ไม่โหลด', 'danger');
      return;
    }
    if (mode === 'replace' && isFormDirty() && !(await AdminModalAlert.confirm({
      title: '⚠️ Import (Replace Mode)',
      message: 'ท่านมีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก — แน่ใจมั้ยที่จะ Import (จะทับฟอร์ม)?',
      level: 'warn', okLabel: 'Import ทับ',
    }))) return;
    setTemplateStatus('⏳ กำลังเลือกไฟล์…');
    const file = await window.botConfigIO.pickJsonFile();
    if (!file) { setTemplateStatus('ยกเลิก', 'warn'); return; }
    setTemplateStatus(`⏳ กำลังอ่าน ${file.name}…`);
    const result = await window.botConfigIO.parseImportFile(file);
    if (!result.ok) {
      setTemplateStatus('❌ ' + result.error, 'danger');
      return;
    }
    const warnings = result.warnings || [];
    const sanitize = result.sanitizeResult;
    const { applied, skipped } = window.botConfigIO.applyToForm(sanitize.settings, 'master-config', { mode });
    // Summary
    const parts = [];
    parts.push(`✅ Import ${applied} fields (${mode})`);
    if (sanitize.dropped > 0) parts.push(`dropped ${sanitize.dropped} unknown`);
    if (skipped.length > 0) parts.push(`skipped ${skipped.length}`);
    if (warnings.length > 0) parts.push(`⚠️ ${warnings.join('; ')}`);
    setTemplateStatus(parts.join(' · '), warnings.length ? 'warn' : 'success');
  }
})();