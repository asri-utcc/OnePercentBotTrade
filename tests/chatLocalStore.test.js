'use strict';

/**
 * Phase 4-2026-08-29 — chatLocalStore unit tests.
 *
 *   - addMessage respects ring buffer cap (200 per scope)
 *   - DM from admin increments unread; community doesn't
 *   - getMessages returns newest-first; filters by since
 *   - markRead resets counters
 *   - displayName / customerTag / machineId resolvers
 */

const chatLocalStore = require('../src/services/chatLocalStore');

beforeEach(() => {
  chatLocalStore.clear();
});

describe('chatLocalStore (Phase 4)', () => {
  test('addMessage stores in community buffer', () => {
    chatLocalStore.addMessage({ id: 'a1', scope: 'community', fromAdmin: false, text: 'hi', displayName: 'op', createdAt: '2026-08-29T10:00:00.000Z' });
    const msgs = chatLocalStore.getMessages('community');
    expect(msgs.length).toBe(1);
    expect(msgs[0].text).toBe('hi');
  });

  test('addMessage trims text to 2000 chars', () => {
    const longText = 'x'.repeat(5000);
    chatLocalStore.addMessage({ id: 'b1', scope: 'community', text: longText, displayName: 'op' });
    const msgs = chatLocalStore.getMessages('community');
    expect(msgs[0].text.length).toBe(2000);
  });

  test('ring buffer caps at 200 per scope', () => {
    for (let i = 0; i < 250; i++) {
      chatLocalStore.addMessage({
        id: `m${i}`,
        scope: 'community',
        text: `msg ${i}`,
        displayName: 'op',
        createdAt: new Date(Date.UTC(2026, 7, 29, 10, 0, i)).toISOString(),
      });
    }
    const msgs = chatLocalStore.getMessages('community', null, 200);
    expect(msgs.length).toBe(200);
    // Should keep the most recent (m50..m249), oldest is m50
    expect(msgs[0].id).toBe('m249');
    expect(msgs[199].id).toBe('m50');
  });

  test('DM from admin increments unread; community does not', () => {
    chatLocalStore.addMessage({ id: 'd1', scope: 'dm', fromAdmin: true, text: 'hi from admin', displayName: 'admin', createdAt: '2026-08-29T10:00:00.000Z' });
    chatLocalStore.addMessage({ id: 'd2', scope: 'dm', fromAdmin: false, text: 'reply', displayName: 'op', createdAt: '2026-08-29T10:00:01.000Z' });
    chatLocalStore.addMessage({ id: 'c1', scope: 'community', fromAdmin: false, text: 'public', displayName: 'op', createdAt: '2026-08-29T10:00:02.000Z' });
    expect(chatLocalStore.getUnread('dm')).toBe(1);
    expect(chatLocalStore.getUnread('community')).toBe(0);
    expect(chatLocalStore.getAllUnread()).toEqual({ community: 0, dm: 1 });
  });

  test('markRead resets the scope counter', () => {
    chatLocalStore.addMessage({ id: 'd1', scope: 'dm', fromAdmin: true, text: 'a', displayName: 'admin', createdAt: '2026-08-29T10:00:00.000Z' });
    chatLocalStore.addMessage({ id: 'd2', scope: 'dm', fromAdmin: true, text: 'b', displayName: 'admin', createdAt: '2026-08-29T10:00:01.000Z' });
    expect(chatLocalStore.getUnread('dm')).toBe(2);
    chatLocalStore.markRead('dm');
    expect(chatLocalStore.getUnread('dm')).toBe(0);
  });

  test('getMessages returns newest-first', () => {
    chatLocalStore.addMessage({ id: 'a', scope: 'community', text: 'first', displayName: 'op', createdAt: '2026-08-29T10:00:00.000Z' });
    chatLocalStore.addMessage({ id: 'b', scope: 'community', text: 'second', displayName: 'op', createdAt: '2026-08-29T10:00:01.000Z' });
    chatLocalStore.addMessage({ id: 'c', scope: 'community', text: 'third', displayName: 'op', createdAt: '2026-08-29T10:00:02.000Z' });
    const msgs = chatLocalStore.getMessages('community');
    expect(msgs.map((m) => m.id)).toEqual(['c', 'b', 'a']);
  });

  test('getMessages filters by since timestamp', () => {
    chatLocalStore.addMessage({ id: 'a', scope: 'community', text: 'a', displayName: 'op', createdAt: '2026-08-29T10:00:00.000Z' });
    chatLocalStore.addMessage({ id: 'b', scope: 'community', text: 'b', displayName: 'op', createdAt: '2026-08-29T10:00:01.000Z' });
    chatLocalStore.addMessage({ id: 'c', scope: 'community', text: 'c', displayName: 'op', createdAt: '2026-08-29T10:00:02.000Z' });
    const sinceMs = new Date('2026-08-29T10:00:00.500Z').getTime();
    const msgs = chatLocalStore.getMessages('community', new Date(sinceMs).toISOString());
    expect(msgs.map((m) => m.id)).toEqual(['c', 'b']);
  });

  test('getMessages limit', () => {
    for (let i = 0; i < 10; i++) {
      chatLocalStore.addMessage({ id: `m${i}`, scope: 'community', text: 't', displayName: 'op', createdAt: new Date(Date.UTC(2026, 7, 29, 10, 0, i)).toISOString() });
    }
    const msgs = chatLocalStore.getMessages('community', null, 3);
    expect(msgs.length).toBe(3);
    expect(msgs[0].id).toBe('m9'); // newest
  });

  test('displayName resolvers prefer explicit, then customerTag, then machineId', () => {
    chatLocalStore.setMachineId('abcdef1234567890');
    chatLocalStore.setCustomerTag('shop-A');
    expect(chatLocalStore.resolveDisplayName()).toBe('shop-A');
    chatLocalStore.setDisplayName('alice');
    expect(chatLocalStore.resolveDisplayName()).toBe('alice');
    chatLocalStore.setDisplayName('');
    chatLocalStore.setCustomerTag('');
    expect(chatLocalStore.resolveDisplayName()).toBe('abcdef12'); // first 8 of machineId
  });

  test('displayName cap 32 chars', () => {
    chatLocalStore.setDisplayName('x'.repeat(100));
    expect(chatLocalStore.getDisplayName().length).toBe(32);
  });

  test('clear wipes state', () => {
    chatLocalStore.addMessage({ id: 'a', scope: 'community', text: 't', displayName: 'op' });
    chatLocalStore.setDisplayName('alice');
    chatLocalStore.clear();
    expect(chatLocalStore.getMessages('community').length).toBe(0);
    expect(chatLocalStore.getDisplayName()).toBe('');
    expect(chatLocalStore.resolveDisplayName()).toBe('operator');
  });

  // Phase 4-FIX-2026-08-30: regression tests for "send 1 → see 2" duplicate.
  // Optimistic local append (chatOutbox.enqueue) and inbox echo (chatInbox poll)
  // both call addMessage for the same logical message — the optimistic copy uses
  // clientId as `id`, the echo uses the Mongo `_id` as `id` with the same clientId.
  // We dedupe on id OR clientId so the second addMessage returns false.
  test('Phase 4-FIX-2026-08-30: addMessage dedupes by id', () => {
    chatLocalStore.addMessage({ id: 'a1', scope: 'community', fromAdmin: false, text: 'hi', displayName: 'op' });
    const r = chatLocalStore.addMessage({ id: 'a1', scope: 'community', fromAdmin: false, text: 'hi', displayName: 'op' });
    expect(r).toBe(false);
    expect(chatLocalStore.getMessages('community')).toHaveLength(1);
  });

  test('Phase 4-FIX-2026-08-30: addMessage dedupes by clientId across different ids', () => {
    // Simulates the actual flow:
    //   (1) chatOutbox.enqueue optimistically appends with id=clientId='cid-1'
    //   (2) chatInbox echoes back with id=mongoId='mongo-id-1' and clientId='cid-1'
    chatLocalStore.addMessage({
      id: 'cid-1',
      clientId: 'cid-1',
      scope: 'community',
      fromAdmin: false,
      text: 'hello',
      displayName: 'op',
    });
    const r = chatLocalStore.addMessage({
      id: 'mongo-id-1',
      clientId: 'cid-1',
      scope: 'community',
      fromAdmin: false,
      text: 'hello',
      displayName: 'op',
    });
    expect(r).toBe(false);
    expect(chatLocalStore.getMessages('community')).toHaveLength(1);
    // The optimistic copy (first one) wins; the echo is dropped.
    expect(chatLocalStore.getMessages('community')[0].id).toBe('cid-1');
  });
});
describe('chatLocalStore (Phase 4 chat v2)', () => {
  test('addMessage stores color/icon/replyTo/attachment', () => {
    chatLocalStore.addMessage({
      id: 'v1',
      scope: 'community',
      fromAdmin: false,
      fromMachineId: 'm1',
      displayName: 'op',
      text: 'hi',
      color: '#22c55e',
      icon: '🦊',
      replyTo: { id: 'r1', displayName: 'admin', text: 'reply?' },
      attachment: { id: 'att1', kind: 'image', name: 'a.png', mime: 'image/png', sizeBytes: 1024 },
      createdAt: '2026-08-30T10:00:00.000Z',
    });
    const m = chatLocalStore.getMessages('community', null, 1)[0];
    expect(m.color).toBe('#22c55e');
    expect(m.icon).toBe('🦊');
    expect(m.replyTo.id).toBe('r1');
    expect(m.attachment.kind).toBe('image');
  });

  test('attachment URL defaults to /api/chat/attachments/:id', () => {
    chatLocalStore.addMessage({
      id: 'v2',
      scope: 'community',
      displayName: 'op',
      text: 'see',
      attachment: { id: 'att2', kind: 'text', name: 'b.txt', mime: 'text/plain', sizeBytes: 256 },
      createdAt: '2026-08-30T10:01:00.000Z',
    });
    const m = chatLocalStore.getMessages('community', null, 1)[0];
    expect(m.attachment.url).toBe('/api/chat/attachments/att2');
  });

  test('missing v2 fields default to null', () => {
    chatLocalStore.addMessage({
      id: 'v3',
      scope: 'community',
      displayName: 'op',
      text: 'plain',
      createdAt: '2026-08-30T10:02:00.000Z',
    });
    const m = chatLocalStore.getMessages('community', null, 1)[0];
    expect(m.color).toBe(null);
    expect(m.icon).toBe(null);
    expect(m.replyTo).toBe(null);
    expect(m.attachment).toBe(null);
  });
});
