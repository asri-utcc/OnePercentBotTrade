'use strict';

const express = require('express');
const healthMonitor = require('../../services/healthMonitor');
const positionWatchdog = require('../../services/positionWatchdog');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ไม่ต้อง auth — ให้ dashboard ดึงได้เร็วๆ
router.get('/', (req, res) => {
  const status = healthMonitor.getStatus();
  // FIX-2026-08-03: include watchdog summary so dashboard can show "watchdog last tick Ns ago"
  status.watchdog = positionWatchdog.getStatus();
  res.json(status);
});

// FIX-2026-08-03: Position Watchdog status + manual trigger (admin)
router.get('/watchdog', requireAuth, (req, res) => {
  res.json(positionWatchdog.getStatus());
});

router.post('/watchdog/run', requireAuth, async (req, res) => {
  try {
    const stats = await positionWatchdog.runOnce();
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;