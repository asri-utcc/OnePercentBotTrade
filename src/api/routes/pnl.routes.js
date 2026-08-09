'use strict';

// FIX-2026-07-29: PnL Calendar + PnL Chart API
//   - GET /api/pnl/calendar?year=YYYY&month=M&botId=
//     Daily aggregation per day (Asia/Bangkok timezone) for month grid heatmap
//   - GET /api/pnl/series?from=&to=&botId=
//     Sorted ascending trades — client computes cumulative USDT/THB

const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Trade = require('../../db/models/Trade');
const Bot = require('../../db/models/Bot');
const logger = require('../../utils/logger');

const router = express.Router();

// FIX-2026-07-29: parseDate helper (copy จาก history.routes.js:24-31 เพื่อหลีกเลี่ยง circular import)
function parseDate(s, endOfDay = false) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return d;
}

// ─── GET /api/pnl/calendar ────────────────────────────
// Query: ?year=YYYY&month=1..12&botId=<optional>
router.get('/calendar', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const month = parseInt(req.query.month, 10) || (now.getMonth() + 1); // 1..12
    const botId = req.query.botId || null;

    if (month < 1 || month > 12) {
      return res.status(400).json({ error: 'month must be 1..12' });
    }

    // month range (local TZ) — first day 00:00:00 → last day 23:59:59.999
    const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const end = new Date(year, month, 0, 23, 59, 59, 999);

    const match = {
      sellFilledAt: { $gte: start, $lte: end },
      realizedPnl: { $ne: null },
    };
    if (botId && mongoose.Types.ObjectId.isValid(botId)) {
      match.botId = new mongoose.Types.ObjectId(botId);
    }

    const rows = await Trade.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$sellFilledAt',
              timezone: 'Asia/Bangkok',
            },
          },
          pnl: { $sum: '$realizedPnl' },
          // FIX-2026-08-01: แยก gross profit vs gross loss (mirror frontend UX request)
          //   - grossProfit: sum ของ realizedPnl > 0 (only winning trades)
          //   - grossLoss: sum ของ realizedPnl < 0 (absolute value ไม่ใส่ - — เก็บเป็นลบเพื่อความง่าย)
          //   - verify: grossProfit + grossLoss ≈ pnl (จะตรงเสมอเพราะ sum ของค่าทั้งสองกลุ่ม = sum ใหญ่)
          grossProfit: {
            $sum: { $cond: [{ $gt: ['$realizedPnl', 0] }, '$realizedPnl', 0] },
          },
          grossLoss: {
            $sum: { $cond: [{ $lt: ['$realizedPnl', 0] }, '$realizedPnl', 0] },
          },
          trades: { $sum: 1 },
          wins: { $sum: { $cond: [{ $gt: ['$realizedPnl', 0] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $lt: ['$realizedPnl', 0] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Fill missing days with zeros (so calendar grid ครบทุกวัน)
    const daysInMonth = new Date(year, month, 0).getDate();
    const map = new Map(rows.map((r) => [r._id, r]));
    const result = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const row = map.get(dateStr);
      result.push({
        date: dateStr,
        pnl: row ? Number(row.pnl.toFixed(4)) : 0,
        // FIX-2026-08-01: grossProfit + grossLoss (per-day)
        grossProfit: row ? Number(row.grossProfit.toFixed(4)) : 0,
        grossLoss: row ? Number(row.grossLoss.toFixed(4)) : 0, // negative number
        trades: row ? row.trades : 0,
        wins: row ? row.wins : 0,
        losses: row ? row.losses : 0,
      });
    }

    // totals + best/worst day
    const totals = result.reduce(
      (a, d) => ({
        pnl: a.pnl + d.pnl,
        grossProfit: a.grossProfit + d.grossProfit,
        grossLoss: a.grossLoss + d.grossLoss, // sum of negatives
        trades: a.trades + d.trades,
        wins: a.wins + d.wins,
        losses: a.losses + d.losses,
      }),
      { pnl: 0, grossProfit: 0, grossLoss: 0, trades: 0, wins: 0, losses: 0 },
    );
    const tradeDays = result.filter((d) => d.trades > 0);
    const best = tradeDays.length
      ? tradeDays.reduce((a, b) => (b.pnl > a.pnl ? b : a))
      : null;
    const worst = tradeDays.length
      ? tradeDays.reduce((a, b) => (b.pnl < a.pnl ? b : a))
      : null;

    res.json({
      year,
      month,
      botId: botId || null,
      days: result,
      totals: {
        pnl: Number(totals.pnl.toFixed(4)),
        // FIX-2026-08-01: grossProfit + grossLoss (totals) — grossLoss คงเป็นลบ
        grossProfit: Number(totals.grossProfit.toFixed(4)),
        grossLoss: Number(totals.grossLoss.toFixed(4)),
        trades: totals.trades,
        wins: totals.wins,
        losses: totals.losses,
        winRate: totals.trades
          ? Number(((totals.wins / totals.trades) * 100).toFixed(1))
          : 0,
        // FIX-2026-08-01: avgWin / avgLoss per trade (เฉพ่ยต่อไม้)
        //   - avgWin: grossProfit / wins (0 ถ้าไม่มีไม้ชนะ)
        //   - avgLoss: grossLoss / losses (negative, 0 ถ้าไม่มีไม้แพ้)
        avgWin: totals.wins
          ? Number((totals.grossProfit / totals.wins).toFixed(4))
          : 0,
        avgLoss: totals.losses
          ? Number((totals.grossLoss / totals.losses).toFixed(4))
          : 0,
      },
      bestDay: best ? { date: best.date, pnl: best.pnl } : null,
      worstDay: worst ? { date: worst.date, pnl: worst.pnl } : null,
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'pnl.calendar failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/pnl/series ─────────────────────────────
// Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD&botId=<optional>
// Returns sorted ascending trades — client computes cumulative USDT/THB on toggle
router.get('/series', requireAuth, async (req, res) => {
  try {
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to, true);
    if (!from || !to) {
      return res.status(400).json({ error: 'from/to required (YYYY-MM-DD)' });
    }
    if (from > to) {
      return res.status(400).json({ error: 'from must be <= to' });
    }
    const botId = req.query.botId;

    const match = {
      sellFilledAt: { $gte: from, $lte: to },
      realizedPnl: { $ne: null },
    };
    if (botId && mongoose.Types.ObjectId.isValid(botId)) {
      match.botId = new mongoose.Types.ObjectId(botId);
    }

    const trades = await Trade.find(match)
      // FIX-2026-08-09: include sellReason* fields so pnl.html can render pills + tooltip
      .select('_id botId symbol realizedPnl sellFilledAt sellReason sellReasonDetail sellReasonSource sellReasonAt')
      .sort({ sellFilledAt: 1 }) // ascending — chart builds cumulative left→right
      // FIX-2026-08-04: cap with .limit() to prevent unbounded year-range queries (was 10k+ docs JSON-serialized)
      .limit(5000)
      .lean();

    // enrich with bot name (สำหรับ tooltip / drill-down)
    const botIds = [...new Set(trades.map((t) => String(t.botId)))];
    const bots = await Bot.find({ _id: { $in: botIds } }, 'name').lean();
    const botNameMap = Object.fromEntries(bots.map((b) => [String(b._id), b.name]));

    res.json({
      from: req.query.from,
      to: req.query.to,
      botId: botId || null,
      count: trades.length,
      // FIX-2026-08-01: grossProfit + grossLoss + avgWin + avgLoss (เหมือน /day endpoint)
      totals: (() => {
        const grossProfit = trades
          .filter((t) => (t.realizedPnl || 0) > 0)
          .reduce((s, t) => s + t.realizedPnl, 0);
        const grossLoss = trades
          .filter((t) => (t.realizedPnl || 0) < 0)
          .reduce((s, t) => s + t.realizedPnl, 0);
        const wins = trades.filter((t) => (t.realizedPnl || 0) > 0).length;
        const losses = trades.filter((t) => (t.realizedPnl || 0) < 0).length;
        return {
          pnl: Number((grossProfit + grossLoss).toFixed(4)),
          grossProfit: Number(grossProfit.toFixed(4)),
          grossLoss: Number(grossLoss.toFixed(4)),
          wins,
          losses,
          avgWin: wins ? Number((grossProfit / wins).toFixed(4)) : 0,
          avgLoss: losses ? Number((grossLoss / losses).toFixed(4)) : 0,
        };
      })(),
      trades: trades.map((t) => ({
        _id: t._id,
        botId: t.botId,
        botName: botNameMap[String(t.botId)] || '?',
        symbol: t.symbol,
        realizedPnl: t.realizedPnl,
        sellFilledAt: t.sellFilledAt,
        // FIX-2026-08-09: pass through sellReason fields so frontend can render pill + tooltip
        sellReason: t.sellReason || null,
        sellReasonDetail: t.sellReasonDetail || null,
        sellReasonSource: t.sellReasonSource || null,
        sellReasonAt: t.sellReasonAt || null,
      })),
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'pnl.series failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/pnl/day ────────────────────────────────
// Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (same day OK) &botId=<optional>
// FIX-2026-07-29: รายละเอียดเทรดรายวัน (ใช้ตอนคลิก cell ใน calendar)
router.get('/day', requireAuth, async (req, res) => {
  try {
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to, true);
    if (!from || !to) {
      return res.status(400).json({ error: 'from/to required (YYYY-MM-DD)' });
    }
    const botId = req.query.botId;

    const match = {
      sellFilledAt: { $gte: from, $lte: to },
      realizedPnl: { $ne: null },
    };
    if (botId && mongoose.Types.ObjectId.isValid(botId)) {
      match.botId = new mongoose.Types.ObjectId(botId);
    }

    const trades = await Trade.find(match)
      // FIX-2026-08-09: include sellReason* + qty (entry/exit) fields so pnl.html modal can render pills + Entry/Exit Qty columns
      //   - entryQty = buyQty (total bought)
      //   - exitQty = sellFilledQty (actually filled on SELL; partial-fill → < buyQty)
      //   - isPartialSell flag สำหรับบอกผู้ใช้เมื่อ partial-fill
      //   - stackTotalQty / stackBep / dcaLayerCount สำหรับ DCA stack branch (เดิมมีอยู่แล้ว)
      .select('_id botId symbol entryPrice exitPrice qty realizedPnl sellFilledAt side sellReason sellReasonDetail sellReasonSource sellReasonAt buyQty sellFilledQty sellQty isPartialSell isDcaStack stackTotalQty stackBep dcaLayerCount')
      .sort({ sellFilledAt: 1 })
      // FIX-2026-08-04: cap with .limit() to prevent unbounded single-day queries
      .limit(5000)
      .lean();

    const botIds = [...new Set(trades.map((t) => String(t.botId)))];
    const bots = await Bot.find({ _id: { $in: botIds } }, 'name').lean();
    const botNameMap = Object.fromEntries(bots.map((b) => [String(b._id), b.name]));

    res.json({
      from: req.query.from,
      to: req.query.to,
      botId: botId || null,
      count: trades.length,
      // FIX-2026-08-01: grossProfit + grossLoss + avgWin + avgLoss สำหรับ modal summary
      //   - grossProfit: sum ของ realizedPnl > 0
      //   - grossLoss: sum ของ realizedPnl < 0 (คงเป็นลบ)
      //   - wins/losses: นับจำนวนไม้
      totals: (() => {
        const grossProfit = trades
          .filter((t) => (t.realizedPnl || 0) > 0)
          .reduce((s, t) => s + t.realizedPnl, 0);
        const grossLoss = trades
          .filter((t) => (t.realizedPnl || 0) < 0)
          .reduce((s, t) => s + t.realizedPnl, 0);
        const wins = trades.filter((t) => (t.realizedPnl || 0) > 0).length;
        const losses = trades.filter((t) => (t.realizedPnl || 0) < 0).length;
        return {
          pnl: Number((grossProfit + grossLoss).toFixed(4)),
          grossProfit: Number(grossProfit.toFixed(4)),
          grossLoss: Number(grossLoss.toFixed(4)),
          wins,
          losses,
          avgWin: wins ? Number((grossProfit / wins).toFixed(4)) : 0,
          avgLoss: losses ? Number((grossLoss / losses).toFixed(4)) : 0,
        };
      })(),
      trades: trades.map((t) => ({
        _id: t._id,
        botId: t.botId,
        botName: botNameMap[String(t.botId)] || '?',
        symbol: t.symbol,
        side: t.side,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        qty: t.qty,
        realizedPnl: t.realizedPnl,
        sellFilledAt: t.sellFilledAt,
        // FIX-2026-08-09: pass through sellReason fields so pnl.html modal can render pill + tooltip
        sellReason: t.sellReason || null,
        sellReasonDetail: t.sellReasonDetail || null,
        sellReasonSource: t.sellReasonSource || null,
        sellReasonAt: t.sellReasonAt || null,
        // FIX-2026-08-09: Entry/Exit Qty columns for pnl modal (mobile toggle-friendly)
        //   - entryQty = buyQty (total bought)
        //   - exitQty = sellFilledQty (actually filled on SELL; partial-fill → < buyQty)
        //     - falls back to sellQty when sellFilledQty is null (fully-filled trades ส่วนใหญ่)
        //   - DCA stack: stackTotalQty (aggregate of all layers)
        entryQty: t.isDcaStack ? t.stackTotalQty : t.buyQty,
        exitQty: t.sellFilledQty != null ? t.sellFilledQty : t.sellQty,
        sellQtyOrdered: t.sellQty,
        isPartialSell: t.isPartialSell === true || (t.buyQty && t.sellFilledQty && t.sellFilledQty < t.buyQty),
        isDcaStack: t.isDcaStack === true,
        dcaLayerCount: t.dcaLayerCount || null,
        stackBep: t.stackBep || null,
      })),
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'pnl.day failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;