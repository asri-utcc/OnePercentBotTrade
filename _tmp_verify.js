// Verify live masterConfig cache (simulates what trader.js does on signal)
// Connects to same MongoDB and reads AppConfig
'use strict';
const mongoose = require('mongoose');
const path = require('path');

async function main() {
  const uri = 'mongodb://127.0.0.1:27017/onepercentbottrade';
  await mongoose.connect(uri);

  const AppConfig = require('./src/db/models/AppConfig');
  const cfg = await AppConfig.findOne({ key: 'singleton' }).lean();

  if (!cfg) {
    console.log('NO AppConfig found');
    return;
  }

  console.log('=== Live AppConfig from DB ===');
  console.log('masterDlcEnabled:', cfg.masterDlcEnabled);
  console.log('dlcBaseLossPct:', cfg.dlcBaseLossPct);

  // Simulate masterConfig.getMasterToggles() logic
  const masterDlcEnabled = cfg.masterDlcEnabled === true;
  console.log('');
  console.log('=== Simulated cache state (masterConfig._cache) ===');
  console.log('masterDlcEnabled (after === true check):', masterDlcEnabled);
  console.log('  -> matches masterConfig.js:85: cfg.masterDlcEnabled === true');

  // Also check SOPHUSDT bot
  const Bot = require('./src/db/models/Bot');
  const sophBot = await Bot.findOne({ symbol: 'SOPHUSDT' }).lean();
  console.log('');
  console.log('=== SOPHUSDT bot live state ===');
  console.log('dlcEnabled:', sophBot.dlcEnabled);
  console.log('maxTrades:', sophBot.maxTrades);
  console.log('dlcPrevMaxTrades:', sophBot.dlcPrevMaxTrades);
  console.log('dlcBaseLossPct:', sophBot.dlcBaseLossPct);

  // Decision simulation
  console.log('');
  console.log('=== DLC decision simulation ===');
  const k = 2; // SOPHUSDT has 2 positions currently
  const base = sophBot.dlcBaseLossPct || cfg.dlcBaseLossPct || -10;
  for (let i = 0; i < k; i++) {
    const threshold = base * (k - i);
    console.log(`  position[${i}] threshold = ${base} * (${k} - ${i}) = ${threshold}%`);
  }
  console.log('  -> Layer 3 (new) requires oldest to be < ' + (base * k) + '% OR newer to be < ' + base + '%');

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });