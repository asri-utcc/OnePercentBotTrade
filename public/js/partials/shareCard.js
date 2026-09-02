'use strict';

/**
 * 2026-09-02: Shareable Daily PnL Card
 * ────────────────────────────────────────────────────────────────────────────
 * สร้าง shareable card (SVG 800×1000) จาก dailyTarget data เพื่อให้ผู้ใช้ download
 * เป็น PNG แล้วเอาไปแชร์ให้เพื่อนๆ ดูความสำเร็จ/ความล้มเหลวของวันนี้
 *
 * - ไม่ต้องพึ่ง html2canvas (เพิ่ม dependency ใหม่)
 * - Theme เปลี่ยนตาม zone:
 *     achieved: rainbow gradient + 🏆 + "ทะลุเป้าแล้ว 🎉" (ลูกเล่นโดดเด่น)
 *     hot:      bull-green gradient + 🚀
 *     warming:  gold gradient + 🔥
 *     cold:     steel-blue + 🥶
 *     loss:     red + 💔 "ขาดทุนวันนี้"
 * - ขนาด 800×1000 (เหมาะแชร์ IG/FB/Twitter/Discord)
 * - มี preview modal + ปุ่ม download PNG
 *
 * Public API (บน window.ShareCard):
 *   - ShareCard.buildSvg(data)        → SVG string
 *   - ShareCard.downloadPng(svg, fn)  → trigger download
 *   - ShareCard.showPreview(data)     → เปิด modal preview
 *
 * ใช้ร่วมกับ dailyTargetGauge.js — ปุ่ม "📸 สร้างการ์ด" ใน popover จะเรียก
 * ShareCard.showPreview(window.__dtb.data)
 */

(function () {
  const W = 800;
  const H = 1000;

  // ─── Theme per zone ────────────────────────────────────────────────────
  const ZONE_THEMES = {
    achieved: {
      // rainbow + gold (ลูกเล่นโดดเด่นกว่าโซนอื่น)
      label: 'ทะลุเป้าแล้ว! 🎉',
      emoji: '🏆',
      badge: '🎉 TARGET ACHIEVED 🎉',
      bg: 'achieved-bg',
      glow: 'achieved-glow',
      confetti: true,
      headline: 'ทะลุเป้าแล้ว!',
      headlineSub: 'วันนี้คุณคือผู้ชนะ 🏆',
    },
    hot: {
      label: 'ใกล้เป้าแล้ว!',
      emoji: '🚀',
      badge: '🔥 HOT',
      bg: 'hot-bg',
      glow: 'hot-glow',
      confetti: false,
      headline: 'ใกล้เป้าแล้ว!',
      headlineSub: 'อีกนิดเดียว — ลุยต่อ 🚀',
    },
    warming: {
      label: 'กำลังอุ่นเครื่อง',
      emoji: '🔥',
      badge: '🔥 WARMING',
      bg: 'warming-bg',
      glow: 'warming-glow',
      confetti: false,
      headline: 'กำลังอุ่นเครื่อง',
      headlineSub: 'เก็บกำไรต่อเนื่อง 🔥',
    },
    cold: {
      label: 'ยังเย็น — ลุยต่อ!',
      emoji: '🥶',
      badge: '🥶 COLD',
      bg: 'cold-bg',
      glow: 'cold-glow',
      confetti: false,
      headline: 'ยังเย็นอยู่',
      headlineSub: 'วันนี้ยังไม่หมด — ลุยต่อ!',
    },
    loss: {
      label: 'ขาดทุนวันนี้',
      emoji: '💔',
      badge: '💔 LOSS',
      bg: 'loss-bg',
      glow: 'loss-glow',
      confetti: false,
      headline: 'ขาดทุนวันนี้',
      headlineSub: 'พรุ่งนี้เริ่มใหม่ — สู้ต่อ 💪',
    },
  };

  // ─── Palette (locked colors สำหรับ SVG เพราะ CSS vars ใช้ใน DOM เท่านั้น) ─
  const PALETTE = {
    achieved: {
      bgFrom:    '#1a0f3a',
      bgTo:      '#3d1a5c',
      accent:    '#ffd76a',
      accent2:   '#f5b800',
      positive:  '#00e5b8',
      negative:  '#ff4d6d',
      cardBg:    'rgba(255,255,255,0.06)',
      cardBorder:'rgba(255,215,106,0.35)',
      text:      '#ffffff',
      textDim:   'rgba(255,255,255,0.72)',
      textMuted: 'rgba(255,255,255,0.45)',
      progressTrack: 'rgba(255,255,255,0.10)',
      progressFill:  ['#f5b800', '#00e5b8', '#5dc4ff', '#ffd76a'],
    },
    hot: {
      bgFrom:    '#001a1a',
      bgTo:      '#003d33',
      accent:    '#00e5b8',
      accent2:   '#80ffd0',
      positive:  '#00e5b8',
      negative:  '#ff4d6d',
      cardBg:    'rgba(0,229,184,0.06)',
      cardBorder:'rgba(0,229,184,0.30)',
      text:      '#ffffff',
      textDim:   'rgba(255,255,255,0.78)',
      textMuted: 'rgba(255,255,255,0.50)',
      progressTrack: 'rgba(0,229,184,0.12)',
      progressFill:  ['#00e5b8', '#80ffd0'],
    },
    warming: {
      bgFrom:    '#1f1500',
      bgTo:      '#3d2c00',
      accent:    '#ffd76a',
      accent2:   '#f5b800',
      positive:  '#00e5b8',
      negative:  '#ff4d6d',
      cardBg:    'rgba(245,184,0,0.06)',
      cardBorder:'rgba(245,184,0,0.30)',
      text:      '#ffffff',
      textDim:   'rgba(255,255,255,0.78)',
      textMuted: 'rgba(255,255,255,0.50)',
      progressTrack: 'rgba(245,184,0,0.12)',
      progressFill:  ['#f5b800', '#ffd76a'],
    },
    cold: {
      bgFrom:    '#0a1024',
      bgTo:      '#15203d',
      accent:    '#90b0d8',
      accent2:   '#5b7290',
      positive:  '#00e5b8',
      negative:  '#ff4d6d',
      cardBg:    'rgba(255,255,255,0.04)',
      cardBorder:'rgba(144,176,216,0.25)',
      text:      '#ffffff',
      textDim:   'rgba(255,255,255,0.78)',
      textMuted: 'rgba(255,255,255,0.50)',
      progressTrack: 'rgba(144,176,216,0.15)',
      progressFill:  ['#5b7290', '#90b0d8'],
    },
    loss: {
      bgFrom:    '#1f0008',
      bgTo:      '#3d0014',
      accent:    '#ff85a0',
      accent2:   '#ff4d6d',
      positive:  '#00e5b8',
      negative:  '#ff4d6d',
      cardBg:    'rgba(255,77,109,0.06)',
      cardBorder:'rgba(255,77,109,0.30)',
      text:      '#ffffff',
      textDim:   'rgba(255,255,255,0.78)',
      textMuted: 'rgba(255,255,255,0.50)',
      progressTrack: 'rgba(255,77,109,0.12)',
      progressFill:  ['#ff4d6d', '#ff85a0'],
    },
  };

  // ─── Helpers ───────────────────────────────────────────────────────────
  function escapeXml(s) {
    if (s == null) return '';
    return String(s).replace(/[<>&"']/g, (c) => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
    }[c]));
  }

  function fmtThb(n) {
    if (n == null || !isFinite(n)) return '฿0.00';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(Number(n));
    return `${sign}฿${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function fmtUsdt(n) {
    if (n == null || !isFinite(n)) return '0.0000 USDT';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(Number(n));
    return `${sign}${abs.toFixed(4)} USDT`;
  }

  function fmtPct(n) {
    if (n == null || !isFinite(n)) return '0%';
    const v = Number(n);
    return `${v.toFixed(v >= 100 ? 0 : 1)}%`;
  }

  function bkkDateStr(isoMs) {
    try {
      const d = new Date(Number(isoMs) || Date.now());
      // Convert to BKK (UTC+7)
      const bkk = new Date(d.getTime() + 7 * 60 * 60_000);
      const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                      'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
      const day = bkk.getUTCDate();
      const mon = months[bkk.getUTCMonth()];
      const yr = bkk.getUTCFullYear() + 543; // พ.ศ.
      return `${day} ${mon} ${yr}`;
    } catch (_) { return ''; }
  }

  // ─── SVG primitives ────────────────────────────────────────────────────
  function buildDefns(theme) {
    const gradId = `bg-${Math.random().toString(36).slice(2, 9)}`;
    const progId = `prog-${Math.random().toString(36).slice(2, 9)}`;
    const accId  = `acc-${Math.random().toString(36).slice(2, 9)}`;
    const stripeId = `stripe-${Math.random().toString(36).slice(2, 9)}`;

    const fillStops = theme.progressFill.map((c, i) => {
      const offset = (i / Math.max(1, theme.progressFill.length - 1)) * 100;
      return `<stop offset="${offset}%" stop-color="${c}"/>`;
    }).join('');

    return `
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${theme.bgFrom}"/>
          <stop offset="100%" stop-color="${theme.bgTo}"/>
        </linearGradient>
        <linearGradient id="${progId}" x1="0" y1="0" x2="1" y2="0">
          ${fillStops}
        </linearGradient>
        <linearGradient id="${accId}" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${theme.accent}"/>
          <stop offset="100%" stop-color="${theme.accent2}"/>
        </linearGradient>
        <pattern id="${stripeId}" patternUnits="userSpaceOnUse" width="40" height="40" patternTransform="rotate(45)">
          <rect width="40" height="40" fill="${theme.accent}" opacity="0.04"/>
        </pattern>
      </defs>
    `.replace(/<!--[\s\S]*?-->/g, ''); // strip any accidental comments
  }

  // Confetti dots for achieved zone
  function buildConfetti() {
    const colors = ['#f5b800', '#ffd76a', '#00e5b8', '#5dc4ff', '#a78bfa', '#ff4d6d'];
    const dots = [];
    const N = 36;
    for (let i = 0; i < N; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const r = 4 + Math.random() * 8;
      const c = colors[i % colors.length];
      const op = 0.4 + Math.random() * 0.5;
      const rot = Math.random() * 360;
      dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${c}" opacity="${op.toFixed(2)}" transform="rotate(${rot.toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`);
    }
    // Trophy sparkle stars
    for (let i = 0; i < 8; i++) {
      const x = 200 + Math.random() * 400;
      const y = 280 + Math.random() * 200;
      const sz = 6 + Math.random() * 10;
      dots.push(`<path d="M ${x} ${y - sz} L ${x + sz * 0.3} ${y - sz * 0.3} L ${x + sz} ${y} L ${x + sz * 0.3} ${y + sz * 0.3} L ${x} ${y + sz} L ${x - sz * 0.3} ${y + sz * 0.3} L ${x - sz} ${y} L ${x - sz * 0.3} ${y - sz * 0.3} Z" fill="${colors[i % colors.length]}" opacity="0.8"/>`);
    }
    return dots.join('\n      ');
  }

  // ─── Main SVG builder ──────────────────────────────────────────────────
  function buildSvg(d) {
    const zone = ZONE_THEMES[d.zone] ? d.zone : 'cold';
    const t = PALETTE[zone];
    const meta = ZONE_THEMES[zone];

    const todayPnlUsdt = Number(d.todayPnlUsdt) || 0;
    const todayPnlThb  = Number(d.todayPnlThb) || 0;
    const targetThb    = Number(d.targetThb) || 100;
    const pct          = Number(d.pct) || 0;
    const trades       = Number(d.todayTrades) || 0;
    const wins         = Number(d.todayWins) || 0;
    const losses       = Number(d.todayLosses) || 0;
    const winRate      = Number(d.winRate) || 0;
    const grossWinUsdt = Number(d.todayGrossProfit) || 0;
    const grossLossUsdt= Number(d.todayGrossLoss) || 0;
    const grossWinThb  = grossWinUsdt * (Number(d.fxRate) || 0);
    const grossLossThb = Math.abs(grossLossUsdt) * (Number(d.fxRate) || 0);

    const defns = buildDefns(t);
    const gradMatch = defns.match(/id="(bg-[a-z0-9]+)"/);
    const gradId = gradMatch ? gradMatch[1] : 'bg';
    const progMatch = defns.match(/id="(prog-[a-z0-9]+)"/);
    const progId = progMatch ? progMatch[1] : 'prog';
    const accMatch = defns.match(/id="(acc-[a-z0-9]+)"/);
    const accId = accMatch ? accMatch[1] : 'acc';
    const stripeMatch = defns.match(/id="(stripe-[a-z0-9]+)"/);
    const stripeId = stripeMatch ? stripeMatch[1] : 'stripe';

    const isProfit = todayPnlUsdt >= 0;
    const pnlSign  = isProfit ? '+' : '−';
    const pnlColor = isProfit ? t.positive : t.negative;

    // Progress width — clamp 0..100 for visual, even if pct > 100
    const pctClamped = Math.max(0, Math.min(100, pct));
    const progX = 80;
    const progW = W - 160;
    const progH = 22;
    const progY = 540;

    const dateStr = bkkDateStr(d.ts || Date.now());
    const achievedSparkle = zone === 'achieved';

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif">
  ${defns}

  <!-- Background gradient -->
  <rect width="${W}" height="${H}" fill="url(#${gradId})"/>
  <rect width="${W}" height="${H}" fill="url(#${stripeId})"/>

  ${meta.confetti ? `<!-- Achieved confetti -->
  <g opacity="0.85">${buildConfetti()}</g>` : ''}

  <!-- Top accent strip -->
  <rect x="0" y="0" width="${W}" height="6" fill="url(#${accId})"/>

  <!-- Header: brand -->
  <g transform="translate(60, 70)">
    <!-- Shield+1% mini logo -->
    <g transform="translate(0, 0)">
      <path d="M 24 0 L 48 8 L 48 28 Q 48 44 24 56 Q 0 44 0 28 L 0 8 Z"
            fill="url(#${accId})" opacity="0.95"/>
      <text x="24" y="34" text-anchor="middle" font-size="22" font-weight="900" fill="${t.bgFrom}">1%</text>
    </g>
    <text x="68" y="32" font-size="22" font-weight="700" fill="${t.text}">OnePercent<tspan fill="${t.accent}">%</tspan>BotTrade</text>
    <text x="68" y="52" font-size="14" fill="${t.textDim}">Daily Trading Report</text>
  </g>

  <!-- Date pill (top right) -->
  <g transform="translate(${W - 60}, 70)">
    <rect x="-180" y="0" width="180" height="36" rx="18" fill="${t.cardBg}" stroke="${t.cardBorder}" stroke-width="1"/>
    <text x="-90" y="23" text-anchor="middle" font-size="14" fill="${t.textDim}">📅 ${escapeXml(dateStr)}</text>
  </g>

  <!-- Zone badge -->
  <g transform="translate(${W / 2}, 200)">
    <rect x="-160" y="-30" width="320" height="60" rx="30" fill="${t.cardBg}" stroke="${t.cardBorder}" stroke-width="2"/>
    <text x="0" y="8" text-anchor="middle" font-size="28" fill="${t.accent}">${meta.emoji} ${escapeXml(meta.badge)}</text>
  </g>

  <!-- Hero: Big PnL number -->
  <g transform="translate(${W / 2}, 320)">
    <text x="0" y="0" text-anchor="middle" font-size="22" font-weight="500" fill="${t.textDim}" letter-spacing="2">${escapeXml(meta.headline.toUpperCase())}</text>
    <text x="0" y="80" text-anchor="middle" font-size="22" fill="${t.textMuted}">${escapeXml(meta.headlineSub)}</text>

    <!-- Big PnL (USDT) -->
    <text x="0" y="170" text-anchor="middle" font-size="92" font-weight="900" fill="${pnlColor}" letter-spacing="-2">${pnlSign}${fmtUsdt(todayPnlUsdt).replace(' USDT', '')}</text>
    <text x="0" y="200" text-anchor="middle" font-size="18" fill="${t.textDim}">USDT</text>

    <!-- THB equivalent -->
    <text x="0" y="240" text-anchor="middle" font-size="20" fill="${t.textDim}">${fmtThb(todayPnlThb)}</text>
  </g>

  <!-- Progress bar -->
  <g transform="translate(${progX}, ${progY})">
    <text x="0" y="-10" font-size="13" fill="${t.textDim}">🎯 เป้า ${fmtThb(targetThb)}</text>
    <text x="${progW}" y="-10" text-anchor="end" font-size="13" font-weight="700" fill="${t.accent}">${fmtPct(pct)}</text>
    <rect x="0" y="0" width="${progW}" height="${progH}" rx="${progH / 2}" fill="${t.progressTrack}" stroke="${t.cardBorder}" stroke-width="1"/>
    ${pctClamped > 0 ? `<rect x="0" y="0" width="${(progW * pctClamped / 100).toFixed(1)}" height="${progH}" rx="${progH / 2}" fill="url(#${progId})"/>` : ''}
  </g>

  <!-- Stats grid 2×2 -->
  <g transform="translate(60, 640)">
    <!-- Trades -->
    <g transform="translate(0, 0)">
      <rect width="320" height="100" rx="14" fill="${t.cardBg}" stroke="${t.cardBorder}" stroke-width="1"/>
      <text x="20" y="32" font-size="13" fill="${t.textMuted}" letter-spacing="1">TRADES</text>
      <text x="20" y="72" font-size="38" font-weight="800" fill="${t.text}">${trades}</text>
      <text x="20" y="92" font-size="12" fill="${t.textDim}">${wins}W / ${losses}L</text>
      <text x="300" y="68" text-anchor="end" font-size="40">📊</text>
    </g>

    <!-- Win rate -->
    <g transform="translate(340, 0)">
      <rect width="320" height="100" rx="14" fill="${t.cardBg}" stroke="${t.cardBorder}" stroke-width="1"/>
      <text x="20" y="32" font-size="13" fill="${t.textMuted}" letter-spacing="1">WIN RATE</text>
      <text x="20" y="72" font-size="38" font-weight="800" fill="${trades > 0 ? t.positive : t.textMuted}">${trades > 0 ? fmtPct(winRate) : '—'}</text>
      <text x="20" y="92" font-size="12" fill="${t.textDim}">${trades > 0 ? `${wins} ชนะ / ${losses} แพ้` : 'ยังไม่มีไม้'}</text>
      <text x="300" y="68" text-anchor="end" font-size="40">${trades > 0 && winRate >= 50 ? '🎯' : '🎲'}</text>
    </g>

    <!-- Gross win -->
    <g transform="translate(0, 120)">
      <rect width="320" height="100" rx="14" fill="${t.cardBg}" stroke="${t.cardBorder}" stroke-width="1"/>
      <text x="20" y="32" font-size="13" fill="${t.textMuted}" letter-spacing="1">+ GROSS WIN</text>
      <text x="20" y="72" font-size="32" font-weight="800" fill="${t.positive}">${fmtThb(grossWinThb)}</text>
      <text x="20" y="92" font-size="12" fill="${t.textDim}">${grossWinUsdt > 0 ? `+${grossWinUsdt.toFixed(4)} USDT` : '—'}</text>
      <text x="300" y="68" text-anchor="end" font-size="40">💰</text>
    </g>

    <!-- Gross loss -->
    <g transform="translate(340, 120)">
      <rect width="320" height="100" rx="14" fill="${t.cardBg}" stroke="${t.cardBorder}" stroke-width="1"/>
      <text x="20" y="32" font-size="13" fill="${t.textMuted}" letter-spacing="1">− GROSS LOSS</text>
      <text x="20" y="72" font-size="32" font-weight="800" fill="${grossLossUsdt < 0 ? t.negative : t.textMuted}">${grossLossUsdt < 0 ? '−' : ''}${fmtThb(grossLossThb)}</text>
      <text x="20" y="92" font-size="12" fill="${t.textDim}">${grossLossUsdt < 0 ? `${grossLossUsdt.toFixed(4)} USDT` : '—'}</text>
      <text x="300" y="68" text-anchor="end" font-size="40">📉</text>
    </g>
  </g>

  <!-- Footer / branding -->
  <g transform="translate(${W / 2}, 920)">
    <line x1="-200" y1="0" x2="200" y2="0" stroke="${t.cardBorder}" stroke-width="1"/>
    <text x="0" y="30" text-anchor="middle" font-size="14" font-weight="700" fill="${t.text}">
      #OnePercentBotTrade
    </text>
    <text x="0" y="52" text-anchor="middle" font-size="11" fill="${t.textMuted}">
      ${achievedSparkle ? '✨ ทุกวันคือโอกาส — วันนี้คุณทำได้! ✨' : 'วันนี้คืออีกหนึ่งบทเรียน — สู้ต่อพรุ่งนี้'}
    </text>
  </g>
</svg>`;
    return svg;
  }

  // ─── SVG → PNG conversion ──────────────────────────────────────────────
  function svgStringToPngBlob(svgString) {
    return new Promise((resolve, reject) => {
      try {
        // Add XML declaration if missing
        if (!svgString.startsWith('<?xml')) {
          svgString = '<?xml version="1.0" encoding="UTF-8"?>' + svgString;
        }
        const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = W;
          canvas.height = H;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, W, H);
          URL.revokeObjectURL(url);
          canvas.toBlob((pngBlob) => {
            if (pngBlob) resolve(pngBlob);
            else reject(new Error('canvas.toBlob returned null'));
          }, 'image/png', 0.95);
        };
        img.onerror = (e) => {
          URL.revokeObjectURL(url);
          reject(new Error('SVG image failed to load: ' + (e && e.message)));
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

  // ─── Preview Modal ─────────────────────────────────────────────────────
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
          <button type="button" class="share-card-btn share-card-btn-primary" id="share-card-download">
            💾 ดาวน์โหลด PNG
          </button>
        </div>
        <div class="share-card-hint">
          การ์ดนี้ออกแบบมาสำหรับแชร์ไปยังโซเชียลมีเดีย (IG/FB/Discord/Line) — ดาวน์โหลดแล้วอัปโหลดได้เลย
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Wire close handlers
    modal.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', closePreview);
    });
    // Esc to close
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
    const svg = buildSvg(d);

    // Show as data URL in img tag (preview before download)
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.src = url;
    img.dataset.svg = svg;
    img.dataset.filename = defaultFilename(d);
    img.dataset.url = url;

    // Wire download button (replace handler to avoid duplicate)
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

    modal.classList.add('is-open');
    document.body.classList.add('share-card-modal-open');
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

  // ─── Public API ────────────────────────────────────────────────────────
  window.ShareCard = {
    buildSvg,
    downloadPng,
    showPreview,
    closePreview,
    ZONE_THEMES,
    PALETTE,
  };
})();
