'use strict';

const { isCBv2At, isCBAt } = require('../src/core/signalEngine');

// FIX-2026-08-09: isCBv2At unit tests — Pine cbv2 semantics (4 consecutive red below lowerKC)
//   - CBv2 = sls12 AND sls12[1]  where sls12 = 3 consecutive red below lowerKC (Pine sls12 = i,i-1,i-2)
//   - CBv2 therefore = 4 consecutive red candles fully below lowerKC (i-3, i-2, i-1, i)
//   - CB (= isCBAt) = 3 consecutive red below lowerKC (Pine sls12)
//   - เดิม JS isCBAt checks 4 candles (off-by-one) → CBv2 = 5 candles ที่ผิด
//   - หลัง fix: isCBAt checks 3 candles → CBv2 = 4 candles (Pine-correct)

function mkScenario(n, mode) {
  // mode = 'full'  → 4 consecutive red below lowerKC at i-3..i
  // mode = 'gap3'  → 3 consecutive red below lowerKC at i-2..i (i-3 is green) → CB fires but CBv2 doesn't
  // mode = 'above' → one bar (i-1) close >= lowerKC → CBv2 doesn't fire
  // mode = 'green' → i-1 has open <= close (green) → CBv2 doesn't fire
  // mode = 'nullLK' → some lowerKC value is null → CBv2 doesn't fire
  const opens = new Array(n).fill(100);
  const closes = new Array(n).fill(99); // red: open > close
  const lower = new Array(n).fill(101); // price well below lowerKC
  if (mode === 'gap3') {
    // i-3 is green (open < close) — but isCBAt only checks i, i-1, i-2 (3 candles) so i-3 doesn't matter
    // CBv2 needs 4 consecutive red (i-3..i) → i-3 green breaks CBv2; CB still fires (3 candles i-2..i)
    opens[n - 4] = 95;
    closes[n - 4] = 100;
  } else if (mode === 'above') {
    // i-1's lowerKC is below the candle (price ≥ lowerKC)
    lower[n - 2] = 50; // any value below the closes (99) ─ price is above the lowerKC
  } else if (mode === 'green') {
    // i-1 has open ≤ close (green)
    opens[n - 2] = 95;
    closes[n - 2] = 100;
  } else if (mode === 'nullLK') {
    lower[n - 2] = null;
  }
  return { opens, closes, lower };
}

describe('isCBv2At — Pine cbv2 semantics (4 consecutive red below lowerKC)', () => {
  test('returns true when 4 consecutive red candles are fully below lowerKC', () => {
    const { opens, closes, lower } = mkScenario(10, 'full');
    expect(isCBv2At(9, opens, closes, lower)).toBe(true);
  });

  test('returns false when only 3 consecutive red candles below lowerKC (CB fires but CBv2 does not)', () => {
    // gap3: i-3 is green → breaks 4-candle sequence for CBv2
    // CB (isCBAt at i=9) checks 9, 8, 7 — all RED+below → CB fires
    // CBv2 (isCBAt at i=9 AND isCBAt at i=8) — isCBAt(8) checks 8, 7, 6 where 6 is GREEN → CBv2 doesn't fire
    const { opens, closes, lower } = mkScenario(10, 'gap3');
    expect(isCBv2At(9, opens, closes, lower)).toBe(false);
    expect(isCBAt(9, opens, closes, lower)).toBe(true);  // CB fires (3 candles)
    expect(isCBAt(8, opens, closes, lower)).toBe(false); // CB doesn't fire at i-1 (candle 6 is green)
  });

  test('returns false when i < 3 (insufficient history for 4 consecutive candles)', () => {
    const { opens, closes, lower } = mkScenario(10, 'full');
    // i=3: isCBAt(3) checks 3,2,1; isCBAt(2) checks 2,1,0 → all red+below → CBv2 fires at i=3
    expect(isCBv2At(3, opens, closes, lower)).toBe(true);
    // i=2: isCBAt(2) checks 2,1,0; isCBAt(1) requires i>=2 → FALSE → CBv2 doesn't fire
    expect(isCBv2At(2, opens, closes, lower)).toBe(false);
    // i=0: isCBAt(0) requires i>=2 → FALSE → CBv2 doesn't fire
    expect(isCBv2At(0, opens, closes, lower)).toBe(false);
  });

  test('returns false when one of the previous 2 candles is green (open <= close)', () => {
    // i-1 (n-2) is green — both isCBAt(i) and isCBAt(i-1) fail
    const { opens, closes, lower } = mkScenario(10, 'green');
    expect(isCBv2At(9, opens, closes, lower)).toBe(false);
  });

  test('returns false when one of the previous 2 candles has close >= lowerKC', () => {
    const { opens, closes, lower } = mkScenario(10, 'above');
    expect(isCBv2At(9, opens, closes, lower)).toBe(false);
  });

  test('returns false when a lowerKC value is null', () => {
    const { opens, closes, lower } = mkScenario(10, 'nullLK');
    expect(isCBv2At(9, opens, closes, lower)).toBe(false);
  });

  test('isCBv2At(i) implies isCBAt(i) — CBv2 is strictly stronger than CB', () => {
    const { opens, closes, lower } = mkScenario(10, 'full');
    expect(isCBv2At(9, opens, closes, lower)).toBe(true);
    expect(isCBAt(9, opens, closes, lower)).toBe(true);
  });

  test('CB can fire without CBv2 firing (3 consecutive red without 4 consecutive)', () => {
    // Pine semantics: CB (3 candles) fires but CBv2 (4 candles) requires i-3 to also be red+below
    // Setup: i-3 is GREEN → CB fires at i (only checks 9, 8, 7) but CBv2 needs i-3 also red
    const opens = new Array(10).fill(100);
    const closes = new Array(10).fill(99); // red
    const lower = new Array(10).fill(101); // price well below lowerKC
    opens[6] = 95; closes[6] = 100; // i-3 (idx 6) is GREEN
    // isCBAt(9) checks 9, 8, 7 (all red+below) → TRUE
    // isCBAt(8) checks 8, 7, 6 (6 is green) → FALSE
    // isCBv2At(9) = TRUE AND FALSE = FALSE
    expect(isCBAt(9, opens, closes, lower)).toBe(true);  // CB fires
    expect(isCBv2At(9, opens, closes, lower)).toBe(false); // CBv2 doesn't fire
  });

  test('CBv2 at i requires CB at both i AND i-1 (peeking pattern)', () => {
    // Build: i-1 is green → isCBAt(i-1) fails → CBv2 doesn't fire
    const opens = new Array(10).fill(100);
    const closes = new Array(10).fill(99); // red
    const lower = new Array(10).fill(101); // price well below lowerKC
    opens[8] = 95; closes[8] = 100; // i-1 (idx 8) is GREEN
    // isCBAt(9) checks 9, 8, 7 (8 is green) → FALSE
    // isCBv2At(9) = FALSE → CBv2 doesn't fire
    expect(isCBAt(9, opens, closes, lower)).toBe(false);
    expect(isCBv2At(9, opens, closes, lower)).toBe(false);
  });
});
