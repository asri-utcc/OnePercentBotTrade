'use strict';

// ─── Pine Script v5 — KC + S1 (สำหรับคัดลอกไปรันบน TradingView) ──────────────
const PINE_SCRIPT = `//@version=5
indicator("KC + S1 (OnePercentBotTrade)", overlay=true)

// === Inputs (ตรงกับค่าในบอท) ===
kcLen  = input.int(20,   "KC Length")
kcMult = input.float(1.5, "KC Mult")

// === Keltner Channel ===
basisKC = ta.ema(close, kcLen)
rngKC   = ta.atr(kcLen)                  // Wilder RMA-based ATR (ta.rma(ta.tr, len))
upperKC = basisKC + kcMult * rngKC
lowerKC = basisKC - kcMult * rngKC

// === bg_state classification (matches src/core/signalEngine.js) ===
bg = close > upperKC ? 1 :
     close < lowerKC ? 3 :
     close < basisKC ? 2 : 0

// === S1: breakout/breakdown จาก "Weak" (bg==2) เข้า Strong zone ===
s1Up   = (bg[1] == 2) and (bg == 1)      // close ทะลุ upper → Strong Up breakout
s1Down = (bg[1] == 2) and (bg == 3)      // close ทะลุ lower → Strong Down breakdown
s1     = s1Up or s1Down

// === Plots (สีและสไตล์ตรงกับหน้า chart ของเรา) ===
plot(basisKC, color=color.new(color.blue,  0), linewidth=1, title="EMA20")
plot(upperKC, color=color.new(color.green, 0), linewidth=1, title="Upper KC")
plot(lowerKC, color=color.new(color.red,   0), linewidth=1, title="Lower KC")

// === S1 marker (ลูกศรเขียวใต้แท่ง) ===
plotshape(s1, title="S1", style=shape.triangleup, location=location.belowbar,
     color=color.new(color.green, 0), size=size.tiny, text="S1")
`;

let chart = null;
let candleSeries = null;
let basisSeries = null;
let upperSeries = null;
let lowerSeries = null;
let markers = [];
let currentData = null;
let refreshTimer = null;
let chartSymbol = ''; // FIX-2026-07-31: current chart symbol (for PriceFormat in signal marker)

// ─── Timezone helpers (force Asia/Bangkok +07:00) ──────
const TZ = 'Asia/Bangkok';
const _chartTickFmt = new Intl.DateTimeFormat('th-TH', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  day: '2-digit',
  month: 'short',
  hour12: false,
});
const _chartDtFmt = new Intl.DateTimeFormat('th-TH', {
  timeZone: TZ,
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
function fmtDateTime(d) { return d ? _chartDtFmt.format(new Date(d)) : '-'; }

async function init() {
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me || !me.authenticated) {
    location.href = '/login.html';
    return;
  }

  // FIX-2026-08-03: deep-link support — รับ ?symbol=XXX&tf=YYY จาก URL
  //   - ใช้ตอน user กดปุ่ม "📈 Chart" จาก Position card ในหน้า /bots.html → /chart.html
  //   - apply หลัง symbols/timeframe options พร้อม (กัน select.value หาย)
  const params = new URLSearchParams(location.search);
  const dlSymbol = (params.get('symbol') || '').trim().toUpperCase();
  const dlTf = (params.get('tf') || '').trim();

  setupChart();
  await loadSymbols();
  // FIX-2026-07-31: preload Binance tickSize precision สำหรับ PriceFormat
  if (window.PriceFormat) await window.PriceFormat.load();
  WSClient.start();

  document.getElementById('c-load').onclick = loadChart;
  document.getElementById('c-symbol').addEventListener('change', loadChart);
  document.getElementById('c-timeframe').addEventListener('change', loadChart);
  document.getElementById('c-limit').addEventListener('change', loadChart);

  bindSignalInfoPanel();

  // FIX-2026-08-03: apply deep-link values (ถ้ามี) ก่อน loadChart()
  //   - ถ้า symbol ไม่อยู่ใน dropdown (เช่น de-listed) → fallback เป็น BNBUSDT (default)
  //   - ถ้า tf ไม่อยู่ในรายการ → fallback เป็น 5m (default)
  if (dlSymbol) {
    const symSel = document.getElementById('c-symbol');
    const hasOption = Array.from(symSel.options).some((o) => o.value === dlSymbol);
    if (hasOption) symSel.value = dlSymbol;
  }
  if (dlTf) {
    const tfSel = document.getElementById('c-timeframe');
    const hasOption = Array.from(tfSel.options).some((o) => o.value === dlTf);
    if (hasOption) tfSel.value = dlTf;
  }
  // FIX-2026-08-03: อัปเดต document.title ให้แสดง symbol/tf ใน browser tab
  const curSymbol = document.getElementById('c-symbol').value;
  const curTf = document.getElementById('c-timeframe').value;
  if (dlSymbol || dlTf) {
    document.title = `📈 ${curSymbol} ${curTf} — Chart`;
  }

  await loadChart();

  // FIX-2026-08-04: auto refresh 30s → 60s (ลด kline API load; WS push updates current candle real-time)
  refreshTimer = setInterval(loadChart, 60000);

  WSClient.on('kline:update', (p) => {
    if (!currentData) return;
    if (p.kline.symbol !== currentData.symbol || p.interval !== currentData.timeframe) return;
    // อัปเดตแท่งล่าสุด
    const lastCandle = currentData.klines[currentData.klines.length - 1];
    if (lastCandle && p.kline.openTime === lastCandle.openTime) {
      lastCandle.close = parseFloat(p.kline.close);
      lastCandle.high = Math.max(lastCandle.high, parseFloat(p.kline.high));
      lastCandle.low = Math.min(lastCandle.low, parseFloat(p.kline.low));
      candleSeries.update({
        time: lastCandle.openTime / 1000,
        open: lastCandle.open,
        high: lastCandle.high,
        low: lastCandle.low,
        close: lastCandle.close,
      });
    }
  });
}

// ─── Adaptive price-axis formatter ─────────────────────────────────────────
// ปรับจำนวนทศนิยมตามขนาดราคา เพื่อให้อ่านค่าได้ละเอียดพอในทุกช่วงราคา
//   - ≥ 1000              → 2 ตำแหน่ง  (BTC @ 60000.00)
//   - ≥ 1                 → 4 ตำแหน่ง  (ETH @ 3500.1234)
// FIX-2026-07-31: ใช้ Binance tickSize precision (authoritative) — fallback heuristic
//   - ZILUSDT tickSize = 0.000001 → 6 ตำแหน่ง (ตรงกับ Binance UI)
//   - เดิม heuristic >=0.01 → 4 ตำแหน่ง ทำให้ ZIL/BANK/COTI แสดงผิด
function chartPriceFormatter(price) {
  if (price === null || price === undefined || !Number.isFinite(price)) return '';
  // ดึง symbol ปัจจุบันจาก dropdown
  const symbolEl = document.getElementById('c-symbol');
  const symbol = symbolEl ? symbolEl.value : null;
  if (window.PriceFormat) return window.PriceFormat.format(price, symbol);
  // fallback heuristic (เดิม)
  const abs = Math.abs(price);
  if (abs >= 1000) return price.toFixed(2);
  if (abs >= 1) return price.toFixed(4);
  if (abs >= 0.01) return price.toFixed(4);
  if (abs >= 0.0001) return price.toFixed(5);
  return price.toFixed(6);
}

function setupChart() {
  const container = document.getElementById('chart-container');
  chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 600,
    layout: {
      background: { type: 'solid', color: '#ffffff' },
      textColor: '#333',
    },
    grid: {
      vertLines: { color: '#f0f0f0' },
      horzLines: { color: '#f0f0f0' },
    },
    timeScale: {
      timeVisible: true,
      secondsVisible: false,
      // FIX-2026-07-22: เพิ่มพื้นที่ด้านขวาหลังแท่งสุดท้าย ~12 แท่ง
      // เพื่อให้เห็น "เวลาถอยหลังก่อนแท่งปัจจุบันจะปิด" เหมือน TradingView
      // (drag scroll ซ้ายได้เพื่อดูย้อนหลังเพิ่ม, ขวาเพื่อดูเวลาปัจจุบันเดินหน้า)
      rightOffset: 12,
      // เมื่อมีแท่งใหม่เข้ามา ให้ time scale เลื่อนตามอัตโนมัติ (เหมือน TV live mode)
      shiftVisibleRangeOnNewBar: true,
      // อนุญาตให้ user drag/pinch ซูมเพื่อดูย้อนหลังเพิ่มได้
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: false },
    },
    // FIX-2026-07-22: ใช้ adaptive price formatter เพื่อให้แกนราคาแสดงทศนิยม
    // เหมาะสมกับทุกช่วงราคา — เหรียญราคาต่ำจะเห็นรายละเอียดมากขึ้น
    localization: {
      priceFormatter: chartPriceFormatter,
    },
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
  });

  // ให้แกนเวลาแสดงเป็น Asia/Bangkok (+07:00) — lightweight-charts รับ time เป็น Unix seconds
  chart.timeScale().applyOptions({
    tickMarkFormatter: (timeSec) => {
      try { return _chartTickFmt.format(new Date(timeSec * 1000)); }
      catch (e) { return ''; }
    },
  });

  basisSeries = chart.addLineSeries({ color: '#2196f3', lineWidth: 1, title: 'EMA20' });
  upperSeries = chart.addLineSeries({ color: '#4caf50', lineWidth: 1, lineStyle: 2, title: 'Upper KC' });
  lowerSeries = chart.addLineSeries({ color: '#f44336', lineWidth: 1, lineStyle: 2, title: 'Lower KC' });

  window.addEventListener('resize', () => {
    chart.applyOptions({ width: container.clientWidth });
  });
}

async function loadSymbols() {
  try {
    const resp = await API.get('/api/bots/symbols');
    const select = document.getElementById('c-symbol');
    select.innerHTML = '';
    for (const s of resp.symbols) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === 'BNBUSDT') opt.selected = true;
      select.appendChild(opt);
    }
  } catch (err) {
    console.error(err);
  }
}

async function loadChart() {
  const symbol = document.getElementById('c-symbol').value;
  chartSymbol = symbol; // FIX-2026-07-31: expose for signal marker label formatting (ZILUSDT needs 6 dp not 4)
  const timeframe = document.getElementById('c-timeframe').value;
  const limit = document.getElementById('c-limit').value;
  if (!symbol) return;

  try {
    const resp = await API.get(`/api/chart/klines?symbol=${symbol}&timeframe=${timeframe}&limit=${limit}`);
    currentData = resp;

    // Map data
    const candleData = resp.klines.map((k) => ({
      time: k.openTime / 1000,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));

    const basisData = [];
    const upperData = [];
    const lowerData = [];
    for (let i = 0; i < resp.klines.length; i += 1) {
      const t = resp.klines[i].openTime / 1000;
      if (resp.keltner.basis[i] !== null) {
        basisData.push({ time: t, value: resp.keltner.basis[i] });
        upperData.push({ time: t, value: resp.keltner.upper[i] });
        lowerData.push({ time: t, value: resp.keltner.lower[i] });
      }
    }

    candleSeries.setData(candleData);
    basisSeries.setData(basisData);
    upperSeries.setData(upperData);
    lowerData && lowerSeries.setData(lowerData);

    // Markers (S1 signals)
    const sigMarkers = resp.signals.map((s) => ({
      time: s.openTime / 1000,
      position: 'belowBar',
      color: '#22c55e',
      shape: 'arrowUp',
      text: 'S1',
    }));
    candleSeries.setMarkers(sigMarkers);

    // Background colors per bg state — ใช้ candlestick color เป็นหลัก และเพิ่ม histogram series สำหรับ zone
    renderSignalList(resp);

    chart.timeScale().fitContent();
  } catch (err) {
    console.error(err);
    document.getElementById('signal-list').innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

function renderSignalList(resp) {
  const recent = resp.signals.slice(-20).reverse();
  document.getElementById('signal-list').innerHTML = `
    <strong>S1 signals ล่าสุด (${resp.signals.length} จุด):</strong>
    ${recent.length === 0 ? '<span class="text-muted">ไม่มีสัญญาณในช่วงที่เลือก</span>' :
      recent.map((s) => {
        const d = new Date(s.closeTime);
        return `<span class="signal-marker" title="${d.toISOString()} price=${PriceFormat.format(s.close, chartSymbol)} bg=${s.bgPrev}→${s.bgState}">S1 @ ${fmtDateTime(d)} ($${PriceFormat.format(s.close, chartSymbol)})</span> `;
      }).join('')
    }
  `;
}

// ─── Signal info accordion + Pine Script copy ──────────────────────────────
function bindSignalInfoPanel() {
  const codeEl = document.getElementById('pine-script-code');
  if (codeEl) codeEl.textContent = PINE_SCRIPT;

  const btn = document.getElementById('copy-pine-btn');
  const status = document.getElementById('pine-copy-status');
  if (btn) {
    btn.addEventListener('click', async () => {
      const ok = await copyToClipboard(PINE_SCRIPT);
      if (status) {
        status.hidden = false;
        status.textContent = ok ? '✓ คัดลอก Pine Script แล้ว' : '⚠️ คัดลอกไม่สำเร็จ';
      }
      setTimeout(() => { if (status) status.hidden = true; }, 2500);
    });
  }

  // จำสถานะ open/closed ระหว่าง reload
  const det = document.getElementById('signal-info');
  if (det) {
    const saved = localStorage.getItem('chart.signalInfo.open');
    if (saved !== null) det.open = (saved === '1');
    det.addEventListener('toggle', () => {
      localStorage.setItem('chart.signalInfo.open', det.open ? '1' : '0');
    });
  }
}

async function copyToClipboard(text) {
  // Modern path — secure context (HTTPS or localhost)
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
  }
  // Fallback — works in older browsers / non-secure contexts
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

init();