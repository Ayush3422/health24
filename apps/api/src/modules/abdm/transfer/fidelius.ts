import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

/**
 * Encrypting a bundle for the requester and nobody else (sp8-plan.md, T22,
 * DF7).
 *
 * ABDM does not send health information through the gateway in clear, and it
 * does not encrypt it to a long-lived key either. Each transfer has its own
 * ephemeral key pair on each side: the requester sends a public key and a
 * nonce with the data request, this system generates its own pair, the two
 * agree a shared secret, and the bundles are encrypted under a key derived
 * from that secret and from **both** nonces. Nothing that could decrypt the
 * transfer exists after it, on either side, unless somebody kept it.
 *
 * Written with the platform's own primitives — X25519, HKDF-SHA256 and
 * AES-256-GCM are all in Node — because a dependency here is a dependency in
 * the most sensitive path in the system, and because this is exactly the kind
 * of code where an unmaintained package is worse than a hundred lines.
 *
 * **What is asserted and what is not.** The scheme below is self-consistent
 * and proved so by a test that plays both sides. The specific parameters —
 * that the salt is the two nonces exclusive-ored, that the info string is
 * `ndhm`, that the key and the initialisation vector are taken from one
 * derivation in that order — are the published ones as understood here, and
 * they are the sort of detail where being nearly right is being wrong.
 * Reconciling them against the sandbox is T38; until then this module is the
 * one place any of it would change.
 */

const CURVE = 'x25519';
const NONCE_BYTES = 32;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const INFO = 'ndhm';

export interface PartyKeyMaterial {
  /** Base64, raw X25519 public key. */
  publicKey: string;
  /** Base64, 32 bytes. */
  nonce: string;
}

export interface TransferKeys {
  /** What the requester is told, so it can derive the same secret. */
  ours: PartyKeyMaterial;
  /** The derived content key. Lives as long as the transfer and no longer. */
  key: Buffer;
  iv: Buffer;
}

/** Raw 32 bytes of an X25519 public key, however the key object holds them. */
function rawPublicKey(key: KeyObject): Buffer {
  // The DER encoding of an X25519 public key is a 12-byte prefix and the key.
  return key.export({ type: 'spki', format: 'der' }).subarray(12);
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  const prefix = Buffer.from('302a300506032b656e032100', 'hex');
  return createPublicKey({
    key: Buffer.concat([prefix, raw]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * The exclusive-or of the two nonces, as the salt.
 *
 * Both sides contribute: a requester that reuses its nonce cannot, on its
 * own, make two transfers share a key, because this system's nonce is fresh
 * every time.
 */
function xorNonces(a: Buffer, b: Buffer): Buffer {
  const length = Math.max(a.length, b.length);
  const out = Buffer.alloc(length);

  for (let i = 0; i < length; i += 1) {
    out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  }

  return out;
}

function derive(sharedSecret: Buffer, salt: Buffer): { key: Buffer; iv: Buffer } {
  const material = Buffer.from(
    hkdfSync('sha256', sharedSecret, salt, Buffer.from(INFO), KEY_BYTES + IV_BYTES),
  );

  return {
    key: material.subarray(0, KEY_BYTES),
    iv: material.subarray(KEY_BYTES, KEY_BYTES + IV_BYTES),
  };
}

/**
 * Agrees a key for one transfer with the requester's key material.
 *
 * The private key never leaves this function's stack: it is used once, for
 * one agreement, and is not returned, stored or logged.
 */
export function agreeTransferKeys(theirs: PartyKeyMaterial): TransferKeys {
  const theirPublic = publicKeyFromRaw(Buffer.from(theirs.publicKey, 'base64'));
  const { publicKey, privateKey } = generateKeyPairSync(CURVE);

  const sharedSecret = diffieHellman({ privateKey, publicKey: theirPublic });
  const ourNonce = randomBytes(NONCE_BYTES);
  const salt = xorNonces(Buffer.from(theirs.nonce, 'base64'), ourNonce);
  const { key, iv } = derive(sharedSecret, salt);

  return {
    ours: {
      publicKey: rawPublicKey(publicKey).toString('base64'),
      nonce: ourNonce.toString('base64'),
    },
    key,
    iv,
  };
}

/** One bundle, encrypted under the agreed key. Base64 of ciphertext and tag. */
export function encryptBundle(keys: TransferKeys, bundle: unknown): string {
  const cipher = createCipheriv('aes-256-gcm', keys.key, keys.iv);

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(bundle), 'utf8')),
    cipher.final(),
  ]);

  return Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64');
}

/**
 * The requester's side, implemented here so that a test can play it.
 *
 * It exists for one reason: a scheme nobody has decrypted is a scheme that
 * has not been shown to work. Nothing in the running system calls this.
 */
export function decryptAsRequester(
  theirKeyMaterial: PartyKeyMaterial,
  ourPrivateKey: KeyObject,
  ourNonce: string,
  content: string,
): unknown {
  const theirPublic = publicKeyFromRaw(Buffer.from(theirKeyMaterial.publicKey, 'base64'));
  const sharedSecret = diffieHellman({ privateKey: ourPrivateKey, publicKey: theirPublic });

  const salt = xorNonces(
    Buffer.from(ourNonce, 'base64'),
    Buffer.from(theirKeyMaterial.nonce, 'base64'),
  );

  const { key, iv } = derive(sharedSecret, salt);

  const raw = Buffer.from(content, 'base64');
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(0, raw.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

/** A requester's own key material, for the tests and for the mock gateway. */
export function generateRequesterKeys(): {
  material: PartyKeyMaterial;
  privateKey: KeyObject;
} {
  const { publicKey, privateKey } = generateKeyPairSync(CURVE);

  return {
    material: {
      publicKey: rawPublicKey(publicKey).toString('base64'),
      nonce: randomBytes(NONCE_BYTES).toString('base64'),
    },
    privateKey,
  };
}
