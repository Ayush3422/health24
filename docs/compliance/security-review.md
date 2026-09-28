# Security review

A checklist run against the code on **2026-09-28**, by the developer, against
the state of the repository at that date (sp7-plan.md, T23, Decision W1).

This is an internal review. It finds what a person looking adversarially at
their own code can find: a missing authorisation path, a message that says too
much, a policy that refuses the thing it was protecting. It does not replace an
external penetration test, and it is not a certificate — `pen-test-scope.md`
says what somebody from outside should be given and asked to break.

Each item below is one of **found and fixed**, **found and accepted** (with an
entry in `accepted-risks.md`), or **checked, nothing found** — and the last is
recorded deliberately, because a checklist that only lists problems cannot be
told apart from one that was never run.

---

## Findings

### 1. The content security policy refused every document — **fixed**

**Severity: high** (functional break with a security cause; no data exposure.)

The policy written in Phase 3 named only the app's own origin. A scanned report
is read back from object storage in an `img` or an `iframe`, and uploaded
straight to it with a presigned `PUT` — so `img-src`, `frame-src` and
`connect-src` each refused it.

Found by loading the clinical app in a browser and trying it, not by reading the
policy. The console said:

```
Loading the image 'http://localhost:7070/...' violates "img-src 'self' data: blob:"
Framing 'http://localhost:7070/' violates "frame-src 'self' blob:"
```

Nothing else says so: a refused subresource is a console message nobody is
watching, and the viewer is simply blank. A policy that breaks a screen is a
policy somebody switches off, which is how the protection is lost for every
screen.

**Fixed** by naming the storage origin in those three directives, as
configuration rather than a constant — nginx substitutes it at start from
`STORAGE_ORIGIN`, so one image serves every environment. The first version of
the fix still dropped it in development, where the policy is rewritten so Vite
can talk to itself; that was caught by a test rather than by a person.

**Regression tests:** one per directive in `security-headers.spec.ts`, one for
the development rewrite, and a browser test that loads an image, an iframe and
a `fetch` from the storage origin and fails on any refusal the console reports
(`apps/clinical/e2e/headers.spec.ts`).

### 2. `drizzle-orm` below 0.45.2 — SQL injection in identifier escaping — **fixed**

**Severity: high advisory; exposure here: none.**

GHSA-gpj5-g38j-94v9: identifiers were not escaped before being quoted, so an
application passing untrusted input to `sql.identifier()` or `.as()` could have
SQL injected.

**Exposure established rather than assumed:** the only `sql.identifier()` call
in the codebase takes `TABLES[kind]`, where `TABLES` is a seven-entry constant
and `kind` is a Zod enum. No request can reach it with anything else.

**Fixed anyway**, by upgrading to 0.45.3 — because the argument that a call site
is safe today is an argument that has to be made again every time somebody adds
one.

**The upgrade broke two things, and the suite caught both.** Drizzle 0.45 wraps
every failed query in its own error, with the driver's — the one carrying the
constraint name and the policy violation — moved to `cause`. A check reading
only the top-level message stopped matching, and a correction request naming a
hospital the patient is not registered at went from a clear 400 to a 500. The
fix is one helper that walks the whole chain
(`src/common/database-errors.ts`), used everywhere that reads what the database
said, with tests that do not need a database. This is why an upgrade is not
"verified" until the integration suite has run against it.

### 3. `multer` and `lodash` advisories in transitive production dependencies — **fixed**

**Severity: high advisories; exposure here: none.**

Four denial-of-service advisories in `multer`, which arrives through
`@nestjs/platform-express`, and a `_.template` code-injection advisory in
`lodash`, which arrives through `@nestjs/config`. The API parses no multipart at
all — uploads never pass through it — and `@nestjs/config` uses `get` and `set`,
not `template`.

**Fixed** with pnpm overrides to patched versions, because the exposure is nil
*today*: a `FileInterceptor` added next year would reintroduce the first
silently.

### 4. `/metrics` answers anybody who can reach the API — **accepted**

**Severity: low.** It holds counts by route, method and status class and nothing
about a patient, by construction. What it reveals is the shape of the API and
how busy it is — and the route names are in every client bundle already.

The fix belongs to the load balancer rather than the application: a rule
refusing `/metrics` from outside the VPC. Recorded in `accepted-risks.md` with a
date.

---

## Checked, nothing found

### Authorisation

- **Every route has a written expectation.** `authorization.e2e-spec.ts` walks
  every registered route against every role and fails on one that is not
  classified — which is how the probe routes added in Phase 2 were caught.
- **Guards are global.** A new route is authenticated and authorised unless it
  opts out with `@Public()`, rather than being exposed by omission.
- **Staff tokens are refused on portal routes, and the reverse**, by audience,
  asserted for every route rather than argued.
- **Tenancy is not the application's to enforce.** Row-level security is
  enabled and forced on every table, and a sweep fails on a new one that is not
  (`rls-coverage.e2e-spec.ts`).
- **The platform role holds no patient permission at all.**

### Error messages and what they reveal

- **Sign-in** answers "Invalid email or password" to both an unknown account and
  a wrong password, and runs a fake verification for the unknown case so the two
  take the same time (`passwords.fakeVerify()`).
- **The patient's sign-in always answers 202**, whether or not the number is
  registered.
- **A row belonging to another hospital is "not found"**, not "forbidden" —
  which is the difference between refusing access and confirming existence.
- **A 5xx logs identifiers and a scrubbed message**, never the failing statement
  and its parameters, which is what the framework's default filter would have
  logged (`error-reporter.ts`).

### Token and session handling

- Access tokens: fifteen minutes, audience-scoped, verified against the current
  signing secret and the one it replaced.
- Refresh tokens: 256 bits of randomness, stored as a SHA-256 hash, rotated on
  every use; a reused token revokes every session for that user.
- Second factors: encrypted at rest, one-step window, single-use recovery codes.
- Revocation is immediate — a revoked session fails the next request rather than
  at token expiry (`authorization.e2e-spec.ts`).
- Secrets rotate without an outage, proved end to end
  (`key-rotation.e2e-spec.ts`).

### Injection surfaces

- **Every request-path query is a parameterised Drizzle fragment.** The
  composed `sql` fragments that build filters bind their values; the audit
  confirmed no string interpolation of request data into SQL.
- **`sql.unsafe` appears three times**, all in operational scripts — the local
  bootstrap, the end-to-end fixture, and the restore drill — and each validates
  its identifier against `^[a-z_][a-z0-9_]*$` or takes it from the catalog.
- **Command execution** exists only in the restore drill, which spawns
  `pg_dump`, `pg_restore` and `docker` with argument arrays it constructs
  itself. No request reaches it.
- **No `eval`, no `new Function`, no template engine** anywhere in the API.

### File handling

Reviewed in full in Phase 3 and written up in `docs/hardening.md`: type and
length bound into the upload signature, a scan before a document is available,
a pinned response content type, presigned and short-lived URLs, and keys
validated against the shape the system generates.

### Secrets

- Nothing in the repository: gitleaks now runs over the working tree **and the
  history** on every push.
- `.env` and `.env.prod-local` are ignored, and excluded from the Docker build
  context so a layer cannot carry one.
- Terraform creates secrets empty; there is no `secret_version` resource, so no
  value passes through state.
- The one credential in the repository is the fixture password for a throwaway
  test database, and it is named as such.

### Logs

Proved rather than reviewed: `logging.e2e-spec.ts` registers a patient, searches
by name, looks up by phone, fails a validation with her details in the body and
records a chief complaint, then reads back every line the application wrote and
asserts none of it is there.

---

## What this review did not cover

- **The hospital's own network, workstations and physical security.**
- **Cryptographic implementation.** Argon2id parameters and AES-256-GCM usage
  follow current guidance; nobody here has reviewed the primitives themselves.
- **Denial of service at scale.** Per-caller limits exist; capacity does not.
- **The infrastructure as deployed**, because it has not been deployed. Terraform
  is reviewed as code, and `trivy config` checks it on every push.
- **Anything an external tester would find.** That is the point of
  `pen-test-scope.md`.
