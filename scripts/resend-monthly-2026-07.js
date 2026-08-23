'use strict';
/**
 * FIX-2026-08-01: Re-send monthly summary for 2026-07 with correct label
 *   - Reason: bug — rangeLabel used CURRENT month (2026-08) instead of previous (2026-07)
 *   - User received "สรุปการเทรดรายเดือน (2026-08)" but data was actually July
 *   - This script manually dispatches monthlySummary with rangeLabel='2026-07'
 *
 * Usage: node scripts/resend-monthly-2026-07.js
 */

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

(async () => {
  const c = require('../src/db/connection');
  await (c.connect ? c.connect() : c);

  const Trade = require('../src/db/models/Trade');
  const Bot = require('../src/db/models/Bot');
  const fxService = require('../src/services/fxService');
  const telegramNotifier = require('../src/services/telegramNotifier');

  // Range: 2026-07-01 00:00 → 2026-08-01 00:00 (local TZ)
  const startDate = new Date(2026, 6, 1); // month is 0-indexed: 6 = July
  const endDate = new Date(2026, 7, 1); // August 1
  console.log(`[resend] aggregate range: ${startDate.toISOString()} → ${endDate.toISOString()}`);

  const trades = await Trade.find({
    sellFilledAt: { $gte: startDate, $lt: endDate },
    realizedPnl: { $ne: null },
  }).select('_id botId symbol realizedPnl').lean();
  const bots = await Bot.find({ _id: { $in: trades.map((t) => t.botId) } }, 'name').lean();
  const botNameMap = new Map(bots.map((b) => [String(b._id), b.name]));

  let pnlUsdt = 0, wins = 0, losses = 0;
  const perBotMap = new Map();
  for (const t of trades) {
    const pnl = Number(t.realizedPnl) || 0;
    pnlUsdt += pnl;
    if (pnl > 0) wins += 1; else if (pnl < 0) losses += 1;
    const key = `${t.botId}|${t.symbol}`;
    const cur = perBotMap.get(key) || { botId: t.botId, name: botNameMap.get(String(t.botId)) || '?', symbol: t.symbol, trades: 0, pnlUsdt: 0 };
    cur.trades += 1;
    cur.pnlUsdt += pnl;
    perBotMap.set(key, cur);
  }
  const agg = {
    trades: trades.length,
    wins,
    losses,
    pnlUsdt,
    perBot: Array.from(perBotMap.values()).sort((a, b) => b.pnlUsdt - a.pnlUsdt),
  };

  // FX
  let fxRate = null;
  try { fxRate = (await fxService.getUsdtToThb()).rate; } catch (err) {
    console.warn('[resend] FX fetch failed:', err.message);
  }
  const pnlThb = fxRate != null ? Number((agg.pnlUsdt * fxRate).toFixed(2)) : null;

  console.log(`[resend] July 2026 stats: trades=${agg.trades} wins=${agg.wins} losses=${agg.losses} pnlUsdt=${pnlUsdt.toFixed(4)} pnlThb=${pnlThb}`);
  console.log(`[resend] perBot:`, agg.perBot.map((b) => `${b.name}(${b.symbol}) ${b.trades} ไม้ ${b.pnlUsdt.toFixed(4)}`));

  // Dispatch via telegramNotifier internal sendNow (renamed export of dispatch)
  //   module.exports = { start, stop, reloadConfig, sendNow: dispatch }
  if (typeof telegramNotifier.sendNow !== 'function') {
    console.error('[resend] telegramNotifier.sendNow not found — check exports');
    process.exit(2);
  }
  const ok = await telegramNotifier.sendNow('monthlySummary', {
    ...agg,
    pnlThb,
    fxRate,
    rangeLabel: '2026-07', // correct label
  });
  console.log(`[resend] telegram dispatch result: ${ok}`);

  // Also update lastSummarySent cache so the bot doesn't re-send with wrong label later today
  try {
    // notifier module has internal lastSummarySent — but it's module-private. Patching not feasible.
    // Workaround: bot will still try to send at next 60s tick (since monthKey=2026-08 but lastSent=null on fresh process restart)
    // To prevent duplicate, we set lastSummarySent via a side-channel: trigger a daily scan write
    // — but for simplicity, just exit and let the user know
    console.log('[resend] NOTE: bot may also send monthly summary at next 60s tick — they should be deduplicated if telegram chat has duplicate-detection, otherwise user will see 2 messages');
  } catch (_) { /* noop */ }

  process.exit(ok ? 0 : 3);
})().catch((err) => {
  console.error('[resend] FAILED:', err);
  process.exit(1);
});
