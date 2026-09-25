import type { ServerResponse } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { securityHeaders } from '@health24/shared';
import { PROBE_ROUTES } from './health/health.module';

/**
 * Everything the application is, besides its modules (sp7-plan.md, T10–T13).
 *
 * Here rather than in `main.ts` because the test suites build the application
 * themselves, and an application configured one way in production and another
 * way under test proves nothing about the one that is deployed. The headers,
 * the body limits and the CORS rules are exactly what a browser will meet.
 */
export function configureApp(app: NestExpressApplication): void {
  /*
   * The largest body this API will read (T12).
   *
   * A discharge summary a clinician has written is the biggest legitimate JSON
   * here, and it is measured in kilobytes. Anything near this limit is either a
   * mistake or an attempt to make the process spend memory parsing it, and is
   * refused before a handler ever sees it. Files never come this way at all:
   * an upload is a presigned PUT straight to object storage (SP4).
   */
  app.useBodyParser('json', { limit: '256kb' });
  app.useBodyParser('urlencoded', { limit: '16kb', extended: false });

  /*
   * The headers a browser enforces, from the one definition both apps use
   * (T10). An API's policy is the strict one: nothing it returns is ever
   * rendered, framed or submitted from, so it is allowed nothing at all.
   */
  const headers = securityHeaders('api', {
    development: process.env.NODE_ENV !== 'production',
  });

  app.use((_request: unknown, response: ServerResponse, next: () => void) => {
    for (const [header, value] of Object.entries(headers)) response.setHeader(header, value);
    // Nothing should announce what it is running on.
    response.removeHeader('X-Powered-By');
    next();
  });

  // Behind a load balancer, the client IP arrives in X-Forwarded-For. Without
  // this, every audit row records the balancer's address — and every rate
  // limit counts the whole hospital as one caller.
  app.set('trust proxy', 1);

  app.setGlobalPrefix('api/v1', { exclude: PROBE_ROUTES });

  /*
   * Cross-origin access, which in normal use nobody needs (T13).
   *
   * Both apps are served behind a proxy that forwards `/api` to this API, so a
   * browser's requests are same-origin. The list exists for the cases that are
   * not — a developer running an app on another port, and whatever an
   * integration eventually needs — and is required in production (T2).
   *
   * `credentials` stays off: the session travels in an Authorization header
   * from memory, never in a cookie, so nothing needs the browser to attach
   * credentials to a cross-origin request. It flips to `true`, with an exact
   * origin list and a CSRF defence, on the day refresh tokens move to cookies
   * — see `docs/hardening.md`.
   */
  app.enableCors({
    origin: process.env.CORS_ORIGINS?.split(',') ?? ['http://localhost:5173'],
    credentials: false,
    maxAge: 600,
  });

  // Stops in-flight requests from being cut off mid-transaction on deploy.
  app.enableShutdownHooks();
}
