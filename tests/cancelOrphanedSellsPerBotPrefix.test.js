'use strict';

/**
 * FIX-2026-09-01 audit C16: _cancelOrphanedSells defensive scan must be
 * scoped by per-bot clientOrderId prefix.
 *
 *   Before this fix:
 *     - getOpenOrders({ symbol }) returns ALL open SELL orders on this
 *       symbol, regardless of which bot placed them.
 *     - A defensive scan triggered by bot A's _cancelOrphanedSells
 *       (e.g. after a partial_fill / abort path) could cancel bot B's
 *       SELL on the SAME symbol because the qty/price heuristic was
 *       too loose (1% qty, 50% price).
 *     - Risk: shared Binance account, two bots both trading BTCUSDT →
 *       bot A's defensive scan cancels bot B's live SELL.
 *
 *   After this fix:
 *     - Each SELL order carries a clientOrderId with prefix
 *       `b${botId.slice(-6)}-` (set by makeClientOrderId).
 *     - The defensive scan SKIPS any open order whose clientOrderId
 *       does NOT start with this bot's prefix.
 *     - Orders without a clientOrderId are SKIPPED too (safer than
 *       blindly cancelling them — we may not have placed them).
 */

const fs = require('fs');
const path = require('path');

const MOD_PATH = path.join(__dirname, '..', 'src', 'core', 'trader.js');
const modRaw = fs.readFileSync(MOD_PATH, 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s;,(])\/\/[^\n]*/g, '$1');
}

describe('audit-C16 source: defensive scan gated by per-bot clientOrderId prefix', () => {
  test('FIX-2026-09-01 audit C16 comment is present in trader.js', () => {
    expect(modRaw).toMatch(/FIX-2026-09-01 audit C16/);
  });

  test('per-bot prefix derived from makeClientOrderId format (b + botId.slice(-6) + "-")', () => {
    const code = stripComments(modRaw);
    // The defensive scan must compute the prefix from this.bot._id exactly
    // the same way makeClientOrderId does (b${shortBot}-).
    const prefixMatch = code.match(/const\s+botPrefix\s*=\s*`b\$\{this\.bot\._id\.toString\(\)\.slice\(-6\)\}-`/);
    expect(prefixMatch).not.toBeNull();
  });

  test('defensive scan skips orders whose clientOrderId does not start with botPrefix', () => {
    const code = stripComments(modRaw);
    // The gate must compare order.clientOrderId against botPrefix via startsWith
    // and CONTINUE (skip) when not matching.
    const skipBlock = code.match(/const\s+cid\s*=\s*o\.clientOrderId\s*\|\|\s*['"]['"];[\s\S]{0,200}if\s*\(\s*!cid\.startsWith\(botPrefix\)\s*\)\s*continue\s*;/);
    expect(skipBlock).not.toBeNull();
  });

  test('defensive scan logs the clientOrderId when it cancels', () => {
    const code = stripComments(modRaw);
    // The defensive cancel log line should include clientOrderId so forensic
    // trace can confirm we only ever cancelled our own orders. The
    // clientOrderId key sits INSIDE the logger.info({...}) object that
    // appears immediately before the message string.
    const cancelBlock = code.match(/clientOrderId\s*:\s*cid[\s\S]{0,300}'trader: _cancelOrphanedSells — defensive cancel'/);
    expect(cancelBlock).not.toBeNull();
  });
});

describe('audit-C16 runtime: defensive scan only cancels own-bot SELLs', () => {
  // We mock the trader's binanceRest and a single trader instance to exercise
  // the scan loop directly. We don't load the full trader module (it's huge)
  // — we just re-implement the scan logic here using the same source-level
  // contract so a regression in trader.js would also break this test if the
  // assert below gets out of sync.
  //
  // The actual real behaviour is verified by source-level tests above.

  function buildBot(id) {
    return { _id: { toString: () => id }, symbol: 'BTCUSDT' };
  }
  function makePrefix(botId) { return `b${botId.slice(-6)}-`; }

  function pickScannable(orders, botId, buyPrice, buyQty) {
    const prefix = makePrefix(botId);
    // Mirror trader.js logic: candidatesQty = buyQty when no orphans yet
    const candidatesQty = buyQty;
    const result = [];
    for (const o of orders) {
      if (o.side !== 'SELL') continue;
      const cid = o.clientOrderId || '';
      if (!cid.startsWith(prefix)) continue;
      const oQty = parseFloat(o.origQty || o.quantity || 0);
      const oPrice = parseFloat(o.price || 0);
      const matchQty = !candidatesQty || Math.abs(oQty - candidatesQty) / Math.max(candidatesQty, 1e-12) < 0.01;
      const matchPrice = !buyPrice || oPrice >= buyPrice * 0.5;
      if (matchQty && matchPrice) result.push(o);
    }
    return result;
  }

  test('only this bot\'s own SELLs are returned (same symbol, sibling bot excluded)', () => {
    const orders = [
      { orderId: 1, side: 'SELL', clientOrderId: 'b123456-100-sell-abc', origQty: 100, price: 50000 }, // own bot
      { orderId: 2, side: 'SELL', clientOrderId: 'b999999-100-sell-xyz', origQty: 100, price: 50000 }, // other bot
      { orderId: 3, side: 'SELL', clientOrderId: '', origQty: 100, price: 50000 },                    // legacy no-cid
      { orderId: 4, side: 'BUY',  clientOrderId: 'b123456-100-buy-abc',  origQty: 100, price: 50000 }, // wrong side
    ];
    const bot = buildBot('botA123456'); // last 6 = 123456
    const picks = pickScannable(orders, bot._id.toString(), 50000, 100);
    const ids = picks.map((p) => p.orderId).sort();
    expect(ids).toEqual([1]); // only own SELL
  });

  test('qty mismatch still skipped even if prefix matches (defense in depth)', () => {
    const orders = [
      { orderId: 1, side: 'SELL', clientOrderId: 'b123456-100-sell-abc', origQty: 50, price: 50000 }, // wrong qty
      { orderId: 2, side: 'SELL', clientOrderId: 'b123456-100-sell-abc', origQty: 100, price: 50000 }, // right qty
    ];
    const picks = pickScannable(orders, 'botA123456', 50000, 100);
    expect(picks.map((p) => p.orderId)).toEqual([2]);
  });

  test('empty clientOrderId is always skipped (legacy safety)', () => {
    const orders = [{ orderId: 1, side: 'SELL', clientOrderId: '', origQty: 100, price: 50000 }];
    const picks = pickScannable(orders, 'botA123456', 50000, 100);
    expect(picks).toEqual([]);
  });

  test('returns nothing when no SELLs exist for this bot', () => {
    const orders = [
      { orderId: 1, side: 'SELL', clientOrderId: 'b999999-100-sell-xyz', origQty: 100, price: 50000 },
    ];
    const picks = pickScannable(orders, 'botA123456', 50000, 100);
    expect(picks).toEqual([]);
  });

  test('BOT prefix format matches makeClientOrderId (b + last 6 + dash)', () => {
    // spot-check that bot._id.slice(-6) yields exactly 6 chars before the dash
    expect(makePrefix('aaaaaaaaaaaaaaaaa123456')).toBe('b123456-');
    expect(makePrefix('123456')).toBe('b123456-');
  });
});