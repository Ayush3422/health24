import { describe, expect, it, vi } from 'vitest';
import { GatewayRefusedError, GatewayTimeoutError, PendingRequests } from './correlation';

/**
 * Holding the two halves of a gateway call together (sp8-plan.md, T6).
 *
 * The behaviour worth testing here is not the happy path — it is what happens
 * when the answer never comes, when it comes twice, and when it comes for a
 * question nobody asked. All three happen against a real gateway, and none of
 * them happens on a developer's machine.
 */
describe('pending gateway calls', () => {
  it('resolves the caller when the answer arrives', async () => {
    const pending = new PendingRequests();
    const { requestId, answer } = pending.begin<{ ok: boolean }>('abha.verify.init', 1_000);

    expect(pending.size).toBe(1);
    expect(pending.isWaitingFor(requestId)).toBe(true);

    pending.settle(requestId, { ok: true });

    await expect(answer).resolves.toEqual({ ok: true });
    expect(pending.size).toBe(0);
  });

  it('rejects with the gateway’s own refusal', async () => {
    const pending = new PendingRequests();
    const { requestId, answer } = pending.begin('abha.verify.confirm', 1_000);

    pending.fail(requestId, 'That code is not correct.', 1401);

    await expect(answer).rejects.toThrow(GatewayRefusedError);
    await expect(answer).rejects.toThrow('That code is not correct.');
  });

  it('gives up on a gateway that never answers', async () => {
    vi.useFakeTimers();

    try {
      const pending = new PendingRequests();
      const { answer } = pending.begin('abha.verify.init', 5_000);
      const settled = answer.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(5_001);

      expect(await settled).toBeInstanceOf(GatewayTimeoutError);
      expect(pending.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The check the callback endpoint leans on. An answer to a question this
   * process never asked is not an answer, and it cannot be allowed to become
   * one by being sent to the right URL.
   */
  it('knows nothing about a correlation it did not issue', () => {
    const pending = new PendingRequests();

    expect(pending.isWaitingFor('01a0e7e2-0000-0000-0000-000000000000')).toBe(false);
    expect(pending.settle('01a0e7e2-0000-0000-0000-000000000000', {})).toBe(false);
    expect(pending.fail('01a0e7e2-0000-0000-0000-000000000000', 'nope')).toBe(false);
  });

  it('answers a call once, and not twice', async () => {
    const pending = new PendingRequests();
    const { requestId, answer } = pending.begin<string>('abha.verify.init', 1_000);

    expect(pending.settle(requestId, 'first')).toBe(true);
    expect(pending.settle(requestId, 'second')).toBe(false);

    await expect(answer).resolves.toBe('first');
  });

  it('gives every call its own id', () => {
    const pending = new PendingRequests();
    const ids = new Set<string>();

    for (let i = 0; i < 50; i += 1) {
      const call = pending.begin('abha.verify.init', 60_000);
      // Abandoned below, so each rejection needs somewhere to land.
      call.answer.catch(() => undefined);
      ids.add(call.requestId);
    }

    expect(ids.size).toBe(50);
    expect(pending.size).toBe(50);

    pending.abandonAll('test');
  });

  it('lets a shutting-down process go rather than waiting out every timeout', async () => {
    const pending = new PendingRequests();
    const { answer } = pending.begin('abha.verify.init', 60_000);
    const settled = answer.catch((error: unknown) => error);

    pending.abandonAll('the process is shutting down');

    expect(await settled).toBeInstanceOf(GatewayRefusedError);
    expect(pending.size).toBe(0);
  });
});
