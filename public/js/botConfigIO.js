'use strict';

/**
 * FIX-2026-08-14: Bot Config Import/Export — browser-side wrapper
 *
 * Wraps the pure helpers from src/services/botConfigIO.js with DOM-aware
 * counterparts (FileReader, Blob, URL.createObjectURL, per-surface dispatch).
 *
 * The constant arrays (ALLOWED_FIELD_KEYS / NUMBER_FIELDS / BOOLEAN_FIELDS /
 * STRING_FIELDS) are DUPLICATED here intentionally — there's no build step and
 * the browser can't `require()` Node modules. They MUST stay in sync with
 * src/services/botConfigIO.js (covered by tests/botConfigIO.test.js).
 *
 * Attaches to window.botConfigIO.
 */

(function () {
  const SCHEMA_VERSION = 1;
  const MAX_FILE_BYTES = 1_048_576; // 1 MiB
  const ALLOWED_IMPORT_TYPES = ['bot', 'master-template', 'bot-defaults'];

  // ── Field type registry (MIRROR of src/services/botConfigIO.js) ──
  // Keep in sync! The 4 lists below MUST equal the backend constants.
  const NUMBER_FIELDS = new Set([
    'capitalPerTrade', 'maxTrades', 'tpPercent', 'retryTimeMin', 'retryMax',
    'kcMult', 'minSpreadTicks', 'suggestTpWindow',
    'dcaMaxLayers', 'martingaleMultiplier', 'martingaleMaxLayerNotional',
    'cbv2LockHours', 'cbv3LockHours', 'cbv5LockHours',
    'cbv5KcLen', 'cbv5KcMult', 'cbv5PivotLookback', 'cbv5PivotLeftLen', 'cbv5PivotRightLen',
    'cbv5VolMaLen', 'cbv5VolMultiplier', 'cbv5DebounceCandles',
    'cbAutoUnlockThresholdPct',
    'autoPauseMinKcPct', 'autoPauseMin24hVolUsdt',
    'autoArmLossPct', 'autoArmAgeHours',
    'tpTrendMultiplier',
  ]);

  const BOOLEAN_FIELDS = new Set([
    'dcaEnabled', 'martingaleEnabled',
    's1OnlyDown', 'xs1Enabled',
    'cbEnabled', 'cbv2Enabled', 'cbv3Enabled', 'cbv5Enabled',
    'cbv5StrictBreak', 'cbv5UseVolume',
    'cbAutoUnlockEnabled',
    'dynamicSizeEnabled',
    'safeTradeEnabled', 'safeTradeTrendlineEnabled', 'safeTradeNoTradeEnabled',
    'autoPauseEnabled',
    // FIX-2026-08-29: auto-pause threshold auto-adjust per-bot opt-in (mirror src/services/botConfigIO.js)
    'autoPauseAdjustEnabled',
    'autoArmStopLossOnUKC', 'slUkcTriggerOnProfit',
    // FIX-2026-08-30: Auto-Timing (Phase 4) per-bot tristate (null|true|false = inherit/force-on/force-off)
    'autoTimingEnabled',
    'tpTrendEnabled', 'autoUpdateTp', 'stopLossOnUpperKC',
  ]);

  const STRING_FIELDS = new Set([
    'defaultSymbol', 'defaultTimeframe', 'timeframe',
  ]);

  // 52 keys: 50 from masterConfigTemplates.ALLOWED_TEMPLATE_FIELDS + 2 new (defaultSymbol + defaultTimeframe)
  const ALLOWED_FIELD_KEYS = [
    'capitalPerTrade', 'maxTrades', 'tpPercent', 'retryTimeMin', 'retryMax',
    'timeframe', 'stopLossOnUpperKC', 'autoUpdateTp', 'kcMult', 'minSpreadTicks',
    's1OnlyDown', 'xs1Enabled', 'cbEnabled', 'cbv2Enabled', 'cbv2LockHours', 'safeTradeEnabled',
    'safeTradeTrendlineEnabled', 'safeTradeNoTradeEnabled',
    'autoPauseEnabled', 'autoPauseMinKcPct', 'autoPauseMin24hVolUsdt',
    'suggestTpWindow', 'autoArmStopLossOnUKC', 'autoArmLossPct', 'autoArmAgeHours', 'slUkcTriggerOnProfit',
    'tpTrendMultiplier', 'tpTrendEnabled',
    'dcaEnabled', 'dcaMaxLayers',
    'martingaleEnabled', 'martingaleMultiplier', 'martingaleMaxLayerNotional',
    'dynamicSizeEnabled', 'cbAutoUnlockEnabled', 'cbAutoUnlockThresholdPct',
    'cbv3Enabled', 'cbv3LockHours',
    'cbv5Enabled', 'cbv5LockHours',
    'cbv5KcLen', 'cbv5KcMult',
    'cbv5PivotLookback', 'cbv5PivotLeftLen', 'cbv5PivotRightLen',
    'cbv5StrictBreak', 'cbv5UseVolume',
    'cbv5VolMaLen', 'cbv5VolMultiplier', 'cbv5DebounceCandles',
    'defaultSymbol', 'defaultTimeframe',
  ];

  // ──────────────────────────────────────────────────────────────────────────
  // Per-surface selector tables
  // ──────────────────────────────────────────────────────────────────────────
  // Each surface has its own DOM convention. The dispatcher uses these tables
  // to find the right element for a given key.
  //
  // "kind" values:
  //   - "mc-tristate":  Master Config — tri-state radios (.mc-toggle-mode[data-key])
  //                     numbers live in .mc-field[data-key]
  //   - "id-prefix":    bot-edit / new-bot / bot-defaults — id-based selectors

  const SURFACE_SELECTORS = {
    'master-config': {
      kind: 'mc-tristate',
      numericSelector: (k) => `.mc-field[data-key="${k}"]`,
      // Tri-state radios: 3 radios per key, values "" / "true" / "false"
      booleanSelector: (k) => `.mc-toggle-mode[data-key="${k}"]`,
      clearNumeric: (k) => document.querySelectorAll(`.mc-field[data-key="${k}"]`).forEach((el) => { el.value = ''; }),
      clearBoolean: (k) => {
        const radio = document.querySelector(`.mc-toggle-mode[data-key="${k}"][value=""]`);
        if (radio) radio.checked = true;
      },
    },
    'bot-edit': {
      kind: 'id-prefix',
      prefix: 'f-',
      // Special ID remaps (kebab-case collisions / non-standard keys)
      idRemap: {},
    },
    'new-bot': {
      kind: 'id-prefix',
      prefix: 'nb-',
      idRemap: {},
    },
    'bot-defaults': {
      kind: 'id-prefix',
      prefix: 'bd-',
      // Bot Defaults uses different IDs for defaultSymbol + defaultTimeframe
      idRemap: {
        defaultSymbol: 'bd-symbol',
        defaultTimeframe: 'bd-tf',
      },
    },
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Utility helpers
  // ──────────────────────────────────────────────────────────────────────────

  function kebab(camelKey) {
    return String(camelKey).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  }

  function isTruthyValue(v) {
    return v === true || v === 'true' || v === 1 || v === '1';
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Pure helpers (mirror of backend)
  // ──────────────────────────────────────────────────────────────────────────

  function buildExportPayload(opts) {
    const {
      type, name, source, settings,
      botSymbol = null, botTimeframe = null, cbVersion = null,
    } = opts || {};
    const cleanSettings = (settings && typeof settings === 'object' && !Array.isArray(settings))
      ? settings : {};

    const meta = {
      source: source || 'unknown',
      fieldCount: Object.keys(cleanSettings).length,
    };
    if (botSymbol) meta.botSymbol = botSymbol;
    if (botTimeframe) meta.botTimeframe = botTimeframe;
    if (cbVersion) meta.cbVersion = cbVersion;

    return {
      schemaVersion: SCHEMA_VERSION,
      type: type || 'master-template',
      exportedAt: new Date().toISOString(),
      name: name || 'Unnamed',
      meta,
      settings: cleanSettings,
    };
  }

  function sanitizeImportSettings(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { settings: {}, dropped: 0 };
    }
    const out = {};
    let dropped = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (!ALLOWED_FIELD_KEYS.includes(k)) { dropped += 1; continue; }
      if (NUMBER_FIELDS.has(k)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(parseFloat(v))) out[k] = parseFloat(v);
        else dropped += 1;
        continue;
      }
      if (BOOLEAN_FIELDS.has(k)) {
        // FIX-2026-08-30: tristate fields (autoTimingEnabled) preserve null as 'inherit'
        if (k === 'autoTimingEnabled' && v === null) { out[k] = null; continue; }
        if (typeof v === 'boolean') out[k] = v;
        else if (v === 'true' || v === '1' || v === 1) out[k] = true;
        else if (v === 'false' || v === '0' || v === 0) out[k] = false;
        else out[k] = v === true;
        continue;
      }
      if (STRING_FIELDS.has(k)) {
        out[k] = (v === null) ? null : (typeof v === 'string' ? v : String(v));
        continue;
      }
      out[k] = v;
    }
    return { settings: out, dropped };
  }

  function checkMutuallyExclusive(settings) {
    if (!settings || typeof settings !== 'object') return [];
    const warnings = [];
    if (settings.martingaleEnabled === true && settings.dcaEnabled === false) {
      warnings.push('Martingale requires DCA mode');
    }
    if (
      settings.dynamicSizeEnabled === true
      && (settings.dcaEnabled === true || settings.martingaleEnabled === true)
    ) {
      warnings.push('DPS (Dynamic Position Sizing) is mutually exclusive with DCA/Martingale');
    }
    if (settings.cbEnabled === false && settings.cbAutoUnlockEnabled === true) {
      warnings.push('CB Auto-Unlock requires CB enabled');
    }
    return warnings;
  }

  function validateImportPayload(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Invalid payload: not an object' };
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      return {
        ok: false,
        error: `Unsupported schemaVersion: ${parsed.schemaVersion} (this app expects ${SCHEMA_VERSION})`,
      };
    }
    if (!ALLOWED_IMPORT_TYPES.includes(parsed.type)) {
      return {
        ok: false,
        error: `Unknown type: ${parsed.type} (allowed: ${ALLOWED_IMPORT_TYPES.join(', ')})`,
      };
    }
    if (!parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings)) {
      return { ok: false, error: 'Missing or invalid settings object' };
    }
    return { ok: true, payload: parsed, warnings: checkMutuallyExclusive(parsed.settings) };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Browser-only helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * parseImportFile(file) → Promise<{ ok, payload, error, warnings, sanitizeResult }>
   *
   * Reads file via FileReader, validates schema, sanitizes settings.
   */
  function parseImportFile(file) {
    return new Promise((resolve) => {
      if (!file) {
        resolve({ ok: false, error: 'No file provided' });
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        resolve({ ok: false, error: `File too large: ${file.size} bytes (max ${MAX_FILE_BYTES})` });
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = String(e.target.result || '');
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          resolve({ ok: false, error: `Invalid JSON: ${err.message}` });
          return;
        }
        const v = validateImportPayload(parsed);
        if (!v.ok) {
          resolve({ ok: false, error: v.error });
          return;
        }
        const sanitizeResult = sanitizeImportSettings(v.payload.settings);
        resolve({
          ok: true,
          payload: v.payload,
          warnings: v.warnings,
          sanitizeResult,
        });
      };
      reader.onerror = () => {
        resolve({ ok: false, error: `FileReader error: ${reader.error?.message || 'unknown'}` });
      };
      reader.readAsText(file);
    });
  }

  /**
   * applyToForm(settings, surface, opts) → { applied, skipped[] }
   *
   * surface: 'master-config' | 'bot-edit' | 'new-bot' | 'bot-defaults'
   * opts:
   *   - mode: 'replace' (default) | 'merge'
   *   - skipKey: optional field name to never touch (e.g. 'symbol' on bot-edit)
   */
  function applyToForm(settings, surface, opts = {}) {
    const surfaceCfg = SURFACE_SELECTORS[surface];
    if (!surfaceCfg) {
      return { applied: 0, skipped: [`unknown surface: ${surface}`] };
    }
    const mode = opts.mode || 'replace';
    const skipKey = opts.skipKey || null;

    if (mode === 'replace') {
      // Clear all whitelisted fields first (skipKey omitted)
      for (const k of ALLOWED_FIELD_KEYS) {
        if (k === skipKey) continue;
        clearField(surfaceCfg, k);
      }
    }

    let applied = 0;
    const skipped = [];

    for (const [k, v] of Object.entries(settings || {})) {
      if (!ALLOWED_FIELD_KEYS.includes(k)) {
        skipped.push(`unknown:${k}`);
        continue;
      }
      if (k === skipKey) {
        skipped.push(`skipped:${k}`);
        continue;
      }
      const ok = setField(surfaceCfg, k, v);
      if (ok) applied += 1;
      else skipped.push(`missing:${k}`);
    }

    return { applied, skipped };
  }

  // Clear one field (per-surface dispatch). Internal helper for applyToForm replace-mode.
  function clearField(surfaceCfg, key) {
    if (surfaceCfg.kind === 'mc-tristate') {
      const numericEl = document.querySelector(surfaceCfg.numericSelector(key));
      if (numericEl) { numericEl.value = ''; return; }
      const radios = document.querySelectorAll(surfaceCfg.booleanSelector(key));
      if (radios.length) {
        const blankRadio = document.querySelector(surfaceCfg.booleanSelector(key) + '[value=""]');
        if (blankRadio) blankRadio.checked = true;
        return;
      }
      return;
    }
    if (surfaceCfg.kind === 'id-prefix') {
      const el = findIdPrefixElement(surfaceCfg, key);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = false;
      else el.value = '';
      return;
    }
  }

  // Set one field to a value (per-surface dispatch). Returns true if element found.
  function setField(surfaceCfg, key, value) {
    if (surfaceCfg.kind === 'mc-tristate') {
      // Numbers + strings → .mc-field[data-key]
      if (NUMBER_FIELDS.has(key) || STRING_FIELDS.has(key)) {
        const el = document.querySelector(surfaceCfg.numericSelector(key));
        if (!el) return false;
        el.value = (value === null || value === undefined) ? '' : String(value);
        // Trigger 'change' event so any on-change listeners fire (e.g. live previews)
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      // Booleans → tri-state radios
      if (BOOLEAN_FIELDS.has(key)) {
        const radios = document.querySelectorAll(surfaceCfg.booleanSelector(key));
        if (!radios.length) return false;
        const targetValue = value === true ? 'true' : value === false ? 'false' : '';
        const target = [...radios].find((r) => r.value === targetValue);
        if (!target) return false;
        target.checked = true;
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    }
    if (surfaceCfg.kind === 'id-prefix') {
      const el = findIdPrefixElement(surfaceCfg, key);
      if (!el) return false;
      if (el.type === 'checkbox') {
        el.checked = isTruthyValue(value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.tagName === 'SELECT') {
        el.value = (value === null || value === undefined) ? '' : String(value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.value = (value === null || value === undefined) ? '' : String(value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }
    return false;
  }

  function findIdPrefixElement(surfaceCfg, key) {
    const remapId = surfaceCfg.idRemap && surfaceCfg.idRemap[key];
    if (remapId) return document.getElementById(remapId);
    return document.getElementById(surfaceCfg.prefix + kebab(key));
  }

  /**
   * triggerDownload(filename, payload)
   * payload: object → JSON.stringify → Blob → click hidden <a download>
   */
  function triggerDownload(filename, payload) {
    const text = JSON.stringify(payload, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  /**
   * buildExportFilename(type, name?) → string
   * onepct-{type}-{slug}-{YYYYMMDD-HHmmss}.json
   */
  function buildExportFilename(type, name) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    let slug = 'unnamed';
    if (typeof name === 'string' && name.trim()) {
      slug = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 30);
      if (!slug) slug = 'unnamed';
    }
    return `onepct-${type}-${slug}-${stamp}.json`;
  }

  /**
   * Prompt the user to pick a file via hidden <input type="file">.
   * Returns Promise<File | null>.
   */
  function pickJsonFile(accept = 'application/json,.json') {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.style.display = 'none';
      input.onchange = () => {
        const file = input.files && input.files[0];
        document.body.removeChild(input);
        resolve(file || null);
      };
      // Cancel = null
      input.addEventListener('cancel', () => {
        document.body.removeChild(input);
        resolve(null);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Export
  // ──────────────────────────────────────────────────────────────────────────
  window.botConfigIO = {
    // Constants
    SCHEMA_VERSION,
    MAX_FILE_BYTES,
    ALLOWED_IMPORT_TYPES,
    ALLOWED_FIELD_KEYS,
    NUMBER_FIELDS,
    BOOLEAN_FIELDS,
    STRING_FIELDS,

    // Pure helpers (mirror backend; tests in tests/botConfigIO.test.js)
    buildExportPayload,
    sanitizeImportSettings,
    checkMutuallyExclusive,
    validateImportPayload,

    // Browser helpers
    parseImportFile,
    applyToForm,
    triggerDownload,
    pickJsonFile,
    buildExportFilename,
    kebab,
  };
})();
