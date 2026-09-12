/**
 * Failed-login backoff.
 *
 * The obvious design — lock the account for fifteen minutes after five wrong
 * passwords — is a denial-of-service vector with clinical consequences.
 * Anyone who knows a clinician's email address can lock them out of the
 * patient record system on demand, repeatedly, by failing to log in as them.
 * In a hospital, "the doctor cannot open the record" is not an inconvenience.
 *
 * So the cliff is replaced by a curve. The first few mistakes cost nothing,
 * because people mistype passwords. After that each failure roughly doubles
 * the wait, which a legitimate user experiences as a brief pause and an
 * attacker experiences as a wall: reaching even twenty guesses takes hours,
 * and the account stays usable to its owner throughout.
 *
 * A hard ceiling keeps the worst case bounded — a locked-out clinician is
 * never more than fifteen minutes from their patients, and a real emergency is
 * handled by an administrator, not by waiting.
 */

/** Mistakes forgiven entirely. People mistype, and shift changes are rushed. */
export const FREE_ATTEMPTS = 3;

/** The wait after the first non-free failure. */
export const BASE_DELAY_MS = 2_000;

/** Upper bound, so an account is never unusable for long. */
export const MAX_DELAY_MS = 15 * 60 * 1000;

/**
 * How long to refuse sign-in after `attempts` consecutive failures.
 *
 * Returns 0 while the account is still within its free attempts.
 */
export function lockoutDurationMs(attempts: number): number {
  if (attempts <= FREE_ATTEMPTS) {
    return 0;
  }

  const doublings = attempts - FREE_ATTEMPTS - 1;

  // Guard against overflow before it reaches the comparison: 2 ** 1024 is
  // Infinity, and Math.min(Infinity, cap) is fine, but the intermediate
  // multiplication is clearer bounded here.
  if (doublings > 40) {
    return MAX_DELAY_MS;
  }

  return Math.min(BASE_DELAY_MS * 2 ** doublings, MAX_DELAY_MS);
}

/**
 * When the next attempt becomes permissible, or null while none is needed.
 */
export function lockedUntilFor(attempts: number, now: Date = new Date()): Date | null {
  const duration = lockoutDurationMs(attempts);
  return duration === 0 ? null : new Date(now.getTime() + duration);
}

/**
 * Seconds remaining, for the message shown to the user.
 *
 * Rounded up, so "try again in 1 second" never means "try again now and fail".
 */
export function secondsRemaining(lockedUntil: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
}
