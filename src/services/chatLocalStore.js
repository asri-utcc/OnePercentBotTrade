'use strict';

/**
 * Phase 4-2026-08-29 — Bot-side chat local store.
 *
 * In-memory ring buffer + unread counters — survives process lifetime, lost on restart.
 * On startup, the chatInbox poll back-fills from the admin server (server-of-record).
 *
 *   - community: shared with all bot operators + admins
 *   - dm:       only admin→this-operator + this-operator→admin (visible to local UI)
 *
 * No persistence layer for v1 — design choice: admin is the canonical store, and
 * after restart operators see the same messages via the first /inbox poll.
 *
 * Public API:
 *   - addMessage(msg)
 *   - getMessages(scope, sinceIso?, limit?)
 *   - markRead(scope)
 *   - getUnread(scope)
 *   - getAllUnread()           → { community, dm }
 *   - setDisplayName(name)
 *   - getDisplayName()
 *   - resolveDisplayName()     → chatDisplayName || customerTag || machineId slice
 *   - setCustomerTag(tag), setMachineId(id) — identity resolvers (call from app boot)
 *   - clear()                  → test helper
 */

const MAX_PER_SCOPE = 200;

const _buffers = {
  community: [],  // FIFO: oldest first
  dm: [],
};

const _unread = {
  community: 0,
  dm: 0,
};

let _displayName = '';
let _customerTag = '';
let _machineId = '';

function _trimScope(s) {
  return s === 'community' || s === 'dm' ? s : 'community';
}

function _trimText(t) {
  return String(t || '').slice(0, 2000);
}

function _newestFirst(arr) {
  // store oldest-first for natural append; queries return newest-first for UI
  return arr;
}

function addMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const scope = _trimScope(msg.scope);
  const buf = _buffers[scope];
  const newId = String(msg.id || msg._id || '');
  const newClientId = String(msg.clientId || '');
  // Phase 4-FIX-2026-08-30: de-dupe by id OR clientId.
  //   The optimistic local append from chatOutbox.enqueue uses clientId as `id`.
  //   When the same message echoes back via chatInbox poll, admin returns the
  //   Mongo `_id` in `id` and the same clientId in `clientId` — either match
  //   means we've already stored this message.
  for (const existing of buf) {
    if (newId && existing.id && existing.id === newId) return false;
    if (newClientId && existing.clientId && existing.clientId === newClientId) return false;
  }
  const replyTo = msg.replyTo && msg.replyTo.id
    ? {
        id: String(msg.replyTo.id),
        displayName: msg.replyTo.displayName || null,
        text: msg.replyTo.text || null,
        createdAt: msg.replyTo.createdAt || null,
      }
    : null;
  buf.push({
    id: newId,
    clientId: newClientId,
    scope,
    fromAdmin: !!msg.fromAdmin,
    fromMachineId: msg.fromMachineId || null,
    toMachineId: msg.toMachineId || null,
    displayName: String(msg.displayName || '').slice(0, 64),
    text: _trimText(msg.text),
    readByAdmin: !!msg.readByAdmin,
    createdAt: msg.createdAt || new Date().toISOString(),
    // Phase 4 chat v2
    color: msg.color || null,
    icon: msg.icon || null,
    replyTo,
    deletedAt: msg.deletedAt || null,
  });
  if (buf.length > MAX_PER_SCOPE) buf.splice(0, buf.length - MAX_PER_SCOPE);
  // DM from admin increments unread; community doesn't (always visible)
  if (scope === 'dm' && !!msg.fromAdmin) {
    _unread.dm += 1;
  }
  return true;
}

/**
 * Returns messages newest-first.
 *   sinceIso — if set, return messages strictly newer than that ISO timestamp
 *   limit    — default 50, max 200
 */
function getMessages(scope, sinceIso, limit) {
  const s = _trimScope(scope);
  const buf = _newestFirst(_buffers[s]).slice(); // oldest-first copy
  let start = 0;
  if (sinceIso) {
    const sinceMs = new Date(sinceIso).getTime();
    if (!isNaN(sinceMs)) {
      // binary search for first index where ts > sinceMs
      let lo = 0, hi = buf.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (new Date(buf[mid].createdAt).getTime() <= sinceMs) lo = mid + 1;
        else hi = mid;
      }
      start = lo;
    }
  }
  const sliced = buf.slice(start);
  const n = Math.min(typeof limit === 'number' && limit > 0 ? limit : 50, 200);
  // newest-first
  return sliced.slice(-n).reverse();
}

function markRead(scope) {
  const s = _trimScope(scope);
  _unread[s] = 0;
}

function getUnread(scope) {
  return _unread[_trimScope(scope)] || 0;
}

function getAllUnread() {
  return {
    community: _unread.community || 0,
    dm: _unread.dm || 0,
  };
}

function setDisplayName(name) {
  _displayName = String(name || '').trim().slice(0, 32);
}

function getDisplayName() {
  return _displayName;
}

function setCustomerTag(tag) {
  _customerTag = String(tag || '').trim();
}

function setMachineId(id) {
  _machineId = String(id || '').trim();
}

function resolveDisplayName() {
  if (_displayName) return _displayName;
  if (_customerTag) return _customerTag.slice(0, 32);
  if (_machineId) return _machineId.slice(0, 8);
  return 'operator';
}

/** Test helper — wipes all state. */
function clear() {
  _buffers.community = [];
  _buffers.dm = [];
  _unread.community = 0;
  _unread.dm = 0;
  _displayName = '';
  _customerTag = '';
  _machineId = '';
}

module.exports = {
  addMessage,
  getMessages,
  markRead,
  getUnread,
  getAllUnread,
  setDisplayName,
  getDisplayName,
  setCustomerTag,
  setMachineId,
  resolveDisplayName,
  clear,
  _buffers,         // exported for tests
  _unread,          // exported for tests
  MAX_PER_SCOPE,
};
