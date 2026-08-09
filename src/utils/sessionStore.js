'use strict';

/**
 * FIX-2026-08-09: connect-mongo v5 `sessionStore.all()` has 2 bugs:
 *   1) returns ONLY the unserialized inner session data (not the wrapper {_id, session, expires})
 *   2) stringifies session by default (stringify=true) — all() calls JSON.parse internally,
 *      but we lose _id and expires in the process
 * Result: session IDs and expires are NOT exposed via sessionStore.all() → can't list or
 *         kill sessions reliably.
 *
 * Workaround: query MongoDB collection directly via mongoose.connection.db.
 *   - doc._id       = session ID (computeStorageId is identity by default)
 *   - doc.session   = JSON STRING (stringify=true default) → JSON.parse needed
 *   - doc.expires   = Date
 *
 * Used by /api/auth/sessions + /api/auth/sessions/kill-others + change-password killOthers.
 */

const mongoose = require('mongoose');

/**
 * Get all active session docs from MongoDB collection.
 * @returns {Promise<Array<{_id: string, session: string|object, expires?: Date}>>}
 */
async function getAllSessionDocs() {
  const coll = mongoose.connection.db.collection('sessions');
  const docs = await coll.find({
    $or: [
      { expires: { $exists: false } },
      { expires: { $gt: new Date() } },
    ],
  }).toArray();
  return docs;
}

/**
 * Parse connect-mongo session data — handles both string (stringify=true default) and pre-parsed object.
 * @param {string|object|null|undefined} raw
 * @returns {object} parsed session data (empty object on parse failure)
 */
function unserializeSessionData(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

module.exports = {
  getAllSessionDocs,
  unserializeSessionData,
};