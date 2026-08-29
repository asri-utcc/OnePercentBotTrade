'use strict';

/**
 * FIX-2026-08-08: Feature #5 — Auto Delete Bot (scheduled cleanup)
 *   - reads AppConfig.autoDeleteBotEnabled (default false)
 *   - reads AppConfig.autoDeleteBotDays (default 30, range 7..365)
 *   - reads AppConfig.autoDeleteBotWarningDays (default 3) — แจ้งเตือนล่วงหน้า
 *   - per bot:
 *       * if enabled=false AND no open positions AND (now - bot.enabledAt OR - lastSignalAt) > days
 *         → schedule soft-delete (already running, just set deletedAt)
 *       * warning window: when warningDays remaining → telegram แจ้งเตือน (1 time)
 *   - excludes DCA-stack bots (มี layers รอดำเนินการต่อ)
 *   - excludes bots with open positions
 *   - telemetry: autoDeleteBotLastRunAt + autoDeleteBotLastStats
 *   - hard delete: out of scope (admin cleanup script)
 *   - restore: POST /api/bots/:id/restore (within 30-day window)
 *
 * Usage:
 *   const autoDeleteBot = require('./services/autoDeleteBot');
 *   - autoDeleteBot.start() — start periodic scheduler (called from app.js)
 *   - autoDeleteBot.tick() — run 1 cycle (testable)
 */

const Bot = require('../db/models/Bot');
const AppConfig = require('../db/models/AppConfig');
const Trade = require('../db/models/Trade');
const eventBus = require('./eventBus');
const telegramNotifier = require('./telegramNotifier');
const logger = require('../utils/logger');

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const OPEN_STATES = ['placed', 'partial_wait', 'filled', 'retrying', 'holding', 'selling', 'stopping', 'partial_sell_wait'];
// FIX-2026-08-20: safety caps — prevent mass deletion in a single tick (e.g. after bug fix backlog)
//   - ไม่กระทบ enabled bots / open positions (filter ก่อนหน้าแล้ว) — แค่จำกัด batch size
const MAX_DELETES_PER_TICK = 50;   // up to 50 soft-deletes per tick (clears backlog ภายใน 1-2 รอบ)
const MAX_WARNS_PER_TICK = 20;     // up to 20 warnings per tick (กัน telegram spam)

let _intervalHandle = null;
let _running = false;

function start() {
  if (_intervalHandle) return;
  _intervalHandle = setInterval(() => {
    tick().catch((err) => logger.warn({ err: err.message }, 'autoDeleteBot: tick failed (non-fatal)'));
  }, INTERVAL_MS);
  // Don't prevent process exit
  if (_intervalHandle.unref) _intervalHandle.unref();
  logger.info({ intervalMs: INTERVAL_MS }, 'autoDeleteBot: scheduled (1h interval)');
  // FIX-2026-08-08: run 1 tick 30s after start (avoid boot storm)
  setTimeout(() => {
    tick().catch((err) => logger.warn({ err: err.message }, 'autoDeleteBot: initial tick failed (non-fatal)'));
  }, 30_000);
  if (setTimeout.unref) setTimeout.unref();
}

function stop() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

/**
 * FIX-2026-08-08: tick() — 1 cycle of auto-delete evaluation
 *   - reads AppConfig (master switches + thresholds)
 *   - scans bots that are NOT deleted + enabled=false + DCA-stack-free + no open positions
 *   - for each, computes (now - lastEnabledAt) or (now - createdAt) as "downtime"
 *   - if downtime >= threshold days → soft-delete (set deletedAt)
 *   - if downtime >= (threshold - warningDays) AND no warning sent yet → telegram 1-time alert
 *   - returns stats object
 */
async function tick() {
  if (_running) {
    logger.debug('autoDeleteBot: tick already in progress, skip');
    return { skipped: 'in-progress' };
  }
  _running = true;
  const startedAt = Date.now();
  const stats = {
    scanned: 0,
    scheduled: 0,
    warned: 0,
    skipped_dca: 0,
    skipped_open_positions: 0,
    skipped_enabled: 0,
    skipped_already_deleted: 0,
    skipped_cap: 0, // FIX-2026-08-20: track safety cap hits
    errors: 0,
  };
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (!cfg || cfg.autoDeleteBotEnabled !== true) {
      logger.debug('autoDeleteBot: skip (disabled)');
      await AppConfig.updateOne(
        { key: 'singleton' },
        { $set: { autoDeleteBotLastRunAt: new Date(), autoDeleteBotLastStats: { skipped: 'disabled', ...stats } } }
      );
      return { skipped: 'disabled', ...stats };
    }
    const days = Math.max(7, Math.min(365, parseInt(cfg.autoDeleteBotDays, 10) || 30));
    const warningDays = Math.max(1, Math.min(30, parseInt(cfg.autoDeleteBotWarningDays, 10) || 3));
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const warningCutoffMs = Date.now() - (days - warningDays) * 24 * 60 * 60 * 1000;

    // FIX-2026-08-08: candidate bots = not deleted + enabled=false
    //   - exclude DCA stack mode (DCA รอ layer ต่อ — อย่าลบทิ้ง)
    //   - exclude martingale mode (lower priority but similar logic)
    const candidates = await Bot.find({
      deletedAt: null,
      enabled: false,
      dcaEnabled: { $ne: true },
      martingaleEnabled: { $ne: true },
    }).lean();

    stats.scanned = candidates.length;
    for (const b of candidates) {
      try {
        // FIX-2026-08-08: skip if bot has open positions
        const openPos = await Trade.countDocuments({
          botId: b._id,
          state: { $in: OPEN_STATES },
        });
        if (openPos > 0) {
          stats.skipped_open_positions += 1;
          continue;
        }
        // FIX-2026-08-08: compute downtime
        //   - FIX-2026-08-29: use MOST RECENT of (disabledAt, lastSignalAt, enabledAt, createdAt)
        //     Reason: comment line 9 originally listed lastSignalAt as an option but the code
        //     only checked disabledAt. This caused bots that had traded yesterday
        //     (lastSignalAt=yesterday) but were disabled long ago (disabledAt=30d ago) to be
        //     deleted anyway — because the older disabledAt won. A bot that placed orders
        //     yesterday is by definition NOT stale.
        //   - anchor priority (newest wins):
        //       1. lastSignalAt — when bot last placed a signal/order (most reliable activity proxy)
        //       2. disabledAt   — when bot was last disabled
        //       3. enabledAt    — when bot was last enabled
        //       4. createdAt    — last resort (brand-new never-enabled bot)
        const candidates2 = [
          b.lastSignalAt ? new Date(b.lastSignalAt).getTime() : 0,
          b.disabledAt ? new Date(b.disabledAt).getTime() : 0,
          b.enabledAt ? new Date(b.enabledAt).getTime() : 0,
          b.createdAt ? new Date(b.createdAt).getTime() : 0,
        ].filter((t) => t > 0);
        const lastActiveMs = candidates2.length > 0 ? Math.max(...candidates2) : Date.now();
        // FIX-2026-08-08: ignore freshly-disabled bots (< 1 hour) — give minute to recover
        const elapsedMs = Date.now() - lastActiveMs;
        if (elapsedMs < 60 * 60 * 1000) {
          stats.skipped_enabled += 1;
          continue;
        }

        // FIX-2026-08-20: BUG FIX — เดิมใช้ `elapsedMs >= cutoffMs` (เปรียบเทียบ duration �ับ absolute timestamp = false เสมอ)
        //   - elapsedMs = duration in ms (e.g. 22 วัน ≈ 1.9B ms)
        //   - cutoffMs = absolute timestamp (e.g. 2026-08-13 ≈ 1.78T ms)
        //   - ทำให้ soft-delete ไม่เ�ยทำงานเลย (74+ บอท backlog)
        //   - fix: เปรียบเทียบ timestamp กับ timestamp — ถ้า lastActiveMs <= cutoffMs แปลว่า disabled นานเกิน threshold
        if (lastActiveMs <= cutoffMs) {
          // FIX-2026-08-20: safety cap — skip if already hit MAX_DELETES_PER_TICK this round
          if (stats.scheduled >= MAX_DELETES_PER_TICK) {
            stats.skipped_cap += 1;
            continue;
          }
          // FIX-2026-08-08: schedule soft-delete
          await Bot.updateOne(
            { _id: b._id },
            { $set: {
              deletedAt: new Date(),
              scheduledDeleteAt: new Date(),
              status: 'disabled',
            } }
          );
          stats.scheduled += 1;
          eventBus.emit('bot:deleted', { botId: String(b._id), name: b.name, reason: 'auto-delete' });
          logger.info({
            botId: String(b._id),
            name: b.name,
            downtimeDays: Math.floor(elapsedMs / (24 * 60 * 60 * 1000)),
          }, 'autoDeleteBot: soft-deleted (downtime exceeded threshold)');
          // FIX-2026-08-08: telegram notify (1-time on actual delete)
          try {
            await telegramNotifier.sendNow('autoDeleteBotRemoved', {
              botId: String(b._id),
              botName: b.name || b.symbol,
              symbol: b.symbol,
              downtimeDays: Math.floor(elapsedMs / (24 * 60 * 60 * 1000)),
              thresholdDays: days,
            });
          } catch (tgErr) {
            logger.warn({ err: tgErr.message }, 'autoDeleteBot: telegram sendNow failed (non-fatal)');
          }
        } else if (lastActiveMs <= warningCutoffMs && (!b.deleteNotificationSentAt || new Date(b.deleteNotificationSentAt).getTime() < lastActiveMs)) {
          // FIX-2026-08-20: safety cap — skip if already hit MAX_WARNS_PER_TICK this round
          if (stats.warned >= MAX_WARNS_PER_TICK) {
            stats.skipped_cap += 1;
            continue;
          }
          // FIX-2026-08-08: warning window — 1-time telegram alert
          await Bot.updateOne(
            { _id: b._id },
            { $set: { deleteNotificationSentAt: new Date() } }
          );
          stats.warned += 1;
          const remainingDays = Math.ceil((cutoffMs - lastActiveMs) / (24 * 60 * 60 * 1000));
          try {
            await telegramNotifier.sendNow('autoDeleteBotWarning', {
              botId: String(b._id),
              botName: b.name || b.symbol,
              symbol: b.symbol,
              remainingDays,
              downtimeDays: Math.floor(elapsedMs / (24 * 60 * 60 * 1000)),
              thresholdDays: days,
            });
          } catch (tgErr) {
            logger.warn({ err: tgErr.message }, 'autoDeleteBot: telegram warning failed (non-fatal)');
          }
        }
      } catch (perBotErr) {
        stats.errors += 1;
        logger.warn({ botId: String(b._id), err: perBotErr.message }, 'autoDeleteBot: per-bot evaluation failed');
      }
    }
    const ms = Date.now() - startedAt;
    await AppConfig.updateOne(
      { key: 'singleton' },
      { $set: { autoDeleteBotLastRunAt: new Date(), autoDeleteBotLastStats: stats } }
    );
    logger.info({ ms, ...stats }, 'autoDeleteBot: tick completed');
    return stats;
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'autoDeleteBot: tick error');
    return { error: err.message, ...stats };
  } finally {
    _running = false;
  }
}

module.exports = {
  start,
  stop,
  tick,
  // exports for tests
  OPEN_STATES,
  INTERVAL_MS,
};
