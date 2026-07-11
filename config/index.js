'use strict';

require('dotenv').config();

const path = require('path');

// Validate required env
function required(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

function optional(name, fallback) {
  const v = process.env[name];
  return (v === undefined || v === '') ? fallback : v;
}

const config = {
  env: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '3000'), 10),
  // Host to bind. '0.0.0.0' = all interfaces (ต้องการตอน forward port ผ่าน router)
  // '127.0.0.1' = localhost only (default ปลอดภัยกว่า)
  host: optional('HOST', '127.0.0.1'),
  logLevel: optional('LOG_LEVEL', 'info'),

  // Auth / session
  sessionSecret: required('SESSION_SECRET'),
  dashboardPassword: optional('DASHBOARD_PASSWORD', ''),
  // Password ที่ต้องใส่เพื่อทำ action อันตราย (สร้าง/ลบ/เปิด/ปิดบอท)
  // ถ้าไม่ตั้ง จะ fallback ไปใช้ dashboardPassword (เพื่อไม่ให้ใช้งานเดิม break)
  // ถ้าไม่ตั้งทั้งคู่ → middleware จะ reject ทุก action อันตราย (force secure)
  botActionPassword: optional('BOT_ACTION_PASSWORD', optional('DASHBOARD_PASSWORD', '')),

  // DB
  mongoUri: optional('MONGODB_URI', 'mongodb://127.0.0.1:27017/onepercentbottrade'),

  // Encryption
  encryptionKey: required('ENCRYPTION_KEY'),

  // Binance
  binance: {
    apiKey: optional('BINANCE_API_KEY', ''),
    apiSecret: optional('BINANCE_API_SECRET', ''),
    useBnbForFees: optional('USE_BNB_FOR_FEES', 'false').toLowerCase() === 'true',
    recvWindow: parseInt(optional('BINANCE_RECV_WINDOW', '5000'), 10),
  },

  // Trading defaults
  defaults: {
    capitalPerTrade: parseFloat(optional('DEFAULT_CAPITAL_PER_TRADE', '10')),
    maxTrades: parseInt(optional('DEFAULT_MAX_TRADES', '10'), 10),
    tpPercent: parseFloat(optional('DEFAULT_TP_PERCENT', '0.1')),
    retryTimeMin: parseInt(optional('DEFAULT_RETRY_TIME_MIN', '1'), 10),
    retryMax: parseInt(optional('DEFAULT_RETRY_MAX', '1'), 10),
    symbol: optional('DEFAULT_SYMBOL', 'BNBUSDT'),
    timeframe: optional('DEFAULT_TIMEFRAME', '5m'),
  },

  // Security: login brute-force protection (only matters if exposed to internet)
  security: {
    loginMaxAttempts: parseInt(optional('LOGIN_MAX_ATTEMPTS', '10'), 10),
    loginWindowMs: parseInt(optional('LOGIN_WINDOW_MS', '900000'), 10), // 15 นาที
    loginLockoutMs: parseInt(optional('LOGIN_LOCKOUT_MS', '900000'), 10), // 15 นาที
  },

  // Paths
  paths: {
    root: path.resolve(__dirname, '..'),
    public: path.resolve(__dirname, '..', 'public'),
  },

  // Binance endpoints
  binanceApi: {
    base: 'https://api.binance.com',
    wsBase: 'wss://stream.binance.com:9443',
    wsUserData: 'wss://stream.binance.com:9443/ws', // legacy listenKey WS (deprecated Feb 2026)
    // WebSocket API (new) — used for user data stream via userDataStream.subscribe.signature
    wsApiBase: 'wss://ws-api.binance.com:9443/ws-api/v3',
  },

  // Binance intervals supported (subset we use; user can extend)
  binanceIntervals: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'],

  // Fee rates (default; ดึงจาก account จริงตอน runtime ได้)
  fees: {
    bnbMaker: 0.00075,   // 0.075%
    bnbTaker: 0.00075,   // 0.075%
    normalMaker: 0.001,  // 0.1%
    normalTaker: 0.001,  // 0.1%
  },
};

module.exports = config;