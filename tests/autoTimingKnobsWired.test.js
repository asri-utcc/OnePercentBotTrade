/**
 * FIX-2026-09-01 audit C9: Auto-Timing dead-code wiring
 *
 * slTightenPct and minKcMult were defined in autoTimingDecider.js + defaulted in
 * autoTimingDefaults.js, but NEVER read by trader.js or botManager.js. Now:
 *   - slTightenPct → trader.js:_checkStopLossOnUpperKC lowers upperKC threshold
 *     by (1 - slTightenPct/100). When slTightenPct=8 and upperKC=100, the SL
 *     triggers at 92 (not 100).
 *   - minKcMult → botManager.js:checkAutoPauseBots multiplies autoPauseMinKcPct
 *     by minKcMult. When minKcMult=1.5 and autoPauseMinKcPct=2, the effective
 *     threshold is 3.0 (less likely to unpause in low-volatility cells).
 *
 * Contract tests verify:
 *   - Both wirings exist (static)
 *   - trader.js fetches autoTiming decision + applies slTightenPct
 *   - botManager.js fetches autoTiming decision + applies minKcMult
 *   - autoTiming module exports the noop default (slTightenPct:0, minKcMult:1)
 *   - No regression: existing TP tighten wiring still intact
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TRADER_PATH     = path.join(__dirname, '..', 'src', 'core', 'trader.js');
const BOTMGR_PATH     = path.join(__dirname, '..', 'src', 'core', 'botManager.js');
const AUTOTIMING_PATH = path.join(__dirname, '..', 'src', 'services', 'autoTiming.js');

const traderRaw     = fs.readFileSync(TRADER_PATH,     'utf8');
const botMgrRaw     = fs.readFileSync(BOTMGR_PATH,     'utf8');
const autoTimingRaw = fs.readFileSync(AUTOTIMING_PATH, 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s;,(])\/\/[^\n]*/g, '$1');
}

describe('audit-C9 slTightenPct wiring — trader.js:_checkStopLossOnUpperKC', () => {
  test('trader.js imports autoTiming service', () => {
    expect(traderRaw).toMatch(/require\(['"]\.\.\/services\/autoTiming['"]\)/);
  });

  test('slTightenPct comment block present (audit trail)', () => {
    // Comments are stripped by stripComments — check the raw file instead.
    expect(traderRaw).toMatch(/audit C9[\s\S]{0,400}slTightenPct/);
  });

  test('_checkStopLossOnUpperKC awaits autoTiming.decideForBot', () => {
    const slBlock = traderRaw.match(/effectiveUpperKC = upperKC \* \(1 - slTightenPct \/ 100\)/);
    expect(slBlock).not.toBeNull();
    const awaitIdx = traderRaw.indexOf('await autoTiming.decideForBot(this.bot, Date.now())');
    const effIdx = traderRaw.indexOf('effectiveUpperKC = upperKC * (1 - slTightenPct / 100)');
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(effIdx).toBeGreaterThan(awaitIdx);
  });

  test('trigger condition uses effectiveUpperKC (not raw upperKC)', () => {
    expect(stripComments(traderRaw)).toMatch(/if \(closePrice <= effectiveUpperKC\) return;/);
  });

  test('slTightenPct defaults to 0 (no-op when decision missing)', () => {
    const initBlock = traderRaw.match(/const slTightenPct = slDec[\s\S]{0,200}slDec\.slTightenPct : 0/);
    expect(initBlock).not.toBeNull();
  });

  test('slTightenPct bounded to (0, 100) — no negative or huge multiplier', () => {
    expect(stripComments(traderRaw)).toMatch(/if \(slTightenPct > 0 && slTightenPct < 100\)/);
  });

  test('fail-OPEN: try/catch around autoTiming.decideForBot preserves original threshold', () => {
    const tryBlock = traderRaw.match(/try\s*\{[\s\S]{0,800}autoTiming\.decideForBot[\s\S]{0,600}\}\s*catch\s*\([^)]*\)\s*\{[\s\S]{0,200}fail-OPEN/);
    expect(tryBlock).not.toBeNull();
  });
});

describe('audit-C9 minKcMult wiring — botManager.js:checkAutoPauseBots', () => {
  test('botManager.js imports autoTiming service', () => {
    expect(stripComments(botMgrRaw)).toMatch(/const autoTiming = require\(['"]\.\.\/services\/autoTiming['"]\)/);
  });

  test('minKcMult comment block present (audit trail)', () => {
    expect(botMgrRaw).toMatch(/audit C9[\s\S]{0,300}minKcMult/);
  });

  test('checkAutoPauseBots loop awaits autoTiming.decideForBot per bot', () => {
    const loopBlock = botMgrRaw.match(/for \(const b of bots\)\s*\{[\s\S]{0,3000}autoTiming\.decideForBot\(b, Date\.now\(\)\)/);
    expect(loopBlock).not.toBeNull();
  });

  test('kcThreshold is multiplied by kcMult', () => {
    expect(stripComments(botMgrRaw)).toMatch(/const kcThreshold = baseKcPct \* kcMult/);
  });

  test('kcMult bounded to (0, 5] — prevents runaway threshold', () => {
    expect(stripComments(botMgrRaw)).toMatch(/if \(m > 0 && m <= 5\) kcMult = m/);
  });

  test('fail-OPEN: try/catch around autoTiming.decideForBot keeps kcMult=1', () => {
    const tryBlock = botMgrRaw.match(/let kcMult = 1;[\s\S]{0,800}autoTiming\.decideForBot[\s\S]{0,600}\}\s*catch\s*\([^)]*\)\s*\{[\s\S]{0,200}fail-OPEN/);
    expect(tryBlock).not.toBeNull();
  });

  test('baseKcPct variable preserves original autoPauseMinKcPct logic', () => {
    expect(stripComments(botMgrRaw)).toMatch(/const baseKcPct = b\.autoPauseMinKcPct != null \? b\.autoPauseMinKcPct : 2/);
  });
});

describe('audit-C9 autoTiming service — noop defaults preserve safety', () => {
  test('decideForBot noop returns slTightenPct:0 and minKcMult:1', () => {
    // Locate the noOp object — it is defined inside decideForBot.
    // The fields live on the same line: `tpTightenPct: 0, slTightenPct: 0, minKcMult: 1,`.
    expect(autoTimingRaw).toMatch(/tpTightenPct: 0, slTightenPct: 0, minKcMult: 1/);
  });

  test('master-disabled and bot-opted-out both return noop (fail-safe)', () => {
    const stripped = stripComments(autoTimingRaw);
    expect(stripped).toMatch(/if \(!this\._config \|\| !this\._config\.enabled\) return noOp\(\)/);
    expect(stripped).toMatch(/if \(bot\.autoTimingEnabled === false\) return noOp\(\)/);
  });
});

describe('audit-C9 regression — existing TP tighten wiring still intact', () => {
  test('tpTightenPct consumed at trader.js (pre-existing wire)', () => {
    // Grep is tolerant of line spacing.
    expect(traderRaw).toMatch(/atTpTightenPct\s*=\s*atDecision[\s\S]{0,40}tpTightenPct/);
  });

  test('forceST1 / forceST2 / forceCBv5 still consumed (no regression)', () => {
    const expectWire = (field) => {
      const re = new RegExp(`this\\._autoTimingDecision\\?\\.${field} === true`);
      expect(traderRaw).toMatch(re);
    };
    expectWire('forceST1');
    expectWire('forceST2');
    expect(traderRaw).toMatch(/forceCBv5/);
  });
});
