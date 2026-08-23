'use strict';

/**
 * 2026-08-09: parseDeviceLabel — best-effort browser/OS/device detection from User-Agent
 *
 * Used by:
 *   - src/api/routes/auth.routes.js (session metadata stashing)
 *   - src/utils/loginAudit.js (failed login attempt logging)
 *   - public/js/pages/password-sessions.js (frontend display)
 *
 * Critical ordering (caught by tests on first pass):
 *   - iPhone/iPad/iOS MUST be checked BEFORE Mac OS X — iPad UA contains "Mac OS X"
 *   - iPad MUST be checked BEFORE generic Mobile — iPad UA contains "Mobile"
 */

function parseDeviceLabel(ua) {
  if (!ua || typeof ua !== 'string') {
    return { browser: 'Unknown', os: 'Unknown', device: 'desktop' };
  }
  const s = ua;

  // Browser
  let browser = 'Unknown';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/Chrome\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = 'Safari';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/curl|wget|http\.request/i.test(s)) browser = 'CLI';

  // OS (iPhone/iPad/iOS BEFORE Mac OS X — iPad UA contains "Mac OS X")
  let os = 'Unknown';
  if (/Windows NT/.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iOS/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';

  // Device (iPad BEFORE generic Mobile — iPad UA contains "Mobile")
  let device = 'desktop';
  if (/iPad/.test(s)) device = 'tablet';
  else if (/iPhone/.test(s)) device = 'phone';
  else if (/Android/.test(s) && !/Mobile/.test(s)) device = 'tablet';
  else if (/Android/.test(s)) device = 'phone';
  else if (/Mobile/.test(s)) device = 'phone';

  return { browser, os, device };
}

module.exports = { parseDeviceLabel };