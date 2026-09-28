import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Waiting for an answer that arrives as a different request
 * (sp8-plan.md, T6).
 *
 * This is the shape of ABDM and the reason the adapter is not a thin wrapper
 * around `fetch`. A call is accepted with 202 and an empty body; the answer
 * comes minutes or milliseconds later as an **inbound** request quoting the
 * id we sent. Something has to hold the two halves together, time them out,
 * and refuse an answer nobody asked for.
 *
 * Deliberately in memory and per process. A pending request is worth nothing
 * after a restart — whoever was waiting on it is gone — so persisting it
 * would only create the illusion that a dropped call could be resumed. What
 * it does mean is that the callback must reach the same process that made the
 * call, which is written into `docs/abdm.md` and is a real constraint on how
 * this is deployed.
 */

export class GatewayTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly waitedMs: number,
  ) {
    super(`The gateway did not answer ${operation} within ${String(waitedMs)}ms`);
    this.name = 'GatewayTimeoutError';
  }
}

export class GatewayRefusedError extends Error {
  constructor(
    readonly operation: string,
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'GatewayRefusedError';
  }
}

interface Pending {
  operation: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

@Injectable()
export class PendingRequests {
  private readonly logger = new Logger(PendingRequests.name);
  private readonly pending = new Map<string, Pending>();

  /** How many calls are in flight. Read by the health probe and the tests. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Registers a call and hands back the id to send with it.
   *
   * The id is generated here rather than by the caller so that there is one
   * place that decides what a correlation id is, and no chance of two calls
   * sharing one.
   */
  begin<T>(operation: string, timeoutMs: number): { requestId: string; answer: Promise<T> } {
    const requestId = randomUUID();
    const startedAt = Date.now();

    const answer = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new GatewayTimeoutError(operation, Date.now() - startedAt));
      }, timeoutMs);

      // Nothing should be kept alive by a call we are waiting on.
      timer.unref?.();

      this.pending.set(requestId, {
        operation,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        startedAt,
      });
    });

    return { requestId, answer };
  }

  /** True when this id is one we issued and are still waiting on. */
  isWaitingFor(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** What the call was for, for a log line that names something useful. */
  operationOf(requestId: string): string | null {
    return this.pending.get(requestId)?.operation ?? null;
  }

  /** The answer arrived. */
  settle(requestId: string, value: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(value);

    return true;
  }

  /** The gateway answered, and the answer was a refusal. */
  fail(requestId: string, message: string, code?: number): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.reject(new GatewayRefusedError(entry.operation, message, code));

    return true;
  }

  /**
   * Gives up on everything, on shutdown.
   *
   * Without this a process draining its connections waits out the full
   * timeout of every call in flight before it can exit.
   */
  abandonAll(reason: string): void {
    if (this.pending.size > 0) {
      this.logger.warn(`Abandoning ${String(this.pending.size)} gateway calls: ${reason}`);
    }

    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      entry.reject(new GatewayRefusedError(entry.operation, reason));
    }
  }
}
