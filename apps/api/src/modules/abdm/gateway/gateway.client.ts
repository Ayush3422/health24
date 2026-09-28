import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { AbdmConfig } from '../abdm.config';
import { PendingRequests } from './correlation';
import { GATEWAY_OPERATIONS, type GatewayOperation } from './operations';
import { GatewaySession } from './session';

/**
 * The one place that knows what the gateway's wire looks like
 * (sp8-plan.md, T6, DF4).
 *
 * A call here is not a request and a response. It is: send, be told 202,
 * and wait for a separate inbound request quoting the id we sent. So `call`
 * registers the wait **before** sending — a gateway fast enough to call back
 * while we are still reading its 202 is not a race this should lose.
 *
 * Above this class nothing knows about session tokens, correlation ids,
 * `X-HIP-ID` or which path an operation lives at. That is the property the
 * whole adapter exists for: ABDM's APIs have moved once and will again, and
 * when they do, this file and the mock beside it are what change.
 */
@Injectable()
export class GatewayClient implements OnApplicationShutdown {
  private readonly logger = new Logger(GatewayClient.name);

  constructor(
    private readonly config: AbdmConfig,
    private readonly session: GatewaySession,
    private readonly pending: PendingRequests,
  ) {}

  onApplicationShutdown(): void {
    this.pending.abandonAll('the process is shutting down');
  }

  async call<T>(operation: GatewayOperation, payload: Record<string, unknown>): Promise<T> {
    const { baseUrl, hipId, cmId, callTimeoutMs } = this.config.gateway;
    const { path } = GATEWAY_OPERATIONS[operation];

    // Registered first, deliberately. See the note above.
    const { requestId, answer } = this.pending.begin<T>(operation, callTimeoutMs);

    try {
      await this.send(`${baseUrl}${path}`, hipId, cmId, callTimeoutMs, {
        requestId,
        timestamp: new Date().toISOString(),
        ...payload,
      });
    } catch (error) {
      // Nothing is coming back for a call that was never accepted, and
      // leaving it pending would hold the caller for the full timeout.
      this.pending.fail(requestId, error instanceof Error ? error.message : String(error));
      throw error;
    }

    return answer;
  }

  private async send(
    url: string,
    hipId: string,
    cmId: string,
    timeoutMs: number,
    body: Record<string, unknown>,
  ): Promise<void> {
    const attempt = async (): Promise<Response> =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await this.session.token()}`,
          'X-HIP-ID': hipId,
          'X-CM-ID': cmId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

    let response = await attempt();

    // One retry, and only for the one cause a retry fixes: a token the
    // gateway no longer accepts. Anything else retried here would be a
    // duplicate of a request the gateway may already be acting on.
    if (response.status === 401) {
      this.session.forget();
      response = await attempt();
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `The gateway refused the call (HTTP ${String(response.status)})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      );
    }
  }
}
