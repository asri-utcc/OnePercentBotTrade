'use strict';

/**
 * Force-close helpers — manual recovery for orphan / stuck positions.
 *
 * A bot can reach an "orphan" state where the DB says we still own a position
 * (state: placed/filled/holding/selling/retrying) but the actual base asset is
 * already gone from the Binance account (sold by a duplicate signal, by another
 * route, or never arrived). The trader's holding-retry loop just sees
 * `freeQty=0` and retries forever every 60s.
 *
 * Three branches on entry:
 *   1. freeQty > 0       → cancel any live SELL, MARKET SELL freeQty (real PnL from Binance)
 *   2. freeQty == 0 ∧ lockedQty > 0 → try cancelAllOpenOrders then re-check; fall through to 3
 *   3. freeQty == 0 ∧ lockedQty == 0 → synthetic close (asset already gone)
 *
 * Reuse (DO NOT duplicate):
 *   - binanceRest.cancelOrder({symbol, orderId}) — handles -2011 (already gone)
 *   - binanceRest.newOrder({type: 'MARKET', side: 'SELL'}) — exchange MARKET
 *   - binanceRest.getAccount() — source of truth for free/locked balance
 *   - fees.calcPnl(...) — uses a single feeRate; we pass taker rate for the MARKET leg
 *   - Trade.updateOne + Bot.updateOne atomic pattern (mirrors trader.js:1084)
 *
 * API surface:
 *   forceCloseTrade({ trade, allowMarketSell })  → { ok, mode, executedQty, avgSellPrice, pnl, error? }
 *   forceCloseBot({ botId, allowMarketSell })    → { ok, closedTrades:[], errors:[], disabled }
 *   cleanupOrphanTrades({ symbol, botId })       → summary of synthetic-closes (no Binance MARKET)
 *   resolveBaseAsset(symbol)                     → { base, freeQty, lockedQty }
 */

const config = require('../../config');
const binanceRest = require('../binance/binanceRest');
const fees = require('../binance/fees');
const logger = require('../utils/logger');
const eventBus = require('../services/eventBus');
const Bot = require('../db/models/Bot');
const Trade = require('../db/models/Trade');
const botManager = require('./botManager');

// Mirror OPEN_TRADE_STATES from bot-detail.js — duplicated to avoid circular require on trader.js
// FIX-2026-07-23b: เพิ่ม 'stopping' เพื่อให้ manual force-close ทำงานได้ระหว่าง stop-loss atomic-claim window
//   - ถ้า user กด force-close ขณะ stop-loss กำลัง force-close อยู่ → ทั้งคู่แข่งกัน, ใคร update 'sold' ก่อนชนะ
// FIX-2026-08-02: เพิ่ม 'partial_wait', 'partial_sell_wait' เพื่อรองรับ DCA stack partial states
const FORCE_OPEN_STATES = ['placed', 'partial_wait', 'filled', 'holding', 'selling', 'retrying', 'partial_sell_wait', 'stopping'];

// FIX-2026-08-02: DCA stack BEP computation (local copy — avoid circular require on trader.js)
//   - ใช้ใน forceClose เพื่อ derive buyPrice/buyQty จาก stack fields
function computeStackBEP(trade) {
  if (Array.isArray(trade.buyLayers) && trade.buyLayers.length > 0) {
    let totalQty = 0;
    let totalSpent = 0;
    for (const layer of trade.buyLayers) {
      if (!layer || layer.status !== 'FILLED') continue;
      const p = Number(layer.price);
      const q = Number(layer.qty);
      if (!Number.isFinite(p) || !Number.isFinite(q) || q <= 0 || p <= 0) continue;
      totalQty += q;
      totalSpent += p * q;
    }
    if (totalQty > 0) {
      return { totalQty, totalSpent, bep: totalSpent / totalQty };
    }
  }
  // Fallback to scalar fields (mirror from _handleDcaBuyFilled)
  const buyPrice = Number(trade.buyPrice);
  const buyQty = Number(trade.buyQty);
  if (Number.isFinite(buyPrice) && Number.isFinite(buyQty) && buyPrice > 0 && buyQty > 0) {
    return { totalQty: buyQty, totalSpent: buyPrice * buyQty, bep: buyPrice };
  }
  return { totalQty: 0, totalSpent: 0, bep: null };
}

/**
 * Look up free + locked balances for the base asset derived from a USDT symbol.
 * Uses binanceRest.getAccount() directly (not the cached fees.getAccount) because
 * force-close decisions need the freshest snapshot — the cached version has a
 * 5-minute TTL that is not acceptable when we are deciding to MARKET SELL.
 */
async function resolveBaseAsset(symbol) {
  const base = symbol.replace(/USDT$|USDC$|BUSD$/, '');
  const acc = await binanceRest.getAccount();
  const bal = (acc.balances || []).find((b) => b.asset === base);
  const freeQty = bal ? parseFloat(bal.free) : 0;
  const lockedQty = bal ? parseFloat(bal.locked) : 0;
  return { base, freeQty, lockedQty };
}

/**
 * Cancel a SELL order if any. Treats -2011 (order already gone / filled) as success
 * since the goal is to clear the live SELL before MARKET SELL — same pattern as
 * trader.js cancelAndRecheck (~line 785).
 *
 * Returns { cancelled: bool, status: string|null, error: object|null }
 */
async function cancelSellOrderIfAny(trade) {
  if (!trade.sellOrderId) return { cancelled: false, status: null, error: null };
  try {
    const resp = await binanceRest.cancelOrder({
      symbol: trade.symbol,
      orderId: trade.sellOrderId,
    });
    return { cancelled: true, status: resp.status || 'CANCELED', error: null };
  } catch (err) {
    const ferr = binanceRest.formatBinanceError(err);
    if (ferr && ferr.code === -2011) {
      // -2011 = "Unknown order" — already gone (filled / cancelled / expired). Not a failure.
      return { cancelled: true, status: 'ALREADY_GONE', error: null };
    }
    return { cancelled: false, status: null, error: ferr || { msg: err.message } };
  }
}

/**
 * Place a MARKET SELL with a fresh newClientOrderId. We do NOT depend on the
 * Trader instance here because in force-close we may be cleaning up a position
 * whose trader is disabled / crashing / never existed.
 *
 * Returns { ok, resp, error } — caller decides what to do on !ok.
 */
async function placeMarketSell(symbol, qty, clientOrderTag) {
  const newClientOrderId = `fc-${clientOrderTag || 'sell'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (newClientOrderId.length > 36) {
    // Binance hard limit = 36 chars — truncate the random tail if needed
    return { ok: false, error: { code: -1, msg: 'newClientOrderId too long' } };
  }
  const resp = await binanceRest.newOrder({
    symbol,
    side: 'SELL',
    type: 'MARKET',
    quantity: qty.toString(),
    newClientOrderId,
    recvWindow: config.binance.recvWindow,
  }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));
  if (resp.error) return { ok: false, error: resp.error, resp: null };
  return { ok: true, error: null, resp };
}

/**
 * Atomic UPDATE guarded by the open state. If the trade has already moved on
 * (e.g. the WS recovered and handleSellFilled ran) the `modifiedCount` is 0
 * and we treat it as a no-op success so we don't double-decrement bot totals.
 */
async function markTradeSold({ trade, sold, errorNote, reason, sellReason, sellReasonDetail, sellReasonSource, isDcaStack }) {
  const setFields = {
    state: 'sold',
    sellOrderId: sold.sellOrderId ?? null,
    sellClientOrderId: sold.sellClientOrderId ?? null,
    sellPrice: sold.sellPrice ?? null,
    sellQty: sold.sellQty ?? null,
    sellQuoteQty: sold.sellQuoteQty ?? null,
    sellStatus: sold.sellStatus ?? 'FORCED',
    sellFilledAt: sold.sellFilledAt ?? new Date(),
    sellPlacedAt: sold.sellPlacedAt ?? new Date(),
    realizedPnl: sold.realizedPnl ?? null,
    pnlPercent: sold.pnlPercent ?? null,
    error: errorNote || '',
    // FIX-2026-08-01: structured sellReason — caller passes sellReason enum + free-text detail
    sellReason: sellReason || null,
    sellReasonDetail: sellReasonDetail || errorNote || null,
    sellReasonAt: new Date(),
    sellReasonSource: sellReasonSource || 'forceClose.markTradeSold',
  };
  // FIX-2026-08-02: DCA stack — stamp stackClosedAt
  if (isDcaStack) {
    setFields.stackClosedAt = new Date();
  }
  const upd = await Trade.updateOne(
    {
      _id: trade._id,
      state: { $in: FORCE_OPEN_STATES },
    },
    { $set: setFields }
  );
  const ok = upd.modifiedCount === 1;
  if (!ok) {
    logger.warn({
      tradeId: trade._id.toString(),
      stateInDb: 'no longer in OPEN_STATES',
    }, 'forceClose: trade moved on (modifiedCount=0) — skipping Bot $inc to avoid double-count');
  }
  return ok;
}

/**
 * Centralised force-close for one trade. Returns a structured result so the
 * API route can report `mode` ("market" / "synthetic") back to the client.
 *
 * @param {object} opts
 * @param {object} opts.trade   - Mongoose trade document (must have _id, symbol, botId, buyPrice, buyQty)
 * @param {object} [opts.bot]   - Optional; if omitted we look up by trade.botId (needed for symbol in cancel)
 * @param {boolean} [opts.allowMarketSell=true] - When false, never places a MARKET SELL (cleanup mode)
 * @returns {Promise<{ok: boolean, mode: string, executedQty: number, avgSellPrice: number|null, pnl: number, error?: string}>}
 */
async function forceCloseTrade({ trade, bot = null, allowMarketSell = true }) {
  const logCtx = { tradeId: trade._id && trade._id.toString(), symbol: trade.symbol };
  // FIX-2026-08-02: DCA stack branch — derive qty/buyPrice from stack fields
  const isDcaStack = trade.isDcaStack === true;
  let stackBep = null;
  let stackTotalQty = 0;
  if (isDcaStack) {
    const stack = computeStackBEP(trade);
    stackBep = stack.bep;
    stackTotalQty = stack.totalQty;
    if (!stackBep || stackTotalQty <= 0) {
      return { ok: false, mode: 'none', executedQty: 0, avgSellPrice: null, pnl: 0, error: 'DCA stack missing BEP/qty' };
    }
    logger.info({
      ...logCtx,
      stackId: trade.stackId?.toString(),
      stackBep, stackTotalQty,
      dcaLayerCount: trade.dcaLayerCount,
    }, 'forceClose: DCA stack detected — using stackBep + stackTotalQty');
  }
  try {
    if (!trade || !trade._id) {
      return { ok: false, mode: 'none', executedQty: 0, avgSellPrice: null, pnl: 0, error: 'trade missing' };
    }
    if (!bot) {
      bot = await Bot.findById(trade.botId).catch(() => null);
    }
    if (!bot) {
      return { ok: false, mode: 'none', executedQty: 0, avgSellPrice: null, pnl: 0, error: 'bot missing' };
    }

    // Idempotency guard: if trade already 'sold' (e.g. user double-clicked while
    // the previous call was in flight), just return success with zeros so caller
    // doesn't show a misleading error.
    if (trade.state === 'sold') {
      return { ok: true, mode: 'already-sold', executedQty: 0, avgSellPrice: null, pnl: 0 };
    }

    // Cancel any live SELL before attempting MARKET to avoid double-selling.
    const cancel = await cancelSellOrderIfAny(trade);
    if (cancel.error) {
      logger.warn({ ...logCtx, err: cancel.error }, 'forceClose: cancelSellOrderIfAny failed (will still attempt balance branch)');
    }

    // Branch 2: lockedQty > 0 → try cancelAllOpenOrders and re-check.
    let resolved = await resolveBaseAsset(trade.symbol);
    if (resolved.freeQty === 0 && resolved.lockedQty > 0) {
      try {
        await binanceRest.cancelAllOpenOrders({ symbol: trade.symbol });
        // wait a beat for the cancellations to settle on Binance
        await new Promise((r) => setTimeout(r, 400));
        resolved = await resolveBaseAsset(trade.symbol);
      } catch (err) {
        const ferr = binanceRest.formatBinanceError(err);
        logger.warn({ ...logCtx, err: ferr }, 'forceClose: cancelAllOpenOrders failed (proceeding)');
      }
    }

    // Branch 1: freeQty > 0 — MARKET SELL.
    if (resolved.freeQty > 0) {
      if (!allowMarketSell) {
        // Cleanup mode — treat as synthetic close since caller said no MARKET.
        return await forceCloseTrade_synthetic({
          trade, logCtx, reason: 'cleanup-mode (allowMarketSell=false, freeQty present)',
        });
      }
      const tradeSymbol = trade.symbol || bot.symbol;
      const placed = await placeMarketSell(tradeSymbol, resolved.freeQty, 'fc');
      if (!placed.ok) {
        return { ok: false, mode: 'market-failed', executedQty: 0, avgSellPrice: null, pnl: 0, error: JSON.stringify(placed.error) };
      }
      const resp = placed.resp;
      const executed = parseFloat(resp.executedQty) || 0;
      const avgSell = parseFloat(resp.price)
        || parseFloat(resp.avgPrice)
        || (parseFloat(resp.cummulativeQuoteQty) / parseFloat(resp.executedQty))
        || 0;
      const buyPrice = isDcaStack ? stackBep : (parseFloat(trade.buyPrice) || 0);
      // MARKET is a taker leg — use taker rate. (The buy was a maker, but we don't
      // store buy fee separate per leg in this minimal helper; for v1 we accept the
      // same fee on both legs and document the approximation.)
      const feeRate = config.binance.useBnbForFees ? config.fees.bnbTaker : config.fees.normalTaker;
      const pnl = fees.calcPnl({
        buyPrice,
        sellPrice: avgSell,
        qty: executed,
        feeRate,
      });

      // FIX-2026-08-02: DCA stack — use dca_stack_force_close reason + stamp stackClosedAt
      const finalSellReason = isDcaStack ? 'dca_stack_force_close' : 'manual_api_market';
      const finalSellReasonDetail = isDcaStack
        ? `manual close via API (DCA stack) — MARKET @ ${avgSell} qty=${executed} stackBep=${stackBep} layers=${trade.dcaLayerCount || 0}`
        : `manual close via API — MARKET @ ${avgSell} qty=${executed}`;
      const finalSellReasonSource = isDcaStack
        ? 'forceClose.forceCloseTrade_dca'
        : 'forceClose.forceCloseTrade';

      const marked = await markTradeSold({
        trade,
        sold: {
          sellOrderId: resp.orderId,
          sellClientOrderId: resp.clientOrderId || null,
          sellPrice: avgSell,
          sellQty: executed,
          sellQuoteQty: parseFloat(resp.cummulativeQuoteQty) || 0,
          sellStatus: resp.status || 'FILLED',
          sellFilledAt: new Date(resp.updateTime || Date.now()),
          sellPlacedAt: new Date(),
          realizedPnl: pnl.net,
          pnlPercent: pnl.pnlPercent,
        },
        errorNote: isDcaStack ? 'force_close: DCA stack MARKET SELL via API' : 'force_close: MARKET SELL via API',
        reason: 'market',
        sellReason: finalSellReason,
        sellReasonDetail: finalSellReasonDetail,
        sellReasonSource: finalSellReasonSource,
        isDcaStack,
      });

      if (marked) {
        await Bot.updateOne(
          { _id: trade.botId },
          {
            $inc: {
              totalPnl: pnl.net,
              totalTrades: 1,
              winTrades: (pnl.net > 0 ? 1 : 0),
            },
            $set: { status: 'idle' },
          }
        );
      }
      eventBus.emit('trade:update', {
        tradeId: trade._id,
        botId: trade.botId,
        state: 'sold',
        reason: finalSellReason,
        reasonDetail: finalSellReasonDetail,
        stackId: isDcaStack ? trade.stackId : undefined,
        dcaLayerCount: isDcaStack ? (trade.dcaLayerCount || 0) : undefined,
        stackBep: isDcaStack ? stackBep : undefined,
        stackTotalQty: isDcaStack ? stackTotalQty : undefined,
        realizedPnl: pnl.net,
        pnlPercent: pnl.pnlPercent,
      });
      eventBus.emit('bot:status', { botId: trade.botId, status: 'idle' });
      logger.info({
        ...logCtx,
        isDcaStack,
        mode: 'market', executedQty: executed, avgSellPrice: avgSell, pnl: pnl.net, freeQty: resolved.freeQty,
      }, 'forceCloseTrade: MARKET SELL completed');
      return { ok: true, mode: 'market', executedQty: executed, avgSellPrice: avgSell, pnl: pnl.net };
    }

    // Branch 3: freeQty == 0 ∧ lockedQty == 0 → synthetic close.
    return await forceCloseTrade_synthetic({
      trade, logCtx, reason: 'asset missing on exchange',
    });
  } catch (err) {
    logger.error({ ...logCtx, err: err.message, stack: err.stack }, 'forceCloseTrade: unhandled');
    return { ok: false, mode: 'error', executedQty: 0, avgSellPrice: null, pnl: 0, error: err.message };
  }
}

/**
 * Synthetic close — no Binance order placed. Used when:
 *   - branch 3 (freeQty == 0 ∧ lockedQty == 0), OR
 *   - cleanup mode (allowMarketSell=false even if freeQty > 0)
 *
 * Records a 0 PnL closing and emits events. The trader is responsible for
 * eventually clearing its currentTrade pointer via WS / reconcile; the next
 * botManager.reconcilePendingTrades() will see the trade as 'sold' and skip.
 */
async function forceCloseTrade_synthetic({ trade, logCtx, reason }) {
  const now = new Date();
  // FIX-2026-08-02: DCA stack — use dca_stack_force_close + stamp stackClosedAt
  const isDcaStack = trade.isDcaStack === true;
  const finalSellReason = isDcaStack ? 'dca_stack_force_close' : 'manual_api_synthetic';
  const finalSellReasonDetail = isDcaStack
    ? `manual close via API (DCA stack, synthetic) — ${reason || 'asset missing'} layers=${trade.dcaLayerCount || 0}`
    : (reason || 'asset missing on exchange');
  const finalSellReasonSource = isDcaStack
    ? 'forceClose.forceCloseTrade_synthetic_dca'
    : 'forceClose.forceCloseTrade_synthetic';
  const marked = await markTradeSold({
    trade,
    sold: {
      sellOrderId: null,
      sellClientOrderId: null,
      sellPrice: 0,
      sellQty: 0,
      sellQuoteQty: 0,
      sellStatus: 'FORCED_SYNTHETIC',
      sellFilledAt: now,
      sellPlacedAt: now,
      realizedPnl: 0,
      pnlPercent: 0,
    },
    errorNote: isDcaStack ? `force_close: DCA stack synthetic close — ${reason}` : `force_close: synthetic close — ${reason}`,
    reason: 'synthetic',
    // FIX-2026-08-01: structured sellReason — manual close via API (synthetic — asset missing)
    sellReason: finalSellReason,
    sellReasonDetail: finalSellReasonDetail,
    sellReasonSource: finalSellReasonSource,
    isDcaStack,
  });
  if (marked) {
    await Bot.updateOne(
      { _id: trade.botId },
      {
        $inc: { totalTrades: 1 }, // count the close but no PnL change (WIN only if positive — we have 0)
        $set: { status: 'idle' },
      }
    );
  }
  eventBus.emit('trade:update', {
    tradeId: trade._id,
    botId: trade.botId,
    state: 'sold',
    reason: 'manual_api_synthetic',
    reasonDetail: reason || 'asset missing on exchange',
  });
  eventBus.emit('bot:status', { botId: trade.botId, status: 'idle' });
  logger.warn({ ...logCtx, reason }, 'forceCloseTrade: synthetic close recorded');
  return { ok: true, mode: 'synthetic', executedQty: 0, avgSellPrice: 0, pnl: 0 };
}

/**
 * Force-close ALL open trades for a bot and disable it. Sequential (one at a
 * time) to stay well under Binance weight limits.
 *
 * @param {object} opts
 * @param {string} opts.botId
 * @param {boolean} [opts.allowMarketSell=true]
 * @param {boolean} [opts.disableBot=true]   - if false, just close positions (don't disable)
 */
async function forceCloseBot({ botId, allowMarketSell = true, disableBot = true }) {
  const results = { ok: true, closedTrades: [], errors: [], disabled: false };
  const bot = await Bot.findById(botId).catch(() => null);
  if (!bot) {
    return { ok: false, closedTrades: [], errors: [{ error: 'bot missing' }], disabled: false };
  }
  const opens = await Trade.find({
    botId,
    state: { $in: FORCE_OPEN_STATES },
  });
  logger.warn({
    botId: botId.toString(), symbol: bot.symbol, count: opens.length, allowMarketSell, disableBot,
  }, 'forceCloseBot: starting');
  for (const t of opens) {
    try {
      const r = await forceCloseTrade({ trade: t, bot, allowMarketSell });
      const entry = { tradeId: t._id.toString(), symbol: t.symbol, mode: r.mode, executedQty: r.executedQty, avgSellPrice: r.avgSellPrice, pnl: r.pnl };
      if (!r.ok) {
        results.errors.push({ ...entry, error: r.error || 'unknown' });
      }
      results.closedTrades.push(entry);
    } catch (err) {
      results.errors.push({ tradeId: t._id.toString(), error: err.message });
    }
  }
  if (disableBot && bot.enabled) {
    try {
      await botManager.disableBot(botId);
      results.disabled = true;
    } catch (err) {
      results.errors.push({ stage: 'disable', error: err.message });
    }
  }
  logger.warn({
    botId: botId.toString(),
    closed: results.closedTrades.length,
    errors: results.errors.length,
    disabled: results.disabled,
  }, 'forceCloseBot: done');
  return results;
}

/**
 * Cleanup utility — synthetic close ALL open trades for the given bot(s) or
 * symbol(s) WITHOUT placing any MARKET SELL. Intended to be called from a
 * one-shot script when we know the assets are already gone (e.g. a duplicate
 * signal blow-up that already was emergency-sold earlier).
 *
 * @param {object} [opts]
 * @param {string} [opts.symbol]  - if set, restrict to trades of this symbol
 * @param {string} [opts.botId]   - if set, restrict to this bot
 * @returns {Promise<{ cleaned: object[], errors: object[] }>}
 */
async function cleanupOrphanTrades({ symbol = null, botId = null } = {}) {
  const query = { state: { $in: FORCE_OPEN_STATES } };
  if (botId) query.botId = botId;
  const opens = await Trade.find(query).populate('botId');
  const filtered = symbol ? opens.filter((t) => t.botId && t.botId.symbol === symbol) : opens;
  const cleaned = [];
  const errors = [];
  logger.warn({ total: opens.length, afterFilter: filtered.length, symbol, botId }, 'cleanupOrphanTrades: starting');
  for (const t of filtered) {
    try {
      const r = await forceCloseTrade({
        trade: t,
        bot: t.botId,
        allowMarketSell: false, // synthetic-only — never place orders
      });
      cleaned.push({ tradeId: t._id.toString(), symbol: t.symbol, mode: r.mode, error: r.error || null });
    } catch (err) {
      errors.push({ tradeId: t._id.toString(), error: err.message });
    }
  }
  logger.warn({ cleaned: cleaned.length, errors: errors.length }, 'cleanupOrphanTrades: done');
  return { cleaned, errors };
}

module.exports = {
  forceCloseTrade,
  forceCloseBot,
  cleanupOrphanTrades,
  resolveBaseAsset,
  FORCE_OPEN_STATES,
};
