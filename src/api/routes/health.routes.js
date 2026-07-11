'use strict';

const express = require('express');
const healthMonitor = require('../../services/healthMonitor');

const router = express.Router();

// ไม่ต้อง auth — ให้ dashboard ดึงได้เร็วๆ
router.get('/', (req, res) => {
  res.json(healthMonitor.getStatus());
});

module.exports = router;