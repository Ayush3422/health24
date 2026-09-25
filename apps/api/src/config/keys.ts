import type { ConfigService } from '@nestjs/config';
import type { JwtService, JwtVerifyOptions } from '@nestjs/jwt';

/**
 * The keys in force, and the one they replaced (sp7-plan.md, T4).
 *
 * A key that cannot be rotated without signing everybody out is a key that
 * never gets rotated, which is how a leaked secret stays in use for years.
 * Both of ours therefore come in pairs: the current one, which everything is
 * written and signed with, and optionally the previous one, which is still
 * accepted while the overlap lasts.
 *
 * The procedure that uses this is `docs/runbooks/key-rotation.md`.
 */

/** The TOTP encryption keys to try, newest first. */
export function totpKeys(config: ConfigService): string[] {
  const current = config.getOrThrow<string>('TOTP_ENCRYPTION_KEY');
  const previous = config.get<string>('TOTP_ENCRYPTION_KEY_PREVIOUS');

  return previous ? [current, previous] : [current];
}

/** The token signing secrets to try when verifying, newest first. */
export function jwtSecrets(config: ConfigService): string[] {
  const current = config.getOrThrow<string>('JWT_ACCESS_SECRET');
  const previous = config.get<string>('JWT_ACCESS_SECRET_PREVIOUS');

  return previous ? [current, previous] : [current];
}

/**
 * Verifies a token against the current secret, then the previous one.
 *
 * Signing always uses the current secret — `JwtModule` is configured with it —
 * so a rotation only has to keep yesterday's tokens readable until they
 * expire, which for an access token is minutes and for a challenge token less
 * than that.
 */
export async function verifyWithRotation<T extends object>(
  jwt: JwtService,
  secrets: readonly string[],
  token: string,
  options: JwtVerifyOptions = {},
): Promise<T> {
  let lastError: unknown;

  for (const secret of secrets) {
    try {
      return await jwt.verifyAsync<T>(token, { ...options, secret });
    } catch (error: unknown) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Token verification failed');
}
