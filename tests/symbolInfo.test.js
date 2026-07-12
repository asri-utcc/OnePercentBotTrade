'use strict';

const { floorPrice, roundPrice } = require('../src/binance/symbolInfo');
const Decimal = require('decimal.js');

describe('symbolInfo.price helpers', () => {
  describe('floorPrice', () => {
    test('snaps to tickSize multiple (already aligned)', () => {
      const tick = new Decimal('0.01');
      expect(floorPrice('77.91', tick).toString()).toBe('77.91');
      // Decimal normalizes trailing zeros — 77.90 stays numerically equal to 77.9
      expect(floorPrice('77.90', tick).toString()).toBe('77.9');
    });

    test('floors down (NOT rounds up) for sub-tick values', () => {
      const tick = new Decimal('0.01');
      // 77.911 floored to 0.01 tick = 77.91 (NOT 77.92)
      expect(floorPrice('77.911', tick).toString()).toBe('77.91');
      // 77.929 floored = 77.92
      expect(floorPrice('77.929', tick).toString()).toBe('77.92');
    });

    test('produces price strictly < ask when ask - 1 tick is exact', () => {
      // Regression for 2026-07-12 05:21 BUY rejection:
      // bid >= ask (spread collapsed) → place at ask - tickSize floored
      const tick = new Decimal('0.01');
      const ask = '77.92';
      const safe = floorPrice(new Decimal(ask).minus(tick), tick);
      expect(parseFloat(safe.toString())).toBeLessThan(parseFloat(ask));
      expect(safe.toString()).toBe('77.91');
    });

    test('handles larger tickSize (e.g. tick=0.1)', () => {
      const tick = new Decimal('0.1');
      expect(floorPrice('123.45', tick).toString()).toBe('123.4');
      expect(floorPrice('123.99', tick).toString()).toBe('123.9');
    });

    test('handles fractional tickSize (e.g. tick=0.001 for low-price coins)', () => {
      const tick = new Decimal('0.001');
      expect(floorPrice('0.12349', tick).toString()).toBe('0.123');
      expect(floorPrice('0.12399', tick).toString()).toBe('0.123');
    });

    test('returns price unchanged when tickSize is missing or zero', () => {
      expect(floorPrice('77.91', null).toString()).toBe('77.91');
      expect(floorPrice('77.91', new Decimal(0)).toString()).toBe('77.91');
    });
  });

  describe('roundPrice (sanity, should still work)', () => {
    test('rounds to nearest tickSize', () => {
      const tick = new Decimal('0.01');
      expect(roundPrice('77.911', tick).toString()).toBe('77.91');
      expect(roundPrice('77.916', tick).toString()).toBe('77.92');
    });
  });
});