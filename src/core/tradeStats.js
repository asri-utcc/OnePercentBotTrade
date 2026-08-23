'use strict';

/**
 * FIX-2026-08-20: Trade collection global stats — source of truth for summary tiles
 *   - ใช้แทน sum(b.totalTrades) ในหน้า bots เพราะรวม trades จาก soft-deleted bots ด้วย
 *   - ป้องกัน drift จาก Bot.totalTrades cumulative counter (read-modify-write race)
 *
 * API:
 *   - aggregateAllTimeGlobal(): { totalTrades, totalWins, totalPnl }
 *   - aggregateTodayPerBot(): Map<botIdString, { todayTrades, todayPnl }>
 *   - aggregateMonthPerBot(): Map<botIdString, { monthTrades, monthPnl }>
 *   - aggregateActivePositionsPerBot(): Map<botIdString, count>
 */

const Trade = require('../db/models/Trade');

function startOfTodayLocal() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonthLocal() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * All-time GLOBAL trade stats from Trade collection (source of truth).
 *   - count(state='sold' && realizedPnl != null) = totalTrades (cumulative)
 *   - count(realizedPnl > 0) = totalWins
 *   - sum(realizedPnl) = totalPnl
 *   - includes trades from soft-deleted bots (autoDeleteBot) — ไม่ต้องพึ่ง bot.totalTrades
 *     cumulative counter ที่อาจมี drift และถูก filter ออกเวลา bot ถูก soft-delete
 *   - ใช้กับ summary tiles (Total Trades / Win Rate / Total PnL) ในหน้า bots
 *   - per-bot totalTrades/winTrades/totalPnl ยังคงใช้จาก Bot doc (สำหรับ bot card)
 */
async function aggregateAllTimeGlobal() {
  const rows = await Trade.aggregate([
    { $match: { state: 'sold', realizedPnl: { $ne: null } } },
    {
      $group: {
        _id: null,
        totalTrades: { $sum: 1 },
        totalWins: { $sum: { $cond: [{ $gt: ['$realizedPnl', 0] }, 1, 0] } },
        totalPnl: { $sum: '$realizedPnl' },
      },
    },
  ]);
  const r = rows[0] || { totalTrades: 0, totalWins: 0, totalPnl: 0 };
  return { totalTrades: r.totalTrades, totalWins: r.totalWins, totalPnl: r.totalPnl };
}

/**
 * Aggregate todayTrades + todayPnl grouped by botId.
 * Returns Map<botIdString, { todayTrades, todayPnl }>.
 */
async function aggregateTodayPerBot() {
  const since = startOfTodayLocal();
  const rows = await Trade.aggregate([
    { $match: { sellFilledAt: { $gte: since }, realizedPnl: { $ne: null } } },
    {
      $group: {
        _id: '$botId',
        todayTrades: { $sum: 1 },
        todayPnl: { $sum: '$realizedPnl' },
      },
    },
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), { todayTrades: r.todayTrades, todayPnl: r.todayPnl });
  return map;
}

/**
 * Aggregate monthTrades + monthPnl grouped by botId (since day 1 of current month).
 * Returns Map<botIdString, { monthTrades, monthPnl }>.
 */
async function aggregateMonthPerBot() {
  const since = startOfMonthLocal();
  const rows = await Trade.aggregate([
    { $match: { sellFilledAt: { $gte: since }, realizedPnl: { $ne: null } } },
    {
      $group: {
        _id: '$botId',
        monthTrades: { $sum: 1 },
        monthPnl: { $sum: '$realizedPnl' },
      },
    },
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), { monthTrades: r.monthTrades, monthPnl: r.monthPnl });
  return map;
}

/**
 * Active position count per bot — trades ที่ยังเปิดอยู่ (BUY/SELL รอ fill หรือถือ position)
 *   Returns Map<botIdString, count>
 */
async function aggregateActivePositionsPerBot() {
  const rows = await Trade.aggregate([
    {
      $match: {
        state: { $in: ['placed', 'partial_wait', 'filled', 'retrying', 'holding', 'selling', 'stopping'] },
      },
    },
    { $group: { _id: '$botId', count: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), r.count);
  return map;
}

module.exports = {
  startOfTodayLocal,
  startOfMonthLocal,
  aggregateAllTimeGlobal,
  aggregateTodayPerBot,
  aggregateMonthPerBot,
  aggregateActivePositionsPerBot,
};
