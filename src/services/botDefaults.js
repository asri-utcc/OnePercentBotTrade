'use strict';

/**
 * FIX-2026-08-09: Bot Defaults — single source of truth
 *
 * Background:
 *   ก่อนหน้านี้มี 2 path สร้างบอทใหม่ที่ใช้ค่า default คนละชุดกัน:
 *     1. POST /api/bots (New Bot modal ในหน้า /bots.html)
 *        → อ่าน AppConfig.botDefaults ผ่าน pickDefault()
 *     2. autoAddBot._createBotFor (background scan)
 *        → hardcode ค่าทั้งหมดในไฟล์ ไม่สนใจ AppConfig.botDefaults เลย
 *
 *   ผลคือถ้า user ตั้งค่า default ในหน้า Settings section 1️⃣ Bot Defaults
 *   แล้วเปิด Auto Add Bot → บอทที่ถูกสร้างอัตโนมัติจะไม่ใช้ค่าที่ user ตั้ง
 *   (ตัวอย่างจริง: 1000CAT(bAdd) ถูกสร้างด้วย capital=9, kcMult=1.2, tpTrendMultiplier=2
 *    ทั้งที่ user ตั้งค่า default ไว้ต่างออกไป)
 *
 * Design:
 *   - Helper นี้รวม logic "อ่าน AppConfig.botDefaults + clamp + default" ไว้ที่เดียว
 *   - ทั้ง 2 path เรียกใช้ตัวเดียวกัน → ไม่มี drift อีก
 *   - การเพิ่ม field ใหม่ทำที่เดียว ไม่ต้องตามแก้ 2 ที่
 *
 * Precedence ต่อ field:
 *   1. overrides[key] — explicit value (จาก user form หรือ scan result)
 *   2. AppConfig.botDefaults[key] — user ตั้งใน Settings
 *   3. fallback (config.defaults หรือ schema default) — safe last-resort
 *
 * NOTE: `enabled` / `status` เป็น flow control ไม่ใช่ default — caller จัดการเอง
 *       (manual = atomic create+enable, autoAddBot = SAFETY disabled แล้วค่อย enableBot)
 */

const AppConfig = require('../db/models/AppConfig');

/**
 * Read AppConfig.botDefaults (object or empty {})
 * Safe to call multiple times — no caching (create ไม่บ่อย + ต้องการ fresh value)
 */
async function getBotDefaults() {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (cfg && cfg.botDefaults) return cfg.botDefaults;
  } catch (_) { /* ignore — fallback to empty */ }
  return {};
}

/**
 * Sync version of getBotDefaults — ใช้ตอน caller มี doc อยู่แล้ว (เช่น test)
 */
function getBotDefaultsFromDoc(cfg) {
  if (cfg && cfg.botDefaults) return cfg.botDefaults;
  return {};
}

/**
 * Pick a value with precedence: overrides → botDefaults → fallback
 * Returns undefined if all three are missing (caller can decide what to do).
 */
function pickValue(overrides, botDefaults, key, fallback) {
  if (overrides && overrides[key] !== undefined) return overrides[key];
  if (botDefaults && botDefaults[key] !== undefined) return botDefaults[key];
  return fallback;
}

/**
 * Resolve a boolean field.
 * Booleans ต้องระวัง: explicit `false` ต้องผ่าน (ไม่ใช่ undefined)
 * ดังนั้น check `key !== undefined` แทนการพึ่ง truthiness
 *
 * มี 2 mode ตาม default ของ field:
 *
 *   Lenient (default true — "ON by default" fields เช่น xs1Enabled, cbEnabled, tpTrendEnabled)
 *     → o.x = false → false (explicit off)
 *     → o.x = undefined, b.x = true → true
 *     → o.x = undefined, b.x = false → false
 *     → o.x = "1" / 1 / null → true (lenient — anything not strictly false = on)
 *
 *   Strict (default false — "OFF by default" fields เช่น s1OnlyDown, dcaEnabled, autoUpdateTp)
 *     → o.x = true → true (explicit on)
 *     → o.x = undefined, b.x = true → true
 *     → o.x = undefined, b.x = false → false
 *     → o.x = "1" / 1 / null → false (strict — must be === true to turn on)
 *
 * ใช้ตาม default ของแต่ละ field (ดู buildBotCreatePayload)
 */
function pickBool(overrides, botDefaults, key, fallback, { strict = false } = {}) {
  if (overrides && overrides[key] !== undefined) {
    return strict ? (overrides[key] === true) : (overrides[key] !== false);
  }
  if (botDefaults && botDefaults[key] !== undefined) {
    return strict ? (botDefaults[key] === true) : (botDefaults[key] !== false);
  }
  return fallback;
}

/**
 * Resolve a numeric/integer field with optional clamp.
 *
 *   pickScalar(o, b, 'kcMult', 1.5, { clamp: [0.5, 5] })
 *     → o.kcMult = 10 → clamp → 5
 *     → o.kcMult = undefined, b.kcMult = 1.2 → 1.2
 *     → undefined ทั้งคู่ → 1.5 (fallback)
 *
 * Behavior:
 *   - ถ้า key present ในระดับใดระดับหนึ่ง → ใช้ค่านั้น (match `??` semantics: null/undefined treated เหมือนกัน)
 *   - null จาก caller → ใช้ค่านั้น (parseFloat(null) = NaN) — caller ควรหลีกเลี่ยงการส่ง null
 *   - ถ้า fallback เป็น null → return null (ไม่ parse)
 *   - ถ้า clamp ให้มา → apply หลัง parse (parseFloat ก่อน clamp)
 */
function pickScalar(overrides, botDefaults, key, fallback, { clamp, int = false } = {}) {
  let v;
  if (overrides && overrides[key] != null) v = overrides[key];
  else if (botDefaults && botDefaults[key] != null) v = botDefaults[key];
  else v = fallback;
  if (v == null) return v;
  if (clamp) {
    const [lo, hi] = clamp;
    if (int) v = Math.min(hi, Math.max(lo, parseInt(v, 10)));
    else v = Math.min(hi, Math.max(lo, parseFloat(v)));
  } else {
    if (int) v = parseInt(v, 10);
    else v = parseFloat(v);
  }
  return v;
}

/**
 * Resolve a plain int (no clamp). parseInt with default fallback.
 */
function pickInt(overrides, botDefaults, key, fallback) {
  return pickScalar(overrides, botDefaults, key, fallback, { int: true });
}

/**
 * Build the complete Bot.create payload.
 * ทั้ง manual POST และ autoAddBot เรียก function นี้ตัวเดียวกัน
 *
 * @param {Object} opts
 * @param {Object} opts.overrides   - explicit field values (req.body for manual, scan result for auto)
 * @param {Object} opts.botDefaults - AppConfig.botDefaults (already loaded)
 * @param {Object} opts.fallbacks   - hardcoded safe defaults (config.defaults + schema defaults)
 * @returns {Object} payload for Bot.create
 */
function buildBotCreatePayload({ overrides = {}, botDefaults = {}, fallbacks = {} } = {}) {
  // Normalize overrides — caller อาจส่ง `data` ที่ field ไม่ครบ (เช่น POST ส่ง symbol แต่ไม่ส่ง kcMult)
  const o = overrides || {};
  const b = botDefaults || {};
  const f = fallbacks || {};

  const symbol = (o.symbol || b.defaultSymbol || f.symbol || '').toString().toUpperCase();
  const timeframe = o.timeframe || b.defaultTimeframe || f.timeframe || '5m';

  return {
    // ── Identity ──
    name: o.name || `${symbol} ${timeframe}`.trim(),
    symbol,
    timeframe,

    // ── Position sizing ──
    capitalPerTrade: pickScalar(o, b, 'capitalPerTrade', f.capitalPerTrade ?? 9),
    maxTrades: pickInt(o, b, 'maxTrades', f.maxTrades ?? 1),
    tpPercent: pickScalar(o, b, 'tpPercent', f.tpPercent ?? 0.1),

    // ── DCA + Martingale ──
    dcaEnabled: pickBool(o, b, 'dcaEnabled', false, { strict: true }),
    dcaMaxLayers: pickScalar(o, b, 'dcaMaxLayers', 3, { clamp: [1, 100], int: true }),
    martingaleEnabled: pickBool(o, b, 'martingaleEnabled', false, { strict: true }),
    martingaleMultiplier: pickScalar(o, b, 'martingaleMultiplier', 1.5, { clamp: [1, 3] }),
    martingaleMaxLayerNotional: pickScalar(o, b, 'martingaleMaxLayerNotional', 100, { clamp: [1, 10000] }),

    // ── Retry + signal config ──
    retryTimeMin: pickScalar(o, b, 'retryTimeMin', f.retryTimeMin ?? 0.2, { clamp: [0.1, 60] }),
    retryMax: pickInt(o, b, 'retryMax', f.retryMax ?? 8),
    kcMult: pickScalar(o, b, 'kcMult', 1.5, { clamp: [0.5, 5] }),
    minSpreadTicks: pickScalar(o, b, 'minSpreadTicks', 1, { clamp: [0, 10], int: true }),
    suggestTpWindow: pickScalar(o, b, 'suggestTpWindow', 500, { clamp: [30, 1000], int: true }),

    // ── S1 / XS1 ──
    s1OnlyDown: pickBool(o, b, 's1OnlyDown', false, { strict: true }),
    xs1Enabled: pickBool(o, b, 'xs1Enabled', true),

    // ── Circuit Breaker ──
    cbEnabled: pickBool(o, b, 'cbEnabled', true),
    cbv2Enabled: pickBool(o, b, 'cbv2Enabled', true),
    cbv2LockHours: pickScalar(o, b, 'cbv2LockHours', 8, { clamp: [0.5, 168] }),
    cbv3Enabled: pickBool(o, b, 'cbv3Enabled', true),
    cbv3LockHours: pickScalar(o, b, 'cbv3LockHours', 8, { clamp: [0.5, 168] }),
    // FIX-2026-08-10: CBv5 (Support Zone Circuit Breaker) — independent of cbVersion
    cbv5Enabled: pickBool(o, b, 'cbv5Enabled', true),
    cbv5LockHours: pickScalar(o, b, 'cbv5LockHours', 4, { clamp: [0.5, 168] }),
    cbv5KcLen: pickScalar(o, b, 'cbv5KcLen', 20, { clamp: [5, 100], int: true }),
    cbv5KcMult: pickScalar(o, b, 'cbv5KcMult', 1.2, { clamp: [0.5, 5.0] }),
    cbv5PivotLookback: pickScalar(o, b, 'cbv5PivotLookback', 3, { clamp: [2, 10], int: true }),
    cbv5PivotLeftLen: pickScalar(o, b, 'cbv5PivotLeftLen', 5, { clamp: [2, 50], int: true }),
    cbv5PivotRightLen: pickScalar(o, b, 'cbv5PivotRightLen', 5, { clamp: [2, 50], int: true }),
    cbv5StrictBreak: pickBool(o, b, 'cbv5StrictBreak', true),
    cbv5UseVolume: pickBool(o, b, 'cbv5UseVolume', true),
    cbv5VolMaLen: pickScalar(o, b, 'cbv5VolMaLen', 20, { clamp: [5, 100], int: true }),
    cbv5VolMultiplier: pickScalar(o, b, 'cbv5VolMultiplier', 1.5, { clamp: [1.0, 10.0] }),
    cbv5DebounceCandles: pickScalar(o, b, 'cbv5DebounceCandles', 5, { clamp: [1, 20], int: true }),

    // ── Safe-trade filters ──
    safeTradeEnabled: pickBool(o, b, 'safeTradeEnabled', true),
    safeTradeTrendlineEnabled: pickBool(o, b, 'safeTradeTrendlineEnabled', false, { strict: true }),
    safeTradeNoTradeEnabled: pickBool(o, b, 'safeTradeNoTradeEnabled', false, { strict: true }),

    // ── Auto-pause on low volatility ──
    autoPauseEnabled: pickBool(o, b, 'autoPauseEnabled', true),
    autoPauseMinKcPct: pickScalar(o, b, 'autoPauseMinKcPct', 2, { clamp: [0.1, 50] }),
    // FIX-2026-08-10: 24h volume guard (paired with autoPauseMinKcPct)
    autoPauseMin24hVolUsdt: pickScalar(o, b, 'autoPauseMin24hVolUsdt', 1_000_000, { clamp: [0, 1_000_000_000] }),

    // ── Auto-arm SL-UKC (F1) ──
    autoArmStopLossOnUKC: pickBool(o, b, 'autoArmStopLossOnUKC', true),
    autoArmLossPct: pickScalar(o, b, 'autoArmLossPct', 10, { clamp: [1, 90] }),
    autoArmAgeHours: pickScalar(o, b, 'autoArmAgeHours', 4, { clamp: [0.5, 168] }),
    slUkcTriggerOnProfit: pickBool(o, b, 'slUkcTriggerOnProfit', false, { strict: true }),

    // ── TP trend ×N (F2) ──
    tpTrendEnabled: pickBool(o, b, 'tpTrendEnabled', true),
    tpTrendMultiplier: pickScalar(o, b, 'tpTrendMultiplier', 2, { clamp: [1, 10] }),

    // ── Other toggles ──
    stopLossOnUpperKC: pickBool(o, b, 'stopLossOnUpperKC', false, { strict: true }),
    autoUpdateTp: pickBool(o, b, 'autoUpdateTp', false, { strict: true }),

    // ── Dynamic Position Sizing ──
    dynamicSizeEnabled: pickBool(o, b, 'dynamicSizeEnabled', true),

    // ── Auto Unlock Cooldown ──
    cbAutoUnlockEnabled: pickBool(o, b, 'cbAutoUnlockEnabled', false, { strict: true }),
    cbAutoUnlockThresholdPct: pickScalar(o, b, 'cbAutoUnlockThresholdPct', 1.0, { clamp: [0.5, 5.0] }),
  };
}

module.exports = {
  getBotDefaults,
  getBotDefaultsFromDoc,
  pickValue,
  pickBool,
  pickScalar,
  pickInt,
  buildBotCreatePayload,
};
