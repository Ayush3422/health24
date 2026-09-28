import { describe, expect, it } from 'vitest';
import { refuseCallback, type CallbackCheck } from './callback-auth';

/**
 * Who is allowed to answer for the national registry (sp8-plan.md, T8).
 *
 * Each case here is a way in that would otherwise exist, and the last two are
 * the ones that do not need ABDM's cooperation: an answer must quote a
 * question this process asked and is still waiting on, and it must be recent.
 */
describe('refusing an ABDM callback', () => {
  const NOW = Date.parse('2026-09-28T09:00:00.000Z');

  const waitingFor = 'e6e1a5b0-1111-4444-8888-aaaaaaaaaaaa';

  const check = (overrides: Partial<CallbackCheck> = {}): CallbackCheck => ({
    expectedSecret: 'the-shared-secret',
    secretRequired: true,
    maxSkewMs: 300_000,
    isWaitingFor: (id) => id === waitingFor,
    now: NOW,
    ...overrides,
  });

  const body = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'ffffffff-2222-4444-8888-bbbbbbbbbbbb',
    timestamp: new Date(NOW).toISOString(),
    resp: { requestId: waitingFor },
    ...overrides,
  });

  it('accepts a correlated, recent callback carrying the secret', () => {
    expect(refuseCallback(body(), 'the-shared-secret', check())).toBeNull();
  });

  it('refuses a wrong or missing secret', () => {
    expect(refuseCallback(body(), 'not-the-secret', check())).toBe('wrong-secret');
    expect(refuseCallback(body(), undefined, check())).toBe('wrong-secret');
    // A secret of a different length must not throw, which is what a naive
    // timing-safe comparison does.
    expect(refuseCallback(body(), 'short', check())).toBe('wrong-secret');
  });

  it('refuses to run unauthenticated where a secret is required', () => {
    expect(refuseCallback(body(), undefined, check({ expectedSecret: null }))).toBe(
      'no-secret-configured',
    );
  });

  it('allows an unauthenticated callback only where that was a deliberate choice', () => {
    expect(
      refuseCallback(body(), undefined, check({ expectedSecret: null, secretRequired: false })),
    ).toBeNull();
  });

  /**
   * The check that stands on its own. Reaching the URL is not enough: the
   * caller has to be answering something.
   */
  it('refuses an answer to a question nobody asked', () => {
    expect(refuseCallback(body({ resp: {} }), 'the-shared-secret', check())).toBe(
      'no-correlation',
    );
    expect(
      refuseCallback(
        body({ resp: { requestId: 'cccccccc-3333-4444-8888-dddddddddddd' } }),
        'the-shared-secret',
        check(),
      ),
    ).toBe('unknown-correlation');
  });

  it('refuses a callback captured and sent again later', () => {
    const old = new Date(NOW - 600_000).toISOString();
    expect(refuseCallback(body({ timestamp: old }), 'the-shared-secret', check())).toBe(
      'stale-timestamp',
    );
  });

  it('refuses a clock far ahead of ours as readily as one behind', () => {
    const ahead = new Date(NOW + 600_000).toISOString();
    expect(refuseCallback(body({ timestamp: ahead }), 'the-shared-secret', check())).toBe(
      'stale-timestamp',
    );
  });

  it('tolerates ordinary skew', () => {
    const slightly = new Date(NOW - 120_000).toISOString();
    expect(refuseCallback(body({ timestamp: slightly }), 'the-shared-secret', check())).toBeNull();
  });

  it('refuses a callback with no usable timestamp at all', () => {
    expect(refuseCallback(body({ timestamp: 'whenever' }), 'the-shared-secret', check())).toBe(
      'stale-timestamp',
    );
  });
});
