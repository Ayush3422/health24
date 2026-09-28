import { describe, expect, it } from 'vitest';
import {
  agreeTransferKeys,
  decryptAsRequester,
  encryptBundle,
  generateRequesterKeys,
} from './fidelius';

/**
 * The transfer encryption, proved by decrypting it (sp8-plan.md, T22).
 *
 * A scheme nobody has decrypted is a scheme that has not been shown to work,
 * so these tests play the requester: they generate its key pair, hand this
 * system the public half, and then open what comes back. What they cannot
 * prove is that ABDM derives the key the same way — that is T38, and the
 * module says so.
 */
describe('encrypting a bundle for the requester', () => {
  const bundle = { resourceType: 'Bundle', type: 'document', entry: [{ id: 'one' }] };

  it('comes back out the other side, unchanged', () => {
    const requester = generateRequesterKeys();
    const keys = agreeTransferKeys(requester.material);

    const content = encryptBundle(keys, bundle);

    expect(
      decryptAsRequester(keys.ours, requester.privateKey, requester.material.nonce, content),
    ).toEqual(bundle);
  });

  it('is not readable by somebody else’s key', () => {
    const requester = generateRequesterKeys();
    const eavesdropper = generateRequesterKeys();
    const keys = agreeTransferKeys(requester.material);

    const content = encryptBundle(keys, bundle);

    expect(() =>
      decryptAsRequester(keys.ours, eavesdropper.privateKey, requester.material.nonce, content),
    ).toThrow();
  });

  /** The authentication half of authenticated encryption. */
  it('refuses a bundle somebody altered in transit', () => {
    const requester = generateRequesterKeys();
    const keys = agreeTransferKeys(requester.material);

    const content = encryptBundle(keys, bundle);
    const raw = Buffer.from(content, 'base64');
    raw[10] = (raw[10] ?? 0) ^ 0xff;

    expect(() =>
      decryptAsRequester(
        keys.ours,
        requester.privateKey,
        requester.material.nonce,
        raw.toString('base64'),
      ),
    ).toThrow();
  });

  /**
   * The property DF7 is about. Two transfers to the same requester, with the
   * same public key, must not share a key — this system's nonce and key pair
   * are fresh each time, so a requester cannot make them collide.
   */
  it('gives every transfer its own key, even to the same requester', () => {
    const requester = generateRequesterKeys();

    const first = agreeTransferKeys(requester.material);
    const second = agreeTransferKeys(requester.material);

    expect(first.ours.publicKey).not.toBe(second.ours.publicKey);
    expect(first.ours.nonce).not.toBe(second.ours.nonce);
    expect(first.key.equals(second.key)).toBe(false);

    // And one transfer's key opens nothing of the other's.
    const content = encryptBundle(first, bundle);

    expect(() =>
      decryptAsRequester(second.ours, requester.privateKey, requester.material.nonce, content),
    ).toThrow();
  });

  it('keeps nothing that could open it afterwards', () => {
    const requester = generateRequesterKeys();
    const keys = agreeTransferKeys(requester.material);

    // What comes back is a public key, a nonce, and the content key this
    // transfer uses. There is no private key here to be logged or stored:
    // it was used once inside the agreement and never left it.
    expect(Object.keys(keys).sort()).toEqual(['iv', 'key', 'ours']);
    expect(JSON.stringify(keys.ours)).not.toContain('PRIVATE');
  });

  it('produces a different ciphertext for the same bundle each time', () => {
    const requester = generateRequesterKeys();

    const one = encryptBundle(agreeTransferKeys(requester.material), bundle);
    const other = encryptBundle(agreeTransferKeys(requester.material), bundle);

    expect(one).not.toBe(other);
  });
});
