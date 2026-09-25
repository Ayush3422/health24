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
 * Both apps talk to their own origin only: the proxy in front of them forwards
 * `/api` to the API, so a browser never makes a cross-origin request in normal
 * use. That is deliberate — it keeps the tokens same-origin and makes a
 * `connect-src 'self'` policy honest rather than aspirational.
 */
function contentSecurityPolicy(surface: Surface, development: boolean): string {
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

  const directives = [
    "default-src 'self'",
    // The bundler inlines a small runtime style; scripts are always files.
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // Data URIs are how the QR code for a second factor is drawn.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    // Uploaded documents are shown in an iframe from object storage, which is
    // reached through the same origin's proxy.
    "frame-src 'self' blob:",
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
            ? "connect-src 'self' ws: wss:"
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
 */
export function securityHeaders(
  surface: Surface,
  options: { development?: boolean } = {},
): SecurityHeaders {
  const development = options.development ?? false;

  const headers: SecurityHeaders = {
    'Content-Security-Policy': contentSecurityPolicy(surface, development),
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
