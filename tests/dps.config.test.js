'use strict';

/**
 * FIX-2026-08-08 (rev2): Pure-unit regression tests for Dynamic Position Sizing
 * FIX-2026-09-03: Layer-removal — tests now size-only (no layers assertions, no layer config keys)
 *
 *   ไม่ต้องการ MongoDB — ทดสอบแค่ engine logic ใน src/core/dynamicPositionSizing.js
 *   ครอบคลุม 6 บั๊กที่เจอ:
 *     A1) persistEval คืนก่อนเมื่อ !changed → history ไม่โต → Rule 1/2 ยิงไม่ได้
 *     A2) cooldown return ก่อน append history
 *     A3) clamp 6..15 บีบ capitalPerTrade ของ user
 *     A4) dynamicSizeCurrent override capitalPerTrade ถาวร (test ผ่าน resetStateUpdate)
 *     A5) ไม่มี minNotional floor (test ทาง config-level — floor อยู่ใน trader.js)
 *     A6) กฎยิงซ้ำจาก streak เดิม (resetHistoryOnFire)
 *
 *   + ครอบคลุมฟีเจอร์ใหม่ rev2:
 *     - normalizeConfig fallback (null/undefined/NaN → DEFAULTS)
 *     - bad-config guard (minSize > maxSize) + history ยังถูกบันทึก
 *     - dryRun (changed=false แต่คำนวณครบ + history บันทึก)
 *     - cooldown path returns newHistory (A2 fix)
 *     - resolveBounds anchored clamp (A3 fix)
 *     - custom config: 5-win streak / 2-loss streak / bigWinPct 3%
 *     - resetStateUpdate clears all 4 fields (layers dropped FIX-2026-09-03)
 */

const dps = require('../src/core/dynamicPositionSizing');

// FIX-2026-08-28 B6: DPS gate via license — default-ON for backward compat in tests
jest.mock('../src/services/licenseService', () => ({
  isFeatureEnabled: jest.fn().mockReturnValue(true),
  getMaxCapital: jest.fn().mockReturnValue(Infinity),
  withinMaxCapital: jest.fn().mockReturnValue(true),
}));

// helpers ──────────────────────────────────────────────────────────────────
const baseBot = (overrides = {}) => ({
  capitalPerTrade: 9,
  dynamicSizeEnabled: true,
  dynamicSizeCurrent: null,
  dynamicSizeLastResults: [],
  dynamicSizeCooldownUntil: null,
  ...overrides,
});

const win = (pnlPct = 1.0) => ({ isWin: true, pnlPct });
const loss = (pnlPct = -1.0) => ({ isWin: false, pnlPct });

// ─────────────────────────────────────────────────────────────────────────
// DEFAULTS — ค่าต้องตรงกับที่ AppConfig default ใช้
// ─────────────────────────────────────────────────────────────────────────
describe('DPS · DEFAULTS (FIX-2026-08-08 rev2)', () => {
  test('ค่า DEFAULTS ตรงกับพฤติกรรมเดิม (size 6..15, 3 wins → +1, 2 wins >2% → +2, 1 loss → -2)', () => {
    expect(dps.DEFAULTS).toEqual({
      minSize: 6, maxSize: 15,
      cooldownMs: 5 * 60 * 1000,
      winStreakCount: 3, winStreakDeltaSize: 1,
      bigWinCount: 2, bigWinPct: 2.0, bigWinDeltaSize: 2,
      lossStreakCount: 1, lossDeltaSize: -2,
      respectBotCapital: true, resetHistoryOnFire: true, dryRun: false,
    });
  });

  test('normalizeConfig(null) → ค่าเดียวกับ DEFAULTS + maxHistory=3', () => {
    const c = dps.normalizeConfig(null);
    expect(c.maxHistory).toBe(3);
    expect(c.minSize).toBe(6);
    expect(c.maxSize).toBe(15);
    expect(c.cooldownMs).toBe(5 * 60 * 1000);
  });

  test('normalizeConfig: ค่าที่เป็น null/undefined/NaN → fallback เป็น DEFAULT (กันค่าพังหลุดเข้า engine)', () => {
    const c = dps.normalizeConfig({
      minSize: NaN, maxSize: undefined, winStreakCount: null,
      bigWinPct: 5, cooldownMs: 0, dryRun: 'truthy',
    });
    expect(c.minSize).toBe(6);                          // NaN → default
    expect(c.maxSize).toBe(15);                         // undefined → default
    expect(c.winStreakCount).toBe(3);                   // null → default
    expect(c.bigWinPct).toBe(5);                        // valid number → kept
    expect(c.cooldownMs).toBe(0);                       // 0 is finite → kept
    expect(c.dryRun).toBe(true);                        // truthy string → true
  });

  test('normalizeConfig: derived maxHistory = max(winStreakCount, bigWinCount, lossStreakCount)', () => {
    const c = dps.normalizeConfig({ winStreakCount: 5, bigWinCount: 2, lossStreakCount: 3 });
    expect(c.maxHistory).toBe(5);
    const c2 = dps.normalizeConfig({ winStreakCount: 1, bigWinCount: 4, lossStreakCount: 2 });
    expect(c2.maxHistory).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resetStateUpdate — A4 regression guard
// ─────────────────────────────────────────────────────────────────────────
describe('DPS · resetStateUpdate (A4 fix)', () => {
  test('เคลียร์ทุก field ที่เกี่ยวกับ DPS (4 fields — layers dropped FIX-2026-09-03)', () => {
    expect(dps.resetStateUpdate()).toEqual({
      dynamicSizeCurrent: null,
      dynamicSizeLastResults: [],
      dynamicSizeCooldownUntil: null,
      dynamicSizeLastEvaluatedAt: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A1 — history ต้องสะสมได้แม้ไม้นั้นไม่ทำให้ size เปลี่ยน
// ─────────────────────────────────────────────────────────────────────────
describe('DPS · A1 regression: history grows on every trade', () => {
  test('default config + 3 wins ที่ไม่ใช่ big-win → Rule 1 ยิง (proves A1 fixed)', () => {
    const bot = baseBot();
    let r;
    // win เล็ก (< 2%) — ไม่เข้า Rule 2 แต่สะสม history
    r = dps.evaluate(bot, win(1.5), null);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('no-rule');
    expect(r.newHistory).toHaveLength(1);

    r = dps.evaluate({ ...bot, dynamicSizeLastResults: r.newHistory }, win(1.5), null);
    expect(r.changed).toBe(false);
    expect(r.newHistory).toHaveLength(2);

    r = dps.evaluate({ ...bot, dynamicSizeLastResults: r.newHistory }, win(1.5), null);
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('3-wins');
    expect(r.after.size).toBe(9 + 1);  // capitalPerTrade + winStreakDeltaSize
    expect(r.newHistory).toEqual([]);  // resetHistoryOnFire cleared it
  });

  test('2 wins >2% ติดกัน → Rule 2 ยิง (proves A1 fixed for bigWin)', () => {
    const bot = baseBot();
    let r = dps.evaluate(bot, win(3.0), null);
    expect(r.changed).toBe(false);
    expect(r.newHistory).toHaveLength(1);
    r = dps.evaluate({ ...bot, dynamicSizeLastResults: r.newHistory }, win(3.0), null);
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('2-wins-2pct');
    expect(r.after.size).toBe(9 + 2);  // bigWinDeltaSize
  });

  test('resetHistoryOnFire=false → streak ต่อยอด (Rule 1 ยิงได้หลายครั้งติด)', () => {
    const cfg = dps.normalizeConfig({ resetHistoryOnFire: false });
    const bot = baseBot();
    let r;
    for (let i = 0; i < 3; i++) {
      r = dps.evaluate(bot, win(1.5), cfg);
      bot.dynamicSizeLastResults = r.newHistory;
    }
    // ชนะครบ 3 → Rule 1 ยิง
    expect(r.reason).toBe('3-wins');
    expect(r.changed).toBe(true);
    expect(r.newHistory).toHaveLength(3);  // ไม่เคลียร์
    // ชนะต่ออีกไม้ → ยังเป็น 3-wins (history ไม่หลุด)
    const r2 = dps.evaluate(bot, win(1.5), cfg);
    expect(r2.reason).toBe('3-wins');
    expect(r2.changed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A2 — cooldown path ต้องคืน newHistory
// ─────────────────────────────────────────────────────────────────────────
describe('DPS · A2 regression: cooldown path persists history', () => {
  test('ปิดไม้ระหว่าง cooldown → skipped:cooldown แต่ newHistory ยังถูกบันทึก', () => {
    const bot = baseBot({
      dynamicSizeLastResults: [win(1.5)],
      dynamicSizeCooldownUntil: new Date(Date.now() + 60_000), // cooldown 60s
    });
    const r = dps.evaluate(bot, win(1.5), null);
    expect(r.changed).toBe(false);
    expect(r.skipped).toBe('cooldown');
    expect(r.reason).toBe('cooldown');
    expect(Array.isArray(r.newHistory)).toBe(true);
    expect(r.newHistory).toHaveLength(2);
  });

  test('cooldown หมดเวลาแล้ว → ประเมินปกติ', () => {
    const bot = baseBot({
      dynamicSizeLastResults: [win(1.5), win(1.5)],
      dynamicSizeCooldownUntil: new Date(Date.now() - 1000), // past
    });
    const r = dps.evaluate(bot, win(1.5), null);
    expect(r.skipped).toBeFalsy();
    expect(r.reason).toBe('3-wins');
    expect(r.changed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A3 — anchored clamp ไม่บีบ capitalPerTrade ของ user
// ─────────────────────────────────────────────────────────────────────────
describe('DPS · A3 regression: anchored clamp respects capitalPerTrade', () => {
  test('capitalPerTrade=20 + band 6..15 → bounds ขยายเป็น 6..20 (ไม่ถูกหั่น)', () => {
    const bot = baseBot({ capitalPerTrade: 20 });
    const bounds = dps.resolveBounds(bot, null);
    expect(bounds.minSize).toBe(6);
    expect(bounds.maxSize).toBe(20);  // anchored: max(maxSize=15, capitalPerTrade=20) = 20
  });

  test('capitalPerTrade=3 + band 6..15 → bounds เป็น 3..15 (ไม่ถูกดันขึ้น)', () => {
    const bot = baseBot({ capitalPerTrade: 3 });
    const bounds = dps.resolveBounds(bot, null);
    expect(bounds.minSize).toBe(3);   // anchored: min(minSize=6, capitalPerTrade=3) = 3
    expect(bounds.maxSize).toBe(15);
  });

  test('respectBotCapital=false → bounds ตรงตาม config (บีบ capitalPerTrade ได้)', () => {
    const bot = baseBot({ capitalPerTrade: 20 });
    const bounds = dps.resolveBounds(bot, { respectBotCapital: false });
    expect(bounds.minSize).toBe(6);
    expect(bounds.maxSize).toBe(15);
  });

  test('anchored clamp: win-streak +1 จาก capitalPerTrade=20 → newSize=20 (ชนเพดานของบอท) — ไม่ใช่ 16 (บีบด้วย maxSize=15)', () => {
    // anchored: minSize=6, maxSize=max(15, 20)=20
    // base=20, delta=+1 → target=21 → clamped to 20 → ไม่เปลี่ยน → changed=false (แต่ค่าที่อยู่ใน DB คือ 20 ไม่ใช่ 15)
    const bot = baseBot({
      capitalPerTrade: 20,
      dynamicSizeLastResults: [win(1.5), win(1.5)],
    });
    const r = dps.evaluate(bot, win(1.5), null);
    expect(r.reason).toBe('3-wins');
    expect(r.after.size).toBe(20);   // anchored expanded band: 20+1→21→clamp 20
    // ตรงนี้คือหัวใจของ A3: ถ้าไม่มี anchored clamp จะถูกหั่นเหลือ 15 ทันที
    expect(r.before.size).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A6 — resetHistoryOnFire prevents re-fire from same streak
// ─────────────────────────────────────────────────────────────────────────
describe('DPS · A6 regression: history resets on fire (default)', () => {
  test('default (resetHistoryOnFire=true): กฎยิงแล้ว history เคลียร์ → ไม้ถัดไปเริ่มนับใหม่ (no-rule)', () => {
    const bot = baseBot();
    let r;
    for (let i = 0; i < 3; i++) {
      r = dps.evaluate(bot, win(1.5), null);
      bot.dynamicSizeLastResults = r.newHistory;
    }
    expect(r.reason).toBe('3-wins');
    expect(r.changed).toBe(true);
    expect(r.newHistory).toEqual([]);

    // ไม้ถัดไป — history เคลียร์แล้ว ไม้ใหม่ถูก append ก่อน → length=1 → no-rule (winStreakCount=3 ยังไม่ครบ)
    const r2 = dps.evaluate(bot, win(1.5), null);
    expect(r2.changed).toBe(false);
    expect(r2.reason).toBe('no-rule');
    expect(r2.newHistory).toHaveLength(1);
  });

  test('rule ยิงแต่ size ไม่เปลี่ยนจริง (ชนเพดาน) → history ไม่เคลียร์ (เก็บ streak จริง)', () => {
    const cfg = dps.normalizeConfig({ maxSize: 9 });
    const bot = baseBot({ capitalPerTrade: 9 });
    let r;
    for (let i = 0; i < 3; i++) {
      r = dps.evaluate(bot, win(1.5), cfg);
      bot.dynamicSizeLastResults = r.newHistory;
    }
    expect(r.reason).toBe('3-wins');
    expect(r.changed).toBe(false);  // size ชนเพดาน 9 → ไม่เปลี่ยน
    expect(r.newHistory).toHaveLength(3);  // ไม่เคลียร์
  });
});

// ─────────────────────────────────────────────────────────────────────────
// bad-config guard (rev2 safety feature)
// ─────────────────────────────────────────────────────────────────────────
describe('DPS · bad-config guard', () => {
  test('minSize > maxSize + respectBotCapital=false → skipped:bad-config + history ยังบันทึก', () => {
    const cfg = dps.normalizeConfig({ minSize: 20, maxSize: 10, respectBotCapital: false });
    const r = dps.evaluate(baseBot(), win(1.5), cfg);
    expect(r.skipped).toBe('bad-config');
    expect(r.changed).toBe(false);
    expect(r.newHistory).toHaveLength(1);  // history ถูกบันทึก
  });

  test('respectBotCapital=true + bot ไม่มี capitalPerTrade → guard fires (ป้องกัน clamp เพี้ยน)', () => {
    const cfg = dps.normalizeConfig({ minSize: 20, maxSize: 10, respectBotCapital: true });
    const r = dps.evaluate({ dynamicSizeEnabled: true }, win(1.5), cfg);
    expect(r.skipped).toBe('bad-config');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// dryRun mode
// ─────────────────────────────────────────────────────────────────────────
describe('DPS · dryRun mode', () => {
  test('dryRun=true → changed=false แต่คำนวณ + wouldChange=true + history บันทึก', () => {
    const cfg = dps.normalizeConfig({ dryRun: true });
    const bot = baseBot({ dynamicSizeLastResults: [win(1.5), win(1.5)] });
    const r = dps.evaluate(bot, win(1.5), cfg);
    expect(r.dryRun).toBe(true);
    expect(r.changed).toBe(false);  // ← caller จะไม่เขียน size
    expect(r.wouldChange).toBe(true);
    expect(r.reason).toBe('3-wins');
    expect(r.after.size).toBe(10);  // คำนวณครบ
    expect(r.newHistory).toEqual([]);  // resetHistoryOnFire ยังทำงาน
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Custom config — ผู้ใช้ปรับแต่งเอง (proves B-section flexibility)
// ─────────────────────────────────────────────────────────────────────────
describe('DPS · custom config from settings page', () => {
  test('ชนะติด 5 (ไม่แตะ 2%) → Rule 1 ยิงที่ streak=5', () => {
    const cfg = dps.normalizeConfig({ winStreakCount: 5, winStreakDeltaSize: 2 });
    const bot = baseBot();
    let r;
    for (let i = 0; i < 5; i++) {
      r = dps.evaluate(bot, win(1.5), cfg);
      bot.dynamicSizeLastResults = r.newHistory;
    }
    expect(r.reason).toBe('5-wins');
    expect(r.after.size).toBe(9 + 2);  // 11
  });

  test('แพ้ติด 2 → Rule 3 ยิงหลังแพ้ครบ 2', () => {
    const cfg = dps.normalizeConfig({ lossStreakCount: 2, lossDeltaSize: -3 });
    const bot = baseBot();
    let r = dps.evaluate(bot, loss(-1), cfg);
    expect(r.changed).toBe(false); // streak ยังไม่ครบ
    bot.dynamicSizeLastResults = r.newHistory;
    r = dps.evaluate(bot, loss(-1), cfg);
    expect(r.reason).toBe('2-losses');
    expect(r.after.size).toBe(9 - 3);
  });

  test('bigWinPct 3% → ไม้ที่กำไร 2.5% ไม่เข้า Rule 2', () => {
    const cfg = dps.normalizeConfig({ bigWinPct: 3.0 });
    const bot = baseBot();
    let r = dps.evaluate(bot, { isWin: true, pnlPct: 2.5 }, cfg);
    bot.dynamicSizeLastResults = r.newHistory;
    r = dps.evaluate(bot, { isWin: true, pnlPct: 2.5 }, cfg);
    expect(r.changed).toBe(false);  // 2.5% ไม่เข้า Rule 2
    expect(r.reason).toBe('no-rule');
  });

  test('cooldownMs จาก settings (× 60_000) → resolved ตรง', () => {
    const cfg = dps.normalizeConfig({ cooldownMs: 10 * 60 * 1000 });
    const bot = baseBot({ dynamicSizeCooldownUntil: new Date(Date.now() + 60_000) });
    const r = dps.evaluate(bot, win(1.5), cfg);
    expect(r.skipped).toBe('cooldown');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// getEffective — trader.js ใช้ตัวนี้ตอน placeBuy
// ─────────────────────────────────────────────────────────────────────────
describe('DPS · getEffective', () => {
  test('dynamicSizeCurrent=null → คืน capitalPerTrade', () => {
    expect(dps.getEffective(baseBot())).toEqual({ size: 9 });
  });
  test('dynamicSizeCurrent=12 → คืน 12 (DPS ปรับแล้ว)', () => {
    expect(dps.getEffective(baseBot({ dynamicSizeCurrent: 12 }))).toEqual({ size: 12 });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// computeDeltasFromHistory — pure helper
// ─────────────────────────────────────────────────────────────────────────
describe('DPS · computeDeltasFromHistory', () => {
  test('history ว่าง → no-history', () => {
    expect(dps.computeDeltasFromHistory([], null).reason).toBe('no-history');
  });
  test('1 win + default cfg → no-rule', () => {
    expect(dps.computeDeltasFromHistory([win()], null).reason).toBe('no-rule');
  });
  test('priority: win-streak ตรวจก่อน big-win', () => {
    // 2 wins ที่กำไร >2% — Rule 1 (streak=3) ยังไม่ครบ แต่ Rule 2 (bigWin=2) ครบ
    const r = dps.computeDeltasFromHistory([win(3.0), win(3.0)], null);
    expect(r.reason).toBe('2-wins-2pct');
  });
  test('priority: 3 wins ติดกัน (เป็น big-win ด้วย) → Rule 1 ชนะ', () => {
    const r = dps.computeDeltasFromHistory([win(3.0), win(3.0), win(3.0)], null);
    expect(r.reason).toBe('3-wins');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// clampSize — pure helper (FIX-2026-09-03: renamed from clampSizeAndLayers)
// ─────────────────────────────────────────────────────────────────────────
describe('DPS · clampSize', () => {
  test('size เกิน max → บีบลง', () => {
    expect(dps.clampSize(20, { minSize: 6, maxSize: 15 }))
      .toEqual({ newSize: 15 });
  });
  test('size ต่ำกว่า min → ดันขึ้น', () => {
    expect(dps.clampSize(2, { minSize: 6, maxSize: 15 }))
      .toEqual({ newSize: 6 });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Master switch + per-bot toggle
// ─────────────────────────────────────────────────────────────────────────
describe('DPS · gates (master + per-bot)', () => {
  test('dynamicSizeEnabled=false → skipped:disabled', () => {
    const r = dps.evaluate(baseBot({ dynamicSizeEnabled: false }), win(1.5), null);
    expect(r.skipped).toBe('disabled');
  });
  test('_masterDynamicSizeEnabled=false → skipped:master-off', () => {
    const r = dps.evaluate(baseBot({ _masterDynamicSizeEnabled: false }), win(1.5), null);
    expect(r.skipped).toBe('master-off');
  });
  test('dcaEnabled=true → skipped:dca-mode', () => {
    const r = dps.evaluate(baseBot({ dcaEnabled: true }), win(1.5), null);
    expect(r.skipped).toBe('dca-mode');
  });
  test('martingaleEnabled=true → skipped:martingale-mode', () => {
    const r = dps.evaluate(baseBot({ martingaleEnabled: true }), win(1.5), null);
    expect(r.skipped).toBe('martingale-mode');
  });
});
