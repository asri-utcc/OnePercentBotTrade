'use strict';

/**
 * FIX-2026-09-01 audit H8: placeBuy retry path races WS _handleBuyFilled.
 *
 *   Before: when initial BUY returned -2010 (insufficient balance / post-only
 *     rejected), the code immediately entered a retry loop with a NEW
 *     clientOrderId. If the original order actually got FILLED on Binance
 *     (race between orderResp error and WS event delivery), the retry sent
 *     a 2nd BUY → DOUBLE POSITION on the same signal.
 *
 *   After: before the retry loop, query Binance via getOrder for the original
 *     clientOrderId. If FILLED/PARTIALLY_FILLED → overwrite orderResp with
 *     the filled order details, abort retry, treat as success. WS handler
 *     picks up normally.
 *
 *   This test verifies:
 *     - getOrder returns FILLED → orderResp replaced, retry loop skipped
 *     - getOrder returns NEW/CANCELED → retry loop proceeds
 *     - getOrder returns null (network blip) → retry loop proceeds (defensive)
 *     - getOrder throws → retry loop proceeds (better to risk dup than skip)
 *     - Non -2010 error → no getOrder check (no point)
 */

function makeRetryGate() {
  // Replicates the H8 logic. Returns { retry, replacedOrderResp }.
  // `retry` = true if retry loop should run; `replacedOrderResp` = new value for orderResp (null if no change)
  return function gate(orderResp, getOrderResult) {
    if (!(orderResp && orderResp.error && orderResp.error.code === -2010)) {
      return { retry: false, replacedOrderResp: null, reason: 'not_-2010' };
    }
    // getOrder throws → defensive: retry
    if (getOrderResult && getOrderResult.error) {
      return { retry: true, replacedOrderResp: null, reason: 'getOrder_failed' };
    }
    const liveOrder = getOrderResult && getOrderResult.value;
    if (liveOrder && (liveOrder.status === 'FILLED' || liveOrder.status === 'PARTIALLY_FILLED')) {
      return { retry: false, replacedOrderResp: liveOrder, reason: 'already_filled' };
    }
    // status = NEW, CANCELED, EXPIRED, REJECTED → safe to retry
    return { retry: true, replacedOrderResp: null, reason: 'not_filled' };
  };
}

describe('audit-H8 retry gate: getOrder pre-retry check', () => {
  test('initial error != -2010 → no gate check, no retry', () => {
    const gate = makeRetryGate();
    const r = gate({ error: { code: -1011 } }, { value: null });
    expect(r.retry).toBe(false);
    expect(r.replacedOrderResp).toBeNull();
  });

  test('-2010 + getOrder FILLED → abort retry, replace orderResp', () => {
    const gate = makeRetryGate();
    const liveOrder = {
      orderId: 12345, status: 'FILLED',
      executedQty: '0.01', cummulativeQuoteQty: '5.0',
      transactTime: 1700000000000,
    };
    const r = gate({ error: { code: -2010, msg: 'would immediately match' } }, { value: liveOrder });
    expect(r.retry).toBe(false);
    expect(r.replacedOrderResp).toBe(liveOrder);
    expect(r.reason).toBe('already_filled');
  });

  test('-2010 + PARTIALLY_FILLED → abort retry, replace orderResp', () => {
    const gate = makeRetryGate();
    const liveOrder = { orderId: 99, status: 'PARTIALLY_FILLED', executedQty: '0.005' };
    const r = gate({ error: { code: -2010 } }, { value: liveOrder });
    expect(r.retry).toBe(false);
    expect(r.replacedOrderResp).toBe(liveOrder);
  });

  test('-2010 + getOrder NEW (still pending) → retry proceeds', () => {
    const gate = makeRetryGate();
    const r = gate({ error: { code: -2010 } }, { value: { status: 'NEW' } });
    expect(r.retry).toBe(true);
    expect(r.replacedOrderResp).toBeNull();
    expect(r.reason).toBe('not_filled');
  });

  test('-2010 + getOrder CANCELED → retry proceeds', () => {
    const gate = makeRetryGate();
    const r = gate({ error: { code: -2010 } }, { value: { status: 'CANCELED' } });
    expect(r.retry).toBe(true);
  });

  test('-2010 + getOrder EXPIRED → retry proceeds', () => {
    const gate = makeRetryGate();
    const r = gate({ error: { code: -2010 } }, { value: { status: 'EXPIRED' } });
    expect(r.retry).toBe(true);
  });

  test('-2010 + getOrder REJECTED → retry proceeds', () => {
    const gate = makeRetryGate();
    const r = gate({ error: { code: -2010 } }, { value: { status: 'REJECTED' } });
    expect(r.retry).toBe(true);
  });

  test('-2010 + getOrder returns null → retry proceeds (defensive)', () => {
    const gate = makeRetryGate();
    const r = gate({ error: { code: -2010 } }, { value: null });
    expect(r.retry).toBe(true);
    expect(r.reason).toBe('not_filled');
  });

  test('-2010 + getOrder throws → retry proceeds (better dup than skip)', () => {
    const gate = makeRetryGate();
    const r = gate({ error: { code: -2010 } }, { error: new Error('network blip') });
    expect(r.retry).toBe(true);
    expect(r.reason).toBe('getOrder_failed');
  });

  test('replaced orderResp has the fields the downstream code needs', () => {
    // After replacement, code at L4685 reads orderResp.orderId, orderResp.status,
    // orderResp.transactTime. The Binance getOrder response MUST include these.
    const gate = makeRetryGate();
    const liveOrder = {
      symbol: 'BTCUSDT',
      orderId: 777,
      clientOrderId: 'b123456-buy-0',
      transactTime: 1700000000000,
      status: 'FILLED',
      executedQty: '0.001',
      cummulativeQuoteQty: '50.0',
      fills: [{ price: '50000', qty: '0.001' }],
    };
    const r = gate({ error: { code: -2010 } }, { value: liveOrder });
    expect(r.replacedOrderResp.orderId).toBe(777);
    expect(r.replacedOrderResp.status).toBe('FILLED');
    expect(r.replacedOrderResp.transactTime).toBe(1700000000000);
  });
});

describe('audit-H8 source: trader.js implements pre-retry getOrder check', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = path.join(__dirname, '..', 'src', 'core', 'trader.js');

  test('FIX-2026-09-01 audit H8 comment present in source', () => {
    expect(fs.readFileSync(SRC, 'utf8')).toMatch(/FIX-2026-09-01 audit H8/);
  });

  test('binanceRest.getOrder is called with origClientOrderId', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const block = src.match(/FIX-2026-09-01 audit H8[\s\S]{0,2500}/);
    expect(block).not.toBeNull();
    expect(block[0]).toMatch(/binanceRest\.getOrder\(/);
    expect(block[0]).toMatch(/origClientOrderId/);
  });

  test('FILLED + PARTIALLY_FILLED branches abort retry', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const block = src.match(/FIX-2026-09-01 audit H8[\s\S]{0,2500}/);
    expect(block[0]).toMatch(/liveOrder\.status\s*===\s*['"]FILLED['"]/);
    expect(block[0]).toMatch(/liveOrder\.status\s*===\s*['"]PARTIALLY_FILLED['"]/);
  });

  test('getOrder throw is caught (defensive — better dup than skip)', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const block = src.match(/FIX-2026-09-01 audit H8[\s\S]{0,2500}/);
    expect(block[0]).toMatch(/catch\s*\(\s*statusErr\s*\)/);
    expect(block[0]).toMatch(/proceeding with retry/);
  });

  test('orderResp is overwritten when live order is filled', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const block = src.match(/FIX-2026-09-01 audit H8[\s\S]{0,2500}/);
    expect(block[0]).toMatch(/orderResp\s*=\s*liveOrder/);
  });
});
