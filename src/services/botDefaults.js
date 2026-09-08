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
 *   3. RECOMMENDED_DEFAULTS — single canonical recommendation (this file)
 *   4. fallback (config.defaults หรือ schema default) — safe last-resort
 *
 * NOTE: `enabled` / `status` เป็น flow control ไม่ใช่ default — caller จัดการเอง
 *       (manual = atomic create+enable, autoAddBot = SAFETY disabled แล้วค่อย enableBot)
 */

const AppConfig = require('../db/models/AppConfig');
const { mergeTierWithDefaults } = require('./tierTemplates'); // FIX-2026-08-27 Phase 3b-1

/**
 * FIX-2026-09-09: RECOMMENDED_DEFAULTS — single canonical recommendation.
 *   Used as the fallback for every key in buildBotCreatePayload so that:
 *     - All 4 UI surfaces (Settings Bot Defaults / Master Config / bot-edit / New Bot)
 *       share the exact same recommended values.
 *     - Frontend can `require` this constant via the botConfigIO export (or via
 *       GET /api/admin/bot-defaults/recommended) to pre-fill empty forms.
 *     - Tests can pin a known-good baseline.
 *
 *   Strategy: classic single-position + DLC layer-gating + cut-loss fast.
 *     - AUv2 cuts ≤22 THB when age ≥ 5.3 days (128 hours)
 *     - F1 (autoArm SL-UKC) cuts when age ≥ 34.5 days (828 hours) — AUv2 fires first
 *     - No safe-trade filters (more signals pass; user decides via auto-pause)
 *     - No CB panic-sell (cbEnabled=false); cbAutoUnlockEnabled=true for fast recovery
 *     - Round-down capital ON (8 USDT/trade is small enough to be flexible)
 */
const RECOMMENDED_DEFAULTS = Object.freeze({
  // Identity
  defaultSymbol: 'BNBUSDT',
  defaultTimeframe: '3m',

  // Position sizing
  capitalPerTrade: 8,
  maxTrades: 1,
  tpPercent: 0.1,

  // Round-down Capital
  roundDownCapitalEnabled: true,
  roundDownCapitalMin: 5.5,

  // Entry / signal config
  retryTimeMin: 0.2,
  retryMax: 8,
  kcMult: 1.2,
  minSpreadTicks: 1,
  s1OnlyDown: false,
  xs1Enabled: false,
  suggestTpWindow: 30,

  // TP
  autoUpdateTp: true,
  tpTrendEnabled: true,
  tpTrendMultiplier: 2,

  // Auto-pause
  autoPauseEnabled: true,
  autoPauseMinKcPct: 1.2,
  autoPauseMin24hVolUsdt: 400000,
  autoPauseAdjustEnabled: true,

  // Dynamic Position Sizing
  dynamicSizeEnabled: true,

  // DLC (Dynamic Layer Control) — recommended ON since DCA/Martingale are OFF
  dlcEnabled: true,
  dlcBaseLossPct: -10,

  // DCA + Martingale — recommended OFF (incompatible with DLC; opt-in)
  dcaEnabled: false,
  dcaMaxLayers: 3,
  martingaleEnabled: false,
  martingaleMultiplier: 1.5,
  martingaleMaxLayerNotional: 100,

  // Auto-Timing — recommended OFF (no heatmap gating)
  autoTimingEnabled: false,

  // Risk / SL-UKC / F1
  stopLossOnUpperKC: false,
  autoArmStopLossOnUKC: true,
  autoArmLossPct: 10,
  autoArmAgeHours: 828,
  slUkcTriggerOnProfit: true,

  // AUv2 — F1 v2 (shallow-loss exit) — recommended ON with thb mode
  auv2Enabled: true,
  auv2MinAgeHours: 128,
  auv2LossMode: 'thb',
  auv2MaxLossPct: 8,
  auv2MaxLossThb: 22,
  auv2MaxWaitDays: 0,

  // Circuit Breaker
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

  // CB Auto-Unlock
  cbAutoUnlockEnabled: true,
  cbAutoUnlockThresholdPct: 2,

  // Safe Trade filters — recommended OFF (more signals pass)
  safeTradeEnabled: false,
  safeTradeTrendlineEnabled: false,
  safeTradeNoTradeEnabled: false,
});

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
 * @param {String|null} opts.tier   - License tier key (admin-defined via TierTemplate); unknown = no preset
 * @returns {Object} payload for Bot.create
 *
 * Precedence per field (strongest first):
 *   1. overrides (user explicit / scan result)
 *   2. tierPreset (admin-set tier wins over user-global)  ← FIX-2026-08-27 Phase 3b-1
 *   3. botDefaults (Settings section 1️⃣)
 *   4. fallback (config.defaults)
 */
function buildBotCreatePayload({ overrides = {}, botDefaults = {}, fallbacks = {}, tier = null } = {}) {
  // Normalize overrides — caller อาจส่ง `data` ที่ field ไม่ครบ (เช่น POST ส่ง symbol แต่ไม่ส่ง kcMult)
  const o = overrides || {};
  // Merge tier preset ON TOP of botDefaults — tier wins over user-global settings
  // (rationale: tier is what admin set; user-global is fallback when tier doesn't specify)
  const b = mergeTierWithDefaults(botDefaults, tier);
  const f = fallbacks || {};

  // FIX-2026-09-09: short alias for the canonical recommendation.
  const R = RECOMMENDED_DEFAULTS;

  const symbol = (o.symbol || b.defaultSymbol || f.symbol || R.defaultSymbol || '').toString().toUpperCase();
  const timeframe = o.timeframe || b.defaultTimeframe || f.timeframe || R.defaultTimeframe;

  // Helper: pull a recommended default for a given key
  const rec = (key) => R[key];

  return {
    // ── Identity ──
    name: o.name || `${symbol} ${timeframe}`.trim(),
    symbol,
    timeframe,

    // ── Position sizing ──
    capitalPerTrade: pickScalar(o, b, 'capitalPerTrade', f.capitalPerTrade ?? rec('capitalPerTrade')),
    maxTrades: pickInt(o, b, 'maxTrades', f.maxTrades ?? rec('maxTrades')),
    tpPercent: pickScalar(o, b, 'tpPercent', f.tpPercent ?? rec('tpPercent')),

    // ── DCA + Martingale (recommend OFF; opt-in) ──
    dcaEnabled: pickBool(o, b, 'dcaEnabled', rec('dcaEnabled'), { strict: true }),
    dcaMaxLayers: pickScalar(o, b, 'dcaMaxLayers', rec('dcaMaxLayers'), { clamp: [1, 100], int: true }),
    martingaleEnabled: pickBool(o, b, 'martingaleEnabled', rec('martingaleEnabled'), { strict: true }),
    martingaleMultiplier: pickScalar(o, b, 'martingaleMultiplier', rec('martingaleMultiplier'), { clamp: [1, 3] }),
    martingaleMaxLayerNotional: pickScalar(o, b, 'martingaleMaxLayerNotional', rec('martingaleMaxLayerNotional'), { clamp: [1, 10000] }),

    // ── Retry + signal config ──
    retryTimeMin: pickScalar(o, b, 'retryTimeMin', f.retryTimeMin ?? rec('retryTimeMin'), { clamp: [0.1, 60] }),
    retryMax: pickInt(o, b, 'retryMax', f.retryMax ?? rec('retryMax')),
    kcMult: pickScalar(o, b, 'kcMult', rec('kcMult'), { clamp: [0.5, 5] }),
    minSpreadTicks: pickScalar(o, b, 'minSpreadTicks', rec('minSpreadTicks'), { clamp: [0, 10], int: true }),
    suggestTpWindow: pickScalar(o, b, 'suggestTpWindow', rec('suggestTpWindow'), { clamp: [30, 1000], int: true }),

    // ── S1 / XS1 ──
    s1OnlyDown: pickBool(o, b, 's1OnlyDown', rec('s1OnlyDown'), { strict: true }),
    xs1Enabled: pickBool(o, b, 'xs1Enabled', rec('xs1Enabled')),

    // ── Circuit Breaker ──
    cbEnabled: pickBool(o, b, 'cbEnabled', rec('cbEnabled')),
    cbv2Enabled: pickBool(o, b, 'cbv2Enabled', rec('cbv2Enabled'), { strict: true }),
    cbv2LockHours: pickScalar(o, b, 'cbv2LockHours', rec('cbv2LockHours'), { clamp: [0.5, 168] }),
    cbv3Enabled: pickBool(o, b, 'cbv3Enabled', rec('cbv3Enabled'), { strict: true }),
    cbv3LockHours: pickScalar(o, b, 'cbv3LockHours', rec('cbv3LockHours'), { clamp: [0.5, 168] }),
    cbv5Enabled: pickBool(o, b, 'cbv5Enabled', rec('cbv5Enabled'), { strict: true }),
    cbv5LockHours: pickScalar(o, b, 'cbv5LockHours', rec('cbv5LockHours'), { clamp: [0.5, 168] }),
    cbv5KcLen: pickScalar(o, b, 'cbv5KcLen', rec('cbv5KcLen'), { clamp: [5, 100], int: true }),
    cbv5KcMult: pickScalar(o, b, 'cbv5KcMult', rec('cbv5KcMult'), { clamp: [0.5, 5.0] }),
    cbv5PivotLookback: pickScalar(o, b, 'cbv5PivotLookback', rec('cbv5PivotLookback'), { clamp: [2, 10], int: true }),
    cbv5PivotLeftLen: pickScalar(o, b, 'cbv5PivotLeftLen', rec('cbv5PivotLeftLen'), { clamp: [2, 50], int: true }),
    cbv5PivotRightLen: pickScalar(o, b, 'cbv5PivotRightLen', rec('cbv5PivotRightLen'), { clamp: [2, 50], int: true }),
    cbv5StrictBreak: pickBool(o, b, 'cbv5StrictBreak', rec('cbv5StrictBreak')),
    cbv5UseVolume: pickBool(o, b, 'cbv5UseVolume', rec('cbv5UseVolume')),
    cbv5VolMaLen: pickScalar(o, b, 'cbv5VolMaLen', rec('cbv5VolMaLen'), { clamp: [5, 100], int: true }),
    cbv5VolMultiplier: pickScalar(o, b, 'cbv5VolMultiplier', rec('cbv5VolMultiplier'), { clamp: [1.0, 10.0] }),
    cbv5DebounceCandles: pickScalar(o, b, 'cbv5DebounceCandles', rec('cbv5DebounceCandles'), { clamp: [1, 20], int: true }),

    // ── Safe-trade filters (recommend OFF; more signals pass) ──
    safeTradeEnabled: pickBool(o, b, 'safeTradeEnabled', rec('safeTradeEnabled')),
    safeTradeTrendlineEnabled: pickBool(o, b, 'safeTradeTrendlineEnabled', rec('safeTradeTrendlineEnabled'), { strict: true }),
    safeTradeNoTradeEnabled: pickBool(o, b, 'safeTradeNoTradeEnabled', rec('safeTradeNoTradeEnabled'), { strict: true }),

    // ── Auto-pause on low volatility ──
    autoPauseEnabled: pickBool(o, b, 'autoPauseEnabled', rec('autoPauseEnabled')),
    autoPauseMinKcPct: pickScalar(o, b, 'autoPauseMinKcPct', rec('autoPauseMinKcPct'), { clamp: [0.1, 50] }),
    // FIX-2026-08-10: 24h volume guard (paired with autoPauseMinKcPct)
    autoPauseMin24hVolUsdt: pickScalar(o, b, 'autoPauseMin24hVolUsdt', rec('autoPauseMin24hVolUsdt'), { clamp: [0, 1_000_000_000] }),
    // FIX-2026-08-29: per-bot opt-in for auto-pause threshold auto-adjust (default ON)
    //   - ถ้า master AppConfig.autoPauseAdjustEnabled=true → scheduler ปรับ KC/Vol thresholds ของบอทนี้
    //   - false: บอทนี้ไม่ถูกปรับ (per-bot opt-out แม้ master เปิดอยู่)
    autoPauseAdjustEnabled: pickBool(o, b, 'autoPauseAdjustEnabled', rec('autoPauseAdjustEnabled')),

    // ── Auto-arm SL-UKC (F1) ──
    autoArmStopLossOnUKC: pickBool(o, b, 'autoArmStopLossOnUKC', rec('autoArmStopLossOnUKC')),
    autoArmLossPct: pickScalar(o, b, 'autoArmLossPct', rec('autoArmLossPct'), { clamp: [1, 99] }),
    autoArmAgeHours: pickScalar(o, b, 'autoArmAgeHours', rec('autoArmAgeHours'), { clamp: [0.5, 999] }),
    slUkcTriggerOnProfit: pickBool(o, b, 'slUkcTriggerOnProfit', rec('slUkcTriggerOnProfit'), { strict: true }),

    // ── FIX-2026-09-06: AUv2 — Auto-Underwater v2 (F1 auto-arm variant) ──
    //   - same age+loss gate แต่ trigger ด้วย "loss ตื้นพอ" → MARKET SELL ทันที
    //   - recommend ON with thb mode (cut-loss fast strategy)
    auv2Enabled: pickBool(o, b, 'auv2Enabled', rec('auv2Enabled'), { strict: true }),
    auv2MinAgeHours: pickScalar(o, b, 'auv2MinAgeHours', rec('auv2MinAgeHours'), { clamp: [0.5, 999] }),
    auv2LossMode: (function () {
      const v = (o && o.auv2LossMode != null) ? o.auv2LossMode
              : (b && b.auv2LossMode != null) ? b.auv2LossMode
              : rec('auv2LossMode');
      return ['pct', 'thb'].includes(v) ? v : 'pct';
    })(),
    auv2MaxLossPct: pickScalar(o, b, 'auv2MaxLossPct', rec('auv2MaxLossPct'), { clamp: [0.1, 50] }),
    auv2MaxLossThb: pickScalar(o, b, 'auv2MaxLossThb', rec('auv2MaxLossThb'), { clamp: [1, 100000] }),
    auv2MaxWaitDays: pickScalar(o, b, 'auv2MaxWaitDays', rec('auv2MaxWaitDays'), { clamp: [0, 90] }),

    // ── TP trend ×N (F2) ──
    tpTrendEnabled: pickBool(o, b, 'tpTrendEnabled', rec('tpTrendEnabled')),
    tpTrendMultiplier: pickScalar(o, b, 'tpTrendMultiplier', rec('tpTrendMultiplier'), { clamp: [1, 10] }),

    // ── Other toggles ──
    stopLossOnUpperKC: pickBool(o, b, 'stopLossOnUpperKC', rec('stopLossOnUpperKC'), { strict: true }),
    autoUpdateTp: pickBool(o, b, 'autoUpdateTp', rec('autoUpdateTp'), { strict: true }),

    // ── Dynamic Position Sizing ──
    dynamicSizeEnabled: pickBool(o, b, 'dynamicSizeEnabled', rec('dynamicSizeEnabled')),

    // ── FIX-2026-09-04: Dynamic Layer Control (DLC) — position-aware layer gate ──
    //   - recommend ON (since DCA/Martingale are OFF — DLC is the recommended layer strategy)
    //   - mutually exclusive with dcaEnabled/martingaleEnabled (enforced in routes + UI)
    //   - dlcBaseLossPct clamp to schema range (-95..-1) to prevent inverted thresholds
    dlcEnabled: pickBool(o, b, 'dlcEnabled', rec('dlcEnabled'), { strict: true }),
    dlcBaseLossPct: pickScalar(o, b, 'dlcBaseLossPct', rec('dlcBaseLossPct'), { clamp: [-95, -1] }),

    // ── FIX-2026-09-02: Round-down Capital (opt-in per-bot) ──
    //   - เมื่อเงินไม่พอ: round notional ลงให้ <= available USDT เพื่อเปิด order ได้
    //   - ถ้า round แล้ว < roundDownCapitalMin → ยังคง skip signal (กัน order เล็กเกินไป)
    //   - recommend ON with min=5.5 USDT ตามที่ user ระบุ
    roundDownCapitalEnabled: pickBool(o, b, 'roundDownCapitalEnabled', rec('roundDownCapitalEnabled'), { strict: true }),
    roundDownCapitalMin: pickScalar(o, b, 'roundDownCapitalMin', rec('roundDownCapitalMin'), { clamp: [1, 10000] }),

    // ── Auto Unlock Cooldown (recommend ON with threshold=2%) ──
    cbAutoUnlockEnabled: pickBool(o, b, 'cbAutoUnlockEnabled', rec('cbAutoUnlockEnabled'), { strict: true }),
    cbAutoUnlockThresholdPct: pickScalar(o, b, 'cbAutoUnlockThresholdPct', rec('cbAutoUnlockThresholdPct'), { clamp: [0.5, 5.0] }),
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
  RECOMMENDED_DEFAULTS, // FIX-2026-09-09: single canonical recommendation (frozen)
};
