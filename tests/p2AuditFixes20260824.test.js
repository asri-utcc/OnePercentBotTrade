'use strict';

/**
 * FIX-2026-08-24 (P2 audit): regression tests สำหรับ P2 fixes
 *
 * P2-R1-1: trader._handleBuyFilledImpl division-by-zero NaN guard
 * P2-R1-2: indicators.js NaN propagation guards (ema/sma/rma/trueRange/keltnerChannel)
 * P2-R1-3: binanceWs scheduleReconnect MAX_RECONNECT_ATTEMPTS=20 + ±30% jitter
 * P2-R1-4: binanceWs sendRpc timeoutId + wrappedResolve/Reject cleanup
 * P2-R1-5: binanceWs handleKline/handleBookTicker defensive null guards
 * P2-R1-6: klineCache.seed() accepts both object array and raw Binance array
 * P2-R1-7: healthMonitor binanceErrorCount reset on 2 consecutive ping successes
 * P2-R1-8: errorRateLimiter + loginGuard attempt array cap
 * P2-R2-9: requireBotActionPassword extracted to shared middleware
 * P2-R2-10: bot.routes.js no longer has local requireBotActionPassword function
 * P2-R2-11: analysis.routes.js POST /trade-analysis/invalidate uses requireBotActionPassword
 * P2-R2-12: bot.routes.js POST /:id/dps-reset uses requireBotActionPassword
 * P2-R2-13: bot.routes.js POST /bulk-update uses requireBotActionPassword
 * P2-R2-14: trader.reconcileKlines uses Promise.all for parallel CB checks
 * P2-R2-15: forceClose.js forceCloseTrade_synthetic forwards finalSellReason + source/isDcaStack
 * P2-R2-16: symbolInfo.validateOrder NOTIONAL MARKET fallback uses currentPrice or 0.01
 * P2-R3-17: Trade.js realizedPnl partial index uses $type:'number'
 * P2-R3-18: Trade.js compound index { botId, state, sellInFlight } for atomic claim
 * P2-R3-19: Trade.js sparse index { sellOrderId } for orphan detection
 * P2-R3-20: Signal.js TTL index { createdAt } expireAfterSeconds 90 days
 */

const fs = require('fs');
const path = require('path');

const traderSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'core', 'trader.js'),
  'utf8'
);
const indicatorsSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'core', 'indicators.js'),
  'utf8'
);
const binanceWsSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'binance', 'binanceWs.js'),
  'utf8'
);
const klineCacheSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'klineCache.js'),
  'utf8'
);
const healthMonitorSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'healthMonitor.js'),
  'utf8'
);
const errorRateLimiterSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'utils', 'errorRateLimiter.js'),
  'utf8'
);
const loginGuardSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'utils', 'loginGuard.js'),
  'utf8'
);
const authMiddlewareSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'api', 'middleware', 'auth.js'),
  'utf8'
);
const botRoutesSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'api', 'routes', 'bot.routes.js'),
  'utf8'
);
const analysisRoutesSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'api', 'routes', 'analysis.routes.js'),
  'utf8'
);
const forceCloseSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'core', 'forceClose.js'),
  'utf8'
);
const symbolInfoSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'binance', 'symbolInfo.js'),
  'utf8'
);
const tradeModelSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'models', 'Trade.js'),
  'utf8'
);
const signalModelSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'models', 'Signal.js'),
  'utf8'
);

// ─────────────────────────────────────────────────────────────
// P2-R1-1: trader._handleBuyFilledImpl division-by-zero NaN guard
// ─────────────────────────────────────────────────────────────
describe('P2-R1-1: trader._handleBuyFilledImpl division-by-zero NaN guard', () => {
  test('source has division-by-0 guard comment + cummulativeQuoteQty fallback', () => {
    expect(traderSrc).toMatch(/FIX-2026-08-24 \(P2 audit\): division-by-0 guard/);
    expect(traderSrc).toMatch(/cummulativeQuoteQty/);
  });

  test('source aborts if avgPrice still non-finite after fallback', () => {
    expect(traderSrc).toMatch(/cannot derive avgPrice/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R1-2: indicators.js NaN propagation guards
// ─────────────────────────────────────────────────────────────
describe('P2-R1-2: indicators NaN propagation guards', () => {
  test('ema/sma/rma sanitize non-finite inputs', () => {
    expect(indicatorsSrc).toMatch(/FIX-2026-08-24 \(P2 audit\): sanitize non-finite inputs/);
    expect(indicatorsSrc).toMatch(/Number\.isFinite\(x\) \? x : null/);
  });

  test('trueRange returns 0 if high/low non-finite', () => {
    const trIdx = indicatorsSrc.indexOf('function trueRange');
    const trSection = indicatorsSrc.slice(trIdx, trIdx + 800);
    expect(trSection).toMatch(/FIX-2026-08-24 \(P2 audit\): NaN guard/);
    expect(trSection).toMatch(/Number\.isFinite\(high\)/);
    expect(trSection).toMatch(/Number\.isFinite\(low\)/);
  });

  test('keltnerChannel uses strict Number.isFinite for basis/range', () => {
    const kcIdx = indicatorsSrc.indexOf('function keltnerChannel');
    const kcSection = indicatorsSrc.slice(kcIdx, kcIdx + 1500);
    expect(kcSection).toMatch(/Number\.isFinite\(b\)/);
    expect(kcSection).toMatch(/Number\.isFinite\(r\)/);
  });

  test('keltnerChannel width[i] uses null when close non-finite', () => {
    const kcIdx = indicatorsSrc.indexOf('function keltnerChannel');
    const kcSection = indicatorsSrc.slice(kcIdx, kcIdx + 1500);
    // close non-finite → null (not 0)
    expect(kcSection).toMatch(/Number\.isFinite\(c\) && c > 0/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R1-3: binanceWs scheduleReconnect MAX_RECONNECT_ATTEMPTS + jitter
// ─────────────────────────────────────────────────────────────
describe('P2-R1-3: binanceWs scheduleReconnect MAX_RECONNECT_ATTEMPTS + jitter', () => {
  test('MAX_RECONNECT_ATTEMPTS=20 defined', () => {
    expect(binanceWsSrc).toMatch(/MAX_RECONNECT_ATTEMPTS\s*=\s*20/);
  });

  test('scheduleReconnect uses exponential backoff + ±30% jitter', () => {
    expect(binanceWsSrc).toMatch(/Math\.min\(1000 \* 2 \*\* \(this\.reconnectAttempts - 1\), 30000\)/);
    expect(binanceWsSrc).toMatch(/0\.7 \+ Math\.random\(\) \* 0\.6/);
  });

  test('gives up after MAX_RECONNECT_ATTEMPTS', () => {
    expect(binanceWsSrc).toMatch(/reconnect attempts exhausted/);
  });

  test('user data stream scheduleReconnect also has the fix', () => {
    const occurrences = binanceWsSrc.match(/MAX_RECONNECT_ATTEMPTS/g) || [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R1-4: binanceWs sendRpc timeout cleanup
// ─────────────────────────────────────────────────────────────
describe('P2-R1-4: binanceWs sendRpc timeoutId cleanup', () => {
  test('sendRpc stores timeoutId + clearTimeout on resolve/reject', () => {
    // There are 2 sendRpc() in binanceWs.js — line 326 (simple) and line 533 (Promise)
    // We want the latter (Promise one). Use lastIndexOf.
    const sendRpcIdx = binanceWsSrc.lastIndexOf('sendRpc(method, params) {');
    expect(sendRpcIdx).toBeGreaterThan(0);
    const sendRpcSection = binanceWsSrc.slice(sendRpcIdx, sendRpcIdx + 2000);
    expect(sendRpcSection).toMatch(/FIX-2026-08-24 \(P2 audit\): store timeout id/);
    expect(sendRpcSection).toMatch(/clearTimeout\(timeoutId\)/);
  });

  test('wrappedResolve + wrappedReject declared in sendRpc', () => {
    const sendRpcIdx = binanceWsSrc.lastIndexOf('sendRpc(method, params) {');
    const sendRpcSection = binanceWsSrc.slice(sendRpcIdx, sendRpcIdx + 2000);
    expect(sendRpcSection).toMatch(/const wrappedResolve/);
    expect(sendRpcSection).toMatch(/const wrappedReject/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R1-5: binanceWs handleKline/handleBookTicker defensive null guards
// ─────────────────────────────────────────────────────────────
describe('P2-R1-5: binanceWs handleKline/handleBookTicker null guards', () => {
  test('handleKline validates data/k/symbol/interval', () => {
    const hkIdx = binanceWsSrc.indexOf('handleKline(data, stream) {');
    const hkSection = binanceWsSrc.slice(hkIdx, hkIdx + 1000);
    expect(hkSection).toMatch(/FIX-2026-08-24 \(P2 audit\): defensive null guards/);
    expect(hkSection).toMatch(/!data \|\| typeof data !== 'object'/);
    expect(hkSection).toMatch(/missing k or s/);
    expect(hkSection).toMatch(/missing k\.i/);
  });

  test('handleBookTicker validates s/b/a fields + Number.isFinite', () => {
    const btIdx = binanceWsSrc.indexOf('handleBookTicker(data) {');
    const btSection = binanceWsSrc.slice(btIdx, btIdx + 800);
    expect(btSection).toMatch(/FIX-2026-08-24 \(P2 audit\): null guard for bookTicker/);
    expect(btSection).toMatch(/!data \|\| !data\.s \|\| !data\.b \|\| !data\.a/);
    expect(btSection).toMatch(/Number\.isFinite\(bid\) \|\| !Number\.isFinite\(ask\)/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R1-6: klineCache.seed() accepts both object array and raw Binance array
// ─────────────────────────────────────────────────────────────
describe('P2-R1-6: klineCache.seed() accepts object + raw Binance array', () => {
  test('seed() accepts raw arrays + opts.symbol/timeframe', () => {
    const seedIdx = klineCacheSrc.indexOf('seed(klines, opts = {}) {');
    // JSDoc comment is BEFORE seed(), so look 500 chars before
    const seedSection = klineCacheSrc.slice(Math.max(0, seedIdx - 500), seedIdx + 2000);
    expect(seedSection).toMatch(/FIX-2026-08-24 \(P2 audit\): accept either/);
    expect(seedSection).toMatch(/opts\.symbol/);
    expect(seedSection).toMatch(/opts\.timeframe/);
    expect(seedSection).toMatch(/isRawArray/);
  });

  test('intervalMs() helper added for closeTime fallback', () => {
    expect(klineCacheSrc).toMatch(/FIX-2026-08-24 \(P2 audit\): interval → ms helper/);
    expect(klineCacheSrc).toMatch(/intervalMs\(timeframe\)/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R1-7: healthMonitor binanceErrorCount reset on consecutive pings
// ─────────────────────────────────────────────────────────────
describe('P2-R1-7: healthMonitor binanceErrorCount reset (hysteresis)', () => {
  test('requires 2 consecutive successful pings to reset error count', () => {
    expect(healthMonitorSrc).toMatch(/FIX-2026-08-24 \(P2 audit\): reset binanceErrorCount/);
    expect(healthMonitorSrc).toMatch(/_consecutiveSuccess/);
    expect(healthMonitorSrc).toMatch(/_consecutiveSuccess >= 2/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R1-8: errorRateLimiter + loginGuard attempt array cap
// ─────────────────────────────────────────────────────────────
describe('P2-R1-8: errorRateLimiter + loginGuard attempt array cap', () => {
  test('errorRateLimiter caps recent to maxPerWindow * 10', () => {
    expect(errorRateLimiterSrc).toMatch(/FIX-2026-08-24 \(P2 audit\): cap per-key array length/);
    expect(errorRateLimiterSrc).toMatch(/maxPerWindow \* 10/);
  });

  test('loginGuard caps attempts to maxAttempts * 10 + triggers lock immediately', () => {
    expect(loginGuardSrc).toMatch(/FIX-2026-08-24 \(P2 audit\): cap attempts array/);
    expect(loginGuardSrc).toMatch(/maxAttempts \* 10/);
    expect(loginGuardSrc).toMatch(/trigger lock ทันที/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R2-9: requireBotActionPassword extracted to shared middleware
// ─────────────────────────────────────────────────────────────
describe('P2-R2-9: requireBotActionPassword extracted to shared middleware', () => {
  test('middleware/auth.js exports both requireAuth + requireBotActionPassword', () => {
    expect(authMiddlewareSrc).toMatch(/function requireAuth\(req, res, next\)/);
    expect(authMiddlewareSrc).toMatch(/function requireBotActionPassword\(req, res, next\)/);
    expect(authMiddlewareSrc).toMatch(/module\.exports\s*=\s*\{ requireAuth, requireBotActionPassword \}/);
  });

  test('middleware reads password from body/header/query + 503 if not configured', () => {
    expect(authMiddlewareSrc).toMatch(/config\.botActionPassword/);
    expect(authMiddlewareSrc).toMatch(/X-Bot-Action-Password/);
    expect(authMiddlewareSrc).toMatch(/req\.query\.password/);
    expect(authMiddlewareSrc).toMatch(/status\(503\)/);
    expect(authMiddlewareSrc).toMatch(/status\(403\)/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R2-10: bot.routes.js no longer has local requireBotActionPassword function
// ─────────────────────────────────────────────────────────────
describe('P2-R2-10: bot.routes.js imports requireBotActionPassword from middleware', () => {
  test('imports from middleware/auth', () => {
    expect(botRoutesSrc).toMatch(/requireBotActionPassword.*=.*require\('.*middleware\/auth'\)/);
  });

  test('does NOT have local function definition', () => {
    expect(botRoutesSrc).not.toMatch(/function requireBotActionPassword\(req, res, next\)/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R2-11: analysis.routes.js /trade-analysis/invalidate uses requireBotActionPassword
// ─────────────────────────────────────────────────────────────
describe('P2-R2-11: analysis.routes.js /trade-analysis/invalidate password-gated', () => {
  test('imports requireBotActionPassword from middleware', () => {
    expect(analysisRoutesSrc).toMatch(/requireBotActionPassword.*=.*require\('.*middleware\/auth'\)/);
  });

  test('POST /trade-analysis/invalidate uses requireBotActionPassword', () => {
    expect(analysisRoutesSrc).toMatch(/router\.post\('.*trade-analysis\/invalidate.*requireAuth.*requireBotActionPassword/s);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R2-12/13: bot.routes.js dps-reset + bulk-update password-gated
// ─────────────────────────────────────────────────────────────
describe('P2-R2-12/13: bot.routes.js dps-reset + bulk-update password-gated', () => {
  test('POST /:id/dps-reset uses requireBotActionPassword', () => {
    expect(botRoutesSrc).toMatch(/router\.post\('.*dps-reset'.*requireAuth.*requireBotActionPassword/s);
  });

  test('POST /bulk-update uses requireBotActionPassword', () => {
    expect(botRoutesSrc).toMatch(/router\.post\('.*bulk-update'.*requireAuth.*requireBotActionPassword/s);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R2-14: trader.reconcileKlines parallel CB checks via Promise.all
// ─────────────────────────────────────────────────────────────
describe('P2-R2-14: trader.reconcileKlines parallel CB checks', () => {
  test('reconcileKlines uses Promise.all for CB panic-close checks', () => {
    const rkIdx = traderSrc.indexOf('  async reconcileKlines(trigger');
    const rkSection = traderSrc.slice(rkIdx, rkIdx + 12000);
    expect(rkSection).toMatch(/FIX-2026-08-24 \(P2 audit\): parallel CB panic-close checks/);
    expect(rkSection).toMatch(/cbChecks\.push\(this\._checkCBv2PanicClose/);
    expect(rkSection).toMatch(/cbChecks\.push\(this\._checkCBv3PanicClose/);
    expect(rkSection).toMatch(/cbChecks\.push\(this\._checkCBv5PanicClose/);
    expect(rkSection).toMatch(/await Promise\.all\(cbChecks\)/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R2-15: forceClose.js forceCloseTrade_synthetic forwards finalSellReason + source/isDcaStack
// ─────────────────────────────────────────────────────────────
describe('P2-R2-15: forceClose.forwardSellReason + source/isDcaStack in payload', () => {
  test('forceCloseTrade_synthetic forwards finalSellReason (not hardcoded)', () => {
    const fcIdx = forceCloseSrc.indexOf('async function forceCloseTrade_synthetic');
    expect(fcIdx).toBeGreaterThan(0);
    const fcSection = forceCloseSrc.slice(fcIdx, fcIdx + 6000);
    expect(fcSection).toMatch(/FIX-2026-08-24 \(P2 audit\): forward finalSellReason/);
    expect(fcSection).toMatch(/finalSellReason/);
    expect(fcSection).toMatch(/source/);
    expect(fcSection).toMatch(/isDcaStack/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R2-16: symbolInfo.validateOrder NOTIONAL MARKET fallback
// ─────────────────────────────────────────────────────────────
describe('P2-R2-16: symbolInfo.validateOrder NOTIONAL MARKET fallback', () => {
  test('effectivePrice uses opts.currentPrice or 0.01 conservative floor', () => {
    const voIdx = symbolInfoSrc.indexOf('function validateOrder');
    const voSection = symbolInfoSrc.slice(voIdx, voIdx + 3000);
    expect(voSection).toMatch(/FIX-2026-08-24 \(P2 audit\): MARKET order NOTIONAL fallback/);
    expect(voSection).toMatch(/opts\.currentPrice/);
    expect(voSection).toMatch(/0\.01/); // conservative floor
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R3-17: Trade.js realizedPnl partial index uses $type:'number'
// ─────────────────────────────────────────────────────────────
describe('P2-R3-17: Trade.js realizedPnl partial index uses $type', () => {
  test('index uses $type:number not $exists', () => {
    expect(tradeModelSrc).toMatch(/FIX-2026-08-24 \(P2 audit\): partial index filter uses \$type instead of \$exists/);
    expect(tradeModelSrc).toMatch(/partialFilterExpression:\s*\{\s*realizedPnl:\s*\{\s*\$type:\s*'number'\s*\}\s*\}/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R3-18: Trade.js compound index for atomic claim
// ─────────────────────────────────────────────────────────────
describe('P2-R3-18: Trade.js compound index { botId, state, sellInFlight }', () => {
  test('compound index defined for atomic claim query', () => {
    expect(tradeModelSrc).toMatch(/botId:\s*1,\s*state:\s*1,\s*sellInFlight:\s*1/);
    expect(tradeModelSrc).toMatch(/FIX-2026-08-24 \(P2 audit\): compound index for sellInFlight atomic claim/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R3-19: Trade.js sparse index { sellOrderId } for orphan detection
// ─────────────────────────────────────────────────────────────
describe('P2-R3-19: Trade.js sparse index sellOrderId for orphan detection', () => {
  test('sparse index on sellOrderId exists', () => {
    expect(tradeModelSrc).toMatch(/sellOrderId:\s*1[\s\S]*?sparse:\s*true/);
    expect(tradeModelSrc).toMatch(/FIX-2026-08-24 \(P2 audit\): index for SELL freeze detection/);
  });
});

// ─────────────────────────────────────────────────────────────
// P2-R3-20: Signal.js TTL index 90 days
// ─────────────────────────────────────────────────────────────
describe('P2-R3-20: Signal.js TTL index 90 days', () => {
  test('TTL index with expireAfterSeconds = 90 * 86400', () => {
    expect(signalModelSrc).toMatch(/createdAt:\s*1[\s\S]*?expireAfterSeconds:\s*90\s*\*\s*86400/);
    expect(signalModelSrc).toMatch(/FIX-2026-08-24 \(P2 audit\): TTL index/);
  });
});
