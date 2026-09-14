import { describe, expect, it } from 'vitest';
import { createSessionKey, seal, unseal } from './cipher';

describe('offline cache encryption', () => {
  it('opens what it sealed', async () => {
    const key = await createSessionKey();
    const value = { allergies: [{ substance: 'Penicillin', criticality: 'high' }] };

    expect(await unseal(key, await seal(key, value))).toEqual(value);
  });

  it('uses a fresh nonce every time, so equal records never look equal', async () => {
    const key = await createSessionKey();
    const first = await seal(key, 'same');
    const second = await seal(key, 'same');

    expect(first.iv).not.toEqual(second.iv);
    expect(new Uint8Array(first.data)).not.toEqual(new Uint8Array(second.data));
  });

  it('keeps the key inside the browser: it cannot be exported', async () => {
    const key = await createSessionKey();

    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('cannot be opened under any other key — as after a reload or sign-out', async () => {
    const sealed = await seal(await createSessionKey(), { substance: 'Penicillin' });

    await expect(unseal(await createSessionKey(), sealed)).rejects.toThrow();
  });

  it('refuses a record that has been altered', async () => {
    const key = await createSessionKey();
    const sealed = await seal(key, { substance: 'Penicillin' });

    const tampered = new Uint8Array(sealed.data.slice(0));
    tampered[0] = tampered[0]! ^ 0xff;

    await expect(unseal(key, { iv: sealed.iv, data: tampered.buffer })).rejects.toThrow();
  });
});
