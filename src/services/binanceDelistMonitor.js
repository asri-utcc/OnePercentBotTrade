'use strict';

/**
 * FIX-2026-08-06: Binance Delist Monitor
 *
 * Purpose:
 *   - Detect symbols Binance has flagged for potential delisting (Marketing "Monitoring" tag)
 *     and symbols with a confirmed delist date (/sapi/v1/spot/delist-schedule)
 *   - Expose helpers for trader pre-flight, symbolInfo.validateOrder, bot auto-pause,
 *     telegram notifier, and UI badges
 *   - Emit eventBus events on first detection and on transition changes
 *
 * Why two layers:
 *   - Layer 1 — Marketing "Monitoring" tag (cache 30min, weight 1, no auth):
 *       Early warning. Cryptorank: "Every Token Binance Delisted Monday Carried a
 *       Prior Warning Label". Bots can still open positions but mark at-risk.
 *   - Layer 2 — /sapi/v1/spot/delist-schedule (cache 30min, weight 100, X-MBX-APIKEY):
 *       Authoritative delist date. Once a symbol appears here, the bot MUST NOT open
 *       new positions and SHOULD force-close existing positions before the delist time.
 *
 * Safety:
 *   - Fetch failures are non-fatal (we keep stale cache + warn)
 *   - No DB writes — purely in-memory cache + eventBus events
 *   - Force-close is handled by botManager.checkDelistSchedule (separate concern)
 */

const https = require('https');
const binanceRest = require('../binance/binanceRest');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');

// ─── Config ────────────────────────────────────────────
const MARKETING_LIST_URL = 'www.binance.com';
const MARKETING_LIST_PATH = '/bapi/composite/v1/public/marketing/symbol/list';
const MARKETING_TTL_MS = 30 * 60 * 1000;     // 30 min — Binance เปลี่ยน tag ช้า
const SCHEDULE_TTL_MS = 30 * 60 * 1000;      // 30 min — �ด weight load (100/call)
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;   // tick ทุก 5 นาที — check TTL + emit diff
const FORCE_CLOSE_DAYS = 3;                  // ถ้า delistTime - now <= 3 วัน → force-close
const BLOCK_BUY_DAYS = 7;                    // ถ้า delistTime - now <= 7 วัน → block new BUY
const RISK_TAGS = ['Monitoring'];            // tag ที่บ่งบอกเสี่ยง (verified VICUSDT มี 'Monitoring')

// ─── State ─────────────────────────────────────────────
// Layer 1 — at-risk set (from marketing "Monitoring" tag)
let monitoredSymbols = new Set();           // symbol (uppercase) → true
let monitoredAt = 0;                        // ts of last successful refresh
let monitoredLastError = null;

// Layer 2 — delist schedule: symbol → { delistTime: epoch_ms, firstSeenAt: epoch_ms }
let delistSchedule = new Map();
let scheduleAt = 0;
let scheduleLastError = null;

// Anti-spam: track which delist symbols we've already notified via telegram
//   - cleared only when symbol disappears from schedule (cancel delist)
const notifiedSymbols = new Set();

// ─── Marketing list fetch (Layer 1) ─────────────────────
function fetchMarketingList() {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: MARKETING_LIST_URL,
      path: MARKETING_LIST_PATH,
      headers: {
        'User-Agent': 'Mozilla/5.0 (onepercentbot/delistMonitor)',
        'Accept': 'application/json',
        'lang': 'en',
      },
      timeout: 10_000,
    }, (resp) => {
      let body = '';
      resp.on('data', (chunk) => { body += chunk; });
      resp.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.code !== '000000') return reject(new Error(`BAPI code ${j.code}: ${j.message || ''}`));
          resolve(j.data || []);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('BAPI marketing timeout')); });
  });
}

async function refreshMonitoredSymbols({ force = false } = {}) {
  const now = Date.now();
  if (!force && monitoredAt && (now - monitoredAt) < MARKETING_TTL_MS) {
    return monitoredSymbols;
  }
  try {
    const list = await fetchMarketingList();
    const next = new Set();
    for (const item of list) {
      const sym = String(item.symbol || '').toUpperCase();
      if (!sym) continue;
      const tags = Array.isArray(item.tags) ? item.tags : [];
      if (RISK_TAGS.some((t) => tags.includes(t))) {
        next.add(sym);
      }
    }
    // Diff for logging + events
    const newlyMonitored = [];
    const clearedMonitor = [];
    for (const s of next) if (!monitoredSymbols.has(s)) newlyMonitored.push(s);
    for (const s of monitoredSymbols) if (!next.has(s)) clearedMonitor.push(s);

    monitoredSymbols = next;
    monitoredAt = now;
    monitoredLastError = null;

    if (newlyMonitored.length > 0) {
      logger.warn({ symbols: newlyMonitored, count: newlyMonitored.length }, 'delistMonitor: new at-risk symbols (Monitoring tag)');
      eventBus.emit('delistMonitor:monitoring-added', { symbols: newlyMonitored });
    }
    if (clearedMonitor.length > 0) {
      logger.info({ symbols: clearedMonitor, count: clearedMonitor.length }, 'delistMonitor: at-risk tag cleared');
      eventBus.emit('delistMonitor:monitoring-removed', { symbols: clearedMonitor });
    }
    return monitoredSymbols;
  } catch (err) {
    monitoredLastError = err.message;
    logger.warn({ err: err.message }, 'delistMonitor: marketing list refresh failed (keeping stale cache)');
    return monitoredSymbols;
  }
}

// ─── Delist schedule fetch (Layer 2) ────────────────────
async function refreshDelistSchedule({ force = false } = {}) {
  const now = Date.now();
  if (!force && scheduleAt && (now - scheduleAt) < SCHEDULE_TTL_MS) {
    return delistSchedule;
  }
  try {
    const arr = await binanceRest.getSpotDelistSchedule();
    const next = new Map();
    for (const entry of arr || []) {
      const dt = Number(entry.delistTime);
      if (!Number.isFinite(dt) || dt <= 0) continue;
      const symbols = Array.isArray(entry.symbols) ? entry.symbols : [];
      for (const raw of symbols) {
        const sym = String(raw || '').toUpperCase();
        if (!sym) continue;
        // If same symbol appears multiple times with different dates, take earliest (most urgent)
        const existing = next.get(sym);
        if (!existing || dt < existing.delistTime) {
          next.set(sym, { delistTime: dt, firstSeenAt: existing ? existing.firstSeenAt : now });
        } else if (!existing) {
          next.set(sym, { delistTime: dt, firstSeenAt: now });
        }
      }
    }
    // Diff for logging + events
    const newlyScheduled = [];
    const clearedScheduled = [];
    for (const [sym, info] of next) if (!delistSchedule.has(sym)) newlyScheduled.push({ symbol: sym, delistTime: info.delistTime });
    for (const sym of delistSchedule.keys()) if (!next.has(sym)) clearedScheduled.push(sym);

    delistSchedule = next;
    scheduleAt = now;
    scheduleLastError = null;

    if (newlyScheduled.length > 0) {
      logger.warn({
        count: newlyScheduled.length,
        symbols: newlyScheduled.map((x) => ({ symbol: x.symbol, delistTime: new Date(x.delistTime).toISOString() })),
      }, 'delistMonitor: NEW delist schedule detected');
      // Emit per-symbol event for telegram notifier + bot auto-pause handler
      for (const x of newlyScheduled) {
        eventBus.emit('delistMonitor:scheduled', {
          symbol: x.symbol,
          delistTime: x.delistTime,
          delistDateIso: new Date(x.delistTime).toISOString(),
        });
      }
    }
    if (clearedScheduled.length > 0) {
      logger.info({ symbols: clearedScheduled }, 'delistMonitor: delist schedule cleared (Binance canceled delisting)');
      for (const sym of clearedScheduled) {
        eventBus.emit('delistMonitor:schedule-cleared', { symbol: sym });
        notifiedSymbols.delete(sym);
      }
    }
    return delistSchedule;
  } catch (err) {
    scheduleLastError = err.message;
    logger.warn({ err: err.message }, 'delistMonitor: delist schedule refresh failed (keeping stale cache)');
    return delistSchedule;
  }
}

// ─── Public API ────────────────────────────────────────

/**
 * True if symbol has Binance "Monitoring" tag (early warning).
 * Use as soft filter — bot can still open positions but log warn.
 */
function isAtRisk(symbol) {
  if (!symbol) return false;
  return monitoredSymbols.has(String(symbol).toUpperCase());
}

/**
 * Get delistTime (epoch ms) if symbol is in confirmed delist schedule, else null.
 */
function getDelistTime(symbol) {
  if (!symbol) return null;
  const entry = delistSchedule.get(String(symbol).toUpperCase());
  return entry ? entry.delistTime : null;
}

/**
 * True if delistTime - now <= days (soft BUY block threshold, default 7d).
 */
function willDelistWithin(symbol, days = BLOCK_BUY_DAYS) {
  const dt = getDelistTime(symbol);
  if (!dt) return false;
  return (dt - Date.now()) <= days * 24 * 60 * 60 * 1000;
}

/**
 * True if delistTime has passed (symbol already delisted).
 */
function isDelisted(symbol) {
  const dt = getDelistTime(symbol);
  if (!dt) return false;
  return Date.now() >= dt;
}

/**
 * True if delistTime - now <= FORCE_CLOSE_DAYS (3d) — emergency force-close threshold.
 */
function shouldForceClose(symbol) {
  return willDelistWithin(symbol, FORCE_CLOSE_DAYS);
}

/**
 * Get all currently scheduled symbols (for botManager scanner).
 * Returns Array<{ symbol, delistTime, delistDateIso, daysUntil }>
 */
function getScheduledSymbols() {
  const out = [];
  const now = Date.now();
  for (const [symbol, info] of delistSchedule) {
    out.push({
      symbol,
      delistTime: info.delistTime,
      delistDateIso: new Date(info.delistTime).toISOString(),
      daysUntil: Math.max(0, (info.delistTime - now) / (24 * 60 * 60 * 1000)),
    });
  }
  return out;
}

/**
 * Coin-info helper — returns { isAtRisk, isDelisted, delistTime, delistDateIso, daysUntil } or null.
 * Used by /api/coins/info/:symbol to expose fields to UI.
 */
function getRiskInfoFor(symbol) {
  if (!symbol) return null;
  const sym = String(symbol).toUpperCase();
  const isMonitored = monitoredSymbols.has(sym);
  const dt = delistSchedule.get(sym);
  if (!isMonitored && !dt) return null;
  const now = Date.now();
  return {
    isAtRisk: isMonitored,
    isDelisted: dt ? now >= dt.delistTime : false,
    delistTime: dt ? dt.delistTime : null,
    delistDateIso: dt ? new Date(dt.delistTime).toISOString() : null,
    daysUntil: dt ? Math.max(0, (dt.delistTime - now) / (24 * 60 * 60 * 1000)) : null,
  };
}

/**
 * Mark symbol as notified (for telegram anti-spam latch).
 */
function markNotified(symbol) {
  if (symbol) notifiedSymbols.add(String(symbol).toUpperCase());
}
function wasNotified(symbol) {
  return symbol ? notifiedSymbols.has(String(symbol).toUpperCase()) : false;
}

// ─── Lifecycle ────────────────────────────────────────
let intervalHandle = null;
let running = false;

async function start({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (running) return;
  running = true;
  logger.info({ intervalMs, marketingTtlMs: MARKETING_TTL_MS, scheduleTtlMs: SCHEDULE_TTL_MS }, 'delistMonitor: starting');
  // Immediate first refresh — don't wait interval
  await Promise.allSettled([
    refreshMonitoredSymbols({ force: true }),
    refreshDelistSchedule({ force: true }),
  ]);
  // Periodic tick — re-check TTL + emit diff
  intervalHandle = setInterval(() => {
    Promise.allSettled([
      refreshMonitoredSymbols(),
      refreshDelistSchedule(),
    ]).catch((err) => logger.warn({ err: err.message }, 'delistMonitor: tick refresh failed'));
  }, intervalMs);
  if (intervalHandle.unref) intervalHandle.unref();
}

function stop() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  running = false;
  logger.info('delistMonitor: stopped');
}

function getStatus() {
  return {
    running,
    monitoredCount: monitoredSymbols.size,
    scheduledCount: delistSchedule.size,
    monitoredAt,
    scheduleAt,
    monitoredLastError,
    scheduleLastError,
    blockBuyDays: BLOCK_BUY_DAYS,
    forceCloseDays: FORCE_CLOSE_DAYS,
  };
}

module.exports = {
  start,
  stop,
  // public helpers
  isAtRisk,
  getDelistTime,
  willDelistWithin,
  isDelisted,
  shouldForceClose,
  getScheduledSymbols,
  getRiskInfoFor,
  markNotified,
  wasNotified,
  // refresh (for tests + initial boot)
  refreshMonitoredSymbols,
  refreshDelistSchedule,
  // diagnostics
  getStatus,
  // constants for tests/UI
  BLOCK_BUY_DAYS,
  FORCE_CLOSE_DAYS,
};
