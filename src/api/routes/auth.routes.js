'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../../../config');
const AppConfig = require('../../db/models/AppConfig');
const crypto = require('../../services/crypto');
const binanceRest = require('../../binance/binanceRest');
const logger = require('../../utils/logger');

const router = express.Router();

// ─── POST /api/auth/setup ─────────────────────────────
// Setup ครั้งแรก: ตั้ง password + Binance API keys (encrypted)
router.post('/setup', async (req, res) => {
  try {
    const { password, binanceApiKey, binanceApiSecret, useBnbForFees } = req.body || {};

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'password ต้องยาวอย่างน้อย 6 ตัวอักษร' });
    }

    let configDoc = await AppConfig.findOne({ key: 'singleton' });
    if (!configDoc) configDoc = new AppConfig({ key: 'singleton' });
    if (configDoc.setupCompleted) {
      return res.status(400).json({ error: 'Setup already completed' });
    }

    configDoc.passwordHash = await bcrypt.hash(password, 10);
    configDoc.passwordSetAt = new Date();

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
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err: err.message }, 'setup failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/auth/status ─────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const configDoc = await AppConfig.findOne({ key: 'singleton' });
    const setupCompleted = !!(configDoc && configDoc.setupCompleted);
    const authenticated = !!(req.session && req.session.authenticated);
    res.json({ setupCompleted, authenticated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/auth/login ─────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'password required' });

    const configDoc = await AppConfig.findOne({ key: 'singleton' });
    if (!configDoc || !configDoc.passwordHash) {
      return res.status(400).json({ error: 'Setup not completed' });
    }

    const ok = await bcrypt.compare(password, configDoc.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid password' });

    req.session.authenticated = true;
    res.json({ ok: true });
  } catch (err) {
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
router.post('/change-password', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'newPassword ต้องยาวอย่างน้อย 6 ตัวอักษร' });
    }
    const configDoc = await AppConfig.findOne({ key: 'singleton' });
    if (!configDoc) return res.status(400).json({ error: 'Setup not completed' });

    if (currentPassword) {
      const ok = await bcrypt.compare(currentPassword, configDoc.passwordHash);
      if (!ok) return res.status(401).json({ error: 'currentPassword ไม่ถูกต้อง' });
    }

    configDoc.passwordHash = await bcrypt.hash(newPassword, 10);
    configDoc.passwordSetAt = new Date();
    await configDoc.save();

    res.json({ ok: true });
  } catch (err) {
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