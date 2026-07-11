'use strict';

let chart = null;
let candleSeries = null;
let basisSeries = null;
let upperSeries = null;
let lowerSeries = null;
let markers = [];
let currentData = null;
let refreshTimer = null;

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

  setupChart();
  await loadSymbols();
  WSClient.start();

  document.getElementById('c-load').onclick = loadChart;
  document.getElementById('c-symbol').addEventListener('change', loadChart);
  document.getElementById('c-timeframe').addEventListener('change', loadChart);
  document.getElementById('c-limit').addEventListener('change', loadChart);

  await loadChart();

  // auto refresh ทุก 30 วินาที (เนื่องจาก WebSocket ส่งมาเองอยู่แล้ว แต่ historical แท่งเก่าต้อง refetch)
  refreshTimer = setInterval(loadChart, 30000);

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
        return `<span class="signal-marker" title="${d.toISOString()} price=${s.close.toFixed(4)} bg=${s.bgPrev}→${s.bgState}">S1 @ ${fmtDateTime(d)} ($${s.close.toFixed(4)})</span> `;
      }).join('')
    }
  `;
}

init();