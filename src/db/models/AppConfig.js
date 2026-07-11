'use strict';

const mongoose = require('mongoose');

// Singleton: เก็บแค่ document เดียว (key = 'singleton')
const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'singleton', unique: true },
    // password hash จาก bcrypt (เก็บที่นี่เพื่อ persist ระหว่าง restart)
    passwordHash: { type: String, default: '' },
    passwordSetAt: { type: Date, default: null },

    // Binance API keys (encrypted with AES-256-GCM)
    binanceApiKeyEnc: { type: String, default: '' },       // base64 ciphertext
    binanceApiSecretEnc: { type: String, default: '' },    // base64 ciphertext
    binanceApiKeyIv: { type: String, default: '' },
    binanceApiSecretIv: { type: String, default: '' },
    binanceApiKeyAuthTag: { type: String, default: '' },
    binanceApiSecretAuthTag: { type: String, default: '' },

    useBnbForFees: { type: Boolean, default: false },

    setupCompleted: { type: Boolean, default: false },
    setupAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AppConfig', appConfigSchema);