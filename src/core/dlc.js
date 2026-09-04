'use strict';
// ═══════════════════════════════════════════════════════════════════════
// FIX-2026-09-04: Dynamic Layer Control (DLC) engine
//   - Position-aware layer gate (replaces rigid maxTrades count)
//   - threshold[i] = dlcBaseLossPct * (k - i), k=open positions, i=0=oldest
//   - example (base=-10):
//       k=1, i=0 → threshold=-10  (avg-down a single losing position needs <-10%)
//       k=2, i=0 → threshold=-20, i=1 → threshold=-10
//       k=3, i=0 → threshold=-30, i=1 → -20, i=2 → -10
//   - PnL for open positions computed on-the-fly from currentPrice vs buyPrice
//     (Trade.pnlPercent is null until SELL fills — gross formula matches
//      src/core/backtester.js:1998-2001 pattern)
//   - Mutex with DCA/Martingale enforced upstream in routes + UI
//   - Engine is PURE: evaluate() takes cfg + positions, no I/O
// ═══════════════════════════════════════════════════════════════════════

const Trade = require('../db/models/Trade');

const DEFAULTS = {
  baseLossPct: -10,
};

/**
 * Normalize DLC config — fills missing/invalid values with DEFAULTS.
 * @param {Object} [cfg]
 * @returns {{baseLossPct: number}}
 */
function normalizeConfig(cfg = {}) {
  const raw = cfg && cfg.baseLossPct;
  return {
    baseLossPct: Number.isFinite(raw) ? raw : DEFAULTS.baseLossPct,
  };
}

/**
 * Pure-function DLC gate evaluation.
 * @param {Object} args
 *   cfg       - {baseLossPct} from normalizeConfig()
 *   positions - Array<{buyPrice, currentPrice, buyFilledAt, symbol}>
 *               sorted ASC by buyFilledAt (oldest first)
 * @returns {{allow: boolean, reason?: string, blockingIdx?: number, threshold?: number, openCount?: number}}
 *   allow=true           → may proceed with BUY signal
 *   allow=false          → block; reason='price-unavailable' | 'threshold-not-met'
 *   blockingIdx (0..k-1) → which position failed first (0=oldest)
 *   threshold            → required pnl% that position[i] did NOT meet
 *   openCount            → k (echo of positions.length for log clarity)
 */
function evaluate({ cfg, positions }) {
  const k = positions.length;
  const base = cfg.baseLossPct;
  if (k === 0) return { allow: true, openCount: 0 };
  for (let i = 0; i < k; i++) {
    const p = positions[i];
    if (p.currentPrice == null || p.buyPrice == null || p.buyPrice <= 0) {
      return { allow: false, reason: 'price-unavailable', blockingIdx: i, openCount: k };
    }
    const grossPct = ((p.currentPrice - p.buyPrice) / p.buyPrice) * 100;
    const threshold = base * (k - i);
    if (grossPct >= threshold) {
      return {
        allow: false,
        reason: 'threshold-not-met',
        blockingIdx: i,
        threshold,
        openCount: k,
      };
    }
  }
  return { allow: true, openCount: k };
}

/**
 * Load open positions for a bot, sorted ASC by buyFilledAt (oldest first),
 * with `currentPrice` injected via caller-supplied lookup.
 *
 * @param {ObjectId|string} botId
 * @param {Function} [priceLookup] (symbol) => currentPrice | null
 * @returns {Promise<Array<{buyPrice, currentPrice, buyFilledAt, symbol}>>}
 */
async function loadPositions(botId, priceLookup) {
  const docs = await Trade.find({
    botId,
    state: { $in: ['placed', 'filled', 'holding', 'selling'] },
  })
    .sort({ buyFilledAt: 1 })
    .select({ buyPrice: 1, buyFilledAt: 1, symbol: 1 })
    .lean();
  return docs.map((d) => ({
    buyPrice: d.buyPrice,
    buyFilledAt: d.buyFilledAt,
    symbol: d.symbol,
    currentPrice: typeof priceLookup === 'function' ? priceLookup(d.symbol) : null,
  }));
}

module.exports = { DEFAULTS, normalizeConfig, evaluate, loadPositions };
