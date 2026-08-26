'use strict';

/**
 * FIX-2026-08-26 Phase 2c-v2: Consent Hybrid — transport-agnostic core tests.
 *
 *   Covers:
 *     - handlers.getStatus() returns pending/accepted/declined per file state
 *     - handlers.getStatus() returns 'accepted' when CONSENT_ENABLED=false
 *     - recordDecision('accepted') writes once, emits once, source='first_run'
 *     - recordDecision('declined') after accept → source='settings_change'
 *     - recordDecision is idempotent (same decision → no-op)
 *     - Promise.all of two recordDecisions for the same value → one write, one emit
 *     - pushDecision rejection still resolves recordDecision (best-effort)
 *     - markEngaged / hasEngaged flag toggling
 *     - pageHtml({ actionBase: '/api/consent' }) contains /api/consent/accept
 *     - pageHtml without actionBase param keeps legacy /consent/accept (regression)
 */

// ─── Mocks (Jest hoists `mock`-prefixed names) ────────────────────────
const mockPush = jest.fn(async () => true);
const mockMachineId = 'TEST-MACHINE-001';
jest.mock('../src/consent/api', () => ({
  pushDecision: (...args) => mockPush(...args),
}));
jest.mock('../src/admin-monitor/machineId', () => ({
  getMachineId: () => mockMachineId,
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const handlers = require('../src/consent/handlers');
const storage = require('../src/consent/storage');
const config = require('../src/consent/config');
const { pageHtml } = require('../src/consent/html');
const text = require('../src/consent/text');

// Use a tmp consent file so we don't touch the real one
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-hybrid-test-'));
const TMP_FILE = path.join(TMP_DIR, 'consent.json');

describe('consent/handlers — getStatus()', () => {
  beforeEach(() => {
    config.filePath = TMP_FILE;
    if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE);
    handlers._resetEngagedForTest();
    config.enabled = true;
  });

  test('returns pending when no decision on disk', () => {
    expect(handlers.getStatus()).toBe('pending');
  });
  test('returns accepted when storage has accepted', () => {
    storage.write({ decision: 'accepted', source: 'first_run' });
    expect(handlers.getStatus()).toBe('accepted');
  });
  test('returns declined when storage has declined', () => {
    storage.write({ decision: 'declined', source: 'first_run' });
    expect(handlers.getStatus()).toBe('declined');
  });
  test('returns accepted when CONSENT_ENABLED=false (opt-out)', () => {
    config.enabled = false;
    expect(handlers.getStatus()).toBe('accepted');
  });
});

describe('consent/handlers — getStatusPayload()', () => {
  beforeEach(() => {
    config.filePath = TMP_FILE;
    if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE);
    config.enabled = true;
  });
  test('shape includes decision + version + flags', () => {
    const p = handlers.getStatusPayload();
    expect(p).toHaveProperty('decision');
    expect(p).toHaveProperty('consentVersion');
    expect(p).toHaveProperty('adminMonitorEnabled');
    expect(p).toHaveProperty('consentEnabled');
    expect(p.decision).toBe('pending');
    expect(p.consentVersion).toBe(config.version);
  });

  // FIX-2026-08-26 Phase 3a: getStatusPayload() includes decidedAt + source + previousDecision
  //   for Settings page Consent card audit display
  test('returns null audit fields when no decision on disk (pending)', () => {
    const p = handlers.getStatusPayload();
    expect(p.decidedAt).toBeNull();
    expect(p.source).toBeNull();
    expect(p.previousDecision).toBeNull();
  });

  test('returns decidedAt + source after a decision is written', async () => {
    await handlers.recordDecision({ decision: 'accepted', port: 6015 });
    const p = handlers.getStatusPayload();
    expect(p.decision).toBe('accepted');
    expect(p.decidedAt).toBeTruthy();
    expect(new Date(p.decidedAt).toString()).not.toBe('Invalid Date');
    expect(p.source).toBe('first_run');
    expect(p.previousDecision).toBeNull();
  });

  test('source=first_run → settings_change when revised', async () => {
    await handlers.recordDecision({ decision: 'accepted', port: 6015 });
    await handlers.recordDecision({ decision: 'declined', port: 6015 });
    const p = handlers.getStatusPayload();
    expect(p.decision).toBe('declined');
    expect(p.source).toBe('settings_change');
    expect(p.previousDecision).toBe('accepted');
  });
});

describe('consent/handlers — recordDecision()', () => {
  let emitSpy;
  beforeEach(() => {
    config.filePath = TMP_FILE;
    if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE);
    config.enabled = true;
    mockPush.mockClear();
    emitSpy = jest.fn();
    handlers.emitter.on('decision', emitSpy);
  });
  afterEach(() => {
    handlers.emitter.removeListener('decision', emitSpy);
  });

  test('first accept writes file, emits once, source=first_run, pushes admin', async () => {
    const r = await handlers.recordDecision({ decision: 'accepted', port: 6015 });
    expect(r.decision).toBe('accepted');
    expect(r.source).toBe('first_run');
    expect(r.previousDecision).toBeNull();
    expect(r.alreadyDecided).toBe(false);
    expect(storage.currentDecision()).toBe('accepted');
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy.mock.calls[0][0]).toMatchObject({ decision: 'accepted', port: 6015 });
    expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({
      machineId: mockMachineId, decision: 'accepted', source: 'first_run',
    }));
  });

  test('same decision already on disk → no-op', async () => {
    storage.write({ decision: 'accepted', source: 'first_run' });
    emitSpy.mockClear();
    mockPush.mockClear();
    const r = await handlers.recordDecision({ decision: 'accepted', port: 6015 });
    expect(r.alreadyDecided).toBe(true);
    expect(r.source).toBe('noop');
    expect(emitSpy).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  test('changing accepted → declined records settings_change', async () => {
    await handlers.recordDecision({ decision: 'accepted', port: 6015 });
    emitSpy.mockClear();
    mockPush.mockClear();
    const r = await handlers.recordDecision({ decision: 'declined', port: 6015 });
    expect(r.source).toBe('settings_change');
    expect(r.previousDecision).toBe('accepted');
    expect(storage.currentDecision()).toBe('declined');
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy.mock.calls[0][0]).toMatchObject({
      decision: 'declined', previousDecision: 'accepted', port: 6015,
    });
  });

  test('invalid decision throws 400', async () => {
    await expect(handlers.recordDecision({ decision: 'maybe' }))
      .rejects.toThrow(/invalid decision/);
  });

  test('pushDecision rejection does not block recordDecision', async () => {
    mockPush.mockRejectedValueOnce(new Error('admin offline'));
    const r = await handlers.recordDecision({ decision: 'accepted', port: 6015 });
    expect(r.decision).toBe('accepted');
    expect(storage.currentDecision()).toBe('accepted');
  });

  test('Promise.all of two recordDecisions for the same new value → one write, one emit', async () => {
    // Race: two callers, both fire recordDecision('accepted') simultaneously.
    // _inFlight should serialise; only one write should land, one emit.
    emitSpy.mockClear();
    mockPush.mockClear();
    const [r1, r2] = await Promise.all([
      handlers.recordDecision({ decision: 'accepted', port: 6015 }),
      handlers.recordDecision({ decision: 'accepted', port: 6017 }),
    ]);
    // Both should succeed; one was the "first write", the other was alreadyDecided.
    const decided = [r1, r2].filter((r) => !r.alreadyDecided);
    expect(decided.length).toBe(1);
    expect(decided[0].decision).toBe('accepted');
    // One emit total (the first write emits; the second is a no-op).
    expect(emitSpy).toHaveBeenCalledTimes(1);
    // pushDecision called once (the first write's push)
    expect(mockPush).toHaveBeenCalledTimes(1);
  });
});

describe('consent/handlers — markEngaged / hasEngaged', () => {
  beforeEach(() => {
    handlers._resetEngagedForTest();
  });
  test('starts false', () => {
    expect(handlers.hasEngaged()).toBe(false);
  });
  test('markEngaged flips flag', () => {
    handlers.markEngaged();
    expect(handlers.hasEngaged()).toBe(true);
  });
  test('_resetEngagedForTest clears flag', () => {
    handlers.markEngaged();
    handlers._resetEngagedForTest();
    expect(handlers.hasEngaged()).toBe(false);
  });
});

describe('consent/html — pageHtml actionBase', () => {
  test('omitted actionBase defaults to /consent (regression guard)', () => {
    const html = pageHtml({ sections: text({ adminMonitorEnabled: false }) });
    expect(html).toContain('/consent/accept');
    expect(html).toContain('/consent/decline');
  });
  test('actionBase=/api/consent posts to new route', () => {
    const html = pageHtml({
      sections: text({ adminMonitorEnabled: false }),
      actionBase: '/api/consent',
    });
    expect(html).toContain('/api/consent/accept');
    expect(html).toContain('/api/consent/decline');
    expect(html).not.toContain('"/consent/accept"'); // the form action attribute, escaped
  });
});

describe('consent/html — formal/boring design (Phase 2c-v3)', () => {
  test('uses formal document title (no emoji)', () => {
    const html = pageHtml({ sections: text({ adminMonitorEnabled: false }) });
    expect(html).toContain('Consent and Agreement');
    expect(html).toContain('คำยินยอมและข้อตกลง');
    expect(html).not.toContain('First-Run Consent');
    expect(html).not.toContain('�️');
    expect(html).not.toContain('✅');
    expect(html).not.toContain('�');
  });
  test('single acknowledgement checkbox (not one per section)', () => {
    const html = pageHtml({ sections: text({ adminMonitorEnabled: false }) });
    expect(html).toContain('id="cs-ack-box"');
    expect(html).toContain('I have read the entire document above and accept all conditions');
    expect(html).toContain('ฉันอ่านเอกสารทั้งหมดข้างต้นแล้ว และยอมรับทุกเงื่อนไข');
    // No per-section checkboxes anymore
    expect(html).not.toContain('class="cs-read"');
    expect(html).not.toContain('class="cs-tick"');
  });
  test('formal buttons labeled Accept / Decline', () => {
    const html = pageHtml({ sections: text({ adminMonitorEnabled: false }) });
    expect(html).toContain('id="cs-accept"');
    expect(html).toContain('id="cs-decline"');
    expect(html).toContain('>Accept</span>');
    expect(html).toContain('>Decline</span>');
    expect(html).toContain('>ตกลง</span>');
    expect(html).toContain('>ไม่ตกลง</span>');
  });
  test('uses serif font + document meta (version + date)', () => {
    const html = pageHtml({ sections: text({ adminMonitorEnabled: false }) });
    expect(html).toMatch(/font-family.*Times New Roman/);
    expect(html).toMatch(/Document version \d+/);
    expect(html).toMatch(/Issued \d{4}-\d{2}-\d{2}/);
  });
  test('buttons disabled until ack box ticked', () => {
    const html = pageHtml({ sections: text({ adminMonitorEnabled: false }) });
    // Buttons render with disabled attribute; JS toggles on box change
    expect(html).toMatch(/id="cs-accept"[^>]*disabled/);
    expect(html).toMatch(/id="cs-decline"[^>]*disabled/);
  });
});