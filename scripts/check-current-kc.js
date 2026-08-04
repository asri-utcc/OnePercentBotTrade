const https = require('https');

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
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
  const symbols = ['MMTUSDT', 'ZAMAUSDT', 'AEVOUSDT', 'RIFUSDT'];
  for (const sym of symbols) {
    try {
      const klines = await getJson(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=3m&limit=30`);
      const highs = klines.map((k) => parseFloat(k[2]));
      const lows = klines.map((k) => parseFloat(k[3]));
      const closes = klines.map((k) => parseFloat(k[4]));
      const last = klines.length - 1;
      const lastClose = closes[last];
      const lastEma = ema(closes, 20);
      const lastAtr = atr(highs, lows, closes, 20);
      const upperKC = lastEma + 1.5 * lastAtr;
      const lowerKC = lastEma - 1.5 * lastAtr;
      console.log(`${sym}: lastClose=${lastClose.toFixed(5)} upperKC=${upperKC.toFixed(5)} gap=${((lastClose - upperKC) / upperKC * 100).toFixed(2)}% ${lastClose > upperKC ? '⚠️  ABOVE' : ''}`);
    } catch (e) {
      console.log(`${sym}: error ${e.message}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
