'use strict';

/**
 * FIX-2026-08-22: -1100 Illegal characters on newClientOrderId (PEPE)
 *
 * Binance Spot API contract for `newClientOrderId`:
 *   - regex: ^[a-zA-Z0-9-_]{1,36}$
 *   - allowed: A-Z, a-z, 0-9, hyphen '-', underscore '_'
 *   - disallowed (all else): '.', ' ', '/', '#', unicode, … → return -1100
 *
 * Root cause: trader.js#makeClientOrderId concatenated `retry` directly. Caller at
 * line 5077 uses `(trade.retryCount || 0) + 0.5` for the SELL -2010 retry path →
 * decimal retry becomes "0.5" → contains '.' → Binance -1100 reject.
 *
 * PEPE (1000PEPEUSDT) hit this most often because the SELL retry path was triggered
 * by the small-balance race. The fix:
 *   - sanitize retry + side via /[^a-zA-Z0-9_-]/g (defense in depth)
 *   - guarantee output always matches Binance regex
 *
 * This test pins the invariant: every output of makeClientOrderId MUST be a valid
 * newClientOrderId per the Binance regex, regardless of inputs.
 */

const Trader = require('../src/core/trader');

// Binance Spot API constraint for newClientOrderId (single source of truth).
const BINANCE_REGEX = /^[a-zA-Z0-9_-]{1,36}$/;

// Replicated logic — same as src/core/trader.js#Trader.makeClientOrderId
// (keep these in sync; rounding/slicing must match exactly).
function replicateMakeClientOrderId(botId, side, refTs, retry) {
  const ts = typeof refTs === 'number' ? refTs : new Date(refTs).getTime();
  const shortBot = botId.toString().slice(-6);
  const rand = 'rand00'; // deterministic for assertions
  const safeRetry = String(retry ?? 0).replace(/[^a-zA-Z0-9_-]/g, '');
  const safeSide = String(side || 'x').replace(/[^a-zA-Z0-9_-]/g, '');
  const id = `b${shortBot}-${ts}-${safeRetry}-${safeSide}-${rand}`;
  return id.slice(0, 36);
}

describe('makeClientOrderId — Binance -1100 illegal-char defense (PEPE fix 2026-08-22)', () => {
  // ---------- Replicated logic (pure) ----------
  describe('replicated pure helper', () => {
    test('integer retry ปกติ → passes regex', () => {
      const id = replicateMakeClientOrderId('507f1f77bcf86cd799439011', 'buy', 1755888000000, 1);
      expect(id).toMatch(BINANCE_REGEX);
      expect(id).toContain('-1-'); // retry=1
    });

    test('retry ที่เป็น decimal (0.5) → "." ถูก sanitize → no "." in output', () => {
      const id = replicateMakeClientOrderId('507f1f77bcf86cd799439011', 'sell', 1755888000000, 0.5);
      expect(id).not.toContain('.');
      expect(id).toMatch(BINANCE_REGEX);
    });

    test('retry ที่เป็น decimal (1.5) → sanitize ออกหมด → no "." in output', () => {
      const id = replicateMakeClientOrderId('507f1f77bcf86cd799439011', 'sell', 1755888000000, 1.5);
      expect(id).not.toContain('.');
      expect(id).toMatch(BINANCE_REGEX);
    });

    test('retry = undefined/null → fallback 0', () => {
      expect(replicateMakeClientOrderId('botid123', 'sell', 1755888000000, undefined)).toMatch(BINANCE_REGEX);
      expect(replicateMakeClientOrderId('botid123', 'sell', 1755888000000, null)).toMatch(BINANCE_REGEX);
    });

    test('retry = NaN → "NaN" (all letters, OK)', () => {
      expect(replicateMakeClientOrderId('botid123', 'sell', 1755888000000, NaN)).toMatch(BINANCE_REGEX);
    });

    test('side มี illegal char (เช่น "buy/x") → "/" ถูก sanitize', () => {
      const id = replicateMakeClientOrderId('botid123', 'buy/x', 1755888000000, 0);
      expect(id).not.toContain('/');
      expect(id).toMatch(BINANCE_REGEX);
    });

    test('output length ≤ 36 chars (Binance hard limit)', () => {
      // สร้าง inputs ที่ถ้าไม่ slice จะยาวเกิน 36 แน่ๆ
      const longBotId = 'a'.repeat(40);
      const id = replicateMakeClientOrderId(longBotId, 'sell', Date.now(), 99);
      expect(id.length).toBeLessThanOrEqual(36);
      expect(id).toMatch(BINANCE_REGEX);
    });

    test('decimal retry (เคส PEPE — line 5077) ผ่าน regex', () => {
      // เคสเป๊ะที่ user เจอ: trader.js:5077 ใส่ (retryCount || 0) + 0.5 → "0.5"
      const id = replicateMakeClientOrderId('507f1f77bcf86cd799439011', 'sell', 1755888000000, (0) + 0.5);
      expect(id).toMatch(BINANCE_REGEX);
      expect(id).not.toMatch(/\./); // ไม่มีจุด
      expect(id.length).toBeLessThanOrEqual(36);
    });
  });

  // ---------- Real Trader.prototype test (sanity) ----------
  describe('Trader.prototype.makeClientOrderId (real method)', () => {
    // stub bot (only _id is needed)
    const fakeBot = { _id: { toString: () => '507f1f77bcf86cd799439011' } };
    const ctx = { bot: fakeBot };
    // call via prototype so we don't need a Trader instance
    const makeClientOrderId = Trader.prototype.makeClientOrderId;

    const cases = [
      { name: 'integer retry=0', args: ['buy', 1755888000000, 0] },
      { name: 'integer retry=5', args: ['sell', 1755888000000, 5] },
      { name: 'decimal retry=0.5 (PEPE incident)', args: ['sell', 1755888000000, 0.5] },
      { name: 'decimal retry=1.5', args: ['sell', 1755888000000, 1.5] },
      { name: 'decimal retry=99.5', args: ['sell', 1755888000000, 99.5] },
      { name: 'retry=undefined', args: ['sell', 1755888000000, undefined] },
      { name: 'retry=null', args: ['sell', 1755888000000, null] },
      { name: 'retry=NaN', args: ['sell', 1755888000000, NaN] },
      { name: 'side with illegal slash', args: ['sell/buy', 1755888000000, 0] },
      { name: 'refTs as Date object', args: ['buy', new Date(1755888000000), 0] },
      { name: 'very long botId', args: ['sell', 1755888000000, 0] }, // will pair with long _id below
    ];

    test.each(cases)('$name → matches Binance regex', ({ args }) => {
      const id = makeClientOrderId.call(ctx, ...args);
      expect(typeof id).toBe('string');
      expect(id).toMatch(BINANCE_REGEX);
      expect(id).not.toContain('.');
      expect(id.length).toBeGreaterThan(0);
      expect(id.length).toBeLessThanOrEqual(36);
    });

    test('random suffix ทำให้ id ไม่ซ้ำ (no -2010 Duplicate)', () => {
      // ทำ 100 ครั้งติด → ทุก id ต้อง unique
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(makeClientOrderId.call(ctx, 'buy', 1755888000000, 0));
      }
      expect(ids.size).toBe(100);
    });

    test('เคสเฉพาะ PEPE incident จำลองจาก line 5077', () => {
      // ตรงกับ logic เดิม: trade.retryCount = 0 → (0 || 0) + 0.5 = 0.5
      const retryVal = (0 || 0) + 0.5;
      const id = makeClientOrderId.call(ctx, 'sell', Date.now(), retryVal);
      expect(id).not.toContain('.');
      expect(id).toMatch(BINANCE_REGEX);
      expect(id.length).toBeLessThanOrEqual(36);
    });

    test('id ขึ้นต้นด้วย "b" + 6-char bot suffix', () => {
      const id = makeClientOrderId.call(ctx, 'buy', 1755888000000, 0);
      expect(id).toMatch(/^b.{6}-/); // b + 6 chars + '-'
    });

    test('output ≤ 36 chars แม้ inputs ใหญ่ (long botId via stub override)', () => {
      const longBot = { _id: { toString: () => 'abcdefghijklmnopqrstuvwxyz1234567890' } };
      const id = makeClientOrderId.call({ bot: longBot }, 'sell', Date.now(), 99);
      expect(id.length).toBeLessThanOrEqual(36);
      expect(id).toMatch(BINANCE_REGEX);
    });
  });
});
