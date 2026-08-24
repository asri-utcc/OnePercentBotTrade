'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit'); // FIX-2026-08-24: HTTP-layer brute-force protection
const config = require('../../../config');
const AppConfig = require('../../db/models/AppConfig');
const crypto = require('../../services/crypto');
const binanceRest = require('../../binance/binanceRest');
const logger = require('../../utils/logger');
const { LoginGuard } = require('../../utils/loginGuard');
// 2026-08-09: Telegram Login (alternative login channel — NOT 2FA)
const telegramOtp = require('../../services/telegramOtp');
const telegramNotifier = require('../../services/telegramNotifier');
// FIX-2026-08-09: connect-mongo v5 `all()` drops _id/expires + returns unserialized session only
//   - ใช้ mongoose.connection.db.collection('sessions') เพื่อเข้าถึง full doc + sid
const sessionStore = require('../../utils/sessionStore');
// FIX-2026-08-09: shared parseDeviceLabel utility (used by sessions + loginAudit)
const { parseDeviceLabel } = require('../../utils/deviceLabel');
// FIX-2026-08-09: log failed login attempts for audit (Sessions Manager → Failed Logins tab)
const loginAudit = require('../../utils/loginAudit');
// FIX-2026-08-09: LoginAttempt model for /api/auth/login-attempts endpoint
const LoginAttempt = require('../../db/models/LoginAttempt');
// FIX-2026-08-10: shared client-IP extraction (CF-Connecting-IP + X-Real-IP + XFF)
const { getClientIp } = require('../../utils/clientIp');

// Brute-force protection สำหรับ /login (สำคัญมากถ้า expose port ออกเน็ต)
const loginGuard = new LoginGuard({
  maxAttempts: config.security.loginMaxAttempts,
  windowMs: config.security.loginWindowMs,
  lockoutMs: config.security.loginLockoutMs,
});

// FIX-2026-08-10: ใช้ shared getClientIp (รองรับ CF-Connecting-IP + X-Real-IP + XFF + req.ip + socket)
function clientIp(req) {
  return getClientIp(req);
}

const router = express.Router();

// FIX-2026-08-24: HTTP-layer brute-force protection (กัน flood ระดับ HTTP ก่อนถึง handler)
//   - ทำงานก่อน loginGuard + bcrypt → ลด CPU burn จาก 1000+ req/s flood
//   - trust proxy ถูกตั้งใน app.js (`app.set('trust proxy', 1)`) → keyGenerator ใช้ XFF/CF-Connecting-IP ถูกต้อง
//   - ตัวเลข generous พอสำหรับ progressive backoff (user fail 5-9 ครั้งใน 60s ยังไม่โดนตัด)
//   - แต่ block flood 100 req/s ได้ทันที
const authLoginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please slow down.' },
});

const authTgRequestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many OTP requests. Please slow down.' },
});

const authTgVerifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many verify attempts. Please slow down.' },
});

const authSetupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many setup attempts. Please slow down.' },
});

// ─── POST /api/auth/setup ─────────────────────────────
// Setup ครั้งแรก: ตั้ง password + Binance API keys (encrypted)
// หลัง setup เสร็จแล้ว endpoint นี้จะถูกปิดถาวร (return 404)
router.post('/setup', authSetupLimiter, async (req, res) => {
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
// FIX-2026-08-09: log failed attempts for /password-sessions.html "Failed Logins" tab
// FIX-2026-08-24: layered brute-force protection — progressive backoff + IP lockout escalation
//   + per-account lockout + Telegram admin alert on lock + UI hints (attemptsRemaining/nextDelayMs)
router.post('/login', authLoginLimiter, async (req, res) => {
  const ip = clientIp(req);
  const userAgent = req.get('user-agent') || '';

  // FIX-2026-08-24: rich status — UI polls this to show "เหลืออีก X ครั้ง" + countdown
  //   Returned on every response (401/429/200) so frontend can sync state after submit
  function statusPayload() {
    return loginGuard.getStatus(ip);
  }

  // Check IP lockout ก่อน — ถ้า IP ถูก lock ไม่ต้องทำ bcrypt เลย (กัน CPU burn)
  const lockStatus = loginGuard.check(ip);
  if (lockStatus.locked) {
    // FIX-2026-08-09: log locked-attempt
    loginAudit.logFailedLoginAttempt({ ip, method: 'password', reason: 'locked', userAgent });
    res.set('Retry-After', String(lockStatus.retryAfterSec));
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${lockStatus.retryAfterSec}s`,
      ...statusPayload(),
    });
  }

  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'password required' });

    const configDoc = await AppConfig.findOne({ key: 'singleton' });
    if (!configDoc || !configDoc.passwordHash) {
      return res.status(400).json({ error: 'Setup not completed' });
    }
    const passwordHash = configDoc.passwordHash;

    // FIX-2026-08-24: per-account lockout — distributed brute-force (หลาย IP ยิง hash เดียวกัน)
    const acctStatus = loginGuard.checkAccount(passwordHash);
    if (acctStatus.locked) {
      loginAudit.logFailedLoginAttempt({ ip, method: 'password', reason: 'locked', userAgent });
      res.set('Retry-After', String(acctStatus.retryAfterSec));
      logger.warn({ ip, hashPrefix: passwordHash.slice(0, 8) + '...' },
        'login: account locked (distributed brute-force signal)');
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${acctStatus.retryAfterSec}s`,
        ...statusPayload(),
      });
    }

    const ok = await bcrypt.compare(password, passwordHash);
    if (!ok) {
      // FIX-2026-08-24: recordFail updates BOTH IP + account counters
      loginGuard.recordFail(ip, passwordHash);
      const fails = loginGuard.check(ip);
      const acctFails = loginGuard.checkAccount(passwordHash);

      // FIX-2026-08-24: if EITHER IP or account just got locked → 429 + Telegram alert
      if (fails.locked || acctFails.locked) {
        const retryAfter = fails.locked ? fails.retryAfterSec : acctFails.retryAfterSec;
        res.set('Retry-After', String(retryAfter));
        logger.warn({
          ip,
          hashPrefix: passwordHash.slice(0, 8) + '...',
          ipLocked: fails.locked,
          acctLocked: acctFails.locked,
          lockoutLevel: fails.lockoutLevel || 0,
        }, 'login: invalid password — locked');
        loginAudit.logFailedLoginAttempt({ ip, method: 'password', reason: 'locked', userAgent });
        // FIX-2026-08-24: Telegram admin alert (best-effort, never blocks)
        _sendLoginLockedAlert({
          ip,
          userAgent,
          ipLockoutLevel: fails.lockoutLevel || 0,
          ipLocked: fails.locked,
          accountLocked: acctFails.locked,
          retryAfterSec: retryAfter,
        });
        return res.status(429).json({
          error: `Too many failed attempts. Try again in ${retryAfterSecFmt(retryAfter)}`,
          ...statusPayload(),
        });
      }

      // FIX-2026-08-10: log wrong-password attempt + attemptedPassword (admin audit)
      loginAudit.logFailedLoginAttempt({
        ip,
        method: 'password',
        reason: 'wrong-password',
        userAgent,
        attemptedPassword: password,
      });
      // FIX-2026-08-24: surface attemptsRemaining + nextDelayMs in 401 body
      //   so frontend can show "เหลืออีก 6 ครั้ง" + "รอ 5s ก่อน"
      return res.status(401).json({
        error: 'Invalid password',
        ...statusPayload(),
      });
    }

    // FIX-2026-08-24: success → reset BOTH IP + account counters
    loginGuard.recordSuccess(ip, passwordHash);
    req.session.authenticated = true;
    // 2026-08-09: stash session metadata
    const now = new Date().toISOString();
    req.session.loginAt = now;
    req.session.lastSeenAt = now;
    req.session.loginIp = ip;
    req.session.userAgent = req.get('user-agent') || '';
    req.session.deviceLabel = parseDeviceLabel(req.session.userAgent);
    res.json({ ok: true, ...statusPayload() });
  } catch (err) {
    logger.error({ err: err.message, ip }, 'login error');
    res.status(500).json({ error: err.message });
  }
});

// FIX-2026-08-24: helper — format seconds → "Xm Ys" for human-readable countdown
function retryAfterSecFmt(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// FIX-2026-08-24: helper — fire Telegram admin alert when IP/account locked
//   Best-effort: never throws, never blocks the response
function _sendLoginLockedAlert({ ip, userAgent, ipLockoutLevel, ipLocked, accountLocked, retryAfterSec }) {
  try {
    // dispatch() awaits; use fire-and-forget (don't block response)
    setImmediate(() => {
      telegramNotifier.sendNow('loginLocked', {
        ip,
        userAgent,
        ipLockoutLevel,
        ipLocked: !!ipLocked,
        accountLocked: !!accountLocked,
        retryAfterSec,
      }).catch((err) => {
        logger.warn({ err: err.message }, 'login: telegram alert failed (non-fatal)');
      });
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'login: telegram alert dispatch failed (non-fatal)');
  }
}

// ─── POST /api/auth/login-telegram/request ─────────────
// 2026-08-09: alternative login channel — generate 6-digit OTP, send via Telegram
//   - ไม่ใช่ 2FA — ใช้แทน password เมื่อลืม
//   - ตรวจสอบ Telegram ตั้งค่า + telegramLogin event เปิดอยู่
//   - ส่ง OTP เข้า chat + set HTTP-only cookie `tg_login_token` (5 min) สำหรับ verify step
// FIX-2026-08-09: log failures (rate-limited / telegram-disabled / event-disabled)
router.post('/login-telegram/request', authTgRequestLimiter, async (req, res) => {
  const ip = clientIp(req);
  const userAgent = req.get('user-agent') || '';
  try {
    const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();
    if (!cfg?.telegramEnabled || !cfg?.telegramBotTokenEnc) {
      loginAudit.logFailedLoginAttempt({ ip, method: 'telegram-otp', reason: 'telegram-disabled', userAgent });
      return res.status(400).json({ error: 'Telegram login ไม่พร้อมใช้งาน — bot ยังไม่ได้ตั้งค่า' });
    }
    if (cfg.telegramEvents?.telegramLogin === false) {
      loginAudit.logFailedLoginAttempt({ ip, method: 'telegram-otp', reason: 'telegram-event-disabled', userAgent });
      return res.status(400).json({ error: 'ปิด Telegram login อยู่ — เปิดใน Settings > Telegram Events' });
    }
    // Generate OTP
    const result = telegramOtp.requestOtp();
    if (!result.ok) {
      loginAudit.logFailedLoginAttempt({ ip, method: 'telegram-otp', reason: 'rate-limited', userAgent });
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
    logger.info({ ip }, 'login-telegram: OTP sent');
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
// FIX-2026-08-09: log OTP failures (token-invalid, wrong, locked, expired, malformed)
router.post('/login-telegram/verify', authTgVerifyLimiter, async (req, res) => {
  const ip = clientIp(req);
  const userAgent = req.get('user-agent') || '';
  try {
    const loginToken = req.cookies?.tg_login_token || req.body?.loginToken;
    if (!loginToken) {
      loginAudit.logFailedLoginAttempt({ ip, method: 'telegram-otp', reason: 'otp-token-invalid', userAgent });
      return res.status(400).json({ error: 'OTP token ไม่ถูกต้อง — กดขอ OTP ใหม่' });
    }
    const code = String(req.body?.code || '').trim();
    // FIX-2026-08-09: malformed input → log + reject
    if (!/^\d{6}$/.test(code)) {
      loginAudit.logFailedLoginAttempt({ ip, method: 'telegram-otp', reason: 'otp-malformed', userAgent });
      return res.status(400).json({ error: 'OTP ต้องเป็นตัวเลข 6 หลัก' });
    }
    const result = telegramOtp.verifyOtp(loginToken, code);
    if (!result.ok) {
      // Map verify-error to audit reason
      const reason = result.retryAfterSec === 900 ? 'otp-locked'
        : result.error && /หมดอายุ/.test(result.error) ? 'otp-expired'
        : 'otp-wrong';
      loginAudit.logFailedLoginAttempt({ ip, method: 'telegram-otp', reason, userAgent });
      if (result.retryAfterSec) res.set('Retry-After', String(result.retryAfterSec));
      return res.status(400).json({ error: result.error, retryAfterSec: result.retryAfterSec });
    }
    // Success — clear cookie, set session
    res.clearCookie('tg_login_token');
    const now = new Date().toISOString();
    req.session.authenticated = true;
    req.session.loginAt = now;
    req.session.lastSeenAt = now;
    req.session.loginIp = ip;
    req.session.userAgent = userAgent;
    req.session.deviceLabel = parseDeviceLabel(userAgent);
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
    // FIX-2026-08-10: sync botActionPassword กับ login password
    //   - ก่อนหน้านี้ config.botActionPassword ถูก cache ตอน startup จาก .env
    //     เลยเปลี่ยน login password แล้ว bot action (create/stop/cancel-cooldown) ยังคงใช้ password เก่า
    //   - ตอนนี้: อัปเดตทั้ง AppConfig (persist) + runtime config (effective ทันที)
    //   - ถ้า user ตั้ง BOT_ACTION_PASSWORD แยกใน .env → ไม่แตะ field นี้ (เคารพการตั้งค่า explicit)
    const envHasSeparateBotPw = !!process.env.BOT_ACTION_PASSWORD;
    if (!envHasSeparateBotPw) {
      // FIX-2026-08-10 (extended): backfill case — ถ้า user เคยเปลี่ยน login password มาก่อน
      //   ที่ fix นี้ถูก deploy จะทำให้ configDoc.botActionPassword ยังว่างอยู่
      //   และ config.botActionPassword จะ fall back ไปใช้ .env DASHBOARD_PASSWORD (ตัวเก่า)
      //   → บังคับให้ user เปลี่ยน password อีกครั้งเพื่อ trigger sync (ครั้งนี้จะเขียนทับ both DB + runtime)
      const wasEmpty = !(configDoc.botActionPassword || '').trim();
      configDoc.botActionPassword = newPassword;
      configDoc.botActionPasswordChangedAt = new Date();
      configDoc.botActionPasswordChangedFromIp = ip;
      config.botActionPassword = newPassword; // runtime mutation — bot.routes.js จะเห็นทันที
      if (wasEmpty) {
        logger.warn(
          { ip },
          'change-password: botActionPassword backfilled (was empty — previous password change predated sync fix)'
        );
      } else {
        logger.info({ ip }, 'change-password: botActionPassword synced (no separate BOT_ACTION_PASSWORD in .env)');
      }
    }
    await configDoc.save();

    let killedCount = 0;
    if (killOthers && req.sessionStore) {
      // FIX-2026-08-09: ใช้ MongoDB collection ตรงๆ (connect-mongo v5 all() drops _id)
      try {
        const docs = await sessionStore.getAllSessionDocs();
        const currentSid = req.sessionID;
        for (const doc of docs) {
          const sid = String(doc._id || '');
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

// ─── POST /api/auth/sync-bot-action-password ──────────
// FIX-2026-08-10: emergency sync — user changes login password BEFORE sync fix deployed
//   → AppConfig.botActionPassword stays empty → runtime falls back to .env DASHBOARD_PASSWORD (old)
//   → unlock-cooldown / stop-bot / etc. still require the OLD password
//
//   This endpoint backfills botActionPassword with the CURRENT login password (without
//   requiring a password change). After calling, unlock-cooldown accepts the login password.
//
//   Body: { currentPassword: string }
//   Requires session auth (already logged in)
router.post('/sync-bot-action-password', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const { currentPassword } = req.body || {};
    if (!currentPassword) {
      return res.status(400).json({ error: 'currentPassword required' });
    }
    const configDoc = await AppConfig.findOne({ key: 'singleton' });
    if (!configDoc) return res.status(400).json({ error: 'Setup not completed' });

    const ok = await bcrypt.compare(currentPassword, configDoc.passwordHash);
    if (!ok) return res.status(401).json({ error: 'currentPassword ไม่ถูกต้อง' });

    // Skip if user explicitly set BOT_ACTION_PASSWORD in .env
    const envHasSeparateBotPw = !!process.env.BOT_ACTION_PASSWORD;
    if (envHasSeparateBotPw) {
      return res.status(400).json({
        error: 'มี BOT_ACTION_PASSWORD ใน .env — ตัว sync จะไม่ override ค่าที่ตั้งไว้',
      });
    }

    const ip = clientIp(req);
    const prevRuntimeLen = (config.botActionPassword || '').length;
    const prevDbLen = (configDoc.botActionPassword || '').length;

    // Persist + mutate runtime
    configDoc.botActionPassword = currentPassword;
    configDoc.botActionPasswordChangedAt = new Date();
    configDoc.botActionPasswordChangedFromIp = ip;
    config.botActionPassword = currentPassword;
    await configDoc.save();

    logger.warn(
      { ip, prevRuntimeLen, prevDbLen },
      'sync-bot-action-password: backfilled (prev pw was cached from .env — login password had drifted)'
    );
    res.json({ ok: true, synced: true });
  } catch (err) {
    logger.warn({ err: err.message }, 'sync-bot-action-password failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/auth/password-info ─────────────────────
// 2026-08-09: Password & Sessions Manager — hint + note + last-changed audit
// FIX-2026-08-10: + botActionPasswordChangedAt/FromIp for "Sync Bot Password" status badge
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
      // FIX-2026-08-10: bot password sync status (UI "Sync Bot Password" section)
      botActionPasswordChangedAt: configDoc.botActionPasswordChangedAt || null,
      botActionPasswordChangedFromIp: configDoc.botActionPasswordChangedFromIp || '',
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

// FIX-2026-08-09: helper functions moved to src/utils/sessionStore.js
//   - shared between auth.routes.js + tests (testable in isolation)

// ─── GET /api/auth/sessions ──────────────────────────
// 2026-08-09 (rev2): fix connect-mongo v5 `all()` drops _id → query MongoDB directly
router.get('/sessions', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const currentSid = req.sessionID;
    const docs = await sessionStore.getAllSessionDocs();
    const out = [];
    for (const doc of docs) {
      const data = sessionStore.unserializeSessionData(doc.session);
      if (!data.authenticated) continue; // skip non-authenticated sessions
      const sid = String(doc._id || ''); // MongoDB _id IS the session ID (computeStorageId is identity by default)
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
//   ฆ่าทุก session ยกเว้น current
// FIX-2026-08-09: ใช้ MongoDB collection ตรงๆ (connect-mongo v5 all() drops _id)
router.post('/sessions/kill-others', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    if (!req.sessionStore) return res.status(503).json({ error: 'Session store not available' });
    const currentSid = req.sessionID;
    const docs = await sessionStore.getAllSessionDocs();
    let killedCount = 0;
    for (const doc of docs) {
      const sid = String(doc._id || '');
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

// ─── GET /api/auth/login-attempts ─────────────────────
// FIX-2026-08-09: list failed login attempts (Password & Sessions Manager → Failed Logins tab)
//   - sort: recent first
//   - filters: limit (default 50, max 200), since (ISO date), method
//   - TTL 30 days (MongoDB auto-delete after that)
// FIX-2026-08-10: + attemptedPassword (admin-only, plaintext) — for audit of leaked old passwords
//   - Masked in UI by default; reveal on click
router.get('/login-attempts', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const filter = {};
    if (req.query.since) {
      const since = new Date(req.query.since);
      if (!isNaN(since.getTime())) filter.at = { $gte: since };
    }
    if (req.query.method && ['password', 'telegram-otp'].includes(req.query.method)) {
      filter.method = req.query.method;
    }
    const docs = await LoginAttempt.find(filter)
      .sort({ at: -1 })
      .limit(limit)
      .lean();
    const attempts = docs.map((d) => ({
      _id: String(d._id),
      at: d.at,
      ip: d.ip,
      method: d.method,
      reason: d.reason,
      userAgent: d.userAgent || '',
      deviceLabel: d.deviceLabel || { browser: 'Unknown', os: 'Unknown', device: 'desktop' },
      // FIX-2026-08-10: plaintext attempted password (only set for password-method wrong-password)
      attemptedPassword: d.attemptedPassword || '',
    }));
    res.json({ attempts, count: attempts.length });
  } catch (err) {
    logger.warn({ err: err.message }, 'GET /api/auth/login-attempts failed');
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
