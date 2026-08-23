'use strict';

const EventEmitter = require('events');

class EventBus extends EventEmitter {
  constructor() {
    super();
    // FIX-2026-08-22: 100 → 500 — �องรับ 80 bots × 6 listeners ('kline:closed' × 6) + dashboard clients
    //   ก่อนหน้านี้ 100 ไม่พอเมื่อ bots > 17 (17 × 6 = 102 > 100) → MaxListenersExceededWarning ยิงซ้ำ
    //   → listeners สะสมข้าม PM2 restart (SIGKILL crash ฆ่าก่อน stop() ครบ) → fanout burst
    this.setMaxListeners(500); // รองรับ dashboard clients หลายตัว
  }
}

module.exports = new EventBus();