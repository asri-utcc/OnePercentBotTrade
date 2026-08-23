// Verify Pine ST3 state machine on 1h MMTUSDT, replicating nt + nt1 carry-over
const https = require('https');

function get(url) {
  return new Promise((r, j) => {
    https.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { r(JSON.parse(d)); } catch (e) { j(e); }
      });
    }).on('error', j);
  });
}

function ema(arr, p) {
  const k = 2 / (p + 1);
  let e = arr[0];
  const out = [e];
  for (let i = 1; i < arr.length; i++) {
    e = arr[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

function atr(h, l, c, p) {
  const n = h.length;
  const trs = [];
  for (let i = 0; i < n; i++) {
    const pc = i > 0 ? c[i - 1] : c[i];
    trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - pc), Math.abs(l[i] - pc)));
  }
  // Rolling ATR: out[i] = mean(trs[i-p+1 .. i])  (i >= p-1),  else null
  const out = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += trs[i];
    if (i >= p) sum -= trs[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

function isEngulf1(i, o, c, upperKC) {
  if (i < 1) return false;
  if (o[i] == null || c[i] == null || o[i - 1] == null || c[i - 1] == null) return false;
  if (upperKC[i] == null || upperKC[i - 1] == null) return false;
  const gPrev = c[i - 1] > o[i - 1];
  const rNow = c[i] < o[i];
  const cov = o[i] * 1.001 >= c[i - 1];
  const dip = c[i] * 0.999 <= o[i - 1];
  const upper = c[i - 1] > upperKC[i - 1] || o[i] > upperKC[i];
  return gPrev && rNow && cov && dip && upper;
}

function isEngulf2(i, o, c, upperKC) {
  if (i < 2) return false;
  if (o[i] == null || c[i] == null || o[i - 1] == null || c[i - 1] == null || o[i - 2] == null || c[i - 2] == null) return false;
  if (upperKC[i] == null) return false;
  const g2 = c[i - 2] > o[i - 2];
  const rOrD1 = c[i - 1] <= o[i - 1];
  const rNow = c[i] < o[i];
  const dip = c[i] * 0.999 <= o[i - 2];
  const upper = c[i - 2] > upperKC[i - 2] || c[i - 1] > upperKC[i - 1] || o[i] > upperKC[i];
  return g2 && rOrD1 && rNow && dip && upper;
}

function isSS(i, o, c, h, l, upperKC) {
  if (o[i] == null || c[i] == null || h[i] == null || l[i] == null || upperKC[i] == null) return false;
  const r = h[i] - l[i];
  if (r <= 0) return false;
  const b = Math.abs(c[i] - o[i]);
  if (b > r * 0.35) return false;
  const uW = h[i] - Math.max(o[i], c[i]);
  if (!(uW >= b * 2 && uW >= r * 0.5)) return false;
  const lW = Math.min(o[i], c[i]) - l[i];
  if (!(lW <= r * 0.15)) return false;
  if (!(o[i] > upperKC[i] || c[i] > upperKC[i])) return false;
  return true;
}

(async () => {
  const k = await get('https://api.binance.com/api/v3/klines?symbol=MMTUSDT&interval=1h&limit=120');
  const o = k.map((x) => +x[1]);
  const h = k.map((x) => +x[2]);
  const l = k.map((x) => +x[3]);
  const c = k.map((x) => +x[4]);
  const t = k.map((x) => +x[0]);
  const basis = ema(c, 20);
  const at = atr(h, l, c, 20);
  const upperKC = basis.map((b, i) => (b != null && at[i] != null ? b + at[i] * 1.2 : null));

  console.log('idx | time (UTC)         | O       C       | body%   | upperKC | e1  e2  ss  | kind | redLeft');
  console.log('-'.repeat(95));
  let redCountRemaining = 0;
  for (let i = 20; i < k.length; i++) {
    const d = new Date(+t[i]).toISOString().slice(0, 16);
    const bodyPct = (((c[i] - o[i]) / o[i]) * 100).toFixed(2);
    const upper = upperKC[i] != null ? upperKC[i].toFixed(4) : 'null';
    const e1 = isEngulf1(i, o, c, upperKC);
    const e2 = isEngulf2(i, o, c, upperKC);
    const ss = isSS(i, o, c, h, l, upperKC);
    const raw = e1 || e2 || ss;
    let kind = 'none';
    if (raw) {
      kind = 'nt';
      redCountRemaining = 2;
    } else if (redCountRemaining > 0 && c[i] < o[i]) {
      kind = 'nt1';
      redCountRemaining -= 1;
    } else {
      kind = 'none';
      redCountRemaining = 0;
    }
    console.log(
      `${i.toString().padStart(3)} | ${d} | ${o[i].toFixed(4)} ${c[i].toFixed(4)} | ${bodyPct.padStart(6)}% | ${upper} | ${e1 ? 'Y' : '-'}  ${e2 ? 'Y' : '-'}  ${ss ? 'Y' : '-'}  | ${kind.padEnd(4)} | ${redCountRemaining}`,
    );
  }
})();
