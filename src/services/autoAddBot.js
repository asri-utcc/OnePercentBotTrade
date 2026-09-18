'use strict';

/**
 * FIX-2026-08-07: Auto Add New Bot Service
 *
 * Background:
 *   ผู้ใช้ต้องการฟีเจอร์ที่ทำงานอัตโนมัติทุก ๆ N นาที (default 60): สแกนหาคู่เหรียญ
 *   ที่ "เหวี่ยง" ตาม scan defaults, กรองเฉพาะเหรียญที่ (a) ยังไม่มีบอทในระบบ และ
 *   (b) Min %KC > threshold, แล้วสร้างบอทใหม่ตามค่า new-bot defaults
 *
 * Design:
 *   - Default OFF (user must opt-in via scan-volatility card หรือ settings)
 *   - Periodic scan (default 60 min) — re-uses volatilityScanner.scanUniverse()
 *   - Filter: !Bot.distinct('symbol') AND ranked.kcMinPct > minKcPct
 *   - Cap: maxPerRun (default 5)
 *   - FIX-2026-08-07: ถ้า autoEnable=true (default ON) → เรียก botManager.enableBot() ทันทีหลัง create
 *     → bot spawn Trader + start running ทันที ไม่ต้องไปกด enable ที่ bots.html
 *     ถ้า autoEnable=false → สร้างบอท DISABLED ไว้ก่อน (legacy SAFETY mode) ให้ user เปิดเอง
 *   - Audit: บันทึก lastRunAt + lastStats + lastError ลง AppConfig (cross-restart persist)
 *   - EventBus: emit 'autoAddBot:created' สำหรับ telegram notifier (with autoEnabled flag)
 *
 * Manual trigger:
 *   - POST /api/auto-add-bot/run → runOnce() โดยไม่สนใจ interval
 *
 * ⚠️ Live trading risk: สร้างบอทใหม่ disabled ก่อนเสมอ — user ต้องเปิดเอง
 */

const AppConfig = require('../db/models/AppConfig');
const Bot = require('../db/models/Bot');
const volatilityScanner = require('../core/volatilityScanner');
const botManager = require('../core/botManager'); // FIX-2026-08-07: auto-enable บอทที่เพิ่งสร้าง (spawnTrader)
const eventBus = require('./eventBus');
const { getBotDefaults, buildBotCreatePayload } = require('./botDefaults'); // FIX-2026-08-09: share defaults source with manual POST /api/bots
const licenseService = require('./licenseService'); // FIX-2026-08-27 Phase 3b-1: pass tier to buildBotCreatePayload
const logger = require('../utils/logger');
// FIX-2026-09-17: per-instance first-fire stagger
const { scheduledInterval, clearScheduledInterval } = require('../utils/scheduledInterval');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 min (กันพลาดตั้งค่า interval ต่ำเกิน)

class AutoAddBot {
  constructor() {
    this.interval = null;
    this.intervalMs = DEFAULT_INTERVAL_MS;
    this.inFlight = false;
    this.tickCount = 0;
    this.lastRunAt = null;
    this.lastRunError = null;
    this.lastStats = null;
    this.config = null;
  }

  /**
   * Start the periodic scanner. Config reloaded from AppConfig every tick.
   *   - ถ้า enabled=false → อย่าติดตั้ง interval (start in dormant mode)
   *   - reloadConfig() จะติดตั้ง interval ใหม่เมื่อ user เปิด toggle ภายหลัง
   */
  start({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    this._loadConfig().then((cfg) => {
      this.config = cfg;
      if (cfg.enabled) this._installInterval(intervalMs);
      logger.info({ enabled: cfg.enabled, intervalMs: this.intervalMs }, 'autoAddBot: started');
    }).catch((err) => {
      logger.error({ err: err.message }, 'autoAddBot: initial config load failed');
    });
  }

  stop() {
    if (this.interval) {
      clearScheduledInterval(this.interval);
      this.interval = null;
    }
    logger.info('autoAddBot: stopped');
  }

  /**
   * Reload config + restart timer (เรียกจาก PUT /api/auto-add-bot/config)
   *   - ถ้า enabled flag เปลี่ยน → start/stop interval ตามค่าใหม่
   *   - ถ้า intervalMs เปลี่ยน → restart timer
   */
  async reloadConfig() {
    const wasEnabled = !!this.interval;
    const wasIntervalMs = this.intervalMs;
    try {
      this.config = await this._loadConfig();
    } catch (err) {
      logger.warn({ err: err.message }, 'autoAddBot: reloadConfig load failed');
      return;
    }
    if (this.config.enabled && (!wasEnabled || this.config.intervalMs !== wasIntervalMs)) {
      this._installInterval(this.config.intervalMs);
      logger.info({ enabled: true, intervalMs: this.config.intervalMs }, 'autoAddBot: interval installed/reinstalled');
    } else if (!this.config.enabled && wasEnabled) {
      this.stop();
      logger.info('autoAddBot: disabled — interval cleared');
    } else {
      logger.info({ enabled: this.config.enabled, intervalMs: this.intervalMs }, 'autoAddBot: reloaded (no interval change)');
    }
  }

  _installInterval(intervalMs) {
    if (this.interval) clearScheduledInterval(this.interval);
    this.intervalMs = Math.max(MIN_INTERVAL_MS, intervalMs || DEFAULT_INTERVAL_MS);
    // FIX-2026-09-17: SCHEDULE_OFFSET_SEC applied (Binance kline read)
    this.interval = scheduledInterval(() => this._tickSafe(), this.intervalMs, {
      unref: true,
      meta: 'autoAddBot',
    });
    // immediate first tick — ให้ user เห็นผลทันทีหลังเปิด toggle (independent of offset)
    setImmediate(() => this._tickSafe());
  }

  async _loadConfig() {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (!cfg) {
      // No config yet — use defaults (enabled=false)
      return {
        enabled: false,
        intervalMs: DEFAULT_INTERVAL_MS,
        minKcPct: 2,
        maxPerRun: 5,
        telegramNotify: true,
        autoEnable: true, // FIX-2026-08-07: default ON — auto-spawn Trader ทันทีหลัง create
        autoRestore: true, // FIX-2026-08-23: default ON — restore + activate บอท soft-deleted ที่ symbol ตรงเกณฑ์
        scanParams: {
          timeframe: '3m',
          threshold: 0.5,
          window: 500,
          tpWindow: 30,
          topN: 100,
          minQuoteVolume: 1_000_000,
          minPctBarsAbove: 0.30,
          trends: ['uptrend', 'downtrend', 'sideways'],
          concurrency: 8,
        },
      };
    }
    const intervalMin = Math.max(5, Number(cfg.autoAddBotIntervalMin) || 60);
    return {
      // FIX-2026-08-28 B6: gate autoAddBot via license (basic tier = OFF)
      enabled: cfg.autoAddBotEnabled === true && licenseService.isFeatureEnabled('autoAddBot'),
      intervalMs: intervalMin * 60 * 1000,
      minKcPct: Number(cfg.autoAddBotMinKcPct) || 2,
      maxPerRun: Math.max(1, Number(cfg.autoAddBotMaxPerRun) || 5),
      telegramNotify: cfg.autoAddBotTelegramNotify !== false,
      // FIX-2026-08-07: auto-enable บอทที่เพิ่งสร้างทันที (default true ตาม new-bot modal default)
      autoEnable: cfg.autoAddBotAutoEnable !== false,
      // FIX-2026-08-23: auto-restore + activate บอท soft-deleted ที่ symbol ตรงเกณฑ์ (default true)
      autoRestore: cfg.autoAddBotAutoRestore !== false,
      // 2026-08-08: name prefix (default "(bAdd)" — match DEFAULTS + sanitize)
      namePrefix: typeof cfg.autoAddBotNamePrefix === 'string' && cfg.autoAddBotNamePrefix.trim()
        ? cfg.autoAddBotNamePrefix.trim().slice(0, 32)
        : '(bAdd)',
      scanParams: {
        timeframe: cfg.autoAddBotScanTimeframe || '3m',
        threshold: Number(cfg.autoAddBotScanThreshold) || 0.5,
        window: Math.max(5, Number(cfg.autoAddBotScanWindow) || 500),
        tpWindow: Math.max(20, Number(cfg.autoAddBotScanTpWindow) || 30),
        topN: Math.max(20, Number(cfg.autoAddBotScanTopN) || 100),
        minQuoteVolume: Number(cfg.autoAddBotScanMinVol) || 1_000_000,
        minPctBarsAbove: Number(cfg.autoAddBotScanMinPct) || 0.30,
        trends: Array.isArray(cfg.autoAddBotScanTrends) && cfg.autoAddBotScanTrends.length > 0
          ? cfg.autoAddBotScanTrends
          : ['uptrend', 'downtrend', 'sideways'],
        concurrency: 8,
      },
    };
  }

  _tickSafe() {
    this.tickCount += 1;
    this.runOnce({ source: 'periodic' })
      .then((stats) => {
        this.lastStats = { ...stats, ts: Date.now(), tickCount: this.tickCount };
        this.lastRunError = null;
        if (stats.created > 0 || stats.skipped) {
          logger.info({ ...stats, tickCount: this.tickCount }, 'autoAddBot: tick (created/skipped)');
        } else {
          logger.debug({ ...stats, tickCount: this.tickCount }, 'autoAddBot: tick');
        }
      })
      .catch((err) => {
        this.lastRunError = err.message;
        logger.error({ err: err.message, stack: err.stack, tickCount: this.tickCount }, 'autoAddBot: tick failed');
      })
      .finally(async () => {
        this.lastRunAt = new Date();
        // persist lastRunAt/lastStats/lastError ลง DB (กัน pm2 restart แล้วลืม)
        try {
          await AppConfig.updateOne({ key: 'singleton' }, {
            $set: {
              autoAddBotLastRunAt: this.lastRunAt,
              autoAddBotLastStats: this.lastStats,
              autoAddBotLastError: this.lastRunError,
            },
          });
        } catch (err) {
          logger.warn({ err: err.message }, 'autoAddBot: persist lastRun failed');
        }
      });
  }

  /**
   * Run one scan + filter + create. Idempotent — in-flight guard.
   * Returns stats: { outcome, scanned, candidates, created, createdList, error? }
   */
  async runOnce({ source = 'periodic', force = false } = {}) {
    if (this.inFlight) {
      logger.warn({ source }, 'autoAddBot: previous tick still in flight, skip');
      return { skipped: 'inFlight' };
    }
    this.inFlight = true;
    try {
      // re-load config (ถ้ามีการเปลี่ยนระหว่างรอบ)
      if (!this.config) {
        this.config = await this._loadConfig();
      }
      if (!this.config.enabled && !force) {
        return { skipped: 'disabled' };
      }

      // 1. scan
      let scanResp;
      try {
        scanResp = await volatilityScanner.scanUniverse(this.config.scanParams);
      } catch (err) {
        logger.error({ err: err.message }, 'autoAddBot: scanUniverse failed');
        return { outcome: 'failed_scan', error: err.message };
      }
      const ranked = scanResp.ranked || [];

      // 2. fetch existing symbols SPLIT by deletion status (FIX-2026-08-23)
      //   - activeSymbols: bots ที่ยังเ�รดอยู่ (deletedAt: null) — ใช้ skip ถ้า scan เจอ symbol นี้ (มีบอทแล้ว)
      //   - deletedBySymbol: bots ที่ถูก soft-delete — ถ้า autoRestore=true และ symbol ตรงเกณฑ์ → restore + activate แทนที่จะสร้างบอทใหม่ (กันบอทซ้อน, รัก�า trade history)
      const [activeSymbolsRaw, deletedBotsRaw] = await Promise.all([
        Bot.distinct('symbol', { deletedAt: null }),
        this.config.autoRestore
          ? Bot.find({ deletedAt: { $ne: null } })
              .select('_id name symbol deletedAt scheduledDeleteAt')
              .lean()
          : Promise.resolve([]),
      ]);
      const activeSymbols = new Set(
        activeSymbolsRaw.map((s) => String(s || '').toUpperCase())
      );
      const deletedBySymbol = new Map(
        deletedBotsRaw.map((b) => [String(b.symbol || '').toUpperCase(), b])
      );

      // 3. filter: NOT in activeSymbols AND kcMinPct > minKcPct threshold
      //   - soft-deleted bots จะ *ไม่* ถูกนับเป็น "existing" — จะถูก process ใน step 5 (restore path) แทน
      //   - autoRestore=false → deletedBySymbol ว่าง → filter นี้จะ pick up symbol เหล่านั้น (จะสร้างบอทใหม่ ถ้า symbol ยังตรงเกณฑ์)
      const candidates = ranked.filter((r) => {
        const sym = String(r.symbol || '').toUpperCase();
        if (!sym) return false;
        if (activeSymbols.has(sym)) return false;
        if (!Number.isFinite(r.kcMinPct)) return false;
        return r.kcMinPct > this.config.minKcPct;
      });

      // 4. cap ตาม maxPerRun (covers BOTH create-new + restore-existing)
      const toProcess = candidates.slice(0, this.config.maxPerRun);

      // 5. process: CREATE-NEW หรือ RESTORE-EXISTING (per candidate)
      const createdList = [];
      const restoredList = [];
      const failedList = [];
      for (const r of toProcess) {
        const sym = String(r.symbol || '').toUpperCase();
        const deletedBot = deletedBySymbol.get(sym);
        try {
          if (deletedBot) {
            // RESTORE path: �ีบอท soft-deleted อยู่แล้ว → restore + (optional) auto-enable
            const result = await this._restoreAndEnableBot(deletedBot, r);
            restoredList.push(result);
          } else {
            // CREATE path: symbol ใหม่ → create new bot + (optional) auto-enable
            const result = await this._createAndEnableBot(r);
            createdList.push(result);
          }
        } catch (err) {
          logger.warn({ symbol: r.symbol, err: err.message }, 'autoAddBot: process failed');
          failedList.push({ symbol: r.symbol, error: err.message });
        }
      }

      return {
        outcome: createdList.length > 0 || restoredList.length > 0 ? 'created' : 'no_candidates',
        scanned: ranked.length,
        candidates: candidates.length,
        created: createdList.length,
        createdEnabled: createdList.filter((b) => b.autoEnabled).length,
        restored: restoredList.length,
        restoredEnabled: restoredList.filter((b) => b.autoEnabled).length,
        capped: candidates.length - toProcess.length,
        createdList,
        restoredList,
        failedList,
        source,
      };
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * CREATE path (FIX-2026-08-23): extract inline create+enable logic into helper.
   * - สร้างบอทใหม่ (DISABLED) แล้ว (optional) เรียก botManager.enableBot() เพื่อ spawnTrader
   * - emit `autoAddBot:created` event สำหรับ telegram notifier
   */
  async _createAndEnableBot(r) {
    const bot = await this._createBotFor(r);
    let autoEnabled = false;
    let enableError = null;
    if (this.config.autoEnable) {
      try {
        await botManager.enableBot(bot._id);
        autoEnabled = true;
        logger.info({ botId: String(bot._id), symbol: r.symbol }, 'autoAddBot: created + auto-enabled + spawnTrader');
      } catch (err) {
        enableError = err.message;
        logger.warn({ botId: String(bot._id), symbol: r.symbol, err: err.message }, 'autoAddBot: create OK but auto-enable failed');
      }
    }
    const result = {
      botId: String(bot._id),
      symbol: r.symbol,
      score: r.score,
      kcMinPct: r.kcMinPct,
      suggestedTpPct: r.suggestedTpPct,
      autoEnabled,
      enableError,
    };
    if (this.config.telegramNotify) {
      eventBus.emit('autoAddBot:created', {
        botId: result.botId,
        botName: bot.name,
        symbol: r.symbol,
        timeframe: this.config.scanParams.timeframe,
        score: r.score,
        kcMinPct: r.kcMinPct,
        suggestedTpPct: r.suggestedTpPct,
        autoEnabled,
        autoEnable: this.config.autoEnable,
      });
    }
    logger.info({ botId: result.botId, symbol: r.symbol, score: r.score, kcMinPct: r.kcMinPct, autoEnabled }, 'autoAddBot: created');
    return result;
  }

  /**
   * RESTORE path (FIX-2026-08-23): restore บอท soft-deleted ที่ symbol ตรงเก�ฑ์ + (optional) auto-enable.
   *
   * ต่างจาก POST /api/bots/:id/restore ตรงที่:
   *   - ไม่ต้อง requireBotActionPassword (เป็น internal service trigger)
   *   - เรียก botManager.enableBot() ทันทีตามค่า autoEnable (เดิม restore endpoint ไม่ spawn)
   *   - emit `bot:restored` + `autoAddBot:restored` events
   *
   * Mirror logic ของ POST /api/bots/:id/restore (bot.routes.js:1376-1404):
   *   - clear deletedAt / scheduledDeleteAt / deleteNotificationSentAt / status='idle'
   *   - guard 30-day window (เ�มือน manual restore)
   *   - ตั้ง restoredAt + restoredBy='autoAddBot' เพื่อ audit trail
   */
  async _restoreAndEnableBot(deletedBot, scanMeta) {
    const botId = deletedBot._id;
    const deletedAt = deletedBot.deletedAt ? new Date(deletedBot.deletedAt) : null;
    if (!deletedAt) {
      throw new Error('deletedBot.deletedAt is null — cannot restore');
    }
    const daysSinceDelete = (Date.now() - deletedAt.getTime()) / (86_400_000);
    if (daysSinceDelete > 30) {
      // เหมือน POST /:id/restore — ถ้าเกิน 30 วัน ให้ fail (ไม่ silent skip) เพื่อให้ user เห็นใน failedList
      throw new Error(`Beyond 30-day restore window (${Math.floor(daysSinceDelete)}d)`);
    }

    // 1. clear soft-delete fields + audit trail
    const now = new Date();
    await Bot.updateOne({ _id: botId }, {
      $set: {
        deletedAt: null,
        scheduledDeleteAt: null,
        deleteNotificationSentAt: null,
        status: 'idle',
        restoredAt: now,
        restoredBy: 'autoAddBot',
      },
    });
    eventBus.emit('bot:updated', { botId: String(botId) });
    eventBus.emit('bot:restored', { botId: String(botId), source: 'autoAddBot' });

    // 2. (optional) auto-enable — เรียก enableBot() ตามค่า autoEnable (FIX-2026-08-07)
    //    หมายเหตุ: enableBot() throws ถ้า bot.deletedAt != null — แต่เราเพิ่ง clear ไปแล้ว → safe
    let autoEnabled = false;
    let enableError = null;
    if (this.config.autoEnable) {
      try {
        await botManager.enableBot(botId);
        autoEnabled = true;
      } catch (err) {
        enableError = err.message;
        logger.warn({ botId: String(botId), symbol: deletedBot.symbol, err: err.message }, 'autoAddBot: restored OK but auto-enable failed');
      }
    }

    // 3. emit telegram event (แยกจาก autoAddBot:created — ต่าง use case)
    if (this.config.telegramNotify) {
      eventBus.emit('autoAddBot:restored', {
        botId: String(botId),
        botName: deletedBot.name,
        symbol: deletedBot.symbol,
        timeframe: this.config.scanParams.timeframe,
        score: scanMeta.score,
        kcMinPct: scanMeta.kcMinPct,
        suggestedTpPct: scanMeta.suggestedTpPct,
        daysSinceDelete: Math.floor(daysSinceDelete),
        autoEnabled,
        autoEnable: this.config.autoEnable,
      });
    }
    logger.info({ botId: String(botId), symbol: deletedBot.symbol, daysSinceDelete: Math.floor(daysSinceDelete), autoEnabled }, 'autoAddBot: restored + activated');

    return {
      botId: String(botId),
      symbol: deletedBot.symbol,
      score: scanMeta.score,
      kcMinPct: scanMeta.kcMinPct,
      suggestedTpPct: scanMeta.suggestedTpPct,
      daysSinceDelete: Math.floor(daysSinceDelete),
      autoEnabled,
      enableError,
    };
  }

  /**
   * Create a new bot in DISABLED state. User must manually enable after review.
   *
   * FIX-2026-08-09: อ่านค่า default จาก AppConfig.botDefaults (Settings page section 1️⃣)
   *   เพื่อให้ค่าตรงกับ New Bot modal — แก้บั๊กที่ autoAddBot hardcode ทุก field
   *   แล้วค่าใน Settings ไม่ apply กับบอทที่ถูกสร้างอัตโนมัติ
   *
   * Precedence ต่อ field (ผ่าน buildBotCreatePayload):
   *   1. scan result (symbol, timeframe, tpPercent, name)
   *   2. AppConfig.botDefaults (user ตั้งใน Settings)
   *   3. fallback (hardcoded schema default)
   *
   * `enabled: false` ตั้งข้างนอกเสมอ — เป็น SAFETY ไม่ใช่ default
   *   (ถ้า autoEnable=true → botManager.enableBot() จะถูกเรียกตามหลัง return)
   */
  async _createBotFor(rank) {
    const symbol = String(rank.symbol || '').toUpperCase();
    if (!symbol) throw new Error('empty symbol');
    const tf = this.config.scanParams.timeframe;
    const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
    // 2026-08-08: prefix configurable via Settings 7️⃣ — default "(bAdd)"
    const prefix = (this.config && typeof this.config.namePrefix === 'string' && this.config.namePrefix.trim())
      ? this.config.namePrefix.trim()
      : '(bAdd)';
    const name = `${base}${prefix}`;

    // FIX-2026-08-09: อ่าน AppConfig.botDefaults เพื่อ share defaults กับ manual POST /api/bots
    //   - ก่อนหน้านี้: hardcode ทุก field → Settings ไม่มีผลกับบอทที่สร้างอัตโนมัติ
    //   - ตอนนี้: user เปลี่ยนค่าใน Settings → บอทใหม่ที่ auto-spawn ใช้ค่านั้นทันที
    const botDefaults = await getBotDefaults();

    // Scan-specific overrides:
    //   - name: "<base><prefix>" (ไม่ใช่ "<symbol> <timeframe>")
    //   - symbol/timeframe: จาก scan โดยตรง (override botDefaults.defaultSymbol/defaultTimeframe)
    //   - tpPercent: suggestedTpPct (NET from volatilityScanner) — ถ้า scan ไม่ส่ง → fallback ของ helper
    const overrides = {
      name,
      symbol,
      timeframe: tf,
      tpPercent: Number.isFinite(rank.suggestedTpPct) ? rank.suggestedTpPct : undefined,
    };

    const payload = buildBotCreatePayload({ overrides, botDefaults, tier: licenseService.getTier ? licenseService.getTier() : null });

    // SAFETY: สร้างบอท disabled เสมอ — user (หรือ autoEnable flag) เปิดเองทีหลัง
    payload.enabled = false;

    const bot = await Bot.create(payload);
    return bot;
  }

  getStatus() {
    return {
      running: !!this.interval,
      enabled: !!this.config?.enabled,
      intervalMs: this.intervalMs,
      inFlight: this.inFlight,
      tickCount: this.tickCount,
      lastRunAt: this.lastRunAt,
      lastRunError: this.lastRunError,
      lastStats: this.lastStats,
      config: this.config,
    };
  }
}

module.exports = new AutoAddBot();