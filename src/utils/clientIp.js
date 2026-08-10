'use strict';

/**
 * FIX-2026-08-10: Extract real client IP from a request — proxy-aware.
 *
 * Why: ก่อนหน้านี้ auth.routes.js เขียน `clientIp()` ฝังในไฟล์เดียว และ
 *       - อ่านแค่ X-Forwarded-For → ถ้าผ่าน Cloudflare Tunnel / nginx โดยไม่ได้ตั้ง XFF
 *         จะได้ 127.0.0.1 ตลอด (เช่น ตอน test ผ่าน SSH tunnel)
 *       - ไม่ handle CF-Connecting-IP / X-Real-IP → ผู้ใช้ที่อยู่หลัง Cloudflare
 *         หรือ nginx ที่ set X-Real-IP จะเห็นแค่ IP ของ proxy
 *       - ซ้ำซ้อนกับที่ loginAudit.js ต้องการใช้งาน → รวมเป็น utility เดียว
 *
 * Headers checked (priority order):
 *   1. CF-Connecting-IP       — Cloudflare
 *   2. X-Real-IP              — nginx default
 *   3. X-Forwarded-For        — leftmost IP (multi-hop proxy chain)
 *   4. req.ip / req.ips[0]    — Express trust-proxy result (set in app.js)
 *   5. req.socket.remoteAddress — fallback (TCP peer)
 *
 * Note on trust proxy:
 *   app.js sets `app.set('trust proxy', 1)` already — that means Express
 *   trusts ONE hop in XFF. So req.ip = leftmost XFF when present.
 *
 * Usage:
 *   const { getClientIp } = require('./utils/clientIp');
 *   const ip = getClientIp(req);
 */

const logger = require('./logger');

/**
 * Extract real client IP. Returns 'unknown' if all sources are empty.
 *
 * @param {object} req — Express request
 * @param {object} [opts]
 * @param {boolean} [opts.debug] — log resolved IP + sources (debug only)
 * @returns {string} IPv4/IPv6 string (max 64 chars)
 */
function getClientIp(req, opts = {}) {
  if (!req) return 'unknown';

  // 1) Cloudflare
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) {
    const v = String(cfIp).trim();
    if (v) return _maybeLog(v, 'cf-connecting-ip', opts);
  }

  // 2) nginx X-Real-IP
  const xRealIp = req.headers['x-real-ip'];
  if (xRealIp) {
    const v = String(xRealIp).trim();
    if (v) return _maybeLog(v, 'x-real-ip', opts);
  }

  // 3) X-Forwarded-For — leftmost IP (original client)
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return _maybeLog(first, 'x-forwarded-for', opts);
  }

  // 4) Express trust-proxy result
  //    req.ips is the populated chain when trust proxy is enabled.
  //    req.ip is the final resolved IP.
  const ipsChain = Array.isArray(req.ips) && req.ips.length > 0 ? req.ips : null;
  if (ipsChain) {
    return _maybeLog(ipsChain[0], 'req.ips[0]', opts);
  }
  if (req.ip) {
    return _maybeLog(String(req.ip).trim(), 'req.ip', opts);
  }

  // 5) TCP peer (last resort)
  const remote = req.socket && req.socket.remoteAddress;
  if (remote) return _maybeLog(String(remote).trim(), 'socket.remoteAddress', opts);

  return 'unknown';
}

function _maybeLog(ip, source, opts) {
  if (opts && opts.debug) {
    logger.debug({ ip, source }, 'clientIp: resolved');
  }
  return ip;
}

module.exports = { getClientIp };