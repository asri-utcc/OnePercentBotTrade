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
const logger = require('../utils/logger');

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
      clearInterval(this.interval);
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
    if (this.interval) clearInterval(this.interval);
    this.intervalMs = Math.max(MIN_INTERVAL_MS, intervalMs || DEFAULT_INTERVAL_MS);
    this.interval = setInterval(() => this._tickSafe(), this.intervalMs);
    // immediate first tick — ให้ user เห็นผลทันทีหลังเปิด toggle (ถ้ามี symbols ที่ผ่านเกณฑ์)
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
      enabled: cfg.autoAddBotEnabled === true,
      intervalMs: intervalMin * 60 * 1000,
      minKcPct: Number(cfg.autoAddBotMinKcPct) || 2,
      maxPerRun: Math.max(1, Number(cfg.autoAddBotMaxPerRun) || 5),
      telegramNotify: cfg.autoAddBotTelegramNotify !== false,
      // FIX-2026-08-07: auto-enable บอทที่เพิ่งสร้างทันที (default true ตาม new-bot modal default)
      autoEnable: cfg.autoAddBotAutoEnable !== false,
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

      // 2. existing bot symbols (uppercase normalize)
      const existingRaw = await Bot.distinct('symbol');
      const existing = new Set(existingRaw.map((s) => String(s || '').toUpperCase()));

      // 3. filter: NOT in existing AND kcMinPct > minKcPct threshold
      const candidates = ranked.filter((r) => {
        const sym = String(r.symbol || '').toUpperCase();
        if (!sym) return false;
        if (existing.has(sym)) return false;
        if (!Number.isFinite(r.kcMinPct)) return false;
        return r.kcMinPct > this.config.minKcPct;
      });

      // 4. cap ตาม maxPerRun
      const toCreate = candidates.slice(0, this.config.maxPerRun);

      // 5. create bots
      const createdList = [];
      const failedList = [];
      for (const r of toCreate) {
        try {
          const bot = await this._createBotFor(r);
          // FIX-2026-08-07: auto-enable ทันทีหลัง create (default ON)
          //   - เรียก botManager.enableBot() → persisted enabled=true + spawnTrader() + invalidate trendline + scan fresh
          //   - ถ้า enable ล้มเหลว ไม่ fail ทั้ง batch — ใส่ enabled=false + error ใน createdList ให้ user เปิดเอง
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
          createdList.push({
            botId: String(bot._id),
            symbol: r.symbol,
            score: r.score,
            kcMinPct: r.kcMinPct,
            suggestedTpPct: r.suggestedTpPct,
            autoEnabled,
            enableError,
          });
          // emit event for telegram notifier
          if (this.config.telegramNotify) {
            eventBus.emit('autoAddBot:created', {
              botId: String(bot._id),
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
          logger.info({ botId: String(bot._id), symbol: r.symbol, score: r.score, kcMinPct: r.kcMinPct, autoEnabled }, 'autoAddBot: created');
        } catch (err) {
          logger.warn({ symbol: r.symbol, err: err.message }, 'autoAddBot: create failed');
          failedList.push({ symbol: r.symbol, error: err.message });
        }
      }

      return {
        outcome: createdList.length > 0 ? 'created' : 'no_candidates',
        scanned: ranked.length,
        candidates: candidates.length,
        created: createdList.length,
        createdEnabled: createdList.filter((b) => b.autoEnabled).length,
        capped: candidates.length - toCreate.length,
        createdList,
        failedList,
        source,
      };
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Create a new bot in DISABLED state. User must manually enable after review.
   * Settings mirror new-bot modal defaults (2026-08-07):
   *   - name "${base}<namePrefix>" (strip USDT suffix; prefix configurable via Settings 7️⃣)
   *   - 9 USDT/trade, 1 trade, TP from scan suggestedTpPct
   *   - 0.2 min retry × 8, KC×1.2, spread 1 tick
   *   - ST2 + ST3 on · CB off · Safe-trade off
   *   - autoUpdateTp + auto-arm SL-UKC 6.3%/4h + SL-UKC on profit
   *   - TP trend ×2 enabled
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
    // tpPercent = suggestedTpPct (NET, x.xx1 format) — fallback 0.1 ถ้า scan ไม่ได้ส่งมา
    const tpPercent = Number.isFinite(rank.suggestedTpPct) ? rank.suggestedTpPct : 0.1;
    const bot = await Bot.create({
      name,
      symbol,
      timeframe: tf,
      capitalPerTrade: 9,
      maxTrades: 1,
      tpPercent,
      retryTimeMin: 0.2,
      retryMax: 8,
      kcMult: 1.2,
      minSpreadTicks: 1,
      suggestTpWindow: 30,
      s1OnlyDown: true,
      xs1Enabled: true,
      stopLossOnUpperKC: false,
      cbEnabled: false,
      cbv2Enabled: true,
      cbv2LockHours: 8,
      safeTradeEnabled: false,
      safeTradeTrendlineEnabled: true,
      safeTradeNoTradeEnabled: true,
      autoPauseEnabled: true,
      autoPauseMinKcPct: 2,
      autoUpdateTp: true,
      autoArmStopLossOnUKC: true,
      autoArmLossPct: 6.3,
      autoArmAgeHours: 4,
      slUkcTriggerOnProfit: true,
      tpTrendEnabled: true,
      tpTrendMultiplier: 2,
      enabled: false, // SAFETY: don't auto-enable — user reviews + enables manually
    });
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