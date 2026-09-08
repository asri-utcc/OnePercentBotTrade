'use strict';

/**
 * 2026-09-02: Shareable Daily PnL Card (v2 — THB-first + portfolio status)
 * ────────────────────────────────────────────────────────────────────────────
 * สร้าง shareable card (SVG 800×1000) จาก dailyTarget + positions + wallet data
 * เพื่อให้ผู้ใช้ download เป็น PNG แล้วเอาไปแชร์โซเชียล
 *
 * Data shape (assembled by dailyTargetGauge.js):
 *   {
 *     // from /api/daily-target
 *     targetThb, todayPnlUsdt, todayPnlThb, fxRate, pct, zone,
 *     todayTrades, todayWins, todayLosses, winRate,
 *     todayGrossProfit, todayGrossLoss, ts,
 *
 *     // from /api/bot/positions
 *     holdingCount, holdingCostUsdt, holdingCostThb,
 *     totalUnrealizedUsdt, totalUnrealizedThb,
 *     worstPosition: { symbol, unrealizedUsdt, unrealizedThb, pct } | null,
 *
 *     // from /api/wallet/balances (USDT row only — usable)
 *     usableUsdt, usableThb,
 *   }
 *
 * Themes (5 zones — สีแตกต่างกันชัดเจน):
 *   - achieved (≥100%): RAINBOW + ANIMATED FIREWORKS + 🏆 (จุดพลุหลายดอก)
 *   - hot      (≥70%):  green-teal vibrant + 🚀
 *   - warming  (≥30%):  gold-amber + 🔥
 *   - cold     (≥0%):   blue-purple slate + 🥶
 *   - loss     (<0%):   red-crimson + 💔
 *
 * Layout (THB-first):
 *   1. Header (logo + date)
 *   2. Zone badge + headline
 *   3. HERO PnL (THB big + USDT subtitle)
 *   4. Progress bar (target)
 *   5. PORTFOLIO STATUS (2x2: holding / loss-total / worst-position / usable)
 *   6. TODAY TRADING (4 mini stats)
 *   7. Footer (hashtag)
 *
 * ใช้:
 *   ShareCard.showPreview(data) — เปิด preview modal + download
 *   ShareCard.buildSvg(data)    — return SVG string
 *   ShareCard.downloadPng(svg, fn) — trigger download PNG
 */

(function () {
  const W = 800;
  // 2026-09-05: H 1000 → 1100 เพื่อรองรับ MONTH TRADING section ใหม่
  const H = 1100;

  // ─── Zone themes ──────────────────────────────────────────────────────
  const ZONE_THEMES = {
    achieved: {
      label: 'ทะลุเป้าแล้ว!',
      emoji: '🏆',
      badge: '🎉 TARGET ACHIEVED 🎉',
      headline: 'ทะลุเป้าแล้ว!',
      headlineSub: 'วันนี้คุณคือผู้ชนะ',
      bg: 'achieved-bg',
      confetti: true,
      fireworks: true, // จุดพลุ
    },
    hot: {
      label: 'ใกล้เป้าแล้ว!',
      emoji: '🚀',
      badge: '🔥 HOT',
      headline: 'ใกล้เป้าแล้ว!',
      headlineSub: 'อีกนิดเดียว — ลุยต่อ',
      bg: 'hot-bg',
      confetti: false,
      fireworks: false,
    },
    warming: {
      label: 'กำลังอุ่นเครื่อง',
      emoji: '🔥',
      badge: '🔥 WARMING',
      headline: 'กำลังอุ่นเครื่อง',
      headlineSub: 'เก็บกำไรต่อเนื่อง',
      bg: 'warming-bg',
      confetti: false,
      fireworks: false,
    },
    cold: {
      label: 'ยังเย็น — ลุยต่อ',
      emoji: '🥶',
      badge: '🥶 COLD',
      headline: 'ยังเย็นอยู่',
      headlineSub: 'วันนี้ยังไม่หมด — ลุยต่อ!',
      bg: 'cold-bg',
      confetti: false,
      fireworks: false,
    },
    loss: {
      label: 'ขาดทุนวันนี้',
      emoji: '💔',
      badge: '💔 LOSS',
      headline: 'ขาดทุนวันนี้',
      headlineSub: 'พรุ่งนี้เริ่มใหม่ — สู้ต่อ',
      bg: 'loss-bg',
      confetti: false,
      fireworks: false,
    },
  };

  // ─── Color palette (locked — SVG ไม่ใช้ CSS vars) ────────────────────
  // achieved ใช้สีสันมากที่สุด + rainbow
  const PALETTE = {
    achieved: {
      bgFrom: '#1a0f3a', bgTo: '#3d1a5c',
      accent: '#ffd76a', accent2: '#f5b800',
      positive: '#00e5b8', negative: '#ff4d6d',
      cardBg: 'rgba(255,255,255,0.07)',
      cardBorder: 'rgba(255,215,106,0.40)',
      text: '#ffffff',
      textDim: 'rgba(255,255,255,0.78)',
      textMuted: 'rgba(255,255,255,0.50)',
      progressTrack: 'rgba(255,255,255,0.12)',
      progressFill: ['#f5b800', '#00e5b8', '#5dc4ff', '#ffd76a'],
      accentGlow: '#ffd76a',
      radialBurst: ['#f5b800', '#ffd76a', '#00e5b8', '#5dc4ff', '#a78bfa', '#ff4d6d', '#ffffff'],
    },
    hot: {
      bgFrom: '#003322', bgTo: '#005544',
      accent: '#00ffd0', accent2: '#00b894',
      positive: '#00e5b8', negative: '#ff4d6d',
      cardBg: 'rgba(0,229,184,0.08)',
      cardBorder: 'rgba(0,229,184,0.35)',
      text: '#ffffff',
      textDim: 'rgba(255,255,255,0.82)',
      textMuted: 'rgba(255,255,255,0.55)',
      progressTrack: 'rgba(0,229,184,0.14)',
      progressFill: ['#00b894', '#00ffd0'],
    },
    warming: {
      bgFrom: '#2d1c00', bgTo: '#5c3d00',
      accent: '#ffd76a', accent2: '#f5b800',
      positive: '#00e5b8', negative: '#ff4d6d',
      cardBg: 'rgba(245,184,0,0.08)',
      cardBorder: 'rgba(245,184,0,0.35)',
      text: '#ffffff',
      textDim: 'rgba(255,255,255,0.82)',
      textMuted: 'rgba(255,255,255,0.55)',
      progressTrack: 'rgba(245,184,0,0.14)',
      progressFill: ['#f5b800', '#ffd76a'],
    },
    cold: {
      bgFrom: '#0a1428', bgTo: '#1a2848',
      accent: '#8ab4ff', accent2: '#5b7290',
      positive: '#00e5b8', negative: '#ff4d6d',
      cardBg: 'rgba(138,180,255,0.06)',
      cardBorder: 'rgba(138,180,255,0.30)',
      text: '#ffffff',
      textDim: 'rgba(255,255,255,0.82)',
      textMuted: 'rgba(255,255,255,0.55)',
      progressTrack: 'rgba(138,180,255,0.14)',
      progressFill: ['#5b7290', '#8ab4ff'],
    },
    loss: {
      bgFrom: '#2a000a', bgTo: '#4d0018',
      accent: '#ff85a0', accent2: '#ff4d6d',
      positive: '#00e5b8', negative: '#ff4d6d',
      cardBg: 'rgba(255,77,109,0.08)',
      cardBorder: 'rgba(255,77,109,0.35)',
      text: '#ffffff',
      textDim: 'rgba(255,255,255,0.82)',
      textMuted: 'rgba(255,255,255,0.55)',
      progressTrack: 'rgba(255,77,109,0.14)',
      progressFill: ['#ff4d6d', '#ff85a0'],
    },
  };

  // ─── Helpers ──────────────────────────────────────────────────────────
  function escapeXml(s) {
    if (s == null) return '';
    return String(s).replace(/[<>&"']/g, (c) => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
    }[c]));
  }

  function fmtThb(n, opts = {}) {
    if (n == null || !isFinite(n)) return opts.fallback || '฿0.00';
    const v = Number(n);
    const sign = v < 0 ? '−' : '';
    const abs = Math.abs(v);
    const dp = opts.dp != null ? opts.dp : (abs >= 100000 ? 0 : abs >= 100 ? 1 : 2);
    const parts = abs.toFixed(dp).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${sign}฿${parts.join('.')}`;
  }

  function fmtUsdt(n, opts = {}) {
    if (n == null || !isFinite(n)) return opts.fallback || '0.00 USDT';
    const v = Number(n);
    const sign = v < 0 ? '−' : '+'; // realized มักมี + สำหรับกำไร
    const abs = Math.abs(v);
    const dp = opts.dp != null ? opts.dp : 2;
    return `${sign}${abs.toFixed(dp)} USDT`;
  }

  function fmtUsdtSigned(n, opts = {}) {
    // explicit sign for subtitle (always show +/-)
    if (n == null || !isFinite(n)) return opts.fallback || '0.00 USDT';
    const v = Number(n);
    const sign = v < 0 ? '−' : '+';
    const abs = Math.abs(v);
    const dp = opts.dp != null ? opts.dp : 2;
    return `${sign}${abs.toFixed(dp)} USDT`;
  }

  function fmtPct(n) {
    if (n == null || !isFinite(n)) return '0%';
    const v = Number(n);
    return `${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}%`;
  }

  function fmtCount(n) {
    return Number(n || 0).toString();
  }

  // เวลาที่ generate ภาพ (BKK) — format "📸 สร้างเมื่อ 14:35:42 น."
  function generatedAtStr(isoMs) {
    try {
      const d = new Date(Number(isoMs) || Date.now());
      const bkk = new Date(d.getTime() + 7 * 60 * 60_000);
      const hh = String(bkk.getUTCHours()).padStart(2, '0');
      const mm = String(bkk.getUTCMinutes()).padStart(2, '0');
      const ss = String(bkk.getUTCSeconds()).padStart(2, '0');
      return `📸 สร้างเมื่อ ${hh}:${mm}:${ss} น.`;
    } catch (_) { return '📸 สร้างเมื่อ —'; }
  }

  function bkkDateStr(isoMs) {
    try {
      const d = new Date(Number(isoMs) || Date.now());
      const bkk = new Date(d.getTime() + 7 * 60 * 60_000);
      const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                      'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
      return `${bkk.getUTCDate()} ${months[bkk.getUTCMonth()]} ${bkk.getUTCFullYear() + 543}`;
    } catch (_) { return ''; }
  }

  // ─── SVG defs (gradients + filters) ───────────────────────────────────
  function buildDefs(t, nonce) {
    const gradId = `bg-${nonce}`;
    const progId = `prog-${nonce}`;
    const accId  = `acc-${nonce}`;
    const stripeId = `stripe-${nonce}`;
    const glowId = `glow-${nonce}`;

    const fillStops = t.progressFill.map((c, i) => {
      const offset = (i / Math.max(1, t.progressFill.length - 1)) * 100;
      return `<stop offset="${offset}%" stop-color="${c}"/>`;
    }).join('');

    return `
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${t.bgFrom}"/>
          <stop offset="100%" stop-color="${t.bgTo}"/>
        </linearGradient>
        <linearGradient id="${progId}" x1="0" y1="0" x2="1" y2="0">${fillStops}</linearGradient>
        <linearGradient id="${accId}" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${t.accent}"/>
          <stop offset="100%" stop-color="${t.accent2}"/>
        </linearGradient>
        <pattern id="${stripeId}" patternUnits="userSpaceOnUse" width="40" height="40" patternTransform="rotate(45)">
          <rect width="40" height="40" fill="${t.accent}" opacity="0.05"/>
        </pattern>
        <filter id="${glowId}" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
    `;
  }

  // ─── Static confetti (for non-firework zones) ─────────────────────────
  function buildStaticConfetti() {
    const colors = ['#f5b800', '#ffd76a', '#00e5b8', '#5dc4ff', '#a78bfa', '#ff4d6d'];
    const dots = [];
    for (let i = 0; i < 28; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const r = 3 + Math.random() * 6;
      const c = colors[i % colors.length];
      const op = 0.3 + Math.random() * 0.4;
      dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${c}" opacity="${op.toFixed(2)}"/>`);
    }
    return dots.join('\n      ');
  }

  // ─── Animated FIREWORKS (achieved zone — จุดพลุ!) ─────────────────────
  // ใช้ SVG <animate> + <animateTransform> ทำให้ PNG export เป็น snapshot
  // ของเฟรมที่ animation กำลังเล่นอยู่ (canvas.drawImage จะ render เฟรมปัจจุบัน)
  function buildFireworks() {
    const colors = ['#f5b800', '#ffd76a', '#00e5b8', '#5dc4ff', '#a78bfa', '#ff4d6d', '#ffffff'];
    const bursts = [];
    // 4 จุดพลุ กระจายทั่ว card (เลี่ยง hero area)
    const positions = [
      { x: 180, y: 200, begin: '0s' },
      { x: 620, y: 180, begin: '1.2s' },
      { x: 200, y: 480, begin: '0.6s' },
      { x: 600, y: 500, begin: '1.8s' },
    ];

    for (const pos of positions) {
      const N = 14; // rays per burst
      const rays = [];
      const particles = [];
      for (let i = 0; i < N; i++) {
        const angle = (Math.PI * 2 * i) / N;
        const dist = 60 + Math.random() * 30;
        const ex = Math.cos(angle) * dist;
        const ey = Math.sin(angle) * dist;
        const c = colors[i % colors.length];
        // Ray line — scale from 0 → 1 over duration
        rays.push(`
          <line x1="0" y1="0" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}"
                stroke="${c}" stroke-width="2" stroke-linecap="round" opacity="0">
            <animate attributeName="opacity" values="0;1;0" dur="2s" repeatCount="indefinite" begin="${pos.begin}"/>
            <animateTransform attributeName="transform" type="scale" values="0;1.2;1.1" dur="2s" repeatCount="indefinite" begin="${pos.begin}" additive="sum"/>
          </line>
        `);
        // Sparkle particle (small circle) — fades with delay
        particles.push(`
          <circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="2.5" fill="${c}" opacity="0">
            <animate attributeName="opacity" values="0;1;0" dur="2s" repeatCount="indefinite" begin="${pos.begin}" calcMode="spline" keySplines="0.2 0 0.4 1; 0.6 0 0.8 1"/>
            <animate attributeName="r" values="0;3.5;1.5" dur="2s" repeatCount="indefinite" begin="${pos.begin}"/>
          </circle>
        `);
      }
      // Center flash
      const flash = `
        <circle cx="0" cy="0" r="6" fill="#ffffff" opacity="0" filter="url(#glow-ach)">
          <animate attributeName="opacity" values="0;1;0" dur="2s" repeatCount="indefinite" begin="${pos.begin}"/>
          <animate attributeName="r" values="0;14;4" dur="2s" repeatCount="indefinite" begin="${pos.begin}"/>
        </circle>
      `;
      bursts.push(`
        <g transform="translate(${pos.x}, ${pos.y})">
          ${rays.join('')}
          ${particles.join('')}
          ${flash}
        </g>
      `);
    }
    return bursts.join('\n      ');
  }

  // ─── Main SVG builder ─────────────────────────────────────────────────
  function buildSvg(d) {
    const zone = ZONE_THEMES[d.zone] ? d.zone : 'cold';
    const t = PALETTE[zone];
    const meta = ZONE_THEMES[zone];

    // Data extraction
    const fxRate = Number(d.fxRate) || 0;
    const todayPnlUsdt = Number(d.todayPnlUsdt) || 0;
    const todayPnlThb = Number(d.todayPnlThb) || 0;
    const targetThb = Number(d.targetThb) || 100;
    const pct = Number(d.pct) || 0;
    const trades = Number(d.todayTrades) || 0;
    const wins = Number(d.todayWins) || 0;
    const losses = Number(d.todayLosses) || 0;
    const winRate = Number(d.winRate) || 0;

    // New: portfolio status
    const holdingCount = Number(d.holdingCount) || 0;
    const holdingCostUsdt = Number(d.holdingCostUsdt) || 0;
    const holdingCostThb = holdingCostUsdt * fxRate;
    const totalUnrealizedUsdt = Number(d.totalUnrealizedUsdt) || 0;
    const totalUnrealizedThb = Number(d.totalUnrealizedThb) || (totalUnrealizedUsdt * fxRate);
    const worst = d.worstPosition || null;
    const usableUsdt = Number(d.usableUsdt) || 0;
    const usableThb = Number(d.usableThb) || (usableUsdt * fxRate);

    // 2026-09-05: month PnL (เดือนนี้ — from /api/pnl/calendar totals)
    const monthPnlUsdt = Number(d.monthPnlUsdt) || 0;
    const monthPnlThb = Number(d.monthPnlThb) || (monthPnlUsdt * fxRate);
    const monthTrades = Number(d.monthTrades) || 0;
    const monthWins = Number(d.monthWins) || 0;
    const monthLosses = Number(d.monthLosses) || 0;
    const monthWinRate = Number(d.monthWinRate) || 0;

    const isProfit = todayPnlUsdt >= 0;
    const pnlColor = isProfit ? t.positive : t.negative;

    // Progress (clamped 0..100)
    const pctClamped = Math.max(0, Math.min(100, pct));
    const progX = 80, progW = W - 160, progH = 22, progY = 460;

    const dateStr = bkkDateStr(d.ts || Date.now());
    const nonce = Math.random().toString(36).slice(2, 9);
    const defs = buildDefs(t, nonce);

    // For fireworks, use a fixed filter id (so animation refs work)
    const fireworksFilterId = `glow-ach`;

    // Choose headline ending
    const headlineSub = meta.headlineSub;
    const headline = meta.headline;

    // Hero: THB is BIG, USDT is subtitle
    const heroThb = fmtThb(todayPnlThb, { dp: 0 });
    const heroUsdt = fmtUsdtSigned(todayPnlUsdt, { dp: 2 });

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
     font-family="-apple-system, 'Segoe UI', 'Helvetica Neue', Arial, 'Noto Sans Thai', sans-serif">
  ${defs}
  ${zone === 'achieved' ? `<filter id="${fireworksFilterId}" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="4" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>` : ''}

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="url(#bg-${nonce})"/>
  <rect width="${W}" height="${H}" fill="url(#stripe-${nonce})"/>

  ${meta.confetti && !meta.fireworks ? `<g>${buildStaticConfetti()}</g>` : ''}
  ${meta.fireworks ? `<g opacity="0.95">${buildFireworks()}</g>` : ''}

  <!-- Top accent strip -->
  <rect x="0" y="0" width="${W}" height="6" fill="url(#acc-${nonce})"/>

  <!-- Header: brand + date -->
  <g transform="translate(60, 70)">
    <g>
      <path d="M 24 0 L 48 8 L 48 28 Q 48 44 24 56 Q 0 44 0 28 L 0 8 Z" fill="url(#acc-${nonce})" opacity="0.95"/>
      <text x="24" y="34" text-anchor="middle" font-size="22" font-weight="900" fill="${t.bgFrom}">1%</text>
    </g>
    <text x="68" y="32" font-size="22" font-weight="700" fill="${t.text}">OnePercent<tspan fill="${t.accent}">%</tspan>BotTrade</text>
    <text x="68" y="52" font-size="13" fill="${t.textDim}">Daily Trading Report</text>
  </g>

  <g transform="translate(${W - 60}, 70)">
    <rect x="-200" y="0" width="200" height="36" rx="18" fill="${t.cardBg}" stroke="${t.cardBorder}" stroke-width="1"/>
    <text x="-100" y="23" text-anchor="middle" font-size="14" fill="${t.textDim}">📅 ${escapeXml(dateStr)}</text>
  </g>

  <!-- Zone badge -->
  <g transform="translate(${W / 2}, 175)">
    <rect x="-180" y="-30" width="360" height="60" rx="30" fill="${t.cardBg}" stroke="${t.cardBorder}" stroke-width="2"/>
    <text x="0" y="8" text-anchor="middle" font-size="24" fill="${t.accent}" font-weight="700">${meta.emoji} ${escapeXml(meta.badge)}</text>
  </g>

  <!-- Headline -->
  <g transform="translate(${W / 2}, 235)">
    <text x="0" y="0" text-anchor="middle" font-size="22" font-weight="700" fill="${t.text}">${escapeXml(headline)}</text>
    <text x="0" y="26" text-anchor="middle" font-size="14" fill="${t.textDim}">${escapeXml(headlineSub)}</text>
  </g>

  <!-- HERO: PnL THB (big) + USDT subtitle -->
  <g transform="translate(${W / 2}, 365)">
    <text x="0" y="0" text-anchor="middle" font-size="86" font-weight="900" fill="${pnlColor}" letter-spacing="-3">${heroThb}</text>
    <text x="0" y="40" text-anchor="middle" font-size="22" fill="${t.textDim}" font-weight="600">${heroUsdt}</text>
  </g>

  <!-- Progress bar -->
  <g transform="translate(${progX}, ${progY})">
    <text x="0" y="-12" font-size="13" fill="${t.textDim}">🎯 เป้า ${fmtThb(targetThb, { dp: 0 })}</text>
    <text x="${progW}" y="-12" text-anchor="end" font-size="14" font-weight="700" fill="${t.accent}">${fmtPct(pct)}</text>
    <rect x="0" y="0" width="${progW}" height="${progH}" rx="${progH / 2}" fill="${t.progressTrack}" stroke="${t.cardBorder}" stroke-width="1"/>
    ${pctClamped > 0 ? `<rect x="0" y="0" width="${(progW * pctClamped / 100).toFixed(1)}" height="${progH}" rx="${progH / 2}" fill="url(#prog-${nonce})"/>` : ''}
  </g>

  <!-- Portfolio Status section -->
  <g transform="translate(60, 540)">
    <text x="0" y="0" font-size="13" font-weight="700" fill="${t.accent}" letter-spacing="2">📊 PORTFOLIO STATUS</text>
    <line x1="170" y1="-5" x2="${W - 120}" y2="-5" stroke="${t.cardBorder}" stroke-width="1"/>

    <!-- 2x2 grid -->
    <g transform="translate(0, 20)">
      <!-- Holding positions -->
      <g transform="translate(0, 0)">
        <rect width="330" height="120" rx="14" fill="${t.cardBg}" stroke="${t.cardBorder}" stroke-width="1"/>
        <text x="20" y="30" font-size="12" fill="${t.textMuted}" letter-spacing="1">ถืออยู่ (HOLDING)</text>
        <text x="20" y="68" font-size="34" font-weight="800" fill="${t.text}">${holdingCount} <tspan font-size="16" font-weight="500" fill="${t.textDim}">positions</tspan></text>
        <text x="20" y="98" font-size="16" fill="${t.textDim}">ต้นทุน ${fmtThb(holdingCostThb, { dp: 0 })}</text>
        <text x="310" y="80" text-anchor="end" font-size="32">💼</text>
      </g>

      <!-- Total unrealized loss -->
      <g transform="translate(350, 0)">
        <rect width="330" height="120" rx="14" fill="${t.cardBg}" stroke="${t.cardBorder}" stroke-width="1"/>
        <text x="20" y="30" font-size="12" fill="${t.textMuted}" letter-spacing="1">ขาดทุนรวม (UNREALIZED)</text>
        <text x="20" y="68" font-size="32" font-weight="800" fill="${totalUnrealizedUsdt < 0 ? t.negative : (totalUnrealizedUsdt > 0 ? t.positive : t.textMuted)}">
          ${totalUnrealizedUsdt < 0 ? '−' : totalUnrealizedUsdt > 0 ? '+' : ''}${fmtThb(Math.abs(totalUnrealizedThb), { dp: 0 })}
        </text>
        <text x="20" y="98" font-size="14" fill="${t.textDim}">${fmtUsdtSigned(totalUnrealizedUsdt, { dp: 2 })}</text>
        <text x="310" y="80" text-anchor="end" font-size="32">${totalUnrealizedUsdt < 0 ? '📉' : totalUnrealizedUsdt > 0 ? '📈' : '➖'}</text>
      </g>

      <!-- Worst position -->
      <g transform="translate(0, 140)">
        <rect width="330" height="120" rx="14" fill="${t.cardBg}" stroke="${t.cardBorder}" stroke-width="1"/>
        <text x="20" y="30" font-size="12" fill="${t.textMuted}" letter-spacing="1">ขาดทุนสุด (WORST)</text>
        ${worst ? `
          <text x="20" y="62" font-size="22" font-weight="800" fill="${t.text}">${escapeXml(worst.symbol || '—')}</text>
          <text x="20" y="92" font-size="22" font-weight="700" fill="${t.negative}">−${fmtThb(Math.abs(worst.unrealizedThb || 0), { dp: 0 })}</text>
          <text x="20" y="112" font-size="13" fill="${t.textDim}">−${Math.abs(Number(worst.unrealizedUsdt) || 0).toFixed(2)} USDT${worst.pct != null ? ' · ' + fmtPct(worst.pct) : ''}</text>
          <text x="310" y="80" text-anchor="end" font-size="32">😱</text>
        ` : `
          <text x="20" y="72" font-size="22" font-weight="600" fill="${t.textMuted}">ไม่มี position</text>
          <text x="310" y="80" text-anchor="end" font-size="32">😌</text>
        `}
      </g>

      <!-- Usable balance (USDT-first — ใช้ USDT เป็นหลัก) -->
      <g transform="translate(350, 140)">
        <rect width="330" height="120" rx="14" fill="${t.cardBg}" stroke="${t.cardBorder}" stroke-width="1"/>
        <text x="20" y="30" font-size="12" fill="${t.textMuted}" letter-spacing="1">เงินคงเหลือ (USABLE)</text>
        <text x="20" y="68" font-size="32" font-weight="800" fill="${t.accent}">${fmtUsdt(usableUsdt, { dp: 2 })}</text>
        <text x="20" y="98" font-size="14" fill="${t.textDim}">${fmtThb(usableThb, { dp: 0 })}</text>
        <text x="310" y="80" text-anchor="end" font-size="32">💰</text>
      </g>
    </g>
  </g>

  <!-- TODAY TRADING section -->
  <g transform="translate(60, 850)">
    <text x="0" y="0" font-size="13" font-weight="700" fill="${t.accent}" letter-spacing="2">📈 TODAY TRADING</text>
    <line x1="160" y1="-5" x2="${W - 120}" y2="-5" stroke="${t.cardBorder}" stroke-width="1"/>

    <g transform="translate(0, 20)">
      <g transform="translate(0, 0)">
        <text x="80" y="32" text-anchor="middle" font-size="32" font-weight="800" fill="${t.text}">${trades}</text>
        <text x="80" y="52" text-anchor="middle" font-size="11" fill="${t.textMuted}" letter-spacing="1">TRADES</text>
      </g>
      <g transform="translate(170, 0)">
        <text x="80" y="32" text-anchor="middle" font-size="32" font-weight="800" fill="${trades > 0 ? t.positive : t.textMuted}">${trades > 0 ? fmtPct(winRate) : '—'}</text>
        <text x="80" y="52" text-anchor="middle" font-size="11" fill="${t.textMuted}" letter-spacing="1">WIN RATE</text>
      </g>
      <g transform="translate(340, 0)">
        <text x="80" y="32" text-anchor="middle" font-size="28" font-weight="800" fill="${t.positive}">${wins}</text>
        <text x="80" y="52" text-anchor="middle" font-size="11" fill="${t.textMuted}" letter-spacing="1">ชนะ</text>
      </g>
      <g transform="translate(510, 0)">
        <text x="80" y="32" text-anchor="middle" font-size="28" font-weight="800" fill="${losses > 0 ? t.negative : t.textMuted}">${losses}</text>
        <text x="80" y="52" text-anchor="middle" font-size="11" fill="${t.textMuted}" letter-spacing="1">แพ้</text>
      </g>
    </g>
  </g>

  <!-- MONTH TRADING section — 2026-09-05: เพิ่ม PnL เดือนนี้ -->
  <g transform="translate(60, 950)">
    <text x="0" y="0" font-size="13" font-weight="700" fill="${t.accent}" letter-spacing="2">📅 MONTH TRADING ${escapeXml(d.monthLabel || '')}</text>
    <line x1="200" y1="-5" x2="${W - 120}" y2="-5" stroke="${t.cardBorder}" stroke-width="1"/>

    <g transform="translate(0, 20)">
      <!-- Month PnL (THB big) -->
      <g transform="translate(0, 0)">
        <text x="80" y="32" text-anchor="middle" font-size="28" font-weight="800" fill="${monthPnlUsdt >= 0 ? t.positive : t.negative}">${fmtThb(monthPnlThb, { dp: 0 })}</text>
        <text x="80" y="52" text-anchor="middle" font-size="11" fill="${t.textMuted}" letter-spacing="1">MONTH PnL</text>
        <text x="80" y="68" text-anchor="middle" font-size="10" fill="${t.textMuted}" opacity="0.75">${fmtUsdtSigned(monthPnlUsdt, { dp: 2 })}</text>
      </g>
      <!-- Month Trades -->
      <g transform="translate(170, 0)">
        <text x="80" y="32" text-anchor="middle" font-size="32" font-weight="800" fill="${t.text}">${monthTrades}</text>
        <text x="80" y="52" text-anchor="middle" font-size="11" fill="${t.textMuted}" letter-spacing="1">TRADES</text>
      </g>
      <!-- Month Win rate -->
      <g transform="translate(340, 0)">
        <text x="80" y="32" text-anchor="middle" font-size="32" font-weight="800" fill="${monthTrades > 0 ? t.positive : t.textMuted}">${monthTrades > 0 ? fmtPct(monthWinRate) : '—'}</text>
        <text x="80" y="52" text-anchor="middle" font-size="11" fill="${t.textMuted}" letter-spacing="1">WIN RATE</text>
      </g>
      <!-- Month W/L -->
      <g transform="translate(510, 0)">
        <text x="80" y="20" text-anchor="middle" font-size="22" font-weight="800" fill="${t.positive}">${monthWins}W</text>
        <text x="80" y="44" text-anchor="middle" font-size="22" font-weight="800" fill="${monthLosses > 0 ? t.negative : t.textMuted}">${monthLosses}L</text>
        <text x="80" y="62" text-anchor="middle" font-size="11" fill="${t.textMuted}" letter-spacing="1">เดือนนี้</text>
      </g>
    </g>
  </g>

  <!-- Footer -->
  <g transform="translate(${W / 2}, 1075)">
    <text x="0" y="0" text-anchor="middle" font-size="13" font-weight="700" fill="${t.text}">#OnePercentBotTrade</text>
    ${zone === 'achieved' ? `<text x="0" y="20" text-anchor="middle" font-size="11" fill="${t.textMuted}">✨ ทุกวันคือโอกาส — วันนี้คุณทำได้! ✨</text>` : ''}
    <text x="0" y="${zone === 'achieved' ? 40 : 22}" text-anchor="middle" font-size="10" fill="${t.textMuted}" opacity="0.85">${escapeXml(generatedAtStr(d.generatedAt || d.ts || Date.now()))}</text>
  </g>
</svg>`;
    return svg;
  }

  // ─── SVG → PNG ────────────────────────────────────────────────────────
  // 2026-09-08: แยก compress option (scale + quality) ออกมา — Telegram ใช้
  //   ภาพเล็กกว่า + quality ต่ำกว่าได้ (server-side compress อีกทีอยู่แล้ว) ทำให้
  //   payload base64 ลดลง ~70% (จาก ~280 KB → ~80 KB) หลบ 413 Request Entity
  //   Too Large จาก express.json limit 1 MB
  // opts: { scale?: number (default 1), quality?: number 0..1 (default 0.95) }
  function svgStringToPngBlob(svgString, opts) {
    const scale = (opts && Number(opts.scale)) > 0 && (opts.scale) <= 1 ? Number(opts.scale) : 1;
    const quality = opts && Number.isFinite(opts.quality) ? Number(opts.quality) : 0.95;
    return new Promise((resolve, reject) => {
      try {
        if (!svgString.startsWith('<?xml')) {
          svgString = '<?xml version="1.0" encoding="UTF-8"?>' + svgString;
        }
        const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          // render with a tiny delay so animation can tick before snapshot
          setTimeout(() => {
            const canvas = document.createElement('canvas');
            const outW = Math.round(W * scale);
            const outH = Math.round(H * scale);
            canvas.width = outW;
            canvas.height = outH;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, outW, outH);
            URL.revokeObjectURL(url);
            canvas.toBlob((pngBlob) => {
              if (pngBlob) resolve(pngBlob);
              else reject(new Error('canvas.toBlob returned null'));
            }, 'image/png', quality);
          }, 200);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('SVG image failed to load'));
        };
        img.src = url;
      } catch (err) {
        reject(err);
      }
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function defaultFilename(d) {
    const date = new Date(Number(d && d.ts) || Date.now());
    const bkk = new Date(date.getTime() + 7 * 60 * 60_000);
    const y = bkk.getUTCFullYear();
    const m = String(bkk.getUTCMonth() + 1).padStart(2, '0');
    const day = String(bkk.getUTCDate()).padStart(2, '0');
    const zone = (d && d.zone) || 'cold';
    return `onepercent-pnl-${y}${m}${day}-${zone}.png`;
  }

  async function downloadPng(svgString, filename) {
    const blob = await svgStringToPngBlob(svgString);
    downloadBlob(blob, filename);
    return blob;
  }

  // ─── Preview Modal ────────────────────────────────────────────────────
  function ensureModal() {
    let modal = document.getElementById('share-card-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'share-card-modal';
    modal.className = 'share-card-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Share Daily PnL Card Preview');
    modal.innerHTML = `
      <div class="share-card-backdrop" data-close></div>
      <div class="share-card-dialog">
        <div class="share-card-header">
          <h3>📸 การ์ดสรุปผลประจำวัน</h3>
          <button type="button" class="share-card-close" data-close aria-label="ปิด">✕</button>
        </div>
        <div class="share-card-preview-wrap">
          <img id="share-card-preview-img" alt="Share card preview" />
        </div>
        <div class="share-card-actions">
          <button type="button" class="share-card-btn share-card-btn-secondary" data-close>ยกเลิก</button>
          <button type="button" class="share-card-btn share-card-btn-telegram" id="share-card-telegram" title="ส่งการ์ดนี้ไปยัง Telegram chat ที่ตั้งค่าไว้">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
              <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/>
            </svg>
            ส่งไป Telegram
          </button>
          <button type="button" class="share-card-btn share-card-btn-primary" id="share-card-download">
            💾 ดาวน์โหลด PNG
          </button>
        </div>
        <div class="share-card-hint">
          การ์ดนี้ออกแบบมาสำหรับแชร์ไปยังโซเชียลมีเดีย (IG/FB/Discord/Line/Telegram)
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', closePreview);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('is-open')) {
        closePreview();
      }
    });

    return modal;
  }

  function showPreview(d) {
    if (!d) {
      console.warn('ShareCard.showPreview: no data');
      return;
    }
    const modal = ensureModal();
    const img = document.getElementById('share-card-preview-img');
    const dlBtn = document.getElementById('share-card-download');
    const tgBtn = document.getElementById('share-card-telegram');

    // Stamp generation time (BKK) so the SVG footer + caption both reflect it
    const dataWithTs = { ...d, generatedAt: Date.now() };
    const svg = buildSvg(dataWithTs);
    const caption = buildTelegramCaption(dataWithTs);

    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.src = url;
    img.dataset.svg = svg;
    img.dataset.caption = caption;
    img.dataset.filename = defaultFilename(dataWithTs);
    img.dataset.url = url;

    const newDl = dlBtn.cloneNode(true);
    dlBtn.parentNode.replaceChild(newDl, dlBtn);
    newDl.addEventListener('click', async () => {
      try {
        newDl.disabled = true;
        newDl.textContent = '⏳ กำลังสร้าง PNG...';
        await downloadPng(svg, img.dataset.filename);
        newDl.textContent = '✅ ดาวน์โหลดแล้ว!';
        setTimeout(() => closePreview(), 700);
      } catch (err) {
        console.error('ShareCard download failed', err);
        newDl.textContent = '❌ ล้มเหลว — ลองอีกครั้ง';
        setTimeout(() => {
          newDl.disabled = false;
          newDl.textContent = '💾 ดาวน์โหลด PNG';
        }, 1500);
      }
    });

    // Wire Telegram button (clone to drop stale handlers)
    if (tgBtn) {
      const newTg = tgBtn.cloneNode(true);
      tgBtn.parentNode.replaceChild(newTg, tgBtn);
      newTg.addEventListener('click', async () => {
        await sendToTelegramHandler(svg, img.dataset.caption, newTg);
      });
    }

    modal.classList.add('is-open');
    document.body.classList.add('share-card-modal-open');
  }

  // Build Telegram caption (HTML parse mode)
  // Format: emoji + headline + PnL THB + USDT + zone + tags
  function buildTelegramCaption(d) {
    const zone = ZONE_THEMES[d.zone] ? d.zone : 'cold';
    const meta = ZONE_THEMES[zone];
    const fxRate = Number(d.fxRate) || 0;
    const pnlUsdt = Number(d.todayPnlUsdt) || 0;
    const pnlThb = Number(d.todayPnlThb) || (pnlUsdt * fxRate);
    const isProfit = pnlUsdt >= 0;
    const sign = isProfit ? '+' : '−';
    const trades = Number(d.todayTrades) || 0;
    const wins = Number(d.todayWins) || 0;
    const losses = Number(d.todayLosses) || 0;
    const winRate = Number(d.winRate) || 0;
    const holdingCount = Number(d.holdingCount) || 0;
    const totalUnrealizedUsdt = Number(d.totalUnrealizedUsdt) || 0;
    const worst = d.worstPosition;
    const usableUsdt = Number(d.usableUsdt) || 0;

    const safeHtml = (s) => escapeXml(String(s));
    // 2026-09-05: เพิ่ม month PnL fields
    const monthPnlUsdt = Number(d.monthPnlUsdt) || 0;
    const monthPnlThb = Number(d.monthPnlThb) || (monthPnlUsdt * fxRate);
    const monthTrades = Number(d.monthTrades) || 0;
    const monthWins = Number(d.monthWins) || 0;
    const monthLosses = Number(d.monthLosses) || 0;
    const monthWinRate = Number(d.monthWinRate) || 0;
    const monthLabel = d.monthLabel || '';

    const lines = [];
    lines.push(`${meta.emoji} <b>${safeHtml(meta.headline)}</b>`);
    lines.push(`<b>PnL: ${sign}${fmtUsdt(pnlUsdt, { dp: 2 }).replace(' USDT', '')} USDT (${fmtThb(pnlThb, { dp: 0 })})</b>`);
    lines.push('');
    lines.push(`📊 Today: <b>${trades}</b> trades (${wins}W / ${losses}L) · Win rate: <b>${trades > 0 ? fmtPct(winRate) : '—'}</b>`);
    // 2026-09-05: เพิ่ม "เดือนนี้" summary
    if (monthTrades > 0 || monthPnlUsdt !== 0) {
      const monthSign = monthPnlUsdt >= 0 ? '+' : '−';
      lines.push(`📅 เดือนนี้${monthLabel ? ' (' + safeHtml(monthLabel) + ')' : ''}: <b>${monthSign}${Math.abs(monthPnlUsdt).toFixed(2)} USDT (${fmtThb(monthPnlThb, { dp: 0 })})</b>`);
      lines.push(`   · <b>${monthTrades}</b> trades (${monthWins}W / ${monthLosses}L) · Win rate: <b>${fmtPct(monthWinRate)}</b>`);
    }
    lines.push(`💼 Holding: <b>${holdingCount}</b> positions · Loss: <b>${fmtUsdt(totalUnrealizedUsdt, { dp: 2 })}</b>`);
    if (worst && worst.symbol && worst.unrealizedUsdt < 0) {
      lines.push(`😱 Worst: <b>${safeHtml(worst.symbol)}</b> ${fmtUsdt(worst.unrealizedUsdt, { dp: 2 })}`);
    }
    lines.push(`💰 Usable: <b>${fmtUsdt(usableUsdt, { dp: 2 })}</b>`);
    lines.push('');
    lines.push(`<i>#OnePercentBotTrade · ${generatedAtStr(d.generatedAt || d.ts || Date.now())}</i>`);

    // Telegram caption hard limit 1024 chars
    const cap = lines.join('\n');
    return cap.length > 1024 ? cap.slice(0, 1021) + '…' : cap;
  }

  async function sendToTelegramHandler(svgString, caption, btn) {
    if (!btn) return;
    const original = btn.innerHTML;
    try {
      btn.disabled = true;
      btn.innerHTML = '⏳ กำลังแปลงเป็น PNG...';
      // 2026-09-08: compress (scale 0.75 → 600×825, quality 0.85) เพื่อหลบ
      //   HTTP 413 Request Entity Too Large จาก express.json limit 1 MB
      //   Telegram ก็ compress ฝั่ง server + แสดงสูงสุด ~1280px width อยู่แล้ว
      const pngBlob = await svgStringToPngBlob(svgString, { scale: 0.75, quality: 0.85 });
      if (!pngBlob) throw new Error('PNG conversion failed');
      btn.innerHTML = '⏳ กำลังส่งไป Telegram...';
      // base64 encode for POST
      const arrayBuf = await pngBlob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      let bin = '';
      // chunk to avoid call stack overflow on large buffers
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      const pngBase64 = btoa(bin);
      const res = await fetch('/api/share-card/send-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pngBase64, caption }),
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        btn.innerHTML = '✅ ส่งแล้ว!';
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = original;
        }, 2200);
      } else {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      console.error('ShareCard telegram send failed', err);
      btn.innerHTML = `❌ ${err.message || 'ล้มเหลว'}`;
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = original;
      }, 2500);
    }
  }

  function closePreview() {
    const modal = document.getElementById('share-card-modal');
    if (!modal) return;
    modal.classList.remove('is-open');
    document.body.classList.remove('share-card-modal-open');
    const img = document.getElementById('share-card-preview-img');
    if (img && img.dataset.url) {
      URL.revokeObjectURL(img.dataset.url);
      delete img.dataset.url;
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────
  window.ShareCard = {
    buildSvg,
    downloadPng,
    showPreview,
    closePreview,
    sendToTelegram: sendToTelegramHandler,
    buildTelegramCaption,
    ZONE_THEMES,
    PALETTE,
    fmtThb,
    fmtUsdt,
  };
})();
