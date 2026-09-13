import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import argon2 from 'argon2';
import * as OTPAuth from 'otpauth';
import { decryptSecret, encryptSecret, generateToken } from '../../common/crypto';

export interface TotpEnrolment {
  /** Encrypted, ready to store. */
  secretEncrypted: string;
  /** Shown once, as a QR code and as text for manual entry. */
  otpauthUrl: string;
  /** The base32 secret, for users who cannot scan. Never persisted in clear. */
  secretForDisplay: string;
}

export interface RecoveryCodes {
  /** Shown to the user exactly once. */
  plaintext: string[];
  /** Argon2 hashes, for storage. */
  hashes: string[];
}

/**
 * Time-based one-time passwords, mandatory for clinical and admin accounts.
 *
 * A stolen password alone must not open a patient record. Given that hospital
 * workstations are shared and passwords get written down, the second factor is
 * doing most of the real work here.
 */
@Injectable()
export class TotpService {
  private readonly issuer: string;
  private readonly encryptionKey: string;

  /**
   * Accepts codes from one step either side of now — 30 seconds of tolerance
   * for clock drift, which is ordinary on hospital machines. Wider windows
   * meaningfully weaken the factor.
   */
  private static readonly WINDOW = 1;

  private static readonly RECOVERY_CODE_COUNT = 10;

  constructor(private readonly config: ConfigService) {
    this.issuer = this.config.get<string>('TOTP_ISSUER') ?? 'Health24';
    this.encryptionKey = this.config.getOrThrow<string>('TOTP_ENCRYPTION_KEY');
  }

  /** Generates a new secret for a user who is enrolling. */
  createEnrolment(accountLabel: string): TotpEnrolment {
    const secret = new OTPAuth.Secret({ size: 20 });

    const totp = new OTPAuth.TOTP({
      issuer: this.issuer,
      label: accountLabel,
      algorithm: 'SHA1', // What every authenticator app actually supports.
      digits: 6,
      period: 30,
      secret,
    });

    return {
      secretEncrypted: encryptSecret(secret.base32, this.encryptionKey),
      otpauthUrl: totp.toString(),
      secretForDisplay: secret.base32,
    };
  }

  /**
   * Verifies a 6-digit code against an encrypted secret.
   *
   * Returns false on a decryption failure rather than throwing: a corrupt or
   * unreadable secret must deny access, not crash the login route.
   */
  verify(secretEncrypted: string, code: string): boolean {
    let base32: string;

    try {
      base32 = decryptSecret(secretEncrypted, this.encryptionKey);
    } catch {
      return false;
    }

    const totp = new OTPAuth.TOTP({
      issuer: this.issuer,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(base32),
    });

    // `validate` returns the time-step delta, or null when no step matches.
    return totp.validate({ token: code, window: TotpService.WINDOW }) !== null;
  }

  /**
   * Single-use codes for when the authenticator device is lost.
   *
   * Without these, a lost phone means an administrator resets the second
   * factor by hand, and that reset path becomes the weakest link in the whole
   * auth system.
   */
  async createRecoveryCodes(): Promise<RecoveryCodes> {
    const plaintext = Array.from({ length: TotpService.RECOVERY_CODE_COUNT }, () =>
      generateToken(8)
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase()
        .slice(0, 10)
        .padEnd(10, 'X'),
    );

    const hashes = await Promise.all(plaintext.map((code) => argon2.hash(code)));

    return { plaintext, hashes };
  }

  /**
   * Consumes a recovery code.
   *
   * Returns the remaining hashes with the used one removed, so the caller can
   * persist the reduction. A recovery code that survives its own use is not a
   * recovery code.
   */
  async consumeRecoveryCode(
    hashes: string[],
    candidate: string,
  ): Promise<{ matched: boolean; remaining: string[] }> {
    const normalised = candidate.trim().toUpperCase();

    for (const hash of hashes) {
      let matched = false;
      try {
        matched = await argon2.verify(hash, normalised);
      } catch {
        matched = false;
      }

      if (matched) {
        return { matched: true, remaining: hashes.filter((h) => h !== hash) };
      }
    }

    return { matched: false, remaining: hashes };
  }
}
