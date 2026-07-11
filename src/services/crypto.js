'use strict';

const crypto = require('crypto');
const config = require('../../config');

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard

function getKey() {
  const key = config.encryptionKey;
  if (!key || key.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters (hex or random string).');
  }
  // รองรับทั้ง hex และ string ทั่วไป — pad/trim ให้ได้ 32 bytes
  let keyBuf;
  if (/^[0-9a-fA-F]+$/.test(key) && key.length === 64) {
    keyBuf = Buffer.from(key, 'hex');
  } else {
    // ใช้ SHA-256 ของ key เพื่อให้ได้ 32 bytes ที่แน่นอน
    keyBuf = crypto.createHash('sha256').update(key).digest();
  }
  return keyBuf;
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: tag.toString('base64'),
  };
}

function decrypt(enc) {
  if (!enc || !enc.ciphertext) return null;
  const iv = Buffer.from(enc.iv, 'base64');
  const ct = Buffer.from(enc.ciphertext, 'base64');
  const tag = Buffer.from(enc.authTag, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { encrypt, decrypt };