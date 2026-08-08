'use strict';

// 2026-08-06: Daily Profit Target gauge (radial gauge below navbar)
//   - GET  /api/daily-target  → { targetThb, todayPnlUsdt, todayPnlThb, pct, zone, ... }
//   - PUT  /api/daily-target  → { targetThb }
//   - pct = clamp(todayPnlThb / targetThb * 100, -100..+200)
//   - zone:
//       'achieved' pct >= 100           (🎉 rainbow shimmer)
//       'hot'      pct >= 70  && < 100  (bull green glow)
//       'warming'  pct >= 30  && < 70   (gold)
//       'cold'     pct >= 0   && < 30   (steel-blue slate)
//       'loss'     pct < 0             (warm red, fill goes backwards)
//
// Asia/Bangkok day boundary (00:00 local) — same convention as pnl.routes.js

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Trade = require('../../db/models/Trade');
const AppConfig = require('../../db/models/AppConfig');
const fxService = require('../../services/fxService');
const logger = require('../../utils/logger');

const router = express.Router();

const TARGET_DEFAULT = 100;
const TARGET_MIN = 1;
const TARGET_MAX = 1_000_000;

function startOfTodayBkk() {
  // FIX-2026-08-08: Asia/Bangkok day boundary (00:00 local) — server-TZ independent.
  //   Previous version used `now.getTimezoneOffset()` which made bkkMs collapse
  //   back to T (no-op), so `bkk.getUTCDate()` returned the UTC date — not the
  //   BKK date — during 00:00–06:59 BKK. Result: startOfTodayBkk() returned
  //   YESTERDAY's BKK midnight and the daily-target gauge showed yesterday's
  //   PnL throughout the early BKK morning.
  //   Now: convert UTC ms → BKK clock directly with a fixed +7h offset.
  const now = new Date();
  const bkkMs = now.getTime() + 7 * 60 * 60_000;
  const bkk = new Date(bkkMs);
  // Construct 00:00:00 BKK in absolute time
  const startUtcMs = Date.UTC(
    bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate(),
    -7, 0, 0
  );
  return new Date(startUtcMs);
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean().catch(() => null);
    const targetThb = (cfg && Number(cfg.dailyTargetThb) >= TARGET_MIN)
      ? Number(cfg.dailyTargetThb)
      : TARGET_DEFAULT;

    const since = startOfTodayBkk();
    const rows = await Trade.aggregate([
      { $match: { sellFilledAt: { $gte: since }, realizedPnl: { $ne: null } } },
      {
        $group: {
          _id: null,
          todayTrades:      { $sum: 1 },
          todayPnlUsdt:     { $sum: '$realizedPnl' },
          todayWins:        { $sum: { $cond: [{ $gt: ['$realizedPnl', 0] }, 1, 0] } },
          todayLosses:      { $sum: { $cond: [{ $lt: ['$realizedPnl', 0] }, 1, 0] } },
          todayGrossProfit: { $sum: { $cond: [{ $gt: ['$realizedPnl', 0] }, '$realizedPnl', 0] } },
          todayGrossLoss:   { $sum: { $cond: [{ $lt: ['$realizedPnl', 0] }, '$realizedPnl', 0] } },
        },
      },
    ]);
    const agg = rows[0] || {
      todayTrades: 0, todayPnlUsdt: 0, todayWins: 0, todayLosses: 0,
      todayGrossProfit: 0, todayGrossLoss: 0,
    };

    // USDT→THB conversion via fxService (cached, returns { rate, source, ... })
    const fxObj = await fxService.getUsdtToThb().catch(() => null);
    const fxRate = fxObj && Number(fxObj.rate) > 0 ? Number(fxObj.rate) : null;
    const todayPnlThb = (agg.todayPnlUsdt || 0) * (fxRate || 0);

    // pct of THB target — clamped -100..+200 so the radial stays visually balanced
    // (negative shows "we owe X baht" on the loss side)
    const pctRaw = targetThb > 0 ? (todayPnlThb / targetThb) * 100 : 0;
    const pct = Math.max(-100, Math.min(200, pctRaw));

    // zone
    let zone = 'cold';
    if (pct >= 100) zone = 'achieved';
    else if (pct >= 70) zone = 'hot';
    else if (pct >= 30) zone = 'warming';
    else if (pct >= 0)  zone = 'cold';
    else zone = 'loss';

    const remainingThb = targetThb - todayPnlThb; // >0 = need more, <0 = surplus

    res.json({
      targetThb,
      todayPnlUsdt:  Number((agg.todayPnlUsdt || 0).toFixed(4)),
      todayPnlThb:   Number(todayPnlThb.toFixed(2)),
      fxRate:        fxRate || null,
      pct:           Number(pct.toFixed(2)),
      zone,
      remainingThb:  Number(remainingThb.toFixed(2)),
      todayTrades:   agg.todayTrades,
      todayWins:     agg.todayWins,
      todayLosses:   agg.todayLosses,
      winRate:       agg.todayTrades
        ? Number(((agg.todayWins / agg.todayTrades) * 100).toFixed(1))
        : 0,
      todayGrossProfit: Number((agg.todayGrossProfit || 0).toFixed(4)),
      todayGrossLoss:   Number((agg.todayGrossLoss || 0).toFixed(4)),
      // BKK midnight ISO — UI can show "rolls over at …"
      dayBoundaryBkk: since.toISOString(),
      ts: Date.now(),
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'dailyTarget: GET failed');
    res.status(500).json({ error: err.message });
  }
});

router.put('/', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const targetThb = Number(body.targetThb);
    if (!Number.isFinite(targetThb) || targetThb < TARGET_MIN || targetThb > TARGET_MAX) {
      return res.status(400).json({
        error: `targetThb must be between ${TARGET_MIN} and ${TARGET_MAX}`,
      });
    }
    await AppConfig.updateOne(
      { key: 'singleton' },
      { $set: { dailyTargetThb: targetThb } },
      { upsert: true }
    );
    res.json({ ok: true, targetThb });
  } catch (err) {
    logger.error({ err: err.message }, 'dailyTarget: PUT failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;