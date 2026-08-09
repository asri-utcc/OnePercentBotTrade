'use strict';
// FIX-2026-08-09: Scan CBv3 across all bots — look back 24h (replay klines)
//   - For each bot: fetch (1h klines × 24h) + (bot TF klines × 24h)
//   - Apply CBv2 (4 consecutive red below lowerKC) on bot TF
//   - Apply ST3 (Bearish Engulfing + Shooting Star) on upper TF (TREND_TF_MAP)
//     ST3 with bypassOptIn=true (CBv3 decoupling — FIX-2026-08-09)
//   - Report any candle that would have triggered CBv3 in the last 24h

require('dotenv').config();
const mongoose = require('mongoose');
const Bot = require('../src/db/models/Bot');
const Trade = require('../src/db/models/Trade');
const binanceRest = require('../src/binance/binanceRest');
const signalEngine = require('../src/core/signalEngine');
const { TREND_TF_MAP } = require('../src/core/volatilityScanner');
const { computeBgStates, isCBv2At, isEngulf1BarAt, isEngulf2BarAt, isShootingStarAt } = signalEngine;

function tfMinutes(tf) {
  const m = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '6h': 360, '8h': 480, '12h': 720, '1d': 1440, '3d': 4320, '1w': 10080, '1M': 43200 };
  return m[tf] || 60;
}

function candlesIn24h(tf) {
  return Math.ceil((24 * 60) / tfMinutes(tf));
}

async function fetchKlines(symbol, tf, n) {
  const raw = await binanceRest.getKlines({ symbol, interval: tf, limit: n });
  if (!Array.isArray(raw)) return null;
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
  if (ms == null) return 'null';
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

async function scanBot(bot) {
  const tf = bot.timeframe || '15m';
  const trendTF = TREND_TF_MAP[tf] || '1h';
  const symbol = bot.symbol;
  const kcMult = bot.kcMult != null ? parseFloat(bot.kcMult) : 1.2;

  const botN = candlesIn24h(tf) + 25; // +25 for KC warmup
  const trendN = candlesIn24h(trendTF) + 25;

  let botKlines, trendKlines;
  try {
    [botKlines, trendKlines] = await Promise.all([
      fetchKlines(symbol, tf, botN),
      fetchKlines(symbol, trendTF, trendN),
    ]);
  } catch (err) {
    return { error: `klines fetch failed: ${err.message}` };
  }
  if (!botKlines || botKlines.length < 24) return { error: 'insufficient bot klines' };
  if (!trendKlines || trendKlines.length < 24) return { error: 'insufficient trend klines' };

  // ─── CBv2 on bot TF ───
  const opens = botKlines.map((k) => k.open);
  const closes = botKlines.map((k) => k.close);
  const highs = botKlines.map((k) => k.high);
  const lows = botKlines.map((k) => k.low);
  const { lower } = computeBgStates({ closes, highs, lows, mult: kcMult });
  const cbv2Hits = [];
  for (let i = 4; i < botKlines.length; i++) {
    if (isCBv2At(i, opens, closes, lower)) {
      cbv2Hits.push({
        index: i,
        openTime: botKlines[i].openTime,
        close: closes[i],
        lowerKC: lower[i],
      });
    }
  }

  // ─── ST3 on trend TF (Bypassing Opt-In) ───
  const tOpens = trendKlines.map((k) => k.open);
  const tCloses = trendKlines.map((k) => k.close);
  const tHighs = trendKlines.map((k) => k.high);
  const tLows = trendKlines.map((k) => k.low);
  const { upper: tUpperKC } = computeBgStates({ closes: tCloses, highs: tHighs, lows: tLows, mult: kcMult });

  const st3Hits = [];
  for (let i = 2; i < trendKlines.length; i++) {
    const e1 = isEngulf1BarAt(i, tOpens, tCloses, tUpperKC);
    const e2 = isEngulf2BarAt(i, tOpens, tCloses, tUpperKC);
    const ss = isShootingStarAt(i, tOpens, tCloses, tHighs, tLows, tUpperKC);
    if (e1 || e2 || ss) {
      st3Hits.push({
        index: i,
        openTime: trendKlines[i].openTime,
        close: tCloses[i],
        pattern: e1 ? 'engulf1' : e2 ? 'engulf2' : 'shootingStar',
      });
    }
  }

  return {
    tf,
    trendTF,
    kcMult,
    cbv3Enabled: bot.cbv3Enabled !== false,
    st3OptIn: bot.safeTradeNoTradeEnabled === true,
    cbv2Hits,
    st3Hits,
    botKlinesCount: botKlines.length,
    trendKlinesCount: trendKlines.length,
  };
}

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/onepercentbottrade');

    const bots = await Bot.find({ enabled: { $ne: false } }, '_id name symbol timeframe kcMult cbv3Enabled safeTradeNoTradeEnabled').lean();
    console.log(`Scanning ${bots.length} enabled bots for CBv3 in last 24h...`);
    console.log('='.repeat(80));

    const fires = [];
    const errors = [];
    let i = 0;
    for (const bot of bots) {
      i++;
      process.stdout.write(`\r[${i}/${bots.length}] ${bot.name || bot._id} (${bot.symbol})...`);
      const result = await scanBot(bot);
      if (result.error) {
        errors.push({ name: bot.name, symbol: bot.symbol, error: result.error });
        continue;
      }
      const cbv3Score = result.cbv2Hits.length + result.st3Hits.length;
      if (cbv3Score > 0) {
        fires.push({
          name: bot.name || bot._id,
          symbol: bot.symbol,
          tf: result.tf,
          trendTF: result.trendTF,
          kcMult: result.kcMult,
          cbv3Enabled: result.cbv3Enabled,
          st3OptIn: result.st3OptIn,
          cbv2Hits: result.cbv2Hits,
          st3Hits: result.st3Hits,
        });
      }
      // polite delay between bots
      await new Promise((r) => setTimeout(r, 200));
    }

    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    console.log('='.repeat(80));
    console.log(`\n📊 SCAN RESULTS: ${bots.length} bots scanned, ${fires.length} would have fired CBv3, ${errors.length} errors`);
    console.log('='.repeat(80));

    if (fires.length === 0) {
      console.log('\n✅ No CBv3 fires detected in the last 24h');
    } else {
      console.log('\n🚨 BOTS THAT WOULD HAVE FIRED CBv3:\n');
      for (const f of fires) {
        const decoupled = f.cbv3Enabled && !f.st3OptIn;
        console.log(`📌 ${f.name} | ${f.symbol} | ${f.tf} (trend: ${f.trendTF}) | kcMult=${f.kcMult}`);
        console.log(`   cbv3Enabled=${f.cbv3Enabled} | ST3 opt-in=${f.st3OptIn}${decoupled ? '  [DECOUPLED MODE]' : ''}`);
        if (f.cbv2Hits.length > 0) {
          console.log(`   🔥 CBv2 hits (${f.cbv2Hits.length}):`);
          for (const h of f.cbv2Hits) {
            console.log(`      ${formatBkk(h.openTime)} | close=${h.close} | lowerKC=${h.lowerKC?.toFixed(6)}`);
          }
        }
        if (f.st3Hits.length > 0) {
          console.log(`   🎯 ST3 hits (${f.st3Hits.length}):`);
          for (const h of f.st3Hits) {
            console.log(`      ${formatBkk(h.openTime)} | pattern=${h.pattern} | close=${h.close}`);
          }
        }
        console.log('');
      }
    }

    if (errors.length > 0) {
      console.log('\n⚠️  ERRORS:');
      for (const e of errors) {
        console.log(`   ${e.name} (${e.symbol}): ${e.error}`);
      }
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error('Fatal:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
