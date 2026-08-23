'use strict';

// FIX-2026-08-09: tests for src/utils/sessionStore.js
//   - unserializeSessionData: handle string (connect-mongo v5 default stringify=true) + object + edge cases
//   - getAllSessionDocs: mocked mongoose to verify the query shape (filter by expires > now)

const { unserializeSessionData, getAllSessionDocs } = require('../src/utils/sessionStore');

describe('sessionStore.unserializeSessionData', () => {
  test('returns {} for null/undefined/empty', () => {
    expect(unserializeSessionData(null)).toEqual({});
    expect(unserializeSessionData(undefined)).toEqual({});
    expect(unserializeSessionData('')).toEqual({});
  });

  test('returns object unchanged when input is already an object', () => {
    const obj = { authenticated: true, loginAt: '2026-08-09T10:00:00Z' };
    expect(unserializeSessionData(obj)).toBe(obj);
  });

  test('parses JSON string (connect-mongo v5 stringify=true default)', () => {
    const json = JSON.stringify({ authenticated: true, userAgent: 'Mozilla/5.0...' });
    const result = unserializeSessionData(json);
    expect(result.authenticated).toBe(true);
    expect(result.userAgent).toBe('Mozilla/5.0...');
  });

  test('returns {} on invalid JSON', () => {
    expect(unserializeSessionData('{not valid json')).toEqual({});
    expect(unserializeSessionData('undefined')).toEqual({});
  });

  test('preserves all fields including boolean false / 0', () => {
    const data = { authenticated: false, count: 0, empty: '', nested: { a: 1 } };
    const parsed = unserializeSessionData(JSON.stringify(data));
    expect(parsed.authenticated).toBe(false);
    expect(parsed.count).toBe(0);
    expect(parsed.empty).toBe('');
    expect(parsed.nested).toEqual({ a: 1 });
  });
});

describe('sessionStore.getAllSessionDocs', () => {
  test('queries sessions collection with expires > now filter', async () => {
    // mock mongoose.connection.db.collection().find().toArray()
    let capturedFilter = null;
    const mockFind = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([]),
    });
    const mockColl = {
      find: (filter) => { capturedFilter = filter; return mockFind(filter); },
    };
    const mongoose = require('mongoose');
    const originalDb = mongoose.connection.db;
    mongoose.connection.db = { collection: jest.fn().mockReturnValue(mockColl) };

    try {
      const docs = await getAllSessionDocs();
      expect(Array.isArray(docs)).toBe(true);
      expect(capturedFilter).toBeDefined();
      expect(capturedFilter.$or).toBeDefined();
      expect(capturedFilter.$or.length).toBe(2);
      // expires > now OR expires doesn't exist
      const now = new Date();
      const cond1 = capturedFilter.$or[0];
      const cond2 = capturedFilter.$or[1];
      expect(cond1.expires.$exists).toBe(false);
      expect(cond2.expires.$gt).toBeInstanceOf(Date);
      // 1ms slack — `new Date()` inside getAllSessionDocs() may have been built a microsecond before `now`
      expect(cond2.expires.$gt.getTime()).toBeGreaterThanOrEqual(now.getTime() - 1);
    } finally {
      mongoose.connection.db = originalDb;
    }
  });

  test('returns array of docs from MongoDB', async () => {
    const docs = [
      { _id: 'sid-1', session: JSON.stringify({ authenticated: true }), expires: new Date(Date.now() + 3600_000) },
      { _id: 'sid-2', session: JSON.stringify({ authenticated: true }), expires: new Date(Date.now() + 3600_000) },
      { _id: 'sid-3', session: JSON.stringify({ authenticated: false }), expires: new Date(Date.now() + 3600_000) },
    ];
    const mockFind = jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(docs) });
    const mockColl = { find: jest.fn().mockReturnValue(mockFind()) };
    const mongoose = require('mongoose');
    const originalDb = mongoose.connection.db;
    mongoose.connection.db = { collection: jest.fn().mockReturnValue(mockColl) };

    try {
      const result = await getAllSessionDocs();
      expect(result).toHaveLength(3);
      expect(result[0]._id).toBe('sid-1');
      expect(typeof result[0].session).toBe('string'); // raw MongoDB shape
    } finally {
      mongoose.connection.db = originalDb;
    }
  });
});

describe('Integration: list sessions flow (rev2)', () => {
  test('lists 3 sessions, parses string sessions, skips unauthenticated', async () => {
    const docs = [
      { _id: 'sid-A', session: JSON.stringify({ authenticated: true, loginAt: '2026-08-09T10:00:00Z', userAgent: 'Chrome/Windows', loginIp: '1.2.3.4' }), expires: new Date(Date.now() + 3600_000) },
      { _id: 'sid-B', session: JSON.stringify({ authenticated: true, loginAt: '2026-08-09T11:00:00Z', userAgent: 'Safari/iPhone', loginIp: '5.6.7.8' }), expires: new Date(Date.now() + 3600_000) },
      { _id: 'sid-C', session: JSON.stringify({ authenticated: false }), expires: new Date(Date.now() + 3600_000) }, // should be skipped
    ];
    const mockColl = { find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(docs) }) };
    const mongoose = require('mongoose');
    const originalDb = mongoose.connection.db;
    mongoose.connection.db = { collection: jest.fn().mockReturnValue(mockColl) };

    try {
      const allDocs = await getAllSessionDocs();
      const authed = allDocs
        .map((d) => ({ sid: String(d._id), data: unserializeSessionData(d.session) }))
        .filter((x) => x.data.authenticated);
      expect(authed).toHaveLength(2); // sid-C skipped
      expect(authed[0].sid).toBe('sid-A');
      expect(authed[1].sid).toBe('sid-B');
      expect(authed[0].data.loginIp).toBe('1.2.3.4');
      expect(authed[1].data.userAgent).toBe('Safari/iPhone');
    } finally {
      mongoose.connection.db = originalDb;
    }
  });
});