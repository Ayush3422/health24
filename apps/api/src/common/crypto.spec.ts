import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  CryptoError,
  decryptSecret,
  encryptSecret,
  generateToken,
  hashToken,
  safeEqual,
} from './crypto';

const KEY = crypto.randomBytes(32).toString('base64url');
const OTHER_KEY = crypto.randomBytes(32).toString('base64url');

describe('secret encryption', () => {
  it('round-trips a value', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(decryptSecret(encryptSecret(secret, KEY), KEY)).toBe(secret);
  });

  it('produces different ciphertext each time', () => {
    // A fresh IV per encryption. Without it, identical secrets produce
    // identical ciphertext and the database leaks which users share one.
    const a = encryptSecret('same-secret', KEY);
    const b = encryptSecret('same-secret', KEY);
    expect(a).not.toBe(b);
  });

  it('refuses a key of the wrong length', () => {
    expect(() => encryptSecret('x', 'too-short')).toThrow(CryptoError);
  });

  it('refuses to decrypt with the wrong key', () => {
    const encrypted = encryptSecret('secret', KEY);
    expect(() => decryptSecret(encrypted, OTHER_KEY)).toThrow(CryptoError);
  });

  it('detects tampering', () => {
    // GCM authenticates as well as encrypts, so a modified ciphertext fails
    // rather than decrypting to garbage that the caller then trusts.
    const encrypted = encryptSecret('secret', KEY);
    const parts = encrypted.split('.');
    const tampered = [parts[0], parts[1], Buffer.from('evil').toString('base64url'), parts[3]].join(
      '.',
    );

    expect(() => decryptSecret(tampered, KEY)).toThrow(CryptoError);
  });

  it('rejects a malformed payload', () => {
    expect(() => decryptSecret('nonsense', KEY)).toThrow(CryptoError);
    expect(() => decryptSecret('v2.a.b.c', KEY)).toThrow(CryptoError);
  });

  it('carries a version prefix so the scheme can be rotated', () => {
    expect(encryptSecret('secret', KEY).startsWith('v1.')).toBe(true);
  });
});

describe('token hashing', () => {
  it('is deterministic', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('differs for different inputs', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('does not store the token itself', () => {
    const token = generateToken();
    expect(hashToken(token)).not.toContain(token);
  });
});

describe('generateToken', () => {
  it('is URL-safe', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateToken()));
    expect(seen.size).toBe(500);
  });
});

describe('safeEqual', () => {
  it('matches identical strings', () => {
    expect(safeEqual('token', 'token')).toBe(true);
  });

  it('rejects different strings', () => {
    expect(safeEqual('token', 'other')).toBe(false);
  });

  it('handles different lengths without throwing', () => {
    // timingSafeEqual throws on a length mismatch; the wrapper must not.
    expect(safeEqual('short', 'considerably-longer')).toBe(false);
  });
});
