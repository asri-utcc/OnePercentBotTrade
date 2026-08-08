'use strict';

/**
 * FIX-2026-08-08: Feature #3 — Auto Unlock Cooldown (CBv2/CBv3)
 *   - per-bot toggle: cbAutoUnlockEnabled (default false)
 *   - threshold Pct: cbAutoUnlockThresholdPct (default 1.0, range 0.5..5.0)
 *   - count: cbAutoUnlockSignalsFound (reset on CB fire)
 *   - on tick: scan candles since last CB fire, evaluate S1 signals
 *     - signal candle close vs next candle high → if >thresholdPct → counts as profitable signal
 *   - if count >= 3 → unlock immediately (no whipsaw guard per user request)
 *   - all numeric math uses candles (no real trades)
 *   - returns { unlocked: bool, signalsFound: number, threshold: number, signals: [...] }
 *
 * NOTE: This is a hedged feature — design rationale:
 *   - Auto-unlock counterbalances long CB cooldown
 *   - User explicitly chose "no whipsaw guard" → accepts loop risk
 *   - 3-signals requirement is a soft ballot of "market is back"
 *   - All math is candle-based (no real PnL) — sample bias acknowledged
 */

const Bot = require('../db/models/Bot');
const binanceRest = require('../binance/binanceRest');
const klineCache = require('../services/klineCache');
const logger = require('../utils/logger');
const eventBus = require('../services/eventBus');
const masterConfig = require('./masterConfig'); // FIX-2026-08-08: master toggle gate

const REQUIRED_SIGNALS = 3;
const KLINE_FETCH_LIMIT = 100; // ~enough for 3 S1 signals even on 1h TF

/**
 * FIX-2026-08-08: evaluate() — check if bot should be auto-unlocked
 *   - skip if cbAutoUnlockEnabled !== true
 *   - skip if no cooldown active
 *   - get candles since CB fire (from cbv2LastFiredAt or cbv3LastFiredAt)
 *   - compute S1 signals (using bot's kcMult, s1OnlyDown, xs1Enabled)
 *   - for each signal: hypothetical profit = (next candle high - signal close) / signal close * 100
 *   - count signals where hypothetical profit > threshold
 *   - if count >= 3 → unlock (clear cbv2LockedUntil + cbv3LockedUntil + reset trader._cbv2FiredAt / _cbv3FiredAt)
 *
 * @param {Object} bot - Bot doc (or lean) — must include cbAutoUnlockEnabled, cbAutoUnlockThresholdPct, cbAutoUnlockSignalsFound, symbol, timeframe, kcMult, s1OnlyDown, xs1Enabled, cbv2LastFiredAt OR cbv3LastFiredAt
 * @returns {Object} { unlocked, signalsFound, threshold, signals, skipped }
 */
async function evaluate(bot) {
  if (!bot) return { unlocked: false, skipped: 'no-bot' };
  // FIX-2026-08-08: master switch (AppConfig.masterCbAutoUnlockEnabled, default false)
  //   - if master on → globally allow auto-unlock (per-bot cbAutoUnlockEnabled still respected)
  //   - if master off → globally disable auto-unlock (per-bot true → skip with 'master-off')
  //   - bot._masterCbAutoUnlockEnabled is stamped by caller from masterConfig.getMasterToggles()
  if (bot.cbAutoUnlockEnabled === true && bot._masterCbAutoUnlockEnabled === false) {
    return { unlocked: false, skipped: 'master-off' };
  }
  if (bot.cbAutoUnlockEnabled !== true) {
    return { unlocked: false, skipped: 'disabled' };
  }
  const threshold = Math.max(0.5, Math.min(5.0, Number(bot.cbAutoUnlockThresholdPct) || 1.0));

  // Determine cooldown state
  const now = Date.now();
  const cbv2LockedUntilMs = bot.cbv2LockedUntil ? new Date(bot.cbv2LockedUntil).getTime() : 0;
  const cbv3LockedUntilMs = bot.cbv3LockedUntil ? new Date(bot.cbv3LockedUntil).getTime() : 0;
  const cbv2Active = cbv2LockedUntilMs > now;
  const cbv3Active = cbv3LockedUntilMs > now;
  if (!cbv2Active && !cbv3Active) {
    // No cooldown → reset counter
    return { unlocked: false, skipped: 'no-cooldown', signalsFound: 0, threshold };
  }

  // Determine last CB fire timestamp (use whichever is more recent)
  const lastCbv2Ms = bot.cbv2LastFiredAt ? new Date(bot.cbv2LastFiredAt).getTime() : 0;
  const lastCbv3Ms = bot.cbv3LastFiredAt ? new Date(bot.cbv3LastFiredAt).getTime() : 0;
  const lastFireMs = Math.max(lastCbv2Ms, lastCbv3Ms);
  if (lastFireMs === 0) {
    return { unlocked: false, skipped: 'no-fire-timestamp', signalsFound: 0, threshold };
  }

  // Get klines since CB fire
  // Primary: klineCache (zero weight), fallback: REST
  let klines = klineCache.getAll(bot.symbol, bot.timeframe) || [];
  let usedCache = true;
  if (klines.length < 50) {
    try {
      const raw = await binanceRest.getKlines({
        symbol: bot.symbol,
        interval: bot.timeframe,
        limit: KLINE_FETCH_LIMIT,
      });
      klines = raw.map((k) => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        closeTime: k[6],
      }));
      usedCache = false;
    } catch (err) {
      logger.warn({ botId: String(bot._id), err: err.message }, 'cbAutoUnlock: kline fetch failed (cache + REST)');
      return { unlocked: false, skipped: 'kline-fetch-failed', signalsFound: 0, threshold };
    }
  }
  if (klines.length < 22) {
    return { unlocked: false, skipped: 'insufficient-klines', signalsFound: 0, threshold };
  }

  const signalEngine = require('./signalEngine');
  const { signals: allSignals } = signalEngine.detectS1Signals(klines, {
    mult: bot.kcMult || 1.5,
    onlyDown: !!bot.s1OnlyDown,
    xs1Enabled: bot.xs1Enabled !== false,
  });

  // Filter signals that occurred AFTER CB fire
  const newSignals = allSignals.filter((s) => s.openTime >= lastFireMs);
  if (newSignals.length === 0) {
    return { unlocked: false, skipped: 'no-signals-since-fire', signalsFound: 0, threshold };
  }

  // For each signal, compute hypothetical profit = (next candle high - signal close) / signal close * 100
  const profitableSignals = [];
  for (const sig of newSignals) {
    const sigIdx = klines.findIndex((k) => k.openTime === sig.openTime);
    if (sigIdx < 0 || sigIdx >= klines.length - 1) continue; // missing next candle
    const nextCandle = klines[sigIdx + 1];
    if (!nextCandle) continue;
    const profitPct = ((nextCandle.high - sig.close) / sig.close) * 100;
    if (profitPct > threshold) {
      profitableSignals.push({
        openTime: sig.openTime,
        signalClose: sig.close,
        nextHigh: nextCandle.high,
        profitPct: Number(profitPct.toFixed(4)),
      });
    }
  }

  const signalsFound = profitableSignals.length;
  const unlocked = signalsFound >= REQUIRED_SIGNALS;

  return {
    unlocked,
    signalsFound,
    threshold,
    candlesticksScanned: klines.length,
    usedCache,
    signals: profitableSignals,
    skipped: null,
  };
}

/**
 * FIX-2026-08-08: applyUnlock() — actually clear cooldown fields if metric threshold met
 *   - clear cbv2LockedUntil + cbv3LockedUntil + cbv2LockReason + cbv3LockReason
 *   - clear cbv2LastFiredAt + cbv3LastFiredAt
 *   - reset counted signals
 *   - emit bot:unlocked event
 *   - returns { ok: true, unlockedAt, version: 'v2'|'v3' }
 */
async function applyUnlock(bot, evalResult) {
  if (!evalResult || !evalResult.unlocked) return { ok: false, reason: 'not-unlocked' };
  const now = new Date();
  const update = {
    cbv2LockedUntil: null,
    cbv2LockReason: null,
    cbv2LastFiredAt: null,
    cbv3LockedUntil: null,
    cbv3LockReason: null,
    cbv3LastFiredAt: null,
    cbAutoUnlockSignalsFound: 0,
    cbAutoUnlockCheckedAt: now,
  };
  await Bot.updateOne({ _id: bot._id }, { $set: update });
  eventBus.emit('bot:unlocked', {
    botId: String(bot._id),
    source: 'auto-unlock',
    signalsFound: evalResult.signalsFound,
    threshold: evalResult.threshold,
  });
  // FIX-2026-08-08: reset in-memory trader (if running) for instant BUY gate reset
  try {
    const botManager = require('./botManager');
    const trader = botManager.traders && botManager.traders.get(String(bot._id));
    if (trader) {
      if (Number.isFinite(trader._cbv2FiredAt)) trader._cbv2FiredAt = 0;
      if (Number.isFinite(trader._cbv3FiredAt)) trader._cbv3FiredAt = 0;
    }
  } catch (traderErr) {
    logger.warn({ err: traderErr.message }, 'cbAutoUnlock: trader reset failed (non-fatal)');
  }
  return { ok: true, unlockedAt: now, signalsFound: evalResult.signalsFound };
}

module.exports = {
  evaluate,
  applyUnlock,
  REQUIRED_SIGNALS,
};
