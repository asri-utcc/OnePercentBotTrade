'use strict';
const fs = require('fs');
const path = require('path');
const envContent = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/onepercentbottrade';
const binanceRest = require('../src/binance/binanceRest');
(async () => {
  const acc = await binanceRest.getAccount({}, { critical: true }).catch((e) => { console.error('getAccount failed:', e.message); process.exit(1); });
  console.log('\n=== Checking problematic base assets on Binance ===');
  const baseAssets = ['QKC','VTHO','GPS','NOM','BICO','ACE','MARSCOIN','SOPH','HEMI'];
  for (const asset of baseAssets) {
    const b = (acc.balances || []).find(x => x.asset === asset);
    const free = parseFloat(b?.free || 0);
    const locked = parseFloat(b?.locked || 0);
    console.log(`  ${asset.padEnd(10)} free=${free.toFixed(4).padStart(14)}  locked=${locked.toFixed(4).padStart(14)}  total=${(free+locked).toFixed(4)}`);
  }
  console.log('\n=== USDT ===');
  const usdt = (acc.balances || []).find(b => b.asset === 'USDT');
  console.log(`  USDT free=${usdt?.free}  locked=${usdt?.locked}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });