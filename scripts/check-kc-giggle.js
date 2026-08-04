// Compute upperKC for GIGGLE 3m candles
const https = require('https');

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function tr(high, low, prevClose) {
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

function atr(highs, lows, closes, period) {
  const trs = [];
  for (let i = 1; i < highs.length; i++) trs.push(tr(highs[i], lows[i], closes[i - 1]));
  return ema(trs, period);
}

(async () => {
  const klines = await getJson('https://api.binance.com/api/v3/klines?symbol=GIGGLEUSDT&interval=3m&limit=50');
  const highs = klines.map((k) => parseFloat(k[2]));
  const lows = klines.map((k) => parseFloat(k[3]));
  const closes = klines.map((k) => parseFloat(k[4]));
  const lastClose = closes[closes.length - 1];
  const lastAtr = atr(highs, lows, closes, 20);
  const lastEma = ema(closes, 20);
  const kcMult = 1.5;
  const upperKC = lastEma + kcMult * lastAtr;
  console.log({
    lastClose,
    lastEma: lastEma.toFixed(4),
    lastAtr: lastAtr.toFixed(4),
    upperKC: upperKC.toFixed(4),
    spreadPct: ((upperKC - lastClose) / lastClose * 100).toFixed(2) + '%',
    closeAboveUpperKC: lastClose > upperKC,
  });
  // Check last 10 candles for close > upperKC
  console.log('\nLast 10 candles (close vs upperKC computed at that time):');
  for (let i = closes.length - 10; i < closes.length; i++) {
    const partialHighs = highs.slice(0, i + 1);
    const partialLows = lows.slice(0, i + 1);
    const partialCloses = closes.slice(0, i + 1);
    const a = atr(partialHighs, partialLows, partialCloses, 20);
    const e = ema(partialCloses, 20);
    const u = e + kcMult * a;
    const c = closes[i];
    console.log(`i=${i} close=${c.toFixed(2)} upperKC=${u.toFixed(4)} ${c > u ? '*** ABOVE ***' : ''}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });