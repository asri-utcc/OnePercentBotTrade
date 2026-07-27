'use strict';

// FIX-2026-07-24: Trade + Signal history aggregation
//   - GET /api/history?kind=trades|signals|both&botId=&from=&to=&limit=&offset=&tradeStates=&signalOutcomes=
//   - GET /api/history/stats?date=YYYY-MM-DD
//   - Signals filter ตาม currently-enabled bots เสมอ (per user req: "signal history นับจากตัวที่เปิด บอท เท่านั้น")
//   - Trades รวมทุกบอท (รวม force-close / manual close paths)
//   - Stats ใช้ Trade.aggregate + Signal.aggregate (Promise.all)
// FIX-2026-07-24 (filter): เพิ่ม tradeStates + signalOutcomes CSV query
//   - ถ้าไม่ส่ง → default ซ่อน failed/cancelled (trades) และ failed/skipped (signals)
//   - ถ้าส่ง 'all' → แสดงทั้งหมด
//   - ถ้าส่ง CSV เช่น 'sold,filled,holding' → ใช้ตามนั้น

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Trade = require('../../db/models/Trade');
const Signal = require('../../db/models/Signal');
const Bot = require('../../db/models/Bot');
const { TRADE_STATES } = require('../../db/models/Trade');
const { SIGNAL_OUTCOMES } = require('../../db/models/Signal');

const router = express.Router();

function parseDate(s, endOfDay = false) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return d;
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// FIX-2026-07-24: parse CSV → array of valid enums (silently drop unknowns)
//   - undefined / '' → null (caller ใช้ default)
//   - 'all' → [] (caller ตีความว่า "no filter")
function parseCsvEnum(raw, allowedList) {
  if (raw == null || raw === '') return null;
  const str = String(raw).trim().toLowerCase();
  if (str === 'all' || str === '*') return [];
  const parts = str.split(',').map((p) => p.trim()).filter(Boolean);
  const allowed = new Set(allowedList.map((s) => s.toLowerCase()));
  return parts.filter((p) => allowed.has(p));
}

// GET /api/history?kind=trades|signals|both&botId=&from=&to=&limit=&offset=&tradeStates=&signalOutcomes=
router.get('/', requireAuth, async (req, res) => {
  try {
    const kind = String(req.query.kind || 'both').toLowerCase();
    if (!['trades', 'signals', 'both'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be trades|signals|both' });
    }
    const botId = req.query.botId || null;
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to, true);
    const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

    // FIX-2026-07-24: parse filter CSVs
    //   - null → caller ใช้ default
    //   - [] (length 0 จาก 'all') → ไม่ filter
    //   - [...] (length > 0) → $in
    const tradeStatesRaw = parseCsvEnum(req.query.tradeStates, TRADE_STATES);
    const signalOutcomesRaw = parseCsvEnum(req.query.signalOutcomes, SIGNAL_OUTCOMES);
    // FIX-2026-07-24: default = hide failed/cancelled (trades) + failed/skipped (signals)
    //   ใช้แบบ explicit default เพื่อให้ client เห็นว่า filter ทำงาน
    const DEFAULT_HIDE_TRADE = ['failed', 'cancelled'];
    const DEFAULT_HIDE_SIGNAL = ['failed', 'skipped'];
    const tradeStates = tradeStatesRaw === null
      ? TRADE_STATES.filter((s) => !DEFAULT_HIDE_TRADE.includes(s))
      : tradeStatesRaw;
    const signalOutcomes = signalOutcomesRaw === null
      ? SIGNAL_OUTCOMES.filter((s) => !DEFAULT_HIDE_SIGNAL.includes(s))
      : signalOutcomesRaw;

    // Signals: per user req — ALWAYS filter to currently-enabled bots
    // (แม้ user จะเลือก botId เฉพาะ ก็ต้องเป็น enabled อยู่)
    const enabledBots = await Bot.find({ enabled: true }, '_id name symbol').lean();
    const enabledIds = enabledBots.map((b) => b._id);
    const enabledMap = new Map(enabledBots.map((b) => [String(b._id), b]));

    let trades = [];
    let signals = [];

    if (kind === 'trades' || kind === 'both') {
      const q = {};
      if (botId) q.botId = botId;
      if (from || to) {
        q.createdAt = {};
        if (from) q.createdAt.$gte = from;
        if (to) q.createdAt.$lte = to;
      }
      // FIX-2026-07-24: apply tradeStates filter
      if (tradeStates.length > 0) q.state = { $in: tradeStates };
      trades = await Trade.find(q)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean();
    }

    if (kind === 'signals' || kind === 'both') {
      const q = { botId: { $in: enabledIds } };
      if (botId) {
        // ถ้า user เลือก botId เฉพาะ ต้องเป็น enabled เท่านั้น
        if (!enabledMap.has(String(botId))) {
          q.botId = { $in: [] }; // ไม่มีข้อมูล
        } else {
          q.botId = botId;
        }
      }
      if (from || to) {
        q.candleCloseTime = {};
        if (from) q.candleCloseTime.$gte = from;
        if (to) q.candleCloseTime.$lte = to;
      }
      // FIX-2026-07-24: apply signalOutcomes filter
      if (signalOutcomes.length > 0) q.outcome = { $in: signalOutcomes };
      signals = await Signal.find(q)
        .sort({ candleCloseTime: -1 })
        .skip(offset)
        .limit(limit)
        .lean();
    }

    let items;
    if (kind === 'both') {
      // Merge by timestamp desc แล้ว slice limit
      const tagged = [
        ...trades.map((t) => ({ ...t, _kind: 'trade', _ts: new Date(t.createdAt).getTime() })),
        ...signals.map((s) => ({ ...s, _kind: 'signal', _ts: new Date(s.candleCloseTime).getTime() })),
      ];
      tagged.sort((a, b) => b._ts - a._ts);
      items = tagged.slice(0, limit);
    } else if (kind === 'trades') {
      items = trades.map((t) => ({ ...t, _kind: 'trade' }));
    } else {
      items = signals.map((s) => ({ ...s, _kind: 'signal' }));
    }

    res.json({
      kind,
      items,
      bots: enabledBots,
      counts: { trades: trades.length, signals: signals.length },
      // FIX-2026-07-24: ส่ง effective filter กลับให้ client (ช่วย debug + UI sync)
      filter: {
        tradeStates,
        signalOutcomes,
        default: {
          trade: DEFAULT_HIDE_TRADE,
          signal: DEFAULT_HIDE_SIGNAL,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history/stats?date=YYYY-MM-DD
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const date = req.query.date || todayISO();
    const start = parseDate(date);
    const end = parseDate(date, true);
    if (!start || !end) {
      return res.status(400).json({ error: 'invalid date (YYYY-MM-DD)' });
    }

    // FIX-2026-07-24: ต้อง await enabledBots ก่อน เพราะ signalAgg ใช้ enabledBots.map(...)
    //   (เดิมใส่ใน Promise.all แต่ .then() closure รัน TDZ → ReferenceError)
    const enabledBots = await Bot.find({ enabled: true }, '_id').lean();

    const [tradeAgg, signalAgg] = await Promise.all([
      Trade.aggregate([
        { $match: { sellFilledAt: { $gte: start, $lte: end }, realizedPnl: { $ne: null } } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            pnl: { $sum: '$realizedPnl' },
            wins: { $sum: { $cond: [{ $gt: ['$realizedPnl', 0] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $lt: ['$realizedPnl', 0] }, 1, 0] } },
          },
        },
      ]),
      Signal.aggregate([
        {
          $match: {
            candleCloseTime: { $gte: start, $lte: end },
            botId: { $in: enabledBots.map((b) => b._id) },
          },
        },
        {
          $group: {
            _id: '$outcome',
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const t = (tradeAgg && tradeAgg[0]) || { count: 0, pnl: 0, wins: 0, losses: 0 };
    const sMap = Object.fromEntries((signalAgg || []).map((r) => [r._id || 'unknown', r.count]));

    res.json({
      date,
      trades: {
        count: t.count,
        pnl: Number(t.pnl.toFixed ? t.pnl.toFixed(4) : t.pnl),
        wins: t.wins,
        losses: t.losses,
      },
      signals: {
        detected: sMap.detected || 0,
        placed: sMap.order_placed || 0,
        filled: sMap.filled || 0,
        skipped: sMap.skipped || 0,
        expired: sMap.expired || 0,
        failed: sMap.failed || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
