'use strict';

/**
 * FIX-2026-08-09: unit tests for the dpsAfterClose helper
 *
 *   - the helper is wired into forceClose.js, trader._emergencyMarketSell,
 *     trader.handleSellFilled, and botManager orphan reconcile
 *   - it must evaluate DPS for ANY SELL close (loss AND win) so Rule 3
 *     (loss-streak → size -2 USDT, layers -2) actually fires
 *   - try/catch wraps everything so SELL flow never breaks
 *   - bot snapshot is reloaded from DB to avoid stale in-memory data
 *   - masterDynamicSizeEnabled toggle is respected
 *
 * These tests are pure-unit (mock Bot + masterConfig + telegramNotifier) — no DB.
 * For end-to-end DB-level test see tests/dps.integration.test.js.
 */

// Mock Bot model BEFORE requiring the helper → the helper's `new Bot()` lookup is reusable
jest.mock('../src/db/models/Bot', () => {
  const mockUpdateOne = jest.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
  function MockBot() {}
  MockBot.findById = jest.fn();
  MockBot.updateOne = mockUpdateOne;
  MockBot.__updateOne = mockUpdateOne;
  // Helper exposes a setter so we can configure the next findById() response
  //   set: Bot.__setFindByIdResult(promise) — overrides next call
  MockBot.__setFindByIdResult = (val) => {
    const lean = typeof val === 'object' && val !== null && typeof val.then !== 'function'
      ? () => Promise.resolve(val)
      : () => val;
    MockBot.findById.mockReturnValue({ lean });
  };
  return MockBot;
});
jest.mock('../src/core/masterConfig', () => ({
  getMasterToggles: jest.fn().mockResolvedValue({ masterDynamicSizeEnabled: true }),
  getDpsConfig: jest.fn().mockResolvedValue({
    minSize: 6, maxSize: 15, minLayers: 1, maxLayers: 5,
    cooldownMs: 5 * 60 * 1000,
    winStreakCount: 3, winStreakDeltaSize: 1, winStreakDeltaLayers: 1,
    bigWinCount: 2, bigWinPct: 2.0, bigWinDeltaSize: 2, bigWinDeltaLayers: 0,
    lossStreakCount: 1, lossDeltaSize: -2, lossDeltaLayers: -2,
    respectBotCapital: true, resetHistoryOnFire: true, dryRun: false,
  }),
}));
jest.mock('../src/services/telegramNotifier', () => ({
  sendNow: jest.fn().mockResolvedValue(true),
}));

const Bot = require('../src/db/models/Bot');
const masterConfig = require('../src/core/masterConfig');
const telegramNotifier = require('../src/services/telegramNotifier');
const dpsAfterClose = require('../src/core/dpsAfterClose');

const baseBot = (overrides = {}) => ({
  _id: 'bot-test-1',
  name: 'TEST',
  symbol: 'TESTUSDT',
  timeframe: '5m',
  capitalPerTrade: 9,
  maxTrades: 5,
  dynamicSizeEnabled: true,
  dcaEnabled: false,
  martingaleEnabled: false,
  dynamicSizeCurrent: null,
  dynamicLayersCurrent: null,
  dynamicSizeLastResults: [],
  dynamicSizeCooldownUntil: null,
  _masterDynamicSizeEnabled: true,
  ...overrides,
});

describe('dpsAfterClose.evaluateDpsAfterClose', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Bot.findById.mockReset();
    Bot.__updateOne.mockReset();
    Bot.__updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    masterConfig.getMasterToggles.mockResolvedValue({ masterDynamicSizeEnabled: true });
    masterConfig.getDpsConfig.mockResolvedValue({
      minSize: 6, maxSize: 15, minLayers: 1, maxLayers: 5,
      cooldownMs: 5 * 60 * 1000,
      winStreakCount: 3, winStreakDeltaSize: 1, winStreakDeltaLayers: 1,
      bigWinCount: 2, bigWinPct: 2.0, bigWinDeltaSize: 2, bigWinDeltaLayers: 0,
      lossStreakCount: 1, lossDeltaSize: -2, lossDeltaLayers: -2,
      respectBotCapital: true, resetHistoryOnFire: true, dryRun: false,
    });
    telegramNotifier.sendNow.mockResolvedValue(true);
  });

  // helper to set the next findById result (returns Query with .lean())
  const mockBotFound = (bot) => Bot.__setFindByIdResult(bot);
  const mockBotError = (err) => Bot.__setFindByIdResult(Promise.reject(err));

  // ─────────────────────────────────────────────────────────────────────
  // 1. Loss-streak rule fires end-to-end (the P0 bug)
  // ─────────────────────────────────────────────────────────────────────
  test('loss-streak rule fires: loss PnL → size decreases, history appends isWin=false', async () => {
    mockBotFound(baseBot());

    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: baseBot(),
      pnl: -1.23,
      pnlPct: -5.0,
      source: 'forceClose:market:cbv3_panic',
    });

    expect(result).toBeTruthy();
    expect(result.changed).toBe(true);
    expect(result.reason).toBe('loss');
    expect(result.before.size).toBe(9);
    expect(result.after.size).toBe(7);  // 9 + (-2) = 7
    expect(result.after.layers).toBe(3); // 5 + (-2) = 3
    // resetHistoryOnFire=true → history cleared after rule fires (next loss starts fresh streak)
    expect(result.newHistory).toHaveLength(0);

    // Bot.updateOne was called once (persistState)
    expect(Bot.__updateOne).toHaveBeenCalledTimes(1);
    const update = Bot.__updateOne.mock.calls[0][1].$set;
    // lastResults is the cleared array (size 0) — but cooldownUntil + size ARE updated
    expect(update.dynamicSizeLastResults).toHaveLength(0);
    expect(update.dynamicSizeCurrent).toBe(7);
    expect(update.dynamicLayersCurrent).toBe(3);
    expect(update.dynamicSizeCooldownUntil).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. Win-streak rule still works (regression for original)
  // ─────────────────────────────────────────────────────────────────────
  test('win-streak rule fires: WIN pnlPct > 2%, last 2 wins → size +2 USDT', async () => {
    mockBotFound(baseBot({
      dynamicSizeLastResults: [
        { closedAt: new Date(Date.now() - 60000), pnlPct: 2.5, isWin: true },
      ],
    }));

    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: baseBot(),
      pnl: 0.5,
      pnlPct: 2.7,
      source: 'trader:handleSellFilled',
    });

    expect(result.changed).toBe(true);
    expect(result.reason).toBe('2-wins-2pct');
    expect(result.before.size).toBe(9);
    expect(result.after.size).toBe(11); // 9 + 2
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. Always writes history even when no rule fires
  // ─────────────────────────────────────────────────────────────────────
  test('writes history even when no rule fires (no-rule path)', async () => {
    mockBotFound(baseBot());

    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: baseBot(),
      pnl: 0.1,
      pnlPct: 0.5,  // small win, no streak
      source: 'trader:handleSellFilled',
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe('no-rule');
    expect(result.newHistory).toHaveLength(1);
    expect(result.newHistory[0].isWin).toBe(true);

    // updateOne still called (history write)
    expect(Bot.__updateOne).toHaveBeenCalledTimes(1);
    const update = Bot.__updateOne.mock.calls[0][1].$set;
    expect(update.dynamicSizeLastResults).toHaveLength(1);
    // size NOT updated when changed=false
    expect(update.dynamicSizeCurrent).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. Sends telegram when size changes
  // ─────────────────────────────────────────────────────────────────────
  test('sends dpsResize telegram when size changes', async () => {
    mockBotFound(baseBot());

    await dpsAfterClose.evaluateDpsAfterClose({
      bot: baseBot(),
      pnl: -0.5,
      pnlPct: -3.0,
      source: 'forceClose:market:cbv3_panic',
    });

    expect(telegramNotifier.sendNow).toHaveBeenCalledWith('dpsResize', expect.objectContaining({
      reason: 'loss',
      beforeSize: 9,
      afterSize: 7,
      isWin: false,
      symbol: 'TESTUSDT',
      source: 'forceClose:market:cbv3_panic',
    }));
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5. Disabled bot → skipped
  // ─────────────────────────────────────────────────────────────────────
  test('disabled bot (dynamicSizeEnabled=false) → skipped, no DB write', async () => {
    mockBotFound(baseBot({ dynamicSizeEnabled: false }));

    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: baseBot(),
      pnl: -0.5,
      pnlPct: -3.0,
      source: 'forceClose:market',
    });

    expect(result.skipped).toBe('disabled');
    expect(result.changed).toBe(false);
    expect(Bot.__updateOne).not.toHaveBeenCalled();
    expect(telegramNotifier.sendNow).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 6. Master switch off → skipped
  // ─────────────────────────────────────────────────────────────────────
  test('masterDynamicSizeEnabled=false → skipped', async () => {
    mockBotFound(baseBot());
    masterConfig.getMasterToggles.mockResolvedValue({ masterDynamicSizeEnabled: false });

    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: baseBot(),
      pnl: -0.5,
      pnlPct: -3.0,
      source: 'forceClose:market',
    });

    expect(result.skipped).toBe('master-off');
    expect(Bot.__updateOne).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 7. DCA mode → skipped
  // ─────────────────────────────────────────────────────────────────────
  test('dcaEnabled=true → skipped (DCA mode is mutually exclusive)', async () => {
    mockBotFound(baseBot({ dcaEnabled: true }));

    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: baseBot(),
      pnl: -0.5,
      pnlPct: -3.0,
      source: 'forceClose:market',
    });

    expect(result.skipped).toBe('dca-mode');
    expect(Bot.__updateOne).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 8. Bot missing in DB → graceful return
  // ─────────────────────────────────────────────────────────────────────
  test('bot not found in DB → returns null, no throw', async () => {
    mockBotFound(null);

    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: baseBot(),
      pnl: -0.5,
      pnlPct: -3.0,
      source: 'forceClose:market',
    });

    expect(result).toBeNull();
    expect(Bot.__updateOne).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 9. Bot argument missing → returns null
  // ─────────────────────────────────────────────────────────────────────
  test('no bot → returns null', async () => {
    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: null,
      pnl: -0.5,
      pnlPct: -3.0,
      source: 'forceClose:market',
    });
    expect(result).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 10. No _id on bot → returns null
  // ─────────────────────────────────────────────────────────────────────
  test('bot without _id → returns null', async () => {
    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: { name: 'broken' },
      pnl: -0.5,
      pnlPct: -3.0,
      source: 'forceClose:market',
    });
    expect(result).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 11. throws upstream → swallowed (non-fatal)
  // ─────────────────────────────────────────────────────────────────────
  test('throws from evaluate() → caught, returns null, no propagation', async () => {
    mockBotError(new Error('DB connection lost'));

    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: baseBot(),
      pnl: -0.5,
      pnlPct: -3.0,
      source: 'forceClose:market',
    });

    expect(result).toBeNull();
    // Did not throw — caller can proceed safely
  });

  // ─────────────────────────────────────────────────────────────────────
  // 12. Cooldown gate: loss during cooldown → history written, size unchanged
  // ─────────────────────────────────────────────────────────────────────
  test('during cooldown → history written, size UNCHANGED', async () => {
    const futureCooldown = new Date(Date.now() + 5 * 60 * 1000);
    const botWithCooldown = baseBot({
      dynamicSizeCurrent: 11,
      dynamicLayersCurrent: 4,
      dynamicSizeCooldownUntil: futureCooldown,
    });
    mockBotFound(botWithCooldown);

    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: botWithCooldown,
      pnl: -0.5,
      pnlPct: -3.0,
      source: 'forceClose:market',
    });

    expect(result.skipped).toBe('cooldown');
    expect(result.changed).toBe(false);
    // history still updates
    expect(result.newHistory).toHaveLength(1);
    expect(result.newHistory[0].isWin).toBe(false);
    expect(Bot.__updateOne).toHaveBeenCalledTimes(1);
    const update = Bot.__updateOne.mock.calls[0][1].$set;
    expect(update.dynamicSizeLastResults).toHaveLength(1);
    expect(update.dynamicSizeCurrent).toBeUndefined(); // unchanged
  });

  // ─────────────────────────────────────────────────────────────────────
  // 13. resetHistoryOnFire: after win-streak fires, history cleared
  // ─────────────────────────────────────────────────────────────────────
  test('3-wins fires → history cleared (resetHistoryOnFire)', async () => {
    mockBotFound(baseBot({
      dynamicSizeLastResults: [
        { closedAt: new Date(Date.now() - 30000), pnlPct: 1.0, isWin: true },
        { closedAt: new Date(Date.now() - 60000), pnlPct: 1.0, isWin: true },
        { closedAt: new Date(Date.now() - 90000), pnlPct: 1.0, isWin: true },
      ],
    }));

    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: baseBot(),
      pnl: 0.5,
      pnlPct: 1.0,
      source: 'trader:handleSellFilled',
    });

    expect(result.changed).toBe(true);
    expect(result.reason).toBe('3-wins');
    // after fire, history cleared (the 4th win gets cleared because rule fired)
    expect(result.newHistory).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 14. Telegram failure → swallowed (non-fatal)
  // ─────────────────────────────────────────────────────────────────────
  test('telegram sendNow rejects → no throw, eval still returns result', async () => {
    telegramNotifier.sendNow.mockRejectedValue(new Error('telegram 5xx'));
    mockBotFound(baseBot());

    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: baseBot(),
      pnl: -0.5,
      pnlPct: -3.0,
      source: 'forceClose:market:cbv3_panic',
    });

    expect(result.changed).toBe(true);
    expect(result.reason).toBe('loss');
  });

  // ─────────────────────────────────────────────────────────────────────
  // 15. Bot is loaded from DB (not from passed-in reference)
  // ─────────────────────────────────────────────────────────────────────
  test('reloads bot from DB even if passed-in bot has stale state', async () => {
    // passed-in bot has dynSz=15 (outdated)
    // DB has dynSz=10 (current)
    const staleBot = baseBot({ dynamicSizeCurrent: 15 });
    const freshBot = baseBot({ dynamicSizeCurrent: 10 });
    mockBotFound(freshBot);

    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: staleBot,
      pnl: -0.5,
      pnlPct: -3.0,
      source: 'forceClose:market',
    });

    // crit: baseSize=10 (from DB), not 15 (passed-in)
    expect(result.before.size).toBe(10);
    expect(result.after.size).toBe(8); // 10 - 2
  });

  // ─────────────────────────────────────────────────────────────────────
  // 16. Multiple losses in history — only the most recent N match the rule
  // ─────────────────────────────────────────────────────────────────────
  test('loss streak: prior history has W,L,W → newest is L → still fires loss rule', async () => {
    mockBotFound(baseBot({
      dynamicSizeLastResults: [
        { closedAt: new Date(Date.now() - 180000), pnlPct: 2.0, isWin: true },
        { closedAt: new Date(Date.now() - 120000), pnlPct: -8.0, isWin: false },
        { closedAt: new Date(Date.now() - 60000), pnlPct: 1.5, isWin: true },
      ],
    }));

    const result = await dpsAfterClose.evaluateDpsAfterClose({
      bot: baseBot(),
      pnl: -0.5,
      pnlPct: -4.0,
      source: 'forceClose:market:sl_ukc_f1_armed',
    });

    expect(result.changed).toBe(true);
    expect(result.reason).toBe('loss');
    expect(result.after.size).toBe(7); // 9 - 2
  });
});
