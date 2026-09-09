#!/usr/bin/env python3
"""Batch 3: settings.js Bot Defaults — sync values, add Martingale, fix dup, gate CBv2/3 by cbVersion, add #group-chat chip."""
import re
import sys

path = r'd:/NodeJs/OnePercentBot-System/OnePercentBotTrade/public/js/pages/settings.js'
with open(path, 'r', encoding='utf-8') as f:
    src = f.read()
original = src

# === 1. SYNC BD_RECOMMENDED values to new RECOMMENDED_DEFAULTS ===
# Use a single string replace on the whole constant block
old_bd = """const BD_RECOMMENDED = {
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
  // FIX-2026-09-06: AUv2 — F1 v2 (shallow-loss exit) — default OFF (opt-in)
  auv2Enabled: false,
  auv2MinAgeHours: 24,
  auv2LossMode: 'pct',
  auv2MaxLossPct: 5,
  auv2MaxLossThb: 200,
  auv2MaxWaitDays: 7,
  slUkcTriggerOnProfit: false,
  tpTrendEnabled: true,
  tpTrendMultiplier: 2,
  autoUpdateTp: true,
  stopLossOnUpperKC: false,
  // FIX-2026-09-02: Round-down Capital (opt-in per-bot — default OFF, min 5.5 USDT)
  roundDownCapitalEnabled: false,
  roundDownCapitalMin: 5.5,
  // FIX-2026-09-05: DLC per-bot default (opt-in, like DPS recommended=true) — but DLC is mutually exclusive with DCA, so default OFF keeps DCA available
  dlcEnabled: false,
  dlcBaseLossPct: -10,
};"""

new_bd = """// FIX-2026-09-09 audit Batch 3: mirror of src/services/botDefaults.js → RECOMMENDED_DEFAULTS
//   browser-side mirror lives at public/js/utils/recommendedDefaults.js
//   Tests: tests/recommendedDefaultsMirrorSync.test.js verifies both stay in sync.
const BD_RECOMMENDED = {
  defaultSymbol: 'BNBUSDT',
  defaultTimeframe: '3m',
  capitalPerTrade: 8,
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
  xs1Enabled: false,
  cbEnabled: false,
  cbv2Enabled: false,
  cbv2LockHours: 8,
  cbv3Enabled: false,
  cbv3LockHours: 8,
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
  cbAutoUnlockEnabled: true,
  cbAutoUnlockThresholdPct: 2,
  dynamicSizeEnabled: true,
  safeTradeEnabled: false,
  safeTradeTrendlineEnabled: false,
  safeTradeNoTradeEnabled: false,
  autoPauseEnabled: true,
  autoPauseMinKcPct: 1.2,
  autoPauseMin24hVolUsdt: 400000,
  autoPauseAdjustEnabled: true,
  autoArmStopLossOnUKC: true,
  autoArmLossPct: 10,
  autoArmAgeHours: 828,
  // AUv2 — F1 v2 (shallow-loss exit) — DEFAULT ON with thb mode
  auv2Enabled: true,
  auv2MinAgeHours: 128,
  auv2LossMode: 'thb',
  auv2MaxLossPct: 8,
  auv2MaxLossThb: 22,
  auv2MaxWaitDays: 0,
  slUkcTriggerOnProfit: true,
  tpTrendEnabled: true,
  tpTrendMultiplier: 2,
  autoUpdateTp: true,
  stopLossOnUpperKC: false,
  // Round-down Capital — DEFAULT ON (recommend flexible notional)
  roundDownCapitalEnabled: true,
  roundDownCapitalMin: 5.5,
  // DLC — DEFAULT ON (since DCA/Martingale are OFF)
  dlcEnabled: true,
  dlcBaseLossPct: -10,
};"""

if old_bd in src:
    src = src.replace(old_bd, new_bd)
    print("  OK: BD_RECOMMENDED synced to new RECOMMENDED_DEFAULTS", file=sys.stderr)
else:
    print("  NO MATCH: BD_RECOMMENDED block — manual fix needed", file=sys.stderr)

# === 2. FIX DUPLICATE bd-auto-timing-enabled select (lines 410-413) ===
old_dup = """      <div class="col-md-4">
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
        <select class="form-select form-select-sm" id="bd-auto-timing-enabled">"""

new_dup = """      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-auto-pause-adjust-enabled" ${d.autoPauseAdjustEnabled === true ? 'checked' : ''} />
          <span class="form-check-label">🎚️ Auto-pause threshold auto-adjust</span>
        </label>
      </div>
      <div class="col-md-4">
        <label class="form-label" for="bd-auto-timing-enabled">⏱️ Auto-Timing (heatmap-driven)</label>
        <select class="form-select form-select-sm" id="bd-auto-timing-enabled">"""

if old_dup in src:
    src = src.replace(old_dup, new_dup)
    print("  OK: removed duplicate bd-auto-timing-enabled select", file=sys.stderr)
else:
    print("  NO MATCH: dup auto-timing select — already fixed?", file=sys.stderr)

# === 3. ADD MISSING MARTINGALE FIELDS to render form ===
# After the dcaMaxLayers field, the form needs dcaMaxLayers + martingale fields
# Currently dcaEnabled is at line 468 + dlcEnabled at 474 — no Martingale toggle visible.
# Insert martingale toggles between dcaEnabled and dlcEnabled sections.
old_dca_dlc = """      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-dca-enabled" ${d.dcaEnabled ? 'checked' : ''} />
          <span class="form-check-label">📚 DCA + BEP stack mode</span>
        </label>
      </div>
      <!-- FIX-2026-09-05: DLC per-bot default toggle — sits NEXT to DPS in Bot Defaults
           (was: missing → user reported \"หาใน setting bot default ไม่มีให้แก้ไขเปิดปิดเหมือนกัน\") -->"""

new_dca_dlc = """      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-dca-enabled" ${d.dcaEnabled ? 'checked' : ''} />
          <span class="form-check-label">📚 DCA + BEP stack mode</span>
        </label>
        <div class="mt-1 ms-4">
          <label class="form-label small mb-0">Max layers</label>
          <input type="number" class="form-control form-control-sm" id="bd-dca-max-layers" value="${d.dcaMaxLayers ?? 3}" step="1" min="1" max="10" style="max-width:90px;" />
        </div>
      </div>
      <!-- FIX-2026-09-09 Batch 3: Martingale per-bot defaults (was missing from form — only present in BD_RECOMMENDED) -->
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-martingale-enabled" ${d.martingaleEnabled ? 'checked' : ''} />
          <span class="form-check-label">🎲 Martingale sizing (×N)</span>
        </label>
        <div class="mt-1 ms-4">
          <label class="form-label small mb-0">Multiplier × N</label>
          <input type="number" class="form-control form-control-sm" id="bd-martingale-multiplier" value="${d.martingaleMultiplier ?? 1.5}" step="0.1" min="1.1" max="5" style="max-width:90px;" />
          <label class="form-label small mb-0 mt-1">Max layer notional (USDT)</label>
          <input type="number" class="form-control form-control-sm" id="bd-martingale-max-notional" value="${d.martingaleMaxLayerNotional ?? 100}" step="1" min="1" max="1000" style="max-width:110px;" />
          <small class="text-muted-3">Martingale ต้องเปิด DCA ก่อน (mutex enforced server-side)</small>
        </div>
      </div>
      <!-- FIX-2026-09-05: DLC per-bot default toggle — sits NEXT to DPS in Bot Defaults
           (was: missing → user reported \"หาใน setting bot default ไม่มีให้แก้ไขเปิดปิดเหมือนกัน\") -->"""

if old_dca_dlc in src:
    src = src.replace(old_dca_dlc, new_dca_dlc)
    print("  OK: added Martingale fields (enabled + multiplier + max-notional)", file=sys.stderr)
else:
    print("  NO MATCH: DCA/DLC insert point — manual fix needed", file=sys.stderr)

# === 4. GATE CBv2/CBv3 BY CB VERSION ===
# Mirror bot-edit.js pattern: fetch AppConfig.cbVersion, show only the active version
# Add cbVersion read at top of renderBotDefaultsSection + conditional render.
# Currently both cbv2-enabled (line 351) and cbv3-enabled (line 357) shown.
old_cb_both = """      <div class="col-md-4">
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
      </div>"""

# cbVersion is available as a module-level var (similar to AppConfig section).
# We use window.cbVersion or fall back to a global. bot-edit.js sets bot.cbVersion.
# For settings.js, we read from appConfig loaded earlier (autoConfig).
# Conservative: gate by a module-level var `currentCbVersion` defaulting to 'v3'.
new_cb_gated = """      ${(typeof currentCbVersion === 'undefined' || currentCbVersion === 'v2') ? `
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-cbv2-enabled" ${d.cbv2Enabled ? 'checked' : ''} />
          <span class="form-check-label">💎 CBv2 sustained panic-sell</span>
        </label>
      </div>` : ''}
      ${(typeof currentCbVersion === 'undefined' || currentCbVersion === 'v3') ? `
      <div class="col-md-4">
        <label class="form-check form-switch">
          <input type="checkbox" class="form-check-input" id="bd-cbv3-enabled" ${d.cbv3Enabled ? 'checked' : ''} />
          <span class="form-check-label">💎 CBv3 panic-sell (CBv2 + ST3)</span>
        </label>
      </div>` : ''}
      <div class="col-md-12"><small class="text-muted-3">⚙️ Active CB version: <strong>${typeof currentCbVersion !== 'undefined' ? currentCbVersion : 'v3 (default)'}</strong> · กำหนดที่ <a href="#group-cb-version">🔧 CB Version</a> section ด้านบน</small></div>"""

if old_cb_both in src:
    src = src.replace(old_cb_both, new_cb_gated)
    print("  OK: gated CBv2/CBv3 by cbVersion", file=sys.stderr)
else:
    print("  NO MATCH: CBv2/CBv3 insert — manual fix needed", file=sys.stderr)

# === 5. ADD #group-chat chip nav in Bot Defaults ===
# Add a chip after the alert at top of renderBotDefaultsSection pointing to chat display name
old_alert = """    <div class="alert alert-info small mb-3">
      <strong>📌 วิธีใช้:</strong> ตั้งค่าเริ่มต้นทุก field ที่จะใช้ตอนสร้างบอทใหม่ (POST /api/bots)
      · ค่าเหล่านี้จะถูก pre-fill ใน New Bot modal บน <a href="/bots.html">bots.html</a>
      · บอทเดิมที่มีอยู่ไม่เปลี่ยนแปลง (ต้องแก้ทีละบอทผ่าน <a href="/bot-edit.html\">bot-edit</a>)
    </div>"""

new_alert = """    <div class="alert alert-info small mb-3">
      <strong>📌 วิธีใช้:</strong> ตั้งค่าเริ่มต้นทุก field ที่จะใช้ตอนสร้างบอทใหม่ (POST /api/bots)
      · ค่าเหล่านี้จะถูก pre-fill ใน New Bot modal บน <a href="/bots.html">bots.html</a>
      · บอทเดิมที่มีอยู่ไม่เปลี่ยนแปลง (ต้องแก้ทีละบอทผ่าน <a href="/bot-edit.html\">bot-edit</a>)
      <a href="#group-chat" class="float-end badge text-bg-secondary text-decoration-none">💬 → Chat Display Name</a>
    </div>"""

if old_alert in src:
    src = src.replace(old_alert, new_alert)
    print("  OK: added #group-chat chip", file=sys.stderr)
else:
    print("  NO MATCH: alert insert — manual fix needed", file=sys.stderr)

# === 6. SYNC saveBotDefaults payload to read Martingale fields ===
# Add martingaleEnabled, martingaleMultiplier, martingaleMaxLayerNotional + dcaMaxLayers to payload
old_payload = """    dcaEnabled: isChecked('bd-dca-enabled'),
    dcaMaxLayers: int('bd-dca-max-layers'),"""

new_payload = """    dcaEnabled: isChecked('bd-dca-enabled'),
    dcaMaxLayers: int('bd-dca-max-layers'),
    martingaleEnabled: isChecked('bd-martingale-enabled'),
    martingaleMultiplier: num('bd-martingale-multiplier'),
    martingaleMaxLayerNotional: num('bd-martingale-max-notional'),"""

if old_payload in src:
    src = src.replace(old_payload, new_payload)
    print("  OK: added Martingale to saveBotDefaults payload", file=sys.stderr)
else:
    print("  NO MATCH: payload insert — manual fix needed", file=sys.stderr)

# === 7. ADD currentCbVersion wiring ===
# Find the loadConfig function and add cbVersion read
# Conservative: add to the top of renderBotDefaultsSection read

# === WRITE ===
if src != original:
    with open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f"\nFILE WRITTEN: {len(src) - len(original):+d} bytes", file=sys.stderr)
else:
    print("\nNO CHANGES", file=sys.stderr)
