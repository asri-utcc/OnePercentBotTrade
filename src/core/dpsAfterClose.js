'use strict';

/**
 * FIX-2026-08-09: DPS loss-path coverage — single source of truth for evaluating
 * Dynamic Position Sizing after ANY SELL fill (not just trader.handleSellFilled).
 * FIX-2026-09-03: layer-removal — DPS now only auto-tunes size (layers owned by separate function)
 *
 * Background (memory: onepercentbot-dps-loss-path-bypass-2026-08-09):
 *   - ก่อนหน้านี้ DPS eval block อยู่ใน trader.handleSellFilled() เท่านั้น
 *   - ทุก force-close path (cbv3_panic, cbv2_panic, sl_ukc_f1_armed, manual_api_market,
 *     market_fallback, manual_api_synthetic) ผ่าน forceClose.js หรือ _emergencyMarketSell
 *   - ผลคือ Rule 3 (แพ้ติดกัน N ไม้ → size -2 USDT) ไม่เคยถูก eval ใน production
 *   - Bot ที่ชนะหลายไม้ติด → size ใหญ่ขึ้นเรื่อยๆ โดยไม่มี auto-rebalance ตอนแพ้
 *
 * Pattern: helper accepts (bot, pnl, pnlPct, source) → look up master config + DPS config
 *   → load fresh bot snapshot → evaluate → persistState → log + telegram (non-blocking).
 *
 * Safety:
 *   - try/catch ครอบทั้งหมด (caller ไม่ต้อง wrap เอง)
 *   - telegram sendNow().catch(...) non-blocking
 *   - persistState แยก write ไม่ block SELL flow
 *   - bot snapshot reload (lean) — กัน stale in-memory data
 *
 * Single entry point: `evaluateDpsAfterClose({ bot, pnl, pnlPct, source })`
 *
 * @param {Object} opts
 * @param {Object} opts.bot - Bot doc or lean (must have _id, name, symbol, timeframe,
 *   dynamicSizeEnabled, dcaEnabled, martingaleEnabled, capitalPerTrade,
 *   dynamicSizeCurrent, dynamicSizeLastResults, dynamicSizeCooldownUntil)
 * @param {number} opts.pnl - Realized PnL (USDT, net of fees) — used for isWin detection
 * @param {number} opts.pnlPct - PnL percent (e.g. -1.23 = -1.23%) — passed to DPS
 * @param {string} [opts.source='unknown'] - Tag for logs (e.g. 'trader:handleSellFilled', 'forceClose:market')
 * @returns {Promise<Object|null>} evalResult from dps.evaluate() or null on error
 */
const dps = require('./dynamicPositionSizing');
const masterConfig = require('./masterConfig');
const logger = require('../utils/logger');
const telegramNotifier = require('../services/telegramNotifier');
const Bot = require('../db/models/Bot');

/**
 * Evaluate DPS after a SELL fill, persist state, log + telegram notify.
 *
 * Contract:
 *   - Returns evalResult (or null on failure) — useful for tests
 *   - Never throws — all errors logged as warn
 *   - Telegram is non-blocking (fire-and-forget)
 *   - Works with both full bot doc and lean object
 */
async function evaluateDpsAfterClose({ bot, pnl, pnlPct, source = 'unknown' }) {
  if (!bot) {
    logger.warn({ source }, 'dpsAfterClose: skipped — no bot');
    return null;
  }
  const botId = bot._id || bot.id;
  if (!botId) {
    logger.warn({ source }, 'dpsAfterClose: skipped — no bot._id');
    return null;
  }

  try {
    // ── 1. Read master + DPS config (30s cache per masterConfig) ─────────────
    const masterToggles = await masterConfig.getMasterToggles();
    const dpsCfg = await masterConfig.getDpsConfig();

    // ── 2. Load fresh bot snapshot (lean) — กัน stale in-memory data ─────────
    //   - botManager orphan path ผ่านมาหลายชั่วโมง → bot.dynamicSizeCurrent อาจล้ำสมัย
    //   - forceClose.js may receive bot from cache that wasn't refreshed
    //   - โหลดใหม่ทุกครั้ง (single round-trip, no aggregation cost) เพื่อ single source of truth
    const botSnap = await Bot.findById(botId).lean();
    if (!botSnap) {
      logger.warn({ botId: botId.toString(), source }, 'dpsAfterClose: bot not found in DB');
      return null;
    }
    // Stamp master switch (per-bot dynamicSizeEnabled takes precedence — checked first by evaluate)
    botSnap._masterDynamicSizeEnabled = masterToggles.masterDynamicSizeEnabled;

    // ── 3. Evaluate ──────────────────────────────────────────────────────────
    const evalResult = dps.evaluate(botSnap, {
      closedAt: new Date(),
      pnlPct: Number.isFinite(pnlPct) ? pnlPct : 0,
      isWin: Number(pnl) > 0,
    }, dpsCfg);

    // ── 4. Persist state (history เสมอ, size เฉพาะ changed) ─────────
    if (Array.isArray(evalResult.newHistory) || evalResult.changed) {
      await dps.persistState(Bot, botId, evalResult);
    }

    // ── 5. Log + telegram ────────────────────────────────────────────────────
    if (evalResult.changed || (evalResult.dryRun && evalResult.wouldChange)) {
      logger.info({
        botId: botId.toString(),
        source,
        reason: evalResult.reason,
        before: evalResult.before,
        after: evalResult.after,
        dryRun: !!evalResult.dryRun,
        pnlPct: Number(pnlPct).toFixed(4),
        isWin: Number(pnl) > 0,
      }, 'dpsAfterClose: size updated');

      // FIX-2026-08-09: include `source` in telegram payload so user sees which path fired
      // FIX-2026-09-03: layer fields removed from telegram payload
      const botName = botSnap.name || botSnap.symbol || botId.toString();
      telegramNotifier.sendNow('dpsResize', {
        botName,
        symbol: botSnap.symbol,
        timeframe: botSnap.timeframe,
        reason: evalResult.reason,
        beforeSize: evalResult.before.size,
        afterSize: evalResult.after.size,
        pnlPct,
        isWin: Number(pnl) > 0,
        dryRun: !!evalResult.dryRun,
        cooldownMinutes: Math.round((dpsCfg.cooldownMs || 0) / 60000),
        minSize: evalResult.bounds && evalResult.bounds.minSize,
        maxSize: evalResult.bounds && evalResult.bounds.maxSize,
        source, // telegram formatter may ignore unknown fields
      }).catch((err) => logger.warn({ err: err.message, botId: botId.toString(), source }, 'dpsAfterClose: telegram sendNow failed'));
    } else if (evalResult.skipped) {
      logger.debug({
        botId: botId.toString(),
        source,
        skipped: evalResult.skipped,
        reason: evalResult.reason,
      }, 'dpsAfterClose: skipped');
    }

    return evalResult;
  } catch (err) {
    logger.warn({
      err: err.message,
      stack: err.stack,
      botId: botId.toString(),
      source,
    }, 'dpsAfterClose: failed (non-fatal)');
    return null;
  }
}

module.exports = {
  evaluateDpsAfterClose,
};
