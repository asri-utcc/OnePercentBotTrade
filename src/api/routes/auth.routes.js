'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../../../config');
const AppConfig = require('../../db/models/AppConfig');
const crypto = require('../../services/crypto');
const binanceRest = require('../../binance/binanceRest');
const logger = require('../../utils/logger');
const { LoginGuard } = require('../../utils/loginGuard');
// 2026-08-09: Telegram Login (alternative login channel — NOT 2FA)
const telegramOtp = require('../../services/telegramOtp');
const telegramNotifier = require('../../services/telegramNotifier');

// Brute-force protection สำหรับ /login (สำคัญมากถ้า expose port ออกเน็ต)
const loginGuard = new LoginGuard({
  maxAttempts: config.security.loginMaxAttempts,
  windowMs: config.security.loginWindowMs,
  lockoutMs: config.security.loginLockoutMs,
});

// Helper: extract client IP จาก request (รองรับ X-Forwarded-For ตอน reverse proxy)
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.socket.remoteAddress || 'unknown';
}

// 2026-08-09: device label parser — best-effort จาก User-Agent
//   ใช้สำหรับแสดง�ลในหน้า Sessions Manager ("Chrome on Windows", "Safari on iPhone")
//   ไม่ต้องแม่น — แค่พอให้ user รู้ว่า device ไหน
function parseDeviceLabel(ua) {
  if (!ua || typeof ua !== 'string') return { browser: 'Unknown', os: 'Unknown', device: 'desktop' };
  const s = ua;
  // Browser
  let browser = 'Unknown';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/Chrome\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = 'Safari';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/curl|wget|http\.request/i.test(s)) browser = 'CLI';
  // OS (ลำดับสำคัญ: iPhone/iPad ต้องเช็คก่อน Mac OS X เพราะ iPad UA มี "Mac OS X" อยู่ใน string)
  let os = 'Unknown';
  if (/Windows NT/.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iOS/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';
  // Device type (iPad ก่อน Android เพราะ iPad UA มี "Mobile" อยู่ใน string)
  let device = 'desktop';
  if (/iPad/.test(s)) device = 'tablet';
  else if (/iPhone/.test(s)) device = 'phone';
  else if (/Android/.test(s) && !/Mobile/.test(s)) device = 'tablet';
  else if (/Android/.test(s)) device = 'phone';
  else if (/Mobile/.test(s)) device = 'phone';
  return { browser, os, device };
}

const router = express.Router();

// ─── POST /api/auth/setup ─────────────────────────────
// Setup ครั้งแรก: ตั้ง password + Binance API keys (encrypted)
// หลัง setup เสร็จแล้ว endpoint นี้จะถูกปิดถาวร (return 404)
router.post('/setup', async (req, res) => {
  try {
    // เช็คก่อนว่า setup เสร็จยัง — ถ้าใช่ ไม่ต้องเปิดเผยว่า�ี route นี้อยู่
    const existing = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (existing && existing.setupCompleted) {
      return res.status(404).json({ error: 'Not found' });
    }

    const { password, binanceApiKey, binanceApiSecret, useBnbForFees } = req.body || {};

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'password ต้องยาวอย่างน้อย 6 ตัวอักษร' });
    }

    let configDoc = await AppConfig.findOne({ key: 'singleton' });
    if (!configDoc) configDoc = new AppConfig({ key: 'singleton' });
    if (configDoc.setupCompleted) {
      return res.status(404).json({ error: 'Not found' });
    }

    configDoc.passwordHash = await bcrypt.hash(password, 10);
    configDoc.passwordSetAt = new Date();
    configDoc.passwordLastChangedAt = new Date();
    configDoc.passwordLastChangedFromIp = clientIp(req);

    if (binanceApiKey && binanceApiSecret) {
      const encKey = crypto.encrypt(binanceApiKey);
      const encSec = crypto.encrypt(binanceApiSecret);
      configDoc.binanceApiKeyEnc = encKey.ciphertext;
      configDoc.binanceApiKeyIv = encKey.iv;
      configDoc.binanceApiKeyAuthTag = encKey.authTag;
      configDoc.binanceApiSecretEnc = encSec.ciphertext;
      configDoc.binanceApiSecretIv = encSec.iv;
      configDoc.binanceApiSecretAuthTag = encSec.authTag;
    }
    if (typeof useBnbForFees === 'boolean') {
      configDoc.useBnbForFees = useBnbForFees;
    }
    configDoc.setupCompleted = true;
    configDoc.setupAt = new Date();

    await configDoc.save();

    req.session.authenticated = true;
    // 2026-08-09: stash session metadata for Sessions Manager
    req.session.loginAt = new Date().toISOString();
    req.session.lastSeenAt = new Date().toISOString();
    req.session.loginIp = clientIp(req);
    req.session.userAgent = req.get('user-agent') || '';
    req.session.deviceLabel = parseDeviceLabel(req.session.userAgent);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err: err.message }, 'setup failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/auth/status ─────────────────────────────
// 2026-08-09: expose `telegramLoginEnabled` for login.html ที่จะโชว์/ซ่อน Telegram login section
router.get('/status', async (req, res) => {
  try {
    const configDoc = await AppConfig.findOne({ key: 'singleton' });
    const setupCompleted = !!(configDoc && configDoc.setupCompleted);
    const authenticated = !!(req.session && req.session.authenticated);
    const telegramLoginEnabled = !!(
      configDoc &&
      configDoc.telegramEnabled &&
      configDoc.telegramBotTokenEnc &&
      (configDoc.telegramEvents?.telegramLogin !== false)
    );
    res.json({ setupCompleted, authenticated, telegramLoginEnabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/auth/login ─────────────────────────────
router.post('/login', async (req, res) => {
  const ip = clientIp(req);

  // Check lockout ก่อน — ถ้า IP ถูก lock ไม่ต้องทำ bcrypt เลย (กัน CPU burn)
  const lockStatus = loginGuard.check(ip);
  if (lockStatus.locked) {
    res.set('Retry-After', String(lockStatus.retryAfterSec));
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${lockStatus.retryAfterSec}s`,
    });
  }

  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'password required' });

    const configDoc = await AppConfig.findOne({ key: 'singleton' });
    if (!configDoc || !configDoc.passwordHash) {
      return res.status(400).json({ error: 'Setup not completed' });
    }

    const ok = await bcrypt.compare(password, configDoc.passwordHash);
    if (!ok) {
      loginGuard.recordFail(ip);
      const fails = loginGuard.check(ip);
      if (fails.locked) {
        res.set('Retry-After', String(fails.retryAfterSec));
        logger.warn({ ip }, 'login: invalid password — IP locked');
        return res.status(429).json({
          error: `Too many failed attempts. Try again in ${fails.retryAfterSec}s`,
        });
      }
      return res.status(401).json({ error: 'Invalid password' });
    }

    loginGuard.recordSuccess(ip);
    req.session.authenticated = true;
    // 2026-08-09: stash session metadata
    const now = new Date().toISOString();
    req.session.loginAt = now;
    req.session.lastSeenAt = now;
    req.session.loginIp = ip;
    req.session.userAgent = req.get('user-agent') || '';
    req.session.deviceLabel = parseDeviceLabel(req.session.userAgent);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err: err.message, ip }, 'login error');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/auth/login-telegram/request ─────────────
// 2026-08-09: alternative login channel — generate 6-digit OTP, send via Telegram
//   - ไม่ใช่ 2FA — ใช้แทน password เมื่อลืม
//   - ตรวจสอบ Telegram ตั้งค่า + telegramLogin event เปิดอยู่
//   - ส่ง OTP เข้า chat + set HTTP-only cookie `tg_login_token` (5 min) สำหรับ verify step
router.post('/login-telegram/request', async (req, res) => {
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (!cfg?.telegramEnabled || !cfg?.telegramBotTokenEnc) {
      return res.status(400).json({ error: 'Telegram login ไม่พร้อมใช้งาน — bot ยังไม่ได้ตั้งค่า' });
    }
    if (cfg.telegramEvents?.telegramLogin === false) {
      return res.status(400).json({ error: 'ปิด Telegram login อยู่ — เปิดใน Settings > Telegram Events' });
    }
    // Generate OTP
    const result = telegramOtp.requestOtp();
    if (!result.ok) {
      if (result.retryAfterSec) res.set('Retry-After', String(result.retryAfterSec));
      return res.status(429).json({ error: result.error, retryAfterSec: result.retryAfterSec });
    }
    // Send via Telegram (best-effort — failure here invalidates the token)
    try {
      await telegramNotifier.sendNow('telegramLogin', { code: result.code, expiresInMin: 5 });
    } catch (e) {
      logger.warn({ err: e.message }, 'login-telegram: sendNow failed');
      return res.status(502).json({ error: 'ส่ง OTP ผ่าน Telegram ไม่สำเร็จ' });
    }
    // Set short-lived HTTP-only cookie carrying loginToken
    res.cookie('tg_login_token', result.loginToken, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 5 * 60 * 1000, // 5 min
      secure: false, // dev (http) — production should set up TLS termination
    });
    logger.info({ ip: clientIp(req) }, 'login-telegram: OTP sent');
    res.json({ ok: true, expiresInSec: result.expiresInSec });
  } catch (err) {
    logger.error({ err: err.message }, 'login-telegram request error');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/auth/login-telegram/verify ──────────────
// 2026-08-09: verify OTP, complete login (set session.authenticated=true)
//   - loginToken จาก cookie หรือ body (cookie preferred — more secure)
//   - success → clear cookie + set session + loginGuard.recordSuccess
router.post('/login-telegram/verify', async (req, res) => {
  try {
    const loginToken = req.cookies?.tg_login_token || req.body?.loginToken;
    if (!loginToken) {
      return res.status(400).json({ error: 'OTP token ไม่ถูกต้อง — กดขอ OTP ใหม่' });
    }
    const code = String(req.body?.code || '').trim();
    const result = telegramOtp.verifyOtp(loginToken, code);
    if (!result.ok) {
      if (result.retryAfterSec) res.set('Retry-After', String(result.retryAfterSec));
      return res.status(400).json({ error: result.error, retryAfterSec: result.retryAfterSec });
    }
    // Success — clear cookie, set session
    res.clearCookie('tg_login_token');
    const ip = clientIp(req);
    const now = new Date().toISOString();
    req.session.authenticated = true;
    req.session.loginAt = now;
    req.session.lastSeenAt = now;
    req.session.loginIp = ip;
    req.session.userAgent = req.get('user-agent') || '';
    req.session.deviceLabel = parseDeviceLabel(req.session.userAgent);
    // 2026-08-09: audit trail — loginMethod แยก password vs telegram-otp
    req.session.loginMethod = 'telegram-otp';
    // Reset brute-force guard for this IP (legitimate login)
    loginGuard.recordSuccess(ip);
    logger.info({ ip }, 'login-telegram: success');
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err: err.message }, 'login-telegram verify error');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/auth/logout ────────────────────────────
router.post('/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(() => {});
  }
  res.json({ ok: true });
});

// ─── GET /api/auth/me ─────────────────────────────────
router.get('/me', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ─── POST /api/auth/change-password ───────────────────
// 2026-08-09 (extended): �ับ option `killOthers` เพื่อบังคับ logout ทุก device อื่น
//   - track passwordLastChangedAt + passwordLastChangedFromIp
//   - ถ้า killOthers → เรียก sessionStore.destroy(sid) ยกเว้น current session
router.post('/change-password', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, killOthers } = req.body || {};
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'newPassword ต้องยาวอย่างน้อย 6 �ัวอักษร' });
    }
    const configDoc = await AppConfig.findOne({ key: 'singleton' });
    if (!configDoc) return res.status(400).json({ error: 'Setup not completed' });

    if (currentPassword) {
      const ok = await bcrypt.compare(currentPassword, configDoc.passwordHash);
      if (!ok) return res.status(401).json({ error: 'currentPassword ไม่ถูกต้อง' });
    }

    const ip = clientIp(req);
    configDoc.passwordHash = await bcrypt.hash(newPassword, 10);
    configDoc.passwordSetAt = new Date();
    configDoc.passwordLastChangedAt = new Date();
    configDoc.passwordLastChangedFromIp = ip;
    await configDoc.save();

    let killedCount = 0;
    if (killOthers && req.sessionStore) {
      // ฆ่าทุก session ยกเว้น current
      try {
        const allSids = await new Promise((resolve, reject) => {
          req.sessionStore.all((err, sessions) => {
            if (err) return reject(err);
            resolve((sessions || []).map((s) => s.id || s._id || s.sessionID));
          });
        });
        const currentSid = req.sessionID;
        for (const sid of allSids) {
          if (!sid || sid === currentSid) continue;
          await new Promise((resolve) => {
            req.sessionStore.destroy(sid, () => resolve());
          });
          killedCount++;
        }
        logger.info({ ip, killedCount }, 'change-password: killed other sessions');
      } catch (e) {
        logger.warn({ err: e.message }, 'change-password: kill-others failed (non-fatal)');
      }
    }

    res.json({ ok: true, killedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/auth/password-info ─────────────────────
// 2026-08-09: Password & Sessions Manager — hint + note + last-changed audit
router.get('/password-info', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const configDoc = await AppConfig.findOne({ key: 'singleton' });
    if (!configDoc) return res.json({
      hint: '', note: '', lastChangedAt: null, lastChangedFromIp: '',
    });
    res.json({
      hint: configDoc.passwordHint || '',
      note: configDoc.passwordNote || '',
      lastChangedAt: configDoc.passwordLastChangedAt || configDoc.passwordSetAt || null,
      lastChangedFromIp: configDoc.passwordLastChangedFromIp || '',
      passwordSetAt: configDoc.passwordSetAt || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/auth/password-info ─────────────────────
//   อัปเดต hint + note เท่านั้น (ไม่เปลี่ยน password)
//   - whitelist: { passwordHint: string (max 500), passwordNote: string (max 1000) }
router.put('/password-info', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const configDoc = await AppConfig.findOne({ key: 'singleton' });
    if (!configDoc) return res.status(400).json({ error: 'Setup not completed' });

    const set = {};
    if (typeof req.body.passwordHint === 'string') {
      const v = req.body.passwordHint.slice(0, 500);
      set.passwordHint = v;
    }
    if (typeof req.body.passwordNote === 'string') {
      const v = req.body.passwordNote.slice(0, 1000);
      set.passwordNote = v;
    }
    if (Object.keys(set).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    const updated = await AppConfig.findOneAndUpdate(
      { key: 'singleton' },
      { $set: set },
      { new: true }
    ).lean();
    res.json({
      ok: true,
      hint: updated.passwordHint || '',
      note: updated.passwordNote || '',
      lastChangedAt: updated.passwordLastChangedAt || updated.passwordSetAt || null,
      lastChangedFromIp: updated.passwordLastChangedFromIp || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/auth/sessions ──────────────────────────
// 2026-08-09: Password & Sessions Manager — list active sessions
//   - ใช้ req.sessionStore.all() (express-session store interface)
//   - connect-mongo: each entry has { _id, session, expires }
//   - filter: เฉพาะ session.authenticated === true
//   - แต่ละ entry มี currentSid flag (== req.sessionID)
router.get('/sessions', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    if (!req.sessionStore) return res.status(503).json({ error: 'Session store not available' });
    const currentSid = req.sessionID;
    const sessions = await new Promise((resolve, reject) => {
      req.sessionStore.all((err, list) => {
        if (err) return reject(err);
        resolve(list || []);
      });
    });
    const out = [];
    for (const s of sessions) {
      const data = s.session || {};
      if (!data.authenticated) continue; // skip non-authenticated sessions
      const sid = s.id || s._id || data.id || '';
      const userAgent = data.userAgent || '';
      const deviceLabel = data.deviceLabel || parseDeviceLabel(userAgent);
      out.push({
        sid,
        isCurrent: sid === currentSid,
        loginAt: data.loginAt || null,
        lastSeenAt: data.lastSeenAt || null,
        loginIp: data.loginIp || 'unknown',
        userAgent,
        deviceLabel,
      });
    }
    // sort: current first, then by lastSeenAt desc
    out.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      const ta = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
      const tb = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
      return tb - ta;
    });
    res.json({ sessions: out, currentSid });
  } catch (err) {
    logger.warn({ err: err.message }, 'GET /api/auth/sessions failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/auth/sessions/:sid ──────────────────
//   ฆ่า session เฉพาะ (ยกเว้น current — ป้องกัน user ลบตัวเองโดยไม่ตั้งใจ)
//   ใช้ req.sessionStore.destroy(sid)
router.delete('/sessions/:sid', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const sid = String(req.params.sid || '');
    if (!sid) return res.status(400).json({ error: 'sid required' });
    if (sid === req.sessionID) {
      return res.status(400).json({ error: 'ไม่สามารถลบ session ปัจจุบันได้ — ใช้ปุ่ม Logout แทน' });
    }
    if (!req.sessionStore) return res.status(503).json({ error: 'Session store not available' });
    await new Promise((resolve, reject) => {
      req.sessionStore.destroy(sid, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    logger.info({ sid, by: req.sessionID }, 'session killed via Sessions Manager');
    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err: err.message, sid: req.params.sid }, 'DELETE /api/auth/sessions/:sid failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/auth/sessions/kill-others ─────────────
//   ฆ่าทุก session ยกเ�้น current
router.post('/sessions/kill-others', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    if (!req.sessionStore) return res.status(503).json({ error: 'Session store not available' });
    const currentSid = req.sessionID;
    const all = await new Promise((resolve, reject) => {
      req.sessionStore.all((err, list) => {
        if (err) return reject(err);
        resolve(list || []);
      });
    });
    let killedCount = 0;
    for (const s of all) {
      const sid = s.id || s._id || s.session?.id || '';
      if (!sid || sid === currentSid) continue;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        req.sessionStore.destroy(sid, () => resolve());
      });
      killedCount++;
    }
    logger.info({ killedCount, by: currentSid }, 'sessions: kill-others');
    res.json({ ok: true, killedCount });
  } catch (err) {
    logger.warn({ err: err.message }, 'POST /api/auth/sessions/kill-others failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/auth/api-keys ───────────────────────────
// อัปเดต API keys (ต้อง authenticated)
router.put('/api-keys', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const { binanceApiKey, binanceApiSecret, useBnbForFees } = req.body || {};
    const configDoc = await AppConfig.findOne({ key: 'singleton' });
    if (!configDoc) return res.status(400).json({ error: 'Setup not completed' });

    if (binanceApiKey && binanceApiSecret) {
      const encKey = crypto.encrypt(binanceApiKey);
      const encSec = crypto.encrypt(binanceApiSecret);
      configDoc.binanceApiKeyEnc = encKey.ciphertext;
      configDoc.binanceApiKeyIv = encKey.iv;
      configDoc.binanceApiKeyAuthTag = encKey.authTag;
      configDoc.binanceApiSecretEnc = encSec.ciphertext;
      configDoc.binanceApiSecretIv = encSec.iv;
      configDoc.binanceApiSecretAuthTag = encSec.authTag;
    }
    if (typeof useBnbForFees === 'boolean') {
      configDoc.useBnbForFees = useBnbForFees;
    }
    await configDoc.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/auth/api-keys/status ────────────────────
router.get('/api-keys/status', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const configDoc = await AppConfig.findOne({ key: 'singleton' });
    if (!configDoc) return res.json({ configured: false });
    const has = !!(configDoc.binanceApiKeyEnc && configDoc.binanceApiSecretEnc);
    res.json({
      configured: has,
      useBnbForFees: configDoc.useBnbForFees,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
