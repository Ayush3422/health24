/**
 * Encryption for the offline cache.
 *
 * AES-GCM under a key generated for the session, **non-extractable** and held
 * in memory only. Nothing can read the key back out — not this code, not a
 * script injected later — and it is gone when the tab closes, the page
 * reloads, or the session ends. Whatever ciphertext is left in IndexedDB
 * after that is unreadable by anyone, including the next person at a shared
 * ward workstation.
 */

export interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(key: CryptoKey, value: unknown): Promise<Sealed> {
  // A fresh 96-bit nonce per record: GCM's security depends on never reusing one.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(JSON.stringify(value)),
  );

  return { iv, data };
}

/** Throws when the record was sealed under another key, or has been altered. */
export async function unseal<T>(key: CryptoKey, sealed: Sealed): Promise<T> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.data);
  return JSON.parse(decoder.decode(plain)) as T;
}
