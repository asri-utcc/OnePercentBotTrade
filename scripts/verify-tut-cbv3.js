'use strict';
// FIX-2026-08-09: Verify TUT CBv3 alert — check if CBv2 pattern + ST3 upper-TF both matched
//   Alert timestamp: 2026-08-09T10:18:55.862Z (= 17:18:55 BKK)
//   Bot: TUT, 3m TF, kcMult=1.2
//   Upper-TF (TREND_TF_MAP 3m→1h)

require('dotenv').config();
const binanceRest = require('../src/binance/binanceRest');
const signalEngine = require('../src/core/signalEngine');

async function fetchKlines(symbol, tf, n) {
  const raw = await binanceRest.getKlines({ symbol, interval: tf, limit: n });
  return raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    closeTime: k[6],
  }));
}

function formatBkk(ms) {
  const bkkMs = ms + (7 * 3600 * 1000);
  const bkkDate = new Date(bkkMs);
  return bkkDate.toISOString().replace('T', ' ').slice(0, 19) + ' BKK';
}

(async () => {
  const symbol = 'TUTUSDT';
  const tf = '3m';
  const trendTF = '1h';
  const alertMs = Date.parse('2026-08-09T10:18:55.862Z'); // 17:18:55 BKK

  const botKlines = await fetchKlines(symbol, tf, 60);
  const trendKlines = await fetchKlines(symbol, trendTF, 60);

  console.log(`📊 TUT CBv3 alert verification`);
  console.log(`Alert: 2026-08-09T10:18:55.862Z (17:18:55 BKK)`);
  console.log(`Bot TF: ${tf} | Trend TF: ${trendTF}`);
  console.log('='.repeat(80));

  // ─── Bot TF analysis ───
  const opens = botKlines.map((k) => k.open);
  const closes = botKlines.map((k) => k.close);
  const highs = botKlines.map((k) => k.high);
  const lows = botKlines.map((k) => k.low);
  const { lower, upper } = signalEngine.computeBgStates({ closes, highs, lows, mult: 1.2 });

  // Find alert candle (candle whose closeTime >= alertMs)
  let alertCandleIdx = -1;
  for (let i = 0; i < botKlines.length; i++) {
    const closeTime = botKlines[i].openTime + 3 * 60 * 1000 - 1;
    if (closeTime >= alertMs) {
      alertCandleIdx = i;
      break;
    }
  }
  console.log(`Alert candle: idx=${alertCandleIdx} ${formatBkk(botKlines[alertCandleIdx].openTime)}`);

  const startIdx = Math.max(0, alertCandleIdx - 8);
  const endIdx = Math.min(botKlines.length - 1, alertCandleIdx + 4);
  console.log(`\n🔥 3m candles around alert (idx ${startIdx}..${endIdx}):`);
  console.log('idx | time (BKK)        | open    | high    | low     | close   | red? | lowerKC');
  for (let i = startIdx; i <= endIdx; i++) {
    const k = botKlines[i];
    const isRed = k.open > k.close;
    const belowLK = k.close < lower[i] && k.open < lower[i];
    const marker = i === alertCandleIdx ? ' ← ALERT' : '';
    console.log(
      `${String(i).padStart(3)} | ${formatBkk(k.openTime)} | ${k.open.toFixed(7)} | ${k.high.toFixed(7)} | ${k.low.toFixed(7)} | ${k.close.toFixed(7)} | ${isRed ? '🔴' : '🟢'}   | ${lower[i]?.toFixed(7) || 'null'}${belowLK ? ' ⚠️' : ''}${marker}`
    );
  }

  // CBv2 = 4 consecutive red below lowerKC (isCBv2At = isCBAt(i) AND isCBAt(i-1))
  console.log(`\n🎯 CBv2 pattern check at idx=${alertCandleIdx}:`);
  const cbv2Match = alertCandleIdx >= 1 && signalEngine.isCBv2At(alertCandleIdx, opens, closes, lower);
  if (cbv2Match) {
    console.log(`  ✅ CBv2 pattern MATCHES at alert candle!`);
    for (let j = alertCandleIdx - 3; j <= alertCandleIdx; j++) {
      const k = botKlines[j];
      console.log(`     idx=${j} ${formatBkk(k.openTime)} o=${k.open.toFixed(7)} c=${k.close.toFixed(7)} lowerKC=${lower[j]?.toFixed(7)}`);
    }
  } else {
    console.log(`  ❌ CBv2 pattern does NOT match at alert candle`);
    if (alertCandleIdx >= 2 && signalEngine.isCBAt(alertCandleIdx, opens, closes, lower)) {
      console.log(`     (but isCBAt/3-candle CB DOES match)`);
    }
  }

  // ─── Trend TF analysis ───
  const tOpens = trendKlines.map((k) => k.open);
  const tCloses = trendKlines.map((k) => k.close);
  const tHighs = trendKlines.map((k) => k.high);
  const tLows = trendKlines.map((k) => k.low);
  const { upper: tUpper } = signalEngine.computeBgStates({ closes: tCloses, highs: tHighs, lows: tLows, mult: 1.2 });

  let trendAlertIdx = -1;
  let trendDiff = Infinity;
  for (let i = 0; i < trendKlines.length; i++) {
    const diff = Math.abs(trendKlines[i].openTime - alertMs);
    if (diff < trendDiff) {
      trendDiff = diff;
      trendAlertIdx = i;
    }
  }
  console.log(`\n📈 1h candles around alert (trend candle idx=${trendAlertIdx} ${formatBkk(trendKlines[trendAlertIdx].openTime)}):`);
  const tStartIdx = Math.max(0, trendAlertIdx - 4);
  const tEndIdx = Math.min(trendKlines.length - 1, trendAlertIdx + 1);
  for (let i = tStartIdx; i <= tEndIdx; i++) {
    const k = trendKlines[i];
    const isRed = k.open > k.close;
    const e1 = signalEngine.isEngulf1BarAt(i, tOpens, tCloses, tUpper);
    const e2 = signalEngine.isEngulf2BarAt(i, tOpens, tCloses, tUpper);
    const ss = signalEngine.isShootingStarAt(i, tOpens, tCloses, tHighs, tLows, tUpper);
    const st3 = e1 ? 'engulf1' : e2 ? 'engulf2' : ss ? 'shootingStar' : '';
    const marker = i === trendAlertIdx ? ' ← ALERT trend candle' : '';
    console.log(
      `${String(i).padStart(3)} | ${formatBkk(k.openTime)} | o=${k.open.toFixed(7)} h=${k.high.toFixed(7)} l=${k.high.toFixed(7)} c=${k.close.toFixed(7)} | ${isRed ? '🔴' : '🟢'} | upperKC=${tUpper[i]?.toFixed(7) || 'null'} ${st3 ? `⚠️ ST3: ${st3}` : ''}${marker}`
    );
  }

  if (trendAlertIdx >= 2) {
    const e1 = signalEngine.isEngulf1BarAt(trendAlertIdx, tOpens, tCloses, tUpper);
    const e2 = signalEngine.isEngulf2BarAt(trendAlertIdx, tOpens, tCloses, tUpper);
    const ss = signalEngine.isShootingStarAt(trendAlertIdx, tOpens, tCloses, tHighs, tLows, tUpper);
    console.log(`\n🎯 ST3 at alert trend candle: ${e1 ? 'engulf1' : e2 ? 'engulf2' : ss ? 'shootingStar' : 'NO MATCH'}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log(`🏁 VERDICT: ${cbv2Match ? 'CBv2 ✅' : 'CBv2 ❌'} → CBv3 fire ${cbv2Match ? 'JUSTIFIED' : 'UNJUSTIFIED'}`);
})().catch((err) => {
  console.error('Fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});