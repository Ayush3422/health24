# The edge

What a browser is told to enforce, what the API refuses to read, how often
anybody may ask, and why cross-origin access is switched off (sp7-plan.md,
Phase 3).

## Headers

One definition — `packages/shared/src/security-headers.ts` — used by the API,
by both apps' dev servers, and by the static server that serves the built apps.
Three copies of a content security policy is three chances for the deployed one
to be the weak one.

| Header | Apps | API |
| --- | --- | --- |
| `Content-Security-Policy` | `default-src 'self'`, no inline or eval'd script, `object-src 'none'`, `frame-ancestors 'none'` | `default-src 'none'` and `sandbox`: JSON is never rendered |
| `Strict-Transport-Security` | two years, subdomains included (production only) | same |
| `X-Frame-Options` | `DENY` | `DENY` |
| `X-Content-Type-Options` | `nosniff` | `nosniff` |
| `Referrer-Policy` | `no-referrer` | `no-referrer` |
| `Permissions-Policy` | camera, microphone and location denied | same |
| `Cross-Origin-Opener-Policy` / `-Resource-Policy` | `same-origin` | `same-origin` |

Development relaxes exactly two directives, because Vite injects its client and
talks to itself over a websocket: `script-src` gains `'unsafe-inline'` and
`'unsafe-eval'`, and `connect-src` gains `ws:`. Everything else — framing,
referrer, sniffing, plugins — applies on a laptop exactly as in production, so
a mistake shows up while it is cheap.

`X-Frame-Options: DENY` is not a formality here. A clinical record inside
somebody else's frame is a consent, a discharge or a refund one click away from
being given by a clinician who thought they were clicking something else.

**Tested, not assumed.** `test/hardening.e2e-spec.ts` asserts the headers on
real responses, including 401s and 404s; `apps/clinical/e2e/headers.spec.ts`
asserts them in a browser and then drives a screen under them, because a
content security policy that breaks a page breaks it silently.

## What the API will read

| Limit | Value | Why |
| --- | --- | --- |
| JSON body | 256 KB | A discharge summary a clinician wrote is the largest legitimate body, and it is kilobytes. Anything near this is a mistake or an attempt to spend the process's memory. |
| Form body | 16 KB | Nothing here posts a form; the limit exists so that the parser cannot be used as one. |
| Uploaded file | 25 MB, and only `application/pdf`, `image/jpeg`, `image/png` | A scanned report at a sensible resolution. |

Files never travel through the API at all. An upload is a presigned `PUT`
straight to object storage, with the content type **and the exact length** in
the signature: a file of a different type or size is refused by storage itself,
before anything of ours sees it.

## The upload and download path, against a hostile file

The path is: presign → the browser puts the file → the API records it →
`clamd` scans it → the document becomes available. Each step and what stops
the obvious attack:

- **A file that is not what it says.** The type and length are in the presigned
  signature, so storage refuses a mismatch. The recorded size and type are then
  checked against what storage actually holds before the file is accepted.
- **A file with something in it.** Every file is scanned by `clamd` before the
  document leaves `pending_scan`, and a download of a document that is not
  available is refused. An upload that never completes leaves a document that
  is never served.
- **A file served as something else.** Storage answers downloads directly, so
  this API's `X-Content-Type-Options` is not on that response. The presigned
  URL therefore pins `ResponseContentType` to the type the record holds, and
  the disposition to `inline` or `attachment` explicitly — a browser cannot be
  talked into treating a stored file as HTML.
- **A file read by the wrong person.** A download URL is presigned, short-lived
  and issued only after the row has been read under row-level security and
  consent; the bucket itself is private, with no public access.
- **A file used to find other files.** Storage keys are derived from ids, and
  `assertStorageKey` refuses anything that is not the shape the system
  generates, so a key cannot be walked or traversed.

What is deliberately **not** claimed: the scanner is a signature scanner, so a
targeted document exploit that nothing has a signature for would pass it. The
answers to that are the ones already in place — the file is never rendered by
the API, never served from the app's own origin, and always served with its
recorded type — and a second look at this path is on the Phase 6 checklist.

## Rate limits

| Door | Limit | What actually protects it |
| --- | --- | --- |
| Sign-in (`/auth/login`, `/auth/mfa/*`) | 60 a minute per address | The per-account lockout, which grows exponentially with consecutive failures. The address limit only stops a flood — a hospital is behind one NAT and a shift changes together, so a tight per-address limit would lock out a ward, not an attacker. |
| Invite acceptance | 5 a minute | Nobody accepts an invitation twice. |
| Patient sign-in codes | 30 a minute per address, and three codes per number per fifteen minutes | The per-number limit is the one that matters: it is the patient's phone being protected, not ours. |
| A record export | 20 an hour | Building one is expensive, and a hundred is not a use case. |
| Everything else | 120 a minute per address | A ceiling, not a control. |

Limits are counted per route, so a flood at one door does not shut another —
asserted in `test/hardening.e2e-spec.ts`.

## Cross-origin access, and cookies

**CORS is effectively off, and that is the point.** Both apps are served behind
a proxy that forwards `/api` to the API, so a browser's requests are
same-origin and no CORS header is involved. `CORS_ORIGINS` exists for the cases
that are not — a developer running an app on another port — and is required in
production, where an unset list would otherwise mean "answer anybody".

`credentials` is **off**: the access token lives in memory and travels in an
`Authorization` header, the refresh token lives in `sessionStorage`, and
nothing is sent in a cookie. A browser therefore never attaches credentials to
a cross-origin request to this API, which makes CSRF a non-issue by
construction rather than by a token nobody checks.

### What changes when refresh tokens move to cookies

`apps/clinical/src/api/client.ts` already says this is the destination: an
httpOnly, `SameSite=Strict`, `Secure` cookie issued by the API is strictly
better than `sessionStorage`, which script can read. The day that lands:

1. `credentials` becomes `true`, and the origin list stops being a convenience
   and becomes a control — exact origins, never a wildcard, never reflected.
2. CSRF stops being a non-issue. A cookie is attached by the browser whether or
   not the app meant to send it, so the refresh route needs a double-submit
   token or an `Origin` check, and every state-changing route needs the same.
3. `SameSite=Strict` has to be tested against the portal's sign-in link flow,
   which arrives from an SMS — a link opened from another app is a cross-site
   navigation, and a strict cookie will not be sent on it.
4. The browser suites stay as they are, which is the point of having them.

Until then, the honest statement is: tokens in `sessionStorage` are readable by
any script that runs on the page, and the content security policy above is what
stops such a script existing.
