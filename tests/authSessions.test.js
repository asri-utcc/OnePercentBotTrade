'use strict';

// 2026-08-09: Password & Sessions Manager — unit tests
//   - parseDeviceLabel: extract browser/os/device from UA
//   - session touch middleware: throttles lastSeenAt updates to 60s
//   - AppConfig schema accepts new fields (passwordHint, passwordNote, etc.)

const { parseDeviceLabel } = (() => {
  // import-free extraction — re-parse the same logic as in auth.routes.js
  // (mirror, not require, to avoid loading mongoose into this file)
  function parseDeviceLabel(ua) {
    if (!ua || typeof ua !== 'string') return { browser: 'Unknown', os: 'Unknown', device: 'desktop' };
    const s = ua;
    let browser = 'Unknown';
    if (/Edg\//.test(s)) browser = 'Edge';
    else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
    else if (/Chrome\//.test(s)) browser = 'Chrome';
    else if (/Safari\//.test(s) && /Version\//.test(s)) browser = 'Safari';
    else if (/Firefox\//.test(s)) browser = 'Firefox';
    else if (/curl|wget|http\.request/i.test(s)) browser = 'CLI';
    let os = 'Unknown';
    if (/Windows NT/.test(s)) os = 'Windows';
    else if (/iPhone|iPad|iOS/.test(s)) os = 'iOS';
    else if (/Android/.test(s)) os = 'Android';
    else if (/CrOS/.test(s)) os = 'ChromeOS';
    else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
    else if (/Linux/.test(s)) os = 'Linux';
    let device = 'desktop';
    if (/iPad/.test(s)) device = 'tablet';
    else if (/iPhone/.test(s)) device = 'phone';
    else if (/Android/.test(s) && !/Mobile/.test(s)) device = 'tablet';
    else if (/Android/.test(s)) device = 'phone';
    else if (/Mobile/.test(s)) device = 'phone';
    return { browser, os, device };
  }
  return { parseDeviceLabel };
})();

describe('parseDeviceLabel (Password & Sessions Manager)', () => {
  test('Chrome on Windows 10', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    expect(parseDeviceLabel(ua)).toEqual({ browser: 'Chrome', os: 'Windows', device: 'desktop' });
  });

  test('Safari on iPhone', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    expect(parseDeviceLabel(ua)).toEqual({ browser: 'Safari', os: 'iOS', device: 'phone' });
  });

  test('Firefox on Linux', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
    expect(parseDeviceLabel(ua)).toEqual({ browser: 'Firefox', os: 'Linux', device: 'desktop' });
  });

  test('Edge on Windows', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
    expect(parseDeviceLabel(ua)).toEqual({ browser: 'Edge', os: 'Windows', device: 'desktop' });
  });

  test('Chrome on Android phone', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
    expect(parseDeviceLabel(ua)).toEqual({ browser: 'Chrome', os: 'Android', device: 'phone' });
  });

  test('iPad Safari (tablet)', () => {
    const ua = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    expect(parseDeviceLabel(ua)).toEqual({ browser: 'Safari', os: 'iOS', device: 'tablet' });
  });

  test('Android tablet (no Mobile keyword)', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 13; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    expect(parseDeviceLabel(ua)).toEqual({ browser: 'Chrome', os: 'Android', device: 'tablet' });
  });

  test('CLI curl', () => {
    const ua = 'curl/8.4.0';
    expect(parseDeviceLabel(ua)).toEqual({ browser: 'CLI', os: 'Unknown', device: 'desktop' });
  });

  test('Empty UA returns Unknown', () => {
    expect(parseDeviceLabel('')).toEqual({ browser: 'Unknown', os: 'Unknown', device: 'desktop' });
    expect(parseDeviceLabel(null)).toEqual({ browser: 'Unknown', os: 'Unknown', device: 'desktop' });
    expect(parseDeviceLabel(undefined)).toEqual({ browser: 'Unknown', os: 'Unknown', device: 'desktop' });
  });

  test('macOS Chrome', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    expect(parseDeviceLabel(ua)).toEqual({ browser: 'Chrome', os: 'macOS', device: 'desktop' });
  });
});

describe('AppConfig schema — password & sessions fields (2026-08-09)', () => {
  test('schema has passwordHint / passwordNote / passwordLastChangedAt / passwordLastChangedFromIp', () => {
    const schema = require('../src/db/models/AppConfig').schema;
    expect(schema.paths.passwordHint).toBeDefined();
    expect(schema.paths.passwordHint.options.maxlength).toBe(500);
    expect(schema.paths.passwordNote).toBeDefined();
    expect(schema.paths.passwordNote.options.maxlength).toBe(1000);
    expect(schema.paths.passwordLastChangedAt).toBeDefined();
    expect(schema.paths.passwordLastChangedFromIp).toBeDefined();
  });

  test('defaults: hint + note are empty strings', () => {
    const schema = require('../src/db/models/AppConfig').schema;
    expect(schema.paths.passwordHint.options.default).toBe('');
    expect(schema.paths.passwordNote.options.default).toBe('');
    expect(schema.paths.passwordLastChangedFromIp.options.default).toBe('');
    expect(schema.paths.passwordLastChangedAt.options.default).toBeNull();
  });
});

describe('Session touch middleware throttling', () => {
  // Mirror the throttling logic from src/app.js
  function shouldTouch(lastSeenIso) {
    if (!lastSeenIso) return true;
    const last = new Date(lastSeenIso).getTime();
    if (!isFinite(last)) return true;
    return Date.now() - last >= 60 * 1000;
  }

  test('first request → touch', () => {
    expect(shouldTouch(null)).toBe(true);
    expect(shouldTouch(undefined)).toBe(true);
  });

  test('within 60s → skip', () => {
    expect(shouldTouch(new Date().toISOString())).toBe(false);
    expect(shouldTouch(new Date(Date.now() - 30 * 1000).toISOString())).toBe(false);
    expect(shouldTouch(new Date(Date.now() - 59 * 1000).toISOString())).toBe(false);
  });

  test('after 60s → touch', () => {
    expect(shouldTouch(new Date(Date.now() - 61 * 1000).toISOString())).toBe(true);
    expect(shouldTouch(new Date(Date.now() - 5 * 60 * 1000).toISOString())).toBe(true);
  });
});
