import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/**
 * Password hashing and policy.
 *
 * argon2id with parameters at the OWASP minimum: 19 MiB of memory, 2
 * iterations, parallelism 1. Memory hardness is the point — it is what makes
 * GPU-based cracking expensive, which bcrypt does not do well.
 */
@Injectable()
export class PasswordService {
  private static readonly OPTIONS = {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  } as const;

  /**
   * Passwords that pass the length rule but are still worthless. Kept short
   * and specific to this context — a full breach-corpus check belongs behind
   * an API, not in process memory.
   */
  private static readonly BLOCKED = new Set([
    'password1234',
    'passwordpassword',
    'health24health24',
    'administrator',
    '123456789012',
    'qwertyuiop12',
    'iloveyou1234',
    'welcome12345',
  ]);

  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, PasswordService.OPTIONS);
  }

  /**
   * Verifies a password against a stored hash.
   *
   * Returns false rather than throwing on a malformed hash, so that a corrupt
   * row denies access instead of returning a 500 that tells an attacker the
   * account exists.
   */
  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      return false;
    }
  }

  /**
   * Burns roughly the same time as a real verification.
   *
   * Called when the email does not exist, so that response timing cannot be
   * used to enumerate which accounts are real.
   */
  async fakeVerify(): Promise<void> {
    await argon2.hash('timing-equalisation-placeholder', PasswordService.OPTIONS);
  }

  /**
   * Policy check. Length over composition rules: a long passphrase beats
   * `Passw0rd!`, and composition rules mostly produce passwords on sticky
   * notes.
   */
  validate(plaintext: string, context: { email?: string; name?: string } = {}): string[] {
    const problems: string[] = [];
    const lower = plaintext.toLowerCase();

    if (plaintext.length < 12) {
      problems.push('Password must be at least 12 characters');
    }

    if (plaintext.length > 200) {
      problems.push('Password must be at most 200 characters');
    }

    if (PasswordService.BLOCKED.has(lower)) {
      problems.push('That password is too common');
    }

    if (/^(.)\1+$/.test(plaintext)) {
      problems.push('Password cannot be a single repeated character');
    }

    const localPart = context.email?.split('@')[0]?.toLowerCase();
    if (localPart && localPart.length >= 4 && lower.includes(localPart)) {
      problems.push('Password must not contain your email address');
    }

    if (context.name) {
      const firstName = context.name.trim().split(/\s+/)[0]?.toLowerCase();
      if (firstName && firstName.length >= 4 && lower.includes(firstName)) {
        problems.push('Password must not contain your name');
      }
    }

    return problems;
  }
}
