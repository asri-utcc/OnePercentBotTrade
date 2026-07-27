'use strict';

/**
 * Scan Volatility page — UI logic
 * - POST /api/scan/volatility with form params
 * - render 4-tile summary + ranked table
 * - click symbol → /chart.html?symbol=XXX&timeframe=YYY
 */

async function init() {
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me || !me.authenticated) {
    location.href = '/login.html';
    return;
  }

  const runBtn = document.getElementById('s-run');
  if (runBtn) runBtn.onclick = runScan;
}

function readParams() {
  // Trend multi-select — empty array = "no filter, show all trends"
  const trends = [];
  if (document.getElementById('s-trend-up').checked) trends.push('uptrend');
  if (document.getElementById('s-trend-down').checked) trends.push('downtrend');
  if (document.getElementById('s-trend-side').checked) trends.push('sideways');

  return {
    timeframe: document.getElementById('s-timeframe').value,
    threshold: parseFloat(document.getElementById('s-threshold').value),
    window: parseInt(document.getElementById('s-window').value, 10),
    tpWindow: parseInt(document.getElementById('s-tpwindow').value, 10) || 500, // FIX-2026-07-23
    topN: parseInt(document.getElementById('s-topn').value, 10),
    minQuoteVolume: parseFloat(document.getElementById('s-minvol').value),
    minPctBarsAbove: (parseFloat(document.getElementById('s-minpct').value) || 0) / 100,
    trends,
  };
}

function setLoading(loading) {
  const btn = document.getElementById('s-run');
  if (!btn) return;
  btn.disabled = !!loading;
  btn.classList.toggle('is-loading', !!loading);
}

async function runScan() {
  const params = readParams();
  const result = document.getElementById('result');

  // light validation
  if (!Number.isFinite(params.threshold) || params.threshold <= 0) {
    result.innerHTML = `<div class="alert alert-danger">threshold ต้องมากกว่า 0</div>`;
    return;
  }
  if (!Number.isFinite(params.window) || params.window < 5) {
    result.innerHTML = `<div class="alert alert-danger">window ต้อง ≥ 5 bars</div>`;
    return;
  }
  if (params.trends.length === 0) {
    result.innerHTML = `<div class="alert alert-danger">เลือก trend อย่างน้อย 1 อย่าง (uptrend / downtrend / sideways)</div>`;
    return;
  }

  const trendLabel = params.trends.length === 3
    ? 'all trends'
    : params.trends.join(' + ');

  result.innerHTML = `
    <div class="alert alert-info d-flex align-items-center gap-2">
      <div class="spinner-border spinner-border-sm" role="status"></div>
      <div>กำลังสแกน <strong>${params.topN}</strong> symbols × <strong>${params.timeframe}</strong> (thr=${params.threshold}% · window=${params.window} bars · TP window=${params.tpWindow || 500} bars · ${trendLabel}) — อาจใช้เวลา 10-30 วินาที…</div>
    </div>`;
  setLoading(true);

  try {
    const resp = await API.post('/api/scan/volatility', params);
    renderResult(resp, params);
  } catch (err) {
    const msg = (err && err.message) || 'unknown error';
    result.innerHTML = `<div class="alert alert-danger">❌ สแกนล้มเหลว: ${msg}</div>`;
  } finally {
    setLoading(false);
  }
}

function fmtNum(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function renderResult(resp, params) {
  const ranked = resp.ranked || [];
  const scanned = resp.scanned || 0;
  const scanMs = resp.scanMs || 0;
  const threshold = resp.threshold;
  const winBars = resp.window;

  if (ranked.length === 0) {
    document.getElementById('result').innerHTML = `
      <div class="alert alert-warning">
        ไม่มี symbol ที่ผ่านเกณฑ์ (pct_bars &gt; threshold ≥ ${(params.minPctBarsAbove * 100).toFixed(0)}% AND trend ∈ {${params.trends.join(', ')}})
        จากการสแกน ${scanned} symbols · ${(scanMs / 1000).toFixed(1)}s
        <br>ลองลด <code>Min % bars &gt; thr</code> · ลด <code>% Volatility threshold</code> · หรือเพิ่ม trend ที่ filter
      </div>`;
    return;
  }

  // Save state for sort handler
  rankedData = ranked;
  lastParams = params;
  sortKey = 'score';
  sortDir = 'desc';

  // Aggregate KPIs across ranked set
  const meanScore = ranked.reduce((s, r) => s + r.score, 0) / ranked.length;
  const meanAtr = ranked.reduce((s, r) => s + r.currentAtrPct, 0) / ranked.length;
  const meanPct = ranked.reduce((s, r) => s + r.pctBarsAboveThreshold, 0) / ranked.length;
  const meanAvgVol = ranked.reduce((s, r) => s + r.avgVol, 0) / ranked.length;
  summary = { meanScore, meanAtr, meanPct, meanAvgVol };

  const result = document.getElementById('result');
  result.innerHTML = `
    <div class="summary-row mb-3">
      <div class="stat-tile is-gold">
        <span class="glyph">🎯</span>
        <div class="value">${ranked.length}</div>
        <div class="label">Symbols Ranked</div>
        <div class="sub">จาก ${scanned} scanned · ${(scanMs / 1000).toFixed(1)}s</div>
      </div>
      <div class="stat-tile is-info">
        <span class="glyph">📊</span>
        <div class="value">${meanScore.toFixed(2)}</div>
        <div class="label">Mean Score</div>
        <div class="sub">avg swing strength</div>
      </div>
      <div class="stat-tile is-violet">
        <span class="glyph">📈</span>
        <div class="value">${meanAtr.toFixed(3)}%</div>
        <div class="label">Mean ATR%</div>
        <div class="sub">ATR(14) / close × 100</div>
      </div>
      <div class="stat-tile">
        <span class="glyph">🔥</span>
        <div class="value">${(meanPct * 100).toFixed(0)}%</div>
        <div class="label">Bars &gt; threshold</div>
        <div class="sub">avg · thr=${threshold}% · ${winBars} bars</div>
      </div>
    </div>

    <div class="lux-card">
      <div class="lux-header">
        <span class="title">🏆 Top ${ranked.length} Symbols</span>
        <span class="text-muted-2 small" id="scan-results-sub">คลิกหัวคอลัมน์เพื่อเรียงใหม่ · trend filter: ${params.trends.join(', ')}</span>
      </div>
      <div class="lux-body p-0">
        <div class="lux-table-wrap">
          <table class="lux-table" id="scan-results-table">
            <thead>
              <tr>
                <th class="num">#</th>
                <th class="sortable" data-sort-key="symbol">${headerLabel('Symbol', 'symbol')}</th>
                <th class="sortable" data-sort-key="trend">${headerLabel('Trend', 'trend')}</th>
                <th class="num sortable" data-sort-key="score">${headerLabel('Score', 'score')}</th>
                <th class="num sortable" data-sort-key="avgVol">${headerLabel('Avg Vol %', 'avgVol')}</th>
                <th class="num sortable" data-sort-key="maxVol">${headerLabel('Max Vol %', 'maxVol')}</th>
                <th class="num sortable" data-sort-key="volStd">${headerLabel('Std', 'volStd')}</th>
                <th class="num sortable" data-sort-key="pctBars">${headerLabel('Bars &gt; thr', 'pctBars')}</th>
                <th class="num sortable" data-sort-key="atr">${headerLabel('ATR(14)%', 'atr')}</th>
                <th class="num sortable" data-sort-key="trendEma">${headerLabel(`EMA20 Trend <span class="col-help" title="เปรียบเทียบราคาปิดแท่งล่าสุดกับ EMA20 ของ timeframe ที่ใหญ่กว่า scan TF — 1m→30m, 3m/5m→1h, 15m→4h, 30m→6h, 1h→1d · 'อยู่บน' = lastClose >= EMA20 (bullish), 'อยู่ล่าง' = lastClose < EMA20 (bearish)">ⓘ</span>`, 'trendEma')}</th>
                <th class="num sortable" data-sort-key="kcMin">${headerLabel('Min %KC <span class="col-help" title="ความกว้าง Keltner Channel แคบสุดในช่วง window — (upper-lower)/close × 100. ยิ่งน้อย = ยิ่ง \'ผูก\' (squeeze)">ⓘ</span>', 'kcMin')}</th>
                <th class="num sortable" data-sort-key="kcMax">${headerLabel('Max %KC <span class="col-help" title="ความกว้าง Keltner Channel กว้างสุดในช่วง window — (upper-lower)/close × 100. ยิ่งมาก = ยิ่ง \'เหวี่ยง\'">ⓘ</span>', 'kcMax')}</th>
                <th class="num sortable" data-sort-key="kcAvg">${headerLabel('Avg %KC <span class="col-help" title="ความกว้าง Keltner Channel เฉลี่ยในช่วง window — (upper-lower)/close × 100. สะท้อนระดับผันผวนโดยรวม">ⓘ</span>', 'kcAvg')}</th>
                <th class="num sortable" data-sort-key="suggestedTp">${headerLabel(`%TP แนะนำ (NET) <span class="col-help" title="NET หลังหัก round-trip fee (2×maker rate): trend upper → (Min %KC(${resp.tpWindow || 500} bars) / 4) − fee, trend lower → (Min %KC(${resp.tpWindow || 500} bars) / 8) − fee · ค่านี้ตรงกับปุ่ม Get TP% ในหน้า Bot Edit (single source of truth)">ⓘ</span>`, 'suggestedTp')}</th>
                <th class="num sortable" data-sort-key="last">${headerLabel('Last', 'last')}</th>
              </tr>
            </thead>
            <tbody>
              ${renderSortedRowsHTML()}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="alert alert-light small mt-3 mb-0">
      <strong>ℹ️ เกณฑ์การให้คะแนน (สูตรเดียวกับ user spec):</strong>
      <ul class="mb-1 mt-1">
        <li><strong>0.4 × (avg_vol / threshold)</strong> — ความเหวี่ยงเฉลี่ยเทียบกับเกณฑ์</li>
        <li><strong>0.3 × pct_bars_above_threshold</strong> — สัดส่วนแท่งที่ "เหวี่ยง" เกินเกณฑ์ (0–1)</li>
        <li><strong>0.2 × (current_ATR% / threshold)</strong> — ATR ปัจจุบัน vs เกณฑ์ (ทนต่อ gap)</li>
        <li><strong>0.1 × (max_vol / threshold)</strong> — แรงเหวี่ยงสูงสุดใน window</li>
      </ul>
      ⚠️ <strong>Volume ต้องดูเพิ่ม</strong> — เหรียญเหวี่ยงแรงแต่ 24h volume ต่ำ = slippage สูง เข้าไม่คุ้มออก · <strong>Spread</strong> กิน 0.5% หมดสำหรับเหรียญเล็ก · <strong>Session</strong> ช่วงเปิด US/Asia ผันผวนสูงเป็นปกติ
    </div>

    <div class="lux-card mt-3">
      <div class="lux-header">
        <span class="title">📖 คำอธิบายคอลัมน์ในตาราง</span>
        <span class="text-muted-2 small">คลิกหัวข้อหรือไอคอน ⓘ ในตารางเพื่อดู tooltip แบบย่อ</span>
      </div>
      <div class="lux-body">
        <div class="col-legend-grid">
          <div class="col-legend-item">
            <div class="col-legend-name">#</div>
            <div class="col-legend-desc">ลำดับหลังเรียงตาม Score (1 = คะแนนสูงสุด)</div>
          </div>
          <div class="col-legend-item">
            <div class="col-legend-name">Symbol</div>
            <div class="col-legend-desc">คู่เทรด USDT เช่น <code>BNBUSDT</code> · คลิกเพื่อเปิดหน้า chart</div>
          </div>
          <div class="col-legend-item">
            <div class="col-legend-name">Trend</div>
            <div class="col-legend-desc">ทิศทางในช่วง window — เปรียบเทียบ SMA ครึ่งแรก vs ครึ่งหลัง<br/>
              <span class="trend-pill is-uptrend">📈 uptrend</span> = +0.5%+ ·
              <span class="trend-pill is-downtrend">📉 downtrend</span> = −0.5%+ ·
              <span class="trend-pill is-sideways">↔️ sideways</span> = ±0.5%</div>
          </div>
          <div class="col-legend-item">
            <div class="col-legend-name">Score</div>
            <div class="col-legend-desc">คะแนนรวม swing-strength (0–5+) — ยิ่งสูงยิ่งเหวี่ยง<br/>
              <code>0.4×(avg_vol/thr) + 0.3×pct + 0.2×(ATR%/thr) + 0.1×(max_vol/thr)</code></div>
          </div>
          <div class="col-legend-item">
            <div class="col-legend-name">Avg Vol %</div>
            <div class="col-legend-desc">ความเหวี่ยงเฉลี่ยต่อแท่งใน window · สูตร <code>(high-low)/low × 100</code></div>
          </div>
          <div class="col-legend-item">
            <div class="col-legend-name">Max Vol %</div>
            <div class="col-legend-desc">ความเหวี่ยงสูงสุดของแท่งใดแท่งหนึ่งใน window (peak spike)</div>
          </div>
          <div class="col-legend-item">
            <div class="col-legend-name">Std</div>
            <div class="col-legend-desc">ส่วนเบี่ยงเบนมาตรฐานของ vol% — ยิ่งสูง = ความเหวี่ยงแต่ละแท่ง "ไม่สม่ำเสมอ" (บางแท่งเหวี่ยง บางแท่งนิ่ง)</div>
          </div>
          <div class="col-legend-item">
            <div class="col-legend-name">Bars &gt; thr</div>
            <div class="col-legend-desc">% ของแท่งใน window ที่ vol% &gt; threshold · ใช้กรอง spike-and-silence (เหวี่ยงแรงแต่นานๆ ที)</div>
          </div>
          <div class="col-legend-item">
            <div class="col-legend-name">ATR(14)%</div>
            <div class="col-legend-desc">Average True Range 14 แท่ง (Wilder) เทียบกับราคาปิด × 100 · สะท้อน "ความผันผวนเฉลี่ย" ทนต่อ gap</div>
          </div>
          <div class="col-legend-item is-new">
            <div class="col-legend-name">EMA20 Trend <span class="badge-new">ใหม่</span></div>
            <div class="col-legend-desc">เปรียบเทียบ <strong>lastClose</strong> กับ <strong>EMA20</strong> ของ timeframe ที่ใหญ่กว่า scan TF<br/>
              <table class="mini-tf-map">
                <tr><td>1m</td><td>→</td><td>30m</td></tr>
                <tr><td>3m, 5m</td><td>→</td><td>1h</td></tr>
                <tr><td>15m</td><td>→</td><td>4h</td></tr>
                <tr><td>30m</td><td>→</td><td>6h</td></tr>
                <tr><td>1h</td><td>→</td><td>1d</td></tr>
              </table>
              🟢 <span class="trend-state is-upper">▲ อยู่บน</span> = lastClose ≥ EMA20 (bullish) ·
              🔴 <span class="trend-state is-downtrend">▼ อยู่ล่าง</span> = lastClose &lt; EMA20 (bearish) ·
              ⏳ <span class="trend-state is-warmup">warmup</span> = ยังโหลด klines ครบ 20 แท่งไม่พอ
            </div>
          </div>
          <div class="col-legend-item is-new">
            <div class="col-legend-name">Min %KC <span class="badge-new">ใหม่</span></div>
            <div class="col-legend-desc">ความกว้าง Keltner Channel แคบสุดใน window · <code>(upper-lower)/close × 100</code><br/>
              <strong>ยิ่งน้อย = ยิ่ง "squeeze"</strong> (ราคานิ่งมาก เตรียมระเบิด) — ใช้จับจังหวะ "นิ่งแล้วเหวี่ยง"</div>
          </div>
          <div class="col-legend-item is-new">
            <div class="col-legend-name">Max %KC <span class="badge-new">ใหม่</span></div>
            <div class="col-legend-desc">ความกว้าง Keltner Channel กว้างสุดใน window · <code>(upper-lower)/close × 100</code><br/>
              <strong>ยิ่งมาก = ยิ่ง "เหวี่ยง"</strong> (ราคากว้างมากในช่วงนั้น)</div>
          </div>
          <div class="col-legend-item is-new">
            <div class="col-legend-name">Avg %KC <span class="badge-new">ใหม่</span></div>
            <div class="col-legend-desc">ความกว้าง Keltner Channel เฉลี่ยใน window · <code>(upper-lower)/close × 100</code><br/>
              สะท้อน "ระดับผันผวนโดยรวม" ของเหรียญในช่วงนั้น · KC ใช้ EMA+ATR (Wilder) — ทนต่อ gap ดีกว่า BB</div>
          </div>
          <div class="col-legend-item is-new">
            <div class="col-legend-name">%TP แนะนำ <span class="badge-new">ใหม่</span></div>
            <div class="col-legend-desc">คำนวณจาก <strong>trend</strong> ของ EMA20(upper-TF) + <strong>Min %KC</strong> (ความกว้าง Keltner Channel แคบสุดในช่วง TP Window — ค่าแยกจาก Window หลัก ใช้ดูยาว window กว้างเพื่อจับ squeeze ที่ลึก)<br/>
              <strong>อยู่บน EMA20 (upper)</strong> → <code>Min %KC / 4</code> — momentum แรง + squeeze → breakout คาดว่าจะวิ่งได้ไกล<br/>
              <strong>อยู่ใต้ EMA20 (lower)</strong> → <code>Min %KC / 8</code> — momentum อ่อน → breakout ระยะสั้น TP ต่ำลงเพื่อความปลอดภัย<br/>
              <span class="muted">สูตร "KC squeeze breakout" — upper TF บ่งบอก momentum, kcMin บ่งบอก magnitude ของ move ที่จะตามมา · TP Window default = 500 bars ตรงกับปุ่ม Get TP%</span>
            </div>
          </div>
          <div class="col-legend-item">
            <div class="col-legend-name">Last</div>
            <div class="col-legend-desc">ราคาปิดของแท่งล่าสุด (last close)</div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Wire (or re-wire) the click handler on the sortable header row
  bindSortHandlers();
}

/**
 * Adapt decimal display to price magnitude — avoid 0.000001234 looking like 0.00
 */
function formatPrice(p) {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  const abs = Math.abs(p);
  if (abs >= 1000) return p.toFixed(2);
  if (abs >= 1) return p.toFixed(4);
  if (abs >= 0.01) return p.toFixed(5);
  if (abs >= 0.0001) return p.toFixed(6);
  return p.toExponential(3);
}

/* ============================================================
   Sortable column headers
   - module-level state holds the current sort
   - clicking a th toggles direction (if same key) or sets default
   - only <tbody> + header indicators re-render on sort change
   ============================================================ */

// Map sort-key (data-sort-key on <th>) → field name + type in `ranked` object
const SORT_FIELDS = {
  symbol:     { field: 'symbol',               type: 'string' },
  trend:      { field: 'trend',                type: 'string' },
  score:      { field: 'score',                type: 'number' },
  avgVol:     { field: 'avgVol',               type: 'number' },
  maxVol:     { field: 'maxVol',               type: 'number' },
  volStd:     { field: 'volStd',               type: 'number' },
  pctBars:    { field: 'pctBarsAboveThreshold', type: 'number' },
  atr:        { field: 'currentAtrPct',        type: 'number' },
  trendEma:   { field: 'trendGapPct',          type: 'number' }, // FIX-2026-07-23: sort by gap% so upper sort descending = bullish first
  kcMin:      { field: 'kcMinPct',             type: 'number' },
  kcMax:      { field: 'kcMaxPct',             type: 'number' },
  kcAvg:      { field: 'kcAvgPct',             type: 'number' },
  suggestedTp:{ field: 'suggestedTpPct',       type: 'number' },
  last:       { field: 'lastClose',            type: 'number' },
};

let rankedData = [];
let summary = null;
let lastParams = null;
let sortKey = 'score';
let sortDir = 'desc'; // 'asc' | 'desc'

function defaultDirFor(key) {
  const meta = SORT_FIELDS[key];
  if (!meta) return 'desc';
  return meta.type === 'string' ? 'asc' : 'desc';
}

function sortIndicator(key, dir) {
  if (key === sortKey) return dir === 'asc' ? '▲' : '▼';
  return '↕';
}

function headerLabel(text, key) {
  // Show sort arrow; tooltip on inactive columns hints click-to-sort.
  const isActive = key === sortKey;
  const arrow = isActive ? sortIndicator(key, sortDir) : '↕';
  const arrowCls = isActive ? 'sort-arrow' : 'sort-arrow is-inactive';
  const tip = isActive
    ? (sortDir === 'desc' ? 'กดเพื่อเรียงน้อย→มาก' : 'กดเพื่อเรียงมาก→น้อย')
    : 'กดเพื่อเรียงตามคอลัมน์นี้';
  return `${text} <span class="${arrowCls}" title="${tip}">${arrow}</span>`;
}

function compareRows(a, b, key, dir) {
  const meta = SORT_FIELDS[key];
  if (!meta) return 0;
  const va = a[meta.field];
  const vb = b[meta.field];
  let cmp;
  if (meta.type === 'string') {
    cmp = String(va || '').localeCompare(String(vb || ''));
  } else {
    const na = Number.isFinite(va) ? va : -Infinity;
    const nb = Number.isFinite(vb) ? vb : -Infinity;
    cmp = na - nb;
  }
  return dir === 'desc' ? -cmp : cmp;
}

function getSortedRows() {
  return [...rankedData].sort((a, b) => compareRows(a, b, sortKey, sortDir));
}

/**
 * Build the HTML string for the current sorted rows. Used both for the
 * initial render (inside renderResult's template literal) and for subsequent
 * sort-change re-renders (renderTableBody).
 */

/**
 * FIX-2026-07-23: render EMA20 trend cell
 *   - 'upper' → บนเส้น (bullish) → 🟢 + ลูกศรขึ้น + gap%
 *   - 'lower' → ใต้เส้น (bearish) → 🔴 + ลูกศรลง + gap%
 *   - 'warmup' → ยังโหลดไม่ครบ → จาง + "warmup"
 */
function renderTrendEma(r) {
  if (!r || r.trendState === 'warmup' || r.trendEma20 == null) {
    // trendTF is server-controlled (from TREND_TF_MAP) — no need to escape
    const tf = r && r.trendTF ? ` ${r.trendTF}` : '';
    return `<span class="trend-state is-warmup">⏳ warmup${tf}</span>`;
  }
  const state = r.trendState;
  const arrow = state === 'upper' ? '▲' : '▼';
  const gapPct = Number.isFinite(r.trendGapPct) ? r.trendGapPct : 0;
  const gapSign = gapPct >= 0 ? '+' : '';
  const glyph = state === 'upper' ? '🟢' : '🔴';
  // trendTF is server-controlled (from TREND_TF_MAP) — safe to inject directly
  const tfLabel = r.trendTF || '';
  return `<span class="trend-state is-${state}" title="EMA20 (${tfLabel}): ${fmtNum(r.trendEma20, 6)} · lastClose: ${fmtNum(r.trendLastClose, 6)}">${glyph} ${arrow} ${gapSign}${gapPct.toFixed(2)}% <span class="trend-tf">${tfLabel}</span></span>`;
}

/**
 * FIX-2026-07-23: render suggested %TP cell
 *   - trend upper → kcMin/4 · สีเขียว
 *   - trend lower → kcMin/8 · สีแดง
 *   - warmup/null → "—"
 * FIX-2026-07-25: tooltip แสดงทั้ง NET (ที่เห็น) + GROSS + fee buffer
 *   - NET = ค่าที่ user จะเก็บใน bot.tpPercent (ตรงกับ Get TP% button + auto-update)
 */
function renderSuggestedTp(r) {
  if (r == null || r.suggestedTpPct == null || !Number.isFinite(r.suggestedTpPct)) {
    return `<span class="muted">—</span>`;
  }
  const state = r.trendState || 'unknown';
  const cls = state === 'upper' ? 'pnl-bull' : (state === 'lower' ? 'pnl-bear' : '');
  const tag = state === 'upper' ? '↗ upper' : '↘ lower';
  const gross = r.suggestedTpGross != null ? fmtNum(r.suggestedTpGross, 3) : '—';
  const fee = r.feeBufferPct != null ? fmtNum(r.feeBufferPct, 3) : '—';
  const title = `kcMin=${fmtNum(r.kcMinPct, 3)}% · trend=${state} · gross=${gross}% − fee=${fee}% = NET`;
  return `<span class="suggested-tp ${cls}" title="${title}">${fmtNum(r.suggestedTpPct, 3)}% <span class="muted small">${tag}</span></span>`;
}

function renderSortedRowsHTML() {
  const tf = lastParams ? lastParams.timeframe : '3m';
  const rows = getSortedRows();
  return rows.map((r, i) => {
    const scoreCls = summary && r.score >= summary.meanScore * 1.2
      ? 'pnl-bull'
      : (summary && r.score < summary.meanScore * 0.8 ? 'pnl-bear' : '');
    const atrCls = summary && r.currentAtrPct >= summary.meanAtr * 1.2
      ? 'pnl-bull'
      : (summary && r.currentAtrPct < summary.meanAtr * 0.8 ? 'pnl-bear' : '');
    const priceStr = formatPrice(r.lastClose);
    const trendKey = (r.trend || 'sideways').toLowerCase();
    const trendGlyph = trendKey === 'uptrend' ? '📈' : (trendKey === 'downtrend' ? '📉' : '↔️');
    const trendPill = `<span class="trend-pill is-${trendKey}">${trendGlyph} ${r.trend || 'sideways'}</span>`;
    return `
      <tr>
        <td class="num">${i + 1}</td>
        <td>
          <a href="/chart.html?symbol=${encodeURIComponent(r.symbol)}&timeframe=${encodeURIComponent(tf)}"
             class="mono fw-bold" style="color:var(--gold-1);">${r.symbol}</a>
        </td>
        <td>${trendPill}</td>
        <td class="num ${scoreCls}"><strong>${fmtNum(r.score, 2)}</strong></td>
        <td class="num">${fmtNum(r.avgVol, 3)}</td>
        <td class="num">${fmtNum(r.maxVol, 3)}</td>
        <td class="num">${fmtNum(r.volStd, 3)}</td>
        <td class="num">${(r.pctBarsAboveThreshold * 100).toFixed(0)}%</td>
        <td class="num ${atrCls}">${fmtNum(r.currentAtrPct, 3)}</td>
        <td class="num">${renderTrendEma(r)}</td>
        <td class="num">${fmtNum(r.kcMinPct, 3)}</td>
        <td class="num">${fmtNum(r.kcMaxPct, 3)}</td>
        <td class="num">${fmtNum(r.kcAvgPct, 3)}</td>
        <td class="num">${renderSuggestedTp(r)}</td>
        <td class="num mono">${priceStr}</td>
      </tr>
    `;
  }).join('');
}

/**
 * Re-render <tbody> only — preserves KPIs, legend card, scroll position.
 */
function renderTableBody() {
  const tbody = document.querySelector('#scan-results-table tbody');
  const subEl = document.getElementById('scan-results-sub');
  if (!tbody) return;
  tbody.innerHTML = renderSortedRowsHTML();
  updateSortHeaderIndicators();
  if (subEl) {
    const meta = SORT_FIELDS[sortKey];
    const fieldLabel = meta ? meta.field : sortKey;
    const dirLabel = sortDir === 'desc' ? 'มาก→น้อย' : 'น้อย→มาก';
    subEl.textContent = `เรียงตาม ${fieldLabel} (${dirLabel}) · trend filter: ${lastParams.trends.join(', ')}`;
  }
}

/**
 * Update header <th> arrow + is-active class in place.
 */
function updateSortHeaderIndicators() {
  const ths = document.querySelectorAll('#scan-results-table thead th.sortable');
  ths.forEach((th) => {
    const key = th.getAttribute('data-sort-key');
    const active = key === sortKey;
    th.classList.toggle('is-active', active);
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) {
      arrow.textContent = sortIndicator(key, sortDir);
      arrow.title = active
        ? (sortDir === 'desc' ? 'กดเพื่อเรียงน้อย→มาก' : 'กดเพื่อเรียงมาก→น้อย')
        : 'กดเพื่อเรียงตามคอลัมน์นี้';
    }
  });
}

/**
 * Click handler — delegated from <thead>. Toggle direction if same key,
 * otherwise switch to new key with default direction.
 */
function bindSortHandlers() {
  const thead = document.querySelector('#scan-results-table thead');
  if (!thead) return;
  thead.addEventListener('click', (ev) => {
    const th = ev.target.closest('th.sortable');
    if (!th) return;
    const key = th.getAttribute('data-sort-key');
    if (!key || !SORT_FIELDS[key]) return;
    if (key === sortKey) {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      sortKey = key;
      sortDir = defaultDirFor(key);
    }
    renderTableBody();
  });
}

init();