'use strict';

/**
 * FIX-2026-07-23: TP auto-updater
 *   - per-bot toggle `autoUpdateTp: Boolean` บน Bot model
 *   - ระบบจะ recompute TP% จาก Min %KC(500 bars) + EMA20 trend(upper-TF)
 *     ทุก ๆ ต้นชั่วโมง (HH:00:00 local time) แล้ว persist ลง bot.tpPercent
 *   - ใช้ logic เดียวกับ /api/bots/suggest-tp (single source of truth)
 *   - formatTpToXxx1 — output อยู่ในรูป x.xx1 เสมอ (ง่ายต่อการเทียบ/อ่าน)
 *
 * Flow:
 *   1) botManager.start() → scheduleHourlyTpUpdate() — ตั้ง setInterval(60s)
 *      ทุก ๆ tick จะเช็คว่าเริ่มเข้านาทีแรกของชั่วโมง (now.getMinutes() === 0) หรือยัง
 *   2) ในนาทีแรกของชั่วโมง → runTpUpdateForAllEligibleBots()
 *      - query bots ที่ autoUpdateTp=true (refresh ทุกครั้งเพื่อรองรับ enable/disable ตอน runtime)
 *      - สำหรับแต่ละบอท: fetch klines → คำนวณ → ถ้า TP ใหม่ต่างจากเดิม → update bot.tpPercent + updateTpAt
 *      - ถ้า minTP เดิม = minTP ใหม่ → skip (กัน spam log + DB write)
 *   3) กัน overlap ด้วย inFlight guard (กรณี tick รอบก่อนนานกว่า 1 นาที)
 */

const Bot = require('../db/models/Bot');
const binanceRest = require('../binance/binanceRest');
const volatilityScanner = require('./volatilityScanner');
const indicators = require('./indicators');
const fees = require('../binance/fees');
const eventBus = require('../services/eventBus'); // FIX-2026-07-26: emit tp:low event for Telegram notifier

// FIX-2026-07-26: TP low warning threshold (NET TP ต่ำกว่า threshold นี้ → แจ้งเตือน)
const TP_LOW_PNL_THRESHOLD_PCT = 0.2;
const logger = require('../utils/logger');

const SUGGEST_WINDOW_DEFAULT = 500; // FIX-2026-07-25: per-bot override ผ่าน bot.suggestTpWindow (range 30..1000)

// FIX-2026-08-02: TP floor bumped 0.111 → 0.281 (per user request)
//   - ถ้า NET TP% (ก่อน format) < 0.281 → override เป็น 0.281% (เดิม 0.111%)
//   - ใช้กับ autoUpdateTp flow ตอน low-volatility regime
//   - ไม่ทำให้บอทหยุดเทรด (TP 0.281% ยังดีกว่าไม่เทรดเลย + ลดโอกาส fee กินกำไร)
//   - tpLowPnL warning (threshold 0.2%) ตอนนี้ effectively dead (floor 0.281 > 0.2)
//     ถ้าอยากให้ warning ยังทำงาน → ปรับ TP_LOW_PNL_THRESHOLD_PCT เป็นค่าที่ต่ำกว่า 0.281
//   - ใช้ helper เดียวกันทั้งใน computeSuggestedTpForBot + suggest-tp route (single source of truth)
const TP_FLOOR_THRESHOLD_PCT = 0.281; // NET TP < ค่านี้ → trigger override
const TP_FLOOR_OVERRIDE_PCT = 0.281; // ค่าที่ใช้แทน (pass formatTpToXxx1 → 0.281)

/**
 * FIX-2026-07-23: format TP ให้เป็นทศนิยม 3 ตำแหน่ง โดยหลักพัน (ตำแหน่งที่ 3) ต้องเป็น 1 เสมอ
 *   - floor ทศนิยมที่ 2 แล้ว +0.001 → output อยู่ในรูป x.xx1 เสมอ
 */
function formatTpToXxx1(value) {
  if (value == null || !Number.isFinite(value)) return value;
  const truncated2 = Math.floor(value * 100) / 100;
  return Number((truncated2 + 0.001).toFixed(3));
}

/**
 * FIX-2026-08-02: auto-floor — ถ้า NET TP% (raw ก่อน format) < TP_FLOOR_THRESHOLD_PCT → override เป็น TP_FLOOR_OVERRIDE_PCT
 *   - FIX-2026-08-02: threshold + override เป็น 0.281% (เดิม 0.1% / 0.111%)
 *   - return { value, overridden, rawNetBeforeOverride }
 *     - value: ค่าที่จะใช้ (post-floor) — caller ต้องผ่าน formatTpToXxx1 อีกครั้ง
 *     - overridden: true ถ้าเคย override (ให้ caller แสดง tooltip / log)
 *     - rawNetBeforeOverride: ค่า NET ดิบก่อน floor (null ถ้า raw = null)
 */
function applyMinNetTpFloor(netSuggestedTpPct) {
  if (netSuggestedTpPct == null || !Number.isFinite(netSuggestedTpPct)) {
    return { value: null, overridden: false, rawNetBeforeOverride: null };
  }
  if (netSuggestedTpPct < TP_FLOOR_THRESHOLD_PCT) {
    return {
      value: TP_FLOOR_OVERRIDE_PCT,
      overridden: true,
      rawNetBeforeOverride: netSuggestedTpPct,
    };
  }
  return {
    value: netSuggestedTpPct,
    overridden: false,
    rawNetBeforeOverride: netSuggestedTpPct,
  };
}

/**
 * คำนวณ suggested TP% สำหรับบอท 1 ตัว
 *   - ใช้ logic เดียวกับ /api/bots/suggest-tp
 *   - return { suggestedTpPct, rawSuggestedTpPct, kcMinPct, trendState, trendTF, trendGapPct, ms, error? }
 */
async function computeSuggestedTpForBot(bot) {
  const start = Date.now();
  try {
    // 1) fetch main TF klines (per-bot suggestTpWindow, default 500)
    const suggestWindow = Math.min(1000, Math.max(30, bot.suggestTpWindow ?? SUGGEST_WINDOW_DEFAULT));
    const rawMain = await binanceRest.getKlines({
      symbol: bot.symbol, interval: bot.timeframe, limit: suggestWindow,
    });
    const mainKlines = rawMain.map((k) => ({
      openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      closeTime: k[6],
    }));
    if (mainKlines.length < 20) {
      return { error: `insufficient klines: got ${mainKlines.length}`, ms: Date.now() - start };
    }

    // 2) compute KC(20, 1.5) → Min %KC over window
    const highs = mainKlines.map((k) => k.high);
    const lows = mainKlines.map((k) => k.low);
    const closes = mainKlines.map((k) => k.close);
    const kc = indicators.keltnerChannel(highs, lows, closes, 20, 1.5);
    const kcWidths = kc.width.filter((w) => w != null && Number.isFinite(w));
    const kcMinPct = kcWidths.length ? Math.min(...kcWidths) : 0;

    // 3) upper-TF trend
    const trendTF = volatilityScanner.TREND_TF_MAP[bot.timeframe] || null;
    let trend = {
      trendTF,
      trendEma20: null,
      trendLastClose: closes[closes.length - 1],
      trendGapPct: null,
      trendState: 'warmup',
    };
    if (trendTF && trendTF !== bot.timeframe) {
      try {
        const rawTrend = await binanceRest.getKlines({
          symbol: bot.symbol, interval: trendTF, limit: 30,
        });
        const trendKlines = rawTrend.map((k) => ({
          openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
          low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
          closeTime: k[6],
        }));
        trend = volatilityScanner.computeTrend(trendKlines, trendTF);
      } catch (err) {
        logger.warn({ botId: bot._id.toString(), symbol: bot.symbol, tf: bot.timeframe, trendTF, err: err.message }, 'tpUpdater: trend fetch failed — using warmup');
      }
    }

    // 4) suggestedTpPct = upper → minKC/4, lower → minKC/8, warmup → null
    // FIX-2026-07-23: ลบ round-trip fee ทันที — user ต้องการเก็บ NET value ใน bot.tpPercent
    //   - trader.calcSellPrice() จะ +2*feeRate กลับตอนวาง SELL → sell target = gross → net = tpPercent เดิมหลังหัก fee
    //   - ดู logic เดียวกันใน src/api/routes/bot.routes.js (POST /suggest-tp)
    const feeRate = fees.getMakerRate();
    const feeBufferPct = Number((feeRate * 2 * 100).toFixed(4)); // 0.2 (off) หรือ 0.15 (BNB on)
    const rawSuggestedTpPct = trend.trendState === 'warmup' || !kcMinPct
      ? null
      : (trend.trendState === 'upper' ? kcMinPct / 4 : kcMinPct / 8);
    const netSuggestedTpPct = rawSuggestedTpPct == null
      ? null
      : Math.max(0, rawSuggestedTpPct - feeBufferPct);
    // FIX-2026-08-02: auto-floor — ถ้า NET TP ต่ำเกินไป (< 0.281%) → override เป็น 0.281%
    //   - ใช้กับบอทที่ autoUpdateTp=true เพื่อให้ยัง trade ได้ใน low-volatility regime
    const floored = applyMinNetTpFloor(netSuggestedTpPct);
    const suggestedTpPct = floored.value == null ? null : formatTpToXxx1(floored.value);

    return {
      suggestedTpPct,
      rawSuggestedTpPct,
      feeBufferPct,
      kcMinPct,
      trendTF: trend.trendTF,
      trendState: trend.trendState,
      trendGapPct: trend.trendGapPct,
      lastClose: closes[closes.length - 1],
      ms: Date.now() - start,
      // FIX-2026-07-28: surface override info ให้ caller ใช้ (UI tooltip + log)
      tpOverridden: floored.overridden,
      rawNetBeforeOverride: floored.rawNetBeforeOverride,
      tpFloorThreshold: TP_FLOOR_THRESHOLD_PCT,
      tpFloorOverride: TP_FLOOR_OVERRIDE_PCT,
    };
  } catch (err) {
    return { error: err.message, ms: Date.now() - start };
  }
}

/**
 * Run TP update สำหรับบอทที่ autoUpdateTp=true
 *   - query DB ทุกครั้ง (รองรับ enable/disable toggle ตอน runtime)
 *   - per-bot try/catch กัน error 1 ตัวไม่กระทบบอทอื่น
 *   - ถ้า suggestedTpPct เท่ากับ bot.tpPercent เดิม → skip update (กัน spam DB)
 *   - return { updated: N, skipped: N, failed: N }
 */
async function runTpUpdateForAllEligibleBots() {
  const startAll = Date.now();
  const bots = await Bot.find({ autoUpdateTp: true }).lean();
  if (!bots.length) {
    return { updated: 0, skipped: 0, failed: 0 };
  }
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  for (const bot of bots) {
    const botId = bot._id.toString();
    try {
      const calc = await computeSuggestedTpForBot(bot);
      if (calc.error) {
        logger.warn({ botId, symbol: bot.symbol, tf: bot.timeframe, err: calc.error }, 'tpUpdater: compute failed — skip');
        failed += 1;
        continue;
      }
      if (calc.suggestedTpPct == null) {
        // warmup → ยังไม่ commit (กัน tpPercent กลายเป็น null)
        logger.info({ botId, symbol: bot.symbol, tf: bot.timeframe, trendTF: calc.trendTF }, 'tpUpdater: trend warmup — skip');
        skipped += 1;
        continue;
      }
      // tolerance 1e-9 — ป้องกัน floating point drift
      if (Math.abs((calc.suggestedTpPct - (bot.tpPercent || 0))) < 1e-9) {
        // ยังไม่เปลี่ยน → อัพเดทแค่ updateTpAt (เพื่อให้ UI เห็นว่า tick แล้ว) — เลือกไม่อัพเดทเพื่อลด write
        logger.debug({ botId, symbol: bot.symbol, tf: bot.timeframe, tp: calc.suggestedTpPct }, 'tpUpdater: TP unchanged — skip');
        // FIX-2026-07-26: แม้ TP ไม่เปลี่ยน → ยังเช็ค low TP warning (อาจเคยแจ้งแล้ว)
        checkAndEmitLowTp(bot, calc.suggestedTpPct);
        // FIX-2026-07-28: sync tpOnFloor flag (rare — happens เมื่อ floor threshold flip จาก off→on ใน tick เดียวกัน)
        //   - ถ้า calc.tpOverridden !== bot.tpOnFloor → fix flag ให้ตรง
        const expectedFloor = !!calc.tpOverridden;
        if (!!bot.tpOnFloor !== expectedFloor) {
          await Bot.updateOne({ _id: bot._id }, { $set: { tpOnFloor: expectedFloor } });
          logger.info({ botId, symbol: bot.symbol, tpOnFloor: expectedFloor }, 'tpUpdater: tpOnFloor flag synced (no TP value change)');
        }
        skipped += 1;
        continue;
      }
      const oldTp = bot.tpPercent;
      // FIX-2026-07-28: persist tpOnFloor flag ตามสถานะ override ปัจจุบัน (UI ใช้แสดง badge)
      await Bot.updateOne(
        { _id: bot._id },
        {
          $set: {
            tpPercent: calc.suggestedTpPct,
            updateTpAt: Date.now(),
            tpOnFloor: !!calc.tpOverridden,
          },
        }
      );
      // FIX-2026-08-02: invalidate per-bot volatility snapshot cache ด้วย
      //   - volSuggestedTpPct ที่ UI แสดงใน tile "TP แนะนำ % (NET)" มาจาก volatilityForBot
      //   - ถ้าไม่ invalidate → UI แสดง TP เก่าจนกว่า 60s TTL จะหมด
      try {
        const volatilityForBot = require('./volatilityForBot');
        volatilityForBot.invalidate(bot.symbol, bot.timeframe);
      } catch (_) { /* volatilityForBot may not be loaded in this context */ }
      // FIX-2026-07-28: log เมื่อ auto-floor ทำงาน (NET TP ต่ำกว่า threshold)
      const logMsg = calc.tpOverridden ? 'tpUpdater: TP updated (auto-floor applied)' : 'tpUpdater: TP updated';
      logger.info({
        botId, symbol: bot.symbol, tf: bot.timeframe,
        oldTp, newTp: calc.suggestedTpPct,
        trendTF: calc.trendTF, trendState: calc.trendState,
        kcMinPct: calc.kcMinPct, ms: calc.ms,
        ...(calc.tpOverridden ? {
          rawNetBeforeOverride: calc.rawNetBeforeOverride,
          tpFloorThreshold: calc.tpFloorThreshold,
          tpFloorOverride: calc.tpFloorOverride,
        } : {}),
      }, logMsg);
      // FIX-2026-07-26: emit tp:low หลัง update (NET TP ต่ำกว่า threshold → แจ้ง Telegram)
      checkAndEmitLowTp(bot, calc.suggestedTpPct);
      updated += 1;
    } catch (err) {
      logger.error({ botId, err: err.message }, 'tpUpdater: update loop error');
      failed += 1;
    }
  }
  const msAll = Date.now() - startAll;
  logger.info({ botCount: bots.length, updated, skipped, failed, ms: msAll }, 'tpUpdater: tick complete');
  return { updated, skipped, failed };
}

// FIX-2026-07-26: per-bot anti-spam latch — แจ้ง tp:low ครั้งเดียว จนกว่า TP จะ recover เกิน threshold
//   - ใช้ Map<botId, bool> ในหน่วยความจำ
//   - ถ้า tp < threshold && !notified → emit + set true
//   - ถ้า tp >= threshold → reset false (ให้แจ้งใหม่ได้หากกลับมาต่ำอีก)
const tpLowNotified = new Map(); // botId → bool

function checkAndEmitLowTp(bot, suggestedTpPct) {
  const botId = bot._id.toString();
  if (suggestedTpPct == null || !Number.isFinite(suggestedTpPct)) return;
  const isLow = suggestedTpPct < TP_LOW_PNL_THRESHOLD_PCT;
  const wasNotified = tpLowNotified.get(botId) === true;

  if (isLow && !wasNotified) {
    tpLowNotified.set(botId, true);
    eventBus.emit('tp:low', {
      botId: bot._id,
      botName: bot.name,
      symbol: bot.symbol,
      timeframe: bot.timeframe,
      tpPct: suggestedTpPct,
      threshold: TP_LOW_PNL_THRESHOLD_PCT,
      autoUpdateTp: bot.autoUpdateTp,
    });
    logger.info({
      botId, symbol: bot.symbol, tpPct: suggestedTpPct, threshold: TP_LOW_PNL_THRESHOLD_PCT,
    }, 'tpUpdater: NET TP below threshold — emit tp:low warning');
  } else if (!isLow && wasNotified) {
    // recover → reset latch
    tpLowNotified.set(botId, false);
    logger.info({ botId, symbol: bot.symbol, tpPct: suggestedTpPct }, 'tpUpdater: TP recovered above threshold — reset tp:low latch');
  }
}

/**
 * Schedule a setInterval that runs every 60s and triggers runTpUpdateForAllEligibleBots()
 * เมื่อถึง top-of-hour (HH:00:00 local time)
 *
 * design choices:
 *   - tick = 60s (ไม่ถี่เกินไป — Binance API quota + ลด DB query)
 *   - trigger condition: minute===0 → run (guard inFlight กัน overlap)
 *   - guard lastFiredHour: กัน run ซ้ำ 2 ครั้งในชั่วโมงเดียวกัน (เผื่อ setInterval drift)
 *   - หยุด timer ผ่าน stopHourlyTpUpdate() — เรียกจาก botManager.stop()
 */
const TP_TICK_INTERVAL_MS = 60 * 1000;

let tpUpdateTimer = null;
let tpUpdateInFlight = false;
let lastFiredHour = -1; // hh ของรอบที่ run ไปแล้ว — กันซ้ำ

function isTopOfHour(date) {
  return date.getMinutes() === 0;
}

function scheduleHourlyTpUpdate() {
  if (tpUpdateTimer) {
    logger.warn('tpUpdater: timer already scheduled — skip');
    return;
  }
  logger.info({ intervalMs: TP_TICK_INTERVAL_MS }, 'tpUpdater: hourly timer scheduled');
  tpUpdateTimer = setInterval(() => {
    if (tpUpdateInFlight) return;
    const now = new Date();
    if (!isTopOfHour(now)) return;
    if (lastFiredHour === now.getHours()) return; // กัน drift/run ซ้ำ
    lastFiredHour = now.getHours();
    tpUpdateInFlight = true;
    runTpUpdateForAllEligibleBots()
      .catch((err) => logger.error({ err: err.message }, 'tpUpdater: tick failed'))
      .finally(() => { tpUpdateInFlight = false; });
  }, TP_TICK_INTERVAL_MS);
}

function stopHourlyTpUpdate() {
  if (tpUpdateTimer) {
    clearInterval(tpUpdateTimer);
    tpUpdateTimer = null;
    logger.info('tpUpdater: hourly timer stopped');
  }
  lastFiredHour = -1;
}

module.exports = {
  formatTpToXxx1,
  applyMinNetTpFloor, // FIX-2026-07-28: ให้ suggest-tp route reuse floor logic
  computeSuggestedTpForBot,
  runTpUpdateForAllEligibleBots,
  scheduleHourlyTpUpdate,
  stopHourlyTpUpdate,
};
