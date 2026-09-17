'use strict';

// Verify that the waiting_sell_recovery positions are returned by /api/bots/positions
// Args: --faiz or --owner (default owner)

const fs = require('fs');
const path = require('path');
const http = require('http');
const mongoose = require('mongoose');
const axios = require('axios');

const arg = process.argv[2] || '--owner';
const isFaiz = arg === '--faiz';

const envFile = isFaiz ? '.env.faiz' : '.env';
const envContent = fs.readFileSync(path.join(__dirname, '..', envFile), 'utf8');
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.MONGODB_URI = isFaiz
  ? 'mongodb://127.0.0.1:27017/onepercentbottrade_faiz'
  : 'mongodb://127.0.0.1:27017/onepercentbottrade';

const PORT = parseInt(process.env.PORT || (isFaiz ? '2026' : '6015'));
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  // 1. MongoDB direct — what recovery-injected trades exist?
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.collection('trades');
  const rec = await col.find({ recoveryOriginalId: { $exists: true } }).sort({ symbol: 1 }).toArray();
  const byState = {};
  for (const t of rec) (byState[t.state] = byState[t.state] || []).push(t);

  console.log(`\n=== ${arg.replace('--', '')} (port ${PORT}) recovery-injected trades: ${rec.length} ===`);
  for (const [st, arr] of Object.entries(byState)) {
    console.log(`  ${st.padEnd(24)} ${arr.length} trades`);
    for (const t of arr) console.log(`    - ${t.symbol.padEnd(12)} buyPx=${(parseFloat(t.buyPrice)||0).toFixed(6)} sellPx=${(parseFloat(t.sellPrice)||0).toFixed(6)} waitingSince=${t.waitingSince || '-'}`);
  }
  await mongoose.disconnect();

  // 2. Login to the API
  console.log(`\n--- POST /api/auth/login on port ${PORT} ---`);
  const loginResp = await axios.post(`${BASE}/api/auth/login`, {
    password: process.env.DASHBOARD_PASSWORD || '',
  }, { validateStatus: () => true, timeout: 10000 });
  console.log(`login: status=${loginResp.status}`);

  if (loginResp.status !== 200) {
    console.log('Login failed; falling back to DB-direct count for UI verification.');
    return;
  }

  const cookie = loginResp.headers['set-cookie']?.[0]?.split(';')[0] || '';

  // 3. GET /api/bots/positions
  console.log(`\n--- GET /api/bots/positions ---`);
  const posResp = await axios.get(`${BASE}/api/bots/positions`, {
    headers: { Cookie: cookie },
    validateStatus: () => true,
    timeout: 10000,
  });
  console.log(`status=${posResp.status}`);
  if (posResp.status !== 200) {
    console.log(`body=${JSON.stringify(posResp.data).slice(0, 200)}`);
    return;
  }
  const positions = posResp.data?.positions || posResp.data || [];
  const list = Array.isArray(positions) ? positions : Object.values(positions);
  const waiting = list.filter((p) => p.state === 'waiting_sell_recovery');
  const recoverySymbols = rec.map((t) => t.symbol);
  const recoveredInApi = list.filter((p) => recoverySymbols.includes(p.symbol));
  console.log(`\nAPI returned ${list.length} open positions total.`);
  console.log(`  waiting_sell_recovery in API: ${waiting.length}`);
  console.log(`  recovery-injected symbols present in API: ${recoveredInApi.length}/${rec.length}`);
  for (const p of waiting) console.log(`    ✓ ${p.symbol?.padEnd(12)} state=${p.state} buyPrice=${(parseFloat(p.buyPrice)||0).toFixed(6)} target=${(parseFloat(p.sellPrice)||0).toFixed(6)} unrealizedPnL=${p.unrealizedPnL || p.unrealizedPnl || '?'}`);
  for (const p of recoveredInApi) {
    if (p.state !== 'waiting_sell_recovery') console.log(`    · ${p.symbol.padEnd(12)} state=${p.state} (recovered)`);
  }

  // 4. List which recovery-injected symbols are MISSING from the API (still hidden)
  const apiSymbols = new Set(list.map((p) => p.symbol));
  const missing = rec.filter((t) => !apiSymbols.has(t.symbol));
  if (missing.length > 0) {
    console.log(`\n  ✗ MISSING from API:`);
    for (const t of missing) console.log(`    - ${t.symbol} state=${t.state}`);
  } else {
    console.log(`\n  ✅ All ${rec.length} recovery-injected trades visible in /api/bots/positions`);
  }
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
