'use strict';

/**
 * 2026-08-19: Wallet Reserve — shared cached reader for AppConfig.walletReserveUsdt
 *
 * Used by:
 *   - src/core/trader.js balance pre-check (per BUY attempt)
 *   - src/api/routes/wallet.routes.js (GET /api/wallet/reserve)
 *
 * Why cache?
 *   - Trader calls this every BUY attempt → avoid hitting MongoDB every time
 *   - 10s in-process TTL is enough since user only changes reserve manually
 *     → no race window concerns within 10s
 *   - On write path (PUT /api/wallet/reserve) → invalidateCache() forces next
 *     read to re-fetch from DB immediately (no stale reserve after save)
 *
 * Fallback safety:
 *   - AppConfig.findOne() throws or returns null → return 0 (treat as no reserve)
 *   - Negative or non-numeric values → return 0 (defensive)
 *   - Above schema max (1,000,000) → return schema max (clamp)
 */

const CACHE_TTL_MS = 10 * 1000;
const MAX_RESERVE = 1_000_000;

let _cachedValue = null;
let _cachedAt = 0;
let _inflight = null;

function _clampToValidNumber(v) {
  if (v == null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_RESERVE, n);
}

/**
 * Read current reserve from AppConfig (with 10s cache).
 * @returns {Promise<number>} reserve in USDT (0 if unset / error)
 */
async function getReserveUsdt() {
  const now = Date.now();
  if (_cachedValue != null && (now - _cachedAt) < CACHE_TTL_MS) {
    return _cachedValue;
  }
  if (_inflight) {
    // de-duplicate concurrent reads — wait for the in-flight fetch
    try {
      return await _inflight;
    } catch (_) {
      return _cachedValue != null ? _cachedValue : 0;
    }
  }
  _inflight = (async () => {
    let cfg = null;
    let fetchFailed = false;
    try {
      const AppConfig = require('../db/models/AppConfig');
      const result = AppConfig.findOne({ key: 'singleton' });
      // result may be a Mongoose Query (has .lean()) or a Promise (mock / future API)
      // Wrap .lean() defensively — never throw out of this block.
      let leanable;
      try { leanable = result && typeof result.lean === 'function' ? result.lean() : result; }
      catch (_) { leanable = result; }
      cfg = await Promise.resolve(leanable);
    } catch (innerErr) {
      cfg = null;
      fetchFailed = true;
    }
    try {
      // On fetch failure: do NOT cache (allow retry on next tick)
      //   - reason: if DB has reserve=50 but throws momentarily, we'd cache 0
      //     and the trader would suddenly spend USDT that should be reserved
      if (fetchFailed) {
        _cachedValue = null;
        _cachedAt = 0;
        return 0;
      }
      const raw = cfg ? cfg.walletReserveUsdt : 0;
      _cachedValue = _clampToValidNumber(raw);
      _cachedAt = Date.now();
      return _cachedValue;
    } catch (err) {
      // safety net — should never reach here, but if it does, fail-safe to 0
      _cachedValue = null;
      _cachedAt = 0;
      return 0;
    } finally {
      _inflight = null;
    }
  })();
  // Attach a defensive .catch so an unhandled rejection never crashes the process
  _inflight.catch(() => { _inflight = null; });
  return _inflight;
}

/**
 * Force next read to re-fetch from DB (call this after PUT /api/wallet/reserve).
 */
function invalidateCache() {
  _cachedValue = null;
  _cachedAt = 0;
  _inflight = null;
}

module.exports = {
  getReserveUsdt,
  invalidateCache,
  MAX_RESERVE,
  CACHE_TTL_MS,
};