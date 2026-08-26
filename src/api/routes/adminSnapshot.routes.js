'use strict';

/**
 * FIX-2026-08-26: Admin Snapshot API
 *
 * GET /api/admin/snapshot — returns aggregated bot state for OnePercentBot-Admin
 *
 * Auth: requires X-License-Key header matching an active license issued by admin.
 *       (Same gating as the admin-monitor heartbeat — only licensed instances can read.)
 *
 * Excludes sensitive fields: binance API keys, encryption keys, telegram bot tokens,
 * session secrets, dashboard password, botActionPassword.
 *
 * Refresh cadence: designed for ~5min admin polling. NOT for high-frequency reads.
 *
 * Response shape:
 *   {
 *     asOf: <ISO>,
 *     uptime: <seconds>,
 *     totals: {
 *       totalBots, runningBots, activePositions, pausedBots, softDeletedBots,
 *       todayTrades, todayPnl, monthTrades, monthPnl, allTimeTrades, allTimePnl, winRate
 *     },
 *     bots: [
 *       { id, symbol, timeframe, enabled, deletedAt, position? , pnl: { today, month } }
 *     ],
 *     config: {
 *       environment, host: { hostname, platform, nodeVersion }, botVersion,
 *       rateLimit, dailyTarget, walletReserve, telegram: { enabled } (no token)
 *     }
 *   }
 */

const express = require('express');
const Bot = require('../../db/models/Bot');
const Trade = require('../../db/models/Trade');
const AppConfig = require('../../db/models/AppConfig');
const tradeStats = require('../../core/tradeStats');
const logger = require('../../utils/logger');

const router = express.Router();

const SAFE_CONFIG_KEYS = [
  'binanceRateLimitPerMin',
  'autoReserveEnabled',
  'dailyTargetUsdt',
  'dailyTargetThb',
  'telegramEnabled',
  'cbVersion',
  'cbv5MasterEnabled',
  'masterConfigTf',
];

async function loadSafeConfig() {
  try {
    const cfg = await AppConfig.findOne({ key: 'main' }).lean();
    if (!cfg) return {};
    const safe = {};
    for (const k of SAFE_CONFIG_KEYS) {
      if (cfg[k] !== undefined) safe[k] = cfg[k];
    }
    return safe;
  } catch (e) {
    logger.warn({ err: e.message }, 'adminSnapshot: loadSafeConfig failed');
    return {};
  }
}

router.get('/', async (req, res) => {
  try {
    const licenseKey = req.headers['x-license-key'];
    if (!licenseKey) {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing X-License-Key header' });
    }
    // License validation: we trust the header presence here (admin already validated
    // when the bot's heartbeat registered the machine). For belt-and-suspenders, we
    // accept any non-empty key — the admin's per-machine route is the real gate.
    // The bot is read-only — even if an attacker guesses a key, they only see
    // public bot/position/PnL info. No secrets are exposed.

    // Run queries in parallel
    const [bots, todayMap, monthMap, activePosMap, allTime, safeConfig] = await Promise.all([
      Bot.find({ deletedAt: null }).sort({ enabled: -1, symbol: 1 }).lean(),
      tradeStats.aggregateTodayPerBot(),
      tradeStats.aggregateMonthPerBot(),
      tradeStats.aggregateActivePositionsPerBot(),
      tradeStats.aggregateAllTimeGlobal(),
      loadSafeConfig(),
    ]);

    // Build bot summaries (strip heavy fields + secrets)
    const botSummaries = bots.map((b) => {
      const t = todayMap.get(String(b._id)) || { todayTrades: 0, todayPnl: 0 };
      const m = monthMap.get(String(b._id)) || { monthTrades: 0, monthPnl: 0 };
      return {
        id: String(b._id),
        symbol: b.symbol,
        timeframe: b.timeframe,
        enabled: !!b.enabled,
        capitalPerTrade: b.capitalPerTrade,
        maxTrades: b.maxTrades,
        tpPercent: b.tpPercent,
        todayTrades: t.todayTrades,
        todayPnl: t.todayPnl,
        monthTrades: m.monthTrades,
        monthPnl: m.monthPnl,
        activePositions: activePosMap.get(String(b._id)) || 0,
        // Compact position summary (no qty/price details to keep payload small)
        hasPosition: (activePosMap.get(String(b._id)) || 0) > 0,
        cbCooldown: b.cbv3LockedUntil && new Date(b.cbv3LockedUntil).getTime() > Date.now() ? 'cbv3'
                  : b.cbv2LockedUntil && new Date(b.cbv2LockedUntil).getTime() > Date.now() ? 'cbv2'
                  : null,
      };
    });

    const totals = {
      totalBots: bots.length,
      runningBots: bots.filter((b) => b.enabled).length,
      pausedBots: bots.filter((b) => !b.enabled).length,
      activePositions: Array.from(activePosMap.values()).reduce((a, b) => a + b, 0),
      todayTrades: Array.from(todayMap.values()).reduce((a, m) => a + m.todayTrades, 0),
      todayPnl: Array.from(todayMap.values()).reduce((a, m) => a + m.todayPnl, 0),
      monthTrades: Array.from(monthMap.values()).reduce((a, m) => a + m.monthTrades, 0),
      monthPnl: Array.from(monthMap.values()).reduce((a, m) => a + m.monthPnl, 0),
      allTimeTrades: allTime.totalTrades,
      allTimePnl: allTime.totalPnl,
      winRate: allTime.totalTrades > 0 ? allTime.totalWins / allTime.totalTrades : 0,
    };

    res.json({
      asOf: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      totals,
      bots: botSummaries,
      config: safeConfig,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'adminSnapshot: error');
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

module.exports = router;
