import { Injectable, Logger } from '@nestjs/common';
import { AbdmConfig } from '../abdm.config';

/**
 * The gateway's session token (sp8-plan.md, T6).
 *
 * Three properties, each of which is a bug if it is missing:
 *
 * 1. **Cached.** A token per call would mean two round trips for every
 *    operation and a rate limit reached by doing nothing wrong.
 * 2. **Renewed early.** A token that expires while a request is in flight
 *    fails a call that had nothing wrong with it, so it is replaced a margin
 *    before it lapses rather than after.
 * 3. **Fetched once at a time.** Without that, a burst of calls on a cold
 *    process asks for twenty tokens at once — the thundering herd that looks
 *    like an attack from the other side.
 *
 * The token is never logged. It is a bearer credential for a national
 * network, and a log is a place it would outlive its five minutes.
 */

const RENEW_MARGIN_MS = 60_000;

interface Token {
  value: string;
  expiresAt: number;
}

@Injectable()
export class GatewaySession {
  private readonly logger = new Logger(GatewaySession.name);
  private current: Token | null = null;
  private inFlight: Promise<Token> | null = null;

  constructor(private readonly config: AbdmConfig) {}

  /** A token that will still be valid for the next minute. */
  async token(): Promise<string> {
    const current = this.current;

    if (current && current.expiresAt - RENEW_MARGIN_MS > Date.now()) {
      return current.value;
    }

    this.inFlight ??= this.fetch().finally(() => {
      this.inFlight = null;
    });

    const fetched = await this.inFlight;
    return fetched.value;
  }

  /**
   * Throws the token away.
   *
   * Called when the gateway answers 401 to a call that used it: the clock, or
   * a rotation on their side, has made it worthless, and the next call should
   * pay for a new one rather than repeating the same failure.
   */
  forget(): void {
    this.current = null;
  }

  private async fetch(): Promise<Token> {
    const { baseUrl, clientId, clientSecret, callTimeoutMs } = this.config.gateway;

    const response = await fetch(`${baseUrl}/v0.5/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
      signal: AbortSignal.timeout(callTimeoutMs),
    });

    if (!response.ok) {
      // The body may carry the credential back in an error message, so it is
      // not included. The status is what an operator needs.
      throw new Error(`The gateway refused a session (HTTP ${String(response.status)})`);
    }

    const body = (await response.json()) as { accessToken?: string; expiresIn?: number };

    if (!body.accessToken) {
      throw new Error('The gateway returned a session with no token');
    }

    // A gateway that does not say gets the shortest sensible assumption
    // rather than the longest: an early renewal costs one request.
    const lifetimeMs = (body.expiresIn ?? 300) * 1_000;

    this.current = { value: body.accessToken, expiresAt: Date.now() + lifetimeMs };
    this.logger.log(`Gateway session renewed, valid for ${String(lifetimeMs / 1000)}s`);

    return this.current;
  }
}
