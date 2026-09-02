'use strict';

/**
 * FIX-2026-09-01 audit H13: autoArmLossPct / autoArmAgeHours must NOT be in
 * preservedKeys.
 *
 *   trader.js maintains an in-memory snapshot of the Bot document and refreshes
 *   it on every bot:updated event. The refresh loop (lines 562-568) copies
 *   every field from the fresh DB doc to the in-memory bot — EXCEPT the
 *   fields listed in `preservedKeys`, where the in-memory value wins.
 *
 *   The list is meant to protect "live runtime" state — fields that the
 *   trader manages in-memory and shouldn't get clobbered by stale DB writes:
 *     - status, currentTrade, lastSignalCloseTime, lastError
 *     - cbLastFiredAt / cbv2LastFiredAt / cbv3LastFiredAt / cbv5LastFiredAt
 *     - autoArmedAt (the suppression timestamp)
 *
 *   BUG: autoArmLossPct and autoArmAgeHours were lumped in with autoArmedAt.
 *   They are TUNABLE CONFIG fields, not runtime state. The admin can change
 *   them live via PUT /api/bots/:id (bot.routes.js whitelist at line 1187).
 *   Trader.js reads them on every tick (lines 864-865, 899-900, 909-910).
 *
 *   Effect of the bug: admin updates autoArmLossPct 10→15 → DB writes 15 →
 *   bot:updated fires → preservedKeys check skips it → in-memory stays 10.
 *   Trader keeps using stale 10% threshold indefinitely.
 *
 *   Fix: REMOVE autoArmLossPct and autoArmAgeHours from preservedKeys (the
 *   timestamp autoArmedAt stays).
 */

const fs = require('fs');
const path = require('path');

const TRADER_PATH = path.join(__dirname, '..', 'src', 'core', 'trader.js');
const traderRaw = fs.readFileSync(TRADER_PATH, 'utf8');

function extractPreservedKeysArray(src) {
  // Find the literal array between `const preservedKeys = [` and the matching `];`
  const start = src.indexOf('const preservedKeys = [');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const preservedKeysBlock = extractPreservedKeysArray(traderRaw);

describe('audit-H13 trader preservedKeys: tunable config fields excluded', () => {
  test('preservedKeys array exists and is parseable', () => {
    expect(preservedKeysBlock).not.toBeNull();
    expect(preservedKeysBlock).toMatch(/const preservedKeys\s*=\s*\[/);
    expect(preservedKeysBlock).toMatch(/\];?\s*$/);
  });

  test('autoArmLossPct is NOT in preservedKeys', () => {
    // Must NOT appear as a bare string element in the array
    expect(preservedKeysBlock).not.toMatch(/['"]autoArmLossPct['"]/);
  });

  test('autoArmAgeHours is NOT in preservedKeys', () => {
    expect(preservedKeysBlock).not.toMatch(/['"]autoArmAgeHours['"]/);
  });

  test('autoArmedAt (timestamp) IS still preserved', () => {
    // The suppression timestamp must remain so the in-memory cooldown window
    // is not clobbered by stale DB writes.
    expect(preservedKeysBlock).toMatch(/['"]autoArmedAt['"]/);
  });
});

describe('audit-H13 trader preservedKeys: runtime state still preserved', () => {
  // Regression: make sure the cleanup didn't strip other fields.
  const expected = [
    '_id', 'status', 'lastSignalCloseTime', 'lastSignalAt',
    'totalPnl', 'totalTrades', 'winTrades', 'lastError',
    'createdAt', 'updatedAt', '__v',
    'cbLastFiredAt', 'cbv2LastFiredAt',
    'cbv3LastFiredAt', 'cbv5LastFiredAt',
    'autoArmedAt',
  ];
  for (const key of expected) {
    test(`${key} is preserved`, () => {
      const re = new RegExp(`['"]${key.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')}['"]`);
      expect(preservedKeysBlock).toMatch(re);
    });
  }
});

describe('audit-H13 trader preservedKeys: source annotation', () => {
  test('FIX-2026-09-01 audit H13 comment is present', () => {
    expect(traderRaw).toMatch(/FIX-2026-09-01 audit H13/);
  });

  test('comment mentions admin PUT and live tunable', () => {
    // The comment should justify WHY these fields were removed (not silently)
    expect(traderRaw).toMatch(/tunable/i);
    expect(traderRaw).toMatch(/PUT\s*\/api\/bots/i);
  });
});

describe('audit-H13 trader preservedKeys: bot.routes.js PUT whitelist includes the fields', () => {
  // Pre-condition: admin PUT must be able to write the fields. If the whitelist
  // was missing them, removing from preservedKeys wouldn't help.
  const BOT_ROUTES_PATH = path.join(__dirname, '..', 'src', 'api', 'routes', 'bot.routes.js');
  const botRoutesRaw = fs.readFileSync(BOT_ROUTES_PATH, 'utf8');

  test('autoArmLossPct in PUT /:id whitelist (bot.routes.js)', () => {
    expect(botRoutesRaw).toMatch(/['"]autoArmLossPct['"]/);
  });

  test('autoArmAgeHours in PUT /:id whitelist (bot.routes.js)', () => {
    expect(botRoutesRaw).toMatch(/['"]autoArmAgeHours['"]/);
  });
});

describe('audit-H13 trader preservedKeys: trader.js READS these fields on every tick', () => {
  // Sanity: confirm the fields are actually consumed (not orphaned config).
  test('trader.js reads this.bot.autoArmLossPct', () => {
    expect(traderRaw).toMatch(/this\.bot\.autoArmLossPct/);
  });

  test('trader.js reads this.bot.autoArmAgeHours', () => {
    expect(traderRaw).toMatch(/this\.bot\.autoArmAgeHours/);
  });
});

describe('audit-H13 runtime replica: bot:updated refresh propagates autoArmLossPct', () => {
  // Re-implement the refresh loop from trader.js:540-568 in a tiny replica,
  // confirm that a DB write to autoArmLossPct propagates to the in-memory bot.
  const { preservedKeys } = (() => {
    // Pull the literal array entries out of the source
    const block = extractPreservedKeysArray(traderRaw);
    // Match each quoted element
    const entries = [];
    const re = /['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(block))) entries.push(m[1]);
    return { preservedKeys: entries };
  })();

  function refreshBot(inMemory, freshFromDb) {
    const next = { ...inMemory };
    for (const k of Object.keys(freshFromDb)) {
      if (preservedKeys.includes(k)) continue;
      if (k in inMemory) next[k] = freshFromDb[k];
    }
    return next;
  }

  test('replica setup: autoArmLossPct is not in preservedKeys', () => {
    expect(preservedKeys).not.toContain('autoArmLossPct');
    expect(preservedKeys).not.toContain('autoArmAgeHours');
  });

  test('autoArmLossPct change in DB propagates after bot:updated', () => {
    const inMemory = { _id: 'b1', status: 'running', autoArmLossPct: 10, autoArmAgeHours: 4, autoArmedAt: 1700000000000 };
    const fresh = { ...inMemory, autoArmLossPct: 15, autoArmAgeHours: 8 };
    const after = refreshBot(inMemory, fresh);
    expect(after.autoArmLossPct).toBe(15);
    expect(after.autoArmAgeHours).toBe(8);
  });

  test('autoArmedAt (timestamp) is preserved across refresh', () => {
    const inMemory = { _id: 'b1', status: 'running', autoArmedAt: 1700000000000 };
    const fresh = { ...inMemory, autoArmedAt: null }; // DB cleared it (toggle off then on)
    const after = refreshBot(inMemory, fresh);
    expect(after.autoArmedAt).toBe(1700000000000); // in-memory wins
  });

  test('status is preserved (in-memory wins over DB)', () => {
    const inMemory = { _id: 'b1', status: 'running' };
    const fresh = { ...inMemory, status: 'stopped' }; // admin paused via another route
    const after = refreshBot(inMemory, fresh);
    expect(after.status).toBe('running');
  });

  test('tpPercent (tunable) propagates after bot:updated', () => {
    const inMemory = { _id: 'b1', tpPercent: 0.4 };
    const fresh = { ...inMemory, tpPercent: 0.5 };
    const after = refreshBot(inMemory, fresh);
    expect(after.tpPercent).toBe(0.5);
  });
});