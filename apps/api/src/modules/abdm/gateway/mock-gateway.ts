import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * A gateway to develop and test against (sp8-plan.md, T7, Decision Z1).
 *
 * Not a stub that returns a value: a **server**, which is the only kind of
 * mock that can exercise the thing this phase is about. It hands out session
 * tokens, refuses a call that does not carry one, answers 202, and then calls
 * back on its own connection quoting the request id — so the correlation, the
 * session handling, the headers and the callback authentication are all
 * tested by using them rather than by asserting about them.
 *
 * It is deliberately awkward in the ways the real one is:
 *
 * - it refuses an unauthenticated call,
 * - it answers asynchronously, after a tick, never in the response,
 * - it can be told to answer with an error, or not to answer at all.
 *
 * The operations it knows are the operations that have a caller. Phases 3 to
 * 5 add theirs here, beside the adapter that calls them, rather than
 * inventing a second place for the wire format to live (DF4).
 *
 * The published code is `000000`, which protects nothing and is meant not to:
 * the configuration schema refuses `ABDM_MODE` pointed anywhere but a real
 * gateway in production.
 */

export const MOCK_GATEWAY_CODE = '000000';

export interface MockGatewayOptions {
  /**
   * Where this gateway calls back to: the API's own base URL.
   *
   * Settable after construction because of an ordering that the real world
   * also has — the gateway has to exist before the API can be told where it
   * is, and the API has to be listening before the gateway can be told where
   * to answer. ABDM solves this by registering a bridge URL out of band.
   */
  callbackBaseUrl?: string;
  clientId: string;
  clientSecret: string;
  /** Sent as `x-abdm-callback-secret` on every callback. */
  callbackSecret?: string | null;
}

interface Challenge {
  abhaNumber: string | null;
  abhaAddress: string | null;
  method: string;
  attempts: number;
}

export class MockGatewayServer {
  private server: Server | null = null;
  private token: string | null = null;
  private readonly challenges = new Map<string, Challenge>();

  /**
   * Behaviour a test asks for and the real gateway produces on a bad day.
   *
   * `silent` is the interesting one: it is how the timeout path gets covered,
   * and a timeout is the failure most likely to be handled badly, because it
   * is the one that never happens on a developer's machine.
   */
  silent = false;
  /** When set, the next callback carries this error instead of a payload. */
  nextError: { code: number; message: string } | null = null;
  /** Every callback this gateway has sent, for a test to look at. */
  readonly sent: Array<{ operation: string; correlation: string | undefined }> = [];
  /** How many sessions it has handed out — one per burst, if caching works. */
  sessionsIssued = 0;

  /** See `MockGatewayOptions.callbackBaseUrl`. */
  callbackBaseUrl: string;

  constructor(private readonly options: MockGatewayOptions) {
    this.callbackBaseUrl = options.callbackBaseUrl ?? '';
  }

  get url(): string {
    const address = this.server?.address();

    if (!address || typeof address === 'string') {
      throw new Error('The mock gateway is not listening');
    }

    return `http://127.0.0.1:${String(address.port)}`;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', resolve);
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;

    if (!server) return;

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);

    const path = (request.url ?? '').split('?')[0] ?? '';
    const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};

    const reply = (status: number, payload: unknown = {}) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };

    if (path === '/v0.5/sessions') {
      if (body.clientId !== this.options.clientId || body.clientSecret !== this.options.clientSecret) {
        reply(401, { error: 'bad credentials' });
        return;
      }

      this.token = randomUUID();
      this.sessionsIssued += 1;
      reply(200, { accessToken: this.token, expiresIn: 600, tokenType: 'bearer' });
      return;
    }

    // Everything else needs a session, which is what makes the client's
    // token handling something this proves rather than assumes.
    if (request.headers.authorization !== `Bearer ${String(this.token)}`) {
      reply(401, { error: 'no session' });
      return;
    }

    const requestId = String(body.requestId ?? '');

    if (path === '/v0.5/users/auth/init') {
      const transactionId = randomUUID();

      this.challenges.set(transactionId, {
        abhaNumber: (body.abhaNumber as string | null) ?? null,
        abhaAddress: (body.abhaAddress as string | null) ?? null,
        method: String(body.method ?? 'mobile_otp'),
        attempts: 0,
      });

      reply(202, {});
      this.callBack('abha.verify.init', requestId, {
        transactionId,
        sentTo: 'XXXXXXXX99',
        expiresInSeconds: 300,
      });
      return;
    }

    if (path === '/v0.5/users/auth/confirm') {
      const challenge = this.challenges.get(String(body.transactionId ?? ''));

      reply(202, {});

      if (!challenge) {
        this.callBack('abha.verify.confirm', requestId, null, {
          code: 1410,
          message: 'That verification has expired. Ask for a new code.',
        });
        return;
      }

      challenge.attempts += 1;

      if (body.code !== MOCK_GATEWAY_CODE) {
        this.callBack('abha.verify.confirm', requestId, null, {
          code: 1401,
          message: 'That code is not correct.',
        });
        return;
      }

      this.challenges.delete(String(body.transactionId));
      this.callBack('abha.verify.confirm', requestId, {
        abhaNumber: challenge.abhaNumber,
        abhaAddress: challenge.abhaAddress,
        method: challenge.method,
      });
      return;
    }

    reply(404, { error: `the mock gateway does not implement ${path}` });
  }

  /** The answer, as its own request, the way the real one sends it. */
  private callBack(
    operation: string,
    correlation: string,
    payload: unknown,
    error?: { code: number; message: string },
  ): void {
    this.sent.push({ operation, correlation });

    if (this.silent) return;

    const failure = error ?? this.nextError ?? undefined;
    this.nextError = null;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.callbackSecret) {
      headers['x-abdm-callback-secret'] = this.options.callbackSecret;
    }

    // Deferred a tick, so that a caller which has not finished reading the
    // 202 is still the one that has to cope.
    setTimeout(() => {
      void fetch(`${this.callbackBaseUrl}/api/v1/abdm/callbacks/${operation}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          requestId: randomUUID(),
          timestamp: new Date().toISOString(),
          resp: { requestId: correlation },
          ...(failure ? { error: failure } : { payload }),
        }),
      }).catch(() => {
        // A gateway does not care whether the callback was accepted, and
        // neither does this. The waiting call times out, which is the
        // behaviour a test of that path wants.
      });
    }, 5);
  }
}
