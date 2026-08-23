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

const symbols = [
  { symbol: 'HOMEUSDT', kcMult: 1.5, count: 30 },
  { symbol: 'RIFUSDT', kcMult: 1.5, count: 30 },
  { symbol: 'MMTUSDT', kcMult: 1.5, count: 30 },
];

(async () => {
  for (const s of symbols) {
    console.log(`\n========== ${s.symbol} ==========`);
    const klines = await getJson(`https://api.binance.com/api/v3/klines?symbol=${s.symbol}&interval=3m&limit=${s.count}`);
    const highs = klines.map((k) => parseFloat(k[2]));
    const lows = klines.map((k) => parseFloat(k[3]));
    const closes = klines.map((k) => parseFloat(k[4]));
    const lastClose = closes[closes.length - 1];
    const lastAtr = atr(highs, lows, closes, 20);
    const lastEma = ema(closes, 20);
    const upperKC = lastEma + s.kcMult * lastAtr;
    console.log({
      lastClose,
      lastEma: lastEma.toFixed(6),
      lastAtr: lastAtr.toFixed(6),
      upperKC: upperKC.toFixed(6),
      closeAboveUpperKC: lastClose > upperKC,
    });
    console.log('Last 15 candles (high vs upperKC):');
    for (let i = closes.length - 15; i < closes.length; i++) {
      const partialHighs = highs.slice(0, i + 1);
      const partialLows = lows.slice(0, i + 1);
      const partialCloses = closes.slice(0, i + 1);
      const a = atr(partialHighs, partialLows, partialCloses, 20);
      const e = ema(partialCloses, 20);
      const u = e + s.kcMult * a;
      const c = closes[i];
      const h = highs[i];
      const highAbove = h > u ? '*** HIGH ABOVE ***' : '';
      const closeAbove = c > u ? '*** CLOSE ABOVE ***' : '';
      console.log(`  i=${i} close=${c.toFixed(6)} high=${h.toFixed(6)} upperKC=${u.toFixed(6)} ${highAbove} ${closeAbove}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });