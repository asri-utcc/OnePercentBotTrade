'use strict';

/**
 * FIX-2026-08-08: Feature #1 — Dynamic Position Sizing (auto-tune size + layers)
 *   - rule (per closed position = 1 BUY → 1 SELL), ค่าทั้งหมดปรับได้จากหน้า /settings.html:
 *       * ชนะติดกัน N ไม้            → size +X USDT, layers +Y   (default 3 → +1 / +1)
 *       * N ไม้ล่าสุดกำไร > P% ทุกไม้ → size +X USDT, layers +Y   (default 2 ไม้ >2% → +2 / +0)
 *       * แพ้ติดกัน N ไม้             → size -X USDT, layers -Y   (default 1 → -2 / -2)
 *   - bounds default: size 6..15 USDT, layers 1..5 (ปรับได้)
 *   - default toggle per bot: `dynamicSizeEnabled` (default true)
 *   - **mutually exclusive** กับ DCA / Martingale (validated in routes)
 *   - evaluate after handleSellFilled (in-place — single source of truth)
 *   - cooldown ระหว่าง resize (default 5 นาที, ปรับได้) กัน whipsaw
 *   - "trade" = 1 closed position (per user's clarification)
 *
 * FIX-2026-08-08 (rev2): แก้บั๊ก P0 — DPS ไม่เคยทำงานสำเร็จเลยตั้งแต่ deploy
 *   A1) persistEval() return ทันทีถ้า !changed → history ไม่ถูกบันทึก → ไม้ชนะปกติ (reason='no-rule',
 *       changed=false) ทำให้ history ไม่มีวันยาวเกิน 1 ช่อง → Rule 1 (ชนะ 3) + Rule 2 (2 ไม้ >2%)
 *       ยิงไม่ได้ตลอดกาล เหลือแต่ Rule 3 (แพ้) = บันไดลงทางเดียว
 *       → แก้: แยก "บันทึกสถิติ" ออกจาก "ปรับขนาด" — persistState() เขียน history เสมอ
 *   A2) cooldown return ก่อน append history → ไม้ที่ปิดในช่วง cooldown หายจากสถิติ
 *       → แก้: append history ก่อน แล้วค่อยเช็ค cooldown (คืน newHistory ทุก path หลัง append)
 *   A3) clamp 6..15 บีบทับ capitalPerTrade ของ user (บอท 20 USDT ถูกหั่นเหลือ 15)
 *       → แก้: anchored clamp — cfg.respectBotCapital (default true) ขยาย band ให้ครอบ
 *         capitalPerTrade/maxTrades ของบอทเสมอ
 *   A6) กฎยิงซ้ำจาก streak เดิม (ชนะ 3 แล้วชนะไม้ที่ 4 → history ยัง [W,W,W] → +1 อีก)
 *       → แก้: cfg.resetHistoryOnFire (default true) เคลียร์ history เมื่อกฎยิง
 */

// FIX-2026-08-28 B6: gate DPS via license (basic tier = OFF)
const licenseService = require('../services/licenseService');

// ─────────────────────────────────────────────────────────────────────────────
// FIX-2026-08-08: design notes
//   - effective size = dynamicSizeCurrent if set else capitalPerTrade
//   - effective layers = dynamicLayersCurrent if set else maxTrades
//   - persisted `dynamicSizeLastResults` = closed positions ล่าสุด (most recent first),
//     cap = max(winStreakCount, bigWinCount, lossStreakCount)
//   - **rule order matters**: เช็ค win-streak ก่อน (priority สูงสุด) → big-win → loss
//     เมื่อหลายเงื่อนไขเข้าพร้อมกัน apply delta เดียวต่อ 1 eval
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULTS — ค่าเดิมทุกตัวก่อน rev2 (AppConfig ที่ยังไม่มี field เหล่านี้ = ทำงานเหมือนเดิมเป๊ะ)
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULTS = {
  minSize: 6,               // USDT
  maxSize: 15,              // USDT
  minLayers: 1,
  maxLayers: 5,
  cooldownMs: 5 * 60 * 1000, // 5 min between resizes
  // Rule 1 — ชนะติดกัน N ไม้
  winStreakCount: 3,
  winStreakDeltaSize: 1,
  winStreakDeltaLayers: 1,
  // Rule 2 — N ไม้ล่าสุดกำไร > bigWinPct% ทุกไม้
  bigWinCount: 2,
  bigWinPct: 2.0,
  bigWinDeltaSize: 2,
  bigWinDeltaLayers: 0,
  // Rule 3 — แพ้ติดกัน N ไม้
  lossStreakCount: 1,
  lossDeltaSize: -2,
  lossDeltaLayers: -2,
  // safety
  respectBotCapital: true,   // anchored clamp — band ต้องครอบ capitalPerTrade เสมอ
  resetHistoryOnFire: true,  // กฎยิงแล้วเคลียร์ streak (ต้องสร้าง streak ใหม่ถึงจะยิงอีก)
  dryRun: false,             // คำนวณ + แจ้งเตือน แต่ไม่เขียน size ลง DB
};

// Legacy exports (คงไว้เพื่อ backward-compat กับ test/caller เดิม)
const MIN_SIZE = DEFAULTS.minSize;
const MAX_SIZE = DEFAULTS.maxSize;
const MIN_LAYERS = DEFAULTS.minLayers;
const MAX_LAYERS = DEFAULTS.maxLayers;
const COOLDOWN_MS = DEFAULTS.cooldownMs;
const MAX_HISTORY = 3;
const PROFIT_THRESHOLD_PCT = DEFAULTS.bigWinPct;

/**
 * FIX-2026-08-08 (rev2): normalize config — merge partial cfg เข้ากับ DEFAULTS
 *   - field ที่เป็น null/undefined/NaN → ใช้ default (ไม่ยอมให้ค่าพังหลุดเข้า engine)
 *   - derived: maxHistory = ความยาวที่กฎยาวสุดต้องใช้
 */
function normalizeConfig(cfg) {
  const out = { ...DEFAULTS };
  if (cfg && typeof cfg === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      const v = cfg[k];
      if (v === null || v === undefined) continue;
      if (typeof DEFAULTS[k] === 'boolean') out[k] = !!v;
      else if (Number.isFinite(Number(v))) out[k] = Number(v);
    }
  }
  out.maxHistory = Math.max(1, out.winStreakCount, out.bigWinCount, out.lossStreakCount);
  return out;
}

/**
 * Compute size delta + layers delta based on recent closed positions.
 * @param {Array} lastResults - most recent first
 * @param {Object} cfg - normalized config (optional → DEFAULTS)
 * Returns { deltaSize, deltaLayers, reason }
 */
function computeDeltasFromHistory(lastResults, cfg) {
  const c = cfg && cfg.maxHistory ? cfg : normalizeConfig(cfg);
  if (!Array.isArray(lastResults) || lastResults.length === 0) {
    return { deltaSize: 0, deltaLayers: 0, reason: 'no-history', newSize: null, newLayers: null };
  }

  // Rule 1: ชนะติดกัน N ไม้ (N ไม้ล่าสุดต้องชนะทั้งหมด)
  if (lastResults.length >= c.winStreakCount) {
    const window = lastResults.slice(0, c.winStreakCount);
    const allWin = window.every((r) => r && r.isWin === true);
    if (allWin) {
      return {
        deltaSize: c.winStreakDeltaSize,
        deltaLayers: c.winStreakDeltaLayers,
        reason: `${c.winStreakCount}-wins`,
        newSize: null,
        newLayers: null,
      };
    }
  }

  // Rule 2: N ไม้ล่าสุดกำไร > bigWinPct% ทุกไม้ (apply larger delta to win big)
  if (lastResults.length >= c.bigWinCount) {
    const window = lastResults.slice(0, c.bigWinCount);
    const bothBigProfit = window.every(
      (r) => r && r.isWin === true && Number.isFinite(r.pnlPct) && r.pnlPct > c.bigWinPct
    );
    if (bothBigProfit) {
      return {
        deltaSize: c.bigWinDeltaSize,
        deltaLayers: c.bigWinDeltaLayers,
        reason: `${c.bigWinCount}-wins-${c.bigWinPct}pct`,
        newSize: null,
        newLayers: null,
      };
    }
  }

  // Rule 3: แพ้ติดกัน N ไม้ (default 1 = พฤติกรรมเดิมเป๊ะ)
  if (lastResults.length >= c.lossStreakCount) {
    const window = lastResults.slice(0, c.lossStreakCount);
    const allLoss = window.every((r) => r && r.isWin === false);
    if (allLoss) {
      return {
        deltaSize: c.lossDeltaSize,
        deltaLayers: c.lossDeltaLayers,
        reason: c.lossStreakCount > 1 ? `${c.lossStreakCount}-losses` : 'loss',
        newSize: null,
        newLayers: null,
      };
    }
  }

  // Mild win (ชนะแต่ไม่เข้ากฎไหน): no change
  return { deltaSize: 0, deltaLayers: 0, reason: 'no-rule', newSize: null, newLayers: null };
}

/**
 * FIX-2026-08-08 (rev2): resolveBounds — anchored clamp (แก้บั๊ก A3)
 *   - respectBotCapital=true (default): ขยาย band ให้ครอบ capitalPerTrade / maxTrades ของบอทเสมอ
 *     → DPS ขยับรอบๆ ค่าที่ user ตั้ง แต่ไม่มีวันกระโดดออกนอกกรอบที่ user ตั้งใจ
 *   - respectBotCapital=false: ใช้ band ตรงๆ ตามที่ตั้งในหน้า settings
 */
function resolveBounds(bot, cfg) {
  const c = cfg && cfg.maxHistory ? cfg : normalizeConfig(cfg);
  let minSize = c.minSize;
  let maxSize = c.maxSize;
  let minLayers = c.minLayers;
  let maxLayers = c.maxLayers;

  if (c.respectBotCapital && bot) {
    const cap = Number(bot.capitalPerTrade);
    if (Number.isFinite(cap) && cap > 0) {
      minSize = Math.min(minSize, cap);
      maxSize = Math.max(maxSize, cap);
    }
    const mt = Number(bot.maxTrades);
    if (Number.isFinite(mt) && mt > 0) {
      minLayers = Math.min(minLayers, mt);
      maxLayers = Math.max(maxLayers, mt);
    }
  }
  return { minSize, maxSize, minLayers, maxLayers };
}

/**
 * Apply clamping to size and layers.
 * @param {Object} bounds - { minSize, maxSize, minLayers, maxLayers } (optional → DEFAULTS)
 * Returns { newSize, newLayers }
 */
function clampSizeAndLayers(size, layers, bounds) {
  const b = bounds && Number.isFinite(bounds.minSize) ? bounds : DEFAULTS;
  const cSize = Math.max(b.minSize, Math.min(b.maxSize, size));
  const cLayers = Math.max(b.minLayers, Math.min(b.maxLayers, layers));
  return { newSize: cSize, newLayers: cLayers };
}

/**
 * FIX-2026-08-08: evaluate() — main entry point after a SELL fill
 *
 * FIX-2026-08-08 (rev2) ลำดับใหม่ — แยก "บันทึกสถิติ" ออกจาก "ปรับขนาด":
 *   1. gates (no-bot / disabled / master-off / dca / martingale / bad-config) → return, ไม่แตะ history
 *   2. append tradeResult ลง history **เสมอ**            ← ย้ายขึ้นมาก่อน cooldown (แก้ A2)
 *   3. ถ้าติด cooldown → return { changed:false, skipped:'cooldown', newHistory }
 *      ← caller ยัง persist history ได้ (แก้ A1+A2)
 *   4. compute rule → clamp (anchored) → changed?
 *   5. ถ้ากฎยิง + resetHistoryOnFire → เคลียร์ history   (แก้ A6)
 *   - **does NOT persist** — caller persists ด้วย persistState()
 *
 * @param {Object} bot - Bot doc/lean — ต้องมี dynamicSizeEnabled, dynamicSizeCurrent,
 *   dynamicLayersCurrent, dynamicSizeLastResults, dynamicSizeCooldownUntil, capitalPerTrade,
 *   maxTrades, dcaEnabled, martingaleEnabled
 * @param {Object} tradeResult - { closedAt: Date, pnlPct: Number, isWin: Boolean }
 * @param {Object} [cfg] - DPS config จาก masterConfig.getDpsConfig() (optional → DEFAULTS)
 * @returns {Object} { changed, before, after, reason, appliedAt, cooldownUntil, newHistory, skipped, dryRun, bounds }
 */
function evaluate(bot, tradeResult, cfg) {
  const c = normalizeConfig(cfg);

  if (!bot) return { changed: false, skipped: 'no-bot', reason: 'no-bot' };
  if (bot.dynamicSizeEnabled === false) {
    return { changed: false, skipped: 'disabled', reason: 'disabled' };
  }
  // FIX-2026-08-28 B6: license gate — basic tier disables DPS
  if (!licenseService.isFeatureEnabled('dps')) {
    return { changed: false, skipped: 'license-disabled', reason: 'license-disabled' };
  }
  // FIX-2026-08-08: master switch (AppConfig.masterDynamicSizeEnabled, default true)
  //   - trader hook stamps master state into bot._masterDynamicSizeEnabled
  //   - if explicit false → skip (per-bot dynamicSizeEnabled still takes precedence — checked first)
  if (bot._masterDynamicSizeEnabled === false) {
    return { changed: false, skipped: 'master-off', reason: 'master-off' };
  }
  if (bot.dcaEnabled === true) {
    return { changed: false, skipped: 'dca-mode', reason: 'dca-mode' };
  }
  if (bot.martingaleEnabled === true) {
    return { changed: false, skipped: 'martingale-mode', reason: 'martingale-mode' };
  }

  // ── ข้อ 2: append history เสมอ (ก่อน cooldown gate) ────────────────────────
  // FIX-2026-08-08 (rev2): บันทึกสถิติก่อน — กันขาดหากข้อ 4 (rule) ถูก skip
  const prev = Array.isArray(bot.dynamicSizeLastResults) ? bot.dynamicSizeLastResults : [];
  const tr = tradeResult || {};
  const newHistory = [
    {
      closedAt: tr.closedAt || new Date(),
      pnlPct: Number.isFinite(tr.pnlPct) ? tr.pnlPct : 0,
      isWin: !!tr.isWin,
    },
    ...prev,
  ].slice(0, c.maxHistory);

  // FIX-2026-08-08 (rev2): bad-config guard — ไม่ clamp เพี้ยนถ้า config กลับด้าน
  //   - ตรวจหลัง append history เพื่อให้สถิติไม่หาย (ถ้า user แก้ config ในอนาคต จะได้นับต่อ)
  //   - คืน newHistory ให้ caller persist ด้วย (เหมือน cooldown path)
  const bounds = resolveBounds(bot, c);
  if (bounds.minSize > bounds.maxSize || bounds.minLayers > bounds.maxLayers) {
    return { changed: false, skipped: 'bad-config', reason: 'bad-config', newHistory };
  }

  const now = Date.now();

  // ── ข้อ 3: cooldown — ไม่ปรับขนาด แต่ยังคืน history ให้ caller บันทึก ──────
  if (bot.dynamicSizeCooldownUntil && new Date(bot.dynamicSizeCooldownUntil).getTime() > now) {
    return { changed: false, skipped: 'cooldown', reason: 'cooldown', newHistory };
  }

  // ── ข้อ 4: compute rule → clamp ───────────────────────────────────────────
  const baseSize = Number.isFinite(bot.dynamicSizeCurrent) ? bot.dynamicSizeCurrent : (bot.capitalPerTrade || 0);
  const baseLayers = Number.isFinite(bot.dynamicLayersCurrent) ? bot.dynamicLayersCurrent : (bot.maxTrades || 0);

  const deltas = computeDeltasFromHistory(newHistory, c);
  const targetSize = baseSize + deltas.deltaSize;
  const targetLayers = baseLayers + deltas.deltaLayers;
  const { newSize, newLayers } = clampSizeAndLayers(targetSize, targetLayers, bounds);

  const ruleFired = deltas.reason !== 'no-rule' && deltas.reason !== 'no-history';
  const sizeChanged = newSize !== baseSize || newLayers !== baseLayers;

  // ── ข้อ 5: กฎยิงแล้วเคลียร์ streak (แก้ A6) ────────────────────────────────
  //   เคลียร์เฉพาะเมื่อกฎยิงและมีการเปลี่ยนจริง — ถ้าชนเพดานแล้ว (clamp) ไม่เคลียร์
  //   เพื่อให้ยังเห็น streak ที่แท้จริงใน DB
  const finalHistory = (c.resetHistoryOnFire && ruleFired && sizeChanged) ? [] : newHistory;

  return {
    // dryRun → ไม่ให้ caller เขียน size ลง DB (แต่ history ยังบันทึกปกติ)
    changed: c.dryRun ? false : sizeChanged,
    wouldChange: sizeChanged,
    dryRun: !!c.dryRun,
    before: { size: baseSize, layers: baseLayers },
    after: { size: newSize, layers: newLayers },
    reason: deltas.reason,
    newHistory: finalHistory,
    appliedAt: new Date(),
    cooldownUntil: new Date(now + c.cooldownMs),
    bounds,
    skipped: null,
  };
}

/**
 * FIX-2026-08-08: getEffectiveSizeOrLayers — resolve effective size/layers
 *   - returns dynamicSizeCurrent if set, else capitalPerTrade
 *   - used by trader.placeBuy() to compute buy quantity
 */
function getEffective(bot) {
  if (!bot) return { size: 0, layers: 0 };
  return {
    size: Number.isFinite(bot.dynamicSizeCurrent) ? bot.dynamicSizeCurrent : (bot.capitalPerTrade || 0),
    layers: Number.isFinite(bot.dynamicLayersCurrent) ? bot.dynamicLayersCurrent : (bot.maxTrades || 0),
  };
}

/**
 * FIX-2026-08-08 (rev2): persistState — persist eval result (แทน persistEval เดิม)
 *   - เขียน dynamicSizeLastResults + dynamicSizeLastEvaluatedAt **เสมอ** (เมื่อมี newHistory)
 *     ← หัวใจของการแก้บั๊ก A1: history ต้องสะสมได้แม้ไม้นั้นไม่ทำให้ size เปลี่ยน
 *   - เขียน dynamicSizeCurrent/dynamicLayersCurrent/dynamicSizeCooldownUntil **เฉพาะเมื่อ changed**
 *   - updateOne ตัวเดียว → +1 write ต่อ 1 position ปิด (ไม่มีนัยยะต่อ load)
 *   - returns true ถ้ามีการเขียน size จริง (caller ใช้ตัดสินใจ log/telegram)
 */
async function persistState(Bot, botId, evalResult) {
  if (!evalResult) return false;
  const update = {};
  if (Array.isArray(evalResult.newHistory)) {
    update.dynamicSizeLastResults = evalResult.newHistory;
    update.dynamicSizeLastEvaluatedAt = evalResult.appliedAt || new Date();
  }
  if (evalResult.changed) {
    update.dynamicSizeCurrent = evalResult.after.size;
    update.dynamicLayersCurrent = evalResult.after.layers;
    update.dynamicSizeCooldownUntil = evalResult.cooldownUntil;
  }
  if (Object.keys(update).length === 0) return false;
  await Bot.updateOne({ _id: botId }, { $set: update });
  return !!evalResult.changed;
}

/**
 * DEPRECATED (kept for backward-compat): persistEval — เขียนเฉพาะตอน changed
 *   ห้ามใช้ในโค้ดใหม่ — เป็นต้นเหตุบั๊ก A1 (history ไม่ถูกบันทึก)
 */
async function persistEval(Bot, botId, evalResult) {
  if (!evalResult || !evalResult.changed) return false;
  return persistState(Bot, botId, evalResult);
}

/**
 * FIX-2026-08-08 (rev2): resetState — เคลียร์ DPS state ของบอท
 *   ใช้เมื่อ user แก้ capitalPerTrade/maxTrades เอง หรือกดปุ่ม reset
 */
function resetStateUpdate() {
  return {
    dynamicSizeCurrent: null,
    dynamicLayersCurrent: null,
    dynamicSizeLastResults: [],
    dynamicSizeCooldownUntil: null,
    dynamicSizeLastEvaluatedAt: null,
  };
}

module.exports = {
  // config
  DEFAULTS,
  normalizeConfig,
  // constants (exported for tests / backward-compat)
  MIN_SIZE,
  MAX_SIZE,
  MIN_LAYERS,
  MAX_LAYERS,
  COOLDOWN_MS,
  MAX_HISTORY,
  PROFIT_THRESHOLD_PCT,
  // pure helpers
  computeDeltasFromHistory,
  clampSizeAndLayers,
  resolveBounds,
  resetStateUpdate,
  // main API
  evaluate,
  getEffective,
  persistState,
  persistEval,
};
