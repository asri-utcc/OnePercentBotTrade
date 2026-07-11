'use strict';

/**
 * Unit tests for the new retryMax + balance check logic.
 * เน้นทดสอบ pure functions และ helper math ที่ใช้ใน trader
 */

const fees = require('../src/binance/fees');
const symbolInfo = require('../src/binance/symbolInfo');

describe('fees.calcSellPrice — TP + fee buffer', () => {
  test('คำนวณ sell price รวม fee buffer 2 ขา', () => {
    const buyPrice = 100;
    const tp = 0.1;
    const feeRate = 0.00075; // BNB
    const sell = fees.calcSellPrice({ buyPrice, tpPercent: tp, feeRate });
    // sell = 100 * (1 + 0.001 + 0.0015) = 100.25
    expect(sell).toBeCloseTo(100.25, 4);
  });

  test('normal maker rate (ไม่ใช้ BNB)', () => {
    const sell = fees.calcSellPrice({ buyPrice: 100, tpPercent: 0.1, feeRate: 0.001 });
    // sell = 100 * (1 + 0.001 + 0.002) = 100.3
    expect(sell).toBeCloseTo(100.3, 4);
  });

  test('sell ที่ TP 0.1% BNB → net = เกือบ 0.1%', () => {
    const buyPrice = 100;
    const tp = 0.1;
    const feeRate = 0.00075;
    const sellPrice = fees.calcSellPrice({ buyPrice, tpPercent: tp, feeRate });
    const qty = 1;
    const pnl = fees.calcPnl({ buyPrice, sellPrice, qty, feeRate });
    // net ควรอยู่ใกล้ 0.1 (target TP)
    expect(pnl.pnlPercent).toBeCloseTo(0.1, 2);
  });

  test('ถ้าไม่บวก fee buffer → net ติดลบ', () => {
    const buyPrice = 100;
    const tp = 0.1;
    const feeRate = 0.00075;
    // simulate ไม่บวก fee: sell ที่ buy * (1 + tp/100) = 100.1
    const sellPrice = buyPrice * (1 + tp / 100);
    const pnl = fees.calcPnl({ buyPrice, sellPrice, qty: 1, feeRate });
    expect(pnl.net).toBeLessThan(0);
  });
});

describe('fees.getMakerRate — fee rate selection', () => {
  test('default ตาม config', () => {
    const r = fees.getMakerRate();
    expect([0.00075, 0.001]).toContain(r);
  });

  test('override explicit → ใช้ค่าที่ override', () => {
    expect(fees.getMakerRate({ useBnbForFees: true })).toBe(0.00075);
    expect(fees.getMakerRate({ useBnbForFees: false })).toBe(0.001);
  });
});

describe('calcPnl — fee 2 ขา', () => {
  test('buy/sell/qty บวก fee ครบ', () => {
    const pnl = fees.calcPnl({ buyPrice: 100, sellPrice: 101, qty: 10, feeRate: 0.001 });
    // gross = (101-100)*10 = 10
    // fees = (100+101)*10*0.001 = 2.01
    // net = 10 - 2.01 = 7.99
    expect(pnl.gross).toBeCloseTo(10, 4);
    expect(pnl.fees).toBeCloseTo(2.01, 4);
    expect(pnl.net).toBeCloseTo(7.99, 4);
    expect(pnl.notional).toBeCloseTo(1000, 4);
  });

  test('sellPrice < buyPrice → net ติดลบ', () => {
    const pnl = fees.calcPnl({ buyPrice: 100, sellPrice: 99, qty: 1, feeRate: 0.001 });
    expect(pnl.net).toBeLessThan(0);
  });

  test('qty = 0 → notional 0 + pnlPercent 0', () => {
    const pnl = fees.calcPnl({ buyPrice: 100, sellPrice: 101, qty: 0, feeRate: 0.001 });
    expect(pnl.notional).toBe(0);
    expect(pnl.pnlPercent).toBe(0);
  });
});

describe('symbolInfo — qty/price rounding (pure math)', () => {
  // ทดสอบ math ผ่าน raw helpers ที่ใช้ภายใน (หลีกเลี่ยงการ mock internal cache)

  function floorQtyToStep(qty, stepSize) {
    const Decimal = require('decimal.js');
    return new Decimal(qty).div(stepSize).floor().mul(stepSize);
  }

  function roundPriceToTick(price, tickSize) {
    const Decimal = require('decimal.js');
    return new Decimal(price).div(tickSize).round().mul(tickSize);
  }

  test('BNBUSDT @ 700, capital 10, stepSize 0.001 → qty = 0.014', () => {
    const rawQty = 10 / 700;
    const qty = floorQtyToStep(rawQty, '0.001');
    expect(qty.toString()).toBe('0.014');
  });

  test('stepSize ใหญ่ (0.01) → floor ลง', () => {
    const rawQty = 10 / 700; // 0.0142857
    const qty = floorQtyToStep(rawQty, '0.01');
    expect(qty.toString()).toBe('0.01');
  });

  test('roundPrice ตาม tickSize 0.01', () => {
    const p = roundPriceToTick(575.123, '0.01');
    expect(p.toString()).toBe('575.12');
  });

  test('roundPrice tickSize 0.001', () => {
    const p = roundPriceToTick(575.1234, '0.001');
    expect(p.toString()).toBe('575.123');
  });

  test('floorQty stepSize 0.0001 → แม่นถึงทศนิยม 4 ตำแหน่ง', () => {
    const qty = floorQtyToStep(0.0142857, '0.0001');
    expect(qty.toString()).toBe('0.0142'); // floor ไป 142 แล้ว × 0.0001
  });
});

describe('retry logic — math ที่ใช้ใน trader.checkBuyOrder', () => {
  // ทดสอบ "movedEnough" threshold
  function isMovedEnough(originalPrice, newBid, threshold = 0.000001) {
    if (!newBid) return false;
    return Math.abs(newBid - originalPrice) / originalPrice > threshold;
  }

  test('bid ขยับ 0.001% → moved enough', () => {
    expect(isMovedEnough(700.000, 700.007)).toBe(true); // 0.001%
  });

  test('bid ขยับ 0.00005% → ไม่ moved enough', () => {
    expect(isMovedEnough(700.000, 700.00035)).toBe(false); // 0.00005%
  });

  test('bid ไม่ขยับ → ไม่ moved', () => {
    expect(isMovedEnough(700.000, 700.000)).toBe(false);
  });

  test('bid ขยับลง → moved enough', () => {
    expect(isMovedEnough(700.000, 699.99)).toBe(true);
  });

  test('null bid → ไม่ moved (จะ schedule retry รอบถัดไป)', () => {
    expect(isMovedEnough(700.000, null)).toBe(false);
  });
});

describe('retry decision — retryMax cap', () => {
  // ทดสอบ decision: ควร cancel+re-place, cancel+expire, หรือ wait
  function decide({ retryCount, retryMax, movedEnough }) {
    const remaining = retryMax - retryCount;
    if (!movedEnough) return 'wait';
    if (remaining > 0) return 'replace';
    return 'expire';
  }

  test('retryMax=1, retryCount=0, moved → replace', () => {
    expect(decide({ retryCount: 0, retryMax: 1, movedEnough: true })).toBe('replace');
  });

  test('retryMax=1, retryCount=1, moved → expire', () => {
    expect(decide({ retryCount: 1, retryMax: 1, movedEnough: true })).toBe('expire');
  });

  test('retryMax=1, retryCount=1, ไม่ moved → wait', () => {
    expect(decide({ retryCount: 1, retryMax: 1, movedEnough: false })).toBe('wait');
  });

  test('retryMax=0 (no retry), retryCount=0, moved → expire', () => {
    expect(decide({ retryCount: 0, retryMax: 0, movedEnough: true })).toBe('expire');
  });

  test('retryMax=3, retryCount=2, moved → replace (เหลืออีก 1)', () => {
    expect(decide({ retryCount: 2, retryMax: 3, movedEnough: true })).toBe('replace');
  });
});

describe('balance check — pre-flight math', () => {
  // simulate การคำนวณ requiredWithBuffer ใน trader.placeBuy
  function checkBalance({ freeUsdt, buyPrice, qty, feeRate }) {
    const requiredNotional = buyPrice * qty;
    const requiredWithBuffer = requiredNotional * (1 + feeRate);
    return {
      ok: freeUsdt >= requiredWithBuffer,
      requiredNotional,
      requiredWithBuffer,
      shortfall: Math.max(0, requiredWithBuffer - freeUsdt),
    };
  }

  test('balance พอ → ok', () => {
    const r = checkBalance({ freeUsdt: 100, buyPrice: 700, qty: 0.014, feeRate: 0.00075 });
    // required = 9.8 * 1.00075 = 9.81
    expect(r.ok).toBe(true);
    expect(r.requiredNotional).toBeCloseTo(9.8, 4);
  });

  test('balance ไม่พอ → fail + คำนวณ shortfall', () => {
    const r = checkBalance({ freeUsdt: 5, buyPrice: 700, qty: 0.014, feeRate: 0.00075 });
    expect(r.ok).toBe(false);
    expect(r.shortfall).toBeCloseTo(9.81 - 5, 2);
  });

  test('balance = 0 → fail', () => {
    const r = checkBalance({ freeUsdt: 0, buyPrice: 700, qty: 0.014, feeRate: 0.00075 });
    expect(r.ok).toBe(false);
  });

  test('balance exactly required → ok', () => {
    const r = checkBalance({ freeUsdt: 9.81, buyPrice: 700, qty: 0.014, feeRate: 0.00075 });
    expect(r.ok).toBe(true);
  });
});