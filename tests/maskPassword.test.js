'use strict';

// FIX-2026-08-10: maskPassword utility tests
//   - UI-safe masking of attempted password
//   - empty/null → em-dash
//   - 1-2 chars → as-is
//   - 3 chars → a*c
//   - 4+ chars → first 2 + stars + last 1

const { maskPassword } = require('../src/utils/maskPassword');

describe('maskPassword (FIX-2026-08-10)', () => {
  test('null/undefined → em-dash', () => {
    expect(maskPassword(null)).toBe('—');
    expect(maskPassword(undefined)).toBe('—');
  });

  test('empty string → em-dash', () => {
    expect(maskPassword('')).toBe('—');
  });

  test('1 char → as-is', () => {
    expect(maskPassword('a')).toBe('a');
  });

  test('2 chars → as-is', () => {
    expect(maskPassword('ab')).toBe('ab');
  });

  test('3 chars → first + * + last', () => {
    expect(maskPassword('abc')).toBe('a*c');
    expect(maskPassword('xyz')).toBe('x*z');
  });

  test('4 chars → first 2 + * + last 1', () => {
    expect(maskPassword('abcd')).toBe('ab*d');
  });

  test('long password → first 2 + (len-3) stars + last 1', () => {
    // 'MyPassword123' (13 chars): 'My' + 10 stars + '3'
    expect(maskPassword('MyPassword123')).toBe(`My${'*'.repeat(10)}3`);
    // 'verylongpassword' (16 chars): 've' + 13 stars + 'd'
    expect(maskPassword('verylongpassword')).toBe(`ve${'*'.repeat(13)}d`);
  });

  test('only-spaces → masked (non-empty)', () => {
    // 5 spaces → '  ' + 2 stars + ' '
    expect(maskPassword('     ')).toBe('  ** ');
  });

  test('unicode is preserved (counted by code units)', () => {
    // Thai chars are BMP (1 UTF-16 code unit each) → len=4 → 'กข' + 1 star + 'ง'
    expect(maskPassword('กขคง')).toBe('กข*ง');
  });
});