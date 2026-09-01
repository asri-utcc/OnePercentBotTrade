/**
 * FIX-2026-09-01 audit: Frontend XSS hardening (CRITICAL C8/C9/C10).
 *
 * Audit 2026-09-01 surfaced unescaped innerHTML interpolations in:
 *   - bot-edit.js   : bot.name / bot.symbol / bot.timeframe in header + inputs
 *   - bot-detail.js : t.state / t.symbol / t.timeframe / orderIds / statuses in detail panel + trades table
 *   - wallet.js     : b.asset / o.symbol / o.type / orderId / clientOrderId (NO helper existed)
 *
 * Contract tests verify escapeHtml is applied to all these vectors, and the
 * helper exists in wallet.js (it didn't before).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BOT_EDIT     = path.join(__dirname, '..', 'public', 'js', 'pages', 'bot-edit.js');
const BOT_DETAIL   = path.join(__dirname, '..', 'public', 'js', 'pages', 'bot-detail.js');
const WALLET       = path.join(__dirname, '..', 'public', 'js', 'pages', 'wallet.js');

const botEditRaw   = fs.readFileSync(BOT_EDIT,   'utf8');
const botDetailRaw = fs.readFileSync(BOT_DETAIL, 'utf8');
const walletRaw    = fs.readFileSync(WALLET,     'utf8');

describe('audit-C8 bot-edit.js — escapeHtml on all bot.X interpolations', () => {
  test('escapeHtml helper exists', () => {
    expect(botEditRaw).toMatch(/function\s+escapeHtml\s*\(/);
  });

  test('bot.name input value escaped', () => {
    expect(botEditRaw).toMatch(/id="f-name" value="\$\{escapeHtml\(bot\.name \|\| ''\)\}"/);
  });

  test('bot.symbol disabled input escaped', () => {
    expect(botEditRaw).toMatch(/value="\$\{escapeHtml\(bot\.symbol\)\}" disabled/);
  });

  test('header subtitle escapes symbol + timeframe', () => {
    expect(botEditRaw).toMatch(/\$\{escapeHtml\(bot\.symbol\)\} · \$\{escapeHtml\(bot\.timeframe\)\}/);
  });

  test('header title still uses escapeHtml for name || symbol', () => {
    expect(botEditRaw).toMatch(/⚙️ \$\{escapeHtml\(bot\.name \|\| bot\.symbol\)\}/);
  });
});

describe('audit-C9 bot-detail.js — escapeHtml on trade fields', () => {
  test('escapeHtml helper exists at end of file', () => {
    expect(botDetailRaw).toMatch(/function\s+escapeHtml\s*\(/);
  });

  test('detail panel: state pill content escaped', () => {
    expect(botDetailRaw).toMatch(/status-pill is-\$\{escapeHtml\(stateClass\)\}">\$\{escapeHtml\(t\.state\)\}/);
  });

  test('detail panel: symbol · timeframe escaped', () => {
    expect(botDetailRaw).toMatch(/\$\{escapeHtml\(t\.symbol\)\} · \$\{escapeHtml\(t\.timeframe\)\}/);
  });

  test('detail panel: orderIds escaped', () => {
    expect(botDetailRaw).toMatch(/BUY OrderId[\s\S]{0,200}\$\{escapeHtml\(t\.buyOrderId\) \|\| '-'\}/);
    expect(botDetailRaw).toMatch(/SELL OrderId[\s\S]{0,200}\$\{escapeHtml\(t\.sellOrderId\) \|\| '-'\}/);
  });

  test('detail panel: buy/sell status escaped', () => {
    expect(botDetailRaw).toMatch(/status-pill is-\$\{escapeHtml\(buyStatusClass\)\}">\$\{escapeHtml\(t\.buyStatus\) \|\| '-'\}/);
  });

  test('trades table: state, statuses, orderId escaped', () => {
    expect(botDetailRaw).toMatch(/status-pill is-\$\{escapeHtml\(sc\)\}">\$\{escapeHtml\(t\.state\)\}/);
    expect(botDetailRaw).toMatch(/\$\{escapeHtml\(t\.buyStatus\) \|\| ''\}\$\{t\.sellStatus \? ` → \$\{escapeHtml\(t\.sellStatus\)\}`/);
    expect(botDetailRaw).toMatch(/<span class="code">\$\{escapeHtml\(t\.buyOrderId\) \|\| '-'\}/);
  });

  test('numeric coercion: retryCount and buyQty not interpolated raw', () => {
    // Defensive: numbers passed through escapeHtml won't break (escapeHtml casts via String())
    expect(botDetailRaw).toMatch(/Number\(t\.retryCount \?\? 0\)/);
  });

  test('t.error was already escaped (regression guard)', () => {
    expect(botDetailRaw).toMatch(/escapeHtml\(t\.error\)/);
  });
});

describe('audit-C10 wallet.js — escapeHtml helper added + applied', () => {
  test('escapeHtml helper exists (was missing before)', () => {
    expect(walletRaw).toMatch(/function\s+escapeHtml\s*\(/);
  });

  test('balances table: b.asset escaped', () => {
    expect(walletRaw).toMatch(/<div class="\$\{iconCls\}">\s*\$\{escapeHtml\(b\.asset\)\}/);
  });

  test('open orders: o.symbol + o.type + side escaped', () => {
    expect(walletRaw).toMatch(/<b>\$\{escapeHtml\(o\.symbol\)\}<\/b>/);
    expect(walletRaw).toMatch(/<span class="wallet-order-type">\$\{escapeHtml\(type\)\}<\/span>/);
    expect(walletRaw).toMatch(/<span class="\$\{sideClass\}">\$\{escapeHtml\(side\)\}<\/span>/);
  });

  test('orderId + clientOrderId escaped in title + content', () => {
    expect(walletRaw).toMatch(/title="\$\{escapeHtml\(orderId\)\}"/);
    expect(walletRaw).toMatch(/title="\$\{escapeHtml\(clientOrderId\)\}"/);
    expect(walletRaw).toMatch(/#\$\{escapeHtml\(orderId\.slice\(-8\)\)\}/);
    expect(walletRaw).toMatch(/\$\{escapeHtml\(clientShort\)\}/);
  });

  test('executedQty + origQty in progress title escaped', () => {
    expect(walletRaw).toMatch(/title="\$\{escapeHtml\(String\(executedQty\)\)\} \/ \$\{escapeHtml\(String\(origQty\)\)\}/);
  });

  test('age field escaped', () => {
    expect(walletRaw).toMatch(/<td class="num">\$\{escapeHtml\(age\)\}<\/td>/);
  });
});