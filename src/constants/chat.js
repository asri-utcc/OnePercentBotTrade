'use strict';

/**
 * Phase 4 chat v2 — constants (mirror of admin).
 *
 * The bot side keeps its own copy because the bot runs without admin at boot
 * (and tests in isolation). Keep in sync with
 * `OnePercentBot-Admin/src/constants/chat.js`.
 */

const MAX_TEXT_LENGTH = 2000;
const MAX_DISPLAY_NAME_LENGTH = 32; // Trade side cap is stricter
const MIN_DISPLAY_NAME_LENGTH = 1;

const MAX_FETCH_LIMIT = 200;
const DEFAULT_FETCH_LIMIT = 50;
const LOCAL_RING_BUFFER_LIMIT = 200;

const TTL_SECONDS = 90 * 24 * 60 * 60;

const BOT_INBOX_POLL_MS = 5 * 1000;
const BOT_OUTBOX_POLL_MS = 3 * 1000;
const BOT_OUTBOX_BATCH = 10;
const BOT_UNREAD_NAV_POLL_MS = 10 * 1000;

const SCOPES = Object.freeze(['community', 'dm']);

// ─── Identity ───
const OPERATOR_COLORS = Object.freeze([
  '#4a9eff', '#22c55e', '#eab308', '#a855f7',
  '#ec4899', '#06b6d4', '#f97316', '#84cc16',
]);
const ADMIN_COLOR = '#ef4444';
const SYSTEM_ICONS = Object.freeze([
  '🦊', '🐱', '🐶', '�', '🦁',
  '🐯', '🐸', '🐵', '�', '🦅',
  '🐢', '🐧', '🐳', '🦋', '�',
  '🐞', '🌸', '🌺', '🌻', '🍀',
]);
const ADMIN_ICON = '🛡';
const MAX_COLOR_LENGTH = 16;
const MAX_ICON_LENGTH = 8;
const REPLY_PREVIEW_MAX = 100;

// ─── Time grouping ───
const BURST_GAP_MS = 5 * 60 * 1000;
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

// ─── Attachments ───
const MAX_ATTACHMENT_BYTES = 500 * 1024;
const DAILY_ATTACHMENT_LIMIT = 5;
const ALLOWED_ATTACHMENT_MIME = Object.freeze({
  image: Object.freeze(['image/png', 'image/jpeg']),
  text:  Object.freeze([
    'text/plain',
    'application/json',
    'text/csv',
    'text/markdown',
  ]),
});
const ALLOWED_ATTACHMENT_EXT = Object.freeze({
  image: Object.freeze(['png', 'jpg', 'jpeg']),
  text:  Object.freeze(['txt', 'json', 'csv', 'md']),
});
const ATTACHMENT_KINDS = Object.freeze(['image', 'text']);

module.exports = {
  MAX_TEXT_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DISPLAY_NAME_LENGTH,
  MAX_FETCH_LIMIT,
  DEFAULT_FETCH_LIMIT,
  LOCAL_RING_BUFFER_LIMIT,
  TTL_SECONDS,
  BOT_INBOX_POLL_MS,
  BOT_OUTBOX_POLL_MS,
  BOT_OUTBOX_BATCH,
  BOT_UNREAD_NAV_POLL_MS,
  SCOPES,
  OPERATOR_COLORS,
  ADMIN_COLOR,
  SYSTEM_ICONS,
  ADMIN_ICON,
  MAX_COLOR_LENGTH,
  MAX_ICON_LENGTH,
  REPLY_PREVIEW_MAX,
  BURST_GAP_MS,
  BKK_OFFSET_MS,
  MAX_ATTACHMENT_BYTES,
  DAILY_ATTACHMENT_LIMIT,
  ALLOWED_ATTACHMENT_MIME,
  ALLOWED_ATTACHMENT_EXT,
  ATTACHMENT_KINDS,
};
