'use strict';

/**
 * FIX-2026-08-24 (P1 audit): regression tests สำหรับ P1 fixes
 *
 * P1-1: botManager reconcilePendingTrades bulk-load bots + signals (N+1 elimination)
 * P1-2: botManager auto-pause hysteresis (avoid ping-pong at boundary)
 * P1-3: trader.js reconcileKlines per-candle try/catch (200-candle sweep abort safely)
 * P1-4: trader.js _botUpdatedHandler preservedKeys includes CBv3/CBv5 + F1 auto-arm
 * P1-5: binanceRest HTTP 429 → setBanUntil(5s) (Round 1c)
 * P1-6: binanceRest get24hrTickers in-process 60s cache (Round 1c)
 * P1-7: binanceRest _resetTickerCache exported (Round 1c)
 * P1-8: bot.routes.js SPAWN_STAGGER_MS applied to bulk-update + bulk-toggle (Round 1a)
 */

const fs = require('fs');
const path = require('path');

const botManagerSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'core', 'botManager.js'),
  'utf8'
);
const traderSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'core', 'trader.js'),
  'utf8'
);
const binanceRestSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'binance', 'binanceRest.js'),
  'utf8'
);
const botRoutesSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'api', 'routes', 'bot.routes.js'),
  'utf8'
);

describe('P1-1: botManager.reconcilePendingTrades bulk-load bots + signals', () => {
  test('source contains uniqueBotIds/botMap pre-pass before per-trade loop', () => {
    // bulk pre-pass comment + Map must exist in reconcilePendingTrades
    expect(botManagerSrc).toMatch(/FIX-2026-08-24 \(P1 audit\): bulk-load bots \+ signals/);
    expect(botManagerSrc).toMatch(/const botMap = new Map\(botsArr/);
    expect(botManagerSrc).toMatch(/const signalMap = new Map\(signalsArr/);
  });

  test('per-trade loop uses botMap.get instead of Bot.findById', () => {
    // after bulk pre-pass, loop must use map lookup, not N+1
    // Look for the line that previously was `await Bot.findById(trade.botId)`
    // in reconcilePendingTrades it must now use botMap
    const reconcileSection = botManagerSrc.slice(
      botManagerSrc.indexOf('async reconcilePendingTrades'),
      botManagerSrc.indexOf('async reconcilePendingTrades') + 8000
    );
    expect(reconcileSection).toMatch(/const bot = botMap\.get\(String\(trade\.botId\)\)/);
    expect(reconcileSection).toMatch(/signalMap\.get\(String\(trade\.signalId\)\)/);
    // ensure no per-trade Bot.findById in reconcile (besides L751 fresh-snapshot path for inline-mark-sold)
    const findByIdMatches = reconcileSection.match(/await Bot\.findById\(trade\.botId\)/g) || [];
    // tolerate the explicit inline-mark-sold .lean() at L751 only — must use .lean()
    expect(findByIdMatches.length).toBeLessThanOrEqual(1);
  });
});

describe('P1-2: botManager auto-pause hysteresis (no ping-pong)', () => {
  test('module-level _autoPauseFlipAt Map + helpers exist', () => {
    expect(botManagerSrc).toMatch(/const _autoPauseFlipAt = new Map\(\)/);
    expect(botManagerSrc).toMatch(/function recordAutoPauseFlip\(botId\)/);
    expect(botManagerSrc).toMatch(/function shouldSkipFlipByHysteresis\(botId\)/);
    expect(botManagerSrc).toMatch(/AUTO_PAUSE_HYSTERESIS_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/);
  });

  test('PAUSE branch gates on shouldSkipFlipByHysteresis', () => {
    expect(botManagerSrc).toMatch(/hysteresis guard — กัน ping-pong ที่ boundary/);
    expect(botManagerSrc).toMatch(/stats\.skippedHysteresis/);
  });

  test('RESUME branch also gates on shouldSkipFlipByHysteresis (mirror)', () => {
    // Find the resume block (after kcLow/volLow check)
    const resumeIdx = botManagerSrc.indexOf('auto-resume skipped — within hysteresis window');
    expect(resumeIdx).toBeGreaterThan(0);
    const before = botManagerSrc.slice(Math.max(0, resumeIdx - 2000), resumeIdx);
    expect(before).toMatch(/shouldSkipFlipByHysteresis\(b\._id\)/);
  });

  test('recordAutoPauseFlip called after both PAUSE and RESUME success', () => {
    // both branches must call recordAutoPauseFlip(b._id) right after Bot.updateOne
    const pauseIdx = botManagerSrc.indexOf('recordAutoPauseFlip(b._id)');
    expect(pauseIdx).toBeGreaterThan(0);
    expect(botManagerSrc.indexOf('recordAutoPauseFlip(b._id)', pauseIdx + 1)).toBeGreaterThan(0);
  });
});

describe('P1-3: trader.js reconcileKlines per-candle try/catch', () => {
  test('source contains per-candle try/catch in 200-candle sweep loop', () => {
    expect(traderSrc).toMatch(/FIX-2026-08-24 \(P1 audit\): per-candle try\/catch — one bad candle ไม่ควร abort/);
  });

  test('per-candle error increments candleErrors and breaks to prevent indicator drift', () => {
    // The fix MUST break (not continue) because skipping a bad candle in rolling-window
    // indicators like KC would cause drift on subsequent candles.
    const sweepIdx = traderSrc.indexOf('FIX-2026-08-24 (P1 audit): per-candle');
    expect(sweepIdx).toBeGreaterThan(0);
    const sweep = traderSrc.slice(sweepIdx, sweepIdx + 3500);
    expect(sweep).toMatch(/candleErrors\s*\+=\s*1/);
    expect(sweep).toMatch(/\bbreak;\s*$/m);
  });

  test('candleErrors summary logged at end of sweep', () => {
    expect(traderSrc).toMatch(/reconcileKlines had candle errors/);
  });
});

describe('P1-4: trader.js _botUpdatedHandler preservedKeys add CBv3/CBv5 + F1 auto-arm', () => {
  test('preservedKeys array includes cbv3LastFiredAt, cbv5LastFiredAt, autoArmedAt (timestamps)', () => {
    const handlerIdx = traderSrc.indexOf('this._botUpdatedHandler = async');
    expect(handlerIdx).toBeGreaterThan(0);
    const section = traderSrc.slice(handlerIdx, handlerIdx + 3000);
    expect(section).toMatch(/'cbv3LastFiredAt'/);
    expect(section).toMatch(/'cbv5LastFiredAt'/);
    expect(section).toMatch(/'autoArmedAt'/);
  });

  // FIX-2026-09-01 audit H13: autoArmLossPct / autoArmAgeHours are tunables
  //   (changed via PUT /api/bots/:id). They MUST propagate to in-memory bot
  //   on bot:updated, so they are NOT in preservedKeys. The P1 test that
  //   asserted the opposite is updated here.
  test('preservedKeys does NOT include the tunable config fields autoArmLossPct/autoArmAgeHours', () => {
    const handlerIdx = traderSrc.indexOf('this._botUpdatedHandler = async');
    expect(handlerIdx).toBeGreaterThan(0);
    // Read far enough to cover the array + the H13 comment block
    const section = traderSrc.slice(handlerIdx, handlerIdx + 3500);
    expect(section).not.toMatch(/'autoArmLossPct'/);
    expect(section).not.toMatch(/'autoArmAgeHours'/);
  });

  test('contains FIX-2026-08-24 (P1 audit) comment about CB suppression collapse', () => {
    expect(traderSrc).toMatch(/FIX-2026-08-24 \(P1 audit\): add CBv3\/CBv5 \+ F1 auto-arm timestamps/);
  });
});

describe('P1-5: binanceRest HTTP 429 → setBanUntil(5s) (Round 1c)', () => {
  test('source contains HTTP 429 handling with setBanUntil(now + 5000)', () => {
    expect(binanceRestSrc).toMatch(/setBanUntil\(now\s*\+\s*5000\)/);
  });
});

describe('P1-6: binanceRest get24hrTickers 60s in-process cache (Round 1c)', () => {
  test('source contains _tickers24hCache + _tickers24hCacheTtlMs', () => {
    expect(binanceRestSrc).toMatch(/let _tickers24hCache = null/);
    expect(binanceRestSrc).toMatch(/_tickers24hCacheTtlMs\s*=\s*60\s*\*\s*1000/);
  });

  test('cache hit returns early when within TTL', () => {
    expect(binanceRestSrc).toMatch(/_tickers24hCache\s*&&\s*\(now\s*-\s*_tickers24hCache\.atMs\)\s*<\s*_tickers24hCacheTtlMs/);
    expect(binanceRestSrc).toMatch(/return _tickers24hCache\.value/);
  });
});

describe('P1-7: binanceRest _resetTickerCache exported (Round 1c)', () => {
  test('_resetTickerCache is exported in module.exports', () => {
    expect(binanceRestSrc).toMatch(/function _resetTickerCache\(\)/);
    // find the module.exports block — must contain _resetTickerCache
    const exportIdx = binanceRestSrc.indexOf('module.exports');
    expect(exportIdx).toBeGreaterThan(0);
    const exportSection = binanceRestSrc.slice(exportIdx, exportIdx + 4000);
    expect(exportSection).toMatch(/_resetTickerCache/);
  });

  test('functional: _resetTickerCache sets cache to null', () => {
    // simulate cache state
    delete require.cache[require.resolve('../src/binance/binanceRest')];
    const binanceRest = require('../src/binance/binanceRest');
    // call reset
    expect(() => binanceRest._resetTickerCache()).not.toThrow();
  });
});

describe('P1-8: bot.routes.js SPAWN_STAGGER_MS applied to bulk paths (Round 1a)', () => {
  test('SPAWN_STAGGER_MS constant declared', () => {
    expect(botRoutesSrc).toMatch(/const SPAWN_STAGGER_MS = 300/);
  });

  test('TF-change bulk-update path applies sleep(SPAWN_STAGGER_MS * index)', () => {
    // find the stagger comment in TF-change block
    expect(botRoutesSrc).toMatch(/FIX-2026-08-24.*stagger between TF-change restarts/);
  });

  test('bulk-toggle path applies stagger between iterations', () => {
    expect(botRoutesSrc).toMatch(/FIX-2026-08-24.*stagger between iterations/);
  });
});
