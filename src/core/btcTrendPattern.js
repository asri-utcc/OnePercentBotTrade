'use strict';

/**
 * BTC Trend Pattern — dual-KC state machine (Pine Script v5 port)
 *
 * Pine mapping (matches the tradingview "ฺBTC Trend Pattern" indicator):
 *   kcLen   = 20
 *   multIn  = 0.8   (inner KC)
 *   multOut = 2.2   (outer KC2)
 *
 *   basisKC  = ta.ema(close, kcLen)
 *   rngKC    = ta.atr(kcLen)  // Wilder RMA-based ATR
 *   upperKC  = basisKC + multIn  * rngKC   // inner
 *   lowerKC  = basisKC - multIn  * rngKC
 *   upperKC2 = basisKC + multOut * rngKC   // outer
 *   lowerKC2 = basisKC - multOut * rngKC
 *
 *   State machine emits one of 5 modes per candle:
 *     normal | waiting-boots | boots | waiting-break | break
 *
 *   This module returns plain arrays (mode per index + KC bands) so the
 *   HTTP layer can stream them straight to the browser. It reuses
 *   indicators.keltnerChannel() — already Pine-compatible and NaN-safe.
 *
 * FIX-2026-09-21: Initial port — read-only indicator page; no BUY/SELL hook.
 */

const { keltnerChannel } = require('./indicators');

const MODES = Object.freeze([
  'normal',
  'waiting-boots',
  'boots',
  'waiting-break',
  'break',
]);

const DEFAULT_KC_LEN = 20;
const DEFAULT_MULT_IN = 0.8;
const DEFAULT_MULT_OUT = 2.2;

/**
 * Compute dual-Keltner + mode state machine.
 *
 * @param {Array<{open:number, high:number, low:number, close:number}>} candles
 *        OHLC candles in chronological order (oldest first).
 * @param {object} [opts]
 * @param {number} [opts.kcLen=20]
 * @param {number} [opts.multInner=0.8]
 * @param {number} [opts.multOuter=2.2]
 * @returns {{
 *   basis:    (number|null)[],
 *   upperKC:  (number|null)[],
 *   lowerKC:  (number|null)[],
 *   upperKC2: (number|null)[],
 *   lowerKC2: (number|null)[],
 *   modes:    string[],
 *   warmupEnd: number,
 * }}
 */
function computeBtcTrendPattern(candles, opts = {}) {
  const kcLen = Number.isFinite(opts.kcLen) && opts.kcLen > 0 ? opts.kcLen : DEFAULT_KC_LEN;
  const multInner = Number.isFinite(opts.multInner) && opts.multInner > 0 ? opts.multInner : DEFAULT_MULT_IN;
  const multOuter = Number.isFinite(opts.multOuter) && opts.multOuter > 0 ? opts.multOuter : DEFAULT_MULT_OUT;

  const n = candles ? candles.length : 0;
  const empty = {
    basis: [], upperKC: [], lowerKC: [], upperKC2: [], lowerKC2: [],
    modes: [], warmupEnd: kcLen - 1,
  };
  if (n === 0) return empty;

  const highs = new Array(n);
  const lows = new Array(n);
  const closes = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const c = candles[i];
    highs[i] = Number(c && c.high);
    lows[i] = Number(c && c.low);
    closes[i] = Number(c && c.close);
  }

  // FIX-2026-09-21: reuse Pine-compatible EMA + Wilder ATR math from indicators.js
  const inner = keltnerChannel(highs, lows, closes, kcLen, multInner);
  const outer = keltnerChannel(highs, lows, closes, kcLen, multOuter);

  const basis = inner.basis;
  const upperKC = inner.upper;
  const lowerKC = inner.lower;
  const upperKC2 = outer.upper;
  const lowerKC2 = outer.lower;

  const modes = new Array(n).fill('normal');
  const WARMUP_END = kcLen - 1;
  let state = 'normal';

  for (let i = 0; i < n; i += 1) {
    if (i < WARMUP_END) {
      modes[i] = 'normal';
      continue;
    }
    // NaN guard: if any band is non-finite at this index (shouldn't happen post-warmup
    // but indicators.js sanitizes non-finite inputs), keep the previous state rather
    // than producing a false signal.
    if (
      !Number.isFinite(upperKC[i]) ||
      !Number.isFinite(lowerKC[i]) ||
      !Number.isFinite(upperKC2[i]) ||
      !Number.isFinite(lowerKC2[i])
    ) {
      modes[i] = state;
      continue;
    }

    const lo = lows[i];
    const hi = highs[i];

    switch (state) {
      case 'normal':
        if (lo < lowerKC2[i]) state = 'waiting-boots';
        else if (hi > upperKC2[i]) state = 'waiting-break';
        break;
      case 'waiting-boots':
        if (hi > lowerKC[i]) state = 'boots';
        break;
      case 'boots':
        // Fallback FIRST (Pine Script evaluates top-to-bottom; if both fire,
        // the lower-KC2 fallback wins → back to waiting-boots rather than
        // escalation to waiting-break).
        if (lo < lowerKC2[i]) state = 'waiting-boots';
        else if (hi > upperKC2[i]) state = 'waiting-break';
        break;
      case 'waiting-break':
        if (lo < upperKC[i]) state = 'break';
        break;
      case 'break':
        if (lo < lowerKC2[i]) state = 'waiting-boots';
        else if (hi > upperKC2[i]) state = 'waiting-break';
        break;
      default:
        state = 'normal';
    }
    modes[i] = state;
  }

  return { basis, upperKC, lowerKC, upperKC2, lowerKC2, modes, warmupEnd: WARMUP_END };
}

module.exports = {
  MODES,
  DEFAULT_KC_LEN,
  DEFAULT_MULT_IN,
  DEFAULT_MULT_OUT,
  computeBtcTrendPattern,
};