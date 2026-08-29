'use strict';

/**
 * FIX-2026-08-29: Auto-pause threshold auto-adjust (singleton scheduler)
 *
 * Background (per user request 2026-08-29):
 *   ระบบ autoPause (auto-pause on Min-%KC + Min 24h Vol) ใช้ threshold คงที่ต่อบอท
 *   ผลคือ "จำนวน running bot" ขึ้นกับค่า threshold ที่ตั้งตอนสร้างบอท — ถ้า threshold ต่ำเกิน
 *   จะมีบอทรันเยอะเกินไป (เสี่ยง overexposure) ถ้า threshold สูงเกินจะมีบอทรันน้อยเกินไป
 *   (พลาดโอกาส)
 *
 *   ฟีเจอร์เสริมนี้ (เปิด/ปิดได้ — default OFF) จะ:
 *     - ทุก ๆ autoPauseAdjustIntervalMs (default 1h) → นับ "running bots" ที่ใช้ autoPause
 *     - ถ้า running > maxBots (default 25) → tighten: autoPauseMinKcPct += kcStep, min24hVol += volStep
 *     - ถ้า running < minBots (default 15) → loosen: autoPauseMinKcPct -= kcStep, min24hVol -= volStep
 *     - ถ้าอยู่ใน [minBots, maxBots] → no-op
 *     - เฉพาะบอทที่ autoPauseAdjustEnabled=true (per-bot opt-out, default ON)
 *
 * Design:
 *   - Singleton class (mirror src/services/autoAddBot.js + src/services/autoReserve.js)
 *   - ไม่มีผลกระทบเมื่อปิด: start() = load config, only install interval if enabled
 *   - reloadConfig() — ใช้ตอน user เปิด/ปิด master toggle ผ่าน admin PUT (in-place)
 *   - runOnce({ source }) — pure tick (idempotent), in-flight guard กัน overlap
 *   - decideAdjustment() — pure function (testable อย่างเดียว)
 *   - บอทที่ถูก adjust → เขียน telemetry ลง bot.autoPauseAdjustLast* ต่อบอทด้วย
 *   - Persist scheduler-level telemetry (lastRunAt/lastStats/lastError) ลง AppConfig
 *   - Emit 'autoPauseAdjust:applied' event เพื่อให้ UI refresh / Telegram notifier แจ้งเตือน
 *   - License-gated: ต้องมี feature 'autoPauseMinKc' enabled ถึงจะทำงาน (matches existing
 *     autoPause behavior — ถ้า license ไม่อนุญาต autoPause ก็ไม่ต้อง adjust threshold)
 *
 * Schema fields used:
 *   Bot.autoPauseAdjustEnabled          (Boolean, default true) — per-bot opt-in
 *   Bot.autoPauseAdjustLastCheckedAt    (Date)   — last tick that included this bot
 *   Bot.autoPauseAdjustLastActionAt     (Date)   — last tick that mutated this bot's thresholds
 *   Bot.autoPauseAdjustLastStats        (Object) — { runningBots, action, deltaKc, deltaVol, prevKc, prevVol, newKc, newVol }
 *   AppConfig.autoPauseAdjustEnabled    (Boolean, default false) — master switch
 *   AppConfig.autoPauseAdjustMinBots    (Number, default 15)
 *   AppConfig.autoPauseAdjustMaxBots    (Number, default 25)
 *   AppConfig.autoPauseAdjustIntervalMs (Number, default 3_600_000 = 1h)
 *   AppConfig.autoPauseAdjustKcStep     (Number, default 0.1)
 *   AppConfig.autoPauseAdjustVolStep    (Number, default 100_000)
 *   AppConfig.autoPauseAdjustLastRunAt  (Date)
 *   AppConfig.autoPauseAdjustLastStats  (Object)
 *   AppConfig.autoPauseAdjustLastError  (String)
 *
 * Safety:
 *   - Clamp thresholds ตาม Bot.js schema bounds ก่อนเขียน:
 *       autoPauseMinKcPct     ∈ [0.1, 50]
 *       autoPauseMin24hVolUsdt ∈ [0, 1_000_000_000]
 *     ถ้า clamp แล้ว threshold เท่าเดิม (เพราะชน min/max) → skip bot (ไม่เขียน no-op)
 *   - bulkWrite({ updateOne, ... }, { ordered: false }) — atomic per-doc, ไม่ block ทั้ง batch
 *   - in-flight guard กัน tick ซ้อน (manual run-now + interval tick)
 */

const AppConfig = require('../db/models/AppConfig');
const Bot = require('../db/models/Bot');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');

// FIX-2026-08-29: License gate — ต้องมี feature 'autoPauseMinKc' enabled (matches existing autoPause behavior)
let licenseService = null;
try { licenseService = require('./licenseService'); } catch (_) { /* ignore */ }

// ─── Defaults (mirror AppConfig schema) ───────────────────────────────────
const DEFAULT_MIN_BOTS = 15;
const DEFAULT_MAX_BOTS = 25;
// FIX-2026-08-30: per user request — change check interval default 1h → 30min
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30min
const DEFAULT_KC_STEP = 0.1;
const DEFAULT_VOL_STEP = 100_000;
// FIX-2026-08-30: configurable clamp defaults (was hardcoded ADJUST_* constants —
//   user wants the operational bounds adjustable via Settings UI).
//   Defaults match the previous hardcoded ADJUST_* values so behavior is unchanged for existing configs.
const DEFAULT_ADJUST_KC_MIN = 0.8;
const DEFAULT_ADJUST_KC_MAX = 2.8;
const DEFAULT_ADJUST_VOL_MIN = 100_000;
const DEFAULT_ADJUST_VOL_MAX = 2_800_000;

// ─── Bot schema clamps (mirror src/db/models/Bot.js) ──────────────────────
//   Used to validate that the bot's stored threshold is a sane number before applying delta.
//   NOT used to bound the auto-adjust output — see ADJUST_* below.
const KC_MIN = 0.1;
const KC_MAX = 50;
const VOL_MIN = 0;
const VOL_MAX = 1_000_000_000;

// ─── Auto-adjust operational bounds (FIX-2026-08-29 per user request) ─────
//   The auto-adjust scheduler MUST NOT push thresholds beyond these bounds,
//   regardless of what the bot's stored value is or what step size is configured.
//   Schema bounds are looser (e.g. KC up to 50) — user wants the strategy to stay
//   within a tighter operating range:
//     - KC (autoPauseMinKcPct):     [0.8, 2.8]   %
//     - Vol (autoPauseMin24hVolUsdt): [100_000, 2_800_000] USDT
//   If a bot is already at the bound and the delta would push it past, the field
//   stays at the bound (no change) and the bot is skipped if BOTH fields are unchanged.
//   FIX-2026-08-30: these are now configurable via Settings UI (autoPauseAdjustKcClamp*
//   and autoPauseAdjustVolClamp* in AppConfig). The constants below serve as the
//   default fallback when no config is present.
const ADJUST_KC_MIN = 0.8;
const ADJUST_KC_MAX = 2.8;
const ADJUST_VOL_MIN = 100_000;
const ADJUST_VOL_MAX = 2_800_000;

// ─── Pure helpers (exported for tests) ────────────────────────────────────
function clampKc(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  // FIX-2026-08-29: round to 4 decimals to avoid floating-point drift in lastStats
  //   (e.g. 1.3 + 0.1 = 1.4000000000000001 — fails exact-match test asserts).
  return Math.round(Math.min(KC_MAX, Math.max(KC_MIN, n)) * 1e4) / 1e4;
}

function clampVol(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(VOL_MAX, Math.max(VOL_MIN, n)));
}

// Auto-adjust clamps (tighter than schema — see ADJUST_* constants above).
// Applied AFTER schema clamp in runOnce() before the skip-unchanged check.
// FIX-2026-08-30: accept bounds arg (default to constants) so user can tighten/loosen
//   the operational range from the Settings UI without redeploy.
function clampAdjustKc(v, bounds) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  const lo = (bounds && Number.isFinite(bounds.kcMin)) ? bounds.kcMin : ADJUST_KC_MIN;
  const hi = (bounds && Number.isFinite(bounds.kcMax)) ? bounds.kcMax : ADJUST_KC_MAX;
  return Math.round(Math.min(hi, Math.max(lo, n)) * 1e4) / 1e4;
}

function clampAdjustVol(v, bounds) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  const lo = (bounds && Number.isFinite(bounds.volMin)) ? bounds.volMin : ADJUST_VOL_MIN;
  const hi = (bounds && Number.isFinite(bounds.volMax)) ? bounds.volMax : ADJUST_VOL_MAX;
  return Math.round(Math.min(hi, Math.max(lo, n)));
}

/**
 * Pure decision function — no I/O, fully testable.
 *
 * Returns { action: 'tighten' | 'loosen' | 'none', deltaKc, deltaVol, reason }
 *
 *  - runningBots > maxBots → tighten (+kcStep, +volStep)
 *  - runningBots < minBots → loosen  (-kcStep, -volStep)
 *  - else                   → none
 *
 * Step deltas are SIGNED (+ for tighten, - for loosen). Caller adds them to current thresholds
 * and then clamps to schema bounds before writing to DB.
 */
function decideAdjustment({ runningBots, minBots, maxBots, kcStep, volStep }) {
  const rb = Number.isFinite(runningBots) ? runningBots : 0;
  const min = Number.isFinite(minBots) ? minBots : DEFAULT_MIN_BOTS;
  const max = Number.isFinite(maxBots) ? maxBots : DEFAULT_MAX_BOTS;
  const kc = Number.isFinite(kcStep) ? kcStep : DEFAULT_KC_STEP;
  const vs = Number.isFinite(volStep) ? volStep : DEFAULT_VOL_STEP;

  if (rb > max) {
    return {
      action: 'tighten',
      deltaKc: +kc,
      deltaVol: +vs,
      reason: `running=${rb} > max=${max} → tighten (+${kc}%KC, +${vs} USDT)`,
    };
  }
  if (rb < min) {
    return {
      action: 'loosen',
      deltaKc: -kc,
      deltaVol: -vs,
      reason: `running=${rb} < min=${min} → loosen (${kc}%KC, ${vs} USDT)`,
    };
  }
  return {
    action: 'none',
    deltaKc: 0,
    deltaVol: 0,
    reason: `running=${rb} ∈ [${min}, ${max}] → no-op`,
  };
}

// ─── Singleton ─────────────────────────────────────────────────────────────
class AutoPauseAdjust {
  constructor() {
    this._timer = null;
    this._inFlight = false;
    this._running = false;
    this._config = {
      enabled: false,
      minBots: DEFAULT_MIN_BOTS,
      maxBots: DEFAULT_MAX_BOTS,
      intervalMs: DEFAULT_INTERVAL_MS,
      kcStep: DEFAULT_KC_STEP,
      volStep: DEFAULT_VOL_STEP,
      // FIX-2026-08-30: configurable operational clamps
      kcClampMin: DEFAULT_ADJUST_KC_MIN,
      kcClampMax: DEFAULT_ADJUST_KC_MAX,
      volClampMin: DEFAULT_ADJUST_VOL_MIN,
      volClampMax: DEFAULT_ADJUST_VOL_MAX,
    };
  }

  async start() {
    // FIX-2026-08-29: clear _inFlight on start so test re-runs aren't poisoned by prior
    //   leaked promise from a previous in-flight test that didn't await properly.
    this._inFlight = false;
    if (this._running) return;
    this._running = true;
    await this._loadConfig();
    this._installInterval();
    logger.info({ cfg: this._config }, 'autoPauseAdjust: started');
  }

  /**
   * Reload from AppConfig + (re-)install interval in-place.
   * ใช้ตอน admin PUT /api/admin/auto-pause-adjust เปิด/ปิด master toggle
   *  - ถ้า enabled: stop existing timer (ถ้ามี) + install in-place (เผื่อ intervalMs เปลี่ยน)
   *  - ถ้า !enabled: stop + ลบ timer (next reloadConfig จะ install ใหม่เมื่อเปิดกลับ)
   */
  async reloadConfig() {
    try {
      await this._loadConfig();
      // Always re-install in case intervalMs changed — clearInterval ก่อนเสมอ
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      this._installInterval();
      logger.info({ cfg: this._config }, 'autoPauseAdjust: reloadConfig applied');
    } catch (err) {
      logger.warn({ err: err.message }, 'autoPauseAdjust: reloadConfig failed');
    }
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._running = false;
    // FIX-2026-08-29: clear _inFlight on stop (mirrors start() reset) — test isolation +
    //   process shutdown safety (prevent stuck-inFlight after SIGTERM mid-tick).
    this._inFlight = false;
    logger.info('autoPauseAdjust: stopped');
  }

  getStatus() {
    return {
      running: this._running,
      timerInstalled: this._timer != null,
      inFlight: this._inFlight,
      config: { ...this._config },
    };
  }

  async _loadConfig() {
    // FIX-2026-08-29: removed .lean() — test mocks return plain object (no chain).
    //   Production Mongoose findOne returns a Query; .lean() was a perf opt for read-only
    //   config, but here we need to stay compatible with the jest mock.
    const cfg = await AppConfig.findOne({ key: 'singleton' });
    if (!cfg) {
      this._config = {
        enabled: false,
        minBots: DEFAULT_MIN_BOTS,
        maxBots: DEFAULT_MAX_BOTS,
        intervalMs: DEFAULT_INTERVAL_MS,
        kcStep: DEFAULT_KC_STEP,
        volStep: DEFAULT_VOL_STEP,
        kcClampMin: DEFAULT_ADJUST_KC_MIN,
        kcClampMax: DEFAULT_ADJUST_KC_MAX,
        volClampMin: DEFAULT_ADJUST_VOL_MIN,
        volClampMax: DEFAULT_ADJUST_VOL_MAX,
      };
      return;
    }
    this._config = {
      enabled: cfg.autoPauseAdjustEnabled === true,
      minBots: Number.isFinite(cfg.autoPauseAdjustMinBots) ? cfg.autoPauseAdjustMinBots : DEFAULT_MIN_BOTS,
      maxBots: Number.isFinite(cfg.autoPauseAdjustMaxBots) ? cfg.autoPauseAdjustMaxBots : DEFAULT_MAX_BOTS,
      intervalMs: Number.isFinite(cfg.autoPauseAdjustIntervalMs) ? cfg.autoPauseAdjustIntervalMs : DEFAULT_INTERVAL_MS,
      kcStep: Number.isFinite(cfg.autoPauseAdjustKcStep) ? cfg.autoPauseAdjustKcStep : DEFAULT_KC_STEP,
      volStep: Number.isFinite(cfg.autoPauseAdjustVolStep) ? cfg.autoPauseAdjustVolStep : DEFAULT_VOL_STEP,
      // FIX-2026-08-30: configurable operational clamps (read from AppConfig; fall back to defaults)
      kcClampMin: Number.isFinite(cfg.autoPauseAdjustKcClampMin) ? cfg.autoPauseAdjustKcClampMin : DEFAULT_ADJUST_KC_MIN,
      kcClampMax: Number.isFinite(cfg.autoPauseAdjustKcClampMax) ? cfg.autoPauseAdjustKcClampMax : DEFAULT_ADJUST_KC_MAX,
      volClampMin: Number.isFinite(cfg.autoPauseAdjustVolClampMin) ? cfg.autoPauseAdjustVolClampMin : DEFAULT_ADJUST_VOL_MIN,
      volClampMax: Number.isFinite(cfg.autoPauseAdjustVolClampMax) ? cfg.autoPauseAdjustVolClampMax : DEFAULT_ADJUST_VOL_MAX,
    };
  }

  _installInterval() {
    if (!this._config.enabled) {
      logger.info('autoPauseAdjust: master disabled — no interval installed');
      return;
    }
    const intervalMs = Math.max(60_000, this._config.intervalMs); // floor 60s
    this._timer = setInterval(() => {
      this._tickSafe().catch((err) => logger.warn({ err: err.message }, 'autoPauseAdjust: tick failed'));
    }, intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    logger.info({ intervalMs }, 'autoPauseAdjust: interval installed');
  }

  async _tickSafe() {
    return this.runOnce({ source: 'periodic' });
  }

  /**
   * Run a single adjust cycle.
   *
   * @param {{ source?: 'periodic' | 'manual' }} opts
   * @returns {Promise<Object>} stats — { skipped, runningBots, eligibleBots, action, updatedBots, reason, error }
   */
  async runOnce({ source = 'periodic' } = {}) {
    if (this._inFlight) {
      logger.info({ source }, 'autoPauseAdjust: tick skipped (in-flight)');
      return { skipped: 'in-flight' };
    }
    this._inFlight = true;
    const startedAt = new Date();
    try {
      // Reload config in case user changed settings between ticks (cheap, single doc)
      await this._loadConfig();

      if (!this._config.enabled) {
        return { skipped: 'disabled' };
      }

      // License gate

      // License gate — ถ้า license ไม่อนุญาต autoPause feature ก็ไม่ adjust
      if (licenseService && typeof licenseService.isFeatureEnabled === 'function'
          && !licenseService.isFeatureEnabled('autoPauseMinKc')) {
        return { skipped: 'license-disabled' };
      }

      // 1. Count running bots (enabled && autoPauseEnabled && !deletedAt)
      const runningBots = await Bot.countDocuments({
        enabled: { $ne: false },
        autoPauseEnabled: { $ne: false },
        deletedAt: null,
      });

      // 2. Decide
      const decision = decideAdjustment({
        runningBots,
        minBots: this._config.minBots,
        maxBots: this._config.maxBots,
        kcStep: this._config.kcStep,
        volStep: this._config.volStep,
      });

      if (decision.action === 'none') {
        const stats = {
          source,
          runningBots,
          action: null,
          updatedBots: 0,
          reason: decision.reason,
          ranAt: startedAt,
          // FIX-2026-08-30: include bounds even in no-op path so UI shows live clamps
          bounds: {
            kcMin: this._config.kcClampMin,
            kcMax: this._config.kcClampMax,
            volMin: this._config.volClampMin,
            volMax: this._config.volClampMax,
          },
        };
        await this._persistSchedulerTelemetry(stats, null);
        return stats;
      }

      // 3. Find eligible bots (autoPauseEnabled !== false AND autoPauseAdjustEnabled !== false AND !deletedAt)
      const eligibleDocs = await Bot.find(
        {
          autoPauseEnabled: { $ne: false },
          autoPauseAdjustEnabled: { $ne: false },
          deletedAt: null,
        },
        { _id: 1, autoPauseMinKcPct: 1, autoPauseMin24hVolUsdt: 1 }
      ).lean();

      if (!eligibleDocs || eligibleDocs.length === 0) {
        const stats = {
          source,
          runningBots,
          eligibleBots: 0,
          action: decision.action,
          updatedBots: 0,
          reason: `${decision.reason}; no eligible bots`,
          ranAt: startedAt,
        };
        await this._persistSchedulerTelemetry(stats, null);
        return stats;
      }

      // 4. Compute new thresholds per bot (apply delta + schema clamp + operational clamp; skip no-op writes)
      // FIX-2026-08-30: thread configurable bounds through clampAdjust* calls
      const bounds = {
        kcMin: this._config.kcClampMin,
        kcMax: this._config.kcClampMax,
        volMin: this._config.volClampMin,
        volMax: this._config.volClampMax,
      };
      const ops = [];
      let skippedClamped = 0;
      for (const doc of eligibleDocs) {
        // schema-level clamp: ensure stored values are valid numbers (not null/NaN)
        const prevKc = clampKc(doc.autoPauseMinKcPct);
        const prevVol = clampVol(doc.autoPauseMin24hVolUsdt);
        if (prevKc == null || prevVol == null) {
          skippedClamped += 1;
          continue;
        }
        // apply delta
        const rawNewKc = prevKc + decision.deltaKc;
        const rawNewVol = prevVol + decision.deltaVol;
        // schema-level clamp first (sanity), then operational clamp (FIX-2026-08-29 user request)
        const newKc = clampAdjustKc(rawNewKc, bounds);
        const newVol = clampAdjustVol(rawNewVol, bounds);
        if (newKc == null || newVol == null) {
          skippedClamped += 1;
          continue;
        }
        // ถ้าทั้งคู่เท่าเดิม (ชน min/max) → skip ไม่เขียน
        if (newKc === prevKc && newVol === prevVol) {
          skippedClamped += 1;
          continue;
        }
        const actionAt = new Date();
        ops.push({
          updateOne: {
            filter: { _id: doc._id },
            update: {
              $set: {
                autoPauseMinKcPct: newKc,
                autoPauseMin24hVolUsdt: newVol,
                autoPauseAdjustLastCheckedAt: startedAt,
                autoPauseAdjustLastActionAt: actionAt,
                autoPauseAdjustLastStats: {
                  runningBots,
                  action: decision.action,
                  deltaKc: decision.deltaKc,
                  deltaVol: decision.deltaVol,
                  prevKc,
                  prevVol,
                  newKc,
                  newVol,
                },
              },
            },
          },
        });
      }

      // 5. Bulk write (atomic per-doc, ordered:false — ไม่ block เมื่อ doc นึงพัง)
      let updatedBots = 0;
      if (ops.length > 0) {
        const result = await Bot.bulkWrite(ops, { ordered: false });
        updatedBots = (result && (result.modifiedCount || result.nModified)) || ops.length;
      }

      const stats = {
        source,
        runningBots,
        eligibleBots: eligibleDocs.length,
        action: decision.action,
        updatedBots,
        skippedClamped,
        deltaKc: decision.deltaKc,
        deltaVol: decision.deltaVol,
        reason: decision.reason,
        ranAt: startedAt,
        // FIX-2026-08-30: include configured bounds so run-now response shows live values
        bounds: { ...bounds },
      };
      await this._persistSchedulerTelemetry(stats, null);

      // 6. Emit EventBus event (UI refresh + Telegram notifier hooks)
      if (updatedBots > 0) {
        try {
          eventBus.emit('autoPauseAdjust:applied', stats);
        } catch (e) { /* ignore */ }
      }
      logger.info({ stats }, 'autoPauseAdjust: tick done');
      return stats;
    } catch (err) {
      logger.warn({ err: err.message, source }, 'autoPauseAdjust: tick error');
      try {
        await this._persistSchedulerTelemetry({ source, ranAt: startedAt }, err.message);
      } catch (_) { /* ignore */ }
      return { error: err.message, source, ranAt: startedAt };
    } finally {
      this._inFlight = false;
    }
  }

  async _persistSchedulerTelemetry(stats, errorMsg) {
    try {
      const update = {
        autoPauseAdjustLastRunAt: new Date(),
        autoPauseAdjustLastStats: stats,
        autoPauseAdjustLastError: errorMsg || null,
      };
      await AppConfig.updateOne({ key: 'singleton' }, { $set: update });
    } catch (err) {
      logger.warn({ err: err.message }, 'autoPauseAdjust: persistSchedulerTelemetry failed');
    }
  }
}

const instance = new AutoPauseAdjust();

module.exports = instance;
module.exports.AutoPauseAdjust = AutoPauseAdjust; // class (for tests)
module.exports.decideAdjustment = decideAdjustment;
module.exports.clampKc = clampKc;
module.exports.clampVol = clampVol;
module.exports.clampAdjustKc = clampAdjustKc; // FIX-2026-08-29: tighter operational bounds
module.exports.clampAdjustVol = clampAdjustVol; // FIX-2026-08-29: tighter operational bounds
module.exports.DEFAULT_MIN_BOTS = DEFAULT_MIN_BOTS;
module.exports.DEFAULT_MAX_BOTS = DEFAULT_MAX_BOTS;
module.exports.DEFAULT_INTERVAL_MS = DEFAULT_INTERVAL_MS;
module.exports.DEFAULT_KC_STEP = DEFAULT_KC_STEP;
module.exports.DEFAULT_VOL_STEP = DEFAULT_VOL_STEP;
module.exports.DEFAULT_ADJUST_KC_MIN = DEFAULT_ADJUST_KC_MIN; // FIX-2026-08-30: configurable defaults
module.exports.DEFAULT_ADJUST_KC_MAX = DEFAULT_ADJUST_KC_MAX;
module.exports.DEFAULT_ADJUST_VOL_MIN = DEFAULT_ADJUST_VOL_MIN;
module.exports.DEFAULT_ADJUST_VOL_MAX = DEFAULT_ADJUST_VOL_MAX;
module.exports.KC_MIN = KC_MIN;
module.exports.KC_MAX = KC_MAX;
module.exports.VOL_MIN = VOL_MIN;
module.exports.VOL_MAX = VOL_MAX;
module.exports.ADJUST_KC_MIN = ADJUST_KC_MIN; // FIX-2026-08-29: user-requested clamp
module.exports.ADJUST_KC_MAX = ADJUST_KC_MAX; // FIX-2026-08-29: user-requested clamp
module.exports.ADJUST_VOL_MIN = ADJUST_VOL_MIN; // FIX-2026-08-29: user-requested clamp
module.exports.ADJUST_VOL_MAX = ADJUST_VOL_MAX; // FIX-2026-08-29: user-requested clamp
