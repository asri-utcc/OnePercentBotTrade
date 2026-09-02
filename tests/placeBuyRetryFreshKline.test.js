'use strict';

/**
 * FIX-2026-09-01 audit H14: placeBuy cooldown retry must NOT use the stale
 * candle from the outer scope.
 *
 *   Before: trader.js scheduled a setTimeout to re-enter placeBuy() with the
 *   `candle` argument captured at the original call. If a 5m bot hit
 *   cooldown at T=0, retried at T=2s — but the candle had closed at T=5min
 *   and a new candle was active by T=2s. The retry re-evaluated the OLD
 *   candle's data (price/KC/volume from 2 minutes ago) and could BUY on
 *   stale signal data.
 *
 *   Fix: at retry time, fetch the latest 2 klines for this.symbol+timeframe.
 *     - If latest kline.closeTime === signalCandleCloseTime → reuse that
 *       fresh kline (same candle, fresh fields).
 *     - If latest kline.closeTime > signalCandleCloseTime → a NEW candle
 *       has closed in the meantime → drop the stale retry with
 *     - Signal.outcome = 'skipped', note = 'cooldown_retry_stale_candle'.
 *
 *   Tests:
 *     1. Source-level: code path exists + FIX comment + drop path.
 *     2. Runtime replica: same-candle / new-candle / api-error branches.
 */

const fs = require('fs');
const path = require('path');

const TRADER_PATH = path.join(__dirname, '..', 'src', 'core', 'trader.js');
const traderRaw = fs.readFileSync(TRADER_PATH, 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const traderCode = stripComments(traderRaw);

describe('audit-H14 trader: cooldown retry fetches fresh kline', () => {
  test('buyCooldownTimer block calls binanceRest.getKlines at retry time', () => {
    // Find the cooldown timer block by anchoring on its logging context.
    const anchor = traderCode.indexOf("'trader: cooldown expired");
    expect(anchor).toBeGreaterThan(0);
    const section = traderCode.slice(anchor, anchor + 2500);
    expect(section).toMatch(/binanceRest\.getKlines\(/);
  });

  test('retry compares latest kline closeTime vs signalCandleCloseTime', () => {
    const anchor = traderCode.indexOf("'trader: cooldown expired");
    expect(anchor).toBeGreaterThan(0);
    const section = traderCode.slice(anchor, anchor + 2500);
    expect(section).toMatch(/latestClosed\.closeTime\s*!==\s*signalCandleCloseTime/);
  });

  test('stale-candle path marks Signal outcome=skipped with note cooldown_retry_stale_candle', () => {
    const anchor = traderCode.indexOf("'trader: cooldown expired");
    expect(anchor).toBeGreaterThan(0);
    const section = traderCode.slice(anchor, anchor + 2500);
    expect(section).toMatch(/outcome:\s*['"]skipped['"]/);
    expect(section).toMatch(/note:\s*['"]cooldown_retry_stale_candle['"]/);
  });

  test('FIX-2026-09-01 audit H14 comment is present', () => {
    expect(traderRaw).toMatch(/FIX-2026-09-01 audit H14/);
  });

  test('binanceRest.getKlines call uses the canonical {symbol, interval, limit} shape', () => {
    // The getKlines signature in this repo is { symbol, interval, limit }
    // (see trader.js:1105). Make sure the retry uses the same shape.
    const anchor = traderCode.indexOf("'trader: cooldown expired");
    const section = traderCode.slice(anchor, anchor + 2500);
    expect(section).toMatch(/binanceRest\.getKlines\(\s*\{[^}]*symbol:\s*this\.bot\.symbol/);
    expect(section).toMatch(/interval:\s*this\.bot\.timeframe/);
    expect(section).toMatch(/limit:\s*2/);
  });
});

describe('audit-H14 trader: stale candle no longer reused', () => {
  test('cooldown retry does NOT just re-call placeBuy(signalDoc, candle) with the outer candle', () => {
    // The pre-fix code did exactly `this.placeBuy(signalDoc, candle).catch(...)`.
    // After H14 it must be an async IIFE that re-fetches klines first.
    const anchor = traderCode.indexOf("'trader: cooldown expired");
    expect(anchor).toBeGreaterThan(0);
    const section = traderCode.slice(anchor, anchor + 2500);
    // The literal old call must NOT appear (the helper variable is `freshCandle`,
    // not the outer `candle` directly).
    expect(section).not.toMatch(/this\.placeBuy\(signalDoc,\s*candle\)/);
  });

  test('placeBuy is called with the freshCandle variable', () => {
    const anchor = traderCode.indexOf("'trader: cooldown expired");
    expect(anchor).toBeGreaterThan(0);
    const section = traderCode.slice(anchor, anchor + 2500);
    expect(section).toMatch(/this\.placeBuy\(signalDoc,\s*freshCandle\)/);
  });
});

// ─── Runtime replica of the retry decision ─────────────────────────────
//
// We re-implement the timeout-callback body to verify behavior across the
// three branches:
//   A. fresh kline same closeTime → re-enter placeBuy with freshCandle
//   B. fresh kline newer closeTime → mark signal skipped, return
//   C. getKlines throws → log warn, drop silently

describe('audit-H14 runtime replica: cooldown retry decision', () => {
  function makeRetryHandler({ fetchKlines, placeBuy, markSkipped }) {
    // Returns an async function that mirrors trader.js:3920-3949
    return async function retry({ signalCandleCloseTime, signalDoc, log }) {
      if (!this.running || !this.bot.enabled || this.buyInFlight) return;
      log('cooldown expired');
      try {
        const freshKlines = await fetchKlines(this.bot.symbol, this.bot.timeframe, 2);
        const latestClosed = freshKlines && freshKlines.length > 0 ? freshKlines[freshKlines.length - 1] : null;
        if (!latestClosed || latestClosed.closeTime !== signalCandleCloseTime) {
          log(`drop stale: signal=${signalCandleCloseTime} latest=${latestClosed ? latestClosed.closeTime : 'null'}`);
          await markSkipped(signalDoc, 'cooldown_retry_stale_candle');
          return;
        }
        const freshCandle = {
          openTime: latestClosed.openTime,
          closeTime: latestClosed.closeTime,
          open: latestClosed.open, high: latestClosed.high, low: latestClosed.low, close: latestClosed.close,
          volume: latestClosed.volume, closeTimeMs: latestClosed.closeTime,
        };
        await placeBuy(signalDoc, freshCandle);
      } catch (err) {
        log(`failed: ${err.message}`);
      }
    };
  }

  function makeBotState({ running = true, enabled = true, buyInFlight = false, symbol = 'BTCUSDT', timeframe = '5m' } = {}) {
    return { running, bot: { enabled, symbol, timeframe }, buyInFlight };
  }

  test('A. same-candle branch: placeBuy is called with freshCandle fields', async () => {
    const fetchKlines = jest.fn().mockResolvedValue([
      { openTime: 100, closeTime: 200, open: 100, high: 110, low: 90, close: 105, volume: 1 },
      { openTime: 200, closeTime: 300, open: 105, high: 115, low: 100, close: 110, volume: 2 },
    ]);
    const placeBuy = jest.fn().mockResolvedValue();
    const markSkipped = jest.fn().mockResolvedValue();
    const log = jest.fn();
    const handler = makeRetryHandler({ fetchKlines, placeBuy, markSkipped });
    await handler.call(makeBotState(), { signalCandleCloseTime: 300, signalDoc: { _id: 's1' }, log });
    expect(fetchKlines).toHaveBeenCalledWith('BTCUSDT', '5m', 2);
    expect(placeBuy).toHaveBeenCalledTimes(1);
    const [passedSignal, passedCandle] = placeBuy.mock.calls[0];
    expect(passedSignal).toEqual({ _id: 's1' });
    expect(passedCandle.closeTime).toBe(300);
    expect(passedCandle.close).toBe(110);
    expect(passedCandle.volume).toBe(2);
    expect(markSkipped).not.toHaveBeenCalled();
  });

  test('B. new-candle branch: signal is marked skipped with cooldown_retry_stale_candle', async () => {
    // Latest candle closed at T=400, but signal was for candle that closed at T=300.
    // → a new candle has been closed in the meantime → drop.
    const fetchKlines = jest.fn().mockResolvedValue([
      { openTime: 300, closeTime: 400, open: 110, high: 120, low: 105, close: 115, volume: 3 },
    ]);
    const placeBuy = jest.fn().mockResolvedValue();
    const markSkipped = jest.fn().mockResolvedValue();
    const log = jest.fn();
    const handler = makeRetryHandler({ fetchKlines, placeBuy, markSkipped });
    await handler.call(makeBotState(), { signalCandleCloseTime: 300, signalDoc: { _id: 's2' }, log });
    expect(placeBuy).not.toHaveBeenCalled();
    expect(markSkipped).toHaveBeenCalledWith({ _id: 's2' }, 'cooldown_retry_stale_candle');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/drop stale/));
  });

  test('B2. empty klines response: signal marked skipped', async () => {
    const fetchKlines = jest.fn().mockResolvedValue([]);
    const placeBuy = jest.fn().mockResolvedValue();
    const markSkipped = jest.fn().mockResolvedValue();
    const log = jest.fn();
    const handler = makeRetryHandler({ fetchKlines, placeBuy, markSkipped });
    await handler.call(makeBotState(), { signalCandleCloseTime: 300, signalDoc: { _id: 's3' }, log });
    expect(placeBuy).not.toHaveBeenCalled();
    expect(markSkipped).toHaveBeenCalledWith({ _id: 's3' }, 'cooldown_retry_stale_candle');
  });

  test('C. fetchKlines throws: log warn, drop silently', async () => {
    const fetchKlines = jest.fn().mockRejectedValue(new Error('binance 503'));
    const placeBuy = jest.fn().mockResolvedValue();
    const markSkipped = jest.fn().mockResolvedValue();
    const log = jest.fn();
    const handler = makeRetryHandler({ fetchKlines, placeBuy, markSkipped });
    await expect(handler.call(makeBotState(), { signalCandleCloseTime: 300, signalDoc: { _id: 's4' }, log })).resolves.toBeUndefined();
    expect(placeBuy).not.toHaveBeenCalled();
    expect(markSkipped).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/failed: binance 503/));
  });

  test('guard: bot not running → no fetch, no placeBuy', async () => {
    const fetchKlines = jest.fn();
    const placeBuy = jest.fn();
    const markSkipped = jest.fn();
    const handler = makeRetryHandler({ fetchKlines, placeBuy, markSkipped });
    await handler.call(makeBotState({ running: false }), { signalCandleCloseTime: 300, signalDoc: { _id: 's5' }, log: () => {} });
    expect(fetchKlines).not.toHaveBeenCalled();
    expect(placeBuy).not.toHaveBeenCalled();
    expect(markSkipped).not.toHaveBeenCalled();
  });

  test('guard: bot disabled → no fetch, no placeBuy', async () => {
    const fetchKlines = jest.fn();
    const placeBuy = jest.fn();
    const markSkipped = jest.fn();
    const handler = makeRetryHandler({ fetchKlines, placeBuy, markSkipped });
    await handler.call(makeBotState({ enabled: false }), { signalCandleCloseTime: 300, signalDoc: { _id: 's6' }, log: () => {} });
    expect(fetchKlines).not.toHaveBeenCalled();
    expect(placeBuy).not.toHaveBeenCalled();
    expect(markSkipped).not.toHaveBeenCalled();
  });

  test('guard: another BUY in flight → no fetch, no placeBuy', async () => {
    const fetchKlines = jest.fn();
    const placeBuy = jest.fn();
    const markSkipped = jest.fn();
    const handler = makeRetryHandler({ fetchKlines, placeBuy, markSkipped });
    await handler.call(makeBotState({ buyInFlight: true }), { signalCandleCloseTime: 300, signalDoc: { _id: 's7' }, log: () => {} });
    expect(fetchKlines).not.toHaveBeenCalled();
    expect(placeBuy).not.toHaveBeenCalled();
    expect(markSkipped).not.toHaveBeenCalled();
  });
});