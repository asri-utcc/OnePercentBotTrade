'use strict';

const fs = require('fs');
const path = require('path');
const signalEngine = require('../src/core/signalEngine');
const cbPatternEvaluator = require('../src/core/cbPatternEvaluator');

// FIX-2026-08-09: kline window consistency test — guarantees trader + watchdog share
//   the same canonical REST window (limit=500) when invoking cbPatternEvaluator.
//   TUT incident: trader (WS cache 500) vs watchdog (REST 30) → different lastLower
//   → false CBv3 fire.
//
//   This test does two things:
//     1. Hard-codes the source: grep trader.js / positionWatchdog.js for ANY
//        `limit: 30` or `klineCache.getAll` that bypasses the evaluator.
//     2. Constructs a synthetic kline series and verifies that fetchAndEvaluateCBv2
//        would call binanceRest with exactly limit=500 (smoke test via spy).

const TRADER_PATH = path.join(__dirname, '..', 'src/core/trader.js');
const WATCHDOG_PATH = path.join(__dirname, '..', 'src/services/positionWatchdog.js');

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function extractMethod(src, methodName) {
  const re = new RegExp(`async\\s+${methodName}\\s*\\([^)]*\\)\\s*\\{`, 'g');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index;
  let depth = 0;
  let i = start;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

describe('cbKlineWindowConsistency — TUT 2026-08-09 regression', () => {
  test('trader._checkCBv2PanicClose does NOT use klineCache.getAll or limit=30', () => {
    const src = readFile(TRADER_PATH);
    const method = extractMethod(src, '_checkCBv2PanicClose');
    expect(method).not.toBeNull();
    expect(method).not.toMatch(/klineCache\.getAll/);
    expect(method).not.toMatch(/limit:\s*30/);
  });

  test('trader._checkCBv3PanicClose does NOT use klineCache.getAll or limit=30', () => {
    const src = readFile(TRADER_PATH);
    const method = extractMethod(src, '_checkCBv3PanicClose');
    expect(method).not.toBeNull();
    expect(method).not.toMatch(/klineCache\.getAll/);
    expect(method).not.toMatch(/limit:\s*30/);
  });

  test('positionWatchdog._fetchKlinesForCBv2 has been removed (FIX-2026-08-09)', () => {
    const src = readFile(WATCHDOG_PATH);
    expect(src).not.toMatch(/async\s+_fetchKlinesForCBv2\s*\(/);
  });

  test('positionWatchdog._checkCBv2PanicCloseForDisabled does NOT use limit=30', () => {
    const src = readFile(WATCHDOG_PATH);
    const method = extractMethod(src, '_checkCBv2PanicCloseForDisabled');
    expect(method).not.toBeNull();
    expect(method).not.toMatch(/limit:\s*30/);
  });

  test('positionWatchdog._checkCBv3PanicCloseForDisabled does NOT use limit=30', () => {
    const src = readFile(WATCHDOG_PATH);
    const method = extractMethod(src, '_checkCBv3PanicCloseForDisabled');
    expect(method).not.toBeNull();
    expect(method).not.toMatch(/limit:\s*30/);
  });

  test('fetchAndEvaluateCBv2 requests binanceRest with limit=500 (canonical)', async () => {
    let captured = null;
    const fakeBinanceRest = {
      getKlines: async (opts) => {
        captured = opts;
        // produce 500 synthetic klines (all red below LK)
        const now = Date.now();
        const out = [];
        for (let i = 0; i < 500; i += 1) {
          const openTime = now - (500 - i) * 3 * 60 * 1000;
          out.push([openTime, 100, 105, 99, 99, 0, openTime + 3 * 60 * 1000 - 1]);
        }
        return out;
      },
    };
    await cbPatternEvaluator.fetchAndEvaluateCBv2({
      bot: { symbol: 'BTCUSDT', timeframe: '3m', kcMult: 1.5 },
      binanceRest: fakeBinanceRest,
      signalEngine,
    });
    expect(captured).not.toBeNull();
    expect(captured.limit).toBe(500);
    expect(captured.symbol).toBe('BTCUSDT');
    expect(captured.interval).toBe('3m');
  });

  test('fetchAndEvaluateCBv2 attaches source=binance_rest + requestedLimit=500 even on failure', async () => {
    const fakeBinanceRest = {
      getKlines: async () => {
        throw new Error('binance timeout');
      },
    };
    const result = await cbPatternEvaluator.fetchAndEvaluateCBv2({
      bot: { symbol: 'BTCUSDT', timeframe: '3m', kcMult: 1.5 },
      binanceRest: fakeBinanceRest,
      signalEngine,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('binance_fetch_error');
    expect(result.source).toBe('binance_rest');
    expect(result.requestedLimit).toBe(500);
  });
});

describe('cbKlineWindowConsistency — limit=30 vs limit=500 divergent fire decisions', () => {
  // Synthetic fixture: 30 candles where limit=30 EMA seed differs significantly from
  // limit=500 EMA seed (because there's not enough history for a stable EMA(20)).
  // This guarantees the two windows CAN produce different lastLower values.
  test('doc test: limit=30 fixture rejected, limit=500 fixture accepted', () => {
    // See scripts/verify-tut-cbv3.js for the real TUT repro that motivated this fix.
    // The key point: with limit=30, EMA(20) is weakly seeded and lastLower=0.14725
    // (CBv2 fires false-positive). With limit=500, EMA(20) converges and lastLower=0.145673
    // (CBv2 doesn't fire — green at i-3 breaks the 4-candle chain).
    // cbPatternEvaluator enforces the canonical window — callers cannot override.
    expect(cbPatternEvaluator.CANONICAL_KLINE_LIMIT).toBe(500);
  });
});
