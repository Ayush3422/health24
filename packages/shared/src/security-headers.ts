/**
 * The headers a browser is told to enforce (sp7-plan.md, T10).
 *
 * One definition, used in three places: the API sets its own, each app's dev
 * server sets the app's, and the static server that serves the built apps in
 * production is configured from the same values. Three copies of a content
 * security policy is three chances for the deployed one to be the weak one.
 *
 * A content security policy is the only header here that can break a working
 * screen, and it breaks it silently — a script refuses to run and the page
 * simply does nothing. That is why the browser suites run against these
 * headers rather than around them: a policy nobody tested is a policy that
 * gets switched off during an incident.
 */

export type SecurityHeaders = Record<string, string>;

/** What each surface is allowed to do. */
export type Surface = 'api' | 'clinical' | 'portal';

/**
 * Where the app may fetch from.
 *
 * Almost everything is the app's own origin: the proxy in front of it forwards
 * `/api` to the API, so a browser makes no cross-origin request for anything
 * the API serves. That keeps the tokens same-origin and makes
 * `connect-src 'self'` honest rather than aspirational.
 *
 * Object storage is the exception, and it has to be named. A document is
 * uploaded by the browser straight to storage with a presigned URL, and read
 * back from storage in an `img` or an `iframe` (SP4) — three directives that
 * would otherwise refuse it. Leaving them out does not make the system safer;
 * it makes the document viewer silently blank, which is how a content security
 * policy ends up being switched off altogether.
 */
function contentSecurityPolicy(
  surface: Surface,
  development: boolean,
  storageOrigin: string,
): string {
  if (surface === 'api') {
    // An API serves JSON. Nothing it returns should ever be rendered, and
    // `sandbox` means a browser that is tricked into navigating to one of its
    // responses can do nothing with it.
    return [
      "default-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      'sandbox',
    ].join('; ');
  }

  // Named once, so that a policy with no storage configured is a policy with
  // no extra origin in it rather than a dangling space.
  const storage = storageOrigin ? ` ${storageOrigin}` : '';

  const directives = [
    "default-src 'self'",
    // The bundler inlines a small runtime style; scripts are always files.
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // Data URIs are how the QR code for a second factor is drawn; storage is
    // where a scanned report actually lives.
    `img-src 'self' data: blob:${storage}`,
    "font-src 'self'",
    // The API through the proxy, and the presigned PUT that sends a file to
    // storage without it passing through the API at all.
    `connect-src 'self'${storage}`,
    // A PDF is read in an iframe, from storage, through a presigned URL that
    // expires in a minute.
    `frame-src 'self' blob:${storage}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ];

  if (development) {
    // Vite's dev server injects its client and talks to itself over a
    // websocket; without these the development server serves a blank page.
    return directives
      .map((directive) =>
        directive.startsWith('script-src')
          ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
          : directive.startsWith('connect-src')
            ? `connect-src 'self'${storage} ws: wss:`
            : directive,
      )
      .filter((directive) => directive !== 'upgrade-insecure-requests')
      .join('; ');
  }

  return directives.join('; ');
}

/**
 * The headers for one surface.
 *
 * `development` relaxes exactly two directives, and nothing else: the same
 * frame, referrer and content-type rules apply on a laptop as in production,
 * so a mistake shows up while it is cheap to fix.
 *
 * `storageOrigin` is where documents live — `http://localhost:7070` locally,
 * the bucket's own origin in a deployment. It is configuration rather than a
 * constant because it differs per environment, and the static server
 * substitutes it at start rather than at build, so one image serves every
 * environment.
 */
export function securityHeaders(
  surface: Surface,
  options: { development?: boolean; storageOrigin?: string } = {},
): SecurityHeaders {
  const development = options.development ?? false;

  const headers: SecurityHeaders = {
    'Content-Security-Policy': contentSecurityPolicy(
      surface,
      development,
      options.storageOrigin ?? '',
    ),
    // A clinical record is never framed by anybody, which is what stops it
    // being clickjacked into a consent nobody meant to give.
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    // A patient's MRN is in the path of a portal URL; nothing of it travels to
    // another site in a Referer header.
    'Referrer-Policy': 'no-referrer',
    // Nothing here needs a camera, a microphone or a location.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };

  if (!development) {
    // Two years, subdomains included. Only ever sent over HTTPS, so it is
    // harmless on a laptop and meaningless there anyway.
    headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
  }

  return headers;
}
