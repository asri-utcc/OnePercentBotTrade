#!/usr/bin/env node
'use strict';

/**
 * AUDIT-2026-11-19 — DB ↔ Binance reconciliation fix (data only, never places/cancels orders)
 *
 * Findings (verified against Binance allOrders / account, see AUDIT-2026-11-19.md):
 *   A. OVERSELL — positionWatchdog passed a projected trade without buyQty → forceClose sold the whole
 *      free balance. The selling trade recorded every coin + a wildly wrong PnL.
 *      → sellQty = own qty, sellQuoteQty / realizedPnl recomputed at the order's avg price.
 *   B. VICTIMS — sibling trades whose coins were sold by (A). Still 'holding' (coins gone) or
 *      synthetic-closed with PnL 0. → mark sold at the avg price of the order that sold them.
 *   C. ORPHAN 'filled' / 'selling'-without-order on auto-paused bots (coins verified in wallet)
 *      → waiting_sell_recovery @ targetSellPrice (service places LIMIT_MAKER when PERCENT_PRICE allows).
 *   D. PHANTOM waiting_sell_recovery — coins not in wallet (sold by the 2026-09-17 force-close)
 *      → dust_skipped (terminal, no PnL attributable).
 *   E. Recompute Bot totals for every touched bot (same aggregate as botManager.recomputeBotStats).
 *
 * Usage:
 *   node scripts/audit-fix-2026-11-19.js           # dry-run (prints plan)
 *   node scripts/audit-fix-2026-11-19.js --apply --skip-requeue   # A/B/D/E only (safe while pre-fix code runs)
 *   node scripts/audit-fix-2026-11-19.js --apply   # backup → data/audit-backup-2026-11-19-<ts>.json, then write
 */

const fs = require('fs');
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
const mongoose = require('mongoose');
const config = require('../config');
const binanceRest = require('../src/binance/binanceRest');
const fees = require('../src/binance/fees');

const APPLY = process.argv.includes('--apply');
// C must run on the fixed code only: pre-fix waitingSellRecovery cancelled every SELL on the symbol
const SKIP_REQUEUE = process.argv.includes('--skip-requeue');
const NOTE = 'audit-2026-11-19';
const TAKER = config.binance.useBnbForFees ? config.fees.bnbTaker : config.fees.normalTaker;

// B: victim → the trade whose (pre-fix) SELL order actually sold its coins. Verified qty sums:
//   HEMI  order 282815016 1884.2 = d3dd09a9 1440.2 + 1ac80cd6 444
//   HEMI  order 282817500 6461.1 = 10c31397 2972.9 + 4f7680b8 3488.3 (−0.1 dust still in wallet)
//   SAGA  order 2191999522 1006.7 = 1bde78d9 149.6 + 7fecf34f 857.1
//   CELR  order 1304987280 4041.1 = 44892636 2310.3 + 2da25a2e 1730.8
//   MOVR  order 1528635997 6.74   = 60b7277b 2.752 + 60b4cc0b 3.988
const PRICED_BY = {
  '6a9929b4f3b5b5db1ac80cd6': '6accdf05ec1e86e5d3dd09a9', // 1ac80cd6's coins went in d3dd09a9's order
};
const VICTIMS = {
  '6ae821f4bd75e78810c31397': '6a9929b4f3b5b5db1ac80cd6',
  '6af33885b094a9d14f7680b8': '6a9929b4f3b5b5db1ac80cd6',
  '6ae539599d69054d7fecf34f': '6ab5d709750d8b7f1bde78d9',
};
const OWN = (t) => parseFloat(t.buyFilledQty) || parseFloat(t.buyQty) || 0;
const OPEN_FOR_BALANCE = ['placed', 'partial_wait', 'filled', 'retrying', 'holding', 'selling', 'stopping', 'waiting_sell_recovery'];
const RECOVERABLE_PAUSE = ['low_vol', 'low_24h_vol'];

(async () => {
  await mongoose.connect(config.mongoUri);
  const col = mongoose.connection.db.collection('trades');
  const botsCol = mongoose.connection.db.collection('bots');
  const ops = []; // { id, before, set, why }
  const byId = async (id) => col.findOne({ _id: new mongoose.Types.ObjectId(id) });
  const avgOf = (t) => (t.sellQty > 0 ? t.sellQuoteQty / t.sellQty : 0);

  // ── A. oversell ──
  const oversold = await col.find({
    state: 'sold',
    $expr: { $gt: ['$sellQty', { $multiply: [{ $ifNull: ['$buyFilledQty', '$buyQty'] }, 1.01] }] },
  }).toArray();
  const origAvg = new Map(oversold.map((t) => [String(t._id), avgOf(t)]));
  for (const t of oversold) {
    const id = String(t._id);
    const own = OWN(t);
    const avg = PRICED_BY[id] ? origAvg.get(PRICED_BY[id]) || avgOf(await byId(PRICED_BY[id])) : origAvg.get(id);
    const pnl = fees.calcPnl({ buyPrice: t.buyPrice, sellPrice: avg, qty: own, feeRate: TAKER });
    ops.push({ id, before: t, why: `A oversell ${t.sellQty}→${own}`, set: {
      sellQty: own, sellQuoteQty: avg * own, sellPrice: avg, sellAvgPrice: avg,
      realizedPnl: pnl.net, pnlPercent: pnl.pnlPercent,
      sellReasonDetail: `${t.sellReasonDetail || ''} | ${NOTE}: SELL order oversold ${t.sellQty} (own ${own}) — qty/PnL corrected`.trim(),
    } });
  }

  // ── B. victims (explicit) + synthetic-closed victims (sold, sellQty 0, same symbol, closed ≤15min after an oversell) ──
  const victims = { ...VICTIMS };
  for (const o of oversold) {
    const extra = o.sellQty - OWN(o);
    if (extra <= 0 || !o.sellFilledAt) continue;
    const cands = await col.find({
      symbol: o.symbol, state: 'sold', $or: [{ sellQty: 0 }, { sellQty: null }],
      sellFilledAt: { $gte: new Date(o.sellFilledAt.getTime() - 15 * 60e3), $lte: new Date(o.sellFilledAt.getTime() + 15 * 60e3) },
    }).toArray();
    for (const c of cands) if (Math.abs(OWN(c) - extra) / extra < 0.01) victims[String(c._id)] = String(o._id);
  }
  for (const [vid, srcId] of Object.entries(victims)) {
    const v = await byId(vid);
    if (!v) continue;
    if (!['holding', 'sold'].includes(v.state)) { console.log('skip victim (state changed)', vid, v.state); continue; }
    if (v.state === 'sold' && v.sellQty > 0) continue; // already real
    const src = await byId(srcId);
    const avg = origAvg.get(srcId) || avgOf(src);
    const own = OWN(v);
    const pnl = fees.calcPnl({ buyPrice: v.buyPrice, sellPrice: avg, qty: own, feeRate: TAKER });
    ops.push({ id: vid, before: v, why: `B victim of ${srcId.slice(-8)} (${v.state})`, filter: { state: v.state }, set: {
      state: 'sold', sellOrderId: src.sellOrderId, sellStatus: 'FILLED', sellQty: own, sellPrice: avg, sellAvgPrice: avg,
      sellQuoteQty: avg * own, sellFilledAt: src.sellFilledAt, realizedPnl: pnl.net, pnlPercent: pnl.pnlPercent,
      sellReason: src.sellReason || 'manual_api_market', sellReasonSource: NOTE, sellReasonAt: new Date(),
      sellReasonDetail: `${NOTE}: coins sold by sibling trade ${srcId} SELL ${src.sellOrderId} (forceClose oversell bug)`,
      error: '', sellInFlight: false, holdingRetryCount: 0, holdingRetryParkedAt: null,
    } });
  }

  // wallet (read-only)
  const acct = await binanceRest.getAccount();
  const wallet = new Map((acct.balances || []).map((b) => [b.asset, parseFloat(b.free) + parseFloat(b.locked)]));
  const victimIds = new Set(Object.keys(victims));
  const open = (await col.find({ state: { $in: OPEN_FOR_BALANCE } }).toArray()).filter((t) => !victimIds.has(String(t._id)));
  const bots = new Map((await botsCol.find({}).toArray()).map((b) => [String(b._id), b]));
  const base = (s) => s.replace(/USDT$/, '');

  // ── D. phantom waiting_sell_recovery (wallet can't cover after other open trades) ──
  const phantom = new Set();
  for (const sym of new Set(open.filter((t) => t.state === 'waiting_sell_recovery').map((t) => t.symbol))) {
    const others = open.filter((t) => t.symbol === sym && t.state !== 'waiting_sell_recovery').reduce((a, t) => a + OWN(t), 0);
    let left = (wallet.get(base(sym)) || 0) - others;
    for (const t of open.filter((x) => x.symbol === sym && x.state === 'waiting_sell_recovery')) {
      if (left >= OWN(t) * 0.98) { left -= OWN(t); continue; }
      phantom.add(String(t._id));
      ops.push({ id: String(t._id), before: t, why: `D phantom (wallet ${wallet.get(base(sym)) || 0}, others ${others})`, filter: { state: 'waiting_sell_recovery' }, set: {
        state: 'dust_skipped',
        recoveryNote: `${NOTE}: coins not in wallet (sold by 2026-09-17 force-close) — closed, PnL not attributable`,
      } });
    }
  }

  // ── C. orphan filled / selling-without-order on auto-paused bots → waiting_sell_recovery ──
  for (const t of (SKIP_REQUEUE ? [] : open)) {
    const b = bots.get(String(t.botId));
    const orphanFilled = t.state === 'filled';
    const sellingNoOrder = t.state === 'selling' && !t.sellOrderId;
    if (!(orphanFilled || sellingNoOrder)) continue;
    if (!b || b.deletedAt || (b.enabled && !sellingNoOrder)) continue;
    if (!b.enabled && !RECOVERABLE_PAUSE.includes(b.autoPauseReason) && !sellingNoOrder) continue;
    const others = open.filter((x) => x.symbol === t.symbol && String(x._id) !== String(t._id) && !phantom.has(String(x._id)))
      .reduce((a, x) => a + OWN(x), 0);
    const have = (wallet.get(base(t.symbol)) || 0) - others;
    if (have < OWN(t) * 0.98) { console.log('skip C (coins not in wallet)', String(t._id), t.symbol, have, OWN(t)); continue; }
    const target = parseFloat(t.targetSellPrice) || 0;
    if (!(target > 0)) { console.log('skip C (no targetSellPrice)', String(t._id)); continue; }
    ops.push({ id: String(t._id), before: t, why: `C ${t.state}${sellingNoOrder ? ' (no sellOrderId)' : ''} → waiting_sell_recovery @ ${target}`, filter: { state: t.state }, set: {
      state: 'waiting_sell_recovery', buyFilledQty: OWN(t), waitingSince: new Date(), waitingTargetPrice: target,
      sellOrderId: null, sellClientOrderId: null, sellStatus: null, sellInFlight: false, holdingRetryCount: 0,
      recoveryNote: `${NOTE}: orphan ${t.state} on paused bot — TP SELL rejected (PERCENT_PRICE/NOTIONAL); waiting for price`,
    } });
  }

  // ── report ──
  for (const o of ops) console.log(o.why.padEnd(64), o.id.slice(-8), (o.before.symbol || '').padEnd(13),
    o.set.realizedPnl != null ? `pnl ${o.before.realizedPnl == null ? '-' : o.before.realizedPnl.toFixed(3)} → ${o.set.realizedPnl.toFixed(3)}` : '');
  const pnlDelta = ops.reduce((a, o) => a + (o.set.realizedPnl != null ? o.set.realizedPnl - (o.before.realizedPnl || 0) : 0), 0);
  console.log(`\n${ops.length} changes, realized PnL delta ${pnlDelta >= 0 ? '+' : ''}${pnlDelta.toFixed(2)} USDT${APPLY ? '' : '  (dry-run — pass --apply)'}`);

  if (APPLY && ops.length) {
    const bk = path.join('data', `audit-backup-2026-11-19-${Date.now()}.json`);
    fs.writeFileSync(bk, JSON.stringify(ops.map((o) => o.before), null, 1));
    console.log('backup →', bk);
    for (const o of ops) {
      const r = await col.updateOne({ _id: o.before._id, ...(o.filter || {}) }, { $set: { ...o.set, updatedAt: new Date() } });
      if (r.modifiedCount !== 1) console.log('  ! not modified (state changed?)', o.id);
    }
    // ── E. recompute bot totals for touched bots ──
    for (const botId of new Set(ops.map((o) => String(o.before.botId)))) {
      const [s] = await col.aggregate([
        { $match: { botId: new mongoose.Types.ObjectId(botId), state: 'sold', realizedPnl: { $ne: null } } },
        { $group: { _id: null, totalPnl: { $sum: '$realizedPnl' }, totalTrades: { $sum: 1 }, winTrades: { $sum: { $cond: [{ $gt: ['$realizedPnl', 0] }, 1, 0] } } } },
      ]).toArray();
      await botsCol.updateOne({ _id: new mongoose.Types.ObjectId(botId) }, { $set: s ? { totalPnl: s.totalPnl, totalTrades: s.totalTrades, winTrades: s.winTrades } : { totalPnl: 0, totalTrades: 0, winTrades: 0 } });
    }
    console.log('applied.');
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
