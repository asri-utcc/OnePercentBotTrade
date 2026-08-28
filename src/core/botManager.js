'use strict';

const binanceRest = require('../binance/binanceRest');
const { marketWs, userDataWs } = require('../binance/binanceWs');
const symbolInfo = require('../binance/symbolInfo');
const klineCache = require('../services/klineCache');
const eventBus = require('../services/eventBus');
const licenseService = require('../services/licenseService'); // FIX-2026-08-28 B6: gate autoPauseMinKc feature
const logger = require('../utils/logger');
const Bot = require('../db/models/Bot');
const Trade = require('../db/models/Trade');
const Trader = require('./trader');
// FIX-2026-07-23: TP auto-updater (per-bot autoUpdateTp toggle → top-of-hour recompute)
const tpUpdater = require('./tpUpdater');
const indicators = require('./indicators'); // FIX-2026-08-01: keltnerChannel() for auto-pause Min-%KC scan
// FIX-2026-08-03: Safe-trade filter #2 (trendline) — live status module for bot card badge
//   - per-bot 60s cache + concurrency-6 batch scan (mirror volatilityForBot pattern)
//   - botManager.scheduleTrendlineStatusScan() populates _trendlineStatusCache for /api/bots
const trendlineForBot = require('./trendlineForBot');

// FIX-2026-07-14: periodic reconcile interval (ms) — safety net กัน WS event หลุด
//   FIX-2026-08-04: 2 นาที → 5 นาที (ลด Binance account API load) — reconcilePendingTrades เป็น defensive WS-miss sweep
//   ยังเร็วพอที่จะจับ SELL filled ที่หลุด และช้าพอที่จะลด Binance weight
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

// FIX-2026-08-01: auto-pause on low Min-%KC (default ON per bot)
//   - ทุก 5 นาที: scan Min-%KC(30 bars) — ถ้า < autoPauseMinKcPct → set enabled=false
//   - ถ้า ≥ threshold (และเคยถูก auto-pause) → auto-resume (vol_recovered)
//   - ตรวจเฉพาะบอทที่ autoPauseEnabled !== false (default true)
// FIX-2026-08-04: 5min → 10min (auto-pause check เป็น read-only volatility scan — ไม่กระทบ bot operations)
const AUTO_PAUSE_INTERVAL_MS = 10 * 60 * 1000;
let autoPauseTimer = null;
// FIX-2026-08-22: BUY-in-flight states — if a bot has any trade in these states,
//   auto-pause must NOT fire (pausing would orphan the BUY position because
//   trader.stop() removes the in-memory handler that places the SELL).
//   See [[onepercentbot-rvn-orphan-2026-08-22]] incident:
//     - 01:27:16 BUY 1344279972 placed (state='placed')
//     - 01:27:37 autoPauseLastActionAt → trader.stop() killed in-memory handler
//     - 01:30:46 BUY filled → state='filled' but no SELL placed → orphan 2108.4 RVN
//   `selling` is intentionally excluded (SELL is on the order book, pause is safe).
const AUTO_PAUSE_BUY_IN_FLIGHT_STATES = [
  'placed',
  'partial_wait',
  'filled',
  'retrying',
  'holding',
  'partial_sell_wait',
  'stopping',
];
// FIX-2026-08-06: delist scheduler — interval + forceCloseDays/blockBuyDays
const DELIST_SCHEDULE_INTERVAL_MS = 5 * 60 * 1000; // ทุก 5 นาที ตรวจ delist schedule
let delistSchedulerTimer = null;
let delistSchedulerInFlight = false;

// FIX-2026-08-24 (P1 audit): Auto-pause/resume hysteresis — กัน ping-pong ที่ boundary
//   - เดิม: KC/24hVol แกว่งใกล้ threshold → pause tick A → resume tick B (5 นาทีถัดไป) → pause tick C
//     - ผลข้างเคียง: telegram spam, bot status flip-flop, trader spawn/stop บ่อย → CPU + API load
//   - fix: track lastFlipMs per bot ใน in-memory Map → ถ้า flip ใหม่เกิดภายใน HYSTERESIS_MS → skip
//   - HYSTERESIS_MS = 30min: pause/resume เกิดได้ไม่เกิดชั่วโมงละ 2 ครั้งต่อบอท
//   - in-memory only — process restart = reset (acceptable; first tick may pause again if needed)
//   - exported as helper for testability
const AUTO_PAUSE_HYSTERESIS_MS = 30 * 60 * 1000; // 30 minutes
const _autoPauseFlipAt = new Map(); // botId (string) → Date.now() ms of last flip
function recordAutoPauseFlip(botId) {
  if (botId) _autoPauseFlipAt.set(String(botId), Date.now());
}
function shouldSkipFlipByHysteresis(botId) {
  const last = _autoPauseFlipAt.get(String(botId));
  if (!last) return false;
  return (Date.now() - last) < AUTO_PAUSE_HYSTERESIS_MS;
}

// FIX-2026-08-03: Safe-trade filter #2 (trendline) — live status scanner
//   - every 60s (matches trendlineForBot CACHE_TTL_MS) for bots with safeTradeTrendlineEnabled=true
//   - populates module-level _trendlineStatusCache Map for /api/bots response
// FIX-2026-08-04: decouple scan interval from cache TTL — scan every 120s (ลด Binance kline API load)
//   - cache TTL 60s ยังคงเดิม (trendlineForBot.CACHE_TTL_MS) — แค่ scan tick ห่างขึ้น
// FIX-2026-08-04 v2: 120s → 600s (10 min) + filter enabled: true only (ลด Binance load อีก 5 เท่า)
//   - trader.js path (BUY-time check) เป็น on-demand — ไม่กระทบ BUY
//   - DISABLED bots: cache freeze ที่ค่าล่าสุด (แสดง stale data บน bot card pill)
//   - Mitigated: invalidateTrendlineCache ใน enableBot() — clear cache on re-enable → next scan fresh
//   - **read-only** — never blocks BUY; trader.js path is the only place that blocks
const TRENDLINE_SCAN_INTERVAL_MS = 10 * 60 * 1000;
let trendlineScanTimer = null;
// FIX-2026-08-03: in-memory cache: botId → {status, trendTF, lastClose, trendlineValue, gapPct, pivotCount, updatedAt}
//   - keyed by botId string; refreshed every TRENDLINE_SCAN_INTERVAL_MS
//   - cleared on bot delete; invalidated when timeframe changes (see botUpdate handler)
const _trendlineStatusCache = new Map();

// FIX-2026-08-22 (weight spike fix): stagger bot spawns on PM2 restart
//   - เดิม: start() วน for-loop โหลดบอท enabled=true ทั้งหมดแล้ว spawnTrader ทีละตัวติดกัน
//   - แต่ละ spawnTrader ทำ exchangeInfo(20) + seedKlines(5-10) + marketWs.subscribeMarket(~klines WS warm-up)
//   - กับ ~50 บอท: ~30 weight ต่อบอท × 50 = ~1500 weight ใน 5-15 วินาทีแรก
//   - รวมกับ subsystem periodic timers (healthMonitor/autoBnbBuyer/delistMonitor/walletSnapshot)
//     → IP weight > 6000/min → 418 ban → PM2 restart loop → ตาย
//   - fix: SPAWN_STAGGER_MS delay ระหว่างบอท กระจาย API calls ให้เฉลี่ย ~70/วินาที (ใต้ refill 100/s)
//   - 50 บอท × 300ms = 15s spread; พอเยียวยาโดยไม่ทำให้ startup ช้าเกินไป
const SPAWN_STAGGER_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bot Manager — spawn/stop Trader ต่อ bot, จัดการ WS subscriptions
 * + seed klineCache ด้วย historical data ตอนเริ่ม
 */
class BotManager {
  constructor() {
    this.traders = new Map(); // botId -> Trader
    this.running = false;
    // FIX-2026-07-14: periodic reconciliation timer (safety net for missed WS updates)
    //   reconcilePendingTrades() เดิมรันแค่ครั้งเดียวตอน startup — ถ้า WS event หลุดระหว่าง runtime
    //   (listenkey expired, network blip, race กับ idempotent guard) จะมี position ที่ SELL fill แล้วบน Binance
    //   แต่ trade.state ยัง stuck ที่ 'selling' ใน DB → ระบบค้าง
    //   fix: ยิง reconcilePendingTrades() ทุก RECONCILE_INTERVAL_MS (default 2 นาที)
    this.reconcileTimer = null;
    this.reconcileInFlight = false; // guard กัน overlap ถ้า reconcile รอบก่อนยังไม่จบ

    // FIX-2026-08-24 (P0 audit): per-bot spawn mutex ป้องกัน duplicate trader instance
    //   - เดิม enableBot + auto-resume + start() (PM2 boot) ไม่มี mutex รอบ spawnTrader
    //   - ถ้า user toggle + auto-pause tick + PM2 restart พร้อมกัน → 2 spawnTrader calls
    //     → 2 trader instances / 1 bot → double WS subscribe + double reconcileKlines
    //     → silent leak (instance เก่าไม่ถูก unsub) หรือ orphan (overwrite + leak เก่า)
    //   - fix: per-bot promise chain — caller await chain เดียวกัน → serialized
    //   - pattern: Map<botId, Promise>; lock ก่อน spawn, delete หลังเสร็จ (finally)
    this._spawningLocks = new Map(); // Map<string, Promise<void>>
  }

  async start() {
    if (this.running) return;
    this.running = true;
    logger.info('botManager start');

    // FIX-2026-08-22 (weight spike): subsystem timer jitter — de-align periodic ticks
    //   - เดิม 4 setInterval เริ่ม t=0 → ทุก tick จะ aligned burst เมื่อถึงเวลา (5min, 2min, 60s)
    //   - ±10% jitter: 5min→4.5-5.5min, 60s→54-66s, 2min→1.8-2.2min → ticks กระจายตัว
    const _jitter = (base, pct = 0.1) => Math.round(base * (1 + (Math.random() * 2 - 1) * pct));

    // Start market WS
    marketWs.start();

    // Start user data stream (ถ้ามี keys)
    await userDataWs.start();

    // Load all enabled bots
    const bots = await Bot.find({ enabled: true });
    logger.info({ count: bots.length, staggerMs: SPAWN_STAGGER_MS }, 'botManager: spawning traders (staggered)');
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      try {
        // FIX 2026-08-06 (BANK incident): reset stale cursor on PM2 restart too
        //   - enableBot() + auto-resume มี guard นี้แล้ว แต่ start() (โหลดบอทตอน process boot) ไม่มี
        //   - ถ้า lastSignalCloseTime เก่า > 30 นาที (เช่น PM2 ถูก restart ตอนบอท enabled) reconcileKlines('startup')
        //     จะ replay historical candles หลายร้อยแท่ง → S1 detector ยิง ghost BUY บน candles เก่า
        //   - safe: cursor advances monotonically ($max guard ใน trader reconcileKlines กันย้อนหลังอยู่แล้ว)
        await this._resetStaleReplayCursorOnEnable(bot);
        await this._withSpawnLock(bot._id, () => this.spawnTrader(bot));
      } catch (err) {
        logger.error({ err: err.message, botId: bot._id.toString() }, 'botManager: spawn failed');
      }
      // FIX-2026-08-22 (weight spike): stagger between spawns ลด burst บน Binance
      //   - sleep หลังทุกบอท ยกเว้นตัวสุดท้าย (ไม่ต้องรอหลังงานจบ)
      //   - skip on first bot too (delay applies AFTER spawn, so first bot runs immediately)
      if (i < bots.length - 1) {
        await sleep(SPAWN_STAGGER_MS);
      }
    }

    // Reconciliation: เช็ค Trade ที่ค้างจาก crash ก่อนหน้า
    await this.reconcilePendingTrades();

    // ซ่อม Bot totals (totalPnl/totalTrades/winTrades) ให้ตรงกับ Trade collection
    // (กัน drift จาก read-modify-write race ที่เคยทำให้ totalTrades ตกหล่น)
    await this.recomputeBotStats();

    // FIX-2026-07-14: schedule periodic reconcile (safety net)
    //   - ห่าง RECONCILE_INTERVAL_MS (default 2 นาที) — กัน WS event หลุดระหว่าง runtime
    //   - clearInterval ตอน stop()
    //   - guard reconcileInFlight กัน overlap กรณี reconcile นาน (เช่น reconcile 50 trades)
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    const reconcileIntervalMs = _jitter(RECONCILE_INTERVAL_MS);
    this.reconcileTimer = setInterval(() => {
      if (!this.running || this.reconcileInFlight) return;
      this.reconcileInFlight = true;
      this.reconcilePendingTrades()
        .catch((err) => logger.error({ err: err.message }, 'botManager: periodic reconcile failed'))
        .finally(() => { this.reconcileInFlight = false; });
    }, reconcileIntervalMs);
    logger.info({ intervalMs: reconcileIntervalMs, baseMs: RECONCILE_INTERVAL_MS }, 'botManager: periodic reconcile scheduled');

    // FIX-2026-07-23: schedule TP auto-updater (recompute TP% top-of-hour สำหรับบอทที่ autoUpdateTp=true)
    tpUpdater.scheduleHourlyTpUpdate();

    // FIX-2026-08-01: auto-pause scanner (ทุก 5 นาที: pause/resume ตาม Min-%KC 30 bars)
    // FIX-2026-08-06 (BANK incident): bind this → BotManager instance
    //   - checkAutoPauseBots เป็น standalone function (declared outside class) ที่ใช้ this.traders / this._resetStaleReplayCursorOnEnable / this.spawnTrader
    //   - ถ้าเรียกเป็น free function `this` = undefined (strict mode) → auto-resume crash ทุกครั้งที่ cursor > 30 min
    const autoPauseIntervalMs = _jitter(AUTO_PAUSE_INTERVAL_MS);
    autoPauseTimer = setInterval(() => {
      checkAutoPauseBots.call(this).catch((err) => logger.warn({ err: err.message }, 'botManager: auto-pause tick failed'));
    }, autoPauseIntervalMs);
    if (autoPauseTimer && typeof autoPauseTimer.unref === 'function') autoPauseTimer.unref();
    logger.info({ intervalMs: autoPauseIntervalMs, baseMs: AUTO_PAUSE_INTERVAL_MS }, 'botManager: auto-pause scanner scheduled');

    // FIX-2026-08-03: Safe-trade #2 (trendline) live status scanner
    //   - ทุก 60s scan บอทที่ safeTradeTrendlineEnabled=true → populate _trendlineStatusCache
    //   - UI bot card badge reads from this cache via /api/bots response (sl fields)
    //   - immediate first scan (non-blocking) so badge shows on page load
    const trendlineIntervalMs = _jitter(TRENDLINE_SCAN_INTERVAL_MS);
    trendlineScanTimer = setInterval(() => {
      checkTrendlineStatusBots().catch((err) => logger.warn({ err: err.message }, 'botManager: trendline status tick failed'));
    }, trendlineIntervalMs);
    if (trendlineScanTimer && typeof trendlineScanTimer.unref === 'function') trendlineScanTimer.unref();
    setImmediate(() => {
      checkTrendlineStatusBots().catch((err) => logger.warn({ err: err.message }, 'botManager: trendline status initial scan failed'));
    });
    logger.info({ intervalMs: trendlineIntervalMs, baseMs: TRENDLINE_SCAN_INTERVAL_MS }, 'botManager: trendline status scanner scheduled');

    // FIX-2026-08-06: delist scheduler — auto-pause + force-close บอทที่อยู่ใน delist schedule
    //   - tick ทุก 5 นาที: scan delistMonitor.getScheduledSymbols() → บอทที่ trade symbol นั้น:
    //     * force-close position ถ้า daysUntil <= 3
    //     * auto-pause (set enabled=false) ถ้า daysUntil <= 7
    //   - botManager scheduler handles BOTH enabled และ disabled bots (force-close ต้องทำแม้บอทปิด)
    //   - emit telegram event (delistMonitor:scheduled ที่ telegramNotifier bind แล้ว)
    const delistIntervalMs = _jitter(DELIST_SCHEDULE_INTERVAL_MS);
    delistSchedulerTimer = setInterval(() => {
      checkDelistScheduleBots.call(this).catch((err) => logger.warn({ err: err.message }, 'botManager: delist scheduler tick failed'));
    }, delistIntervalMs);
    if (delistSchedulerTimer && typeof delistSchedulerTimer.unref === 'function') delistSchedulerTimer.unref();
    logger.info({ intervalMs: delistIntervalMs, baseMs: DELIST_SCHEDULE_INTERVAL_MS }, 'botManager: delist scheduler scheduled');

    // FIX-2026-07-24: start Telegram notifier (subscribe eventBus + periodic PnL scan)
    // FIX-2026-08-27 Phase 3a C2: gate by License.features.telegram (premium feature toggle).
    //   - If license missing or features.telegram === false → skip start (no token decrypt attempt,
    //     no event subscriptions, no periodic scans — bot still trades, just no TG notifications).
    //   - Settings page shows current feature state; admin can flip it on/off per license.
    const licenseService = require('../services/licenseService');
    if (licenseService.isFeatureEnabled('telegram')) {
      const telegramNotifier = require('../services/telegramNotifier');
      telegramNotifier.start().catch((e) => logger.warn({ err: e.message }, 'telegramNotifier start failed'));
    } else {
      logger.info('botManager: telegramNotifier skipped (License.features.telegram === false or no license)');
    }

    // FIX-2026-07-14: sync Binance server time on startup (กัน -1021 timestamp drift)
    binanceRest.refreshServerTimeOffset()
      .then((offsetMs) => logger.info({ offsetMs }, 'botManager: initial Binance time-sync done'))
      .catch((err) => logger.warn({ err: err.message }, 'botManager: initial Binance time-sync failed'));
  }

  async stop() {
    this.running = false;
    // FIX-2026-07-14: clear periodic reconcile timer ด้วย
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    // FIX-2026-07-23: หยุด TP auto-updater timer
    tpUpdater.stopHourlyTpUpdate();
    // FIX-2026-08-01: หยุด auto-pause scanner timer
    if (autoPauseTimer) { clearInterval(autoPauseTimer); autoPauseTimer = null; }
    // FIX-2026-08-03: หยุด trendline status scanner timer + clear cache
    if (trendlineScanTimer) { clearInterval(trendlineScanTimer); trendlineScanTimer = null; }
    _trendlineStatusCache.clear();
    // FIX-2026-08-06: หยุด delist scheduler
    if (delistSchedulerTimer) { clearInterval(delistSchedulerTimer); delistSchedulerTimer = null; }
    // FIX-2026-07-24: หยุด Telegram notifier (clear listeners + timers)
    try { require('../services/telegramNotifier').stop(); } catch (e) { /* ignore */ }
    for (const [id, trader] of this.traders.entries()) {
      try { await trader.stop(); } catch (e) { /* ignore */ }
    }
    this.traders.clear();
    marketWs.stop();
    await userDataWs.stop();
    logger.info('botManager stopped');
  }

  async spawnTrader(bot, opts = {}) {
    // FIX-2026-08-22 (zombie): refuse to spawn a trader for a soft-deleted bot
    //   - ป้องกัน checkAutoPauseBots RESUME branch (หรือ caller อื่น) จากการเปิด trader
    //     บนบอทที่ user ลบไปแล้ว → trader จะ place BUY ต่อจนกว่า process จะถูก kill
    //   - kaito/gps incident: RESUME branch เคยเรียก spawnTrader บน soft-deleted bot
    //     (เพราะ loader ไม่กรอง deletedAt + RESUME ไม่เช็ค) — fix ทั้ง 3 จุด
    if (bot && bot.deletedAt) {
      logger.warn({
        botId: bot._id && bot._id.toString(),
        symbol: bot.symbol,
        deletedAt: bot.deletedAt,
      }, 'botManager: spawnTrader refused — bot is soft-deleted');
      return;
    }
    if (this.traders.has(bot._id.toString())) {
      logger.warn({ botId: bot._id.toString() }, 'trader already running');
      return;
    }

    // Load symbol info
    try {
      await symbolInfo.loadSymbol(bot.symbol);
    } catch (err) {
      logger.warn({ botId: bot._id.toString(), err: err.message }, 'symbol info load failed');
    }

    // Seed klineCache
    await this.seedKlines(bot);

    // Subscribe WS
    marketWs.subscribeMarket(bot.symbol, bot.timeframe);

    // Start trader
    const trader = new Trader(bot);
    trader.start();
    this.traders.set(bot._id.toString(), trader);

    logger.info({ botId: bot._id.toString(), symbol: bot.symbol, tf: bot.timeframe }, 'trader spawned');

    // FIX-2026-08-22 (auto-resume replay-1): replay the last closed candle to catch missed S1 signals
    //   - caller (auto-resume only) passes opts.pendingReplayCandle from _resetStaleReplayCursorOnEnable
    //   - schedule via setImmediate so it runs AFTER start() event handler registration
    //   - skip on soft-deleted bot (defense-in-depth; gate above already filters)
    //   - ถ้า candle มี S1 → placeBuy fires (intended); ถ้าไม่ใช่ → cursor advances, no harm
    if (opts.pendingReplayCandle && !bot.deletedAt) {
      const candleForReplay = opts.pendingReplayCandle;
      setImmediate(async () => {
        try {
          await trader.onCandleClosed(candleForReplay, { replay: true, trigger: 'resume-replay-1' });
          logger.info({
            botId: bot._id.toString(),
            symbol: bot.symbol,
            candleCloseTime: candleForReplay.closeTime,
            close: candleForReplay.close,
          }, 'botManager: replayed last closed candle on resume');
        } catch (err) {
          logger.warn({
            botId: bot._id.toString(),
            err: err.message,
            stack: err.stack,
          }, 'botManager: resume-replay-1 candle failed');
        }
      });
    }
  }

  /**
   * FIX-2026-08-24 (P0 audit): per-bot spawn mutex
   *   - ห่อ spawnTrader() เพื่อ serialize concurrent spawn calls (enableBot + auto-resume + PM2 boot)
   *   - pattern: Map<botId, Promise> — caller await chain เดียวกัน
   *   - usage: `await this._withSpawnLock(bot._id, () => this.spawnTrader(bot))`
   */
  async _withSpawnLock(botId, fn) {
    const id = botId.toString();
    const prev = this._spawningLocks.get(id) || Promise.resolve();
    const next = prev.then(() => fn(), () => fn()); // run even if previous failed
    // store a no-throw tail so the chain doesn't break if fn rejects
    this._spawningLocks.set(id, next.catch(() => {}));
    try {
      await next;
    } finally {
      // only delete if we're still the tail of the chain
      if (this._spawningLocks.get(id) && this._spawningLocks.get(id) === next.catch(() => {})) {
        this._spawningLocks.delete(id);
      }
    }
  }

  async stopTrader(botId) {
    const id = botId.toString();
    const trader = this.traders.get(id);
    if (!trader) return;
    await trader.stop();
    this.traders.delete(id);

    // หา symbol/tf ของ bot นี้
    const bot = await Bot.findById(botId).catch(() => null);
    if (bot) {
      // ดูว่ายังมี bot อื่นที่ใช้ symbol/tf นี้อยู่ไหม
      const otherBot = await Bot.findOne({
        _id: { $ne: botId },
        symbol: bot.symbol,
        timeframe: bot.timeframe,
        enabled: true,
      });
      if (!otherBot) {
        marketWs.unsubscribeMarket(bot.symbol, bot.timeframe);
      }
    }
    logger.info({ botId: id }, 'trader stopped');
  }

  async seedKlines(bot) {
    if (klineCache.size(bot.symbol, bot.timeframe) >= 100) return; // มีข้อมูลพอแล้ว

    try {
      const klines = await binanceRest.getKlines({
        symbol: bot.symbol,
        interval: bot.timeframe,
        limit: 200,
      });

      const candles = klines.map((k) => {
        const [openTime, open, high, low, close, volume, closeTime] = k;
        return {
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          openTime,
          open: parseFloat(open),
          high: parseFloat(high),
          low: parseFloat(low),
          close: parseFloat(close),
          volume: parseFloat(volume),
          closeTime,
          isClosed: true,
        };
      });
      klineCache.seed(candles);
      logger.info({ symbol: bot.symbol, tf: bot.timeframe, count: candles.length }, 'klines seeded');
    } catch (err) {
      logger.error({ err: err.message }, 'klines seed failed');
    }
  }

  /**
   * Reconcile pending trades จาก crash ก่อนหน้า
   * FIX 5: ตอนนี้จับ orphan ได้ทุก state (placed/filled/holding/cancelled/selling)
   * - BUY filled แต่ trade state ไม่ใช่ selling → handleBuyFilled
   * - BUY placed แต่ state stuck (cancelled/holding) + order FILLED → handleBuyFilled
   * - SELL placed + state=selling + order FILLED → handleSellFilled
   */
  async reconcilePendingTrades() {
    const pending = await Trade.find({
      state: { $in: ['placed', 'filled', 'holding', 'cancelled', 'selling'] },
    });

    // FIX-2026-08-24 (P1 audit): bulk-load bots + signals to replace per-trade N+1 queries
    //   - เดิม: 100 pending trades × Bot.findById = 100 sequential round-trips × 1-2ms = 100-200ms blocking
    //   - fix: pre-pass collect unique botIds + signalIds → single $in query each → maps
    //   - scale: 500 bots × pending trades → was 500 round-trips, now 2 queries
    const Signal = require('../db/models/Signal');
    const uniqueBotIds = [...new Set(pending.map((t) => String(t.botId)).filter(Boolean))];
    const uniqueSignalIds = [...new Set(pending.map((t) => t.signalId).filter(Boolean).map(String))];
    const [botsArr, signalsArr] = await Promise.all([
      uniqueBotIds.length > 0 ? Bot.find({ _id: { $in: uniqueBotIds } }).lean() : Promise.resolve([]),
      uniqueSignalIds.length > 0 ? Signal.find({ _id: { $in: uniqueSignalIds } }).lean() : Promise.resolve([]),
    ]);
    const botMap = new Map(botsArr.map((b) => [String(b._id), b]));
    const signalMap = new Map(signalsArr.map((s) => [String(s._id), s]));

    for (const trade of pending) {
      try {
        const bot = botMap.get(String(trade.botId));
        if (!bot) continue;

        // ตรวจ BUY order (กรณี state=placed หรือ cancelled ที่ BUY อาจ fill จริง)
        if (trade.buyOrderId) {
          const order = await binanceRest.getOrder({
            symbol: trade.symbol,
            orderId: trade.buyOrderId,
          }).catch(() => null);
          if (order) {
            // BUY filled จริง — ไม่ว่า trade.state จะเป็นอะไร ต้อง proceed SELL
            // FIX-2026-07-31 (BUG-22): don't call handleBuyFilled for PARTIALLY_FILLED — the BUY
            //   is still open and filling more. Calling handleBuyFilled would place a SELL for
            //   current executedQty while the remainder of the BUY keeps filling → over-exposure.
            //   Let the trader manage PARTIALLY_FILLED via its own schedulePartialFillWatch.
            if (order.status === 'FILLED') {
              // skip ถ้า trade เป็น selling/sold อยู่แล้ว (normal path)
              if (['selling', 'sold'].includes(trade.state)) {
                logger.debug({ tradeId: trade._id.toString(), dbState: trade.state }, 'reconcile: BUY filled, trade already in selling/sold — skip');
              } else {
                logger.warn({
                  tradeId: trade._id.toString(),
                  dbState: trade.state,
                  orderStatus: order.status,
                  botId: trade.botId.toString(),
                }, 'reconcile: ORPHAN detected — BUY filled but DB state stuck');

                const sig = trade.signalId ? (signalMap.get(String(trade.signalId)) || null) : null;
                const trader = this.traders.get(bot._id.toString());
                if (trader) {
                  trader.currentTrade = trade;
                  await trader.handleBuyFilled(trade, order, sig);
                } else {
                  // ไม่มี trader (บอท disabled) → mark filled + ปล่อยให้ user/manual reconcile
                  logger.warn({
                    tradeId: trade._id.toString(),
                    botId: trade.botId.toString(),
                  }, 'reconcile: BUY filled but no live trader — DB updated to filled, manual SELL needed');
                  await Trade.updateOne(
                    { _id: trade._id },
                    {
                      state: 'filled',
                      buyStatus: order.status,
                      buyFilledAt: new Date(order.updateTime || Date.now()),
                      buyPrice: parseFloat(order.price) || parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty),
                      buyQty: parseFloat(order.executedQty),
                      buyQuoteQty: parseFloat(order.cummulativeQuoteQty),
                    }
                  );
                  // FIX-2026-08-14: ส่ง Telegram alert เพื่อให้ user รู้ทันที — ก่อนหน้านี้ silent
                  //   log เฉยๆ ทำให้ orphan ค้างเป็นเดือน (เช่น EPIC 2026-08-14 ค้าง 4 ชม.)
                  //   - latch: ส่ง telegram เฉพาะเมื่อ `trade.updatedAt` เก่ากว่า 1 ชั่วโมง
                  //     (คือ "ยังไม่ได้ alert ใน reconcile cycle นี้") — กัน spam ทุก 5 นาที
                  //   - reconcile cycle ถัดไปจะ re-update trade.updatedAt → latch ใหม่อีก 1 ชม.
                  const updatedAtMs = trade.updatedAt ? new Date(trade.updatedAt).getTime() : 0;
                  const staleMs = Date.now() - updatedAtMs;
                  const shouldAlert = staleMs > 60 * 60 * 1000; // > 1 hour since last update
                  if (shouldAlert) {
                    try {
                      const telegramNotifier = require('../services/telegramNotifier');
                      telegramNotifier.sendNow && telegramNotifier.sendNow('orphanBuyFilled', {
                        botName: bot.name || bot.symbol,
                        symbol: trade.symbol,
                        tradeId: trade._id.toString(),
                        buyOrderId: trade.buyOrderId,
                        buyPrice: parseFloat(order.price) || parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty),
                        buyQty: parseFloat(order.executedQty),
                        buyFilledAt: new Date(order.updateTime || Date.now()).toISOString(),
                        botEnabled: bot.enabled,
                        botStatus: bot.status,
                        autoPauseReason: bot.autoPauseReason || '',
                        ts: Date.now(),
                      });
                    } catch (tgErr) {
                      logger.warn({ err: tgErr.message }, 'reconcile: telegram alert (orphanBuyFilled) failed (non-fatal)');
                    }
                  }
                  logger.error({
                    tradeId: trade._id.toString(),
                    botId: trade.botId.toString(),
                    botName: bot.name,
                    symbol: trade.symbol,
                    buyOrderId: trade.buyOrderId,
                    buyQty: parseFloat(order.executedQty),
                    buyFilledAt: new Date(order.updateTime || Date.now()).toISOString(),
                    botEnabled: bot.enabled,
                    autoPauseReason: bot.autoPauseReason || '',
                    telegramAlerted: shouldAlert,
                    staleMsSinceLastUpdate: staleMs,
                  }, 'reconcile: 🚨 ORPHAN BUY filled on DISABLED bot — user must re-enable bot OR run force-close manually');
                }
              }
            } else if (order.status === 'PARTIALLY_FILLED') {
              // FIX-2026-07-31 (BUG-22): partial BUY in-progress — let trader manage via
              //   schedulePartialFillWatch. Don't call handleBuyFilled (would over-expose).
              logger.debug({
                tradeId: trade._id.toString(),
                dbState: trade.state,
                executedQty: order.executedQty,
              }, 'reconcile: BUY partially filled in-progress, skip — trader manages');
            } else if ((order.status === 'CANCELED' || order.status === 'EXPIRED') && trade.state === 'placed') {
              // BUY ถูก cancel จริง — sync DB
              logger.info({ tradeId: trade._id.toString() }, 'reconcile: BUY cancelled/expired, marking DB');
              await Trade.updateOne({ _id: trade._id }, { state: 'cancelled', buyStatus: order.status });
            } else if (order.status === 'NEW' && trade.state === 'placed') {
              // FIX: BUY ค้างที่ state=placed นานเกิน retry budget → cancel + sync DB
              // (กันเคสที่ bot restart ระหว่างรอ retry → in-memory retry state หาย
              //  → BUY order ค้างบน Binance แบบไม่มีใครดูแล)
              // เกณฑ์: retryTimeMin × (retryMax + 1) นาที — ตามสเปคที่ user กำหนด
              //         "wait 1 min, retry 1 min, if still no fill → cancel ไม่เทรดรอบนั้น"
              const retryBudgetMs = (bot.retryTimeMin || 1) * 60 * 1000 * ((bot.retryMax || 1) + 1);
              const placedAt = trade.buyPlacedAt ? new Date(trade.buyPlacedAt).getTime() : 0;
              const ageMs = placedAt ? Date.now() - placedAt : Infinity;
              if (ageMs > retryBudgetMs) {
                logger.warn({
                  tradeId: trade._id.toString(),
                  orderId: trade.buyOrderId,
                  ageMs,
                  retryBudgetMs,
                  botId: trade.botId.toString(),
                }, 'reconcile: stuck BUY beyond retry budget — cancelling');
                let cancelResp;
                try {
                  cancelResp = await binanceRest.cancelOrder({
                    symbol: trade.symbol,
                    orderId: trade.buyOrderId,
                  });
                } catch (err) {
                  const ferr = binanceRest.formatBinanceError(err);
                  if (ferr && ferr.code === -2011) {
                    // already gone — sync DB ตามสถานะจริง (NEW/CANCELED) แล้วปล่อยผ่าน
                    logger.info({ tradeId: trade._id.toString() }, 'reconcile: stuck BUY already gone (-2011), marking cancelled');
                    await Trade.updateOne({ _id: trade._id }, { state: 'cancelled', buyStatus: 'CANCELED' });
                    // FIX: เคลียร์ bot.status + trader.currentTrade ด้วยเหมือนกรณี cancel สำเร็จ
                    await Bot.updateOne(
                      { _id: trade.botId, status: { $in: ['waiting_fill', 'holding', 'selling', 'error'] } },
                      { $set: { status: 'idle', lastError: null } }
                    );
                    const traderAfter = this.traders.get(bot._id.toString());
                    if (traderAfter && traderAfter.currentTrade && traderAfter.currentTrade._id.toString() === trade._id.toString()) {
                      traderAfter._unregisterTrade(trade);
                      traderAfter.currentTrade = null;
                      eventBus.emit('bot:status', { botId: bot._id, status: 'idle' });
                      logger.info({ botId: bot._id.toString(), tradeId: trade._id.toString() }, 'reconcile: cleared trader.currentTrade after stuck BUY already gone (-2011)');
                    }
                  } else {
                    logger.error({
                      tradeId: trade._id.toString(),
                      code: ferr && ferr.code,
                      msg: ferr && ferr.msg,
                    }, 'reconcile: stuck BUY cancel failed — will retry next reconcile cycle');
                  }
                  // ไม่ mark DB ทิ้ง — ให้ reconcile รอบหน้าลองใหม่
                  // FIX-2026-07-31 (BUG-21): `return` aborted the entire reconcile pass for ALL
                  //   remaining trades — should be `continue` so we move on to next trade.
                  continue;
                }
                logger.info({
                  tradeId: trade._id.toString(),
                  orderId: trade.buyOrderId,
                  status: cancelResp.status,
                }, 'reconcile: stuck BUY cancelled — marking DB cancelled');
                await Trade.updateOne({
                  _id: trade._id,
                }, {
                  state: 'cancelled',
                  buyStatus: cancelResp.status || 'CANCELED',
                });
                // FIX: รีเซ็ต bot.status กลับเป็น idle + clear currentTrade ของ trader (ถ้ามี)
                // (ถ้าไม่เคลียร์ บอทจะติด 'waiting_fill' และ skip signal ใหม่ทุกตัว — เคสนี้เคยเกิด 21:09 / 21:21)
                await Bot.updateOne(
                  { _id: trade.botId, status: { $in: ['waiting_fill', 'holding', 'selling', 'error'] } },
                  { $set: { status: 'idle', lastError: null } }
                );
                const traderAfter = this.traders.get(bot._id.toString());
                if (traderAfter && traderAfter.currentTrade && traderAfter.currentTrade._id.toString() === trade._id.toString()) {
                  traderAfter._unregisterTrade(trade);
                  traderAfter.currentTrade = null;
                  eventBus.emit('bot:status', { botId: bot._id, status: 'idle' });
                  logger.info({ botId: bot._id.toString(), tradeId: trade._id.toString() }, 'reconcile: cleared trader.currentTrade after stuck BUY cancel');
                }
              }
            }
          }
        }

        // ตรวจ SELL order (กรณี state=selling หรือ holding ที่ SELL อาจ fill จริง)
        if (trade.sellOrderId) {
          const order = await binanceRest.getOrder({
            symbol: trade.symbol,
            orderId: trade.sellOrderId,
          }).catch(() => null);
          if (order) {
            if (order.status === 'FILLED' && trade.state !== 'sold') {
              logger.warn({
                tradeId: trade._id.toString(),
                dbState: trade.state,
                botId: trade.botId.toString(),
              }, 'reconcile: ORPHAN — SELL filled but DB state not sold');
              const trader = this.traders.get(bot._id.toString());

              // FIX-2026-08-06 (BUG-BICO): inline mark-sold is the SAFE FALLBACK — does NOT
              //   depend on trader state, handleSellFilled guard set, or any race-condition.
              //   - pattern: partial-fill BUY → leftover unfilled portion auto-CANCELED → trade
              //     auto-marked 'cancelled' by reconcile sweep → SELL for the filled portion
              //     already placed (state was 'selling' at that moment) → SELL fills on Binance
              //     → handleSellFilled bails because trade.state='cancelled' is not in guard set
              //   - เคยเกิด 15+ orphan detects every 5min จนกว่าจะแก้
              //   - inline path ใช้ Trade.updateOne ไม่มี state guard → force write 'sold'
              //     + atomic state-sellOrderId check for idempotency
              const inlineSellPrice = parseFloat(order.price || order.avgPrice) || (parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty));
              const inlineSellQty = parseFloat(order.executedQty);
              const inlineFeeRate = require('../binance/fees').getMakerRate();
              const inlinePnl = require('../binance/fees').calcPnl({
                buyPrice: trade.buyPrice,
                sellPrice: inlineSellPrice,
                qty: inlineSellQty,
                feeRate: inlineFeeRate,
              });

              let inlineMark = false;

              // Helper: inline mark-sold (idempotent, atomic sellOrderId check)
              const doInlineMarkSold = async () => {
                const updRes = await Trade.updateOne(
                  {
                    _id: trade._id,
                    sellOrderId: order.orderId,
                    state: { $nin: ['sold'] }, // already sold → skip
                  },
                  {
                    state: 'sold',
                    sellStatus: 'FILLED',
                    sellPrice: inlineSellPrice,
                    sellQty: inlineSellQty,
                    sellQuoteQty: parseFloat(order.cummulativeQuoteQty),
                    sellFilledAt: new Date(order.updateTime || Date.now()),
                    realizedPnl: inlinePnl.net,
                    pnlPercent: inlinePnl.pnlPercent,
                    // FIX-2026-07-31 (F1): reset SL-on-UKC auto-arm flag
                    useStopLossOnUKC: false,
                    autoArmedAt: null,
                    autoArmLossPct: null,
                    autoArmAgeHours: null,
                    // FIX-2026-08-01: reset SELL partial-fill latch
                    sellPartialDetectedAt: null,
                    sellPartialLatchedAt: null,
                    sellPartialLatchedReason: null,
                    // FIX-2026-08-01: structured sellReason for orphan recovery
                    sellReason: 'manual_api_market', // closest enum for "force close via reconcile"
                    sellReasonDetail: `orphan reconcile: SELL ${order.orderId} filled but DB state='${trade.state}' — inline mark-sold`,
                    sellReasonAt: new Date(),
                    sellReasonSource: 'botManager.reconcilePendingTrades',
                  }
                );
                return updRes.modifiedCount === 1;
              };

              if (trader) {
                trader.currentTrade = trade;
                await trader.handleSellFilled({
                  orderId: order.orderId, // FIX-2026-08-06: pass orderId so cancelled-state guard can match
                  executedQty: order.executedQty,
                  avgPrice: order.price || order.avgPrice,
                  cumulativeQuoteQty: order.cummulativeQuoteQty,
                  ts: order.updateTime,
                }, trade);

                // FIX-2026-08-06 (BUG-BICO): defense-in-depth — if trader path didn't update
                //   (modifiedCount=0 because state='cancelled' wasn't in guard set, OR trade
                //   re-fetched state='sold' by another path), try inline mark-sold with idempotent guard
                const freshAfter = await Trade.findById(trade._id, 'state').lean();
                if (freshAfter && freshAfter.state !== 'sold') {
                  inlineMark = await doInlineMarkSold();
                  if (inlineMark) {
                    logger.warn({
                      tradeId: trade._id.toString(),
                      orderId: order.orderId,
                      dbState: freshAfter.state,
                      botId: trade.botId.toString(),
                    }, 'reconcile: ORPHAN — trader.handleSellFilled no-op, fell through to inline mark-sold');
                  }
                }
              } else {
                // ไม่มี trader → inline mark-sold
                inlineMark = await doInlineMarkSold();
              }

              // อัปเดต Bot totals ด้วย $inc (atomic, idempotent เช็คจาก trade.sellReason)
              if (inlineMark) {
                await Bot.updateOne(
                  { _id: trade.botId },
                  {
                    $inc: {
                      totalPnl: inlinePnl.net,
                      totalTrades: 1,
                      winTrades: (inlinePnl.net > 0 ? 1 : 0),
                    },
                    $set: { status: 'idle', lastError: '' },
                  }
                );
                eventBus.emit('trade:update', {
                  tradeId: trade._id,
                  botId: trade.botId,
                  state: 'sold',
                  reason: 'orphan_reconcile',
                  reasonDetail: `SELL ${order.orderId} filled but DB state='${trade.state}' — inline mark-sold`,
                  realizedPnl: inlinePnl.net,
                  pnlPercent: inlinePnl.pnlPercent,
                });
                // FIX-2026-08-06: alert via eventBus so telegramNotifier + dashboard surface it.
                //   - ใช้ 'trade:warning' event ที่มีอยู่ (ดู eventBus taxonomy)
                eventBus.emit('trade:warning', {
                  tradeId: trade._id,
                  botId: trade.botId,
                  state: 'sold',
                  reason: 'orphan_reconcile_inline_mark',
                  reasonDetail: `SELL ${order.orderId} FILLED but DB was '${trade.state}' — inline mark-sold, PnL=${inlinePnl.net.toFixed(4)} USDT (${inlinePnl.pnlPercent.toFixed(2)}%)`,
                });

                // FIX-2026-08-08: DPS evaluation — inline mark-sold path ข้าม handleSellFilled
                //   ดังนั้นต้องเรียก DPS ตรงนี้เพื่อให้ orphan ก็นับ resize ด้วย
                //   - safe: evaluate() เช็ค disabled / DCA / cooldown / master-off
                //   - emit dpsResize telegram ถ้า resize จริง
                // FIX-2026-08-09: refactor → use dpsAfterClose.evaluateDpsAfterClose() helper
                //   - single source of truth across all SELL close paths
                //   - helper handles deps reload, master toggle, persistState, log + telegram
                try {
                  const dpsAfterClose = require('./dpsAfterClose');
                  // reload bot snapshot fresh (helper will do this too, but we want it for the
                  //   botName/symbol/timeframe in the inline-mark-sold log above to match)
                  const botSnap = await Bot.findById(trade.botId).lean();
                  if (botSnap) {
                    await dpsAfterClose.evaluateDpsAfterClose({
                      bot: botSnap,
                      pnl: inlinePnl.net,
                      pnlPct: inlinePnl.pnlPercent,
                      source: 'botManager:orphanReconcile',
                    });
                  }
                } catch (dpsErr) {
                  logger.warn({ err: dpsErr.message, tradeId: trade._id.toString() }, 'botManager: orphan DPS evaluation failed (non-fatal)');
                }
              }
            } else if ((order.status === 'CANCELED' || order.status === 'EXPIRED') && trade.state !== 'cancelled') {
              // FIX: SELL ถูก cancel/expire (เช่น manual cancel หรือ TTL) แต่ DB state ยังเป็น selling
              // เคยเกิด: cancel แล้ว trade stuck ที่ selling → scheduleHoldingRetry loop forever
              // → แก้โดย sync state กลับเป็น holding + เคลียร์ sellOrderId → ให้ trader re-place
              logger.warn({
                tradeId: trade._id.toString(),
                dbState: trade.state,
                sellOrderId: trade.sellOrderId,
                orderStatus: order.status,
                botId: trade.botId.toString(),
              }, 'reconcile: ORPHAN — SELL cancelled/expired but DB state still selling, reverting to holding');
              await Trade.updateOne(
                { _id: trade._id, state: { $in: ['selling', 'placed', 'filled'] } },
                {
                  state: 'holding',
                  sellStatus: order.status,
                  $unset: { sellOrderId: '', sellClientOrderId: '' },
                }
              );
              // ถ้ามี trader live ให้ sync currentTrade + trigger holding retry
              const trader = this.traders.get(bot._id.toString());
              if (trader) {
                const fresh = await Trade.findById(trade._id);
                if (fresh) {
                  trader.currentTrade = fresh;
                  logger.info({
                    tradeId: fresh._id.toString(),
                    botId: bot._id.toString(),
                  }, 'reconcile: re-armed holding retry after SELL cancel detected');
                  trader.scheduleHoldingRetry(fresh, fresh.buyQty, fresh.buyPrice, fresh.targetSellPrice);
                }
              }
            } else if (order.status === 'NEW' && trade.state === 'selling') {
              // FIX: SELL ยังมีชีวิตอยู่ — ไม่ต้องทำอะไร
              // (เคยมี bug: restart แล้ว reconcile วนซ้ำหรือไป trigger handleSellFilled ซ้ำ)
              // แค่ log debug เพื่อ visibility
              logger.debug({
                tradeId: trade._id.toString(),
                sellOrderId: trade.sellOrderId,
              }, 'reconcile: SELL still NEW on book, trade in selling state — skip');
            }
          }
        }

        // FIX-2026-07-31 (BUG-13): orphan holding with no sellOrderId — re-arm scheduleHoldingRetry
        //   เดิม: reconcile path ต้องการ sellOrderId + CANCELED/EXPIRED → trade no sellOrderId ค้างตลอด
        //   ใหม่: ถ้า trade.state='holding' และไม่มี sellOrderId → สั่ง trader ให้ scheduleHoldingRetry
        if (trade.state === 'holding' && !trade.sellOrderId) {
          const trader = this.traders.get(bot._id.toString());
          if (trader && trader.running) {
            logger.warn({
              tradeId: trade._id.toString(),
              botId: bot._id.toString(),
              symbol: bot.symbol,
              buyQty: trade.buyQty,
              buyFilledQty: trade.buyFilledQty,
            }, 'reconcile: ORPHAN holding with no sellOrderId — re-arming scheduleHoldingRetry');
            const fresh = await Trade.findById(trade._id);
            if (fresh && fresh.state === 'holding') {
              const qty = parseFloat(fresh.buyFilledQty || fresh.buyQty) || 0;
              const buyPrice = parseFloat(fresh.buyPrice) || 0;
              const targetSell = parseFloat(fresh.targetSellPrice) || 0;
              if (qty > 0 && buyPrice > 0) {
                trader.scheduleHoldingRetry(fresh, qty, buyPrice, targetSell);
              } else {
                logger.warn({
                  tradeId: fresh._id.toString(),
                  qty, buyPrice, targetSell,
                }, 'reconcile: orphan holding has no buyQty/buyPrice — cannot re-arm');
              }
            }
          }
        }
      } catch (err) {
        logger.error({ err: err.message, tradeId: trade._id.toString() }, 'reconcile error');
      }
    }
  }

  /**
   * Recompute Bot totals (totalPnl/totalTrades/winTrades) from Trade collection.
   * ใช้ตอน startup เพื่อซ่อมค่าที่ตกหล่นจาก read-modify-write race ก่อนหน้านี้
   * (idempotent — รันกี่ครั้งก็ได้ผลเดิม)
   */
  async recomputeBotStats() {
    try {
      const bots = await Bot.find().lean();
      for (const bot of bots) {
        const stats = await Trade.aggregate([
          {
            $match: {
              botId: bot._id,
              state: 'sold',
              realizedPnl: { $ne: null },
            },
          },
          {
            $group: {
              _id: null,
              totalPnl: { $sum: '$realizedPnl' },
              totalTrades: { $sum: 1 },
              winTrades: { $sum: { $cond: [{ $gt: ['$realizedPnl', 0] }, 1, 0] } },
            },
          },
        ]);
        const s = stats[0] || { totalPnl: 0, totalTrades: 0, winTrades: 0 };
        // ใช้ $set แทน (overwrite) เพราะ aggregate เป็น source of truth
        await Bot.updateOne(
          { _id: bot._id },
          {
            $set: {
              totalPnl: s.totalPnl,
              totalTrades: s.totalTrades,
              winTrades: s.winTrades,
            },
          }
        );
        if (s.totalTrades !== (bot.totalTrades || 0)) {
          logger.warn({
            botId: bot._id.toString(),
            symbol: bot.symbol,
            old: { totalPnl: bot.totalPnl, totalTrades: bot.totalTrades, winTrades: bot.winTrades },
            new: { totalPnl: s.totalPnl, totalTrades: s.totalTrades, winTrades: s.winTrades },
          }, 'botManager: recomputed bot totals (fixed drift from lost updates)');
        }
      }
    } catch (err) {
      logger.error({ err: err.message }, 'botManager: recomputeBotStats failed');
    }
  }

  // ─── Lifecycle handlers (called from API) ──────────

  // FIX (GIGGLE incident 2026-08-05): stale-cursor reset on re-enable
  //   - on manual enable OR auto-resume, if lastSignalCloseTime is older than REPLAY_MIN_AGE_MS
  //     → re-seed to latestClosed BEFORE spawnTrader()
  //   - ป้องกัน reconcileKlines('startup') ดึง historical candles 200 แท่ง (ช่วง pause/disable)
  //     แล้ว S1 detector ยิง BUY บนแท่งเก่าหลายชั่วโมงก่อน (ghost BUY bug)
  //   - safe: cursor advances monotonically ($max guard ใน trader reconcileKlines กันย้อนหลังอยู่แล้ว)
  //   - mutate `bot.lastSignalCloseTime` ใน place + persist DB เพื่อให้ spawnTrader() ส่งค่าใหม่ให้ Trader ctor
  // FIX-2026-08-22 (auto-resume replay-1): return pendingReplayCandle when cursor age is in safe replay window
  //   - REPLAY_MIN_AGE_MS = 30s : cursor ใหม่มาก ไม่ต้อง replay (WS path / reconcile จัดการเอง)
  //   - REPLAY_MAX_AGE_MS = 5min : pause ยาวเกินไป ไม่ replay (เสี่ยง entry ที่ price เก่า)
  //   - ใน window (30s < age ≤ 5min) : replay last closed candle เพื่อ catch S1 ที่อาจเกิดระหว่าง pause
  async _resetStaleReplayCursorOnEnable(bot) {
    const REPLAY_MIN_AGE_MS = 30 * 1000;            // 30 วินาที
    const REPLAY_MAX_AGE_MS = 5 * 60 * 1000;        // 5 นาที
    const lastSignalCloseMs = bot.lastSignalCloseTime || 0;
    const nowMs = Date.now();
    const cursorAgeMs = nowMs - lastSignalCloseMs;
    // fresh cursor (≤ 30s) → ไม่ต้อง reset (WS / reconcileKlines จะดึงแค่ 1-2 แท่งที่หายไป)
    // FIX-2026-08-22: return shape changed to { newCursorMs, pendingReplayCandle }
    if (lastSignalCloseMs > 0 && cursorAgeMs <= REPLAY_MIN_AGE_MS) {
      return { newCursorMs: lastSignalCloseMs, pendingReplayCandle: null };
    }

    let latestClosedMs = 0;
    let pendingReplayCandle = null;
    try {
      const raw = await binanceRest.getKlines({
        symbol: bot.symbol,
        interval: bot.timeframe,
        limit: 2,
      });
      for (const k of (raw || [])) {
        const ct = k[6];
        // FIX-2026-08-22: also capture OHLCV of the latest closed candle for resume-replay-1
        if (ct <= nowMs && ct > latestClosedMs) {
          latestClosedMs = ct;
          pendingReplayCandle = {
            openTime: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            closeTime: ct,
          };
        }
      }
    } catch (err) {
      // FIX-2026-08-24 (P0 audit): re-throw to surface stale-cursor failure instead of swallowing
      //   - เดิม log warn + return stale cursor → trader.spawnTrader → reconcileKlines('startup')
      //     replay 200 candles จาก stale cursor → ghost BUY (regression GIGGLE 2026-08-05)
      //   - ใหม่: throw เพื่อให้ caller (enableBot, auto-resume) abort spawn safely
      //   - ก่อน throw: log + emit 'bot:enable_cursor_reset_failed' เพื่อให้ telegramNotifier แจ้ง
      logger.error({ botId: String(bot._id), symbol: bot.symbol, err: err.message },
        'botManager: _resetStaleReplayCursorOnEnable — getKlines failed; refusing enable to prevent ghost BUY replay');
      try {
        eventBus.emit('bot:enable_cursor_reset_failed', {
          botId: String(bot._id),
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          reason: err.message,
        });
      } catch (_) { /* never let emit fail the throw */ }
      const wrappedErr = new Error(`stale-cursor reset failed for bot ${bot._id}: ${err.message}`);
      wrappedErr.code = 'STALE_CURSOR_RESET_FAILED';
      wrappedErr.botId = String(bot._id);
      throw wrappedErr;
    }
    if (latestClosedMs === 0) {
      return { newCursorMs: lastSignalCloseMs, pendingReplayCandle: null };
    } // ยังไม่มี closed candle (เดือนใหม่, exchange ปิด ฯลฯ)

    await Bot.updateOne({ _id: bot._id }, { $set: { lastSignalCloseTime: latestClosedMs } });
    bot.lastSignalCloseTime = latestClosedMs;

    // FIX-2026-08-22: only return pendingReplayCandle when cursor age is in the safe replay window
    //   - cursorAgeMs > REPLAY_MIN_AGE_MS (30s) → fresh enough that WS may have legitimately missed it
    //   - cursorAgeMs ≤ REPLAY_MAX_AGE_MS (5min) → not so stale that entry price is risky
    const inReplayWindow = cursorAgeMs > REPLAY_MIN_AGE_MS && cursorAgeMs <= REPLAY_MAX_AGE_MS;
    const replayCandle = inReplayWindow ? pendingReplayCandle : null;
    let replayReason;
    if (cursorAgeMs <= REPLAY_MIN_AGE_MS) replayReason = 'too_fresh';
    else if (cursorAgeMs > REPLAY_MAX_AGE_MS) replayReason = 'too_stale';
    else replayReason = 'in_window';

    logger.info({
      botId: String(bot._id),
      symbol: bot.symbol,
      timeframe: bot.timeframe,
      prevCursorMs: lastSignalCloseMs,
      cursorAgeMs,
      newCursorMs: latestClosedMs,
      willReplayCandle: !!replayCandle,
      replayReason,
    }, 'botManager: stale replay cursor reset on re-enable');

    return { newCursorMs: latestClosedMs, pendingReplayCandle: replayCandle };
  }

  async enableBot(botId) {
    const bot = await Bot.findById(botId);
    if (!bot) throw new Error('Bot not found');
    // FIX-2026-08-22 (zombie): refuse to enable a soft-deleted bot via direct API call
    //   - ป้องกัน user-initiated path (POST /api/bots/:id/enable, bulk-toggle) จากการเปิดบอทที่ลบไปแล้ว
    //   - ถ้าต้องการ re-enable จริงๆ ต้องเรียก restore endpoint ก่อน (POST /api/bots/:id/restore)
    if (bot.deletedAt) {
      throw new Error('Bot is soft-deleted — call POST /api/bots/:id/restore first to re-enable');
    }
    // FIX 2026-08-05: reset stale cursor ก่อน spawnTrader (กัน ghost BUY จาก reconcileKlines replay)
    // FIX-2026-08-24 (P0 audit): catch STALE_CURSOR_RESET_FAILED and abort enable safely
    //   - เดิม: error ถูก swallow ใน helper → spawn → ghost BUY replay
    //   - ใหม่: helper throws → caller abort (do NOT set enabled=true, do NOT spawn)
    let pendingReplayCandle = null;
    try {
      ({ pendingReplayCandle } = await this._resetStaleReplayCursorOnEnable(bot));
    } catch (cursorErr) {
      if (cursorErr.code === 'STALE_CURSOR_RESET_FAILED') {
        logger.warn({ botId: String(bot._id), symbol: bot.symbol }, 'botManager: enableBot aborted — stale cursor reset failed; bot remains disabled to prevent ghost BUY');
        // rethrow as-is so route handler returns 503 to user
        throw cursorErr;
      }
      throw cursorErr;
    }
    bot.enabled = true;
    bot.enabledAt = new Date();
    bot.status = 'idle';
    await bot.save();
    await this._withSpawnLock(bot._id, () => this.spawnTrader(bot));
    eventBus.emit('bot:updated', { botId });
    // FIX-2026-07-24: action-specific event สำหรับ Telegram notifier (bot:updated payload ไม่มี verb)
    eventBus.emit('bot:enabled', { botId });
    // FIX-2026-08-04 v3: invalidate trendline cache + scan immediately (fresh badge on re-enable)
    //   - เดิม: only invalidate → stale นาน 10 นาที (รอ next 600s tick)
    //   - ใหม่: invalidate + fire-and-forget scanSingleBot() → fresh badge ภายใน ~200ms
    //   - หากไม่มี safeTradeTrendlineEnabled → skip (no Binance call wasted)
    if (bot.safeTradeTrendlineEnabled === true) {
      invalidateTrendlineCache(bot.symbol, bot.timeframe);
      scanSingleBot(bot).catch((err) => {
        logger.warn({ botId: String(bot._id), symbol: bot.symbol, err: err.message }, 'botManager: enableBot → scanSingleBot failed');
      });
    }
    // FIX-2026-08-14: trigger reconcilePendingTrades() right after spawn so a
    //   re-enabled bot picks up any orphan BUY-filled-without-SELL trades that
    //   accumulated while it was disabled (e.g. EPIC 2026-08-14 incident where
    //   bot was auto-paused 4 hours after BUY fill → DB stuck in 'filled' with
    //   no sellOrderId, creating "10 positions vs 9 open orders" mismatch).
    //   - previous behavior: enableBot spawned trader but waited up to
    //     RECONCILE_INTERVAL_MS (5 min) for the periodic sweep to catch orphan.
    //   - new: fire-and-forget reconcile immediately → trader.handleBuyFilled
    //     places LIMIT_MAKER SELL @ TP for the orphan trade.
    //   - reconcileInFlight guard: periodic sweep will skip this cycle.
    if (!this.reconcileInFlight) {
      this.reconcileInFlight = true;
      this.reconcilePendingTrades()
        .catch((err) => logger.warn({ botId: String(bot._id), err: err.message }, 'botManager: enableBot → reconcilePendingTrades failed'))
        .finally(() => { this.reconcileInFlight = false; });
    }
    return bot;
  }

  async disableBot(botId) {
    const bot = await Bot.findById(botId);
    if (!bot) throw new Error('Bot not found');
    // สะสมเวลา enabled รอบนี้เข้า totalActiveMs ก่อนเคลียร์ enabledAt
    if (bot.enabledAt) {
      const sessionMs = Date.now() - new Date(bot.enabledAt).getTime();
      if (sessionMs > 0) bot.totalActiveMs = (bot.totalActiveMs || 0) + sessionMs;
    }
    bot.enabled = false;
    bot.enabledAt = null;
    bot.disabledAt = new Date(); // FIX-2026-08-08: anchor for autoDeleteBot downtime calc
    bot.status = 'idle';
    await bot.save();
    await this.stopTrader(botId);
    eventBus.emit('bot:updated', { botId });
    // FIX-2026-07-24: action-specific event สำหรับ Telegram notifier
    eventBus.emit('bot:disabled', { botId });
    return bot;
  }

  /**
   * Flush cumulative active time for every enabled bot (called on graceful shutdown).
   * ป้องกันข้อมูลเวลาหายเมื่อ PM2 kill server หรือ SIGTERM ก่อนผู้ใช้กด disable
   */
  async flushActiveTimeOnShutdown() {
    try {
      const enabled = await Bot.find({ enabled: true, enabledAt: { $ne: null } });
      const now = Date.now();
      for (const b of enabled) {
        const sessionMs = now - new Date(b.enabledAt).getTime();
        if (sessionMs > 0) {
          await Bot.updateOne(
            { _id: b._id },
            { $inc: { totalActiveMs: sessionMs } }
          );
        }
      }
      if (enabled.length) {
        logger.info({ count: enabled.length }, 'flushed totalActiveMs on shutdown');
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'flushActiveTimeOnShutdown failed');
    }
  }
}

// FIX-2026-08-22: Return Set of botId strings that currently have a BUY in flight.
//   Used by checkAutoPauseBots() to skip pausing bots that have an open position
//   needing the trader to complete the BUY → SELL placement cycle. On error returns
//   empty Set (fail-OPEN: still allow pauses — better than orphaning the BUY).
//   Exported for testability (see tests/autoPauseBuyInFlight.test.js).
async function findBotIdsWithBuyInFlight() {
  const out = new Set();
  try {
    const cursor = Trade.find(
      { state: { $in: AUTO_PAUSE_BUY_IN_FLIGHT_STATES } },
      { projection: { botId: 1 } }
    ).lean().cursor();
    for await (const t of cursor) {
      if (t && t.botId) out.add(String(t.botId));
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'botManager: findBotIdsWithBuyInFlight failed');
  }
  return out;
}

// FIX-2026-08-01: Auto-pause scanner — ทุก 5 นาที ตรวจ Min-%KC(30 bars) ของทุกบอทที่ autoPauseEnabled !== false
//   - ถ้า minKcPct < threshold และบอท enabled → PAUSE (set enabled=false + telegram + stop trader)
//   - ถ้า minKcPct >= threshold และบอท auto-paused ก่อนหน้า (autoPauseReason === 'low_vol') → RESUME
//   - auto-resume เฉพาะบอทที่ถูก auto-pause (ไม่ resume บอทที่ user ปิดเอง)
//   - FIX-2026-08-22: ถ้ามี BUY in flight → SKIP pause (กัน orphan) — see findBotIdsWithBuyInFlight()
//   - FIX-2026-08-22 (zombie): exclude soft-deleted bots (deletedAt: null) — กัน RESUME บอทที่ user ลบไปแล้ว
//     (kaito/gps incident: บอทถูก auto-pause → user soft-delete → vol ฟื้น → auto-RESUME กลับมาเปิด BUY ใหม่)
async function checkAutoPauseBots() {
  // FIX-2026-08-28 B6: license gate — basic tier disables Auto Pause on minKC%
  if (!licenseService.isFeatureEnabled('autoPauseMinKc')) {
    logger.debug('botManager: checkAutoPauseBots skipped — license disables autoPauseMinKc');
    return;
  }
  let bots;
  try {
    bots = await Bot.find({ autoPauseEnabled: { $ne: false }, deletedAt: null }).lean();
  } catch (err) {
    logger.warn({ err: err.message }, 'botManager: checkAutoPauseBots — Bot.find failed');
    return;
  }
  if (!bots || bots.length === 0) return;

  // FIX-2026-08-24 (P1 audit): stats accumulator (P1-7 hysteresis counter)
  let stats = { skippedHysteresis: 0, skippedBuyInFlight: 0, paused: 0, resumed: 0, errors: 0 };

  const telegramNotifier = require('../services/telegramNotifier');
  const now = new Date();

  // FIX-2026-08-10: bulk fetch 24h tickers (weight 80 once/tick) → build symbol→quoteVolume Map
  //   - pattern mirrors volatilityScanner.js:227
  //   - on failure: volMap stays empty → per-bot lookup returns 0 → all bots evaluate as "low 24h vol"
  //     (safer to pause than to miss illiquid coins)
  const volMap = new Map();
  try {
    const all = await binanceRest.get24hrTickers();
    for (const t of (all || [])) {
      if (!t || !t.symbol) continue;
      const qv = parseFloat(t.quoteVolume);
      if (Number.isFinite(qv)) volMap.set(String(t.symbol).toUpperCase(), qv);
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'botManager: checkAutoPauseBots — 24h tickers bulk fetch failed');
  }

  // Local helper: format USDT for telegram (e.g. 1234567 → "$1.2M")
  const fmtUsdt = (n) => {
    if (!Number.isFinite(n)) return '$0';
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${Math.round(n)}`;
  };

  // FIX-2026-08-22: pre-fetch botIds with BUY in flight (single query, streamed)
  //   - on error returns empty Set (fail-OPEN — pause still allowed if Trade.query fails)
  //   - skip-then-pause pattern: ถ้า pauseReason trigger แต่มี BUY in flight → skip
  //     (จะถูก evaluate อีกครั้งใน tick ถัดไป เมื่อ BUY progress ไปถึง 'selling')
  const buyInFlightBots = await findBotIdsWithBuyInFlight();

  for (const b of bots) {
    try {
      const raw = await binanceRest.getKlines({ symbol: b.symbol, interval: b.timeframe, limit: 50 });
      if (!Array.isArray(raw) || raw.length < 25) continue;
      const highs = raw.map((k) => parseFloat(k[2]));
      const lows = raw.map((k) => parseFloat(k[3]));
      const closes = raw.map((k) => parseFloat(k[4]));
      const kc = indicators.keltnerChannel(highs, lows, closes, 20, b.kcMult || 1.5);
      const tail = kc.width.slice(-30).filter((w) => w != null && Number.isFinite(w));
      if (tail.length < 5) continue;
      const minKcPct = Math.min(...tail);
      const kcThreshold = b.autoPauseMinKcPct != null ? b.autoPauseMinKcPct : 2;
      const volThreshold = b.autoPauseMin24hVolUsdt != null ? b.autoPauseMin24hVolUsdt : 1_000_000;
      const quoteVolume24h = volMap.get(String(b.symbol).toUpperCase()) || 0;
      const kcLow = minKcPct < kcThreshold;
      const volLow = quoteVolume24h < volThreshold;

      const update = { autoPauseLastCheckedAt: now };

      // FIX-2026-08-07: HYBRID mode — CBv2 cooldown ไม่ block Auto-pause/resume อีกต่อไป
      //   - CBv2 แค่กั้น S1 BUY (cooldown window) — ไม่ disable บอท ไม่ override Auto-pause
      //   - Auto-pause ทำงานปกติ: ถ้า Min-%KC ต่ำ OR 24hVol ต่ำ → pause
      //     (priority: %KC ก่อน → 'low_vol', ถ้า %KC OK แต่ 24hVol ต่ำ → 'low_24h_vol')
      //   - Resume ต้องผ่านทั้ง 2 เงื่อนไข (AND)
      //   - CBv2 cooldown อาจอยู่ระหว่าง Auto-pause ได้ (เป็นอิสระต่อกัน)
      //   - ลบ CBv2 lock override block เดิม (FIX-2026-08-06) แล้ว — ไม่จำเป็นแล้วใน HYBRID mode

      // FIX-2026-08-10: เพิ่มเงื่อนไขที่ 2 (24h volume) — pause ถ้าเงื่อนไขใดเงื่อนไขหนึ่งผิดพลาด
      //   - reason priority: 'low_vol' (KC) ก่อน 'low_24h_vol' — เก็บ backward-compat กับ event consumers
      let pauseReason = null;
      if (kcLow) pauseReason = 'low_vol';
      else if (volLow) pauseReason = 'low_24h_vol';

      // Build telegram reason: แสดงทั้ง 2 metrics เสมอ (ชัดเจนสำหรับ debug + UI)
      const pauseReasonStr =
        pauseReason === 'low_vol'
          ? `auto-pause: Min-%KC=${minKcPct.toFixed(2)}% < ${kcThreshold}% AND 24hVol=${fmtUsdt(quoteVolume24h)} < ${fmtUsdt(volThreshold)}`
          : pauseReason === 'low_24h_vol'
            ? `auto-pause: Min-%KC=${minKcPct.toFixed(2)}% ≥ ${kcThreshold}% (OK) BUT 24hVol=${fmtUsdt(quoteVolume24h)} < ${fmtUsdt(volThreshold)}`
            : null;
      const resumeReasonStr = `auto-resume: Min-%KC=${minKcPct.toFixed(2)}% ≥ ${kcThreshold}% AND 24hVol=${fmtUsdt(quoteVolume24h)} ≥ ${fmtUsdt(volThreshold)}`;

      if (pauseReason && b.enabled !== false) {
        // ─── PAUSE ────────────────────────────────────────────────────
        // FIX-2026-08-24 (P1 audit): hysteresis guard — กัน ping-pong ที่ boundary
        //   - เดิม: Min-%KC แกว่งใกล้ threshold → pause/resume/pause ทุก 5 นาที
        //     → telegram spam + bot status flip-flop + trader spawn/stop บ่อย
        //   - fix: skip ถ้า bot เพิ่งถูก flip (pause/resume) ภายใน AUTO_PAUSE_HYSTERESIS_MS
        if (shouldSkipFlipByHysteresis(b._id)) {
          update.autoPauseLastCheckedAt = now;
          update.autoPauseSkipReason = 'hysteresis';
          await Bot.updateOne({ _id: b._id }, { $set: update });
          stats.skippedHysteresis = (stats.skippedHysteresis || 0) + 1;
          logger.debug({ botId: String(b._id), pauseReason, minKcPct, quoteVolume24h }, 'botManager: auto-pause skipped — within hysteresis window');
          continue;
        }
        // FIX-2026-08-22: skip pause if bot has a BUY in flight — pausing here would
        //   orphan the position (trader.stop() removes the in-memory SELL-placement
        //   handler).  Next tick (10min) will re-evaluate when BUY has progressed
        //   to 'selling' (safe to pause) or the BUY has fully closed.
        if (buyInFlightBots.has(String(b._id))) {
          update.autoPauseLastCheckedAt = now;
          update.autoPauseSkipReason = 'buy_in_flight';
          await Bot.updateOne({ _id: b._id }, { $set: update });
          stats.skippedBuyInFlight = (stats.skippedBuyInFlight || 0) + 1;
          logger.info({
            botId: String(b._id),
            pauseReason,
            minKcPct,
            quoteVolume24h,
          }, 'botManager: auto-pause skipped — BUY in flight');
          continue;
        }
        Object.assign(update, {
          enabled: false,
          enabledAt: null,
          status: 'idle',
          autoPauseLastActionAt: now,
          autoPauseReason: pauseReason,
          // FIX-2026-08-22: clear skip flag on successful pause (it was bypassed)
          autoPauseSkipReason: null,
        });
        await Bot.updateOne({ _id: b._id }, { $set: update });
        recordAutoPauseFlip(b._id);
        stats.paused = (stats.paused || 0) + 1;
        const stopReason = pauseReason === 'low_vol' ? 'auto_pause_low_kc' : 'auto_pause_low_24h_vol';
        eventBus.emit('bot:disabled', {
          botId: String(b._id),
          reason: stopReason,
          minKcPct,
          quoteVolume24h,
          pauseReason,
        });
        try {
          await telegramNotifier.sendNow('botDisabled', {
            botId: String(b._id),
            botName: b.name || b.symbol,
            symbol: b.symbol,
            timeframe: b.timeframe,
            reason: pauseReasonStr,
          });
        } catch (_) { /* non-fatal */ }
        const trader = this.traders.get(String(b._id));
        if (trader) {
          // FIX-2026-08-06 (HOME stuck SL-UKC loop): delete from map BEFORE stop()
          //   - trader.stop() sets running=false but leaves instance in this.traders map
          //   - on auto-resume, spawnTrader() bails with "trader already running" because map is non-empty
          //   - reconcile orphan handler calls trader.handleBuyFilled etc. → bails at if (!this.running) return
          //   - delete ก่อน → spawnTrader จะสร้าง instance ใหม่ได้ตอน auto-resume (clean restart)
          this.traders.delete(String(b._id));
          await trader.stop(stopReason).catch(() => {});
        }
        logger.info({
          botId: String(b._id),
          minKcPct,
          kcThreshold,
          quoteVolume24h,
          volThreshold,
          pauseReason,
        }, 'botManager: auto-paused bot');
      } else if (
        !kcLow && !volLow
        && b.enabled === false
        && !b.deletedAt // FIX-2026-08-22 (zombie): guard against respawning soft-deleted bots
        && (b.autoPauseReason === 'low_vol' || b.autoPauseReason === 'low_24h_vol')
      ) {
        // ─── RESUME (เฉพาะบอทที่เคยถูก auto-pause) ──────────────────
        // FIX-2026-08-24 (P1 audit): hysteresis guard mirror — กัน resume/pause ping-pong
        if (shouldSkipFlipByHysteresis(b._id)) {
          update.autoPauseLastCheckedAt = now;
          update.autoPauseSkipReason = 'hysteresis';
          await Bot.updateOne({ _id: b._id }, { $set: update });
          stats.skippedHysteresis = (stats.skippedHysteresis || 0) + 1;
          logger.debug({ botId: String(b._id), minKcPct, quoteVolume24h }, 'botManager: auto-resume skipped — within hysteresis window');
          continue;
        }
        // FIX-2026-08-07: HYBRID mode — CBv2 cooldown ไม่ block resume อีกต่อไป
        //   - CBv2 cooldown แค่กั้น BUY — ไม่ disable บอท, ไม่ override auto-pause logic
        //   - ลบ CBv2 lock override blocks เดิม (FIX-2026-08-06) — ไม่จำเป็นใน HYBRID mode
        // FIX-2026-08-10: resume gate ต้องการทั้ง 2 เงื่อนไข healthy + reason ∈ {low_vol, low_24h_vol}
        //   - บอทที่ user ปิดเอง (reason=null) หรือ delist (reason='binance_delist') → ไม่ auto-resume
        // FIX-2026-08-22 (zombie): defense-in-depth — ถึงแม้ loader filter จะตัด deletedAt แล้ว
        //   ก็เช็คซ้ำใน condition (กัน regression ถ้า loader filter หลุด)
        Object.assign(update, {
          enabled: true,
          enabledAt: now,
          autoPauseLastActionAt: now,
          autoPauseReason: 'vol_recovered',
          // FIX-2026-08-22: clear skip flag on successful resume
          autoPauseSkipReason: null,
        });
        await Bot.updateOne({ _id: b._id }, { $set: update });
        recordAutoPauseFlip(b._id);
        // FIX 2026-08-05 (GIGGLE): reset stale cursor ก่อน spawnTrader (กัน ghost BUY จาก reconcileKlines replay)
        //   - b เป็น plain object จาก .find() → mutate directly แล้ว persist ผ่าน helper
        // FIX-2026-08-22: capture pendingReplayCandle เพื่อ replay last closed candle (auto-resume เท่านั้น)
        //   - manual enable / PM2 boot ไม่ trigger replay (user อาจตั้งใจปิด)
        //   - safe window (30s, 5min] enforced ใน helper แล้ว
        // FIX-2026-08-24 (P0 audit): catch STALE_CURSOR_RESET_FAILED — skip auto-resume for this bot
        //   - เดิม: error swallow → ghost BUY on next reconcile cycle
        //   - ใหม่: skip resume + leave bot disabled + try again on next 5-min tick
        let pendingReplayCandle = null;
        try {
          ({ pendingReplayCandle } = await this._resetStaleReplayCursorOnEnable(b));
        } catch (cursorErr) {
          if (cursorErr.code === 'STALE_CURSOR_RESET_FAILED') {
            logger.warn({ botId: String(b._id), symbol: b.symbol }, 'auto-resume skipped this tick — stale cursor reset failed; will retry on next 5-min cycle');
            stats.skippedCursorResetFailed = (stats.skippedCursorResetFailed || 0) + 1;
            continue;
          }
          throw cursorErr;
        }
        eventBus.emit('bot:enabled', {
          botId: String(b._id),
          reason: 'auto_resume_vol_recovered',
          minKcPct,
          quoteVolume24h,
        });
        try {
          await telegramNotifier.sendNow('botEnabled', {
            botId: String(b._id),
            botName: b.name || b.symbol,
            symbol: b.symbol,
            timeframe: b.timeframe,
            reason: resumeReasonStr,
          });
        } catch (_) { /* non-fatal */ }
        // re-spawn trader (mirror enableBot behavior — without totalActiveMs accrual since autoPause is short)
        // FIX-2026-08-22: pass pendingReplayCandle → spawnTrader จะ schedule onCandleClosed replay หลัง start
        await this._withSpawnLock(b._id, () => this.spawnTrader({ _id: b._id, ...b }, { pendingReplayCandle })).catch((err) => logger.warn({ botId: String(b._id), err: err.message }, 'botManager: auto-resume spawn failed'));
        stats.resumed = (stats.resumed || 0) + 1;
        logger.info({
          botId: String(b._id),
          minKcPct,
          kcThreshold,
          quoteVolume24h,
          volThreshold,
        }, 'botManager: auto-resumed bot (vol recovered)');
      } else {
        // ปกติ: แค่ update timestamp
        await Bot.updateOne({ _id: b._id }, { $set: update });
      }
    } catch (err) {
      stats.errors = (stats.errors || 0) + 1;
      logger.warn({ botId: String(b._id), err: err.message }, 'botManager: auto-pause check failed');
    }
  }

  // FIX-2026-08-24 (P1 audit): roll-up log for observability
  if (stats.paused > 0 || stats.resumed > 0 || stats.skippedHysteresis > 0 || stats.skippedBuyInFlight > 0 || stats.skippedCursorResetFailed > 0 || stats.errors > 0) {
    logger.info({ stats }, 'botManager: checkAutoPauseBots roll-up');
  }
}

// FIX-2026-08-06: Delist scheduler — ทุก 5 นาที scan delistMonitor แล้ว auto-pause + force-close
//   - Phase A: บอทที่ trade symbol ที่ delistTime - now <= 7d → auto-pause (set enabled=false)
//     (force-close ทำใน Phase B แยก — Phase A แค่ mark + disable + telegram)
//   - Phase B: �อทที่ trade symbol ที่ delistTime - now <= 3d → force-close open positions
//     (ใช้ forceClose.forceCloseTrade ที่ positionWatchdog ใช้เช่นกัน — atomic state guard)
//   - botManager scheduler จัดการทั้ง enabled และ disabled bots (force-close ต้องทำแม้บอทปิด)
//   - skip on previous tick in-flight (กัน overlap)
async function checkDelistScheduleBots() {
  if (delistSchedulerInFlight) {
    logger.debug('botManager: delist scheduler previous tick still in flight, skip');
    return;
  }
  delistSchedulerInFlight = true;
  let stats = { scheduledSymbols: 0, botsAffected: 0, paused: 0, forceClosed: 0, errors: 0 };
  try {
    const delistMonitor = require('../services/binanceDelistMonitor');
    const forceClose = require('../core/forceClose');
    const scheduled = delistMonitor.getScheduledSymbols();
    stats.scheduledSymbols = scheduled.length;
    if (scheduled.length === 0) return;

    const scheduledSymbols = new Set(scheduled.map((s) => s.symbol));
    const forceCloseSet = new Set(scheduled.filter((s) => s.daysUntil <= 3).map((s) => s.symbol));
    const blockBuySet = new Set(scheduled.filter((s) => s.daysUntil <= 7).map((s) => s.symbol));

    // Find bots trading these symbols (any enabled state — force-close must work on disabled too)
    const bots = await Bot.find({ symbol: { $in: [...scheduledSymbols] } }).lean();
    if (!bots || bots.length === 0) return;
    stats.botsAffected = bots.length;

    const telegramNotifier = require('../services/telegramNotifier');
    const now = new Date();

    for (const b of bots) {
      const sym = b.symbol;
      const delistEntry = scheduled.find((s) => s.symbol === sym);
      if (!delistEntry) continue;

      // Phase A: auto-pause if within 7d
      if (blockBuySet.has(sym) && b.enabled !== false) {
        try {
          await Bot.updateOne(
            { _id: b._id },
            {
              $set: {
                enabled: false,
                enabledAt: null,
                status: 'idle',
                autoPauseReason: 'binance_delist',
                autoPauseLastActionAt: now,
                autoPauseLastCheckedAt: now,
              },
            }
          );
          stats.paused++;
          logger.warn({
            botId: String(b._id),
            symbol: sym,
            daysUntil: delistEntry.daysUntil,
            delistTime: delistEntry.delistDateIso,
          }, 'botManager: delist auto-pause — symbol scheduled for delist');
          eventBus.emit('bot:disabled', {
            botId: String(b._id),
            reason: 'auto_pause_binance_delist',
            symbol: sym,
            delistTime: delistEntry.delistTime,
            daysUntil: delistEntry.daysUntil,
          });
          try {
            await telegramNotifier.sendNow('botDisabled', {
              botId: String(b._id),
              botName: b.name || sym,
              symbol: sym,
              timeframe: b.timeframe,
              reason: `auto-pause: symbol delist in ${delistEntry.daysUntil.toFixed(1)}d (${delistEntry.delistDateIso})`,
            });
          } catch (_) { /* non-fatal */ }
          // stop trader if running
          const trader = this.traders.get(String(b._id));
          if (trader) {
            this.traders.delete(String(b._id));
            await trader.stop('auto_pause_binance_delist').catch(() => {});
          }
        } catch (err) {
          stats.errors++;
          logger.warn({ botId: String(b._id), err: err.message }, 'botManager: delist auto-pause failed');
        }
      }

      // Phase B: force-close if within 3d (run regardless of enabled state — even disabled bots need closing)
      if (forceCloseSet.has(sym)) {
        const Trade = require('../db/models/Trade');
        const OPEN_STATES = ['placed', 'partial_wait', 'filled', 'holding', 'selling', 'partial_sell_wait', 'retrying', 'stopping'];
        const openTrades = await Trade.find({ botId: b._id, state: { $in: OPEN_STATES } }).lean();
        for (const t of openTrades) {
          try {
            const fresh = await Trade.findById(t._id);
            if (!fresh || !OPEN_STATES.includes(fresh.state)) continue;
            const result = await forceClose.forceCloseTrade({ trade: fresh, bot: b, allowMarketSell: true });
            if (result.ok) {
              stats.forceClosed++;
              logger.warn({
                botId: String(b._id),
                tradeId: String(t._id),
                symbol: sym,
                daysUntil: delistEntry.daysUntil,
                mode: result.mode,
                pnl: result.pnl,
              }, 'botManager: delist force-close executed');
              eventBus.emit('positionWatchdog:closed', {
                tradeId: t._id,
                botId: String(b._id),
                symbol: sym,
                isDcaStack: t.isDcaStack === true,
                mode: result.mode,
                pnl: result.pnl,
                avgSellPrice: result.avgSellPrice,
                source: 'delist_scheduler',
                delistTime: delistEntry.delistTime,
                daysUntil: delistEntry.daysUntil,
              });
              try {
                await telegramNotifier.sendNow('positionForceClosed', {
                  botId: String(b._id),
                  botName: b.name || sym,
                  symbol: sym,
                  tradeId: String(t._id),
                  pnl: result.pnl,
                  mode: result.mode,
                  reason: `binance delist in ${delistEntry.daysUntil.toFixed(1)}d (${delistEntry.delistDateIso})`,
                });
              } catch (_) { /* non-fatal */ }
            } else {
              stats.errors++;
              logger.warn({ botId: String(b._id), tradeId: String(t._id), err: result.error }, 'botManager: delist force-close failed');
            }
          } catch (err) {
            stats.errors++;
            logger.warn({ botId: String(b._id), tradeId: String(t._id), err: err.message }, 'botManager: delist force-close exception');
          }
        }
      }
    }
  } catch (err) {
    stats.errors++;
    logger.error({ err: err.message, stack: err.stack }, 'botManager: checkDelistScheduleBots failed');
  } finally {
    delistSchedulerInFlight = false;
    if (stats.paused > 0 || stats.forceClosed > 0 || stats.errors > 0) {
      logger.info({ ...stats }, 'botManager: delist scheduler tick summary');
    }
  }
}

module.exports = new BotManager();

// FIX-2026-08-03: Export helpers for routes (pattern mirrors module.exports = new BotManager() above)
module.exports.getTrendlineStatusForBots = getTrendlineStatusForBots;
module.exports.invalidateTrendlineCache = invalidateTrendlineCache;
// FIX-2026-08-22: Export for testability (see tests/autoPauseBuyInFlight.test.js)
module.exports.findBotIdsWithBuyInFlight = findBotIdsWithBuyInFlight;
module.exports.AUTO_PAUSE_BUY_IN_FLIGHT_STATES = AUTO_PAUSE_BUY_IN_FLIGHT_STATES;
// FIX-2026-08-22 (zombie): Export for testability (see tests/autoPauseDeletedAtGuard.test.js)
module.exports.checkAutoPauseBots = checkAutoPauseBots;

// FIX-2026-08-03: Trendline status scanner — refresh _trendlineStatusCache ทุก 60s
//   - ตรวจเฉพาะบอทที่ safeTradeTrendlineEnabled === true (ลด Binance calls)
//   - ใช้ trendlineForBot.mapWithConcurrency(6) กัน burst weight
//   - **read-only** — ไม่มี side effect กับ trade state
//   - emit 'bot:trendline_status_changed' event เมื่อ status เปลี่ยน (เพื่อให้ telegram notifier แจ้งได้)
// FIX-2026-08-04 v3: extract scanSingleBot() — reuse จาก enableBot() เพื่อ refresh badge ทันทีหลัง enable
//   - เดิม enable → invalidate → รอ 600s scan tick → stale 10 นาที
//   - ใหม่ enable → invalidate → scanSingleBot() ทันที (Binance ~200ms) → fresh badge
//   - transition event: หาก scanSingleBot ครั้งแรกที่ prev=undefined → skip notification (กัน spam)
async function scanSingleBot(bot, precomputedSnap) {
  const botId = String(bot._id);
  const prev = _trendlineStatusCache.get(botId);
  let snap = precomputedSnap;
  if (!snap) {
    try {
      snap = await trendlineForBot.computeBotTrendlineSnapshot(bot);
    } catch (err) {
      logger.warn({ botId, symbol: bot.symbol, err: err.message }, 'botManager: scanSingleBot — computeBotTrendlineSnapshot failed');
      return;
    }
  }
  const now = Date.now();
  _trendlineStatusCache.set(botId, {
    status: snap.status || 'unknown',
    trendTF: snap.trendTF || null,
    lastClose: snap.lastClose != null ? snap.lastClose : null,
    trendlineValue: snap.trendlineValue != null ? snap.trendlineValue : null,
    gapPct: snap.gapPct != null ? Number(snap.gapPct) : null,
    pivotCount: snap.pivotCount || 0,
    updatedAt: now,
    cached: !!snap.cached,
    ms: snap.ms != null ? snap.ms : null,
    error: snap.error || null,
  });
  // Detect transition (only meaningful states: pass ↔ blocked) — skip if prev undefined (initial)
  if (prev && prev.status !== snap.status && (snap.status === 'pass' || snap.status === 'blocked')
      && (prev.status === 'pass' || prev.status === 'blocked')) {
    try {
      const telegramNotifier = require('../services/telegramNotifier');
      await telegramNotifier.sendNow('trendlineStatusChanged', {
        botId,
        botName: bot.name || bot.symbol,
        symbol: bot.symbol,
        timeframe: bot.timeframe,
        trendTF: snap.trendTF,
        prevStatus: prev.status,
        newStatus: snap.status,
        lastClose: snap.lastClose,
        trendlineValue: snap.trendlineValue,
        gapPct: snap.gapPct,
      });
    } catch (_) { /* non-fatal */ }
    eventBus.emit('bot:trendline_status_changed', {
      botId, symbol: bot.symbol, prevStatus: prev.status, newStatus: snap.status,
      lastClose: snap.lastClose, trendlineValue: snap.trendlineValue, gapPct: snap.gapPct,
    });
  }
  logger.debug({ botId, symbol: bot.symbol, status: snap.status }, 'botManager: scanSingleBot done');
}

async function checkTrendlineStatusBots() {
  let bots;
  try {
    // FIX-2026-08-04 v2: filter enabled: true only — disabled bots freeze cache at last value
    //   - เหตุผล: disabled bot ไม่ทำการเทรดอยู่แล้ว → status แค่แสดง stale info ไม่มีประโยชน์
    //   - ลด Binance kline load ลง 5 เท่า (เฉพาะ enabled bots scan)
    //   - เมื่อ enable bot ใหม่ → invalidateTrendlineCache() + scanSingleBot() ใน enableBot() → fresh ทันที
    bots = await Bot.find({ safeTradeTrendlineEnabled: true, enabled: true }).lean();
  } catch (err) {
    logger.warn({ err: err.message }, 'botManager: checkTrendlineStatusBots — Bot.find failed');
    return;
  }
  if (!bots || bots.length === 0) {
    // ลบ cache entries สำหรับบอทที่ปิด filter แล้ว (cleanup)
    return;
  }

  // FIX-2026-08-04 v3: parallel fetch snapshots (concurrency 6), then sequential cache update via scanSingleBot
  //   - decoupling: scanSingleBot(bot, snap) handles cache-set + transition event (reusable from enableBot)
  //   - single Binance call per bot per tick (no duplication)
  const now = Date.now();
  const snapshots = await trendlineForBot.mapWithConcurrency(
    bots, 6, (b) => trendlineForBot.computeBotTrendlineSnapshot(b)
  );
  for (let i = 0; i < bots.length; i += 1) {
    await scanSingleBot(bots[i], snapshots[i]);
  }

  logger.debug({ count: bots.length, ts: now }, 'botManager: trendline status scan done');
}

// FIX-2026-08-03: accessor for /api/bots route — returns slim fields for bot card badge
function getTrendlineStatusForBots(botIds) {
  const out = {};
  for (const id of botIds) {
    const s = _trendlineStatusCache.get(String(id));
    if (s) out[String(id)] = s;
  }
  return out;
}

// FIX-2026-08-03: cache invalidation when timeframe changes (called from botUpdate + bulk-update routes)
//   - mirrors volatilityForBot.invalidate(symbol, timeframe) pattern
function invalidateTrendlineCache(symbol, timeframe) {
  trendlineForBot.invalidate(symbol, timeframe);
  // Also clear in-memory status cache for any bot with this symbol+tf
  // (we don't have botId here so scan will rebuild on next tick — acceptable)
  _trendlineStatusCache.clear();
}