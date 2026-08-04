'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Trade = require('../../db/models/Trade');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const { botId, symbol, limit = 100, state, isDcaStack } = req.query;
    const q = {};
    if (botId) q.botId = botId;
    if (symbol) q.symbol = symbol.toUpperCase();
    if (state) q.state = state;
    // FIX-2026-08-03: filter by isDcaStack (used by bot-edit UI to detect open DCA stack when toggling off)
    if (isDcaStack !== undefined) q.isDcaStack = isDcaStack === 'true';

    const trades = await Trade.find(q).sort({ createdAt: -1 }).limit(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500)).lean();
    res.json({ trades });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const trade = await Trade.findById(req.params.id).lean();
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    res.json({ trade });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FIX-2026-08-02: DCA stack endpoint — returns full stack view (defensive read-only)
//   Accepts either the stack's own _id OR a layer's _id (resolves to parent stack via stackId)
//   Returns: { stackId, isDcaStack, layerCount, maxLayers (from bot config), layers, totalQty,
//              totalSpent, bep, targetSellPrice, sellOrderId, state, partialSellFrozen }
router.get('/:id/stack', requireAuth, async (req, res) => {
  try {
    const Bot = require('../../db/models/Bot');
    const trade = await Trade.findById(req.params.id).lean();
    if (!trade) return res.status(404).json({ error: 'Trade not found' });

    // If this trade is a layer (not the stack itself), resolve via stackId
    let stack = trade;
    if (!trade.isDcaStack && trade.stackId) {
      stack = await Trade.findById(trade.stackId).lean();
      if (!stack) return res.status(404).json({ error: 'Stack not found for layer' });
    } else if (!trade.isDcaStack) {
      return res.status(400).json({ error: 'Trade is not part of a DCA stack' });
    }

    // Compute aggregates from buyLayers[] (defensive: derive even if scalars drift)
    let totalQty = Number(stack.stackTotalQty) || 0;
    let totalSpent = Number(stack.stackTotalSpent) || 0;
    let bep = Number(stack.stackBep) || 0;
    if (Array.isArray(stack.buyLayers) && stack.buyLayers.length > 0) {
      const q = stack.buyLayers.reduce((s, ly) => s + (Number(ly.qty) || 0), 0);
      const spent = stack.buyLayers.reduce((s, ly) => s + ((Number(ly.price) || 0) * (Number(ly.qty) || 0)), 0);
      if (q > 0) {
        totalQty = q;
        totalSpent = spent;
        bep = spent / q;
      }
    }

    const bot = await Bot.findById(stack.botId).select('dcaMaxLayers dcaEnabled symbol timeframe').lean();

    // Detect partial-fill freeze
    const partialSellFrozen = !!(stack.sellPartialLatchedAt || stack.sellPartialDetectedAt);

    res.json({
      stackId: stack._id,
      isDcaStack: stack.isDcaStack === true,
      layerCount: stack.dcaLayerCount || (stack.buyLayers?.length || 0),
      maxLayers: (bot && bot.dcaMaxLayers) || null,
      dcaEnabled: !!(bot && bot.dcaEnabled),
      botId: stack.botId,
      symbol: stack.symbol,
      timeframe: stack.timeframe,
      layers: stack.buyLayers || [],
      totalQty,
      totalSpent,
      bep,
      targetSellPrice: Number(stack.stackTargetSellPrice) || Number(stack.targetSellPrice) || null,
      sellOrderId: stack.sellOrderId || null,
      state: stack.state,
      partialSellFrozen,
      sellReason: stack.sellReason || null,
      sellReasonDetail: stack.sellReasonDetail || null,
      openedAt: stack.openedAt || (stack.buyLayers?.[0]?.filledAt) || stack.createdAt,
      closedAt: stack.stackClosedAt || stack.sellFilledAt || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;