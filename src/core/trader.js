'use strict';

const Decimal = require('decimal.js');
const binanceRest = require('../binance/binanceRest');
const symbolInfo = require('../binance/symbolInfo');
const fees = require('../binance/fees');
const klineCache = require('../services/klineCache');
const eventBus = require('../services/eventBus');
const signalEngine = require('./signalEngine');
const indicators = require('./indicators'); // FIX-2026-08-01: needed by signalEngine.checkSafeTrade (ema)
const volatilityScanner = require('./volatilityScanner');
const dps = require('./dynamicPositionSizing'); // FIX-2026-08-08: Feature #1 — Dynamic Position Sizing
const cbAutoUnlock = require('./cbAutoUnlock'); // FIX-2026-08-08: Feature #3 — Auto Unlock Cooldown
const cbVersion = require('./cbVersion'); // FIX-2026-08-08: Feature #2 — CB Version routing (v2 vs v3)
const cbPatternEvaluator = require('./cbPatternEvaluator'); // FIX-2026-08-09: canonical REST window + 2-tick confirmation
const cbCrossCooldown = require('./cbCrossCooldown'); // FIX-2026-08-10: CBv5 cross-version cooldown interaction (Direction A/B)
const masterConfig = require('./masterConfig'); // FIX-2026-08-08: master toggles (DPS, CB Auto-Unlock)
const telegramNotifier = require('../services/telegramNotifier');
const logger = require('../utils/logger');
const Bot = require('../db/models/Bot');
const Trade = require('../db/models/Trade');
const Signal = require('../db/models/Signal');

// FIX-2026-08-01 (audit H1/R4): CB fire-suppression window
//   - หลัง CB panic-close สำเร็จ ห้ามเปิด BUY ใหม่เป็นเวลา N ms
//   - กัน race: onCandleClosed CB fires (force-close) + S1 BUY on same candle
//   - default 5 minutes (300_000 ms) — ให้เวลา panic-sell dust settle + กัน FOMO re-entry
const CB_SUPPRESS_MS = 5 * 60 * 1000;

// FIX-2026-08-07: CBv2 cooldown duration (HYBRID mode — replaces short CBV2_SUPPRESS_MS)
//   - ใช้ bot.cbv2LockHours (user-configurable, default 8) แปลงเป็น ms แบบ dynamic ใน placeBuy
//   - เดิม: short 30s suppression + bot.enabled=false (lock) → HYBRID: long window + bot ยัง enabled
//   - ค่านี้ไม่ fixed เพราะ duration ขึ้นกับ cbv2LockHours ของบอทนั้น (เปลี่ยนได้ runtime)

/**
 * Trader class — state machine ต่อบอท สำหรับ maker-only BUY → TP SELL
 *
 * States:
 *  - idle: รอ S1 signal บนแท่งล่าสุด
 *  - waiting_buy_fill: วาง BUY แล้ว รอ fill (retry loop)
 *  - holding: มี base asset แล้ว กำลังจะวาง/วาง SELL แล้ว
 *  - waiting_sell_fill: วาง SELL แล้ว รอ fill
 *  - error: เกิดข้อผิดพลาด หยุดชั่วคราว
 *
 * Robustness patches:
 *  - FIX 1: SELL reject → MARKET fallback + holding retry (กัน stranded position)
 *  - FIX 2: cancelAndRecheck คืนค่า + checkBuyOrder handle PARTIALLY_FILLED + defer
 *    เมื่อ cancel/getOrder ไม่แน่ใจ (กัน mark cancelled ทั้งที่ order ยังมีชีวิต)
 *  - FIX 3: WS handler ใช้ Map<clientOrderId, trade> + DB fallback (กัน drop event
 *    ของ trade เก่าหลัง rePlaceBuy)
 *  - FIX 4: Mutex handleBuyFilled (กัน double-SELL จาก WS+retryTimer race)
 *  - FIX 6: makeClientOrderId เพิ่ม random suffix (กัน -2010 Duplicate)
 *  - FIX 7: WS update handle PARTIALLY_FILLED/CANCELED/EXPIRED (กัน silent drop)
 */
class Trader {
  constructor(bot) {
    this.bot = bot;
    this.running = false;
    this.currentTrade = null;
    this.retryCheckTimer = null;
    this.holdingRetryTimer = null;
    this.currentBookTicker = null;
    this.lastSignalIndex = -1; // index ของแท่งที่ S1 ล่าสุดที่เคย trigger แล้ว (กันยิงซ้ำ)

    // FIX 3: Map clientOrderId → trade เพื่อให้ WS update หา trade ที่ถูกต้อง
    // แม้ currentTrade จะถูก replace ไปแล้ว (เช่น หลัง cancel-and-replace)
    this.tradesByClientOrderId = new Map();

    // FIX 4: Mutex per tradeId กัน handleBuyFilled ถูกเรียก 2 ครั้งพร้อมกัน
    this.handleBuyFilledLocks = new Map();

    // FIX-2026-07-21: per-bot BUY cooldown — กันยิง BUY รัวใน 1 วินาที
    //   เคสที่เจอ: reconcileKlines replay หลาย candles → onCandleClosed ยิง 5 BUY ใน 1 วินาที
    //   ทำให้ทุนโดนหักหลายไม้ก่อน SELL ตัวแรกจะ sell ได้ → orphan trade (BUY filled แต่ไม่มีของเหลือ)
    this.lastBuyPlacedAt = 0;            // epoch ms ของ BUY order ล่าสุดที่วางสำเร็จ
    this.buyCooldownMs = 3000;           // อย่างน้อย 3 วินาที ระหว่าง BUY orders
    this.buyInFlight = false;            // กัน onCandleClosed ที่มาพร้อมกัน 2 เส้นทาง (WS + sweep) เข้า placeBuy พร้อมกัน

    // FIX-2026-07-23: partial-fill watcher timer + reconcileAccountBalance throttle
    this.partialFillTimer = null;
    this._lastReconcileBalanceMs = 0;
    // FIX-2026-07-23: deadline tracking for partial-fill finalizer (instance-only, not persisted)
    this.partialFillDeadlineAt = null;
    this._partialFillTradeId = null;
    // FIX-2026-07-30: SELL partial-fill watcher — mirror BUY side (issue: DEXE orphan incident)
    this.sellPartialFillTimer = null;
    this.sellPartialFillDeadlineAt = null;
    this._sellPartialFillTradeId = null;
    // FIX P1.3: explicit init กัน undefined reference
    this.reconcileInFlight = false;
    // FIX P1.5: holding retry counter (instance-level) — กัน retry loop infinite
    this.holdingRetryCount = 0;
    // FIX P2.5: stop-loss check mutex — กัน WS + sweep ยิงพร้อมกัน
    this.stopLossCheckInFlight = false;
    // FIX P2.1: serialized bot:status emit — กัน race ระหว่าง error/idle/selling
    this._statusEmitQueue = Promise.resolve();
    // FIX-2026-07-31 (BUG-14): track startup timers T3/T4 + BUY cooldown timer T5
    //   เดิม: setTimeout แบบไม่ assign handle → ไม่สามารถ clear ใน stop() → timer leak
    //   ถ้า bot.stop() แล้ว timer fires → placeBuy บน stopped bot + ใช้ stale candle
    this.startupSweepTimer = null;
    this.startupBalanceTimer = null;
    this.buyCooldownTimer = null;
    // FIX-2026-08-06 (FIDA incident): tpPercent TTL cache — defense-in-depth กันกรณี bot:updated event ตกหล่น
    //   - primary: bot:updated event (emit จาก tpUpdater / botManager / API routes) → _botUpdatedHandler refresh this.bot
    //   - secondary: ทุก 5s _computeTp() จะเช็คว่า this.bot.tpPercent เก่าเกิน TTL หรือไม่
    //     ถ้าเก่า → re-read จาก DB (เฉพาะ tpPercent-related fields) แล้ว update this.bot
    //   - ทำให้แม้ event bus มีปัญหา TP ก็ sync ภายใน ≤5s
    //   - เก็บ cache time per-field เพื่อให้ selective refresh (ไม่ re-fetch ทั้ง doc)
    this._tpCacheAt = 0;
    this._tpCacheFields = {}; // { tpPercent, tpTrendEnabled, tpTrendMultiplier, tpOnFloor, updateTpAt }
    this._tpCacheTtlMs = 5000; // 5s — balance between freshness + DB load
  }

  // ─── FIX P2.1: serialized bot:status emit ──────────────────────────
  //   กัน race ระหว่าง error/idle/selling emit ที่อาจมาพร้อมกัน
  //   - ทุก status change ต้องผ่าน helper นี้เพื่อให้ DB update + emit เป็น sequential
  //   - ถ้าเปลี่ยน status หลายครั้งใน hot path → จะเรียงตามลำดับ ไม่ข้าม
  _setBotStatus(status, { lastError = null, extra = {} } = {}) {
    const update = { status, ...extra };
    if (lastError !== null) update.lastError = lastError;
    // chain ต่อ queue — Promise.resolve() เป็น resolved เสมอ แต่ละ call จะรอ call ก่อนหน้า
    this._statusEmitQueue = this._statusEmitQueue
      .catch(() => {}) // swallow error จาก previous call
      .then(async () => {
        try {
          await Bot.updateOne({ _id: this.bot._id }, { $set: update });
          // mirror local state เพื่อให้ onCandleClosed check this.bot.status เห็นค่าล่าสุด
          this.bot.status = status;
          if (lastError !== null) this.bot.lastError = lastError;
          eventBus.emit('bot:status', { botId: this.bot._id, status });
        } catch (err) {
          logger.warn({ err: err.message, botId: this.bot._id.toString(), status }, 'trader: _setBotStatus failed');
        }
      });
    return this._statusEmitQueue;
  }

  // ─── Lifecycle ─────────────────────────────────────
  start() {
    this.running = true;
    logger.info({ botId: this.bot._id.toString(), symbol: this.bot.symbol, tf: this.bot.timeframe }, 'trader start');

    // subscribe WS streams
    eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });

    // FIX-2026-07-15: restore lastSignalCloseTime from DB → populate lastSignalIndex using cached klines
    //   (กัน WS missed kline:closed ตอน bot start — replay candle ที่ close ไปแล้วและยังไม่ process)
    if (this.bot.lastSignalCloseTime) {
      const klines = klineCache.getAll(this.bot.symbol, this.bot.timeframe);
      if (klines.length > 0) {
        const idx = klines.findIndex((k) => k.closeTime === this.bot.lastSignalCloseTime);
        this.lastSignalIndex = idx >= 0 ? idx : (klines.length - 1);
        logger.info({
          botId: this.bot._id.toString(),
          lastSignalCloseTime: this.bot.lastSignalCloseTime,
          restoredIdx: this.lastSignalIndex,
          klineCount: klines.length,
        }, 'trader: lastSignalIndex restored from DB');
      }
    }

    // FIX-2026-07-15: schedule periodic "kline sweep" to catch missed closes (WS gap safety net)
    //   - ดึง latest 5 candles จาก REST every SWEEP_INTERVAL_MS
    //   - ถ้า candle.closeTime > lastSignalCloseTime → เรียก onCandleClosed() ทันที
    //   - guard sweepInFlight กัน overlap
    this.sweepTimer = null;
    this.sweepInFlight = false;
    this.sweepTimer = setInterval(() => {
      if (!this.running || this.sweepInFlight) return;
      this.sweepInFlight = true;
      this.reconcileKlines('periodic-sweep')
        .catch((err) => logger.warn({ err: err.message }, 'trader: periodic sweep failed'))
        .finally(() => { this.sweepInFlight = false; });
    }, SWEEP_INTERVAL_MS);

    // FIX-2026-07-31 (BUG-9): periodic reconcileAccountBalance — previously fired only on startup
    //   (one-shot L166) so SELL-orphan cross-check + balance reconciliation never ran after first
    //   4s post-start. Now runs every 15min per bot (FIX-2026-08-04: 5min → 15min เพื่อลด Binance account API load).
    //   - logic เดิม 100% — reconcileAccountBalance() ยังทำงานเหมือนเดิม
    //   - orphan detection ยังครบถ้วน แค่ห่างขึ้น
    this.reconcileBalanceTimer = null;
    this._reconcileBalanceInFlight = false;
    const RECONCILE_BALANCE_MS = 15 * 60 * 1000;
    this.reconcileBalanceTimer = setInterval(() => {
      if (!this.running || this._reconcileBalanceInFlight) return;
      this._reconcileBalanceInFlight = true;
      this.reconcileAccountBalance({ force: false })
        .catch((err) => logger.warn({ err: err.message }, 'trader: periodic reconcileAccountBalance failed'))
        .finally(() => { this._reconcileBalanceInFlight = false; });
    }, RECONCILE_BALANCE_MS);

    // FIX-2026-07-15: also reconcile on WS reconnect (immediate catch-up vs 90s sweep wait)
    this._marketReconnectHandler = () => {
      // เล็กน้อย debounce กัน reconnect storm (Binance อาจ reconnect หลายรอบ)
      if (this._marketReconnectDebounce) clearTimeout(this._marketReconnectDebounce);
      this._marketReconnectDebounce = setTimeout(() => {
        if (!this.running) return;
        this.reconcileKlines('ws-reconnect').catch((err) =>
          logger.warn({ err: err.message }, 'trader: ws-reconnect sweep failed')
        );
      }, 500);
    };
    eventBus.on('market:reconnected', this._marketReconnectHandler);

    // FIX-2026-07-31: F1 auto-arm SL-on-UKC state (mutex per candle)
    this._autoArmInFlight = false;
    // FIX-2026-07-31: F2 TP trend multiplier state (60s cache)
    this._tpTrendCache = { at: 0, trendState: null, trendTF: null };
    this._tpTrendInFlight = false;
    // FIX-2026-08-01 (audit H1/R4): CB fire-suppression gate
    //   - timestamp of last successful CB panic-close (Date.now() ms)
    //   - placeBuy consults this to skip new BUY for CB_SUPPRESS_MS after a panic-close
    //   - prevents S1 BUY on the SAME candle that triggered CB (race in onCandleClosed)
    this._cbFiredAt = 0;
    // FIX-2026-08-01: restore cbLastFiredAt from DB → continue suppression across bot restart
    // FIX-2026-08-09: NaN guard — new Date(undefined).getTime() returns NaN → gate bypass risk
    if (this.bot.cbLastFiredAt) {
      const restoredAt = new Date(this.bot.cbLastFiredAt).getTime();
      if (Number.isFinite(restoredAt)) {
        this._cbFiredAt = restoredAt;
        logger.info({
          botId: this.bot._id.toString(),
          cbLastFiredAt: this.bot.cbLastFiredAt,
          restoredAt,
        }, 'trader: cbLastFiredAt restored from DB → suppression continues');
      } else {
        logger.warn({
          botId: this.bot._id.toString(),
          cbLastFiredAt: this.bot.cbLastFiredAt,
          cbLastFiredAtType: typeof this.bot.cbLastFiredAt,
        }, 'trader: cbLastFiredAt invalid (NaN/Infinity) — _cbFiredAt reset to 0');
      }
    }
    // FIX-2026-08-07: CBv2 cooldown gate (HYBRID — replaces 30s suppression with cbv2LockHours window)
    //   - timestamp of last CBv2 fire (Date.now() ms) — placeBuy consults (now - _cbv2FiredAt) < cbv2LockHours*3600000
    //   - prevents S1 BUY during the cooldown window after a CBv2 force-close
    //   - HYBRID: bot stays enabled, Auto-pause still works — _cbv2FiredAt is the only gate
    //   - restore from bot.cbv2LastFiredAt across restart (cross-restart continuity)
    // FIX-2026-08-09: NaN guard — new Date(undefined).getTime() returns NaN → gate bypass risk
    //   - mirror cbCooldownGate.evaluateCbCooldown behavior
    this._cbv2FiredAt = 0;
    if (this.bot.cbv2LastFiredAt) {
      const restoredAt = new Date(this.bot.cbv2LastFiredAt).getTime();
      if (Number.isFinite(restoredAt)) {
        this._cbv2FiredAt = restoredAt;
        logger.info({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          cbv2LastFiredAt: this.bot.cbv2LastFiredAt,
          restoredAt,
          cbv2LockedUntil: this.bot.cbv2LockedUntil,
        }, 'trader: cbv2LastFiredAt restored from DB → suppression continues');
      } else {
        logger.warn({
          botId: this.bot._id.toString(),
          cbv2LastFiredAt: this.bot.cbv2LastFiredAt,
          cbv2LastFiredAtType: typeof this.bot.cbv2LastFiredAt,
        }, 'trader: cbv2LastFiredAt invalid (NaN/Infinity) — _cbv2FiredAt reset to 0');
      }
    }

    // FIX-2026-08-08: Feature #2 — CBv3 cooldown gate (mirror CBv2 schema)
    //   - CBv3 = CBv2 + ST3 no-trade pattern match on upper-TF (TREND_TF_MAP)
    //   - active version resolved lazily via cbVersion.getActiveVersion() — AppConfig.cbVersion
    //   - only consulted in placeBuy IF cbVersion === 'v3' (mutually exclusive with CBv2)
    //   - restore from bot.cbv3LastFiredAt across restart (parallel to CBv2)
    // FIX-2026-08-09: NaN guard + startup log
    this._cbv3FiredAt = 0;
    if (this.bot.cbv3LastFiredAt) {
      const restoredAt = new Date(this.bot.cbv3LastFiredAt).getTime();
      if (Number.isFinite(restoredAt)) {
        this._cbv3FiredAt = restoredAt;
        logger.info({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          cbv3LastFiredAt: this.bot.cbv3LastFiredAt,
          restoredAt,
          cbv3LockedUntil: this.bot.cbv3LockedUntil,
        }, 'trader: cbv3LastFiredAt restored from DB → suppression continues');
      } else {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          cbv3LastFiredAt: this.bot.cbv3LastFiredAt,
          cbv3LastFiredAtType: typeof this.bot.cbv3LastFiredAt,
        }, 'trader: cbv3LastFiredAt invalid (NaN/Infinity) — _cbv3FiredAt reset to 0');
      }
    }

    // FIX-2026-08-10: CBv5 cooldown gate (Support Zone + Deepest Low + Volume Filter)
    //   - INDEPENDENT of cbVersion enum — CBv5 always runs in parallel if bot.cbv5Enabled !== false
    //   - CBv5 fires when close < lowerKC + close < deepest pivot low + bearish + volume spike
    //   - HYBRID mode: force-close + cooldown BUY cbv5LockHours hours, bot stays enabled
    //   - restore from bot.cbv5LastFiredAt across restart (parallel to CBv2/CBv3)
    // FIX-2026-08-10: NaN guard (mirror CBv3 pattern)
    this._cbv5FiredAt = 0;
    if (this.bot.cbv5LastFiredAt) {
      const restoredAt = new Date(this.bot.cbv5LastFiredAt).getTime();
      if (Number.isFinite(restoredAt)) {
        this._cbv5FiredAt = restoredAt;
        logger.info({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          cbv5LastFiredAt: this.bot.cbv5LastFiredAt,
          restoredAt,
          cbv5LockedUntil: this.bot.cbv5LockedUntil,
        }, 'trader: cbv5LastFiredAt restored from DB → suppression continues');
      } else {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          cbv5LastFiredAt: this.bot.cbv5LastFiredAt,
          cbv5LastFiredAtType: typeof this.bot.cbv5LastFiredAt,
        }, 'trader: cbv5LastFiredAt invalid (NaN/Infinity) — _cbv5FiredAt reset to 0');
      }
    }

    // FIX-2026-08-02: DCA mode startup reconciliation
    //   - load active DCA stack → set this.currentTrade + register
    //   - verify Binance SELL order → sync state (FILLED → handleSellFilled, PARTIALLY_FILLED → handleSellPartialFill, CANCELED/EXPIRED → holding)
    //   - block new S1 signals until reconciliation completes (via setImmediate)
    if (this._isDcaMode()) {
      setImmediate(() => {
        this._reconcileDcaStackOnStart().catch((err) =>
          logger.warn({ err: err.message }, 'trader: _reconcileDcaStackOnStart failed'));
      });
    }

    // FIX-2026-07-15: startup sweep — catch up missed closes ถ้า bot เพิ่ง restart
    //   (รอ 2s ให้ klineCache warm-up เสร็จก่อน)
    // FIX-2026-07-31 (BUG-14): track handles (T3 = 2s startup sweep, T4 = inner 4s balance)
    this.startupSweepTimer = setTimeout(() => {
      this.startupSweepTimer = null; // mark fired
      if (!this.running) return;
      this.reconcileKlines('startup').catch((err) =>
        logger.warn({ err: err.message }, 'trader: startup sweep failed')
      );
      // FIX-2026-07-23: หลัง startup sweep ตรวจ Binance balance ของบอทนี้
      //   ถ้ามี base asset ค้างโดยไม่มี active trade → log orphan + sync BUY order ที่ยังมีชีวิต
      this.startupBalanceTimer = setTimeout(() => {
        this.startupBalanceTimer = null; // mark fired
        if (!this.running) return;
        this.reconcileAccountBalance({ force: true }).catch((err) =>
          logger.warn({ err: err.message }, 'trader: startup reconcileAccountBalance failed')
        );
      }, 4000);
    }, 2000);

    // FIX-2026-07-31 (BUG-19): re-arm partial-fill watchers for trades with persisted deadlines
    //   เดิม: partialFillDeadlineAt/sellPartialDeadlineAt persist ใน DB แต่ restore เฉพาะในตัว timer
    //   (checkPartialFill/checkSellPartialFill) — ถ้า timer ไม่ได้รัน (restart) → deadline ตาย
    //   ใหม่: ใน start() ดึง trade ที่ยังมี deadline ในอนาคต → เรียก schedulePartialFillWatch/scheduleSellPartialFillWatch
    //   (หลัง startup sweep ให้ reconcileKlines/processBUY-fill cycle เสร็จก่อน ไม่งั้น race)
    setImmediate(() => {
      if (!this.running) return;
      this._rearmPersistedPartialFillWatchers().catch((err) =>
        logger.warn({ err: err.message }, 'trader: _rearmPersistedPartialFillWatchers failed')
      );
    });

    // bookTicker handler — เก็บ bid ล่าสุด
    this._bookTickerHandler = (t) => {
      if (t.symbol === this.bot.symbol) this.currentBookTicker = t;
    };
    eventBus.on('bookTicker', this._bookTickerHandler);

    // kline:closed handler
    this._klineHandler = (payload) => {
      if (payload.symbol !== this.bot.symbol || payload.timeframe !== this.bot.timeframe) return;
      this.onCandleClosed(payload.candle);
    };
    eventBus.on('kline:closed', this._klineHandler);

    // FIX-2026-08-01 (CRITICAL-BUG-1): CB direct kline:closed subscription
    //   - bypass onCandleClosed gate (lastSignalIndex check at L1105) which can
    //     short-circuit non-S1 candles and skip CB entirely
    //   - COTI incident (12:15-12:42 ICT 2026-08-01): CB never fired
    //   - mirror the _klineHandler pattern but independent of S1 flow
    this._cbKlineHandler = (payload) => {
      if (!this.running) return;
      if (!payload || !payload.candle) return;
      if (payload.symbol !== this.bot.symbol || payload.timeframe !== this.bot.timeframe) return;
      this._checkCBPanicClose(payload.candle).catch((err) =>
        logger.error({ err: err.message, stack: err.stack }, 'trader: CB direct handler threw'));
    };
    eventBus.on('kline:closed', this._cbKlineHandler);

    // FIX-2026-08-06: CBv2 direct kline:closed subscription (mirror CB pattern)
    //   - เรียก _checkCBv2PanicClose ทุก candle → strict pattern (4 red candles below lowerKC)
    //   - on fire: force-close + lock bot cbv2LockHours hours + emit bot:locked
    this._cbv2KlineHandler = (payload) => {
      if (!this.running) return;
      if (!payload || !payload.candle) return;
      if (payload.symbol !== this.bot.symbol || payload.timeframe !== this.bot.timeframe) return;
      this._checkCBv2PanicClose(payload.candle).catch((err) =>
        logger.error({ err: err.message, stack: err.stack }, 'trader: CBv2 direct handler threw'));
    };
    eventBus.on('kline:closed', this._cbv2KlineHandler);

    // FIX-2026-08-08: Feature #2 — CBv3 direct kline:closed subscription (mirror CBv2 pattern)
    //   - CBv3 = CBv2 + ST3 no-trade pattern match on upper-TF (TREND_TF_MAP)
    //   - active version resolved lazily via cbVersion.getActiveVersion()
    //   - on fire: force-close + lock bot cbv3LockHours hours + emit bot:cooldown with version='v3'
    //   - mutually exclusive with CBv2 (user picks one in Settings) — handler is always installed,
    //     but _checkCBv3PanicClose returns early if cbVersion !== 'v3'
    this._cbv3KlineHandler = (payload) => {
      if (!this.running) return;
      if (!payload || !payload.candle) return;
      if (payload.symbol !== this.bot.symbol || payload.timeframe !== this.bot.timeframe) return;
      this._checkCBv3PanicClose(payload.candle).catch((err) =>
        logger.error({ err: err.message, stack: err.stack }, 'trader: CBv3 direct handler threw'));
    };
    eventBus.on('kline:closed', this._cbv3KlineHandler);

    // FIX-2026-08-10: CBv5 direct kline:closed subscription (Support Zone + Deepest Low + Volume)
    //   - INDEPENDENT of cbVersion enum — runs in parallel with CBv2 or CBv3 (no version gate)
    //   - on fire: force-close + lock bot cbv5LockHours hours + emit bot:cooldown with version='v5'
    //   - handler is always installed; _checkCBv5PanicClose returns early if cbv5Enabled === false
    //   - cbCrossCooldown handles Direction A/B interaction with CBv2/CBv3
    this._cbv5KlineHandler = (payload) => {
      if (!this.running) return;
      if (!payload || !payload.candle) return;
      if (payload.symbol !== this.bot.symbol || payload.timeframe !== this.bot.timeframe) return;
      this._checkCBv5PanicClose(payload.candle).catch((err) =>
        logger.error({ err: err.message, stack: err.stack }, 'trader: CBv5 direct handler threw'));
    };
    eventBus.on('kline:closed', this._cbv5KlineHandler);

    // FIX-2026-08-08: Feature #3 — Auto Unlock Cooldown on candle close (independent of SELL fill)
    //   - bug-fix: cbAutoUnlock.evaluate() was inside handleSellFilled (deadlock — bot in cooldown
    //     suppresses new BUYs → no new SELL → never evaluated → permanent lock)
    //   - new flow: on every kline:closed (matching bot symbol+TF), check cooldown state + scan
    //     signals since last CB fire. If 3+ profitable signals → unlock immediately.
    //   - mutex _cbAutoUnlockInFlight กัน concurrent invocations across candles
    this._cbAutoUnlockKlineHandler = (payload) => {
      if (!this.running) return;
      if (!payload || !payload.candle) return;
      if (payload.symbol !== this.bot.symbol || payload.timeframe !== this.bot.timeframe) return;
      this._evaluateAutoUnlockOnCandle(payload.candle).catch((err) =>
        logger.error({ err: err.message, botId: this.bot._id.toString() }, 'trader: cbAutoUnlock handler threw'));
    };
    eventBus.on('kline:closed', this._cbAutoUnlockKlineHandler);

    // FIX 3 + FIX-2026-07-13: order update handler ใช้ Map lookup + DB fallback
    // (FIX-2026-07-13: _registerTrade บางที register แค่ {buyClientOrderId, sellClientOrderId}
    //  → trade snapshot ไม่มี buyPrice → handleSellFilled pnl.net=NaN → DB ไม่อัปเดต
    //  แก้โดยเช็ค trade.buyPrice ก่อน — ถ้าไม่มีก็ re-fetch จาก DB เพื่อให้ได้ full doc)
    this._orderHandler = async (update) => {
      // FIX-2026-07-31 (BUG-16): running check — WS events continue after stop() otherwise
      if (!this.running) return;
      if (update.symbol !== this.bot.symbol) return;
      const c = update.clientOrderId || '';
      if (!c) return;

      // Fast path: in-memory map (อาจเป็น partial doc จาก _registerTrade minimal)
      let trade = this.tradesByClientOrderId.get(c);

      // FIX-2026-07-13: full doc จำเป็นต้องมี buyPrice สำหรับ handleSellFilled → ถ้า Map hit แต่ doc ไม่มี buyPrice → re-fetch
      if (trade && (trade.buyPrice == null || trade.buyPrice === undefined)) {
        trade = null;
      }

      // Fallback: DB lookup (กรณี restart, trade จาก round ก่อนหน้า, หรือ fast path เป็น partial doc)
      if (!trade) {
        try {
          trade = await Trade.findOne({
            botId: this.bot._id,
            $or: [{ buyClientOrderId: c }, { sellClientOrderId: c }],
          }).lean();
        } catch (err) {
          logger.warn({ err: err.message, c }, 'trader: order handler DB lookup failed');
          return;
        }
      }
      if (!trade) return;

      // Dispatch ตาม clientOrderId — ไม่พึ่ง currentTrade
      if (trade.buyClientOrderId === c) {
        await this.onBuyOrderUpdate(update, trade);
      } else if (trade.sellClientOrderId === c) {
        await this.onSellOrderUpdate(update, trade);
      }
    };
    eventBus.on('order:update', this._orderHandler);

    // FIX-2026-07-24: subscribe bot:updated เพื่อ refresh this.bot (kcMult, s1OnlyDown, minSpreadTicks, ...)
    //   - ปัญหา: เมื่อ user แก้ค่าใน UI ตอนบอท run อยู่ บอทไม่ reload (cache this.bot ตอน spawn)
    //     → mini chart เห็นสัญญาณ (ที่ใช้ค่าใหม่จาก API ตอน page load) ก่อนบอท 3 นาที
    //   - fix: ผูก bot:updated → fetch fresh this.bot แล้ว assign กลับ
    //     จุดใช้งาน (kcMult, s1OnlyDown, minSpreadTicks) จะเห็นค่าใหม่รอบถัดไป
    this._botUpdatedHandler = async ({ botId } = {}) => {
      if (!botId || String(botId) !== String(this.bot._id)) return;
      try {
        const fresh = await Bot.findById(this.bot._id).lean();
        if (!fresh) return;
        // FIX-2026-07-24: refresh เฉพาะ tunable fields (ไม่แตะ status/currentTrade เพราะจัดการใน hot path)
        // FIX P2.2: ใช้ **blacklist** แทน whitelist — refresh ทุก field ยกเว้น hot-path state
        //   เดิม whitelist = 13 fields → ถ้า dev เพิ่ม field ใหม่แล้วลืม update array = bug
        //   fix: blacklist เฉพาะ fields ที่ต้อง preserve (status, currentTrade, lastSignalCloseTime, etc.)
        const preservedKeys = ['_id', 'status', 'lastSignalCloseTime', 'lastSignalAt', 'totalPnl', 'totalTrades', 'winTrades', 'lastError', 'createdAt', 'updatedAt', '__v', 'cbLastFiredAt', 'cbv2LastFiredAt']; // FIX-2026-08-06: add cbv2LastFiredAt to preserve CBv2 suppression across bot:updated refresh
        for (const k of Object.keys(fresh)) {
          if (preservedKeys.includes(k)) continue;
          if (k in this.bot) {
            // refresh field ที่อยู่ใน instance แล้ว
            this.bot[k] = fresh[k];
          }
        }
        logger.info({
          botId: this.bot._id.toString(),
          kcMult: this.bot.kcMult,
          s1OnlyDown: this.bot.s1OnlyDown,
          minSpreadTicks: this.bot.minSpreadTicks,
          // FIX-2026-08-06: include tpPercent for visibility (FIDA incident — bot:tp-updated must propagate)
          tpPercent: this.bot.tpPercent,
          tpTrendMultiplier: this.bot.tpTrendMultiplier,
          tpTrendEnabled: this.bot.tpTrendEnabled,
          tpOnFloor: this.bot.tpOnFloor,
        }, 'trader: bot config refreshed from bot:updated event');
      } catch (err) {
        logger.warn({ err: err.message, botId: this.bot._id.toString() }, 'trader: bot:updated refresh failed');
      }
    };
    eventBus.on('bot:updated', this._botUpdatedHandler);
  }

  async stop() {
    this.running = false;
    if (this.retryCheckTimer) {
      clearTimeout(this.retryCheckTimer);
      this.retryCheckTimer = null;
    }
    if (this.holdingRetryTimer) {
      clearTimeout(this.holdingRetryTimer);
      this.holdingRetryTimer = null;
    }
    // FIX-2026-07-15: clear sweep timer + reconnect debounce
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this._marketReconnectDebounce) {
      clearTimeout(this._marketReconnectDebounce);
      this._marketReconnectDebounce = null;
    }
    // FIX-2026-07-30: clear SELL partial-fill watcher timer
    if (this.sellPartialFillTimer) {
      clearTimeout(this.sellPartialFillTimer);
      this.sellPartialFillTimer = null;
    }
    // FIX-2026-07-31 (BUG-6): clear BUY partial-fill watcher timer (was leaking — checkPartialFill
    //   would fire after stop() and place real BUY/SELL orders on a stopped bot).
    if (this.partialFillTimer) {
      clearTimeout(this.partialFillTimer);
      this.partialFillTimer = null;
    }
    // FIX-2026-07-31 (BUG-9 / FIX-C3): clear periodic reconcile-balance interval
    if (this.reconcileBalanceTimer) {
      clearInterval(this.reconcileBalanceTimer);
      this.reconcileBalanceTimer = null;
    }
    // FIX-2026-07-31 (BUG-14): clear startup timers (T3/T4) + BUY cooldown timer (T5)
    //   เดิม: setTimeout แบบไม่ assign handle → restart-cycle ของ bot
    //   (spawnTrader → stopTrader → spawnTrader) ทำให้ timer ค้างรัน reorder ที่อาจไม่ตรง state
    if (this.startupSweepTimer) {
      clearTimeout(this.startupSweepTimer);
      this.startupSweepTimer = null;
    }
    if (this.startupBalanceTimer) {
      clearTimeout(this.startupBalanceTimer);
      this.startupBalanceTimer = null;
    }
    if (this.buyCooldownTimer) {
      clearTimeout(this.buyCooldownTimer);
      this.buyCooldownTimer = null;
    }
    if (this._bookTickerHandler) eventBus.off('bookTicker', this._bookTickerHandler);
    if (this._klineHandler) eventBus.off('kline:closed', this._klineHandler);
    if (this._cbKlineHandler) eventBus.off('kline:closed', this._cbKlineHandler);
    if (this._cbv2KlineHandler) eventBus.off('kline:closed', this._cbv2KlineHandler); // FIX-2026-08-06
    if (this._cbv3KlineHandler) eventBus.off('kline:closed', this._cbv3KlineHandler); // FIX-2026-08-08: CBv3 handler
    if (this._cbv5KlineHandler) eventBus.off('kline:closed', this._cbv5KlineHandler); // FIX-2026-08-10: CBv5 handler
    if (this._cbAutoUnlockKlineHandler) eventBus.off('kline:closed', this._cbAutoUnlockKlineHandler); // FIX-2026-08-08: auto-unlock handler
    if (this._orderHandler) eventBus.off('order:update', this._orderHandler);
    if (this._marketReconnectHandler) eventBus.off('market:reconnected', this._marketReconnectHandler);
    if (this._botUpdatedHandler) eventBus.off('bot:updated', this._botUpdatedHandler);
    this._cbKlineHandler = null;
    this._cbv2KlineHandler = null; // FIX-2026-08-06
    this._cbv3KlineHandler = null; // FIX-2026-08-08: CBv3 handler
    this._cbv5KlineHandler = null; // FIX-2026-08-10: CBv5 handler
    this._cbAutoUnlockKlineHandler = null; // FIX-2026-08-08: auto-unlock handler
    this.tradesByClientOrderId.clear();
    this.handleBuyFilledLocks.clear();
    // FIX-2026-08-06: reset TP cache flags so a respawned trader doesn't inherit stale values
    this._tpCacheAt = 0;
    this._tpCacheInFlight = false;
    logger.info({ botId: this.bot._id.toString() }, 'trader stopped');
    eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
  }

  // ─── FIX 3 helpers: register/unregister trade ใน Map ────
  _registerTrade(trade) {
    if (!trade) return;
    if (trade.buyClientOrderId) this.tradesByClientOrderId.set(trade.buyClientOrderId, trade);
    if (trade.sellClientOrderId) this.tradesByClientOrderId.set(trade.sellClientOrderId, trade);
  }

  _unregisterTrade(trade) {
    if (!trade) return;
    if (trade.buyClientOrderId) this.tradesByClientOrderId.delete(trade.buyClientOrderId);
    if (trade.sellClientOrderId) this.tradesByClientOrderId.delete(trade.sellClientOrderId);
  }

  // FIX-2026-08-02: cancel any leftover SELL orders on Binance before declaring trade "dead"
  //   - Root cause of DEXE orphan SELL incident 2026-08-02: handleBuyOrderUpdate PARTIALLY_FILLED
  //     branch placed SELL for the filled qty, then race set trade.state='cancelled' and
  //     this.currentTrade=null — but the SELL order stayed LIVE on Binance.
  //   - Defensive cancel: try (1) trade.sellOrderId from doc, (2) any open SELL orders on
  //     this symbol that match this trade's qty. Best-effort — emit trade:orphan on failure
  //     so the recover-orphan-trades.js script (or manual op) can clean up.
  //   - Returns { cancelled: number, failed: number, orphans: array }
  async _cancelOrphanedSells(trade, { reason = 'unspecified', ctx = null } = {}) {
    const result = { cancelled: 0, failed: 0, errors: [], orphans: [] };
    if (!trade) return result;
    if (!this.bot || !this.bot.symbol) return result;

    // Build list of SELL orderIds to try cancelling
    const candidates = new Set();
    if (trade.sellOrderId) candidates.add(trade.sellOrderId);
    if (trade.sellOrderIds && Array.isArray(trade.sellOrderIds)) {
      for (const id of trade.sellOrderIds) if (id) candidates.add(id);
    }

    if (candidates.size > 0) {
      for (const orderId of candidates) {
        try {
          const r = await binanceRest.cancelOrder({ symbol: this.bot.symbol, orderId });
          if (r && r.status === 'CANCELED') {
            result.cancelled += 1;
            logger.info({
              botId: this.bot._id.toString(),
              tradeId: trade._id && trade._id.toString(),
              symbol: this.bot.symbol,
              orderId,
              reason, ctx,
            }, 'trader: _cancelOrphanedSells — cancelled');
          } else if (r && (r.status === 'NEW' || r.status === 'PARTIALLY_FILLED')) {
            // -2011 "Unknown order" or order already filled → not an orphan, just be silent
            logger.info({
              botId: this.bot._id.toString(),
              symbol: this.bot.symbol,
              orderId, status: r.status,
              reason,
            }, 'trader: _cancelOrphanedSells — already state, skip');
          } else {
            result.failed += 1;
            result.errors.push({ orderId, status: r && r.status, err: r && r.error });
            result.orphans.push({ orderId, candidate: 'sellOrderId' });
          }
        } catch (err) {
          // -2011 "Unknown order" → already gone → silent
          const msg = (err && err.message) || String(err);
          if (/2011|Unknown order|already cancelled|UNKNOWN_ORDER/i.test(msg)) {
            logger.info({ botId: this.bot._id.toString(), orderId, msg }, 'trader: _cancelOrphanedSells — already gone');
          } else {
            result.failed += 1;
            result.errors.push({ orderId, err: msg });
            result.orphans.push({ orderId, candidate: 'sellOrderId', err: msg });
            logger.warn({
              botId: this.bot._id.toString(),
              tradeId: trade._id && trade._id.toString(),
              orderId, err: msg, reason,
            }, 'trader: _cancelOrphanedSells — cancel failed');
          }
        }
      }
    }

    // Defensive: scan Binance open orders on this symbol for any SELL that matches this trade's qty
    //   - เผื่อ trade.sellOrderId ว่างแต่ Binance มี SELL ค้างจาก path อื่น
    //   - Only do this for SELL-side cancel paths (where we KNOW SELL was placed); skip for BUY-only
    //     cancel paths to avoid cancelling unrelated SELLs from previous trades
    //   - Heuristic: SELL price >= trade.buyPrice (sell above buy)
    if (reason && /partial|abort|cancel|orphan/i.test(reason)) {
      try {
        const openOrders = await binanceRest.getOpenOrders({ symbol: this.bot.symbol }).catch(() => []);
        const buyPrice = parseFloat(trade.buyPrice);
        const buyQty = parseFloat(trade.buyQty);
        const candidatesQty = result.orphans.length > 0 ? null : buyQty; // only scan if not already cancelled
        for (const o of (openOrders || [])) {
          if (o.side !== 'SELL') continue;
          const oQty = parseFloat(o.origQty || o.quantity || 0);
          const oPrice = parseFloat(o.price || 0);
          const matchQty = !candidatesQty || Math.abs(oQty - candidatesQty) / Math.max(candidatesQty, 1e-12) < 0.01;
          const matchPrice = !buyPrice || oPrice >= buyPrice * 0.5; // very loose: at least 50% of buy price
          if (matchQty && matchPrice) {
            try {
              const r = await binanceRest.cancelOrder({ symbol: this.bot.symbol, orderId: o.orderId });
              if (r && r.status === 'CANCELED') {
                result.cancelled += 1;
                logger.info({
                  botId: this.bot._id.toString(),
                  tradeId: trade._id && trade._id.toString(),
                  symbol: this.bot.symbol,
                  orderId: o.orderId, qty: oQty, price: oPrice,
                  reason, ctx,
                }, 'trader: _cancelOrphanedSells — defensive cancel');
              }
            } catch (err) {
              const msg = (err && err.message) || String(err);
              if (!/2011|Unknown order|already cancelled|UNKNOWN_ORDER/i.test(msg)) {
                result.failed += 1;
                result.errors.push({ orderId: o.orderId, err: msg });
                result.orphans.push({ orderId: o.orderId, candidate: 'defensive_scan', qty: oQty, price: oPrice, err: msg });
              }
            }
          }
        }
      } catch (err) {
        logger.warn({ botId: this.bot._id.toString(), err: err.message }, 'trader: _cancelOrphanedSells — defensive scan failed');
      }
    }

    // Emit orphan event for any leftover orphans
    if (result.orphans.length > 0) {
      try {
        eventBus.emit('trade:orphan', {
          botId: this.bot._id && this.bot._id.toString(),
          tradeId: trade._id && trade._id.toString(),
          symbol: this.bot.symbol,
          reason,
          orphans: result.orphans,
        });
      } catch (_) { /* non-fatal */ }
    }

    return result;
  }

  // ─── FIX-2026-07-31: F1 auto-arm SL-on-UKC for stuck losing positions ───────
  // เรียกจาก onCandleClosed entry-point (ก่อน CB check)
  //   - gate: bot.autoArmStopLossOnUKC ต้องเปิดอยู่ (per-bot toggle, default true)
  //   - ค้นหา trades ที่ state='selling' + buyFilledAt > autoArmAgeHours ago + loss > autoArmLossPct
  //   - ถ้า match → set trade.useStopLossOnUKC=true (per-trade flag) + snapshot thresholds
  //   - _checkStopLossOnUpperKC ใช้ flag นี้เป็น gate (1D)
  //   - ล้าง flag เมื่อ trade ออกจาก selling (1E)
  // FIX-2026-08-03 (Option B): ลบ M2 config asymmetry guard — F1 arm ทำงานแม้ bot.stopLossOnUpperKC=false
  //   - เดิม audit 2026-08-01 ใส่ guard กัน arm flag ที่ไม่มี trigger → แต่ทำให้ live กับ DCA backtest diverge
  //   - ตอนนี้ _checkStopLossOnUpperKC ใช้ per-trade flag เป็น gate เดียว (ไม่สน global toggle) → live = DCA backtest
  async _autoArmStopLossOnUKC(candle) {
    if (!this.running) return;
    if (!this.bot.autoArmStopLossOnUKC) return; // bot toggle off
    if (this._autoArmInFlight) return;
    this._autoArmInFlight = true;
    try {
      // FIX-2026-08-03: per-bot configurable thresholds (default 4h + 10% to preserve original behavior)
      const lossPct = (this.bot.autoArmLossPct ?? 10) / 100;
      const ageHours = this.bot.autoArmAgeHours ?? 4;
      const ageThresholdAgo = new Date(Date.now() - ageHours * 60 * 60 * 1000);
      const closePrice = parseFloat(candle.close);
      // FIX-2026-07-31: $expr คำนวณ (buyPrice - close) / buyPrice > lossPct ใน DB
      //   - buyPrice > 0 → กัน divide by zero
      //   - index { botId: 1, state: 1 } → match state='selling' filter ได้เร็ว
      // FIX-2026-08-01 (audit H2): state เป็น exact 'selling' (ไม่ใช่ stopping/partial_wait/filled/holding)
      //   - 'stopping' = CB หรือ SL-UKC กำลัง force-close อยู่ → ไม่ arm (race with concurrent close)
      //   - 'partial_wait'/'filled'/'holding' = BUY ยังไม่เสร็จ → ไม่ arm
      //   - exact 'selling' = SELL placed รอ fill → เป็น stuck losing scenario ที่ F1 ต้องการ
      const candidates = await Trade.find({
        botId: this.bot._id,
        state: 'selling',
        useStopLossOnUKC: { $ne: true }, // not yet armed
        buyFilledAt: { $lte: ageThresholdAgo },
        $expr: {
          $and: [
            { $gt: ['$buyPrice', 0] },
            { $gt: [{ $divide: [{ $subtract: ['$buyPrice', closePrice] }, '$buyPrice'] }, lossPct] },
          ],
        },
      }).lean();
      if (candidates.length > 0) {
        const ids = candidates.map(t => t._id);
        // FIX-2026-08-01 (audit M2 from agent 1): tighten updateMany filter
        //   - กัน race: race-loser reset flag → F1 overwrites back to true
        //   - เพิ่ม state filter เพื่อให้แน่ใจว่า state ยังเป็น 'selling' ตอน update commit
        // FIX-2026-08-03: snapshot thresholds ไว้บน trade เพื่อ positionCard.js แสดงผลตรงกับตอน arm (กันเคส user เปลี่ยนค่าทีหลัง)
        await Trade.updateMany(
          { _id: { $in: ids }, state: 'selling', useStopLossOnUKC: { $ne: true } },
          {
            $set: {
              useStopLossOnUKC: true,
              autoArmedAt: new Date(),
              autoArmLossPct: this.bot.autoArmLossPct ?? 10,
              autoArmAgeHours: this.bot.autoArmAgeHours ?? 4,
            },
          }
        );
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          candleClose: closePrice,
          autoArmLossPct: this.bot.autoArmLossPct ?? 10,
          autoArmAgeHours: this.bot.autoArmAgeHours ?? 4,
          armedCount: ids.length,
          tradeIds: ids.map(i => String(i)),
        }, 'trader: auto-arm SL-on-UKC for stuck losing positions');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'trader: auto-arm SL-on-UKC failed');
    } finally {
      this._autoArmInFlight = false;
    }
  }

  // ─── FIX-2026-07-31: F2 TP trend multiplier helper ──────────────────────────
  // คำนวณ trend ของ upper-TF (TREND_TF_MAP) — ใช้ 60s in-process cache
  //   - 'upper' = close > EMA20 → apply คูณ
  //   - 'lower' = close < EMA20 → ไม่คูณ
  //   - 'warmup' = ข้อมูลไม่พอ → ไม่คูณ
  //   - เรียกจาก _handleBuyFilledImpl เท่านั้น (new position only)
  // FIX-2026-08-02: extract _computeTp() helper — single source of truth for TP + fee buffer + trend mult
  //   - was: 4 sites each had their own copy of (tpTrendEnabled gate → _getTrendState → mult → feeRate → calcSellPrice → roundPrice)
  //   - 3 of those 4 sites used `this.bot.tpPercent` directly, skipping trend mult AND fee buffer
  //   - net result: bots were placing SELL at buyPrice × (1 + tp/100) only, missing 2× mult + 0.15% fee buffer
  //   - now: every SELL placement calls this helper → consistent + correct TP targeting
  // FIX-2026-08-06: TTL refresh tpPercent-related fields from DB — defense-in-depth กัน event-bus miss
  //   - primary sync: bot:updated event → _botUpdatedHandler refresh this.bot
  //   - secondary sync: ถ้า this._tpCacheAt ห่างจาก now > 5s → re-read 4 fields (tpPercent, tpTrendEnabled, tpTrendMultiplier, tpOnFloor, updateTpAt)
  //   - DB query ใช้ select แค่ 4 fields เพื่อ minimize load
  async _computeTp({ buyPrice, skipTrend = false } = {}) {
    // FIX-2026-08-06: defense-in-depth refresh — re-read TP fields from DB if cache stale
    await this._refreshTpCacheIfStale();
    const tpTrendEnabled = !skipTrend && this.bot.tpTrendEnabled !== false;
    let effectiveTpPercent = this.bot.tpPercent;
    let trendState = { trendState: 'warmup', trendTF: null };
    if (tpTrendEnabled) {
      trendState = await this._getTrendState();
      const tpTrendMultiplier = Number(this.bot.tpTrendMultiplier);
      effectiveTpPercent = (trendState.trendState === 'upper' && Number.isFinite(tpTrendMultiplier) && tpTrendMultiplier > 1)
        ? this.bot.tpPercent * tpTrendMultiplier
        : this.bot.tpPercent;
    }
    const feeRate = fees.getMakerRate();
    const sellPriceRaw = fees.calcSellPrice({
      buyPrice,
      tpPercent: effectiveTpPercent,
      feeRate,
    });
    const info = symbolInfo.getCached(this.bot.symbol);
    const tickSize = info ? info.priceFilter.tickSize : null;
    const sellPrice = tickSize
      ? symbolInfo.roundPrice(sellPriceRaw, tickSize).toString()
      : sellPriceRaw.toString();
    return {
      tpBase: this.bot.tpPercent,
      tpEffective: effectiveTpPercent,
      trendState: trendState.trendState,
      trendTF: trendState.trendTF,
      tpTrendMultiplier: Number(this.bot.tpTrendMultiplier) || 1,
      tpTrendEnabled,
      feeRate,
      sellPriceRaw,
      sellPrice,
    };
  }

  // FIX-2026-08-06: TTL cache refresh — re-read tpPercent-related fields from DB if cache stale
  //   - triggered from _computeTp() before TP calc
  //   - refresh only 4 fields (cheap select) — preserves all hot-path fields
  //   - idempotent + safe under concurrent calls (in-flight guard)
  async _refreshTpCacheIfStale() {
    if (!this.bot || !this.bot._id) return;
    // FIX-2026-08-06: don't issue DB query after stop() — guard against late _computeTp calls
    if (!this.running) return;
    if (Date.now() - this._tpCacheAt < this._tpCacheTtlMs) return;
    if (this._tpCacheInFlight) return;
    this._tpCacheInFlight = true;
    try {
      const fresh = await Bot.findById(this.bot._id)
        .select('tpPercent tpTrendEnabled tpTrendMultiplier tpOnFloor updateTpAt')
        .lean();
      if (!fresh) return;
      const before = {
        tpPercent: this.bot.tpPercent,
        tpTrendEnabled: this.bot.tpTrendEnabled,
        tpTrendMultiplier: this.bot.tpTrendMultiplier,
        tpOnFloor: this.bot.tpOnFloor,
        updateTpAt: this.bot.updateTpAt,
      };
      let changed = false;
      for (const k of Object.keys(fresh)) {
        if (this.bot[k] !== fresh[k]) {
          this.bot[k] = fresh[k];
          changed = true;
        }
      }
      this._tpCacheAt = Date.now();
      if (changed) {
        logger.info({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          tpPercent: this.bot.tpPercent,
          tpTrendMultiplier: this.bot.tpTrendMultiplier,
          tpTrendEnabled: this.bot.tpTrendEnabled,
          tpOnFloor: this.bot.tpOnFloor,
          before,
        }, 'trader: TP cache refreshed from DB (TTL expired, defense-in-depth)');
      }
    } catch (err) {
      logger.warn({ err: err.message, botId: this.bot._id && this.bot._id.toString() }, 'trader: TP cache refresh failed');
    } finally {
      this._tpCacheInFlight = false;
    }
  }

  // FIX-2026-08-06: SELL slippage helper — เรียกจากทุก SELL-fill path
  //   - target > 0 และ sellPrice > 0 → slip% = (sell - target) / target * 100
  //   - slip < -1% → log warn (เห็นใน logs ทันที)
  //   - slip < -3% → log error + telegram alert (slippageWarning event) — สัญญาณว่า MARKET fallback ทำงานผิดปกติ
  //   - returns slipPct (number) หรือ null ถ้าคำนวณไม่ได้
  //   - safe — try/catch ทุกชั้น, ไม่กระทบ trade finalize path
  _computeSlippage({ sellPrice, targetSellPrice, tradeId, sellReason, pnlPercent }) {
    try {
      if (!Number.isFinite(sellPrice) || !Number.isFinite(targetSellPrice) || targetSellPrice <= 0) {
        return null;
      }
      const slip = ((sellPrice - targetSellPrice) / targetSellPrice) * 100;
      if (slip < -1.0) {
        logger.warn({
          botId: this.bot && this.bot._id && this.bot._id.toString(),
          symbol: this.bot && this.bot.symbol,
          tradeId: tradeId && tradeId.toString(),
          sellReason: sellReason || null,
          sellPrice, targetSellPrice,
          slipPct: slip.toFixed(3),
          pnlPercent,
        }, 'trader: SELL slippage warning — fill below target > 1%');
      }
      if (slip < -3.0) {
        logger.error({
          botId: this.bot && this.bot._id && this.bot._id.toString(),
          symbol: this.bot && this.bot.symbol,
          tradeId: tradeId && tradeId.toString(),
          sellReason: sellReason || null,
          sellPrice, targetSellPrice,
          slipPct: slip.toFixed(3),
          pnlPercent,
        }, 'trader: SELL severe slippage — fill below target > 3%');
        try {
          // FIX-2026-08-06: telegram alert (non-blocking, swallow errors)
          //   - sendNow() = public dispatcher, no need to hold reference
          //   - require แบบ lazy เพราะ telegramNotifier อาจไม่ถูก load ใน test contexts
          const telegramNotifier = require('../services/telegramNotifier');
          telegramNotifier.sendNow('slippageWarning', {
            botName: (this.bot && this.bot.name) || (this.bot && this.bot.symbol) || '?',
            symbol: (this.bot && this.bot.symbol) || '?',
            timeframe: (this.bot && this.bot.timeframe) || null,
            tradeId: tradeId && tradeId.toString(),
            sellReason: sellReason || 'unknown',
            sellPrice,
            targetSellPrice,
            slipPct: Number(slip.toFixed(3)),
            pnlPercent,
          }).catch(() => null);
        } catch (_) { /* telegram not loaded or sendNow missing */ }
      }
      return slip;
    } catch (err) {
      logger.warn({ err: err.message }, 'trader: _computeSlippage failed');
      return null;
    }
  }

  async _getTrendState() {
    if (!this.running) return { trendState: 'warmup' };
    // 60s cache — mirror volatilityForBot CACHE_TTL_MS pattern
    if (Date.now() - this._tpTrendCache.at < 60_000 && this._tpTrendCache.trendState != null) {
      return this._tpTrendCache;
    }
    if (this._tpTrendInFlight) return { trendState: null }; // concurrent skip
    this._tpTrendInFlight = true;
    try {
      const trendTF = volatilityScanner.TREND_TF_MAP && volatilityScanner.TREND_TF_MAP[this.bot.timeframe] || null;
      if (!trendTF) {
        this._tpTrendCache = { at: Date.now(), trendState: 'warmup', trendTF: null };
        return this._tpTrendCache;
      }
      const klines = await binanceRest.getKlines({ symbol: this.bot.symbol, interval: trendTF, limit: 30 });
      this._tpTrendCache = { at: Date.now(), ...volatilityScanner.computeTrend(klines, trendTF) };
      return this._tpTrendCache;
    } catch (err) {
      logger.warn({ err: err.message, symbol: this.bot.symbol, tf: this.bot.timeframe }, 'trader: getTrendState failed');
      return { trendState: 'warmup' };
    } finally {
      this._tpTrendInFlight = false;
    }
  }

  // ─── FIX-2026-08-02: DCA + BEP stack helpers ──────────────────────────────
  // ใช้เฉพาะเมื่อ this.bot.dcaEnabled === true (single-stack mode)
  //   - _isDcaMode: gate helper (single source of truth for "is this bot in DCA mode?")
  //   - _computeStackBEP: รวม totalQty / totalSpent / bep จาก buyLayers (fallback scalar fields)
  //   - _computeDcaTp: TP target สำหรับ stack — ใช้ _computeTp กับ stackBep (reuse TP+trend+fee logic)
  _isDcaMode() {
    return this.bot && this.bot.dcaEnabled === true;
  }

  // FIX-2026-08-11: CBv5 pre-BUY support — check if CBv2 or CBv3 cooldown is active
  //   - Used by CBv5 pre-BUY block to skip the pre-check when another CB already
  //     fired (the cooldown gate in placeBuy will block anyway)
  //   - Returns true if CBv2 or CBv3 lock is in the future
  _hasActiveCbCooldownExceptV5() {
    const now = Date.now();
    const cbv2LockedUntil = this.bot.cbv2LockedUntil ? new Date(this.bot.cbv2LockedUntil).getTime() : 0;
    const cbv3LockedUntil = this.bot.cbv3LockedUntil ? new Date(this.bot.cbv3LockedUntil).getTime() : 0;
    if (cbv2LockedUntil > now) return true;
    if (cbv3LockedUntil > now) return true;
    return false;
  }

  // FIX-2026-08-03: DCA + Martingale layer sizing
  //   - Returns the per-layer notional (USDT) for the upcoming DCA layer
  //   - When martingaleEnabled=false OR dcaEnabled=false → capitalPerTrade (unchanged, backward compat)
  //   - When martingaleEnabled=true AND dcaEnabled=true → capitalPerTrade × mult^(layerIndex-1)
  //     - layerIndex = stack.dcaLayerIndex (1 for first layer, 2 for second, ...)
  //     - applied with per-layer cap (martingaleMaxLayerNotional) for safety
  //   - Returns { notional, isMartingale, multiplier, layerIndex, capped }
  //   - Pure function — does NOT mutate state or place orders
  _computeDcaLayerNotional(stack) {
    const base = parseFloat(this.bot.capitalPerTrade) || 0;
    if (!this._isDcaMode() || !this.bot.martingaleEnabled) {
      return { notional: base, isMartingale: false, multiplier: 1, layerIndex: 1, capped: false };
    }
    const layerIndex = Number(stack && stack.dcaLayerIndex) || 1;
    const multiplier = parseFloat(this.bot.martingaleMultiplier) || 1.5;
    const cap = parseFloat(this.bot.martingaleMaxLayerNotional) || 100;
    const raw = base * Math.pow(multiplier, layerIndex - 1);
    const capped = raw > cap;
    const notional = capped ? cap : raw;
    return { notional, isMartingale: true, multiplier, layerIndex, capped };
  }

  _computeStackBEP(trade) {
    // Priority 1: walk buyLayers (canonical for DCA stacks)
    if (Array.isArray(trade.buyLayers) && trade.buyLayers.length > 0) {
      let totalQty = 0;
      let totalSpent = 0;
      for (const layer of trade.buyLayers) {
        if (!layer || layer.status !== 'FILLED') continue;
        const p = Number(layer.price);
        const q = Number(layer.qty);
        if (!Number.isFinite(p) || !Number.isFinite(q) || q <= 0 || p <= 0) continue;
        totalQty += q;
        totalSpent += p * q;
      }
      if (totalQty > 0) {
        return { totalQty, totalSpent, bep: totalSpent / totalQty };
      }
    }
    // Priority 2: fallback to scalar fields (works for first layer before any layer recorded, or non-DCA safety)
    const buyPrice = Number(trade.buyPrice);
    const buyQty = Number(trade.buyQty);
    if (Number.isFinite(buyPrice) && Number.isFinite(buyQty) && buyPrice > 0 && buyQty > 0) {
      return { totalQty: buyQty, totalSpent: buyPrice * buyQty, bep: buyPrice };
    }
    return { totalQty: 0, totalSpent: 0, bep: null };
  }

  // DCA stack TP — reuse _computeTp (single source of truth) by passing stackBep as buyPrice
  async _computeDcaTp({ stackBep, totalQty, skipTrend = false } = {}) {
    if (!Number.isFinite(stackBep) || stackBep <= 0) {
      throw new Error(`_computeDcaTp: invalid stackBep=${stackBep}`);
    }
    // totalQty reserved for future fee/qty-aware logic — currently fees are percent-based
    return this._computeTp({ buyPrice: stackBep, skipTrend });
  }

  // ─── FIX-2026-07-23: Stop Loss on upper-KC ─────────────────────────────────
  // เรียกจาก onCandleClosed หลังจาก S1 detection เสร็จ
  //   - gate: bot.stopLossOnUpperKC ต้องเปิดอยู่ + trade.useStopLossOnUKC === true
  //   - คำนวณ upper-KC ของ timeframe นี้
  //   - ถ้า candle.close > upperKC → scan active trades ที่ state='selling' + buyPrice > close (ขาดทุน) + useStopLossOnUKC=true
  //   - force close ทีละ trade (cancel SELL + MARKET SELL)
  async _checkStopLossOnUpperKC(candle) {
    // FIX E7: gate running
    if (!this.running) return;
    // FIX-2026-08-03 (Option B): ลบ global gate `if (!this.bot.stopLossOnUpperKC) return;`
    //   - เดิม: require bot.stopLossOnUpperKC=true (ทุก candle ต้องผ่าน global toggle)
    //   - ใหม่: per-trade useStopLossOnUKC flag เป็น gate เดียว (F1 arm เท่านั้นที่ทำให้ SL-UKC ทำงาน)
    //   - เหตุผล: live-vs-DCA-backtest parity (backtester.js:1057 ใช้ OR semantic มาตั้งแต่แรก)
    //     → เปิด bot ที่ AU=on, SL-UKC=off → DCA backtest เห็น SL-UKC exit แต่ live ไม่ trigger (เคส GIGGLEUSDT)
    //   - behavior: ถ้าไม่มี trade ที่ useStopLossOnUKC=true → query return [] → early return (ไม่มี work)

    // FIX P2.5: mutex กัน concurrent invocation (WS + sweep อาจ trigger พร้อมกัน)
    //   ถ้า in-flight อยู่ → skip (อีก call จะจบเร็วๆ นี้อยู่แล้ว)
    if (this.stopLossCheckInFlight) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: stop-loss check already in flight, skip');
      return;
    }
    this.stopLossCheckInFlight = true;
    try {

    // FIX E3: warm-up guard
    const klines = klineCache.getAll(this.bot.symbol, this.bot.timeframe);
    if (!klines || klines.length < 21) return;

    // FIX E3: คำนวณ upper-KC ของแท่งล่าสุด (re-use signalEngine.computeBgStates)
    const { upper } = signalEngine.computeBgStates({
      closes: klines.map((k) => k.close),
      highs: klines.map((k) => k.high),
      lows: klines.map((k) => k.low),
      length: 20,
      mult: this.bot.kcMult || 1.5, // FIX-2026-07-24: per-bot kcMult
      useTrueRange: true,
    });
    const upperKC = upper[upper.length - 1];
    if (upperKC == null) return;

    const closePrice = parseFloat(candle.close);
    // FIX: candle ต้องปิดเหนือ upperKC เท่านั้น → trigger
    if (closePrice <= upperKC) return;

    // FIX-2026-08-02: DCA mode — SL-UKC applies per-stack using stack BEP
    //   - หา DCA stack trades ที่กำลัง selling + ขาดทุน (stackBep > closePrice)
    //   - ใช้ stackBep แทน buyPrice (BEP = weighted-avg ของทุก layer)
    //   - force-close เป็น stack: totalQty = stackTotalQty, sellReason = 'dca_stack_stop_loss'
    if (this._isDcaMode()) {
      let dcaTargets;
      try {
        // FIX-2026-08-03 (B6): include state='filled' so SL-UKC catches stacks that have BUY filled
        //   but SELL not yet placed (post-mirror, pre-cancel/replace, or post-startup reconcile)
        // FIX-2026-08-03: bot.slUkcTriggerOnProfit toggle — DCA ใช้ stackBep แทน buyPrice
        //   - false (default): stackBep > closePrice (loss only) — DCA mode is always loss-exit by design
        //   - true: skip loss check → trigger ได้ทั้งกำไรและขาดทุน (rare; ใช้ strategy "exit DCA stack at upper band")
        const dcaLossFilter = this.bot.slUkcTriggerOnProfit === true
          ? { stackBep: { $exists: true, $ne: null } } // trigger on any close > upperKC (profit OR loss)
          : { stackBep: { $gt: closePrice, $exists: true, $ne: null } }; // loss only (default)
        dcaTargets = await Trade.find({
          botId: this.bot._id,
          isDcaStack: true,
          state: { $in: ['selling', 'filled', 'partial_sell_wait'] },
          useStopLossOnUKC: true,
          ...dcaLossFilter,
        }).lean();
      } catch (err) {
        logger.warn({ err: err.message }, 'trader: stop_loss_upper_kc DCA — Trade.find failed');
        return;
      }
      if (!dcaTargets || dcaTargets.length === 0) {
        logger.debug({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          closePrice, upperKC: upperKC.toFixed(6),
        }, 'trader: stop_loss_upper_kc DCA — no stack to force-close');
        return;
      }
      logger.warn({
        botId: this.bot._id.toString(),
        symbol: this.bot.symbol,
        timeframe: this.bot.timeframe,
        closePrice, upperKC: upperKC.toFixed(6),
        stacks: dcaTargets.length,
        stackIds: dcaTargets.map((t) => t.stackId?.toString() || t._id.toString()),
      }, 'trader: stop_loss_upper_kc DCA — force-closing losing stacks');
      for (const t of dcaTargets) {
        if (!this.running) break;
        try {
          // stack fields: stackBep, stackTotalQty
          await this._stopLossForceClose(t, {
            upperKC,
            closePrice,
            isStack: true,
            stackBep: t.stackBep,
            stackTotalQty: t.stackTotalQty,
            reason: 'dca_stack_stop_loss',
          });
        } catch (err) {
          logger.error({
            err: err.message, stack: err.stack,
            stackId: t.stackId?.toString(),
          }, 'trader: stop_loss_force_close DCA stack — exception');
        }
      }
      return;
    }

    // FIX E5: หา trades ที่กำลัง selling + ยังขาดทุน (buyPrice > close)
    //   ถ้า buyPrice < close (กำไร) → ไม่แตะ ปล่อยให้ TP ทำงานต่อ
    // FIX-2026-07-31 (F1): gate ด้วย per-trade flag (default false; set ตอน auto-arm)
    //   - trade.useStopLossOnUKC === true → trigger ได้
    //   - trade.useStopLossOnUKC === false (default) → ไม่ trigger (backward compatible)
    //   - $exists:false ใน DB เก่า → ก็ไม่ trigger (ต้อง arm ก่อน)
    // FIX-2026-08-03: bot.slUkcTriggerOnProfit toggle — default false = loss only, true = any close>upperKC
    //   - false (default): buyPrice > closePrice (loss only) — original behavior
    //   - true: skip loss check → trigger ได้ทั้งกำไรและขาดทุน (strict upper-band exit strategy)
    const lossFilter = this.bot.slUkcTriggerOnProfit === true
      ? {} // trigger on any close > upperKC (profit OR loss)
      : { buyPrice: { $gt: closePrice } }; // loss only (default — backward compat)
    let targets;
    try {
      targets = await Trade.find({
        botId: this.bot._id,
        state: 'selling',
        useStopLossOnUKC: true,
        ...lossFilter,
      }).lean();
    } catch (err) {
      logger.warn({ err: err.message }, 'trader: stop_loss_upper_kc — Trade.find failed');
      return;
    }

    if (!targets || targets.length === 0) {
      // log debug only (เคสปกติ — candle ทะลุ upper-kc แต่ไม่มี trade ขาดทุน)
      logger.debug({
        botId: this.bot._id.toString(),
        symbol: this.bot.symbol,
        timeframe: this.bot.timeframe,
        closePrice, upperKC: upperKC.toFixed(6),
      }, 'trader: stop_loss_upper_kc — close > upperKC but no losing trade to force-close');
      return;
    }

    logger.warn({
      botId: this.bot._id.toString(),
      symbol: this.bot.symbol,
      timeframe: this.bot.timeframe,
      closePrice, upperKC: upperKC.toFixed(6),
      targets: targets.length,
      tradeIds: targets.map((t) => t._id.toString()),
    }, 'trader: stop_loss_upper_kc — close > upperKC, force-closing losing positions');

    // FIX E6: loop ทีละ trade (atomic per-trade กัน race)
    for (const t of targets) {
      if (!this.running) break;
      try {
        await this._stopLossForceClose(t, { upperKC, closePrice });
      } catch (err) {
        logger.error({
          err: err.message, stack: err.stack,
          tradeId: t._id.toString(),
        }, 'trader: stop_loss_force_close — exception');
      }
    }
    } finally {
      // FIX P2.5: release mutex — ใช้ finally กัน throw ค้าง flag
      this.stopLossCheckInFlight = false;
    }
  }

  // ─── FIX-2026-07-30: CB panic-sell (3-candle persistent lower-band breach) ──
  // เรียกจาก onCandleClosed หลังจาก _checkStopLossOnUpperKC เสร็จ
  //   - gate: bot.cbEnabled !== false (default true)
  //   - คำนวณ lower-KC ของ timeframe นี้
  //   - ถ้า candle ใหม่ (และ 3 แท่งก่อนหน้า) ล้วน "แดง + อยู่ใต้ lowerKC" → panic-close ALL positions ในบอท
  //   - target states: 'partial_wait', 'filled', 'retrying', 'holding', 'selling' (ทุก position ที่ยังเปิดอยู่)
  //   - ใช้ shared _forceCloseTradeNow() กับ duplicate logic
  async _checkCBPanicClose(candle) {
    if (!this.running) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cb skip — not running');
      return;
    }
    if (this.bot.cbEnabled === false) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cb skip — disabled');
      return;
    }
    // FIX-2026-08-02: DCA mode — disable CB panic-sell entirely
    //   - matches "no cut loss" philosophy of DCA stack strategy
    //   - ให้ layer accumulation ทำงานต่อ (ราคาจะลงเท่าไหร่ก็ตาม — BEP จะลดลงเรื่อยๆ)
    //   - SL-UKC ยังคงทำงาน (per-stack BEP) — เป็น exit mechanism เดียวใน DCA mode
    if (this._isDcaMode()) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cb skip — DCA mode (no panic-sell per design)');
      return;
    }

    // mutex กัน concurrent invocation
    if (this.cbCheckInFlight) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cb check already in flight, skip');
      return;
    }

    // FIX-2026-08-01 (CRITICAL-BUG-1): debug log at entry so we can confirm the helper ran
    //   - COTI incident 2026-08-01: zero log activity between BUY and forced close
    //   - ใส่ log entry นี้ทุก candle → ดูใน pm2 log ได้ว่า helper ถูกเรียกจริงหรือไม่
    logger.debug({
      botId: this.bot._id.toString(),
      symbol: this.bot.symbol,
      tf: this.bot.timeframe,
      candleCloseTime: candle.closeTime,
      candleClose: candle.close,
    }, 'trader: CB check running');

    this.cbCheckInFlight = true;
    try {
      const klines = klineCache.getAll(this.bot.symbol, this.bot.timeframe);
      if (!klines || klines.length < 21) {
        logger.debug({ botId: this.bot._id.toString(), klinesLen: klines?.length }, 'trader: cb skip — klines not warm');
        return;
      }

      // คำนวณ lower-KC
      // FIX-2026-08-08 ACTUSDT CB-CBv2/CBv3: parseFloat klines first
      //   - เดิม klines[i].close/high/low อาจเป็น string จาก cache → computeBgStates ได้ NaN/string ใน lower[]
      //   - กัน TypeError: Cannot read properties of undefined (reading 'toFixed') ที่ lastLower.toFixed(6)
      const klineCloses = klines.map((k) => parseFloat(k.close));
      const klineHighs = klines.map((k) => parseFloat(k.high));
      const klineLows = klines.map((k) => parseFloat(k.low));
      const { lower } = signalEngine.computeBgStates({
        closes: klineCloses,
        highs: klineHighs,
        lows: klineLows,
        length: 20,
        mult: this.bot.kcMult || 1.5,
        useTrueRange: true,
      });

      // FIX-2026-08-01 (CRITICAL-BUG-1, Layer B): find index of PASSED-IN candle in cache
      //   - เดิม lastIdx = klines.length - 1 (cache tail) → ถ้า reconcileKlines replay
      //     ย้อนหลัง candle ที่อยู่ก่อน cache tail → ตรวจผิด candle
      //   - fix: scan cache tail (last 10 candles) for the one matching candle.closeTime
      //   - fallback ถ้าไม่เจอ → ใช้ cache tail (live path)
      let lastIdx = klines.length - 1;
      if (candle && candle.closeTime) {
        let found = -1;
        const tail = Math.min(10, klines.length);
        for (let i = klines.length - 1; i >= klines.length - tail; i--) {
          if (klines[i].closeTime === candle.closeTime) { found = i; break; }
        }
        if (found >= 0) lastIdx = found;
      }
      const lastLower = lower[lastIdx];
      // FIX-2026-08-08 ACTUSDT CB-CBv2/CBv3: use Number.isFinite guard (catches NaN, strings, undefined)
      //   - เดิม `lastLower == null` ตรวจแค่ null/undefined แต่ถ้า computeBgStates คืน NaN หรือ string จะหลุดไป lastLower.toFixed(6) แล้ว throw
      if (typeof lastLower !== 'number' || !Number.isFinite(lastLower)) {
        logger.debug({
          botId: this.bot._id.toString(),
          lastIdx,
          lastLowerType: typeof lastLower,
          lastLowerValue: lastLower,
        }, 'trader: cb skip — lastLower invalid (warmup or bad kline)');
        return;
      }

      // ตรวจ pattern CB ที่ candle ที่ตรงกับ passed-in candle
      const opens = klines.map((k) => parseFloat(k.open));
      const closes = klines.map((k) => parseFloat(k.close));
      // FIX-2026-08-01: info-level log เฉพาะตอน pattern match (หลัง isCBAt คืน true)
      if (!signalEngine.isCBAt(lastIdx, opens, closes, lower)) return;

      // FIX-2026-08-01: include 'partial_sell_wait' (was missing — partial-filled SELL positions ถูก skip)
      const OPEN_STATES = ['partial_wait', 'filled', 'retrying', 'holding', 'selling', 'partial_sell_wait'];
      let targets;
      try {
        targets = await Trade.find({
          botId: this.bot._id,
          state: { $in: OPEN_STATES },
        }).lean();
      } catch (err) {
        logger.warn({ err: err.message }, 'trader: cb — Trade.find failed');
        return;
      }
      if (!targets || targets.length === 0) {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          candleCloseTime: candle.closeTime,
          lastLower: lastLower.toFixed(6),
        }, 'trader: cb — pattern matched but no open positions to force-close');
        return;
      }

      logger.warn({
        botId: this.bot._id.toString(),
        symbol: this.bot.symbol,
        timeframe: this.bot.timeframe,
        candleCloseTime: candle.closeTime,
        lastLower: lastLower.toFixed(6),
        targets: targets.length,
        tradeIds: targets.map((t) => t._id.toString()),
      }, 'trader: cb — 3-candle lowerKC breach, force-closing ALL positions (panic-sell)');

      // loop ทีละ trade — ตัว logic หลักเหมือน stop-loss: cancel SELL → MARKET SELL
      // ทุก position ถูกปิด ไม่สนว่ากำไรหรือขาดทุน (panic mode)
      for (const t of targets) {
        if (!this.running) break;
        try {
          await this._forceCloseTradeNow(t, {
            reason: 'cb_panic',
            ctx: {
              lastClose: parseFloat(candle.close),
              lastLower: lastLower,
              allowProfit: true, // CB ไม่สนกำไร/ขาดทุน — ปิดทุก position เพื่อกันกราฟไหล
            },
          });
        } catch (err) {
          logger.error({
            err: err.message, stack: err.stack,
            tradeId: t._id.toString(),
          }, 'trader: cb_force_close — exception');
        }
      }

      // FIX-2026-08-01 (audit H1/R4): set suppression timestamp
      //   - placeBuy consults _cbFiredAt + Date.now() < CB_SUPPRESS_MS → skip
      //   - กัน S1 BUY ใน candle เดียวกัน / candle ถัดไปทันทีหลัง panic-close (race)
      this._cbFiredAt = Date.now();

      // FIX-2026-08-01: persist cbLastFiredAt to Bot for cross-restart continuity
      //   - audit trail ใน DB (optional future dashboard)
      //   - restore ใน start() (Change 8) → continue suppression ข้าม bot restart
      this.bot.cbLastFiredAt = new Date();
      Bot.updateOne(
        { _id: this.bot._id },
        { $set: { cbLastFiredAt: this.bot.cbLastFiredAt } }
      ).catch((err) => logger.warn({ err: err.message }, 'trader: persist cbLastFiredAt failed'));

      // แจ้งเตือนผ่าน Telegram + EventBus
      try {
        const botName = this.bot.name || this.bot.symbol || this.bot._id.toString();
        // FIX-2026-08-01: use sendNow (was incorrectly .notify() — not an export)
        await telegramNotifier.sendNow('cbPanicClose', {
          botName,
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          closedCount: targets.length,
          candleCloseTime: candle.closeTime,
          lastLower: lastLower.toFixed(6),
        }).catch((err) => logger.warn({ err: err.message }, 'trader: cb telegram sendNow failed'));
      } catch (_) { /* non-fatal */ }
    } finally {
      this.cbCheckInFlight = false;
    }
  }

  // ─── FIX-2026-08-06: CBv2 sustained panic-sell + cooldown cbv2LockHours hours ────
  // เรียกจาก _cbv2KlineHandler (direct kline:closed subscription) — bypass onCandleClosed gate
  //   - gate: bot.cbv2Enabled !== false (default true)
  //   - skip if DCA mode (mirror CB — "no cut loss" DCA philosophy)
  //   - skip if already CBv2-cooldown active (cbv2LockedUntil > now) → idempotent
  //   - คำนวณ lower-KC ของ timeframe นี้
  //   - ถ้า candle ใหม่ AND previous candle match isCBv2At (4 red candles fully below lowerKC)
  //     → force-close ALL positions + cooldown S1 BUY for cbv2LockHours hours (default 8)
  //   - HYBRID mode (FIX-2026-08-07): force-close + cooldown only — ไม่ disable บอท, ไม่ override Auto-pause
  //     - บอทยัง enabled, Auto-pause/resume on Min-%KC ยังทำงานปกติ (เป็นอิสระจาก CBv2 cooldown)
  //     - BUY suppression = _cbv2FiredAt cooldown window (เดิม 30s → ตอนนี้ใช้ cbv2LockHours)
  //     - ผู้ใช้ปลด cooldown manual ผ่าน POST /api/bots/:id/unlock-cbv2 ได้
  //   - ใช้ shared _forceCloseTradeNow() with reason 'cbv2_panic'
  //   - mutex cbv2CheckInFlight กัน concurrent invocations
  async _checkCBv2PanicClose(candle) {
    if (!this.running) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cbv2 skip — not running');
      return;
    }
    // FIX-2026-08-08: Feature #2 — version gate (mutually exclusive with CBv3)
    //   - cbVersion='v3' → CBv3 handler fires instead (it has ST3 upper-TF filter)
    //   - cbVersion='v2' → CBv2 handler fires (pure 4-red-below-lowerKC)
    const cbVer = await cbVersion.getActiveVersion();
    if (cbVer !== 'v2') {
      logger.debug({ botId: this.bot._id.toString(), cbVersion: cbVer }, 'trader: cbv2 skip — active version is v3');
      return;
    }
    if (this.bot.cbv2Enabled === false) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cbv2 skip — disabled');
      return;
    }
    // DCA mode — disable CBv2 entirely (mirror CB pattern)
    if (this._isDcaMode()) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cbv2 skip — DCA mode (no panic-sell per design)');
      return;
    }
    // Already cooldown active — skip (idempotent until expiry + manual unlock)
    if (this.bot.cbv2LockedUntil && new Date(this.bot.cbv2LockedUntil).getTime() > Date.now()) {
      logger.debug({ botId: this.bot._id.toString(), cbv2LockedUntil: this.bot.cbv2LockedUntil }, 'trader: cbv2 skip — cooldown active');
      return;
    }

    // mutex กัน concurrent invocation
    if (this.cbv2CheckInFlight) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cbv2 check already in flight, skip');
      return;
    }

    logger.debug({
      botId: this.bot._id.toString(),
      symbol: this.bot.symbol,
      tf: this.bot.timeframe,
      candleCloseTime: candle.closeTime,
      candleClose: candle.close,
    }, 'trader: CBv2 check running');

    this.cbv2CheckInFlight = true;
    try {
      // FIX-2026-08-09: Migrate to cbPatternEvaluator — single canonical REST window
      //   eliminates kline window inconsistency between trader (WS cache, ~500) and
      //   watchdog (REST limit=30). Both now use limit=500 REST snapshot.
      const targetCloseTime = candle && candle.closeTime ? candle.closeTime : null;
      const evaluation = await cbPatternEvaluator.fetchAndEvaluateCBv2({
        bot: this.bot,
        binanceRest,
        targetCloseTime,
        signalEngine,
      });
      if (!evaluation.ok) {
        logger.debug({
          botId: this.bot._id.toString(),
          reason: evaluation.reason,
          candlesCount: evaluation.candlesCount,
        }, 'trader: cbv2 skip — evaluator not ok');
        return;
      }
      if (!evaluation.matched) {
        // FIX-2026-08-09: clear stale confirmations when pattern fails to match
        if (targetCloseTime != null) {
          cbPatternEvaluator.consumeConfirmation({
            botId: this.bot._id.toString(),
            version: 'v2',
            candleCloseTime: targetCloseTime,
          });
        }
        if (evaluation.isBorderline) {
          logger.warn({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            timeframe: this.bot.timeframe,
            cbVersion: 'v2',
            source: evaluation.source,
            requestedLimit: evaluation.requestedLimit,
            targetCloseTime,
            candlesCount: evaluation.candlesCount,
            lastLower: evaluation.lastLower ? evaluation.lastLower.toFixed(8) : null,
            consecutiveCount: evaluation.consecutiveCount,
            reason: evaluation.reason,
          }, 'trader: cbv2 borderline — 3 candles match (CB but not CBv2), no fire');
        }
        return;
      }

      const lastLower = evaluation.lastLower;
      const fingerprint = evaluation.fingerprint;

      // FIX-2026-08-09: 2-tick confirmation — require 2 independent observations
      //   of the same closed candle with the same fingerprint before destructive action.
      //   First tick records confirmation (count=1), second tick confirms (count=2) → fire.
      const recorded = cbPatternEvaluator.recordConfirmation({
        botId: this.bot._id.toString(),
        version: 'v2',
        candleCloseTime: evaluation.targetCloseTime,
        fingerprint,
      });
      const confirmationCount = recorded.count;
      if (confirmationCount < cbPatternEvaluator.REQUIRED_CONFIRMATIONS) {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          cbVersion: 'v2',
          source: evaluation.source,
          requestedLimit: evaluation.requestedLimit,
          targetCloseTime: evaluation.targetCloseTime,
          candlesCount: evaluation.candlesCount,
          lastLower: lastLower.toFixed(8),
          confirmationCount,
          required: cbPatternEvaluator.REQUIRED_CONFIRMATIONS,
          fingerprint,
          reason: 'confirmation_pending',
        }, 'trader: cbv2 pattern matched but confirmation pending — skipping force-close');
        return;
      }

      // FIX-2026-08-09: re-fetch canonical snapshot to verify candle + fingerprint stable
      //   (prevents stale-trigger from a candle that got rewritten after first observation)
      const recheck = await cbPatternEvaluator.fetchAndEvaluateCBv2({
        bot: this.bot,
        binanceRest,
        targetCloseTime: evaluation.targetCloseTime,
        signalEngine,
      });
      if (!recheck.ok || !recheck.matched || recheck.fingerprint !== fingerprint) {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          targetCloseTime: evaluation.targetCloseTime,
          firstFingerprint: fingerprint,
          recheckMatched: recheck.matched,
          recheckFingerprint: recheck.fingerprint,
          reason: !recheck.ok ? recheck.reason : 'fingerprint_mismatch',
        }, 'trader: cbv2 recheck mismatch — skipping force-close (fail-closed)');
        cbPatternEvaluator.consumeConfirmation({
          botId: this.bot._id.toString(),
          version: 'v2',
          candleCloseTime: evaluation.targetCloseTime,
        });
        return;
      }

      // include 'partial_sell_wait' (mirror CB pattern)
      const OPEN_STATES = ['partial_wait', 'filled', 'retrying', 'holding', 'selling', 'partial_sell_wait'];
      let targets;
      try {
        targets = await Trade.find({
          botId: this.bot._id,
          state: { $in: OPEN_STATES },
        }).lean();
      } catch (err) {
        logger.warn({ err: err.message }, 'trader: cbv2 — Trade.find failed');
        return;
      }
      if (!targets || targets.length === 0) {
        // pattern matched but no open positions — still set cooldown (hybrid: ไม่ disable bot, แค่กัน BUY)
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          candleCloseTime: candle.closeTime,
          lastLower: lastLower.toFixed(6),
        }, 'trader: cbv2 — pattern matched but no open positions, setting cooldown anyway (hybrid mode)');
        // fall through to set cooldown
      } else {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          candleCloseTime: candle.closeTime,
          lastLower: lastLower.toFixed(6),
          targets: targets.length,
          tradeIds: targets.map((t) => t._id.toString()),
        }, 'trader: cbv2 — sustained 4-candle lowerKC breach, force-closing ALL positions + setting BUY cooldown');

        // loop ทีละ trade — mirror CB pattern but with cbv2_panic reason
        for (const t of targets) {
          if (!this.running) break;
          try {
            await this._forceCloseTradeNow(t, {
              reason: 'cbv2_panic',
              ctx: {
                lastClose: parseFloat(candle.close),
                lastLower: lastLower,
                allowProfit: true, // CBv2 ไม่สนกำไร/ขาดทุน — ปิดทุก position เพื่อกันกราฟไหลต่อเนื่อง
              },
            });
          } catch (err) {
            logger.error({
              err: err.message, stack: err.stack,
              tradeId: t._id.toString(),
            }, 'trader: cbv2_force_close — exception');
          }
        }
      }

      // ─── HYBRID COOLDOWN (FIX-2026-08-07) — ไม่ disable bot, แค่กัน S1 BUY ───
      const lockHours = Math.max(0.5, Math.min(168, Number(this.bot.cbv2LockHours) || 8));
      const lockedUntil = new Date(Date.now() + lockHours * 60 * 60 * 1000);
      const lockedUntilIso = lockedUntil.toISOString();

      // FIX-2026-08-10: Direction A — CBv2 fires while CBv5 cooldown active → cancel CBv5
      //   - cbCrossCooldown.applyCrossCooldownOnFire('v2') handles the cancel + audit logic
      //   - cbv5LastFiredAt is preserved as audit timestamp
      let cbv5Canceled = false;
      if (this.bot.cbv5LockedUntil && new Date(this.bot.cbv5LockedUntil).getTime() > Date.now()) {
        const cbv5FireMs = new Date(this.bot.cbv5LastFiredAt || Date.now()).getTime();
        cbCrossCooldown.applyCrossCooldownOnFire({
          bot: this.bot,
          firingVersion: 'v2',
          lockHours,
          nowMs: Date.now(),
        });
        this._cbv5FiredAt = 0;
        cbv5Canceled = true;
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          cbv5LockedUntil: this.bot.cbv5LockedUntil,
          cbv5FireMs,
        }, 'trader: cbv2 fires — canceled active CBv5 cooldown (Direction A)');
      }

      // set suppression timestamp (in-memory BUY gate)
      this._cbv2FiredAt = Date.now();

      // persist cooldown fields to Bot (cross-restart continuity)
      this.bot.cbv2LastFiredAt = new Date();
      this.bot.cbv2LockedUntil = lockedUntil;
      this.bot.cbv2LockReason = 'cbv2_panic';
      // FIX-2026-08-10: also clear CBv5 fields on bot doc (in-mem + persistence)
      if (cbv5Canceled) {
        this.bot.cbv5LockedUntil = null;
        this.bot.cbv5LockReason = null;
        // cbv5LastFiredAt preserved as audit
      }
      // HYBRID: ไม่แตะ bot.enabled / bot.status / autoPauseReason — บอทยังรัน, Auto-pause ยังทำงานปกติ

      Bot.updateOne(
        { _id: this.bot._id },
        {
          $set: {
            cbv2LastFiredAt: this.bot.cbv2LastFiredAt,
            cbv2LockedUntil: this.bot.cbv2LockedUntil,
            cbv2LockReason: this.bot.cbv2LockReason,
            // FIX-2026-08-10: persist CBv5 cancel
            cbv5LockedUntil: this.bot.cbv5LockedUntil,
            cbv5LockReason: this.bot.cbv5LockReason,
            // HYBRID: enabled/status/autoPauseReason unchanged
          },
        }
      ).catch((err) => logger.warn({ err: err.message }, 'trader: persist cbv2 cooldown failed'));

      // FIX-2026-08-09: consume confirmation entry after successful fire
      cbPatternEvaluator.consumeConfirmation({
        botId: this.bot._id.toString(),
        version: 'v2',
        candleCloseTime: evaluation.targetCloseTime,
      });

      // emit events — bot:cooldown (CBv2-specific BUY suppression), bot:updated (no bot:disabled, no bot:locked)
      eventBus.emit('bot:cooldown', {
        botId: this.bot._id,
        reason: 'cbv2_panic',
        lockedUntil: lockedUntilIso,
        lockHours,
      });
      eventBus.emit('bot:updated', { botId: this.bot._id });

      // แจ้งเตือนผ่าน Telegram
      try {
        const botName = this.bot.name || this.bot.symbol || this.bot._id.toString();
        await telegramNotifier.sendNow('cbv2PanicClose', {
          botName,
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          closedCount: targets ? targets.length : 0,
          candleCloseTime: candle.closeTime,
          lastLower: lastLower.toFixed(6),
          lockedUntil: lockedUntilIso,
          lockHours,
        }).catch((err) => logger.warn({ err: err.message }, 'trader: cbv2 telegram sendNow failed'));
      } catch (_) { /* non-fatal */ }
    } finally {
      this.cbv2CheckInFlight = false;
    }
  }

  // ─── FIX-2026-08-08: Feature #2 — CBv3 panic-sell + cooldown (CBv2 + ST3 upper-TF) ─────
  // เรียกจาก _cbv3KlineHandler (direct kline:closed subscription)
  //   - CBv3 = CBv2 sustained pattern (4 red candles below lowerKC) + ST3 no-trade pattern
  //     match on upper-TF (TREND_TF_MAP: 3m/5m→1h, 15m→4h, 1h→1d) SAME candle (lastCloseTime)
  //   - mutually exclusive with CBv2: cbVersion='v2' → early return (CBv2 handler already fires)
  //                        cbVersion='v3' → this handler fires (CBv2 handler returns early)
  //   - per-bot opt-out: bot.cbv3Enabled === false → skip (mirrors cbv2Enabled)
  //   - HYBRID mode: force-close + cooldown only — ไม่ disable บอท, ไม่ override Auto-pause
  //     - bot stays enabled, BUY suppression = _cbv3FiredAt cooldown window (cbv3LockHours)
  //     - manual unlock via POST /api/bots/:id/unlock-cbv2 (clears both cbv2+cbv3 fields)
  //   - fields: bot.cbv3Enabled / cbv3LockHours / cbv3LockedUntil / cbv3LockReason /
  //     cbv3LastFiredAt (mirror CBv2 schema — FIX-2026-08-09 added cbv3Enabled +
  //     cbv3LockHours which were missing from schema before)
  //   - mutex cbv3CheckInFlight กัน concurrent invocations
  async _checkCBv3PanicClose(candle) {
    if (!this.running) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cbv3 skip — not running');
      return;
    }
    // FIX-2026-08-08: Feature #2 — version gate (mutually exclusive with CBv2)
    const cbVer = await cbVersion.getActiveVersion();
    if (cbVer !== 'v3') {
      logger.debug({ botId: this.bot._id.toString(), cbVersion: cbVer }, 'trader: cbv3 skip — active version is v2');
      return;
    }
    if (this.bot.cbv3Enabled === false) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cbv3 skip — disabled');
      return;
    }
    if (this._isDcaMode()) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cbv3 skip — DCA mode');
      return;
    }
    if (this.bot.cbv3LockedUntil && new Date(this.bot.cbv3LockedUntil).getTime() > Date.now()) {
      logger.debug({ botId: this.bot._id.toString(), cbv3LockedUntil: this.bot.cbv3LockedUntil }, 'trader: cbv3 skip — cooldown active');
      return;
    }
    if (this.cbv3CheckInFlight) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cbv3 check already in flight, skip');
      return;
    }

    this.cbv3CheckInFlight = true;
    try {
      // FIX-2026-08-09: Migrate to cbPatternEvaluator — single canonical REST window
      //   - same rationale as CBv2: trader (WS cache 500) vs watchdog (REST 30) mismatch
      //   - TUT incident 2026-08-09 17:18 BKK: lastLower=0.145673 matches limit=500
      //     but NOT limit=30 (≈0.14725) → false CBv3 from WS path
      const targetCloseTime = candle && candle.closeTime ? candle.closeTime : null;
      const evaluation = await cbPatternEvaluator.fetchAndEvaluateCBv2({
        bot: this.bot,
        binanceRest,
        targetCloseTime,
        signalEngine,
      });
      if (!evaluation.ok) {
        logger.debug({
          botId: this.bot._id.toString(),
          reason: evaluation.reason,
          candlesCount: evaluation.candlesCount,
        }, 'trader: cbv3 skip — evaluator not ok');
        return;
      }
      if (!evaluation.matched) {
        // FIX-2026-08-09: clear stale confirmations when pattern fails to match
        if (targetCloseTime != null) {
          cbPatternEvaluator.consumeConfirmation({
            botId: this.bot._id.toString(),
            version: 'v3',
            candleCloseTime: targetCloseTime,
          });
        }
        if (evaluation.isBorderline) {
          logger.warn({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            timeframe: this.bot.timeframe,
            cbVersion: 'v3',
            source: evaluation.source,
            requestedLimit: evaluation.requestedLimit,
            targetCloseTime,
            candlesCount: evaluation.candlesCount,
            lastLower: evaluation.lastLower ? evaluation.lastLower.toFixed(8) : null,
            consecutiveCount: evaluation.consecutiveCount,
            reason: evaluation.reason,
          }, 'trader: cbv3 borderline — 3 candles match (CB but not CBv2), no fire');
        }
        return;
      }

      const lastLower = evaluation.lastLower;
      const fingerprint = evaluation.fingerprint;

      // FIX-2026-08-09: 2-tick confirmation — require 2 independent observations
      //   of the same closed candle with the same fingerprint before destructive action.
      const recorded = cbPatternEvaluator.recordConfirmation({
        botId: this.bot._id.toString(),
        version: 'v3',
        candleCloseTime: evaluation.targetCloseTime,
        fingerprint,
      });
      const confirmationCount = recorded.count;
      if (confirmationCount < cbPatternEvaluator.REQUIRED_CONFIRMATIONS) {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          cbVersion: 'v3',
          source: evaluation.source,
          requestedLimit: evaluation.requestedLimit,
          targetCloseTime: evaluation.targetCloseTime,
          candlesCount: evaluation.candlesCount,
          lastLower: lastLower.toFixed(8),
          confirmationCount,
          required: cbPatternEvaluator.REQUIRED_CONFIRMATIONS,
          fingerprint,
          reason: 'confirmation_pending',
        }, 'trader: cbv3 pattern matched but confirmation pending — skipping force-close');
        return;
      }

      // FIX-2026-08-09: re-fetch canonical snapshot to verify candle + fingerprint stable
      //   (prevents stale-trigger from a candle that got rewritten after first observation)
      const recheck = await cbPatternEvaluator.fetchAndEvaluateCBv2({
        bot: this.bot,
        binanceRest,
        targetCloseTime: evaluation.targetCloseTime,
        signalEngine,
      });
      if (!recheck.ok || !recheck.matched || recheck.fingerprint !== fingerprint) {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          targetCloseTime: evaluation.targetCloseTime,
          firstFingerprint: fingerprint,
          recheckMatched: recheck.matched,
          recheckFingerprint: recheck.fingerprint,
          reason: !recheck.ok ? recheck.reason : 'fingerprint_mismatch',
        }, 'trader: cbv3 recheck mismatch — skipping force-close (fail-closed)');
        cbPatternEvaluator.consumeConfirmation({
          botId: this.bot._id.toString(),
          version: 'v3',
          candleCloseTime: evaluation.targetCloseTime,
        });
        return;
      }

      // FIX-2026-08-09: ST3 no-trade on upper-TF (SAME candle) — fail-CLOSED on error
      //   - If we can't fetch upper-TF data → suppress CBv3 (safer than firing blind)
      //   - Replaces previous FAIL-OPEN which was a false-positive risk vector
      const trendTF = volatilityScanner.TREND_TF_MAP ? volatilityScanner.TREND_TF_MAP[this.bot.timeframe] : null;
      if (trendTF) {
        try {
          const noTradeCheck = await signalEngine.checkNoTradeOnUpperTF(
            this.bot, trendTF, binanceRest, { bypassOptIn: true },
          );
          if (noTradeCheck.skip === true) {
            // ST3 pattern matched on upper-TF → CBv3 trigger
            if (this.bot.safeTradeNoTradeEnabled !== true) {
              logger.warn({
                botId: this.bot._id.toString(),
                symbol: this.bot.symbol,
                timeframe: this.bot.timeframe,
                trendTF,
                lastKind: noTradeCheck.lastKind,
                candleCloseTime: candle.closeTime,
                lastLower: lastLower.toFixed(6),
              }, 'trader: CBv3 — CBv2 + ST3 (decoupled mode: safeTradeNoTradeEnabled=false but CBv3 still uses ST3 internally)');
            }
            logger.warn({
              botId: this.bot._id.toString(),
              symbol: this.bot.symbol,
              timeframe: this.bot.timeframe,
              trendTF,
              lastKind: noTradeCheck.lastKind,
              candleCloseTime: candle.closeTime,
              lastLower: lastLower.toFixed(6),
            }, 'trader: CBv3 — CBv2 pattern + ST3 upper-TF no-trade, force-closing ALL positions');
          } else {
            // CBv2 pattern matched BUT ST3 didn't trigger → don't fire CBv3
            // (user opted into v3 for stricter gating — pure CBv2 should NOT trigger)
            logger.debug({
              botId: this.bot._id.toString(),
              symbol: this.bot.symbol,
              timeframe: this.bot.timeframe,
              trendTF,
              reason: noTradeCheck.reason,
            }, 'trader: cbv3 — CBv2 pattern matched but ST3 cleared, no fire (v3 strict gate)');
            return;
          }
        } catch (stErr) {
          // FIX-2026-08-09: FAIL-CLOSED — ST3 fetch error → suppress CBv3
          //   (better to miss a panic than fire a false alarm)
          logger.warn({
            err: stErr.message,
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            trendTF,
            candleCloseTime: candle.closeTime,
          }, 'trader: cbv3 — ST3 fetch failed, skipping (fail-closed)');
          cbPatternEvaluator.consumeConfirmation({
            botId: this.bot._id.toString(),
            version: 'v3',
            candleCloseTime: evaluation.targetCloseTime,
          });
          return;
        }
      } else {
        // No trendTF for this TF — fall back to CBv2-equivalent fire
        logger.warn({
          botId: this.bot._id.toString(),
          timeframe: this.bot.timeframe,
          trendTF,
        }, 'trader: cbv3 — no TREND_TF_MAP entry, firing CBv2-equivalent');
      }

      const OPEN_STATES = ['partial_wait', 'filled', 'retrying', 'holding', 'selling', 'partial_sell_wait'];
      let targets;
      try {
        targets = await Trade.find({ botId: this.bot._id, state: { $in: OPEN_STATES } }).lean();
      } catch (err) {
        logger.warn({ err: err.message }, 'trader: cbv3 — Trade.find failed');
        return;
      }
      if (!targets || targets.length === 0) {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          candleCloseTime: candle.closeTime,
          lastLower: lastLower.toFixed(6),
        }, 'trader: cbv3 — pattern matched but no open positions, setting cooldown anyway (hybrid mode)');
      } else {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          candleCloseTime: candle.closeTime,
          lastLower: lastLower.toFixed(6),
          targets: targets.length,
          tradeIds: targets.map((t) => t._id.toString()),
        }, 'trader: cbv3 — CBv2+ST3 sustained breach, force-closing ALL positions');

        for (const t of targets) {
          if (!this.running) break;
          try {
            await this._forceCloseTradeNow(t, {
              reason: 'cbv3_panic',
              ctx: {
                lastClose: parseFloat(candle.close),
                lastLower: lastLower,
                allowProfit: true,
              },
            });
          } catch (err) {
            logger.error({
              err: err.message, stack: err.stack,
              tradeId: t._id.toString(),
            }, 'trader: cbv3_force_close — exception');
          }
        }
      }

      // HYBRID COOLDOWN
      const lockHours = Math.max(0.5, Math.min(168, Number(this.bot.cbv3LockHours) || 8));
      const lockedUntil = new Date(Date.now() + lockHours * 60 * 60 * 1000);
      const lockedUntilIso = lockedUntil.toISOString();

      // FIX-2026-08-10: Direction A — CBv3 fires while CBv5 cooldown active → cancel CBv5
      //   - cbCrossCooldown.applyCrossCooldownOnFire('v3') handles the cancel + audit logic
      //   - cbv5LastFiredAt is preserved as audit timestamp
      let cbv5CanceledV3 = false;
      if (this.bot.cbv5LockedUntil && new Date(this.bot.cbv5LockedUntil).getTime() > Date.now()) {
        cbCrossCooldown.applyCrossCooldownOnFire({
          bot: this.bot,
          firingVersion: 'v3',
          lockHours,
          nowMs: Date.now(),
        });
        this._cbv5FiredAt = 0;
        cbv5CanceledV3 = true;
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          cbv5LockedUntil: this.bot.cbv5LockedUntil,
        }, 'trader: cbv3 fires — canceled active CBv5 cooldown (Direction A)');
      }

      this._cbv3FiredAt = Date.now();
      this.bot.cbv3LastFiredAt = new Date();
      this.bot.cbv3LockedUntil = lockedUntil;
      this.bot.cbv3LockReason = 'cbv3_panic';
      if (cbv5CanceledV3) {
        this.bot.cbv5LockedUntil = null;
        this.bot.cbv5LockReason = null;
      }

      Bot.updateOne(
        { _id: this.bot._id },
        {
          $set: {
            cbv3LastFiredAt: this.bot.cbv3LastFiredAt,
            cbv3LockedUntil: this.bot.cbv3LockedUntil,
            cbv3LockReason: this.bot.cbv3LockReason,
            cbv5LockedUntil: this.bot.cbv5LockedUntil,
            cbv5LockReason: this.bot.cbv5LockReason,
          },
        }
      ).catch((err) => logger.warn({ err: err.message }, 'trader: persist cbv3 cooldown failed'));

      // FIX-2026-08-09: consume confirmation entry after successful fire
      cbPatternEvaluator.consumeConfirmation({
        botId: this.bot._id.toString(),
        version: 'v3',
        candleCloseTime: evaluation.targetCloseTime,
      });

      eventBus.emit('bot:cooldown', {
        botId: this.bot._id,
        reason: 'cbv3_panic',
        version: 'v3',
        lockedUntil: lockedUntilIso,
        lockHours,
      });
      eventBus.emit('bot:updated', { botId: this.bot._id });

      try {
        const botName = this.bot.name || this.bot.symbol || this.bot._id.toString();
        await telegramNotifier.sendNow('cbv3PanicClose', {
          botName,
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          closedCount: targets ? targets.length : 0,
          candleCloseTime: candle.closeTime,
          lastLower: lastLower.toFixed(6),
          lockedUntil: lockedUntilIso,
          lockHours,
        }).catch((err) => logger.warn({ err: err.message }, 'trader: cbv3 telegram sendNow failed'));
      } catch (_) { /* non-fatal */ }
    } finally {
      this.cbv3CheckInFlight = false;
    }
  }

  // เรียกจาก _cbv5KlineHandler (direct kline:closed subscription)
  //   - CBv5 (Support Zone + Deepest Low + Volume Filter) — independent of cbVersion
  //   - 4-condition confirmation: close < lowerKC + close < deepest pivot low + bearish + volume spike
  //   - debounce: pattern must NOT have matched in previous N candles (cbv5DebounceCandles)
  //   - per-bot opt-out: bot.cbv5Enabled === false → skip
  //   - HYBRID mode: force-close + cooldown only — ไม่ disable บอท, ไม่ override Auto-pause
  //     - bot stays enabled, BUY suppression = _cbv5FiredAt cooldown window (cbv5LockHours)
  //     - manual unlock via POST /api/bots/:id/unlock-cbv2 (clears cbv2+cbv3+cbv5 fields together)
  //   - cbCrossCooldown handles Direction A (cancel CBv5 if CBv2/CBv3 fires) +
  //     Direction B (absorb CBv5 into existing dominant cooldown)
  //   - fields: bot.cbv5Enabled / cbv5LockHours / cbv5LockedUntil / cbv5LockReason /
  //     cbv5LastFiredAt (mirror CBv2/CBv3 schema)
  //   - mutex cbv5CheckInFlight กัน concurrent invocations
  async _checkCBv5PanicClose(candle) {
    if (!this.running) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cbv5 skip — not running');
      return;
    }
    if (this.bot.cbv5Enabled === false) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cbv5 skip — disabled');
      return;
    }
    if (this._isDcaMode()) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cbv5 skip — DCA mode');
      return;
    }
    if (this.bot.cbv5LockedUntil && new Date(this.bot.cbv5LockedUntil).getTime() > Date.now()) {
      logger.debug({ botId: this.bot._id.toString(), cbv5LockedUntil: this.bot.cbv5LockedUntil }, 'trader: cbv5 skip — cooldown active');
      return;
    }
    if (this.cbv5CheckInFlight) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: cbv5 check already in flight, skip');
      return;
    }

    this.cbv5CheckInFlight = true;
    try {
      const targetCloseTime = candle && candle.closeTime ? candle.closeTime : null;
      // CBv5 uses its own evaluator (cbPatternEvaluator.fetchAndEvaluateCBv5) — independent of CBv2/CBv3
      // because CBv5 needs pivot-low history + volume MA which evaluateCBv2Snapshot doesn't compute.
      const evaluation = await cbPatternEvaluator.fetchAndEvaluateCBv5({
        bot: this.bot,
        binanceRest,
        targetCloseTime,
      });
      if (!evaluation.ok) {
        logger.debug({
          botId: this.bot._id.toString(),
          reason: evaluation.reason,
          candlesCount: evaluation.candlesCount,
        }, 'trader: cbv5 skip — evaluator not ok');
        return;
      }
      if (!evaluation.matched) {
        // Clear stale confirmations when pattern fails to match
        if (targetCloseTime != null) {
          cbPatternEvaluator.consumeConfirmation({
            botId: this.bot._id.toString(),
            version: 'v5',
            candleCloseTime: targetCloseTime,
          });
        }
        if (evaluation.reason === 'debounce_active') {
          logger.warn({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            timeframe: this.bot.timeframe,
            reason: evaluation.reason,
            candlesCount: evaluation.candlesCount,
            lastLower: evaluation.lastLower ? evaluation.lastLower.toFixed(8) : null,
            bypassedDebounce: evaluation.bypassedDebounce === true,
            targetCloseTime: evaluation.targetCloseTime,
          }, 'trader: cbv5 near-miss — single-tick match but debounce blocked (pattern matched recently)');
        }
        return;
      }

      const lastLower = evaluation.lastLower;
      const deepestLow = evaluation.deepestLow;
      const fingerprint = evaluation.fingerprint;

      // 2-tick confirmation registry (reuse existing helpers — version key 'v5')
      const recorded = cbPatternEvaluator.recordConfirmation({
        botId: this.bot._id.toString(),
        version: 'v5',
        candleCloseTime: evaluation.targetCloseTime,
        fingerprint,
      });
      const confirmationCount = recorded.count;
      if (confirmationCount < cbPatternEvaluator.REQUIRED_CONFIRMATIONS) {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          source: evaluation.source,
          requestedLimit: evaluation.requestedLimit,
          targetCloseTime: evaluation.targetCloseTime,
          candlesCount: evaluation.candlesCount,
          lastLower: lastLower.toFixed(8),
          deepestLow: deepestLow != null ? deepestLow.toFixed(8) : null,
          confirmationCount,
          required: cbPatternEvaluator.REQUIRED_CONFIRMATIONS,
          fingerprint,
          reason: 'confirmation_pending',
        }, 'trader: cbv5 pattern matched but confirmation pending — skipping force-close');
        return;
      }

      // Re-fetch canonical snapshot to verify candle + fingerprint stable
      // (prevents stale-trigger from a candle that got rewritten after first observation)
      const recheck = await cbPatternEvaluator.fetchAndEvaluateCBv5({
        bot: this.bot,
        binanceRest,
        targetCloseTime: evaluation.targetCloseTime,
      });
      if (!recheck.ok || !recheck.matched || recheck.fingerprint !== fingerprint) {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          targetCloseTime: evaluation.targetCloseTime,
          firstFingerprint: fingerprint,
          recheckMatched: recheck.matched,
          recheckFingerprint: recheck.fingerprint,
          reason: !recheck.ok ? recheck.reason : 'fingerprint_mismatch',
        }, 'trader: cbv5 recheck mismatch — skipping force-close (fail-closed)');
        cbPatternEvaluator.consumeConfirmation({
          botId: this.bot._id.toString(),
          version: 'v5',
          candleCloseTime: evaluation.targetCloseTime,
        });
        return;
      }

      const OPEN_STATES = ['partial_wait', 'filled', 'retrying', 'holding', 'selling', 'partial_sell_wait'];
      let targets;
      try {
        targets = await Trade.find({ botId: this.bot._id, state: { $in: OPEN_STATES } }).lean();
      } catch (err) {
        logger.warn({ err: err.message }, 'trader: cbv5 — Trade.find failed');
        return;
      }
      if (!targets || targets.length === 0) {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          candleCloseTime: candle.closeTime,
          lastLower: lastLower.toFixed(6),
          deepestLow: deepestLow != null ? deepestLow.toFixed(6) : null,
        }, 'trader: cbv5 — pattern matched but no open positions, setting cooldown anyway (hybrid mode)');
      } else {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          candleCloseTime: candle.closeTime,
          lastLower: lastLower.toFixed(6),
          deepestLow: deepestLow != null ? deepestLow.toFixed(6) : null,
          targets: targets.length,
          tradeIds: targets.map((t) => t._id.toString()),
        }, 'trader: cbv5 — Support Zone broken + deepest pivot low breached, force-closing ALL positions');

        for (const t of targets) {
          if (!this.running) break;
          try {
            await this._forceCloseTradeNow(t, {
              reason: 'cbv5_panic',
              ctx: {
                lastClose: parseFloat(candle.close),
                lastLower,
                deepestLow,
                isBearish: evaluation.isBearish,
                isHighVolume: evaluation.isHighVolume,
                allowProfit: true,
              },
            });
          } catch (err) {
            logger.error({
              err: err.message, stack: err.stack,
              tradeId: t._id.toString(),
            }, 'trader: cbv5_force_close — exception');
          }
        }
      }

      // HYBRID COOLDOWN + cross-version interaction
      //   - cbCrossCooldown handles Direction A/B:
      //     * if CBv2/CBv3 already active → CBv5 is absorbed into the dominant cooldown
      //     * if no CBv2/CBv3 active → CBv5 takes its own lock (cbv5LockedUntil)
      //   - returns updated lock fields + audit timestamp
      const lockHours = Math.max(0.5, Math.min(168, Number(this.bot.cbv5LockHours) || 4));
      const nowMs = Date.now();
      const crossResult = cbCrossCooldown.applyCrossCooldownOnFire({
        bot: this.bot,
        firingVersion: 'v5',
        lockHours,
        nowMs,
      });

      // Only set in-memory gate if CBv5 took its OWN lock (Direction B "absorbed" → cbv5LockedUntil=null)
      if (crossResult.cbv5LockedUntil && new Date(crossResult.cbv5LockedUntil).getTime() > nowMs) {
        this._cbv5FiredAt = nowMs;
      } else {
        // Absorbed into CBv2/CBv3 → in-memory gate is null. Buy-gate via the extended CBv2/CBv3 field.
        this._cbv5FiredAt = 0;
      }

      // Persist cooldown fields (idempotent — applies whatever crossResult decided)
      Bot.updateOne(
        { _id: this.bot._id },
        {
          $set: {
            cbv2LockedUntil: crossResult.cbv2LockedUntil,
            cbv3LockedUntil: crossResult.cbv3LockedUntil,
            cbv5LockedUntil: crossResult.cbv5LockedUntil,
            cbv5LastFiredAt: crossResult.cbv5LastFiredAt,
            cbv5LockReason: crossResult.cbv5LockedUntil ? 'cbv5_panic' : null,
          },
        }
      ).catch((err) => logger.warn({ err: err.message }, 'trader: persist cbv5 cooldown failed'));

      // Consume confirmation entry after successful fire
      cbPatternEvaluator.consumeConfirmation({
        botId: this.bot._id.toString(),
        version: 'v5',
        candleCloseTime: evaluation.targetCloseTime,
      });

      // Emit events
      const lockedUntilIso = crossResult.cbv5LockedUntil
        ? new Date(crossResult.cbv5LockedUntil).toISOString()
        : (crossResult.cbv3LockedUntil
            ? new Date(crossResult.cbv3LockedUntil).toISOString()
            : (crossResult.cbv2LockedUntil
                ? new Date(crossResult.cbv2LockedUntil).toISOString()
                : null));
      eventBus.emit('bot:cooldown', {
        botId: this.bot._id,
        reason: 'cbv5_panic',
        version: 'v5',
        lockedUntil: lockedUntilIso,
        lockHours,
        absorbed: crossResult.appliedTo.startsWith('cbv5-absorbed') || crossResult.appliedTo.startsWith('cbv5-extended'),
        appliedTo: crossResult.appliedTo,
      });
      eventBus.emit('bot:updated', { botId: this.bot._id });

      // Telegram notification (mirror cbv3PanicClose format with deepestLow/isBearish/isHighVolume)
      try {
        const botName = this.bot.name || this.bot.symbol || this.bot._id.toString();
        await telegramNotifier.sendNow('cbv5PanicClose', {
          botName,
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          closedCount: targets ? targets.length : 0,
          candleCloseTime: candle.closeTime,
          lastLower: lastLower.toFixed(6),
          deepestLow: deepestLow != null ? deepestLow.toFixed(6) : null,
          isBearish: evaluation.isBearish,
          isHighVolume: evaluation.isHighVolume,
          lockedUntil: lockedUntilIso,
          lockHours,
          appliedTo: crossResult.appliedTo,
        }).catch((err) => logger.warn({ err: err.message }, 'trader: cbv5 telegram sendNow failed'));
      } catch (_) { /* non-fatal */ }
    } finally {
      this.cbv5CheckInFlight = false;
    }
  }

  // ─── FIX-2026-08-08: Feature #3 — Auto Unlock Cooldown on candle close ─────
  // เรียกจาก _cbAutoUnlockKlineHandler (direct kline:closed subscription)
  //   - runs every candle close while bot is in CB cooldown (cbv2 OR cbv3)
  //   - if cbAutoUnlockEnabled=false → skip
  //   - if no cooldown active → skip
  //   - mutex _cbAutoUnlockInFlight กัน concurrent invocations across candles
  //   - on unlock: cbAutoUnlock.applyUnlock() clears cbv2* + cbv3* fields + resets in-memory _cbv2FiredAt/_cbv3FiredAt
  //   - ไม่ override bot.enabled (HYBRID mode — manual unlock ไม่ disable บอท)
  async _evaluateAutoUnlockOnCandle(_candle) {
    if (!this.running) return;
    if (this.bot.cbAutoUnlockEnabled !== true) return;
    if (this._cbAutoUnlockInFlight) return;
    this._cbAutoUnlockInFlight = true;
    try {
      const cbBot = await Bot.findById(this.bot._id).lean();
      if (!cbBot) return;
      // FIX-2026-08-08: master switch — stamp AppConfig.masterCbAutoUnlockEnabled
      const masterToggles = await masterConfig.getMasterToggles();
      cbBot._masterCbAutoUnlockEnabled = masterToggles.masterCbAutoUnlockEnabled;
      const unlockResult = await cbAutoUnlock.evaluate(cbBot);
      if (unlockResult.unlocked) {
        await cbAutoUnlock.applyUnlock(cbBot, unlockResult);
        // refresh in-memory snapshot
        this.bot.cbv2LockedUntil = null;
        this.bot.cbv2LockReason = null;
        this.bot.cbv2LastFiredAt = null;
        this.bot.cbv3LockedUntil = null;
        this.bot.cbv3LockReason = null;
        this.bot.cbv3LastFiredAt = null;
        logger.info({
          botId: this.bot._id.toString(),
          signalsFound: unlockResult.signalsFound,
          threshold: unlockResult.threshold,
        }, 'trader: CB auto-unlock triggered (3+ profitable signals on candle close)');
        try {
          const botName = this.bot.name || this.bot.symbol || this.bot._id.toString();
          await telegramNotifier.sendNow('botAutoUnlocked', {
            botName,
            symbol: this.bot.symbol,
            timeframe: this.bot.timeframe,
            signalsFound: unlockResult.signalsFound,
            threshold: unlockResult.threshold,
          }).catch((err) => logger.warn({ err: err.message }, 'trader: cbAutoUnlock telegram failed'));
        } catch (_) { /* non-fatal */ }
      } else if (unlockResult.signalsFound > 0) {
        // partial progress — update counter for UI/debugging
        await Bot.updateOne(
          { _id: this.bot._id },
          { $set: {
            cbAutoUnlockSignalsFound: unlockResult.signalsFound,
            cbAutoUnlockCheckedAt: new Date(),
          } }
        ).catch(() => {});
      }
    } catch (err) {
      logger.warn({ err: err.message, botId: this.bot._id.toString() }, 'trader: cbAutoUnlock evaluate failed (non-fatal)');
    } finally {
      this._cbAutoUnlockInFlight = false;
    }
  }

  // FIX-2026-07-30: shared force-close helper — ใช้ได้ทั้ง stop-loss (upperKC) และ CB (panic)
  //   - atomic claim → cancel live SELL → MARKET SELL
  //   - reason: 'stop_loss_upper_kc' | 'cb_panic'
  //   - ctx: { upperKC, closePrice } หรือ { lastClose, lastLower, allowProfit }
  // FIX-2026-08-02: _cancelAndReplaceSell — shared SELL cancel + replace helper
  //   - ใช้ใน DCA stack flow (ทุก layer ใหม่ cancel SELL เก่า → place ใหม่ที่ BEP+TP ใหม่)
  //   - race-safe: atomic state check + cancel orphan guard
  //   - returns: { ok, mode, sellOrderId, sellPrice, error? }
  //     mode ∈ 'placed' | 'race_sold' | 'race_stopping' | 'cancelled_first' | 'validation_fail' | 'binance_error'
  async _cancelAndReplaceSell({ trade, reason, source, qty, newTarget, allowStates = ['filled', 'holding', 'selling', 'partial_sell_wait'] }) {
    if (!trade || !trade._id) {
      return { ok: false, mode: 'error', error: 'trade missing' };
    }
    const logCtx = { tradeId: trade._id.toString(), symbol: trade.symbol, reason, source, qty, newTarget };
    let cancelOk = true;
    let prevSellOrderId = trade.sellOrderId;

    // 1. cancel existing SELL (if any)
    if (prevSellOrderId) {
      try {
        await binanceRest.cancelOrder({ symbol: trade.symbol, orderId: prevSellOrderId });
        logger.info({ ...logCtx, prevSellOrderId }, 'trader: _cancelAndReplaceSell — cancelled old SELL');
      } catch (err) {
        const ferr = binanceRest.formatBinanceError(err);
        if (ferr && ferr.code === -2011) {
          // -2011 = "Unknown order" — already gone (filled / cancelled / expired). Not a failure.
          logger.info({ ...logCtx, prevSellOrderId, code: -2011 }, 'trader: _cancelAndReplaceSell — old SELL already gone (filled/cancelled)');
        } else {
          logger.warn({ ...logCtx, err: ferr || err.message }, 'trader: _cancelAndReplaceSell — cancel failed (will still attempt recheck + new place)');
          cancelOk = false;
        }
      }
    }

    // 2. recheck trade state — if SELL already filled (race), abort + return 'race_sold'
    let latest;
    try {
      latest = await Trade.findById(trade._id).lean();
    } catch (err) {
      logger.warn({ ...logCtx, err: err.message }, 'trader: _cancelAndReplaceSell — recheck failed');
      return { ok: false, mode: 'binance_error', error: 'recheck failed: ' + err.message };
    }
    if (!latest) {
      return { ok: false, mode: 'error', error: 'trade not found' };
    }
    if (latest.state === 'sold') {
      logger.info({ ...logCtx, prevSellOrderId }, 'trader: _cancelAndReplaceSell — race: trade already sold, abort new SELL place');
      return { ok: true, mode: 'race_sold' };
    }
    if (latest.state === 'stopping') {
      logger.info({ ...logCtx, prevSellOrderId }, 'trader: _cancelAndReplaceSell — race: trade in stopping, abort new SELL place');
      return { ok: true, mode: 'race_stopping' };
    }
    if (!allowStates.includes(latest.state)) {
      return { ok: false, mode: 'error', error: `trade state=${latest.state} not in allowStates=${allowStates.join(',')}` };
    }

    if (!cancelOk) {
      return { ok: false, mode: 'binance_error', error: 'cancel failed and not -2011' };
    }

    // 3. validate new SELL params (qty, price, tick, minNotional)
    const info = symbolInfo.getCached(trade.symbol);
    if (!info) {
      return { ok: false, mode: 'error', error: 'symbolInfo missing' };
    }
    const validation = symbolInfo.validateOrder({ symbol: trade.symbol, price: newTarget.toString(), qty });
    if (!validation.ok) {
      logger.warn({ ...logCtx, reason: validation.reason }, 'trader: _cancelAndReplaceSell — validation failed (MARKET fallback deferred to caller)');
      return { ok: false, mode: 'validation_fail', error: validation.reason };
    }

    // 4. place new aggregate SELL (LIMIT_MAKER post-only)
    const sellClientOrderId = this.makeClientOrderId('sell', Date.now(), trade.retryCount || 0);
    let sellResp;
    try {
      sellResp = await binanceRest.newOrder({
        symbol: trade.symbol,
        side: 'SELL',
        type: 'LIMIT_MAKER',
        quantity: qty.toString(),
        price: newTarget.toString(),
        newClientOrderId: sellClientOrderId,
        recvWindow: config_recvWindow(),
      });
    } catch (err) {
      const ferr = binanceRest.formatBinanceError(err);
      logger.warn({ ...logCtx, err: ferr || err.message }, 'trader: _cancelAndReplaceSell — newOrder failed');
      return { ok: false, mode: 'binance_error', error: (ferr ? `${ferr.code}: ${ferr.msg}` : err.message) };
    }

    // 5. atomic state update (state must still be in allowStates)
    const upd = await Trade.updateOne(
      { _id: trade._id, state: { $in: allowStates } },
      {
        sellOrderId: sellResp.orderId,
        sellClientOrderId,
        sellPrice: parseFloat(newTarget),
        sellQty: qty,
        sellStatus: sellResp.status,
        sellPlacedAt: new Date(),
        targetSellPrice: parseFloat(newTarget),
        state: 'selling',
      }
    );
    if (upd.modifiedCount === 0) {
      // race lost — trade moved on between recheck and updateOne
      logger.warn({ ...logCtx, sellOrderId: sellResp.orderId }, 'trader: _cancelAndReplaceSell — race lost after newOrder, cancelling orphan SELL');
      try {
        await binanceRest.cancelOrder({ symbol: trade.symbol, orderId: sellResp.orderId }).catch(() => null);
      } catch (_) { /* best-effort */ }
      return { ok: false, mode: 'binance_error', error: 'race lost after newOrder' };
    }
    logger.info({ ...logCtx, sellOrderId: sellResp.orderId, newTarget }, 'trader: _cancelAndReplaceSell — placed new SELL');
    return {
      ok: true,
      mode: 'placed',
      sellOrderId: sellResp.orderId,
      sellPrice: parseFloat(newTarget),
    };
  }

  async _forceCloseTradeNow(trade, { reason, ctx }) {
    // FIX-2026-08-02: DCA stack branch — derive qty/buyPrice from stack; override reason
    //   - trade.isDcaStack === true → ใช้ stackBep + stackTotalQty + sellReason='dca_stack_force_close'
    //   - 1 stack = 1 bot counter entry (totalTrades, winTrades)
    const isStack = trade.isDcaStack === true;
    const stackReason = isStack ? 'dca_stack_force_close' : null;
    const effectiveReason = isStack ? stackReason : reason;

    // 1. atomic claim (state selling → stopping, หรือ filled/holding/... → stopping)
    //   - ใช้ allowedFrom set เพื่อกัน race กับ paths อื่น ๆ
    const ALLOWED_FROM = ['partial_wait', 'filled', 'retrying', 'holding', 'selling', 'partial_sell_wait'];
    let errNote;
    if (isStack) {
      errNote = `dca_stack_force_close triggered (reason=${reason}, stackBep=${parseFloat(trade.stackBep || 0).toFixed(6)})`;
    } else if (reason === 'cb_panic') {
      errNote = `cb_panic_sell triggered (close=${ctx.lastClose} < lowerKC=${ctx.lastLower.toFixed(6)})`;
    } else {
      errNote = `stop_loss_upper_kc triggered (close=${ctx.closePrice} > upperKC=${ctx.upperKC.toFixed(6)})`;
    }
    const claim = await Trade.findOneAndUpdate(
      { _id: trade._id, state: { $in: ALLOWED_FROM } },
      { $set: { state: 'stopping', error: errNote } },
      { new: true }
    );
    if (!claim) {
      logger.debug({
        tradeId: trade._id.toString(),
        reason,
      }, 'trader: _forceCloseTradeNow — state changed concurrently, abort');
      return;
    }
    // 2. cancel live SELL (ถ้ามี) — re-use logic เดิม
    if (trade.sellOrderId) {
      try {
        await binanceRest.cancelOrder({
          symbol: this.bot.symbol,
          orderId: trade.sellOrderId,
        });
        logger.info({
          botId: this.bot._id.toString(),
          tradeId: trade._id.toString(),
          sellOrderId: trade.sellOrderId,
          reason,
        }, 'trader: _forceCloseTradeNow — cancelled live SELL');
      } catch (err) {
        const fe = binanceRest.formatBinanceError(err);
        if (fe.code === -2011) {
          // -2011 → อาจจะ fill ที่ TP แล้วก่อนหน้านี้ → ตรวจ order ก่อน
          try {
            const fresh = await binanceRest.getOrder({
              symbol: this.bot.symbol,
              orderId: trade.sellOrderId,
            });
            if (fresh && fresh.status === 'FILLED') {
              const filledQty = parseFloat(fresh.executedQty);
              const avgSell = parseFloat(fresh.price)
                || parseFloat(fresh.avgPrice)
                || (parseFloat(fresh.cummulativeQuoteQty) / filledQty);
              const feeRate = fees.getMakerRate();
              const pnl = fees.calcPnl({
                buyPrice: parseFloat(trade.buyPrice),
                sellPrice: avgSell,
                qty: filledQty,
                feeRate,
              });
              const upd = await Trade.updateOne(
                { _id: claim._id, state: 'stopping' },
                {
                  state: 'sold',
                  sellOrderId: fresh.orderId,
                  sellPrice: avgSell,
                  sellAvgPrice: avgSell, // P2-fix-2026-08-06: alias for query consistency
                  sellFilledAt: new Date(),
                  sellFilledQty: filledQty,
                  // FIX-2026-07-31 (BUG-1): calcPnl returns {gross,fees,net,pnlPercent} — no realizedPnl key
                  //   was silently writing `undefined` to DB. Use `pnl.net`.
                  realizedPnl: pnl.net,
                  pnlPercent: pnl.pnlPercent,
                  error: `${reason}: SELL already FILLED at TP, recorded (no MARKET placed)`,
                  // FIX-2026-07-31 (F1): reset SL-on-UKC auto-arm flag (trade ออกจาก selling แล้ว)
                  useStopLossOnUKC: false,
                  autoArmedAt: null,
                  // FIX-2026-08-03: clear F1 threshold snapshots เมื่อ trade ออกจาก selling
                  autoArmLossPct: null,
                  autoArmAgeHours: null,
                  // FIX-2026-08-01: reset SELL partial-fill latch on state-out-of-selling
                  sellPartialDetectedAt: null,
                  sellPartialLatchedAt: null,
                  sellPartialLatchedReason: null,
                  // FIX-2026-08-01: race recovery (cancel returned -2011 because SELL already filled at TP)
                  sellReason: 'race_recovery_filled',
                  sellReasonDetail: `${reason}: SELL already FILLED at TP before force-close cancelled`,
                  sellReasonAt: new Date(),
                  sellReasonSource: '_forceCloseTradeNow',
                }
              );
              if (upd.modifiedCount === 1) {
                // FIX-2026-08-06 (P4): slippage check for race-recovery path —
                //   SELL fill ต่ำกว่า target > 1% (warn) / > 3% (telegram alert)
                const raceTarget = parseFloat(trade.targetSellPrice || 0);
                if (raceTarget > 0) {
                  this._computeSlippage({
                    sellPrice: avgSell,
                    targetSellPrice: raceTarget,
                    tradeId: claim._id,
                    sellReason: 'race_recovery_filled',
                    pnlPercent: pnl.pnlPercent,
                  });
                }
                // FIX-2026-07-31 (BUG-1): previously this branch skipped Bot.$inc + unregisterTrade +
                //   currentTrade cleanup + bot:status idle emit (mirror stop_loss_upper_kc L704-719 pattern)
                await Bot.updateOne(
                  { _id: this.bot._id },
                  {
                    $inc: {
                      totalPnl: pnl.net,
                      totalTrades: 1,
                      winTrades: (pnl.net > 0 ? 1 : 0),
                    },
                    $set: { status: 'idle', lastError: '' },
                  }
                );
                this._unregisterTrade(trade);
                if (this.currentTrade && this.currentTrade._id.toString() === trade._id.toString()) {
                  this.currentTrade = null;
                }
                eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
                // FIX-2026-08-01: surface race-recovery reason to dashboardWS/telegram
                eventBus.emit('trade:update', {
                  tradeId: claim._id,
                  botId: this.bot._id,
                  state: 'sold',
                  reason: trade.sellReason || 'race_recovery_filled',
                  reasonDetail: trade.sellReasonDetail || `${reason}: SELL already FILLED at TP before force-close cancelled`,
                });
                return;
              }
            }
          } catch (_) { /* fall through to MARKET */ }
        }
        // ไม่ใช่ -2011 ที่ fill แล้ว → MARKET place
        logger.warn({
          err: fe.message, code: fe.code,
          tradeId: trade._id.toString(),
        }, 'trader: _forceCloseTradeNow — cancel SELL failed, proceeding to MARKET anyway');
      }
    }

    // 3. MARKET SELL
    // FIX-2026-08-02: DCA stack — use stackBep + stackTotalQty
    const qty = isStack
      ? parseFloat(trade.stackTotalQty || 0)
      : parseFloat(trade.buyFilledQty || trade.buyQty || 0);
    const buyPrice = isStack
      ? parseFloat(trade.stackBep || 0)
      : parseFloat(trade.buyPrice || 0);
    const targetSell = parseFloat(trade.targetSellPrice || 0);
    if (!(qty > 0) || !(buyPrice > 0)) {
      logger.error({
        tradeId: claim._id.toString(),
        isStack, qty, buyPrice,
      }, 'trader: _forceCloseTradeNow — invalid qty/buyPrice, marking failed');
      await Trade.updateOne(
        { _id: claim._id, state: 'stopping' },
        { state: 'failed', error: `${effectiveReason}: invalid qty/buyPrice, cannot MARKET SELL`,
          // FIX-2026-07-31 (F1): reset SL-on-UKC auto-arm flag
          useStopLossOnUKC: false,
          autoArmedAt: null,
          // FIX-2026-08-03: clear F1 threshold snapshots เมื่อ trade ออกจาก selling
          autoArmLossPct: null,
          autoArmAgeHours: null,
          // FIX-2026-08-01: reset SELL partial-fill latch
          sellPartialDetectedAt: null,
          sellPartialLatchedAt: null,
          sellPartialLatchedReason: null,
        }
      );
      eventBus.emit('trade:update', {
        tradeId: claim._id,
        state: 'failed',
        reason: null,
        reasonDetail: null,
      });
      return;
    }
    // FIX-2026-07-31 (BUG-1): was calling `this._placeMarketSell` which doesn't exist → TypeError
    //   stranded every CB panic-sell in 'stopping' forever. Use the existing `_emergencyMarketSell`
    //   helper (defined L1891+) — signature is `(trade, qty, buyPrice, targetSellPrice, reasonNote)`.
    // FIX-2026-08-01: pass opts.reason so _emergencyMarketSell can stamp sellReason enum on the trade doc.
    // FIX-2026-08-02: use effectiveReason (for DCA stack, it's 'dca_stack_force_close')
    const ok = await this._emergencyMarketSell(claim, qty, buyPrice, targetSell, errNote, { reason: effectiveReason });
    if (!ok) {
      logger.error({
        tradeId: claim._id.toString(),
        reason: effectiveReason,
      }, 'trader: _forceCloseTradeNow — MARKET SELL failed, fallback to holding retry');
      await Trade.updateOne(
        { _id: claim._id },
        { state: 'holding', error: `${effectiveReason}: MARKET SELL failed — will retry` }
      );
      await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
      eventBus.emit('trade:update', {
        tradeId: claim._id,
        state: 'holding',
        reason: null,
        reasonDetail: null,
      });
      this.scheduleHoldingRetry(claim, qty, buyPrice, targetSell);
      return;
    }

    // FIX-2026-08-02: DCA stack — stamp stackClosedAt + sellReasonSource
    if (isStack) {
      await Trade.updateOne(
        { _id: claim._id },
        {
          stackClosedAt: new Date(),
          sellReason: stackReason,
          sellReasonDetail: errNote,
          sellReasonAt: new Date(),
          sellReasonSource: '_forceCloseTradeNow_dca',
        }
      );
    }
  }

  // FIX-2026-07-23: stop-loss force close — atomic claim → cancel live SELL → MARKET SELL
  async _stopLossForceClose(trade, ctx) {
    // FIX-2026-08-02: DCA stack branch — use stack BEP + totalQty + per-stack pnl
    //   - ctx.isStack, ctx.stackBep, ctx.stackTotalQty, ctx.reason
    //   - 1 stack = 1 bot counter entry (totalTrades, winTrades)
    //   - sellReason = 'dca_stack_stop_loss'
    const isStack = ctx.isStack === true;
    const stackBep = isStack ? parseFloat(ctx.stackBep || trade.stackBep) : null;
    const stackTotalQty = isStack ? parseFloat(ctx.stackTotalQty || trade.stackTotalQty) : null;
    const stackReason = isStack ? (ctx.reason || 'dca_stack_stop_loss') : null;

    // FIX E1: atomic claim (state='selling' → 'stopping') กัน 2 trigger พร้อมกัน
    //   - onSellOrderUpdate (WS) จะเห็น state='stopping' และ skip (FILLED → handleSellFilled guard)
    //   - onCandleClosed รอบถัดไปจะเห็น state != 'selling' ไม่ trigger ซ้ำ
    // FIX-2026-08-03 (B6): for DCA stacks, also accept state='filled' (SELL placed path post-mirror,
    //   pre-cancel/replace) so SL-UKC can still trigger against stacks that have BUY but no SELL yet
    const claimPredicate = isStack
      ? { _id: trade._id, state: { $in: ['selling', 'filled', 'partial_sell_wait'] } }
      : { _id: trade._id, state: 'selling' };
    const claim = await Trade.findOneAndUpdate(
      claimPredicate,
      {
        $set: {
          state: 'stopping',
          error: isStack
            ? `dca_stack_stop_loss triggered (close=${ctx.closePrice} > upperKC=${ctx.upperKC.toFixed(6)}, stackBep=${stackBep?.toFixed(6)})`
            : `stop_loss_upper_kc triggered (close=${ctx.closePrice} > upperKC=${ctx.upperKC.toFixed(6)})`,
        },
      },
      { new: true }
    );
    if (!claim) {
      // someone else handled (WS SELL fill, or concurrent stop-loss path)
      logger.debug({
        tradeId: trade._id.toString(),
        isStack,
      }, 'trader: stop_loss_force_close — state no longer selling/filled, abort');
      return;
    }

    // 1. cancel live SELL ก่อน (idempotent — -2011 Unknown order ก็ ignore)
    if (trade.sellOrderId) {
      try {
        await binanceRest.cancelOrder({
          symbol: this.bot.symbol,
          orderId: trade.sellOrderId,
        });
        logger.info({
          botId: this.bot._id.toString(),
          tradeId: trade._id.toString(),
          sellOrderId: trade.sellOrderId,
        }, 'trader: stop_loss_force_close — cancelled live SELL');
      } catch (err) {
        // -2011 Unknown order (already filled/cancelled) → log info, continue
        const fe = binanceRest.formatBinanceError(err);
        if (fe.code === -2011) {
          // CRITICAL FIX (FIX-2026-07-23b): -2011 อาจหมายถึง SELL เพิ่ง FILL ที่ TP target
          //   - ถ้า fill แล้วจริง → ห้าม place MARKET SELL อีก (จะ double-sell)
          //   - ต้อง re-fetch order → ถ้า status=FILLED → record fill แทน, ออกจาก stop-loss flow
          //   - ถ้า status=CANCELED → asset ยังอยู่ → ทำ MARKET SELL ตามปกติ
          try {
            const fresh = await binanceRest.getOrder({
              symbol: this.bot.symbol,
              orderId: trade.sellOrderId,
            });
            if (fresh && fresh.status === 'FILLED') {
              const filledQty = parseFloat(fresh.executedQty);
              const avgSell = parseFloat(fresh.price)
                || parseFloat(fresh.avgPrice)
                || (parseFloat(fresh.cummulativeQuoteQty) / filledQty);
              const feeRate = fees.getMakerRate();
              const pnl = fees.calcPnl({
                buyPrice: parseFloat(trade.buyPrice),
                sellPrice: avgSell,
                qty: filledQty,
                feeRate,
              });
              const upd = await Trade.updateOne(
                { _id: claim._id, state: 'stopping' },
                {
                  state: 'sold',
                  sellOrderId: fresh.orderId,
                  sellPrice: avgSell,
                  sellQty: filledQty,
                  sellQuoteQty: parseFloat(fresh.cummulativeQuoteQty),
                  sellStatus: 'FILLED',
                  sellFilledAt: new Date(fresh.updateTime || Date.now()),
                  realizedPnl: pnl.net,
                  pnlPercent: pnl.pnlPercent,
                  error: `stop_loss_upper_kc — SELL already filled at TP before stop-loss cancelled (close=${ctx.closePrice} > upperKC=${ctx.upperKC.toFixed(6)})`,
                  // FIX-2026-07-31 (F1): reset SL-on-UKC auto-arm flag
                  useStopLossOnUKC: false,
                  autoArmedAt: null,
                  // FIX-2026-08-03: clear F1 threshold snapshots เมื่อ trade ออกจาก selling
                  autoArmLossPct: null,
                  autoArmAgeHours: null,
                  // FIX-2026-08-01: reset SELL partial-fill latch on state-out-of-selling
                  sellPartialDetectedAt: null,
                  sellPartialLatchedAt: null,
                  sellPartialLatchedReason: null,
                }
              );
              if (upd.modifiedCount === 1) {
                await Bot.updateOne(
                  { _id: this.bot._id },
                  {
                    $inc: {
                      totalPnl: pnl.net,
                      totalTrades: 1,
                      winTrades: (pnl.net > 0 ? 1 : 0),
                    },
                    $set: { status: 'idle', lastError: '' },
                  }
                );
                this._unregisterTrade(trade);
                if (this.currentTrade && this.currentTrade._id.toString() === trade._id.toString()) {
                  this.currentTrade = null;
                }
                eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
                // FIX-2026-08-01: stop-loss race recovery — SELL filled at TP before stop-loss cancellation
                eventBus.emit('trade:update', {
                  tradeId: claim._id,
                  botId: this.bot._id,
                  state: 'sold',
                  reason: trade.sellReason || 'race_recovery_filled',
                  reasonDetail: trade.sellReasonDetail || `stop_loss_upper_kc: SELL already FILLED at TP (close=${ctx.closePrice} > upperKC=${ctx.upperKC.toFixed(6)})`,
                });
                logger.warn({
                  botId: this.bot._id.toString(),
                  tradeId: claim._id.toString(),
                  sellOrderId: trade.sellOrderId,
                  filledQty, avgSell, pnl: pnl.net,
                }, 'trader: stop_loss_force_close — SELL already FILLED at TP, recorded (no MARKET placed)');
              } else {
                logger.debug({
                  tradeId: claim._id.toString(),
                }, 'trader: stop_loss_force_close — race with WS handleSellFilled, abort');
              }
              return; // ออกจาก stop-loss flow — ไม่ place MARKET SELL
            }
            // status = CANCELED หรืออื่นๆ → asset ยังอยู่ → ทำ MARKET SELL ตามปกติ
            logger.info({
              tradeId: trade._id.toString(),
              sellOrderId: trade.sellOrderId,
              freshStatus: fresh.status,
            }, 'trader: stop_loss_force_close — SELL gone but not FILLED, proceeding to MARKET');
          } catch (fetchErr) {
            // getOrder fail (เช่น network) → fallback ไป MARKET SELL ตามปกติ (ตามเดิม)
            logger.warn({
              err: fetchErr.message,
              tradeId: trade._id.toString(),
              sellOrderId: trade.sellOrderId,
            }, 'trader: stop_loss_force_close — getOrder after -2011 failed, proceeding to MARKET');
          }
        } else {
          logger.warn({
            err: fe,
            tradeId: trade._id.toString(),
            sellOrderId: trade.sellOrderId,
          }, 'trader: stop_loss_force_close — cancel SELL failed, proceeding to MARKET anyway');
        }
      }
    }

    // 2. MARKET SELL (re-use _emergencyMarketSell — guard ตอนนี้รวม 'stopping' แล้ว)
    // FIX-2026-08-02: DCA stack — use stackBep + stackTotalQty
    const qty = isStack
      ? stackTotalQty
      : (parseFloat(trade.sellQty) || parseFloat(trade.buyQty) || 0);
    const buyPrice = isStack
      ? stackBep
      : (parseFloat(trade.buyPrice) || 0);
    const targetSell = parseFloat(trade.targetSellPrice) || 0;
    if (qty <= 0 || buyPrice <= 0) {
      logger.error({
        tradeId: claim._id.toString(),
        isStack, qty, buyPrice,
      }, 'trader: stop_loss_force_close — invalid qty/buyPrice, marking failed');
      await Trade.updateOne(
        { _id: claim._id, state: 'stopping' },
        { state: 'failed', error: 'stop_loss: invalid qty/buyPrice',
          // FIX-2026-07-31 (F1): reset SL-on-UKC auto-arm flag
          useStopLossOnUKC: false,
          autoArmedAt: null,
          // FIX-2026-08-03: clear F1 threshold snapshots เมื่อ trade ออกจาก selling
          autoArmLossPct: null,
          autoArmAgeHours: null,
          // FIX-2026-08-01: reset SELL partial-fill latch
          sellPartialDetectedAt: null,
          sellPartialLatchedAt: null,
          sellPartialLatchedReason: null,
        }
      );
      return;
    }

    // FIX-2026-08-09: แยก SL-UKC F1-armed (auto-armed by F1) vs manual (bot.stopLossOnUpperKC=true)
    //   - F1 auto-arms useStopLossOnUKC=true + autoArmedAt เมื่อ loss>10% + age>4h
    //   - manual = bot.stopLossOnUpperKC=true (admin enabled in bot config)
    //   - DCA stack branch ใช้ dca_stack_stop_loss เหมือนเดิม (เป็น category แยก)
    const wasF1Armed = !isStack
      && trade.useStopLossOnUKC === true
      && trade.autoArmedAt != null;
    const slUkcReason = wasF1Armed ? 'sl_ukc_f1_armed' : 'sl_ukc_manual';
    const reasonText = isStack
      ? `${stackReason} (stackBep=${stackBep?.toFixed(6)}, close=${ctx.closePrice} > upperKC=${ctx.upperKC.toFixed(6)}, f1Armed=${wasF1Armed})`
      : `stop_loss_upper_kc (close=${ctx.closePrice} > upperKC=${ctx.upperKC.toFixed(6)}, f1Armed=${wasF1Armed})`;
    const ok = await this._emergencyMarketSell(
      claim,
      qty,
      buyPrice,
      targetSell,
      reasonText,
      // FIX-2026-08-09: pass explicit sellReason (sl_ukc_f1_armed vs sl_ukc_manual)
      //   - เดิมใช้ default 'stop_loss_upper_kc' แต่ไม่บอกว่าเป็น auto-armed หรือ manual
      //   - DCA stack path ยังคงใช้ 'dca_stack_stop_loss' (override ใน post-sell block ด้านล่าง)
      { reason: isStack ? 'dca_stack_stop_loss' : slUkcReason },
    );

    if (!ok) {
      // FIX E4: MARKET fail → fallback ไป holding + scheduleHoldingRetry
      logger.error({
        tradeId: claim._id.toString(),
        isStack,
      }, 'trader: stop_loss_force_close — MARKET SELL failed, fallback to holding retry');
      await Trade.updateOne(
        { _id: claim._id },
        { state: 'holding', error: 'stop_loss MARKET SELL failed — will retry' }
      );
      await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
      eventBus.emit('trade:update', {
        tradeId: claim._id,
        state: 'holding',
        reason: null,
        reasonDetail: null,
      });
      this.scheduleHoldingRetry(claim, qty, buyPrice, targetSell);
      return;
    }

    // FIX-2026-08-02: DCA stack — stamp stackClosedAt + override sellReason
    //   - _emergencyMarketSell ตั้ง sellReason='stop_loss_upper_kc' default → เปลี่ยนเป็น 'dca_stack_stop_loss'
    if (isStack) {
      await Trade.updateOne(
        { _id: claim._id },
        {
          stackClosedAt: new Date(),
          sellReason: stackReason,
          sellReasonDetail: reasonText,
          sellReasonAt: new Date(),
          sellReasonSource: '_stopLossForceClose_dca',
        }
      );
    }
  }

  // ─── Signal Detection ─────────────────────────────
  async onCandleClosed(candle, opts = {}) {
    if (!this.running) return;
    if (!this.bot.enabled) return;

    // ต้อง warm-up ก่อน
    if (!signalEngine.isWarmedUp(klineCache.size(this.bot.symbol, this.bot.timeframe))) {
      logger.debug({ botId: this.bot._id.toString() }, 'trader: waiting for warm-up');
      return;
    }

    // FIX P1.1: status='error' recovery — ถ้าบอทค้างใน error (เช่น placeBuy throw ตอน candle นี้)
    //   → ก่อน process candle ใหม่ reset เป็น idle เพื่อให้ trade loop กลับมาทำงาน
    //   - เดิม: ค้างที่ 'error' จนกว่า user จะ manually restart → bot ตาย
    //   - fix: candle ใหม่มา = auto-recover (สมมุติว่า error นั้น transient)
    if (this.bot.status === 'error' && !opts.replay) {
      logger.info({
        botId: this.bot._id.toString(),
        candleCloseTime: candle.closeTime,
      }, 'trader: auto-recovering from status=error on new candle');
      this._setBotStatus('idle', { lastError: '' });
    }

    // FIX-2026-07-15: in replay mode (called by reconcileKlines), candle อาจจะอยู่ "ก่อน"
    //   candles ที่ in-memory klineCache มีอยู่ ณ ปัจจุบัน (เพราะ WS ได้รับ candles ใหม่กว่าไปแล้ว)
    //   - ต้อง push candle นี้เข้า cache ก่อน (เพื่อให้ signal detection รันบน history ที่ตรง)
    //   - แล้ว advance lastSignalIndex ให้ตรง candle ที่ replay
    // - ในโหมดปกติ (จาก WS kline:closed), candle คือล่าสุดของ cache อยู่แล้ว
    // - ใช้ klineCache.seed() (มีอยู่แล้ว) โดยอ่าน cache ปัจจุบัน + append candle แล้วเขียนกลับ
    //   (หลีกเลี่ยงการเพิ่ม method ใหม่ใน klineCache)
    let replayedKlines = false;
    if (opts.replay) {
      const klines = klineCache.getAll(this.bot.symbol, this.bot.timeframe);
      // ถ้า candle.closeTime > cache.lastCandleCloseTime → append เข้า cache (replay candle ใหม่กว่าที่ cache มี)
      if (klines.length === 0 || candle.closeTime > klines[klines.length - 1].closeTime) {
        const symbol = this.bot.symbol;
        const timeframe = this.bot.timeframe;
        const merged = klines.concat([{
          symbol,
          timeframe,
          openTime: candle.openTime,
          closeTime: candle.closeTime,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume || 0,
          isClosed: true,
        }]);
        // seed() จะ slice(-maxCandles) ให้อัตโนมัติ
        klineCache.seed(merged);
        replayedKlines = true;
      }
    }

    const klines = klineCache.getAll(this.bot.symbol, this.bot.timeframe);
    const latestIdx = klines.length - 1;
    // FIX-2026-07-15: during replay, candle อาจจะอยู่ก่อน lastSignalIndex ใน array
    //   แต่ยังใหม่กว่า bot.lastSignalCloseTime (ที่ persist ใน DB)
    //   - ปัญหาเดิม: ใช้ `latestIdx <= lastSignalIndex` → replay candle เก่าใน cache = skip ทั้งหมด
    //   - fix: ถ้า opts.replay ให้ใช้ lastSignalCloseTime (DB) เป็น gate
    //          ถ้าไม่ใช่ replay → ใช้ lastSignalIndex (in-memory) เหมือนเดิม
    if (opts.replay) {
      const lastSigMs = this.bot.lastSignalCloseTime || 0;
      if (candle.closeTime <= lastSigMs) return; // signal เก่าแล้ว (เคย process แล้ว)
    } else {
      if (latestIdx <= this.lastSignalIndex) return; // signal เก่าแล้ว
    }

    // FIX-2026-07-31 (F1): auto-arm SL-on-UKC for stuck losing positions
    //   - trigger: position loss > bot.autoArmLossPct (default 10%) AND age > bot.autoArmAgeHours (default 4h) AND state='selling'
    //   - sets trade.useStopLossOnUKC=true → _checkStopLossOnUpperKC จะยอม trigger
    //   - run ทุก candle (mirror CB pattern) — early return ภายใน helper ถ้า pattern ไม่ match
    //   - ต้อง call ก่อน S1 logic เพราะ arm ต้องเสร็จก่อน candle ถัดไป (sync เป็น async)
    // FIX-2026-08-01 (audit M1/R3): AWAIT F1 ก่อน — กัน race กับ _checkStopLossOnUpperKC ที่ query ใน candle เดียวกัน
    await this._autoArmStopLossOnUKC(candle);

    // FIX-2026-08-01: CB panic-sell moved to direct kline:closed subscription
    //   (see start() _cbKlineHandler). Reason: onCandleClosed() is gated by
    //   lastSignalIndex (line 1105) which only advances on S1 signals — dump candles
    //   with no S1 trigger bypass CB entirely. Direct subscription runs the
    //   pattern check on every candle close regardless of S1 state.
    //   reconcileKlines also force-calls CB on the last missed candle to cover
    //   WS-outage replays (see end of for-loop below).

    // FIX-2026-07-15: ในโหมด replay ต้องตรวจ S1 ที่ candle ที่กำลัง replay (อาจจะอยู่ก่อน cache tail)
    //   ปัญหาเดิม: checkS1OnLatestCandle ตรวจแค่ klines[klines.length-1] (cache tail)
    //   ถ้า candle ที่ replay อยู่ก่อน cache tail จะตรวจผิด candle
    //   fix: ใช้ detectS1Signals แล้วเลือก signal ที่ closeTime ตรงกับ candle.closeTime
    //        ถ้าไม่ใช่ replay → checkS1OnLatestCandle เหมือนเดิม
    let signal = null;
    let xs1Skipped = false;
    // FIX-2026-07-25: per-bot XS1 toggle
    //   - xs1Enabled=true (default) → skip candle-wide dump (XS1=skip)
    //   - xs1Enabled=false → ใช้สัญญาณดั้งเดิม (S1 ปกติ, ไม่ skip)
    const s1Opts = {
      mult: this.bot.kcMult || 1.5,
      onlyDown: !!this.bot.s1OnlyDown,
      xs1Enabled: this.bot.xs1Enabled !== false,
    };
    if (opts.replay) {
      // FIX-2026-07-24: per-bot kcMult
      // FIX-2026-07-24: ส่ง onlyDown ตาม bot.s1OnlyDown (ถ้า true → skip bg 2→1)
      // FIX-2026-07-25: ส่ง xs1Enabled ตาม bot.xs1Enabled (per-bot toggle)
      const { signals } = signalEngine.detectS1Signals(klines, s1Opts);
      // หา signal ที่มี closeTime === candle.closeTime และใหม่กว่า lastSignalCloseTime
      const lastSigMs = this.bot.lastSignalCloseTime || 0;
      for (let i = signals.length - 1; i >= 0; i -= 1) {
        const s = signals[i];
        if (s.closeTime === candle.closeTime && s.closeTime > lastSigMs) {
          signal = s;
          break;
        }
      }
      // FIX-2026-07-25: ถ้า candle นี้เป็น S1 base match แต่ถูก filter จาก XS1
      //   → บันทึก audit row เพื่อให้เห็นใน Trade & Signal History
      if (!signal) {
        const baseCheck = signalEngine.checkS1OnLatestCandle(klines, s1Opts);
        // FIX-2026-07-25: ถ้า xs1Enabled=false → ไม่นับเป็น xs1Skipped (สัญญาณดั้งเดิมไม่ต้อง skip)
        if (baseCheck.xs1 && baseCheck.signal && this.bot.xs1Enabled !== false) {
          const s = baseCheck.signal;
          if (s.closeTime === candle.closeTime && s.closeTime > lastSigMs) {
            xs1Skipped = true;
            logger.info({
              botId: this.bot._id.toString(),
              symbol: this.bot.symbol,
              candleCloseTime: candle.closeTime,
              close: s.close,
              basisKC: s.basisKC, lowerKC: s.lowerKC,
            }, 'S1 signal skipped (XS1 anti-dump)');
            try {
              await Signal.create({
                botId: this.bot._id,
                symbol: this.bot.symbol,
                timeframe: this.bot.timeframe,
                type: 'S1',
                candleOpenTime: new Date(s.openTime),
                candleCloseTime: new Date(s.closeTime),
                closePrice: s.close,
                basisKC: s.basisKC,
                upperKC: s.upperKC,
                lowerKC: s.lowerKC,
                bgState: s.bgState,
                bgPrev: s.bgPrev,
                outcome: 'skipped',
                note: 'xs1_dumped',
              });
            } catch (err) {
              logger.warn({ err: err.message }, 'trader: failed to save xs1 audit row');
            }
          }
        }
      }
      if (xs1Skipped) {
        // FIX P1.6: ตอนนี้ persist audit แล้ว → early return พร้อม run stop-loss (mirror live path)
        //   เดิม: xs1Skipped = true แต่ flow ทำต่อ → hit `if (!signal) return` โดยไม่ run stop-loss
        //   fix: return ที่นี่แทน + รัน _checkStopLossOnUpperKC เพื่อ parity กับ live path
        this._checkStopLossOnUpperKC(candle).catch((err) =>
          logger.error({ err: err.message, stack: err.stack }, 'trader: stop_loss check threw'));
        return;
      }
    } else {
      // FIX-2026-07-24: per-bot kcMult + s1OnlyDown (skip bg 2→1)
      // FIX-2026-07-25: คืน { signal, xs1 } — xs1=true = S1 base match แต่ candle-wide dump → skip
      // FIX-2026-07-25: per-bot xs1Enabled toggle (false = ใช้สัญญาณดั้งเดิม, ไม่ skip)
      const live = signalEngine.checkS1OnLatestCandle(klines, s1Opts);
      // FIX-2026-07-25: ถ้า xs1Enabled=false → ไม่ skip แม้ live.xs1=true (ใช้ signal ปกติ)
      if (live.xs1 && this.bot.xs1Enabled !== false) {
        // FIX-2026-07-25: S1 base match แต่ candle-wide dump → skip ทันที + persist audit
        logger.info({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          candleCloseTime: candle.closeTime,
          close: candle.close,
          basisKC: live.signal ? live.signal.basisKC : null,
          lowerKC: live.signal ? live.signal.lowerKC : null,
        }, 'S1 signal skipped (XS1 anti-dump)');
        try {
          if (live.signal) {
            await Signal.create({
              botId: this.bot._id,
              symbol: this.bot.symbol,
              timeframe: this.bot.timeframe,
              type: 'S1',
              candleOpenTime: new Date(live.signal.openTime),
              candleCloseTime: new Date(live.signal.closeTime),
              closePrice: live.signal.close,
              basisKC: live.signal.basisKC,
              upperKC: live.signal.upperKC,
              lowerKC: live.signal.lowerKC,
              bgState: live.signal.bgState,
              bgPrev: live.signal.bgPrev,
              outcome: 'skipped',
              note: 'xs1_dumped',
            });
          }
        } catch (err) {
          logger.warn({ err: err.message }, 'trader: failed to save xs1 audit row');
        }
        // stop-loss check ยังคงต้องรัน
        this._checkStopLossOnUpperKC(candle).catch((err) =>
          logger.error({ err: err.message, stack: err.stack }, 'trader: stop_loss check threw'));
        return;
      }
      signal = live.signal;
    }
    if (!signal) {
      // FIX-2026-07-23: ไม่มี S1 signal แต่ candle ใหม่ — ยังต้องเช็ค stop-loss (อาจมี position ขาดทุนที่ต้องปิด)
      //   - ไม่ return เพราะ stop-loss เป็น concern แยกจาก S1 detection
      //   - run async แบบไม่ block (ถ้า throw ก็ catch ในตัวเอง)
      this._checkStopLossOnUpperKC(candle).catch((err) =>
        logger.error({ err: err.message, stack: err.stack }, 'trader: stop_loss check threw'));
      return;
    }
    // FIX-2026-07-23: มี S1 signal — ก่อนจะ place BUY ให้ปิด losing position ก่อน (ถ้ามี)
    //   - เคส candle ทะลุ upper-KC และมี position ขาดทุน → ปิดก่อน แล้วค่อยเปิดใหม่ (ถ้า TP รอบใหม่มา)
    //   - ถ้าไม่มี stop-loss path → ไม่กระทบ S1 signal ปกติ
    this._checkStopLossOnUpperKC(candle).catch((err) =>
      logger.error({ err: err.message, stack: err.stack }, 'trader: stop_loss check threw'));
    // FIX BUG-2026-07-31: CB panic-sell ถูกย้ายไป entry-point ของ onCandleClosed (ก่อน S1 logic)
    //   เพื่อให้ trigger ทุก candle ไม่ใช่เฉพาะตอนมี S1 signal

    // กันยิงซ้ำ
    this.lastSignalIndex = latestIdx;
    // FIX-2026-07-15: persist lastSignalCloseTime (epoch ms) for crash/WS-gap recovery
    const candleCloseMs = candle.closeTime;
    Bot.updateOne(
      { _id: this.bot._id },
      { $max: { lastSignalCloseTime: candleCloseMs }, lastSignalAt: new Date() }
    ).catch((err) => logger.warn({ err: err.message }, 'trader: persist lastSignalCloseTime failed'));
    this.bot.lastSignalCloseTime = candleCloseMs;
    if (opts.replay && replayedKlines) {
      logger.info({
        botId: this.bot._id.toString(),
        trigger: opts.trigger || 'replay',
        candleCloseMs,
      }, 'trader: replay signal accepted');
    }

    logger.info({
      botId: this.bot._id.toString(),
      symbol: this.bot.symbol,
      candleCloseTime: candle.closeTime,
      close: signal.close,
    }, 'S1 signal detected');

    // บันทึก signal
    let signalDoc;
    try {
      signalDoc = await Signal.create({
        botId: this.bot._id,
        symbol: this.bot.symbol,
        timeframe: this.bot.timeframe,
        type: 'S1',
        candleOpenTime: new Date(candle.openTime),
        candleCloseTime: new Date(candle.closeTime),
        closePrice: signal.close,
        basisKC: signal.basisKC,
        upperKC: signal.upperKC,
        lowerKC: signal.lowerKC,
        bgState: signal.bgState,
        bgPrev: signal.bgPrev,
        outcome: 'detected',
      });
    } catch (err) {
      logger.error({ err: err.message }, 'trader: failed to save signal');
      return;
    }

    eventBus.emit('signal:new', { signalId: signalDoc._id, signal: signalDoc });

    // FIX-2026-07-13b: ลบ single-position lock เดิม — `currentTrade` ไม่ใช่ตัวนับ trade ทั้งหมด
    //   (มันเป็น pointer ของ trade ที่กำลัง retry/monitor เท่านั้น, ไม่ใช่ active slot counter)
    //   การล็อกที่บรรทัดเดิมทำให้บอท single-position ตลอด ทั้งที่ออกแบบให้รัน maxTrades ไม้พร้อมกัน
    //   ตอนนี้ใช้แค่ Trade.countDocuments เช็ค slot ตามที่ตั้งใจไว้

    // เช็คจำนวนไม้ (นับ trades ที่ยังไม่จบ — placed/filled/holding/selling)
    const activeTrades = await Trade.countDocuments({
      botId: this.bot._id,
      state: { $in: ['placed', 'filled', 'holding', 'selling'] },
    });
    if (activeTrades >= this.bot.maxTrades) {
      logger.info({
        botId: this.bot._id.toString(),
        activeTrades, maxTrades: this.bot.maxTrades,
      }, 'trader: max trades reached');
      await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'maxTrades reached' });
      return;
    }

    // FIX-2026-08-01: Safe-trade filter (default ON)
    //   - ก่อนวาง BUY ให้เช็ค super-upper TF (3m/5m→4h, 15m→1d, 1h→1w)
    //   - PASS = lastClose > open (green) OR lastClose > ema20 (uptrend)
    //   - FAIL-OPEN on Binance error (API outage ไม่ block การเทรด)
    //   - skip BUY ทันทีถ้า fail (don't waste signal slot)
    if (this.bot.safeTradeEnabled !== false) {
      try {
        const st = await signalEngine.checkSafeTrade(this.bot, binanceRest, indicators);
        if (st.skip) {
          logger.info({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            tf: this.bot.timeframe,
            superTF: st.superTF,
            greenCandle: st.greenCandle,
            aboveEma: st.aboveEma,
            lastClose: st.lastClose,
            lastEma: st.lastEma,
          }, 'trader: safe-trade blocked BUY');
          await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'safe_trade_block' });
          try {
            eventBus.emit('safe_trade:blocked', {
              botId: String(this.bot._id),
              symbol: this.bot.symbol,
              timeframe: this.bot.timeframe,
              superTF: st.superTF,
            });
          } catch (_) {}
          return; // do NOT place buy
        }
        // safe-trade PASS or fail-open — log only at debug (no spam on every signal)
        if (st.reason === 'pass') {
          logger.debug({ botId: this.bot._id.toString(), superTF: st.superTF, greenCandle: st.greenCandle, aboveEma: st.aboveEma }, 'trader: safe-trade PASS');
        } else if (st.reason !== 'disabled' && st.reason !== 'no_super_tf') {
          // fail-open reason (insufficient_data_open, api_error_open) — log warning
          logger.warn({ botId: this.bot._id.toString(), reason: st.reason, error: st.error }, 'trader: safe-trade fail-open — allowing BUY');
        }
      } catch (err) {
        // fail-open on unexpected exception (defensive)
        logger.warn({ err: err.message, botId: this.bot._id.toString() }, 'trader: safe-trade check threw — allowing BUY');
      }
    }

    // FIX-2026-08-03: Safe-trade filter #2 — LuxAlgo red pivot-low trendline support (opt-in, default OFF)
    //   - หลัง ST#1 ผ่าน: ตรวจ upper-TF (TREND_TF_MAP) — current price > trendline?
    //   - PASS = lastClose > trendline value at current bar → BUY
    //   - FAIL-OPEN on Binance error / warmup / insufficient data (mirror ST#1)
    //   - **ไม่แนะนำสำหรับ DCA bots** (DCA ซื้อ dip — filter นี้ block dip-buy → ขัดกับ DCA intent)
    //   - ทำงานคู่กับ ST#1: ST#1 = "ขาขึ้นบน super-upper TF" + ST#2 = "ราคายังอยู่เหนือ support บน upper-TF"
    if (this.bot.safeTradeTrendlineEnabled === true) {
      try {
        const trendTF = volatilityScanner.TREND_TF_MAP && volatilityScanner.TREND_TF_MAP[this.bot.timeframe];
        const st2 = await signalEngine.checkSafeTradeTrendline(this.bot, trendTF, binanceRest);
        if (st2.skip) {
          logger.info({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            tf: this.bot.timeframe,
            trendTF: st2.trendTF,
            lastClose: st2.lastClose,
            trendlineValue: st2.trendlineValue,
            gapPct: st2.gapPct != null ? Number(st2.gapPct.toFixed(3)) : null,
            pivotCount: st2.pivotCount,
          }, 'trader: safe-trade trendline blocked BUY');
          await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'safe_trade_trendline_block' });
          try {
            eventBus.emit('safe_trade_trendline:blocked', {
              botId: String(this.bot._id),
              symbol: this.bot.symbol,
              timeframe: this.bot.timeframe,
              trendTF: st2.trendTF,
              lastClose: st2.lastClose,
              trendlineValue: st2.trendlineValue,
              gapPct: st2.gapPct,
            });
          } catch (_) {}
          return; // do NOT place buy
        }
        // trendline PASS or fail-open — log at debug for PASS, warn for fail-open
        if (st2.reason === 'pass') {
          logger.debug({
            botId: this.bot._id.toString(),
            trendTF: st2.trendTF,
            gapPct: st2.gapPct,
          }, 'trader: safe-trade trendline PASS');
        } else if (st2.reason !== 'disabled' && st2.reason !== 'no_trend_tf') {
          // fail-open reason (warmup, insufficient_data_open, api_error_open) — log warning
          logger.warn({
            botId: this.bot._id.toString(),
            reason: st2.reason,
            error: st2.error,
          }, 'trader: safe-trade trendline fail-open — allowing BUY');
        }
      } catch (err) {
        // fail-open on unexpected exception (defensive)
        logger.warn({ err: err.message, botId: this.bot._id.toString() }, 'trader: safe-trade trendline check threw — allowing BUY');
      }
    }

    // FIX-2026-08-05: Safe-trade filter #3 — Pine "No-Trade Signal Engine" (engulfing + shooting star)
    //   - หลัง ST#1 + ST#2 ผ่าน: ตรวจ upper-TF (TREND_TF_MAP) — แท่งล่าสุดมี nt/nt1 pattern หรือไม่
    //   - PASS = lastKind === 'none' → BUY
    //   - FAIL-OPEN on Binance error / insufficient data / no_trend_tf (mirror ST#1/ST#2)
    //   - **ไม่แนะนำสำหรับ DCA bots** (DCA ซื้อ dip — filter นี้ block dip-buy → �ัดกับ DCA intent)
    //   - **Real-time**: Binance REST returns last candle ที่ยังไม่ close (close = live price) → check ทันที (ไม่รอ kline:closed)
    //   - ใช้ bot.kcMult (per-bot) ผ่าน checkNoTradeOnUpperTF (FIX: ให้ consistent กับ S1 detection)
    // FIX-2026-08-05: ST#3 disabled for DCA bots (UI warns "not recommended for DCA")
    //   - DCA intent = buy dips — filter = block dip-buys → ขัดกัน
    //   - Wizard layer-add ของ DCA ใช้ placeBuy path เดียวกัน → ต้อง bypass filter
    if (this.bot.safeTradeNoTradeEnabled === true && !this._isDcaMode()) {
      try {
        const trendTF = volatilityScanner.TREND_TF_MAP && volatilityScanner.TREND_TF_MAP[this.bot.timeframe];
        const st3 = await signalEngine.checkNoTradeOnUpperTF(this.bot, trendTF, binanceRest);
        if (st3.skip) {
          logger.info({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            tf: this.bot.timeframe,
            trendTF: st3.trendTF,
            lastKind: st3.lastKind,
            lastClose: st3.lastClose,
            kcMult: st3.kcMult,
          }, 'trader: safe-trade no-trade blocked BUY');
          await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'safe_trade_no_trade_block' });
          try {
            eventBus.emit('safe_trade_no_trade:blocked', {
              botId: String(this.bot._id),
              symbol: this.bot.symbol,
              timeframe: this.bot.timeframe,
              trendTF: st3.trendTF,
              lastKind: st3.lastKind,
              lastClose: st3.lastClose,
              kcMult: st3.kcMult,
            });
          } catch (_) {}
          return; // do NOT place buy
        }
        // PASS or fail-open — log only when meaningful
        if (st3.reason === 'pass') {
          logger.debug({
            botId: this.bot._id.toString(),
            trendTF: st3.trendTF,
            lastKind: st3.lastKind,
          }, 'trader: safe-trade no-trade PASS');
        } else if (st3.reason !== 'disabled' && st3.reason !== 'no_trend_tf') {
          logger.warn({
            botId: this.bot._id.toString(),
            reason: st3.reason,
            error: st3.error,
          }, 'trader: safe-trade no-trade fail-open — allowing BUY');
        }
      } catch (err) {
        // fail-open on unexpected exception (defensive)
        logger.warn({ err: err.message, botId: this.bot._id.toString() }, 'trader: safe-trade no-trade check threw — allowing BUY');
      }
    }

    // FIX-2026-08-11: CBv5 pre-BUY check (race: S1 + CBv5 on same candle)
    //   - CBv5 only blocks BUY AFTER it fires (cbv5LockHours cooldown).
    //   - When S1 fires on the same candle that CBv5 matches, BUY is placed
    //     before the WS handler persists cbv5LockedUntil.
    //   - Fix: pre-check the same candle against CBv5 here, alongside ST#3.
    //   - Per-bot opt-out: bot.cbv5Enabled === false → skip
    //   - DCA mode: skip (mirror ST#3 behavior)
    //   - Mutual: if CBv2/CBv3 already locked → skip pre-check (cooldown gate blocks anyway)
    if (this.bot.cbv5Enabled !== false && !this._isDcaMode() && !this._hasActiveCbCooldownExceptV5()) {
      try {
        const evalResult = await cbPatternEvaluator.fetchAndEvaluateCBv5({
          bot: this.bot,
          binanceRest,
          targetCloseTime: candle.closeTime,
        });
        if (evalResult.ok && evalResult.matched) {
          logger.warn({
            botId: this.bot._id.toString(),
            signalId: signalDoc._id.toString(),
            symbol: this.bot.symbol,
            targetCloseTime: candle.closeTime,
            lastLower: evalResult.lastLower ? evalResult.lastLower.toFixed(8) : null,
            deepestLow: evalResult.deepestLow ? evalResult.deepestLow.toFixed(8) : null,
            fingerprint: evalResult.fingerprint,
            reason: 'cbv5_pre_buy_block',
          }, 'trader: CBv5 pre-BUY block — CBv5 matched on S1 candle, defer to WS handler for force-close');
          await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'cbv5_pre_buy_block' });
          try {
            eventBus.emit('cbv5:pre_buy_block', {
              botId: this.bot._id.toString(),
              signalId: signalDoc._id.toString(),
              targetCloseTime: candle.closeTime,
              fingerprint: evalResult.fingerprint,
            });
          } catch (_) { /* non-fatal */ }
          return;
        }
      } catch (err) {
        logger.warn({ err: err.message, botId: this.bot._id.toString() }, 'trader: CBv5 pre-BUY check threw — allowing BUY (fail-OPEN)');
      }
    }

    await this.placeBuy(signalDoc, candle);
  }

  // ─── BUY logic ─────────────────────────────────────
  async placeBuy(signalDoc, candle) {
    try {
      // FIX-2026-08-01 (audit H1/R4): CB fire-suppression gate
      //   - ถ้า CB เพิ่ง panic-close ภายใน CB_SUPPRESS_MS → skip BUY ทันที
      //   - กัน S1 BUY วางบน candle ที่เพิ่ง trigger panic-close (race เดิม: CB fire-and-forget
      //     + S1 detect sync → ทั้งคู่ run ใน onCandleClosed เดียวกัน)
      //   - ตั้ง suppress ใน _checkCBPanicClose หลัง force-close loop สำเร็จ
      if (this._cbFiredAt > 0 && (Date.now() - this._cbFiredAt) < CB_SUPPRESS_MS) {
        const remainingMs = CB_SUPPRESS_MS - (Date.now() - this._cbFiredAt);
        logger.warn({
          botId: this.bot._id.toString(),
          signalId: signalDoc._id.toString(),
          sinceCbMs: Date.now() - this._cbFiredAt,
          remainingMs,
        }, 'trader: skip BUY — CB panic-close suppression active');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'cb_suppress' });
        return;
      }

      // FIX-2026-08-07: CBv2 cooldown gate (HYBRID mode — replaces short 30s suppression)
      //   - HYBRID: CBv2 force-closes positions + sets BUY cooldown cbv2LockHours hours
      //   - บอทยัง enabled + Auto-pause ยังทำงาน — gate นี้แค่กั้น S1 BUY ในช่วง cooldown
      //   - dynamic duration: cbv2LockHours (user-configurable per bot, default 8)
      //   - ถ้า user เปลี่ยน cbv2LockHours ระหว่าง cooldown → window ปรับตามทันที (computed on-the-fly)
      //   - ผู้ใช้ปลด cooldown manual ผ่าน POST /api/bots/:id/unlock-cbv2 ได้ (reset _cbv2FiredAt)
      // FIX-2026-08-08: Feature #2 — CBv3 cooldown gate (mirror CBv2 schema)
      //   - mutually exclusive: cbVersion='v2' → CBv2 gate fires, 'v3' → CBv3 gate fires
      //   - both gates share the same unlock endpoint (POST /api/bots/:id/unlock-cbv2)
      const { evaluateCbCooldown } = require('./cbCooldownGate');
      const cbv2Gate = evaluateCbCooldown(this, this.bot, 'v2', Date.now());
      if (cbv2Gate.active) {
        logger.warn({
          botId: this.bot._id.toString(),
          signalId: signalDoc._id.toString(),
          sinceCbv2Ms: this._cbv2FiredAt > 0 ? Date.now() - this._cbv2FiredAt : null,
          cooldownMs: (Math.max(0.5, Math.min(168, Number(this.bot.cbv2LockHours) || 8))) * 3600 * 1000,
          remainingMs: cbv2Gate.remainingMs,
          cbv2LockedUntil: this.bot.cbv2LockedUntil,
          source: cbv2Gate.source,
        }, 'trader: skip BUY — CBv2 cooldown active (hybrid mode)');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'cbv2_cooldown' });
        return;
      }
      // FIX-2026-08-09: ACEUSDT cooldown-bypass incident — CBv3 fired externally (positionWatchdog
      //   Phase 4) writes DB `cbv3LastFiredAt` + `cbv3LockedUntil` but never sets `this._cbv3FiredAt`
      //   in memory. Pre-fix gate only consulted in-memory flag → trader opened 5 BUYs in 2.5h.
      //   Fix: ALSO consult DB `bot.cbv3LockedUntil` (authoritative across restart + external writers)
      //   via cbCooldownGate.evaluateCbCooldown().
      const cbv3Gate = evaluateCbCooldown(this, this.bot, 'v3', Date.now());
      if (cbv3Gate.active) {
        logger.warn({
          botId: this.bot._id.toString(),
          signalId: signalDoc._id.toString(),
          sinceCbv3Ms: this._cbv3FiredAt > 0 ? Date.now() - this._cbv3FiredAt : null,
          cooldownMs: (Math.max(0.5, Math.min(168, Number(this.bot.cbv3LockHours) || 8))) * 3600 * 1000,
          remainingMs: cbv3Gate.remainingMs,
          cbv3LockedUntil: this.bot.cbv3LockedUntil,
          source: cbv3Gate.source,
        }, 'trader: skip BUY — CBv3 cooldown active (hybrid mode)');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'cbv3_cooldown' });
        return;
      }
      // FIX-2026-08-10: CBv5 cooldown gate (Support Zone + Deepest Low + Volume Filter)
      //   - INDEPENDENT of cbVersion — fires in parallel with CBv2 or CBv3 (no mutual exclusion)
      //   - same shape as CBv2/CBv3 gates; cbCooldownGate.evaluateCbCooldown handles v5 via dynamic key
      //   - dynamic duration: cbv5LockHours (per-bot, default 4)
      const cbv5Gate = evaluateCbCooldown(this, this.bot, 'v5', Date.now());
      if (cbv5Gate.active) {
        logger.warn({
          botId: this.bot._id.toString(),
          signalId: signalDoc._id.toString(),
          sinceCbv5Ms: this._cbv5FiredAt > 0 ? Date.now() - this._cbv5FiredAt : null,
          cooldownMs: (Math.max(0.5, Math.min(168, Number(this.bot.cbv5LockHours) || 4))) * 3600 * 1000,
          remainingMs: cbv5Gate.remainingMs,
          cbv5LockedUntil: this.bot.cbv5LockedUntil,
          source: cbv5Gate.source,
        }, 'trader: skip BUY — CBv5 cooldown active (hybrid mode)');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'cbv5_cooldown' });
        return;
      }

      // FIX-2026-07-21: กัน placeBuy รัวจากหลายเส้นทาง (WS kline:closed + reconcileKlines sweep
      //   หรือ 2 sweep ที่มาชนกัน). ถ้ามี BUY กำลังวางอยู่ → skip signal นี้ทันที
      //   (จะถูก process รอบหน้าเมื่อ BUY ก่อนหน้าเสร็จ)
      if (this.buyInFlight) {
        logger.info({
          botId: this.bot._id.toString(),
          signalId: signalDoc._id.toString(),
        }, 'trader: skip BUY — another BUY in flight');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'buy_in_flight' });
        return;
      }

      // FIX-2026-07-21: per-bot cooldown ระหว่าง BUY orders — กัน 5 BUY ใน 1 วินาที
      //   ถ้า BUY ล่าสุดยังไม่ผ่าน cooldown → skip (signal จะถูก process รอบถัดไปถ้า candle ใหม่มา)
      const sinceLastBuy = Date.now() - this.lastBuyPlacedAt;
      if (this.lastBuyPlacedAt > 0 && sinceLastBuy < this.buyCooldownMs) {
        const waitMs = this.buyCooldownMs - sinceLastBuy;
        logger.info({
          botId: this.bot._id.toString(),
          signalId: signalDoc._id.toString(),
          sinceLastBuyMs: sinceLastBuy,
          waitMs,
        }, 'trader: skip BUY — cooldown active');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: `cooldown_${waitMs}ms` });
        // schedule retry ตอน cooldown หมด (กัน drop signal ที่อาจ valid)
        // FIX-2026-07-31 (BUG-14): track handle (T5) + clear ใน stop() — fixed candle stale (placeBuy
        //   ใช้ candle จาก outer scope → หลัง cooldown อาจเป็น candle เก่า → re-evaluate ด้วย fresh kline)
        clearTimeout(this.buyCooldownTimer);
        this.buyCooldownTimer = setTimeout(() => {
          this.buyCooldownTimer = null;
          if (this.running && this.bot.enabled && !this.buyInFlight) {
            logger.info({ botId: this.bot._id.toString() }, 'trader: cooldown expired — re-evaluating placeBuy');
            // re-enter placeBuy — internal guards จะเช็คอีกครั้ง
            this.placeBuy(signalDoc, candle).catch((err) =>
              logger.warn({ err: err.message }, 'trader: cooldown retry failed'));
          }
        }, waitMs);
        if (typeof this.buyCooldownTimer.unref === 'function') this.buyCooldownTimer.unref();
        return;
      }

      // FIX-2026-08-06: delist pre-flight — กัน BUY บน symbol ที่กำลังจะถูก delist
      //   - ถ้า symbol อยู่ใน /sapi/v1/spot/delist-schedule และ delistTime - now <= 7 วัน → skip
      //   - ตรวจก่อน buyInFlight flag �ั้ง (กัน flag ค้างถ้า reject)
      //   - defense-in-depth: ซ้ำกับ symbolInfo.validateOrder ในขั้นตอนถัดไป แต่ที่นี่ fail-fast
      //     ก่อนทำ DCA stack creation / symbolInfo load / bookTicker fetch — ประหยัด work
      try {
        const delistMonitor = require('../services/binanceDelistMonitor');
        if (delistMonitor.isDelisted(this.bot.symbol)) {
          logger.warn({ botId: this.bot._id.toString(), symbol: this.bot.symbol }, 'trader: symbol already delisted on Binance — skipping BUY');
          await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'symbol_delisted' });
          return;
        }
        if (delistMonitor.willDelistWithin(this.bot.symbol, 7)) {
          const dt = delistMonitor.getDelistTime(this.bot.symbol);
          const daysUntil = ((dt - Date.now()) / (24 * 60 * 60 * 1000)).toFixed(2);
          logger.warn({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            delistTime: new Date(dt).toISOString(),
            daysUntil,
          }, 'trader: delist pre-flight skip');
          await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: `delist_in_${daysUntil}d` });
          return;
        }
      } catch (_) { /* delistMonitor not yet started — fail-open (validateOrder catches it later) */ }

      this.buyInFlight = true;

      // FIX-2026-08-02: DCA mode — find or create the stack BEFORE symbol info + price calc
      //   - 1 Bot = 1 open DCA stack at a time
      //   - first S1 → create stack (stackId = own _id, dcaLayerIndex=1, dcaLayerCount=0)
      //   - subsequent S1 → atomic claim to bump dcaLayerIndex + dcaAdding=true
      //   - เมื่อ layer count >= dcaMaxLayers → skip signal (emit dcaMaxLayersHit)
      //   - เมื่อ previous BUY in flight (state in placed/partial_wait/retrying) → skip
      //   - atomic claim guards against 2 S1 signals racing เข้าพร้อมกัน
      if (this._isDcaMode()) {
        const OPEN_STACK_STATES = ['placed', 'partial_wait', 'filled', 'retrying', 'holding', 'selling', 'partial_sell_wait', 'stopping'];
        const BUY_IN_FLIGHT = ['placed', 'partial_wait', 'retrying'];
        let stack = await Trade.findOne({ botId: this.bot._id, isDcaStack: true, state: { $in: OPEN_STACK_STATES } });
        if (!stack) {
          // Create new stack — stackId = own _id (self-ref)
          const newId = new mongoose.Types.ObjectId();
          stack = await Trade.create({
            _id: newId,
            botId: this.bot._id,
            signalId: signalDoc._id,
            symbol: this.bot.symbol,
            timeframe: this.bot.timeframe,
            isDcaStack: true,
            stackId: newId,
            dcaLayerIndex: 1,
            dcaLayerCount: 0,
            dcaAdding: false,
            buyLayers: [],
            stackTotalQty: 0,
            stackTotalSpent: 0,
            stackBep: null,
            stackTargetSellPrice: null,
            buyPrice: null,
            buyQty: null,
            buyQuoteQty: null,
            targetSellPrice: null,
            state: 'placed',
          });
          logger.info({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            stackId: newId.toString(),
            dcaLayerIndex: 1,
          }, 'trader: DCA stack created — first layer');
        } else {
          // Stack exists — check max layers
          if ((stack.dcaLayerCount || 0) >= this.bot.dcaMaxLayers) {
            logger.info({
              botId: this.bot._id.toString(),
              symbol: this.bot.symbol,
              stackId: stack.stackId?.toString(),
              layerCount: stack.dcaLayerCount,
              maxLayers: this.bot.dcaMaxLayers,
            }, 'trader: DCA stack at max layers — skipping BUY');
            await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'dca_max_layers' });
            this.buyInFlight = false;
            eventBus.emit('dcaMaxLayersHit', {
              botId: this.bot._id,
              symbol: this.bot.symbol,
              stackId: stack.stackId,
              layerCount: stack.dcaLayerCount,
              maxLayers: this.bot.dcaMaxLayers,
            });
            return;
          }
          // Previous BUY still in flight → skip
          if (BUY_IN_FLIGHT.includes(stack.state)) {
            logger.info({
              botId: this.bot._id.toString(),
              symbol: this.bot.symbol,
              stackId: stack.stackId?.toString(),
              state: stack.state,
            }, 'trader: DCA stack previous BUY in flight — skipping signal');
            await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'dca_buy_in_flight' });
            this.buyInFlight = false;
            return;
          }
          // Atomic claim — bump dcaLayerIndex + dcaAdding=true
          //   - กัน 2 S1 signals พร้อมกัน: ใคร claim ก่อนชนะ → layer index ขยับ
          //   - state='selling' guard: เฉพาะตอน SELL placed พร้อม add layer ใหม่
          const nextIdx = (stack.dcaLayerIndex || 0) + 1;
          const claim = await Trade.updateOne(
            { _id: stack._id, dcaLayerIndex: stack.dcaLayerIndex, state: 'selling' },
            { $set: { dcaLayerIndex: nextIdx, dcaAdding: true, state: 'placed' } }
          );
          if (claim.modifiedCount !== 1) {
            logger.info({
              botId: this.bot._id.toString(),
              symbol: this.bot.symbol,
              stackId: stack.stackId?.toString(),
              expectedLayerIndex: stack.dcaLayerIndex,
              state: stack.state,
            }, 'trader: DCA stack claim lost — skipping signal');
            await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: 'dca_claim_lost' });
            this.buyInFlight = false;
            return;
          }
          stack = await Trade.findById(stack._id);
          logger.info({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            stackId: stack.stackId?.toString(),
            dcaLayerIndex: stack.dcaLayerIndex,
            dcaLayerCount: stack.dcaLayerCount,
          }, 'trader: DCA stack claim won — adding layer');
        }
        // Set currentTrade so the rest of placeBuy uses the stack
        this.currentTrade = stack;
        this._registerTrade(stack);
      }

      // 1. ตรวจว่ามี symbol info
      if (!symbolInfo.getCached(this.bot.symbol)) {
        await symbolInfo.loadSymbol(this.bot.symbol);
      }

      // 2. กำหนด BUY price ที่ post-only safe (LIMIT_MAKER)
      //    FIX-2026-07-24 (v2): per-bot minSpreadTicks + no-skip เมื่อ spread แคบ
      //    - bot.minSpreadTicks (default 1):
      //        * 1 → ใช้ bid ตรงๆ (post-only guaranteed: bid < ask) — เหมาะ low-cap (RIF)
      //        * 2 → ต้องมี margin 1 tick: ใช้ bid - tickSize — เหมาะ mid/high-cap
      //        * 0 → ไม่สนใจ spread (อันตราย)
      //    - ถ้า bid >= ask (spread collapsed): ใช้ ask - tickSize (forced post-only)
      //    - ถ้าไม่มี bookTicker: fallback candle.close (suboptimal — log warning)
      //    - เดิม v1: skip เมื่อ spread < 2 ticks → RIF โดน skip ทุก signal
      //      fix v2: ไม่ skip แล้ว — ใช้ bid ตรงๆ + retry path ที่ step 8 กัน -2010
      const ticker = this.currentBookTicker;
      const info = symbolInfo.getCached(this.bot.symbol);
      const tickSize = info.priceFilter.tickSize;
      const tickDec = new Decimal(tickSize);
      // FIX-2026-07-24: per-bot minSpreadTicks (default 1, fallback 1)
      const minSpreadTicks = Number(this.bot.minSpreadTicks ?? 1);

      let bid;
      let ask;
      let refPrice;
      if (ticker && ticker.bid && ticker.ask) {
        bid = ticker.bid;
        ask = ticker.ask;
        const spread = new Decimal(ask).minus(bid);
        if (bid >= ask) {
          // spread collapsed (bid >= ask): ใช้ ask - 1 tick
          refPrice = new Decimal(ask).minus(tickSize);
          logger.warn({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            bid, ask, refPrice: refPrice.toString(),
          }, 'trader: spread collapsed (bid >= ask) — clamping BUY price to ask - tickSize');
        } else if (spread.lessThan(tickDec.times(minSpreadTicks))) {
          // FIX-2026-07-24 (v2): spread < minSpreadTicks ticks → ใช้ bid ตรงๆ
          //   (post-only guaranteed: bid < ask, fill เร็ว)
          //   ถ้า -2010 ตอน place order → retry path ที่ step 8 จัดการให้
          refPrice = new Decimal(bid);
          logger.info({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            bid, ask, spread: spread.toString(), tickSize, minSpreadTicks,
            refPrice: refPrice.toString(),
          }, 'trader: tight spread — using bid directly (post-only guaranteed, retry path will handle -2010)');
        } else {
          // ปกติ: ใช้ bid - 1 tick (safety กัน bookTicker stale)
          refPrice = new Decimal(bid).minus(tickSize);
        }
      } else {
        // no fresh ticker — risky fallback
        refPrice = candle.close;
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
        }, 'trader: no bookTicker for BUY price selection, falling back to candle.close');
      }

      // FIX-2026-08-05 (HFT -2010 hardening): pre-flight fresh bookTicker
      //   - HFT incident (low-cap + 1m TF): WS snapshot จาก @bookTicker stream อาจเก่า 200-500ms
      //     เพราะ order book เปลี่ยนทุก 100-200ms → ask ขยับลงก่อน LIMIT_MAKER ไปถึง matching engine
      //     → -2010 "Order would immediately match and take"
      //   - fix: ถ้า WS snapshot เก่าเกิน 200ms → refetch ผ่าน /api/v3/ticker/bookTicker (REST, weight=2)
      //     แล้ว recompute bid/ask/refPrice ด้วยค่าใหม่ → race window ลดจาก ~300-500ms เหลือ ~50-100ms
      //   - ถ้า refetch fail (network/429) → fall through ใช้ snapshot เดิม (retry path ที่ step 8 ยังกัน -2010 อยู่)
      //   - 200ms threshold: มากกว่า WS tick ปกติ (~50ms สำหรับ active symbols) แต่น้อยกว่า Binance HTTP RTT (~100-150ms)
      const STALE_THRESHOLD_MS = 200;
      const wsAgeMs = ticker && ticker.ts ? Date.now() - ticker.ts : Infinity;
      if (ticker && ticker.bid && ticker.ask && Number.isFinite(wsAgeMs) && wsAgeMs > STALE_THRESHOLD_MS) {
        try {
          const fresh = await binanceRest.getBookTicker(this.bot.symbol);
          if (fresh && fresh.bidPrice && fresh.askPrice) {
            const oldBid = bid;
            const oldAsk = ask;
            const fBid = parseFloat(fresh.bidPrice);
            const fAsk = parseFloat(fresh.askPrice);
            logger.info({
              botId: this.bot._id.toString(),
              symbol: this.bot.symbol,
              wsAgeMs,
              oldBid, oldAsk,
              newBid: fBid, newAsk: fAsk,
            }, 'trader: pre-flight bookTicker refresh (WS snapshot stale > 200ms)');
            // recompute bid/ask/refPrice ด้วยค่าใหม่ — ใช้ logic เดียวกับ block ด้านบน
            bid = fBid;
            ask = fAsk;
            const freshSpread = new Decimal(fAsk).minus(fBid);
            if (bid >= ask) {
              refPrice = new Decimal(fAsk).minus(tickSize);
            } else if (freshSpread.lessThan(tickDec.times(minSpreadTicks))) {
              refPrice = new Decimal(fBid);
            } else {
              refPrice = new Decimal(fBid).minus(tickSize);
            }
          } else {
            logger.warn({ botId: this.bot._id.toString(), symbol: this.bot.symbol }, 'trader: pre-flight bookTicker returned empty — using WS snapshot');
          }
        } catch (refreshErr) {
          logger.warn({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            err: refreshErr.message,
          }, 'trader: pre-flight bookTicker refresh failed — using WS snapshot (retry path will catch -2010)');
        }
      }

      // 3. คำนวณ qty
      // FIX-2026-08-03: DCA + Martingale scaling — when DCA mode + martingaleEnabled,
      //   per-layer notional scales by multiplier^(layerIndex-1), capped by martingaleMaxLayerNotional.
      //   When martingaleEnabled=false (default) OR non-DCA → uses capitalPerTrade (unchanged).
      let buyNotionalUSDT = this.bot.capitalPerTrade;
      if (this._isDcaMode() && this.currentTrade) {
        const layerInfo = this._computeDcaLayerNotional(this.currentTrade);
        buyNotionalUSDT = layerInfo.notional;
        if (layerInfo.isMartingale) {
          logger.info({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            stackId: String(this.currentTrade.stackId || this.currentTrade._id),
            layerIndex: layerInfo.layerIndex,
            multiplier: layerInfo.multiplier,
            layerNotionalUSDT: layerInfo.notional.toFixed(4),
            capped: layerInfo.capped,
          }, 'trader: DCA Martingale layer sizing');
        }
      }
      // FIX-2026-08-08: Feature #1 — Dynamic Position Sizing (non-DCA path)
      //   - mutually exclusive กับ DCA (validated in routes) — only fires when NOT in DCA mode
      //   - effective size = dynamicSizeCurrent if set, else capitalPerTrade
      //   - persisted via dynamicPositionSizing service on every SELL fill
      // FIX-2026-08-08 (rev2): minNotional floor — บั๊ก A5
      //   เดิม: ถ้า DPS ลด size ต่ำกว่า minNotional ของเหรียญ → validateOrder fail
      //         → BUY ตายเงียบทุกสัญญาณของบอทตัวนั้น (กระทบระบบเทรดหลัก)
      //   ใหม่: fail-safe — ถ้า size ที่ DPS เสนอต่ำกว่า minNotional × margin
      //         → fallback ไปใช้ capitalPerTrade เดิม (ไม่ยกเลิก BUY)
      if (!this._isDcaMode() && this.bot.dynamicSizeEnabled !== false) {
        const effective = dps.getEffective(this.bot);
        if (Number.isFinite(effective.size) && effective.size > 0) {
          const DPS_MIN_NOTIONAL_MARGIN = 1.02; // กัน edge case ราคาขยับ/ปัดเศษ qty
          let minNotionalUSDT = 0;
          try {
            const info = symbolInfo.getCached(this.bot.symbol);
            if (info && info.notional && info.notional.minNotional) {
              minNotionalUSDT = parseFloat(info.notional.minNotional.toString()) || 0;
            }
          } catch (_) { minNotionalUSDT = 0; /* non-fatal — treat as no floor */ }

          if (effective.size >= minNotionalUSDT * DPS_MIN_NOTIONAL_MARGIN) {
            buyNotionalUSDT = effective.size;
          } else {
            logger.warn({
              botId: this.bot._id.toString(),
              symbol: this.bot.symbol,
              dpsSize: effective.size,
              minNotional: minNotionalUSDT,
              fallback: this.bot.capitalPerTrade,
            }, 'trader: DPS size below minNotional — falling back to capitalPerTrade');
          }
        }
      }

      const { qty } = symbolInfo.calcQtyFromCapital({
        symbol: this.bot.symbol,
        capitalUSDT: buyNotionalUSDT,
        price: parseFloat(refPrice.toString()),
      });

      // 4. floor price ตาม tickSize — รับประกันว่า price < ask (post-only safe)
      const buyPrice = symbolInfo.floorPrice(refPrice, tickSize).toString();

      // 5. validate
      const validation = symbolInfo.validateOrder({ symbol: this.bot.symbol, price: buyPrice, qty });
      if (!validation.ok) {
        logger.warn({ botId: this.bot._id.toString(), reason: validation.reason }, 'trader: order validation failed');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'failed', note: validation.reason });
        this.buyInFlight = false; // FIX-2026-07-21: release on early-return
        await this.failSignal(signalDoc, `validation: ${validation.reason}`);
        return;
      }

      // 6. ── Pre-flight USDT balance check (FIX-2026-07-21: ใช้ free + locked) ──
      // ตรวจว่ามี USDT พอจ่าย notional + fee buffer
      //   - ก่อนหน้านี้ใช้แค่ free — ทำให้ locked USDT (BUY order ที่ match แล้วแต่ยังไม่ settled)
      //     ถูกนับซ้ำ → บอทคิดว่ามีเงินพอ แต่จริงๆ committed ไปแล้วใน BUY ก่อนหน้า
      //   - fix: ใช้ (free + locked) — accurate committed balance
      const requiredNotional = parseFloat(buyPrice) * parseFloat(qty);
      const feeBufferRate = fees.getMakerRate();
      const requiredWithBuffer = requiredNotional * (1 + feeBufferRate);

      try {
        const account = await binanceRest.getAccount();
        const usdtBal = (account.balances || []).find((b) => b.asset === 'USDT');
        const freeUsdt = usdtBal ? parseFloat(usdtBal.free) : 0;
        const lockedUsdt = usdtBal ? parseFloat(usdtBal.locked) : 0;
        const availableUsdt = freeUsdt + lockedUsdt; // FIX-2026-07-21
        if (availableUsdt < requiredWithBuffer) {
          const reason = `insufficient USDT balance: have ${availableUsdt.toFixed(4)} (free ${freeUsdt.toFixed(4)} + locked ${lockedUsdt.toFixed(4)}), need ${requiredWithBuffer.toFixed(4)} (notional ${requiredNotional.toFixed(4)} + fee buffer)`;
          logger.warn({ botId: this.bot._id.toString(), freeUsdt, lockedUsdt, requiredWithBuffer }, 'trader: balance check failed');
          await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'skipped', note: reason });
          this.buyInFlight = false; // FIX-2026-07-21: release on early-return
          await this.failSignal(signalDoc, reason);
          return;
        }
        logger.debug({ botId: this.bot._id.toString(), freeUsdt, lockedUsdt, requiredWithBuffer }, 'trader: balance check ok');
      } catch (balErr) {
        // ถ้า fetch balance fail (เช่น API key ไม่มี permission) — log warning แต่ไม่ block
        logger.warn({ err: balErr.message }, 'trader: balance pre-check failed (continuing)');
      }

      // 7. สร้าง Trade document (หรือ update stack ถ้า DCA mode)
      const clientOrderId = this.makeClientOrderId('buy', candle.closeTime, 0);
      let trade;
      if (this._isDcaMode()) {
        // FIX-2026-08-02: DCA mode — update existing stack with new layer BUY fields
        //   (stack ถูก set จาก DCA branch ด้านบน — this.currentTrade ชี้ไปที่ stack)
        const stack = this.currentTrade;
        await Trade.updateOne(
          { _id: stack._id },
          {
            $set: {
              signalId: signalDoc._id,
              buyClientOrderId: clientOrderId,
              buyPrice: parseFloat(buyPrice),
              buyQty: parseFloat(qty),
              buyPlacedAt: new Date(),
              buyStatus: 'NEW',
              targetSellPrice: null,
              state: 'placed',
            },
          }
        );
        // Refresh in-memory stack with new BUY fields
        stack.signalId = signalDoc._id;
        stack.buyClientOrderId = clientOrderId;
        stack.buyPrice = parseFloat(buyPrice);
        stack.buyQty = parseFloat(qty);
        stack.buyPlacedAt = new Date();
        stack.buyStatus = 'NEW';
        stack.targetSellPrice = null;
        stack.state = 'placed';
        trade = stack;
      } else {
        trade = await Trade.create({
          botId: this.bot._id,
          signalId: signalDoc._id,
          symbol: this.bot.symbol,
          timeframe: this.bot.timeframe,
          buyClientOrderId: clientOrderId,
          buyPrice: parseFloat(buyPrice),
          buyQty: parseFloat(qty),
          buyPlacedAt: new Date(),
          buyStatus: 'NEW',
          state: 'placed',
          targetSellPrice: null,
        });
        this.currentTrade = trade;
        this._registerTrade(trade); // FIX 3
      }

      // 8. วาง LIMIT_MAKER BUY (post-only) — ถ้า price จะ match ทันที = reject ทันที
      //    FIX-2026-07-24 (v2): ถ้า -2010 post-only rejected → retry ด้วย ask - tickSize
      //      - bookTicker อาจ stale 200-500ms (ask ขยับลง) → ใช้ fresh ask จากอีก call ก่อน retry
      //    FIX-2026-08-09 (rev2): เพิ่มเป็น retry สูงสุด 2 ครั้ง (3 attempts รวม) พร้อม backoff
      //      - backoff: [50ms, 200ms] + jitter ±20% — รอให้ ask settle ก่อนลองใหม่
      //      - ถ้า retry ครบ 2 ครั้งแล้วยัง -2010 → fail ตามเดิม (ไม่ infinite loop)
      //      - rationale: log 30 วัน → recovery rate attempt 2 = 44%, attempt 3 expected +5-10%
      //        แต่ latency รวม ~250-400ms ยังอยู่ในกรอบที่ spread ไม่วิ่งหนี
      const MAX_BUY_RETRIES = 2;
      const RETRY_BACKOFFS_MS = [50, 200]; // backoff ก่อน retry แต่ละครั้ง
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      let orderResp = await binanceRest.newOrder({
        symbol: this.bot.symbol,
        side: 'BUY',
        type: 'LIMIT_MAKER',
        quantity: qty,
        price: buyPrice,
        newClientOrderId: clientOrderId,
        recvWindow: config_recvWindow(),
      }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

      // FIX-2026-08-09 (rev2): retry path — loop สูงสุด 2 ครั้ง
      //   - แต่ละรอบ: backoff (jitter ±20%) → refetch bookTicker → ลองด้วย ask - tickSize
      //   - ถ้า retry สำเร็จ: update trade.buyPrice + sync Map<clientOrderId> ทันที (P3.2)
      //   - ถ้า retry ครบ 2 ครั้งแล้ว -2010 อีก → ออก loop ไป fail signal block
      for (let attempt = 1; attempt <= MAX_BUY_RETRIES; attempt++) {
        if (!(orderResp.error && orderResp.error.code === -2010)) break;

        const backoffBase = RETRY_BACKOFFS_MS[attempt - 1] || 200;
        const jitter = backoffBase * 0.2 * (Math.random() * 2 - 1); // ±20%
        const backoffMs = Math.max(10, Math.round(backoffBase + jitter));

        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          attempt,
          maxRetries: MAX_BUY_RETRIES,
          backoffMs,
          placedPrice: buyPrice,
          binanceMsg: orderResp.error.msg,
        }, `trader: -2010 on attempt ${attempt} — sleeping ${backoffMs}ms then refetching bookTicker and retrying`);

        await sleep(backoffMs);

        // refetch bookTicker (refresh stale data)
        try {
          const fresh = await binanceRest.getBookTicker(this.bot.symbol);
          if (fresh && fresh.bidPrice && fresh.askPrice) {
            const freshAsk = fresh.askPrice;
            const retryPrice = symbolInfo.floorPrice(new Decimal(freshAsk).minus(tickSize), tickSize).toString();
            const retryClientOrderId = this.makeClientOrderId('buy', candle.closeTime, attempt);
            logger.info({
              botId: this.bot._id.toString(),
              symbol: this.bot.symbol,
              attempt,
              freshAsk,
              retryPrice,
              retryClientOrderId,
            }, `trader: retrying BUY attempt ${attempt} with ask - tickSize (fresh bookTicker)`);
            orderResp = await binanceRest.newOrder({
              symbol: this.bot.symbol,
              side: 'BUY',
              type: 'LIMIT_MAKER',
              quantity: qty,
              price: retryPrice,
              newClientOrderId: retryClientOrderId,
              recvWindow: config_recvWindow(),
            }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

            // update trade record's buyPrice + clientOrderId ถ้า retry สำเร็จ
            if (!orderResp.error) {
              await Trade.updateOne(
                { _id: trade._id },
                { buyPrice: parseFloat(retryPrice), buyClientOrderId: retryClientOrderId }
              );
              // FIX P3.2: sync in-memory Map<clientOrderId, trade> immediately
              //   - ปัญหา: retry สร้าง order ใหม่ด้วย clientOrderId ใหม่ → Map ยังมี key เก่า
              //     WS event ที่มาตามมาจะถูก Map.get(newId) → undefined → fall through DB lookup
              //     DB lookup อาจให้ partial doc (ไม่มี buyPrice) → ทำให้ handleSellFilled pnl=NaN
              //   - fix: unregister key เก่า + register key ใหม่ + update this.currentTrade/this.trade
              //     ทันทีที่ retry สำเร็จ ก่อน WS event จะมา
              const oldClientOrderId = trade.buyClientOrderId;
              if (oldClientOrderId && oldClientOrderId !== retryClientOrderId) {
                this.tradesByClientOrderId.delete(oldClientOrderId);
              }
              trade.buyClientOrderId = retryClientOrderId;
              trade.buyPrice = parseFloat(retryPrice);
              this.tradesByClientOrderId.set(retryClientOrderId, trade);
              if (this.currentTrade && String(this.currentTrade._id) === String(trade._id)) {
                this.currentTrade.buyClientOrderId = retryClientOrderId;
                this.currentTrade.buyPrice = parseFloat(retryPrice);
              }
              logger.info({
                botId: this.bot._id.toString(),
                symbol: this.bot.symbol,
                attempt,
                buyPrice: retryPrice,
                oldClientOrderId,
                newClientOrderId: retryClientOrderId,
              }, 'trader: retry succeeded — updated trade buyPrice + re-registered clientOrderId in Map');
              break; // success — exit retry loop
            }
          }
        } catch (retryErr) {
          logger.warn({
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            attempt,
            err: retryErr.message,
          }, `trader: retry refetch/place failed on attempt ${attempt}`);
          // fall through — orderResp.error ยังคงอยู่ → loop รอบถัดไป (ถ้ามี) หรือ fail
        }
      }

      if (orderResp.error) {
        const isPostOnly = orderResp.error.code === -2010;
        // FIX-2026-07-24: ใช้ msg จริงจาก Binance แทนการ assume "spread collapsed"
        //   - เดิม hardcode "bid X >= ask Y (spread collapsed)" ทั้งที่ spread จริงอาจปกติ
        //   - root cause: bookTicker ที่ใช้คำนวณ price อาจ stale (200-500ms ก่อน place order)
        //     → ask ขยับลงมาต่ำกว่า price ตอนที่ order ไปถึง Binance → -2010 post-only rejected
        //   - ข้อความใหม่: บอกทั้ง snapshot เก่า + Binance msg จริง + แนะนำ root cause
        const binanceMsg = orderResp.error.msg || '(no message)';
        const detail = isPostOnly
          ? `BUY -2010 post-only rejected (snapshot bid=${bid} ask=${ask}, placed=${buyPrice}) — Binance: ${binanceMsg}. bookTicker อาจ stale ตอน place order; ลอง retry ด้วย price ที่ต่ำกว่า ask มากขึ้น`
          : `BUY ${orderResp.error.code}: ${binanceMsg}`;
        logger.warn({
          botId: this.bot._id.toString(),
          err: orderResp.error,
          bid, ask, buyPrice, detail,
        }, 'trader: BUY order rejected');
        await Trade.updateOne(
          { _id: trade._id },
          { state: 'failed', error: detail }
        );
        await Signal.updateOne({ _id: signalDoc._id }, {
          outcome: 'failed',
          note: isPostOnly
            ? `BUY -2010 (placed ${buyPrice} ≥ ask ${ask} ตอนส่ง order) · snapshot bid=${bid} · retried ${MAX_BUY_RETRIES}× with backoff → Binance: ${binanceMsg}`
            : `BUY ${orderResp.error.code}: ${binanceMsg}`,
        });
        // FIX-2026-08-02: cancel any SELL orphaned by partial fill before resetting trade
        await this._cancelOrphanedSells(trade, { reason: 'placeBuy_rejected', ctx: 'state=placed' });
        this._unregisterTrade(trade); // FIX 3
        this.currentTrade = null;
        this.buyInFlight = false; // FIX-2026-07-21: release on early-return
        eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'failed',
        reason: null,
        reasonDetail: null,
      });
        return;
      }

      await Trade.updateOne(
        { _id: trade._id },
        {
          buyOrderId: orderResp.orderId,
          buyStatus: orderResp.status,
          buyPlacedAt: new Date(orderResp.transactTime || Date.now()),
        }
      );
      this.currentTrade.buyOrderId = orderResp.orderId;
      this.currentTrade.buyStatus = orderResp.status;

      logger.info({
        botId: this.bot._id.toString(),
        orderId: orderResp.orderId,
        price: buyPrice,
        qty,
        clientOrderId,
      }, 'trader: BUY placed');

      // FIX-2026-07-21: stamp cooldown + release inFlight flag เมื่อ BUY วางสำเร็จ
      this.lastBuyPlacedAt = Date.now();
      this.buyInFlight = false;

      // FIX P2.1+P3.4: ใช้ _setBotStatus serialized — กัน race กับ error/idle
      this._setBotStatus('waiting_fill', { lastError: '', extra: { lastSignalAt: new Date() } });
      eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'placed',
        reason: null,
        reasonDetail: null,
      });

      // 9. Schedule retry check (เช็คสถานะทุก retryTimeMin นาที)
      await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'order_placed' });
      this.scheduleRetryCheck(candle, signalDoc);
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'trader: placeBuy error');
      // FIX-2026-07-21: release flag on error path too
      this.buyInFlight = false;
      // FIX P2.1+P3.4: serialized error status (ถ้า candle ใหม่มา = P1.1 จะ reset เป็น idle)
      this._setBotStatus('error', { lastError: err.message });
    }
  }

  // helper: บันทึก failure + reset state
  async failSignal(signalDoc, note) {
    await Bot.updateOne({ _id: this.bot._id }, { status: 'idle', lastError: note });
    this.currentTrade = null;
    eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
    // FIX-2026-07-24: dedicated event สำหรับ Telegram notifier — เดิมไม่มี event สำหรับ "เงินหมด"
    //   note ขึ้นต้นด้วย "insufficient USDT balance" เมื่อ balance check fail (trader.js:761)
    if (typeof note === 'string' && note.startsWith('insufficient USDT balance')) {
      eventBus.emit('insufficient:balance', {
        botId: this.bot._id,
        symbol: this.bot.symbol,
        note,
      });
    }
  }

  scheduleRetryCheck(candle, signalDoc) {
    if (!this.running) return;
    if (this.retryCheckTimer) clearTimeout(this.retryCheckTimer);
    this.retryCheckTimer = setTimeout(() => {
      this.checkBuyOrder(signalDoc, candle);
    }, this.bot.retryTimeMin * 60 * 1000);
  }

  async checkBuyOrder(signalDoc, candle) {
    if (!this.running || !this.currentTrade) return;
    try {
      const trade = this.currentTrade;
      // FIX-2026-07-23 #3: state guard — ถ้า trade เคลื่อนผ่าน 'placed' ไปแล้ว (เช่น
      // handlePartialBuyFill ย้ายไป 'selling' หลังจาก partial fill) → อย่าทำ cancel/replace
      // เพราะ BUY อาจถูก cancel ไปแล้ว + SELL กำลัง pending อยู่ → เราจะ overwrite state='selling'
      // เป็น 'cancelled' ทำให้ SELL กลายเป็น orphan ที่ DB ไม่รู้จัก
      if (trade.state !== 'placed') {
        logger.debug({
          botId: this.bot._id.toString(),
          tradeId: trade._id?.toString(),
          state: trade.state,
          orderId: trade.buyOrderId,
        }, 'trader: checkBuyOrder — trade no longer placed, skipping retry');
        if (this.retryCheckTimer) {
          clearTimeout(this.retryCheckTimer);
          this.retryCheckTimer = null;
        }
        return;
      }
      // 1. ดึงสถานะ order
      const order = await binanceRest.getOrder({
        symbol: this.bot.symbol,
        orderId: trade.buyOrderId,
      }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

      if (order.error) {
        logger.error({ botId: this.bot._id.toString(), err: order.error }, 'trader: getOrder failed');
        this.scheduleRetryCheck(candle, signalDoc);
        return;
      }

      // 2. ตรวจสถานะ
      if (order.status === 'FILLED') {
        await this.handleBuyFilled(trade, order, signalDoc);
        return;
      }

      if (order.status === 'PARTIALLY_FILLED') {
        // partial → จัดการส่วนที่ได้ + cancel ที่เหลือ
        logger.info({ botId: this.bot._id.toString(), executedQty: order.executedQty }, 'trader: partial fill');
        await this.handlePartialBuyFill(trade, order, signalDoc, candle);
        return;
      }

      // 3. NEW / ACCEPTED — ยังไม่ fill → เช็ค best bid
      const newBid = this.currentBookTicker ? this.currentBookTicker.bid : null;
      const originalPrice = trade.buyPrice;
      const retryMax = this.bot.retryMax ?? 1;
      const priceThreshold = 0.000001; // 0.0001%

      // ถ้าไม่มี bookTicker → รอรอบหน้า
      if (!newBid) {
        this.scheduleRetryCheck(candle, signalDoc);
        return;
      }

      const movedEnough = Math.abs(newBid - originalPrice) / originalPrice > priceThreshold;
      const remainingRetries = retryMax - (trade.retryCount || 0);

      if (movedEnough && remainingRetries > 0) {
        // bid ขยับเกิน threshold → cancel + re-place
        logger.info({
          botId: this.bot._id.toString(),
          originalPrice,
          newBid,
          retryCount: trade.retryCount + 1,
          retryMax,
        }, 'trader: best bid moved → cancel & re-place');

        // FIX 2: cancelAndRecheck คืนค่า — เราตัดสินใจตามสถานะจริงเท่านั้น
        const cancelResult = await this.cancelAndRecheck(trade);
        const reCheck = await binanceRest.getOrder({
          symbol: this.bot.symbol,
          orderId: trade.buyOrderId,
        }).catch(() => null);

        // Case A: order FILLED ระหว่าง cancel → handle normally
        if (reCheck && reCheck.status === 'FILLED') {
          await this.handleBuyFilled(trade, reCheck, signalDoc);
          return;
        }

        // Case B: PARTIALLY_FILLED → handle partial
        if (reCheck && reCheck.status === 'PARTIALLY_FILLED') {
          logger.info({ botId: this.bot._id.toString(), executedQty: reCheck.executedQty }, 'trader: partial fill during retry');
          await this.handlePartialBuyFill(trade, reCheck, signalDoc, candle);
          return;
        }

        // FIX 2 Case C: cancel REST call fail + order NEW → อย่า mark cancelled
        // (order อาจยังมีชีวิตอยู่ เราจะเสีย asset ถ้า mark cancelled แล้ว replace)
        if (reCheck && reCheck.status === 'NEW' && !cancelResult.ok) {
          logger.warn({
            botId: this.bot._id.toString(),
            cancelError: cancelResult.error,
          }, 'trader: cancel failed + order still NEW → defer retry, do NOT mark cancelled');
          this.scheduleRetryCheck(candle, signalDoc);
          return;
        }

        // FIX 2 Case D: getOrder fail + cancel ไม่ได้ confirmed -2011 → อย่า mark cancelled
        if (!reCheck && !cancelResult.wasUnknown) {
          logger.warn({ botId: this.bot._id.toString() }, 'trader: cannot determine order state, deferring');
          this.scheduleRetryCheck(candle, signalDoc);
          return;
        }

        // Case E: confirmed CANCELLED / EXPIRED → ปลอดภัย re-place
        if (reCheck && (reCheck.status === 'CANCELED' || reCheck.status === 'EXPIRED')) {
          // FIX-2026-07-31 (BUG-5): add state filter to prevent overwriting 'selling'/'filled' that
          //   a WS path may have set during the await window (L1447 / L1497-1563). Without guard,
          //   a WS PARTIALLY_FILLED→'selling' transition landing inside that window would be
          //   silently overwritten to 'cancelled' with a live SELL on the book → orphan SELL.
          const cancelUpd = await Trade.updateOne(
            { _id: trade._id, state: 'placed' },
            { state: 'cancelled', buyStatus: reCheck.status }
          );
          if (cancelUpd.modifiedCount === 0) {
            logger.info({
              tradeId: trade._id.toString(),
            }, 'checkBuyOrder Case E — state changed during cancel, skip re-place');
            return;
          }
          await this.rePlaceBuy(trade, signalDoc, candle, newBid);
          return;
        }

        // Fallback (ไม่ควรมาถึง) — defer ไว้ก่อน
        logger.error({
          botId: this.bot._id.toString(),
          reCheck, cancelResult,
        }, 'trader: unexpected state in cancel-and-replace, deferring');
        this.scheduleRetryCheck(candle, signalDoc);
        return;
      }

      if (movedEnough && remainingRetries <= 0) {
        // bid ขยับ แต่ retry หมดแล้ว → cancel + จบรอบ (signal expired)
        logger.info({
          botId: this.bot._id.toString(),
          originalPrice,
          newBid,
          retryCount: trade.retryCount,
          retryMax,
        }, 'trader: bid moved but retryMax reached → cancel & expire signal');

        const cancelResult = await this.cancelAndRecheck(trade);
        const reCheck = await binanceRest.getOrder({
          symbol: this.bot.symbol,
          orderId: trade.buyOrderId,
        }).catch(() => null);

        if (reCheck && reCheck.status === 'FILLED') {
          // match พอดีระหว่าง cancel → ดำเนินการขายตามปกติ
          await this.handleBuyFilled(trade, reCheck, signalDoc);
          return;
        }

        if (reCheck && reCheck.status === 'PARTIALLY_FILLED') {
          await this.handlePartialBuyFill(trade, reCheck, signalDoc, candle);
          return;
        }

        // ยืนยัน cancelled แล้วเท่านั้น → expire
        if (reCheck && (reCheck.status === 'CANCELED' || reCheck.status === 'EXPIRED')) {
          // FIX-2026-07-31 (BUG-5): add state filter — same race protection as Case E above.
          const expireUpd = await Trade.updateOne(
            { _id: trade._id, state: 'placed' },
            { state: 'cancelled', buyStatus: reCheck.status, error: `retryMax (${retryMax}) reached` }
          );
          if (expireUpd.modifiedCount === 0) {
            logger.info({
              tradeId: trade._id.toString(),
            }, 'checkBuyOrder retryMax path — state changed during cancel, skip expire');
            return;
          }
          await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'expired', note: `retryMax ${retryMax} reached, bid moved` });
          await Bot.updateOne({ _id: this.bot._id }, { status: 'idle', lastError: `signal expired: retryMax ${retryMax} reached` });
          // FIX-2026-08-02: cancel any SELL orphaned by partial fill before resetting trade
          await this._cancelOrphanedSells(trade, { reason: 'retryMax_expired', ctx: 'state=placed' });
          this._unregisterTrade(trade); // FIX 3
          this.currentTrade = null;
          eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
          return;
        }

        // ไม่แน่ใจ → defer แทน expire
        logger.warn({
          botId: this.bot._id.toString(),
          reCheck, cancelResult,
        }, 'trader: retryMax reached but order state unclear, deferring');
        this.scheduleRetryCheck(candle, signalDoc);
        return;
      }

      // 4. bid ยังอยู่ที่เดิม (order ยังอยู่ใน best bid) → รอรอบถัดไป
      logger.debug({
        botId: this.bot._id.toString(),
        orderPrice: originalPrice,
        bestBid: newBid,
        retryCount: trade.retryCount,
        retryMax,
      }, 'trader: order still at best bid → wait for next retry cycle');
      this.scheduleRetryCheck(candle, signalDoc);
    } catch (err) {
      logger.error({ err: err.message }, 'trader: checkBuyOrder error');
    }
  }

  // FIX 2: cancel order + คืนค่าให้ caller ตัดสินใจ
  // -2011 = Unknown order (อาจ fill ไปแล้ว) → ถือว่า ok, wasUnknown=true
  // error อื่น ๆ → ok=false, error=...
  async cancelAndRecheck(trade) {
    const cancelResp = await binanceRest.cancelOrder({
      symbol: this.bot.symbol,
      orderId: trade.buyOrderId,
    }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

    if (cancelResp.error && cancelResp.error.code === -2011) {
      // Order already filled/cancelled/expired — this is informational, not a failure
      logger.debug({ botId: this.bot._id.toString(), orderId: trade.buyOrderId }, 'trader: cancel got -2011 (order already gone)');
      return { ok: true, wasUnknown: true, error: cancelResp.error };
    }
    if (cancelResp.error) {
      logger.warn({ botId: this.bot._id.toString(), err: cancelResp.error }, 'trader: cancel failed (non -2011)');
      return { ok: false, wasUnknown: false, error: cancelResp.error };
    }
    return { ok: true, wasUnknown: false };
  }

  async rePlaceBuy(prevTrade, signalDoc, candle, newBid) {
    try {
      const info = symbolInfo.getCached(this.bot.symbol);
      const tickSize = info.priceFilter.tickSize;
      const ticker = this.currentBookTicker;

      // เหมือน placeBuy: clamp BUY price ให้ < ask กัน -2010 post-only rejected
      let refPrice;
      let bidForLog;
      let askForLog;
      if (ticker && ticker.bid && ticker.ask && newBid) {
        bidForLog = ticker.bid;
        askForLog = ticker.ask;
        if (newBid < ticker.ask) {
          refPrice = newBid;
        } else {
          refPrice = new Decimal(ticker.ask).minus(tickSize);
          logger.warn({
            botId: this.bot._id.toString(),
            bid: ticker.bid, ask: ticker.ask, newBid, refPrice: refPrice.toString(),
          }, 'trader: rePlace — spread collapsed, clamping to ask - tickSize');
        }
      } else {
        refPrice = newBid || candle.close;
      }

      const buyPrice = symbolInfo.floorPrice(refPrice, tickSize).toString();

      // safety net — floor ยังให้ price >= ask (เช่น tickSize มากกว่า spread) → abort
      if (bidForLog !== undefined && askForLog !== undefined && parseFloat(buyPrice) >= askForLog) {
        logger.warn({
          botId: this.bot._id.toString(),
          bid: bidForLog, ask: askForLog, buyPrice,
        }, 'trader: rePlaceBuy clamped price still >= ask, aborting');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'expired', note: 'spread too tight to re-place' });
        await Bot.updateOne({ _id: this.bot._id }, { status: 'idle' });
        // FIX-2026-08-02: cancel any SELL orphaned by partial fill before resetting trade
        await this._cancelOrphanedSells(prevTrade, { reason: 'rePlace_spread_too_tight', ctx: 'state=placed' });
        this._unregisterTrade(prevTrade); // FIX 3
        this.currentTrade = null;
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
        return;
      }

      const validation = symbolInfo.validateOrder({ symbol: this.bot.symbol, price: buyPrice, qty: prevTrade.buyQty });
      if (!validation.ok) {
        logger.warn({ botId: this.bot._id.toString(), reason: validation.reason }, 'trader: rePlace validation failed');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'expired', note: validation.reason });
        await Bot.updateOne({ _id: this.bot._id }, { status: 'idle' });
        // FIX-2026-08-02: cancel any SELL orphaned by partial fill before resetting trade
        await this._cancelOrphanedSells(prevTrade, { reason: 'rePlace_validation_failed', ctx: 'state=placed' });
        this._unregisterTrade(prevTrade); // FIX 3
        this.currentTrade = null;
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
        return;
      }

      const newClientOrderId = this.makeClientOrderId('buy', candle.closeTime, prevTrade.retryCount + 1);
      const orderResp = await binanceRest.newOrder({
        symbol: this.bot.symbol,
        side: 'BUY',
        type: 'LIMIT_MAKER',
        quantity: prevTrade.buyQty.toString(),
        price: buyPrice,
        newClientOrderId: newClientOrderId,
        recvWindow: config_recvWindow(),
      }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

      if (orderResp.error) {
        logger.warn({
          botId: this.bot._id.toString(),
          err: orderResp.error,
          bid: bidForLog, ask: askForLog, buyPrice,
        }, 'trader: rePlace rejected');
        await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'expired', note: 'rePlace rejected' });
        await Bot.updateOne({ _id: this.bot._id }, { status: 'idle' });
        // FIX-2026-08-02: cancel any SELL orphaned by partial fill before resetting trade
        await this._cancelOrphanedSells(prevTrade, { reason: 'rePlace_rejected', ctx: 'state=placed' });
        this._unregisterTrade(prevTrade); // FIX 3
        this.currentTrade = null;
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
        return;
      }

      // FIX 3: unregister trade เก่า (BUY clientOrderId เปลี่ยน) — แต่ SELL (ถ้ามี) ยังคงอยู่
      // prevTrade มีแค่ buyClientOrderId (ยังไม่มี sell) เลย unregister ได้ตรง ๆ
      this._unregisterTrade(prevTrade);

      const newTrade = await Trade.create({
        botId: this.bot._id,
        signalId: signalDoc._id,
        symbol: this.bot.symbol,
        timeframe: this.bot.timeframe,
        buyClientOrderId: newClientOrderId,
        buyPrice: parseFloat(buyPrice),
        buyQty: prevTrade.buyQty,
        buyPlacedAt: new Date(),
        buyStatus: orderResp.status,
        buyOrderId: orderResp.orderId,
        retryCount: prevTrade.retryCount + 1,
        state: 'placed',
      });
      this.currentTrade = newTrade;
      this._registerTrade(newTrade); // FIX 3

      eventBus.emit('trade:update', {
        tradeId: newTrade._id,
        state: 'placed',
        reason: null,
        reasonDetail: null,
      });
      this.scheduleRetryCheck(candle, signalDoc);
    } catch (err) {
      logger.error({ err: err.message }, 'trader: rePlaceBuy error');
    }
  }

  // FIX 4: handleBuyFilled mutex ป้องกัน double-SELL จาก WS+retryTimer race
  async handleBuyFilled(trade, order, signalDoc) {
    // FIX-2026-07-31 (BUG-16): running check — guard against WS events after stop()
    if (!this.running) return;
    const tradeId = trade._id.toString();
    if (this.handleBuyFilledLocks.has(tradeId)) {
      logger.debug({ tradeId }, 'trader: handleBuyFilled already running, skip duplicate');
      return this.handleBuyFilledLocks.get(tradeId);
    }
    const promise = this._handleBuyFilledImpl(trade, order, signalDoc);
    this.handleBuyFilledLocks.set(tradeId, promise);
    try {
      return await promise;
    } finally {
      this.handleBuyFilledLocks.delete(tradeId);
    }
  }

  // FIX-2026-08-02: DCA stack BUY filled handler
  //   - append layer to buyLayers (atomic $push with orderId-not-in guard)
  //   - recompute BEP from buyLayers (weighted-avg by qty)
  //   - compute new TP at BEP
  //   - mirror scalars (buyPrice=stackBep, buyQty=totalQty, buyQuoteQty=totalSpent)
  //   - reset dcaAdding flag
  //   - replace aggregate SELL via _cancelAndReplaceSell (cancel old at old TP, place new at BEP+TP)
  //   - emit dcaLayerAdded + trade:update + buyFilled event with stack context
  //   - 1 stack = 1 bot counter entry (dcaLayerCount != count for totalTrades)
  async _handleDcaBuyFilled(trade, order, signalDoc, { filledQty, avgPrice }) {
    const layerIndex = trade.dcaLayerIndex;
    const orderId = order.orderId;
    const stackId = trade.stackId || trade._id;
    const tradeFee = parseFloat(order.fee || 0);
    const tradeFeeAsset = (order.fills && order.fills[0] && order.fills[0].commissionAsset) || '';

    // 1. atomic claim: append layer (with orderId uniqueness guard)
    //   - race protection: 2 เส้นทาง (WS + retry) อาจ call handleBuyFilled พร้อมกัน
    //   - duplicate event → ไม่ $push ซ้ำ (return null → skip)
    const layer = {
      layerIndex,
      orderId,
      clientOrderId: trade.buyClientOrderId,
      price: avgPrice,
      qty: filledQty,
      quoteQty: parseFloat(order.cummulativeQuoteQty),
      fee: tradeFee,
      feeAsset: tradeFeeAsset,
      status: 'FILLED',
      filledAt: new Date(order.updateTime || Date.now()),
      placedAt: trade.buyPlacedAt || new Date(),
    };
    const updated = await Trade.findOneAndUpdate(
      { _id: trade._id, 'buyLayers.orderId': { $ne: orderId } },
      { $push: { buyLayers: layer }, $inc: { dcaLayerCount: 1 } },
      { new: true }
    );
    if (!updated) {
      logger.info({
        tradeId: trade._id.toString(),
        stackId: stackId.toString(),
        orderId,
      }, 'trader: _handleDcaBuyFilled — duplicate event (layer already appended), skip');
      return;
    }

    // 2. recompute BEP from updated buyLayers
    const { totalQty, totalSpent, bep } = this._computeStackBEP(updated);
    if (!bep || totalQty <= 0) {
      logger.warn({
        tradeId: trade._id.toString(),
        stackId: stackId.toString(),
        buyLayers: updated.buyLayers,
      }, 'trader: _handleDcaBuyFilled — invalid BEP after layer append, abort');
      return;
    }

    // 3. compute new TP from BEP
    let dcaTp;
    try {
      dcaTp = await this._computeDcaTp({ stackBep: bep, totalQty });
    } catch (err) {
      // FIX-2026-08-03 (B4): reset dcaAdding=false on failure so bot isn't stuck
      //   - otherwise next S1 sees state='placed' + dcaAdding=true → claim predicate fails (no-op)
      //   - leave state='placed' so layer BUY still pending; holding-retry will recover
      await Trade.updateOne({ _id: trade._id }, { dcaAdding: false, error: `dca_tp_compute: ${err.message}` });
      logger.warn({
        tradeId: trade._id.toString(),
        bep, err: err.message,
      }, 'trader: _handleDcaBuyFilled — TP compute failed, abort (dcaAdding reset)');
      return;
    }
    const newTarget = dcaTp.sellPrice;

    // 4. mirror scalars + reset dcaAdding + transition state to 'filled' (so _cancelAndReplaceSell sees 'filled' state)
    //   - targetSellPrice จะถูก _cancelAndReplaceSell override อีกที (sellPrice = newTarget)
    const mirrorUpd = await Trade.updateOne(
      { _id: trade._id, state: 'placed' },
      {
        $set: {
          buyStatus: 'FILLED',
          buyPrice: bep,
          buyQty: totalQty,
          buyQuoteQty: totalSpent,
          buyFilledAt: new Date(order.updateTime || Date.now()),
          targetSellPrice: newTarget,
          stackBep: bep,
          stackTotalQty: totalQty,
          stackTotalSpent: totalSpent,
          stackTargetSellPrice: newTarget,
          stackClosedAt: null,
          dcaAdding: false,
          state: 'filled',
        },
      }
    );
    if (mirrorUpd.modifiedCount === 0) {
      // state moved on (race with another path) — skip SELL replace
      logger.info({
        tradeId: trade._id.toString(),
        stackId: stackId.toString(),
      }, 'trader: _handleDcaBuyFilled — state changed during mirror, skip SELL replace');
      return;
    }

    // 5. cancel old SELL + place new aggregate SELL at BEP+TP
    //   - This will handle cancel(-2011=already gone), validate, newOrder, atomic state update
    //   - If SELL already filled during this path → mode='race_sold' (orphan SELL avoided)
    const replaceResult = await this._cancelAndReplaceSell({
      trade: { ...updated.toObject(), _id: trade._id, symbol: trade.symbol },
      reason: 'dca_layer_added',
      source: 'dca_buy_filled',
      qty: totalQty,
      newTarget,
    });

    if (!replaceResult.ok) {
      if (replaceResult.mode === 'race_sold' || replaceResult.mode === 'race_stopping') {
        // SELL already filled/stopping — stack is closed
        logger.info({
          tradeId: trade._id.toString(),
          stackId: stackId.toString(),
          mode: replaceResult.mode,
        }, 'trader: _handleDcaBuyFilled — SELL already closed during layer add, stack closed');
      } else if (replaceResult.mode === 'validation_fail') {
        // validation fail → MARKET fallback via _emergencyMarketSell
        logger.warn({
          tradeId: trade._id.toString(),
          stackId: stackId.toString(),
          error: replaceResult.error,
          totalQty, newTarget,
        }, 'trader: _handleDcaBuyFilled — SELL validation failed, MARKET fallback');
        await this._emergencyMarketSell(
          { ...updated.toObject(), _id: trade._id, symbol: trade.symbol },
          totalQty,
          bep,
          newTarget,
          `dca_layer_validation: ${replaceResult.error}`,
        );
      } else {
        // binance_error or other → put into 'holding' + schedule retry
        logger.warn({
          tradeId: trade._id.toString(),
          stackId: stackId.toString(),
          mode: replaceResult.mode,
          error: replaceResult.error,
        }, 'trader: _handleDcaBuyFilled — SELL place failed, scheduling holding retry');
        await Trade.updateOne(
          { _id: trade._id },
          { state: 'holding', error: `dca_sell: ${replaceResult.error}` }
        );
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        this.scheduleHoldingRetry(
          { ...updated.toObject(), _id: trade._id, symbol: trade.symbol },
          totalQty,
          bep,
          newTarget,
        );
      }
    }

    // 6. emit events (always — even on failure paths)
    eventBus.emit('dcaLayerAdded', {
      botId: this.bot._id,
      symbol: this.bot.symbol,
      stackId,
      layerIndex,
      layerCount: updated.dcaLayerCount,
      maxLayers: this.bot.dcaMaxLayers,
      layerPrice: avgPrice,
      layerQty: filledQty,
      layerQuoteQty: parseFloat(order.cummulativeQuoteQty),
      stackBep: bep,
      stackTotalQty: totalQty,
      stackTotalSpent: totalSpent,
      targetSellPrice: newTarget,
      tpTrendEnabled: !!dcaTp.tpTrendEnabled,
      tpTrendMultiplier: parseFloat(dcaTp.tpTrendMultiplier),
      tpBase: parseFloat(dcaTp.tpBase),
      tpEffective: parseFloat(dcaTp.tpEffective),
      feeRate: parseFloat(dcaTp.feeRate),
      sellOrderId: replaceResult.sellOrderId || null,
      sellPlaced: !!replaceResult.ok && replaceResult.mode === 'placed',
    });
    eventBus.emit('trade:update', {
      tradeId: trade._id,
      state: replaceResult.ok && replaceResult.mode === 'placed' ? 'selling' : (replaceResult.mode === 'race_sold' ? 'sold' : 'filled'),
      targetSellPrice: newTarget,
      tpBase: parseFloat(dcaTp.tpBase),
      tpEffective: parseFloat(dcaTp.tpEffective),
      tpTrendMultiplier: parseFloat(dcaTp.tpTrendMultiplier),
      tpTrendEnabled: !!dcaTp.tpTrendEnabled,
      feeRate: parseFloat(dcaTp.feeRate),
      stackId,
      dcaLayerCount: updated.dcaLayerCount,
      stackBep: bep,
      stackTotalQty: totalQty,
      reason: null,
      reasonDetail: null,
    });

    // 7. also emit 'filled' style event for telegramNotifier (mirror buyFilled)
    //   - telegramNotifier subscribes to 'trade:update' state='filled' OR 'holding'
    //   - ใน DCA mode: ทุก layer BUY ต้องส่ง notification
    eventBus.emit('trade:update', {
      tradeId: trade._id,
      state: 'filled',
      targetSellPrice: newTarget,
      tpBase: parseFloat(dcaTp.tpBase),
      tpEffective: parseFloat(dcaTp.tpEffective),
      tpTrendMultiplier: parseFloat(dcaTp.tpTrendMultiplier),
      tpTrendEnabled: !!dcaTp.tpTrendEnabled,
      feeRate: parseFloat(dcaTp.feeRate),
      stackId,
      dcaLayerCount: updated.dcaLayerCount,
      stackBep: bep,
      stackTotalQty: totalQty,
      isDcaLayer: true,
      layerIndex,
      layerPrice: avgPrice,
      layerQty: filledQty,
      reason: null,
      reasonDetail: null,
    });

    // 8. update bot status
    if (replaceResult.ok && replaceResult.mode === 'placed') {
      await Bot.updateOne({ _id: this.bot._id }, { status: 'selling', lastError: '' });
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'selling' });
    }

    // 9. update signal outcome
    await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'filled' });
  }

  async _handleBuyFilledImpl(trade, order, signalDoc) {
    try {
      const filledQty = parseFloat(order.executedQty);
      const avgPrice = parseFloat(order.price) || parseFloat(order.cummulativeQuoteQty) / filledQty;

      // FIX-2026-08-02: DCA mode branch — append layer + recompute BEP + replace aggregate SELL
      if (trade.isDcaStack) {
        return await this._handleDcaBuyFilled(trade, order, signalDoc, { filledQty, avgPrice });
      }

      // FIX-2026-07-31 (F2): TP ×N multiplier when upper-TF trend above EMA20
      //   - apply เฉพาะ position ใหม่ (call site เดียว — partial-fill sites ใช้ targetSellPrice ที่ persist แล้ว)
      //   - cache 60s in-process (mirror volatilityForBot CACHE_TTL_MS pattern)
      //   - 'warmup' หรือ 'lower' → ไม่คูณ (ใช้ tpPercent เดิม)
      // FIX-2026-08-01: tpTrendEnabled gate (per-bot toggle, default true)
      //   - ถ้า false → ใช้ tpPercent ตรงๆ (ข้าม trend logic ทั้งหมด, ไม่ call _getTrendState)
      //   - ลด Binance API call ด้วย (early-return ก่อน await)
      // FIX-2026-08-02: use _computeTp() helper (single source of truth)
      // FIX-2026-08-02: compute TP ก่อน update trade + emit 'filled' — telegramNotifier จะได้ targetSellPrice ทันที
      //   - ก่อนหน้านี้: emit 'filled' ก่อนคำนวณ TP → telegramNotifier อ่าน DB เจอ targetSellPrice=null
      //   - BUY notification ไม่มี 🎯 Target Sell line (ใน telegramNotifier render)
      const tp = await this._computeTp({ buyPrice: avgPrice });
      const sellPrice = tp.sellPrice;
      logger.info({
        tradeId: trade._id.toString(),
        tpTrendEnabled: tp.tpTrendEnabled,
        trendState: tp.trendState,
        trendTF: tp.trendTF,
        multiplier: tp.tpTrendMultiplier,
        tpBase: tp.tpBase,
        tpEffective: tp.tpEffective,
        avgPrice, sellPrice,
      }, 'trader: TP applied with trend multiplier');

      // FIX 1: idempotent state update — ใช้ guard { state: 'placed' | 'filled' | 'retrying' }
      // กัน double-update ถ้า 2 path (WS + retry) มาถึงพร้อมกัน
      // FIX-2026-08-02: persist targetSellPrice ใน update เดียวกับ state='filled' เพื่อให้ telegramNotifier อ่าน DB เจอทันที
      const upd = await Trade.updateOne(
        {
          _id: trade._id,
          state: { $in: ['placed', 'filled', 'retrying', 'holding'] },
        },
        {
          state: 'filled',
          buyStatus: 'FILLED',
          buyPrice: avgPrice,
          buyQty: filledQty,
          buyQuoteQty: parseFloat(order.cummulativeQuoteQty),
          buyFilledAt: new Date(order.updateTime || Date.now()),
          targetSellPrice: parseFloat(sellPrice),
        }
      );
      if (upd.modifiedCount === 0) {
        // ถูก process ไปแล้ว (state เปลี่ยนเป็น selling/sold/cancelled)
        logger.debug({ tradeId: trade._id.toString() }, 'trader: handleBuyFilled skipped — trade already in terminal state');
        return;
      }

      // FIX-2026-07-24: emit 'filled' (BUY filled) เพื่อให้ telegramNotifier ส่ง buyFilled
      //   - ก่อนหน้านี้ state กระโดด placed -> filled -> selling โดยไม่ emit 'filled'
      //   - telegramNotifier filter เฉพาะ 'holding' / 'sold' → skip 'filled' และ 'selling'
      //   - ผลคือ BUY filled ไม่เคยถูกแจ้งเตือน
      // FIX-2026-08-02: include targetSellPrice in event payload → telegramNotifier ใช้ event target ก่อน DB read
      // FIX-2026-08-02 (TP-NET clarity): include tpBase/tpEffective/tpTrendMultiplier so telegram can show
      //   both "Gross +X%" markup and "NET +Y%" profit (NET = bot.tpPercent × tpTrendMultiplier if trend=upper).
      //   Previously telegram only showed gross markup which user mis-read as NET profit.
      eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'filled',
        targetSellPrice: parseFloat(sellPrice),
        tpBase: parseFloat(tp.tpBase),
        tpEffective: parseFloat(tp.tpEffective),
        tpTrendMultiplier: parseFloat(tp.tpTrendMultiplier),
        tpTrendEnabled: !!tp.tpTrendEnabled,
        feeRate: parseFloat(tp.feeRate),
        reason: null,
        reasonDetail: null,
      });

      // FIX 1: ถ้า validation fail (เช่น tick size / min notional) → MARKET fallback
      const validation = symbolInfo.validateOrder({ symbol: this.bot.symbol, price: sellPrice, qty: filledQty });
      if (!validation.ok) {
        logger.warn({ reason: validation.reason }, 'trader: SELL validation failed → MARKET fallback');
        const ok = await this._emergencyMarketSell(trade, filledQty, avgPrice, sellPrice, `validation: ${validation.reason}`);
        if (!ok) {
          // FIX 1: schedule retry แทนการค้างเฉย ๆ
          await Trade.updateOne({ _id: trade._id }, { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: validation.reason });
          await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
          eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
          eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'holding',
        reason: null,
        reasonDetail: null,
      });
          this.scheduleHoldingRetry(trade, filledQty, avgPrice, sellPrice);
        }
        return;
      }

      // FIX 1: ลอง LIMIT_MAKER ก่อน — ถ้า reject (-2010 Duplicate, MIN_NOTIONAL ฯลฯ)
      // → fallback เป็น MARKET ทันที (emergency exit)
      let sellClientOrderId = this.makeClientOrderId('sell', order.updateTime || Date.now(), trade.retryCount || 0);
      let sellResp = await binanceRest.newOrder({
        symbol: this.bot.symbol,
        side: 'SELL',
        type: 'LIMIT_MAKER',
        quantity: filledQty.toString(),
        price: sellPrice,
        newClientOrderId: sellClientOrderId,
        recvWindow: config_recvWindow(),
      }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

      // FIX-2026-08-07 (ZBT 17:27 incident): retry once on -2010 "insufficient balance"
      //   - เคสก่อนหน้า: BUY fill ตอนที่ ZBT free=0 (อีก position ของบอท lock ZBT อยู่) → Binance ยัง
      //     ไม่ settle base asset เข้า free balance → LIMIT_MAKER SELL โดน -2010 "Account has
      //     insufficient balance for requested action." ทันทีที่ place order
      //   - ก่อนหน้า fix: fall through ไป _emergencyMarketSell (ตัดขาดทุนทันทีที่ราคา spot)
      //     ทั้งที่ SELL น่าจะสำเร็จถ้ารอ Binance settle ~500ms-1s
      //   - fix: detect -2010 + msg="insufficient balance" → รอ 750ms แล้ว retry LIMIT_MAKER
      //     1 ครั้ง (Binance settle time ปกติ < 1s). ถ้าสำเร็จ → continue ปกติ
      //     ถ้ายัง fail → fall through ไป _emergencyMarketSell เดิม (safe side)
      //   - post-only rejected (-2010 "would immediately match") ไม่เข้าเงื่อนไขนี้
      //     → fall through _emergencyMarketSell ทันที (behavior เดิม)
      if (sellResp.error && sellResp.error.code === -2010
          && typeof sellResp.error.msg === 'string'
          && sellResp.error.msg.toLowerCase().includes('insufficient balance')) {
        logger.warn({
          tradeId: trade._id.toString(),
          symbol: this.bot.symbol,
          err: sellResp.error,
        }, 'trader: SELL -2010 insufficient balance — likely Binance settlement race; waiting 750ms and retrying');
        await new Promise((r) => setTimeout(r, 750));
        // newClientOrderId must be unique per request — generate fresh for retry
        const retryClientOrderId = this.makeClientOrderId('sell', Date.now(), (trade.retryCount || 0) + 0.5);
        sellResp = await binanceRest.newOrder({
          symbol: this.bot.symbol,
          side: 'SELL',
          type: 'LIMIT_MAKER',
          quantity: filledQty.toString(),
          price: sellPrice,
          newClientOrderId: retryClientOrderId,
          recvWindow: config_recvWindow(),
        }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));
        if (!sellResp.error) {
          // อัพเดท sellClientOrderId เป็นตัวที่ retry สำเร็จ เพื่อใช้ใน Trade.updateOne/_registerTrade
          sellClientOrderId = retryClientOrderId;
          logger.info({
            tradeId: trade._id.toString(),
            symbol: this.bot.symbol,
            orderId: sellResp.orderId,
          }, 'trader: SELL LIMIT_MAKER retry succeeded after settlement race');
        }
      }

      if (sellResp.error) {
        logger.warn({
          err: sellResp.error,
          tradeId: trade._id.toString(),
        }, 'trader: SELL LIMIT_MAKER rejected → trying MARKET fallback');

        const ok = await this._emergencyMarketSell(trade, filledQty, avgPrice, sellPrice,
          `${sellResp.error.code}: ${sellResp.error.msg}`);
        if (!ok) {
          // ทั้ง LIMIT และ MARKET fail → mark holding + schedule retry
          await Trade.updateOne({
            _id: trade._id,
            state: { $in: ['filled', 'holding'] },
          }, { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: `${sellResp.error.code}: ${sellResp.error.msg}` });
          await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
          eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
          eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'holding',
        reason: null,
        reasonDetail: null,
      });
          this.scheduleHoldingRetry(trade, filledQty, avgPrice, sellPrice);
        }
        return;
      }

      // FIX-2026-07-31 (BUG-4): add state filter to prevent overwriting a 'sold' state set by WS path.
      //   Race: WS SELL FILLED from handleSellFilled (L3338) sets state='sold' between atomic claim at
      //   L1767 and this write. Without guard, this would write state='selling' over 'sold', leaving
      //   DB=Selling while Binance has FILLED — second FILLED event never arrives, trade stuck.
      // FIX-2026-08-01 (audit R1): explicit pre-check state to catch 'sold'/'stopping' that BUG-4 missed
      //   - BUG-4 แก้ race กับ handleSellFilled (WS path) เท่านั้น — ไม่ครอบคลุม CB panic-close
      //   - Race: ระหว่าง F2 _getTrendState() (500ms-60s wait) + CB panic-close
      //     → CB claim state='stopping' → place MARKET SELL → state='sold'
      //     → F2 SELL placed → updateOne เดิม match (state='filled' ยังไม่ถูก update) → write 'selling'
      //     → orphan: state='selling' แต่ Binance มี MARKET SELL FILLED แล้ว
      //   - fix: re-read state from DB ก่อน update — ถ้า 'sold'/'stopping' แล้ว cancel SELL + abort
      const latestTrade = await Trade.findById(trade._id).lean();
      if (latestTrade && (latestTrade.state === 'sold' || latestTrade.state === 'stopping')) {
        logger.warn({
          tradeId: trade._id.toString(),
          currentState: latestTrade.state,
          sellOrderId: sellResp.orderId,
        }, 'trader: _handleBuyFilledImpl — state changed to sold/stopping during trend fetch, cancelling orphan SELL');
        try {
          await binanceRest.cancelOrder({
            symbol: this.bot.symbol,
            orderId: sellResp.orderId,
          }).catch(() => null);
        } catch (_) { /* best-effort cancel */ }
        return;
      }
      const sellUpd = await Trade.updateOne(
        {
          _id: trade._id,
          state: { $in: ['filled', 'holding'] },
        },
        {
          sellOrderId: sellResp.orderId,
          sellClientOrderId,
          sellPrice: parseFloat(sellPrice),
          sellQty: filledQty,
          sellStatus: sellResp.status,
          sellPlacedAt: new Date(),
          targetSellPrice: parseFloat(sellPrice),
          state: 'selling',
        }
      );
      if (sellUpd.modifiedCount === 0) {
        // race lost — WS or other path already moved past 'filled'/'holding'
        // Cancel the SELL we just placed to avoid orphan
        logger.warn({
          tradeId: trade._id.toString(),
          sellOrderId: sellResp.orderId,
        }, 'trader: _handleBuyFilledImpl — state changed before SELL placement, cancelling orphan SELL');
        try {
          await binanceRest.cancelOrder({
            symbol: this.bot.symbol,
            orderId: sellResp.orderId,
          }).catch(() => null);
        } catch (_) { /* best-effort cancel */ }
        return;
      }
      this.currentTrade.sellOrderId = sellResp.orderId;
      this.currentTrade.sellClientOrderId = sellClientOrderId;
      this.currentTrade.state = 'selling';
      // FIX 3: register sell clientOrderId ใน Map (กรณี currentTrade เปลี่ยนทีหลัง)
      this._registerTrade({ buyClientOrderId: trade.buyClientOrderId, sellClientOrderId });

      logger.info({
        botId: this.bot._id.toString(),
        buyPrice: avgPrice,
        sellPrice,
        qty: filledQty,
      }, 'trader: SELL placed');

      await Bot.updateOne({ _id: this.bot._id }, { status: 'selling', lastError: '' });
      await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'filled' });
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'selling' });
      eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'selling',
        reason: null,
        reasonDetail: null,
      });
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'trader: handleBuyFilled error');
    }
  }

  // FIX 1: emergency MARKET SELL — ป้องกัน asset stranded
  // return true ถ้าสำเร็จ (state → selling), false ถ้า fail (ต้อง schedule retry)
  async _emergencyMarketSell(trade, qty, buyPrice, targetSellPrice, reasonNote, opts = {}) {
    try {
      // FIX-2026-07-30: รองรับ partial-fill context — เมื่อ SELL fill ที่ TP บางส่วนแล้วและจะ MARKET ที่เหลือ
      //   - opts.alreadyFilledQty: qty ที่ fill แล้วที่ TP (default 0 = legacy path)
      //   - opts.alreadyAvgSellPrice: avg price ของส่วนที่ fill แล้ว (default targetSellPrice)
      //   - opts.alreadyCumQuote: cumulative quote ของส่วนที่ fill แล้ว (default = qty*price)
      //   - opts.allowStates: array ของ state ที่ยอมให้ claim (default = ['filled','holding','stopping'])
      //   - ถ้า alreadyFilledQty=0 → behavior identical เดิม (CB/stop-loss path)
      const alreadyFilledQty = parseFloat(opts.alreadyFilledQty) || 0;
      const alreadyAvgSellPrice = parseFloat(opts.alreadyAvgSellPrice) || parseFloat(targetSellPrice) || 0;
      const alreadyCumQuote = parseFloat(opts.alreadyCumQuote) || (alreadyFilledQty * alreadyAvgSellPrice);
      const allowStates = opts.allowStates || ['filled', 'holding', 'stopping'];

      // FIX-2026-08-05: atomic claim BEFORE placing MARKET order — กัน DUPLICATE SELL
      //   - HOMEUSDT incident 2026-08-05T00:20:04: _emergencyMarketSell ถูกเรียก 2 ครั้งจากคนละ path
      //     (handleBuyFilled → -2010 → emergencyMarketSell + reconcile ORPHAN → emergencyMarketSell)
      //     → ทั้ง 2 วาง MARKET ก่อนที่ DB update จะ race-safe
      //   - filter `sellInFlight: {$ne:true}` + state in allowStates → ถ้า claim fail = path อื่นกำลัง place SELL → abort
      const placeClaim = await Trade.findOneAndUpdate(
        {
          _id: trade._id,
          state: { $in: allowStates },
          sellInFlight: { $ne: true },
        },
        {
          $set: {
            sellInFlight: true,
            sellInFlightAt: new Date(),
            sellStatus: 'PLACING',
          },
        },
        { new: true }
      );
      if (!placeClaim) {
        logger.warn({
          tradeId: trade._id.toString(),
          allowStates,
          qty,
        }, 'trader: _emergencyMarketSell — another path already placing SELL (sellInFlight claim failed), abort');
        return false;
      }

      const marketSellId = this.makeClientOrderId('em-sell', Date.now(), 0);

      // FIX-2026-08-06 (HOME stuck SL-UKC loop): round qty to LOT_SIZE stepSize before MARKET
      //   - forceClose.js + scheduleHoldingRetry already round, but defense-in-depth here
      //   - targets all callers: handleBuyFilled validation-fail, LIMIT_MAKER reject, partial-fill
      //     finalize, CB panic-sell, stop-loss-on-UKC, D.C.A. unsold stack, etc.
      //   - สำหรับ HOME/USDT stepSize=1: ถ้า qty=945.5 → 945
      //   - ถ้า rounded qty < minQty → keep but warn (caller may want to retry with smaller)
      let marketQty = qty;
      try {
        const info = await symbolInfo.loadSymbol(this.bot.symbol);
        const stepSize = info.lotSize.stepSize;
        const minQty = info.lotSize.minQty;
        marketQty = symbolInfo.roundQty(qty, stepSize);
        if (minQty && marketQty < parseFloat(String(minQty))) {
          logger.warn({
            tradeId: trade._id.toString(),
            symbol: this.bot.symbol,
            requestedQty: qty,
            roundedQty: marketQty,
            minQty: String(minQty),
            stepSize: String(stepSize),
          }, 'trader: _emergencyMarketSell — rounded qty below minQty, attempting anyway (Binance may reject)');
        }
      } catch (e) {
        logger.warn({
          tradeId: trade._id.toString(),
          symbol: this.bot.symbol,
          err: e.message,
        }, 'trader: _emergencyMarketSell — symbolInfo load failed, using raw qty');
      }

      const resp = await binanceRest.newOrder({
        symbol: this.bot.symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: marketQty.toString(),
        newClientOrderId: marketSellId,
        recvWindow: config_recvWindow(),
      }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

      if (resp.error) {
        logger.error({
          err: resp.error,
          tradeId: trade._id.toString(),
        }, 'trader: EMERGENCY MARKET SELL also failed');
        // FIX-2026-08-05: clear sellInFlight on place failure so caller can retry
        await Trade.updateOne(
          { _id: trade._id, sellInFlight: true },
          { $set: { sellInFlight: false, sellInFlightAt: null, sellStatus: '' } }
        ).catch(() => null);
        return false;
      }

      // MARKET fill ทันที → คำนวณ avgPrice จาก fills หรือใช้ cummulativeQuoteQty/executedQty
      const avgSell = parseFloat(resp.price)
        || parseFloat(resp.avgPrice)
        || (parseFloat(resp.cummulativeQuoteQty) / parseFloat(resp.executedQty));
      const executed = parseFloat(resp.executedQty);
      const marketCumQuote = parseFloat(resp.cummulativeQuoteQty);

      // FIX-2026-07-30: cumulative PnL — รวมทั้ง 2 legs (TP-fill + MARKET-fill) เมื่อ alreadyFilledQty > 0
      const totalQty = alreadyFilledQty + executed;
      const totalCumQuote = alreadyCumQuote + marketCumQuote;
      const avgSellCombined = totalQty > 0 ? totalCumQuote / totalQty : 0;

      const feeRate = fees.getMakerRate();
      let net, pnlPct, buyQuoteQtyForPct;
      if (alreadyFilledQty > 0) {
        // Partial-fill path — คำนวณ PnL จาก 2 legs
        const tpGross = alreadyFilledQty * (alreadyAvgSellPrice - buyPrice);
        const marketGross = executed * (avgSell - buyPrice);
        const tpFees = (buyPrice + alreadyAvgSellPrice) * alreadyFilledQty * feeRate;
        const marketFees = (buyPrice + avgSell) * executed * feeRate;
        net = tpGross + marketGross - tpFees - marketFees;
        buyQuoteQtyForPct = parseFloat(trade.buyQuoteQty) || (buyPrice * (alreadyFilledQty + executed));
        pnlPct = buyQuoteQtyForPct > 0 ? (net / buyQuoteQtyForPct) * 100 : 0;
      } else {
        // Legacy path (CB/stop-loss) — single-leg PnL via fees.calcPnl
        const pnl = fees.calcPnl({ buyPrice, sellPrice: avgSell, qty: executed, feeRate });
        net = pnl.net;
        pnlPct = pnl.pnlPercent;
      }

      // FIX-2026-07-31 (BUG-18): check modifiedCount — race losers (e.g., WS handleSellFilled already
      //   transitioned to 'sold') would otherwise double-count totalPnl/totalTrades.
      //   Mirror forceClose.js:138 pattern — gate Bot.$inc on modifiedCount===1.
      const marketSellUpd = await Trade.updateOne(
        {
          _id: trade._id,
          state: { $in: allowStates },
          sellInFlight: true,
        },
        {
          state: 'sold',
          sellOrderId: resp.orderId,
          sellClientOrderId: marketSellId,
          sellPrice: avgSellCombined || avgSell,
          sellFilledQty: totalQty,
          sellAvgPrice: avgSellCombined || avgSell,
          sellCumulativeQuoteQty: totalCumQuote,
          sellQty: totalQty,
          sellQuoteQty: totalCumQuote,
          sellStatus: resp.status,
          sellFilledAt: new Date(resp.updateTime || Date.now()),
          sellPlacedAt: new Date(),
          targetSellPrice: parseFloat(targetSellPrice),
          realizedPnl: net,
          pnlPercent: pnlPct,
          error: alreadyFilledQty > 0
            ? `${reasonNote} → MARKET fallback used (partial-fill: ${alreadyFilledQty}@${alreadyAvgSellPrice} + ${executed}@${avgSell})`
            : `${reasonNote} → MARKET fallback used`,
          // FIX-2026-07-31 (F1): reset SL-on-UKC auto-arm flag
          useStopLossOnUKC: false,
          autoArmedAt: null,
          // FIX-2026-08-03: clear F1 threshold snapshots เมื่อ trade ออกจาก selling
          autoArmLossPct: null,
          autoArmAgeHours: null,
          // FIX-2026-08-01: reset SELL partial-fill latch
          sellPartialDetectedAt: null,
          sellPartialLatchedAt: null,
          sellPartialLatchedReason: null,
          // FIX-2026-08-05: clear SELL placement in-flight flag (success path)
          sellInFlight: false,
          sellInFlightAt: null,
          // FIX-2026-08-01: structured sellReason — caller passes opts.reason (e.g. 'cb_panic',
          //   'stop_loss_upper_kc'); default 'market_fallback' for validation/LIMIT reject paths.
          sellReason: opts.reason || 'market_fallback',
          sellReasonDetail: reasonNote || `MARKET emergency qty=${qty} avgSell=${(avgSellCombined || avgSell).toFixed(6)}`,
          sellReasonAt: new Date(),
          sellReasonSource: '_emergencyMarketSell',
        }
      );

      if (marketSellUpd.modifiedCount === 0) {
        // Race lost — another path (WS handleSellFilled) already moved state to 'sold'.
        // Don't double-count bot stats. The MARKET order was placed on Binance and filled —
        // record as orphanDetected so reconciler can audit, but don't $inc totals.
        logger.warn({
          tradeId: trade._id.toString(),
          marketOrderId: resp.orderId,
          alreadyFilledQty, executed,
        }, '_emergencyMarketSell — claim failed (race lost), skip Bot.$inc to avoid double-count');
        // FIX-2026-08-05: clear sellInFlight since we lost the race (state already moved on by another path)
        await Trade.updateOne(
          { _id: trade._id, sellInFlight: true },
          { $set: { sellInFlight: false, sellInFlightAt: null } }
        ).catch(() => null);
        // Try to record audit flag — state may already be 'sold' so this may not match
        Trade.updateOne(
          { _id: trade._id },
          { $set: { orphanDetected: true, orphanReason: `_emergencyMarketSell claim lost race — MARKET ${resp.orderId} placed but state already 'sold'` } }
        ).catch(() => null);
        return false;
      }

      // update bot stats — ใช้ $inc (atomic) กัน lost update
      await Bot.updateOne(
        { _id: this.bot._id },
        {
          $inc: {
            totalPnl: net,
            totalTrades: 1,
            winTrades: (net > 0 ? 1 : 0),
          },
          $set: { status: 'idle', lastError: '' },
        }
      );

      // FIX-2026-08-09: DPS loss-path coverage — _emergencyMarketSell is the exit for
      //   cb_panic / cbv2_panic(v1) / sl_ukc_manual / market_fallback / LIMIT reject paths.
      //   before this hook, all those paths left DPS state untouched → Rule 3 (loss-streak)
      //   never fired in production. Now routed through the same helper as forceClose + handleSellFilled.
      try {
        const dpsAfterClose = require('./dpsAfterClose');
        await dpsAfterClose.evaluateDpsAfterClose({
          bot: this.bot,
          pnl: net,
          pnlPct,
          source: `trader:_emergencyMarketSell:${opts.reason || 'market_fallback'}`,
        });
      } catch (dpsErr) {
        logger.warn({ err: dpsErr.message, tradeId: trade._id.toString() }, 'trader: _emergencyMarketSell DPS failed (non-fatal)');
      }

      this._unregisterTrade(trade);
      this.currentTrade = null;
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
      // FIX-2026-08-01: include reason + reasonDetail so dashboardWs/telegramNotifier pick it up
      eventBus.emit('trade:update', {
        tradeId: trade._id,
        botId: this.bot._id,
        state: 'sold',
        reason: opts.reason || 'market_fallback',
        reasonDetail: reasonNote || null,
      });
      // FIX-2026-08-06 (P4): slippage check for MARKET emergency SELL
      //   - MARKET SELL = bottom-of-book fill, almost always < LIMIT_MAKER target
      //   - warn on slip > 1%, telegram alert on slip > 3%
      const emergencyTarget = parseFloat(targetSellPrice || 0);
      if (emergencyTarget > 0) {
        this._computeSlippage({
          sellPrice: avgSellCombined || avgSell,
          targetSellPrice: emergencyTarget,
          tradeId: trade._id,
          sellReason: opts.reason || 'market_fallback',
          pnlPercent: pnlPct,
        });
      }
      logger.warn({
        tradeId: trade._id.toString(),
        pnl: net,
        avgSell: avgSellCombined || avgSell,
        partialFill: alreadyFilledQty > 0 ? `${alreadyFilledQty}@${alreadyAvgSellPrice} + ${executed}@${avgSell}` : null,
      }, 'trader: EMERGENCY MARKET SELL succeeded');
      return true;
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'trader: _emergencyMarketSell error');
      return false;
    }
  }

  // FIX 1: schedule holding retry — พยายาม SELL ใหม่ทุก 30s สำหรับ stranded positions
  // FIX P1.5: เปลี่ยนเป็น async เพื่อรองรับ counter guard ที่มี await
  // FIX-2026-07-31 (BUG-12): per-trade persisted counter (trade.holdingRetryCount) — แต่ละ stranded
  //   position มี budget แยก 10 retries แทนที่จะแชร์ global this.holdingRetryCount เดียว
  //   กัน multi-trade bots ที่ trade แรกหมด budget แล้ว trade อื่นถูกปล่อยทิ้ง
  async scheduleHoldingRetry(trade, qty, buyPrice, targetSellPrice) {
    if (this.holdingRetryTimer) clearTimeout(this.holdingRetryTimer);
    if (!this.running) return;

    // FIX P1.5: counter ป้องกัน retry loop infinite — max 10 ครั้ง (~10 นาที)
    //   เดิม: schedule 60s เรื่อยๆ ไม่จำกัด → ถ้า MARKET SELL fail ตลอด (เช่น API key หมดสิทธิ์) → ค้างเป็นชั่วโมง
    //   fix: นับ counter, ถ้าเกิน 10 ครั้ง → mark stuck + alert telegram แทนการ retry
    const MAX_HOLDING_RETRIES = 10;
    // FIX-2026-07-31 (BUG-12): atomic $inc on per-trade counter (returns updated doc)
    const incRes = await Trade.findOneAndUpdate(
      { _id: trade._id, state: 'holding' },
      { $inc: { holdingRetryCount: 1 } },
      { new: true }
    );
    if (!incRes) {
      // trade ไม่ได้อยู่ใน holding แล้ว — abort
      return;
    }
    const retryCount = incRes.holdingRetryCount;
    if (retryCount > MAX_HOLDING_RETRIES) {
      logger.error({
        tradeId: trade._id.toString(),
        botId: this.bot._id.toString(),
        symbol: this.bot.symbol,
        retryCount: retryCount - 1,
        maxRetries: MAX_HOLDING_RETRIES,
      }, 'trader: holding retry exhausted — MANUAL INTERVENTION REQUIRED');
      // alert telegram — ใช้ eventBus เพื่อไม่ couple กับ telegramNotifier
      eventBus.emit('insufficient:balance', {
        botId: this.bot._id,
        symbol: this.bot.symbol,
        note: `⚠️ Holding retry exhausted after ${MAX_HOLDING_RETRIES} attempts — manual intervention required (trade ${trade._id})`,
      });
      // mark stuck ใน trade เพื่อให้เห็นใน UI + reset counter
      await Trade.updateOne(
        { _id: trade._id, state: 'holding' },
        { $set: { state: 'holding', error: `stuck: holding_retry_exhausted_${MAX_HOLDING_RETRIES}`, holdingRetryCount: 0 } }
      ).catch(() => null);
      return;
    }

    this.holdingRetryTimer = setTimeout(async () => {
      if (!this.running) return;
      try {
        // เช็คว่า trade ยังเป็น holding + มี asset จริง
        const fresh = await Trade.findById(trade._id);
        if (!fresh || fresh.state !== 'holding') {
          logger.info({ tradeId: trade._id.toString(), state: fresh?.state }, 'trader: holding retry — trade no longer holding, abort');
          // FIX-2026-07-31 (BUG-12): reset per-trade counter เมื่อ state เปลี่ยน (success path)
          await Trade.updateOne({ _id: trade._id }, { $set: { holdingRetryCount: 0 } }).catch(() => null);
          return;
        }

        // ตรวจ base asset balance จริง
        // FIX: เช็ค free + locked เพราะ asset อาจถูก lock ใน SELL order ที่ค้างอยู่
        // (เคยมีเคส: SELL reject → asset ถูก lock ใน orphan order → free=0 แต่ locked > 0
        //         → retry loop forever โดยไม่ realize ว่า SELL ยังมีชีวิตอยู่)
        const baseAsset = this.bot.symbol.replace(/USDT$|USDC$|BUSD$/, '');
        const account = await binanceRest.getAccount();
        const bal = (account.balances || []).find((b) => b.asset === baseAsset);
        const freeQty = bal ? parseFloat(bal.free) : 0;
        const lockedQty = bal ? parseFloat(bal.locked) : 0;
        const totalQty = freeQty + lockedQty;

        if (totalQty < qty * 0.95) {
          logger.warn({
            tradeId: trade._id.toString(),
            freeQty, lockedQty, totalQty, expected: qty, baseAsset,
            retryCount: fresh.holdingRetryCount,
          }, 'trader: holding retry — asset balance too low (free+locked < expected), will retry in 60s');
          this.scheduleHoldingRetry(trade, qty, buyPrice, targetSellPrice);
          return;
        }

        // FIX: ถ้า trade มี sellOrderId อยู่แล้ว → เช็ค order status ก่อน
        // (กรณี SELL ถูก place ไปแล้วแต่ trade.state ยัง stuck ที่ holding)
        if (trade.sellOrderId) {
          const order = await binanceRest.getOrder({
            symbol: this.bot.symbol,
            orderId: trade.sellOrderId,
          }).catch(() => null);
          if (order) {
            if (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') {
              logger.warn({
                tradeId: trade._id.toString(),
                sellOrderId: trade.sellOrderId,
                orderStatus: order.status,
                lockedQty,
              }, 'trader: holding retry — asset locked in live SELL, syncing DB to selling');
              // FIX-2026-08-07 (ZBT 17:27 incident): clear stale error field
              //   - เคสก่อนหน้า: placeSell flow โดน -2010 "insufficient balance" จาก Binance settlement race
              //     → set state='holding' + error="-2010: ..." → holding retry path sync state='selling'
              //     แต่ไม่ clear error → UI แสดง "⚠️ -2010" ต่อแม้ SELL วางสำเร็จแล้ว
              //   - เมื่อ SELL live on book (status NEW/PARTIALLY_FILLED) แปลว่า placeSell สำเร็จจริง
              //     → error เก่าเป็น stale เคลียร์ทิ้ง + audit timestamp
              await Trade.updateOne(
                { _id: trade._id, state: 'holding' },
                {
                  $set: {
                    state: 'selling',
                    sellStatus: order.status,
                    error: '',
                    errorClearedAt: new Date(),
                    errorClearedReason: 'holding_retry_sell_synced_live',
                  },
                  $inc: { holdingRetryCount: 0 },
                }
              );
              // FIX-2026-07-31 (BUG-12): reset per-trade counter เมื่อเจอ live SELL
              await Trade.updateOne({ _id: trade._id }, { $set: { holdingRetryCount: 0 } }).catch(() => null);
              return; // SELL ยังมีชีวิต → ปล่อยให้ order:update handler จัดการต่อ
            }
            if (order.status === 'FILLED') {
              logger.warn({
                tradeId: trade._id.toString(),
                sellOrderId: trade.sellOrderId,
              }, 'trader: holding retry — SELL FILLED, finalizing via handleSellFilled');
              this.currentTrade = fresh;
              // FIX-2026-07-13: ใช้ order.cummulativeQuoteQty/executedQty ถ้า order.avgPrice หายไป
              // (LIMIT_MAKER SELL ที่ fill แบบเต็ม → Binance อาจไม่ส่ง avgPrice แต่มี price=TP ซึ่งไม่ใช่ fill price จริง)
              const filledQty = parseFloat(order.executedQty);
              const cumQuote = parseFloat(order.cummulativeQuoteQty);
              const realAvgPrice = (order.avgPrice && parseFloat(order.avgPrice))
                || (cumQuote && filledQty > 0 ? cumQuote / filledQty : 0);
              await this.handleSellFilled({
                executedQty: order.executedQty,
                avgPrice: realAvgPrice,
                cumulativeQuoteQty: order.cummulativeQuoteQty,
                ts: order.updateTime,
              }, fresh);
              // FIX-2026-07-31 (BUG-12): reset per-trade counter หลัง success
              await Trade.updateOne({ _id: trade._id }, { $set: { holdingRetryCount: 0 } }).catch(() => null);
              return;
            }
            if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
              logger.warn({
                tradeId: trade._id.toString(),
                sellOrderId: trade.sellOrderId,
                orderStatus: order.status,
              }, 'trader: holding retry — sellOrderId is CANCELED/EXPIRED, clearing it');
              await Trade.updateOne(
                { _id: trade._id, state: 'holding' },
                { $unset: { sellOrderId: '', sellClientOrderId: '' } }
              );
              trade.sellOrderId = null;
              trade.sellClientOrderId = null;
              // fall through to MARKET SELL below
            }
          }
        }

        // FIX-2026-07-31 (BUG-3): cap sell qty at this trade's qty — never sell the entire free balance
        //   which could include other positions' inventory on the same symbol (multi-trade bots
        //   or 2 bots on same symbol). Use buyFilledQty (post-top-up) or buyQty (initial).
        const tradeMaxQty = parseFloat(trade.buyFilledQty || trade.buyQty) || qty;
        let sellQty = Math.min(freeQty, tradeMaxQty);

        // FIX-2026-08-06 (HOME stuck SL-UKC loop): round sellQty to LOT_SIZE stepSize
        //   - defense-in-depth: forceClose.js also rounds, but if this path is taken first
        //     (scheduleHoldingRetry before SL-UKC) → prevent -1013 LOT_SIZE repeat
        //   - HOME/USDT stepSize=1: freeQty=947.095 → min(947.095, 945) = 945 (in whole units)
        //     but Math.min keeps fractional and 945 is integer so passes here. The trap is
        //     when other symbols have fractional freeQty that exceeds buyQty (e.g. orphan).
        //   - floor to stepSize always to avoid any leftover fractional pass-through
        try {
          const info = await symbolInfo.loadSymbol(this.bot.symbol);
          const stepSize = info.lotSize.stepSize;
          const minQty = info.lotSize.minQty;
          sellQty = symbolInfo.roundQty(sellQty, stepSize);
          if (minQty && sellQty < parseFloat(String(minQty))) {
            // rounded below minQty (orphan portion) → fall back to stepSize×1 or skip
            const stepSizeNum = parseFloat(String(stepSize));
            if (stepSizeNum > 0 && stepSizeNum <= parseFloat(String(minQty))) {
              // stepSize itself >= minQty → use 1 step
              sellQty = stepSizeNum;
            } else {
              // too small → skip retry, hope partial-fill finalize or other path handles
              logger.warn({
                tradeId: trade._id.toString(),
                symbol: this.bot.symbol,
                sellQty, minQty: String(minQty), stepSize: String(stepSize),
              }, 'trader: holding retry — sellQty below minQty after stepSize rounding, skip');
              return;
            }
          }
        } catch (e) {
          // symbolInfo load failed → continue with unrounded qty (Binance will reject if wrong)
          logger.warn({
            tradeId: trade._id.toString(),
            symbol: this.bot.symbol,
            err: e.message,
          }, 'trader: holding retry — symbolInfo round failed, continuing with raw sellQty');
        }

        // FIX-2026-08-05: atomic claim BEFORE placing MARKET order — กัน DUPLICATE SELL
        //   - ป้องกัน async race: scheduleHoldingRetry มี async gap ระหว่าง clearTimeout/setTimeout
        //     → 2 timers เกิดพร้อมกัน, ทั้ง 2 วาง MARKET SELL, ทั้ง 2 fill → orphan SELL
        //   - HOMEUSDT incident 2026-08-05T00:20:04: 2 timers placed SELL 283049653 + 283049654
        //     (qty=878 each), ทั้งคู่ fill → 882 HOME ของ stuck trade ถูกกินโดย orphan 283049654
        //   - atomic filter `sellInFlight: {$ne: true}` + state='holding' → ถ้า claim fail = path อื่นกำลัง place SELL อยู่ → abort
        const placeClaim = await Trade.findOneAndUpdate(
          {
            _id: trade._id,
            state: 'holding',
            sellInFlight: { $ne: true },
          },
          {
            $set: {
              sellInFlight: true,
              sellInFlightAt: new Date(),
              // FIX-2026-08-05: transition to 'selling' so other paths skip this trade
              state: 'selling',
              sellStatus: 'PLACING',
            },
          },
          { new: true }
        );
        if (!placeClaim) {
          logger.warn({
            tradeId: trade._id.toString(),
            retryCount: fresh.holdingRetryCount,
            sellQty,
          }, 'trader: holding retry — another path already placing SELL (sellInFlight claim failed), abort');
          // ไม่ schedule retry ใหม่ — ปล่อยให้ path ที่ claim สำเร็จจัดการ
          return;
        }

        logger.warn({
          tradeId: trade._id.toString(),
          freeQty, qty, tradeMaxQty, sellQty,
          retryCount: fresh.holdingRetryCount,
        }, 'trader: holding retry — found asset, attempting MARKET SELL (capped at trade qty)');

        // ลอง MARKET ก่อน (LIMIT_MAKER มัก reject ซ้ำด้วยสาเหตุเดิม)
        const retrySellId = this.makeClientOrderId('retry-sell', Date.now(), 0);
        const resp = await binanceRest.newOrder({
          symbol: this.bot.symbol,
          side: 'SELL',
          type: 'MARKET',
          quantity: sellQty.toString(),
          newClientOrderId: retrySellId,
          recvWindow: config_recvWindow(),
        }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

        if (resp.error) {
          logger.error({ err: resp.error, tradeId: trade._id.toString(), retryCount: fresh.holdingRetryCount }, 'trader: holding retry MARKET SELL failed');
          // FIX-2026-08-05: clear sellInFlight + revert state to holding so next retry can claim
          await Trade.updateOne(
            { _id: trade._id, sellInFlight: true },
            { $set: { state: 'holding', sellStatus: 'CANCELED', sellInFlight: false, sellInFlightAt: null }, $unset: { sellOrderId: '', sellClientOrderId: '' } }
          ).catch(() => null);
          // FIX P1.5: counter จะถูก increment ใน scheduleHoldingRetry call ถัดไป
          //   ถ้าเกิน MAX_HOLDING_RETRIES จะ alert + abort
          if (this.running) {
            this.holdingRetryTimer = setTimeout(() => this.scheduleHoldingRetry(trade, qty, buyPrice, targetSellPrice), 60 * 1000);
          }
          return;
        }

        const avgSell = parseFloat(resp.price)
          || parseFloat(resp.avgPrice)
          || (parseFloat(resp.cummulativeQuoteQty) / parseFloat(resp.executedQty));
        const executed = parseFloat(resp.executedQty);
        const feeRate = fees.getMakerRate();
        const pnl = fees.calcPnl({
          buyPrice,
          sellPrice: avgSell,
          qty: executed,
          feeRate,
        });

        await Trade.updateOne(
          { _id: trade._id, state: 'selling', sellInFlight: true },
          {
            $set: {
              state: 'sold',
              sellOrderId: resp.orderId,
              sellClientOrderId: retrySellId,
              sellPrice: avgSell,
              // FIX-2026-08-06: P2 — persist sellAvgPrice alias (same as handleSellFilled)
              sellAvgPrice: avgSell,
              sellQty: executed,
              sellQuoteQty: parseFloat(resp.cummulativeQuoteQty),
              sellStatus: resp.status,
              sellFilledAt: new Date(resp.updateTime || Date.now()),
              sellPlacedAt: new Date(),
              realizedPnl: pnl.net,
              pnlPercent: pnl.pnlPercent,
              targetSellPrice: parseFloat(targetSellPrice),
              // FIX-2026-08-06: derive sellReason — holding retry MARKET path = 'holding_retry_recovered'
              //   - ก่อนหน้านี้ path นี้ไม่ตั้ง sellReason → DB sellReason=null → dashboard/audit miss
              //   - fix: ตั้ง 'holding_retry_recovered' ทันทีที่ MARKET fill (เป็น source of truth)
              sellReason: 'holding_retry_recovered',
              sellReasonAt: new Date(),
              sellReasonSource: 'scheduleHoldingRetry',
              holdingRetryCount: 0, // FIX-2026-07-31 (BUG-12): reset on success
              // FIX-2026-07-31 (F1): reset SL-on-UKC auto-arm flag
              useStopLossOnUKC: false,
              autoArmedAt: null,
              // FIX-2026-08-03: clear F1 threshold snapshots เมื่อ trade ออกจาก selling
              autoArmLossPct: null,
              autoArmAgeHours: null,
              // FIX-2026-08-01: reset SELL partial-fill latch
              sellPartialDetectedAt: null,
              sellPartialLatchedAt: null,
              sellPartialLatchedReason: null,
              // FIX-2026-08-05: clear SELL placement in-flight flag
              sellInFlight: false,
              sellInFlightAt: null,
            },
          }
        );

        // FIX-2026-08-06: P4 — slippage detection (holding retry MARKET fallback path)
        //   - เคสนี้แหละคือ slippage หนักสุด — MARKET fill ตอน TP ไม่ถึง
        //   - alert telegram เมื่อ slip < -3% (ผู้ใช้จะได้เห็นทันที)
        this._computeSlippage({
          sellPrice: avgSell,
          targetSellPrice: parseFloat(targetSellPrice) || 0,
          tradeId: trade._id,
          sellReason: 'holding_retry_recovered',
          pnlPercent: pnl.pnlPercent,
        });

        await Bot.updateOne(
          { _id: this.bot._id },
          {
            $inc: {
              totalPnl: pnl.net,
              totalTrades: 1,
              winTrades: (pnl.net > 0 ? 1 : 0),
            },
            $set: { status: 'idle', lastError: '' },
          }
        );

        this._unregisterTrade(trade);
        if (this.currentTrade && this.currentTrade._id.toString() === trade._id.toString()) {
          this.currentTrade = null;
        }
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
        // FIX-2026-08-01: holding retry recovered via MARKET
        eventBus.emit('trade:update', {
          tradeId: trade._id,
          botId: this.bot._id,
          state: 'sold',
          reason: trade.sellReason || 'holding_retry_recovered',
          reasonDetail: trade.sellReasonDetail || `recovered via MARKET SELL after ${trade.holdingRetryCount || 0} retries`,
        });
        logger.warn({
          tradeId: trade._id.toString(),
          pnl: pnl.net,
          avgSell,
        }, 'trader: holding retry — RECOVERED stranded position via MARKET SELL');
      } catch (err) {
        logger.error({ err: err.message, tradeId: trade._id.toString() }, 'trader: holding retry failed');
        // FIX-2026-08-05: clear sellInFlight + revert state to holding so next retry can claim
        await Trade.updateOne(
          { _id: trade._id, sellInFlight: true },
          { $set: { state: 'holding', sellInFlight: false, sellInFlightAt: null } }
        ).catch(() => null);
        // schedule อีก 60s
        if (this.running) {
          this.holdingRetryTimer = setTimeout(() => this.scheduleHoldingRetry(trade, qty, buyPrice, targetSellPrice), 60 * 1000);
        }
      }
    }, 30 * 1000);
  }

  async handlePartialBuyFill(trade, order, signalDoc, candle) {
    // FIX-2026-07-31 (BUG-16): running check — guard against WS events after stop()
    if (!this.running) return;
    // วาง SELL เฉพาะส่วนที่ fill แล้ว + cancel ที่เหลือ
    try {
      const filledQty = parseFloat(order.executedQty);
      if (filledQty <= 0) {
        this.scheduleRetryCheck(candle, signalDoc);
        return;
      }
      const avgPrice = parseFloat(order.avgPrice)
        || (parseFloat(order.cummulativeQuoteQty) / filledQty);
      const cumQuote = parseFloat(order.cummulativeQuoteQty);

      // ─── FIX-2026-07-23 #1: atomic claim + idempotency guard ────────────────
      // กัน race condition ระหว่าง WS path (onBuyOrderUpdate) กับ timer path
      // (checkBuyOrder) ที่อาจเห็น PARTIALLY_FILLED พร้อมกัน — ตัวที่ 2 ต้อง abort
      const claim = await Trade.findOneAndUpdate(
        { _id: trade._id, state: 'placed' },
        {
          $set: {
            state: 'filled',
            buyStatus: 'PARTIALLY_FILLED',
            buyQty: filledQty,
            buyPrice: avgPrice,
            buyQuoteQty: cumQuote,
            buyFilledAt: new Date(),
          },
        },
        { new: true }
      );
      if (!claim) {
        // Lost the race — อีก path ได้ claim ไปแล้ว (state เปลี่ยนเป็น 'filled'/'selling'/...)
        const current = await Trade.findById(trade._id).select('state').lean();
        logger.info({
          tradeId: trade._id.toString(),
          currentState: current && current.state,
        }, 'trader: handlePartialBuyFill — already handled by another path, abort');
        return;
      }

      // FIX-2026-08-02: emit 'filled' (BUY filled) สำหรับ partial-fill path
      //   - ก่อนหน้านี้ handlePartialBuyFill เปลี่ยน placed → filled แบบ silent (ไม่ emit)
      //     ทำให้ telegramNotifier ไม่เห็น state='filled' event → BUY notification ไม่เด้ง
      //   - AEVO incident 13:28 +07 (2026-08-02): PARTIALLY_FILLED BUY ที่ buyFilledAt=06:27:39Z
      //     state='filled' แล้ว แต่ telegramNotifier ไม่ได้รับ event เลย → ไม่มี 🟢 BUY notification
      //   - emit targetSellPrice=null เพราะยังไม่ได้คำนวณ TP (จะคำนวณตอน place SELL ด้านล่าง)
      eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'filled',
        targetSellPrice: null,
        reason: null,
        reasonDetail: null,
      });

      // ─── FIX-2026-07-23 #2: NOTIONAL pre-check ──────────────────────────
      // ถ้า filled qty × price < MIN_NOTIONAL → อย่า cancel remaining BUY
      //   ปล่อยให้ fill เพิ่มจนกว่าจะผ่าน (กัน SELL rejection loop)
      const symCached = symbolInfo.getCached(this.bot.symbol);
      if (symCached && symCached.notional && symCached.notional.minNotional) {
        const minNotional = parseFloat(symCached.notional.minNotional.toString());
        const notionalNow = filledQty * avgPrice;
        if (notionalNow < minNotional) {
          logger.warn({
            tradeId: claim._id.toString(),
            botId: this.bot._id.toString(),
            symbol: this.bot.symbol,
            filledQty, avgPrice,
            notional: notionalNow.toFixed(4),
            minNotional,
          }, 'trader: partial fill below MIN_NOTIONAL — leaving BUY open for accumulation');
          // คง BUY order ไว้, schedule watcher poll ทุก 30s
          this.schedulePartialFillWatch(claim);
          return;
        }
      }

      // ─── ตอนนี้พอจะขายได้ → cancel remaining BUY ก่อน ─────────────────────
      await binanceRest.cancelOrder({
        symbol: this.bot.symbol,
        orderId: trade.buyOrderId,
      }).catch(() => null);

      // FIX-2026-08-02: use _computeTp() helper (was: this.bot.tpPercent only — no mult, no fee buffer)
      const tp = await this._computeTp({ buyPrice: avgPrice });
      const sellPrice = tp.sellPrice;

      const sellClientOrderId = this.makeClientOrderId('sell', Date.now(), trade.retryCount || 0);
      const sellResp = await binanceRest.newOrder({
        symbol: this.bot.symbol,
        side: 'SELL',
        type: 'LIMIT_MAKER',
        quantity: filledQty.toString(),
        price: sellPrice,
        newClientOrderId: sellClientOrderId,
        recvWindow: config_recvWindow(),
      }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

      if (sellResp.error) {
        // FIX 1: MARKET fallback ก่อน mark holding
        const ok = await this._emergencyMarketSell(trade, filledQty, avgPrice, sellPrice,
          `partial-fill SELL rejected: ${sellResp.error.code}`);
        if (!ok) {
          await Trade.updateOne({ _id: trade._id }, { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: `${sellResp.error.code}: ${sellResp.error.msg}` });
          await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
          eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
          this.scheduleHoldingRetry(trade, filledQty, avgPrice, sellPrice);
        }
        return;
      }

      await Trade.updateOne(
        { _id: trade._id },
        {
          sellOrderId: sellResp.orderId,
          sellClientOrderId,
          sellPrice: parseFloat(sellPrice),
          sellQty: filledQty,
          sellStatus: sellResp.status,
          targetSellPrice: parseFloat(sellPrice),
          state: 'selling',
        }
      );
      this.currentTrade.state = 'selling';
      this.currentTrade.sellOrderId = sellResp.orderId;
      this.currentTrade.sellClientOrderId = sellClientOrderId;
      // FIX-2026-07-23 #3: cancel pending retry timer — BUY already cancelled,
      // SELL is now in flight. checkBuyOrder would otherwise fire 60s later and
      // (without state guard) overwrite state='selling' with 'cancelled'.
      if (this.retryCheckTimer) {
        clearTimeout(this.retryCheckTimer);
        this.retryCheckTimer = null;
      }
      this._registerTrade({ buyClientOrderId: trade.buyClientOrderId, sellClientOrderId });

      await Bot.updateOne({ _id: this.bot._id }, { status: 'selling', lastError: '' });
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'selling' });
      eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'selling',
        reason: null,
        reasonDetail: null,
      });
    } catch (err) {
      logger.error({ err: err.message }, 'trader: handlePartialBuyFill error');
    }
  }

  // ─── FIX-2026-07-23 #3: partial-fill watcher ────────────────────────────────
  // - poll สถานะ BUY order ที่ถูกทิ้งไว้ (filledQty × price < MIN_NOTIONAL)
  // - เมื่อ fill เพิ่มจนพอ → ยกเลิก BUY, วาง SELL ตามปกติ
  // - เมื่อ BUY ถูก CANCELED/EXPIRED ภายนอก → สร้าง recovery record
  // - FIX-2026-07-23: deadline tracking — เก็ม partialFillDeadlineAt = buyPlacedAt + retryTimeMin×retryMax
  //   เมื่อครบ deadline → checkPartialFill เรียก _finalizePartialAfterDeadline ตาม notional
  // FIX P3.1: persist deadline ใน DB → restore ได้หลัง bot restart (เดิม instance-only)
  // FIX-2026-07-31 (BUG-19): deadline restore in start() — re-arm ตัว watcher ใหม่ หลัง restart
  //   เดิม: trade ที่ persisted deadline อยู่ในอนาคต แต่ timer ไม่ได้รัน → deadline ตาย
  async _rearmPersistedPartialFillWatchers() {
    if (!this.running) return;
    const now = new Date();
    // BUY side — state='filled' (after handlePartialBuyFill claim) + deadline > now
    const buyTrades = await Trade.find({
      botId: this.bot._id,
      state: 'filled',
      buyStatus: 'PARTIALLY_FILLED',
      partialFillDeadlineAt: { $gt: now },
      buyOrderId: { $exists: true, $ne: null },
    }).limit(20).lean();

    for (const t of buyTrades) {
      this.schedulePartialFillWatch(t);
      logger.info({
        tradeId: t._id.toString(),
        deadlineAt: t.partialFillDeadlineAt,
        executedQty: t.buyQty,
      }, 'trader: re-armed BUY partial-fill watcher after restart (FIX BUG-19)');
    }

    // SELL side — state='selling' + sellPartialDeadlineAt > now + SELL still PARTIALLY_FILLED
    const sellTrades = await Trade.find({
      botId: this.bot._id,
      state: 'selling',
      sellStatus: 'PARTIALLY_FILLED',
      sellPartialDeadlineAt: { $gt: now },
      sellOrderId: { $exists: true, $ne: null },
    }).limit(20).lean();

    for (const t of sellTrades) {
      this.scheduleSellPartialFillWatch(t);
      logger.info({
        tradeId: t._id.toString(),
        deadlineAt: t.sellPartialDeadlineAt,
        sellFilledQty: t.sellFilledQty,
      }, 'trader: re-armed SELL partial-fill watcher after restart (FIX BUG-19)');
    }
  }

  schedulePartialFillWatch(trade) {
    if (this.partialFillTimer) {
      clearTimeout(this.partialFillTimer);
      this.partialFillTimer = null;
    }
    if (!this.running || !trade || !trade._id) return;
    const tradeIdStr = trade._id.toString();
    // FIX-2026-07-23: คำนวณ deadline ตาม retryTimeMin × retryMax (นาที)
    //   - ถ้าไม่มี buyPlacedAt (เช่น recovery record) → ใช้ now เป็น base
    //   - FIX P3.1: persist ใน DB ด้วย — restore ได้หลัง restart
    const retryMax = this.bot.retryMax ?? 1;
    const retryTimeMin = this.bot.retryTimeMin ?? 1;
    const placedAtMs = trade.buyPlacedAt ? new Date(trade.buyPlacedAt).getTime() : Date.now();
    const deadlineMs = placedAtMs + retryTimeMin * retryMax * 60 * 1000;
    this.partialFillDeadlineAt = deadlineMs;
    this._partialFillTradeId = tradeIdStr;
    // FIX P3.1: persist deadline ลง DB แบบ fire-and-forget
    Trade.updateOne(
      { _id: trade._id },
      { $set: { partialFillDeadlineAt: new Date(deadlineMs) } }
    ).catch((err) => logger.warn({ err: err.message, tradeId: tradeIdStr }, 'trader: persist partialFillDeadline failed'));
    logger.info({
      botId: this.bot._id.toString(),
      tradeId: tradeIdStr,
      placedAtMs,
      deadlineMs,
      retryTimeMin,
      retryMax,
      deadlineAt: new Date(deadlineMs).toISOString(),
    }, 'trader: partial-fill watch scheduled with deadline');
    this.partialFillTimer = setTimeout(async () => {
      try {
        await this.checkPartialFill(tradeIdStr);
      } catch (err) {
        logger.error({ err: err.message, tradeId: tradeIdStr }, 'trader: checkPartialFill crashed');
      }
    }, 30 * 1000);
  }

  async checkPartialFill(tradeIdStr) {
    // FIX-2026-07-31 (BUG-6): abort if bot stopped — prevents placing real orders after stop()
    if (!this.running) return;
    const fresh = await Trade.findById(tradeIdStr);
    if (!fresh) return;
    if (this.bot._id.toString() !== fresh.botId.toString()) return;

    // ถ้า state เปลี่ยนแล้ว (someone else handled) → หยุด watch
    if (fresh.state !== 'filled' || fresh.buyStatus !== 'PARTIALLY_FILLED') {
      logger.debug({
        tradeId: tradeIdStr, currentState: fresh.state, currentBuyStatus: fresh.buyStatus,
      }, 'trader: partial-fill watch — trade no longer in filled/partial state, stop');
      return;
    }

    // FIX P3.1: restore deadline จาก DB (ถ้า instance var หายไป เช่น หลัง restart)
    if (!this.partialFillDeadlineAt && fresh.partialFillDeadlineAt) {
      this.partialFillDeadlineAt = new Date(fresh.partialFillDeadlineAt).getTime();
      logger.info({
        tradeId: tradeIdStr,
        restoredDeadlineMs: this.partialFillDeadlineAt,
      }, 'trader: partial-fill watch — restored deadline from DB after restart');
    }

    let order;
    try {
      order = await binanceRest.getOrder({
        symbol: this.bot.symbol,
        orderId: fresh.buyOrderId,
      });
    } catch (err) {
      logger.warn({ err: err.message, tradeId: tradeIdStr }, 'trader: partial-fill watch — getOrder failed, retry in 30s');
      this.schedulePartialFillWatch(fresh);
      return;
    }
    if (!order || !order.orderId) {
      this.schedulePartialFillWatch(fresh);
      return;
    }

    const filledQty = parseFloat(order.executedQty);
    const avgPrice = parseFloat(order.avgPrice)
      || (parseFloat(order.cummulativeQuoteQty) / filledQty);

    // FIX-2026-07-23: deadline gate — ถ้าเลย retryTimeMin × retryMax แล้ว → ตัดสินใจ accept_partial หรือ top_up_market
    //   - ผู้ใช้ต้องการ "รอให้ครบ retry window ก่อนตัดสินใจ" ไม่ใช่ trigger SELL ทันทีที่ notional ≥ MIN_NOTIONAL
    //   - deadlineAt set ใน schedulePartialFillWatch ครั้งแรก; ถ้า partialFillTimer ยัง tick อยู่แต่ state
    //     ถูก handle จาก WS path → check นี้จะไม่ trigger (อยู่ใน closure)
    const now = Date.now();
    const deadlinePassed = this.partialFillDeadlineAt && now >= this.partialFillDeadlineAt;

    // ถ้า BUY fill ครบหมดแล้ว → handle normally
    if (order.status === 'FILLED') {
      logger.info({
        tradeId: tradeIdStr,
        filledQty, avgPrice,
      }, 'trader: partial-fill watch — BUY now fully FILLED, processing SELL');
      const sig = fresh.signalId ? await Signal.findById(fresh.signalId).catch(() => null) : null;
      const candle = { closeTime: Date.now(), close: avgPrice };
      await this.handleBuyFilled(fresh, order, sig);
      return;
    }

    // BUY ยังเปิดอยู่ (NEW/PARTIALLY_FILLED) → เช็คว่า notional พอหรือยัง
    if (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') {
      const symCached = symbolInfo.getCached(this.bot.symbol);
      const minNotional = symCached && symCached.notional && symCached.notional.minNotional
        ? parseFloat(symCached.notional.minNotional.toString()) : 0;
      const notional = filledQty * avgPrice;

      // ── FIX-2026-07-23 DEADLINE BRANCH ─────────────────────────────────
      // ครบ retry window แล้ว → ตัดสินใจทันที (ไม่รอ notional gate)
      if (deadlinePassed) {
        const sig = fresh.signalId ? await Signal.findById(fresh.signalId).catch(() => null) : null;
        if (notional >= minNotional && minNotional > 0) {
          logger.info({
            tradeId: tradeIdStr,
            filledQty, notional: notional.toFixed(4), minNotional,
            deadlineMs: this.partialFillDeadlineAt,
            nowMs: now,
          }, 'trader: deadline passed — filledNotional ≥ minNotional → accept_partial path');
          await this._finalizePartialAfterDeadline(fresh, order, sig, { mode: 'accept_partial' });
        } else {
          logger.info({
            tradeId: tradeIdStr,
            filledQty, notional: notional.toFixed(4), minNotional,
            deadlineMs: this.partialFillDeadlineAt,
            nowMs: now,
          }, 'trader: deadline passed — filledNotional < minNotional → top_up_market path');
          await this._finalizePartialAfterDeadline(fresh, order, sig, { mode: 'top_up_market' });
        }
        return;
      }
      // ── ก่อน deadline: notional พอแล้ว → เดิม trigger handlePartialBuyFill ทันที ──
      //   แต่ตามที่ผู้ใช้ขอใหม่: "รอจนครบ retry window ก่อน" — ดังนั้นเราเปลี่ยนเป็น schedule ต่อ
      //   (ไม่ trigger SELL ทันทีเมื่อ notional gate ผ่าน เพราะผู้ใช้อยากให้ "เผื่อ" fill ต่อจนครบ deadline)
      if (notional >= minNotional && minNotional > 0) {
        logger.debug({
          tradeId: tradeIdStr,
          filledQty, notional: notional.toFixed(4), minNotional,
          msToDeadline: this.partialFillDeadlineAt ? this.partialFillDeadlineAt - now : null,
        }, 'trader: partial-fill watch — notional now ≥ minNotional, but waiting for deadline before triggering SELL');
        this.schedulePartialFillWatch(fresh);
        return;
      }
      // ยังไม่พอ → schedule อีก 30s
      logger.debug({
        tradeId: tradeIdStr,
        filledQty, notional: notional.toFixed(4), minNotional,
        msToDeadline: this.partialFillDeadlineAt ? this.partialFillDeadlineAt - now : null,
      }, 'trader: partial-fill watch — still below MIN_NOTIONAL, retry in 30s');
      this.schedulePartialFillWatch(fresh);
      return;
    }

    if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
      // BUY ถูก cancel ภายนอก — ถ้ามีบางส่วน fill → พยายาม recover
      if (filledQty > 0) {
        const symCached = symbolInfo.getCached(this.bot.symbol);
        const minNotional = symCached && symCached.notional && symCached.notional.minNotional
          ? parseFloat(symCached.notional.minNotional.toString()) : 0;
        const notional = filledQty * avgPrice;
        if (notional >= minNotional && minNotional > 0) {
          logger.warn({
            tradeId: tradeIdStr,
            filledQty, notional: notional.toFixed(4),
          }, 'trader: partial-fill watch — BUY cancelled but sellable, triggering SELL');
          await Trade.updateOne({ _id: fresh._id }, { state: 'placed' });
          const sig = fresh.signalId ? await Signal.findById(fresh.signalId).catch(() => null) : null;
          const candle = { closeTime: Date.now(), close: avgPrice };
          await this.handlePartialBuyFill(fresh, order, sig, candle);
          return;
        }
        // ไม่พอขาย → mark 'failed' (dust_orphan)
        logger.error({
          tradeId: tradeIdStr, symbol: this.bot.symbol,
          filledQty, notional: notional.toFixed(4), minNotional,
        }, 'trader: partial-fill watch — dust_orphan (BUY cancelled externally, qty below MIN_NOTIONAL)');
        await Trade.updateOne(
          { _id: fresh._id, state: 'filled' },
          {
            state: 'failed',
            buyStatus: order.status,
            buyQty: filledQty,
            buyPrice: avgPrice,
            buyQuoteQty: parseFloat(order.cummulativeQuoteQty),
            error: `dust_orphan ${notional.toFixed(4)} < ${minNotional} (BUY cancelled externally, manual recovery needed)`,
          }
        );
        eventBus.emit('trade:update', {
        tradeId: fresh._id,
        state: 'failed',
        reason: null,
        reasonDetail: null,
      });
        return;
      }
      // ไม่มี fill เลย → cancel ตามปกติ
      await Trade.updateOne(
        { _id: fresh._id, state: 'filled' },
        { state: 'cancelled', buyStatus: order.status }
      );
      eventBus.emit('trade:update', {
        tradeId: fresh._id,
        state: 'cancelled',
        reason: null,
        reasonDetail: null,
      });
      return;
    }
  }

  // ─── FIX-2026-07-23: partial-fill deadline finalizers ──────────────────────
  // เรียกหลัง retryTimeMin × retryMax นาที:
  //   - mode='accept_partial' → filledNotional ≥ MIN_NOTIONAL → place SELL ตาม TP
  //   - mode='top_up_market' → filledNotional < MIN_NOTIONAL → MARKET BUY เพิ่มแล้ว place SELL
  // ใช้ atomic claim (state='placed') เพื่อกัน race กับ handlePartialBuyFill (WS path)
  async _finalizePartialAfterDeadline(trade, order, signalDoc, { mode }) {
    // FIX V1: atomic claim — ตั้ง state='partial_wait' ก่อน helper อื่นเข้ามา claim 'placed'
    // FIX-2026-07-31 (BUG-7): change claim predicate from state='placed' → state='filled'.
    //   handlePartialBuyFill at L2246 claims placed→filled BEFORE schedulePartialFillWatch runs,
    //   so by the time the deadline fires, state is already 'filled'. The old predicate
    //   {state:'placed'} never matched → finalizer always logged "already moved on" and returned
    //   without scheduling → sub-MIN_NOTIONAL partial positions abandoned with live BUY order.
    //   Per user choice 2026-07-31: claim 'filled' instead.
    const claim = await Trade.findOneAndUpdate(
      { _id: trade._id, state: 'filled' },
      {
        $set: {
          state: 'partial_wait',
          partialDecisionAt: new Date(),
          partialDecisionMode: mode,
        },
      },
      { new: true }
    );
    if (!claim) {
      // Lost the race — handler อื่น (WS path, onBuyOrderUpdate, handlePartialBuyFill) claim ไปแล้ว
      // หรือ trade ถูกยกเลิกจากภายนอก ก็ปล่อยให้ handler นั้น process ต่อ
      const cur = await Trade.findById(trade._id).select('state').lean();
      logger.info({
        tradeId: trade._id.toString(),
        requestedMode: mode,
        currentState: cur && cur.state,
      }, 'trader: deadline handler — already moved on (state != placed), abort');
      return;
    }

    logger.info({
      botId: this.bot._id.toString(),
      tradeId: claim._id.toString(),
      mode,
      filledQty: parseFloat(order.executedQty),
      avgPrice: parseFloat(order.avgPrice || 0),
    }, 'trader: deadline handler — atomic claim won, dispatching');

    try {
      if (mode === 'accept_partial') {
        await this._placeSellForPartialFill(claim, order);
      } else {
        await this._topUpAndSell(claim, order);
      }
    } catch (err) {
      // FIX V9: bot stuck ใน 'partial_wait' ถ้า helper crash → fail-safe
      logger.error({
        err: err.message, stack: err.stack,
        tradeId: claim._id.toString(), mode,
      }, 'trader: deadline handler failed — marking trade as failed');
      try {
        // FIX-2026-07-31 (BUG-15): add state filter — without guard, the helper's race-loser path
        //   could legitimately advance state past 'partial_wait' before crash, and this fail-safe
        //   would clobber it. Only write 'failed' if state is still 'partial_wait' (atomic claim state).
        await Trade.updateOne(
          { _id: claim._id, state: 'partial_wait' },
          { state: 'failed', error: `deadline handler (${mode}): ${err.message}` }
        );
        await Bot.updateOne(
          { _id: this.bot._id },
          { status: 'error', lastError: `deadline handler failed: ${err.message}` }
        );
        this._unregisterTrade(claim);
        // FIX-2026-08-02: cancel any SELL orphaned by partial fill before resetting trade
        await this._cancelOrphanedSells(claim, { reason: 'deadline_handler_failed', ctx: 'state=partial_wait' });
        if (this.currentTrade && this.currentTrade._id.toString() === claim._id.toString()) {
          this.currentTrade = null;
        }
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'error' });
        eventBus.emit('trade:update', {
        tradeId: claim._id,
        state: 'failed',
        reason: null,
        reasonDetail: null,
      });
      } catch (cleanupErr) {
        logger.error({ err: cleanupErr.message }, 'trader: deadline handler cleanup failed');
      }
    }
  }

  // ── _placeSellForPartialFill — accept_partial path (filledNotional ≥ MIN_NOTIONAL) ──
  // 1. re-fetch BUY order เพื่อ catch late fills (FIX V2)
  // 2. update trade ด้วย avg BUY price จริง (FIX V7)
  // 3. cancel BUY (idempotent)
  // 4. place SELL ตาม TP
  async _placeSellForPartialFill(trade, order) {
    // FIX V2: re-fetch order เพื่อ catch late fills ระหว่าง cancel-confirm
    let fresh;
    try {
      fresh = await binanceRest.getOrder({
        symbol: this.bot.symbol,
        orderId: trade.buyOrderId,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'trader: accept_partial — re-fetch BUY failed, using order snapshot');
      fresh = order;
    }
    const filledQty = parseFloat(fresh.executedQty || order.executedQty);
    const cumQuote = parseFloat(fresh.cummulativeQuoteQty || order.cummulativeQuoteQty || 0);
    const avgPrice = parseFloat(fresh.avgPrice)
      || (cumQuote > 0 && filledQty > 0 ? cumQuote / filledQty : parseFloat(order.avgPrice || order.price || 0));

    if (filledQty <= 0 || avgPrice <= 0) {
      logger.error({
        tradeId: trade._id.toString(),
        freshStatus: fresh.status, filledQty, avgPrice,
      }, 'trader: accept_partial — invalid filledQty/avgPrice, marking failed');
      await Trade.updateOne(
        { _id: trade._id, state: 'partial_wait' },
        { state: 'failed', error: 'accept_partial: invalid filledQty/avgPrice' }
      );
      return;
    }

    // FIX V7: update trade ด้วย avg BUY price จริง (อาจต่างจาก buyPrice แรก)
    // FIX-2026-08-02: ดึง targetSellPrice ที่ persist ไว้ก่อนหน้า (ถ้ามี — handlePartialBuyFill หรือ top-up เคยตั้งไว้แล้ว)
    //   - ไม่คำนวณ TP ใหม่ที่นี่ — เพราะ TP ต้องคำนวณจาก buyPrice ใหม่, และ BUY ใกล้ deadline แล้ว
    //     ใช้ targetSellPrice เดิมที่คำนวณจากรอบแรก (หรือ top-up รอบก่อน) ก็พอ — SELL จะถูก place ใน _placeSellForPartialFill ด้านล่าง
    const existing = await Trade.findById(trade._id).select('targetSellPrice').lean();
    const preservedTargetSellPrice = existing && existing.targetSellPrice != null
      ? parseFloat(existing.targetSellPrice)
      : null;
    await Trade.updateOne(
      { _id: trade._id, state: 'partial_wait' },
      {
        buyQty: filledQty,
        buyPrice: avgPrice,
        buyQuoteQty: cumQuote,
        buyStatus: fresh.status,
        buyFilledAt: new Date(fresh.updateTime || Date.now()),
        state: 'filled',
        ...(preservedTargetSellPrice != null ? { targetSellPrice: preservedTargetSellPrice } : {}),
      }
    );

    // FIX V6: idempotent cancel (ถ้า CANCELED แล้ว → no-op)
    await binanceRest.cancelOrder({
      symbol: this.bot.symbol,
      orderId: trade.buyOrderId,
    }).catch(() => null);

    // FIX V8: เช็ค MIN_NOTIONAL อีกครั้ง (เผื่อ race ทำให้ notional ลดลง) → MARKET SELL fallback
    const symCached = symbolInfo.getCached(this.bot.symbol);
    const minNotional = symCached && symCached.notional && symCached.notional.minNotional
      ? parseFloat(symCached.notional.minNotional.toString()) : 0;
    if (filledQty * avgPrice < minNotional) {
      logger.warn({
        tradeId: trade._id.toString(),
        filledQty, avgPrice, notional: (filledQty * avgPrice).toFixed(4), minNotional,
      }, 'trader: accept_partial — notional below MIN_NOTIONAL at deadline, fallback to MARKET SELL');
      const ok = await this._emergencyMarketSell(trade, filledQty, avgPrice, 0,
        'partial-fill accept_partial below MIN_NOTIONAL at deadline');
      if (!ok) {
        await Trade.updateOne(
          { _id: trade._id, state: 'filled' },
          { state: 'holding', error: 'accept_partial MARKET SELL fallback failed' }
        );
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'holding',
        reason: null,
        reasonDetail: null,
      });
        this.scheduleHoldingRetry(trade, filledQty, avgPrice, 0);
      }
      return;
    }

    // Place SELL ตาม TP — extract logic จาก handlePartialBuyFill
    // FIX-2026-08-02: use _computeTp() helper (was: this.bot.tpPercent only — no mult, no fee buffer)
    const tp = await this._computeTp({ buyPrice: avgPrice });
    const sellPrice = tp.sellPrice;

    const validation = symbolInfo.validateOrder({ symbol: this.bot.symbol, price: sellPrice, qty: filledQty });
    if (!validation.ok) {
      logger.warn({
        reason: validation.reason, tradeId: trade._id.toString(),
      }, 'trader: accept_partial — SELL validation failed → MARKET fallback');
      const ok = await this._emergencyMarketSell(trade, filledQty, avgPrice, sellPrice,
        `accept_partial validation: ${validation.reason}`);
      if (!ok) {
        await Trade.updateOne(
          { _id: trade._id, state: 'filled' },
          { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: validation.reason }
        );
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'holding',
        reason: null,
        reasonDetail: null,
      });
        this.scheduleHoldingRetry(trade, filledQty, avgPrice, sellPrice);
      }
      return;
    }

    const sellClientOrderId = this.makeClientOrderId('sell', Date.now(), trade.retryCount || 0);

    // FIX-2026-08-06 (HOME stuck SL-UKC loop): round filledQty to stepSize before SELL LIMIT_MAKER
    //   - filledQty มาจาก BUY fills (cumulative) — Binance fills may have fractional leftovers
    //   - e.g. ZIL/USDT stepSize=1: BUY filled 1234.7 → round → 1234
    //   - defense-in-depth: validateOrder above may pass but Binance strict-mode rejects
    let sellFilledQty = filledQty;
    try {
      const stepSize = symCached.lotSize.stepSize;
      const minQty = symCached.lotSize.minQty;
      sellFilledQty = symbolInfo.roundQty(filledQty, stepSize);
      if (minQty && sellFilledQty < parseFloat(String(minQty))) {
        logger.warn({
          tradeId: trade._id.toString(),
          symbol: this.bot.symbol,
          filledQty, sellFilledQty,
          minQty: String(minQty), stepSize: String(stepSize),
        }, 'trader: accept_partial — rounded sellQty below minQty, using filledQty anyway (validation above should have caught)');
        sellFilledQty = filledQty;
      }
    } catch (e) {
      // symCached might be missing lotSize — fall back to raw filledQty
      logger.warn({
        tradeId: trade._id.toString(),
        symbol: this.bot.symbol, err: e.message,
      }, 'trader: accept_partial — symbolInfo round failed, using raw filledQty');
    }

    const sellResp = await binanceRest.newOrder({
      symbol: this.bot.symbol,
      side: 'SELL',
      type: 'LIMIT_MAKER',
      quantity: sellFilledQty.toString(),
      price: sellPrice,
      newClientOrderId: sellClientOrderId,
      recvWindow: config_recvWindow(),
    }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

    if (sellResp.error) {
      logger.warn({
        err: sellResp.error, tradeId: trade._id.toString(),
      }, 'trader: accept_partial — SELL LIMIT_MAKER rejected → MARKET fallback');
      const ok = await this._emergencyMarketSell(trade, filledQty, avgPrice, sellPrice,
        `accept_partial SELL rejected: ${sellResp.error.code}`);
      if (!ok) {
        await Trade.updateOne(
          { _id: trade._id, state: 'filled' },
          { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: `${sellResp.error.code}: ${sellResp.error.msg}` }
        );
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'holding',
        reason: null,
        reasonDetail: null,
      });
        this.scheduleHoldingRetry(trade, filledQty, avgPrice, sellPrice);
      }
      return;
    }

    // SELL placed → state='selling'
    await Trade.updateOne(
      { _id: trade._id, state: 'filled' },
      {
        sellOrderId: sellResp.orderId,
        sellClientOrderId,
        sellPrice: parseFloat(sellPrice),
        sellQty: filledQty,
        sellStatus: sellResp.status,
        sellPlacedAt: new Date(),
        targetSellPrice: parseFloat(sellPrice),
        state: 'selling',
      }
    );
    this.currentTrade.sellOrderId = sellResp.orderId;
    this.currentTrade.sellClientOrderId = sellClientOrderId;
    this.currentTrade.state = 'selling';
    this._registerTrade({ buyClientOrderId: trade.buyClientOrderId, sellClientOrderId });
    // FIX-2026-07-23 #3: cancel pending retry timer
    if (this.retryCheckTimer) {
      clearTimeout(this.retryCheckTimer);
      this.retryCheckTimer = null;
    }

    logger.info({
      botId: this.bot._id.toString(),
      tradeId: trade._id.toString(),
      buyPrice: avgPrice, sellPrice, qty: filledQty,
    }, 'trader: accept_partial — SELL placed');

    await Bot.updateOne({ _id: this.bot._id }, { status: 'selling', lastError: '' });
    eventBus.emit('bot:status', { botId: this.bot._id, status: 'selling' });
    eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'selling',
        reason: null,
        reasonDetail: null,
      });
  }

  // ── _topUpAndSell — top_up_market path (filledNotional < MIN_NOTIONAL) ──
  // 1. re-fetch BUY order (FIX V2)
  // 2. cancel LIMIT_MAKER BUY (ปลดล็อก USDT)
  // 3. MARKET BUY เพิ่มเติมตาม remainingNotional (FIX V3 best-effort)
  // 4. คำนวณ avgBuyPrice รวมทั้งสองส่วน (FIX V7)
  // 5. place SELL ตาม TP
  async _topUpAndSell(trade, order) {
    // FIX V2: re-fetch order
    let fresh;
    try {
      fresh = await binanceRest.getOrder({
        symbol: this.bot.symbol,
        orderId: trade.buyOrderId,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'trader: top_up — re-fetch BUY failed, using order snapshot');
      fresh = order;
    }
    const filledQty = parseFloat(fresh.executedQty || order.executedQty);
    const cumQuote = parseFloat(fresh.cummulativeQuoteQty || order.cummulativeQuoteQty || 0);
    const avgPrice = parseFloat(fresh.avgPrice)
      || (cumQuote > 0 && filledQty > 0 ? cumQuote / filledQty : parseFloat(order.avgPrice || order.price || 0));
    const filledNotional = filledQty * avgPrice;
    const capital = parseFloat(this.bot.capitalPerTrade) || 0;
    const remainingNotional = Math.max(0, capital - filledNotional);

    logger.info({
      tradeId: trade._id.toString(),
      filledQty, avgPrice, filledNotional: filledNotional.toFixed(4),
      capital, remainingNotional: remainingNotional.toFixed(4),
    }, 'trader: top_up — starting');

    // ดึงราคาตลาดปัจจุบัน
    let currentAsk = 0;
    try {
      const ticker = await binanceRest.get24hrTickers({ symbol: this.bot.symbol });
      currentAsk = parseFloat(ticker.askPrice || ticker.lastPrice || 0);
    } catch (err) {
      logger.warn({ err: err.message }, 'trader: top_up — get24hrTickers failed');
    }
    if (currentAsk <= 0) {
      logger.warn({
        tradeId: trade._id.toString(),
      }, 'trader: top_up — cannot read current ask, falling back to accept_partial');
      // FIX-2026-07-31 (BUG-8): keep state as 'partial_wait' instead of downgrading to 'placed'.
      //   _placeSellForPartialFill guards on 'partial_wait' (L2668) then 'filled' (L2780).
      //   Downgrading to 'placed' made all subsequent updates no-op → SELL placed at L2749
      //   but sellOrderId never recorded → guaranteed orphan SELL.
      return this._placeSellForPartialFill(trade, fresh);
    }

    const info = symbolInfo.getCached(this.bot.symbol);
    const stepSize = info.lotSize.stepSize;
    const minNotional = parseFloat(info.notional.minNotional.toString());

    // FIX V3: best-effort top-up — qty จาก remainingNotional / currentAsk, floor ตาม stepSize
    const topUpRawQty = symbolInfo.roundQty(remainingNotional / currentAsk, stepSize);
    let topUpQty = parseFloat(topUpRawQty.toString());

    // sanity check: top-up notional ≥ minNotional ไหม
    if (topUpQty * currentAsk < minNotional) {
      logger.warn({
        tradeId: trade._id.toString(),
        remainingNotional: remainingNotional.toFixed(4),
        topUpQty, currentAsk,
        projectedNotional: (topUpQty * currentAsk).toFixed(4), minNotional,
      }, 'trader: top_up — remaining USDT insufficient for meaningful top-up, falling back to accept_partial');
      // FIX-2026-07-31 (BUG-8): keep state as 'partial_wait' — see L2946 comment
      return this._placeSellForPartialFill(trade, fresh);
    }

    // FIX V2: cancel LIMIT_MAKER BUY ก่อน MARKET BUY (ปลดล็อก USDT)
    try {
      await binanceRest.cancelOrder({
        symbol: this.bot.symbol,
        orderId: trade.buyOrderId,
      });
    } catch (err) {
      // ถ้า cancel fail (order อาจถูก cancel ไปแล้ว) → log แต่ทำต่อ
      logger.warn({
        err: err.message, tradeId: trade._id.toString(),
      }, 'trader: top_up — cancel LIMIT_MAKER BUY failed (continuing)');
    }

    // FIX V4: place MARKET BUY top-up
    let topUpResp;
    try {
      topUpResp = await binanceRest.newOrder({
        symbol: this.bot.symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: topUpQty.toString(),
        newClientOrderId: this.makeClientOrderId('topup', Date.now()),
        newOrderRespType: 'FULL',
        recvWindow: config_recvWindow(),
      });
    } catch (err) {
      const fe = binanceRest.formatBinanceError(err);
      logger.warn({
        err: fe, tradeId: trade._id.toString(),
      }, 'trader: top_up — MARKET BUY failed, falling back to accept_partial');
      // FIX-2026-07-31 (BUG-8): keep state as 'partial_wait' — see L2946 comment
      return this._placeSellForPartialFill(trade, fresh);
    }
    if (topUpResp.error) {
      logger.warn({
        err: topUpResp.error, tradeId: trade._id.toString(),
      }, 'trader: top_up — MARKET BUY rejected, falling back to accept_partial');
      // FIX-2026-07-31 (BUG-8): keep state as 'partial_wait' — see L2946 comment
      return this._placeSellForPartialFill(trade, fresh);
    }

    const topUpExecuted = parseFloat(topUpResp.executedQty);
    const topUpQuote = parseFloat(topUpResp.cummulativeQuoteQty);
    const totalQty = filledQty + topUpExecuted;
    const totalQuote = cumQuote + topUpQuote;
    const avgBuyPrice = totalQty > 0 ? totalQuote / totalQty : avgPrice;

    logger.info({
      tradeId: trade._id.toString(),
      topUpOrderId: topUpResp.orderId,
      topUpQty: topUpExecuted, topUpQuote: topUpQuote.toFixed(4),
      totalQty, avgBuyPrice: avgBuyPrice.toFixed(6), totalQuote: totalQuote.toFixed(4),
    }, 'trader: top_up — MARKET BUY executed');

    // FIX V7: update trade ด้วย avg BUY price รวม top-up + topUpOrderId
    await Trade.updateOne(
      { _id: trade._id, state: 'partial_wait' },
      {
        buyQty: totalQty,
        buyPrice: avgBuyPrice,
        buyQuoteQty: totalQuote,
        buyStatus: 'FILLED',
        buyFilledAt: new Date(),
        topUpOrderId: topUpResp.orderId,
        state: 'filled',
      }
    );

    // FIX V8: เช็ค MIN_NOTIONAL ก่อน place SELL
    const sellNotional = totalQty * avgBuyPrice;
    if (sellNotional < minNotional) {
      logger.warn({
        tradeId: trade._id.toString(),
        totalQty, avgBuyPrice, sellNotional: sellNotional.toFixed(4), minNotional,
      }, 'trader: top_up — total notional still below MIN_NOTIONAL, MARKET SELL fallback');
      const ok = await this._emergencyMarketSell(trade, totalQty, avgBuyPrice, 0,
        'top_up_market total still below MIN_NOTIONAL');
      if (!ok) {
        await Trade.updateOne(
          { _id: trade._id, state: 'filled' },
          { state: 'holding', error: 'top_up MARKET SELL fallback failed' }
        );
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'holding',
        reason: null,
        reasonDetail: null,
      });
        this.scheduleHoldingRetry(trade, totalQty, avgBuyPrice, 0);
      }
      return;
    }

    // Place SELL ตาม TP (avgBuyPrice รวม top-up)
    // FIX-2026-08-02: use _computeTp() helper (was: this.bot.tpPercent only — no mult, no fee buffer)
    const tp = await this._computeTp({ buyPrice: avgBuyPrice });
    const sellPrice = tp.sellPrice;

    const sellClientOrderId = this.makeClientOrderId('sell', Date.now(), trade.retryCount || 0);
    const sellResp = await binanceRest.newOrder({
      symbol: this.bot.symbol,
      side: 'SELL',
      type: 'LIMIT_MAKER',
      quantity: totalQty.toString(),
      price: sellPrice,
      newClientOrderId: sellClientOrderId,
      recvWindow: config_recvWindow(),
    }).catch((err) => ({ error: binanceRest.formatBinanceError(err) }));

    if (sellResp.error) {
      logger.warn({
        err: sellResp.error, tradeId: trade._id.toString(),
      }, 'trader: top_up — SELL LIMIT_MAKER rejected → MARKET fallback');
      const ok = await this._emergencyMarketSell(trade, totalQty, avgBuyPrice, sellPrice,
        `top_up_market SELL rejected: ${sellResp.error.code}`);
      if (!ok) {
        await Trade.updateOne(
          { _id: trade._id, state: 'filled' },
          { state: 'holding', targetSellPrice: parseFloat(sellPrice), error: `${sellResp.error.code}: ${sellResp.error.msg}` }
        );
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'holding',
        reason: null,
        reasonDetail: null,
      });
        this.scheduleHoldingRetry(trade, totalQty, avgBuyPrice, sellPrice);
      }
      return;
    }

    await Trade.updateOne(
      { _id: trade._id, state: 'filled' },
      {
        sellOrderId: sellResp.orderId,
        sellClientOrderId,
        sellPrice: parseFloat(sellPrice),
        sellQty: totalQty,
        sellStatus: sellResp.status,
        sellPlacedAt: new Date(),
        targetSellPrice: parseFloat(sellPrice),
        state: 'selling',
      }
    );
    this.currentTrade.sellOrderId = sellResp.orderId;
    this.currentTrade.sellClientOrderId = sellClientOrderId;
    this.currentTrade.state = 'selling';
    this._registerTrade({ buyClientOrderId: trade.buyClientOrderId, sellClientOrderId });
    if (this.retryCheckTimer) {
      clearTimeout(this.retryCheckTimer);
      this.retryCheckTimer = null;
    }

    logger.info({
      botId: this.bot._id.toString(),
      tradeId: trade._id.toString(),
      buyPrice: avgBuyPrice, sellPrice, qty: totalQty,
      topUpOrderId: topUpResp.orderId,
    }, 'trader: top_up_market — SELL placed');

    await Bot.updateOne({ _id: this.bot._id }, { status: 'selling', lastError: '' });
    eventBus.emit('bot:status', { botId: this.bot._id, status: 'selling' });
    eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'selling',
        reason: null,
        reasonDetail: null,
      });
  }

  // ─── FIX-2026-07-23 #4: startup reconciliation ─────────────────────────────
  // Scan Binance balance for this bot's base asset; if found and DB has no active
  // trade that explains it → log a clear orphan warning. Caller decides whether
  // to create a recovery trade. Throttled to once per 5 minutes per bot.
  // FIX-2026-08-02: DCA mode startup reconciliation
  //   - load active DCA stack (state in OPEN_STACK_STATES) → set this.currentTrade + register
  //   - verify Binance SELL order:
  //     * FILLED → handleSellFilled (จะ route ไป _handleDcaSellFilled)
  //     * PARTIALLY_FILLED → handleSellPartialFill (keep SELL live, schedule watch)
  //     * CANCELED / EXPIRED → transition to 'holding' + scheduleHoldingRetry
  //     * NEW / ACCEPTED → leave alone (state stays selling)
  //   - ถ้า state='placed' (BUY in flight) → verify BUY order
  //   - ถ้า BUY FILLED but stack still in 'placed' → trigger handleBuyFilled
  async _reconcileDcaStackOnStart() {
    if (!this.running) return;
    const stack = await Trade.findOne({
      botId: this.bot._id,
      isDcaStack: true,
      state: { $in: ['placed', 'partial_wait', 'filled', 'retrying', 'holding', 'selling', 'partial_sell_wait', 'stopping'] },
    }).sort({ createdAt: -1 });

    if (!stack) {
      logger.info({ botId: this.bot._id.toString() }, 'trader: _reconcileDcaStackOnStart — no active DCA stack');
      return;
    }

    logger.info({
      botId: this.bot._id.toString(),
      symbol: this.bot.symbol,
      stackId: stack.stackId?.toString() || stack._id.toString(),
      state: stack.state,
      dcaLayerCount: stack.dcaLayerCount,
      stackBep: stack.stackBep,
      sellOrderId: stack.sellOrderId,
    }, 'trader: _reconcileDcaStackOnStart — found active DCA stack');

    // Set this.currentTrade + register for order routing
    this.currentTrade = stack;
    this._registerTrade(stack);

    // If BUY in flight (state='placed'), verify BUY order
    if (stack.state === 'placed' && stack.buyOrderId) {
      try {
        const buyOrder = await binanceRest.getOrder({ symbol: this.bot.symbol, orderId: stack.buyOrderId });
        if (buyOrder.status === 'FILLED') {
          const sig = stack.signalId ? await Signal.findById(stack.signalId).catch(() => null) : null;
          await this.handleBuyFilled(stack, buyOrder, sig);
          return;
        }
        if (buyOrder.status === 'PARTIALLY_FILLED') {
          // FIX-2026-08-03 (B2): do NOT call handlePartialBuyFill for DCA stacks
          //   - classic handler would place single-layer SELL with single-layer TP
          //   - for DCA we want to LET THE BUY ACCUMULATE (treat as partial layer fill, BUY open)
          //   - the partial-fill watcher (schedulePartialFillWatch) will poll until full fill
          //   - then a real _handleDcaBuyFilled will run with full qty + correct BEP
          //   - meanwhile, mark state='partial_wait' so the claim predicate at L2099 skips new S1s
          const symCached = symbolInfo.getCached(this.bot.symbol);
          const minNotional = symCached?.notional?.minNotional ? parseFloat(symCached.notional.minNotional.toString()) : null;
          const filledQty = parseFloat(buyOrder.executedQty) || 0;
          const avgPrice = parseFloat(buyOrder.price) || parseFloat(buyOrder.avgPrice) || 0;
          const notionalNow = filledQty * avgPrice;
          if (minNotional && notionalNow < minNotional) {
            // wait for accumulation below MIN_NOTIONAL — keep BUY open
            logger.info({
              stackId: stack._id.toString(),
              buyOrderId: stack.buyOrderId,
              filledQty, notional: notionalNow.toFixed(4), minNotional,
            }, 'trader: DCA stack BUY partial-fill below MIN_NOTIONAL — keeping BUY open, will poll');
            await Trade.updateOne(
              { _id: stack._id, state: 'placed' },
              { state: 'partial_wait', buyStatus: 'PARTIALLY_FILLED', buyFilledAt: new Date() }
            );
            this.schedulePartialFillWatch(stack);
          } else {
            // partial fill already >= MIN_NOTIONAL — close BUY at this layer, treat as partial layer
            //   - this is the borderline case where notional is enough but BUY is still PARTIALLY_FILLED
            //   - simplest path: cancel BUY order, accept the partial qty as a real layer, then go to DCA fill path
            //   - mirror scalars and place aggregate SELL at BEP+TP (using partial qty's avgPrice for BEP)
            logger.info({
              stackId: stack._id.toString(),
              buyOrderId: stack.buyOrderId,
              filledQty, avgPrice, notional: notionalNow.toFixed(4),
            }, 'trader: DCA stack BUY partial-fill >= MIN_NOTIONAL — cancel BUY, accept partial layer');
            await binanceRest.cancelOrder({ symbol: this.bot.symbol, orderId: stack.buyOrderId }).catch(() => null);
            const sig = stack.signalId ? await Signal.findById(stack.signalId).catch(() => null) : null;
            const synthOrder = {
              orderId: stack.buyOrderId,
              executedQty: buyOrder.executedQty,
              cummulativeQuoteQty: buyOrder.cummulativeQuoteQty,
              price: buyOrder.price || buyOrder.avgPrice,
              avgPrice: buyOrder.avgPrice,
              updateTime: buyOrder.updateTime,
              status: 'FILLED',
              fills: [],
            };
            await this.handleBuyFilled(stack, synthOrder, sig);
          }
          return;
        }
        // NEW/ACCEPTED — keep BUY pending
        logger.info({ stackId: stack._id.toString(), buyOrderId: stack.buyOrderId, buyStatus: buyOrder.status }, 'trader: DCA stack BUY still in flight, no action');
      } catch (err) {
        logger.warn({ err: err.message, stackId: stack._id.toString() }, 'trader: DCA stack BUY order fetch failed');
      }
      return;
    }

    // If SELL in flight (state='selling' or 'partial_sell_wait'), verify SELL order
    if ((stack.state === 'selling' || stack.state === 'partial_sell_wait') && stack.sellOrderId) {
      try {
        const sellOrder = await binanceRest.getOrder({ symbol: this.bot.symbol, orderId: stack.sellOrderId });
        if (sellOrder.status === 'FILLED') {
          logger.info({ stackId: stack._id.toString(), sellOrderId: stack.sellOrderId }, 'trader: DCA stack SELL FILLED during downtime — calling handleSellFilled');
          await this.handleSellFilled({
            orderId: stack.sellOrderId,
            status: 'FILLED',
            executedQty: parseFloat(sellOrder.executedQty),
            avgPrice: parseFloat(sellOrder.avgPrice),
            cumulativeQuoteQty: parseFloat(sellOrder.cummulativeQuoteQty),
            ts: sellOrder.updateTime,
          }, stack);
          return;
        }
        if (sellOrder.status === 'PARTIALLY_FILLED') {
          logger.info({ stackId: stack._id.toString(), sellOrderId: stack.sellOrderId, executedQty: sellOrder.executedQty }, 'trader: DCA stack SELL PARTIALLY_FILLED during downtime — calling handleSellPartialFill');
          await this.handleSellPartialFill({
            orderId: stack.sellOrderId,
            status: 'PARTIALLY_FILLED',
            executedQty: parseFloat(sellOrder.executedQty),
            avgPrice: parseFloat(sellOrder.avgPrice),
            cumulativeQuoteQty: parseFloat(sellOrder.cummulativeQuoteQty),
          }, stack);
          return;
        }
        if (sellOrder.status === 'CANCELED' || sellOrder.status === 'EXPIRED') {
          logger.warn({ stackId: stack._id.toString(), sellOrderId: stack.sellOrderId, sellStatus: sellOrder.status }, 'trader: DCA stack SELL cancelled/expired during downtime — marking holding');
          await Trade.updateOne(
            { _id: stack._id, state: stack.state },
            { state: 'holding', sellStatus: sellOrder.status, error: `SELL ${sellOrder.status.toLowerCase()} during downtime` }
          );
          await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
          eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
          eventBus.emit('trade:update', {
            tradeId: stack._id, state: 'holding', reason: null, reasonDetail: null,
          });
          this.scheduleHoldingRetry(
            stack,
            parseFloat(stack.stackTotalQty) || parseFloat(stack.buyQty) || 0,
            parseFloat(stack.stackBep) || parseFloat(stack.buyPrice) || 0,
            parseFloat(stack.targetSellPrice) || 0,
          );
          return;
        }
        // NEW/ACCEPTED — SELL still live
        logger.info({ stackId: stack._id.toString(), sellOrderId: stack.sellOrderId, sellStatus: sellOrder.status }, 'trader: DCA stack SELL still live, no action');
      } catch (err) {
        logger.warn({ err: err.message, stackId: stack._id.toString() }, 'trader: DCA stack SELL order fetch failed');
      }
      return;
    }

    // 'holding' state — schedule holding retry
    if (stack.state === 'holding') {
      logger.info({ stackId: stack._id.toString() }, 'trader: DCA stack in holding state — scheduling holding retry');
      this.scheduleHoldingRetry(
        stack,
        parseFloat(stack.stackTotalQty) || parseFloat(stack.buyQty) || 0,
        parseFloat(stack.stackBep) || parseFloat(stack.buyPrice) || 0,
        parseFloat(stack.targetSellPrice) || 0,
      );
      return;
    }

    // 'filled' state — SELL not yet placed (e.g. interrupted between BUY fill and SELL place)
    if (stack.state === 'filled') {
      logger.warn({ stackId: stack._id.toString() }, 'trader: DCA stack in filled state (SELL not placed) — placing SELL');
      // Compute TP from BEP and call _cancelAndReplaceSell (qty=stackTotalQty, newTarget=tp)
      const { totalQty, totalSpent, bep } = this._computeStackBEP(stack);
      if (bep && totalQty > 0) {
        try {
          const dcaTp = await this._computeDcaTp({ stackBep: bep, totalQty });
          await this._cancelAndReplaceSell({
            trade: stack,
            reason: 'dca_startup_reconcile',
            source: 'dca_reconcile',
            qty: totalQty,
            newTarget: dcaTp.sellPrice,
          });
        } catch (err) {
          logger.warn({ err: err.message, stackId: stack._id.toString() }, 'trader: DCA startup reconcile SELL place failed');
        }
      }
      return;
    }

    // 'stopping' state — SELL was being cancelled, SELL orphan
    if (stack.state === 'stopping') {
      logger.warn({ stackId: stack._id.toString() }, 'trader: DCA stack in stopping state during startup — checking SELL order');
      if (stack.sellOrderId) {
        try {
          const sellOrder = await binanceRest.getOrder({ symbol: this.bot.symbol, orderId: stack.sellOrderId });
          if (sellOrder.status === 'FILLED') {
            // race recovery — SELL filled during cancel
            await this.handleSellFilled({
              orderId: stack.sellOrderId,
              status: 'FILLED',
              executedQty: parseFloat(sellOrder.executedQty),
              avgPrice: parseFloat(sellOrder.avgPrice),
              cumulativeQuoteQty: parseFloat(sellOrder.cummulativeQuoteQty),
            }, stack);
            return;
          }
          if (sellOrder.status === 'CANCELED' || sellOrder.status === 'EXPIRED') {
            // SELL was cancelled — go to holding
            await Trade.updateOne(
              { _id: stack._id, state: 'stopping' },
              { state: 'holding', error: 'stopping: SELL cancelled during downtime' }
            );
            await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
            eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
            eventBus.emit('trade:update', {
              tradeId: stack._id, state: 'holding', reason: null, reasonDetail: null,
            });
            this.scheduleHoldingRetry(
              stack,
              parseFloat(stack.stackTotalQty) || parseFloat(stack.buyQty) || 0,
              parseFloat(stack.stackBep) || parseFloat(stack.buyPrice) || 0,
              parseFloat(stack.targetSellPrice) || 0,
            );
            return;
          }
        } catch (err) {
          logger.warn({ err: err.message, stackId: stack._id.toString() }, 'trader: DCA startup stopping SELL fetch failed');
        }
      }
    }
  }

  async reconcileAccountBalance({ force = false } = {}) {
    if (!this.running) return null;
    const now = Date.now();
    if (!force && now - this._lastReconcileBalanceMs < 5 * 60 * 1000) return null;
    this._lastReconcileBalanceMs = now;

    try {
      const baseAsset = this.bot.symbol.replace(/USDT$|USDC$|BUSD$/, '');
      const account = await binanceRest.getAccount();
      const bal = (account.balances || []).find((b) => b.asset === baseAsset);
      const freeQty = bal ? parseFloat(bal.free) : 0;
      const lockedQty = bal ? parseFloat(bal.locked) : 0;
      const totalQty = freeQty + lockedQty;

      // ถ้าไม่มี base asset เลย → ไม่ต้องทำอะไร
      if (totalQty <= 0) return { ok: true, reason: 'no_balance' };

      // หา active trades ของบอทนี้ (ทั้งหมด ไม่ใช่แค่ล่าสุด — FIX P1.4 multi-trade aggregation)
      const allActive = await Trade.find({
        botId: this.bot._id,
        state: { $in: ['placed', 'filled', 'holding', 'selling'] },
      }).lean();

      // ใช้ active ตัวล่าสุดสำหรับ partial-fill watch (back-compat)
      const active = allActive.length > 0
        ? allActive.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
        : null;

      // FIX P1.4: aggregate expectedFree จาก **all** filled/holding trades
      //   เดิม: ใช้แค่ trade ล่าสุด → ถ้ามี 2 filled trades (maxTrades=2) trade เก่าจะถูก mark เป็น orphan
      //   fix: รวม buyQty - sellQty ของทุก filled/holding trades
      //   หมายเหตุ: 'placed' ยังไม่ถือว่า free (อยู่ใน BUY order lock) / 'selling' ก็เช่นกัน (SELL order lock)
      let expectedFreeFromActive = 0;
      for (const t of allActive) {
        if ((t.state === 'filled' || t.state === 'holding') && t.buyQty) {
          expectedFreeFromActive += parseFloat(t.buyQty) - (parseFloat(t.sellQty) || 0);
        }
      }

      // ถ้า free qty มากกว่า 0 และไม่มี active trade → อาจเป็น orphan
      // (ถ้ามี active trade state='selling' → freeQty ควรเป็น 0 อยู่แล้ว เพราะถูก lock)
      const orphanFree = Math.max(0, freeQty - expectedFreeFromActive);

      if (orphanFree > 0.0000001 || lockedQty > 0) {
        logger.warn({
          botId: this.bot._id.toString(),
          symbol: this.bot.symbol,
          baseAsset,
          freeQty, lockedQty, totalQty,
          activeTradeId: active ? active._id.toString() : null,
          activeState: active ? active.state : null,
          activeBuyQty: active ? active.buyQty : null,
          activeCount: allActive.length,
          expectedFree: expectedFreeFromActive,
          orphanFree,
        }, 'trader: reconcileAccountBalance — unexpected base-asset balance on Binance (orphan?)');

        // ถ้ามี locked qty ใน BUY order → ตรวจ BUY order ที่ยังมีชีวิต
        if (lockedQty > 0 && active && active.buyOrderId && active.state === 'placed') {
          const liveOrder = await binanceRest.getOrder({
            symbol: this.bot.symbol,
            orderId: active.buyOrderId,
          }).catch(() => null);
          if (liveOrder) {
            logger.info({
              tradeId: active._id.toString(),
              buyOrderId: active.buyOrderId,
              liveStatus: liveOrder.status,
              executedQty: liveOrder.executedQty,
              originalQty: liveOrder.origQty,
            }, 'trader: reconcileAccountBalance — live BUY order found, syncing to watch');
            // ถ้า status เปลี่ยนจากที่ DB คิด → trigger handler
            if (liveOrder.status === 'PARTIALLY_FILLED') {
              const sig = active.signalId
                ? await Signal.findById(active.signalId).catch(() => null) : null;
              const candle = { closeTime: Date.now(), close: parseFloat(liveOrder.price) };
              await this.handlePartialBuyFill(active, liveOrder, sig, candle);
            } else if (liveOrder.status === 'FILLED') {
              const sig = active.signalId
                ? await Signal.findById(active.signalId).catch(() => null) : null;
              await this.handleBuyFilled(active, liveOrder, sig);
            }
          }
        }

        return {
          ok: true,
          reason: 'orphan_or_partial_locked',
          freeQty, lockedQty, orphanFree,
          activeTradeId: active && active._id.toString(),
          activeCount: allActive.length,
        };
      }

      // FIX-2026-07-30: SELL orphan cross-check — flag trades ที่ DB state='sold' แต่ Binance SELL order ยังไม่ FILLED
      //   (defense-in-depth สำหรับเคสที่ handleSellFilled เคยถูก trigger โดย PARTIALLY_FILLED — เช่น DEXE incident)
      //   - เช็คเฉพาะ trade ที่ยังไม่ verified (ไม่มี soldVerifiedAt) เพื่อไม่ให้ reconcile ทำงานซ้ำ
      //   - ถ้าเจอ → mark `soldVerifiedAt` + `orphanDetected:true` + `orphanReason` เพื่อ audit
      const unverifiedSold = await Trade.find({
        botId: this.bot._id,
        state: 'sold',
        sellOrderId: { $exists: true, $ne: null },
        soldVerifiedAt: { $exists: false },
      }).limit(5).lean();

      for (const st of unverifiedSold) {
        try {
          const liveSell = await binanceRest.getOrder({ symbol: this.bot.symbol, orderId: st.sellOrderId });
          if (liveSell.status !== 'FILLED') {
            logger.error({
              botId: this.bot._id.toString(),
              tradeId: st._id.toString(),
              sellOrderId: st.sellOrderId,
              liveStatus: liveSell.status,
              liveExecutedQty: liveSell.executedQty,
              liveOrigQty: liveSell.origQty,
              dbSellQty: st.sellQty,
            }, 'trader: reconcileAccountBalance — DB says sold but Binance SELL order still ' + liveSell.status);
            await Trade.updateOne(
              { _id: st._id },
              {
                $set: {
                  soldVerifiedAt: new Date(),
                  orphanDetected: true,
                  orphanReason: `SELL ${liveSell.status} (executedQty=${liveSell.executedQty}/${liveSell.origQty})`,
                },
              }
            );
            try {
              telegramNotifier.notify('sellOrphanDetected', {
                botName: this.bot.name || this.bot.symbol, symbol: this.bot.symbol, timeframe: st.timeframe,
                tradeId: st._id.toString(), orderId: st.sellOrderId,
                liveStatus: liveSell.status, executedQty: liveSell.executedQty, origQty: liveSell.origQty,
              });
            } catch (_) { /* non-fatal */ }
          } else {
            // verify OK — mark verified เพื่อไม่ต้องเช็คอีก
            await Trade.updateOne({ _id: st._id }, { $set: { soldVerifiedAt: new Date() } });
          }
        } catch (err) {
          logger.warn({
            err: err.message, tradeId: st._id.toString(),
          }, 'trader: reconcileAccountBalance — SELL order fetch failed (will retry next reconcile)');
        }
      }

      return { ok: true, reason: 'balanced', freeQty, lockedQty, expectedFree: expectedFreeFromActive };
    } catch (err) {
      logger.warn({
        botId: this.bot._id.toString(),
        symbol: this.bot.symbol,
        err: err.message,
      }, 'trader: reconcileAccountBalance error (non-fatal)');
      return { ok: false, reason: 'error', err: err.message };
    }
  }

  // ─── Order update handler (จาก User Data Stream) ─
  // FIX 3: รับ trade parameter (จาก Map/DB lookup) ไม่พึ่ง currentTrade
  // FIX 7: handle ทุก status (FILLED/PARTIALLY_FILLED/CANCELED/EXPIRED)
  async onBuyOrderUpdate(update, trade) {
    // FIX-2026-07-31 (BUG-16): running check — guard against WS events after stop()
    if (!this.running) return;
    if (!trade) return;
    if (update.status === 'FILLED') {
      logger.info({ botId: this.bot._id.toString(), orderId: update.orderId, avgPrice: update.avgPrice }, 'trader: BUY FILLED (via WS)');
      binanceRest.getOrder({
        symbol: this.bot.symbol,
        orderId: update.orderId,
      }).then(async (order) => {
        if (!order) return;
        // ดึง signal doc จาก trade
        const sig = trade.signalId ? await Signal.findById(trade.signalId).catch(() => null) : null;
        await this.handleBuyFilled(trade, order, sig);
      }).catch((err) => logger.error({ err: err.message }, 'trader: onBuyOrderUpdate getOrder failed'));
      return;
    }
    if (update.status === 'PARTIALLY_FILLED') {
      logger.info({ botId: this.bot._id.toString(), orderId: update.orderId, executedQty: update.executedQty }, 'trader: BUY PARTIALLY_FILLED (via WS)');
      binanceRest.getOrder({
        symbol: this.bot.symbol,
        orderId: update.orderId,
      }).then(async (order) => {
        if (!order) return;
        const sig = trade.signalId ? await Signal.findById(trade.signalId).catch(() => null) : null;
        // ส่ง candle หลอก ๆ (cancel ที่เหลือทำใน handlePartialBuyFill)
        const candle = { closeTime: Date.now(), close: parseFloat(update.avgPrice || order.price) };
        await this.handlePartialBuyFill(trade, order, sig, candle);
      }).catch((err) => logger.error({ err: err.message }, 'trader: onBuyOrderUpdate partial getOrder failed'));
      return;
    }
    if (update.status === 'CANCELED' || update.status === 'EXPIRED') {
      // FIX 7: handle WS cancel/expire สำหรับ BUY ที่ state='placed'
      if (trade.state === 'placed') {
        logger.info({ botId: this.bot._id.toString(), orderId: update.orderId, status: update.status }, 'trader: BUY cancelled externally');
        await Trade.updateOne(
          { _id: trade._id, state: 'placed' },
          { state: 'cancelled', buyStatus: update.status }
        );
        if (this.currentTrade && this.currentTrade._id.toString() === trade._id.toString()) {
          // FIX-2026-08-02: cancel any SELL orphaned by partial fill before resetting trade
          await this._cancelOrphanedSells(trade, { reason: 'ws_buy_cancelled', ctx: 'state=placed' });
          this._unregisterTrade(trade);
          this.currentTrade = null;
          await Bot.updateOne({ _id: this.bot._id }, { status: 'idle' });
          eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
        }
      }
    }
  }

  // FIX-2026-08-01: derive sellReason from prior state when caller didn't pre-populate
  //   - called by handleSellFilled() after successful state→'sold' atomic update
  //   - `trade` is the pre-update snapshot (its `.state` is the PRIOR state)
  //   - returns null if state can't be classified
  //   - best-effort: prefer caller pre-population (placeSellOrder / _finalizePartialSellAfterDeadline / etc.)
  _deriveSellReasonFromPriorState(trade, sellPrice) {
    const prior = trade.state;
    // stopping → race recovery / force-close path
    if (prior === 'stopping') {
      // Heuristic: if sellPrice > buyPrice and within band → tp_hit (cancelled SELL already filled at TP);
      // otherwise → stop_loss_upper_kc (MARKET filled at lower price).
      const buy = parseFloat(trade.buyPrice) || 0;
      if (buy > 0 && sellPrice >= buy) {
        return {
          reason: 'race_recovery_filled',
          detail: `close=${sellPrice} >= buyPrice=${buy} (filled at TP before SL cancel)`,
          source: 'handleSellFilled:derived',
        };
      }
      return {
        reason: 'stop_loss_upper_kc',
        detail: `close=${sellPrice} < buyPrice=${buy} (MARKET fallback after SL arm)`,
        source: 'handleSellFilled:derived',
      };
    }
    // partial_sell_wait → pre-populated by _finalizePartialSellAfterDeadline; fallback here
    if (prior === 'partial_sell_wait') {
      return {
        reason: 'partial_sell_finalized',
        detail: 'partial-sell freeze deadline finalization',
        source: 'handleSellFilled:derived',
      };
    }
    // holding → could be TP or holding-retry recovery
    if (prior === 'holding') {
      if ((trade.holdingRetryCount || 0) > 0) {
        return {
          reason: 'holding_retry_recovered',
          detail: `recovered on retry #${trade.holdingRetryCount}`,
          source: 'handleSellFilled:derived',
        };
      }
      // holding but no retries → TP filled while in holding state
      return {
        reason: 'tp_hit',
        detail: `TP filled at ${sellPrice} while state=holding`,
        source: 'handleSellFilled:derived',
      };
    }
    // selling (normal TP path)
    if (prior === 'selling') {
      const mult = parseFloat(this.bot.tpTrendMultiplier) || 1;
      const boosted = mult > 1 && this.bot.tpTrendEnabled !== false;
      return {
        reason: boosted ? 'tp_trend_boosted' : 'tp_hit',
        detail: boosted
          ? `TP filled at ${sellPrice} (tpTrendMultiplier=${mult})`
          : `TP filled at ${sellPrice}`,
        source: 'handleSellFilled:derived',
      };
    }
    return null;
  }

  async onSellOrderUpdate(update, trade) {
    // FIX-2026-07-31 (BUG-16): running check — guard against WS events after stop()
    if (!this.running) return;
    if (!trade) return;
    if (update.status === 'FILLED') {
      logger.info({ botId: this.bot._id.toString(), orderId: update.orderId, avgPrice: update.avgPrice }, 'trader: SELL FILLED (via WS)');
      // FIX 3: ส่ง trade ไปด้วยเพื่อให้ handleSellFilled ใช้ trade ที่ถูกต้อง (ไม่ใช่ currentTrade)
      await this.handleSellFilled(update, trade);
      return;
    }
    if (update.status === 'PARTIALLY_FILLED') {
      logger.info({ botId: this.bot._id.toString(), orderId: update.orderId, executedQty: update.executedQty }, 'trader: SELL PARTIALLY_FILLED (via WS)');
      // FIX-2026-07-30: เปลี่ยนจาก handleSellFilled → handleSellPartialFill
      //   ปัญหาเดิม: handleSellFilled บน PARTIALLY_FILLED → mark 'sold' ทันที
      //   → ส่วนที่เหลือ (origQty - executedQty) กลายเป็น orphan
      await this.handleSellPartialFill(update, trade);
      return;
    }
    if (update.status === 'CANCELED' || update.status === 'EXPIRED') {
      if (trade.state === 'selling') {
        logger.warn({ botId: this.bot._id.toString(), orderId: update.orderId, status: update.status }, 'trader: SELL cancelled externally');
        // ยังถือ asset → schedule holding retry แทนการทิ้ง
        await Trade.updateOne(
          { _id: trade._id, state: 'selling' },
          { state: 'holding', sellStatus: update.status, error: `SELL ${update.status.toLowerCase()}` }
        );
        await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
        eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
        eventBus.emit('trade:update', {
        tradeId: trade._id,
        state: 'holding',
        reason: null,
        reasonDetail: null,
      });
        // retry MARKET ทุก 30s
        this.scheduleHoldingRetry(trade, trade.sellQty, trade.buyPrice, trade.targetSellPrice);
      }
    }
  }

  // FIX 3: รับ trade parameter — ไม่ใช้ this.currentTrade โดยตรง (กัน stale reference)
  // FIX-2026-07-31 (BUG-16): running check
  // FIX-2026-08-02: DCA stack SELL filled handler — aggregate SELL filled at BEP+TP
  //   - mark stack as 'sold', sellReason='dca_target_hit', stackClosedAt
  //   - 1 stack = 1 bot counter entry (totalTrades, winTrades) — ไม่ใช่ 1 layer
  //   - ใช้ stackBep/stackTotalQty สำหรับ pnl
  //   - emit dcaTargetHit + tradeoff + trade:update + bot:status idle
  async _handleDcaSellFilled(update, trade) {
    try {
      const sellQty = parseFloat(update.executedQty);
      const sellPrice = parseFloat(update.avgPrice) || (parseFloat(update.cumulativeQuoteQty) / sellQty);
      const feeRate = fees.getMakerRate();
      const stackBep = parseFloat(trade.stackBep || trade.buyPrice || 0);
      const stackTotalQty = parseFloat(trade.stackTotalQty || trade.buyQty || 0);
      const pnl = fees.calcPnl({
        buyPrice: stackBep,
        sellPrice,
        qty: stackTotalQty,
        feeRate,
      });

      // Idempotent guard — state must be in 'selling'/'holding'/'stopping'/'partial_sell_wait'
      //   - ไม่ต้องเพิ่ม 'placed'/'filled' etc. (sellOrderId sell pending only)
      const upd = await Trade.updateOne(
        {
          _id: trade._id,
          state: { $in: ['selling', 'holding', 'stopping', 'partial_sell_wait'] },
        },
        {
          $set: {
            state: 'sold',
            sellStatus: 'FILLED',
            sellPrice,
            // FIX-2026-08-06: P2 — persist sellAvgPrice alias (same as handleSellFilled)
            sellAvgPrice: sellPrice,
            sellQty: stackTotalQty, // aggregate qty (sum of all layers)
            sellQuoteQty: parseFloat(update.cumulativeQuoteQty),
            sellFilledAt: new Date(update.ts || Date.now()),
            realizedPnl: pnl.net,
            pnlPercent: pnl.pnlPercent,
            stackClosedAt: new Date(),
            // FIX-2026-08-02: sellReason='dca_target_hit' (TP hit for whole stack)
            sellReason: 'dca_target_hit',
            sellReasonDetail: `Aggregate SELL filled at TP (close=${sellPrice.toFixed(6)}, stackBep=${stackBep.toFixed(6)}, layers=${trade.dcaLayerCount || (trade.buyLayers || []).length})`,
            sellReasonAt: new Date(),
            sellReasonSource: '_handleDcaSellFilled',
            // FIX-2026-07-31 (F1): reset SL-on-UKC auto-arm flag
            useStopLossOnUKC: false,
            autoArmedAt: null,
            // FIX-2026-08-03: clear F1 threshold snapshots เมื่อ trade ออกจาก selling
            autoArmLossPct: null,
            autoArmAgeHours: null,
            // FIX-2026-08-01: reset SELL partial-fill latch
            sellPartialDetectedAt: null,
            sellPartialLatchedAt: null,
            sellPartialLatchedReason: null,
          },
        }
      );

      // FIX-2026-08-06: P4 — slippage detection (DCA stack — target = stackBep-based targetSellPrice)
      //   - stackTargetSellPrice persist ใน _handleDcaBuyFilled / _handleDcaLayerAdded
      //   - ถ้าไม่มี → fall back ไป trade.targetSellPrice
      const dcaSlipTarget = parseFloat(trade.stackTargetSellPrice || trade.targetSellPrice) || 0;
      if (dcaSlipTarget > 0) {
        this._computeSlippage({
          sellPrice,
          targetSellPrice: dcaSlipTarget,
          tradeId: trade._id,
          sellReason: 'dca_target_hit',
          pnlPercent: pnl.pnlPercent,
        });
      }
      if (upd.modifiedCount === 0) {
        logger.debug({ tradeId: trade._id.toString() }, 'trader: _handleDcaSellFilled skipped — already sold');
        return;
      }

      // FIX-2026-08-02: 1 stack = 1 bot counter entry (NOT 1 per layer)
      await Bot.updateOne(
        { _id: this.bot._id },
        {
          $inc: {
            totalPnl: pnl.net,
            totalTrades: 1,
            winTrades: (pnl.net > 0 ? 1 : 0),
          },
          $set: {
            status: 'idle',
            lastError: '',
            warning: '',
          },
        }
      );

      this._unregisterTrade(trade);
      if (this.currentTrade && this.currentTrade._id.toString() === trade._id.toString()) {
        this.currentTrade = null;
      }

      const stackId = trade.stackId || trade._id;
      const layerCount = trade.dcaLayerCount || (trade.buyLayers || []).length;
      eventBus.emit('dcaTargetHit', {
        botId: this.bot._id,
        symbol: this.bot.symbol,
        stackId,
        layerCount,
        stackBep,
        stackTotalQty,
        stackTotalSpent: trade.stackTotalSpent || 0,
        sellPrice,
        sellQty: stackTotalQty,
        realizedPnl: pnl.net,
        pnlPercent: pnl.pnlPercent,
        sellOrderId: update.orderId,
      });
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
      eventBus.emit('trade:update', {
        tradeId: trade._id,
        botId: this.bot._id,
        state: 'sold',
        reason: 'dca_target_hit',
        reasonDetail: `Stack closed: ${layerCount} layers, BEP=${stackBep.toFixed(6)}, sold=${sellPrice.toFixed(6)}, PnL=${pnl.net.toFixed(4)} (${pnl.pnlPercent.toFixed(2)}%)`,
        stackId,
        dcaLayerCount: layerCount,
        stackBep,
        stackTotalQty,
        realizedPnl: pnl.net,
        pnlPercent: pnl.pnlPercent,
      });
      logger.info({
        botId: this.bot._id.toString(),
        stackId: stackId.toString(),
        layerCount,
        stackBep, sellPrice,
        pnl: pnl.net,
        pnlPercent: pnl.pnlPercent.toFixed(4),
      }, 'trader: DCA stack SELL filled — stack closed');
    } catch (err) {
      logger.error({ err: err.message }, 'trader: _handleDcaSellFilled error');
    }
  }

  async handleSellFilled(update, tradeParam) {
    if (!this.running) return;
    // FIX-2026-08-02: DCA stack handleSellFilled — SELL aggregate SELL filled at BEP+TP
    //   - mark stack as 'sold', sellReason='dca_target_hit', stackClosedAt
    //   - 1 stack = 1 bot counter entry (totalTrades, winTrades)
    //   - ใช้ stackBep/stackTotalQty สำหรับ pnl
    //   - emit dcaTargetHit event + extra trade:update payload fields
    if (tradeParam && tradeParam.isDcaStack) {
      return await this._handleDcaSellFilled(update, tradeParam);
    }
    try {
      let trade = tradeParam || this.currentTrade;
      if (!trade) {
        logger.warn({ update }, 'trader: handleSellFilled called without trade context');
        return;
      }
      // FIX-2026-07-13: ถ้า trade ไม่มี buyPrice (เคยเกิดจาก _registerTrade minimal)
      // → re-fetch จาก DB เพื่อให้ pnl.net valid (กัน 'Cast to Number failed for NaN at realizedPnl')
      if (trade.buyPrice == null || trade.buyPrice === undefined) {
        try {
          const fresh = await Trade.findById(trade._id).lean();
          if (fresh && fresh.buyPrice != null) {
            logger.warn({
              tradeId: trade._id.toString(),
              orderId: update.orderId,
            }, 'trader: handleSellFilled — trade snapshot missing buyPrice, re-fetched from DB');
            trade = fresh;
          }
        } catch (err) {
          logger.error({ err: err.message }, 'trader: handleSellFilled DB re-fetch failed');
          return;
        }
        if (trade.buyPrice == null || trade.buyPrice === undefined) {
          logger.error({
            tradeId: trade._id.toString(),
            orderId: update.orderId,
          }, 'trader: handleSellFilled ABORT — buyPrice still missing after DB re-fetch');
          return;
        }
      }
      const sellQty = parseFloat(update.executedQty);
      const sellPrice = parseFloat(update.avgPrice) || (parseFloat(update.cumulativeQuoteQty) / sellQty);
      const feeRate = fees.getMakerRate();
      const pnl = fees.calcPnl({
        buyPrice: trade.buyPrice,
        sellPrice,
        qty: sellQty,
        feeRate,
      });

      // Idempotent guard: กัน double-update ถ้า WS มาซ้ำ
      // FIX-2026-07-23b: เพิ่ม 'stopping' เพื่อให้ stop-loss flow ที่ atomic claim ไปแล้ว
      //   แต่ Binance ยังส่ง WS SELL FILLED หลัง cancel (-2011) → handler นี้ต้อง update DB
      //   - ถ้า handleSellFilled ไม่ match guard → trade ค้างใน 'stopping' + _emergencyMarketSell จะทำ MARKET ซ้ำ
      //   - ถ้า handleSellFilled match → 'stopping' → 'sold' ด้วยราคาจริงของ LIMIT_MAKER fill (ถูกต้อง)
      //   - atomic guard กัน _emergencyMarketSell race: ใคร update 'sold' ก่อนชนะ
      // FIX-2026-07-31: เพิ่ม 'partial_sell_wait' (BUG-2) — `_finalizePartialSellAfterDeadline` claims
      //   `selling → partial_sell_wait` (atomic guard at L3579), then post-cancel fully-filled branch
      //   (L3622/3654) calls `handleSellFilled` — without 'partial_sell_wait' in this guard set, the
      //   modifiedCount=0 → trade stuck in 'partial_sell_wait' forever, no Bot $inc, no 'idle' status.
      // FIX-2026-08-06: เพิ่ม 'cancelled' (BUG-BICO) — pattern: partial-fill BUY → leftover unfilled
      //   portion auto-CANCELED → trade auto-marked 'cancelled' by reconcile sweep (line ~392)
      //   → SELL for the filled portion already placed (state='selling' at that moment)
      //   → SELL fills on Binance but trade.state is 'cancelled' → handleSellFilled bails (modifiedCount=0)
      //   → trade stuck 'cancelled' with FILLED SELL forever, reconcile ORPHAN loop every 5min
      //   incident: BICO 6a73e01514eb21f18b0441d6 08:15 BUY partial 312.52/333.2 → cancel 20.68 → reconcile mark cancelled 08:16:57 → SELL fill 08:20:26 → bailed → 15+ orphan detects
      const upd = await Trade.updateOne(
        {
          _id: trade._id,
          state: { $in: ['selling', 'holding', 'stopping', 'partial_sell_wait', 'cancelled'] },
          // FIX-2026-08-06: extra safety for 'cancelled' state — must have an active sellOrderId
          //   and that sellOrderId must match the one being filled (either from WS event or from
          //   the trade snapshot passed by reconcile orphan path).
          ...(trade.state === 'cancelled'
            ? { sellOrderId: update.orderId || trade.sellOrderId }
            : {}),
        },
        {
          state: 'sold',
          sellStatus: 'FILLED',
          sellPrice,
          // FIX-2026-08-06: P2 — persist sellAvgPrice alias เพื่อ query ง่าย
          //   - เดิม handleSellFilled ตั้งแค่ sellPrice (actual fill)
          //   - handleSellPartialFill ตั้ง sellAvgPrice เท่านั้น
          //   - query slippage ต้องใช้ 2 field → สับสน
          //   - fix: handleSellFilled ก็ตั้ง sellAvgPrice = sellPrice (single source of truth สำหรับ fully-filled)
          sellAvgPrice: sellPrice,
          sellQty,
          sellQuoteQty: parseFloat(update.cumulativeQuoteQty),
          sellFilledAt: new Date(update.ts || Date.now()),
          realizedPnl: pnl.net,
          pnlPercent: pnl.pnlPercent,
          // FIX-2026-07-31 (F1): reset SL-on-UKC auto-arm flag
          useStopLossOnUKC: false,
          autoArmedAt: null,
          // FIX-2026-08-03: clear F1 threshold snapshots เมื่อ trade ออกจาก selling
          autoArmLossPct: null,
          autoArmAgeHours: null,
          // FIX-2026-08-01: reset SELL partial-fill latch
          sellPartialDetectedAt: null,
          sellPartialLatchedAt: null,
          sellPartialLatchedReason: null,
        }
      );
      if (upd.modifiedCount === 0) {
        logger.debug({ tradeId: trade._id.toString() }, 'trader: handleSellFilled skipped — already sold');
        return;
      }

      // FIX-2026-08-06: P4 — slippage detection (warn -1%, alert telegram -3%)
      //   - targetSellPrice จาก trade snapshot (persist ตอน BUY fill)
      //   - sellPrice = actual fill จาก Binance
      //   - ถ้า sellReason pre-populated แล้ว (เช่น race_recovery_filled) → ใช้ค่านั้น, ไม่งั้น derive หลัง
      const slipCtx = {
        sellPrice,
        targetSellPrice: parseFloat(trade.targetSellPrice) || 0,
        tradeId: trade._id,
        sellReason: trade.sellReason || (this._deriveSellReasonFromPriorState(trade, sellPrice) || {}).reason || null,
        pnlPercent: pnl.pnlPercent,
      };
      this._computeSlippage(slipCtx);

      // FIX-2026-08-01: derive sellReason if caller didn't pre-populate (TP path = placeSellOrder)
      //   - prior state is `trade.state` snapshot BEFORE the atomic update above
      //   - idempotent guard `{sellReason: null}` กัน race กับ placeSellOrder pre-population
      if (!trade.sellReason) {
        const derived = this._deriveSellReasonFromPriorState(trade, sellPrice);
        if (derived) {
          await Trade.updateOne(
            { _id: trade._id, sellReason: null },
            { $set: {
              sellReason: derived.reason,
              sellReasonDetail: derived.detail,
              sellReasonAt: new Date(),
              sellReasonSource: derived.source,
            } }
          );
          trade.sellReason = derived.reason;
          trade.sellReasonDetail = derived.detail;
        }
      }

      // update bot stats — ใช้ $inc (atomic) แทน read-modify-write เพื่อกัน
      // lost update เวลา trader instance ถือ snapshot เก่า (เคยทำให้
      // totalTrades ตกหล่นเมื่อ 2 trade ปิดใกล้กัน หรือระหว่าง restart)
      await Bot.updateOne(
        { _id: this.bot._id },
        {
          $inc: {
            totalPnl: pnl.net,
            totalTrades: 1,
            winTrades: (pnl.net > 0 ? 1 : 0),
          },
          $set: {
            status: 'idle',
            lastError: '',
            // FIX-2026-08-01: reset warning เมื่อ SELL fill สำเร็จ (latch cleared)
            warning: '',
          },
        }
      );

      // FIX-2026-08-08: Feature #1 — Dynamic Position Sizing evaluation
      //   - evaluate after every closed position (BUY→SELL)
      //   - skip if disabled / DCA mode / martingale / cooldown / master-off
      //   - apply dynamicSizeCurrent + dynamicLayersCurrent to bot
      //   - persisted via dps.persistEval (separate updateOne — non-blocking)
      // FIX-2026-08-08: master switch — read AppConfig.masterDynamicSizeEnabled (30s cache)
      //   - if master off → stamp _masterDynamicSizeEnabled=false on snapshot → dps.evaluate() returns 'master-off'
      // FIX-2026-08-08 (rev2): ย้าย getMasterToggles() เข้ามาใน try — DPS ต้องไม่มีทางกระทบ SELL flow
      // FIX-2026-08-09: refactor → use dpsAfterClose.evaluateDpsAfterClose() helper
      //   - single source of truth across handleSellFilled / _emergencyMarketSell / forceClose / botManager
      //   - helper handles deps reload, master toggle, persistState, log + telegram
      //   - caller syncs in-memory snapshot from evalResult so next BUY uses fresh size
      try {
        const dpsAfterClose = require('./dpsAfterClose');
        const evalResult = await dpsAfterClose.evaluateDpsAfterClose({
          bot: this.bot,
          pnl: pnl.net,
          pnlPct: pnl.pnlPercent,
          source: 'trader:handleSellFilled',
        });
        // refresh in-memory snapshot so next eval/BUY เห็นค่าล่าสุด
        if (evalResult) {
          if (Array.isArray(evalResult.newHistory)) {
            this.bot.dynamicSizeLastResults = evalResult.newHistory;
            this.bot.dynamicSizeLastEvaluatedAt = evalResult.appliedAt;
          }
          if (evalResult.changed) {
            this.bot.dynamicSizeCurrent = evalResult.after.size;
            this.bot.dynamicLayersCurrent = evalResult.after.layers;
            this.bot.dynamicSizeCooldownUntil = evalResult.cooldownUntil;
          }
          if (evalResult.skipped) {
            logger.debug({
              botId: this.bot._id.toString(),
              skipped: evalResult.skipped,
              reason: evalResult.reason,
            }, 'trader: DPS — skipped');
          }
        }
      } catch (dpsErr) {
        logger.warn({ err: dpsErr.message, botId: this.bot._id.toString() }, 'trader: DPS evaluation failed (non-fatal)');
      }

      // FIX-2026-08-08: Feature #3 — Auto Unlock Cooldown (CBv2/CBv3)
      //   - BUG-FIX: removed from handleSellFilled (deadlock — cooldown suppresses BUYs → no SELL → never evaluated)
      //   - moved to _cbAutoUnlockKlineHandler (fires every candle close while cooldown active)
      //   - see _evaluateAutoUnlockOnCandle() below

      this._unregisterTrade(trade);
      if (this.currentTrade && this.currentTrade._id.toString() === trade._id.toString()) {
        this.currentTrade = null;
      }
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'idle' });
      // FIX-2026-08-01: include reason + reasonDetail so dashboardWs/telegramNotifier pick it up
      eventBus.emit('trade:update', {
        tradeId: trade._id,
        botId: this.bot._id,
        state: 'sold',
        reason: trade.sellReason || null,
        reasonDetail: trade.sellReasonDetail || null,
      });
      logger.info({
        botId: this.bot._id.toString(),
        pnl: pnl.net,
        pnlPercent: pnl.pnlPercent.toFixed(4),
      }, 'trader: SELL FILLED, round complete');
    } catch (err) {
      logger.error({ err: err.message }, 'trader: handleSellFilled error');
    }
  }

  // FIX-2026-07-30: SELL PARTIALLY_FILLED handler — แยกจาก handleSellFilled ที่ mark 'sold' ทันที
  //   ปัญหาเดิม (DEXE incident): handleSellFilled บน PARTIALLY_FILLED → mark 'sold' → ส่วนที่เหลือเป็น orphan
  //   fix: คง state='selling', อัปเดต sellFilledQty, schedule deadline finalizer
  async handleSellPartialFill(update, trade) {
    // FIX-2026-07-31 (BUG-16): running check — guard against WS events after stop()
    if (!this.running) return;
    // FIX-2026-08-02: DCA stack partial-fill — FREEZE policy preserved
    //   - ไม่ cancel, ไม่ MARKET replace, ไม่ add layer ใหม่
    //   - keep SELL live waiting for natural fill (same as non-DCA path)
    //   - existing _finalizePartialSellAfterDeadline จะใช้ trade.buyPrice (=stackBep) และ trade.buyQty (=stackTotalQty)
    //     จาก mirror ใน _handleDcaBuyFilled → PnL calculation ถูกต้องอัตโนมัติ
    if (trade && trade.isDcaStack) {
      logger.info({
        botId: this.bot._id.toString(),
        tradeId: trade._id?.toString(),
        stackId: trade.stackId?.toString(),
        sellOrderId: trade.sellOrderId,
        symbol: this.bot.symbol,
      }, 'trader: DCA stack SELL partial-fill — FREEZE policy (no cancel, no replace)');
    }
    try {
      if (!trade) return;
      if (!trade.sellOrderId) {
        logger.warn({ tradeId: trade._id && trade._id.toString() }, 'trader: handleSellPartialFill — missing sellOrderId, skip');
        return;
      }
      // Re-fetch fresh order เพื่อ catch late partial fills
      let fresh;
      try {
        fresh = await binanceRest.getOrder({ symbol: this.bot.symbol, orderId: trade.sellOrderId });
      } catch (err) {
        logger.warn({ err: err.message, tradeId: trade._id.toString() }, 'trader: handleSellPartialFill — getOrder failed, using update snapshot');
        fresh = update;
      }
      const executedQty = parseFloat(fresh.executedQty);
      const remainingQty = Math.max(0, parseFloat(fresh.origQty) - executedQty);
      const avgPrice = parseFloat(fresh.avgPrice) || (parseFloat(fresh.cummulativeQuoteQty) / Math.max(executedQty, 1e-12));
      const cumQuote = parseFloat(fresh.cummulativeQuoteQty);

      if (executedQty <= 0) {
        logger.warn({ tradeId: trade._id.toString(), executedQty }, 'trader: handleSellPartialFill — zero executedQty, skip');
        return;
      }

      // Atomic update — เฉพาะ state='selling' กัน race กับ handleSellFilled
      // FIX-2026-08-01: ตั้ง sellPartialDetectedAt เฉพาะครั้งแรก (idempotent — $setOnInsert-like pattern)
      //   - $set จะ overwrite ทุกครั้ง → ใช้ aggregation pipeline + $cond เพื่อ set เฉพาะตอน null
      //   - ถ้า detectedAt เดิม != null → keep เดิม (latch age ไม่ reset ทุก partial fill)
      const upd = await Trade.updateOne(
        { _id: trade._id, state: 'selling' },
        [
          {
            $set: {
              sellStatus: 'PARTIALLY_FILLED',
              sellFilledQty: executedQty,
              sellFilledAt: new Date(),
              sellAvgPrice: avgPrice,
              sellCumulativeQuoteQty: cumQuote,
              sellPartialDetectedAt: {
                $ifNull: ['$sellPartialDetectedAt', new Date()],
              },
              // อย่าเปลี่ยน sellQty — total order qty เดิม
            },
          },
        ]
      );
      if (upd.modifiedCount === 0) {
        logger.info({ tradeId: trade._id.toString(), currentState: trade.state }, 'trader: handleSellPartialFill — trade not in selling state, skip');
        return;
      }

      logger.warn({
        botId: this.bot._id.toString(),
        tradeId: trade._id.toString(),
        symbol: this.bot.symbol,
        orderId: trade.sellOrderId,
        executedQty, remainingQty, avgPrice,
      }, 'trader: SELL PARTIALLY_FILLED — keeping state selling, scheduling deadline watch');

      // Telegram alert
      try {
        telegramNotifier.notify('sellPartialFill', {
          botName: this.bot.name || this.bot.symbol,
          symbol: this.bot.symbol,
          timeframe: trade.timeframe,
          tradeId: trade._id.toString(),
          orderId: trade.sellOrderId,
          sellQty: trade.sellQty,
          executedQty, remainingQty, avgPrice,
        });
      } catch (_) { /* non-fatal */ }

      this.scheduleSellPartialFillWatch(trade);
    } catch (err) {
      logger.error({ err: err.message, tradeId: trade && trade._id && trade._id.toString() }, 'trader: handleSellPartialFill error');
    }
  }

  // FIX-2026-07-30: schedule SELL partial-fill watcher — mirror schedulePartialFillWatch (BUY side)
  //   poll สถานะ SELL order ทุก 30s; เมื่อครบ deadline → _finalizePartialSellAfterDeadline
  //   deadline = sellPlacedAt + 2 × retryTimeMin × retryMax (นาที) — 2× window เพราะ TP ใกล้ market กว่า BUY fill
  scheduleSellPartialFillWatch(trade) {
    if (!this.running || !trade || !trade._id) return;
    const tradeIdStr = trade._id.toString();
    const retryMax = this.bot.retryMax ?? 1;
    const retryTimeMin = this.bot.retryTimeMin ?? 1;
    const placedAtMs = trade.sellPlacedAt ? new Date(trade.sellPlacedAt).getTime() : Date.now();
    const deadlineMs = placedAtMs + 2 * retryTimeMin * retryMax * 60 * 1000;

    // FIX-2026-07-31 (BUG-11): always clear previous timer — previous conditional check
    //   (`&& _sellPartialFillTradeId === tradeIdStr`) left handles orphaned when a different
    //   trade scheduled its own watch. Always clearTimeout to prevent leaked polls + clobbered deadline.
    if (this.sellPartialFillTimer) {
      clearTimeout(this.sellPartialFillTimer);
      this.sellPartialFillTimer = null;
    }
    this.sellPartialFillDeadlineAt = deadlineMs;
    this._sellPartialFillTradeId = tradeIdStr;

    // Persist deadline ใน DB (mirror partialFillDeadlineAt pattern)
    Trade.updateOne(
      { _id: trade._id },
      { $set: { sellPartialDeadlineAt: new Date(deadlineMs) } }
    ).catch((err) => logger.warn({ err: err.message, tradeId: tradeIdStr }, 'trader: persist sellPartialDeadline failed'));

    logger.info({
      botId: this.bot._id.toString(),
      tradeId: tradeIdStr,
      placedAtMs, deadlineMs,
      retryTimeMin, retryMax,
      deadlineAt: new Date(deadlineMs).toISOString(),
    }, 'trader: SELL partial-fill watch scheduled with deadline');

    this.sellPartialFillTimer = setTimeout(async () => {
      try {
        await this.checkSellPartialFill(tradeIdStr);
      } catch (err) {
        logger.error({ err: err.message, tradeId: tradeIdStr }, 'trader: checkSellPartialFill crashed');
      }
    }, 30 * 1000);
  }

  // FIX-2026-07-30: poll SELL order status — mirror checkPartialFill (BUY side)
  async checkSellPartialFill(tradeIdStr) {
    const fresh = await Trade.findById(tradeIdStr);
    if (!fresh) return;
    if (this.bot._id.toString() !== fresh.botId.toString()) return;

    // ถ้า state เปลี่ยนแล้ว → หยุด watch
    if (fresh.state !== 'selling' || fresh.sellStatus !== 'PARTIALLY_FILLED') {
      logger.debug({
        tradeId: tradeIdStr, currentState: fresh.state, currentSellStatus: fresh.sellStatus,
      }, 'trader: SELL partial-fill watch — trade no longer in selling/partial state, stop');
      return;
    }

    // Restore deadline from DB after restart
    if (!this.sellPartialFillDeadlineAt && fresh.sellPartialDeadlineAt) {
      this.sellPartialFillDeadlineAt = new Date(fresh.sellPartialDeadlineAt).getTime();
      logger.info({ tradeId: tradeIdStr, restoredDeadlineMs: this.sellPartialFillDeadlineAt }, 'trader: SELL partial-fill — restored deadline from DB after restart');
    }

    let order;
    try {
      order = await binanceRest.getOrder({ symbol: this.bot.symbol, orderId: fresh.sellOrderId });
    } catch (err) {
      logger.warn({ err: err.message, tradeId: tradeIdStr }, 'trader: checkSellPartialFill — getOrder failed, reschedule');
      this.scheduleSellPartialFillWatch(fresh);
      return;
    }

    // FILLED → terminal path เดิม
    if (order.status === 'FILLED') {
      logger.info({ tradeId: tradeIdStr, orderId: fresh.sellOrderId }, 'trader: checkSellPartialFill — SELL now FILLED, calling handleSellFilled');
      await this.handleSellFilled({
        status: 'FILLED',
        orderId: fresh.sellOrderId,
        executedQty: parseFloat(order.executedQty),
        avgPrice: parseFloat(order.avgPrice),
        cumulativeQuoteQty: parseFloat(order.cummulativeQuoteQty),
      }, fresh);
      return;
    }

    // CANCELLED/EXPIRED → holding + scheduleHoldingRetry (mirror line 3179-3193)
    if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
      logger.warn({ tradeId: tradeIdStr, orderId: fresh.sellOrderId, status: order.status }, 'trader: checkSellPartialFill — SELL cancelled externally, transitioning to holding');
      await Trade.updateOne(
        { _id: fresh._id, state: 'selling' },
        { state: 'holding', sellStatus: order.status, error: `SELL ${order.status.toLowerCase()} (was partial)` }
      );
      await Bot.updateOne({ _id: this.bot._id }, { status: 'holding' });
      eventBus.emit('bot:status', { botId: this.bot._id, status: 'holding' });
      eventBus.emit('trade:update', {
        tradeId: fresh._id,
        state: 'holding',
        reason: null,
        reasonDetail: null,
      });
      this.scheduleHoldingRetry(fresh, parseFloat(fresh.sellQty), fresh.buyPrice, fresh.targetSellPrice);
      return;
    }

    // ยัง PARTIALLY_FILLED หรือ NEW
    const now = Date.now();
    const deadlinePassed = this.sellPartialFillDeadlineAt && now >= this.sellPartialFillDeadlineAt;

    // FIX-2026-08-01: 1h latched alert — ถ้า partial-fill ยังไม่คืบหน้าเกิน 1h → emit warning + telegram
    //   - เรียกก่อน deadline check (กรณี freeze policy: deadline = 24h, 1h alert ยังควรยิง)
    //   - sellPartialDetectedAt ตั้งตอน partial-fill ครั้งแรก (handleSellPartialFill) — ไม่ reset
    //   - sellPartialLatchedAt = latch ตัวล่าสุด (idempotent — กัน re-emit ทุก 30s poll)
    await this._checkPartialFillLatchedAlert(fresh, order);

    if (deadlinePassed) {
      logger.warn({ tradeId: tradeIdStr, orderId: fresh.sellOrderId, status: order.status }, 'trader: checkSellPartialFill — deadline passed, finalizing');
      await this._finalizePartialSellAfterDeadline(fresh, order);
      return;
    }

    // ยังไม่ครบ deadline → reschedule
    this.scheduleSellPartialFillWatch(fresh);
  }

  // FIX-2026-08-01: 1h latched alert for SELL partial-fill
  //   - ถ้า sellPartialDetectedAt + 1h <= now AND sellPartialLatchedAt == null
  //     → emit warning + telegram + set latched timestamp
  //   - กัน re-emit ด้วย sellPartialLatchedAt (idempotent)
  //   - reset sellPartialLatchedAt เมื่อ state ออกจาก 'selling' (ใน state-transition handlers)
  //   - แจ้งผ่าน 3 channels:
  //     1. Telegram (sellPartialLatched event)
  //     2. Bot.warning field (UI badge)
  //     3. trade:warning event (UI bots / positions table)
  async _checkPartialFillLatchedAlert(trade, order) {
    if (!trade || !trade.sellPartialDetectedAt) return;
    if (trade.sellPartialLatchedAt) return; // already latched
    if (trade.state !== 'selling') return;

    const detectedAt = new Date(trade.sellPartialDetectedAt).getTime();
    const elapsedMs = Date.now() - detectedAt;
    const LATCH_MS = 60 * 60 * 1000; // 1 hour
    if (elapsedMs < LATCH_MS) return;

    const executedSoFar = parseFloat(order.executedQty || 0);
    const remainingQty = Math.max(0, parseFloat(order.origQty || 0) - executedSoFar);
    const avgPrice = parseFloat(order.avgPrice) || (parseFloat(order.cummulativeQuoteQty) / Math.max(executedSoFar, 1e-12));

    // Determine reason: 'no_progress' if remainingQty ยังเท่าเดิม, 'remaining_unchanged' otherwise
    const reason = trade.sellFilledQty && Math.abs(parseFloat(trade.sellFilledQty) - executedSoFar) < 1e-9
      ? 'no_progress'
      : 'remaining_unchanged';

    logger.warn({
      botId: this.bot._id.toString(),
      tradeId: trade._id.toString(),
      symbol: this.bot.symbol,
      orderId: trade.sellOrderId,
      detectedAt: trade.sellPartialDetectedAt,
      elapsedMs,
      elapsedMin: Math.round(elapsedMs / 60000),
      executedSoFar, remainingQty, avgPrice,
      reason,
    }, 'trader: SELL partial-fill LATCHED — 1h no progress, emitting alert');

    // Atomic update — กัน race (poll concurrent call) ตั้ง sellPartialLatchedAt
    const claim = await Trade.updateOne(
      { _id: trade._id, state: 'selling', sellPartialLatchedAt: null },
      {
        $set: {
          sellPartialLatchedAt: new Date(),
          sellPartialLatchedReason: reason,
        },
      }
    );
    if (claim.modifiedCount === 0) {
      // race lost — concurrent poll already latched
      return;
    }

    // 1) Telegram (sellPartialLatched event)
    try {
      await telegramNotifier.notify('sellPartialLatched', {
        botName: this.bot.name || this.bot.symbol,
        symbol: this.bot.symbol,
        timeframe: this.bot.timeframe,
        tradeId: trade._id.toString(),
        orderId: trade.sellOrderId,
        sellQty: trade.sellQty,
        executedSoFar, remainingQty, avgPrice,
        elapsedMs,
        elapsedMin: Math.round(elapsedMs / 60000),
        reason,
        note: 'SELL partial-fill ไม่คืบหน้าเกิน 1h — ตรวจสอบ position + พิจารณา manual cancel/new SELL',
      }).catch((err) => logger.warn({ err: err.message }, 'trader: sellPartialLatched telegram notify failed'));
    } catch (_) { /* non-fatal */ }

    // 2) Bot.warning field (UI badge)
    try {
      const warningMsg = `⚠️ SELL partial-fill ${Math.round(elapsedMs / 60000)}min no progress — remaining ${remainingQty} @ ${avgPrice}`;
      await Bot.updateOne(
        { _id: this.bot._id },
        {
          $set: {
            warning: warningMsg,
            warningAt: new Date(),
          },
        }
      );
    } catch (err) {
      logger.warn({ err: err.message }, 'trader: sellPartialLatched — bot.warning persist failed');
    }

    // 3) trade:warning event (UI positions table — symmetric กับ bot:status)
    try {
      eventBus.emit('trade:warning', {
        tradeId: trade._id,
        botId: this.bot._id,
        kind: 'sellPartialLatched',
        message: `SELL partial-fill ${Math.round(elapsedMs / 60000)}min no progress`,
        remainingQty,
        avgPrice,
        elapsedMs,
        reason,
      });
    } catch (_) { /* non-fatal */ }
  }

    // FIX-2026-07-30: SELL partial-finalize — atomic claim state='selling' → 'partial_sell_wait'
  // FIX-2026-08-01 (SELL partial-fill FREEZE policy):
  //   ❌ เดิม: cancel SELL + MARKET SELL ที่เหลือ (อาจติด MIN_LOT precision = -1111 ทำให้ stuck)
  //   ✅ ใหม่: คง SELL order ไว้แบบ LIVE รอจนกว่าจะ fill ที่เหลือเอง
  //   - เหตุผล: ถ้า remainingQty < MIN_LOT (Binance precision) → MARKET SELL fail → holding retry loop ไม่จบ
  //             และ position บน Binance ≠ DB state (ทำให้ reconcileAccountBalance log spam)
  //   - เปลี่ยน behavior: keep state='selling' + keep SELL order LIVE + extend watch indefinitely
  //   - เมื่อ SELL fill ที่เหลือเอง (Binance FILLED event) → handleSellFilled ทำงานปกติ
  //   - ถ้า SELL cancel/expire externally → handleSellFilled → state='holding' → holding retry
  //   - ส่ง telegram แจ้ง user ว่า "freeze" ไว้แล้ว (ไม่ใช่ action อัตโนมัติ)
  async _finalizePartialSellAfterDeadline(trade, order) {
    // FIX-2026-08-01: ยกเลิก atomic claim 'partial_sell_wait' — ไม่ต้องเปลี่ยน state
    //   ก่อนหน้านี้: state='selling' → 'partial_sell_wait' (ก่อน cancel)
    //   ตอนนี้: state='selling' ต่อ + SELL order LIVE ต่อ
    //
    // เช็คก่อนว่า tradeยังอยู่ใน state='selling' + sellStatus='PARTIALLY_FILLED' หรือไม่
    const fresh = await Trade.findById(trade._id).lean();
    if (!fresh) {
      logger.warn({ tradeId: trade._id.toString() }, 'trader: SELL partial-finalize — trade not found, abort');
      return;
    }
    if (fresh.state !== 'selling' || fresh.sellStatus !== 'PARTIALLY_FILLED') {
      logger.info({
        tradeId: trade._id.toString(),
        currentState: fresh.state,
        currentSellStatus: fresh.sellStatus,
      }, 'trader: SELL partial-finalize — state moved on, abort');
      return;
    }

    const executedSoFar = parseFloat(order.executedQty);
    const remainingQty = Math.max(0, parseFloat(order.origQty) - executedSoFar);
    const avgPriceSoFar = parseFloat(order.avgPrice) || (parseFloat(order.cummulativeQuoteQty) / Math.max(executedSoFar, 1e-12));

    // ถ้า remainingQty ≤ 0 → SELL fill ครบก่อน finalize (ตรวจตอน poll)
    if (remainingQty <= 0) {
      logger.info({ tradeId: trade._id.toString() }, 'trader: SELL partial-finalize — remaining=0, treating as full fill');
      await this.handleSellFilled({
        status: 'FILLED',
        orderId: trade.sellOrderId,
        executedQty: parseFloat(order.executedQty),
        avgPrice: avgPriceSoFar,
        cumulativeQuoteQty: parseFloat(order.cummulativeQuoteQty),
      }, fresh);
      return;
    }

    // คำนวณ lot precision จาก symbolInfo เพื่อ verify remainingQty valid
    let belowMinLot = false;
    try {
      const sym = symbolInfo.getCached(this.bot.symbol);
      if (sym && sym.lotSize && sym.lotSize.minQty) {
        const minQty = parseFloat(sym.lotSize.minQty.toString());
        if (remainingQty < minQty) {
          belowMinLot = true;
        }
      }
    } catch (_) { /* best-effort */ }

    // ❌ REMOVED 2026-08-01: cancel SELL + MARKET fallback
    //   ✅ ใหม่: log "freeze" + คง SELL order ไว้ตามเดิม + extend watch
    //   - เหตุผล: MARKET SELL มักติด MIN_LOT precision (-1111) → holding retry loop ไม่จบ
    //             และบางครั้งติด MIN_NOTIONAL (dust) → MARKET SELL ก็ fail
    //   - ทางออก: คง LIMIT_MAKER SELL live ที่ราคาเดิม → Binance จะ fill เมื่อมีคนมาตัดที่ราคานั้น
    //   - expose ใน DB: state='selling' + sellFreezeReason='lot_below_min' เพื่อ UI แสดง
    const freezeReason = belowMinLot ? 'lot_below_min' : 'partial_fill_freeze';
    logger.warn({
      botId: this.bot._id.toString(),
      tradeId: trade._id.toString(),
      symbol: this.bot.symbol,
      orderId: trade.sellOrderId,
      executedSoFar, remainingQty, avgPriceSoFar,
      belowMinLot,
      freezeReason,
      policy: 'NO_CANCEL_NO_REPLACE — keep SELL order LIVE waiting for natural fill',
    }, 'trader: SELL partial-fill FREEZE — keeping SELL order LIVE, NOT cancel + replace');

    // persist freeze flag in DB (UI แสดงสถานะ, manual close path สามารถใช้ตรวจ)
    await Trade.updateOne(
      { _id: trade._id },
      {
        $set: {
          sellStatus: 'PARTIALLY_FILLED',
          sellFreezeReason: freezeReason,
          sellFreezeAt: new Date(),
          sellFrozenExecutedQty: executedSoFar,
          sellFrozenRemainingQty: remainingQty,
        },
      }
    ).catch((err) => logger.warn({ err: err.message, tradeId: trade._id.toString() }, 'freeze flag persist failed'));

    // extend watch deadline — keep polling until SELL FILLED manually (or new S1 signal cancel+replace)
    //   ใช้ TTL ยาว (24h) แล้วให้ user ตัดสินใจเอง — หรือ SELL fill เองตอนมีคนมาตัด
    const freezeUntilMs = Date.now() + 24 * 60 * 60 * 1000;
    this.sellPartialFillDeadlineAt = freezeUntilMs;
    Trade.updateOne(
      { _id: trade._id },
      { $set: { sellPartialDeadlineAt: new Date(freezeUntilMs) } }
    ).catch((err) => logger.warn({ err: err.message, tradeId: trade._id.toString() }, 'freeze deadline persist failed'));

    // schedule next poll (30s) — watch ต่อปกติ แต่ deadline ยาว 24h
    this.scheduleSellPartialFillWatch(fresh);

    // Telegram alert — แจ้ง user ว่า freeze แล้ว (manual intervention OK)
    try {
      await telegramNotifier.notify('sellPartialFrozen', {
        botName: this.bot.name || this.bot.symbol,
        symbol: this.bot.symbol,
        timeframe: trade.timeframe,
        tradeId: trade._id.toString(),
        orderId: trade.sellOrderId,
        executedSoFar, remainingQty, avgPriceSoFar,
        belowMinLot,
        freezeReason,
        note: 'SELL partial-fill FREEZE — keep order LIVE, waiting for natural fill. Manual cancel/new SELL allowed.',
      }).catch((err) => logger.warn({ err: err.message }, 'trader: sellPartialFrozen telegram notify failed'));
    } catch (err) {
      // fail-safe: log error + persist freeze flag (FREEZE policy — no state change)
      logger.error({
        err: err.message, stack: err.stack,
        tradeId: trade._id.toString(),
      }, 'trader: SELL partial-finalize crashed');
      try {
        await Trade.updateOne(
          { _id: trade._id },
          { $set: { sellFreezeError: err.message, sellFreezeAt: new Date() } }
        );
      } catch (cleanupErr) {
        logger.error({ err: cleanupErr.message }, 'trader: SELL partial-finalize cleanup failed');
      }
    }
  }

  // ─── Helpers ───────────────────────────────────────

  /**
   * FIX-2026-07-15: Periodic sweep — fetch latest 5 candles via REST แล้ว replay onCandleClosed
   * สำหรับ candle ที่ close ไปแล้วและยังไม่ถูก process (เช่น WS หลุดระหว่าง close)
   *
   * @param {string} trigger — 'periodic-sweep' | 'ws-reconnect' | 'startup'
   */
  async reconcileKlines(trigger = 'periodic-sweep') {
    if (!this.running) {
      logger.debug({ botId: this.bot._id.toString(), trigger }, 'trader: reconcileKlines skipped (not running)');
      return;
    }
    if (this.reconcileInFlight) {
      logger.debug({ botId: this.bot._id.toString(), trigger }, 'trader: reconcileKlines skipped (already in flight)');
      return;
    }
    this.reconcileInFlight = true;
    try {
      // FIX-2026-07-15: ดึง candles ตั้งแต่ candle ถัดจาก signal ล่าสุด
      //   ปัญหาเดิม (v3): max(lastSignalCloseMs, cacheLastCloseMs)+1
      //     → cache.lastCloseTime มาจาก forming candle (closeTime > now) → startTime เป็นอนาคต → Binance คืน len=0
      //   ปัญหาเดิม (v5): ใช้ max(lastSignalCloseMs, latestClosedInCacheMs) → cache tail advance ทุก tick
      //     → startTime ขยับตาม cache → fetch แค่ 1 candle forming ตลอด → ไม่เคยดึง candles เก่าใน cache
      //   fix (v6): ใช้แค่ lastSignalCloseMs
      //     → Binance คืน candles ทั้งหมดตั้งแต่ signal ล่าสุด (รวม candles ที่อยู่ใน cache แล้ว)
      //     → onCandleClosed({replay:true}) จะใช้ detectS1Signals(klines) รันบน full cache
      //        → หา signal ที่ closeTime ตรงกับ candle ที่ replay → save signal + place BUY
      const lastSignalCloseMs = this.bot.lastSignalCloseTime || 0;
      const nowMs = Date.now();

      // FIX: fresh-bot guard — ถ้าบอทเพิ่ง enabled (lastSignalCloseTime = 0) ห้าม replay
      //   historical candles เพราะจะไป trigger BUY บน S1 เก่าที่เกิดก่อน start
      //   (เคยเจอ user รายงาน: "กด Start แล้วบอทเปิดออร์เดอร์ทันทีทั้งที่กราฟยังไม่มีสัญญาณ")
      //   fix: ดึง candles 2 แท่งล่าสุด, set cursor ไปที่แท่ง closed ล่าสุด, ไม่เรียก onCandleClosed
      //        → ปล่อยให้ WS handle candle close ที่เกิดขึ้นหลัง start เท่านั้น
      if (lastSignalCloseMs === 0) {
        const initParams = {
          symbol: this.bot.symbol,
          interval: this.bot.timeframe,
          limit: 2,
        };
        const initRaw = await binanceRest.getKlines(initParams);
        let latestClosedMs = 0;
        for (const k of (initRaw || [])) {
          const ct = k[6];
          if (ct <= nowMs && ct > latestClosedMs) latestClosedMs = ct;
        }
        if (latestClosedMs > 0) {
          await Bot.updateOne(
            { _id: this.bot._id },
            { $set: { lastSignalCloseTime: latestClosedMs } }
          ).catch((err) => logger.warn({ err: err.message }, 'trader: seed lastSignalCloseTime failed'));
          this.bot.lastSignalCloseTime = latestClosedMs;
          logger.info({
            botId: this.bot._id.toString(),
            trigger,
            latestClosedMs,
            nowMs,
          }, 'trader: fresh bot — cursor seeded to latest closed, skipped historical replay');
        } else {
          logger.debug({ botId: this.bot._id.toString(), trigger }, 'trader: fresh bot — no closed candles yet');
        }
        return;
      }

      const params = {
        symbol: this.bot.symbol,
        interval: this.bot.timeframe,
        limit: 200,
      };
      if (lastSignalCloseMs > 0) params.startTime = lastSignalCloseMs + 1;
      const raw = await binanceRest.getKlines(params);
      if (!Array.isArray(raw) || raw.length === 0) {
        logger.debug({ botId: this.bot._id.toString(), trigger, lastSignalCloseMs }, 'trader: reconcileKlines — no klines returned');
        return;
      }

      let replayed = 0;
      let actuallySeeded = 0;
      let skipped = 0;
      let advancedToMs = lastSignalCloseMs;
      for (const k of raw) {
        const openTime = k[0];
        const closeTime = k[6];
        if (closeTime > nowMs) { skipped += 1; continue; } // ยังไม่ close (current forming candle) — skip
        if (closeTime <= lastSignalCloseMs) { skipped += 1; continue; } // เคย process signal แล้ว
        if (closeTime === openTime) { skipped += 1; continue; } // sanity
        // Replay — onCandleClosed({replay:true}) จะ:
        //   1) append candle เข้า cache (ถ้าใหม่กว่า cache tail)
        //   2) run detectS1Signals(klines) บน full cache
        //   3) ถ้าเจอ S1 ที่ closeTime ตรงกับ candle นี้ → save Signal + place BUY
        const beforeCacheSize = klineCache.size(this.bot.symbol, this.bot.timeframe);
        await this.onCandleClosed({
          openTime,
          closeTime,
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          isClosed: true,
        }, { replay: true, trigger });
        replayed += 1;
        if (closeTime > advancedToMs) advancedToMs = closeTime;
        const afterCacheSize = klineCache.size(this.bot.symbol, this.bot.timeframe);
        if (afterCacheSize > beforeCacheSize) actuallySeeded += 1;
      }

      // FIX-2026-08-01 (CRITICAL-BUG-1): force CB on the most-recent missed candle
      //   - covers WS-outage scenarios where kline:closed events were missed
      //   - the direct kline:closed subscription (_cbKlineHandler) handles live path
      //   - this handles the "WS dropped, sweep is replaying missed candles" path
      //   - reuses raw[] from above so no extra REST call
      if (replayed > 0 && this.bot.cbEnabled !== false && !this.cbCheckInFlight) {
        let lastMissed = null;
        for (const k of raw) {
          if (k[6] > nowMs) continue; // forming
          if (k[6] <= lastSignalCloseMs) continue; // already processed
          if (!lastMissed || k[6] > lastMissed[6]) lastMissed = k;
        }
        if (lastMissed) {
          await this._checkCBPanicClose({
            openTime: lastMissed[0],
            closeTime: lastMissed[6],
            open: parseFloat(lastMissed[1]),
            high: parseFloat(lastMissed[2]),
            low: parseFloat(lastMissed[3]),
            close: parseFloat(lastMissed[4]),
            volume: parseFloat(lastMissed[5]),
            isClosed: true,
          });
        }
      }

      // FIX-2026-08-06: force CBv2 on the most-recent missed candle (sustained breach lock)
      //   - same WS-outage coverage as CB above but checks CBv2 pattern (4 consecutive red candles below lowerKC)
      //   - lock expiry is the long-term gate; this just catches the missed candle for force-close
      // FIX-2026-08-08: Feature #2 — CBv3 replay (mirror CBv2 — _checkCBv3PanicClose internally checks cbVersion)
      if (replayed > 0) {
        let lastMissed = null;
        for (const k of raw) {
          if (k[6] > nowMs) continue; // forming
          if (k[6] <= lastSignalCloseMs) continue; // already processed
          if (!lastMissed || k[6] > lastMissed[6]) lastMissed = k;
        }
        if (lastMissed) {
          const candleObj = {
            openTime: lastMissed[0],
            closeTime: lastMissed[6],
            open: parseFloat(lastMissed[1]),
            high: parseFloat(lastMissed[2]),
            low: parseFloat(lastMissed[3]),
            close: parseFloat(lastMissed[4]),
            volume: parseFloat(lastMissed[5]),
            isClosed: true,
          };
          if (this.bot.cbv2Enabled !== false && !this.cbv2CheckInFlight) {
            await this._checkCBv2PanicClose(candleObj);
          }
          if (this.bot.cbv3Enabled !== false && !this.cbv3CheckInFlight) {
            await this._checkCBv3PanicClose(candleObj);
          }
        }
      }

      // FIX-2026-07-15: advance lastSignalCloseTime แม้ไม่เจอ S1 (กัน re-fetch ซ้ำรอบหน้า)
      if (advancedToMs > lastSignalCloseMs) {
        await Bot.updateOne(
          { _id: this.bot._id },
          { $max: { lastSignalCloseTime: advancedToMs } }
        ).catch((err) => logger.warn({ err: err.message }, 'trader: advance lastSignalCloseTime failed'));
        this.bot.lastSignalCloseTime = advancedToMs;
      }

      if (replayed > 0) {
        logger.info({
          botId: this.bot._id.toString(),
          trigger,
          replayed,
          actuallySeeded,
          skipped,
          fromMs: lastSignalCloseMs,
          advancedToMs,
        }, 'trader: reconciled missed candle closes');
      } else {
        logger.debug({
          botId: this.bot._id.toString(),
          trigger,
          checked: raw.length,
          skipped,
          lastSignalCloseMs,
        }, 'trader: sweep ok, no missed closes');
      }
    } catch (err) {
      // ไม่ throw — sweep ล้มเหลวไม่ควรหยุดบอท
      logger.warn({ botId: this.bot._id.toString(), trigger, err: err.message, stack: err.stack }, 'trader: reconcileKlines error');
    } finally {
      this.reconcileInFlight = false;
    }
  }

  // FIX 6: เพิ่ม random suffix กัน -2010 Duplicate order sent
  // (กรณี retry ที่ ts+retry+side ตรงกัน)
  makeClientOrderId(side, refTs, retry) {
    const ts = typeof refTs === 'number' ? refTs : new Date(refTs).getTime();
    const shortBot = this.bot._id.toString().slice(-6);
    const rand = Math.random().toString(36).slice(2, 8); // 6-char random
    return `b${shortBot}-${ts}-${retry}-${side}-${rand}`.slice(0, 36); // Binance limit 36 chars
  }
}

function config_recvWindow() {
  // lazy load เพื่อไม่ให้เกิด circular
  return require('../../config').binance.recvWindow;
}

// FIX-2026-07-15: periodic kline sweep interval (ms) — safety net against missed kline:closed events
//   WS reconnect storms ดูดูดสังเกตได้ทุกๆ 1-2 วินาที, แต่ละครั้งทำให้ candle close อาจหายไป
//   ดังนั้น sweep ทุก 90s → กลบ gap ภายใน 90s (เคสเดิมพลาดไป 1.5 ชม. ก่อน user เห็น)
// FIX-2026-08-04: 90s → 300s (5min) — ลด Binance kline API load — WS push จัดการ live candles
//   - sweepTimer เป็น safety net เท่านั้น (กัน WS gap) — 5 min gap ยังยอมรับได้
//   - bot operations ไม่กระทบ — reconcileKlines() logic เหมือนเดิม
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

module.exports = Trader;