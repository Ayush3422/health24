import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service';

const passwords = new PasswordService();

describe('PasswordService.validate', () => {
  it('accepts a reasonable passphrase', () => {
    expect(passwords.validate('correct horse battery staple')).toEqual([]);
  });

  it('rejects anything shorter than twelve characters', () => {
    expect(passwords.validate('short1!')).toContain('Password must be at least 12 characters');
  });

  it('accepts a long password with no special characters', () => {
    // Length over composition rules on purpose: complexity requirements push
    // people towards Passw0rd! and sticky notes.
    expect(passwords.validate('all lowercase and quite long indeed')).toEqual([]);
  });

  it('rejects an obvious choice even at full length', () => {
    expect(passwords.validate('passwordpassword')).toContain('That password is too common');
  });

  it('rejects a single repeated character', () => {
    expect(passwords.validate('aaaaaaaaaaaaaaa')).toContain(
      'Password cannot be a single repeated character',
    );
  });

  it('rejects a password containing the user email', () => {
    const problems = passwords.validate('meera-is-my-password', {
      email: 'meera@sanjeevani.example.in',
    });

    expect(problems).toContain('Password must not contain your email address');
  });

  it('rejects a password containing the user name', () => {
    const problems = passwords.validate('ramesh-and-more-text', { name: 'Ramesh Kumar' });
    expect(problems).toContain('Password must not contain your name');
  });

  it('does not reject on a short name fragment', () => {
    // A two-letter name must not make half the dictionary unusable.
    expect(passwords.validate('a fine long passphrase', { name: 'Li Wei' })).toEqual([]);
  });
});

describe('PasswordService hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await passwords.hash('a fine long passphrase');
    expect(await passwords.verify(hash, 'a fine long passphrase')).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await passwords.hash('a fine long passphrase');
    expect(await passwords.verify(hash, 'a different passphrase')).toBe(false);
  });

  it('produces a different hash for the same password', async () => {
    // Salted, so two users with the same password are not visibly identical
    // in the database.
    const a = await passwords.hash('identical passphrase');
    const b = await passwords.hash('identical passphrase');
    expect(a).not.toBe(b);
  });

  it('uses argon2id', async () => {
    expect(await passwords.hash('a fine long passphrase')).toContain('$argon2id$');
  });

  it('returns false rather than throwing on a corrupt hash', async () => {
    // A corrupt row must deny access, not produce a 500 that confirms the
    // account exists.
    expect(await passwords.verify('not-a-hash', 'anything')).toBe(false);
    expect(await passwords.verify('', 'anything')).toBe(false);
  });
});
