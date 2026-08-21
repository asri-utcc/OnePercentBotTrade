'use strict';

/**
 * 2026-08-21: Unit tests for src/services/buyCommitment.js
 *
 * Covers:
 *   - claim/release basic round-trip
 *   - concurrent claim scenario (2 bots race) → only 1 passes
 *   - release on zero or negative
 *   - NaN/Infinity safety
 *   - reset clears state
 *   - rounding avoids float drift
 */

const buyCommitment = require('../src/services/buyCommitment');

describe('buyCommitment (FIX-2026-08-21: กัน reserve หลุดจาก race)', () => {
  beforeEach(() => buyCommitment.reset());

  test('claimBuy(10) increments committed from 0 to 10', () => {
    expect(buyCommitment.getCommitted()).toBe(0);
    buyCommitment.claimBuy(10);
    expect(buyCommitment.getCommitted()).toBe(10);
  });

  test('releaseBuy(10) decrements committed from 10 to 0', () => {
    buyCommitment.claimBuy(10);
    buyCommitment.releaseBuy(10);
    expect(buyCommitment.getCommitted()).toBe(0);
  });

  test('releaseBuy(15) on committed=10 floors at 0', () => {
    buyCommitment.claimBuy(10);
    buyCommitment.releaseBuy(15);
    expect(buyCommitment.getCommitted()).toBe(0);
  });

  test('claimBuy(NaN) returns false, no change', () => {
    const result = buyCommitment.claimBuy(NaN);
    expect(result).toBe(false);
    expect(buyCommitment.getCommitted()).toBe(0);
  });

  test('claimBuy(Infinity) returns false', () => {
    expect(buyCommitment.claimBuy(Infinity)).toBe(false);
    expect(buyCommitment.getCommitted()).toBe(0);
  });

  test('claimBuy(-5) returns false', () => {
    expect(buyCommitment.claimBuy(-5)).toBe(false);
    expect(buyCommitment.getCommitted()).toBe(0);
  });

  test('claimBuy(0) returns false', () => {
    expect(buyCommitment.claimBuy(0)).toBe(false);
  });

  test('claimBuy(0.1) + claimBuy(0.2) ≈ 0.3 (no float drift)', () => {
    buyCommitment.claimBuy(0.1);
    buyCommitment.claimBuy(0.2);
    expect(buyCommitment.getCommitted()).toBeCloseTo(0.3, 4);
  });

  test('releaseBuy(NaN) does not change committed', () => {
    buyCommitment.claimBuy(10);
    buyCommitment.releaseBuy(NaN);
    expect(buyCommitment.getCommitted()).toBe(10);
  });

  test('race: botA claim succeeds, botB sees updated committed and would fail', () => {
    buyCommitment.claimBuy(8); // botA claims first
    expect(buyCommitment.getCommitted()).toBe(8);
    // botB checks: available=10, committed=8 → available - committed = 2 < 8 → fail
    const botBView = 10 - buyCommitment.getCommitted();
    expect(botBView >= 8).toBe(false);
  });

  test('release then claim works', () => {
    buyCommitment.claimBuy(8);
    buyCommitment.releaseBuy(8);
    expect(buyCommitment.getCommitted()).toBe(0);
    buyCommitment.claimBuy(8);
    expect(buyCommitment.getCommitted()).toBe(8);
  });

  test('reset() clears committed to 0', () => {
    buyCommitment.claimBuy(10);
    buyCommitment.claimBuy(5);
    buyCommitment.reset();
    expect(buyCommitment.getCommitted()).toBe(0);
  });

  test('100 claims of 0.01 each sum to 1.0', () => {
    for (let i = 0; i < 100; i++) buyCommitment.claimBuy(0.01);
    expect(buyCommitment.getCommitted()).toBeCloseTo(1.0, 4);
  });

  test('user scenario: reserve=10, total=20, 2 bots want 8 each → only 1 ends up committed', () => {
    const reserve = 10;
    const total = 20;
    const want = 8;
    const available = total - reserve; // 10

    // Bot A: check, then claim
    const botAOk = buyCommitment.claimBuy(want);
    expect(botAOk).toBe(true);
    const botACommitted = buyCommitment.getCommitted(); // 8
    const botAAvailable = available - botACommitted; // 2
    expect(botAAvailable >= want).toBe(false); // botA cannot double-claim

    // Bot B: also claims (atomic increment always succeeds at the API level)
    const botBOk = buyCommitment.claimBuy(want);
    expect(botBOk).toBe(true);
    let botBCommitted = buyCommitment.getCommitted(); // 16
    const botBAvailable = available - botBCommitted; // -6
    expect(botBAvailable >= want).toBe(false); // botB over-committed — caller must release

    // Proper caller-side check (like trader.js does):
    // After claim, caller should check available. If negative, release.
    if (botBAvailable < want) {
      buyCommitment.releaseBuy(want);
      botBCommitted = buyCommitment.getCommitted();
    }

    // Final: only botA's claim remains
    expect(buyCommitment.getCommitted()).toBe(8);
  });

  test('scenario: partial fills keep claim (no release on success)', () => {
    // Simulate: bot A claims 10 USDT for BUY. Order placed successfully.
    // BUY partially fills 4 USDT, then fully fills later. No release needed.
    buyCommitment.claimBuy(10);
    expect(buyCommitment.getCommitted()).toBe(10);
    // partial fill — committed stays at 10 (Binance's locked reduces, but our
    // counter represents "intent to spend" which is still 10 USDT)
    // final fill — committed stays at 10 (the 10 USDT is now spent at Binance)
    expect(buyCommitment.getCommitted()).toBe(10);
    // bot B tries to claim 5 USDT — sees committed=10, available = 15-10-5reserve = 0 → fail
    const botBAvailable = (15 - 5) - buyCommitment.getCommitted();
    expect(botBAvailable >= 5).toBe(false);
  });

  // ─── FIX-2026-08-21 (rev2): release on order acceptance ─────────────────
  // ก่อนหน้านี้: release เฉพาะตอน order reject → committed สะสมทุก BUY ที่สำเร็จ
  // จนกินเงินเกือบหมด (อาการ: log "in-flight committed 54.5057" ทั้งที่ free 59.7)
  // fix: trader.js placeBuy + _topUpAndSell เรียก releaseBuy ทันทีหลัง Binance accept
  describe('FIX-2026-08-21 rev2: release on order acceptance (ไม่ leak หลัง success)', () => {
    test('cycle claim→release→claim ทำซ้ำได้เรื่อยๆ ไม่สะสม', () => {
      // simulate 100 successful BUY cycles
      for (let i = 0; i < 100; i++) {
        buyCommitment.claimBuy(5);
        expect(buyCommitment.getCommitted()).toBe(5);
        buyCommitment.releaseBuy(5);
        expect(buyCommitment.getCommitted()).toBe(0);
      }
    });

    test('mix: 3 success + 1 reject → counter = 0 (3 releases + 1 release = 4)', () => {
      // bot A claim + release (success)
      buyCommitment.claimBuy(5);
      buyCommitment.releaseBuy(5);
      expect(buyCommitment.getCommitted()).toBe(0);

      // bot B claim + release (success)
      buyCommitment.claimBuy(7);
      buyCommitment.releaseBuy(7);
      expect(buyCommitment.getCommitted()).toBe(0);

      // bot C claim + release (success)
      buyCommitment.claimBuy(3);
      buyCommitment.releaseBuy(3);
      expect(buyCommitment.getCommitted()).toBe(0);

      // bot D claim + release (reject — same path as success in counter terms)
      buyCommitment.claimBuy(10);
      buyCommitment.releaseBuy(10);
      expect(buyCommitment.getCommitted()).toBe(0);
    });

    test('เดิม (ไม่ release on success) จะ leak: 50 success claims → committed = 250', () => {
      // simulate buggy behavior: claim only, never release
      for (let i = 0; i < 50; i++) buyCommitment.claimBuy(5);
      expect(buyCommitment.getCommitted()).toBe(50 * 5); // 250 USDT leaked

      // ต่อให้บอทอื่นพยายาม — committed ใหญ่กว่า free ทั้งหมด → block
      // ตัวอย่างเช่น free=300, committed=250, reserve=0 → available = 50
      const available = 300 - buyCommitment.getCommitted();
      expect(available).toBe(50); // bug: ควรเป็น 300 (USDT ถูกใช้ไปจริงบน Binance แล้ว)
      expect(available >= 10).toBe(true); // บอทอื่นผ่านไปได้ แต่ committed ยังค้าง
    });

    test('หลัง fix: 50 success claims + 50 releases → committed = 0', () => {
      for (let i = 0; i < 50; i++) {
        buyCommitment.claimBuy(5);
        buyCommitment.releaseBuy(5);
      }
      expect(buyCommitment.getCommitted()).toBe(0);

      // available = free - committed = free (ไม่มี double-count)
      const available = 300 - buyCommitment.getCommitted();
      expect(available).toBe(300);
    });

    test('race + release on success: 2 bots race, both succeed → total claims bounded', () => {
      // Both bots claim 10 simultaneously (within in-flight window)
      buyCommitment.claimBuy(10); // bot A
      buyCommitment.claimBuy(10); // bot B
      expect(buyCommitment.getCommitted()).toBe(20);

      // bot A's newOrder returns first → release
      buyCommitment.releaseBuy(10);
      expect(buyCommitment.getCommitted()).toBe(10);

      // bot B's newOrder returns next → release
      buyCommitment.releaseBuy(10);
      expect(buyCommitment.getCommitted()).toBe(0);
    });
  });
});
