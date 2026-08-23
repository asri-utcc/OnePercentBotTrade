'use strict';
// FIX-2026-08-09: Verify 1000CAT CB alert — check if CBv2 pattern actually matched
//   and whether ST3 upper-TF same-candle matched (which would have triggered CBv3)
//   - Alert timestamp: 2026-08-09T01:32:38.901Z (= 08:32:38 BKK)
//   - Bot: 1000CAT(bAdd), 3m TF, kcMult=1.2
//   - Upper-TF (TREND_TF_MAP 3m→1h)

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
  const d = new Date(ms);
  // Convert to BKK (UTC+7)
  const bkkMs = ms + (7 * 3600 * 1000);
  const bkkDate = new Date(bkkMs);
  return bkkDate.toISOString().replace('T', ' ').slice(0, 19) + ' BKK';
}

(async () => {
  const symbol = '1000CATUSDT';
  const tf = '3m';
  const trendTF = '1h';
  const alertMs = Date.parse('2026-08-09T01:32:38.901Z'); // 08:32:38 BKK

  // Fetch more candles so we can see context around alert time
  const botKlines = await fetchKlines(symbol, tf, 50);
  const trendKlines = await fetchKlines(symbol, trendTF, 50);

  console.log(`📊 1000CAT CB alert verification`);
  console.log(`Alert: 2026-08-09T01:32:38.901Z (08:32:38 BKK)`);
  console.log(`Bot TF: ${tf} | Trend TF: ${trendTF}`);
  console.log('='.repeat(80));

  // ─── Bot TF analysis ───
  const opens = botKlines.map((k) => k.open);
  const closes = botKlines.map((k) => k.close);
  const highs = botKlines.map((k) => k.high);
  const lows = botKlines.map((k) => k.low);
  const { lower, upper } = signalEngine.computeBgStates({ closes, highs, lows, mult: 1.2 });

  // Find which candle was the one CLOSING around the alert time
  // 3m candle openTime, closeTime = openTime + 3min - 1ms
  // Alert at 08:32:38 — last closed candle is the one whose closeTime <= 08:32:38
  let alertCandleIdx = -1;
  for (let i = 0; i < botKlines.length; i++) {
    const closeTime = botKlines[i].openTime + 3 * 60 * 1000 - 1;
    if (closeTime >= alertMs) {
      alertCandleIdx = i;
      break;
    }
  }
  console.log(`Alert candle (forming at 08:32:38): idx=${alertCandleIdx} ${formatBkk(botKlines[alertCandleIdx].openTime)}`);

  // Print 15 candles centered on alert candle
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

  // Find CBv2 pattern matches in this window
  console.log(`\n🎯 CBv2 pattern check (4 consecutive red below lowerKC) at idx=${alertCandleIdx}:`);
  if (alertCandleIdx >= 3 && signalEngine.isCBv2At(alertCandleIdx, opens, closes, lower)) {
    console.log(`  ✅ CBv2 pattern MATCHES at alert candle!`);
    // Show the 4 candles involved
    for (let j = alertCandleIdx - 3; j <= alertCandleIdx; j++) {
      const k = botKlines[j];
      console.log(`     idx=${j} ${formatBkk(k.openTime)} o=${k.open.toFixed(7)} c=${k.close.toFixed(7)} lowerKC=${lower[j]?.toFixed(7)}`);
    }
  } else {
    console.log(`  ❌ CBv2 pattern does NOT match at alert candle`);
    // Try CB (3 candles)
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

  // Find trend candle CLOSING around alert (or whose closeTime is closest to alert)
  let trendAlertIdx = -1;
  let trendDiff = Infinity;
  for (let i = 0; i < trendKlines.length; i++) {
    const diff = Math.abs(trendKlines[i].openTime - alertMs);
    if (diff < trendDiff) {
      trendDiff = diff;
      trendAlertIdx = i;
    }
  }
  console.log(`\n📈 1h candles around alert (alert trend candle idx=${trendAlertIdx} ${formatBkk(trendKlines[trendAlertIdx].openTime)}):`);
  const tStartIdx = Math.max(0, trendAlertIdx - 5);
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
      `${String(i).padStart(3)} | ${formatBkk(k.openTime)} | o=${k.open.toFixed(7)} h=${k.high.toFixed(7)} l=${k.low.toFixed(7)} c=${k.close.toFixed(7)} | ${isRed ? '🔴' : '🟢'} | upperKC=${tUpper[i]?.toFixed(7) || 'null'} ${st3 ? `⚠️ ST3: ${st3}` : ''}${marker}`
    );
  }

  // ST3 at alert trend candle
  if (trendAlertIdx >= 2) {
    const e1 = signalEngine.isEngulf1BarAt(trendAlertIdx, tOpens, tCloses, tUpper);
    const e2 = signalEngine.isEngulf2BarAt(trendAlertIdx, tOpens, tCloses, tUpper);
    const ss = signalEngine.isShootingStarAt(trendAlertIdx, tOpens, tCloses, tHighs, tLows, tUpper);
    console.log(`\n🎯 ST3 at alert trend candle: ${e1 ? 'engulf1' : e2 ? 'engulf2' : ss ? 'shootingStar' : 'NO MATCH'}`);
  }
})().catch((err) => {
  console.error('Fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
