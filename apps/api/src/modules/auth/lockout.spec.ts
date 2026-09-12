import { describe, expect, it } from 'vitest';
import {
  BASE_DELAY_MS,
  FREE_ATTEMPTS,
  MAX_DELAY_MS,
  lockedUntilFor,
  lockoutDurationMs,
  secondsRemaining,
} from './lockout';

describe('lockoutDurationMs', () => {
  it('forgives the first few mistakes entirely', () => {
    for (let attempts = 0; attempts <= FREE_ATTEMPTS; attempts += 1) {
      expect(lockoutDurationMs(attempts)).toBe(0);
    }
  });

  it('starts small enough that a mistyping clinician barely notices', () => {
    expect(lockoutDurationMs(FREE_ATTEMPTS + 1)).toBe(BASE_DELAY_MS);
    expect(lockoutDurationMs(FREE_ATTEMPTS + 1)).toBeLessThanOrEqual(2_000);
  });

  it('doubles with each further failure', () => {
    expect(lockoutDurationMs(5)).toBe(4_000);
    expect(lockoutDurationMs(6)).toBe(8_000);
    expect(lockoutDurationMs(7)).toBe(16_000);
    expect(lockoutDurationMs(8)).toBe(32_000);
  });

  it('never exceeds the ceiling', () => {
    for (const attempts of [20, 50, 500, 10_000]) {
      expect(lockoutDurationMs(attempts)).toBe(MAX_DELAY_MS);
    }
  });

  it('does not overflow on an absurd attempt count', () => {
    expect(Number.isFinite(lockoutDurationMs(Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(lockoutDurationMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_DELAY_MS);
  });

  it('makes sustained brute force impractical', () => {
    // The property that matters: guessing is expensive in aggregate, not just
    // per attempt. Twenty guesses must cost far more than a few minutes.
    let total = 0;
    for (let attempts = 1; attempts <= 20; attempts += 1) {
      total += lockoutDurationMs(attempts);
    }

    expect(total).toBeGreaterThan(60 * 60 * 1000);
  });

  it('keeps an account usable to its owner, unlike a hard lock', () => {
    // The denial-of-service case: someone deliberately fails five times
    // against a known clinician's email. Under a fifteen-minute hard lock,
    // that doctor cannot reach a patient record. Here they wait seconds.
    expect(lockoutDurationMs(5)).toBeLessThan(10_000);
  });
});

describe('lockedUntilFor', () => {
  const now = new Date('2026-09-12T10:00:00Z');

  it('returns null while attempts are still free', () => {
    expect(lockedUntilFor(FREE_ATTEMPTS, now)).toBeNull();
  });

  it('returns the moment the next attempt is permitted', () => {
    const until = lockedUntilFor(FREE_ATTEMPTS + 1, now);
    expect(until?.getTime()).toBe(now.getTime() + BASE_DELAY_MS);
  });
});

describe('secondsRemaining', () => {
  const now = new Date('2026-09-12T10:00:00Z');

  it('rounds up, so the message is never a lie', () => {
    // Rounding down would tell someone to retry at a moment that still fails.
    const until = new Date(now.getTime() + 1_200);
    expect(secondsRemaining(until, now)).toBe(2);
  });

  it('never reports a negative wait', () => {
    const past = new Date(now.getTime() - 5_000);
    expect(secondsRemaining(past, now)).toBe(0);
  });
});
