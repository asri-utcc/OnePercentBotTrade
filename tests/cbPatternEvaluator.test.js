'use strict';

// FIX-2026-08-09: cbPatternEvaluator unit tests — TUT false-positive regression coverage
//   - TUT incident 2026-08-09 17:18 BKK: trader WS cache (500) vs watchdog REST (30)
//     → different lastLower → CBv3 fired despite green candle at i-3
//   - cbPatternEvaluator centralizes window + 2-tick confirmation
//   - Pure helpers → testable without DB/Binance mocks
//
//   Note: real signalEngine.isCBv2At requires prices WELL below lowerKC. Many test
//   pairs mock signalEngine.computeBgStates / isCBv2At directly to control the
//   KC output and avoid price-engineering fragile synthetic fixtures.

const realSignalEngine = require('../src/core/signalEngine');
const cbPatternEvaluator = require('../src/core/cbPatternEvaluator');
const {
  CANONICAL_KLINE_LIMIT,
  KC_LENGTH,
  MIN_EVALUATION_CANDLES,
  MIN_PATTERN_CANDLES,
  REQUIRED_CONFIRMATIONS,
  normalizeKlines,
  buildFingerprint,
  countConsecutiveBreach,
  evaluateCBv2Snapshot,
  recordConfirmation,
  getConfirmationCount,
  consumeConfirmation,
  _resetConfirmationRegistry,
} = cbPatternEvaluator;

function mkKlines(n, opts = {}) {
  // Generate deterministic synthetic klines.
  const now = Date.now();
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const openTime = now - (n - i) * 3 * 60 * 1000;
    const closeTime = openTime + 3 * 60 * 1000 - 1;
    let o = 100;
    let c = 99;
    if (opts.mode === 'green_at_idx' && i === n - 4) {
      o = 95;
      c = 100;
    }
    out.push([openTime, o, o + 1, c - 1, c, 0, closeTime]);
  }
  return out;
}

describe('cbPatternEvaluator — constants', () => {
  test('CANONICAL_KLINE_LIMIT = 500 (matches default WS cache window)', () => {
    expect(CANONICAL_KLINE_LIMIT).toBe(500);
  });
  test('KC_LENGTH = 20 (Pine standard KC length)', () => {
    expect(KC_LENGTH).toBe(20);
  });
  test('MIN_PATTERN_CANDLES = 4 (CBv2 = 4 consecutive red below lowerKC)', () => {
    expect(MIN_PATTERN_CANDLES).toBe(4);
  });
  test('MIN_EVALUATION_CANDLES = 23 (20 EMA + 3 isCBv2At lookup)', () => {
    expect(MIN_EVALUATION_CANDLES).toBe(23);
  });
  test('REQUIRED_CONFIRMATIONS = 2 (2-tick defense-in-depth)', () => {
    expect(REQUIRED_CONFIRMATIONS).toBe(2);
  });
});

describe('cbPatternEvaluator.normalizeKlines', () => {
  test('returns [] for non-array input', () => {
    expect(normalizeKlines(null)).toEqual([]);
    expect(normalizeKlines(undefined)).toEqual([]);
    expect(normalizeKlines('garbage')).toEqual([]);
  });

  test('parses Binance tuple format [openTime, open, high, low, close, vol, closeTime]', () => {
    const now = Date.now() - 1000; // ensure closed
    const raw = [[now, 100, 105, 99, 100, 0, now + 1000]];
    const out = normalizeKlines(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      openTime: now, closeTime: now + 1000,
      open: 100, high: 105, low: 99, close: 100,
    });
  });

  test('drops in-progress candles (closeTime > now)', () => {
    const now = Date.now();
    const raw = [
      [now - 10000, 100, 105, 99, 100, 0, now - 5000], // closed
      [now, 100, 105, 99, 100, 0, now + 30000], // in-progress (3m candle)
    ];
    const out = normalizeKlines(raw);
    expect(out).toHaveLength(1);
    expect(out[0].closeTime).toBe(now - 5000);
  });

  test('drops malformed (NaN price) and short tuples', () => {
    expect(normalizeKlines([[1, 2, 3, 4]])).toEqual([]); // too short
    const out = normalizeKlines([[100, 'foo', 105, 99, 100, 0, 200]]);
    expect(out).toEqual([]);
  });

  test('dedupes by openTime', () => {
    const now = Date.now() - 1000;
    const raw = [
      [now, 100, 105, 99, 100, 0, now + 1000],
      [now, 100, 105, 99, 101, 0, now + 1000], // dup openTime
    ];
    const out = normalizeKlines(raw);
    expect(out).toHaveLength(1);
  });

  test('sorts by openTime ascending', () => {
    const now = Date.now() - 10000;
    const raw = [
      [now + 1000, 100, 105, 99, 100, 0, now + 1500],
      [now, 100, 105, 99, 100, 0, now + 500],
    ];
    const out = normalizeKlines(raw);
    expect(out).toHaveLength(2);
    expect(out[0].openTime).toBe(now);
    expect(out[1].openTime).toBe(now + 1000);
  });
});

describe('cbPatternEvaluator.buildFingerprint', () => {
  test('returns null when klines too short', () => {
    const klines = normalizeKlines(mkKlines(3));
    expect(klines).toHaveLength(3);
    expect(buildFingerprint(klines, 2)).toBeNull();
  });

  test('returns deterministic JSON over 4-candle window [lastIdx-3..lastIdx]', () => {
    const klines = normalizeKlines(mkKlines(30));
    const fp1 = buildFingerprint(klines, 29);
    const fp2 = buildFingerprint(klines, 29);
    expect(fp1).toBe(fp2);
    expect(typeof fp1).toBe('string');
    expect(JSON.parse(fp1)).toHaveLength(4);
  });

  test('fingerprints differ across distinct candle windows', () => {
    const klines = normalizeKlines(mkKlines(30));
    const fp1 = buildFingerprint(klines, 29);
    const fp2 = buildFingerprint(klines, 28);
    expect(fp1).not.toBe(fp2);
  });
});

describe('cbPatternEvaluator.countConsecutiveBreach', () => {
  test('returns 0 when last candle is red but not below LK', () => {
    const klines = normalizeKlines(mkKlines(30));
    const lower = new Array(klines.length).fill(50); // all candles way above LK
    const count = countConsecutiveBreach(klines, klines.length - 1, lower);
    expect(count).toBe(0);
  });

  test('returns 4 for all-red-below-LK at lastIdx', () => {
    const klines = normalizeKlines(mkKlines(30));
    const lower = new Array(klines.length).fill(200); // all candles below LK
    const count = countConsecutiveBreach(klines, klines.length - 1, lower);
    expect(count).toBe(4);
  });

  test('returns 3 when candle at i-3 is green (TUT borderline setup)', () => {
    const klines = normalizeKlines(mkKlines(30, { mode: 'green_at_idx' }));
    const lower = new Array(klines.length).fill(200); // all red candles below LK
    const count = countConsecutiveBreach(klines, klines.length - 1, lower);
    expect(count).toBe(3); // 3 consecutive red (i-2, i-1, i) — green at i-3 breaks chain
  });
});

describe('cbPatternEvaluator.evaluateCBv2Snapshot — TUT regression (with mocked signalEngine)', () => {
  // The real signalEngine.isCBv2At requires synthetic prices engineered to be below
  // EMA(20) - 1.5*ATR — fragile. We instead mock computeBgStates/isCBv2At to
  // inject deterministic KC and inspect pure evaluator semantics.
  function buildMockSignalEngine(lowerKC, isCBv2AtImpl) {
    return {
      computeBgStates: () => ({
        lower: lowerKC,
        upper: lowerKC,
        mid: lowerKC,
      }),
      isCBv2At: isCBv2AtImpl,
    };
  }

  test('TUT regression: green at i-3 → matched=false, consecutiveCount=3, isBorderline=true', () => {
    const klines = normalizeKlines(mkKlines(30, { mode: 'green_at_idx' }));
    const lowerKC = new Array(klines.length).fill(200); // all red candles below LK
    const signalEngine = buildMockSignalEngine(lowerKC, () => false); // pattern doesn't match
    const evaluation = evaluateCBv2Snapshot({
      bot: { kcMult: 1.5 },
      klines,
      targetCloseTime: null,
      signalEngine,
    });
    expect(evaluation.ok).toBe(true);
    expect(evaluation.matched).toBe(false);
    expect(evaluation.consecutiveCount).toBe(3); // CB fires, CBv2 doesn't
    expect(evaluation.isBorderline).toBe(true);
    expect(evaluation.fingerprint).toBeTruthy();
  });

  test('all-red-below-LK at lastIdx → matched=true, consecutiveCount=4', () => {
    const klines = normalizeKlines(mkKlines(30));
    const lowerKC = new Array(klines.length).fill(200); // all candles below LK
    const signalEngine = buildMockSignalEngine(lowerKC, () => true); // pattern matches
    const evaluation = evaluateCBv2Snapshot({
      bot: { kcMult: 1.5 },
      klines,
      targetCloseTime: null,
      signalEngine,
    });
    expect(evaluation.ok).toBe(true);
    expect(evaluation.matched).toBe(true);
    expect(evaluation.consecutiveCount).toBe(4);
    expect(evaluation.isBorderline).toBe(false);
  });

  test('warmup: klines < MIN_EVALUATION_CANDLES → ok=false, reason=warmup', () => {
    const klines = normalizeKlines(mkKlines(20));
    const lowerKC = new Array(klines.length).fill(200);
    const signalEngine = buildMockSignalEngine(lowerKC, () => true);
    const evaluation = evaluateCBv2Snapshot({
      bot: { kcMult: 1.5 },
      klines,
      targetCloseTime: null,
      signalEngine,
    });
    expect(evaluation.ok).toBe(false);
    expect(evaluation.reason).toBe('warmup');
    expect(evaluation.candlesCount).toBe(20);
  });

  test('exact candle lookup: targetCloseTime not in window → ok=false, reason=target_candle_not_found', () => {
    const klines = normalizeKlines(mkKlines(30));
    const lowerKC = new Array(klines.length).fill(200);
    const signalEngine = buildMockSignalEngine(lowerKC, () => true);
    const evaluation = evaluateCBv2Snapshot({
      bot: { kcMult: 1.5 },
      klines,
      targetCloseTime: 999999999999, // not in window
      signalEngine,
    });
    expect(evaluation.ok).toBe(false);
    expect(evaluation.reason).toBe('target_candle_not_found');
    expect(evaluation.targetCloseTime).toBe(999999999999);
  });

  test('exact candle lookup: targetCloseTime matches mid-window → uses that idx (not tail)', () => {
    const klines = normalizeKlines(mkKlines(30));
    const lowerKC = new Array(klines.length).fill(200);
    const signalEngine = buildMockSignalEngine(lowerKC, () => true);
    const targetIdx = 25;
    const targetCloseTime = klines[targetIdx].closeTime;
    const evaluation = evaluateCBv2Snapshot({
      bot: { kcMult: 1.5 },
      klines,
      targetCloseTime,
      signalEngine,
    });
    expect(evaluation.ok).toBe(true);
    expect(evaluation.lastIdx).toBe(targetIdx);
  });

  test('open candle included in REST tail → normalized filters it out', () => {
    const now = Date.now();
    const recent = mkKlines(29).map((t) => [t[0], t[1], t[2], t[3], t[4], 0, t[6]]);
    const openCandle = [now, 100, 105, 99, 100, 0, now + 30000]; // closeTime in future
    const raw = [...recent, openCandle];
    const klines = normalizeKlines(raw);
    expect(klines).toHaveLength(29); // open candle dropped
    expect(klines[klines.length - 1].closeTime).toBeLessThanOrEqual(now);
  });

  test('mock-computeBgStates throws → handled by ok=false', () => {
    const klines = normalizeKlines(mkKlines(30));
    const signalEngine = {
      computeBgStates: () => { throw new Error('KC failure'); },
      isCBv2At: () => false,
    };
    const evaluation = evaluateCBv2Snapshot({
      bot: { kcMult: 1.5 },
      klines,
      targetCloseTime: null,
      signalEngine,
    });
    expect(evaluation.ok).toBe(false);
  });
});

describe('cbPatternEvaluator — confirmation registry', () => {
  beforeEach(() => _resetConfirmationRegistry());

  test('recordConfirmation returns count=1 on first call', () => {
    const fp = 'fp1';
    const r = recordConfirmation({ botId: 'b1', version: 'v3', candleCloseTime: 100, fingerprint: fp });
    expect(r.count).toBe(1);
  });

  test('recordConfirmation same fp → count increments', () => {
    const fp = 'fp1';
    const r1 = recordConfirmation({ botId: 'b1', version: 'v3', candleCloseTime: 100, fingerprint: fp });
    const r2 = recordConfirmation({ botId: 'b1', version: 'v3', candleCloseTime: 100, fingerprint: fp });
    expect(r1.count).toBe(1);
    expect(r2.count).toBe(2);
  });

  test('recordConfirmation different fp → resets count to 1', () => {
    const r1 = recordConfirmation({ botId: 'b1', version: 'v3', candleCloseTime: 100, fingerprint: 'fp1' });
    const r2 = recordConfirmation({ botId: 'b1', version: 'v3', candleCloseTime: 100, fingerprint: 'fp2' });
    expect(r1.count).toBe(1);
    expect(r2.count).toBe(1);
  });

  test('getConfirmationCount returns 0 for unknown key', () => {
    const c = getConfirmationCount({ botId: 'unknown', version: 'v3', candleCloseTime: 999 });
    expect(c).toBe(0);
  });

  test('consumeConfirmation clears entry', () => {
    recordConfirmation({ botId: 'b1', version: 'v3', candleCloseTime: 100, fingerprint: 'fp' });
    expect(getConfirmationCount({ botId: 'b1', version: 'v3', candleCloseTime: 100 })).toBe(1);
    consumeConfirmation({ botId: 'b1', version: 'v3', candleCloseTime: 100 });
    expect(getConfirmationCount({ botId: 'b1', version: 'v3', candleCloseTime: 100 })).toBe(0);
  });

  test('CBv2 and CBv3 keys are independent', () => {
    recordConfirmation({ botId: 'b1', version: 'v2', candleCloseTime: 100, fingerprint: 'fp' });
    const v3Count = getConfirmationCount({ botId: 'b1', version: 'v3', candleCloseTime: 100 });
    expect(v3Count).toBe(0);
  });

  test('recordConfirmation expired entry → resets to 1', () => {
    const r1 = recordConfirmation({ botId: 'b1', version: 'v3', candleCloseTime: 100, fingerprint: 'fp', ttlMs: 1 });
    return new Promise((resolve) => {
      setTimeout(() => {
        const r2 = recordConfirmation({ botId: 'b1', version: 'v3', candleCloseTime: 100, fingerprint: 'fp' });
        expect(r1.count).toBe(1);
        expect(r2.count).toBe(1); // expired → new entry
        resolve();
      }, 10);
    });
  });

  test('recordConfirmation with null botId/candleCloseTime → safe no-op', () => {
    const r = recordConfirmation({ botId: null, version: 'v3', candleCloseTime: null, fingerprint: 'fp' });
    expect(r.count).toBe(0);
  });
});
