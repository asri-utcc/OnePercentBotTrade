'use strict';

const express = require('express');
const healthMonitor = require('../../services/healthMonitor');
const positionWatchdog = require('../../services/positionWatchdog');
const delistMonitor = require('../../services/binanceDelistMonitor'); // FIX-2026-08-06
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ไม่ต้อง auth — ให้ dashboard ดึงได้เร็วๆ
router.get('/', (req, res) => {
  const status = healthMonitor.getStatus();
  // FIX-2026-08-03: include watchdog summary so dashboard can show "watchdog last tick Ns ago"
  status.watchdog = positionWatchdog.getStatus();
  // FIX-2026-08-06: include delist monitor summary so dashboard can show "delistMonitor: 3 symbols scheduled"
  status.delistMonitor = delistMonitor.getStatus();
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

// FIX-2026-08-06: Delist Monitor status + scheduled symbols (admin)
router.get('/delist', requireAuth, (req, res) => {
  const status = delistMonitor.getStatus();
  status.scheduledSymbols = delistMonitor.getScheduledSymbols();
  res.json(status);
});

router.post('/delist/refresh', requireAuth, async (req, res) => {
  try {
    await Promise.allSettled([
      delistMonitor.refreshMonitoredSymbols({ force: true }),
      delistMonitor.refreshDelistSchedule({ force: true }),
    ]);
    res.json({ ok: true, status: delistMonitor.getStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;