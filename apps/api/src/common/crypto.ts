import crypto from 'node:crypto';

/**
 * Symmetric encryption for secrets held at rest.
 *
 * Used for TOTP shared secrets. A TOTP secret is a bearer credential: anyone
 * holding it can generate valid second factors forever. Storing it in plain
 * text means a database dump hands an attacker every user's second factor,
 * which would make the second factor pointless.
 *
 * AES-256-GCM, random 12-byte IV per encryption, authentication tag appended.
 * Output format is `v1.<iv>.<ciphertext>.<tag>`, base64url throughout — the
 * version prefix exists so the scheme can be rotated later without guessing
 * how old rows were written.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

export class CryptoError extends Error {}

function toKey(rawKey: string): Buffer {
  const key = Buffer.from(rawKey, 'base64url');

  if (key.length !== 32) {
    throw new CryptoError(
      `Encryption key must decode to 32 bytes, got ${key.length}. ` +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
    );
  }

  return key;
}

export function encryptSecret(plaintext: string, rawKey: string): string {
  const key = toKey(rawKey);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

export function decryptSecret(encoded: string, rawKey: string): string {
  const key = toKey(rawKey);
  const parts = encoded.split('.');

  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new CryptoError('Malformed ciphertext');
  }

  const [, ivPart, ciphertextPart, tagPart] = parts as [string, string, string, string];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Tampering, or the wrong key. Do not distinguish the two to the caller.
    throw new CryptoError('Could not decrypt secret');
  }
}

/**
 * Decrypts with whichever key wrote it (sp7-plan.md, T4).
 *
 * During a key rotation the database holds secrets written under both the old
 * key and the new one, and nobody can say which is which without trying. This
 * returns the plaintext and the key that worked, so a caller can tell that a
 * row is still on the old key and have it rewritten.
 *
 * Keys are tried in order, so the current key is tried first and the cost of
 * the overlap falls on the rows that have not been rewritten yet.
 */
export function decryptWithAnyKey(
  encoded: string,
  keys: readonly string[],
): { plaintext: string; keyIndex: number } {
  if (keys.length === 0) throw new CryptoError('No decryption key was supplied');

  for (const [index, key] of keys.entries()) {
    try {
      return { plaintext: decryptSecret(encoded, key), keyIndex: index };
    } catch {
      // The next key, or the error below when none is left.
    }
  }

  throw new CryptoError('Could not decrypt secret with any key');
}

/**
 * Hash for high-entropy tokens (refresh tokens, invite tokens).
 *
 * SHA-256 rather than argon2 deliberately: the input is 256 bits of random
 * data, so there is nothing to brute-force, and lookups must be fast and
 * indexable. Argon2 is for passwords, where the input is low-entropy.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

/** A cryptographically random, URL-safe token. */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Constant-time comparison, for anywhere a timing difference would leak
 * whether a guess was partially correct.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    // timingSafeEqual throws on length mismatch, so compare against self to
    // keep the work constant before returning.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}
