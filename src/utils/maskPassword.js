'use strict';

/**
 * FIX-2026-08-10: maskPassword — UI-safe display of attempted password
 *
 * Why: LoginAttempt now stores plaintext `attemptedPassword` for password-method
 *      wrong-password failures so admin can audit leaked old passwords.
 *      UI must NEVER show the full value by default — mask with first 2 + middle
 *      stars + last 1 char. Admin can click to reveal.
 *
 * Examples:
 *   ''        → '—'
 *   'a'       → 'a'                 (too short → no mask)
 *   'ab'      → 'ab'                (too short)
 *   'abc'     → 'a*c'               (3 chars → show all)
 *   'abcd'    → 'a**d'              (4+ chars → mask middle)
 *   'MyPassword123' → 'My***3'
 *   'verylongpasswordname' → 've***e'
 *
 * Rules:
 *   - empty / null → '—' (em dash, indicates no attempt)
 *   - 1-2 chars   → return as-is (masking adds nothing)
 *   - 3 chars     → first + '*' + last
 *   - 4+ chars    → first 2 + '*'×(len-3) + last 1
 *
 * Frontend usage:
 *   const { maskPassword } = await import('./utils/maskPassword.js');
 *   span.textContent = maskPassword(attempt.attemptedPassword);
 *   onClick: span.textContent = revealed ? maskPassword(...) : attempt.attemptedPassword
 */

function maskPassword(raw) {
  if (raw == null) return '—';
  const s = String(raw);
  if (!s) return '—';
  const len = s.length;
  if (len <= 2) return s;
  if (len === 3) return s[0] + '*' + s[2];
  // 4+ chars: first 2 + (len-3) stars + last 1
  return s.slice(0, 2) + '*'.repeat(len - 3) + s.slice(-1);
}

module.exports = { maskPassword };